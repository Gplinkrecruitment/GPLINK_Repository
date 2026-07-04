# AHPRA s80 GP uploads — AI check → Accept → threaded officer reply

**Date:** 2026-07-03
**Status:** Design (approved in brainstorm; pending spec review)
**Area:** AHPRA s80 "Who/How" review tray (this session's feature — `renderS80Tray`/`renderS80Active`, `ahpra_action_item`, `team_instructions`).

## Purpose

When an AHPRA officer's "provide documents" notice is split into the Who/How tray, each **GP upload item** (`owner=gp`, `mode=upload`) currently just gets an Approve/Reject after the doctor uploads. This feature adds, per upload item:

1. **An AI check at upload time** — does the uploaded file actually satisfy what AHPRA asked for on *that* item?
2. **The AI verdict shown to the RSO**, who can **Accept** regardless (advisory, never blocking).
3. On Accept, a **pre-filled email composer to the assigned AHPRA officer** — attachment + the GP CC'd + a suggested body — sent as a **direct reply on the original officer email thread** so the whole exchange stays in one AHPRA thread. The RSO reviews and sends; the item completes on send.

**User decisions (brainstorm):** one email per accepted document; AI check is advisory (admin always decides); AI verifies the document against the specific task requirement; the officer email must reply on AHPRA's original notice thread.

## Scope

**In:** AI upload check (fail-open) + storage on the item; verdict display in the tray's active view + read-only in the Ops-Queue s80 view; "Accept & email AHPRA" action; a per-document, threaded officer-reply composer pre-filled with attachment + GP CC.

**Out (YAGNI):** blocking/gating on the AI verdict; combined multi-document email; auto-send (RSO always reviews + sends); re-check loops beyond the existing Reject → re-upload path; changing the GP-facing upload UX (the doctor still just sees "uploaded — under review").

## Architecture overview

```
GP uploads file ──PUT /api/ahpra/more-info/upload──► store file
                                                   └► runUploadCheck(fileBuf, requirement)  [fast model, vision, fail-open]
                                                        └► metadata.upload.ai_check = {verdict, summary, checked_at, model}
                                                            (item stays status waiting_on_gp → upload.status 'under_review')

RSO opens GP profile ► renderS80Active upload item shows: verdict badge + summary + [Accept & email AHPRA] [Reject]
                       (Ops-Queue renderOpsS80Item shows the same verdict, read-only)

RSO clicks Accept ► POST /api/admin/ahpra/item/review {decision:'approve'}   (existing; marks upload approved)
                  ► client opens the officer-reply composer pre-filled:
                       To  = item/case ahpra_officer_email (editable)
                       CC  = gp_email
                       Attachment = the uploaded document
                       Subject = "Re: <original notice subject>"
                       Body = buildOfficerReplyDraft(...)   (new pure helper)
                       thread = original officer email (threadId + In-Reply-To/References)

RSO reviews + Send ► POST /api/admin/ahpra/item/officer-reply {task_id, to, cc, subject, bodyHtml}
                       └► sendGmailEmail({to, cc, attachments:[uploaded doc], subject, threadId, inReplyTo, references, from: rep/hub mailbox})
                       └► item → status 'completed'; store an outbound task_message on the thread
```

## Part 1 — AI upload check

**New pure module `lib/ahpra-upload-check.js`** (unit-tested, no I/O):
- `buildUploadCheckPrompt(requirement)` — requirement = `{ title, detail, team_instructions, sub_items }` from the item metadata. Prompt: "Here is what AHPRA asked for on this item… Here is the document the doctor uploaded. Is this the right document, and does it satisfy the requirement (including any signed/dated/certified condition stated)? Reply strict JSON."
- `UPLOAD_CHECK_SYSTEM` — short system string.
- `parseUploadCheck(text)` → `{ verdict: 'match'|'possible_issue'|'unclear', summary }` (verdict coerced to the enum; unknown → 'unclear'; summary trimmed/capped). Returns a safe object on unparseable input.

**Server helper `runUploadCheck(fileBuffer, mimeType, requirement)`** in server.js:
- Builds the Anthropic `messages` content: a `document`/`image` block (existing base64 pattern, server.js ~1918/1978) + the prompt text.
- Model: `AHPRA_S80_EXTRACT_MODEL` (fast; Sonnet 5), `thinking:{type:'disabled'}`, **no `temperature`** (Sonnet 5 rejects it), `max_tokens` ~600, ~30s AbortController.
- **Fail-open:** no `ANTHROPIC_API_KEY`, budget exceeded, timeout, parse failure, or unsupported file type ⇒ return `{ verdict:'unchecked', summary:'' }`. Never throws to the caller.

**Wiring** into `PUT /api/ahpra/more-info/upload` (server.js:33472), after the file is stored and before responding: call `runUploadCheck` on the just-uploaded buffer + the item's requirement, and persist `metadata.upload.ai_check = { verdict, summary, checked_at: nowIso, model }` alongside the existing `metadata.upload` fields. The GP response is unchanged ("uploaded — under review"); the check adds a few seconds server-side (acceptable, mirrors `verify-certification`'s at-upload check). If the check is slow/undesirable to block the PUT, fallback allowed: store `verdict:'unchecked'` and let the admin trigger it — but default is inline at upload.

