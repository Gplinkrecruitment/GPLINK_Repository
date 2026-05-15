# Nudge Chat System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone nudge chat system — completely separate from support tickets — where admin-sent nudges open an active chat thread that the GP can reply to in-app, and the admin can manage and close.

**Architecture:** Nudge chats live in the existing `user_nudges` table (as the chat entity) with a new `nudge_chat_messages` table for thread messages. The user sees a new "Chats" tab on `messages.html`. The admin sees and replies to chats via a modal in `admin.html`. The email CTA links directly into the specific chat. DoubleTick WhatsApp sends the nudge text; WhatsApp replies flow through the existing DoubleTick webhook and get attached to the nudge chat thread.

**Tech Stack:** Vanilla JS, Node.js (server.js), Supabase (PostgreSQL), Resend (email), DoubleTick (WhatsApp)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/20260516000000_nudge_chat_messages.sql` | Create | New table + ALTER user_nudges status constraint to add 'active','closed' |
| `server.js` | Modify | 6 new API endpoints for nudge chat CRUD + modify existing nudge endpoint |
| `pages/messages.html` | Modify | Add "Chats" tab, chat list view, chat thread slide-over with reply input |
| `pages/admin.html` | Modify | Add nudge chat thread modal with reply + close buttons |
| `js/updates-sync.js` | Modify | Update nudge click handler to open chat in messages page instead of ticket form |

---

### Task 1: Database Migration — nudge_chat_messages table + status update

**Files:**
- Create: `supabase/migrations/20260516000000_nudge_chat_messages.sql`

This migration does two things:
1. Adds 'active' and 'closed' to the `user_nudges.status` CHECK constraint
2. Creates `nudge_chat_messages` table for chat thread messages

- [ ] **Step 1: Create the migration file**

```sql
-- ══════════════════════════════════════════════
-- Nudge Chat Messages + Status Extension
-- ══════════════════════════════════════════════

-- 1. Extend user_nudges status to support chat states
ALTER TABLE user_nudges DROP CONSTRAINT IF EXISTS user_nudges_status_check;
ALTER TABLE user_nudges ADD CONSTRAINT user_nudges_status_check
  CHECK (status IN ('pending','delivered','read','dismissed','active','closed'));

-- 2. Nudge chat messages — threaded replies for each nudge
CREATE TABLE IF NOT EXISTS nudge_chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nudge_id UUID NOT NULL REFERENCES user_nudges(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('admin','user')),
  sender_email TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nudge_chat_messages_nudge ON nudge_chat_messages(nudge_id, created_at ASC);

ALTER TABLE nudge_chat_messages ENABLE ROW LEVEL SECURITY;

-- Users can read messages on their own nudges
CREATE POLICY nudge_chat_messages_select_own ON nudge_chat_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_nudges WHERE user_nudges.id = nudge_chat_messages.nudge_id AND user_nudges.user_id = auth.uid())
  );

-- Users can insert messages on their own nudges (sender_type='user' only)
CREATE POLICY nudge_chat_messages_insert_own ON nudge_chat_messages
  FOR INSERT WITH CHECK (
    sender_type = 'user' AND
    EXISTS (SELECT 1 FROM user_nudges WHERE user_nudges.id = nudge_chat_messages.nudge_id AND user_nudges.user_id = auth.uid())
  );

-- Service role full access
CREATE POLICY nudge_chat_messages_service_all ON nudge_chat_messages
  FOR ALL USING (auth.role() = 'service_role');
```

Write this to `supabase/migrations/20260516000000_nudge_chat_messages.sql`.

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260516000000_nudge_chat_messages.sql
git commit -m "feat: add nudge_chat_messages table + extend user_nudges status for chat"
```

---

### Task 2: Server — Modify Nudge Send Endpoint to Create Chat

**Files:**
- Modify: `server.js` — the `/api/admin/va/nudge` POST handler (around line 23744)

When a nudge is sent, it should now:
1. Set status to `'active'` instead of `'pending'`
2. Insert the nudge message as the first `nudge_chat_messages` row (sender_type='admin')
3. Update the email CTA URL to point to the specific chat: `/pages/messages.html#chat-{nudge_id}`

- [ ] **Step 1: Change status from 'pending' to 'active' in the insert**

In `server.js`, in the `/api/admin/va/nudge` POST handler, find the `supabaseDbRequest('user_nudges', '', { method: 'POST' ...` block. Change `status: 'pending'` to `status: 'active'`.

The exact old code:

```js
      body: [{
        user_id: targetUserId,
        case_id: regCase ? regCase.id : null,
        stage: stage,
        substage: substage,
        title: title,
        message: message,
        whatsapp_number: HAZEL_WHATSAPP_NUMBER,
        delivered_channels: channels,
        status: 'pending',
        created_by: adminCtx.email
      }]
```

Replace `status: 'pending'` with `status: 'active'`.

- [ ] **Step 2: Insert initial chat message after nudge creation**

After the line `const nudge = insertRes.ok && ...` and the null check, add:

```js
    // Create the initial chat message from admin
    if (nudge && nudge.id) {
      await supabaseDbRequest('nudge_chat_messages', '', {
        method: 'POST',
        body: [{
          nudge_id: nudge.id,
          sender_type: 'admin',
          sender_email: adminCtx.email,
          message: message
        }]
      });
    }
```

- [ ] **Step 3: Update email CTA to link to specific chat**

In the same handler, find the `nudgeReplyUrl` line:

```js
      const nudgeReplyUrl = APP_BASE_URL + '/pages/messages.html#tab-action';
```

Move this line AFTER the nudge is created (after the `if (!nudge)` early return), and change it to:

```js
      const nudgeReplyUrl = APP_BASE_URL + '/pages/messages.html#chat-' + encodeURIComponent(nudge.id);
```

This means the email block needs to move after the insert. Restructure so the email is sent AFTER the nudge row exists (it already is, just update the URL).

- [ ] **Step 4: Update response to include nudge id for the frontend**

The response line already includes `nudge: nudge` which has the id. No change needed here — just verify.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: nudge creates active chat with initial message + email links to chat"
```

---

### Task 3: Server — User-Facing Nudge Chat API Endpoints

**Files:**
- Modify: `server.js` — add 3 new endpoints near the existing user nudge endpoints (around line 24946)

Three endpoints:
1. `GET /api/user/nudge-chats` — list user's active/closed nudge chats with last message preview
2. `GET /api/user/nudge-chats/:id` — get a specific chat with all messages
3. `POST /api/user/nudge-chats/:id/reply` — user sends a reply

- [ ] **Step 1: Add GET /api/user/nudge-chats endpoint**

Insert BEFORE the existing `// ── List my nudges (unread first) ──` block (line ~24946). Add:

```js
  // ══════ Nudge Chat endpoints (user-facing) ══════

  // ── List my nudge chats ──
  if (pathname === '/api/user/nudge-chats' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    if (!isSupabaseDbConfigured()) { sendJson(res, 200, { ok: true, chats: [] }); return; }
    const userId = session.user_id;
    if (!userId) { sendJson(res, 200, { ok: true, chats: [] }); return; }
    const r = await supabaseDbRequest('user_nudges',
      'select=*&user_id=eq.' + encodeURIComponent(userId) + '&status=in.(active,closed)&order=created_at.desc&limit=50');
    const chats = r.ok && Array.isArray(r.data) ? r.data : [];
    // Fetch last message for each chat
    for (const chat of chats) {
      const mr = await supabaseDbRequest('nudge_chat_messages',
        'select=*&nudge_id=eq.' + encodeURIComponent(chat.id) + '&order=created_at.desc&limit=1');
      chat.last_message = mr.ok && Array.isArray(mr.data) && mr.data[0] ? mr.data[0] : null;
      // Count unread (admin messages after last user message)
      const allMr = await supabaseDbRequest('nudge_chat_messages',
        'select=id,sender_type,created_at&nudge_id=eq.' + encodeURIComponent(chat.id) + '&order=created_at.desc');
      const allMsgs = allMr.ok && Array.isArray(allMr.data) ? allMr.data : [];
      const lastUserMsg = allMsgs.find(m => m.sender_type === 'user');
      const cutoff = lastUserMsg ? lastUserMsg.created_at : '1970-01-01';
      chat.unread_count = allMsgs.filter(m => m.sender_type === 'admin' && m.created_at > cutoff).length;
    }
    sendJson(res, 200, { ok: true, chats: chats });
    return;
  }

  // ── Get nudge chat thread ──
  const nudgeChatMatch = pathname.match(/^\/api\/user\/nudge-chats\/([^/]+)$/);
  if (nudgeChatMatch && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    if (!isSupabaseDbConfigured()) { sendJson(res, 404, { ok: false, message: 'Not found.' }); return; }
    const userId = session.user_id;
    const chatId = decodeURIComponent(nudgeChatMatch[1] || '');
    if (!chatId || !userId) { sendJson(res, 400, { ok: false, message: 'Invalid.' }); return; }
    // Fetch the nudge (must belong to this user)
    const nr = await supabaseDbRequest('user_nudges',
      'select=*&id=eq.' + encodeURIComponent(chatId) + '&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const chat = nr.ok && Array.isArray(nr.data) && nr.data[0] ? nr.data[0] : null;
    if (!chat) { sendJson(res, 404, { ok: false, message: 'Chat not found.' }); return; }
    // Fetch all messages
    const mr = await supabaseDbRequest('nudge_chat_messages',
      'select=*&nudge_id=eq.' + encodeURIComponent(chatId) + '&order=created_at.asc');
    const messages = mr.ok && Array.isArray(mr.data) ? mr.data : [];
    sendJson(res, 200, { ok: true, chat: chat, messages: messages });
    return;
  }

  // ── User replies to nudge chat ──
  const nudgeChatReplyMatch = pathname.match(/^\/api\/user\/nudge-chats\/([^/]+)\/reply$/);
  if (nudgeChatReplyMatch && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const userId = session.user_id;
    const chatId = decodeURIComponent(nudgeChatReplyMatch[1] || '');
    if (!chatId || !userId) { sendJson(res, 400, { ok: false, message: 'Invalid.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const text = sanitizeUserString(body && body.message, 2000);
    if (!text) { sendJson(res, 400, { ok: false, message: 'Message required.' }); return; }
    // Verify chat belongs to user and is active
    const nr = await supabaseDbRequest('user_nudges',
      'select=id,status,user_id&id=eq.' + encodeURIComponent(chatId) + '&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const chat = nr.ok && Array.isArray(nr.data) && nr.data[0] ? nr.data[0] : null;
    if (!chat) { sendJson(res, 404, { ok: false, message: 'Chat not found.' }); return; }
    if (chat.status === 'closed') { sendJson(res, 400, { ok: false, message: 'This chat has been closed.' }); return; }
    // Get user email for sender_email
    const email = getSessionEmail(session) || '';
    // Insert the message
    const ir = await supabaseDbRequest('nudge_chat_messages', '', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [{ nudge_id: chatId, sender_type: 'user', sender_email: email, message: text }]
    });
    const msg = ir.ok && Array.isArray(ir.data) && ir.data[0] ? ir.data[0] : null;
    if (!msg) { sendJson(res, 502, { ok: false, message: 'Failed to send reply.' }); return; }
    sendJson(res, 200, { ok: true, message: msg });
    return;
  }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add user-facing nudge chat API endpoints (list, get, reply)"
```

