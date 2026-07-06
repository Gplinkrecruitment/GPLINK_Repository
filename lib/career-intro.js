'use strict';
// Builds the plain-language candidate introduction used in the
// submit-to-practice email. Pure module — no I/O — so it is unit-testable.

var COUNTRY_META = {
  uk: { name: 'the United Kingdom', shortName: 'the UK', flag: '\u{1F1EC}\u{1F1E7}', trained: 'Trained in the UK' },
  gb: { name: 'the United Kingdom', shortName: 'the UK', flag: '\u{1F1EC}\u{1F1E7}', trained: 'Trained in the UK' },
  ie: { name: 'Ireland', shortName: 'Ireland', flag: '\u{1F1EE}\u{1F1EA}', trained: 'Trained in Ireland' },
  nz: { name: 'New Zealand', shortName: 'New Zealand', flag: '\u{1F1F3}\u{1F1FF}', trained: 'Trained in New Zealand' }
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
  var name = String(o.gpName || '').trim() || 'the candidate';
  var displayName = /^dr\b/i.test(name) ? name : 'Dr ' + name;
  var meta = countryMeta(o.countryCode);
  var pathway = pathwayLabelFor(o.accountStatus);
  var startLabel = formatTargetDate(o.targetDate);
  var specialty = String(o.specialty || '').trim();

  var bits = [];
  var lead = displayName + ' is a';
  if (meta) lead += 'n internationally trained GP from ' + meta.name;
  else lead += 'n internationally trained GP';
  if (specialty) lead += ' holding the ' + specialty.replace(/\s*—.*$/, '');
  lead += ', coming to Australia via the ' + pathway + '.';
  bits.push(lead);
  if (startLabel) {
    bits.push('Dr ' + name.split(' ').pop() + ' is hoping to commence work by ' + startLabel + ', with GP Link managing the registration process end-to-end.');
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