**Data model:** metadata only — no migration. New key `metadata.upload.ai_check`.

## Part 2 — Admin display + Accept

**`renderS80Active` upload branch** (admin.html ~3081, the `m.mode==='upload'` + `up.status==='under_review'` case):
- Above the existing View file / Approve / Reject row, render an **AI verdict chip + summary**:
  - `match` → green "✓ Looks right" ; `possible_issue` → amber "⚠ Possible issue" ; `unclear`/`unchecked` → grey "— Not verified" ; plus `ai_check.summary` as one line.
- Rename **Approve** → **"Accept & email AHPRA"** (same `data-s80-review` `approve` semantics for the item-review call, plus a new `data-s80-officer-reply` attribute the click handler uses to open the composer). **Reject unchanged.**

**`renderOpsS80Item`** (Ops-Queue, added this session): show the same verdict chip + summary **read-only** (no Accept there — acceptance happens on the review surface). Consistent with "show the simplified version everywhere."

## Part 3 — Accept → threaded officer-reply composer

**Accept click handler** (in the `#detailContent` s80 handlers):
1. Mark the upload **approved but keep the item open** (it completes only on Send). ⚠️ The existing `/api/admin/ahpra/item/review` approve path sets `upload.status='approved'` **and** `status='completed'` (server.js ~36420) — that would finish the item before the email is sent. So this flow does **not** reuse the full approve as-is: instead the Accept step sets `metadata.upload.status='approved'` and leaves the item open (e.g. `status='in_progress'`), and the officer-reply **Send** is what sets `status='completed'`. Cleanest: fold the "approve-without-complete" into the officer-reply-draft fetch, or add an `advance:false` option to `item/review`. Decide in the plan.
2. Open a composer (reuse the officer-composer UI pattern) pre-filled with To / CC / Subject / Body and a note that the upload will be attached as the reply.

