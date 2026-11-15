// Bump this version whenever any cached application or CDN asset changes.
const CACHE_NAME = 'putergpt-shell-v2';
const APP_SHELL = [
    './', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png',
    './css/base.css', './css/sidebar.css', './css/chat.css', './css/message-actions.css',
    './css/markdown.css', './css/input.css', './css/ui-elements.css', './css/modal.css',
    './css/settings.css', './css/reasoning.css', './css/responsive.css', './css/animations.css',
    './css/token-management.css', './css/search.css', './css/compare.css', './css/print.css',
    './js/app.js', './js/backup.js', './js/chat-api.js', './js/chat-edit.js', './js/chat-ui.js',
    './js/chat.js', './js/code-runner.js', './js/compare.js', './js/compression.js',
    './js/event-bus.js', './js/export.js', './js/generation-params.js', './js/image-utils.js',
    './js/indexeddb-storage.js', './js/modal-helper.js', './js/models.js', './js/pwa.js', './js/sanitize.js',
    './js/search-ui.js', './js/search.js', './js/shortcuts.js', './js/state.js', './js/storage.js', './js/store.js',
    './js/theme-generator.js', './js/theme-ui.js', './js/token-manager.js', './js/token-ui-list.js',
    './js/token-ui-modals.js', './js/token-ui-quick.js', './js/token-ui-rotation.js',
    './js/token-ui.js', './js/ui.js', './js/utils.js', './js/variants.js', './js/voice-input.js'
];
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
    'https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js',
    'https://unpkg.com/dexie@4.0.11/dist/dexie.js',
    'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css',
    'https://fonts.googleapis.com/icon?family=Material+Icons+Outlined',
    'https://noname-isaidnoname.github.io/MyAIUtilities/puterStream.js'
];
const shellUrls = new Set(APP_SHELL.map(path => new URL(path, self.registration.scope).href));
const cdnUrls = new Set(CDN_ASSETS);

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // The local shell is required; CDN availability must not block installation.
        await cache.addAll(APP_SHELL);
        await Promise.allSettled(CDN_ASSETS.map(url => cache.add(url)));
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith('putergpt-shell-') && key !== CACHE_NAME)
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    // API and authenticated traffic must never be read from or written to a cache.
    if (request.method !== 'GET' || url.hostname === 'api.puter.com'
        || request.headers.has('Authorization')) return;
    const cleanUrl = new URL(url.href);
    cleanUrl.search = '';
    cleanUrl.hash = '';
    const isShell = url.origin === self.location.origin && shellUrls.has(cleanUrl.href);
    const isIconFont = url.origin === 'https://fonts.gstatic.com' && url.pathname.startsWith('/s/materialiconsoutlined/');
    if (!isShell && !cdnUrls.has(url.href) && !isIconFont) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const key = isShell ? cleanUrl.href : request;
        const cached = await cache.match(key);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
            await cache.put(key, response.clone());
        }
        return response;
    })());
});
