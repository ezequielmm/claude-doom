# afk-arcade

An animated arcade banner rendered inside Claude Code's statusline — the terminal UI row just below the input box. The DOOM PSX fire effect runs live while Claude works, fades to embers when it's idle, and shifts to a demo mode when you go AFK. Phase B brings a DOOM WASM daemon that streams real frames.

## Architecture

```
Claude Code event loop
  │
  ├─ hooks/hooks.json  ──►  scripts/hook.mjs        (hook dispatcher)
  │                           writes ~/.claude/afk-arcade/{config,runtime}.json
  │                           writes /tmp/afk-arcade/sessions/<id>.json (state)
  │
  └─ statusLine setting  ──►  scripts/statusline.mjs (banner renderer)
                               reads session state → maps to fire intensity
                               loads/steps/saves fire state (binary, cross-invocation)
                               renders half-block ANSI via lib/render.mjs
```

Hook events → session state:
- `SessionStart` → `idle`; writes the `statusline.sh` shim and `runtime.json`
- `UserPromptSubmit` → `working` (full fire)
- `Stop` / `StopFailure` → `idle` (embers)
- `Notification: idle_prompt` → `afk` (demo mode)
- `Notification: permission_prompt` → attention flag (yellow warning HUD)

## Install

```sh
# Install from local path via the marketplace manifest
claude plugin marketplace add /path/to/afk-arcade-claude
claude plugin install afk-arcade@afk-arcade-marketplace
```

Add to your Claude Code settings (`.claude/settings.json` or global):

```json
{
  "statusLine": {
    "command": "bash ~/.claude/afk-arcade/statusline.sh",
    "refreshIntervalMs": 1000
  }
}
```

Restart Claude Code. The `SessionStart` hook writes `statusline.sh` automatically.

## Usage

```
/afk status                    — show config + active session modes
/afk on / off                  — toggle banner
/afk game fire                 — DOOM PSX fire (default)
/afk game doom                 — DOOM WASM daemon frames (Phase B)
/afk rows <N>                  — banner height, 2–15 rows
/afk aspect <4:3|16:10|stretch> — DOOM frame aspect ratio (default: 4:3)
```

## Play it for real

Play DOOM fullscreen in your terminal — not the attract-mode daemon, but a fully interactive game:

```sh
# Fetch WASM assets first (if you haven't already)
node scripts/fetch-doom.mjs

# Then start the player in any terminal
node scripts/play.mjs
```

Or via the control CLI (prints the command to copy into a fresh tab):

```
/afk play
```

Controls:

| Key | Action |
|-----|--------|
| `W` / `↑` | Move forward |
| `S` / `↓` | Move back |
| `A` / `←` | Turn left |
| `D` / `→` | Turn right |
| `SPACE` | Use (open doors) |
| `F` or `X` | Fire |
| `1`–`7` | Switch weapon |
| `ESC` | Menu |
| `ENTER` / `TAB` | Menu navigation |
| `Q` or `Ctrl+C` | Quit |

See [ROADMAP.md](./ROADMAP.md) for planned extensions: NES / Game Boy emulators and a Wide-Banner Game SDK.

## Phase B — DOOM WASM daemon

Real DOOM (doomgeneric compiled to WebAssembly) runs in a detached sidecar process, rendering the attract/demo mode as ANSI half-block art in your statusline.

### Setup

```sh
# 1. Fetch WASM engine + shareware WAD (~4 MB total, into vendor/ which is gitignored)
node scripts/fetch-doom.mjs
# or via the control CLI:
/afk fetch-doom

# 2. Switch the banner to DOOM mode
/afk game doom
```

### How it works

```
statusline.mjs (every ~1 s)
  │  writes /tmp/afk-arcade/doom/viewport.json  { cols, pxRows, truecolor }
  │  reads  /tmp/afk-arcade/doom/frame.ans       (< 5s old = daemon alive)
  │  if frame absent or stale + daemon dead → spawns daemon.mjs (detached, unref'd)
  │  while daemon warms up → falls back to fire with "doom: warming up" HUD note
  │
daemon.mjs  (singleton, runs in background)
  │  setInterval ~30ms → engine.tick()           (doomgeneric self-paces internally)
  │  every ~1 s → reads viewport.json + config.json
  │             → computes gameW from aspect ratio (4:3 default: gameW=round(pxRows*4/3))
  │             → box-filter scales 320×200 → gameW×pxRows (area-average, ~80 samples/px)
  │             → centers game horizontally with plain-space pillarbox gutters
  │             → renderHalfBlocks → writes frame.ans atomically
  │  watchdog: if viewport.json > 10 min old → exit gracefully
  │  SIGTERM (from hook.mjs SessionEnd) → removes pidfile + exits
```

### Aspect ratio

DOOM's 320×200 framebuffer was displayed on 4:3 CRTs with tall pixels. The renderer uses `▀` half-blocks — one terminal cell per 2 pixel rows, making each pixel approximately square. The `aspect` setting controls how the game is scaled horizontally:

| value     | gameW formula                  | effect                              |
|-----------|--------------------------------|-------------------------------------|
| `4:3`     | `round(pxRows * 4/3)` (default) | authentic CRT look, centered        |
| `16:10`   | `round(pxRows * 1.6)`          | slightly wider, centered            |
| `stretch` | full terminal width            | fills the banner, original behavior |

The gutters are plain spaces with no background color so the terminal's own background shows through.

### Daemon lifecycle

The daemon is **lazily spawned** the first time statusline.mjs runs with `game=doom` and no live frame. It is **automatically stopped** when `hook.mjs` receives a `SessionEnd` event and no other live sessions remain. A pidfile at `/tmp/afk-arcade/doom/daemon.pid` guards against double-spawning.

### Switching back

```sh
/afk game fire
```

The daemon will exit on its own within 10 minutes (viewport watchdog), or immediately when the session ends.
