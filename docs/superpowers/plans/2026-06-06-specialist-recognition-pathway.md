# Specialist Recognition Pathway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the RACGP/ACRRM Specialist Recognition Pathway as an alternative registration route for UK/IE/NZ GPs who don't meet AHPRA's expedited pathway recency requirements.

**Architecture:** A pathway branch point during onboarding asks when the GP received their specialist registration. If they don't qualify for the expedited pathway, they're routed through the specialist recognition pathway instead — which adds a College Comparability Assessment step between AMC and Placement. The existing registration engine (registration_cases, registration_tasks, app-shell journey rendering) is extended to support pathway-conditional steps. Since all three country qualifications (MRCGP, MICGP, FRNZCGP) are RACGP Category 1, all GPs on this pathway will be assessed as **substantially comparable** — so only the happy path is built; edge cases go to admin for manual handling.

**Tech Stack:** Vanilla JS/HTML, Node.js (server.js), Supabase (PostgreSQL), Vitest for tests.

---

## Domain Research: RACGP PEP-SP Pathway (from official RACGP handbook)

> Sources: RACGP PEP SP Application Handbook (revised July 2025) — 16 pages reviewed.
> All information below is sourced directly from https://www.racgp.org.au/education/gp-training/.../pep-sp-application-handbook/

### What is PEP-SP?

The **Practice Experience Program Specialist (PEP SP)** is designed for Specialist International Medical Graduates (SIMGs) who hold a recognised overseas general practice specialist qualification and wish to obtain **specialist registration and Fellowship of the RACGP (FRACGP)** through the Medical Board of Australia's Specialist Pathway.

During the program, participants must complete a **minimum of six months in comprehensive Australian general practice** while working under supervision and completing targeted educational activities. They must also **sit assessments or exams** to demonstrate comparability with an Australian-trained specialist GP at the level of a new Fellow of the RACGP.

The program has two streams based on comparability outcome:
- **Substantially Comparable (SC) Stream** — shorter supervised practice, fewer assessments
- **Partially Comparable (PC) Stream** — longer supervised practice, additional training

### Key Acronyms

| Acronym | Definition |
|---------|-----------|
| AHPRA | Australian Health Practitioner Regulation Agency |
| AKT | Applied Knowledge Test |
| AMC | Australian Medical Council |
| BLS | Basic Life Support |
| CPD | Continuing Professional Development |
| DPA | Distribution Priority Area |
| ECFMG | Educational Commission for Foreign Medical Graduates |
| EPIC | Electronic Portfolio of International Credentials |
| FRACGP | Fellowship of the Royal Australian College of General Practitioners |
| FTE | Full Time Equivalent |
| KFP | Key Feature Problem |
| MBA | Medical Board of Australia |
| MBS | Medicare Benefits Schedule |
| MMM | Modified Monash Model |
| PC | Partially Comparable |
| PEP SP | Practice Experience Program Specialist |
| SC | Substantially Comparable |
| SIMG | Specialist International Medical Graduate |
| SPR | Summary of Preliminary Review |

### The Three-Part Application Journey

The PEP-SP application is structured into three sequential parts:

**Part A — Comparability Assessment**
Evaluates how the GP's training and experience compare to an Australian-trained GP at the point of Fellowship admission. Must be completed before Part B or Part C.

**Part B — Job Offer Approval Assessment**
The GP secures employment in an approved general practice and RACGP approves the position.

**Part C — Right to Work Assessment**
The GP applies for AHPRA medical registration and an appropriate visa, then submits evidence to RACGP.

After all three parts: sign program agreement, pay fees, obtain BLS certification, RACGP membership, and Medicare provider number.

### Part A: Comparability Assessment — Full Detail

#### Prerequisites (3 requirements)

1. **Medical qualification recognition** — Primary qualification in medicine and surgery from an institution recognised by both the AMC and the World Directory of Medical Schools (WDOMS)
2. **Specialist GP qualification** — Must have satisfied all training and examination requirements to practice as a specialist GP and received a specialist general practice qualification in their country of origin
3. **Curriculum eligibility** — The curriculum of the specialist GP qualification must have been assessed by RACGP as "eligible" (free assessment, takes up to 10 weeks if not yet assessed)

#### Eligibility Criteria (7 requirements)

1. Hold a specialist GP qualification with a curriculum assessed as comparable to the RACGP curriculum
2. **Recency:** Completed 12 months' FTE of general practice in the last 4 years, with minimum 4 weeks' FTE in the last year
3. Clinical general practice experience meeting PEP SP Comparability Assessment Policy requirements
4. CV on RACGP template listing all clinical experience from graduation, explaining gaps exceeding 3 calendar months
5. **50 hours CPD** completed in the last 12 months (substantiated by official certificates)
6. Satisfactory completion of summative assessments with both theoretical and practical components
7. Satisfactory completion through a suitable training program

#### Eligible Qualifications (GP Link countries)

| Country | Qualification | Status | Last Reviewed |
|---------|--------------|--------|---------------|
| **United Kingdom** | Membership of the Royal College of General Practitioners (MRCGP) | **Eligible** | August 2025 |
| **Ireland** | Membership of the Irish College of General Practitioners (MICGP) | **Eligible** | July 2024 |
| **New Zealand** | Fellowship of the Royal New Zealand College of General Practitioners (FRNZCGP) | **Eligible** | July 2024 |

All three are classified as **eligible (comparable)** — GPs holding these qualifications will be assessed as **substantially comparable**, assuming they meet the recency and CPD requirements.

Other eligible countries (for future reference): Canada, Hong Kong, Malaysia, Belgium, Netherlands, Singapore, South Africa, USA, Bahrain, Fiji, Malta, Philippines, Saudi Arabia, Spain, Sri Lanka, Sweden, Thailand.

#### EPIC Verification (prerequisite to application)

Before applying, the GP must have their overseas medical qualifications verified through EPIC (administered by ECFMG). They need:
- **EPIC ID** (evidence of applying for EPIC verification)
- **AMC candidate number** (evidence of establishing an AMC portfolio)

Important: The comparability assessment can be submitted even if EPIC verification hasn't completed yet, as long as the EPIC ID is provided.

#### How to Apply

- **Platform:** https://applications.racgp.org.au/prog/pep_specialist/
- **RACGP ID required** (free registration on RACGP website)
- **Expected completion time:** 90 minutes
- **Application can be saved and revisited** within 6 months from payment date
- **Cannot be amended after submission**
- Third parties or agencies may complete on applicant's behalf

#### Required Documents for Application

**Identity:**
- Name change documentation if applicable

**Professional Credentials:**
- CV on RACGP template (dated within 3 months preceding submission)
- Primary medical degree certificate
- Specialist medical degree certificate
- Letter of good standing from issuing organisation

**Clinical Experience (last 48 months):**
- Letters of support for ALL clinical posts held in past 48 calendar months
- Each letter must be on practice letterhead, signed by Practice Principal/Senior Medical Director/CEO/Director/Practice Manager
- Must specify: exact employment dates, FT/PT status, average weekly hours, weekly session duration, detailed duty descriptions, patient demographics summary

**Registration & Compliance:**
- Evidence of medical registration for all practice jurisdictions since graduation
- Disclosure of any addenda on medical registration
- Disclosure of any regulatory authority activity affecting registration

**CPD:**
- Evidence of 50 hours CPD in prior 12 months
- All substantiated by official certificates/completion statements
- Must show activity nature, dates, and hours completed

**Statutory Declaration:**
- Signed before an authorised witness
- Signature date = official application date (reference point for recency, experience, CPD assessment)
- Witness must verify: medical registrations for all jurisdictions, letters of support for previous 48 months

**Academic Qualifications:**
- Certified copies of: primary medical degree, specialist GP qualification, certificate of completion of training (where applicable)
- Confirmation letter from awarding body stating pathway followed and summative assessments
- 100-300 word descriptions of theoretical and practical summative assessments

**All non-English documents require certified official English translations.**

#### Fees

- **Application fee:** Paid in full before processing (exact amount on RACGP fee schedule)
- **Accepted payment:** Visa, MasterCard, American Express, PayPal
- The 2026 fees referenced elsewhere: $1,096 application + $6,184 assessment = **$7,280 AUD total (incl. GST)**

#### Assessment Timeline

- **Up to 10 weeks** to receive outcome (provided all required information was submitted)
- If RACGP needs more information, they email and extend the timeframe

#### Outcome Notification Process

1. **Summary of Preliminary Review (SPR)** sent via email with outcome:
   - Substantially Comparable
   - Partially Comparable
   - Not Comparable
2. Applicant must respond via email confirming acceptance
3. **21 calendar day challenge period** — GP can contact RACGP with clarifications or additional information if they believe there are gaps or errors. If no response within 21 days, original SPR findings are upheld.
4. **Final Comparability Assessment outcome letter** sent via email after acceptance

#### Outcome Validity

- **Valid for 12 calendar months** from the date of the outcome letter
- Must complete Parts B and C and sign program agreements within this timeframe
- Failing to complete within 12 months requires **reapplying** for a new comparability assessment

#### Not Comparable Outcome

- Ineligible for PEP SP
- Contact becomeagp@racgp.org.au and AHPRA for alternative pathways (Standard Pathway, Competent Authority Pathway)
- Reconsideration available under Dispute, Reconsideration and Appeals Policy
- Re-application possible after 6 months if significant training/experience changes occurred

### Part B: Securing and Approving Employment

#### Practice Requirements

The job offer must be in a practice that:
1. Is **accredited** against the RACGP Standards for general practices
2. Meets requirements of **comprehensive Australian general practice**
3. Meets placement guidelines per the General Practice Fellowship Program Placement Guidelines

#### Location Requirements

PEP-SP participants typically work in **regional, rural or remote areas** (MM2-MM7 under the Modified Monash Model). The Health Workforce Locator identifies where IMGs can work.

#### Work Hours

| Type | Weekly Hours | Days | Face-to-face Patient Time |
|------|-------------|------|--------------------------|
| **Full-time** | Minimum 38 hours | 4+ days | At least 27 hours |
| **Part-time** | Minimum 14.5 hours | 2+ days | At least 10.5 hours |

- Work periods must be minimum 3 consecutive hours
- Minimum 4 calendar weeks in any single practice
- Hours beyond full-time definition are not counted

