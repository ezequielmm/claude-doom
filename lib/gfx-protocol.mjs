/**
 * gfx-protocol.mjs — terminal graphics protocol helpers.
 *
 * Supports two protocols:
 *   - iTerm2 inline images (OSC 1337) — used by iTerm2 and WezTerm.
 *   - Kitty graphics protocol (APC) — used by Kitty and compatible terminals.
 *
 * Both protocols embed a PNG (or other image format) directly in the terminal
 * output stream, replacing character-cell rendering with a rasterized image.
 *
 * Runtime capability probe:
 *   probeKittyGraphics(stdin, stdout, options) — sends a Kitty query and
 *   resolves true only when the terminal responds with an explicit OK.
 */

// ── Runtime Kitty graphics capability probe ──────────────────────────────────

/**
 * Probe whether the terminal speaks the Kitty graphics protocol.
 *
 * Strategy:
 *   1. Send a 1×1 RGB direct-transmission QUERY (a=q) with image id 4242:
 *        \x1b_Gi=4242,a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\
 *      followed immediately by a DA1 device-attributes fence:
 *        \x1b[c
 *      A Kitty-capable terminal replies \x1b_Gi=4242;OK\x1b\\ (or ;E... on error).
 *      Every terminal replies to DA1 with \x1b[?...c.
 *   2. Read response bytes in raw mode.  Stop as soon as either:
 *      - We see \x1b_Gi=4242;OK\x1b\\ → resolve true.
 *      - We see the DA1 reply \x1b[? without having seen a Kitty OK → resolve false.
 *      - timeoutMs elapses → resolve false.
 *   3. Any bytes that are not part of the probe responses are buffered and
 *      returned in the `carryOver` Uint8Array so callers can re-emit them.
 *
 * The function sets stdin to raw mode for the duration of the probe and
 * restores the prior state on return.  If stdin is already in raw mode the
 * caller must manage that itself (pass alreadyRaw: true).
 *
 * @param {NodeJS.ReadStream}  stdin     Readable TTY (or fake duplex in tests).
 * @param {NodeJS.WriteStream} stdout    Writable TTY (or fake duplex in tests).
 * @param {{ timeoutMs?: number, alreadyRaw?: boolean }} [options]
 * @returns {Promise<{ supported: boolean, carryOver: Uint8Array }>}
 */
export async function probeKittyGraphics(stdin, stdout, options = {}) {
  const { timeoutMs = 500, alreadyRaw = false } = options;

  // The exact query + DA1 fence
  const PROBE_SEQ = '\x1b_Gi=4242,a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\\x1b[c';

  // We match against these byte sequences in the response stream.
  // Kitty OK response:     \x1b _ G i = 4 2 4 2 ; O K \x1b \\
  // Kitty error response:  \x1b _ G i = 4 2 4 2 ; E ...  \x1b \\
  // DA1 fence reply:       \x1b [ ?  (CSI ? ...)
  const KITTY_OK_BYTES    = [0x1b, 0x5f, 0x47, 0x69, 0x3d, 0x34, 0x32, 0x34, 0x32, 0x3b, 0x4f, 0x4b]; // \x1b_Gi=4242;OK
  const KITTY_PROBE_BYTES = [0x1b, 0x5f, 0x47, 0x69, 0x3d, 0x34, 0x32, 0x34, 0x32, 0x3b];              // \x1b_Gi=4242;
  const DA1_PREFIX_BYTES  = [0x1b, 0x5b, 0x3f];                                                          // \x1b[?

  return new Promise((resolve) => {
    let settled    = false;
    let rawBuf     = Buffer.alloc(0);   // accumulates all received bytes
    let kittyMatch = 0;                 // progress through KITTY_OK_BYTES
    let kittyAny   = 0;                 // progress through KITTY_PROBE_BYTES (any response)
    let da1Match   = 0;                 // progress through DA1_PREFIX_BYTES
    let inKittyAPC = false;             // currently inside an APC response for id 4242
    let kittyWasOK = false;             // the matched APC response had ;OK

    function finish(supported) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.pause();
      if (!alreadyRaw && stdin.isTTY && typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(false); } catch { /* ignore */ }
      }
      // Bytes not consumed by the probe are carried over for the caller.
      resolve({ supported, carryOver: new Uint8Array(rawBuf) });
    }

    const timer = setTimeout(() => finish(false), timeoutMs);

    function onData(chunk) {
      if (settled) return;

      // Scan each incoming byte for probe-response patterns.
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        rawBuf = Buffer.concat([rawBuf, Buffer.from([b])]);

        // --- Kitty APC response matching ---
        // Phase 1: match KITTY_PROBE_BYTES (\x1b_Gi=4242;)
        if (!inKittyAPC) {
          if (b === KITTY_PROBE_BYTES[kittyAny]) {
            kittyAny++;
            if (kittyAny === KITTY_PROBE_BYTES.length) {
              inKittyAPC = true;
              kittyAny   = 0;
              kittyMatch = KITTY_PROBE_BYTES.length; // already matched through ;
              da1Match   = 0; // reset DA1 if we're inside a kitty APC
            }
          } else {
            kittyAny = (b === KITTY_PROBE_BYTES[0]) ? 1 : 0;
          }
        } else {
          // Phase 2: we're inside the APC response; check for OK suffix or APC terminator
          if (kittyMatch < KITTY_OK_BYTES.length) {
            if (b === KITTY_OK_BYTES[kittyMatch]) {
              kittyMatch++;
              if (kittyMatch === KITTY_OK_BYTES.length) {
                kittyWasOK = true;
              }
            } else {
              // Not ;OK — this is an error response (;E...) or something else; still a kitty reply
              kittyWasOK = false;
            }
          }
          // Detect APC terminator \x1b\\ (ST)
          // We look for ESC \ in the stream while inside APC
          if (b === 0x5c && rawBuf.length >= 2 && rawBuf[rawBuf.length - 2] === 0x1b) {
            // APC response complete
            inKittyAPC = false;
            if (kittyWasOK) {
              finish(true);
              return;
            }
            // Error response — probe spoken but not OK; resolve false when DA1 arrives
          }
        }

        // --- DA1 fence matching (only while not mid-APC) ---
        if (!inKittyAPC) {
          if (b === DA1_PREFIX_BYTES[da1Match]) {
            da1Match++;
            if (da1Match === DA1_PREFIX_BYTES.length) {
              // DA1 reply seen — if no Kitty OK was received, resolve false
              if (!kittyWasOK) {
                finish(false);
                return;
              }
            }
          } else {
            da1Match = (b === DA1_PREFIX_BYTES[0]) ? 1 : 0;
          }
        }
      }
    }

    if (!alreadyRaw && stdin.isTTY && typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(true); } catch { /* ignore */ }
    }

    stdin.resume();
    stdin.on('data', onData);
    stdout.write(PROBE_SEQ);
  });
}

