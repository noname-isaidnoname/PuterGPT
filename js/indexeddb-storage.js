
import { emit } from './event-bus.js';

const db = new Dexie('PuterGPT');
let pendingLegacyChats = null;

export function getPendingLegacyChats() {
    return pendingLegacyChats;
}

export function reportStorageError(error) {
    const isQuota = err => err?.name === 'QuotaExceededError' || err?.inner?.name === 'QuotaExceededError';
    if (!isQuota(error) && !error?.failures?.some(isQuota)) return false;
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

db.version(2).stores({
    chats: 'id, title, lastModified, pinned',
    tokens: 'id, name, value, token, status',
    settings: 'key, value'
});

export { db };

// The marker identifies the exact legacy payload, not merely a previous
// migration attempt. Store it in the same database transaction as the chats,
// so clearing IndexedDB cannot leave a stale success marker behind.
async function legacyChatsFingerprint(value) {
    if (!globalThis.crypto?.subtle) return null;
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
}

async function hasMigrationWitness(marker, fingerprint) {
    if (!fingerprint || marker?.fingerprint !== fingerprint || typeof marker.proofKey !== 'string'
        || typeof marker.proof !== 'string' || !Array.isArray(marker.chatIds)
        || !marker.chatIds.every(id => typeof id === 'string')) return false;
    const records = await db.chats.bulkGet(marker.chatIds);
    return records.some(chat => chat && Object.hasOwn(chat, marker.proofKey) && chat[marker.proofKey] === marker.proof);
}

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

    if (chatsStr) {
        try {
            const chats = JSON.parse(chatsStr);
            if (Array.isArray(chats)) {
                pendingLegacyChats = chats;
                const fingerprint = await legacyChatsFingerprint(chatsStr);
                const marker = (await db.settings.get('legacy_chat_migration_sha256'))?.value;
                const confirmed = await hasMigrationWitness(marker, fingerprint);
                if (chatCount === 0) {
                    // A previous successful migration may have been followed by
                    // deletion of all chats. Invalidate its marker independently:
                    // a failed bulkAdd must not roll that invalidation back.
                    await db.settings.delete('legacy_chat_migration_sha256');
                    const canMark = fingerprint && chats.length && chats.every(chat =>
                        chat && typeof chat === 'object' && !Array.isArray(chat) && typeof chat.id === 'string');
                    let proofKey = '__puterLegacyMigrationProof';
                    while (canMark && chats.some(chat => Object.hasOwn(chat, proofKey))) proofKey += '_';
                    const proof = canMark ? Array.from(crypto.getRandomValues(new Uint8Array(16)),
                        byte => byte.toString(16).padStart(2, '0')).join('') : null;
                    await db.transaction('rw', db.chats, db.settings, async () => {
                        await db.chats.bulkAdd(canMark ? chats.map(chat => ({ ...chat, [proofKey]: proof })) : chats);
                        if (canMark) await db.settings.put({ key: 'legacy_chat_migration_sha256',
                            value: { fingerprint, proofKey, proof, chatIds: chats.map(chat => chat.id) } });
                    });
                    pendingLegacyChats = null;
                    console.log('Migrated chats from LocalStorage');
                } else if (!confirmed) {
                    pendingLegacyChats = chats;
                    emit('toast:show', 'Legacy chats may need recovery. Export a backup to preserve them.', 'info', {
                        label: 'Export backup',
                        onClick: () => window.exportFullBackup()
                    });
                } else {
                    pendingLegacyChats = null;
                }
            }
        } catch (e) {
            if (!reportStorageError(e)) console.error('Failed to migrate chats', e);
        }
    } else pendingLegacyChats = null;

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
