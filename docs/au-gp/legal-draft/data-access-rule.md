# Who can see a doctor's identity and credential data: today, and one proposed rule

**DRAFT - FOR LEGAL REVIEW - NOT PUBLISHED**

Work package WP-25, finding DAT-25 (and the retention gap DAT-24). Written
20 November 2026 from the code on branch `au-gp-testing` at commit `60491526`.
All line numbers are `server.js` at that commit unless another file is named.

**Nothing in the product was changed to write this.** Part 1 describes what the
code does today. It was established by reading the code, not by signing in as
each role and trying it, so every "can" below means "the code allows it". Part 2
proposes one rule. Part 3 lists the exact changes a later package would make.

Roles used in the code (`normalizeAdminRole`, line 17744):

| Name here | Role value | Reaches |
| --- | --- | --- |
| CEO / super admin | `super_admin` | Everything. |
| Consultant | `consultant` | Only routes guarded by `requireAtsSession` (21174) or `requireAdminOrAtsSession` (21220). Rejected by `requireAdminSession` (21124). Sees every candidate; there is no per-consultant assignment. |
| RSO | `admin` or `staff` | Routes guarded by `requireAdminSession`. Per-doctor routes normally add `ensureAdminCaseAccess` (853), which limits an RSO to doctors whose case is assigned to them. |
| Doctor | signed-in user | Their own records only (`requireSession`). |
| Practice | no account | Token links in emails (`/api/practice/...`). |

## Part 1. What the code allows today

### 1.1 Identity document (passport or ID image captured at onboarding)

Stored by `saveIdentityDocumentForUser` (11514): a file in Supabase storage at
`users/<id>/identity/current`, a `user_documents` row with key `identity`, and a
copy in the doctor's Google Drive folder, "ID" subfolder, named `ID — ...`.
Older accounts may also hold the image inside `user_profiles.id_copy_data_url`.

The stated intent, in the comment above `canViewIdentity` (17758-17761): "viewable
by CEO (super_admin) and ATS users (consultant) only, never RSOs".

| # | Route | Guard | Who gets the identity document | Logged? |
| --- | --- | --- | --- | --- |
| A | `GET /api/admin/gp-documents` (75217; identity block 75542-75553) | `requireAdminSession` + `ensureAdminCaseAccess`, then `canViewIdentity` (super admin only) | CEO only. An assigned RSO gets the rest of the page with `identityDocument: null`. | **No.** No audit entry is written when the CEO is given the link. |
| B | `GET /api/ats/candidate-id` (90283) | `requireAtsSession` | CEO **and every consultant, for any doctor**. | Yes: `ats_id_viewed` (90307). |
| C | `GET /api/admin/gp-document-preview?case_id=…&key=…` (81663) | `requireAdminSession` + `ensureAdminCaseAccess`. **The `key` is whatever the caller sends; it is looked up directly in `user_documents` (81706-81707).** | CEO, **and an RSO assigned to that doctor, if they ask for `key=identity`**. Nothing in this route calls `canViewIdentity`. The admin page never asks for that key, so it is not reachable by clicking, only by typing the address. | No. |
| D | `GET /api/admin/visa/case` (83720) | `requireAdminSession` + `ensureAdminCaseAccess` (83736) | Returns the doctor's whole profile row (`select=*`, 83740). Where an older account still has `id_copy_data_url` filled, that image goes to the CEO **and the assigned RSO**. | No. |
| E | Google Drive | Drive sharing, not the app | The `ID — ` file is shared with `hello@mygplink.com.au` only (`applyDriveDocPermissions`, mode `id_private`, 1259-1261). It is filtered out of the Drive file list the admin page shows (75537-75539). | Google's own log only. |
| F | `POST /api/admin/gp-identity-delete` (75591) | `requireAdminSession` + `canViewIdentity` | CEO only can delete on request. | Yes: `identity_deleted`. |
| G | Staff upload on the doctor's behalf (ATS candidate upload, slot `idDoc`, 90189) | `requireAtsSession` | CEO and consultants can file a new ID. | Yes (upload audit, 90225). |

**So the two routes the review pointed at do differ** (A: CEO only; B: CEO and
all consultants), and reading on from there found two more ways in (C and D)
that let an **assigned RSO** reach an identity image, against the stated rule.
C is the important one.

### 1.2 Ahpra registration details of an Australian GP (`gp_credentials`)

New in this build. Number, registration type, conditions, undertakings,
notations, expiry, fellowship, 19AB answer, work rights, visa subclass / expiry /
sponsor, supervision level, indemnity provider and expiry.

