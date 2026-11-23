'use strict';

/**
 * WP-16 (Australian GP build): THE one place the words of every automated
 * message to an Australian-segment LEAD live. Pure, no I/O.
 *
 * Who reads this: the existing builders (lib/consult-lead.js consultNudgeCopy,
 * lib/booker-nudge-email.js buildBookerNudgeEmail, lib/consult-reminders.js
 * buildConsultReminderEmail, lib/consult-noshow.js noShowEmailCopy and the
 * booking-link emails in server.js) take their Australian wording from here
 * when the lead is Australian-segment and the switch is on. Every overseas
 * string stays where it was, byte for byte.
 *
 * The angle (docs/au-gp/review-report.md, WEB-05): a confidential
 * conversation about a better-fitting practice: billing mix, location,
 * flexibility. The doctor is already registered and already working, so
 * nothing here talks about registration steps or changing country.
 *
 * Rules every string in this file keeps (tests/au-wp16-copy-snapshot.test.js
 * scans every message for every segment group):
 *   - none of the AGENT-RULES section 4 words;
 *   - no dollar figures and no percentages (billing MODEL words, bulk / mixed
 *     / private, are fine);
 *   - no promise of a specific role or of pay;
 *   - never implies the current employer will be contacted, and carries the
 *     confidentiality line in its agreed wording (CONFIDENTIALITY_LINE);
 *   - the regulator is written "Ahpra";
 *   - first person, short, plain, Australian spelling (the owner's voice);
 *   - nothing that only makes sense at one time of day or "just now": a note
 *     held back overnight by quiet hours must still read correctly at 8 am.
 *
 * Two copy groups (owner decision 1: only segment A is launched):
 *   main  au_vr and au_unknown. Written to be true for ANY Ahpra-registered
 *         doctor, because au_unknown is anyone whose detail we do not have.
 *   safe  au_restricted, au_non_vr, au_registrar: built, not launched. Says
 *         nothing about roles being available: "we'll talk through what fits
 *         your registration". A message whose whole point is matching to
 *         roles is not sent to this group at all (MESSAGES[id].groups).
 */

const CONFIDENTIALITY_LINE = 'We never contact your current practice without asking you first.';
const SAFE_LINE = "we'll talk through what fits your registration";
const SIGN_OFF = 'Khaleed\nCEO, GP Link';

const SEGMENT_GROUP = Object.freeze({
  au_vr: 'main',
  au_unknown: 'main',
  au_restricted: 'safe',
  au_non_vr: 'safe',
  au_registrar: 'safe'
});
const GROUPS = Object.freeze(['main', 'safe']);
const SKIP_NOT_LAUNCHED = 'au_segment_not_launched';

// An Australian segment we do not recognise gets the careful wording.
function segmentGroup(segment) {
  return SEGMENT_GROUP[String(segment || '').trim().toLowerCase()] || 'safe';
}

/**
 * The message table: every automated message an Australian-segment lead can
 * be sent, when, on what channel, to which copy groups, and how the two
 * send rules treat it.
 *
 *   groups   which copy groups receive it ('safe' missing = not sent to the
 *            unlaunched segments; the step is recorded as skipped with
 *            reason au_segment_not_launched)
 *   quiet    'gated'   an elapsed-time send: 08:00 to 20:00 local only
 *            'exempt'  anchored on a meeting, or answers something the doctor
 *                      just did
 *            'prompt'  exempt only within 30 minutes of its anchor (a
 *                      confirmation); after that it is gated like any other
 *   anchor   the event the go-live rule measures (lib/au-lead-sends.js): the
 *            message is only ever sent when that event happened after go-live
 *            ('none' = not a sequence step: a reply to a request, or a
 *            reminder about a call that is still ahead)
 *   whatsapp the consult WhatsApp kind that carries the same message (through
 *            an approved Australian template only: lib/au-whatsapp-templates.js)
 */
