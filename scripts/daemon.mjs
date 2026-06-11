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
import net from 'node:net';
import path from 'node:path';
import { createDoom } from '../lib/doom-engine.mjs';
import { renderHalfBlocks } from '../lib/render.mjs';
import { readConfig, TMP_ROOT } from '../lib/state.mjs';
import { computeGameWidth, buildScaledBuffer, bufferGetPixel } from '../lib/scale.mjs';

// ── Paths ─────────────────────────────────────────────────────────────────────

const DOOM_TMP  = path.join(TMP_ROOT, 'doom');
const PIDFILE   = path.join(DOOM_TMP, 'daemon.pid');
const SOCKFILE  = path.join(DOOM_TMP, 'daemon.sock');
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

// Inode of the socket file this process bound — 0 until the singleton is won.
let ownedSockIno = 0;

/**
 * Remove the pidfile and socket — but only the ones THIS process owns, so a
 * yielding/usurped daemon never deletes the live owner's files on exit.
 */
function removePidfile() {
  try {
    const owner = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (owner === process.pid) fs.unlinkSync(PIDFILE);
  } catch { /* missing or not ours */ }
  try {
    if (ownedSockIno && fs.statSync(SOCKFILE).ino === ownedSockIno) {
      fs.unlinkSync(SOCKFILE);
    }
  } catch { /* missing or not ours */ }
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
 * Acquire the daemon singleton by binding a Unix domain socket. The kernel
 * makes bind() exclusive — no file read/write interleaving can ever let two
 * racers both win. If the address is in use, a connect() probe distinguishes
 * a live daemon (yield) from a stale socket file left by a crash or SIGKILL
 * (unlink and rebind once). The pidfile is written only AFTER winning the
 * bind, so it is informational and always names the single true owner.
 *
 * @returns {Promise<void>}  resolves once this process owns the singleton
 */
function acquireSingleton() {
  mkdirp(DOOM_TMP);
  return new Promise((resolve) => {
    const tryBind = (retried) => {
      const srv = net.createServer((conn) => conn.destroy());
      srv.on('error', (err) => {
        if (err.code !== 'EADDRINUSE' || retried) {
          process.exit(0);
        }
        const probeOnce = (attempt) => {
          const probe = net.connect(SOCKFILE);
          probe.setTimeout(1000);
          probe.on('connect', () => { probe.destroy(); process.exit(0); });
          probe.on('timeout', () => { probe.destroy(); process.exit(0); });
          probe.on('error', () => {
            probe.destroy();
            if (attempt === 0) {
              // A daemon that just bound may not be accepting yet — re-probe
              // after a beat instead of stealing a possibly-live socket.
              setTimeout(() => probeOnce(1), 300);
              return;
            }
            // Refused twice — genuinely stale. Clear it and rebind once.
            try { fs.unlinkSync(SOCKFILE); } catch { /* already gone */ }
            tryBind(true);
          });
        };
        probeOnce(0);
      });
      srv.listen(SOCKFILE, () => {
        srv.unref();
        try { ownedSockIno = fs.statSync(SOCKFILE).ino; } catch { ownedSockIno = 0; }
        fs.writeFileSync(PIDFILE, String(process.pid), 'utf8');
        resolve();
      });
    };
    tryBind(false);
  });
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
  await acquireSingleton();

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
        // Self-defense: if our socket file vanished or was replaced (inode
        // changed), another daemon usurped the singleton — yield quietly and
        // leave all files to the new owner.
        if (ownedSockIno) {
          let usurped = false;
          try { usurped = fs.statSync(SOCKFILE).ino !== ownedSockIno; } catch { usurped = true; }
          if (usurped) {
            clearInterval(tickTimer);
            process.exit(0);
          }
        }
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