// ── Protocol detection ────────────────────────────────────────────────────────

/**
 * Detect the preferred terminal graphics protocol from the environment.
 *
 * Priority:
 *   1. Explicit override via `override` option (used for --gfx flag).
 *   2. TERM_PROGRAM=iTerm.app or TERM_PROGRAM=WezTerm → 'iterm2'
 *      (WezTerm implements the iTerm2 inline-images protocol).
 *   3. TERM contains 'kitty' OR KITTY_WINDOW_ID is set → 'kitty'
 *   4. Otherwise → null (no protocol detected; fall back to half-blocks).
 *
 * @param {Record<string, string | undefined>} env  process.env or equivalent.
 * @param {{ override?: string }} [options]
 *   override: 'iterm2' | 'kitty' | 'off' | 'auto' — explicit --gfx flag value.
 * @returns {'iterm2' | 'kitty' | null}
 */
export function detectGraphics(env, options = {}) {
  const override = options.override;

  if (override && override !== 'auto') {
    if (override === 'off') return null;
    if (override === 'iterm2') return 'iterm2';
    if (override === 'kitty') return 'kitty';
  }

  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  if (termProgram === 'iterm.app' || termProgram === 'wezterm') {
    return 'iterm2';
  }

  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('kitty') || env.KITTY_WINDOW_ID !== undefined) {
    return 'kitty';
  }

  return null;
}

// ── iTerm2 inline images (OSC 1337) ──────────────────────────────────────────

/**
 * Build an iTerm2 inline-image escape sequence.
 *
 * Protocol: ESC ] 1337 ; File=inline=1;size=N;width=W;height=H;<options>:<base64> BEL
 *
 * The `width` and `height` parameters specify the number of terminal character
 * cells to occupy.  The terminal scales the image to fit while preserving
 * aspect ratio when `preserveAspectRatio=1`.
 *
 * @param {Buffer}  pngBuffer  Raw PNG file bytes.
 * @param {{ widthCells: number, heightCells: number }} options
 * @returns {string}  Complete escape sequence (with surrounding BEL).
 */
export function iterm2Image(pngBuffer, { widthCells, heightCells }) {
  const b64 = pngBuffer.toString('base64');
  return (
    '\x1b]1337;File=inline=1' +
    `;size=${pngBuffer.length}` +
    `;width=${widthCells}` +
    `;height=${heightCells}` +
    ';preserveAspectRatio=1' +
    `:${b64}` +
    '\x07'
  );
}

// ── Kitty graphics protocol (APC) ────────────────────────────────────────────

// Max base64 payload per APC chunk (bytes of base64 text, not binary).
const KITTY_CHUNK_SIZE = 4096;

/**
 * Build a Kitty graphics protocol image transmission sequence.
 *
 * Transmits an image as a series of APC (Application Program Command) chunks.
 * Each chunk is at most KITTY_CHUNK_SIZE base64 characters.
 *
 * APC frame format:
 *   \x1b_G<key=value,...>;<base64-chunk>\x1b\\
 *
 * Key parameters used:
 *   a=T    — action: transmit (display immediately)
 *   f=100  — format: PNG
 *   i=<id> — image ID (reusing the same ID on subsequent frames replaces the image)
 *   q=2    — quiet: suppress OK/error responses
 *   c=<n>  — columns to occupy
 *   r=<n>  — rows to occupy
 *   m=1    — more data follows (all chunks except the last)
 *   m=0    — final chunk (last chunk only)
 *
 * @param {Buffer}  pngBuffer  Raw PNG file bytes.
 * @param {{ cols: number, rows: number, imageId: number }} options
 * @returns {string}  Complete APC sequence (all chunks concatenated).
 */
export function kittyImage(pngBuffer, { cols, rows, imageId }) {
  const b64 = pngBuffer.toString('base64');
  const totalChunks = Math.ceil(b64.length / KITTY_CHUNK_SIZE);
  let result = '';

  for (let i = 0; i < totalChunks; i++) {
    const chunk = b64.slice(i * KITTY_CHUNK_SIZE, (i + 1) * KITTY_CHUNK_SIZE);
    const isLast = i === totalChunks - 1;
    const isFirst = i === 0;
    const m = isLast ? 0 : 1;

    if (isFirst) {
      // First chunk: full header with action, format, id, quiet, cols, rows
      result +=
        `\x1b_Ga=T,f=100,i=${imageId},q=2,c=${cols},r=${rows},m=${m};${chunk}\x1b\\`;
    } else {
      // Continuation chunks: only m flag needed
      result += `\x1b_Gm=${m};${chunk}\x1b\\`;
    }
  }

  return result;
}
