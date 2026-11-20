# Privacy policy, terms and consent wording: notes for the owner and the lawyer

**DRAFT - FOR LEGAL REVIEW - NOT PUBLISHED**

Work package WP-25 (findings WEB-19, DAT-25, DAT-24). Written 20 November 2026
from the code on branch `au-gp-testing`. Nothing in this document is legal
advice or a legal conclusion. Every point in section 4 is a question for an
Australian privacy and commercial lawyer. Where it says "we understand", that is
working knowledge the lawyer needs to confirm.

## 1. In short

- A new privacy policy, new terms of service and a set of consent lines have
  been **written as files only**. The live privacy page, the live terms page and
  every form are exactly as they were. A test fails if either live page changes
  by a single character or if any page or script refers to the drafts.
- The drafts cover both groups of doctors (those moving to Australia and those
  already registered here) and practices.
- Writing them accurately meant reading what the product actually does with
  personal information. That turned up **things the live privacy page gets
  wrong or leaves out today**, for the existing overseas service, regardless of
  the Australian launch. They are in section 3. Three deserve the owner's
  attention before anything else: 3.1, 3.2 and 3.3.
- The drafts cannot simply be published once a lawyer approves the words. Parts
  of them describe how the service **should** work (consent before an AI call,
  consent before a profile is sent, one access rule, a working deletion
  schedule). Section 6 lists what has to be true first.

## 2. The files

| File | What it is |
| --- | --- |
| `docs/au-gp/legal-draft/privacy-policy-draft.html` | Proposed replacement for `pages/privacy.html`. Same layout, so it can be dropped in. |
| `docs/au-gp/legal-draft/terms-draft.html` | Proposed replacement for `pages/terms.html`. |
| `docs/au-gp/legal-draft/consent-wording.md` | The exact consent lines, where each goes, which package wires it. |
| `docs/au-gp/legal-draft/data-access-rule.md` | Who can see identity and credential data today, one proposed rule, and the code changes to apply it. Also the retention gap (DAT-24). |
| `docs/au-gp/privacy-terms-legal-review.md` | This document. |
| `tests/au-wp25-legal-drafts.test.js` | Proves nothing was published. |

The folder `docs/` is not served by the website. To read a draft page, open the
file in a browser from disk; it will look unstyled because the stylesheet is
loaded from the site.

Related, and not repeated here: `docs/au-gp/hazel-au-script-notes.md` section 4
holds the 13 detailed questions about AI phone calls to Australian numbers
(owner action 2). Questions LR 3 and LR 4 below add to those; they do not
replace them.

## 3. What the live pages say, and what the code does

Established by reading the code. Nothing was tested against production and no
production setting was read.

### 3.1 AI phone calls are not mentioned anywhere, and the caller does not say she is an AI or that the call is recorded

- The AI caller rings qualified leads on UK, Irish and New Zealand numbers
  (`lib/lead-calls.js`). Australian leads are blocked.
- The live privacy page does not mention phone calls by an AI, recording or
  transcription. The form the lead filled in says only "We'll only contact you
  about your enquiry" (`pages/site-start.html:453`). Leads from Facebook and
  Instagram forms never see even that.
- The live script (`config/retell/hazel-prompt.md`) has her say she is an AI
  only if asked (line 65) and does not mention recording at all. The provider
  is set to keep everything (`config/retell/agent.json:40`,
  `"data_storage_setting": "everything"`), with per-contact memory switched on
  and no retention period.
- What is kept: recording link, full transcript, summary, sentiment and the
  assistant's notes ("family situation, preferred locations, concerns") in
  the table `lead_calls`. No deletion schedule.

This is today's overseas service, not the Australian build. See LR 3 and LR 4.

### 3.2 The live page says Meta never receives email or phone. For some leads it does.

`pages/privacy.html:282` says the Meta Pixel "never receives your name, email
address or phone number from us". That is true of the pixel on the page. But
for leads who came through a Facebook or Instagram form, the server separately
sends Meta the lead's email and phone in hashed form, with funnel events (lead,
qualified, call booked, signed up), for up to 35 days (`lib/meta-capi.js:76-87`,
`:179-181`). A reader of the live sentence would not expect that. The draft
describes both. See LR 10.

