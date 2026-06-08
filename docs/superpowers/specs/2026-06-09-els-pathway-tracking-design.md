# ELS Pathway Tracking — Design Spec

**Date:** 2026-06-09
**Status:** Draft
**Approach:** Inline expansion (Approach A)

## Summary

Add English Language Skills (ELS) pathway selection to the AHPRA page so GPs can record which pathway they'll use for their AHPRA application. The selection is informational — no uploads, no progress tracking, no admin tasks. Admin sees the GP's chosen pathway and its required document checklist on the GP profile.

## GP-Facing UI

### Location

Row 3 ("English language skills") in the Application step of `pages/ahpra.html`. The existing "Check your eligibility on AHPRA" link remains unchanged.

### New Elements (below the existing link)

1. **Dropdown** — labelled "Select your pathway" with 5 options:
   - Combined Education Pathway
   - School Education Pathway
   - Advanced Education Pathway
   - Test Pathway (IELTS, OET, PTE, TOEFL, Cambridge)
   - Native English Speaker (recognised country)

2. **Checklist panel** — appears below the dropdown when a pathway is selected. Blue-tinted card (`#f0f5ff` background, `#d4e0f7` border) with a non-interactive checkbox-style list of documents the GP needs to prepare for that pathway. Slides in with a fade animation.

3. **Saved badge** — "Pathway saved — visible to your GP Link team" shown below the checklist after selection. Green text with checkmark icon.

Changing the dropdown updates the checklist immediately and re-saves.

### Pathway Document Lists

**Combined Education Pathway:**
- Official transcripts showing qualification taught & assessed in English
- Details of secondary education provider and enrolment dates (entered in AHPRA form)
- Letter from education provider confirming English instruction (if not shown on transcript)

**School Education Pathway:**
- Details of primary & secondary education providers and enrolment dates (entered in AHPRA form)
- Official transcripts showing qualification taught & assessed in English
- Letter from education provider confirming English instruction (if not shown on transcript)
- Home schooling evidence from Department of Education (if applicable)

**Advanced Education Pathway:**
- Official transcripts of professional qualification
- Official transcripts of advanced education (degree level AQF 7+)
- Letter from education provider confirming English instruction (if not shown on transcript)
- Dates of any breaks taken during study (entered in AHPRA form)
- Date of most recent study completion (must be within 2 years of application)

**Test Pathway:**
- Copy of test results with candidate number (IELTS / OET / PTE / TOEFL / Cambridge)
- PTE Academic only: authorise AHPRA to access results through PTE system
- If test > 2 years old + still working: CV in AHPRA format + employer letter confirming continuous employment
- If test > 2 years old + enrolled in study: transcript showing continuous enrolment in Board-approved program
- PLAB or NZREX: certified copy of test results (medicine applicants only)

**Native English Speaker:**
- No additional documents required — your country of training qualifies you automatically
- Confirm your recognised country in the AHPRA application form

## Admin Visibility

### Location

The GP's existing admin profile/case view in `pages/admin.html`. No new pages or sections — displayed alongside the other registration state data.

### What's Shown

- **Pathway name** — e.g. "ELS Pathway: Test Pathway" or "ELS Pathway: Not yet selected"
- **Document checklist** — the same list of required documents the GP sees, so the admin knows what to expect without looking it up externally

Read from `gp_ahpra_progress.els_pathway` in the GP's user state (already loaded by the admin panel).

## Data & Storage

- **Field:** `gp_ahpra_progress.els_pathway` — string key: `combined`, `school`, `advanced`, `test`, or `native`
- **Pathway document map:** Shared JS object used by both `pages/ahpra.html` and `pages/admin.html`, mapping each pathway key to its title and document list
- **Sync:** Existing `state-sync.js` handles localStorage-to-Supabase persistence. No new API endpoints.
- **No DB schema changes** — the field lives inside the existing `gp_ahpra_progress` JSON blob in the `user_state` table

## What This Feature Does NOT Do

- No document upload slots for ELS documents
- No progress tracking or completion status for ELS
- No admin tasks created on pathway selection
- No notifications to admin when GP selects a pathway
- No validation of pathway eligibility against GP's country/qualifications
- No new tabs or pages — purely inline within existing Row 3

## Files to Modify

1. `pages/ahpra.html` — Add dropdown + checklist rendering in Row 3, save/load `els_pathway` to `gp_ahpra_progress`
2. `pages/admin.html` — Display ELS pathway + document checklist on GP profile view
