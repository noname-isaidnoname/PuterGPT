// Token UI - Guide & Import/Export Modals
import { tokenManager, TOKEN_GUIDE } from './token-manager.js';
import { renderTokenList } from './token-ui-list.js';
import { showToast } from './ui.js';
import { createModal, createConfirmModal, downloadJsonFile } from './modal-helper.js';

export function showTokenGuide() {
    try {
        const modal = createModal(`
            <div class="modal token-guide-modal">
                <h3>Token Guide</h3>
                <div class="token-guide-content">
                    <pre style="white-space: pre-wrap; font-size:0.9rem; line-height:1.4;">${TOKEN_GUIDE}</pre>
                </div>
                <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px;">
                    <button class="btn" id="guide-close-btn">Close</button>
                </div>
            </div>
        `);
        modal.querySelector('#guide-close-btn').addEventListener('click', () => modal.remove());
    } catch (error) {
        console.error('Error in showTokenGuide:', error);
        alert('Error showing token guide: ' + error.message);
    }
}

export function importTokens() {
    const modal = createModal(`
        <div class="modal">
            <h3>Import Tokens</h3>
            <p style="margin-bottom: 15px;">Paste exported token JSON you copied previously into the box below. This will add them to your current list.</p>
            <textarea id="import-token-json" placeholder='[{"tokenName": "...", "value": "...", "disabled": false}, ...]' style="height: 150px; font-family: monospace; font-size: 12px; margin-bottom: 15px; width: 100%; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-secondary); color: var(--text-primary); padding: 8px; resize: vertical;"></textarea>
            <div style="display:flex; gap:10px; justify-content:center;">
                <button class="btn" id="cancel-import-btn" style="background-color: var(--danger);">Cancel</button>
                <button class="btn primary" id="confirm-import-btn" style="background-color: var(--accent);">Import Tokens</button>
            </div>
        </div>
    `);

    const cancelBtn = modal.querySelector('#cancel-import-btn');
    const confirmBtn = modal.querySelector('#confirm-import-btn');
    const textArea = modal.querySelector('#import-token-json');

    cancelBtn.addEventListener('click', () => modal.remove());

    confirmBtn.addEventListener('click', async () => {
        const jsonText = textArea.value.trim();
        if (!jsonText) {
            showToast('Please enter token JSON data', 'error');
            return;
        }
        try {
            const importedCount = await tokenManager.importTokens(jsonText);
            await renderTokenList();
            showToast(`Successfully imported ${importedCount} tokens`, 'success');
            modal.remove();
        } catch (error) {
            showToast(`Import failed: ${error.message}`, 'error');
        }
    });

    setTimeout(() => textArea.focus(), 100);
}

export async function exportTokens() {
    try {
        const tokens = await tokenManager.exportTokens();
        const dataStr = JSON.stringify(tokens, null, 2);

        createConfirmModal({
            title: 'Security Warning',
            body: `
                <p style="margin-bottom: 15px;">You are about to copy your API tokens to your clipboard. Tokens grant access to your AI models and credits.</p>
                <p style="margin-bottom: 20px;"><strong>Never share these tokens</strong> with anyone you don't trust. Ensure you are in a private environment before proceeding.</p>
            `,
            confirmLabel: 'I Understand, Copy Now',
            cancelLabel: 'Cancel',
            onConfirm: async () => {
                try {
                    await navigator.clipboard.writeText(dataStr);
                    showToast(`Copied ${tokens.length} tokens to clipboard`, 'success');
                } catch (error) {
                    downloadJsonFile(dataStr, `puter-tokens-${new Date().toISOString().split('T')[0]}.json`);
                    showToast(`Downloaded ${tokens.length} tokens`, 'success');
                }
                // Close the modal (last created)
                document.querySelectorAll('.modal-overlay.active').forEach(m => m.remove());
            }
        });
    } catch (error) {
        showToast(`Export failed: ${error.message}`, 'error');
    }
}
