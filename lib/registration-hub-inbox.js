// lib/registration-hub-inbox.js
'use strict';

function previewOf(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

// Strip HTML tags to plain text for a list preview (when a message has only body_html).
function stripHtmlPreview(html) {
  if (!html) return '';
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}

// Extract the bare email address from a value that may be "Name <addr>" or just "addr".
function addrOf(value) {
  var s = String(value == null ? '' : value).trim();
  var m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// Decide whether a single conversation/thread is with the doctor or with the
// practice, by who its counterparty actually is — NOT by whether the case has a
// practice at all. A candidate with a secured placement still has separate
// GP-facing threads; those must read as the doctor, not the practice. We compare
// the thread's counterparty to the candidate's own email; on a practice case,
// anything that isn't the candidate is treated as the practice. Used by both the
// Inbox conversation list and the thread-detail header so they never disagree.
function classifyThread(opts) {
  opts = opts || {};
  var hasPractice = !!(opts.practiceName && String(opts.practiceName).trim());
  var cpAddr = addrOf(opts.counterparty);
  var gpAddr = addrOf(opts.gpEmail);
  var isDoctorThread = (cpAddr && gpAddr) ? (cpAddr === gpAddr) : !hasPractice;
  var isPractice = hasPractice && !isDoctorThread;
  return {
    isPractice: isPractice,
    kind: isPractice ? 'practice' : 'doctor',
    name: isPractice ? String(opts.practiceName) : (opts.gpName || 'Unknown')
  };
}

function groupConversations(opts) {
  opts = opts || {};
  var messages = opts.messages || [];
  var casesById = opts.casesById || {};
  var rsoNameByUserId = opts.rsoNameByUserId || {};
  var scope = opts.scope === 'mine' ? 'mine' : 'all';
  var meUserId = opts.meUserId || null;

  // Key by gmail_thread_id when present; fall back to a per-case bucket for null/empty threads.
  var byThread = {};
  messages.forEach(function (m) {
    var cid = m.case_id;
    if (!cid || !casesById[cid]) return;
    var threadKey = m.gmail_thread_id || ('case:' + cid);
    var threadId = m.gmail_thread_id || '';
    if (!byThread[threadKey]) {
      byThread[threadKey] = { caseId: cid, threadId: threadId, last: null, unread: false };
    }
    var g = byThread[threadKey];
    if (!g.last || new Date(m.created_at) >= new Date(g.last.created_at)) g.last = m;
    if (m.direction === 'inbound' && !m.read_at) g.unread = true;
  });

  var out = Object.keys(byThread).map(function (key) {
    var g = byThread[key];
    var c = casesById[g.caseId];
    var latestMsg = g.last;
    var counterparty = '';
    if (latestMsg) {
      counterparty = (latestMsg.direction === 'inbound')
        ? (latestMsg.sender || '')
        : (latestMsg.recipient || '');
    }
    var cls = classifyThread({
      counterparty: counterparty, gpEmail: c.gp_email,
      practiceName: c.practice_name, gpName: c.gp_name
    });
    return {
      caseId: g.caseId,
      threadId: g.threadId,
      name: cls.name,
      counterparty: counterparty,
      kind: cls.kind,
      stage: c.stage || '',
      assignedVa: c.assigned_va || null,
      assignedRsoName: rsoNameByUserId[c.assigned_va] || '',
      lastMessageAt: g.last ? g.last.created_at : null,
      lastPreview: g.last ? previewOf(g.last.body_text || stripHtmlPreview(g.last.body_html) || g.last.subject) : '',
      lastSubject: g.last ? (g.last.subject || '') : '',
      lastDirection: g.last ? g.last.direction : null,
      needsReply: g.last ? g.last.direction === 'inbound' : false,
      unread: g.unread
    };
  });

  if (scope === 'mine' && meUserId) {
    out = out.filter(function (x) { return x.assignedVa === meUserId; });
  }
  out.sort(function (a, b) {
    return new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0);
  });
  return out;
}

module.exports = { groupConversations, previewOf, classifyThread, addrOf };
