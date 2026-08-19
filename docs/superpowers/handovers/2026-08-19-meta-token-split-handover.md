# Handover — split `FB_PAGE_ACCESS_TOKEN` into two credentials

**Written 2026-08-19.** Status: **NOT STARTED.** The incident that motivates it is
**resolved**; this is hardening so it cannot happen a third time.

Read §1 and §2 before touching anything. §3 is the history — read it before you
diagnose any "Facebook leads are being DROPPED" email, because the obvious
reading of that alert has now been wrong twice.

---

## 1. The defect, in one paragraph

`FB_PAGE_ACCESS_TOKEN` is **one environment variable read by two unrelated
features that need different Meta permissions**:

| Consumer | Code | Needs |
|---|---|---|
| Lead-answer hydration | `server.js:14359` (`fetchFacebookLeadFieldData`) | `leads_retrieval` |
| FB/IG post publisher | `lib/social-campaign.js:355` (`graphConfig` → `cfg.pageToken`, used at lines 454, 469, 481, 493) | `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish` |

A token minted for one silently breaks the other. There is no warning, no
startup check, and the two failures look nothing alike: leads fail loudly by
email, posting fails quietly in a cron. **This has already fired once in each
direction** (§3).

---

## 2. Verified live state as of 2026-08-19

- **Leads work.** Proven by test leads `1062334336283017` and `1686379759134963`
  (17 Aug 12:38 / 12:42Z), by real lead `1432788012009668` storing on retry at
  12:54Z, and by an owner test at 17:45Z.
- **Instagram/Facebook posting works.** Owner confirmed 2026-08-18.
- **The token currently in Vercel is a Graph-API-Explorer-derived Page token**
  minted 2026-08-18 by the owner: `type: Page`, Page `769864969547691`,
  `Expires: Never`, 8 scopes (all of the above plus `pages_show_list`,
  `ads_management`, `pages_manage_metadata`).
- ⚠️ **It carries `data_access_expires_at = 1794843457` → 2026-11-16.** That is a
  90-day clock tied to Khaleed's *personal* Facebook login, not to the token.
  The **System User** token it replaced (`AutomatedPosts`, `61593571162433`)
  had no such clock and is strictly better.

### Two pending owner actions, both non-urgent

1. **Restore the System User token** — Business Settings for business
   `1500341461017110` → Users → System users → `AutomatedPosts` → Generate token
   → app `GP Link Leads` → tick `leads_retrieval` (the four social scopes are
   locked-in app defaults and come automatically) → paste into
   `FB_PAGE_ACCESS_TOKEN` → redeploy. **No page-token exchange is needed** — a
   System User token reads leads directly. Do this before 2026-11-16.
2. 🎯 **Turn on "Allow retrieval of untargeted leads"** on the live form
   `1571202738133124`, and check the same setting on `1957628845192779`. This is
   the actual cause of the drop alerts — see §3a. Not optional: with it off, any
   untargeted lead is unreachable by the API for good.
3. **Add `1571202738133124` to `FB_GP_LEAD_FORM_IDS`** if it is not there.
   `1957628845192779` was added on 18 Aug; this third form went live after that.

---

## 3. History — read this before diagnosing a "leads DROPPED" email

**The alert email names `FB_PAGE_ACCESS_TOKEN` as the likely cause. It has been
misleading every time but the first.** Do these four checks, in this order:

1. 🎯 **Open the form in Meta → Lead ads forms → Lead breakdown and read
   "Allow retrieval of untargeted leads".** If it is **No**, any *untargeted*
   lead on that form **can never be fetched through the Graph API** — and Meta
   refuses it with the same wording a permissions failure produces. This is the
   actual cause of every drop alert after 2026-08-17 12:28. See §3a.
2. **Count *distinct lead ids*, not emails.** The handler returns 500 so Meta
   retries, and every retry re-sends the alert. On 17–18 Aug, **13 emails were
   2 leads**. Meta's backoff is 1m, 1m, 30m, 1h, 1.5h, 3h, 6h, 12h.
3. **Check Gmail for `subject:"New gp enquiry"`.** A *successful* hydration
   emails the owner. Those messages are the real success log — if they are
   arriving, hydration is fine and the alert is about one specific lead.
4. **Only then suspect the token.** Fetch a known-good lead id with it.

### 3a. "Allow retrieval of untargeted leads" — the real cause

Found 2026-08-19 from the form panel for `1571202738133124`
("GP Link — Overseas GP enquiry NEW-copy"):

```
Allow retrieval of untargeted leads:  No
Targeted: 1        Untargeted: 1        Expired: 0
```

One untargeted lead on the form; one lead the API would not serve
(`1716625716276091`, 2026-08-19 02:16Z). A lead is *untargeted* when the person
reached the form from outside the ad's target audience.

| Form | Reads? |
|---|---|
| `2029012337751132` (old) | ✅ leads were targeted / retrieval allowed |
| `1957628845192779` | ❌ check this setting — earlier blamed on "a deleted test lead", probably wrong |
| `1571202738133124` (current) | ❌ confirmed by the screenshot above |

"Old form works, new forms don't" is what made this look like a credential
problem for three days. **Fix: the running form needs that setting ON.** Meta
may lock form settings once a form has leads — confirm before assuming you must
duplicate it. The form panel's **Download** button exports untargeted leads even
when the API refuses them, so such a lead is recoverable by hand.