const MESSAGES = Object.freeze({
  booking_link: Object.freeze({
    ref: 'N01', label: 'Booking link', channel: 'email',
    when: 'The moment an Australian-segment lead qualifies from a Meta lead form (the website form goes straight to the calendar, so it sends none).',
    groups: GROUPS, quiet: 'exempt', anchor: 'none', whatsapp: ''
  }),
  booking_link_generic: Object.freeze({
    ref: 'N01', label: 'Booking link (no personal link on file)', channel: 'email',
    when: 'Only when the booking-link tool is used for a lead with no personal link. That tool belongs to Hazel, who never rings an Australian-segment lead, so in practice this is not sent; the wording exists so the path can never fall back to the overseas email.',
    groups: GROUPS, quiet: 'exempt', anchor: 'none', whatsapp: ''
  }),
  n01_5m: Object.freeze({
    ref: 'N01', label: '5-minute note', channel: 'WhatsApp when its template is approved; until then email',
    when: 'About 5 minutes after the lead qualifies, if they have not booked. (Not emailed when the booking-link email went in the last hour: two emails in five minutes would read as a glitch.)',
    groups: GROUPS, quiet: 'gated', anchor: 'qualified', whatsapp: 'hello_5m'
  }),
  n01_1h: Object.freeze({
    ref: 'N01', label: '1-hour note', channel: 'email (+ WhatsApp when its template is approved)',
    when: '1 hour after the lead qualifies, and never sooner than 40 minutes after the 5-minute note.',
    groups: GROUPS, quiet: 'gated', anchor: 'qualified', whatsapp: 'check_in_1h'
  }),
  n01_24h: Object.freeze({
    ref: 'N01', label: '24-hour note', channel: 'email (+ WhatsApp when its template is approved)',
    when: '24 hours after the lead qualifies, and never sooner than 12 hours after the 1-hour note. The last note before a booking.',
    groups: GROUPS, quiet: 'gated', anchor: 'qualified', whatsapp: 'day_after_24h'
  }),
  n02_booked: Object.freeze({
    ref: 'N02', label: 'Call booked', channel: 'email (+ WhatsApp confirmation when its template is approved)',
    when: 'Within 5 minutes of the lead booking a call.',
    groups: GROUPS, quiet: 'prompt', anchor: 'booked', whatsapp: 'call_booked'
  }),
  n02_reminder_day: Object.freeze({
    ref: 'N02', label: 'Reminder, the day before', channel: 'email (+ WhatsApp when its template is approved)',
    when: 'From 24 hours before the call (and at least 2 hours after the booking).',
    groups: GROUPS, quiet: 'exempt', anchor: 'none', whatsapp: 'call_reminder'
  }),
  n02_reminder_hour: Object.freeze({
    ref: 'N02', label: 'Reminder, an hour before', channel: 'email (+ WhatsApp when its template is approved)',
    when: 'Between 70 and 30 minutes before the call.',
    groups: GROUPS, quiet: 'exempt', anchor: 'none', whatsapp: 'call_hour_before'
  }),
  n02_noshow: Object.freeze({
    ref: 'N02', label: 'Missed call', channel: 'email (+ WhatsApp when its template is approved)',
    when: '1 hour after a booked call the doctor did not join (not after 36 hours).',
    groups: GROUPS, quiet: 'gated', anchor: 'no_show', whatsapp: 'call_missed'
  }),
  n03_after_call: Object.freeze({
    ref: 'N03', label: 'After the call', channel: 'email (+ WhatsApp 10 minutes later when its template is approved)',
    when: 'The moment a call the doctor attended ends, if they have no account.',
    groups: GROUPS, quiet: 'prompt', anchor: 'attended', whatsapp: 'post_call_onboard'
  }),
  n03_week1: Object.freeze({
    ref: 'N03', label: 'Week 1: how it works', channel: 'email',
    when: '7 days after an attended call, still no account. This REPLACES the overseas day-7 email ("AHPRA, AMC, visa, already solved"), which is never sent to an Australian-segment lead.',
    groups: Object.freeze(['main']), quiet: 'gated', anchor: 'attended', whatsapp: ''
  }),
  n03_week2: Object.freeze({
    ref: 'N03', label: 'Week 2: how matching works', channel: 'email',
    when: '14 days after an attended call, still no account.',
    groups: Object.freeze(['main']), quiet: 'gated', anchor: 'attended', whatsapp: ''
  }),
  n03_week3: Object.freeze({
    ref: 'N03', label: 'Week 3: last note', channel: 'email',
    when: '21 days after an attended call, still no account. The last message.',
    groups: Object.freeze(['main']), quiet: 'gated', anchor: 'attended', whatsapp: ''
  })
});
const MESSAGE_IDS = Object.freeze(Object.keys(MESSAGES));

