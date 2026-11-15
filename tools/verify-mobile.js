#!/usr/bin/env node
// Mobile-viewport check (420x850): the sidebar is off-canvas on mobile,
// so settings is opened from the welcome view's "Configure Tokens" button.
//
// Usage: node tools/verify-mobile.js [--backend auto|lightpanda|playwright] [--base-url URL] [--screenshot-dir DIR]
// Note: lightpanda has no graphical engine, so --viewport has no effect on it;
// mobile checks are only meaningful with the playwright backend.

const { run, waitForBoot, sleep } = require('./lib');

run('verify-mobile', { viewport: { width: 420, height: 850 } }, async (page, ctx) => {
    const { baseUrl, check, backend } = ctx;
    if (backend !== 'playwright') {
        console.log('NOTE: mobile checks are only meaningful on the playwright backend (lightpanda has no graphical engine).');
    }

    await page.goto(baseUrl + '/');
    await waitForBoot(page);
    console.log('BOOT_OK');

    const canClickWelcome = await page.evaluate(
        "Array.from(document.querySelectorAll('.welcome-actions .btn')).some(b => b.textContent.includes('Configure'))"
    );
    check(canClickWelcome, 'welcome "Configure Tokens" button present on mobile');

    await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('.welcome-actions .btn')).find(x => x.textContent.includes('Configure')); b.click(); })()`);
    await page.waitFor("document.getElementById('settings-modal').classList.contains('active')", 3000);
    await sleep(400);
    check(true, 'settings modal opens from welcome view');
    await ctx.shot('mobile-general.png');

    // Tabs remain reachable via the horizontal scroll row
    await page.click('.settings-tab[data-tab="tokens"]');
    await page.waitFor("document.getElementById('settings-panel-tokens').classList.contains('active')");
    check(true, 'tokens tab reachable');
    await ctx.shot('mobile-tokens.png');

    await page.click('.settings-tab[data-tab="appearance"]');
    await page.waitFor("document.getElementById('settings-panel-appearance').classList.contains('active')");
    check(true, 'appearance tab reachable');
    await ctx.shot('mobile-appearance.png');

    await page.click('.settings-tab[data-tab="data"]');
    await page.waitFor("document.getElementById('settings-panel-data').classList.contains('active')");
    await sleep(400);
    check(true, 'data tab reachable');
    await ctx.shot('mobile-data.png');
});
