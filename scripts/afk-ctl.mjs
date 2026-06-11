#!/usr/bin/env node
/**
 * afk-ctl.mjs — config CLI for the afk-arcade plugin.
 *
 * Usage:
 *   node afk-ctl.mjs status
 *   node afk-ctl.mjs on | off
 *   node afk-ctl.mjs game fire | game doom
 *   node afk-ctl.mjs rows <N>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readConfig,
  writeConfig,
  CONFIG_PATH,
  SESSION_DIR,
  readJson,
} from '../lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR_DOOM = path.join(ROOT, 'vendor', 'doom');

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function printConfig(cfg) {
  process.stdout.write(
    `afk-arcade: game=${cfg.game} rows=${cfg.rows} aspect=${cfg.aspect ?? '4:3'} enabled=${cfg.enabled}\n`,
  );
}

function activeSessionSummary() {
  try {
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
    if (!files.length) {
      process.stdout.write('  (no active sessions)\n');
      return;
    }
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 min
    for (const f of files) {
      const data = readJson(path.join(SESSION_DIR, f), null);
      if (!data) continue;
      const sessionId = f.replace(/\.json$/, '');
      const fresh = data.updatedAt > cutoff;
      const age = Math.round((Date.now() - data.updatedAt) / 1000);
      const label = fresh ? `${data.mode}${data.attention ? ' ⚠ATTENTION' : ''}` : `(stale ${age}s)`;
      process.stdout.write(`  session ${sessionId}: ${label}\n`);
    }
  } catch {
    process.stdout.write('  (session dir not found)\n');
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0];

const cfg = readConfig();

switch (cmd) {
  case 'status': {
    process.stdout.write(`config: ${CONFIG_PATH}\n`);
    printConfig(cfg);
    process.stdout.write('sessions:\n');
    activeSessionSummary();
    break;
  }

  case 'on': {
    writeConfig({ enabled: true });
    printConfig({ ...cfg, enabled: true });
    break;
  }

  case 'off': {
    writeConfig({ enabled: false });
    printConfig({ ...cfg, enabled: false });
    break;
  }

  case 'game': {
    const game = args[1];
    if (!['fire', 'doom'].includes(game)) {
      process.stdout.write(`afk-arcade: unknown game "${game ?? ''}". Valid options: fire, doom\n`);
      process.exit(1);
    }
    if (game === 'doom') {
      // Verify vendor assets exist before switching
      const vendorFiles = ['doom.js', 'doom.wasm', 'doom1.wad'];
      const missing = vendorFiles.filter((f) => {
        try { return fs.statSync(path.join(VENDOR_DOOM, f)).size < 1000; } catch { return true; }
      });
      if (missing.length > 0) {
        process.stdout.write(
          `afk-arcade: DOOM vendor assets missing: ${missing.join(', ')}\n` +
          `  Run:  node ${path.join(ROOT, 'scripts', 'fetch-doom.mjs')}\n` +
          `  Or:   /afk fetch-doom\n`,
        );
        process.exit(1);
      }
    }
    writeConfig({ game });
    printConfig({ ...cfg, game });
    break;
  }

  case 'fetch-doom': {
    const fetchScript = path.join(ROOT, 'scripts', 'fetch-doom.mjs');
    const result = spawnSync(process.execPath, ['--no-warnings', fetchScript], {
      stdio: 'inherit',
    });
    process.exit(result.status ?? 0);
    break;
  }

  case 'rows': {
    const raw = parseInt(args[1], 10);
    if (isNaN(raw)) {
      process.stdout.write(`afk-arcade: "rows" requires a number. Usage: afk-ctl.mjs rows <2..30>\n`);
      process.exit(1);
    }
    const rows = clamp(raw, 2, 30);
    writeConfig({ rows });
    printConfig({ ...cfg, rows });
    break;
  }

  case 'aspect': {
    const aspect = args[1];
    if (!['4:3', '16:10', 'stretch'].includes(aspect)) {
      process.stdout.write(
        `afk-arcade: unknown aspect "${aspect ?? ''}". Valid options: 4:3, 16:10, stretch\n`,
      );
      process.exit(1);
    }
    writeConfig({ aspect });
    printConfig({ ...cfg, aspect });
    break;
  }

  case 'play': {
    // Print the command to run in a fresh terminal — do NOT launch DOOM here.
    // The statusline/hook context cannot take over Claude Code's own terminal.
    const playScript = path.join(ROOT, 'scripts', 'play.mjs');
    process.stdout.write(
      `Run this command in a fresh terminal tab:\n\n` +
      `  node ${playScript}\n\n` +
      `Controls: WASD/arrows move \xB7 SPACE use \xB7 F fire \xB7 1-7 weapons \xB7 ESC menu \xB7 Q quit\n`,
    );
    break;
  }

  default: {
    process.stdout.write([
      'afk-arcade control CLI',
      '',
      'Commands:',
      '  status               — show current config and active sessions',
      '  on / off             — enable or disable the banner',
      '  game fire            — switch to DOOM fire effect',
      '  game doom            — switch to DOOM WASM daemon frame (Phase B)',
      '  rows <N>             — set banner height (2..30 rows)',
      '  aspect <4:3|16:10|stretch> — set DOOM frame aspect ratio (default: 4:3)',
      '  fetch-doom           — download DOOM WASM assets into vendor/doom/',
      '  play                 — print the command to play DOOM in a fresh terminal',
    ].join('\n') + '\n');
    break;
  }
}
