# Australian GP testing: what the preview and local environments are connected to

Read-only audit, 20 November 2026. Nothing was changed in code, Vercel, the database or any outside service. No secret values or personal details appear in this file; secrets were compared by short fingerprint only.

Code read from branch `au-gp-testing` at commit `bf5f8ce7`. Line numbers refer to `server.js` on that commit unless another file is named.

---

## Plain-English summary

**1. The preview is not a sandbox. It is the live business with a different front door.**
The preview website for this branch uses the same live database as the real app, and the same live keys for email (Resend), WhatsApp (DoubleTick), Calendly, Google (Gmail, Drive, Calendar), the AI services and Facebook. A doctor created on the preview is a real row in the live database. A message triggered on the preview is a real message.

**2. The preview address is open to anyone who has the link.**
There is no Vercel login wall in front of it. You do not need to be signed in to Vercel to open it. The app's own sign-in still applies.

- Stable address: `https://gplink-repository-git-au-gp-testing-gplinkrecruitments-projects.vercel.app`
- It is built and ready, on the right commit.

**3. You can sign in on the preview, with three things to know.**
- Doctor sign-up and sign-in work. Go straight to `/pages/signin`, because the bare address sends you to the admin sign-in.
- The admin dashboard and the CEO dashboard both work, but only for a super-admin account (yours). A normal staff (RSO) login is refused on a preview address.
- Links inside emails and WhatsApp messages sent from the preview point at the live app (`app.mygplink.com.au`), where the Australian feature is switched off. Clicking one takes you out of the test.

**4. Scheduled jobs do not run on the preview, but the live ones will see your test doctors.**
The 41 scheduled jobs only run on the live site. They run the live code, which knows nothing about Australian doctors, against the shared database. So a test Australian doctor created on the preview can be picked up by the live hourly jobs and sent the normal overseas-doctor reminders ("finish your onboarding", "upload your CV", and so on) by email and WhatsApp. Use only email addresses and phone numbers you own for test doctors.

**5. Running the app on this Mac also talks to the live database.**
Starting the app from the main project folder silently loads its `.env` file, which points at the live database with full access. It cannot send email or WhatsApp from there (those keys are blank locally). Starting it from a fresh worktree folder (no `.env`) uses a small throwaway local file instead, but most of the registration, task and placement features do not work in that mode.

**6. There is already a safety switch for messages. It is not turned on anywhere.**
The app has a setting, `NOTIFY_TEST_RECIPIENTS`, that limits all Resend email and all WhatsApp sends to a list of agreed addresses and numbers. Setting it for the Vercel "Preview" environment is the cheapest way to make the preview safe. It does not cover email sent through Gmail, Google Calendar invitations, or Calendly's own emails (details in section 7).

**7. Are Australian leads being contacted today?**
Rung by Hazel: no. Lead calls are on in production, but there is no Australian outbound number, so Australian and New Zealand leads are skipped. Messaged: yes. Consult WhatsApp messages are on by default and Australia is a served country. The two Australian leads in the last 30 days each received a WhatsApp.

**8. Database changes can be applied from this Mac.**
There is a working route to run SQL on the live database (a stored function called through the service key). It was used here for a read-only look at the live rules. The live rules currently reject any new stage or task type, so the Australian build needs a migration before it can save new values, and that migration changes the live database for everyone.

### Things to decide before testing

| Decision | Why it matters |
|---|---|
| Set `NOTIFY_TEST_RECIPIENTS` on the Vercel Preview environment (and locally) | Otherwise the preview can email or WhatsApp any real doctor or practice |
| Agree the test identities (emails and phones you own) | Live scheduled jobs will message test doctors as if they were overseas doctors |
| Decide whether the preview should keep sharing the live database | A separate Supabase project for Preview is the only full isolation; none exists today |
| Decide when the constraint migration runs | It alters live tables; the live code must tolerate the new values first |

---

## 1. Vercel environment variables

Source: `GET /v9/projects/{project}/env` (89 entries) and `GET /v1/projects/{project}/env/{id}` per entry. Entries of type `sensitive` cannot be read back, so their values could not be fingerprinted. There are no team-level shared variables (`GET /v1/env` returned an empty list) and no custom environments.

One entry serving several targets means those targets get the identical value. That is the basis for "same as production" below.

### Services asked about

