# Handoff — ship the 4 "My Practice" fixes to PRODUCTION (main)

**Date:** 2026-07-09
**From:** the session that built + verified these fixes on `worktree-ai-matching-build`.
**To:** the session that will do the production merge.
**Owner ask:** "these fixes should go to production and the preview … so that the fix is also present for their current account" (repro account: Sana Ahsan, `sana.ahsan3@nhs.net`, uid `db02252c-36e8-4b56-86bf-c49ca97fc406`).

## The 4 fixes (all on `worktree-ai-matching-build`, pushed)

In dependency order — apply/ship together, they build on each other:

1. **`e030d1a`** — hired "My Practice" page rubber-bands / won't scroll.
   `pages/career.html`: remove `overscroll-behavior-y: contain;` **and** `overflow-x: hidden;` from `body.career-mode-secured` (the tall secured page's real overflow is on `<html>`; those two turned `<body>` into a dead scroll container that trapped the wheel). Also removed the temporary scroll-diagnostic scaffolding. `sw.js` VERSION bump. Test in `tests/career-placement-by-association.test.js`.
2. **`23e5897`** — Split/Relocation showed "Pending"; "Download contract" saved the page.
   `server.js` `buildCareerPlacementPayload`: read the still-valid `career_contract_extract:<zoho_application_id>` runtime_kv cache back into `contractTerms` (Zoho decommission had hardcoded it `null`), and key it off the local `gp_applications.zoho_application_id` via a **new `applicationId` param** (the live Zoho `applicationRecord` is always null now, so `appId` was empty). Contract URL now only set when a **servable** `offer_contract` doc exists (dead `/api/career/contract` route removed from the path). `career.html`: contract anchor no longer ships `href="#"`+`download` (that saved "career.html"). Cached `placement_payload` values carrying the dead URL are sanitised on read.
3. **`be53c09`** — contact buttons pointed at the DEMO practice (Murrumbidgee); contract button dead.
   `career.html` `resolveSecuredPlacement`: add a `hasServerPlacement` guard so a REAL placement with an empty phone/email/WhatsApp/contractUrl **stays empty** (never borrows the demo fallback). Contact buttons ship inactive + enable only via new `setContactChannel()` when a real channel exists; demo hrefs removed from static markup. `server.js` `buildCareerPlacementPayload`: when there's no live contact record, read the GP's real `registration_cases.practice_contact`.
4. **`43aef1b`** — admin "Prepared by GP LINK → Offer/contract" upload gave "Upload failed" + never powered the GP download.
   Base64-in-JSON POST exceeds Vercel's ~4.5 MB request-body limit (rejected before the handler; no server error logged). New: `supabaseStorageCreateSignedUploadUrl()` + `POST /api/admin/offer-contract/sign-upload` + `POST /api/admin/offer-contract/finalize` (browser PUTs the raw file straight to Supabase Storage, then finalize delivers it to `user_documents` offer_contract + storage ref, marks `practice_doc_ops` completed, invalidates the GP's `placement_payload` cache). `pages/admin.html`: offer_contract uploads use sign→PUT→finalize. Test `tests/admin-offer-contract-upload.test.js`.

5. **`b27bdd8`** — contact buttons inactive because the only source checked was `registration_cases.practice_contact` (null for most placed GPs).
   `server.js` `buildCareerPlacementPayload`: resolve the practice contact from the app's **Practices section** — the linked `practices` row via `roleRow.practice_id` (`atsGetPracticeRow` → `contact_name`/`contact_email`/`contact_phone`), falling back to the hired application's `practice_contact_name`/`practice_contact_email`, then the registration case. Practice phone is used for WhatsApp too. E.g. Sana → Halekulani → Tarig Mahmoud / drtarig@yahoo.co.uk / +61493844634. Works for all future placed GPs.

> NOTE: `fd79065` (offer/interview flow) sits between #3 and #4 on the branch but is a **separate** fix (another workstream) — not part of this owner ask. Include or exclude it per its own handoff, independently.

> The full owner ask is now **5 commits**: `e030d1a`, `23e5897`, `be53c09`, `43aef1b`, `b27bdd8`. Branch tip when this was written: `b27bdd8` (plus this doc). `main` is a strict ANCESTOR of the branch (0 behind, 44 ahead) — so merging the branch to main is a **fast-forward that ships all 44 commits**; a subset-only prod change must be a fresh backport (Route B).

