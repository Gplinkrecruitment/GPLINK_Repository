'use strict';

/*
 * The two drafts the RSO sends with one click once AHPRA grants a doctor's
 * registration:
 *   1. buildPracticeRegistrationEmail  - congratulate the practice, ask them to
 *      engage a registered migration agent for the Subclass 482 nomination/visa.
 *   2. buildGpPassportRequest          - congratulate the doctor, explain what
 *      happens next, ask for the passports (doctor + partner + children) and
 *      carry the matching WhatsApp template placeholders.
 *
 * Owner style rule: no dashes anywhere in the copy (not even hyphens), warm and
 * plain, and never "Hi X, <sender> here". Pure: no I/O, no clock reads.
 */

var reg = require('./ahpra-registration-granted.js');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

// The owner's rule is "no dashes": any hyphen or dash a data value drags in (a practice
// called "Co-op Medical", a level written "Indirect-2") is turned into a space.
function noDashes(s) {
  return clean(String(s == null ? '' : s).replace(/[-‐-―−]+/g, ' '));
}

function firstName(name) {
  var n = clean(name);
  return n ? n.split(' ')[0] : '';
}

// How to greet the practice contact. "Dr Chamira Ranatunga" -> "Dr Ranatunga" (the first
// draft for Dr Obanimoh opened "Hi Dr," because the title was read as a first name);
// "Naomi Milne" -> "Naomi"; a role in the name field ("Practice Manager") -> "" so the
// email opens "Hi there," rather than "Hi Practice,".
function greetingName(name) {
  var n = clean(name);
  if (!n) return '';
  var m = n.match(/^(dr|doctor|prof|professor)\.?\s+(.+)$/i);
  if (m) {
    var parts = m[2].trim().split(' ');
    return noDashes((/^prof/i.test(m[1]) ? 'Prof' : 'Dr') + ' ' + parts[parts.length - 1]);
  }
  if (/\b(manager|reception|receptionist|administrator|admin|coordinator|team|office)\b/i.test(n)) return '';
  return noDashes(firstName(n));
}

// "Dr Mercy Obanimoh" for the first mention, "Dr Obanimoh" after.
function doctorNames(ctx) {
  var first = clean(ctx.gpFirstName);
  var last = clean(ctx.gpLastName);
  var full = clean(ctx.gpName) || clean(first + ' ' + last);
  if (!last && full) last = full.split(' ').slice(-1)[0];
  var short = last ? 'Dr ' + last : (full ? 'Dr ' + full : 'the doctor');
  var long = full ? 'Dr ' + full : short;
  return { full: full, first: first, last: last, short: short, long: long };
}

function longDate(iso) { return iso ? reg.formatDateLong(iso) : ''; }

