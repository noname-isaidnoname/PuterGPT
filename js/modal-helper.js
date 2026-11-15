// Shared modal helper. Reduces duplication across the token UI modals.
import { emit } from './event-bus.js';
import { escapeHtml } from './utils.js';

const modalStack = [];
let modalId = 0;
const focusSelector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(dialog) {
    return [...dialog.querySelectorAll(focusSelector)].filter(element =>
        !element.closest('[inert], [hidden], [aria-hidden="true"]')
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden');
}

/**
 * Create a modal overlay with the given inner HTML, attach it to <body>,
 * make it active, and wire up the close-on-overlay-click / close-on-Escape
 * behaviour. Returns the modal element so callers can attach their own
 * button handlers. The returned modal has a `.remove()` override that also
 * unregisters its Escape listener — always remove via `modal.remove()`.
 */
export function createModal(htmlContent) {
    const previousFocus = document.activeElement;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = htmlContent;
    const dialog = modal.querySelector('.modal') || modal;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (!dialog.hasAttribute('aria-labelledby') && !dialog.hasAttribute('aria-label')) {
        const heading = dialog.querySelector('h1, h2, h3, h4, h5, h6');
        if (heading) {
            if (!heading.id) heading.id = `dynamic-modal-title-${++modalId}`;
            dialog.setAttribute('aria-labelledby', heading.id);
        } else {
            dialog.setAttribute('aria-label', 'Dialog');
        }
    }
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
    document.body.appendChild(modal);
    modalStack.push(modal);
    const isTop = () => modalStack[modalStack.length - 1] === modal;
    const focusFirst = () => (focusableElements(dialog)[0] || dialog).focus();

    // Animate in
    setTimeout(() => {
        if (!modal.isConnected) return;
        modal.classList.add('active');
        if (isTop() && !modal.contains(document.activeElement)) focusFirst();
    }, 10);

    const handleKey = (e) => {
        if (!isTop()) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            modal.remove();
        } else if (e.key === 'Tab') {
            const elements = focusableElements(dialog);
            if (!elements.length) {
                e.preventDefault();
                dialog.focus();
                return;
            }
            const index = elements.indexOf(document.activeElement);
            if (index === -1 || (e.shiftKey && index === 0) || (!e.shiftKey && index === elements.length - 1)) {
                e.preventDefault();
                (e.shiftKey ? elements[elements.length - 1] : elements[0]).focus();
            }
        }
    };
    const handleFocus = (e) => {
        if (isTop() && modal.classList.contains('active') && !modal.contains(e.target)) focusFirst();
    };
    // Ensure every removal path unregisters the Escape listener, no matter
    // who calls the element's remove().
    const nativeRemove = modal.remove.bind(modal);
    modal.remove = () => {
        const wasTop = isTop();
        const index = modalStack.indexOf(modal);
        if (index < 0) return;
        modalStack.splice(index, 1);
        document.removeEventListener('keydown', handleKey, true);
        document.removeEventListener('focusin', handleFocus, true);
        nativeRemove();
        if (wasTop && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        else if (wasTop && modalStack.length) {
            const parentDialog = modalStack[modalStack.length - 1].querySelector('.modal');
            if (parentDialog) (focusableElements(parentDialog)[0] || parentDialog).focus();
        }
    };

    // Close on overlay click (not on inner content)
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });

    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('focusin', handleFocus, true);

    return modal;
}

/**
 * Convenience: create a confirmation modal with Cancel + Confirm buttons.
 * The confirm button is styled as primary/danger via the `confirmStyle` arg.
 * `title` and the button labels are escaped; `body` is trusted HTML and is
 * inserted as-is (escape any user-controlled content inside it yourself).
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body - HTML body
 * @param {string} options.confirmLabel
 * @param {string} options.cancelLabel
 * @param {() => void | Promise<void>} options.onConfirm
 * @param {() => void} [options.onCancel]
 * @param {'primary'|'danger'} [options.confirmStyle='primary']
 */
export function createConfirmModal({
    title,
    body = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    onConfirm,
    onCancel,
    confirmStyle = 'primary'
}) {
    const confirmClass = confirmStyle === 'danger' ? 'btn danger' : 'btn primary';
    const modal = createModal(`
        <div class="modal" style="max-width: 400px;">
            <h3>${escapeHtml(title)}</h3>
            ${body}
            <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px;">
                <button class="btn" id="cancel-btn">${escapeHtml(cancelLabel)}</button>
                <button class="${confirmClass}" id="confirm-btn">${escapeHtml(confirmLabel)}</button>
            </div>
        </div>
    `);
    const cancelBtn = modal.querySelector('#cancel-btn');
    const confirmBtn = modal.querySelector('#confirm-btn');
    cancelBtn.addEventListener('click', () => {
        modal.remove();
        if (onCancel) onCancel();
    });
    confirmBtn.addEventListener('click', async () => {
        try {
            await onConfirm();
            modal.remove();
        } catch (err) {
            emit('toast:show', err.message || String(err), 'error');
        }
    });
    return modal;
}

