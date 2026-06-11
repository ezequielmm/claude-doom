/**
 * doom-bot.mjs — Pixel-heuristic DOOM autopilot.
 *
 * Drives the engine via pushKey calls.  No setInterval/setTimeout inside
 * the bot — the daemon tick loop supplies the clock via update(nowMs).
 *
 * Usage:
 *   const bot = createBot(engine);
 *   // in daemon tick loop:
 *   bot.update(Date.now(), isAggressive);
 *   // on shutdown:
 *   bot.dispose();
 *
 * Key codes (from doomgeneric doomkeys.h, verified in lib/doom-engine.mjs comments):
 *   KEY_UPARROW   0xad
 *   KEY_DOWNARROW 0xaf
 *   KEY_LEFTARROW 0xac
 *   KEY_RIGHTARROW 0xae
 *   KEY_USE       0xa2
 *   KEY_FIRE      0xa3
 *   KEY_ESCAPE    27
 *   KEY_ENTER     13
 */

// ── Key constants ─────────────────────────────────────────────────────────────

const KEY_UPARROW   = 0xad;
const KEY_DOWNARROW = 0xaf;
const KEY_LEFTARROW = 0xac;
const KEY_RIGHTARROW = 0xae;
const KEY_USE       = 0xa2;
const KEY_FIRE      = 0xa3;
const KEY_ESCAPE    = 27;
const KEY_ENTER     = 13;

// ── Tunables (top-level constants) ────────────────────────────────────────────

/** ms between play-loop decisions */
const DECISION_INTERVAL_MS = 150;

/** Calm wander: turn every 1.2-2.5s, hold 150-450ms */
const WANDER_MIN_INTERVAL_MS  = 1200;
const WANDER_MAX_INTERVAL_MS  = 2500;
const WANDER_MIN_HOLD_MS      = 150;
const WANDER_MAX_HOLD_MS      = 450;

/** Aggressive wander: more frequent */
const WANDER_AGG_MIN_INTERVAL_MS = 800;
const WANDER_AGG_MAX_INTERVAL_MS = 1500;

/** Stuck detection: same center signature for >1.6s → unstick */
const STUCK_THRESHOLD_MS        = 1600;
const STUCK_CENTER_COLS         = 64;
const STUCK_CENTER_ROWS         = 40;
const STUCK_DELTA_THRESHOLD     = 100;
const STUCK_TURN_MIN_MS         = 500;
const STUCK_TURN_MAX_MS         = 800;

/** Monster detection: sample a 48×32 grid in screen center */
const MONSTER_SAMPLE_COLS       = 48;
const MONSTER_SAMPLE_ROWS       = 32;
/** Fleshy pixel: r>90 && r>g*1.25 && r>b*1.25 */
const MONSTER_THRESHOLD_NORMAL  = 0.08;  // 8% of sampled pixels
const MONSTER_THRESHOLD_AGG     = 0.04;  // 4% when aggressive (shoots more eagerly)

/** Fire burst: hold FIRE 300ms, release 250ms */
const FIRE_HOLD_MS              = 300;
const FIRE_RELEASE_MS           = 250;

/** Aggressive rush: forward + fire periodically */
const RUSH_INTERVAL_MS          = 5000;

/** KEY_USE tap every ~4s; ENTER tap every ~10s */
const USE_INTERVAL_MS           = 4000;
const ENTER_INTERVAL_MS         = 10_000;

/** Game-start retry if still not in-game after 8s */
const START_RETRY_INTERVAL_MS   = 8000;
/** After > 3s not in-game → begin start sequence */
const NOT_IN_GAME_THRESHOLD_MS  = 3000;
/** Delay between start sequence ENTER taps */
const START_SEQ_STEP_MS         = 700;

/** HUD detection: bottom 12% scanlines; low-variance gray strip means in-game */
const HUD_BOTTOM_PCT            = 0.12;
const HUD_GRAY_VARIANCE_THRESH  = 800;  // low color variance = gray strip

