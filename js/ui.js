import { els, state, hasSettingsChanged, resetSettingsToOriginal } from './state.js';
import { db } from './indexeddb-storage.js';
import { setState, getState, subscribe, themeDefinitions } from './store.js';
import { emit, on } from './event-bus.js';

// Set up reactive subscription to update image preview when attached images change
subscribe((newState, prevState) => {
    if (newState.attachedImages !== prevState.attachedImages) {
        updateImagePreview();
    }
});

// Wire up toast listener
on('toast:show', (msg, type) => showToast(msg, type));

// Wire up scroll-to-bottom listener
on('ui:scroll-bottom', () => scrollToBottom());

// Toast Pool - manages up to 3 concurrent toasts
const MAX_TOASTS = 3;
const TOAST_VISIBLE_DURATION = 2500;
const TOAST_GAP = 8;
const TOAST_HIDDEN_BOTTOM = -100;
const toastPool = [];

function updateToastPositions() {
    let currentBottom = 0;
    for (let i = 0; i < toastPool.length; i++) {
        const toastObj = toastPool[i];
        toastObj.element.style.bottom = `${currentBottom}px`;
        currentBottom += toastObj.element.offsetHeight + TOAST_GAP;
    }
}

function removeToast(toastObj) {
    clearTimeout(toastObj.fadeOutTimer);
    clearTimeout(toastObj.hideTimer);
    // Slide out downward and fade
    toastObj.element.style.bottom = `${TOAST_HIDDEN_BOTTOM}px`;
    toastObj.element.classList.remove('show');
    toastObj.element.classList.add('hiding');
    toastObj.hideTimer = setTimeout(() => {
        toastObj.element.remove();
        const idx = toastPool.indexOf(toastObj);
        if (idx !== -1) toastPool.splice(idx, 1);
        updateToastPositions();
    }, 300);
}

function removeToastImmediate(toastObj) {
    clearTimeout(toastObj.fadeOutTimer);
    clearTimeout(toastObj.hideTimer);
    toastObj.element.remove();
    const idx = toastPool.indexOf(toastObj);
    if (idx !== -1) toastPool.splice(idx, 1);
}

export function showToast(msg, type = 'info') {
    // Normalize type: 'warn' -> 'warning'
    const normalizedType = type === 'warn' ? 'warning' : type;
    
    // If pool is full, remove the oldest toast immediately
    if (toastPool.length >= MAX_TOASTS) {
        const oldest = toastPool.shift();
        removeToastImmediate(oldest);
    }
    
    // Create a new toast element
    const toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.classList.add(normalizedType);
    toastEl.textContent = msg;
    // Start off-screen below
    toastEl.style.bottom = `${TOAST_HIDDEN_BOTTOM}px`;
    els.toastContainer.appendChild(toastEl);
    
    const toastObj = { element: toastEl, fadeOutTimer: null, hideTimer: null };
    toastPool.push(toastObj);
    
    // Double rAF: first frame commits the initial bottom:-100px state,
    // second frame updates positions and adds .show to trigger both transitions
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            updateToastPositions();
            toastEl.classList.add('show');
        });
    });
    
    // Schedule fade-out
    toastObj.fadeOutTimer = setTimeout(() => {
        removeToast(toastObj);
    }, TOAST_VISIBLE_DURATION);
}

export function scrollToBottom() {
    const shouldScroll = els.autoScroll ? els.autoScroll.checked : true;
    if(shouldScroll) els.chatContainer.scrollTop = els.chatContainer.scrollHeight;
}

// Global Actions
window.toggleSidebar = () => els.sideBar.classList.toggle('open');

