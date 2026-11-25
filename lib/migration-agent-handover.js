'use strict';

/**
 * Handing the doctor over to the migration agent (visa stage).
 *
 * Owner report 25 Nov 2026 (Dr Obanimoh, The Doctors Werribee, Syed Rahman at Pace Migration):
 * the practice confirmed the agent, the agent listed what he needed, and our team answered
 * "we will send the documents shortly". The send parked the card as "waiting on the practice",
 * nothing recorded that the next step was OURS, and every later request would have come
 * through us as the middle man.
 *
 * The fix is one email, on its own card: To the agent, Cc the doctor. It carries the documents
 * we already hold (so the doctor is not asked for them twice), asks the doctor to reply to the
 * agent directly with the few things only they know, and tells the agent to deal with the
 * doctor directly from here with us copied. The practice is NOT copied: passport, family and
 * English-test details are the doctor's own, and the practice has its own thread with the
 * agent for the business and sponsorship side.
 *
 * Pure helpers only (no I/O), so they are unit-testable. server.js owns the storage reads,
 * the send and the task rows.
 */

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function emailOf(value) {
  var m = String(value == null ? '' : value).match(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/);
  return m ? m[0].toLowerCase() : '';
}

/**
 * What the agent needs from the doctor's file, in the order it is listed in the email. The
 * first key of a slot that has a usable file wins, so a doctor is never sent two copies of
 * the same certificate (the onboarding upload and the certified copy prepared for AHPRA).
 */
var HANDOVER_DOC_SLOTS = [
  { slot: 'cv', label: 'CV', keys: ['cv_signed_dated', 'career_cv', 'cv'] },
  { slot: 'primary_degree', label: 'Primary medical degree', keys: ['primary_medical_degree', 'onboarding_primary_med_degree', 'primary_med_degree'] },
  { slot: 'specialist_qualification', label: 'Specialist GP qualification', keys: ['mrcgp_certified', 'micgp_certified', 'frnzcgp_certified', 'specialist_qualification', 'onboarding_specialist_qualification'] },
  { slot: 'training_completion', label: 'Certificate of completion of training', keys: ['cct_certified', 'cscst_certified', 'onboarding_cct_certificate'] },
  { slot: 'ahpra_registration', label: 'AHPRA registration notice', keys: ['ahpra_registration_notice'] },
];

var UNUSABLE_STATUSES = ['rejected', 'missing', 'deleted', 'expired', 'requested', 'flagged'];

function hasFile(row) {
  if (!row) return false;
  var path = clean(row.storage_path);
  if (path && path.toLowerCase() !== 'null' && path.toLowerCase() !== 'none') return true;
  return !!clean(row.google_drive_file_id);
}

/**
 * Pick the documents to offer on the card from the doctor's user_documents rows and (when the
 * passports were uploaded in the app) their visa_documents rows.
 *
 * @param {Array} userDocs  user_documents rows
 * @param {Array} visaDocs  visa_documents rows (passports), optional
 * @returns {Array<{source:string,id:string,slot:string,label:string,file_name:string,size:number}>}
 */
function pickHandoverDocuments(userDocs, visaDocs) {
  var rows = Array.isArray(userDocs) ? userDocs : [];
  var out = [];
  HANDOVER_DOC_SLOTS.forEach(function (slot) {
    for (var i = 0; i < slot.keys.length; i++) {
      var hit = null;
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        if (!r || r.document_key !== slot.keys[i]) continue;
        if (UNUSABLE_STATUSES.indexOf(String(r.status || '').toLowerCase()) > -1) continue;
        if (!hasFile(r)) continue;
        hit = r; break;
      }
      if (hit) {
        out.push({ source: 'user_documents', id: String(hit.id), slot: slot.slot, label: slot.label, file_name: clean(hit.file_name), size: Number(hit.file_size) || 0 });
        break;
      }
    }
  });
  (Array.isArray(visaDocs) ? visaDocs : []).forEach(function (d) {
    if (!d || String(d.document_type || '') !== 'passport') return;
    if (!clean(d.file_path)) return;
    if (UNUSABLE_STATUSES.indexOf(String(d.status || '').toLowerCase()) > -1) return;
    var label = clean(d.label) || 'Passport';
    if (/^your passport$/i.test(label)) label = 'Passport';
    out.push({ source: 'visa_documents', id: String(d.id), slot: 'passport', label: label, file_name: clean(d.original_file_name), size: 0 });
  });
  return out;
}

