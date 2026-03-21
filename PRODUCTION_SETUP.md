# Production Setup (GitHub + Vercel)

## 1. Repository hygiene before push
1. Use the included `.gitignore` so secrets and local artifacts are not committed:
   - `.env`
   - `data/app-db.json`
   - `backups/`
   - `*.zip`
2. Keep only `.env.example` in GitHub.
3. Admin panel is protected by dedicated admin session + role-aware host allowlists.

## 2. Deploy as separate surfaces (best practice)
Create separate Vercel surfaces from the same repo:

1. Public app surface (for candidates/users), e.g. `app.mygplink.com.au`
2. Internal admin surface, e.g. `admin.mygplink.com.au`
3. CEO / super-admin surface, e.g. `ceo.admin.mygplink.com.au` (recommended)

All surfaces can use the same codebase; access is separated by host-based admin allowlisting plus admin roles.

## 3. Vercel project configuration
1. Import this GitHub repository into Vercel.
2. Framework preset: `Other`.
3. Build command: leave empty.
4. Output directory: leave empty.
5. Install command: leave empty (no dependencies required).

## 4. Vercel environment variables
Add these in Vercel Project Settings -> Environment Variables:

- `NODE_ENV=production`
- `AUTH_DISABLED=false`
- `AUTH_SECRET=<strong-random-secret>`
- `COOKIE_SECURE=true`
- `ENFORCE_SAME_ORIGIN=true` (blocks cross-site writes to `/api/*`)
- `REQUIRE_SUPABASE_DB=true` (recommended: disables critical local JSON fallbacks)
- `SUPABASE_URL=<your-supabase-url>`
- `SUPABASE_PUBLISHABLE_KEY=<your-supabase-publishable-key>`
- `SUPABASE_SERVICE_ROLE_KEY=<your-supabase-service-role-key>` (server-side only)
- `SUPABASE_SCAN_NORMALIZER_FUNCTION=normalize-scan-image` (recommended; used for App Store-safe image normalization before AI scans)
- `ZOHO_RECRUIT_CLIENT_ID=<your-zoho-client-id>` (server-side only)
- `ZOHO_RECRUIT_CLIENT_SECRET=<your-zoho-client-secret>` (server-side only)
- `ZOHO_RECRUIT_ACCOUNTS_SERVER=https://accounts.zoho.com` (or your Zoho data-center accounts server)
- `ZOHO_RECRUIT_REDIRECT_URI=https://app.mygplink.com.au/api/integrations/zoho-recruit/callback`
- `ZOHO_RECRUIT_SCOPES=ZohoRecruit.modules.all,ZohoRecruit.modules.attachments.all,ZohoRecruit.search.READ`
- `ZOHO_RECRUIT_SYNC_CRON_SECRET=<strong-random-secret>` (recommended if using scheduled sync)
- `ADMIN_ALLOWED_HOSTS=admin.mygplink.com.au` (required in production; employee admin hostnames)
- `SUPER_ADMIN_ALLOWED_HOSTS=ceo.admin.mygplink.com.au` (recommended; super-admin-only hostname)
- `ADMIN_EMAILS=<comma-separated-bootstrap-admin-emails>` (optional fallback/bootstrap allowlist)
- `SUPER_ADMIN_EMAILS=<comma-separated-bootstrap-super-admin-emails>` (optional fallback/bootstrap allowlist)
- `ADMIN_COOKIE_NAME=gp_admin_session` (optional override)
- `ADMIN_SESSION_TTL_MS=28800000` (optional, default 8 hours)

Optional:
- `DB_FILE_PATH=/tmp/app-db.json` (default on Vercel already uses `/tmp`)
- `OTP_TTL_MS`, `OTP_MAX_ATTEMPTS`, `RATE_WINDOW_MS`, `RATE_MAX_SEND`, `SESSION_TTL_MS`, `MAX_JSON_BODY_BYTES`
- `AUTH_RATE_WINDOW_MS`, `AUTH_RATE_MAX_ATTEMPTS`

## 5. Routing and runtime
- `vercel.json` routes all traffic to `server.js`.
- Runtime is `nodejs20.x`.
- `/pages/admin.html` is protected by admin-auth cookie + admin role + host allowlists.
- Admin login is separate: `/pages/admin-signin.html` + `/api/admin/auth/login`.
- Normal sign in (`/pages/signin.html`) does not grant admin session.

## 6. Admin access behavior
- If request host is not in `ADMIN_ALLOWED_HOSTS` or `SUPER_ADMIN_ALLOWED_HOSTS`, admin pages/APIs return `404`.
- Admin dashboard requires a dedicated `gp_admin_session` cookie.
- `admin.mygplink.com.au` accepts `staff`, `admin`, and `super_admin`.
- `ceo.admin.mygplink.com.au` accepts `super_admin` only.
- Preferred source of truth is `public.user_roles`; env email lists are bootstrap fallbacks.

