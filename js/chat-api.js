import { streamPuterCompletion } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterStream.js';
import { state, els } from './state.js';
import { tokenManager } from './token-manager.js';
import { setState } from './store.js';
import { estimateTokens, calculateMessageCost } from './models.js';
import { emit } from './event-bus.js';
import { decorateCodeBlocks } from './chat-ui.js';
import { getMessageText } from './utils.js';
import { sanitizeHtml } from './sanitize.js';

/**
 * Generation is tracked explicitly in the store as `state.isGenerating`
 * (single source of truth, mirrored by `state.lastOperationId` for matching
 * stream callbacks to the active stream). `activeStream` holds the in-flight
 * stream context so abortAssistantResponse() can finalize synchronously
 * instead of racing the async AbortError callback.
 */
let activeStream = null;

/**
 * Persist any partial assistant response (or drop the empty assistant bubble
 * when there is nothing to keep). Used by both the abort path and the error
 * path. Bounds-checked against `state.messages` because edits/regenerates
 * can truncate the array while a stream is in flight.
 */
function finalizePartialResponse(aiMsgIndex, fullContent, fullReasoning) {
    if (fullContent || fullReasoning) {
        const finalContent = fullContent || (fullReasoning ? '[Response not generated]' : '');
        const msg = state.messages[aiMsgIndex];
        if (msg && msg.role === 'assistant') {
            msg.content = finalContent;
            msg.reasoning = fullReasoning;
            emit('messages:rerender');
            emit('chat:save');
        }
    } else {
        removeEmptyAssistantPlaceholder(aiMsgIndex);
        emit('messages:rerender');
    }
}

/**
 * Remove the placeholder assistant message that the streaming callback added.
 * Falls back to the most recent message if the expected index is no longer
 * the empty placeholder. Emits no UI events on its own.
 */
function removeEmptyAssistantPlaceholder(aiMsgIndex) {
    if (
        aiMsgIndex !== undefined &&
        state.messages[aiMsgIndex] &&
        state.messages[aiMsgIndex].role === 'assistant' &&
        state.messages[aiMsgIndex].content === ''
    ) {
        state.messages.splice(aiMsgIndex, 1);
        return;
    }
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === '') {
        state.messages.pop();
    }
}

/** Mark the store as no longer generating and drop the active stream ref. */
function settleGeneration() {
    if (activeStream) activeStream = null;
    setState({ isGenerating: false, lastOperationId: null, abortController: null });
}

export async function triggerAssistantResponse() {
    if (state.isGenerating) {
        console.warn('Assistant response already in progress, ignoring duplicate request');
        return;
    }

    // Mark synchronously so a re-entrant call in the same tick can't slip through.
    setState({ isGenerating: true });

    const ctx = createStreamContext();
    // Register immediately so abortAssistantResponse() can finalize even if the
    // abort lands before the bubble / operation id are set up.
    activeStream = ctx;

    try {
        const currentModel = state.models.find(m => m.id === state.config.modelId);
        const { messagesPayload, inputTokens, enableVision, enableWebSearch } = buildRequestPayload(currentModel);

        await prepareAssistantBubble(ctx);
        if (ctx.settled) return; // aborted while the bubble was being prepared

        const operationId = Date.now();
        ctx.operationId = operationId;
        const abortController = new AbortController();
        setState({
            lastOperationId: operationId,
            abortController
        });

        const currentToken = await tokenManager.getCurrentToken();
        if (ctx.settled) return; // aborted while resolving the token
        const apiToken = await tokenManager.getApiToken();
        if (ctx.settled) return;

        await streamPuterCompletion({
            apiUrl: "https://api.puter.com/drivers/call",
            requestBody: buildStreamRequestBody({ messagesPayload, enableVision, enableWebSearch }),
            headers: buildRequestHeaders(apiToken),
            signal: abortController.signal,
            onToolUse: (toolUse) => handleToolUse(ctx, toolUse, operationId),
            onPartialUpdate: (update) => handlePartialUpdate(ctx, update, operationId),
            onComplete: (final) => handleComplete(ctx, final, { inputTokens, currentModel, currentToken, operationId }),
            onError: (err) => handleStreamError(ctx, err, { currentToken, operationId })
        });
    } catch (err) {
        handleOuterStreamError(err, ctx);
    } finally {
        // Safety net: if nothing settled the generation state (e.g. an error
        // before the callbacks were wired up), release it here.
        if (activeStream === ctx || state.isGenerating) {
            settleGeneration();
        }
    }
}