---

### Task 4: Server — Admin-Facing Nudge Chat API Endpoints

**Files:**
- Modify: `server.js` — add 3 new endpoints near the existing admin nudge endpoint (around line 23805)

Three endpoints:
1. `GET /api/admin/va/nudge-chats` — list all active nudge chats with GP names
2. `POST /api/admin/va/nudge-chats/:id/reply` — admin sends a reply in the chat
3. `PUT /api/admin/va/nudge-chats/:id/close` — admin closes the chat

- [ ] **Step 1: Add admin nudge chat endpoints**

Insert after the existing `/api/admin/va/nudge` POST handler's `return;` (line ~23804). Add:

```js
  // ── List active nudge chats (admin) ──
  if (pathname === '/api/admin/va/nudge-chats' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const r = await supabaseDbRequest('user_nudges',
      'select=*&status=in.(active,closed)&order=created_at.desc&limit=100');
    const chats = r.ok && Array.isArray(r.data) ? r.data : [];
    // Enrich with GP names and last message
    const userIds = [...new Set(chats.map(c => c.user_id).filter(Boolean))];
    let profileMap = {};
    if (userIds.length > 0) {
      const pr = await supabaseDbRequest('user_profiles',
        'select=user_id,first_name,last_name,email&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')');
      if (pr.ok && Array.isArray(pr.data)) {
        pr.data.forEach(p => { profileMap[p.user_id] = p; });
      }
    }
    for (const chat of chats) {
      const p = profileMap[chat.user_id] || {};
      chat.gp_name = ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || 'Unknown GP';
      chat.gp_email = p.email || '';
      // Last message + unread count (messages from user since last admin reply)
      const mr = await supabaseDbRequest('nudge_chat_messages',
        'select=*&nudge_id=eq.' + encodeURIComponent(chat.id) + '&order=created_at.desc&limit=1');
      chat.last_message = mr.ok && Array.isArray(mr.data) && mr.data[0] ? mr.data[0] : null;
      const allMr = await supabaseDbRequest('nudge_chat_messages',
        'select=id,sender_type,created_at&nudge_id=eq.' + encodeURIComponent(chat.id) + '&order=created_at.desc');
      const allMsgs = allMr.ok && Array.isArray(allMr.data) ? allMr.data : [];
      const lastAdminMsg = allMsgs.find(m => m.sender_type === 'admin');
      const cutoff = lastAdminMsg ? lastAdminMsg.created_at : '1970-01-01';
      chat.unread_count = allMsgs.filter(m => m.sender_type === 'user' && m.created_at > cutoff).length;
    }
    sendJson(res, 200, { ok: true, chats: chats });
    return;
  }

  // ── Get nudge chat thread (admin) ──
  const adminNudgeChatGetMatch = pathname.match(/^\/api\/admin\/va\/nudge-chats\/([^/]+)$/);
  if (adminNudgeChatGetMatch && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const chatId = decodeURIComponent(adminNudgeChatGetMatch[1] || '');
    if (!chatId) { sendJson(res, 400, { ok: false, message: 'Invalid.' }); return; }
    const nr = await supabaseDbRequest('user_nudges', 'select=*&id=eq.' + encodeURIComponent(chatId) + '&limit=1');
    const chat = nr.ok && Array.isArray(nr.data) && nr.data[0] ? nr.data[0] : null;
    if (!chat) { sendJson(res, 404, { ok: false, message: 'Chat not found.' }); return; }
    const mr = await supabaseDbRequest('nudge_chat_messages',
      'select=*&nudge_id=eq.' + encodeURIComponent(chatId) + '&order=created_at.asc');
    const messages = mr.ok && Array.isArray(mr.data) ? mr.data : [];
    // GP profile
    const pr = await supabaseDbRequest('user_profiles',
      'select=first_name,last_name,email&user_id=eq.' + encodeURIComponent(chat.user_id) + '&limit=1');
    const profile = pr.ok && Array.isArray(pr.data) && pr.data[0] ? pr.data[0] : {};
    chat.gp_name = ((profile.first_name || '') + ' ' + (profile.last_name || '')).trim() || 'Unknown GP';
    chat.gp_email = profile.email || '';
    sendJson(res, 200, { ok: true, chat: chat, messages: messages });
    return;
  }

  // ── Admin replies to nudge chat ──
  const adminNudgeChatReplyMatch = pathname.match(/^\/api\/admin\/va\/nudge-chats\/([^/]+)\/reply$/);
  if (adminNudgeChatReplyMatch && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const chatId = decodeURIComponent(adminNudgeChatReplyMatch[1] || '');
    if (!chatId) { sendJson(res, 400, { ok: false, message: 'Invalid.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const text = sanitizeUserString(body && body.message, 2000);
    if (!text) { sendJson(res, 400, { ok: false, message: 'Message required.' }); return; }
    // Verify chat exists
    const nr = await supabaseDbRequest('user_nudges', 'select=id,status,user_id&id=eq.' + encodeURIComponent(chatId) + '&limit=1');
    const chat = nr.ok && Array.isArray(nr.data) && nr.data[0] ? nr.data[0] : null;
    if (!chat) { sendJson(res, 404, { ok: false, message: 'Chat not found.' }); return; }
    // Reopen if closed
    if (chat.status === 'closed') {
      await supabaseDbRequest('user_nudges', 'id=eq.' + encodeURIComponent(chatId), { method: 'PATCH', body: { status: 'active' } });
    }
    const ir = await supabaseDbRequest('nudge_chat_messages', '', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [{ nudge_id: chatId, sender_type: 'admin', sender_email: adminCtx.email, message: text }]
    });
    const msg = ir.ok && Array.isArray(ir.data) && ir.data[0] ? ir.data[0] : null;
    if (!msg) { sendJson(res, 502, { ok: false, message: 'Failed.' }); return; }
    // Send email notification to GP
    const pr = await supabaseDbRequest('user_profiles',
      'select=email,first_name&user_id=eq.' + encodeURIComponent(chat.user_id) + '&limit=1');
    const gpProfile = pr.ok && Array.isArray(pr.data) && pr.data[0] ? pr.data[0] : {};
    if (gpProfile.email && isEmailConfigured()) {
      const chatUrl = APP_BASE_URL + '/pages/messages.html#chat-' + encodeURIComponent(chatId);
      await sendEmail({
        to: gpProfile.email,
        subject: 'New message from GP Link',
        html: buildCareerEmailHtml({
          title: 'New message from GP Link',
          body: text,
          ctaText: 'View & Reply',
          ctaUrl: chatUrl,
          footer: 'You have a new message in your GP Link chat. Click above to view and reply.'
        })
      }).catch(() => {});
    }
    sendJson(res, 200, { ok: true, message: msg });
    return;
  }

  // ── Admin closes nudge chat ──
  const adminNudgeChatCloseMatch = pathname.match(/^\/api\/admin\/va\/nudge-chats\/([^/]+)\/close$/);
  if (adminNudgeChatCloseMatch && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const chatId = decodeURIComponent(adminNudgeChatCloseMatch[1] || '');
    if (!chatId) { sendJson(res, 400, { ok: false, message: 'Invalid.' }); return; }
    const ur = await supabaseDbRequest('user_nudges', 'id=eq.' + encodeURIComponent(chatId), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: { status: 'closed' }
    });
    const updated = ur.ok && Array.isArray(ur.data) && ur.data[0] ? ur.data[0] : null;
    if (!updated) { sendJson(res, 404, { ok: false, message: 'Chat not found.' }); return; }
    sendJson(res, 200, { ok: true, chat: updated });
    return;
  }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add admin nudge chat API endpoints (list, get, reply, close)"
```

