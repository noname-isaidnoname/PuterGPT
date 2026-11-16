import { streamPuterCompletion } from 'https://noname-isaidnoname.github.io/MyAIUtilities/puterStream.js';
import { state, els } from './state.js';
import { tokenManager } from './token-manager.js';
import { setState } from './store.js';
import { estimateTokens, calculateMessageCost, isFreeModel } from './models.js';
import { emit } from './event-bus.js';
import { decorateCodeBlocks } from './chat-ui.js';
import { getMessageText } from './utils.js';
import { sanitizeHtml } from './sanitize.js';
import { db, reportStorageError } from './indexeddb-storage.js';
import { normalizeGenerationParams } from './generation-params.js';
import { addResponseVariant } from './variants.js';

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
function finalizePartialResponse(aiMsgIndex, fullContent, fullReasoning, originalMessage = null) {
    if (originalMessage && aiMsgIndex !== undefined && state.messages[aiMsgIndex]) {
        const response = { role: 'assistant', content: fullContent || '[Response not generated]', reasoning: fullReasoning };
        state.messages[aiMsgIndex] = fullContent || fullReasoning
            ? addResponseVariant(originalMessage, response) : originalMessage;
        emit('messages:rerender');
        if (fullContent || fullReasoning) emit('chat:save');
        return;
    }
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

export async function triggerAssistantResponse({ autoTitle = false, regenerateIndex = null } = {}) {
    if (state.isGenerating) {
        console.warn('Assistant response already in progress, ignoring duplicate request');
        return;
    }

    if (regenerateIndex !== null && (!state.variantsEnabled || regenerateIndex !== state.messages.length - 1
        || state.messages[regenerateIndex]?.role !== 'assistant' || state.messages[regenerateIndex - 1]?.role !== 'user')) return;
    // Mark synchronously so a re-entrant call in the same tick can't slip through.
    setState({ isGenerating: true });

    const ctx = createStreamContext();
    ctx.autoTitle = autoTitle;
    ctx.originalMessage = regenerateIndex === null ? null : structuredClone(state.messages[regenerateIndex]);
    ctx.chatId = state.currentChatId;
    ctx.firstUserText = autoTitle ? getMessageText(state.messages[0]).slice(0, 2000) : '';
    // Register immediately so abortAssistantResponse() can finalize even if the
    // abort lands before the bubble / operation id are set up.
    activeStream = ctx;

    try {
        const currentModel = state.models.find(m => m.id === state.config.modelId);
        const { messagesPayload, inputTokens, enableVision, enableWebSearch } = buildRequestPayload(currentModel, !!ctx.originalMessage);

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
        if (activeStream === ctx) {
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

function buildRequestPayload(currentModel, regenerating = false) {
    const conversation = regenerating ? state.messages.slice(0, -1) : state.messages;
    const lastUserMessage = conversation.filter(m => m.role === 'user').pop();
    const hasImagesForApi = lastUserMessage && lastUserMessage.images && lastUserMessage.images.length > 0;
    const modelSupportsVision = currentModel && currentModel.supportsVision;
    const modelSupportsSearch = currentModel && currentModel.supportsSearch;
    const enableVision = hasImagesForApi && modelSupportsVision;
    const enableWebSearch = modelSupportsSearch && state.config.enableWebSearch;

    const messagesPayload = [
        { role: 'system', content: state.config.systemPrompt },
        ...conversation.map(({ variants, activeVariant, ...message }) => message)
    ];
    const inputText = messagesPayload.map(m => getMessageText(m)).join(' ');
    const inputTokens = estimateTokens(inputText);

    return { messagesPayload, inputTokens, enableVision, enableWebSearch };
}

function buildStreamRequestBody({ messagesPayload, enableVision, enableWebSearch }) {
    const { temperature, maxTokens } = normalizeGenerationParams(state.generationParams);
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
            ...(temperature !== null && { temperature }),
            ...(maxTokens !== null && { max_tokens: maxTokens }),
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
        messages: [...(ctx.originalMessage ? s.messages.slice(0, -1) : s.messages), { role: 'assistant', content: '' }]
    }));
    ctx.aiMsgIndex = state.messages.length - 1;
    if (ctx.originalMessage) emit('messages:rerender');
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
        if (ctx.originalMessage) {
            state.messages[ctx.aiMsgIndex] = finalContent || finalReasoning
                ? addResponseVariant(ctx.originalMessage, msg)
                : ctx.originalMessage;
        }
    }

    emit('messages:rerender');
    emit('chat:save');

    settleGeneration();
    if (ctx.autoTitle && finalContent) {
        generateChatTitle(ctx.chatId, ctx.firstUserText, finalContent.slice(0, 2000));
    }

    if (currentToken && (currentToken.value || currentToken.token)) {
        tokenManager.markTokenSuccess(currentToken.value || currentToken.token);
    }
}

