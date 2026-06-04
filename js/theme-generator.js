import { state, els } from './state.js';
import { themeDefinitions } from './store.js';
import { emit } from './event-bus.js';

// Custom themes storage
let customThemes = JSON.parse(localStorage.getItem('customThemes') || '{}');

// Theme generator functions
window.openThemeGenerator = () => {
    els.themeGeneratorModal.classList.add('active');
    loadThemeModels();
    els.themePrompt.value = '';
    els.generateJavaScript.checked = false;
};

window.closeThemeGenerator = () => {
    els.themeGeneratorModal.classList.remove('active');
};

window.refreshThemeModels = async () => {
    await loadThemeModels();
};

// Load models for theme generation
async function loadThemeModels() {
    try {
        // Use the same populateModelSelect function that works for the main model dropdown
        const { populateModelSelect } = await import('./models.js');
        
        // Clear cached models to force API call
        const { db } = await import('./indexeddb-storage.js');
        await db.settings.delete('cached_models');
        
        // Load fresh models from API
        const { loadModels } = await import('./models.js');
        await loadModels();
        
        // Use the same populate function but target theme dropdown
        const models = state.models;
        const { populateSelectWithModels } = await import('./models.js');
        populateSelectWithModels(els.themeModelSelect, models);

    } catch (error) {
        console.error('Failed to load theme models:', error);
        emit('toast:show', 'Failed to load AI models for theme generation', 'error');
    }
}

// Filter theme models
window.filterThemeModels = () => {
    const searchTerm = els.themeModelSearch.value.toLowerCase();
    const freeOnly = els.themeFreeOnly.checked;
    
    Array.from(els.themeModelSelect.options).forEach(option => {
        const modelId = option.value;
        const model = state.models.find(m => m.id === modelId);
        const matchesSearch = option.textContent.toLowerCase().includes(searchTerm);
        const isFree = model?.costInfo?.isFree || option.textContent.includes('(Free)');
        const shouldShow = matchesSearch && (!freeOnly || isFree);
        
        option.style.display = shouldShow ? 'block' : 'none';
    });
};

/**
 * Safely parse a JSON string that may contain:
 * - Markdown code fences (```json ... ```)
 * - Unescaped control characters (literal newlines/tabs inside string values)
 * - Extra text before/after the JSON object
 */
function safelyParseThemeJson(text) {
    if (!text) return null;
    
    // Step 1: Strip markdown code fences (```json ... ``` or ``` ... ```)
    let cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    
    // Step 2: Extract JSON object via balanced braces (handles nested objects)
    // Find the first '{' and match its closing '}'
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) return null;
    
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let endIdx = -1;
    
    for (let i = firstBrace; i < cleaned.length; i++) {
        const char = cleaned[i];
        
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        
        if (inString) {
            if (char === '\\') {
                escapeNext = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        
        if (char === '"') {
            inString = true;
            continue;
        }
        
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                endIdx = i + 1;
                break;
            }
        }
    }
    
    if (endIdx === -1) return null;
    
    let jsonStr = cleaned.substring(firstBrace, endIdx);
    
    // Step 3: Sanitize unescaped control characters within string values
    // First, find all string values and fix literal newlines/tabs inside them
    jsonStr = sanitizeJsonStringValues(jsonStr);
    
    // Step 4: Try to parse
    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        // If still failing, try a more aggressive approach:
        // Replace all literal newlines with \n, tabs with \t, etc.
        jsonStr = jsonStr
            .replace(/\r\n/g, '\\n')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t');
        
        try {
            return JSON.parse(jsonStr);
        } catch (e2) {
            // Last resort: try to manually construct a minimal valid theme
            // from whatever partial JSON we can salvage
            return salvageThemeJson(jsonStr);
        }
    }
}

/**
 * Sanitizes unescaped control characters (newlines, tabs) within JSON string values.
 * This handles the case where the AI writes multi-line CSS values like gradients
 * with literal line breaks inside them.
 */
function sanitizeJsonStringValues(str) {
    let result = '';
    let inString = false;
    let escapeNext = false;
    
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        
        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }
        
        if (inString) {
            if (char === '\\') {
                escapeNext = true;
                result += char;
            } else if (char === '"') {
                inString = false;
                result += char;
            } else if (char === '\n' || char === '\r') {
                // Replace literal newlines inside strings with \n escape sequence
                result += '\\n';
            } else if (char === '\t') {
                result += '\\t';
            } else {
                result += char;
            }
        } else {
            result += char;
            if (char === '"') {
                inString = true;
            }
        }
    }
    
    return result;
}

