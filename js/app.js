import { state, els } from './state.js';
import { resizeInput, handleInputKey, sendMessage } from './chat.js';
import { loadModels, filterModels, updateCostDisplay } from './models.js';
import { loadSavedChats } from './storage.js';
import { initializeTokenManagement } from './token-ui.js';
import { migrateFromLocalStorage, db } from './indexeddb-storage.js';
import { setState, subscribe, themeDefinitions } from './store.js';
import { deepDiff } from './utils.js';
import { renderThemeCards, syncThemeCards } from './theme-ui.js';
import './search-ui.js'; // Initializes search UI globally
import './theme-generator.js'; // Initialize theme generator
import './code-runner.js'; // Initializes code runner modal (HTML/JS preview) globally
import './backup.js';
import { initializeGenerationParams } from './generation-params.js';
import { initializeVoiceInput } from './voice-input.js';
import './variants.js';
import './compare.js';
import { registerPWA } from './pwa.js';
import { initializeShortcuts } from './shortcuts.js';
import { installDialogGuard } from './modal-helper.js';
import { loadCustomThemes } from './theme-generator.js';
import { emit } from './event-bus.js';

// Main Application Initialization
installDialogGuard();
window.addEventListener('load', async () => {
    await bootstrap();
});

async function bootstrap() {
    initializeGenerationParams();
    initializeVoiceInput();
    initializeShortcuts();
    // Perform migration if needed
    await migrateFromLocalStorage();
    await bootstrapThemes();
    await import('./state.js').then(m => m.loadSettingsFromDB());
    const variantToggle = document.getElementById('enable-variants');
    variantToggle.checked = (await db.settings.get('enable_variants'))?.value === true;
    setState({ variantsEnabled: variantToggle.checked });
    variantToggle.addEventListener('change', async () => {
        try {
            await db.settings.put({ key: 'enable_variants', value: variantToggle.checked });
            setState({ variantsEnabled: variantToggle.checked });
            emit('messages:rerender');
        } catch (error) {
            variantToggle.checked = !variantToggle.checked;
            emit('toast:show', 'Could not save response variants setting', 'error');
        }
    });
    subscribe((next, previous) => {
        if (next.isGenerating !== previous.isGenerating) variantToggle.disabled = next.isGenerating;
    });
    const autoName = document.getElementById('auto-name-chats');
    autoName.checked = (await db.settings.get('auto_name_chats'))?.value !== false;
    autoName.addEventListener('change', async () => {
        try {
            await db.settings.put({ key: 'auto_name_chats', value: autoName.checked });
        } catch (error) {
            autoName.checked = !autoName.checked;
            emit('toast:show', 'Could not save auto-name setting', 'error');
        }
    });
    await initializeTokenManagement();
    renderThemeCards();

    wireReactiveSubscriptions();
    restoreConfigUI();

    // Load Chats and Models
    await loadSavedChats();
    await loadModels();

    initializeImageHandling();
    initializeImportHandling();
    initializeEventListeners();
    initializeWelcomeMode();
    registerPWA();

    // Check for shared chat URL
    import('./export.js').then(m => m.loadSharedChat());
}

async function bootstrapThemes() {
    // Custom themes must load BEFORE settings are applied, so the theme picker
    // and theme CSS variables are correct on first paint.
    console.log('Loading custom themes...');
    await loadCustomThemes();
    console.log('Custom themes loaded, themeDefinitions now:', Object.keys(themeDefinitions));
}

function wireReactiveSubscriptions() {
    subscribe(syncConfigToUI);
}

function syncConfigToUI(newState, prevState) {
    if (newState.messages !== prevState.messages && newState.config.autoScroll) {
        setTimeout(() => {
            els.chatContainer.scrollTop = els.chatContainer.scrollHeight;
        }, 100);
    }

    syncField(newState, prevState, 'modelId',       v => els.modelSelect.value = v);
    syncField(newState, prevState, 'systemPrompt',  v => els.systemPrompt.value = v);
    syncField(newState, prevState, 'autoScroll',    v => { els.autoScroll.checked = v; });

    if (newState.config?.enableWebSearch !== prevState.config?.enableWebSearch) {
        if (els.enableWebSearch) els.enableWebSearch.checked = newState.config.enableWebSearch;
    }

    if (newState.config?.theme !== prevState.config?.theme) {
        syncThemeCards();
        import('./state.js').then(m => m.applyTheme(newState.config.theme));
    }

    updateSendButtonIcon(newState);

    const changes = deepDiff(newState, prevState);
    if (Object.keys(changes).length > 0) {
        console.log('State changes:', changes);
    }
}

