#!/usr/bin/env node
// Mobile-viewport check (420x850): the sidebar is off-canvas on mobile,
// so settings is opened from the welcome view's "Configure Tokens" button.
//
// Usage: node tools/verify-mobile.js [--base-url URL] [--screenshot-dir DIR]

const { run, waitForBoot } = require('./lib');

run('verify-mobile', { viewport: { width: 420, height: 850 } }, async (page, ctx) => {
    const { baseUrl, check } = ctx;

    await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
    await waitForBoot(page);
    console.log('BOOT_OK');

    await page.click('.welcome-actions .btn.primary');
    await page.waitForSelector('#settings-modal.active', { timeout: 3000 });
    await page.waitForTimeout(400);
    check(true, 'settings modal opens from welcome view on mobile');
    await ctx.shot(page, 'mobile-general.png');

    // Tabs remain reachable via the horizontal scroll row
    await page.click('.settings-tab[data-tab="tokens"]');
    await page.waitForSelector('#settings-panel-tokens.active');
    check(true, 'tokens tab reachable on mobile');
    await ctx.shot(page, 'mobile-tokens.png');

    await page.click('.settings-tab[data-tab="appearance"]');
    await page.waitForSelector('#settings-panel-appearance.active');
    await ctx.shot(page, 'mobile-appearance.png');
    check(true, 'appearance tab reachable on mobile');
});
