# DoubleTick — RSOs Only Message Their Assigned GPs (+ Unassigned General Inquiries)

**Date:** 2026-06-27
**Status:** Approved design — ready for implementation plan
**Owner-facing goal:** Each RSO should only see and message the WhatsApp chats for the GPs assigned to them, **plus** any GP who isn't assigned to anyone yet (general inquiries). They must never see chats that belong to a different RSO.

---

## Plain-words summary

DoubleTick (the WhatsApp team app) is already connected to GP Link. Today there's no restriction — anyone signed in can message any GP, and only the owner/Hazel is on DoubleTick.

We will:
1. **In DoubleTick (one-time setup):** add each RSO as a team member and give them a restricted role so they can see **their own GPs + unassigned GPs**, but **not** another RSO's GPs.
2. **In the GP Link app (new automation):** whenever a GP is assigned to an RSO in the dashboard, the app automatically tells DoubleTick to hand that GP's chat to that RSO. GP Link stays the single source of truth.

The whole thing relies on the **Pro plan** (already active — roles/permissions and the Developer API are both Pro-only).

---

## Current state (verified in code)

- DoubleTick is integrated in `server.js`:
  - Config constants near `server.js:142` (`DOUBLETICK_API_KEY`, `DOUBLETICK_BASE_URL = https://public.doubletick.io`, webhook secret, conversation-URL helpers).
  - Outbound sends already use `Authorization: <DOUBLETICK_API_KEY>` (raw key, **no** `Bearer` prefix) against `DOUBLETICK_BASE_URL` — e.g. the freeform send at `POST /api/admin/whatsapp/send` (`server.js:23671`) and `sendDoubleTickTemplate` (`server.js:8128`). **This exact auth/header convention is proven in production and will be reused for the assign call.**
  - Inbound webhook `handleDoubleTickWebhook` (`server.js:5339`) receives `MESSAGE_RECEIVED`, sanitizes the payload, and can create a registration case (`server.js:~5489`).
- **One shared WhatsApp business number:** `HAZEL_WHATSAPP_NUMBER` (`server.js:7973`, default `+61494391968`). This is the `from`/WABA number for all sends and will be the `wabaNumber` for assignment.
- **RSO ↔ GP assignment** lives on `registration_cases.assigned_va` = the RSO's `user_id`.
- **RSO identity:** the live roster is the Supabase `rso_team` table (the hardcoded `RSO_TEAM` array at `server.js:258` is a fallback ignored when the table has rows — see memory `rso-roster-live-source`). Each RSO has a `user_id`, name, email, and (sometimes) a phone.
- `assigned_va` is written in (at least) these places, all of which must trigger the new sync:
  - `PATCH /api/admin/case` — RSO dashboard (`server.js:~29323`, allowed list includes `assigned_va`; already fetches the old `assigned_va` for Gmail-label reassignment at `~29342`).
  - The CEO-dashboard case PATCH (`server.js:~36099`, allowed list includes `assigned_va`).
  - The case-assignment dropdown / auto-assign path (rsos list at `server.js:~24943`, assigned-RSO lookup at `~24969`).

## DoubleTick capabilities (researched 2026-06-26, official docs)

- Multiple agents on one number: yes. Members are invited **by phone number** (via WhatsApp), and **can only log in with the exact phone the invite was sent to**.
- Restricting visibility is done with a **custom Channel role** under *Conversation Management*. Relevant toggles: `View Assigned Chats`, `View Unassigned Chats`, `View All Chats`, `Start New Chats`, `Message Assigned Chats`, `Message Unassigned Chats`, `Message All Chats`, `Delete Chats`.
- Programmatic assignment: `POST /team-member/assign` — body `{ customerPhoneNumber, groupId, assignedUserPhoneNumber, reassign, wabaNumber }` (supply exactly one of `customerPhoneNumber` / `groupId`). Customer-level variant: `POST /customer/assign`. Read current owner via `GET /customer/details` → `assignedToUser` / `assignedUserNumber`.
- Auto-assign-on-first-reply: if a chat is unassigned and an agent messages the customer, DoubleTick assigns that chat to that agent.
- Webhook `CHAT_ASSIGNED_TO_AGENT` exists (fires on manual or automated assignment); inbound `MESSAGE_RECEIVED` does **not** carry an assigned-agent field.
- **Plan gating:** roles/permissions **and** the Developer API are **Pro+** (Starter has neither). Pro bundles 10 agents. Pro is already active.
- Uncertainty to verify during build: the exact JSON field names in the `CHAT_ASSIGNED_TO_AGENT` payload (not needed for v1, one-way sync). Sources listed at the end.

