# Handover: AHPRA registration granted → visa stage (2026-11-05)

Owner request (5 Nov 2026): when a GP's AHPRA registration is granted, the GP's app should show
only the visa page (practice engages a migration agent; documents needed from the GP are
requested and uploaded there), the AHPRA letter should be saved to the GP's file, and the RSO
should get two tasks: congratulate the practice and ask them to engage a migration agent, and
request passports from the GP and family by email + WhatsApp. Everything else that was missing
was to be added as well.

Trigger case: Dr Mercy Obanimoh (The Doctors Werribee). AHPRA emailed "Ahpra – Final Notice of
Registration – 14805868" to the doctor with hazel@ cc'd on 2 Nov 2026 (reg MED0004091669,
effective 2 Nov 2026, current to 30 Sep 2027, supervised practice Indirect 2 under
Dr Chamira Ranatunga, commencement 25 Jan 2027). The app dropped it: any email with a PDF/DOCX
attachment took the "attachments" track and was marked `filtered`; the AHPRA classifier only ran
on attachment-free mail. The 28 Oct "Notice to propose approval" email was never processed at all.

## 1. What is live (this change)

### Database (migration `supabase/migrations/20261105120000_ahpra_registration_granted.sql`,
applied to production via `rpc/exec_sql` with `public.`-qualified names, recorded in
`schema_migrations`)
- `registration_cases`: `ahpra_registration_number`, `ahpra_registration_type`,
  `ahpra_registration_effective_date`, `ahpra_registration_expiry_date`,
  `ahpra_registration_granted_at`, `ahpra_registration_has_conditions`,
  `ahpra_registration_conditions` (jsonb: summary, items[], review_period_months,
  supervised_practice{position, employer, location, level, supervisor, commencement_date},
  appeal_deadline_days), `ahpra_registration_source_gmail_message_id`, `visa_case_id`,
  `migration_agent`, `migration_agent_contact`, `sponsor_name`, `sponsor_contact`.
- `visa_documents`: `dependant_id` (FK visa_dependants), `label`.
- `registration_tasks`: `domain`, `visa_case_id` (migration `20261105130000_registration_tasks_domain_visa_case.sql`,
  also applied via `rpc/exec_sql`): production never had them, so every visa task insert that set
  `domain:'visa'` (visa document review, visa case setup, the passports card) was being rejected.
- Note: `registration_cases` has NO `metadata` column in production (older code that patches it
  fails silently). Do not assume an unapplied migration's columns exist: probe with a `select=`.

### Inbound Gmail pipeline (server.js)
- `preFilterEmail`: an `@ahpra.gov.au` sender always takes the **triage** track, attachments or not.
- GP matching for AHPRA mail also reads the **To:** header (was Cc only); the classifier's
  candidate query now includes `visa` and `amc` stages.
- `lib/ahpra-registration-granted.js` → `detectAhpraRegistrationOutcome(emailMeta)` returns
  `granted` / `proposal` / null from subject, body and attachment filenames.
  - `granted` → `processAhpraGrantEmail` (downloads PDF/DOCX, parses, runs the flow) →
    `processed_gmail_messages.result = 'registration_granted'`, no correspondence card.
  - `proposal` → normal status card titled "AHPRA proposes to approve registration (with
    conditions)" + timeline event; no stage move.
- `parseAhpraFinalNotice`: model read of the PDF (document block, `AHPRA_S80_EXTRACT_MODEL`,
  budget-checked) with a regex fallback over the covering email, the DOCX schedule text (mammoth)
  and a dependency-free PDF text read (`extractPdfTextBasic`). The fallback finds dates,
  supervision block and commencement from the letter and the MED number from the schedule.

### The flow: `handleAhpraRegistrationGranted(input)` (server.js)
Idempotent on the Gmail id, the RFC822 Message-ID and the registration number. Steps, each
fail-soft, summary returned `{ok, already, filed[], closed[], tasks[], stage, visaCaseId, errors[]}`:
1. Records the registration fields on the case (+ `ahpra_application_number` if empty,
   `gp_verified_stage = 'visa'`, sponsor name/contact from the placed practice).
2. Files the attachments with `deliverToMyDocuments(..., {notifyGp:false})` under keys
   `ahpra_registration_notice`, `ahpra_conditions_schedule`, `ahpra_registration_certificate`,
   `ahpra_proposal_notice` (Drive folder "AHPRA registration"; labels in `DELIVERED_DOC_LABELS`;
   exposed to the GP via `GET /api/gplink-docs-status` → `ahpra_documents`).
