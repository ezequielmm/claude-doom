#!/usr/bin/env node
/**
 * play.mjs — fullscreen standalone DOOM player.
 *
 * Run with:  node scripts/play.mjs
 * Self-test: node scripts/play.mjs --selftest
 *
 * Controls:
 *   WASD / Arrow keys  — move / turn
 *   SPACE              — use (open doors)
 *   F or X             — fire
 *   1–7                — switch weapon
 *   ESC                — menu
 *   ENTER / TAB        — menu navigation
 *   Q or Ctrl+C        — quit
 *
 * Terminal requirements:
 *   - stdin and stdout must be a TTY (unless --selftest).
 *   - Truecolor detected from COLORTERM env var (falls back to 256-color).
 *
 * DOOM key codes (doomgeneric doomkeys.h):
 *   KEY_LEFTARROW  0xac   KEY_UPARROW   0xad
 *   KEY_RIGHTARROW 0xae   KEY_DOWNARROW 0xaf
 *   KEY_USE  0xa2         KEY_FIRE 0xa3
 *   KEY_ESCAPE 27         KEY_ENTER 13    KEY_TAB 9
 *   Weapons: ASCII '1'..'7' (49..55)
 *
 * Verified: Module["_DG_PushKeyEvent"] is exported by vendor/doom/doom.js
 * (opentui-doom 0.3.11 — confirmed via grep of doom.js wasmExports assignment).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SELF_TEST = process.argv.includes('--selftest');

// ── TTY guard ─────────────────────────────────────────────────────────────────

if (!SELF_TEST) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('error: play.mjs requires a TTY (run in a terminal, not piped)\n');
    process.exit(1);
  }
}

// ── Imports ───────────────────────────────────────────────────────────────────

import { createDoom, vendorAssetsExist } from '../lib/doom-engine.mjs';
import { renderHalfBlocks } from '../lib/render.mjs';
import { computeGameWidth, buildScaledBuffer, bufferGetPixel } from '../lib/scale.mjs';
import { decodeKeys, HeldKeyTracker } from '../lib/keys.mjs';

// ── DOOM key codes ────────────────────────────────────────────────────────────

const KEY_LEFTARROW  = 0xac;
const KEY_UPARROW    = 0xad;
const KEY_RIGHTARROW = 0xae;
const KEY_DOWNARROW  = 0xaf;
const KEY_USE        = 0xa2;
const KEY_FIRE       = 0xa3;
const KEY_ESCAPE     = 27;
const KEY_ENTER      = 13;
const KEY_TAB        = 9;

/** Map from normalized key name → DOOM key code */
const KEY_MAP = {
  up:    KEY_UPARROW,
  down:  KEY_DOWNARROW,
  left:  KEY_LEFTARROW,
  right: KEY_RIGHTARROW,
  w:     KEY_UPARROW,
  s:     KEY_DOWNARROW,
  a:     KEY_LEFTARROW,
  d:     KEY_RIGHTARROW,
  ' ':   KEY_USE,
  f:     KEY_FIRE,
  x:     KEY_FIRE,
  '\x1b': KEY_ESCAPE,
  '\r':   KEY_ENTER,
  '\n':   KEY_ENTER,
  '\t':   KEY_TAB,
};

// Weapon keys: '1'..'7' → their ASCII codes
for (let i = 1; i <= 7; i++) {
  KEY_MAP[String(i)] = 48 + i; // '1'=49 .. '7'=55
}

/** Keys that should be treated as taps (down + immediate up) rather than held */
const TAP_KEYS = new Set(['\x1b', '\r', '\n', '\t', '1', '2', '3', '4', '5', '6', '7']);

// ── Color detection ───────────────────────────────────────────────────────────

const truecolor = (process.env.COLORTERM ?? '').toLowerCase().includes('truecolor') ||
                  (process.env.COLORTERM ?? '').toLowerCase().includes('24bit');

// ── Cleanup guard ─────────────────────────────────────────────────────────────

