'use strict';
// Builds the plain-language candidate introduction used in the
// submit-to-practice email. Pure module — no I/O — so it is unit-testable.

var COUNTRY_META = {
  uk: { name: 'the United Kingdom', flag: '\u{1F1EC}\u{1F1E7}', trained: 'Trained in the UK' },
  gb: { name: 'the United Kingdom', flag: '\u{1F1EC}\u{1F1E7}', trained: 'Trained in the UK' },
  ie: { name: 'Ireland', flag: '\u{1F1EE}\u{1F1EA}', trained: 'Trained in Ireland' },
  nz: { name: 'New Zealand', flag: '\u{1F1F3}\u{1F1FF}', trained: 'Trained in New Zealand' }
};
var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function countryMeta(code) {
  var k = String(code || '').trim().toLowerCase();
  if (k === 'united kingdom' || k === 'great britain') k = 'uk';
  if (k === 'ireland') k = 'ie';
  if (k === 'new zealand') k = 'nz';
  return COUNTRY_META[k] || null;
}

function formatTargetDate(value) {
  var s = String(value || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!m) return '';
  var monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return '';
  return MONTHS[monthIdx] + ' ' + m[1];
}

function pathwayLabelFor(accountStatus) {
  if (String(accountStatus || '').trim().toLowerCase() === 'pep_waitlist') {
    return 'Practice Experience Program (PEP) pathway';
  }
  return 'Expedited Specialist Pathway';
}

function buildCandidateIntro(opts) {
  var o = opts || {};
  var gpName = String(o.gpName || '').trim();
  var hasName = gpName.length > 0;
  var meta = countryMeta(o.countryCode);
  var pathway = pathwayLabelFor(o.accountStatus);
  var startLabel = formatTargetDate(o.targetDate);
  var specialty = String(o.specialty || '').trim();

  var bits = [];

  // First sentence — use "This candidate" with no "Dr" when name is empty
  var displayName;
  if (!hasName) {
    displayName = 'This candidate';
  } else if (/^dr\b/i.test(gpName)) {
    displayName = gpName;
  } else {
    displayName = 'Dr ' + gpName;
  }

  var lead = displayName + ' is a';
  if (meta) lead += 'n internationally trained GP from ' + meta.name;
  else lead += 'n internationally trained GP';

  // Guard specialty clause: only append if cleaned value is non-empty
  if (specialty) {
    var cleanedSpecialty = specialty.replace(/\s*—.*$/, '').trim();
    if (cleanedSpecialty) lead += ' holding the ' + cleanedSpecialty;
  }
  lead += ', coming to Australia via the ' + pathway + '.';
  bits.push(lead);

  // Second sentence
  if (startLabel) {
    if (hasName) {
      var surname = gpName.split(' ').pop();
      bits.push('Dr ' + surname + ' is hoping to commence work by ' + startLabel + ', with GP Link managing the registration process end-to-end.');
    } else {
      bits.push('This candidate is hoping to commence work by ' + startLabel + ', with GP Link managing the registration process end-to-end.');
    }
  } else {
    bits.push('GP Link is managing the registration process end-to-end.');
  }

  var facts = [];
  if (meta) facts.push({ icon: meta.flag, label: meta.trained });
  facts.push({ icon: '\u{1FA7A}', label: pathway + (specialty ? ' (' + specialty.split(' ')[0] + ')' : '') });
  if (startLabel) {
    var shortMonth = startLabel.slice(0, 3) + ' ' + startLabel.split(' ')[1];
    facts.push({ icon: '\u{1F4C5}', label: 'Available from ' + shortMonth });
  }

  return { paragraph: bits.join(' '), facts: facts, pathwayLabel: pathway, startDateLabel: startLabel };
}

module.exports = { buildCandidateIntro, formatTargetDate, pathwayLabelFor };
