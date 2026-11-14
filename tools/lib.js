#!/usr/bin/env node
// Shared harness for the verification scripts in tools/.
// No app dependencies; the page is driven through a small backend-agnostic
// adapter API. Two backends are supported:
//
//   lightpanda  — spawns `lightpanda serve` and speaks raw CDP over its
//                 WebSocket (Node >= 21). Fast, zero install besides the
//                 lightpanda binary. No screenshots (no graphical engine).
//   playwright  — uses Playwright's chromium (local/global/`npm root -g`).
//                 Slower, but supports screenshots.
//
// Backend is chosen with --backend <name> / BACKEND, or auto-detected:
// lightpanda if the binary is on PATH/in ~/.local/bin, else playwright.
//
// Adapter API (identical on both backends):
//   page.goto(url)                 navigate and wait for load
//   page.evaluate(jsString)        Runtime.evaluate-style eval, returns the value
//   page.click(cssSelector)        DOM click via evaluate; throws if no match
//   page.fill(cssSelector, value)  sets value + dispatches input/change events
//   page.waitFor(jsStringExpr)     polls until the expression is truthy (10s)
//   page.waitForBoot()             #main.welcome-mode after bootstrap
//   ctx.check(cond, label)         logs PASS/FAIL, records failures
//   ctx.shot(name)                 screenshot (playwright) / skip (lightpanda)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= Lightpanda backend (raw CDP) ================= */

function findLightpanda() {
    if (process.env.LIGHTPANDA_PATH && fs.existsSync(process.env.LIGHTPANDA_PATH)) {
        return process.env.LIGHTPANDA_PATH;
    }
    const which = spawnSync('lightpanda', ['version'], { stdio: 'ignore' });
    if (which.status === 0) return 'lightpanda';
    const local = path.join(os.homedir(), '.local', 'bin', 'lightpanda');
    if (fs.existsSync(local)) return local;
    return null;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

async function httpOk(url, timeoutMs = 1500) {
    return new Promise(resolve => {
        const req = http.get(url, res => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
        req.on('error', () => resolve(false));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    });
}

class LightpandaPage {
    static async connect(ctx) {
        const bin = findLightpanda();
        const port = await freePort();
        const child = spawn(bin, ['serve', '--port', String(port)], {
            stdio: 'ignore',
            env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' }
        });
        const deadline = Date.now() + 15000;
        let up = false;
        while (Date.now() < deadline) {
            if (await httpOk(`http://127.0.0.1:${port}/json/version`)) { up = true; break; }
            if (child.exitCode !== null) break;
            await sleep(150);
        }
        if (!up) {
            child.kill();
            throw new Error('lightpanda serve did not start on port ' + port);
        }

        const page = new LightpandaPage(child, port, ctx);
        await page._connect();
        return page;
    }

    constructor(child, port, ctx) {
        this.child = child;
        this.port = port;
        this.ctx = ctx;
        this.id = 0;
        this.pending = new Map();
        this.sessionId = null;
        this.ws = null;
    }

    async _connect() {
        this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/`);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', event => {
            const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
                return;
            }
            if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
                this.ctx.consoleErrors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
            } else if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                this.ctx.pageErrors.push(d?.exception?.description || d?.text || JSON.stringify(d));
            }
        });

        const { targetId } = await this._send('Target.createTarget', { url: 'about:blank' }, null);
        const attach = await this._send('Target.attachToTarget', { targetId, flatten: true }, null);
        this.sessionId = attach.sessionId;
        await this._send('Page.enable');
        await this._send('Runtime.enable');
    }

    _send(method, params = {}, sid = this.sessionId) {
        return new Promise((resolve, reject) => {
            const msgId = ++this.id;
            const msg = { id: msgId, method, params };
            if (sid) msg.sessionId = sid;
            this.pending.set(msgId, { resolve, reject });
            this.ws.send(JSON.stringify(msg));
        });
    }

    async goto(url) {
        await this._send('Page.navigate', { url });
        await this.waitFor("document.readyState === 'complete' || document.readyState === 'interactive'", 15000);
    }

    async evaluate(js) {
        const r = await this._send('Runtime.evaluate', {
            expression: js,
            returnByValue: true,
            awaitPromise: true
        });
        if (r.exceptionDetails) {
            throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
        }
        return r.result ? r.result.value : undefined;
    }

    async click(selector) {
        const found = await this.evaluate(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`
        );
        if (!found) throw new Error('click: no element matches ' + selector);
    }

    async fill(selector, value) {
        const found = await this.evaluate(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
        );
        if (!found) throw new Error('fill: no element matches ' + selector);
    }

    async waitFor(expr, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try { if (await this.evaluate(expr)) return true; } catch (e) { /* not ready yet */ }
            await sleep(150);
        }
        throw new Error('waitFor timed out after ' + timeoutMs + 'ms: ' + expr);
    }

    async close() {
        try { this.ws?.close(); } catch {}
        try { this.child.kill(); } catch {}
    }
}

