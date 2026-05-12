# Visa Application Step

**Status:** Re-enabled in user flow (2026-05-12). Previously hidden for v1 release (2026-04-11).

## Current state

The Visa step is now visible as Step 5 in the user journey (between AHPRA Registration and PBS & Medicare). The page currently shows an informational view of the 482 → 186 permanent residency pathway. The full visa case management UI (questionnaire, documents, dependants, timeline) was replaced with this simplified informational page.

The page is always accessible (never locked) and includes:
- Visual pathway showing Subclass 482 → Subclass 186 → Permanent Residency
- Note that more information will appear once they reach the visa step
- Button to contact the team about alternative visa pathways

## Backend preserved

All server-side visa logic remains in place for future use:
- `pages/admin-visa.html` — admin-side visa case management UI
- `server.js` — all visa API routes, `VISA_STAGES`, task automation, questionnaire logic
- Supabase `visa_cases` table and `visa_case_id` linkage columns