function createStreamContext() {
    return {
        aiMsgIndex: undefined,
        contentEl: null,
        fullContent: '',
        fullReasoning: '',
        reasoningBlock: null,
        contentWrapper: null,
        toolUseBlock: null,
        operationId: undefined,
        settled: false
    };
}

function buildRequestPayload(currentModel) {
    const lastUserMessage = state.messages.filter(m => m.role === 'user').pop();
    const hasImagesForApi = lastUserMessage && lastUserMessage.images && lastUserMessage.images.length > 0;
    const modelSupportsVision = currentModel && currentModel.supportsVision;
    const modelSupportsSearch = currentModel && currentModel.supportsSearch;
    const enableVision = hasImagesForApi && modelSupportsVision;
    const enableWebSearch = modelSupportsSearch && state.config.enableWebSearch;

    const messagesPayload = [
        { role: 'system', content: state.config.systemPrompt },
        ...state.messages
    ];
    const inputText = messagesPayload.map(m => getMessageText(m)).join(' ');
    const inputTokens = estimateTokens(inputText);

    return { messagesPayload, inputTokens, enableVision, enableWebSearch };
}

function buildStreamRequestBody({ messagesPayload, enableVision, enableWebSearch }) {
    return {
        interface: 'puter-chat-completion',
        driver: 'ai-chat',
        test_mode: true,
        method: 'complete',
        args: {
            vision: enableVision,
            messages: messagesPayload,
            model: state.config.modelId,
            stream: true,
            ...(enableWebSearch && { tools: [{ type: 'web_search' }] })
        }
    };
}

