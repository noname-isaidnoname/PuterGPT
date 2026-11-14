#!/usr/bin/env node
// End-to-end check of the settings modal on desktop:
// boot, open via the sidebar button, tab switching, toggles, theme cards,
// save/discard/close flows, and screenshots of every panel.
//
// Usage: node tools/verify-settings.js [--base-url URL] [--screenshot-dir DIR]

const { run, waitForBoot, openSettings } = require('./lib');

run('verify-settings', async (page, ctx) => {
    const { baseUrl, check } = ctx;

    await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
    await waitForBoot(page);
    console.log('BOOT_OK');

    // Open settings via the real sidebar button
    await openSettings(page);
    check(true, 'settings modal opens from sidebar button');
    await ctx.shot(page, 'settings-general.png');

    // Default tab is General
    check(await page.$eval('.settings-tab.active', el => el.dataset.tab) === 'general', 'default tab is general');
    check(await page.$eval('#settings-panel-general', el => el.classList.contains('active')), 'general panel visible');

    // Tab switching
    for (const tab of ['model', 'tokens', 'appearance', 'general']) {
        await page.click(`.settings-tab[data-tab="${tab}"]`);
        await page.waitForSelector(`#settings-panel-${tab}.active`);
        check(await page.$eval('.settings-tab.active', el => el.dataset.tab) === tab, `tab switch: ${tab}`);
        await page.waitForTimeout(300);
        await ctx.shot(page, `settings-${tab}.png`);
    }

    // Auto-scroll switch flips on click
    const before = await page.$eval('#auto-scroll', el => el.checked);
    await page.click('.switch:has(#auto-scroll) .switch-track');
    check(await page.$eval('#auto-scroll', el => el.checked) === !before, 'auto-scroll toggle flips');
    await page.click('.switch:has(#auto-scroll) .switch-track'); // flip back

    // Web search switch flips on click
    await page.click('.settings-tab[data-tab="model"]');
    const wsBefore = await page.$eval('#enable-web-search', el => el.checked);
    await page.click('.switch:has(#enable-web-search) .switch-track');
    check(await page.$eval('#enable-web-search', el => el.checked) === !wsBefore, 'web search toggle flips');
    await page.click('.switch:has(#enable-web-search) .switch-track'); // flip back

    // Appearance: theme cards apply dark/light
    await page.click('.settings-tab[data-tab="appearance"]');
    await page.click('.theme-card[data-theme-card="dark"]');
    await page.waitForTimeout(300);
    check(await page.$eval('.theme-card[data-theme-card="dark"]', el => el.classList.contains('active')), 'dark theme card activates');
    await ctx.shot(page, 'settings-dark.png');
    await page.click('.theme-card[data-theme-card="light"]');
    await page.waitForTimeout(300);
    check(await page.$eval('.theme-card[data-theme-card="light"]', el => el.classList.contains('active')), 'light theme card activates');

    // Save closes the modal
    await page.click('.settings-tab[data-tab="general"]');
    await page.click('.settings-footer .btn.primary');
    await page.waitForSelector('#settings-modal:not(.active)', { timeout: 3000 });
    check(true, 'save closes the modal');

    // With no changes, the × button closes directly
    await openSettings(page);
    await page.click('.settings-close');
    await page.waitForSelector('#settings-modal:not(.active)', { timeout: 3000 });
    check(true, '× closes modal with no changes');

    // With changes, × opens the discard confirmation
    await openSettings(page);
    await page.click('.switch:has(#auto-scroll) .switch-track'); // make a change
    await page.click('.settings-close');
    await page.waitForSelector('#settings-confirm-modal.active', { timeout: 3000 });
    check(await page.$eval('#settings-modal', el => el.classList.contains('active')), '× with changes keeps settings open behind confirm');
    await page.click('#settings-confirm-modal .btn.danger'); // Discard
    await page.waitForSelector('#settings-confirm-modal:not(.active)', { timeout: 3000 });
    check(!(await page.$eval('#settings-modal', el => el.classList.contains('active'))), 'discard closes settings');
});
