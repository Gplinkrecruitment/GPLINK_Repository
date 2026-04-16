# Practice Pack Phase 2 — Zoho Sign SPPA-00 + AI Email Triage — Design Spec

## Overview

Phase 2 completes the Practice Pack document pipeline by adding:

1. **Zoho Sign integration** for the SPPA-00 document — VA sends via API, Practice Contact signs first, Candidate signs second, VA reviews the completed envelope against a checklist, then approves → PDF lands in GP MyDocuments + Google Drive.
2. **AI-powered inbound email triage** — any email at `hazel@mygplink.com.au` that relates to a placed GP is classified by Sonnet 4.6, grouped with the right GP, and surfaced to the VA as an actionable to-do. Phase 1b's attachment-matching AI is also upgraded from Haiku to Sonnet for higher accuracy.

Phase 2 builds on Phase 1a (document workflows, Google Drive) and Phase 1b (Gmail watch, webhook, pre-filter) — reusing all their infrastructure.

---

## 1. Architecture Overview

```
VA Admin Dashboard          server.js              Zoho Sign API       Signers (Contact → Candidate)
        │                      │                         │                        │
        │  [Career secured]    │                         │                        │
        │───────────────────▶ create_envelope_from_template                        │
        │                      │──────────────────────▶ │                        │
        │                      │◀──── envelope_id ───── │                        │
        │                      │                         │──── signing email ───▶│
        │                      │                         │                        │
        │                      │◀──── webhook: viewed/signed/completed ──────────│
        │◀── realtime status ──│                         │                        │
        │                      │                         │                        │
        │  [VA clicks Review]  │                         │                        │
        │───────────────────▶ GET signed PDF            │                        │
        │◀── PDF preview ──────│                         │                        │
        │                      │                         │                        │
        │  [VA Approves]       │                         │                        │
        │───────────────────▶ save to MyDocuments + Drive, mark task complete    │
        │                      │                         │                        │
        │  [VA Requests Correction]                      │                        │
        │───────────────────▶ fetch old fields → void → new envelope to affected │
        │                      │   signer only, non-flagged sections prefilled ─▶│
```

Components:

