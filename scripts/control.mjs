#!/usr/bin/env node
/**
 * control.mjs — user controller sidecar for the afk-arcade DOOM backdrop.
 *
 * Run in a dedicated terminal tab (launched by `afk-ctl control`):
 *   node scripts/control.mjs
 *
 * Requires a TTY (stdin must be a real terminal). Exits with an error message
 * if no TTY is available.
 *
 * The daemon reads TMP_ROOT/doom/control.json on every tick. When the
 * heartbeat is fresh (<1500ms old) the daemon lets the user drive;
 * when it goes stale or heartbeat===0 the bot resumes automatically.
 *
 * Controls:
 *   w / up-arrow      move forward
 *   s / down-arrow    move backward
 *   a / left-arrow    turn left
 *   d / right-arrow   turn right
 *   space             use (open door / interact) — tap
 *   f or x            fire weapon — held
 *   1-7               select weapon — tap
 *   enter             confirm / menu select — tap
 *   esc               menu / escape — tap
 *   q / ctrl+c        quit and hand control back to bot
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKeys, HeldKeyTracker } from '../lib/keys.mjs';
import {
  mapKeyEventToDoom,
  buildControlState,
  KEY_FIRE,
} from '../lib/control-core.mjs';
import { TMP_ROOT } from '../lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Require TTY ───────────────────────────────────────────────────────────────

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  process.stderr.write(
    'control.mjs: stdin must be a TTY.\n' +
    'Run this command in a fresh interactive terminal tab — not piped or scripted.\n',
  );
  process.exit(1);
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const DOOM_TMP      = path.join(TMP_ROOT, 'doom');
const CONTROL_JSON  = path.join(DOOM_TMP, 'control.json');
const DAEMON_PIDFILE = path.join(DOOM_TMP, 'daemon.pid');

// ── State ─────────────────────────────────────────────────────────────────────

// Set of DOOM key codes currently held by the user.
const heldCodes = new Set();

// Pending tap events not yet written to control.json.
// Each entry: { seq: number, code: number }
const pendingTaps = [];

// Monotonically increasing sequence counter for tap events.
let nextTapSeq = 1;

// ── Atomic write helper ───────────────────────────────────────────────────────

function mkdirpSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Atomically write the current control state to control.json.
 * Uses tmp+rename so readers never see a partial file.
 */
function writeControlState() {
  try {
    mkdirpSync(DOOM_TMP);
    const state = buildControlState(Array.from(heldCodes), pendingTaps, nextTapSeq);
    const tmp = CONTROL_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, CONTROL_JSON);
  } catch {
    // Non-fatal — the daemon will see a stale heartbeat and resume bot control
  }
}

/**
 * Write a zero-heartbeat sentinel so the daemon immediately releases user
 * ownership and re-arms the bot. This is called on clean exit only.
 */
function writeReleaseState() {
  try {
    mkdirpSync(DOOM_TMP);
    const tmp = CONTROL_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ heartbeat: 0, held: [], taps: [], pid: process.pid }), 'utf8');
    fs.renameSync(tmp, CONTROL_JSON);
  } catch {
    // Best effort — daemon will also recover via stale-heartbeat detection
  }
}

// ── Status line rendering ─────────────────────────────────────────────────────

// ANSI helpers
const RESET    = '\x1b[0m';
const BOLD     = '\x1b[1m';
const DIM      = '\x1b[2m';
const FG_GREEN = '\x1b[38;5;70m';
const FG_CYAN  = '\x1b[38;5;51m';
const FG_GRAY  = '\x1b[38;5;244m';
const FG_YLW   = '\x1b[38;5;220m';

