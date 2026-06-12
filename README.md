<h1 align="center">
  <picture>
    <img src="captures/title-1280.png" width="680" alt="claude-doom — real DOOM in your Claude Code statusline" />
  </picture>
  <br />
  claude-doom
</h1>

<p align="center">
  🇬🇧 English &nbsp;•&nbsp; <a href="docs/i18n/README.es.md">🇪🇸 Español</a>
</p>

<h4 align="center">
  Real DOOM (doomgeneric WASM) inside <a href="https://claude.com/claude-code">Claude Code</a>'s statusline —
  fire while Claude works, attract-mode DOOM when you're AFK, pixel-perfect fullscreen play in iTerm2/kitty/Warp.
</h4>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/version-0.8.0-informational" alt="version 0.8.0" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/dependencies-zero-success" alt="Zero dependencies" />
  <img src="https://img.shields.io/badge/Claude%20Code-%3E%3D2.1.153-blueviolet" alt="Claude Code >= 2.1.153" />
</p>

<br />

<p align="center">
  <table align="center">
    <tr>
      <td align="center">
        <img src="captures/gameplay-1280.png" width="500" alt="Pixel-perfect mode — real 1280×800 PNG frames via terminal graphics protocols" />
        <br />
        <em>Pixel-perfect mode — real 1280×800 PNG frames via terminal graphics protocols</em>
      </td>
      <td align="center">
        <img src="captures/fire.png" width="200" alt="PSX fire ambient banner" />
        <br />
        <em>PSX fire ambient banner</em>
      </td>
    </tr>
  </table>
</p>

---

## Quick Start

```sh
# 1. Install the plugin
claude plugin marketplace add ezequielmm/claude-doom
claude plugin install afk-arcade@afk-arcade-marketplace

# 2. Restart Claude Code
```

That's it. On the first `SessionStart` the auto-setup hook:
- Creates `~/.claude/afk-arcade/config.json` with DOOM-first defaults.
- Writes `~/.claude/afk-arcade/statusline.sh` (the shim that drives the banner).
- Adds `statusLine` to `~/.claude/settings.json` **only if you don't already have one** — a backup is saved as `settings.json.afk-arcade-backup` before any change.
- Downloads the DOOM engine assets in the background (shareware WAD + GPL doomgeneric WASM — fetched on demand, never bundled). Progress logs to `~/.claude/afk-arcade/setup.log`.

**Optional guided installer** — also offers iTerm2 on macOS for pixel-perfect mode:

```
/afk setup
```

### What gets written to your machine

| Path | What it is | When |
|---|---|---|
| `~/.claude/afk-arcade/config.json` | Plugin settings (game, rows, aspect) | First install only, never overwritten |
| `~/.claude/afk-arcade/statusline.sh` | Shim that Claude Code executes for the banner | Created/refreshed on SessionStart |
| `~/.claude/afk-arcade/setup.log` | Setup and asset-fetch log | Appended on SessionStart; rotated at 200 KB |
| `~/.claude/settings.json` | `statusLine` key added (if absent) | Once only; backup saved first |
| `~/.claude/settings.json.afk-arcade-backup` | Backup of settings.json before first edit | Written once, never overwritten |
| `<plugin>/vendor/doom/` | doom.js, doom.wasm, doom1.wad | Downloaded on first setup (gitignored) |

<details>
<summary>Manual setup (if you prefer to wire things yourself)</summary>

```sh
# Write the shim and runtime files
node <plugin>/scripts/hook.mjs   # via SessionStart, or run manually once

# Download DOOM assets
node <plugin>/scripts/fetch-doom.mjs

# Add to ~/.claude/settings.json
```

```json
{
  "statusLine": {
    "type": "command",
    "command": "/bin/bash ~/.claude/afk-arcade/statusline.sh",
    "refreshInterval": 1,
    "padding": 0
  }
}
```

</details>

---

## The Four Modes

### 1. Statusline banner

The banner lives in Claude Code's status row and responds to the editor's event stream via a hook state machine:

| Event | State | Visual |
|---|---|---|
| `UserPromptSubmit` | `working` | Full fire / DOOM rolling |
| `Stop` / `StopFailure` | `idle` | Embers — "done, waiting for you" |
| `Notification: idle_prompt` | `afk` | DOOM attract-mode demo |
| `Notification: permission_prompt` | `attention` | Yellow warning HUD flash |

Switch between the fire effect (`/afk game fire`) and the live DOOM daemon (`/afk game doom`) at any time.

### 2. Fullscreen half-blocks

