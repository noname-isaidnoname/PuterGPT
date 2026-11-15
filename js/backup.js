import { db, reportStorageError, getPendingLegacyChats } from './indexeddb-storage.js';
import { downloadJsonFile, createModal } from './modal-helper.js';
import { emit } from './event-bus.js';
import { generateUniqueId } from './utils.js';
import { abortAssistantResponse } from './chat-api.js';
import { state } from './state.js';
import { getMessageText } from './utils.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertJsonSafe(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value)
        || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
        throw new Error('Backup contains data that cannot be represented in JSON');
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            if (!(i in value)) throw new Error('Backup contains a sparse array');
            assertJsonSafe(value[i], seen);
        }
    } else {
        for (const item of Object.values(value)) assertJsonSafe(item, seen);
    }
    seen.delete(value);
}

function validateBackup(data) {
    if (!isObject(data) || data.version !== 1 || !Array.isArray(data.chats)
        || !Array.isArray(data.themes) || !isObject(data.settings)
        || (data.tokens !== undefined && !Array.isArray(data.tokens))) {
        throw new Error('Invalid or unsupported backup format');
    }
    const ids = new Set();
    for (const chat of data.chats) {
        if (!isObject(chat) || typeof chat.id !== 'string' || !chat.id || typeof chat.title !== 'string'
            || !Array.isArray(chat.messages) || ids.has(chat.id)) throw new Error('Invalid or duplicate chat');
        ids.add(chat.id);
    }
    ids.clear();
    for (const theme of data.themes) {
        if (!isObject(theme) || typeof theme.id !== 'string' || !theme.id.startsWith('custom-')
            || ids.has(theme.id) || !isObject(theme.value) || !isObject(theme.value.cssVars)) {
            throw new Error('Invalid or duplicate custom theme');
        }
        ids.add(theme.id);
    }
    ids.clear();
    for (const token of data.tokens || []) {
        if (!isObject(token) || typeof token.id !== 'string' || !token.id || ids.has(token.id)
            || (typeof token.value !== 'string' && typeof token.token !== 'string')) {
            throw new Error('Invalid or duplicate token');
        }
        ids.add(token.id);
    }
    if ('customThemes' in data.settings) throw new Error('Themes must be in the themes list');
    return data;
}

// Keep the local copy at its original ID (the one used at startup). Preserve
// differing IndexedDB copies under unused IDs so the ordinary restore path can
// restore both, with provenance recorded in the backup.
export function collectBackupThemes(localThemes, storedThemes, reservedIds = []) {
    if (!isObject(localThemes) || !isObject(storedThemes)) throw new Error('Invalid custom theme storage');
    const localEntries = Object.entries(localThemes).map(([id, value]) => ({ id, value }));
    const storedEntries = Object.entries(storedThemes).map(([id, value]) => ({ id, value }));
    for (const themes of [localEntries, storedEntries]) {
        validateBackup({ version: 1, chats: [], themes, settings: {} });
        assertJsonSafe(themes);
    }
    const used = new Set([...localEntries.map(theme => theme.id), ...storedEntries.map(theme => theme.id), ...reservedIds]);
    const themes = [...localEntries];
    const indexedDBCopies = [];
    for (const { id, value } of storedEntries) {
        if (!Object.hasOwn(localThemes, id)) {
            themes.push({ id, value });
            indexedDBCopies.push({ originalId: id, backupId: id });
        } else if (JSON.stringify(localThemes[id]) !== JSON.stringify(value)) {
            let backupId = `${id}-recovered-db`;
            let suffix = 2;
            while (used.has(backupId)) backupId = `${id}-recovered-db-${suffix++}`;
            used.add(backupId);
            themes.push({ id: backupId, value });
            indexedDBCopies.push({ originalId: id, backupId });
        }
    }
    const localOnlyIds = localEntries.filter(theme => !Object.hasOwn(storedThemes, theme.id)).map(theme => theme.id);
    const recovery = indexedDBCopies.length || localOnlyIds.length
        ? { indexedDBCopies, localOnlyIds } : undefined;
    return { themes, recovery };
}