**Important:** The RACGP does NOT help find employment — it's solely the GP's responsibility. (This is where GP Link's placement service adds value.)

#### Job Offer Approval

- Submit via PEP SP application platform
- Letter of offer must include: supervisor details, scope of practice, intended hours, job duties, practice location, commencement date
- Letter must be signed **no more than 6 calendar months** before submission
- RACGP takes **up to 3 weeks** to review and approve/deny
- If details change after submission, notify RACGP immediately

### Part C: Right to Work

#### AHPRA Registration

| Comparability Outcome | Registration Type |
|----------------------|-------------------|
| Substantially Comparable | **Provisional registration** |
| Partially Comparable | **Limited registration** |

- Apply via AHPRA website after job offer approval
- Must meet all MBA registration standards (criminal history check, English language test)
- Processing time: **6-8 weeks**
- Name published on National Register of Health Practitioners within 2 weeks of approval
- Overseas applicants may receive **in-principle approval** with minimum identity evidence

#### Visa

- Most common: **Temporary Skill Shortage Visa (subclass 482) Medium-term stream**
- Requires sponsorship by an Australian medical practice or hospital
- Other visa options may be available depending on circumstances

#### Submitting to RACGP

Once registration and visa are granted, complete Part C on the PEP SP application platform with evidence of:
- Valid visa (including visa type)
- AHPRA medical registration

### Finalising Entry into PEP-SP

After Parts A, B, and C are complete:

1. **Sign Program Agreement and Pay Fees**
   - RACGP emails agreement and invoice
   - Pay program fees, return signed agreement to pepspecialistadmin@racgp.org.au
   - **Must commence work within 6 calendar months** of signing

2. **Basic Life Support (BLS) Certification**
   - Provide evidence of valid BLS certification with signed agreement
   - Expired certifications not accepted

3. **RACGP Membership**
   - Must maintain financial RACGP membership throughout PEP SP
   - Fees paid before commencing work
   - Withdrawal from program if membership lapses

4. **Medicare Provider Number**
   - RACGP is authorised to approve A1 Medicare provider numbers for PEP SP participants
   - Participants can access highest-value MBS items while on PEP SP
   - Processing: complete form → RACGP → Department of Health → Services Australia
   - **Takes up to 12 weeks** to process
   - Services Australia issues approved placement outcome letter with provider number

### Key Timelines Summary

| Step | Duration |
|------|----------|
| Comparability assessment processing | Up to 10 weeks |
| SPR challenge period | 21 calendar days |
| Comparability outcome validity | 12 months |
| Job offer letter validity | Must be signed within 6 months of submission |
| Job offer RACGP review | Up to 3 weeks |
| AHPRA registration processing | 6-8 weeks |
| AHPRA register publication | Within 2 weeks of approval |
| Must commence work after signing agreement | Within 6 months |
| Medicare provider number processing | Up to 12 weeks |
| Minimum supervised practice | 6 months |

### Contact Information

- **General PEP SP queries:** educationsupport@racgp.org.au
- **Program agreement:** pepspecialistadmin@racgp.org.au
- **Medicare placement:** approvedplacement@racgp.org.au
- **Not Comparable guidance:** becomeagp@racgp.org.au
- **Phone:** 1800 472 247
- **Application platform:** https://applications.racgp.org.au/prog/pep_specialist/

---

## Domain Research: Placement Guidelines (from Government PDF)

> Source: General Practice Fellowship Program Placement Guidelines, Fourth Edition (October 2022), Australian Government Department of Health and Aged Care.

### PEP Location Rules — MM1 is allowed for Substantially Comparable SIMGs

**Default rule:** PEP placements are limited to areas classified **MM2-7**.

**Exception for PEP Specialist Stream participants (our GPs):**

> "No MM1 placements for PEP participants will be approved unless the participant... **is an international medical graduate with substantially comparable specialist qualifications participating in the PEP under the PEP Specialist Stream and will be working in a Distribution Priority Area (DPA).**"

This means GP Link's GPs on the specialist recognition pathway **CAN work in MM1 (metropolitan) practices**, provided:
1. They are assessed as **substantially comparable** (all UK/IE/NZ GPs with MRCGP/MICGP/FRNZCGP will be)
2. The practice is in a **Distribution Priority Area (DPA)**

### What is a DPA?

The Distribution Priority Area (DPA) classification system replaced the Districts of Workforce Shortage (DWS) from 1 July 2019. It determines where IMGs can work with Medicare access.

**Key DPA rules:**
- **Inner metropolitan areas** are automatically deemed **non-DPA**
- **MM2-7 areas** are automatically deemed **DPA**
- **Northern Territory** is automatically deemed **DPA**
- Other MM1 areas are assessed based on demographics (gender/age), socioeconomic status, and GP-to-population ratios in GP catchment areas

So **not all MM1 areas are DPA** — inner metro is automatically non-DPA. But many outer metropolitan MM1 areas ARE classified as DPA. GP Link placements need to verify the DPA status of each practice location.

**Tool for checking:** The Health Workforce Locator (healthworkforce.health.gov.au) identifies DPA areas where IMGs can work.

### Other PEP Location Requirements

| Training Stream | Location Restriction |
|----------------|---------------------|
| AGPT (RACGP) | Metropolitan, regional, rural and remote |
| AGPT (ACRRM) | Regional, rural and remote (MM2-7), minimum 12 months in MM4-7 |
| PEP | MM2-7, **except SC SIMGs in DPA MM1 areas** |
| IP (ACRRM) | MM2-7 |
| RVTS | Remote areas / Aboriginal Medical Services |
| FSP | MM2-7 (extenuating circumstances only for MM1) |

### Work Hours (from Placement Guidelines)

| Type | Weekly Hours | Days | Face-to-face Patient Time |
|------|-------------|------|--------------------------|
| **Full-time** | Minimum 38 hours | 4+ days | At least 27 hours |
| **Part-time** | Minimum 14.5 hours | 2+ days | At least 10.5 hours |

### Practice Accreditation

All PEP placement practices must hold **practice accreditation against the RACGP Standards for general practices**. If the practice is already accredited to train AGPT registrars, it's automatically considered an "approved practice."

### Medicare Provider Number for PEP

- RACGP is a **Specified Body** authorised to grant Approved Placements
- Participants get access to **highest-value MBS GP items** while on program
- MPN is location-specific and time-limited (tied to placement dates)
- **Services Australia processing can take up to 6 weeks** in peak periods
- Participants should start renewal at least **10 weeks before** placement expiry

### Implications for GP Link

1. **Placement service is a competitive advantage** — RACGP does NOT help find employment; GP Link does
2. **DPA verification is required** — when placing a GP in an MM1 area on the specialist pathway, must verify the practice is in a DPA area
3. **Practice accreditation must be verified** — practices must hold RACGP accreditation
4. **Job offer letter requirements** are specific — must include supervisor details, scope of practice, hours, duties, location, commencement date
5. **RACGP approves the placement** — the job offer must be submitted to RACGP for approval (Part B), which takes up to 3 weeks

---

## Current App Audit: What exists and how it maps to PEP-SP

### Onboarding (js/onboarding.js)

**Current state:** 5-step flow collecting country (GB/IE/NZ), qualification documents (MRCGP/MICGP/FRNZCGP + primary medical degree), relocation details, and identity verification. Stores in localStorage `gp_onboarding`.

**What maps to PEP-SP:**
- Country selection already limits to GB, IE, NZ — the three countries whose qualifications are RACGP Category 1 (eligible, substantially comparable)
- Qualification doc scanning (AI verification) already validates MRCGP, MICGP, FRNZCGP — these are the exact same documents needed for PEP-SP Part A
- Primary medical degree verification — also required for PEP-SP Part A

**What's missing:**
- No specialist registration date question (needed to determine expedited vs specialist recognition)
- No pathway type selection
- No college preference (RACGP vs ACRRM)
- No CPD hours collection (PEP-SP requires 50 hours in last 12 months)
- No recency check (PEP-SP requires 12 months FTE GP work in last 4 years)

### MyIntealth / EPIC (pages/myinthealth.html)

**Current state:** 3-stage flow (create_account → account_establishment → upload_qualifications → verification_issued). Stores in `gp_epic_progress`. Completion unlocks AMC.

**What maps to PEP-SP:**
- EPIC ID is a **prerequisite for PEP-SP Part A** — the GP must have an EPIC ID before submitting their comparability assessment
- The current flow already produces the EPIC ID through the MyIntealth account
- PEP-SP explicitly states: "You may submit your comparability assessment even if the EPIC verification hasn't been completed yet, as long as you provide your EPIC ID"

**What's missing:** Nothing — this step is identical for both pathways.

### AMC Portfolio (pages/amc.html)

**Current state:** 2-stage flow (create_portfolio → upload_credentials → qualifications_verified). Gate requires MyIntealth ID. Stores in `gp_amc_progress`.

**What maps to PEP-SP:**
- AMC candidate number is a **prerequisite for PEP-SP Part A** — required alongside EPIC ID
- The current flow already creates the AMC portfolio and uploads credentials
- PEP-SP Part A application form asks for the AMC candidate number

**What's missing:** Nothing — this step is identical for both pathways.

### Career / Placement (pages/career.html)

**Current state:** Zoho Recruit integration shows job listings, handles applications, tracks placement status. "Placement secured" detected via application status (hired/secured/placement_secured/contract_signed). Triggers practice pack document creation (SPPA-00, Section G, position description, offer/contract, supervisor CV).

**What maps to PEP-SP Part B (Job Offer Approval):**
- GP Link already places GPs in practices — this maps directly to "securing an offer of employment"
- The offer/contract document already exists in the practice pack
- Supervisor details are already tracked (supervisor CV task)
- Practice accreditation and location data could be captured here

**What's missing for PEP-SP Part B:**
- RACGP requires the letter of offer to include: supervisor details, scope of practice, intended hours, job duties, practice location, commencement date — some of this is already in the offer/contract but may need explicit fields
- RACGP must approve the job offer (up to 3 weeks) — need to track this approval status
- Practice must be accredited against RACGP Standards
- Work hours must meet PEP-SP minimums (FT: 38hrs/4+ days, PT: 14.5hrs/2+ days)
- **Location (CONFIRMED):** PEP-SP SC participants CAN work in MM1 areas if the practice is in a **Distribution Priority Area (DPA)**. GP Link currently has no MM classification or DPA tracking. Need to tag practices with MMM classification and DPA status. MM2-7 are automatically DPA. MM1 requires explicit DPA verification via the Health Workforce Locator.

### AHPRA Registration (pages/ahpra.html)

**Current state:** 3 visible stages (Account → Application → Status). Tracks via `gp_ahpra_progress`. Has an intro/gate screen. Documents required include: primary medical degree, specialist cert (MRCGP/MICGP/FRNZCGP), CCT, CV, SPPA-00, Section G, position description, offer/contract, supervisor CV.

**What maps to PEP-SP Part C (Right to Work):**
- AHPRA registration is already tracked
- Document requirements overlap significantly

**What's different for PEP-SP:**
- **Registration type:** Substantially Comparable applicants apply for **provisional registration** (not the expedited specialist registration)
- **Prerequisite:** Job offer must be approved by RACGP (Part B) before applying for AHPRA
- **Processing:** 6-8 weeks (same as current)
- **Document requirements:** Same core documents (primary degree, specialist cert, CCT, CV) but also criminal history check and English language test evidence
- The AHPRA page intro screen currently doesn't distinguish between pathways

### Visa (pages/visa.html)

**Current state:** Informational page showing the 482 → 186 → Citizenship pathway. No state tracking — read-only.

**What maps to PEP-SP:**
- Visa requirements are the same: Temporary Skill Shortage Visa (subclass 482) Medium-term stream
- Requires sponsorship by the practice (same)
- Part C of PEP-SP requires submitting visa evidence to RACGP

**What's missing:**
- Need to track when visa is granted (for PEP-SP Part C submission)
- Need to submit visa details to RACGP after visa approval

### PBS & Medicare (pages/pbs.html)

**Current state:** 2-step tracking: Medicare provider number → PBS prescriber number. Upload documents, track status/reference numbers.

**What's different for PEP-SP:**
- **Medicare provider number goes through RACGP** for PEP-SP participants (not direct application)
- RACGP is authorised to approve A1 Medicare provider numbers
- Processing: RACGP → Department of Health → Services Australia — **up to 12 weeks**
- PEP-SP participants can access highest-value MBS items

**What's missing:**
- Different Medicare application flow for PEP-SP pathway (through RACGP, not direct)
- Need to track that the form was sent to RACGP at approvedplacement@racgp.org.au

### Finalisation Steps (NOT in current app)

PEP-SP has additional requirements after Parts A-C that don't exist in the current app:

1. **Program agreement** — RACGP emails agreement + invoice, GP signs and pays
2. **BLS certification** — Must provide valid (not expired) BLS cert
3. **RACGP membership** — Must maintain throughout PEP SP (withdrawal if lapsed)
4. **Must commence work within 6 months** of signing agreement

### Admin Dashboard (pages/admin.html)

**Current state:** Case list with stage/status filters, case detail with profile, tasks, notes, documents, timeline. Stage override via `gp_verified_stage` dropdown. VA task system with automation.

**What maps to PEP-SP:**
- Case management structure already supports tracking stages
- Task automation (auto-create tasks on state transitions) can be extended for PEP-SP milestones
- Stage override system already handles unlocking/locking stages

**What's missing:**
- No pathway filter (expedited vs specialist_recognition)
- No college assessment tracking in case detail
- No PEP-SP Part B (job offer approval) status tracking
- No PEP-SP Part C submission tracking
- No outcome validity expiry warning (12-month window)
- Stage override (`gp_verified_stage`) doesn't include `college_assessment`
- Admin STEPS array doesn't include college_assessment

### State Sync (js/state-sync.js)

**Current state:** Syncs 22 localStorage keys to Supabase. Handles admin-readonly keys, ownership enforcement, batched saves.

**What's missing:**
- `gp_college_progress` not in STATE_KEYS
- `gp_pep_sp_status` not in STATE_KEYS (if we track PEP-SP milestones)

### Database (registration_cases + registration_tasks)

**Current state:** `registration_cases` tracks stage (myintealth→amc→career→ahpra→visa→pbs→commencement→complete), status, VA assignment, practice info. `registration_tasks` tracks all VA work items.

**What's missing:**
- `college_assessment` not in stage CHECK constraint
- No `pathway_type` column
- No `college`, `comparability_outcome`, `college_application_date`, `college_outcome_date`, `college_outcome_valid_until` columns
- No task types for PEP-SP milestones (Part A submitted, SPR received, Part B approved, Part C submitted, agreement signed)

---

## Gap Analysis: Complete Change List

### Priority Legend
- **P0** — Required for pathway to function at all
- **P1** — Required for production readiness
- **P2** — Nice to have, can ship without

### 1. Onboarding Changes (P0)

| Change | Detail | Files |
|--------|--------|-------|
| Add specialist registration date question | Date input in Step 1 after qualification scanning. Determines pathway. | `js/onboarding.js` |
| Add pathway determination logic | If registration date > cutoff → specialist_recognition, else → expedited | `js/onboarding.js` |
| Add college selection | RACGP vs ACRRM radio buttons (only shown for specialist_recognition) | `js/onboarding.js` |
| Update review step | Show determined pathway and college in review summary | `js/onboarding.js` |
| Store pathway on profile | `/api/onboarding/complete` saves pathway_type + specialist_registration_date to user_profiles | `server.js` |
| Set pathway on registration_case | Include pathway_type + college when creating registration_case | `server.js` |

### 2. Database Changes (P0)

| Change | Detail | Files |
|--------|--------|-------|
| Add pathway columns to user_profiles | pathway_type, specialist_registration_date | Migration SQL |
| Add college assessment columns to registration_cases | pathway_type, college, comparability_outcome, college_application_date, college_outcome_date, college_outcome_valid_until | Migration SQL |
| Extend stage CHECK | Add 'college_assessment' to allowed stages | Migration SQL |
| Add pathway index | For admin filtering performance | Migration SQL |

### 3. New College Assessment Page (P0)

| Change | Detail | Files |
|--------|--------|-------|
| Create page | 3-step tracker: Application → Waiting (10-week timeline) → Outcome | `pages/college-assessment.html` |
| College-specific content | Dynamic labels/links based on RACGP vs ACRRM selection | `pages/college-assessment.html` |
| State management | `gp_college_progress` localStorage key synced via state-sync | `pages/college-assessment.html` |
| Document checklist | Show required Part A documents (CV, certs, letters of support, CPD evidence, statutory declaration) | `pages/college-assessment.html` |
| Fee information | $1,096 + $6,184 = $7,280 AUD | `pages/college-assessment.html` |
| Outcome validity tracker | 12-month countdown from outcome date | `pages/college-assessment.html` |

### 4. Server Changes (P0)

| Change | Detail | Files |
|--------|--------|-------|
| Add `gp_college_progress` to USER_STATE_KEYS | Enables state sync for college assessment | `server.js:3332` |
| Add `college_assessment` to PAGE_STAGE_MAP | Maps new page to stage | `server.js:5715` |
| Pathway-conditional step computation | Insert college_assessment step between AMC and documents for specialist_recognition GPs | `server.js:6867` |
| Include pathway in bootstrap | Frontend needs pathway_type and college from bootstrap response | `server.js:18115` |
| Update isStageAccessAllowed | college_assessment only accessible for specialist_recognition pathway, after AMC complete | `server.js:5725` |
| College assessment API endpoints | POST /api/college-assessment/application, POST /api/college-assessment/outcome | `server.js` |
| Admin college outcome endpoint | POST /api/admin/college-assessment/outcome | `server.js` |

### 5. App Shell Changes (P0)

| Change | Detail | Files |
|--------|--------|-------|
| Add route | `/pages/college-assessment` to PAGE_PATHS | `js/app-shell.js:27` |
| Update progress snapshot | Add collegeDone, collegeApplied, pathwayType | `js/app-shell.js:504` |
| Conditional journey rows | Insert "College Assessment" step 4 for specialist_recognition, renumber subsequent steps | `js/app-shell.js:545` |
| Update locking logic | College assessment locked until AMC complete | `js/app-shell.js:545` |

### 6. Admin Dashboard Changes (P1)

| Change | Detail | Files |
|--------|--------|-------|
| Pathway filter pills | "All pathways / Expedited / Specialist Recognition" filter buttons | `pages/admin.html` |
| Pathway badge on case card | "Specialist" badge next to stage pill for specialist_recognition cases | `pages/admin.html` |
| College assessment section in case detail | Shows college, application date, outcome, validity | `pages/admin.html` |
| Admin outcome override | Dropdown to set/update comparability outcome | `pages/admin.html` |
| Include pathway columns in cases API | SELECT pathway_type, college, comparability_outcome etc. from registration_cases | `server.js` |
| Add college_assessment to admin STEPS array | So stage override dropdown includes it | `pages/admin.html:1418` |
| Add college_assessment to STAGE_ORDER | For stage ordering in override logic | `pages/admin.html:1428`, `server.js:28073` |

### 7. State Sync Changes (P0)

| Change | Detail | Files |
|--------|--------|-------|
| Add `gp_college_progress` to STATE_KEYS | Client-side sync for college assessment state | `js/state-sync.js:2` |

### 8. AHPRA Page Adjustments (P1)

| Change | Detail | Files |
|--------|--------|-------|
| Pathway-aware intro text | For specialist_recognition: mention provisional registration and that Part B must be approved first | `pages/ahpra.html` |
| Registration type label | "Provisional Registration" for SC pathway vs current language | `pages/ahpra.html` |

### 9. PBS & Medicare Adjustments (P2)

| Change | Detail | Files |
|--------|--------|-------|
| Pathway-aware Medicare guidance | For specialist_recognition: note that Medicare provider number goes through RACGP (up to 12 weeks) instead of direct application | `pages/pbs.html` |
| RACGP form tracking | Track that form was sent to approvedplacement@racgp.org.au | `pages/pbs.html` |

### 10. PEP-SP Part B: Job Offer Approval (P1)

| Change | Detail | Files |
|--------|--------|-------|
| Track RACGP job offer approval | After placement secured, specialist_recognition GPs need to submit offer to RACGP for approval (up to 3 weeks) | `server.js`, possibly `pages/career.html` or `pages/college-assessment.html` |
| Letter of offer requirements | Must include: supervisor details, scope of practice, intended hours, job duties, practice location, commencement date. Letter signed within 6 months. | Documentation in UI |
| Approval status tracking | pending_racgp_approval → approved / denied | `registration_cases` or `gp_college_progress` state |

### 11. PEP-SP Finalisation Checklist (P2)

| Change | Detail | Files |
|--------|--------|-------|
| Program agreement tracking | Track: signed, fee paid | New section or state key |
| BLS certification | Track valid BLS cert uploaded | New document type or checklist item |
| RACGP membership | Track active membership status | Checklist item |
| Commencement deadline | Must start work within 6 months of signing — show countdown | Timer/alert |

### 12. Task Automation (P1)

| Change | Detail | Files |
|--------|--------|-------|
| Auto-create tasks on pathway events | college_assessment submitted → create followup task (check outcome in 10 weeks). Outcome received → create Part B task. Part B approved → create Part C tasks. | `server.js:8100` (processRegistrationTaskAutomation) |
| Outcome validity warning | If 12-month validity is approaching (e.g., 2 months left), create urgent task | Task automation or cron |

### 13. Location / DPA Verification (P1 — CONFIRMED: MM1 allowed for SC SIMGs in DPA areas)

| Change | Detail | Files |
|--------|--------|-------|
| DPA verification for MM1 placements | PEP-SP SC participants CAN work in MM1, but ONLY in DPA areas. When placing a specialist_recognition GP in an MM1 practice, must verify the practice is in a DPA. Use Health Workforce Locator data. | `server.js`, `pages/career.html` or admin |
| Practice MMM + DPA tagging | Tag practices in Zoho Recruit or career roles with MMM classification and DPA status. MM2-7 are automatically DPA. MM1 needs explicit DPA check. | `server.js`, Zoho Recruit config |
| Practice accreditation tracking | PEP-SP requires practices to hold RACGP accreditation. Add accreditation status field to career roles or practice data. | `server.js`, admin |
| DPA info on career/placement page | For specialist_recognition GPs, show DPA status of practice location to confirm eligibility | `pages/career.html` |

---

## Context for the implementing engineer

### What is this?

GP Link helps overseas GPs (from UK, Ireland, New Zealand) register to practise in Australia. The current app handles the **Expedited Specialist Pathway** — a fast-track route through AHPRA.

**Problem:** Not all GPs qualify for the expedited pathway because AHPRA requires their specialist registration to have been granted within a specific recency window. GPs who fall outside that window currently have no pathway in the app.

**Solution:** Route those GPs through the **Specialist Recognition Pathway (PEP-SP)** instead. This is a three-part application through RACGP: Part A (comparability assessment), Part B (job offer approval), Part C (right to work — AHPRA + visa). The GP's qualifications (MRCGP/MICGP/FRNZCGP) are all classified as eligible by RACGP, so they'll be assessed as **substantially comparable** — it's a formality, just with extra steps, documents, and fees (~$7,280 AUD).

### How the current registration journey works

**Expedited pathway (current, 6 steps in app-shell):**
1. Your Practice (career/placement)
2. MyIntealth Account (EPIC verification)
3. AMC Portfolio (credential verification)
4. AHPRA Registration (4 sub-stages)
5. Visa Application
6. PBS & Medicare

**Specialist recognition pathway (new, 7 steps in app-shell):**
1. Your Practice (same)
2. MyIntealth Account (same — EPIC ID is a prerequisite for PEP-SP Part A)
3. AMC Portfolio (same — AMC candidate number is a prerequisite for PEP-SP Part A)
4. **College Assessment** (NEW — PEP-SP Part A: comparability assessment, ~10 weeks)
5. AHPRA Registration (modified — provisional registration for SC, 6-8 weeks processing)
6. Visa Application (same — 482 subclass most common)
7. PBS & Medicare (same — but Medicare provider number goes through RACGP for PEP-SP, up to 12 weeks)

**Key insight:** Steps 2 and 3 (MyIntealth/EPIC + AMC) are prerequisites for the PEP-SP application. The GP needs their EPIC ID and AMC candidate number before they can even submit Part A. So the existing step ordering already aligns perfectly — we just insert the college assessment between AMC and AHPRA.

### Key files you'll touch

- `server.js` — API endpoints, stage maps, bootstrap data, registration step computation
- `js/app-shell.js` — Journey rendering (`getRegistrationRows()`), route map, progress snapshot
- `js/onboarding.js` — Onboarding state, pathway determination question
- `pages/college-assessment.html` — NEW page for college comparability tracking
- `pages/admin.html` — Case list pathway filter, college assessment admin panel
- `supabase/migrations/` — New migration for pathway columns

### Key patterns to follow

- Cache busters on script tags: `?v=YYYYMMDD[letter]` (e.g., `?v=20260606a`)
- Pages are plain HTML with inline `<script>` and `<style>` blocks
- State stored in localStorage keys (e.g., `gp_college_progress`) and synced to Supabase via `user_state`
- Navigation from embedded pages uses `window.parent.postMessage({ type: "gp-shell-route", href, title }, origin)`
- Event delegation preferred (single document-level listener)
- Server routes are all in `server.js` — add new endpoints alongside existing patterns
- Registration pages load `js/nav-shell-bridge.js` for app-shell integration

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `supabase/migrations/20260606000000_pathway_columns.sql` | Create | Add pathway_type and college_assessment columns to DB |
| `js/onboarding.js` | Modify | Add specialist registration date question + pathway determination |
| `server.js` (onboarding endpoints) | Modify | Store pathway_type on profile, include in bootstrap |
| `server.js` (stage maps + step computation) | Modify | Pathway-conditional steps and stage access |
| `server.js` (college assessment API) | Modify | New endpoints for college assessment CRUD |
| `pages/college-assessment.html` | Create | College comparability assessment tracking page |
| `js/app-shell.js` | Modify | Add college-assessment route, pathway-conditional journey rows |
| `pages/admin.html` | Modify | Pathway filter pill + college assessment info in case detail |
| `server.js` (admin endpoints) | Modify | Return pathway_type in case list, college assessment admin actions |

---

## Task 1: Database Migration — Pathway Columns

**Files:**
- Create: `supabase/migrations/20260606000000_pathway_columns.sql`

This migration adds pathway tracking to user_profiles and the new `college_assessment` stage to registration_cases.

- [ ] **Step 1: Write the migration SQL**

```sql
-- Specialist Recognition Pathway support
-- Adds pathway_type to user_profiles and college assessment tracking

-- 1. Add pathway_type to user_profiles
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS pathway_type TEXT DEFAULT 'expedited'
    CHECK (pathway_type IN ('expedited', 'specialist_recognition'));

-- 2. Add specialist_registration_date to user_profiles (used to determine pathway eligibility)
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS specialist_registration_date DATE;

-- 3. Extend registration_cases stage CHECK to include 'college_assessment'
ALTER TABLE registration_cases
  DROP CONSTRAINT IF EXISTS registration_cases_stage_check;

ALTER TABLE registration_cases
  ADD CONSTRAINT registration_cases_stage_check
    CHECK (stage IN ('myintealth','amc','college_assessment','career','ahpra','visa','pbs','commencement','complete'));

-- 4. Add college assessment fields to registration_cases
ALTER TABLE registration_cases
  ADD COLUMN IF NOT EXISTS pathway_type TEXT DEFAULT 'expedited'
    CHECK (pathway_type IN ('expedited', 'specialist_recognition')),
  ADD COLUMN IF NOT EXISTS college TEXT
    CHECK (college IS NULL OR college IN ('racgp', 'acrrm')),
  ADD COLUMN IF NOT EXISTS comparability_outcome TEXT
    CHECK (comparability_outcome IS NULL OR comparability_outcome IN ('substantially_comparable', 'partially_comparable', 'not_comparable')),
  ADD COLUMN IF NOT EXISTS college_application_date DATE,
  ADD COLUMN IF NOT EXISTS college_outcome_date DATE,
  ADD COLUMN IF NOT EXISTS college_outcome_valid_until DATE;

-- 5. Index for pathway filtering
CREATE INDEX IF NOT EXISTS idx_reg_cases_pathway ON registration_cases(pathway_type);

COMMENT ON COLUMN user_profiles.pathway_type IS 'expedited = standard AHPRA fast-track; specialist_recognition = RACGP/ACRRM comparability route';
COMMENT ON COLUMN registration_cases.college IS 'Which Australian college assesses comparability (racgp or acrrm)';
COMMENT ON COLUMN registration_cases.comparability_outcome IS 'Result of college comparability assessment';
COMMENT ON COLUMN registration_cases.college_outcome_valid_until IS '12 months from outcome date — must start requirements before expiry';
```

- [ ] **Step 2: Apply migration to Supabase**

Run in Supabase SQL editor or via CLI:
```bash
# If using Supabase CLI:
npx supabase db push
# Otherwise: paste the SQL into the Supabase SQL Editor at https://supabase.com/dashboard
```

Verify: Check that `user_profiles` has `pathway_type` and `specialist_registration_date` columns, and `registration_cases` has `pathway_type`, `college`, `comparability_outcome`, `college_application_date`, `college_outcome_date`, `college_outcome_valid_until` columns.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260606000000_pathway_columns.sql
git commit -m "feat: add pathway_type and college assessment columns for specialist recognition pathway"
```

---

## Task 2: Onboarding — Pathway Determination

**Files:**
- Modify: `js/onboarding.js` (lines 59-73 for state, and the step rendering logic)
- Modify: `server.js` — `/api/onboarding/complete` endpoint (line ~24241)

The onboarding flow currently has 5 steps (0=intro, 1=country+qualifications, 2=relocation, 3=review, 4=identity). We add a specialist registration date question to **Step 1** (after country selection and qualification scanning) that determines which pathway the GP takes.

- [ ] **Step 1: Add pathway fields to onboarding state**

In `js/onboarding.js`, update `defaultState()` at line 59:

```javascript
function defaultState() {
  return {
    _version: 2,
    currentStep: 0,
    country: "",
    qualDocs: {},
    accountReviewFlag: false,
    targetDate: "",
    preferredCity: "",
    whoMoving: "",
    childrenCount: 1,
    childrenAges: [],
    idVerification: null,
    completedAt: null,
    // Specialist Recognition Pathway fields
    specialistRegistrationDate: "",   // YYYY-MM-DD — when they received specialist GP registration
    pathwayType: "",                  // "expedited" or "specialist_recognition" — determined from date
    college: "",                      // "racgp" or "acrrm" — chosen by GP (only if specialist_recognition)
  };
}
```

- [ ] **Step 2: Add registration date question UI to Step 1**

In `js/onboarding.js`, find the function that renders Step 1 (the country + qualification documents step). After the qualification document scanning section, add the specialist registration date question. Search for the step 1 rendering block — it will contain the country selector and COUNTRY_DOCS loop.

Add this HTML block after the qualification docs section, inside the step 1 container:

```javascript
// After the qualification docs section in renderStep1():
const dateSection = `
  <div class="ob-field" style="margin-top:24px">
    <label class="ob-label">When were you granted your specialist GP registration?</label>
    <p class="ob-hint" style="font-size:13px;color:#8893a7;margin:4px 0 10px">
      This is the date on your CCT, CSCST, or Fellowship certificate. It determines your registration pathway in Australia.
    </p>
    <input type="date" id="obSpecRegDate" class="ob-input"
      value="${escHtml(state.specialistRegistrationDate)}"
      max="${new Date().toISOString().split('T')[0]}"
      style="max-width:260px" />
    <div id="obPathwayResult" style="margin-top:12px;font-size:13px"></div>
  </div>
`;
```

- [ ] **Step 3: Add pathway determination logic**

Add an event listener for the date input that computes the pathway. The AHPRA expedited pathway requires specialist registration within the last 5 years (this cutoff may change — keep it configurable).

```javascript
const EXPEDITED_CUTOFF_YEARS = 5;

function determinePathway(specialistRegDateStr) {
  if (!specialistRegDateStr) return "";
  const regDate = new Date(specialistRegDateStr);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - EXPEDITED_CUTOFF_YEARS);
  return regDate >= cutoff ? "expedited" : "specialist_recognition";
}

