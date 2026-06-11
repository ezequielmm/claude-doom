# ROADMAP

A living document of planned directions for afk-arcade. Each item includes a short rationale and concrete first steps.

---

## 1. Emulator games (NES / Game Boy)

**Rationale.**
DOOM proved the pattern: run a WASM engine, read its framebuffer, push it through `renderHalfBlocks`, route input through `HeldKeyTracker`. Classic 8-bit consoles are the next natural step — their resolutions are tiny (160×144 for Game Boy, 256×240 for NES) and several C/Rust emulators already compile cleanly to WASM.

**Verified WASM-friendly candidates:**

| Console   | Project           | Source language | Resolution | Notes |
|-----------|-------------------|-----------------|------------|-------|
| Game Boy  | [binji/binjgb](https://github.com/binji/binjgb) | C → WASM        | 160×144    | Near-perfect fit for the banner; half-height renders in ~10 terminal rows |
| NES       | [jsnes](https://github.com/bfirsh/jsnes)         | Pure JS         | 256×240    | No WASM compile needed; import as ESM or CJS                             |
| NES       | [takahirox/nes-rust](https://github.com/takahirox/nes-rust) | Rust → WASM | 256×240  | Smaller binary than jsnes; `wasm-pack` output |

**ROM licensing.**
The plugin ships nothing. The user supplies their own ROM files. For public demos, freely redistributable homebrew ROMs work (e.g. [Tobu Tobu Girl](https://tangramgames.dk/tobutobugirl/) CC BY, [Lan Master](https://gbhh.avivace.com/game/lan-master) freeware NES).

**Common adapter interface:**
```
{
  init(romBytes: Uint8Array): Promise<void>
  tick(): void                        // advance one frame
  getPixel(x, y): [r, g, b]          // read framebuffer
  pushKey(pressed: 0|1, code): void   // inject input
  width: number
  height: number
  dispose(): void
}
```
This is already satisfied by `doom-engine.mjs`; the emulator adapters will match the same shape so `play.mjs` and `daemon.mjs` can drive any game through the same loop.

**First steps:**
1. Vendor `jsnes` as a zero-dependency ESM shim (`vendor/nes/`).
2. Write `lib/nes-engine.mjs` implementing the adapter interface above.
3. Extend `scripts/play.mjs` to accept `--game nes --rom path/to/rom.nes`.
4. Add `game nes` to `afk-ctl.mjs` and the daemon (daemon renders attract-mode demo ROM).
5. Repeat for binjgb (Game Boy) with a `vendor/gb/` WASM bundle.

---

## 2. Wide-banner Game SDK

**Rationale.**
The "stretch" aspect mode was originally a fallback, but it revealed something better: the statusline is a native ultra-wide canvas (~200–220 × 20–30 pixels in truecolor, ~100–110 columns × 10–15 half-block rows in practice). It is always visible while Claude works. Games designed *for* this format — endless runners, side-scrollers, snake — are a natural fit. Exposing a stable SDK turns the plugin into a platform.

**SDK surface:**

```
// Game interface — implement these four methods
interface Game {
  init(canvas: GameCanvas): void          // called once; canvas.width/height are fixed
  update(dt: number): void                // dt = elapsed ms since last update
  render(): void                          // draw into canvas.buffer
  onKey?(event: KeyEvent): void           // optional input handler
}

// Canvas provided to the game by the runtime
interface GameCanvas {
  width: number                           // pixel columns
  height: number                          // pixel rows
  setPixel(x, y, r, g, b): void
}

// State events the game can subscribe to (hook feed)
type HookState = 'working' | 'idle' | 'afk' | 'attention'
interface StateEvent { state: HookState, since: number }
```

**Contract:**
- The runtime drives `update` + `render` at ~20 fps.
- `render()` writes into `canvas.buffer`; the runtime reads it and calls `renderHalfBlocks`.
- The hook state feed (`working` / `idle` / `afk` / `attention`) is delivered as `onKey`-style events so games can react to Claude's state — e.g. an endless runner that speeds up when Claude is busy.

**Local preview / dev tool:**
A small script (`scripts/preview.mjs`) that runs a game in a fresh terminal tab, simulating the statusline poll loop at the correct refresh rate. Developers build their game against the SDK, run `node scripts/preview.mjs --game mygame.mjs`, and see it live.

**Reference games to build first:**
- **Endless runner** — a side-scrolling obstacle runner; the ground rushes faster in `working` mode and slows in `afk` mode. Natural genre for a 200-wide × 20-tall canvas.
- **Snake** — classic; uses the full canvas; wraps at edges.

**Publishable path:**
Once the SDK stabilizes, it can be extracted into its own npm package (`afk-arcade-sdk`) with zero dependencies and published separately. Games become installable plugins.

**First steps:**
1. Define `lib/game-sdk.mjs` with `GameCanvas`, `GameRuntime`, and the `Game` interface.
2. Ship `games/runner.mjs` as the first reference game (endless runner).
3. Write `scripts/preview.mjs` — a `play.mjs`-style fullscreen previewer, but SDK-driven.
4. Document the frame.ans + viewport.json contract and hook state feed in a `SDK.md`.
5. Wire `daemon.mjs` to support SDK games as an alternative to DOOM.

---

## 3. Smaller items

### Chat-driven input gimmick
Add an `/afk key <keys>` command that writes key names to a command file (`/tmp/afk-arcade/doom/keys.cmd`). The daemon reads and flushes this file each tick, calling `engine.pushKey` for each key. This lets you fire from a Claude Code slash command without leaving the editor.

**First steps:** add `case 'key'` to `afk-ctl.mjs`; add a command-file reader to `daemon.mjs`'s tick loop.

### Publish plugin to a public GitHub marketplace repo
The plugin already has a `.claude-plugin/` manifest directory. Create a public GitHub repo (`afk-arcade-marketplace`) with the manifest, a release workflow, and instructions for `claude plugin marketplace add <url>`.

### Statusline test-config isolation
The existing test suite reads from the real `~/.claude/afk-arcade/config.json`, which means tests mutate user state. Inject a `CONFIG_PATH` override via environment variable so tests run against a tmp directory and never touch user config.

### More ambient games
- **Matrix rain** — classic green-on-black falling characters.
- **Lava lamp** — slow Perlin-noise blobs in warm colors.
Both work as SDK games with no external dependencies.

### Per-session game override
Allow each Claude Code session to override the active game independently via session state. Useful when multiple terminals are open and one should show fire while another shows DOOM.
