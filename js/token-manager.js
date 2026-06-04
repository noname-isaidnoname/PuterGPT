import { db } from './indexeddb-storage.js';
import { generateUniqueId } from './utils.js';

// Token Management System with Rotation
class TokenManager {
    // Find a token by its value, accepting both 'value' and 'token' field names
    // (different versions of the schema used different keys).
    async _findTokenByValue(tokenValue) {
        return (
            (await db.tokens.where('value').equals(tokenValue).first()) ||
            (await db.tokens.where('token').equals(tokenValue).first()) ||
            null
        );
    }
    constructor() {
        this.tokens = [];
        this.currentIndex = 0;
        this.rotationEnabled = false;
        this.failedTokens = new Set();
        this.initialized = this.init();
    }

    async init() {
        try {
            await this.loadTokens();
            const rotationSetting = await db.settings.get('token_rotation');
            this.rotationEnabled = rotationSetting ? rotationSetting.value : false;
        } catch (error) {
            console.error('Failed to initialize token manager:', error);
            showToast('Failed to initialize token management. Some features may not work.', 'error');
            // Ensure we have a working state even if initialization fails
            this.tokens = [];
            this.rotationEnabled = false;
        }
    }

    // Load tokens from IndexedDB
    async loadTokens() {
        try {
            this.tokens = await db.tokens.toArray();
            return this.tokens;
        } catch (error) {
            console.error('Failed to load tokens:', error);
            
            // Show user feedback for critical errors
            if (error.name === 'QuotaExceededError') {
                showToast('Storage quota exceeded. Unable to load tokens.', 'error');
            } else if (error.name === 'InvalidStateError') {
                showToast('Database error. Please refresh the page.', 'error');
            }
            
            return [];
        }
    }

    // Save tokens is now implicit via db.tokens.put/add in other methods
    // but we keep this for compatibility if needed, although it's better to update DB directly
    async saveTokens() {
        // In IndexedDB, we don't usually "save all" like in LocalStorage
        // This is kept for internal state sync if needed
        try {
            this.tokens = await db.tokens.toArray();
        } catch (error) {
            console.error('Failed to save tokens:', error);
            showToast('Failed to save token data.', 'error');
        }
    }

    // Add a new token with name
    async addToken(name, token, disabled = false) {
        if (!name || !token) {
            throw new Error('Name and token are required');
        }

        // Check for duplicates
        const existing = await db.tokens.where('value').equals(token.trim()).first();
        if (existing) {
            throw new Error('Token already exists');
        }

        const newToken = {
            id: generateUniqueId(),
            name: name.trim(),
            value: token.trim(), // Renamed 'token' to 'value' to match schema if needed, or keep 'token'
            disabled,
            createdAt: new Date().toISOString(),
            isHealthy: true,
            lastUsed: null,
            usageCount: 0
        };

        // Ensure we match schema 'value' from indexeddb-storage.js
        // Wait, I used 'value' in schema for settings, but for tokens I didn't specify fields in stores()
        // db.version(1).stores({ tokens: 'id, name, value, status' });
        
        await db.tokens.add(newToken);
        await this.loadTokens();
        return newToken;
    }

    // Remove a token
    async removeToken(tokenId) {
        const token = await db.tokens.get(tokenId);
        if (token) {
            await db.tokens.delete(tokenId);
            this.failedTokens.delete(token.value || token.token);
            await this.loadTokens();
            
            // Adjust current index if needed
            if (this.currentIndex >= this.tokens.length) {
                this.currentIndex = 0;
            }
            return true;
        }
        return false;
    }

    // Update token name
    async updateTokenName(tokenId, newName) {
        const token = await db.tokens.get(tokenId);
        if (token) {
            token.name = newName.trim();
            await db.tokens.put(token);
            await this.loadTokens();
            return true;
        }
        return false;
    }

