# Gmail Label Organization System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-organize all candidate-related emails into Gmail labels per VA and a silent master archive on hello@mygplink.com.au.

**Architecture:** Extend existing Gmail integration (service account + domain-wide delegation) to manage labels per candidate on multiple VA accounts + a master archive. The Gmail watch expands from INBOX-only to INBOX+SENT. A matching engine checks sender/recipient against GP emails and practice domains, applies labels, and inserts silent copies into hello@. A `practice_detected_contacts` table tracks discovered practice contacts for CC dropdown in the admin UI.

**Tech Stack:** Node.js (server.js), Google Gmail API v1 (googleapis), Supabase (PostgreSQL), vanilla JS admin UI.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server.js` (modify) | New Gmail label helper functions, updated `sendGmailEmail()`, updated `processGmailNotification()`, new API endpoints, updated cron handlers |
| `supabase/migrations/20260601000000_gmail_label_organization.sql` (create) | New tables + columns for label tracking and detected contacts |
| `pages/admin.html` (modify) | CC dropdown in email compose UI |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260601000000_gmail_label_organization.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Gmail Label Organization System
-- Adds label tracking, VA account registry, and detected contacts

-- ── VA Gmail Accounts: maps admin users to their Gmail accounts ──
CREATE TABLE IF NOT EXISTS va_gmail_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  watch_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_va_gmail_email ON va_gmail_accounts(email_address);
CREATE INDEX IF NOT EXISTS idx_va_gmail_user ON va_gmail_accounts(user_id);

-- ── Practice Detected Contacts: discovered emails from practice domains ���─
CREATE TABLE IF NOT EXISTS practice_detected_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES registration_cases(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  display_name TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  seen_count INTEGER DEFAULT 1,
  UNIQUE(case_id, email_address)
);

CREATE INDEX IF NOT EXISTS idx_practice_contacts_case ON practice_detected_contacts(case_id);

-- ── Add label tracking columns to registration_cases ��─
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS gmail_label_id TEXT;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS gmail_label_hello_id TEXT;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS gmail_label_name TEXT;

-- ── RLS for new tables ──
ALTER TABLE va_gmail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_detected_contacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE va_gmail_accounts FROM anon, authenticated;
REVOKE ALL ON TABLE practice_detected_contacts FROM anon, authenticated;

CREATE POLICY va_gmail_service_all ON va_gmail_accounts
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY practice_contacts_service_all ON practice_detected_contacts
  FOR ALL USING (auth.role() = 'service_role');
```

- [ ] **Step 2: Apply migration to Supabase**

Run: `npx supabase db push` (or apply via Supabase dashboard SQL editor if remote-only)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260601000000_gmail_label_organization.sql
git commit -m "feat: add migration for Gmail label organization system"
```

---

## Task 2: Gmail Label Helper Functions

**Files:**
- Modify: `server.js` (insert after `setupGmailWatch` function, around line 2845)

- [ ] **Step 1: Add the `MASTER_ARCHIVE_EMAIL` constant**

Insert after line 1136 (the `GMAIL_WEBHOOK_SECRET` line):

```javascript
const MASTER_ARCHIVE_EMAIL = String(process.env.MASTER_ARCHIVE_EMAIL || 'hello@mygplink.com.au').trim();
```

- [ ] **Step 2: Update Gmail auth scopes to include `gmail.modify` and `gmail.labels`**

Replace line 1164:
```javascript
      scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send'],
```
With:
```javascript
      scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.labels', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send'],
```

- [ ] **Step 3: Add `ensureGmailLabel` helper function**

Insert after `setupGmailWatch` (after line 2845):

```javascript
// ── Gmail Label Management ──
async function ensureGmailLabel(gmailAccount, labelName) {
  // Creates a Gmail label if it doesn't exist, returns the label ID.
  // For nested labels like "Expedited Specialist Pathway/Dr Smith", Gmail uses the full path as the name.
  var gmail = await getGmailClient(gmailAccount);
  if (!gmail) return null;

  try {
    // Check if label already exists
    var listRes = await gmail.users.labels.list({ userId: gmailAccount });
    var labels = (listRes.data && listRes.data.labels) || [];
    var existing = labels.find(function(l) { return l.name === labelName; });
    if (existing) return existing.id;

    // Create the label
    var createRes = await gmail.users.labels.create({
      userId: gmailAccount,
      requestBody: {
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show'
      }
    });
    console.log('[Gmail Labels] Created label "' + labelName + '" on', gmailAccount);
    return createRes.data.id;
  } catch (err) {
    console.error('[Gmail Labels] ensureGmailLabel failed for "' + labelName + '" on', gmailAccount, ':', err.message);
    return null;
  }
}

async function renameGmailLabel(gmailAccount, labelId, newName) {
  var gmail = await getGmailClient(gmailAccount);
  if (!gmail || !labelId) return false;
  try {
    await gmail.users.labels.patch({
      userId: gmailAccount,
      id: labelId,
      requestBody: { name: newName }
    });
    console.log('[Gmail Labels] Renamed label', labelId, 'to "' + newName + '" on', gmailAccount);
    return true;
  } catch (err) {
    console.error('[Gmail Labels] rename failed:', err.message);
    return false;
  }
}

