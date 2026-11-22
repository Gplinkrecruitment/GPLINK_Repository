// FB-2b (walk-findings W3-D23, R9, R14, R17): the one Australian date and
// time formatter, a date-only value that is the same calendar date in every
// time zone, and the greeting rule.
//
// The zone tests run the real files in a child process with TZ set, because a
// process cannot change its own zone once Intl has been used.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const auDoctor = require('../js/au-doctor.js');
const auGreeting = require('../lib/au-greeting.js');
const { bannedIn } = require('./helpers/au-banned-words.js');

function inZone(tz, script) {
  const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
  return JSON.parse(out);
}
const ZONES = ['America/Los_Angeles', 'Pacific/Honolulu', 'UTC', 'Europe/London', 'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Kiritimati'];

describe('the one formatter (js/au-doctor.js)', () => {
  it('the style: "20 Nov 2026", "Thu 26 Nov 2026", 12-hour times with the zone\'s short label', () => {
    expect(auDoctor.formatDate('2026-11-20')).toBe('20 Nov 2026');
    expect(auDoctor.formatDay('2026-11-26')).toBe('Thu 26 Nov 2026');
    expect(auDoctor.formatTime('2026-11-26T06:30:00Z', 'Australia/Perth')).toBe('2:30 pm AWST');
    expect(auDoctor.formatTime('2026-11-26T06:30:00Z', 'Australia/Sydney')).toBe('5:30 pm AEDT');
    expect(auDoctor.formatTime('2026-07-01T00:05:00Z', 'Australia/Brisbane')).toBe('10:05 am AEST');
    expect(auDoctor.formatClock('2026-11-26T06:30:00Z', 'Australia/Perth')).toBe('2:30 pm');
    expect(auDoctor.formatDateTime('2026-11-26T06:30:00Z', 'Australia/Perth')).toBe('Thu 26 Nov 2026, 2:30 pm AWST');
    expect(auDoctor.formatDay('2026-11-26T22:30:00Z', 'Australia/Sydney')).toBe('Fri 27 Nov 2026');   // the next morning in Sydney
    // a date-only value has no time
    expect(auDoctor.formatTime('2026-11-20')).toBe('');
    expect(auDoctor.formatDateTime('2026-11-20')).toBe('Fri 20 Nov 2026');
  });
  it('anything that is not a date is an empty string, never "Invalid Date"', () => {
    for (const bad of [null, undefined, '', 'soon', '2026-13-40', '2026-02-30', {}]) {
      expect(auDoctor.formatDate(bad), String(bad)).toBe('');
      expect(auDoctor.formatDay(bad), String(bad)).toBe('');
      expect(auDoctor.formatDateTime(bad), String(bad)).toBe('');
    }
  });
  it('custom Intl options still work (existing callers pass them)', () => {
    expect(auDoctor.formatDate('2026-12-01', { day: 'numeric', month: 'short' })).toMatch(/^1 Dec\.?$/);
  });
  it('whole calendar days between two dates', () => {
    expect(auDoctor.daysBetween('2026-11-22', '2026-12-14')).toBe(22);
    expect(auDoctor.daysBetween('2026-12-14', '2026-11-22')).toBe(-22);
    expect(auDoctor.daysBetween('2026-10-03', '2026-10-05')).toBe(2);   // across the start of daylight saving
    expect(auDoctor.daysBetween('x', '2026-10-05')).toBeNull();
  });
});

