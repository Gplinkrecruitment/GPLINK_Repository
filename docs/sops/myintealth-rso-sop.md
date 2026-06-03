# MyIntealth — RSO Standard Operating Procedure

**Version:** 1.0
**Effective Date:** June 2026
**Owner:** GP Link Operations
**Applies to:** All RSOs (Registration Support Officers) managing GPs through the MyIntealth stage

---

## 1. Overview

### What is MyIntealth?

MyIntealth is the first stage of the GP registration journey. It handles **EPIC verification** (Electronic Provider Identification and Credentialing) — the process where GPs create an account, verify their identity, upload their qualification certificates, and receive official verification.

GPs must complete MyIntealth before they can start AMC (Australian Medical Council). Until EPIC verification is issued, the AMC stage remains locked.

All GP-facing work happens on the **external MyIntealth platform** at `https://applicant.myintealth.app/s/`. GP Link tracks the GP's progress and provides support, but the RSO cannot perform actions inside the external portal. If a GP has a technical issue with the MyIntealth platform itself, direct them to MyIntealth support.

### The 3 Substeps

MyIntealth has three substeps the GP works through in order:

| Step | Name | What the GP Does | Typical Duration |
|------|------|-------------------|------------------|
| 1 | **Account Creation** | Creates a MyIntealth account and completes identity verification | 10–20 minutes |
| 2 | **Account Establishment** | Completes a NotaryCam video session to establish their EPIC account | 10–20 minutes |
| 3 | **Qualifications Upload** | Uploads qualification certificates and nominates AMC as the recipient | 10–20 minutes |

Each step has a tutorial video the GP can watch (a 2-minute walkthrough). If a GP is unsure what to do, point them to the video for their current step.

### Qualification Requirements by Country

The documents a GP needs to upload in Step 3 depend on where they trained. Check the GP's country in the profile bar before advising on documents.

**United Kingdom (GB)**
- MRCGP Certificate (Membership of the Royal College of General Practitioners)
- Primary Medical Degree

**Ireland (IE)**
- MICGP Certificate (Member of the Irish College of General Practitioners)
- Primary Medical Degree

**New Zealand (NZ)**
- FRNZCGP Certificate (Fellow of the Royal New Zealand College of General Practitioners)
- Primary Medical Degree

Every GP needs their **primary medical degree** regardless of country. The specialist qualification certificate is what varies.

### Quick Reference

| Substep | Admin Dashboard Shows | RSO Action |
|---------|----------------------|------------|
| Account Creation | Substage: `create_account` | Monitor activity, nudge if inactive 3+ days |
| Account Establishment | Substage: `account_establishment` | Monitor activity, nudge if inactive 3+ days |
| Qualifications Upload | Substage: `upload_qualifications` | Monitor activity, check correct docs for country, nudge if inactive 3+ days |

> **[Scribe: Insert screenshot]** Admin dashboard showing a GP in the MyIntealth stage — profile bar with country, journey rail, and stage badge visible.

---

## 2. Substep Walkthroughs

### 2a. Account Creation

**What the GP is doing:**
The GP creates their MyIntealth account on the external portal and completes identity verification. This is their first interaction with the MyIntealth platform.

**What the RSO sees in the admin dashboard:**
- The GP's stage badge shows **MyIntealth**
- The substage is **create_account**
- The journey rail highlights MyIntealth as the current stage

**How to monitor:**
- Check the GP's `last_gp_activity_at` timestamp. If there has been no activity for 3 or more days, the GP is likely stuck or hasn't started.
- A GP who completed onboarding but hasn't moved on `create_account` for several days probably needs a nudge.

**Common issues:**

| Issue | What's happening | What to do |
|-------|-----------------|------------|
| GP hasn't started | They may not understand what MyIntealth is, or they missed the post-onboarding instructions | Send a nudge. Check if their onboarding is actually complete — MyIntealth won't make sense if they haven't finished onboarding. |
| GP can't find the portal link | They're looking for a link in their email or don't know where to go | Direct them to the "Open MyIntealth" button on their MyIntealth page in the GP Link app, or send them the direct link: `https://applicant.myintealth.app/s/` |
| Identity verification failing | The external portal is rejecting their identity documents | This is a MyIntealth platform issue. Advise the GP to contact MyIntealth support directly. The RSO cannot resolve issues inside the external portal. |

