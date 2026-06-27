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

  var byCase = {};
  messages.forEach(function (m) {
    var cid = m.case_id;
    if (!cid || !casesById[cid]) return;
    if (!byCase[cid]) byCase[cid] = { caseId: cid, last: null, unread: false };
    var g = byCase[cid];
    if (!g.last || new Date(m.created_at) >= new Date(g.last.created_at)) g.last = m;
    if (m.direction === 'inbound' && !m.read_at) g.unread = true;
  });

  var out = Object.keys(byCase).map(function (cid) {
    var g = byCase[cid];
    var c = casesById[cid];
    var isPractice = !!(c.practice_name && String(c.practice_name).trim());
    return {
      caseId: cid,
      name: isPractice ? c.practice_name : (c.gp_name || 'Unknown'),
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