/**
 * Last resort: try to salvage a usable theme from broken JSON.
 * Extracts any key-value pairs that can be parsed.
 */
function salvageThemeJson(str) {
    try {
        // Try to extract name
        const nameMatch = str.match(/"name"\s*:\s*"([^"]*)"/);
        const descMatch = str.match(/"description"\s*:\s*"([^"]*)"/);
        
        if (!nameMatch) return null;
        
        // Try to extract any CSS variables we can find
        const cssVars = {};
        const varRegex = /"(--[\w-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let match;
        while ((match = varRegex.exec(str)) !== null) {
            cssVars[match[1]] = match[2];
        }
        
        if (Object.keys(cssVars).length === 0) return null;
        
        return {
            name: nameMatch[1],
            description: descMatch ? descMatch[1] : 'Salvaged custom theme',
            cssVars: cssVars
        };
    } catch (e) {
        return null;
    }
}

// Static metadata describing the application structure — given to the model
// as context when it generates a new theme. Kept here so it doesn't bloat
// the generation function.
const UI_STRUCTURE = {
    layout: {
        sidebar: "Left sidebar with navigation, saved chats, settings button",
        main: "Main chat area with messages container and input area at bottom",
        modals: "Settings modal, theme generator modal, confirmation modals"
    },
    elements: {
        buttons: ["Primary buttons", "Secondary buttons", "Icon buttons", "Danger buttons"],
        messages: ["User messages", "AI messages", "Message avatars", "Message content"],
        inputs: ["Text input area", "File inputs", "Select dropdowns", "Checkboxes"],
        interactive: ["Hover states", "Focus states", "Loading states", "Tooltips"]
    },
    components: {
        chat: "Message bubbles, typing indicators, scroll areas, image previews",
        sidebar: "Chat list, new chat button, search toggle, settings access",
        modals: "Overlay backgrounds, modal containers, form elements, action buttons"
    }
};

const CSS_FILE_DESCRIPTIONS = [
    "base.css - Basic body styles and reset",
    "sidebar.css - Sidebar layout and navigation styles",
    "chat.css - Message bubbles and chat container styles",
    "input.css - Message input area and button styles",
    "modal.css - Modal overlay and container styles",
    "animations.css - Transitions and keyframe animations",
    "ui-elements.css - Buttons, forms, and interactive elements",
    "responsive.css - Mobile and responsive design styles"
];

const CSS_FILES_TO_FETCH = ['base', 'sidebar', 'chat', 'input', 'modal', 'animations', 'ui-elements', 'responsive'];
const CSS_CACHE_KEY = 'css_contents_cache';
const CSS_CACHE_DURATION = 30 * 60 * 1000;

const REQUIRED_CSS_VARS = [
    "--bg-primary", "--bg-secondary", "--bg-sidebar",
    "--text-primary", "--text-secondary", "--border-color",
    "--input-bg", "--user-msg-bg", "--ai-msg-bg",
    "--accent", "--accent-hover", "--danger", "--warning",
    "--btn-hover-bg", "--btn-hover-border", "--btn-primary-hover-bg",
    "--input-focus-border", "--hover-overlay",
    "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl",
    "--font-sans", "--shadow-sm", "--shadow-md",
    "--user-avatar-bg", "--gradient-start", "--input-border-radius",
    "--focus-border", "--hover-light", "--danger-hover", "--danger-bg", "--danger-border",
    "--modal-overlay", "--sidebar-width", "--avatar-size", "--font-mono",
    "--scrollbar-width", "--scrollbar-width-modal", "--message-border-radius",
    "--code-bg", "--code-border", "--pre-bg",
    "--blockquote-bg", "--blockquote-border",
    "--link-color", "--link-hover",
    "--table-border", "--table-header-bg", "--table-row-hover",
    "--scrollbar-track", "--scrollbar-thumb", "--scrollbar-thumb-hover",
    "--selection-bg", "--loading-spinner", "--typing-indicator",
    "--sidebar-hover", "--chat-bg-pattern", "--glow-effect",
    "--transition-speed", "--animation-easing"
];