Play DOOM interactively, using Unicode half-block characters (`▀`) to render every frame in any 256-color terminal:

```sh
node scripts/play.mjs
```

Controls: `WASD` / arrow keys to move, `SPACE` to open doors, `F` to fire, `1`–`7` to switch weapons, `ESC` for menu, `Q` or `Ctrl+C` to quit.

### 3. Pixel-perfect mode

Real 1280×800 PNG frames streamed at adaptive fps via native terminal graphics protocols:

```sh
node scripts/play.mjs --gfx auto
```

The `--gfx auto` flag detects your terminal and picks the best protocol. For terminals not identified by environment variables (e.g. Warp), a runtime capability probe is run automatically — pixel mode activates if the terminal replies with a Kitty graphics OK, otherwise quadrant text mode is used. Use `--res half` for 640×400 if your connection is slow.

| Terminal | Support |
|---|---|
| iTerm2 | Full (iTerm2 inline images) |
| kitty | Full (Kitty graphics protocol) |
| WezTerm | Full (iTerm2 inline images) |
| Warp | **Auto-probed** — pixel mode if your build speaks Kitty graphics, quadrant text otherwise |
| Apple Terminal | Quadrant text fallback |

### 4. Universal backdrop (doomscreen)

DOOM as the background of your **entire terminal** with Claude Code floating on
top — in ANY terminal, no graphics protocols, no extra tab. Pure text-cell
composition at ~15 fps:

```sh
node scripts/doomscreen.mjs            # launches claude inside
node scripts/doomscreen.mjs -- cmd     # wrap any other command
```

Claude runs inside a pseudo-terminal (`conhost.exe --headless` on Windows,
`script(1)` on macOS/Linux) and its screen lives in a vendored
`@xterm/headless` instance. Each tick the compositor merges the DOOM frame
(quadrant glyphs) with Claude's cells — Claude wins wherever it has content,
the game shows through everywhere else — and diff-paints only changed cells,
wrapped in synchronized output.

On Windows your keyboard is routed by the compositor itself: press **F8** (or
`Ctrl+]`) and your keys drive the marine via `control.json` (the bot yields);
press it again to give the keyboard back to Claude. No `expect`, no Tcl.

Tune with `AFK_DOOMSCREEN_FPS` (5–20, default 15). `/afk screen` prints the
launch command.

---

## How It Works

```
┌──────────────────────────────────────────────────────────────────┐
│ Claude Code                                                        │
│                                                                    │
│  hooks ──► hook.mjs (state machine)                               │
│              writes ~/.claude/afk-arcade/{config,runtime}.json    │
│              writes /tmp/afk-arcade/sessions/<id>.json            │
│              SIGTERM → daemon (SessionEnd cleanup)                │
│                                                                    │
│  statusLine ──► statusline.mjs (1 fps poll)                       │
│                   reads session state                              │
│                   reads frame.ans  ◄── daemon.mjs                 │
│                   if stale → spawns daemon (detached, auto-exits) │
│                   renders half-blocks or passes through to        │
│                   terminal graphics protocol                      │
│                                                                    │
│  /afk ──► afk-ctl.mjs                                             │
└──────────────────────────────────────────────────────────────────┘
```

`daemon.mjs` runs doomgeneric compiled to WebAssembly in a detached Node.js process. Every ~1 s it reads `viewport.json` (terminal dimensions from the statusline), scales DOOM's 320×200 framebuffer through a box filter to the current banner size, and writes `frame.ans` atomically. A pidfile guards against double-spawning. The daemon self-terminates after 10 minutes of no viewport updates, or immediately on `SessionEnd`.

`play.mjs --gfx auto` bypasses the half-block renderer entirely: it reads the raw RGB framebuffer, zero-dependency-encodes it to PNG, and streams it to the terminal using the appropriate inline-image escape sequence at adaptive fps.

---

## Renderer

The default `quad` renderer uses all 16 Unicode Block Elements (▀▄▌▐▘▝▖▗▚▞▛▜▙▟█ and space) to pack a 2×2 pixel quad into each terminal cell — doubling the horizontal detail of the classic `▀` half-block renderer with no extra terminal requirements.

After downscaling, two post-processing passes run automatically regardless of style:
- **Edge sharpening** (unsharp mask) — lifts local contrast, making dark DOOM corridors and fire edges crisper.
- **Tone lift** — gentle gamma expansion + saturation boost so the image reads clearly on both light and dark terminal backgrounds.

Switch styles at any time:

```sh
/afk style quad   # adaptive 2×2 blocks (default)
/afk style half   # classic ▀ half-block
/afk style pixel  # experimental — kitty Unicode placeholders (see below)
```

---

## Experimental: pixel banner (kitty Unicode placeholders)

### Backdrop mode — the game as your terminal's background

`/afk backdrop on` turns the darkened DOOM frame into the **background of the whole
terminal**: the daemon streams kitty graphics frames (z=-2 negative z-index) directly
to each registered session tty at game-native framerate, so the terminal composites the
game UNDER Claude Code's UI — your conversation floats over DOOM, animated. The banner
collapses to a single HUD line. Verified live in Warp.

**Streaming fps**: the daemon pushes frames at `backdropFps` (default `24`, clamped
`5..35`; DOOM's internal tic rate is 35fps). Tune it with `/afk backdrop fps <N>`.

Requires a terminal with kitty graphics support (Warp, kitty, WezTerm, Ghostty);
terminals without it silently ignore the image — use `/afk backdrop off`. Darkening is
tunable via the `backdropDim` config key (default `0.4`).

### The bot

`/afk bot on` enables a **pixel-heuristic autopilot** that plays DOOM while the banner
runs in daemon mode. It's the demo that keeps the game alive and interesting while you
work:

- **While you type** (idle/afk session state): calm autopilot — holds forward, random
  wander turns, fires on monster sightings, presses USE every ~4s to open doors.
- **While Claude is working** (working session state): the bot ramps up aggression —
  fires more eagerly (threshold halved), turns more frequently, and adds periodic
  forward+fire rushes. The HUD shows *"claude is playing — go grab a coffee ◈"*.

The bot is a pure pixel reader — it samples the framebuffer to detect the HUD strip
(in-game vs title screen), monster presence (fleshy-pixel heuristic in the center
region), and stuck states (unchanged center signature). No game-state injection.

```sh
/afk bot on    # enable (takes effect after daemon restarts)
/afk bot off   # disable (engine returns to attract demo)
```

### Take the wheel

`/afk control` opens a **controller sidecar** in a new Warp tab (or prints the
command for other terminals) so *you* play DOOM while Claude works:

```sh
/afk control
```

The philosophy: **you play while Claude thinks; the bot plays when the console
comes back to you and you start typing.** Ownership is fully automatic — no
mode-switch needed:

| Who drives | When |
|---|---|
| **You** | The controller tab is open and your heartbeat is fresh (<1.5s old) |
| **Bot** | Controller tab is closed, quit (`Q`), or 1.5s without a heartbeat |

The controller sends your keypresses to the daemon at ~15Hz via
`/tmp/afk-arcade/doom/control.json`. When you quit (`Q` or Ctrl+C), a
zero-heartbeat sentinel is written instantly and the bot resumes with no gap.
The HUD shows *"you're driving 🎮"* while the sidecar is connected.

Controls in the controller tab:

| Key | Action |
|---|---|
| `W` / `↑` | Move forward (held) |
| `S` / `↓` | Move backward (held) |
| `A` / `←` | Turn left (held) |
| `D` / `→` | Turn right (held) |
| `Space` | Use / open door (tap) |
| `F` or `X` | Fire weapon (held) |
| `1`–`7` | Select weapon (tap) |
| `Enter` | Menu confirm (tap) |
| `Esc` | Menu / escape (tap) |
| `Q` / `Ctrl+C` | Quit — hand back to bot |

### One-key takeover (F8)

**`doomclaude`** is a transparent launcher wrapper that lets you press a single
reserved key (`F8` by default) inside your **existing** Claude Code session to
grab the keyboard and drive the marine — then `F8` again to give it back. Claude
keeps running completely unaffected the whole time; it simply stops receiving
keystrokes while you drive, and its output keeps streaming over the game backdrop.

```sh
# Launch Claude Code through the wrapper
node ~/afk-arcade-claude/scripts/doomclaude.mjs

# Or add an alias for convenience
alias doom-claude='node ~/afk-arcade-claude/scripts/doomclaude.mjs'
doom-claude
```

| Mode | What happens |
|---|---|
| **Chat mode** (default) | Every byte from your keyboard flows to Claude untouched |
| **Press F8** | Enter DRIVE mode — keystrokes go to the DOOM bridge; Claude output still streams to the screen |
| **Press F8 again** | Back to Chat mode; bridge releases control and the bot resumes with no gap |

The terminal bell rings once on each toggle. The HUD shows *"you're driving 🎮"*
while the bridge is active (same signal as the sidecar controller tab).

**Env variable:** `AFK_ARCADE_DRIVE_KEY` — override the toggle key:

```sh
AFK_ARCADE_DRIVE_KEY=f9  doom-claude   # use F9 instead of F8
AFK_ARCADE_DRIVE_KEY=f10 doom-claude   # use F10
```

Valid values: `f8` (default), `f9`, `f10`.

**How it works:** the wrapper uses `/usr/bin/expect` (ships with macOS) to spawn
`claude` inside a PTY while keeping ownership of the real terminal. An `interact`
loop intercepts F8 and toggles between forwarding input to claude's PTY (chat
mode) and piping it to `scripts/control.mjs --stdin-bridge` (drive mode). Claude
Code never sees the F8 keypress and has no awareness of the mode switch.