    // Toggle token disabled status
    async toggleTokenDisabled(tokenId) {
        const token = await db.tokens.get(tokenId);
        if (token) {
            token.disabled = !token.disabled;
            await db.tokens.put(token);
            await this.loadTokens();
            
            // If we disabled the current token and rotation is enabled, find next available
            if (token.disabled && this.rotationEnabled && this.tokens[this.currentIndex]?.id === tokenId) {
                // Find next available non-disabled token
                const availableTokens = this.tokens.filter(t => !t.disabled);
                if (availableTokens.length > 0) {
                    const nextToken = availableTokens[0];
                    this.currentIndex = this.tokens.indexOf(nextToken);
                }
            }
            
            return token.disabled;
        }
        return false;
    }

    // Get current active token
    async getCurrentToken() {
        await this.initialized;
        if (this.tokens.length === 0) return null;
        
        if (this.rotationEnabled) {
            return this.rotateToken();
        }
        
        return this.tokens[this.currentIndex] || null;
    }

    // Get token by ID
    async getTokenById(tokenId) {
        return await db.tokens.get(tokenId);
    }

    // Set active token by ID
    async setActiveToken(tokenId) {
        const index = this.tokens.findIndex(t => t.id === tokenId);
        if (index !== -1) {
            this.currentIndex = index;
            return true;
        }
        return false;
    }

    // Token rotation logic
    rotateToken() {
        if (this.tokens.length === 0) return null;
        
        // Filter out disabled tokens
        const activeTokens = this.tokens.filter(t => !t.disabled);
        if (activeTokens.length === 0) return null;
        
        let attempts = 0;
        const maxAttempts = this.tokens.length;
        
        while (attempts < maxAttempts) {
            const token = this.tokens[this.currentIndex];
            
            // Skip disabled, failed, or unhealthy tokens
            if (token && !token.disabled && !this.failedTokens.has(token.value || token.token) && token.isHealthy) {
                return token;
            }
            
            // Move to next token
            this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
            attempts++;
        }
        
        // All tokens failed, reset and try again (but still skip disabled ones)
        this.failedTokens.clear();
        // Reset health in DB
        this.tokens.forEach(async t => {
            t.isHealthy = true;
            await db.tokens.put(t);
        });
        
        // Find first available non-disabled token
        const availableToken = this.tokens.find(t => !t.disabled);
        if (availableToken) {
            this.currentIndex = this.tokens.indexOf(availableToken);
            return availableToken;
        }
        
        return null;
    }

    // Mark token as failed
    async markTokenFailed(tokenValue) {
        this.failedTokens.add(tokenValue);
        const tokenObj = await this._findTokenByValue(tokenValue);
        if (tokenObj) {
            tokenObj.isHealthy = false;
            await db.tokens.put(tokenObj);
            await this.loadTokens();
        }

        // If rotation is enabled, move to next token
        if (this.rotationEnabled) {
            this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        }
    }

    // Mark token as successful
    async markTokenSuccess(tokenValue) {
        this.failedTokens.delete(tokenValue);
        const tokenObj = await this._findTokenByValue(tokenValue);
        if (tokenObj) {
            tokenObj.isHealthy = true;
            tokenObj.lastUsed = new Date().toISOString();
            tokenObj.usageCount++;
            await db.tokens.put(tokenObj);
            await this.loadTokens();
        }
    }

    // Enable/disable rotation
    async setRotationEnabled(enabled) {
        this.rotationEnabled = enabled;
        await db.settings.put({ key: 'token_rotation', value: enabled });
        if (enabled) {
            this.currentIndex = 0;
        }
    }

    // Get all tokens
    async getAllTokens() {
        return await this.loadTokens();
    }

    // Get token statistics
    async getTokenStats() {
        const tokens = await this.loadTokens();
        return {
            total: tokens.length,
            healthy: tokens.filter(t => t.isHealthy).length,
            failed: this.failedTokens.size,
            rotationEnabled: this.rotationEnabled
        };
    }

