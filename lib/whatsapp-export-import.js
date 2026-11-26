'use strict';

// Plans what a WhatsApp Business Web export (the owner's personal number,
// exported from the browser) changes on the Pipeline board. Pure: takes the
// parsed export + the existing whatsapp_personal pipeline_people rows and
// returns the inserts/patches; the route performs them.
//
// Export shape: { exportedAt: 'Mon Nov 23 2026 21:46:44 GMT+0800 (…)', source,
//   chatCount, messageCount, chats: [{ chat, id, isGroup, messageCount,
//   messages: [{ time: 'YYYY-MM-DD HH:MM', from: 'Me' | name, type, text, media }] }] }
// `time` is wall-clock in the owner's zone at export time; the offset comes
// from the exportedAt header.
//
// Rules (owner 26 Nov 2026):
//   * only "Dr …" chats, or 1:1 chats with a reply and doctor talk in them;
//   * never groups (id @g.us), WhatsApp Business / WhatsApp Support, or
//     unknown numbers with no doctor content;
//   * an existing row only gets last_message_at / _from / _snippet (and the
//     phone when the chat title is a number) — owner-entered fields are never
//     touched;
//   * a new row is created only when the doctor replied in the last 60 days,
//     stage 'warm' (no flood of cold leads).

var DAY_MS = 86400000;
var NEW_ROW_REPLY_WINDOW_MS = 60 * DAY_MS;
var SNIPPET_MAX = 160;
var SYSTEM_CHATS = /^(whatsapp business|whatsapp support|whatsapp|meta ai)$/i;
var DOCTOR_CONTENT = /\b(gp|g\.p\.|doctor|dr\.?|ahpra|mrcgp|rcgp|gmc|amc|practice|surgery|registration|visa|locum|cv|consult(ation)?|australia|clinic|medical)\b/i;
var PHONE_TITLE = /^\+?[\d\s()-]{8,}$/;

function str(v) { return v == null ? '' : String(v); }

// Offset in minutes east of UTC from 'GMT+0800' / 'GMT-05:30' / 'UTC+8'.
// null when the header carries none.
function parseOffsetMinutes(exportedAt) {
  var m = /(?:GMT|UTC)\s*([+-])(\d{1,2}):?(\d{2})?/.exec(str(exportedAt));
  if (!m) return null;
  var mins = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === '-' ? -mins : mins;
}
// 'Mon Nov 23 2026 21:46:44 GMT+0800 (Central Indonesia Time)' → ISO.
function parseExportedAt(exportedAt) {
  var s = str(exportedAt).replace(/\s*\([^)]*\)\s*$/, '');
  var t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  var m = /(\w{3}) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  var off = parseOffsetMinutes(exportedAt);
  if (!m) return null;
  var months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  if (!(m[1] in months)) return null;
  var utc = Date.UTC(Number(m[3]), months[m[1]], Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6])) - (off || 0) * 60000;
  return new Date(utc).toISOString();
}
// 'YYYY-MM-DD HH:MM' at offset → epoch ms (NaN when unreadable).
function parseLocalTime(time, offsetMinutes) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str(time).trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)) - (offsetMinutes || 0) * 60000;
}

function snippetOf(msg) {
  var t = str(msg && msg.text).replace(/\s+/g, ' ').trim();
  if (!t) {
    var kind = str((msg && (msg.media || msg.type)) || '');
    t = kind === 'call_log' ? '[call]' : kind === 'ptt' ? '[voice note]' : kind === 'revoked' ? '[deleted message]' : kind ? '[' + kind.replace(/_/g, ' ') + ']' : '';
  }
  return t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX - 1).trimEnd() + '…' : t;
}
function phoneFromTitle(title) {
  var t = str(title).trim();
  if (!PHONE_TITLE.test(t)) return '';
  var d = t.replace(/\D/g, '');
  return d.length >= 8 ? '+' + d : '';
}

