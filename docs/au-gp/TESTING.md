# Testing the Australian GP journey yourself

A step-by-step guide for the owner. No technical knowledge needed beyond
pasting a few lines into Terminal.

**Checked 24 November 2026 against commit `9e66f27e`.** Every step in Part 1
was followed on screen in Chrome on this Mac, with these exceptions: the
"cleared to start" email at the end of step 17 was not seen (the walk was done
after 8pm, when that email is held until morning); at step 14 the sessions box
was left empty and the 8 was typed at step 18 instead; the real booking
calendar at step 4 was not loaded; step O2 was followed as far as "Plan your
move"; step O1 could not be compared side by side with the live app; and
"Remove everything" was not run.

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

Open **Terminal** and paste these two lines, one at a time. Each takes a few
seconds (the first takes about half a minute the very first time) and both
are safe to run again.

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/au-gp-testing" && scripts/au-local/setup.sh
```

```
scripts/au-local/start.sh
```

When it says **Ready**, use **Chrome**. The app keeps running in the
background: you get the Terminal prompt back and can close the window. Keep
it open if you plan to do step O3 or a reset, because those lines must be
pasted in a window that has already run the `cd` line above.

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

**Switching between staff logins.** The CEO and the consultant share one
sign-in page, so only one of them can be signed in at a time. To switch, open
http://localhost:3000/pages/admin-signin. If someone is still signed in you
land on a page called "CEO Command Centre" or "RSO Command Centre": press
**Logout** (top right), then sign in as the other person. The CEO lands on
"CEO Command Centre" after signing in: open the CEO dashboard address from
there. The consultant lands on the CEO dashboard directly. The RSO uses the
`127.0.0.1` address and can stay signed in alongside either of them.

**A new doctor needs a fresh Incognito window.** Before signing up or inviting
another doctor, close every Incognito window and open a new one. Otherwise the
previous doctor is still signed in.

**Reading the Outbox.** Click a message to open it. **Plain text** shows the
wording. The message's buttons are listed under "Buttons and links in this
message": click one to follow it. Press **Refresh** to see new messages.

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
`au.test1@gplink-test.local`. Use the same password as above so it is easy to
remember.

### 1.4 What is different on this Mac

- **No real email arrives anywhere.** Look in the Outbox instead.
- **AI is switched off.** Where the live app would show AI-written text you
  will see a placeholder in square brackets, or a line such as "AI review
  failed" or "AI scan unavailable". That is expected.
- **The booking calendar is real Calendly.** Do not book a time on it; stop
  when you reach the calendar (step 4).
- **Photo ID is optional here.** You can skip the identity step.
- Address look-up (Google) is blocked, so type addresses by hand.
- **Dates follow the Sydney clock**, which is three hours ahead of this Mac.
  After 9pm on this Mac the app already counts it as tomorrow, so if "today"
  is refused as a date, use tomorrow's date.

---

## The doctor's journey (about 45 minutes)

Do these as the doctor in an Incognito window at phone size, switching to the
staff window when a step says so.

**1. The website.** Open http://site.localhost:3000. You should see two doors
at the top of the main picture: "Moving to Australia" and "Already practising
in Australia". The menu (the ☰ button at phone size) has "Australian GPs".

**2. The Australian page.** Click "Already practising in Australia". You
should land on a page headed **"Your next practice, on your terms."** Nothing
on it should mention overseas doctors, visas or relocating. It should promise
"We never contact your current practice without asking you first."

**3. The booking form.** Scroll to "Book your call". The first question,
"Are you currently registered with Ahpra?", should already be answered
**Yes**. Fill in: a state (try **Western Australia**), vocationally registered
**Yes**, 19AB **No**, right to work **Citizen or permanent resident**, a fake
name, a `@gplink-test.local` email and any phone number. Press **Continue to
booking →**.

**4. The calendar.** The form is replaced by a booking calendar on the same
page, under a line starting "Dr …, pick a time that suits you". **Stop here:
do not pick a time** (it is the real Calendly). Open the Outbox: there should
be an email to you, "New gp enquiry, …"; open it and press **Plain text**: it
says "Segment: Australian GP: vocationally registered". Then, in the staff
window, sign in as `ceo@gplink-test.local` at the staff sign-in address, open
the CEO dashboard address and press the **Leads** tab: the lead should carry
the label "AU · VR" and say "Australian GP: Hazel does not ring Australian
leads".

**5. Sign up.** In the Incognito window go to
http://localhost:3000/pages/signin and press **SIGN UP**. Fill in first name,
last name, a new `@gplink-test.local` email, a phone number and the password
twice, then press **CREATE ACCOUNT**. You should go straight to a question:
**"Are you already registered with Ahpra and working in Australia?"** Choose
**Yes**. (A note asking you to verify your email may show at the top. You can
carry on.)

**6. Onboarding.** Short screens, pressing **NEXT** after each:
   - "Where would you like to work?" Pick Perth and "Regional WA".
   - "When could you start?" Any date; notice period **4 weeks**; under "Where
     you live now" choose Western Australia.
   - "Your Ahpra registration". Type `MED0001234567`, choose **Specialist
     (general practice)** and **FRACGP**, tick the box.
   - "A few details about your registration". Conditions **No**, 19AB **No**,
     right to work **Australian citizen**.
   - "Does everything look right?" Check it and press NEXT.
   - "Confirm your identity". Press **SUBMIT** without uploading anything.
   - "You're all set."

   You should never see "Not yet eligible", "Plan your move" or a GMC number
   field. It should take a few minutes.

**7. First look at roles.** Press **See roles**. A welcome sheet appears
("Welcome, Dr …"): press **See roles** again. You should see **one** role
(Dubbo, the DPA one) and a line saying "More roles may open once we have
confirmed your registration." That is the safe default: until staff confirm
the 19AB moratorium does not apply, only DPA roles show. This page is
**Careers**: at phone size it is the "My Practice" button at the bottom.

**8. Staff: check the register.** In the staff window switch to
`consultant@gplink-test.local` (see 1.2). You land on **Candidates**. Find
your doctor (labels "Australian VR · unconfirmed" and "Needs review") and
click the row. Find the card **Ahpra register check**. Fill in: Registration
type **Specialist**, Registration expiry a date next year, Fellowship
**FRACGP**, Right to work **Australian or NZ citizen**, Supervision shown on
the register **None**, On the specialist register as a GP **Yes**, Conditions,
Undertakings and Notations **No**, Section 19AB **Does not apply**. Press
**✓ Save as verified**. The Pathway card should now read **Confirmed by
staff**. (If a tick box about resolving a review shows, tick it first.)

**9. Doctor: more roles.** Back as the doctor, reload Careers. You should now
see **three** roles, including two in Parramatta. In the Outbox there should
be an email to the doctor, "Your Ahpra registration is confirmed".

**10. Apply.** The two Parramatta roles look the same in the list. Open the
**lower** one (the full-time role). Under "The practice" the facts shown
should be the ones that matter to a local GP: Billing, Registration
("Vocational registration (VR) required"), Sessions, Location type
("Metropolitan (MM1)"). Press **Apply for interview**. A sheet "Upload Your
CV" appears: choose any PDF and press **Upload & Apply**. Then a sheet "Put
me forward to Test Metro Practice (FAKE)?" says exactly what will be sent to
the practice, with a box to tick. Tick it and press **Apply for interview**.
You should see "✓ Interview request sent".

**11. Staff: send to the practice.** As the consultant, open the doctor from
Candidates, scroll to **Applications** and press **Submit to practice**. A
box asks you to confirm: press OK. In the Outbox, open the email to the
practice, "Candidate introduction: Dr …": it should describe the doctor as "a
vocationally registered GP (FRACGP) based in Western Australia. GP Link has
verified Dr …'s Ahpra registration on the public register… available from…",
with the CV attached, and should **not** say "internationally trained".

**12. The practice decides.** In that email, click the link "Approve Dr … and
choose interview times" (it opens the practice's decision page; look at it at
phone size). Press **Approve & choose interview times**. Offer two times on
weekdays, choosing **morning** times: the times you pick are on this Mac's
clock, and they must fall between 8:00 am and 7:30 pm in Sydney. (Try a
Saturday first: it should be refused with "Please pick a weekday".) Press
**Confirm times & approve candidate**.

**13. Doctor: book the interview.** As the doctor, open Careers: a sheet
"Interview invitation" appears with the times, and a line saying they are
shown in your local time. On this Mac that is this Mac's own clock (GMT+8,
the same as Perth). Tap a time and press **Confirm interview time**. You
should see "You're booked in". In the Outbox, the doctor's "Your interview is
confirmed 🎉" and the practice's "Interview confirmed, …" both give the time
followed by "GMT+8", because both screens were used on this Mac.

**14. Staff: interview done, offer made.** As the consultant, open the doctor,
scroll to Applications and press **Mark interview finished**, then OK. In the
Outbox open the email to the practice "How did the interview with Dr … go?",
click its **Extend an offer** link, press **Extend an offer**, choose any PDF
as the contract and press **Send contract for review**. Then switch to
`ceo@gplink-test.local`, open the CEO dashboard and the **Contracts** tab,
click the contract and press **Submit to GP**. A box asks "How many sessions a
week will the doctor work?": type **8** and press OK. The contract should now
say "Sent to GP".

**15. Doctor: sign.** As the doctor, open Careers: a sheet "The position is
yours" appears. Press **Complete agreement**. (If the sheet has gone, press
**Sign my contract**, then **Review and sign**.) The screen is headed "Your
agreement is ready". Type your name, draw a signature and press **Sign &
secure my position**. You should see a sheet "Position secured": press
**Next**, then **Open my pre-start checklist**.

**16. The pre-start checklist.** You should see a list: Ahpra register check
(done), Notice to your current practice, Start date confirmed, Indemnity
certificate of currency, Medicare provider number for the practice, Reference
checks, Practice credentialing, then four more documents (Ahpra registration
certificate, Fellowship certificate, Right to work in Australia, Working with
Children Check). There should be **no** MyIntealth, AMC, Ahpra application,
visa, SPPA-00, Section G or supervisor CV anywhere. Do these as the doctor:
   - Press **I have given notice**, tick the box, pick a date, press **Save**.
   - Press **Add two referees**, fill in both (every box, and both tick
     boxes), press **Save referees**.
   - Scroll down to **Documents to upload** and press **Upload** on each of
     the five cards, choosing any PDF each time.
   - Press **Open this step** on the Medicare provider number item and type a
     number such as `2468101A`, then **Save number**. It should say **Being
     confirmed** (staff confirm it). Press "Back to my pre-start checklist".

   In the Outbox the doctor should have "Your placement is secured: your
   pre-start checklist" and the practice "Placement confirmed: Dr …".

**17. Staff: finish pre-start.** First give the case to the test RSO. As the
CEO, open http://localhost:3000/pages/admin, press **GPs**, click the doctor,
press the small **▾** button beside "View as GP", choose **Test Rso (FAKE)**
under "Assigned RSO" and press **Save Changes**. Now sign in as
`rso@gplink-test.local` at http://127.0.0.1:3000/pages/admin-signin, press
**GPs** and click the doctor. The case should show **Australian VR (segment
A)**, the Australian steps (Secure placement, Pre-start, Commenced,
Guarantee, Complete) and the pre-start tasks. Then:
   - Press **Review Document**, then **Approve**, on each "Review uploaded…"
     task (five in all).
   - Press **Record number** on the Medicare task, then **Confirm and
     record**.
   - Press **Save start date**, choose today's date (after 9pm use
     tomorrow's, see 1.4), press **Save start date**.
   - Press **Mark Complete** on "Send the practice credentialing pack" (it
     appears once the indemnity certificate is approved).

   Then, as the consultant, open the doctor from Candidates and find **Tasks
   on this case**. Press **Mark done** on the restraint-of-trade check, choose
   "No restraint in the current contract" and press **Save**. Press **Mark
   done** on the reference checks and press **Save**. The Pre-start card
   should now be complete. Between 8am and 8pm the doctor then gets "You are
   cleared to start on …"; outside those hours it is held until the morning.

**18. Commencement.** As the CEO, open the doctor in Candidates and find the
card **Commencement and guarantee**. Press **Confirm commenced**. Leave the
date the form suggests; if "Sessions a week" is empty, type **8**; press
**Confirm commenced**. You should then see the fee worked out from the
practice's agreement (**$21,000** for 8 or more sessions, **$18,000** for
fewer), a task **Raise placement-fee invoice**, and check-ins at the first
week and weeks 4, 8 and 12. Nothing is sent to anyone at this moment, and
nothing is created in Xero: the invoice is yours to raise by hand. Press
**Mark invoice sent**, type any invoice number, **Save**; then **Mark invoice
paid**, **Save**.

**19. What the doctor sees after starting.** As the doctor, press Home (the
first button at the bottom). It should say **"You have started"** with the
practice name. Nothing about fees appears to the doctor anywhere. To see the
doctor's documents, press the person button at the bottom, then **My
Documents**. Known quirk: **View** on a document saves a file called
`document.pdf` to Downloads instead of opening it.

**20. Dashboards.** As the CEO, look at the **Overview**: there is an
"Australian GPs" card with the pipeline (Matched, Interview, Contract,
Pre-start, Commenced, Guarantee) and, marked "you only", invoices due and
placements in the guarantee period. The doctor should not appear under
"MyIntealth" or as "GB" anywhere.

---

## The staff journey (about 15 minutes)

**S1. Add a doctor yourself.** As the consultant: **Candidates**, **＋ Add
candidate**. Enter a fake name, a `@gplink-test.local` email, pathway
**Australian VR**, a state, and press **Create and send invite**. In the
Outbox there is an invite, "Set up your GP Link account". Open its **Set my
password** link in a **fresh** Incognito window: the doctor creates a
password and goes straight into the Australian onboarding (no first question)
with the state already filled in on the second screen. Finish the onboarding
as in step 6: you will use this doctor again in P5.

**S2. A doctor with restrictions (segment B).** In a fresh Incognito window
sign up another fake doctor and in onboarding answer 19AB **Yes** and right to
work **Temporary resident**. They should finish onboarding and be told
**"Thanks, we have your details."** and "Our team will confirm your details
and be in touch." Press **See where things are up to**: Careers shows a card
"Thanks, we have your details" and no roles; they cannot apply. As staff you
should see them labelled "Australian restricted · unconfirmed" and "Needs
review"; inside, the Pathway card says "Segment B (not launched: held)" and
there is a task to decide the segment.

**S3. A non-VR doctor (segment C).** The same, choosing **No fellowship**
(leave 19AB as No). Same result: held, labelled "Non-VR · unconfirmed",
nothing wrong shown.

**S4. Filters.** In Candidates use the pathway filter (All pathways, Overseas,
Australian VR, Australian restricted, Non-VR, Registrar, Needs review).

**S5. The staff guide.** As the CEO, open the CEO dashboard. A box "Needs your
review" now pops up because of the two held doctors: press **Remind me
later**. Then **Registration**, **Guides**, **+ Add the Australian guide**. A
folder "Australian GP placements" appears with seven short pages for staff.

---

## The practice journey (about 15 minutes)

**P1. Employers page.** Open http://site.localhost:3000/employers. Under "Two
ways to hire" it should describe two tracks: GPs already registered in
Australia, and GPs moving to Australia.

**P2. A metro practice enquires.** On that page find "Tell us what your
practice needs". Step 1: tap how many GPs, full-time or part-time and when,
then **Continue →**. Step 2: **Test Inner Metro Practice (FAKE)**, Surry
Hills, NSW, 2010. On this Mac the area check says "We'll confirm your area
with you." (the map service is blocked here). **Continue →**. Step 3: a name,
`practice.metro.test@gplink-test.local`, a phone number and a role, then
**Send my details**. You should see "Check your inbox".

**P3. Intake.** In the Outbox open "Your GP is waiting: complete your
placement application" and follow its link. Complete the five steps:
   - **Where.** Press "Can't find your address? Enter it manually →" and type
     the address. Answer **"No, we are not"** in a DPA, choose when you need a
     GP, a billing style and a percentage split (for example 70).
   - **The job.** Choose full-time or part-time, then check the question
     **"Which GPs will you consider?"**: only "Vocationally registered
     Australian GPs" is ticked, and the overseas option is greyed out with an
     explanation.
   - **The pitch.** Only the practice website is required (any address).
     Press **Save this practice →**.
   - **Practices.** Press **Continue to the agreement →**.
   - **Sign.** Type a name, position, legal entity name, the ABN
     `51 824 753 556` and the practice's email, draw a signature, tick the
     box and press **Sign & submit**. You should see "Agreement signed".

**P4. Approve and publish.** As the CEO: **Practices** shows the practice
with the labels "Not in a DPA" and "Open to: VR GPs". In **Jobs**, press
**Review & approve** on the role marked "Pending approval", check the section
"Who this role is open to", scroll to the bottom and press **Review photo &
approve / reject**. Press **Upload photo**, choose any picture, then
**Approve**.

**P5. Who can see it.** A verified Australian VR doctor who has not yet been
placed should see the new role. Use the doctor from S1: as the consultant do
the register check for them (as in step 8), then as that doctor reload
Careers. There should be **four** roles, including "General Practice · Surry
Hills". `uk.doctor@gplink-test.local` should see only the Dubbo role. (The
doctor from step 9 has started work by now, so their Careers page shows their
placement instead of the list of roles.)

---

## Check nothing changed for overseas doctors (about 10 minutes)

**O1.** In a fresh Incognito window sign in as `uk.doctor@gplink-test.local`.
You land on Careers with a welcome tour: press **Next** on each sheet, then
**Find my practice**, then **Skip** on the short tour that follows.
Careers and My Documents (Account, then My Documents) should look as
they do on the live app today: MyIntealth, AMC and AHPRA steps, and the
overseas document list (Certificate of Good Standing, Confirmation of
Training, Criminal History Check).

**O2.** In a fresh Incognito window sign up a new fake doctor and answer
**No** to the first question. You should get today's wizard: "Your fastest
pathway to practising in Australia", then "Plan your move", then the country
question.

**O3. The switch off.** In the Terminal window paste:

```
AU_PATHWAY_ENABLED=false scripts/au-local/start.sh
```

Now: the website has no two doors and no "Australian GPs" item, and
`/australian-gps` shows a page headed "We couldn't load this page"; sign-up
has no first question, and choosing "Somewhere else" then Australia as the
country leads to "Not yet eligible"; the Candidates tab has no pathway filter
and no "Add candidate". This is what the live site will be like after the
change is merged and before you turn the switch on. Paste
`scripts/au-local/start.sh` to turn it back on.

---

## Start again, and clean up

These lines go in a Terminal window that has already run the `cd` line from
1.1.

- **Reset a test and try again:** paste `scripts/au-local/reset.sh`, then
  `scripts/au-local/start.sh`. This wipes the private database, the uploaded
  files and the Outbox and puts the fake starting data back. Nothing else on
  the Mac is touched. Afterwards close your Incognito windows and sign in to
  the staff pages again.
- **Stop:** paste `scripts/au-local/stop.sh`. (Ctrl+C does not stop it.)
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
   fourteen database files have been applied to the live database, which needs
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

---

## Known rough edges on the test copy

Things you will see on this Mac that are known. None stops a step.

- **The RSO sees no doctors at first (step 17).** A new placement is handed to
  the other test RSO, "Test Admin Pool (FAKE)". That is why step 17 starts by
  giving the case to "Test Rso (FAKE)".
- **The agreement shows as a grey box (steps 14 and 15).** Where the contract
  should be shown inside the page you see a grey box with a broken-page
  picture. Use "Download agreement" or "Open in a new tab" to read it.
- **"View" on a document saves a file (step 19).** It saves `document.pdf` to
  Downloads instead of opening it.
- **AI boxes show an error.** For example "AI review failed" on a contract,
  "AI returned invalid format" on a case and "AI scan unavailable" on a
  document. AI is switched off here.
- **Evening dates.** After 9pm on this Mac, today's date is refused as a start
  date or commencement date ("before the day this placement was recorded").
  Use tomorrow's date.
- **"Cleared to start" only goes between 8am and 8pm** (step 17).
- **Interview times read "GMT+8"** in both confirmation emails (step 13),
  because the practice's and the doctor's screens were both this Mac.
- **The new practice's card says "Bunbury, NSW"** on the Practices tab (step
  P4), although the practice is in Surry Hills.
- **Two links in staff and practice emails.** "Open the candidate" in the
  staff email "… applied to …" does not open on this Mac. "Turn down this
  candidate" in the introduction email opens the same page as the approve
  link; the page has both buttons.
