---
description: "Control the afk-arcade banner (on/off, game, rows, status)"
allowed-tools:
  - "Bash(node:*)"
  - "Read"
---

To control the afk-arcade banner, first locate the plugin root:

1. Read the file `~/.claude/afk-arcade/runtime.json`.
   - If the file does not exist, tell the user: "The afk-arcade runtime file is missing. Please restart Claude Code so the plugin's SessionStart hook can initialize it."
   - If it exists, extract the `pluginRoot` field.

2. Run the control CLI with the user's arguments:

```bash
node "<pluginRoot>/scripts/afk-ctl.mjs" $ARGUMENTS
```

3. Show the script's output verbatim.

**Available commands:**

- `/afk status` — show current config and active session modes
- `/afk on` — enable the banner
- `/afk off` — disable the banner
- `/afk game fire` — switch to DOOM PSX fire effect
- `/afk game doom` — switch to DOOM WASM daemon mode (requires Phase B daemon running)
- `/afk rows <N>` — set banner height (2–12 rows)
