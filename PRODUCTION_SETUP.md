# Production Setup (GitHub + Vercel)

## 1. Repository hygiene before push
1. Use the included `.gitignore` so secrets and local artifacts are not committed:
   - `.env`
   - `data/app-db.json`
   - `backups/`
   - `*.zip`
2. Keep only `.env.example` in GitHub.
3. Admin panel is excluded from this release (`pages/admin.html` is blocked and ignored).

## 2. Vercel project configuration
1. Import this GitHub repository into Vercel.
2. Framework preset: `Other`.
3. Build command: leave empty.
4. Output directory: leave empty.
5. Install command: leave empty (no dependencies required).

## 3. Vercel environment variables
Add these in Vercel Project Settings -> Environment Variables:

- `NODE_ENV=production`
- `AUTH_DISABLED=false`
- `AUTH_SECRET=<strong-random-secret>`
- `COOKIE_SECURE=true`
- `SUPABASE_URL=<your-supabase-url>`
- `SUPABASE_PUBLISHABLE_KEY=<your-supabase-publishable-key>`
- `SUPABASE_SERVICE_ROLE_KEY=<your-supabase-service-role-key>` (server-side only)

Optional:
- `DB_FILE_PATH=/tmp/app-db.json` (default on Vercel already uses `/tmp`)
- `OTP_TTL_MS`, `OTP_MAX_ATTEMPTS`, `RATE_WINDOW_MS`, `RATE_MAX_SEND`, `SESSION_TTL_MS`, `MAX_JSON_BODY_BYTES`

## 4. Routing and runtime
- `vercel.json` routes all traffic to `server.js`.
- Runtime is `nodejs20.x`.
- `/pages/admin.html` returns `404` in this deployment.

## 5. Health check
- Endpoint: `GET /api/health`
- Expected response includes: `ok: true` and `status: "healthy"`.

## 6. Important Vercel limitation
This app currently stores state in a JSON file. On Vercel, filesystem writes are ephemeral (`/tmp`) and do not persist across deployments/instances.

Impacted server-side data:
- Session records
- OTP challenges
- Rate-limit counters
- Profile/state data in local JSON store

For durable production data, move these records to a managed database (for example Supabase Postgres) before scaling.