| Service | Variable(s) | Targets | Preview same as production? |
|---|---|---|---|
| Supabase URL | `SUPABASE_URL` | production + preview + development (one entry) | Yes. Value is the custom domain `login.mygplink.com.au`, which is a DNS alias of the production project `rqrqcfxalkvzwbedvsjs` |
| Supabase keys | `SUPABASE_SERVICE_ROLE_KEY` (sensitive), `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ANON_KEY` | production + preview (one entry each) | Yes |
| Resend | `RESEND_API_KEY` (sensitive), `RESEND_WEBHOOK_SECRET` (sensitive), `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME` | production + preview | Yes |
| DoubleTick | `DOUBLETICK_API_KEY`, `DOUBLETICK_BASE_URL`, `DOUBLETICK_WEBHOOK_SECRET` | all three targets | Yes |
| Retell (Hazel) | `RETELL_API_KEY` (sensitive), `RETELL_AGENT_ID`, `RETELL_FROM_NUMBER_UK` | production only | Not present on preview |
| Lead-call settings | `LEAD_CALLS_ENABLED`, `LEAD_CALLS_PER_RUN`, `LEAD_CALLS_MAX_LEAD_AGE_DAYS`, `LEAD_CALLS_AGENT_NAME`, `LEAD_CALLS_DIRECTOR_NAME` | production only | Not present on preview |
| Twilio | `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FORWARD_TO` | production only | Not present on preview |
| Calendly | `CALENDLY_API_TOKEN` (sensitive), `CALENDLY_WEBHOOK_SECRET` (sensitive), `CALENDLY_EVENT_TYPE_URI`, `CALENDLY_EVENT_URL`, `CONSULT_CALENDLY_EVENT_TYPE_URI` | production + preview | Yes |
| Zoom | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET` (all sensitive) | production only | Not present on preview |
| Google service account | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `GOOGLE_PUBSUB_TOPIC` | all three targets | Yes |
| Google Calendar / Drive extras | `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_IMPERSONATE_EMAIL`, `GOOGLE_DRIVE_IMPERSONATE_EMAIL` (sensitive), `GOOGLE_DRIVE_BACKUP_FOLDER_ID_1/2` (sensitive) | production + preview | Yes |
| Anthropic | `ANTHROPIC_API_KEY` | all three targets | Yes |
| OpenAI | none | not set anywhere | The code reads `OPENAI_API_KEY` (line 450) but it does not exist in Vercel |
| Meta lead webhook | `FB_LEAD_VERIFY_TOKEN`, `FB_LEAD_WEBHOOK_SECRET`, `FB_LEADS_PAGE_TOKEN`, `FB_PAGE_ACCESS_TOKEN`, `FB_SOCIAL_PAGE_TOKEN` (all sensitive), `FB_PAGE_ID`, `FB_GP_LEAD_FORM_IDS`, `IG_USER_ID` | production + preview | Yes |
| Meta ads | `META_ADS_ACCESS_TOKEN` (sensitive) | production + preview | Yes |
| Meta CAPI | `META_CAPI_ACCESS_TOKEN`, `META_CAPI_DATASET_ID` | production only | Not present on preview |
| Xero | none | not set anywhere | No Xero variable exists and the code has no Xero call |
| `AUTH_SECRET` | one entry | all three targets | Yes. A session token signed on the preview is valid on production and the reverse |
| `CRON_SECRET` | two separate entries | one for production, one (sensitive) for preview | Different entries. Could not confirm whether the values differ, because the preview one is unreadable |
| `AU_PATHWAY_ENABLED` | none | not set anywhere | Confirmed absent from Vercel and from every local env file |

### Other entries worth knowing

| Variable | Targets | Note |
|---|---|---|
| `NODE_ENV` | all three targets, value `production` | The preview reports itself as production. `NODE_ENV` cannot tell preview from live |
| `ADMIN_ALLOWED_HOSTS` | all three | Three hosts: `admin.mygplink.com.au`, the `git-main` alias, and one old deployment address. The `au-gp-testing` alias is not in it |
| `SUPER_ADMIN_ALLOWED_HOSTS` | all three | `ceo.admin.mygplink.com.au` only |
| `COOKIE_SECURE` | all three | `true` |
| `AUTH_DISABLED` | all three | `false` |
| `REQUIRE_SUPABASE_DB` | all three | See side finding below |
| `ADMIN_EMAILS` (sensitive) | production only | Missing on preview. Staff resolved by this list alone have no role on preview |
| `SUPER_ADMIN_EMAILS` | all three | Same on preview |
| `REGISTRATION_HUB_EMAIL`, `CONSULT_OWNER_ALERT_PHONE`, `ONBOARDING_FOLLOWUP_SECRET` | production only | Not present on preview |
| `GITHUB_TOKEN`, `HIGGSFIELD_API_KEY`, `SOCIAL_INGEST_TOKEN`, `MASTER_ARCHIVE_EMAIL` (all sensitive) | production + preview | Same on preview |
| `ZOHO_SIGN_*` (6 entries) | preview + production | `server.js` no longer references any `ZOHO_SIGN` variable. Leftovers |
| `NOTIFY_TEST_RECIPIENTS` | none | The message safety switch is not set anywhere |
| `APP_BASE_URL`, `PUBLIC_BASE_URL` | none | Code falls back to `https://app.mygplink.com.au` (line 24) on every deployment, preview included |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | none | Web push is off everywhere (line 43113) |

### Side finding (not part of the brief, not changed)

`REQUIRE_SUPABASE_DB` in Vercel is five characters long and its fingerprint matches the text `true` followed by a line break, not plain `true`. The code tests for an exact match (lines 50 to 52), so this setting appears to evaluate to **false** on production and preview. The effect is that the "never fall back to the local JSON file" protection is not active on Vercel. I could not observe the running value directly; this is inferred from the fingerprint and the code.

---

## 2. Preview deployment of the branch

Source: `GET /v6/deployments?projectId=…&branch=au-gp-testing`, `GET /v13/deployments/{id}`, `GET /v9/projects/{id}`, plus anonymous GET requests to the address.

| Item | Finding |
|---|---|
| Deployment exists | Yes, `dpl_4UqieShLBUX4tc5ayqFeHhKkDni9` |
| State | `READY`, target preview, commit `bf5f8ce7`, created 2026-11-20 05:43 UTC |
| Per-deployment address | `gplink-repository-6f2x8jlbz-gplinkrecruitments-projects.vercel.app` (frozen to this one build) |
| Stable branch address | `gplink-repository-git-au-gp-testing-gplinkrecruitments-projects.vercel.app` (always the newest build of the branch) |
| Vercel Deployment Protection | Off. The project has `ssoProtection: null`, no password protection and no trusted-IP list |
| Confirmed in practice | An anonymous request to `/api/health` returned 200 with `branch: au-gp-testing`, the right commit, and `environment: production` (that last value is `NODE_ENV`) |
| Search engines | Every response carries `X-Robots-Tag: noindex, nofollow` |

The owner does not need a Vercel login. Anyone holding the link can reach the sign-in pages.

---

## 3. Signing in on the preview address and on localhost

### The checks that exist

