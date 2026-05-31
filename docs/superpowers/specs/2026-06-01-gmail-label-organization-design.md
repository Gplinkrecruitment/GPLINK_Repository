# Gmail Label Organization System — Design Spec

**Date:** 2026-06-01
**Status:** Draft

---

## Overview

Automatically organize all candidate-related emails into Gmail labels (folders) for each VA/admin officer and the master `hello@mygplink.com.au` archive. Emails are filed regardless of whether they're sent through the admin UI or directly from Gmail.

---

## Label Structure

### VA's Gmail Account (e.g., `hazel@mygplink.com.au`)

```
Expedited Specialist Pathway/
  Dr Jane Smith
  Dr Jane Smith - Sunshine Medical Centre    ← renamed when practice confirmed
  Dr Ahmed Khan - Coastal Family Practice
Archived/
  Dr Sarah Lee - Metro Health               ← moved here on reassignment
```

- **Active labels** live under the pathway parent (e.g., `Expedited Specialist Pathway/`)
- **One flat `Archived/` label** collects all GPs reassigned away from this VA
- Label starts as `Dr [Name]`, renamed to `Dr [Name] - [Practice]` when practice is confirmed on the case

### Master Archive (`hello@mygplink.com.au`)

```
Expedited Specialist Pathway/
  Hazel/
    Dr Jane Smith - Sunshine Medical Centre
    Dr Ahmed Khan - Coastal Family Practice
  Maryam/
    Dr John Doe - Rural Practice
```

- Organized by **assigned admin officer** first, then GPs as sub-labels
- On reassignment: GP sub-label moves from old officer's folder to new officer's folder (no archiving — hello@ keeps all history)
- Emails filed here are **never placed in INBOX** — silent archive only

---

## Label Lifecycle

### Creation

Labels are created when `assigned_va` is set on a `registration_case` (via `PUT /api/admin/case`).

**What gets created:**
1. On the **assigned VA's Gmail**: `Expedited Specialist Pathway/Dr [GP Name]`
2. On **hello@**: `Expedited Specialist Pathway/[VA Display Name]/Dr [GP Name]`

If the pathway parent label or VA sub-label doesn't exist yet, create it.

### Rename (Practice Confirmed)

When `practice_name` is set or updated on the registration case:
- VA label: `Expedited Specialist Pathway/Dr [Name]` → `Expedited Specialist Pathway/Dr [Name] - [Practice]`
- hello@ label: `Expedited Specialist Pathway/[VA]/Dr [Name]` → `Expedited Specialist Pathway/[VA]/Dr [Name] - [Practice]`

Gmail API: Use `users.labels.patch()` to update the label name.

### Reassignment

When `assigned_va` changes on a case:

**Old VA's account:**
1. Move the GP's label from `Expedited Specialist Pathway/[GP Label]` to `Archived/[GP Label]`
2. Historical emails remain labeled (no deletion)

**New VA's account:**
1. Create label: `Expedited Specialist Pathway/Dr [Name] - [Practice]`
2. Copy email history from old VA's label into new VA's account via `gmail.users.messages.insert()` with the new label applied (no INBOX label)

**hello@ account:**
1. Re-parent the GP sub-label from `Expedited Specialist Pathway/[Old VA]/[GP]` to `Expedited Specialist Pathway/[New VA]/[GP]`
2. All existing emails under that label remain — no re-filing needed

---

## Auto-Filing Logic

### Matching Criteria

An email is considered "related to a candidate" if ANY of these match:

| Match Type | Example | Source |
|-----------|---------|--------|
| GP's registered email (exact) | `dr.smith@gmail.com` | `user_state.email` or `registration_cases.gp_email` |
| Practice domain (any address) | `*@sunshinemedical.com.au` | Derived from `practice_contact` email on the case |
| Detected contact (exact) | `manager@sunshinemedical.com.au` | `practice_detected_contacts` table |

**Matching applies to:** From, To, CC, and BCC fields.

### Filing Triggers

| Event | How It's Detected | Action |
|-------|-------------------|--------|
| Email sent via admin task UI | `sendGmailEmail()` call | Apply label immediately on send |
| VA sends email manually in Gmail | Gmail watch on `SENT` label history | Match recipient → apply label |
| VA receives email in Gmail | Gmail watch on `INBOX` label history | Match sender → apply label |
| Any candidate email detected | All of the above | Insert copy into hello@ with candidate's label (no INBOX) |

### Gmail Watch Configuration

**Current state:** Single account (`hazel@`), INBOX only, `labelIds: ['INBOX']`

**New state:** Multiple VA accounts + hello@, watching both INBOX and SENT

- Watch uses `historyTypes: ['messageAdded']` to capture new messages in both INBOX and SENT
- Each VA's watch processes only emails for their assigned GPs (checked against `registration_cases.assigned_va`)
- Watch registration stored in `gmail_watch_state` table (extend to support multiple accounts)

---

## Detected Contacts & CC Dropdown

### How Contacts Are Detected