- **Zoho Sign OAuth module** — mirrors existing Zoho Recruit pattern (admin-initiated OAuth, Supabase-stored refresh token, 5-min-before-expiry auto-refresh).
- **Envelope service** — thin wrapper around Zoho Sign REST: `createFromTemplate`, `getEnvelope`, `getFieldValues`, `voidEnvelope`, `downloadSignedPdf`, `updateRecipientEmail`.
- **Zoho Sign webhook handler** — `POST /api/webhooks/zoho-sign`, HMAC-validated with idempotency.
- **Task-card UI** — 5-stage status chip, "Review" panel with PDF preview + checklist, "Request Correction" modal.
- **AI Email Triage** — extension to Phase 1b Gmail pipeline: when a post-filter email has no attachments (or has attachments but they don't match any open task), Sonnet 4.6 classifies it, matches to a placed GP, and creates an "Incoming Questions" to-do.

---

## 2. Send & Status Flow

### 2.1 Trigger

On Practice Pack creation (career secured):

```
practiceContact.email present AND Zoho Sign connected?
  ├── YES → server calls createEnvelopeFromTemplate
  │          Task card: "Sent to Contact"
  │
  └── NO  → Task card shows "Send SPPA-00" button
            Clicking → same API call
            If Zoho Sign not connected: button disabled with
            "Zoho Sign disconnected — connect in Integrations"
```

Auto-send preconditions (all must be true):
- `zoho_sign_connection` row exists and token is refreshable
- `ZOHO_SIGN_SPPA_TEMPLATE_ID` env var is set
- Placement has a valid Practice Contact email (RFC-5322 validation)

### 2.2 Status progression — five labels on the task card

| Webhook event from Zoho | Task card label |
|---|---|
| `envelope.requesting_sign` (recipient #1) | **Sent to Contact** |
| `envelope.signed` (recipient #1) | **Contact Signed** |
| `envelope.requesting_sign` (recipient #2) | **Sent to Candidate** |
| `envelope.signed` (recipient #2) | **Candidate Signed** |
| `envelope.completed` | **Awaiting VA Review** |

Also shown on the card:
- **"Days since sent"** counter (grey → orange at day 7 → red at day 14).
- **Envelope ID** + a deep-link button "Open in Zoho Sign" for VA troubleshooting.
- On `declined`, `expired`, or **unexpected** `voided`: red state + **"Re-send"** button.
- On `voided` caused by our own correction flow: no red state; the replacement envelope takes over.

### 2.3 Field pre-population

**The server does not pre-fill any template fields on the initial send.** The SPPA-00 template itself has baked-in defaults (e.g., supervision arrangements) set up in Zoho Sign's template editor. Signers fill their respective sections during signing.

The *only* time the server pre-fills fields is during the correction flow (Section 4.2), where values are carried forward from the prior (voided) envelope using Zoho Sign's field-values API — not from our database or Zoho Recruit.

### 2.4 Reminders

Zoho Sign's native reminder engine handles nagging stalled signers. We do not build custom reminder logic.

---

## 3. VA Review UI

When the task card reaches **"Awaiting VA Review"**, clicking it opens a review panel:

```
┌─────────────────────────────────────────────────────────────┐
│ SPPA-00 — Dr Jane Smith at Melbourne Family Medical         │
│ Envelope: ZS-E-74982    [Open in Zoho Sign ↗]               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│    [ PDF preview of the signed SPPA-00 — full width ]       │
│    [ scrollable, page navigation, download button ]         │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│ VA Review Checklist                                          │
│   ☐ All fields complete                                      │
│   ☐ Candidate name matches user profile                      │
│   ☐ Both signatures present                                  │
│   ☐ Dates are plausible (start date ≥ today)               │
├─────────────────────────────────────────────────────────────┤
│  [ Request Correction ▾ ]           [ Approve & Send to GP ] │
└─────────────────────────────────────────────────────────────┘
```

- **"Approve & Send to GP"** is enabled only when all checklist boxes are ticked.
- Checklist items are hard-coded in Phase 2 as above. Team will expand once it's working.

---

## 4. Approval & Correction Flows

### 4.1 Approval → GP delivery

```
VA clicks Approve
      │
      ▼
1. Server downloads signed PDF from Zoho Sign
     GET /api/v1/requests/{envelope_id}/pdf
      │
      ▼
2. Save to GP's MyDocuments
     - Reuses deliverToMyDocuments(userId, 'sppa_00', 'SPPA-00 Signed.pdf', buffer, 'application/pdf')
      │
      ▼
3. Upload to Google Drive
     - Target: GP Candidate Documents/Dr [Name]/SPPA-00.pdf
     - Reuses uploadToGoogleDrive() helper
     - Store Drive file ID in zoho_sign_envelopes.signed_pdf_drive_id
      │
      ▼
4. Mark task complete
     - registration_tasks.status = 'complete'
     - completed_by = admin user ID
     - completed_at = now
      │
      ▼
5. Log timeline events
     - "VA approved signed SPPA-00" (on case)
     - "SPPA-00 delivered to MyDocuments" (on user)
      │
      ▼
6. Update envelope record
     - zoho_sign_envelopes.status = 'approved'
```

All delivery infrastructure is reused from Phase 1a; Phase 2 only wires Zoho Sign → the delivery helpers.

### 4.2 Correction flow — "Request Correction"

Triggered when VA reviews a completed envelope and finds a problem.

**UI (modal):**
1. Radio: **Who needs to correct this?** → *Practice Contact* / *Candidate*
2. Checkboxes: **Which sections need correction?** → e.g., Candidate details / Practice details / Commencement terms / Signatures
3. Note textarea (required) — short explanation the signer will see in their email
4. [Submit Correction] button

**Server:**
1. Fetch all field values from the old envelope (`getFieldValues`).
2. Void the old envelope (status: `voided_for_correction`).
3. Create a new envelope from the SPPA-00 template, sending **only to the flagged signer**.
4. Pre-fill every field **except** those in the flagged section(s), using the old values fetched in step 1.
5. Append the VA's note to the signing request email.
6. Task card status returns to "Sent to Contact" or "Sent to Candidate" based on recipient.

**Legal caveat (documented explicitly for future maintainers):**
Sending the correction envelope only to the affected signer means the non-affected signer's signature stays on the pre-correction (voided) envelope and does not cover the correction. Operationally fine for typos and minor fixes; **material changes** (e.g., changed start date, changed remuneration) should trigger re-signature from both parties. The VA exercises judgment at the correction-request step. This trade-off is deliberate to reduce back-and-forth friction.

### 4.3 Decline / unexpected void / expiry

| Terminal state | Cause | UI |
|---|---|---|
| `declined` | Signer clicked "Decline to sign" | Red card + decline reason from webhook + "Re-send" button |
| `voided` (unexpected) | VA manually voided in Zoho Sign dashboard, or org access revoked | Red card + "Re-send" button |
| `voided_for_correction` | Our own correction flow | No red card; replacement envelope takes over |
| `expired` | Signer never completed for >3 months (Zoho platform-level cap) | Red card + "Re-send" button |

### 4.4 Recipient email delivery failure

Zoho Sign emits `recipient_delivery_failed` when a signer's email bounces (typo, full inbox, etc.).

- Task goes to amber state: **"Contact email bounced — edit and resend"**.
- Inline form shows current email with edit affordance + **"Resend"** button.
- Submitting calls `updateRecipientEmail` if Zoho supports it on live envelopes; otherwise voids and creates a fresh envelope with the corrected email.

---

## 5. AI Email Triage & Auto-To-Do

This extends Phase 1b's Gmail pipeline to surface **all GP-related inbound emails** as VA to-dos, not only attachments.

### 5.1 Pipeline extension

```
Gmail push → webhook → pre-filter
                          │
                          ▼
              Has attachments?
                ├── yes → existing Phase 1b flow (Sonnet attachment matching)
                │          │
                │          ├── matched → task card update (green/yellow)
                │          └── unmatched → "Incoming Documents" panel (existing)
                │
                └── no  → NEW: AI triage (Sonnet 4.6)
                          identifies:
                            - Which placed GP this is about
                            - Category (signing_question | document_request |
                              schedule_query | status_update | other)
                            - Urgency (low | normal | high)
                            - One-sentence summary
                          │
                          ▼
                  Confidence ≥ 0.7?
                    ├── yes → to-do in "Incoming Questions" panel,
                    │         grouped under the matched GP
                    └── low → "Needs Triage" panel for manual VA routing
```

### 5.2 VA UI — "Incoming Questions" panel

Placed next to the existing "Incoming Documents" panel in the VA Inbox. Example:

```
Incoming Questions                                          [3]
─────────────────────────────────────────────────────────
▸ [SIGNING]  Dr Jane Smith — Practice contact asking about
             clause 4.2 of SPPA-00           (2h ago) 🟡
▸ [SCHEDULE] Dr Tom Lee — Contact wants to push start date
             back 2 weeks                    (5h ago) 🔴
▸ [OTHER]    Dr Sarah Wong — Needs triage    (1d ago) ⚪
─────────────────────────────────────────────────────────
```

Clicking an entry opens the email body with the AI summary + a **[Reply via Gmail]** button that opens a pre-populated draft. Dismissing marks the to-do as resolved.

### 5.3 Model selection

Both AI paths use **Sonnet 4.6** (`claude-sonnet-4-6`):

| Task | Model | Why |
|---|---|---|
| Phase 1b attachment-matching | **Sonnet 4.6** (upgraded from Haiku) | Multi-option matching of attachment to open tasks; disambiguation matters when multiple tasks are open per GP |
| Phase 2 email triage | **Sonnet 4.6** | Multi-class classification, entity disambiguation, nuanced urgency judgment |

Haiku is deprecated from the Practice Pack AI paths entirely.

### 5.4 GP identification logic

The triage call receives:
- A compact list of all "placed GPs" (GP name + practice name + contact emails + active envelope IDs)
- Email headers (From, Subject, Date)
- Email body (truncated to first 4000 chars to bound cost)

Sonnet returns structured JSON:
```
{
  "matched_gp_user_id": "uuid-or-null",
  "confidence": 0.0-1.0,
  "category": "signing_question | document_request | schedule_query | status_update | other",
  "urgency": "low | normal | high",
  "summary": "one sentence",
  "needs_triage": bool
}
```

### 5.5 Cost control

- Prompt caching enabled on the "placed GPs context" block (5-min TTL) — cuts input cost by ~30–40% in high-traffic windows.
- All AI calls gated behind the existing Phase 1b pre-filter (already drops marketing, internal, and bounce emails).
- Daily Anthropic spend cap remains at `ANTHROPIC_DAILY_LIMIT_USD` (default 100) — applies across all AI features.
- At 150 inbound/day assuming ~70% post-filter → ~$0.80/day → ~$25/month.

---

## 6. OAuth Setup & Admin Connection

Mirrors the existing Zoho Recruit OAuth pattern.

### 6.1 Zoho-side setup (operator task)

1. At `api-console.zoho.com.au`, register a new Server-based Application named "GP Link Zoho Sign".
2. Redirect URI: `https://www.mygplink.com.au/api/admin/integrations/zoho-sign/callback`.
3. Copy Client ID + Client Secret to Vercel env.

### 6.2 Admin dashboard UI

- New section: **Integrations → Zoho Sign**.
- Shows: `Status: Not connected` + **"Connect Zoho Sign"** button.
- Clicking launches OAuth consent flow → user approves scopes → redirected back → server stores the refresh token in `zoho_sign_connection`.
- Status flips to `Connected as [org-name]` + token expiry + **"Disconnect"** button.

### 6.3 Scopes

- `ZohoSign.documents.ALL`
- `ZohoSign.templates.READ`
- `ZohoSign.account.READ`

### 6.4 Webhook auto-registration

After OAuth success, server makes a one-time API call to register `/api/webhooks/zoho-sign` with a generated HMAC secret (stored in `zoho_sign_connection.webhook_secret`). No manual webhook config in Zoho UI.

### 6.5 Graceful disconnect behavior

If `zoho_sign_connection` row is missing, or token refresh fails and retries are exhausted:

- Admin dashboard top banner: **"Zoho Sign disconnected — SPPA-00 sends are paused. [Reconnect]"**.
- Auto-send on new Practice Packs is skipped; task card shows **"Send SPPA-00"** button with warning text.
- All other Practice Pack tasks continue normally.

---

## 7. Webhook Handling

### 7.1 Endpoint

`POST /api/webhooks/zoho-sign`

### 7.2 Security

- Zoho Sign signs each webhook payload with HMAC-SHA256 using the secret from `zoho_sign_connection.webhook_secret`.
- Server validates the `X-ZS-Webhook-Signature` header against a recomputed HMAC of the raw body.
- Invalid signature → `401`, logged to server console.
- Timing-safe comparison (`timingSafeEqualStrings`, reuse from existing `zoho-recruit` helpers).

### 7.3 Event map

| Zoho event | Our action |
|---|---|
| `envelope.requesting_sign` | Update task status; store recipient sent-at |
| `envelope.viewed` | No status change; append timeline entry |
| `envelope.signed` | Update task status (per recipient index) |
| `envelope.completed` | Update task: `Awaiting VA Review`; cache signed PDF reference; create urgent to-do in VA Inbox |
| `envelope.declined` | Red state + decline reason |
| `envelope.voided` | If `voided_for_correction`, ignore; else red state |
| `envelope.expired` | Red state |
| `recipient_delivery_failed` | Amber state + edit-email UI |

### 7.4 Idempotency

Each webhook carries a `notification_id`. We store processed IDs in `processed_zoho_sign_events` (same pattern as Phase 1b's `processed_gmail_messages`) to survive Zoho's at-least-once delivery.

### 7.5 Response contract

Always `200 OK` within 3 seconds, even if processing fails internally. Actual processing runs async in the background to prevent Zoho from retry-spamming us if downstream operations (e.g., Drive upload) are slow.

---

## 8. Database Schema

### 8.1 New tables

**`zoho_sign_connection`** (singleton)

```sql
create table zoho_sign_connection (
  id                    uuid primary key default gen_random_uuid(),
  access_token          text,
  refresh_token         text,
  token_expires_at      timestamptz,
  org_id                text,
  org_name              text,
  webhook_secret        text,
  webhook_registered_at timestamptz,
  connected_by          uuid references users(id),
  updated_at            timestamptz default now()
);
```

**`zoho_sign_envelopes`**

```sql
create table zoho_sign_envelopes (
  envelope_id           text primary key,
  task_id               uuid references registration_tasks(id),
  user_id               uuid references users(id),
  case_id               uuid references registration_cases(id),
  template_id           text not null,
  status                text not null,
    -- sent_to_contact | contact_signed | sent_to_candidate
    -- candidate_signed | awaiting_review | approved
    -- declined | voided | voided_for_correction | expired
    -- recipient_delivery_failed
  recipient_contact     jsonb,          -- { email, name }
  recipient_candidate   jsonb,
  sent_at               timestamptz,
  completed_at          timestamptz,
  decline_reason        text,
  previous_envelope_id  text,           -- self-FK for corrections
  correction_sections   text[],
  correction_note       text,
  signed_pdf_drive_id   text,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);
```

**`processed_zoho_sign_events`**

```sql
create table processed_zoho_sign_events (
  notification_id   text primary key,
  envelope_id       text,
  event_type        text,
  received_at       timestamptz default now()
);
```

**`incoming_email_todos`** (new — for AI triage results)

```sql
create table incoming_email_todos (
  id                uuid primary key default gen_random_uuid(),
  gmail_message_id  text not null unique,
  matched_user_id   uuid references users(id),    -- null if needs_triage
  sender_email      text not null,
  subject           text,
  ai_category       text,           -- signing_question | document_request | ...
  ai_urgency        text,           -- low | normal | high
  ai_summary        text,
  ai_confidence     real,
  needs_triage      boolean default false,
  resolved_at       timestamptz,    -- when VA dismisses
  resolved_by       uuid references users(id),
  created_at        timestamptz default now()
);
```

### 8.2 Extensions to `registration_tasks`

```sql
alter table registration_tasks add column zoho_sign_envelope_id text;
  -- references zoho_sign_envelopes.envelope_id
```

"Days since sent" shown on the task card is computed at render time from `zoho_sign_envelopes.sent_at` — no stored column, no cron required.

---

## 9. API Endpoints

### 9.1 OAuth

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/integrations/zoho-sign/auth-url` | Generate OAuth consent URL |
| GET | `/api/admin/integrations/zoho-sign/callback` | OAuth callback handler |
| POST | `/api/admin/integrations/zoho-sign/disconnect` | Revoke tokens, clear row |
| GET | `/api/admin/integrations/zoho-sign/status` | Connection status for dashboard |

### 9.2 Envelope actions

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/va/task/:taskId/send-sppa` | Create and send SPPA-00 envelope |
| GET | `/api/admin/va/task/:taskId/sppa-pdf` | Preview signed PDF |
| POST | `/api/admin/va/task/:taskId/sppa-approve` | Approve, deliver to GP, complete task |
| POST | `/api/admin/va/task/:taskId/sppa-request-correction` | Correction flow |
| POST | `/api/admin/va/task/:taskId/sppa-update-recipient` | Fix bounced email |
| POST | `/api/admin/va/task/:taskId/sppa-resend` | Manual re-send after decline / expiry |

### 9.3 Inbound

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/webhooks/zoho-sign` | Webhook from Zoho Sign |

### 9.4 Email triage to-dos

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/va/incoming-questions` | List unresolved to-dos |
| POST | `/api/admin/va/incoming-questions/:id/assign` | Manual reassignment from triage |
| POST | `/api/admin/va/incoming-questions/:id/resolve` | Mark dismissed |

---

## 10. Environment Variables

| Variable | Purpose |
|---|---|
| `ZOHO_SIGN_CLIENT_ID` | OAuth client ID from api-console.zoho.com.au |
| `ZOHO_SIGN_CLIENT_SECRET` | OAuth client secret |
| `ZOHO_SIGN_REDIRECT_URI` | `https://www.mygplink.com.au/api/admin/integrations/zoho-sign/callback` |
| `ZOHO_SIGN_ACCOUNTS_SERVER` | `https://accounts.zoho.com.au` |
| `ZOHO_SIGN_API_BASE` | `https://sign.zoho.com.au/api/v1` |
| `ZOHO_SIGN_SPPA_TEMPLATE_ID` | ID of the SPPA-00 template in your Zoho Sign org |

The webhook HMAC secret is NOT an env var — it is generated per-connection during OAuth setup and stored in `zoho_sign_connection.webhook_secret`. This lets operators rotate the secret by reconnecting without a redeploy.

Existing env vars reused without change:
- `ANTHROPIC_API_KEY` (Sonnet calls for triage + upgraded attachment matching)
- `ANTHROPIC_DAILY_LIMIT_USD`
- `GOOGLE_SERVICE_ACCOUNT_*` (Drive delivery)
- Gmail infrastructure (Pub/Sub topic, webhook secret) from Phase 1b
- `SUPABASE_*`, `AUTH_SECRET`, `CRON_SECRET`

---

## 11. Operational Safeguards

1. **Zoho Sign disconnected:** top banner in admin + auto-send paused + manual "Send SPPA-00" button disabled with clear message. Already described in Section 6.5.
2. **Contact email bounce:** amber state + inline email edit + resend. Section 4.4.
3. **Unexpected void / decline / expired:** red state + "Re-send" with clear VA action. Section 4.3.
4. **Webhook signature mismatch:** 401 + logged; envelope status reconciled via daily cron (see Phase 1b's pattern).
5. **AI classifier low confidence:** email goes to "Needs Triage" panel; never silently dropped.
6. **Daily AI spend cap:** existing `ANTHROPIC_DAILY_LIMIT_USD` covers all AI features; exceeding → 429 responses + ops alert (same behavior as Phase 1b).

---

## 12. Deliverables Summary

**Code:**
- New helper module: `zoho-sign-client.js` (thin wrapper over Zoho Sign REST).
- New server.js sections:
  - Zoho Sign OAuth handlers (~6 endpoints)
  - Zoho Sign webhook handler
  - Envelope send / review / approve / correction endpoints
  - AI email triage in the existing Gmail webhook flow
  - Incoming Questions API endpoints
- New admin.html sections:
  - Integrations → Zoho Sign connection card
  - SPPA-00 task card — 5-stage status chip, Review panel, Correction modal, Edit-email form
  - Incoming Questions panel in VA Inbox
- DB migration: `supabase/migrations/20260417000000_zoho_sign_and_email_triage.sql`
- Model upgrade: Phase 1b attachment matching — swap Haiku → Sonnet 4.6

**Infrastructure (final implementation task):**
- Register OAuth client in api-console.zoho.com.au
- Set Vercel env vars
- Run Supabase migration
- Run admin OAuth flow to connect Zoho Sign
- Verify webhook auto-registration succeeded
- Update memory notes

---

## 13. Out of Scope for Phase 2

- Candidate-facing SPPA-00 UI (candidates sign via Zoho's email link, not inside the app).
- SMS reminders (Zoho Sign can do this natively if configured on the template).
- Custom email templates for signing invites (Zoho Sign template controls these).
- Multi-template support (Phase 2 handles SPPA-00 only; additional templates are a future phase).
- Signature image upload by VA (signers always sign themselves in Zoho Sign).
- Per-field (vs per-section) correction granularity — future enhancement if per-section proves too coarse.