export async function createBackup(includeTokens = false) {
    const snapshot = await db.transaction('r', db.chats, db.settings, db.tokens, async () => {
        const chats = (await db.chats.toArray()).map(chat => {
            // Older imports wrote these optional fields as undefined; JSON
            // cannot represent that value, and it means the field was absent.
            const copy = { ...chat };
            for (const key of ['originalExportedAt', 'sharedAt']) {
                if (copy[key] === undefined) delete copy[key];
            }
            return copy;
        });
        const rows = await db.settings.toArray();
        const tokens = includeTokens ? await db.tokens.toArray() : undefined;
        if (rows.some(row => !isObject(row) || typeof row.key !== 'string')) throw new Error('Invalid settings records');
        const storedThemes = rows.find(row => row.key === 'customThemes')?.value;
        const local = localStorage.getItem('customThemes');
        const localThemes = local === null ? {} : JSON.parse(local);
        const { themes, recovery } = collectBackupThemes(localThemes, storedThemes === undefined ? {} : storedThemes);
        const settings = Object.fromEntries(rows.filter(row => row.key !== 'customThemes'
            && row.key !== 'legacy_chat_migration_sha256').map(row => [row.key, row.value]));
        // A quota failure can leave the active transcript newer than IndexedDB.
        const pending = state.pendingChatData?.id === state.currentChatId ? state.pendingChatData : null;
        if (state.currentChatId && (state.messages.length || pending)) {
            const index = chats.findIndex(chat => chat.id === state.currentChatId);
            const existing = index < 0 ? null : chats[index];
            const firstUser = state.messages.find(message => message.role === 'user');
            const text = getMessageText(firstUser);
            const current = { ...existing, ...pending, id: state.currentChatId,
                title: pending?.title || existing?.title || (text ? text.substring(0, 25) + (text.length > 25 ? '...' : '') : 'New Chat'),
                lastModified: Date.now(), messages: state.messages,
                generationParams: state.generationParams,
                systemPrompt: pending?.systemPrompt ?? existing?.systemPrompt ?? firstUser?.systemPrompt ?? state.config.systemPrompt };
            if (index < 0) chats.push(current);
            else chats[index] = current;
        }
        const legacy = getPendingLegacyChats();
        const legacyChatRecovery = [];
        if (legacy) {
            validateBackup({ version: 1, chats: legacy, themes: [], settings: {} });
            assertJsonSafe(legacy);
            const used = new Set([...chats.map(chat => chat.id), ...legacy.map(chat => chat.id)]);
            for (const chat of legacy) {
                const existing = chats.find(item => item.id === chat.id);
                if (existing && JSON.stringify(existing) === JSON.stringify(chat)) continue;
                let id = chat.id;
                if (existing) {
                    do { id = generateUniqueId(); } while (used.has(id));
                    used.add(id);
                }
                chats.push({ ...chat, id });
                legacyChatRecovery.push({ originalId: chat.id, backupId: id });
            }
        }
        return { version: 1, exportedAt: new Date().toISOString(), chats,
            themes, settings, ...(recovery ? { themeRecovery: recovery } : {}),
            ...(legacyChatRecovery.length ? { legacyChatRecovery } : {}),
            ...(includeTokens ? { tokens } : {}) };
    });
    validateBackup(snapshot);
    assertJsonSafe(snapshot);
    // A JSON round trip must succeed before a download can be offered.
    const json = JSON.stringify(snapshot, null, 2);
    validateBackup(JSON.parse(json));
    return json;
}

window.exportFullBackup = async () => {
    try {
        const includeTokens = document.getElementById('backup-include-tokens').checked;
        const json = await createBackup(includeTokens);
        downloadJsonFile(json, `putergpt-backup-${new Date().toISOString().slice(0, 10)}.json`);
        const result = JSON.parse(json);
        if (result.themeRecovery || result.legacyChatRecovery) {
            emit('toast:show', result.themeRecovery
                ? 'Backup exported with differing theme copies. Check themeRecovery in the file for details.'
                : 'Backup exported with recovered legacy chats. Check legacyChatRecovery for details.', 'info');
        } else {
            emit('toast:show', 'Backup exported successfully', 'success');
        }
    } catch (error) {
        emit('toast:show', `Backup failed: ${error.message}`, 'error');
    }
};