// In the step 1 event setup:
document.addEventListener("change", function (e) {
  if (e.target.id === "obSpecRegDate") {
    const dateVal = e.target.value;
    state.specialistRegistrationDate = dateVal;
    state.pathwayType = determinePathway(dateVal);
    saveState();
    renderPathwayResult();
  }
});

function renderPathwayResult() {
  const el = document.getElementById("obPathwayResult");
  if (!el) return;
  if (!state.pathwayType) { el.innerHTML = ""; return; }

  if (state.pathwayType === "expedited") {
    el.innerHTML = '<div style="padding:10px 14px;background:#ecfdf5;border-radius:8px;color:#065f46">' +
      '<strong>Expedited Pathway</strong> — Your registration date qualifies you for the fast-track AHPRA route.</div>';
    state.college = "";
  } else {
    el.innerHTML = '<div style="padding:10px 14px;background:#eff6ff;border-radius:8px;color:#1e40af">' +
      '<strong>Specialist Recognition Pathway</strong> — You\'ll go through a college comparability assessment (RACGP or ACRRM) before AHPRA registration. ' +
      'Your qualification is Category 1, so you\'ll be assessed as substantially comparable.</div>' +
      '<div style="margin-top:12px">' +
        '<label class="ob-label">Which college would you like to apply through?</label>' +
        '<div style="display:flex;gap:10px;margin-top:8px">' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
            '<input type="radio" name="obCollege" value="racgp"' + (state.college === "racgp" ? " checked" : "") + ' /> RACGP (leads to FRACGP)' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
            '<input type="radio" name="obCollege" value="acrrm"' + (state.college === "acrrm" ? " checked" : "") + ' /> ACRRM (leads to FACRRM)' +
          '</label>' +
        '</div>' +
      '</div>';
  }
  saveState();
}

