import { emit } from './event-bus.js';

export async function registerPWA() {
    if (!('serviceWorker' in navigator)) return;
    try {
        const registration = await navigator.serviceWorker.register('./sw.js');
        let notifiedWorker = null;
        const notify = worker => {
            if (!worker || worker === notifiedWorker || !navigator.serviceWorker.controller) return;
            notifiedWorker = worker;
            emit('toast:show', 'An update is available.', 'info', {
                label: 'Reload',
                onClick: () => {
                    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
                    worker.postMessage({ type: 'SKIP_WAITING' });
                }
            });
        };
        notify(registration.waiting);
        registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            if (!worker) return;
            worker.addEventListener('statechange', () => {
                if (worker.state === 'installed') notify(registration.waiting || worker);
            });
        });
    } catch (error) {
        // The app remains usable without a service worker (e.g. file://).
        console.warn('Offline app registration failed:', error);
    }
}
