# Phase 2 — Career Experience (GP-facing browse + job detail + offer/interview)

> **For agentic workers:** Build this with superpowers:subagent-driven-development. This is a BUILD BRIEF, not a rigid TDD script — the owner explicitly wants the builder (Fable 5) to extrapolate and build as it sees fit, using the Atlas mockup as a *very close* reference. Prioritise a complete, functional, production-wired result over literal fidelity. Push to main when the full suite is green (owner authorised direct-to-main per phase).

**Goal:** Replace the incomplete GP-facing career browse page and job detail with the approved **Atlas** design — fully functional, wired to the live career APIs — including the confidential-identity treatment, the two-tier intro video, and the offer → schedule-interview flow.

**Reference mockup (very close target):** `docs/mockups/career-redesign/variant-b.html` (Atlas). Serve it with `python3 -m http.server` and mirror its structure, copy, interactions and visual language. `variant-a.html` (Journal) is the rejected alternative — ignore. `index.html` is the chooser.

## Global Constraints (HARD — copy verbatim into every task)

- **Design tokens:** use `css/gp-tokens.css` (DM Sans body + Source Serif 4 display, the blue system, navy hero gradient, 18px cards, `.gp-reveal` entrance). Navy masthead + sky glow borrowed from the marketing site (`css/site.css`).
- **Never write "RSO".** Always spell out **"Registration Support Officer"** in full, everywhere GPs can see it. (GPs don't know the acronym.)
- **Application count is a FIXED presentation band of 15–23** — NOT the real `gp_applications` count. Deterministic per role so it never flickers (e.g. `15 + (hashRoleId % 9)`). Owner directive: do not surface real counts.
- **No inventory counts anywhere** — no "X live roles", "X DPA", "X states", no per-filter counts. Abundance kills urgency.
- **Confidential identity is server-enforced.** The real practice name / exact street address must NEVER reach the browser for a non-revealed role. Reveal is gated by the existing `canRevealPracticeIdentity()` (admin_applied || revealed || accepted offer). The blur is a placeholder graphic, not CSS over real text.
- **Masked title never falls back to the real title** (already true after Phase 1 mappers — verify in `mapCareerRoleRowToClient`/`mapCareerRoleRowToPublicJob`).
- **App-shell embedding:** keep the `gp-shell-embedded` early inline script + `/js/nav-shell-bridge.js`; reserve bottom space with `var(--gp-shell-bottom-clearance,70px)`; detail navigation via `gpShellNavigate('/pages/job?id=…')` (routes already registered in `js/app-shell.js`). Inline-modal detail is acceptable if cleaner — builder's call — but remove the dead legacy `#roleModal` in career.html either way.
- **Cache-busters:** bump `?v=YYYYMMDD[letter]` on every changed JS/CSS/script tag.
- **Tests green + push to main.** Update/extend career + job tests; keep the whole suite green; then push to main.

## Files

- `pages/career.html` — the browse hub (currently ~11k lines; has a dead legacy `#roleModal`). Rebuild the browse experience: navy masthead (no counts), search, **tabs Roles / Saved / Offers**, **dropdown filters** ("Jobs I'm eligible for" / billing / location — NOT filter tiles), refined **single-accent** cards (green "Eligible for you" pill; muted meta line; earnings as ink; NO rainbow chips), photo-less **map-motif scenery** when no `header_image_url`, "17 applied" band, save-to-shortlist, "NAME ON ACCEPTANCE" locked ribbon.
- `pages/job.html` — the detail view. Two modes:
  - **Standard:** eligibility/billing/permanent tags; **urgency panel** (High interest · 15–23 applied · progress bar · "doctors with a complete CV are shortlisted first — your CV is complete, you'll be prioritised"); package cells; about/intro; benefits; **identity vault** (blurred name, "revealed the moment you're accepted", tap = shake + explain); **two-tier intro video** (logged-in GP sees the intro video here; the public marketing site stays masked); **area map** (fuzzy pulsing circle, "exact address on acceptance"); Registration Support Officer reassurance strip; **Apply** bar → `POST /api/career/apply`.
  - **Offer mode** (when the GP has an accepted application / live offer for this role): **identity UNLOCKED** — real practice name + full address in header, "✓ UNLOCKED" practice card, **exact** green map pin; green **offer banner** ("The practice would like to interview you", respond-within nudge); **Schedule your interview** — day + time-slot picker → confirm → booked card with **Join on Zoom** + **Add to calendar** + Reschedule; bottom bar "Schedule your interview" → "✓ Interview booked · <slot>".
- `pages/secure-interview.html` — existing instant-booking + confetti page; reuse its scheduler wiring / align with it.
- Marketing site `pages/site-jobs.html` — leave masked; only ensure no regression from mapper/leak changes.
- `server.js` — only as needed: a helper for the fixed 15–23 band; ensure search + address are masked (see leak fixes); any small payload additions the detail needs (e.g. `revealed`, offer/interview fields already exist).

## Live endpoints to wire (already exist — see the code map in memory)

- `GET /api/career/roles` — list (card shape = `mapCareerRoleRowToClient`).
- `GET /api/career/role?id=` — detail (`mapCareerRoleDetailToClient`, key `role`).
- `POST /api/career/apply` `{ roleId }` — guards: session, onboarding complete (403), CV uploaded (403 `requiresCv`), already-placed (409), job closed (409), DPA qualification (403 `not_qualified`), rate limit (429).
- `GET /api/career/applications` — Saved/Offers data: per-application `status`, `tone`, `offerPending`, `isPlacementSecured`, `revealed`, `practiceName` (real, when revealed), `roleId`.
- `GET /api/career/my-offer`, `POST /api/career/offer/accept|decline`.
- `GET /api/career/interview/slots`, `POST /api/career/interview/book` — the 3-way timezone scheduler + Zoom (see [[ceo-interview-scheduling-build]]). Books into `scheduled_calls`.
- `GET /api/career/upload-cv` path for apply-with-CV (job.html:1831 today).
- Saved roles: current page uses `data-save-role`; wire persistence (server-side if an endpoint exists, else localStorage + `js/state-sync.js`).

## Leak fixes to fold in (were the old Phase 2 masking items)

1. **Search** (public `/api/public/jobs` search + in-app `/api/career/roles` search) must match ONLY masked fields (suburb, nearest_city, billing, DPA, state) — never `practice_name` or raw `title`.
2. **Exact street address** (`career_roles.address`, Zoho `Location`/`Zip_Code`) must never be sent to the client for a non-revealed role — suburb + nearest_city + state only.
3. **Intro video / intro text**: only on the in-app logged-in detail (and post-reveal), never on the anonymous public marketing card.

## Acceptance

- A logged-in GP can: browse (search + 3 dropdowns + Roles/Saved/Offers tabs) → open a role → see the confidential detail with urgency + video + area map → Apply → see it under Offers as "In review" → (when an offer exists) open offer mode → schedule an interview → get a Zoom-confirmed booking.
- No real practice name/address/title leaks anywhere pre-reveal (verify live `/api/public/jobs` + `/api/career/roles`).
- No "RSO"; no inventory counts; application band 15–23 only.
- Full test suite green; pushed to main; cache-busters bumped.
