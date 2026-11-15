import { state } from './state.js';
import { createModal } from './modal-helper.js';
import { emit } from './event-bus.js';

function typingTarget(target) {
    return target instanceof HTMLElement && (target.isContentEditable
        || !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

export function openShortcuts() {
    if (document.querySelector('.modal-overlay.active')) return;
    const previouslyFocused = document.activeElement;
    const modal = createModal(`
        <div class="modal shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
            <div class="shortcut-header">
                <h3 id="shortcuts-title">Keyboard shortcuts</h3>
                <button class="settings-close" type="button" aria-label="Close shortcuts"><span class="material-icons-outlined">close</span></button>
            </div>
            <p>Use these shortcuts outside text fields. Ctrl+K also works while typing. On macOS, use ⌘ instead of Ctrl.</p>
            <div class="shortcut-list">
                <div class="shortcut-row"><span>Focus chat filter</span><span class="search-shortcuts"><kbd>Ctrl</kbd> + <kbd>K</kbd></span></div>
                <div class="shortcut-row"><span>Open settings</span><span class="search-shortcuts"><kbd>Ctrl</kbd> + <kbd>,</kbd></span></div>
                <div class="shortcut-row"><span>Export current chat as JSON</span><span class="search-shortcuts"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>E</kbd></span></div>
                <div class="shortcut-row"><span>Show this guide</span><span class="search-shortcuts"><kbd>?</kbd></span></div>
            </div>
        </div>`);
    const close = modal.querySelector('.settings-close');
    const remove = modal.remove.bind(modal);
    modal.remove = () => {
        remove();
        if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
    close.addEventListener('click', () => modal.remove());
    setTimeout(() => { if (modal.isConnected) close.focus(); }, 60);
}

export function initializeShortcuts() {
    document.getElementById('shortcuts-help').addEventListener('click', openShortcuts);
    document.addEventListener('keydown', async event => {
        if (event.defaultPrevented || event.isComposing || event.repeat || document.querySelector('.modal-overlay.active')) return;
        const modifier = (event.ctrlKey || event.metaKey) && !event.altKey;
        const key = event.key.toLowerCase();
        if (modifier && !event.shiftKey && key === 'k') {
            event.preventDefault();
            if (window.innerWidth <= 768) document.getElementById('sidebar').classList.add('open');
            document.getElementById('sidebar-filter').focus();
            return;
        }
        if (typingTarget(event.target)) return;
        if (modifier && !event.shiftKey && key === ',') {
            event.preventDefault();
            window.openSettings();
        } else if (modifier && event.shiftKey && key === 'e') {
            event.preventDefault();
            const chatId = state.currentChatId;
            if (!chatId) {
                emit('toast:show', 'Open a saved chat to export it.', 'warning');
                return;
            }
            // Ensure the event listener is registered before emitting.
            await import('./export.js');
            emit('chat:export-json', chatId);
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === '?') {
            event.preventDefault();
            openShortcuts();
        }
    });
}
