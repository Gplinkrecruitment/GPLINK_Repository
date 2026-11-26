# Testing the Australian GP journey yourself

A step-by-step guide for the owner. No technical knowledge needed beyond
pasting a few lines into Terminal.

**Updated 27 November 2026 for fix bundle FR-10** (the ports note in 1.1,
step 13's "AWST", A7's ten minutes and P5's register check; these edits were
not followed on screen). **Updated 26 November 2026 for fix bundle FR-9** (the test copy now starts with
the made-up Ahpra register lookup switched on: steps 6 to 9 and 11, S1 to S4b,
P5, A7 and A8 were rewritten). Steps 6 to 9 and 11, S2, S3, S3b, the S4b rows,
A7 and A8 were followed in Chrome on a separate copy of the app, with these
exceptions: the doctors were signed up through the app's own sign-up request
rather than the sign-up screen (that screen loads a script from the internet,
which the check did not allow); the S4b rows and the application in step 10
were made the same way and then looked at in Chrome; the CV was a stand-in, so
the introduction in step 11 said "We'll follow up with their CV shortly"
instead of attaching it; S1 and P5 were not followed. **Updated 25 November
2026 for fix bundle FR-7** (steps 14, 17 and 19 and the "Known rough edges"
list; the changed screens were followed in Chrome on a separate copy of the
app). **Checked 24 November 2026 against commit `9e66f27e`.** Every step in Part 1
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

When it says **Ready**, use **Chrome**.

**The ports.** This guide uses the usual addresses, `localhost:3000` for the
app and `localhost:54321` for the Outbox. If another program on this Mac is
already using port 3000, the test copy may have been started on other ports
(for example 3100 for the app and 54421 for the Outbox). To tell, look at the
lines printed under **"Ready. Open these in Chrome:"** when it started: they
show the addresses this copy really uses (FR-10: they are no longer always
3000 and 54321). Wherever this guide says `3000` or `54321`, use the numbers
from those lines instead. The app keeps running in the
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
- **The Ahpra register check uses made-up test numbers.** When a doctor types
  their registration number, the test copy "looks it up" on a made-up copy of
  the public register (nothing is asked of the real Ahpra website). The
  numbers it knows start `MED000999` and are listed under S4b. The main walk
  uses `MED0009990001`, a clean Australian-trained GP: with it the register
  check completes by itself the moment onboarding finishes. When the test copy
  starts it prints "Ahpra register lookup: ON, made-up test numbers only".
  (To see how things work with the lookup switched off, as on the live site
  today, start it with `AHPRA_LOOKUP_PROVIDER=none scripts/au-local/start.sh`;
  then staff do the check by hand, as the note under step 9 says.)
- **The area check uses a small built-in test map**, not the Government's real
  Health Workforce Locator (nothing leaves this Mac). It knows only the
  addresses in the table under "The area check" below. Any other street in
  those suburbs comes back "not confirmed", and any other suburb cannot be
  found. If the test copy was started before 26 November, stop and start it
  once so this is on.
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
   - "Where would you like to work?" Under **Where are you based?** type
     `parra`: a list drops down; choose **Parramatta NSW 2150** (you can also
     type a postcode, such as `2150`, or a town, such as `ballarat` or
     `cairns`; a small misspelling such as `paramatta` still finds it, and
     nonsense says "Nothing found. Try a nearby town or a postcode."). Then
     under **How far would you go for the right practice?** choose **Within a
     commute of where I am now (about 45 minutes)**. The other three are
     "Anywhere in my state", "Specific places" (a second search box opens;
     each place you choose becomes a small tag with an × to remove it; try
     `sydney`, which offers "Sydney (whole city)", and `regional`, which
     offers "Regional NSW" and the rest) and "Anywhere in Australia".
   - "When could you start?" Any date; notice period **4 weeks**. (It no
     longer asks where you live: that comes from the place you just chose.)
   - "Your Ahpra registration". Type `MED0009990001`, choose **Specialist
     (general practice)** and **FRACGP**, tick the box.
   - "A few details about your registration". Conditions **No**, 19AB **No**
     (the note under the question says who it usually applies to, and that
     "Not sure" is a fine answer), right to work **Australian citizen**.
   - "Does everything look right?" Check it and press NEXT.
   - "Confirm your identity". Press **SUBMIT** without uploading anything.
   - "You're all set."

   You should never see "Not yet eligible", "Plan your move" or a GMC number
   field. It should take a few minutes.

