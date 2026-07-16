# Handover — the 2026 Practice Agreement

**Scope:** this document covers *only* the practice agreement (the contract a practice
e-signs). It is written for a session that needs to reference, display, quote or extend
the agreement as part of other work. It deliberately says nothing about the intake form,
the FB lead pipeline, or the job/placement flow.

**Status as of 2026-07-16:** current, merged to `main` at commit `52ded84`, live in prod.

---

## 1. Read this first — the two traps

**Trap 1 — the document is not named what it is called.**

| | |
|---|---|
| **Filename** | `gp-link-practice-agreement-2026.pdf` — says *agreement* |
| **Cover page title** | *"Australia Medical Recruitment **Pricing Schedule 2026**"* — says *pricing schedule* |
| **What it actually is** | The full **Recruitment Services Agreement**: 19 pages, 16 binding clauses |

Pages 1–3 are marketing copy ("How do we do it", "The GP Link Difference"). The fee tables
start at page 4. The numbered T&Cs start after the "Agreement to terms" page. Someone opening
it and reading only the cover will conclude it is a brochure. **It is not.** Clause 16.1
("Entire agreement") makes the terms + fee schedule + e-sign execution page the whole contract.

Do **not** identify this document by its filename or its cover. Identify it by its clause list.

The in-document cross-references ("clause 6 of the Recruitment Services Agreement",
"clause 7 of the …") are **self-referential** — they point at its own clauses 6 and 7.
There is no second, separate document. This confuses people; it confused a previous session.

**Trap 2 — stale worktrees silently carry the 2025 file.**

The 2026 rebuild landed in commit `8ddd684` (2026-07-15). Any branch cut before that carries
the **2025** file instead, and it is *also* named `gp-link-practice-agreement-2026.pdf`.

| Version | Bytes | Pages | Cover reads |
|---|---|---|---|
| **Stale / pre-rebuild** | 1,783,144 | 11 | Pricing Schedule **2025** |
| **Current** | 2,761,127 | 19 | Pricing Schedule **2026** |

A previous session handed the owner the 2025 file while calling it the 2026 agreement, because
it trusted the filename and a stale memory note. **Pull legal assets from `origin/main`,
not the working copy:**

```bash
git cat-file blob $(git rev-parse origin/main:assets/legal/gp-link-practice-agreement-2026.pdf) > /tmp/agreement.pdf
```

---

## 2. Where everything lives

| Path | Role |
|---|---|
| `assets/legal/gp-link-practice-agreement-2026.pdf` | **Generated output.** Never hand-edit |
| `assets/legal/src/agreement-2026.html` | **Source of truth.** Edit this |
| `assets/legal/src/logo.png`, `strip.png` | Inlined as base64 at build (`{{LOGO}}` / `{{STRIP}}` placeholders) |
| `scripts/build-practice-agreement-pdf.sh` | The build |
| `lib/practice-agreement-pdf.js` | Exports `stampAgreementExecutionPage` |
| `tests/practice-agreement-pdf.test.js` | Page-count + stamping tests |

## 3. Changing the wording

Edit the HTML, then rebuild. **Never edit the PDF directly** — the next rebuild silently
discards it.

```bash
bash scripts/build-practice-agreement-pdf.sh
```

It inlines the images with python3, then prints A4 via headless Chrome
(`/Applications/Google Chrome.app`). Requires Chrome; no npm deps.

**After any wording change, check for duplicate statements.** Several terms are stated twice
— once in the page 4–5 fee-schedule fine print (plain English, for the reader) and again in
the numbered clauses (legal wording). Removing one and not the other leaves the contract
contradicting itself. Grep the distinctive phrase before assuming one occurrence:

```bash
grep -n "your phrase here" assets/legal/src/agreement-2026.html
```

**If you delete a numbered clause, renumber the ones after it** and check nothing cites the
old numbers (`grep -nE "clause[s]? [0-9]+\.[0-9]"`).

## 4. Verifying a change (no Node on this machine)

`npm test` will not run — there is no node binary installed. Verify visually instead.

`qlmanage` renders page 1 only:

```bash
qlmanage -t -s 1400 -o <outdir> assets/legal/gp-link-practice-agreement-2026.pdf
```

**To see any other page**, extract that page's `<div class="page">` from the HTML source,
wrap it with the document's own `<style>` block, inline the images, print with Chrome, then
`qlmanage` the result. Pages are delimited in the source by comments like
`<!-- ═══ PAGE 13 — RSA CLAUSES 7.2–7.5 ═══ -->`. (Those comment labels have drifted from the
real page numbers — trust the rendered footer, not the comment.)

Extracting the PDF's text directly is a dead end: the fonts use a custom encoding
(a naive extract yields a `+29`-shifted mojibake), and 900+ embedded images dominate the file.
**Read `assets/legal/src/agreement-2026.html` for the text** — it is the source anyway.

## 5. How it reaches a signing practice

1. `server.js:33204` — `fs.readFileSync('assets/legal/gp-link-practice-agreement-2026.pdf')`,
   memoised into the module-level `_agreementPdfBytes` (declared `server.js:156`).
   **Cached per warm lambda instance** — after a deploy, a warm instance can keep serving the
   previous bytes until it recycles. Expect a lag; don't conclude the deploy failed.
