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
  <img src="https://img.shields.io/badge/version-0.4.1-informational" alt="version 0.4.1" />
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

## The Three Modes

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