3. Completes open AHPRA tasks of the case (related_stage ahpra or type ahpra_action_item /
   ahpra_correspondence) with a "Closed: AHPRA registration granted" note.
4. Moves the case to `visa` with `applyVerifiedStageToGp(caseId, userId, 'visa', actor)` — the
   staff "VA verified stage" propagation extracted into a function (user_state overrides +
   `registration_cases.stage/substage` + stage_change event). `PUT /api/admin/case` now calls it.
5. Creates the `visa_applications` row (482, stage nomination, sponsor = practice, status message
   about the practice engaging a migration agent), links `registration_cases.visa_case_id`, adds a
   GP-visible timeline event.
6. Creates `visa_dependants` from onboarding (`who_moving`: just_me / me_partner / me_children /
   me_partner_children; `children_count`) and passport request rows in `visa_documents`
   (status `missing`, label "Your passport" / "Partner's passport" / "Child N passport").
7. Creates RSO tasks (all `metadata.registration_granted = true`, assignee = assigned RSO):
   - `verify` "AHPRA registration granted — confirm details (MED…)": register link + checklist.
   - `migration_agent` "Email <practice>: congratulate … engage a migration agent":
     `metadata.outbound_email` draft from `lib/registration-granted-emails.js`.
   - `visa_stage` "Request passports from Dr <GP> and family (email + WhatsApp)":
     `metadata.gp_request` (email draft + WhatsApp template `gp_link_visa_passports`).
   - `followup` conditions tracker (status `waiting`, related_stage `commencement`):
     acknowledge conditions (effective +30d), watch for the Compliance Team letter (+14d), and
     from the commencement date: practice location form (+14d), 3-month supervision report,
     MSF/CFEP (5 months), workplace assessment (6 months), orientation + cultural safety
     (6 months), final 6-month report, renewal (expiry −30d).
8. Timeline event "AHPRA registration granted — MED…, effective …, current to …".
Nothing is sent to the GP or the practice automatically; the RSO sends from the task cards.

### Endpoints
- `POST /api/admin/registration-granted/send-practice-email` `{task_id, to?, cc?, subject?, bodyHtml?}`
  → sends via Gmail as the case sender, outbound task_message, task → `waiting_on_practice`.
- `POST /api/admin/registration-granted/send-gp-request` `{task_id}` → GP email
  (`sendGpNotificationEmail`) + WhatsApp template; a retry never re-sends the email
  (`metadata.gp_request.email_sent_at`); WhatsApp failure is fail-soft; task → `waiting_on_gp`.
- `POST /api/admin/ahpra/registration-granted` — manual path (letter arrived outside email),
  also reachable from the "Log AHPRA letter" modal (letter type "Registration granted").
- `POST /api/admin/ahpra/reprocess-message` `{mailbox, gmailMessageId, repair?}` (admin session or
  `Authorization: Bearer <CRON_SECRET>`, and the request must carry the app's `Origin` header or
  the same-origin guard answers 403) — re-runs detection + the flow for one Gmail message.
  `repair: true` re-runs only the idempotent steps of an already recorded grant (filing, visa
  case, family, passport requests, cards) to fill gaps without re-recording or re-moving the stage.
- `GET /api/visa/status` adds `registration` and `stage_context`; `documents[]` carry
  `label, dependant_id, request_note, requested_at` (allowlisted, no internal fields).
- `POST /api/visa/documents` accepts `documentId` (fulfil a request row in place) and
  `dependant {fullName, dateOfBirth}`; `POST /api/visa/dependants` also creates the passport
  request and returns it as `passportRequest`.

### GP app
- `pages/visa.html` rebuilt: collapsed journey ("Steps 1 to 4 complete" + Visa current), green
  registration strip, "Where things are" (agent engaged → nomination → lodged → granted),
  "Documents needed from you" with per-person passport rows, inline name/DOB for placeholder
  dependants, add-a-family-member, empty state, RSO banner with WhatsApp link, pathway collapsed.
- `pages/index.html`: at stage `visa` the hub navigates to `/pages/visa` (`?all=1` shows the
  full hub); Visa is the Current row once AHPRA is done (PBS was wrongly highlighted before).
- `pages/ahpra.html`: "Registration Granted" hero → "Go to your visa page".
- `pages/my-documents.html`: "From AHPRA" group (We Prepare tab) from `ahpra_documents`.

