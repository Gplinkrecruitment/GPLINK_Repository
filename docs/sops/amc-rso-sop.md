# AMC — RSO Standard Operating Procedure

**Version:** 1.0
**Effective Date:** June 2026
**Owner:** GP Link Operations
**Applies to:** All RSOs (Registration Support Officers) managing GPs through the AMC stage

---

## 1. Overview

### What is AMC?

AMC is the second stage of the GP registration journey. It stands for **Australian Medical Council** — the body responsible for verifying that a GP's overseas qualifications are recognised for practice in Australia.

During this stage, GPs create an **AMC Candidate Portfolio** account, upload their qualification certificates and primary medical degree, and wait for AMC to verify their credentials. Once AMC verifies the qualifications, the GP can proceed to AHPRA registration.

All GP-facing work happens on the **external AMC platform**:
- Account creation: `https://account.amc.org.au/sign_up`
- Main portal: `https://www.amc.org.au`

GP Link tracks the GP's progress and provides support. The RSO cannot perform actions inside the AMC portal, but can help GPs prepare the right documents and chase verification when it's delayed.

### Prerequisites

AMC is unlocked after MyIntealth. Before a GP can access the AMC page in GP Link, they must pass the **MyIntealth ID gate** — a prompt that asks for their 6-8 digit MyIntealth ID (found on their MyIntealth dashboard, top-right corner). This confirms they have a verified MyIntealth account.

### The 2 Substeps

| Step | Name | What the GP Does | Typical Duration |
|------|------|-------------------|------------------|
| 1 | **Create Portfolio** | Creates an AMC Candidate Portfolio account and confirms login access | 5–10 minutes |
| 2 | **Upload Credentials** | Uploads primary medical degree and specialist qualification certificate | 10–20 minutes |

Each step has a tutorial video (2-minute walkthrough). If a GP is unsure what to do, point them to the video for their current step.

### Qualification Requirements by Country

The documents a GP uploads in Step 2 depend on where they trained. Check the GP's country in the profile bar before advising.

**United Kingdom (GB)**
- MRCGP Certificate (Membership of the Royal College of General Practitioners)
- Primary Medical Degree

**Ireland (IE)**
- MICGP Certificate (Member of the Irish College of General Practitioners)
- Primary Medical Degree

**New Zealand (NZ)**
- FRNZCGP Certificate (Fellow of the Royal New Zealand College of General Practitioners)
- Primary Medical Degree

These are the same documents required during MyIntealth — the GP uploads them again to AMC's own system so AMC can independently verify them.

### Quick Reference

| Substep | Admin Dashboard Shows | RSO Action |
|---------|----------------------|------------|
| Create Portfolio | Substage: `create_portfolio` | Monitor activity, nudge if inactive 3+ days |
| Upload Credentials | Substage: `upload_credentials` | Check correct docs for country, nudge if inactive 3+ days |
| Waiting on Verification | Substage: `waiting_verification` | Monitor, chase if stalled 14+ days |

> **[Scribe: Insert screenshot]** Admin dashboard showing a GP in the AMC stage — profile bar with country, journey rail with AMC highlighted, and stage badge visible.

---

## 2. Substep Walkthroughs

### 2a. Create Portfolio

**What the GP is doing:**
The GP creates their AMC Candidate Portfolio account at `https://account.amc.org.au/sign_up` and confirms they can log in. This is a straightforward account creation — name, email, password.

**What the RSO sees in the admin dashboard:**
- The GP's stage badge shows **AMC**
- The substage is **create_portfolio**
- The journey rail highlights AMC as the current stage

**How to monitor:**
- Check `last_gp_activity_at`. If no activity for 3+ days, the GP may be stuck or hasn't started.
- A GP who just completed MyIntealth but hasn't moved on AMC may not realise the next step is available.

**Common issues:**

| Issue | What's happening | What to do |
|-------|-----------------|------------|
| GP hasn't started | They finished MyIntealth but don't know AMC is next | Send a nudge. The GP should have received an automated WhatsApp and email when MyIntealth completed, but they may have missed it. |
| GP confused between AMC and MyIntealth | They think MyIntealth covered everything | Explain that AMC is a separate body — MyIntealth verified their identity, AMC verifies their qualifications for Australian practice. |
| Account creation errors | Email already registered, password issues | Advise GP to try the AMC password reset flow. If that fails, direct them to AMC support. The RSO cannot resolve issues inside the AMC portal. |
| GP blocked by the MyIntealth ID gate | Can't get past the ID prompt on the AMC page | See Section 2c below. |

