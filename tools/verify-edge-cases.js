#!/usr/bin/env node
// verify-edge-cases — exercises PuterGPT's failure paths and the implicit
// state machines around AI generation, settings discard tracking, search and
// theme generation.
//
// Unlike the other harnesses this one mocks `api.puter.com/drivers/call`
// through Playwright request routing, so it never depends on the network.
// The models/details endpoint is mocked too (a tiny canned list) so every
// page boots offline and fast — before this, each scenario waited on the
// real ~576 KB models fetch.
// Related tests are batched into shared-page scenarios (results within a
// batch run sequentially, marked in the batch title); unrelated batches are
// independent and run concurrently — adaptive default 4–6, EDGE_CONCURRENCY=1
// for sequential.
// Runs on Playwright only (lightpanda has no route interception).
//
// Usage: node tools/verify-edge-cases.js [--base-url URL] [--screenshot-dir DIR] [--only 11[,3,chat...]]
//   --only selects a subset of the 14 scenarios by 1-based index or name substring
//   (comma-separated, e.g. --only 11 or --only "generation flows,chat list"). Run it in
//   loops with --only for tight iteration on one scenario instead of the whole suite.
// Exits non-zero on any failed check, console error or page error.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');
const { startStaticServer, loadPlaywright, launchBrowser, sleep, installCdnCache } = require('./lib.js');

const argValue = (name) => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--' + name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const BASE_URL = argValue('base-url') || process.env.BASE_URL;
const SCREENSHOT_DIR = argValue('screenshot-dir') || process.env.SCREENSHOT_DIR
  || path.join(os.tmpdir(), 'putergpt-tools');

const NDJSON_OK = '{"type":"text","text":"Hi "}\n{"type":"text","text":"there"}\n';
const NDJSON_ANSWER_A = '{"type":"text","text":"Answer A"}\n';

