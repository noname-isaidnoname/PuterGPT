// Theme editor — edit custom themes (colors, JS effects, name/icon) with a
// live preview, plus create new custom themes from a preset (no AI involved).
//
// Editing never touches storage until Save: changes preview live via inline
// CSS properties (debounced ~300ms) and Cancel restores the snapshot taken
// at open. Save mirrors the generator's dual-store write (localStorage +
// IndexedDB) via updateCustomTheme(). Live preview sets only CSS variables —
// theme JavaScript always takes effect on Save, not while typing.

import { themeDefinitions, setState } from './store.js';
import { state, applyTheme } from './state.js';
import { emit } from './event-bus.js';
import { reportStorageError } from './indexeddb-storage.js';
import { THEME_VAR_CATEGORIES, CATALOG_VAR_NAMES } from './theme-catalog.js';
import { persistCustomTheme, updateCustomTheme } from './theme-generator.js';

const PREVIEW_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Working state (single editor instance)
// ---------------------------------------------------------------------------
let editingThemeId = null;
let previousThemeId = null;   // active theme when the editor opened (restored by preview-off / Cancel)
let previewEnabled = true;    // live preview toggle
let workingTheme = null;      // deep clone being edited (mutated on input)
let originalTheme = null;     // snapshot for Cancel
let dirty = false;
let previewVars = new Set();  // var names currently applied by the preview
let previewTimer = null;
let activeTab = THEME_VAR_CATEGORIES[0].id;
let lastTrigger = null;

const $ = (id) => document.getElementById(id);

const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;

function leadingEmoji(name) {
    const m = (name || '').match(LEADING_EMOJI_RE);
    return m ? m[1] : null;
}

function normalizeIcon(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return undefined;
    try {
        const glyphs = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(trimmed)];
        return glyphs.length === 1 ? trimmed : null; // null = invalid (multi-glyph)
    } catch {
        return trimmed;
    }
}

function humanizeVarName(name) {
    const base = (name || '').replace(/^--/, '').replace(/-/g, ' ').trim();
    return base.charAt(0).toUpperCase() + base.slice(1);
}

// ---------------------------------------------------------------------------
// Color parsing (canvas normalizes any CSS color to #rrggbb / rgba()).
// Falls back to text-input-only rows when canvas 2d is unavailable.
// ---------------------------------------------------------------------------
let canvasCtx = undefined; // undefined = not tried yet, null = unavailable
const SENTINEL = '#000001';

function getCanvasCtx() {
    if (canvasCtx !== undefined) return canvasCtx;
    try {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        canvasCtx = c.getContext('2d') || null;
    } catch {
        canvasCtx = null;
    }
    return canvasCtx;
}

