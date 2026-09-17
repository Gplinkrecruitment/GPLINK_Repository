'use strict';

// Canonical "how to get this" steps for the documents the GP Link app ALREADY
// guides doctors through in pages/my-documents.html (the COUNTRY_DOCS object and
// its "Show me how" popovers).
//
// We mirror them here as concise, plain-text steps (no HTML, no giant login URLs)
// so the AHPRA section-80 follow-up cards can show the doctor the SAME real
// acquisition steps — and the correct AHPRA destination mailbox — instead of the
// officer's loose wording (e.g. "send it to my email address").
//
// SOURCE OF TRUTH for the fuller, clickable version is pages/my-documents.html.
// If the steps there change, update them here too. Keep these short: the s80 card
// only needs the gist plus the right address; the full guide lives in My Documents.

var GUIDES = {
  uk: {
    certificate_good_standing: {
      key: 'certificate_good_standing',
      title: 'Certificate of Good Standing (GMC)',
      destination_email: 'COGS@ahpra.gov.au',
      steps: [
        'Log in to your GMC Online account.',
        'In the left-hand menu choose “My registration”, then open “My CCPS requests”.',
        'Request the certificate and ask the GMC to send it directly to AHPRA at COGS@ahpra.gov.au.'
      ],
      reminder: 'The GMC must send this directly to AHPRA (COGS@ahpra.gov.au) — it will not be accepted if it is sent to you first.'
    },
    confirmation_training: {
      key: 'confirmation_training',
      title: 'Confirmation of GP training (GMC / RCGP)',
      destination_email: 'registration18@ahpra.gov.au',
      steps: [
        'Email the GMC portfolio team at portfolio@gmc-uk.org and say you need confirmation of your specialist / GP training posts for your AHPRA application.',
        'The GMC will send you an application form — complete it and return it as instructed.',
        'Ask the GMC to send the confirmation of training directly to AHPRA by email to registration18@ahpra.gov.au.'
      ],
      reminder: 'The confirmation of training must be sent by the GMC directly to AHPRA (registration18@ahpra.gov.au), not to you.'
    }
  },
  ie: {
    certificate_good_standing: {
      key: 'certificate_good_standing',
      title: 'Certificate of Good Standing / Registration Status (Medical Council of Ireland)',
      destination_email: 'COGS@ahpra.gov.au',
      steps: [
        'Log in to the Medical Council of Ireland Doctors Portal.',
        'Request a Certificate of Good Standing / Current Professional Status.',
        'Choose the Australian Health Practitioner Regulation Agency / Medical Board of Australia as the recipient and ask MCI to send it directly to AHPRA at COGS@ahpra.gov.au.'
      ],
      reminder: 'MCI must send this directly to AHPRA (COGS@ahpra.gov.au), not to you.'
    },
    icgp_confirmation_letter: {
      key: 'icgp_confirmation_letter',
      title: 'ICGP confirmation letter',
      destination_email: '',
      steps: [
        'Email the Irish College of General Practitioners (ICGP) at info@icgp.ie.',
        'Ask for an ICGP confirmation letter for the AHPRA expedited specialist pathway, confirming your MICGP, your CSCST and the date it was awarded, and that your training followed the ICGP curriculum from 2009 onwards.',
        'Include your full name, date of birth, ICGP number, Medical Council of Ireland registration number and your AHPRA reference number.',
        'Ask ICGP to send the letter as a PDF, then have it certified as a true copy before you upload it.'
      ],
      reminder: 'This is the key supporting letter for Irish GPs.'
    }
  },
  nz: {
    certificate_good_standing: {
      key: 'certificate_good_standing',
      title: 'Certificate of Good Standing / Professional Status (MCNZ)',
      destination_email: 'COGS@ahpra.gov.au',
      steps: [
        'Log in to myMCNZ.',
        'Request a Certificate of Professional Status (COPS).',
        'Choose the Australian Health Practitioner Regulation Agency / Medical Board of Australia and ask MCNZ to email it directly to AHPRA at COGS@ahpra.gov.au.'
      ],
      reminder: 'MCNZ must send this directly to AHPRA (COGS@ahpra.gov.au), not to you.'
    },
    rnzcgp_confirmation_letter: {
      key: 'rnzcgp_confirmation_letter',
      title: 'RNZCGP confirmation letter',
      destination_email: '',
      steps: [
        'Email the RNZCGP Fellowship Team at fellowship@rnzcgp.org.nz.',
        'Ask RNZCGP to confirm your FRNZCGP, the date it was awarded (from 2012 onwards), and that you completed the General Practice Education Programme (GPEP) under the RNZCGP curriculum.',
        'Ask them to send the letter as a PDF, then have it certified as a true copy before you upload it.'
      ],
      reminder: ''
    }
  }
};

