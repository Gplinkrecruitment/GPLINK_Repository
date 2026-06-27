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

## Known follow-ups before enabling for non-Hazel RSOs

- The SPPA correction emails (in `server.js`, the SPPA GP-corrections and practice-corrections send paths) hard-code the closing line `Kind regards, Hazel — GP Link Registration Team` in the email BODY. When the hub is ON and a case is assigned to a different RSO (e.g. Smith Miller), the From header will correctly show that RSO's name but the body sign-off will still say "Hazel". This is cosmetic, not a functional break, but it should be fixed (use the assigned RSO's name in the body) before enabling the hub for cases not assigned to Hazel. Until then, the hub is safe to enable for Hazel-assigned cases.