| Check | Where | What it does |
|---|---|---|
| Session cookies | `setSession` 18837, `setAdminSession` 18857 | `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` when `COOKIE_SECURE=true`. **No `Domain` attribute**, so each cookie belongs to the exact host that set it. Nothing ties cookies to `mygplink.com.au` |
| Same-origin rule for writes | `enforceMutationOrigin` 16805, `isTrustedSameOriginRequest` 16788 | For POST/PUT/PATCH/DELETE, the `Origin` (or `Referer`) host must equal the request host. It is a self-comparison, not an allow-list, so any host passes when you browse it normally. On by default when `NODE_ENV=production` (line 47) |
| Admin host scope | `getAdminHostScope` 16854 | Returns `super_admin` for `SUPER_ADMIN_ALLOWED_HOSTS` and for the deployment's own Vercel addresses on any non-production Vercel deployment (`PREVIEW_SUPER_ADMIN_HOSTS`, lines 65 to 76, built from `VERCEL_URL` and `VERCEL_BRANCH_URL`); `admin` for `ADMIN_ALLOWED_HOSTS`; `local` for `localhost`/`127.0.0.1` only when `NODE_ENV` is not production; otherwise blank |
| Role must match host | `doesAdminRoleMatchHost` 16900 | `super_admin` host admits only `super_admin` and `consultant`. `admin` host admits everyone except `consultant`. `local` admits any admin role |
| Admin pages on a non-admin host | 91535 | `admin.html`, `admin-signin.html`, `admin-visa.html`, `admin-pbs.html` return 404 when the host scope is blank |
| CEO dashboard | 91541 and 91672 | Served only when host scope is exactly `super_admin` |
| Admin APIs | `resolveAdminRequestContext` 20149 | 404 on a blank scope, 401 with no admin cookie, 403 on a role/host mismatch |
| Admin login | `/api/admin/auth/login` 70349, MFA step 70494 | Password checked against Supabase Auth, then role and host checked (70405 to 70420) |

There is no `ALLOWED_ORIGINS` variable and no CSRF token. `APP_BASE_URL` is used to build links, not to gate requests.

### On the preview address (`…git-au-gp-testing….vercel.app`)

Confirmed by anonymous request: `/api/admin/auth/session` answered `hostScope: super_admin`, so the preview alias is treated as the CEO host.

| Surface | Works? | Detail |
|---|---|---|
| (a) GP sign-up and sign-in | Yes | Email and password go through the server to Supabase Auth; the cookie is host-only. The bare `/` redirects to `/pages/admin` (line 91347, because this host is an admin host), so open `/pages/signin` directly. New accounts are confirmed at creation, so no email click is needed to get in |
| (a) Google / Apple sign-in | Not verified | The page asks Supabase to return to `window.location.origin + /pages/signin` (`pages/signin.html` 1541). Supabase only honours that if the preview address is on its Redirect URL allow-list, which could not be read from here. If it is not listed, the doctor is returned to the live site instead |
| (a) Password reset and verification emails | Work, but leave the preview | Links are built from `APP_BASE_URL` (lines 42628, 69893), which is the live app |
| (b) Admin (RSO) dashboard `pages/admin.html` | Yes, for a super-admin account only | A `staff` or `admin` role is refused with "This host is reserved for super admin access" (70411). The RSO experience cannot be tested as an RSO on a preview address |
| (c) CEO dashboard | Yes, for a super-admin (or consultant) account | Use the clean address `/pages/ceo-dashboard` |

### On `localhost:3000`

| Situation | GP sign-in | Admin dashboard | CEO dashboard |
|---|---|---|---|
| Started from the main folder (its `.env` loads, `NODE_ENV=production`) | Works against the live database | 404. The `local` scope needs a non-production `NODE_ENV` (16860) | 404 |
| Same, with `NODE_ENV=development` exported first | Works | Works under the `local` scope, any admin role | 404 unless `SUPER_ADMIN_ALLOWED_HOSTS=localhost` is also exported (91541 needs exactly `super_admin`) |
| Started from a worktree with no `.env` | Local throwaway accounts only | Host allowed, but admin login needs Supabase Auth (70378), which is not configured in this mode | 404 without `SUPER_ADMIN_ALLOWED_HOSTS=localhost` |

`.env` sets `COOKIE_SECURE=true`. Chrome accepts `Secure` cookies on `http://localhost`; Safari does not. None of the localhost rows were exercised by running the server in this audit; they are read from the code.

---

## 4. Scheduled jobs

### Do they run on previews?

No.

- `vercel.json` declares 41 crons. Vercel invokes crons only against the production deployment. The project record confirms it: `crons.deploymentId` is the current production deployment (`dpl_DwSEpM4Z…`, branch `main`, commit `2d35b94a`) with 41 definitions. The Vercel documentation was not re-fetched during this audit; the statement rests on the project record and on known platform behaviour.
- Every `/api/cron/*` handler requires `Authorization: Bearer <CRON_SECRET>` (for example line 53202 for lead calls, `isValidCronSecret` at 177 for others). An anonymous request to `/api/cron/lead-calls` on the preview returned 401.

So testing on the preview cannot start a cron run by itself. Two caveats:

1. Admin dashboard buttons that do the same work as a cron (for example "Pull recent emails now") run on the preview, with preview code, against the live database.
2. Outside services send their webhooks to the live addresses. A Calendly booking, a WhatsApp reply, a Resend bounce or a Facebook lead caused by preview testing is handled by **production code**, where the Australian switch is off.

### Can production crons pick up Australian test doctors?

Yes. This is the main risk of sharing the database. Production runs `main`, which treats every doctor as an overseas doctor.

