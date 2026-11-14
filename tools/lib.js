#!/usr/bin/env node
// Shared helpers for the verification harnesses in tools/.
// No dependencies beyond Node itself; Playwright is resolved at runtime
// (local install, global install, or via `npm root -g`).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

/* ---------- Playwright resolution ---------- */

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
    throw new Error(
        'Playwright not found. Tried:\n  ' + errors.join('\n  ') +
        '\n\nInstall it with one of:\n  npm i -g playwright && playwright install chromium\n  npx playwright install chromium   (plus a local/global playwright package)'
    );
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
        console.warn(`[lib] chromium.launch() failed (${e.message.split('\n')[0]}); retrying with ${exe}`);
        return pw.chromium.launch({ executablePath: exe });
    }
}

/* ---------- Static file server (zero dependencies) ---------- */

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

/* ---------- Test runner ---------- */

function argValue(name) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--' + name);
    return i !== -1 ? argv[i + 1] : undefined;
}

/**
 * Boots the app in headless Chromium and runs `fn(page, ctx)`.
 *
 * ctx: { baseUrl, screenshotDir, consoleErrors, pageErrors, check(cond, label), shot(page, name) }
 * `check` logs PASS/FAIL and records failures; any console error, page error,
 * or failed check makes the script exit 1.
 *
 * Options:
 *   viewport     — default { width: 1280, height: 860 }
 *   initScript   — { fn, arg } passed to context.addInitScript (e.g. to seed localStorage)
 *   baseUrl      — override the served app (default: serve REPO_ROOT on an ephemeral port)
 *   screenshotDir— default $SCREENSHOT_DIR or <os.tmpdir()>/putergpt-tools
 */
async function run(name, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
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
    console.log(`[${name}] serving ${REPO_ROOT}`);
    console.log(`[${name}] base-url: ${baseUrl}`);
    console.log(`[${name}] screenshot-dir: ${screenshotDir}`);

    const pw = loadPlaywright();
    const browser = await launchBrowser(pw);
    const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 860 } });
    if (opts.initScript) await context.addInitScript(opts.initScript.fn, opts.initScript.arg);
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => pageErrors.push(String(e)));

    const failures = [];
    const ctx = {
        baseUrl,
        screenshotDir,
        consoleErrors,
        pageErrors,
        failures,
        check(cond, label) {
            const ok = !!cond;
            console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`);
            if (!ok) failures.push(label);
        },
        async shot(pageArg, shotName) {
            const p = path.join(screenshotDir, shotName);
            await pageArg.screenshot({ path: p });
            console.log(`  [shot] ${p}`);
        }
    };

    let code = 0;
    try {
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

    await browser.close();
    if (server) await new Promise(r => server.close(r));
    console.log(code === 0
        ? `[${name}] PASS`
        : `[${name}] FAIL (${failures.length} problem(s))`);
    process.exit(code);
}

/** Wait for the app to finish booting (see AGENTS.md, Verification). */
async function waitForBoot(page) {
    await page.waitForSelector('#main.welcome-mode', { timeout: 20000 });
}

async function openSettings(page) {
    await page.click('button.settings-row');
    await page.waitForSelector('#settings-modal.active', { timeout: 3000 });
    await page.waitForTimeout(400); // let the open transition finish
}

module.exports = { REPO_ROOT, run, waitForBoot, openSettings };
