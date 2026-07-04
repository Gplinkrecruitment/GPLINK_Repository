# GP Link Standalone ATS — Operator Guide

GP Link is now a complete recruitment system on its own. Jobs, candidates, the
pipeline board, interviews, offers and placements all work fully inside the
app — **Zoho Recruit is optional**. You can disconnect Zoho and nothing in the
doctor's journey or the CEO dashboard stops working.

Everything below happens on the CEO dashboard (`ceo-dashboard.html` on the
super-admin address), unless it says otherwise.

---

## The lifecycle, start to finish

1. **Create the practice** — *Practices tab → Add practice.* Give it a name and
   a contact email. The contact email matters: it's where the candidate
   introduction is sent later.

2. **Create the job** — *Jobs tab → Add a job.* Pick the practice, city, state,
   type, billing, and write a short "About the role" description — that text is
   what doctors read on the job page. The job appears on the doctors' Careers
   page immediately (only while it's **open** — filled or closed jobs are
   hidden automatically).

3. **Candidates arrive two ways:**
   - A doctor applies themselves from the Careers page in the app, or
   - You add them to a job from the candidate drawer (*Candidates tab → open a
     candidate → "＋ Add to a job"*).

4. **Submit to the practice** — in the candidate drawer, each application has a
   **Submit to practice** button. The practice receives a professional
   introduction email with the doctor's CV attached. (If the practice record
   has no contact email you'll be asked to add one on the Practices tab
   first.) The card moves to "Submitted to Practice" and the doctor sees
   "Sent to the practice" in the app.

5. **Interview** — from the drawer, request an interview. The doctor picks a
   time slot in the app, the meeting lands on the Meetings tab, and the
   pipeline card moves to Interview.

6. **Send the offer** — for applications in the Reviewing / Interview / Offer
   lanes, the drawer shows **Send offer**. Fill in the billing split, sessions
   per week, compensation, start date, notes, and optionally attach the
   contract (PDF). The doctor gets one email with a link straight to their
   offer page, where they see the real terms — and can accept, ask for
   changes, or decline. You can quietly withdraw a sent offer at any time.

7. **The doctor accepts** — everything completes automatically:
   - their application is marked **placement secured** and the pipeline card
     moves to Hired;
   - their Careers page flips to the "your placement" view with the real
     terms, start date, practice contact and contract download;
   - the registration steps that were waiting for a placement (AHPRA / SPPA
     paperwork) unlock;
   - the job is marked **filled** so no one else can apply;
   - whoever sent the offer gets a "🎉 offer accepted" email.

   If the doctor declines instead, the offer is marked declined, the card
   stays in the Offer lane, and the offer sender is emailed so they can follow
   up or adjust the terms.

## What the doctor sees along the way

The Careers page labels come straight from the pipeline board:

| Pipeline lane | Doctor sees |
| --- | --- |
| Applied | "Application submitted" |
| Submitted to Practice | "Sent to the practice" |
| Practice Reviewing | "The practice is reviewing your profile" |
| Interview | "Interview stage" |
| Offer (offer sent) | "Offer waiting for you 🎉" + a Review Offer button |
| Hired / accepted | "Practice secured" + the placement view |
| Not Proceeding | "Not proceeding this time" |

If a doctor withdraws their own application in the app, the card moves to the
**Not Proceeding** lane automatically so the board always reflects reality.

## Consultants (your recruitment team)

- **Invite** — *Team section (visible only to you) → add name + email.* They
  get an email invitation to set a password. **Remove** — same place, one
  click (this revokes their access immediately).
- **What a consultant sees:** the ATS only — Candidates, Jobs, Practices and
  Meetings on the CEO dashboard, with full pipeline control (move cards, book
  interviews, submit to practices, send offers).
- **What they can't see or do:** the Registration master tab, the Team
  (consultant management) section, the RSO admin dashboard, or any other admin
  page. They simply don't have access — the server refuses, not just the
  screen.

## Zoho Recruit is now optional

- **To disconnect:** open the RSO admin dashboard → Integrations card → Zoho
  Recruit → **Disconnect**. It's reversible — reconnecting later picks up where
  it left off.
- **What still works after disconnecting:** everything in this guide. Jobs,
  applications, the pipeline, submit-to-practice, interviews, offers,
  acceptance, placements, CV uploads and the doctor's whole journey are all
  in-app. Doctors' CV uploads simply stop being mirrored to Zoho (they're
  always saved in GP Link either way).
- **What Zoho adds when connected:** job openings from Zoho Recruit appear on
  the doctors' Careers page alongside in-app jobs, and the status of older
  Zoho-managed applications keeps syncing back into the app. That's it —
  nothing else depends on it.

## The three pending database migrations

The ATS works **right now** without any database changes — new records are
kept in the app's built-in fallback store (`runtime_kv`) until the real tables
exist. Applying the migrations makes the records first-class (better for
reporting and long-term durability). Apply them the usual way (`exec_sql` with
the service key), in this order:

| Migration file | What it activates |
| --- | --- |
| `supabase/migrations/20260703090000_user_roles_consultant.sql` | Lets the `user_roles` table store the **consultant** role. Until then, consultants are recognised from the invite list (runtime_kv) and the `CONSULTANT_EMAILS` setting — they work fine either way. |
| `supabase/migrations/20260703091000_ats_offers.sql` | Creates the **ats_offers** table so every offer (terms, status, who sent it, when) is a proper database row. Until then, offers live in runtime_kv and behave identically. |
| `supabase/migrations/20260703092000_placements.sql` | Creates the **placements** table — one row per completed placement. Until then, the placement details are still recorded on the doctor's profile (that part never depended on the table), so nothing is lost. |

Nothing needs to be redeployed after applying them — the app notices the
tables and starts using them automatically.

## Intentionally Zoho-only (safe when disconnected)

These exist only to talk to Zoho and quietly do nothing when it's
disconnected: the Zoho job sync + enrich crons, the Zoho webhooks, the
reverse status sync, and the "sync to Zoho" mirror on CV/document uploads.
