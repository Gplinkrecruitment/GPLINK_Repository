// lib/booker-nudge-email.js — pure copy/HTML for the post-consultation signup drip
// (sequence booked_no_signup). Steps 0–4 map to the approved mockups:
//   docs/mockups/direct-booker-signup-nudge-email.html   (step 0)
//   docs/mockups/direct-booker-nudge-sequence.html        (steps 1–4)
// Returns { subject, bodyHtml } — bodyHtml is the INNER content only; server.js wraps
// it with buildCareerEmailHtml({ bodyHtml, footer }) so the GP Link header/card/footer
// stay identical to every other GP Link email. No I/O. See
// docs/superpowers/specs/2026-07-25-booker-signup-nudge-and-backfill-design.md.
'use strict';

const BOOKER_NUDGE_STEP_COUNT = 5;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Append a per-touch ref so signup attribution is visible in analytics without
// changing where the CTA points.
function withRef(url, step) {
  const u = String(url || '');
  if (!u) return '';
  return u + (u.includes('?') ? '&' : '?') + 'ref=nudge-t' + step;
}

// ── shared visual bits (email-safe inline styles) ──────────────────────────
function ctaBlock(label, url, micro) {
  return '<div style="text-align:center;margin:8px 0 6px">'
    + '<a href="' + esc(url) + '" style="display:inline-block;padding:15px 36px;background:#2563eb;color:#fff;font-weight:800;font-size:15px;text-decoration:none;border-radius:12px;box-shadow:0 5px 14px rgba(37,99,235,0.32)">' + esc(label) + '</a>'
    + (micro ? '<div style="font-size:12.5px;color:#94a3b8;margin-top:11px">' + esc(micro) + '</div>' : '')
    + '</div>';
}

function socialProof(text) {
  return '<p style="font-size:12.5px;color:#64748b;line-height:1.55;text-align:center;margin:18px 0 0">' + esc(text) + '</p>';
}

function scarcityBox(html) {
  return '<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:13px 15px;margin:18px 0 2px">'
    + '<p style="font-size:13.5px;color:#9a3412;line-height:1.55;margin:0">' + html + '</p></div>';
}

function tickList(heading, items) {
  return '<div style="background:#f8fafc;border:1px solid #eef2f7;border-radius:11px;padding:15px 17px;margin:18px 0">'
    + '<div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#64748b;font-weight:800;margin-bottom:10px">' + esc(heading) + '</div>'
    + items.map(function (t) {
      return '<p style="font-size:14px;color:#334155;margin:0 0 8px;line-height:1.5"><span style="color:#16a34a;font-weight:800">✓</span>&nbsp;&nbsp;' + esc(t) + '</p>';
    }).join('')
    + '</div>';
}

function eyebrow(text, amber) {
  return '<div style="font-size:11px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:' + (amber ? '#c2410c' : '#2563eb') + ';margin-bottom:9px">' + esc(text) + '</div>';
}
function headline(text) {
  return '<h1 style="font-size:22px;line-height:1.28;font-weight:800;color:#0f172a;margin:0 0 13px">' + text + '</h1>';
}
function para(html) {
  return '<p style="font-size:14.5px;color:#334155;line-height:1.62;margin:0 0 16px">' + html + '</p>';
}