// Small canned model list — keeps every page boot fully offline. Shape
// matches api.puter.com/puterai/chat/models/details (parseModelData).
const CANNED_MODELS = {
  models: [
    { id: 'puter:anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', costs: { input_tokens: 300, output_tokens: 1500 }, modalities: { input: ['text', 'image'] } },
    { id: 'puter:openai/gpt-4o', name: 'GPT-4o', costs: { input_tokens: 250, output_tokens: 1000 }, modalities: { input: ['text', 'image'] } },
    { id: 'puter:openrouter/google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', costs: { input_tokens: 30, output_tokens: 250, web_search: 0 }, modalities: { input: ['text', 'image'] } },
    { id: 'puter:deepseek/deepseek-r1', name: 'DeepSeek R1 Reasoning', costs: { input_tokens: 55, output_tokens: 219 }, modalities: { input: ['text'] } },
    { id: 'openrouter:google/gemini-2.0-flash-lite-preview-02-05:free', name: 'Gemini 2.0 Flash Lite', costs: { input_tokens: 0, output_tokens: 0 }, modalities: { input: ['text', 'image'] } },
    { id: 'openrouter:deepseek/deepseek-r1:free', name: 'DeepSeek R1', costs: { input_tokens: 0, output_tokens: 0 }, modalities: { input: ['text'] } },
    { id: 'openrouter:meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', costs: { input_tokens: 0, output_tokens: 0 }, modalities: { input: ['text'] } },
    { id: 'openrouter:grok-3-mini', name: 'Grok 3 Mini', costs: { input_tokens: 30, output_tokens: 500 }, modalities: { input: ['text'] } },
  ],
};

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const pw = loadPlaywright();
  if (!pw) {
    console.error('[verify-edge-cases] FAIL: playwright package not found (local, global, or npm root -g). See tools/README.md.');
    process.exit(1);
  }

  let server = null;
  let baseUrl = BASE_URL;
  if (!baseUrl) {
    const s = await startStaticServer();
    server = s.server;
    baseUrl = s.baseUrl;
  }
  console.log(`[verify-edge-cases] backend: playwright`);
  console.log(`[verify-edge-cases] base-url: ${baseUrl}`);

  const browser = await launchBrowser(pw);
  const startedAt = Date.now();
  let failures = 0;
  const consoleErrors = [];
  const pageErrors = [];

  // Scenarios run concurrently; each gets its own AsyncLocalStorage store so
  // PASS lines and console/page errors are attributed to the right scenario.
  const als = new AsyncLocalStorage();
  const check = (cond, label) => {
    const ok = !!cond;
    const line = `  ${ok ? 'PASS' : 'FAIL'} ${label}`;
    const store = als.getStore();
    if (store) {
      store.lines.push(line);
      if (!ok) store.failures++;
    } else {
      console.log(line);
      if (!ok) failures++;
    }
  };
  const trackConsoleError = (text) => {
    const store = als.getStore();
    (store ? store.consoleErrors : consoleErrors).push(text);
  };
  const trackPageError = (text) => {
    const store = als.getStore();
    (store ? store.pageErrors : pageErrors).push(text);
  };
  const scenarios = [];
  const scenario = (name, fn) => scenarios.push({ name, fn });
  // Run sub-tests sequentially against one shared page. A throwing
  // sub-test records a FAIL and the rest of its batch continues — one
  // hung wait must not delete the rest of the batch's signal.
  const pageDiag = (page) => () => page.evaluate(async () => {
    const { getState } = await import('./js/store.js');
    const { els } = await import('./js/state.js');
    const { tokenManager } = await import('./js/token-manager.js');
    const s = getState();
    const msgs = (s.messages || []).map(m => m.role + ':' + JSON.stringify(m?.content).slice(0, 60));
    return JSON.stringify({
      input: document.getElementById('user-input')?.value,
      inputInDomLen: document.getElementById('user-input')?.value?.length ?? -1,
      elsInputVal: els.input?.value,
      elsSame: els.input === document.getElementById('user-input'),
      sendTitle: document.getElementById('send-btn')?.getAttribute('title'),
      isGenerating: s.isGenerating,
      msgCount: (s.messages||[]).length,
      messages: msgs,
      modelId: s.config?.modelId,
      setInputVal: document.getElementById('user-input')?.value,
      tokenIsHealthy: tokenManager.tokens?.[tokenManager.currentIndex]?.isHealthy,
      tokenDisabled: tokenManager.tokens?.[tokenManager.currentIndex]?.disabled,
      tokenName: tokenManager.tokens?.[tokenManager.currentIndex]?.name,
      activeElement: document.activeElement?.id || document.activeElement?.tagName,
      disabled: document.getElementById('user-input')?.disabled,
      readOnly: document.getElementById('user-input')?.readOnly,
      settingsOpen: document.getElementById('settings-modal')?.classList.contains('active'),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).slice(-3),
    });
  });
  const subtest = async (name, fn, diag) => {
    try {
      await fn();
    } catch (e) {
      let dump = '';
      try { if (diag) dump = ' [diag ' + await diag() + ']'; } catch (diagErr) { dump = ' [diag failed: ' + diagErr.message + ']'; }
      try { require('fs').appendFileSync('/tmp/opencode/subtest-diag.log', new Date().toISOString() + ' ' + name + ' => ' + (e && e.message ? e.message.split('\n')[0] : e) + ' || ' + dump + '\n'); } catch {}
      check(false, `${name}: unexpected error — ${e && e.message ? e.message : e}${dump}`);
    }
  };

  // Fresh page (fresh context) per scenario; route interception mocks the
  // Puter API. The models/details endpoint is mocked too so boots don't hit
  // the network. page.close() also closes the context.
  const newPage = async (route, init, allowServiceWorkers = false) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
      serviceWorkers: allowServiceWorkers ? 'allow' : 'block',
    });
    await installCdnCache(ctx);
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') trackConsoleError(m.text()); });
    page.on('pageerror', e => { trackPageError(String(e)); });
    page.on('dialog', dialog => {
      trackPageError(`Unexpected native ${dialog.type()} dialog`);
      dialog.dismiss().catch(() => {});
    });
    await page.route('**/puterai/chat/models/details', r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CANNED_MODELS) }));
    if (route) await page.route('**/drivers/call', route);
    await page.goto(baseUrl + '/', { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.getElementById('main') && document.getElementById('main').classList.contains('welcome-mode'), null,
      { timeout: 15000 });
    const plainClose = page.close.bind(page);
    page.close = async () => {
      try { await plainClose(); } catch {}
      try { await ctx.close(); } catch {}
    };
    return page;
  };

  // Generation tests need a token, not a full settings interaction. Token UI
  // creation and deletion are exercised independently in Tests 7 and 17.
  const seedToken = async (page) => {
    await page.evaluate(async () => {
      const { tokenManager } = await import('./js/token-manager.js');
      await tokenManager.initialized;
      await tokenManager.addToken('Test Token', 'fake-token-for-ui-test');
    });
  };

  // Send a message and wait for the full send → stream → settle cycle.
  // The Stop-phase wait proves the send actually started (a bare Send-phase
  // wait resolves at boot too, before the pipeline starts).
  const sendAndSettle = async (page, text) => {
    await page.focus('#user-input');
    await page.focus('#user-input');
    await page.fill('#user-input', text);
    await page.press('#user-input', 'Enter');
    await page.waitForFunction(() => document.getElementById('send-btn')?.getAttribute('title') === 'Stop generating', null, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('send-btn')?.getAttribute('title') === 'Send message', null, { timeout: 30000 });
  };
  // DOM click (works for non-interactive elements, unlike hit-tested clicks)
  const domClick = (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) throw new Error('no element: ' + s);
    el.click();
    return true;
  }, sel);

  scenario('Legacy migration safety net (quota, rollback, reload, restore)', async () => {
    const page = await newPage();
    const resetWorld = () => page.evaluate(async () => {
      const { db } = await import('./js/indexeddb-storage.js');
      localStorage.clear();
      await db.chats.clear();
      await db.settings.clear();
      await db.tokens.clear();
    });
    const clearToasts = () => page.evaluate(() =>
      document.querySelectorAll('.toast-actionable').forEach(t => t.remove()));
    try {
      // --- Legacy chat migration quota failure offers recoverable backup ---
      await subtest('legacy quota failure', async () => {
        await resetWorld();
        const result = await page.evaluate(async () => {
          const { db, migrateFromLocalStorage } = await import('./js/indexeddb-storage.js');
          const legacy = [
            { id: 'legacy-1', title: 'Legacy one', lastModified: 1, messages: [{ role: 'user', content: 'Keep me' }] },
            { id: 'legacy-2', title: 'Legacy two', lastModified: 2, messages: [] }
          ];
          localStorage.setItem('puter_chats', JSON.stringify(legacy));
          const original = db.chats.bulkAdd;
          db.chats.bulkAdd = async function (chats) {
            await db.chats.add(chats[0]);
            const error = new Error('Bulk write failed');
            error.name = 'BulkError';
            error.failures = [new DOMException('Full', 'QuotaExceededError')];
            throw error;
          };
          try { await migrateFromLocalStorage(); } finally { db.chats.bulkAdd = original; }
          return { count: await db.chats.count(), legacy: JSON.parse(localStorage.getItem('puter_chats')) };
        });
        check(result.count === 0 && result.legacy.length === 2, 'Failed migration rolls back partial writes and keeps legacy data');
        const action = page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' });
        check(await action.count() === 1, 'Legacy migration quota error offers backup');
        const [download] = await Promise.all([page.waitForEvent('download'), action.click()]);
        const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        check(backup.chats.some(chat => chat.id === 'legacy-1' && chat.messages[0].content === 'Keep me')
          && backup.chats.some(chat => chat.id === 'legacy-2' && chat.messages.length === 0)
          && backup.legacyChatRecovery.length === 2, 'Downloaded backup includes both failed legacy chats');
        const collision = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { createBackup } = await import('./js/backup.js');
          await db.chats.put({ id: 'legacy-1', title: 'Newer chat', lastModified: 3, messages: [] });
          return JSON.parse(await createBackup());
        });
        check(collision.chats.some(chat => chat.id === 'legacy-1' && chat.title === 'Newer chat')
          && collision.chats.some(chat => chat.id !== 'legacy-1' && chat.title === 'Legacy one')
          && collision.legacyChatRecovery.some(item => item.originalId === 'legacy-1' && item.backupId !== 'legacy-1'),
        'Backup preserves both sides of a later chat ID collision');
        const retried = await page.evaluate(async () => {
          const { db, migrateFromLocalStorage, getPendingLegacyChats } = await import('./js/indexeddb-storage.js');
          await db.chats.clear();
          await migrateFromLocalStorage();
          return { count: await db.chats.count(), pending: getPendingLegacyChats() };
        });
        check(retried.count === 2 && retried.pending === null, 'Successful retry migrates both chats and clears recovery state');
        check(await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { createBackup } = await import('./js/backup.js');
          const marker = await db.settings.get('legacy_chat_migration_sha256');
          const backup = JSON.parse(await createBackup());
          return !!marker && !Object.hasOwn(backup.settings, 'legacy_chat_migration_sha256');
        }), 'Successful migration records a database-local marker that backups exclude');
        await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          await db.chats.update('legacy-1', { title: 'Edited after migration' });
        });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('main').classList.contains('welcome-mode'));
        check(await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).getPendingLegacyChats() === null),
          'Confirmed successful migration is not recovered again after reload');
      });
      // --- Marker deletion failure does not hide legacy recovery ---
      await subtest('marker deletion failure', async () => {
        await resetWorld();
        const stateAfterFailure = await page.evaluate(async () => {
          const { db, migrateFromLocalStorage } = await import('./js/indexeddb-storage.js');
          const legacy = [{ id: 'witness-chat', title: 'Original', lastModified: 1,
            messages: [{ role: 'user', content: 'Legacy message' }], __puterLegacyMigrationProof: 'user data' }];
          localStorage.setItem('puter_chats', JSON.stringify(legacy));
          await migrateFromLocalStorage();
          const migrated = await db.chats.get('witness-chat');
          const marker = (await db.settings.get('legacy_chat_migration_sha256'))?.value;
          await db.chats.clear();
          const original = db.settings.delete;
          db.settings.delete = function (key) {
            return key === 'legacy_chat_migration_sha256'
              ? Promise.reject(new DOMException('Full', 'QuotaExceededError'))
              : original.call(this, key);
          };
          try { await migrateFromLocalStorage(); } finally { db.settings.delete = original; }
          await db.chats.put({ id: 'witness-chat', title: 'New chat', lastModified: 2, messages: [] });
          return { marker, migrated, remaining: (await db.settings.get('legacy_chat_migration_sha256'))?.value };
        });
        check(stateAfterFailure.marker?.proof && stateAfterFailure.remaining?.proof === stateAfterFailure.marker.proof
          && stateAfterFailure.migrated.__puterLegacyMigrationProof === 'user data',
        'Failed deletion leaves the marker intact without overwriting a legacy field');
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('main').classList.contains('welcome-mode'));
        check(await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).getPendingLegacyChats()?.length === 1),
          'Reload rejects a stale marker even when a new chat reuses the old ID');
        const action = page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' });
        const [download] = await Promise.all([page.waitForEvent('download'), action.click()]);
        const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        const recoveredId = backup.legacyChatRecovery.find(item => item.originalId === 'witness-chat')?.backupId;
        check(recoveredId && recoveredId !== 'witness-chat'
          && backup.chats.some(chat => chat.id === 'witness-chat' && chat.title === 'New chat')
          && backup.chats.some(chat => chat.id === recoveredId && chat.messages[0].content === 'Legacy message'
            && chat.__puterLegacyMigrationProof === 'user data'),
        'Backup preserves the new chat and the original legacy chat');
        const restored = await page.evaluate(async data => {
          const { restoreBackup } = await import('./js/backup.js');
          const { db } = await import('./js/indexeddb-storage.js');
          await restoreBackup(data, 'overwrite');
          return db.chats.toArray();
        }, backup);
        check(restored.some(chat => chat.id === 'witness-chat' && chat.title === 'New chat')
          && restored.some(chat => chat.id === recoveredId && chat.messages[0].content === 'Legacy message'),
        'Restore recovers both the new and original chat');
      });
      // --- Stale legacy migration marker cannot hide a failed retry ---
      await subtest('stale marker cannot hide a failed retry', async () => {
        await resetWorld();
        const failedRetry = await page.evaluate(async () => {
          const { db, migrateFromLocalStorage } = await import('./js/indexeddb-storage.js');
          const legacy = [
            { id: 'stale-legacy', title: 'Earlier chat', lastModified: 1,
              messages: [{ role: 'user', content: 'Recover earlier content' }] },
            { id: 'stale-empty', title: 'Earlier empty chat', lastModified: 2, messages: [] }
          ];
          localStorage.setItem('puter_chats', JSON.stringify(legacy));
          await migrateFromLocalStorage();
          const hadMarker = !!(await db.settings.get('legacy_chat_migration_sha256'));
          await db.chats.clear();
          const original = db.chats.bulkAdd;
          db.chats.bulkAdd = () => Promise.reject(new DOMException('Full', 'QuotaExceededError'));
          try { await migrateFromLocalStorage(); } finally { db.chats.bulkAdd = original; }
          const markerAfterFailure = await db.settings.get('legacy_chat_migration_sha256');
          await db.chats.put({ id: 'stale-legacy', title: 'New chat', lastModified: 3, messages: [] });
          return { hadMarker, markerAfterFailure };
        });
        check(failedRetry.hadMarker && !failedRetry.markerAfterFailure,
          'Retry invalidates the previous success marker even when migration fails');
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('main').classList.contains('welcome-mode'));
        check(await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).getPendingLegacyChats()?.length === 2),
          'Reload detects legacy recovery after a new chat is saved');
        const action = page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' });
        const [download] = await Promise.all([page.waitForEvent('download'), action.click()]);
        const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        const recoveredId = backup.legacyChatRecovery.find(item => item.originalId === 'stale-legacy')?.backupId;
        check(recoveredId && recoveredId !== 'stale-legacy'
          && backup.chats.some(chat => chat.id === 'stale-legacy' && chat.title === 'New chat')
          && backup.chats.some(chat => chat.id === recoveredId && chat.messages[0].content === 'Recover earlier content')
          && backup.chats.some(chat => chat.id === 'stale-empty' && chat.messages.length === 0),
        'Downloaded backup contains the new chat and both legacy chats');
        const restored = await page.evaluate(async data => {
          const { restoreBackup } = await import('./js/backup.js');
          const { db } = await import('./js/indexeddb-storage.js');
          await restoreBackup(data, 'overwrite');
          return db.chats.toArray();
        }, backup);
        check(restored.some(chat => chat.id === 'stale-legacy' && chat.title === 'New chat')
          && restored.some(chat => chat.id === recoveredId && chat.messages[0].content === 'Recover earlier content')
          && restored.some(chat => chat.id === 'stale-empty' && chat.messages.length === 0),
        'Restored backup retains the new and recovered legacy chats');
      });
      // --- Failed legacy migration survives reload and restores ---
      await subtest('failed migration survives reload and restores', async () => {
        await resetWorld();
        await clearToasts();
        await page.evaluate(async () => {
          const { db, migrateFromLocalStorage } = await import('./js/indexeddb-storage.js');
          const legacy = JSON.stringify([
            { id: 'legacy-reload', title: 'Legacy', lastModified: 1, messages: [{ role: 'user', content: 'Legacy content' }] },
            { id: 'legacy-empty', title: 'Legacy empty', lastModified: 2, messages: [] }
          ]);
          localStorage.setItem('puter_chats', legacy);
          // A stale local marker from another or cleared database is not proof.
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacy));
          localStorage.setItem('puter_chats_migrated_sha256',
            Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''));
          const original = db.chats.bulkAdd;
          db.chats.bulkAdd = () => Promise.reject(new DOMException('Full', 'QuotaExceededError'));
          try { await migrateFromLocalStorage(); } finally { db.chats.bulkAdd = original; }
          await db.chats.put({ id: 'legacy-reload', title: 'New chat', lastModified: 3,
            messages: [{ role: 'user', content: 'New content' }] });
        });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('main').classList.contains('welcome-mode'));
        check(await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).getPendingLegacyChats()?.length === 2),
          'Reload detects unconfirmed legacy data despite a new saved chat');
        const action = page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' });
        check(await action.count() === 1, 'Reload offers a recovery backup');
        const [download] = await Promise.all([page.waitForEvent('download'), action.click()]);
        const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        const renamedId = backup.legacyChatRecovery.find(item => item.originalId === 'legacy-reload')?.backupId;
        check(renamedId && renamedId !== 'legacy-reload'
          && backup.chats.some(chat => chat.id === 'legacy-reload' && chat.title === 'New chat')
          && backup.chats.some(chat => chat.id === renamedId && chat.messages[0].content === 'Legacy content')
          && backup.chats.some(chat => chat.id === 'legacy-empty' && chat.messages.length === 0),
        'Downloaded backup preserves the new chat and both legacy chats');
        const restored = await page.evaluate(async data => {
          const { restoreBackup } = await import('./js/backup.js');
          const { db } = await import('./js/indexeddb-storage.js');
          data.settings.legacy_chat_migration_sha256 = 'forged';
          await restoreBackup(data, 'overwrite');
          return { chats: await db.chats.toArray(), marker: await db.settings.get('legacy_chat_migration_sha256') };
        }, backup);
        check(restored.chats.some(chat => chat.id === 'legacy-reload' && chat.title === 'New chat')
          && restored.chats.some(chat => chat.id === renamedId && chat.messages[0].content === 'Legacy content')
          && restored.chats.some(chat => chat.id === 'legacy-empty' && chat.messages.length === 0),
        'Restoring the downloaded backup recovers all three chats');
        check(!restored.marker, 'Restore ignores a database-specific migration marker in a backup');
      });
    } finally {
      await page.close();
    }
  });




  scenario('Quota-failed imports and shared chats stay recoverable', async () => {
    const page = await newPage();
    try {
      // --- Empty quota-failed imports and shared chats are backed up ---
      await subtest('empty imports and shared chats survive quota failures', async () => {
        const importId = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { state } = await import('./js/state.js');
          const { importChatFromJson } = await import('./js/export.js');
          const original = db.chats.put;
          db.chats.put = () => Promise.reject(new DOMException('Full', 'QuotaExceededError'));
          try {
            await importChatFromJson({ title: 'Empty import', systemPrompt: 'Keep this prompt', messages: [] });
          } finally {
            db.chats.put = original;
          }
          return state.currentChatId;
        });
        let [download] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' }).click()
        ]);
        let backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        let chat = backup.chats.find(entry => entry.id === importId);
        check(chat?.title === 'Empty import' && chat.systemPrompt === 'Keep this prompt'
          && Array.isArray(chat.messages) && chat.messages.length === 0 && !!chat.importedAt,
        'Backup action preserves empty imported chat and metadata');

        const sharedId = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { state } = await import('./js/state.js');
          const { loadSharedChat } = await import('./js/export.js');
          const data = { title: 'Empty shared', sharedAt: '2026-01-01T00:00:00.000Z', messages: [] };
          history.replaceState(null, '', '#shared=' + window.LZString.compressToEncodedURIComponent(JSON.stringify(data)));
          const original = db.chats.put;
          db.chats.put = () => Promise.reject(new DOMException('Full', 'QuotaExceededError'));
          try {
            await loadSharedChat();
          } finally {
            db.chats.put = original;
          }
          return state.currentChatId;
        });
        [download] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' }).click()
        ]);
        backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        chat = backup.chats.find(entry => entry.id === sharedId);
        check(chat?.title === 'Empty shared' && chat.sharedAt === '2026-01-01T00:00:00.000Z'
          && Array.isArray(chat.messages) && chat.messages.length === 0 && !!chat.importedAt,
        'Backup action preserves empty shared chat and metadata');
        await page.evaluate(async () => (await import('./js/event-bus.js')).emit('chat:save'));
        await page.waitForFunction(() => [...document.querySelectorAll('.chat-title')].some(el => el.textContent === 'Empty shared'));
        check(await page.evaluate(async () => {
          const { state } = await import('./js/state.js');
          const { db } = await import('./js/indexeddb-storage.js');
          const saved = await db.chats.get(state.currentChatId);
          return saved?.title === 'Empty shared' && saved.messages.length === 0 && state.pendingChatData === null;
        }), 'Retry can save an empty pending chat');
      });
      // --- Quota failures preserve imported and shared chats for backup ---
      await subtest('imported and shared chats with content stay recoverable', async () => {
        const imported = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { importChatFromJson } = await import('./js/export.js');
          await db.chats.put({ id: 'legacy-import', title: 'Legacy import', messages: [], lastModified: 1, originalExportedAt: undefined });
          const original = db.chats.put;
          db.chats.put = () => Promise.reject(new DOMException('Full', 'QuotaExceededError'));
          try {
            await importChatFromJson({ title: 'Unsaved import', systemPrompt: 'Original prompt', messages: [{ role: 'user', content: 'Import content' }] });
          } finally { db.chats.put = original; }
          const { createBackup } = await import('./js/backup.js');
          return JSON.parse(await createBackup()).chats;
        });
        check(imported.some(chat => chat.title === 'Unsaved import' && chat.systemPrompt === 'Original prompt'
          && chat.messages[0].content === 'Import content'), 'Failed import remains recoverable with its metadata');
        check(imported.some(chat => chat.title === 'Legacy import'), 'Legacy optional undefined fields do not prevent backup');
        check((await page.locator('.toast-actionable').last().innerText()).includes('Storage is full'), 'Import quota error offers backup');
        await page.evaluate(async () => (await import('./js/event-bus.js')).emit('chat:save'));
        await page.waitForFunction(() => [...document.querySelectorAll('.chat-title')].some(el => el.textContent === 'Unsaved import'));
        const retried = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { state } = await import('./js/state.js');
          return { record: await db.chats.get(state.currentChatId), pending: state.pendingChatData };
        });
        check(retried.record.title === 'Unsaved import' && retried.record.systemPrompt === 'Original prompt'
          && !!retried.record.importedAt && retried.pending === null, 'Retry saves original import metadata and clears pending record');
        const shared = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { loadSharedChat } = await import('./js/export.js');
          const data = { title: 'Unsaved shared chat', messages: [{ role: 'user', content: 'Shared content' }] };
          history.replaceState(null, '', '#shared=' + window.LZString.compressToEncodedURIComponent(JSON.stringify(data)));
          const original = db.chats.put;
          db.chats.put = () => Promise.reject(new DOMException('Full', 'QuotaExceededError'));
          try { await loadSharedChat(); } finally { db.chats.put = original; }
          return { hash: location.hash, text: document.querySelector('#chat-container').textContent };
        });
        check(shared.hash.startsWith('#shared=') && shared.text.includes('Shared content'), 'Failed shared chat remains visible and share URL is retained');
        const action = page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' });
        const [download] = await Promise.all([page.waitForEvent('download'), action.click()]);
        const data = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        check(data.chats.some(chat => chat.title === 'Unsaved shared chat' && chat.messages[0].content === 'Shared content'), 'Quota action downloads backup containing unsaved shared chat');
      });
    } finally {
      await page.close();
    }
  });


  scenario('Divergent theme stores across boots, edits and backups', async () => {
    const page = await newPage();
    const clearToasts = () => page.evaluate(() =>
      document.querySelectorAll('.toast-actionable').forEach(t => t.remove()));
    try {
      // --- Startup reconciles divergent theme stores across reloads ---
      await subtest('startup reconciliation keeps both stores consistent', async () => {
        await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const theme = name => ({ name, cssVars: { '--bg-primary': '#123456' } });
          localStorage.setItem('customThemes', JSON.stringify({
            'custom-shared': theme('Local version'),
            'custom-shared-recovered-db': theme('Occupied recovery ID'),
            'custom-local': theme('Local only')
          }));
          await db.settings.put({ key: 'customThemes', value: {
            'custom-shared': theme('Database version'),
            'custom-db': theme('Database only')
          } });
        });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('main').classList.contains('welcome-mode'));
        const snapshot = () => page.evaluate(async () => ({
          local: JSON.parse(localStorage.getItem('customThemes')),
          stored: (await (await import('./js/indexeddb-storage.js')).db.settings.get('customThemes')).value,
          cards: [...document.querySelectorAll('.theme-card[data-theme-card]')].map(card => card.dataset.themeCard)
        }));
        const first = await snapshot();
        check(JSON.stringify(first.local) === JSON.stringify(first.stored)
          && first.local['custom-shared']?.name === 'Local version'
          && first.local['custom-shared-recovered-db-2']?.name === 'Database version'
          && first.local['custom-shared-recovered-db']?.name === 'Occupied recovery ID'
          && first.local['custom-db']?.name === 'Database only'
          && first.local['custom-local']?.name === 'Local only', 'Startup preserves both stores and resolves ID conflicts');
        check(['custom-shared', 'custom-shared-recovered-db-2', 'custom-db', 'custom-local']
          .every(id => first.cards.includes(id)), 'Recovered themes are available in the theme picker');
        check(await page.getByText('Recovered theme copies with separate IDs.').count() === 1,
          'Startup informs the user about recovered database copies');
        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="appearance"]');
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#settings-modal')).opacity) > 0.99);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'recovered-themes-desktop.png') });
        await page.setViewportSize({ width: 420, height: 850 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'recovered-themes-mobile.png') });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('main').classList.contains('welcome-mode'));
        const second = await snapshot();
        check(JSON.stringify(second.local) === JSON.stringify(first.local)
          && JSON.stringify(second.stored) === JSON.stringify(first.stored), 'A second reload keeps recovery IDs stable without duplicates');
      });
      // --- Startup theme reconciliation rolls back if local storage is full ---
      await subtest('local storage quota rolls back the sync', async () => {
        await clearToasts();
        const result = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { loadCustomThemes } = await import('./js/theme-generator.js');
          const local = { 'custom-local': { name: 'Local', cssVars: {} } };
          const stored = { 'custom-db': { name: 'Database', cssVars: {} } };
          localStorage.setItem('customThemes', JSON.stringify(local));
          await db.settings.put({ key: 'customThemes', value: stored });
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (this === localStorage && key === 'customThemes') throw new DOMException('Full', 'QuotaExceededError');
            return original.call(this, key, value);
          };
          try { await loadCustomThemes(); } finally { Storage.prototype.setItem = original; }
          return {
            local: JSON.parse(localStorage.getItem('customThemes')),
            stored: (await db.settings.get('customThemes')).value
          };
        });
        check(result.local['custom-local']?.name === 'Local' && !result.local['custom-db']
          && result.stored['custom-db']?.name === 'Database' && !result.stored['custom-local'],
        'Failed local write rolls back the IndexedDB sync and preserves both originals');
        check(await page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' }).count() === 1,
          'Local storage quota failure offers a recovery backup');
      });
      // --- Quota failure during custom-theme sync offers backup ---
      await subtest('custom-theme sync quota offers a recoverable backup', async () => {
        await clearToasts();
        const result = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { themeDefinitions } = await import('./js/store.js');
          const { loadCustomThemes } = await import('./js/theme-generator.js');
          const themes = { 'custom-sync': { name: 'Sync theme', cssVars: { '--bg-primary': '#123456' } } };
          localStorage.setItem('customThemes', JSON.stringify(themes));
          await db.settings.put({ key: 'customThemes', value: themes });
          const original = db.settings.put;
          db.settings.put = function (row) {
            return row.key === 'customThemes'
              ? Promise.reject(new DOMException('Full', 'QuotaExceededError'))
              : original.call(this, row);
          };
          try { await loadCustomThemes(); } finally { db.settings.put = original; }
          return {
            local: JSON.parse(localStorage.getItem('customThemes')),
            saved: (await db.settings.get('customThemes')).value,
            definition: themeDefinitions['custom-sync']
          };
        });
        check(!!result.local['custom-sync'] && !!result.saved['custom-sync'] && !!result.definition,
          'Failed sync preserves local, stored and loaded themes');
        const action = page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' });
        check(await action.count() === 1, 'Theme sync quota error offers backup');
        const [download] = await Promise.all([page.waitForEvent('download'), action.click()]);
        const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        check(backup.themes.some(theme => theme.id === 'custom-sync'), 'Backup action downloads the preserved theme');
        await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { loadCustomThemes } = await import('./js/theme-generator.js');
          const themes = JSON.parse(localStorage.getItem('customThemes'));
          themes['custom-sync'] = { name: 'Local version', cssVars: { '--bg-primary': '#111111' } };
          themes['custom-sync-recovered-db'] = { name: 'Existing ID', cssVars: { '--bg-primary': '#222222' } };
          themes['custom-unsynced'] = { name: 'Unsynced', cssVars: { '--bg-primary': '#abcdef' } };
          await db.settings.put({ key: 'customThemes', value: {
            'custom-sync': { name: 'Database version', cssVars: { '--bg-primary': '#333333' } },
            'custom-db-only': { name: 'Database only', cssVars: { '--bg-primary': '#444444' } }
          } });
          localStorage.setItem('customThemes', JSON.stringify(themes));
          const original = db.settings.put;
          db.settings.put = () => Promise.reject(new DOMException('Full', 'QuotaExceededError'));
          try { await loadCustomThemes(); } finally { db.settings.put = original; }
        });
        const [recoveryDownload] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' }).click()
        ]);
        const recovery = JSON.parse(fs.readFileSync(await recoveryDownload.path(), 'utf8'));
        const find = id => recovery.themes.find(theme => theme.id === id)?.value;
        check(find('custom-sync')?.name === 'Local version' && find('custom-sync-recovered-db-2')?.name === 'Database version'
          && find('custom-sync-recovered-db')?.name === 'Existing ID', 'Conflicting copies and an occupied recovery ID are preserved');
        check(find('custom-unsynced')?.name === 'Unsynced' && find('custom-db-only')?.name === 'Database only',
          'Local-only and database-only themes are preserved');
        check(recovery.themeRecovery.indexedDBCopies.some(copy => copy.originalId === 'custom-sync' && copy.backupId === 'custom-sync-recovered-db-2')
          && recovery.themeRecovery.localOnlyIds.includes('custom-unsynced'), 'Backup records recovery provenance');
        check(await page.getByText('Backup exported with differing theme copies.', { exact: false }).count() === 1,
          'Export reports differing theme copies');
        const restored = await page.evaluate(async data => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { restoreBackup } = await import('./js/backup.js');
          localStorage.setItem('customThemes', '{}');
          await db.settings.put({ key: 'customThemes', value: {} });
          await restoreBackup(data, 'overwrite');
          return { local: JSON.parse(localStorage.getItem('customThemes')), stored: (await db.settings.get('customThemes')).value };
        }, recovery);
        check(restored.local['custom-sync']?.name === 'Local version'
          && restored.local['custom-sync-recovered-db-2']?.name === 'Database version'
          && restored.stored['custom-db-only']?.name === 'Database only'
          && restored.stored['custom-unsynced']?.name === 'Unsynced', 'Restore retains both versions and synchronizes theme copies');
        check(await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { createBackup } = await import('./js/backup.js');
          await db.settings.put({ key: 'customThemes', value: { 'custom-invalid': { name: 'Broken' } } });
          try { await createBackup(); return false; } catch { return true; }
        }), 'Invalid database theme copy still fails backup validation');
      });
      // --- Restore reconciles divergent existing theme stores ---
      await subtest('restore reconciles divergent existing stores', async () => {
        await clearToasts();
        const results = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { restoreBackup } = await import('./js/backup.js');
          const theme = name => ({ name, cssVars: { '--bg-primary': '#123456' } });
          const local = { 'custom-conflict': theme('Local'), 'custom-local-only': theme('Local only') };
          const stored = { 'custom-conflict': theme('Database'), 'custom-db-only': theme('Database only') };
          const backup = { version: 1, exportedAt: '', chats: [], settings: {}, themes: [
            { id: 'custom-conflict', value: theme('Incoming conflict') },
            { id: 'custom-conflict-recovered-db', value: theme('Incoming reserved ID') }
          ] };
          const results = {};
          for (const policy of ['skip', 'overwrite', 'rename']) {
            localStorage.setItem('customThemes', JSON.stringify(local));
            await db.settings.put({ key: 'customThemes', value: stored });
            await restoreBackup(backup, policy);
            results[policy] = {
              local: JSON.parse(localStorage.getItem('customThemes')),
              stored: (await db.settings.get('customThemes')).value
            };
          }
          localStorage.setItem('customThemes', JSON.stringify(local));
          await db.settings.put({ key: 'customThemes', value: stored });
          const original = db.settings.put;
          db.settings.put = row => row.key === 'customThemes'
            ? Promise.reject(new DOMException('Full', 'QuotaExceededError')) : original.call(db.settings, row);
          try { await restoreBackup(backup, 'overwrite'); } catch {}
          finally { db.settings.put = original; }
          results.rollback = {
            local: JSON.parse(localStorage.getItem('customThemes')),
            stored: (await db.settings.get('customThemes')).value
          };
          return results;
        });
        for (const policy of ['skip', 'overwrite', 'rename']) {
          const { local, stored } = results[policy];
          check(JSON.stringify(local) === JSON.stringify(stored)
            && local['custom-db-only']?.name === 'Database only'
            && local['custom-local-only']?.name === 'Local only'
            && local['custom-conflict-recovered-db-2']?.name === 'Database'
            && local['custom-conflict-recovered-db']?.name === 'Incoming reserved ID',
          `${policy}: retains existing divergent copies and reserves incoming IDs`);
          const names = Object.values(local).map(theme => theme.name);
          check(policy === 'skip' ? local['custom-conflict'].name === 'Local' && !names.includes('Incoming conflict')
            : policy === 'overwrite' ? local['custom-conflict'].name === 'Incoming conflict'
            : local['custom-conflict'].name === 'Local' && names.includes('Incoming conflict'),
          `${policy}: applies the selected incoming collision policy`);
        }
        check(results.rollback.local['custom-conflict'].name === 'Local'
          && results.rollback.stored['custom-conflict'].name === 'Database'
          && results.rollback.stored['custom-db-only'].name === 'Database only',
        'Failed restore leaves both divergent stores unchanged');
        await page.setInputFiles('#backup-input', {
          name: 'restore.json', mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ version: 1, chats: [], themes: [], settings: {} }))
        });
        await page.waitForSelector('.modal-overlay.active #backup-restore');
        check((await page.locator('.modal-overlay.active .modal').innerText()).includes('both copies are kept'),
          'Restore dialog explains divergent theme handling');
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.modal-overlay.active')).opacity) > 0.99);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'restore-themes-desktop.png') });
        await page.setViewportSize({ width: 420, height: 850 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'restore-themes-mobile.png') });
        await page.click('.modal-overlay.active #backup-cancel');
      });
      // --- Quota failure rolls back custom-theme deletion ---
      await subtest('theme deletion quota rolls back both stores', async () => {
        await clearToasts();
        const result = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { setState, getState, themeDefinitions } = await import('./js/store.js');
          const themes = { 'custom-quota': { name: 'Quota theme', cssVars: { '--bg-primary': '#111111' } } };
          localStorage.setItem('customThemes', JSON.stringify(themes));
          await db.settings.put({ key: 'customThemes', value: themes });
          await db.settings.put({ key: 'theme', value: 'custom-quota' });
          themeDefinitions['custom-quota'] = themes['custom-quota'];
          setState(s => ({ config: { ...s.config, theme: 'custom-quota' } }));
          window.openDeleteThemeModal();
          const original = db.settings.put;
          db.settings.put = function (row) {
            return row.key === 'theme' ? Promise.reject(new DOMException('Full', 'QuotaExceededError')) : original.call(this, row);
          };
          try { await window.confirmDeleteTheme(); } finally { db.settings.put = original; }
          return {
            local: JSON.parse(localStorage.getItem('customThemes')),
            saved: (await db.settings.get('customThemes')).value,
            theme: getState().config.theme,
            definition: !!themeDefinitions['custom-quota'],
            modalOpen: document.getElementById('delete-theme-modal').classList.contains('active')
          };
        });
        check(!!result.local['custom-quota'] && !!result.saved['custom-quota'] && result.theme === 'custom-quota'
          && result.definition && result.modalOpen, 'Failed deletion keeps theme and confirmation intact');
        check(await page.locator('.toast-actionable').last().getByRole('button', { name: 'Export backup' }).count() === 1, 'Theme quota error offers backup');
        await page.evaluate(() => window.confirmDeleteTheme());
        const deleted = await page.evaluate(async () => ({
          local: JSON.parse(localStorage.getItem('customThemes')),
          saved: (await (await import('./js/indexeddb-storage.js')).db.settings.get('customThemes')).value
        }));
        check(!deleted.local['custom-quota'] && !deleted.saved['custom-quota'], 'Retry deletes both theme copies');
      });
    } finally {
      await page.close();
    }
  });





  scenario('Theme generation, voice input, native share and token XSS', async () => {
    const themeJson = JSON.stringify({
      name: 'Test Sea', icon: '🌊', description: 'A test theme',
      cssVars: { '--accent': '#006680', '--bg-primary': '#f0fbfd' },
    });
    const apiResponse = JSON.stringify({ result: { message: { content: themeJson } } });
    const page = await newPage(async route => route.fulfill({ status: 200, contentType: 'application/json', body: apiResponse }), () => {
      window.__shareMode = 'success';
      window.__shares = [];
      window.__copies = [];
      const originalMatchMedia = window.matchMedia.bind(window);
      window.__coarse = true;
      window.matchMedia = query => query === '(pointer: coarse)' ? { matches: window.__coarse } : originalMatchMedia(query);
      Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
        window.__shares.push(data);
        if (window.__shareMode === 'cancel') throw new DOMException('Dismissed', 'AbortError');
        if (window.__shareMode === 'fail') throw new Error('Not supported');
      } });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copies.push(text) } });
      window.SpeechRecognition = class {
        constructor() { window.testRecognition = this; }
        start() {}
        stop() { this.onend(); }
      };
    });
    try {
      // --- Test 13: theme generation end-to-end (button id, modal) ---
      await subtest('theme generation applies the generated theme', async () => {
        await page.evaluate(() => { window.openThemeGenerator(); });
        await page.waitForFunction(() => document.getElementById('theme-generator-modal')?.classList.contains('active'), null, { timeout: 5000 });
        await page.fill('#theme-prompt', 'ocean');
        const modelOptions = await page.evaluate(() => document.querySelectorAll('#theme-model-select option').length);
        check(modelOptions > 0, `theme model dropdown populated (${modelOptions} options)`);
        await page.click('#generate-theme-btn');
        await page.waitForFunction(
          () => document.getElementById('theme-generator-modal') &&
               !document.getElementById('theme-generator-modal').classList.contains('active'), null,
          { timeout: 15000 });
        const accent = await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));
        check(accent.trim() === '#006680', `generated theme applied (--accent=${accent.trim() || '(unset)'})`);
      });
      // --- Voice input uses speech recognition when available ---
      await subtest('voice input uses speech recognition when available', async () => {
        await page.focus('#user-input');
        await page.fill('#user-input', 'Hello ');
        await page.click('#voice-btn');
        await page.evaluate(() => {
          window.testRecognition.onresult({ results: [[{ transcript: 'world' }]] });
        });
        check(await page.inputValue('#user-input') === 'Hello world', 'Speech transcript appears in composer');
        check(await page.getAttribute('#voice-btn', 'aria-pressed') === 'true', 'Voice button indicates listening');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'voice-input.png') });
        await page.click('#voice-btn');
        check(await page.getAttribute('#voice-btn', 'aria-pressed') === 'false', 'Voice input stops');
      });
      // --- Share uses native mobile sheet and falls back safely ---
      await subtest('share uses native sheet and falls back safely', async () => {
        await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          await db.chats.put({ id: 'share-test', title: 'Shared', lastModified: Date.now(), messages: [{ role: 'user', content: 'Hello' }] });
          const { emit } = await import('./js/event-bus.js');
          await import('./js/export.js');
          emit('chat:share', 'share-test');
        });
        await page.waitForFunction(() => window.__shares.length === 1);
        check(await page.evaluate(() => window.__shares[0].url.includes('#shared=') && window.__copies.length === 0), 'Mobile uses native share with generated URL');
        await page.evaluate(async () => {
          window.__shareMode = 'cancel';
          (await import('./js/event-bus.js')).emit('chat:share', 'share-test');
        });
        await page.waitForFunction(() => window.__shares.length === 2);
        check(await page.evaluate(() => window.__copies.length === 0), 'Cancel does not copy the link');
        await page.evaluate(async () => {
          window.__shareMode = 'fail';
          (await import('./js/event-bus.js')).emit('chat:share', 'share-test');
        });
        await page.waitForFunction(() => window.__copies.length === 1);
        check(true, 'Native-share failure falls back to clipboard');
        await page.evaluate(async () => {
          window.__coarse = false;
          (await import('./js/event-bus.js')).emit('chat:share', 'share-test');
        });
        await page.waitForFunction(() => window.__copies.length === 2);
        check(await page.evaluate(() => window.__shares.length === 3), 'Desktop keeps clipboard sharing');
      });
    } finally {
      await page.close();
    }
  });

  scenario('Dialog guard, modal a11y and keyboard shortcuts', async () => {
    const page = await newPage();
    try {
      // --- Native dialog guard returns safe defaults and async helpers settle ---
      await subtest('native dialog guard returns safe defaults', async () => {
        const defaults = await page.evaluate(() => ({
          confirm: window.confirm('<img src=x onerror=alert(1)>'),
          prompt: null
        }));
        check(defaults.confirm === false, 'Synchronous confirm returns false');
        await page.waitForSelector('.modal-overlay.active #confirm-btn');
        check(await page.locator('.modal-overlay.active img').count() === 0, 'Guard escapes untrusted dialog text');
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.modal-overlay.active')).opacity) > 0.99);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'dialog-guard-desktop.png') });
        await page.setViewportSize({ width: 420, height: 850 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'dialog-guard-mobile.png') });
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.click('.modal-overlay.active #confirm-btn');
        const promptDefault = await page.evaluate(() => window.prompt('Enter value', 'original'));
        check(promptDefault === null, 'Synchronous prompt returns null');
        await page.waitForSelector('.modal-overlay.active #prompt-cancel-btn');
        await page.click('.modal-overlay.active #prompt-cancel-btn');
        await page.evaluate(async () => {
          const { confirmAsync } = await import('./js/modal-helper.js');
          window.__dialogResult = 'pending';
          confirmAsync('Proceed?').then(value => { window.__dialogResult = value; });
        });
        await page.waitForSelector('.modal-overlay.active #confirm-btn');
        await page.click('.modal-overlay.active #confirm-btn');
        await page.waitForFunction(() => window.__dialogResult === true);
        check(true, 'Async confirmation returns the selected result');
        await page.evaluate(async () => {
          const { promptAsync } = await import('./js/modal-helper.js');
          window.__dialogResult = 'pending';
          promptAsync('Value?').then(value => { window.__dialogResult = value; });
        });
        await page.waitForSelector('.modal-overlay.active #prompt-modal-input');
        await page.fill('.modal-overlay.active #prompt-modal-input', 'answer');
        await page.press('.modal-overlay.active #prompt-modal-input', 'Enter');
        await page.waitForFunction(() => window.__dialogResult === 'answer');
        check(true, 'Async prompt returns entered text');
        await page.evaluate(async () => {
          const { confirmAsync } = await import('./js/modal-helper.js');
          window.__dialogResult = 'pending';
          confirmAsync('Dismiss?').then(value => { window.__dialogResult = value; });
        });
        await page.waitForSelector('.modal-overlay.active #cancel-btn');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => window.__dialogResult === false);
        check(true, 'Dismissed async dialog resolves safely');
      });
      // --- Modal focus, theme keyboard access and reduced motion ---
      await subtest('modal focus, theme keyboard access and reduced motion', async () => {
        await page.focus('#shortcuts-help');
        await page.evaluate(async () => {
          const { createConfirmModal } = await import('./js/modal-helper.js');
          createConfirmModal({ title: 'First dialog', onConfirm: () => {} });
        });
        await page.waitForFunction(() => document.querySelector('.modal-overlay.active .modal')?.contains(document.activeElement));
        const dialog = page.locator('.modal-overlay.active .modal').last();
        check(await dialog.getAttribute('role') === 'dialog' && await dialog.getAttribute('aria-modal') === 'true'
          && !!(await dialog.getAttribute('aria-labelledby')), 'Modal has dialog semantics and an accessible label');
        check(!(await dialog.innerText()).includes('undefined'), 'Confirmation without a body has no placeholder text');
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.modal-overlay.active')).opacity) > 0.99);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'a11y-modal-desktop.png') });
        await page.setViewportSize({ width: 420, height: 850 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'a11y-modal-mobile.png') });
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.focus('.modal-overlay.active #cancel-btn');
        await page.keyboard.press('Shift+Tab');
        check(await page.evaluate(() => document.activeElement.id) === 'confirm-btn', 'Shift+Tab wraps to last control');
        await page.keyboard.press('Tab');
        check(await page.evaluate(() => document.activeElement.id) === 'cancel-btn', 'Tab wraps to first control');
        await page.evaluate(() => document.getElementById('sidebar-filter').focus());
        check(await page.evaluate(() => !!document.activeElement.closest('.modal-overlay.active')), 'Programmatic focus cannot escape the modal');
        await page.evaluate(async () => {
          const { createConfirmModal } = await import('./js/modal-helper.js');
          createConfirmModal({ title: 'Nested dialog', onConfirm: () => {} });
        });
        await page.waitForFunction(() => document.querySelectorAll('.modal-overlay.active .modal').length === 2);
        await page.keyboard.press('Escape');
        check(await page.locator('.modal-overlay.active .modal').count() === 1, 'Escape closes only the top nested dialog');
        check(await page.evaluate(() => !!document.activeElement.closest('.modal-overlay.active')), 'Closing nested dialog restores focus to its parent');
        await page.keyboard.press('Escape');
        check(await page.evaluate(() => document.activeElement.id) === 'shortcuts-help', 'Closing modal restores the original focus');

        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="appearance"]');
        await page.keyboard.press('Tab'); // Data tab
        await page.keyboard.press('Tab'); // Light theme card
        check(await page.evaluate(() => document.activeElement?.dataset.themeCard === 'light'), 'Theme card is reachable by keyboard');
        const focusStyle = await page.locator('.theme-card[data-theme-card="light"]').evaluate(el => getComputedStyle(el).outlineStyle);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'a11y-theme-focus.png') });
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.theme-card[data-theme-card="light"]').getAttribute('aria-pressed') === 'true');
        check(focusStyle !== 'none', 'Theme cards have a visible keyboard focus outline');
        check(true, 'Theme card can be activated with Enter');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Space');
        await page.waitForFunction(() => document.querySelector('.theme-card[data-theme-card="dark"]').getAttribute('aria-pressed') === 'true');
        check(true, 'Theme card can be activated with Space');
        // Theme-card clicks don't mark settings dirty, so × closes the modal
        // directly; wait for that so the following sub-tests start clean
        await page.click('.settings-close');
        await page.waitForFunction(() => !document.getElementById('settings-modal').classList.contains('active'), null, { timeout: 5000 });

        await page.emulateMedia({ reducedMotion: 'reduce' });
        const motion = await page.evaluate(() => {
          const dot = document.createElement('div');
          dot.className = 'dot';
          document.body.appendChild(dot);
          const animation = getComputedStyle(dot).animationDuration;
          const transition = getComputedStyle(document.querySelector('.settings-modal')).transitionDuration;
          dot.remove();
          return { animation, transition };
        });
        check(parseFloat(motion.animation) <= 0.01 && parseFloat(motion.transition) <= 0.01, 'Reduced motion shortens animations and transitions');
      });
      // --- Keyboard shortcuts respect focus and export the active chat ---
      await subtest('keyboard shortcuts respect focus and export', async () => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.focus('#user-input');
        await page.fill('#user-input', 'Draft');
        await page.keyboard.press('Control+,');
        check(!(await page.locator('#settings-modal').evaluate(el => el.classList.contains('active'))), 'Settings shortcut ignored while typing');
        await page.keyboard.press('Control+Shift+E');
        check(await page.inputValue('#user-input') === 'Draft', 'Export shortcut ignored while typing');
        await page.keyboard.press('Control+K');
        check(await page.evaluate(() => document.activeElement.id) === 'sidebar-filter', 'Ctrl+K focuses filter from composer');
        await page.fill('#sidebar-filter', '?');
        check(await page.locator('.shortcut-dialog').count() === 0, 'Question mark remains text in an input');
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.type('?');
        await page.waitForSelector('.shortcut-dialog');
        await page.waitForFunction(() => {
          const overlay = document.querySelector('.shortcut-dialog')?.closest('.modal-overlay');
          return overlay && Number(getComputedStyle(overlay).opacity) > 0.99;
        });
        check(await page.locator('.shortcut-row').count() === 4, 'Question mark opens shortcut guide');
        await page.keyboard.press('Control+K');
        check(await page.evaluate(() => document.activeElement.id !== 'sidebar-filter'), 'Shortcuts do not focus behind an open dialog');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'shortcuts-desktop.png') });
        await page.setViewportSize({ width: 420, height: 850 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'shortcuts-mobile.png') });
        await page.keyboard.press('Escape');
        check(await page.locator('.shortcut-dialog').count() === 0, 'Escape closes the guide');
        await page.focus('#user-input');
        await page.fill('#user-input', 'Draft');
        await page.keyboard.press('Control+K');
        check(await page.evaluate(() => document.activeElement.id === 'sidebar-filter' && document.getElementById('sidebar').classList.contains('open')), 'Ctrl+K opens mobile sidebar and focuses filter');
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          await db.chats.put({ id: 'export-key', title: 'Shortcut', messages: [{ role: 'user', content: 'Hello' }], lastModified: Date.now() });
          await window.loadChat('export-key');
          document.activeElement.blur();
        });
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.keyboard.press('Control+Shift+E')
        ]);
        check(download.suggestedFilename().endsWith('.json'), 'Export shortcut downloads the current chat');
        await page.keyboard.press('Control+,');
        check(await page.locator('#settings-modal').evaluate(el => el.classList.contains('active')), 'Settings shortcut opens settings outside inputs');
      });
    } finally {
      await page.close();
    }
  });



  scenario('PWA caches the shell but never caches API requests', async () => {
    const page = await newPage(null, null, true);
    try {
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
      check(true, 'Service worker installed and controls the page');
      const manifest = await page.evaluate(async () => {
        const response = await fetch(document.querySelector('link[rel="manifest"]').href);
        return response.json();
      });
      check(manifest.start_url === './' && manifest.icons.length >= 2, 'Install manifest has scoped start URL and icons');
      await page.route('https://api.puter.com/pwa-cache-probe', route =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'network response' }));
      const apiResult = await page.evaluate(async () => {
        const cache = await caches.open('putergpt-test-api');
        await cache.put('https://api.puter.com/pwa-cache-probe', new Response('cached response'));
        const value = await (await fetch('https://api.puter.com/pwa-cache-probe')).text();
        await caches.delete('putergpt-test-api');
        return value;
      });
      check(apiResult === 'network response', 'API request bypasses cached responses');
      const apiCached = await page.evaluate(async () => !!(await caches.match('https://api.puter.com/pwa-cache-probe')));
      check(!apiCached, 'API response was not stored by the service worker');
      await page.context().setOffline(true);
      const offlineShell = await page.evaluate(async () => (await fetch('./js/app.js')).text());
      check(offlineShell.includes('bootstrap'), 'Application shell is available offline');
      const offlinePage = await page.context().newPage();
      try {
        await offlinePage.goto(baseUrl + '/', { waitUntil: 'load' });
        await offlinePage.waitForFunction(() => document.getElementById('main')?.classList.contains('welcome-mode'), null, { timeout: 15000 });
        check(true, 'Cached application boots offline');
      } finally {
        await offlinePage.close();
      }
      await page.context().setOffline(false);
      await page.evaluate(() => navigator.serviceWorker.register('./sw.js?update-test=1'));
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(el => el.textContent.includes('An update is available')), null, { timeout: 30000 });
      check(true, 'Waiting service worker announces an update');
      await page.waitForSelector('.toast.show');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'pwa-update.png') });
      await page.setViewportSize({ width: 420, height: 850 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'pwa-update-mobile.png') });
      await Promise.all([
        page.waitForEvent('load', { timeout: 30000 }),
        page.locator('.toast').filter({ hasText: 'An update is available' }).getByRole('button', { name: 'Reload' }).click()
      ]);
      check(true, 'User accepts update and reloads into the new worker');
    } finally {
      await page.context().setOffline(false);
      await page.close();
    }
  });

  scenario('Comparison streams independently without changing the chat', async () => {
    const requests = [];
    const page = await newPage(async route => {
      const args = route.request().postDataJSON().args;
      requests.push(args);
      if (requests.length === 1) {
        await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_ANSWER_A });
      } else {
        await new Promise(() => {});
      }
    });
    try {
      await seedToken(page);
      await page.focus('#user-input');
      await page.fill('#user-input', 'Compare this prompt');
      await page.click('#compare-btn');
      await page.click('.compare-start');
      await page.waitForFunction(() => document.querySelectorAll('.compare-status')[0].textContent === 'Complete');
      await page.waitForFunction(() => document.querySelectorAll('.compare-status')[1].textContent === 'Generating…');
      check((await page.locator('.compare-output').first().innerText()) === 'Answer A', 'First model completes independently');
      check(requests.length === 2 && requests.every(args => args.messages[1].content === 'Compare this prompt'), 'Both models receive the same prompt');
      check(requests[0].model !== requests[1].model, 'Comparison uses two selected models');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'comparison-desktop.png') });
      await page.setViewportSize({ width: 420, height: 850 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'comparison-mobile.png') });
      await page.locator('.compare-stop').nth(1).click();
      check(await page.locator('.compare-status').nth(1).innerText() === 'Stopped', 'Second model stops independently');
      check(await page.locator('.compare-status').first().innerText() === 'Complete', 'Stopping second model keeps first result');
      await page.click('.compare-start');
      await page.waitForFunction(() => [...document.querySelectorAll('.compare-status')].every(el => el.textContent === 'Generating…'));
      await page.click('.compare-close');
      check(await page.locator('.message').count() === 0 && await page.inputValue('#user-input') === 'Compare this prompt', 'Comparison leaves transcript and composer unchanged');
      await page.click('#compare-btn');
      check(await page.locator('.compare-status').first().innerText() === 'Ready' && await page.locator('.compare-output').first().innerText() === '', 'Closing active comparison resets its independent streams');
    } finally {
      await page.close();
    }
  });

  scenario('Response variants (switch, regenerate, abort, edit-truncate)', async () => {
    let vCalls = 0;
    let mode = 'variants';
    const page = await newPage(async route => {
      vCalls++;
      if (mode === 'variants') {
        const text = ['First answer', 'Second answer', 'Edited answer'][vCalls - 1] || 'Edited answer';
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson',
          body: JSON.stringify({ type: 'text', text }) + '\n' });
      }
      if (vCalls === 1) return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_ANSWER_A });
      return new Promise(() => {});
    });
    const idle = () => page.waitForFunction(async () => {
      const { getState } = await import('./js/store.js');
      return !getState().isGenerating;
    }, null, { timeout: 30000 });
    try {
      await seedToken(page);
      await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).db.settings.put({ key: 'auto_name_chats', value: false }));
      // Enable variants once for the whole batch (settings modal → General tab → Save)
      await page.click('button.settings-row');
      await page.click('.settings-tab[data-tab="general"]');
      await domClick(page, '#enable-variants');
      await page.click('.settings-footer .btn.primary');
      // --- Switching an earlier response requires confirmation ---
      await subtest('switching an earlier response requires confirmation', async () => {
        await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { setState } = await import('./js/store.js');
          await db.chats.put({ id: 'branch', title: 'Branch', lastModified: Date.now(), messages: [
            { role: 'user', content: 'Question' },
            { role: 'assistant', content: 'Second', variants: [{ content: 'First' }, { content: 'Second' }], activeVariant: 1 },
            { role: 'user', content: 'Follow-up' },
            { role: 'assistant', content: 'Later answer' }
          ] });
          setState({ variantsEnabled: true });
          await window.loadChat('branch');
        });
        await domClick(page, '.variant-prev');
        await page.waitForSelector('.modal-overlay.active #confirm-btn');
        check(await page.locator('.message').count() === 4, 'Later messages remain until confirmation');
        await page.click('.modal-overlay.active #cancel-btn');
        check(await page.locator('.message').count() === 4, 'Cancel preserves later messages');
        await domClick(page, '.variant-prev');
        await page.waitForSelector('.modal-overlay.active #confirm-btn');
        await page.click('.modal-overlay.active #confirm-btn');
        await page.waitForFunction(() => document.querySelectorAll('.message').length === 2);
        check((await page.locator('.message.assistant').innerText()).includes('First'), 'Confirm selects alternative and removes dependent turns');
      });
      // --- Response variants regenerate, switch and truncate on earlier edit ---
      await subtest('response variants regenerate, switch and truncate', async () => {
        mode = 'variants';
        vCalls = 0;
        await page.evaluate(() => window.newChat());
        await sendAndSettle(page, 'Original question');
        await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('First answer'));
        await page.waitForSelector('.regenerate');
        await domClick(page, '.regenerate');
        await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('Second answer'));
        await idle();
        await page.waitForFunction(() => document.querySelector('.variant-switcher')?.textContent.includes('2/2'));
        check(true, 'Regenerate preserves first response and selects second');
        await page.locator('.message.assistant').hover();
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'response-variants.png') });
        await domClick(page, '.variant-prev');
        await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('First answer'));
        check((await page.locator('.variant-switcher').innerText()).includes('1/2'), 'Switch restores first response');
        await domClick(page, '.variant-next');
        await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('Second answer'));
        await domClick(page, '.message.user .edit');
        await page.fill('.message.user .edit-textarea', 'Edited question');
        await domClick(page, '.message.user .edit-controls .btn.primary:last-child');
        await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('Edited answer'));
        await idle();
        check(await page.locator('.variant-switcher').count() === 0, 'Editing earlier prompt and regenerating discards its old response branch');
        check(vCalls === 3, 'Exactly three completions were requested');
      });
      // --- Aborting variant regeneration preserves the original ---
      await subtest('aborting variant regeneration preserves the original', async () => {
        mode = 'answer-then-hang';
        vCalls = 0;
        await page.evaluate(() => window.newChat());
        await sendAndSettle(page, 'Hello');
        await page.waitForSelector('.regenerate');
        await domClick(page, '.regenerate');
        await page.waitForSelector('.typing-indicator');
        await page.click('#send-btn');
        await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('Answer A'));
        check(await page.locator('.variant-switcher').count() === 0, 'Abort restores the original without an empty variant');
        mode = 'variants';
      });
    } finally {
      await page.close();
    }
  });




  scenario('Generation extensions (errors, params, title, code copy)', async () => {
    let mode = 'fast';
    let genCalls = 0;
    let titleCalls = 0;
    let capturedArgs = null;
    let requestCount = 0;
    const page = await newPage(async route => {
      genCalls++;
      const body = route.request().postDataJSON();
      const isTitle = !!body?.args?.messages?.[0]?.content?.includes('at most six words');
      if (isTitle) {
        titleCalls++;
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson',
          body: '{"type":"text","text":"{\\"title\\": \\"A Helpful Title\\"}"}\n' });
      }
      capturedArgs = body?.args || null;
      requestCount++;
      if (mode === 'code') {
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson',
          body: '{"type":"text","text":"```js\\nconsole.log(1+1)\\n```"}\n' });
      }
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_OK });
    });
    const idle = () => page.waitForFunction(async () => {
      const { getState } = await import('./js/store.js');
      return !getState().isGenerating;
    }, null, { timeout: 30000 });
    try {
      await seedToken(page);
      await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).db.settings.put({ key: 'auto_name_chats', value: false }));
      // --- Test 11: zero console errors across a full cycle ---
      await subtest('zero console errors during seed → send cycle', async () => {
        // Own-batch console errors only (batches run concurrently)
        const store = () => als.getStore();
        await sendAndSettle(page, 'hello');
        // Wait for the stream to complete (content rendered), not just for the
        // send-button title, which starts as 'Send message' before Enter lands.
        await page.waitForFunction(
          () => (document.querySelector('.rendered-content')?.textContent || '').includes('Hi there')
            && document.getElementById('send-btn')?.getAttribute('title') === 'Send message', null,
          { timeout: 15000 });
        const fresh = (store()?.consoleErrors || []).filter(e => !e.includes('401') && !e.includes('net::'));
        check(fresh.length === 0, `zero console errors during seed → send cycle${fresh.length ? ' (got: ' + fresh.join(' | ') + ')' : ''}`);
      });
      // --- Test 14: code block Copy button does not error ---
      await subtest('code block copy button copies code to clipboard', async () => {
        mode = 'code';
        await sendAndSettle(page, 'give me code');
        await page.waitForSelector('.code-block-header', { timeout: 10000 });
        await page.click('.code-block-header .copy-btn');
        await sleep(300);
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        check(copied.includes('console.log(1+1)'), 'code block copy button copies code to clipboard');
        mode = 'fast';
      });
      // --- Generation parameters follow the chat and request ---
      await subtest('generation parameters follow the chat and request', async () => {
        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="model"]');
        await page.fill('#chat-temperature', '0.4');
        await page.locator('#chat-temperature').dispatchEvent('change');
        await page.fill('#chat-max-tokens', '256');
        await page.locator('#chat-max-tokens').dispatchEvent('change');
        await page.click('.settings-footer .btn.primary');
        const requestsBefore = requestCount;
        await page.focus('#user-input');
        await page.fill('#user-input', 'Parameter test');
        await page.press('#user-input', 'Enter');
        for (let waited = 0; requestCount === requestsBefore && waited < 10000; waited += 25) await sleep(25);
        const args = capturedArgs;
        check(!!args && args.temperature === 0.4 && args.max_tokens === 256, 'Request includes configured Puter parameters');
        const chatId = await page.evaluate(async () => (await import('./js/state.js')).state.currentChatId);
        await page.evaluate(() => window.newChat());
        check(await page.inputValue('#chat-temperature') === '' && await page.inputValue('#chat-max-tokens') === '', 'New chat uses model defaults');
        await page.evaluate(id => window.loadChat(id), chatId);
        check(await page.inputValue('#chat-temperature') === '0.4' && await page.inputValue('#chat-max-tokens') === '256', 'Loading chat restores its parameters');
        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="model"]');
        await page.click('#reset-generation-params');
        check(await page.inputValue('#chat-temperature') === '' && await page.inputValue('#chat-max-tokens') === '', 'Reset clears both parameters');
      });
      // --- Auto-title runs once on a new chat ---
      await subtest('auto-title runs once on a new chat', async () => {
        await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).db.settings.put({ key: 'auto_name_chats', value: true }));
        titleCalls = 0;
        await page.evaluate(() => window.newChat());
        await sendAndSettle(page, 'Hello');
        await page.waitForFunction(() => [...document.querySelectorAll('.chat-title')].some(el => el.textContent === 'A Helpful Title'), null, { timeout: 10000 });
        check(titleCalls === 1, `One title completion generated after first answer (got ${titleCalls})`);
      });
    } finally {
      await page.close();
    }
  });

  scenario('Chat list, backup/restore and markdown export', async () => {
    const page = await newPage();
    try {
      // --- Sidebar pin and filtering preserve chat metadata ---
      await subtest('sidebar pin and filtering preserve chat metadata', async () => {
        await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          await db.chats.bulkPut([
            { id: 'a', title: 'Alpha', messages: [], lastModified: 1 },
            { id: 'b', title: 'Beta', messages: [], lastModified: 2 }
          ]);
          await window.toggleChatPin('a');
        });
        check(await page.locator('.chat-item').first().getAttribute('data-id') === 'a', 'Pinned chat sorts first');
        await page.fill('#sidebar-filter', 'ALP');
        await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 1);
        check(await page.locator('.chat-item').first().getAttribute('data-id') === 'a', 'Filter matches titles case-insensitively');
        check(await page.evaluate(async () => (await (await import('./js/indexeddb-storage.js')).db.chats.get('a')).pinned), 'Pin is persisted');
        await page.fill('#sidebar-filter', '');
      });
      // --- Backup restores conflicts and excludes tokens by default ---
      await subtest('backup restore conflicts and token exclusion', async () => {
        const result = await page.evaluate(async () => {
          const { db } = await import('./js/indexeddb-storage.js');
          const { createBackup, restoreBackup } = await import('./js/backup.js');
          await db.chats.put({ id: 'same', title: 'Original', messages: [], lastModified: 1 });
          await db.tokens.put({ id: 'secret', name: 'Secret', value: 'token-secret' });
          const normal = JSON.parse(await createBackup());
          const withTokens = JSON.parse(await createBackup(true));
          const incoming = { version: 1, exportedAt: '', chats: [{ id: 'same', title: 'Imported', messages: [], lastModified: 2 }],
            themes: [], settings: {} };
          await restoreBackup(incoming, 'skip');
          const skipped = (await db.chats.get('same')).title;
          await restoreBackup(incoming, 'rename');
          const chats = await db.chats.toArray();
          await restoreBackup(incoming, 'overwrite');
          const overwritten = (await db.chats.get('same')).title;
          let invalidRejected = false;
          try { await restoreBackup({ ...incoming, themes: [{ id: 'dark', value: {} }] }, 'overwrite'); }
          catch { invalidRejected = true; }
          return { normal, withTokens, skipped, chats, overwritten, invalidRejected };
        });
        check(!('tokens' in result.normal) && !JSON.stringify(result.normal).includes('token-secret'), 'Default backup omits tokens');
        check(result.withTokens.tokens[0].value === 'token-secret', 'Token opt-in includes credentials');
        check(result.skipped === 'Original' && result.overwritten === 'Imported', 'Skip and overwrite honor chat collisions');
        check(result.chats.some(chat => chat.title === 'Original') && result.chats.some(chat => chat.title === 'Imported (imported)'), 'Rename retains both chats');
        check(result.invalidRejected, 'Invalid theme IDs rejected');
        await page.evaluate(async () => (await import('./js/event-bus.js')).emit('chats:refresh-needed'));
        await page.waitForSelector('.chat-more-btn');
        await page.locator('.chat-item').first().hover();
        await page.locator('.chat-more-btn').first().click();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#chat-context-menu')).opacity === '1');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'backup-menu-desktop.png') });
        await page.click('#sidebar-filter');
        await page.setViewportSize({ width: 420, height: 850 });
        await page.click('.mobile-toggle');
        await page.locator('.chat-more-btn').first().click();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#chat-context-menu')).opacity === '1');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'backup-menu-mobile.png') });
        await page.locator('#chat-context-menu .context-item', { hasText: 'Backup and restore' }).click();
        check(await page.locator('#settings-modal.active #settings-panel-data.active').count() === 1, 'Context menu opens backup and restore settings');
        check(await page.locator('#backup-include-tokens').isChecked() === false, 'Context menu leaves token inclusion off by default');
        await page.click('.settings-close');
        await page.setViewportSize({ width: 1280, height: 800 });
      });
      // --- Markdown export preserves content and print hides app chrome ---
      await subtest('markdown export and print layout', async () => {
        const markdown = await page.evaluate(async () => {
          const { chatToMarkdown } = await import('./js/export.js');
          return chatToMarkdown({
            id: 'example', title: 'Example', systemPrompt: 'Be helpful',
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'Question' }, { type: 'image_url', image_url: 'data:image/png;base64,abc' }] },
              { role: 'assistant', content: '```js\nconst x = 1;\n```', reasoning: 'thinking' }
            ]
          });
        });
        check(markdown.includes('# Example') && markdown.includes('## user') && markdown.includes('Question'), 'Markdown includes title and user message');
        check(markdown.includes('```js\nconst x = 1;\n```') && markdown.includes('thinking'), 'Markdown preserves code and reasoning');
        check(markdown.includes('data:image/png;base64,abc') && markdown.includes('Be helpful'), 'Markdown preserves attachments and system prompt');
        await page.emulateMedia({ media: 'print' });
        check(await page.locator('#sidebar').evaluate(el => getComputedStyle(el).display === 'none'), 'Print hides sidebar');
        check(await page.locator('#chat-container').evaluate(el => getComputedStyle(el).overflowY === 'visible'), 'Print expands transcript');
      });
    } finally {
      await page.close();
    }
  });




  scenario('Generation flows (stream, bubble, abort, 401, mid-chat switch)', async () => {
    let mode = 'fast';
    let genCalls = 0;
    const page = await newPage(async route => {
      genCalls++;
      const body = route.request().postDataJSON();
      const isTitle = !!body?.args?.messages?.[0]?.content?.includes('at most six words');
      if (isTitle) {
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson',
          body: '{"type":"text","text":"A Helpful Title"}\n' });
      }
      if (mode === 'hang') return new Promise(() => {});
      if (mode === '401') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"token_auth_failed"}' });
      if (mode === 'answer-then-hang') {
        return genCalls === 1
          ? route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_ANSWER_A })
          : new Promise(() => {});
      }
      await sleep(50);
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_OK });
    });
    // The app ignores sends while a previous stream is still settling
    // (isGenerating), and the send button title is the synchronous UI mirror —
    // always wait for it before pressing Enter or clicking regenerate.
    const idle = () => page.waitForFunction(async () => {
      const { getState } = await import('./js/store.js');
      return !getState().isGenerating;
    }, null, { timeout: 30000 });
    try {
      await seedToken(page);
      await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).db.settings.put({ key: 'auto_name_chats', value: false }));
      // --- Test 1: user bubble sizes to content (reported bug) ---
      await subtest('user bubble sizes to content', async () => {
        await sendAndSettle(page, 'Hello');
        await page.waitForSelector('.user-bubble');
        const box = await page.locator('.user-bubble').first().boundingBox();
        check(box && box.width > 60 && box.height < 80,
          `user bubble sizes to content (got ${box ? Math.round(box.width) : 0}x${box ? Math.round(box.height) : 0})`);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'edge-cases-bubble.png') });
      });
      // --- Test 2: successful stream renders + cost badge ---
      await subtest('successful stream renders with cost badge', async () => {
        await sendAndSettle(page, 'Hello');
        await page.waitForFunction(
          () => (document.querySelector('.rendered-content') || {}).textContent?.includes('Hi there'), null,
          { timeout: 15000 });
        check(true, 'assistant streamed content rendered');
        await page.waitForSelector('.message-cost', { timeout: 15000 });
        check(true, 'cost badge rendered after completion');
        await idle();
        check(await page.getAttribute('#send-btn', 'title') === 'Send message', 'send button back to send state after completion');
      });
      // --- Test 3: stop button aborts, no stuck state ---
      await subtest('stop button aborts cleanly', async () => {
        mode = 'hang';
        await idle();
        await page.focus('#user-input');
        await page.fill('#user-input', 'Hello');
        await page.press('#user-input', 'Enter');
        await page.waitForFunction(() => document.getElementById('send-btn')?.getAttribute('title') === 'Stop generating', null, { timeout: 10000 });
        await page.waitForSelector('.typing-indicator', { timeout: 10000 });
        check(await page.getAttribute('#send-btn', 'title') === 'Stop generating',
          'send button shows stop state during generation');
        await page.click('#send-btn'); // abort
        await page.waitForFunction(
          () => document.querySelector('#send-btn span') && document.querySelector('#send-btn span').textContent === 'arrow_upward', null,
          { timeout: 5000 });
        check(true, 'send button restored after abort');
        const emptyAssistant = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.message.assistant')).filter(m => !m.textContent.trim()).length);
        check(emptyAssistant === 0, 'empty assistant placeholder removed after abort');
        check(await page.getAttribute('#send-btn', 'title') === 'Send message',
          'send button title back to send after abort');
        mode = 'fast';
      }, pageDiag(page));
      // --- Test 4: 401 error path — no orphan bubble, can retry ---
      await subtest('401 error path shows no orphan bubble and can retry', async () => {
        await page.evaluate(() => window.newChat()); // clean transcript for the assistant count check
        mode = '401';
        await page.focus('#user-input');
        await page.fill('#user-input', 'Hello');
        await page.press('#user-input', 'Enter');
        // The error path always ends in an error toast — wait for it so the
        // placeholder removal / button restore are guaranteed to have happened.
        await page.waitForSelector('.toast.error', { timeout: 8000 });
        const assistantCount = await page.evaluate(() => document.querySelectorAll('.message.assistant').length);
        check(assistantCount === 0, 'no orphaned assistant bubble on 401');
        check(await page.getAttribute('#send-btn', 'title') === 'Send message', 'send button usable after 401');
        await page.focus('#user-input');
        await page.fill('#user-input', 'Hello again');
        await page.press('#user-input', 'Enter');
        await page.waitForFunction(
          () => document.querySelectorAll('.user-bubble').length === 2, null,
          { timeout: 8000 });
        check(await page.evaluate(() => document.querySelectorAll('.user-bubble').length) === 2,
          'can send again after failure');
        // Wait for the second 401 stream to settle before moving on — a stale in-flight
        // stream would poison the next subtest's send (it would be ignored, leaving the
        // input filled and no bubble). The send button title is the synchronous mirror
        // of isGenerating.
        await idle();
        mode = 'fast';
      });
      // --- Test 10: switching chats mid-generation aborts cleanly ---
      await subtest('switching chats mid-generation aborts cleanly', async () => {
        mode = 'answer-then-hang';
        genCalls = 0;
        await page.evaluate(() => window.newChat()); // fresh transcript so the sidebar entry matches
        await sendAndSettle(page, 'chat A question');
        await page.waitForFunction(
          () => (document.querySelector('.rendered-content') || {}).textContent?.includes('Answer A'), null,
          { timeout: 30000 });
        // Chat B: hang the stream
        await page.click('.new-chat-btn');
        await page.focus('#user-input');
        await page.fill('#user-input', 'chat B question');
        await page.press('#user-input', 'Enter');
        await page.waitForFunction(() => document.getElementById('send-btn')?.getAttribute('title') === 'Stop generating', null, { timeout: 10000 });
        await page.waitForSelector('.typing-indicator', { timeout: 10000 });
        // Switch back to chat A while B is generating — the sidebar
        // refresh is async, so wait for chat A's item to appear first
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('.chat-item')).some(el => el.textContent.includes('chat A question')),
          null, { timeout: 10000 });
        await page.evaluate(() => {
          const item = Array.from(document.querySelectorAll('.chat-item'))
            .find(el => el.textContent.includes('chat A question'));
          if (!item) throw new Error('chat A item not found in sidebar');
          item.click();
        });
        await page.waitForFunction(
          () => (document.getElementById('chat-container')?.textContent || '').includes('Answer A'),
          null, { timeout: 30000 });
        const mainText = await page.textContent('#chat-container');
        check(mainText.includes('Answer A') && !mainText.includes('chat B question'),
          'switched to chat A mid-generation without corruption');
        check(await page.getAttribute('#send-btn', 'title') === 'Send message',
          'generation aborted when switching chats');
        mode = 'fast';
      }, pageDiag(page));
    } finally {
      await page.close();
    }
  });








  scenario('Import sanitization and advanced search', async () => {
    const page = await newPage(() => {});
    try {
      // --- Test 5: XSS via imported chat JSON is sanitized ---
      await subtest('XSS via imported chat JSON is sanitized', async () => {
        await page.evaluate(() => { window.__xss = false; });
        const payload = JSON.stringify({
          title: 'Evil',
          messages: [
            { role: 'user', content: 'hi <img src=x onerror=window.__xss=1>' },
            { role: 'assistant', content: 'result <img src=x onerror=window.__xss=1> <script>window.__xss=1</script>' },
          ],
        });
        await page.setInputFiles('#import-input', { name: 'evil.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
        await page.waitForSelector('.message', { timeout: 8000 });
        check(await page.evaluate(() => window.__xss) === false, 'imported chat XSS payload did not execute');
        check(!(await page.evaluate(() => !!document.querySelector('[onerror]'))), 'no onerror attributes in rendered messages');
      });
      // --- Test 6: XSS via shared-chat URL hash is sanitized ---
      await subtest('XSS via shared-chat URL hash is sanitized', async () => {
        // Sentinel must be in place before the app renders after the reload
        await page.addInitScript(() => { window.__xss = false; });
        const hash = await page.evaluate(() => {
          const data = { title: 'shared', messages: [{ role: 'assistant', content: 'see <img src=x onerror=window.__xss=1>' }] };
          return window.LZString.compressToEncodedURIComponent(JSON.stringify(data));
        });
        // A bare goto(baseUrl + '#hash') is a same-document navigation (no reload,
        // no boot) — reload to actually exercise the shared-chat loader.
        await page.goto(baseUrl + '#shared=' + hash, { waitUntil: 'load' });
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('.message', { timeout: 8000 });
        check(await page.evaluate(() => window.__xss) === false, 'shared chat XSS payload did not execute');
      });
      // --- Test 12: advanced search — result flow via delegation ---
      await subtest('advanced search result flow via delegation', async () => {
        // Import a chat with known content
        const payload = JSON.stringify({ title: 'Searchable chat', messages: [
          { role: 'user', content: 'the quick brown fox' },
          { role: 'assistant', content: 'jumps over the lazy dog' },
        ] });
        await page.setInputFiles('#import-input', { name: 'fox.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
        await page.waitForSelector('.chat-item', { timeout: 8000 });
        await page.click('.search-toggle-btn');
        await page.fill('#search-input', 'quick brown');
        await page.waitForFunction(
          () => document.querySelectorAll('#search-results-content .search-result-item').length > 0, null,
          { timeout: 8000 });
        const resultCount = await page.evaluate(() =>
          document.querySelectorAll('#search-results-content .search-result-item').length);
        check(resultCount === 1, `search found the imported chat (${resultCount} results)`);
        // Expand + open via delegated handlers
        await domClick(page, '#search-results-content [data-action="toggle"]');
        await domClick(page, '#search-results-content [data-action="open"]');
        await page.waitForFunction(
          () => (document.getElementById('chat-container')?.textContent || '').includes('quick brown'), null,
          { timeout: 8000 });
        check((await page.textContent('#chat-container')).includes('quick brown'),
          'clicking Open in search results loads the chat');
      });
    } finally {
      await page.close();
    }
  });




  scenario('Import, delete and themed-dialog flows', async () => {
    const page = await newPage(() => {});
    try {
      // --- Test 15: context menu — delete chat flow ---
      await subtest('context menu delete chat flow', async () => {
        const payload = JSON.stringify({ title: 'Delete me', messages: [{ role: 'user', content: 'bye' }] });
        await page.setInputFiles('#import-input', { name: 'bye.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
        await page.waitForSelector('.chat-item', { timeout: 8000 });
        await domClick(page, '.chat-item:last-child .chat-more-btn');
        await page.waitForFunction(() => document.getElementById('chat-context-menu').classList.contains('active'), null, { timeout: 5000 });
        await domClick(page, '#chat-context-menu .context-item.danger');
        // Themed confirm dialog (replaces window.confirm) — click its Delete button
        await page.waitForFunction(() => !!document.querySelector('.modal-overlay.active #confirm-btn'), null, { timeout: 5000 });
        await domClick(page, '.modal-overlay.active #confirm-btn');
        await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 0, null, { timeout: 8000 });
        check(await page.evaluate(() => document.querySelectorAll('.chat-item').length) === 0,
          'deleting the only chat removes it from the sidebar');
        check(await page.evaluate(() => document.getElementById('main').classList.contains('welcome-mode')),
          'welcome view shown after deleting the active chat');
      });
      // --- Test 17: themed rename/delete dialogs (replaced prompt/confirm) ---
      await subtest('themed rename/delete dialogs', async () => {
        const payload = JSON.stringify({ title: 'Dialog test', messages: [{ role: 'user', content: 'hello' }] });
        await page.setInputFiles('#import-input', { name: 'dialog.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
        await page.waitForSelector('.chat-item', { timeout: 8000 });

        // Rename chat through the themed prompt dialog
        await domClick(page, '.chat-item:last-child .chat-more-btn');
        await domClick(page, '#chat-context-menu .context-item'); // first item = Rename
        await page.waitForFunction(() => !!document.querySelector('.modal-overlay.active input#prompt-modal-input'), null, { timeout: 5000 });
        const prefilled = await page.evaluate(() => document.querySelector('.modal-overlay.active input#prompt-modal-input').value);
        check(prefilled === 'Dialog test', 'rename dialog prefilled with current title');
        await page.fill('.modal-overlay.active input#prompt-modal-input', 'Renamed chat');
        await page.press('.modal-overlay.active input#prompt-modal-input', 'Enter');
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll('.chat-item')).some(el => el.textContent.includes('Renamed chat')), null,
          { timeout: 8000 });
        check(true, 'chat renamed through the themed prompt dialog');

        // Rename a token through the themed prompt dialog
        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="tokens"]');
        await page.fill('#token-name', 'DialogToken');
        await page.fill('#token-value', 'token-value-123');
        await page.click('#add-token-btn');
        await page.waitForSelector('#token-list [data-token-id]', { timeout: 8000 });
        await domClick(page, '#token-list [data-action="edit-name"]');
        await page.waitForFunction(() => !!document.querySelector('.modal-overlay.active input#prompt-modal-input'), null, { timeout: 5000 });
        await page.fill('.modal-overlay.active input#prompt-modal-input', 'DialogToken2');
        await page.press('.modal-overlay.active input#prompt-modal-input', 'Enter');
        await page.waitForFunction(() => (document.querySelector('#token-list')?.textContent || '').includes('DialogToken2'), null, { timeout: 8000 });
        check(true, 'token renamed through the themed prompt dialog');

        // Delete the token through the themed confirm dialog
        await domClick(page, '#token-list [data-action="delete"]');
        await page.waitForFunction(() => !!document.querySelector('.modal-overlay.active #confirm-btn'), null, { timeout: 5000 });
        await domClick(page, '.modal-overlay.active #confirm-btn');
        await page.waitForFunction(() => !document.querySelector('#token-list [data-token-id]'), null, { timeout: 8000 });
        check(true, 'token deleted through the themed confirm dialog');
        await page.click('.settings-close');
      });
      // --- Test 7: token name XSS is escaped ---
      await subtest('token name XSS is escaped', async () => {
        await page.evaluate(() => { window.__xss = false; });
        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="tokens"]');
        await page.fill('#token-name', '<img src=x onerror=window.__xss=1>');
        await page.fill('#token-value', 'some-token-value');
        await page.click('#add-token-btn');
        await page.waitForSelector('#token-list .token-item', { timeout: 8000 });
        check(await page.evaluate(() => window.__xss) !== true, 'token name did not inject markup');
        check(!(await page.evaluate(() => !!document.querySelector('#token-list [onerror]'))),
          'token list contains no onerror handlers');
        await page.click('.settings-close');
      });
    } finally {
      await page.close();
    }
  });


  scenario('Settings save, discard and theme flows', async () => {
    const page = await newPage(() => {});
    try {
      // --- Test 8: save → reopen → close shows NO discard prompt ---
      await subtest('save, reopen, close shows no discard prompt', async () => {
        await seedToken(page);
        // Change a setting and save it
        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="general"]');
        await page.fill('#system-prompt', 'You are a test assistant.');
        await page.click('.settings-footer .btn.primary'); // Save
        await page.waitForFunction(() => !document.getElementById('settings-modal').classList.contains('active'), null, { timeout: 5000 });
        check(!(await page.evaluate(() => document.getElementById('settings-modal').classList.contains('active'))),
          'settings closed after save');
        // Reopen and close with no further changes: must NOT ask to discard
        await page.click('button.settings-row');
        await sleep(200);
        await page.click('.settings-close'); // ×
        await sleep(200);
        check(!(await page.evaluate(() => document.getElementById('settings-confirm-modal').classList.contains('active'))),
          'no discard prompt after save + close (originalSettings baseline fix)');
      });
      // --- Test 9: unsaved changes DO prompt, discard closes both ---
      await subtest('unsaved changes prompt, discard closes both', async () => {
        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="general"]');
        await page.fill('#system-prompt', 'Changed prompt');
        await page.click('.settings-close'); // ×
        await sleep(200);
        check(await page.evaluate(() => document.getElementById('settings-confirm-modal').classList.contains('active')),
          'discard prompt shown with unsaved changes');
        await domClick(page, '#settings-confirm-modal .btn.danger'); // Discard
        await sleep(200);
        check(!(await page.evaluate(() => document.getElementById('settings-modal').classList.contains('active'))),
          'discard closes both modals');
      });
      // --- Test 16: dark theme applies and swaps back ---
      await subtest('dark theme applies and swaps back', async () => {
        await page.click('button.settings-row');
        await page.click('.settings-tab[data-tab="appearance"]');
        await domClick(page, '[data-theme-card="dark"]');
        await sleep(200);
        const darkBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim());
        check(darkBg === '#151518', `dark theme applied (--bg-primary=${darkBg})`);
        await domClick(page, '[data-theme-card="light"]');
        await sleep(200);
        const lightBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim());
        check(lightBg === '#ffffff', `light theme restored (--bg-primary=${lightBg})`);
      });
    } finally {
      await page.close();
    }
  });




















  // Optional scenario selection: --only takes a comma-separated list of
  // 1-based indices and/or case-insensitive name substrings, e.g.
  //   --only 11                     (just "Generation flows …", index 11)
  //   --only theme                  (every scenario whose name contains "theme")
  //   --only 11,"chat list"          (indices and substrings mix freely)
  const ONLY = argValue('only');
  if (ONLY) {
    const terms = ONLY.split(',').map(s => s.trim()).filter(Boolean);
    const selected = scenarios.filter((s, i) => terms.some(term => {
      if (/^\d+$/.test(term)) return i + 1 === Number(term);
      return s.name.toLowerCase().includes(term.toLowerCase());
    }));
    if (!selected.length) {
      console.error(`[verify-edge-cases] --only matched no scenarios. Available:`);
      scenarios.forEach((s, i) => console.error(`  ${i + 1}. ${s.name}`));
      process.exit(1);
    }
    scenarios.length = 0;
    scenarios.push(...selected);
    console.log(`[verify-edge-cases] --only: running ${scenarios.length} of the full suite:\n  - ${scenarios.map(s => s.name).join('\n  - ')}`);
  }
  // Run scenarios concurrently; each gets its own store for output and
  // console/page error attribution. EDGE_CONCURRENCY=1 forces sequential.
  const defaultConcurrency = Math.min(6, Math.max(4, Math.floor((os.availableParallelism?.() || os.cpus().length) * 1.5)));
  const CONCURRENCY = Math.max(1, parseInt(process.env.EDGE_CONCURRENCY || String(defaultConcurrency), 10) || defaultConcurrency);
  console.log(`[verify-edge-cases] running ${scenarios.length} scenario(s), concurrency ${CONCURRENCY}`);
  const results = new Array(scenarios.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= scenarios.length) break;
      const store = { name: scenarios[i].name, lines: [], failures: 0, consoleErrors: [], pageErrors: [] };
      const t0 = Date.now();
      try {
        await als.run(store, scenarios[i].fn);
      } catch (e) {
        store.lines.push(`  FAIL exception: ${e && e.message ? e.message : e}`);
        store.failures++;
      }
      store.ms = Date.now() - t0;
      results[i] = store;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenarios.length) }, worker));

  for (const r of results) {
    console.log(`${r.failures === 0 ? 'PASS' : 'FAIL'} ${r.name}  (${((r.ms || 0) / 1000).toFixed(1)}s)`);
    for (const line of r.lines) console.log(line);
    failures += r.failures;
    consoleErrors.push(...r.consoleErrors);
    pageErrors.push(...r.pageErrors);
  }

  await browser.close();

  // Any console/page error fails the whole run. Resource 401s are expected:
  // every API scenario mocks api.puter.com with a fake token, which the
  // browser logs as a console error — not an app bug.
  const unexpectedConsoleErrors = consoleErrors.filter(
    e => e !== 'Failed to load resource: the server responded with a status of 401 (Unauthorized)');
  if (unexpectedConsoleErrors.length) {
    console.error('[verify-edge-cases] console errors:\n  ' + unexpectedConsoleErrors.join('\n  '));
    failures++;
  }
  if (pageErrors.length) {
    console.error('[verify-edge-cases] page errors:\n  ' + pageErrors.join('\n  '));
    failures++;
  }

  if (server) await new Promise(r => server.close(r));
  console.log(failures === 0
    ? `[verify-edge-cases] PASS (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
    : `[verify-edge-cases] FAIL (${failures} problem(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('[verify-edge-cases] FAILED:', e); process.exit(1); });
