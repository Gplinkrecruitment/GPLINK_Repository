# Australian GP build: owner actions

Things only the owner can do, because they need an outside account or a
decision. Each package appends to this list. Nothing here has been done by an
agent.

| # | From | Action | Why | Status |
| --- | --- | --- | --- | --- |
| 1 | WP-00S | To receive test emails/WhatsApps on the preview, `NOTIFY_TEST_RECIPIENTS` must be set on the Vercel **Preview** environment to addresses/numbers you own (comma-separated, for example `you@example.com, +61 400 000 000`), then the branch redeployed. Do **not** set it on Production. | The preview shares production's database and sending keys, so it now blocks every outbound email, WhatsApp, Gmail send and calendar invite unless the recipient is on this list. Until it is set the preview sends nothing at all, which is safe but means you will not see any test message arrive. | open |
| 2 | WP-19 | Take the 13 questions in `docs/au-gp/hazel-au-script-notes.md` section 4 to a lawyer and get the answers in writing (AI calls to Australian numbers, Do Not Call Register, calling hours, call recording by state, privacy, AI disclosure, consent wording on the enquiry form). | Owner decision 7 / COM-34: Hazel stays off for Australian leads until this is answered. Nobody on the build has checked the law. | open |
| 3 | WP-19 | Read the draft script `config/retell/hazel-prompt-au.md` and confirm or correct the promises it makes: "we never contact your current practice", "your details go to a practice only after you agree to that practice", "free for doctors, the practice pays when the doctor starts", "no exclusivity", "no locum work". | Hazel would state these as fact. They are business commitments, not things the code enforces. Not urgent: the script is not live. | open |
| 4 | WP-19 | Only after item 2: decide whether to enable Australian calls at all, and if so approve the steps in notes section 7 (second Retell agent, Australian number, consent wording on the form, removing the block). | Nothing in section 7 has been started. Hazel's voicemail greeting and the "text after a missed call" WhatsApp would both reveal a job search and must be changed first. | open |
| 5 | WP-28 | Have an Australian commercial lawyer review the draft Australian GP agreement before any practice is sent it. Give them `docs/au-gp/agreement-au-variant-legal-review.md` and a PDF made with `bash scripts/build-au-draft-agreement-pdf.sh ~/Desktop/au-agreement-DRAFT.pdf`. Ask for the outstanding unfair-contract-terms review of the standard 2026 agreement at the same time (same clauses). | The draft changes positioning only; fees, payment timing, guarantee and clauses are the standard agreement word for word. Ten marked questions (LR-1 to LR-10) need a lawyer. | open |
| 6 | WP-28 | Do not show or send the draft agreement to any practice, even informally. | Clause 1.1 accepts terms by conduct after "having received a copy" (question LR-10). | open |
| 7 | WP-28 | Confirm in writing the regulatory statements on page 2 of the draft (a provider number is needed for the new location; Ahpra public register check). | They are the build's working assumptions, not checked against a source. | open |
| 8 | WP-28 | Find the pre-July-2026 agreement and the list of practices that signed it. | What it says about Australian GPs is unknown (LR-8). | open |
| 9 | WP-28 | After lawyer sign-off, ask for the variant to be made usable (six technical steps at the end of the legal-review document). | It cannot be selected, sent or signed today, by design. | open |
| 10 | WP-28 (found, not fixed) | Decide whether the agreement PDFs and the discounted-rate source should stay publicly downloadable. | The standard and discounted agreement files sit in the publicly served `assets/` folder, so the negotiated rate card is at a guessable web address. This is how the live site works today and was not changed by this build. Checked by reading the code, not by fetching the address. | open |

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
