# GP Link — message & template audit

**Date:** 2026-07-18 · **Source:** traced from `server.js` (~60k lines) at main `65d9ec2`
**Visual version:** `docs/mockups/message-templates-map.html` (filterable page)

Two transports for email — Resend (`sendEmail`, marketing + transactional) and the Gmail API
(`sendGmailEmail`, AHPRA/SPPA threads). WhatsApp is DoubleTick (`sendWhatsappText` freeform +
`sendDoubleTickTemplate` approved). Every `lib/*` file only *builds* copy; all sends live in server.js.

---

## The reminder question (what triggered this audit)

**Do meeting reminders reach the GP and practice, by email and WhatsApp, with the join link?**

| Reminder | GP email | GP WhatsApp | Practice email | Practice WhatsApp | Join link |
|---|---|---|---|---|---|
| Interview (GP ↔ practice) | ✅ | ✅ | ✅ | ❌ no phone stored | ✅ |
| **Consult call (/start booking)** | ❌ **none** | ❌ **none** | — | — | — |
| RSO assistance call | ❌ | ❌ | — | — | RSO only |

- **Interviews:** `interview-reminders` cron (`server.js:30543`) sends GP email + GP WhatsApp (24h + 1h,
  Zoom link in both), practice email (`30690`, "email only — no practice phone is stored"), RSO email + WhatsApp.
- **Consult call:** covered by `call-reminders` cron (`server.js:32021`), but that cron is **staff-facing** —
  it emails/WhatsApps the *RSO* (`to: assigned_rso_email` `32077`, RSO phone `32059`), not the GP. And a
  `/start` consult row has `assigned_rso_email = null`, so the `32039` filter drops it → **nobody is reminded**.
- **Calendly** sends its own confirmation + reminders to the doctor (Zoom link in the calendar invite), but
  that's Calendly's generic email; the app sends the consult booker nothing, and there's no WhatsApp.
- **All WhatsApp reminders are freeform** (`sendWhatsappText → /message/text`), so they only deliver inside
  the 24-hour WhatsApp session window. There is **no approved WhatsApp reminder template.**

---

## WhatsApp templates — the actionable list

WhatsApp won't deliver a business-initiated message outside a 24h window without a **pre-approved template**.
DoubleTick config `server.js:205-212`; registry `server.js:216-238`.

### Approved & live (4)
| Template | → | Fires |
|---|---|---|
| `gp_link_app_myintealth_introductiory_message_` | GP | case enters MyIntealth (`14714`) |
| `gp_link_app_amc_introductiory_message_` | GP | MyIntealth verified (`14729`) |
| `gp_link_app_ahpra_introductiory_message` | GP | placement secured (`14861`) |
| `gp_link_app_rso_welcome` | GP | RSO first assigned (`14390`) — **flagged pending approval, chase it** |

