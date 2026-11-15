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
| `verify-edge-cases.js` | Failure paths + implicit state machines: mocks `api.puter.com/drivers/call` **and** the ~576 KB `puterai/chat/models/details` endpoint (canned list) via route interception (no network). Covers the user-bubble width bug, streaming success/abort/401 flows, the settings save→close discard-tracking regression, imported/shared/token-name XSS sanitization, advanced search (index, results, open-chat), theme generation end-to-end, code-block copy, delete-chat flow, theme switching, and the themed confirm/prompt dialogs (rename chat/token, delete chat/token). Scenarios are independent and run concurrently (adaptive default 4–6; `EDGE_CONCURRENCY=1` for sequential) |
| `verify-all.js` | Runs the harnesses in parallel over one shared static server, buffers output per harness, exits non-zero on any failure. Quiet on success (one line per harness, full output only for failures — `--verbose` for everything). `--changed` runs only harnesses affected by uncommitted changes (docs-only commits skip); `--timeout N` bounds each harness (default 180s); `--list` prints the plan |

Screenshots land in `$TMPDIR/putergpt-tools` by default; nothing is written into the repo.

## CDN asset cache

The app loads a handful of pinned (SRI) CDN assets on every page boot (marked,
highlight.js, lz-string, dexie, the hljs theme stylesheet, Google/Material fonts,
and the `puterStream.js` ES-module import). Fresh browser contexts would otherwise
re-download all of them on every scenario. The Playwright backend fulfills those
requests from a disk cache instead — boots are faster and the harnesses are fully
offline-capable once the cache is warm. Only the known CDN/font hosts are
intercepted; `api.puter.com` (and everything else) passes through untouched, and
Lightpanda has no route interception, so it still loads CDN assets from the
network. Cache entries are kept for 7 days (mutable URLs revalidate), and on a
network failure a stale entry is served rather than failing the run.

- location: `~/.cache/putergpt-tools/cdn` — override with `PUTERGPT_CDN_CACHE_DIR`
- TTL: 7 days — override with `PUTERGPT_CDN_CACHE_TTL_MS`
- clear it by deleting the directory; the next run re-downloads (and re-verifies)

The static repo server also sends `Cache-Control: max-age=60` so the reload-heavy
scenarios don't re-download/re-parse local assets.

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
node tools/verify-all.js --changed                      # only harnesses affected by uncommitted changes
node tools/verify-all.js --verbose                      # print full output of passing harnesses too
node tools/verify-all.js --backend all                  # browser harnesses on BOTH backends
node tools/verify-all.js --timeout 240                  # per-harness timeout in seconds (default 180)
node tools/verify-all.js --list                         # print the planned harness list
```

Options (env vars or flags):

- `--backend NAME` / `BACKEND` — `auto` (default), `lightpanda`, or `playwright`
- `--changed` — only run harnesses affected by uncommitted changes (`git diff --name-only HEAD` + untracked files; docs/meta-only commits skip entirely, everything else runs the full suite)
- `--verbose` — print full output of passing harnesses (default: one line each)
- `--list` — print the planned harness list and exit
- `--timeout SECONDS` / `VERIFY_TIMEOUT` — per-harness kill timeout (default 180s)
- `EDGE_CONCURRENCY` — parallelism for verify-edge-cases scenarios (adaptive default 4–6; 1 = sequential)
- `PUTERGPT_CDN_CACHE_DIR` / `PUTERGPT_CDN_CACHE_TTL_MS` — disk cache for the pinned CDN assets (see "CDN asset cache" above)
- `--base-url URL` / `BASE_URL` — test against an already-running server instead of the built-in one (e.g. `BASE_URL=http://localhost:8765 node tools/verify-settings.js`)
- `--screenshot-dir DIR` / `SCREENSHOT_DIR` — where screenshots go (default: `$TMPDIR/putergpt-tools`; ignored by the lightpanda backend). Harness output is a scratch artifact; if a screenshot is meant for the documentation, point this at `screenshots/` in the repo (or copy it there) so it can be committed and referenced from the docs
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` — force a specific chromium binary
- `LIGHTPANDA_PATH` — force a specific lightpanda binary

## Git hooks

`.githooks/pre-commit` runs `node tools/verify-all.js --changed` and blocks the commit when verification fails. App code, CSS and tooling changes always run the full suite; only docs/meta-only commits skip it. Enable once per clone:

```bash
sh tools/install-hooks.sh     # sets core.hooksPath=.githooks
```

Bypass in emergencies: `git commit --no-verify`.

## Notes

- The app boots without network (the model list falls back to cache/static defaults); the settings/theme/mobile harnesses never send chat messages, so no Puter API token is required.
- `verify-edge-cases.js` is **Playwright-only** and fully offline — it mocks `api.puter.com/drivers/call` (canned NDJSON / 401 / hanging streams) and `puterai/chat/models/details` (canned model list), and fulfills the pinned CDN assets from a disk cache (see "CDN asset cache"). The 401 resource errors the browser logs are expected and filtered. Its per-scenario PASS/FAIL lines include individual durations, which is the first place to look when the suite gets slower.
- Lightpanda does not provide the request interception used by the generation scenarios. `verify-all.js` explicitly labels that harness `(playwright)` even when other checks use Lightpanda.
- Each run is a fresh ephemeral browser context per scenario, so tests may freely mutate `localStorage`/IndexedDB — nothing persists.
- Generation scenarios seed fake tokens directly via `tokenManager`; the dedicated token-name XSS and themed-dialog scenarios still exercise token creation through the UI.
- Clicks are DOM clicks (`el.click()` via evaluate), which both backends support uniformly. Visibility/hit-testing is not covered; check that manually if you change layout.
- Expected output: `PASS` lines per check and `[<name>] PASS` at the end. A run is only valid with **zero console errors and zero page errors**.
- Avoid adding tools or harnesses at `/tmp/*` as they'll be deleted on reboot. If you currently have tests there, move them to `./tools/*` directory.
- To get real AI responses (via the Puter API), use the `PUTER_TOKEN` environment variable in the `tools/.env` file. Do not print it in the console.