// The same policy applies to chat, theme, token and settings collisions.
// Existing themes are mirrored to localStorage because bootstrap reads it first.
export async function restoreBackup(data, policy) {
    validateBackup(data);
    if (!['skip', 'overwrite', 'rename'].includes(policy)) throw new Error('Invalid conflict policy');
    const previousLocal = localStorage.getItem('customThemes');
    const localThemes = previousLocal === null ? {} : JSON.parse(previousLocal);
    if (!isObject(localThemes)) throw new Error('Invalid existing themes');
    abortAssistantResponse();
    let localChanged = false;
    try {
        await db.transaction('rw', db.chats, db.settings, db.tokens, async () => {
            const storedThemes = (await db.settings.get('customThemes'))?.value;
            const incomingIds = new Set(data.themes.map(theme => theme.id));
            const existingThemes = collectBackupThemes(localThemes, storedThemes === undefined ? {} : storedThemes, incomingIds);
            const themes = Object.fromEntries(existingThemes.themes.map(theme => [theme.id, theme.value]));
            for (const chat of data.chats) {
                const existing = await db.chats.get(chat.id);
                if (existing && policy === 'skip') continue;
                const copy = { ...chat };
                if (existing && policy === 'rename') {
                    do { copy.id = generateUniqueId(); } while (await db.chats.get(copy.id));
                    copy.title += ' (imported)';
                }
                await db.chats.put(copy);
            }
            for (const theme of data.themes) {
                let id = theme.id;
                if (Object.hasOwn(themes, id)) {
                    if (policy === 'skip') continue;
                    if (policy === 'rename') {
                        do { id = `custom-${generateUniqueId()}`; } while (Object.hasOwn(themes, id) || incomingIds.has(id));
                    }
                }
                themes[id] = theme.value;
            }
            const activeTheme = await db.settings.get('theme');
            if (policy === 'overwrite' && typeof activeTheme?.value === 'string'
                && data.themes.some(theme => theme.id === activeTheme.value)) {
                await db.settings.put({ key: 'theme', value: 'dark' });
            }
            for (const [key, value] of Object.entries(data.settings)) {
                // A marker only applies to chats migrated within this database.
                if (key === 'legacy_chat_migration_sha256') continue;
                if (policy !== 'overwrite' && await db.settings.get(key)) continue;
                // Do not automatically activate imported theme scripts.
                if (key === 'theme' && typeof value === 'string' && value.startsWith('custom-')) continue;
                await db.settings.put({ key, value });
            }
            for (const token of data.tokens || []) {
                const existing = await db.tokens.get(token.id);
                if (existing && policy !== 'overwrite') continue;
                await db.tokens.put(token);
            }
            await db.settings.put({ key: 'customThemes', value: themes });
            localStorage.setItem('customThemes', JSON.stringify(themes));
            localChanged = true;
        });
    } catch (error) {
        if (localChanged) {
            if (previousLocal === null) localStorage.removeItem('customThemes');
            else localStorage.setItem('customThemes', previousLocal);
        }
        throw error;
    }
}

document.getElementById('backup-input').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        const data = validateBackup(JSON.parse(await file.text()));
        const modal = createModal(`
            <div class="modal">
                <h3>Restore backup?</h3>
                <p>Restore merges chats, settings, themes and any included tokens. If existing theme stores differ, both copies are kept under separate IDs before applying your choice below. Custom themes may contain JavaScript; only continue if you trust this file. The page will reload.</p>
                <label for="backup-conflict">When data already exists</label>
                <select id="backup-conflict">
                    <option value="skip">Keep existing data</option>
                    <option value="overwrite">Overwrite existing data</option>
                    <option value="rename">Keep both chats and themes (keep other existing data)</option>
                </select>
                <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px">
                    <button class="btn" id="backup-cancel">Cancel</button>
                    <button class="btn primary" id="backup-restore">Restore</button>
                </div>
            </div>`);
        modal.querySelector('#backup-cancel').onclick = () => modal.remove();
        modal.querySelector('#backup-restore').onclick = async event => {
            event.currentTarget.disabled = true;
            try {
                await restoreBackup(data, modal.querySelector('#backup-conflict').value);
                location.reload();
            } catch (error) {
                event.currentTarget.disabled = false;
                if (!reportStorageError(error)) emit('toast:show', `Restore failed: ${error.message}`, 'error');
            }
        };
    } catch (error) {
        emit('toast:show', `Invalid backup: ${error.message}`, 'error');
    }
});
