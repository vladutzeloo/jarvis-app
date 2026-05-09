# JARVIS — local

Tauri + Vanilla TS desktop app for the Jarvis persona. Tabbed UI (chat,
workspace, brain) with voice I/O, gesture recognition, and a cockpit HUD
fed from a local Python stats server.

The chat tab can talk to two backends:

- **Ollama** (local) — `http://localhost:11434`, the default. Models you've
  pulled appear in the picker.
- **NVIDIA build.nvidia.com** (cloud) — hosted inference, OpenAI-compatible
  endpoint at `https://integrate.api.nvidia.com/v1`. Requires an API key.

The picker groups both into a single dropdown so switching is one click.

## Setup

```bash
git clone https://github.com/vladutzeloo/jarvis-app.git
cd jarvis-app
npm install
cp .env.example .env
# edit .env and paste your NVIDIA_API_KEY
npm run tauri dev
```

Each machine keeps its own `.env`; nothing secret is ever committed.
`.env` is gitignored; the template lives at `.env.example`.

The app will read `.env` on startup. Open the settings drawer (⚙ in the
chat toolbar) and use the **Integrations · NVIDIA** section to write the
key from the UI — it appends to `.env` on disk and never round-trips
through the webview as a JS string.

If you don't want NVIDIA right now, leave `NVIDIA_API_KEY` blank — the app
will run on Ollama only and show no NVIDIA group in the picker.

## Backends in detail

- The NVIDIA call goes Webview → Rust `nvidia_chat_stream` command → NVIDIA
  → SSE chunks → Tauri events → Webview. The API key never leaves Rust.
- Sampling settings (`temperature`, `top_p`, `max_tokens`) are mapped from
  the existing settings drawer. NVIDIA's API doesn't support `top_k` or
  `repeat_penalty`; those are silently ignored on the NVIDIA path.
- Models are listed via `/v1/models`. The list is sorted alphabetically.

See `02_Capabilities/integrations/nvidia.md` in the
[own-jarvis vault](https://github.com/vladutzeloo/own-jarvis) for the
canonical integration notes (model picks, egress per surface, rotation).

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