describe('R14: a date-only value is that calendar date wherever the device is', () => {
  it('js/au-doctor.js formatDate / formatDay: the same answer in eight zones, from far west to far east of UTC', () => {
    const script = "const d=require('./js/au-doctor.js');process.stdout.write(JSON.stringify([d.formatDate('2026-11-20'),d.formatDay('2026-11-20'),d.formatDate('2027-01-01'),d.formatDateTime('2026-11-26T06:30:00Z','Australia/Perth')]))";
    for (const tz of ZONES) expect(inZone(tz, script), tz).toEqual(['20 Nov 2026', 'Fri 20 Nov 2026', '1 Jan 2027', 'Thu 26 Nov 2026, 2:30 pm AWST']);
  });
  it('the OLD formatter was a day out west of UTC (what this replaced)', () => {
    const old = "const d=new Date('2026-11-20');process.stdout.write(JSON.stringify(d.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})))";
    expect(inZone('America/Los_Angeles', old)).toMatch(/^19 Nov/);
    expect(inZone('Australia/Perth', old)).toMatch(/^20 Nov/);
  });
  it('js/au-prestart.js formatDay (Home and the pre-start page)', () => {
    const script = "const p=require('./js/au-prestart.js');process.stdout.write(JSON.stringify([p.formatDay('2026-12-14'),p.formatDay('2027-02-01'),p.formatDay('nope')]))";
    for (const tz of ZONES) expect(inZone(tz, script), tz).toEqual(['14 Dec 2026', '1 Feb 2027', '']);
  });
  it('js/my-documents-au.js: the expiry line is the same date, and the same "in N days", in every zone', () => {
    // 12:00 UTC on 22 Nov 2026 is still the 22nd in Los Angeles and in Perth.
    const script = "const m=require('./js/my-documents-au.js');const now=Date.parse('2026-11-22T12:00:00Z');"
      + "const item=(d)=>({key:'k',label:'L',provider:'you',status:'approved',expiryTracked:true,expiresAt:d,expiryLabel:'Valid until'});"
      + "process.stdout.write(JSON.stringify([m._expiryLine(item('2027-09-30'),now),m._expiryLine(item('2026-12-02'),now),m._expiryLine(item('2026-11-22'),now),m._expiryLine(item('2026-11-21'),now),m._formatDate('2027-09-30')]))";
    const expected = [
      { tone: 'idle', text: 'Valid until 30 Sep 2027' },
      { tone: 'warn', text: 'Valid until 2 Dec 2026 (in 10 days)' },
      { tone: 'warn', text: 'Valid until 22 Nov 2026 (today)' },
      { tone: 'bad', text: 'Expired on 21 Nov 2026. Please upload the current one.' },
      '30 Sep 2027'
    ];
    for (const tz of ['America/Los_Angeles', 'UTC', 'Australia/Perth']) expect(inZone(tz, script), tz).toEqual(expected);
  });
  it('the third site in R14, js/ceo-ats-matching.js, is existing staff code and is NOT changed (reported to the owner)', () => {
    // It prints a TIMESTAMP (when a role was filled) in the viewer's own zone,
    // which is a choice, not the date-only bug. Its test assumes a zone.
    const src = read('js/ceo-ats-matching.js');
    expect(src).toContain("return d.getDate() + ' ' + months[d.getMonth()];");
  });
});

describe('every doctor-facing date site goes through the formatter for an Australian doctor, and is untouched for everyone else', () => {
  const sites = {
    'pages/secure-interview.html': ['if (auDay) return auDay.formatDay(slot.startUtc, displayTzFor(slot) || undefined);', 'if (auClock) return auClock.formatClock(slot.startUtc, displayTzFor(slot) || undefined);', 'if (auConfirm) confirmTimeLabel.textContent = auConfirm.formatDateTime(slot.startUtc, displayTzFor(slot) || undefined);', 'if (auBooked) timeLabel = auBooked.formatDateTime(booked.scheduled_at, viewerTz || undefined) || timeLabel;'],
    'pages/application-detail.html': ['if (auDay) return auDay.formatDay(slot.startUtc, slot.local && slot.local.gp && slot.local.gp.tz);', 'rows.push({ label: "Date", value: auWhen.formatDay(interviewObj.scheduled_at) });', 'rows.push({ label: "Time", value: auWhen.formatTime(interviewObj.scheduled_at) });'],
    'pages/offer-review.html': ["if (auDeadline) setText('deadlineDate', auDeadline.formatDateTime(deadlineDate));", 'if (auLong) return auLong.formatDate(String(iso).length === 10 ? String(iso) : iso) || String(iso);'],
    'pages/career.html': ['if (auDoctorInfo && window.GPAuDoctor && window.GPAuDoctor.formatDay) return window.GPAuDoctor.formatDay(iso, careerDeviceTz || undefined);', 'if (auDoctorInfo && window.GPAuDoctor && window.GPAuDoctor.formatTime) return window.GPAuDoctor.formatTime(iso, careerDeviceTz || undefined);'],
    'pages/account.html': ['return window.GPAuDoctor.formatDate(d) + ", " + window.GPAuDoctor.formatTime(d);'],
    'js/interview-popup.js': ['window.GPAuDoctor.formatDay(iso)', 'window.GPAuDoctor.formatClock(iso)']
  };
  // The lines an overseas doctor's browser runs, byte for byte as they were.
  const untouched = {
    'pages/secure-interview.html': ["return new Intl.DateTimeFormat(undefined, { timeZone: displayTzFor(slot), weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(slot.startUtc));"],
    'pages/application-detail.html': ['rows.push({ label: "Date", value: dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) });'],
    'pages/offer-review.html': ["return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });"],
    'pages/career.html': ['try { return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; }'],
    'pages/account.html': ['return d.toLocaleString(auCareerCvMode ? "en-AU" : [], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });'],
    'js/interview-popup.js': ["try { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }"]
  };
  for (const file of Object.keys(sites)) {
    it(file, () => {
      const src = read(file);
      sites[file].forEach((line) => expect(src, line).toContain(line));
      untouched[file].forEach((line) => expect(src, line).toContain(line));
    });
  }
  it('each page reaches the formatter only for a doctor the session says is Australian', () => {
    for (const file of ['pages/secure-interview.html', 'pages/application-detail.html', 'pages/offer-review.html']) {
      expect(read(file), file).toContain("return (window.GPAuDoctor && typeof window.GPAuDoctor.formatDay === 'function' && window.GPAuDoctor.cached()) ? window.GPAuDoctor : null;");
    }
    // and the picker page's variable exists where career.html uses it
    expect(read('pages/career.html')).toMatch(/const careerDeviceTz = /);
  });
});

