# Setting up an RSO so meetings come from them (Calendly + Zoom)

Plain-English guide. Do this once per RSO. After it's done, everything is automatic.

## What you're trying to achieve
When you assign an RSO (e.g. Hazel) and send a meeting invite, the GP books a time and the
Zoom call, calendar event, and all reminders belong to that RSO — not the main GP Link account.

## Part A — Zoom side (each RSO connects their own Zoom, once)
1. The RSO signs in to their own Zoom account (the email you want the meetings to come from).
2. They don't need to do anything else here yet — the connection happens inside Calendly in Part B.
   (If your Calendly plan requires it, make sure the RSO has a Zoom account that can host meetings.)

## Part B — Calendly side
### One-time, done by you (the admin/owner)
1. In Calendly, go to your Team / Members area and **invite the RSO** to a seat. (You've done this for Hazel.)
2. Wait for them to **accept** the invite (Part C, step 1).
3. Create the meeting type **once** as a **Managed Event** and **share/assign it to the RSO**:
   - Calendly → Event Types → the "GP Registration Assistance" event → make it a **Managed Event**
     (Calendly Teams feature) and distribute it to your members.
   - This gives each RSO their own copy automatically. You keep control of the settings; they can't break it.

### One-time, done by the RSO (~2 minutes — only they can do this)
1. **Accept** the Calendly seat invite you sent.
2. In Calendly → **Integrations → Zoom → Connect**, and sign in to *their own* Zoom. (This is the step
   most people forget — without it the meeting won't be hosted by them.)
3. In Calendly → **Integrations → Calendar**, connect *their own* calendar (Google/Outlook).
4. Set **their own availability** (working hours) on their copy of the event.

### One-time, done by you after the RSO finishes
1. Open the RSO's copy of the "GP Registration Assistance" event and **copy its public booking link**
   (looks like `https://calendly.com/<their-name>/gp-registration-assistance`).
2. Put that link into the app against that RSO (the app uses it to route GPs to that RSO).
   - For now this is set by the dev team in the `rso_team` table (`calendly_event_url`). Send the link over
     and it gets added. (A self-service "paste link" screen in the admin can be added next.)

## Part C — How to check it's working
1. Assign the RSO on a test GP and click **Send meeting invite**, with a reason in the GP-visible box.
2. The GP gets the email (showing the reason) → books a time.
3. Confirm the Zoom meeting and reminders land in the **RSO's** Zoom and calendar, and the RSO is the host.

## Good to know
- Until an RSO's Calendly link is filled in, invites still use the main GP Link booking link (nothing breaks).
- Calendly's own confirmation/reminder emails come from Calendly but show the RSO as host. The app's own
  invite email is sent from the RSO when they use an @mygplink.com.au address (otherwise replies go to them).
- Each RSO controls their own availability in their own Calendly — you don't manage hours in the app.