| Route | Who |
| --- | --- |
| `GET/POST /api/admin/candidate/pathway` (71456), guard `ensureAuPathwayStaffAccess` (6205) | CEO: any doctor. Consultant: any doctor. RSO: only doctors assigned to them. Switch off: the route answers 404. |
| Database | Row-level security allows the server only (`gp_credentials_service_all`); a browser cannot read the table directly. |
| Doctor | Their own answers through the profile endpoints (CONVENTIONS section 3). The staff-only columns (`ahpra_last_checked_*`, `moratorium_19ab_confirmed_*`, `staff_verified_*`) are not writable by the doctor. |
| Practice | Nothing from this table reaches a practice today. |

For overseas doctors the older fields are separate: `registration_cases.ahpra_registration_*`
(read through the case, RSO-scoped) and `user_profiles.register_*` (the
public-register check). A practice is shown one thing derived from these: the
label "<body> registration verified" in the introduction (58100, 67381).

### 1.3 Medicare provider number and PBS prescriber number (`pbs_applications`)

| Route | Guard | Who |
| --- | --- | --- |
| `GET /api/pbs/status` (83754) | `requireSession` | The doctor, own rows. |
| `GET /api/admin/pbs/cases` (84039) | `requireAdminSession`, then filtered to assigned doctors (84059-84063) | CEO: all. RSO: assigned only. |
| `GET /api/admin/pbs/case` (84070) | + `ensureAdminCaseAccess` (84084) | CEO: all. RSO: assigned only. |
| `POST /api/pbs/update` (83789), `/api/pbs/updates` (83948), `/api/pbs/events` (83970), `/api/pbs/documents/review` (83989), `/api/pbs/documents/request` (84016) | `requireAdminSession` **only** | **Any RSO can write to any doctor's record**, including setting the provider and prescriber numbers. Reading is limited to assigned doctors; writing is not. |
| Consultants | | No access (these are not ATS routes). |
| Practice | | Not sent by these routes. |

### 1.4 Indemnity certificate

Uploaded by the doctor at `POST /api/commencement/upload-indemnity` (72781);
stored as a `user_documents` row (`professional_indemnity_insurance`) and
copied to Google Drive.

- Staff: seen through routes A and C above, so CEO and the assigned RSO.
  Consultants have no route to it.
- **Google Drive:** the copy is made with `uploadToGoogleDrive` (72813), which
  sets the file to **"anyone with the link can view"** (1168-1175). A later
  tidy-up (`reconcileGpDrive`, 1367-1371) re-shares accepted documents to the
  team only, which removes the public link, but only when that tidy-up runs for
  that doctor and only for documents in an accepted status. Between upload and
  tidy-up the file is readable by anyone holding its link. The same is true of
  every document that goes through `uploadToGoogleDrive` (it has about a dozen
  callers). Whether any such link has ever been sent outside the team was not
  traced.
- After the tidy-up, the file is shared with the whole `mygplink.com.au` domain
  and **every** RSO on the team list (1262-1276), not just the assigned one.

### 1.5 Visa case, visa documents, grant notices, dependants

| Route | Guard | Who |
| --- | --- | --- |
| `/api/visa/*` doctor routes (82891 onwards) | `requireSession` | The doctor, own case. |
| `GET /api/admin/visa/cases` (83690) | `requireAdminSession`, filtered (83710-83714) | CEO: all. RSO: assigned only. |
| `GET /api/admin/visa/case` (83720) | + `ensureAdminCaseAccess` | CEO: all. RSO: assigned only. (Also returns the full profile row: see 1.1 D.) |
| `GET /api/admin/visa/dependants?caseId=…` (83678) | `requireAdminSession` **only** | **Any RSO can read the dependants (family members) of any visa case** by its id. |
| Consultants | | No access. |
| Practice | | Not traced in full. Sponsorship needs the practice's involvement and some documents are emailed to the practice contact by staff action (for example `request-revision`, 81741). What a practice receives by email about a doctor's visa was not mapped. |

### 1.6 What a practice sees

Before a doctor applies: nothing about the doctor. (Roles shown to a doctor hide
the practice's street address and contacts until the practice accepts them; that
is the other direction.)

After the doctor presses "Apply for interview" on a role (`/api/career/apply`,
61950) a staff member presses "Submit to practice"
(`/api/admin/career/application/submit-to-practice`, 67153; CEO, consultant or
any RSO). The practice is emailed, and can re-open by token link
(`/api/practice/application/decision-context`, 58011):

