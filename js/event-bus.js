// Tiny pub/sub event bus
const listeners = new Map();

export function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => off(event, fn);
}

function off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
}

export function emit(event, ...args) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
        try {
            fn(...args);
        } catch (err) {
            console.error(`[event-bus] listener for "${event}" threw:`, err);
        }
    }
}

function clearAll() {
    listeners.clear();
}
