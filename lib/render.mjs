/**
 * render.mjs — framebuffer → ANSI half-block lines
 *
 * Uses the UPPER HALF BLOCK "▀" (U+2580) to pack two pixel rows into one
 * terminal row: top pixel = foreground, bottom pixel = background.
 *
 * Color modes:
 *   truecolor  — \x1b[38;2;R;G;Bm / \x1b[48;2;R;G;Bm  (24-bit)
 *   256-color  — \x1b[38;5;Nm    / \x1b[48;5;Nm        (xterm cube + grayscale)
 */

// ── 256-colour quantisation ───────────────────────────────────────────────────

/**
 * Quantise an [r, g, b] triple to the nearest xterm 256-color index.
 *
 * xterm color layout:
 *   0..15   — system/extended colours (skip)
 *  16..231  — 6×6×6 RGB cube: index = 16 + 36*r' + 6*g' + b', each channel 0..5
 * 232..255  — 24-step grayscale ramp from 8..238
 *
 * @param {number} r  0..255
 * @param {number} g  0..255
 * @param {number} b  0..255
 * @returns {number}  xterm color index 16..255
 */
function rgbTo256(r, g, b) {
  // Check if grayscale is a better fit (channels within 10 of each other)
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && Math.abs(r - b) < 10) {
    const avg = (r + g + b) / 3;
    if (avg < 8) return 16;   // black cube cell
    if (avg > 238) return 231; // white cube cell
    const grayIdx = Math.round((avg - 8) / (238 - 8) * 23);
    return 232 + grayIdx;
  }

  // Map each channel 0..255 → 0..5 (cube step)
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

// ── Core renderer ─────────────────────────────────────────────────────────────

/**
 * Render a pixel buffer as an array of ANSI-coloured half-block strings.
 *
 * Each output line covers two rows of pixels:
 *   pixel row 2r   → foreground (top half)
 *   pixel row 2r+1 → background (bottom half)
 *
 * Sequences are batched: only emit a new fg/bg escape when the colour
 * changes from the previous cell in the same output line.
 *
 * @param {(x: number, y: number) => [number, number, number]} getPixel
 *   Function returning [r, g, b] for pixel at (x, y).
 * @param {number} widthCols  Width of the output in terminal columns.
 * @param {number} heightPxRows  Total pixel height (must be even; rendered as heightPxRows/2 lines).
 * @param {{ truecolor: boolean }} options
 * @returns {string[]}  One string per output row.
 */
export function renderHalfBlocks(getPixel, widthCols, heightPxRows, { truecolor }) {
  const outputRows = Math.floor(heightPxRows / 2);
  const lines = [];

  for (let r = 0; r < outputRows; r++) {
    const topY = r * 2;
    const botY = r * 2 + 1;

    let line = '';
    let prevFgCode = '';
    let prevBgCode = '';

    for (let x = 0; x < widthCols; x++) {
      const [fr, fg, fb] = getPixel(x, topY);
      const [br, bg, bb] = getPixel(x, botY);

      let fgCode, bgCode;

      if (truecolor) {
        fgCode = `\x1b[38;2;${fr};${fg};${fb}m`;
        bgCode = `\x1b[48;2;${br};${bg};${bb}m`;
      } else {
        const fgIdx = rgbTo256(fr, fg, fb);
        const bgIdx = rgbTo256(br, bg, bb);
        fgCode = `\x1b[38;5;${fgIdx}m`;
        bgCode = `\x1b[48;5;${bgIdx}m`;
      }

      // Only emit the escape sequence when the colour changes
      let cell = '';
      if (fgCode !== prevFgCode) { cell += fgCode; prevFgCode = fgCode; }
      if (bgCode !== prevBgCode) { cell += bgCode; prevBgCode = bgCode; }
      cell += '▀';

      line += cell;
    }

    line += '\x1b[0m'; // reset at end of each line
    lines.push(line);
  }

  return lines;
}