async function applyGmailLabel(gmailAccount, messageId, labelId) {
  var gmail = await getGmailClient(gmailAccount);
  if (!gmail || !messageId || !labelId) return false;
  try {
    await gmail.users.messages.modify({
      userId: gmailAccount,
      id: messageId,
      requestBody: { addLabelIds: [labelId] }
    });
    return true;
  } catch (err) {
    console.error('[Gmail Labels] applyLabel failed:', err.message);
    return false;
  }
}

async function insertSilentCopy(targetAccount, labelId, rawMessage) {
  // Insert a message into targetAccount with label applied but NOT in INBOX
  var gmail = await getGmailClient(targetAccount);
  if (!gmail || !labelId) return null;
  try {
    var rawBase64 = Buffer.from(rawMessage).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    var result = await gmail.users.messages.insert({
      userId: targetAccount,
      requestBody: {
        raw: rawBase64,
        labelIds: [labelId]
      }
    });
    return result.data && result.data.id ? result.data.id : null;
  } catch (err) {
    console.error('[Gmail Labels] insertSilentCopy failed:', err.message);
    return null;
  }
}

function buildCandidateLabelName(gpName, practiceName) {
  var label = 'Expedited Specialist Pathway/Dr ' + (gpName || 'Unknown');
  if (practiceName && practiceName.trim()) {
    label += ' - ' + practiceName.trim();
  }
  return label;
}

function buildHelloLabelName(vaDisplayName, gpName, practiceName) {
  var gpPart = 'Dr ' + (gpName || 'Unknown');
  if (practiceName && practiceName.trim()) {
    gpPart += ' - ' + practiceName.trim();
  }
  return 'Expedited Specialist Pathway/' + vaDisplayName + '/' + gpPart;
}
```

- [ ] **Step 4: Add `createLabelsForCase` orchestrator function**

```javascript
async function createLabelsForCase(caseId, vaEmail, vaDisplayName, gpName, practiceName) {
  // Creates labels on the VA's Gmail and on hello@ for a candidate
  var vaLabelName = buildCandidateLabelName(gpName, practiceName);
  var helloLabelName = buildHelloLabelName(vaDisplayName, gpName, practiceName);

  var vaLabelId = await ensureGmailLabel(vaEmail, vaLabelName);
  var helloLabelId = await ensureGmailLabel(MASTER_ARCHIVE_EMAIL, helloLabelName);

  // Store label IDs on the case
  var patch = {};
  if (vaLabelId) patch.gmail_label_id = vaLabelId;
  if (helloLabelId) patch.gmail_label_hello_id = helloLabelId;
  patch.gmail_label_name = vaLabelName;

  if (Object.keys(patch).length > 0) {
    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), {
      method: 'PATCH', body: patch
    });
  }

  console.log('[Gmail Labels] Created labels for case', caseId, '— VA:', vaLabelId, 'hello@:', helloLabelId);
  return { vaLabelId: vaLabelId, helloLabelId: helloLabelId };
}