const TITLE_MAX_ATTEMPTS = 3;
// Last-resort free router when the primary free model can't produce a title.
const TITLE_FALLBACK_MODEL = 'openrouter:openrouter/free';

// Try a title completion up to TITLE_MAX_ATTEMPTS times (request errors and
// unusable/empty responses all count as failures) with a short backoff.
// Returns the parsed title, or '' if every attempt failed.
async function generateTitleWithRetry(apiToken, modelId, messages) {
    for (let attempt = 1; attempt <= TITLE_MAX_ATTEMPTS; attempt++) {
        try {
            const title = parseGeneratedTitle(await requestTitleCompletion(apiToken, modelId, messages));
            if (title) return title;
            console.warn(`Chat title generation attempt ${attempt}/${TITLE_MAX_ATTEMPTS} (model: ${modelId}) returned no usable title`);
        } catch (error) {
            console.warn(`Chat title generation attempt ${attempt}/${TITLE_MAX_ATTEMPTS} (model: ${modelId}) failed:`, error);
        }
        if (attempt < TITLE_MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 300 * attempt));
    }
    return '';
}

// One-off (non-streaming) title completion. The shared helper handles
// Puter's non-stream response shape ({success, result: {message: {content}}})
// natively now, including the driver "streaming anyway" as NDJSON. Errors
// propagate (the helper throws after reporting) and are retried by the caller.
async function requestTitleCompletion(apiToken, modelId, messages) {
    let content = '';
    await streamPuterCompletion({
        apiUrl: "https://api.puter.com/drivers/call",
        requestBody: {
            interface: 'puter-chat-completion', driver: 'ai-chat', test_mode: true, method: 'complete',
            args: { model: modelId, stream: false, messages }
        },
        headers: buildRequestHeaders(apiToken),
        onComplete: (final) => { content = final.accumulatedContent || ''; }
    });
    return content;
}

