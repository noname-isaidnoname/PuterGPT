#!/usr/bin/env node
// verify-all — run the tools/ harnesses concurrently and report the result.
//
// Harnesses serve the repo statically themselves, but this runner starts one
// shared static server and passes BASE_URL to every child, saving redundant
// trips. Output is buffered per harness and printed grouped afterwards;
// exit code is non-zero if anything fails.
//
// Usage:
//   node tools/verify-all.js                      # every harness, parallel
//   node tools/verify-all.js --changed            # only harnesses affected by uncommitted changes
//   node tools/verify-all.js --backend playwright # force one backend for the browser harnesses
//   node tools/verify-all.js --backend all        # browser harnesses on both backends
//   node tools/verify-all.js --backend lightpanda
//   node tools/verify-all.js --timeout 240        # per-harness timeout in seconds (default 180)
//   node tools/verify-all.js --verbose            # print full output of passing harnesses too
//   node tools/verify-all.js --list               # print the planned harness list and exit
//
// verify-edge-cases.js is always Playwright (it mocks the Puter API via route
// interception, which lightpanda can't do); verify-mobile.js is always
// Playwright when running with --backend all.
//
// --changed mode (used by the pre-commit hook): files are classified into
//   "skip" (docs/meta — no verification needed), "harnesses X" (only those
//   harnesses are affected) and "all" (everything else). App code, tools/
//   infrastructure and unknown paths always select the full suite; when git
//   is unavailable or the tree is clean, behavior is as documented above.

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { startStaticServer } = require('./lib.js');

const REPO_ROOT = path.resolve(__dirname, '..');

// Harnesses that accept --backend; edge-cases always uses playwright.
const BROWSER_HARNESSES = ['verify-settings', 'verify-custom-themes', 'verify-mobile'];
const EDGE_CASES = 'verify-edge-cases';
const ALL_HARNESSES = [...BROWSER_HARNESSES, EDGE_CASES];

// Map a harness source file to the harness it verifies
const HARNESS_BY_FILE = {
    'tools/verify-settings.js': 'verify-settings',
    'tools/verify-custom-themes.js': 'verify-custom-themes',
    'tools/verify-mobile.js': 'verify-mobile',
    'tools/verify-edge-cases.js': 'verify-edge-cases',
};

// Paths that never affect the app — a commit touching only these skips verification
const SKIP_PATH_RE = /(\.md$)|(^LICENSE)|(^LICENCE)|(^\.gitignore$)|(^\.githooks\/)|(^\.github\/)|(^\.fallow)|(^tools\/\.env)|(^tools\.env)/i;

const BACKENDS = ['auto', 'lightpanda', 'playwright', 'all'];
const argValue = (name) => {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--' + name);
    return i !== -1 ? argv[i + 1] : undefined;
};
const hasFlag = (name) => process.argv.slice(2).includes('--' + name);

const backendArg = (argValue('backend') || process.env.BACKEND || 'auto').toLowerCase();
if (!BACKENDS.includes(backendArg)) {
    console.error(`[verify-all] Unknown --backend "${backendArg}" (expected ${BACKENDS.join('|')})`);
    process.exit(1);
}
const TIMEOUT_MS = Math.max(1, (parseFloat(argValue('timeout') || process.env.VERIFY_TIMEOUT || '180') || 180)) * 1000;
const baselineUrl = argValue('base-url') || process.env.BASE_URL;
const changedMode = hasFlag('changed');
const verbose = hasFlag('verbose');

