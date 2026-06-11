#!/usr/bin/env node
/**
 * hook.mjs — single dispatcher for ALL Claude Code hook events.
 *
 * IMPORTANT: This script MUST NEVER print to stdout. Hook stdout is injected
 * into Claude's context for UserPromptSubmit hooks. Silent, exit 0 always.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CONFIG_DIR,
  RUNTIME_PATH,
  SESSION_DIR,
  ensureConfig,
  readJson,
  writeJsonAtomic,
  writeSessionState,
  sessionStatePath,
  mkdirp,
} from '../lib/state.mjs';

// ── Read all of stdin ─────────────────────────────────────────────────────────

async function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const onData = (chunk) => chunks.push(chunk);
    const onEnd = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const onError = () => resolve('');

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);

    // If stdin never closes (unlikely but defensive), resolve after 8s
    setTimeout(() => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, 8000);
  });
}

// ── Shim writer ───────────────────────────────────────────────────────────────

/**
 * Write (or refresh) an executable bash shim at CONFIG_DIR/statusline.sh.
 * The shim calls the statusline script via its absolute plugin root so it
 * self-heals across plugin updates.
 *
 * @param {string} pluginRoot  Absolute path to the plugin directory.
 */
function writeStatuslineShim(pluginRoot) {
  try {
    mkdirp(CONFIG_DIR);
    const shimPath = path.join(CONFIG_DIR, 'statusline.sh');
    const content = `#!/bin/bash\nexec node --no-warnings "${pluginRoot}/scripts/statusline.mjs"\n`;
    fs.writeFileSync(shimPath, content, 'utf8');
    fs.chmodSync(shimPath, 0o755);
  } catch {
    // silent
  }
}

// ── Session cleanup ───────────────────────────────────────────────────────────

/**
 * Delete session state file and associated .fire file for a session.
 * @param {string} sessionId
 */
function deleteSessionFiles(sessionId) {
  try {
    const stateFile = sessionStatePath(sessionId);
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  } catch { /* silent */ }

  try {
    const fireFile = path.join(os.tmpdir(), 'afk-arcade', 'sessions', `${sessionId}.fire`);
    if (fs.existsSync(fireFile)) fs.unlinkSync(fireFile);
  } catch { /* silent */ }
}

/**
 * Remove session state files older than 24 hours.
 */
function pruneOldSessions() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(SESSION_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fullPath = path.join(SESSION_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
      } catch { /* single file error — continue */ }
    }
  } catch { /* SESSION_DIR may not exist */ }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleSessionStart(payload) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  if (pluginRoot) {
    // Persist plugin root so statusline.sh can locate scripts after updates
    writeJsonAtomic(RUNTIME_PATH, {
      pluginRoot,
      updatedAt: Date.now(),
    });
    writeStatuslineShim(pluginRoot);
  }

  ensureConfig();

  const sessionId = payload.session_id;
  if (sessionId) {
    writeSessionState(sessionId, { mode: 'idle', attention: false });
  }
}

function handleUserPromptSubmit(payload) {
  const sessionId = payload.session_id;
  if (!sessionId) return;
  writeSessionState(sessionId, { mode: 'working', attention: false });
}

function handleStop(payload) {
  const sessionId = payload.session_id;
  if (!sessionId) return;
  writeSessionState(sessionId, { mode: 'idle', attention: false });
}

function handleNotification(payload) {
  const sessionId = payload.session_id;
  if (!sessionId) return;

  const notifType = payload.notification_type;

  if (notifType === 'idle_prompt') {
    writeSessionState(sessionId, { mode: 'afk', attention: false });
    return;
  }

  if (notifType === 'permission_prompt') {
    // Keep current mode, only flip attention flag
    const currentFile = sessionStatePath(sessionId);
    const current = readJson(currentFile, { mode: 'idle', attention: false });
    writeSessionState(sessionId, {
      mode: current.mode,
      attention: true,
      since: current.since,
    });
    return;
  }

  // Other notification types — ignore
}

function handleSessionEnd(payload) {
  const sessionId = payload.session_id;
  if (sessionId) deleteSessionFiles(sessionId);
  pruneOldSessions();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();

  let payload = {};
  try {
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    // Malformed JSON — proceed with empty payload (defensive)
  }

  const event = payload.hook_event_name ?? '';

  switch (event) {
    case 'SessionStart':
      handleSessionStart(payload);
      break;
    case 'UserPromptSubmit':
      handleUserPromptSubmit(payload);
      break;
    case 'Stop':
    case 'StopFailure':
      handleStop(payload);
      break;
    case 'Notification':
      handleNotification(payload);
      break;
    case 'SessionEnd':
      handleSessionEnd(payload);
      break;
    default:
      // Unknown event — ignore silently
      break;
  }
}

main().catch(() => {
  // Never let an unhandled rejection surface as output or a non-zero exit
}).finally(() => {
  process.exit(0);
});
