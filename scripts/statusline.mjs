#!/usr/bin/env node
/**
 * statusline.mjs — animated arcade banner renderer for Claude Code's statusline.
 *
 * Claude Code pipes a JSON payload to stdin, reads stdout, and renders it
 * below the input box. Multi-line output = multiple rows. ANSI colours are
 * supported. Target: <50ms, ~1fps animation via refreshInterval.
 *
 * On ANY error: print "afk-arcade ⚠" and exit 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, resolveSessionState, TMP_ROOT } from '../lib/state.mjs';
import { createFire, stepFire, heatToRgb, saveFire, loadFire } from '../lib/fire.mjs';
import { renderHalfBlocks, renderQuadrants } from '../lib/render.mjs';
import { kittyVirtualImage, kittyPlaceholderLines } from '../lib/gfx-protocol.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

const FIRE_SESSION_DIR = path.join(TMP_ROOT, 'sessions');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp a number to [lo, hi]. */
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * Read all of stdin, race against a timeout so we never hang.
 * @returns {Promise<string>}
 */
function readStdinWithTimeout(timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let resolved = false;

    const finish = (str) => {
      if (resolved) return;
      resolved = true;
      resolve(str);
    };

    const timer = setTimeout(() => {
      finish(Buffer.concat(chunks).toString('utf8'));
    }, timeoutMs);

    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

/** Detect truecolor support from environment. */
function detectTruecolor() {
  return /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
}

/** ANSI SGR codes for HUD styling. */
const SGR = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  blink:  '\x1b[5m',
  fgRed:  '\x1b[38;5;196m',
  fgOrng: '\x1b[38;5;208m',
  fgYlw:  '\x1b[38;5;220m',
  fgGrn:  '\x1b[38;5;70m',
  fgCyan: '\x1b[38;5;51m',
  fgDimG: '\x1b[38;5;65m',
  fgGray: '\x1b[38;5;244m',
};

// ── HUD line ──────────────────────────────────────────────────────────────────

/**
 * Build the single HUD status line.
 *
 * @param {object} params
 * @param {{ mode: string, attention: boolean }} params.state
 * @param {object|undefined} params.modelObj
 * @param {object|undefined} params.ctxObj
 * @param {number} params.width
 * @param {string|undefined} params.extraSuffix
 * @returns {string}  ANSI-styled string, truncated to `width` visible chars.
 */
function buildHudLine({ state, modelObj, ctxObj, width, extraSuffix }) {
  const modelName = modelObj?.display_name ?? modelObj?.id ?? 'claude';
  const usedPct = ctxObj?.used_percentage;

  const now = Date.now();
  const evenSecond = Math.floor(now / 1000) % 2 === 0;

  let statusPart;
  let statusColor;

  if (state.attention) {
    // Alternating bold on even seconds (blink-style without actual blink)
    const prefix = evenSecond ? `${SGR.bold}${SGR.fgYlw}` : `${SGR.fgYlw}`;
    statusPart = `${prefix}⚠ claude needs your input${SGR.reset}`;
    statusColor = '';
  } else {
    switch (state.mode) {
      case 'working':
        statusColor = SGR.fgOrng;
        statusPart = `${statusColor}claude is working — go grab a coffee${SGR.reset}`;
        break;
      case 'afk':
        statusColor = SGR.fgCyan;
        statusPart = `${statusColor}AFK · demo mode${SGR.reset}`;
        break;
      case 'idle':
      default:
        statusColor = SGR.fgDimG;
        statusPart = `${statusColor}done — waiting for you${SGR.reset}`;
        break;
    }
  }

  // Assemble visible segments (for length estimation)
  let visibleParts = ` ▶ afk-arcade · ${stripAnsi(statusPart)} · ${modelName}`;
  if (usedPct !== undefined && usedPct !== null) {
    visibleParts += ` · ctx ${usedPct}%`;
  }
  if (extraSuffix) {
    visibleParts += ` · ${extraSuffix}`;
  }

  // Build the styled version
  let styled = `${SGR.dim} ▶ afk-arcade${SGR.reset} · ${statusPart} · ${SGR.fgGray}${modelName}${SGR.reset}`;
  if (usedPct !== undefined && usedPct !== null) {
    styled += ` · ${SGR.fgGray}ctx ${usedPct}%${SGR.reset}`;
  }
  if (extraSuffix) {
    styled += ` · ${SGR.dim}${extraSuffix}${SGR.reset}`;
  }

  // Truncate to width (visible chars only — crude but safe)
  const visible = stripAnsi(styled);
  if (visible.length > width) {
    // Rebuild truncated plain version
    const truncated = visibleParts.slice(0, width - 1) + '…';
    return truncated;
  }

  return styled;
}

