# AHPRA Expedited Specialist Pathway — Intro Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a welcome/intro screen to the AHPRA registration page that introduces the Expedited Specialist Pathway and gates entry on document readiness.

**Architecture:** The intro screen is injected into the existing `pages/ahpra.html` as a new view layer that appears before the tab-based registration steps. It consists of two panels: a welcome screen (always shown) and a document preparation slide-over (shown only when documents are incomplete). Both panels live inside a new container div that sits above `.reg-content`. The intro reuses the same `gp_documents_prep` / `gp_prepared_docs` localStorage keys and `COUNTRY_DOCS` data from `my-documents.html` so uploads sync bidirectionally. Once dismissed (either via "Begin Now" or after all documents are completed), a flag is set in `gp_ahpra_progress` so the intro is not shown again on subsequent visits.

**Tech Stack:** Vanilla JS/HTML/CSS (inline in `pages/ahpra.html`), localStorage, existing Supabase upload APIs.

---

### Task 1: Add Intro Screen HTML Structure

**Files:**
- Modify: `pages/ahpra.html:1512-1513` (insert new HTML block before `.reg-content`)

- [ ] **Step 1: Add the intro container HTML**

Insert the following HTML immediately **before** the `<!-- LIGHT CONTENT SURFACE -->` comment (line 1512 in `ahpra.html`). This creates the welcome panel and the document preparation slide-over panel:

```html
    <!-- AHPRA INTRO / WELCOME SCREEN -->
    <div class="ahpra-intro" id="ahpraIntro" style="display:none;">
      <!-- Blob background -->
      <div class="intro-blob-canvas">
        <div class="intro-blob intro-blob-1"></div>
        <div class="intro-blob intro-blob-2"></div>
        <div class="intro-blob intro-blob-3"></div>
      </div>

      <!-- Panel 1: Welcome -->
      <div class="intro-panel intro-panel-active" id="introWelcomePanel">
        <div class="intro-content">
          <div class="intro-pathway-badge">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Expedited Specialist Pathway
          </div>

          <h1 class="intro-title">Welcome to your AHPRA Registration</h1>
          <p class="intro-subtitle">You're on the fast track. GP Link will guide you through each step of your Expedited Specialist Pathway application — from account setup to final approval.</p>

          <div class="intro-milestones">
            <div class="intro-milestone">
              <div class="intro-milestone-icon green">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
              <div class="intro-milestone-text"><strong>Create your AHPRA account</strong> — we'll walk you through it</div>
            </div>
            <div class="intro-milestone">
              <div class="intro-milestone-icon green">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </div>
              <div class="intro-milestone-text"><strong>Submit your application</strong> — with GP Link prepared docs</div>
            </div>
            <div class="intro-milestone">
              <div class="intro-milestone-icon amber">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div class="intro-milestone-text"><strong>Track your outcome</strong> — we'll keep you updated</div>
            </div>
          </div>

          <div class="intro-cta-area" id="introCta"></div>
        </div>
      </div>

      <!-- Panel 2: Document Preparation (slide-over) -->
      <div class="intro-panel" id="introDocsPanel">
        <div class="intro-docs-header">
          <div class="intro-docs-header-top">
            <button class="intro-back-btn" id="introBackBtn" type="button">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <h2 class="intro-docs-title">Prepare Documents</h2>
          </div>
          <p class="intro-docs-sub">Upload or complete these before starting your application</p>
        </div>
        <div class="intro-docs-list" id="introDocsList"></div>
      </div>
    </div>
```

- [ ] **Step 2: Add the intro help popover HTML**

Insert this immediately after the closing `</div>` of `#ahpraIntro`, before the existing `<!-- LIGHT CONTENT SURFACE -->` comment:

```html
    <!-- INTRO HELP POPOVER -->
    <div class="help-popover-backdrop" id="introHelpBackdrop"></div>
    <div class="help-popover" id="introHelpPopover" role="dialog" aria-modal="true">
      <h4 id="introHelpTitle"></h4>
      <ol id="introHelpSteps"></ol>
      <div class="cert-note" id="introHelpCertNote" hidden></div>
      <div class="help-reminder" id="introHelpReminder" hidden></div>
      <button class="btn-modern btn-outline" id="introHelpClose" type="button" style="width:100%;justify-content:center;">Got it</button>
    </div>
```

- [ ] **Step 3: Verify the HTML is valid**

Open the dev server and check the page loads without console errors:

```bash
npm start
```

Navigate to `/pages/ahpra.html` — the intro screen should be `display:none` so the page should look identical to before.

- [ ] **Step 4: Commit**

```bash
git add pages/ahpra.html
git commit -m "feat: add AHPRA intro screen HTML structure"
```

---

### Task 2: Add Intro Screen CSS

**Files:**
- Modify: `pages/ahpra.html` (add CSS inside the existing `<style>` block, before the closing `</style>` tag around line 1490)

- [ ] **Step 1: Add the intro screen CSS**

Add the following CSS rules inside the existing `<style>` block in `ahpra.html`, just before the closing `</style>` tag:

```css
    /* ── AHPRA INTRO SCREEN ── */
    .ahpra-intro {
      position: relative;
      min-height: calc(100dvh - 200px);
      overflow: hidden;
    }

    /* Blob background */
    .intro-blob-canvas {
      position: absolute;
      inset: 0;
      overflow: hidden;
      z-index: 0;
      pointer-events: none;
    }
    .intro-blob {
      position: absolute;
      border-radius: 50%;
      filter: blur(80px);
      opacity: 0.35;
    }
    .intro-blob-1 {
      width: 280px; height: 280px;
      background: radial-gradient(circle, #60a5fa, #3b82f6);
      top: -60px; left: -40px;
    }
    .intro-blob-2 {
      width: 200px; height: 200px;
      background: radial-gradient(circle, #a78bfa, #7c3aed);
      top: 120px; right: -30px;
    }
    .intro-blob-3 {
      width: 160px; height: 160px;
      background: radial-gradient(circle, #34d399, #10b981);
      bottom: 80px; left: 20px;
    }

    /* Panels */
    .intro-panel {
      position: absolute;
      inset: 0;
      z-index: 1;
      opacity: 0;
      transform: translateX(40px);
      pointer-events: none;
      transition: opacity 0.4s ease, transform 0.4s ease;
      overflow-y: auto;
    }
    .intro-panel-active {
      position: relative;
      opacity: 1;
      transform: translateX(0);
      pointer-events: auto;
    }
    .intro-panel-exit {
      opacity: 0;
      transform: translateX(-40px);
      pointer-events: none;
    }

    /* Welcome panel content */
    .intro-content {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      min-height: calc(100dvh - 200px);
      padding: 40px var(--sp-7) 40px;
    }

    .intro-pathway-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(26, 86, 219, 0.08);
      border: 1px solid rgba(26, 86, 219, 0.15);
      border-radius: 999px;
      padding: 6px 14px;
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 24px;
      width: fit-content;
    }
    .intro-pathway-badge svg { stroke: var(--accent); }

    .intro-title {
      font-family: var(--font-heading);
      font-size: 28px;
      font-weight: 700;
      color: var(--ink);
      line-height: 1.15;
      letter-spacing: -0.02em;
      margin-bottom: 14px;
    }
    .intro-subtitle {
      font-size: 15px;
      color: var(--ink-soft);
      line-height: 1.6;
      margin-bottom: 32px;
      max-width: 520px;
    }

    /* Milestone cards */
    .intro-milestones {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 36px;
    }
    .intro-milestone {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 16px;
    }
    .intro-milestone-icon {
      width: 36px; height: 36px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .intro-milestone-icon.green { background: rgba(16, 185, 129, 0.08); }
    .intro-milestone-icon.green svg { stroke: #10b981; }
    .intro-milestone-icon.amber { background: rgba(245, 158, 11, 0.08); }
    .intro-milestone-icon.amber svg { stroke: #f59e0b; }
    .intro-milestone-text {
      font-size: 13px;
      font-weight: 500;
      color: var(--ink-soft);
      line-height: 1.4;
    }
    .intro-milestone-text strong {
      color: var(--ink);
      font-weight: 600;
    }

    /* CTA area */
    .intro-cta-area {
      margin-top: auto;
      padding-top: 20px;
    }
    .intro-doc-notice {
      text-align: center;
      font-size: 13px;
      color: var(--ink-muted);
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .intro-ready-check {
      width: 64px; height: 64px;
      border-radius: 50%;
      background: rgba(16, 185, 129, 0.08);
      display: grid;
      place-items: center;
      margin: 0 auto 20px;
    }
    .intro-ready-check svg { stroke: #10b981; }
    .intro-ready-text {
      text-align: center;
      font-size: 14px;
      color: #166534;
      font-weight: 500;
      margin-bottom: 24px;
    }
    .intro-cta-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 16px 24px;
      border: none;
      border-radius: 14px;
      font-family: var(--font-body);
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .intro-cta-btn svg {
      width: 18px; height: 18px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .intro-cta-btn.primary {
      background: var(--accent);
      color: #fff;
      box-shadow: 0 4px 14px rgba(26, 86, 219, 0.3);
    }
    .intro-cta-btn.primary:hover {
      background: #1d4ed8;
      box-shadow: 0 6px 20px rgba(26, 86, 219, 0.4);
      transform: translateY(-1px);
    }
    .intro-cta-btn.success {
      background: #10b981;
      color: #fff;
      box-shadow: 0 4px 14px rgba(16, 185, 129, 0.3);
    }
    .intro-cta-btn.success:hover {
      background: #059669;
      box-shadow: 0 6px 20px rgba(16, 185, 129, 0.4);
      transform: translateY(-1px);
    }

    /* ── Document Preparation Panel ── */
    .intro-docs-header {
      background: var(--surface-raised);
      padding: 20px var(--sp-7) 16px;
      border-bottom: 1px solid var(--border);
    }
    .intro-docs-header-top {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .intro-back-btn {
      width: 32px; height: 32px;
      border-radius: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      display: grid;
      place-items: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .intro-back-btn:hover { background: var(--border); }
    .intro-docs-title {
      font-family: var(--font-heading);
      font-size: 22px;
      font-weight: 700;
      color: var(--ink);
      letter-spacing: -0.01em;
    }
    .intro-docs-sub {
      font-size: 13px;
      color: var(--ink-muted);
      margin-left: 42px;
    }

    /* Document cards */
    .intro-docs-list {
      padding: 16px var(--sp-7) 40px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .intro-doc-group-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-muted);
      margin-top: 8px;
      margin-bottom: 4px;
    }
    .intro-doc-card {
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      transition: border-color 0.15s;
    }
    .intro-doc-card:hover {
      border-color: rgba(26, 86, 219, 0.25);
    }
    .intro-doc-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .intro-doc-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--ink);
    }
    .intro-doc-status {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 3px 8px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    .intro-doc-status.missing {
      background: #fef2f2;
      color: #991b1b;
    }
    .intro-doc-status.preparing {
      background: #fffbeb;
      color: #92400e;
    }
    .intro-doc-status.requested {
      background: #f0f9ff;
      color: #0369a1;
    }
    .intro-doc-desc {
      font-size: 12px;
      color: var(--ink-muted);
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .intro-doc-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .intro-upload-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 10px;
      border: 1px solid #bfdbfe;
      background: #eff6ff;
      color: #1d4ed8;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: var(--font-body);
      transition: background 0.15s;
    }
    .intro-upload-btn:hover { background: #dbeafe; }
    .intro-upload-btn svg {
      width: 14px; height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .intro-show-me-how {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 0;
      background: transparent;
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
      font-family: var(--font-body);
      transition: color 0.15s;
    }
    .intro-show-me-how:hover { color: #1d4ed8; }
    .intro-show-me-how svg {
      width: 14px; height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* Upload progress bar inside doc card */
    .intro-upload-progress {
      height: 3px;
      border-radius: 2px;
      background: var(--border);
      margin-top: 10px;
      overflow: hidden;
      display: none;
    }
    .intro-upload-progress.show { display: block; }
    .intro-upload-progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 2px;
      width: 0;
      transition: width 0.3s ease;
    }

    /* Uploaded state for doc card */
    .intro-doc-card.uploaded .intro-doc-status.missing {
      background: #ecfdf5;
      color: #166534;
    }
    .intro-doc-uploaded-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #166534;
      font-weight: 500;
    }
    .intro-doc-uploaded-row svg {
      width: 14px; height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
      flex-shrink: 0;
    }
```

