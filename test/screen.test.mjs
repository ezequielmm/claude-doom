/**
 * screen.test.mjs — universal compositor (doomscreen) test suite.
 *
 * Covers:
 *   1. parseFrameRgb — header validation and pixel payload integrity
 *   2. composeGrid — claude-wins precedence, game transparency, no-frame base
 *   3. renderDiff — full paint, no-change short-circuit, minimal repaint runs
 *   4. xtermCellToCompose — colour modes, attributes, wide-char continuation
 *   5. conhost --headless roundtrip (win32 only — the PTY layer doomscreen
 *      uses on Windows; skipped elsewhere)
 *
 * Standalone:  node test/screen.test.mjs
 * Integrated:  wired as a phase in test/run.mjs (runScreenTests export)
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseFrameRgb,
  composeGrid,
  renderDiff,
  xtermCellToCompose,
} from '../lib/compose.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'assertion failed');
}

/**
 * Build a frame.rgb buffer filled with a single colour.
 */
function solidFrame(w, h, [r, g, b]) {
  const buf = Buffer.alloc(4 + w * h * 3);
  buf.writeUInt16LE(w, 0);
  buf.writeUInt16LE(h, 2);
  for (let i = 0; i < w * h; i++) {
    buf[4 + i * 3] = r;
    buf[4 + i * 3 + 1] = g;
    buf[4 + i * 3 + 2] = b;
  }
  return buf;
}

/**
 * Duck-typed fake of an xterm buffer cell.
 */
function fakeCell({
  ch = ' ', width = 1,
  bold = false, dim = false, italic = false, underline = false, inverse = false,
  fgMode = 'default', fgColor = 0,
  bgMode = 'default', bgColor = 0,
} = {}) {
  return {
    getChars: () => ch === ' ' ? '' : ch,
    getWidth: () => width,
    isBold: () => bold,
    isDim: () => dim,
    isItalic: () => italic,
    isUnderline: () => underline,
    isInverse: () => inverse,
    isFgDefault: () => fgMode === 'default',
    isFgPalette: () => fgMode === 'palette',
    isFgRGB: () => fgMode === 'rgb',
    getFgColor: () => fgColor,
    isBgDefault: () => bgMode === 'default',
    isBgPalette: () => bgMode === 'palette',
    isBgRGB: () => bgMode === 'rgb',
    getBgColor: () => bgColor,
  };
}

const blankTerm = () => null;

// ── Shared test runner ────────────────────────────────────────────────────────

