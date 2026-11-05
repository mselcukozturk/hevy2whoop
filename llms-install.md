# hevy2whoop — agent installation

This file is written for an AI agent (Cline, Claude Code, Cursor, Codex) that installs the MCP
server for a user. Follow the steps in order and stop where a human decision is required.

## 1. Requirements

- Node.js >= 24 on the user's machine.
- A Hevy Pro account and an API key (`HEVY_API_KEY`).
- `totem` (the WHOOP bridge) installed and signed in by the user, because WHOOP has no public
  write API: `npm install -g @thebriangao/totem` then `totem auth`.

## 2. Install the MCP server

npm package:

```bash
npx -y hevy2whoop mcp
```

Register it in the client:

```bash
claude mcp add hevy2whoop -e HEVY_API_KEY=<user-key> -- npx -y hevy2whoop mcp
```

Claude Desktop / Cursor / other clients (`claude_desktop_config.json` or MCP settings):

```json
{
  "mcpServers": {
    "hevy2whoop": {
      "command": "npx",
      "args": ["-y", "hevy2whoop", "mcp"],
      "env": {"HEVY_API_KEY": "<user-key>"}
    }
  }
}
```

## 3. Tools

- `hevy2whoop_sync` — arguments `from`, `to` (YYYY-MM-DD, optional) and `write` (default `false`).
  Returns one result per workout: `preview`, `written`, `already_in_whoop`, `nothing_to_write` or
  `error`, plus unmapped and skipped exercises.
- `hevy2whoop_catalog` — argument `search` (optional).

`write` defaults to `false`. Always run a preview first and show it to the user; write only after
the user approves that preview.

## 4. Unmapped exercises

The bundled `mapping.json` covers Hevy's common exercises. If the preview lists unmapped
exercises, offer to map them: copy `mapping.json`, add entries, and point
`HEVY2WHOOP_MAPPING` at the user's file. Never invent a WHOOP exercise id; use
`hevy2whoop catalog <search>` or the totem catalog.

## 5. Boundaries

- The user signs in to WHOOP through totem. Do not ask for WHOOP credentials.
- Do not write to WHOOP without an explicit approval of the preview.
- totem uses WHOOP's private iOS API, which WHOOP's terms do not permit. State this once if the
  user has not read the README.

## Links

- Repository: https://github.com/mselcukozturk/hevy2whoop
- MCP Registry: `io.github.mselcukozturk/hevy2whoop`