function parseColor(value) {
    const v = (value || '').trim();
    if (!v) return null;
    const ctx = getCanvasCtx();
    if (!ctx) return null;
    try {
        ctx.fillStyle = SENTINEL;
        ctx.fillStyle = v;
        const out = String(ctx.fillStyle || '').toLowerCase();
        if (!out) return null;
        if (out === SENTINEL && v.toLowerCase() !== SENTINEL) return null; // unparseable (e.g. var() refs)
        let m = out.match(/^#([0-9a-f]{6})$/);
        if (m) {
            const hex = m[1];
            return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
        }
        m = out.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
        if (m) {
            return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
        }
        return null;
    } catch {
        return null;
    }
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

function formatRgb(r, g, b) {
    return '#' + hex2(r) + hex2(g) + hex2(b);
}

function roundAlpha(a) {
    return Math.round(a * 100) / 100;
}

function formatColorValue(r, g, b, a) {
    if (a >= 1) return formatRgb(r, g, b);
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${roundAlpha(a)})`;
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------
function clearPreviewVars() {
    const root = document.documentElement;
    for (const name of previewVars) root.style.removeProperty(name);
    previewVars.clear();
}

function applyPreviewVars() {
    if (!workingTheme) return;
    const root = document.documentElement;
    const vars = workingTheme.cssVars || {};
    for (const name of [...previewVars]) {
        if (!Object.prototype.hasOwnProperty.call(vars, name)) {
            root.style.removeProperty(name);
            previewVars.delete(name);
        }
    }
    for (const [name, value] of Object.entries(vars)) {
        if (typeof value === 'string') {
            root.style.setProperty(name, value);
            previewVars.add(name);
        }
    }
}

function refreshCards() {
    import('./theme-ui.js').then(m => m.renderThemeCards()).catch(() => {});
}

function schedulePreview() {
    dirty = true;
    updateDirtyIndicator();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
        if (!previewEnabled) return; // edits accumulate in the working copy only
        publishWorkingTheme();
        applyPreviewVars();
        refreshCards();
    }, PREVIEW_DEBOUNCE_MS);
}

function updatePreviewToggleUI() {
    const toggle = $('theme-editor-preview-toggle');
    if (toggle) toggle.checked = previewEnabled;
    const hint = $('theme-editor-preview-hint');
    if (hint) {
        hint.textContent = previewEnabled
            ? 'Showing this theme while you edit'
            : 'Preview off — showing the theme from before you opened the editor';
    }
}

// Toggle live preview. Off: put back both the pre-edit theme definition and
// the theme that was active when the editor opened. On: re-publish the
// working copy and re-apply the edited theme.
async function setPreviewEnabled(enabled) {
    if (!workingTheme || !editingThemeId) return;
    previewEnabled = enabled;
    clearTimeout(previewTimer);
    clearPreviewVars();
    const isActive = state.config.theme === editingThemeId;

    if (enabled) {
        publishWorkingTheme();
        if (!isActive) {
            setState((s) => ({ config: { ...s.config, theme: editingThemeId } })); // applies via subscription
            await persistActiveTheme(editingThemeId);
        } else {
            applyTheme(editingThemeId); // subscription won't fire — re-apply explicitly
        }
    } else {
        themeDefinitions[editingThemeId] = originalTheme; // hide the working copy everywhere
        const restoreId = previousThemeId || 'dark';
        if (restoreId === editingThemeId) {
            applyTheme(restoreId); // re-assert the pre-edit definition (its JS onRemove runs cleanly)
        } else if (state.config.theme !== restoreId) {
            setState((s) => ({ config: { ...s.config, theme: restoreId } }));
            await persistActiveTheme(restoreId);
        }
        // else: restoreId already active (user toggled off earlier) — nothing to switch
    }

    refreshCards();
    updatePreviewToggleUI();
}

function updateDirtyIndicator() {
    const el = $('theme-editor-dirty');
    if (el) el.textContent = dirty ? '● Unsaved changes' : '';
}

async function persistActiveTheme(id) {
    try {
        const { db } = await import('./indexeddb-storage.js');
        await db.settings.put({ key: 'theme', value: id });
    } catch (error) {
        console.error('Failed to persist theme selection:', error);
    }
}

// Publish the working copy to the runtime registry (what cards/JS see) vs.
// re-assert the pre-edit snapshot. Only ever applied while the preview is on
// or after a save.
function publishWorkingTheme() {
    if (editingThemeId && workingTheme) themeDefinitions[editingThemeId] = workingTheme;
}

// ---------------------------------------------------------------------------
// Editor construction
// ---------------------------------------------------------------------------
function defaultVars() {
    // Built-in dark set as the placeholder reference (what "unset" falls back to-ish)
    return themeDefinitions.dark?.cssVars || {};
}

function makeVarRow(varDef) {
    const { name, label, hint } = varDef;
    const defaults = defaultVars();
    const current = workingTheme.cssVars[name];
    const isSet = current !== undefined && current !== '';

    const row = document.createElement('div');
    row.className = 'theme-var-row';

    const labelWrap = document.createElement('div');
    labelWrap.className = 'theme-var-label';
    const nameEl = document.createElement('span');
    nameEl.className = 'theme-var-name';
    nameEl.textContent = label;
    const rawEl = document.createElement('code');
    rawEl.className = 'theme-var-raw';
    rawEl.textContent = name;
    rawEl.title = hint ? `${name} — ${hint}` : name;
    if (hint) rawEl.tabIndex = 0;
    labelWrap.appendChild(nameEl);
    labelWrap.appendChild(rawEl);

    const field = document.createElement('div');
    field.className = 'theme-var-field';

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'theme-var-swatch';
    swatch.title = 'Pick a color';
    swatch.setAttribute('aria-label', `Pick color for ${name}`);

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'theme-var-input';
    text.dataset.var = name;
    text.value = isSet ? current : '';
    text.placeholder = defaults[name] ? `${defaults[name]} (default)` : 'unset';
    text.spellcheck = false;
    text.autocomplete = 'off';

    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.className = 'theme-var-alpha';
    alpha.min = '0';
    alpha.max = '100';
    alpha.step = '1';
    alpha.title = 'Opacity';
    alpha.setAttribute('aria-label', `Opacity for ${name}`);

    field.appendChild(swatch);
    field.appendChild(text);
    field.appendChild(alpha);
    row.appendChild(labelWrap);
    row.appendChild(field);

    const syncSwatchFromText = () => {
        const parsed = parseColor(text.value);
        if (parsed) {
            swatch.disabled = false;
            swatch.value = formatRgb(parsed.r, parsed.g, parsed.b);
            const hasAlpha = parsed.a < 1;
            alpha.classList.toggle('visible', hasAlpha);
            alpha.value = String(Math.round(parsed.a * 100));
        } else {
            swatch.disabled = true;
            alpha.classList.remove('visible');
        }
    };

    const setVarFromText = () => {
        const v = text.value.trim();
        if (v === '') delete workingTheme.cssVars[name];
        else workingTheme.cssVars[name] = v;
    };

    text.addEventListener('input', () => {
        setVarFromText();
        syncSwatchFromText();
        schedulePreview();
    });

    swatch.addEventListener('input', () => {
        const parsed = parseColor(text.value);
        const a = alpha.classList.contains('visible') && parsed ? parsed.a : 1;
        const hex = swatch.value; // #rrggbb
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const v = formatColorValue(r, g, b, a);
        text.value = v;
        workingTheme.cssVars[name] = v;
        schedulePreview();
    });

    alpha.addEventListener('input', () => {
        const parsed = parseColor(text.value) || { r: 0, g: 0, b: 0 };
        const a = Math.round(Number(alpha.value)) / 100;
        const v = formatColorValue(parsed.r, parsed.g, parsed.b, a);
        text.value = v;
        workingTheme.cssVars[name] = v;
        schedulePreview();
    });

    syncSwatchFromText();
    return row;
}

function buildVarPanel(category) {
    const panel = document.createElement('div');
    panel.className = 'theme-editor-panel theme-editor-panel-vars';
    panel.dataset.panel = category.id;
    panel.setAttribute('role', 'tabpanel');
    const desc = document.createElement('p');
    desc.className = 'theme-editor-panel-desc';
    desc.textContent = category.description || '';
    panel.appendChild(desc);
    const grid = document.createElement('div');
    grid.className = 'theme-var-grid';
    for (const varDef of category.vars) grid.appendChild(makeVarRow(varDef));
    panel.appendChild(grid);
    return panel;
}

// Pretty-print JavaScript when js-beautify loaded; fall back to verbatim code.
function beautifyJs(code) {
    const src = String(code || '');
    if (!src.trim()) return '';
    try {
        if (typeof window.js_beautify === 'function') {
            return window.js_beautify(src, { indent_size: 4, end_with_newline: false });
        }
    } catch (error) {
        console.warn('Could not beautify theme JavaScript:', error);
    }
    return src;
}

// Re-render the syntax-highlighting overlay for a JS codebox.
function renderJsHighlight(codebox) {
    const ta = codebox.querySelector('.theme-js-textarea');
    const code = codebox.querySelector('.theme-js-highlight code');
    if (!ta || !code) return;
    const src = ta.value + '\n'; // trailing newline keeps the scroll heights in sync
    try {
        // hljs.highlight().value — no .hljs class involved, so no "already highlighted" skip
        if (window.hljs) {
            code.innerHTML = window.hljs.highlight(src, { language: 'javascript' }).value;
            return;
        }
    } catch (error) {
        console.warn('Could not highlight theme JavaScript:', error); // plain escaped text stays readable
    }
    code.textContent = src;
}

function syncJsScroll(codebox) {
    const ta = codebox.querySelector('.theme-js-textarea');
    const pre = codebox.querySelector('.theme-js-highlight');
    if (ta && pre) {
        pre.scrollTop = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
    }
}

function wireJsField(field) {
    const codebox = field.querySelector('.theme-js-codebox');
    const ta = field.querySelector('.theme-js-textarea');
    const formatBtn = field.querySelector('.theme-js-format-btn');
    if (!ta || !codebox) return;

    ta.addEventListener('input', () => renderJsHighlight(codebox));
    ta.addEventListener('scroll', () => syncJsScroll(codebox));
    ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault(); // insert 4 spaces instead of moving focus
        ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    formatBtn?.addEventListener('click', () => {
        if (typeof window.js_beautify !== 'function') {
            emit('toast:show', 'Formatter failed to load — check your network/CDN access', 'error');
            return;
        }
        const beautified = beautifyJs(ta.value);
        if (!ta.value.trim() || beautified === ta.value) {
            emit('toast:show', 'Code is already formatted', 'info');
            return;
        }
        ta.value = beautified;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        emit('toast:show', 'JavaScript formatted', 'success');
    });

    renderJsHighlight(codebox);
}

// Syntax-check JS the way executeThemeJS compiles it, so save only persists
// code that will actually run.
function compileThemeJs(code) {
    try {
        // eslint-disable-next-line no-new-func
        new Function(
            'document', 'window', 'console', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout',
            'themeUtils', 'Math', 'Date', 'JSON', 'localStorage', 'sessionStorage',
            `"use strict";\n${code}`);
        return null;
    } catch (error) {
        return error?.message || String(error);
    }
}

function buildJsPanel() {
    const panel = document.createElement('div');
    panel.className = 'theme-editor-panel';
    panel.dataset.panel = 'js';
    panel.setAttribute('role', 'tabpanel');

    const js = workingTheme.javascript || {};
    const enabled = !!((js.onApply && js.onApply.trim()) || (js.onRemove && js.onRemove.trim()));

    const toggleRow = document.createElement('div');
    toggleRow.className = 'theme-js-toggle-row';
    toggleRow.innerHTML = `
        <label class="theme-js-toggle" for="theme-editor-js-enabled">
            <span class="switch"><input type="checkbox" id="theme-editor-js-enabled"${enabled ? ' checked' : ''}><span class="switch-track"></span></span>
            <span class="theme-js-toggle-label">Enable JavaScript effects</span>
        </label>
        <p class="theme-js-hint">
            Runs when the theme is applied, like AI-generated themes. The code executes with
            <code>themeUtils</code> helpers (<code>toggleClass</code>, <code>addClass</code>, <code>setCSSVar</code>,
            <code>createElement</code>, <code>storage</code>…) passed in its scope. Keep <code>onRemove</code> a mirror of
            <code>onApply</code> so switching away cleans up. Effects take effect after you save — not while typing.
            A theme saved without JS simply has no <code>javascript</code> key, exactly like a JS-less generated theme.
        </p>`;
    panel.appendChild(toggleRow);

    const makeField = (id, label, placeholder) => {
        const rawKey = id === 'theme-editor-js-onapply' ? 'javascript.onApply' : 'javascript.onRemove';
        const wrap = document.createElement('div');
        wrap.className = 'theme-js-field';
        wrap.innerHTML = `
            <div class="theme-js-label-row">
                <label class="theme-js-label" for="${id}">${label} <code>${rawKey}</code></label>
                <button type="button" class="theme-js-format-btn" data-format="${id}" title="Pretty-print the code"${enabled ? '' : ' disabled'}>
                    <span class="material-icons-outlined">format_align_left</span>Format
                </button>
            </div>
            <div class="theme-js-codebox">
                <pre class="theme-js-highlight" aria-hidden="true"><code class="language-javascript"></code></pre>
                <textarea id="${id}" class="theme-js-textarea" spellcheck="false" autocomplete="off" autocapitalize="off"
                    placeholder="${placeholder}" aria-label="${label} JavaScript"${enabled ? '' : ' disabled'}></textarea>
            </div>`;
        return wrap;
    };

    const onApplyWrap = makeField(
        'theme-editor-js-onapply',
        'On apply',
        "// runs when the theme is applied\nthemeUtils.toggleClass('body', 'my-theme', true);"
    );
    const onRemoveWrap = makeField(
        'theme-editor-js-onremove',
        'On remove',
        "// undo what onApply did\nthemeUtils.toggleClass('body', 'my-theme', false);"
    );
    // Show minified/AI code pretty-printed; stored verbatim unless edited
    onApplyWrap.querySelector('textarea').value = beautifyJs(js.onApply);
    onRemoveWrap.querySelector('textarea').value = beautifyJs(js.onRemove);
    panel.appendChild(onApplyWrap);
    panel.appendChild(onRemoveWrap);

    const checkbox = panel.querySelector('#theme-editor-js-enabled');
    const disabledTargets = () => panel.querySelectorAll('.theme-js-textarea, .theme-js-format-btn');
    checkbox.addEventListener('change', () => {
        disabledTargets().forEach(el => { el.disabled = !checkbox.checked; });
        dirty = true;
        updateDirtyIndicator();
    });
    panel.querySelectorAll('.theme-js-field').forEach(wireJsField);
    panel.querySelectorAll('.theme-js-textarea').forEach(t => t.addEventListener('input', () => {
        dirty = true;
        updateDirtyIndicator();
    }));

    return panel;
}

function tabList() {
    const categories = [...THEME_VAR_CATEGORIES];
    const extras = Object.keys(workingTheme.cssVars || {})
        .filter(name => !CATALOG_VAR_NAMES.has(name))
        .map(name => ({ name, label: humanizeVarName(name) }));
    if (extras.length) {
        categories.push({
            id: 'other',
            label: `Other (${extras.length})`,
            icon: 'more_horiz',
            description: 'Variables specific to this theme that are not part of the built-in set',
            vars: extras
        });
    }
    categories.push({ id: 'js', label: 'JS Effects', icon: 'code' });
    return categories;
}

function buildTabs() {
    const tabsEl = $('theme-editor-tabs');
    const panelsEl = $('theme-editor-panels');
    tabsEl.innerHTML = '';
    panelsEl.innerHTML = '';

    const categories = tabList();
    if (!categories.some(c => c.id === activeTab)) activeTab = categories[0].id;

    for (const category of categories) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'theme-editor-tab' + (category.id === activeTab ? ' active' : '');
        tab.dataset.tabId = category.id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', category.id === activeTab ? 'true' : 'false');
        const icon = document.createElement('span');
        icon.className = 'material-icons-outlined';
        icon.textContent = category.icon || 'tune';
        const label = document.createElement('span');
        label.textContent = category.label;
        tab.appendChild(icon);
        tab.appendChild(label);
        tab.addEventListener('click', () => window.switchThemeEditorTab(category.id));
        tabsEl.appendChild(tab);

        const panel = category.id === 'js' ? buildJsPanel() : buildVarPanel(category);
        panel.classList.toggle('active', category.id === activeTab);
        panelsEl.appendChild(panel);
    }
}

function updateHeaderIcon() {
    const headerIcon = $('theme-editor-icon');
    if (headerIcon) headerIcon.textContent = workingTheme?.icon || leadingEmoji(workingTheme?.name) || '🎨';
}

function updateModalTitle() {
    const title = $('theme-editor-title');
    if (title) title.textContent = 'Edit Theme';
    const subtitle = $('theme-editor-subtitle');
    if (subtitle) subtitle.textContent = `“${workingTheme?.name || editingThemeId}” — changes preview live; Cancel restores the original.`;
}

// ---------------------------------------------------------------------------
// Open / close / save / cancel
// ---------------------------------------------------------------------------
export async function openThemeEditor(themeId) {
    themeId = themeId || state.config.theme;
    const theme = themeDefinitions[themeId];
    if (!theme || !String(themeId).startsWith('custom-')) {
        emit('toast:show', 'Only custom themes can be edited', 'error');
        return;
    }

    // Remember what was active so "preview off" / Cancel can restore it
    previousThemeId = state.config.theme || 'dark';
    previewEnabled = true;

    // Make the edited theme the active one so the live preview is what the user sees
    if (state.config.theme !== themeId) {
        setState((s) => ({ config: { ...s.config, theme: themeId } }));
        await persistActiveTheme(themeId);
    }

    editingThemeId = themeId;
    originalTheme = JSON.parse(JSON.stringify(theme));
    workingTheme = JSON.parse(JSON.stringify(theme));
    if (!workingTheme.cssVars || typeof workingTheme.cssVars !== 'object') workingTheme.cssVars = {};
    dirty = false;
    activeTab = THEME_VAR_CATEGORIES[0].id;

    $('theme-editor-name').value = workingTheme.name || '';
    $('theme-editor-icon-input').value = workingTheme.icon || '';
    buildTabs();
    updateHeaderIcon();
    updateModalTitle();
    updateDirtyIndicator();
    updatePreviewToggleUI();

    lastTrigger = document.activeElement;
    $('theme-editor-modal').classList.add('active');
    $('theme-editor-name').focus();
}

function closeThemeEditorModal() {
    clearTimeout(previewTimer);
    $('theme-editor-modal').classList.remove('active');
    editingThemeId = null;
    previousThemeId = null;
    previewEnabled = true;
    workingTheme = null;
    originalTheme = null;
    dirty = false;
    updateDirtyIndicator();
    if (lastTrigger && typeof lastTrigger.focus === 'function' && document.contains(lastTrigger)) {
        lastTrigger.focus();
    }
    lastTrigger = null;
}

// Revert to the pre-edit view: restore the snapshot, then put back whatever
// theme was active when the editor opened.
export async function cancelThemeEditor() {
    clearTimeout(previewTimer);
    clearPreviewVars();
    if (editingThemeId) {
        themeDefinitions[editingThemeId] = originalTheme;
        const restoreId = previousThemeId || 'dark';
        if (state.config.theme !== restoreId) {
            setState((s) => ({ config: { ...s.config, theme: restoreId } })); // applies via subscription
            await persistActiveTheme(restoreId);
        } else if (restoreId === editingThemeId && dirty) {
            applyTheme(restoreId); // was showing the working copy — re-assert the pre-edit definition
        }
        refreshCards();
    }
    closeThemeEditorModal();
}

export async function saveThemeEditor() {
    if (!workingTheme || !editingThemeId) return;
    clearTimeout(previewTimer);

    // Validate icon: empty is fine, multi-glyph is rejected (no silent data loss)
    const rawIcon = $('theme-editor-icon-input').value;
    if (rawIcon.trim()) {
        const normalized = normalizeIcon(rawIcon);
        if (normalized === null) {
            emit('toast:show', 'Icon must be a single emoji or glyph', 'error');
            $('theme-editor-icon-input').focus();
            return;
        }
        workingTheme.icon = normalized;
    } else {
        delete workingTheme.icon;
    }

    const name = $('theme-editor-name').value.trim();
    workingTheme.name = name || originalTheme?.name || editingThemeId;

    // JavaScript effects — syntax-check before persisting so a broken theme
    // can't be saved (and fail on every theme switch afterwards)
    const jsEnabled = $('theme-editor-js-enabled')?.checked ?? false;
    if (jsEnabled) {
        const onApply = $('theme-editor-js-onapply')?.value || '';
        const onRemove = $('theme-editor-js-onremove')?.value || '';
        const applyError = onApply.trim() ? compileThemeJs(onApply) : null;
        if (applyError) {
            emit('toast:show', `onApply has a syntax error: ${applyError}`, 'error');
            window.switchThemeEditorTab('js');
            $('theme-editor-js-onapply')?.focus();
            return;
        }
        const removeError = onRemove.trim() ? compileThemeJs(onRemove) : null;
        if (removeError) {
            emit('toast:show', `onRemove has a syntax error: ${removeError}`, 'error');
            window.switchThemeEditorTab('js');
            $('theme-editor-js-onremove')?.focus();
            return;
        }
        if (onApply.trim() || onRemove.trim()) {
            workingTheme.javascript = { onApply, onRemove };
        } else {
            delete workingTheme.javascript;
        }
    } else {
        delete workingTheme.javascript;
    }

    // Clean up effects created by the ORIGINAL theme before swapping definitions;
    // applyTheme() would otherwise invoke the NEW onRemove to clean up. Only
    // needed while the edited theme is actually applied — when the preview is
    // off, the restore already ran the original onRemove exactly once.
    const isApplied = previewEnabled && state.config.theme === editingThemeId;
    const originalRemove = originalTheme?.javascript?.onRemove;
    if (dirty && isApplied && originalRemove && originalRemove.trim()) {
        try {
            const { executeThemeJS } = await import('./state.js');
            executeThemeJS(originalRemove, editingThemeId, 'onRemove');
        } catch (error) {
            console.error('Failed to run original theme cleanup:', error);
        }
    }

    try {
        await updateCustomTheme(editingThemeId, workingTheme);
    } catch (error) {
        console.error('Failed to save theme:', error);
        if (!reportStorageError(error)) emit('toast:show', 'Failed to save theme', 'error');
        return; // keep the modal open; the working copy is intact for retry or Cancel
    }

    clearPreviewVars();
    themeDefinitions[editingThemeId] = workingTheme;
    if (previewEnabled) {
        applyTheme(editingThemeId); // re-applies CSS vars and runs the (possibly new) JS effects
    }
    // preview off: the saved theme is kept but deliberately stays inactive —
    // the app remains on the pre-edit theme
    refreshCards();
    const savedName = workingTheme.name;
    closeThemeEditorModal();
    emit('toast:show', `Theme "${savedName}" saved`, 'success');
}

window.openThemeEditor = openThemeEditor;
window.cancelThemeEditor = cancelThemeEditor;
window.saveThemeEditor = saveThemeEditor;
window.switchThemeEditorTab = (id) => {
    activeTab = id;
    $('theme-editor-tabs')?.querySelectorAll('.theme-editor-tab').forEach(tab => {
        const active = tab.dataset.tabId === id;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('theme-editor-panels')?.querySelectorAll('.theme-editor-panel').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.panel === id);
    });
};

// ---------------------------------------------------------------------------
// New theme from a preset (no AI)
// ---------------------------------------------------------------------------
let presetChoice = 'dark';

export function openThemePresetModal() {
    presetChoice = 'dark';
    $('preset-theme-name').value = '';
    $('preset-theme-icon').value = '';
    updatePresetSelection();
    $('theme-preset-modal').classList.add('active');
    $('preset-theme-name').focus();
}

export function closeThemePresetModal() {
    $('theme-preset-modal').classList.remove('active');
}

function updatePresetSelection() {
    document.querySelectorAll('#preset-options .preset-option').forEach(btn => {
        const active = btn.dataset.preset === presetChoice;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

export async function createThemeFromPreset() {
    const nameInput = $('preset-theme-name');
    const iconInput = $('preset-theme-icon');
    const name = nameInput.value.trim();
    if (!name) {
        emit('toast:show', 'Enter a name for the theme', 'error');
        nameInput.focus();
        return;
    }
    const rawIcon = iconInput.value;
    let icon;
    if (rawIcon.trim()) {
        icon = normalizeIcon(rawIcon);
        if (icon === null) {
            emit('toast:show', 'Icon must be a single emoji or glyph', 'error');
            iconInput.focus();
            return;
        }
    }

    const base = themeDefinitions[presetChoice];
    const theme = {
        name,
        ...(icon ? { icon } : {}),
        description: `Custom theme created from the ${presetChoice} preset`,
        cssVars: JSON.parse(JSON.stringify(base.cssVars || {}))
    };

    let themeId;
    try {
        themeId = await persistCustomTheme(theme);
    } catch (error) {
        console.error('Failed to create theme:', error);
        if (!reportStorageError(error)) emit('toast:show', 'Failed to create theme', 'error');
        return;
    }

    themeDefinitions[themeId] = theme;
    setState((s) => ({ config: { ...s.config, theme: themeId } }));
    await persistActiveTheme(themeId);

    const { renderThemeCards } = await import('./theme-ui.js');
    renderThemeCards();
    closeThemePresetModal();
    emit('toast:show', `Theme "${name}" created — customize it now`, 'success');
    await openThemeEditor(themeId);
}

window.openThemePresetModal = openThemePresetModal;
window.closeThemePresetModal = closeThemePresetModal;
window.selectPreset = (name) => {
    if (name !== 'dark' && name !== 'light') return;
    presetChoice = name;
    updatePresetSelection();
};
window.createThemeFromPreset = createThemeFromPreset;

// Live preview toggle
$('theme-editor-preview-toggle')?.addEventListener('change', (e) => {
    setPreviewEnabled(e.target.checked);
});

// Wire header inputs that stay live during editing
$('theme-editor-name')?.addEventListener('input', () => {
    if (!workingTheme) return;
    workingTheme.name = $('theme-editor-name').value;
    updateModalTitle();
    schedulePreview();
});
$('theme-editor-icon-input')?.addEventListener('input', () => {
    if (!workingTheme) return;
    const normalized = normalizeIcon($('theme-editor-icon-input').value);
    workingTheme.icon = normalized === null ? workingTheme.icon : (normalized || undefined);
    if ($('theme-editor-icon-input').value.trim() === '') delete workingTheme.icon;
    updateHeaderIcon();
    schedulePreview();
});

// Escape / backdrop click cancel (revert), like the other modal flows
$('theme-editor-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) cancelThemeEditor();
});
$('theme-preset-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeThemePresetModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('theme-editor-modal')?.classList.contains('active')) {
        e.stopPropagation();
        cancelThemeEditor();
    } else if ($('theme-preset-modal')?.classList.contains('active')) {
        e.stopPropagation();
        closeThemePresetModal();
    }
}, true); // capture: runs before global shortcut handling
