# Proposed Meta lead form for Australian GPs

**PROPOSAL. NOTHING HERE EXISTS IN META.** Written by WP-15 on 21 November
2026. No form was created or edited, no ad was touched, and no setting was
changed in Vercel. This file is what the owner would build by hand in Ads
Manager, and the one setting to add afterwards.

## In short

- Today every Facebook and Instagram lead form sends its leads through one
  list, `FB_GP_LEAD_FORM_IDS`. The app treats them all as doctors moving to
  Australia.
- WP-15 adds a second list, **`FB_AU_GP_LEAD_FORM_IDS`**. A lead from a form on
  that list is tagged as an Australian GP, is never rung by Hazel, and (with
  the Australian switch on) does not get the emails written for a doctor moving
  country. The owner is still alerted straight away, with the segment, state
  and VR status in the alert.
- If the form asks "Are you currently registered with Ahpra?" and the doctor
  says yes, they qualify whatever country they trained in.

## The form to build (Ads Manager → Lead forms → Create)

| Setting | Value |
| --- | --- |
| Form name | `GP Link — Australian GP enquiry` |
| Form type | Higher intent (the same as the current form) |
| Privacy policy link | `https://www.mygplink.com.au/pages/privacy` |
| "Allow retrieval of untargeted leads" | **Yes**. With this set to No the app can never read some leads (this has cost three days before: handover of 19 August, section 3a). |
| Thank-you screen button | Link to `https://www.mygplink.com.au/start?src=fb&seg=au#book` (`seg=au` opens the booking form already answered "Yes"). When WP-21's Australian landing page exists, point it there instead. |

### Contact fields (Meta's own, pre-filled)

Full name, Email, Phone number. Mark phone as required.

### Questions, in this order (all multiple choice)

Type the wording exactly. Meta turns each question and each answer into a
hidden code (lower case, spaces become underscores), and that code is what the
app reads. The app looks for the words in **bold**, so keep them.

| # | Question | Answers |
| --- | --- | --- |
| 1 | Are you currently registered with **Ahpra**? | Yes / No |
| 2 | **Which state** or territory are you in? | New South Wales / Victoria / Queensland / Western Australia / South Australia / Tasmania / Australian Capital Territory / Northern Territory / Outside Australia at the moment |
| 3 | Are you a **vocationally registered** GP (FRACGP or FACRRM)? | Yes / No / I'm a GP registrar / Not sure |
| 4 | Does the **19AB** moratorium apply to you? | Yes / No / Not sure |
| 5 | What is your **right to work** in Australia? | Australian citizen or permanent resident / Temporary / Not sure |
| 6 (optional) | Anything you'd like us to cover on the call? | Short answer |

Keep question 1. Questions 2 to 5 can be dropped to make the form shorter: a
lead who answers only question 1 is still qualified and tagged, as
"Australian GP: details to confirm". Do **not** add "Where did you complete
your GP training?" to this form: it decides nothing for a doctor who is
already registered here.

Do not use the words the build bans for an Australian doctor in the form's
headline, description or thank-you screen (AGENT-RULES section 4): nothing
about a visa, relocating, "your move", or being trained overseas.

### What the app does with each answer

| Answer | Result |
| --- | --- |
| Question 1 "Yes" | Qualified. Tagged Australian. Never shown the "we can't take this one on" screen. |
| Question 1 "No" | Treated exactly like a lead from today's form: where they trained decides. |
| Question 1 missing or unreadable | Tagged "Australian GP: details to confirm" because of the form it came from. Not turned away on training country. If nothing else qualifies them, the owner's alert is headed "Check this lead". |
| VR "Yes", 19AB "No", citizen or permanent resident | Australian GP, vocationally registered (segment A) |
| 19AB "Yes", or a temporary right to work | Australian GP, restricted (segment B) |
| "I'm a GP registrar" | Australian GP, registrar (segment C) |
| VR "No" | Australian GP, not vocationally registered (segment C) |
| Any "Not sure" | Australian GP, details to confirm |

The segment is the doctor's own description. It is used for the wording of
messages, reporting and the Hazel block. It never sets the doctor's pathway in
the app: that happens when they finish onboarding, or when staff set it.

## The setting to add (Vercel → Environment Variables, Production)

```
FB_AU_GP_LEAD_FORM_IDS=<the new form's id>
```

- Several forms: separate the ids with commas.
- Do **not** also add the id to `FB_GP_LEAD_FORM_IDS`. A form on both lists is
  treated as a mistake: the app handles its leads as overseas leads and writes
  `CONFIGURATION ERROR` to the server log on every lead until it is fixed.
- Add the id **before** the first ad using the form goes live. A form on
  neither list is not recognised as a doctor's form.
- The Australian tagging only happens when the Australian switch
  (`AU_PATHWAY_ENABLED`) is on. With the switch off, a lead from the new form
  is still saved as a doctor's lead and the owner is still alerted, but it is
  handled like a lead from today's form (training country decides, no segment
  recorded). So: turn the switch on before spending on Australian ads.

## Consent on the form (for the lawyer, not yet decided)

The website booking form shows an Australian consent line (the draft in
`legal-draft/consent-wording.md`, section A1). A Meta form shows only what is
typed into it. If the lawyer confirms that wording, add it to this form as a
custom disclaimer. No AI-call consent is proposed here: Hazel does not ring
Australian leads.

## Checked how

The reading of each answer is tested (`tests/au-wp15-lead-segment-lib.test.js`,
`tests/au-wp15-lead-server.test.js`) using the wording above turned into Meta's
codes the way Meta is known to do it (the live overseas form's stored leads
show the pattern). **No real lead from this form exists**, so the exact codes
Meta produces for these questions have not been seen. After the first real
lead arrives, check its alert email shows the segment, state and VR status. If
one is missing, the question's wording differs from the above: tell the
developer the exact wording used.
