import { state, els } from './state.js';
import { getMessageText } from './utils.js';
import { emit, on } from './event-bus.js';
import { db, reportStorageError } from './indexeddb-storage.js';
import { setState, subscribe } from './store.js';
import { abortAssistantResponse } from './chat-api.js';
import { normalizeGenerationParams } from './generation-params.js';

// Set up reactive subscription to update chat list when current chat changes
subscribe((newState, prevState) => {
    if (newState.currentChatId !== prevState.currentChatId) {
        loadSavedChats();
    }
});

// Storage & Sidebar Management

async function saveChatToStorage() {
    const pending = state.pendingChatData?.id === state.currentChatId ? state.pendingChatData : null;
    if (!state.currentChatId || (state.messages.length === 0 && !pending)) return;
    
    let title = "New Chat";
    const firstUserMsg = state.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
        const contentText = getMessageText(firstUserMsg);
        title = contentText.substring(0, 25) + (contentText.length > 25 ? '...' : '');
    }

    // Capture the system prompt at chat start so it can be exported with
    // the conversation. Prefer the first user message's snapshot (the
    // prompt that was actually active for the first AI response) and fall
    // back to the current global setting for legacy chats that don't have
    // per-message snapshots.
    const initialSystemPrompt = (firstUserMsg && firstUserMsg.systemPrompt !== undefined)
        ? firstUserMsg.systemPrompt
        : (pending?.systemPrompt ?? (state.config && typeof state.config.systemPrompt === 'string'
            ? state.config.systemPrompt
            : ''));
    
    const chatData = {
        id: state.currentChatId,
        title,
        messages: structuredClone(state.messages),
        generationParams: normalizeGenerationParams(state.generationParams),
        lastModified: Date.now(),
        systemPrompt: initialSystemPrompt
    };

    await db.transaction('rw', db.chats, async () => {
        const existing = await db.chats.get(chatData.id);
        await db.chats.put({ ...existing, ...pending, ...chatData, title: existing?.title || pending?.title || title });
    });
    if (state.pendingChatData === pending && pending) setState({ pendingChatData: null });
    await loadSavedChats();

    // Rebuild search index when chat is saved
    emit('search:rebuild');
}

export async function getSavedChats() {
    const chats = await db.chats.orderBy('lastModified').reverse().toArray();
    return chats.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
}

export async function loadSavedChats() {
    const chats = await getSavedChats();
    els.savedChatsContainer.innerHTML = '';
    
    const query = document.getElementById('sidebar-filter').value.trim().toLocaleLowerCase();
    const visible = chats.filter(chat => (chat.title || '').toLocaleLowerCase().includes(query));
    if (visible.length === 0) {
        els.savedChatsContainer.textContent = query ? 'No matching chats.' : 'No saved chats yet.';
        return;
    }

    visible.forEach(chat => {
        const div = document.createElement('div');
        div.className = 'chat-item';
        if (chat.id === state.currentChatId) div.classList.add('active');
        div.dataset.id = chat.id;
        
        const titleSpan = document.createElement('span');
        titleSpan.textContent = chat.title || 'Untitled';
        titleSpan.className = 'chat-title';
        titleSpan.style.flex = '1';
        titleSpan.style.overflow = 'hidden';
        titleSpan.style.textOverflow = 'ellipsis';
        titleSpan.style.whiteSpace = 'nowrap';
        
        const moreBtn = document.createElement('span');
        moreBtn.className = 'material-icons-outlined chat-more-btn';
        moreBtn.textContent = 'more_vert';
        moreBtn.onclick = (e) => {
            e.stopPropagation();
            window.showChatContextMenu(e, chat.id);
        };

        if (chat.pinned) {
            const pin = document.createElement('span');
            pin.className = 'material-icons-outlined';
            pin.style.fontSize = '16px';
            pin.textContent = 'push_pin';
            pin.title = 'Pinned';
            div.appendChild(pin);
        }
        div.appendChild(titleSpan);
        div.appendChild(moreBtn);

        div.onclick = () => loadChat(chat.id);
        els.savedChatsContainer.appendChild(div);
    });
}

window.loadChat = async function(id) {
    const chat = await db.chats.get(id);
    if (chat) {
        // Stop any in-flight generation so the old stream can't write its
        // result into the chat being loaded.
        abortAssistantResponse();
        setState({
            currentChatId: chat.id,
            pendingChatData: null,
            generationParams: normalizeGenerationParams(chat.generationParams),
            messages: chat.messages,
            attachedImages: []
        });
        emit('messages:rerender');
        await loadSavedChats();
        if (window.innerWidth <= 768) els.sideBar.classList.remove('open');
        emit('toast:show', "Chat loaded");
    }
};

window.deleteChat = async function(id) {
    await db.chats.delete(id);

    // Rebuild search index when chat is deleted
    emit('search:rebuild');

    if (state.currentChatId === id) {
        emit('chat:new-requested');
    } else {
        await loadSavedChats();
    }
};

async function renameChat(id, newTitle) {
    if (!newTitle.trim()) return;
    const chat = await db.chats.get(id);
    if (chat) {
        await db.chats.update(id, { title: newTitle, manuallyRenamed: true });
        await loadSavedChats();
        emit('toast:show', "Chat renamed");
    }
}

window.toggleChatPin = async id => {
    try {
        await db.transaction('rw', db.chats, async () => {
            const chat = await db.chats.get(id);
            if (chat) await db.chats.update(id, { pinned: !chat.pinned });
        });
        await loadSavedChats();
    } catch (error) {
        if (!reportStorageError(error)) emit('toast:show', 'Failed to update pin', 'error');
    }
};

document.getElementById('sidebar-filter').addEventListener('input', loadSavedChats);

// Wire up listeners
on('chats:refresh-needed', () => {
    loadSavedChats();
});

on('chat:new-requested', () => {
    // Stop any in-flight generation before resetting the conversation.
    abortAssistantResponse();
    // Reset state and refresh list, then close sidebar on mobile.
    setState({
        messages: [],
        currentChatId: null,
        pendingChatData: null,
        generationParams: normalizeGenerationParams(null),
        attachedImages: []
    });
    els.chatContainer.innerHTML = '';
    loadSavedChats();
    if (window.innerWidth <= 768) els.sideBar.classList.remove('open');
});

on('chat:save', async () => {
    try {
        await saveChatToStorage();
    } catch (error) {
        if (!reportStorageError(error)) {
            console.error('Failed to save chat:', error);
            emit('toast:show', 'Failed to save chat', 'error');
        }
    }
});

on('chat:rename', (id, newTitle) => {
    renameChat(id, newTitle).catch(error => {
        if (!reportStorageError(error)) {
            console.error('Failed to rename chat:', error);
            emit('toast:show', 'Failed to rename chat', 'error');
        }
    });
});
