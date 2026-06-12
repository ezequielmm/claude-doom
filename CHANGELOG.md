# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.9.0] — 2026-06-12

### Added

- **`scripts/doomscreen.mjs` — the universal backdrop (HANDOFF §4 + §5)**:
  DOOM behind Claude Code in ANY terminal via pure text-cell composition,
  ~15 fps (`AFK_DOOMSCREEN_FPS` 5–20). Claude runs inside a pseudo-terminal,
  its screen lives in a vendored `@xterm/headless`, and the compositor
  diff-paints game+claude cells wrapped in synchronized output
  (`CSI ?2026`). Cursor mirrors Claude's virtual cursor (DECTCEM tracked
  from the output stream).
  - **Windows PTY layer**: `conhost.exe --headless` spawned directly from
    node — zero dependencies, plain-text input, in-band resize
    (`CSI 8;rows;cols t`, verified intercepted), exit-code propagation.
    The documented `CreatePseudoConsole` route (PowerShell Add-Type
    P/Invoke) was built first and dropped: its input pipe erratically
    drops bytes on Win11 26200 (output path fine) — see engram topic
    `claude-doom/conpty` for the full bisection.
  - **§5 absorbed — keyboard capture with zero Tcl**: on Windows the
    compositor owns stdin (raw mode). `F8` / `Ctrl+]` toggles claude ↔
    marine; game keys flow through `decodeKeys` → `mapKeyEventToDoom` →
    `control.json` (300 ms held-expiry, heartbeat sentinel release). A
    badge overlay shows game-mode controls. The expect-based
    `doomclaude.mjs` wrapper is now legacy (unix-only).
  - `--selftest`: conhost VT roundtrip check (win32; trivially passes
    elsewhere).
- **`scripts/fetch-xterm.mjs`**: vendors `@xterm/headless` (MIT, pinned
  5.5.0) into `vendor/xterm/` following the fetch-doom pattern; validates
  by instantiating a Terminal and round-tripping a glyph. Auto-runs on
  first doomscreen launch.
- **`lib/compose.mjs`**: pure compositor core — `parseFrameRgb`,
  `composeGrid` (claude-wins precedence, bg-49 legibility halo, full-bleed
  frame scaling), `renderDiff` (changed-cell runs with gap bridging,
  cursor parking), `xtermCellToCompose` (colour modes, attributes,
  wide-char continuations).
- **`test/screen.test.mjs`** (Phase I in `test/run.mjs`): 11 pure
  compositor tests + win32-only conhost roundtrip + a full doomscreen e2e
  drill (outer headless conhost provides the TTY; asserts typed input
  composites back, F8 badge renders, and held `W` lands in `control.json`
  as `KEY_UPARROW`).
- **`/afk screen`**: prints the doomscreen launch command.

### Changed

- **Full-speed compositor pipeline** (3.7 → 32 game fps / 28.6 paint fps):
  frame.rgb streams from the daemon tick loop at `config.screenFps`
  (default 35 — deliberately NOT backdropFps, whose 24 silently capped
  the stream) using the bulk `getFrameRGB` path; adaptive tick cadence
  (~36Hz via setImmediate-chaining while the compositor is live — Windows
  clamps setTimeout to ~15.6ms — banner pace otherwise); doomscreen
  paints at 30fps default (cap 35) with accumulator pacing and an idle
  skip when neither the game frame nor claude's output changed.
  `bot-status.json` now publishes live `tickHz`/`rawHz` telemetry.
- `scripts/daemon.mjs`: **compositor-implied bot** — a fresh
  `raw-request.json` lazily creates the bot even when `config.bot` is off,
  because both "start the game past the attract demo" AND the
  `control.json` ownership arbitration (F8 user input) live inside the
  daemon's bot block. The bot is disposed again when the compositor
  leaves. Without this, doomscreen booted into DOOM's demo loop and F8
  keys never reached the engine.
- `scripts/daemon.mjs`: `raw-request.json` may now carry `{cols, rows}` —
  the raw `frame.rgb` gets its own fullscreen dimensions, decoupled from
  the banner viewport (which the statusline rewrites every second and
  clamps to 80 px rows). Legacy empty-touch requests keep banner dims.

### Fixed

