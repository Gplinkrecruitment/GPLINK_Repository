'use strict';
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
  if (included.length !== 1) {
    var registrar = matches.some(function (r) { return /registrar/i.test(r.role); });
    return {
      outcome: 'pending',
      evidence: registrar
        ? 'NHS England lists this doctor as a GP REGISTRAR (in training), not a qualified GP Performer. Check by hand.'
        : 'NHS England row found but status/role is not a clean Included GP Performer (' + matches.map(function (r) { return r.role + ': ' + r.status; }).join('; ') + '). Check by hand.'
    };
  }
  var row = included[0];
  return {
    outcome: 'verified',
    matchedName: performersFullName(row),
    evidence: 'NHS England Performers List: ' + performersFullName(row) + ', GMC ' + row.number + ', GP Performer, status Included'
      + (row.gpRegisterDate ? ', in the GP Register since ' + row.gpRegisterDate : '')
      + (row.firstOnListDate ? ', on the performers list since ' + row.firstOnListDate : '') + '.'
  };
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
  parseMcnzCards,
  mcnzVerdict
};
