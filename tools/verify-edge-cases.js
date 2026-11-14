#!/usr/bin/env node
// verify-edge-cases — exercises PuterGPT's failure paths and the implicit
// state machines around AI generation, settings discard tracking, search and
// theme generation.
//
// Unlike the other harnesses this one mocks `api.puter.com/drivers/call`
// through Playwright request routing, so it never depends on the network.
// Runs on Playwright only (lightpanda has no route interception).
//
// Usage: node tools/verify-edge-cases.js [--base-url URL] [--screenshot-dir DIR]
// Exits non-zero on any failed check, console error or page error.

const path = require('path');
const fs = require('fs');
const os = require('os');
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
  let failures = 0;
  const consoleErrors = [];
  const pageErrors = [];
  const check = (cond, label) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`);
    if (!cond) failures++;
  };

  // Fresh page per scenario; route interception mocks the Puter API.
  const newPage = async (route) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => { pageErrors.push(String(e)); });
    if (route) await page.route('**/drivers/call', route);
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.getElementById('main') && document.getElementById('main').classList.contains('welcome-mode'),
      { timeout: 20000 });
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

  // ---------- Test 1: user bubble sizes to content (reported bug) ----------
  {
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
  }

  // ---------- Test 2: successful stream renders + cost badge ----------
  {
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
  }

  // ---------- Test 3: stop button aborts, no stuck state ----------
  {
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
  }

  // ---------- Test 4: 401 error path — no orphan bubble, can retry ----------
  {
    const page = await newPage(async route =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"token_auth_failed"}' }));
    await seedToken(page);
    await page.fill('#user-input', 'Hello');
    await page.press('#user-input', 'Enter');
    await sleep(1500);
    const assistantCount = await page.evaluate(() => document.querySelectorAll('.message.assistant').length);
    check(assistantCount === 0, 'no orphaned assistant bubble on 401');
    check(await page.getAttribute('#send-btn', 'title') === 'Send message', 'send button usable after 401');
    await page.fill('#user-input', 'Hello again');
    await page.press('#user-input', 'Enter');
    await sleep(800);
    check(await page.evaluate(() => document.querySelectorAll('.user-bubble').length) === 2,
      'can send again after failure');
    await page.close();
  }

  // ---------- Test 5: XSS via imported chat JSON is sanitized ----------
  {
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
    await sleep(800);
    check(await page.evaluate(() => window.__xss) === false, 'imported chat XSS payload did not execute');
    check(!(await page.evaluate(() => !!document.querySelector('[onerror]'))), 'no onerror attributes in rendered messages');
    await page.close();
  }

  // ---------- Test 6: XSS via shared-chat URL hash is sanitized ----------
  {
    const page = await newPage(() => {});
    const hash = await page.evaluate(() => {
      window.__xss = false;
      const data = { title: 'shared', messages: [{ role: 'assistant', content: 'see <img src=x onerror=window.__xss=1>' }] };
      return window.LZString.compressToEncodedURIComponent(JSON.stringify(data));
    });
    await page.goto(baseUrl + '#shared=' + hash, { waitUntil: 'load' });
    await sleep(1500);
    check(await page.evaluate(() => window.__xss) === false, 'shared chat XSS payload did not execute');
    await page.close();
  }

  // ---------- Test 7: token name XSS is escaped ----------
  {
    const page = await newPage(() => {});
    await page.click('button.settings-row');
    await page.click('.settings-tab[data-tab="tokens"]');
    await page.fill('#token-name', '<img src=x onerror=window.__xss=1>');
    await page.fill('#token-value', 'some-token-value');
    await page.click('#add-token-btn');
    await sleep(400);
    check(await page.evaluate(() => window.__xss) !== true, 'token name did not inject markup');
    check(!(await page.evaluate(() => !!document.querySelector('#token-list [onerror]'))),
      'token list contains no onerror handlers');
    await page.close();
  }

  // ---------- Test 8: save → reopen → close shows NO discard prompt ----------
  {
    const page = await newPage(() => {});
    await seedToken(page);
    // Change a setting and save it
    await page.click('button.settings-row');
    await page.click('.settings-tab[data-tab="general"]');
    await page.fill('#system-prompt', 'You are a test assistant.');
    await page.click('.settings-footer .btn.primary'); // Save
    await sleep(200);
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
  }

  // ---------- Test 9: unsaved changes DO prompt, discard closes both ----------
  {
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
  }

  // ---------- Test 10: switching chats mid-generation aborts cleanly ----------
  {
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
    await sleep(500);
    const mainText = await page.textContent('#chat-container');
    check(mainText.includes('Answer A') && !mainText.includes('chat B question'),
      'switched to chat A mid-generation without corruption');
    check(await page.getAttribute('#send-btn', 'title') === 'Send message',
      'generation aborted when switching chats');
    await page.close();
  }

  // ---------- Test 11: zero console errors across a full cycle ----------
  {
    const before = consoleErrors.length;
    const page = await newPage(async route => route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: NDJSON_OK }));
    await seedToken(page);
    await page.fill('#user-input', 'hello');
    await page.press('#user-input', 'Enter');
    await sleep(1500);
    const fresh = consoleErrors.slice(before).filter(e => !e.includes('401') && !e.includes('net::'));
    check(fresh.length === 0, `zero console errors during seed → send cycle${fresh.length ? ' (got: ' + fresh.join(' | ') + ')' : ''}`);
    await page.close();
  }

  // ---------- Test 12: advanced search — result flow via delegation ----------
  {
    const page = await newPage(() => {});
    // Import a chat with known content
    const payload = JSON.stringify({ title: 'Searchable chat', messages: [
      { role: 'user', content: 'the quick brown fox' },
      { role: 'assistant', content: 'jumps over the lazy dog' },
    ] });
    await page.setInputFiles('#import-input', { name: 'fox.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
    await sleep(800);
    await page.click('.search-toggle-btn');
    await sleep(300);
    await page.fill('#search-input', 'quick brown');
    await sleep(600);
    const resultCount = await page.evaluate(() =>
      document.querySelectorAll('#search-results-content .search-result-item').length);
    check(resultCount === 1, `search found the imported chat (${resultCount} results)`);
    // Expand + open via delegated handlers
    await domClick(page, '#search-results-content [data-action="toggle"]');
    await domClick(page, '#search-results-content [data-action="open"]');
    await sleep(500);
    check((await page.textContent('#chat-container')).includes('quick brown'),
      'clicking Open in search results loads the chat');
    await page.close();
  }

  // ---------- Test 13: theme generation end-to-end (button id, modal) ----------
  {
    const themeJson = JSON.stringify({
      name: 'Test Sea', icon: '🌊', description: 'A test theme',
      cssVars: { '--accent': '#006680', '--bg-primary': '#f0fbfd' },
    });
    const apiResponse = JSON.stringify({ result: { message: { content: themeJson } } });
    const page = await newPage(async route => route.fulfill({ status: 200, contentType: 'application/json', body: apiResponse }));
    await page.evaluate(() => { window.openThemeGenerator(); });
    await sleep(300);
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
  }

  // ---------- Test 14: code block Copy button does not error ----------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => { pageErrors.push(String(e)); });
    await page.route('**/drivers/call', async route => route.fulfill({
      status: 200, contentType: 'application/x-ndjson',
      body: '{"type":"text","text":"```js\\nconsole.log(1+1)\\n```"}\n',
    }));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('main')?.classList.contains('welcome-mode'), { timeout: 20000 });
    await seedToken(page);
    await page.fill('#user-input', 'give me code');
    await page.press('#user-input', 'Enter');
    await page.waitForSelector('.code-block-header', { timeout: 10000 });
    await page.click('.code-block-header .copy-btn');
    await sleep(300);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(copied.includes('console.log(1+1)'), 'code block copy button copies code to clipboard');
    await page.close();
  }

  // ---------- Test 15: context menu — delete chat flow ----------
  {
    const page = await newPage(() => {});
    await page.evaluate(() => { window.confirm = () => true; }); // auto-confirm the native dialog
    const payload = JSON.stringify({ title: 'Delete me', messages: [{ role: 'user', content: 'bye' }] });
    await page.setInputFiles('#import-input', { name: 'bye.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
    await sleep(800);
    await domClick(page, '.chat-item:last-child .chat-more-btn');
    await page.waitForFunction(() => document.getElementById('chat-context-menu').classList.contains('active'), { timeout: 5000 });
    await domClick(page, '#chat-context-menu .context-item.danger');
    await sleep(500);
    const items = await page.evaluate(() => document.querySelectorAll('.chat-item').length);
    check(items === 0, 'deleting the only chat removes it from the sidebar');
    check(await page.evaluate(() => document.getElementById('main').classList.contains('welcome-mode')),
      'welcome view shown after deleting the active chat');
    await page.close();
  }

  // ---------- Test 16: dark theme applies and swaps back ----------
  {
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
  console.log(failures === 0 ? '[verify-edge-cases] PASS' : `[verify-edge-cases] FAIL (${failures} problem(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('[verify-edge-cases] FAILED:', e); process.exit(1); });