**Pre-fill data** — a new endpoint `GET /api/admin/ahpra/item/officer-reply-draft?task_id=…` returns `{ to, cc, subject, bodyHtml, has_attachment }`:
- `to` = item `metadata.officer.email` || case `ahpra_officer_email` (editable; blank if unknown).
- `cc` = the GP candidate email (`gp_applications`/profile lookup by case).
- `subject` = `"Re: " + original notice subject` (from the item's inbound `task_message.subject` / `metadata.original_email.subject`).
- `bodyHtml` = **AI-drafted**, matching the app's existing "✦ Suggest a reply" pattern (`/api/admin/email-triage/suggest-reply`, model **`SUGGEST_REPLY_MODEL` = `claude-opus-4-6`**, `lib/suggest-reply-prompt.js`). New **pure** prompt builder `buildOfficerReplyMessages({ gpName, itemTitle, requirement, reference, officerName })` in `lib/ahpra-s80.js` (unit-tested); the draft endpoint makes the `SUGGEST_REPLY_MODEL` call with it and returns the suggested body. Grounded with: this is a reply to the AHPRA officer's notice, attaching the requested item, on behalf of Dr [name], ref [X]; short, professional. **Fail-open:** no key / AI error ⇒ fall back to a simple deterministic template `buildOfficerReplyDraft(...)` (also pure/tested) so the composer always opens with an editable draft. The RSO edits freely before sending.

**Send** — new `POST /api/admin/ahpra/item/officer-reply {task_id, to, cc, subject, bodyHtml}`:
- Load the item + its current uploaded document (via the same storage the file-view endpoint uses) → attachment `{ filename, mimeType, contentBase64 }`.
- Resolve threading from the item's **inbound** `task_message` (the original officer email): `threadId = task.gmail_thread_id`; `inReplyTo = task_message.rfc822_message_id`; `references = task_message.rfc822_references || rfc822_message_id`.
- Resolve the send mailbox with the existing sender logic (rep/hub mailbox for the case).
- `sendGmailEmail({ from, to, cc, subject, bodyHtml, attachments:[doc], threadId, inReplyTo, references, caseId })` — all already supported.
- On success: set the item `status='completed'`, `metadata.upload.status='approved'`, record an **outbound** `task_message` on the thread (so the exchange shows in the thread and reply-matching stays intact). Notify the GP (optional, reuse existing push).

## Models

- **Document scan** (Part 1): **`claude-sonnet-5`** via `AHPRA_S80_EXTRACT_MODEL` — fast, runs at upload; env-overridable.
- **Email draft** (Part 3): **`claude-opus-4-6`** via `SUGGEST_REPLY_MODEL` — the app's standard "suggest an email" model; quality over speed, generated when the composer opens.

## Reused vs new

**Reused:** `sendGmailEmail` (cc/attachments/threadId/inReplyTo/references already supported); `/api/admin/ahpra/item/review`; `/api/admin/ahpra/item/file` storage access; the `document` base64 vision-block pattern; `AHPRA_S80_EXTRACT_MODEL` (scan); the AI email-suggestion pattern (`SUGGEST_REPLY_MODEL`, `/api/admin/email-triage/suggest-reply`, `lib/suggest-reply-prompt.js`); the officer-composer UI pattern; the item's stored inbound `task_message` for threading.

**New:** `lib/ahpra-upload-check.js` (pure) + `runUploadCheck` (server); `buildOfficerReplyMessages` (AI prompt builder) **and** `buildOfficerReplyDraft` (deterministic fail-open template) in `lib/ahpra-s80.js` (both pure); `metadata.upload.ai_check`; `GET …/item/officer-reply-draft` (makes the `SUGGEST_REPLY_MODEL` call, falls back to the template); `POST …/item/officer-reply` (threaded send); verdict UI in `renderS80Active` + `renderOpsS80Item`; the Accept-opens-composer client handler.

## Testing

- **Unit (offline):** `buildUploadCheckPrompt` includes the requirement fields; `parseUploadCheck` coerces verdicts + is safe on garbage; `buildOfficerReplyMessages` grounds the prompt with item/GP/officer/ref; `buildOfficerReplyDraft` (fallback) renders name/title/reference + a `Re:` subject; verdict-chip helper maps enum→label.
- **No local AI/DB:** the vision scan (Sonnet 5), the email draft (Opus 4.6), and the send run only in prod (no key/creds locally) — verified live: upload a doc as the GP → RSO sees the verdict → Accept → composer pre-filled with an AI-drafted body as a thread reply with attachment + GP CC → Send lands in the original AHPRA thread.
- Full suite stays green.

## Open items to confirm during implementation

1. Exact item status transition on Accept vs Send (approve marks `upload.status='approved'`; item completes on Send, not on Accept).
2. Officer email address when unknown (Gmail stand-in / no `@ahpra.gov.au` officer stored) — composer `to` is editable so the RSO can fill it.
3. Attachment size limits for `sendGmailEmail` (uploaded docs are small; confirm base64 path).