## Test status
Full suite on the branch: **2603 pass / 1 fail**. The single failure is pre-existing + unrelated (`tests/job-page-offer-mode.test.js` "shell clearance fallback is 70px") — it fails identically with these fixes stashed out. Run: `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH"; node ./node_modules/vitest/vitest.mjs run`.

## Recommended route

**Route A — merge the whole `worktree-ai-matching-build` branch → main (preferred IF the owner is ready to ship the branch).** These 4 commits are already on it and tested; they ride along with zero cherry-pick friction. This is the branch's intended eventual destination. Only caveat: it also ships the branch's other in-progress work (some marked "not browser-verified" in MEMORY.md) — confirm the owner wants all of it.

**Route B — ship ONLY these 4 fixes (curated).** Do **NOT** `git cherry-pick` these SHAs onto main — they will conflict:
  - `e030d1a` deletes scroll-diagnostic scaffolding that **does not exist on main** (main never had `careerScrollDiag`/`reportSecuredScrollDiag`/`watchScroll`).
  - `23e5897`/`be53c09` edit `resolveSecuredPlacement`, which on main is an **older shape**: it references `SECURED_PLACEMENT.practiceContact.*` and `SECURED_PLACEMENT.contractUrl` **directly** (no `FB`/provisional split, no `hasServerPlacement`). See `origin/main:pages/career.html` ~line 10897-10905.
  Instead, **re-apply the fixes fresh against main's code**:
  - `career.html`: (a) remove `overscroll-behavior-y: contain;` + `overflow-x: hidden;` from `body.career-mode-secured` (main ~line 5874); (b) in `resolveSecuredPlacement`, add `const hasServerPlacement = !!(placementApp && placementApp.placement && typeof placementApp.placement === "object");` and change the contact channels + contractUrl to `hasServerPlacement ? (practiceContactPayload.phone || "") : (practiceContactPayload.phone || SECURED_PLACEMENT.practiceContact.phone)` (same for email/whatsapp) and `contractUrl: hasServerPlacement ? (placementPayload.contractUrl || "") : (placementPayload.contractUrl || SECURED_PLACEMENT.contractUrl || "")`; (c) add `setContactChannel()` + disabled-button CSS + strip the demo hrefs from the static contact anchors + the contract-anchor `href="#"`/`download`; (d) bump `sw.js` VERSION.
  - `server.js` `buildCareerPlacementPayload`: add the `applicationId` param + `career_contract_extract` cache read into `contractTerms`; make `contractUrl` come from a servable `offer_contract` doc (`getOfferDocumentRow`) not the dead `/api/career/contract` route; resolve practice contact from the `practices` row (`atsGetPracticeRow(roleRow.practice_id)` → contact_name/email/phone) → hired `gp_applications.practice_contact_name/email` → `registration_cases.practice_contact`; sanitise cached `placement_payload.contractUrl` that starts with `/api/career/contract`. Pass `applicationId: localApp.zoho_application_id` / `appRow.zoho_application_id` at both call sites.
  - `server.js`: add `supabaseStorageCreateSignedUploadUrl()` + the two `/api/admin/offer-contract/*` endpoints (copy verbatim from the branch — they're self-contained).
  - `pages/admin.html`: the offer_contract branch in the `data-gplink-doc-upload` handler.
  - Bring `tests/admin-offer-contract-upload.test.js` and the new assertions in `tests/career-placement-by-association.test.js`.
  The easiest mechanical way to get exact hunks: `git show <sha> -- pages/career.html server.js pages/admin.html` for each of the 4 SHAs, then hand-apply to main's shapes.

## Data / runtime notes (already true on PROD Supabase — preview shares it)
- Sana's real contract terms live in `runtime_kv` `career_contract_extract:11734000001222012` (Split 65% / Relocation $10,000 / 3 yr, valid to 2026-08-04) — the split/reloc fix reads these; no data migration needed.
- Sana's original contract **PDF** was a Zoho attachment never migrated (gone). The upload fix is how the owner re-attaches it; once uploaded it lands in `user_documents` (`offer_contract`) + Storage and the GP download resolves. No `offer_contract` doc exists for her yet.
- After production deploy, existing GPs' `placement_payload:<appId>` caches (30-min TTL) self-heal; the finalize endpoint also proactively deletes them on contract upload.

## Related memory
`[[career-secured-pending-and-contract-download]]`, `[[career-placement-by-association]]`, `[[preview-branch-working-mode]]`, `[[zoho-decommission-masked-pipeline]]`, `[[gp-billing-split-gp-share]]`.
