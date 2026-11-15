#!/usr/bin/env node
// Verifies the theme editor (js/theme-editor.js): per-card edit affordance,
// tabbed variable panels, live preview with debounce, cancel-revert, save
// (colors + adding/removing JS effects), and creating a new theme from a
// preset.
//
// The seeded custom theme deliberately has a sparse cssVars map with one
// theme-specific variable (shows up under the "Other" tab) and no JavaScript.
//
// Usage: node tools/verify-theme-editor.js [--backend auto|lightpanda|playwright] [--base-url URL]

const { run, waitForBoot, openSettings, sleep } = require('./lib');

const CUSTOM_THEMES = {
    'custom-editortest-1': {
        name: 'Editor Test',
        icon: '🧪',
        description: 'Seeded for the theme editor harness',
        cssVars: { '--bg-primary': '#101010', '--accent': '#aabbcc', '--editor-test-extra': '#123456' }
    }
};

function readStoredMap(page) {
    return page.evaluate(`JSON.stringify(JSON.parse(localStorage.getItem('customThemes') || '{}'))`).then(JSON.parse);
}

// Click a button inside a container that matches `finder` (text content match)
function clickButtonIn(page, containerSelector, text) {
    return page.evaluate(`(() => {
        const c = document.querySelector(${JSON.stringify(containerSelector)});
        if (!c) throw new Error('container not found: ' + ${JSON.stringify(containerSelector)});
        const b = Array.from(c.querySelectorAll('button')).find(x => x.textContent.trim().includes(${JSON.stringify(text)}));
        if (!b) throw new Error('button not found: ' + ${JSON.stringify(text)});
        b.click();
        return true;
    })()`);
}

