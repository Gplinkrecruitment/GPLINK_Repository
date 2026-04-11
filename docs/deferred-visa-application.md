# Deferred: Visa Application Step

**Status:** Hidden from user flow for v1 release (2026-04-11). Backend and page preserved — intended to re-enable in a future release.

## Scope of removal

The Visa step has been removed from the **user-visible registration journey** only. All backend, admin, and page scaffolding remains in place so that re-enabling is a UI reconnection rather than a rebuild.

### Files edited (user-facing removal)

- `js/app-shell.js` — removed the `buildRegistrationRow("visa", ...)` entry from the registration dropdown; reordered steps so the dropdown now shows 6 steps (Secure Placement → MyIntealth → AMC → AHPRA → PBS & Medicare → Commencement). Visa row replaced with a comment block marking the deferral.
- `pages/index.html` — removed visa from the dashboard journey list (`renderJourneyList`), the registration rows (`getRegistrationRows`), and the progress snapshot (`visaDone` no longer counted, `currentRoute` branch removed). `TOTAL_STEPS` dropped from 7 to 6.
- `pages/career.html` — removed the Visa milestone card from the placement-detail mock data story.

### Files intentionally preserved

Do **not** delete or rename any of these when cleaning up — they are needed to restore visa work later:

- `pages/visa.html` — full user-facing visa page.
- `pages/admin-visa.html` — admin-side visa case management UI.
- `server.js` — all visa server logic remains, including:
  - `VISA_STAGES` array and the DoubleTick visa template (`sendDoubleTickTemplate(..., 'visa', ...)`).
  - `_linkVisaCaseToRegCase`, `processVisaTaskAutomation`, and the `visa_case_id` linkage.
  - `VA_TASK_DOMAINS` (still includes `visa`) and the visa-related task categories.
  - Stage-progression logic around line 3473 and the visa template trigger around line 3919.
- `js/app-shell.js` — `PAGE_PATHS` and `NAV_GROUPS` still include `/pages/visa.html` so the page is reachable via direct URL.
- `js/nav-shell-bridge.js` — still includes visa page routing.
- Supabase migrations — `visa_cases` table and `visa_case_id` linkage columns remain.

## New journey ordering (v1)

1. **Secure Your Placement** (career) — *no prerequisite, non-blocking for registration start*
2. **MyIntealth Account** — *no prerequisite*
3. **AMC Portfolio** — *locked until MyIntealth/EPIC verified*
4. **AHPRA Registration** — *locked until placement secured AND AMC verified*
5. **PBS & Medicare** — *locked until AHPRA complete*
6. **Commencement** — *locked until AHPRA complete*

The registration entry point (`REGISTRATION_ENTRY_ROUTE`) remains `/pages/myinthealth.html`. Placement is listed first in the journey view but users begin the structured registration work from MyIntealth; placement can be worked on in parallel.

## To re-enable the Visa step

1. In `js/app-shell.js` `getRegistrationRows()`, re-add the visa row between AHPRA and PBS, and bump the displayed step numbers on PBS and Commencement.
2. In `pages/index.html`:
   - Bump `TOTAL_STEPS` back to 7.
   - Re-add `visaDone` to the `getProgressSnapshot()` return.
   - Re-add the visa branch in the `currentRoute` logic.
   - Re-add visa to `renderJourneyList()` steps array between AHPRA and PBS.
   - Re-add visa to the `getRegistrationRows()` list and renumber.
3. In `pages/career.html`, re-add the visa milestone card in the placement-detail mock.
4. No server or DB changes required — those were never removed.
