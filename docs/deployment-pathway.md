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

## Step 4 — Push

```bash
git push origin main
```

**Do not rely on the push triggering a deployment.** The GitHub Action (`vercel-deploy.yml`) calls a deploy hook that redeploys a stale commit (`2685559`). It has been broken since April 2026. The push ensures the code is on GitHub but does **not** deploy it.

---

## Step 5 — Deploy via Vercel CLI

The **only** reliable deployment method is the Vercel CLI. The deploy hook and GitHub integration webhook are both broken.

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

### Vercel Hobby Plan — Cron Jobs
Only **daily** cron schedules are allowed (once per 24 hours). Any schedule more frequent than daily (e.g. `*/15 * * * *`, `0 */6 * * *`) will cause the deploy to fail with:

> Hobby accounts are limited to daily cron jobs.

Current valid cron schedules in `vercel.json`:

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/process-gmail` | `0 0 * * *` | Daily Gmail processing (GitHub Action handles frequent polling) |
| `/api/cron/renew-gmail-watch` | `0 6 * * *` | Daily Gmail watch renewal |
| `/api/cron/refresh-zoho-sign-token` | `0 0 * * *` | Daily Zoho Sign token refresh |
| `/api/integrations/zoho-recruit/cron-sync` | `0 6 * * *` | Daily Zoho Recruit sync |
| `/api/cron/reconcile-followups` | `0 20 * * *` | Daily followup reconciliation |
| `/api/cron/interview-reminders` | `0 21 * * *` | Daily interview reminders |

If you need more frequent execution, use GitHub Actions (see `.github/workflows/gmail-poll.yml`).

### Build Warnings
The Vercel build shows TypeScript errors from `supabase/functions/normalize-scan-image/index.ts`. These are Deno-specific imports (`npm:` specifiers, `Deno.serve`) that the Vercel TypeScript checker doesn't understand. They are **non-blocking** — the deployment succeeds despite these warnings.

### Broken Deploy Hook
The deploy hook (`manual-deploy` / `uERMhHFt41`) redeploys from a cached/stale commit rather than fetching the latest from GitHub. **Do not use it for production deploys.** Always use `vercel --prod` from the CLI.

---

## Quick Reference

```bash
# Full deploy sequence (copy-paste ready)
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add <files>
git commit -m "$(cat <<'EOF'
type: description

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
NODE_TLS_REJECT_UNAUTHORIZED=0 /usr/local/Cellar/node@18/18.20.8/bin/vercel --prod --yes
```
