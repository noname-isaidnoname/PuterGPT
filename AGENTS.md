# AGENTS.md

Hosted at GitHub Pages: `https://noname-isaidnoname.github.io/PuterGPT/`, deliberately no build steps or servers: see below.

PuterGPT — a browser-based AI chat client for [Puter.ai](https://puter.ai) models. Static HTML/CSS/vanilla JS. **No build step, no server, no package.json.** The deployed site is served as-is from this directory (GitHub Pages), and the same files run fine off `python3 -m http.server`.

Everything lives in one big `index.html`; there is no bundler, no TypeScript, no lint/test harness. Keep it that way unless the user asks for tooling.

## Project map — which file owns what

Plain ES modules loaded with `<script type="module" src="js/app.js">`. Globals referenced by inline `onclick="…"` handlers are attached to `window` explicitly (`window.newChat`, `window.openSettings`, `window.sendMessage`, `window.enterEditMode`, …) — keep that pattern working or remove the inline handlers.

| file | owns |
| --- | --- |
| `index.html` | the whole skeleton: sidebar, welcome view, `#input-area`, settings / settings-confirm / code-runner / delete-theme / theme-generator modals, context menu, toast container, and the **default (dark) `:root` CSS variables inlined in a `<style>` block** (mirrored from `js/store.js` — see Theming) |
| `css/*.css` | one concern each, linked from `index.html`: base (body, selection, focus ring), sidebar, chat (message column, welcome view, `.msg-footer`), input (floating composer), markdown (code blocks + banner), message-actions (edit UI), ui-elements (buttons, inputs, labels), modal (base `.modal` + confirms + code runner), settings (settings modal sidebar-tab layout, switches, theme cards), reasoning, responsive, animations (typing dots, toasts), token-management, search |
| `tools/` | Node verification harnesses (headless browser, zero app dependencies; Lightpanda via raw CDP by default, Playwright for screenshots/mobile emulation): boot the app statically served, exercise the settings UI/theme cards, exit non-zero on any console/page error or failed check. Never add tests to `/tmp/*` as they'll be deleted on reboot — move them to `./tools/*` instead. See `tools/README.md` |
| `js/app.js` | entry point; `bootstrap()` order matters: migrate → `bootstrapThemes()` → settings → token mgmt → `renderThemeCards()` → subscriptions → `loadSavedChats()` → `loadModels()` (network) → image/import/listeners → `initializeWelcomeMode()` (**last** — sets `#main.welcome-mode` synchronously, so it doubles as "app booted") |
| `js/state.js` | `applyTheme()` (sets inline vars on `<html>`, `data-theme`, swaps the highlight.js `<link id="hljs-theme">` between `github.min.css`/`github-dark.min.css`, sets `meta theme-color`), loads settings from IndexedDB (`loadSettingsFromDB`), Proxy-backed `state` export |
| `js/store.js` | tiny Zustand-like store (`setState`/`getState`/`subscribe`) + `themeDefinitions` (built-in `light`, `dark`, plus `custom-*` merged in at runtime). Holds the canonical light/dark variable sets |
| `js/chat.js` | input handling, `sendMessage()`, image attach, `resizeInput()` |
| `js/export.js`, `css/print.css` | per-chat JSON/Markdown export and share links; print-only transcript layout. Markdown exports include system prompts, message metadata and non-text parts, so treat them as sensitive |
| `js/backup.js` | versioned full-data JSON backups and transactional restore; tokens are opt-in, collisions use an explicit policy, and custom themes are mirrored to localStorage because theme bootstrap reads it first |
| `js/chat-api.js` | streaming responses from the Puter.ai API (`api.puter.com`), token rotation hooks, `triggerAssistantResponse()`, abort |
| `js/generation-params.js`, `js/voice-input.js` | per-chat optional temperature/max output tokens (null means model defaults; changing them saves immediately) and feature-detected browser speech input |
| `js/variants.js` | experimental response alternatives: snapshots are stored additively on assistant messages, whose top-level fields always mirror the active variant; switching an older response requires confirmation before dropping dependent later turns |
| `js/compare.js`, `css/compare.css` | read-only model comparison; two independent streams receive the same prompt and system prompt, and closing the modal aborts both without changing the chat |
| `manifest.json`, `sw.js`, `js/pwa.js` | installable app shell and opt-in update activation. Bump `CACHE_NAME` in `sw.js` on every change to cached app files, keep `APP_SHELL` in sync with added/deleted assets, and never cache Puter API or authenticated requests. Manifest theme color is intentionally static dark |
| `js/shortcuts.js` | keyboard shortcut handling and `?` help dialog. Ctrl/Cmd+K focuses the chat filter even while typing; other shortcuts are suppressed in editable fields and all are suppressed behind active modals |
| `js/chat-ui.js` | `renderMessage()` (the message DOM), `decorateCodeBlocks()` (adds the `.code-block-header` banner with language label + copy/Run buttons), `reRenderAllMessages()` |
| `js/chat-edit.js` | edit mode: `window.enterEditMode(index)`, save / save+regenerate / cancel |
| `js/token-manager.js`, `js/token-ui*.js` | token vault, rotation, list UI, quick-register |
| `js/storage.js`, `js/indexeddb-storage.js` | persistence: IndexedDB **'PuterGPT'** via Dexie — stores `chats`, `tokens`, `settings`; schema v2 adds a chat pin index. Chat writes preserve stored metadata, including titles and pins. One-off migration of legacy `puter_*` localStorage keys runs on boot |
| `js/theme-generator.js`, `js/theme-ui.js` | AI/custom themes: prompts, JS-effects execution (`executeThemeJS`), dropdown population |
| `js/models.js`, `js/compression.js` | model list + pricing; lz-string compression for share links |
| `js/search.js`, `js/search-ui.js`, `css/search.css` | full-text search. The Advanced Search modal mirrors the settings modal chrome (`.search-header`/`.search-body`/`.search-footer`, reuses `.settings-close` and `.settings-badge`); close keeps the query + results (resynced on next open) |
| `js/event-bus.js` | pub/sub (`on`, `emit`) — **listener exceptions are caught and logged as `console.error('[event-bus] …')`, never thrown** |
| `js/ui.js` | toasts, context menu, saved-theme delete/reset helpers |
| `js/code-runner.js` | sandboxed JS/HTML preview modal |
| `js/modal-helper.js` | shared modal factories: `createModal()` (overlay/Escape/overlay-click, topmost-dialog focus trap and restoration), `createConfirmModal()` (cancel/confirm, `confirmStyle: primary\|danger`), `createPromptModal()` (single-line input, Enter=confirm). Always call the returned overlay's `.remove()` so focus and listeners are cleaned up. Use these or `confirmAsync()`/`promptAsync()` instead of native dialogs. The defensive `window.confirm`/`window.prompt` shims return `false`/`null` immediately; never use them when an answer is needed |

## Theming — two files must stay in sync

Custom properties are the whole theme system (built-ins `dark` = default, `light`, plus runtime `custom-*` themes). When you add or rename a variable:

1. add it to the inline `<style>:root` block in `index.html` (the dark defaults used before JS runs),
2. add it to **both** `themeDefinitions.light.cssVars` and `themeDefinitions.dark.cssVars` in `js/store.js`.

`applyTheme()` sets every var as an inline `style` on `<html>`, so dedicated dark selectors don't exist — components must use variables only, never hardcoded mode colors. `--content-max-width`, `--content-padding-horizontal` drive the message column and composer width.

## State & reactivity

`state` is a **Proxy** delegating to `getState()` — always read `state.x` fresh; never cache the proxy itself. For UI updates, `subscribe(syncConfigToUI)` in `app.js` syncs config → DOM; messages flow through `emit('message:append')` / `emit('messages:rerender')`. `reRenderAllMessages()` clears and rebuilds `#chat-container`; a MutationObserver in `initializeWelcomeMode()` watches the container and toggles `#main.welcome-mode`, which shows the centered `#welcome-view` and hides the transcript.

**AI generation is an explicit state machine** — never go back to inferring it from the messages array. `triggerAssistantResponse()` sets `state.isGenerating: true` synchronously; `streamPuterCompletion`'s callbacks and every failure path settle it back to `false` (with `lastOperationId`/`abortController`); `abortAssistantResponse()` is the one entry point that finalizes synchronously by reaching the in-flight stream context (`activeStream` in `js/chat-api.js`). Anything that swaps the transcript (`newChat`, `loadChat`, import/shared-chat load, delete-active-chat, regenerate) must call `abortAssistantResponse()` first. Empty assistant placeholders are only ever valid mid-flight.

Per-chat `generationParams` are normalized on load, reset on new/shared chats, and included in backups and single-chat JSON export. Unset values are omitted from Puter requests. Puter documents `temperature` and `max_tokens`, but some models ignore temperature or enforce model-specific limits.

**Untrusted HTML never reaches `innerHTML` raw.** `marked.parse(...)` output must go through `sanitizeHtml()` (`js/sanitize.js`, allowlist-based — strips scripts, event handlers, non-image `data:` URLs, forms/iframes). Reasoning text is escaped, not interpolated. Same rule applies to imported/shared chats and token names.

## Message markup contract (easy to break)

- `renderMessage()` output: `<div class="message user|assistant"><div class="message-wrapper"><div class="message-content">…</div><div class="msg-footer">…edit button…</div></div></div>`
- user bubbles use `.user-bubble` (no `.rendered-content`); assistant output uses `.rendered-content`. **Anything that assumes `.rendered-content` exists will throw on user messages** — `decorateCodeBlocks` and edit-mode already account for this; keep the guards.
- `.msg-footer` (edit/copy buttons) is `opacity: 0` until `.message:hover` (forced visible ≤768px).
- Streaming: the typing indicator renders `.typing-indicator` with three `.dot`s; cost badges (`.message-cost`) and reasoning pills (`.reasoning-block`) are built inline in `chat-ui.js` — both take the content path.

## Verification

**No test suite exists.** Verify in a real browser (or with Lightpanda) instead of eyeballing the diff. Serve first:

```bash
python3 -m http.server 8765
```

Headless harnesses live in `tools/` (see `tools/README.md`) — they serve the repo statically themselves, so no manual server is needed. They run on Lightpanda (raw CDP, no dependencies, default) or Playwright (`--backend playwright`; needed for screenshots and mobile viewport emulation), and exit non-zero on console/page errors, which is the fastest way to run the checks below. `tools/verify-edge-cases.js` is Playwright-only (mocks the Puter API **and** the ~576 KB models/details endpoint with a canned list, so it boots fully offline) and covers the generation/abort/error paths, XSS sanitization, the settings discard-tracking flow and the themed confirm/prompt dialogs (`createConfirmModal`/`createPromptModal`). Its scenarios are independent and run concurrently (`EDGE_CONCURRENCY`, adaptive default 4–6; set to 1 for sequential, easier-to-read output). `node tools/verify-all.js` (or `--backend all`) runs the whole suite in parallel with one shared static server; output is per-harness one-liners on success (full output only for failures — `--verbose` prints everything). `--timeout N` bounds each harness (default 180s).

### Git hooks

`.githooks/` carries a `pre-commit` hook (versioned, not activated by clone) that runs `node tools/verify-all.js --changed` and blocks the commit on failure. `--changed` skips only docs/meta paths (`*.md`, LICENSE, `.githooks/`, …); any app code, CSS or tooling change selects the full suite. Install it with `sh tools/install-hooks.sh` (sets `core.hooksPath=.githooks`); bypass with `git commit --no-verify`.

### Installing the verification tools — ask first

Don't assume `lightpanda` or Playwright exists on the machine. **If the tools below are missing, ask the user before installing anything** (use the question/ask tool of whatever harness you're running; if none exists, just ask in your reply). Downloading a tool (except for chromium) is not something to do silently on someone's machine. Check first:

```bash
command -v lightpanda        # e.g. ~/.local/bin/lightpanda
command -v playwright
command -v python3
ls ~/.cache/ms-playwright    # playwright browsers, if any
```

- **Lightpanda** — headless browser (Zig, no graphical engine -- faster than Playwright in most cases) from <https://github.com/lightpanda-io/browser>. Install the x86_64 Linux nightly (arm64/macOS links on the releases page):

  ```bash
  mkdir -p ~/.local/bin
  curl -L -o ~/.local/bin/lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux
  chmod a+x ~/.local/bin/lightpanda
  lightpanda version
  ```

  No sudo is needed; don't ask for one. Set `LIGHTPANDA_DISABLE_TELEMETRY=true` for runs — it collects usage telemetry by default. Linux release builds need glibc ≥ 2.35.

  Usage: `lightpanda fetch --dump html --wait-ms 3000 URL` for a rendered-DOM dump (modals hidden by CSS still appear in text dumps) · `lightpanda run script.js` for a PandaScript (`new Page()` + `goto`/`click`/`fill`/`evaluate`/`waitForScript`) · `lightpanda serve --port 9222` then speak raw CDP from Node if you need real clicks and console capture. Quirks:
  - **No graphical engine** — `--dump png` is a text-only rendering; `getComputedStyle` doesn't apply author CSS reliably. It checks structure and JS, not looks.
  - Its `click` only fires on "interactive" (button-like) elements — `.chat-item` is a `<div onclick>`, so dispatch with `page.evaluate("document.querySelector('.chat-item').click()")` or use Playwright.
  - `MutationObserver` callbacks race your next `waitForScript`/`click`; wait for the state itself, not for the injection call.
