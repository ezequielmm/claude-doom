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
import { computeGameWidth, buildScaledBuffer, bufferGetPixel } from '../lib/scale.mjs';

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

  // Claim the pidfile with an exclusive create BEFORE any heavy init. If the
  // create fails, wait for any concurrent writer to finish before reading —
  // reading mid-write yields an empty file, which must not be mistaken for a
  // stale pidfile (that mistake lets two racers both "win").
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(PIDFILE, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      sleepMs(120);
      let existingPid = NaN;
      try {
        existingPid = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
      } catch { /* unreadable */ }
      if (!isNaN(existingPid) && existingPid !== process.pid && isProcessAlive(existingPid)) {
        process.exit(0);
      }
      removePidfile();
    }
  }

  // Settle, then verify undisputed ownership: the pidfile holds exactly one
  // pid, so exactly one racer survives this check no matter the interleaving.
  // If we lost (or the file vanished), exit — the statusline respawns within
  // a second and the next claim is uncontested.
  sleepMs(150);
  let owner = NaN;
  try {
    owner = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
  } catch { /* missing — treat as lost */ }
  if (owner !== process.pid) {
    process.exit(0);
  }
}

/**
 * Synchronous sleep without a child process — Atomics.wait on a throwaway
 * buffer. Fine here: the daemon has not started its tick loop yet.
 * @param {number} ms
 */
function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
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
    const pxRows  = typeof obj.pxRows   === 'number' ? Math.max(4,  Math.min(60,  obj.pxRows))   : DEFAULT_VIEWPORT.pxRows;
    const truecolor = typeof obj.truecolor === 'boolean' ? obj.truecolor : DEFAULT_VIEWPORT.truecolor;
    return { cols, pxRows, truecolor, stale: false };
  } catch {
    return { ...DEFAULT_VIEWPORT, stale: false };
  }
}

// Note: computeGameWidth, buildScaledBuffer, bufferGetPixel are now imported
// from lib/scale.mjs — shared with scripts/play.mjs.

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
