# Australian-GP website content: what is built and what is waiting

Written by WP-21 (22 November 2026). The review report lists five kinds of
page "with no equivalent today". This file says what was built, what was
deliberately not, and gives an outline for each page still to write.

Every page here is an Australian-only page: it is added to
`AU_ONLY_SITE_ROUTES` in `lib/site-au-pages.js`, exists only with the
Australian switch on, and keeps the rules in `docs/au-gp/CONVENTIONS.md`
section 34 (none of the AGENT-RULES section 4 words, no dollar figures, no
percentages, no earnings claims, nothing invented).

## Built

| Page | Address | Notes |
| --- | --- | --- |
| Australian GP landing page | `/australian-gps` | The form and booking step are on the page. |
| Changing practices: notice periods and restraint clauses | `/australian-gps/changing-practices` | General information, not legal advice. Mirrors the in-app article (`js/support-au.js`, `au5`) and the confidentiality article (`au2`). If the in-app wording changes, change this page too. |

## Not built, and why

### 1. 19AB, DPA and the moratorium: what it means for where you can work

**Not built.** It could not be written honestly within the build's rules:

- The rules are recorded as **unconfirmed** for this build (AGENT-RULES
  section 3, decision 2). An explainer has to state what the rules are.
- Section 19AB is defined by where a doctor trained. The plain description
  uses a word an Australian doctor must never be shown (AGENT-RULES section
  4). A page that avoids the word cannot say who the section applies to.

What the site does instead: the landing page says "If anything limits where
you can work, we go through your position with you before we suggest a
practice", and the booking form asks whether the 19AB moratorium applies, with
"Not sure" as an accepted answer.

**To build it, the owner needs to supply or confirm:**

1. A decision on the wording rule: may this one page name who 19AB applies to?
2. The confirmed facts, each with its official source (Department of Health,
   Disability and Ageing; Services Australia): what 19AB restricts; how long
   the moratorium lasts and what shortens it; what a Distribution Priority Area
   is and how often the classification is reviewed; how the Modified Monash
   Model relates to it; what an exemption is and who applies for it; what
   changes for a doctor who is a permanent resident or citizen.
3. Who signs the page off (a registered migration agent or a lawyer, if any
   statement touches a doctor's right to work).

**Proposed outline** (address: `/australian-gps/19ab-dpa-moratorium`)

1. "This is general information. The rules depend on your individual
   circumstances, and we confirm your position with you before we suggest a
   practice."
2. Three terms in one sentence each (19AB, DPA, the moratorium), each linked
   to the official page.
3. "Does it apply to me?": the questions that decide it, with "check the
   official tool" links, and no worked answers.
4. What it changes about where you can work, in general terms.
5. What does not change: your registration, your choice of whether to apply.
6. How GP Link handles it: we ask, we check with you, we only show roles you
   can take up (the app already fails closed on an unknown answer).
7. Book a confidential call.

### 2. Pages for vocationally registered GPs by state or city

**Not built.** All open roles today are in Distribution Priority Areas, and
the owner is still signing metropolitan practices (owner decision 11). A page
called "GP jobs in Sydney" would promise roles that do not exist.

**Build when** there are approved open roles in the place the page names.

**Proposed outline** (address: `/australian-gps/<state>`, for example
`/australian-gps/nsw`)

1. Hero: "GP roles in <state> for Ahpra-registered GPs", the confidentiality
   promise.
2. The open roles in that state, read live from the job board (never a typed
   number; if there are none, the page says so and offers the call).
3. What practices in that state are offering (billing models as labels only:
   bulk, mixed, private).
4. How it works (the six steps from the landing page).
5. The booking form (`<!--au:use site-start.html#booking-script-->`, as on the
   landing page).

### 3. Billing and earnings guide

**Not built.** The build's rule is no dollar figures, no percentages and no
earnings claims for an Australian audience (owner decision 9). A billing
guide without them is a glossary; with them it needs the owner's figures and
a view on how they may be advertised.

**Owner decision needed:** may the site publish billing percentages or
earnings ranges at all? If yes: the source for each figure, the date, and the
wording review.

**Proposed outline, safe version** (address: `/australian-gps/billing-models`)

1. Bulk billing, mixed billing and private billing: what each means for how a
   day runs (no figures).
2. What to ask a practice about its billing arrangement (the questions, not
   the answers): what the service fee covers, how it is calculated, when it is
   paid, what happens in the first months.
3. What we will tell you about a role before you apply (the billing model).
4. "Your own accountant or adviser is the person to ask about what an
   arrangement means for you."
5. Book a confidential call.

### 4. Non-VR doctors and GP registrars

**Not built.** Those segments are built in the app but not launched (owner
decision 1), and non-VR placements are off by default (decision 5). The
landing page carries the one truthful line: "Tell us your situation and we
will be straight about what we can do."

**Build when** the owner launches either segment.

**Proposed outline** (address: `/australian-gps/non-vr-and-registrars`)

1. Who this page is for, in their own words.
2. What we can do today, stated plainly, including "nothing yet" where true.
3. What we need to know from you (the same questions the form asks).
4. What happens next, and how long we will take to come back to you.
5. Book a call, or leave your details to be told when this opens.

### 5. Stories from Australian GPs and practices (WEB-22)

**Not built: there is no real content.** The landing page has an empty, hidden
slot (`<section class="block au-proof" id="proof" data-au-proof-slot hidden>`)
with the rule written beside it. Nothing may be invented.

**Owner supplies:** a first-name-and-suburb quote from a placed Australian GP
with their written permission; a quote from a practice that has hired one,
with permission; any count only once it is true and has a date.

## Also waiting on a decision

- **The phone picture on The app page** still shows the pathway of a doctor
  moving country (the steps and the "Your move to Australia" line). The page
  now says who that section is for, but a second picture for an Australian GP
  needs a design decision.
- **The blog** is written for doctors moving country. It has no Australian
  articles. The two guides above could be published there once it does.