**Troubleshooting steps:**
1. Check that the GP has completed onboarding (their onboarding state should show as complete).
2. Send a substep-specific nudge — the system will send: "Need a hand creating your MyIntealth account?"
3. If the GP responds, direct them to the Step 1 tutorial video.
4. If the GP reports a technical issue with the external portal, advise them to contact MyIntealth support. Add a note to the case documenting the issue.

> **[Scribe: Insert screenshot]** Admin dashboard view of a GP at the `create_account` substep.

---

### 2b. Account Establishment

**What the GP is doing:**
The GP completes a NotaryCam video session to formally establish their EPIC account. NotaryCam is a remote online notarisation service — the GP joins a video call where a notary verifies their identity and witnesses document signing.

**What the RSO sees in the admin dashboard:**
- The substage is **account_establishment**
- The GP has moved past Account Creation, meaning their MyIntealth account exists

**How to monitor:**
- Check `last_gp_activity_at`. If no activity for 3+ days at this substep, the GP may need help.
- This step sometimes takes longer because the GP needs to schedule a NotaryCam session, which depends on availability and timezone.

**Common issues:**

| Issue | What's happening | What to do |
|-------|-----------------|------------|
| GP doesn't know what NotaryCam is | They're confused by the requirement for a video notarisation session | Explain that it's a short video call (~10–20 min) where a notary verifies their identity. Direct them to the Step 2 tutorial video. |
| Scheduling difficulties | Timezone differences make it hard to find a slot, especially for GPs still overseas | Acknowledge the difficulty. Suggest they check available times on the NotaryCam platform. This is outside the RSO's control but noting it in the case helps track the delay. |
| Technical issues during the session | Video call drops, camera/mic problems, browser compatibility | Advise the GP to try again with a different browser or device. If the issue persists, direct them to MyIntealth support. |

**Troubleshooting steps:**
1. Send a substep-specific nudge — the system will send: "Trouble establishing your MyIntealth account?"
2. If the GP responds confused about NotaryCam, walk them through it via WhatsApp or direct them to the tutorial video.
3. If the GP is struggling to schedule, note the delay in the case and set a follow-up date for 3–5 days out.
4. For technical failures during the NotaryCam session, advise the GP to contact MyIntealth support.

> **[Scribe: Insert screenshot]** Admin dashboard view of a GP at the `account_establishment` substep.

---

### 2c. Qualifications Upload

**What the GP is doing:**
The GP uploads their qualification certificates to the MyIntealth platform and **nominates AMC (Australian Medical Council) as the recipient**. This is the final substep before verification is issued.

**What the RSO sees in the admin dashboard:**
- The substage is **upload_qualifications**
- The GP's country is visible in the profile bar — this tells you which documents they need

**How to monitor:**
- Check `last_gp_activity_at` for inactivity.
- This substep has the most room for error because the GP needs to upload the correct documents for their country AND remember to nominate AMC.

**Country-specific guidance:**

Before advising a GP on what to upload, check their country in the profile bar.

| If the GP trained in... | They need to upload... |
|------------------------|----------------------|
| **United Kingdom (GB)** | MRCGP Certificate + Primary Medical Degree |
| **Ireland (IE)** | MICGP Certificate + Primary Medical Degree |
| **New Zealand (NZ)** | FRNZCGP Certificate + Primary Medical Degree |

**Common issues:**

| Issue | What's happening | What to do |
|-------|-----------------|------------|
| Wrong document uploaded | GP uploads a CV, reference letter, or other unrelated document instead of their qualification certificate | Check their country, then tell them exactly which certificate is needed (e.g. "You need your MRCGP certificate, not your CV"). |
| Forgot to nominate AMC | GP uploads documents but doesn't select AMC as the recipient | This is critical. Without AMC nomination, the verification won't reach AMC and the GP will be stuck. Remind the GP to go back into MyIntealth and nominate AMC. |
| Poor document quality | Scan is blurry, cropped, or illegible | Ask the GP to re-scan or re-photograph the document. Advise: good lighting, flat surface, all corners visible, no glare. |
| GP holds multiple qualifications | GP is unsure which one to upload (e.g. they have both UK and Irish qualifications) | Check which country is set in their GP Link profile. They should upload the qualification that matches their selected country. |

