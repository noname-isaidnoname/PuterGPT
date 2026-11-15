#!/usr/bin/env node
// Verifies the Appearance panel's theme cards, including custom themes.
// Custom themes are seeded by loading the app once, writing localStorage,
// then reloading (the app reads customThemes at boot). One seeded theme has
// a generator-style icon, one has a leading emoji in the name only, one is a
// legacy theme with neither.
//
// Usage: node tools/verify-custom-themes.js [--backend auto|lightpanda|playwright] [--base-url URL] [--screenshot-dir DIR]

const { run, waitForBoot, openSettings, sleep } = require('./lib');

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

run('verify-custom-themes', async (page, ctx) => {
    const { baseUrl, check } = ctx;

    // Boot once, seed localStorage, reload so bootstrap picks the themes up
    await page.goto(baseUrl + '/');
    await waitForBoot(page);
    await page.evaluate(`localStorage.setItem('customThemes', ${JSON.stringify(JSON.stringify(CUSTOM_THEMES))})`);
    await page.goto(baseUrl + '/');
    await waitForBoot(page);
    console.log('BOOT_OK (seeded)');

    await openSettings(page);
    await page.click('.settings-tab[data-tab="appearance"]');
    await page.waitFor("document.getElementById('settings-panel-appearance').classList.contains('active')");
    await sleep(400);

    const cards = JSON.parse(await page.evaluate(`JSON.stringify(
        Array.from(document.querySelectorAll('.theme-card')).map(el => ({
            key: el.dataset.themeCard || null,
            label: el.querySelector('.theme-card-name')?.textContent.trim(),
            icon: el.querySelector('.theme-card-icon')?.textContent.trim(),
            active: el.classList.contains('active')
        }))
    )`));
    console.log('CARDS=' + JSON.stringify(cards));
    const byKey = Object.fromEntries(cards.map(c => [c.key, c]));

    check(cards.length === 7, `7 cards rendered (2 built-in + 3 custom + new + generate), got ${cards.length}`);
    check(!!byKey['light']?.icon, 'light card has an icon');
    check(!!byKey['dark']?.icon, 'dark card has an icon');
    check(byKey['custom-ocean-1']?.icon === '🌊', 'custom theme uses its icon field');
    check(byKey['custom-ocean-1']?.label === 'Ocean Breeze', 'custom theme label is the bare name');
    check(byKey['custom-forest-2']?.icon === '🌲', 'leading emoji falls back to icon when no icon field');
    check(byKey['custom-forest-2']?.label === 'Forest Calm', 'leading emoji stripped from label');
    check(byKey['custom-mystery-3']?.icon === '🎨', 'legacy theme falls back to 🎨');
    check(byKey[null]?.label === 'Generate', 'generate card rendered');
    check(cards.some(c => c.label === 'New Theme'), 'new theme (preset) card rendered');
    const editButtons = JSON.parse(await page.evaluate(`JSON.stringify(
        Array.from(document.querySelectorAll('.theme-card-edit')).map(el => ({
            label: el.getAttribute('aria-label'),
            target: el.closest('.theme-card-wrap')?.querySelector('.theme-card')?.dataset.themeCard || null
        }))
    )`));
    check(editButtons.length === 3, `one edit button per custom card, got ${editButtons.length}`);
    check(editButtons.every(b => b.target && b.target.startsWith('custom-')), 'edit buttons only on custom cards');
    await ctx.shot('appearance-custom-themes.png');

    // Activating a custom card applies its vars and marks it active
    await page.click('.theme-card[data-theme-card="custom-ocean-1"]');
    await sleep(400);
    check(await page.evaluate(`document.querySelector('.theme-card[data-theme-card="custom-ocean-1"]').classList.contains('active')`), 'custom card activates on click');
    check(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()`) === '#0b2a3a', 'custom cssVars applied (--bg-primary)');
    check(await page.evaluate(`getComputedStyle(document.getElementById('delete-theme-btn')).display`) === 'block', 'delete button shown for custom theme');
    await ctx.shot('appearance-custom-active.png');

    // Generate card opens the theme generator
    await page.click('.theme-card-generate');
    await page.waitFor("document.getElementById('theme-generator-modal').classList.contains('active')", 3000);
    await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('#theme-generator-modal button')).find(x => x.textContent.trim() === 'Cancel'); if (!b) throw new Error('Cancel button not found'); b.click(); })()`);
    await page.waitFor("!document.getElementById('theme-generator-modal').classList.contains('active')", 3000);
    check(true, 'generate card opens and closes theme generator');

    // Delete button opens the confirm modal
    await page.click('#delete-theme-btn');
    await page.waitFor("document.getElementById('delete-theme-modal').classList.contains('active')", 3000);
    check(true, 'delete button opens confirm modal');
    await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('#delete-theme-modal button')).find(x => x.textContent.trim() === 'Cancel'); if (!b) throw new Error('Cancel button not found'); b.click(); })()`);
    await page.waitFor("!document.getElementById('delete-theme-modal').classList.contains('active')", 3000);
});
