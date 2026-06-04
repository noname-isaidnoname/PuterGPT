/**
 * Utility to generate a unique ID with format: {timestamp}-{randomString}
 * Example: 1773090574898-pb3glyq
 * @returns {string}
 */
export function generateUniqueId() {
    const timestamp = Date.now().toString();
    const randomStr = Math.random().toString(36).substring(2, 10);
    return `${timestamp}-${randomStr}`;
}

/**
 * Computes deep differences between two objects
 * @param {Object} a - New state
 * @param {Object} b - Previous state
 * @param {string} path - Current path (used internally for recursion)
 * @returns {Object} - Object containing all changes with before/after values
 */
export function deepDiff(a, b, path = "") {
    const changes = {};

    for (const key in { ...a, ...b }) {
        const fullPath = path ? `${path}.${key}` : key;
        if (Object.is(a[key], b[key])) continue;
        if (typeof a[key] === "object" && a[key] && typeof b[key] === "object" && b[key]) {
            const nestedChanges = deepDiff(a[key], b[key], fullPath);
            Object.assign(changes, nestedChanges);
        } else {
            changes[fullPath] = { before: b[key], after: a[key] };
        }
    }

    return changes;
}

/**
 * Extract plain text from a message's content field. Handles both string content
 * and the array form used when images are attached.
 * @param {Object} message
 * @returns {string}
 */
export function getMessageText(message) {
    if (!message) return '';
    if (Array.isArray(message.content)) {
        const textItem = message.content.find(item => item.type === 'text');
        return textItem ? textItem.text : '';
    }
    return message.content || '';
}
