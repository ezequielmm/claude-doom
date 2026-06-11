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
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readConfig,
  writeConfig,
  CONFIG_PATH,
  SESSION_DIR,
  readJson,
} from '../lib/state.mjs';
import { DEBUG_LOG } from '../lib/debug.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR_DOOM = path.join(ROOT, 'vendor', 'doom');

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function printConfig(cfg) {
  process.stdout.write(
    `afk-arcade: game=${cfg.game} rows=${cfg.rows} aspect=${cfg.aspect ?? '4:3'} style=${cfg.style ?? 'quad'} enabled=${cfg.enabled}\n`,
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

  case 'setup': {
    const setupScript = path.join(ROOT, 'scripts', 'setup.mjs');
    // Pass through --yes and --no-iterm flags if present
    const setupArgs = args.slice(1).filter(a => a === '--yes' || a === '--no-iterm');
    const result = spawnSync(process.execPath, ['--no-warnings', setupScript, ...setupArgs], {
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
    const rows = clamp(raw, 2, 40);
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

  case 'style': {
    const style = args[1];
    if (!['quad', 'half', 'pixel'].includes(style)) {
      process.stdout.write(
        `afk-arcade: unknown style "${style ?? ''}". Valid options: quad, half, pixel\n` +
        '  quad  — adaptive 2×2 quadrant blocks (2× horizontal detail, default)\n' +
        '  half  — classic half-block ▀ rendering\n' +
        '  pixel — EXPERIMENTAL: kitty Unicode placeholder banner (kitty/Warp/WezTerm/Ghostty\n' +
        '          with kitty graphics + U=1 support required; revert with /afk style quad)\n',
      );
      process.exit(1);
    }
    writeConfig({ style });
    printConfig({ ...cfg, style });
    break;
  }

  case 'backdrop': {
    const value = args[1];
    if (!['on', 'off'].includes(value)) {
      process.stdout.write(
        `afk-arcade: usage: backdrop <on|off>\n` +
        '  on  — the darkened game frame becomes the WHOLE terminal background\n' +
        '        (kitty graphics z=-2 under-text layer; Claude Code UI floats on top;\n' +
        '        verified in Warp). The banner collapses to a single HUD line.\n' +
        '  off — remove the backdrop image and restore the normal banner\n',
      );
      process.exit(1);
    }
    writeConfig({ backdrop: value === 'on' });
    printConfig({ ...cfg, backdrop: value === 'on' });
    if (value === 'on') {
      process.stdout.write('Backdrop enabled — give the daemon a few seconds to bake the first frame.\n');
    }
    break;
  }

  case 'debug': {
    const sub = args[1];

    if (sub === 'on') {
      writeConfig({ debug: true });
      process.stdout.write('afk-arcade: debug logging enabled — logs go to ' + DEBUG_LOG + '\n');
      process.stdout.write('  Disable with:  /afk debug off\n');
      process.stdout.write('  Tail with:     /afk debug tail\n');
      process.stdout.write('  Or set env:    AFK_ARCADE_DEBUG=1\n');
      break;
    }

    if (sub === 'off') {
      writeConfig({ debug: false });
      process.stdout.write('afk-arcade: debug logging disabled\n');
      break;
    }

    if (sub === 'tail' || sub === undefined) {
      const n = sub === 'tail' && args[2] ? parseInt(args[2], 10) : 30;
      const lineCount = isNaN(n) || n < 1 ? 30 : n;

      let raw;
      try {
        raw = fs.readFileSync(DEBUG_LOG, 'utf8');
      } catch {
        process.stdout.write('(no debug log yet — enable with: /afk debug on)\n');
        break;
      }

      const allLines = raw.split('\n').filter(l => l.length > 0);
      if (allLines.length === 0) {
        process.stdout.write('(debug log is empty)\n');
        break;
      }

      const tail = allLines.slice(-lineCount);
      process.stdout.write(tail.join('\n') + '\n');
      break;
    }

    // Unknown sub-command
    process.stdout.write([
      'afk-arcade debug commands:',
      '  debug on           — enable JSONL debug logging to ' + DEBUG_LOG,
      '  debug off          — disable debug logging',
      '  debug tail [n]     — print last n lines from debug.log (default: 30)',
      '',
      'Or set env:  AFK_ARCADE_DEBUG=1  (enables without touching config)',
    ].join('\n') + '\n');
    break;
  }

  case 'play': {
    const playScript = path.join(ROOT, 'scripts', 'play.mjs');
    const CONTROLS = 'Controls: WASD/arrows move \xB7 SPACE use \xB7 F fire \xB7 1-7 weapons \xB7 ESC menu \xB7 Q quit';
    const playCmd  = `${process.execPath} --no-warnings ${playScript} --gfx auto`;

    if (process.platform === 'darwin') {
      const warpInstalled  = fs.existsSync('/Applications/Warp.app');
      const itermInstalled = fs.existsSync('/Applications/iTerm.app');

      if (warpInstalled) {
        // Write a Warp Launch Configuration YAML and open it via the URI scheme.
        // Schema: https://docs.warp.dev/terminal/sessions/launch-configurations
        // URI:    warp://launch/<url-encoded-path-to-yaml>
        const launchDir  = path.join(os.homedir(), '.warp', 'launch_configurations');
        const launchFile = path.join(launchDir, 'claude-doom.yaml');

        // Ensure the directory exists
        fs.mkdirSync(launchDir, { recursive: true });

        // Build the YAML — single window, single tab, one command.
        // cwd must be an absolute path (~ is not accepted by Warp).
        const yaml = [
          '# Warp Launch Configuration — generated by afk-arcade /afk play',
          '---',
          'name: claude-doom',
          'windows:',
          '  - tabs:',
          '      - title: DOOM',
          '        layout:',
          `          cwd: ${os.homedir()}`,
          '          commands:',
          `            - exec: "${process.execPath} --no-warnings ${playScript} --gfx auto"`,
        ].join('\n') + '\n';

        fs.writeFileSync(launchFile, yaml, 'utf8');

        // URI: warp://launch/<url-encoded absolute path>
        const uri = `warp://launch/${encodeURIComponent(launchFile)}`;

        let launched = false;
        try {
          execFileSync('open', [uri], { timeout: 5000 });
          launched = true;
        } catch {
          /* open failed — fall through to manual instructions */
        }

        if (launched) {
          process.stdout.write(
            `Launched DOOM in a Warp tab.\n` +
            `${CONTROLS}\n`,
          );
        } else {
          process.stdout.write(
            `Could not open Warp automatically. Run this command in a fresh Warp tab:\n\n` +
            `  ${playCmd}\n\n` +
            `${CONTROLS}\n`,
          );
        }
        break;
      }

      if (itermInstalled) {
        process.stdout.write(
          `Run this command inside iTerm2 for pixel-perfect mode:\n\n` +
          `  ${playCmd}\n\n` +
          `${CONTROLS}\n`,
        );
        break;
      }
    }

    // Non-darwin or no supported terminal detected
    process.stdout.write(
      `Run this command in a fresh terminal tab:\n\n` +
      `  ${playCmd}\n\n` +
      `${CONTROLS}\n`,
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
      '  rows <N>             — set banner height (2..40 rows)',
      '  aspect <4:3|16:10|stretch> — set DOOM frame aspect ratio (default: 4:3)',
      '  backdrop <on|off>    — game as the WHOLE terminal background (kitty z=-2),',
      '                         Claude Code UI floats on top; banner becomes HUD-only',
      '  style <quad|half|pixel>',
      '                       — set render style: quad (2×2 blocks, default), half (▀ classic),',
      '                         or pixel (EXPERIMENTAL kitty Unicode placeholder banner)',
      '  debug on             — enable JSONL diagnostics (written to ~/.claude/afk-arcade/debug.log)',
      '  debug off            — disable diagnostics',
      '  debug tail [n]       — print last n lines from debug.log (default: 30)',
      '  fetch-doom           — download DOOM WASM assets into vendor/doom/',
      '  play                 — print the command to play DOOM in a fresh terminal',
      '  setup [--yes] [--no-iterm]',
      '                       — one-shot installer: wires statusline, downloads DOOM assets,',
      '                         offers iTerm2 on macOS (--yes to accept all, --no-iterm to skip)',
    ].join('\n') + '\n');
    break;
  }
}