/** Check if the daemon pid file is present (daemon running). */
function isDaemonRunning() {
  try {
    const raw = fs.readFileSync(DAEMON_PIDFILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // throws if no such process
    return true;
  } catch {
    return false;
  }
}

/** Build a compact human-readable list of currently held codes. */
function heldSummary() {
  if (heldCodes.size === 0) return '(none)';
  const names = {
    [0xad]: 'W↑', [0xaf]: 'S↓', [0xac]: 'A←', [0xae]: 'D→',
    [0xa3]: 'FIRE',
  };
  return Array.from(heldCodes)
    .map(c => names[c] ?? `0x${c.toString(16)}`)
    .join(' ');
}

/** Overwrite the current terminal line (no newline). */
function writeStatusLine() {
  const daemonUp = isDaemonRunning();
  const daemonText = daemonUp
    ? `${FG_GREEN}daemon running${RESET}`
    : `${FG_GRAY}daemon not detected${RESET}`;
  const heldText = heldCodes.size > 0
    ? `${FG_YLW}${heldSummary()}${RESET}`
    : `${FG_GRAY}(no keys)${RESET}`;
  const line = `\r${DIM}[afk-ctrl]${RESET} ${FG_CYAN}${BOLD}you're driving${RESET} · ${daemonText} · held: ${heldText}   `;
  process.stdout.write(line);
}

// ── Key event handling ────────────────────────────────────────────────────────

/** Held-key tracker for movement and fire keys. */
const tracker = new HeldKeyTracker(
  // onDown: key starts being held
  (keyName) => {
    const mapping = mapKeyEventToDoom(keyName);
    if (!mapping || !mapping.held) return;
    heldCodes.add(mapping.code);
    writeControlState();
    writeStatusLine();
  },
  // onUp: key released (auto-repeat expired)
  (keyName) => {
    const mapping = mapKeyEventToDoom(keyName);
    if (!mapping || !mapping.held) return;
    heldCodes.delete(mapping.code);
    writeControlState();
    writeStatusLine();
  },
  160, // expireMs — matches play.mjs
);

/**
 * Process a batch of decoded key names from a single stdin data event.
 * Held keys go through the tracker; tap keys are added to pendingTaps
 * and written immediately.
 */
function handleKeys(keyNames) {
  let stateChanged = false;

  for (const keyName of keyNames) {
    // Quit signal
    if (keyName === 'q' || keyName === '\x03') {
      cleanup();
      return;
    }

    const mapping = mapKeyEventToDoom(keyName);
    if (!mapping) continue;

    if (mapping.held) {
      // Feed into the held-key tracker (which calls onDown/onUp itself)
      tracker.see(keyName);
      stateChanged = true;
    } else {
      // Tap: add to pending list and write immediately
      pendingTaps.push({ seq: nextTapSeq++, code: mapping.code });
      // Keep pending taps bounded at 16 (daemon drains them quickly)
      if (pendingTaps.length > 16) pendingTaps.splice(0, pendingTaps.length - 16);
      stateChanged = true;
    }
  }

  if (stateChanged) {
    writeControlState();
    writeStatusLine();
  }
}

// ── Heartbeat timer (~15Hz) ───────────────────────────────────────────────────

// Write state at ~15Hz even if nothing changed, to keep the heartbeat fresh.
// Also call tracker.sweep() to release expired held keys.
const heartbeatTimer = setInterval(() => {
  tracker.sweep();
  writeControlState();
  writeStatusLine();
}, 66); // ~15Hz

// ── Cleanup ───────────────────────────────────────────────────────────────────

let cleaningUp = false;

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;

  clearInterval(heartbeatTimer);

  // Release all held keys and flush tracker
  tracker.releaseAll();
  heldCodes.clear();

  // Restore terminal
  try {
    process.stdin.setRawMode(false);
  } catch { /* ignore — may already be restored */ }

  process.stdin.pause();

  // Write zero-heartbeat so daemon resumes bot immediately
  writeReleaseState();

  // Move to a new line so the terminal prompt appears cleanly
  process.stdout.write('\r\n');
  process.exit(0);
}

process.on('SIGINT',  cleanup);
process.on('SIGTERM', cleanup);

// ── Setup stdin raw mode ──────────────────────────────────────────────────────

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (buf) => {
  const keyNames = decodeKeys(buf);
  handleKeys(keyNames);
});

// ── Initial display ───────────────────────────────────────────────────────────

// Print a small header (fixed, not overwritten by the status line)
process.stdout.write(
  `${BOLD}afk-arcade controller${RESET} — you take the wheel while Claude thinks.\n` +
  `  ${FG_CYAN}WASD/arrows${RESET} move · ${FG_CYAN}SPACE${RESET} use · ${FG_CYAN}F/X${RESET} fire · ` +
  `${FG_CYAN}1-7${RESET} weapons · ${FG_CYAN}ESC${RESET} menu · ${FG_CYAN}Q/^C${RESET} quit\n`,
);

// Write initial status
writeControlState();
writeStatusLine();
