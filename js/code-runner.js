// Code Runner Modal
// Renders HTML or JavaScript from code blocks inside an iframe (unsandboxed by design).
import { emit } from './event-bus.js';

const RUNNABLE_HTML = new Set(['html', 'xhtml']);
const RUNNABLE_JS = new Set(['javascript', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'typescript']);

function buildJsShell() {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>JS Output</title>
<style>
    body { font-family: ui-monospace, 'Cascadia Mono', 'Cascadia Code', SFMono-Regular, Menlo, Monaco, Consolas, monospace; padding: 10px 14px; color: #d4d4d4; background: #0c0c0c; margin: 0; min-height: 100vh; box-sizing: border-box; }
    #runner-log { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; min-height: 1em; margin: 0; }
    #runner-log > div { padding: 1px 0; }
    #runner-log .l-info,
    #runner-log .l-log   { color: #d4d4d4; }
    #runner-log .l-debug { color: #6b7280; }
    #runner-log .l-warn  { color: #eab308; }
    #runner-log .l-error { color: #f87171; font-weight: 600; }
    #runner-log .l-info::before,
    #runner-log .l-log::before   { content: '> '; color: #4ade80; margin-right: 4px; }
    #runner-log .l-warn::before  { content: '! '; color: #eab308; margin-right: 4px; }
    #runner-log .l-error::before { content: '\u00d7 '; color: #f87171; margin-right: 4px; }
    #runner-log .l-debug::before { content: '# '; color: #6b7280; margin-right: 4px; }
</style>
</head>
<body>
<pre id="runner-log"></pre>
<script>
(function () {
    var logEl = document.getElementById('runner-log');

    function fmt(value, seen) {
        if (value === undefined) return 'undefined';
        if (value === null) return 'null';
        var t = typeof value;
        if (t === 'string') return value;
        if (t === 'number' || t === 'boolean') return String(value);
        if (t === 'bigint') return value.toString() + 'n';
        if (t === 'symbol') return value.toString();
        if (t === 'function') {
            try { return value.toString(); } catch (_) { return '[Function]'; }
        }
        seen = seen || new WeakSet();
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        try {
            return JSON.stringify(value, function (k, v) {
                if (typeof v === 'bigint') return v.toString() + 'n';
                if (typeof v === 'function') return '[Function]';
                if (v instanceof Error) return v.stack || v.message;
                if (v instanceof HTMLElement) return '<' + v.tagName.toLowerCase() + '>';
                return v;
            }, 2);
        } catch (_) {
            try { return String(value); } catch (_) { return Object.prototype.toString.call(value); }
        }
    }

    function append(level, args) {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(fmt(args[i]));
        var line = document.createElement('div');
        line.className = 'l-' + level;
        line.textContent = parts.join(' ');
        logEl.appendChild(line);
    }

    function capture(name, level) {
        if (typeof console === 'undefined' || typeof console[name] !== 'function') return;
        var original = console[name].bind(console);
        console[name] = function () {
            try { append(level, arguments); } catch (_) { /* never break user code */ }
            try { return original.apply(console, arguments); } catch (_) { /* still never break user code */ }
        };
    }
    capture('log',   'log');
    capture('info',  'info');
    capture('debug', 'debug');
    capture('warn',  'warn');
    capture('error', 'error');

    function reportError(err) {
        var line = document.createElement('div');
        line.className = 'l-error';
        line.textContent = (err && err.stack) ? err.stack : String(err);
        logEl.appendChild(line);
    }
    window.addEventListener('error', function (e) {
        reportError(e.error || e.message);
    });
    window.addEventListener('unhandledrejection', function (e) {
        reportError(e.reason);
    });
    try {
        __USER_CODE__
    } catch (err) {
        reportError(err);
    }
})();
</script>
</body>
</html>`;
}

function getOverlay() { return document.getElementById('code-runner-modal'); }
function getIframe() { return document.getElementById('code-runner-iframe'); }
function getTitle() { return document.getElementById('code-runner-title'); }
function getNewTabBtn() { return document.getElementById('code-runner-open-new-tab'); }

// Escape the literal sequence "</script" inside the user's code so it can't
// prematurely close the shell's <script> tag when the iframe parses srcdoc.
function safeUserCode(code) {
    return String(code).replace(/<\/script/gi, '<\\/script');
}

function isRunnableLanguage(lang) {
    if (!lang) return null;
    const normalized = String(lang).toLowerCase().split(/\s+/)[0];
    if (RUNNABLE_HTML.has(normalized)) return 'html';
    if (RUNNABLE_JS.has(normalized)) return 'js';
    return null;
}

function openCodeRunner(code, lang) {
    const runnable = isRunnableLanguage(lang);
    if (!runnable) {
        console.warn('Language is not runnable:', lang);
        return;
    }

    const overlay = getOverlay();
    const iframe = getIframe();
    const title = getTitle();
    if (!overlay || !iframe || !title) {
        console.error('Code runner modal markup is missing from the page.');
        return;
    }

    title.textContent = runnable === 'html' ? 'HTML Preview' : 'JavaScript Output';

    // Reset the iframe so previous state doesn't leak between runs.
    iframe.removeAttribute('srcdoc');
    iframe.srcdoc = runnable === 'html'
        ? code
        : buildJsShell().replace('__USER_CODE__', safeUserCode(code));

    overlay.classList.add('active');
    overlay.dataset.lang = runnable;
    overlay.dataset.code = code;

    // Focus the iframe so keyboard input is captured by the running code.
    try { iframe.focus(); } catch (_) { /* no-op */ }
}

function closeCodeRunner() {
    const overlay = getOverlay();
    const iframe = getIframe();
    if (!overlay) return;
    overlay.classList.remove('active');
    if (iframe) {
        // Clear srcdoc to fully tear down the previous run before the next open.
        iframe.srcdoc = '';
    }
}

function openInNewTab() {
    const overlay = getOverlay();
    if (!overlay) return;
    const code = overlay.dataset.code || '';
    const lang = overlay.dataset.lang || 'html';
    const html = lang === 'html' ? code : buildJsShell().replace('__USER_CODE__', safeUserCode(code));
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
        // Popup blocked; Show a toast
        emit('toast:show', 'Popup blocked. Could not open in new tab. Try allowing popups for this site.');
    } else {
        // Revoke the URL once the new tab has had a chance to load it.
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
}

// Expose for inline onclick handlers in the modal markup and for the
// decorateCodeBlocks() helper in chat-ui.js to consult when adding run buttons.
window.openCodeRunner = openCodeRunner;
window.closeCodeRunner = closeCodeRunner;
window.openCodeRunnerInNewTab = openInNewTab;
window.isRunnableLanguage = isRunnableLanguage;

// Global wiring: close on Escape and on backdrop click.
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const overlay = getOverlay();
        if (overlay && overlay.classList.contains('active')) {
            closeCodeRunner();
        }
    }
});

document.addEventListener('click', (e) => {
    const overlay = getOverlay();
    if (!overlay || !overlay.classList.contains('active')) return;
    // Backdrop click = click directly on the overlay (not its children).
    if (e.target === overlay) {
        closeCodeRunner();
    }
});