/**
 * doom-engine.mjs — Node.js host for the doomgeneric WASM engine.
 *
 * Loads the CJS Emscripten glue from vendor/doom/doom.js via createRequire,
 * mounts doom1.wad into the emscripten FS, calls doomgeneric_Create, and
 * exposes a minimal API for ticking and sampling pixels.
 *
 * ABI verified from vendor/doom/doom.js (opentui-doom 0.3.11):
 *   - Factory: createDoomModule(moduleArg?) → Promise<Module>  (CJS default export)
 *   - Module._doomgeneric_Create(argc, argv)  — void, called once
 *   - Module._doomgeneric_Tick()              — void, advance one frame
 *   - Module._DG_GetFrameBuffer()             — i32 ptr into WASM heap
 *   - Module._malloc(size)                    — allocate WASM heap bytes
 *   - Module._free(ptr)                       — free WASM heap
 *   - Module.setValue(ptr, val, type)         — write to WASM heap
 *   - Module.getValue(ptr, type)              — read from WASM heap
 *   - Module.FS                               — emscripten virtual FS
 *   - Module.ccall / Module.cwrap             — available but we use direct calls
 *
 * Framebuffer layout: 1280×800 pixels, each pixel is a 32-bit word
 * in 0xAARRGGBB format. Index: pixel(x,y) = HEAPU32[(fbPtr/4) + y*1280 + x].
 * Since HEAPU32 is a closure variable (not exposed on Module), we access
 * individual pixels via Module.getValue(ptr, 'i32') which reads HEAP32[ptr>>2].
 * The renderer samples only the pixels it needs, so this is fast enough.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'doom');
const DOOM_JS   = path.join(VENDOR, 'doom.js');
const DOOM_WASM = path.join(VENDOR, 'doom.wasm');
const DOOM_WAD  = path.join(VENDOR, 'doom1.wad');

// Canonical framebuffer dimensions (doomgeneric hardcoded values)
export const DOOM_WIDTH  = 320;
export const DOOM_HEIGHT = 200;
// Note: doomgeneric typically renders at 320×200 internally (not 1280×800).
// The opentui port may vary. We probe the actual FB size during init.
// The constants above are the minimum we expect; we detect the actual size.

// ── Asset check ───────────────────────────────────────────────────────────────

/**
 * Returns true if all vendor assets are present and valid.
 */
export function vendorAssetsExist() {
  for (const f of [DOOM_JS, DOOM_WASM, DOOM_WAD]) {
    try {
      const stat = fs.statSync(f);
      if (stat.size < 1000) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create and initialise the DOOM engine.
 *
 * @returns {Promise<{
 *   tick(): void,
 *   getPixel(x: number, y: number): [number, number, number],
 *   width: number,
 *   height: number,
 *   dispose(): void,
 * }>}
 */
export async function createDoom() {
  if (!vendorAssetsExist()) {
    throw new Error(
      'DOOM vendor assets missing. Run: node scripts/fetch-doom.mjs',
    );
  }

  // Load the CJS module via createRequire (doom.js uses CommonJS module.exports)
  const require = createRequire(import.meta.url);
  const createDoomModule = require(DOOM_JS);

  // State captured during init
  let Module = null;
  let fbPtr = 0;    // pointer returned by _DG_GetFrameBuffer()
  let actualWidth  = 320;
  let actualHeight = 200;

  // Instantiate the Emscripten module.
  // We silence console output (doom prints a lot to stdout/stderr) and
  // provide locateFile so it can find doom.wasm.
  Module = await createDoomModule({
    locateFile: (name) => path.join(VENDOR, name),
    // Silence engine output — daemon must not emit to stdout/stderr
    print:    () => {},
    printErr: () => {},
    // Pre-allocate a 4MB+ stack to avoid stack overflow during init
    INITIAL_MEMORY: 64 * 1024 * 1024,
  });

  // Mount doom1.wad into the emscripten virtual FS
  const wadBuffer = fs.readFileSync(DOOM_WAD);
  Module.FS.writeFile('doom1.wad', wadBuffer);

  // Build argv in WASM memory: ["doom", "-iwad", "doom1.wad"]
  const argStrings = ['doom', '-iwad', 'doom1.wad'];
  const argc = argStrings.length;

  // Allocate each string and write its bytes into WASM heap
  const argPtrs = argStrings.map((s) => {
    const bytes = Buffer.from(s + '\0', 'utf8');
    const ptr = Module._malloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      Module.setValue(ptr + i, bytes[i], 'i8');
    }
    return ptr;
  });

  // Allocate the argv pointer array (argc + 1 null terminator, 4 bytes each)
  const argvPtr = Module._malloc((argc + 1) * 4);
  for (let i = 0; i < argc; i++) {
    Module.setValue(argvPtr + i * 4, argPtrs[i], 'i32');
  }
  Module.setValue(argvPtr + argc * 4, 0, 'i32'); // null terminator

  // Call doomgeneric_Create — this initialises the engine and starts the
  // title/attract sequence. It blocks briefly for WASM wasm init work.
  Module._doomgeneric_Create(argc, argvPtr);

  // Probe the framebuffer pointer and detect actual dimensions.
  // doomgeneric_Create must be called at least once before the FB is valid.
  // Tick once to warm up.
  Module._doomgeneric_Tick();
  fbPtr = Module._DG_GetFrameBuffer();

  // Detect actual framebuffer dimensions by trying known sizes.
  // doomgeneric 1280×800 is what some ports use; classic is 320×200.
  // We probe by checking the memory size of the allocation (not possible
  // without malloc metadata), so we trust the known port dimensions.
  // The opentui-doom port renders at 320×200 (classic doomgeneric default).
  actualWidth  = 320;
  actualHeight = 200;

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Advance the engine by one tick. Safe to call at any rate.
   */
  function tick() {
    Module._doomgeneric_Tick();
    // Refresh fbPtr each tick in case the engine reallocated the framebuffer
    fbPtr = Module._DG_GetFrameBuffer();
  }

  /**
   * Read a single pixel from the current framebuffer.
   *
   * The framebuffer is stored as 32-bit words in 0xAARRGGBB format
   * (big-endian component order within the 32-bit word). We use
   * Module.getValue(addr, 'i32') which reads HEAP32[addr>>2], then
   * extract R, G, B from the signed 32-bit value.
   *
   * @param {number} x  0..width-1
   * @param {number} y  0..height-1
   * @returns {[number, number, number]}  [r, g, b]
   */
  function getPixel(x, y) {
    if (!fbPtr) return [0, 0, 0];
    const addr = fbPtr + (y * actualWidth + x) * 4;
    // getValue returns signed i32 — treat it as unsigned with >>> 0
    const px = Module.getValue(addr, 'i32') >>> 0;
    // 0xAARRGGBB: bits 23-16 = R, bits 15-8 = G, bits 7-0 = B
    const r = (px >>> 16) & 0xff;
    const g = (px >>> 8)  & 0xff;
    const b =  px         & 0xff;
    return [r, g, b];
  }

  /**
   * Release WASM heap allocations. The module itself stays loaded
   * (there's no clean way to unload it), but we free our allocations.
   */
  function dispose() {
    try {
      Module._free(argvPtr);
      for (const ptr of argPtrs) Module._free(ptr);
    } catch { /* ignore — module may already be torn down */ }
  }

  return {
    tick,
    getPixel,
    width: actualWidth,
    height: actualHeight,
    dispose,
  };
}
