// Shared modal helper. Reduces duplication across the token UI modals.
import { emit } from './event-bus.js';

/**
 * Create a modal overlay with the given inner HTML, attach it to <body>,
 * make it active, and wire up the close-on-overlay-click / close-on-Escape
 * behaviour. Returns the modal element so callers can attach their own
 * button handlers.
 */
export function createModal(htmlContent) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = htmlContent;
    document.body.appendChild(modal);

    // Animate in
    setTimeout(() => modal.classList.add('active'), 10);

    // Close on overlay click (not on inner content)
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });

    // Close on Escape
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);

    return modal;
}

/**
 * Convenience: create a confirmation modal with Cancel + Confirm buttons.
 * The confirm button is styled as primary/danger via the `confirmStyle` arg.
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
    body,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
    confirmStyle = 'primary'
}) {
    const modal = createModal(`
        <div class="modal">
            <h3>${title}</h3>
            ${body}
            <div style="display:flex; gap:10px; justify-content:center; margin-top:20px;">
                <button class="btn" id="cancel-btn" style="background-color: var(--danger);">${cancelLabel}</button>
                <button class="btn primary" id="confirm-btn" style="background-color: var(--accent);">${confirmLabel}</button>
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
        } catch (err) {
            emit('toast:show', err.message || String(err), 'error');
        }
    });
    return modal;
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
    URL.revokeObjectURL(link.href);
}
