import { streamPuterCompletion } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterStream.js';
import { state, els } from './state.js';
import { tokenManager } from './token-manager.js';
import { setState } from './store.js';
import { estimateTokens, calculateMessageCost } from './models.js';
import { emit } from './event-bus.js';
import { decorateCodeBlocks } from './chat-ui.js';

// Global operation lock to prevent concurrent API calls
let isOperationInProgress = false;

/**
 * Persist any partial assistant response (or drop the empty assistant bubble
 * when there is nothing to keep). Used by both the abort path and the error
 * path.
 */
function finalizePartialResponse(aiMsgIndex, fullContent, fullReasoning) {
    if (fullContent || fullReasoning) {
        const finalContent = fullContent || (fullReasoning ? '[Response not generated]' : '');
        state.messages[aiMsgIndex].content = finalContent;
        state.messages[aiMsgIndex].reasoning = fullReasoning;
        emit('messages:rerender');
        emit('chat:save');
    } else {
        state.messages.splice(aiMsgIndex, 1);
        emit('messages:rerender');
    }
}

/**
 * Remove the placeholder assistant message that the streaming callback added.
 * Falls back to the most recent message if the expected index is no longer
 * the empty placeholder.
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

export async function triggerAssistantResponse() {
    if (isOperationInProgress) {
        console.warn('Assistant response already in progress, ignoring duplicate request');
        return;
    }

    isOperationInProgress = true;

    const ctx = createStreamContext();

    try {
        const currentModel = state.models.find(m => m.id === state.config.modelId);
        const { messagesPayload, inputTokens, enableVision, enableWebSearch } = buildRequestPayload(currentModel);

        await prepareAssistantBubble(ctx);
        const operationId = Date.now();
        const abortController = new AbortController();
        setState({
            lastOperationId: operationId,
            abortController
        });

        const currentToken = await tokenManager.getCurrentToken();
        const apiToken = await tokenManager.getApiToken();

        await streamPuterCompletion({
            apiUrl: "https://api.puter.com/drivers/call",
            requestBody: buildStreamRequestBody({ messagesPayload, enableVision, enableWebSearch }),
            headers: buildRequestHeaders(apiToken),
            signal: abortController.signal,
            onToolUse: (toolUse) => handleToolUse(ctx, toolUse, operationId),
            onPartialUpdate: (update) => handlePartialUpdate(ctx, update, operationId),
            onComplete: (final) => handleComplete(ctx, final, { inputTokens, currentModel, operationId }),
            onError: (err) => handleStreamError(ctx, err, { currentToken, operationId })
        });
    } catch (err) {
        handleOuterStreamError(err, ctx);
    } finally {
        isOperationInProgress = false;
        if (state.abortController) {
            setState({ abortController: null });
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
        toolUseBlock: null
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
    const inputText = messagesPayload.map(m => m.content).join(' ');
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
    if (state.lastOperationId !== operationId) return;
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
    if (state.lastOperationId !== operationId) return;
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
    ctx.contentWrapper.innerHTML = marked.parse(content);
    ctx.contentWrapper.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
    decorateCodeBlocks(ctx.contentWrapper);
}

function handleComplete(ctx, final, { inputTokens, currentModel, operationId }) {
    if (state.lastOperationId !== operationId) return;
    const typing = ctx.contentEl && ctx.contentEl.querySelector('.typing-indicator');
    if (typing) typing.remove();

    const finalContent = final.accumulatedContent || ctx.fullContent;
    const finalReasoning = final.accumulatedReasoning || ctx.fullReasoning;
    state.messages[ctx.aiMsgIndex].content = finalContent;
    state.messages[ctx.aiMsgIndex].reasoning = finalReasoning;

    const outputTokens = estimateTokens(finalContent);
    state.messages[ctx.aiMsgIndex].cost = calculateMessageCost(inputTokens, outputTokens, currentModel?.costInfo);

    emit('messages:rerender');
    emit('chat:save');

    setState({ lastOperationId: null, abortController: null });

    if (currentToken && (currentToken.value || currentToken.token)) {
        tokenManager.markTokenSuccess(currentToken.value || currentToken.token);
    }
}

function handleStreamError(ctx, err, { currentToken, operationId }) {
    if (state.lastOperationId !== operationId) return;
    const typing = ctx.contentEl && ctx.contentEl.querySelector('.typing-indicator');
    if (typing) typing.remove();

    if (err.name === 'AbortError') {
        finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning);
    } else {
        if (ctx.contentEl) {
            ctx.contentEl.innerHTML += `<p style="color:var(--danger)">Error: ${err.message}</p>`;
        }
        removeEmptyAssistantPlaceholder(ctx.aiMsgIndex);
        if (currentToken && (currentToken.value || currentToken.token)) {
            tokenManager.markTokenFailed(currentToken.value || currentToken.token);
            emit('toast:show', `Token "${currentToken.name}" failed. ${tokenManager.rotationEnabled ? 'Rotating to next token.' : 'Please check token or enable rotation.'}`, 'error');
        }
    }
    setState({ lastOperationId: null, abortController: null });
}

function handleOuterStreamError(err, ctx) {
    if (err.name === 'AbortError') {
        if (ctx.contentEl) {
            finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning);
        } else {
            removeEmptyAssistantPlaceholder(ctx.aiMsgIndex);
        }
        setState({ lastOperationId: null, abortController: null });
    } else {
        if (ctx.contentEl) {
            const typing = ctx.contentEl.querySelector('.typing-indicator');
            if (typing) typing.remove();
            ctx.contentEl.innerHTML = `<p style="color:var(--danger)">Stream Failed: ${err.message}</p>`;
        }
        removeEmptyAssistantPlaceholder(ctx.aiMsgIndex);
    }
}

export function abortAssistantResponse() {
    if (state.lastOperationId && state.abortController) {
        // Abort the current stream
        state.abortController.abort();

        // Clear operation state immediately
        setState({
            lastOperationId: null,
            abortController: null
        });

        // Show feedback to user
        emit('toast:show', 'Response generation stopped');
    }
}
