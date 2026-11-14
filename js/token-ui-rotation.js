// Token UI - Rotation & Initialization
import { tokenManager } from './token-manager.js';
import { els } from './state.js';
import { setState } from './store.js';
import { renderTokenList, addToken } from './token-ui-list.js';
import { showToast } from './ui.js';

export async function toggleTokenRotation() {
    const enabled = els.tokenRotation?.checked;
    await tokenManager.setRotationEnabled(enabled);
    setState((state) => ({
        config: { ...state.config, tokenRotation: enabled }
    }));
    await renderTokenList();
    showToast(`Token rotation ${enabled ? 'enabled' : 'disabled'}`, 'success');
}

export async function initializeTokenManagement() {
    // Load rotation setting from tokenManager which already initialized from DB
    await tokenManager.initialized;
    const rotationEnabled = tokenManager.rotationEnabled;

    if (els.tokenRotation) {
        els.tokenRotation.checked = rotationEnabled;
    }
    setState((state) => ({
        config: { ...state.config, tokenRotation: rotationEnabled }
    }));
    
    // Render initial token list
    await renderTokenList();
    
    // Add event listeners

    // Add enter key support for token inputs
    if (els.tokenName) {
        els.tokenName.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                els.tokenValue?.focus();
            }
        });
    }
    
    if (els.tokenValue) {
        els.tokenValue.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                addToken();
            }
        });
    }
}