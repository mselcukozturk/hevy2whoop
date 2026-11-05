# hevy2whoop

Copies strength workouts you log in [Hevy](https://www.hevyapp.com/) into
WHOOP Strength Trainer: every exercise and every working set, with reps and weight.
WHOOP has no Hevy integration, so without this tool the sets have to be entered
in the WHOOP app by hand after each session.

hevy2whoop handles the Hevy side and the exercise mapping. Writing to WHOOP is
done by [totem](https://github.com/thebriangao/totem), an MCP server by Brian Gao.

> **Read before use.** This project is not affiliated with Hevy or WHOOP.
> WHOOP does not offer a public API for writing Strength Trainer workouts.
> totem uses WHOOP's private iOS API, which WHOOP's terms do not permit and
> which can change without notice. Use it at your own risk and with your own
> account only. hevy2whoop runs on your computer; your Hevy key and WHOOP
> tokens are sent only to Hevy and WHOOP.

## Setting up with an AI agent

Give your agent (Claude Code, Codex, Cursor, ...) this message:

> Install hevy2whoop for me by following
> https://raw.githubusercontent.com/mselcukozturk/hevy2whoop/main/AGENT_INSTALLATION.md

[AGENT_INSTALLATION.md](AGENT_INSTALLATION.md) takes the agent through each
step with a check, maps your unmapped exercises with you, and registers the
MCP server in your client. It tells the agent to leave the WHOOP sign-in to
you and to write to WHOOP only after you approve a preview.

## What it does

1. Reads your latest Hevy workout, or every workout in a date range, from the
   official Hevy API.
2. Converts each exercise to a WHOOP exercise ID using [`mapping.json`](mapping.json).
   Warm-up sets are left out. Exercises without a mapping entry are reported and
   not written.
3. Checks whether WHOOP already has a Strength Trainer activity that starts and
   ends within 2 minutes of the Hevy workout. If so, the workout is not written
   again, so repeated runs are safe.
4. Shows a preview. With `--write`, it logs the workout to WHOOP.

It runs as a command-line tool, or as an MCP server so that Claude or another
MCP client can run the sync on request ("copy yesterday's workout to WHOOP").

## Requirements

- Node.js 24 or later
- Hevy Pro (the Hevy API key is available only on Pro):
  [hevy.com/settings?developer](https://hevy.com/settings?developer)
- A WHOOP account
- totem, installed and signed in

## Installation

```bash
git clone https://github.com/mselcukozturk/hevy2whoop.git
cd hevy2whoop
npm install -g @thebriangao/totem
totem auth                      # sign in to WHOOP once
export HEVY_API_KEY=your-hevy-api-key
```

hevy2whoop has no npm dependencies. It starts `totem start` from your `PATH`.
totem's WHOOP sign-in lasts about 30 days; when it expires, run `totem auth` again.

## Usage

```bash
node hevy2whoop.mjs sync                                      # preview the latest workout
node hevy2whoop.mjs sync --write                              # write it to WHOOP
node hevy2whoop.mjs sync --from 2026-09-01 --to 2026-09-30    # preview a date range
node hevy2whoop.mjs sync --from 2026-09-01 --to 2026-09-30 --write
node hevy2whoop.mjs catalog "lateral raise"                   # find WHOOP exercise IDs
```

Dates are in your local time zone and both ends are included. Example output:

```
2026-09-06 13:34–14:27  Upper Body
  unmapped: Wide Grip Row (template 0b7e5c2a-4d1f-4e8a-9c3b-6f2a1d8e7b90)
  skipped by mapping: Warm Up
  preview: would write 10 exercises, 20 sets (run with --write to write)
```

To sync automatically, run `node hevy2whoop.mjs sync --write` from cron or a
systemd timer some time after your workout ends.

## MCP server

`node hevy2whoop.mjs mcp` runs an MCP server over stdio with two tools:

| Tool | Arguments | Effect |
|---|---|---|
| `hevy2whoop_sync` | `from`, `to` (YYYY-MM-DD, optional), `write` (default `false`) | Same as `sync`. Returns one result per workout: `preview`, `written`, `already_in_whoop`, `nothing_to_write` or `error`, with unmapped and skipped exercises. |
| `hevy2whoop_catalog` | `search` (optional) | Same as `catalog`. |

The sync tool writes to WHOOP only when it is called with `write: true`.

Claude Code:

```bash
claude mcp add hevy2whoop -e HEVY_API_KEY=your-hevy-api-key -- node /path/to/hevy2whoop/hevy2whoop.mjs mcp
```

Claude Desktop, Cursor and other clients (`claude_desktop_config.json` or the
client's MCP settings):

```json
{
  "mcpServers": {
    "hevy2whoop": {
      "command": "node",
      "args": ["/path/to/hevy2whoop/hevy2whoop.mjs", "mcp"],
      "env": { "HEVY_API_KEY": "your-hevy-api-key" }
    }
  }
}
```

`totem` must be on the `PATH` the client gives to the server. If the client
cannot find it, add `"PATH"` to `env`.

## Exercise mapping

`mapping.json` is keyed by the Hevy `exercise_template_id`:

```json
"DE68C825": {
  "hevy": "Single Arm Lateral Raise (Cable)",
  "whoop": ["LATERALRAISELEFT_PULLEYMACHINE", "LATERALRAISERIGHT_PULLEYMACHINE"],
  "approximate": false,
  "note": "the catalog has no two-sided cable lateral raise; every set is written to both sides"
}
```

| Field | Meaning |
|---|---|
| `hevy` | Hevy exercise title, for readers of the file |
| `whoop` | WHOOP exercise IDs. Each working set is written to every ID in the list. An empty list means the exercise is never logged. |
| `approximate` | `true` when the WHOOP catalog has no exact equivalent and the closest exercise was chosen |
| `note` | Reason for an approximate or unusual choice |

The WHOOP catalog has 372 exercises and Hevy has many more, so a number of
entries are approximate. Check the notes and change entries you disagree with.

### Adding an exercise

1. Run `sync`. Unmapped exercises are listed with their template ID.
2. Find the WHOOP ID with `node hevy2whoop.mjs catalog <search>`.
3. Add an entry to your own mapping file (below), or to `mapping.json` if the
   exercise is one of Hevy's built-in exercises and you want to contribute it.

### Your own mapping file

Set `HEVY2WHOOP_MAPPING` to the path of a JSON file in the same format. Its
entries are added to `mapping.json`, and an entry with the same template ID
replaces the bundled one. Use it for your custom Hevy exercises and for
choices that differ from the bundled mapping; updating the repository then
never conflicts with your changes.

```bash
export HEVY2WHOOP_MAPPING=~/.config/hevy2whoop/mapping.json
```

Custom Hevy exercises have UUID template IDs (for example `0b7e5c2a-4d1f-...`).
They exist only in your account, so keep them in your own file and do not
submit them.

### Contributing

Pull requests that add or correct entries for Hevy's built-in exercises
(8-character template IDs) are welcome. Please set `approximate` and explain
the choice in `note` when the match is not exact.

## Limitations

- WHOOP stores a duration for each set; Hevy does not. The workout duration is
  divided equally across the working sets.
- Drop sets and failure sets are written as ordinary sets.
- Only workouts WHOOP records as Strength Trainer activities count as already
  logged. A separate activity recorded by the strap during the same session is
  left untouched.
- For one-sided exercises, Hevy counts reps per side, while some WHOOP entries
  may count the total. See the notes in `mapping.json`.

## Testing

```bash
node test/e2e.mjs
```

Runs the command-line tool and the MCP server end to end against a fake Hevy
API and a fake totem server, covering the cases in [docs/failure-scenarios.md](docs/failure-scenarios.md),
and writes the result to `artifacts/e2e-result.json`. No real account is used.

## Credits

- [totem](https://github.com/thebriangao/totem) by Brian Gao (MIT) does all
  communication with WHOOP.
- [hevy2garmin](https://pypi.org/project/hevy2garmin/) does the same job for
  Garmin Connect and was a reference for this project.

## License

MIT
