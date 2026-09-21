'use strict';
const { PEP_DATE_CUTOFFS } = require('./document-pipeline');
// Automated medical-register verification (owner request 2026-09-01: "there
// must be a way to automate the registration number") — the pure parsing and
// verdict logic. I/O lives in server.js; everything here is unit-testable.
//
// What months of registers offer, discovered empirically 2026-09-01:
// - UK: the GMC register itself blocks ALL automation (Cloudflare rejects
//   plain HTTP and real headless Chrome alike; their sanctioned bulk product
//   is the paid daily download). BUT NHS England's Performers List for
//   England is an OPEN, no-auth, datestamped CSV
//   (https://secure.pcse.england.nhs.uk/PerformersLists/Home/DownloadPerformers)
//   carrying every NHS England performer's GMC number, name, "Included"
//   status and Date in GP Register. A practising England GP MUST be on it,
//   and inclusion requires live GMC registration — so a number+name match
//   with role "GP Performer" and status "Included" is strong, official,
//   automatable verification. A GP from Scotland/Wales/NI or outside the
//   NHS will NOT appear: that is an inconclusive result, never a mismatch.
// - NZ: MCNZ's register search and doctor pages are fully server-rendered
//   with no bot wall — name search + "General Practice" scope + "Practising"
//   status verifies directly against the live register.
// - Ireland (reCAPTCHA-laced WebForms) and Ahpra (F5 bot defence): stay on
//   the staff one-click flow.
//
// Verdicts are CONSERVATIVE: automation may only ever VERIFY or stay
// inconclusive ("pending", for staff) — it never records a mismatch. A
// mismatch is a human judgement.

// ── shared name matching ────────────────────────────────────────────────────
// The register's name must contain BOTH the doctor's first and last name
// tokens (any order, case-insensitive, initials not accepted). Register rows
// often carry middle names or hold the whole name in one field, so exact
// equality is wrong; token containment mirrors the CV identity guard's
// spirit without its OCR fuzz.
function nameTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/[\s'-]+/)
    .filter(function (t) { return t.length > 1; });
}

function registerNameMatches(registerName, firstName, lastName) {
  var reg = nameTokens(registerName);
  var first = nameTokens(firstName);
  var last = nameTokens(lastName);
  if (!reg.length || !first.length || !last.length) return false;
  var hasFirst = first.some(function (t) { return reg.indexOf(t) !== -1; });
  var hasLast = last.every(function (t) { return reg.indexOf(t) !== -1; });
  return hasFirst && hasLast;
}

