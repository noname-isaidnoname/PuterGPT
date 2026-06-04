// Token UI - Quick Register
import { tokenManager } from './token-manager.js';
import { renderTokenList, flashNewToken } from './token-ui-list.js';
import { showToast } from './ui.js';

export async function quickRegisterToken() {
    try {
        const btn = document.querySelector('[onclick*="quickRegisterToken"]');
        if (btn) {
            const originalText = btn.textContent;
            btn.textContent = 'Registering...';
            btn.disabled = true;
            
            const newToken = await tokenManager.quickRegisterToken();
            renderTokenList();
            showToast(`Token "${newToken.name}" added successfully!`, 'success');
            flashNewToken(newToken.id);

            // Restore button text
            btn.textContent = originalText;
            btn.disabled = false;
        } else {
            // No button found, still perform quick register
            const newToken = await tokenManager.quickRegisterToken();
            renderTokenList();
            showToast(`Token "${newToken.name}" added successfully!`, 'success');
        }
        
    } catch (error) {
        showToast(error.message, 'error');
        
        const btn = document.querySelector('[onclick*="quickRegisterToken"]');
        if (btn) {
            btn.textContent = 'Quick Register (via Puter)';
            btn.disabled = false;
        }
    }
}