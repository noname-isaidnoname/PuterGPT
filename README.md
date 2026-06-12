# PuterGPT

A browser-based AI chat client for [Puter.ai](https://puter.ai) models. No build step, no server needed — just open the page and start talking.

All your chats, tokens, and themes live in your browser's IndexedDB. Nothing gets sent anywhere except the API calls to Puter.ai.

---

## Get started

Open the app: **[noname-isaidnoname.github.io/PuterGPT](https://noname-isaidnoname.github.io/PuterGPT/)**

1. Click **Settings & AI Config** in the sidebar
2. Add a Puter.ai API token (or click "Quick Register" to get one)
3. Pick a model and start typing

Or run it locally:

```bash
git clone https://github.com/noname-isaidnoname/PuterGPT.git
cd PuterGPT
python -m http.server 8000
# or: npx http-server -p 8000
# or: php -S localhost:8000
```

Then open `http://localhost:8000` in your browser.

---

## Features

- **Chat with multiple AI models** — switch between available Puter.ai models, each with its own pricing
- **Image support** — upload, paste, or drag-and-drop images into the chat for vision-capable models
- **Web search** — toggle search on supported models so the AI can pull in live results
- **Streaming responses** — replies show up as they're generated, not all at once
- **Edit & regenerate** — tweak previous messages and re-roll the response
- **Chat history** — saved automatically in IndexedDB. Export or import individual chats
- **Themes** — comes with dark and light themes. You can also describe a theme in plain English and let the AI build one for you (with optional JS effects)
- **Token management** — add multiple tokens, rotate them automatically when one runs out, import/export the list
- **Cost tracking** — shows estimated token usage per message
- **Code execution** — run JavaScript code blocks inline (sandboxed)
- **Responsive** — works on phones, has a collapsible sidebar

---

## How it works

The whole thing is static HTML, CSS, and vanilla JavaScript. No frameworks, no bundlers, no build step.

- `js/store.js` — a tiny Zustand-like state manager that everything hooks into
- `js/chat.js` / `js/chat-api.js` — handles sending messages and streaming responses from the Puter.ai API
- `js/chat-ui.js` — renders messages, handles the input area, image attachments
- `js/token-manager.js` — manages API tokens and rotation
- `js/theme-generator.js` / `js/theme-ui.js` — handles themes: built-in, custom, and AI-generated
- `js/storage.js` / `js/indexeddb-storage.js` — persistence layer
- Everything is connected via a simple event bus (`js/event-bus.js`)

---

## Configuration

Open **Settings & AI Config** in the sidebar:

- **System prompt** — set a base instruction the AI follows for every message
- **Model** — pick which Puter.ai model to use
- **Tokens** — add, remove, or reorder API tokens. Enable rotation so it falls back when one hits its limit
- **Auto-scroll** — toggle whether the chat follows new messages
- **Web search** — turn on for models that support it
- **Theme** — pick dark/light or generate a custom one

---

## Notes

- The app is entirely client-side. Your API tokens never leave your browser (except when they're sent to Puter.ai as part of a request)
- Chat history is stored in IndexedDB. Clearing your browser data will wipe it — export anything you want to keep
- Built-in themes can't be deleted. Custom themes can
- If something breaks, check the browser console. Most issues are either a bad token or a network problem

---

Project is on [GitHub](https://github.com/noname-isaidnoname/PuterGPT). Open an issue if something's broken or missing.