const NUDGE_STEP_IDS = Object.freeze({
  not_booked: Object.freeze(['n01_5m', 'n01_1h', 'n01_24h']),
  booked_no_signup: Object.freeze(['n02_booked', 'n03_after_call', 'n03_week1', 'n03_week2', 'n03_week3'])
});
const REMINDER_WINDOW_IDS = Object.freeze({ email_h24: 'n02_reminder_day', email_h1: 'n02_reminder_hour' });
// The consult WhatsApp kind -> the message it belongs to (for the Leads tab).
const WHATSAPP_KIND_IDS = Object.freeze({
  hello_5m: 'n01_5m', check_in_1h: 'n01_1h', day_after_24h: 'n01_24h',
  call_booked: 'n02_booked', call_reminder: 'n02_reminder_day', call_hour_before: 'n02_reminder_hour',
  call_starting: 'n02_reminder_hour', call_missed: 'n02_noshow', post_call_onboard: 'n03_after_call'
});

function messageIdForNudge(seq, step) {
  const list = NUDGE_STEP_IDS[String(seq || '')];
  return (list && list[Number(step)]) || '';
}
function messageIdForReminder(window) {
  return REMINDER_WINDOW_IDS[String(window || '')] || '';
}

/**
 * Does this segment get this message, and in which wording?
 *   { send: true, group }
 *   { send: false, group, reason: 'au_segment_not_launched' }
 * An unknown message id is never sent.
 */
function messagePlan(id, segment) {
  const m = MESSAGES[id];
  const group = segmentGroup(segment);
  if (!m) return { send: false, group, reason: 'unknown_message' };
  if (m.groups.indexOf(group) === -1) return { send: false, group, reason: SKIP_NOT_LAUNCHED };
  return { send: true, group, reason: '' };
}

// "Dr Citizen" from "Jane Citizen" / "Dr Jane Citizen"; "there" with no name.
function displayNameOf(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'there';
  const parts = trimmed.split(/\s+/);
  return 'Dr ' + parts[parts.length - 1];
}

function pick(group, main, safe) {
  return group === 'safe' ? safe : main;
}