- `test/run.mjs`: async test failures were silent false positives (the
  sync `test()` printed PASS before promises settled and `process.exit(0)`
  outran the unhandled rejection); phases F–H counter snapshots wiped
  their results from the summary (reported 35 when 59 ran). Both fixed in
  the Windows-port commit series.

---

## [0.8.0] — 2026-06-11

### Added

- **`scripts/doomclaude.mjs` — F8 one-key keyboard takeover**: transparent PTY
  wrapper that runs `claude` inside a `/usr/bin/expect`-managed PTY. Press `F8`
  (or `AFK_ARCADE_DRIVE_KEY=f9|f10`) to enter DRIVE mode — keystrokes stop
  reaching Claude and instead flow to the DOOM bridge via
  `scripts/control.mjs --stdin-bridge`. Press `F8` again to return to Chat mode.
  Claude keeps running completely unaffected; only stdin is redirected.
  - `--selftest` flag: wraps a `/bin/stty size` inner process through
    `/usr/bin/script` to verify the PTY mechanism end-to-end without launching
    claude. Accepts `0x0` from headless/CI fabricated PTYs as a valid pass.
  - `AFK_ARCADE_DRIVE_KEY` env variable: `f8` (default), `f9`, `f10`.
  - Terminal bell (`\a`) rings once on each toggle as tactile feedback.
  - SIGWINCH propagation: `trap WINCH` updates claude's PTY size on terminal
    resize.
- **`scripts/control.mjs --stdin-bridge` flag**: new mode that skips the TTY
  requirement and reads raw bytes from STDIN (pipe). Decodes keys via the same
  `decodeKeys`/`HeldKeyTracker` path as interactive mode and writes `control.json`
  at ~15Hz while input is active. Idle protocol:
  - 2000ms without bytes → writes `heartbeat:0` once and idles (bot resumes).
  - `\x00\x01` sentinel (from wrapper drive-exit) → immediate `heartbeat:0` + exit.
  - STDIN close → `heartbeat:0` + clean exit.
- **`test/wrapper.test.mjs`** (Phase H) — 10 tests: 7 bridge unit tests
  (held keys, released keys, taps, sentinel, 2s silence auto-release, wake-up
  after silence, stdin-close cleanup) + 3 doomclaude tests (selftest passes,
  `f9` key accepted, invalid key falls back with warning). Wired into
  `test/run.mjs`.

## [0.7.1] — 2026-06-11

### Added
- **/doom — Claude takes the controls**: agentic gameplay. The slash command instructs
  the session to Read the live backdrop frame (vision), narrate one line per move, and
  act via the new `afk-ctl act <keys> [--ms]` one-shot input (holds keys with a live
  heartbeat, then releases — the daemon treats it exactly like a human controller, so
  the bot suspends and resumes automatically). ~12 moves per invocation.

## [0.7.0] — 2026-06-11

### Added
- **User controller sidecar** (`scripts/control.mjs`) — interactive CLI run in a
  second terminal tab. Raw-mode stdin; WASD/arrows held, SPACE/F/X/1-7/Enter/Esc
  forwarded to the engine; Q/Ctrl+C releases cleanly. Writes
  `TMP_ROOT/doom/control.json` atomically at ~15Hz and immediately on any key change.
- **Ownership switch in daemon** — daemon reads `control.json` every ≤100ms and calls
  `controlOwner()` to decide who drives. On `bot → user` transition: `bot.suspend()`
  releases all held keys and drains the key queue. On `user → bot` transition: all
  user-held codes are released and `bot.resume()` re-arms the bot. User tap events are
  sent as down+up pairs with ~80ms pulse.
- **`bot.suspend()` / `bot.resume()`** on `lib/doom-bot.mjs` — clean handoff API for
  the ownership switch.
- **`lib/control-core.mjs`** — pure (no I/O) helper module:
  `mapKeyEventToDoom(keyName)`, `buildControlState(held, taps, seq)`,
  `controlOwner(state, nowMs)`. Fully unit-testable without a TTY.
- **`/afk control`** command on `afk-ctl.mjs` — on Darwin+Warp: writes a uniquely
  timestamped Warp launch config (`claude-doom-ctl-<epoch>.yaml`) and opens it via
  `warp://launch/`. Cleans up generated configs older than 1 day. Falls back to
  printing the manual command on other platforms/terminals.