const STANDARD_VARS_DOC = REQUIRED_CSS_VARS.map(v => `    "${v}": "string"`).join(',\n');

const JS_ENHANCEMENT_DOC = `
JAVASCRIPT ENHANCEMENTS:
- Use themeUtils.addClass(selector, className) to add CSS classes
- Use themeUtils.removeClass(selector, className) to remove CSS classes
- Use themeUtils.toggleClass(selector, className) to toggle classes
- Use themeUtils.addAnimation(selector, animation) to add CSS animations
- Use themeUtils.setCSSVar(varName, value) to dynamically set CSS variables
- Use themeUtils.createElement(tag, attributes, text) to create elements
- Use themeUtils.appendTo(selector, element) to add elements to DOM
- Use themeUtils.addEventListener(selector, event, handler) for interactions
- Use themeUtils.storage for persisting theme-specific data
- Access to Math, Date, JSON, localStorage, sessionStorage for advanced effects`;

// Generate custom theme
window.generateCustomTheme = async () => {
    const prompt = els.themePrompt.value.trim();
    const generateJS = els.generateJavaScript.checked;
    const selectedModel = els.themeModelSelect.value;

    if (!validateGenerationInputs(prompt, selectedModel)) return;

    const generateBtn = event.target;
    const originalText = generateBtn.innerHTML;

    try {
        setGenerateButtonBusy(generateBtn);
        const cssContents = await loadCssContentsForContext();
        const theme = await requestThemeFromModel({ prompt, selectedModel, generateJS, cssContents });
        const themeId = persistCustomTheme(theme);
        applyNewTheme(themeId, theme.name);
    } catch (error) {
        console.error('Theme generation failed:', error);
        emit('toast:show', `Failed to generate theme: ${error.message}`, 'error');
    } finally {
        restoreGenerateButton(generateBtn, originalText);
    }
};

function validateGenerationInputs(prompt, selectedModel) {
    if (!prompt) {
        emit('toast:show', 'Please describe your desired theme', 'error');
        return false;
    }
    if (!selectedModel) {
        emit('toast:show', 'Please select an AI model', 'error');
        return false;
    }
    return true;
}

function setGenerateButtonBusy(btn) {
    btn.innerHTML = '<span class="material-icons-outlined" style="font-size:16px">hourglass_empty</span> Generating...';
    btn.disabled = true;
}

function restoreGenerateButton(btn, originalText) {
    btn.innerHTML = originalText;
    btn.disabled = false;
}

async function loadCssContentsForContext() {
    const cssContents = {};
    try {
        const { db } = await import('./indexeddb-storage.js');
        await tryLoadFromCache(db, cssContents);
        if (Object.keys(cssContents).length === 0) {
            await fetchAllCssFiles(cssContents);
            await cacheCssContents(db, cssContents);
        }
    } catch (error) {
        console.error('Failed to read CSS files for context:', error);
        await fallbackToCache(cssContents);
    }
    return cssContents;
}

async function tryLoadFromCache(db, cssContents) {
    const cached = await db.settings.get(CSS_CACHE_KEY);
    if (cached && cached.value) {
        const { data, timestamp } = cached.value;
        if (Date.now() - timestamp < CSS_CACHE_DURATION) {
            Object.assign(cssContents, data);
            console.log('Loaded CSS contents from IndexedDB cache');
        }
    }
}

async function fetchAllCssFiles(cssContents) {
    for (const fileName of CSS_FILES_TO_FETCH) {
        cssContents[fileName] = await fetchCssWithRetry(fileName);
    }
}

async function fetchCssWithRetry(fileName, maxAttempts = 3) {
    let delay = 1000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(`css/${fileName}.css`, {
                cache: 'no-cache',
                headers: { 'Cache-Control': 'no-cache' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        } catch (error) {
            console.warn(`Attempt ${attempt} failed for ${fileName}.css:`, error.message);
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                console.error(`Failed to fetch ${fileName}.css after ${maxAttempts} attempts`);
                return readCachedCssFallback(fileName);
            }
        }
    }
}

