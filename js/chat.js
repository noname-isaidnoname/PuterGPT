import { state, els } from './state.js';
import { generateUniqueId } from './utils.js';
import { showChatContextMenu } from './ui.js';
import { tokenManager } from './token-manager.js';
import { reRenderAllMessages } from './chat-ui.js';
import { abortAssistantResponse } from './chat-api.js';
import { setState } from './store.js';
import { emit, on } from './event-bus.js';
import './chat-edit.js'; // Registers global edit functions

// Chat Logic & Rendering
window.showChatContextMenu = showChatContextMenu;

export function resizeInput() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
}

export function handleInputKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

export async function sendMessage() {
    const text = els.input.value.trim();
    if (!text && state.attachedImages.length === 0) return;

    // Check if assistant response is already in progress - if so, abort it
    if (state.lastOperationId && state.messages.some(m => m.role === 'assistant' && m.content === '')) {
        abortAssistantResponse();
        return;
    }

    // Check if there are images and model supports vision (early validation)
    const hasImages = state.attachedImages.length > 0;
    const currentModel = state.models.find(m => m.id === state.config.modelId);
    const modelSupportsVision = currentModel && currentModel.supportsVision;

    if (hasImages && !modelSupportsVision) {
        emit('toast:show', `Current model "${currentModel ? currentModel.name : 'Unknown'}" doesn't support vision. Please switch to a model with "(Vision)" in the name.`, 'error');
        return;
    }

    const currentToken = await tokenManager.getCurrentToken();
    if (!currentToken) {
        openSettings();
        emit('toast:show', "Please add at least one token in Settings!");
        return;
    }

    els.input.value = '';
    resizeInput();
    
    // Process message with images first
    await processUserTurn(text);
    
    // Clear attached images after processing
    setState({ attachedImages: [] });
    // Image preview will update automatically via subscription
}

function newChat() {
    setState({
        currentChatId: null,
        messages: [],
        attachedImages: []
    });
    reRenderAllMessages();
    // Image preview will update automatically via subscription
}

async function processUserTurn(text) {
    if (!state.currentChatId) {
        setState({ currentChatId: generateUniqueId() });
    }

    // Create message content with images
    let messageContent = text;
    let hasImagesForApi = false;

    if (state.attachedImages.length > 0) {
        hasImagesForApi = true;
        const contentParts = [];

        // Add text first (if present) with proper type
        if (text.trim()) {
            contentParts.push({
                type: 'text',
                text: text
            });
        } else {
            // If no text provided, add a default prompt
            contentParts.push({
                type: 'text',
                text: 'Please analyze this image and describe what you see.'
            });
        }

        // Add images with proper type
        state.attachedImages.forEach(imageData => {
            contentParts.push({
                type: 'image_url',
                image_url: { url: imageData.dataUrl }
            });
        });

        messageContent = contentParts;
    }

    // Store the message with images for rendering
    const newMessage = {
        role: 'user',
        content: messageContent,
        images: hasImagesForApi ? state.attachedImages.map(img => img.dataUrl) : null,
        // Snapshot the system prompt that will be used for the AI's response
        // to this turn. Consumers of the exported JSON can use this to
        // understand which prompt influenced each assistant response.
        systemPrompt: state.config.systemPrompt
    };
    
    setState((state) => ({
        messages: [...state.messages, newMessage]
    }));

    emit('message:append', state.messages.length - 1, newMessage);
    emit('chat:save');

    await import('./chat-api.js').then(m => m.triggerAssistantResponse());
}