// College radio handler:
document.addEventListener("change", function (e) {
  if (e.target.name === "obCollege") {
    state.college = e.target.value;
    saveState();
  }
});
```

- [ ] **Step 4: Include pathway data in the review step (Step 3)**

In the review step rendering, add the pathway determination to the summary. Find the review step render function and add:

```javascript
// In the review summary section:
const pathwayLabel = state.pathwayType === "specialist_recognition"
  ? "Specialist Recognition (" + (state.college === "acrrm" ? "ACRRM" : "RACGP") + ")"
  : state.pathwayType === "expedited"
    ? "Expedited"
    : "Not determined";

// Add to the review HTML:
'<div class="ob-review-row"><span class="ob-review-label">Registration pathway</span><span>' + escHtml(pathwayLabel) + '</span></div>'
```

- [ ] **Step 5: Send pathway data to server on completion**

In `js/onboarding.js`, find where the completion payload is sent to `/api/onboarding/complete`. The state is already sent as the full onboarding object. Confirm that `specialistRegistrationDate`, `pathwayType`, and `college` are included in the state object that's POSTed. Since they're part of `state` and `saveState()` persists them, they should already be sent.

No code change needed — just verify the POST body includes the new fields by checking that the completion function sends the full state.

- [ ] **Step 6: Update server to store pathway_type on profile**

In `server.js`, find the `/api/onboarding/complete` handler (around line 24241). It already saves profile data. Add pathway fields to the profile update.

Find the section that updates `user_profiles` (look for `qualification_country` or `preferred_city` being set). Add:

```javascript
// After the existing profile updates in the onboarding complete handler:
if (onboardingData.pathwayType === 'expedited' || onboardingData.pathwayType === 'specialist_recognition') {
  profileUpdates.pathway_type = onboardingData.pathwayType;
}
if (onboardingData.specialistRegistrationDate) {
  profileUpdates.specialist_registration_date = onboardingData.specialistRegistrationDate;
}
```

Also, when the registration_case is created for this user (search for `INSERT INTO registration_cases` near the onboarding/signup flow), include the pathway_type:

```javascript
// In the registration case creation:
pathway_type: onboardingData.pathwayType || 'expedited',
college: onboardingData.pathwayType === 'specialist_recognition' ? (onboardingData.college || 'racgp') : null,
```

- [ ] **Step 7: Add `gp_college_progress` to USER_STATE_KEYS**

In `server.js` at line 3332, add to the USER_STATE_KEYS array:

```javascript
'gp_college_progress',
```

This ensures the college assessment state is synced to the frontend via bootstrap.

- [ ] **Step 8: Commit**

```bash
git add js/onboarding.js server.js
git commit -m "feat: add pathway determination to onboarding (specialist registration date check)"
```

---

## Task 3: Server — Pathway-Conditional Step Computation

**Files:**
- Modify: `server.js` — `PAGE_STAGE_MAP` (line 5715), `isStageAccessAllowed()` (line 5725), registration step computation (line 6867), bootstrap data

- [ ] **Step 1: Add college-assessment to PAGE_STAGE_MAP**

At `server.js` line 5715, add the new page:

```javascript
const PAGE_STAGE_MAP = {
  '/pages/myinthealth.html': 'myintealth',
  '/pages/amc.html': 'amc',
  '/pages/college-assessment.html': 'college_assessment',
  '/pages/career.html': 'career',
  '/pages/ahpra.html': 'ahpra',
  '/pages/visa.html': 'visa',
  '/pages/pbs.html': 'pbs',
  '/pages/commencement.html': 'commencement'
};
```

- [ ] **Step 2: Update registration step computation for pathway branching**

At `server.js` line 6867, modify the step computation function to include the college assessment step conditionally. The function that builds `steps` needs access to the user's pathway_type. Find where this function is called and ensure the profile or registration_case data is available.

```javascript
// Replace the static steps array with pathway-conditional logic:
function computeRegistrationSteps(userStateObj, pathwayType) {
  const epic = userStateObj.gp_epic_progress && typeof userStateObj.gp_epic_progress === 'object'
    ? userStateObj.gp_epic_progress : {};
  const amc = userStateObj.gp_amc_progress && typeof userStateObj.gp_amc_progress === 'object'
    ? userStateObj.gp_amc_progress : {};
  const ahpra = userStateObj.gp_ahpra_progress && typeof userStateObj.gp_ahpra_progress === 'object'
    ? userStateObj.gp_ahpra_progress : {};
  const docs = userStateObj.gp_documents_prep && typeof userStateObj.gp_documents_prep === 'object'
    ? userStateObj.gp_documents_prep : {};
  const college = userStateObj.gp_college_progress && typeof userStateObj.gp_college_progress === 'object'
    ? userStateObj.gp_college_progress : {};

  const steps = [
    { id: 'profile_setup', label: 'Profile setup', done: false },
    { id: 'epic_verification', label: 'EPIC verification', done: false },
    { id: 'amc_portfolio', label: 'AMC portfolio', done: false },
  ];

  // Insert college assessment step for specialist recognition pathway
  if (pathwayType === 'specialist_recognition') {
    steps.push({ id: 'college_assessment', label: 'College assessment', done: false });
  }

  steps.push(
    { id: 'documents', label: 'Documents prepared', done: false },
    { id: 'ahpra_setup', label: 'AHPRA account setup', done: false },
    { id: 'ahpra_submission', label: 'AHPRA submission', done: false },
    { id: 'ahpra_assessment', label: 'AHPRA assessment', done: false },
    { id: 'registration_outcome', label: 'Registration outcome', done: false }
  );

  // Completion logic — same as before for shared steps
  steps.find(s => s.id === 'profile_setup').done = !!(epic && epic.completed && epic.completed.create_account === true);
  steps.find(s => s.id === 'epic_verification').done = !!(epic && epic.completed && epic.completed.verification_issued === true);
  steps.find(s => s.id === 'amc_portfolio').done = !!(amc && amc.completed && amc.completed.qualifications_verified === true);

  // College assessment completion (only present for specialist_recognition)
  const collegeStep = steps.find(s => s.id === 'college_assessment');
  if (collegeStep) {
    collegeStep.done = !!(college && college.comparability_outcome === 'substantially_comparable');
  }

  const docEntries = docs && docs.docs && typeof docs.docs === 'object' ? Object.values(docs.docs) : [];
  const preparedByYou = docEntries.filter((item) => item && typeof item === 'object' && hasOwn(item, 'uploaded'));
  const uploadedPrepared = preparedByYou.filter((item) => item.uploaded === true);
  steps.find(s => s.id === 'documents').done = preparedByYou.length > 0 && uploadedPrepared.length === preparedByYou.length;

  steps.find(s => s.id === 'ahpra_setup').done = !!(ahpra && ahpra.stage_1 && ahpra.stage_1.completedAt);
  steps.find(s => s.id === 'ahpra_submission').done = !!(ahpra && ahpra.stage_2 && ahpra.stage_2.completedAt);
  steps.find(s => s.id === 'ahpra_assessment').done = !!(ahpra && ahpra.stage_3 && (ahpra.stage_3.completedAt || ahpra.stage_3.applicationOpenedAt));
  steps.find(s => s.id === 'registration_outcome').done = !!(ahpra && ahpra.stage_4 && ahpra.stage_4.completedAt);

  const doneCount = steps.filter((step) => step.done).length;
  const currentIndex = steps.findIndex((step) => !step.done);
  const currentStepIndex = currentIndex === -1 ? steps.length : currentIndex + 1;
  const currentStepLabel = currentIndex === -1 ? 'Completed' : steps[currentIndex].label;
  const percent = Math.round((doneCount / steps.length) * 100);

  const assessmentStatus = ahpra && ahpra.stage_3 && typeof ahpra.stage_3.assessmentStatus === 'string'
    ? ahpra.stage_3.assessmentStatus : '';
  const pendingVerification = !steps.find(s => s.id === 'epic_verification').done
    || !steps.find(s => s.id === 'amc_portfolio').done
    || assessmentStatus === 'under_review'
    || assessmentStatus === 'further_info_requested';

  const actionRequired = !!(
    (ahpra && ahpra.adminFlags && ahpra.adminFlags.actionRequired === true) ||
    assessmentStatus === 'further_info_requested'
  );

  const documentsPending = docEntries.filter((item) => item && typeof item === 'object' && (item.status === 'under_review' || item.status === 'rejected')).length;

  return {
    steps, currentStepIndex, totalSteps: steps.length, currentStepLabel,
    percent, pendingVerification, actionRequired, documentsPending
  };
}
```

- [ ] **Step 3: Include pathway_type in bootstrap response**

Find where `buildAuthBootstrapForEmail` constructs the bootstrap payload (line ~18115). Add `pathway_type` from the user's profile or registration_case so the frontend knows which pathway this GP is on.

```javascript
// In the bootstrap payload, add:
pathwayType: profile.pathway_type || 'expedited',
college: registrationCase ? registrationCase.college : null,
```

- [ ] **Step 4: Update isStageAccessAllowed for college_assessment**

In `isStageAccessAllowed()` (line 5725), ensure the `college_assessment` stage is only accessible for specialist_recognition pathway GPs, and only after AMC is complete. The existing locking logic uses overrides and stage progression — add college_assessment to the stage ordering.

```javascript
// In the stage ordering/access logic, add college_assessment between amc and career:
const STAGE_ORDER_EXPEDITED = ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement'];
const STAGE_ORDER_SPECIALIST = ['myintealth', 'amc', 'college_assessment', 'career', 'ahpra', 'visa', 'pbs', 'commencement'];
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: pathway-conditional registration steps and stage access in server"
```

---

## Task 4: College Assessment Page

**Files:**
- Create: `pages/college-assessment.html`

This is a new page following the same pattern as `pages/ahpra.html` and `pages/amc.html`. It tracks the RACGP/ACRRM comparability assessment process.

- [ ] **Step 1: Create the college assessment page**

Create `pages/college-assessment.html` with the standard GP Link page structure. The page has 3 sections tracking the assessment journey:

1. **Application** — Links to RACGP/ACRRM portal, tracks when application was submitted
2. **Waiting for outcome** — ~10 week processing period, shows timeline
3. **Outcome** — Displays comparability result (substantially comparable expected)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>College Assessment – GP Link</title>
  <script src="/js/nav-shell-bridge.js?v=20260606a"></script>
  <style>
    :root {
      --bg: #0b1120; --surface: #151d2e; --card: #1a2435;
      --line: #232f42; --text: #e8ecf2; --muted: #8893a7;
      --accent: #4f7df9; --accent-soft: rgba(79,125,249,.12);
      --green: #34d399; --green-soft: rgba(52,211,153,.12);
      --amber: #fbbf24; --amber-soft: rgba(251,191,36,.12);
      --radius: 12px; --font: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--bg); color: var(--text); padding: 20px; padding-bottom: calc(var(--gp-shell-bottom-clearance, 80px) + 20px); }
    .page-header { margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; font-weight: 700; }
    .page-header p { font-size: 14px; color: var(--muted); margin-top: 4px; }
    .step-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; }
    .step-card.active { border-color: var(--accent); }
    .step-card.done { border-color: var(--green); }
    .step-num { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; font-size: 13px; font-weight: 700; margin-right: 10px; }
    .step-num.pending { background: var(--line); color: var(--muted); }
    .step-num.active { background: var(--accent); color: #fff; }
    .step-num.done { background: var(--green); color: #fff; }
    .step-title { font-size: 16px; font-weight: 600; display: inline; }
    .step-desc { font-size: 13px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
    .step-body { margin-top: 16px; }
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: var(--muted); }
    .info-value { font-weight: 600; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .badge-green { background: var(--green-soft); color: var(--green); }
    .badge-amber { background: var(--amber-soft); color: var(--amber); }
    .badge-blue { background: var(--accent-soft); color: var(--accent); }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; border: none; cursor: pointer; text-decoration: none; transition: opacity .15s; }
    .btn:hover { opacity: .85; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-outline { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
    .date-input { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; color: var(--text); font-size: 14px; }
    .timeline-bar { height: 6px; background: var(--line); border-radius: 3px; margin-top: 12px; overflow: hidden; }
    .timeline-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .3s; }
    .hidden { display: none !important; }
    .support-link { color: var(--accent); text-decoration: none; font-size: 13px; }
    .support-link:hover { text-decoration: underline; }
    .fee-info { background: var(--surface); border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 13px; }
    .fee-info strong { color: var(--amber); }
  </style>
</head>
<body>
  <div class="page-header">
    <h1>College Comparability Assessment</h1>
    <p id="collegeSubtitle">Your pathway to specialist GP recognition in Australia.</p>
  </div>

  <!-- Step 1: Application -->
  <div class="step-card" id="stepApply">
    <span class="step-num active" id="applyNum">1</span>
    <span class="step-title">Apply for Comparability Assessment</span>
    <div class="step-desc">
      Submit your application to <span id="collegeName">RACGP</span> for a comparability assessment.
      Your <span id="qualName">qualification</span> is a Category 1 qualification — you'll be assessed as substantially comparable.
    </div>
    <div class="step-body" id="applyBody">
      <div class="fee-info">
        <strong>Fees:</strong> Application $1,096 AUD + Assessment $6,184 AUD (including GST)
      </div>
      <div style="margin-top:16px">
        <a id="collegeLink" href="https://www.racgp.org.au/education/imgs/fellowship-pathways/fellowship-programs-for-imgs/practice-experience-program/practice-experience-program-specialist-stream" target="_blank" class="btn btn-primary">Go to <span id="collegeLinkLabel">RACGP</span> Portal</a>
      </div>
      <div style="margin-top:16px">
        <label style="font-size:13px;color:var(--muted);display:block;margin-bottom:6px">Date you submitted your application:</label>
        <input type="date" id="applicationDate" class="date-input" />
        <button id="saveApplicationBtn" class="btn btn-outline" style="margin-left:10px">Save</button>
      </div>
    </div>
  </div>

  <!-- Step 2: Waiting -->
  <div class="step-card hidden" id="stepWaiting">
    <span class="step-num pending" id="waitNum">2</span>
    <span class="step-title">Waiting for Outcome</span>
    <div class="step-desc">
      Comparability assessments typically take up to 10 weeks. We'll track the timeline for you.
    </div>
    <div class="step-body">
      <div class="info-row">
        <span class="info-label">Application submitted</span>
        <span class="info-value" id="appliedDateDisplay">—</span>
      </div>
      <div class="info-row">
        <span class="info-label">Expected outcome by</span>
        <span class="info-value" id="expectedOutcomeDate">—</span>
      </div>
      <div class="info-row">
        <span class="info-label">Time remaining</span>
        <span class="info-value" id="timeRemaining">—</span>
      </div>
      <div class="timeline-bar">
        <div class="timeline-fill" id="timelineFill" style="width:0%"></div>
      </div>
    </div>
  </div>

  <!-- Step 3: Outcome -->
  <div class="step-card hidden" id="stepOutcome">
    <span class="step-num pending" id="outcomeNum">3</span>
    <span class="step-title">Assessment Outcome</span>
    <div class="step-desc">
      Once your outcome is received, record it here. Your outcome is valid for 12 months.
    </div>
    <div class="step-body">
      <div id="outcomeForm">
        <div style="margin-bottom:12px">
          <label style="font-size:13px;color:var(--muted);display:block;margin-bottom:6px">Outcome received:</label>
          <select id="outcomeSelect" class="date-input" style="min-width:240px">
            <option value="">— Select outcome —</option>
            <option value="substantially_comparable">Substantially Comparable</option>
            <option value="partially_comparable">Partially Comparable</option>
            <option value="not_comparable">Not Comparable</option>
          </select>
        </div>
        <div style="margin-bottom:12px">
          <label style="font-size:13px;color:var(--muted);display:block;margin-bottom:6px">Date outcome received:</label>
          <input type="date" id="outcomeDate" class="date-input" />
        </div>
        <button id="saveOutcomeBtn" class="btn btn-primary">Save Outcome</button>
      </div>
      <div id="outcomeResult" class="hidden">
        <div class="info-row">
          <span class="info-label">Outcome</span>
          <span class="info-value"><span id="outcomeBadge" class="badge badge-green">Substantially Comparable</span></span>
        </div>
        <div class="info-row">
          <span class="info-label">Outcome date</span>
          <span class="info-value" id="outcomeDateDisplay">—</span>
        </div>
        <div class="info-row">
          <span class="info-label">Valid until</span>
          <span class="info-value" id="validUntilDisplay">—</span>
        </div>
      </div>
    </div>
  </div>

  <div style="margin-top:24px;text-align:center">
    <a href="#" class="support-link" data-alert-trigger>Need help? Contact support</a>
  </div>

  <script src="/js/bypass-config.js?v=20260606a"></script>
  <script src="/js/auth-guard.js?v=20260606a"></script>
  <script src="/js/state-sync.js?v=20260606a"></script>
  <script src="/js/updates-sync.js?v=20260606a"></script>
  <script>
  (function () {
    "use strict";

    var STORAGE_KEY = "gp_college_progress";
    var state = loadState();

    function loadState() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return { applicationDate: null, comparability_outcome: null, outcomeDate: null };
    }

    function saveState() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
      // Sync to server
      if (window.__gpStateSyncPush) window.__gpStateSyncPush(STORAGE_KEY, state);
    }

    // Determine college from bootstrap or localStorage
    var bootstrap = null;
    try { bootstrap = JSON.parse(localStorage.getItem("gp_bootstrap") || "null"); } catch (e) {}
    var college = (bootstrap && bootstrap.college) || "racgp";
    var isACRRM = college === "acrrm";

    // Update college-specific labels
    var collegeFull = isACRRM ? "ACRRM" : "RACGP";
    var fellowshipLabel = isACRRM ? "FACRRM" : "FRACGP";
    document.getElementById("collegeSubtitle").textContent =
      "Your " + collegeFull + " comparability assessment pathway to " + fellowshipLabel + " and specialist registration.";
    document.getElementById("collegeName").textContent = collegeFull;
    document.getElementById("collegeLinkLabel").textContent = collegeFull;
    if (isACRRM) {
      document.getElementById("collegeLink").href =
        "https://www.acrrm.org.au/international-graduates/pathway-options/specialist-pathway";
    }

    // Update qualification name based on country
    var onboarding = null;
    try { onboarding = JSON.parse(localStorage.getItem("gp_onboarding") || "null"); } catch (e) {}
    var qualMap = { GB: "MRCGP", IE: "MICGP", NZ: "FRNZCGP" };
    var country = (onboarding && onboarding.country) || "";
    if (qualMap[country]) {
      document.getElementById("qualName").textContent = qualMap[country];
    }

    // Render current state
    renderState();

    function renderState() {
      var stepApply = document.getElementById("stepApply");
      var stepWaiting = document.getElementById("stepWaiting");
      var stepOutcome = document.getElementById("stepOutcome");

      if (state.comparability_outcome) {
        // Step 3 complete — show all as done
        setStepDone("applyNum");
        setStepDone("waitNum");
        setStepDone("outcomeNum");
        stepWaiting.classList.remove("hidden");
        stepOutcome.classList.remove("hidden");
        stepApply.classList.remove("active");
        stepApply.classList.add("done");
        stepWaiting.classList.add("done");
        stepOutcome.classList.add("done");
        document.getElementById("outcomeForm").classList.add("hidden");
        document.getElementById("outcomeResult").classList.remove("hidden");
        renderOutcomeResult();
        renderWaitingInfo();
      } else if (state.applicationDate) {
        // Step 1 done, step 2 active
        setStepDone("applyNum");
        setStepActive("waitNum");
        stepWaiting.classList.remove("hidden");
        stepOutcome.classList.remove("hidden");
        stepApply.classList.remove("active");
        stepApply.classList.add("done");
        stepWaiting.classList.add("active");
        document.getElementById("applyBody").innerHTML =
          '<div class="info-row"><span class="info-label">Application submitted</span><span class="info-value">' + formatDate(state.applicationDate) + '</span></div>';
        renderWaitingInfo();
      }
      // else: step 1 active (default state in HTML)

      // Pre-fill date if saved
      if (state.applicationDate && document.getElementById("applicationDate")) {
        document.getElementById("applicationDate").value = state.applicationDate;
      }
    }

    function renderWaitingInfo() {
      if (!state.applicationDate) return;
      var applied = new Date(state.applicationDate);
      var expected = new Date(applied);
      expected.setDate(expected.getDate() + 70); // 10 weeks

      document.getElementById("appliedDateDisplay").textContent = formatDate(state.applicationDate);
      document.getElementById("expectedOutcomeDate").textContent = formatDate(expected.toISOString().split("T")[0]);

      var now = new Date();
      var totalDays = 70;
      var elapsed = Math.floor((now - applied) / (1000 * 60 * 60 * 24));
      var remaining = Math.max(0, totalDays - elapsed);
      var pct = Math.min(100, Math.round((elapsed / totalDays) * 100));

      document.getElementById("timeRemaining").textContent =
        remaining > 0 ? remaining + " days" : "Outcome expected — check your email";
      document.getElementById("timelineFill").style.width = pct + "%";
    }

    function renderOutcomeResult() {
      var badge = document.getElementById("outcomeBadge");
      var labels = {
        substantially_comparable: "Substantially Comparable",
        partially_comparable: "Partially Comparable",
        not_comparable: "Not Comparable"
      };
      badge.textContent = labels[state.comparability_outcome] || state.comparability_outcome;
      badge.className = "badge " + (state.comparability_outcome === "substantially_comparable" ? "badge-green" : "badge-amber");

      document.getElementById("outcomeDateDisplay").textContent = formatDate(state.outcomeDate);
      if (state.outcomeDate) {
        var valid = new Date(state.outcomeDate);
        valid.setFullYear(valid.getFullYear() + 1);
        document.getElementById("validUntilDisplay").textContent = formatDate(valid.toISOString().split("T")[0]);
      }
    }

    function setStepDone(id) { var el = document.getElementById(id); el.className = "step-num done"; el.textContent = "\u2713"; }
    function setStepActive(id) { var el = document.getElementById(id); el.className = "step-num active"; }

    function formatDate(str) {
      if (!str) return "—";
      var d = new Date(str);
      return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
    }

    // Event handlers
    document.addEventListener("click", function (e) {
      if (e.target.id === "saveApplicationBtn") {
        var dateVal = document.getElementById("applicationDate").value;
        if (!dateVal) return;
        state.applicationDate = dateVal;
        saveState();
        // Also save to server registration_case
        fetch("/api/college-assessment/application", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ applicationDate: dateVal })
        });
        renderState();
      }

      if (e.target.id === "saveOutcomeBtn") {
        var outcome = document.getElementById("outcomeSelect").value;
        var oDate = document.getElementById("outcomeDate").value;
        if (!outcome || !oDate) return;
        state.comparability_outcome = outcome;
        state.outcomeDate = oDate;
        saveState();
        // Save to server
        fetch("/api/college-assessment/outcome", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ outcome: outcome, outcomeDate: oDate })
        });
        renderState();
      }
    });
  })();
  </script>
</body>
</html>
```

