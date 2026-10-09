# companion-mcp

A small, security-gated [MCP](https://modelcontextprotocol.io) server that lets an LLM client (Claude Desktop, Claude Code, etc.) read state from and, when explicitly enabled, press allowlisted buttons on a [Bitfocus Companion](https://bitfocus.io/companion) 5.0.7 instance.

Built for a single operator running live events. Not a public package.

## What it does

- Reads custom variables, module variables and connection status.
- Presses buttons that are on an operator-maintained allowlist.
- Sets custom variables that are on the allowlist.
- Logs every tool call to a JSON lines file.

## What it deliberately does not do

- It will not press any button that is not on the allowlist, no matter what the model asks.
- It will not write anything unless `COMPANION_ALLOW_WRITES=true`.
- It will not act unless the model passes `dry_run: false` explicitly. Dry run is the default.
- It will not press a high risk button without `confirm: true`.
- It never retries a press or a write. On timeout, connection reset or a 5xx after a write it reports "outcome unknown".
- It refuses a second write to the same button or variable while one is in flight, and for 2 seconds after.
- It refuses writes if the audit log cannot be written. An "attempt" line is logged before every real write.
- It never talks to a non-private address unless `COMPANION_ALLOW_REMOTE=true`.
- It never opens a network socket of its own. stdio transport only.
- It does not change button styles, restart connections, rescan surfaces or use the deprecated legacy API.

## Requirements

- Node 22 or later
- Companion 5.0.7 with Settings, HTTP, "HTTP API" enabled
- [gitleaks](https://github.com/gitleaks/gitleaks) on PATH for the local secret scan (`npm run secrets` and the pre-commit hook)

## Install and build

```bash
git clone git@github.com:duncanunderwood/companion-mcp.git
cd companion-mcp
npm ci --ignore-scripts
npx husky            # installs git hooks
npm run build        # emits dist/
npm run check        # typecheck, lint, format, tests with coverage, audit, secrets
```

## Configuration

Environment variables, all optional:

| Variable                   | Default                   | Meaning                                                                                                    |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `COMPANION_URL`            | `http://127.0.0.1:8000`   | Base URL of Companion. Scheme and host only, no path, query or credentials.                                |
| `COMPANION_ALLOW_WRITES`   | `false`                   | Must be exactly `true` to enable `press_button` and `set_custom_variable`.                                 |
| `COMPANION_ALLOW_REMOTE`   | `false`                   | Must be exactly `true` to allow a `COMPANION_URL` outside loopback, 10/8, 172.16/12, 192.168/16, fc00::/7. |
| `COMPANION_ALLOWLIST_PATH` | `./config/allowlist.json` | Path to the allowlist. Relative paths must stay inside the working directory. Must end in `.json`.         |
| `COMPANION_TIMEOUT_MS`     | `3000`                    | Per request timeout, 100 to 30000.                                                                         |
| `COMPANION_LOG_DIR`        | `./logs`                  | Directory for `companion-mcp.jsonl`. Rotates at 5 MB, keeps one backup.                                    |

Any invalid value, including an empty string, stops the server at startup. It never falls back to a guess.

### Allowlist

`config/allowlist.json` is git-ignored because it reveals your rig layout. Copy the example and edit it:

```bash
cp config/allowlist.example.json config/allowlist.json
```

```json
{
  "buttons": [
    { "page": 1, "row": 0, "column": 0, "label": "Program: Camera 1", "risk": "low" },
    { "page": 1, "row": 0, "column": 1, "label": "Program: Camera 2", "risk": "low" },
    { "page": 1, "row": 1, "column": 0, "label": "Play walk-in music", "risk": "low" },
    { "page": 1, "row": 3, "column": 7, "label": "STREAM STOP", "risk": "high" }
  ],
  "variables": ["cue", "speaker_name"]
}
```

- `buttons`: page 1 to 99, row and column 0 to 31, label up to 80 characters, risk `low` or `high`. Duplicates are rejected.
- `variables`: custom variable names (letters, digits, `_`, `-`) that `set_custom_variable` may write. Omit or leave empty to forbid all variable writes.
- Unknown keys anywhere are rejected. A missing or invalid file stops the server.

## Tools

| Tool                    | Writes | Description                                                                                           |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `ping`                  | no     | Liveness, reports whether writes are enabled. No Companion request.                                   |
| `get_custom_variable`   | no     | Read `$(custom:name)`.                                                                                |
| `get_module_variable`   | no     | Read `$(label:name)` from a connection.                                                               |
| `list_connections`      | no     | All connections with status.                                                                          |
| `get_connection_status` | no     | One connection by id.                                                                                 |
| `list_allowlist`        | no     | Shows what `press_button` and `set_custom_variable` may touch.                                        |
| `press_button`          | yes    | Press and release an allowlisted button. `dry_run` defaults to true. High risk needs `confirm: true`. |
| `set_custom_variable`   | yes    | Set an allowlisted custom variable to a text value. `dry_run` defaults to true.                       |

Every tool returns a one line text summary plus `structuredContent`. Refusals and errors are returned with `isError: true` and a plain reason, never a stack trace.

## Claude Desktop configuration

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config). Use absolute paths.

```json
{
  "mcpServers": {
    "companion": {
      "command": "node",
      "args": ["C:/Users/DuncanUnderwood/orca/projects/companion-mcp/dist/index.js"],
      "cwd": "C:/Users/DuncanUnderwood/orca/projects/companion-mcp",
      "env": {
        "COMPANION_URL": "http://127.0.0.1:8000",
        "COMPANION_ALLOW_WRITES": "false",
        "COMPANION_ALLOWLIST_PATH": "C:/Users/DuncanUnderwood/orca/projects/companion-mcp/config/allowlist.json",
        "COMPANION_LOG_DIR": "C:/Users/DuncanUnderwood/orca/projects/companion-mcp/logs",
        "COMPANION_TIMEOUT_MS": "3000"
      }
    }
  }
}
```

Writes are disabled in this shipped config on purpose. Flip `COMPANION_ALLOW_WRITES` to `"true"` only for the event, then flip it back.

For Claude Code:

```bash
claude mcp add companion -e COMPANION_URL=http://127.0.0.1:8000 -e COMPANION_ALLOW_WRITES=false -- node /abs/path/companion-mcp/dist/index.js
```

## Logs

`logs/companion-mcp.jsonl`, one object per line:

```json
{
  "ts": "2026-10-09T10:00:00.000Z",
  "tool": "press_button",
  "args": { "page": 1, "row": 0, "column": 0, "dry_run": false, "confirm": false },
  "outcome": "ok",
  "allowed": true,
  "dryRun": false,
  "detail": "pressed \"Program: Camera 1\" at 1/0/0. Companion accepted the press.",
  "durationMs": 12
}
```

`outcome` is `attempt`, `ok`, `refused` or `error`. Variable values are never logged (reads log only the name, writes log only the length). Argument keys that look like secrets are redacted, `detail` is clipped to 200 characters. The file is created mode 0600 and rotates at 5 MB keeping 5 backups. The environment is never logged.

## Pre-show checklist

1. Confirm the Companion version is 5.0.7 and matches `docs/companion-api.md`.
2. Review `config/allowlist.json` against the current page layout. Rearranged buttons make labels stale.
3. Confirm `COMPANION_URL` points at the intended instance, not a test machine.
4. Enable writes (`COMPANION_ALLOW_WRITES=true`) only for the event, and disable afterwards.
5. Dry run every button you plan to use (`press_button` with the default `dry_run: true`) and check the labels.
6. Check `logs/` is writable and that rotation has left a sane file size.
7. Run `ping` from the client and confirm it reports the expected write state and host.

## Manual test script

Run against a test Companion instance, never the show network. Prepare: a button at page 1 row 0 column 0 with a harmless action, a custom variable named `cue`, and an allowlist containing both (button risk `low`) plus a second entry at 1/3/7 with risk `high`.

| Step | Action                                                                                                                         | Expected                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1    | Start with writes disabled. Call `ping`.                                                                                       | `writesEnabled: false`, correct host, allowlist counts.                                        |
| 2    | `get_custom_variable` name `cue`.                                                                                              | `found: true` with the current value.                                                          |
| 3    | `get_custom_variable` name `does_not_exist`.                                                                                   | `found: false`, not an error.                                                                  |
| 4    | `press_button` 1/0/0 with `dry_run: false`.                                                                                    | Refused: writes are disabled. Nothing happens in Companion. Log line has `outcome: "refused"`. |
| 5    | Restart with `COMPANION_ALLOW_WRITES=true`. `press_button` 1/0/0 (no `dry_run` given).                                         | `DRY RUN` summary naming the label. Nothing happens in Companion.                              |
| 6    | `press_button` 1/0/0 with `dry_run: false`.                                                                                    | Summary `pressed ...`. The button fires in Companion.                                          |
| 7    | `press_button` 1/3/7 with `dry_run: false` and no `confirm`. Then with `confirm: true`.                                        | First refused (requires confirm). Second fires.                                                |
| 8    | `press_button` 2/0/0 with `dry_run: false`. Then `set_custom_variable` `cue` to `test` with `dry_run: false` and read it back. | Press refused (not on allowlist). Variable updated and `get_custom_variable` returns `test`.   |

Finish by setting `COMPANION_ALLOW_WRITES=false` again.

## Development

```bash
npm test                 # vitest
npm run test:coverage    # with thresholds (85% lines overall, 90% on src/safety.ts)
npm run lint
npm run check            # everything CI runs
```

Work on a branch per phase, open a PR, squash merge once `ci` is green. `main` is protected.

Companion HTTP API ground truth lives in `docs/companion-api.md`. If an endpoint is not there, it is not used.

## Not a web app

This is a stdio process launched by an MCP client. It has no HTTP output and must not be deployed to Vercel or any host. `vercel.json` disables Git deployments in case the GitHub integration attaches the repo again.
