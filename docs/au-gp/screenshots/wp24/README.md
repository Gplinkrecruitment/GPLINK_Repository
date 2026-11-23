# WP-24: the local-stack walk (23 Nov 2026)

Run on the local test stack (`docs/au-gp/LOCAL-STACK.md`), Australian switch
on, in headless Chrome with `calendly.com` mapped to nowhere. Every identity is
fake (`…@gplink-test.local`). Nothing left the machine: `blocked-outbound.log`
stayed empty, and the browser made no request to Meta or Google (the pixel and
Google tag load only on the real domain).

## What was done, and what came back

| Step | Result |
| --- | --- |
| Opened `/australian-gps?utm_source=test&utm_campaign=au_test&fbclid=FAKE` | Cookie `gp_attr` written: first and last touch `{ utm_source: test, utm_campaign: au_test, fbclid: FAKE, landing_page: /australian-gps }`. Unchanged after an ordinary click to `/faq`. |
| Filled the form on that page (first answer already "Yes"; WA, vocationally registered, 19AB no, citizen) and submitted | Lead stored, segment `au_vr`, `metadata.attribution` = that first and last touch. Booking step shown. |
| What the page would ask Meta and Google to record for that doctor | Nothing (`[]` for the lead event and for the Google conversion): no Australian event is configured. |
| Opened the sign-up link `/pages/signin?signup=1&email=…` | On this host: nothing loads ("not the real domain"). On the real domain the page view would be reported as `/pages/signin?signup=1`, the email removed first. |
| Signed up from the same browser (the real sign-up endpoint) | Account created. `runtime_kv` row `signup_attribution:<user id>` holds the same first and last touch, `campaign: au_gp`, `segment: australian`. Flag cookie `gp_signup_evt=australian`. |
| Opened onboarding | No pixel, no Google tag on this host. On the real domain "sign-up completed" would carry `segment: australian` and nothing else. |
| Opened `/start?src=fb&utm_campaign=uk_test` in a second, clean browser; answered "No", UK; submitted | Lead stored, segment `overseas`, `metadata.utm = { utm_campaign: uk_test }` (as today) and `metadata.attribution` = `{ src: fb, utm_campaign: uk_test, landing_page: /start }`. |
| What the page would ask Meta and Google to record for that doctor | Exactly today's: `fbq('track','Lead')` and the existing Google conversion. |
| Posted a fake UK Meta-form lead at the local webhook | One trapped request: `POST graph.facebook.com/v26.0/000000000000000/events` with `lead` and `qualified_gp` (the local stack's fake dataset; hashed email and phone, the lead id). |
| Posted a fake Australian Meta-form lead | **No** request to Meta. App log: "nothing sent for Australian-segment lead … (au_not_configured): it does not feed the overseas campaign". |
| Ran the hourly sweep (`run-cron.sh meta-lead-stages`) | No further request to Meta. |
| Signed in as `ceo@gplink-test.local`, opened Social → Ads | `08-ads-hub-two-campaigns.jpg`, `09-ads-hub-full-page.jpg`. Two panels. "Overseas GPs (UK)": 1 lead (the UK Meta-form lead), plus 1 website enquiry from its ads shown beside. "Australian GPs": **Not set up yet**, 4 leads (1 Meta form, 3 website enquiries from tagged links: the walk was run three times), conversions "not configured: nothing is sent". |
| Asked the app to apply a change for the Australian campaign | Refused (409): "The Australian campaign is not set up yet. Nothing was changed." |
| Opened Leads | `10-leads-tab-campaign-labels.jpg`. Each lead says where it came from: "Australian GPs (Meta lead form)", "Overseas GPs (UK) (Meta lead form)", "Australian GPs (Meta ad)", "Overseas GPs (UK) (Meta ad)", and "Direct / unknown" for a lead with no evidence. |

## Found on the walk and fixed

- The campaign panels were drawn white on the dashboard's dark theme and could
  not be read. They now use the page's own card style.
- A visit to `/start?src=fb&utm_campaign=uk_test` was labelled "Direct /
  unknown": a campaign tag by itself is not evidence of an ad. The site's own
  ad marker `src=fb` (the link the existing ads use) is now kept and counts.
- The UK panel now shows, beside its usual numbers, the website enquiries that
  came from its ads.
- The local stack had no Meta lead-form ids, so no lead could be posted at its
  webhook. Two made-up ids were added to the local stack's settings only.

## Not shown here

No screenshot of the website pages is kept: WP-24 changed nothing a visitor
can see on them. The Australian campaign as "set up" (its own review, the net,
its account changes) cannot be shown on the local stack (it has no way to hold
a Meta campaign); it is exercised in `tests/au-wp24-acceptance.test.js`.
