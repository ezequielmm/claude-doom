# claude-doom — Handoff Completo

> **Estado:** v0.9.0-wip · 35/35 tests core + 4 suites standalone en verde · publicado en
> [github.com/ezequielmm/claude-doom](https://github.com/ezequielmm/claude-doom)
> **Último commit:** `99b9673` (wip: compositor groundwork)
> **Fecha:** 2026-06-12 · **Máquina origen:** MacBook Air (macOS, Node 22, Warp + Apple Terminal)
> **Pensado para:** retomar el proyecto en otra PC sin contexto previo.

Este documento es el traspaso completo: qué se construyó, cómo funciona, qué anda y qué no
(con la cruda realidad), las trampas descubiertas (¡hay un campo minado de Tcl documentado!),
y **las especificaciones completas de las DOS piezas que siguen**: el compositor universal
(fullscreen full-fps en CUALQUIER terminal) y la captura de input del usuario en cualquier
terminal.

---

## 1. Resumen ejecutivo

`claude-doom` (plugin interno: `afk-arcade`) corre **DOOM real** (doomgeneric compilado a
WASM) dentro de Claude Code CLI. Cero dependencias npm en runtime (assets GPL se vendorizan
con `fetch-doom`). Las superficies, de menor a mayor ambición:

| Superficie | Estado | Terminal |
| --- | --- | --- |
| Banner statusline (quad-blocks, 1fps, hooks de estado) | ✅ 100% | cualquiera |
| Player fullscreen interactivo (`play.mjs`, ~20fps texto) | ✅ 100% | cualquiera |
| Player pixel-perfect (`play.mjs --gfx`, 1280×800 PNG, ~125fps) | ✅ 100% | Warp/kitty/WezTerm/iTerm2 |
| **Backdrop**: juego de FONDO de toda la terminal, Claude flotando encima | ✅ 24fps | Warp/kitty (z=-2) |
| Bot heurístico que juega solo (autopilot / agresivo si Claude trabaja) | ✅ | — |
| `/doom`: Claude juega con visión (lee frame → narra → actúa) | ✅ | — |
| Controller sidecar (pestaña aparte, tu teclado → marine) | ✅ | cualquiera |
| Wrapper F8 (`doomclaude.mjs`: una tecla toma el control en la misma ventana) | ⚠️ ver §5 | — |
| **Compositor universal** (backdrop en CUALQUIER terminal) | 🔜 **§4 — LA CONTINUACIÓN** | cualquiera |

---

## 2. Arquitectura (mapa de módulos)

```
Claude Code
│
├── hooks (hooks/hooks.json → scripts/hook.mjs)         máquina de estados
│     UserPromptSubmit=working · Stop=idle · Notification idle_prompt=afk
│     escribe $TMPDIR/afk-arcade/sessions/<sid>.json
│
├── statusline (~/.claude/afk-arcade/statusline.sh → scripts/statusline.mjs, poll 1s)
│     · banner quad (lib/render.mjs renderQuadrants + postfx) ← frame.ans
│     · auto-spawn del daemon (spawn-lock, 30s staleness)
│     · registro de tty para backdrop (lib/registry.mjs → tty-registry.json)
│     · auto-degrade: backdrop solo en terminales kitty; resto → banner quad
│     · telemetría JSONL (lib/debug.mjs → ~/.claude/afk-arcade/debug.log)
│
├── daemon (scripts/daemon.mjs — singleton por UNIX SOCKET, kernel-arbitrado)
│     · engine WASM (lib/doom-engine.mjs: HEAPU32 vía patch en memoria del glue,
│       dims auto-detect 1280×800, getFrameRGB 1.5ms)
│     · escribe frame.ans (quad) + backdrop.png (dimmed) + frame.rgb (WIP crudo)
│     · streamea backdrop a ttys registradas: kitty t=f (RUTA del archivo,
│       ~120 bytes atómicos — JAMÁS payload inline a alta frecuencia, ver §6)
│     · bot (lib/doom-bot.mjs) + ownership user|bot (control.json)
│     · auto-recycle: output congelado >90s, vida >30min, RSS >450MB
│
├── control (scripts/control.mjs)
│     · modo interactivo (pestaña sidecar) y --stdin-bridge (para wrappers)
│     · escribe control.json {heartbeat, held[], taps[]} — el daemon arbitra
│
└── wrappers
      · scripts/doomclaude.mjs — F8/Ctrl+] toggle vía expect (⚠️ §5)
      · scripts/doomscreen.mjs — NO EXISTE AÚN: el compositor universal (§4)
```

**Config:** `~/.claude/afk-arcade/config.json` — `game, rows(2..40), aspect(4:3|16:10|stretch),
style(quad|half|pixel), backdrop(bool), backdropDim(0.4), backdropFps(5..35), bot(bool), debug(bool)`.
CLI: `/afk` (afk-ctl.mjs): `status|on|off|game|rows|aspect|style|backdrop|bot|debug|act|setup|control|play|fetch-doom`.

**Instalación en PC nueva:** `claude plugin marketplace add ezequielmm/claude-doom` →
`claude plugin install afk-arcade@afk-arcade-marketplace` → reiniciar Claude Code (el hook
auto-setup cablea statusline + config + baja assets DOOM). Guiado: `/afk setup`.

---

## 3. Qué funciona / qué no (cruda realidad)

✅ **Verificado en vivo** (capturas + telemetría): banner quad en Apple Terminal y Warp ·
backdrop 24fps en Warp con Claude flotando encima · bot jugando (combate real, HUD cambiando) ·
ownership user↔bot en ambas direcciones · `/doom` (act → owner:user → marine se mueve) ·
player pixel 125fps en Warp (probe runtime `gfx:kitty(probe)`).

❌ **Límites de plataforma (no son bugs):**
- Statusline de Claude Code: refresco mínimo 1s (documentado) — el banner JAMÁS pasará de ~1fps.
- Apple Terminal: sin protocolo kitty → sin backdrop de píxeles ahí. Por eso §4.
- Warp NO implementa kitty Unicode placeholders (U=1) — el "pixel banner" (style pixel)
  renderiza glifos verdes ahí. Funciona(ría) en kitty/WezTerm/Ghostty. Claude Code pasa
  los placeholders fielmente (verificado) — se enciende solo cuando Warp shippee U=1.
- Los procesos statusline NO tienen tty de control (`/dev/tty` → ENXIO). El workaround
  que funciona: descubrir la tty del ancestro vía `ps -o ppid=,tty=` (walk del árbol).

⚠️ **Abierto:** el drill E2E del wrapper F8 con claude REAL falla (con `sleep` como
comando envuelto pasa 100%). Detalle y plan en §5.

---

## 4. CONTINUACIÓN A — Compositor universal (fullscreen full-fps en CUALQUIER terminal)

**Objetivo:** DOOM como fondo de TODA la terminal con Claude Code flotando encima, a
~15-20fps, **en cualquier terminal** (Apple Terminal incluida) — sin protocolos gráficos:
composición de CELDAS DE TEXTO.

**El groundwork YA ESTÁ COMMITEADO** (`99b9673`):
- `lib/render.mjs` exporta **`renderQuadCell(px4, truecolor)`** — el núcleo por-celda
  extraído de `renderQuadrants` (output byte-idéntico, tests de paridad en verde).
- `scripts/daemon.mjs` tiene +34 líneas de salida de frame crudo (revisar/terminar:
  la idea es `frame.rgb` binario `[u16 w][u16 h][RGB...]` escalado+dimmed al viewport,
  escrito atómico junto a frame.ans cuando un archivo `raw-request.json` fresco <30s existe).

**Arquitectura completa a construir — `scripts/doomscreen.mjs`:**

1. **PTY sin dependencias** — truco verificado en esta máquina: macOS `script` FALLA con
   stdin pipe (`tcgetattr: not supported on socket`) pero **funciona con stdin heredado**:
   ```js
   spawn('/usr/bin/script', ['-q', '/dev/null', 'claude', ...args],
         { stdio: ['inherit', 'pipe', 'inherit'] })
   ```
   - Teclado del usuario: fluye NATIVO (tty real → script → pty de claude). Cero intercepción.
   - Output de claude: llega por `child.stdout` — NUESTRO para parsear. Claude nunca pinta
     la pantalla real directamente.
   - Resize: reenviar SIGWINCH al hijo (`process.kill(child.pid, 'SIGWINCH')`); verificar
     empíricamente si script lo propaga al pty; fallback documentar re-exec.

2. **Terminal virtual** — vendorizar **@xterm/headless** (MIT) con `scripts/fetch-xterm.mjs`
   siguiendo EXACTO el patrón de fetch-doom (tarball del registry npm → `vendor/xterm/`,
   gitignored, validar instanciando Terminal). El compositor lo carga con createRequire;
   si falta → mensaje "corré fetch-xterm". Integrar a `lib/setup-core.mjs` (ensureXterm).
   Alimentar cada chunk de `child.stdout` a `term.write(chunk)`.

3. **Frames del juego** — NO bootear engine en el wrapper: reusar el daemon.
   El compositor escribe `viewport.json` al tamaño FULL de la terminal y mantiene fresco
   `raw-request.json`; lee `frame.rgb` (mtime-checked).

4. **Loop compositor (~15fps, env AFK_DOOMSCREEN_FPS 5..20):**
   - Por celda (c, r): base = `renderQuadCell` sobre los 2×2 px en (2c, 2r) del frame.rgb.
   - Capa Claude: `term.buffer.active.getCell(c, r)` — si la celda tiene carácter no-espacio
     O fondo no-default → **GANA CLAUDE**: renderizar su char con su fg, y **bg 49**
     (default oscuro) como "halo" de legibilidad sobre el juego. Espacio+bg-default =
     transparente → se ve el juego.
   - Mapear colores xterm (default/256/RGB) → SGR. Diff renderer: grilla anterior vs nueva,
     emitir solo celdas cambiadas (posicionamiento + SGR batcheado por runs), envuelto en
     sync-output `\x1b[?2026h/l` (terminales sin soporte lo ignoran).
   - **Cursor real = cursor virtual de claude** (`buffer.active.cursorX/Y`) tras cada flush,
     + visibilidad. Esto es CRÍTICO para que el input box de claude se sienta nativo.
   - Escribir a `/dev/tty` (fd abierto una vez) — no a stdout.
   - Alt-screen al entrar (`\x1b[?1049h`), restauración COMPLETA al salir (exit code de claude).

5. **Presupuesto:** 235×68 ≈ 16k celdas; recompute solo celdas cambiadas; full-paint ≤35ms
   aceptable a 15fps. `renderQuadrants` hace 160×60 en 10-15ms — alcanza.

6. **Controles/UX:** `afk-ctl screen` imprime el comando de lanzamiento. README sección
   "Universal backdrop". Tests: paridad renderQuadCell (ya existe), compose() puro
   (precedencia claude-gana / transparencia), frame.rgb writer (namespace aislado),
   vendor xterm carga + 'h' en (0,0). Version 0.9.0.

---

## 5. CONTINUACIÓN B — Captura de input del usuario en cualquier terminal

**Estado actual (`scripts/doomclaude.mjs`, wrapper F8 vía expect):**
- E2E COMPLETO en verde con comando falso (`AFK_DC_CMD=sleep`): F8/Ctrl+] → drive →
  W sostenida → bridge → control.json `held:[173]` → daemon → marine. Arnés:
  expect-sobre-expect + polling de control.json cada 100ms (patrón en §7).