// ── Plain emails: { subject, title, body, ctaText } ────────────────────────
// body is plain text, paragraphs separated by a blank line; the shared email
// shell turns it into HTML and the caller appends the link and the
// unsubscribe line to the text version, exactly as for the overseas notes.
//
// ctx: { displayName, whenText (the slot on the doctor's clock, labelled by
//        city), clockText (the time alone, labelled) }
function plainEmail(id, group, ctx) {
  const c = ctx || {};
  const g = group === 'safe' ? 'safe' : 'main';
  const name = String(c.displayName || '').trim() || 'there';
  const hi = 'Hi ' + name + ',';
  const when = String(c.whenText || '').trim();
  const clock = String(c.clockText || '').trim();

  if (id === 'booking_link' || id === 'booking_link_generic') {
    const about = pick(g,
      'It is a confidential conversation about what you would want from your next practice: billing mix, location, hours and flexibility.',
      'It is a confidential conversation about where you are with your registration and what you are looking for, and ' + SAFE_LINE + '.');
    const saved = id === 'booking_link'
      ? 'Your details are already saved, so booking takes about 20 seconds. Just pick a time that suits you.'
      : 'Booking takes about a minute. Just pick a time that suits you.';
    return {
      subject: 'Your GP Link call: pick a time that suits you',
      title: 'A confidential chat, when it suits you',
      body: [hi, 'Thanks for getting in touch with GP Link. The next step is a free 30-minute call with me. ' + about, CONFIDENTIALITY_LINE, saved, SIGN_OFF].join('\n\n'),
      ctaText: 'Pick a time'
    };
  }

  if (id === 'n01_5m') {
    return {
      subject: 'Thanks for getting in touch',
      title: pick(g, 'Looking for a better-fitting practice?', 'Thanks for reaching out'),
      body: [
        hi,
        'Khaleed here from GP Link. Thank you for getting in touch.',
        pick(g,
          'I help GPs who are registered in Australia find a practice that fits them better, whether that is the billing mix, the location or more flexibility in the week. I would rather have a proper conversation than send you a brochure, so if it is easier, pick a time that suits you below.',
          'I would like to understand where you are with your registration and what you are looking for, and ' + SAFE_LINE + '. I would rather have a proper conversation than send you a brochure, so if it is easier, pick a time that suits you below.'),
        'It is confidential. ' + CONFIDENTIALITY_LINE,
        pick(g,
          'One quick question so I can point you the right way: what is the one thing you would change about where you work now?',
          'One quick question so I can point you the right way: what are you hoping to do next?')
      ].join('\n\n'),
      ctaText: 'Pick a time'
    };
  }

  if (id === 'n01_1h') {
    return {
      subject: 'A quick one from me at GP Link',
      title: 'No pressure at all',
      body: [
        hi,
        'Khaleed again. I know a form is easy to fill in between patients, so no pressure at all.',
        pick(g,
          'If it helps, just reply with the one thing you would most want from your next practice (billing mix, location, hours, the team) and I will answer it myself.',
          'If it helps, just reply with where you are with your registration and what you are hoping for, and I will tell you honestly what we can help with.'),
        pick(g,
          'Or, if you would rather talk it through in one go, grab a time below. Thirty minutes, free, confidential, no obligation.',
          'Or grab a time below and ' + SAFE_LINE + '. Thirty minutes, free, confidential, no obligation.'),
        CONFIDENTIALITY_LINE
      ].join('\n\n'),
      ctaText: 'Book a time'
    };
  }

  if (id === 'n01_24h') {
    return {
      subject: 'Last note from me',
      title: 'Whenever the time is right',
      body: [
        hi,
        'Last note from me, I promise.',
        pick(g,
          'If a change of practice is a someday thing rather than a right-now thing, that is completely fine and I am happy to leave it here. If you do want to talk it through at some point, you can book straight in whenever suits you, and you are always welcome to just reply to this email.',
          'If now is not the right time, that is completely fine and I am happy to leave it here. If you would like a conversation at some point, book in whenever suits you and ' + SAFE_LINE + '. You are always welcome to just reply to this email.'),
        'Either way, it stays between us. ' + CONFIDENTIALITY_LINE,
        'Khaleed'
      ].join('\n\n'),
      ctaText: 'Book a time'
    };
  }

  if (id === 'n02_reminder_day') {
    return {
      subject: 'Your GP Link call: ' + when,
      title: 'Looking forward to speaking with you',
      body: [
        hi,
        'Just a quick reminder that your free 30-minute call with me is coming up on ' + when + '.',
        pick(g,
          'The button below is your link to join when it is time. Bring whatever you would like to talk through: the kind of practice you want, billing mix, location, hours and timing. You will get straight answers.',
          'The button below is your link to join when it is time. Bring your questions about your registration and what you are looking for, and ' + SAFE_LINE + '.'),
        'It is confidential. ' + CONFIDENTIALITY_LINE,
        'If the time no longer suits, just reply to this email and we will happily find another.',
        'Speak soon,\nKhaleed, CEO, GP Link'
      ].join('\n\n'),
      ctaText: 'Join the call'
    };
  }

  if (id === 'n02_reminder_hour') {
    return {
      subject: 'Your GP Link call is in about an hour (' + clock + ')',
      title: 'We speak in about an hour',
      body: [
        hi,
        'A quick reminder that your call with me is in about an hour, at ' + clock + '.',
        'The button below takes you straight into the call. It works on a phone or a laptop, and you can join a few minutes early if that suits.',
        'If clinic is running over or something has come up, that is completely fine. Just reply to this email if you need another time, and we will sort it out.',
        'Speak soon,\nKhaleed, CEO, GP Link'
      ].join('\n\n'),
      ctaText: 'Join the call'
    };
  }

  if (id === 'n02_noshow') {
    return {
      subject: 'Sorry we missed each other',
      title: 'Shall we find another time?',
      body: [
        hi,
        'I had our call in the diary' + (when ? ' for ' + when : '') + ' and it looks like we missed each other. No problem at all, I know how quickly a clinic day can change.',
        pick(g,
          'If you would still like to talk through what you want from your next practice, you can pick a new time below. It takes about 20 seconds.',
          'If you would still like a conversation, pick a new time below and ' + SAFE_LINE + '. It takes about 20 seconds.'),
        'Or just reply to this email with a time that suits you and I will make it work.',
        'As always, it is confidential. ' + CONFIDENTIALITY_LINE,
        SIGN_OFF
      ].join('\n\n'),
      ctaText: 'Pick a new time'
    };
  }
  return null;
}

