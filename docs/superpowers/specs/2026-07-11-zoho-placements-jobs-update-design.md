# Zoho placements + job-openings update — design

**Date:** 2026-07-11
**Source:** `prompt instructions (1).pdf` (owner instructions)
**Working mode:** live prod Supabase data ops + one small admin UI feature.

## Hard constraint (owner)

These are **past placements from Zoho**. Marking jobs filled/closed must fire **NO notifications** to
medical practices or candidate GPs.

Verified safe: `career_roles.job_status` is a plain column. The write helper `atsUpdateJobRow`
(`server.js:26024`) and PATCH `/api/ats/job` (`server.js:49909`) do a pure DB PATCH with no email /
notification / automation side effects. The only placement notifications live in the offer-accept flow
(`/api/career/offer/accept`, `server.js:29968`), which we never touch. Therefore all fill/close/edit
operations are done by writing DB columns directly — nothing is sent.

## Data model (prod Supabase)

- `career_roles` — one row per job opening. Key columns:
  - `job_status` `open|filled|closed` (CHECK), `is_active` (bool, controls candidate/public visibility),
    `approval_status`.
  - `practice_name` (denormalized), `practice_id` → `practices(id)`.
  - `title`, `location_city`, `location_state`, `location_label`, `masked_title`.
  - `summary` — **the "About the role" body** (privacy-safe, shown on the job page).
  - `details` (jsonb) — `{ website, benefits[], positions, shortIntro }`. `benefits[]` is the
    commercial-terms display ("Why GPs consider this role").
  - `earnings_text`, `billing_model`, `visa_pathway_aligned` (bool), `tags[]`, `dpa` (bool).
  - `header_image_url` — suburb picture (auto-resolved from Wikimedia, or set explicitly).
  - `source_payload` (jsonb) — `{ zoho, gpLink }`; we add a `gpLink.filledBy` record for the record.
- `practices` — one row per practice. Key columns: `name`, `location_city`, `location_state`, `stage`,
  `website`, `dpa`, `billing_style`, `suburb`, `nearest_city`, `org_type`, `parent_corporation_id`,
  `metadata`, `is_active`.
- `gp_applications` — candidate applications; FK `career_role_id`. Checked before any delete.

## Current prod state (relevant)

55 roles total. Groups: ForHealth Group (35), GP West Group (9), plus singles. Named practices exist for
Four Corners (#5), Complete Family Care (#1, title "General Practitioner - Hanna Elkhoury"),
Halekulani (#53, has one `hired` application), Mount Hutton Family Practice (#50), Kennedy Drive (#56),
Perfect Medical Centre (#54), Thornton (#57). **Carrara and the 5 Spectrum practices do not exist yet.**
Four Corners (#5 + practice `02f9e43a…`) has **zero** applications → safe to hard-delete (pending a final
FK sweep across `ats_offers`, `placements`, `pending_hires`, `gp_career_state`).

## The work

### Part 1 — nine numbered items (live data)

1. **Four Corners** — hard delete role #5 and practice `02f9e43a-…` (after FK sweep confirms no refs).
2. **Halekulani** (#53) — `job_status='closed'`, `is_active=false`; record filled by *Dr Mohsen Dashti*
   and *Dr Sana Ahsan* in `source_payload.gpLink.filledBy`.
3. **Mount Hutton Family Practice** (#50) — `job_status='filled'`, `is_active=false`; filled by *Dr Musharraf*.
4. **Carrara Family Practice** — create practice (Non-DPA) + one job. Website
   `https://carrarafamilypractice.com.au/`. Terms: Bulk billing · Earnings $700k · 2yr $15k / 3yr $22.5k ·
   70% split · $150/hr minimum income guarantee · Visa sponsorship · Supervision available. Add suburb
   picture + AI "About the role".
5. **Kennedy Drive** (#56) — `filled`, inactive; filled by *Dr Yan Win*.
6. **Perfect Medical** (#54) — `filled`, inactive; filled by *Dr Joseph Iyanda*.
7. **Thornton** (#57) — `filled`, inactive; filled by *Dr Sameer Shereef*.
8. **Complete Family Care** (#1) — retitle from "General Practitioner - Hanna Elkhoury" to a name that
   drops the person (e.g. "General Practitioner || Complete Family Care"); practice_name already correct.
9. **View-in-app + View-in-website buttons** — per job card on the **admin ATS Jobs board**
   (`js/ceo-ats-jobs.js`), opening the in-app job page (`/pages/job.html?id=<publicId>`) and the public
   website page (`/jobs/view?id=<publicId>`). Only code change. Ships as a draft PR.

### Part 2 — group billing terms (write to `details.benefits[]` + `earnings_text` + `visa_pathway_aligned` + `tags` so they display)

- **ForHealth Group (35 roles):** $500k · 2yr $15k / 3yr $22.5k · 70% split · $150/hr guarantee · Visa ·
  Supervision. `billing_model` left per-practice ("check website to assess").
- **GP West Group (9 roles):** $500k · 2yr $10k · 70% split · $150/hr guarantee · Supervision (no visa).

### Part 3 — Spectrum Group (new corporation, 5 DPA practices)

Create a "Spectrum Group" corporation practice (`org_type='corporation'`) and 5 child practices + jobs,
each `dpa=true`, AI-scanned from its website, with a suburb picture and terms: $500k · 2yr $10k · 70%
split · $150/hr guarantee · Supervision.

- https://www.theheightsmedical.com.au/index.html
- https://www.connollydrivemedical.com.au/
- https://pearsallmedical.com.au/
- https://rainbowhealth.com.au/
- https://mandurahmedical.com.au/

### Part 4 — AI "About the role" for all active jobs (owner chose "all")

Re-scan each practice website and write a fresh privacy-safe `summary` (location vibe, lifestyle,
allied-health & services) — **no practice name or exact-location leak**. Applies to all active roles
(≈54 existing after the Four Corners delete, + Carrara + 5 Spectrum = ≈60). For the ~17 roles with no
website, fall back to the practice-group site or a suburb/context-based summary. Suburb pictures kept /
added.

## Ship model

- **Data (Parts 1–4 minus buttons):** verified Node scripts writing directly to prod Supabase REST
  (service-role key from `.env`). Each script previews the change, applies it, and reads back to confirm.
  No app notifications are triggered.
- **Code (item 9 buttons):** in this worktree branch → draft PR (background-job safety; no direct push
  to main).

## Assumptions (owner-confirmed / flagged)

- Spectrum practices are **DPA** (owner-corrected). ✅
- "Filled by" GPs are past Zoho placements, not app users — names recorded on the job only, no accounts.
- Filled/closed jobs set `is_active=false` so they drop off candidate + public lists.
