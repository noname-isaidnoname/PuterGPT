import { generateUniqueId } from './utils.js';
import { generateShareUrl } from './compression.js';
import { db } from './indexeddb-storage.js';
import { setState } from './store.js';
import { downloadJsonFile } from './modal-helper.js';
import { emit, on } from './event-bus.js';
import { abortAssistantResponse } from './chat-api.js';

// Wire up listeners for the context-menu actions emitted from ui.js
on('chat:export-json', (chatId) => exportChatAsJson(chatId));
on('chat:export-markdown', (chatId) => exportChatAsMarkdown(chatId));
on('chat:share', (chatId) => shareChat(chatId));

// Export utilities for conversations

// Use a fence longer than any run in the value so metadata cannot terminate it.
function jsonBlock(value) {
    const json = JSON.stringify(value, null, 2);
    const longest = Math.max(0, ...(json.match(/`+/g) || []).map(run => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}json\n${json}\n${fence}`;
}

export function chatToMarkdown(chat) {
    const sections = [`# ${chat.title || 'Untitled Chat'}`];
    const { title, messages, ...metadata } = chat;
    if (Object.keys(metadata).length) sections.push(`## Chat metadata\n\n${jsonBlock(metadata)}`);
    for (const message of messages) {
        const { role, content, ...extra } = message;
        const heading = typeof role === 'string' && role ? role : 'Message';
        let text;
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            // Keep non-text parts, including attached images, rather than dropping them.
            text = content.map(part => part && part.type === 'text' && typeof part.text === 'string'
                && Object.keys(part).every(key => key === 'type' || key === 'text')
                ? part.text : jsonBlock(part)).join('\n\n');
        } else {
            text = jsonBlock(content ?? null);
        }
        sections.push(`## ${heading}\n\n${text}${Object.keys(extra).length ? `\n\n${jsonBlock(extra)}` : ''}`);
    }
    return sections.join('\n\n') + '\n';
}

async function exportChatAsMarkdown(chatId) {
    try {
        const chat = await db.chats.get(chatId);
        if (!chat) {
            emit('toast:show', 'Chat not found', 'error');
            return;
        }
        if (!Array.isArray(chat.messages)) throw new Error('Invalid chat messages');
        const blob = new Blob([chatToMarkdown(chat)], { type: 'text/markdown;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${(chat.title || 'chat').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${chat.id}.md`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 5000);
        emit('toast:show', 'Chat exported successfully', 'success');
    } catch (error) {
        console.error('Failed to export chat:', error);
        emit('toast:show', 'Failed to export chat', 'error');
    }
}

async function exportChatAsJson(chatId) {
    try {
        const chat = await db.chats.get(chatId);

        if (!chat) {
            emit('toast:show', 'Chat not found', 'error');
            return;
        }

        // Prepare export data with metadata
        const exportData = {
            title: chat.title,
            id: chat.id,
            exportedAt: new Date().toISOString(),
            lastModified: new Date(chat.lastModified).toISOString(),
            messageCount: chat.messages.length,
            // Top-level system prompt that was active at the start of the
            // chat. Falls back to the empty string for legacy chats that
            // predate this field. Per-turn snapshots are kept on each user
            // message in `messages` below.
            systemPrompt: typeof chat.systemPrompt === 'string' ? chat.systemPrompt : '',
            messages: chat.messages
        };

        // Create and download JSON file
        const jsonString = JSON.stringify(exportData, null, 2);
        downloadJsonFile(
            jsonString,
            `${chat.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${chat.id}.json`
        );

        emit('toast:show', 'Chat exported successfully', 'success');
    } catch (error) {
        console.error('Failed to export chat:', error);
        emit('toast:show', 'Failed to export chat', 'error');
    }
}

async function shareChat(chatId) {
    try {
        const chat = await db.chats.get(chatId);

        if (!chat) {
            emit('toast:show', 'Chat not found', 'error');
            return;
        }

        // Generate share URL
        const shareUrl = generateShareUrl({
            title: chat.title,
            messages: chat.messages,
            sharedAt: new Date().toISOString()
        });

        // Copy to clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(shareUrl);
            emit('toast:show', 'Share link copied to clipboard', 'success');
        } else {
            // Fallback for browsers without clipboard API
            const textArea = document.createElement('textarea');
            textArea.value = shareUrl;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();

            try {
                document.execCommand('copy');
                emit('toast:show', 'Share link copied to clipboard', 'success');
            } catch (error) {
                console.error('Failed to copy share link:', error);
                emit('toast:show', 'Failed to copy share link. URL: ' + shareUrl, 'error');
            } finally {
                document.body.removeChild(textArea);
            }
        }
    } catch (error) {
        console.error('Failed to share chat:', error);
        emit('toast:show', 'Failed to generate share link', 'error');
    }
}

export function loadSharedChat() {
    try {
        // Compression is already a direct import; this dynamic import is just to keep the
        // existing call site (export.js → compression.js) lazy.
        import('./compression.js').then(({ parseSharedUrl }) => {
            const sharedData = parseSharedUrl();

            if (sharedData && sharedData.messages) {
                const newChatId = generateUniqueId();
                // Stop any in-flight generation before swapping the transcript.
                abortAssistantResponse();

                const chatData = {
                    id: newChatId,
                    title: sharedData.title || 'Shared Chat',
                    messages: sharedData.messages,
                    lastModified: Date.now(),
                    sharedAt: sharedData.sharedAt,
                    importedAt: new Date().toISOString()
                };

                setState({
                    currentChatId: newChatId,
                    messages: sharedData.messages,
                    attachedImages: []
                });

                db.chats.put(chatData).then(() => {
                    emit('messages:rerender');
                    emit('chats:refresh-needed');
                    emit('search:rebuild');
                    emit('toast:show', `Loaded and saved shared chat: ${chatData.title} (${sharedData.messages.length} messages)`, 'success');
                    window.history.replaceState(null, null, window.location.pathname);
                });
            }
        });
    } catch (error) {
        console.error('Failed to load shared chat:', error);
        emit('toast:show', 'Failed to load shared conversation', 'error');
    }
}

export function importChatFromJson(jsonData) {
    try {
        // Validate the imported data structure
        if (!jsonData || typeof jsonData !== 'object') {
            throw new Error('Invalid JSON format');
        }

        if (!jsonData.messages || !Array.isArray(jsonData.messages)) {
            throw new Error('Invalid chat format: missing messages array');
        }

        // Note: any `systemPrompt` field present in the imported JSON
        // (top-level and per-message) is intentionally NOT applied to
        // the user's own settings. It is kept on the imported chat
        // record and messages for reference only, so the user can see
        // which prompts were used in the original conversation.

        const newChatId = generateUniqueId();
        // Stop any in-flight generation before swapping the transcript.
        abortAssistantResponse();

        const chatData = {
            id: newChatId,
            title: jsonData.title || 'Imported Chat',
            messages: jsonData.messages,
            lastModified: Date.now(),
            importedAt: new Date().toISOString(),
            originalExportedAt: jsonData.exportedAt,
            // Preserve the original starting system prompt for reference.
            // It is NOT used as the active system prompt going forward.
            systemPrompt: typeof jsonData.systemPrompt === 'string' ? jsonData.systemPrompt : ''
        };

        setState({
            currentChatId: newChatId,
            messages: jsonData.messages,
            attachedImages: []
        });

        db.chats.put(chatData).then(() => {
            emit('messages:rerender');
            emit('chats:refresh-needed');
            emit('search:rebuild');
            const msgCount = jsonData.messageCount || jsonData.messages.length;
            emit('toast:show', `Imported and saved chat: ${chatData.title} (${msgCount} messages)`, 'success');
        });
    } catch (error) {
        console.error('Failed to import chat:', error);
        emit('toast:show', `Failed to import chat: ${error.message}`, 'error');
    }
}
