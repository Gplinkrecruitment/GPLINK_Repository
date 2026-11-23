# Ads and tracking for the Australian campaign: what to set up, and where

Written by WP-24. **Nothing in this file has been done.** The build made no
change in Meta Ads Manager, Business Manager, Events Manager, Google Ads,
Google Tag Manager or Google Analytics, called none of their APIs, and sent no
conversion event. Everything below is for the owner (or a later session with
the owner's go-ahead) to do by hand.

Until these steps are done the app behaves like this, with the Australian
switch on:

- An Australian-segment lead sends **nothing** to Meta or Google. It does not
  feed the UK campaign's "qualified GP" signal.
- A UK (or other overseas) lead sends exactly what it sends today.
- The ads hub shows the Australian campaign as "Not set up yet", with the
  app's own lead numbers, and offers no change to make.

The steps are independent. You can do Meta without Google, or the conversion
feed before the campaign exists. Each ends with the setting to add in Vercel
(Project → Settings → Environment Variables → Production), and the next page
load picks it up. No redeploy is needed for the ads hub; a redeploy is the
safe way to be sure every function sees a new variable.

## 0. Before any of it

1. Read and approve the Australian ad brief:
   `docs/au-gp/ads-au-house-context.md` (owner action 95). The app will not
   write a review or any ad copy for the Australian campaign until you set
   `ADS_AU_HOUSE_CONTEXT_APPROVED=true`.
2. Decide whether Australian ads may say "free for doctors". The brief flags
   it. Until you set `ADS_AU_FREE_FOR_DOCTORS_APPROVED=true` the model is told
   not to say it and any ad idea that does is thrown away.
3. Legal review of two things (see `docs/au-gp/legal-draft/attribution-cookie-note.md`):
   the attribution cookie, and the Meta Pixel and Google tag now also loading
   on the sign-in and onboarding pages. The live privacy policy says these
   tools are on "our public marketing pages" only.
4. In Meta Events Manager → the pixel (`2269935553370606`) → Settings, check
   **Automatic advanced matching**. If it is on, Meta's script may read form
   fields (email, phone) on any page it loads on and send them hashed. The app
   switches off the pixel's automatic button and form scanning on the sign-in
   and onboarding pages (`autoConfig` off), but that setting is controlled in
   Events Manager, so the safe position is: turn automatic advanced matching
   **off** for this pixel before the Australian switch goes on in production,
   or get legal sign-off to leave it on.

## 1. Meta: a separate dataset for Australian conversions

Why separate: the UK ad set learns from the existing dataset and gets about one
"qualified" event a week. Anything else landing in that dataset, under any
name, changes what Meta sees there. A second dataset leaves the UK one exactly
as it is.

1. Events Manager → **Connect data sources** → **CRM** (the same kind as the
   existing one: "Conversions API for CRM") → name it
   `GP Link CRM: Australian GPs`.
2. Give the existing system user access to the new dataset: Business Settings
   → Users → System users → the GP Link system user → Add assets → Datasets →
   the new one → full control. Then the existing token works for it. (If you
   would rather use a separate token, generate one for this dataset.)
3. Copy the new dataset's id (a long number).
4. In Vercel add:
   - `META_AU_CAPI_DATASET_ID` = that number
   - `META_AU_CAPI_ACCESS_TOKEN` = only if you made a separate token;
     otherwise leave it out and the existing `META_CAPI_ACCESS_TOKEN` is used
   - optional, for the first test: `META_AU_CAPI_TEST_EVENT_CODE` = the code
     from Events Manager → Test events. Remove it afterwards.
5. The app refuses to use the same number as `META_CAPI_DATASET_ID`. If the
   two are equal, nothing is sent for Australian leads and the hub says so.
6. In the new dataset's funnel settings, map the stages. The app sends these
   event names for an Australian-segment lead that came from a Meta lead form:

   | The app sends | Meaning |
   | --- | --- |
   | `au_lead` | every Australian lead stored |
   | `au_qualified_gp` | they said they are registered with Ahpra |
   | `au_call_booked` | they booked a call |
   | `au_signed_up` | they created an account |

   Each carries the Meta lead id and the hashed email and phone, exactly as
   the existing feed does. Nothing else about the doctor is sent.

## 2. Meta: the Australian lead form and campaign

1. Create the instant form from `docs/au-gp/meta-au-lead-form.md` (the five
   questions, in that wording).
2. Copy the form's id. In Vercel add it to **both**:
   - `FB_AU_GP_LEAD_FORM_IDS` (a comma-separated list): this is what tells the
     app a lead is Australian-segment, and which campaign it came from.
   - `META_AU_LEAD_FORM_ID` (optional, one id): the form the hub lists for the
     campaign. If left out, the first id in the list is used.
   Do not put the same id in `FB_GP_LEAD_FORM_IDS`: a form in both lists is
   treated as overseas and an error is logged for every lead.
3. Create the campaign in Ads Manager. Suggested: objective Leads, the
   Employment special ad category (Australia), one ad set, the new form, the
   optimisation event from the **new** dataset (`au_qualified_gp` once it has
   events; plain leads until then). The destination for the website link is
   `https://www.mygplink.com.au/australian-gps`.
4. Website-click ads for this campaign should carry these on the link:
   `utm_source=facebook&utm_medium=paid&utm_campaign=au_<anything>`.
   A paid click that lands on `/australian-gps`, or whose campaign tag starts
   with `au_`, is counted under the Australian campaign. ("Paid" means the
   link carried Meta's or Google's click id, `utm_medium=paid` or `cpc`, or
   the site's own marker `src=fb`. A visit with none of those is never counted
   under a campaign.) (To use other tags,
   list their beginnings in `META_ADS_AU_UTM_CAMPAIGNS`, comma-separated.)
5. Copy the campaign id and the ad set id. In Vercel add:
   - `META_ADS_AU_CAMPAIGN_ID`
   - `META_ADS_AU_DEFAULT_ADSET_ID`
   From then the hub reads this campaign from Meta every morning and shows it
   in its own panel.
6. Optional limits for this campaign only (otherwise it uses the same ones as
   the UK campaign):
   - `ADS_AU_MAX_DAILY_BUDGET` (dollars a day per ad set; default 300)
   - `ADS_AU_MIN_LIVE_ADS` (default 1: a pause may never empty an ad set)

What the hub can do for the Australian campaign once it exists: pause or
resume an ad or an ad set, and change an ad set's daily budget, each ticked by
you and checked against the live account first. It does **not** write,
photograph or launch new Australian ads: ad ideas are shown as text only.

## 3. Meta pixel on the website for Australian visitors (optional)

Today the booking form reports "Lead" and "Schedule" to the existing pixel.
With the switch on, a doctor who answers "Yes, registered with Ahpra" no
longer sends those (they would count as UK results). To measure Australian
bookings on the website:

1. Events Manager → create a second pixel/dataset for the website, e.g.
   `GP Link website: Australian GPs` (or reuse the dataset from step 1 if you
   chose a dataset that accepts website events).
2. In Vercel add `META_AU_PIXEL_ID` = its id.
3. From then an Australian-segment doctor's form submission and booking send
   `Lead` and `Schedule` to that pixel only, each carrying one word
   (`segment: australian`).

## 4. Google Ads: a separate conversion for Australian bookings

Today one conversion exists: "Book appointment"
(`AW-18582515388/jRZnCJmY7bodELzd6pxF`), fired from the booking form when a
call is confirmed. With the switch on an Australian-segment doctor no longer
fires it.

1. Google Ads (account 534-261-0544) → Goals → Conversions → **New conversion
   action** → Website → category "Book appointment" → name
   `Book appointment: Australian GPs` → count One → set it up **manually with
   the Google tag** (not by URL).
2. Google shows an event snippet containing `send_to: 'AW-18582515388/XXXX'`.
   Copy that whole value (`AW-…/…`).
3. In Vercel add `GOOGLE_ADS_AU_CONVERSION_SEND_TO` = that value.
4. Make this new conversion the goal of the Australian campaigns only, and
   leave the existing one as the goal of the UK campaigns. (In each campaign:
   Settings → Goals → use campaign-specific goals.)
5. Nothing is needed in Google Tag Manager: the container
   (`GTM-WNH5QC74`) is already on the pages and the conversion is sent by the
   page itself. The three Google search campaigns built earlier stay paused
   and are not touched by any of this.

Two data-layer events are also pushed on the sign-in and onboarding pages
(switch on, real domain only): `gp_sign_up_completed` and
`gp_onboarding_completed`, each with `gp_segment` = `australian` or
`overseas`. They do nothing until someone builds a tag for them in Tag
Manager. If you want Google conversions for sign-ups, create a Custom Event
trigger for the event name and a Google Ads conversion tag firing on it, with
a condition on `gp_segment` so the two audiences stay apart.

## 5. Check it worked

1. Events Manager → the new dataset → Test events (with the test code set):
   submit a test lead through the Australian form. You should see `au_lead`
   and `au_qualified_gp`, and **nothing new** in the existing dataset.
2. CEO dashboard → Social → Ads: the "Australian GPs" panel should read
   "Set up", show the ads in the campaign, and count that lead once. The
   "Overseas GPs (UK)" panel should not count it.
3. CEO dashboard → Leads: the lead shows "Australian GPs (Meta lead form)".
4. Remove `META_AU_CAPI_TEST_EVENT_CODE`.

## Every setting, in one table

| Variable | What it does | Unset means |
| --- | --- | --- |
| `META_AU_CAPI_DATASET_ID` | The Australian dataset for conversion events | Australian leads send nothing to Meta |
| `META_AU_CAPI_ACCESS_TOKEN` | A token for it, if different | The existing token is used |
| `META_AU_CAPI_TEST_EVENT_CODE` | Test mode for the Australian dataset | Live |
| `FB_AU_GP_LEAD_FORM_IDS` | Which Meta forms are Australian (WP-15) | No Meta lead is Australian by form |
| `META_AU_LEAD_FORM_ID` | The form the hub lists for the campaign | First id of the list above |
| `META_ADS_AU_CAMPAIGN_ID` | The Australian campaign in the ad account | Hub says "Not set up yet"; no reads, no changes |
| `META_ADS_AU_DEFAULT_ADSET_ID` | Its ad set | none |
| `META_ADS_AU_UTM_CAMPAIGNS` | Beginnings of campaign tags that mean "Australian" | `au_` |
| `META_ADS_UK_UTM_CAMPAIGNS` | The same for the UK campaign | none (the landing page decides) |
| `ADS_AU_HOUSE_CONTEXT_APPROVED` | `true` once the brief is approved | No review, no ad copy for the Australian campaign |
| `ADS_AU_FREE_FOR_DOCTORS_APPROVED` | `true` to allow "free for doctors" | The claim is refused |
| `ADS_AU_MAX_DAILY_BUDGET`, `ADS_AU_MIN_LIVE_ADS` | This campaign's own ceiling and floor | Same as the UK campaign's |
| `META_AU_PIXEL_ID` | Website pixel for Australian bookings | Australian bookings send no pixel event |
| `GOOGLE_ADS_AU_CONVERSION_SEND_TO` | Google conversion for Australian bookings (`AW-…/…`) | Australian bookings send no Google conversion |