---

## Requirements

### Functional
1. An RSO can **see and message** WhatsApp chats for GPs assigned to them (`assigned_va` = that RSO).
2. An RSO can **see and message** chats for GPs **assigned to nobody** (unassigned / general inquiries).
3. An RSO **cannot see** chats for GPs assigned to a **different** RSO.
4. When a GP's assigned RSO is set or changed in GP Link, the app **automatically assigns that GP's DoubleTick chat to that RSO** (overriding any previous DoubleTick owner).
5. The owner (Hazel) retains full visibility (Owner role) and is unaffected by the restriction.

### Non-goals (v1)
- **Two-way sync.** The app pushes assignment *to* DoubleTick only. Manual reassignments made inside DoubleTick are not read back into `assigned_va`; the app's next assignment wins.
- **Contact-type filtering.** DoubleTick permissions key off *assignment state*, not whether a contact is a GP. So any **unassigned** chat (including a non-GP — a practice, recruiter, spam) is visible to all RSOs until claimed. **Accepted for v1.** Escape hatch: the Owner assigns any non-GP chat to themselves to hide it from RSOs.
- Round-robin / rule-based auto-distribution inside DoubleTick (GP Link drives assignment instead).
- Number masking, analytics, and other Pro features unrelated to this goal.

---

## Design

### Part A — DoubleTick configuration (one-time, owner-performed; we provide an exact runbook)