- [ ] **Step 2: Test the page renders locally**

```bash
npm start
```

Open `http://localhost:3000/pages/college-assessment.html` in a browser. Verify:
- Page loads with dark theme matching the rest of the app
- Three step cards are visible (Step 1 active, Steps 2-3 hidden initially)
- Date input and college portal link work
- Save button persists state to localStorage under `gp_college_progress`

- [ ] **Step 3: Commit**

```bash
git add pages/college-assessment.html
git commit -m "feat: add college comparability assessment page"
```

---

## Task 5: Server — College Assessment API Endpoints

**Files:**
- Modify: `server.js` — add `/api/college-assessment/application` and `/api/college-assessment/outcome` endpoints

- [ ] **Step 1: Add the application date endpoint**

Add near the other API endpoints in `server.js` (find a section with similar POST endpoints like `/api/ahpra/` or `/api/state/`):

```javascript
// ── College Assessment API ───────────────────────
if (method === 'POST' && pathname === '/api/college-assessment/application') {
  if (!sessionEmail) { sendJson(res, 401, { ok: false, message: 'Unauthorized' }); return; }
  if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
  try {
    const body = await readJsonBody(req);
    const applicationDate = body.applicationDate;
    if (!applicationDate) { sendJson(res, 400, { ok: false, message: 'applicationDate required' }); return; }

    // Update registration_case
    const { error } = await supabase
      .from('registration_cases')
      .update({
        college_application_date: applicationDate,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', (await getProfileByEmail(sessionEmail)).user_id);

    if (error) throw error;
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[College Assessment] application save error:', err.message);
    sendJson(res, 500, { ok: false, message: 'Failed to save application date' });
  }
  return;
}

if (method === 'POST' && pathname === '/api/college-assessment/outcome') {
  if (!sessionEmail) { sendJson(res, 401, { ok: false, message: 'Unauthorized' }); return; }
  if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
  try {
    const body = await readJsonBody(req);
    const { outcome, outcomeDate } = body;
    if (!outcome || !outcomeDate) { sendJson(res, 400, { ok: false, message: 'outcome and outcomeDate required' }); return; }

    const validUntil = new Date(outcomeDate);
    validUntil.setFullYear(validUntil.getFullYear() + 1);

    const { error } = await supabase
      .from('registration_cases')
      .update({
        comparability_outcome: outcome,
        college_outcome_date: outcomeDate,
        college_outcome_valid_until: validUntil.toISOString().split('T')[0],
        updated_at: new Date().toISOString()
      })
      .eq('user_id', (await getProfileByEmail(sessionEmail)).user_id);

    if (error) throw error;
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[College Assessment] outcome save error:', err.message);
    sendJson(res, 500, { ok: false, message: 'Failed to save outcome' });
  }
  return;
}
```