- [ ] **Step 2: Verify styles render correctly**

Navigate to `/pages/ahpra.html`, temporarily change the `#ahpraIntro` `style="display:none"` to `style=""` in devtools to preview the intro. Verify the blobs, milestone cards, and layout look correct. Then revert.

- [ ] **Step 3: Commit**

```bash
git add pages/ahpra.html
git commit -m "feat: add AHPRA intro screen CSS styles"
```

---

### Task 3: Add Intro Screen JavaScript — Document State & Rendering

**Files:**
- Modify: `pages/ahpra.html` (add JS inside the existing `<script>` block)

This task adds the core logic: checking document readiness, rendering the CTA, rendering the document list, and handling the slide transition between panels.

- [ ] **Step 1: Add the COUNTRY_DOCS reference and helper functions**

Add the following code inside the `<script>` block in `ahpra.html`, immediately after the `ONBOARDING_QUAL_DOCS` definition (after line 1715). This duplicates the `COUNTRY_DOCS` help data from `my-documents.html` as a reference lookup — the document keys and help objects must be identical to those in `my-documents.html` (lines 1268-1509) so that "Show me how" content is exactly the same.

```javascript
    // ─── INTRO SCREEN: COUNTRY DOC HELP DATA ─────────────────────
    // Mirrors the COUNTRY_DOCS help data from my-documents.html exactly.
    // Keys must stay in sync with my-documents.html COUNTRY_DOCS.
    const INTRO_COUNTRY_DOCS = {
      uk: {
        institution: [
          {
            key: "certificate_good_standing",
            title: "Certificate of Good Standing",
            help: {
              title: "Certificate of Good Standing",
              steps: [
                'Log in to your <a href="https://extgenmedcouncil.b2clogin.com/extgenmedcouncil.onmicrosoft.com/b2c_1a_usersigninormigrategmconline/oauth2/v2.0/authorize?client_id=1304d06d-0b67-4d06-9abd-e03aaef62a88&redirect_uri=https%3A%2F%2Fwww.gmc-uk.org%2Fqitm%2Fsignin-oidc&response_type=id_token&scope=openid%20profile&response_mode=form_post&nonce=639088171193672580.ZjQwODcyZDgtNTAxOC00YmM2LWE4ZGUtM2I2NWUxNjE0MTVhNzJmY2YzMmQtNTg5Zi00NWRhLTgzYWEtNGMwYWZmMTFjZjg0&client_info=1&x-client-brkrver=IDWeb.1.24.0.0&state=CfDJ8CCFNphTI2xLiogAzC0YsAyIgiiJHlbcbo8KWD0yCcvLYHNZ1xxff35Gjym3wF68p0qnWcVa14sNBtztLdjKu9LyjSCebUIDBFdIvp2xvEUn086Tmqz1yP1ib7R7GaecxE6Aqb9w32l4XIh2x-7FLDYD92INc-Py--FWGS6YBTk1W1cUGoSi79jwFYlY7Ikf-chZf7yqV-3iVm-m_ZXnD-0rwEyDlyUHXfgM5eLMvcXvP_zNSmyKOLvzfe3bHddEmWStUY2QOXtCHxHYqD8womPvW29r7VGUM81fT1hbaj3xUprxuVhINsQTRA9_eIT8me26YGF4Io1VXbZEk4ObR8fDjVhTB38PUd8HiyHdALY2xv5qz5arVs3nzap_Ttoorg">GMC Online account</a>',
                'In the left hand menu choose "My registration"',
                'Then open "My CCPS requests"',
                "Request the certificate to be sent directly to Ahpra"
              ],
              reminder: "Reminder: this must be sent directly by the issuing authority to Ahpra."
            }
          },
          {
            key: "confirmation_training",
            title: "Confirmation of Training",
            help: {
              title: "Confirmation of Training",
              steps: [
                '<a href="mailto:portfolio@gmc-uk.org?subject=Request%20for%20Confirmation%20of%20Training&body=Dear%20GMC%20Portfolio%20Team%2C%0A%0AI%20am%20writing%20to%20request%20confirmation%20of%20my%20specialist%20%2F%20GP%20training%20posts.%20I%20require%20this%20documentation%20for%20my%20application%20to%20the%20Australian%20Health%20Practitioner%20Regulation%20Agency%20(Ahpra).%0A%0APlease%20advise%20on%20the%20next%20steps%20and%20any%20forms%20I%20need%20to%20complete.%0A%0AKind%20regards">Email portfolio@gmc-uk.org</a>',
                "State that you require confirmation of your specialist / GP training posts",
                "GMC will review the request and send you an application form to complete",
                "Complete the form and return it as instructed"
              ],
              reminder: "Reminder: request that the confirmation is sent by the GMC directly to Ahpra."
            }
          },
          {
            key: "criminal_history",
            title: "Criminal History Check",
            help: {
              title: "Criminal History Check",
              steps: [
                'Complete your international criminal history check through <a href="https://www.fit2work.com.au/PreEmployment/GeneralBasicDetails?id=q8Uuw%2BuklTU%3D&amp;_gl=1*ckbmax*_gcl_au*NjY2MzAyMDA3LjE3NzE3NjkwMjU.*_ga*ODA4ODU4NTIuMTc3MTc2OTAyNg..*_ga_0BTJRVTY8V*czE3Nzc1NTcwODQkbzUkZzAkdDE3Nzc1NTcwODQkajYwJGwwJGgw*_ga_WM6YQZ40M2*czE3Nzc1NTcwODQkbzUkZzAkdDE3Nzc1NTcwODQkajYwJGwwJGgxNzk3MjAwOTU0" target="_blank" rel="noopener noreferrer">Fit2Work</a>'
              ]
            }
          }
        ],
        prepared: [
          { key: "primary_medical_degree", title: "Certified copy of Primary Medical Degree (MBBS/MBChB)", help: { title: "Primary Medical Degree", steps: ["Upload a certified copy of your primary medical degree"], certNote: true } },
          { key: "mrcgp_certified", title: "Certified copy of MRCGP", help: { title: "MRCGP", steps: ["Upload a certified copy of your MRCGP certificate"], certNote: true } },
          { key: "cct_certified", title: "Certified copy of CCT (General Practice) issued by the General Medical Council or PMETB", help: { title: "CCT", steps: ["Upload a certified copy of your CCT certificate issued by the GMC or PMETB"], certNote: true } },
          { key: "cv_signed_dated", title: "CV (Signed and dated)", help: { title: "CV", steps: ["Upload your signed and dated CV"] } }
        ]
      },
      ie: {
        institution: [
          { key: "certificate_good_standing", title: "Certificate of Good Standing / Registration Status", help: { title: "Certificate of Good Standing / Registration Status", steps: ["Request a current certificate of good standing / registration status from your Irish regulator", "Ensure it is sent in the required format for Ahpra"], reminder: "Reminder: this must be sent directly where required." } },
          { key: "criminal_history", title: "Criminal History Check", help: { title: "Criminal History Check", steps: ["Complete your criminal history check through the approved provider"] } }
        ],
        prepared: [
          { key: "primary_medical_degree", title: "Certified copy of Primary Medical Degree", help: { title: "Primary Medical Degree", steps: ["Upload a certified copy of your primary medical degree"], certNote: true } },
          { key: "micgp_certified", title: "Certified copy of MICGP", help: { title: "MICGP", steps: ["Upload a certified copy of your MICGP certificate", "If you do not have a copy, request a re-issue from ICGP Membership Services"], certNote: true } },
          { key: "cscst_certified", title: "Certified copy of CSCST", help: { title: "CSCST", steps: ["Upload a certified copy of your CSCST", "If needed, request a re-issue from ICGP Membership Services"], certNote: true } },
          { key: "icgp_confirmation_letter", title: "Certified copy of ICGP Confirmation Letter", help: { title: "ICGP Confirmation Letter", steps: ["Contact ICGP Membership Services", "Request a confirmation / verification letter confirming your qualification was awarded under the ICGP curriculum after completion of the approved GP training pathway", "If needed, request verification of training through ICGP"], certNote: true, reminder: "This is the key supporting letter for Irish GPs." } },
          { key: "cv_signed_dated", title: "CV (Signed and dated)", help: { title: "CV", steps: ["Upload your signed and dated CV"] } }
        ]
      },
      nz: {
        institution: [
          { key: "certificate_good_standing", title: "Certificate of Good Standing / Registration Status", help: { title: "Certificate of Good Standing / Registration Status", steps: ["Request your current certificate of good standing / registration status from the relevant New Zealand authority", "Ensure it is provided in a format acceptable for Ahpra"] } },
          { key: "criminal_history", title: "Criminal History Check", help: { title: "Criminal History Check", steps: ["Complete your criminal history check through the approved provider"] } }
        ],
        prepared: [
          { key: "primary_medical_degree", title: "Certified copy of Primary Medical Degree", help: { title: "Primary Medical Degree", steps: ["Upload a certified copy of your primary medical degree"], certNote: true } },
          { key: "frnzcgp_certified", title: "Certified copy of FRNZCGP", help: { title: "FRNZCGP", steps: ["Upload a certified copy of your FRNZCGP certificate", "If needed, contact RNZCGP for replacement or confirmation"], certNote: true } },
          { key: "rnzcgp_confirmation_letter", title: "Certified copy of RNZCGP Confirmation Letter", help: { title: "RNZCGP Confirmation Letter", steps: ["Contact RNZCGP", "Request a confirmation letter stating that your fellowship was awarded under the RNZCGP curriculum following satisfactory completion of GPEP"], certNote: true } },
          { key: "cv_signed_dated", title: "CV (Signed and dated)", help: { title: "CV", steps: ["Upload your signed and dated CV"] } }
        ]
      }
    };

    const INTRO_CERT_NOTE_HTML = '<p>Before uploading, each required document must be certified as a true copy of the original by a solicitor or public notary.</p>' +
      '<p>On the copy of the document, the certifier must write or stamp:</p>' +
      '<p class="cert-quote">"I have sighted the original document and certify this to be a true copy of the original."</p>' +
      '<p>They must also include:</p>' +
      '<ul>' +
        '<li>Their signature</li>' +
        '<li>Their full name</li>' +
        '<li>Their occupation or profession</li>' +
        '<li>Their profession or registration number (if applicable)</li>' +
        '<li>Their phone number</li>' +
        '<li>The date</li>' +
        '<li>Their stamp or seal (if relevant)</li>' +
      '</ul>';
```

