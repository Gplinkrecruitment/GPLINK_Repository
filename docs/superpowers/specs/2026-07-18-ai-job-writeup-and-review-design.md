# AI job write-up + combined review screen — design

**Date:** 2026-07-18
**Status:** Design approved (owner saw the localhost mockup + AI-enriched preview and said "build and push to main").
**Mockup:** `~/.claude/jobs/2afa6df4/tmp/review-mockup/review.html` (served on :8493).

## Why

When a practice signs, a job is auto-created as `approval_status:'pending'`. Today the CEO's only review action is uploading a suburb photo — they never see the details the practice submitted, can't edit them, and can't preview the listing. And the listing's "about" text is the practice's own thin, typo-prone sentence.

The owner's ask: **AI should write a genuinely better job opening** from (1) the practice's form answers, (2) the practice website, and (3) real knowledge of the area — and the CEO should review it on one screen: all details editable, the AI write-up editable/regenerable, a preview of how it looks in the app and on the website, then approve.

## The load-bearing safety rule: identity masking

The GP board is **identity-masked**. The public website carries no session and never receives the practice name, street address, or doctor names; the in-app view masks them until a GP is accepted. Therefore:

- **The AI write-up must name no practice, no doctor, and no street address.** It says "an established, GP-owned practice on the NSW Central Coast", never "Erina Medical Centre". (The mockup got this wrong on purpose to surface the rule.)
- The prompt forbids it, AND the server strips the known practice name / address tokens as a backstop before storing and again before serving on public payloads.
- The practice website URL is an **AI input only** — never rendered on any listing (it reveals identity).

## The AI write-up

**Inputs:** the intake/`details` fields (billing, split, incentives, earnings, DPA, employment, GP count, years, nursing, supervision, suburb/nearest-city/state) + the practice's raw `intro_text` + text fetched from the practice website (`details.website`) + the model's own knowledge of the suburb/region.

**Output (JSON):**
- `about`: 2–3 short paragraphs, identity-masked, that a GP actually wants to read. Grounds every claim in an input; no invented clinical services or superlatives.
- `highlights`: 3–5 short "why GPs choose it" bullets.
- `sources`: which inputs were used (`form`, `website`, `area`) — shown to the CEO for trust.

**Storage:** `career_roles.source_payload.gpLink.aiWriteup = { about, highlights[], sources[], generatedAt }`. Generated **lazily** — on demand when the CEO opens review (or hits Regenerate) — so signing never waits on an AI call or a website fetch. Cached until regenerated.

**Grounding / no-invention:** the prompt states the only permitted facts are the provided inputs + general geographic knowledge of the named area; no clinical claims beyond what the form/website state; no practice/doctor/street names. The CEO always edits and approves before anything goes live, and the practice's original words stay one click away ("show what the practice wrote").

**Model + call:** reuse the existing pattern (`fetch https://api.anthropic.com/v1/messages`, `x-api-key: ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`, `model: ANTHROPIC_MODEL`, `temperature: 0`, parse `content[0].text`, extract `/\{[\s\S]*\}/`, `recordAnthropicSpend`). 30s timeout, AbortController.

**Graceful degradation (must):**
- No `ANTHROPIC_API_KEY` (e.g. local dev): the endpoint returns `{ ok:false, reason:'ai_unavailable' }`; the listing falls back to the raw `intro_text` / existing benefits. Never a hard failure.
- Website fetch fails/times out: proceed with form + area only; `sources` omits `website`.

## Website fetch

Server-side `GET` of `details.website` with a 10s timeout, follow one redirect, cap body, strip tags to ~4k chars of text. Only http(s) URLs; never fetch anything else. Failure is non-fatal (see above).

## Rendering the write-up on the listings

- **In-app** `pages/job.html`: the "About the practice & area" block uses `aiWriteup.about` when present, else `intro_text`. "Why GPs choose it" uses `aiWriteup.highlights` when present, else the existing benefits fallback.
- **Website** `pages/site-job.html`: same, in the public "About the practice & the area" section.
- Server shaping (`server.js` public + in-app job payloads) includes `aiWriteup` **after** the masking backstop. `PUBLIC_JOB_FIELDS` stays name-free.

## The combined review screen

Clicking a **pending** job (or "Review & approve") opens one review view. Reuse the existing editor modal (`atsJobEditorPayload` already prefills every field, editable) and add to it:

1. **All details, editable** — already exists in the editor; keep.
2. **AI write-up block** — the `about` textarea (editable) + `highlights`, a "✦ Regenerate" button (calls the write-up endpoint), a "show what the practice wrote" toggle (raw `intro_text`), and a "Written by AI from: form · website · area" source line.
3. **Preview** — "Preview in app" / "Preview on website" buttons (see below).
4. **Suburb header photo** — the existing required-photo uploader/reuse picker.
5. **Approve / Reject** — the existing actions; Approve stays gated on a header photo.

A non-pending (already-approved) job still opens the candidate pipeline board as today. Bump the `ceo-ats-jobs.js` cache-buster.

## Preview of a not-yet-live job

The public pages filter to `is_active=true`, so a pending job can't use them directly. Add an **admin-only preview**: `GET /pages/job.html?id=<publicId>&preview=1` (and the site equivalent) served only to an authenticated ATS/admin session, which renders the job regardless of `is_active`/`approval_status` using the same shaping (incl. `aiWriteup`). Opens in a new tab from the review screen. No public exposure — the preview path requires the admin session cookie.

## Out of scope

Everything downstream of approval is unchanged (publish, masking, accept-and-reveal, pipeline). The AI write-up does not touch structured fields (title, earnings, split) — those stay exactly as submitted/edited.

## Testing

- `lib/job-writeup.js` pure: prompt-building, JSON parse/validate, **identity-mask backstop** (given a write-up containing the practice name/address, it is stripped). Unit-tested, no network.
- Endpoint: mock `fetch` for both the website and Anthropic; assert store shape, graceful no-key path, website-failure path.
- Rendering: both pages render `aiWriteup` and fall back; masking assertions (no practice name in public payload).
- Baseline: pristine `origin/main` fails a known handful of tests; judge regressions against that, not zero.
