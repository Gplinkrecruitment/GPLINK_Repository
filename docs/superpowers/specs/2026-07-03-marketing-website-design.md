# Marketing Website — Design Spec (2026-07-03)

## Goal

Replace the Wix site at www.mygplink.com.au with a custom marketing website built INTO this app
(same repo, same server.js, same Vercel deployment), in the approved "Premium & Trustworthy"
design (royal blue #116dff / steel navy #2b5672 / sky #4eb7f5, real site video + photos,
scroll animations, merged job-search+stats hero card, heavy GP-Link-app push).
Everything functional: no dead buttons, real data where it exists, real integration into
signup/onboarding, the jobs pipeline, and the admin dashboard.

Approved via interactive prototype: https://claude.ai/code/artifact/11b63824-1df8-4e49-b64c-11c908d5f089

## Architecture decision

**Build into the existing monolith** (Option A). Rationale: deepest integration (same DB,
same session, same deploy), matches existing architecture (vanilla HTML in pages/ served by
server.js), no CORS, one domain. A separate repo/framework (Option B) was rejected — it would
duplicate auth/jobs plumbing and complicate the admin view. Owner later points
www.mygplink.com.au DNS at Vercel (documented owner action; PUBLIC_BASE_URL already
`https://www.mygplink.com.au`).

## Sitemap & routes (all public, no auth)

| URL | File | Content |
|---|---|---|
| `/` | `pages/site-home.html` | Homepage (per approved prototype) |
| `/jobs` | `pages/site-jobs.html` | Job board; reads `?q=&state=&type=` from URL |
| `/jobs/view` | `pages/site-job.html` | Single job detail (`?id=`) |
| `/employers` | `pages/site-employers.html` | Practice pitch + enquiry form |
| `/about` | `pages/site-about.html` | About GP Link + values + contact |
| `/faq` | `pages/site-faq.html` | Accordion FAQ (GP + employer questions) |
| `/the-app` | `pages/site-app.html` | Dedicated GP Link app marketing-flow page |
| `/robots.txt`, `/sitemap.xml` | served by route | SEO |

Routing rules:
- New `SITE_PUBLIC_ROUTES` map in server.js handled **before** the auth wall at ~`server.js:46164`
  (mirror the blog pattern at `:46034`). Marketing pages do **not** include `js/auth-guard.js`,
  are **not** added to `APP_SHELL_SUPPORTED_PATHS` or nav-shell-bridge `PAGE_PATHS`.
- Root `/`: admin-host behaviour unchanged; non-admin hosts: if valid `gp_session` → existing
  `/pages/index` redirect (dashboard); anonymous → serve homepage (200, no redirect).
- Direct `/pages/site-*.html` hits 302 to the clean URLs.
- Existing public pages (`/pages/privacy`, `/pages/terms`, blog) linked from footer, unchanged.

## Shared frontend assets

- `css/site.css` — design tokens + shared header/footer/buttons/reveal styles (css/ is already
  in vercel includeFiles).
- `js/site.js` — sticky header, mobile menu, IntersectionObserver reveals, stat count-up,
  job-search → `/jobs?…` navigation, enquiry form submit, FAQ accordion. No framework.
- Media committed under `media/images/site/` and `media/videos/` (already in includeFiles):
  hero video (720p mp4 from Wix CDN + beach poster jpg), kangaroo jpg, doctor png, logo png,
  4 partner logos. Cache-busted script/style tags per convention (`?v=YYYYMMDD`).

## New public APIs (server.js)

1. `GET /api/public/jobs` — reads the same Zoho-synced data as `/api/career/roles`
   (`career_roles` table + `_zohoRolesCache` helpers) but **without session**. Filters:
   `q` (title/practice/location/tags substring), `state` (matches `location_state`),
   `type` (`vr-gp` | `non-vr-gp` | `locum` mapped against employment/practice/tags fields),
   `limit`/`offset`. Returns sanitized fields only (id, title, practice_name, location_label,
   location_state, billing_model, dpa, mmm, earnings_text, summary, employment_type, tags,
   published_at). Never `source_payload`. Only `is_active`.
2. `GET /api/public/stats` — `{ jobsCount }` live from `career_roles is_active` count, plus
   marketing constants from one `SITE_STATS` config object (locations: 830, avgPlacementDays: 22,
   gpsPlaced: 150, satisfaction: 100) so the owner edits one place. Cached 5 min.
3. `POST /api/public/enquiry` — body `{ kind: 'practice'|'gp'|'general', name, email, phone?,
   practice_name?, state?, message }`. Validation + honeypot field + naive per-IP rate limit
   (in-memory, 5/hour). Writes to new table `site_enquiries`. If admin notification email infra
   is available (env-gated), also send a heads-up email; failure to email never fails the API.

## New table (DDL)

```sql
create table if not exists public.site_enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('practice','gp','general')),
  name text not null,
  email text not null,
  phone text,
  practice_name text,
  state text,
  message text,
  status text not null default 'new' check (status in ('new','contacted','closed')),
  metadata jsonb not null default '{}'::jsonb
);
```
Migration file committed under `supabase/migrations/`; applied to prod via `rpc/exec_sql`
with the service key (per established procedure). JSON-db fallback for local dev.

## Admin integration