### 3.3 An assigned support officer can open a doctor's identity document by typing an address

The rule in the code is "director and consultants only, never support staff".
One route does not apply it (`data-access-rule.md`, 1.1 C). Nothing shows it
has been used; nothing would show it either, because that route writes no audit
entry. The fix is three lines (change C2) and affects no screen.

### 3.4 Other gaps between the live privacy page and the code

| Topic | Live page | What the code does |
| --- | --- | --- |
| Who the service is for | "medical recruitment and relocation platform" | Being extended to doctors already in Australia. |
| Providers named | Anthropic, "email service providers", Meta and Google tags, "cloud hosting" | Also Retell, Twilio, ElevenLabs, Cartesia, DoubleTick/WhatsApp, Calendly, Zoom, Google Workspace (Gmail, Drive, Calendar), Supabase, Vercel, Resend. |
| AI and identity documents | "document verification… qualification… certification… name matching" | The passport or driver's licence image itself is sent to Anthropic to read the name, type and expiry (`/api/ai/verify-identity`). CVs, WhatsApp messages, emails, call notes and meeting summaries are also sent for summaries, drafting and matching. |
| Video calls | Not mentioned | Interviews switch on Zoom's AI note-taker; the summary is stored and reused (`scheduled_calls.meeting_summary_raw`). Audio and video are not recorded. |
| Staff reading email | Not mentioned | Staff mailboxes are read automatically; attachments from doctors and practices are filed to the doctor's documents and Drive folder. |
| Consent to share with practices | "By using GP Link, you consent to us sharing your professional profile with medical practices" | Sent only after the doctor applies for a role, but no consent is recorded and the apply screen does not say what is sent. A CV may also be sent to the practice by WhatsApp (`lib/practice-submission-whatsapp.js`). |
| Retention | "as long as required… a reasonable period" | Identity document: 6 months after placement or 12 months inactive, but the 6-month rule never starts for in-app placements (DAT-24). Closed accounts: sign-in deleted after 90 days. Practices: deleted 12 months after archiving. Nothing else has a period. Weekly full backups to Google Drive are never pruned. |
| Security | "Audit logging for data access" | Staff actions are logged, but not every view of an identity document (`data-access-rule.md`, 1.1). Some documents copied to Google Drive are, for a time, viewable by anyone with the link (1.4). |
| Overseas transfers | "Australia, the United Kingdom, other relevant regulatory jurisdictions" | Processors are mostly overseas companies. Where each stores data is not recorded in the code or documents. |
| Access to your data | "may have the right" | A self-service download exists (`/api/account/export`). It leaves out call recordings, meeting summaries, WhatsApp messages and the original enquiry. |
| Company name | "GP LINK RECRUITMENT AUSTRALIA PTY LTD"; footer "GP LINK AUSTRALIA PTY LTD"; terms section 9 "GP Link Pty Ltd" | Three names. No ABN. |

### 3.5 Side by side: what changes

**Privacy policy**

