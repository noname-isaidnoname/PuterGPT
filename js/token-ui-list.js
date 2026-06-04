// Token UI - List & CRUD Operations
import { tokenManager } from './token-manager.js';
import { els } from './state.js';
import { showToast } from './ui.js';

/**
 * Briefly highlight a newly-added token in the list.
 * @param {string} id - The token id (data-token-id attribute)
 */
export function flashNewToken(id) {
    setTimeout(() => {
        const el = document.querySelector(`[data-token-id="${id}"]`);
        if (el) {
            el.classList.add('new');
            setTimeout(() => el.classList.remove('new'), 300);
        }
    }, 100);
}

export async function renderTokenList() {
    if (!els.tokenList) return;
    
    const tokens = await tokenManager.getAllTokens();
    const currentToken = await tokenManager.getCurrentToken();
    const stats = await tokenManager.getTokenStats();
    
    if (tokens.length === 0) {
        els.tokenList.innerHTML = '<div style="padding:10px; color:var(--text-secondary); font-size:0.8rem; font-style:italic;">No tokens added yet. Add your first token above!</div>';
        return;
    }
    
    // Show statistics
    const statsHtml = `
        <div class="token-stats">
            <div class="token-stat">
                <span class="token-stat-label">Total:</span>
                <span class="token-stat-value">${stats.total}</span>
            </div>
            <div class="token-stat">
                <span class="token-stat-label">Healthy:</span>
                <span class="token-stat-value">${stats.healthy}</span>
            </div>
            <div class="token-stat">
                <span class="token-stat-label">Failed:</span>
                <span class="token-stat-value">${stats.failed}</span>
            </div>
            <div class="token-stat">
                <span class="token-stat-label">Rotation:</span>
                <span class="token-stat-value">${stats.rotationEnabled ? 'ON' : 'OFF'}</span>
            </div>
        </div>
    `;
    
    const tokensHtml = tokens.map(token => {
        const isActive = currentToken && currentToken.id === token.id;
        const isHealthy = token.isHealthy;
        const isDisabled = token.disabled;
        const lastUsed = token.lastUsed ? new Date(token.lastUsed).toLocaleString() : 'Never';
        const statusClass = isDisabled ? 'disabled' : (isActive ? 'current' : (isHealthy ? 'healthy' : 'failed'));
        const statusText = isDisabled ? 'Disabled' : (isActive ? 'Current' : (isHealthy ? 'Healthy' : 'Failed'));
        
        return `
            <div class="token-item ${isActive ? 'active' : ''} ${!isHealthy ? 'failed' : ''} ${isDisabled ? 'disabled' : ''}" data-token-id="${token.id}">
                <div class="token-info">
                    <div class="token-name">
                        <span>${token.name}</span>
                        <span class="token-status ${statusClass}">${statusText}</span>
                    </div>
                    <div class="token-details">
                        Used ${token.usageCount} times • Last used: ${lastUsed}
                    </div>
                </div>
                <div class="token-actions">
                    <button class="token-action-btn ${isDisabled ? 'enable' : 'disable'}" onclick="toggleTokenDisabled('${token.id}')" title="${isDisabled ? 'Enable token' : 'Disable token'}">
                        <span class="material-icons-outlined" style="font-size:16px">${isDisabled ? 'visibility_off' : 'visibility'}</span>
                    </button>
                    <button class="token-action-btn edit" onclick="editTokenName('${token.id}')" title="Edit name">
                        <span class="material-icons-outlined" style="font-size:16px">edit</span>
                    </button>
                    <button class="token-action-btn" onclick="setActiveToken('${token.id}')" title="Set as active">
                        <span class="material-icons-outlined" style="font-size:16px">check_circle</span>
                    </button>
                    <button class="token-action-btn delete" onclick="deleteToken('${token.id}')" title="Delete token">
                        <span class="material-icons-outlined" style="font-size:16px">delete</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
    
    els.tokenList.innerHTML = statsHtml + tokensHtml;
}

export async function addToken() {
    const name = els.tokenName?.value.trim();
    const token = els.tokenValue?.value.trim();
    
    if (!name || !token) {
        showToast('Please enter both token name and token value', 'error');
        return;
    }
    
    try {
        const newToken = await tokenManager.addToken(name, token);
        await renderTokenList();
        
        // Clear inputs
        if (els.tokenName) els.tokenName.value = '';
        if (els.tokenValue) els.tokenValue.value = '';
        
        showToast(`Token "${name}" added successfully`, 'success');
        flashNewToken(newToken.id);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

export async function deleteToken(tokenId) {
    const token = await tokenManager.getTokenById(tokenId);
    if (!token) return;
    
    if (!confirm(`Delete token "${token.name}"? This action cannot be undone.`)) {
        return;
    }
    
    if (await tokenManager.removeToken(tokenId)) {
        await renderTokenList();
        showToast(`Token "${token.name}" deleted`, 'success');
    } else {
        showToast('Failed to delete token', 'error');
    }
}

export async function setActiveToken(tokenId) {
    if (await tokenManager.setActiveToken(tokenId)) {
        await renderTokenList();
        const token = await tokenManager.getTokenById(tokenId);
        showToast(`Token "${token.name}" set as active`, 'success');
    } else {
        showToast('Failed to set active token', 'error');
    }
}

export async function editTokenName(tokenId) {
    const token = await tokenManager.getTokenById(tokenId);
    if (!token) return;
    
    const newName = prompt('Enter new name for token:', token.name);
    if (newName && newName.trim() !== token.name) {
        if (await tokenManager.updateTokenName(tokenId, newName.trim())) {
            await renderTokenList();
            showToast('Token name updated', 'success');
        } else {
            showToast('Failed to update token name', 'error');
        }
    }
}

export async function toggleTokenDisabled(tokenId) {
    try {
        const isDisabled = await tokenManager.toggleTokenDisabled(tokenId);
        await renderTokenList();
        showToast(`Token ${isDisabled ? 'disabled' : 'enabled'}`, 'success');
    } catch (error) {
        showToast('Failed to toggle token status', 'error');
    }
}