---

### Task 5: User UI — Add Chats Tab to messages.html

**Files:**
- Modify: `pages/messages.html`

Add a third "Chats" tab to the bottom tab bar, a new `viewChats` view with chat list, and a `slideChatDetail` slide-over with message thread + reply input.

- [ ] **Step 1: Add the Chats tab button**

In the `<nav class="bottom-tabs" id="bottomTabs">` section, add a new tab button BEFORE the Support tab. The Chats tab should be the first tab (leftmost). Find:

```html
    <nav class="bottom-tabs" id="bottomTabs">
      <button class="bottom-tab active" type="button" data-view="viewMyTickets">
        <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Support</span>
      </button>
      <button class="bottom-tab" type="button" data-view="viewHelpCenter">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>FAQ</span>
      </button>
    </nav>
```

Replace with:

```html
    <nav class="bottom-tabs" id="bottomTabs">
      <button class="bottom-tab active" type="button" data-view="viewChats">
        <svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        <span>Chats</span>
      </button>
      <button class="bottom-tab" type="button" data-view="viewMyTickets">
        <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Support</span>
      </button>
      <button class="bottom-tab" type="button" data-view="viewHelpCenter">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>FAQ</span>
      </button>
    </nav>
```

- [ ] **Step 2: Add the viewChats HTML view**

After the `</nav>` closing tag and BEFORE the `<!-- ═══ VIEW: MY TICKETS ═══ -->` comment, add:

```html
    <!-- ═══ VIEW: CHATS ═══ -->
    <div class="view active" id="viewChats">
      <header class="view-header">
        <div class="view-header-left">
          <h1 class="view-title">Chats</h1>
        </div>
      </header>
      <div class="chat-list" id="chatList">
        <div class="empty-state" id="chatEmptyState">
          <p style="color:var(--muted);font-size:14px;text-align:center;padding:40px 20px">No chats yet. Your GP Link advisor will reach out when there's something to discuss.</p>
        </div>
      </div>
    </div>
```

Remove the `active` class from `viewMyTickets`:
Change `<div class="view active" id="viewMyTickets">` to `<div class="view" id="viewMyTickets">`.

- [ ] **Step 3: Add the slideChatDetail slide-over**

After the `<!-- ═══ SLIDE: TICKET DETAIL ═══ -->` closing `</div>`, add:

```html
  <!-- ═══ SLIDE: CHAT DETAIL ═══ -->
  <div class="slide-view" id="slideChatDetail">
    <div class="slide-inner">
      <header class="detail-header">
        <button class="icon-btn" type="button" id="chatDetailBack" aria-label="Back">
          <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <h2 class="detail-title" id="chatDetailTitle">Chat</h2>
        <span class="badge badge-status" id="chatDetailStatus">Active</span>
      </header>
      <div class="thread-container" id="chatThread"></div>
      <div class="reply-bar" id="chatReplyBar">
        <div class="reply-input-wrap">
          <textarea id="chatReplyInput" rows="1" placeholder="Type your reply..." maxlength="2000"></textarea>
          <button class="send-btn" id="chatSendReplyBtn" type="button" aria-label="Send">
            <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
```

- [ ] **Step 4: Add CSS for chat list items**

In the `<style>` block, add these styles (after the existing `.ticket-card` styles, or at the end of the style block before `</style>`):

```css
    /* ─── CHAT LIST ─── */
    .chat-card {
      background: var(--panel);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      margin: 0 16px 10px;
      box-shadow: var(--shadow-soft);
      cursor: pointer;
      transition: transform .12s ease;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .chat-card:active { transform: scale(.98); }
    .chat-avatar {
      width: 40px; height: 40px; border-radius: 50%;
      background: linear-gradient(135deg, #7c3aed, #a78bfa);
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-weight: 700; font-size: 15px; flex-shrink: 0;
    }
    .chat-card-body { flex: 1; min-width: 0; }
    .chat-card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .chat-card-title { font-weight: 700; font-size: 14px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-card-time { font-size: 11px; color: var(--muted); flex-shrink: 0; }
    .chat-card-preview { font-size: 13px; color: var(--muted); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-card-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; border-radius: 9px; background: #7c3aed; color: #fff; font-size: 10px; font-weight: 700; padding: 0 5px; margin-left: 8px; }
    .chat-card.closed { opacity: 0.55; }
    .chat-card.closed .chat-avatar { background: linear-gradient(135deg, #94a3b8, #cbd5e1); }
```

- [ ] **Step 5: Add the chat JS logic in the `<script>` block**

At the end of the existing `<script>` block, BEFORE the `init()` call, add:

```js
    /* ═══ NUDGE CHATS ═══ */
    let nudgeChats = [];
    let selectedChatId = null;

    async function loadNudgeChats() {
      try {
        const r = await fetch("/api/user/nudge-chats", { credentials: "same-origin" });
        if (!r.ok) return;
        const d = await r.json();
        if (d && d.ok && Array.isArray(d.chats)) nudgeChats = d.chats;
      } catch {}
      renderChatList();
    }

    function renderChatList() {
      const listEl = document.getElementById("chatList");
      const emptyEl = document.getElementById("chatEmptyState");
      if (!nudgeChats.length) {
        listEl.innerHTML = "";
        listEl.appendChild(emptyEl);
        emptyEl.style.display = "";
        return;
      }
      emptyEl.style.display = "none";
      listEl.innerHTML = nudgeChats.map(function(c) {
        const lm = c.last_message;
        const preview = lm ? escapeHtml(lm.message || "").slice(0, 80) : escapeHtml(c.message || "").slice(0, 80);
        const ts = lm ? formatTs(lm.created_at) : formatTs(c.created_at);
        const sender = lm && lm.sender_type === "user" ? "You: " : "GP Link: ";
        const badge = c.unread_count > 0 ? '<span class="chat-card-badge">' + c.unread_count + '</span>' : '';
        const closedCls = c.status === "closed" ? " closed" : "";
        return '<div class="chat-card' + closedCls + '" data-chat-id="' + escapeHtml(c.id) + '">'
          + '<div class="chat-avatar">GL</div>'
          + '<div class="chat-card-body">'
          + '<div class="chat-card-top"><span class="chat-card-title">' + escapeHtml(c.title) + badge + '</span><span class="chat-card-time">' + ts + '</span></div>'
          + '<div class="chat-card-preview">' + sender + preview + '</div>'
          + '</div></div>';
      }).join("");
    }

    async function openChatDetail(chatId) {
      selectedChatId = chatId;
      const slide = document.getElementById("slideChatDetail");
      slide.style.display = "";
      slide.classList.add("active");
      document.getElementById("chatDetailTitle").textContent = "Chat";
      document.getElementById("chatDetailStatus").textContent = "Loading...";
      document.getElementById("chatThread").innerHTML = '<div class="empty-state"><p style="color:var(--muted);text-align:center;padding:20px">Loading...</p></div>';
      // Hide reply bar until loaded
      document.getElementById("chatReplyBar").style.display = "none";
      try {
        const r = await fetch("/api/user/nudge-chats/" + encodeURIComponent(chatId), { credentials: "same-origin" });
        const d = await r.json();
        if (!d || !d.ok) { document.getElementById("chatThread").innerHTML = '<p style="color:var(--red);text-align:center;padding:20px">Failed to load chat.</p>'; return; }
        const chat = d.chat;
        const messages = d.messages || [];
        document.getElementById("chatDetailTitle").textContent = chat.title || "Chat";
        document.getElementById("chatDetailStatus").textContent = chat.status === "closed" ? "Closed" : "Active";
        document.getElementById("chatDetailStatus").className = "badge badge-status " + (chat.status === "closed" ? "closed" : "in-progress");
        // Render messages
        const threadEl = document.getElementById("chatThread");
        if (!messages.length) {
          threadEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:20px">No messages yet.</p>';
        } else {
          threadEl.innerHTML = messages.map(function(m) {
            const isMe = m.sender_type === "user";
            return '<div class="msg-bubble ' + (isMe ? "msg-me" : "msg-them") + '">'
              + '<div class="msg-sender">' + (isMe ? "You" : "GP Link Team") + '</div>'
              + '<div class="msg-text">' + escapeHtml(m.message || "") + '</div>'
              + '<div class="msg-time">' + formatTs(m.created_at) + '</div>'
              + '</div>';
          }).join("");
          threadEl.scrollTop = threadEl.scrollHeight;
        }
        // Show/hide reply bar
        if (chat.status === "closed") {
          document.getElementById("chatReplyBar").style.display = "none";
        } else {
          document.getElementById("chatReplyBar").style.display = "";
        }
      } catch {
        document.getElementById("chatThread").innerHTML = '<p style="color:var(--red);text-align:center;padding:20px">Network error.</p>';
      }
    }

    function closeChatDetail() {
      selectedChatId = null;
      const slide = document.getElementById("slideChatDetail");
      slide.classList.remove("active");
      setTimeout(function() { slide.style.display = "none"; }, 300);
    }

    // Chat list click handler
    document.getElementById("chatList").addEventListener("click", function(e) {
      const card = e.target.closest("[data-chat-id]");
      if (card) openChatDetail(card.getAttribute("data-chat-id"));
    });

    // Chat detail back button
    document.getElementById("chatDetailBack").addEventListener("click", closeChatDetail);

    // Chat reply send
    document.getElementById("chatSendReplyBtn").addEventListener("click", async function() {
      const input = document.getElementById("chatReplyInput");
      const text = (input.value || "").trim();
      if (!text || !selectedChatId) return;
      const btn = document.getElementById("chatSendReplyBtn");
      btn.disabled = true;
      try {
        const r = await fetch("/api/user/nudge-chats/" + encodeURIComponent(selectedChatId) + "/reply", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text })
        });
        const d = await r.json();
        if (d && d.ok) {
          input.value = "";
          await openChatDetail(selectedChatId);
          await loadNudgeChats();
        }
      } catch {}
      btn.disabled = false;
    });
```

