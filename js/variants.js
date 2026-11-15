import { state } from './state.js';
import { setState } from './store.js';
import { emit } from './event-bus.js';
import { createConfirmModal } from './modal-helper.js';

// Each snapshot contains the full assistant response metadata, but never
// recursively embeds variants. The top-level fields mirror the active one.
export function responseSnapshot(message) {
    const { variants, activeVariant, role, ...snapshot } = message;
    return structuredClone(snapshot);
}

export function variantsOf(message) {
    if (!Array.isArray(message.variants) || !message.variants.length
        || !message.variants.every(v => v && typeof v === 'object' && typeof v.content === 'string')
        || !Number.isInteger(message.activeVariant) || message.activeVariant < 0
        || message.activeVariant >= message.variants.length) {
        return [responseSnapshot(message)];
    }
    return structuredClone(message.variants);
}

export function addResponseVariant(original, response) {
    const variants = variantsOf(original);
    variants.push(responseSnapshot(response));
    return { role: 'assistant', ...variants[variants.length - 1], variants, activeVariant: variants.length - 1 };
}

export function editActiveVariant(message, content) {
    if (!Array.isArray(message.variants)) return { ...message, content };
    const variants = variantsOf(message);
    const active = Number.isInteger(message.activeVariant) && message.activeVariant >= 0 && message.activeVariant < variants.length
        ? message.activeVariant : 0;
    variants[active] = { ...variants[active], content };
    return { ...message, ...variants[active], variants, activeVariant: active };
}

window.regenerateResponseVariant = async index => {
    if (!state.variantsEnabled || state.isGenerating || index !== state.messages.length - 1
        || state.messages[index]?.role !== 'assistant' || state.messages[index - 1]?.role !== 'user') return;
    const { triggerAssistantResponse } = await import('./chat-api.js');
    await triggerAssistantResponse({ regenerateIndex: index });
};

window.switchResponseVariant = (index, direction) => {
    if (!state.variantsEnabled || state.isGenerating) return;
    const message = state.messages[index];
    if (!message || message.role !== 'assistant' || !Array.isArray(message.variants)) return;
    const variants = variantsOf(message);
    const current = Number.isInteger(message.activeVariant) ? message.activeVariant : 0;
    const target = current + direction;
    if (target < 0 || target >= variants.length) return;
    const chatId = state.currentChatId;
    const apply = async () => {
        if (state.currentChatId !== chatId || state.messages[index] !== message || state.isGenerating) return;
        // A later turn belongs to the currently selected response, not this one.
        const { abortAssistantResponse } = await import('./chat-api.js');
        abortAssistantResponse();
        if (state.currentChatId !== chatId || state.messages[index] !== message || state.isGenerating) return;
        const messages = state.messages.slice(0, index + 1);
        messages[index] = { role: 'assistant', ...variants[target], variants, activeVariant: target };
        setState({ messages });
        emit('messages:rerender');
        emit('chat:save');
    };
    if (index < state.messages.length - 1) {
        createConfirmModal({
            title: 'Switch response?',
            body: '<p>Later messages depend on this response and will be removed. This cannot be undone.</p>',
            confirmLabel: 'Switch and remove later messages',
            confirmStyle: 'danger',
            onConfirm: apply
        });
    } else {
        apply();
    }
};