// Image Preview Management
async function updateImagePreview() {
    const { state, els } = await import('./state.js');
    const imagePreview = document.getElementById('image-preview');

    if (state.attachedImages.length === 0) {
        imagePreview.style.display = 'none';
        imagePreview.innerHTML = '';
        return;
    }

    imagePreview.style.display = 'flex';
    imagePreview.innerHTML = '';

    state.attachedImages.forEach((imageData, index) => {
        const imageItem = document.createElement('div');
        imageItem.className = 'image-item';

        const img = document.createElement('img');
        img.src = imageData.dataUrl;
        img.alt = imageData.name;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-image';
        removeBtn.innerHTML = '×';
        removeBtn.onclick = async () => {
            const { imageUtils } = await import('./image-utils.js');
            await imageUtils.removeImage(index);
        };

        imageItem.appendChild(img);
        imageItem.appendChild(removeBtn);
        imagePreview.appendChild(imageItem);
    });
}
let activeContextChatId = null;
const contextMenu = document.getElementById('chat-context-menu');

export function showChatContextMenu(e, chatId) {
    activeContextChatId = chatId;
    contextMenu.classList.add('active');
    
    // Position menu
    const rect = e.currentTarget.getBoundingClientRect();
    contextMenu.style.top = `${rect.bottom + 5}px`;
    contextMenu.style.left = `${rect.right - contextMenu.offsetWidth}px`;
    
    // Close on click outside
    const closeMenu = (event) => {
        if (!contextMenu.contains(event.target)) {
            contextMenu.classList.remove('active');
            document.removeEventListener('click', closeMenu);
        }
    };
    
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}
window.showChatContextMenu = showChatContextMenu;

window.handleRenameChat = async () => {
    const chat = await db.chats.get(activeContextChatId);
    const newTitle = prompt("Rename chat:", chat ? chat.title : "");
    if (newTitle !== null) {
        emit('chat:rename', activeContextChatId, newTitle);
    }
    contextMenu.classList.remove('active');
};

window.handleDeleteChat = () => {
    if (confirm("Delete this chat?")) {
        window.deleteChat(activeContextChatId);
    }
    contextMenu.classList.remove('active');
};

window.handleExportChat = () => {
    emit('chat:export-json', activeContextChatId);
    contextMenu.classList.remove('active');
};

window.handleShareChat = () => {
    emit('chat:share', activeContextChatId);
    contextMenu.classList.remove('active');
};

window.importChat = () => {
    const importInput = document.getElementById('import-input');
    importInput.click();
};

window.newChat = () => {
    setState({
        messages: [],
        currentChatId: null,
        lastOperationId: Date.now()
    });
    els.chatContainer.innerHTML = '';
    emit('chats:refresh-needed');
    if (window.innerWidth <= 768) els.sideBar.classList.remove('open');
};

window.openSettings = () => {
    els.settingsModal.classList.add('active');
    // Store current values as original when opening settings
    const currentSettings = {
        systemPrompt: els.systemPrompt.value,
        modelId: els.modelSelect.value,
        autoScroll: els.autoScroll.checked,
        tokenRotation: els.tokenRotation.checked,
        enableWebSearch: els.enableWebSearch ? els.enableWebSearch.checked : false,
        theme: els.themeSelect ? els.themeSelect.value : 'dark'
    };
    setState({ originalSettings: currentSettings });
};

window.closeSettings = () => {
    // Check if settings have been changed
    if (hasSettingsChanged()) {
        // Show confirmation dialog
        els.settingsConfirmModal.classList.add('active');
    } else {
        // No changes, just close
        els.settingsModal.classList.remove('active');
    }
};

window.cancelCloseSettings = () => {
    // User wants to keep editing, just close the confirmation dialog
    els.settingsConfirmModal.classList.remove('active');
};

window.discardChangesAndClose = async () => {
    // User wants to discard changes, reset to original values and close both modals
    resetSettingsToOriginal();
    // Also clear IndexedDB settings to ensure changes are not persisted
    const currentState = getState();
    await db.settings.put({ key: 'system_prompt', value: currentState.originalSettings.systemPrompt });
    await db.settings.put({ key: 'model', value: currentState.originalSettings.modelId });
    await db.settings.put({ key: 'auto_scroll', value: currentState.originalSettings.autoScroll });
    await db.settings.put({ key: 'token_rotation', value: currentState.originalSettings.tokenRotation });
    await db.settings.put({ key: 'enable_web_search', value: currentState.originalSettings.enableWebSearch });
    await db.settings.put({ key: 'theme', value: currentState.originalSettings.theme });
    
    // Apply the original theme
    const { applyTheme } = await import('./state.js');
    applyTheme(currentState.originalSettings.theme);
    
    els.settingsModal.classList.remove('active');
    els.settingsConfirmModal.classList.remove('active');
    showToast("Changes discarded");
};

