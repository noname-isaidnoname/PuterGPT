#!/usr/bin/env node
// End-to-end check of the settings modal on desktop:
// boot, open via the sidebar button, tab switching, toggles, theme cards,
// save/discard/close flows. Screenshots via the playwright backend only.
//
// Usage: node tools/verify-settings.js [--backend auto|lightpanda|playwright] [--base-url URL] [--screenshot-dir DIR]

const { run, waitForBoot, openSettings } = require('./lib');

run('verify-settings', async (page, ctx) => {
    const { baseUrl, check } = ctx;

    await page.goto(baseUrl + '/');
    await waitForBoot(page);
    console.log('BOOT_OK');

    // Open settings via the real sidebar button
    await openSettings(page);
    check(true, 'settings modal opens from sidebar button');
    await ctx.shot('settings-general.png');

    // Default tab is General
    check(await page.evaluate("document.querySelector('.settings-tab.active')?.dataset.tab") === 'general', 'default tab is general');
    check(await page.evaluate("document.getElementById('settings-panel-general').classList.contains('active')"), 'general panel visible');

    // Tab switching
    for (const tab of ['model', 'tokens', 'appearance', 'data', 'general']) {
        await page.click(`.settings-tab[data-tab="${tab}"]`);
        await page.waitFor(`document.getElementById('settings-panel-${tab}').classList.contains('active')`);
        check(await page.evaluate("document.querySelector('.settings-tab.active')?.dataset.tab") === tab, `tab switch: ${tab}`);
        await new Promise(r => setTimeout(r, 300));
        await ctx.shot(`settings-${tab}.png`);
    }

    await page.click('.settings-tab[data-tab="data"]');
    check(!(await page.evaluate("document.getElementById('backup-include-tokens').checked")), 'backup tokens default off');
    await page.click('#backup-include-tokens');
    check(await page.evaluate("document.getElementById('backup-include-tokens').checked"), 'backup token switch toggles on');
    await page.click('#backup-include-tokens');
    await page.click('.settings-tab[data-tab="general"]');

    // Auto-scroll switch flips on click
    const before = await page.evaluate("document.getElementById('auto-scroll').checked");
    await page.click('#auto-scroll');
    check(await page.evaluate("document.getElementById('auto-scroll').checked") === !before, 'auto-scroll toggle flips');
    await page.click('#auto-scroll'); // flip back

    // Web search switch flips on click
    await page.click('.settings-tab[data-tab="model"]');
    const wsBefore = await page.evaluate("document.getElementById('enable-web-search').checked");
    await page.click('#enable-web-search');
    check(await page.evaluate("document.getElementById('enable-web-search').checked") === !wsBefore, 'web search toggle flips');
    await page.click('#enable-web-search'); // flip back

    // Appearance: theme cards apply dark/light
    await page.click('.settings-tab[data-tab="appearance"]');
    await page.click('.theme-card[data-theme-card="dark"]');
    await new Promise(r => setTimeout(r, 300));
    check(await page.evaluate("document.querySelector('.theme-card[data-theme-card=\"dark\"]').classList.contains('active')"), 'dark theme card activates');
    await ctx.shot('settings-dark.png');
    await page.click('.theme-card[data-theme-card="light"]');
    await new Promise(r => setTimeout(r, 300));
    check(await page.evaluate("document.querySelector('.theme-card[data-theme-card=\"light\"]').classList.contains('active')"), 'light theme card activates');

    // Token rotation switch flips on click
    await page.click('.settings-tab[data-tab="tokens"]');
    const trBefore = await page.evaluate("document.getElementById('token-rotation').checked");
    await page.click('#token-rotation');
    check(await page.evaluate("document.getElementById('token-rotation').checked") === !trBefore, 'token rotation toggle flips');
    await page.click('#token-rotation'); // flip back

    // Save closes the modal
    await page.click('.settings-tab[data-tab="general"]');
    await page.click('.settings-footer .btn.primary');
    await page.waitFor("!document.getElementById('settings-modal').classList.contains('active')", 3000);
    check(true, 'save closes the modal');

    // With no changes, the × button closes directly
    await openSettings(page);
    await page.click('.settings-close');
    await page.waitFor("!document.getElementById('settings-modal').classList.contains('active')", 3000);
    check(true, '× closes modal with no changes');

    // With changes, × opens the discard confirmation
    await openSettings(page);
    await page.click('#auto-scroll'); // make a change
    await page.click('.settings-close');
    await page.waitFor("document.getElementById('settings-confirm-modal').classList.contains('active')", 3000);
    check(await page.evaluate("document.getElementById('settings-modal').classList.contains('active')"), '× with changes keeps settings open behind confirm');
    await page.click('#settings-confirm-modal .btn.danger'); // Discard
    await page.waitFor("!document.getElementById('settings-confirm-modal').classList.contains('active')", 3000);
    check(!(await page.evaluate("document.getElementById('settings-modal').classList.contains('active')")), 'discard closes settings');
});
