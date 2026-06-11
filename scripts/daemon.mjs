#!/usr/bin/env node
/**
 * daemon.mjs — DOOM WASM attract-mode daemon.
 *
 * Singleton process managed by a pidfile. Ticks the doomgeneric engine,
 * scales the framebuffer to the terminal viewport, and writes ANSI
 * half-block frames to /tmp/afk-arcade/doom/frame.ans.
 *
 * stdout/stderr are silent in normal operation (we run detached).
 * Fatal errors are written to /tmp/afk-arcade/doom/daemon.err.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDoom } from '../lib/doom-engine.mjs';
import { renderHalfBlocks } from '../lib/render.mjs';
import { readConfig } from '../lib/state.mjs';

// ── Paths ─────────────────────────────────────────────────────────────────────

const DOOM_TMP  = path.join(os.tmpdir(), 'afk-arcade', 'doom');
const PIDFILE   = path.join(DOOM_TMP, 'daemon.pid');
const ERRFILE   = path.join(DOOM_TMP, 'daemon.err');
const VIEWPORT  = path.join(DOOM_TMP, 'viewport.json');
const FRAME_ANS = path.join(DOOM_TMP, 'frame.ans');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFatal(msg) {
  try {
    mkdirp(DOOM_TMP);
    fs.writeFileSync(ERRFILE, msg + '\n', 'utf8');
  } catch { /* last resort */ }
}

function removePidfile() {
  try { fs.unlinkSync(PIDFILE); } catch { /* ignore */ }
}

/**
 * Atomically write data to dest (tmp + rename).
 * @param {string} dest
 * @param {string} data
 */
function writeAtomic(dest, data) {
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, dest);
}

// ── Singleton guard ───────────────────────────────────────────────────────────

/**
 * Check if pid refers to a live process.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkSingleton() {
  mkdirp(DOOM_TMP);

  try {
    const raw = fs.readFileSync(PIDFILE, 'utf8').trim();
    const existingPid = parseInt(raw, 10);
    if (!isNaN(existingPid) && existingPid !== process.pid && isProcessAlive(existingPid)) {
      // Another daemon is already running — exit cleanly
      process.exit(0);
    }
  } catch {
    // Pidfile missing or unreadable — proceed
  }

  // Write our own pidfile
  fs.writeFileSync(PIDFILE, String(process.pid), 'utf8');
}

// ── Viewport ──────────────────────────────────────────────────────────────────

/** Default viewport if viewport.json is missing or stale. */
const DEFAULT_VIEWPORT = { cols: 80, pxRows: 20, truecolor: true };

/**
 * Read viewport spec from VIEWPORT file.
 * Returns defaults if the file is missing, malformed, or older than 10 minutes.
 * @returns {{ cols: number, pxRows: number, truecolor: boolean, stale: boolean }}
 */
function readViewport() {
  try {
    const stat = fs.statSync(VIEWPORT);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 10 * 60 * 1000) {
      return { ...DEFAULT_VIEWPORT, stale: true };
    }
    const raw = fs.readFileSync(VIEWPORT, 'utf8');
    const obj = JSON.parse(raw);
    const cols    = typeof obj.cols     === 'number' ? Math.max(20, Math.min(220, obj.cols))     : DEFAULT_VIEWPORT.cols;
    const pxRows  = typeof obj.pxRows   === 'number' ? Math.max(4,  Math.min(48,  obj.pxRows))   : DEFAULT_VIEWPORT.pxRows;
    const truecolor = typeof obj.truecolor === 'boolean' ? obj.truecolor : DEFAULT_VIEWPORT.truecolor;
    return { cols, pxRows, truecolor, stale: false };
  } catch {
    return { ...DEFAULT_VIEWPORT, stale: false };
  }
}

// ── Box-filter scaler ─────────────────────────────────────────────────────────

/**
 * Compute game width from aspect ratio, pixel-row count, and available columns.
 *
 * Each "▀" half-block cell is approximately square because terminal cells are
 * ~2:1 tall and we pack 2 pixel rows per cell.  A 4:3 image therefore needs
 * gameW ≈ round(pxRows * 4/3).
 *
 * @param {'4:3'|'16:10'|'stretch'} aspect
 * @param {number} pxRows  Total pixel height used for the game.
 * @param {number} cols    Available terminal columns.
 * @returns {number}  Game width in terminal columns (always ≤ cols).
 */
function computeGameWidth(aspect, pxRows, cols) {
  if (aspect === 'stretch') return cols;
  const ratio = aspect === '16:10' ? 1.6 : 4 / 3;
  return Math.max(8, Math.min(cols, Math.round(pxRows * ratio)));
}

/**
 * Build a pre-scaled RGB buffer using a box filter (area average) from the
 * DOOM 320×200 framebuffer into a dstW×dstH pixel grid.
 *
 * For each destination pixel (x, y) the source rectangle
 *   [x*srcW/dstW .. (x+1)*srcW/dstW) × [y*srcH/dstH .. (y+1)*srcH/dstH)
 * is averaged.  Integer bounds are sufficient — at 36×30 target each pixel
 * covers ~80 source samples; the quantisation error is imperceptible.
 *
 * @param {(x: number, y: number) => [number, number, number]} srcGetPixel
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Uint8Array}  Flat RGB buffer, row-major, 3 bytes per pixel.
 */