- [ ] **Step 6: Add CSS for message bubbles**

In the `<style>` block, add:

```css
    /* ─── CHAT BUBBLES ─── */
    .msg-bubble { padding: 10px 14px; border-radius: 14px; margin-bottom: 8px; max-width: 82%; }
    .msg-them { background: #eff6ff; align-self: flex-start; border-bottom-left-radius: 4px; }
    .msg-me { background: #7c3aed; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; margin-left: auto; }
    .msg-sender { font-size: 11px; font-weight: 700; margin-bottom: 2px; }
    .msg-them .msg-sender { color: var(--blue2); }
    .msg-me .msg-sender { color: rgba(255,255,255,.7); }
    .msg-text { font-size: 13px; line-height: 1.5; }
    .msg-time { font-size: 10px; margin-top: 4px; }
    .msg-them .msg-time { color: var(--muted); }
    .msg-me .msg-time { color: rgba(255,255,255,.6); }
    #chatThread { display: flex; flex-direction: column; gap: 4px; padding: 8px 16px; overflow-y: auto; flex: 1; }
```

- [ ] **Step 7: Update the `switchView` function and init**

In the existing `switchView` function, add `viewChats` to the views map. Find:

```js
    const views = { viewMyTickets: document.getElementById("viewMyTickets"), viewHelpCenter: document.getElementById("viewHelpCenter") };
```

Replace with:

```js
    const views = { viewChats: document.getElementById("viewChats"), viewMyTickets: document.getElementById("viewMyTickets"), viewHelpCenter: document.getElementById("viewHelpCenter") };
```

In the `switchView` function body, find the FAB display line:

```js
      fabEl.style.display = viewId==="viewMyTickets"?"":"none";
```

Keep it as-is (FAB only shows on tickets view, not chats).

In the `init()` function, add `loadNudgeChats();` after the existing `mergeServerTickets();` call.

- [ ] **Step 8: Update hash routing for chat deep links**

In the `applyHashRouting` function, add handling for `#chat-{id}` hashes. Find:

```js
      else if(h.startsWith("#ticket-")){const id=decodeURIComponent(h.replace("#ticket-",""));switchView("viewMyTickets");if(id)setTimeout(()=>openTicketDetail(id),100);}
      else switchView("viewMyTickets");
```

Replace with:

```js
      else if(h.startsWith("#chat-")){const id=decodeURIComponent(h.replace("#chat-",""));switchView("viewChats");if(id)setTimeout(()=>openChatDetail(id),200);}
      else if(h.startsWith("#ticket-")){const id=decodeURIComponent(h.replace("#ticket-",""));switchView("viewMyTickets");if(id)setTimeout(()=>openTicketDetail(id),100);}
      else switchView("viewChats");
```

Note the last `else` now defaults to `viewChats` instead of `viewMyTickets`.

- [ ] **Step 9: Commit**

```bash
git add pages/messages.html
git commit -m "feat: add Chats tab to messages page with chat list and thread view"
```

---

### Task 6: Admin UI — Nudge Chat Thread Modal in admin.html

**Files:**
- Modify: `pages/admin.html`

Add a function `openNudgeChatModal(chatId)` that fetches the chat thread and renders it in the existing modal system with reply input + close button. Also add a "Nudge Chats" section or integrate into existing nudge button handlers.

- [ ] **Step 1: Add openNudgeChatModal function**

After the existing `openNudgeModal` function (around line 4756), add:

