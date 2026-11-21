# Australian WhatsApp templates: proposed, not submitted

Started by WP-09. Later packages add their templates as new rows.

**Nothing in this file has been sent to DoubleTick or Meta.** Each row is a
proposal for the owner to create and submit. Until a template is approved and
switched on, the Australian message it would carry goes by email only or is
skipped. It is never sent through one of the existing templates.

Why new templates rather than the existing ones: a WhatsApp template has fixed
wording that Meta approved, held by DoubleTick. That wording is not in this
repository, so the build cannot check what an existing template says about a
candidate. The existing ones were written for doctors moving to Australia from
another country.

## How to switch one on

1. Create the template in DoubleTick with exactly the name, variables and
   button below, and wait for Meta to approve it.
2. Then either:
   - set the environment variable `AU_WHATSAPP_APPROVED_TEMPLATES` to a
     comma-separated list of the keys (or template names) that are approved, for
     example `AU_WHATSAPP_APPROVED_TEMPLATES=practice_intro,practice_intro_cv`; or
   - set `approved: true` on the row in `lib/au-whatsapp-templates.js`.

Nothing else in the code changes. `lib/au-whatsapp-templates.js` is the only
place that decides whether an Australian WhatsApp may be sent.

## Templates

`{{1}}`, `{{2}}`, ... are the values the app fills in. Category for all:
UTILITY. Language: `en`. WhatsApp business account: the existing one.

| Key | Template name | Purpose | Proposed body | Header | Button | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `practice_intro` | `gp_link_au_practice_candidate_intro` | N10 / P02. Sent to a practice's main contact when staff submit a doctor on an Australian pathway, alongside the introduction email. Used when there is no CV to attach, or when only this one is approved. | Hi {{1}}, GP Link has a GP for your role at {{2}}.<br><br>{{3}}<br><br>Tap below to see their details, then approve and pick interview times, or decline. Please keep this introduction confidential. | none | URL button "Interview or decline" → `https://app.mygplink.com.au/pages/practice-decision.html?token={{1}}` (the same link as the email) | not submitted — owner action |
| `practice_intro_cv` | `gp_link_au_practice_candidate_intro_cv` | The same, with the doctor's CV attached. Used whenever a CV is on file and this one is approved. | Same body as `practice_intro`. | DOCUMENT (the CV, as a PDF). Sample for approval: any one-page sample CV. | Same button as `practice_intro`. | not submitted — owner action |

| `placement_secured` | `gp_link_au_placement_secured` | N11 (WP-11). Sent to a doctor on an Australian pathway when their placement is recorded, alongside the email and the bell item. | Hi {{1}}, congratulations: your placement at {{2}} is secured.<br><br>Your pre-start checklist is in the GP Link app: your start date, a Medicare provider number for the new practice location, your indemnity certificate and your credentialing documents.<br><br>Tap below to open it. Our team will be in touch to help with each step. | none | URL button "Open my checklist" → `https://app.mygplink.com.au/{{1}}` (the app fills `pages/my-documents`) | not submitted — owner action |

What the app puts in the variables of `placement_secured`: `{{1}}` the
doctor's first name, `{{2}}` the practice's name (or "your new practice"). The
fixed words say nothing about registration steps, a move, or where the doctor
trained, and must stay that way: the same template goes to every Australian
segment. Until it is approved the WhatsApp is skipped (the reason is written
on the case's timeline) and the doctor still gets the email and the bell item.

### WP-13: the first-week check-in (N18)

Sent by the daily lifecycle job one week after staff confirm the doctor
started, alongside the emails. Neither has a button. N19 (weeks 4, 8, 12) and
N20 (twelve weeks in) are email only and have no template.

| Key | Template name | Purpose | Proposed body | Header | Button | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `commencement_checkin` | `gp_link_au_first_week_checkin` | N18 to the doctor. | Hi {{1}}, you have finished your first week at {{2}}. We hope it went well.<br><br>How are you settling in? If anything is not as you expected, reply here or message us in the GP Link app and we will help sort it out with the practice. | none | none | not submitted — owner action |
| `commencement_checkin_practice` | `gp_link_au_practice_first_week_checkin` | N18 to the practice's main contact. | Hi {{1}}, {{2}} has now completed the first week at your practice. We hope it has gone well.<br><br>How are they settling in? If anything needs attention, reply here or to our email and we will help. | none | none | not submitted — owner action |

What the app puts in the variables: for `commencement_checkin`, `{{1}}` the
doctor's first name and `{{2}}` the practice's name (or "your new practice");
for `commencement_checkin_practice`, `{{1}}` the contact's name (or "there")
and `{{2}}` the doctor ("Dr Jane Citizen"). The fixed words carry nothing
commercial (no fee, invoice, credit or guarantee wording) and nothing about
where the doctor trained, and must stay that way. Until each is approved its
WhatsApp is skipped with the reason logged (and, for the doctor's, written on
the case's timeline); the emails and the doctor's bell item still go. The
practice WhatsApp is only attempted in the same run as the practice email, so
it cannot go twice.

What the app puts in the variables for both practice templates:

- `{{1}}` the contact's name, or "<practice name> team".
- `{{2}}` the practice's name.
- `{{3}}` the Australian introduction, one paragraph, at most 550 characters.
  Example: "Dr Test Auvr is a vocationally registered GP (FRACGP) based in
  Victoria. GP Link has verified Dr Auvr's Ahpra registration on the public
  register, so there is no registration wait. Dr Auvr is available from
  15 January 2027."
- Button `{{1}}` the decision-link token.

The body's fixed words must stay neutral about where the doctor trained and
must not mention registration timelines or a move to Australia: the same
template carries VR GPs, registrars and doctors with a Medicare billing
restriction, and `{{3}}` says which.

## A possible shortcut (owner decision)

If the wording of the two existing templates (`gp_link_practice_candidate_intro`
and `gp_link_practice_candidate_intro_cv`) turns out to say nothing about where
the doctor trained or about registration, they could carry the Australian
introduction as they are, because only `{{3}}` describes the candidate. Nobody
on the build has seen that wording, so this has not been assumed. To use it,
paste the two approved bodies to the lead; if they are neutral, the two
`templateName` values in `lib/au-whatsapp-templates.js` are pointed at the
existing names and marked approved.
