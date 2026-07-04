# Practice-Client Pipeline — Operator Guide

## What this is, in plain words

This is the automatic front door for new practices. When a medical practice
fills in a Facebook lead ad (or a Zapier/Make automation relays one of our own
web forms), GP Link automatically:

1. saves them as a "prospective" practice,
2. emails them a themed link asking for their job details,
3. lets them fill in those details and **sign the recruitment agreement
   in-app** (no back-and-forth PDF emailing),
4. turns that into a job listing that's **hidden from GPs until an admin
   approves it and uploads a photo**,
5. shows the job to GPs with the **practice's real name and address always
   hidden** until a practice actually says yes to a doctor,
6. and once the practice accepts a doctor, reveals the practice, congratulates
   the doctor, and lets them **book their own interview slot instantly** —
   picking a real time that works for them, the practice, and GP Link, with a
   real Zoom link generated automatically.

Nobody on the GP side ever sees a practice's name, address, or exact suburb
until that practice has actually said "yes, we want to meet this doctor."

---

## The flow, start to finish

```
Facebook Lead Ad  ──┐
                     ├──► POST /api/webhooks/facebook-lead ──► practice row
Zapier / Make form ──┘         (stage: prospective)              created
                                        │
                                        ▼
                        Themed "Your GP is waiting" email
                        → /pages/practice-intake?token=...
                                        │
                        Practice fills in billing, DPA status,
                        suburb, address, earnings, etc.
                          (GET/POST /api/practice-intake)
                                        │
                                        ▼
                    Practice signs the agreement in-app (typed
                    signature + PNG) → /api/practice-intake/sign
                                        │
                        ┌───────────────┴───────────────┐
                        ▼                                ▼
              practice.stage = 'active'         career_roles row created
              signed PDF stored + emailed        is_active:false
                                                  approval_status:'pending'
                                                        │
                                                        ▼
                          Admin/CEO dashboard: Jobs tab shows the
                          pending job. Admin uploads a suburb header
                          photo (or reuses one already on file for
                          that suburb) — mandatory before approval —
                          then clicks Approve.
                          (/api/ats/job/header-image, /api/ats/job/approve)
                                                        │
                                                        ▼
                          Job goes live: is_active:true, approval_status:
                          'approved'. Now visible on:
                            • the public Careers site (masked — no
                              practice name, ever) — GET /api/public/jobs
                            • the in-app GP roles list — GET /api/career/roles
                                                        │
                        DPA gate: an overseas-trained GP only sees a
                        DPA-approved job in full. A non-DPA job shows as
                        a blurred "GP Opportunity" stub UNLESS the GP's
                        onboarding says they trained in Australia.
                                                        │
                                                        ▼
                          GP applies (POST /api/career/apply) — still
                          masked at this point, even for a qualifying GP.
                                                        │
                          Practice says yes → admin clicks Accept
                          (POST /api/ats/application/accept)
                                                        │
                        ┌───────────────┴───────────────┐
                        ▼                                ▼
              gp_applications.revealed = true    "Congratulations 🎉" email
              real practice name + address now   → Secure My Interview button
              visible on GET /api/career/my-offer
                                                        │
                                                        ▼
                        GP picks a real time slot (3-way timezone
                        match: GP / practice / GP Link) and books it
                        instantly — real Zoom link, no practice
                        round-trip needed.
                        (GET /api/career/interview/slots,
                         POST /api/career/interview/book)
```

---

## Endpoints

| Method | Path | Who calls it | What it does |
|---|---|---|---|
| GET | `/api/webhooks/facebook-lead` | Facebook | Webhook verification handshake (`hub.challenge` echo) |
| POST | `/api/webhooks/facebook-lead?secret=…` | Facebook / Zapier / Make | Creates a prospective practice + sends the intake email |
| GET | `/api/practice-intake?token=…` | Practice (no login) | Loads whatever the practice has saved so far |
| POST | `/api/practice-intake` | Practice (no login) | Saves the job/billing details form |
| POST | `/api/practice-intake/sign` | Practice (no login) | Signs the agreement, promotes the practice, creates the pending job |
| GET | `/api/ats/jobs` | Admin/CEO | Lists jobs, including pending ones |
| POST | `/api/ats/job/header-image?id=…` | Admin/CEO | Uploads (or reuses) a suburb header photo |
| GET | `/api/ats/suburb-images` | Admin/CEO | Lists every header photo already on file, for reuse |
| POST | `/api/ats/job/approve?id=…` | Admin/CEO | Approves (or rejects) a pending job — **blocked without a photo** |
| GET | `/api/public/jobs` | Public website (no login) | Masked job board — never returns a practice name |
| GET | `/api/career/roles` | GP (logged in) | In-app job list, DPA-gated + masked until reveal |
| POST | `/api/career/apply` | GP (logged in) | Applies for a role (still masked) |
| POST | `/api/ats/application/accept?id=…` | Admin/CEO | Practice said yes — reveals identity, records an offer, sends the congrats email |
| GET | `/api/career/my-offer` | GP (logged in) | The GP's offer page — masked or revealed depending on state |
| GET | `/api/career/interview/slots?applicationId=…` | GP (logged in) | Real bookable time slots (only once revealed) |
| POST | `/api/career/interview/book` | GP (logged in) | Books a slot — creates the Zoom meeting + calendar event |

---

## Facebook Lead Ads payload vs. the Zapier/Make fallback

Facebook's native Lead Ads webhook payload is nested and field-named
generically (`field_data` with `name`/`values` pairs). We also accept a much
simpler **flat JSON** shape for anyone relaying leads through Zapier, Make, or
a custom web form — this is the one to give an integrator:

```json
{
  "lead_id": "unique-id-for-dedup",
  "practice_name": "Example Medical Centre",
  "location": "Toowoomba",
  "contact_name": "Jane Manager",
  "contact_email": "jane@example-practice.com.au",
  "contact_phone": "0400111222",
  "website": "https://example-practice.com.au",
  "dpa": false
}
```

Only `lead_id` is required for dedup (falls back to a hash of the whole body
if missing); at least one of `practice_name` or `contact_email` must be
present or the payload is rejected as unrecognised. The webhook tells the two
shapes apart automatically — no separate URL or flag needed.

---

## Privacy / masking rules

- **`PUBLIC_JOB_FIELDS`** (the public Careers site) never includes a practice
  name, address, or contact field — only masked `title`/`display_label`,
  suburb, nearest city, billing, DPA flag, earnings text, and a header photo.
- **`canRevealPracticeIdentity(userId, careerRoleId)`** is the single
  gatekeeper used everywhere identity might leak in-app (role detail,
  applications list, interviews, the offer page). It only returns true when:
  the application was admin-applied, `gp_applications.revealed` is already
  `true`, or there's an accepted offer.
- The DPA qualification gate (`gpQualifiesForRole`) is a **separate, earlier**
  check — it decides whether a GP even sees a role (in full or blurred), but
  a role a GP qualifies for is **still masked** until the practice accepts
  them. Qualifying and revealing are two independent gates.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `FB_LEAD_WEBHOOK_SECRET` | Shared secret Facebook/Zapier must send as `?secret=` on every POST. Webhook returns 503 (disabled) if unset. |
| `FB_LEAD_VERIFY_TOKEN` | The token Facebook's `hub.verify_token` must match during the GET verification handshake. |

Both are read once at process start — set them in Vercel, then redeploy.

---

## Database migration

`supabase/migrations/20260705100000_practice_client_pipeline.sql` adds the
practice-intake columns (`intake_token`, `agreement_status`,
`agreement_signed_*`, `dpa`, `billing_style`, `suburb`, `nearest_city`, etc.)
to `practices` and `career_roles`, plus `gp_applications.revealed` and
`gp_applications.origin`.

**This migration has NOT been applied to production as part of this task.**
Apply it via `rpc/exec_sql` with the Supabase service-role key (the parameter
name is `query`; schema-qualify table names). Every write path in this
pipeline has a "missing-column tolerance" fallback (it degrades to storing
data in the `metadata` JSON column and logs `run migration 20260705100000`
to the server console) so **nothing 500s or silently drops data** if the
migration lags behind a deploy — but the pipeline runs in a degraded state
until it's applied. Watch the logs for that message after deploying; if you
see it, apply the migration.

---

## Deploy checklist

- [ ] Apply migration `20260705100000_practice_client_pipeline.sql` (service-role key, `rpc/exec_sql`, param `query`).
- [ ] Set `FB_LEAD_WEBHOOK_SECRET` and `FB_LEAD_VERIFY_TOKEN` in Vercel, redeploy.
- [ ] Point the Facebook Lead Ads webhook (or your Zapier/Make Zap) at
      `https://app.mygplink.com.au/api/webhooks/facebook-lead?secret=YOUR_SECRET`
      and complete the Facebook subscription handshake using the verify token above.
- [ ] Confirm `RESEND_API_KEY` is set — without it, every email in this
      pipeline (intake invite, signed-agreement copy, congrats email) silently
      returns `{ok:false, error:'Email not configured'}` and nothing is sent.
      This was the observed (and expected) behaviour in local testing, where
      no Resend key is present.
- [ ] **DPA-backfill decision (deploy-time, not yet made):** existing
      `career_roles` rows created before this pipeline have no `dpa` value.
      `gpQualifiesForRole` treats a missing/falsy `dpa` as "not DPA", which
      means every pre-existing role will show as a **blurred stub** to any GP
      who hasn't answered "trained in Australia" on onboarding. Decide
      whether to backfill `dpa:true` on legacy Zoho/manual roles (if they're
      genuinely DPA) before this ships, or accept that older roles blur until
      someone re-tags them from the CEO dashboard.
- [ ] **Existing-GP `australia_trained` answer path:** GPs who onboarded
      before this feature have no `australia_trained` value on their profile
      — they will default to "not Australia-trained" (fail-closed) and see
      non-DPA roles blurred until they answer the new onboarding question.
      There's currently no standalone "update my training country" surface
      outside onboarding — a GP who already completed onboarding would need a
      follow-up screen or admin override if this needs correcting sooner than
      a natural re-onboard.
- [ ] **Warm-instance self-heal after migration:** a Vercel serverless
      instance that was warm *before* the migration ran may still see the old
      schema cache and hit the "missing-column" fallback path for a request
      or two after you apply the migration. This resolves itself once that
      instance cycles (typically within minutes) — no action needed, but
      don't be alarmed by a `run migration 20260705100000` log line
      immediately after applying it.

---

## How this was verified

All 82 test files / 1379 tests pass (`npx vitest run`). A full manual
end-to-end pass was also run locally against a throwaway in-memory database
(not production) driving every real HTTP endpoint with `curl` — Facebook
webhook → practice created → intake form → agreement signed → job pending →
header photo uploaded → job approved → public job board confirmed masked →
GP applies → practice accepts → identity revealed → interview slot booked
with a real (local-fallback) Zoom link. See
`.superpowers/sdd/task-14-report.md` for the full transcript of that run,
including the exact request/response pairs.
