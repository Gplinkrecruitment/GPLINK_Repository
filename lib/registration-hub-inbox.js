// lib/registration-hub-inbox.js
'use strict';

function previewOf(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
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
    var isPractice = !!(c.practice_name && String(c.practice_name).trim());
    var latestMsg = g.last;
    var counterparty = '';
    if (latestMsg) {
      counterparty = (latestMsg.direction === 'inbound')
        ? (latestMsg.sender || '')
        : (latestMsg.recipient || '');
    }
    return {
      caseId: g.caseId,
      threadId: g.threadId,
      name: isPractice ? c.practice_name : (c.gp_name || 'Unknown'),
      counterparty: counterparty,
      kind: isPractice ? 'practice' : 'doctor',
      stage: c.stage || '',
      assignedVa: c.assigned_va || null,
      assignedRsoName: rsoNameByUserId[c.assigned_va] || '',
      lastMessageAt: g.last ? g.last.created_at : null,
      lastPreview: g.last ? previewOf(g.last.body_text || g.last.subject) : '',
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

module.exports = { groupConversations, previewOf };