    // Import tokens from JSON
    async importTokens(tokenData) {
        try {
            const imported = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;
            
            if (!Array.isArray(imported)) {
                throw new Error('Invalid format: expected array');
            }

            let importedCount = 0;
            for (const item of imported) {
                const name = item.name || item.tokenName;
                const tokenValue = item.token || item.value || item.tokenValue;
                const disabled = item.disabled || false;
                
                if (name && tokenValue) {
                    try {
                        await this.addToken(name, tokenValue, disabled);
                        importedCount++;
                    } catch (error) {
                        console.warn('Failed to import token:', error.message);
                    }
                }
            }
            
            return importedCount;
        } catch (error) {
            throw new Error(`Import failed: ${error.message}`);
        }
    }

    // Export tokens to JSON
    async exportTokens() {
        const tokens = await this.loadTokens();
        return tokens.map(({ id, name, value, token, createdAt, lastUsed, usageCount, disabled }) => ({
            id,
            name,
            token: value || token,
            createdAt,
            lastUsed,
            usageCount,
            disabled
        }));
    }

    // Clear all tokens
    async clearAllTokens() {
        await db.tokens.clear();
        this.tokens = [];
        this.failedTokens.clear();
        this.currentIndex = 0;
    }

    // Get token for API usage
    async getApiToken() {
        const currentToken = await this.getCurrentToken();
        return currentToken ? (currentToken.value || currentToken.token) : null;
    }

    // Quick register via Puter.com authentication
    async quickRegisterToken() {
        try {
            // Load Puter library dynamically
            const puter = await this.loadPuterLibrary();
            
            // Trigger Puter sign in popup
            const response = await puter.auth.signIn();
            
            if (response && response.token) {
                const token = response.token;
                const username = response.username || 'Puter User';
                
                const newToken = await this.addToken(username, token);
                await this.saveTokens();
                
                return newToken;
            } else {
                throw new Error('No token received from Puter authentication');
            }
        } catch (error) {
            console.error("Puter sign-in failed:", error);
            if (error.error === 'auth_window_closed') {
                throw new Error('Authentication window was closed');
            } else {
                throw new Error(`Authentication failed: ${error.message || 'Unknown error'}`);
            }
        } finally {
            this.unloadPuterLibrary();
        }
    }

    // Helper function to load Puter library
    async loadPuterLibrary() {
        return new Promise((resolve, reject) => {
            // Check if library is already loaded
            if (window.puter) {
                resolve(window.puter);
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://js.puter.com/v2/';
            script.id = 'puter-library';
            script.async = true;

            script.onload = () => {
                if (window.puter) {
                    resolve(window.puter);
                } else {
                    reject(new Error('Puter library loaded but puter object not available'));
                }
            };

            script.onerror = () => {
                reject(new Error('Failed to load Puter library'));
            };

            document.head.appendChild(script);
        });
    }

    // Helper function to unload Puter library
    unloadPuterLibrary() {
        const script = document.getElementById('puter-library');
        if (script) {
            script.remove();
        }
    }
}

// Global instance
export const tokenManager = new TokenManager();

// Token guide/help text from the original project
export const TOKEN_GUIDE = `
How to Create Tokens

Recommended Method (Easiest):
1. Click green "Quick Register (via Puter)" button.
2. A popup will appear—simply sign in or create an account there.
3. The app will automatically add your account to list above.
4. Final Check: Click blue "Test" button next to token to ensure it's working!

Manual Method:
1. Go to Puter Auth Playground: https://docs.puter.com/playground/auth-sign-in/
2. Click Run, then Sign in (create an account; use temp-mail.org for privacy — this also lets you create more disposable emails and tokens if needed).
3. Copy token value from JSON output (exclude quotes).
4. Click "Add Manual Token" above and paste your token into field.
5. Final Check: Click blue "Test" button to verify token is valid and active.

💡 Pro Tips:
- Avoid expensive models (like Claude 3.5) on new accounts to prevent instant rate limits.
- Add multiple tokens for automatic rotation; app handles switching if one is limited!

Known Issues and Fixes:
Issue: When signing up via Puter popup using a temporary email (e.g., from temp-mail.org), signup may sometimes fail with an error saying email appears to be invalid.

Fix: Go back to temporary email provider (e.g., temp-mail.org), click "Delete" or "Reset" button to remove current temporary address — service will immediately generate a new email for you to use. Then retry Puter signup with the newly generated temporary email.
`;
