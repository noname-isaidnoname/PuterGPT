import { state, els } from './state.js';
import { getMessageText } from './utils.js';
import { emit, on } from './event-bus.js';
import { db } from './indexeddb-storage.js';
import { setState, subscribe } from './store.js';

// Set up reactive subscription to update chat list when current chat changes
subscribe((newState, prevState) => {
    if (newState.currentChatId !== prevState.currentChatId) {
        loadSavedChats();
    }
});

// Storage & Sidebar Management

async function saveChatToStorage() {
    if (!state.currentChatId || state.messages.length === 0) return;
    
    let title = "New Chat";
    const firstUserMsg = state.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
        const contentText = getMessageText(firstUserMsg);
        title = contentText.substring(0, 25) + (contentText.length > 25 ? '...' : '');
    }
    
    const chatData = {
        id: state.currentChatId,
        title: title,
        messages: state.messages,
        lastModified: Date.now()
    };

    await db.chats.put(chatData);
    await loadSavedChats();

    // Rebuild search index when chat is saved
    emit('search:rebuild');
}

export async function getSavedChats() {
    return await db.chats.orderBy('lastModified').reverse().toArray();
}

export async function loadSavedChats() {
    const chats = await getSavedChats();
    els.savedChatsContainer.innerHTML = '';
    
    if (chats.length === 0) {
        els.savedChatsContainer.innerHTML = '<div style="padding:10px; color:var(--text-secondary); font-size:0.8rem; font-style:italic;">No saved chats yet.</div>';
        return;
    }

    chats.forEach(chat => {
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

        div.appendChild(titleSpan);
        div.appendChild(moreBtn);

        div.onclick = () => loadChat(chat.id);
        els.savedChatsContainer.appendChild(div);
    });
}

window.loadChat = async function(id) {
    const chat = await db.chats.get(id);
    if (chat) {
        setState({
            currentChatId: chat.id,
            messages: chat.messages
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
        chat.title = newTitle;
        await db.chats.put(chat);
        await loadSavedChats();
        emit('toast:show', "Chat renamed");
    }
}

// Wire up listeners for events emitted by decoupled modules.
on('chats:refresh-needed', () => {
    loadSavedChats();
});

on('chat:new-requested', () => {
    // Reset state and refresh list, then close sidebar on mobile.
    setState({
        messages: [],
        currentChatId: null,
        lastOperationId: Date.now()
    });
    els.chatContainer.innerHTML = '';
    loadSavedChats();
    if (window.innerWidth <= 768) els.sideBar.classList.remove('open');
});

on('chat:save', async () => {
    await saveChatToStorage();
});

on('chat:rename', (id, newTitle) => {
    renameChat(id, newTitle);
});