// Changed files for --changed mode: staged + unstaged tracked changes vs HEAD,
// plus untracked files. Returns null when git is unusable (caller runs all).
function dirtyPaths() {
    const git = (args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const diff = git(['diff', '--name-only', 'HEAD']);
    if (diff.status !== 0) return null;
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    const paths = [...diff.stdout.split('\n'), ...untracked.stdout.split('\n')]
        .map(s => s.trim())
        .filter(Boolean);
    return paths;
}

// Decide which harnesses to run in --changed mode
function selectChanged() {
    const paths = dirtyPaths();
    if (paths === null) {
        console.log('[verify-all] --changed: git unavailable or not a repo — running everything');
        return { selected: ALL_HARNESSES, reason: 'git unavailable' };
    }
    const relevant = paths.filter(p => !SKIP_PATH_RE.test(p));
    if (relevant.length === 0) {
        return { selected: [], reason: 'only docs/meta files changed' };
    }
    const selected = new Set();
    for (const p of relevant) {
        const harness = HARNESS_BY_FILE[p];
        if (harness) {
            selected.add(harness);
        } else {
            // App code, shared tooling or unknown paths — full suite
            return { selected: ALL_HARNESSES, reason: `app/tooling change: ${p}` };
        }
    }
    return { selected: [...selected], reason: `harness-only change(s): ${relevant.join(', ')}` };
}

// Expand the requested backend into the concrete (harness, backend?) task list
function planTasks() {
    let harnesses = ALL_HARNESSES;
    if (changedMode) {
        const { selected, reason } = selectChanged();
        console.log(`[verify-all] --changed: ${reason}`);
        harnesses = selected;
        if (harnesses.length === 0) {
            console.log('[verify-all] nothing to verify — skipping (run without --changed to force)');
            process.exit(0);
        }
    }

    const tasks = [];
    const push = (harness, backend) => {
        const file = path.join(REPO_ROOT, 'tools', harness + '.js');
        if (!fs.existsSync(file)) {
            console.error(`[verify-all] missing harness: ${file}`);
            process.exit(1);
        }
        tasks.push({ name: backend ? `${harness} (${backend})` : harness, file, backend });
    };

    for (const harness of harnesses) {
        if (!BROWSER_HARNESSES.includes(harness)) {
            push(harness, 'playwright'); // Lightpanda cannot intercept requests.
            continue;
        }
        if (backendArg === 'all') {
            // Mobile needs playwright (viewport emulation); the rest run on both.
            if (harness === 'verify-mobile') {
                push(harness, 'playwright');
            } else {
                push(harness, 'lightpanda');
                push(harness, 'playwright');
            }
        } else {
            push(harness, backendArg === 'auto' ? undefined : backendArg);
        }
    }
    return tasks;
}

function runTask(task, baseUrl) {
    return new Promise(resolve => {
        const started = Date.now();
        const args = [task.file];
        if (task.backend) args.push('--backend', task.backend);
        const child = spawn(process.execPath, args, {
            cwd: REPO_ROOT,
            env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true', ...(baseUrl ? { BASE_URL: baseUrl } : {}) },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', d => { output += d; });
        child.stderr.on('data', d => { output += d; });
        const killer = setTimeout(() => {
            child.kill('SIGKILL');
            output += `\n[verify-all] timed out after ${TIMEOUT_MS / 1000}s — killed`;
        }, TIMEOUT_MS);
        child.on('close', code => { clearTimeout(killer); resolve({ ...task, code, output, ms: Date.now() - started }); });
        child.on('error', err => { clearTimeout(killer); resolve({ ...task, code: 1, output: String(err), ms: Date.now() - started }); });
    });
}

(async () => {
    const tasks = planTasks();
    if (hasFlag('list')) {
        console.log(tasks.map(t => t.name).join('\n'));
        process.exit(0);
    }
    console.log(`[verify-all] running ${tasks.length} harness(es) in parallel: ${tasks.map(t => t.name).join(', ')}\n`);

    // One shared static server for the harnesses (unless testing a live URL)
    let server = null;
    let baseUrl = baselineUrl;
    if (!baseUrl) {
        const s = await startStaticServer();
        server = s.server;
        baseUrl = s.baseUrl;
    }

    const startedAt = Date.now();
    const results = await Promise.all(tasks.map(t => runTask(t, baseUrl)));
    if (server) await new Promise(r => server.close(r));

    let failed = 0;
    for (const r of results) {
        const ok = r.code === 0;
        if (!ok) failed++;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`);
        const body = r.output.trim();
        if (body && (!ok || verbose)) {
            // indent for readability; passing output is hidden unless --verbose
            console.log(body.split('\n').map(l => '      ' + l).join('\n'));
        }
        if (body) console.log('');
    }

    console.log(failed === 0
        ? `[verify-all] PASS — all ${results.length} harness(es) succeeded (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
        : `[verify-all] FAIL — ${failed} of ${results.length} harness(es) failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('[verify-all] FAILED:', err);
    process.exit(1);
});