- [ ] **Step 2: Add the intro screen core logic**

Add this immediately after the code from Step 1:

```javascript
    // ─── INTRO SCREEN: LOGIC ─────────────────────────────────────
    const introEl = document.getElementById("ahpraIntro");
    const introWelcomePanel = document.getElementById("introWelcomePanel");
    const introDocsPanel = document.getElementById("introDocsPanel");
    const introCtaEl = document.getElementById("introCta");
    const introDocsListEl = document.getElementById("introDocsList");
    const introBackBtn = document.getElementById("introBackBtn");
    const introHelpBackdrop = document.getElementById("introHelpBackdrop");
    const introHelpPopover = document.getElementById("introHelpPopover");
    const introHelpTitle = document.getElementById("introHelpTitle");
    const introHelpSteps = document.getElementById("introHelpSteps");
    const introHelpCertNote = document.getElementById("introHelpCertNote");
    const introHelpReminder = document.getElementById("introHelpReminder");
    const introHelpClose = document.getElementById("introHelpClose");

    function getIntroDismissedKey() {
      return STORAGE_KEY + "__intro_seen";
    }

    function isIntroDismissed() {
      try { return localStorage.getItem(getIntroDismissedKey()) === "1"; } catch (e) { return false; }
    }

    function dismissIntro() {
      try { localStorage.setItem(getIntroDismissedKey(), "1"); } catch (e) {}
      introEl.style.display = "none";
      // Show the normal AHPRA registration content
      document.querySelector(".hero-compact").style.display = "";
      document.querySelector(".reg-content").style.display = "";
      var footerContent = document.querySelectorAll(".reg-content")[1];
      if (footerContent) footerContent.style.display = "";
      // Desktop sidebar
      var sidebar = document.querySelector(".sidebar-desktop");
      if (sidebar) sidebar.style.display = "";
    }

    function getIncompleteDocsForIntro(country) {
      var countryKey = (country || "").toLowerCase();
      if (countryKey === "gb") countryKey = "uk";
      var cfg = INTRO_COUNTRY_DOCS[countryKey];
      if (!cfg) return [];

      var docState = readJsonStorage(DOC_KEY, { docs: {} }) || { docs: {} };
      var docs = docState.docs || {};
      var preparedState = readJsonStorage(PREPARED_DOCS_KEY, { docs: {} }) || { docs: {} };
      var prepDocs = preparedState.docs || {};

      var incomplete = [];

      // Institution docs: complete if status is requested/under_review/approved/accepted
      (cfg.institution || []).forEach(function(doc) {
        var d = docs[doc.key] || {};
        var status = d.status || "pending";
        var isDone = d.uploaded || status === "requested" || status === "under_review" || status === "approved" || status === "accepted";
        if (!isDone) {
          incomplete.push({ key: doc.key, title: doc.title, help: doc.help, group: "institution", status: "missing" });
        }
      });

      // Prepared docs: complete if uploaded
      (cfg.prepared || []).forEach(function(doc) {
        var d = docs[doc.key] || {};
        var isDone = d.uploaded;
        if (!isDone) {
          incomplete.push({ key: doc.key, title: doc.title, help: doc.help, group: "prepared", status: "missing" });
        }
      });

      // GP Link prepared docs (SUPERVISED_PRACTICE_DOCS): complete if ready or has url
      var spDocs = typeof SUPERVISED_PRACTICE_DOCS !== "undefined" ? SUPERVISED_PRACTICE_DOCS : [];
      spDocs.forEach(function(doc) {
        var p = prepDocs[doc.key] || {};
        var isDone = p.ready || !!p.url;
        if (!isDone) {
          incomplete.push({ key: doc.key, title: doc.label || doc.title, help: null, group: "gplink", status: "preparing" });
        }
      });

      return incomplete;
    }

    function renderIntroCta(incompleteDocs) {
      var html = "";
      if (incompleteDocs.length === 0) {
        html += '<div class="intro-ready-check"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>';
        html += '<p class="intro-ready-text">All your documents are prepared and ready</p>';
        html += '<button class="intro-cta-btn success" id="introBeginBtn" type="button">Begin Now <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></button>';
      } else {
        html += '<p class="intro-doc-notice">There are a few documents we need prepared before commencing</p>';
        html += '<button class="intro-cta-btn primary" id="introCompleteBtn" type="button">Complete Now <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></button>';
      }
      introCtaEl.innerHTML = html;

      var beginBtn = document.getElementById("introBeginBtn");
      if (beginBtn) beginBtn.addEventListener("click", function() { dismissIntro(); });

      var completeBtn = document.getElementById("introCompleteBtn");
      if (completeBtn) completeBtn.addEventListener("click", function() { slideToDocsPanel(); });
    }

    function renderIntroDocsList(incompleteDocs) {
      var html = "";
      var currentGroup = "";
      var groupLabels = { institution: "Direct to AHPRA", prepared: "You Prepare", gplink: "GP Link Prepares" };

      incompleteDocs.forEach(function(doc, idx) {
        if (doc.group !== currentGroup) {
          currentGroup = doc.group;
          html += '<div class="intro-doc-group-label">' + groupLabels[currentGroup] + '</div>';
        }

        var statusClass = doc.status === "preparing" ? "preparing" : "missing";
        var statusLabel = doc.status === "preparing" ? "Preparing" : "Missing";

        html += '<div class="intro-doc-card" id="introDocCard_' + doc.key + '" data-doc-key="' + doc.key + '" data-doc-group="' + doc.group + '">';
        html += '  <div class="intro-doc-card-top">';
        html += '    <span class="intro-doc-title">' + doc.title + '</span>';
        html += '    <span class="intro-doc-status ' + statusClass + '" id="introDocStatus_' + doc.key + '">' + statusLabel + '</span>';
        html += '  </div>';

        if (doc.group === "gplink") {
          html += '  <p class="intro-doc-desc">GP Link is preparing this document for your application</p>';
        } else if (doc.group === "institution") {
          html += '  <div class="intro-doc-actions">';
          html += '    <button class="intro-upload-btn" data-intro-action="mark-requested" data-intro-doc-key="' + doc.key + '" type="button">';
          html += '      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Mark Requested';
          html += '    </button>';
          if (doc.help) {
            html += '    <button class="intro-show-me-how" data-intro-help-idx="' + idx + '" type="button">';
            html += '      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
            html += '      Show me how';
            html += '    </button>';
          }
          html += '  </div>';
        } else {
          html += '  <div class="intro-doc-actions">';
          html += '    <label class="intro-upload-btn" style="cursor:pointer;">';
          html += '      <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
          html += '      Upload Document';
          html += '      <input type="file" accept="image/*,.pdf" data-intro-upload="' + doc.key + '" style="display:none;" />';
          html += '    </label>';
          if (doc.help) {
            html += '    <button class="intro-show-me-how" data-intro-help-idx="' + idx + '" type="button">';
            html += '      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
            html += '      Show me how';
            html += '    </button>';
          }
          html += '  </div>';
          html += '  <div class="intro-upload-progress" id="introProgress_' + doc.key + '"><div class="intro-upload-progress-fill" id="introProgressFill_' + doc.key + '"></div></div>';
        }

        html += '</div>';
      });

      introDocsListEl.innerHTML = html;
    }

    // Panel slide transitions
    function slideToDocsPanel() {
      introWelcomePanel.classList.remove("intro-panel-active");
      introWelcomePanel.classList.add("intro-panel-exit");
      introDocsPanel.classList.remove("intro-panel-exit");
      void introDocsPanel.offsetWidth;
      introDocsPanel.classList.add("intro-panel-active");
    }

    function slideToWelcomePanel() {
      introDocsPanel.classList.remove("intro-panel-active");
      introDocsPanel.classList.add("intro-panel-exit");
      introDocsPanel.style.transform = "translateX(40px)";
      introWelcomePanel.classList.remove("intro-panel-exit");
      introWelcomePanel.style.transform = "";
      void introWelcomePanel.offsetWidth;
      introWelcomePanel.classList.add("intro-panel-active");
    }

    introBackBtn.addEventListener("click", function() { slideToWelcomePanel(); });
```

