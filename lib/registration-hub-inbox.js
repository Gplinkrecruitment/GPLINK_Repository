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
// practice, by who its counterparty actually is, NOT by whether the case has a
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

// Strip the reply/forward prefixes a mail client stacks onto a subject line, so
// "Re: Fwd: RE: AHPRA docs" and "AHPRA docs" land in the same thread bucket.
function normalizeSubject(value) {
  var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  var prev = null;
  while (s !== prev) {
    prev = s;
    s = s.replace(/^\s*(re|fwd|fw|aw|antw)\s*(\[\d+\])?\s*:\s*/i, '');
  }
  return s.trim().toLowerCase();
}

// Split ONE conversation's messages into the separate email threads inside it.
// A case conversation is a mixed bag: real Gmail threads (grouped by gmail_thread_id)
// plus one-off notifications we sent with no Gmail thread at all ("Document verified",
// "Re-upload requested"), which are only relatable by subject. The Inbox shows each of
// those as its own collapsible thread, titled by the FIRST subject in the thread (what
// it was originally about) and repliable to the right party, instead of one flat list.
//
// messages must be sorted oldest → newest. Groups come back least-recently-active first,
// so the thread with the newest message sits at the bottom, right next to the composer.
function groupThreadMessages(opts) {
  opts = opts || {};
  var messages = Array.isArray(opts.messages) ? opts.messages : [];
  var fallbackTo = String(opts.fallbackTo || '').trim();

  var byKey = {};
  var order = [];
  messages.forEach(function (m, idx) {
    if (!m) return;
    var subjectKey = normalizeSubject(m.subject);
    // No gmail thread AND no subject → nothing to group on; keep it standalone rather
    // than pooling every blank-subject email into one meaningless thread.
    var key = m.gmail_thread_id
      ? ('gt:' + m.gmail_thread_id)
      : (subjectKey ? ('subj:' + subjectKey) : ('msg:' + (m.id || idx)));
    if (!byKey[key]) {
      byKey[key] = {
        key: key,
        threadId: m.gmail_thread_id || '',
        subject: String(m.subject || '').trim(),   // first subject seen = what the thread was about
        messages: [],
        unread: false
      };
      order.push(key);
    }
    var g = byKey[key];
    if (!g.threadId && m.gmail_thread_id) g.threadId = m.gmail_thread_id;
    if (!g.subject && m.subject) g.subject = String(m.subject).trim();
    if (m.direction === 'inbound' && !m.read_at) g.unread = true;
    g.messages.push(m);
  });

  // Second pass: unite a subject-keyed group with the REAL Gmail thread that answers it.
  // Our automated notifications go out via Resend with no Gmail thread id, but when the
  // doctor replies to one, the reply arrives through Gmail WITH a thread id and a
  // "Re: <same subject>". Without this pass the notification and its answer would render
  // as two separate threads.
  var gtBySubject = {};
  order.forEach(function (key) {
    if (key.indexOf('gt:') !== 0) return;
    var g = byKey[key];
    for (var gi = 0; gi < g.messages.length; gi++) {
      var ns = normalizeSubject(g.messages[gi].subject);
      if (ns && !gtBySubject[ns]) gtBySubject[ns] = key;
    }
  });
  order = order.filter(function (key) {
    if (key.indexOf('subj:') !== 0) return true;
    var gtKey = gtBySubject[key.slice(5)];
    if (!gtKey) return true;
    var src = byKey[key], dst = byKey[gtKey];
    dst.messages = dst.messages.concat(src.messages).sort(function (a, b) {
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });
    dst.unread = dst.unread || src.unread;
    // Re-title from the (possibly new) earliest message, the thread is "about" whatever
    // was sent first, which after a merge may be the notification, not the Gmail reply.
    dst.subject = String((dst.messages[0] && dst.messages[0].subject) || dst.subject || '').trim();
    delete byKey[key];
    return false;
  });

  return order.map(function (key) {
    var g = byKey[key];
    var latest = g.messages[g.messages.length - 1] || null;
    g.latestAt = latest ? latest.created_at : null;
    // Who a reply goes to: the other party in THIS thread, the last person who wrote to
    // us, or the last person we wrote to. The case default is used only when the thread
    // has no counterparty of its own on any message.
    var to = '';
    for (var i = g.messages.length - 1; i >= 0 && !to; i--) {
      var m = g.messages[i];
      to = (m.direction === 'inbound') ? (m.sender || '') : (m.recipient || '');
    }
    if (!to) to = fallbackTo;
    // In-Reply-To can only come from a message we actually stored an RFC822 id for,
    // newest wins. Threads with none (our Resend notifications) cannot be threaded and
    // are sent as a fresh "Re: …" email instead; the caller decides that.
    var inReplyTo = '';
    var latestTaskId = null;
    for (var j = g.messages.length - 1; j >= 0; j--) {
      var mm = g.messages[j];
      if (!inReplyTo && mm.rfc822_message_id) inReplyTo = mm.rfc822_message_id;
      if (!latestTaskId && mm.task_id) latestTaskId = mm.task_id;
    }
    return {
      key: g.key,
      threadId: g.threadId,
      subject: g.subject || '(no subject)',
      count: g.messages.length,
      messages: g.messages,
      latestAt: latest ? latest.created_at : null,
      latestDirection: latest ? latest.direction : null,
      to: to,
      inReplyTo: inReplyTo,
      latestTaskId: latestTaskId,
      unread: g.unread
    };
  }).sort(function (a, b) {
    return new Date(a.latestAt || 0) - new Date(b.latestAt || 0);
  });
}

module.exports = { groupConversations, previewOf, classifyThread, addrOf, normalizeSubject, groupThreadMessages };
