# DoubleTick WhatsApp Templates

Templates that need to be created in the DoubleTick dashboard and approved by WhatsApp before switching from direct text mode to template mode.

## Status Legend
- **LIVE** — Created in DoubleTick, approved, and wired up in code
- **PENDING** — Template created in DoubleTick, awaiting WhatsApp approval
- **TODO** — Not yet created in DoubleTick

---

## Stage Introduction Templates (LIVE)

Sent automatically when a GP progresses to a new registration stage.

| Template Name | Stage | Placeholders | Status |
|---|---|---|---|
| `gp_link_app_myintealth_introductiory_message_` | MyIntealth welcome | `{{1}}` = GP first name | LIVE |
| `gp_link_app_amc_introductiory_message_` | AMC started | `{{1}}` = GP first name | LIVE |
| `gp_link_app_ahpra_introductiory_message` | AHPRA started | `{{1}}` = GP first name | LIVE |

### Not yet created:
| Template Name | Stage | Placeholders | Status |
|---|---|---|---|
| `gp_link_app_career_introductiory_message` | Career/Documents started | `{{1}}` = GP first name | TODO |
| `gp_link_app_visa_introductiory_message` | Visa started | `{{1}}` = GP first name | TODO |

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

### Stage introductions (`sendDoubleTickTemplate` in server.js)
- Triggered automatically by task automation when GP completes a stage
- Template map: `DOUBLETICK_STAGE_TEMPLATES` (server.js ~line 130)
- Falls back to direct text via `DOUBLETICK_STAGE_MESSAGES` if template not configured

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
