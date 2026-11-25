# The local test stack: run the whole app on this Mac, safely

## What this is

A private copy of everything the app needs, running only on this Mac:

- **A private database** with the same structure as the live one (same tables, columns, rules) and **none of its data**. It starts with a handful of obviously fake records.
- **A stand-in for every outside service.** Email, WhatsApp, phone calls, Zoom, Calendly, Google, Facebook and the rest are all faked. When the app "sends" something, it is caught and shown on a page called the **Outbox** instead. Nothing is sent to anyone.

You can sign up doctors, approve things, move people through stages and run the scheduled jobs. The live business, the live database and real doctors and practices are never touched.

Why it exists: the preview website and the main project folder both talk to the **live** database (see `ENVIRONMENT.md`). This does not.

---

## Set up (once)

In Terminal, from the project folder:

```
scripts/au-local/setup.sh
```

It takes about half a minute. It downloads two small programs into `~/gplink-tools/au-local/` (outside the project), builds the private database and adds the fake test data. It is safe to run again.

## Start

```
scripts/au-local/start.sh
```

When it says **Ready**, open these in **Chrome**:

| What | Address |
|---|---|
| Doctor app: sign in or sign up | http://localhost:3000/pages/signin |
| CEO dashboard | http://localhost:3000/pages/ceo-dashboard |
| Admin dashboard, as the CEO | http://localhost:3000/pages/admin |
| Staff sign-in for the CEO and the consultant | http://localhost:3000/pages/admin-signin |
| Staff sign-in for the RSO | http://127.0.0.1:3000/pages/admin-signin |
| **Outbox**: every message the app tried to send | http://localhost:54321/outbox |

### Why two addresses (`localhost` and `127.0.0.1`)

The live app has two staff addresses: one for the CEO (`ceo.admin…`) and one for employees (`admin…`), and it refuses the wrong kind of login on each. Locally:

- `http://localhost:3000` behaves like the **CEO address**. The CEO and the consultant sign in here. An RSO is refused here, exactly as on the live CEO address.
- `http://127.0.0.1:3000` behaves like the **employee address**. The RSO signs in here. The CEO dashboard does not exist on this address, exactly as live.

Doctors can use either. You can be signed in as the CEO on one and the RSO on the other at the same time.

## Seeded logins

The password for all of them is **`GpLink-Test-2026!`**

| Login | Who | Sign in at |
|---|---|---|
| `ceo@gplink-test.local` | Super admin (CEO) | http://localhost:3000/pages/admin-signin |
| `consultant@gplink-test.local` | Recruitment consultant (CEO dashboard only) | http://localhost:3000/pages/admin-signin, then open the CEO dashboard |
| `rso@gplink-test.local` | RSO / staff | http://127.0.0.1:3000/pages/admin-signin |
| `adminpool@gplink-test.local` | The "GP Link Admin" pool that new doctors are given to | http://127.0.0.1:3000/pages/admin-signin |
| `uk.doctor@gplink-test.local` | Dr Test Ukgp, an overseas (UK) doctor who has finished onboarding | http://localhost:3000/pages/signin |

Also seeded:

- **Test Metro Practice (FAKE)**: Parramatta NSW, not a DPA area, mixed billing, agreement signed, two approved open roles.
- **Test Regional Practice (FAKE)**: Dubbo NSW, DPA, bulk billing, agreement signed, one approved open role.

No Australian doctor is seeded. Sign one up through the real sign-up screen, with any email ending in `@gplink-test.local`.

Things that look odd but are correct:

- A new doctor belongs to the admin pool, so the RSO sees **no doctors** until the CEO assigns one to them. That is how the live app works.
- The UK doctor sees one full role (the DPA one) and two blurred "confidential practice" cards. An overseas doctor does not qualify for non-DPA roles.
- The UK doctor gets the welcome slideshow on first sign-in, and the MyIntealth page stays locked until they are further along.

## The Outbox

http://localhost:54321/outbox lists, newest first, everything the app tried to send: time, type (email, WhatsApp, phone call, calendar, SMS, push), who it was to, the subject or template name, and the full content.

- **Emails** show as the recipient would see them, with tabs for plain text and the raw HTML. Buttons inside the preview cannot be clicked, so each link is listed underneath; click it there.
- **WhatsApp templates** show the template name and the values filled into it. The wording of an approved template lives in DoubleTick and Meta, not in the app, so the finished sentence cannot be shown.
- **Search** looks through names, addresses, phone numbers and message text.
- **Clear outbox** empties the list (only on this Mac).
- Tick **"Also show background service calls"** to see everything else the app tried to reach (sign-in tokens, address lookups, blocked requests).

No real email arrives anywhere. If you are waiting for a verification or reset email, it is in the Outbox.

### Testing "this WhatsApp template is not approved yet"