- **Playwright Chromium** — how screenshots and real computed-style checks are done. Keep the tooling out of this repo (it has no package.json and must stay that way): work from a scratch dir like `/tmp`. 

If Playwright is already installed globally (e.g. `npx playwright --version` / `playwright --version` (without `npx`) or a global `playwright`/`playwright-core` package exists), skip the setup below and use that install directly.
If `playwright` is installed but `chromium` binary isn't, Don't ask the user whether you want to install chromium, just install it (technically not an actual tool, it gets deleted by `playwright` after a while).

  ```bash
  mkdir -p /tmp/ui-verify && cd /tmp/ui-verify
  npm init -y && npm i playwright-core
  npx playwright install chromium     # ~120 MB into ~/.cache/ms-playwright
  ```

  Then `require('playwright-core')` and point `chromium.launch({ executablePath })` at the downloaded shell under `~/.cache/ms-playwright/`. Hover `.message` (and wait ~0.5 s) before asserting `.msg-footer` opacity.

- Boot success marker: `document.getElementById('main').classList.contains('welcome-mode') === true` (empty chat) — happens at the end of `bootstrap()`; earlier checks race it (`loadModels()` network call gates it).
- **Zero console/pageerror output is expected** across a full seed → open chat → edit → save → theme-switch cycle; the `loading state` is not acceptable as "it's fine".
- If you touch the token/rotation, model list, or anything hitting `api.puter.com`, expect a live network dependency.

