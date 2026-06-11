/**
 * doom.test.mjs — Phase B integration tests.
 *
 * Skips cleanly (prints a SKIP notice per test) when vendor/doom assets
 * are absent so CI without fetched assets still passes.
 *
 * Tests:
 *   1. Engine boot — createDoom(), 120 ticks, 64×40 color sample > 50 distinct
 *   2. Daemon e2e  — spawn daemon.mjs, wait for frame.ans, SIGTERM, pidfile cleaned
 *   3. Statusline doom mode — config game=doom + fake frame.ans → frame content in output
 */

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const VENDOR_DOOM  = path.join(ROOT, 'vendor', 'doom');
const DAEMON_SCRIPT = path.join(ROOT, 'scripts', 'daemon.mjs');
const STATUS_SCRIPT = path.join(ROOT, 'scripts', 'statusline.mjs');
const CTL_SCRIPT    = path.join(ROOT, 'scripts', 'afk-ctl.mjs');

// ── Skip guard ────────────────────────────────────────────────────────────────

function vendorPresent() {
  for (const f of ['doom.js', 'doom.wasm', 'doom1.wad']) {
    try {
      if (fs.statSync(path.join(VENDOR_DOOM, f)).size < 1000) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const SKIP = !vendorPresent();

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * @type {{ name: string, fn: () => Promise<void> | void }[]}
 */
const tests = [];

/**
 * Wait up to `maxMs` for `predicate()` to return true, polling every `intervalMs`.
 * @param {() => boolean} predicate
 * @param {number} maxMs
 * @param {number} [intervalMs=200]
 * @returns {Promise<boolean>}
 */
function waitFor(predicate, maxMs, intervalMs = 200) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      if (predicate()) {
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Test 1: Engine boot + color count
tests.push({
  name: 'doom engine boot — 120 ticks, >50 distinct colors in 64×40 sample',
  async fn() {
    if (SKIP) return 'SKIP';

    const { createDoom } = await import('../lib/doom-engine.mjs');

    const engine = await createDoom();
    if (!engine) throw new Error('createDoom() returned falsy');

    // Tick 120 times
    for (let i = 0; i < 120; i++) engine.tick();

    // Sample a 64×40 grid
    const seen = new Set();
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 64; x++) {
        const sx = Math.min(engine.width  - 1, Math.floor(x / 64 * engine.width));
        const sy = Math.min(engine.height - 1, Math.floor(y / 40 * engine.height));
        const [r, g, b] = engine.getPixel(sx, sy);
        seen.add((r << 16) | (g << 8) | b);
      }
    }

    engine.dispose();

    const distinctColors = seen.size;
    if (distinctColors <= 50) {
      throw new Error(`Expected >50 distinct colors, got ${distinctColors}`);
    }

    return `${distinctColors} distinct colors`;
  },
});

// Test 2: Daemon e2e
tests.push({
  name: 'doom daemon e2e — spawns, writes frame.ans with ▀ and ANSI, cleans up on SIGTERM',
  async fn() {
    if (SKIP) return 'SKIP';

    const doomDir    = path.join(os.tmpdir(), 'afk-arcade', 'doom');
    const pidFile    = path.join(doomDir, 'daemon.pid');
    const frameFile  = path.join(doomDir, 'frame.ans');
    const viewportFile = path.join(doomDir, 'viewport.json');

    // Clean state
    for (const f of [pidFile, frameFile, viewportFile]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    fs.mkdirSync(doomDir, { recursive: true });

    // Write a viewport.json so the daemon doesn't bail on the watchdog
    fs.writeFileSync(viewportFile, JSON.stringify({ cols: 40, pxRows: 10, truecolor: false }), 'utf8');

    // Spawn daemon
    const child = spawn(process.execPath, ['--no-warnings', DAEMON_SCRIPT], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Poll up to 20s for a fresh frame.ans that contains ▀ and ANSI escapes
    const deadline = Date.now() + 20_000;
    const ok = await waitFor(() => {
      try {
        const stat = fs.statSync(frameFile);
        if (Date.now() - stat.mtimeMs > 5000) return false;
        const content = fs.readFileSync(frameFile, 'utf8');
        return content.includes('▀') && content.includes('\x1b[');
      } catch {
        return false;
      }
    }, 20_000, 300);

    if (!ok) {
      // Cleanup anyway
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* ignore */ }
      throw new Error(`frame.ans not written within 20s (deadline ${deadline})`);
    }

    // Read pid from pidfile
    let daemonPid = 0;
    try {
      daemonPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    } catch {
      throw new Error('daemon.pid not written');
    }

    if (isNaN(daemonPid) || daemonPid <= 0) {
      throw new Error(`daemon.pid contains invalid value`);
    }

    // SIGTERM the daemon
    try {
      process.kill(daemonPid, 'SIGTERM');
    } catch {
      throw new Error(`Failed to SIGTERM daemon pid ${daemonPid}`);
    }

    // Wait for pidfile to be removed (up to 5s)
    const pidGone = await waitFor(() => {
      try { fs.statSync(pidFile); return false; } catch { return true; }
    }, 5000, 100);

    if (!pidGone) {
      throw new Error('daemon.pid still present after SIGTERM');
    }

    return `frame.ans OK, pid ${daemonPid} cleaned up`;
  },
});

// Test 3: Statusline doom mode with fake frame
tests.push({
  name: 'statusline doom mode — reads fake frame.ans and includes it in output',
  fn() {
    if (SKIP) return 'SKIP';

    const doomDir    = path.join(os.tmpdir(), 'afk-arcade', 'doom');
    const frameFile  = path.join(doomDir, 'frame.ans');

    fs.mkdirSync(doomDir, { recursive: true });

    // Write a recognisable fake frame (fresh mtime)
    const fakeFrame = '\x1b[38;2;255;0;0m▀\x1b[0m DOOM_TEST_FRAME';
    fs.writeFileSync(frameFile, fakeFrame, 'utf8');

    // Switch config to doom (will stay for this test, restored after)
    spawnSync(process.execPath, ['--no-warnings', CTL_SCRIPT, 'game', 'doom'], {
      encoding: 'utf8',
    });

    try {
      const payload = JSON.stringify({
        session_id: 'doom-test-session',
        model: { id: 'claude-test', display_name: 'Test' },
      });

      const r = spawnSync(process.execPath, ['--no-warnings', STATUS_SCRIPT], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, COLUMNS: '80', COLORTERM: 'truecolor' },
        timeout: 5000,
      });

      if (r.status !== 0) throw new Error(`statusline exited ${r.status}: ${r.stderr}`);
      if (!r.stdout.includes('DOOM_TEST_FRAME')) {
        throw new Error(
          `Expected fake frame content in output.\nstdout: ${JSON.stringify(r.stdout.slice(0, 300))}`,
        );
      }
    } finally {
      // Restore config to fire
      spawnSync(process.execPath, ['--no-warnings', CTL_SCRIPT, 'game', 'fire'], {
        encoding: 'utf8',
      });
      // Clean up fake frame
      try { fs.unlinkSync(frameFile); } catch { /* ignore */ }
    }
  },
});

// ── Export runner ─────────────────────────────────────────────────────────────

/**
 * Run all doom tests, appending results to the shared counters.
 *
 * @param {{ passed: { value: number }, failed: { value: number } }} counters
 * @param {{ test: (name: string, fn: () => void) => void }} runner
 */
export async function runDoomTests(counters, runner) {
  if (SKIP) {
    process.stdout.write(
      '\nSKIP  [doom] vendor/doom assets absent — run: node scripts/fetch-doom.mjs\n',
    );
    return;
  }

  process.stdout.write('\n── doom tests ─────────────────────────────────────────\n');

  for (const t of tests) {
    const t0 = Date.now();
    try {
      const note = await t.fn();
      const elapsed = Date.now() - t0;
      const suffix = note === 'SKIP' ? ' (SKIPPED)' : ` (${elapsed}ms${note ? ' — ' + note : ''})`;
      process.stdout.write(`PASS  ${t.name}${suffix}\n`);
      counters.passed.value++;
    } catch (err) {
      const elapsed = Date.now() - t0;
      process.stdout.write(`FAIL  ${t.name} (${elapsed}ms)\n      ${err.message}\n`);
      counters.failed.value++;
    }
  }
}