| Live (17 sections) | Draft (18 sections) |
| --- | --- |
| 1 Introduction: relocation platform | 1 Both groups of doctors and practices; three commitments up front (employer not contacted; practice sees you only after you agree; no selling). |
| 2 Regulatory framework | 2 Kept, shorter; adds New Zealand. |
| 3 What we collect | 3 Rewritten in seven groups. **New:** enquiry and booking data; Ahpra number, type, conditions, undertakings, notations; fellowship; 19AB; right to work and visa details; supervision; indemnity; provider and prescriber numbers; location and notice period; current practice (so it is not approached); practice contacts. |
| 4 How we collect | 4 Adds advertising-platform forms, booking tools, public registers. States we do not collect from the current employer. |
| 5 How we use | 5 Rewritten for both services. |
| 6 Consent to share ("by using GP Link you consent") | **Removed.** Replaced by per-practice consent (sections 1 and 9). |
| not covered | **6 New:** email, WhatsApp, Calendly, Zoom, the AI voice assistant, recording, the Zoom note-taker. |
| not covered | **7 New:** checking registration on public registers. |
| 12 AI document verification | 8 Widened to everything AI is used for, including identity documents and CVs; "a person decides". |
| 7 Security (part) | **9 New:** who can see what, inside GP Link and at a practice, before and after consent. |
| 13 Third parties (four generic lines) and 8 International transfers | 10 Every provider named, with a placeholder for countries. |
| 9 Retention (general) | 11 Specific periods where they exist; placeholders where they do not. |
| 11 Cookies | 12 Corrected for the hashed email and phone sent to Meta. |
| 7 Security | 13 Shorter; adds a data-breach sentence. |
| 10 Your rights | 14 and 15: how to see, correct, withdraw, delete; response time; complaints route. |
| 14 Children | 16 Kept; notes family members on visa applications. |
| 15 Limitation of liability | **Removed** from the privacy policy (it is in the terms). LR 21. |
| 16 Changes, 17 Contact | 17, 18 Kept; adds a named privacy contact (placeholder). |

**Terms of service**

| Live (18 sections) | Draft (19 sections) |
| --- | --- |
| 1 "recruitment, compliance support, and relocation coordination" | 1 Recruitment for two groups of doctors; practices pointed to their agreement. |
| 3 Nature of services | 3 Split into "all doctors" and "doctors who trained overseas". Adds: not legal, financial or tax advice. |
| 4 Recruitment relationship | 4 **New content:** you choose each practice; what the practice receives; current employer never contacted; application limits. |
| 5 No guarantee | 5 Adds provider numbers, billing location, income and billings, start dates; role information comes from the practice. |
| 6 User responsibilities | 6 **New:** responsibility for the accuracy of registration details (Ahpra number and type, conditions, fellowship, 19AB, right to work, indemnity) and to report changes. |
| not covered | **7 New:** agreement to checks on the public Ahpra register and overseas registers. |
| 7 Document authenticity | 8 Kept, shorter, "sole liability" language softened pending LR 15. |
| 8 Fees: "typically charges… practices, not… candidates, unless otherwise agreed" | 9 "Free for doctors… Practices pay our fees." Source: the public site says "completely free for doctors, always" (`pages/site-about.html:148`, `pages/site-faq.html:141`) and the practice agreement carries the fees (`lib/agreement-variants.js`). No code charges a doctor. LR 16. |
| not covered | **10 New:** what a practice must do with candidate information. |
| 9 IP, 10 Confidentiality | 11 Merged. |
| 11 Limitation of liability | 12 Carried over, flagged for review. |
| not covered | **13 New:** how we contact you; AI calls only with agreement. |
| 13 Termination ("by written request") | 15 Account can be closed in the app. |
| 15, 16 Disputes, governing law ("exclusive") | 17 Merged; "exclusive" flagged. |
| 17 Changes ("continued use constitutes acceptance") | 18 Notice of significant changes; flagged. |

**One thing the lead and owner should know about wording.** The build bans
certain words from anything an Australian doctor sees (AGENT-RULES section 4:
visa, overseas, AMC, GMC and others). A single privacy policy and a single set
of terms that cover both services cannot avoid them. The drafts keep those words
inside sections labelled for doctors who trained overseas, and the Australian
consent lines avoid them completely (a test checks this). If the owner wants an
Australian doctor never to see them even in the legal pages, the alternative is
two versions of each page chosen by audience. That is a design decision for the
publishing package, not something this draft settles.

## 4. Questions for the lawyer

Numbered to match the `[LEGAL REVIEW n]` markers in the drafts.