let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;

  // Restore terminal state
  if (!SELF_TEST) {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    // Show cursor + leave alternate screen
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (err) => {
  cleanup();
  process.stderr.write(`uncaught: ${err.message}\n`);
  process.exit(1);
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!vendorAssetsExist()) {
    process.stderr.write(
      'error: DOOM vendor assets missing.\n' +
      'Run: node scripts/fetch-doom.mjs\n',
    );
    process.exit(1);
  }

  // Boot the engine
  const engine = await createDoom();

  // ── Self-test path ──────────────────────────────────────────────────────────
  if (SELF_TEST) {
    // Tick 60 times then render one frame to stdout
    for (let i = 0; i < 60; i++) engine.tick();

    const cols   = 80;
    const pxRows = 20;
    const gameW  = computeGameWidth('4:3', pxRows, cols);
    const scaledBuf = buildScaledBuffer(engine.getPixel, engine.width, engine.height, gameW, pxRows);
    const gp        = bufferGetPixel(scaledBuf, gameW);
    const lines     = renderHalfBlocks(gp, gameW, pxRows, { truecolor: false });

    const frameStr = lines.join('\n');

    // Assertions
    if (!frameStr.includes('▀')) {
      process.stderr.write('selftest fail: frame does not contain ▀\n');
      engine.dispose();
      process.exit(1);
    }
    if (!frameStr.includes('\x1b[')) {
      process.stderr.write('selftest fail: frame does not contain ANSI escape codes\n');
      engine.dispose();
      process.exit(1);
    }

    process.stdout.write(frameStr + '\n');
    process.stdout.write('selftest ok\n');
    engine.dispose();
    process.exit(0);
  }

  // ── Interactive path ────────────────────────────────────────────────────────

  // Enter alternate screen, hide cursor, enable raw mode
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Geometry (computed fresh on each resize)
  let termCols = process.stdout.columns  || 80;
  let termRows = process.stdout.rows     || 24;

  function computeGeometry() {
    termCols = process.stdout.columns  || 80;
    termRows = process.stdout.rows     || 24;
  }

  process.stdout.on('resize', () => {
    computeGeometry();
    // Clear screen so next render fills the new size cleanly
    process.stdout.write('\x1b[2J');
  });

  // Help/status line (last text row)
  const HELP = 'WASD/arrows move \xB7 SPACE use \xB7 F fire \xB7 1-7 weapons \xB7 ESC menu \xB7 Q quit';

  // ── Input wiring ──────────────────────────────────────────────────────────

  const tracker = new HeldKeyTracker(
    (key) => {
      const code = KEY_MAP[key];
      if (code !== undefined) engine.pushKey(1, code);
    },
    (key) => {
      const code = KEY_MAP[key];
      if (code !== undefined) engine.pushKey(0, code);
    },
  );

  process.stdin.on('data', (buf) => {
    const keys = decodeKeys(buf);
    for (const key of keys) {
      // Quit keys — handled before forwarding
      if (key === 'q' || key === '\x03') {
        tracker.releaseAll();
        engine.dispose();
        cleanup();
        process.exit(0);
      }
      if (TAP_KEYS.has(key)) {
        tracker.tap(key);
      } else {
        tracker.see(key);
      }
    }
  });

  // ── Game loop ────────────────────────────────────────────────────────────

  const TICK_MS   = 28;  // ~35 Hz engine tick
  const RENDER_MS = 50;  // ~20 fps render

  // Engine tick
  const tickTimer = setInterval(() => {
    engine.tick();
  }, TICK_MS);

  // Render + sweep (20fps)
  const renderTimer = setInterval(() => {
    tracker.sweep();
    renderFrame(engine);
  }, RENDER_MS);

  function renderFrame(eng) {
    const cols   = termCols;
    const rows   = termRows;
    // Reserve last row for help text; pixel rows = (rows-1)*2 (must stay even)
    const pxRows = Math.max(2, (rows - 1)) * 2;

    const gameW  = computeGameWidth('4:3', pxRows, cols);
    const leftPad = Math.max(0, Math.floor((cols - gameW) / 2));
    const pad     = leftPad > 0 ? ' '.repeat(leftPad) : '';
    const RESET   = '\x1b[0m';

    // Build scaled buffer
    const scaledBuf = buildScaledBuffer(eng.getPixel, eng.width, eng.height, gameW, pxRows);
    const gp        = bufferGetPixel(scaledBuf, gameW);

    // Render game lines
    const gameLines = renderHalfBlocks(gp, gameW, pxRows, { truecolor });

    // Build full frame string: cursor home + all game rows + help row
    let frame = '\x1b[H';
    for (const line of gameLines) {
      frame += `${RESET}${pad}${line}\r\n`;
    }

    // Help line — truncated to terminal width
    const helpTrunc = HELP.slice(0, cols - 1);
    frame += `${RESET}${helpTrunc}`;

    // Synchronized output (BSP § 2026) to reduce tearing
    process.stdout.write(`\x1b[?2026h${frame}\x1b[?2026l`);
  }

  // Handle clean exit when stdin closes (e.g. EOF)
  process.stdin.on('end', () => {
    clearInterval(tickTimer);
    clearInterval(renderTimer);
    tracker.releaseAll();
    engine.dispose();
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  cleanup();
  process.stderr.write(`play.mjs fatal: ${err.message}\n`);
  process.exit(1);
});