- ❌ **MISTERIO ABIERTO:** el mismo drill con **claude real** falla (toggle a los 18s tras
  boot + W's → ningún held). Hipótesis a investigar en orden:
  1. El boot de claude (~14-20s con MCPs) — ¿el toggle llegó antes de que interact estuviera
     en chat-mode estable? Instrumentar: marcadores `exec sh -c "echo X >> /tmp/trace"` en
     las ACCIONES de los toggles (¡no comentarios dentro de interact! — ver minas §6).
  2. Claude emite DA/CPR queries y secuencias que podrían interferir con el matching de
     patrones de interact en el lado usuario (¿colisión de buffer?).
  3. Probar toggle DESPUÉS de boot completo + tipeo previo (¿estado del interact?).
- **Piezas que YA funcionan y se reusan:** `control.mjs --stdin-bridge` (raw-mode self-set,
  sentinel `\x00\x01` release SIN exit — el wrapper es dueño del ciclo de vida),
  `AFK_ARCADE_REAL_TTY` exportada por el wrapper (la statusline la prefiere → el daemon
  streamea DIRECTO a la terminal real → el juego nunca se congela aunque claude pause).

**Visión unificada (recomendada):** cuando exista el compositor (§4), absorber ahí la
captura de input y RETIRAR el wrapper expect. En el compositor v2:
- Cambiar stdin de 'inherit' a 'pipe' rompe `script` (tcgetattr) → opciones:
  (a) PTY del compositor vía expect SOLO como creador de pty (sin interact — el compositor
  lee/escribe los streams), (b) leer el teclado de `/dev/tty` en raw desde el compositor
  y escribir al stdin de script... CUIDADO: dos lectores del mismo tty se roban bytes —
  el compositor debe ser EL ÚNICO lector (stdin: 'pipe' + alimentar manualmente, volviendo
  al problema (a)). La opción (a) es la sólida: expect crea el pty y un par de FIFOs;
  el compositor (node) maneja TODO el I/O por los FIFOs. F8/teclas de juego se deciden
  en NODE (cero Tcl = cero minas).
- Con input en node: F8 togglea ownership directo (escribir control.json desde el
  compositor — ni bridge hace falta), y las teclas de juego van al daemon vía control.json.

---

## 6. Trampas y gotchas (NO REPETIRLAS — costaron horas)

**Campo minado Tcl/expect (3 minas verificadas con bisección de 7 rondas):**
1. `Buffer.prototype.map` es TypedArray.map: coerciona los strings del callback a NÚMEROS
   → el patrón F8 quedó `"00000"`. Usar `Array.from(buffer).map(...)`.
2. **Comentarios DENTRO de la lista de cláusulas de `interact` NO son comentarios** — cada
   palabra se parsea como patrón/acción y revuelve el cableado (los toggles medio-funcionan,
   el relay por defecto MUERE). Comentarios SIEMPRE fuera del cuerpo de interact.
3. **`send_user` dentro de una ACCIÓN de interact** corrompe el relay del siguiente interact
   (la campanita `\a` fue el veneno final). Acciones = solo `set`/`return`.
   Además: cláusulas `-i`/`-input` o `expect_background` coexistiendo TAMBIÉN matan el relay
   implícito user→spawn. Drive mode = interact PELADO (solo patrones + eof).

**PTY/procesos:**
- macOS `script` exige stdin tty (pipe → "tcgetattr: not supported on socket").
  Arneses headless de PTY: expect-sobre-expect.
- Los spawns de expect crean ptys en modo CANÓNICO con echo — un proceso node que lea
  stdin de ahí debe `setRawMode(true)` si isTTY (el bridge lo hace).
- `pgrep/pkill -f` con ruta ABSOLUTA no matchea procesos lanzados con ruta relativa
  (`node scripts/daemon.mjs`) — los "daemons fantasma" invisibles costaron una hora.
  Patrón laxo + inspección.
- Singleton de daemon: SOLO socket UNIX (bind kernel-arbitrado + double-probe antes de
  robar + autodefensa por inode + cleanup con guarda de dueño). Los pidfiles puros
  tienen carreras de lectura-durante-escritura irreparables.

**Protocolos gráficos:**
- Transmisión kitty inline (t=d) a ALTA frecuencia por una tty compartida con Claude Code
  → los chunks APC se entrelazan con las escrituras de claude → terminadores perdidos →
  VÓMITO base64 en pantalla. La solución: **t=f** (el APC lleva solo la RUTA del PNG,
  ~120 bytes, escritura atómica) + archivo reemplazado con rename atómico.
- Warp: minimum-contrast fuerza a blanco los fg≈bg (el "laberinto") → colapso de celdas
  de bajo contraste a espacio coloreado en el renderer (hecho). Imágenes reemplazadas por
  id PUEDEN acumularse → delete-image cada 45s (hecho).
- El framebuffer del build opentui-doom es **1280×800, NO 320×200** — dims auto-detect
  por correlación vertical + fast-path por tamaño de wasm (381,189 bytes).
- El engine se CUELGA en frame estático tras ~20-25min (attract loop) → auto-recycle
  por firma de frame congelada (hecho).

**Warp:**
- `warp://launch/<path>` se DEDUPLICA POR NOMBRE de config por vida de la app → SIEMPRE
  nombres timestampeados. En cold-start el primer URI se pierde. Las pestañas a veces
  no ejecutan el comando (controller murió ahí; manual = confiable).

**Claude Code:**
- statusline: hijos sin tty (ENXIO), env SÍ pasa (TERM_PROGRAM/COLORTERM/COLUMNS/LINES),
  multi-línea OK, refresco mínimo 1s. Hooks: stdout de UserPromptSubmit SE INYECTA al
  contexto — scripts de hooks SIEMPRE silenciosos.
- plugin.json NO debe referenciar hooks/hooks.json explícito (doble carga = plugin muerto).
- El shim de statusline necesita ruta ABSOLUTA de node (process.execPath).

---

## 7. Cómo correr / probar / debuggear

```sh
node test/run.mjs            # suite integrada (fases A-H, 35 tests)
node test/gfx.test.mjs       # + render, setup, debug, bot, control, wrapper standalone
claude plugin validate .

/afk status                  # config + sesiones vivas
/afk debug on && /afk debug tail 30    # telemetría JSONL (statusline + daemon + stream)
AFK_DC_DEBUG=1               # doomclaude conserva el Tcl generado y loguea la ruta
AFK_DC_CMD=sleep             # doomclaude envuelve otro comando (drills)

# Arnés E2E del wrapper (patrón verificado):
/usr/bin/expect -c 'spawn node scripts/doomclaude.mjs; sleep 14; send "\x1d"; ...'
# + polling: rg -q '"held":\[173' $TMPDIR/afk-arcade/doom/control.json cada 100ms
```

Artefactos runtime: `$TMPDIR/afk-arcade/` → `sessions/`, `doom/{frame.ans, backdrop.png,
frame.rgb(wip), viewport.json, control.json, bot-status.json, daemon.pid, daemon.sock}`,
`tty-registry.json`. Config/logs: `~/.claude/afk-arcade/`.

---

## 8. Licencias

Código MIT (Ezequiel Mora). Engine doomgeneric GPL-2.0 (ozkl) + doom1.wad shareware:
**se descargan con fetch-doom, JAMÁS se commitean** (vendor/ gitignored). WASM prebuilt del
paquete npm opentui-doom (glue MIT). @xterm/headless (MIT) se vendorizará igual. DOOM es
marca de id Software.
