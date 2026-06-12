#!/usr/bin/env node
/**
 * doomscreen.mjs — the universal backdrop: DOOM behind Claude Code in ANY
 * terminal, no graphics protocols, no sidecar tab, no external terminal.
 *
 *   ┌─ real terminal (alt-screen, we own every cell) ──────────────┐
 *   │  DOOM frame (frame.rgb → quadrant glyphs)         ← base     │
 *   │  Claude Code's screen (@xterm/headless, composed) ← top      │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Claude runs inside a pseudo-terminal; its output feeds a headless xterm
 * (the virtual screen). Each tick we composite game + claude into a text
 * grid and diff-paint the real terminal. Claude never touches the real
 * screen directly.
 *
 * PTY layer:
 *   win32 — `conhost.exe --headless` spawned directly (inbox binary; plain
 *           text input + in-band resize CSI 8;rows;cols t verified).
 *           Keyboard is OURS: F8 / Ctrl+] toggles claude ↔ marine. (§5
 *           input capture absorbed — no expect, no Tcl.)
 *   macOS — `/usr/bin/script -q /dev/null` with inherited stdin (keyboard
 *           flows natively to claude; game input stays on the sidecar).
 *   linux — `script -qfc` equivalent, same native-keyboard caveat.
 *
 * Usage:
 *   node scripts/doomscreen.mjs [--selftest] [-- <command> [args…]]
 *   AFK_DOOMSCREEN_FPS   compositor rate, 5..20 (default 15)
 *   AFK_DOOMSCREEN_CMD   wrapped command (default "claude") — drills use cmd.exe
 *   AFK_DOOMSCREEN_DEBUG=1  JSONL telemetry via lib/debug.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { TMP_ROOT } from '../lib/state.mjs';
import { parseFrameRgb, composeGrid, renderDiff } from '../lib/compose.mjs';
import { decodeKeys } from '../lib/keys.mjs';
import { mapKeyEventToDoom, buildControlState } from '../lib/control-core.mjs';
import { xtermVendorValid } from './fetch-xterm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DOOM_TMP     = path.join(TMP_ROOT, 'doom');
const RAW_REQUEST  = path.join(DOOM_TMP, 'raw-request.json');
const FRAME_RGB    = path.join(DOOM_TMP, 'frame.rgb');
const CONTROL_JSON = path.join(DOOM_TMP, 'control.json');
const PID_FILE     = path.join(DOOM_TMP, 'daemon.pid');
const SPAWN_LOCK   = path.join(DOOM_TMP, 'spawn.lock');

const FPS = Math.max(5, Math.min(20,
  parseInt(process.env.AFK_DOOMSCREEN_FPS ?? '15', 10) || 15));
/** A frozen frame older than this is dropped (hides daemon recycles). */
const FRAME_FRESH_MS = 12_000;
/** Toggle keys: F8 (CSI 19~) and Ctrl+] (0x1d, survives chunk splits). */
const F8_SEQ = Buffer.from('\x1b[19~');
const CTRL_RBRACKET = 0x1d;

// ── Debug telemetry (optional) ────────────────────────────────────────────────

let dbg = () => {};
if (process.env.AFK_DOOMSCREEN_DEBUG === '1') {
  try {
    const { dbgLog } = await import('../lib/debug.mjs');
    dbg = (data) => dbgLog('doomscreen', data);
  } catch { /* debug module unavailable — stay silent */ }
}

// ── PTY layer ─────────────────────────────────────────────────────────────────

/**
 * Spawn the wrapped command inside a pseudo-terminal.
 *
 * @param {string[]} cmdArgs  [command, ...args]
 * @param {number} cols
 * @param {number} rows
 * @returns {{ child: import('node:child_process').ChildProcess,
 *             routedInput: boolean }}
 *   routedInput true → we own the keyboard (write child.stdin);
 *   false → keyboard flows natively (stdin inherited by the pty).
 */
