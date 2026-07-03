# Marketing Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public marketing website (7 pages) built into server.js replacing the Wix site, wired to real jobs data, signup/onboarding, and a new admin enquiries view.

**Architecture:** Vanilla HTML pages in `pages/site-*.html` served by new public routes in server.js registered BEFORE the auth wall (mirror the blog pattern at `server.js:46034`). Shared design system in `css/site.css` + `js/site.js`. Three new public APIs (`/api/public/jobs|stats|enquiry`), one new table (`site_enquiries`), one new admin tab. Design source of truth: `docs/mockups/marketing-homepage-prototype.html` (the user-approved prototype).

**Tech Stack:** Node http server (no framework), vanilla JS/CSS, Supabase REST via `supabaseDbRequest`, vitest.

## Global Constraints

- Palette: royal blue `#116dff`, steel navy `#2b5672`, dark navy `#14324c`, sky `#4eb7f5`, soft `#e8f2ff`, bg `#f7fafd`, line `#dce6ee` (exactly the tokens in the prototype `:root`).
- Marketing pages must NOT include `js/auth-guard.js`, must NOT be added to `APP_SHELL_SUPPORTED_PATHS` (server.js:5826) or `js/nav-shell-bridge.js` `PAGE_PATHS`.
- Public URLs: `/` `/jobs` `/jobs/view` `/employers` `/about` `/faq` `/the-app` (+ `/robots.txt` `/sitemap.xml`).
- Cache busters `?v=20260703` on all script/style tags (convention).
- Never expose `source_payload` or any non-whitelisted job field publicly.
- Existing behaviour preserved: admin-host root redirect, signed-in `/` → `/pages/index`, all currently-protected pages stay protected. Never weaken `shouldProtectPath`/auth wall for non-site pages.
- Copy tone: plain English, Australian spelling, brand name "GP Link". Free-for-doctors messaging. Partner logos labelled "Working within Australia's medical framework".
- Every button/link on every page must navigate somewhere real (anchors, pages, mailto, Calendly `https://calendly.com/hello-mygplink/30min`, or `/pages/signin?signup=1[&next=…]`). No `href="#"` in final pages.
- After every task: run the task's tests + `node --check server.js` (when server.js touched) + commit.

---

### Task 1: Media assets + design reference

**Files:**
- Create: `media/images/site/logo.png`, `media/images/site/beach-poster.jpg`, `media/images/site/kangaroo.jpg`, `media/images/site/doctor-sydney.png`, `media/images/site/partner-ahpra.png`, `media/images/site/partner-ecfmg.png`, `media/images/site/partner-ama.png`, `media/images/site/partner-amc.png`
- Create: `media/videos/site-hero-beach.mp4`
- Create: `docs/mockups/marketing-homepage-prototype.html`

**Interfaces:**
- Produces: the asset paths above, referenced verbatim by Tasks 6–12.

- [ ] **Step 1: Copy assets from the session tmp dir** (they were already downloaded from the live Wix CDN):

```bash
SRC="/Users/gplinkrecruitment/.claude/jobs/a09cdebf/tmp"
DST="/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/marketing-website"
mkdir -p "$DST/media/images/site"
cp "$SRC/imgs/logo.png"        "$DST/media/images/site/logo.png"
cp "$SRC/imgs/poster1.jpg"     "$DST/media/images/site/beach-poster.jpg"
cp "$SRC/imgs/poster2.jpg"     "$DST/media/images/site/kangaroo.jpg"
cp "$SRC/imgs/doctor.png"      "$DST/media/images/site/doctor-sydney.png"
cp "$SRC/imgs/p-ahpra.png"     "$DST/media/images/site/partner-ahpra.png"
cp "$SRC/imgs/p-ecfmg.png"     "$DST/media/images/site/partner-ecfmg.png"
cp "$SRC/imgs/p-ama.png"       "$DST/media/images/site/partner-ama.png"
cp "$SRC/imgs/p-amc.png"       "$DST/media/images/site/partner-amc.png"
cp "$SRC/imgs/hero.mp4"        "$DST/media/videos/site-hero-beach.mp4"
cp "$SRC/gplink-premium.template.html" "$DST/docs/mockups/marketing-homepage-prototype.html"
```