- the doctor's **name**;
- a short introduction paragraph and "fact chips" built from country of
  registration, specialty, target date and "<body> registration verified";
- optionally an AI-written recommendation;
- the doctor's **CV** and cover letter as attachments, and a token link to the
  CV (`/api/practice/application/cv`, 58135).

Not sent: identity document, registration number, provider numbers, visa
details, indemnity.

**There is no recorded consent.** Pressing "Apply for interview" is treated as
the doctor's agreement. The confirmation sheet (`pages/job.html:1507-1514`) says
only how many interviews a month are allowed; it does not say that name and CV
will go to that practice, and nothing is stored recording that the doctor
agreed. The live privacy page goes further and says "By using GP Link, you
consent to us sharing your professional profile with medical practices".

### 1.7 Retention of the identity document (DAT-24)

A daily job, `GET /api/cron/purge-identity-docs` (56799; scheduled in
`vercel.json`), deletes a doctor's identity document from storage, Drive, the
`user_documents` row and the old profile fields (`purgeStoredIdentityDocument`,
11590) when either is true (`lib/identity-retention.js`):

- **six months (182 days) after placement**, or
- **twelve months (365 days) with no activity** on the account.

It is on by default (`IDENTITY_PURGE_DISABLED=true` makes it log only).

**The gap.** "Placement" is read as: the doctor has a `gp_applications` row with
`status = 'hired'` (56815-56817). But the in-app placement path never writes
that. It sets the board column `ats_stage = 'hired'` (48902, through
`atsUpdateApplicationStageRow`, which writes only `ats_stage`, 45631) and sets
`status = 'placement_secured'` (48907-48909). The code's own comment says
application status "only moves at the endpoints ('applied' →
'placement_secured'/'withdrawn')" (29419-29420). So for a doctor placed through
the app, the six-month rule never starts. Their identity document is deleted
only by the twelve-month inactivity rule, and a placed doctor who keeps using
the app is never inactive, **so it may be kept indefinitely**. The same
`status = 'hired'` test is used by `userHasActivePlacement` (22769).

Whether any production row carries `status = 'hired'` (older Zoho-synced
applications could) was not checked.

Only the identity document has a timed deletion. No timed deletion was found for
CVs, qualification documents, `gp_credentials`, provider numbers, visa records,
indemnity certificates, call recordings (`lead_calls`), enquiries
(`site_enquiries`), WhatsApp messages or meeting summaries.

Two related points:

- **Account deletion.** A doctor can close their account
  (`POST /api/account/delete`, 56323). It is archived for 90 days
  (`ACCOUNT_ARCHIVE_GRACE_MS`, 22713), then the `purge-accounts` job deletes the
  sign-in, unless `userHasActivePlacement` is true. That test is the same
  `status = 'hired'` (22769), so it has the same gap in the other direction: a
  doctor placed through the app is **not** protected from the 90-day deletion.
  No code was found in that job that removes the doctor's stored files or
  Google Drive folder.
- **Backups.** A weekly job (`/api/cron/weekly-backup`, 55116) copies whole
  tables, including `user_profiles` (which holds the old identity image column),
  `user_documents`, visa and provider-number tables, to Google Drive. Nothing
  prunes those copies, and the identity deletion does not reach into them. So
  a deleted identity image can live on in older backups.

### 1.8 Summary of what differs today

| Data | CEO | Consultant | Assigned RSO | Other RSO | Practice |
| --- | --- | --- | --- | --- | --- |
| Identity document | Yes (A, B, C, D) | Yes, any doctor (B) | **Yes by direct address (C); old accounts via D**. Meant to be no. | No | No |
| Ahpra details (`gp_credentials`) | Yes | Yes, any doctor | Yes | No | No |
| Provider / prescriber number | Yes | No | Read yes; write yes | **Write yes**, read no | No |
| Indemnity certificate | Yes | No | Yes | Via Drive share once tidied | No (but see the Drive link point) |
| Visa case and notices | Yes | No | Yes | **Dependants: yes by id** | Not mapped |
| CV | Yes | Yes | Yes | No | After submission |

## Part 2. One proposed rule

Three classes of data, one table. The same answer on every route, and every
release of class 1 or 2 data to staff is written to the audit log.

- **Class 1, identity documents:** passport or ID image, wherever it is held.
- **Class 2, regulated credentials:** Ahpra number, registration type,
  conditions, undertakings, notations; fellowship; 19AB status; work rights and
  visa details and notices; provider and prescriber numbers; indemnity
  certificate and details.