- New **Website** tab in `pages/admin.html` (follow existing `data-view` nav pattern):
  lists `site_enquiries` (kind, name, contact, practice, message, age), status buttons
  (new → contacted → closed). Endpoints `GET /api/admin/site-enquiries` +
  `POST /api/admin/site-enquiries/update` (adminSession-gated, same patterns as existing
  admin endpoints).
- New GP signups from the site flow into the **existing** pipeline automatically
  (signup → onboarding → registration_cases) — no new work needed beyond linking CTAs.

## CTA wiring (no dead buttons)

- "Create free account" (header, app section, final CTA, the-app page) →
  `/pages/signin?signup=1` (small addition to signin.html: `signup=1` auto-opens the
  sign-up panel; preserves existing `?next=` behaviour).
- "Sign in" (header) → `/pages/signin`.
- Job search (hero + jobs page) → `/jobs?q=&state=&type=` (real navigation, filters applied
  server-side via /api/public/jobs).
- Job card → `/jobs/view?id=…`; "Apply" on detail → `/pages/signin?signup=1&next=/pages/career`
  (after onboarding the GP lands in the in-app career board where applications actually work).
- "Book a call" → Calendly `https://calendly.com/hello-mygplink/30min` (existing global link),
  target _blank.
- Employers form → POST /api/public/enquiry (kind=practice) with success/error states.
- Footer: real links (privacy, terms, blog, FAQ, employers, about, mailto hello@, Facebook page).
- Header nav on marketing pages: How it works (home section anchor), Jobs, Employers, About,
  The app; right: Sign in + Create free account.

## Page content (from approved prototype + current Wix copy)

- **Home**: video hero + merged search/stats card (live jobsCount in button + stats strip);
  How we help (4 pillars); App push section (phone mockup, 4 features, 4-step flow,
  links to /the-app); Why Australia (dark, kangaroo, 5 perks); Why GP Link (metrics +
  Dr Daniel R. testimonial); partner logos (AHPRA/AMC/AMA/ECFMG, labelled
  "Working within Australia's medical framework" — not "partners", to avoid implying
  endorsement); final account CTA; footer.
- **Jobs**: filter bar (q/state/type synced to URL), result cards (title, practice, location,
  chips: DPA/MMM/billing/type, earnings_text), count header, empty state, loading state,
  pagination (24/page). Sign-up interstitial card mid-list ("Create a free account to get
  matched"). 
- **Job detail**: full summary, chips, earnings, location; Apply CTA (signup deep link);
  "Not right? browse more" back link; related jobs (same state, 3).
- **Employers**: value pitch (access to overseas-trained GPs, end-to-end registration handled,
  DPA/19AB navigation), how it works for practices (3 steps), enquiry form
  (name, practice, email, phone, state, message), testimonial, FAQ subset, final CTA.
- **About**: story/mission, what we handle (registration, visa, placement, relocation),
  values, team contact block (hello@mygplink.com.au, ACN 693 259 737), Calendly CTA.
- **FAQ**: accordions grouped GP / Employers (content adapted from current Wix FAQ + app
  knowledge: pathways, 19AB/DPA, timelines, costs=free for GPs, visa sponsorship, English tests).
- **The app** (`/the-app`): expanded marketing flow — hero with phone mockup, the 6 real
  registration stages explained in plain English (Secure Placement → MyIntealth → AMC →
  AHPRA → PBS & Medicare → Commencement), document-verification value, job matching,
  human RSO support, security/privacy reassurance, big signup CTA. (Visa stage stays
  deferred per docs/deferred-visa-application.md — not mentioned as an in-app step.)

## SEO

- Per-page `<title>` + meta description + OG tags (og:image = beach poster).
- `/robots.txt` (allow all, sitemap pointer) and `/sitemap.xml` (the 7 public URLs) served
  from server routes; canonical URLs use PUBLIC_BASE_URL.

## Testing & verification

- Vitest: public routes return 200 without session (and don't redirect); `/` anonymous serves
  homepage while signed-in redirect preserved; admin-host root unchanged; /api/public/jobs
  filtering (q/state/type/limit + sanitization: no source_payload); /api/public/enquiry
  validation, honeypot, rate limit, DB write; /api/public/stats shape; signin `?signup=1`;
  sitemap/robots content; admin enquiries endpoints auth-gating.
- Manual verification pass: crawl all public pages for dead links/buttons; `node --check server.js`;
  full `npm test` suite green.

## Non-goals / deferred

- No CMS (copy is hardcoded; stats constants centralised in SITE_STATS).
- No public application submission (apply = create account → in-app career flow).
- Blog stays as-is; DNS cutover is an owner action post-merge (site works on the Vercel
  domain immediately; Wix keeps serving www until then).
- Job alerts email subscription (Alecto-style) — later phase.

## Risks / mitigations

- **Auth wall regressions** — the new public routing must not loosen protection of app pages:
  tests assert existing protected pages still redirect.
- **Zoho data gaps** (fields missing on some roles) — job cards degrade gracefully
  (hide missing chips; earnings optional).
- **admin.html size** — Website tab addition follows existing patterns exactly; keep diff tight.
- **Media weight** — video kept to 720p (~4.8MB) with poster-first loading + `preload="none"`
  below the fold; hero uses `preload="metadata"`; page functional with video blocked.