function syncField(newState, prevState, key, apply) {
    if (newState.config?.[key] !== prevState.config?.[key]) {
        apply(newState.config[key]);
    }
}

function updateSendButtonIcon(currentState) {
    const sendBtnIcon = els.sendBtn.querySelector('.material-icons-outlined');
    if (sendBtnIcon) {
        sendBtnIcon.textContent = currentState.isGenerating ? 'stop' : 'arrow_upward';
    }
    els.sendBtn.title = currentState.isGenerating ? 'Stop generating' : 'Send message';
}

function restoreConfigUI() {
    els.systemPrompt.value = state.config.systemPrompt;
    els.autoScroll.checked = state.config.autoScroll;
    if (els.enableWebSearch) els.enableWebSearch.checked = state.config.enableWebSearch;
    syncThemeCards();
}

function initializeEventListeners() {
    els.input.addEventListener('keydown', handleInputKey);
    els.input.addEventListener('input', resizeInput);
    els.modelSearch.addEventListener('input', filterModels);
    els.freeOnlyFilter.addEventListener('change', filterModels);

    els.modelSelect.addEventListener('change', async (e) => {
        setState((state) => ({
            config: { ...state.config, modelId: e.target.value }
        }));
        await db.settings.put({ key: 'model', value: e.target.value });
        updateCostDisplay();
    });

    els.systemPrompt.addEventListener('change', async (e) => {
        setState((state) => ({
            config: { ...state.config, systemPrompt: e.target.value }
        }));
        await db.settings.put({ key: 'system_prompt', value: e.target.value });
    });

    if (els.enableWebSearch) {
        els.enableWebSearch.addEventListener('change', persistEnableWebSearch);
    }

    if (els.themeModelSearch) {
        els.themeModelSearch.addEventListener('input', callFilterThemeModels);
    }
    if (els.themeFreeOnly) {
        els.themeFreeOnly.addEventListener('change', callFilterThemeModels);
    }
}

async function persistEnableWebSearch(e) {
    setState((state) => ({
        config: { ...state.config, enableWebSearch: e.target.checked }
    }));
    await db.settings.put({ key: 'enable_web_search', value: e.target.checked });
}

function callFilterThemeModels() {
    if (typeof filterThemeModels === 'function') {
        filterThemeModels();
    }
}

// Make sendMessage available globally for the HTML onclick
window.sendMessage = sendMessage;

// Handle send button click - determines whether to send message or abort generation
window.handleSendButtonClick = () => {
    if (state.isGenerating) {
        abortAssistantResponse();
    } else {
        sendMessage();
    }
};

// Toggles the centered welcome view while the conversation is empty
function initializeWelcomeMode() {
    const main = document.getElementById('main');
    const sync = () => {
        main.classList.toggle('welcome-mode', els.chatContainer.children.length === 0);
    };
    new MutationObserver(sync).observe(els.chatContainer, { childList: true });
    sync();
}

// Import and make abortAssistantResponse available globally
import('./chat-api.js').then(m => {
    window.abortAssistantResponse = m.abortAssistantResponse;
});

// Image Handling Initialization
async function initializeImageHandling() {
    const { imageUtils } = await import('./image-utils.js');
    
    // File input change handler
    const imageInput = document.getElementById('image-input');
    imageInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        await imageUtils.handleFileInput(files);
        // Reset input so same file can be selected again
        e.target.value = '';
    });
    
    // Paste handler for textarea
    els.input.addEventListener('paste', imageUtils.handlePaste.bind(imageUtils));
    
    // Drag and drop handlers for the main chat area
    const mainArea = document.getElementById('main');
    mainArea.addEventListener('dragover', imageUtils.handleDragOver);
    mainArea.addEventListener('dragleave', imageUtils.handleDragLeave);
    mainArea.addEventListener('drop', imageUtils.handleDrop.bind(imageUtils));
}

// Import Handling Initialization
function initializeImportHandling() {
    const importInput = document.getElementById('import-input');
    importInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const jsonData = JSON.parse(text);
            import('./export.js').then(m => m.importChatFromJson(jsonData));
        } catch (error) {
            console.error('Failed to read import file:', error);
            emit('toast:show', 'Failed to import chat: Invalid JSON file', 'error');
        } finally {
            // Reset input so same file can be selected again
            e.target.value = '';
        }
    });
}
