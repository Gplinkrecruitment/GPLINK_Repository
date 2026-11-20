# Australian GP agreement draft: notes for the owner and the lawyer

**DRAFT - FOR LEGAL REVIEW - NOT FOR SIGNATURE**

Work package WP-28. Written 20 November 2026. Nothing in this document is legal
advice or a legal conclusion. Every point in section 4 is a question for an
Australian commercial lawyer.

## 1. What this draft is, and what it is not

**It is** a second presentation of the 2026 practice agreement, aimed at
practices that are being offered GPs who are already based in Australia. The
cover and the first introductory pages talk about that service (a faster start,
no overseas registration process, the Ahpra register check, the provider number
for the practice's location) instead of the overseas "6 to 9 months" story.

**It is not** a new contract. Nothing a practice would be bound by has been
re-written:

- **Fees are unchanged.** Based in Australia: $21,000 full-time, $18,000
  part-time, excluding GST. Based overseas: $25,000 and $21,000. No new price
  has been added for any group of doctors.
- **Payment timing is unchanged.** For a GP based in Australia the whole fee is
  invoiced when the doctor commences work. Nothing is invoiced at signing.
- **The guarantee and credits are unchanged.** 12 weeks; credit of 80%, 50% or
  35%; forfeited if an invoice is overdue.
- **Clauses 1 to 16 are unchanged**, as are the locum terms and the withdrawal
  fee.

An automated test compares the draft with the standard agreement and fails if
any word on pages 4 to 16 differs once the draft markings are removed.

**It cannot be used.** It is not in the list staff choose from when they create
a signing link, the server refuses it if someone names it directly, no PDF of it
is stored in the product, and its source file sits in a folder the website does
not serve. Section 6 explains what would have to happen before it could be used.

**Why it must not be shown to a practice even informally.** Clause 1.1 of the
agreement says a practice accepts the terms if it keeps using GP Link's services
"after having received a copy". Whether handing over a draft could have any
effect under that clause is a question for the lawyer (LR-10). Until it is
answered, treat the draft as internal.

### Where the files are

| File | What it is |
| --- | --- |
| `docs/au-gp/legal-draft/agreement-2026-au-draft.html` | The draft itself (the source the PDF is made from) |
| `scripts/build-au-draft-agreement-pdf.sh` | Makes a PDF of the draft on a staff computer, for reading. It refuses to save into the website's public folder |
| `lib/agreement-variants.js` | Where the draft is registered as a draft (`au-2026-draft`), separately from the two real agreements |
| `tests/agreement-au-draft-variant.test.js` | The checks described in this document |
| `assets/legal/src/agreement-2026.html` | The standard 2026 agreement. Not touched |

To give the lawyer a PDF: run `bash scripts/build-au-draft-agreement-pdf.sh ~/Desktop/au-agreement-DRAFT.pdf`.
It is 17 pages. Every page has a red band across the top, a diagonal watermark
and a red footer line, all reading "DRAFT - FOR LEGAL REVIEW - NOT FOR SIGNATURE".

## 2. Exactly what differs from the standard 2026 agreement

| Page | Standard agreement | This draft |
| --- | --- | --- |
| Every page | No marking | Red top band, diagonal watermark and red footer line with the draft wording. Small red tags (LR-1 to LR-10) at the spots listed in section 4 |
| 1 Cover | Title "Australia Medical Recruitment / Pricing Schedule 2026" | Same title, unchanged. One line added underneath: "FOR GPs ALREADY BASED IN AUSTRALIA" |
| 2 How we do it | "Matching" and "Contractual arrangements", then "Registration support for doctors based overseas" (6 to 9 months of support, AMC/EPIC documents, liaison with RACGP, AHPRA and Medicare, visas and migration) | "Matching" and "Contractual arrangements" word for word. The overseas section is **replaced** by "GPs already based in Australia" (full new wording below) |
| 3 The GP Link Difference | Three sections | Word for word the same. Only a review tag added |
| 4 Fees | Two fee tables | Word for word and figure for figure the same. The "based in Australia" column is outlined in a darker blue so the eye goes to it. Nothing is re-ordered |
| 5 Guarantee, locum, withdrawal | | Word for word the same |
| 6 Agreement to terms, fee summary | | Word for word the same |
| 7 to 16 Clauses 1 to 16 | | Word for word the same |
| 17 | Does not exist | "Notes for legal review": the ten questions in short form. Marked as not part of the agreement. Removed before any real use |

### The new wording on page 2 (the only new sentences in the document)

> **GPs already based in Australia**
>
> A GP who is already based in Australia and registered here can usually start
> with you far sooner than a doctor moving from overseas. There is no overseas
> registration process to wait for and, where the doctor already has the right
> to work in Australia, no visa to wait for. The start date is normally set by
> the doctor's notice period at their current practice and by the Medicare
> provider number for your location.
>
> Before we present a GP who is already based in Australia, we:
>
> - Check the doctor's registration on the public Ahpra register of
>   practitioners, including the type of registration and any conditions,
>   undertakings or notations shown there
> - Confirm what the doctor needs to work and bill at your location, including a
>   Medicare provider number
> - Tell you about anything we have not been able to confirm
>
> A 12-week guarantee period applies to permanent placements, on the conditions
> set out in the fee schedule and in clause 7 of the Recruitment Services
> Agreement.

Choices made in that wording, so they can be challenged:

- It uses the agreement's own phrase, "based in Australia", and does not
  introduce "Australian-registered" or "Australian GP" as a new term (see LR-1).
- "No visa to wait for" is limited to a doctor who "already has the right to
  work in Australia", because some doctors already here are tied to a sponsor.
- It says "can usually" and "normally". It gives no number of days or weeks.
- The guarantee sentence points to the existing terms and adds nothing.
- The regulatory statements (a provider number is needed for the practice's
  location) are the working assumptions of the build and have not been checked
  against a source. They need confirming before use.

### What was deliberately left alone

- **The cover title.** It still says "Pricing Schedule 2026" although the
  document is the full Recruitment Services Agreement. That mismatch is a known
  open owner decision and has not been changed here.
- **The order of the fee tables.** The overseas column still comes first. Moving
  the Australian column first would have been presentation only, but it would
  also have meant the two documents could no longer be compared word for word,
  so it was not done. It is an easy change once the lawyer is content.
- **Two sentences on pages 2 and 3 that were written with overseas recruitment
  in mind**: "for every 3 interviews … at least 1 successful placement" and "We
  usually only submit each candidate to 2-3 practices". The second no longer
  matches how Australian GPs will be handled (the build allows up to 4 active
  applications). Both are tagged LR-7 instead of being re-written.

## 3. Statement of what is unchanged

Fees, payment timing, the guarantee and credit terms, the withdrawal fee, the
locum terms and every numbered clause are the same in this draft as in the
standard 2026 agreement. The figures, with where they are written:

| Term | Wording in the standard agreement | Where |
| --- | --- | --- |
| Full-time, based in Australia | $0 on acceptance, $21,000 on commencement, total $21,000 | `assets/legal/src/agreement-2026.html` lines 198, 204, 210; summary lines 332-334 |
| Part-time, based in Australia | $0 on acceptance, $18,000 on commencement, total $18,000 | lines 231, 237, 243; summary lines 342-344 |
| Timing, based in Australia | "For Australian-based GPs, the full fee is invoiced when the placed doctor commences work. All fees are exclusive of GST." | lines 184-185 |
| Full-time, based overseas | $12,500 + $12,500 = $25,000 | lines 197, 203, 209 |
| Part-time, based overseas | $10,500 + $10,500 = $21,000 | lines 230, 236, 242 |
| Discounted agreement (a separate, existing document; not part of this draft) | Based in Australia $19,000 full-time, $17,000 part-time; overseas $20,000 and $18,000 | `assets/legal/src/agreement-2026-discounted.html` lines 218, 224, 251, 257; summary lines 343-358 |
| Guarantee | 12 weeks; 80% / 50% / 35% credit | lines 258-270; clause 7.1 lines 589-597 |
| Part-time to full-time | Difference payable within 12 months | lines 216-218; clause 6.12 lines 582-584 |
| Withdrawal after the doctor signs | 50% of the total fee | lines 285-289; clause 6.10 lines 572-576 |
| Never commenced | Initial fees refunded less $2,500 | clause 7.4 lines 640-641 |

Owner decisions this draft follows: no separate price for a doctor already in
Australia with restrictions (decision 3); payment timing not changed (decision
4); placements of GPs without VR are switched off by default (decision 5); locum
work is out of scope (decision 10); nothing goes live (decision 12).

## 4. Open questions for the lawyer

Each question has a tag. The same tag appears in red in the draft at the places
listed, and on the notes page at the back of the draft. "Issue" numbers refer to
the "Commercial and legal" list in `docs/au-gp/review-report.md`.

### LR-1. Who counts as "based in Australia"? (issue 1)

**Marked at:** page 2 new paragraph; page 4 section 1.1; page 6 fee summary;
page 8 the definition of "Our candidate/s".

The fee that applies depends on whether the candidate is "based overseas" or
"based in Australia". The agreement uses three phrases ("Australian-based GPs",
"GP candidates based in Australia", "Australian GP") and clause 2 defines none
of them.

- Should there be a single defined term?
- What should decide it: where the doctor lives when presented, where they are
  registered, whether they already have the right to work, or how much work GP
  Link has to do?
- At what moment is it decided: presentation, contract, or commencement?
- **Consequence of the owner's decision not to price separately.** A doctor who
  trained overseas, is already working in Australia, but still needs a visa
  transfer or new supervision paperwork is, on the present wording, "based in
  Australia". The practice pays $21,000 on commencement, not $25,000 in two
  payments, even though GP Link does much of the overseas work. The owner has
  accepted that. The questions are whether the wording makes that outcome clear
  to both sides, and whether a practice could argue the other way for a doctor
  GP Link regards as overseas (for example one who is visiting Australia, or who
  holds Australian registration while living abroad).

### LR-2. The statement about specialist registration (issue 2)

**Marked at:** page 5, "Most candidates already based in Australia will hold, or
be immediately eligible for, specialist registration (VR)."

- Is this a statement a practice could rely on about a particular candidate?
- GP Link's system will not present a GP without VR unless a role has been
  explicitly opened to them, and that is off by default. If the owner later
  turns it on, does the agreement need a carve-out, or a disclosure given for
  each candidate, and what should it say?
- Is "immediately eligible" precise enough?

### LR-3. Nothing is payable until the doctor starts (issue 3)

**Marked at:** page 4, the two "$0" first payments; page 12 clause 6.10.

The owner has decided to keep this timing. **This is recorded as an accepted
commercial risk, not an open design question.** For a GP based in Australia GP
Link is paid nothing until commencement, and a doctor's notice period can be
about three months. The 50% withdrawal fee applies only after the candidate has
signed a contract.

- Is there anything the lawyer would still advise about the period between a
  practice accepting a candidate and the doctor starting?
- Does clause 5.1(d) or clause 6.1 already give GP Link anything in that period?
- If the owner ever revisits the timing, what would need to change and where
  (page 4, page 6, clauses 6 and 7.4)?

### LR-4. Clause 7.4 for a GP based in Australia (issue 4)

**Marked at:** page 13 clause 7.4.

"If a candidate does not commence employment, any initial permanent placement
fees paid will be refunded, less an administration fee of $2,500 where the
candidate received registration support from us." No initial fee is paid for a
candidate based in Australia.

- Does the clause have any effect for these placements?
- Could it be read as allowing a $2,500 charge on its own, or as preventing one?
- Should the agreement say what happens when a GP based in Australia does not
  commence?

### LR-5. The guarantee (issue 5)

**Marked at:** page 5 guarantee paragraph; page 11 clause 6.5; page 12 clause 7.1.

Unchanged: 12 weeks from commencement, credit only, 80% / 50% / 35% measured on
the last working day, forfeited if any invoice "is or has been overdue".

- Are the conditions in clause 7.2 workable for a local placement that starts
  within weeks?
- GP Link does not yet record commencement dates, invoice dates or guarantee end
  dates in its system (that is being built). What records does it need to keep
  to apply or refuse a credit?
- Is forfeiture for any late invoice, including an unrelated one, something the
  lawyer wants to look at in the unfair-contract-terms review (LR-10)?

### LR-6. Part-time moving to full-time (issue 6)

**Marked at:** page 4 section 1.2; page 12 clause 6.12.

The difference between the part-time and full-time fee ($3,000 for a GP based
in Australia) becomes payable if a part-time placement reaches an average of
eight or more sessions a week within 12 months. This is expected to
be common for local GPs.

- Over what period is the "average" measured?
- Is the practice obliged to tell GP Link? (Clause 5.1 does not say so in terms.)
- What evidence may GP Link ask for?

### LR-7. The positioning pages (issue 7)

**Marked at:** page 1 cover line; page 2 "1 in 3 interviews" sentence and the
new section heading; page 3 "2-3 practices"; page 10 clause 5.1(f); page 15
clause 12.1.

- Do the new page 2 statements (faster start, no visa wait where the doctor has
  the right to work, the register check, the provider number) create promises?
  How do they sit with clause 4 (no representations), clause 5.1(e) (the
  practice satisfies itself), clause 8.1 and clause 16.2 (no reliance on
  anything not in the terms), given that these pages are inside the document?
- Should the two carried-over sentences be kept, changed or removed?
- Clause 5.1(f) makes the practice responsible for work permits and visas. Does
  it need anything for a doctor already here on a sponsor-tied visa?
- Clause 12.1 sets the fee for hiring GP Link's staff at "the full-time overseas
  placement fee". Is that still the right reference in an Australia-focused
  presentation?
- Is it acceptable to have two presentations of one agreement in circulation, or
  should there be one document?

### LR-8. Practices that signed an earlier version (issue 8)

**Marked at:** page 7 clause 1.4.

Some practices signed the version in use before July 2026. **It is not known
which practices, or what that version says about GPs based in Australia.** This
has not been checked.

- Which version governs a placement of a GP based in Australia with one of those
  practices?
- Do they need to re-sign before an Australian GP is presented to them?

Owner action: find the earlier version and the list of practices that signed it.

### LR-9. Locum terms (issue 9)

**Marked at:** page 5 section 1.3; page 12 clause 6.11.

Carried over unchanged. Locum work is out of scope for the Australian GP build
and GP Link's system has no locum job type, timesheet or weekly billing. No
question is asked here beyond: should locum terms stay in a document whose
service GP Link is not currently set up to deliver?

### LR-10. The unfair-contract-terms review is still outstanding

**Marked at:** page 7 clause 1.1; page 11 clause 6.3; page 14 clause 8.1(b);
page 16 clause 16.2.

The 2026 agreement was drafted to favour GP Link and has not had an
unfair-contract-terms review. Most practices are small businesses. This draft
changes none of those terms and so inherits the position exactly. The terms
previously flagged for that review include acceptance by conduct (1.1, 1.2),
variation on 14 days' notice (6.3), forfeiture of the guarantee (6.5, 7.2(c)),
the indemnities (6.8, 11.3), the liability cap (8.1) and the acknowledgement in
16.2.

- Can this review be done on the standard agreement and this presentation
  together?
- Does putting a draft in front of a practice risk anything under clause 1.1?

## 5. Not checked

- No lawyer has seen this draft.
- The regulatory statements on page 2 are working assumptions.
- The layout was checked on one computer by rendering it with Chrome and
  measuring that no page's text runs past its footer line (pages are fixed-size
  and silently cut off text that overflows). Re-check after any edit: add a
  short script to a temporary copy that compares, for each `.page`, the bottom
  of `.content` with the top of `.footer-line`.