// 5-row vertical progress tracker for step 0 (the flagship).
// Two mirrored journeys reach the same place, so the tracker takes a variant:
//   'booked'  — they booked a call first, and the account is the missing step
//   'account' — they made an account first, and the call is the missing step
// Everything below step 2 is identical; only the first two rows swap roles.
function progressTracker(variant) {
  const accountFirst = variant === 'account';
  const rows = accountFirst ? [
    { n: '✓', title: 'Free account created', desc: "Done — your file is open and your roadmap is live.", strong: false, here: false },
    { n: '2', title: "Book your free 30-minute call · you're here", desc: 'Where we map YOUR route: registration, visa, timing and pay.', strong: true, here: true },
    { n: '3', title: 'Matched to a practice', desc: 'Real roles that fit what you told us you want.', strong: false, here: false },
    { n: '4', title: 'Guided registration', desc: 'AHPRA, AMC & visa — done with you, step by step.', strong: false, here: false },
    { n: '5', title: 'Working in Australia', desc: 'The reason you created the account in the first place.', strong: false, here: false },
  ] : [
    { n: '✓', title: 'Consultation booked', desc: "Done — you're on the calendar.", strong: false, here: false },
    { n: '2', title: "Create your free account · you're here", desc: '2 minutes. Unlocks your roadmap and saves your call notes to your file.', strong: true, here: true },
    { n: '3', title: 'Matched to a practice', desc: 'Real roles that fit what you told us you want.', strong: false, here: false },
    { n: '4', title: 'Guided registration', desc: 'AHPRA, AMC & visa — done with you, step by step.', strong: false, here: false },
    { n: '5', title: 'Working in Australia', desc: 'The reason you booked the call in the first place.', strong: false, here: false },
  ];
  let out = '<div style="background:#f8fafc;border:1px solid #e8eef7;border-radius:14px;padding:20px 20px 8px;margin:0 0 22px">'
    + '<div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#64748b;margin-bottom:15px">Where you are right now</div>';
  rows.forEach(function (r) {
    const dot = r.here
      ? '<div style="width:24px;height:24px;line-height:24px;border-radius:50%;background:#2563eb;color:#fff;text-align:center;font-size:12px;font-weight:800">' + r.n + '</div>'
      : (r.n === '✓'
        ? '<div style="width:24px;height:24px;line-height:24px;border-radius:50%;background:#16a34a;color:#fff;text-align:center;font-size:13px;font-weight:800">✓</div>'
        : '<div style="width:24px;height:24px;line-height:22px;border-radius:50%;background:#fff;border:2px solid #cbd5e1;color:#94a3b8;text-align:center;font-size:12px;font-weight:800">' + r.n + '</div>');
    const wrapOpen = r.here ? '<div style="background:#eef4ff;border:1px solid #cfe0ff;border-radius:10px;padding:12px;margin-bottom:12px">' : '<div style="margin-bottom:12px">';
    out += wrapOpen
      + '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%"><tr>'
      + '<td style="width:30px;vertical-align:top">' + dot + '</td>'
      + '<td style="vertical-align:top;padding-left:10px">'
      + '<div style="font-size:14px;font-weight:' + (r.strong ? '800' : '700') + ';color:' + (r.here ? '#1d4ed8' : (r.n === '✓' ? '#0f172a' : '#334155')) + '">' + esc(r.title) + '</div>'
      + '<div style="font-size:13px;color:' + (r.here ? '#334155' : (r.n === '✓' ? '#64748b' : '#94a3b8')) + ';line-height:1.5">' + esc(r.desc) + '</div>'
      + '</td></tr></table></div>';
  });
  return out + '</div>';
}

// 5-dot horizontal progress (steps 1–4 reminder).
function progressDots(hereStep) {
  const labels = ['✓', '2', '3', '4', '5'];
  let cells = '';
  for (let i = 0; i < 5; i++) {
    let dot;
    if (i === 0) dot = '<div style="width:22px;height:22px;line-height:22px;border-radius:50%;background:#16a34a;color:#fff;text-align:center;font-size:11px;font-weight:800;margin:0 auto">✓</div>';
    else if (i + 1 === hereStep) dot = '<div style="width:22px;height:22px;line-height:22px;border-radius:50%;background:#2563eb;color:#fff;text-align:center;font-size:11px;font-weight:800;margin:0 auto">' + labels[i] + '</div>';
    else dot = '<div style="width:22px;height:22px;line-height:18px;border-radius:50%;background:#fff;border:2px solid #cbd5e1;color:#94a3b8;text-align:center;font-size:11px;font-weight:800;margin:0 auto">' + labels[i] + '</div>';
    cells += '<td style="text-align:center;vertical-align:middle;width:20%">' + dot + '</td>';
  }
  return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px"><tr>' + cells + '</tr></table>';
}