run('verify-theme-editor', async (page, ctx) => {
    const { baseUrl, check } = ctx;

    // Seed, reload so bootstrap picks the theme up
    await page.goto(baseUrl + '/');
    await waitForBoot(page);
    await page.evaluate(`localStorage.setItem('customThemes', ${JSON.stringify(JSON.stringify(CUSTOM_THEMES))})`);
    await page.goto(baseUrl + '/');
    await waitForBoot(page);
    console.log('BOOT_OK (seeded)');

    await openSettings(page);
    await page.click('.settings-tab[data-tab="appearance"]');
    await page.waitFor("document.getElementById('settings-panel-appearance').classList.contains('active')");
    await sleep(300);

    // Edit affordance exists exactly on the custom card
    const editTargets = JSON.parse(await page.evaluate(`JSON.stringify(
        Array.from(document.querySelectorAll('.theme-card-edit')).map(el => el.closest('.theme-card-wrap')?.querySelector('.theme-card')?.dataset.themeCard || null)
    )`));
    check(editTargets.length === 1 && editTargets[0] === 'custom-editortest-1', `edit button on the custom card only (got ${JSON.stringify(editTargets)})`);

    // New Theme card is rendered next to Generate
    const newCardExists = await page.evaluate(`!!Array.from(document.querySelectorAll('.theme-card')).find(c => c.querySelector('.theme-card-name')?.textContent.trim() === 'New Theme')`);
    check(newCardExists, '"New Theme" card rendered');

    // ---- Open the editor ----------------------------------------------------
    await page.click('.theme-card-edit');
    await page.waitFor("document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
    const subtitle = await page.evaluate(`document.getElementById('theme-editor-subtitle').textContent`);
    check(subtitle.includes('Editor Test'), 'editor title reflects the theme being edited');

    const tabs = JSON.parse(await page.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.theme-editor-tab')).map(t => t.querySelector('span:last-child')?.textContent.trim()))`));
    for (const expected of ['Surfaces', 'Text', 'Accent', 'Borders', 'Status', 'Code & Tables', 'Toasts', 'Effects', 'Layout & Type', 'Code Runner', 'JS Effects']) {
        check(tabs.includes(expected), `tab rendered: ${expected}`);
    }
    check(tabs.some(t => t.startsWith('Other')), 'theme-specific variable shows up under "Other"');

    // JS-less theme: toggle off, textareas disabled
    const jsInitial = JSON.parse(await page.evaluate(`JSON.stringify({
        checked: document.getElementById('theme-editor-js-enabled').checked,
        onApplyDisabled: document.getElementById('theme-editor-js-onapply').disabled,
        onRemoveDisabled: document.getElementById('theme-editor-js-onremove').disabled
    })`));
    check(!jsInitial.checked && jsInitial.onApplyDisabled && jsInitial.onRemoveDisabled, 'JS effects toggle starts off for a JS-less theme');

    // ---- Live preview -------------------------------------------------------
    await page.fill('.theme-var-input[data-var="--bg-primary"]', '#222222');
    await sleep(500);
    const previewVal = (await page.evaluate(`document.documentElement.style.getPropertyValue('--bg-primary').trim()`)).trim();
    check(previewVal === '#222222', `live preview applies edited color (got "${previewVal}")`);

    await page.fill('#theme-editor-name', 'Renamed Theme');
    await sleep(500);
    const cardName = await page.evaluate(`document.querySelector('.theme-card[data-theme-card="custom-editortest-1"] .theme-card-name')?.textContent`);
    check(cardName === 'Renamed Theme', `card label updates live (got "${cardName}")`);

    // data-theme reflects the edited (dark) custom theme, not "light" by default
    check(await page.evaluate(`document.documentElement.getAttribute('data-theme')`) === 'dark', 'dark custom theme renders with dark chrome (data-theme)');

    // ---- Live preview toggle -----------------------------------------------
    // Editor opened while "dark" was active; preview starts ON.
    await page.click('#theme-editor-preview-toggle'); // OFF
    await sleep(400);
    const previewOff = JSON.parse(await page.evaluate(`JSON.stringify({
        checked: document.getElementById('theme-editor-preview-toggle').checked,
        bg: document.documentElement.style.getPropertyValue('--bg-primary').trim(),
        activeCard: document.querySelector('.theme-card.active')?.dataset.themeCard || null
    })`));
    check(!previewOff.checked, 'live preview toggles off');
    check(previewOff.bg === '#151518', `preview off restores the pre-edit theme's colors (got "${previewOff.bg}")`);
    check(previewOff.activeCard === 'dark', 'the previously active theme becomes active again');

    // Edits accumulate but don't touch the app while preview is off
    await page.fill('.theme-var-input[data-var="--bg-primary"]', '#444444');
    await sleep(500);
    const offStill = (await page.evaluate(`document.documentElement.style.getPropertyValue('--bg-primary').trim()`)).trim();
    check(offStill === '#151518', `edits do not apply while preview is off (got "${offStill}")`);

    await page.click('#theme-editor-preview-toggle'); // ON
    await sleep(500);
    const backOn = JSON.parse(await page.evaluate(`JSON.stringify({
        bg: document.documentElement.style.getPropertyValue('--bg-primary').trim(),
        activeCard: document.querySelector('.theme-card.active')?.dataset.themeCard || null
    })`));
    check(backOn.bg === '#444444', `toggling preview on re-applies the working theme (got "${backOn.bg}")`);
    check(backOn.activeCard === 'custom-editortest-1', 'toggling preview on re-activates the edited theme');

    // ---- Cancel reverts everything -----------------------------------------
    await clickButtonIn(page, '#theme-editor-modal .theme-editor-footer', 'Cancel');
    await page.waitFor("!document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
    const revertedVal = (await page.evaluate(`document.documentElement.style.getPropertyValue('--bg-primary').trim()`)).trim();
    check(revertedVal === '#151518', `Cancel returns the app to the previously active theme (got "${revertedVal}")`);
    const cancelActiveCard = await page.evaluate(`document.querySelector('.theme-card.active')?.dataset.themeCard`);
    check(cancelActiveCard === 'dark', 'Cancel re-activates the theme that was active before editing');
    const revertedName = await page.evaluate(`document.querySelector('.theme-card[data-theme-card="custom-editortest-1"] .theme-card-name')?.textContent`);
    check(revertedName === 'Editor Test', 'Cancel restores the original name');
    const storedAfterCancel = await readStoredMap(page);
    check(storedAfterCancel['custom-editortest-1']?.cssVars['--bg-primary'] === '#101010', 'Cancel does not persist anything');

    // ---- Save path: color + adding JS to a JS-less theme -------------------
    await page.click('.theme-card-edit');
    await page.waitFor("document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
    await page.fill('.theme-var-input[data-var="--bg-primary"]', '#333333');
    await page.evaluate(`(() => { const t = Array.from(document.querySelectorAll('.theme-editor-tab')).find(x => x.textContent.includes('JS Effects')); t.click(); })()`);
    await page.click('.theme-js-toggle'); // label click toggles the checkbox
    const jsEnabled = JSON.parse(await page.evaluate(`JSON.stringify({
        checked: document.getElementById('theme-editor-js-enabled').checked,
        onApplyDisabled: document.getElementById('theme-editor-js-onapply').disabled
    })`));
    check(jsEnabled.checked && !jsEnabled.onApplyDisabled, 'enabling the toggle unlocks the JS textareas');
    await page.fill('#theme-editor-js-onapply', "document.documentElement.setAttribute('data-editor-js', 'ran');");
    // Syntax highlighting renders spans into the overlay
    const hlSpans = await page.evaluate(`(() => { const code = document.querySelector('#theme-editor-js-onapply').closest('.theme-js-codebox')?.querySelector('.theme-js-highlight code'); return !!code && code.innerHTML.includes('hljs-'); })()`);
    check(hlSpans, 'JS code is syntax highlighted');
    // Format pretty-prints minified code
    await page.fill('#theme-editor-js-onapply', "(function(){themeUtils.addClass('body','x');if(true){themeUtils.addClass('body','y');}})();");
    await page.click('.theme-js-format-btn[data-format="theme-editor-js-onapply"]');
    const lineCount = await page.evaluate(`document.getElementById('theme-editor-js-onapply').value.split('\\n').length`);
    check(lineCount > 3, `format pretty-prints minified JavaScript (got ${lineCount} lines)`);
    // Syntax error blocks saving and is reported
    await page.fill('#theme-editor-js-onapply', "themeUtils.addClass('body',");
    await clickButtonIn(page, '#theme-editor-modal .theme-editor-footer', 'Save');
    await sleep(300);
    check(await page.evaluate(`document.getElementById('theme-editor-modal').classList.contains('active')`), 'Save is blocked when onApply has a syntax error');
    const toastText = await page.evaluate(`document.querySelector('#toast-container')?.textContent || ''`);
    check(toastText.includes('syntax error'), 'syntax error surfaced via toast');
    await page.fill('#theme-editor-js-onapply', "document.documentElement.setAttribute('data-editor-js', 'ran');");
    await clickButtonIn(page, '#theme-editor-modal .theme-editor-footer', 'Save');
    await page.waitFor("!document.getElementById('theme-editor-modal').classList.contains('active')", 5000);

    const storedAfterSave = await readStoredMap(page);
    const savedTheme = storedAfterSave['custom-editortest-1'];
    check(savedTheme?.cssVars['--bg-primary'] === '#333333', 'Save persists edited color');
    check(savedTheme?.javascript?.onApply?.includes('data-editor-js'), 'Save adds JavaScript to a JS-less theme');
    const jsRan = await page.evaluate(`document.documentElement.getAttribute('data-editor-js')`);
    check(jsRan === 'ran', 'onApply executes when the saved theme is applied');
    const appliedInline = (await page.evaluate(`document.documentElement.style.getPropertyValue('--bg-primary').trim()`)).trim();
    check(appliedInline === '#333333', 'Save re-applies the theme');

    // ---- Save with preview OFF: persists but stays inactive -----------------
    // Editor opens while the edited theme is active again after the previous
    // save; switch to dark first so "pre-edit theme" is deterministic.
    await page.click('.theme-card[data-theme-card="dark"]');
    await sleep(400);
    await page.click('.theme-card-edit');
    await page.waitFor("document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
    await page.fill('.theme-var-input[data-var="--accent"]', '#c0ffee');
    await page.click('#theme-editor-preview-toggle'); // OFF
    await sleep(300);
    const offState = JSON.parse(await page.evaluate(`JSON.stringify({
        activeCard: document.querySelector('.theme-card.active')?.dataset.themeCard || null,
        bg: document.documentElement.style.getPropertyValue('--bg-primary').trim()
    })`));
    check(offState.activeCard === 'dark' && offState.bg === '#151518', `preview off restores the pre-edit theme (got card=${offState.activeCard} bg=${offState.bg})`);
    await clickButtonIn(page, '#theme-editor-modal .theme-editor-footer', 'Save');
    await page.waitFor("!document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
    const offSave = JSON.parse(await page.evaluate(`JSON.stringify({
        stored: (JSON.parse(localStorage.getItem('customThemes'))['custom-editortest-1'] || {}).cssVars?.['--accent'],
        activeCard: document.querySelector('.theme-card.active')?.dataset.themeCard || null
    })`));
    check(offSave.stored === '#c0ffee', 'Save with preview off persists the edit');
    check(offSave.activeCard === 'dark', 'Save with preview off leaves the pre-edit theme active');

    // ---- Reopen, JS shows up enabled; disabling removes it ----------------
    await page.click('.theme-card-edit');
    await page.waitFor("document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
    const jsSecondOpen = JSON.parse(await page.evaluate(`JSON.stringify({
        checked: document.getElementById('theme-editor-js-enabled').checked,
        onApplyDisabled: document.getElementById('theme-editor-js-onapply').disabled,
        onApplyValue: document.getElementById('theme-editor-js-onapply').value
    })`));
    check(jsSecondOpen.checked && !jsSecondOpen.onApplyDisabled, 'reopening an edited theme shows JS enabled');
    check(jsSecondOpen.onApplyValue.includes('data-editor-js'), 'reopening an edited theme keeps the code');
    await page.click('.theme-js-toggle'); // disable
    await clickButtonIn(page, '#theme-editor-modal .theme-editor-footer', 'Save');
    await page.waitFor("!document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
    const storedAfterDisable = await readStoredMap(page);
    check(!('javascript' in (storedAfterDisable['custom-editortest-1'] || {})), 'disabling JS removes the javascript key');

    // ---- Preset creation (no AI) -------------------------------------------
    const themesBefore = Object.keys(await readStoredMap(page)).length;
    await page.click('.theme-card-new');
    await page.waitFor("document.getElementById('theme-preset-modal').classList.contains('active')", 5000);

    // Empty name: modal stays open, nothing created
    await page.fill('#preset-theme-name', '');
    await clickButtonIn(page, '#theme-preset-modal', 'Create');
    await sleep(300);
    check(await page.evaluate(`document.getElementById('theme-preset-modal').classList.contains('active')`), 'empty name keeps the preset modal open');
    check(Object.keys(await readStoredMap(page)).length === themesBefore, 'empty name creates nothing');

    await page.fill('#preset-theme-name', 'Harness Preset');
    await page.fill('#preset-theme-icon', '🚀');
    await page.click('.preset-option[data-preset="light"]');
    await clickButtonIn(page, '#theme-preset-modal', 'Create');
    await page.waitFor("document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
    check(true, 'preset creation opens the editor on the new theme');

    const createdMap = await readStoredMap(page);
    const createdId = Object.keys(createdMap).find(id => createdMap[id]?.name === 'Harness Preset');
    check(!!createdId, 'preset theme persisted');
    check(createdId && createdMap[createdId].cssVars['--bg-primary'] === '#ffffff', 'preset theme copies the light palette');
    check(createdId && createdMap[createdId].icon === '🚀', 'preset theme keeps the icon');
    check(createdId && createdMap[createdId].cssVars && Object.keys(createdMap[createdId].cssVars).length > 100, 'preset theme copies the full built-in palette');

    const editorSubtitle = await page.evaluate(`document.getElementById('theme-editor-subtitle').textContent`);
    check(editorSubtitle.includes('Harness Preset'), 'editor is editing the freshly created theme');
    const cardActive = createdId && await page.evaluate(`document.querySelector('.theme-card[data-theme-card="${createdId}"]')?.classList.contains('active')`);
    check(!!cardActive, 'created theme becomes the active theme');
    check(await page.evaluate(`document.documentElement.getAttribute('data-theme')`) === 'light', 'light preset theme renders with light chrome (data-theme)');

    // Clean up: leave the editor via Cancel (nothing to persist)
    await clickButtonIn(page, '#theme-editor-modal .theme-editor-footer', 'Cancel');
    await page.waitFor("!document.getElementById('theme-editor-modal').classList.contains('active')", 5000);
});
