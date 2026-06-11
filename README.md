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
/afk status        — show config + active session modes
/afk on / off      — toggle banner
/afk game fire     — DOOM PSX fire (default)
/afk game doom     — DOOM WASM daemon frames (Phase B)
/afk rows <N>      — banner height, 2–12 rows
```

## Roadmap

**Phase B — DOOM WASM daemon**: a sidecar process renders actual DOOM gameplay frames as ANSI art and writes them to `/tmp/afk-arcade/doom/frame.ans`. The statusline polls that file (< 5s old = daemon alive) and renders it verbatim. File contract is already wired in `statusline.mjs`.