// ── NHS England Performers List (UK / GMC numbers) ──────────────────────────
// CSV columns (header row, verified 2026-09-01): "Alignment","Performer
// Role","ForeName(s)","Surname","Professional Registration Number","Date of
// Registration","Status","Date first on Performers list(this is the earliest
// date of inclusion held)","Date in GP Register","NHSE Regional Team",
// "Currently in Probationary Period". Quirks: the number is space-padded,
// Surname is often "-" with the WHOLE name in ForeName(s), and Dental rows
// (GDC numbers) share the file with Medical ones.
function parseCsvLine(line) {
  var out = [];
  var cur = '';
  var inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parsePerformersRow(line) {
  var cols = parseCsvLine(String(line || ''));
  if (cols.length < 11) return null;
  return {
    alignment: cols[0].trim(),
    role: cols[1].trim(),
    foreNames: cols[2].trim(),
    surname: cols[3].trim(),
    number: cols[4].replace(/\D+/g, ''),
    registeredDate: cols[5].trim(),
    status: cols[6].trim(),
    firstOnListDate: cols[7].trim(),
    gpRegisterDate: cols[8].trim(),
    region: cols[9].trim(),
    probationary: cols[10].trim()
  };
}

function performersFullName(row) {
  if (!row) return '';
  var sur = row.surname === '-' ? '' : row.surname;
  return (row.foreNames + ' ' + sur).trim();
}

// rows: every CSV row whose number matched the doctor's GMC number.
// Returns { outcome: 'verified' | 'pending', evidence, matchedName }.
function performersVerdict(rows, doctor) {
  var matches = (rows || []).filter(function (r) {
    return r && r.alignment === 'Medical' && registerNameMatches(performersFullName(r), doctor.firstName, doctor.lastName);
  });
  if (matches.length === 0) {
    return {
      outcome: 'pending',
      evidence: (rows && rows.length)
        ? 'GMC ' + doctor.number + ' is on the England performers list under a different name. Check by hand.'
        : 'GMC ' + doctor.number + ' is not on the NHS England performers list (a GP from Scotland, Wales, NI or outside the NHS will not appear). Check the GMC register by hand.'
    };
  }
  var included = matches.filter(function (r) { return /^included$/i.test(r.status) && /gp performer/i.test(r.role); });
  if (included.length === 1) return verifiedFromPerformersRow(included[0]);

  // No clean Included GP Performer row. Before sending this to a human, ask
  // whether the ROLE is the only thing missing — because NHS England's file
  // LAGS the GMC register on exactly this field.
  //
  // Proven on GMC 7742772 (2026-09-21): the GMC register shows him on the GP
  // Register from 08 Jul 2026, while the same day's performers file still
  // tagged him "GP Registrar" with a BLANK GP Register date, 2.5 months after
  // his CCT. It is not a one-off — 275 of the 2,333 GP Registrar rows in that
  // file already carry a GP Register date, so PCSE demonstrably does not flip
  // the role promptly. The doctors it strands are the newly-qualified GPs we
  // recruit, so the registrar tag alone must not hold up verification.
  //
  // What the role does and does not tell us:
  //  - "Is this GMC number really this person's?" — the role is irrelevant. An
  //    exact number + name match on an Included Medical row answers it.
  //  - "Has this doctor finished training?" — the role is the signal, and it
  //    is the unreliable one. It stays UNRESOLVED here (gpRegisterUnconfirmed)
  //    rather than being asserted either way.
  // Conflating the two is what parked a fully qualified GP in the manual queue.
  //
  // The relaxation is OPT-IN (doctor.identityVerified) and corroborated, not a
  // loosening: it needs the doctor to have passed the AI ID-document check,
  // which itself fails on a name that disagrees with the profile name. So the
  // chain licence/passport → profile → performers row holds end to end, and a
  // caller that does not pass the flag keeps the old conservative behaviour.
  var soleIncluded = matches.filter(function (r) { return /^included$/i.test(r.status); });
  if (soleIncluded.length === 1 && doctor && doctor.identityVerified) {
    return verifiedFromPerformersRow(soleIncluded[0], true);
  }

  var registrar = matches.some(function (r) { return /registrar/i.test(r.role); });
  return {
    outcome: 'pending',
    evidence: registrar
      ? 'NHS England lists this doctor as a GP REGISTRAR (in training), not a qualified GP Performer. Check by hand.'
      : 'NHS England row found but status/role is not a clean Included GP Performer (' + matches.map(function (r) { return r.role + ': ' + r.status; }).join('; ') + '). Check by hand.'
  };
}

// Build the verified verdict from the one name-matched row we settled on.
// roleUnconfirmed = the row was not a clean GP Performer (see performersVerdict):
// the NUMBER is proven, the training status is not.
function verifiedFromPerformersRow(row, roleUnconfirmed) {
  // The same rows already carry the two dates the expedited-pathway cutoff
  // turns on, so screen them here rather than waiting for the certificate
  // upload weeks later (owner 2026-09-17).
  var pathway = assessExpeditedPathway({
    country: 'GB',
    gpRegisterDate: row.gpRegisterDate,
    fullRegistrationDate: row.registeredDate
  });
  if (!roleUnconfirmed) {
    return {
      outcome: 'verified',
      matchedName: performersFullName(row),
      pathway: pathway,
      evidence: 'NHS England Performers List: ' + performersFullName(row) + ', GMC ' + row.number + ', GP Performer, status Included'
        + (row.gpRegisterDate ? ', in the GP Register since ' + row.gpRegisterDate : '')
        + (row.firstOnListDate ? ', on the performers list since ' + row.firstOnListDate : '') + '.'
        + (pathway.reason ? ' Expedited pathway: ' + pathway.reason : '')
    };
  }
  return {
    outcome: 'verified',
    matchedName: performersFullName(row),
    pathway: pathway,
    gpRegisterUnconfirmed: true,
    evidence: 'NHS England Performers List: ' + performersFullName(row) + ', GMC ' + row.number + ', status Included'
      + (row.firstOnListDate ? ', on the performers list since ' + row.firstOnListDate : '') + '.'
      + ' The number and name match and the ID document matched too, so the REGISTRATION is confirmed.'
      + ' NHS England still records the role as "' + row.role + '" and holds no GP Register date — that file lags the GMC register after a CCT,'
      + ' so whether this doctor has finished training is NOT confirmed here. Open the GMC register to read the GP Register date.'
  };
}

// ── Expedited-pathway screen from the register date ─────────────────────────
// Owner 2026-09-17: "when a gp enters their gmc number can we cross check the
// date they were on the gp register and ensure they would have completed the
// nMRCGP curriculum".
//
// The rule, from RACGP's Expedited Specialist Pathway Fellowship Admission
// Policy and the Medical Board's accepted-qualification list: a UK GP needs
// "Membership of the Royal College of General Practitioners MRCGP (United
// Kingdom) from August 2007 onwards together with a Certificate of Completion
// of Training (CCT) issued by the GMC". August 2007 is exactly when nMRCGP
// (AKT + CSA + workplace-based assessment) became the assessment for CCT, so
// the cutoff and the curriculum question are the same question.
//
// A doctor joins the GP Register on the award of their CCT, so the GP Register
// date is a faithful proxy for the CCT date — and NHS England's performers CSV
// carries it. Verified against the GMC's own page for GMC 7705439 on
// 2026-09-17: the register page's "on the GP Register From 05 Feb 2026" is the
// CSV's "05 February 2026", and "Full registration date 07 Jun 2019" is the
// CSV's "Date of Registration". Both dates we already mirror daily.
//
// What the date can and cannot settle:
//  - BEFORE the cutoff: conclusive. The MRCGP cannot be "from August 2007
//    onwards", so the expedited pathway is closed and PEP is the route. This
//    is the same cutoff lib/document-pipeline.js applies to the certificate
//    itself, reused here rather than restated.
//  - ON/AFTER the cutoff: consistent, NOT proof. The Portfolio route (formerly
//    CEGPR) also places a doctor on the GP Register — with no CCT and no
//    nMRCGP — and the public register does not say which route was taken.
//    Only the certificate, or asking the doctor, settles that.
//  - UK GP training is a three-year programme, so a gap of under three years
//    between full registration and GP Register entry cannot be a CCT. That is
//    a strong hint of the Portfolio route and worth a human look.
//
// Conservative like the rest of this file: the only automatic conclusion is
// the one the dates actually prove.
var MIN_UK_GP_TRAINING_YEARS = 3;
// NHS England writes "01 January 1900" where it holds no GP Register date —
// 58 GP Performer rows carried that placeholder when this was measured on
// 2026-09-17. Read literally it is the strongest possible "before the cutoff"
// and would lock those doctors out of the app over a missing field, so
// anything implausibly old is treated as NO date rather than an old one. A
// real 1968 entry exists in the same data and is left alone: pre-cutoff is
// the correct answer for a genuine date.
var REGISTER_DATE_FLOOR = '1960-01-01';
var MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// The performers CSV writes "05 February 2026"; ISO turns up elsewhere.
// Returns 'YYYY-MM-DD', or '' when there is nothing trustworthy to read.
function parseRegisterDate(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';
  var iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var named = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!named) return '';
  var month = MONTH_NAMES.indexOf(named[2].toLowerCase());
  if (month === -1) return '';
  var day = parseInt(named[1], 10);
  if (!(day >= 1 && day <= 31)) return '';
  return named[3] + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

// { country, gpRegisterDate, fullRegistrationDate } →
// { verdict, cutoff, gpRegisterDate, fullRegistrationDate, reason }
// verdict: 'before_cutoff' | 'consistent' | 'short_gap' | 'unknown'
function assessExpeditedPathway(input) {
  var country = String((input && input.country) || '').toUpperCase();
  var cutoff = PEP_DATE_CUTOFFS[country] || '';
  var gpDate = parseRegisterDate(input && input.gpRegisterDate);
  var fullDate = parseRegisterDate(input && input.fullRegistrationDate);
  var base = { verdict: 'unknown', cutoff: cutoff, gpRegisterDate: gpDate, fullRegistrationDate: fullDate, reason: '' };
  if (!cutoff) { base.reason = 'No expedited-pathway cutoff is defined for this country.'; return base; }
  if (!gpDate) { base.reason = 'No GP Register date on record, so the pathway cutoff cannot be checked yet.'; return base; }
  if (gpDate < REGISTER_DATE_FLOOR) {
    base.gpRegisterDate = '';
    base.reason = 'The register shows ' + gpDate + ', which is a "no date held" placeholder rather than a real GP Register date. Check by hand.';
    return base;
  }
  if (gpDate < cutoff) {
    base.verdict = 'before_cutoff';
    base.reason = 'On the GP Register since ' + gpDate + ', before the ' + cutoff
      + ' cutoff — the specialist qualification predates the expedited pathway, so this doctor belongs on the PEP (Substantially Comparable) pathway.';
    return base;
  }
  // On/after the cutoff. Can the timeline even hold a training programme?
  if (fullDate) {
    var gapYears = (Date.parse(gpDate) - Date.parse(fullDate)) / (365.25 * 24 * 60 * 60 * 1000);
    if (gapYears >= 0 && gapYears < MIN_UK_GP_TRAINING_YEARS) {
      base.verdict = 'short_gap';
      base.reason = 'On the GP Register since ' + gpDate + ' (after the ' + cutoff + ' cutoff) but only '
        + gapYears.toFixed(1) + ' years after full registration on ' + fullDate
        + ' — too fast for a three-year training programme, so this is likely the Portfolio route (no CCT). Confirm the certificate by hand.';
      return base;
    }
  }
  base.verdict = 'consistent';
  base.reason = 'On the GP Register since ' + gpDate + ', after the ' + cutoff + ' cutoff'
    + (fullDate ? ' and ' + ((Date.parse(gpDate) - Date.parse(fullDate)) / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1) + ' years after full registration on ' + fullDate : '')
    + ' — consistent with a CCT under the nMRCGP curriculum. The register cannot show whether the route was CCT or Portfolio, so the certificate is still the proof.';
  return base;
}

// ── MCNZ register search (NZ) ───────────────────────────────────────────────
// Search results at /registration/register-of-doctors/?keyword=… are
// server-rendered tiles: title link "Surname, Given Names", an optional
// "previously …" former-name block, a speciality item and a status item
// ("Practising (certificate expires 31 May 2027)" / "Not practising").
function parseMcnzCards(html) {
  var cards = [];
  var blocks = String(html || '').split('b-search-register-tile__wrapper');
  for (var i = 1; i < blocks.length; i++) {
    var b = blocks[i];
    var name = (b.match(/__title-link[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '';
    name = name.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
    var fka = (b.match(/previously\s*<strong>([\s\S]*?)<\/strong>/) || [])[1] || '';
    fka = fka.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    var spec = (b.match(/__content-speciality[\s\S]*?<\/svg>\s*([^<]+)/) || [])[1] || '';
    var status = (b.match(/__content-status[\s\S]*?<\/svg>\s*([^<]+)/) || [])[1] || '';
    var href = (b.match(/href="(\/registration\/register-of-doctors\/doctor\/[^"]+)"/) || [])[1] || '';
    if (name) {
      cards.push({
        name: name,
        formerName: fka,
        speciality: spec.replace(/\s+/g, ' ').trim(),
        status: status.replace(/\s+/g, ' ').trim(),
        href: href
      });
    }
  }
  return cards;
}

function mcnzVerdict(cards, doctor) {
  var matches = (cards || []).filter(function (c) {
    return registerNameMatches(c.name, doctor.firstName, doctor.lastName)
      || (c.formerName && registerNameMatches(c.formerName, doctor.firstName, doctor.lastName));
  });
  if (matches.length !== 1) {
    return {
      outcome: 'pending',
      evidence: matches.length === 0
        ? 'No doctor named ' + doctor.firstName + ' ' + doctor.lastName + ' found on the MCNZ register search. Check by hand.'
        : matches.length + ' doctors on the MCNZ register match this name. Check by hand.'
    };
  }
  var c = matches[0];
  var practising = /^practising/i.test(c.status);
  var gp = /general practice/i.test(c.speciality);
  if (!practising || !gp) {
    return {
      outcome: 'pending',
      evidence: 'MCNZ lists ' + c.name + ' as "' + (c.speciality || 'no speciality') + '", status "' + (c.status || 'unknown') + '". Check by hand.'
    };
  }
  return {
    outcome: 'verified',
    matchedName: c.name,
    evidence: 'MCNZ register: ' + c.name + ', General Practice, ' + c.status + ' (live register search' + (c.href ? ', mcnz.org.nz' + c.href : '') + ').'
  };
}

module.exports = {
  registerNameMatches,
  parseCsvLine,
  parsePerformersRow,
  performersFullName,
  performersVerdict,
  parseRegisterDate,
  assessExpeditedPathway,
  MIN_UK_GP_TRAINING_YEARS,
  REGISTER_DATE_FLOOR,
  parseMcnzCards,
  mcnzVerdict
};