- **`bot-status.json` gains `owner` field** — `"user" | "bot"`. Statusline shows
  *"you're driving 🎮"* when `owner === 'user'` (overrides all other mode text).
- **RSS self-check belt** — daemon checks `process.memoryUsage().rss` every ~30s.
  If RSS > 450 MB: logs `{ recycle: 'rss', rssMb }` and exits 0 (statusline respawns).
- **Kitty image hygiene belt** — every ~45s the daemon prepends `kittyDeleteImage(77)`
  to the next backdrop streaming write (single atomic `writeSync`). Purges accumulated
  image storage from Warp's replace-by-id calls.
- **`rssMb` in telemetry** — periodic stream dbgLog entry now includes `rssMb`.
- **`test/control.test.mjs`** (Phase G) — 10 unit tests:
  `mapKeyEventToDoom` mapping correctness, `buildControlState` schema/capping,
  `controlOwner` fresh/stale/zero/null, `bot.suspend()` no-down-press guarantee,
  `bot.resume()` re-issue-forward guarantee. Wired into `test/run.mjs`.

### Changed
- `bot-status.json` now includes `owner: "user" | "bot"` and `rssMb` fields.
- Statusline `buildHudLine` checks `botStatus.owner === 'user'` before any other
  status text (attention/working/idle/afk) to surface the "you're driving" state.

## [0.6.0] — 2026-06-11

### Added
- **Daemon-side backdrop streaming** — the daemon now pushes kitty backdrop
  frames directly to each registered tty at game-native framerate instead of
  waiting for the statusline to pull them.  The statusline only upserts its
  tty into `TMP_ROOT/tty-registry.json` (atomic read-modify-write); the daemon
  reads the registry at most every 1000ms, prunes stale entries (>30s), and
  sends a fresh kitty-z=-2 frame to every live tty on each streaming tick.
- **`backdropFps` config** (default `24`, clamped `5..35`) — controls the
  daemon streaming rate.  DOOM's internal tic rate is 35fps; values above that
  are clamped.  Set with `/afk backdrop fps <N>`.
- **`/afk backdrop fps <5..35>`** — new sub-command to tune streaming fps.
- **Heuristic bot** (`lib/doom-bot.mjs`) — pixel-heuristic autopilot that
  drives the engine via `pushKey` without any `setInterval`.  Behavior:
  - **Not in-game**: detects title/attract screen (bottom 12% frame analysis)
    and sends ENTER sequences to start a new game; retries every 8s.
  - **In-game calm** (`aggressive=false`): holds FORWARD most of the time;
    random wander turns every 1.2–2.5s; fires in bursts on fleshy-pixel
    monster detection (>8% of sampled center region); USE every 4s; ENTER
    every 10s; stuck detection (center unchanged >1.6s) triggers an unstick
    turn.
  - **In-game aggressive** (`aggressive=true`): fires on >4% monster signal
    (twice as trigger-happy), wander turns every 0.8–1.5s, periodic
    forward+fire rush every 5s.
- **`/afk bot on|off`** — enable/disable the heuristic bot.
- **Aggressive mode trigger**: daemon reads session state files at most every
  1000ms; `aggressive=true` when any session has `mode='working'` with
  `updatedAt` within the last 15s.
- **Bot status HUD**: daemon writes `TMP_ROOT/doom/bot-status.json` (atomic,
  ~1s cadence); statusline reads it (fresh <5s) and shows:
  - Working + bot aggressive → `"claude is playing — go grab a coffee ◈"`
  - Bot active (any mode) → `"autopilot · type away"`
- **`lib/registry.mjs`** — extracted TTY registry helpers (`upsertTtyRegistry`,
  `removeTtyEntry`, `readRegistry`, `pruneRegistry`, `REGISTRY_TTL_MS`) for
  unit testability.
- **`test/bot.test.mjs`** — 7 tests: start-sequence ENTER taps, FORWARD held
  on in-game frame, FIRE burst on monster signal, stuck-detection turn+release,
  aggressive vs calm threshold behavioral difference, registry upsert format,
  and pruneRegistry stale-entry removal.  Wired into `test/run.mjs` as Phase F.

## [0.5.0] — 2026-06-11

