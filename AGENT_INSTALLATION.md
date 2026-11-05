# hevy2whoop: installation instructions for AI agents

This document is for an AI agent (Claude Code, Codex, Cursor, or similar) that a
user has asked to set up hevy2whoop. Follow the steps in order. Every step ends
with a check; do not continue until the check passes. Where a step needs the
user, stop and ask.

The user can start you with:

> Install hevy2whoop for me by following
> https://raw.githubusercontent.com/mselcukozturk/hevy2whoop/main/AGENT_INSTALLATION.md

## Rules

1. **No WHOOP write without approval.** Do not run `sync --write` and do not
   call `hevy2whoop_sync` with `write: true` until you have shown the user the
   preview for exactly those workouts and the user has agreed in this
   conversation. This applies to every date range, including past workouts.
2. **No WHOOP password.** Do not ask for, type, read or store the user's WHOOP
   password or SMS code. `totem auth` is interactive; the user runs it.
3. **The Hevy API key is a secret.** Do not print it, commit it or write it into
   a mapping file or log. Store it only where the user agrees (step 8 or 10).
4. **Do not edit the bundled `mapping.json` for the user's own choices.** Use the
   user's mapping file (step 7).
5. **No scheduled job unless asked.** Set up automatic sync only if the user
   asks for it (step 10).
6. Do not install system packages, use `sudo` or change shell profiles without
   asking.

## Step 0: Inform the user

Tell the user, in their language:

- hevy2whoop copies Hevy strength workouts into WHOOP Strength Trainer
  (exercises, working sets, reps, weight). It previews by default.
- Requirements: Hevy Pro (for the Hevy API key), a WHOOP account, Node.js 24
  or later.