```js
  async function openNudgeChatModal(chatId){
    document.getElementById("modalTitle").textContent="Nudge Chat";
    document.getElementById("modalBody").innerHTML='<div style="text-align:center;padding:20px;color:#64748b">Loading...</div>';
    document.getElementById("modalOverlay").classList.add("open");
    try{
      const r=await fetch("/api/admin/va/nudge-chats/"+encodeURIComponent(chatId),{credentials:"same-origin"});
      const d=await r.json();
      if(!d||!d.ok){document.getElementById("modalBody").innerHTML='<div style="color:#ef4444;padding:20px">Failed to load chat.</div>';return;}
      const chat=d.chat;
      const msgs=d.messages||[];
      document.getElementById("modalTitle").textContent="Chat with "+(chat.gp_name||"GP")+(chat.status==="closed"?" (Closed)":"");
      let html='<div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;padding:4px 0" id="adminChatThread">';
      msgs.forEach(function(m){
        const isAdmin=m.sender_type==="admin";
        html+='<div style="padding:8px 12px;border-radius:10px;max-width:85%;'
          +(isAdmin?'background:#eff6ff;align-self:flex-end;margin-left:auto;border-bottom-right-radius:3px;':'background:#f1f5f9;align-self:flex-start;border-bottom-left-radius:3px;')
          +'">';
        html+='<div style="font-size:10px;font-weight:700;color:'+(isAdmin?'#1d4ed8':'#7c3aed')+'">'+(isAdmin?'You (Admin)':'GP')+'</div>';
        html+='<div style="font-size:12px;line-height:1.4;margin:2px 0">'+esc(m.message||"")+'</div>';
        html+='<div style="font-size:10px;color:#64748b">'+new Date(m.created_at||Date.now()).toLocaleString()+'</div>';
        html+='</div>';
      });
      html+='</div>';
      html+='<textarea id="adminChatReplyInput" class="textarea" placeholder="Type your reply..." style="margin-top:8px"></textarea>';
      html+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">';
      html+='<button class="btn primary" id="adminChatSendBtn">Send Reply</button>';
      if(chat.status!=="closed"){
        html+='<button class="btn amber" id="adminChatCloseBtn">Close Chat</button>';
      }else{
        html+='<span style="font-size:12px;color:#64748b;align-self:center">Chat is closed. Sending a reply will reopen it.</span>';
      }
      html+='<button class="btn" data-close-modal>Cancel</button>';
      html+='</div>';
      document.getElementById("modalBody").innerHTML=html;
      // Scroll thread to bottom
      const threadEl=document.getElementById("adminChatThread");
      if(threadEl)threadEl.scrollTop=threadEl.scrollHeight;
      // Reply handler
      document.getElementById("adminChatSendBtn").addEventListener("click",async function(){
        const txt=(document.getElementById("adminChatReplyInput").value||"").trim();
        if(!txt)return;
        const btn=document.getElementById("adminChatSendBtn");
        btn.disabled=true;btn.textContent="Sending...";
        try{
          await fetch("/api/admin/va/nudge-chats/"+encodeURIComponent(chatId)+"/reply",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:txt})});
          toast("Reply sent");
          await openNudgeChatModal(chatId);
        }catch{toast("Failed to send","red");btn.disabled=false;btn.textContent="Send Reply";}
      });
      // Close handler
      var closeBtn=document.getElementById("adminChatCloseBtn");
      if(closeBtn){
        closeBtn.addEventListener("click",async function(){
          closeBtn.disabled=true;
          try{
            await fetch("/api/admin/va/nudge-chats/"+encodeURIComponent(chatId)+"/close",{method:"PUT",credentials:"same-origin"});
            toast("Chat closed");
            closeModal();
          }catch{toast("Failed to close","red");closeBtn.disabled=false;}
        });
      }
    }catch{document.getElementById("modalBody").innerHTML='<div style="color:#ef4444;padding:20px">Network error.</div>';}
  }
```

- [ ] **Step 2: Update the nudge send handler to open chat after sending**

In the existing `openNudgeModal` function, update the success handler to open the created chat. Find the nudge send success handler:

```js
        if(d&&d.ok){
          const parts=["In-app"];
          if(d.whatsapp_sent)parts.push("WhatsApp");
          if(d.email_sent)parts.push("Email");
          toast("Nudge sent via "+parts.join(" + "));
          closeModal();
        }
```

Replace with:

```js
        if(d&&d.ok){
          const parts=["In-app"];
          if(d.whatsapp_sent)parts.push("WhatsApp");
          if(d.email_sent)parts.push("Email");
          toast("Nudge sent via "+parts.join(" + "));
          closeModal();
          // Open the chat thread for this nudge
          if(d.nudge&&d.nudge.id){setTimeout(function(){openNudgeChatModal(d.nudge.id);},400);}
        }
```

- [ ] **Step 3: Add click handler for opening nudge chats from ticket list**

In the admin's ticket list rendering, nudge-reply tickets should have a "View Chat" button. But for now, the main interaction point is the nudge send flow (send nudge → chat opens). The admin can also click the existing "Nudge Reply" badges on tickets. This is handled by the existing `openTicketModal` which already shows the badge. No additional change needed for MVP.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add nudge chat thread modal to admin panel with reply + close"
```

---

### Task 7: Update updates-sync.js — Nudge Click Opens Chat

**Files:**
- Modify: `js/updates-sync.js`

When a nudge notification is clicked in the bell panel, it should navigate to the specific chat instead of the generic `#tab-action` hash.

