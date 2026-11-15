
import { emit } from './event-bus.js';

const db = new Dexie('PuterGPT');

export function reportStorageError(error) {
    if (error?.name !== 'QuotaExceededError' && error?.inner?.name !== 'QuotaExceededError') return false;
    emit('toast:show', 'Storage is full. Recent changes may not have been saved.', 'error', {
        label: 'Export backup',
        onClick: () => window.exportFullBackup()
    });
    return true;
}

db.version(1).stores({
    chats: 'id, title, lastModified',
    tokens: 'id, name, value, token, status',
    settings: 'key, value'
});

export { db };

export async function migrateFromLocalStorage() {
    const chatsStr = localStorage.getItem('puter_chats');
    const tokensStr = localStorage.getItem('puter_tokens');
    const rotationStr = localStorage.getItem('puter_token_rotation');
    const modelStr = localStorage.getItem('puter_model');
    const promptStr = localStorage.getItem('puter_system_prompt');
    const scrollStr = localStorage.getItem('puter_auto_scroll');

    const chatCount = await db.chats.count();
    const tokenCount = await db.tokens.count();
    const settingCount = await db.settings.count();

    if (chatCount === 0 && chatsStr) {
        try {
            const chats = JSON.parse(chatsStr);
            if (Array.isArray(chats)) {
                await db.chats.bulkAdd(chats);
                console.log('Migrated chats from LocalStorage');
            }
        } catch (e) { console.error('Failed to migrate chats', e); }
    }

    if (tokenCount === 0 && tokensStr) {
        try {
            const tokens = JSON.parse(tokensStr);
            if (Array.isArray(tokens)) {
                await db.tokens.bulkAdd(tokens);
                console.log('Migrated tokens from LocalStorage');
            }
        } catch (e) { console.error('Failed to migrate tokens', e); }
    }

    if (settingCount === 0) {
        const settings = [];
        if (rotationStr !== null) settings.push({ key: 'token_rotation', value: rotationStr === 'true' });
        if (modelStr !== null) settings.push({ key: 'model', value: modelStr });
        if (promptStr !== null) settings.push({ key: 'system_prompt', value: promptStr });
        if (scrollStr !== null) settings.push({ key: 'auto_scroll', value: scrollStr !== 'false' });
        
        if (settings.length > 0) {
            await db.settings.bulkAdd(settings);
            console.log('Migrated settings from LocalStorage');
        }
    }
}
