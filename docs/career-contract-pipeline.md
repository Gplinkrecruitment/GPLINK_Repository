# Career Interview → Contract → Placement Pipeline

**Status:** Live (2026-07-21). Plain-language ops note for the owner — how a GP goes from "interview accepted" to "placement secured" without anyone in our team having to chase paperwork by hand.

## The flow, in words

1. **GP accepts the practice's interview invitation.** This only books an interview — it does **not** secure a placement any more. The GP picks a time and a Zoom link is created.
2. **The interview happens.** As soon as the meeting ends, the system marks it complete.
3. **The practice gets an instant email** asking what they'd like to do: **extend an offer** (upload the employment contract) or **not proceed** (we let the doctor down gently and keep looking for other roles for them).
4. **If they extend an offer**, the practice uploads the contract on a simple web page — no login needed, the link itself is the practice's proof of identity.
5. **Our AI reads the contract** and compares it against what was actually discussed in the interview (when we have a recording of that) and against the advertised job terms, flagging anything that doesn't match — pay, sessions per week, start date, leave, restraint clauses, etc.
6. **The CEO reviews it** in the dashboard's **Contracts** tab, sees the AI's verdict, and either sends it on to the GP or sends it back to the practice with a note.
7. **The GP reviews the contract.** They can either **sign by uploading the signed copy**, or **request changes** if something isn't right.
8. **If the GP requests changes**, the CEO looks at the request and either releases it to the practice for their sign-off, or explains to the GP why the contract stands. If the practice agrees to the change, they get a fresh upload link and the loop repeats from step 4 with a new contract version.
9. **Once the GP signs**, the placement is secured automatically: the job is marked filled, other candidates for that role are notified it's no longer available, the GP gets a congratulations message, and signed copies go out to both the practice and the CEO.

If the automatic "placement secured" step ever fails for a technical reason (for example, an outage at the exact moment of signing), the signature itself is never lost — the CEO gets an alert email and can finish the placement manually from the candidate's file with one click ("Mark placement secured").

## The timing truth — with vs. without Zoom set up

**Today, Zoom is not fully connected**, so here is what actually happens right now:

- The practice's "how did the interview go?" email fires roughly **90–105 minutes after the interview's scheduled start time**, not the moment the call actually ends. This is because a background check that runs every 10 minutes is the only way we currently know the interview is over.
- The AI contract check compares the contract only against the **advertised job listing and the offer record** — there is no interview recording to check against, so any verbal changes agreed to on the call itself won't be caught automatically.

**Once Zoom credentials are added**, both of those get better automatically, with no further code changes:

- The practice's email fires **instantly**, the moment the Zoom meeting actually ends.
- The AI contract check can also read the **Zoom meeting summary** (an AI-generated recap of what was discussed on the call) and treat whatever was agreed to on the call as the deciding version — **the interview conversation overrides the original job listing** if the two disagree. Interview meetings are already configured to request this summary automatically, so no extra setup is needed there.

## What to configure to switch Zoom on

In Vercel's environment variables for this project, set:

- `ZOOM_CLIENT_ID`
- `ZOOM_CLIENT_SECRET`
- `ZOOM_ACCOUNT_ID`
- `ZOOM_WEBHOOK_SECRET`

Then, in the Zoom app's webhook settings, add this URL:

```
https://app.mygplink.com.au/api/webhooks/zoom
```

and subscribe it to two events:

- `meeting.ended`
- `meeting.summary_completed`

That's the whole switch — once those five values are set, interviews booked through the app will report back instantly and with the AI summary attached.

## The web pages practices use (no login required)

Practices act on emailed links, not by logging in. Each link contains a unique, signed token tied to one specific application or one specific contract — so a link only ever works for the thing it was sent for, and can't be reused for someone else's file.

- **Practice offer/decline page** — where the practice says "extend an offer" or "not proceeding," and (if extending) uploads the contract.
- **Practice consent page** — used only in the change-request loop, where the practice agrees or disagrees to a change the GP asked for.

## Contract statuses, in plain terms

| Status | What it means |
|---|---|
| `awaiting_upload` | We're waiting on the practice to upload a contract. |
| `uploaded` | Contract is in, AI has checked it (or is checking it), waiting on the CEO. |
| `sent_to_gp` | CEO has approved it forward — the GP can now view it, sign it, or request changes. |
| `changes_requested` | The GP asked for something to change; waiting on the CEO to triage it. |
| `practice_review` | CEO sent the requested change to the practice for their sign-off. |
| `signed` | The GP signed — placement is secured. |
| `void` | This version was superseded (either sent back for changes, or replaced by a newer upload). |

## Where the CEO acts

Everything the CEO needs to do lives in the **Contracts tab** of the CEO dashboard: see which contracts are waiting on review, read the AI's verdict (matched fine / minor gaps / major mismatches / couldn't be read), send a contract on to the GP or back to the practice, and triage any change requests the GP has raised.

## If the automatic placement step fails

This should be rare (only happens if something technical goes wrong at the exact moment the GP signs), but when it does:

- The CEO receives an alert email titled "Signed contract needs manual placement."
- The signed contract itself is never lost — only the automatic bookkeeping (marking the job filled, notifying other candidates, etc.) didn't run.
- The CEO opens the candidate's file (the "drawer") in the dashboard and clicks **Mark placement secured** to finish it manually. This takes a few seconds and completes exactly the same steps the automatic version would have.