function spawnPty(cmdArgs, cols, rows) {
  if (process.platform === 'win32') {
    // cmd.exe /c resolves .cmd/.bat shims (claude installs as claude.cmd)
    const child = spawn('conhost.exe', [
      '--headless', '--width', String(cols), '--height', String(rows), '--',
      'cmd.exe', '/c', ...cmdArgs,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    return { child, routedInput: true };
  }

  if (process.platform === 'darwin') {
    // Verified on macOS: `script` works with INHERITED stdin only — a pipe
    // raises "tcgetattr: not supported on socket" (HANDOFF §4).
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', ...cmdArgs], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    return { child, routedInput: false };
  }

  // linux (util-linux script syntax)
  const quoted = cmdArgs.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const child = spawn('script', ['-qfc', quoted, '/dev/null'], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  return { child, routedInput: false };
}

/** Ask the pty to adopt a new size. */
function resizePty(child, routedInput, cols, rows) {
  if (process.platform === 'win32') {
    // In-band resize — verified intercepted by conhost --headless.
    try { child.stdin.write(`\x1b[8;${rows};${cols}t`); } catch { /* gone */ }
  } else {
    try { process.kill(child.pid, 'SIGWINCH'); } catch { /* gone */ }
  }
}

// ── Daemon liveness (same spawn-lock dance as the statusline) ─────────────────

function ensureDaemon() {
  let alive = false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid > 0) { process.kill(pid, 0); alive = true; }
  } catch { /* absent or dead */ }
  if (alive) return;

  try {
    try {
      const lockStat = fs.statSync(SPAWN_LOCK);
      if (Date.now() - lockStat.mtimeMs > 30_000) fs.rmdirSync(SPAWN_LOCK);
    } catch { /* no lock */ }
    fs.mkdirSync(SPAWN_LOCK);
  } catch {
    return; // another process is spawning
  }
  try {
    const daemon = spawn(process.execPath,
      ['--no-warnings', path.join(__dirname, 'daemon.mjs')],
      { detached: true, stdio: 'ignore' });
    daemon.unref();
    dbg({ event: 'daemon-spawned' });
  } catch { /* non-fatal — game layer stays blank */ }
}

// ── raw-request / frame.rgb plumbing ──────────────────────────────────────────

function writeRawRequest(cols, rows) {
  try {
    fs.mkdirSync(DOOM_TMP, { recursive: true });
    const tmp = RAW_REQUEST + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cols, rows, pid: process.pid }));
    fs.renameSync(tmp, RAW_REQUEST);
  } catch { /* non-fatal */ }
}

/** Stateful frame.rgb reader — re-reads only on mtime change. */
function makeFrameReader() {
  let lastMtime = 0;
  let frame = null;
  let frameAt = 0;
  return () => {
    try {
      const stat = fs.statSync(FRAME_RGB);
      if (stat.mtimeMs !== lastMtime) {
        const parsed = parseFrameRgb(fs.readFileSync(FRAME_RGB));
        if (parsed) {
          lastMtime = stat.mtimeMs;
          frame = parsed;
          frameAt = Date.now();
        }
      }
    } catch { /* absent — keep last */ }
    if (frame && Date.now() - frameAt > FRAME_FRESH_MS) return null;
    return frame;
  };
}

// ── Game input (F8 mode) — control.json, zero Tcl ─────────────────────────────

class GameControls {
  constructor() {
    /** @type {Map<number, number>} code → last keydown ms */
    this.held = new Map();
    this.taps = [];
    this.seq = 1;
    this.timer = null;
  }

  start() {
    // Heartbeat + held-key expiry sweep. Terminals auto-repeat held keys, so
    // a key not re-seen for 300ms has been released (same window as the
    // stdin bridge in control.mjs).
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [code, at] of this.held) {
        if (now - at > 300) this.held.delete(code);
      }
      this.flush();
    }, 120);
  }

  feed(buf) {
    for (const name of decodeKeys(buf)) {
      const mapped = mapKeyEventToDoom(name);
      if (!mapped) continue;
      if (mapped.held) {
        this.held.set(mapped.code, Date.now());
      } else {
        this.taps.push({ seq: this.seq++, code: mapped.code });
        if (this.taps.length > 8) this.taps.shift();
      }
    }
    this.flush();
  }

  flush() {
    const state = buildControlState([...this.held.keys()], this.taps, this.seq);
    try {
      const tmp = CONTROL_JSON + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, CONTROL_JSON);
    } catch { /* daemon will see the next one */ }
  }

  /** Release ownership back to the bot (heartbeat 0 sentinel). */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.held.clear();
    this.taps = [];
    try {
      const tmp = CONTROL_JSON + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(
        { heartbeat: 0, held: [], taps: [], pid: process.pid }));
      fs.renameSync(tmp, CONTROL_JSON);
    } catch { /* ignore */ }
  }
}