// Is this chat one the board should know about? Returns a reason string when not.
function skipReason(chat) {
  var name = str(chat && chat.chat).trim();
  var id = str(chat && chat.id);
  if (!chat || !id) return 'no_id';
  if (/@g\.us$/i.test(id) || chat.isGroup === true) return 'group';
  if (SYSTEM_CHATS.test(name) || id === '0@c.us') return 'system';
  var msgs = Array.isArray(chat.messages) ? chat.messages : [];
  if (!msgs.length) return 'empty';
  if (/^dr\.?\s/i.test(name) || /^dr\.?$/i.test(name)) return '';
  var fromThem = msgs.filter(function (m) { return str(m.from) !== 'Me'; });
  if (!fromThem.length) return 'no_reply';
  var talk = msgs.map(function (m) { return str(m.text); }).join(' ');
  if (!DOCTOR_CONTENT.test(talk)) return 'not_doctor';
  return '';
}

// existing: pipeline_people rows with source 'whatsapp_personal' (id, source_ref,
// last_message_at, phone …). Returns { exportedAtIso, offsetMinutes, creates,
// updates: [{ id, patch }], skipped, skippedBy, unchanged }.
function planWhatsappImport(exportJson, existing, nowMs) {
  var ex = exportJson && typeof exportJson === 'object' ? exportJson : {};
  var now = Number(nowMs) || Date.now();
  var offset = parseOffsetMinutes(ex.exportedAt);
  var exportedAtIso = parseExportedAt(ex.exportedAt);
  var byRef = {};
  (Array.isArray(existing) ? existing : []).forEach(function (r) { if (r && r.source_ref) byRef[str(r.source_ref)] = r; });
  var out = { exportedAtIso: exportedAtIso, offsetMinutes: offset, creates: [], updates: [], skipped: 0, skippedBy: {}, unchanged: 0 };
  var skip = function (why) { out.skipped++; out.skippedBy[why] = (out.skippedBy[why] || 0) + 1; };
  var chats = Array.isArray(ex.chats) ? ex.chats : [];
  var seen = {};
  chats.forEach(function (chat) {
    var why = skipReason(chat);
    if (why) { skip(why); return; }
    var ref = str(chat.id);
    if (seen[ref]) { skip('duplicate'); return; }
    seen[ref] = true;
    var msgs = chat.messages.map(function (m, i) { return { m: m, t: parseLocalTime(m.time, offset), i: i }; })
      .filter(function (x) { return Number.isFinite(x.t); })
      .sort(function (a, b) { return a.t - b.t || a.i - b.i; });
    if (!msgs.length) { skip('no_times'); return; }
    var last = msgs[msgs.length - 1];
    var lastThem = msgs.filter(function (x) { return str(x.m.from) !== 'Me'; }).pop() || null;
    var patch = {
      last_message_at: new Date(last.t).toISOString(),
      last_message_from: str(last.m.from) === 'Me' ? 'me' : 'them',
      last_message_snippet: snippetOf(last.m) || null
    };
    var phone = phoneFromTitle(chat.chat);
    var row = byRef[ref];
    if (row) {
      // Never move a row backwards with an older export.
      var have = Date.parse(str(row.last_message_at));
      if (Number.isFinite(have) && have > last.t) { out.unchanged++; return; }
      if (phone && !str(row.phone)) patch.phone = phone;
      if (Number.isFinite(have) && have === last.t && str(row.last_message_from) === patch.last_message_from && str(row.last_message_snippet) === str(patch.last_message_snippet) && !patch.phone) { out.unchanged++; return; }
      out.updates.push({ id: row.id, patch: patch });
      return;
    }
    if (!lastThem || (now - lastThem.t) > NEW_ROW_REPLY_WINDOW_MS) { skip('cold'); return; }
    out.creates.push(Object.assign({
      name: str(chat.chat).trim().slice(0, 200), phone: phone || null, stage: 'warm', source: 'whatsapp_personal', source_ref: ref
    }, patch));
  });
  return out;
}

module.exports = {
  planWhatsappImport: planWhatsappImport,
  parseOffsetMinutes: parseOffsetMinutes,
  parseExportedAt: parseExportedAt,
  parseLocalTime: parseLocalTime,
  skipReason: skipReason,
  snippetOf: snippetOf,
  NEW_ROW_REPLY_WINDOW_MS: NEW_ROW_REPLY_WINDOW_MS
};
