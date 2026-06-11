<h1 align="center">
  <picture>
    <img src="../../captures/title-1280.png" width="680" alt="claude-doom — DOOM real en el statusline de Claude Code" />
  </picture>
  <br />
  claude-doom
</h1>

<p align="center">
  <a href="../../README.md">🇬🇧 English</a> &nbsp;•&nbsp; 🇪🇸 Español
</p>

<h4 align="center">
  DOOM real (doomgeneric WASM) dentro del statusline de <a href="https://claude.com/claude-code">Claude Code</a> —
  fuego mientras Claude trabaja, DOOM en modo demo cuando estás AFK, pantalla completa pixel-perfect en iTerm2/kitty/Warp.
</h4>

<p align="center">
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/licencia-MIT-blue.svg" alt="Licencia MIT" /></a>
  <img src="https://img.shields.io/badge/versión-0.3.1-informational" alt="versión 0.3.1" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/dependencias-cero-success" alt="Cero dependencias" />
  <img src="https://img.shields.io/badge/Claude%20Code-%3E%3D2.1.153-blueviolet" alt="Claude Code >= 2.1.153" />
</p>

<br />

<p align="center">
  <table align="center">
    <tr>
      <td align="center">
        <img src="../../captures/gameplay-1280.png" width="500" alt="Modo pixel-perfect — frames PNG reales de 1280×800 mediante protocolos gráficos de terminal" />
        <br />
        <em>Modo pixel-perfect — frames PNG reales de 1280×800 mediante protocolos gráficos de terminal</em>
      </td>
      <td align="center">
        <img src="../../captures/fire.png" width="200" alt="Banner de fuego PSX" />
        <br />
        <em>Banner de fuego PSX</em>
      </td>
    </tr>
  </table>
</p>

---

## Inicio rápido

```sh
# 1. Instalar el plugin
claude plugin marketplace add ezequielmm/claude-doom
claude plugin install afk-arcade@afk-arcade-marketplace

# 2. Reiniciar Claude Code
```

Eso es todo. En el primer `SessionStart`, el hook de auto-configuración:
- Crea `~/.claude/afk-arcade/config.json` con valores predeterminados orientados a DOOM.
- Escribe `~/.claude/afk-arcade/statusline.sh` (el shim que alimenta el banner).
- Agrega `statusLine` a `~/.claude/settings.json` **solo si no existe ya** — se guarda una copia de respaldo como `settings.json.afk-arcade-backup` antes de cualquier cambio.
- Descarga los assets del motor DOOM en segundo plano (WAD shareware + WASM doomgeneric GPL — descargados bajo demanda, nunca incluidos). El progreso se registra en `~/.claude/afk-arcade/setup.log`.

**Instalador guiado opcional** — también ofrece iTerm2 en macOS para el modo pixel-perfect:

```
/afk setup
```

### Qué se escribe en tu máquina

| Ruta | Qué es | Cuándo |
|---|---|---|
| `~/.claude/afk-arcade/config.json` | Configuración del plugin (game, rows, aspect) | Solo en la primera instalación, nunca se sobreescribe |
| `~/.claude/afk-arcade/statusline.sh` | Shim que ejecuta Claude Code para el banner | Creado/actualizado en SessionStart |
| `~/.claude/afk-arcade/setup.log` | Log de configuración y descarga de assets | Se agrega en SessionStart; se rota al alcanzar 200 KB |
| `~/.claude/settings.json` | Se agrega la clave `statusLine` (si no existe) | Una sola vez; se guarda respaldo antes |
| `~/.claude/settings.json.afk-arcade-backup` | Copia de respaldo de settings.json | Se escribe una vez, nunca se sobreescribe |
| `<plugin>/vendor/doom/` | doom.js, doom.wasm, doom1.wad | Descargados en la primera configuración (en .gitignore) |

<details>
<summary>Configuración manual (si preferís hacerlo vos mismo)</summary>

```sh
# Escribir el shim y los archivos de runtime
node <plugin>/scripts/hook.mjs   # via SessionStart, o ejecutar manualmente una vez

# Descargar los assets DOOM
node <plugin>/scripts/fetch-doom.mjs

# Agregar a ~/.claude/settings.json
```

```json
{
  "statusLine": {
    "type": "command",
    "command": "/bin/bash ~/.claude/afk-arcade/statusline.sh",
    "refreshInterval": 1,
    "padding": 0
  }
}
```

</details>

---

## Los tres modos

### 1. Banner en el statusline

El banner vive en la fila de estado de Claude Code y responde al flujo de eventos del editor mediante una máquina de estados:

| Evento | Estado | Visual |
|---|---|---|
| `UserPromptSubmit` | `working` | Fuego intenso / DOOM rodando |
| `Stop` / `StopFailure` | `idle` | Brasas — "listo, esperándote" |
| `Notification: idle_prompt` | `afk` | Demo attract-mode de DOOM |
| `Notification: permission_prompt` | `attention` | Flash de advertencia amarillo |

Cambia entre el efecto de fuego (`/afk game fire`) y el daemon DOOM en vivo (`/afk game doom`) en cualquier momento.

### 2. Pantalla completa con half-blocks

Juega DOOM de forma interactiva usando caracteres Unicode de medio bloque (`▀`) para renderizar cada frame en cualquier terminal con 256 colores:

```sh
node scripts/play.mjs
```

Controles: `WASD` / teclas de dirección para moverse, `SPACE` para abrir puertas, `F` para disparar, `1`–`7` para cambiar de arma, `ESC` para el menú, `Q` o `Ctrl+C` para salir.

### 3. Modo pixel-perfect

Frames PNG reales de 1280×800 transmitidos a fps adaptativos mediante protocolos gráficos nativos de terminal:

```sh
node scripts/play.mjs --gfx auto
```

El flag `--gfx auto` detecta tu terminal y elige el mejor protocolo. Para terminales no identificadas por variables de entorno (como Warp), se ejecuta automáticamente un probe de capacidades en runtime — el modo pixel se activa si la terminal responde con un OK del protocolo Kitty graphics; en caso contrario se usa texto cuadrante. Usa `--res half` para 640×400 si tu conexión es lenta.

| Terminal | Soporte |
|---|---|
| iTerm2 | Completo (iTerm2 inline images) |
| kitty | Completo (protocolo gráfico de Kitty) |
| WezTerm | Completo (iTerm2 inline images) |
| Warp | **Auto-probe en runtime** — modo pixel si tu build soporta Kitty graphics, texto cuadrante si no |
| Apple Terminal | Fallback a texto cuadrante |

---

## Cómo funciona

```
┌──────────────────────────────────────────────────────────────────┐
│ Claude Code                                                        │
│                                                                    │
│  hooks ──► hook.mjs (máquina de estados)                         │
│              escribe ~/.claude/afk-arcade/{config,runtime}.json  │
│              escribe /tmp/afk-arcade/sessions/<id>.json          │
│              SIGTERM → daemon (limpieza en SessionEnd)           │
│                                                                    │
│  statusLine ──► statusline.mjs (poll 1 fps)                      │
│                   lee estado de sesión                           │
│                   lee frame.ans  ◄── daemon.mjs                  │
│                   si stale → lanza daemon (detached, auto-exit)  │
│                   renderiza half-blocks o delega al protocolo    │
│                   gráfico de terminal                            │
│                                                                    │
│  /afk ──► afk-ctl.mjs                                            │
└──────────────────────────────────────────────────────────────────┘
```

`daemon.mjs` ejecuta doomgeneric compilado a WebAssembly en un proceso Node.js desconectado. Cada ~1 s lee `viewport.json` (dimensiones del terminal desde el statusline), escala el framebuffer 320×200 de DOOM mediante un filtro de caja al tamaño actual del banner y escribe `frame.ans` de forma atómica. Un pidfile evita el doble arranque. El daemon se termina solo tras 10 minutos sin actualizaciones del viewport, o inmediatamente en `SessionEnd`.

`play.mjs --gfx auto` omite el renderer de half-blocks: lee el framebuffer RGB crudo, lo codifica a PNG sin dependencias externas y lo transmite al terminal usando la secuencia de escape de imagen inline apropiada a fps adaptativos.

---

## Renderer

El renderer `quad` (predeterminado) usa los 16 Block Elements de Unicode (▀▄▌▐▘▝▖▗▚▞▛▜▙▟█ y espacio) para empaquetar un quad de 2×2 píxeles en cada celda del terminal — duplicando el detalle horizontal del renderer clásico `▀` sin requerir nada adicional.

Después del downscaling, dos pases de post-procesamiento se aplican automáticamente:
- **Nitidez de bordes** (unsharp mask) — aumenta el contraste local, haciendo más nítidos los pasillos oscuros de DOOM y los bordes del fuego.
- **Tone lift** — expansión de gamma suave + boost de saturación para que la imagen se vea bien en fondos de terminal claros y oscuros.

Cambiá el estilo en cualquier momento:

```sh
/afk style quad   # bloques adaptativos 2×2 (predeterminado)
/afk style half   # half-block clásico ▀
```

---

## Comandos

