#!/usr/bin/env node
/**
 * doombrain.mjs — Claude pilots the marine.
 *
 * A sidecar that watches frame.rgb, asks a cheap Claude model for a short
 * play plan (vision via `claude -p`, no API key — uses the user's plan),
 * and drives the daemon through control.json exactly like a human
 * controller: the brain's heartbeat makes it the `user` owner, so the
 * heuristic bot suspends while the brain thinks.
 *
 * Between decisions (model latency ~3-6s) the last plan keeps executing:
 * held keys refresh every BEAT_MS, the turn component expires after
 * plan.turnMs so the marine doesn't orbit.
 *
 * Usage:
 *   node scripts/doombrain.mjs [--once]
 *   AFK_BRAIN_MODEL     model alias/id (default: haiku)
 *   AFK_BRAIN_INTERVAL  ms between decisions (default 4000, min 2000)
 *   AFK_BRAIN_MINUTES   auto-stop after N minutes (default 30)
 *
 * Stop: /afk brain off  (writes doombrain.stop; also kills the pid in
 * doombrain-status.json as belt-and-suspenders).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TMP_ROOT } from '../lib/state.mjs';
import { parseFrameRgb } from '../lib/compose.mjs';
import { encodePngFast } from '../lib/png.mjs';
import { buildControlState } from '../lib/control-core.mjs';
import {
  extractPlan, normalizePlan, planHeldKeys, planTaps, BRAIN_PROMPT,
} from '../lib/brain-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOOM_TMP     = path.join(TMP_ROOT, 'doom');
const FRAME_RGB    = path.join(DOOM_TMP, 'frame.rgb');
const RAW_REQUEST  = path.join(DOOM_TMP, 'raw-request.json');
const CONTROL_JSON = path.join(DOOM_TMP, 'control.json');
const STATUS_FILE  = path.join(DOOM_TMP, 'doombrain-status.json');
const STOP_FILE    = path.join(DOOM_TMP, 'doombrain.stop');
const FRAME_PNG    = path.join(DOOM_TMP, 'doombrain-frame.png');

const MODEL    = process.env.AFK_BRAIN_MODEL ?? 'haiku';
const INTERVAL = Math.max(2000, parseInt(process.env.AFK_BRAIN_INTERVAL ?? '4000', 10) || 4000);
const MAX_MS   = Math.max(1, parseInt(process.env.AFK_BRAIN_MINUTES ?? '30', 10) || 30) * 60_000;
const BEAT_MS  = 200;

const startedAt = Date.now();
let plan = normalizePlan({ move: 'forward', turn: 'none' });
let planAdoptedAt = Date.now();
let tapSeq = 1;
let decisions = 0;
let failures = 0;

function writeStatus(extra) {
  try {
    const tmp = STATUS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      pid: process.pid, model: MODEL, decisions, failures,
      note: plan.note, updatedAt: Date.now(), ...extra,
    }));
    fs.renameSync(tmp, STATUS_FILE);
  } catch { /* non-fatal */ }
}

function writeControl() {
  const held = planHeldKeys(plan, Date.now() - planAdoptedAt);
  try {
    const tmp = CONTROL_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(buildControlState(held, [], tapSeq)));
    fs.renameSync(tmp, CONTROL_JSON);
  } catch { /* daemon reads the next one */ }
}

function releaseControl() {
  try {
    const tmp = CONTROL_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(
      { heartbeat: 0, held: [], taps: [], pid: process.pid }));
    fs.renameSync(tmp, CONTROL_JSON);
  } catch { /* ignore */ }
}