// Models frequently wrap reasoning in inline tags even in content — drop those
// sections so the JSON title can be found.
function stripInlineReasoning(text) {
    return (text || '')
        .replace(/<(thought|think|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(thought|think|reasoning)>[\s\S]*$/i, '');
}

// Models frequently ignore the "JSON only" instruction, so accept the common
// shapes they emit instead: a bare JSON object (possibly wrapped in prose or
// code fences), single-quoted/Python-style dicts, nested objects, a
// "Title: ..." line, or a bare title on its own line. Returns '' on failure.
function parseGeneratedTitle(raw) {
    const text = stripInlineReasoning((raw || '').trim()).trim();
    if (!text) return '';

    // 1. JSON object, possibly wrapped in prose or code fences.
    const candidates = [text];
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
        candidates.push(match[0]);
        // Python-style dicts: {'title': 'Foo'}
        candidates.push(match[0].replace(/'/g, '"'));
    }
    for (const candidate of candidates) {
        try {
            const title = extractTitleFromObject(JSON.parse(candidate));
            if (title) return title;
        } catch { /* try next candidate */ }
    }

    // 2. A "Title: ..." (or "Title - ..." / "title = ...") line anywhere in the text.
    const lineMatch = text.match(/title\s*[:=\-–]\s*([^\n]+)/i);
    if (lineMatch) {
        const title = cleanTitleText(lineMatch[1]);
        if (title) return title;
    }

    // 3. No JSON at all — assume the model answered with the title itself and
    // use the last non-empty line (the title usually follows any preamble).
    if (!text.includes('{')) {
        const lines = text.split('\n').map(cleanTitleText).filter(Boolean);
        if (lines.length) return lines[lines.length - 1];
    }
    return '';
}

function extractTitleFromObject(parsed, depth = 0) {
    if (!parsed || typeof parsed !== 'object' || depth > 2) return '';
    // Prefer a key that looks like "title" (case-insensitive).
    for (const [key, value] of Object.entries(parsed)) {
        if (/title/i.test(key) && typeof value === 'string' && value.trim()) return cleanTitleText(value);
    }
    // A single string-valued key is almost certainly the title.
    const strings = Object.values(parsed).filter(v => typeof v === 'string' && v.trim());
    if (strings.length === 1) return cleanTitleText(strings[0]);
    // Otherwise recurse one level (e.g. {"response": {"title": "..."}}).
    for (const value of Object.values(parsed)) {
        const nested = extractTitleFromObject(value, depth + 1);
        if (nested) return nested;
    }
    return '';
}

function cleanTitleText(s) {
    return (s || '')
        .replace(/^[\s*_`#"']+|[\s*_`#"']+$/g, '') // leading/trailing quotes, markdown, hashes
        .replace(/\*\*|__/g, '')                   // emphasis markers
        .replace(/[.\s]+$/, '')                    // trailing period
        .trim();
}

async function generateChatTitle(chatId, userText, assistantText) {
    try {
        if ((await db.settings.get('auto_name_chats'))?.value === false) return;
        // Never incur a paid completion solely for a title (the fallback router is free too).
        const model = state.models.find(isFreeModel);
        if (!model) return;
        const apiToken = await tokenManager.getApiToken();
        if (!apiToken) return;
        let title = '';
        const titleMessages = [
            { role: 'system', content: 'You are a title generator. Your only job is to invent a short title for a conversation. Rules: your entire response MUST be a single-line JSON object exactly of the form {"title": "your title here"}. The title must be at most six words and contain no double quotes. No explanation, no reasoning, no preamble, no markdown, no code fences, no extra keys, no trailing text. Output the JSON object and nothing else.' },
            { role: 'user', content: `User: ${userText}\n\nAssistant: ${assistantText}` }
        ];
        title = await generateTitleWithRetry(apiToken, model.id, titleMessages);
        if (!title && model.id !== TITLE_FALLBACK_MODEL) {
            console.warn(`Chat title generation failed for ${model.id}; falling back to ${TITLE_FALLBACK_MODEL}`);
            title = await generateTitleWithRetry(apiToken, TITLE_FALLBACK_MODEL, titleMessages);
        }
        title = title.replace(/^["'`#\s]+|["'`\s]+$/g, '').split(/\s+/).slice(0, 6).join(' ').slice(0, 100);
        let usedFallback = false;
        if (!title) {
            const flat = userText.replace(/\s+/g, ' ').trim();
            if (!flat) return;
            title = flat.substring(0, 25) + (flat.length > 25 ? '...' : '');
            usedFallback = true;
        }
        let applied = false;
        await db.transaction('rw', db.chats, async () => {
            const chat = await db.chats.get(chatId);
            if (!chat || chat.manuallyRenamed || chat.importedAt || chat.sharedAt
                || getMessageText(chat.messages[0]).slice(0, 2000) !== userText
                || getMessageText(chat.messages[1]).slice(0, 2000) !== assistantText) return;
            await db.chats.update(chatId, { title, autoNamed: true });
            applied = true;
        });
        if (applied && usedFallback) {
            emit('toast:show', "Couldn't generate a chat title, so the start of your message was used instead.", 'warning');
        }
        emit('chats:refresh-needed');
    } catch (error) {
        if (!reportStorageError(error)) console.warn('Could not generate chat title:', error);
    }
}

function handleStreamError(ctx, err, { currentToken, operationId }) {
    if (ctx.settled || state.lastOperationId !== operationId) return;
    ctx.settled = true;
    const typing = ctx.contentEl && ctx.contentEl.querySelector('.typing-indicator');
    if (typing) typing.remove();

    if (err.name === 'AbortError') {
        finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning, ctx.originalMessage);
    } else {
        // Keep any partial answer the user already paid for; otherwise drop
        // the empty placeholder entirely and say what happened.
        if (ctx.fullContent || ctx.fullReasoning || ctx.originalMessage) {
            finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning, ctx.originalMessage);
        } else {
            removeEmptyAssistantPlaceholder(ctx.aiMsgIndex);
            emit('messages:rerender');
        }
        const friendly = err.code === 'NO_FALLBACK_MODEL'
            ? 'Puter could not find a model to serve this request. Try a different model.'
            : `Failed to generate response: ${err.message || err}`;
        if (currentToken && (currentToken.value || currentToken.token)) {
            tokenManager.markTokenFailed(currentToken.value || currentToken.token);
            emit('toast:show', `Token "${currentToken.name}" failed. ${tokenManager.rotationEnabled ? 'Rotating to next token.' : 'Please check token or enable rotation.'}`, 'error');
        } else {
            emit('toast:show', friendly, 'error');
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
        finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning, ctx.originalMessage);
    } else {
        if (ctx.originalMessage && ctx.aiMsgIndex !== undefined) {
            finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning, ctx.originalMessage);
        } else {
            removeEmptyAssistantPlaceholder(ctx.aiMsgIndex);
            emit('messages:rerender');
        }
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
    finalizePartialResponse(ctx.aiMsgIndex, ctx.fullContent, ctx.fullReasoning, ctx.originalMessage);
    settleGeneration();

    // Show feedback to user
    emit('toast:show', 'Response generation stopped');
}