// ── The drip after a booking: richer emails with one button ────────────────
// The five steps an Australian doctor's journey has (the report's N03 list).
// They replace the overseas tracker ("Guided registration", "Working in
// Australia"), which is about a different journey.
const JOURNEY_STEPS = Object.freeze([
  Object.freeze({ title: 'Booked', desc: 'Your call with us.' }),
  Object.freeze({ title: 'Account', desc: 'Two minutes. Your preferences and your Ahpra registration details in one place.' }),
  Object.freeze({ title: 'Matched', desc: 'When a role fits what you told us and your registration, we show it to you. You choose which to look at.' }),
  Object.freeze({ title: 'Interview', desc: 'You meet the practice. Your details go to a practice only when you say yes.' }),
  Object.freeze({ title: 'Start date', desc: 'You agree a start date that works with your notice period.' })
]);

// done: how many steps are ticked; here: the index of the step to highlight.
function tracker(heading, done, here, firstDesc) {
  return {
    heading: heading,
    rows: JOURNEY_STEPS.map(function (s, i) {
      return { title: s.title, desc: (i === 0 && firstDesc) ? firstDesc : s.desc, done: i < done, here: i === here };
    })
  };
}

/**
 * One email of the post-booking drip, as data the existing drip renderer
 * (lib/booker-nudge-email.js) draws. All strings are plain text.
 *   { subject, eyebrow, headline, paras[], tracker|null, ctaLabel, micro,
 *     closing[], signoff }
 * ctx: { displayName, whenText }
 * null for a message that is not a drip email.
 */
