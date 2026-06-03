# AMC RSO SOP — Design Spec

**Date:** 2026-06-03
**Author:** GP Link Operations
**Format:** Scribe guide, placed in admin AMC stage guides section
**Audience:** RSOs (Registration Support Officers) — onboarding training and day-to-day reference
**Tone:** Practical and direct
**Terminology:** "RSO" throughout

---

## Scope

Covers the AMC stage (Australian Medical Council Candidate Portfolio) only. Does not cover:
- Manual stage overrides (admin-only operations)
- Support ticket handling (covered in separate SOP)

## Structure

### Section 1: Overview & Quick Reference

1. **What is AMC?** — Second stage of the GP registration journey. Handles credential verification through the AMC Candidate Portfolio. GPs create an account, upload their qualifications, and wait for AMC to verify.
2. **Why it matters** — Prerequisite for AHPRA. GPs cannot begin AHPRA registration until AMC verifies their qualifications.
3. **The MyIntealth ID gate** — Before GPs can access the AMC page, they must enter their MyIntealth ID (a 6-8 digit code found on their MyIntealth dashboard). This gate ensures they've completed MyIntealth first.
4. **The 2 substeps:**
   - Step 1: Create Portfolio (create AMC account, confirm login — ~5-10 min)
   - Step 2: Upload Credentials (upload primary medical degree + specialist qualification, country-specific — ~10-20 min)
5. **Qualification requirements by country:**
   - UK (GB): MRCGP Certificate + Primary Medical Degree
   - Ireland (IE): MICGP Certificate + Primary Medical Degree
   - New Zealand (NZ): FRNZCGP Certificate + Primary Medical Degree
6. **External portal URLs:**
   - Signup: `https://account.amc.org.au/sign_up`
   - Main portal: `https://www.amc.org.au`
7. **Quick-reference table:** substep → what GP does → what RSO monitors → typical duration

### Section 2: Substep Walkthroughs (Monitoring + Troubleshooting)

#### 2a. Create Portfolio
- What GP does: creates AMC Candidate Portfolio account, confirms login
- What RSO sees: substage = `create_portfolio`
- Common issues: GP doesn't know where to sign up, confusion between AMC and MyIntealth, account creation errors
- Troubleshooting actions

#### 2b. Upload Credentials
- What GP does: uploads primary medical degree + country-specific specialist qualification
- What RSO sees: substage = `upload_credentials`
- Country-specific guidance (which docs per country)
- Common issues: wrong documents uploaded, missing primary medical degree, poor scan quality
- Troubleshooting actions

#### 2c. MyIntealth ID Gate
- What the gate is: GP must enter their 6-8 digit MyIntealth ID to access AMC
- Where to find it: MyIntealth dashboard, top-right corner
- Common issues: GP can't find the ID, enters wrong format, confusion about what it is
- How RSO helps: walk GP through finding the ID via WhatsApp or nudge

### Section 3: Communication Playbook

#### 3a. Nudges
- Substep-specific templates:
  - `create_portfolio` → "Need help creating your AMC portfolio?"
  - `upload_credentials` → "Stuck uploading AMC credentials?"
  - `waiting_verification` → "Waiting on AMC verification?"
- How to send, what GP receives, monitoring replies

#### 3b. WhatsApp (DoubleTick)
- Same pattern as MyIntealth: check substep before responding, country-specific advice for doc queries

#### 3c. Email
- Same pattern as MyIntealth: link to AMC portal, reference tutorial videos

### Section 4: Chasing AMC Verification

- What happens after upload: AMC reviews credentials externally (RSO/GP cannot speed this up)
- Auto-chase: system creates high-priority chase task if GP stalled 14+ days
- What to do: send "Waiting on AMC verification?" nudge, offer to help chase, document in case notes
- What completion looks like: `qualifications_verified` = true, all AMC tasks auto-close, WhatsApp + email sent to GP, AHPRA unlocks

### Section 5: Support Tickets

Brief note: refer to separate Support Ticket Handling SOP.

---

## Out of Scope

- Manual stage overrides
- Support ticket handling procedures
- MyIntealth, AHPRA, PBS, Commencement stages