async function readCachedCssFallback(fileName) {
    try {
        const { db } = await import('./indexeddb-storage.js');
        const cached = await db.settings.get(CSS_CACHE_KEY);
        if (cached?.value?.data?.[fileName]) {
            console.log(`Using cached version for ${fileName}.css`);
            return cached.value.data[fileName];
        }
    } catch (e) { /* ignore */ }
    return '';
}

async function cacheCssContents(db, cssContents) {
    if (Object.keys(cssContents).length > 0) {
        await db.settings.put({
            key: CSS_CACHE_KEY,
            value: { data: cssContents, timestamp: Date.now() }
        });
        console.log('Cached CSS contents in IndexedDB for future use');
    }
}

async function fallbackToCache(cssContents) {
    try {
        const { db } = await import('./indexeddb-storage.js');
        const cached = await db.settings.get(CSS_CACHE_KEY);
        if (cached?.value?.data) {
            Object.assign(cssContents, cached.value.data);
            console.log('Using IndexedDB cached CSS contents as fallback');
        }
    } catch (cacheError) {
        console.error('IndexedDB cache fallback also failed:', cacheError);
    }
}

function buildSystemPrompt({ prompt, generateJS, cssContents }) {
    const cssContextStr = Object.entries(cssContents)
        .map(([fileName, content]) => `\n--- ${fileName}.css ---\n${content}`)
        .join('\n');

    const jsSection = generateJS ? `- You can create interactive effects with JavaScript${JS_ENHANCEMENT_DOC}` : '';
    const jsRequirement = generateJS
        ? `,
  "javascript": {
    "onApply": "string (JavaScript code for theme application - can add classes, create animations, modify elements)",
    "onRemove": "string (JavaScript cleanup code - must reverse ALL changes made in onApply)"
  }`
        : '';
    const jsPrinciple = generateJS
        ? `- If using JavaScript effects, make them enhance rather than distract`
        : `- Focus on CSS-only theme enhancements (no JavaScript)`;
    const jsRule = generateJS
        ? `- If generating JavaScript, ensure proper cleanup in onRemove`
        : `- Do NOT generate any JavaScript code in your response`;

    return `You are a creative theme generation expert with full access to customize the entire PuterGPT chat application interface.

CONTEXT:
1. CURRENT THEMES: Here are the existing theme definitions for reference:
${JSON.stringify(themeDefinitions, null, 2)}

2. UI STRUCTURE: This is the application layout you're styling:
${JSON.stringify(UI_STRUCTURE, null, 2)}

3. CSS FILES: These are the stylesheets you can influence:
${CSS_FILE_DESCRIPTIONS.join('\n')}

4. ACTUAL CSS CONTENTS: Here are the current CSS files for complete context:
${cssContextStr}

CREATIVE FREEDOM & CAPABILITIES:
- You can create ANY visual style - from minimal to highly decorative
- Experiment with gradients, animations, shadows, and modern design trends
- Consider accessibility, contrast, and user experience
- You may suggest additional CSS variables beyond the standard set
- Think about the entire user journey and emotional impact
${jsSection}

REQUIREMENTS:
1. Generate a valid JSON object with this structure:
{
  "name": "string (creative theme name with emoji that captures the essence)",
  "description": "string (brief description of the theme's mood and style)",
  "cssVars": {
${STANDARD_VARS_DOC}
    // Optional creative variables (add if your theme needs them)
    // "--custom-gradient-1": "string",
    // "--custom-animation-speed": "string",
    // "--custom-glow-color": "string",
    // "--custom-pattern-bg": "string"
  }${jsRequirement}
}

DESIGN PRINCIPLES:
- Create a cohesive visual experience across all components
- Ensure good contrast ratios for readability
- Consider how colors work together in different contexts
- Think about the emotional impact and user comfort
- Be creative but maintain usability
${jsPrinciple}

CRITICAL RULES:
- Respond with ONLY the JSON object, no other text
- All CSS values must be valid CSS strings (colors, sizes, fonts)
- Theme name should be creative and descriptive with appropriate emoji
${jsRule}
- Be ambitious - create something unique and memorable!

USER REQUEST: ${prompt}`;
}