- **Class 3, professional profile:** name, CV, cover letter, the introduction.

| Role | Class 1 identity | Class 2 credentials | Class 3 profile |
| --- | --- | --- | --- |
| The doctor | Own: view, replace, ask for deletion. | Own: view and correct. Staff verification fields are read-only. | Own. |
| CEO / super admin | Any doctor. Logged. | Any doctor. Logged. | Any. |
| Consultant | Candidates only, until placement. Logged. **[OWNER DECISION A]** | Candidates until placement (owner decision 6: the consultant owns an Australian GP until placement). | Any candidate. |
| RSO assigned to the doctor | **Never.** | Yes, for doctors assigned to them, read and write. | Yes. |
| RSO not assigned | Never. | Never, read or write. | Never. |
| Practice, before the doctor consents to that practice | Nothing. | Nothing. | Nothing that identifies the doctor. |
| Practice, after the doctor consents to that practice | Never. | Only: the Ahpra registration number and type, and "checked on the public register on <date>" (the register is public). Never conditions text, visa details, indemnity or numbers. **[OWNER DECISION B]** | Name, introduction, CV, cover letter. |
| Practice, after placement | Never through the app. | What that practice needs to start the doctor at its own location, sent by a deliberate staff action and recorded. **[OWNER DECISION C]** | As above. |
| The doctor's current employer | Never, at any stage. Not contacted. | Never. | Never. |
| Public / anyone with a link | Nothing. No file is shared "anyone with the link". | Nothing. | Nothing. |

Three points only the owner can settle:

- **A. Consultants and identity documents.** Today every consultant can open
  any doctor's ID. The proposal keeps consultant access (they run the identity
  review for candidates) but stops it at placement. The stricter alternative is
  CEO only. The looser one is today's behaviour.
- **B. What a practice may be told about registration before interview.** The
  proposal is the number, the type and the date it was checked. If the owner
  prefers, nothing but "registration checked" (today's behaviour for overseas
  doctors).
- **C. What a practice receives after placement.** Not mapped in the code (see
  1.5). The rule should be written down once the owner says what practices
  actually need.

## Part 3. The code changes a later package would make

Not applied. Each is small and independent. All need tests for the Australian
behaviour and the unchanged overseas behaviour (AGENT-RULES section 5).

**C1. One predicate, used everywhere.** `server.js:17758-17761`.

Before:

```js
// The identity document is viewable by CEO (super_admin) and ATS users
// (consultant) only — never RSOs. ATS surfaces gate via requireAtsSession; admin
// surfaces gate with this predicate.
function canViewIdentity(ctx) { return isSuperAdminRole(ctx && ctx.role); }
```

After (new helper file `lib/data-access-rule.js`, pure, unit-tested; `server.js`
keeps `canViewIdentity` as a thin wrapper so existing callers do not change):

```js
// lib/data-access-rule.js
const IDENTITY_DOCUMENT_KEYS = new Set(['identity']);
function canViewIdentity(role, { placed } = {}) {
  if (role === 'super_admin') return true;
  if (role === 'consultant') return !placed;   // OWNER DECISION A
  return false;                                 // RSO: never
}
function isIdentityDocumentKey(key) { return IDENTITY_DOCUMENT_KEYS.has(String(key || '').trim().toLowerCase()); }
```

**C2. Close route C.** `server.js:81668`, straight after `gdpKey` is read:

```js
if (dataAccessRule.isIdentityDocumentKey(gdpKey) && !canViewIdentity(gdpAdmin)) {
  await logAdminAction(req, gdpAdmin, 'admin_identity_view_refused', { targetType: 'case', targetId: gdpCaseId, success: false });
  sendJson(res, 403, { ok: false, message: 'CEO/ATS access required.' });
  return;
}
```

This is the one change worth making before the rest of the package, because it
closes a way round an existing rule. It changes nothing for any screen: no page
requests that key.

**C3. Stop sending the whole profile row.** `server.js:83740`.

Before: `` `select=*&user_id=eq.${…}&limit=1` ``

After: name the columns the visa screen uses (read `pages/admin-visa.html` /
`js/admin-visa*.js` to list them) and never include `id_copy_data_url` or
`id_copy_name`. The same applies to the other three `user_profiles` `select=*`
reads (50377, 58081, 67257). 58081 and 67257 build the practice introduction
on the server and return no raw column to the practice today, but an explicit
list keeps it that way once the new Australian columns exist.

**C4. Log route A.** `server.js:75551`, when `idUrl` is produced:

```js
await logAdminAction(req, gdAdminCtx, 'admin_id_viewed', { targetType: 'gp', targetId: gdUserId, detail: { case_id: String(gdCaseId).slice(0, 120) } });
```

Note this route builds the link every time the Documents tab is opened, whether
or not the CEO looks at it. Better: return only `identityDocument: { available: true }`
here and have the page call `/api/ats/candidate-id` (already logged) when the
CEO presses "View".

**C5. Consultant access stops at placement.** `server.js:90283-90312` (route B)
and the upload at 90189: after resolving the user id, look up whether the doctor
is placed (`isSecuredApp` in `ceoMetrics`: status in the secured set or
`ats_stage = 'hired'`) and call `canViewIdentity(role, { placed })`. Only if the
owner chooses option A as proposed.

**C6. Scope the PBS write routes.** `server.js:83791`, `83950`, `83972`,
`83991`, `84018`: after `requireAdminSession`, resolve the target doctor's user
id and add

```js
if (!(await ensureAdminCaseAccess(adminCtx, await fetchCaseAssignmentByUserId(targetUserId), res))) return;
```

(the pattern already used at 84084). Check each route's body for where the user
id or application id comes from.

**C7. Scope the dependants read.** `server.js:83681`, after the case id is read:
load `visa_applications.user_id` for that id and apply the same
`ensureAdminCaseAccess` line.

**C8. No public Drive links.** `server.js:1167-1175` (`uploadToGoogleDrive`)
and `1140-1146` (`createGoogleDriveFolder`).

Before:

```js
await drive.permissions.create({ fileId: res.data.id, requestBody: { role: 'reader', type: 'anyone' } });
```

After: `await applyDriveDocPermissions(res.data.id, 'team_domain');`

**Careful:** the comment says the public link exists "so admin preview works",
and prepared documents are "GP-facing via existing links" (1359). This change
needs the admin preview and the doctor's document links tested first, and a
one-off script to re-secure files already uploaded. It affects the overseas
product, so it is **not** behind the Australian switch and needs the owner's
separate go-ahead. Listed as an owner action.

**C9. Record consent before a profile goes to a practice.** New nullable columns
(additive migration): `gp_applications.profile_share_consent_at timestamptz`,
`profile_share_consent_version text`. `POST /api/career/apply` (61950) stores
them when the request carries the ticked consent (wording C in
`consent-wording.md`). `submit-to-practice` (67153) refuses, for an Australian
pathway, an application without it. Overseas doctors: unchanged until the owner
decides to add the same line to their apply sheet. Per AGENT-RULES, the new
columns may only be named in queries that run with the switch on.

**C10. Fix the retention anchor (DAT-24).** `server.js:56815-56817`.

Before:

```js
'select=updated_at,applied_at&user_id=eq.' + encodeURIComponent(idpUserId) +
'&status=eq.hired&order=updated_at.desc&limit=1'
```

After (same secured test the CEO "Secured" tile uses, 49168-49172):

```js
'select=updated_at,applied_at,ats_stage_updated_at,status,ats_stage&user_id=eq.' + encodeURIComponent(idpUserId) +
'&or=(status.in.(hired,secured,placed,placement_secured,contract_signed),ats_stage.eq.hired)&order=updated_at.desc&limit=1'
```

**Do not ship this without the owner's say-so.** On its first run it would
delete the identity document of every doctor placed through the app more than
six months ago. That may be exactly what the privacy promise requires, or the
business may still need some of them (for example a registration or visa step
still running after placement). Run it first with `IDENTITY_PURGE_DISABLED=true`
and read the logged list. Also decide whether "placement" should mean the date
of acceptance or the date the doctor starts work; `updated_at` moves whenever
the row is edited, which restarts the clock. The same fix applies to
`userHasActivePlacement` (22769), but that function has other callers: check
each before changing it.

**C11. Tests.** A table-driven test of `lib/data-access-rule.js`; server tests
proving: RSO + `key=identity` is a 403; consultant after placement is a 403;
RSO not assigned cannot write a provider number; overseas doctor screens
unchanged with the switch on and off.

## What could not be established from the code

- Whether anyone has actually used route C or D to view an identity document
  (no audit entry is written on either).
- What a practice is sent about a doctor after placement, across all the
  staff-triggered emails.
- Whether Supabase row-level security on the older tables (`user_documents`,
  `pbs_applications`, `visa_applications`) matches the server's rules. Only
  `gp_credentials` was confirmed (service role only).
- Who, outside the app, has been given access to the Google Drive folders by
  hand.
- Whether any production application row has `status = 'hired'`.