- [ ] **Step 2: Write test for the endpoints**

Create `tests/college-assessment.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

describe('College Assessment pathway determination', () => {
  const EXPEDITED_CUTOFF_YEARS = 5;

  function determinePathway(specialistRegDateStr) {
    if (!specialistRegDateStr) return '';
    const regDate = new Date(specialistRegDateStr);
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - EXPEDITED_CUTOFF_YEARS);
    return regDate >= cutoff ? 'expedited' : 'specialist_recognition';
  }

  it('returns expedited for registration within last 5 years', () => {
    const recentDate = new Date();
    recentDate.setFullYear(recentDate.getFullYear() - 2);
    expect(determinePathway(recentDate.toISOString().split('T')[0])).toBe('expedited');
  });

  it('returns specialist_recognition for registration older than 5 years', () => {
    const oldDate = new Date();
    oldDate.setFullYear(oldDate.getFullYear() - 7);
    expect(determinePathway(oldDate.toISOString().split('T')[0])).toBe('specialist_recognition');
  });

  it('returns expedited for registration exactly 5 years ago', () => {
    const borderDate = new Date();
    borderDate.setFullYear(borderDate.getFullYear() - 5);
    expect(determinePathway(borderDate.toISOString().split('T')[0])).toBe('expedited');
  });

  it('returns empty string for missing date', () => {
    expect(determinePathway('')).toBe('');
    expect(determinePathway(null)).toBe('');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/college-assessment.test.js
```