| Production cron | Schedule | What it would do to a test Australian doctor |
|---|---|---|
| `onboarding-nudge` (52127) | hourly | Any active, non-staff profile with unfinished onboarding gets the "finish onboarding" email and WhatsApp sequence. There is no test-account exclusion in `enumerateIncompleteOnboardingGps` (16437) |
| `dropoff-nudge` (52294) | hourly | Finished onboarding, no application or CV: career nudges by email and WhatsApp. Skips staff and the small hard-coded test list (`isBypassLockEmail`, 52312) |
| `chase-nonresponders` (53734) | daily | Chases doctors silent for 14 days and creates RSO chase tasks |
| `stalled-applications`, `sla-sweep`, `weekly-sweep`, `reconcile-followups`, `reconcile-doc-tasks` | daily / hourly | Create tasks and alerts for staff on the test doctor's case using overseas rules |
| `call-reminders`, `detect-no-shows`, `interview-reminders` | every 5 to 60 min | Act on any `scheduled_calls` row, including ones created from the preview: reminders, no-show handling |
| `match-lifecycle` (53237) | hourly | Reminder, final-call and expiry emails on shortlisted applications |
| `doc-ai-review` | every 10 min | Reviews uploaded documents against overseas requirements, spends AI budget |
| `register-auto-verify`, `organize-drive`, `recompute-intent`, `refresh-summaries` | various | Register lookups by country, Drive folder creation, intent scoring, AI summaries for the test doctor |
| `consult-nudge`, `lead-calls` | every 5 min | Act on consult leads (`site_enquiries`), not on app accounts. A test lead with an Australian number is not rung (no AU number) but can be messaged |

Concretely: the owner creates a test Australian GP on the preview at 10:00 and stops halfway through onboarding. At 11:00 the production `onboarding-nudge` job sees an incomplete profile and, on later passes, sends the standard overseas "pick up where you left off" email and WhatsApp to that address and number, with a link to the live app where the Australian pathway does not exist.

There is a second, quieter risk. Production code will read rows carrying values it has never seen (a new stage, a new task type). Section 9 shows the database rejects those values today, so the first effect is that the preview cannot save them at all. Once a migration widens the rules, production code starts encountering them.

### Ways to contain it

- Use only owner-controlled emails and phone numbers for test doctors, so anything production sends lands with the owner.
- Get a small guard into `main` first so production jobs skip Australian-pathway doctors while the switch is off.
- Or give the Preview environment its own Supabase project by adding Preview-only values for the Supabase variables. This is the only complete isolation. No such project is configured today.

---

## 5. Local development

### How env files are loaded

`server.js` has no env loader of its own, but line 17 requires `scripts/agents.js`, which loads **`<project folder>/.env`** as a side effect (`scripts/agents.js` 85 to 102) before any setting is read.

- Only `.env` is ever loaded. `.env.prod`, `.env.vercel`, `.env.vercel-prod` and `.vercel/.env.preview.local` are never read by the app. They are old downloads.
- A value already present in the shell wins. An empty value does not count as present, so a key cannot be blanked by exporting it empty. Blank lines in `.env` are skipped.
- `AGENT_SKIP_DOTENV=true` turns the loading off.
- Worktrees have no `.env` (only `.env.example`), so a server started from a worktree gets nothing.

### What `npm start` connects to

