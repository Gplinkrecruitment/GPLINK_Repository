# Email Notifications

All email notifications sent by the GP Link app. System-automated emails are sent via Resend from `notifications@mygplink.com.au`. VA-initiated emails are sent manually from the VA's company email (e.g. `hazel@mygplink.com.au`).

---

## System-Automated Emails (via Resend)

Sent from: **GP Link \<notifications@mygplink.com.au\>**

| Email | Subject | Trigger | Recipient | Status |
|---|---|---|---|---|
| Email Verification | Verify your GP Link account | User signs up or unconfirmed user tries to login | GP | LIVE |
| Application Submitted | Application Submitted - GP Link | GP submits a job application | GP | LIVE |
| Interview Scheduled | Interview Scheduled - GP Link | Admin schedules an interview | GP | LIVE |
| Offer Pending | Offer Pending - GP Link | Application status changed to offer | GP | LIVE |
| Placement Secured | Placement Secured! - GP Link | Application status changed to hired/placed | GP | LIVE |
| Password Reset | (Supabase default) | User clicks "Forgot Password" | GP | LIVE (via Supabase) |

### Not Yet Built

| Email | Subject | Trigger | Recipient | Status |
|---|---|---|---|---|
| Welcome Email | Welcome to GP Link | After email verification confirmed | GP | TODO |
| Document Approved | Document Approved - GP Link | VA approves an uploaded document | GP | TODO |
| Document Revision | Revision Requested - GP Link | VA requests a document revision | GP | TODO |
| Stage Complete | Stage Complete - GP Link | GP completes a registration stage | GP | TODO |
| Nudge Email | Check-in from GP Link | VA sends a nudge (email channel) | GP | TODO |
| Weekly Progress | Your Weekly Progress - GP Link | Scheduled weekly for active GPs | GP | TODO |
| Practice Submission | Candidate Submitted - GP Link | VA submits GP to a practice | Practice contact | TODO |
| Admin Alert: New Signup | New GP Signup - GP Link | New user signs up | Admin/VA | TODO |
| Admin Alert: Help Request | GP Help Request - GP Link | GP submits a support ticket | Admin/VA | TODO |

---

## VA-Initiated Emails (via company email client)

Sent from: **VA's company email** (e.g. `hazel@mygplink.com.au`)

These are triggered by the VA clicking "Email Practice" buttons in the admin dashboard. The app opens the VA's email client with a pre-filled mailto: link. The VA sends from their own email account.

| Email | Subject (pre-filled) | Trigger | Recipient |
|---|---|---|---|
| Request Supervisor CV | Supervisor CV Required - [GP Name] at [Practice] | VA clicks "Email Practice for Supervisor CV" | Practice contact |
| Request Offer/Contract | Offer/Contract Required - [GP Name] at [Practice] | VA clicks "Email Practice for Contract" | Practice contact |
| Request Revision | (VA composes) | VA clicks "Request Revision" on a document | Practice contact |

---

## Integration-Based Emails (not via Resend)

These go through third-party integrations, not our email system.

| Email | Sent Via | Trigger | Recipient |
|---|---|---|---|
| SPPA-00 Signing Request | Zoho Sign | VA sends SPPA-00 envelope | GP + Practice contact |
| Candidate Submission to Practice | Zoho Recruit | VA submits application to practice | Practice contact |

---

## WhatsApp Notifications (via DoubleTick)

Not emails, but part of the notification system. See `docs/doubletick-templates.md` for template details.

| Notification | Trigger | Recipient |
|---|---|---|
| MyIntealth Welcome | GP enters MyIntealth stage | GP |
| AMC Started | GP completes MyIntealth verification | GP |
| AHPRA Started | GP unlocks AHPRA | GP |
| Nudge Check-in | VA clicks "Send Nudge" | GP |

---

## Configuration

### Resend (system-automated emails)
```
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM_EMAIL=notifications@mygplink.com.au
RESEND_FROM_NAME=GP Link
```

Domain `mygplink.com.au` must be verified in Resend with DNS records (SPF, DKIM).

### Spam Isolation Strategy
- System-automated emails: `notifications@mygplink.com.au` (via Resend)
- VA team emails: `hazel@mygplink.com.au`, `hello@mygplink.com.au` (via company email)
- If automated notifications get spam-flagged, VA team emails are unaffected because they use different sender addresses and different delivery infrastructure (Resend vs company email provider)

---

*Last updated: 2026-05-03*
