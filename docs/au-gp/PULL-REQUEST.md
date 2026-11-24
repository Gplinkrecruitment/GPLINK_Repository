# Draft pull request: title and description

Open it as a **draft** from `au-gp-testing` into `main`:
https://github.com/Gplinkrecruitment/GPLINK_Repository/compare/main...au-gp-testing?expand=1

Do not merge it until you have tested and decided to go live. Merging deploys
to the live site.

## Title

Australian GP placements (behind AU_PATHWAY_ENABLED, off in production): DRAFT, do not merge yet

## Description

**What this is.** Everything needed for GP Link to place Australian GPs
(already in Australia, already registered with Ahpra), from the website to the
end of the 12-week guarantee. It is the 28-package build plan from the 20
November 2026 systems review.

**It changes nothing until a switch is turned on.** All Australian behaviour
sits behind `AU_PATHWAY_ENABLED`, which is off on the live site unless set.
With it off, the product behaves as it does on `main`. A doctor with no
pathway recorded is an overseas doctor and sees, receives and triggers what
they do today.

**Do not merge yet.** This is a draft for the owner to read and test.

### Before merging

1. Test it: `docs/au-gp/TESTING.md` (every step of Part 1 was followed on
   screen).
2. Read `docs/au-gp/HANDOVER.md` (what was built, what is not done, what could
   not be verified) and `docs/au-gp/OWNER-ACTIONS.md` (148 decisions and
   outside-account actions).
3. Apply the fourteen `*au_gp*` database files in `supabase/migrations/` to
   the live database, in filename order, and run the checks at the top of the
   last two files. They only add fields, tables and rules; nothing is dropped,
   renamed or narrowed. **The switch must not go on anywhere real before
   this**: one of the files is the lock that stops a doctor writing a
   "confirmed Australian VR GP" pathway onto their own profile.

### What was checked

- Tests: 11,906 pass. One fails, and fails identically on `main`
  (`tests/server-observability.test.js`, cron-health).
- Seven independent reviews by fresh agents. The seventh found no blocker and
  no required defect. Every defect from all seven, with its status, is in
  `docs/au-gp/final-review.md`.
- With the switch off, compared against a server running `main`: signed-out
  public pages byte-identical; a UK doctor's screens and emails match; a
  placed overseas doctor's saved data and download match; database request
  counts over a whole overseas journey equal; 410 staff task actions on an
  overseas case match.
- An Australian VR GP from sign-up to commencement at phone width: no overseas
  wording on any screen or in any message.

### What is not done or not verified

- Launched for segment A (Australian VR GPs) only. Restricted and non-VR
  doctors are held safely and flagged to staff.
- Open "should" and "minor" items are listed in `HANDOVER.md` under "Found by
  the reviews and NOT fixed" and "Rough edges".
- Not verified: real AI output, the preview website end to end, a physical
  phone, outside services (nothing was changed in DoubleTick, Retell, Meta,
  Google Ads, Calendly, Zoom or Xero; nothing real was sent).
- Regulatory rules (19AB, provider numbers, supervision, visa transfer) are
  assumptions that take the restrictive option when unknown; they need
  confirming.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012btG5ceLpQz2PtWtvUXXkT