### To create (11) — currently freeform, no-op, or missing
| Need | → | Today |
|---|---|---|
| Consult call confirmation | GP | **missing** (only Calendly's own email) |
| Consult call reminder 24h + 1h | GP | **missing** — the consult booker is never reminded |
| Interview reminder | GP & RSO | freeform (`30663`, `30736`) |
| Interview slots ready | GP | freeform (`34330`, `60200`) |
| Zoom assistance-call invite / reschedule / re-book | GP | freeform (`39834`, `40133`, `18202`) |
| Stage-call reminder (~10 min) | RSO | freeform (`32062`) |
| Career stage intro | GP | no-op — call at `14748`, no template |
| Visa stage intro | GP | no-op — call at `14915`, no template |
| Support ticket received | GP | no-op — call at `14931`, no template |
| PEP waitlist / launch | GP | freeform (`8486`, `8510`) |
| VA nudge | GP | freeform (`48535`) |

### Orphans — keep or delete (13)
- **7 nudge templates** `gp_link_nudge_myintealth … _pbs, _checkin` (`14539-14547`) — map built, never referenced;
  `sendDoubleTickNudge` always sends freeform.
- **6 fallback texts** `DOUBLETICK_STAGE_MESSAGES` (`231-238`) — dormant while `DOUBLETICK_USE_DIRECT_TEXT=false`.

### ⚠️ Two DoubleTick request conventions coexist (real risk, UNCONFIRMED)
- Convention A (`Authorization: Bearer KEY`, body `{to,body}`): `sendWhatsappText`, `sendDoubleTickZoomCallInvite`, inline sends.
- Convention B (raw key, body `{messages:[{to,from,content}]}`): `sendDoubleTickTemplate`, `ensureRsoWelcomeSent`, `sendDoubleTickNudge`.
- DoubleTick's public API documents Convention B; the Convention-A sends may silently fail. Verify against the live API.

---

## Email inventory (~60, by area)

Only **3 sends are marketing** (unsubscribe + suppression): consult nudge, onboarding nudge, admin nudge.
Everything else transactional. 2 are forced-transactional (doc-renewal reminder, chase fallback).

**Funnel:** consult magic-link · consult nudge ×4 [mktg] · onboarding nudge ×7 [mktg] · practice intake invite ·
site-enquiry alert (ops) · PEP waitlist confirmation · PEP launch broadcast.
**Account:** email verification · welcome · onboarding complete · account activated · welcome/set-password ·
password reset (user+admin) · change-email confirm + security notice · support ticket reply.
**Journey:** MyIntealth/AMC/AHPRA complete · AHPRA unlocked · AHPRA per-task emails · stalled reminder ·
doc renewal reminder · doc approved/revision/verified · re-upload requested · doc delivered.
**Career:** match offer/24h/2h · position-filled redirect · application submitted (GP+ops) · stage/career-status
change · offer sent · practice-accepted congrats · placement secured · offer decision→sender · placement
confirmed→practice · candidate introduction→practice · interview slots ready · match/career-lock ops alerts (~8).
**Practice:** signed-agreement welcome · new-signed-practice (ops) · job live/approved · one-click response
alerts (ops+RSO) · approved/turned-down candidate (GP+ops) · availability request.
**Meetings:** Zoom invite/reschedule/resend · re-book (strike 1) · stage-call reminder (RSO) · interview
scheduled · interview reminder GP/practice/RSO · interview confirmed (GP+practice+RSO+ops, .ics) · interview
cancelled (GP+practice) · RSO call-outcome alert.
**Ops:** weekly owner digest · critical admin-action alert · ATS consultant invite · admin nudge [mktg] ·
RSO Inbox composer (5 canned templates + free compose, Gmail).
**AHPRA/SPPA (Gmail):** SPPA-00 to candidate/practice · SPPA corrections · SPPA practice chase · AHPRA officer
chase · AHPRA officer reply w/ doc (s80).

**Draft-only (RSO sends by hand, NOT auto-sent):** alt-supervisor CV request · AHPRA conflict letter ·
s80 draft reply · practice doc-revision request (Gmail draft).

---

## Gaps summary

1. **Consult booker gets no app message at all** — no confirmation, no reminder (email or WhatsApp). Only
   Calendly's generic email. This is the flow the Meta ads feed. Highest-impact gap.
2. **No practice WhatsApp** anywhere — no practice phone is captured. Would need a phone field on intake first.
3. **11 WhatsApp templates to build** in DoubleTick (above); until then those sends fail for cold contacts.
4. **Two DoubleTick API conventions** may mean half the WhatsApp sends silently fail — verify against live API.
5. **13 orphan templates/texts** to keep or delete.

Related memories: `whatsapp-rso-welcome-only`, `doubletick-blubeam-legacy`, `calendly-unmatched-booking-and-leads-tab`,
`ceo-interview-scheduling-build`, `rso-meeting-invite-branch`, `ahpra-per-task-emails`.