function dripEmail(id, group, ctx) {
  const c = ctx || {};
  const g = group === 'safe' ? 'safe' : 'main';
  const name = String(c.displayName || '').trim() || 'there';
  const when = String(c.whenText || '').trim();

  if (id === 'n02_booked') {
    return {
      subject: 'Your GP Link call is booked' + (when ? ': ' + when : ''),
      eyebrow: 'Your call is booked',
      headline: 'You are booked in, ' + name + '.',
      paras: [
        'Thanks for booking a call with me' + (when ? ' for ' + when : '') + '. I am looking forward to it.',
        pick(g,
          'So you know what to expect: we will talk about what you want from your next practice, including billing mix (bulk, mixed or private), location, hours and flexibility. I will explain how the roles we work on tend to be set up and how matching works, and we will cover timing, including your notice period.',
          'So you know what to expect: I would like to understand where you are with your registration and what you are looking for, and ' + SAFE_LINE + '. I will be straight with you about what we can and cannot help with right now.'),
        'It is a conversation, not a commitment. ' + CONFIDENTIALITY_LINE
      ],
      tracker: g === 'main' ? tracker('Where you are', 1, 1, 'Done. Your call is in the diary.') : null,
      ctaLabel: 'Create my free account',
      micro: 'Optional before the call · Two minutes · Free',
      closing: [
        pick(g,
          'If you would like a head start, create your free GP Link account before we speak. Your preferences will be ready when we talk, and nothing in it is shared with a practice until you say so.',
          'If you would like a head start, create your free GP Link account before we speak. It keeps your registration details in one place, and nothing in it is shared with a practice until you say so.'),
        'If the time stops suiting you, just reply to this email and we will find another.'
      ],
      signoff: SIGN_OFF
    };
  }

  if (id === 'n03_after_call') {
    return {
      subject: 'Good to speak with you, ' + name + ': the next step',
      eyebrow: 'After our call',
      headline: 'Thanks for the conversation, ' + name + '.',
      paras: [
        'The next step is your free GP Link account. It takes about two minutes.',
        pick(g,
          'It is where you tell us what you want from your next practice (billing mix, location, hours, the kind of team), so that we only bring you roles worth your time.',
          'It keeps your registration details and what you are looking for in one place, so we can follow up on what we discussed. From there ' + SAFE_LINE + '.')
      ],
      tracker: g === 'main' ? tracker('Where you are', 1, 1, 'Done. We have spoken.') : null,
      ctaLabel: 'Create my free account',
      micro: 'Two minutes · Free · Confidential',
      closing: ['Nothing in your account is shared with a practice until you say so. ' + CONFIDENTIALITY_LINE],
      signoff: SIGN_OFF
    };
  }

  // The three weekly emails are about being matched to roles, so they exist
  // in the main wording only (MESSAGES[id].groups).
  if (id === 'n03_week1') {
    return {
      subject: 'What happens after you create your account',
      eyebrow: 'How it works',
      headline: 'Five steps, and the first is already done.',
      paras: [
        'Here is the whole path, ' + name + ', so there are no surprises.'
      ],
      tracker: tracker('The five steps', 1, 1, 'Done. We have spoken.'),
      ctaLabel: 'Create my free account',
      micro: 'Two minutes · Free · Confidential',
      closing: ['You stay in control at every step. ' + CONFIDENTIALITY_LINE],
      signoff: SIGN_OFF
    };
  }

  if (id === 'n03_week2') {
    return {
      subject: 'How we match GPs to practices',
      eyebrow: 'Matching',
      headline: 'We would rather send you nothing than waste your time.',
      paras: [
        'When we match a GP to a practice we look at the billing model (bulk, mixed or private), the location, the hours and the support around you. We only put a role in front of you when it fits what you told us and your registration.',
        'Some weeks that is a few roles. Some weeks it is none. Either way, you decide which ones are worth a conversation, and your details go to a practice only when you say yes.',
        'Your account is where you set those preferences. It takes about two minutes.'
      ],
      tracker: null,
      ctaLabel: 'Set my preferences',
      micro: 'Two minutes · Free · Confidential',
      closing: [CONFIDENTIALITY_LINE],
      signoff: SIGN_OFF
    };
  }

  if (id === 'n03_week3') {
    return {
      subject: 'Last note from me, ' + name,
      eyebrow: 'Whenever you are ready',
      headline: 'I will leave it here.',
      paras: [
        'This is my last note about setting up your account. If the timing is not right, that is completely fine.',
        'The button below stays open whenever you are ready, and you are always welcome to reply to this email if a question comes up.'
      ],
      tracker: null,
      ctaLabel: 'Create my free account',
      micro: 'Two minutes · Free · Confidential',
      closing: ['Either way, our conversation stays between us. ' + CONFIDENTIALITY_LINE],
      signoff: SIGN_OFF
    };
  }
  return null;
}

// The plain-text version of a drip email (the caller appends the link and the
// unsubscribe line).
function dripText(d) {
  if (!d) return '';
  const lines = [d.headline].concat(d.paras || []);
  if (d.tracker) {
    lines.push(d.tracker.heading + ':\n' + d.tracker.rows.map(function (r, i) {
      return (i + 1) + '. ' + r.title + (r.here ? ' (you are here)' : '') + ': ' + r.desc;
    }).join('\n'));
  }
  return lines.concat(d.closing || []).concat([d.signoff]).join('\n\n');
}

