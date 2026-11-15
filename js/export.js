import { generateUniqueId } from './utils.js';
import { generateShareUrl } from './compression.js';
import { db, reportStorageError } from './indexeddb-storage.js';
import { setState } from './store.js';
import { downloadJsonFile } from './modal-helper.js';
import { emit, on } from './event-bus.js';
import { abortAssistantResponse } from './chat-api.js';
import { normalizeGenerationParams } from './generation-params.js';

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
            generationParams: normalizeGenerationParams(chat.generationParams),
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

        // Web Share requires a user gesture and is most useful on mobile.
        const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
            || window.matchMedia?.('(pointer: coarse)').matches;
        if (mobile && typeof navigator.share === 'function') {
            try {
                await navigator.share({ url: shareUrl });
                return;
            } catch (error) {
                // Dismissing the native sheet is not a request to copy instead.
                if (error.name === 'AbortError') return;
            }
        }

        let copied = false;
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(shareUrl);
                copied = true;
            } catch {
                // Try the legacy path below when clipboard permission is denied.
            }
        }
        if (!copied) {
            const textArea = document.createElement('textarea');
            textArea.value = shareUrl;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();

            try {
                copied = document.execCommand('copy');
            } finally {
                document.body.removeChild(textArea);
            }
        }
        emit('toast:show', copied ? 'Share link copied to clipboard' : 'Could not copy the share link.', copied ? 'success' : 'error');
    } catch (error) {
        console.error('Failed to share chat:', error);
        emit('toast:show', 'Failed to generate share link', 'error');
    }
}

export async function loadSharedChat() {
    try {
        const { parseSharedUrl } = await import('./compression.js');
        const sharedData = parseSharedUrl();

        if (sharedData && Array.isArray(sharedData.messages)) {
            const newChatId = generateUniqueId();
            // Stop any in-flight generation before swapping the transcript.
            abortAssistantResponse();

            const chatData = {
                id: newChatId,
                title: sharedData.title || 'Shared Chat',
                messages: sharedData.messages,
                lastModified: Date.now(),
                ...(sharedData.sharedAt !== undefined && { sharedAt: sharedData.sharedAt }),
                importedAt: new Date().toISOString()
            };

            setState({
                currentChatId: newChatId,
                pendingChatData: chatData,
                generationParams: normalizeGenerationParams(null),
                messages: sharedData.messages,
                attachedImages: []
            });

            emit('messages:rerender');
            await db.chats.put(chatData);
            setState(s => s.currentChatId === newChatId && s.pendingChatData === chatData ? { pendingChatData: null } : {});
            emit('chats:refresh-needed');
            emit('search:rebuild');
            emit('toast:show', `Loaded and saved shared chat: ${chatData.title} (${sharedData.messages.length} messages)`, 'success');
            window.history.replaceState(null, null, window.location.pathname);
        }
    } catch (error) {
        if (!reportStorageError(error)) {
            console.error('Failed to load shared chat:', error);
            emit('toast:show', 'Failed to load shared conversation', 'error');
        }
    }
}

export async function importChatFromJson(jsonData) {
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
            ...(jsonData.exportedAt !== undefined && { originalExportedAt: jsonData.exportedAt }),
            // Preserve the original starting system prompt for reference.
            // It is NOT used as the active system prompt going forward.
            systemPrompt: typeof jsonData.systemPrompt === 'string' ? jsonData.systemPrompt : '',
            generationParams: normalizeGenerationParams(jsonData.generationParams)
        };

        setState({
            currentChatId: newChatId,
            pendingChatData: chatData,
            generationParams: normalizeGenerationParams(jsonData.generationParams),
            messages: jsonData.messages,
            attachedImages: []
        });

        emit('messages:rerender');
        await db.chats.put(chatData);
        setState(s => s.currentChatId === newChatId && s.pendingChatData === chatData ? { pendingChatData: null } : {});
        emit('chats:refresh-needed');
        emit('search:rebuild');
        const msgCount = jsonData.messageCount || jsonData.messages.length;
        emit('toast:show', `Imported and saved chat: ${chatData.title} (${msgCount} messages)`, 'success');
    } catch (error) {
        if (!reportStorageError(error)) {
            console.error('Failed to import chat:', error);
            emit('toast:show', `Failed to import chat: ${error.message}`, 'error');
        }
    }
}