⚠️ **This is permanent, not transient.** Retries will never succeed for these
leads, which is exactly why §5's bounded retry window is the right shape and why
branching on Meta's error code still would not have helped.

**No doctor has actually been lost to any of this** — both affected doctors
self-rescued via the `/start?src=fb` thank-you-screen path, and Prashant Malla
(+44 7578 572757) went on to book a call. Do not remove that fallback.

### 2026-08-16 — leads broken by the social work

The Aug-7 token (which had `leads_retrieval`) was **overwritten** with a
posting-only token minted for the social pipeline. `leads_retrieval` was never
ticked; it is not mentioned once in that session. Leads died silently.

### 2026-08-17 — fixed, but the fix was never written down

Owner minted a System User token with `leads_retrieval` at 12:23Z, deployed at
12:28Z, and it was proven twice by 12:42Z. **The incident memory recorded the
plan but not the outcome**, so the next session read a stale note, re-diagnosed
a solved problem, and had the owner mint a replacement token at 1am for nothing.
That is why §2 above exists and why it is dated.

### 2026-08-17→18 — one deleted test lead, 8 more emails

Lead `1033387905982548` on form `1957628845192779` was retried for 12 hours.
It is unreadable even with a fully-scoped token —
`GraphMethodException code 100 / subcode 33`. Almost certainly a Lead Ads
Testing Tool lead deleted before the webhook could fetch it.

🧨 **Meta's wording for that error is identical to a missing-permission error:**
*"does not exist, cannot be loaded due to missing permissions, or does not
support this operation."* **Do not branch on it.** Branching on it would have
returned 200 during the 16 Aug outage and thrown away the automatic recovery of
lead `1432788012009668` at 12:54Z. Branch `fb-lead-drop-hardening` uses a
6-hour time window instead, precisely to avoid that trap. Do not "improve" it
into an error-code check.

---

## 4. The work

Give each consumer its own variable, with a fallback so nothing breaks mid-roll.

### Proposed shape

```js
// server.js — lead hydration
const token = process.env.FB_LEADS_PAGE_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;

// lib/social-campaign.js — graphConfig()
pageToken: String(e.FB_SOCIAL_PAGE_TOKEN || e.FB_PAGE_ACCESS_TOKEN || '').trim(),
```

The fallback is what makes this safe to ship before the env vars exist. Ship
the code, confirm nothing changed, then set the new variables one at a time.

### Rollout order (this order matters)

1. Ship the fallback code. Behaviour is byte-identical — both still read
   `FB_PAGE_ACCESS_TOKEN`.
2. Set `FB_LEADS_PAGE_TOKEN` in Vercel. Redeploy. Fire a test lead through
   `developers.facebook.com/tools/lead-ads-testing` and confirm a
   "New gp enquiry" email, not a DROPPED alert.
3. Set `FB_SOCIAL_PAGE_TOKEN`. Redeploy. Publish one post and confirm it lands.
4. Only once both are proven, consider removing `FB_PAGE_ACCESS_TOKEN`. Leaving
   it as the fallback is also fine and arguably safer.

### Worth adding while you are in there

- **A startup or health-check warning** when the two variables are equal *and*
  both features are enabled — that state is the bug, and nothing currently says so.
- **Name the consumer in `graphConfigProblems`** (`lib/social-campaign.js:364`)
  so a social failure says "social token" rather than the shared name.
- Consider a scope self-check: call `/debug_token` on boot and warn if the leads
  token lacks `leads_retrieval`. Cheap, and would have caught 16 Aug instantly.

---

## 5. Things NOT to "fix" back

- **The 500 on an unreadable lead is deliberate.** It is what lets Meta's retry
  recover a lead after a token is fixed. Branch `fb-lead-drop-hardening` bounds
  it to 6 hours; it does not remove it.
- **`FB_LEAD_UNREADABLE_RETRY_MS` (6h) must stay longer than 3h03m** — the real
  recovery interval on 17 Aug. A test in `tests/fb-lead-unreadable-retry.test.js`
  pins this.
- **The webhook is pinned to Graph `v26.0`** (`FB_GRAPH_VERSION`) to match the
  Page's leadgen subscription. Do not bump one without the other.
- **`IG_USER_ID` is not `FB_PAGE_ID`.** Pasting the Page id into both fails with
  the *same* opaque "does not support this operation" wording. There is already
  a guard for this — leave it.

---

## 6. Verifying without node

`node`/`npm`/`npx` are **not installed** in the Claude Code environment on this
machine, so the ~5,400-test suite cannot be run from a session. See the
`no-node-in-agent-sandbox` memory. Write the tests, verify by inspection, and
**say plainly in the PR that the suite is unrun**. `gh` is installed but not
authenticated, so a session can push a branch but not open the PR.

---

## 7. Related

- Branch **`fb-lead-drop-hardening`** (commit `2b3eb98`) — alert dedupe, bounded
  retries, and persistence of dropped lead ids. Pushed, **tests unrun**, not
  merged. Read its PR body before starting here; it changes
  `fetchFacebookLeadFieldData`'s return shape to `{ fieldData, reason }`.
- Memory: `fb-page-token-two-consumers` (read its **RESOLVED** section first —
  the earlier sections are a mid-investigation snapshot, not current state).