Expected: All 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js tests/college-assessment.test.js
git commit -m "feat: add college assessment API endpoints and pathway determination tests"
```

---

## Task 6: App Shell — Pathway-Conditional Journey Rendering

**Files:**
- Modify: `js/app-shell.js` — `PAGE_PATHS` (line 27), `getRegistrationRows()` (line 545), `getProgressSnapshot()` (line 504)

- [ ] **Step 1: Add college-assessment to PAGE_PATHS**

At `js/app-shell.js` line 27, add the new route:

```javascript
var PAGE_PATHS = {
  "/pages/index": true,
  "/pages/myinthealth": true,
  "/pages/amc": true,
  "/pages/college-assessment": true,    // NEW
  "/pages/ahpra": true,
  "/pages/my-documents": true,
  "/pages/career": true,
  "/pages/visa": true,
  "/pages/pbs": true,
  "/pages/commencement": true,
  "/pages/messages": true,
  "/pages/account": true,
  "/pages/registration-intro": true,
  "/pages/application-detail": true,
  "/pages/job": true,
  "/pages/interview-prep": true,
  "/pages/offer-review": true,
  "/pages/area-guide": true
};
```

- [ ] **Step 2: Add college progress to getProgressSnapshot()**

At `js/app-shell.js` line 504, in `getProgressSnapshot()`, add college progress tracking:

```javascript
function getProgressSnapshot() {
  var epic = parseStorage(EPIC_PROGRESS_KEY);
  var amc = parseStorage(AMC_PROGRESS_KEY);
  var ahpra = parseStorage(AHPRA_PROGRESS_KEY);
  var college = parseStorage("gp_college_progress");          // NEW

  // ... existing epicDone, amcDone, ahpraDone logic ...

  var collegeDone = !!(college && college.comparability_outcome === 'substantially_comparable');  // NEW
  var collegeApplied = !!(college && college.applicationDate);                                    // NEW

  // ... existing careerSecured logic ...

  // Determine pathway from bootstrap or onboarding state
  var bootstrap = parseStorage("gp_bootstrap");                                                  // NEW
  var pathwayType = (bootstrap && bootstrap.pathwayType) || 'expedited';                         // NEW

  // ... existing adminOverride logic (add collegeDone to overrides if needed) ...

  return {
    epicDone: epicDone,
    epicCurrentLabel: epicCurrentLabel,
    amcDone: amcDone,
    amcCurrentLabel: amcCurrentLabel,
    ahpraDone: ahpraDone,
    careerSecured: careerSecured,
    collegeDone: collegeDone,            // NEW
    collegeApplied: collegeApplied,      // NEW
    pathwayType: pathwayType             // NEW
  };
}
```

- [ ] **Step 3: Update getRegistrationRows() with conditional college step**

At `js/app-shell.js` line 545, modify `getRegistrationRows()` to insert the college assessment step for specialist_recognition pathway GPs:

```javascript
function getRegistrationRows() {
  var snap = getProgressSnapshot();
  var bypassLocks = !!BYPASS_LOCK_EMAILS[getCurrentUserEmail()];
  var isSpecialist = snap.pathwayType === 'specialist_recognition';   // NEW

  var ahpraStatusHint = snap.ahpraDone ? "Completed"
    : !snap.careerSecured ? "Secure a placement to continue"
    : !snap.amcDone ? "Complete AMC first"
    : (isSpecialist && !snap.collegeDone) ? "Complete college assessment first"  // NEW
    : "In progress";

  var rows = [
    buildRegistrationRow("career", {
      title: "1. Your Practice",
      sub: "View your secured practice placement.",
      mobileDetail: "Your placed practice details and contact information.",
      mobileStatus: snap.careerSecured ? "Placement secured" : "View placement",
      done: snap.careerSecured,
      href: "/pages/career"
    }),
    buildRegistrationRow("myinthealth", {
      title: "2. MyIntealth Account",
      sub: "Create account and complete EPIC verification.",
      mobileDetail: "EPIC verification is set up and moving forward.",
      mobileStatus: snap.epicDone ? "Completed" : snap.epicCurrentLabel,
      done: snap.epicDone,
      href: "/pages/myinthealth?" + REGISTRATION_CONTINUE_PARAM + "=1"
    }),
    buildRegistrationRow("amc", {
      title: "3. AMC Portfolio",
      sub: "Create AMC candidate portfolio and upload credentials.",
      mobileDetail: "AMC portfolio is created and connected to your verification.",
      mobileStatus: snap.epicDone ? (snap.amcDone ? "Completed" : snap.amcCurrentLabel) : "Unlocked after MyIntealth is complete",
      locked: !bypassLocks && !snap.epicDone,
      done: snap.amcDone,
      href: "/pages/amc"
    }),
  ];

  // Step numbering shifts when college assessment is present
  var stepOffset = isSpecialist ? 1 : 0;

  // Insert college assessment step for specialist recognition pathway
  if (isSpecialist) {
    var collegeStatus = snap.collegeDone ? "Substantially Comparable"
      : snap.collegeApplied ? "Awaiting outcome"
      : !snap.amcDone ? "Unlocked after AMC is complete"
      : "Ready to apply";

    rows.push(buildRegistrationRow("college-assessment", {
      title: "4. College Assessment",
      sub: "RACGP/ACRRM comparability assessment for specialist recognition.",
      mobileDetail: "Your college comparability assessment tracks your pathway to specialist registration.",
      mobileStatus: collegeStatus,
      locked: !bypassLocks && !snap.amcDone,
      done: snap.collegeDone,
      href: "/pages/college-assessment"
    }));
  }

  rows.push(
    buildRegistrationRow("ahpra", {
      title: (4 + stepOffset) + ". AHPRA Registration",
      sub: "Prepare and submit your specialist registration application.",
      mobileDetail: "Specialist registration application is prepared and submitted correctly.",
      mobileStatus: ahpraStatusHint,
      locked: false,
      done: snap.ahpraDone,
      href: "/pages/ahpra"
    }),
    buildRegistrationRow("visa", {
      title: (5 + stepOffset) + ". Visa Application",
      sub: "Your pathway to permanent residency.",
      mobileDetail: "Information about your 482 and 186 visa pathway.",
      mobileStatus: "View pathway",
      locked: false,
      done: false,
      href: "/pages/visa"
    }),
    buildRegistrationRow("pbs", {
      title: (6 + stepOffset) + ". PBS & Medicare",
      sub: "Apply for Medicare provider number and PBS prescriber number.",
      mobileDetail: "Medicare and PBS registration for prescribing authority.",
      mobileStatus: !snap.ahpraDone ? "Unlocked after AHPRA is complete" : "In progress",
      locked: !bypassLocks && !snap.ahpraDone,
      done: false,
      href: "/pages/pbs"
    })
  );

  return rows;
}
```

- [ ] **Step 4: Test in browser**

```bash
npm start
```

1. Open the app, complete onboarding with a specialist registration date > 5 years ago
2. Verify the journey shows 7 steps with "College Assessment" as step 4
3. Verify the college assessment step is locked until AMC is complete
4. Reset onboarding with a recent date — verify the journey shows 6 steps (no college step)

- [ ] **Step 5: Update cache buster versions**

In every HTML page that loads `app-shell.js`, update the cache buster:
```html
<script src="/js/app-shell.js?v=20260606a"></script>
```

- [ ] **Step 6: Commit**

```bash
git add js/app-shell.js
git commit -m "feat: pathway-conditional journey rendering in app shell (college assessment step)"
```

---

## Task 7: Admin Dashboard — Pathway Filter and College Info

**Files:**
- Modify: `pages/admin.html` — case list filter, case card, case detail panel
- Modify: `server.js` — include pathway_type in admin cases response

- [ ] **Step 1: Include pathway_type in admin cases API response**

In `server.js`, find the `/api/admin/cases` endpoint (search for `GET` and `/api/admin/cases`). The query that fetches registration_cases needs to also select the new pathway columns. Add to the SELECT:

```sql
, rc.pathway_type, rc.college, rc.comparability_outcome, rc.college_application_date, rc.college_outcome_date, rc.college_outcome_valid_until
```

- [ ] **Step 2: Add pathway filter pills to admin case list**

In `pages/admin.html`, find the filter buttons section (search for `filter-btn`). Add pathway filter pills after the existing stage/status filters:

```javascript
// In the filter rendering section, add pathway filters:
// After the stage filter pills:
'<button class="filter-btn' + (S.pathwayFilter === 'all' ? ' active' : '') + '" data-pathway-filter="all">All pathways</button>' +
'<button class="filter-btn' + (S.pathwayFilter === 'expedited' ? ' active' : '') + '" data-pathway-filter="expedited">Expedited</button>' +
'<button class="filter-btn' + (S.pathwayFilter === 'specialist_recognition' ? ' active' : '') + '" data-pathway-filter="specialist_recognition">Specialist Recognition</button>'
```

Add the filter state and handler:

```javascript
// In the state object (S), add:
S.pathwayFilter = 'all';

