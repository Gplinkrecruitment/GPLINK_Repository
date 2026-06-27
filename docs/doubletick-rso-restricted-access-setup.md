# DoubleTick — restrict each RSO to their assigned GPs (+ unassigned inquiries)

**Plan required:** DoubleTick **Pro** (already active). Roles/permissions and the
Developer API are Pro-only.

## 1. Create the restricted role (once)
Settings → Manage Roles → create a **custom Channel role** named
`RSO – Assigned + Unassigned` on the GP Link WhatsApp number (+61494391968).

DoubleTick groups the toggles into a few sections. Set them as below. If your
account doesn't show a particular row (e.g. Calls or Groups aren't enabled),
just skip it — only the **Conversation** section matters for the restriction.

**Conversation Management** (this is the section that enforces the restriction):
- View Assigned Chats — **ON**
- View Unassigned Chats — **ON**     (lets RSOs answer general inquiries)
- View All Chats — **OFF**            ← the key one: hides other RSOs' GPs
- Start New Chats — **ON**            (RSO can open a chat with their own GP)
- Message Assigned Chats — **ON**
- Message Unassigned Chats — **ON**
- Message All Chats — **OFF**
- Delete Chats — **OFF**

**Templates Management:**
- View Templates — **ON**             (they need approved templates to send)
- Create Templates — **OFF**
- Delete Templates — **OFF**

**WhatsApp Group Management:** (all **OFF** unless you actively use GP groups)
- Create WhatsApp Groups — **OFF**
- View Group Details — **OFF**
- Edit Group Settings — **OFF**
- Delete WhatsApp Groups — **OFF**

**Bots Management:** (all **OFF** — automation stays owner-controlled)
- View Bot Configurations — **OFF**
- Toggle Bot Status — **OFF**
- Edit Bot Responses — **OFF**
- Delete Bot Keywords — **OFF**
- Manage Catalog Requests — **OFF**

**Call Management:** (only if WhatsApp calling is on — your call)
- Make Outgoing Calls — **ON** if RSOs should call their GPs, else **OFF**
- Receive Incoming Calls — **ON** if they should answer GP calls, else **OFF**
- Configure Call Settings — **OFF**
- View Call History — **ON** (optional)

> The restriction lives in just three of these: **View All Chats = OFF**,
> **View Assigned = ON**, **View Unassigned = ON**. Everything else is about
> what an RSO is _allowed to do_, not what they can _see_.

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
