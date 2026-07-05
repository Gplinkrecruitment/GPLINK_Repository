# Onboarding Nudge Waitlist

## What This Does

When a GP starts the onboarding flow but doesn't finish all 5 steps, they get reminder emails sent automatically from **notifications@mygplink.com.au**. 

The emails are sent on this schedule:
- ~1 hour after they leave
- 24 hours later
- 3 days later
- Then weekly: days 10, 17, 24, and 31
- After that, emails stop permanently

**Smart behaviors:**
- If a GP comes back to the app and makes progress (even if they don't finish), the reminder clock resets
- If a GP finishes onboarding, the reminders stop silently with no further emails
- Every email includes a "Continue where you left off" button that opens their exact last step
- Every email has an unsubscribe link. Clicking it opens a short confirm page with one "Unsubscribe" button — clicking the button is what actually turns off the emails. (This two-step design stops email-security scanners that auto-open links from silently unsubscribing people before a human ever saw the email.) Gmail/Yahoo's own built-in "Unsubscribe" option next to the email also works, with no extra click needed
- When the feature first turns on (or first notices a GP who's been gone a while), existing drop-outs don't get bombarded with every overdue email at once — the reminder sequence starts fresh from that moment, properly spaced out (~1 hour, then 1 day, then 3 days, and so on), exactly as if they'd just left today
- GPs who already have a job application in progress are treated as real candidates, not waitlist drop-outs — they never get chase emails and never show up on the onboarding-incomplete list, even if their onboarding profile is still unfinished

## Where Things Live

**Hourly Cron:** The system checks for GPs who need reminders every hour via `GET /api/cron/onboarding-nudge` — wired in `vercel.json`

**Core Engine:** `lib/onboarding-nudge.js` — calculates who needs emails, when, and generates the content

**Database Table:** `onboarding_reminders` — tracks each GP's last email date, which step they're on, unsubscribe status, and whether reminders are paused

**Migration:** `supabase/migrations/20260705120000_onboarding_reminders.sql` — creates the table (must be applied to prod via the standard exec_sql route before the cron can store state)

## CEO Dashboard

The Waitlist card now has two tabs:

1. **PEP pathway** — unchanged; shows GPs awaiting secure placement
2. **Onboarding incomplete** — lists GPs mid-onboarding (shows their last completed step, days inactive, and how many emails sent)

GPs who haven't finished onboarding no longer show up in the "Unassociated" pipeline bucket until they finish all 5 steps.

## How to Pause

**Pause everything:**
- Remove the cron entry from `vercel.json` and redeploy (disables hourly checks entirely)

**Pause per GP (four ways):**
1. The GP clicks the unsubscribe link in any email (no sign-in needed)
2. An admin manually sets `stopped = true` on that GP's row in the `onboarding_reminders` table
3. The GP completes onboarding (emails stop automatically)
4. The GP returns to the app and makes progress (clock resets; if they keep coming back, no new emails will send if they're too far behind — the system is lenient)

**Resume per GP:**
- An admin sets `stopped = false` on their `onboarding_reminders` row and the normal schedule resumes

## Monitoring

Check the Waitlist tab on the CEO dashboard to see:
- How many GPs are mid-onboarding
- Which step they're stuck on
- Days since last activity
- Whether they've received emails yet

No manual intervention needed unless a GP unsubscribes incorrectly or a pause needs overriding.