// ── Bot state machine ─────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   tick(): void,
 *   getPixel(x: number, y: number): [number, number, number],
 *   getFrameRGB(out?: Uint8Array): Uint8Array,
 *   pushKey(pressed: 0|1, code: number): void,
 *   width: number,
 *   height: number,
 * }} Engine
 */

/**
 * Create a heuristic DOOM bot.
 *
 * @param {Engine} engine
 * @returns {{ update(nowMs: number, aggressive: boolean): void, dispose(): void }}
 */
export function createBot(engine) {
  // ── Timed key queue ───────────────────────────────────────────────────────
  // A small list of pending key events with absolute fire times.
  // Each entry: { atMs: number, action: () => void }
  const keyQueue = [];

  function scheduleKey(delayMs, action) {
    // Store the absolute time
    keyQueue.push({ atMs: _lastNow + delayMs, action });
  }

  function flushKeyQueue(nowMs) {
    let i = 0;
    while (i < keyQueue.length) {
      if (keyQueue[i].atMs <= nowMs) {
        try { keyQueue[i].action(); } catch { /* ignore */ }
        keyQueue.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  // ── Tap helper (down + up after ~80ms) ────────────────────────────────────
  function tap(code, nowMs) {
    engine.pushKey(1, code);
    scheduleKey(80, () => engine.pushKey(0, code));
  }

  // ── In-game detection ────────────────────────────────────────────────────
  function isInGame() {
    const w = engine.width;
    const h = engine.height;
    if (!w || !h) return false;

    // Sample the bottom HUD_BOTTOM_PCT of the frame
    const startY = Math.floor(h * (1 - HUD_BOTTOM_PCT));
    const sampleStep = Math.max(1, Math.floor(w / 32));

    let sumR = 0, sumG = 0, sumB = 0;
    let count = 0;
    let rAbove90 = 0;

    for (let y = startY; y < h; y += 2) {
      for (let x = 0; x < w; x += sampleStep) {
        const [r, g, b] = engine.getPixel(x, y);
        sumR += r; sumG += g; sumB += b;
        if (r > 90) rAbove90++;
        count++;
      }
    }

    if (count === 0) return false;

    const meanR = sumR / count;
    const meanG = sumG / count;
    const meanB = sumB / count;

    // Variance in RGB (simple proxy for "is this a uniform gray strip?")
    let varSum = 0;
    let c2 = 0;
    for (let y = startY; y < h; y += 2) {
      for (let x = 0; x < w; x += sampleStep) {
        const [r, g, b] = engine.getPixel(x, y);
        varSum += (r - meanR) ** 2 + (g - meanG) ** 2 + (b - meanB) ** 2;
        c2++;
      }
    }
    const variance = c2 > 0 ? varSum / c2 : 0;

    // Title screen: high reds and high variance
    // In-game HUD: low-variance grayish strip
    if (variance < HUD_GRAY_VARIANCE_THRESH) {
      return true; // uniform gray strip → in-game HUD
    }

    // Also treat as in-game if bottom strip is NOT heavily red/orange
    const redFraction = count > 0 ? rAbove90 / count : 0;
    return redFraction < 0.3;
  }

  // ── Monster detection ─────────────────────────────────────────────────────
  function monsterRatio() {
    const w = engine.width;
    const h = engine.height;
    if (!w || !h) return 0;

    const startX = Math.floor((w - MONSTER_SAMPLE_COLS) / 2);
    const startY = Math.floor((h - MONSTER_SAMPLE_ROWS) / 2);
    const stepX = Math.max(1, Math.floor(MONSTER_SAMPLE_COLS / 16));
    const stepY = Math.max(1, Math.floor(MONSTER_SAMPLE_ROWS / 8));

    let fleshy = 0;
    let total = 0;
    for (let y = startY; y < startY + MONSTER_SAMPLE_ROWS && y < h; y += stepY) {
      for (let x = startX; x < startX + MONSTER_SAMPLE_COLS && x < w; x += stepX) {
        const [r, g, b] = engine.getPixel(x, y);
        total++;
        if (r > 90 && r > g * 1.25 && r > b * 1.25) fleshy++;
      }
    }
    return total > 0 ? fleshy / total : 0;
  }

  // ── Stuck detection ───────────────────────────────────────────────────────
  let _stuckSignature = -1;
  let _lastSignatureChangeAt = 0;

  function centerSignature() {
    const w = engine.width;
    const h = engine.height;
    if (!w || !h) return 0;

    const startX = Math.floor((w - STUCK_CENTER_COLS) / 2);
    const startY = Math.floor((h - STUCK_CENTER_ROWS) / 2);
    const stepX = Math.max(1, Math.floor(STUCK_CENTER_COLS / 16));
    const stepY = Math.max(1, Math.floor(STUCK_CENTER_ROWS / 8));

    let sum = 0;
    for (let y = startY; y < startY + STUCK_CENTER_ROWS && y < h; y += stepY) {
      for (let x = startX; x < startX + STUCK_CENTER_COLS && x < w; x += stepX) {
        const [r, g, b] = engine.getPixel(x, y);
        sum += r + g + b;
      }
    }
    return sum;
  }

  // ── Bot state ─────────────────────────────────────────────────────────────
  let _lastNow             = 0;
  let _inGame              = false;
  let _notInGameSince      = 0;      // ms when we first noticed NOT in-game
  let _lastStartRetryAt    = 0;
  let _startSeqPhase       = 0;      // 0=idle, 1=first-enter-sent, 2=second-enter-sent, 3=third-enter-sent
  let _startSeqScheduled   = false;

  let _lastDecisionAt      = 0;
  let _forwardDown         = false;
  let _lastWanderAt        = 0;
  let _wanderTurnKey       = null;
  let _wanderStopAt        = 0;
  let _lastWanderDirection = 0;      // -1=left, 1=right

  let _stuckTurning        = false;
  let _stuckTurnStopAt     = 0;

  let _firingBurst         = false;
  let _fireBurstStopAt     = 0;
  let _fireReleaseStopAt   = 0;
  let _inFireRelease       = false;

  let _lastUseAt           = 0;
  let _lastEnterAt         = 0;
  let _lastRushAt          = 0;

  // ── Release all held keys ─────────────────────────────────────────────────
  function releaseAll() {
    engine.pushKey(0, KEY_UPARROW);
    engine.pushKey(0, KEY_LEFTARROW);
    engine.pushKey(0, KEY_RIGHTARROW);
    engine.pushKey(0, KEY_FIRE);
    _forwardDown = false;
    _wanderTurnKey = null;
    _firingBurst = false;
    _inFireRelease = false;
    _stuckTurning = false;
  }

  // ── Start sequence (title → in-game) ─────────────────────────────────────
  function runStartSequence(nowMs) {
    if (_startSeqScheduled) return;
    _startSeqScheduled = true;
    _startSeqPhase = 1;

    // Tap ENTER → wait → tap ENTER (New Game) → wait → tap ENTER (skill select)
    tap(KEY_ENTER, nowMs);
    scheduleKey(START_SEQ_STEP_MS, () => {
      tap(KEY_ENTER, _lastNow);
    });
    scheduleKey(START_SEQ_STEP_MS * 2, () => {
      tap(KEY_ENTER, _lastNow);
      _startSeqScheduled = false;
    });
  }

  // ── Main update ───────────────────────────────────────────────────────────
  function update(nowMs, aggressive) {
    _lastNow = nowMs;

    // Always flush pending key queue first
    flushKeyQueue(nowMs);

    // Initialize signature tracker on first call
    if (_lastSignatureChangeAt === 0) _lastSignatureChangeAt = nowMs;
    if (_notInGameSince === 0) _notInGameSince = nowMs;

    // Check game state
    const prevInGame = _inGame;
    _inGame = isInGame();

    if (!_inGame) {
      if (prevInGame) {
        // Just left game state (death / intermission)
        releaseAll();
        _notInGameSince = nowMs;
      }

      // If not in-game for > threshold → run start sequence
      if (nowMs - _notInGameSince > NOT_IN_GAME_THRESHOLD_MS) {
        if (!_startSeqScheduled && nowMs - _lastStartRetryAt > START_RETRY_INTERVAL_MS) {
          _lastStartRetryAt = nowMs;
          runStartSequence(nowMs);
        }
      }
      return;
    }

    // Just entered game
    if (!prevInGame) {
      _notInGameSince = nowMs;
      _lastDecisionAt = nowMs;
      _lastWanderAt = nowMs;
      _lastUseAt = nowMs;
      _lastEnterAt = nowMs;
      _lastRushAt = nowMs;
      _stuckSignature = centerSignature();
      _lastSignatureChangeAt = nowMs;
    }

    // ── Decision cadence ─────────────────────────────────────────────────
    if (nowMs - _lastDecisionAt < DECISION_INTERVAL_MS) return;
    _lastDecisionAt = nowMs;

    // ── Stuck detection ───────────────────────────────────────────────────
    const sig = centerSignature();
    const sigDelta = Math.abs(sig - _stuckSignature);
    if (sigDelta > STUCK_DELTA_THRESHOLD) {
      _stuckSignature = sig;
      _lastSignatureChangeAt = nowMs;
    }

    const isStuck = (nowMs - _lastSignatureChangeAt) > STUCK_THRESHOLD_MS;

    if (isStuck && !_stuckTurning) {
      // Start unstick maneuver
      engine.pushKey(0, KEY_UPARROW);
      _forwardDown = false;
      _stuckTurning = true;
      _lastWanderDirection = -_lastWanderDirection || 1;
      const turnKey = _lastWanderDirection > 0 ? KEY_RIGHTARROW : KEY_LEFTARROW;
      engine.pushKey(1, turnKey);
      _wanderTurnKey = turnKey;
      const holdMs = STUCK_TURN_MIN_MS + Math.random() * (STUCK_TURN_MAX_MS - STUCK_TURN_MIN_MS);
      _stuckTurnStopAt = nowMs + holdMs;
      _lastSignatureChangeAt = nowMs + STUCK_THRESHOLD_MS; // reset detector
    }

    if (_stuckTurning) {
      if (nowMs >= _stuckTurnStopAt) {
        // End unstick turn, resume forward
        if (_wanderTurnKey) { engine.pushKey(0, _wanderTurnKey); _wanderTurnKey = null; }
        _stuckTurning = false;
        engine.pushKey(1, KEY_UPARROW);
        _forwardDown = true;
      }
      // During stuck-turn: no other decisions
      periodicTaps(nowMs);
      return;
    }

    // ── Monster detection and fire ────────────────────────────────────────
    const ratio = monsterRatio();
    const threshold = aggressive ? MONSTER_THRESHOLD_AGG : MONSTER_THRESHOLD_NORMAL;
    const monsterSeen = ratio > threshold;

    if (monsterSeen) {
      // Stop turning when monster detected
      if (_wanderTurnKey) { engine.pushKey(0, _wanderTurnKey); _wanderTurnKey = null; }

      if (!_firingBurst && !_inFireRelease) {
        engine.pushKey(1, KEY_FIRE);
        _firingBurst = true;
        _fireBurstStopAt = nowMs + FIRE_HOLD_MS;
      }

      if (_firingBurst && nowMs >= _fireBurstStopAt) {
        engine.pushKey(0, KEY_FIRE);
        _firingBurst = false;
        _inFireRelease = true;
        _fireReleaseStopAt = nowMs + FIRE_RELEASE_MS;
      }

      if (_inFireRelease && nowMs >= _fireReleaseStopAt) {
        _inFireRelease = false;
      }
    } else {
      // No monster: stop any fire burst
      if (_firingBurst) {
        engine.pushKey(0, KEY_FIRE);
        _firingBurst = false;
      }
      _inFireRelease = false;
    }

    // ── Aggressive rush ───────────────────────────────────────────────────
    if (aggressive) {
      const rushInterval = RUSH_INTERVAL_MS;
      if (nowMs - _lastRushAt > rushInterval) {
        _lastRushAt = nowMs;
        // Forward burst + fire
        if (!_forwardDown) { engine.pushKey(1, KEY_UPARROW); _forwardDown = true; }
        engine.pushKey(1, KEY_FIRE);
        scheduleKey(400, () => { engine.pushKey(0, KEY_FIRE); });
      }
    }

    // ── Forward movement ──────────────────────────────────────────────────
    if (!_forwardDown) {
      engine.pushKey(1, KEY_UPARROW);
      _forwardDown = true;
    }

    // ── Wander turns ──────────────────────────────────────────────────────
    const wanderMin = aggressive ? WANDER_AGG_MIN_INTERVAL_MS : WANDER_MIN_INTERVAL_MS;
    const wanderMax = aggressive ? WANDER_AGG_MAX_INTERVAL_MS : WANDER_MAX_INTERVAL_MS;

    if (!_wanderTurnKey && !monsterSeen) {
      if (nowMs - _lastWanderAt > wanderMin + Math.random() * (wanderMax - wanderMin)) {
        _lastWanderAt = nowMs;
        // Pick direction (alternate bias)
        _lastWanderDirection = -_lastWanderDirection || (Math.random() > 0.5 ? 1 : -1);
        const turnKey = _lastWanderDirection > 0 ? KEY_RIGHTARROW : KEY_LEFTARROW;
        engine.pushKey(1, turnKey);
        _wanderTurnKey = turnKey;
        const holdMs = WANDER_MIN_HOLD_MS + Math.random() * (WANDER_MAX_HOLD_MS - WANDER_MIN_HOLD_MS);
        _wanderStopAt = nowMs + holdMs;
      }
    } else if (_wanderTurnKey && nowMs >= _wanderStopAt) {
      engine.pushKey(0, _wanderTurnKey);
      _wanderTurnKey = null;
    }

    // ── Periodic taps (USE, ENTER) ────────────────────────────────────────
    periodicTaps(nowMs);
  }

  function periodicTaps(nowMs) {
    if (nowMs - _lastUseAt > USE_INTERVAL_MS) {
      _lastUseAt = nowMs;
      tap(KEY_USE, nowMs);
    }
    if (nowMs - _lastEnterAt > ENTER_INTERVAL_MS) {
      _lastEnterAt = nowMs;
      tap(KEY_ENTER, nowMs);
    }
  }

  // ── Suspend / Resume (user-controller handoff) ───────────────────────────
  // The daemon calls suspend() when the user takes the wheel and resume()
  // when the user releases control (stale heartbeat or clean exit).

  /** Whether the bot is currently suspended. */
  let _suspended = false;

  /**
   * Suspend the bot: release every key it currently holds and clear pending
   * queued events. The bot will not issue any pushKey calls until resume().
   */
  function suspend() {
    if (_suspended) return;
    _suspended = true;
    // Release all keys the bot may currently be holding
    releaseAll();
    // Drain the key queue so no pending events fire after the handoff
    keyQueue.length = 0;
  }

  /**
   * Resume the bot: re-arm so the next update() call continues normally.
   * The bot's in-game detection and state machine pick up from wherever they
   * left off — no explicit reset is needed (the game state is unchanged).
   */
  function resume() {
    _suspended = false;
  }

  // ── Dispose ───────────────────────────────────────────────────────────────
  function dispose() {
    try { releaseAll(); } catch { /* engine may be gone */ }
    keyQueue.length = 0;
    _suspended = false;
  }

  return { update, dispose, suspend, resume };
}
