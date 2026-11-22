// Australian GP build, WP-22: the public job board, the practice map and the
// public job page.
//
//   switch OFF  every public payload and the job page's server-rendered head
//               are exactly what they were before this package (a snapshot
//               taken on the commit before any code changed), and the WP-22
//               filter parameters are ignored like any unknown parameter
//   switch ON   the neutral view: doctor-facing titles, no dollar figure and
//               no percentage, the role's plain facts with "not stated" kept
//               honest, the filters, a neutral head and JobPosting, and never
//               a field that identifies the practice
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const auPublicJobs = require('../lib/au-public-jobs.js');
const auDoctorText = require('../lib/au-doctor-text.js');
const site = require('../lib/site-au-pages.js');
const fx = require('./helpers/au-wp22-fixtures.js');
const { capturePublicParity } = require('./helpers/au-wp22-parity.js');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'au-wp22-public-parity.snapshot.json'), 'utf8'));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const P = (qs) => new URLSearchParams(qs || '');

let server, port, t;

function get(urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const setSwitch = (on) => { process.env.AU_PATHWAY_ENABLED = on ? 'true' : 'false'; };
const seed = () => t.__setPublicJobsRowsCacheForTest({ rows: fx.publicRows(), at: Date.now() });
const board = (qs) => t.buildPublicJobsResponse(fx.publicRows(), P(qs));
const ids = (res) => res.jobs.map((j) => j.id.replace(/^.*wp22-role-|^zoho_recruit:zr-wp22-/, '')).sort();
const jobOf = (n) => board('id=' + encodeURIComponent(fx.publicId(n))).jobs[0];

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-wp22-public-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.OPENAI_API_KEY = '';
  process.env.DB_FILE_PATH = `/tmp/gplink-wp22-public-${RUN_ID}.json`;
  const mod = await import('../server.js');
  t = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
}, 60000);

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  delete process.env.AU_PATHWAY_ENABLED;
});

beforeEach(() => { setSwitch(true); seed(); });

// ── switch off ──────────────────────────────────────────────────────────────