var MIME_EXT = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/**
 * What the file actually is, from its first bytes. The stored mime type and name cannot be
 * trusted: Dr Obanimoh's "Primary Medical Degree" row says application/pdf and has no
 * extension, but the file is a JPEG photo, which would have gone out as a broken ".pdf".
 */
function sniffMimeType(buffer) {
  if (!buffer || buffer.length < 4) return '';
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  return '';
}

/**
 * A filename the agent can file without opening it: "Dr Mercy Obanimoh - CV.pdf". Stored
 * names are often a label with no extension ("CV (Signed and dated)") or a scanner name
 * ("327488.jpg"), neither of which tells the agent what the file is.
 */
function attachmentFilename(doc, gpName, mimeType) {
  var label = clean(doc && doc.label) || 'Document';
  var stored = clean(doc && doc.file_name);
  var ext = '';
  var m = stored.match(/\.([A-Za-z0-9]{2,5})$/);
  if (m) ext = m[1].toLowerCase();
  if (!ext) ext = MIME_EXT[String(mimeType || '').toLowerCase().split(';')[0].trim()] || '';
  var base = (clean(gpName) ? 'Dr ' + clean(gpName).replace(/^dr\.?\s+/i, '') + ' - ' : '') + label;
  base = base.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base + (ext ? '.' + ext : '');
}

/**
 * Has the practice told the agent to go ahead? Deterministic twin of the AI read
 * (`agent_engaged`), so the handover card still appears with the AI off. Deliberately narrow:
 * it must be an instruction or agreement to proceed, never a question about fees or timing.
 */
function practiceConfirmedAgent(text) {
  var t = String(text == null ? '' : text);
  // Only what they wrote, not the quoted thread below it.
  var cut = t.search(/\n\s*(On .{0,120}wrote:|-{2,}\s*Original Message|From:\s.+\n\s*Sent:)/i);
  if (cut > 0) t = t.slice(0, cut);
  if (!t.trim()) return false;
  // Sentence by sentence: a question ("what are the fees before we proceed with the
  // application?"), a refusal ("do not go ahead yet") or a condition ("once we have the fees
  // we will proceed") is not a go-ahead, whatever words it shares with one.
  var sentences = t.replace(/\r/g, '').split(/(?<=[.?!])\s+|\n+/);
  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i].replace(/\s+/g, ' ').trim();
    if (!s || /\?\s*$/.test(s)) continue;
    if (/\b(not|never|no longer|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|before|until|unless|once|if|whether|hold off|wait)\b/i.test(s)) continue;
    if (/\b(please|kindly)\s+(start|proceed|go ahead|begin|commence)\b/i.test(s)
      || /\b(happy|pleased|glad|keen)\s+(for\s+[^.?!]{1,60}\s+)?to\s+(progress|proceed|go ahead|engage|use|start)\b/i.test(s)
      || /\b(go ahead|proceed)\s+with\s+(the\s+)?(application|nomination|visa|sponsorship|process)/i.test(s)
      || /\bwe\s+(would like|wish|want|are happy|have decided|will)\s+to\s+(proceed|go ahead|engage|use)\b/i.test(s)
      || /\b(we have|we've|i have|i've)\s+(engaged|signed|appointed)\b/i.test(s)) return true;
  }
  return false;
}

function greetingFor(name, fallback) {
  var n = clean(name).replace(/\s*\(.*\)\s*$/, '').replace(/,.*$/, '');
  var first = n.split(' ')[0] || '';
  if (!first || /@/.test(first)) return fallback;
  return first;
}

