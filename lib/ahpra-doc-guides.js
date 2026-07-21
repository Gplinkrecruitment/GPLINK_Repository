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

// Match an s80 item to the app's existing acquisition guide, or null if we don't
// already guide this document. Used to enrich the GP-facing card with real steps.
function matchGuide(item, country) {
  item = item || {};
  var c = guideCountry(country);
  var set = GUIDES[c] || GUIDES.uk;
  var hay = (String(item.title || '') + ' ' + String(item.detail || '') + ' ' + String(item.kind || '')).toLowerCase();
  var kind = String(item.kind || '').toLowerCase();

  // Certificate of Good Standing / Professional Status.
  if (kind === 'good_standing' ||
      /certificate of good standing|good standing|\bcogs\b|registration status|certificate of (current )?(professional )?status|\bcops\b/.test(hay)) {
    return set.certificate_good_standing || null;
  }

  // Confirmation of GP/specialist training (the key is country-specific).
  // Match the explicit phrase, OR a college acronym that co-occurs with a
  // training/confirmation context word — so a bare "CCT" mention elsewhere
  // doesn't wrongly inherit the training-confirmation steps.
  var trainPhrase = /confirmation of (gp |specialist )?training|confirmation of training|training (confirmation|verification)|certificate of completion of training/.test(hay);
  var trainAcronym = /\b(rcgp|cct|cscst|icgp|rnzcgp)\b/.test(hay) && /\b(training|completion|fellowship|confirmation)\b/.test(hay);
  if (trainPhrase || trainAcronym) {
    var trainKey = c === 'ie' ? 'icgp_confirmation_letter' : (c === 'nz' ? 'rnzcgp_confirmation_letter' : 'confirmation_training');
    return set[trainKey] || null;
  }

  return null;
}

module.exports = {
  GUIDES: GUIDES,
  guideCountry: guideCountry,
  getGuide: getGuide,
  matchGuide: matchGuide
};
