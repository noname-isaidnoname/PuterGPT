import { state } from './state.js';
import { getMessageText } from './utils.js';
import { setState } from './store.js';
import { emit } from './event-bus.js';

window.enterEditMode = function(index) {
    const message = state.messages[index];
    const msgEl = document.querySelector(`.message[data-index='${index}']`);
    if (!msgEl) return;

    const contentEl = msgEl.querySelector('.message-content');
    const renderedContent = contentEl.querySelector('.rendered-content');
    const actions = msgEl.querySelector('.avatar-actions');
    
    renderedContent.style.display = 'none';
    if (actions) {
        actions.style.display = 'none';
    }

    const editUI = document.createElement('div');
    editUI.className = 'edit-container';
    
    let buttonsHtml = `
        <button class="btn danger" onclick="cancelEdit(${index})">Cancel</button>
        <button class="btn primary" onclick="saveEdit(${index})">Save</button>
    `;
    
    if (message.role === 'user') {
        buttonsHtml += `
            <button class="btn primary" onclick="saveAndRegenerate(${index})">Save + Regenerate</button>
        `;
    }

    editUI.innerHTML = `
        <textarea class="edit-textarea" id="edit-textarea-${index}">${getMessageText(message)}</textarea>
        <div class="edit-controls">
            ${buttonsHtml}
        </div>
    `;

    contentEl.appendChild(editUI);
    const textarea = editUI.querySelector('textarea');
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
        const updatedMessage = { ...newMessages[index], content: newContent };
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
    commitMessageEdit(index, newContent, { truncate: true });

    await import('./chat-api.js').then(m => m.triggerAssistantResponse());
};