describe('R17 / W3-D23: the greeting', () => {
  const cases = [
    // [first-name field, full name, greeting, the single word a WhatsApp variable gets]
    ['Test', 'Test Fullwalk', 'Hi Test,', 'Test'],
    ['', 'Test Fullwalk', 'Hi Test,', 'Test'],
    ['', 'Dr Jane Citizen', 'Hi Jane,', 'Jane'],
    ['', 'dr. jane citizen', 'Hi jane,', 'jane'],
    ['', 'Prof Anna Lee', 'Hi Anna,', 'Anna'],
    ['Dr. Jane', '', 'Hi Jane,', 'Jane'],
    ['', 'Dr Citizen', 'Hi Dr Citizen,', 'there'],
    ['', 'Dr', 'Hi there,', 'there'],
    ['', '', 'Hi there,', 'there'],
    [null, undefined, 'Hi there,', 'there'],
    ['', '  ', 'Hi there,', 'there'],
    ['', '12345', 'Hi there,', 'there'],
    ['', "O'Brien", "Hi O'Brien,", "O'Brien"]
  ];
  it('first name, any title skipped; never the full name, never a bare title; "Hi there" when there is none', () => {
    for (const [first, full, hi, word] of cases) {
      expect(auGreeting.greeting(first, full), JSON.stringify([first, full])).toBe(hi);
      expect(auGreeting.firstNameFor(first, full) || 'there', JSON.stringify([first, full])).toBe(word);
      expect(auGreeting.greeting(first, full)).not.toMatch(/^Hi (Dr|Doctor|Prof|Mr|Mrs|Ms),$/i);
      expect(auGreeting.greeting(first, full)).not.toBe('Hi Test Fullwalk,');
    }
  });
  it('the browser copy gives the same answers', () => {
    for (const [first, full] of cases) {
      expect(auDoctor.greeting(first, full), JSON.stringify([first, full])).toBe(auGreeting.greeting(first, full));
      expect(auDoctor.firstNameFor(first, full), JSON.stringify([first, full])).toBe(auGreeting.firstNameFor(first, full));
      expect(auDoctor.greetingName(first, full), JSON.stringify([first, full])).toBe(auGreeting.greetingName(first, full));
    }
  });
  it('the server uses it for Australian recipients only, at each place a greeting is built from a name', () => {
    const src = read('server.js');
    // the shared doctor email: {{name}}
    expect(src).toContain('if (greetCtx && greetCtx.isAu === true) nameVal = auGreeting.greetingName(gp.firstName, gp.name);');
    expect(src).toContain("let nameVal = gp.firstName || 'there';");
    // the interview invitation ("Hi Test Fullwalk,")
    expect(src).toContain('if (cgAu && cgAu.isAu === true) gpName = auGreeting.greetingName(cgCtx && cgCtx.gpFirstName, cgCtx && cgCtx.gpName);');
    expect(src).toContain("var gpName = (cgCtx && cgCtx.gpName) || 'there';");
    // WhatsApp to an Australian-segment lead ("Hi Dr,")
    expect(src).toContain("if (auCtx) ctx.name = auGreeting.firstNameFor('', row.name) || 'there';");
    expect(src).toContain('const ctx = { name: row.name };');
    // the Australian onboarding nudge
    expect(src).toContain("const firstName = auGreeting.firstNameFor('', row && row.name) || 'there';");
  });
  it('the overseas "Hi Dr" case still exists and is unchanged (reported to the owner, with the one-line fix)', () => {
    // An overseas lead's WhatsApp greets by the first word of the name.
    expect(read('lib/consult-reminders.js')).toContain("return String(name || '').trim().split(/\\s+/)[0] || '';");
    const snap = JSON.parse(read('tests/fixtures/au-wp16-overseas-parity.snapshot.json'));
    expect(JSON.stringify(snap)).toContain('"Dr"');
    // and the Australian snapshot no longer carries it
    expect(read('tests/fixtures/au-wp18-au-reused-whatsapp.snapshot.json')).not.toMatch(/^\s+"Dr",?$/m);
  });
  it('no banned word in the helper', () => {
    expect(bannedIn(read('lib/au-greeting.js').replace(/\/\*[\s\S]*?\*\//g, ''))).toEqual([]);
  });
});

describe('W3-D23: "countersigned"', () => {
  it('a practice is told the doctor has signed "the signed contract" for an Australian candidate; the overseas wording is unchanged', () => {
    const src = read('server.js');
    expect(src).toContain("'. You can download the ' + (fsAuCandidate ? 'signed' : 'countersigned') + ' contract using the button below'");
    expect(src).toContain('const fsAuCtx = await auRoleCtxForUser(fsApp && fsApp.user_id); fsAuCandidate = !!(fsAuCtx && fsAuCtx.isAu === true);');
  });
});
