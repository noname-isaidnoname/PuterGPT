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
// Scenarios are independent (each gets a fresh browser context), so they are
// run concurrently — adaptive default 4–6, EDGE_CONCURRENCY=1 for sequential.
// Runs on Playwright only (lightpanda has no route interception).
//
// Usage: node tools/verify-edge-cases.js [--base-url URL] [--screenshot-dir DIR]
// Exits non-zero on any failed check, console error or page error.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');
const { startStaticServer, loadPlaywright, launchBrowser, sleep } = require('./lib.js');

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

  // Fresh page (fresh context) per scenario; route interception mocks the
  // Puter API. The models/details endpoint is mocked too so boots don't hit
  // the network. page.close() also closes the context.
  const newPage = async (route, init, allowServiceWorkers = false) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
      serviceWorkers: allowServiceWorkers ? 'allow' : 'block',
    });
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
      () => document.getElementById('main') && document.getElementById('main').classList.contains('welcome-mode'),
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

  // DOM click (works for non-interactive elements, unlike hit-tested clicks)
  const domClick = (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) throw new Error('no element: ' + s);
    el.click();
    return true;
  }, sel);

  scenario('Quota failures preserve imported and shared chats for backup', async () => {
    const page = await newPage();
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Quota failure rolls back custom-theme deletion', async () => {
    const page = await newPage();
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Share uses native mobile sheet and falls back safely', async () => {
    const page = await newPage(null, () => {
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
    });
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Native dialog guard returns safe defaults and async helpers settle', async () => {
    const page = await newPage();
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Modal focus, theme keyboard access and reduced motion', async () => {
    const page = await newPage();
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Keyboard shortcuts respect focus and export the active chat', async () => {
    const page = await newPage();
    try {
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

  scenario('Switching an earlier response requires confirmation', async () => {
    const page = await newPage();
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Aborting variant regeneration preserves the original', async () => {
    let calls = 0;
    const page = await newPage(async route => {
      calls++;
      if (calls === 1) await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_ANSWER_A });
      else await new Promise(() => {});
    });
    try {
      await seedToken(page);
      await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).db.settings.put({ key: 'auto_name_chats', value: false }));
      await page.click('button.settings-row');
      await page.click('.settings-tab[data-tab="general"]');
      await domClick(page, '#enable-variants');
      await page.click('.settings-footer .btn.primary');
      await page.fill('#user-input', 'Hello');
      await page.press('#user-input', 'Enter');
      await page.waitForSelector('.regenerate');
      await domClick(page, '.regenerate');
      await page.waitForSelector('.typing-indicator');
      await page.click('#send-btn');
      await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('Answer A'));
      check(await page.locator('.variant-switcher').count() === 0, 'Abort restores the original without an empty variant');
    } finally {
      await page.close();
    }
  });

  scenario('Response variants regenerate, switch and truncate on earlier edit', async () => {
    let calls = 0;
    const page = await newPage(async route => {
      calls++;
      const text = calls === 1 ? 'First answer' : calls === 2 ? 'Second answer' : 'Edited answer';
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'text', text }) + '\n' });
    });
    try {
      await seedToken(page);
      await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).db.settings.put({ key: 'auto_name_chats', value: false }));
      await page.click('button.settings-row');
      await page.click('.settings-tab[data-tab="general"]');
      await domClick(page, '#enable-variants');
      await page.click('.settings-footer .btn.primary');
      await page.fill('#user-input', 'Original question');
      await page.press('#user-input', 'Enter');
      await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('First answer'));
      await page.waitForSelector('.regenerate');
      await domClick(page, '.regenerate');
      await page.waitForFunction(() => document.querySelector('.message.assistant .rendered-content')?.textContent.includes('Second answer'));
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
      check(await page.locator('.variant-switcher').count() === 0, 'Editing earlier prompt and regenerating discards its old response branch');
      check(calls === 3, 'Exactly three completions were requested');
    } finally {
      await page.close();
    }
  });

  scenario('Voice input uses speech recognition when available', async () => {
    const page = await newPage(null, () => {
      window.SpeechRecognition = class {
        constructor() { window.testRecognition = this; }
        start() {}
        stop() { this.onend(); }
      };
    });
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Generation parameters follow the chat and request', async () => {
    let requestArgs;
    const page = await newPage(async route => {
      requestArgs = route.request().postDataJSON().args;
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_OK });
    });
    try {
      await seedToken(page);
      await page.evaluate(async () => (await import('./js/indexeddb-storage.js')).db.settings.put({ key: 'auto_name_chats', value: false }));
      await page.click('button.settings-row');
      await page.click('.settings-tab[data-tab="model"]');
      await page.fill('#chat-temperature', '0.4');
      await page.locator('#chat-temperature').dispatchEvent('change');
      await page.fill('#chat-max-tokens', '256');
      await page.locator('#chat-max-tokens').dispatchEvent('change');
      await page.click('.settings-footer .btn.primary');
      await page.fill('#user-input', 'Parameter test');
      await page.press('#user-input', 'Enter');
      await page.waitForSelector('.message-cost');
      check(requestArgs.temperature === 0.4 && requestArgs.max_tokens === 256, 'Request includes configured Puter parameters');
      await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 1);
      const chatId = await page.locator('.chat-item').first().getAttribute('data-id');
      await page.evaluate(() => window.newChat());
      check(await page.inputValue('#chat-temperature') === '' && await page.inputValue('#chat-max-tokens') === '', 'New chat uses model defaults');
      await page.evaluate(id => window.loadChat(id), chatId);
      check(await page.inputValue('#chat-temperature') === '0.4' && await page.inputValue('#chat-max-tokens') === '256', 'Loading chat restores its parameters');
      await page.click('button.settings-row');
      await page.click('.settings-tab[data-tab="model"]');
      await page.click('#reset-generation-params');
      check(await page.inputValue('#chat-temperature') === '' && await page.inputValue('#chat-max-tokens') === '', 'Reset clears both parameters');
    } finally {
      await page.close();
    }
  });

  scenario('Sidebar pin and filtering preserve chat metadata', async () => {
    const page = await newPage();
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Auto-title runs once on a new chat', async () => {
    let titleCalls = 0;
    const page = await newPage(async route => {
      const body = route.request().postDataJSON();
      const isTitle = body.args.messages[0].content.includes('at most six words');
      if (isTitle) titleCalls++;
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson',
        body: isTitle ? '{"type":"text","text":"A Helpful Title"}\n' : NDJSON_OK });
    });
    try {
      await seedToken(page);
      await page.fill('#user-input', 'Hello');
      await page.press('#user-input', 'Enter');
      await page.waitForFunction(() => document.querySelector('.chat-title')?.textContent === 'A Helpful Title', null, { timeout: 10000 });
      check(titleCalls === 1, `One title completion generated after first answer (got ${titleCalls})`);
    } finally {
      await page.close();
    }
  });

  scenario('Backup restores conflicts and excludes tokens by default', async () => {
    const page = await newPage();
    try {
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
      check(result.chats.length === 2 && result.chats.some(chat => chat.title === 'Imported (imported)'), 'Rename retains both chats');
      check(result.invalidRejected, 'Invalid theme IDs rejected');
    } finally {
      await page.close();
    }
  });

  scenario('Markdown export preserves content and print hides app chrome', async () => {
    const page = await newPage();
    try {
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
    } finally {
      await page.close();
    }
  });

  scenario('Test 1: user bubble sizes to content (reported bug)', async () => {
    const page = await newPage(() => {});
    await seedToken(page);
    await page.fill('#user-input', 'Hello');
    await page.press('#user-input', 'Enter');
    await page.waitForSelector('.user-bubble');
    const box = await page.locator('.user-bubble').first().boundingBox();
    check(box && box.width > 60 && box.height < 80,
      `user bubble sizes to content (got ${box ? Math.round(box.width) : 0}x${box ? Math.round(box.height) : 0})`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'edge-cases-bubble.png') });
    await page.close();
  });

  scenario('Test 2: successful stream renders + cost badge', async () => {
    const page = await newPage(async route => {
      await sleep(50);
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_OK });
    });
    await seedToken(page);
    await page.fill('#user-input', 'Hello');
    await page.press('#user-input', 'Enter');
    await page.waitForFunction(
      () => (document.querySelector('.rendered-content') || {}).textContent?.includes('Hi there'),
      { timeout: 10000 });
    check(true, 'assistant streamed content rendered');
    await page.waitForSelector('.message-cost', { timeout: 10000 });
    check(true, 'cost badge rendered after completion');
    check(await page.getAttribute('#send-btn', 'title') === 'Send message', 'send button back to send state after completion');
    await page.close();
  });

  scenario('Test 3: stop button aborts, no stuck state', async () => {
    const page = await newPage(() => new Promise(() => {})); // hang forever
    await seedToken(page);
    await page.fill('#user-input', 'Hello');
    await page.press('#user-input', 'Enter');
    await page.waitForSelector('.typing-indicator', { timeout: 5000 });
    check(await page.getAttribute('#send-btn', 'title') === 'Stop generating',
      'send button shows stop state during generation');
    await page.click('#send-btn'); // abort
    await page.waitForFunction(
      () => document.querySelector('#send-btn span') && document.querySelector('#send-btn span').textContent === 'arrow_upward',
      { timeout: 5000 });
    check(true, 'send button restored after abort');
    const emptyAssistant = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.message.assistant')).filter(m => !m.textContent.trim()).length);
    check(emptyAssistant === 0, 'empty assistant placeholder removed after abort');
    check(await page.getAttribute('#send-btn', 'title') === 'Send message',
      'send button title back to send after abort');
    await page.close();
  });

  scenario('Test 4: 401 error path — no orphan bubble, can retry', async () => {
    const page = await newPage(async route =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"token_auth_failed"}' }));
    await seedToken(page);
    await page.fill('#user-input', 'Hello');
    await page.press('#user-input', 'Enter');
    // The error path always ends in an error toast — wait for it so the
    // placeholder removal / button restore are guaranteed to have happened.
    await page.waitForSelector('.toast.error', { timeout: 8000 });
    // Wait until the failed generation settles (button flips back to send)
    await page.waitForFunction(
      () => document.getElementById('send-btn')?.getAttribute('title') === 'Send message',
      { timeout: 5000 });
    const assistantCount = await page.evaluate(() => document.querySelectorAll('.message.assistant').length);
    check(assistantCount === 0, 'no orphaned assistant bubble on 401');
    check(await page.getAttribute('#send-btn', 'title') === 'Send message', 'send button usable after 401');
    await page.fill('#user-input', 'Hello again');
    await page.press('#user-input', 'Enter');
    await page.waitForFunction(
      () => document.querySelectorAll('.user-bubble').length === 2,
      { timeout: 8000 });
    check(await page.evaluate(() => document.querySelectorAll('.user-bubble').length) === 2,
      'can send again after failure');
    await page.close();
  });

  scenario('Test 5: XSS via imported chat JSON is sanitized', async () => {
    const page = await newPage(() => {});
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
    await page.close();
  });

  scenario('Test 6: XSS via shared-chat URL hash is sanitized', async () => {
    const page = await newPage(() => {});
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
    await page.close();
  });

  scenario('Test 7: token name XSS is escaped', async () => {
    const page = await newPage(() => {});
    await page.click('button.settings-row');
    await page.click('.settings-tab[data-tab="tokens"]');
    await page.fill('#token-name', '<img src=x onerror=window.__xss=1>');
    await page.fill('#token-value', 'some-token-value');
    await page.click('#add-token-btn');
    await page.waitForSelector('#token-list .token-item', { timeout: 8000 });
    check(await page.evaluate(() => window.__xss) !== true, 'token name did not inject markup');
    check(!(await page.evaluate(() => !!document.querySelector('#token-list [onerror]'))),
      'token list contains no onerror handlers');
    await page.close();
  });

  scenario('Test 8: save → reopen → close shows NO discard prompt', async () => {
    const page = await newPage(() => {});
    await seedToken(page);
    // Change a setting and save it
    await page.click('button.settings-row');
    await page.click('.settings-tab[data-tab="general"]');
    await page.fill('#system-prompt', 'You are a test assistant.');
    await page.click('.settings-footer .btn.primary'); // Save
    await page.waitForFunction(() => !document.getElementById('settings-modal').classList.contains('active'), { timeout: 5000 });
    check(!(await page.evaluate(() => document.getElementById('settings-modal').classList.contains('active'))),
      'settings closed after save');
    // Reopen and close with no further changes: must NOT ask to discard
    await page.click('button.settings-row');
    await sleep(200);
    await page.click('.settings-close'); // ×
    await sleep(200);
    check(!(await page.evaluate(() => document.getElementById('settings-confirm-modal').classList.contains('active'))),
      'no discard prompt after save + close (originalSettings baseline fix)');
    await page.close();
  });

  scenario('Test 9: unsaved changes DO prompt, discard closes both', async () => {
    const page = await newPage(() => {});
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
    await page.close();
  });

  scenario('Test 10: switching chats mid-generation aborts cleanly', async () => {
    let callCount = 0;
    const page = await newPage(route => {
      callCount++;
      if (callCount === 1) return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_ANSWER_A });
      return new Promise(() => {}); // hang
    });
    await seedToken(page);
    await page.fill('#user-input', 'chat A question');
    await page.press('#user-input', 'Enter');
    await page.waitForFunction(
      () => (document.querySelector('.rendered-content') || {}).textContent?.includes('Answer A'),
      { timeout: 10000 });
    // Chat B: hang the stream
    await page.click('.new-chat-btn');
    await page.fill('#user-input', 'chat B question');
    await page.press('#user-input', 'Enter');
    await page.waitForSelector('.typing-indicator', { timeout: 5000 });
    // Switch back to chat A while B is generating
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.chat-item'))
        .find(el => el.textContent.includes('chat A question'));
      if (!item) throw new Error('chat A item not found in sidebar');
      item.click();
    });
    await page.waitForFunction(
      () => (document.getElementById('chat-container')?.textContent || '').includes('Answer A'),
      { timeout: 8000 });
    const mainText = await page.textContent('#chat-container');
    check(mainText.includes('Answer A') && !mainText.includes('chat B question'),
      'switched to chat A mid-generation without corruption');
    check(await page.getAttribute('#send-btn', 'title') === 'Send message',
      'generation aborted when switching chats');
    await page.close();
  });

  scenario('Test 11: zero console errors across a full cycle', async () => {
    // Own-scenario console errors only (scenarios run concurrently)
    const store = () => als.getStore();
    const page = await newPage(async route => route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_OK }));
    await seedToken(page);
    await page.fill('#user-input', 'hello');
    await page.press('#user-input', 'Enter');
    // Wait for the stream to complete (content rendered), not just for the
    // send-button title, which starts as 'Send message' before Enter lands.
    await page.waitForFunction(
      () => (document.querySelector('.rendered-content')?.textContent || '').includes('Hi there')
        && document.getElementById('send-btn')?.getAttribute('title') === 'Send message',
      { timeout: 10000 });
    const fresh = (store()?.consoleErrors || []).filter(e => !e.includes('401') && !e.includes('net::'));
    check(fresh.length === 0, `zero console errors during seed → send cycle${fresh.length ? ' (got: ' + fresh.join(' | ') + ')' : ''}`);
    await page.close();
  });

  scenario('Test 12: advanced search — result flow via delegation', async () => {
    const page = await newPage(() => {});
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
      () => document.querySelectorAll('#search-results-content .search-result-item').length > 0,
      { timeout: 8000 });
    const resultCount = await page.evaluate(() =>
      document.querySelectorAll('#search-results-content .search-result-item').length);
    check(resultCount === 1, `search found the imported chat (${resultCount} results)`);
    // Expand + open via delegated handlers
    await domClick(page, '#search-results-content [data-action="toggle"]');
    await domClick(page, '#search-results-content [data-action="open"]');
    await page.waitForFunction(
      () => (document.getElementById('chat-container')?.textContent || '').includes('quick brown'),
      { timeout: 8000 });
    check((await page.textContent('#chat-container')).includes('quick brown'),
      'clicking Open in search results loads the chat');
    await page.close();
  });

  scenario('Test 13: theme generation end-to-end (button id, modal)', async () => {
    const themeJson = JSON.stringify({
      name: 'Test Sea', icon: '🌊', description: 'A test theme',
      cssVars: { '--accent': '#006680', '--bg-primary': '#f0fbfd' },
    });
    const apiResponse = JSON.stringify({ result: { message: { content: themeJson } } });
    const page = await newPage(async route => route.fulfill({ status: 200, contentType: 'application/json', body: apiResponse }));
    await page.evaluate(() => { window.openThemeGenerator(); });
    await page.waitForFunction(() => document.getElementById('theme-generator-modal')?.classList.contains('active'), { timeout: 5000 });
    await page.fill('#theme-prompt', 'ocean');
    const modelOptions = await page.evaluate(() => document.querySelectorAll('#theme-model-select option').length);
    check(modelOptions > 0, `theme model dropdown populated (${modelOptions} options)`);
    await page.click('#generate-theme-btn');
    await page.waitForFunction(
      () => document.getElementById('theme-generator-modal') &&
           !document.getElementById('theme-generator-modal').classList.contains('active'),
      { timeout: 10000 });
    const accent = await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'));
    check(accent.trim() === '#006680', `generated theme applied (--accent=${accent.trim() || '(unset)'})`);
    await page.close();
  });

  scenario('Test 14: code block Copy button does not error', async () => {
    const page = await newPage(async route => route.fulfill({
      status: 200, contentType: 'application/x-ndjson',
      body: '{"type":"text","text":"```js\\nconsole.log(1+1)\\n```"}\n',
    }));
    await seedToken(page);
    await page.fill('#user-input', 'give me code');
    await page.press('#user-input', 'Enter');
    await page.waitForSelector('.code-block-header', { timeout: 10000 });
    await page.click('.code-block-header .copy-btn');
    await sleep(300);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(copied.includes('console.log(1+1)'), 'code block copy button copies code to clipboard');
    await page.close();
  });

  scenario('Test 15: context menu — delete chat flow', async () => {
    const page = await newPage(() => {});
    const payload = JSON.stringify({ title: 'Delete me', messages: [{ role: 'user', content: 'bye' }] });
    await page.setInputFiles('#import-input', { name: 'bye.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
    await page.waitForSelector('.chat-item', { timeout: 8000 });
    await domClick(page, '.chat-item:last-child .chat-more-btn');
    await page.waitForFunction(() => document.getElementById('chat-context-menu').classList.contains('active'), { timeout: 5000 });
    await domClick(page, '#chat-context-menu .context-item.danger');
    // Themed confirm dialog (replaces window.confirm) — click its Delete button
    await page.waitForFunction(() => !!document.querySelector('.modal-overlay.active #confirm-btn'), { timeout: 5000 });
    await domClick(page, '.modal-overlay.active #confirm-btn');
    await page.waitForFunction(() => document.querySelectorAll('.chat-item').length === 0, { timeout: 8000 });
    check(await page.evaluate(() => document.querySelectorAll('.chat-item').length) === 0,
      'deleting the only chat removes it from the sidebar');
    check(await page.evaluate(() => document.getElementById('main').classList.contains('welcome-mode')),
      'welcome view shown after deleting the active chat');
    await page.close();
  });

  scenario('Test 16: dark theme applies and swaps back', async () => {
    const page = await newPage(() => {});
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
    await page.close();
  });

  scenario('Test 17: themed rename/delete dialogs (replaced prompt/confirm)', async () => {
    const page = await newPage(() => {});
    const payload = JSON.stringify({ title: 'Dialog test', messages: [{ role: 'user', content: 'hello' }] });
    await page.setInputFiles('#import-input', { name: 'dialog.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
    await page.waitForSelector('.chat-item', { timeout: 8000 });

    // Rename chat through the themed prompt dialog
    await domClick(page, '.chat-item:last-child .chat-more-btn');
    await domClick(page, '#chat-context-menu .context-item'); // first item = Rename
    await page.waitForFunction(() => !!document.querySelector('.modal-overlay.active input#prompt-modal-input'), { timeout: 5000 });
    const prefilled = await page.evaluate(() => document.querySelector('.modal-overlay.active input#prompt-modal-input').value);
    check(prefilled === 'Dialog test', 'rename dialog prefilled with current title');
    await page.fill('.modal-overlay.active input#prompt-modal-input', 'Renamed chat');
    await page.press('.modal-overlay.active input#prompt-modal-input', 'Enter');
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.chat-item')).some(el => el.textContent.includes('Renamed chat')),
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
    await page.waitForFunction(() => !!document.querySelector('.modal-overlay.active input#prompt-modal-input'), { timeout: 5000 });
    await page.fill('.modal-overlay.active input#prompt-modal-input', 'DialogToken2');
    await page.press('.modal-overlay.active input#prompt-modal-input', 'Enter');
    await page.waitForFunction(() => (document.querySelector('#token-list')?.textContent || '').includes('DialogToken2'), { timeout: 8000 });
    check(true, 'token renamed through the themed prompt dialog');

    // Delete the token through the themed confirm dialog
    await domClick(page, '#token-list [data-action="delete"]');
    await page.waitForFunction(() => !!document.querySelector('.modal-overlay.active #confirm-btn'), { timeout: 5000 });
    await domClick(page, '.modal-overlay.active #confirm-btn');
    await page.waitForFunction(() => !document.querySelector('#token-list [data-token-id]'), { timeout: 8000 });
    check(true, 'token deleted through the themed confirm dialog');

    await page.close();
  });

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
      try {
        await als.run(store, scenarios[i].fn);
      } catch (e) {
        store.lines.push(`  FAIL exception: ${e && e.message ? e.message : e}`);
        store.failures++;
      }
      results[i] = store;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenarios.length) }, worker));

  for (const r of results) {
    console.log(`${r.failures === 0 ? 'PASS' : 'FAIL'} ${r.name}`);
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