/**
 * What only the doctor can tell the agent. Passports are asked for only when we are not
 * already attaching them.
 */
function gpAskItems(params) {
  var items = ['Your date of birth and the country of your passport'];
  var n = Number(params.passportCount) || 0;
  // One attached passport is the doctor's own: the family's are still needed.
  if (!n) items.push(params.familyMoving ? 'A copy of the passport photo page for you and for each family member coming with you' : 'A copy of your passport photo page');
  else if (n === 1 && params.familyMoving) items.push('A copy of the passport photo page for each family member coming with you');
  items.push('Your English language test result, if you have sat one. If you have not, please let ' + params.agentFirst + ' know');
  if (params.familyMoving !== false) items.push('The family members to be included in your visa application, and whether any of them are already in Australia');
  return items;
}

/**
 * The handover email.
 *
 * @param {Object} p
 * @param {string} p.gpFirstName / p.gpLastName / p.gpEmail
 * @param {string} p.agentName   "Syed Rahman (Pace Migration)" or a firm name
 * @param {string} p.agentEmail
 * @param {string} p.practiceName
 * @param {string} p.registrationNumber  AHPRA number, optional
 * @param {string} p.commencement        planned start, already formatted, optional
 * @param {string} p.whoMoving           profile who_moving (just_me | me_partner | ...), optional
 * @param {Array}  p.documents           from pickHandoverDocuments
 * @param {string} p.senderName          first name of the coordinator
 * @returns {{to,cc,subject,bodyText,bodyHtml}}
 */
function buildHandoverDraft(p) {
  p = p || {};
  var gpLast = clean(p.gpLastName), gpFirst = clean(p.gpFirstName);
  var dr = 'Dr ' + (gpLast || gpFirst || 'the doctor');
  var drFull = 'Dr ' + (clean(gpFirst + ' ' + gpLast) || 'the doctor');
  var agentName = clean(p.agentName);
  var agentFirst = greetingFor(agentName, 'there');
  var agentRef = agentFirst === 'there' ? 'the migration agent' : agentFirst;
  var practice = clean(p.practiceName);
  var docs = Array.isArray(p.documents) ? p.documents : [];
  var who = String(p.whoMoving || '').toLowerCase();
  var familyMoving = who ? who !== 'just_me' : null;
  var asks = gpAskItems({ agentFirst: agentRef, passportCount: docs.filter(function (d) { return d.slot === 'passport'; }).length, familyMoving: familyMoving });
  var sender = clean(p.senderName) || 'GP Link';

  var lines = [];
  lines.push('Hi ' + agentFirst + ',');
  lines.push('');
  if (docs.length) {
    lines.push('Please find attached ' + dr + '\'s documents for the Subclass 482 application' + (practice ? ' with ' + practice : '') + ':');
    lines.push('');
    docs.forEach(function (d, i) { lines.push((i + 1) + '. ' + d.label); });
  } else {
    lines.push('We support ' + dr + '\'s registration and relocation' + (practice ? ' to ' + practice : '') + ', and we are writing to put you in touch with ' + dr + ' directly for the Subclass 482 application.');
  }
  var facts = [];
  if (clean(p.registrationNumber)) facts.push(dr + ' holds AHPRA registration ' + clean(p.registrationNumber));
  if (clean(p.commencement)) facts.push('the planned start date is ' + clean(p.commencement));
  if (facts.length) { lines.push(''); lines.push(facts.join(' and ').replace(/^./, function (c) { return c.toUpperCase(); }) + '.'); }
  lines.push('');
  lines.push(dr + ' is copied on this email so the two of you can work together directly from here.');
  lines.push('');
  lines.push(dr + ', ' + (agentName ? agentName.replace(/\s*\(([^)]+)\)\s*$/, ' from $1') : 'the agent copied here') + ' is the registered migration agent looking after your visa. Could you please reply to ' + agentRef + ' directly on this email with the following:');
  lines.push('');
  asks.forEach(function (a, i) { lines.push((i + 1) + '. ' + a); });
  lines.push('');
  lines.push((agentFirst === 'there' ? 'Please' : agentFirst + ', please') + ' contact ' + dr + ' directly for anything further you need, and keep us copied so we can help where needed.');
  lines.push('');
  lines.push('Warm regards,');
  lines.push(sender);
  lines.push('GP Link');

  var bodyText = lines.join('\n');
  return {
    to: emailOf(p.agentEmail),
    cc: emailOf(p.gpEmail),
    subject: drFull + ', Subclass 482 visa: documents and next steps',
    bodyText: bodyText,
    bodyHtml: textToHtml(bodyText),
  };
}

