# Testing the Australian GP journey yourself

A step-by-step guide for the owner. No technical knowledge needed beyond
pasting a few lines into Terminal.

There are two places to test:

- **Part 1: on this Mac (recommended first).** A private copy of the app with
  a private database. Nothing you do can reach a real doctor, a real practice
  or the live business. Every email and WhatsApp the app tries to send is
  caught and shown on a page called the **Outbox**. Everything in this guide
  works here today.
- **Part 2: on the preview website.** The real app on the internet, at a
  private address. It shares the **live** database, so it needs your go-ahead
  first (see Part 2). Use it after Part 1 to check things look right on your
  own phone.

If anything on a screen differs from what a step says you should see, that is
worth telling me: note the step number and what you saw.

---

## Part 1: test on this Mac

### 1.1 Start it

Open **Terminal** and paste these two lines, one at a time. The first takes
about half a minute and is safe to run again; the second keeps running (leave
that Terminal window open).

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/au-gp-testing" && scripts/au-local/setup.sh
```

```
scripts/au-local/start.sh
```

When it says **Ready**, use **Chrome**.

### 1.2 The addresses

| What | Address |
| --- | --- |
| Public website | http://site.localhost:3000 |
| Doctor app (sign in or sign up) | http://localhost:3000/pages/signin |
| Staff sign-in for the CEO and the consultant | http://localhost:3000/pages/admin-signin |
| CEO dashboard | http://localhost:3000/pages/ceo-dashboard |
| Admin (RSO) dashboard, as the CEO | http://localhost:3000/pages/admin |
| Staff sign-in for the RSO | http://127.0.0.1:3000/pages/admin-signin |
| **Outbox**: every message the app tried to send | http://localhost:54321/outbox |

Tip: use a normal Chrome window for staff and an **Incognito** window for the
doctor, so you can be both at once. To see doctor screens at phone size, press
**Cmd+Option+I**, then **Cmd+Shift+M**, and choose "iPhone 14".

### 1.3 The test logins (all fake)

The password for every one is **`GpLink-Test-2026!`**

| Login | Who |
| --- | --- |
| `ceo@gplink-test.local` | You (CEO) |
| `consultant@gplink-test.local` | A recruitment consultant |
| `rso@gplink-test.local` | An RSO (sign in at the `127.0.0.1` address) |
| `uk.doctor@gplink-test.local` | An overseas (UK) doctor who has finished onboarding |

Two fake practices are already there: **Test Metro Practice (FAKE)** in
Parramatta (not in a DPA, two open roles) and **Test Regional Practice (FAKE)**
in Dubbo (in a DPA, one open role).

The Australian doctor you create yourself in the steps below. Use any name and
an email ending in `@gplink-test.local`, for example
`au.test1@gplink-test.local`.

### 1.4 What is different on this Mac

- **No real email arrives anywhere.** Look in the Outbox instead.
- **AI is switched off.** Where the live app would show AI-written text you
  will see a placeholder in square brackets. That is expected.
- **The booking calendar is real Calendly.** Do not book a time on it; stop
  when you reach the calendar (step 4).
- **Photo ID is optional here.** You can skip the identity step.
- Address look-up (Google) is blocked, so type addresses by hand.

---

## The doctor's journey (about 25 minutes)

Do these as the doctor in an Incognito window at phone size, switching to the
staff window when a step says so.

**1. The website.** Open http://site.localhost:3000. You should see two doors
above the main picture: "Moving to Australia" and "Already practising in
Australia". The menu has "Australian GPs".

**2. The Australian page.** Click "Already practising in Australia". You
should land on a page headed **"Your next practice, on your terms."** Nothing
on it should mention overseas doctors, visas or relocating. It should promise
"We never contact your current practice without asking you first."

**3. The booking form.** Scroll to "Book your call". The first question,
"Are you currently registered with Ahpra?", should already be answered
**Yes**. Fill in: a state (try **Western Australia**), vocationally registered
**Yes**, 19AB **No**, right to work **Citizen or permanent resident**, a fake
name, a `@gplink-test.local` email and any phone number. Press **Continue to
booking**.

**4. The calendar.** You should reach a booking calendar. **Stop here: do not
pick a time** (it is the real Calendly). Open the Outbox: there should be a
"New gp enquiry" email to you saying the segment is "Australian GP". In the
CEO dashboard, **Leads** tab, the lead should be labelled Australian and say
"Hazel does not ring Australian leads".

**5. Sign up.** Go to http://localhost:3000/pages/signin and choose to create
an account with a new `@gplink-test.local` email. You should go straight to a
question: **"Are you already registered with Ahpra and working in
Australia?"** Choose **Yes**.

**6. Onboarding.** Five short screens:
   - Where you would like to work (pick Perth and "Regional WA").
   - When you could start (any date; give a notice period of 4 weeks; state WA).
   - Your registration: type `MED0001234567`, choose **Specialist**
     registration and **FRACGP**, tick the box.
   - A few details: conditions **No**, 19AB **No**, right to work
     **Australian citizen**.
   - Review, then the identity step (skip it), then "You're all set".

   You should never see "Not yet eligible", "Plan your move" or a GMC number
   field. It should take a few minutes.

**7. First look at roles.** Press "See roles". After one welcome screen you
should see **one** role (Dubbo, the DPA one) and a line saying more roles may
open once your registration is confirmed. That is the safe default: until
staff confirm the 19AB moratorium does not apply, only DPA roles show.

**8. Staff: check the register.** In the staff window sign in as
`consultant@gplink-test.local`, open the CEO dashboard, **Candidates**. Find
your doctor (chip "Australian VR · unconfirmed"). Open them. There is a task
"Ahpra register check" and a card for it. Fill in: registration type
**Specialist**, on the specialist register **Yes**, conditions, undertakings
and notations **No**, an expiry date next year, 19AB **Does not apply**. Press
**Save as verified**. The pathway should now read **Confirmed by staff**.

**9. Doctor: more roles.** Back as the doctor, reload Careers. You should now
see **three** roles, including the two in Parramatta. In the Outbox there
should be an email to the doctor, "Your Ahpra registration is confirmed".

**10. Apply.** Open the Parramatta full-time role. The facts shown should be
the ones that matter to a local GP (billing model, VR requirement, sessions,
metropolitan). Press **Apply**. You will be asked for a CV: upload any PDF.
Then a sheet says exactly what will be sent to the practice, with a box to
tick. Tick it and apply.

**11. Staff: send to the practice.** As the consultant, open the doctor's
application and press **Submit to practice**. In the Outbox, open the email to
the practice: it should describe the doctor as "a vocationally registered GP
(FRACGP)… Ahpra registration verified… available from…", with the CV
attached, and should **not** say "internationally trained".

**12. The practice decides.** In the Outbox, click the link in that email (it
opens the practice's decision page; look at it at phone size). Press
**Approve & choose interview times**. Offer two times on weekdays between
8am and 7:30pm. (Try a Saturday: it should be refused.)

**13. Doctor: book the interview.** As the doctor, open Careers; there is an
invitation to choose a time. The times should be shown in **Perth time**.
Book one. In the Outbox, the doctor's confirmation should say the time in
AWST and the practice's in AEDT.

**14. Staff: interview done, offer made.** As the consultant, open the
application and press **Mark interview finished**. In the Outbox open the
email to the practice "How did the interview go?", click its link, choose
**Extend an offer** and upload any PDF as the contract. Then sign in as
`ceo@gplink-test.local`, open the **Contracts** tab, open the contract, enter
**sessions a week** (for example 8) and press **Submit to GP**.

**15. Doctor: sign.** As the doctor, Careers shows the offer. Open it, read
the screen ("Your agreement is ready"), type your name, draw a signature and
sign. You should see "Position secured", then a button **Open my pre-start
checklist**.

**16. The pre-start checklist.** You should see a list: Ahpra register check
(done), notice to your current practice, start date, indemnity certificate,
Medicare provider number for the new location, referees, credentialing.
There should be **no** MyIntealth, AMC, Ahpra application, visa, SPPA-00,
Section G or supervisor CV anywhere. Do these as the doctor:
   - Record that you have given notice (pick a date).
   - Add two referees.
   - Upload any PDF as the indemnity certificate.
   - Open the **Medicare provider number** step and type a number such as
     `2468101A`. It should say it is **being confirmed** (staff confirm it).

   In the Outbox the doctor should have "Your placement is secured: your
   pre-start checklist" and the practice "Placement confirmed".

**17. Staff: finish pre-start.** Sign in as `rso@gplink-test.local` at
http://127.0.0.1:3000/pages/admin-signin. Open the doctor. The case should
show **AU**, the Australian steps (Secure placement, Pre-start, Commenced,
Guarantee, Complete) and the pre-start tasks. Approve the indemnity document,
confirm the doctor's provider number, save the start date, and mark the
credentialing pack sent. As the consultant, complete the reference check and
the restraint check. The doctor should then get "You are cleared to start".

**18. Commencement.** As the CEO or consultant, open the doctor in Candidates
and find the card **Commencement and guarantee**. Press **Confirm commenced**,
choose today's date. As the CEO you should then see the fee worked out from
the practice's agreement (**$21,000** for 8 or more sessions, **$18,000** for
fewer), a task **Raise placement-fee invoice**, and check-ins at week 1 and
weeks 4, 8 and 12. Nothing is sent to anyone at this moment, and nothing is
created in Xero: the invoice is yours to raise by hand. Mark the invoice
**sent**, then **paid**.

**19. What the doctor sees after starting.** As the doctor, Home should say
**"You have started"** with the practice name. Nothing about fees appears to
the doctor anywhere.

**20. Dashboards.** As the CEO, look at the **Overview**: there is an
"Australian GPs" card with the pipeline (Matched, Interview, Contract,
Pre-start, Commenced, Guarantee) and, for you only, invoices due and
placements in guarantee. The doctor should not appear under "MyIntealth" or
as "GB" anywhere.

---

## The staff journey (about 10 minutes)

**S1. Add a doctor yourself.** As the consultant: CEO dashboard,
**Candidates**, **Add candidate**. Enter a fake name, a `@gplink-test.local`
email, pathway **Australian VR**, a state. In the Outbox there is an invite,
"Set up your GP Link account". Open its link in the Incognito window: the
doctor creates a password and goes straight into the Australian onboarding
with the state already filled in.

**S2. A doctor with restrictions (segment B).** Sign up another fake doctor
and in onboarding answer 19AB **Yes** and right to work **Temporary
resident**. They should finish onboarding and be told **"Thanks, we have your
details. Our team will confirm your details and be in touch."** Careers shows
a card "We are confirming your details" and no roles; they cannot apply. As
staff you should see them flagged ("Segment B (not launched: held)") with a
review task.

**S3. A non-VR doctor (segment C).** The same, choosing **No fellowship**.
Same result: held, flagged, nothing wrong shown.

**S4. Filters.** In Candidates use the pathway filter (All, Overseas,
Australian VR, restricted, Non-VR, Registrar, Needs review).

**S5. The staff guide.** As the CEO: Registration, Guides, **Add the
Australian guide**. Seven short pages appear for staff.

---

## The practice journey (about 10 minutes)

**P1. Employers page.** Open http://site.localhost:3000/employers. It should
describe two ways to hire: GPs moving to Australia, and GPs already registered
here.

**P2. A metro practice enquires.** On that page fill in "Tell us what your
practice needs" as **Test Inner Metro Practice (FAKE)**, Surry Hills, NSW,
2010, with `practice.metro.test@gplink-test.local`. On this Mac the area
check says "We'll confirm your area with you" (the map service is blocked
here). Send.

**P3. Intake.** In the Outbox open "Your GP is waiting" and follow its link.
Complete the five steps: type the address by hand, answer **"No, we are
not"** in a DPA, and on step 2 check the question **"Which GPs will you
consider?"** (only vocationally registered Australian GPs is ticked; the
overseas option is greyed out with an explanation). Sign on step 5 using the
ABN `51 824 753 556`.

**P4. Approve and publish.** As the CEO: **Practices** shows the practice as
"Not in a DPA · Open to: VR GPs". In **Jobs**, open the pending role, add a
header photo, check "Who this role is open to", and **Approve**.

**P5. Who can see it.** Your verified Australian VR doctor (step 9) should
see the new role in Careers. `uk.doctor@gplink-test.local` should not.

---

## Check nothing changed for overseas doctors (about 5 minutes)

**O1.** Sign in as `uk.doctor@gplink-test.local`. Home, Careers and My
Documents should look exactly as they do on the live app today (MyIntealth,
AMC, AHPRA, visa steps; the overseas document list).

**O2.** Sign up a new fake doctor and answer **No** to the first question.
You should get today's wizard ("Plan your move", country, GMC number).

**O3. The switch off.** In the Terminal window press **Ctrl+C**, then paste:

```
AU_PATHWAY_ENABLED=false scripts/au-local/start.sh
```

Now: the website has no "Australian GPs" item and `/australian-gps` is "not
found"; sign-up has no first question, and choosing Australia leads to "Not
yet eligible"; the CEO dashboard has no pathway filter and no "Add
candidate". This is what the live site will be like after the change is
merged and before you turn the switch on. Press **Ctrl+C** and run
`scripts/au-local/start.sh` again to turn it back on.

---

## Start again, and clean up

- **Reset a test and try again:** in Terminal, **Ctrl+C**, then
  `scripts/au-local/reset.sh`, then `scripts/au-local/start.sh`. This wipes
  the private database, the uploaded files and the Outbox and puts the fake
  starting data back. Nothing else on the Mac is touched.
- **Stop:** **Ctrl+C** in the Terminal window, or `scripts/au-local/stop.sh`.
- **Remove everything:** delete the folder `~/gplink-tools/au-local/`. All of
  the local test data lives there and nowhere else.

---

## Part 2: test on the preview website

The preview is the real app at a private address:

**https://gplink-repository-git-au-gp-testing-gplinkrecruitments-projects.vercel.app**

Doctor sign-in is at `/pages/signin`; staff at `/pages/admin-signin` (your own
super-admin login only; a normal staff login is refused on a preview address).

Three things to know before using it:

1. **It shares the live database.** A doctor you create there is a real row
   in the live database. So it cannot work for Australian doctors until the
   twelve database files have been applied to the live database, which needs
   your go-ahead. They only add empty fields and rules; they change nothing
   for current doctors. Until then, Australian onboarding on the preview stops
   with an error rather than guessing.
2. **It cannot message anyone yet.** The preview blocks every email and
   WhatsApp until you set `NOTIFY_TEST_RECIPIENTS` (in Vercel, on the
   **Preview** environment only) to addresses and numbers you own. After
   that, test messages reach only those.
3. **The live site's scheduled jobs will see your test doctors**, and the
   live site still runs today's code. A half-finished test doctor may get the
   normal overseas reminder emails from the live system. Use only email
   addresses and phone numbers you own, and make the names obviously fake
   (for example "Dr Test Preview").

On the preview, repeat the doctor's journey steps 1 to 20 on your own phone.
Things worth checking there that cannot be checked on this Mac: how screens
feel on a real phone, real emails arriving, and what the AI actually writes
(case summaries, suggested replies, the "why we recommend" line to a
practice).

**Removing preview test data afterwards.** Keep a list of the test doctors
and practices you create (their emails). They are removed from the live
database with the existing admin tools: archive or delete the test doctors
from the admin dashboard and delete the test practice and its role from the
CEO dashboard. Ask me to check nothing is left behind.

---

## The test identities used in this guide

All fake; none is a real doctor or practice.

| Identity | Where | Created by |
| --- | --- | --- |
| `ceo@`, `consultant@`, `rso@`, `adminpool@`, `uk.doctor@` (all `@gplink-test.local`) | This Mac only | The setup script |
| Test Metro Practice (FAKE), Test Regional Practice (FAKE) | This Mac only | The setup script |
| Any `…@gplink-test.local` doctor you sign up | This Mac only | You |
| Test Inner Metro Practice (FAKE), `practice.metro.test@gplink-test.local` | This Mac only | You (step P2) |
| "Dr Test Preview" style doctors with your own email addresses | Preview (live database) | You, in Part 2 |
