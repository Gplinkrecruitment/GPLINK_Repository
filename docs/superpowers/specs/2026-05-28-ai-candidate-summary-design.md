# AI Candidate Summary — Design Spec

**Date:** 2026-05-28
**Status:** Approved

## Overview

An AI-generated intelligence brief that appears as a card between the profile bar and journey stepper in the admin candidate detail view. It aggregates data from all communication channels (emails, WhatsApp, support tickets) and case data, then uses Claude to synthesize an actionable summary highlighting what needs doing, concerns, recent comms, and outstanding requirements.

## Placement

- Card sits **between the profile bar and the journey stepper** in `renderDetail()` inside `pages/admin.html`
- Always rendered on load (auto-generates when admin opens a candidate)
- **Collapsed by default**: shows overview paragraph + status pills + "Show details" toggle
- **Expanded on click**: reveals structured sections (Action Items, Concerns, Recent Comms, Outstanding Requirements)

## Trigger & Caching

- **Auto-generate on every detail view open** — no caching, always fresh
- A "Refresh" button in the card header allows manual re-generation without closing/reopening
- Loading state shown while the API call is in flight (skeleton/spinner inside the card area)

## Data Sources

The backend endpoint aggregates the following before sending to Claude:

| Source | What to fetch | How |
|---|---|---|
| **Case data** | Stage, substage, status, blocker_reason, assigned_va, timestamps, practice_name, practice_contact | `registration_cases` table via existing `/api/admin/case` logic |
| **Tasks** | All tasks for the case — title, status, priority, due_date, related_stage | `registration_tasks` table |
| **Emails (task_messages)** | All email records linked to the case — subject, body excerpt, sender, direction, timestamp | `task_messages` table filtered by `case_id` and `channel = 'email'` |
| **Emails (Gmail search)** | Emails to/from the GP's email address AND the practice contact email | Gmail API search using `from:` / `to:` queries for both GP email and practice contact email |
| **WhatsApp (DoubleTick)** | Messages from `doubletick_messages` table for the case — body, direction, timestamp | `doubletick_messages` table filtered by `case_id` |
| **Support tickets** | Unresolved tickets for this candidate — title, category, latest thread message | `support_tickets` table filtered by `candidateId` and `status != 'resolved'` |
| **Qualification docs** | Approved, pending, missing documents | Existing `/api/admin/va/user-qualifications` logic |
| **Timeline events** | Recent notes, status changes, actions (last 20) | `task_timeline` table filtered by `case_id` |
| **Previous AI handover** | Stored summary from last generation — carries forward full historical context | `registration_cases.ai_handover_summary` JSONB column |

### Data fetching strategy

All data sources fetched **in parallel** via `Promise.all()` on the server side. Gmail API search limited to last 30 days and max 10 messages per address to bound cost/latency. DoubleTick and task_messages limited to last 20 records. Timeline limited to last 20 events.

### Handover summary (rolling context)

Recent data fetches are bounded to keep API calls fast and cheap, but this means the AI could miss important context from earlier in the journey. A **handover summary** solves this by carrying forward historical knowledge across generations.

**How it works:**

1. **First generation** (no handover exists): AI sees only current data. Produces summary. Result saved to `registration_cases.ai_handover_summary` as JSONB.
2. **Every subsequent generation**: AI reads the **previous handover summary** (full historical context) + **fresh recent data** (bounded fetches). Produces new summary, overwrites the stored handover.
3. The handover acts like shift notes — each generation reads the previous notes and writes updated ones, so no context is ever lost even though individual fetches are bounded.

**Storage:** Single `ai_handover_summary` JSONB column on `registration_cases` table. Only the latest handover is stored — no history needed.

**Schema:**
```json
{
  "overview": "...",
  "action_items": ["..."],
  "concerns": ["..."],
  "key_history": "Condensed record of all significant events, resolved issues, and historical context carried forward from previous summaries",
  "generated_at": "2026-05-28T13:45:00Z"
}
```

