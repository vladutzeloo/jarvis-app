# JARVIS — local

Tauri + Vanilla TS desktop app for the Jarvis persona. Tabbed UI (chat,
workspace, agents, brain) with voice I/O, gesture recognition, and a cockpit
HUD fed from a local Python stats server.

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
├── agents/               # ruflo runner — Tauri-side bridge to WSL agent runs
├── brain/                # vault search + SVG visualization
├── gestures/             # MediaPipe hand-gesture controls
├── cockpit/              # HUD bar + system-stats poller
├── settings/             # drawer, sliders, NVIDIA integration panel
├── backends/nvidia.ts    # OpenAI-compatible NVIDIA streaming via Rust
├── vault.ts              # Obsidian vault read/write helpers
└── styles/               # one stylesheet per feature, imported by styles.css

src-tauri/                # Tauri Rust shell (window, commands, menus)

server/                   # Python source-of-truth for the WSL TTS server
├── server.py             # HTTP server (port 5500) — Piper TTS + stats + ruflo
├── synthesis.py          # Piper voice + sox post-effects (alan/orc/narrator)
├── system_stats.py       # CPU/RAM/GPU stats from psutil + nvidia-smi
└── ruflo_runner.py       # subprocess manager for `npx ruflo@latest` jobs

apps/minimap/             # standalone Vite web app (browser, not Tauri) —
                          # live "minimap" of jarvis: system stats, ruflo +
                          # vinted bots, log feed, helper bot. Talks to the
                          # WSL server on :5500. Run with `npm run dev:minimap`.

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
bash scripts/jarvis-server.sh             # installs piper + sox + psutil + ruflo (everything)
bash scripts/jarvis-server.sh --piper     # just TTS, no styles or stats
bash scripts/jarvis-server.sh --cockpit   # just the system-stats endpoint
bash scripts/jarvis-server.sh --ruflo     # just the ruflo runner (needs node + npx)
```

Flags compose: `--piper --cockpit` skips the sox effects but keeps stats.
The script is idempotent — re-run any time. It copies `server/*.py` into
`~/jarvis-tts/` and registers a `jarvis-tts.service` systemd unit. When
`--ruflo` is set the unit's `PATH` is rewritten to include the directory
containing `node`/`npx`, and `HOME` is preserved so npx finds its cache.

## Agents tab (ruflo)

The Agents tab integrates [ruflo](https://github.com/ruvnet/ruflo) — a
multi-agent orchestration platform — as an in-app runner. The webview ↔ Rust ↔
WSL bridge mirrors the NVIDIA streaming path:

- Webview invokes `ruflo_run(argv, eventName)` on the Rust side.
- Rust POSTs `/ruflo/run` to the WSL server, then opens the SSE stream at
  `/ruflo/stream/<job_id>` and re-emits each frame as a Tauri event.
- WSL spawns `npx -y ruflo@latest <argv>` with `start_new_session=True` so
  cancel can SIGTERM the whole tree (npx → node → ruflo workers).

The webview never sees a raw shell — it only ever sends a `string[]` of
ruflo subcommand arguments. The `npx -y ruflo@latest` prefix is added
server-side and cannot be overridden.

Setup (after the WSL bridge is installed via `--ruflo`):
1. Open the Agents tab. The status pill shows `bridge online` once
   `/ruflo/health` confirms `npx` is on the systemd unit's `PATH`.
2. Pick a preset (Probe version, Init wizard, MCP start, …) or type your
   own argv. Whitespace splits tokens; `'…'` and `"…"` quote.
3. **Run** streams stdout (white) and stderr (amber) into the console.
   **Cancel** sends SIGTERM to the process group; the bridge escalates to
   SIGKILL after a 5 s grace period.

If the status pill says `bridge up · npx missing`, install Node ≥18 inside
WSL (nvm is the easiest path) and re-run `bash scripts/jarvis-server.sh --ruflo`
so the systemd unit picks up the new bin directory.

Override the install dir with `JARVIS_HOME=/somewhere/else bash scripts/...`.

## Minimap web app

A second, browser-served view of what jarvis is doing right now. Lives at
`apps/minimap/` as its own Vite app (port `5601`) so it can be opened from
any device on the LAN — no Tauri shell required.

```bash
npm install --prefix apps/minimap
npm run dev:minimap        # http://localhost:5601
```

It hits the same WSL server on `:5500` for `/system-stats`, `/ruflo/jobs`,
`/vinted/bots`, and the SSE feed at `/ruflo/stream/<id>`. The helper-bot
panel POSTs to `/chat`, which proxies to local Ollama (`$JARVIS_OLLAMA_URL`,
default `http://localhost:11434`) and streams ndjson tokens back. Configure
the server URL, Ollama model, and poll interval from the ⚙ drawer; settings
persist in `localStorage`.

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