| # | Topic | Question |
| --- | --- | --- |
| LR 1 | Which laws apply | Is GP Link bound by the Privacy Act (annual turnover may be under the small-business threshold; it handles identity documents and discloses personal information to practices for a fee)? Should the policy commit to the APPs regardless? Do the UK GDPR, EU GDPR and the New Zealand Privacy Act apply to doctors recruited from those countries, and if so what must be added (lawful bases, a UK or EU representative, transfer wording)? |
| LR 2 | Sensitive information and government identifiers | Which of these is "sensitive information" needing express consent: conditions and undertakings on registration, conduct history, criminal history checks, nationality, immigration status? What rules apply to holding and passing on passport numbers, Medicare provider numbers and PBS prescriber numbers (we understand APP 9 limits use of government identifiers)? Is the internal access rule in section 9 of the draft adequate? |
| LR 3 | AI phone calls | In addition to the 13 questions in `hazel-au-script-notes.md`: (a) is the optional tick box in `consent-wording.md` A2 sufficient consent for an AI call; (b) the AI caller rings UK, Irish and New Zealand numbers today on the strength of "We'll only contact you about your enquiry", or of a Facebook form with no such line: is there a sufficient basis for those calls under each country's rules on automated or marketing calls, and what should change now; (c) must the caller say she is an AI at the start? |
| LR 4 | Call recording | Calls are recorded and transcribed with no announcement in the live script. What is required for calls to people in each Australian state and territory, the UK, Ireland and New Zealand: notice, or agreement? Is a tick on a form plus an announcement at the start enough? What should happen to existing recordings made without an announcement? How long may recordings be kept? |
| LR 5 | Email and WhatsApp | We understand the Spam Act covers commercial emails and messages such as WhatsApp. Is "by continuing you agree" under a form button enough consent for the booking link, reminders and later follow-ups, or is a tick needed? What sender identification and unsubscribe must each message carry, including WhatsApp templates? How long does consent from an enquiry last? |
| LR 6 | Information sent overseas | Most processors are overseas companies. What must the policy say (we understand it should name the likely countries)? Should GP Link rely on taking reasonable steps and remaining accountable, or ask for consent to overseas disclosure, and if consent, is the sentence in section 10 of the draft adequate? What contract terms should GP Link have with each provider? |
| LR 7 | AI processing | Identity documents, CVs, messages and call notes are sent to an AI provider. Is the disclosure in sections 6 and 8 adequate? We understand new Privacy Act requirements about explaining decisions made with computer programs start on 10 December 2026: do they apply to AI-assisted matching, document checks and screening here, and what must the policy say? Is "a person decides" accurate enough given that an AI check can hold an account for review? |
| LR 8 | The current-employer promise | The drafts promise that GP Link never contacts a doctor's current practice or employer and never tells them. Can that be promised without exception? What carve-outs are needed (legal obligation, the doctor asking us to, a practice that is itself a GP Link client, a reference the doctor nominates)? What is the exposure if a practice we introduce the doctor to tells the current employer? |
| LR 9 | Consent before a profile goes to a practice | Is the per-practice tick in `consent-wording.md` C adequate? Must the live blanket consent ("by using GP Link you consent…") be withdrawn for existing users, and how? What must GP Link do about information a practice already holds when a doctor withdraws? |
| LR 10 | Advertising tools | The live page's statement about Meta is inaccurate for leads from Facebook forms (3.2). Is the corrected wording in section 12 adequate? Is consent needed before setting advertising cookies for visitors in the UK and EU (there is no cookie banner)? Any issue with sending hashed contact details to Meta for people who filled in Meta's own form? |
| LR 11 | Retention and deletion | What retention periods are appropriate, and what must be kept by law, for: enquiries that never convert, CVs and credentials of unplaced doctors, placement records, call recordings, meeting summaries, messages? Are there state or territory employment-agent rules on record keeping? The identity-document deletion rule does not run for in-app placements, and weekly backups are never pruned: what should be done about copies already held longer than the policy would promise? |
| LR 12 | Access, correction, complaints | Are the routes and the 30-day response time in sections 14 and 15 correct? The self-service download leaves out call recordings, meeting summaries and messages: is that acceptable if they are provided on request? |
| LR 13 | Data breaches | Is the sentence in section 13 appropriate? Does the identity-document access gap (3.3) or the Drive link exposure (`data-access-rule.md` 1.4) need to be assessed as a possible breach? |
| LR 14 | Checking public registers | Is the doctor's agreement needed to check the public Ahpra register, record the result (including conditions, undertakings and reprimands) and repeat the check? May GP Link tell a practice what the register shows? Any restriction on automated or repeated look-ups of the register? |
| LR 15 | The terms as a contract | Is a statement under a button enough to bind a doctor, or is a tick needed? Do the limitation of liability, "your responsibility" clauses, exclusive NSW jurisdiction and "we may change these terms" clauses survive the Australian Consumer Law and the unfair contract terms rules (we understand penalties now apply)? The draft softens some; say what else must change. |
| LR 16 | Free for doctors | The draft says doctors are never charged. Do any state or territory employment-agent laws apply to GP Link (licensing, a ban on charging work-seekers, required notices), and does the wording satisfy them? Is there any situation in the practice agreement where cost could fall on the doctor? |
| LR 17 | Advice GP Link does not give | The site has a visa page and staff help with visa steps. Is "we do not give immigration advice" accurate and sufficient (we understand only registered agents may give immigration assistance)? Same question for contract and restraint-clause discussions and for talk about earnings. |
| LR 18 | What practices must do with candidate information | Section 10 of the terms and line D3 ask practices to keep details confidential, not contact the current employer, and delete a CV if they do not proceed. Should these be in the Recruitment Services Agreement instead? Does the 2026 agreement already say anything on this? |
| LR 19 | AI meeting summaries | Interviews use Zoom's AI note-taker. No audio or video is kept, only a written summary. Is notice in the invitation (line D4) enough for doctors and practice staff in every state, or is agreement needed? |
| LR 20 | Other people's information | Doctors give us details of family members (for visas), referees and supervisors. What must GP Link do to notify those people, if anything? |
| LR 21 | Liability wording in the privacy policy | The live privacy policy contains a "limitation of liability" section. The draft removes it. Confirm that is right. |