## 6a. Seed admin roles
Add internal users to `public.user_roles` after their auth accounts exist.

Example SQL:

```sql
insert into public.user_roles (user_id, role)
select id, 'admin'
from auth.users
where email = 'employee@mygplink.com.au'
on conflict (user_id) do update
set role = excluded.role,
    updated_at = now();

insert into public.user_roles (user_id, role)
select id, 'super_admin'
from auth.users
where email = 'ceo@mygplink.com.au'
on conflict (user_id) do update
set role = excluded.role,
    updated_at = now();
```

Allowed role values:
- `staff`
- `admin`
- `super_admin`

## 7. Health check
- Endpoint: `GET /api/health`
- Expected response includes: `ok: true` and `status: "healthy"`.

## 8. Important Vercel limitation
This app currently stores state in a JSON file. On Vercel, filesystem writes are ephemeral (`/tmp`) and do not persist across deployments/instances.

Impacted server-side data:
- Session records
- OTP challenges
- Rate-limit counters
- Profile/state data in local JSON store

For durable production data, move these records to a managed database (for example Supabase Postgres) before scaling.

## 9. Publish-ready security defaults
- Mutating API requests (`POST/PUT/PATCH/DELETE`) enforce same-origin checks using `Origin/Referer` when `ENFORCE_SAME_ORIGIN=true`.
- Security headers are enabled on API/static responses (`nosniff`, `X-Frame-Options`, strict referrer policy, and HSTS in production).
- If `REQUIRE_SUPABASE_DB=true`, critical APIs (`/api/profile`, `/api/state`, admin dashboard/tickets) require Supabase DB configuration and will not silently fall back to local JSON.
- If `REQUIRE_SUPABASE_DB=true`, server-side local JSON persistence is disabled for production runtime paths.
- Runtime security counters (auth rate limits) are persisted in Supabase table `public.runtime_kv`.
- OTP code endpoints (`/api/auth/send-code`, `/api/auth/verify-code`) are disabled when `REQUIRE_SUPABASE_DB=true`.

## 10. Apply Supabase migrations
After pulling latest code, run:

1. `supabase link --project-ref <your-project-ref>`
2. `supabase db push`
3. `supabase functions deploy normalize-scan-image`

This applies required schema, including `public.runtime_kv`, and deploys the Supabase Edge Function used to normalize uploaded images before AI scanning.

## 11. Connect Zoho Recruit
1. In Zoho API Console, create a server-based OAuth client.
2. Set the redirect URI to your live app callback:
   - `https://app.mygplink.com.au/api/integrations/zoho-recruit/callback`
3. Add the Zoho env vars above to Vercel.
4. Sign in to the employee admin portal with an account assigned `staff`, `admin`, or `super_admin`, then open:
   - `https://admin.mygplink.com.au/pages/admin.html`
5. If Zoho was already connected with older scopes, click `Reconnect Zoho Recruit` from the admin dashboard once after deploy so Zoho issues a refresh token with the expanded permissions required for applications, contacts, search, and contract attachments.
6. After consent, GP Link stores the refresh token in Supabase table `public.integration_connections`.
7. GP Link syncs Zoho `JobOpenings` into `public.career_roles`.
8. Candidate-facing Career UI reads from GP Link `/api/career/roles`, not from Zoho directly.

## 12. Scheduled Zoho sync
- Secure endpoint: `GET /api/integrations/zoho-recruit/cron-sync`
- Authenticate with header:
  - `Authorization: Bearer <ZOHO_RECRUIT_SYNC_CRON_SECRET>`
- This endpoint skips if a successful sync already ran in the last ~45 seconds and uses a short lock to reduce overlapping runs.
- Vercel Hobby does not support per-minute cron schedules. Use one of:
  - Vercel Pro cron with `* * * * *`
  - an external scheduler such as GitHub Actions, cron-job.org, or Upstash QStash calling the secure endpoint every 15 minutes
- This repo includes a ready-to-use GitHub Actions workflow at `.github/workflows/zoho-recruit-sync.yml`.
- To enable it:
  1. Set `ZOHO_RECRUIT_SYNC_CRON_SECRET` in Vercel.
  2. Add the same value as a GitHub repository secret named `ZOHO_RECRUIT_SYNC_CRON_SECRET`.
  3. Keep the workflow enabled; it will call `https://app.mygplink.com.au/api/integrations/zoho-recruit/cron-sync` every 15 minutes.
- Recommended cadence in production is usually every 5-15 minutes unless job openings change extremely frequently.
