// Theme cards UI (Appearance panel)
import { themeDefinitions } from './store.js';
import { els, state } from './state.js';

const BUILTIN_CARDS = [
    { key: 'light', label: 'Light', icon: 'light_mode' },
    { key: 'dark', label: 'Dark', icon: 'dark_mode' }
];

const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;

function leadingEmoji(name) {
    const m = (name || '').match(LEADING_EMOJI_RE);
    return m ? m[1] : null;
}

function stripLeadingEmoji(name) {
    return (name || '').replace(LEADING_EMOJI_RE, '');
}

function currentTheme() {
    return state?.config?.theme || 'light';
}

function makeCard(key, label, iconNode) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.themeCard = key;
    card.setAttribute('aria-pressed', key === currentTheme() ? 'true' : 'false');

    const iconEl = document.createElement('span');
    iconEl.className = 'theme-card-icon';
    if (typeof iconNode === 'string') {
        // Material icon ligature
        const mi = document.createElement('span');
        mi.className = 'material-icons-outlined';
        mi.textContent = iconNode;
        iconEl.appendChild(mi);
    } else {
        // Emoji / unicode glyph
        iconEl.textContent = iconNode;
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'theme-card-name';
    nameEl.textContent = label;

    card.appendChild(iconEl);
    card.appendChild(nameEl);
    card.addEventListener('click', () => window.selectThemeCard(key));
    return card;
}

export function renderThemeCards() {
    const container = document.getElementById('theme-cards');
    if (!container) return;

    container.innerHTML = '';

    BUILTIN_CARDS.forEach(({ key, label, icon }) => {
        container.appendChild(makeCard(key, label, icon));
    });

    Object.entries(themeDefinitions).forEach(([key, theme]) => {
        if (key === 'light' || key === 'dark') return;
        const rawName = theme.name || key;
        const icon = theme.icon || leadingEmoji(rawName) || '🎨';
        const label = stripLeadingEmoji(rawName).trim() || rawName;
        container.appendChild(makeCard(key, label, icon));
    });

    // "Generate custom theme" card
    const gen = document.createElement('button');
    gen.type = 'button';
    gen.className = 'theme-card theme-card-generate';
    const genIcon = document.createElement('span');
    genIcon.className = 'theme-card-icon';
    const mi = document.createElement('span');
    mi.className = 'material-icons-outlined';
    mi.textContent = 'auto_awesome';
    genIcon.appendChild(mi);
    const genLabel = document.createElement('span');
    genLabel.className = 'theme-card-name';
    genLabel.textContent = 'Generate';
    gen.appendChild(genIcon);
    gen.appendChild(genLabel);
    gen.addEventListener('click', () => window.openThemeGenerator());
    container.appendChild(gen);

    syncThemeCards();
}

export function syncThemeCards() {
    const current = currentTheme();
    document.querySelectorAll('.theme-card[data-theme-card]').forEach(card => {
        const active = card.dataset.themeCard === current;
        card.classList.toggle('active', active);
        card.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    // Delete button only makes sense for custom themes
    const deleteBtn = document.getElementById('delete-theme-btn');
    if (deleteBtn) {
        deleteBtn.style.display = current.startsWith('custom-') ? 'block' : 'none';
    }
}

window.selectThemeCard = async (key) => {
    if (!key || key === 'generate-custom') return;
    const { setState } = await import('./store.js');
    setState((state) => ({
        config: { ...state.config, theme: key }
    }));
    const { db } = await import('./indexeddb-storage.js');
    await db.settings.put({ key: 'theme', value: key });
    syncThemeCards();
};