/* ================= Playwright backend ================= */

function loadPlaywright() {
    const errors = [];
    try { return require('playwright'); } catch (e) { errors.push('playwright: ' + e.message); }
    try { return require('playwright-core'); } catch (e) { errors.push('playwright-core: ' + e.message); }
    try {
        const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
        for (const name of ['playwright', 'playwright-core']) {
            const candidate = path.join(globalRoot, name);
            if (fs.existsSync(candidate)) {
                try { return require(candidate); } catch (e) { errors.push(`${candidate}: ` + e.message); }
            }
        }
    } catch (e) {
        errors.push('npm root -g: ' + e.message);
    }
    return null;
}

// If `chromium.launch()` can't find its browser, scour the ms-playwright
// cache for a usable binary (newest build wins).
function findChromiumExecutable() {
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }
    const cacheDir = path.join(os.homedir(), '.cache', 'ms-playwright');
    if (!fs.existsSync(cacheDir)) return undefined;

    const candidates = [];
    for (const dir of fs.readdirSync(cacheDir)) {
        const m = dir.match(/^chromium(?:_headless_shell)?-(\d+)$/);
        if (!m) continue;
        const build = parseInt(m[1], 10);
        const sub = dir.startsWith('chromium_headless_shell') ? 'chrome-linux/headless_shell' : 'chrome-linux/chrome';
        const exe = path.join(cacheDir, dir, sub);
        if (fs.existsSync(exe)) candidates.push({ build, exe });
    }
    candidates.sort((a, b) => b.build - a.build);
    return candidates[0]?.exe;
}

async function launchBrowser(pw) {
    try {
        return await pw.chromium.launch();
    } catch (e) {
        const exe = findChromiumExecutable();
        if (!exe) {
            throw new Error(
                e.message +
                '\n\nNo chromium binary found in ' + path.join(os.homedir(), '.cache', 'ms-playwright') +
                '\nRun: playwright install chromium   (or: npx playwright install chromium)'
            );
        }
        console.warn(`[lib] chromium.launch() failed (${String(e.message).split('\n')[0]}); retrying with ${exe}`);
        return pw.chromium.launch({ executablePath: exe });
    }
}

class PlaywrightPage {
    static async connect(ctx, viewport) {
        const pw = loadPlaywright();
        if (!pw) throw new Error('playwright package not found (local, global, or npm root -g). See tools/README.md.');
        const browser = await launchBrowser(pw);
        const page = new PlaywrightPage(browser, ctx, viewport);
        page._page = await browser.newPage({ viewport });
        return page;
    }

    constructor(browser, ctx) {
        this.browser = browser;
        this.ctx = ctx;
        this._page = null;
        this._consoleBound = false;
    }

    async goto(url) {
        if (!this._consoleBound) {
            this._consoleBound = true;
            this._page.on('console', m => { if (m.type() === 'error') this.ctx.consoleErrors.push(m.text()); });
            this._page.on('pageerror', e => this.ctx.pageErrors.push(String(e)));
        }
        await this._page.goto(url, { waitUntil: 'networkidle' });
    }

    async evaluate(js) {
        return this._page.evaluate(js);
    }

    async click(selector) {
        const found = await this._page.evaluate(s => {
            const el = document.querySelector(s);
            if (!el) return false;
            el.click();
            return true;
        }, selector);
        if (!found) throw new Error('click: no element matches ' + selector);
    }

    async fill(selector, value) {
        const found = await this._page.evaluate(([s, v]) => {
            const el = document.querySelector(s);
            if (!el) return false;
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, [selector, value]);
        if (!found) throw new Error('fill: no element matches ' + selector);
    }

    async waitFor(expr, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try { if (await this._page.evaluate(expr)) return true; } catch (e) { /* not ready yet */ }
            await sleep(150);
        }
        throw new Error('waitFor timed out after ' + timeoutMs + 'ms: ' + expr);
    }