**Migration:** `ALTER TABLE registration_cases ADD COLUMN ai_handover_summary JSONB DEFAULT NULL;`

## API Endpoint

### `GET /api/admin/candidate-summary?case_id=<id>`

**Auth:** Requires valid `gp_admin_session` cookie.

**Response (200):**
```json
{
  "ok": true,
  "summary": {
    "overview": "Dr Smith Miller (UK, SOP Medical Centre) is early in registration — Secure Placement is done but the Offer/Contract hasn't arrived from the practice. Email was sent 3 days ago with no reply. WhatsApp shows the GP is aware but hasn't chased yet. Progress is stalling.",
    "action_items": [
      "Chase SOP Medical Centre for Offer / Contract — no reply in 3 days",
      "Follow up with GP on starting MyIntealth health forms"
    ],
    "concerns": [
      "Practice unresponsive to document request email (3 days, no reply)",
      "GP hasn't commenced MyIntealth — may not understand next steps"
    ],
    "recent_comms": [
      { "channel": "email", "direction": "outbound", "summary": "Offer / Contract needed for Dr Smith Miller", "recipient": "SOP Medical Centre", "age": "3d ago" },
      { "channel": "whatsapp", "direction": "inbound", "summary": "Will follow up with the practice manager", "sender": "GP", "age": "2d ago" },
      { "channel": "email", "direction": "outbound", "summary": "Welcome + next steps email", "recipient": "GP", "age": "5d ago" }
    ],
    "outstanding_requirements": [
      { "item": "Offer / Contract from practice", "done": false },
      { "item": "MyIntealth health assessment", "done": false },
      { "item": "AMC Portfolio", "done": false },
      { "item": "Secure Placement", "done": true }
    ],
    "key_history": "Dr Smith Miller registered on 2026-05-20 and was matched with SOP Medical Centre the same day. Secure Placement confirmed immediately. Welcome email and WhatsApp intro sent on day 1. Practice was emailed for Offer/Contract on 2026-05-25 — no response yet. GP acknowledged via WhatsApp on 2026-05-26 that they would follow up with the practice manager. No escalations or support tickets to date."
  },
  "meta": {
    "model": "claude-sonnet-4-6",
    "generated_at": "2026-05-28T13:45:00Z",
    "input_tokens": 2400,
    "output_tokens": 600
  }
}
```

**Error (500):**
```json
{
  "ok": false,
  "error": "Summary generation failed",
  "fallback": "Unable to generate AI summary. Check Anthropic API key and daily budget."
}
```

## AI Prompt Design

### System prompt

```
You are an admin assistant for GP Link, a medical recruitment platform that helps overseas GPs register to work in Australia. You produce concise, actionable intelligence briefs about candidate registration progress.

Given a candidate's case data, communications, tasks, documents, support tickets, and (if available) a previous handover summary, produce a structured JSON summary with these fields:

- overview: 2-4 sentence executive summary. Lead with who they are, where they're at, and the single most important thing the admin needs to know. Be specific — name the practice, name the document, quote the message.
- action_items: Array of strings. Concrete next steps the admin/VA should take. Most urgent first. Include context (e.g. "no reply in 3 days").
- concerns: Array of strings. Potential problems, delays, red flags. Empty array if none.
- recent_comms: Array of objects with { channel, direction, summary, sender/recipient, age }. Last 5 most relevant communications across all channels. Most recent first.
- outstanding_requirements: Array of objects with { item, done }. Registration steps and key documents needed. Mark completed ones as done:true.
- key_history: A condensed paragraph capturing all significant events, resolved issues, and historical context from this candidate's entire journey. This field is carried forward into the next summary generation, so include anything a future reader would need to understand the full picture — past blockers that were resolved, important decisions made, escalations, practice changes, etc. If a previous handover exists, preserve its important context and merge with new findings.

Be direct and specific. No fluff. If something is overdue or stalling, say so plainly. If there are no concerns, say so — don't fabricate issues. If a previous handover summary is provided, use it as historical context — don't discard past knowledge, but update it with current findings.
```