**Troubleshooting steps:**
1. Check that MyIntealth is complete (the GP's journey rail should show MyIntealth with a tick).
2. Send a substep-specific nudge — the system will send: "Need help creating your AMC portfolio?"
3. If the GP responds, direct them to the signup URL and the Step 1 tutorial video.
4. For AMC portal issues, advise them to contact AMC support directly.

> **[Scribe: Insert screenshot]** Admin dashboard view of a GP at the `create_portfolio` substep.

---

### 2b. Upload Credentials

**What the GP is doing:**
The GP logs into their AMC Candidate Portfolio and uploads their qualification certificates — their **primary medical degree** and their **specialist qualification certificate** (which varies by country).

**What the RSO sees in the admin dashboard:**
- The substage is **upload_credentials**
- The GP's country is visible in the profile bar

**How to monitor:**
- Check `last_gp_activity_at` for inactivity.
- This step has the most room for error — the GP needs to upload the correct documents for their country.

**Country-specific guidance:**

| If the GP trained in... | They need to upload... |
|------------------------|----------------------|
| **United Kingdom (GB)** | MRCGP Certificate + Primary Medical Degree |
| **Ireland (IE)** | MICGP Certificate + Primary Medical Degree |
| **New Zealand (NZ)** | FRNZCGP Certificate + Primary Medical Degree |

**Common issues:**

| Issue | What's happening | What to do |
|-------|-----------------|------------|
| Wrong document uploaded | GP uploads a CV, reference letter, or other unrelated document | Check their country, then tell them exactly which certificate is needed. |
| Missing primary medical degree | GP uploads only their specialist certificate | Remind them that AMC requires both the specialist certificate AND their primary medical degree. |
| Poor document quality | Scan is blurry, cropped, or illegible | Ask the GP to re-scan or re-photograph. Advise: good lighting, flat surface, all corners visible, no glare. |
| GP holds multiple qualifications | Unsure which to upload | Check which country is set in their profile. They should upload the qualification matching their selected country. |
| GP doesn't know where to upload | Can't find the upload section in the AMC portal | Direct them to the Step 2 tutorial video, which walks through the AMC portal upload flow. |

**Troubleshooting steps:**
1. Check the GP's country in the profile bar.
2. Send a substep-specific nudge — the system will send: "Stuck uploading AMC credentials?"
3. If the GP responds, confirm which documents they need based on their country.
4. Remind them to upload both documents — the specialist certificate and the primary medical degree.
5. For AMC portal upload errors, advise them to contact AMC support.

> **[Scribe: Insert screenshot]** Admin dashboard view of a GP at the `upload_credentials` substep, with country visible in the profile bar.

---

### 2c. MyIntealth ID Gate

**What the gate is:**
When a GP opens the AMC page for the first time, they see a prompt asking for their **MyIntealth ID** — a 6-8 digit number. Until they enter a valid ID, they cannot see the AMC page content.

**Where to find the MyIntealth ID:**
The ID is on the GP's MyIntealth dashboard, in the top-right corner. The gate screen shows 3 steps:
1. Log in to your MyIntealth account at myintealth.com
2. Find your MyIntealth ID on the dashboard (top-right corner)
3. Enter it below to continue

**Common issues:**

| Issue | What's happening | What to do |
|-------|-----------------|------------|
| GP can't find the ID | They're logged into MyIntealth but don't see the number | Walk them through it via WhatsApp: "Log in to myintealth.com, look at the top-right corner of your dashboard — you'll see a 6-8 digit number." |
| GP enters wrong format | They enter an email, name, or password instead of the numeric ID | Clarify that the MyIntealth ID is a number (6-8 digits), not their login email or password. |
| GP hasn't completed MyIntealth | They're trying to access AMC before finishing MyIntealth | Check their journey rail. If MyIntealth isn't complete, direct them back to finish it first. |

**How the RSO helps:**
The RSO cannot bypass the gate for the GP. The GP must enter the ID themselves. The RSO's role is to guide them to find it — typically via WhatsApp or a nudge pointing them to the right place on the MyIntealth dashboard.

> **[Scribe: Insert screenshot]** The MyIntealth ID gate prompt that GPs see when they first open the AMC page.

---

## 3. Communication Playbook

### 3a. Nudges

**When to nudge:**
- The GP has been inactive on a substep for 3 or more days.
- A task related to AMC is approaching its due date with no GP activity.

**How to send a nudge:**
1. Open the GP's case in the admin dashboard.
2. Click the **Nudge** button on the GP's profile bar.
3. The system automatically selects the right message based on the GP's current substep.

**What the GP receives:**

| Substep | Nudge Message |
|---------|--------------|
| Create Portfolio | "Need help creating your AMC portfolio?" |
| Upload Credentials | "Stuck uploading AMC credentials?" |
| Waiting on Verification | "Waiting on AMC verification?" |

Each nudge is sent as:
- A **WhatsApp message** via DoubleTick
- An **email** with a link to continue the conversation
- An **in-app notification**

**After sending a nudge:**
- The nudge creates a chat thread in the admin dashboard. Monitor it for replies.
- If the GP replies, respond promptly — they're engaged and ready for help.
- If no reply after 2–3 days, consider a second nudge or a direct WhatsApp message.

> **[Scribe: Insert screenshot]** Sending a nudge from the GP's profile bar while a GP is in the AMC stage.

---

### 3b. WhatsApp (DoubleTick)

**How it works:**
- GPs can message the GP Link WhatsApp number at any time.
- Incoming messages auto-create a **whatsapp_help** task with a **24-hour due date**.

**How to respond:**
1. Click the **WhatsApp button** on the GP's profile bar to open their DoubleTick conversation.
2. Check their current substep in the admin dashboard before replying.
3. Reply directly in the DoubleTick conversation.
4. Mark the `whatsapp_help` task as complete once resolved.

**Tips for AMC WhatsApp queries:**
- If the GP is asking about the MyIntealth ID gate, walk them through finding the ID on their MyIntealth dashboard.
- If the GP is asking about documents (Step 2), check their country first.
- If the GP is asking about verification wait times, see Section 4 (Chasing AMC Verification).

> **[Scribe: Insert screenshot]** DoubleTick conversation opened from the WhatsApp button, with an AMC-related query.

---

### 3c. Email

**When to use email:**
- When the GP hasn't responded to WhatsApp nudges.
- When you need to send detailed instructions or links.

**How to send:**
1. Open any task on the GP's case.
2. Click the **three-dot menu** → **Email GP**.

**Tips for AMC emails:**
- Include the relevant AMC portal link:
  - Step 1: `https://account.amc.org.au/sign_up`
  - Step 2: `https://www.amc.org.au`
- Reference the tutorial video for their current step.
- If the GP is waiting on verification, acknowledge the wait and let them know you're monitoring it.

> **[Scribe: Insert screenshot]** Email action from the three-dot menu on an AMC task.

---

## 4. Chasing AMC Verification

### What happens after upload

Once the GP uploads their credentials in Step 2 and marks it complete, the process enters a **waiting period**. AMC reviews the submitted documents externally. Neither the RSO nor the GP can speed this up directly — it depends on AMC's processing time.

During this period:
- The GP's substage shows **waiting_verification** (or remains at `upload_credentials` depending on how they marked it)
- The GP may feel stuck because there's nothing for them to do
- The RSO's role is to monitor and reassure

### When the system flags a stall

If a GP has been in the AMC stage for **14 or more days** without progress, the system automatically creates a high-priority **chase task**:
- Title: "Weekly check-in — GP stalled 14+ days on AMC"
- Description: "GP has not progressed in 14+ days. Reach out via WhatsApp or send an in-app nudge."
- The system also sends the GP a stalled reminder email.

This chase task only gets created once every 7 days to avoid spamming.

### What to do

1. **Send a nudge** — the system will send: "Waiting on AMC verification? We can help chase this up."
2. **Check in with the GP via WhatsApp** — ask if they've received any communication from AMC. Sometimes AMC sends requests for additional documents directly to the GP, and the GP doesn't realise they need to act.
3. **Document in case notes** — log when you last checked, what the GP said, and any actions taken. This creates an audit trail and helps the next RSO if the case is handed over.
4. **Set a follow-up date** — if the GP confirms they're just waiting, set a follow-up date for 7 days out so the case doesn't fall through the cracks.

### What AMC completion looks like

When AMC verifies the GP's qualifications (`qualifications_verified` = true):
- All open AMC tasks are **automatically closed**
- The GP receives an automated **WhatsApp message** and **email** confirming AMC is complete and introducing the next stage
- The **AHPRA stage unlocks** on the GP's journey rail
- The GP's stage badge in the admin dashboard updates accordingly

The RSO does not need to manually trigger this transition — it happens automatically. After completion, check that the GP has received their notifications and understands they can now proceed to AHPRA.

> **[Scribe: Insert screenshot]** Admin dashboard showing a GP whose AMC has just completed — journey rail with AMC ticked, AHPRA now current.

---

## 5. Support Tickets

For support ticket handling procedures, refer to the **Support Ticket Handling SOP**.

---

*Last updated: June 2026*