function buildScaledBuffer(srcGetPixel, srcW, srcH, dstW, dstH) {
  const buf = new Uint8Array(dstW * dstH * 3);

  for (let dy = 0; dy < dstH; dy++) {
    // Source row range [y0, y1)
    const y0 = Math.floor(dy * srcH / dstH);
    const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * srcH / dstH));

    for (let dx = 0; dx < dstW; dx++) {
      // Source column range [x0, x1)
      const x0 = Math.floor(dx * srcW / dstW);
      const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * srcW / dstW));

      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const [r, g, b] = srcGetPixel(sx, sy);
          sumR += r; sumG += g; sumB += b;
          count++;
        }
      }

      const base = (dy * dstW + dx) * 3;
      buf[base]     = Math.round(sumR / count);
      buf[base + 1] = Math.round(sumG / count);
      buf[base + 2] = Math.round(sumB / count);
    }
  }

  return buf;
}

/**
 * Build a getPixel accessor over a flat RGB buffer with the given width.
 *
 * @param {Uint8Array} buf
 * @param {number} bufW
 * @returns {(x: number, y: number) => [number, number, number]}
 */
function bufferGetPixel(buf, bufW) {
  return (x, y) => {
    const base = (y * bufW + x) * 3;
    return [buf[base], buf[base + 1], buf[base + 2]];
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Singleton check — exit if another daemon is already running
  checkSingleton();

  // Clean up pidfile on graceful exit
  process.on('SIGTERM', () => {
    removePidfile();
    cleanupDoomTmp();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    removePidfile();
    process.exit(0);
  });
  process.on('exit', () => {
    removePidfile();
  });

  // Boot the engine
  let engine;
  try {
    engine = await createDoom();
  } catch (err) {
    writeFatal(`daemon init failed: ${err.message}`);
    removePidfile();
    process.exit(1);
  }

  // Tick interval (~30ms → ~33fps internal pacing)
  const TICK_INTERVAL_MS = 30;

  // Frame write interval (~1000ms)
  const FRAME_INTERVAL_MS = 1000;

  let lastFrameAt = 0;
  let tickCount = 0;

  const tickTimer = setInterval(() => {
    try {
      engine.tick();
      tickCount++;

      const now = Date.now();
      if (now - lastFrameAt >= FRAME_INTERVAL_MS) {
        lastFrameAt = now;
        writeFrame(engine);
      }
    } catch {
      // Engine error — stop ticking but keep process alive for pidfile cleanup
    }
  }, TICK_INTERVAL_MS);

  // Watchdog: if viewport.json is missing or older than 10 minutes, exit
  const watchdogTimer = setInterval(() => {
    try {
      const stat = fs.statSync(VIEWPORT);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 10 * 60 * 1000) {
        // Nobody is watching — exit gracefully
        clearInterval(tickTimer);
        clearInterval(watchdogTimer);
        engine.dispose();
        removePidfile();
        process.exit(0);
      }
    } catch {
      // viewport.json doesn't exist yet — tolerate for 10 minutes from daemon start
      // We track this via a startup timestamp
    }
  }, 30_000); // check every 30s

  // Startup grace: if viewport never appears within 10 minutes, bail
  const startedAt = Date.now();
  const graceTimer = setInterval(() => {
    const viewportExists = (() => {
      try { fs.statSync(VIEWPORT); return true; } catch { return false; }
    })();
    if (!viewportExists && Date.now() - startedAt > 10 * 60 * 1000) {
      clearInterval(tickTimer);
      clearInterval(watchdogTimer);
      clearInterval(graceTimer);
      engine.dispose();
      removePidfile();
      process.exit(0);
    }
  }, 60_000);
}

/**
 * Write one aspect-correct, box-filtered ANSI frame to FRAME_ANS.
 *
 * Layout:
 *   - gameW columns of DOOM content, horizontally centered within `cols`
 *   - leftPad plain spaces on the left (no background color — terminal default shows through)
 *   - no trailing spaces needed; the reset at end of each game line suffices
 *
 * @param {{ getPixel: Function, width: number, height: number }} engine
 */
function writeFrame(engine) {
  try {
    const vp     = readViewport();
    const cfg    = readConfig();
    const cols   = vp.cols;
    const pxRows = vp.pxRows % 2 === 0 ? vp.pxRows : vp.pxRows + 1; // must be even

    const aspect  = cfg.aspect ?? '4:3';
    const gameW   = computeGameWidth(aspect, pxRows, cols);
    const leftPad = Math.floor((cols - gameW) / 2);
    const pad     = leftPad > 0 ? ' '.repeat(leftPad) : '';

    // Build the scaled RGB buffer using box-filter averaging
    const scaledBuf     = buildScaledBuffer(engine.getPixel, engine.width, engine.height, gameW, pxRows);
    const scaledGetPixel = bufferGetPixel(scaledBuf, gameW);

    // Render game content as half-block lines
    const gameLines = renderHalfBlocks(scaledGetPixel, gameW, pxRows, { truecolor: vp.truecolor });

    // Prepend pillarbox padding (plain spaces, no color codes — gutters inherit terminal bg)
    const RESET = '\x1b[0m';
    const lines = gameLines.map(line => `${RESET}${pad}${line}`);

    writeAtomic(FRAME_ANS, lines.join('\n'));
  } catch {
    // Non-fatal — next tick will retry
  }
}

/**
 * Remove the doom tmp files on graceful SIGTERM exit.
 */
function cleanupDoomTmp() {
  for (const f of [FRAME_ANS, VIEWPORT]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  writeFatal(`daemon fatal: ${err.message}`);
  removePidfile();
  process.exit(1);
});