- [ ] **Step 1: Store nudge IDs in the update items**

In `pullServerNudges()`, find the line where new updates are created:

```js
        updates.unshift({ type: "action", title: title, detail: msg, ts: ts });
```

Replace with:

```js
        updates.unshift({ type: "action", title: title, detail: msg, ts: ts, nudgeId: n.id });
```

- [ ] **Step 2: Update the click handler to navigate to the specific chat**

Find the panel item click handler in `renderPanel()` or wherever the click listener routes `action` type items. Look for any handler that navigates to `messages.html#tab-action`. Find the section where clicking an action item navigates. The current logic in `renderPanel` builds list items — find where the click target is set.

Search for `#tab-action` in the file. Find:

```js
      if (item.type === "action") {
```

In the panel item rendering, the click handler needs to check for `nudgeId` and link to `/pages/messages.html#chat-{nudgeId}` instead of `#tab-action`. Find the `href` or `onclick` that uses `#tab-action` and update it to:

```js
      const clickTarget = item.nudgeId
        ? "/pages/messages.html#chat-" + encodeURIComponent(item.nudgeId)
        : "/pages/messages.html#tab-action";
```

Use this `clickTarget` as the navigation URL.

- [ ] **Step 3: Commit**

```bash
git add js/updates-sync.js
git commit -m "feat: nudge bell notifications link directly to specific chat thread"
```

---

### Task 8: Wire Up DoubleTick Webhook Replies to Nudge Chat

**Files:**
- Modify: `server.js` — the `handleDoubleTickWebhook` function (around line 3139)

When a GP replies via WhatsApp and has pending/active nudges, the reply message should be inserted into `nudge_chat_messages` so it appears in the chat thread.

- [ ] **Step 1: Insert WhatsApp reply into nudge_chat_messages**

In the DoubleTick webhook handler, find the block where pending nudges are dismissed (around line 3142-3157):

```js
    let isNudgeReply = false;
    ...
    if (pendingNudges.length > 0) {
        isNudgeReply = true;
        // Dismiss all pending nudges for this GP
        for (const n of pendingNudges) {
          await supabaseDbRequest('user_nudges', 'id=eq.' + encodeURIComponent(n.id), {
```

After the nudge status update loop, add:

```js
        // Also insert the WhatsApp reply into the nudge chat thread
        for (const n of pendingNudges) {
          if (n.status === 'active' || n.status === 'pending') {
            await supabaseDbRequest('nudge_chat_messages', '', {
              method: 'POST',
              body: [{ nudge_id: n.id, sender_type: 'user', sender_email: '', message: messageBody || '(WhatsApp reply)' }]
            });
          }
        }
```

Also update the status change — instead of setting nudges to `'read'`, set active ones to stay `'active'`:

The existing code patches status to `'read'`. Change it so that nudges with status `'active'` stay `'active'` (the chat is still open), and nudges with status `'pending'` or `'delivered'` get set to `'active'` (now that the GP replied, the chat is active).

Find the existing patch:
```js
            method: 'PATCH', body: { status: 'read', read_at: new Date().toISOString() }
```

Replace with:
```js
            method: 'PATCH', body: { status: 'active', read_at: new Date().toISOString() }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: DoubleTick WhatsApp replies appear in nudge chat thread"
```

---

### Task 9: Update Nudge Email CTA URL (move email send after insert)

**Files:**
- Modify: `server.js` — the `/api/admin/va/nudge` POST handler

The email with "View & Reply" button should link to the specific chat by ID. Currently the email is sent before the nudge row exists. Restructure so the email goes out after the insert, using the nudge ID.

- [ ] **Step 1: Move email send block after the nudge insert**

In the `/api/admin/va/nudge` handler, move the entire "Send nudge email via Resend" block to AFTER the `const nudge = ...` line and the null check. Update the URL:

```js
    // Send nudge email via Resend (after insert so we have the nudge ID)
    if (gpEmail && isEmailConfigured() && nudge) {
      const nudgeReplyUrl = APP_BASE_URL + '/pages/messages.html#chat-' + encodeURIComponent(nudge.id);
      const emailResult = await sendEmail({
        to: gpEmail,
        subject: 'GP Link — ' + title,
        html: buildCareerEmailHtml({
          title: title,
          body: message,
          ctaText: 'View & Reply',
          ctaUrl: nudgeReplyUrl,
          footer: 'This message was sent by the GP Link team to help you with your registration. Click the button above to view and reply.'
        })
      }).catch(() => ({ ok: false }));
      if (emailResult && emailResult.ok) {
        channels.push('email');
        // Update delivered_channels on the nudge row
        await supabaseDbRequest('user_nudges', 'id=eq.' + encodeURIComponent(nudge.id), {
          method: 'PATCH', body: { delivered_channels: channels }
        });
      }
    }
```

Remove the old email block that was before the insert.

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "fix: nudge email CTA links to specific chat-{id} URL"
```

---

### Task 10: Verification — Test the Full Flow

**Files:** None (testing only)

- [ ] **Step 1: Syntax check server.js**

```bash
node -e "require('./server.js'); process.exit(0)" 2>&1 | head -5
```

Expected: loads without syntax errors.

- [ ] **Step 2: Run test suite**

```bash
./node_modules/.bin/vitest run
```

Expected: all tests pass (no regressions).

- [ ] **Step 3: Final commit and push**

```bash
git push
```
