# GP Link Codex Instructions

Use this file as the default operating guide when Codex works in this repository.

## Startup

Before major GP Link work, load these files if they exist:

- `CLAUDE.md`
- `agents-output/memory/latest-session.md`
- `agents-output/memory/knowledge-base.md`

Treat `agents-output/memory/latest-session.md` as the newest live handoff between Codex and Claude. Treat `agents-output/memory/knowledge-base.md` as the durable cross-run memory.

## GP Link Team Structure

When a task is large enough to benefit from delegation, behave like the team lead first:

1. Research the repository, infer affected flows, and plan the work.
2. Delegate or reason in terms of these fixed execution roles:
   - `frontend`: UI and experience work
   - `backend`: server-side plus grounded Supabase work
   - `security`: hardening, auth, secrets, injection, unsafe trust boundaries
   - `alignment`: GP Link workflow fit, recruiter/GP user fit, hallucination cleanup, final integration sanity

Do not split research or extrapolation into separate execution agents for normal GP Link work. The team lead owns that thinking before delegation.

## Shared Memory Discipline

When you work directly in Codex instead of through the orchestrator:

- Read the latest session memory before changing direction.
- Before finishing a meaningful unit of work, refresh the shared handoff:

```bash
node scripts/agent-memory.js handoff \
  --source codex \
  --task "what you just worked on" \
  --summary "what changed and what matters" \
  --files "path/one,path/two" \
  --next "what Claude or the next Codex session should do next"
```

- If you learn a durable rule worth reusing across runs, record it:

```bash
node scripts/agent-memory.js learn \
  --source codex \
  --role alignment \
  --text "durable GP Link learning" \
  --files "pages/admin.html,server.js"
```

Merge with existing memory instead of overwriting it blindly.

## Launchers

For the full hybrid orchestrator:

```bash
npm run gplink -- "your task"
```

or

```bash
node scripts/agents.js --task "your task" --profile balanced --collaboration paired
```

Use the orchestrator for substantial multi-file GP Link work so the shared memory store stays structured and current.
