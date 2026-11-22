# Addendum for the privacy draft: the attribution cookie, and tracking on sign-in and onboarding

Written by WP-24. **For legal review. Nothing here is live**: all of it sits
behind the Australian switch, which is off in production. The draft policy
(`privacy-policy-draft.html`) was not edited; these are the points it needs to
cover before the switch goes on.

## 1. A new first-party cookie: `gp_attr`

| | |
| --- | --- |
| Set by | GP Link's own script (`js/site-attribution.js`) on the public website pages. Not set by, or shared with, any third party. |
| When | With the Australian switch on only. |
| Purpose | To know which advertisement or campaign brought a visitor, so that a later enquiry or account can be counted against the right campaign. |
| What it holds | For the visitor's **first** visit and their **latest** tagged or referred visit: the campaign tags on the address (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`), the click identifiers an ad platform adds (`fbclid`, `gclid`), the page they landed on (the path only, never the query string), the site they came from (the host name only), and the time. |
| What it never holds | A name, email address, phone number, registration number, any answer from a form, a sign-in or booking link, or any other part of the address. Only the listed parameters are read. A tag containing an "@" is discarded. Every value is shortened to a fixed length. |
| Lifetime | 90 days from the last time it was written. |
| Scope | The website and the app (`.mygplink.com.au`), so what was noted on the website is still there when an account is created. `SameSite=Lax`, `Secure`. |
| Where it goes | Nowhere by itself. When the visitor submits the enquiry form, or creates an account, the server reads it, checks every value again, and stores the result on that enquiry (`site_enquiries.metadata.attribution`) or beside that account (`runtime_kv`, key `signup_attribution:<user id>`). |
| Who sees it | GP Link staff with access to the owner's dashboard (the Leads tab and the Ads tab show which campaign a lead came from). It is not sent to Meta, Google or anyone else. |

Points for review:

- `fbclid` and `gclid` are identifiers issued by Meta and Google for a click on
  an advertisement. They are stored as received and are not sent back to
  either company by this build. If a later build uploads conversions to
  Google or Meta using them, that is a new disclosure.
- The stored record has no retention rule of its own: it lives as long as the
  enquiry or the account it is attached to. The data-retention section of the
  policy should say so, or a period should be set.
- There is no cookie banner or consent tool on the website today, for this
  cookie or for the Meta Pixel and Google tag already in use. This build did
  not add one. Whether one is needed for an Australian and a UK audience is a
  question for legal review.

## 2. The Meta Pixel and Google tag on two more pages

The live policy says these tools run on "our public marketing pages". With the
Australian switch on they also load on the **sign-in / sign-up page** and the
**onboarding pages**, on the real domain only.

What they are sent from those pages:

- A page view, with the page address. Before either tool loads, the address is
  checked: an email address in it (the prefill on the sign-up link) is removed
  from the address bar, and if the address carries a sign-in link, a recovery
  link, or any parameter not on a short fixed list, **neither tool loads** for
  that page view.
- At most two further events, "sign-up completed" and "onboarding completed",
  each carrying one fixed word: `australian` or `overseas`.

What they are never sent by this build: an email address, phone number, name,
registration number, password, or any answer given in onboarding.

Points for review:

- The Meta Pixel has a setting in Meta's Events Manager, "Automatic advanced
  matching", under which Meta's own script can read form fields on a page and
  send them hashed. The build switches off the pixel's automatic scanning on
  these two pages, but the setting is controlled in Meta's console. It should
  be confirmed **off** before these pages go live with the pixel, or the
  policy must disclose it (owner action WP-24-d).
- Both tools set their own cookies (`_fbp`, `_gcl_au` and similar) as they do
  on the marketing pages today. The policy's cookie section should name the
  sign-in and onboarding pages.
- The signed-in app itself (everything after onboarding) carries no
  advertising tool, before or after this build.

## 3. Conversion events to Meta for Australian leads

Unchanged in kind from what the policy already covers for overseas leads (the
"Conversions API": the Meta lead id, and the hashed email and phone, with the
stage reached). New: for an Australian-segment lead these go to a **separate**
Meta dataset, and only once the owner has created it. Until then nothing is
sent to Meta about an Australian-segment lead.
