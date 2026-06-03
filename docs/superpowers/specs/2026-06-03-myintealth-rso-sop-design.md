# MyIntealth RSO SOP — Design Spec

**Date:** 2026-06-03
**Author:** GP Link Operations
**Format:** Scribe guide, placed in admin MyIntealth stage guides section
**Audience:** RSOs (Registration Support Officers) — serves as both onboarding training and day-to-day reference
**Tone:** Practical and direct ("Check X, then do Y")
**Terminology:** "RSO" throughout (not "VA")

---

## Scope

Covers the MyIntealth stage (EPIC verification) only. Does not cover:
- Verification Issued transition or manual stage overrides (admin-only operations)
- Support ticket handling (covered in separate SOP)

## Structure

### Section 1: Overview & Quick Reference

**Purpose:** Give the RSO a clear mental model of what MyIntealth is, why it matters, and what varies between GPs.

**Content:**

1. **What is MyIntealth?**
   - The first stage of the GP registration journey
   - Handles EPIC (Electronic Provider Identification and Credentialing) verification
   - GPs must create an account, verify their identity, upload qualifications, and receive official verification before proceeding to AMC
   - All GP-facing work happens on the external MyIntealth platform: `https://applicant.myintealth.app/s/`
   - GP Link tracks progress and provides support; the RSO cannot perform actions inside the external portal

2. **Why it matters**
   - Prerequisite for AMC (Australian Medical Council) — GPs cannot start AMC until MyIntealth verification is issued
   - Gateway to the full Australian registration pathway

3. **The 3 substeps at a glance**
   - Step 1: Account Creation (create MyIntealth account, complete identity verification — ~10-20 min)
   - Step 2: Account Establishment (complete NotaryCam session to establish EPIC account — ~10-20 min)
   - Step 3: Qualifications Upload (upload qualification certificates, nominate AMC as recipient — ~10-20 min)

4. **Qualification requirements by training country**

   | Country | Qualification Certificate | Also Required |
   |---------|-------------------------|---------------|
   | **UK (GB)** | MRCGP Certificate | Primary Medical Degree |
   | **Ireland (IE)** | MICGP Certificate | Primary Medical Degree |
   | **New Zealand (NZ)** | FRNZCGP Certificate | Primary Medical Degree |

   - The GP's country is set during onboarding and visible in the admin profile bar
   - The MyIntealth page dynamically shows the correct qualification label based on the GP's country
   - RSOs should check the GP's country before advising on which documents to upload

5. **Quick-reference table**

   | Substep | What the GP does | What the RSO monitors | Typical duration |
   |---------|------------------|-----------------------|------------------|
   | Account Creation | Creates MyIntealth account, completes identity verification | Substage = `create_account`, check `last_gp_activity_at` | 10-20 min |
   | Account Establishment | Completes NotaryCam session | Substage = `account_establishment` | 10-20 min |
   | Qualifications Upload | Uploads certificates, nominates AMC | Substage = `upload_qualifications` | 10-20 min |

**Scribe placeholders:** Screenshots of the admin dashboard showing a GP in the MyIntealth stage — profile bar, journey rail, and stage badge.

---

### Section 2: Substep Walkthroughs (Monitoring + Troubleshooting)

**Purpose:** For each substep, tell the RSO what to monitor and what to do when a GP is stuck.

#### 2a. Account Creation

- **What the GP is doing:** Creating their MyIntealth account and completing identity verification on the external portal
- **What the RSO sees:** GP's substage shows `create_account` in the admin dashboard
- **How to monitor:** Check `last_gp_activity_at` — if no activity for 3+ days, the GP may be stuck
- **Common issues:**
  - GP hasn't started (doesn't know what MyIntealth is or missed the instruction)
  - GP can't find the link to the external portal
  - Identity verification failing on the MyIntealth side
- **Troubleshooting actions:**
  - Send a substep-specific nudge
  - Check if onboarding was completed (GP must complete onboarding before MyIntealth makes sense)
  - Direct GP to the tutorial video (Step 1 walkthrough)
  - If the issue is with the external portal itself, advise GP to contact MyIntealth support