**7. First look at roles.** The last screen says **"You're all set."** (its
wording still says our team will confirm your registration; with the test
lookup on, that has in fact already happened: the Outbox has an email to the
doctor, "Your Ahpra registration is confirmed", next to "Your profile is
complete: we are lining up matches"). Press **See roles**. A welcome sheet
appears ("Welcome, Dr …"): press **See roles** again. You should see **all
three** roles straight away: the two Parramatta roles first, each with the
line "Less than 1 km from Parramatta", then Dubbo with "Outside the area you
chose · about 280 km from Parramatta". The place you chose only puts the
roles in order and adds that line; it never hides one. (Had you answered 19AB
**Yes** or **Not sure** you would see only Dubbo, the DPA one, and the line
"You are seeing roles in areas where your registration lets you work. If you
think this is wrong, message us.": try it with a second doctor.) The register
showed nothing that needs a person, but one thing still rests on your own
word: that section 19AB does not apply. You can see and apply for every role,
but a practice outside a priority area is not told about you until staff have
confirmed it (step 8). This page is **Careers**: at phone size it is the "My
Practice" button at the bottom.

**8. Staff: confirm 19AB.** In the staff window switch to
`consultant@gplink-test.local` (see 1.2). You land on **Candidates**. Find
your doctor: the row says "Australian VR" and **Can work anywhere** (no "Needs
review": the register check is already done). Click the row. On the
**Pathway** card the pill says **"Set by the automatic register lookup (no
person has checked)"**, and the box **Where they can work** says "Can work
anywhere", "Sorted from the Ahpra register lookup on …, together with the
doctor's own answer that 19AB does not apply, which nobody has checked", and
"They cannot be introduced to a practice outside a DPA until you confirm 19AB
below." The **Ahpra register check** card shows what the register lookup read
(the name on the register, "Status: Registered", the qualifications) and "The
check was completed automatically from the register lookup: everything it
read was clean. No staff member checked it." Under **Tasks on this case** there
is an open task, "Confirm 19AB with the doctor: Dr …". Now, on the Pathway
card, choose **19AB does not apply** in the "Section 19AB" box and press
**Confirm 19AB**. Press OK on the box that asks you to confirm, then type the
evidence when asked (for example "Citizen, trained in Australia") and press
OK. The box now reads "Sorted from what staff confirmed (your login)" and
"Section 19AB: Does not apply (confirmed by …)", and the "Confirm 19AB" task
is done.

**9. Doctor: still three roles.** Back as the doctor, reload Careers. You
should still see **three** roles. (To see the safety net, do steps 10 and 11
**before** step 8: "Submit to practice" on a Parramatta role answers with a
box saying staff have not confirmed whether 19AB applies, "this role is not in
a Distribution Priority Area. Confirm 19AB on the candidate's Pathway card
(Section 19AB), then submit again. Nothing was sent." On the application the
staff screen shows an amber line: "19AB not yet confirmed by staff: confirm
before introducing to this practice.")

*With the lookup off* (`AHPRA_LOOKUP_PROVIDER=none`, as on the live site
today) a person does the check instead: the row says "Australian VR ·
unconfirmed" and "Needs review"; on the **Ahpra register check** card fill in
Registration type **Specialist**, Registration expiry a date next year,
Fellowship **FRACGP**, Right to work **Australian or NZ citizen**, Supervision
shown on the register **None**, On the specialist register as a GP **Yes**,
Conditions, Undertakings and Notations **No**, Section 19AB **Does not apply**
(with the reason in the note box: it is refused without one), and press **✓
Save as verified**. The doctor is then emailed "Your Ahpra registration is
confirmed".

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
vocationally registered GP (FRACGP) based in New South Wales. GP Link has
verified Dr …'s Ahpra registration on the public register, so there is no
registration wait… available from…" (FRACGP is stated because the register's
own list shows it; a fellowship the doctor only told us about is never
stated),
with the CV attached, and should **not** say "internationally trained".

**12. The practice decides.** In that email, click the one button, "Review
Dr …" (it opens the practice's decision page, where the practice can approve
or turn down; look at it at phone size). Press **Approve & choose interview
times**. Offer two times on weekdays at least **two days from now** (tomorrow
is refused: the practice must give 48 hours' notice), choosing **morning**
times: the times you pick are on this Mac's
clock, and they must fall between 8:00 am and 7:30 pm in Sydney. (Try a
Saturday first: it should be refused with "Please pick a weekday".) Press
**Confirm times & approve candidate**.

**13. Doctor: book the interview.** As the doctor, open Careers: a sheet
"Interview invitation" appears with the times, and a line saying they are
shown in your local time. On this Mac that is this Mac's own clock (GMT+8,
the same as Perth). Tap a time and press **Confirm interview time**. You
should see "You're booked in". In the Outbox, the doctor's "Your interview is
confirmed 🎉" and the practice's "Interview confirmed, …" both give the time
followed by "AWST" (Australian Western Standard Time, the same as GMT+8),
because both screens were used on this Mac.

**14. Staff: interview done, offer made.** As the consultant, open the doctor,
scroll to Applications and press **Mark interview finished**, then OK. In the
Outbox open the email to the practice "How did the interview with Dr … go?",
click its **Extend an offer** link, press **Extend an offer**, choose any PDF
as the contract and press **Send contract for review**. Then switch to
`ceo@gplink-test.local`, open the CEO dashboard and the **Contracts** tab,
click the contract and press **Submit to GP**. A form headed **Sessions a
week** opens in the page: type **8** and press **Send**. (Pressing Send with
nothing typed is refused; "Not known yet" is a box you tick on purpose.) The
contract should now say "Sent to GP".

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
   should now be complete. The doctor's "You are cleared to start on …" email
   is sent as soon as the RSO's last item (the credentialing pack) is done,
   so it may already be in the Outbox before the consultant's two tasks.
   Between 8am and 8pm it goes at once; outside those hours it is held until
   the morning, and the staff screen says when it will send.

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
Documents**. On a document, **View** opens it in a new tab and **Download**
saves it under its own file name.

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
password and goes straight into the Australian onboarding (no first
question). Finish the onboarding as in step 6 (number `MED0009990001` again:
the made-up register prints whatever name the doctor signed up with). You will
use this doctor again in P5.

**S2. A doctor with restrictions (segment B).** In a fresh Incognito window
sign up another fake doctor and in onboarding type `MED0009990001`, choose
**Specialist (general practice)** and **FRACGP** as before, but answer 19AB
**Yes** and right to work **Temporary resident**. They are not held: they
finish onboarding with "You're all set." and on Careers see **only Dubbo** (a
priority-area role whose practice offers sponsorship), with the line "You are
seeing roles in areas where your registration lets you work. If you think this
is wrong, message us." They can apply for it. As staff you should see them
labelled "Australian restricted · unconfirmed" and **Priority areas only
(DPA)**; inside, the box **Where they can work** says "Temporary resident:
restricted until staff confirm otherwise. Sorted from the Ahpra register
lookup on …, and the doctor's own answers.", with a flag that a temporary
resident needs the new practice to sponsor them. The register check task is
already closed (the lookup completed it).

**S3. A non-VR doctor (segment C).** Sign up another, typing `MED0009990007`
(a made-up number with general registration only) and choosing **General**
registration and **No fellowship** (leave 19AB as No). They are held exactly
as before: the finish screen says **"Thanks, we have your details."**,
Careers shows that card and no roles, and they cannot apply. Staff see
"Non-VR · unconfirmed", "Needs review", **Non-VR: held**, the register check
task still open (a person decides), and a task to decide the segment.

**S3b. A GP registrar.** Sign up another, typing `MED0009990007`, choosing
**General** registration and **I am a GP registrar (in training)** as the
fellowship. The finish screen, Careers and their home page
all say **"We place fully qualified GPs"**: "GP Link works with GPs who hold
fellowship (FRACGP or FACRRM) or are otherwise fully qualified to practise
independently. We can't place GP registrars at the moment. Once you have your
fellowship, sign in again and update your details and we will take it from
there." with a **Message us** button. No roles, and they cannot apply. In the
Outbox their email is "Your GP Link profile: we place fully qualified GPs".
As staff: labelled "Registrar · unconfirmed" and **Registrar: not placed**,
with **no** task raised for them (the timeline says "Signed up as a GP
registrar"). If the registrar later changes their registration type or
fellowship in Account, nothing changes for them, but a task appears for staff
to check the register: that is their way out.

**S4. Filters.** In Candidates use the pathway filter (All pathways, Overseas,
Australian VR, Australian restricted, Non-VR, Registrar, Needs review, and the
five new ones: Can work anywhere, Priority areas only (DPA), Registrar: not
placed, Non-VR: held, Needs a person).

**S4b. The Ahpra register lookup, number by number.** The test copy starts
with it on ("Ahpra register lookup: ON, made-up test numbers only"). Nothing
is ever asked of the real Ahpra website from the test copy: these made-up
numbers are answered from made-up pages, and each one prints the name the
doctor signed up with (except `MED0009990004`, which belongs to "somebody
else"). Sign up a doctor for each line you want to see, typing the number in
the "Your Ahpra registration" screen (Specialist (general practice), FRACGP,
Conditions No, right to work Australian citizen, 19AB as shown). The lookup
has already run when the finish screen appears; then open the doctor as
staff.

| Type this number | 19AB answer | What you should see |
| --- | --- | --- |
| `MED0009990001` | No | **Can work anywhere.** All three roles. The Ahpra check card says it "was completed automatically from the register lookup" (nobody had to check), the check task is closed, the doctor is emailed "Your Ahpra registration is confirmed", and there is an open task "Confirm 19AB with the doctor" (step 8). |
| `MED0009990001` | Not sure | **Priority areas only (DPA).** Dubbo only. The check still completes by itself, and a "Confirm 19AB with the doctor" task asks staff to find out. |
| `MED0009990002` (modelled on the real example: Expedited Specialist pathway, first registered 18 December 2025, supervision, approved locations) | Yes, and Conditions **Yes** | **Priority areas only (DPA)**: "Trained outside Australia and New Zealand, first registered 2025-12-18: restricted until 2035-12-18, or until staff confirm an exemption." Dubbo only. The check completes by itself, and staff see three flags: "Supervision required: Indirect 2", "Registration is tied to approved practice locations: a move needs a new Board approval for the new practice" and "The ten years from first registration end on 2035-12-18." The doctor is never shown any of that wording. |
| `MED0009990008` (trained in the UK, first registered 2014) | No | **Can work anywhere** (the ten years have passed). A "Confirm 19AB with the doctor" task is open, because being a citizen rests on their word. |
| `MED0009990003` | No | **Not found.** The finish screen and Careers say "Thanks, we have your details" with no roles; staff see **On hold: needs a person** and **Needs a person**, and the check task stays open. |
| `MED0009990004` | No | **A number that belongs to somebody else.** The same hold; the check card warns that the name on the register does NOT match, and nothing is filled in. |
| `MED0009990006` | No | **A reprimand.** Not completed automatically: "Why a person is needed" lists it, the doctor sees Dubbo only until a person saves the check, and that stays so even if the lookup is later switched off. |
| `MED0009990005` | No | **A condition that is not the standard supervised-practice set.** The same as the line above. |
| `MED0009990007` | No | **General registration only.** Held as non-VR ("Thanks, we have your details"); staff are told the doctor said VR but the register does not show it. |
| `MED0009990012` | No | **The lookup fails.** Nothing changes for the doctor (all three roles); the check task stays open for a person and the card says the last lookup could not be completed and that it will be tried again automatically. |

On any doctor's Ahpra check card, **Look up on the register** runs it again.
A new lookup never lifts a hold by itself: only a person saving the check
does.
A registrar (S3b) and a non-VR doctor (S3) are in their groups whatever the
register says. The rule and its limits are in `ahpra-register-lookup.md`.

**S5. The staff guide.** As the CEO, open the CEO dashboard. A box "Needs your
review" now pops up because of the doctors waiting on a person: press **Remind me
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
with you." (Surry Hills is not in the small test map this Mac uses).
**Continue →**. Step 3: a name,
`practice.metro.test@gplink-test.local`, a phone number and a role, then
**Send my details**. You should see "Check your inbox".

**P3. Intake.** In the Outbox open "Your GP is waiting: complete your
placement application" and follow its link. Complete the five steps:
   - **Where.** Press "Can't find your address? Enter it manually →" and type
     the address. **You are not asked whether you are in a DPA.** Under
     "Distribution Priority Area (DPA)" the form says "We look this up from
     your address", and a moment after you finish typing it shows what it
     found. For a Surry Hills address on this Mac that is "We'll confirm your
     area with you" (the address is not in the test map), with a small link,
     "This looks wrong". Choose when you need a GP, a billing style and a
     percentage split (for example 70).
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
with the labels "DPA not confirmed" and "Open to: VR GPs". In **Jobs**, press
**Review & approve** on the role marked "Pending approval", check the section
"Who this role is open to" (it starts with "Area labels on this role"), scroll
to the bottom and press **Review photo & approve / reject**. Press **Upload
photo**, choose any picture, then **Approve**. Because the area is not
confirmed you are asked "Approve anyway?": press OK.

**P5. Who can see it.** A verified Australian VR doctor who has not yet been
placed should see the new role. Use the doctor from S1. **No register lookup
runs for a doctor that staff added** (corrected 27 November 2026, FR-10), so
their Ahpra register check is still open for staff: the Candidates row says
**Needs review**. As the consultant, open the doctor, fill in the **Ahpra
register check** card with what the register shows for `MED0009990001`
(specialist registration, general practice, no conditions, undertakings or
notations) and save it as verified; then on the **Pathway** card confirm
19AB "does not apply" with a reason, as in step 8. Then, as that doctor,
reload Careers. What to expect on a **freshly reset** test copy, once you have
done P1 to P4: **four** roles, the two Parramatta roles, Dubbo, and the new
"General Practice · Surry Hills". `uk.doctor@gplink-test.local` should see
only the one Dubbo role (the Surry Hills practice is not in a priority area;
the second Dubbo role is added later, in A6). If the copy has been used for
other testing since it was reset, there may be more roles: that is expected.
(The doctor from step 9 has started work by now, so their Careers page shows
their placement instead of the list of roles.)

---

## The area check (about 10 minutes)

This is the part that looks a practice's address up instead of asking the
practice (WP-30). The full explanation is `docs/au-gp/workforce-locator.md`.
When the test copy starts it prints "Area look-up (WP-30): test data (no
network)".

The test map knows these addresses and nothing else:

| Type this | The answer |
| --- | --- |
| `14 Example Street` or `2 Test Road`, Dubbo, NSW, 2830 | In a DPA · Modified Monash 3 |
| `30 Sample Avenue` or `1 Test Street`, Parramatta, NSW, 2150 | Not in a DPA · Modified Monash 1 |
| `5 Sample Road`, Tennant Creek, NT, 0860 | In a DPA · Modified Monash 7 |
| any other street in those three suburbs | "We'll confirm your area with you" (only the suburb is known) |

**A1. A practice with an exact address.** On
http://site.localhost:3000/employers fill in "Tell us what your practice
needs" for **Test Area Practice (FAKE)**, Dubbo, NSW, 2830 and
`practice.area.test@gplink-test.local`. The area check on that page says
"Good news, you're in a Distribution Priority Area" (that is what the suburb
suggests; it is not recorded as a yes). Open the intake link from the Outbox.
On the first step press "Can't find your address? Enter it manually →" and
type `14 Example Street`, `Dubbo`, `2830`, state NSW. After a moment the form
shows **"Your practice is in a Distribution Priority Area for GPs · Modified
Monash 3"**. There are no Yes / No buttons.

**A2. An address that is not exact.** Change the street to `Dubbo Medical
Centre`. The form now shows **"We'll confirm your area with you"**. Press
**This looks wrong**, type a note and press **Send to the GP Link team**: it
thanks you, and what is shown does not change. Change the street back to
`14 Example Street` and finish the form as in step P3 (sign it too).

**A3. What staff see.** As the CEO open **Practices**. The practice card
shows "In a DPA" and "Large rural town (MM 3)". Open it. The card "Area:
priority area and remoteness" shows the status, the Modified Monash level, "Set
by: Automatic check", "Exact (street address)", the source ("Test data (not
the real locator)" on this Mac), the date, the address that was checked, and
the note you sent in A2 in a red box. Under "Roles at this practice" the new
role shows the same labels and "Follows the practice". Press **Re-check**: a
message says "Checked: no change."

**A4. Set it by hand, and a disagreement.** Press **Set by hand…**, choose
"No, not in a DPA", leave the reason empty and press **Save**: it is refused.
Type a reason and save. The status becomes "Not in a DPA", "Set by hand by
ceo@gplink-test.local", and a red box says the automatic check and the value
set by hand disagree, with both answers and both dates. The role underneath
now says "Not in a DPA" and its title starts "Non-DPA". Press **Re-check**:
"the automatic answer differs from the value set by hand. Nothing was
changed." Press **Remove the value set by hand** and confirm: everything goes
back to "In a DPA".

**A5. Correct an address.** Press **Correct the address…**, type
`30 Sample Avenue`, `Parramatta`, NSW, `2150` and press **Save and check**. The
practice and its role become "Not in a DPA · Metropolitan (MM 1)". Correct it
back to `14 Example Street`, Dubbo, NSW, 2830.

**A6. The job.** In **Jobs** press **Review & approve** on the new role. Under
"Who this role is open to" the box "Area labels on this role" shows the same
labels and where they came from. At the bottom press **Review photo & approve
/ reject**: the labels are shown above the photo. Upload any picture and
approve.

**A7. Who sees it.** Sign in as `uk.doctor@gplink-test.local` (the seeded
overseas doctor from the UK; like every overseas doctor, they may only work in
a priority area) and open Careers: there is a second Dubbo role. As the CEO,
on the practice press **Set by hand…**, choose "Not confirmed", give a reason
and save. Now open a **fresh Incognito window**, sign in as the UK doctor
again and open Careers: the new role is no longer offered. (A window that was
already signed in can keep showing the list it had for **about ten minutes**
(the round-13 review measured about eleven), even if you reload: that is
expected and is not this change, so always look in a **fresh Incognito
window**. Opening the role always asks the server.) Remove the value set by
hand and the role comes back (again, look in a fresh Incognito window).

**A8. Check all practices.** As the CEO, at the top of **Practices**, press
**Check all practices** and confirm. After a few seconds a summary appears, for
example, on a fresh test copy: "Finished. 2 practices checked: 2 changed, 0
unchanged, 0 not confident, 0 disagreed with a value set by hand, 0 could not
be checked. Roles: 0 updated, 0 need a decision, 0 set by hand and left
alone." A practice that had never been checked automatically counts as
"changed" the first time, so the numbers depend on what you did before. Press
it again: now every practice is "unchanged".

**A9. With the area check off.** Stop the test copy and start it with
`AU_WORKFORCE_LOCATOR_PROVIDER=none scripts/au-local/start.sh`. Open an intake
link: the form asks "Yes, we are in a DPA / No, we are not / Not sure" as it
did before, and the staff screens have no "Area" card and no "Check all
practices" button. Stop and start it normally to turn the check back on.

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
  the default RSO for new cases, here "Test Admin Pool (FAKE)". That is why
  step 17 starts by giving the case to "Test Rso (FAKE)". The app now says so:
  the CEO is emailed "Pre-start for Dr … is with Test Admin Pool (FAKE)" (see
  the Outbox), the case timeline names the RSO, and an RSO with no doctors
  sees an explanation instead of an empty list.
- **The agreement shows as a grey box (steps 14 and 15).** Where the contract
  should be shown inside the page you see a grey box with a broken-page
  picture. Use "Download agreement" or "Open in a new tab" to read it.
- **AI boxes show an error.** For example "AI review failed" on a contract,
  "AI returned invalid format" on a case and "AI scan unavailable" on a
  document. AI is switched off here.
- **Evening dates.** Dates follow the practice's clock (Sydney for the test
  practices). After 9pm on this Mac, Sydney is already on tomorrow, so today's
  date is refused as a start date or commencement date. The date boxes now
  start at the earliest date allowed and a line under them says whose clock
  is used; a refusal names the earliest date you can enter.
- **Messages to a doctor only go between 8am and 8pm on their clock** (step
  17: the start date email and "cleared to start"). If you save outside
  those hours, a yellow line at the top of the screen says the message has
  not gone yet and when it will. That time is the next morning run: about
  11am Sydney time in summer (10am in winter), 8am in Perth.
- **Interview times read "AWST"** (Perth time) in both confirmation emails
  (step 13), because the practice's and the doctor's screens were both this Mac.
- **The new practice's card says "Bunbury, NSW"** on the Practices tab (step
  P4), although the practice is in Surry Hills.
- **The introduction email has one button** for an Australian doctor:
  "Review Dr …" (approve and choose interview times, or turn down, on the page
  it opens). "Open the candidate" in staff emails opens on this Mac once the
  test copy has been stopped and started again.