1. **Create a custom Channel role** named `RSO – Assigned + Unassigned` on the WABA channel (`HAZEL_WHATSAPP_NUMBER`):
   - `View Assigned Chats` = **ON**
   - `View Unassigned Chats` = **ON**  *(enables general inquiries)*
   - `View All Chats` = **OFF**  *(blocks seeing another RSO's GPs)*
   - `Message Assigned Chats` = **ON**
   - `Message Unassigned Chats` = **ON**
   - `Start New Chats` = **ON**  *(RSOs may initiate to their own GPs)*
   - `Message All Chats` = **OFF**, `Delete Chats` = **OFF**
   - Organization role: a non-admin "Team Member" (no invite/remove/settings powers).
   - *(DoubleTick's built-in "Team Member – Assigned Only" role produces the same assigned-or-unassigned visibility; we use a custom role for explicit control of the Message toggles.)*
2. **Invite each RSO** by their WhatsApp phone number and assign them the custom role. RSO accepts on WhatsApp and logs in.
3. **API key:** reuse the existing `DOUBLETICK_API_KEY` (Settings → Developer API). No new key.

### Part B — App automation (new code)

**B1. RSO phone resolution — `resolveRsoWhatsAppPhone(rsoUserId)`**
- Looks up the RSO's WhatsApp phone (the number used to log into DoubleTick) from the `rso_team` table by `user_id`, falling back to the `RSO_TEAM` array.
- Returns a normalized phone (reuse `normalizePhone`) or `null`.
- **Prerequisite to verify during implementation:** confirm `rso_team` has a usable phone column and that each active RSO's stored phone equals their DoubleTick-login phone. If a column is missing, add one (e.g. `whatsapp_phone`) via the `exec_sql` migration path (memory `supabase-migrations-exec-sql`). Flag/log any RSO missing a phone.

**B2. Assign helper — `assignDoubleTickChat({ gpPhone, rsoPhone })`**
- Placed next to the existing DoubleTick send-helpers (around `server.js:8128`).
- `POST {DOUBLETICK_BASE_URL}/team-member/assign` with headers `{ 'Content-Type': 'application/json', Authorization: DOUBLETICK_API_KEY }` and body:
  ```json
  {
    "customerPhoneNumber": "<normalized GP phone>",
    "assignedUserPhoneNumber": "<normalized RSO phone>",
    "reassign": true,
    "wabaNumber": "<HAZEL_WHATSAPP_NUMBER digits>"
  }
  ```
- 15s `AbortController` timeout (mirroring existing sends). Returns `{ ok, status, data, error }`.
- **Fail-soft:** all errors are caught and logged with a `[doubletick-assign]` prefix; the helper never throws into a caller.
- Disabled no-op (logged) when `DOUBLETICK_API_KEY` is unset.

**B3. Sync wrapper — `syncCaseChatAssignment({ gpPhone, assignedVaUserId })`**
- Resolves the RSO phone (B1); if missing GP phone or RSO phone → log and return (no call).
- Otherwise calls `assignDoubleTickChat` (B2).
- Owner/archive (Hazel / hello@) assignment: resolves to the Owner number → call is a harmless no-op for an Owner-role account; guard so it never errors (see memory `rso-reassign-hello-archive`).

**B4. Trigger points (call B3 after a successful `assigned_va` write):**
- `PATCH /api/admin/case` assigned_va branch (`server.js:~29342`) — fire only when `assigned_va` actually changed (the old value is already fetched here).
- CEO-dashboard case PATCH (`server.js:~36099`) — same.
- The auto-assign-on-case-creation / assignment-dropdown path (`server.js:~24969`).
- All calls are best-effort and must not block or fail the underlying save (await-and-catch, or fire-and-forget with internal catch).

**B5. Webhook backstop (`handleDoubleTickWebhook`, `server.js:5339`):**
- After the inbound message resolves to a GP/case, if that case has a non-null `assigned_va`, call B3 to (re)assert the chat assignment. This lands a formally-assigned GP's chat with the right RSO promptly even if it briefly existed unassigned.
- If the case is unassigned, do nothing → the chat stays unassigned → visible to all RSOs (general inquiry). **This is the desired behaviour.**

### Behavioural notes (expected, not bugs)
- **First responder owns a general inquiry:** when an RSO replies to an unassigned chat, DoubleTick auto-assigns it to them; it drops off other RSOs' screens. If that GP is later formally assigned to a different RSO in GP Link, B4 reassigns it (`reassign: true`).
- **Harmless divergence:** for an informal inquiry, DoubleTick may show a chat assigned to RSO-A while GP Link's `assigned_va` is still null. That's fine — GP Link ownership tracks the registration case; DoubleTick ownership tracks who's handling the conversation. They reconcile the moment a formal assignment is made.

---

## Error handling & edge cases
- DoubleTick API error / timeout → logged, swallowed; the case save succeeds regardless.
- RSO has no phone on file → skip the call, log a warning naming the RSO (so the owner can fix the roster).
- GP has no WhatsApp / no chat yet → no assignment now; B5 webhook backstop assigns it on their first inbound message.
- Reassignment RSO-A → RSO-B → single assign call with `reassign: true` moves it.
- Owner/archive assignment → no-op, never errors.

## Testing
Unit tests (mirror `tests/doubletick-webhook.test.js` patterns; mock `fetch`):
- `assignDoubleTickChat` builds the correct URL/headers/body; handles non-2xx and network error without throwing.
- `resolveRsoWhatsAppPhone` resolves from `rso_team`, falls back to `RSO_TEAM`, returns `null` when absent.
- A change of `assigned_va` triggers exactly one assign call; an unchanged save triggers none.
- An assign failure does **not** fail the case-save path.
- Webhook backstop: assigned case → assign call fires; unassigned case → no call.

Manual live verification (stated honestly as manual):
1. Assign a test GP to RSO-A → confirm in DoubleTick that **only** RSO-A sees that chat.
2. Confirm RSO-A also sees an **unassigned** test chat; confirm RSO-B does **not** see RSO-A's GP.
3. Reassign the GP to RSO-B → confirm the chat moves to RSO-B and leaves RSO-A.

## Rollout checklist
1. (Owner) Confirm Pro plan active — **done**.
2. (Owner) Create the custom role; invite each RSO by phone; assign the role.
3. Verify/record each RSO's DoubleTick-login phone in `rso_team`.
4. Ship Part B (auto-sync) behind the existing `DOUBLETICK_API_KEY` env (no new secret).
5. Run the manual live verification above.

## Prerequisites to confirm during implementation
- `rso_team` schema: is there a phone column matching DoubleTick-login numbers? Add `whatsapp_phone` if needed.
- Exact `/team-member/assign` success/error shape (confirm against a live call; the auth header convention is already proven by existing sends).
- Whether any active RSOs currently lack a phone in the roster.

## Sources
- https://learn.doubletick.io/settings/manage-roles/understanding-the-permissions-available-while-creating-a-custom-channel-role.md
- https://learn.doubletick.io/settings/manage-roles/how-do-you-view-role-permissions-and-duplicating-roles.md
- https://learn.doubletick.io/teams/accept-invitations-and-log-in-to-doubletick
- https://learn.doubletick.io/chat-management/how-to-assign-chats
- https://docs.doubletick.io/reference/assign-team-member-to-chat.md
- https://docs.doubletick.io/reference/assign-team-member-to-customer.md
- https://docs.doubletick.io/reference/get-customer-details.md
- https://docs.doubletick.io/reference/webhooks
- https://docs.doubletick.io/docs/register-new-webhook
- https://doubletick.io/pricing
