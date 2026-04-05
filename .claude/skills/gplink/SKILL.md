---
name: gplink
description: Enter GP Link mode. Use when working in this repository or when you want Claude to load the latest shared GP Link memory, follow the GP Link team-lead workflow, and handle a GP Link task or handoff.
argument-hint: [task]
disable-model-invocation: true
---

Enter GP Link mode for this repository.

Always start by loading and using these files if they exist:

- `AGENTS.md`
- `CLAUDE.md`
- `agents-output/memory/latest-session.md`
- `agents-output/memory/knowledge-base.md`

Treat `agents-output/memory/latest-session.md` as the newest Codex <-> Claude handoff.
Treat `agents-output/memory/knowledge-base.md` as durable cross-run memory.

## Team-lead workflow

For meaningful GP Link work, act as the team lead first:

1. Research the repo and understand the affected GP Link flows.
2. Extrapolate risks, edge cases, and rollout implications yourself.
3. Plan the work around these fixed execution roles:
   - `frontend`: UI and UX implementation
   - `backend`: server-side plus grounded Supabase work
   - `security`: auth, secret handling, injection, unsafe trust boundaries
   - `alignment`: GP Link workflow fit, recruiter/GP user fit, hallucination cleanup, final integration

Do not create separate research or extrapolation execution agents for normal GP Link work. The team lead owns that reasoning before delegation.

## When a task argument is provided

Use `$ARGUMENTS` as the active GP Link task.

- If the task is substantial, prefer the orchestrator:

```bash
npm run gplink -- "$ARGUMENTS"
```

- If you are working directly in Claude Code instead of launching the orchestrator, keep the shared handoff fresh before you finish:

```bash
node scripts/agent-memory.js handoff \
  --source claude \
  --task "$ARGUMENTS" \
  --summary "what changed and what matters" \
  --files "path/one,path/two" \
  --next "what Codex or the next Claude session should do next"
```

- If you discover a durable GP Link rule worth reusing across runs, record it too:

```bash
node scripts/agent-memory.js learn \
  --source claude \
  --role alignment \
  --text "durable GP Link learning" \
  --files "pages/admin.html,server.js"
```

Merge with existing memory instead of overwriting it.

## Response style

When `/gplink` is invoked without a task, briefly summarize:

1. the latest shared memory state
2. the current GP Link team structure
3. the recommended next prompt or orchestrator command