function textToHtml(text) {
  return escHtml(String(text == null ? '' : text)).replace(/\r?\n/g, '<br>');
}

/**
 * A reply landed on the handover thread. Does it need US, or is it the doctor and the agent
 * talking to each other with us copied (which is the whole point of the handover)?
 *
 * Needs us when: we are addressed directly (our mailbox is in To, not only Cc), the sender is
 * neither the doctor nor the agent, or the message names us or our coordinator.
 *
 * @param {Object} p { sender, to, cc, text, ownAddresses:[...], parties:[gp, agent emails], names:[...] }
 */
function handoverReplyNeedsUs(p) {
  p = p || {};
  var own = (p.ownAddresses || []).map(function (a) { return String(a || '').toLowerCase(); }).filter(Boolean);
  var isOwn = function (addr) {
    if (!addr) return false;
    if (own.indexOf(addr) > -1) return true;
    return /@mygplink\.com\.au$/.test(addr);
  };
  var list = function (v) { return (String(v == null ? '' : v).match(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/g) || []).map(function (a) { return a.toLowerCase(); }); };
  var sender = emailOf(p.sender);
  var parties = (p.parties || []).map(function (a) { return String(a || '').toLowerCase(); }).filter(Boolean);
  if (!sender || parties.indexOf(sender) === -1) return { needsUs: true, reason: 'someone_new' };
  var to = list(p.to), cc = list(p.cc);
  // No recipient lines at all: we cannot tell, so a person looks at it.
  if (!to.length && !cc.length) return { needsUs: true, reason: 'unknown_recipients' };
  // To us and nobody else on the email. (A reply-all to our handover email puts us alone in
  // To with the other party on Cc: that is still the two of them talking, and the name check
  // below catches it when it is really meant for us.)
  var othersInCc = cc.some(function (a) { return !isOwn(a) && a !== sender; });
  if (to.some(isOwn) && !to.some(function (a) { return !isOwn(a); }) && !othersInCc) return { needsUs: true, reason: 'addressed_to_us' };
  var text = String(p.text == null ? '' : p.text);
  var cut = text.search(/\n\s*(On .{0,120}wrote:|-{2,}\s*Original Message|From:\s.+\n\s*Sent:)/i);
  if (cut > 0) text = text.slice(0, cut);
  var names = ['gp link', 'gplink'].concat((p.names || []).map(function (n) { return clean(n).toLowerCase(); }).filter(function (n) { return n.length > 2; }));
  var lower = text.toLowerCase();
  for (var i = 0; i < names.length; i++) {
    if (new RegExp('(^|[^a-z])' + names[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(lower)) return { needsUs: true, reason: 'mentions_us' };
  }
  return { needsUs: false, reason: 'between_them' };
}

/** Kept well under Gmail's message limit (base64 adds a third) and the serverless memory budget. */
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

module.exports = {
  HANDOVER_DOC_SLOTS: HANDOVER_DOC_SLOTS,
  MAX_ATTACHMENT_BYTES: MAX_ATTACHMENT_BYTES,
  pickHandoverDocuments: pickHandoverDocuments,
  attachmentFilename: attachmentFilename,
  sniffMimeType: sniffMimeType,
  practiceConfirmedAgent: practiceConfirmedAgent,
  buildHandoverDraft: buildHandoverDraft,
  handoverReplyNeedsUs: handoverReplyNeedsUs,
  textToHtml: textToHtml,
  emailOf: emailOf,
};