## 5. Questions for the owner

Numbered to match the `[OWNER TO CONFIRM n]` placeholders. None of these could
be found in the code or documents.

| # | Question |
| --- | --- |
| OQ 1 | The exact legal name of the company and its ABN. The live pages use three different names. |
| OQ 2 | Who is responsible for privacy requests (name or title), a phone number, and how quickly complaints are acknowledged. |
| OQ 3 | Where each provider stores data: the Supabase project region, the Vercel region, and the storage country for Retell, DoubleTick, Calendly, Zoom, Resend, Google Workspace and Anthropic. The policy needs a list of countries. (Each provider's dashboard or contract shows this.) |
| OQ 4 | How long to keep each kind of record (see the table under LR 11), and whether to fix the identity-document deletion rule (`data-access-rule.md`, change C10), which would delete older documents on its first run. |
| OQ 5 | What retention period is set for call recordings in the Retell account, and what it should be. The configuration file says "keep everything". |
| OQ 6 | Whether a migration agent is used, who, and what information is passed to them. |
| OQ 7 | Does GP Link ever contact a doctor's current or former employer or supervisor: for references, certificates of good standing, supervisor forms, or anything else? The "never contact your current practice" promise has to match. |
| OQ 8 | What a practice is actually sent about a doctor after placement (documents, numbers, visa papers). |
| OQ 9 | Whether criminal history checks or conduct declarations are actually collected. The live page says they may be. |
| OQ 10 | Whether the AI caller will ever ring Australian numbers, and whether calls to overseas leads should from now on require the tick box (which would mean fewer calls). |
| OQ 11 | Whether any payment or invoicing provider handles practice contact details (the code has none; invoices appear to be raised outside the app). |
| OQ 12 | The effective date for each document. |
| OQ 13 | The three access decisions in `data-access-rule.md` Part 2: (A) may consultants see identity documents, and until when; (B) is a practice given the Ahpra registration number before interview; (C) what a practice receives after placement. |
| OQ 14 | Should doctors moving to Australia also get the per-practice consent tick when they apply, or only Australian doctors? |
| OQ 15 | In Meta Events Manager, is "automatic advanced matching" on for the pixel? If it is, the pixel does receive hashed contact details from forms and the policy must say so. |
| OQ 16 | How long weekly database backups in Google Drive should be kept, and who has access to those folders. |
| OQ 17 | Whether the Zoom AI note-taker is used on first consultation calls as well as interviews, and whether anyone has objected. |

## 6. What must be true before these can be published

The drafts describe some things as they are meant to be. Publishing them while
the product does otherwise would make the policy inaccurate in a new way.

| The draft says | Needed first |
| --- | --- |
| AI calls only with your agreement (privacy 6, terms 13) | Consent line A2 on every lead form including Meta's own forms; the dialler refuses a lead with no recorded consent. |
| The assistant says at the start that she is an AI and that the call is recorded (privacy 6) | The live script changed and published in Retell (an owner action; not done, and not to be done by an agent). |
| A practice sees your details only after you agree (privacy 1 and 9, terms 4) | Consent line C on the apply sheet and the consent recorded (`data-access-rule.md`, C9). |
| Who can see identity documents and credentials (privacy 9) | The access rule built (`data-access-rule.md`, C1 to C8). |
| Identity document deleted six months after placement (privacy 11) | The retention anchor fixed (C10) and the owner's decision on existing documents. |
| Retention periods (privacy 11) | The owner's decisions (OQ 4, 5, 16) and the jobs that enforce them. |
| Countries (privacy 10) | OQ 3. |
| We never contact your current practice (both) | OQ 7 and LR 8. |

Sections that are accurate today and could be published sooner, if the lawyer
agrees, as a correction to the live page: the provider list (privacy 10), the
AI tools section (privacy 8), the corrected Meta wording (privacy 12), and the
WhatsApp, Calendly and Zoom paragraphs (privacy 6).

## 7. How to publish later

**NOT DONE. Needs the lawyer's sign-off in writing and the owner's go-ahead.**

1. Lawyer answers LR 1 to LR 21; owner answers OQ 1 to OQ 17. Edit the two
   draft pages and `consent-wording.md` to match.
2. Build and release what section 6 lists, each through its own package.
3. In each draft page remove: the banner `<div data-wp25-draft="banner">`, the
   HTML comment at the top of `<main>`, every `<span data-wp25-draft="flag">`,
   every `[OWNER TO CONFIRM …]` and `[LEGAL REVIEW …]`, the two
   `<p data-wp25-draft-note…>` paragraphs if not wanted, and the
   `<meta name="robots" content="noindex, nofollow" />` line; restore the
   `<title>` ("Privacy Policy - GP Link", "Terms of Service - GP Link"). Search
   the result for `wp25`, `[OWNER` and `[LEGAL`: there must be no match.
4. Copy the results over `pages/privacy.html` and `pages/terms.html`. These two
   pages are not behind the Australian switch, so this changes what every
   visitor sees; it is a deliberate, owner-approved release, not part of the
   switch.
5. In the same commit update the two hashes in
   `tests/au-wp25-legal-drafts.test.js` (or retire that test), and check whether
   any other test quotes the live wording (`grep -rn "privacy.html\|terms.html" tests/`).
6. Cache-busters: the two pages load `/css/gp-tokens.css?v=20260612` and
   `/js/error-reporter.js?v=20260720a`. Neither file changes, so no bump is
   needed for the pages themselves. Bump the `?v=` of any script or stylesheet
   changed when wiring the consent lines, and the tests that pin them.
7. Wire the consent lines through the packages named in `consent-wording.md`
   (WP-15 / WP-21, WP-05, WP-22 / WP-09, WP-23), with the consent recorded.
8. Tell existing users. A changed privacy policy and terms should be notified
   to current doctors and practices (email and an in-app notice); ask the lawyer
   whether existing users must actively re-accept (LR 9, LR 15).
9. Who approves: the lawyer (wording), the owner (business promises and
   publication), and the lead (that section 6 is built and tested).