### Added
- **Backdrop mode** (`/afk backdrop on|off`) — the darkened DOOM frame becomes the
  WHOLE terminal background: transmitted out-of-band to the session's tty as a kitty
  graphics placement with negative z-index (`z=-2`), so the terminal composites the
  game UNDER Claude Code's UI. Verified live in Warp: the conversation floats over
  the game, animated at the statusline cadence. The banner collapses to a single HUD
  line while active. `backdropDim` config (default 0.4) controls darkening.
- Daemon self-recycle watchdog: exits cleanly when its output freezes (>90s) or after
  a 30-minute lifetime; the statusline respawns a fresh daemon within a second.
- Low-contrast quadrant collapse: near-equal fg/bg cells render as a single colored
  space — immune to terminal minimum-contrast passes (Warp) that whitened them.

### Fixed
- Per-session transmission bookkeeping (backdrop/pixel) — concurrent sessions in
  different terminals no longer clobber each other's discovered tty path.
- 12s frame freshness window hides daemon recycles behind a frozen frame instead of
  flashing the fire fallback.

## [0.4.1] — 2026-06-11

### Added
- **Deep diagnostics** — JSONL structured debug log at `~/.claude/afk-arcade/debug.log`.
  - `lib/debug.mjs`: `debugEnabled(config)` (checks `config.debug === true` or `AFK_ARCADE_DEBUG=1`); `dbgLog(component, fields)` appends one JSON line per call. Rotates at 500 KB: current file renamed to `debug.log.1` (overwrites previous `.1`) before each new line. Never throws.
  - `scripts/statusline.mjs` instrumented: one `dbgLog('statusline', diag)` call per invocation (success and error paths). Captures `sid`, `style`, `game`, `rows`, `cols`, `env` (raw `TERM_PROGRAM`, `TERM`, `COLORTERM`, `COLUMNS×LINES`), `mode`, `tMs` (total runtime), `out` (kind, lines, bytes, 80-char sample of second output line). When `style=pixel`: nested `pixel` object with `tty` (ok or `err:<msg>`), `png` (age + bytes or `'missing'`), `tx` (sent/skipped, bytes, chunks, ms), `fellBack` (exact reason string).
  - `scripts/daemon.mjs` instrumented: `dbgLog('daemon', {...})` on frames 1, 2, 3, then every 20th. Fields: `frame`, `style`, `engineDims`, `viewport`, `gameW`, `tScaleMs`, `tRenderMs`, `ansBytes`; `tPngMs` and `pngBytes` added when `style=pixel`.
  - `/afk debug on` / `debug off` — write `{ debug: true|false }` to config + confirmation message.
  - `/afk debug tail [n]` — print last `n` lines (default 30) from `debug.log` raw (JSONL).
  - `/afk` help text updated with the three `debug` sub-commands.
- `test/debug.test.mjs` — 4 new tests: (1) `dbgLog` writes parseable JSONL with `ts` and `c`; (2) rotation triggers when file > 500 KB; (3) statusline with `AFK_ARCADE_DEBUG=1` produces a log line whose `out.kind` is a known value and `env.sz` reflects `COLUMNS`; (4) debug off (no env, no `config.debug`) — no log file created. Wired into `test/run.mjs` as Phase E.

---

## [0.4.0] — 2026-06-11

