# Australian GP build: owner actions

Things only the owner can do, because they need an outside account or a
decision. Each package appends to this list. Nothing here has been done by an
agent.

| # | From | Action | Why | Status |
| --- | --- | --- | --- | --- |
| 1 | WP-00S | To receive test emails/WhatsApps on the preview, `NOTIFY_TEST_RECIPIENTS` must be set on the Vercel **Preview** environment to addresses/numbers you own (comma-separated, for example `you@example.com, +61 400 000 000`), then the branch redeployed. Do **not** set it on Production. | The preview shares production's database and sending keys, so it now blocks every outbound email, WhatsApp, Gmail send and calendar invite unless the recipient is on this list. Until it is set the preview sends nothing at all, which is safe but means you will not see any test message arrive. | open |

## Notes on item 1

- Check it worked: open `/api/health` on the preview address. It shows
  `"previewSendLock":"allowlist"` once the list is set, and
  `"previewSendLock":"block_all"` while it is not.
- Use the addresses and numbers of the test doctor and test practice accounts
  you will sign in with, plus your own. A calendar invite is only emailed when
  every attendee of the interview is on the list.
- Phone calls from Hazel on the preview use a separate list,
  `LEAD_CALLS_TEST_NUMBERS`. Retell's keys are not on the preview today, so no
  call can be placed there anyway.
- This does not stop the **live** site's own scheduled jobs from messaging a
  test doctor who exists in the shared database. Use test accounts whose email
  and phone you own.
