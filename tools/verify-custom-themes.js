#!/usr/bin/env node
// Verifies the Appearance panel's theme cards, including custom themes
// seeded via localStorage before boot (one with a generator-style icon,
// one with a leading emoji in the name only, one legacy theme with none).
//
// Usage: node tools/verify-custom-themes.js [--base-url URL] [--screenshot-dir DIR]

const { run, waitForBoot, openSettings } = require('./lib');

const CUSTOM_THEMES = {
    'custom-ocean-1': {
        name: 'Ocean Breeze',
        icon: '🌊',
        description: 'Calming sea tones',
        cssVars: { '--bg-primary': '#0b2a3a', '--text-primary': '#e6f4f9', '--accent': '#22b8cf' }
    },
    'custom-forest-2': {
        name: '🌲 Forest Calm',
        description: 'Deep green forest',
        cssVars: { '--bg-primary': '#12281a', '--text-primary': '#e8f5ea', '--accent': '#34d399' }
    },
    'custom-mystery-3': {
        name: 'Mystery',
        description: 'No icon anywhere (legacy theme)',
        cssVars: { '--bg-primary': '#241733', '--text-primary': '#efe6f7', '--accent': '#a78bfa' }
    }
};

run('verify-custom-themes', {
    initScript: {
        fn: themes => localStorage.setItem('customThemes', JSON.stringify(themes)),
        arg: CUSTOM_THEMES
    }
}, async (page, ctx) => {
    const { baseUrl, check } = ctx;

    await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
    await waitForBoot(page);
    console.log('BOOT_OK');

    await openSettings(page);
    await page.click('.settings-tab[data-tab="appearance"]');
    await page.waitForSelector('#settings-panel-appearance.active');
    await page.waitForTimeout(400);

    // One card per theme + Generate
    const cards = await page.$$eval('.theme-card', els => els.map(el => ({
        key: el.dataset.themeCard || null,
        label: el.querySelector('.theme-card-name')?.textContent.trim(),
        icon: el.querySelector('.theme-card-icon')?.textContent.trim(),
        active: el.classList.contains('active')
    })));
    console.log('CARDS=' + JSON.stringify(cards));
    const byKey = Object.fromEntries(cards.map(c => [c.key, c]));

    check(cards.length === 6, `6 cards rendered (2 built-in + 3 custom + generate), got ${cards.length}`);
    check(byKey['light']?.icon, 'light card has an icon');
    check(byKey['dark']?.icon, 'dark card has an icon');
    check(byKey['custom-ocean-1']?.icon === '🌊', 'custom theme uses its icon field');
    check(byKey['custom-ocean-1']?.label === 'Ocean Breeze', 'custom theme label is the bare name');
    check(byKey['custom-forest-2']?.icon === '🌲', 'leading emoji falls back to icon when no icon field');
    check(byKey['custom-forest-2']?.label === 'Forest Calm', 'leading emoji stripped from label');
    check(byKey['custom-mystery-3']?.icon === '🎨', 'legacy theme falls back to 🎨');
    check(byKey[null]?.label === 'Generate', 'generate card rendered');
    await ctx.shot(page, 'appearance-custom-themes.png');

    // Activating a custom card applies its vars and marks it active
    await page.click('.theme-card[data-theme-card="custom-ocean-1"]');
    await page.waitForTimeout(400);
    check(await page.$eval('.theme-card[data-theme-card="custom-ocean-1"]', el => el.classList.contains('active')), 'custom card activates on click');
    check(await page.$eval('html', el => getComputedStyle(el).getPropertyValue('--bg-primary').trim()) === '#0b2a3a', 'custom cssVars applied (--bg-primary)');
    check(await page.$eval('#delete-theme-btn', el => getComputedStyle(el).display) === 'block', 'delete button shown for custom theme');
    await ctx.shot(page, 'appearance-custom-active.png');

    // Generate card opens the theme generator
    await page.click('.theme-card-generate');
    await page.waitForSelector('#theme-generator-modal.active', { timeout: 3000 });
    await page.click('#theme-generator-modal button:has-text("Cancel")');
    await page.waitForSelector('#theme-generator-modal:not(.active)', { timeout: 3000 });
    check(true, 'generate card opens and closes theme generator');

    // Delete button opens the confirm modal
    await page.click('#delete-theme-btn');
    await page.waitForSelector('#delete-theme-modal.active', { timeout: 3000 });
    check(true, 'delete button opens confirm modal');
    await page.click('#delete-theme-modal .btn:not(.danger)'); // Cancel
    await page.waitForSelector('#delete-theme-modal:not(.active)', { timeout: 3000 });
});
