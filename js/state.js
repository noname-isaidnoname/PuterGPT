// State Management Module - Updated to use Zustand-like store
import { db } from './indexeddb-storage.js';
import { getState, setState, themeDefinitions } from './store.js';

// Backward compatibility - export state proxy that mirrors store state
export const state = new Proxy({}, {
  get(target, prop) {
    const currentState = getState();
    if (prop in currentState) {
      return currentState[prop];
    }
    return target[prop];
  },
  set(target, prop, value) {
    setState({ [prop]: value });
    return true;
  },
  has(target, prop) {
    const currentState = getState();
    return prop in currentState || prop in target;
  },
  ownKeys(target) {
    const currentState = getState();
    return [...Object.keys(currentState), ...Object.keys(target)];
  },
  getOwnPropertyDescriptor(target, prop) {
    const currentState = getState();
    if (prop in currentState) {
      return {
        enumerable: true,
        configurable: true,
        value: currentState[prop]
      };
    }
    return Object.getOwnPropertyDescriptor(target, prop);
  }
});

// Enhanced Safe JavaScript execution for themes
export function executeThemeJS(code, themeName, hookName) {
    try {
        // Create a more powerful but safe execution context
        const themeUtils = {
            // Utility functions for theme manipulation
            addClass: (selector, className) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => el.classList.add(className));
            },
            removeClass: (selector, className) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => el.classList.remove(className));
            },
            toggleClass: (selector, className) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => el.classList.toggle(className));
            },
            // Animation utilities
            addAnimation: (selector, animation) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => el.style.animation = animation);
            },
            removeAnimation: (selector) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => el.style.animation = '');
            },
            // Style utilities
            setCSSVar: (varName, value) => {
                document.documentElement.style.setProperty(varName, value);
            },
            getCSSVar: (varName) => {
                return getComputedStyle(document.documentElement).getPropertyValue(varName);
            },
            // Element utilities
            createElement: (tag, attributes, text) => {
                const element = document.createElement(tag);
                if (attributes) {
                    Object.entries(attributes).forEach(([key, value]) => {
                        element.setAttribute(key, value);
                    });
                }
                if (text) element.textContent = text;
                return element;
            },
            appendTo: (selector, element) => {
                const target = document.querySelector(selector);
                if (target) target.appendChild(element);
            },
            removeFrom: (selector) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => el.remove());
            },
            // Event utilities
            addEventListener: (selector, event, handler) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => el.addEventListener(event, handler));
            },
            removeEventListener: (selector, event, handler) => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => el.removeEventListener(event, handler));
            },
            // Storage for theme-specific data
            storage: {
                get: (key) => localStorage.getItem(`theme_${themeName}_${key}`),
                set: (key, value) => localStorage.setItem(`theme_${themeName}_${key}`, value),
                remove: (key) => localStorage.removeItem(`theme_${themeName}_${key}`)
            }
        };
        
        // Create a safe execution context with enhanced capabilities
        const safeFunction = new Function(
            'document', 'window', 'console', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout',
            'themeUtils', 'Math', 'Date', 'JSON', 'localStorage', 'sessionStorage',
            `
            "use strict";
            ${code}
            `
        );
        
        // Execute with enhanced context
        safeFunction(
            document, window, console, setTimeout, setInterval, clearInterval, clearTimeout,
            themeUtils, Math, Date, JSON, localStorage, sessionStorage
        );
        
        console.log(`✅ Theme "${themeName}" ${hookName} executed successfully`);
    } catch (error) {
        console.error(`❌ Theme "${themeName}" ${hookName} failed:`, error);
        // Show user feedback for JavaScript errors
        if (typeof showToast === 'function') {
            showToast(`Theme effect failed: ${error.message}`, 'error');
        }
    }
}

// Apply theme to document
export function applyTheme(theme) {
    const root = document.documentElement;
    
    // Clean up previous theme's JavaScript if it exists
    const previousTheme = window.currentTheme;
    if (previousTheme && themeDefinitions[previousTheme]?.javascript?.onRemove) {
        executeThemeJS(
            themeDefinitions[previousTheme].javascript.onRemove,
            previousTheme,
            'onRemove'
        );
    }
    
    // Remove any existing theme attribute
    root.removeAttribute('data-theme');
    
    // Apply theme CSS variables if theme exists
    if (themeDefinitions[theme]) {
        const themeConfig = themeDefinitions[theme];
        
        // Apply CSS variables
        Object.entries(themeConfig.cssVars).forEach(([property, value]) => {
            root.style.setProperty(property, value);
        });
        
        // Execute theme's onApply JavaScript if it exists
        if (themeConfig.javascript?.onApply) {
            executeThemeJS(
                themeConfig.javascript.onApply,
                theme,
                'onApply'
            );
        }
        
        // Store current theme for cleanup
        window.currentTheme = theme;
    }
}

applyTheme('dark');