// ── Proposed WhatsApp templates (NOT submitted: an owner action) ───────────
// Keyed by the row in lib/au-whatsapp-templates.js. The placeholders are the
// same, in the same order, as the overseas template for the same touch, so
// the existing message builder fills them. Nothing is sent through any of
// these until the owner has it approved and marks it approved.
//
// WP-18 (the review of the live templates, whatsapp-live-templates.md):
//   - `supersededBy`: an existing approved template was read and found
//     neutral, so the Australian row points at it and this draft does NOT
//     need submitting. The wording is kept in case the owner prefers it.
//   - No body may start or end with a variable (Meta rejects it): the hello,
//     the check-in and the missed-call drafts gained a closing line.
//   - The sign-up welcome is expected to be classed MARKETING, as the
//     existing welcome was.
const PROPOSED_WHATSAPP_TEMPLATES = Object.freeze({
  lead_hello_5m: Object.freeze({
    purpose: 'N01, about 5 minutes after an Australian-segment lead qualifies.', category: 'MARKETING',
    body: 'Hi {{1}}, Khaleed here from GP Link. Thanks for getting in touch.\n\nI help GPs who are registered in Australia find a practice that fits them better: billing mix, location, flexibility. It is confidential. ' + CONFIDENTIALITY_LINE + '\n\nWhat is the one thing you would change about where you work now? Or pick a time for a chat here: {{2}}\n\nKhaleed, GP Link',
    placeholders: ['first name', 'booking link'], buttons: 'none'
  }),
  lead_check_in_1h: Object.freeze({
    purpose: 'N01, 1 hour after the lead qualifies.', category: 'MARKETING',
    body: 'Hi {{1}}, Khaleed again. No pressure at all.\n\nIf it helps, reply with the one thing you would most want from your next practice and I will answer it myself. Or grab a time here, 30 minutes, free and confidential: {{2}}\n\nKhaleed, GP Link',
    placeholders: ['first name', 'booking link'], buttons: 'none'
  }),
  lead_day_after_24h: Object.freeze({
    purpose: 'N01, 24 hours after the lead qualifies. The last note.', category: 'MARKETING',
    body: 'Hi {{1}}, last note from me. If a change of practice is a someday thing, that is completely fine and I will leave it here.\n\nIf you would like to talk it through at some point, you can book whenever suits you: {{2}}\n\nEither way it stays between us. ' + CONFIDENTIALITY_LINE,
    placeholders: ['first name', 'booking link'], buttons: 'none'
  }),
  lead_call_booked: Object.freeze({
    purpose: 'N02, booking confirmation.', category: 'UTILITY',
    body: 'Hi {{1}}, your GP Link call is booked for {{2}}. The link to join will arrive by email, and we will send it here before the call as well.\n\nIt is a confidential conversation. ' + CONFIDENTIALITY_LINE,
    placeholders: ['first name', 'the time on their own clock, for example "Thursday 14 January, 10:30 am (Perth time)"'], buttons: 'none'
  }),
  lead_call_reminder: Object.freeze({
    purpose: 'N02, the day before the call.', category: 'UTILITY',
    body: 'Hi {{1}}, a reminder that your GP Link call is coming up on {{2}}.\n\nJoin here when it is time: {{3}}\n\nIf the time no longer suits, just reply and we will find another.',
    placeholders: ['first name', 'the time on their own clock', 'join link'], buttons: 'none'
  }),
  lead_call_hour_before: Object.freeze({
    purpose: 'N02, about an hour before the call.', category: 'UTILITY',
    body: 'Hi {{1}}, your GP Link call is in about an hour, at {{2}}.\n\nJoin here: {{3}}\n\nIf clinic is running over, just let us know.',
    placeholders: ['first name', 'the time on their own clock', 'join link'], buttons: 'Quick replies: "I\'ll be there", "Need another time" (the same two the existing one-hour template has: the app reads them)', supersededBy: 'gp_link_consult_call_1h'
  }),
  lead_call_starting: Object.freeze({
    purpose: 'N02, 5 minutes before the call.', category: 'UTILITY',
    body: 'Hi {{1}}, your GP Link call starts in 5 minutes. Tap to join: {{2}}\n\nRunning a few minutes late is fine.',
    placeholders: ['first name', 'join link'], buttons: 'none', supersededBy: 'gp_link_consult_call_starting_5m'
  }),
  lead_call_missed: Object.freeze({
    purpose: 'N02, an hour after a call the doctor did not join.', category: 'UTILITY',
    body: 'Hi {{1}}, it looks like we missed each other today. No problem at all, I know how quickly a clinic day can change.\n\nIf you would still like to talk, pick a new time here: {{2}}\n\nOr reply with a time that suits you and I will make it work.',
    placeholders: ['first name', 'link to pick a new time'], buttons: 'none', supersededBy: 'gp_link_consult_missed_call'
  }),
  lead_post_call_onboard: Object.freeze({
    purpose: 'N03, 10 minutes after a call the doctor attended, if they have no account.', category: 'MARKETING',
    body: 'Thanks for the conversation today, {{1}}. The next step is your free GP Link account. It takes about two minutes and it is where you tell us what you want from your next practice: {{2}}\n\nNothing in it is shared with a practice until you say so.',
    placeholders: ['first name', 'sign-up link'], buttons: 'none', supersededBy: 'gp_link_consult_post_call_onboard_v3'
  }),
  lead_signed_up: Object.freeze({
    purpose: 'When a lead creates their account. (WP-17 owns onboarding wording; proposed here so the skip has a name.)', category: 'MARKETING',
    body: 'Welcome to GP Link, {{1}}. Your account is set up. A few short questions in the app tell us what you want from your next practice, and nothing is shared with a practice until you say so.',
    placeholders: ['first name'], buttons: 'none'
  }),
  lead_onboarding_incomplete: Object.freeze({
    purpose: 'A day after sign-up, if the short set-up questions are not finished. (WP-17 owns onboarding wording.)', category: 'UTILITY',
    body: 'Hi {{1}}, your GP Link account is nearly ready. A couple of minutes in the app to finish your details and we can start looking at what fits. Reply here if anything is unclear.',
    placeholders: ['first name'], buttons: 'none', supersededBy: 'gp_link_consult_onboarding_nudge'
  })
});

