# DoubleTick — restrict each RSO to their assigned GPs (+ unassigned inquiries)

**Plan required:** DoubleTick **Pro** (already active). Roles/permissions and the
Developer API are Pro-only.

## 1. Create the restricted role (once)
Settings → Manage Roles → create a **custom Channel role** named
`RSO – Assigned + Unassigned` on the GP Link WhatsApp number (+61494391968):

- View Assigned Chats — **ON**
- View Unassigned Chats — **ON**   (lets RSOs answer general inquiries)
- View All Chats — **OFF**          (hides other RSOs' GPs)
- Message Assigned Chats — **ON**
- Message Unassigned Chats — **ON**
- Start New Chats — **ON**
- Message All Chats — **OFF**, Delete Chats — **OFF**

Organization role: a non-admin "Team Member" (no invite/remove/settings powers).

## 2. Invite each RSO (per RSO)
Teams → Invite members → enter the RSO's **name + WhatsApp phone number** →
pick the org role + the `RSO – Assigned + Unassigned` channel role → Invite.
The RSO accepts on WhatsApp and logs in **with that exact phone number**.

## 3. Record each RSO's phone in GP Link
The app routes chats by matching the GP's assigned RSO to that RSO's phone in the
`rso_team` table. For every active RSO, make sure `rso_team.phone` holds the **same
WhatsApp number** they were invited with (E.164, e.g. +61406281243). RSOs with a
blank phone (owner/archive) are skipped by design — they see everything anyway.

## 4. How it stays in sync (automatic)
Whenever you set/change a GP's assigned RSO in the GP Link dashboard, the app calls
DoubleTick to assign that GP's chat to that RSO. New/unassigned GPs stay visible to
all RSOs until someone picks them up (first responder owns it). Non-GP inbound that
nobody owns is also visible to all RSOs — claim it yourself (assign to you, the
Owner) to hide it. This is the accepted v1 behaviour.

## 5. Verify
- Assign a test GP to RSO-A → confirm only RSO-A sees that chat.
- Confirm RSO-A also sees an unassigned chat, and RSO-B does NOT see RSO-A's GP.
- Reassign the GP to RSO-B → confirm the chat moves.