Locally every WhatsApp message is reported to the app as sent. On the live service, a template that Meta has not approved yet is refused. To make the local stack refuse particular templates the same way, create the text file `~/gplink-tools/au-local/whatsapp-unapproved-templates.txt` with one template name per line (a `*` at the end matches any ending, for example `gp_link_au_*`). It takes effect straight away. Those messages then appear in the Outbox marked **NOT DELIVERED**, and you can check the app falls back to email or skips the message, as it must. Delete the file to go back to "everything is accepted".

## Switching the Australian pathway off

```
AU_PATHWAY_ENABLED=false scripts/au-local/start.sh
```

Use this to check the app behaves exactly as it does today with the switch off. Run `start.sh` again without it to turn it back on.

## Running a scheduled job

On the live site, jobs run by themselves on a timetable. Locally they run only when asked:

```
scripts/au-local/run-cron.sh --list
scripts/au-local/run-cron.sh onboarding-nudge
```

Anything the job tries to send appears in the Outbox. Many jobs only act after time has passed (for example "24 hours after sign-up"), so a job can correctly report that it did nothing.

## Reset (back to a clean start)

```
scripts/au-local/reset.sh
scripts/au-local/start.sh
```

This wipes the private database, stored files and the Outbox and puts the fake test data back. It only ever touches the local stack and refuses to run against anything else.

## Stop

```
scripts/au-local/stop.sh
```

Your test data is kept. `start.sh` brings it back as it was.

## Trying a database change before it goes near production

Database changes for this build are files in `supabase/migrations/` with `au_gp` in the name.

```
scripts/au-local/apply-migrations.sh
```