// Normalise a loose country value onto one of our guide buckets.
function guideCountry(country) {
  var c = String(country || '').trim().toLowerCase();
  if (c === 'gb' || c === 'uk' || c === 'united kingdom' || c === 'england' || c === 'scotland' || c === 'wales') return 'uk';
  if (c === 'ie' || c === 'ireland' || c === 'republic of ireland') return 'ie';
  if (c === 'nz' || c === 'new zealand') return 'nz';
  return GUIDES[c] ? c : 'uk';
}

// Fetch a specific guide by key (falls back to the UK guide if the country has none).
function getGuide(key, country) {
  var c = guideCountry(country);
  var set = GUIDES[c] || GUIDES.uk;
  return (set && set[key]) || (GUIDES.uk && GUIDES.uk[key]) || null;
}

// ── Issuing bodies outside the three guides ──────────────────────────────────
//
// Each country guide above is written for ONE issuing body (the GMC, the Medical Council of
// Ireland, MCNZ, and their GP colleges). An AHPRA letter can name any regulator in the world:
// Dr Mercy (UK-registered) was asked for a Certificate of Good Standing from the Medical and
// Dental Council of Nigeria, and her card handed her the GMC Online / "My CCPS requests" steps
// (owner, 2026-09-17). So the steps follow the BODY THE LETTER NAMES, not the doctor's country:
// a body we guide gets its own country's steps whatever the doctor's country, and any other body
// gets generic steps — contact that body and have it send the document straight to AHPRA at the
// document's mailbox (COGS@ for good standing, registration18@ for training confirmation), or to
// the assigned AHPRA officer. The same rule covers every request-from-institution item, not just
// the Certificate of Good Standing.

var GUIDE_BODIES = {
  uk: /\b(gmc|general medical council|rcgp|royal college of general practitioners)\b/i,
  ie: /\b(mci|medical council of ireland|irish medical council|icgp|irish college of general practitioners)\b/i,
  nz: /\b(mcnz|medical council of new zealand|rnzcgp|royal new zealand college of general practitioners)\b/i
};

// The AHPRA mailbox each guided document is sent to, whoever issues it.
var DOC_DESTINATIONS = {
  certificate_good_standing: 'COGS@ahpra.gov.au',
  confirmation_training: 'registration18@ahpra.gov.au'
};

// Which of our guide countries an issuing body belongs to ('' when it is none of them).
function bodyCountry(institution) {
  var s = String(institution || '').trim();
  if (!s) return '';
  var keys = Object.keys(GUIDE_BODIES);
  for (var i = 0; i < keys.length; i++) if (GUIDE_BODIES[keys[i]].test(s)) return keys[i];
  return '';
}