/**
 * Convenience: create a single-line input modal (stand-in for window.prompt).
 * Enter in the input confirms; Escape / overlay click / Cancel dismisses.
 * The `title` and labels are escaped. Values are handed to `onConfirm`
 * trimmed; if onConfirm throws, the modal stays open and the error is
 * shown as a toast (same contract as createConfirmModal).
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.label] - visible label tied to the input
 * @param {string} [options.message] - trusted HTML shown under the title
 * @param {string} [options.defaultValue='']
 * @param {string} [options.placeholder='']
 * @param {string} [options.confirmLabel='Save']
 * @param {string} [options.cancelLabel='Cancel']
 * @param {'primary'|'danger'} [options.confirmStyle='primary']
 * @param {boolean} [options.allowEmpty=false] - reject empty input when false
 * @param {(value: string) => void | Promise<void>} [options.onConfirm]
 * @param {() => void} [options.onCancel]
 */
export function createPromptModal({
    title,
    label,
    message,
    defaultValue = '',
    placeholder = '',
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
    confirmStyle = 'primary',
    allowEmpty = false,
    onConfirm,
    onCancel
}) {
    const confirmClass = confirmStyle === 'danger' ? 'btn danger' : 'btn primary';
    const inputId = 'prompt-modal-input';
    const modal = createModal(`
        <div class="modal" style="max-width: 400px;">
            <h3>${escapeHtml(title)}</h3>
            ${message ? `<p style="color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; margin: 0;">${message}</p>` : ''}
            <div class="select-group" style="margin-bottom: 0;">
                ${label ? `<label for="${inputId}">${escapeHtml(label)}</label>` : ''}
                <input type="text" id="${inputId}" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false">
            </div>
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button class="btn" id="prompt-cancel-btn">${escapeHtml(cancelLabel)}</button>
                <button class="${confirmClass}" id="prompt-confirm-btn">${escapeHtml(confirmLabel)}</button>
            </div>
        </div>
    `);
    const input = modal.querySelector('#' + inputId);
    const cancelBtn = modal.querySelector('#prompt-cancel-btn');
    const confirmBtn = modal.querySelector('#prompt-confirm-btn');

    const submit = async () => {
        const value = input.value.trim();
        if (!allowEmpty && !value) {
            emit('toast:show', 'Please enter a value', 'error');
            input.focus();
            return;
        }
        if (!onConfirm) {
            modal.remove();
            return;
        }
        try {
            await onConfirm(value);
            modal.remove();
        } catch (err) {
            emit('toast:show', err.message || String(err), 'error');
        }
    };

    cancelBtn.addEventListener('click', () => {
        modal.remove();
        if (onCancel) onCancel();
    });
    confirmBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submit();
        }
    });

    // Focus and pre-select the current value so typing replaces it
    setTimeout(() => {
        input.focus();
        input.select();
    }, 60);

    return modal;
}

// Promise-based alternatives for code that needs the actual answer. Escape and
// overlay dismissal settle with the same safe defaults as Cancel.
export function confirmAsync(message = '') {
    return new Promise(resolve => {
        let answer = false;
        const modal = createConfirmModal({
            title: 'Confirm',
            body: `<p>${escapeHtml(message)}</p>`,
            onConfirm: () => { answer = true; }
        });
        const remove = modal.remove.bind(modal);
        modal.remove = () => { remove(); resolve(answer); };
    });
}

export function promptAsync(message = '', defaultValue = '') {
    return new Promise(resolve => {
        let answer = null;
        const modal = createPromptModal({
            title: 'Input',
            message: escapeHtml(message),
            label: 'Value',
            defaultValue: String(defaultValue ?? ''),
            allowEmpty: true,
            onConfirm: value => { answer = value; }
        });
        const remove = modal.remove.bind(modal);
        modal.remove = () => { remove(); resolve(answer); };
    });
}

export function installDialogGuard() {
    const development = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const warn = name => {
        if (development) console.warn(`[dialog-guard] window.${name} is synchronous; use ${name}Async() instead.`);
    };
    window.confirm = message => {
        warn('confirm');
        void confirmAsync(message);
        return false;
    };
    window.prompt = (message, defaultValue) => {
        warn('prompt');
        void promptAsync(message, defaultValue);
        return null;
    };
}

/**
 * Download a JSON string as a file in the browser.
 * @param {string} dataStr - The file contents.
 * @param {string} filename - The download filename.
 */
export function downloadJsonFile(dataStr, filename) {
    const blob = new Blob([dataStr], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    // Revoke after the download has had a chance to start
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}