applies any new ones to the **local** database only, in order, and lists exactly what each one added or changed (columns, rules, indexes). `start.sh`, `setup.sh` and `reset.sh` do this automatically. It runs each file the same way production would (through the database's `exec_sql` function, which has no default schema), so a file that would fail on production fails here first. Add `--redo` to apply every file again and prove they are safe to run twice.

---

## What is the same as production, and what is not

**The same**

- The database structure: 83 tables with their columns, types, defaults, required fields, primary keys, unique rules, CHECK rules (including the live lists for case stage, task type and call stage), foreign keys, 166 extra indexes, 13 functions, 23 triggers, 2 views, 107 row-security policies and the access granted to each API role. Checked by comparing production's structure with the local database's, line for line: an exact match.
- The database programs: Postgres 17 and PostgREST 14.5, the versions production runs. Queries, filters, upserts and error codes come from the real programs. Asking for a column that does not exist fails with a 400, as it does live.
- A result is capped at 1,000 rows per request, as on Supabase.
- Which staff login is allowed on which address.
- The app code. Nothing in `server.js`, `lib/`, `pages/` or `js/` is changed for local use.

**Not the same**

| Area | Locally |
|---|---|
| Sign-in service (Supabase Auth) | Emulated. Email and password sign-up, sign-in, password reset links, and the staff-side account calls all work. **Google and Apple sign-in do not.** The emulator accepts any password of 6 characters or more (the app applies its own 12-character rule first). |
| File storage (Supabase Storage) | Emulated, files kept in `~/gplink-tools/au-local/storage/`. Upload, download, delete, time-limited links and browser uploads work. A storage bucket is created the first time it is used instead of being refused. |
| Email, WhatsApp, calls, SMS, push | Never sent. Captured in the Outbox. The app is told each one succeeded. |
| Replies and receipts | Outside services never call back. No delivery receipts, no WhatsApp replies, no Calendly "booking made" notice, no Zoom recordings or summaries, no incoming email. Features that depend on those callbacks will wait forever. |
| Google Drive, Gmail, Calendar | Faked. Folders and events get made-up ids. Mailboxes are always empty. The diary always shows as free. Opening a Drive link goes nowhere. |
| Health Workforce Locator (the priority-area and remoteness check, WP-30) | Not contacted. The app answers from a small built-in test map (`lib/au-workforce-locator-fixture.json`): a few made-up street addresses in Parramatta, Dubbo and Tennant Creek. Start with `AU_WORKFORCE_LOCATOR_PROVIDER=none scripts/au-local/start.sh` to switch the check off and have practices asked instead. |
| Calendly | Faked, with made-up free time slots. A booking is recorded in the Outbox but the app is not told about it afterwards. |
| AI features | **Off.** Anything that asks the AI gets a placeholder answer, so document checks, summaries and AI matching will not give real results. See below. |
| Maps, address and housing lookups, medical-register checks | Blocked or answered "nothing found". A doctor's register number stays "pending verification". |
| Image clean-up for scanned documents (a Supabase Edge Function) | Not available. |
| Sign-in attempt limit | Raised from 12 to 300 attempts per ten minutes, so repeated test sign-ins are not locked out. |
| Speed | Faster than live (no trip to a US data centre). |
| Sorting of text | Uses the same language rules as live, but small differences are possible between Mac and server versions. |
| Fonts and one sign-in script | The **browser** still loads Google Fonts and a script from `cdn.jsdelivr.net`. These are ordinary downloads by Chrome and carry no test data. With no internet the pages still work but look plainer, and the sign-in page cannot offer Google sign-in. |

### AI calls

By default every AI request is blocked and noted in the Outbox (tick "background service calls" to see them).

```
AU_LOCAL_ALLOW_AI=1 scripts/au-local/start.sh
```

lets real AI calls through. **This sends the test content to Anthropic using the real key from the main project folder, and it costs real money on the live Anthropic account.** It is never switched on unless you type that. Everything else stays blocked.

---

## How it is kept safe

- The app is started with a fixed, written-out list of settings. It does not read any `.env` file, even if one is sitting in the folder.
- Before the app starts, and again once it has loaded, it checks that its database address is this Mac. If not, it stops with a clear message.
- Every request the app makes to an outside address is redirected to the Outbox. Beneath that, a second guard refuses any connection that is not to this Mac, whatever part of the app tried to open it. Name lookups and starting other programs are blocked too.
- Refused connections are listed in `~/gplink-tools/au-local/logs/blocked-outbound.log`. In normal use that file stays empty, because requests are caught earlier and shown in the Outbox.
- All keys and passwords the stack uses are made up on this Mac and work nowhere else.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| "STOP: not set up yet" | Run `scripts/au-local/setup.sh`. |
| "Port 3000 is already in use" | Another copy of the app is running. Close it, or run `scripts/au-local/stop.sh`, then start again. |
| "the app's node_modules folder is missing" | In the project folder run `ln -s "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/node_modules" node_modules`. |
| A page will not load, or "could not load the outbox" | The stack is not running. Run `scripts/au-local/start.sh`. |
| "This host is reserved for super admin access" | You tried the RSO login on `localhost`. Use `http://127.0.0.1:3000/pages/admin-signin`. |
| "This admin account is not allowed on this host" | You tried the consultant on `127.0.0.1`. Use `http://localhost:3000/pages/admin-signin`. |
| The CEO dashboard shows "not found" | Use `http://localhost:3000/pages/ceo-dashboard`, not `127.0.0.1`. |
| A page looks or behaves wrongly in another browser | Use Chrome. It is the only browser this was checked in. |
| "Too many attempts" when signing in | Wait ten minutes, or run `reset.sh` then `start.sh`. |
| Something behaves strangely after a lot of testing | `scripts/au-local/reset.sh` then `scripts/au-local/start.sh`. |
| You want to see what went wrong | The logs are in `~/gplink-tools/au-local/logs/` (`app.log` is the app itself). |
| The Mac was restarted | Run `scripts/au-local/start.sh` again. Your test data is still there. |
| Remove it all | `scripts/au-local/stop.sh`, then delete the folder `~/gplink-tools/au-local`. |

---

## For engineers

| File | Purpose |
|---|---|
| `scripts/au-local/setup.sh`, `start.sh`, `stop.sh`, `reset.sh` | The commands above. |
| `scripts/au-local/apply-migrations.sh`, `run-cron.sh` | Migrations and scheduled jobs, local only. |
| `scripts/au-local/seed.js` | Fake data. Extend it by adding a file to `scripts/au-local/seed.d/` that exports `async function (ctx)`. |
| `scripts/au-local/snapshot-schema.js` | Re-reads production's structure (read-only, catalog metadata only) and rewrites `schema/prod-schema.sql`. `--check` reports drift. `--verify-local` compares production with the local database. |
| `scripts/au-local/schema/prod-schema.sql` | The committed structure snapshot. No row data. |
| `scripts/au-local/gateway.js` | Port 54321. `/rest/v1` to PostgREST, `/auth/v1` and `/storage/v1` emulators, `/__trap__`, `/outbox`. |
| `scripts/au-local/preload.js` | The outbound trap, loaded into the app with `node -r`. |
| `scripts/au-local/lib/trap.js` | The canned answer for each outside service. Add a new service here. |
| `scripts/au-local/lib/selftest.js` | Checks the gateway: database API, auth, storage. |
| `scripts/au-local/lib/inspect.js` | Read-only look at the local database and Outbox: `doctor <email>`, `outbox`, `counts`, `sql "<select>"`. |

Ports: app 3000, gateway 54321, Postgres 54329, PostgREST 54330. All listen on this Mac only. Data: `~/gplink-tools/au-local/` (`pgdata/`, `storage/`, `outbox.jsonl`, `logs/`, `local-secrets.json`).

To refresh the snapshot after a production migration: `node scripts/au-local/snapshot-schema.js`, review the diff, commit, then `reset.sh`.
