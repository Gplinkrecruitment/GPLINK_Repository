# Hybrid Codex + Claude Agents

`scripts/agents.js` is the repo's multi-model orchestration entrypoint. It plans a task, routes each subtask to the provider best suited for that role, keeps a shared memory handoff so later agents inherit the most useful context from earlier ones, and now maintains both a persistent retrieval memory store and a live cross-tool handoff file across runs.

## GP Link team structure

The team lead handles research, extrapolation, understanding, and planning before it delegates to these fixed execution agents:

- `frontend` -> UI and experience implementation, usually OpenAI/Codex
- `backend` -> server-side plus grounded Supabase work, usually OpenAI/Codex with Claude advisor support
- `security` -> auth, secret handling, injection, and hardening pass, usually Claude
- `alignment` -> GP Link product fit, hallucination cleanup, and final integration pass, usually Claude

The orchestrator enforces that order so the security and final GP Link alignment passes always happen after implementation.

Profile `codex-heavy` pushes more implementation toward OpenAI/Codex. Profile `claude-heavy` keeps more planning and reasoning on Claude.

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

## Persistent memory and learning

The orchestrator now keeps two memory layers:

- run memory: `shared-memory.md` captures the most important handoff context between subtasks in the current run
- persistent memory: `agents-output/memory/knowledge-base.json` and `knowledge-base.md` keep reusable lessons from earlier runs
- live cross-tool handoff: `agents-output/memory/latest-session.md` keeps the newest Codex <-> Claude working memory so you can switch tools mid-stream

How it behaves:

- the planner receives relevant prior learnings before it breaks the work into subtasks
- each specialist and advisor receives only the memory entries most relevant to that role, task wording, and planned file set
- new summaries, shared-context notes, findings, risks, and review issues are normalized into durable memory after each subtask completes
- repeated learnings are merged instead of duplicated, and reused entries get a higher relevance score over time
- the latest-session handoff file is refreshed during orchestrator runs so Codex and Claude can pick up the newest context when you switch tools

This is retrieval-based learning, not model fine-tuning. The agents do not silently change their underlying model weights; they reuse structured memory that you can inspect, version, and delete.

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

npm run gplink -- "build a new admin queue for pending visa tasks"

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

## Codex and Claude entrypoints

Codex:

- repo startup instructions now live in `AGENTS.md`
- Codex should read:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `agents-output/memory/latest-session.md`
  - `agents-output/memory/knowledge-base.md`

Claude:

- project slash command now lives at `.claude/skills/gplink/SKILL.md`
- invoke it with:

```text
/gplink
```

or

```text
/gplink redesign the master admin dashboard to control the hybrid agent workflow
```

Claude's `/gplink` skill is designed to load the same shared memory files Codex uses.
When you pass a task, the skill now acts as a wrapper:

- writes the task into `agents-output/memory/latest-session.md`
- launches the hybrid orchestrator as the default path for serious prompts
- returns a compact report preview plus the latest memory/report paths back into Claude
- detects local absolute file references in the task and ingests them as attachment context before launch

Attachment ingestion behavior:

- text/code files: inline extracted text is appended to the orchestrator task
- PDFs/RTF docs: Spotlight text extraction is used when available
- images like PNG/JPG/HEIC: the wrapper runs local OCR on macOS and appends extracted text plus image metadata
- the wrapper also writes an audit artifact at `agents-output/<run-id>/local-references.md`

The wrapper prefers:

```bash
npm run gplink -- --task "your task" --run-id "<generated-run-id>"
```

and falls back to the direct Node entrypoint if `npm` is not available in the session environment.

Manual memory sync between direct Codex and direct Claude sessions:

```bash
npm run gplink:memory -- handoff \
  --source codex \
  --task "what you just worked on" \
  --summary "what changed" \
  --files "pages/admin.html,server.js" \
  --next "what the next Claude or Codex session should do"
```

Durable learning update:

```bash
npm run gplink:memory -- learn \
  --source claude \
  --role alignment \
  --text "Use same-origin plus super-admin gating on hybrid-agent launch endpoints." \
  --files "server.js,pages/admin.html"
```

## Output layout

Each run writes to `agents-output/<timestamp>/`:

- `plan.json`: raw task breakdown from the planning model
- `resolved-plan.json`: plan plus actual provider/model assignments
- `raw/`: full responses from each primary agent and advisor
- `artifacts/`: `.patched` or `.new` files for review
- `shared-memory.md`: condensed handoff notes collected across subtasks
- `persistent-memory-recall.md`: what prior learnings were recalled for planning and each subtask
- `learned-memory.md`: the new reusable learnings captured from this run
- `REPORT.md`: summary of the run and file application status

Persistent cross-run memory lives outside each run folder:

- `agents-output/memory/knowledge-base.json`
- `agents-output/memory/knowledge-base.md`
- `agents-output/memory/latest-session.md`

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
- `AGENT_ENABLE_PERSISTENT_MEMORY`
- `AGENT_MEMORY_MAX_ENTRIES`
- `AGENT_MEMORY_RECALL_ITEMS`
- `AGENT_MEMORY_RECALL_CHARS`

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
- Persistent memory is retrieval-only and file-aware, so agents can share lessons safely without pretending they have magically retrained themselves.
- `AGENTS.md` and Claude's `/gplink` skill both point at the same shared memory files so you can switch between Codex and Claude with the latest handoff context.
- Review remains non-destructive by default. The safest workflow is to inspect `artifacts/` and `REPORT.md` before using `--apply`.