When processing an inbound or outbound email matched to a candidate:
1. Extract all email addresses from To, CC, BCC fields
2. Check if any share the same domain as the practice contact email
3. If new (not already in `practice_detected_contacts`), insert them

### Database Table: `practice_detected_contacts`

```sql
CREATE TABLE practice_detected_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES registration_cases(id),
  email_address TEXT NOT NULL,
  display_name TEXT,           -- from email header if available
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  seen_count INTEGER DEFAULT 1,
  UNIQUE(case_id, email_address)
);
```

### Admin Task Email UI — CC Dropdown

When an RSO is composing an email for a task:
1. Fetch detected contacts for that case from `practice_detected_contacts`
2. Show as a dropdown/multi-select: `[display_name] <email>` or just `<email>`
3. RSO can select one or more to add as CC
4. Selected addresses are passed to `sendGmailEmail()` as CC recipients

---

## Database Changes

### Extend `gmail_watch_state`

Already has: `email_address (PK), history_id, watch_expiry, updated_at`

No schema change needed — each VA account gets its own row.

### Extend `registration_cases`

Add columns:
```sql
ALTER TABLE registration_cases
  ADD COLUMN gmail_label_id TEXT,           -- VA's label ID for this case
  ADD COLUMN gmail_label_hello_id TEXT;     -- hello@'s label ID for this case
```

These store the Gmail label IDs (not names) for efficient API calls.

### New table: `practice_detected_contacts`

As defined above.

### New table: `va_gmail_accounts`

```sql
CREATE TABLE va_gmail_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  email_address TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,          -- used for hello@ sub-label naming
  watch_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Maps admin users to their Gmail accounts for watch registration and label management.

---

## API Endpoints

### New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/va/case/{id}/email-contacts` | List detected contacts for CC dropdown |
| POST | `/api/admin/va/gmail/setup` | Register a VA's Gmail for watching (admin action) |
| DELETE | `/api/admin/va/gmail/teardown` | Remove a VA's Gmail watch |
| GET | `/api/admin/va/gmail/status` | Check watch health for all VA accounts |

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `PUT /api/admin/case` | When `assigned_va` changes → trigger label creation/archival/reassignment |
| `PUT /api/admin/case` | When `practice_name` changes → trigger label rename |
| `POST /api/admin/va/task/{id}/sppa-send-*` | Apply candidate label + insert to hello@ |
| `POST /api/gmail/webhook` | Expand to handle multiple accounts, match and label, detect contacts, insert to hello@ |
| `GET /api/cron/gmail-watch-renew` | Renew watches for ALL registered VA accounts |

---

## `sendGmailEmail()` Changes

After successfully sending an email, the function will:

1. Look up the candidate's `gmail_label_id` from `registration_cases`
2. Apply the label to the sent message via `gmail.users.messages.modify()`
3. Insert a copy into hello@ via `gmail.users.messages.insert()` with:
   - The candidate's `gmail_label_hello_id` applied
   - NO `INBOX` label (silent archive)

---

## Gmail Webhook Processing Changes

Current flow: receive notification → fetch history → process attachments → match to tasks

New flow additions:
1. Identify which VA account the notification is for (from `email_address` in push data)
2. For each new message in history:
   a. Extract all addresses (From, To, CC, BCC)
   b. Match against assigned GPs' emails + practice domains for this VA
   c. If match found:
      - Apply candidate label via `messages.modify()`
      - Insert copy to hello@ (no INBOX) with hello@ candidate label
      - Extract new domain contacts → upsert into `practice_detected_contacts`
3. Continue existing attachment/document processing as before

---

## Infrastructure Requirements

### Google Workspace Setup

1. **Domain-wide delegation** must cover all VA email accounts + `hello@mygplink.com.au`
2. **Scopes** needed (upgrade from current):
   - `https://www.googleapis.com/auth/gmail.modify` (to apply labels — replaces `gmail.readonly`)
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.labels` (to create/rename labels)
3. **Pub/Sub topic** can remain the same — push endpoint distinguishes accounts via payload

### Environment Variables

- `MONITORED_VA_EMAILS` → replaced by `va_gmail_accounts` table (dynamic)
- `MASTER_ARCHIVE_EMAIL=hello@mygplink.com.au` (new)

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Email matches multiple candidates (e.g., same practice domain) | Apply labels for ALL matched candidates |
| VA sends email to GP before assignment | Not labeled (no case link). If later assigned, historical backfill not performed for manually-sent pre-assignment emails |
| Practice domain changes | Update `practice_contact`, re-derive domain. Old domain emails stay labeled. New domain starts matching. |
| GP has no email on file | Label still created on assignment, but no auto-filing until email is registered |
| VA account removed from system | Watches torn down. Labels remain in their Gmail for reference. |
| hello@ label name conflict (two GPs same name under same VA) | Append case ID suffix: `Dr Jane Smith (abc123)` |

---

## Future Expansion

- Additional pathway labels (e.g., `Standard Pathway/`, `Rural Pathway/`) — same structure, different parent label
- Per-pathway archival or cross-pathway moves if a GP changes track
- Label-based search/reporting in admin dashboard
