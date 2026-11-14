# tools/ — verification harnesses

Headless-browser checks for PuterGPT. They serve the repo statically (no
build, no install step for the app), open it in Chromium via Playwright,
exercise the UI, and **exit non-zero on any failed check, console error or
page error**. Screenshots are written to a scratch directory, never into the repo.

| script | what it covers |
| --- | --- |
| `verify-settings.js` | Desktop settings modal: boot, open via sidebar button, tab switching, toggle switches, theme cards (dark/light), save / close-with-no-changes / discard-with-changes flows, screenshots of every panel |
| `verify-custom-themes.js` | Appearance theme cards: seeds 3 custom themes into `localStorage` before boot and checks icon/label fallback logic, activation (cssVars actually applied), Generate card, delete-theme confirmation |
| `verify-mobile.js` | 420×850 viewport: open settings from the welcome view, horizontal tab row, all panels reachable |

## Prerequisites

- Node.js (any modern version)
- Playwright (`playwright` or `playwright-core`) + a chromium binary. Resolution order: `require('playwright')` → `require('playwright-core')` → `npm root -g`. If the browser isn't downloaded, the harness scans `~/.cache/ms-playwright` for the newest binary.

```bash
playwright install chromium        # or: npx playwright install chromium
```

## Usage

```bash
node tools/verify-settings.js
node tools/verify-custom-themes.js
node tools/verify-mobile.js
```

Options (env vars or flags):

- `--base-url URL` / `BASE_URL` — test against an already-running server instead of the built-in one (e.g. `BASE_URL=http://localhost:8765 node tools/verify-settings.js`)
- `--screenshot-dir DIR` / `SCREENSHOT_DIR` — where screenshots go (default: `$TMPDIR/putergpt-tools`)
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` — force a specific chromium binary

## Notes

- The app boots without network (the model list falls back to cache/static defaults); these harnesses never send chat messages, so no Puter API token is required.
- Each run is a fresh ephemeral browser profile, so tests may freely mutate `localStorage`/IndexedDB (e.g. theme selection) — nothing persists.
- Expected output: `PASS` lines per check and `[<name>] PASS` at the end. A run is only valid with **zero console errors and zero page errors**.