// ── the drip ────────────────────────────────────────────────────────────────
// opts: { firstName, displayName, signupUrl, unsubscribeUrl }
function buildBookerNudgeEmail(step, opts) {
  const o = opts || {};
  const first = esc(String(o.firstName || o.displayName || 'there').trim() || 'there');
  const signup = withRef(o.signupUrl, step);

  if (step === 0) {
    return {
      subject: first + ", you've done the hard part — your Australia move starts here 🇦🇺",
      bodyHtml: eyebrow('Your Australia journey has started')
        + headline(first + ", you've already cleared the biggest hurdle.")
        + para("Booking a consultation and telling us you're ready to practise in Australia is the step most doctors <em>think</em> about for years and never take. <strong>You've taken it.</strong> The hardest part is behind you — now let's turn that decision into a clear, guided plan.")
        + progressTracker()
        + ctaBlock('Create my free account →', signup, "Takes 2 minutes · Free · We've already got your details from your booking")
        + '<div style="border-left:4px solid #2563eb;background:#f8fafc;padding:14px 16px;margin:22px 0 6px;border-radius:0 8px 8px 0"><p style="font-size:14px;color:#334155;line-height:1.6;margin:0">You already told us your goal when you booked. Your account simply picks up where your call leaves off, so nothing you\'ve shared gets lost.</p></div>'
        + tickList('What your account unlocks', ['Your consultation notes and personalised next steps, saved to your file.', 'A registration roadmap that tells you exactly what to do next — no guesswork.', 'Real GP roles across Australia, matched to what you\'re looking for.'])
        + scarcityBox('<strong>⏳ We take a limited number of doctors each intake</strong> so every registration gets hands-on support. Creating your account now holds your place in the current cohort.')
        + socialProof('Join the UK, Irish and NZ-trained GPs already registering with GP Link.')
        + '<p style="font-size:14px;color:#334155;line-height:1.65;margin:22px 0 0">See you on the inside,<br><strong>The GP Link Team</strong></p>',
    };
  }

  if (step === 1) {
    return {
      subject: 'Great speaking with you, ' + first + " — you're 1 step from your plan 📋",
      bodyHtml: eyebrow('After your consultation')
        + headline("That's the conversation done, " + first + ". Don't lose the momentum.")
        + para("You've now done the two hardest things most doctors never do — <strong>deciding</strong>, and <strong>showing up</strong>. Everything we covered on the call (your next steps, our notes, your personalised registration plan) is saved and waiting. Creating your account is all that stands between you and the plan.")
        + progressDots(2)
        + '<div style="font-size:12px;color:#475569;text-align:center;margin:0 0 18px">You\'re on <b style="color:#1d4ed8">step 2 of 5</b> — one step from unlocking everything.</div>'
        + ctaBlock('Open my account & notes →', signup, 'Your call summary is waiting · Free · We already have your details')
        + socialProof('Join the UK, Irish & NZ-trained GPs registering with GP Link every week.'),
    };
  }

  if (step === 2) {
    return {
      subject: first + ', your roadmap is built — and waiting on you',
      bodyHtml: eyebrow('Your roadmap · Week 1')
        + headline('The scary part — AHPRA, AMC, visa — is already solved for you.')
        + para("Most doctors lose <em>months</em> to the registration maze. We've turned it into a step-by-step checklist that tells you exactly what to do next — done <strong>with</strong> you, not by you. It's built, personalised to your call, and sitting in your account right now.")
        + tickList('Waiting inside your account', ['Your consultation notes & next steps', 'Your AHPRA / AMC / visa checklist', 'GP roles matched to you'])
        + '<div style="font-size:12px;color:#475569;text-align:center;margin:0 0 18px">You\'re <b style="color:#1d4ed8">1 step</b> from all of it — step 2 of 5, create your account.</div>'
        + ctaBlock('See my roadmap →', signup, '2 minutes · Free · We already have your details')
        + socialProof('Places in each intake are limited so every doctor gets hands-on support.'),
    };
  }

  if (step === 3) {
    return {
      subject: "A GP role you'll want to see — before it's taken",
      bodyHtml: eyebrow('Opportunities · Week 2', true)
        + headline('Practices are hiring GPs right now — in the areas you asked about.')
        + para("Real GP roles — with income, location and hours — are matched to members <strong>every week</strong>, including where you told us you want to be. The doctors who land the best roles are simply the ones already in the door when a match appears.")
        + scarcityBox('<strong>⏳ Roles fill fast.</strong> You can only see them, and be matched to them, from inside your account.')
        + ctaBlock('See roles matched to me →', signup, 'Free · Matched to exactly what you told us on your call')
        + socialProof('GPs who started right where you are now are already being matched to practices.'),
    };
  }

  // step 4 — week 3, final
  return {
    subject: "We're holding your place, " + first + ' — but not forever ⏳',
    bodyHtml: eyebrow('Your place · Week 3', true)
      + headline('Your spot in this intake is still open — for now.')
      + para("We take a limited number of doctors at a time so nobody's registration gets rushed. You booked a call and told us <strong>you're ready to move to Australia</strong> — that already earned you a place. But we can't hold it open indefinitely while other doctors are waiting to start.")
      + scarcityBox('<strong>⏳ Limited places this intake.</strong> Yours is reserved while it lasts — claiming your account locks it in.')
      + ctaBlock('Claim my place →', signup, '2 minutes · Free · No obligation')
      + socialProof("You've already said you're ready — you're further ahead than most who start."),
  };
}

