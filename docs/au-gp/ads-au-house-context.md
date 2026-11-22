# Australian house context for the ads prompts: DRAFT for WP-24

**Status: DRAFT. Not wired to anything.** Written by WP-20 for WP-24 (the
multi-campaign ads hub) to wire. WP-20 did not change `lib/ads-review.js` or
`lib/ads-context.js`: today both still describe one advertiser brief, "an
Australian recruitment agency placing UK-trained GPs in Australian practices"
(`lib/ads-review.js:29`), and every example in them is a UK example. Nothing in
this file has been sent to a model, and no ad has been written from it.

**The owner must read and approve this text before WP-24 wires it.** Each claim
below says where it comes from. Where the source is a draft or an owner
decision that is still open, it says so.

## How WP-24 should use it

- One house context per campaign audience. The existing UK brief stays exactly
  as it is for the UK campaigns. This text is the brief for a campaign aimed at
  GPs already registered and working in Australia.
- Select by the campaign's audience, never by guessing from an ad's wording.
  A campaign with no audience recorded is a UK campaign (the same rule as a
  doctor with no pathway recorded).
- Keep the claims list in one place (as `lib/au-placement-fees.js` does for
  fees), so a claim is corrected once.
- Run generated copy through a server-side check before it can be launched
  (`lib/au-doctor-text.js` `violations`, plus the money check below). A prompt
  is an instruction, and a model can ignore an instruction: WP-20's rule
  (`docs/au-gp/CONVENTIONS.md` section 33).
- Hazel does not ring Australian leads (owner decision 7), so the "what happens
  after the form" section of `lib/ads-context.js` is wrong for this audience
  and must not be reused. The Australian sequence is in
  `docs/au-gp/au-lead-copy.md` (WP-16).

## The text (as the model would be given it)

```
Advertiser: GP Link, an Australian GP recruitment agency.

Audience for this campaign: GPs who are ALREADY registered with Ahpra and
working in Australia, and who are thinking about changing practice. Most are
vocationally registered (FRACGP or FACRRM). They are not moving country. They
have a job now, and their employer does not know they are looking.

What GP Link does for them: finds them a better-fitting practice, arranges the
interviews, and handles the paperwork between accepting an offer and the first
day (the start date, the provider number for the new location, indemnity,
the practice's credentialing).

Tone: one GP talking to another. Calm, specific, unhurried. No hype, no
exclamation marks, no urgency. Australian spelling. "GP", never "physician".

What an ad may say:
- That a conversation is confidential and their current employer is not told.
- That GP Link only puts them forward to a practice they have agreed to.
- What kinds of things can be different at another practice: the billing model
  (bulk, mixed or private billing), the mix of sessions, the patient list, the
  team, the location, the commute. Name the kind of thing, never a number.
- That the service is free for doctors (see "Claims and their sources").
- That the first step is a short call with a person.

What an ad must never say:
- Any pay figure: no dollar amount, no percentage, no billing split, no
  "earn more", no income comparison, no "up to".
- Any guarantee: of a job, an offer, an interview, a start date, higher
  earnings, or a time frame.
- Anything that frames the reader as coming from somewhere else: no "overseas",
  "international", "internationally trained", "relocate", "relocation", "your
  move", "moving to Australia", "visa", "sponsorship", "registration support",
  "MyIntealth", "AMC", "GMC", "NHS" or "UK".
- Anything about 19AB, the moratorium, Distribution Priority Areas, conditions
  on registration, or supervision. Those are individual and are discussed on
  the call, never advertised.
- The name of any practice, or anything that identifies one.
- Anything negative about the reader's current employer or about a named
  practice group.
- That GP Link is a regulator, a college or a government service, or that it
  can speed up anything Ahpra, a college or Services Australia does.

The photograph: one GP, in an Australian general practice or an Australian
everyday setting, in an ordinary moment. Never an airport, a suitcase, a
passport, a flag, a map, or anything that reads as arriving in the country.
```

## Claims and their sources

| Claim | May it be used? | Source |
| --- | --- | --- |
| "Free for doctors" | **Yes, with the owner's confirmation.** The practice pays GP Link's fee, and nothing charges the doctor. | The signed practice agreement charges the practice a placement fee and no one else (`assets/legal/src/agreement-2026.html:182-185` the fee tiers, `:381` "fee if one of our candidates ... obtains a position with you"). The live site already says "GP Link is free for doctors, always" (`pages/site-faq.html:141`, `pages/site-about.html:148`), written for doctors moving country. The doctor-facing terms that would say it to an Australian GP in so many words are still a **draft** awaiting legal review (`docs/au-gp/legal-draft/terms-draft.html:257`). Until those terms are live the claim rests on the practice agreement and the existing site wording. |
| "Confidential: your employer is not told" | Yes. | The app never tells a practice where a doctor works now (`lib/career-intro.js` `auIntroFactsFromRecords`: never the suburb, postcode or current practice) and a profile goes to a practice only with the doctor's consent for that role (`lib/profile-share-consent.js`, WP-09). |
| "We only put you forward where you agree" | Yes. | The per-practice consent gate (WP-09, `docs/au-gp/CONVENTIONS.md` section 20). |
| Billing model named (bulk, mixed, private) | Yes, the model only. | Owner decision 9 (`docs/au-gp/AGENT-RULES.md` section 3). |
| Any dollar figure or percentage | **No.** | Owner decision 9. |
| Any guarantee of a job, offer or earnings | **No.** | Not supported by anything GP Link has agreed. (The "guarantee period" in the practice agreement is a commercial term between GP Link and the practice about a replacement or credit: it is not a promise to a doctor and must never appear in an ad.) |
| "No registration wait" | **Not in an ad.** | True only for an individual doctor whose registration staff have checked (`lib/career-intro.js`: verified, confirmed `au_vr`, no flag, no supervision). An ad cannot know that about its reader. |
| Anything about 19AB / DPA | **No.** | Regulatory rules are unconfirmed (`docs/au-gp/AGENT-RULES.md` section 3, decision 2). |
| A call with Hazel, or "we will ring you" by an AI caller | **No.** | Owner decision 7: Hazel never rings Australian leads. |

## The check to run on generated copy

Reject a draft (do not launch it; show the reason to the owner) when any of
these is true:

1. `require('./lib/au-doctor-text.js').violations(text)` is not empty (the
   words in AGENT-RULES section 4).
2. It contains `$`, `%`, "per cent", a figure such as "300k", a split such as
   "70/30", or the words salary, income, earnings, earn, pay rise, guarantee
   or guaranteed. (`lib/ai-candidate-job-match.js` `sanitiseAuMatchReasons`
   already implements the money half of this for match reasons: reuse its
   pattern rather than writing a second one.)
3. It contains "UK", "NHS", "19AB", "moratorium" or "DPA".

## What WP-24 still has to decide (not decided here)

- Where an Australian campaign's leads land: the `/start` form's first question
  already separates the two audiences (WP-15), and the Meta lead form draft is
  `docs/au-gp/meta-au-lead-form.md`.
- Which states to target and when (call windows by Australian state are
  WP-19's, and Hazel is not used).
- Whether the daily review's benchmarks (cost per lead, cost per booking) are
  kept per audience. They should be: an Australian campaign compared with UK
  numbers will be judged wrongly.
