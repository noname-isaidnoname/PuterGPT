// Allowlist-based HTML sanitizer for rendering untrusted markup (markdown
// produced by marked.parse on user/AI/imported content). Strips everything
// that isn't explicitly permitted: no scripts, no event handlers, no
// javascript:/data: URLs outside of images, no iframes/forms/embeds.

const ALLOWED_TAGS = new Set([
    'a', 'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
    'sub', 'sup', 'small',
    'span', 'div',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'details', 'summary',
    'img', 'figure', 'figcaption',
    'input' // task-list checkboxes rendered by marked
]);

// Attributes allowed per tag, in addition to GLOBAL_ATTR.
const ALLOWED_ATTRS = {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    th: ['align', 'colspan', 'rowspan'],
    td: ['align', 'colspan', 'rowspan'],
    input: ['type', 'checked', 'disabled'],
    code: ['class'],
    pre: ['class'],
    span: ['class'],
    div: ['class'],
    ol: ['start', 'type'],
    li: ['class'],
    details: ['open'],
};

const GLOBAL_ATTRS = new Set(['class']);

// Tags that are dropped together with their subtree (rather than unwrapped).
const DROP_SUBTREE = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'template', 'svg', 'math', 'noscript']);

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'data:', 'blob:']);

function isSafeUrl(value, { allowDataImage = false } = {}) {
    const trimmed = String(value || '').trim();
    // Relative URLs and fragment-only anchors are fine.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return true;
    try {
        const url = new URL(trimmed, window.location.href);
        if (allowDataImage) {
            if (url.protocol === 'data:') {
                // Only image MIME types may come through as data: URLs.
                return /^data:image\/(png|gif|jpe?g|webp|bmp|ico|avif|svg\+xml);/i.test(trimmed);
            }
            return url.protocol === 'blob:' || SAFE_URL_PROTOCOLS.has(url.protocol);
        }
        return SAFE_URL_PROTOCOLS.has(url.protocol);
    } catch {
        return false;
    }
}

function sanitizeElement(el) {
    const tag = el.tagName.toLowerCase();

    if (DROP_SUBTREE.has(tag)) {
        el.remove();
        return;
    }

    if (!ALLOWED_TAGS.has(tag)) {
        // Unwrap: sanitize descendants first, then replace the element
        // with its children so no unsanitized node is reparented.
        for (const child of [...el.children]) {
            sanitizeElement(child);
        }
        const parent = el.parentNode;
        if (!parent) return;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        return;
    }

    // Strip attributes not on the allowlist (and anything event-handler or style).
    const allowed = new Set([...(ALLOWED_ATTRS[tag] || []), ...GLOBAL_ATTRS]);
    for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction' || !allowed.has(name)) {
            el.removeAttribute(attr.name);
            continue;
        }
        if (name === 'href' && !isSafeUrl(attr.value)) {
            el.removeAttribute(attr.name);
        } else if (name === 'src' && !isSafeUrl(attr.value, { allowDataImage: true })) {
            el.removeAttribute(attr.name);
        }
    }

    if (tag === 'a') {
        // Force safe link behavior.
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    if (tag === 'input') {
        // Task-list checkboxes: make read-only, no interaction.
        el.setAttribute('disabled', '');
    }

    // Sanitize all children now that this element is known-good.
    sanitizeChildren(el);
}

/**
 * Sanitize an HTML string, returning a safe HTML string.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html ?? '');
    sanitizeChildren(template.content);
    return template.innerHTML;
}

function sanitizeChildren(root) {
    for (const child of [...root.children]) {
        sanitizeElement(child);
    }
}
