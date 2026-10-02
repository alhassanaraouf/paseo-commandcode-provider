# paseo-commandcode-provider

A [Paseo](https://paseo.sh) provider plugin for [Command Code](https://commandcode.ai) (`commandcode` CLI). Requires Paseo `>=0.8.0` and `commandcode` on `PATH` (logged in via `commandcode login`) — on Windows the plugin looks for `cmdc` instead, since `commandcode` isn't guaranteed to have installed a `cmd` shim (that name is taken by the Windows shell).

To point at a different binary (a different alias, a full path, a wrapper script), either:
- Set it once for everyone under **Settings → Plugins → Command Code**, or
- Set the `COMMANDCODE_CLI_COMMAND` environment variable on a specific agent, which takes priority over the shared setting.

## Screenshots

![Composer controls](images/composer.png)
![Build and plan modes](images/modes.png)

## Install

```bash
paseo plugin add npm:@alhassanaraouf/paseo-commandcode-provider
```

Or from GitHub:

```bash
paseo plugin add alhassanaraouf/paseo-commandcode-provider
```

Or from a local checkout:

```bash
paseo plugin add /path/to/paseo-commandcode-provider
```

Then create an agent with the **Command Code** provider.

## What works

- **Messages** — prompts run headless (`commandcode -p --output-format json`), streamed into the timeline (text, thinking, tool calls, usage).
- **Images** — attachments are materialized to a private temp file and passed by path (`[Image available at: …]`), which `read_file` resolves into an image block. Capped at 16 MiB; see Known issues.
- **Tasks** — `task_create` / `task_update` / `task_list` / `task_get` maintain a session task list shown in the Tasks pill (`todo` timeline item, like the opencode provider).
- **Models** — full live list from `commandcode --list-models` (1h cache, fallback on failure).
- **Modes** — Build / Plan (`--plan`).
- **Effort** — optional per-model selector (low/medium/high/max); omitted by default because valid levels differ per model.
- **Persistence** — native session id + task list stored opaquely; resume via `--session`, replay on reopen (tasks rebuilt from the native transcript).
- **Health** — probes the CLI (`--version`) on session open; a missing binary or failed probe surfaces an actionable notice (which binary, where it's from, `commandcode login` / `commandcode status` hints) instead of a bare ENOENT.
- **Commands** (composer `/` menu, side effects via the CLI):
  - `/status`, `/info`, `/models`, `/mcp-list`
  - `/taste-list`, `/taste-learn [path|owner/repo]`
  - `/skills-list`, `/skills-add <owner/repo>`
  - `/mods-list`, `/mods-add <source>`
- **Skills** — installed skills (`commandcode skills list`) appear in the composer `/` menu and run as agent turns (`/paseo ...`), like other providers.
- Interrupt cancels the running turn (emits `canceled`, no dangling turn).
- Session titles derive from the first prompt when the host provides none.

## Known issues

- Interactive/TTY-only features (`/usage`, `/login`, `/connect`, IDE setup) are unavailable headless — ask for them in the model prompt instead.
- Steering is rejected with a clear error (the CLI has no live-turn channel; v2 may use the Provider API).
- Images need a vision-capable model. `commandcode -p` has no image flag, so attached images are written to a private file under the system temp directory and referenced by path as `[Image available at: …]` — `read_file` turns that path into a real image block for the model. The temp location is required, not incidental: the CLI auto-allows reads only under its temp roots and the workspace, so a file anywhere else (e.g. under `$PASEO_HOME`) comes back `tool_denied` headless and the turn ends with no response. Each file is deleted when its turn ends, so nothing outlives the session that referenced it. Images are capped at 16 MiB; one that is too large is dropped with a warning and the rest of the prompt still runs. The model still has to call `read_file` on the path, and a model without vision reports that it cannot see the image.
- Effort levels are per-model (e.g. deepseek flash accepts only high/max) — the selector is omit-by-default so untouched sessions never error. Models probed as effortless (e.g. MiMo Flash rejects `--effort` at startup) get per-model `thinkingOptions: []` so the host hides the Thinking pill, stale pill values are stripped on model switch, and the turn is retried once without `--effort` instead of failing.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin reload commandcode-provider
paseo plugin logs commandcode-provider
```