- [ ] **Step 2: Verify** — `file` each copied asset (PNG/JPEG/MP4 as expected), sizes: video ≈4.8MB, no file 0 bytes.
- [ ] **Step 3: Commit** — `git add media docs/mockups && git commit -m "Site: add marketing media assets + approved design prototype"`

---

### Task 2: Public routing foundation (server.js)

**Files:**
- Modify: `server.js` — near the blog block (`server.js:46034-46042`), the root redirect (`:46021-46032`), the clean-URL 302 (`:46004`), `isPublic` (`:46076`)
- Create: placeholder `pages/site-home.html` … `pages/site-app.html` (7 files, minimal `<title>` + `<h1>` placeholders, replaced by Tasks 7–12)
- Test: `tests/site-public-routes.test.js`

**Interfaces:**
- Produces: `SITE_PUBLIC_ROUTES` map `{ '/': 'pages/site-home.html', '/jobs': 'pages/site-jobs.html', '/jobs/view': 'pages/site-job.html', '/employers': 'pages/site-employers.html', '/about': 'pages/site-about.html', '/faq': 'pages/site-faq.html', '/the-app': 'pages/site-app.html' }`; `/robots.txt` + `/sitemap.xml` responses. Later tasks only replace the page files.

- [ ] **Step 1: Read the existing test harness** (`tests/` — pick any server route test, e.g. how oauth.test.js boots/calls the server) and mirror its idiom in the new test file.
- [ ] **Step 2: Write failing tests** covering: each of the 7 URLs returns 200 + `text/html` **without any session cookie** and body does NOT contain `auth-guard.js`; `/` with a valid gp session still 302s to `/pages/index`; `/` on an admin host still 302s to `/pages/admin`; `/pages/site-home.html` 302s to `/`; `/pages/index.html` (no session) still 302s to signin (wall intact); `/robots.txt` 200 text/plain mentioning `Sitemap:`; `/sitemap.xml` 200 xml listing all 7 canonical `https://www.mygplink.com.au` URLs.
- [ ] **Step 3: Run tests — expect FAIL** (routes don't exist).
- [ ] **Step 4: Implement in server.js:**

```js
// Near other page-serving config:
const SITE_PUBLIC_ROUTES = {
  '/': 'pages/site-home.html',
  '/jobs': 'pages/site-jobs.html',
  '/jobs/view': 'pages/site-job.html',
  '/employers': 'pages/site-employers.html',
  '/about': 'pages/site-about.html',
  '/faq': 'pages/site-faq.html',
  '/the-app': 'pages/site-app.html',
};
```

In the request handler, BEFORE the root-redirect block at `:46021` and before the auth wall:
- If admin host (`getAdminHostScope(req)` truthy) → keep existing behaviour untouched (return early to existing logic).
- If `pathname === '/'` and a valid gp session exists → keep existing 302 `/pages/index`.
- If `SITE_PUBLIC_ROUTES[pathname]` → `serveStatic` that file (no session checks).
- If `pathname` matches `/pages/site-([a-z]+)\.html` → 302 to its clean URL.
- `/robots.txt` → 200 `text/plain`: `User-agent: *\nAllow: /\nSitemap: ${PUBLIC_BASE_URL}/sitemap.xml`.
- `/sitemap.xml` → 200 `application/xml` built from `Object.keys(SITE_PUBLIC_ROUTES)` with `PUBLIC_BASE_URL` canonical URLs.
Create the 7 placeholder files, e.g. `<title>GP Link</title><h1>site-home placeholder</h1>`.
- [ ] **Step 5: Run tests — expect PASS.** Also `node --check server.js` and full `npx vitest run tests/site-public-routes.test.js`.
- [ ] **Step 6: Commit** — `"Site: public routing foundation (7 marketing routes, robots, sitemap; auth wall untouched)"`

---

### Task 3: Public jobs + stats APIs

**Files:**
- Modify: `server.js` (near `/api/career/roles` handler ~`:26726` to reuse its data path: `_zohoRolesCache` / `listCareerRoleRows` / `mapCareerRoleRowToClient`)
- Test: `tests/site-public-apis.test.js`

**Interfaces:**
- Produces:
  - `GET /api/public/jobs?q=&state=&type=&limit=&offset=` → `{ ok:true, total, limit, offset, jobs:[{ id, title, practice_name, location_label, location_state, billing_model, dpa, mmm, earnings_text, summary, employment_type, tags, published_at }] }`
  - `GET /api/public/stats` → `{ ok:true, jobsCount, locations: 830, avgPlacementDays: 22, gpsPlaced: 150, satisfaction: 100 }` (constants from a single `SITE_STATS` object; `jobsCount` live count of active roles, 5-min in-memory cache, fallback to `SITE_STATS.jobsFallback = 1470`).

- [ ] **Step 1: Write failing tests:** no session required (200 without cookies); `jobs` items contain ONLY the whitelisted keys above (assert `source_payload` absent, `Object.keys` subset check); `state=QLD` returns only `location_state` matching QLD (seed via the local JSON-db/dev fallback used by `/api/career/roles` — read how career tests seed roles, follow that); `q=` substring-matches title/practice/location/tags case-insensitively; `type=vr-gp|non-vr-gp|locum` filters (mapping: locum → `employment_type`/tags contains "locum"; vr-gp → tags/summary/`source_payload`-derived client fields flag VR; non-vr-gp → the negation when explicitly flagged non-VR — implement as tag/text match on the mapped client object, not raw SQL); `limit` caps results and `total` reflects pre-limit count; `/api/public/stats` returns the exact constant fields + numeric `jobsCount`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Reuse the same role-listing helper `/api/career/roles` uses (cache + DB fallback), then map → filter → sanitize:

```js
const SITE_STATS = { locations: 830, avgPlacementDays: 22, gpsPlaced: 150, satisfaction: 100, jobsFallback: 1470 };
const PUBLIC_JOB_FIELDS = ['id','title','practice_name','location_label','location_state','billing_model','dpa','mmm','earnings_text','summary','employment_type','tags','published_at'];
function sanitizePublicJob(role){ const out={}; for(const k of PUBLIC_JOB_FIELDS) out[k]=role[k] ?? null; return out; }
```
Filtering runs on the mapped client objects (same shape career.html consumes). `limit` default 24, max 100. Stats: `jobsCount = activeRoles.length` via the same helper, cached `{ value, at }` 5 min.
- [ ] **Step 4: Run — PASS** + `node --check server.js` + full suite `npx vitest run`.
- [ ] **Step 5: Commit** — `"Site: public jobs + stats APIs (sanitized career_roles read, no auth)"`

---

### Task 4: Enquiry API + site_enquiries table

**Files:**
- Create: `supabase/migrations/20260703T000000_site_enquiries.sql` (DDL exactly as in the spec §New table)
- Modify: `server.js` (new handler near other `/api/` POSTs; JSON-db fallback collection `siteEnquiries` following how other dbState collections persist)
- Test: `tests/site-enquiry.test.js`

**Interfaces:**
- Produces: `POST /api/public/enquiry` body `{ kind:'practice'|'gp'|'general', name, email, phone?, practice_name?, state?, message?, website? }` → 200 `{ ok:true }`; 400 `{ ok:false, error }` on invalid; 429 after 5 submissions/hour/IP. `website` is the honeypot: non-empty → respond `{ ok:true }` but store nothing.
- Produces (for Task 13): rows in `site_enquiries` / `dbState.siteEnquiries` with shape `{ id, created_at, kind, name, email, phone, practice_name, state, message, status:'new', metadata }`.

- [ ] **Step 1: Failing tests:** valid practice enquiry stores row (status `new`) and returns `{ok:true}`; missing name/email/kind → 400; bad email format → 400; honeypot filled → `{ok:true}` but row count unchanged; 6th request same IP within the hour → 429; kind outside enum → 400; message capped at 4000 chars (413 or 400).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (validation first, in-memory `Map` rate limiter keyed by `req.socket.remoteAddress` with timestamp pruning, then Supabase insert via `supabaseDbRequest('site_enquiries', '', { method:'POST', … })` with JSON-db fallback in dev). Optional env-gated admin email notification — wrap in try/catch, never fail the API.
- [ ] **Step 4: Run — PASS** + `node --check server.js`.
- [ ] **Step 5: Commit** — `"Site: practice/GP enquiry API + site_enquiries migration (honeypot, rate limit, JSON fallback)"`
- Note for ship checklist: apply the migration to prod via `rpc/exec_sql` with the service key (established procedure) before/at merge.

---

### Task 5: signin.html `?signup=1` deep link

**Files:**
- Modify: `pages/signin.html` (near the `GP_SIGNIN_NEXT` handling ~`:1037,1301` and the `right-panel-active` toggle ~`:1283`)
- Test: `tests/site-signup-param.test.js` (static: served signin HTML contains the param-handling script) — plus manual browser check in Task 14.

**Interfaces:**
- Produces: `/pages/signin?signup=1` auto-opens the sign-up panel; composes with existing `?next=`.

- [ ] **Step 1: Failing test:** GET `/pages/signin?signup=1` body includes marker `data-signup-param` (or the JS snippet string) proving the handler shipped.
- [ ] **Step 2: Implement:** in signin.html's boot script: `if (new URLSearchParams(location.search).get('signup') === '1') container.classList.add('right-panel-active');` (use the exact container element the existing toggle uses; keep `next` param intact).
- [ ] **Step 3: Run — PASS.** Bump the page's cache-buster if it references versioned assets.
- [ ] **Step 4: Commit** — `"Site: signin ?signup=1 opens the create-account panel"`

---

### Task 6: Shared site chrome (css/site.css + js/site.js)

**Files:**
- Create: `css/site.css`, `js/site.js`
- Test: `tests/site-assets.test.js` (assets served 200, correct content-type, `no-cache` header pattern for js per convention)

**Interfaces:**
- Produces (contract for Tasks 7–12 — copy exactly):
  - CSS: design tokens under `:root`; classes `.site-header` (fixed, frosted, `.scrolled` state), `.nav-links a` (animated underline), `.nav-signin`, `.nav-cta`, `.site-menu-btn` + `.site-mobile-menu` (mobile), `.container`, `.btn` + `.primary/.ghost/.white`, `.sec-eyebrow`, `.sec-title`, `.sec-sub`, `.reveal`+`.in` (+`.dl1..dl4`), `.site-footer` (+ `.foot-col`, `.foot-base`), `.faq-item/.faq-q/.faq-a`, form controls `.site-field`, `.toast`. Port ALL visual values from `docs/mockups/marketing-homepage-prototype.html` (the approved design) — hero/card/app-push/oz section classes stay page-local in each page's `<style>`, but tokens/chrome/buttons/reveal live here.
  - JS (auto-init on DOMContentLoaded, no globals except `window.GPSite`): header `.scrolled` toggle; mobile menu open/close; IntersectionObserver adding `.in` to `.reveal`; count-up for `[data-count]` (visible-once, `prefers-reduced-motion` → instant); `GPSite.initJobSearch(formEl)` — serializes `q/state/type` and navigates to `/jobs?…` (used by home + jobs pages); `GPSite.bindEnquiryForm(formEl)` — POSTs JSON to `/api/public/enquiry`, disables button while pending, success → replaces form with a thank-you panel, error → inline message; FAQ accordion (click `.faq-q` toggles `open` on parent, closes siblings); `GPSite.toast(msg)`.
  - Canonical header/footer HTML (every page copies verbatim, sets its own `aria-current` link):

```html
<header class="site-header" id="siteHeader">
  <div class="nav-in container">
    <a class="nav-logo" href="/"><img src="/media/images/site/logo.png?v=20260703" alt="GP Link"></a>
    <nav class="nav-links">
      <a href="/#help">How it works</a><a href="/jobs">Jobs</a><a href="/the-app">The app</a>
      <a href="/employers">Employers</a><a href="/about">About</a><a href="/faq">FAQ</a>
    </nav>
    <div class="nav-right">
      <a class="nav-signin" href="/pages/signin">Sign in</a>
      <a class="nav-cta" href="/pages/signin?signup=1">Create free account</a>
      <button class="site-menu-btn" id="siteMenuBtn" aria-label="Menu">☰</button>
    </div>
  </div>
  <nav class="site-mobile-menu" id="siteMobileMenu"><!-- same links + signin/cta --></nav>
</header>
```

```html
<footer class="site-footer">
  <div class="foot-in container">
    <div><span class="flogo"><img src="/media/images/site/logo.png?v=20260703" alt="GP Link"></span>
      <p>Helping overseas-trained GPs register, relocate and thrive in Australia.</p></div>
    <div class="foot-col"><b>Doctors</b><a href="/jobs">Browse jobs</a><a href="/the-app">The GP Link app</a><a href="/#help">How it works</a><a href="/faq">FAQ</a></div>
    <div class="foot-col"><b>Practices</b><a href="/employers">Why GP Link</a><a href="/employers#enquire">Request doctors</a></div>
    <div class="foot-col"><b>Company</b><a href="/about">About</a><a href="/pages/blog">Blog</a><a href="/pages/privacy">Privacy</a><a href="/pages/terms">Terms</a></div>
    <div class="foot-col"><b>Contact</b><a href="mailto:hello@mygplink.com.au">hello@mygplink.com.au</a><a href="https://calendly.com/hello-mygplink/30min" target="_blank" rel="noopener">Book a call</a><a href="https://www.facebook.com/profile.php?id=61551103728177" target="_blank" rel="noopener">Facebook</a></div>
  </div>
  <div class="foot-base container"><span>© GP Link · ACN 693 259 737</span><span><a href="/pages/privacy">Privacy</a> · <a href="/pages/terms">Terms</a></span></div>
</footer>
<script src="/js/site.js?v=20260703"></script>
```
  (Verify the Facebook page URL from the live Wix footer — `grep -i facebook` in the fetched `wix-home.html` in the session tmp dir; if none found, drop the Facebook link.)
- [ ] Steps: failing asset-serving test → implement css/js → test PASS → commit `"Site: shared chrome (site.css design system + site.js behaviours)"`.

---

### Task 7: Homepage (`pages/site-home.html`)

**Files:**
- Replace: `pages/site-home.html`
- Test: extend `tests/site-public-routes.test.js`: body contains `id="jobSearch"`, `/media/videos/site-hero-beach.mp4`, `data-count`, no `auth-guard.js`, no `href="#"` (regex `href="#"` zero matches — anchors like `href="/#help"` fine).

**Interfaces:**
- Consumes: Task 6 chrome + contract; `/api/public/stats`; asset paths (Task 1); prototype sections.

- [ ] **Step 1:** Port the approved prototype **exactly** (all sections in order: video hero + merged search/stats card; How we help; App push w/ phone mockup + 4-step flow; Why Australia; Why GP Link; framework logos; final CTA; footer), with these changes from prototype → production:
  - Video/img `src` → the `media/…` paths; `preload="metadata"`, `poster` set; page fully legible with video blocked.
  - Header/footer → Task 6 canonical chrome; page-local styles keep prototype hero/app/oz CSS.
  - Search card submits via `GPSite.initJobSearch` → real `/jobs?…` navigation (delete the preview toast).
  - Stats: fetch `/api/public/stats`; update `[data-count]` targets + "Search N jobs" button label; fall back to the hardcoded numbers on fetch failure.
  - All CTAs per spec (§CTA wiring): create-account → `/pages/signin?signup=1`; app section buttons → `/the-app` or signup; final CTA ghost → Calendly.
  - SEO head: title `GP Jobs in Australia for Overseas Doctors | GP Link`, meta description, OG tags (og:image `${PUBLIC}/media/images/site/beach-poster.jpg`), canonical `https://www.mygplink.com.au/`.
- [ ] **Step 2:** Tests PASS; open page over `npm start` and eyeball (scroll animations, counters, search nav).
- [ ] **Step 3: Commit** — `"Site: homepage (video hero, live stats, job search → /jobs, app push)"`

---

### Task 8: Job board (`pages/site-jobs.html`)

**Files:**
- Replace: `pages/site-jobs.html`
- Test: `tests/site-jobs-page.test.js` (page 200 + contains `data-jobs-list`; plus API contract already covered in Task 3)

**Interfaces:**
- Consumes: `GET /api/public/jobs` (Task 3 shape), Task 6 chrome/`initJobSearch`.
- Produces: job card links `/jobs/view?id=<id>` (Task 9 must accept `id`).

- [ ] **Step 1:** Build page: compact hero band (navy, h1 "GP jobs across Australia", live count); filter bar = same `#jobSearch` fields pre-filled **from URL params** (`q/state/type`), submitting re-navigates with params; results grid rendered client-side from `/api/public/jobs?…`:
  - Card: title, practice_name, location_label + state chip, chips (DPA when `dpa`, `MMM{n}` when `mmm`, billing_model, employment_type), earnings_text line (omit when null), 2-line summary clamp, "View role →".
  - States: skeleton loading, empty ("No roles match — clear filters or create a free account and we'll match you"), error w/ retry.
  - Pagination: "Load more" using limit/offset until `total` reached; count header "N roles" from `total`.
  - After every 8th card inject signup interstitial card → `/pages/signin?signup=1`.
- [ ] **Step 2:** Tests PASS; manual: `/jobs?state=QLD` pre-fills + filters.
- [ ] **Step 3: Commit** — `"Site: public job board with URL-synced filters"`

---

### Task 9: Job detail (`pages/site-job.html`)

**Files:**
- Replace: `pages/site-job.html`
- Test: `tests/site-jobs-page.test.js` additions (200 + `data-job-detail`)

**Interfaces:**
- Consumes: `/api/public/jobs` (fetch all-active then find by `id` from `?id=`; if the Task 3 implementation added `?id=` server-side filtering use that — check first).

- [ ] **Step 1:** Layout: breadcrumb "← All jobs" (`/jobs`); h1 title + practice + location; chip row; earnings panel; summary (multi-paragraph); "What GP Link handles for you" reassurance block (registration, visa, relocation — static copy); sticky CTA card: **Apply with a free account** → `/pages/signin?signup=1&next=/pages/career`, subtext "Takes 2 minutes — then apply in the app", secondary "Ask us about this role" → Calendly; related roles: 3 others same `location_state` (else newest), linking to their detail pages. Missing/unknown `id` → friendly not-found panel linking `/jobs`. SEO title `${job.title} — ${location} | GP Link` set client-side.
- [ ] **Step 2:** Tests PASS + manual with a real id.
- [ ] **Step 3: Commit** — `"Site: job detail page (apply → signup deep link)"`

---

### Task 10: Employers page (`pages/site-employers.html`)

**Files:**
- Replace: `pages/site-employers.html`
- Test: `tests/site-enquiry.test.js` addition: page 200 + contains `data-enquiry-form`.

**Interfaces:**
- Consumes: `POST /api/public/enquiry` (Task 4), `GPSite.bindEnquiryForm` (Task 6).

- [ ] **Step 1:** Sections: navy hero "Hire overseas-trained GPs, without the paperwork mountain" + CTA scroll to form; value trio (vetted international GPs; we run registration/AHPRA/visa end-to-end; DPA & 19AB navigation); "How it works for practices" 3 steps (Tell us your need → We shortlist & handle registration → Doctor starts); testimonial (reuse Dr Daniel R. or practice-voice variant of approved copy); FAQ subset (cost, timeline ~22 days avg placement, DPA); enquiry form `id="practiceEnquiry" data-enquiry-form data-kind="practice"` — fields name, practice_name, email, phone, state (select), message + hidden `website` honeypot; submit via `GPSite.bindEnquiryForm`; success panel "Thanks — we'll be in touch within one business day."
- [ ] **Step 2:** Tests PASS + manual submit against dev server writes a row.
- [ ] **Step 3: Commit** — `"Site: employers page with working practice enquiry form"`

---

### Task 11: About + FAQ pages

**Files:**
- Replace: `pages/site-about.html`, `pages/site-faq.html`
- Test: routes test additions (200, contain `data-page="about"` / `data-page="faq"`, zero `href="#"`).

- [ ] **Step 1 (About):** hero "We move GP careers to Australia"; mission paragraph (free for doctors, end-to-end); what-we-handle grid (Registration & AHPRA / Visa & migration / Placement & contracts / Relocation & settling); numbers strip (reuse `[data-count]` + `/api/public/stats`); "Talk to us" block: mailto + Calendly + ACN 693 259 737.
- [ ] **Step 2 (FAQ):** two groups using Task 6 accordion — **For doctors** (Am I eligible? (AMC/AHPRA pathways in plain English), How long? (22-day avg placement; registration varies), What does it cost? (free), Visa sponsorship? (yes, employer-backed), Where will I work? (830+ locations; DPA explained), English tests? (IELTS/OET/PTE + PLAB/NZREX note)) and **For practices** (cost/engagement, timeline, DPA/19AB help, how candidates are vetted). Each answer 2–5 sentences, plain English; final CTA band → signup / employers.
- [ ] **Step 3:** Tests PASS; commit `"Site: about + FAQ pages"`.

---

### Task 12: App marketing page (`pages/site-app.html`, `/the-app`)

**Files:**
- Replace: `pages/site-app.html`
- Test: routes test addition (200, contains `data-page="the-app"`, contains the 6 stage names).

- [ ] **Step 1:** Expanded version of the homepage app-push: hero (navy→blue gradient) with phone mockup (port from prototype, animated progress bar + job-match note); "Your whole move, one app" feature grid (pathway tracking, document verification in minutes, matched jobs, human RSO, notifications, secure storage); **the 6 real stages** each explained in one plain-English sentence: Secure Placement → MyIntealth → AMC → AHPRA → PBS & Medicare → Commencement (do NOT mention an in-app Visa step — deferred per docs/deferred-visa-application.md); 4-step get-started flow; trust/privacy note; big CTA "Create my free account" → `/pages/signin?signup=1` + secondary Calendly. SEO title `The GP Link App — Track Your Move to Australia | GP Link`.
- [ ] **Step 2:** Tests PASS; commit `"Site: dedicated GP Link app marketing page"`.

---

### Task 13: Admin Website tab (enquiries)

**Files:**
- Modify: `server.js` (two admin endpoints near existing `/api/admin/*` handlers), `pages/admin.html` (nav `data-view` list ~`:1433-1440` + new panel; follow an existing simple tab like `scheduled_calls` as the pattern)
- Test: `tests/site-admin-enquiries.test.js`

**Interfaces:**
- Consumes: Task 4 row shape.
- Produces: `GET /api/admin/site-enquiries?status=` → `{ ok:true, enquiries:[…] }` newest-first; `POST /api/admin/site-enquiries/update` `{ id, status }` → `{ ok:true }` (status must be in enum).

- [ ] **Step 1: Failing tests:** both endpoints 401/403 without admin session (mirror how existing admin endpoint tests authenticate — read one first); with admin session: list returns seeded enquiry; update changes status; invalid status → 400.
- [ ] **Step 2: Implement endpoints** (Supabase + JSON fallback, same dual-path as Task 4).
- [ ] **Step 3: Admin UI:** add nav item `data-view="website"` labelled "Website"; panel: table (when, kind badge, name, email/phone, practice, state, message expandable, status pill) + per-row buttons "Mark contacted" / "Close" calling the update endpoint; count badge of `new` in the nav item; empty state. Match admin.html's existing markup/styles; keep the diff minimal.
- [ ] **Step 4:** Tests PASS + `node --check server.js` + full suite.
- [ ] **Step 5: Commit** — `"Admin: Website tab surfacing site enquiries (list + status workflow)"`

---

### Task 14: Full verification sweep + link audit

**Files:**
- Create: `tests/site-link-audit.test.js`

- [ ] **Step 1:** Test that fetches each of the 7 public pages and asserts: every `href`/`src`/`action` is (a) an in-repo path that serves 200, (b) an anchor to an id present on the target page, (c) an allowed external URL (calendly.com, facebook.com, mailto:), or (d) `/pages/signin…`. Zero `href="#"`. Every page includes exactly one `<title>` + meta description + canonical.
- [ ] **Step 2:** Fix anything it catches. Run the **entire** test suite `npx vitest run` — all green, plus `node --check server.js`.
- [ ] **Step 3:** Manual smoke via `npm start`: home → search QLD → job board filtered → job detail → Apply → signin signup panel with next param; employers form submits; admin Website tab shows the enquiry; `/` still redirects when signed in.
- [ ] **Step 4: Commit** — `"Site: link audit + verification sweep"`

---

### Ship checklist (end of build)

- [ ] Apply `site_enquiries` migration to prod via `rpc/exec_sql` (service key in `.env`).
- [ ] Push branch `worktree-marketing-website`; open **draft PR** (do not merge to main).
- [ ] PR description: what changed, the DNS cutover step (point www.mygplink.com.au at Vercel when ready), the env-optional email notification, and that visa remains deferred.