**Troubleshooting steps:**
1. Check the GP's country in the profile bar.
2. Send a substep-specific nudge — the system will send: "Stuck uploading your qualifications?"
3. If the GP responds, confirm which documents they need based on their country.
4. Emphasise the AMC nomination — this is the most commonly missed step and causes the most delays.
5. If the GP has upload errors on the external portal, advise them to contact MyIntealth support.

> **[Scribe: Insert screenshot]** Admin dashboard view of a GP at the `upload_qualifications` substep, with country visible in the profile bar.

---

## 3. Communication Playbook

### 3a. Nudges

**When to nudge:**
- The GP has been inactive on a substep for 3 or more days.
- A task related to MyIntealth is approaching its due date with no GP activity.

**How to send a nudge:**
1. Open the GP's case in the admin dashboard.
2. Click the **Nudge** button on the GP's profile bar.
3. The system automatically selects the right message based on the GP's current substep.

**What the GP receives:**

| Substep | Nudge Message |
|---------|--------------|
| Account Creation | "Need a hand creating your MyIntealth account?" |
| Account Establishment | "Trouble establishing your MyIntealth account?" |
| Qualifications Upload | "Stuck uploading your qualifications?" |

Each nudge is sent as:
- A **WhatsApp message** via DoubleTick
- An **email** with a link to continue the conversation
- An **in-app notification**

**After sending a nudge:**
- The nudge creates a chat thread in the admin dashboard. Monitor it for replies.
- If the GP replies, respond promptly — they're engaged and ready for help.
- If no reply after 2–3 days, consider a second nudge or a direct WhatsApp message.

> **[Scribe: Insert screenshot]** Sending a nudge from the GP's profile bar.

---

### 3b. WhatsApp (DoubleTick)

**How it works:**
- GPs can message the GP Link WhatsApp number at any time.
- When a message comes in, the system automatically creates a **whatsapp_help** task with a **24-hour due date**. This task appears in the GP's task list and in the Needs Action lane if it's urgent.

**How to respond:**
1. Click the **WhatsApp button** on the GP's profile bar. This opens their DoubleTick conversation in a new tab.
2. Read their message and check their current substep in the admin dashboard before replying.
3. Reply directly in the DoubleTick conversation.
4. Once the issue is resolved, mark the `whatsapp_help` task as complete.

**Tips for MyIntealth WhatsApp queries:**
- Always check which substep the GP is on before responding. The answer almost always depends on where they're stuck.
- If the GP is asking about documents (Step 3), check their country first so you can tell them exactly which certificates they need.
- Keep responses short and actionable. Link to the tutorial video for their current step if they need a walkthrough.

> **[Scribe: Insert screenshot]** The DoubleTick conversation view, opened from the WhatsApp button on the profile bar.

---

### 3c. Email

**When to use email:**
- When the GP hasn't responded to WhatsApp nudges.
- When the GP prefers email communication.
- When you need to send detailed instructions or links.

**How to send:**
1. Open any task on the GP's case.
2. Click the **three-dot menu** on the task card.
3. Select **Email GP**.

**Tips for MyIntealth emails:**
- Include the link to the external portal (`https://applicant.myintealth.app/s/`) if the GP needs it.
- Reference the tutorial video for their current step.
- Offer WhatsApp as a faster channel for back-and-forth questions.
- Keep it brief. GPs are more likely to act on a short, clear email than a long one.

> **[Scribe: Insert screenshot]** The email action in the three-dot menu on a task card.

---

## 4. Support Tickets

For support ticket handling procedures, refer to the **Support Ticket Handling SOP**.

---

*Last updated: June 2026*
