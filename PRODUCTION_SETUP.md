# Production Setup (GitHub + Vercel)

## 1. Repository hygiene before push
1. Use the included `.gitignore` so secrets and local artifacts are not committed:
   - `.env`
   - `data/app-db.json`
   - `backups/`
   - `*.zip`
2. Keep only `.env.example` in GitHub.
3. Admin panel is protected by dedicated admin session + `ADMIN_EMAILS` allowlist + host allowlist.

## 2. Deploy as two surfaces (best practice)
Create two Vercel projects from the same repo:

1. Public app surface (for candidates/users), e.g. `app.mygplink.com.au`
2. Internal admin surface, e.g. `admin.mygplink.com.au`

Both projects can use the same codebase; access is separated by host-based admin allowlisting.

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
- `ADMIN_EMAILS=<comma-separated-admin-emails>` (required for admin access)
- `ADMIN_ALLOWED_HOSTS=admin.mygplink.com.au` (required in production; restricts `/pages/admin*.html` and `/api/admin/*`)
- `ADMIN_COOKIE_NAME=gp_admin_session` (optional override)
- `ADMIN_SESSION_TTL_MS=28800000` (optional, default 8 hours)

Optional:
- `DB_FILE_PATH=/tmp/app-db.json` (default on Vercel already uses `/tmp`)
- `OTP_TTL_MS`, `OTP_MAX_ATTEMPTS`, `RATE_WINDOW_MS`, `RATE_MAX_SEND`, `SESSION_TTL_MS`, `MAX_JSON_BODY_BYTES`
- `AUTH_RATE_WINDOW_MS`, `AUTH_RATE_MAX_ATTEMPTS`

## 5. Routing and runtime
- `vercel.json` routes all traffic to `server.js`.
- Runtime is `nodejs20.x`.
- `/pages/admin.html` is protected by admin-auth cookie + `ADMIN_EMAILS` + `ADMIN_ALLOWED_HOSTS`.
- Admin login is separate: `/pages/admin-signin.html` + `/api/admin/auth/login`.
- Normal sign in (`/pages/signin.html`) does not grant admin session.

## 6. Admin access behavior
- If request host is not in `ADMIN_ALLOWED_HOSTS`, admin pages/APIs return `404`.
- Admin dashboard requires a dedicated `gp_admin_session` cookie.
- Only emails listed in `ADMIN_EMAILS` can sign in to admin.

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
- Runtime security counters (auth rate limits) are persisted in Supabase table `public.runtime_kv`.
- OTP code endpoints (`/api/auth/send-code`, `/api/auth/verify-code`) are disabled when `REQUIRE_SUPABASE_DB=true`.

## 10. Apply Supabase migrations
After pulling latest code, run:

1. `supabase link --project-ref <your-project-ref>`
2. `supabase db push`

This applies required schema, including `public.runtime_kv`.