**Self-test** (verifies the PTY mechanism without launching claude):

```sh
node ~/afk-arcade-claude/scripts/doomclaude.mjs --selftest
```

### Pixel banner (U=1 placeholders)

`/afk style pixel` enables an experimental mode that renders the DOOM banner as a **real PNG image inside the Claude Code statusline** using the [kitty graphics protocol Unicode placeholder](https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders) (U=1 virtual placements).

### Requirements

- Terminal with kitty graphics protocol **and** Unicode placeholder (U=1) support:
  **kitty**, **WezTerm**, **Ghostty**.
- **Warp (verified 2026-06)**: speaks core kitty graphics — fullscreen pixel play works at
  full speed — but does **not** yet implement U=1 placeholders, so the pixel banner renders
  as green placeholder glyphs there. Use `style quad` in Warp. Notably, Claude Code passes
  the placeholder text through faithfully, so this feature lights up the moment Warp ships U=1.
- DOOM mode must be active (`/afk game doom`).

### How it works

The daemon writes `frame.png` to `/tmp/afk-arcade/doom/` at ≤4 fps (half-resolution 2×2 box downscale — sharp enough, 4× cheaper than full res). The statusline:

1. Transmits the PNG **out-of-band** directly to `/dev/tty` via an APC sequence with `U=1,q=2` (suppresses all terminal responses so nothing leaks into Claude Code's stdin).
2. Emits **pure text placeholder lines** to stdout: each cell is `U+10EEEE` (the spec's private-use placeholder codepoint) with two combining diacritics encoding the row/column, and an SGR foreground color encoding the image ID.

Claude Code passes the placeholder text through its renderer. The terminal replaces each placeholder cell with the transmitted image pixel.

### Caveat

Claude Code's renderer passes ANSI escape sequences but its behavior with astral-plane Unicode codepoints and combining diacritics is not guaranteed across all versions. If you see garbled output or broken characters, revert:

```sh
/afk style quad
```

or hard-disable pixel mode regardless of config:

```sh
AFK_ARCADE_NO_PIXEL=1 # set in your environment
```

### Memory protection

Two built-in belts protect your machine from runaway resource usage:

1. **RSS self-check** — the daemon checks its own memory footprint every ~30s.
   If RSS exceeds 450 MB it exits cleanly; the statusline auto-respawns a fresh
   process within a second. Normal steady-state is ~120–200 MB.

2. **Kitty image hygiene** — every ~45s the daemon prepends a kitty delete
   command to the next backdrop frame write. This forces Warp to release
   accumulated image storage from replace-by-id calls that would otherwise
   grow unbounded at streaming rates.

---

## Commands

| Command | Description |
|---|---|
| `/afk status` | Show config and active session modes |
| `/afk on` / `/afk off` | Toggle the banner |
| `/afk game fire` | DOOM PSX fire effect (default) |
| `/afk game doom` | DOOM WASM daemon frames (auto-spawns daemon) |
| `/afk rows <N>` | Banner height, 2–30 rows |
| `/afk aspect <4:3\|16:10\|stretch>` | Frame aspect ratio (default: `4:3`) |
| `/afk style <quad\|half\|pixel>` | Renderer style: `quad` (default), `half` (classic `▀`), or `pixel` (experimental) |
| `/afk backdrop <on\|off>` | Game as terminal background (kitty z=-2); banner collapses to HUD |
| `/afk backdrop fps <5..35>` | Streaming fps for backdrop mode (default: `24`) |
| `/afk bot <on\|off>` | Heuristic bot pilot: calm autopilot while typing, aggressive while Claude works |
| `/afk control` | Take the wheel: open controller sidecar tab; bot autoplays when not connected |
| `doomclaude` | F8 one-key takeover: launch Claude through the wrapper; press F8 to toggle keyboard between Claude and the marine |
| `/afk play` | Launch DOOM in a Warp tab (macOS + Warp installed); otherwise print the command |
| `/afk fetch-doom` | Download DOOM WASM assets into `vendor/` |
| `/afk setup [--yes] [--no-iterm]` | Guided installer — wires statusline, downloads assets, offers iTerm2 |

---

## Configuration

`~/.claude/afk-arcade/config.json` is written on first `SessionStart` and persists across restarts.

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master on/off switch |
| `game` | `"fire"` | Active game mode (`fire` or `doom`) |
| `rows` | `5` | Banner height in terminal rows |
| `aspect` | `"4:3"` | DOOM frame aspect ratio |
| `style` | `"quad"` | Renderer style: `quad` (adaptive 2×2 blocks), `half` (classic `▀`), or `pixel` (experimental — see below) |
| `backdrop` | `false` | Daemon-side backdrop streaming (kitty z=-2) |
| `backdropDim` | `0.4` | Backdrop darkening factor (0.1–1.0) |
| `backdropFps` | `24` | Backdrop streaming fps (5–35; DOOM tic cap is 35) |
| `bot` | `false` | Heuristic bot player |

Edit the file directly or use `/afk` commands — they write through immediately.

---

## System Requirements

- **Node.js** >= 20
- **Claude Code** >= 2.1.153
- **Terminal** — truecolor recommended (256-color fallback is automatic)
- **Pixel-perfect mode** — requires iTerm2, kitty, or WezTerm

---

## Troubleshooting

**No banner in the statusline**
Run `claude plugin list` and confirm `afk-arcade` is active. Check that `statusLine.command` in your settings points to `~/.claude/afk-arcade/statusline.sh`.

**"doom: daemon offline" or "doom: warming up"**
The daemon needs a few seconds to start. If it stays offline, check that DOOM assets are present:
```sh
node scripts/fetch-doom.mjs
```

**Assets missing / fetch fails**
`fetch-doom.mjs` downloads from the `opentui-doom` npm package registry (no npm install — it uses the CDN tarball directly). Check your network connection and retry.

**Pixel mode looks wrong, slow, or shows artifacts**
Enable the diagnostic log to see exactly what happened on each statusline invocation:
```sh
/afk debug on
```
Wait a few seconds for the statusline to tick, then inspect the log:
```sh
/afk debug tail 10
```
Each line is a JSON object. For pixel renders look at `pixel.fellBack` (why it fell back to quad), `pixel.tty` (whether `/dev/tty` opened), `pixel.png.ageMs` (how stale the daemon frame was), and `pixel.tx.ms` (transmission time). You can also enable without touching config:
```sh
AFK_ARCADE_DEBUG=1 bash ~/.claude/afk-arcade/statusline.sh
```
The log rotates automatically at 500 KB (`debug.log` → `debug.log.1`). Disable when done:
```sh
/afk debug off
```

**Run the test suite**
```sh
node test/run.mjs
```

DOOM-specific tests skip automatically when `vendor/doom/` assets are absent.

---

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full plan — including NES and Game Boy emulators and a wide-banner Game SDK for building status-row games.

---

## Development

```sh
# Run the full test suite (DOOM tests skip cleanly if assets are absent)
node test/run.mjs

# Run the graphics protocol tests
node test/gfx.test.mjs

# Generate new captures from a running daemon
node scripts/capture.mjs
```

---

## Contributing

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/ezequielmm/claude-doom/issues).

Pull requests should:
- Keep the zero-dependency constraint (no `node_modules`, no `package.json` deps)
- Pass `node test/run.mjs` before submitting
- Follow conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)

---

## License & Credits

This plugin's code is released under the [MIT License](./LICENSE).

**Important legal notice:** The doomgeneric engine (GPL-2.0, by [ozkl](https://github.com/ozkl/doomgeneric)) and the DOOM shareware WAD (`doom1.wad`) are **downloaded separately** by `scripts/fetch-doom.mjs` and are **never bundled or committed** to this repository. The prebuilt WASM binary is sourced from the [opentui-doom](https://www.npmjs.com/package/opentui-doom) npm package. DOOM is a registered trademark of id Software, LLC.

---

<p align="center">
  Made with care by <strong>Gentleman Programming</strong>
  <br />
  If this made your terminal more fun, consider giving it a ⭐ on <a href="https://github.com/ezequielmm/claude-doom">GitHub</a>.
</p>
