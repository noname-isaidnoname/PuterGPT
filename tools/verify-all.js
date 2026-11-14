#!/usr/bin/env node
// verify-all — run every harness in tools/ concurrently and report the result.
//
// Each harness serves the repo statically itself (no shared state, random
// ports), so they can all run at once. Output is buffered per harness and
// printed as a group afterwards; exit code is non-zero if anything fails.
//
// Usage:
//   node tools/verify-all.js                      # each harness its default backend (auto)
//   node tools/verify-all.js --backend playwright # force one backend for the browser harnesses
//   node tools/verify-all.js --backend all        # run the browser harnesses on both backends
//   node tools/verify-all.js --backend lightpanda
//
// verify-edge-cases.js is always Playwright (it mocks the Puter API via route
// interception, which lightpanda can't do); verify-mobile.js is always
// Playwright when running the suite with --backend all.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');

// Harnesses that accept --backend; edge-cases always uses playwright.
const BROWSER_HARNESSES = ['verify-settings', 'verify-custom-themes', 'verify-mobile'];
const EDGE_CASES = 'verify-edge-cases';

const BACKENDS = ['auto', 'lightpanda', 'playwright', 'all'];
const argValue = (name) => {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--' + name);
    return i !== -1 ? argv[i + 1] : undefined;
};
const backendArg = (argValue('backend') || process.env.BACKEND || 'auto').toLowerCase();
if (!BACKENDS.includes(backendArg)) {
    console.error(`[verify-all] Unknown --backend "${backendArg}" (expected ${BACKENDS.join('|')})`);
    process.exit(1);
}

// Expand the requested backend into the concrete (harness, backend?) task list
function planTasks() {
    const tasks = [];
    const push = (harness, backend) => {
        const file = path.join(REPO_ROOT, 'tools', harness + '.js');
        if (!fs.existsSync(file)) {
            console.error(`[verify-all] missing harness: ${file}`);
            process.exit(1);
        }
        tasks.push({ name: backend ? `${harness} (${backend})` : harness, file, backend });
    };

    for (const harness of BROWSER_HARNESSES) {
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
    push(EDGE_CASES); // playwright only, always
    return tasks;
}

function runTask(task) {
    return new Promise(resolve => {
        const started = Date.now();
        const args = [task.file];
        if (task.backend) args.push('--backend', task.backend);
        const child = spawn(process.execPath, args, {
            cwd: REPO_ROOT,
            env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', d => { output += d; });
        child.stderr.on('data', d => { output += d; });
        child.on('close', code => resolve({ ...task, code, output, ms: Date.now() - started }));
        child.on('error', err => resolve({ ...task, code: 1, output: String(err), ms: Date.now() - started }));
    });
}

(async () => {
    const tasks = planTasks();
    console.log(`[verify-all] running ${tasks.length} harness(es) in parallel: ${tasks.map(t => t.name).join(', ')}\n`);

    const results = await Promise.all(tasks.map(runTask));

    let failed = 0;
    for (const r of results) {
        const ok = r.code === 0;
        if (!ok) failed++;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`);
        const body = r.output.trim();
        if (body) {
            // indent for readability
            console.log(body.split('\n').map(l => '      ' + l).join('\n'));
        }
        console.log('');
    }

    console.log(failed === 0
        ? `[verify-all] PASS — all ${results.length} harness(es) succeeded`
        : `[verify-all] FAIL — ${failed} of ${results.length} harness(es) failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('[verify-all] FAILED:', err);
    process.exit(1);
});