- The WHOOP side uses [totem](https://github.com/thebriangao/totem), which
  talks to WHOOP's private iOS API. WHOOP's terms do not permit this, and it
  can stop working when WHOOP changes its app. Everything runs on the user's
  computer.

Ask the user:

- Do they accept the WHOOP terms risk?
- Do they want the MCP server (so you or another agent can sync on request),
  the command-line tool, or both? If MCP: which client (Claude Code, Claude
  Desktop, Cursor, Codex, other)?

**Check:** the user accepted the risk. Otherwise stop.

## Step 1: Node.js

```bash
node --version
```

**Check:** major version 24 or later. If Node is missing or older, ask the
user how they want to install it (nodejs.org installer, nvm, or a package
manager) before installing anything.

## Step 2: Get hevy2whoop

Ask where to put it; default `~/hevy2whoop`.

```bash
git clone https://github.com/mselcukozturk/hevy2whoop.git ~/hevy2whoop
node ~/hevy2whoop/hevy2whoop.mjs
```

Below, `<REPO>` is the absolute path of this directory.

**Check:** the second command prints `No command given.` and the usage text.

## Step 3: Install totem

```bash
npm install -g @thebriangao/totem
command -v totem
```

If the install fails with `EACCES`, do not retry with `sudo`. Ask the user;
the usual fix is a user-level npm prefix
(`npm config set prefix ~/.npm-global` and adding `~/.npm-global/bin` to `PATH`).

Below, `<TOTEM_BIN>` is the directory that contains `totem`, and `<NODE_BIN>`
is the directory that contains `node` (`dirname "$(command -v node)"`).

**Check:** `command -v totem` prints a path.

## Step 4: WHOOP sign-in (the user does this)

Ask the user to run this in their own terminal:

```bash
totem auth
```

It asks for the WHOOP email, the password, and an SMS code if the account
has two-factor sign-in. totem stores only tokens and deletes the password
afterwards. Wait until the user says it finished.

```bash
node <REPO>/hevy2whoop.mjs catalog bench
```

**Check:** lines such as `BENCHPRESS_BARBELL	Bench Press - Barbell`. If the
output says `Missing WHOOP_...` or `Run totem auth`, the sign-in did not
complete; ask the user to run `totem auth` again.

## Step 5: Hevy API key (the user does this)

Ask the user to open https://hevy.com/settings?developer, generate an API
key and give it to you (or set `HEVY_API_KEY` themselves). If the page has
no API section, the account is not on Hevy Pro; stop and tell the user.

**Check:** you have the key, or the user confirms `HEVY_API_KEY` is set in
the shell you use.

## Step 6: First preview

```bash
HEVY_API_KEY=<key> node <REPO>/hevy2whoop.mjs sync
```

This reads the latest Hevy workout and writes nothing. Each workout prints a
header line and one of:

| Line | Meaning |
|---|---|
| `preview: would write N exercises, M sets` | Ready to write. |
| `already in WHOOP: activity <id>` | WHOOP has this workout; it will not be written again. |
| `nothing to write` | No exercise of the workout can be written (see step 7). |
| `unmapped: <title> (template <id>)` | No mapping entry; this exercise is left out (step 7). |
| `skipped by mapping: <title>` | The mapping says not to log it (for example Warm Up). |
| `error: ...` | See the table below. |

| Message | Action |
|---|---|
| `HEVY_API_KEY is not set` | Step 5. |
| `Hevy API error: 401` | Wrong key, or the account is not on Hevy Pro. Step 5. |
| `No Hevy workout found.` | The account has no workout yet. Ask the user to log one, or use `--from`/`--to`. |
| `totem is not installed` | Step 3; check that `totem` is on `PATH`. |
| `Run totem auth` or `401` from WHOOP | Step 4. The WHOOP sign-in lasts about 30 days. |
| `Unknown exercise IDs` | A mapping entry has a wrong WHOOP ID. Fix it with `catalog` (step 7). |

Show the user the output.

**Check:** at least one workout header and no `error:` line.

## Step 7: Map the user's unmapped exercises

For each `unmapped:` line:

1. Search the WHOOP catalog with words from the title:
   `node <REPO>/hevy2whoop.mjs catalog "<word>"`.
2. Propose the closest WHOOP ID to the user. Say clearly when it is not an
   exact match. For one-sided exercises WHOOP often has separate `...LEFT` and
   `...RIGHT` entries; listing both writes each set to both sides. If nothing
   fits, propose `[]` (never logged).
3. After the user agrees, add the entry to the user's mapping file, by default
   `~/.config/hevy2whoop/mapping.json` (create the directory and the file with
   `{}` if missing):

```json
{
  "0b7e5c2a-4d1f-4e8a-9c3b-6f2a1d8e7b90": {
    "hevy": "Wide Grip Row",
    "whoop": ["BENTOVERROW_BARBELL"],
    "approximate": true,
    "note": "no wide-grip row in the catalog; barbell bent-over row"
  }
}
```

The key is the template ID from the `unmapped:` line. Entries in this file
are added to the bundled mapping, and an entry with the same template ID
replaces the bundled one.

Then run the preview again with the file:

```bash
HEVY_API_KEY=<key> HEVY2WHOOP_MAPPING=~/.config/hevy2whoop/mapping.json node <REPO>/hevy2whoop.mjs sync
```

To see more exercises at once, preview a longer range, for example the last
four weeks: `sync --from YYYY-MM-DD --to YYYY-MM-DD`.

Template IDs with 8 hexadecimal characters (for example `DE68C825`) are
Hevy's built-in exercises. Tell the user that such entries can be contributed
to the project with a pull request that edits `mapping.json`; open one only if
the user asks. UUID template IDs are the user's custom exercises and stay in
the user's file.

**Check:** the preview shows no `unmapped:` line, or only exercises the user
decided to leave out.

## Step 8: Register the MCP server (if the user chose MCP)

The MCP client starts the server with its own environment, so give it
absolute paths and a `PATH` that contains totem and node.

**Claude Code:**

```bash
claude mcp add hevy2whoop --scope user \
  -e HEVY_API_KEY=<key> \
  -e HEVY2WHOOP_MAPPING=<absolute path of the user's mapping file> \
  -e PATH=<TOTEM_BIN>:<NODE_BIN>:/usr/bin:/bin \
  -- <NODE_BIN>/node <REPO>/hevy2whoop.mjs mcp
claude mcp list
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows) and
**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "hevy2whoop": {
      "command": "<NODE_BIN>/node",
      "args": ["<REPO>/hevy2whoop.mjs", "mcp"],
      "env": {
        "HEVY_API_KEY": "<key>",
        "HEVY2WHOOP_MAPPING": "<absolute path of the user's mapping file>",
        "PATH": "<TOTEM_BIN>:<NODE_BIN>:/usr/bin:/bin"
      }
    }
  }
}
```

Merge the `hevy2whoop` entry into the existing file; do not remove other
servers. On Windows, separate `PATH` entries with `;`.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.hevy2whoop]
command = "<NODE_BIN>/node"
args = ["<REPO>/hevy2whoop.mjs", "mcp"]
env = { HEVY_API_KEY = "<key>", HEVY2WHOOP_MAPPING = "<absolute path of the user's mapping file>", PATH = "<TOTEM_BIN>:<NODE_BIN>:/usr/bin:/bin" }
```

Tell the user to restart the client (Claude Desktop, Cursor) or start a new
session.

**Check:** the client lists `hevy2whoop_sync` and `hevy2whoop_catalog`, and a
call of `hevy2whoop_sync` without arguments returns the same result as step 6.

## Step 9: First write (only after approval)

Show the user the preview of the workouts to be written and ask. After the
user agrees:

```bash
HEVY_API_KEY=<key> HEVY2WHOOP_MAPPING=<file> node <REPO>/hevy2whoop.mjs sync --write
```

or call `hevy2whoop_sync` with `write: true` (and the same `from`/`to` as the
approved preview).

**Check:** `written: activity <id>`. Running the preview again shows
`already in WHOOP` for the same workout. Ask the user to look at the workout
in the WHOOP app.

## Step 10: Automatic sync (only if the user asks)

`sync --write` without dates handles the latest workout and never writes a
workout twice, so it can run on a schedule. Example for cron, every 30
minutes, with the key in a file only the user can read:

```bash
mkdir -p ~/.config/hevy2whoop
printf 'HEVY_API_KEY=%s\n' '<key>' > ~/.config/hevy2whoop/env
chmod 600 ~/.config/hevy2whoop/env
```

```cron
*/30 * * * * . ~/.config/hevy2whoop/env && HEVY_API_KEY=$HEVY_API_KEY HEVY2WHOOP_MAPPING=~/.config/hevy2whoop/mapping.json PATH=<TOTEM_BIN>:<NODE_BIN>:/usr/bin:/bin node <REPO>/hevy2whoop.mjs sync --write >> ~/.config/hevy2whoop/sync.log 2>&1
```

Only the latest Hevy workout is checked on each run; with a 30-minute
interval no workout is missed unless two workouts end within 30 minutes.

**Check:** after the next run, `~/.config/hevy2whoop/sync.log` shows a
workout header and no `error:` line.

## Step 11: Report to the user

Tell the user:

- where hevy2whoop is installed (`<REPO>`) and where the mapping file is;
- where the Hevy key is stored;
- which MCP client was configured, if any, and whether a scheduled job exists;
- that the WHOOP sign-in expires after about 30 days, and `totem auth` renews it;
- that `git -C <REPO> pull` updates hevy2whoop without touching their mapping file.
