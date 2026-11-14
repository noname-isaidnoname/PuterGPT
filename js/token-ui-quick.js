// Token UI - Quick Register
import { tokenManager } from './token-manager.js';
import { renderTokenList, flashNewToken } from './token-ui-list.js';
import { showToast } from './ui.js';

export async function quickRegisterToken() {
    const btn = document.getElementById('quick-register-btn');
    try {
        if (btn) {
            var originalContent = btn.innerHTML;
            btn.innerHTML = '<span class="material-icons-outlined" style="font-size:14px">hourglass_empty</span> Registering...';
            btn.disabled = true;
        }

        const newToken = await tokenManager.quickRegisterToken();
        renderTokenList();
        showToast(`Token "${newToken.name}" added successfully!`, 'success');
        flashNewToken(newToken.id);

        if (btn) {
            btn.innerHTML = originalContent;
            btn.disabled = false;
        }
    } catch (error) {
        showToast(error.message, 'error');
        if (btn) {
            btn.innerHTML = originalContent || btn.innerHTML;
            btn.disabled = false;
        }
    }
}