    async shot(name) {
        const p = path.join(this.ctx.screenshotDir, name);
        await this._page.screenshot({ path: p });
        console.log(`  [shot] ${p}`);
    }

    async close() {
        try { await this.browser.close(); } catch {}
    }
}

/* ================= Static file server (zero dependencies) ================= */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8'
};

function startStaticServer() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
            let filePath = path.normalize(path.join(REPO_ROOT, urlPath));
            if (!filePath.startsWith(REPO_ROOT)) {
                res.writeHead(403); res.end('forbidden'); return;
            }
            if (urlPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); res.end('not found'); return; }
                res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
        });
        server.on('error', reject);
    });
}

/* ================= Test runner ================= */

function argValue(name) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--' + name);
    return i !== -1 ? argv[i + 1] : undefined;
}

function detectBackend(requested) {
    const choice = (requested || process.env.BACKEND || '').toLowerCase();
    if (choice && !['auto', 'lightpanda', 'playwright'].includes(choice)) {
        throw new Error(`Unknown backend "${choice}" (expected auto|lightpanda|playwright)`);
    }
    if (choice === 'lightpanda' || choice === 'playwright') return choice;
    return findLightpanda() ? 'lightpanda' : 'playwright';
}

/**
 * Boots the app and runs `fn(page, ctx)`.
 *
 * opts: { backend?, viewport?, baseUrl?, screenshotDir? }
 * ctx:  { baseUrl, backend, screenshotDir, consoleErrors, pageErrors, failures,
 *         check(cond, label), shot(name) }
 * Any console error, page error, or failed check makes the script exit 1.
 */
async function run(name, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    opts = opts || {};

    const backend = detectBackend(opts.backend || argValue('backend'));
    const baseUrlArg = opts.baseUrl || argValue('base-url') || process.env.BASE_URL;
    const screenshotDir = opts.screenshotDir || argValue('screenshot-dir') || process.env.SCREENSHOT_DIR
        || path.join(os.tmpdir(), 'putergpt-tools');
    fs.mkdirSync(screenshotDir, { recursive: true });

    let server = null;
    let baseUrl = baseUrlArg;
    if (!baseUrl) {
        const s = await startStaticServer();
        server = s.server;
        baseUrl = s.baseUrl;
    }

    console.log(`[${name}] backend: ${backend}`);
    console.log(`[${name}] base-url: ${baseUrl}`);
    console.log(`[${name}] screenshot-dir: ${screenshotDir}`);

    const consoleErrors = [];
    const pageErrors = [];
    const failures = [];
    const ctx = {
        baseUrl,
        backend,
        screenshotDir,
        consoleErrors,
        pageErrors,
        failures,
        check(cond, label) {
            const ok = !!cond;
            console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`);
            if (!ok) failures.push(label);
        },
        async shot(shotName) {
            if (backend === 'playwright') {
                await page.shot(shotName);
            } else {
                console.log(`  [shot] skipped (${shotName}; lightpanda has no graphical screenshots)`);
            }
        }
    };

    let page = null;
    let code = 0;
    try {
        page = backend === 'lightpanda'
            ? await LightpandaPage.connect(ctx)
            : await PlaywrightPage.connect(ctx, opts.viewport || { width: 1280, height: 860 });
        await fn(page, ctx);
    } catch (e) {
        console.error(`[${name}] FAILED:`, e);
        failures.push(e.message || String(e));
        code = 1;
    }

    if (consoleErrors.length) {
        console.error(`[${name}] console errors:\n  ` + consoleErrors.join('\n  '));
        failures.push(`${consoleErrors.length} console error(s)`);
    }
    if (pageErrors.length) {
        console.error(`[${name}] page errors:\n  ` + pageErrors.join('\n  '));
        failures.push(`${pageErrors.length} page error(s)`);
    }
    if (failures.length) code = 1;

    if (page) await page.close();
    if (server) await new Promise(r => server.close(r));
    console.log(code === 0 ? `[${name}] PASS` : `[${name}] FAIL (${failures.length} problem(s))`);
    process.exit(code);
}

/** Wait for the app to finish booting (see AGENTS.md, Verification). */
async function waitForBoot(page) {
    await page.waitFor("document.getElementById('main') && document.getElementById('main').classList.contains('welcome-mode')", 20000);
}

async function openSettings(page) {
    await page.click('button.settings-row');
    await page.waitFor("document.getElementById('settings-modal').classList.contains('active')");
    await sleep(400); // let the open transition finish
}

module.exports = { REPO_ROOT, run, waitForBoot, openSettings, sleep };
