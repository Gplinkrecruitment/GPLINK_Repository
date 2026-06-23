# AHPRA English-language section — match the official ELS evidence guide

**Date:** 2026-06-23
**Source of truth:** `Ahpra---Guide---ELS-evidence-guide---2026.PDF` (ELS evidence guide v1.2, 23 Apr 2026)
**Files:** `pages/ahpra.html` (GP form), `pages/admin.html` (RSO/admin view), `server.js` (persistence)

## Problem

The AHPRA "English language skills" step lets a GP pick a pathway and, for the Test
Pathway, which English test they used. Compared to the official guide, the Test Pathway
test list was incomplete for **doctors** (GP Link's entire user base), and the
"test older than 2 years" rule was only shown as a soft optional note rather than a
required step.

The 4 pathways (Combined / School / Advanced / Test) and the 5 standard tests
(IELTS / OET / PTE / TOEFL / Cambridge) are already present and correct. No change there.

## What the guide says (the gaps)

1. **Medical Board also accepts PLAB and NZREX** as proof of English for medical
   applicants. These need only a **certified copy of the test results** — no candidate
   number, no 2-year-validity rule.
2. **Test older than 2 years:** a standard test sat more than 2 years ago does NOT count
   on its own. The GP **must** extend its validity with EITHER:
   - **Continuous work** — CV in AHPRA standard format + employer letter confirming
     continuous employment (or a professional reference if no letter), plus the dates
     they started/stopped working; OR
   - **Continuous study** — transcript showing continuous enrolment in a Board-approved
     program (started within 12 months of the test, finished within 12 months of applying).
3. **IELTS One Skill Retake** is accepted (re-sit one section within 60 days). IELTS only.
4. **Test sittings rule:** AHPRA accepts one sitting, or two sittings within a 12-month
   period; results can't be combined across different test providers.

## Design

### GP form (`pages/ahpra.html`)

- **Test list** (`ELS_TEST_TYPES`): add
  `'PLAB (Professional and Linguistic Assessments Board)'` and
  `'NZREX (New Zealand Registration Examination)'`.
- **New sub-question** shown only when the GP selects a **standard** test **and** marks it
  **completed**: *"When did you sit this test?"* → `recent` (within 2 years) / `over2y`
  (more than 2 years ago). Stored as `els_test_recency`.
- **Documents (`buildElsTestDocs`)**, branched:
  - PLAB/NZREX → "Certified copy of your <test> results" only.
  - Standard, completed → "Copy of your <test> results with candidate number" (+ PTE
    authorisation line for PTE).
  - Standard, planning → existing book-and-sit guidance.
- **Required block** (`over2y` only): an amber "Required — your test is over 2 years old"
  panel offering the continuous-work OR continuous-study evidence lists.
- **Good-to-know notes** (muted, below the upload list): sittings rule for standard tests;
  IELTS One Skill Retake note for IELTS; "medical applicants only" for PLAB/NZREX.
- **Completion gate** (`isElsRequirementMet`): for the Test Pathway, require a test + a
  status, and — when the status is `done` on a standard test — also require `els_test_recency`,
  so a GP who tested >2 years ago cannot skip the employment/study-evidence requirement.
  `elsGateHintText` gets a matching hint.

### RSO/admin view (`pages/admin.html`)

- Show the chosen test + Completed/Planned badge (already present) and, when
  `els_test_recency === 'over2y'`, a line noting continuous work/study evidence is required.
- Update the static `ELS_PATHWAY_DOCS.test.docs` wording to match the guide.

### Server (`server.js`)

- Add `els_test_recency` to the carried/persisted ELS field list and to the admin payload
  builder so the RSO view receives it. Free string, no allowlist (consistent with existing
  fields).

### CSS bug fix (found in preview)

The required block's list items render inside `.els-checklist`, which applies a checkbox
square via `.els-checklist li::before`. The new `.els-or-card li::before` must reset
`border/background/width/height/border-radius` so only the dash bullet shows.

## Out of scope / unchanged

- The 4 pathways and 5 standard tests (already correct).
- Database schema (els_* live as JSON inside `gp_ahpra_progress`; no migration).
- CEO dashboard (does not display ELS).
- The completion gate for non-test pathways (pathway selection alone is enough).

## Verification

- `node --check server.js` after the server edit.
- Manual: pathway switching; PLAB/NZREX docs; IELTS retake note; sittings rule;
  completed standard test → recency question → over2y required block; gate lock/unlock;
  RSO view reflects test + recency.
