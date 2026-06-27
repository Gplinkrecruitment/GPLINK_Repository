# Registration Email Hub — Go-Live Setup

The app code is ready. Live email stays OFF until these steps are done.

## 1. Create the mailbox (Google Workspace admin)
- Create `registration@mygplink.com.au` as a normal user mailbox (NOT just an alias — the app sends *as* it and reads its inbox).
- Confirm the existing Google service account's domain-wide delegation covers it (same delegation already used for hazel@). No new scopes needed; the scopes are gmail.modify + send.

## 2. Turn it on (environment variables — Vercel project settings)
- `REGISTRATION_HUB_EMAIL=registration@mygplink.com.au`
- (Optional) add it to `MONITORED_VA_EMAILS` too; the code also auto-adds it, but being explicit is fine.
- Redeploy.

## 3. Register the inbox watch
- Hit `GET /api/cron/renew-gmail-watch` once (or wait for the daily cron). Confirm a row appears in `gmail_watch_state` for registration@.

## 4. Apply the DB migration
- Run `supabase/migrations/20260627000000_task_messages_read_at.sql` against prod (via the exec_sql RPC with the service key, per the team convention).

## 5. Verify end-to-end (do this with ONE real test case first)
- From the admin Inbox, send a doc-request to a test address. Confirm the recipient sees it from "registration@mygplink.com.au" with the RSO's name.
- Reply to it. Confirm the reply appears in that case's thread within ~1 min and the Inbox row flips to "Needs reply".
- Only then roll out to real doctors.

## Rollback
- Unset `REGISTRATION_HUB_EMAIL` and redeploy. Sending reverts to per-RSO mailboxes immediately. (Inbound replies already in the hub remain filed; new ones go back to per-RSO inboxes.)

## Pre-go-live correctness follow-ups (from final whole-branch review)

Listed worst-first. None affect the OFF state — they only matter once `REGISTRATION_HUB_EMAIL` is set.

1. ~~**(MOST IMPORTANT — fix before broad rollout) One case can hold two live email threads, and the Inbox merges them.**~~ **✅ RESOLVED 2026-06-27 (commit 485f0ad).** The Inbox now groups one row **per email thread** (`gmail_thread_id`), not per case. A case emailing both the GP and the practice shows as two separate rows (each labelled "with &lt;the address&gt;"), and the reply box for each row is addressed only to that thread's own counterparty — so a GP-meant reply can no longer reach the practice. Verified by rendering the real UI for a two-thread case (two distinct rows, isolated reply targets) and 4 new unit tests proving the split + no cross-talk.

2. **Practice "Request Revision" draft path bypasses the hub.** In `server.js` (~37135/37172) the practice-revision draft is created from `hazel@` against the stored thread id and a hardcoded "GP Link Registration" From. Under the hub the thread belongs to `registration@`, so that draft's threading/mailbox will be wrong. Route this path through the hub (same `resolveCaseSenderInfo` pattern) before relying on it with the hub ON.

3. **Reply threading lookup uses the wrong mailbox under the hub.** `/api/admin/email/send` (~25236) fetches the In-Reply-To/subject via `getGmailClient(MONITORED_VA_EMAILS[0])` (hazel@) instead of the hub mailbox. The reply still groups via the explicit `threadId`, so it's not a break, but switch the lookup to the sender mailbox for clean headers.

4. **Inbox tab + copy aren't gated on the hub flag.** The "Inbox" tab and its "registration@…" wording show even when the hub is OFF (replies actually go from the per-RSO mailbox then). Functionally fine; soften the copy or gate the tab on a server-injected flag so it isn't misleading pre-go-live.

## Known follow-ups before enabling for non-Hazel RSOs

- The SPPA correction emails (in `server.js`, the SPPA GP-corrections and practice-corrections send paths) hard-code the closing line `Kind regards, Hazel — GP Link Registration Team` in the email BODY. When the hub is ON and a case is assigned to a different RSO (e.g. Smith Miller), the From header will correctly show that RSO's name but the body sign-off will still say "Hazel". This is cosmetic, not a functional break, but it should be fixed (use the assigned RSO's name in the body) before enabling the hub for cases not assigned to Hazel. Until then, the hub is safe to enable for Hazel-assigned cases.