| Started from | Database | Sign-in | Notes |
|---|---|---|---|
| Main folder (`.env` loaded) | **Production Supabase**, with the service-role key (the key's project reference matches `rqrqcfxalkvzwbedvsjs`) | Supabase Auth, live accounts | `NODE_ENV=production`, `REQUIRE_SUPABASE_DB=true`, so the JSON file is not used. `AUTH_SECRET` is a different, local-only value |
| A worktree (no `.env`) | `data/app-db.json` in that folder | Local accounts in the JSON file | `NODE_ENV` defaults to `development` |
| With `.env.prod`, `.env.vercel`, `.env.vercel-prod` | Not applicable | | Never loaded by `npm start`. If loaded by hand they point at the same production Supabase URL but their service-role key is blank, and `NODE_ENV=production` with `REQUIRE_SUPABASE_DB` set makes the server refuse to start without that key (9576) |

### Is the JSON file a real separate dev database?

Only partly. It is separate and harmless, but thin.

- It holds: users, profiles, user state, sessions, ATS practices/jobs/applications/candidates, consult leads, scheduled calls, a fake calendar, and a few small stores (line 11290 onward). `scripts/seed-ats-dev.js` fills the ATS parts.
- It has **no store at all** for registration cases, registration tasks, visa cases or PBS applications. Those go straight to Supabase: 235 calls for `registration_cases`, 327 for `registration_tasks`, 12 for `pbs_applications`. With no Supabase configured, each returns "not configured" (28144) and the feature shows nothing.
- `placements` and `career_roles` have small local stand-ins but most of their code paths also call Supabase directly.

Anything built on cases, tasks and stages cannot be tested in JSON mode.

### Which sending keys are blank locally (main folder `.env`)

| Service | In `.env`? | Effect |
|---|---|---|
| Resend | No | No email can be sent (`isEmailConfigured` 41930) |
| DoubleTick | No | No WhatsApp can be sent |
| Twilio | No | SMS webhook disabled |
| Zoom | No | No meetings created |
| Calendly | No | No Calendly API calls |
| Google service-account private key | Blank | Gmail, Drive and Calendar are off |
| `CRON_SECRET` | Blank | Cron endpoints refuse every call |
| Retell | **Key and agent id are present** | No outbound number and `LEAD_CALLS_ENABLED` is not set, so the dialler stays idle and a manual test call stops at "no outbound number" (35313) |
| Anthropic | **Present, same key as production** | Local AI calls spend the live budget |
| Supabase service-role key | **Present** | Full read and write on the live database |

### Local or staging Supabase

- `supabase/config.toml` and `supabase/seed.sql` exist, with 127 migration files, so `supabase start` is set up in principle.
- Docker, the Supabase CLI, `psql`, `pg_dump` and the Vercel CLI are **not installed** on this Mac. No Docker-type app is in `/Applications`. Node is available only at `~/gplink-tools/node-v22`.
- No staging Supabase project is referenced in any env file or in Vercel. Whether one exists inside the Supabase account could not be checked (no Supabase account token on this machine).
- Whether the 127 migrations rebuild a working database from empty was not tested. The live database has drifted from the migration files in places.

---

## 6. Detecting "preview or local" in code

### Existing patterns

| Pattern | Where | Reliable for this purpose? |
|---|---|---|
| `NODE_ENV === 'production'` | lines 23, 47 to 52, 16798, 16860, 18843, and many more | **No.** Vercel sets `NODE_ENV=production` on previews, and the local `.env` sets it too |
| `process.env.VERCEL_ENV !== 'production'` | line 71 (preview super-admin hosts) | **Yes.** This is the only existing check that separates preview from live. System variables are exposed (`autoExposeSystemEnvs: true`) |
| `process.env.VERCEL` | 121, 539, 91751 | Tells Vercel from a laptop, not preview from live |
| `VERCEL_GIT_COMMIT_REF`, `VERCEL_GIT_COMMIT_SHA` | 49695, 54035 | Reporting only |

There is no `IS_PROD` constant.

### Recommended expression

An uncommitted file `lib/au-pathway-flag.js` already in this worktree implements exactly the right rule, and I recommend keeping it as written:

```js
function isAuPathwayEnabled(env) {
  const e = env || process.env;
  const raw = String(e.AU_PATHWAY_ENABLED == null ? '' : e.AU_PATHWAY_ENABLED).trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  const vercelEnv = String(e.VERCEL_ENV || '').trim().toLowerCase();
  if (vercelEnv) return vercelEnv !== 'production';
  return String(e.NODE_ENV || '').trim().toLowerCase() !== 'production';
}
```

Explicit `false` always wins, explicit `true` always wins, an unreadable value falls through, and production stays off unless told otherwise. The `.trim()` matters: section 1 shows a Vercel value in this project with a stray line break.

Three things to be aware of:

1. **Started from the main folder, the switch is OFF.** The `.env` there sets `NODE_ENV=production` and there is no `VERCEL_ENV`. Add `AU_PATHWAY_ENABLED=true` to that `.env` or export it. Started from a worktree with no `.env`, it is ON.
2. **Production webhooks and crons run `main`.** The switch being ON for the preview does not make production code aware of Australian doctors (section 4).
3. **Pages in the browser cannot read env variables.** Any page that branches on the switch needs the server to hand the answer over.

---

## 7. Outbound send choke points

| Channel | Central function | Guarded by the allow-list? |
|---|---|---|
| Email via Resend | `sendEmail` (42155); the single network call is at 42281. Every `send…Email` helper ends here | Yes |
| WhatsApp via DoubleTick | Template sends: `sendDoubleTickTemplate` (24398), `sendConsultWhatsAppTemplate` (24637), `sendDoubleTickTemplateTo` (45282), `sendMatchWhatsAppToGp` (44954). Text sends: `sendDoubleTickNudge` (24566), `sendDoubleTickZoomCallInvite` (24550), plus sites at 30588, 54526, 65560, 92066. All 13 message-sending calls go through `guardedNotifyFetch` | Yes |
| DoubleTick non-message calls | Chat embed link (24173), team-member assign (24262), customer tags (24610), reads (34060, 76244, 85828) | No. These do not message anyone, but assign and tag write to the live DoubleTick account |
| Email via Gmail API (sent as the team mailboxes) | `sendGmailEmail` (4018), network call at 4151, 11 call sites (registration hub replies, practice replies, chase reminders, SMS forwards) | **No** |
| Calls via Retell | `placeLeadCall` (34337), reached from `runLeadCallsPass` (34243) and the manual test-call endpoints (35293, 59575) | Not by the allow-list. Has its own pin: `LEAD_CALLS_TEST_NUMBERS` (`lib/lead-calls.js` 146) restricts dialling to listed numbers |
| SMS via Twilio | Inbound webhook only (34537 onward). It replies to the sender and forwards the text to the team by Gmail. No outbound SMS campaign | Not applicable |
| Zoom meetings | `createZoomMeeting` (41630), `createZoomInterviewMeeting` (41823), token at 41509 | No |
| Google Calendar events | `gcalCreateEvent` (41749), built in `lib/google-calendar.js` 50 with `sendUpdates=all`, so **Google emails every attendee**. Interview events add the doctor and the practice as attendees (92331) | **No** |
| Calendly | `calendlyApiFetch` (34710) creates links and reads events. Calendly itself emails the invitee when a booking is made | No |
| Web push | `sendPushNotification` (43107) | No, but no VAPID keys exist, so it is off |
| Meta conversions (CAPI) | `lib/meta-capi.js` | Production-only keys |

### Existing test mechanisms

| Mechanism | Where | What it does | Set today? |
|---|---|---|---|
| `NOTIFY_TEST_RECIPIENTS` | `lib/notify-allowlist.js`, wired at 535 to 553 | Comma-separated emails and phone numbers. When set, Resend and DoubleTick sends reach only those recipients; `to`, `cc` and `bcc` are filtered; everything else is skipped and logged with the address masked. Fails closed on an unreadable request. When unset, there is no restriction | No, nowhere |
| `LEAD_CALLS_TEST_NUMBERS` | `lib/lead-calls.js` 146 | Only these numbers are ever dialled | No |
| `isBypassLockEmail` / `BYPASS_LOCK_EMAILS` | 19409 to 19430 | A short list of test accounts. Also unlocks every journey gate for them. Only two crons respect it as a "do not nudge" list (52273, 52312) | Hard-coded list only |
| `TEST_WATCH_FROM_SENDERS`, `AHPRA_TEST_OFFICER_SENDERS` | 3914 to 3956 | Limit which **inbound** senders the Gmail watcher acts on. Not an outbound control | Set on preview and production |
| `dry_run` options | Zoho re-engage and Zoho WhatsApp tools (33975, 35585, 52824) | Count without sending, for those two tools only | Per call |

There is no general `EMAIL_DRY_RUN` and no general test-account detection.

### Cheapest safe setup

1. **Add `NOTIFY_TEST_RECIPIENTS` to the Vercel Preview environment** with the agreed test emails and phones, then redeploy the branch. One variable, no code change, covers all Resend and all WhatsApp sends. Add the same line to the local `.env`.
2. **Close the gaps the allow-list does not cover** on preview and local. The smallest code change is to make three functions respect the same list or refuse to run outside production: `sendGmailEmail` (4018), `gcalCreateEvent` (41749) and the Calendly link creation. Alternatively remove the Google service-account key and Calendly token from the Preview target, at the cost of Drive, Gmail and booking features not working there.
3. **Make it fail closed.** Today an unset list means "send to anyone". For the new work, treat "not production and list unset" as "block everything", in the one place the list is built (535).
4. **Retell, Zoom, Twilio and Meta CAPI need nothing.** Their keys are not on the Preview target. Keep it that way.
5. None of this stops **production** jobs messaging a test doctor (section 4). That needs owner-controlled test identities, a guard in `main`, or a separate Preview database.

---

## 8. Production switches

| Switch | Production | Preview | Meaning |
|---|---|---|---|
| `LEAD_CALLS_ENABLED` | Set, `true` | Not set | Hazel's dialler is on in production |
| `RETELL_FROM_NUMBER_UK` | Set | Not set | UK and Ireland leads can be rung |
| `RETELL_FROM_NUMBER_AU` | **Not set** | Not set | Australia and New Zealand leads are skipped with reason `no_from_number` (`lib/lead-calls.js` 372 to 373) |
| `LEAD_CALLS_TEST_NUMBERS` | Not set | Not set | No dialling pin; all eligible leads are in scope |
| `CONSULT_WHATSAPP_ENABLED` | **Not set** | Not set | Defaults to ON in code (line 426: on unless the value is exactly `false`) |
| `FB_GP_LEAD_FORM_IDS` | Set, 9 form ids | Same entry | Facebook GP lead forms are being ingested |

**Are Australian leads being rung or messaged today?**

- Rung: no. There is no Australian outbound number.
- Messaged: yes. Australia has been a served consult country since August (`lib/consult-lead.js` 18), and consult WhatsApp is on by default.

A read-only count of the live consult leads (no names, emails or phones selected) supports this:

| Country | Leads | Last 30 days | With an AI call on record |
|---|---|---|---|
| UK | 879 | 55 | 790 |
| Australia | 2 | 2 | 0 |
| New Zealand | 2 | 1 | 0 |
| Ireland | 1 | 0 | 0 |
| Other / not served | 8 | 1 | 0 |

Both Australian leads have a WhatsApp send recorded and are marked stopped because they signed up. Neither has a call.

---

## 9. Database access for migrations

### How migrations have been applied

- The documented route in `PRODUCTION_SETUP.md` section 10 is `supabase link` then `supabase db push`. The Supabase CLI is not installed here, so that route is not usable from this Mac.
- The route actually in use is a database function, `public.exec_sql(query text)`, created in June and callable only by the service role: `POST {SUPABASE_URL}/rest/v1/rpc/exec_sql` with the service-role key from the main folder's `.env`. It runs arbitrary SQL, including table changes.
- It returns nothing, so results are read back either through the normal REST API or by raising the value as an error message. Object names must be written with the `public.` prefix because the function runs with an empty search path.

**So yes: a credential on this machine can run any SQL against production.** It is the service-role key in `.env`. There is no direct Postgres connection string and no `psql`.

In this audit it was used once, for a read-only block that reads `pg_constraint` and raises the text. It writes nothing. Column lists came from the REST API's schema document at `/rest/v1/` (85 tables exposed).

### Live CHECK constraints (exact allowed values)

**`registration_cases.stage`** (`registration_cases_stage_check`)
`myintealth`, `amc`, `career`, `ahpra`, `visa`, `pbs`, `commencement`, `complete`
Not null, default `myintealth`. Note there is no `placement` value.

**`registration_tasks.task_type`** (`registration_tasks_task_type_check`), 30 values
`kickoff`, `verify`, `review`, `followup`, `blocker`, `escalation`, `practice_pack`, `practice_pack_child`, `manual`, `system`, `visa_stage`, `visa_doc`, `questionnaire`, `sponsor`, `migration_agent`, `sla_overdue`, `chase`, `document_ops`, `whatsapp_help`, `email_triage`, `ahpra_action_item`, `ahpra_correspondence`, `flagged_doc`, `doc_review`, `zoom_call`, `alt_supervisor_cv_review`, `alt_supervisor_cv_request`, `account_deleted_active_placement`, `model_update_available`, `ahpra_conflict_letter`

**`scheduled_calls.stage`** (`scheduled_calls_stage_check`)
NULL, or one of `myintealth`, `amc`, `ahpra`

Other CHECK constraints on the same tables:

| Table.column | Allowed values |
|---|---|
| `registration_cases.status` | `active`, `on_hold`, `blocked`, `complete`, `withdrawn` |
| `registration_cases.blocker_status` | NULL, `waiting_on_gp`, `waiting_on_practice`, `waiting_on_external`, `internal_review` |
| `registration_cases.intent_band` | `hot`, `warm`, `cold` |
| `registration_tasks.status` | `open`, `in_progress`, `waiting`, `completed`, `cancelled`, `waiting_on_gp`, `waiting_on_practice`, `waiting_on_external`, `blocked`, `escalated`, `deferred` |
| `registration_tasks.priority` | `urgent`, `high`, `normal`, `low` |
| `scheduled_calls.status` | `invited`, `booked`, `completed`, `cancelled`, `no_show` |
| `scheduled_calls.meeting_kind` | `consultation`, `interview` |
| `scheduled_calls.call_disposition` | NULL, `resolved`, `needs_followup`, `escalate`, `no_answer`, `rescheduled` |
| `scheduled_calls.summary_status` | `not_requested`, `pending`, `saved`, `not_available`, `error` |
| `placements.status` | `active`, `ended`, `cancelled` |
| `pbs_applications.application_type` | `medicare_provider`, `pbs_prescriber` |
| `pbs_applications.status` | `not_started`, `in_progress`, `submitted`, `approved`, `rejected`, `waiting_on_gp`, `under_review`, `complete`, `blocked` |
| `career_roles.job_status` | `open`, `filled`, `closed` |
| `career_roles.approval_status` | `pending`, `approved`, `rejected` |
| `gp_applications.ats_stage` | `shortlisted`, `applied`, `submitted`, `reviewing`, `interview`, `offer`, `hired`, `not_proceeding` |
| `gp_applications.origin` | `gp_applied`, `admin_applied`, `ai_matched` |
| `gp_applications.practice_submission_status` | `pending_va_submission`, `submitted_to_practice`, `client_reviewed`, `client_approved`, `client_accepted`, `client_rejected`, `client_interview_requested`, `interview_ready` |

`user_profiles` has no CHECK constraints. Only CHECK constraints were read; foreign keys, unique rules and triggers were not.

### Live columns (name : type; `*` means NOT NULL)

**`user_profiles` (40)**
`user_id`* uuid · `email`* text · `first_name`* text · `last_name`* text · `country_dial`* text · `phone_number`* text · `registration_country`* text · `phone`* text · `registration_number`* text · `gmc_number`* text · `profile_photo_name`* text · `profile_photo_data_url`* text · `id_copy_name`* text · `id_copy_data_url`* text · `cv_file_name`* text · `created_at`* timestamptz · `updated_at`* timestamptz · `qualification_country`* text · `preferred_city`* text · `target_arrival_date`* text · `who_moving`* text · `children_count`* text · `onboarding_completed_at` timestamptz · `zoho_candidate_id` text · `doubletick_customer_id` text · `account_status`* text (default `active`) · `archived_at` timestamptz · `purge_after` timestamptz · `archived_reason` text · `lead_source` text · `lead_source_detail` text · `name_change_detected`* boolean · `name_change_note` text · `register_body` text · `register_number` text · `register_name` text · `register_status` text · `register_verified_at` timestamptz · `register_verified_by` text · `register_auto_checked_at` timestamptz

There is no pathway or doctor-type column. All the text columns marked `*` default to an empty string.

**`registration_cases` (47)**
`id`* uuid · `user_id`* uuid · `assigned_va` uuid · `stage`* text · `substage` text · `status`* text · `blocker_status` text · `blocker_reason` text · `next_followup_date` date · `last_gp_activity_at` timestamptz · `last_va_action_at` timestamptz · `practice_name` text · `practice_contact` text · `handover_notes` text · `gp_verified_stage` text · `created_at`* timestamptz · `updated_at`* timestamptz · `google_drive_folder_id` text · `completed_at` timestamptz · `ahpra_application_number` text · `ahpra_officer_name` text · `ahpra_officer_email` text · `ai_handover_summary` jsonb · `gmail_label_id` text · `gmail_label_hello_id` text · `gmail_label_name` text · `assigned_rso` uuid · `blocker_set_at` timestamptz · `intent_score` integer · `intent_band` text · `intent_signals` jsonb · `intent_computed_at` timestamptz · `comms_engagement` jsonb · `comms_engagement_at` timestamptz · `ahpra_registration_number` text · `ahpra_registration_type` text · `ahpra_registration_effective_date` date · `ahpra_registration_expiry_date` date · `ahpra_registration_granted_at` timestamptz · `ahpra_registration_has_conditions` boolean · `ahpra_registration_conditions` jsonb · `ahpra_registration_source_gmail_message_id` text · `visa_case_id` uuid · `migration_agent` text · `migration_agent_contact` text · `sponsor_name` text · `sponsor_contact` text

There is no `metadata` column on this table.

**`placements` (19)**
`id`* uuid · `user_id` uuid · `application_id` uuid · `career_role_id` bigint · `practice_id` uuid · `practice_name` text · `job_title` text · `location` text · `billing_split` text · `sessions_per_week` text · `compensation_range` text · `start_date` date · `contract_document_key` text · `offer_id` uuid · `placed_by` text · `placed_at` timestamptz · `status`* text · `created_at`* timestamptz · `updated_at`* timestamptz

**`career_roles` (41)**
`id`* bigint · `provider`* text (default `zoho_recruit`) · `provider_role_id`* text · `title`* text · `practice_name`* text · `location_city`* text · `location_state`* text · `location_country`* text (default `Australia`) · `location_label`* text · `billing_model`* text · `dpa`* boolean · `mmm`* text · `earnings_text`* text · `summary`* text · `employment_type`* text · `practice_type`* text · `support_summary`* text · `tags`* text[] · `visa_pathway_aligned`* boolean · `family_friendly`* boolean · `private_billing`* boolean · `mixed_billing`* boolean · `metro`* boolean · `regional`* boolean · `is_active`* boolean · `source_payload`* jsonb · `published_at` timestamptz · `synced_at`* timestamptz · `created_at`* timestamptz · `updated_at`* timestamptz · `practice_id` uuid · `job_status`* text · `posted_by`* text · `ats_created`* boolean · `masked_title`* text · `header_image_url`* text · `nearest_city`* text · `suburb`* text · `approval_status`* text · `address`* text · `details`* jsonb

**`pbs_applications` (20)**
`id`* uuid · `user_id`* uuid · `application_type`* text · `status`* text · `reference_number` text · `application_date` timestamptz · `approval_date` timestamptz · `documents` jsonb · `notes` jsonb · `created_at`* timestamptz · `updated_at`* timestamptz · `provider_number` text · `prescriber_number` text · `current_action_title` text · `current_action_description` text · `current_action_owner` text · `current_action_due_date` date · `practice_name` text · `practice_contact` text · `status_message` text

**`registration_tasks` (46)**
`id`* uuid · `case_id` uuid · `parent_task_id` uuid · `task_type`* text · `title`* text · `description` text · `assignee` uuid · `priority`* text · `status`* text · `blocker_reason` text · `due_date` date · `source_trigger` text · `related_stage` text · `related_substage` text · `related_document_key` text · `related_ticket_id` text · `completed_at` timestamptz · `completed_by` text · `created_at`* timestamptz · `updated_at`* timestamptz · `doubletick_conversation_url` text · `doubletick_message_id` text · `attachment_url` text · `attachment_filename` text · `zoho_attachment_id` text · `google_drive_file_id` text · `document_html` text · `gmail_message_id` text · `gmail_attachment_id` text · `ai_match_confidence` real · `ai_match_reasoning` text · `zoho_sign_envelope_id` text · `follow_up_source_timeline_id` uuid · `email_body_snippet` text · `email_sender` text · `gmail_thread_id` text · `escalated_to` text · `escalated_reason` text · `escalated_at` timestamptz · `source_gmail_message_id` text · `ahpra_deadline` date · `metadata` jsonb · `escalated_by` text · `blocker_set_at` timestamptz · `domain` text · `visa_case_id` uuid

`related_stage` and `related_substage` carry no CHECK constraint, so they accept any text.

---

## Could not verify

| Item | Why |
|---|---|
| Whether preview and production share the values of the unreadable (`sensitive`) variables | They cannot be read back. Where one entry serves both targets the value is necessarily shared; that covers every sensitive variable except `CRON_SECRET` |
| Whether the preview `CRON_SECRET` equals the production one | Separate entries, preview one unreadable |
| Supabase Auth's Redirect URL allow-list and Site URL | Needs a Supabase account token, which is not on this machine. Decides whether Google / Apple sign-in returns to the preview |
| Whether another (staging) Supabase project exists in the account | Same reason |
| An actual sign-in on the preview as GP, admin or CEO | Not attempted. No credentials were used and nothing was written. Findings are from the code plus anonymous requests |
| Any localhost behaviour | The server was not started. Findings are from the code |
| That `REQUIRE_SUPABASE_DB` really evaluates to false on Vercel | Inferred from the value's fingerprint and the code; the running process was not inspected |
| That Vercel never runs crons on previews | Based on the project record (crons bound to the production deployment) and known platform behaviour. The documentation page was not re-fetched |
| Whether the 127 migration files rebuild a working database from empty | Not tested; no Docker or Supabase CLI here |
| Foreign keys, unique constraints, triggers and row-level security on the tables in section 9 | Only CHECK constraints and column lists were read |
| Whether the local Retell key is the same as production's | Production's is unreadable |

---

## What changed since this audit

**WP-00S, preview send lock (commit `7f099827`).** Sections 1, 6 and 7 above
describe the code as audited. Since then:

- On a Vercel preview (`VERCEL_ENV` set and not `production`) the allow-list
  **fails closed**. `NOTIFY_TEST_RECIPIENTS` is still not set anywhere, so
  today the preview sends **nothing**: no Resend email, no WhatsApp, no Gmail
  send, no calendar invite. Setting it on the Vercel Preview environment lets
  the listed addresses and numbers through (`OWNER-ACTIONS.md`, item 1).
- The "No" rows in the section 7 table are now guarded on preview:

  | Channel | Now, on a preview |
  | --- | --- |
  | Resend, DoubleTick messages | Unset list blocks all; set list filters (was: unset = send to anyone) |
  | Gmail API (`sendGmailEmail`) | to/cc filtered through the same list; nobody left = Gmail is not called |
  | Google Calendar (`gcalCreateEvent`, `gcalDeleteEvent`) | Unlisted attendees dropped, `sendUpdates=none`; deletes never notify |
  | DoubleTick team-member assign, contact name / tags | Skipped |
  | Retell (`placeLeadCall`) | Only `LEAD_CALLS_TEST_NUMBERS` can be rung (keys are still absent on preview) |
  | Meta CAPI | Skipped (keys are still absent on preview) |
  | Calendly `POST /invitees` (a real booking; Calendly emails the invitee) | Only for a listed address. Link creation and reads are unchanged |

- `GET /api/health` on a preview reports `previewSendLock`. Production's
  response is unchanged.
- Production, localhost and the test runner behave exactly as audited.
  Localhost is therefore still as described in section 5: with real keys and no
  `NOTIFY_TEST_RECIPIENTS` it can message anyone, and its Gmail and calendar
  paths are not filtered even when the list is set.
- Section 7's "Cheapest safe setup" steps 2 and 3 are done in code. Step 1 is
  the owner action. Step 5 still stands: nothing here stops **production**
  jobs and webhooks (which run `main`) from messaging a test doctor who exists
  in the shared database.

Still not guarded on a preview, and why:

| Thing | Why it was left |
| --- | --- |
| Web push (`sendPushNotification`) | No VAPID keys exist in any environment, so it is off |
| Gmail drafts (`gmail.users.drafts.create`, one site) | Creates a draft in a team mailbox; nothing is sent until a person sends it from Gmail |
| Zoom meeting create/delete, Twilio | Keys are not on the Preview target. Twilio has no outbound send, and its Gmail forward goes through `sendGmailEmail` |
| DoubleTick `POST /embed/url` | Looks up a chat link for a phone number. Classed as a read in section 7; whether it creates a contact for an unknown number was not verified |
| Facebook / Instagram publishing, Meta ads tools, Higgsfield | Staff-triggered tools with their keys on preview. They contact no doctor or practice, but they do act on the live accounts. Outside this package |
| Calendly webhook subscription setup | A CEO-only admin action; sends nothing |
| Line numbers in sections 3, 6 and 7 | Not refreshed; they still refer to the audited commit |

Rules for new send paths: `CONVENTIONS.md` section 13.