### Added
- **Experimental pixel banner via kitty Unicode placeholders** (`/afk style pixel`): when the DOOM daemon is active, the statusline transmits a PNG out-of-band directly to `/dev/tty` using an APC sequence with `a=T,U=1,q=2` (virtual placement, suppressed responses), then emits pure-text placeholder lines to stdout. Each placeholder cell is U+10EEEE plus two combining diacritics (row index and column index from the official spec table) with the image ID encoded in the SGR foreground color using 256-color mode (`\x1b[38;5;<id>m`). The daemon writes `frame.png` at ≤4 fps (640×400 half-res 2×2 box downscale) alongside `frame.ans`.
- `kittyVirtualImage(pngBuffer, { imageId, cols, rows })` in `lib/gfx-protocol.mjs`: builds the `U=1` chunked APC transmission string (writes to `/dev/tty`, not stdout).
- `kittyPlaceholderLines({ imageId, cols, rows, leftPad })` in `lib/gfx-protocol.mjs`: returns an array of placeholder text lines for the virtual placement.
- `DIACRITICS` table (241 entries) in `lib/gfx-protocol.mjs`, sourced from the official kitty spec download at `https://sw.kovidgoyal.net/kitty/_downloads/f0a0de9ec8d9ff4456206db8e0814937/rowcolumn-diacritics.txt`, with a citation comment.
- `FRAME_PNG` constant in `scripts/daemon.mjs`; pixel-style `writeFrame` path encodes a half-res PNG via `encodePngFast` and writes it atomically to `DOOM_TMP/frame.png`.
- `AFK_ARCADE_NO_PIXEL=1` env var hard-disables pixel mode regardless of config.
- `pixel-tx.json` bookkeeping in `TMP_ROOT` tracks last transmitted PNG mtime to avoid redundant `/dev/tty` writes.
- Style `"pixel"` validated in `scripts/afk-ctl.mjs` style subcommand with help text.
- 3 new tests in `test/gfx.test.mjs` (tests 11–13): placeholder line count/width/SGR color, `kittyVirtualImage` envelope (U=1, i=42, q=2, c/r, chunking, base64 roundtrip), and daemon pixel path PNG signature + IHDR dims validation.

### Changed
- `lib/gfx-protocol.mjs`: refactored `kittyImage` to use the shared `_kittyChunks` helper (also used by `kittyVirtualImage`) — no behavior change.
- `lib/state.mjs`: `CONFIG_DEFAULTS.style` comment expanded to document `"pixel"` option.
- `scripts/statusline.mjs`: pixel style path in the DOOM section; fires fallback to quad-style fire and quad-style ANSI frame when pixel conditions are not met. `fireW` now covers `style === 'pixel'` (same as `'quad'`).
- `scripts/daemon.mjs`: `writeFrame` always writes `frame.ans` (quad ANSI, universal fallback); additionally writes `frame.png` when `style === 'pixel'`.
- README and `docs/i18n/README.es.md`: new "Experimental: pixel banner" section with requirements, mechanics, caveat, and escape hatches.

---

## [0.3.1] — 2026-06-11

### Added
- **Runtime Kitty graphics capability probe** (`probeKittyGraphics` in `lib/gfx-protocol.mjs`): sends a 1×1 RGB query APC followed by a DA1 fence and resolves `true` only when the terminal explicitly replies `\x1b_Gi=4242;OK\x1b\\`. Pixel-perfect mode now auto-enables on any terminal that speaks the Kitty graphics protocol — including recent Warp builds — without relying on environment variables alone.
- **`--gfx auto` probe path in `scripts/play.mjs`**: when env-based detection yields no result (e.g. `TERM_PROGRAM=WarpTerminal`), the probe runs on the real TTY before the alternate screen opens so response bytes never leak visibly. Status row shows `gfx:kitty(probe)` / `gfx:iterm2` / `text:quad` to make the decision transparent.
- **`/afk play` auto-launches a Warp tab on macOS**: writes `~/.warp/launch_configurations/claude-doom.yaml` (creating the directory if needed) and opens it via `warp://launch/<url-encoded-path>`. Falls back to printing the manual command if `open` fails or Warp is not installed. On macOS with iTerm2 but no Warp, prints the command with a note to run it inside iTerm2 for pixel mode.
- 5 new tests in `test/gfx.test.mjs` covering probe OK→true, DA1-only→false, timeout→false, keystroke carry-over, and the Warp YAML/URI template.

### Changed
- `lib/gfx-protocol.mjs` exports `probeKittyGraphics` in addition to existing exports.
- `scripts/play.mjs` imports `probeKittyGraphics`; `auto` detection is async and probe-aware.
- `scripts/afk-ctl.mjs` `play` case: on darwin with Warp installed, writes the launch config YAML and opens it via the URI scheme instead of only printing the command.

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

[0.4.0]: https://github.com/ezequielmm/claude-doom/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/ezequielmm/claude-doom/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ezequielmm/claude-doom/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/ezequielmm/claude-doom/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ezequielmm/claude-doom/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ezequielmm/claude-doom/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ezequielmm/claude-doom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ezequielmm/claude-doom/releases/tag/v0.1.0