// ── The mirror of step 0 ────────────────────────────────────────────────────
// Step 0 above congratulates a GP who BOOKED and nudges them to make an
// account. This congratulates a GP who made an ACCOUNT and nudges them to book
// the call — the same "you've taken the first step" beat, opposite CTA. Sent
// once, on first login, and only when they have no consultation on file
// already (see hasPriorConsultationForEmail in server.js), so a GP who came in
// through the Facebook funnel and already booked never gets asked twice.
function buildFirstStepBookCallEmail(opts) {
  const o = opts || {};
  const first = esc(String(o.firstName || o.displayName || 'there').trim() || 'there');
  const book = String(o.bookUrl || '');
  return {
    subject: first + ", your account is live — now let's map your move 🇦🇺",
    bodyHtml: eyebrow('You\'ve taken the first step')
      + headline(first + ', your GP Link account is live.')
      + para("Most doctors think about moving to Australia for years without ever starting. <strong>You just started.</strong> Your file is open, and everything from here is something we do <em>with</em> you rather than something you work out alone.")
      + progressTracker('account')
      + para("There's one thing that makes the biggest difference this early: a short conversation. Thirty minutes on a call and you'll know exactly what your route looks like — what to do first, how long it really takes, and what you'd earn on the other side.")
      + ctaBlock('Book my free 30-minute call →', book, 'Takes 30 seconds to book · Free · No obligation')
      + tickList("What we'll cover", [
        'Your registration route — AHPRA, AMC and where you actually sit today.',
        'Visa options for you and your family, and realistic timings.',
        'What GPs with your background are genuinely earning here.',
        'The questions you have not thought to ask yet.'
      ])
      + scarcityBox('<strong>⏳ We take a limited number of doctors each intake</strong> so every registration gets hands-on support. Getting your call in early is what secures your place in the current cohort.')
      + socialProof('Join the UK, Irish and NZ-trained GPs already registering with GP Link.')
      + '<p style="font-size:14px;color:#334155;line-height:1.65;margin:22px 0 0">Talk soon,<br><strong>The GP Link Team</strong></p>',
  };
}

module.exports = { buildBookerNudgeEmail, buildFirstStepBookCallEmail, BOOKER_NUDGE_STEP_COUNT, withRef };
