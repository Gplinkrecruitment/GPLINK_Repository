# Hybrid Codex + Claude Agents

`scripts/agents.js` is the repo's multi-model orchestration entrypoint. It plans a task, routes each subtask to the provider best suited for that role, and keeps a shared memory handoff so later agents inherit the most useful context from earlier ones.

## Default routing

Profile `balanced`:
- `frontend` -> OpenAI/Codex
- `backend` -> OpenAI/Codex
- `database` -> Claude
- `research` -> Claude
- `extrapolation` -> Claude
- `review` -> OpenAI/Codex

Profile `codex-heavy` pushes implementation toward OpenAI/Codex. Profile `claude-heavy` keeps most planning and reasoning on Claude.

## Complexity-aware model allocation

The orchestrator now picks model tiers from task complexity:

- `complex`: use the strongest defaults for redesign, research, architecture, and end-to-end workflow work
  - OpenAI/Codex -> `gpt-5.4`
  - Claude -> `opus`
- `standard`: use the safer middle tier for everyday work
  - OpenAI/Codex -> `gpt-5.4-mini`
  - Claude -> `sonnet`
- `simple`: keep smaller changes on lighter defaults unless you force a higher tier
  - OpenAI/Codex -> `gpt-5.4-mini`
  - Claude -> `sonnet`

Use `--complexity simple|standard|complex` to override auto-detection.
If your installed Claude CLI exposes a versioned Opus 4.6 model name and you want to pin it exactly, set `ANTHROPIC_COMPLEX_MODEL` to that identifier; the default `opus` alias is kept for wider CLI compatibility.

## Collaboration modes

- `single`: use one routed specialist per subtask
- `routed`: route each subtask to one provider, but skip the second-model advisor
- `paired`: run the routed specialist, then send the result to the other provider for critique and shared-context extraction

When both local CLIs are installed and authenticated with your subscriptions, `paired` is the most useful mode because it actually combines both models' context on the same task. If only one subscription-backed CLI is available, the script automatically falls back to routed mode.

## Claude MCP browser-use

If your local Claude Code setup has the `browser-use` MCP connected, the orchestrator now detects it automatically and can let Claude use it for browser/computer walkthrough tasks such as:

- navigating the local app from start to finish
- clicking through GP, VA, or admin flows
- inspecting browser-visible UI states and on-machine flow issues

This is selective, not always-on. The runner only prefers Claude browser-use when the task reads like navigation, walkthrough, browser, or computer inspection work.

Check availability with:

```bash
claude mcp list
```

Example healthy status:

```text
browser-use: ... - ✓ Connected
```

## Live dashboard with local CLIs

If the live site is deployed remotely, it cannot see the `codex` and `claude` CLIs installed on your Mac by itself. The bridge now supports two connection paths:

- direct localhost mode for browsers that allow the live page to call `127.0.0.1`
- secure relay mode for browsers that block localhost fetches from the live HTTPS dashboard

For direct localhost mode:

```bash
npm run agent-bridge
```

That starts a localhost-only bridge at `http://127.0.0.1:4317`. The super-admin Agent tab will try to detect it automatically and, when available, switch control mode from the remote server to your local Mac.

If the live dashboard still shows `Local bridge: Failed to fetch`, open the `Start Bridge` help inside the Agent tab and register a persistent worker instead. That command now looks like:

```bash
/usr/local/Cellar/node@18/18.20.8/bin/node scripts/agent-bridge.js \
  --relay https://ceo.admin.mygplink.com.au \
  --worker-id <worker-id> \
  --token <worker-token>
```

The worker id and token are issued by the super-admin dashboard and identify a persistent remote agent host. Once that machine is registered, the dashboard can target it from any other device, and the same command can be reused after a reboot until that worker is removed from the dashboard.

The dashboard now keeps a registered-worker list so you can:

- create a new persistent worker command
- see which worker is connected
- choose the primary worker the dashboard should target
- remove stale or old workers

What this enables:

- keep using the live `ceo.admin.mygplink.com.au` dashboard
- execute hybrid agent runs through your local Codex CLI login
- execute Claude runs and Claude browser-use MCP from your local machine
- avoid moving back to direct API calls

## Usage

```bash
npm run agents -- "build a new admin queue for pending visa tasks"

node scripts/agents.js \
  --task "add a recruiter-facing dashboard for registration blockers" \
  --profile balanced \
  --collaboration paired

node scripts/agents.js \
  --task "prototype a safer Supabase migration workflow" \
  --profile claude-heavy \
  --complexity complex \
  --apply
```

`--apply` only writes edits back into the repo when every requested `find`/`replace` matched exactly. Otherwise the script leaves the repo untouched and writes reviewable artifacts instead.

## Output layout

Each run writes to `agents-output/<timestamp>/`:

- `plan.json`: raw task breakdown from the planning model
- `resolved-plan.json`: plan plus actual provider/model assignments
- `raw/`: full responses from each primary agent and advisor
- `artifacts/`: `.patched` or `.new` files for review
- `shared-memory.md`: condensed handoff notes collected across subtasks
- `REPORT.md`: summary of the run and file application status

## Environment variables

- `CODEX_CLI_PATH`
- `CLAUDE_CLI_PATH`
- `AGENT_PROFILE`
- `AGENT_COLLABORATION_MODE`
- `AGENT_COMPLEXITY_MODE`
- `AGENT_ENABLE_CLAUDE_BROWSER_USE_MCP`
- `CLAUDE_BROWSER_MCP_NAME`
- `AGENT_BRIDGE_HOST`
- `AGENT_BRIDGE_PORT`
- `AGENT_BRIDGE_ALLOWED_ORIGINS`
- `AGENT_BRIDGE_RELAY_URL`
- `AGENT_BRIDGE_RELAY_TOKEN`
- `AGENT_BRIDGE_WORKER_ID`
- `AGENT_BRIDGE_WORKER_NAME`
- `AGENT_BRIDGE_RELAY_SYNC_MS`
- `HYBRID_AGENT_BRIDGE_STALE_MS`
- `OPENAI_COMPLEX_MODEL`
- `OPENAI_STANDARD_MODEL`
- `OPENAI_SIMPLE_MODEL`
- `OPENAI_COMPLEX_REVIEW_MODEL`
- `OPENAI_STANDARD_REVIEW_MODEL`
- `ANTHROPIC_COMPLEX_MODEL`
- `ANTHROPIC_STANDARD_MODEL`
- `ANTHROPIC_SIMPLE_MODEL`
- `AGENT_MAX_FILE_CONTEXT_CHARS`
- `AGENT_MAX_PLANNER_FILES`
- `AGENT_MAX_SUBTASKS`

## Super-admin dashboard

The master admin dashboard at `pages/admin.html` now exposes an `Agent` tab for `super_admin` users only. It provides:

- launch controls for mixed Codex + Claude runs
- provider connection status plus connect/sync actions
- Claude browser-use MCP status when available
- resolved model-allocation policy for the current draft task
- active run status, current subtask, logs, completed steps, and report preview
- a security summary showing super-admin gating, same-origin protection, single-run safety, and reduced child-process environment handling

## Notes

- The orchestrator uses the local `codex` and `claude` CLIs with your ChatGPT and claude.ai logins instead of making direct API requests from the script.
- It strips `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from child processes so the CLIs stay on subscription auth even if those vars exist for the app itself.
- The server also launches the orchestrator with a reduced environment and disables repo `.env` loading for dashboard-started runs so app secrets are not forwarded into the child agent process.
- If Claude browser-use MCP is connected, Claude subtasks can use it for app/browser walkthrough work without changing the OpenAI/Codex side of the pipeline.
- The script uses a compact repo overview for planning, then focused file snippets for each subtask so prompts stay smaller and more grounded than sending the whole codebase every time.
- Review remains non-destructive by default. The safest workflow is to inspect `artifacts/` and `REPORT.md` before using `--apply`.
