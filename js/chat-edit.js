import { state } from './state.js';
import { getMessageText } from './utils.js';
import { setState } from './store.js';
import { emit } from './event-bus.js';
import { editActiveVariant } from './variants.js';

window.enterEditMode = function(index) {
    if (state.isGenerating) {
        emit('toast:show', 'Stop generation before editing a message.', 'warning');
        return;
    }
    const message = state.messages[index];
    const msgEl = document.querySelector(`.message[data-index='${index}']`);
    if (!msgEl) return;

    const contentEl = msgEl.querySelector('.message-content');
    const renderedContent = contentEl.querySelector('.rendered-content') || contentEl.querySelector('.user-bubble');
    const actions = msgEl.querySelector('.msg-footer');
    
    renderedContent.style.display = 'none';
    if (actions) {
        actions.style.display = 'none';
    }

    const editUI = document.createElement('div');
    editUI.className = 'edit-container';

    let buttonsHtml;
    if (message.role === 'user') {
        buttonsHtml = `
            <button class="btn danger" onclick="cancelEdit(${index})">Cancel</button>
            <button class="btn primary" onclick="saveEdit(${index})">Save</button>
            <button class="btn primary" onclick="saveAndRegenerate(${index})">Save + Regenerate</button>
        `;
    } else {
        buttonsHtml = `
            <button class="btn danger" onclick="cancelEdit(${index})">Cancel</button>
            <button class="btn primary" onclick="saveEdit(${index})">Save</button>
        `;
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.id = `edit-textarea-${index}`;
    // Set via .value, never innerHTML — the message text is untrusted.
    textarea.value = getMessageText(message);

    editUI.appendChild(textarea);
    const controls = document.createElement('div');
    controls.className = 'edit-controls';
    controls.innerHTML = buttonsHtml;
    editUI.appendChild(controls);

    contentEl.appendChild(editUI);
    textarea.focus();
    textarea.selectionStart = textarea.value.length;
};

window.cancelEdit = function(index) {
    emit('messages:rerender');
};

function readEditTextarea(index) {
    const textarea = document.getElementById(`edit-textarea-${index}`);
    return textarea ? textarea.value : null;
}

function commitMessageEdit(index, newContent, { truncate = false } = {}) {
    setState((state) => {
        const newMessages = [...state.messages];
        const updatedMessage = newMessages[index].role === 'assistant'
            ? editActiveVariant(newMessages[index], newContent)
            : { ...newMessages[index], content: newContent };
        // When regenerating from a user message, refresh the system prompt
        // snapshot so the export reflects the prompt that will be (or just
        // was) used for the new assistant response. Assistant message edits
        // don't change the prompt that originally produced the response,
        // so we leave that snapshot untouched.
        if (truncate && newMessages[index].role === 'user') {
            updatedMessage.systemPrompt = state.config.systemPrompt;
        }
        newMessages[index] = updatedMessage;
        return { messages: truncate ? newMessages.slice(0, index + 1) : newMessages };
    });
    emit('messages:rerender');
    emit('chat:save');
}

window.saveEdit = function(index) {
    const newContent = readEditTextarea(index);
    if (newContent === null) return;
    commitMessageEdit(index, newContent);
    emit('toast:show', "Message updated");
};

window.saveAndRegenerate = async function(index) {
    const newContent = readEditTextarea(index);
    if (newContent === null) return;
    // Stop any in-flight generation before truncating, so its finalize step
    // can't resurrect messages that are about to be discarded.
    const { abortAssistantResponse } = await import('./chat-api.js');
    abortAssistantResponse();
    commitMessageEdit(index, newContent, { truncate: true });

    await import('./chat-api.js').then(m => m.triggerAssistantResponse());
};
