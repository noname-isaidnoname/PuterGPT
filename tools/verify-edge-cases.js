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
// run concurrently — set EDGE_CONCURRENCY=1 to force sequential output.
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
  const newPage = async (route) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') trackConsoleError(m.text()); });
    page.on('pageerror', e => { trackPageError(String(e)); });
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

  // Seed a fake token via the settings UI
  const seedToken = async (page) => {
    await page.click('button.settings-row');
    await page.click('.settings-tab[data-tab="tokens"]');
    await page.fill('#token-name', 'Test Token');
    await page.fill('#token-value', 'fake-token-for-ui-test');
    await page.click('#add-token-btn');
    await sleep(300);
    await page.click('.settings-footer .btn.primary'); // Save
    await sleep(200);
  };

  // DOM click (works for non-interactive elements, unlike hit-tested clicks)
  const domClick = (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) throw new Error('no element: ' + s);
    el.click();
    return true;
  }, sel);

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
  const CONCURRENCY = Math.max(1, parseInt(process.env.EDGE_CONCURRENCY || '4', 10) || 4);
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