### RSO Command Centre (`pages/admin.html`)
- Cards for `migration_agent` (editable email, Send to practice, Record the migration agent via
  `PUT /api/admin/ops/case?id=`, Mark complete) and `visa_stage` (email + WhatsApp preview,
  Send email + WhatsApp, Retry WhatsApp). Registration line + Conditions pill in the GP header.
  "Log AHPRA letter" modal gains a letter type select. Ops Queue labels for the new task types.

### WhatsApp
- DoubleTick template `gp_link_visa_passports` (UTILITY, {{1}} first name, {{2}} link) created
  5 Nov 2026 via the public API (id 3670455), PENDING Meta approval at creation.
  `DOUBLETICK_STAGE_TEMPLATES.visa` points at it. The old "Visa stage started — WhatsApp template
  sent" log now only fires after a successful send.

## 2. Deliberate decisions (do not "fix" back)
- Outbound messages to the GP and the practice are NEVER sent automatically on grant; the two
  tasks carry drafts and the RSO sends with one click (owner spec).
- `deliverToMyDocuments` is called with `notifyGp:false` for the AHPRA letters so the doctor is
  not emailed three "document added" notes; the passport-request email is the one message.
- A proposal letter never moves the stage; only the final notice does.
- AHPRA mail always takes the triage track (the attachments track's `aiMatchEmail` is for
  practice/GP documents and marked the final notice "not relevant").

## 3. Verified data shapes
- Final notice PDF: Word-generated; `extractPdfTextBasic` recovers dates/supervision block but
  NOT the MED number (different glyph stream); the DOCX schedule has it in plain text.
- `user_profiles.who_moving` stored values: `just_me`, `me_partner`, `me_children`,
  `me_partner_children`; `children_count` is a string.

## 3b. First live run (Dr Obanimoh, 5 Nov 2026)
Reprocess of `1a19a3d6393065b5` in `hazel@`: model read of the PDF succeeded (MED0004091669,
effective 2 Nov 2026, current to 30 Sep 2027, Indirect 2 under Dr Chamira Ranatunga, commencement
25 Jan 2027, 6 condition items); both letters filed; DECF-00 task closed; stage → visa; visa case
`bfd6763c-5318-4729-a29d-25c44ab456c9` with partner + 2 children and 4 passport requests; verify +
migration-agent cards + 9 tracker tasks. The passports card failed on the missing `domain` column
(fixed by the migration above + a `repair: true` rerun). The processed-email row and the bare
application number (14805868) were repaired by hand. WhatsApp template `gp_link_visa_passports`
was APPROVED by Meta within the hour.

## 3c. The two cards after the first send (owner report 8 Nov 2026)