| Comando | Descripción |
|---|---|
| `/afk status` | Mostrar configuración y modos de sesión activos |
| `/afk on` / `/afk off` | Activar o desactivar el banner |
| `/afk game fire` | Efecto de fuego PSX de DOOM (predeterminado) |
| `/afk game doom` | Frames del daemon DOOM WASM (lanza el daemon automáticamente) |
| `/afk rows <N>` | Altura del banner, 2–30 filas |
| `/afk aspect <4:3\|16:10\|stretch>` | Relación de aspecto del frame (predeterminado: `4:3`) |
| `/afk style <quad\|half>` | Estilo del renderer: `quad` (bloques 2×2, predeterminado) o `half` (clásico `▀`) |
| `/afk play` | Lanzar DOOM en una pestaña Warp (macOS + Warp instalado); si no, imprimir el comando |
| `/afk fetch-doom` | Descargar los assets DOOM WASM en `vendor/` |
| `/afk setup [--yes] [--no-iterm]` | Instalador guiado — conecta statusline, descarga assets, ofrece iTerm2 |

---

## Configuración

`~/.claude/afk-arcade/config.json` se escribe en el primer `SessionStart` y persiste entre reinicios.

| Clave | Valor por defecto | Descripción |
|---|---|---|
| `enabled` | `true` | Interruptor principal de activación |
| `game` | `"fire"` | Modo de juego activo (`fire` o `doom`) |
| `rows` | `5` | Altura del banner en filas de terminal |
| `aspect` | `"4:3"` | Relación de aspecto de los frames DOOM |
| `style` | `"quad"` | Estilo del renderer: `quad` (bloques 2×2 adaptativos) o `half` (clásico `▀`) |

Edita el archivo directamente o usa los comandos `/afk` — escriben de inmediato.

---

## Requisitos del sistema

- **Node.js** >= 20
- **Claude Code** >= 2.1.153
- **Terminal** — truecolor recomendado (fallback a 256 colores automático)
- **Modo pixel-perfect** — requiere iTerm2, kitty o WezTerm

---

## Solución de problemas

**No aparece el banner en el statusline**
Ejecuta `claude plugin list` y confirma que `afk-arcade` está activo. Verifica que `statusLine.command` en tu configuración apunte a `~/.claude/afk-arcade/statusline.sh`.

**"doom: daemon offline" o "doom: warming up"**
El daemon necesita unos segundos para iniciarse. Si permanece offline, verifica que los assets de DOOM estén presentes:
```sh
node scripts/fetch-doom.mjs
```

**Assets faltantes / descarga falla**
`fetch-doom.mjs` descarga desde el registro npm de `opentui-doom` (sin npm install — usa el tarball CDN directamente). Verifica tu conexión de red y reintenta.

**Ejecutar el conjunto de pruebas**
```sh
node test/run.mjs
```

Las pruebas específicas de DOOM se omiten automáticamente si los assets de `vendor/doom/` no están presentes.

---

## Hoja de ruta

Consulta [ROADMAP.md](../../ROADMAP.md) para el plan completo, incluyendo emuladores de NES y Game Boy y un SDK para juegos de banner amplio.

---

## Desarrollo

```sh
# Ejecutar el conjunto completo de pruebas (las pruebas DOOM se omiten si faltan assets)
node test/run.mjs

# Ejecutar las pruebas de protocolo gráfico
node test/gfx.test.mjs

# Generar nuevas capturas desde un daemon en ejecución
node scripts/capture.mjs
```

---

## Contribuciones

Los reportes de errores y solicitudes de funcionalidades son bienvenidos mediante [GitHub Issues](https://github.com/ezequielmm/claude-doom/issues).

Los pull requests deben:
- Mantener la restricción de cero dependencias (sin `node_modules`, sin deps en `package.json`)
- Pasar `node test/run.mjs` antes de enviar
- Seguir commits convencionales (`feat:`, `fix:`, `chore:`, `docs:`)

---

## Licencia y créditos

El código de este plugin se publica bajo la [Licencia MIT](../../LICENSE).

**Aviso legal importante:** El motor doomgeneric (GPL-2.0, por [ozkl](https://github.com/ozkl/doomgeneric)) y el WAD shareware de DOOM (`doom1.wad`) se **descargan por separado** mediante `scripts/fetch-doom.mjs` y **nunca se incluyen ni se confirman** en este repositorio. El binario WASM precompilado proviene del paquete npm [opentui-doom](https://www.npmjs.com/package/opentui-doom). DOOM es una marca registrada de id Software, LLC.

---

<p align="center">
  Hecho con cuidado por <strong>Gentleman Programming</strong>
  <br />
  Si esto hizo tu terminal más entretenida, considera darle una ⭐ en <a href="https://github.com/ezequielmm/claude-doom">GitHub</a>.
</p>