// Async function to load settings from IndexedDB
export async function loadSettingsFromDB() {
    try {
        const [savedPrompt, savedScroll, savedModel, savedRotation, savedWebSearch, savedTheme] = await Promise.all([
            db.settings.get('system_prompt'),
            db.settings.get('auto_scroll'),
            db.settings.get('model'),
            db.settings.get('token_rotation'),
            db.settings.get('enable_web_search'),
            db.settings.get('theme')
        ]);

        const configUpdates = {};
        if (savedPrompt) configUpdates.systemPrompt = savedPrompt.value;
        if (savedScroll !== undefined) configUpdates.autoScroll = savedScroll.value;
        if (savedModel) configUpdates.modelId = savedModel.value;
        if (savedRotation !== undefined) configUpdates.tokenRotation = savedRotation.value;
        if (savedWebSearch !== undefined) configUpdates.enableWebSearch = savedWebSearch.value;
        if (savedTheme) configUpdates.theme = savedTheme.value;

        // Update config through store
        if (Object.keys(configUpdates).length > 0) {
            setState((state) => ({
                config: { ...state.config, ...configUpdates }
            }));
        }
        
        // Always apply theme - use saved theme if exists, otherwise default to 'dark'
        const themeToApply = savedTheme ? savedTheme.value : 'dark';
        applyTheme(themeToApply);

        // Set original settings for comparison using the loaded values
        setState({
            originalSettings: {
                systemPrompt: savedPrompt?.value || '',
                modelId: savedModel?.value || '',
                autoScroll: savedScroll?.value !== undefined ? savedScroll.value : false,
                tokenRotation: savedRotation?.value !== undefined ? savedRotation.value : false,
                enableWebSearch: savedWebSearch?.value !== undefined ? savedWebSearch.value : false,
                theme: savedTheme?.value || 'dark'
            }
        });
    } catch (error) {
        console.error('Failed to load settings from DB:', error);
        
        // Apply default theme even when database loading fails
        applyTheme('dark');
        
        // Show user feedback for critical errors
        if (error.name === 'QuotaExceededError') {
            showToast('Storage quota exceeded. Please clear some data and refresh.', 'error');
        } else if (error.name === 'InvalidStateError') {
            showToast('Database error. Please refresh the page.', 'error');
        } else {
            // For other errors, show a subtle warning
            showToast('Using default settings due to loading error.', 'warning');
        }
        
        // Ensure we have default settings as fallback
        const currentState = getState();
        setState({
            originalSettings: { ...currentState.config }
        });
    }
}

export const els = {
    chatContainer: document.getElementById('chat-container'),
    input: document.getElementById('user-input'),
    sendBtn: document.getElementById('send-btn'),
    modelSelect: document.getElementById('model-select'),
    modelSearch: document.getElementById('model-search'),
    freeOnlyFilter: document.getElementById('free-only-filter'),
    modelCostDisplay: document.getElementById('model-cost-display'),
    systemPrompt: document.getElementById('system-prompt'),
    themeSelect: document.getElementById('theme-select'),
    settingsModal: document.getElementById('settings-modal'),
    settingsConfirmModal: document.getElementById('settings-confirm-modal'),
    toastContainer: document.getElementById('toast-container'),
    sideBar: document.getElementById('sidebar'),
    autoScroll: document.getElementById('auto-scroll'),
    enableWebSearch: document.getElementById('enable-web-search'),
    savedChatsContainer: document.getElementById('saved-chats-container'),
    // Token management elements
    tokenList: document.getElementById('token-list'),
    tokenName: document.getElementById('token-name'),
    tokenValue: document.getElementById('token-value'),
    addTokenBtn: document.getElementById('add-token-btn'),
    tokenRotation: document.getElementById('token-rotation'),
    importTokensBtn: document.getElementById('import-tokens-btn'),
    exportTokensBtn: document.getElementById('export-tokens-btn'),
    tokenGuideBtn: document.getElementById('token-guide-btn'),
    // Theme generator elements
    themeGeneratorModal: document.getElementById('theme-generator-modal'),
    themePrompt: document.getElementById('theme-prompt'),
    generateJavaScript: document.getElementById('generate-javascript'),
    themeModelSelect: document.getElementById('theme-model-select'),
    themeModelSearch: document.getElementById('theme-model-search'),
    themeFreeOnly: document.getElementById('theme-free-only'),
    deleteThemeModal: document.getElementById('delete-theme-modal'),
    // Search elements (will be created dynamically)
    searchModal: null,
    searchInput: null,
    searchResults: null
};

// Function to check if settings have been changed
export function hasSettingsChanged() {
    const currentSystemPrompt = els.systemPrompt.value;
    const currentModelId = els.modelSelect.value;
    const currentAutoScroll = els.autoScroll.checked;
    const currentTokenRotation = els.tokenRotation.checked;
    const currentEnableWebSearch = els.enableWebSearch ? els.enableWebSearch.checked : false;
    const currentTheme = els.themeSelect ? els.themeSelect.value : 'dark';
    
    const currentState = getState();
    
    return (
        currentSystemPrompt !== currentState.originalSettings.systemPrompt ||
        currentModelId !== currentState.originalSettings.modelId ||
        currentAutoScroll !== currentState.originalSettings.autoScroll ||
        currentTokenRotation !== currentState.originalSettings.tokenRotation ||
        currentEnableWebSearch !== currentState.originalSettings.enableWebSearch ||
        currentTheme !== currentState.originalSettings.theme
    );
}

// Function to reset settings to original values
export function resetSettingsToOriginal() {
    const currentState = getState();
    els.systemPrompt.value = currentState.originalSettings.systemPrompt;
    els.modelSelect.value = currentState.originalSettings.modelId;
    els.autoScroll.checked = currentState.originalSettings.autoScroll;
    els.tokenRotation.checked = currentState.originalSettings.tokenRotation;
    if (els.enableWebSearch) els.enableWebSearch.checked = currentState.originalSettings.enableWebSearch;
    if (els.themeSelect) els.themeSelect.value = currentState.originalSettings.theme;
}
