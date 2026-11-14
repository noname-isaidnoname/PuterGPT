# tools/ — verification harnesses

Headless checks for PuterGPT. They serve the repo statically (no build, no
install step for the app), boot it in a headless browser, exercise the UI, and
**exit non-zero on any failed check, console error or page error**.

Two backends are supported — pick with `--backend auto|lightpanda|playwright`
(or `BACKEND=lightpanda` / `--backend=lightpanda`). `auto` (default) prefers
Lightpanda and falls back to Playwright:

| backend | pros | cons |
| --- | --- | --- |
| `lightpanda` (default) | very fast, no npm packages, zero config beyond the binary | no screenshots, no viewport emulation (mobile checks run but don't mean much) |
| `playwright` | real Chromium: screenshots, `--viewport` emulation | heavier; needs a chromium binary |

| script | what it covers |
| --- | --- |
| `verify-settings.js` | Desktop settings modal: boot, open via sidebar button, tab switching, toggle switches, theme cards, save / close-with-no-changes / discard-with-changes flows, screenshots of every panel |
| `verify-custom-themes.js` | Appearance theme cards: seeds 3 custom themes into `localStorage` (load, seed, reload — the app reads customThemes at boot) and checks icon/label fallback logic, activation (cssVars actually applied), Generate card, delete-theme confirmation |
| `verify-mobile.js` | 420×850 viewport (playwright only): open settings from the welcome view, horizontal tab row, all panels reachable |
| `verify-edge-cases.js` | Failure paths + implicit state machines: mocks `api.puter.com/drivers/call` via route interception (no network). Covers the user-bubble width bug, streaming success/abort/401 flows, the settings save→close discard-tracking regression, imported/shared/token-name XSS sanitization, advanced search (index, results, open-chat), theme generation end-to-end, code-block copy, delete-chat flow, theme switching |
| `verify-all.js` | Runs every harness above in parallel and exits non-zero if any fail. `--backend lightpanda\|playwright\|all` to force backends (mobile always playwright; edge-cases always playwright) |

Screenshots land in `$TMPDIR/putergpt-tools` by default; nothing is written into the repo.

## Prerequisites

- Node.js ≥ 21 (uses the built-in WebSocket client for the Lightpanda CDP backend — no dependencies at all)
- **Lightpanda** (default backend): `lightpanda` on `PATH` or at `~/.local/bin/lightpanda` (set `LIGHTPANDA_PATH` to override). Get it from <https://github.com/lightpanda-io/browser/releases> — set `LIGHTPANDA_DISABLE_TELEMETRY=true` for runs if you don't want usage stats (the harness does this for you).
- **Playwright** (for screenshots / mobile emulation): `playwright` or `playwright-core`, resolvable locally, globally, or via `npm root -g`, plus a chromium binary:

```bash
playwright install chromium        # or: npx playwright install chromium
```

## Usage

```bash
node tools/verify-settings.js                          # auto backend (lightpanda if installed)
node tools/verify-custom-themes.js --backend playwright # force playwright (needed for screenshots)
node tools/verify-mobile.js --backend playwright        # mobile viewport emulation
node tools/verify-edge-cases.js                         # playwright only (route interception)
node tools/verify-all.js                                # run all harnesses in parallel
node tools/verify-all.js --backend all                  # browser harnesses on BOTH backends
```

Options (env vars or flags):

- `--backend NAME` / `BACKEND` — `auto` (default), `lightpanda`, or `playwright`
- `--base-url URL` / `BASE_URL` — test against an already-running server instead of the built-in one (e.g. `BASE_URL=http://localhost:8765 node tools/verify-settings.js`)
- `--screenshot-dir DIR` / `SCREENSHOT_DIR` — where screenshots go (default: `$TMPDIR/putergpt-tools`; ignored by the lightpanda backend)
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` — force a specific chromium binary
- `LIGHTPANDA_PATH` — force a specific lightpanda binary

## Notes

- The app boots without network (the model list falls back to cache/static defaults); the settings/theme/mobile harnesses never send chat messages, so no Puter API token is required.
- `verify-edge-cases.js` is **Playwright-only** — it mocks `api.puter.com/drivers/call` with request routing (canned NDJSON / 401 / hanging streams), so it exercises the full send → stream → abort → error paths without network access or a real token. The 401 resource errors the browser logs are expected and filtered.
- Each run is a fresh ephemeral browser profile, so tests may freely mutate `localStorage`/IndexedDB — nothing persists.
- Clicks are DOM clicks (`el.click()` via evaluate), which both backends support uniformly. Visibility/hit-testing is not covered; check that manually if you change layout.
- Expected output: `PASS` lines per check and `[<name>] PASS` at the end. A run is only valid with **zero console errors and zero page errors**.
- Avoid adding tools or harnesses at `/tmp/*` as they'll be deleted on reboot. If you currently have tests there, move them to `./tools/*` directory.