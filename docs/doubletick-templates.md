# DoubleTick WhatsApp Templates

## The rule (2026-07-13)

**The RSO welcome is the only WhatsApp message the app sends on its own.**

Every other automated send was removed — stage introductions, the support-ticket
confirmation, call and interview reminders, the no-show re-invite, and the PEP
waitlist confirmation. Those notifications still go out **by email**; they just no
longer fire a WhatsApp.

WhatsApp is now one of exactly two things:

1. the one-time RSO welcome, sent automatically when a GP is first assigned to an RSO; or
2. a message a human deliberately sends from the dashboard.

If you are adding a new WhatsApp send, it must fall into one of those two buckets.

## Status Legend
- **LIVE** — Created in DoubleTick, approved, and wired up in code
- **PENDING** — Template created in DoubleTick, awaiting WhatsApp approval
- **TODO** — Not yet created in DoubleTick

---

## RSO Welcome Template (PENDING approval) — the only automatic send

Sent by the app the **first time a GP is assigned to an RSO** (`ensureRsoWelcomeSent` in server.js). Purpose: **materialise the GP's DoubleTick conversation** so it appears in that RSO's assigned inbox — a first-contact message to a GP who has never messaged us must be an approved template. Sent once per GP (idempotent via a `task_timeline` sentinel), fail-soft until approved.

| Template Name | Purpose | Placeholders | Status |
|---|---|---|---|
| `gp_link_app_rso_welcome` | Welcome + connect GP to their assigned RSO | `{{1}}` = GP first name; `{{2}}` + `{{3}}` = RSO first name (distinct slots, same value — WhatsApp-safe, avoids a repeated variable) | PENDING (owner-approved copy, submitted for WhatsApp approval) |

**Final copy (owner-approved 2026-07-13):**
> Hi Dr {{1}}, welcome to GP Link 👋
>
> I'm {{2}}, your dedicated Registration Support Officer. I'll be your main point of contact and will guide you through every step of getting registered to work as a GP in Australia.
>
> Whenever you have a question or need a hand, just shoot me a message. Excited to be working with you and in helping you start this next chapter in life!
>
> Warm regards,
> {{3}}
> Registration Support Officer
> GP Link

Template map: `DOUBLETICK_RSO_WELCOME_TEMPLATE` (server.js). Wired into every assignment path (admin reassign, CEO reassign, bulk reassign, and the `/api/admin/ops/resync-dt-assignment` trigger) — but NOT the inbound webhook (the GP already has a live chat there).

---

## Human-triggered sends (kept — a person presses the button)

These are not automatic: an RSO chooses to send them from the dashboard.

| Sender (server.js) | Trigger |
|---|---|
| `/api/admin/whatsapp/send` | RSO types a freeform WhatsApp message |
| `sendDoubleTickZoomCallInvite` | RSO schedules, reschedules, or resends a Zoom call invite |
| `sendDoubleTickNudge` | RSO clicks "Send Nudge" on a stalled GP |
| `sendWhatsappText` (PEP launch) | Owner presses the "launch PEP pathway" button |

### Nudge templates (TODO — still direct text)

`sendDoubleTickNudge` always uses direct text mode; these templates were never created.

| Template Name | Purpose | Placeholders | Status |
|---|---|---|---|
| `gp_link_nudge_myintealth` | Check-in during MyIntealth step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_amc` | Check-in during AMC step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_career` | Check-in during Career/Documents step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_ahpra` | Check-in during AHPRA step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_visa` | Check-in during Visa step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_pbs` | Check-in during PBS step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_checkin` | Generic check-in (no specific stage) | `{{1}}` = GP first name | TODO |

---

## Removed on 2026-07-13 (do not re-add without asking)

The stage-introduction templates below are **no longer sent by the app**. They may
still exist and be approved in the DoubleTick dashboard, but nothing in the code
calls them. `sendDoubleTickTemplate`, `DOUBLETICK_STAGE_TEMPLATES` and
`DOUBLETICK_STAGE_MESSAGES` were deleted.

| Template Name | Was sent when |
|---|---|
| `gp_link_app_myintealth_introductiory_message_` | GP started MyIntealth |
| `gp_link_app_amc_introductiory_message_` | GP started AMC |
| `gp_link_app_ahpra_introductiory_message` | GP started AHPRA |

Also removed (these were direct-text, not templates):

- support-ticket-received confirmation to the GP
- "your interview times are ready" to the GP (both the practice-decision and availability-reply paths)
- interview reminder to the GP, and to the RSO
- 10-minutes-until-your-call reminder to the RSO
- no-show / cancellation alert to the RSO
- automatic Zoom re-invite to the GP after a no-show
- PEP waitlist confirmation to the GP

The **email** version of each of these still sends. The stage-start sentinels in
`task_timeline` are still stamped (`_hasStageSentinel`) because they now dedupe the
stage emails.

---

## Adding New Templates

1. Create the template in DoubleTick dashboard
2. Wait for WhatsApp approval (usually 24-48 hours)
3. Add the template name to the relevant map in `server.js`
4. Update this file — move from TODO to LIVE
5. Test with a real phone number

---

*Last updated: 2026-07-13*