2. `stampAgreementExecutionPage()` (`lib/practice-agreement-pdf.js`) appends **one** execution
   page carrying: signature PNG, signed name, practice name, legal entity, ABN/ACN, signer job
   title, date (`en-AU`, `Australia/Sydney`), client IP, intake token.
   → **Signed output = 20 pages** (19 + 1).
3. Shipped to Vercel by `vercel.json` → `includeFiles: ["assets/**", …]`. If a deploy ever
   404s the PDF, check that entry first — it has bitten this repo before.

The signer's typed entity/ABN/title are stored at `practices.metadata.agreement_signing` and
stamped onto the execution page. The sign endpoint **requires** legal entity name + ABN/ACN
(9 or 11 digits) + job title; old cached sign pages get a 400 telling them to refresh.

## 6. What the contract says (for quoting elsewhere)

**Fees** (all ex-GST). Overseas fees split 50/50: first half on the GP accepting your contract,
second half on commencement. Australian-based: whole fee on commencement.

| Placement | Overseas GP | AU-based GP |
|---|---|---|
| Permanent full-time (≥8 sessions / ~35+ hrs per wk) | **$25,000** ($12,500 + $12,500) | **$21,000** |
| Permanent part-time (<8 sessions / <35 hrs per wk) | **$21,000** ($10,500 + $10,500) | **$18,000** |

- **Locum:** 20% of gross fees/billings payable to the locum GP, invoiced weekly, 7-day terms.
- **Part-time → full-time within 12 months:** the difference becomes payable (clause 6).
- **Withdrawal after the GP signs:** 50% of the total applicable fee.
- **Guarantee:** 12 weeks, credit toward future placements — ≤4 wks **80%**, 4–8 wks **50%**,
  8–12 wks **35%**. Calculated on the candidate's *last working day*, not their notice date.
- **Guarantee is forfeited if any invoice goes overdue** (7-day terms).
- If a candidate never commences: initial fees refunded less a **$2,500** admin fee where
  registration support was given (clause 7.4).
- Practices must never require a doctor to contribute to the recruitment fee.

**Clause list**

| # | Clause | # | Clause |
|---|---|---|---|
| 1 | Application | 9 | Termination |
| 2 | Interpretation | 10 | Dispute resolution |
| 3 | Presentation of our candidates | 11 | Privacy & confidentiality |
| 4 | Our responsibilities | 12 | Non-solicitation of our staff |
| 5 | Your responsibilities | 13 | Waiver |
| 6 | Our fees and charges | 14 | Jurisdiction |
| 7 | Guarantee period | 15 | Severance |
| 8 | Exclusions and liability | 16 | Entire agreement |

Governing law: **New South Wales**, non-exclusive jurisdiction. Disputes go to good-faith
negotiation, then mediation (Resolution Institute, costs shared) — but this does not stop
GP Link suing to recover unpaid fees.

## 7. Change log

- **`52ded84`** (2026-07-16) — removed the unused-credit refund undertaking
  (*"If a credit is not used within twelve (12) months of the date it was issued, it will be
  refunded to you on request."*) at the owner's instruction. It appeared **twice** — the page 5
  fee-schedule fine print and clause 7.5 — and both were removed. Old **7.6 renumbered to 7.5**.
  Still 19 pages, no reflow. Nothing cross-referenced 7.5/7.6.
  *Not covered by an automated test run — no Node on the authoring machine; verified by
  rendering pages 5 and 13.*
- **`8ddd684`** (2026-07-15) — full 2026 rebuild: PDF became generated-from-HTML; part-time
  fees $21k/$18k; locum 20%; overdue invoice voids guarantee; withdrawal 50%; e-sign began
  capturing legal entity + ABN/ACN + title. 11 pages → 19.

## 8. Open risks — do not silently inherit these

1. **⚠️ UCT (unfair contract terms) exposure, unreviewed.** The terms were drafted deliberately
   pro-GP-Link on the owner's instruction: unilateral variation (6.3), acceptance-by-conduct,
   one-way indemnities, easy-to-trip guarantee conditions, liability capped at fees paid. Under
   the Australian Consumer Law UCT regime these can be **void** against a small-business
   counterparty — and most GP practices are small businesses. An Australian commercial lawyer
   still owes a UCT pass. This was flagged to the owner and consciously deferred. **Do not
   present these clauses as reliably enforceable.**
2. **Cover/title mismatch, unresolved.** The cover says *Pricing Schedule 2026*; UI that asks a
   practice to confirm they have read "the Recruitment Services Agreement" therefore names a
   document whose title they never see. Fixing it is a one-line change to the cover `<h1>` in
   the HTML plus a rebuild. **Owner decision pending — do not change unilaterally.**
3. Drafting choices the owner may still revisit: interest raised 6% → 10% p.a., RCSA references
   removed (membership unknown), non-solicitation fee set at the full-time overseas placement fee.

---

*Related: `docs/superpowers/specs/2026-07-15-practice-flow-intake-redesign.md` covers the intake
form and pipeline — out of scope here.*
