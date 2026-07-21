// Per-task AHPRA action emails.
//
// When an s80 "more information" notice goes live for a GP, every GP-owned item
// becomes ONE email with ONE action button, mirroring the card the GP sees on
// pages/ahpra.html: "Upload document" for mode=upload, "Mark as requested" for
// mode=request_institution. Emails are staggered a minute apart (Resend
// scheduled_at) so the GP's inbox gets a clean one-task-per-email sequence, and
// every button deep-links to /pages/ahpra.html?task=<id> which scrolls to and
// highlights that exact card (the signin bounce preserves the query string).
//
// This module is pure (no I/O, no clock reads — the caller passes startAtMs) so
// it can be unit-tested directly; server.js owns the actual sending.

var STAGGER_MS = 60 * 1000; // 1 minute between emails

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// '2025-08-29' → '29 August 2025' (falls back to the raw string on anything odd).
function formatDeadline(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '').trim());
  if (!m) return String(iso || '');
  var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var mi = parseInt(m[2], 10) - 1;
  if (mi < 0 || mi > 11) return String(iso);
  return parseInt(m[3], 10) + ' ' + months[mi] + ' ' + m[1];
}

function ctaForMode(mode) {
  if (mode === 'upload') return 'Upload document';
  if (mode === 'request_institution') return 'Mark as requested';
  return 'Open your AHPRA page';
}

// tasks: [{ id, title, mode, gp_instructions, detail, how_to_steps, institution,
//           sub_items, deadline }]
// opts:  { appBaseUrl, startAtMs, reference }
// Returns one entry per task: { taskId, subject, title, bodyHtml, text, ctaText,
// ctaUrl, scheduledAt } — scheduledAt is null for the first email (send now) and
// an ISO string 1 minute apart for each one after.
function buildAhpraTaskEmailPlan(tasks, opts) {
  opts = opts || {};
  var appBaseUrl = String(opts.appBaseUrl || '').replace(/\/$/, '');
  var startAtMs = typeof opts.startAtMs === 'number' ? opts.startAtMs : 0;
  var list = Array.isArray(tasks) ? tasks.filter(function (t) { return t && t.id; }) : [];
  var total = list.length;

  return list.map(function (t, i) {
    var mode = String(t.mode || '');
    var title = String(t.title || 'AHPRA requested item').trim();
    var instruction = String(t.gp_instructions || t.detail || '').trim();
    var ctaUrl = appBaseUrl + '/pages/ahpra.html?task=' + encodeURIComponent(t.id);
    var ctaText = ctaForMode(mode);

    var parts = [];
    parts.push('Hi {{name}}, AHPRA has asked for the following item to progress your registration'
      + (opts.reference ? ' (ref ' + escapeHtml(opts.reference) + ')' : '') + ':');
    if (instruction) parts.push(escapeHtml(instruction).replace(/\n/g, '<br>'));
    // The email body is injected into a single <p> in the shared template, so
    // lists are rendered as inline "bullet" lines rather than <ul>/<ol> blocks.
    if (Array.isArray(t.sub_items) && t.sub_items.length) {
      parts.push(t.sub_items.map(function (s) {
        return '&bull; ' + escapeHtml(typeof s === 'string' ? s : (s && s.label) || '');
      }).join('<br>'));
    }
    if (Array.isArray(t.how_to_steps) && t.how_to_steps.length) {
      parts.push('<strong>How to get this:</strong><br>' +
        t.how_to_steps.map(function (s, n) { return (n + 1) + '. ' + escapeHtml(String(s || '')); }).join('<br>'));
    }
    if (mode === 'request_institution') {
      var inst = String(t.institution || '').trim() || 'the issuing institution';
      parts.push('This one is sent directly to AHPRA by ' + escapeHtml(inst) +
        ' — once you have requested it, tap the button below and mark it as requested so we can track it.');
    } else if (mode === 'upload') {
      parts.push('Tap the button below to upload the document straight to this task — our team will check it and send it on to AHPRA.');
    }
    if (t.deadline) {
      parts.push('<strong style="color:#dc2626">Please action this by ' + escapeHtml(formatDeadline(t.deadline)) + '.</strong>');
    }
    if (total > 1) {
      parts.push('<span style="color:#64748b;font-size:13px">This is task ' + (i + 1) + ' of ' + total +
        ' — each task arrives as its own email so nothing gets missed.</span>');
    }

    var textInstruction = instruction ? instruction + '\n\n' : '';
    return {
      taskId: t.id,
      subject: 'Action needed' + (total > 1 ? ' (' + (i + 1) + ' of ' + total + ')' : '') + ': ' + title + ' — GP Link',
      title: title,
      bodyHtml: parts.join('<br><br>'),
      text: 'AHPRA has asked for: ' + title + '\n\n' + textInstruction + ctaText + ': ' + ctaUrl,
      ctaText: ctaText,
      ctaUrl: ctaUrl,
      scheduledAt: i === 0 ? null : new Date(startAtMs + i * STAGGER_MS).toISOString()
    };
  });
}

module.exports = {
  STAGGER_MS: STAGGER_MS,
  buildAhpraTaskEmailPlan: buildAhpraTaskEmailPlan,
  formatDeadline: formatDeadline,
  ctaForMode: ctaForMode,
  escapeHtml: escapeHtml
};