Both cards kept showing the email that had already gone. Dr Ranatunga had replied on the
migration-agent thread (6 Nov 12:19, "Hi Nangi, will you be able to do the below for this
doctor?", Surekha Kalpage <migrationnetworks@gmail.com> copied in) and the card still offered
the congratulations draft with "Send again"; the passports card re-showed the congratulations
email after it had been sent.

### Migration-agent card: the practice replied
- The reply WAS matched (thread match, `task_messages` inbound row, task flipped to open) but
  `_recordPracticeReplyFollowup` only read `practice_pack_child` tasks. It now routes a
  `migration_agent` task to `_recordMigrationAgentReply` (same two-phase shape: deterministic
  `metadata.practice_reply` marker first, AI read + draft layered on top; never sends).
- `lib/migration-agent-reply.js` (pure): prompt, defensive parse, deterministic fallback that
  reads the CC line (one third party copied in → `delegated`, follow-up addressed TO them, the
  contact copied), `applyRecipientGuard` (every address the model proposes must be on the
  thread; an unknown "agent email" is dropped with an RSO note). Outcomes: `agent_named`,
  `delegated`, `will_engage_later`, `question_for_us`, `declined`, `unclear`.
  `metadata.practice_reply` carries `kind:'migration_agent'`, `reply_to`, `cc[]`,
  `agent_name/agent_email/agent_confidence`, `suggested_subject/suggested_reply`, `rso_notes`,
  `answered_at`.
- Card (`renderOpsMigrationAgent(task, msgs)`): when the last message on the thread is theirs,
  shows their reply, the AI read and a follow-up composer ("Send follow-up",
  `data-rg-followup="1"`; "Draft with AI" → `POST /api/admin/practice-reply/draft`). The
  Record-the-agent fields are pre-filled from the read until something is on file. Guided line
  "Practice replied — read the reply and send the follow-up"; Ops subtitle "practice replied".
- `send-practice-email`: always threads onto the Gmail conversation (`threadId`, `In-Reply-To`
  / `References` from the latest inbound); the text part is the body actually sent. A follow-up
  (`followup:true`, or a reply pending) is appended to `metadata.followups[]`, marks
  `practice_reply.answered_at`, and leaves `outbound_email` (the congratulations draft) alone.
- `POST /api/admin/practice-reply/draft` also accepts `Authorization: Bearer <CRON_SECRET>`
  (+ the app's Origin header) for a maintenance re-draft of a reply that landed before this
  shipped. (`CRON_SECRET` is empty in every local .env, so Dr Obanimoh's task
  `d580bea7-175e-4a74-bdc4-b050af1de884` was backfilled by a one-off script using the same lib.)
- **Waiting state (second owner report, same day):** once the follow-up had gone the card went
  back to the congratulations draft with "Send again". Now state C is a collapsed **nudge**
  composer ("Nudge them" / "Nudge the practice"): `POST /api/admin/practice-nudge/draft` hands a
  `migration_agent` task to `_draftMigrationAgentNudge`, which chases whoever we last wrote to
  (`nudgeTarget`: the last follow-up's to/cc, else the original contact), drafted from the whole
  thread, deterministic fallback (`buildMigrationAgentNudgeFallback`). The thread subject wins.
  "Send nudge" posts `nudge:true` → `metadata.followups[]` entry `kind:'nudge'`. The
  congratulations draft is offered exactly once, in the not-yet-sent state. Guided line after
  3 quiet days: "No reply N days after our follow-up — send the nudge on the card".
- **Parked while waiting (third owner report, same night):** "the task should disappear after
  Hazel replies and only reappear if there is no reply after a few days or there is a new reply".
  Before this, no task type did that — waiting tasks stayed listed with an amber pill. Now, in
  `pages/admin.html`, every `waiting_on_*` task (except the conditions tracker) is **parked** for
  `WAITING_CHASE_DAYS = 3` after our last send (`taskWaitingSince`: the card's own
  `followups[]`/`outbound_email.sent_at` or `gp_request.last_reminder_at`/`email_sent_at`, else
  `updated_at`): the GP Tasks pane moves it under a collapsed "⏳ Waiting on others · n" strip
  (with an "Open" button that un-parks it for the session), the Tasks tab count excludes it, and
  the Ops Queue hides it unless the Waiting-on-GP/practice tiles are selected. It comes back when
  (a) a reply flips it to `open` (inbound paths, `_recordMigrationAgentReply`), (b) a passport
  upload flips the passports card to `open` and stamps `gp_request.last_upload_label/_at`
  (`POST /api/visa/documents`, passport request rows only), or (c) 3 quiet days pass — the guided
  line then says why ("No reply N days after our follow-up — send the nudge", "No upload N days
  after the request — send the reminder"). Server side, every registration-granted send that
  hands the ball over also sets `due_date = today + 3` (`_waitingChaseDueDate`), so "overdue"
  means "no answer past the chase date" and the weekly sweep's 3-days-overdue escalation lines up.
- **A reply in a NEW thread (owner 2026-11-09, "will the AI match it to the task correctly?"):**
  before this, only three things placed a practice email on the card: the Gmail thread id, an
  `In-Reply-To`/`References` header pointing at a stored Message-ID, or the model guessing from
  task titles (`aiMatchResponseToTask`) — and only after the sender had been resolved to a case,
  which worked for the GP and the practice contact on file but NOT for the agent or anyone else we
  had merely written to; the generic triage path never reused the early sender match either. Now:
  (1) `resolveCaseByCorrespondent(sender)` resolves a case from our own outbound `task_messages`
  (recipient/cc) — wired into the early path after the GP/practice lookups, role `unknown`;
  (2) `matchRegistrationGrantedCardByParty` runs as Signal 2.5 in `matchResponseToTask`, before
  the model: anyone a follow-up/nudge went to, the person the practice handed it to, the agent
  (`lib/migration-agent-reply.js` → `cardParties(meta).specific`) → the card at 0.92
  (`card_party_match`); the practice contact we first wrote to → the card at 0.8
  (`card_contact_match`) only when nothing else practice-facing is open on the case;
  (3) the content matcher's task list now carries a `context` hint (`_taskMatchHint`: stage,
  purpose, people on the thread); (4) the generic path falls back to the early address-resolved
  case (`if (!gpCase && earlyGpCase)`) so a known party's mail lands on the GP's case as a triage
  task rather than in Support. Verified against prod: the PostgREST `or=(recipient.ilike.*a*,
  cc.ilike.*a*)` probe returns Hazel's follow-up row for the agent's address, and Mercy's placed
  application carries Dr Ranatunga's email. Exported for tests: `matchResponseToTask`,
  `resolveCaseByCorrespondent`, `matchRegistrationGrantedCardByParty`.
- **One contact, many GPs (owner, same day):** a practice contact, an agent or a practice manager
  can sit behind several placed GPs. `resolveCaseByCorrespondent(sender, emailMeta)` therefore
  returns `{ case, known, candidates }`: all distinct cases we have written to that address from
  are collected and, when there is more than one, `_disambiguatePracticeEmail` decides (GP surname
  in subject/body → a thread of theirs → the model → deep context), never "the most recent case".
  When it cannot decide, `known: true, case: null` — and the early path sets `earlyKnownParty`
  (also set when the practice-contact lookup finds rows but cannot pick the GP), which the
  rollout-gate call treats as a known case, so the email goes to Sonnet triage (placed-GP list)
  and at worst to Support, never silently `filtered`. Inside the chosen case the card match is
  unambiguous (one migration-agent card per GP).
- **Dr Akkas's "No open tasks" (owner 2026-11-09):** not the parking rule. `GET /api/admin/tasks`
  fetched `limit=200` ordered by priority NAME (`high` < `low` < `normal` < `urgent`) and applied
  the RSO scope filter afterwards; at 265 active tasks every `normal` and `urgent` task fell off
  the page, so her four tasks (two practice-pack items waiting on Dr Mahmoud since 23 Oct, the
  WhatsApp-help task, a deferred SPPA) never reached the Command Centre although the GP card
  (server-counted) said "3 tasks · overdue". Cap raised to 2000 there and on `/api/admin/ops/queue`
  (client asks 1000 / 2000). The two practice items are 17 days quiet, so under the rule they
  show with the nudge, not parked. Also: the server-side counts behind the GP list and header
  (`/api/admin/cases`, the dashboard users) now skip parked tasks for `urgent_tasks` /
  `overdue_tasks` (`_isParkedWaitingTask`: waiting_on_* and `updated_at` inside the chase window;
  `open_tasks` still counts them), and the client's `caseNeedsAction` / `caseActionItems` / header
  "Open Tasks" skip parked tasks too, so a GP is not "Needs Action" for a task that is parked.

### Passports card: a reminder nudge after the first send
- `GET /api/admin/registration-granted/gp-request-status?task_id=` reads the live
  `visa_documents` passport rows (`lib/registration-granted-emails.js` →
  `passportStatusSummary`: uploaded/approved are in, missing/rejected still needed; older
  cases with no rows fall back to `gp_request.people`) and returns `people[]`, `outstanding[]`,
  `received[]`, `all_received`, the reminder draft (`buildGpPassportReminder`: lists only what
  is missing, acknowledges what is in, names the start date, a second reminder says so) and
  `reminder_count`.
- `POST /api/admin/registration-granted/send-gp-request` with `kind:'reminder'` builds the same
  reminder server-side and sends email + WhatsApp template `gp_link_visa_passports_reminder`
  (UTILITY, {{1}} first name, {{2}} what is missing, {{3}} link; created in DoubleTick 8 Nov
  2026, id 3684465, pending Meta approval at creation, fail-soft until approved). 409
  `not_requested_yet` before the first request, 409 `nothing_outstanding` once every passport
  is in. Each send is appended to `gp_request.reminders[]`.
- Card (`renderOpsGpPassports(task, msgs, ps)`): before the first send unchanged; afterwards the
  pills show ✓ for passports already uploaded, and the card previews the reminder (email +
  WhatsApp) with "Send reminder (email + WhatsApp)". `{{name}}` is substituted in the preview.
  When everything is in: "Every passport has been uploaded … mark this complete".
- No automatic reminder cadence: the RSO sends from the card (consistent with §2).

## 4. Open / not yet verified
- Model read of the PDF was not exercised in tests (regex fallback path tested); first live run
  is the reprocess of message `1a19a3d6393065b5` in `hazel@`.
- `gp_link_visa_passports` must be APPROVED by Meta before the WhatsApp leg sends; until then
  the card shows "WhatsApp not sent" with Retry.
- Non-grant AHPRA emails with attachments no longer have their attachments auto-stored (they
  were being filtered before anyway); a follow-up could file them on the correspondence card.
- The hub-to-visa redirect was verified in a plain iframe with a stub server, not inside the
  live app shell.