/** Strip ANSI escape codes for length measurement. */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Fire persistence ──────────────────────────────────────────────────────────

/**
 * Load (or create) fire state, step it proportionally to elapsed time,
 * and save it back.
 *
 * @param {string} fireFile  Path to the .fire binary file.
 * @param {number} w  Pixel width.
 * @param {number} h  Pixel height.
 * @param {number} intensity  0..1
 * @returns {import('../lib/fire.mjs').FireState}
 */
function loadStepSaveFire(fireFile, w, h, intensity) {
  let fire = null;
  let lastMtime = 0;

  try {
    const stat = fs.statSync(fireFile);
    lastMtime = stat.mtimeMs;
    fire = loadFire(fireFile, w, h);
  } catch {
    // File doesn't exist yet — fire will be null
  }

  if (!fire) {
    fire = createFire(w, h);
    lastMtime = 0; // force several steps to warm up
  }

  const elapsed = Date.now() - lastMtime;
  // ~120ms per step (≈8fps effective at 1fps terminal refresh)
  const steps = clamp(Math.round(elapsed / 120), 1, 8);

  for (let i = 0; i < steps; i++) {
    stepFire(fire, intensity);
  }

  saveFire(fire, fireFile);
  return fire;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Read stdin (race with 150ms timeout)
  const raw = await readStdinWithTimeout(150);

  // 2. Parse defensively
  let json = {};
  try {
    if (raw.trim()) json = JSON.parse(raw);
  } catch {
    // proceed with empty object — fire with fallback session
  }

  // 3. Load config
  const config = readConfig();
  if (config.enabled === false) {
    // Print nothing
    process.exit(0);
  }

  // 4. Terminal dimensions
  const cols = parseInt(process.env.COLUMNS, 10) || 80;
  const width = clamp(cols, 20, 280);
  const rows = clamp(config.rows, 2, 40);
  const pixH = rows * 2; // pixel height (2px per terminal row)

  // 5. Session state → fire intensity
  const sessionId = json.session_id;
  const state = resolveSessionState(sessionId);

  const intensityMap = { working: 1.0, afk: 0.85, idle: 0.25 };
  const intensity = intensityMap[state.mode] ?? 0.25;

  // 6. Fire persistence
  const style = config.style ?? 'quad';
  // Quad and pixel modes run the fire simulation at double width (each cell covers 2 columns).
  // Pixel mode falls back to quad-style fire when DOOM is not running.
  const fireW = (style === 'quad' || style === 'pixel') ? width * 2 : width;

  const fireFileId = sessionId ?? 'global';
  const fireFile = path.join(FIRE_SESSION_DIR, `${fireFileId}.fire`);
  const fire = loadStepSaveFire(fireFile, fireW, pixH, intensity);

  // 7. Phase B contract: DOOM daemon frame handling
  let extraSuffix;
  if (config.game === 'doom') {
    const doomDir  = path.join(TMP_ROOT, 'doom');
    const doomFrame  = path.join(doomDir, 'frame.ans');
    const viewportFile = path.join(doomDir, 'viewport.json');
    const pidFile    = path.join(doomDir, 'daemon.pid');

    // Always write the current viewport spec so the daemon knows our dimensions.
    // Atomic write is fine (it's not critical path for correctness).
    try {
      const truecolor = detectTruecolor();
      const viewportObj = { cols: width, pxRows: rows * 2, truecolor };
      const vTmp = viewportFile + '.tmp';
      fs.mkdirSync(doomDir, { recursive: true });
      fs.writeFileSync(vTmp, JSON.stringify(viewportObj), 'utf8');
      fs.renameSync(vTmp, viewportFile);
    } catch { /* non-fatal */ }

    // Check for a fresh daemon frame (< 5s old)
    let frameAge = Infinity;
    try {
      frameAge = Date.now() - fs.statSync(doomFrame).mtimeMs;
    } catch { /* frame absent */ }

    if (frameAge < 5000) {
      // Daemon is alive and fresh — use its frame.
      // For pixel style, attempt out-of-band PNG transmission + placeholder text.
      const doomFramePng = path.join(doomDir, 'frame.png');

      if (style === 'pixel' && !process.env.AFK_ARCADE_NO_PIXEL) {
        // Pixel path: transmit PNG directly to /dev/tty, emit placeholder lines to stdout.
        //
        // Preconditions (all must hold — otherwise fall through to quad frame.ans):
        //   1. frame.png exists and is fresh (< 5s old)
        //   2. /dev/tty is writable
        //
        // The pixel-tx.json bookkeeping file (TMP_ROOT/pixel-tx.json) tracks the
        // last transmitted mtime so we only re-transmit when the PNG has changed.
        // This limits /dev/tty writes to ≤4/s (daemon frame rate) while keeping
        // placeholder-text regeneration cheap on every statusline poll (~1/s).
        //
        // Escape hatch: AFK_ARCADE_NO_PIXEL=1 hard-disables; `/afk style quad` reverts.
        let pixelOk = false;
        try {
          const pngStat = fs.statSync(doomFramePng);
          if (Date.now() - pngStat.mtimeMs < 5000) {
            // Try opening /dev/tty for writing (may fail in piped/CI contexts).
            let ttyFd = -1;
            try { ttyFd = fs.openSync('/dev/tty', 'w'); } catch { /* tty unavailable */ }

            if (ttyFd >= 0) {
              try {
                // Compute game dimensions (same math as daemon.mjs / quad path).
                const { computeGameWidth: cgw } = await import('../lib/scale.mjs');
                const pixelAspect = config.aspect ?? '4:3';
                const gameW       = cgw(pixelAspect, rows * 2, width);
                const leftPad     = Math.floor((width - gameW) / 2);

                // Re-transmit only when the PNG file has changed since last time.
                const txJsonPath = path.join(TMP_ROOT, 'pixel-tx.json');
                const txState    = (() => { try { return JSON.parse(fs.readFileSync(txJsonPath, 'utf8')); } catch { return {}; } })();

                if (pngStat.mtimeMs !== (txState.lastMtime ?? 0)) {
                  const pngBuf = fs.readFileSync(doomFramePng);
                  const txStr  = kittyVirtualImage(pngBuf, { imageId: 42, cols: gameW, rows });
                  fs.writeSync(ttyFd, txStr);

                  // Persist bookkeeping (non-fatal if write fails).
                  try {
                    const txTmp = txJsonPath + '.tmp';
                    fs.writeFileSync(txTmp, JSON.stringify({
                      lastMtime: pngStat.mtimeMs,
                      attempts: (txState.attempts ?? 0) + 1,
                      since:    txState.since ?? Date.now(),
                    }), 'utf8');
                    fs.renameSync(txTmp, txJsonPath);
                  } catch { /* non-fatal */ }
                }

                fs.closeSync(ttyFd);

                // Emit placeholder text to stdout (flows through Claude Code renderer).
                const hudLine = buildHudLine({
                  state, modelObj: json.model, ctxObj: json.context_window,
                  width, extraSuffix: 'pixel',
                });
                const phLines = kittyPlaceholderLines({ imageId: 42, cols: gameW, rows, leftPad });
                process.stdout.write(hudLine + '\n' + phLines.join('\n') + '\n');
                pixelOk = true;
              } catch {
                try { fs.closeSync(ttyFd); } catch { /* ignore */ }
              }
            }
          }
        } catch { /* stat failed or other error — fall through to quad frame.ans */ }

        if (pixelOk) process.exit(0);
        // Fall through to quad frame.ans below.
      }

      // Quad / half / pixel-fallback path: use frame.ans text content.
      try {
        const hudLine = buildHudLine({
          state,
          modelObj: json.model,
          ctxObj: json.context_window,
          width,
          extraSuffix: undefined,
        });
        const frameContent = fs.readFileSync(doomFrame, 'utf8');
        process.stdout.write(hudLine + '\n' + frameContent + '\n');
        process.exit(0);
      } catch { /* fall through to fire */ }
    }

    // Frame is stale or absent — maybe daemon is dead; try to spawn it.
    // Guard with a spawn-lock directory so concurrent statusline runs never
    // double-spawn.
    const lockDir = path.join(doomDir, 'spawn.lock');
    let daemonIsAlive = false;
    try {
      const pidRaw = fs.readFileSync(pidFile, 'utf8').trim();
      const pid = parseInt(pidRaw, 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, 0); daemonIsAlive = true; } catch { /* stale pid */ }
      }
    } catch { /* pidfile absent */ }

    if (!daemonIsAlive) {
      // Attempt spawn lock (mkdir is atomic on POSIX)
      let gotLock = false;
      try {
        // Check if lock is stale (> 30s)
        try {
          const lockStat = fs.statSync(lockDir);
          if (Date.now() - lockStat.mtimeMs > 30_000) {
            fs.rmdirSync(lockDir);
          }
        } catch { /* lock doesn't exist */ }

        fs.mkdirSync(lockDir);
        gotLock = true;
      } catch { /* lock held by another concurrent run */ }

      if (gotLock) {
        try {
          const daemonScript = path.join(__dirname, 'daemon.mjs');
          const child = spawn(process.execPath, ['--no-warnings', daemonScript], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
        } catch { /* spawn failed — non-fatal */ }

        // Keep the lock — the daemon needs a moment to claim its pidfile, and
        // concurrent statusline polls (multiple sessions) must not double-spawn.
        // The stale check above clears it after 30s, which also rate-limits
        // respawn attempts if the daemon crashes on boot.
      }
    }

    // While daemon is warming up (or offline), show fire with "doom: warming up"
    extraSuffix = daemonIsAlive ? 'doom: warming up' : 'doom: warming up';
  }

  // 8. Build HUD line
  const hudLine = buildHudLine({
    state,
    modelObj: json.model,
    ctxObj: json.context_window,
    width,
    extraSuffix,
  });

  // 9. Render fire — quad or half-block depending on config
  const truecolor = detectTruecolor();
  const heatGetPixel = (x, y) => {
    const idx = clamp(y, 0, pixH - 1) * fireW + clamp(x, 0, fireW - 1);
    return heatToRgb(fire.heat[idx]);
  };
  // Pixel style falls back to quad rendering for the fire (no DOOM frame available).
  const lines = (style === 'quad' || style === 'pixel')
    ? renderQuadrants(heatGetPixel, fireW, pixH, { truecolor })
    : renderHalfBlocks(heatGetPixel, width, pixH, { truecolor });

  // 10. Output: HUD line first, then fire rows
  const output = [hudLine, ...lines].join('\n');
  process.stdout.write(output + '\n');
}

main().catch(() => {
  process.stdout.write('afk-arcade ⚠\n');
  process.exit(0);
});
