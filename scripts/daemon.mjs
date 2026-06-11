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
import { renderHalfBlocks, renderQuadrants } from '../lib/render.mjs';
import { readConfig, TMP_ROOT } from '../lib/state.mjs';
import { computeGameWidth, buildScaledBuffer, bufferGetPixel } from '../lib/scale.mjs';
import { sharpen, toneLift } from '../lib/postfx.mjs';
import { encodePngFast } from '../lib/png.mjs';
import { debugEnabled, dbgLog } from '../lib/debug.mjs';

// ── Paths ─────────────────────────────────────────────────────────────────────

const DOOM_TMP  = path.join(TMP_ROOT, 'doom');
const PIDFILE   = path.join(DOOM_TMP, 'daemon.pid');
const SOCKFILE  = path.join(DOOM_TMP, 'daemon.sock');
const ERRFILE   = path.join(DOOM_TMP, 'daemon.err');
const VIEWPORT  = path.join(DOOM_TMP, 'viewport.json');
const FRAME_ANS = path.join(DOOM_TMP, 'frame.ans');
// Written only when style === 'pixel'; the statusline reads this for U=1 placement.
const FRAME_PNG = path.join(DOOM_TMP, 'frame.png');

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
    const cols    = typeof obj.cols     === 'number' ? Math.max(20, Math.min(280, obj.cols))     : DEFAULT_VIEWPORT.cols;
    const pxRows  = typeof obj.pxRows   === 'number' ? Math.max(4,  Math.min(80,  obj.pxRows))   : DEFAULT_VIEWPORT.pxRows;
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
  // 4 frames/s: the statusline polls ~1/s out of phase with our writes, so a
  // 1s write interval served frames up to ~2s stale. Writing at 250ms keeps
  // every poll fresh (≤250ms old) for a consistent perceived cadence.
  const FRAME_INTERVAL_MS = 250;

  let lastFrameAt = 0;
  let tickCount = 0;
  let frameCount = 0;

  // Self-recycle watchdog. A long-running engine was observed to wedge into a
  // static washed-out frame (attract loop stuck) — the banner then looks
  // frozen, and low-contrast terminals (Warp's minimum-contrast pass) render
  // it as a white glyph maze. Rather than heal the engine in place, exit
  // cleanly: the statusline auto-respawns a fresh daemon within a second
  // (spawn-lock guarded). A hard lifetime cap adds belt-and-suspenders.
  const bootedAt = Date.now();
  const LIFETIME_MS = 30 * 60 * 1000;
  const STALE_OUTPUT_MS = 90 * 1000;
  let prevSignature = 0;
  let lastSignatureChangeAt = Date.now();

  // Read config once for debug gating (re-read inside writeFrame for style)
  const _initCfg = readConfig();

  const tickTimer = setInterval(() => {
    try {
      engine.tick();
      tickCount++;

      const now = Date.now();
      if (now - lastFrameAt >= FRAME_INTERVAL_MS) {
        lastFrameAt = now;
        frameCount++;
        // For unknown builds the boot-time dimension probe can land on a
        // degenerate frame (screen-melt wipe). Re-validate on a couple of
        // early frames; known builds skip this entirely.
        if (!engine.dimensionsKnown && (frameCount === 3 || frameCount === 6)) {
          try { engine.redetectDimensions(); } catch { /* keep current dims */ }
        }
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
        writeFrame(engine, frameCount);

        // Staleness + lifetime recycle checks (see watchdog comment above).
        if (lastFrameSignature !== prevSignature) {
          prevSignature = lastFrameSignature;
          lastSignatureChangeAt = now;
        } else if (now - lastSignatureChangeAt > STALE_OUTPUT_MS) {
          try { dbgLog('daemon', { recycle: 'stale-output', frame: frameCount }); } catch { /* ignore */ }
          clearInterval(tickTimer);
          process.exit(0);
        }
        if (now - bootedAt > LIFETIME_MS) {
          try { dbgLog('daemon', { recycle: 'lifetime-cap', frame: frameCount }); } catch { /* ignore */ }
          clearInterval(tickTimer);
          process.exit(0);
        }
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
 * @param {number} frameCount  Current frame counter (for diagnostic sampling).
 */
function writeFrame(engine, frameCount) {
  try {
    const vp     = readViewport();
    const cfg    = readConfig();
    const cols   = vp.cols;
    const pxRows = vp.pxRows % 2 === 0 ? vp.pxRows : vp.pxRows + 1; // must be even

    const aspect  = cfg.aspect ?? '4:3';
    const style   = cfg.style  ?? 'quad';
    const gameW   = computeGameWidth(aspect, pxRows, cols);
    const leftPad = Math.floor((cols - gameW) / 2);
    const pad     = leftPad > 0 ? ' '.repeat(leftPad) : '';

    // Diagnostic sampling: frames 1, 2, 3, then every 20th
    const shouldLog = debugEnabled(cfg) &&
      (frameCount <= 3 || frameCount % 20 === 0);

    let tScaleMs = null;
    let tRenderMs = null;
    let tPngMs = null;
    let ansBytes = null;
    let pngBytes = null;

    // ── Pixel style: write frame.png (half-res 2×2 box downscale) ────────────
    // Also always write frame.ans (quad) as the universal fallback.
    if (style === 'pixel') {
      // Half-resolution: 640×400 is sharp enough and 4× cheaper than 1280×800.
      // Clamp to at most the game content dimensions.
      const halfW = Math.min(640, gameW * 4);
      const halfH = Math.min(400, pxRows * 4);
      try {
        const tPng0 = Date.now();
        const rgb = buildScaledBuffer(engine.getPixel, engine.width, engine.height, halfW, halfH);
        // No sharpen/toneLift for the PNG path — the terminal renders raw pixels.
        const pngBuf = encodePngFast(rgb, halfW, halfH);
        tPngMs = Date.now() - tPng0;
        pngBytes = pngBuf.length;
        const tmp = FRAME_PNG + '.tmp';
        fs.writeFileSync(tmp, pngBuf);
        fs.renameSync(tmp, FRAME_PNG);
      } catch {
        // Non-fatal — statusline will fall back to quad frame.ans
      }
    }

    // ── ANSI frame (quad or half-block) — always written as fallback ─────────
    let gameLines;
    if (style === 'quad' || style === 'pixel') {
      // Quad path: sample at double horizontal resolution so each cell covers 2×2 px
      const dstW = gameW * 2;
      const dstH = pxRows;
      const t0Scale = Date.now();
      const scaledBuf = buildScaledBuffer(engine.getPixel, engine.width, engine.height, dstW, dstH);
      sharpen(scaledBuf, dstW, dstH);
      toneLift(scaledBuf);
      tScaleMs = Date.now() - t0Scale;
      const scaledGetPixel = bufferGetPixel(scaledBuf, dstW);
      // renderQuadrants expects pxW = dstW (cells = dstW/2 = gameW), pxH = dstH
      const t0Render = Date.now();
      gameLines = renderQuadrants(scaledGetPixel, dstW, dstH, { truecolor: vp.truecolor });
      tRenderMs = Date.now() - t0Render;
    } else {
      // Half-block path: classic gameW × pxRows sampling, with post-fx for free
      const t0Scale = Date.now();
      const scaledBuf = buildScaledBuffer(engine.getPixel, engine.width, engine.height, gameW, pxRows);
      sharpen(scaledBuf, gameW, pxRows);
      toneLift(scaledBuf);
      tScaleMs = Date.now() - t0Scale;
      const scaledGetPixel = bufferGetPixel(scaledBuf, gameW);
      const t0Render = Date.now();
      gameLines = renderHalfBlocks(scaledGetPixel, gameW, pxRows, { truecolor: vp.truecolor });
      tRenderMs = Date.now() - t0Render;
    }

    // Prepend pillarbox padding (plain spaces, no color codes — gutters inherit terminal bg)
    const RESET = '\x1b[0m';
    const lines = gameLines.map(line => `${RESET}${pad}${line}`);
    const ansContent = lines.join('\n');
    ansBytes = Buffer.byteLength(ansContent, 'utf8');

    // Cheap content signature for the staleness watchdog: strided char sum.
    let sig = ansBytes;
    for (let i = 0; i < ansContent.length; i += 101) {
      sig = (sig * 31 + ansContent.charCodeAt(i)) >>> 0;
    }
    lastFrameSignature = sig;

    writeAtomic(FRAME_ANS, ansContent);

    // Emit diagnostic log for sampled frames
    if (shouldLog) {
      const logEntry = {
        frame:      frameCount,
        style,
        engineDims: [engine.width, engine.height],
        viewport:   { cols, pxRows },
        gameW,
        tScaleMs,
        tRenderMs,
        ansBytes,
      };
      if (style === 'pixel') {
        logEntry.tPngMs  = tPngMs;
        logEntry.pngBytes = pngBytes;
      }
      dbgLog('daemon', logEntry);
    }
  } catch {
    // Non-fatal — next tick will retry
  }
}

// Updated by writeFrame; consumed by the staleness watchdog in main().
let lastFrameSignature = 0;

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
