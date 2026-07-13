# DoubleTick WhatsApp Templates

Templates that need to be created in the DoubleTick dashboard and approved by WhatsApp before switching from direct text mode to template mode.

## Status Legend
- **LIVE** — Created in DoubleTick, approved, and wired up in code
- **PENDING** — Template created in DoubleTick, awaiting WhatsApp approval
- **TODO** — Not yet created in DoubleTick

---

## Stage Introduction Templates — REMOVED 2026-07-13

**The app no longer WhatsApps a GP when they reach a new registration stage.** All five
stage introductions were removed (owner decision, 2026-07-13). The stage **emails** still
send exactly as before — only the WhatsApp copy went.

Do not re-add a stage-intro send without asking. The templates below may still exist and
be approved in the DoubleTick dashboard, but nothing in the code calls them.

| Template Name | Was sent when | Status in code |
|---|---|---|
| `gp_link_app_myintealth_introductiory_message_` | GP started MyIntealth | REMOVED |
| `gp_link_app_amc_introductiory_message_` | GP started AMC | REMOVED |
| `gp_link_app_ahpra_introductiory_message` | GP started AHPRA | REMOVED |
| `gp_link_app_career_introductiory_message` | GP started Career/Documents | REMOVED (never existed) |
| `gp_link_app_visa_introductiory_message` | GP started Visa | REMOVED (never existed) |

The stage-start sentinels in `task_timeline` are still stamped (`_hasStageSentinel`,
formerly `_hasDoubleTickBeenSent`) because they now dedupe the stage **emails**. The helper
still matches the legacy `— WhatsApp template sent` titles so GPs stamped before the
removal are recognised and never get a duplicate email.

Every other automated WhatsApp send is unchanged and still fires: the RSO welcome,
support-ticket confirmation, interview reminders, call reminders, the no-show alert,
the automatic Zoom re-invite, and the PEP waitlist confirmation.

---

## RSO Welcome Template (PENDING approval)

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

Template map: `DOUBLETICK_RSO_WELCOME_TEMPLATE` (server.js). Wired into every assignment path (admin reassign, CEO reassign, bulk reassign, and the `/api/admin/ops/resync-dt-assignment` trigger) — but NOT the inbound webhook (the GP already has a live chat there). If the owner picks the generic 1-placeholder wording instead, drop `{{2}}` and the `rsoFirstName` placeholder.

---

## Nudge Templates (TODO)

Sent by VA admins when a GP appears stalled. Currently using direct text mode as a fallback until these are approved.

| Template Name | Purpose | Placeholders | Status |
|---|---|---|---|
| `gp_link_nudge_myintealth` | Check-in during MyIntealth step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_amc` | Check-in during AMC step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_career` | Check-in during Career/Documents step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_ahpra` | Check-in during AHPRA step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_visa` | Check-in during Visa step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_pbs` | Check-in during PBS step | `{{1}}` = GP first name | TODO |
| `gp_link_nudge_checkin` | Generic check-in (no specific stage) | `{{1}}` = GP first name | TODO |

### Suggested copy for nudge templates:

**Stage-specific (e.g. `gp_link_nudge_amc`):**
> Hi {{1}}, just checking in on your AMC progress. Need any help with your current step? Reply here or reach out to your support expert Hazel for assistance.

**Generic (`gp_link_nudge_checkin`):**
> Hi {{1}}, just checking in — how are you going with your current step? If you're stuck or need help, reply here and we'll get you sorted.

---

## How Templates Are Used in Code

### `sendDoubleTickTemplate` in server.js
- The stage introductions that used to call this were removed on 2026-07-13
- Its only remaining caller is the `support_ticket_received` confirmation
- Template map: `DOUBLETICK_STAGE_TEMPLATES` — now empty. Because `DOUBLETICK_USE_DIRECT_TEXT`
  is `false`, `sendDoubleTickTemplate` looks for an approved template, finds none for
  `support_ticket_received`, and returns `{ok:false}` with a "No template configured"
  warning. **So the support-ticket WhatsApp does not currently reach the GP** — that was
  already true before this change, not caused by it. To make it send, either create the
  template in DoubleTick and add it to `DOUBLETICK_STAGE_TEMPLATES`, or flip
  `DOUBLETICK_USE_DIRECT_TEXT` to `true` (which uses the copy in `DOUBLETICK_STAGE_MESSAGES`).

### Nudges (`sendDoubleTickNudge` in server.js)
- Triggered manually by VA admin clicking "Send Nudge" in admin dashboard
- Template map: `nudgeTemplateMap` inside `sendDoubleTickNudge` function
- Currently always uses direct text mode until templates are approved
- To switch to template mode: update `sendDoubleTickNudge` to try template first, fall back to text

---

## Adding New Templates

When adding a new template:

1. Create the template in DoubleTick dashboard
2. Wait for WhatsApp approval (usually 24-48 hours)
3. Add the template name to the relevant map in `server.js`
4. Update this file — move from TODO to LIVE
5. Test with a real phone number

---

*Last updated: 2026-04-29*