**Scribe placeholder:** Screenshot of admin view showing a GP at the `create_account` substep.

#### 2b. Account Establishment

- **What the GP is doing:** Completing a NotaryCam session to establish their EPIC account
- **What the RSO sees:** Substage shows `account_establishment`
- **Common issues:**
  - GP unsure what NotaryCam is or how to book a session
  - Scheduling difficulties (timezone differences for international GPs)
  - Technical issues during the video session
- **Troubleshooting actions:**
  - Send substep-specific nudge
  - Offer to walk them through the process via WhatsApp
  - Direct GP to tutorial video (Step 2 walkthrough)
  - For technical issues with NotaryCam, advise GP to contact MyIntealth support

**Scribe placeholder:** Screenshot of admin view showing a GP at the `account_establishment` substep.

#### 2c. Qualifications Upload

- **What the GP is doing:** Uploading their qualification certificates and nominating AMC as the recipient
- **What the RSO sees:** Substage shows `upload_qualifications`
- **Country-specific guidance for the RSO:**
  - UK GP → needs to upload MRCGP certificate + primary medical degree
  - Irish GP → needs to upload MICGP certificate + primary medical degree
  - NZ GP → needs to upload FRNZCGP certificate + primary medical degree
- **Common issues:**
  - GP uploads wrong document type (e.g. a CV instead of their certificate)
  - GP forgets to nominate AMC as recipient
  - Document quality too low / illegible scan
  - GP unsure which qualification to upload (especially if they hold multiple)
- **Troubleshooting actions:**
  - Check the GP's country in their profile to confirm which documents are needed
  - Guide them to the correct document type
  - Remind them about AMC nomination (critical — without it, AMC won't receive verification)
  - For upload failures on the external portal, advise GP to contact MyIntealth support

**Scribe placeholder:** Screenshot of admin view showing a GP at the `upload_qualifications` substep, with country visible in the profile bar.

---

### Section 3: Communication Playbook

**Purpose:** How to communicate with GPs about MyIntealth — nudges, WhatsApp, email.

#### 3a. Nudges (WhatsApp + In-App)

- **When to nudge:** GP has been inactive for 3+ days on a substep, or task is approaching overdue
- **How to send:** Click the Nudge button on the GP's profile bar in the admin dashboard
- **What the GP receives:** A stage-specific WhatsApp message + in-app notification. The system auto-selects the right template based on the substep:
  - `create_account` → "Need a hand creating your MyIntealth account?"
  - `account_establishment` → "Trouble establishing your MyIntealth account?"
  - `upload_qualifications` → "Stuck uploading your qualifications?"
- An email copy is also sent with a link to the nudge chat thread
- RSO can monitor replies via the nudge chat thread in the admin dashboard

#### 3b. WhatsApp (DoubleTick)

- GP can message the GP Link WhatsApp number at any time
- Incoming messages auto-create a `whatsapp_help` task with a 24-hour due date
- RSO replies via the DoubleTick conversation link (click the WhatsApp button on the GP's profile bar)
- If the GP's message is about MyIntealth, check their current substep before responding — the answer depends on where they're stuck

#### 3c. Email

- RSO can email the GP directly using the three-dot menu on any task → "Email GP"
- For MyIntealth-specific queries: link to the external portal, reference the tutorial video for their current step, and offer WhatsApp as a faster channel

**Scribe placeholders:** Screenshots of sending a nudge, the DoubleTick conversation view, and the email action from the task menu.

---

### Section 4: Support Tickets

Brief note: "For support ticket handling procedures, refer to the separate Support Ticket SOP."

---

## Out of Scope

- Verification Issued transition (internal/automated — not part of RSO daily workflow in this SOP)
- Manual stage overrides (admin-only, documented separately)
- AMC, AHPRA, PBS, Commencement stages (each would have their own SOP)
- External MyIntealth platform troubleshooting (RSO cannot act inside the portal; GP contacts MyIntealth directly)