- [ ] **Step 3: Commit**

```bash
git add pages/ahpra.html
git commit -m "feat: add AHPRA intro screen JS — document state checking and rendering"
```

---

### Task 4: Add Intro Screen JavaScript — Upload, Help Popover & Event Handlers

**Files:**
- Modify: `pages/ahpra.html` (continue adding JS after Task 3's code)

- [ ] **Step 1: Add help popover, upload handling, and event delegation**

Add this code immediately after the Task 3 JS code:

```javascript
    // ─── INTRO SCREEN: HELP POPOVER ──────────────────────────────
    function openIntroHelp(helpData) {
      introHelpTitle.textContent = helpData.title || "How to get this document";
      introHelpSteps.innerHTML = "";
      (helpData.steps || []).forEach(function(step) {
        var li = document.createElement("li");
        li.innerHTML = step;
        introHelpSteps.appendChild(li);
      });
      if (helpData.certNote) {
        introHelpCertNote.innerHTML = INTRO_CERT_NOTE_HTML;
        introHelpCertNote.hidden = false;
      } else {
        introHelpCertNote.hidden = true;
      }
      if (helpData.reminder) {
        introHelpReminder.textContent = helpData.reminder;
        introHelpReminder.hidden = false;
      } else {
        introHelpReminder.hidden = true;
      }
      introHelpBackdrop.classList.add("show");
      introHelpPopover.classList.add("show");
    }

    function closeIntroHelp() {
      introHelpBackdrop.classList.remove("show");
      introHelpPopover.classList.remove("show");
    }

    introHelpClose.addEventListener("click", closeIntroHelp);
    introHelpBackdrop.addEventListener("click", closeIntroHelp);

    // ─── INTRO SCREEN: UPLOAD HANDLER ────────────────────────────
    var introIncompleteDocs = [];

    function handleIntroUpload(docKey, file) {
      if (!file) return;

      var progressBar = document.getElementById("introProgress_" + docKey);
      var progressFill = document.getElementById("introProgressFill_" + docKey);
      if (progressBar) progressBar.classList.add("show");
      if (progressFill) progressFill.style.width = "30%";

      var reader = new FileReader();
      reader.onload = function() {
        if (progressFill) progressFill.style.width = "60%";
        var fileDataUrl = reader.result;

        // Save to gp_documents_prep (same as my-documents.html)
        var country = getPageCountry();
        var state = readJsonStorage(DOC_KEY, { docs: {}, country: country }) || { docs: {}, country: country };
        if (!state.docs) state.docs = {};
        if (!state.docs[docKey]) state.docs[docKey] = {};
        state.docs[docKey].uploaded = true;
        state.docs[docKey].fileName = file.name;
        state.docs[docKey].mimeType = file.type;
        state.docs[docKey].fileSize = file.size;
        state.docs[docKey].status = "uploaded";
        state.updatedAt = new Date().toISOString();
        try { localStorage.setItem(DOC_KEY, JSON.stringify(state)); } catch (e) {}

        // Also save to API (same pattern as my-documents.html)
        fetch("/api/prepared-documents", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ country: country, key: docKey, fileName: file.name, mimeType: file.type, fileSize: file.size, fileDataUrl: fileDataUrl })
        }).catch(function() {});

        if (progressFill) progressFill.style.width = "100%";

        setTimeout(function() {
          // Update the card to show uploaded state
          var card = document.getElementById("introDocCard_" + docKey);
          if (card) {
            card.classList.add("uploaded");
            var statusEl = document.getElementById("introDocStatus_" + docKey);
            if (statusEl) { statusEl.textContent = "Uploaded"; statusEl.className = "intro-doc-status"; statusEl.style.background = "#ecfdf5"; statusEl.style.color = "#166534"; }
            var actionsEl = card.querySelector(".intro-doc-actions");
            if (actionsEl) {
              actionsEl.innerHTML = '<div class="intro-doc-uploaded-row"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> ' + file.name + '</div>';
            }
            if (progressBar) progressBar.classList.remove("show");
          }

          // Check if all docs are now complete
          checkIntroCompletion();
        }, 400);
      };
      reader.readAsDataURL(file);
    }

    function handleIntroMarkRequested(docKey) {
      var country = getPageCountry();
      var state = readJsonStorage(DOC_KEY, { docs: {}, country: country }) || { docs: {}, country: country };
      if (!state.docs) state.docs = {};
      if (!state.docs[docKey]) state.docs[docKey] = {};
      state.docs[docKey].status = "requested";
      state.docs[docKey].uploaded = true;
      state.updatedAt = new Date().toISOString();
      try { localStorage.setItem(DOC_KEY, JSON.stringify(state)); } catch (e) {}

      // Sync to API
      fetch("/api/state/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key: DOC_KEY, value: state })
      }).catch(function() {});

      // Update card UI
      var statusEl = document.getElementById("introDocStatus_" + docKey);
      if (statusEl) { statusEl.textContent = "Requested"; statusEl.className = "intro-doc-status requested"; }
      var card = document.getElementById("introDocCard_" + docKey);
      if (card) {
        var actionsEl = card.querySelector(".intro-doc-actions");
        if (actionsEl) {
          actionsEl.innerHTML = '<div class="intro-doc-uploaded-row"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Requested from issuing authority</div>';
        }
      }

      checkIntroCompletion();
    }

    function checkIntroCompletion() {
      var country = getPageCountry();
      var remaining = getIncompleteDocsForIntro(country);
      if (remaining.length === 0) {
        setTimeout(function() { dismissIntro(); }, 600);
      }
    }

    // ─── INTRO SCREEN: EVENT DELEGATION ──────────────────────────
    introDocsListEl.addEventListener("click", function(e) {
      // Show me how
      var helpBtn = e.target.closest("[data-intro-help-idx]");
      if (helpBtn) {
        var idx = parseInt(helpBtn.dataset.introHelpIdx, 10);
        var doc = introIncompleteDocs[idx];
        if (doc && doc.help) openIntroHelp(doc.help);
        return;
      }

      // Mark requested
      var reqBtn = e.target.closest("[data-intro-action='mark-requested']");
      if (reqBtn) {
        handleIntroMarkRequested(reqBtn.dataset.introDocKey);
        return;
      }
    });

    introDocsListEl.addEventListener("change", function(e) {
      var uploadInput = e.target.closest("[data-intro-upload]");
      if (uploadInput && uploadInput.files && uploadInput.files[0]) {
        handleIntroUpload(uploadInput.dataset.introUpload, uploadInput.files[0]);
      }
    });
```

- [ ] **Step 2: Commit**

```bash
git add pages/ahpra.html
git commit -m "feat: add AHPRA intro screen JS — upload, help popover, event handlers"
```

---

### Task 5: Wire Intro Screen into Page Initialization

**Files:**
- Modify: `pages/ahpra.html` — modify the `initPage()` function (around line 3743) and `renderPage()` (around line 3307)

- [ ] **Step 1: Add the `showIntroScreen` function**

Add this function immediately before the `initPage()` function definition:

```javascript
    // ─── INTRO SCREEN: SHOW/HIDE LOGIC ───────────────────────────
    function showIntroScreen() {
      var country = getPageCountry();
      introIncompleteDocs = getIncompleteDocsForIntro(country);

      renderIntroCta(introIncompleteDocs);
      renderIntroDocsList(introIncompleteDocs);

      introEl.style.display = "";

      // Hide the normal registration content while intro is showing
      document.querySelector(".hero-compact").style.display = "none";
      document.querySelector(".reg-content").style.display = "none";
      var footerContent = document.querySelectorAll(".reg-content")[1];
      if (footerContent) footerContent.style.display = "none";
      var sidebar = document.querySelector(".sidebar-desktop");
      if (sidebar) sidebar.style.display = "none";
    }
```

- [ ] **Step 2: Modify `initPage()` to check for intro screen**

In the `initPage()` function (around line 3743), modify the block inside the `hasCareerSecured()` branch to check for the intro screen before rendering the normal page. Change:

```javascript
        } else {
          hidePlacementGate();
          const initialProgress = loadProgress();
          const routeTab = pickTabFromRoute(initialProgress);
          currentTabKey = routeTab || activeTabStage(initialProgress);
          if (!routeTab) syncRouteForStage(initialProgress.stage, true);
          renderPage(initialProgress);
        }
```

To:

```javascript
        } else {
          hidePlacementGate();
          const initialProgress = loadProgress();
          // Show intro screen if not yet dismissed
          if (!isIntroDismissed()) {
            showIntroScreen();
            return;
          }
          const routeTab = pickTabFromRoute(initialProgress);
          currentTabKey = routeTab || activeTabStage(initialProgress);
          if (!routeTab) syncRouteForStage(initialProgress.stage, true);
          renderPage(initialProgress);
        }
```

- [ ] **Step 3: Update cache buster on the ahpra.html script tags**

Update the cache buster version on any script tags in the `<head>` of `ahpra.html` that reference JS files. Change the `?v=` parameter to `?v=20260506a` on all script tags (lines 7-12).

- [ ] **Step 4: Test the full flow**

```bash
npm start
```

1. Navigate to `/pages/ahpra.html` — should see the intro welcome screen with blob background
2. If documents are incomplete: should show "There are a few documents..." text + "Complete Now" button
3. Click "Complete Now" → should slide to document list showing only incomplete docs
4. Click "Show me how" on a document → help popover should appear with correct content matching my-documents.html
5. Click back arrow → should slide back to welcome screen
6. Upload a document → card should update to "Uploaded" state
7. On page reload → intro should show again (until all docs complete or "Begin Now" clicked)
8. If all docs are ready → welcome screen shows green check + "Begin Now" button
9. Click "Begin Now" → intro hides, normal AHPRA registration appears
10. On subsequent page loads → intro should not appear (dismissed flag in localStorage)

- [ ] **Step 5: Commit**

```bash
git add pages/ahpra.html
git commit -m "feat: wire AHPRA intro screen into page initialization flow"
```

- [ ] **Step 6: Push to remote**

```bash
git push
```