async function requestThemeFromModel({ prompt, selectedModel, generateJS, cssContents }) {
    const systemPrompt = buildSystemPrompt({ prompt, generateJS, cssContents });
    const { tokenManager } = await import('./token-manager.js');
    const apiToken = await tokenManager.getApiToken();

    const response = await fetch('https://api.puter.com/drivers/call', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiToken || ''}`,
            'Accept': '*/*'
        },
        body: JSON.stringify({
            interface: 'puter-chat-completion',
            driver: 'ai-chat',
            method: 'complete',
            args: {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Generate a theme: ${prompt}` }
                ],
                model: selectedModel,
                stream: false
            }
        })
    });

    if (!response.ok) throw new Error('Failed to generate theme');

    const data = await response.json();
    const themeRaw = extractThemeContent(data);
    if (!themeRaw) {
        throw new Error('No theme generated - AI response was empty');
    }

    const finishReason = data.result?.finish_reason || data.result?.native_finish_reason;
    if (finishReason === 'length') {
        throw new Error('This model ran out of output capacity while generating the theme. Please try switching to a different model with larger output limits.');
    }

    return parseAndValidateTheme(themeRaw);
}

function extractThemeContent(data) {
    return data.result?.message?.content
        || data.result?.content
        || data.choices?.[0]?.message?.content
        || data.message?.content
        || null;
}

function parseAndValidateTheme(themeRaw) {
    const theme = safelyParseThemeJson(themeRaw);
    if (!theme) throw new Error('Invalid JSON response from AI - could not parse theme');
    if (!theme.name || !theme.cssVars) {
        throw new Error('Invalid theme structure - missing name or CSS variables');
    }
    return theme;
}

function generateCustomThemeId() {
    return `custom-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

function persistCustomTheme(theme) {
    const themeId = generateCustomThemeId();

    // Re-read localStorage to get the latest state (a theme may have been
    // deleted since page load).
    const currentCustomThemes = JSON.parse(localStorage.getItem('customThemes') || '{}');
    currentCustomThemes[themeId] = theme;
    localStorage.setItem('customThemes', JSON.stringify(currentCustomThemes));
    customThemes = currentCustomThemes;

    return themeId;
}

async function applyNewTheme(themeId, themeName) {
    const { db } = await import('./indexeddb-storage.js');
    await db.settings.put({ key: 'customThemes', value: customThemes });
    themeDefinitions[themeId] = customThemes[themeId];

    import('./state.js').then(m => m.applyTheme(themeId));
    const { populateThemeDropdown } = await import('./theme-ui.js');
    populateThemeDropdown();
    els.themeSelect.value = themeId;
    closeThemeGenerator();

    emit('toast:show', `Custom theme "${themeName}" created and applied!`, 'success');
}

// Load custom themes on startup
export async function loadCustomThemes() {
    try {
        // Use localStorage as the source of truth
        // IndexedDB writes might not always persist on first attempt (race conditions, etc.),
        // so localStorage (which is more reliable for simple key-value storage)
        // is treated as authoritative. IndexedDB is synced to match localStorage.
        const localData = localStorage.getItem('customThemes');
        let localThemes = {};
        if (localData) {
            try {
                localThemes = JSON.parse(localData);
            } catch (e) {
                console.warn('Failed to parse localStorage customThemes, ignoring', e);
            }
        }
        
        // Start with localStorage themes (deleted themes are correctly absent here)
        customThemes = {};
        Object.entries(localThemes).forEach(([id, theme]) => {
            customThemes[id] = theme;
        });
        
        // Load themes into definitions
        Object.entries(customThemes).forEach(([id, theme]) => {
            themeDefinitions[id] = theme;
        });
        
        // Sync IndexedDB to match localStorage
        const { db } = await import('./indexeddb-storage.js');
        localStorage.setItem('customThemes', JSON.stringify(customThemes));
        await db.settings.put({ key: 'customThemes', value: customThemes }).catch(err => {
            console.warn('Failed to sync custom themes to IndexedDB:', err);
        });
        
    } catch (error) {
        console.error('Failed to load custom themes:', error);
        // Fallback to localStorage
        customThemes = JSON.parse(localStorage.getItem('customThemes') || '{}');
        Object.entries(customThemes).forEach(([id, theme]) => {
            themeDefinitions[id] = theme;
        });
    }
}

// Handle theme select change for custom option
export function handleThemeSelectChange(e) {
    if (e.target.value === 'generate-custom') {
        openThemeGenerator();
        // Reset to previous theme
        e.target.value = window.currentTheme || 'dark';
    }
}