function buildRequestHeaders(apiToken) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken || ''}`,
        'Accept': '*/*'
    };
}

async function prepareAssistantBubble(ctx) {
    setState((s) => ({
        messages: [...s.messages, { role: 'assistant', content: '' }]
    }));
    ctx.aiMsgIndex = state.messages.length - 1;
    emit('message:append', ctx.aiMsgIndex, { role: 'assistant', content: '' }, true);

    // Wait for the DOM update to flush so we can query the element
    await new Promise(r => requestAnimationFrame(r));
    const aiMsgEls = els.chatContainer.querySelectorAll('.message');
    const lastMsg = aiMsgEls[aiMsgEls.length - 1];
    const aiMsgId = lastMsg ? lastMsg.id : null;
    const aiMsgEl = aiMsgId ? document.getElementById(aiMsgId) : null;
    ctx.contentEl = aiMsgEl ? aiMsgEl.querySelector('.message-content') : null;
}

function handleToolUse(ctx, toolUse, operationId) {
    if (ctx.settled || state.lastOperationId !== operationId) return;
    if (!ctx.toolUseBlock) {
        ctx.toolUseBlock = document.createElement('div');
        ctx.toolUseBlock.className = 'tool-use-block';
        ctx.toolUseBlock.innerHTML = `<div class="tool-use-header"><span class="material-icons-outlined" style="font-size:16px">search</span> <span>Using Web Search</span></div><div class="tool-use-content"></div>`;
        ctx.contentEl.prepend(ctx.toolUseBlock);
    }
    const toolContent = ctx.toolUseBlock.querySelector('.tool-use-content');
    if (toolUse.name === 'web_search' && toolUse.input) {
        toolContent.textContent = `Searching for: ${JSON.stringify(toolUse.input)}`;
    } else {
        toolContent.textContent = `Tool: ${toolUse.name} - ${JSON.stringify(toolUse.input)}`;
    }
}

function handlePartialUpdate(ctx, update, operationId) {
    if (ctx.settled || state.lastOperationId !== operationId) return;
    const typing = ctx.contentEl && ctx.contentEl.querySelector('.typing-indicator');
    if (typing) typing.remove();

    if (update.accumulatedReasoning) {
        updateReasoningBlock(ctx, update.accumulatedReasoning);
    }

    if (update.accumulatedContent !== undefined) {
        updateContentBlock(ctx, update.accumulatedContent);
    }

    emit('ui:scroll-bottom');
}

function updateReasoningBlock(ctx, reasoningText) {
    ctx.fullReasoning = reasoningText;
    if (!ctx.reasoningBlock) {
        ctx.reasoningBlock = document.createElement('div');
        ctx.reasoningBlock.className = 'reasoning-block';
        ctx.reasoningBlock.innerHTML = `<div class="reasoning-header"><span>Thinking Process</span> <span class="material-icons-outlined" style="font-size:16px">expand_less</span></div><div class="reasoning-content open"></div>`;
        const rContent = ctx.reasoningBlock.querySelector('.reasoning-content');
        const rHeader = ctx.reasoningBlock.querySelector('.reasoning-header');
        rHeader.onclick = () => {
            rContent.classList.toggle('open');
            rHeader.querySelector('.material-icons-outlined').textContent = rContent.classList.contains('open') ? 'expand_less' : 'expand_more';
        };
        ctx.contentEl.prepend(ctx.reasoningBlock);
    }
    ctx.reasoningBlock.querySelector('.reasoning-content').textContent = reasoningText;
}

function updateContentBlock(ctx, content) {
    ctx.fullContent = content;
    if (!ctx.contentWrapper) {
        ctx.contentWrapper = document.createElement('div');
        ctx.contentWrapper.className = 'assistant-response';
        ctx.contentEl.appendChild(ctx.contentWrapper);
    }
    ctx.contentWrapper.innerHTML = sanitizeHtml(marked.parse(content));
    ctx.contentWrapper.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
    decorateCodeBlocks(ctx.contentWrapper);
}

function handleComplete(ctx, final, { inputTokens, currentModel, currentToken, operationId }) {
    if (ctx.settled || state.lastOperationId !== operationId) return;
    ctx.settled = true;
    const typing = ctx.contentEl && ctx.contentEl.querySelector('.typing-indicator');
    if (typing) typing.remove();

    const finalContent = final.accumulatedContent || ctx.fullContent;
    const finalReasoning = final.accumulatedReasoning || ctx.fullReasoning;
    const msg = state.messages[ctx.aiMsgIndex];
    if (msg && msg.role === 'assistant') {
        msg.content = finalContent;
        msg.reasoning = finalReasoning;

        const outputTokens = estimateTokens(finalContent);
        msg.cost = calculateMessageCost(inputTokens, outputTokens, currentModel?.costInfo);
    }

    emit('messages:rerender');
    emit('chat:save');

    settleGeneration();

    if (currentToken && (currentToken.value || currentToken.token)) {
        tokenManager.markTokenSuccess(currentToken.value || currentToken.token);
    }
}

function handleStreamError(ctx, err, { currentToken, operationId }) {
    if (ctx.settled || state.lastOperationId !== operationId) return;
    ctx.settled = true;
    const typing = ctx.contentEl && ctx.contentEl.querySelector('.typing-indicator');
    if (typing) typing.remove();

    if (err.name === 'AbortError') {
        finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning);
    } else {
        // Keep any partial answer the user already paid for; otherwise drop
        // the empty placeholder entirely and say what happened.
        if (ctx.fullContent || ctx.fullReasoning) {
            finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning);
        } else {
            removeEmptyAssistantPlaceholder(ctx.aiMsgIndex);
            emit('messages:rerender');
        }
        if (currentToken && (currentToken.value || currentToken.token)) {
            tokenManager.markTokenFailed(currentToken.value || currentToken.token);
            emit('toast:show', `Token "${currentToken.name}" failed. ${tokenManager.rotationEnabled ? 'Rotating to next token.' : 'Please check token or enable rotation.'}`, 'error');
        } else {
            emit('toast:show', `Failed to generate response: ${err.message || err}`, 'error');
        }
    }
    settleGeneration();
}

function handleOuterStreamError(err, ctx) {
    // handleStreamError already runs via the onError callback; this path only
    // fires for failures that never reached the stream callbacks (e.g. payload
    // construction blew up first). Don't double-handle.
    if (ctx.settled) return;
    ctx.settled = true;
    if (err.name === 'AbortError') {
        finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning);
    } else {
        removeEmptyAssistantPlaceholder(ctx.aiMsgIndex);
        emit('messages:rerender');
        emit('toast:show', `Failed to generate response: ${err.message || err}`, 'error');
    }
    settleGeneration();
}

export function abortAssistantResponse() {
    const ctx = activeStream;
    if (!ctx) {
        // Nothing in flight; make sure the UI flag isn't stuck anyway.
        if (state.isGenerating) settleGeneration();
        return;
    }

    // Abort the underlying fetch; callbacks will no-op via ctx.settled /
    // operationId mismatch.
    try {
        state.abortController?.abort();
    } catch (err) {
        console.warn('Failed to abort stream:', err);
    }

    // Settle synchronously: keep whatever partial answer we have (or drop the
    // empty placeholder), so the UI never depends on the abort error arriving.
    ctx.settled = true;
    finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning);
    settleGeneration();

    // Show feedback to user
    emit('toast:show', 'Response generation stopped');
}