/** Snapshot frame.rgb → upscaled bright PNG the model can actually read. */
function snapshotPng() {
  const buf = fs.readFileSync(FRAME_RGB);
  const frame = parseFrameRgb(buf);
  if (!frame) return false;
  const scale = frame.w >= 220 ? 3 : 4;
  const W = frame.w * scale;
  const H = frame.h * scale;
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const so = (((y / scale) | 0) * frame.w + ((x / scale) | 0)) * 3;
      const o = (y * W + x) * 3;
      // The stream is dimmed for backdrop legibility — undo it for the model
      out[o]     = Math.min(255, frame.data[so] * 2.5);
      out[o + 1] = Math.min(255, frame.data[so + 1] * 2.5);
      out[o + 2] = Math.min(255, frame.data[so + 2] * 2.5);
    }
  }
  const tmp = FRAME_PNG + '.tmp';
  fs.writeFileSync(tmp, encodePngFast(out, W, H));
  fs.renameSync(tmp, FRAME_PNG);
  return true;
}

/** One model decision. Blocking (the heartbeat runs on a timer meanwhile). */
function decide() {
  const prompt = `Read the file ${FRAME_PNG} (a DOOM screenshot). ${BRAIN_PROMPT}`;
  // Prompt goes via STDIN: it contains | and " which cmd.exe would parse as
  // pipeline operators no matter how node quotes the argv.
  const r = spawnSync('cmd.exe', ['/c', 'claude', '-p',
    '--model', MODEL,
    '--allowedTools', 'Read',
    '--strict-mcp-config',
  ], {
    input: prompt,
    encoding: 'utf8',
    timeout: 45_000,
    env: { ...process.env, AFK_DOOMSCREEN_INNER: '1' },
  });
  const next = extractPlan(r.stdout ?? '');
  if (next) {
    plan = next;
    planAdoptedAt = Date.now();
    decisions++;
    if (plan.use) {
      // Single USE tap per plan, merged into the next heartbeat write
      const { taps, nextSeq } = planTaps(plan, tapSeq);
      tapSeq = nextSeq;
      try {
        const held = planHeldKeys(plan, 0);
        const tmp = CONTROL_JSON + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(buildControlState(held, taps, tapSeq)));
        fs.renameSync(tmp, CONTROL_JSON);
      } catch { /* ignore */ }
    }
  } else {
    failures++;
  }
  writeStatus({ lastModelMs: Date.now() });
}

async function main() {
  try { fs.unlinkSync(STOP_FILE); } catch { /* clean start */ }
  process.stdout.write(
    `doombrain: model=${MODEL} interval=${INTERVAL}ms max=${MAX_MS / 60000}min\n`);

  // Heartbeat — keeps ownership and refreshes turn-expiry between decisions
  const beat = setInterval(writeControl, BEAT_MS);

  // Keep raw frames flowing even without a compositor attached
  const rawReq = setInterval(() => {
    try {
      const tmp = RAW_REQUEST + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ cols: 120, rows: 40, pid: process.pid }));
      fs.renameSync(tmp, RAW_REQUEST);
    } catch { /* ignore */ }
  }, 5000);
  try {
    fs.mkdirSync(DOOM_TMP, { recursive: true });
    fs.writeFileSync(RAW_REQUEST, JSON.stringify({ cols: 120, rows: 40, pid: process.pid }));
  } catch { /* ignore */ }

  const once = process.argv.includes('--once');

  for (;;) {
    if (fs.existsSync(STOP_FILE)) break;
    if (Date.now() - startedAt > MAX_MS) break;

    let ok = false;
    try { ok = snapshotPng(); } catch { ok = false; }
    if (ok) decide();
    else writeStatus({ waiting: 'frame.rgb' });

    if (once) break;
    await new Promise((r) => setTimeout(r, INTERVAL));
  }

  clearInterval(beat);
  clearInterval(rawReq);
  releaseControl();
  try { fs.unlinkSync(STOP_FILE); } catch { /* ignore */ }
  writeStatus({ stopped: true });
  process.stdout.write(
    `doombrain: stopped — ${decisions} decisions, ${failures} failures\n`);
}

main().catch((err) => {
  releaseControl();
  process.stderr.write(`doombrain fatal: ${err.message}\n`);
  process.exit(1);
});