## Gotchas

- The settings modal is a sidebar-tab layout: `.settings-tab[data-tab]` buttons switch `.settings-panel` sections via `window.switchSettingsTab()` (`js/ui.js`). Panel ids are `settings-panel-<tab>` — keep the two in sync when adding a tab. Appearance is all theme cards (`.theme-card[data-theme-card]`): built-ins plus one card per custom theme, rendered by `renderThemeCards()` (`js/theme-ui.js`; icon = `theme.icon` ?? leading emoji of `theme.name` ?? `🎨`, leading emoji is stripped from the label). Cards call `window.selectThemeCard()`, which goes through `setState({ config.theme })` so `syncConfigToUI()` applies the theme — don't call `applyTheme()` directly there. Custom themes generated by the AI carry a single-glyph `icon` field (validated via `Intl.Segmenter` in `parseAndValidateTheme`).
- Prefer the existing `.settings-toggle-row` and `.switch` pattern over generic checkboxes for on/off settings; retain checkboxes where they are necessary or a better fit for the context.
- Built-in theme changes go in **both** `index.html` and `js/store.js` (see Theming) — one without the other ships broken half-themes.
- Don't reuse variable names for JS-inline styles without checking who else reads them (`--input-bg`, `--border-color`, `--radius-sm` are read by JS-injected HTML).
- `reRenderAllMessages` re-creates every message; don't rely on element identity across rerenders.
- `marked` 12.0.2, `hljs` 11.9.0, `Dexie` 4.0.11, and `lz-string` 1.5.0 are pinned CDN/global scripts with SRI (no imports); changing their versions requires updating the integrity hashes. Missing globals show a blocking error. `applyTheme()` swaps the highlight.js stylesheet between light and dark.
- Inline `style="…"` on some buttons/inputs is deliberate legacy; converting to classes is fine if you keep the `id`s.
- `preferences`-dependent JS (token order, rotation) lives in `localStorage` (`puter_tokens` etc.) only until the first migration to IndexedDB.
- Global `input[type="text"]` / `.btn` rules in `ui-elements.css` outrank same-specificity component classes — a class like `.search-input` silently loses its `padding`. Override with element+class (`input.search-input`) or accept the global styling.
- This repo is also deployed straight to websim.com (the footer script in `index.html` detects an iframe host) — don't break `window.location.ancestorOrigins` logic or the `id="puter-footer"` hook.
- Do NOT read tools/.env file in any way, printing the contents will have it land in your conversation history and potentially expose sensitive information. Scripts can read the file but should never print it to stdout.
- The tools/.env file contains `PUTER_TOKEN`, use this token to authenticate with the Puter API if needed.

## Commit conventions

Short imperative summaries (`redesign: …` is fine). No attribution of tools/models in commit messages or code comments. Only commit what the user asked to be committed or if they simply asked to; the working tree should stay clean of scratch files (no `.fallow/`, `node_modules`, screenshots — none of those belong in this repo). When in doubt about unrelated changes in the working tree, leave them alone.

## Updating this file

If you learn something the next agent would rediscover the hard way — a platform quirk, a verification trap, a file that owns an unexpected behavior — write it down here in the same change. Keep it accurate; wrong notes are worse than missing ones.