// ── Plain words for the owner (Leads tab), never shown to a doctor ─────────
const SKIP_REASON_WORDS = Object.freeze({
  au_template_not_approved: 'no approved Australian template',
  au_template_promises_roles: 'the template promises matching, and this lead\'s segment is not launched',
  au_segment_not_launched: 'not sent to this segment (not launched): follow up personally',
  au_before_go_live: 'enquired before Australian messages went live: follow up personally',
  au_booking_link_just_sent: 'the booking-link email had just gone',
  au_call_already_passed: 'the call time had already passed',
  email_bounced: 'their email address bounced'
});
function skipReasonWords(reason) {
  return SKIP_REASON_WORDS[String(reason || '')] || String(reason || 'skipped').replace(/_/g, ' ');
}
// WhatsApp touches that have no email twin (the account exists by then).
const EXTRA_LABELS = Object.freeze({ signed_up: 'Welcome after sign-up', onboarding_incomplete: 'Finish setting up reminder' });
function messageLabel(id) {
  return (MESSAGES[id] && MESSAGES[id].label) || EXTRA_LABELS[id] || String(id || '').replace(/_/g, ' ');
}

module.exports = {
  CONFIDENTIALITY_LINE,
  SAFE_LINE,
  SEGMENT_GROUP,
  GROUPS,
  SKIP_NOT_LAUNCHED,
  MESSAGES,
  MESSAGE_IDS,
  NUDGE_STEP_IDS,
  REMINDER_WINDOW_IDS,
  WHATSAPP_KIND_IDS,
  JOURNEY_STEPS,
  PROPOSED_WHATSAPP_TEMPLATES,
  segmentGroup,
  messageIdForNudge,
  messageIdForReminder,
  messagePlan,
  displayNameOf,
  plainEmail,
  dripEmail,
  dripText,
  skipReasonWords,
  messageLabel
};