export async function runScreenTests(counters, { test: testFn }) {
  // ── parseFrameRgb ───────────────────────────────────────────────────────────

  await testFn('parseFrameRgb: valid buffer roundtrips dims and payload', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [10, 20, 30]));
    assert(frame !== null, 'valid frame must parse');
    assert(frame.w === 8 && frame.h === 4, `dims must be 8x4, got ${frame.w}x${frame.h}`);
    assert(frame.data.length === 8 * 4 * 3, 'payload length must match dims');
    assert(frame.data[0] === 10 && frame.data[1] === 20 && frame.data[2] === 30,
      'first pixel must be (10,20,30)');
  });

  await testFn('parseFrameRgb: truncated / corrupt buffers return null', () => {
    assert(parseFrameRgb(null) === null, 'null buffer');
    assert(parseFrameRgb(Buffer.alloc(2)) === null, 'short buffer');
    const bad = solidFrame(8, 4, [0, 0, 0]).subarray(0, 20);
    assert(parseFrameRgb(bad) === null, 'truncated payload');
    const zero = Buffer.alloc(4);
    assert(parseFrameRgb(zero) === null, 'zero dims');
  });

  // ── composeGrid precedence ──────────────────────────────────────────────────

  await testFn('composeGrid: claude char wins over the game layer', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [200, 0, 0]));
    const cells = { 0: fakeCell({ ch: 'X' }) };
    const grid = composeGrid({
      cols: 4, rows: 2, frame,
      getTermCell: (c, r) => cells[r * 4 + c] ?? null,
      truecolor: true,
    });
    assert(grid.ch[0] === 'X', `cell 0 must be claude's X, got ${JSON.stringify(grid.ch[0])}`);
    assert(grid.bg[0] === '\x1b[49m', 'claude cell without own bg gets the 49 halo');
    assert(grid.bg[1].includes('48;2;200;0;0') || grid.fg[1].includes('38;2;200;0;0'),
      `cell 1 must carry game red, got fg=${JSON.stringify(grid.fg[1])} bg=${JSON.stringify(grid.bg[1])}`);
  });

  await testFn('composeGrid: space with explicit bg wins (claude highlight)', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [0, 200, 0]));
    const cells = { 0: fakeCell({ ch: ' ', bgMode: 'palette', bgColor: 4 }) };
    const grid = composeGrid({
      cols: 4, rows: 2, frame,
      getTermCell: (c, r) => cells[r * 4 + c] ?? null,
      truecolor: true,
    });
    assert(grid.ch[0] === ' ', 'cell stays a space');
    assert(grid.bg[0] === '\x1b[48;5;4m', `bg must be palette 4, got ${JSON.stringify(grid.bg[0])}`);
  });

  await testFn('composeGrid: space with default bg is transparent (game shows)', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [0, 0, 180]));
    const grid = composeGrid({
      cols: 4, rows: 2, frame,
      getTermCell: () => fakeCell({ ch: ' ' }),
      truecolor: true,
    });
    const blue = grid.bg[0].includes('0;0;180') || grid.fg[0].includes('0;0;180');
    assert(blue, `game blue must show through, got fg=${JSON.stringify(grid.fg[0])} bg=${JSON.stringify(grid.bg[0])}`);
  });

  await testFn('composeGrid: no frame → blank default-bg base', () => {
    const grid = composeGrid({
      cols: 3, rows: 2, frame: null, getTermCell: blankTerm, truecolor: true,
    });
    assert(grid.ch.every((c) => c === ' '), 'all cells blank');
    assert(grid.bg.every((b) => b === '\x1b[49m'), 'all cells default bg');
  });

  // ── renderDiff ──────────────────────────────────────────────────────────────

  await testFn('renderDiff: full paint positions every row and parks cursor', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [120, 60, 30]));
    const grid = composeGrid({
      cols: 4, rows: 2, frame, getTermCell: blankTerm, truecolor: true,
    });
    const out = renderDiff(null, grid, 4, 2, { x: 1, y: 1, visible: true });
    assert(out.includes('\x1b[1;1H'), 'row 1 positioned');
    assert(out.includes('\x1b[2;1H'), 'row 2 positioned');
    assert(out.startsWith('\x1b[?2026h'), 'sync-output begin');
    assert(out.endsWith('\x1b[?2026l'), 'sync-output end');
    assert(out.includes('\x1b[2;2H\x1b[?25h'), 'cursor parked at (1,1) and visible');
  });

  await testFn('renderDiff: identical grids → cursor park only, no sync wrap', () => {
    const grid = composeGrid({
      cols: 3, rows: 2, frame: null, getTermCell: blankTerm, truecolor: true,
    });
    const out = renderDiff(grid, grid, 3, 2, { x: 0, y: 0, visible: false });
    assert(!out.includes('\x1b[?2026h'), 'no sync wrapper when nothing changed');
    assert(out === '\x1b[1;1H\x1b[?25l', `park only, got ${JSON.stringify(out)}`);
  });

  await testFn('renderDiff: single cell change → exactly one reposition', () => {
    const a = composeGrid({
      cols: 5, rows: 3, frame: null, getTermCell: blankTerm, truecolor: true,
    });
    const cells = { [1 * 5 + 2]: fakeCell({ ch: 'Z' }) };
    const b = composeGrid({
      cols: 5, rows: 3, frame: null,
      getTermCell: (c, r) => cells[r * 5 + c] ?? null,
      truecolor: true,
    });
    const out = renderDiff(a, b, 5, 3, { x: 0, y: 0, visible: true });
    const repositions = out.match(/\x1b\[\d+;\d+H/g) ?? [];
    // One for the changed run + one cursor park
    assert(repositions.length === 2, `expected 2 positionings, got ${repositions.length}: ${JSON.stringify(out)}`);
    assert(out.includes('\x1b[2;3H'), `run must start at row 2 col 3, got ${JSON.stringify(out)}`);
    assert(out.includes('Z'), 'changed glyph present');
  });

  // ── xtermCellToCompose ──────────────────────────────────────────────────────

  await testFn('xtermCellToCompose: RGB fg and attributes encode into SGR', () => {
    const cell = fakeCell({ ch: 'A', bold: true, fgMode: 'rgb', fgColor: (250 << 16) | (100 << 8) | 25 });
    const c = xtermCellToCompose(cell);
    assert(c.wins, 'printable char wins');
    assert(c.fg === '\x1b[0;1;38;2;250;100;25m', `got ${JSON.stringify(c.fg)}`);
  });

  await testFn('xtermCellToCompose: width-0 continuation emits nothing, skipped by diff', () => {
    const cont = xtermCellToCompose(fakeCell({ width: 0 }));
    assert(cont.ch === '' && cont.wins, 'continuation: empty glyph, still claims the cell');

    const cells = { 0: fakeCell({ ch: '日', width: 2 }), 1: fakeCell({ width: 0 }) };
    const grid = composeGrid({
      cols: 3, rows: 1, frame: null,
      getTermCell: (c, r) => cells[r * 3 + c] ?? null,
      truecolor: true,
    });
    const out = renderDiff(null, grid, 3, 1, { x: 0, y: 0, visible: true });
    const wideIdx = out.indexOf('日');
    assert(wideIdx !== -1, 'wide char rendered');
    // The continuation cell must not inject a glyph between 日 and the next cell
    const after = out.slice(wideIdx + '日'.length);
    assert(!after.startsWith('日'), 'no duplicate wide glyph');
  });

  // ── conhost --headless roundtrip (win32 only) ──────────────────────────────

  if (process.platform === 'win32') {
    await testFn('conhost --headless: VT output + plain input roundtrip + exit code', async () => {
      const result = await new Promise((resolve) => {
        const c = spawn('conhost.exe', [
          '--headless', '--width', '80', '--height', '24', '--',
          'cmd.exe', '/v:on', '/c', 'set /p X=prompt: && echo GOT=!X!',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        setTimeout(() => c.stdin.write('hello\r\n'), 1500);
        const t = setTimeout(() => { c.kill(); resolve({ out, code: -1 }); }, 15_000);
        c.on('exit', (code) => { clearTimeout(t); resolve({ out, code }); });
      });
      assert(result.code === 0, `conhost child must exit 0, got ${result.code}`);
      assert(result.out.includes('GOT=hello'),
        `input must roundtrip, output tail: ${JSON.stringify(result.out.slice(-120))}`);
      assert(result.out.includes('\x1b['), 'output must be a VT stream');
    });
    await testFn('doomscreen e2e: typing reaches child, F8-mode drives control.json, alt-screen', async () => {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const CONTROL = path.join(os.tmpdir(), 'afk-arcade', 'doom', 'control.json');
      try { fs.unlinkSync(CONTROL); } catch { /* absent */ }

      // doomscreen needs a TTY — an outer headless conhost provides one, and
      // we drive its keyboard from out here. Full §5 drill, no human needed.
      // Note: this spawns the shared daemon; the doom phase / watchdog owns
      // its lifecycle, so no teardown here.
      const result = await new Promise((resolve) => {
        const outer = spawn('conhost.exe', [
          '--headless', '--width', '100', '--height', '30', '--',
          'node', '--no-warnings', path.join(ROOT, 'scripts', 'doomscreen.mjs'),
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, AFK_DOOMSCREEN_CMD: 'cmd.exe' },
        });
        let out = '';
        outer.stdout.on('data', (d) => { out += d; });
        setTimeout(() => outer.stdin.write('echo HELLO_E2E\r'), 5000);
        setTimeout(() => outer.stdin.write('\x1d'), 8000);            // Ctrl+] → game
        let wTimer = null;
        setTimeout(() => {
          // hold W only after the toggle — terminal-autorepeat style
          wTimer = setInterval(() => {
            try { outer.stdin.write('w'); } catch { /* closing */ }
          }, 100);
        }, 8600);
        setTimeout(() => {
          clearInterval(wTimer);
          let ctl = null;
          try { ctl = JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { /* missing */ }
          outer.kill();
          resolve({ out, ctl });
        }, 11_500);
      });

      assert(result.out.includes('\x1b[?1049h'), 'alt-screen must be entered');
      assert(result.out.includes('HELLO_E2E'),
        'typed command must reach the wrapped child and composite back');
      assert(result.out.includes('F8: back to Claude'), 'game-mode badge must render');
      assert(result.ctl !== null, 'control.json must exist after game-mode input');
      assert(Array.isArray(result.ctl.held) && result.ctl.held.includes(0xad),
        `held W must map to KEY_UPARROW 0xad, got ${JSON.stringify(result.ctl?.held)}`);
    });
  } else {
    process.stdout.write('SKIP  conhost --headless roundtrip — win32 only\n');
    process.stdout.write('SKIP  doomscreen e2e — win32 only\n');
  }

  // ── Compositor-implied bot (daemon contract, needs vendor assets) ──────────

  const fs = await import('node:fs');
  const os = await import('node:os');
  const vendorOk = ['doom.js', 'doom.wasm', 'doom1.wad'].every((f) => {
    try { return fs.statSync(path.join(ROOT, 'vendor', 'doom', f)).size > 1000; }
    catch { return false; }
  });

  if (vendorOk) {
    await testFn('daemon: fresh raw-request implies bot even with config.bot=false', async () => {
      const doomTmp = path.join(os.tmpdir(), 'afk-arcade', 'doom');
      const pidFile = path.join(doomTmp, 'daemon.pid');
      const shutdownFile = path.join(doomTmp, 'daemon.shutdown');
      const botStatus = path.join(doomTmp, 'bot-status.json');
      const rawRequest = path.join(doomTmp, 'raw-request.json');

      const waitFor = (pred, maxMs, step = 250) => new Promise((resolve) => {
        const deadline = Date.now() + maxMs;
        const poll = () => {
          if (pred()) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, step);
        };
        poll();
      });
      const shutdown = async () => {
        try { fs.writeFileSync(shutdownFile, 'screen-test'); } catch { /* ignore */ }
        await waitFor(() => { try { fs.statSync(pidFile); return false; } catch { return true; } }, 6000);
      };

      // The daemon is a machine-wide singleton (named pipe on win32) — stop
      // any live instance first, exactly like the doom phase does.
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (pid > 0) await shutdown();
      } catch { /* none running */ }
      for (const f of [botStatus, rawRequest, shutdownFile]) {
        try { fs.unlinkSync(f); } catch { /* absent */ }
      }

      // Isolated config dir with bot explicitly OFF
      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-screen-cfg-'));
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
        enabled: true, game: 'fire', rows: 5, bot: false,
      }));

      const daemon = spawn(process.execPath,
        ['--no-warnings', path.join(ROOT, 'scripts', 'daemon.mjs')],
        { env: { ...process.env, AFK_ARCADE_CONFIG_DIR: cfgDir }, stdio: 'ignore', detached: true });
      daemon.unref();

      try {
        const booted = await waitFor(() => {
          try { return fs.statSync(pidFile).size > 0; } catch { return false; }
        }, 15_000);
        assert(booted, 'daemon must boot (pidfile)');

        // No raw-request yet → no bot block → no bot-status.json
        await new Promise((r) => setTimeout(r, 3500));
        assert(!fs.existsSync(botStatus),
          'bot-status.json must NOT appear while config.bot=false and no compositor');

        // Compositor arrives
        fs.writeFileSync(rawRequest, JSON.stringify({ cols: 60, rows: 20 }));
        const botLive = await waitFor(() => fs.existsSync(botStatus), 20_000);
        assert(botLive, 'bot-status.json must appear once raw-request is fresh (implied bot)');
      } finally {
        await shutdown();
        try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  } else {
    process.stdout.write('SKIP  compositor-implied bot — vendor/doom assets absent\n');
  }
}

// ── Standalone runner ─────────────────────────────────────────────────────────

async function runStandalone() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      process.stdout.write(`PASS  ${name}\n`);
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
      failed++;
    }
  }

  await runScreenTests(null, { test });

  process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runStandalone().catch((err) => {
    process.stderr.write(`screen.test.mjs fatal: ${err.message}\n`);
    process.exit(1);
  });
}
