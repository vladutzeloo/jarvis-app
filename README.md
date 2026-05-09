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

## Repo layout

```
src/                      # Webview app (Vanilla TS, Vite-bundled)
├── main.ts               # boot — imports feature modules in order
├── tabs.ts               # tab switcher
├── types.ts              # shared interfaces + base URLs
├── chat/                 # send loop, model picker, research mode
├── voice/                # TTS (Piper + Web Speech), STT, incoming-call UI
├── workspace/            # file tree + CodeMirror editor
├── brain/                # vault search + SVG visualization
├── gestures/             # MediaPipe hand-gesture controls
├── cockpit/              # HUD bar + system-stats poller
├── settings/             # drawer, sliders, NVIDIA integration panel
├── backends/nvidia.ts    # OpenAI-compatible NVIDIA streaming via Rust
├── vault.ts              # Obsidian vault read/write helpers
└── styles/               # one stylesheet per feature, imported by styles.css

src-tauri/                # Tauri Rust shell (window, commands, menus)

server/                   # Python source-of-truth for the WSL TTS server
├── server.py             # HTTP server (port 5500) — Piper TTS + stats
├── synthesis.py          # Piper voice + sox post-effects (alan/orc/narrator)
└── system_stats.py       # CPU/RAM/GPU stats from psutil + nvidia-smi

scripts/                  # one-off setup + launcher helpers
├── ollama-fix.sh         # systemd override: dual-stack listen + open CORS
├── ollama-fix.cmd        # Windows wrapper: runs ollama-fix.sh in WSL
├── wsl-mirrored-net.cmd  # opt-in: switch WSL2 to mirrored networking
├── jarvis-server.sh      # composable Piper/styles/cockpit installer
├── launch-dev.cmd        # double-click dev launcher (Vite + Tauri)
└── launch.vbs            # production .exe launcher (waits for Ollama)
```

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

## TTS server (WSL)

The cockpit's stats and Alan's voice both come from a single Python server
running inside WSL on port 5500. To install it:

```bash
# from a WSL Ubuntu shell, in this repo
bash scripts/jarvis-server.sh             # installs piper + sox + psutil (everything)
bash scripts/jarvis-server.sh --piper     # just TTS, no styles or stats
bash scripts/jarvis-server.sh --cockpit   # just the system-stats endpoint
```

Flags compose: `--piper --cockpit` skips the sox effects but keeps stats.
The script is idempotent — re-run any time. It copies `server/*.py` into
`~/jarvis-tts/` and registers a `jarvis-tts.service` systemd unit.

Override the install dir with `JARVIS_HOME=/somewhere/else bash scripts/...`.

## Troubleshooting

### Tauri can't reach Ollama

Ollama refuses cross-origin requests by default, and on WSL2 the daemon may
listen IPv4-only while Windows' `localhost` resolves to `::1`. The fix is a
systemd override that opens CORS *and* listens dual-stack:

```cmd
:: from a Windows cmd / PowerShell
scripts\ollama-fix.cmd
```

This shells into WSL as root, writes
`/etc/systemd/system/ollama.service.d/override.conf`, restarts the daemon,
and runs probes from both sides. Look at `scripts/ollama-fix.log` afterwards.

Override the WSL distro with `set JARVIS_WSL_DISTRO=Ubuntu-22.04` first.

### Windows still can't see the WSL ports

If after `ollama-fix.cmd` Windows still gets `connection refused`, you may
need WSL2 mirrored networking. This is a separate, opt-in fix:

```cmd
scripts\wsl-mirrored-net.cmd
```

It writes `%USERPROFILE%\.wslconfig`, restarts WSL, and re-launches Ollama.

### TTS server isn't responding

```bash
# inside WSL
systemctl status jarvis-tts
journalctl -u jarvis-tts -n 50
curl http://localhost:5500/health
```

If the voice fails to load, check `JARVIS_VOICE_PATH` in the unit file
points at an existing `.onnx`. Re-running `bash scripts/jarvis-server.sh`
fixes most things.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
