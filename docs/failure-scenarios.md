# Failure scenarios

Written before the implementation. Each scenario is exercised by `test/e2e.mjs`
against a fake Hevy API and a fake `totem` MCP server.

| # | Scenario | Required behaviour |
|---|---|---|
| F1 | `HEVY_API_KEY` is not set | Exit 1 with a message naming the variable. Whoop is not contacted. |
| F2 | Hevy API returns 401 or 5xx | Exit 1 with the HTTP status. Nothing is written to Whoop. |
| F3 | Hevy has no workout, or none in the requested range | Report that no workout was found. Exit 0. |
| F4 | `totem` is not installed | Exit 1 with installation instructions. |
| F5 | totem is installed but not authenticated, or the token expired | Show the Whoop error and the hint to run `totem auth`. Exit 1. |
| F6 | The workout is already in Whoop (a Strength Trainer activity within 2 minutes of the Hevy start and end) | Report the existing activity. Do not write a second copy. A second `--write` run writes nothing. |
| F7 | A Hevy exercise has no entry in `mapping.json` | Report its title and template ID. Do not write it. Write the mapped exercises of the same workout. |
| F8 | A mapping entry has an empty `whoop` list | Report the exercise as skipped by mapping. Do not write it. |
| F9 | No exercise of the workout can be written (all unmapped, all skipped, or only warm-up sets) | Report that there is nothing to write. Do not call Whoop's log tool. |
| F10 | A mapping entry names a Whoop exercise ID that the catalog does not contain | Show totem's error for that workout. Exit 1. |
| F11 | A mapping entry lists two Whoop IDs (left and right side) | Write every working set to both IDs. |
| F12 | Warm-up sets | Excluded from the payload. |
| F13 | Bodyweight set (`weight_kg` is null) or a set without reps | Omit `weight`; send `reps: 0`. |
| F14 | `--write` is not given | Whoop's log tool is called only with `confirm: false` (preview). Nothing is written. |
| F15 | Invalid date, only one of `--from`/`--to`, or `--from` later than `--to` | Exit 1 with the usage text. Hevy is not contacted. |
| F16 | The requested range spans more than one Hevy page | All pages up to the start of the range are read; workouts outside the range are ignored. |
| F17 | Writing one workout fails while others succeed | The other workouts are still processed. Exit 1. |
| F18 | `mapping.json` is not valid JSON | Exit 1 with the file name. |
| F19 | totem does not answer a request | The request fails after 60 seconds with a timeout message. Not covered by the E2E run. |