### User message

Structured text block containing all aggregated data, formatted as labelled sections:

```
CANDIDATE: Dr {name} | {email} | {phone} | {country}
PRACTICE: {practice_name} | {practice_contact}
STAGE: {stage} / {substage} | Status: {status}
ASSIGNED VA: {assigned_va}
REGISTERED: {created_at} | LAST ACTIVITY: {last_gp_activity_at}
BLOCKER: {blocker_reason || "None"}

--- TASKS ({count}) ---
{for each task: [status] title (priority) — due: date}

--- EMAILS ({count}) ---
{for each email: [direction] subject | from/to | date}
{body excerpt — first 200 chars}

--- WHATSAPP ({count}) ---
{for each message: [direction] body excerpt | date}

--- SUPPORT TICKETS ({count} unresolved) ---
{for each ticket: [status] title (category) — latest: excerpt}

--- QUALIFICATIONS ---
Approved: {list}
Pending: {list}
Missing: {list}

--- DOCUMENTS ---
{for each doc: [status] name — ops_status}

--- RECENT TIMELINE ({count}) ---
{for each event: [type] title — actor — date}

--- PREVIOUS HANDOVER SUMMARY ---
{if exists: previous ai_handover_summary JSON, including key_history}
{if not: "No previous summary — this is the first generation for this candidate."}
```

### Model & parameters

- Model: `claude-sonnet-4-6` (matches existing app patterns, good speed/cost balance)
- max_tokens: 1024
- temperature: 0 (deterministic, factual output)
- Response parsed as JSON from the text response (instruct model to return raw JSON, no markdown fences)

## Frontend Rendering

### Card HTML structure

Rendered by a new `renderAiSummary(caseId, container)` function called from `renderDetail()`.

**Loading state:** Gradient card with pulsing skeleton lines while API call is in flight.

**Collapsed state (default):**
- Card with gradient background (`linear-gradient(135deg, #edf2ff, #f3f0ff)`)
- Header: sparkle icon + "AI Summary" + timestamp + Refresh button
- Overview paragraph (from `summary.overview`)
- Status pills: count of action_items (amber), count of concerns (red), count of unresolved tickets (green if 0, red if >0)
- "Show details" toggle at bottom

**Expanded state (on click):**
- Everything above, plus:
- Divider line
- **Action Items** section (amber header, bullet list)
- **Concerns** section (red header, bullet list) — hidden entirely if empty array
- **Recent Communications** section (blue header, channel icon + direction + summary + age)
- **Outstanding Requirements** section (green header, checkbox list with done/not-done states)
- "Hide details" toggle at bottom

**Error state:** Card with muted background, error message, and "Retry" button.

### Collapse/expand behaviour

- Default: collapsed
- Toggle via click on "Show/Hide details" link
- State not persisted — resets to collapsed on next candidate open
- Smooth CSS transition on expand (max-height animation)

## Cost Considerations

- Claude Sonnet at ~$3/M input, ~$15/M output tokens
- Estimated ~2,500 input tokens + ~600 output tokens per call = ~$0.017 per summary
- At 50 candidate views/day = ~$0.85/day
- Well within the existing `ANTHROPIC_DAILY_LIMIT_USD` ($100) budget
- Token usage tracked via existing `anthropicDailySpend` mechanism

## Error Handling

- If Anthropic API fails: show error card with "Retry" button, don't block the rest of the detail view
- If daily budget exceeded: show "AI budget limit reached for today" message
- If case has no data (brand new candidate): show "Not enough data to generate summary yet"
- Network timeout: 15 second timeout on the fetch call, show timeout message with retry

## Files to Modify

1. **`server.js`** — New `/api/admin/candidate-summary` endpoint with data aggregation + Claude API call
2. **`pages/admin.html`** — New `renderAiSummary()` function, called from `renderDetail()`, with loading/collapsed/expanded/error states and CSS styling
