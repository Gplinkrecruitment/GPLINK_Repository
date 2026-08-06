# Deployment Pathway

Complete commit-to-production pathway for GP Link. Every session must follow these steps in order.

---

## Step 1 — Review Changes

```bash
git status
git diff
git diff --cached
```

Identify what needs to be committed. **Never commit:**
- `.env.vercel` — contains pulled Vercel secrets
- `.env`, `.env.local` — local environment files
- `data/app-db.backup-*.json` — database backups
- Screenshot files (`.png`, `.jpg`) scattered outside `media/images/`

---

## Step 2 — Stage Files

Stage specific files by name. **Do not use `git add -A` or `git add .`** — this risks committing secrets or large binaries.

```bash
git add file1 file2 ...
```

Verify what's staged:

```bash
git diff --cached --stat
```

---

## Step 3 — Commit

Use a descriptive commit message with the Co-Authored-By trailer:

```bash
git commit -m "$(cat <<'EOF'
type: short description of change

Optional longer explanation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Step 4 — Push (this deploys)

```bash
git push origin main          # from a worktree branch: git push origin HEAD:main
```

**Pushing to `main` auto-deploys to production.** The native Vercel↔GitHub integration builds the exact commit you pushed and promotes it to production (aliased to `app.mygplink.com.au`, and since the 2026-07-26 cutover, `www.mygplink.com.au` + the apex). A push to any *other* branch produces a preview deployment instead, not production.

Verified 2026-07-26 against Vercel's own deployment log (`list_deployments`): **every** `main` commit over the prior two days produced a `target: production`, `state: READY` deployment sourced from **git** (never the CLI) — e.g. `2e75eb7`, `87b7c8b`, `e3c7391`, `b969666`, `abf87a0`. Give it ~1–2 min, then verify (Step 6). **No manual deploy step is required for the normal flow.**

> ⚠️ Historical note — do not confuse two different mechanisms. An OLD path (the GitHub Action `vercel-deploy.yml` calling a Vercel *deploy hook*) was broken — it redeployed a stale commit `2685559` — and is deliberately disabled (`workflow_dispatch` only, do NOT re-enable). That deploy **hook** is a *different thing* from the native git integration above, which works. Earlier revisions of this doc said "the push does not deploy — use the CLI"; that is **no longer true**.

---

## Step 5 — Deploy via Vercel CLI (fallback only)

Not needed for the normal flow — Step 4 deploys. Use the CLI only to force a redeploy **without** a new commit, or if the git integration is ever confirmed down. The deploy hook remains broken; the CLI is the fallback, git push to `main` is the default.

### Vercel CLI location

```
/usr/local/Cellar/node@18/18.20.8/bin/vercel
```

npm/npx are at the same path. The system `$PATH` does not include this directory, so always use the full path.

### Deploy command

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
NODE_TLS_REJECT_UNAUTHORIZED=0 /usr/local/Cellar/node@18/18.20.8/bin/vercel --prod --yes
```

- `NODE_TLS_REJECT_UNAUTHORIZED=0` — required because macOS has a TLS certificate chain issue with Node 18. Without this, the CLI fails with `unable to get local issuer certificate`.
- `--prod` — deploys to production (aliases to `app.mygplink.com.au`).
- `--yes` — skips interactive prompts.

### Expected output

A successful deploy shows:

```
Production: https://gplink-repository-XXXXX-gplinkrecruitments-projects.vercel.app
Aliased: https://app.mygplink.com.au
```

With `"readyState": "READY"` in the JSON output.

---

## Step 6 — Verify

Confirm the deployment is live:

1. Check the Vercel dashboard or use the MCP tool `list_deployments` with:
   - `projectId`: `prj_LeHg7obiXjySqpjR23S46QmwSLXJ`
   - `teamId`: `team_CZsGx8ESlTxQ3Uc9sHG23vCY`
2. Verify the `githubCommitSha` in the latest deployment matches the pushed HEAD.
3. Optionally visit `https://app.mygplink.com.au` to confirm the site loads.

---

## Known Constraints

### Cron Jobs — sub-daily schedules are fine (Pro plan)
This section previously documented a Hobby-plan limit of one run per day. That no
longer applies: the project is on a paid plan and `vercel.json` runs sub-daily
schedules in production (`*/5` for `call-reminders`, `*/10` for `detect-no-shows`,
`*/15` for `process-gmail`). On Hobby those would fail the build outright with
"Hobby accounts are limited to daily cron jobs" — they deploy, so the limit is gone.

`vercel.json` is the single source of truth for schedules. **Do not add a cron
without also adding it to `CRON_SCHEDULES` in `server.js`** — that map drives the
overdue detection behind `GET /api/admin/cron-health` and the daily error digest.
`tests/error-fix-endpoints.test.js` asserts the two agree on every job, so drift
fails CI rather than silently disabling a job's health alarm.

Do NOT reach for GitHub Actions to get a faster cadence. It was tried for the Gmail
poll (`.github/workflows/gmail-poll.yml`, deleted 2026-08-07) and it does not work:
GitHub throttles scheduled workflows on public repos hard — a declared `*/15`
(96 runs/day) actually delivered **7–17 runs/day** — and its runner-allocation
failures ("The job was not acquired by Runner of type hosted") emailed the owner a
"Run failed" notice each time. Vercel crons fire on schedule; use them.

### Build Warnings
The Vercel build shows TypeScript errors from `supabase/functions/normalize-scan-image/index.ts`. These are Deno-specific imports (`npm:` specifiers, `Deno.serve`) that the Vercel TypeScript checker doesn't understand. They are **non-blocking** — the deployment succeeds despite these warnings.

### Broken Deploy Hook (NOT the git integration)
The deploy **hook** (`manual-deploy` / `uERMhHFt41`) redeploys from a cached/stale commit rather than fetching the latest from GitHub. **Do not use the hook.** This is a separate mechanism from the native Vercel↔GitHub integration, which *does* deploy the exact pushed commit — see Step 4. Normal deploy = `git push origin main`; the CLI (`vercel --prod`) is only a fallback.

---

## Quick Reference

```bash
# Full deploy sequence (copy-paste ready) — git push IS the deploy
git add <files>                 # specific files only, never git add -A
git commit -m "$(cat <<'EOF'
type: description

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push origin main            # from a worktree branch: git push origin HEAD:main
# → Vercel auto-builds & promotes this commit to production (~1–2 min). Verify with Step 6.
# The Vercel CLI (Step 5) is a fallback, not part of the normal flow.
```
