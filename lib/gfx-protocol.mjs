/**
 * gfx-protocol.mjs — terminal graphics protocol helpers.
 *
 * Supports two protocols:
 *   - iTerm2 inline images (OSC 1337) — used by iTerm2 and WezTerm.
 *   - Kitty graphics protocol (APC) — used by Kitty and compatible terminals.
 *
 * Both protocols embed a PNG (or other image format) directly in the terminal
 * output stream, replacing character-cell rendering with a rasterized image.
 */

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
