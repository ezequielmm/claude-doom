/**
 * brain-core.mjs — pure helpers for the Claude-piloted DOOM brain.
 *
 * The brain sidecar (scripts/doombrain.mjs) asks a cheap Claude model for a
 * short play plan from a frame screenshot, then drives the daemon through
 * control.json exactly like a human controller (owner: user — the heuristic
 * bot suspends while the brain's heartbeat is fresh).
 *
 * Everything here is pure: plan parsing and plan→keys translation, no I/O.
 */

import {
  KEY_UPARROW,
  KEY_DOWNARROW,
  KEY_LEFTARROW,
  KEY_RIGHTARROW,
  KEY_USE,
  KEY_FIRE,
} from './control-core.mjs';

/**
 * Extract the first JSON object from a model reply (models love prose and
 * code fences no matter how hard the prompt says "ONLY JSON").
 *
 * @param {string} text
 * @returns {object | null}
 */
export function extractPlan(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Walk to the matching close brace (plans are flat, but be tolerant)
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return normalizePlan(JSON.parse(text.slice(start, i + 1)));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Clamp a raw parsed object into a well-formed plan.
 *
 * @param {object} raw
 * @returns {{ move: 'forward'|'back'|'none', turn: 'left'|'right'|'none',
 *             turnMs: number, fire: boolean, use: boolean, note: string }}
 */
export function normalizePlan(raw) {
  const move = raw.move === 'back' ? 'back' : raw.move === 'none' ? 'none' : 'forward';
  const turn = raw.turn === 'left' ? 'left' : raw.turn === 'right' ? 'right' : 'none';
  const turnMs = Math.max(0, Math.min(1200, Number(raw.turnMs) || 0));
  return {
    move,
    turn,
    turnMs: turn === 'none' ? 0 : (turnMs || 300),
    fire: raw.fire === true,
    use: raw.use === true,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 60) : '',
  };
}

/**
 * Translate a plan into the held-key set for a moment in time.
 *
 * The turn key is held only for the first plan.turnMs of the plan's life —
 * after that the marine keeps moving straight (prevents orbiting).
 *
 * @param {ReturnType<typeof normalizePlan>} plan
 * @param {number} planAgeMs  ms since this plan was adopted
 * @returns {number[]}  sorted DOOM key codes to hold right now
 */
export function planHeldKeys(plan, planAgeMs) {
  const held = [];
  if (plan.move === 'forward') held.push(KEY_UPARROW);
  else if (plan.move === 'back') held.push(KEY_DOWNARROW);
  if (plan.turn !== 'none' && planAgeMs < plan.turnMs) {
    held.push(plan.turn === 'left' ? KEY_LEFTARROW : KEY_RIGHTARROW);
  }
  if (plan.fire) held.push(KEY_FIRE);
  return held.sort((a, b) => a - b);
}

/**
 * Tap list for a freshly adopted plan (USE fires once per plan).
 *
 * @param {ReturnType<typeof normalizePlan>} plan
 * @param {number} seq  next tap sequence number
 * @returns {{ taps: { seq: number, code: number }[], nextSeq: number }}
 */
export function planTaps(plan, seq) {
  if (!plan.use) return { taps: [], nextSeq: seq };
  return { taps: [{ seq, code: KEY_USE }], nextSeq: seq + 1 };
}

/** The prompt sent alongside every frame. Kept terse — haiku-friendly. */
export const BRAIN_PROMPT = [
  'You are piloting the marine in DOOM. The attached image is the current frame.',
  'Reply with ONLY minified JSON, no prose, no code fences:',
  '{"move":"forward|back|none","turn":"left|right|none","turnMs":<0-1200>,"fire":<bool>,"use":<bool>,"note":"<max 8 words>"}',
  'Tactics: if a monster is visible, turn to center it and fire.',
  'If a wall/door fills most of the view, turn 400-800ms toward open space;',
  'use:true when a door or switch is close ahead. Prefer unexplored dark',
  'openings over walls. Keep moving — standing still is death.',
].join(' ');