describe('switch OFF: the public job board answers exactly as before WP-22', () => {
  it('every list, map and head value equals the snapshot taken before any code changed', () => {
    setSwitch(false);
    const now = capturePublicParity(t);
    expect(Object.keys(now.jobs).length).toBe(fx.PARITY_QUERIES.length);
    for (const key of Object.keys(SNAPSHOT.snapshot.jobs)) expect(now.jobs[key], 'jobs ' + key).toEqual(SNAPSHOT.snapshot.jobs[key]);
    for (const key of Object.keys(SNAPSHOT.snapshot.map)) expect(now.map[key], 'map ' + key).toEqual(SNAPSHOT.snapshot.map[key]);
    for (const key of Object.keys(SNAPSHOT.snapshot.seo)) expect(now.seo[key], 'seo ' + key).toEqual(SNAPSHOT.snapshot.seo[key]);
    expect(now).toEqual(SNAPSHOT.snapshot);
  });

  it('the WP-22 filter parameters are ignored, like any unknown parameter', () => {
    setSwitch(false);
    const all = board('');
    ['vr=non_vr', 'dpa=yes', 'dpa=unknown', 'area=regional', 'mmm=3', 'sessions=part'].forEach((qs) => {
      expect(board(qs), qs).toEqual(all);
      expect(t.practiceMapHasFilters(P(qs)), qs).toBe(false);
    });
    expect(all.unstated).toBeUndefined();
    all.jobs.forEach((j) => { expect(j.auFacts).toBeUndefined(); expect(j.movingToAustralia).toBeUndefined(); });
  });

  it('the real route sends those same bytes, and no cookie', async () => {
    setSwitch(false);
    for (const qs of ['', 'billing=mixed', 'vr=non_vr&dpa=yes', 'id=' + encodeURIComponent(fx.publicId(1))]) {
      const res = await get('/api/public/jobs' + (qs ? '?' + qs : ''));
      expect(res.status).toBe(200);
      expect(res.json, qs).toEqual(SNAPSHOT.snapshot.jobs[qs] || SNAPSHOT.snapshot.jobs['(none)']);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('the job page head is the one main serves (title, description, JobPosting)', async () => {
    setSwitch(false);
    const res = await get('/jobs/view?id=' + encodeURIComponent(fx.publicId(1)));
    expect(res.status).toBe(200);
    expect(res.raw).toContain('<title>Non-DPA - Parramatta - Mixed Billing — Parramatta, NSW, Australia | GP Link</title>');
    expect(res.raw).toContain('plus free end-to-end support to help you relocate.');
    const ld = JSON.parse(res.raw.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    expect(ld).toEqual(SNAPSHOT.snapshot.seo[fx.publicId(1)].jsonLd);
    expect(res.raw).not.toContain('data-au-apply');
    expect(res.raw).not.toContain('site-au-jobs.js');
    expect(res.raw).toContain('href="/pages/signin?signup=1&next=/pages/career">Apply now');
  });

  it('"Apply now" is today\'s: /jobs/apply is not an address, and nothing is stored', async () => {
    setSwitch(false);
    const unknown = await get('/jobs/this-address-does-not-exist');
    const res = await get('/jobs/apply?id=' + encodeURIComponent(fx.publicId(1)));
    expect(res.status).toBe(unknown.status);
    expect(res.headers.location).toBe(unknown.headers.location);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

// ── titles and figures (lib) ────────────────────────────────────────────────

describe('doctor-facing titles', () => {
  const cases = [
    [{ title: 'Non-DPA - Parramatta - Mixed Billing', suburb: 'Parramatta', location_state: 'NSW' }, 'General Practice · Parramatta, NSW'],
    [{ title: 'DPA - Dubbo - Bulk Billing', location_state: 'New South Wales' }, 'General Practice · Dubbo, NSW'],
    [{ title: 'DPA – Terrigal – Mixed Billing' }, 'General Practice · Terrigal'],
    [{ title: 'non-dpa - Geelong', suburb: 'Geelong', state: 'VIC' }, 'General Practice · Geelong, VIC'],
    [{ title: 'Family GP with a skin interest', suburb: 'Paddington', location_state: 'QLD' }, 'Family GP with a skin interest'],
    [{ title: 'GP, earn $400k', suburb: 'Hobart', location_state: 'TAS' }, 'General Practice · Hobart, TAS'],
    [{ title: '', nearest_city: 'Perth', location_state: 'WA' }, 'General Practice · Perth, WA'],
    [{ title: '', location_state: 'SA' }, 'General Practice · SA'],
    [{}, 'General Practice role']
  ];
  cases.forEach(([role, expected]) => {
    it(`${JSON.stringify(role)} -> ${expected}`, () => {
      expect(auPublicJobs.doctorFacingTitle(role)).toBe(expected);
    });
  });

  it('rewrites an internal title inside a sentence, and leaves other text alone', () => {
    expect(auPublicJobs.rewriteInternalTitles('Your application to Non-DPA - Parramatta - Mixed Billing was received'))
      .toBe('Your application to General Practice · Parramatta was received');
    expect(auPublicJobs.rewriteInternalTitles('DPA eligible')).toBe('DPA eligible');
    expect(auPublicJobs.rewriteInternalTitles('A DPA location with mixed billing')).toBe('A DPA location with mixed billing');
    expect(auPublicJobs.isInternalRoleTitle('General Practitioner')).toBe(false);
  });
});

describe('figures: a dollar amount or a percentage', () => {
  const yes = ['70% to GP', '$350k - $450k', 'GP 70% / Practice 30%', '65 per cent of billings', 'Earn 400k', 'a 70/30 split', '$2,000 a day'];
  const no = ['Mixed billing', '5 km from the beach', 'MM3', '6 to 9 sessions a week', '21/11 at 3pm', 'Open 7 days', '2 practice nurses'];
  yes.forEach((s) => it(`"${s}" is a figure`, () => expect(auPublicJobs.hasFigure(s)).toBe(true)));
  no.forEach((s) => it(`"${s}" is not`, () => expect(auPublicJobs.hasFigure(s)).toBe(false)));

  it('removes the sentence that carries one and keeps the rest', () => {
    expect(auPublicJobs.stripFigures('A clinic. GPs keep 70% of billings. Earn $2.5k a day. Parking on site.')).toBe('A clinic. Parking on site.');
    expect(auPublicJobs.stripFigures('Nothing to remove here.')).toBe('Nothing to remove here.');
    expect(auPublicJobs.stripFigures('$400k')).toBe('');
  });
});

// ── the neutral public payload ──────────────────────────────────────────────

describe('switch ON: the public payload', () => {
  it('every role has a doctor-facing title and no internal one', () => {
    const res = board('limit=100');
    expect(res.total).toBe(7);
    res.jobs.forEach((j) => {
      expect(auPublicJobs.isInternalRoleTitle(j.title), j.title).toBe(false);
      expect(j.title).not.toMatch(/dpa|billing/i);
    });
    expect(jobOf(1).title).toBe('General Practice · Parramatta, NSW');
    expect(jobOf(2).title).toBe('General Practice · Dubbo, NSW');
    expect(jobOf(6).title).toBe('Family GP with a skin interest');
  });

  it('carries no dollar figure and no percentage anywhere', () => {
    const res = board('limit=100');
    res.jobs.forEach((j) => {
      const text = JSON.stringify(Object.assign({}, j, { published_at: '', id: '' }));
      expect(text, j.id).not.toMatch(/\$|%|per cent|\d\s?k\b/i);
      expect(j.earnings_text).toBe('');
    });
    const one = jobOf(1);
    expect(one.packageTerms).toEqual({ supervision: 'Available', visaSponsorship: true });
    expect(one.aiPerks).toEqual([{ label: 'Nursing', value: 'Full-time practice nurses' }, { label: 'Parking', value: 'On site' }]);
    expect(one.aiAbout).toBe('A well established mixed-billing clinic. Parking is on site.');
    expect(one.aiHighlights).toEqual(['Full nursing team', 'Long-standing patients']);
    expect(one.tags).toEqual(['Mixed Billing']);
    expect(one.billing_model).toBe('Mixed Billing');
  });

  it('the neutral copy carries none of the words written for a doctor moving country', () => {
    board('limit=100').jobs.forEach((j) => {
      const neutral = [j.title, j.summary, j.aiAbout, j.display_label].concat(j.aiHighlights, j.tags, j.aiPerks.map((p) => p.label + ' ' + p.value)).join(' \n ');
      expect(auDoctorText.violations(neutral), j.id).toEqual([]);
    });
  });

  it('what is only for a doctor moving country is kept apart, with no figure', () => {
    const m = jobOf(1).movingToAustralia;
    expect(m.sponsorship).toBe(true);
    expect(m.lines).toEqual(['Sponsorship is available for this role', 'Visa sponsorship available', 'Relocation package: Flights and 4 weeks accommodation']);
    m.lines.forEach((l) => expect(auPublicJobs.hasFigure(l)).toBe(false));
    expect(jobOf(2).movingToAustralia).toEqual({ sponsorship: false, lines: [] });
  });

  it('carries the role facts (DAT-28), with "not stated" kept honest', () => {
    expect(jobOf(1).auFacts).toEqual({
      billingModel: 'mixed', vrRequirement: 'vr_required', vrRequirementStated: true, acceptsRegistrars: false, acceptsSupervised: false,
      engagementType: 'permanent', sessionsMin: 6, sessionsMax: 9, specialInterests: ['Skin cancer medicine', "Women's health"],
      mmm: 1, area: 'metro', dpa: 'no', afterHours: null, restraintRadiusKm: null
    });
    // A row as production has it today: nothing stated but the legacy boolean.
    const three = jobOf(3).auFacts;
    expect(three.dpa).toBe('yes');
    expect(three.vrRequirementStated).toBe(false);
    expect(three.sessionsMin).toBeNull();
    // DPA boolean false with no recorded status is NOT "no".
    expect(jobOf(4).auFacts.dpa).toBe('unknown');
    expect(jobOf(4).auFacts.billingModel).toBeNull();
    expect(jobOf(4).auFacts.area).toBeNull();
    expect(jobOf(5).auFacts.dpa).toBe('unknown');
    expect(jobOf(6).auFacts.dpa).toBe('no');
  });

  it('adds exactly two keys to the public allow-list and never a practice-identifying one', () => {
    const offKeys = Object.keys(SNAPSHOT.snapshot.jobs['(none)'].jobs[0]).sort();
    board('limit=100').jobs.forEach((j) => {
      expect(Object.keys(j).sort()).toEqual(offKeys.concat(['auFacts', 'movingToAustralia']).sort());
      const text = JSON.stringify(j);
      expect(text).not.toContain('(FAKE)');
      expect(text).not.toContain('Fake Street');
      expect(text).not.toMatch(/practice_name|practice_id|source_payload|address"/);
    });
    // The legacy row whose raw title and summary name the practice.
    expect(JSON.stringify(jobOf(7))).not.toContain('Test Practice 7');
  });

  it('a closed role is never listed and never resolved by id', () => {
    expect(ids(board('limit=100'))).not.toContain('8');
    expect(board('id=' + encodeURIComponent('internal_ats:wp22-role-8')).jobs).toEqual([]);
  });
});

// ── filters ─────────────────────────────────────────────────────────────────

describe('switch ON: the filters, on the stored fields', () => {
  // [query, the roles listed, roles left out because they do not state it]
  const table = [
    ['', ['1', '2', '3', '4', '5', '6', '7'], 0],
    ['vr=non_vr', ['2'], 4],                    // 3, 4, 6, 7 state nothing: not guessed in
    ['vr=vr', ['1', '3', '4', '5', '6', '7'], 0],
    ['dpa=yes', ['2', '3', '7'], 2],            // 4 and 5 are not stated
    ['dpa=no', ['1', '6'], 2],                  // never 4 or 5
    ['dpa=unknown', ['4', '5'], 0],
    ['area=metro', ['1', '5', '6'], 1],         // 4 states neither
    ['area=regional', ['2', '3', '7'], 1],
    ['mmm=3', ['2'], 1],
    ['mmm=2', ['3', '7'], 1],
    ['mmm=MM2', ['3', '7'], 1],
    ['sessions=part', ['1', '2'], 4],
    ['sessions=full', ['1', '5'], 4],
    ['billing=bulk', ['2'], 0],
    ['billing=mixed', ['1', '5', '6', '7'], 0],
    ['billing=private', ['3'], 0],
    ['state=NSW', ['1', '2'], 0],
    ['state=VIC&dpa=yes', ['3'], 1],
    ['vr=non_vr&dpa=yes&area=regional', ['2'], 3],     // 3, 4 and 7 do not state the VR requirement
    ['dpa=no&area=metro&billing=mixed', ['1', '6'], 1],
    ['q=dubbo', ['2'], 0],
    ['q=mixed billing', ['1', '5', '6', '7'], 0],
    ['q=dpa', ['2', '3', '7'], 0],
    ['q=skin', ['1', '6'], 0],
    ['q=regional', ['2', '3', '7'], 0],
    // a value that is not one of the choices is no filter at all
    ['vr=locum', ['1', '2', '3', '4', '5', '6', '7'], 0],
    ['dpa=maybe&area=moon&mmm=9&sessions=lots', ['1', '2', '3', '4', '5', '6', '7'], 0],
    ['type=locum', ['1', '2', '3', '4', '5', '6', '7'], 0]
  ];
  table.forEach(([qs, expected, unstated]) => {
    it(`${qs || '(none)'} -> ${expected.join(',')}${unstated ? ' (+' + unstated + ' not stated)' : ''}`, () => {
      const res = board(qs + (qs ? '&' : '') + 'limit=100');
      expect(ids(res)).toEqual(expected);
      expect(res.total).toBe(expected.length);
      expect(res.unstated).toBe(unstated);
    });
  });

  it('"not a DPA" never includes a role whose status is unknown or not recorded', () => {
    const no = ids(board('dpa=no&limit=100'));
    expect(no).not.toContain('4');
    expect(no).not.toContain('5');
  });

  it('there is no percentage or billing-split filter', () => {
    expect(auPublicJobs.FILTER_PARAMS).toEqual(['vr', 'dpa', 'area', 'mmm', 'sessions']);
    expect(board('split=70&limit=100').total).toBe(7);
  });

  it('pagination and the id lookup still work', () => {
    const page = board('limit=2&offset=2');
    expect(page.jobs.length).toBe(2);
    expect(page.total).toBe(7);
    expect(board('id=' + encodeURIComponent(fx.publicId(2)) + '&dpa=no').jobs.length).toBe(1);
  });

  it('the real route answers the same', async () => {
    const res = await get('/api/public/jobs?vr=non_vr&dpa=yes');
    expect(res.status).toBe(200);
    expect(res.json).toEqual(board('vr=non_vr&dpa=yes'));
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('switch ON: the map pins', () => {
  const pins = () => fx.publicRows()
    .map((row) => t.sanitizePublicJob.call ? auPublicJobs.neutralPublicJob(t.mapCareerRoleRowToPublicJob(row), row) : null)
    .map((j, i) => t.shapeMapPractice(j, j.location_state, { lat: -33 - i, lng: 151 + i }));

  it('a pin has the doctor-facing title, no income and no figure', () => {
    pins().forEach((p) => {
      expect(p.income).toBe('');
      expect(auPublicJobs.isInternalRoleTitle(p.title)).toBe(false);
      expect(JSON.stringify(p.benefits)).not.toMatch(/\$|%/);
      expect(auDoctorText.violations(JSON.stringify(p.benefits))).toEqual([]);
      expect(JSON.stringify(p)).not.toContain('(FAKE)');
    });
  });

  it('the pins honour the same filters as the list', () => {
    const all = pins();
    const pinIds = (qs) => t.filterPracticeMapPractices(all, P(qs)).map((p) => p.id).sort();
    ['vr=non_vr', 'dpa=yes', 'dpa=no', 'dpa=unknown', 'area=metro', 'mmm=2', 'sessions=part', 'billing=mixed&area=metro', 'q=dpa', 'q=mixed billing', 'state=NSW&q=regional'].forEach((qs) => {
      expect(pinIds(qs), qs).toEqual(board(qs + '&limit=100').jobs.map((j) => j.id).sort());
      expect(t.practiceMapHasFilters(P(qs)), qs).toBe(true);
    });
    expect(t.practiceMapHasFilters(P(''))).toBe(false);
  });
});

// ── the job page head ───────────────────────────────────────────────────────

describe('switch ON: the job page head (meta and JobPosting)', () => {
  const page = (n) => get('/jobs/view?id=' + encodeURIComponent(fx.publicId(n)));
  const jsonLd = (raw) => {
    const blocks = raw.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    expect(blocks.length).toBe(1);
    return JSON.parse(blocks[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  };

  it('title, description and share tags are neutral and carry no figure', async () => {
    const res = await page(1);
    expect(res.status).toBe(200);
    expect(res.raw).toContain('<title>General Practice · Parramatta, NSW | GP Link</title>');
    const desc = res.raw.match(/<meta name="description" content="([^"]*)">/)[1];
    const og = res.raw.match(/<meta property="og:description" content="([^"]*)">/)[1];
    expect(desc).toBe('A well established mixed-billing clinic. Parking is on site.');
    expect(og).toBe(desc);
    [desc, og].forEach((s) => { expect(auDoctorText.violations(s)).toEqual([]); expect(auPublicJobs.hasFigure(s)).toBe(false); });
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/jobs/view?id=internal_ats%3Awp22-role-1">');
  });

  it('a role whose copy is all figures gets the neutral fallback description', () => {
    const job = { title: 'General Practice · Fremantle, WA', location_label: 'Fremantle, WA, Australia', summary: 'Earn $400k. Keep 70% of billings.', aiAbout: '' };
    expect(auPublicJobs.neutralJobMeta(job)).toEqual({
      title: 'General Practice · Fremantle, WA | GP Link',
      description: 'View this GP role in Australia: location, billing model, registration requirement and sessions. GP Link introduces you to the practice in confidence, at no cost to you.'
    });
    expect(auPublicJobs.neutralJobPostingDescription(job)).toBe('General practice opportunity in Fremantle, WA, Australia. GP Link introduces GPs to Australian practices in confidence and supports them through interview, offer and contract, at no cost to the doctor.');
    expect(auDoctorText.violations(auPublicJobs.NEUTRAL_META_FALLBACK)).toEqual([]);
  });

  it('every role\'s served head is free of figures and of the words for a doctor moving country', async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const res = await page(n);
      expect(res.status).toBe(200);
      const desc = res.raw.match(/<meta name="description" content="([^"]*)">/)[1];
      const ld = jsonLd(res.raw);
      [desc, ld.title, ld.description, ld.hiringOrganization.description].forEach((text) => {
        expect(auDoctorText.violations(text), 'role ' + n).toEqual([]);
        expect(auPublicJobs.hasFigure(text), 'role ' + n + ': ' + text).toBe(false);
      });
      expect(res.raw).not.toContain('(FAKE)');
    }
  });

  it('the JobPosting parses, keeps the fields it had, and has no premise about where the doctor is from', async () => {
    const res = await page(1);
    const ld = jsonLd(res.raw);
    const before = SNAPSHOT.snapshot.seo[fx.publicId(1)].jsonLd;
    expect(Object.keys(ld).sort()).toEqual(Object.keys(before).sort());
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.title).toBe('General Practice · Parramatta, NSW');
    expect(ld.baseSalary).toBeUndefined();
    expect(ld.hiringOrganization.name).toBe('GP Link');
    expect(ld.jobLocation.address).toEqual({ '@type': 'PostalAddress', addressCountry: 'AU', addressLocality: 'Parramatta', addressRegion: 'NSW' });
    const text = JSON.stringify(Object.assign({}, ld, { url: '', identifier: '' }));
    expect(auDoctorText.violations(text)).toEqual([]);
    expect(text).not.toMatch(/\$|%/);
    expect(text).not.toContain('(FAKE)');
    expect(text).not.toContain('—');
  });

  it('job text can never break out of the head', () => {
    const job = auPublicJobs.neutralPublicJob(Object.assign(t.mapCareerRoleRowToPublicJob(fx.publicRows()[5]), { summary: 'bad </script><script>alert(1) "quoted" text' }), fx.publicRows()[5]);
    const out = t.injectJobSeoIntoHtml('<head><title>x</title><meta name="description" content="old"></head><body>tail</body>', job);
    expect(out.slice(out.indexOf('application/ld+json'))).not.toContain('</script><script>alert');
    expect(out).toContain('content="bad &lt;/script&gt;&lt;script&gt;alert(1) &quot;quoted&quot;');
    expect(out.match(/<\/head>/g)).toHaveLength(1);
    expect(out.endsWith('<body>tail</body>')).toBe(true);
  });

  it('the sitemap lists the same job addresses as with the switch off, and no filtered ones', async () => {
    const on = await t.buildSitemapXmlBody();
    setSwitch(false);
    const off = await t.buildSitemapXmlBody();
    const jobLines = (xml) => xml.split('\n').filter((l) => l.indexOf('/jobs') !== -1);
    expect(jobLines(on)).toEqual(jobLines(off));
    expect(on).not.toMatch(/\/jobs\?/);
    expect(on).not.toContain('/jobs/apply');
  });
});

// ── the pages ───────────────────────────────────────────────────────────────

describe('switch ON: the pages as served', () => {
  const pageOn = (file) => site.renderPageFile('/pages/' + file, { on: true }).html;

  it('the job page has the two-audience block, each column labelled', () => {
    const html = pageOn('site-job.html');
    const block = html.slice(html.indexOf('id="jobAudience"'), html.indexOf('id="jobRelated"'));
    expect(block).toContain('<h3>If you are already registered in Australia</h3>');
    expect(block).toContain('<h3>If you are moving to Australia</h3>');
    const au = block.slice(block.indexOf('data-audience="australia"'), block.indexOf('data-audience="moving"'));
    ['A confidential introduction:', 'Interview scheduling:', 'Offer and contract:', 'A pre-start checklist:',
      'We never contact your current practice without asking you first.'].forEach((s) => expect(au).toContain(s));
    expect(auDoctorText.violations(au.replace(/<[^>]+>/g, ' '))).toEqual([]);
    const moving = block.slice(block.indexOf('data-audience="moving"'));
    ['Registration &amp; AHPRA paperwork:', 'Visa &amp; relocation:', 'Contract &amp; onboarding support:', 'id="jobMovingLines"'].forEach((s) => expect(moving).toContain(s));
  });

  it('outside the "moving to Australia" column the job page says nothing that is only for a doctor moving country', () => {
    const html = pageOn('site-job.html');
    const start = html.indexOf('data-audience="moving"');
    const end = html.indexOf('id="jobRelated"');
    const body = html.slice(html.indexOf('<body>'));
    const rest = (body.slice(0, body.indexOf('data-audience="moving"')) + html.slice(end)).replace(/<script[\s\S]*?<\/script>/g, ' ');
    expect(start).toBeGreaterThan(0);
    // The shared header links to the page for doctors moving country by name.
    const visible = rest.replace(/<[^>]+>/g, ' ').replace(/Moving to Australia/g, ' ');
    expect(auDoctorText.violations(visible)).toEqual([]);
    const head = html.slice(0, html.indexOf('</head>')).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
    expect(auDoctorText.violations(head)).toEqual([]);
    expect(head).toContain('GP Link introduces you to the practice in confidence, at no cost to you.');
  });

  it('"Apply now" links are marked for the carry-through and not followed by crawlers', () => {
    const html = pageOn('site-job.html');
    const links = html.match(/<a [^>]*data-au-apply[^>]*>/g) || [];
    expect(links.length).toBe(2);
    links.forEach((l) => expect(l).toContain('rel="nofollow"'));
    expect(html).toContain('<script src="/js/au-job-facts.js?v=20261122a"></script>');
    expect(html).toContain('<script src="/js/site-au-jobs.js?v=20261122a"></script>');
    expect(html).toContain('if (window.GPSiteAuJob) window.GPSiteAuJob.render(job);');
  });

  it('the job board has the four new filters, a neutral description, and no "locum"', () => {
    const html = pageOn('site-jobs.html');
    ['<select name="vr">', '<select name="dpa">', '<select name="loc">', '<select name="sessions">',
      '<option value="unknown">Not stated</option>', '<option value="non_vr">Open to GPs without VR</option>',
      '<option value="regional">Regional or rural (MM2 to MM7)</option>', '<option value="mm7">MM7 only</option>',
      'id="resultsNote"', '<script src="/js/site-au-jobs.js?v=20261122a"></script>'].forEach((s) => expect(html).toContain(s));
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).not.toMatch(/locum/i);
    expect(head).not.toMatch(/relocate/i);
    expect(head).toContain('<title>GP Jobs in Australia: Browse Open Roles | GP Link</title>');
    expect(head.match(/Filter by state, billing model, VR requirement, DPA and metro or regional location\./g)).toHaveLength(2);
    expect(html).not.toMatch(/name="(split|percent|percentage)"/i);
    expect(html).not.toContain('Expected income');
    expect(html).not.toContain("getElementById('pmapIncome')");
    // Filtered views are not new indexable pages: one canonical, the board itself.
    expect(head.match(/<link rel="canonical" href="https:\/\/www\.mygplink\.com\.au\/jobs">/g)).toHaveLength(1);
  });

  it('every inline script of both pages parses, switch on and off', () => {
    ['site-job.html', 'site-jobs.html'].forEach((file) => {
      [true, false].forEach((on) => {
        const html = site.renderPageFile('/pages/' + file, { on }).html;
        const scripts = html.match(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g) || [];
        expect(scripts.length).toBeGreaterThan(1);
        scripts.forEach((s, i) => {
          const code = s.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
          expect(() => new vm.Script(code), `${file} script ${i} (${on ? 'on' : 'off'})`).not.toThrow();
        });
      });
    });
  });
});

// ── the browser file ────────────────────────────────────────────────────────

describe('js/site-au-jobs.js', () => {
  const sandbox = { window: {}, document: null, module: { exports: {} } };
  sandbox.window.GPAuJobFacts = require('../js/au-job-facts.js');
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'site-au-jobs.js'), 'utf8'), sandbox);
  const B = sandbox.window.GPSiteAuJobs;
  const J = sandbox.window.GPSiteAuJob;
  const chip = (label, cls) => (cls ? cls + ':' : '') + label;

  it('reads the filters from an address and writes them back the same', () => {
    const extra = B.readUrl(P('vr=non-vr&dpa=unknown&mmm=MM3&area=metro&sessions=part&x=1'));
    expect(JSON.parse(JSON.stringify(extra))).toEqual({ vr: 'non_vr', dpa: 'unknown', mmm: '3', sessions: 'part' });
    expect(B.appendParams(P(''), extra).toString()).toBe('vr=non_vr&dpa=unknown&mmm=3&sessions=part');
    expect(B.any(extra)).toBe(true);
    expect(B.any(B.readUrl(P('vr=locum&dpa=maybe')))).toBe(false);
    expect(B.appendParams(P('q=x'), {}).toString()).toBe('q=x');
  });

  it('the address it writes is one the server filters on', () => {
    const qs = B.appendParams(P(''), B.readUrl(P('vr=non_vr&dpa=yes&area=regional'))).toString();
    expect(ids(board(qs + '&limit=100'))).toEqual(['2']);
  });

  it('a card shows facts as chips: DPA only when known, nothing guessed', () => {
    expect(Array.from(B.chips(jobOf(1), chip))).toEqual(['Mixed billing', 'VR required', 'Metropolitan (MM1)', '6 to 9 sessions']);
    expect(Array.from(B.chips(jobOf(2), chip))).toEqual(['Bulk billing', 'Open to GPs without VR', 'Regional (MM3)', '4 sessions', 'dpa:DPA', 'Contract']);
    expect(Array.from(B.chips(jobOf(3), chip))).toEqual(['Private billing', 'Regional (MM2)', 'dpa:DPA']);
    expect(Array.from(B.chips(jobOf(4), chip))).toEqual([]);
  });

  it('the job page rows state the facts, say "Not stated" where nothing is on file, and carry no sponsorship row', () => {
    const rows = (n) => Array.from(J.profileRows(jobOf(n))).map((r) => Array.from(r).join(': '));
    expect(rows(1)).toEqual([
      'Billing: Mixed billing', 'Registration: Vocational registration (VR) required', 'Sessions: 6 to 9 sessions a week',
      'Location type: Metropolitan (MM1)', 'Engagement: Permanent', "Special interests: Skin cancer medicine, Women's health",
      'Distribution Priority Area: No', 'Nursing: Full-time practice nurses', 'Parking: On site', 'Supervision: Available'
    ]);
    expect(rows(4)).toEqual([
      'Billing: Not stated', 'Registration: Not stated by the practice. Treated as VR required until it is.',
      'Sessions: Not stated', 'Distribution Priority Area: Not stated'
    ]);
    [1, 2, 3, 4, 5, 6, 7].forEach((n) => {
      const text = rows(n).join(' | ');
      expect(auDoctorText.violations(text), 'role ' + n).toEqual([]);
      expect(text).not.toMatch(/\$|%|open to overseas/i);
    });
    expect(Array.from(J.movingLines(jobOf(1)))).toEqual(['Sponsorship is available for this role', 'Visa sponsorship available', 'Relocation package: Flights and 4 weeks accommodation']);
    expect(J.applyHref(jobOf(1))).toBe('/jobs/apply?id=internal_ats%3Awp22-role-1');
  });

  it('the in-app renderer is unchanged without the new option', () => {
    const facts = require('../js/au-job-facts.js');
    expect(facts.rows({ billingModel: 'bulk' })).toEqual([
      { key: 'billing', label: 'Billing', value: 'Bulk billing' },
      { key: 'vr', label: 'Registration', value: 'Vocational registration (VR) required' }
    ]);
    expect(facts.rows({}, { showDpa: true })).toEqual([{ key: 'vr', label: 'Registration', value: 'Vocational registration (VR) required' }]);
  });
});