window.saveSettings = async () => {
    // Token management is now handled by tokenManager, no single token to save
    const configUpdates = {
        autoScroll: els.autoScroll.checked,
        systemPrompt: els.systemPrompt.value,
        modelId: els.modelSelect.value,
        enableWebSearch: els.enableWebSearch ? els.enableWebSearch.checked : false
    };
    
    setState((state) => ({
        config: { ...state.config, ...configUpdates }
    }));
    
    await db.settings.put({ key: 'system_prompt', value: configUpdates.systemPrompt });
    await db.settings.put({ key: 'model', value: configUpdates.modelId });
    await db.settings.put({ key: 'auto_scroll', value: configUpdates.autoScroll });
    await db.settings.put({ key: 'enable_web_search', value: configUpdates.enableWebSearch });
  
    // Close both modals if confirmation is open
    els.settingsModal.classList.remove('active');
    els.settingsConfirmModal.classList.remove('active');
    showToast("Settings saved");
};

// Delete theme modal functions
window.openDeleteThemeModal = () => {
    els.deleteThemeModal.classList.add('active');
};

window.closeDeleteThemeModal = () => {
    els.deleteThemeModal.classList.remove('active');
};

function canDeleteCurrentTheme() {
    const currentTheme = state.config.theme;
    if (currentTheme === 'dark' || currentTheme === 'light') {
        showToast('Cannot delete built-in themes', 'error');
        return null;
    }
    if (!currentTheme || !currentTheme.startsWith('custom-')) {
        showToast('No custom theme selected', 'error');
        return null;
    }
    return currentTheme;
}

window.deleteCustomTheme = () => {
    if (!canDeleteCurrentTheme()) return;
    // Open confirmation modal
    openDeleteThemeModal();
};

window.confirmDeleteTheme = async () => {
    const currentTheme = canDeleteCurrentTheme();
    if (!currentTheme) return;
    
    // Execute theme's onRemove JavaScript to clean up effects before deletion
    if (themeDefinitions[currentTheme]?.javascript?.onRemove) {
        try {
            // Import the executeThemeJS function from state.js
            const { executeThemeJS } = await import('./state.js');
            executeThemeJS(
                themeDefinitions[currentTheme].javascript.onRemove,
                currentTheme,
                'onRemove'
            );
        } catch (error) {
            console.error('Failed to execute theme cleanup:', error);
        }
    }
    
    // Delete from theme definitions
    delete themeDefinitions[currentTheme];
    
    // Delete from localStorage
    const customThemes = JSON.parse(localStorage.getItem('customThemes') || '{}');
    delete customThemes[currentTheme];
    localStorage.setItem('customThemes', JSON.stringify(customThemes));
    
    // Delete from IndexedDB
    const { db } = await import('./indexeddb-storage.js');
    const savedThemes = await db.settings.get('customThemes');
    if (savedThemes && savedThemes.value) {
        delete savedThemes.value[currentTheme];
        await db.settings.put({ key: 'customThemes', value: savedThemes.value });
    }
    
    // Reset to dark theme
    const { setState } = await import('./store.js');
    setState((state) => ({
        config: { ...state.config, theme: 'dark' }
    }));
    await db.settings.put({ key: 'theme', value: 'dark' });
    
    // Apply dark theme
    const { applyTheme } = await import('./state.js');
    applyTheme('dark');
    
    // Update dropdown
    const { populateThemeDropdown } = await import('./theme-ui.js');
    populateThemeDropdown();
    
    // Close modal
    closeDeleteThemeModal();
    
    showToast('Custom theme deleted successfully', 'success');
};