// Plain paragraphs -> the simplest HTML (no inline styles, so the markup itself carries no dashes).
function paragraphsToHtml(paragraphs) {
  return paragraphs.map(function (p) {
    return '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
}

/**
 * ctx: { practiceName, contactName, contactEmail, cc, gpFirstName, gpLastName, gpName,
 *        registrationNumber, registrationType, effectiveDate, expiryDate, hasConditions,
 *        supervisionLevel, supervisorName, commencementDate, practiceCoversVisaCosts,
 *        senderName }
 * -> { to, cc, subject, bodyHtml, bodyText }
 */
function buildPracticeRegistrationEmail(ctx) {
  ctx = ctx || {};
  var dr = doctorNames(ctx);
  var practice = noDashes(ctx.practiceName) || 'your practice';
  var contactFirst = greetingName(ctx.contactName);
  var number = noDashes(ctx.registrationNumber);
  var regType = noDashes(ctx.registrationType || 'specialist registration').toLowerCase();
  if (!/registration/.test(regType)) regType += ' registration';
  var effective = longDate(ctx.effectiveDate);
  var expiry = longDate(ctx.expiryDate);
  var level = noDashes(ctx.supervisionLevel);
  var supervisor = noDashes(ctx.supervisorName);
  var commencement = longDate(ctx.commencementDate);
  var sender = noDashes(ctx.senderName) || 'The GP Link team';
  var drShort = noDashes(dr.short);
  var drLong = noDashes(dr.long);

  var paragraphs = [];
  paragraphs.push('Hi ' + (contactFirst || 'there') + ',');

  var p1 = 'Wonderful news. AHPRA has approved ' + drLong + '’s ' + regType + '.';
  if (number) p1 += ' The registration number is ' + number;
  if (number && effective) p1 += ' and it is effective from ' + effective + '.';
  else if (number) p1 += '.';
  else if (effective) p1 += ' It is effective from ' + effective + '.';
  if (expiry) p1 += ' It stays current until ' + expiry + '.';
  paragraphs.push(p1);

  if (ctx.hasConditions !== false && (level || supervisor || commencement)) {
    var p2 = 'The registration is granted with conditions: supervised practice';
    if (level) p2 += ' at ' + level + ' level';
    if (supervisor) p2 += ' under ' + supervisor;
    if (commencement) p2 += ', with commencement planned for ' + commencement;
    p2 += '.';
    paragraphs.push(p2);
  } else if (ctx.hasConditions) {
    paragraphs.push('The registration is granted with conditions, which we will walk through with ' + drShort + '.');
  }

  paragraphs.push('The next step is the visa. Could you please engage a registered migration agent to prepare the Subclass 482 nomination for ' + practice + ' and lodge ' + drShort + '’s visa? Once you have chosen the agent, simply reply to this email with their name and email address and we will connect them with ' + drShort + ' and share the documents they need.');

  if (commencement) {
    paragraphs.push('The visa must be granted before ' + drShort + ' can start on ' + commencement + ', so the sooner the agent is engaged the more room there is in the timeline.');
  } else {
    paragraphs.push('The visa must be granted before ' + drShort + ' can start, so the sooner the agent is engaged the more room there is in the timeline.');
  }

  if (ctx.practiceCoversVisaCosts) {
    paragraphs.push('As set out in the offer, ' + practice + ' covers the visa costs for ' + drShort + ' as the primary applicant. The agent can invoice the practice directly.');
  }

  paragraphs.push('One thing to note for later: AHPRA asks for supervision reports at three months and six months after commencement. We will remind you closer to the time.');
  paragraphs.push('Thank you for everything so far. We are delighted to have reached this milestone with you.');
  paragraphs.push('Warm regards,\n' + sender + '\nGP Link');

  var subject = noDashes(drLong + ' AHPRA registration approved, next step is the visa');
  var bodyText = paragraphs.join('\n\n');
  return {
    to: clean(ctx.contactEmail),
    cc: clean(ctx.cc),
    subject: subject,
    bodyHtml: paragraphsToHtml(paragraphs),
    bodyText: bodyText
  };
}

// ["Your passport", "Partner's passport", "Child 1 passport", ...]
function passportPeopleLabels(whoMoving, childrenCount) {
  var deps = reg.dependantsFromHousehold(whoMoving, childrenCount);
  return ['Your passport'].concat(deps.map(function (d) { return d.label; }));
}

function describeHousehold(whoMoving, childrenCount) {
  var deps = reg.dependantsFromHousehold(whoMoving, childrenCount);
  var partner = deps.some(function (d) { return d.relationship === 'spouse'; });
  var kids = deps.filter(function (d) { return d.relationship === 'child'; }).length;
  var parts = ['you'];
  if (partner) parts.push('your partner');
  if (kids === 1) parts.push('your child');
  else if (kids > 1) parts.push('your ' + kids + ' children');
  if (parts.length === 1) return 'you';
  if (parts.length === 2) return parts[0] + ' and ' + parts[1];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/**
 * ctx: { gpFirstName, gpLastName, gpName, practiceName, registrationNumber, effectiveDate,
 *        whoMoving, childrenCount, appBaseUrl, senderName }
 * -> { email: { subject, title, body, ctaText, ctaUrl }, whatsapp: { templateName, placeholders }, people: [...] }
 */
function buildGpPassportRequest(ctx) {
  ctx = ctx || {};
  var dr = doctorNames(ctx);
  var first = noDashes(dr.first) || 'Doctor';
  var practice = noDashes(ctx.practiceName) || 'Your practice';
  var number = noDashes(ctx.registrationNumber);
  var effective = longDate(ctx.effectiveDate);
  var sender = noDashes(firstName(ctx.senderName)) || 'The GP Link team';
  var base = String(ctx.appBaseUrl || '').replace(/\/+$/, '');
  var visaUrl = base + '/pages/visa';
  var people = passportPeopleLabels(ctx.whoMoving, ctx.childrenCount);
  var household = describeHousehold(ctx.whoMoving, ctx.childrenCount);

  var lines = [];
  var p1 = 'AHPRA has approved your specialist registration.';
  if (number) p1 += ' Your registration number is ' + number;
  if (number && effective) p1 += ' and it is effective from ' + effective + '.';
  else if (number) p1 += '.';
  else if (effective) p1 += ' It is effective from ' + effective + '.';
  lines.push(p1);
  lines.push('What happens next');
  lines.push(practice + ' is engaging a registered migration agent to sponsor your Subclass 482 visa. The agent prepares the nomination with the practice and lodges the visa. You do not need to lodge anything yourself.');
  lines.push('What we need from you now');
  lines.push('Please upload a clear colour scan or photo of the passport photo page for ' + household + ':');
  lines.push(people.map(function (p) { return '• ' + p; }).join('\n'));
  lines.push('Use the passport each person will travel on. You can upload these on your visa page in the app, it only takes a minute.');
  lines.push('If your family situation has changed since you told us who is moving with you, just reply to this email and I will update the request.');
  lines.push('Warm regards,\n' + sender + '\nGP Link');

  var subjectName = noDashes(dr.last ? 'Dr ' + dr.last : first);
  return {
    email: {
      subject: 'Congratulations ' + subjectName + ', your AHPRA registration is approved',
      title: 'Congratulations, {{name}}!',
      body: lines.join('\n\n'),
      ctaText: 'Open your visa page',
      ctaUrl: visaUrl
    },
    whatsapp: {
      templateName: 'gp_link_visa_passports',
      placeholders: [first, visaUrl]
    },
    people: people
  };
}

// ── Reminder: the first request has gone, some passports are still missing ──

var PASSPORT_REMINDER_TEMPLATE = 'gp_link_visa_passports_reminder';

// Which passport request rows are still outstanding. A row is received once a file has been
// uploaded against it (uploaded / approved / verified); 'missing' and 'rejected' still need
// the doctor. Older cases with no request rows fall back to the labels the card was created
// with, all treated as outstanding.
function passportStatusSummary(rows, fallbackPeople) {
  var list = Array.isArray(rows) ? rows.filter(function (r) { return r && (String(r.document_type || '') === 'passport' || r.label); }) : [];
  var people = list.map(function (r) {
    var status = String(r.status || '').toLowerCase();
    var received = !!r.file_path || status === 'uploaded' || status === 'approved' || status === 'verified' || r.verified === true;
    if (status === 'rejected') received = false;
    return {
      id: r.id || null,
      label: String(r.label || (r.dependant_id ? 'Family passport' : 'Your passport')),
      dependant_id: r.dependant_id || null,
      status: received ? (status === 'approved' || status === 'verified' || r.verified === true ? 'approved' : 'uploaded') : (status === 'rejected' ? 'rejected' : 'missing'),
      uploaded_at: received ? (r.uploaded_at || null) : null,
      rejection_reason: status === 'rejected' ? (r.rejection_reason || '') : ''
    };
  });
  if (!people.length) {
    people = (Array.isArray(fallbackPeople) ? fallbackPeople : []).map(function (p) {
      var label = typeof p === 'string' ? p : String((p && (p.label || p.name)) || '');
      return { id: null, label: label, dependant_id: null, status: 'missing', uploaded_at: null, rejection_reason: '' };
    });
  }
  var outstanding = people.filter(function (p) { return p.status === 'missing' || p.status === 'rejected'; }).map(function (p) { return p.label; });
  var received = people.filter(function (p) { return p.status !== 'missing' && p.status !== 'rejected'; }).map(function (p) { return p.label; });
  return { people: people, outstanding: outstanding, received: received, all_received: people.length > 0 && outstanding.length === 0 };
}

// ["Your passport", "Partner's passport", "Child 1 passport", "Child 2 passport"]
//   -> "your passport, your partner's passport and your 2 children's passports"
function describeOutstanding(labels) {
  var list = Array.isArray(labels) ? labels : [];
  var own = list.some(function (l) { return /^your passport$/i.test(clean(l)); });
  var partner = list.some(function (l) { return /partner|spouse/i.test(String(l)); });
  var kids = list.filter(function (l) { return /child/i.test(String(l)); }).length;
  var other = list.filter(function (l) { return !/^your passport$/i.test(clean(l)) && !/partner|spouse|child/i.test(String(l)); });
  var parts = [];
  if (own) parts.push('your passport');
  if (partner) parts.push("your partner's passport");
  if (kids === 1) parts.push("your child's passport");
  else if (kids > 1) parts.push('your ' + kids + " children's passports");
  // A named family member added later ("Baby Obanimoh's passport") keeps their name's capitals.
  other.forEach(function (l) { parts.push(noDashes(l).replace(/^Your\b/, 'your')); });
  if (!parts.length) return 'the passports';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] + ' and ' + parts[1];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/**
 * ctx: { gpFirstName, gpLastName, gpName, practiceName, outstanding: [labels], received: [labels],
 *        requestedAt (iso), commencementDate (iso), reminderCount (reminders already sent),
 *        appBaseUrl, senderName }
 * -> { email: { subject, title, body, ctaText, ctaUrl }, whatsapp: { templateName, placeholders }, people: [outstanding labels] }
 *
 * The passports card shows this once the first request has gone and something is still
 * missing: it is a nudge, never a repeat of the congratulations email.
 */
function buildGpPassportReminder(ctx) {
  ctx = ctx || {};
  var dr = doctorNames(ctx);
  var first = noDashes(dr.first) || 'Doctor';
  var practice = noDashes(ctx.practiceName) || 'Your practice';
  var sender = noDashes(firstName(ctx.senderName)) || 'The GP Link team';
  var base = String(ctx.appBaseUrl || '').replace(/\/+$/, '');
  var visaUrl = base + '/pages/visa';
  var outstanding = (Array.isArray(ctx.outstanding) ? ctx.outstanding : []).map(function (l) { return noDashes(l); }).filter(Boolean);
  var received = (Array.isArray(ctx.received) ? ctx.received : []).map(function (l) { return noDashes(l); }).filter(Boolean);
  var requested = longDate(ctx.requestedAt);
  var commencement = longDate(ctx.commencementDate);
  var count = Number(ctx.reminderCount) || 0;
  var again = count >= 1;

  var lines = [];
  var p1 = again
    ? ('We are still waiting on the passports for your Subclass 482 visa' + (requested ? ', which we first asked for on ' + requested : '') + '.')
    : ((requested ? 'On ' + requested + ' we' : 'We') + ' asked for the passport photo pages for your Subclass 482 visa.');
  if (received.length) p1 += ' Thank you, we have ' + describeOutstanding(received).replace(/^your passport$/, 'yours') + ' already.';
  p1 += ' We are still waiting on:';
  lines.push(p1);
  lines.push(outstanding.map(function (p) { return '• ' + p; }).join('\n'));
  lines.push(practice + ' is engaging a migration agent, and the agent cannot lodge the nomination or the visa until every passport is in' + (commencement ? ', so your start date of ' + commencement + ' depends on it.' : '.'));
  lines.push('It only takes a minute on your visa page. Use the passport each person will travel on, and make sure the whole photo page is clear and in colour.');
  lines.push('If one of these is delayed, for example a passport is being renewed, just reply and tell me so we can plan around it.');
  lines.push('Warm regards,\n' + sender + '\nGP Link');

  var subjectName = noDashes(dr.last ? 'Dr ' + dr.last : first);
  return {
    email: {
      subject: (again ? 'Still waiting on the passports for your visa, ' : 'A quick reminder about the passports for your visa, ') + subjectName,
      title: again ? 'Another gentle nudge, {{name}}' : 'Just a gentle nudge, {{name}}',
      body: lines.join('\n\n'),
      ctaText: 'Upload the passports',
      ctaUrl: visaUrl
    },
    whatsapp: {
      templateName: PASSPORT_REMINDER_TEMPLATE,
      placeholders: [first, describeOutstanding(outstanding), visaUrl]
    },
    people: outstanding,
    reminder_number: count + 1
  };
}

module.exports = {
  buildPracticeRegistrationEmail: buildPracticeRegistrationEmail,
  buildGpPassportRequest: buildGpPassportRequest,
  buildGpPassportReminder: buildGpPassportReminder,
  passportStatusSummary: passportStatusSummary,
  describeOutstanding: describeOutstanding,
  passportPeopleLabels: passportPeopleLabels,
  describeHousehold: describeHousehold,
  greetingName: greetingName,
  PASSPORT_REMINDER_TEMPLATE: PASSPORT_REMINDER_TEMPLATE,
  noDashes: noDashes,
  escapeHtml: escapeHtml
};