async function archiveLabelForVA(vaEmail, caseId) {
  // Move a candidate's label from "Expedited Specialist Pathway/..." to "Archived/..."
  var caseRes = await supabaseDbRequest('registration_cases',
    'select=gmail_label_id,gmail_label_name&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
  if (!caseRes.ok || !caseRes.data || !caseRes.data[0]) return;
  var currentLabelId = caseRes.data[0].gmail_label_id;
  var currentLabelName = caseRes.data[0].gmail_label_name || '';
  if (!currentLabelId || !currentLabelName) return;

  // Extract the GP portion from "Expedited Specialist Pathway/Dr Name - Practice"
  var gpPart = currentLabelName.replace(/^Expedited Specialist Pathway\//, '');
  var archivedName = 'Archived/' + gpPart;

  await renameGmailLabel(vaEmail, currentLabelId, archivedName);
}
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add Gmail label helper functions (create, rename, apply, archive)"
```

---

## Task 3: Email Matching Engine

**Files:**
- Modify: `server.js` (insert after the label helpers from Task 2)

- [ ] **Step 1: Add the matching function**

```javascript
// ── Email-to-Candidate Matching Engine ──
async function matchEmailToCase(emailAddresses, vaEmail) {
  // Given a list of email addresses from an email (from/to/cc/bcc),
  // find which registration_cases they match (by GP email or practice domain).
  // Returns array of { caseId, matchType, matchedAddress }
  if (!emailAddresses || emailAddresses.length === 0) return [];

  // Normalize addresses
  var normalized = emailAddresses.map(function(e) { return e.toLowerCase().trim(); });

  // Get all active cases assigned to this VA
  var casesRes = await supabaseDbRequest('registration_cases',
    'select=id,user_id,practice_contact,gmail_label_id,gmail_label_hello_id&assigned_va=not.is.null&status=eq.active');
  if (!casesRes.ok || !Array.isArray(casesRes.data)) return [];

  // Get user profiles for GP emails
  var userIds = casesRes.data.map(function(c) { return c.user_id; });
  var profilesRes = await supabaseDbRequest('user_profiles',
    'select=user_id,email&user_id=in.(' + userIds.join(',') + ')');
  var profileMap = {};
  if (profilesRes.ok && Array.isArray(profilesRes.data)) {
    profilesRes.data.forEach(function(p) { profileMap[p.user_id] = (p.email || '').toLowerCase(); });
  }

  var matches = [];
  for (var ci = 0; ci < casesRes.data.length; ci++) {
    var c = casesRes.data[ci];
    var gpEmail = profileMap[c.user_id] || '';
    var practiceContact = (c.practice_contact || '').toLowerCase().trim();
    var practiceDomain = practiceContact ? practiceContact.split('@')[1] : '';

    for (var ei = 0; ei < normalized.length; ei++) {
      var addr = normalized[ei];
      // Skip the VA's own email and hello@
      if (addr === vaEmail.toLowerCase() || addr === MASTER_ARCHIVE_EMAIL.toLowerCase()) continue;

      if (gpEmail && addr === gpEmail) {
        matches.push({ caseId: c.id, matchType: 'gp_email', matchedAddress: addr, labelId: c.gmail_label_id, helloLabelId: c.gmail_label_hello_id });
        break;
      }
      if (practiceDomain && addr.endsWith('@' + practiceDomain)) {
        matches.push({ caseId: c.id, matchType: 'practice_domain', matchedAddress: addr, labelId: c.gmail_label_id, helloLabelId: c.gmail_label_hello_id });
        break;
      }
    }
  }

  return matches;
}

function extractAllAddresses(headers) {
  // Extract all email addresses from From, To, CC, BCC headers
  var addresses = [];
  var fields = ['from', 'to', 'cc', 'bcc'];
  for (var fi = 0; fi < fields.length; fi++) {
    var val = headers[fields[fi]] || '';
    // Parse "Name <email>" and bare "email" patterns
    var emailRegex = /[\w.+-]+@[\w.-]+\.\w+/g;
    var found = val.match(emailRegex) || [];
    for (var ai = 0; ai < found.length; ai++) {
      addresses.push(found[ai].toLowerCase());
    }
  }
  return addresses;
}

async function detectAndStoreContacts(caseId, addresses, practiceDomain) {
  // Store newly discovered contacts from the practice domain
  if (!practiceDomain || !addresses || addresses.length === 0) return;
  for (var i = 0; i < addresses.length; i++) {
    var addr = addresses[i].toLowerCase();
    if (!addr.endsWith('@' + practiceDomain)) continue;

    // Upsert into practice_detected_contacts
    await supabaseDbRequest('practice_detected_contacts', '', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: {
        case_id: caseId,
        email_address: addr,
        last_seen_at: new Date().toISOString(),
        seen_count: 1
      }
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add email-to-candidate matching engine and contact detection"
```

---

## Task 4: Update `sendGmailEmail` to Apply Labels After Send

**Files:**
- Modify: `server.js:1190-1312` (the `sendGmailEmail` function)

- [ ] **Step 1: Add `caseId` parameter to `sendGmailEmail`**

Update the function signature at line 1190:

```javascript
async function sendGmailEmail({ from, to, cc, subject, bodyHtml, bodyText, attachments, threadId, inReplyTo, caseId }) {
```

- [ ] **Step 2: Add label application and hello@ archive after successful send**

After line 1304 (after the `console.log('[Gmail] Email sent...')` line), insert:

```javascript
    // Apply Gmail labels if case is linked
    if (caseId) {
      try {
        var labelCaseRes = await supabaseDbRequest('registration_cases',
          'select=gmail_label_id,gmail_label_hello_id&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
        var labelCase = labelCaseRes.ok && labelCaseRes.data && labelCaseRes.data[0] ? labelCaseRes.data[0] : null;
        if (labelCase) {
          // Apply label on sender's account
          if (labelCase.gmail_label_id && gmailMessageId) {
            await applyGmailLabel(from, gmailMessageId, labelCase.gmail_label_id);
          }
          // Insert silent copy into hello@ archive
          if (labelCase.gmail_label_hello_id) {
            await insertSilentCopy(MASTER_ARCHIVE_EMAIL, labelCase.gmail_label_hello_id, rawMessage);
          }
        }
      } catch (labelErr) {
        console.error('[Gmail Labels] Post-send labeling failed:', labelErr.message);
        // Non-fatal — email was already sent successfully
      }
    }
```

- [ ] **Step 3: Update all existing `sendGmailEmail` call sites to pass `caseId`**

Find all calls to `sendGmailEmail` in server.js and add the `caseId` parameter where available. Key locations:

1. SPPA send-to-candidate (~line 29435): Add `caseId: task.case_id`
2. SPPA send-to-practice (~line 29490+): Add `caseId: task.case_id`
3. Any other `sendGmailEmail` calls: Add `caseId` if case context is available, leave undefined otherwise.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: apply Gmail labels and archive to hello@ after sending emails"
```

---

## Task 5: Update Gmail Watch to Monitor INBOX + SENT

**Files:**
- Modify: `server.js:2809-2845` (`setupGmailWatch` function)

- [ ] **Step 1: Update `setupGmailWatch` to watch both INBOX and SENT**

Replace lines 2824-2827:

```javascript
    var watchRes = await gmail.users.watch({
      userId: userEmail,
      requestBody: { topicName: GOOGLE_PUBSUB_TOPIC, labelIds: ['INBOX'] }
    });
```

With:

```javascript
    var watchRes = await gmail.users.watch({
      userId: userEmail,
      requestBody: { topicName: GOOGLE_PUBSUB_TOPIC, labelIds: ['INBOX', 'SENT'] }
    });
```

- [ ] **Step 2: Update `processGmailNotification` history.list to include SENT**

At line 1861-1866, replace:
```javascript
    historyResponse = await gmail.users.history.list({
      userId: emailAddress,
      startHistoryId: storedHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX'
    });
```

With:
```javascript
    historyResponse = await gmail.users.history.list({
      userId: emailAddress,
      startHistoryId: storedHistoryId,
      historyTypes: ['messageAdded']
    });
```

(Remove the `labelId: 'INBOX'` filter to capture both INBOX and SENT messages.)

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: expand Gmail watch to monitor both INBOX and SENT messages"
```

---

## Task 6: Update `processGmailNotification` — Label Matching Logic

**Files:**
- Modify: `server.js` (within `processGmailNotification`, after message fetch ~line 1940)

- [ ] **Step 1: Remove the `MONITORED_VA_EMAILS` restriction at line 1806**

Replace:
```javascript
  if (!MONITORED_VA_EMAILS.includes(emailAddress)) {
    console.log('[Gmail] Ignoring notification for non-monitored email:', emailAddress);
    return;
  }
```

With:
```javascript
  // Check if this email is a registered VA account or the master archive
  var isRegisteredVA = MONITORED_VA_EMAILS.includes(emailAddress);
  if (!isRegisteredVA) {
    var vaAccountRes = await supabaseDbRequest('va_gmail_accounts',
      'select=id&email_address=eq.' + encodeURIComponent(emailAddress) + '&limit=1');
    isRegisteredVA = vaAccountRes.ok && Array.isArray(vaAccountRes.data) && vaAccountRes.data.length > 0;
  }
  if (!isRegisteredVA && emailAddress !== MASTER_ARCHIVE_EMAIL) {
    console.log('[Gmail] Ignoring notification for non-monitored email:', emailAddress);
    return;
  }
```

- [ ] **Step 2: Add label matching after `extractEmailMeta` (line 1940)**

After line 1948 (`emailMeta.headers = lowerHeaders;`), insert:

```javascript
      // ── Gmail Label Auto-Filing ──
      var allAddresses = extractAllAddresses(lowerHeaders);
      var caseMatches = await matchEmailToCase(allAddresses, emailAddress);
      if (caseMatches.length > 0) {
        for (var mi = 0; mi < caseMatches.length; mi++) {
          var match = caseMatches[mi];
          // Apply label on this VA's account
          if (match.labelId) {
            await applyGmailLabel(emailAddress, currentMsgId, match.labelId);
          }
          // Insert silent copy into hello@ archive (skip if this IS hello@)
          if (match.helloLabelId && emailAddress !== MASTER_ARCHIVE_EMAIL) {
            var fullMsgRaw = await gmail.users.messages.get({
              userId: emailAddress, id: currentMsgId, format: 'raw'
            });
            if (fullMsgRaw.data && fullMsgRaw.data.raw) {
              var rawBytes = Buffer.from(fullMsgRaw.data.raw, 'base64');
              await insertSilentCopy(MASTER_ARCHIVE_EMAIL, match.helloLabelId, rawBytes);
            }
          }
          // Detect new practice contacts
          var matchCaseRes = await supabaseDbRequest('registration_cases',
            'select=practice_contact&id=eq.' + encodeURIComponent(match.caseId) + '&limit=1');
          if (matchCaseRes.ok && matchCaseRes.data && matchCaseRes.data[0]) {
            var pc = (matchCaseRes.data[0].practice_contact || '').toLowerCase();
            var domain = pc ? pc.split('@')[1] : '';
            if (domain) {
              await detectAndStoreContacts(match.caseId, allAddresses, domain);
            }
          }
        }
        console.log('[Gmail Labels] Auto-filed message', currentMsgId, 'into', caseMatches.length, 'case label(s)');
      }
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: auto-file emails into candidate labels via matching engine"
```

---

## Task 7: Hook Label Creation into Case Assignment

**Files:**
- Modify: `server.js:27196-27216` (the `PUT /api/admin/case` endpoint)

- [ ] **Step 1: Add label creation when `assigned_va` is set**

After line 27213 (the timeline logging), before the `sendJson` response, insert:

```javascript
    // ── Gmail Label Management on VA assignment ──
    if (patch.assigned_va) {
      (async function() {
        try {
          // Get the case for GP info
          var labelCaseRes = await supabaseDbRequest('registration_cases',
            'select=user_id,practice_name,gmail_label_id&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
          var labelCase = labelCaseRes.ok && labelCaseRes.data && labelCaseRes.data[0] ? labelCaseRes.data[0] : null;
          if (!labelCase) return;

          // Get GP name
          var gpProfileRes = await supabaseDbRequest('user_profiles',
            'select=first_name,last_name&user_id=eq.' + encodeURIComponent(labelCase.user_id) + '&limit=1');
          var gpProfile = gpProfileRes.ok && gpProfileRes.data && gpProfileRes.data[0] ? gpProfileRes.data[0] : {};
          var gpName = [(gpProfile.first_name || ''), (gpProfile.last_name || '')].join(' ').trim() || 'Unknown';

          // Get VA account info
          var vaAccRes = await supabaseDbRequest('va_gmail_accounts',
            'select=email_address,display_name&user_id=eq.' + encodeURIComponent(patch.assigned_va) + '&limit=1');
          var vaAcc = vaAccRes.ok && vaAccRes.data && vaAccRes.data[0] ? vaAccRes.data[0] : null;
          if (!vaAcc) {
            console.log('[Gmail Labels] No VA Gmail account registered for user', patch.assigned_va);
            return;
          }

          // Archive label on old VA if this is a reassignment
          var oldCase = r.data && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
          if (body._old_assigned_va && body._old_assigned_va !== patch.assigned_va) {
            var oldVaRes = await supabaseDbRequest('va_gmail_accounts',
              'select=email_address&user_id=eq.' + encodeURIComponent(body._old_assigned_va) + '&limit=1');
            var oldVaAcc = oldVaRes.ok && oldVaRes.data && oldVaRes.data[0] ? oldVaRes.data[0] : null;
            if (oldVaAcc && labelCase.gmail_label_id) {
              await archiveLabelForVA(oldVaAcc.email_address, caseId);

              // Copy email history to new VA (fetch messages with old label, insert into new VA)
              var oldGmail = await getGmailClient(oldVaAcc.email_address);
              if (oldGmail && labelCase.gmail_label_id) {
                try {
                  var oldMsgs = await oldGmail.users.messages.list({
                    userId: oldVaAcc.email_address,
                    labelIds: [labelCase.gmail_label_id],
                    maxResults: 100
                  });
                  var msgList = (oldMsgs.data && oldMsgs.data.messages) || [];
                  for (var mIdx = 0; mIdx < msgList.length; mIdx++) {
                    var rawMsg = await oldGmail.users.messages.get({
                      userId: oldVaAcc.email_address, id: msgList[mIdx].id, format: 'raw'
                    });
                    if (rawMsg.data && rawMsg.data.raw) {
                      // Will be labeled by createLabelsForCase below
                      var rawBytes = Buffer.from(rawMsg.data.raw, 'base64');
                      // Insert will happen after new label is created
                      setTimeout(async function(bytes, newVaEmail, newCaseId) {
                        var cRes = await supabaseDbRequest('registration_cases',
                          'select=gmail_label_id&id=eq.' + encodeURIComponent(newCaseId) + '&limit=1');
                        var newLabelId = cRes.ok && cRes.data && cRes.data[0] ? cRes.data[0].gmail_label_id : null;
                        if (newLabelId) {
                          await insertSilentCopy(newVaEmail, newLabelId, bytes);
                        }
                      }.bind(null, rawBytes, vaAcc.email_address, caseId), 3000);
                    }
                  }
                } catch (copyErr) {
                  console.error('[Gmail Labels] History copy failed:', copyErr.message);
                }
              }
            }

            // Move hello@ sub-label to new VA's folder
            if (labelCase.gmail_label_hello_id) {
              var oldVaDisplayRes = await supabaseDbRequest('va_gmail_accounts',
                'select=display_name&user_id=eq.' + encodeURIComponent(body._old_assigned_va) + '&limit=1');
              var newHelloName = buildHelloLabelName(vaAcc.display_name, gpName, labelCase.practice_name);
              await renameGmailLabel(MASTER_ARCHIVE_EMAIL, labelCase.gmail_label_hello_id, newHelloName);
            }
          }

          // Create labels for the new VA
          await createLabelsForCase(caseId, vaAcc.email_address, vaAcc.display_name, gpName, labelCase.practice_name || '');
        } catch (err) {
          console.error('[Gmail Labels] Label creation on assignment failed:', err.message);
        }
      })();
    }

    // ── Gmail Label Rename on practice_name change ──
    if (patch.practice_name) {
      (async function() {
        try {
          var rnCaseRes = await supabaseDbRequest('registration_cases',
            'select=user_id,gmail_label_id,gmail_label_hello_id,assigned_va&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
          var rnCase = rnCaseRes.ok && rnCaseRes.data && rnCaseRes.data[0] ? rnCaseRes.data[0] : null;
          if (!rnCase || !rnCase.assigned_va) return;

          var gpProfRes = await supabaseDbRequest('user_profiles',
            'select=first_name,last_name&user_id=eq.' + encodeURIComponent(rnCase.user_id) + '&limit=1');
          var gpProf = gpProfRes.ok && gpProfRes.data && gpProfRes.data[0] ? gpProfRes.data[0] : {};
          var gpN = [(gpProf.first_name || ''), (gpProf.last_name || '')].join(' ').trim() || 'Unknown';

          var vaRes = await supabaseDbRequest('va_gmail_accounts',
            'select=email_address,display_name&user_id=eq.' + encodeURIComponent(rnCase.assigned_va) + '&limit=1');
          var va = vaRes.ok && vaRes.data && vaRes.data[0] ? vaRes.data[0] : null;
          if (!va) return;

          var newVaLabel = buildCandidateLabelName(gpN, patch.practice_name);
          var newHelloLabel = buildHelloLabelName(va.display_name, gpN, patch.practice_name);

          if (rnCase.gmail_label_id) {
            await renameGmailLabel(va.email_address, rnCase.gmail_label_id, newVaLabel);
          }
          if (rnCase.gmail_label_hello_id) {
            await renameGmailLabel(MASTER_ARCHIVE_EMAIL, rnCase.gmail_label_hello_id, newHelloLabel);
          }
          // Update stored label name
          await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), {
            method: 'PATCH', body: { gmail_label_name: newVaLabel }
          });
        } catch (err) {
          console.error('[Gmail Labels] Rename on practice_name change failed:', err.message);
        }
      })();
    }
```

- [ ] **Step 2: Pass `_old_assigned_va` from admin UI on reassignment**

The admin UI needs to include the old VA ID when reassigning. In the PUT body, include:
```javascript
_old_assigned_va: currentCase.assigned_va  // the previous VA before change
```
Add `'_old_assigned_va'` is NOT in the `allowed` list (it shouldn't be patched to DB), but we need access to `body._old_assigned_va` before the patch filter. The current code reads it from `body` before filtering, so it's accessible.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: create/archive/rename Gmail labels on VA assignment and practice changes"
```

---

## Task 8: Update Cron Handlers for Multi-Account Support

**Files:**
- Modify: `server.js:18764-18795` (cron endpoints)

- [ ] **Step 1: Update `/api/cron/process-gmail` to process all registered VA accounts**

Replace lines 18764-18778:

```javascript
  if (req.method === 'GET' && pathname === '/api/cron/process-gmail') {
    var pgCronSecret = String(process.env.CRON_SECRET || process.env.ZOHO_RECRUIT_SYNC_CRON_SECRET || '').trim();
    var pgAuth = req.headers['authorization'] || '';
    if (!pgCronSecret || pgAuth !== 'Bearer ' + pgCronSecret) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
    var pgResults = [];
    // Process legacy monitored emails
    for (var pgEmail of MONITORED_VA_EMAILS) {
      try {
        await processGmailNotification(pgEmail, null);
        pgResults.push({ email: pgEmail, ok: true });
      } catch (pgErr) {
        pgResults.push({ email: pgEmail, ok: false, error: pgErr.message });
      }
    }
    // Process dynamically registered VA accounts
    if (isSupabaseDbConfigured()) {
      var vaAccsRes = await supabaseDbRequest('va_gmail_accounts', 'select=email_address&watch_active=eq.true');
      var vaAccs = vaAccsRes.ok && Array.isArray(vaAccsRes.data) ? vaAccsRes.data : [];
      for (var vai = 0; vai < vaAccs.length; vai++) {
        var vaAddr = vaAccs[vai].email_address;
        if (MONITORED_VA_EMAILS.includes(vaAddr)) continue; // already processed
        try {
          await processGmailNotification(vaAddr, null);
          pgResults.push({ email: vaAddr, ok: true });
        } catch (vaErr) {
          pgResults.push({ email: vaAddr, ok: false, error: vaErr.message });
        }
      }
      // Also process master archive
      try {
        await processGmailNotification(MASTER_ARCHIVE_EMAIL, null);
        pgResults.push({ email: MASTER_ARCHIVE_EMAIL, ok: true });
      } catch (maErr) {
        pgResults.push({ email: MASTER_ARCHIVE_EMAIL, ok: false, error: maErr.message });
      }
    }
    sendJson(res, 200, { ok: true, results: pgResults });
    return;
  }
```

- [ ] **Step 2: Update `/api/cron/renew-gmail-watch` similarly**

Replace lines 18782-18795:

```javascript
  if (req.method === 'GET' && pathname === '/api/cron/renew-gmail-watch') {
    var cronSecret = String(process.env.CRON_SECRET || process.env.ZOHO_RECRUIT_SYNC_CRON_SECRET || '').trim();
    var authHeader = req.headers['authorization'] || '';
    if (!cronSecret || authHeader !== 'Bearer ' + cronSecret) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    var cronResults = [];
    // Legacy monitored emails
    for (var vaEmail of MONITORED_VA_EMAILS) {
      var watchResult = await setupGmailWatch(vaEmail);
      cronResults.push({ email: vaEmail, success: !!(watchResult && watchResult.ok), expiry: watchResult && watchResult.ok ? watchResult.expiry : null, error: watchResult && !watchResult.ok ? watchResult.error : null });
    }
    // Dynamic VA accounts
    if (isSupabaseDbConfigured()) {
      var dynVaRes = await supabaseDbRequest('va_gmail_accounts', 'select=email_address&watch_active=eq.true');
      var dynVas = dynVaRes.ok && Array.isArray(dynVaRes.data) ? dynVaRes.data : [];
      for (var dvi = 0; dvi < dynVas.length; dvi++) {
        var dvAddr = dynVas[dvi].email_address;
        if (MONITORED_VA_EMAILS.includes(dvAddr)) continue;
        var dvResult = await setupGmailWatch(dvAddr);
        cronResults.push({ email: dvAddr, success: !!(dvResult && dvResult.ok), expiry: dvResult && dvResult.ok ? dvResult.expiry : null, error: dvResult && !dvResult.ok ? dvResult.error : null });
      }
      // Master archive watch
      var helloResult = await setupGmailWatch(MASTER_ARCHIVE_EMAIL);
      cronResults.push({ email: MASTER_ARCHIVE_EMAIL, success: !!(helloResult && helloResult.ok), expiry: helloResult && helloResult.ok ? helloResult.expiry : null, error: helloResult && !helloResult.ok ? helloResult.error : null });
    }
    sendJson(res, 200, { ok: true, results: cronResults });
    return;
  }
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: update cron handlers to process all registered VA accounts + hello@"
```

---

## Task 9: New API Endpoints (VA Gmail Management + Detected Contacts)

**Files:**
- Modify: `server.js` (add before the existing admin endpoints section)

- [ ] **Step 1: Add `/api/admin/va/gmail/setup` endpoint**

```javascript
  // ── Register VA Gmail account ──
  if (pathname === '/api/admin/va/gmail/setup' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const vaUserId = body && body.user_id ? String(body.user_id).trim() : '';
    const vaEmailAddr = body && body.email_address ? String(body.email_address).trim().toLowerCase() : '';
    const vaDisplayName = body && body.display_name ? String(body.display_name).trim() : '';
    if (!vaUserId || !vaEmailAddr || !vaDisplayName) {
      sendJson(res, 400, { ok: false, message: 'Missing user_id, email_address, or display_name.' }); return;
    }

    // Upsert into va_gmail_accounts
    var upsertRes = await supabaseDbRequest('va_gmail_accounts', '', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: { user_id: vaUserId, email_address: vaEmailAddr, display_name: vaDisplayName, watch_active: true }
    });
    if (!upsertRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to register VA Gmail account.' }); return; }

    // Set up Gmail watch immediately
    var watchRes = await setupGmailWatch(vaEmailAddr);

    sendJson(res, 200, { ok: true, account: upsertRes.data && upsertRes.data[0] ? upsertRes.data[0] : null, watch: watchRes });
    return;
  }

  // ── Remove VA Gmail watch ──
  if (pathname === '/api/admin/va/gmail/teardown' && req.method === 'DELETE') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const emailToRemove = url.searchParams.get('email');
    if (!emailToRemove) { sendJson(res, 400, { ok: false, message: 'Missing email param.' }); return; }

    // Stop Gmail watch
    var gmail = await getGmailClient(emailToRemove);
    if (gmail) {
      try { await gmail.users.stop({ userId: emailToRemove }); } catch (e) { /* ignore */ }
    }

    // Mark inactive
    await supabaseDbRequest('va_gmail_accounts', 'email_address=eq.' + encodeURIComponent(emailToRemove), {
      method: 'PATCH', body: { watch_active: false }
    });

    sendJson(res, 200, { ok: true });
    return;
  }

  // ── VA Gmail status ��─
  if (pathname === '/api/admin/va/gmail/status' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    var vaListRes = await supabaseDbRequest('va_gmail_accounts', 'select=*&order=created_at.asc');
    var vaList = vaListRes.ok && Array.isArray(vaListRes.data) ? vaListRes.data : [];

    // Get watch state for each
    var watchStateRes = await supabaseDbRequest('gmail_watch_state', 'select=email_address,watch_expiry,updated_at');
    var watchMap = {};
    if (watchStateRes.ok && Array.isArray(watchStateRes.data)) {
      watchStateRes.data.forEach(function(w) { watchMap[w.email_address] = w; });
    }

    var enriched = vaList.map(function(va) {
      var ws = watchMap[va.email_address] || {};
      return Object.assign({}, va, { watch_expiry: ws.watch_expiry || null, watch_updated: ws.updated_at || null });
    });

    sendJson(res, 200, { ok: true, accounts: enriched, master_email: MASTER_ARCHIVE_EMAIL });
    return;
  }

  // ── Get detected contacts for a case (CC dropdown) ──
  if (pathname.match(/^\/api\/admin\/va\/case\/[^/]+\/email-contacts$/) && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const contactsCaseId = pathname.split('/')[5];
    if (!contactsCaseId) { sendJson(res, 400, { ok: false }); return; }

    var contactsRes = await supabaseDbRequest('practice_detected_contacts',
      'select=*&case_id=eq.' + encodeURIComponent(contactsCaseId) + '&order=seen_count.desc');
    var contacts = contactsRes.ok && Array.isArray(contactsRes.data) ? contactsRes.data : [];

    sendJson(res, 200, { ok: true, contacts: contacts });
    return;
  }
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add VA Gmail management and detected contacts API endpoints"
```

---

## Task 10: Admin UI — CC Dropdown in Email Compose

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Find the email compose section in admin.html and add CC dropdown**

Locate the SPPA send UI or general email compose area. Add a multi-select dropdown that fetches from `/api/admin/va/case/{caseId}/email-contacts`:

```html
<!-- CC Contacts Dropdown (inside email compose modal/section) -->
<div class="cc-contacts-row" style="margin-bottom:12px;display:none" id="ccContactsRow">
  <label style="font-size:13px;font-weight:600;color:#334155;margin-bottom:4px;display:block">CC (detected practice contacts)</label>
  <select id="ccContactsSelect" multiple style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;min-height:60px">
  </select>
  <p style="font-size:11px;color:#64748b;margin-top:4px">Hold Ctrl/Cmd to select multiple</p>
</div>
```

- [ ] **Step 2: Add JS to fetch and populate contacts when composing an email**

```javascript
async function loadCcContacts(caseId) {
  var row = document.getElementById('ccContactsRow');
  var select = document.getElementById('ccContactsSelect');
  if (!row || !select) return;
  select.innerHTML = '';
  row.style.display = 'none';

  try {
    var resp = await fetch('/api/admin/va/case/' + caseId + '/email-contacts', { credentials: 'include' });
    var data = await resp.json();
    if (data.ok && data.contacts && data.contacts.length > 0) {
      data.contacts.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.email_address;
        opt.textContent = (c.display_name ? c.display_name + ' <' + c.email_address + '>' : c.email_address) + ' (seen ' + c.seen_count + 'x)';
        select.appendChild(opt);
      });
      row.style.display = 'block';
    }
  } catch (e) {
    console.error('[CC Contacts]', e);
  }
}

function getSelectedCcEmails() {
  var select = document.getElementById('ccContactsSelect');
  if (!select) return '';
  var selected = Array.from(select.selectedOptions).map(function(o) { return o.value; });
  return selected.join(', ');
}
```

- [ ] **Step 3: Wire CC into the send email calls**

When the admin sends an email (SPPA or other), read the selected CC addresses:

```javascript
// In the send button handler, before calling the API:
var ccValue = getSelectedCcEmails();
// Pass to the API body: { ..., cc: ccValue }
```

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add CC contacts dropdown in admin email compose UI"
```

---

## Task 11: Environment Variable + Google Workspace Setup Notes

**Files:**
- Modify: `server.js` (add `MASTER_ARCHIVE_EMAIL` to integration status endpoint)

- [ ] **Step 1: Add `MASTER_ARCHIVE_EMAIL` to the integration status check**

Find the `/api/ceo/integrations` endpoint and add:

```javascript
gmail_label_system: {
  configured: !!(MASTER_ARCHIVE_EMAIL && isGmailConfigured()),
  master_archive_email: MASTER_ARCHIVE_EMAIL
}
```

- [ ] **Step 2: Add env var to Vercel**

Run:
```bash
vercel env add MASTER_ARCHIVE_EMAIL production preview development
# Value: hello@mygplink.com.au
```

- [ ] **Step 3: Update Google Workspace domain-wide delegation**

Manual step — document for admin:
1. Go to Google Workspace Admin Console → Security → API Controls → Domain-wide Delegation
2. Find the service account client ID for `gplink-drive@sunlit-precinct-481010-j2.iam.gserviceaccount.com`
3. Add scopes: `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.labels`
4. Ensure `hello@mygplink.com.au` is covered by the delegation (all users in the domain)
5. Add any new VA email accounts to the domain

- [ ] **Step 4: Commit and deploy**

```bash
git add server.js
git commit -m "feat: add Gmail label system to integration status check"
vercel --prod
```

---

## Task 12: Seed Initial VA Account (Hazel)

**Files:**
- No code changes — run API call to register Hazel's account

- [ ] **Step 1: Register Hazel's Gmail account via the new endpoint**

After deployment, call:
```bash
curl -X POST https://mygplink.com.au/api/admin/va/gmail/setup \
  -H 'Content-Type: application/json' \
  -H 'Cookie: gp_admin_session=<admin-session-cookie>' \
  -d '{"user_id":"<hazel-user-uuid>","email_address":"hazel@mygplink.com.au","display_name":"Hazel"}'
```

- [ ] **Step 2: Verify watch is active**

```bash
curl https://mygplink.com.au/api/admin/va/gmail/status \
  -H 'Cookie: gp_admin_session=<admin-session-cookie>'
```

Expected: Hazel's account shows `watch_active: true` with a valid `watch_expiry`.

- [ ] **Step 3: Create labels for existing assigned cases**

Run a one-time script or manual API calls to create labels for all cases already assigned to Hazel. This is a manual post-deploy step.

---

## Deployment Checklist

- [ ] Migration applied to Supabase (Task 1)
- [ ] Google Workspace delegation updated with `gmail.modify` + `gmail.labels` scopes (Task 11)
- [ ] `hello@mygplink.com.au` exists as a real Google Workspace account
- [ ] `MASTER_ARCHIVE_EMAIL` env var set in Vercel (Task 11)
- [ ] Code deployed via `vercel --prod` (Task 11)
- [ ] Hazel's VA account registered (Task 12)
- [ ] Gmail watch renewed for all accounts (hit `/api/cron/renew-gmail-watch`)
- [ ] Test: assign a candidate to Hazel → verify label created in her Gmail + hello@
- [ ] Test: send an email from admin UI → verify label applied + hello@ copy
- [ ] Test: send email directly from Hazel's Gmail to a GP → verify auto-labeled on next cron/webhook
