# Contributing

PuterGPT is a static HTML, CSS, and vanilla JavaScript app. It is served as-is; do not add a build step, framework, or package manifest.

## Run locally

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`. Read [AGENTS.md](AGENTS.md) for the project map, state and security invariants, theming rules, and verification gotchas.

## Verify changes

The browser harnesses and prerequisites are documented in [tools/README.md](tools/README.md). With the required tools already installed:

```bash
node tools/verify-all.js
node tools/verify-all.js --changed
node tools/verify-settings.js --backend playwright
node tools/verify-mobile.js --backend playwright
```

The Playwright runs capture screenshots for visual inspection. Generation and state changes should also have an independent scenario in `tools/verify-edge-cases.js`. Ask before installing missing verification tools on someone else's machine.

Install the versioned pre-commit hook with `sh tools/install-hooks.sh`. It checks JavaScript syntax, runs the applicable verification harnesses, and blocks a failing commit. The hook can be bypassed in an emergency with `git commit --no-verify`.

When changing cached app files, update the service worker cache version and maintain its app-shell asset list. Do not cache Puter API responses. Keep secrets, user data, and generated screenshots out of commits.