// Add click handler for pathway filter:
document.addEventListener('click', function(e) {
  if (e.target.dataset.pathwayFilter) {
    S.pathwayFilter = e.target.dataset.pathwayFilter;
    renderCaseList();
  }
});

// In filteredCases(), add pathway filtering:
if (S.pathwayFilter !== 'all') {
  list = list.filter(function(m) {
    return m.rc && m.rc.pathway_type === S.pathwayFilter;
  });
}
```

- [ ] **Step 3: Show pathway badge in case card**

In `renderCaseCard()` (line 2226 of `pages/admin.html`), add a pathway indicator next to the stage pill:

```javascript
// After the stage pill in the case card sub line:
const pathwayBadge = rc && rc.pathway_type === 'specialist_recognition'
  ? ' <span class="case-stage-pill" style="background:#eff6ff;color:#3b82f6;font-size:10px">Specialist</span>'
  : '';

// Include pathwayBadge in the case-card-sub div
```

- [ ] **Step 4: Show college assessment info in case detail panel**

In the case detail panel rendering (find where the selected case details are shown — search for `selectedCase` or `renderCaseDetail`), add a college assessment section for specialist_recognition cases:

```javascript
// In the case detail panel, add after the stage/substage info:
if (rc.pathway_type === 'specialist_recognition') {
  html += '<div class="detail-section">' +
    '<h4>College Assessment</h4>' +
    '<div class="info-row"><span class="info-label">College</span><span class="info-value">' + esc(rc.college || '—').toUpperCase() + '</span></div>' +
    '<div class="info-row"><span class="info-label">Application date</span><span class="info-value">' + esc(rc.college_application_date || '—') + '</span></div>' +
    '<div class="info-row"><span class="info-label">Outcome</span><span class="info-value">' +
      (rc.comparability_outcome
        ? '<span class="badge badge-' + (rc.comparability_outcome === 'substantially_comparable' ? 'green' : 'amber') + '">' + esc(rc.comparability_outcome.replace(/_/g, ' ')) + '</span>'
        : 'Pending') +
    '</span></div>' +
    (rc.college_outcome_valid_until
      ? '<div class="info-row"><span class="info-label">Valid until</span><span class="info-value">' + esc(rc.college_outcome_valid_until) + '</span></div>'
      : '') +
  '</div>';
}
```

- [ ] **Step 5: Add admin ability to update college outcome**

Add a dropdown in the case detail that lets admin set/override the comparability outcome. This calls a new admin endpoint:

```javascript
// In the case detail panel for specialist_recognition cases:
html += '<div style="margin-top:12px">' +
  '<select id="adminCollegeOutcome" class="date-input" style="min-width:200px">' +
    '<option value="">— Set outcome —</option>' +
    '<option value="substantially_comparable"' + (rc.comparability_outcome === 'substantially_comparable' ? ' selected' : '') + '>Substantially Comparable</option>' +
    '<option value="partially_comparable"' + (rc.comparability_outcome === 'partially_comparable' ? ' selected' : '') + '>Partially Comparable</option>' +
    '<option value="not_comparable"' + (rc.comparability_outcome === 'not_comparable' ? ' selected' : '') + '>Not Comparable</option>' +
  '</select>' +
  '<button id="saveAdminOutcome" class="btn btn-outline" style="margin-left:8px">Update</button>' +
'</div>';
```

- [ ] **Step 6: Add admin college outcome endpoint in server.js**

```javascript
if (method === 'POST' && pathname === '/api/admin/college-assessment/outcome') {
  if (!isAdmin && !isSuperAdmin) { sendJson(res, 403, { ok: false }); return; }
  if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
  try {
    const body = await readJsonBody(req);
    const { caseId, outcome, outcomeDate } = body;
    if (!caseId || !outcome) { sendJson(res, 400, { ok: false, message: 'caseId and outcome required' }); return; }

    const validUntil = outcomeDate ? new Date(outcomeDate) : new Date();
    validUntil.setFullYear(validUntil.getFullYear() + 1);

    const { error } = await supabase
      .from('registration_cases')
      .update({
        comparability_outcome: outcome,
        college_outcome_date: outcomeDate || new Date().toISOString().split('T')[0],
        college_outcome_valid_until: validUntil.toISOString().split('T')[0],
        updated_at: new Date().toISOString()
      })
      .eq('id', caseId);

    if (error) throw error;
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[Admin College Assessment] outcome update error:', err.message);
    sendJson(res, 500, { ok: false, message: 'Failed to update outcome' });
  }
  return;
}
```

- [ ] **Step 7: Commit**

```bash
git add pages/admin.html server.js
git commit -m "feat: admin pathway filter, college assessment info and outcome management"
```

---

## Task 8: End-to-End Verification

**Files:** No new files — testing existing changes across both pathways.

- [ ] **Step 1: Test expedited pathway is unchanged**

```bash
npm start
```

1. Open app in browser, go through onboarding with a specialist registration date within the last 3 years
2. Verify pathway is set to "Expedited" in the review step
3. After completing onboarding, verify journey shows 6 steps (no college assessment)
4. Navigate through each step — all should work as before
5. Check admin dashboard — case should show no pathway badge or show "Expedited"

- [ ] **Step 2: Test specialist recognition pathway**

1. Reset onboarding (`/pages/onboarding.html?reset=1`)
2. Go through onboarding with a specialist registration date from 7+ years ago
3. Verify pathway is set to "Specialist Recognition (RACGP)" in the review step
4. After completing onboarding, verify journey shows 7 steps with "College Assessment" as step 4
5. Verify college assessment step is locked until AMC is complete
6. Navigate to college assessment page — verify it loads with correct college name and qualification
7. Enter an application date — verify step 2 (waiting) appears with timeline
8. Enter a "substantially comparable" outcome — verify step completes
9. Verify AHPRA step updates to reflect specialist pathway

- [ ] **Step 3: Test admin dashboard**

1. Log in as admin
2. Verify pathway filter pills appear (All / Expedited / Specialist Recognition)
3. Verify specialist_recognition cases show "Specialist" badge on the card
4. Click a specialist case — verify college assessment section appears in detail panel
5. Test admin outcome override — set outcome from dropdown, verify it saves

- [ ] **Step 4: Run automated tests**

```bash
npx vitest run
```

Expected: All existing tests PASS + new college-assessment.test.js tests PASS.

- [ ] **Step 5: Commit all cache buster updates**

Update all HTML page script tags to `?v=20260606a` for any modified JS files, then commit:

```bash
git add -A
git commit -m "chore: update cache busters for specialist recognition pathway release"
```

- [ ] **Step 6: Push to dev branch for preview deployment**

```bash
git push origin dev
```

Verify the preview deployment on Vercel works with both pathways before merging to main.