- Which practices are on the pre-July-2026 version (LR-8).

## 6. Owner actions

1. **Lawyer review before any practice is sent it.** Give the lawyer this
   document and a PDF of the draft. Ask for the unfair-contract-terms review of
   the standard agreement at the same time, since the terms are the same.
2. Confirm the regulatory statements on page 2 in writing.
3. Find the pre-July-2026 agreement and who signed it.

### What making it usable would involve technically

Only after the lawyer has signed off, and as a deliberate, separate change:

1. Apply the lawyer's edits to the draft source. If a clause changes, decide
   whether the standard agreement should change too.
2. Remove the draft markings: the red band on each page, the watermark and
   footer rules, every "LR" tag, and page 17.
3. Move the source to `assets/legal/src/agreement-2026-au.html`, build the PDF
   with `bash scripts/build-practice-agreement-pdf.sh au`, check every page for
   cut-off text, and commit the PDF beside the other two.
4. In `lib/agreement-variants.js`, move the entry from the draft list to the
   list of real agreements, with a new key that does not contain "draft".
5. Add it to the drop-down staff use when creating a signing link
   (`js/ceo-ats-practices.js`, about line 730) and update the cache version for
   that script.
6. Update the two tests that pin the list of agreements
   (`tests/practice-sign-only-link.test.js` and
   `tests/agreement-au-draft-variant.test.js`).

No change to `server.js` is needed for any of that: it already serves and stamps
whichever agreement is recorded against the practice.