// The body the item names: the model's `institution`, else a "from / by the X Council / Board /
// College …" phrase in the title. '' when nothing is named (the doctor's own regulator is then
// assumed, as before).
function namedIssuingBody(item) {
  item = item || {};
  var inst = String(item.institution || '').trim().replace(/\s+/g, ' ');
  if (inst) return inst;
  var m = /\b(?:from|by|issued by)\s+(?:the\s+)?([A-Z][^,.;:()]*?(?:council|board|college|authority|commission|ministry|association|registry|registrar|chamber|order|federation|academy|society|university)[^,.;:()]*)/i
    .exec(String(item.title || ''));
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

// "the Medical and Dental Council of Nigeria" / "OET": multi-word bodies read better with "the".
function bodyDisplayName(institution) {
  var s = String(institution || '').trim().replace(/\s+/g, ' ');
  if (!s) return 'the issuing institution';
  if (/^the\s/i.test(s)) return s;
  return /\s/.test(s) ? 'the ' + s : s;
}

// "your assigned AHPRA officer (Paige Hooper, Paige.Hooper@ahpra.gov.au)" — or just the generic
// phrase when the officer is unknown. Same name test as ahpra-s80's officerLabel (an email
// username like "jane.officer" is not a name).
function officerPhrase(officer) {
  officer = officer || {};
  var email = String(officer.email || '').trim();
  var name = String(officer.name || '').trim();
  if (email.toLowerCase() === 'officer@ahpra.gov.au') email = '';
  if (!email) return 'your assigned AHPRA officer';
  var nameOk = !!name && !/@/.test(name) && (/\s/.test(name) || !/[._]/.test(name));
  return 'your assigned AHPRA officer (' + (nameOk ? name + ', ' : '') + email + ')';
}

// Generic "how to get this" steps for a body we have no walkthrough for. opts:
//   institution      the body named in the letter
//   docPhrase        what to ask for ("a Certificate of Good Standing"); defaults to the item title
//   destinationEmail the document's AHPRA mailbox, '' when the officer is the only destination
//   officer          {name, email} of the assigned AHPRA officer (optional)
//   key              doc_guide_key to store
// No em dashes: this is doctor-facing copy.
function buildGenericGuide(opts) {
  opts = opts || {};
  var body = bodyDisplayName(opts.institution);
  var bodyCap = body.charAt(0).toUpperCase() + body.slice(1);
  var doc = String(opts.docPhrase || '').trim() || 'the document AHPRA has asked for';
  var dest = String(opts.destinationEmail || '').trim();
  var officer = officerPhrase(opts.officer);
  var sendTo = dest
    ? 'directly to AHPRA at ' + dest + ', or to ' + officer
    : 'directly to AHPRA, addressed to ' + officer;
  return {
    key: String(opts.key || 'other_institution'),
    title: doc.charAt(0).toUpperCase() + doc.slice(1) + ' (' + body + ')',
    destination_email: dest,
    generic: true,
    institution: String(opts.institution || '').trim(),
    steps: [
      'Contact ' + body + ' and request ' + doc + ' for your AHPRA registration application.',
      'Ask them to send it ' + sendTo + '.',
      'Once you have requested it, tap “Mark as requested” so we can track it.'
    ],
    reminder: bodyCap + ' must send this directly to AHPRA' + (dest ? ' (' + dest + ' or your assigned officer)' : '') + '. It will not be accepted if it comes from you.'
  };
}

// Match an s80 item to the app's existing acquisition guide, or null if we don't
// already guide this document. Used to enrich the GP-facing card with real steps.
// item: { title, detail, kind, institution, mode }; opts: { officer }.
function matchGuide(item, country, opts) {
  item = item || {};
  opts = opts || {};
  var body = namedIssuingBody(item);
  var bodyC = bodyCountry(body);
  // A body we guide picks its own country's steps (a UK doctor asked for an Irish certificate
  // gets the MCI steps); no named body means the doctor's own regulator.
  var c = bodyC || guideCountry(country);
  var set = GUIDES[c] || GUIDES.uk;
  var hay = (String(item.title || '') + ' ' + String(item.detail || '') + ' ' + String(item.kind || '')).toLowerCase();
  var kind = String(item.kind || '').toLowerCase();
  var trainKey = c === 'ie' ? 'icgp_confirmation_letter' : (c === 'nz' ? 'rnzcgp_confirmation_letter' : 'confirmation_training');

  var docKey = '';
  // Confirmation of GP/specialist training, named explicitly. Checked BEFORE the good-standing
  // tag: the model tags "Confirmation of GP training from the GMC" as good_standing (both come
  // from the GMC), and that used to hand the doctor the Certificate of Good Standing steps and
  // the COGS@ mailbox for a training confirmation (Dr Mercy, 2026-09-17). Words beat tags.
  var trainPhrase = /confirmation of (your |uk )?(gp |specialist )?training|confirmation of training|training (confirmation|verification)|certificate of completion of training/.test(hay);
  // A college acronym that co-occurs with a training/confirmation context word — so a bare
  // "CCT" mention elsewhere doesn't wrongly inherit the training-confirmation steps.
  var trainAcronym = /\b(rcgp|cct|cscst|icgp|rnzcgp)\b/.test(hay) && /\b(training|completion|fellowship|confirmation)\b/.test(hay);
  if (kind === 'training_confirmation' || trainPhrase) docKey = trainKey;
  // Certificate of Good Standing / Professional Status.
  else if (kind === 'good_standing' ||
      /certificate of good standing|good standing|\bcogs\b|registration status|certificate of (current )?(professional )?status|\bcops\b/.test(hay)) docKey = 'certificate_good_standing';
  else if (trainAcronym) docKey = trainKey;

  // A guided document from a body we guide (or from no named body): the real walkthrough.
  if (docKey && (!body || bodyC)) return set[docKey] || null;

  // Any other named body: contact THAT body, send it straight to AHPRA (mailbox or officer).
  // Only for documents an institution sends (a guided type, or a request-from-institution item);
  // an upload item that merely mentions a college keeps no steps.
  if (body && !bodyC && (docKey || String(item.mode || '') === 'request_institution')) {
    var isTraining = docKey && docKey === trainKey;
    var isGoodStanding = docKey === 'certificate_good_standing';
    return buildGenericGuide({
      institution: body,
      officer: opts.officer,
      key: isGoodStanding ? 'certificate_good_standing_other' : (isTraining ? 'confirmation_training_other' : 'other_institution'),
      docPhrase: isGoodStanding ? 'a Certificate of Good Standing'
        : (isTraining ? 'confirmation of your GP / specialist training'
          : (String(item.title || '').trim() ? '“' + String(item.title).trim() + '”' : '')),
      destinationEmail: isGoodStanding ? DOC_DESTINATIONS.certificate_good_standing
        : (isTraining ? DOC_DESTINATIONS.confirmation_training : '')
    });
  }

  return null;
}

module.exports = {
  GUIDES: GUIDES,
  GUIDE_BODIES: GUIDE_BODIES,
  DOC_DESTINATIONS: DOC_DESTINATIONS,
  guideCountry: guideCountry,
  getGuide: getGuide,
  matchGuide: matchGuide,
  bodyCountry: bodyCountry,
  namedIssuingBody: namedIssuingBody,
  buildGenericGuide: buildGenericGuide
};