// ── Game-mode overlay badge ───────────────────────────────────────────────────

const BADGE = '  DOOM — F8: back to Claude · WASD move · F fire · Space use  ';

function stampBadge(grid, cols) {
  const start = Math.max(0, cols - BADGE.length);
  for (let k = 0; k < BADGE.length && start + k < cols; k++) {
    const i = start + k;
    grid.ch[i] = BADGE[k];
    grid.fg[i] = '\x1b[0;1;38;5;220m';
    grid.bg[i] = '\x1b[48;5;52m';
  }
}

// ── Selftest ──────────────────────────────────────────────────────────────────

async function runSelftest() {
  process.stderr.write('doomscreen: --selftest: PTY layer roundtrip…\n');
  if (process.platform !== 'win32') {
    process.stderr.write(
      'doomscreen: selftest: PASS (full check is win32-only; unix uses script(1))\n');
    process.exit(0);
  }
  const marker = 'DOOMSCREEN_SELFTEST_OK';
  const result = await new Promise((resolve) => {
    const { child } = spawnPty([`echo ${marker}`], 80, 24);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const t = setTimeout(() => { child.kill(); resolve({ out, code: -1 }); }, 15_000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ out, code }); });
  });
  if (result.code === 0 && result.out.includes(marker) && result.out.includes('\x1b[')) {
    process.stderr.write('doomscreen: selftest: PASS — conhost VT roundtrip works\n');
    process.exit(0);
  }
  process.stderr.write(
    `doomscreen: selftest: FAIL — exit ${result.code}, ` +
    `tail ${JSON.stringify(result.out.slice(-80))}\n`);
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest') {
    await runSelftest();
    return;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write('doomscreen: needs a real terminal (stdin+stdout TTY)\n');
    process.exit(1);
  }

  // Wrapped command: everything after `--`, else AFK_DOOMSCREEN_CMD, else claude
  const dashDash = argv.indexOf('--');
  const cmdArgs = dashDash !== -1 && argv.length > dashDash + 1
    ? argv.slice(dashDash + 1)
    : [process.env.AFK_DOOMSCREEN_CMD ?? 'claude'];

  // Vendor the virtual terminal on first run
  if (!(await xtermVendorValid())) {
    process.stderr.write('doomscreen: vendoring @xterm/headless (first run)…\n');
    const r = spawnSync(process.execPath,
      ['--no-warnings', path.join(__dirname, 'fetch-xterm.mjs')],
      { stdio: 'inherit' });
    if (r.status !== 0 || !(await xtermVendorValid())) {
      process.stderr.write('doomscreen: vendor failed — run: node scripts/fetch-xterm.mjs\n');
      process.exit(1);
    }
  }
  const require = createRequire(import.meta.url);
  const { Terminal } = require(path.join(ROOT, 'vendor', 'xterm'));

  let cols = process.stdout.columns ?? 120;
  let rows = process.stdout.rows ?? 30;

  ensureDaemon();
  writeRawRequest(cols, rows);

  // ── Virtual screen ──────────────────────────────────────────────────────────
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  let cursorVisible = true;

  const { child, routedInput } = spawnPty(cmdArgs, cols, rows);

  child.stdout.on('data', (chunk) => {
    term.write(chunk);
    // Track DECTCEM so the real cursor mirrors claude's (xterm doesn't expose it)
    const s = chunk.toString('latin1');
    const lastShow = s.lastIndexOf('\x1b[?25h');
    const lastHide = s.lastIndexOf('\x1b[?25l');
    if (lastShow !== -1 || lastHide !== -1) cursorVisible = lastShow > lastHide;
  });
  // Query responses (DA/DSR/CPR…) from the virtual terminal go back to claude
  if (routedInput) {
    term.onData((d) => { try { child.stdin.write(d); } catch { /* gone */ } });
  }

  // ── Real screen setup ───────────────────────────────────────────────────────
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');

  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    try { clearInterval(renderTimer); } catch { /* not yet armed */ }
    try { clearInterval(rawReqTimer); } catch { /* not yet armed */ }
    controls.stop();
    try { process.stdin.setRawMode(false); } catch { /* not a tty */ }
    process.stdin.pause();
    process.stdout.write('\x1b[?2026l\x1b[0m\x1b[?1049l\x1b[?25h');
  };

  child.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  // ── Keyboard routing (win32 conhost path) ───────────────────────────────────
  let mode = 'claude'; // 'claude' | 'game'
  const controls = new GameControls();

  if (routedInput) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      // Toggle detection: F8 (CSI 19~, within-chunk) or Ctrl+] (single byte)
      let toggle = false;
      if (buf.includes(CTRL_RBRACKET) || buf.includes(F8_SEQ)) toggle = true;

      if (toggle) {
        mode = mode === 'claude' ? 'game' : 'claude';
        dbg({ event: 'toggle', mode });
        if (mode === 'game') controls.start();
        else controls.stop();
        forceRepaint = true;
        return; // toggle chunks are never forwarded
      }

      if (mode === 'claude') {
        try { child.stdin.write(buf); } catch { /* child gone */ }
      } else {
        controls.feed(buf);
      }
    });
  }

  // ── Resize ──────────────────────────────────────────────────────────────────
  process.stdout.on('resize', () => {
    cols = process.stdout.columns ?? cols;
    rows = process.stdout.rows ?? rows;
    term.resize(cols, rows);
    resizePty(child, routedInput, cols, rows);
    writeRawRequest(cols, rows);
    prevGrid = null; // full repaint
    dbg({ event: 'resize', cols, rows });
  });

  // ── Compositor loop ─────────────────────────────────────────────────────────
  const readFrame = makeFrameReader();
  let prevGrid = null;
  let forceRepaint = false;
  let painting = false;

  const rawReqTimer = setInterval(() => writeRawRequest(cols, rows), 5_000);

  const renderTimer = setInterval(() => {
    if (painting || exiting) return;
    painting = true;
    try {
      const frame = readFrame();
      const bufA = term.buffer.active;
      const vy = bufA.viewportY;
      const lineCache = new Array(rows).fill(undefined);
      const getTermCell = (c, r) => {
        let line = lineCache[r];
        if (line === undefined) {
          line = bufA.getLine(vy + r) ?? null;
          lineCache[r] = line;
        }
        return line ? (line.getCell(c) ?? null) : null;
      };

      const grid = composeGrid({ cols, rows, frame, getTermCell, truecolor: true });
      if (mode === 'game') stampBadge(grid, cols);

      if (forceRepaint) { prevGrid = null; forceRepaint = false; }
      const out = renderDiff(prevGrid, grid, cols, rows, {
        x: Math.min(bufA.cursorX, cols - 1),
        y: Math.min(bufA.cursorY, rows - 1),
        visible: mode === 'claude' && cursorVisible,
      });
      prevGrid = grid;
      if (out) process.stdout.write(out);
    } catch (err) {
      dbg({ event: 'render-error', message: err.message });
    } finally {
      painting = false;
    }
  }, Math.round(1000 / FPS));

  dbg({ event: 'boot', cols, rows, fps: FPS, routedInput, cmd: cmdArgs });
}

main().catch((err) => {
  try { process.stdout.write('\x1b[0m\x1b[?1049l\x1b[?25h'); } catch { /* tty gone */ }
  process.stderr.write(`doomscreen fatal: ${err.message}\n`);
  process.exit(1);
});
