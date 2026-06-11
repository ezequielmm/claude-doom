# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.3.0] — 2026-06-11

### Added
- **Adaptive quadrant renderer** (`renderQuadrants` in `lib/render.mjs`): uses all 16 Unicode Block Elements (U+2580–U+259F) to pack a 2×2 pixel quad per cell — doubles horizontal detail vs the previous `▀`-only renderer while remaining universally supported.
- `lib/postfx.mjs` — two in-place post-processing passes applied after downscaling:
  - `sharpen(buf, w, h, amount=0.6)` — unsharp mask (3×3 box blur, edge-clamped) that lifts edge contrast noticeably in dark DOOM corridors.
  - `toneLift(buf, { gamma=0.88, saturation=1.12 })` — gamma expansion + per-pixel saturation lift around luma; brightens midtones and restores colour on terminal backgrounds without blowing out highlights.
- `style` config key (`"quad"` | `"half"`, default `"quad"`) in `lib/state.mjs` and persisted via `~/.claude/afk-arcade/config.json`.
- `/afk style <quad|half>` subcommand in `scripts/afk-ctl.mjs`; `style` is now shown in `/afk status` output.
- Sharpen + tone lift also applied on the `half`-block path (no-cost improvement for existing users).
- Quad fire: statusline fire simulation runs at 2× horizontal resolution when `style=quad` (`createFire(width*2, pixH)`); dimension mismatch in existing `.fire` files triggers automatic re-initialisation (pre-existing behavior).
- `test/render.test.mjs` — 16 unit tests covering glyph selection, color codes, SGR batching, output dimensions, sharpen range/contrast, toneLift monotonicity/identity, and a 160×60 performance benchmark (consistently 10–15 ms).
- `test/run.mjs` Phase D wires the render tests into the main suite.

### Changed
- `scripts/daemon.mjs` `writeFrame`: routes through quad or half-block pipeline based on `config.style`; both paths apply sharpen + tone lift.
- `scripts/statusline.mjs`: fire render path selects `renderQuadrants` or `renderHalfBlocks` based on `config.style`.
- `scripts/play.mjs` non-gfx fullscreen path: samples at `gameWcells*2` horizontal resolution and renders with `renderQuadrants` when `style=quad`; shows `[quad]` / `[half]` indicator in the status row. `--gfx` pixel-protocol path is untouched.

---

## [0.2.1] — 2026-06-11

### Added
- **Zero-step install**: new users only need `claude plugin marketplace add` + `claude plugin install` + restart — everything self-wires on the first `SessionStart`.
- `scripts/auto-setup.mjs` — silent SessionStart hook (MUST NOT print to stdout): creates config.json, writes/refreshes statusline.sh shim, adds `statusLine` to `~/.claude/settings.json` only if absent (with one-time backup), spawns `fetch-doom.mjs` detached in the background when `game === 'doom'`.
- `lib/setup-core.mjs` — shared, side-effect-free helpers: `ensurePluginConfig`, `ensureShim`, `ensureStatusline`, `ensureDoomAssets`, `log`.
- `scripts/setup.mjs` — guided interactive installer (`/afk setup [--yes] [--no-iterm]`): Node version check, config/shim/statusline wiring, DOOM asset download, graphics protocol detection, iTerm2 install offer on macOS via Homebrew.
- `/afk setup` subcommand in `scripts/afk-ctl.mjs`.
- `hooks/hooks.json`: second `SessionStart` hook entry for `auto-setup.mjs` (timeout 15 s).
- "What gets written to your machine" transparency table in README (EN + ES).
- Collapsed `<details>` manual-setup section in README for users who prefer explicit control.

---

## [0.2.0] — 2026-06-11

### Added
- Playable fullscreen DOOM mode (`node scripts/play.mjs`) with held-key input tracking via `lib/keys.mjs`
- Pixel-perfect mode (`--gfx auto`) — real 1280×800 PNG frames streamed at adaptive fps via iTerm2 inline images and the Kitty graphics protocol (`lib/gfx-protocol.mjs`)
- `--res half` flag for 640×400 mode using 2×2 box averaging (lower bandwidth)
- Zero-dependency PNG encoder (`lib/png.mjs`) — no npm install required
- Capture tooling (`scripts/capture.mjs`) to generate title/gameplay/fire screenshots from a live daemon
- Graphics protocol test suite (`test/gfx.test.mjs`) — skips cleanly when vendor assets absent
- Play test suite (`test/play.test.mjs`)
- `scale.mjs` box-filter scaler with per-pixel area averaging

---

## [0.1.2] — 2026-06-10

### Added
- `4:3` aspect ratio mode (authentic CRT look) as the default — DOOM's 320×200 framebuffer scaled with correct pixel-aspect via box filter
- `16:10` aspect ratio mode as an alternative
- `stretch` aspect mode preserved for full-width legacy behavior
- Horizontal pillarbox gutters using the terminal's own background color
- Framebuffer auto-detection: statusline reads terminal dimensions and writes `viewport.json` for the daemon
- Unix-socket singleton guard (pidfile at `/tmp/afk-arcade/doom/daemon.pid`) — prevents double-spawning

---

## [0.1.1] — 2026-06-10

### Added
- DOOM WASM daemon (`scripts/daemon.mjs`) — doomgeneric compiled to WebAssembly, runs detached, streams `frame.ans` every ~1 s
- `scripts/fetch-doom.mjs` — downloads GPL-2.0 engine and shareware WAD from the opentui-doom npm CDN into `vendor/` (gitignored)
- Attract-mode: daemon auto-spawns when statusline renders in `doom` mode with no live frame; auto-exits after 10 min of no viewport updates or on `SessionEnd`
- `/afk game doom` command to switch banner to live DOOM frames
- Fallback: statusline shows fire with "doom: warming up" HUD while the daemon starts
- `lib/doom-engine.mjs` — WASM adapter with `getFrameRGB`, `pushKey`, `tick` interface

---

## [0.1.0] — 2026-06-10

### Added
- PSX fire ambient banner rendered in Claude Code's statusline using Unicode half-block characters (`▀`)
- Hook state machine (`scripts/hook.mjs`) — responds to `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, and `Notification` events
- State transitions: `idle` → `working` (full fire) → `idle` (embers) → `afk` (demo) / `attention` (permission flash)
- `SessionStart` hook auto-writes `~/.claude/afk-arcade/statusline.sh` shim and `runtime.json`
- `/afk` control CLI (`scripts/afk-ctl.mjs`) — `status`, `on`, `off`, `game`, `rows`, `aspect`, `play`, `fetch-doom`
- `lib/fire.mjs` — cellular fire simulation (Doom PSX algorithm)
- `lib/render.mjs` — half-block ANSI renderer with 24-bit and 256-color modes
- `lib/state.mjs` — session state persistence across statusline invocations
- Core test suite (`test/run.mjs`, `test/doom.test.mjs`) — DOOM tests skip cleanly when vendor assets absent
- Zero npm dependencies — pure Node.js ESM

[0.3.0]: https://github.com/ezequielmm/claude-doom/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/ezequielmm/claude-doom/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ezequielmm/claude-doom/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ezequielmm/claude-doom/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ezequielmm/claude-doom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ezequielmm/claude-doom/releases/tag/v0.1.0
