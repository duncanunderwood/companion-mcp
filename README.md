# companion-mcp

A small, security-gated [MCP](https://modelcontextprotocol.io) server for [Bitfocus Companion](https://bitfocus.io/companion). It lets any MCP-capable AI client read show state from Companion and, only when you explicitly enable it, press buttons and set variables that you have put on an allowlist.

Built for live-event operators who want AI assistance at the desk without handing an AI the whole rig.

Developed by MyEvent Labs. MIT licensed.

## Contents

- [How it protects your show](#how-it-protects-your-show)
- [Requirements](#requirements)
- [Install](#install)
- [Configure Companion](#configure-companion)
- [Configure the allowlist](#configure-the-allowlist)
- [Connect your AI client](#connect-your-ai-client)
- [Environment variables](#environment-variables)
- [Tools](#tools)
- [Logs](#logs)
- [Pre-show checklist](#pre-show-checklist)
- [Manual test script](#manual-test-script)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it protects your show

- Read-only by default. Nothing is written unless `COMPANION_ALLOW_WRITES=true`.
- Only buttons and variables on your allowlist can ever be written. Everything else is refused, whatever the AI asks.
- Every write defaults to a dry run. The AI must pass `dry_run: false` to act.
- Buttons you mark `high` risk also need `confirm: true`.
- One attempt, never retried. On timeout, reset or server error it reports "outcome unknown" instead of guessing.
- The same button or variable cannot be written twice within 2 seconds, or while a write is in flight.
- Every call is written to an audit log before it happens. If the log cannot be written, writes are refused.
- It only talks to loopback or private network addresses unless you opt in to remote.
- It opens no network port of its own. It is a local process your AI client launches over stdio.
- It uses only the documented Companion 5.0.7 HTTP API (`docs/companion-api.md`). No style changes, connection restarts, surface rescans or legacy endpoints.

## Requirements

- Node.js 22 or later (`node --version`)
- Bitfocus Companion 5.0.7 running on the same machine or your private network
- An MCP client (desktop AI app or IDE) that can launch a local stdio server

Git and a terminal. No global installs, no database, no cloud account.

## Install

### One line

The installer clones to `~/companion-mcp`, builds, creates a starter allowlist, checks the server starts, and prints the client config with your paths filled in. Review the script first if you like: `scripts/install.sh` and `scripts/install.ps1`.

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/duncanunderwood/companion-mcp/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/duncanunderwood/companion-mcp/main/scripts/install.ps1 | iex
```

Set `COMPANION_MCP_DIR` to install somewhere else, or `COMPANION_URL` if Companion is not on `127.0.0.1:8000`.

### Let an AI agent do it

If you use an AI assistant with terminal access (any coding agent or desktop assistant that can run commands), paste this:

```
Install companion-mcp by running the installer from
https://github.com/duncanunderwood/companion-mcp (scripts/install.sh on macOS/Linux,
scripts/install.ps1 on Windows). Then add the JSON it prints to my MCP client config
and tell me where you put it. Leave COMPANION_ALLOW_WRITES set to "false".
```

### Manual

```bash
git clone https://github.com/duncanunderwood/companion-mcp.git
cd companion-mcp
npm ci
npm run build
```

Confirm the build produced `dist/index.js`:

```bash
node dist/index.js
# companion-mcp: allowlist file is missing or unreadable
```

That error is expected at this point. It means the server starts and refuses to run without an allowlist. Continue with the next two sections.

Note the absolute path to the folder. You will need it for the client config, for example `/home/you/companion-mcp` or `C:/Users/you/companion-mcp`.

## Configure Companion

1. Open the Companion web UI.
2. Go to Settings, then HTTP.
3. Enable **HTTP API**. Leave the legacy API disabled.
4. Note the port shown under Admin UI (default `8000`).

Test from a terminal on the same machine (replace `cue` with any custom variable you have):

```bash
curl http://127.0.0.1:8000/api/custom-variable/cue/value
```

You should see the value, or `Not found` if the variable does not exist. A `403` means the HTTP API is still disabled.

## Configure the allowlist

The allowlist is the list of things the AI is permitted to write. It lives at `config/allowlist.json`, which is git-ignored so your rig layout is never committed.

The installer creates it empty, so nothing can be pressed until you add entries. If you installed manually, create it:

```bash
printf '{ "buttons": [], "variables": [] }' > config/allowlist.json
```

Then add only buttons that really exist on your pages. Open each one in the Companion button editor and copy the page, row and column from there. Do not copy the example below as-is; its positions are made up and a press would hit whatever happens to be at that slot on your rig. `config/allowlist.example.json` shows the format:

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

| Field           | Meaning                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `page`          | Companion page number, 1 to 99                                                          |
| `row`, `column` | 0-based grid position as shown in the Companion button editor, 0 to 31                  |
| `label`         | Your own description, shown back to the AI and written to the log                       |
| `risk`          | `low` acts on `dry_run: false`. `high` additionally requires `confirm: true`            |
| `variables`     | Custom variable names the AI may set. Omit or leave empty to forbid all variable writes |

Rules: no duplicates, no unknown keys, names use letters, digits, `_` and `-` only. A missing or invalid file stops the server with a clear message.

Start with 3 or 4 entries. Add more once you trust the workflow.

Stale entries are the main risk. If you move or delete a button, update the allowlist before the next show. A press on an empty slot returns "no button at ..." (nothing fires), but a press on a slot you later reused fires whatever is there now. Running `press_button` with the default dry run for each entry before a show is the quick check.

## Connect your AI client

Every MCP client needs the same three things: the command to launch (`node`), the path to `dist/index.js`, and environment variables. Writes are left disabled in all examples below on purpose.

Replace `/abs/path/companion-mcp` with your real path. On Windows use forward slashes (`C:/Users/you/companion-mcp`) or doubled backslashes.

### Generic JSON config (most desktop apps and IDEs)

Many clients read a JSON file with an `mcpServers` object. Add this block:

```json
{
  "mcpServers": {
    "companion": {
      "command": "node",
      "args": ["/abs/path/companion-mcp/dist/index.js"],
      "cwd": "/abs/path/companion-mcp",
      "env": {
        "COMPANION_URL": "http://127.0.0.1:8000",
        "COMPANION_ALLOW_WRITES": "false",
        "COMPANION_ALLOWLIST_PATH": "/abs/path/companion-mcp/config/allowlist.json",
        "COMPANION_LOG_DIR": "/abs/path/companion-mcp/logs"
      }
    }
  }
}
```

If your client has no `cwd` field, keep the absolute paths in `env` and it will work anyway.

### Claude Desktop

Settings, Developer, Edit Config opens `claude_desktop_config.json`. Add the `companion` entry inside `mcpServers`.

These examples are read-only (`COMPANION_ALLOW_WRITES` is `"false"`). To let the AI press allowlisted buttons, change that one value to `"true"`, save, and fully restart Claude Desktop. Every press then still defaults to a dry run, must be on your allowlist, and high risk entries need `confirm: true`. Set it back to `"false"` after the show.

Windows (backslashes must be doubled in JSON; replace `<USERNAME>` with your Windows user name):

```json
"companion": {
  "command": "node",
  "args": ["C:\\Users\\<USERNAME>\\companion-mcp\\dist\\index.js"],
  "env": {
    "COMPANION_URL": "http://127.0.0.1:8000",
    "COMPANION_ALLOW_WRITES": "false",
    "COMPANION_ALLOWLIST_PATH": "C:\\Users\\<USERNAME>\\companion-mcp\\config\\allowlist.json",
    "COMPANION_LOG_DIR": "C:\\Users\\<USERNAME>\\companion-mcp\\logs"
  }
}
```

macOS and Linux (replace `<USERNAME>`):

```json
"companion": {
  "command": "node",
  "args": ["/Users/<USERNAME>/companion-mcp/dist/index.js"],
  "env": {
    "COMPANION_URL": "http://127.0.0.1:8000",
    "COMPANION_ALLOW_WRITES": "false",
    "COMPANION_ALLOWLIST_PATH": "/Users/<USERNAME>/companion-mcp/config/allowlist.json",
    "COMPANION_LOG_DIR": "/Users/<USERNAME>/companion-mcp/logs"
  }
}
```

Save, then fully quit and reopen Claude Desktop. Closing the window is not enough; the server is only launched at startup. On Windows, force it from a terminal:

```powershell
taskkill /IM Claude.exe /F
```

On macOS: Cmd+Q, or `pkill -x Claude`. The tools appear under the tools icon in a chat.

### Claude Code (CLI)

Registers the server for all your projects (`--scope user`). Run from any folder. These examples are read-only. To enable writes, change `COMPANION_ALLOW_WRITES=false` to `true` in the command (run `claude mcp remove companion` first if it is already registered).

Windows PowerShell:

```powershell
claude mcp add companion --scope user `
  -e COMPANION_URL=http://127.0.0.1:8000 `
  -e COMPANION_ALLOW_WRITES=false `
  -e COMPANION_ALLOWLIST_PATH=$env:USERPROFILE\companion-mcp\config\allowlist.json `
  -e COMPANION_LOG_DIR=$env:USERPROFILE\companion-mcp\logs `
  -- node $env:USERPROFILE\companion-mcp\dist\index.js
```

Windows Command Prompt (cmd):

```bat
claude mcp add companion --scope user ^
  -e COMPANION_URL=http://127.0.0.1:8000 ^
  -e COMPANION_ALLOW_WRITES=false ^
  -e COMPANION_ALLOWLIST_PATH=%USERPROFILE%\companion-mcp\config\allowlist.json ^
  -e COMPANION_LOG_DIR=%USERPROFILE%\companion-mcp\logs ^
  -- node %USERPROFILE%\companion-mcp\dist\index.js
```

macOS and Linux:

```bash
claude mcp add companion --scope user \
  -e COMPANION_URL=http://127.0.0.1:8000 \
  -e COMPANION_ALLOW_WRITES=false \
  -e COMPANION_ALLOWLIST_PATH=$HOME/companion-mcp/config/allowlist.json \
  -e COMPANION_LOG_DIR=$HOME/companion-mcp/logs \
  -- node $HOME/companion-mcp/dist/index.js
```

Check with `claude mcp list`. Remove with `claude mcp remove companion`.

### Cursor

Settings, MCP, Add new global MCP server. Paste the generic block into `~/.cursor/mcp.json` (or `.cursor/mcp.json` inside a project). Toggle the server on.

### VS Code (Copilot agent mode)

Create `.vscode/mcp.json` in a workspace:

```json
{
  "servers": {
    "companion": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/companion-mcp/dist/index.js"],
      "env": {
        "COMPANION_URL": "http://127.0.0.1:8000",
        "COMPANION_ALLOW_WRITES": "false",
        "COMPANION_ALLOWLIST_PATH": "/abs/path/companion-mcp/config/allowlist.json",
        "COMPANION_LOG_DIR": "/abs/path/companion-mcp/logs"
      }
    }
  }
}
```

### Windsurf, Cline, Zed and others

These use the generic `mcpServers` shape or a close variant. Look for "MCP servers" in the client settings, choose "stdio" or "command" type, and copy the command, args and env from the generic block.

### Verify the connection

Ask your AI client to run the `ping` tool. You should get:

```
companion-mcp is running. Writes disabled. Companion at 127.0.0.1:8000.
```

Then ask it to run `list_allowlist` and check your buttons are listed.

### Enabling writes for a show

Change `"COMPANION_ALLOW_WRITES": "false"` to `"true"` in the client config and restart the client. `ping` will now say `Writes ENABLED`. Set it back to `"false"` after the event.

## Environment variables

| Variable                   | Default                   | Meaning                                                                                                    |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `COMPANION_URL`            | `http://127.0.0.1:8000`   | Base URL of Companion. Scheme and host only, no path, query or credentials.                                |
| `COMPANION_ALLOW_WRITES`   | `false`                   | Must be exactly `true` to enable `press_button` and `set_custom_variable`.                                 |
| `COMPANION_ALLOW_REMOTE`   | `false`                   | Must be exactly `true` to allow a `COMPANION_URL` outside loopback, 10/8, 172.16/12, 192.168/16, fc00::/7. |
| `COMPANION_ALLOWLIST_PATH` | `./config/allowlist.json` | Path to the allowlist. Relative paths must stay inside the working directory. Must end in `.json`.         |
| `COMPANION_TIMEOUT_MS`     | `3000`                    | Per request timeout, 100 to 30000.                                                                         |
| `COMPANION_LOG_DIR`        | `./logs`                  | Directory for the audit log.                                                                               |

Any invalid value, including an empty string, stops the server at startup with a message on stderr. It never falls back to a guess.

## Tools

| Tool                    | Writes | Description                                                                                                 |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `ping`                  | no     | Liveness. Reports whether writes are enabled. No Companion request.                                         |
| `get_custom_variable`   | no     | Read `$(custom:name)`.                                                                                      |
| `get_module_variable`   | no     | Read `$(label:name)` from a connection.                                                                     |
| `list_connections`      | no     | All connections with status.                                                                                |
| `get_connection_status` | no     | One connection by id.                                                                                       |
| `list_allowlist`        | no     | Shows what `press_button` and `set_custom_variable` may touch.                                              |
| `press_button`          | yes    | Press and release an allowlisted button. `dry_run` defaults to true. High risk needs `confirm: true`.       |
| `set_custom_variable`   | yes    | Set an allowlisted custom variable to a non-blank text value (1 to 1000 chars). `dry_run` defaults to true. |

Every tool returns a one-line text summary plus structured data. Refusals and errors come back as errors with a plain reason, never a stack trace.

A press result of `ok` means Companion accepted the request, not that the downstream device acted. Confirm by reading a variable back.

## Logs

`<COMPANION_LOG_DIR>/companion-mcp.jsonl`, one JSON object per line:

```json
{
  "ts": "2026-01-01T10:00:00.000Z",
  "tool": "press_button",
  "args": { "page": 1, "row": 0, "column": 0, "dry_run": false, "confirm": false },
  "outcome": "ok",
  "allowed": true,
  "dryRun": false,
  "detail": "pressed \"Program: Camera 1\" at 1/0/0. Companion accepted the press.",
  "durationMs": 12
}
```

- `outcome` is `attempt` (written before a real write), `ok`, `refused` or `error`.
- Variable values are never logged. Reads log the name only, writes log the length only.
- Argument keys that look like secrets are redacted. `detail` is clipped to 200 characters.
- The file is created with mode 0600, rotates at 5 MB and keeps 5 backups. The environment is never logged.

## Pre-show checklist

1. Confirm Companion is 5.0.7 and the HTTP API is enabled.
2. Review `config/allowlist.json` against the current page layout. Rearranged buttons make labels stale.
3. Confirm `COMPANION_URL` points at the show instance, not a test machine.
4. Enable writes only for the event, and disable afterwards.
5. Dry run every button you plan to use (`press_button` with the default `dry_run: true`) and check the labels.
6. Check the log directory is writable and has free space.
7. Run `ping` from the client and confirm it reports the expected write state and host.

## Manual test script

Run against a test Companion instance, never the show network. Prepare a button at page 1 row 0 column 0 with a harmless action, a custom variable named `cue`, and an allowlist containing both (button risk `low`) plus a second entry at 1/3/7 with risk `high`.

| Step | Action                                                                                                                         | Expected                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1    | Start with writes disabled. Call `ping`.                                                                                       | `writesEnabled: false`, correct host, allowlist counts.                                        |
| 2    | `get_custom_variable` name `cue`.                                                                                              | `found: true` with the current value.                                                          |
| 3    | `get_custom_variable` name `does_not_exist`.                                                                                   | `found: false`, not an error.                                                                  |
| 4    | `press_button` 1/0/0 with `dry_run: false`.                                                                                    | Refused: writes are disabled. Nothing happens in Companion. Log line has `outcome: "refused"`. |
| 5    | Restart with writes enabled. `press_button` 1/0/0 with no `dry_run` given.                                                     | `DRY RUN` summary naming the label. Nothing happens in Companion.                              |
| 6    | `press_button` 1/0/0 with `dry_run: false`.                                                                                    | Summary `pressed ...`. The button fires in Companion.                                          |
| 7    | `press_button` 1/3/7 with `dry_run: false` and no `confirm`. Then with `confirm: true`.                                        | First refused (requires confirm). Second fires.                                                |
| 8    | `press_button` 2/0/0 with `dry_run: false`. Then `set_custom_variable` `cue` to `test` with `dry_run: false` and read it back. | Press refused (not on allowlist). Variable updated and `get_custom_variable` returns `test`.   |

Finish by disabling writes again.

## Troubleshooting

| Symptom                                             | Cause and fix                                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowlist file is missing or unreadable`           | Copy `config/allowlist.example.json` to `config/allowlist.json`, or set `COMPANION_ALLOWLIST_PATH` to an absolute path.                                               |
| `COMPANION_URL must be loopback or a private range` | Companion is on a public address. Use its private LAN address, or set `COMPANION_ALLOW_REMOTE=true` if you understand the risk.                                       |
| `Companion HTTP API is disabled (403)`              | Enable HTTP API in Companion Settings, HTTP.                                                                                                                          |
| `could not reach Companion`                         | Wrong host or port, Companion not running, or a firewall. Test with `curl` as shown above.                                                                            |
| `unexpected Companion response 404` on a read       | Something other than Companion is answering on that port, or the Companion version differs. Check the port in Companion settings.                                     |
| `Companion reports no button at ...`                | The allowlist entry points at an empty cell. Fix the page/row/column.                                                                                                 |
| Tools do not appear in the client                   | Paths in the config are not absolute, or the client was not fully restarted. Run `node /abs/path/companion-mcp/dist/index.js` in a terminal to see the startup error. |
| `audit log is not writable`                         | `COMPANION_LOG_DIR` does not exist or is read-only.                                                                                                                   |

## Development

```bash
npm test                 # vitest
npm run test:coverage    # with thresholds
npm run lint
npm run check            # everything CI runs: typecheck, lint, format, build, tests, audit, secret scan
npx husky                # optional: install pre-commit and pre-push hooks
```

`npm run secrets` and the pre-commit hook need [gitleaks](https://github.com/gitleaks/gitleaks) on your PATH.

Companion HTTP API ground truth lives in `docs/companion-api.md`. If an endpoint is not there, it is not used. Contribution rules for humans and AI agents are in `AGENTS.md`.

This is a stdio process launched by an MCP client. It has no web output and is not meant to be hosted anywhere.

## Credits

Developed by MyEvent Labs. Companion is a product of Bitfocus AS; this project is not affiliated with or endorsed by Bitfocus.
