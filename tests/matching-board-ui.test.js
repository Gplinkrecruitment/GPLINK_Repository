// Task 5 (2026-07-11 matching-board/nudges plan) — the Matching board UI
// (js/ceo-ats-matching.js), a rewrite of the old job/GP picker into a
// funnel-board (spec docs/superpowers/specs/2026-07-11-matching-board-design.md
// Part A + Part D).
//
// js/ceo-ats-matching.js is a classic <script> (not a module) that guards on
// window.ATS existing before defining anything. It is executed here with
// node:vm the same way tests/bypass-config.test.js exercises js/bypass-config.js
// — a sandboxed "browser" context — except we ALSO load the real
// js/ceo-ats-shared.js into the same context first, so window.ATS.esc /
// escAttr / initials / avatarColor / emptyHtml are the REAL implementations,
// not a re-typed stand-in that could quietly drift from them. The module
// exposes its pure HTML-builder functions on window.MatchingBoard purely as
// a test seam (nothing in the module reads it back) so these tests can drive
// them directly with sample data shaped like the Task 4
// GET /api/ats/matching/board response (tests/matching-board-endpoint.test.js
// is the ground truth for that shape).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const sharedSrc = fs.readFileSync(path.join(root, 'js/ceo-ats-shared.js'), 'utf8');
const matchingSrc = fs.readFileSync(path.join(root, 'js/ceo-ats-matching.js'), 'utf8');
const ceoHtml = fs.readFileSync(path.join(root, 'pages/ceo-dashboard.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'css/ceo-ats.css'), 'utf8');

function loadBoard() {
  const fakeDocument = {
    readyState: 'complete',
    getElementById: () => null,
    addEventListener: () => {},
    querySelectorAll: () => [],
    activeElement: null,
  };
  const sandbox = {
    window: {},
    document: fakeDocument,
    console,
    setTimeout, clearTimeout,
    location: { hash: '' },
    history: { replaceState: () => {} },
  };
  vm.createContext(sandbox);
  // ceo-ats-shared.js populates window.ATS with the REAL esc/escAttr/initials
  // /avatarColor/emptyHtml/loadingHtml — its own tail-end initSwitcher() call
  // bails immediately (getElementById('masterTabs') -> null), so nothing
  // network-dependent runs at load time.
  vm.runInContext(sharedSrc, sandbox, { filename: 'ceo-ats-shared.js' });
  vm.runInContext(matchingSrc, sandbox, { filename: 'ceo-ats-matching.js' });
  return sandbox;
}

let sandbox, MB, A;
beforeAll(() => {
  sandbox = loadBoard();
  MB = sandbox.window.MatchingBoard;
  A = sandbox.window.ATS;
});

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const hoursAgo = (n) => iso(NOW - n * 3600000);
const hoursFromNow = (n) => iso(NOW + n * 3600000);
const daysAgo = (n) => iso(NOW - n * 86400000);
const daysFromNow = (n) => iso(NOW + n * 86400000);

function job(overrides) {
  return Object.assign({
    id: 'job-1', title: 'VR GP', practice_id: 'prac-1', practice_name: 'Coral Coast Family Practice',
    city: 'Bundaberg', state: 'QLD', suburb: 'Bargara', type: 'Permanent', dpa: true,
    header_image_url: '', posted: daysAgo(74), days_open: 74, job_status: 'open',
  }, overrides || {});
}
function row(overrides) {
  return Object.assign({ job: job(), pipeline: [], suggestions: [], ranking: null }, overrides || {});
}

describe('module loads and exposes the test seam', () => {
  it('window.loadMatchingTab is exported and window.MatchingBoard carries the pure builders', () => {
    expect(typeof sandbox.window.loadMatchingTab).toBe('function');
    expect(typeof MB).toBe('object');
    ['mbKpisHtml', 'mbRowHtml', 'mbGpRowHtml', 'mbNodeHtml', 'mbExpandHtml', 'mbTrackHtml', 'mbFlipHtml', 'mbLegendHtml', 'mbFilterChipsHtml', 'mbFilledRowHtml']
      .forEach((name) => expect(typeof MB[name]).toBe('function'));
  });
});

describe('urgency buckets (mbUrgencyBucket + mbRowHtml)', () => {
  it('red at >=60 days unfilled, amber at >=30, green otherwise', () => {
    expect(MB.mbUrgencyBucket(74)).toBe('red');
    expect(MB.mbUrgencyBucket(60)).toBe('red');
    expect(MB.mbUrgencyBucket(59)).toBe('amber');
    expect(MB.mbUrgencyBucket(30)).toBe('amber');
    expect(MB.mbUrgencyBucket(29)).toBe('green');
    expect(MB.mbUrgencyBucket(0)).toBe('green');
  });

  it('mbRowHtml renders "74 days unfilled" in the red bucket', () => {
    const html = MB.mbRowHtml(row({ job: job({ days_open: 74 }) }), { nowMs: NOW });
    expect(html).toContain('74 days unfilled');
    expect(html).toMatch(/class="ats-mb-row red"/);
    expect(html).toContain('class="ats-mb-urg red"');
  });

  it('amber for 30-59 days, green under 30', () => {
    const amber = MB.mbRowHtml(row({ job: job({ days_open: 41 }) }), { nowMs: NOW });
    expect(amber).toContain('41 days unfilled');
    expect(amber).toMatch(/class="ats-mb-row amber"/);
    const green = MB.mbRowHtml(row({ job: job({ days_open: 12 }) }), { nowMs: NOW });
    expect(green).toContain('12 days unfilled');
    expect(green).toMatch(/class="ats-mb-row green"/);
  });
});

describe('pipeline node sub-labels', () => {
  it('offer stage: "Offer sent · awaiting sign", no time suffix', () => {
    const r = row({ pipeline: [{ user_id: 'u1', name: 'Dr L. Nguyen', ats_stage: 'offer', stage_updated_at: hoursAgo(50), match: null }] });
    const html = MB.mbTrackHtml(r, NOW);
    expect(html).toContain('Offer sent · awaiting sign');
  });

  it('interview stage: "Interview · {time-in-stage}" (no interview_at field exists)', () => {
    const r = row({ pipeline: [{ user_id: 'u1', name: 'Dr H. Wazalski', ats_stage: 'interview', stage_updated_at: iso(NOW - (3 * 86400000 + 3600000)), match: null }] });
    const html = MB.mbTrackHtml(r, NOW);
    expect(html).toContain('Interview · 3d');
  });

  it('submitted AND reviewing both read "With practice · {time}"', () => {
    const submitted = MB.mbTrackHtml(row({ pipeline: [{ user_id: 'u1', name: 'Dr A. Toma', ats_stage: 'submitted', stage_updated_at: iso(NOW - (2 * 86400000 + 3600000)), match: null }] }), NOW);
    expect(submitted).toContain('With practice · 2d');
    const reviewing = MB.mbTrackHtml(row({ pipeline: [{ user_id: 'u1', name: 'Dr A. Toma', ats_stage: 'reviewing', stage_updated_at: iso(NOW - (2 * 86400000 + 3600000)), match: null }] }), NOW);
    expect(reviewing).toContain('With practice · 2d');
  });

  it('applied stage reads "Applied · {time}"', () => {
    const html = MB.mbTrackHtml(row({ pipeline: [{ user_id: 'u1', name: 'Dr X', ats_stage: 'applied', stage_updated_at: hoursAgo(5), match: null }] }), NOW);
    expect(html).toContain('Applied · 5h');
  });
});

describe('shortlisted node — match-driven sub-label (Part D verbatim)', () => {
  it('⏳ Expires in {X}h when <24h left, amber "expiring" pulse class', () => {
    const match = { score: 84, expires_at: hoursFromNow(14), matched_at: daysAgo(1), seen_at: null, outcome: null, reminder_sent_at: null, final_reminder_sent_at: null, more_time_requested_at: null };
    const sub = MB.mbMatchSubLabel(match, NOW);
    expect(sub.text).toBe('⏳ Expires in 14h');
    expect(sub.cls).toBe('expiring');
    const html = MB.mbTrackHtml(row({ pipeline: [{ user_id: 'u1', name: 'Dr R. Bello', ats_stage: 'shortlisted', stage_updated_at: hoursAgo(1), match }] }), NOW);
    expect(html).toContain('⏳ Expires in 14h');
    expect(html).toMatch(/ats-mb-gnode expiring/);
  });

  it('appends " · nudged ✓" once the final reminder has been sent', () => {
    const match = { score: 84, expires_at: hoursFromNow(6), matched_at: daysAgo(1), seen_at: null, outcome: null, reminder_sent_at: daysAgo(1), final_reminder_sent_at: hoursAgo(1), more_time_requested_at: null };
    const sub = MB.mbMatchSubLabel(match, NOW);
    expect(sub.text).toBe('⏳ Expires in 6h · nudged ✓');
  });

  it('🙋 asked for more time REPLACES the countdown even with days left (endpoint fixture: 3d left + more_time_requested_at set)', () => {
    const match = { score: 82, expires_at: daysFromNow(3), matched_at: daysAgo(2), seen_at: null, outcome: null, reminder_sent_at: daysAgo(1), final_reminder_sent_at: null, more_time_requested_at: hoursAgo(12) };
    const sub = MB.mbMatchSubLabel(match, NOW);
    expect(sub.text).toBe('🙋 asked for more time');
    expect(sub.text).not.toMatch(/Awaiting/);
    expect(sub.cls).toBe('expiring');
  });

  it('a non-expiring, non-flagged shortlist reads "Awaiting · Nd left"', () => {
    const match = { score: 70, expires_at: daysFromNow(3), matched_at: daysAgo(2), seen_at: null, outcome: null, reminder_sent_at: null, final_reminder_sent_at: null, more_time_requested_at: null };
    const sub = MB.mbMatchSubLabel(match, NOW);
    expect(sub.text).toBe('Awaiting · 3d left');
    expect(sub.cls).toBe('await');
  });

  it('a plain (never-matched) applicant on a shortlisted stage falls back to "Awaiting reply"', () => {
    expect(MB.mbMatchSubLabel(null, NOW)).toEqual({ text: 'Awaiting reply', cls: 'await' });
  });
});

describe('suggestions — dimmed, "Suggested" sub-label', () => {
  it('renders dashed/dimmed nodes labelled "Suggested" with a score pill', () => {
    const r = row({
      suggestions: [{ user_id: 'u9', name: 'Dr J. O\'Neill', score: 87, reasons: [], chips: [] }],
      ranking: { generated_at: hoursAgo(2), age_hours: 2, excluded_count: 0 },
    });
    const html = MB.mbTrackHtml(r, NOW);
    expect(html).toContain('Suggested');
    expect(html).toMatch(/ats-mb-gnode sugg/);
    expect(html).toContain('87');
  });
});

describe('age chip (Part D verbatim)', () => {
  it('"ranked {X}d ago · ↻ refresh" when >=24h old', () => {
    const r = row({ ranking: { generated_at: hoursAgo(80), age_hours: 80, excluded_count: 4 } });
    const html = MB.mbTrackHtml(r, NOW);
    expect(html).toContain('ranked 3d ago · ↻ refresh');
  });

  it('"ranked today · ↻ refresh" when under 24h old', () => {
    const r = row({ ranking: { generated_at: hoursAgo(5), age_hours: 5, excluded_count: 0 } });
    const html = MB.mbTrackHtml(r, NOW);
    expect(html).toContain('ranked today · ↻ refresh');
  });
});

describe('empty state and the 6-node cap', () => {
  it('no pipeline + no cached ranking -> only "⚡ Run AI ranking"', () => {
    const html = MB.mbTrackHtml(row(), NOW);
    expect(html.trim()).toContain('⚡ Run AI ranking');
    expect(html).toContain('data-mb-run="job-1"');
    expect(html).not.toContain('ats-mb-gnode');
  });

  it('caps the line at 6 nodes total (pipeline + suggestions), then "+n ▸"', () => {
    const pipeline = [1, 2, 3, 4].map((i) => ({ user_id: 'p' + i, name: 'Dr P' + i, ats_stage: 'applied', stage_updated_at: hoursAgo(1), match: null }));
    const suggestions = [1, 2, 3, 4].map((i) => ({ user_id: 's' + i, name: 'Dr S' + i, score: 70, reasons: [], chips: [] }));
    const html = MB.mbTrackHtml(row({ pipeline, suggestions }), NOW);
    const nodeCount = (html.match(/class="ats-mb-gnode/g) || []).length;
    expect(nodeCount).toBe(6);
    expect(html).toContain('+2 ▸');
  });
});

describe('expand panel (Part D verbatim header + bulk bar)', () => {
  it('renders the verbatim header and, with a selection, the verbatim bulk bar', () => {
    const r = row({
      pipeline: [{ application_id: 'app-1', user_id: 'u1', name: 'Dr Interview', ats_stage: 'interview', stage_updated_at: hoursAgo(2), match: null }],
      suggestions: [
        { user_id: 's1', name: 'Dr Sana Mirza', score: 92, reasons: ['Wants coastal Queensland'], chips: ['DPA eligible role'] },
        { user_id: 's2', name: 'Dr James O\'Neill', score: 87, reasons: [], chips: [] },
      ],
      ranking: { generated_at: hoursAgo(80), age_hours: 80, excluded_count: 4 },
    });
    const html = MB.mbExpandHtml(r, { s1: true }, NOW);
    expect(html).toContain('RANKED MATCHES — review, tick, then notify. Nothing is sent until you click.');
    expect(html).toContain('1 selected');
    expect(html).toContain('each gets the match email + 5-day window · moves to Shortlist stage');
    expect(html).toContain('Shortlist 1 &amp; notify ➜');
    expect(html).toContain('4 GPs excluded before ranking (placed, mid-interview or applications paused)');
    expect(html).toContain('ranked 3d ago');
    expect(html).toContain('Re-run fresh');
    expect(html).toContain('Wants coastal Queensland');
    expect(html).toContain('data-mb-cb="s1" checked');
  });

  it('an empty row (no pipeline, no suggestions) shows an empty message, not a broken panel', () => {
    const html = MB.mbExpandHtml(row(), {}, NOW);
    expect(html).toContain('No matches yet.');
    expect(html).not.toContain('RANKED MATCHES');
  });
});

describe('Extend 5 days — visibility rules', () => {
  function expandWithMatch(match) {
    const r = row({ pipeline: [{ application_id: 'app-1', user_id: 'u1', name: 'Dr X', ats_stage: 'shortlisted', stage_updated_at: hoursAgo(1), match }] });
    return MB.mbExpandHtml(r, {}, NOW);
  }
  it('shown when expiring <24h', () => {
    const html = expandWithMatch({ score: 80, expires_at: hoursFromNow(10), outcome: null, more_time_requested_at: null, final_reminder_sent_at: null });
    expect(html).toContain('data-mb-extend="app-1"');
    expect(html).toContain('Extend 5 days');
  });
  it('shown when already expired', () => {
    const html = expandWithMatch({ score: 80, expires_at: hoursAgo(2), outcome: 'expired', more_time_requested_at: null, final_reminder_sent_at: null });
    expect(html).toContain('data-mb-extend="app-1"');
  });
  it('shown when the GP asked for more time, even with days left', () => {
    const html = expandWithMatch({ score: 80, expires_at: daysFromNow(3), outcome: null, more_time_requested_at: hoursAgo(12), final_reminder_sent_at: null });
    expect(html).toContain('data-mb-extend="app-1"');
  });
  it('hidden with days left and nothing flagged', () => {
    const html = expandWithMatch({ score: 80, expires_at: daysFromNow(3), outcome: null, more_time_requested_at: null, final_reminder_sent_at: null });
    expect(html).not.toContain('data-mb-extend');
  });
  it('hidden on a resolved (accepted) match regardless of timing', () => {
    const html = expandWithMatch({ score: 80, expires_at: hoursAgo(2), outcome: 'accepted', more_time_requested_at: null, final_reminder_sent_at: null });
    expect(html).not.toContain('data-mb-extend');
  });
});

describe('filled rows (Part D verbatim)', () => {
  it('"✓ FILLED — {Dr Name} · {D Mon}" and the redirect line', () => {
    const html = MB.mbFilledRowHtml({
      job: job({ id: 'job-filled', title: 'GP · Full time', practice_name: 'Harbourview Health', practice_id: 'prac-2', city: 'Gladstone', state: 'QLD', posted: '2026-05-07T00:00:00.000Z' }),
      hired: { name: 'Priya Krishnan', at: '2026-06-28T00:00:00.000Z' },
      redirected_count: 3,
    });
    expect(html).toContain('✓ FILLED — Priya Krishnan · 28 Jun');
    expect(html).toContain('3 other GPs redirected to similar roles · redirect emails sent ✓');
    expect(html).toContain('was unfilled 52 days');
  });

  it('omits the redirect line when nobody was redirected', () => {
    const html = MB.mbFilledRowHtml({ job: job(), hired: { name: 'Solo Hire', at: daysAgo(1) }, redirected_count: 0 });
    expect(html).not.toContain('redirected to similar roles');
  });
});

describe('XSS safety — ATS.esc/escAttr on every user-derived string', () => {
  it('a <script> practice name renders escaped, never raw, in a position row', () => {
    const evil = '<script>alert(1)</script>';
    const html = MB.mbRowHtml(row({ job: job({ practice_name: evil }) }), { nowMs: NOW });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('the left block is a plain glassy panel — no photo, no gradient backdrop (owner call 2026-07-12)', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const html = MB.mbRowHtml(row({ job: job({ header_image_url: evil }) }), { nowMs: NOW });
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('ats-mb-photowrap');
    expect(html).not.toContain('linear-gradient(135deg,');
  });

  it('a GP name with HTML in a pipeline node renders escaped', () => {
    const r = row({ pipeline: [{ user_id: 'u1', name: '<b>Dr Evil</b>', ats_stage: 'applied', stage_updated_at: hoursAgo(1), match: null }] });
    const html = MB.mbTrackHtml(r, NOW);
    expect(html).not.toContain('<b>Dr Evil</b>');
    expect(html).toContain('&lt;b&gt;Dr Evil&lt;/b&gt;');
  });

  it('a suggestion reason string renders escaped in the expand panel', () => {
    const r = row({ suggestions: [{ user_id: 's1', name: 'Dr S', score: 80, reasons: ['<img src=x onerror=alert(1)>'], chips: [] }] });
    const html = MB.mbExpandHtml(r, {}, NOW);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('a GP name/email on the flipped board renders escaped', () => {
    const gpRow = { gp: { user_id: 'gp1', name: '<script>x</script>', email: '"><script>y</script>', days_on_books: 5 }, live: [], suggestions: [], ranking: null };
    const html = MB.mbGpRowHtml(gpRow, { nowMs: NOW });
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<script>y</script>');
  });
});

describe('corporate groups — opening name leads, group is a tile (owner call 2026-07-12)', () => {
  const groupJob = () => job({ id: 'job-9', title: 'General Practitioner || Woodlake Village Medical Centre', practice_name: 'GP West Group', practice_id: 'prac-gw' });
  it('headline is the opening name, not the corporation', () => {
    const html = MB.mbRowHtml(row({ job: groupJob() }), { nowMs: NOW });
    expect(html).toMatch(/ats-mb-pname">Woodlake Village Medical Centre</);
    expect(html).not.toMatch(/ats-mb-pname">GP West Group</);
  });
  it('renders a corporation tile that opens the practice page', () => {
    const html = MB.mbRowHtml(row({ job: groupJob() }), { nowMs: NOW });
    expect(html).toMatch(/ats-mb-corp" data-mb-open-practice="prac-gw"/);
    expect(html).toContain('GP West Group');
  });
  it('the card itself opens the job opening page', () => {
    const html = MB.mbRowHtml(row({ job: groupJob() }), { nowMs: NOW });
    expect(html).toMatch(/ats-mb-left" data-mb-open-job="job-9"/);
  });
  it('subtitle keeps the role part of the title, not the duplicated opening name', () => {
    const html = MB.mbRowHtml(row({ job: groupJob() }), { nowMs: NOW });
    expect(html).toMatch(/ats-mb-postitle">General Practitioner · Permanent · DPA</);
  });
  it('no tile when the practice name IS the opening name (independent practice)', () => {
    const html = MB.mbRowHtml(row({ job: job({ title: 'General Practitioner || Bay Village Medical Centre', practice_name: 'Bay village medical centre' }) }), { nowMs: NOW });
    expect(html).not.toContain('ats-mb-corp');
    expect(html).toMatch(/ats-mb-pname">Bay village medical centre</);
  });
  it('titles without the || separator keep the practice-name headline (legacy shape)', () => {
    const html = MB.mbRowHtml(row(), { nowMs: NOW }); // fixture title 'VR GP'
    expect(html).toMatch(/ats-mb-pname">Coral Coast Family Practice</);
    expect(html).not.toContain('ats-mb-corp');
    expect(html).toMatch(/ats-mb-left" data-mb-open-job="job-1"/);
  });
  it('a group opening name with HTML renders escaped in headline and tile', () => {
    const html = MB.mbRowHtml(row({ job: job({ title: 'GP || <script>z</script> Clinic', practice_name: '<b>Corp</b> Group', practice_id: 'p9' }) }), { nowMs: NOW });
    expect(html).not.toContain('<script>z</script>');
    expect(html).not.toContain('<b>Corp</b>');
    expect(html).toContain('&lt;script&gt;z&lt;/script&gt; Clinic');
    expect(html).toContain('&lt;b&gt;Corp&lt;/b&gt; Group');
  });
  it('filled rows use the same opening-name headline + group tile', () => {
    const html = MB.mbFilledRowHtml({
      job: job({ id: 'job-f', title: 'General Practitioner || Carrara Health Centre', practice_name: 'ForHealth', practice_id: 'prac-fh', posted: daysAgo(40) }),
      hired: { name: 'Dr A', at: daysAgo(1) },
      redirected_count: 0,
    });
    expect(html).toMatch(/ats-mb-pname"[^>]*>Carrara Health Centre</);
    expect(html).toMatch(/ats-mb-corp" data-mb-open-practice="prac-fh"/);
  });
});

describe('GPs -> Positions (flip) urgency + track', () => {
  function gpRow(overrides) {
    return Object.assign({ gp: { user_id: 'gp1', name: 'Dr Sana Mirza', email: 'sana@test.local', days_on_books: 5 }, live: [], suggestions: [], ranking: null }, overrides || {});
  }
  it('red >=21d with nothing sent, includes "no matches sent"', () => {
    const html = MB.mbGpRowHtml(gpRow({ gp: { user_id: 'gp1', name: 'Dr X', days_on_books: 26 } }), { nowMs: NOW });
    expect(html).toContain('26 days on the books · no matches sent');
    expect(html).toMatch(/class="ats-mb-row red"/);
  });
  it('amber >=7d nothing sent', () => {
    const html = MB.mbGpRowHtml(gpRow({ gp: { user_id: 'gp1', name: 'Dr X', days_on_books: 11 } }), { nowMs: NOW });
    expect(html).toMatch(/class="ats-mb-row amber"/);
  });
  it('green once something has been sent, and drops the "no matches sent" suffix', () => {
    const html = MB.mbGpRowHtml(gpRow({
      gp: { user_id: 'gp1', name: 'Dr X', days_on_books: 26 },
      live: [{ application_id: 'a1', career_role_id: 'job-cand', title: 'GP — Candidate Job', practice_name: 'Cand Practice', ats_stage: 'interview', stage_updated_at: hoursAgo(4), match: null }],
    }), { nowMs: NOW });
    expect(html).toMatch(/class="ats-mb-row green"/);
    expect(html).not.toContain('no matches sent');
  });
  it('mirrors the funnel track using practice_name as the node label', () => {
    const r = gpRow({ live: [{ application_id: 'a1', career_role_id: 'job-cand', title: 'GP — Candidate Job', practice_name: 'Cand Practice', ats_stage: 'interview', stage_updated_at: iso(NOW - (3 * 86400000)), match: null }] });
    const html = MB.mbGpTrackHtml(r, NOW);
    expect(html).toContain('Cand Practice');
    expect(html).toContain('Interview');
  });
  it('expand panel per-node "Open job board" action uses career_role_id', () => {
    const r = gpRow({ live: [{ application_id: 'a1', career_role_id: 'job-cand', title: 'GP — Candidate Job', practice_name: 'Cand Practice', ats_stage: 'interview', stage_updated_at: hoursAgo(4), match: null }] });
    const html = MB.mbExpandHtml(r, {}, NOW);
    expect(html).toContain('data-mb-open-job="job-cand"');
    expect(html).toContain('Open job board');
  });
  it('gps suggestions carry a checkbox keyed by career_role_id', () => {
    const r = gpRow({ suggestions: [{ career_role_id: 'job-74d', title: 'GP — Long Open Role', practice_name: 'Open Roles Practice', score: 88, reasons: ['great fit'], chips: [] }] });
    const html = MB.mbExpandHtml(r, {}, NOW);
    expect(html).toContain('data-mb-cb="job-74d"');
    expect(html).toContain('Open Roles Practice');
  });
});

describe('running state — generic copy, no fabricated numbers', () => {
  it('mbRowHtml shows the shimmer + generic running copy when runningIds carries the job id', () => {
    const html = MB.mbRowHtml(row(), { nowMs: NOW, runningIds: { 'job-1': true } });
    expect(html).toContain('🤖 Ranking eligible GPs against this position… usually 10–20 seconds');
    expect(html).toContain('ats-mb-ghost');
    expect(html).not.toMatch(/Ranking \d+ eligible/);
  });
  it('mbGpRowHtml uses the GP-flavoured running copy', () => {
    const gpRow = { gp: { user_id: 'gp1', name: 'Dr X', days_on_books: 1 }, live: [], suggestions: [], ranking: null };
    const html = MB.mbGpRowHtml(gpRow, { nowMs: NOW, runningIds: { gp1: true } });
    expect(html).toContain('🤖 Ranking eligible jobs for this GP… usually 10–20 seconds');
  });
});

describe('KPI tiles (mbKpisHtml)', () => {
  it('renders all four labels and reflects active filters', () => {
    const html = MB.mbKpisHtml({ open: 12, unfilled60: 3, awaiting: 5, accepted_week: 2 }, { urgency: '60', status: '' });
    expect(html).toContain('OPEN POSITIONS');
    expect(html).toContain('UNFILLED 60+ DAYS');
    expect(html).toContain('AWAITING GP REPLY');
    expect(html).toContain('ACCEPTED THIS WEEK');
    expect(html).toContain('>12<');
    expect(html).toMatch(/ats-mb-kpi hot active/);
  });
  it('works with a single argument (kpis only)', () => {
    expect(() => MB.mbKpisHtml({ open: 1, unfilled60: 0, awaiting: 0, accepted_week: 0 })).not.toThrow();
  });
});

describe('flip toggle (mbFlipHtml)', () => {
  it('marks the current direction "on"', () => {
    const positions = MB.mbFlipHtml('positions');
    expect(positions).toMatch(/class="on" data-mb-flip="positions"/);
    const gps = MB.mbFlipHtml('gps');
    expect(gps).toMatch(/class="on" data-mb-flip="gps"/);
    expect(positions).toContain('Positions → GPs');
    expect(positions).toContain('GPs → Positions');
  });
});

describe('legend (verbatim)', () => {
  it('lists all six line-guide entries', () => {
    const html = MB.mbLegendHtml();
    ['Offer', 'Interview', 'With practice', 'Awaiting reply', 'Expiring &lt;24h', 'Suggested (not contacted)'].forEach((t) => expect(html).toContain(t));
  });
});

describe('filter chips with live counts', () => {
  const rows = [
    { job: job({ id: 'j1', days_open: 74 }), pipeline: [{ user_id: 'u1', ats_stage: 'shortlisted' }], suggestions: [] },
    { job: job({ id: 'j2', days_open: 41 }), pipeline: [], suggestions: [] },
    { job: job({ id: 'j3', days_open: 10 }), pipeline: [], suggestions: [] },
  ];
  it('positions: 60d+, 30d+, No matches sent, Awaiting reply counts, plus state select + DPA chip', () => {
    const html = MB.mbFilterChipsHtml('positions', rows, {});
    expect(html).toContain('60d+ (1)');
    expect(html).toContain('30d+ (2)');
    expect(html).toContain('No matches sent (2)');
    expect(html).toContain('Awaiting reply (1)');
    expect(html).toContain('ats-mb-state-select');
    expect(html).toContain('DPA only');
  });
  it('gps direction omits the state select and DPA chip (no such fields on a gp row)', () => {
    const gpRows = [{ gp: { user_id: 'g1' }, live: [] }, { gp: { user_id: 'g2' }, live: [{ ats_stage: 'shortlisted' }] }];
    const html = MB.mbFilterChipsHtml('gps', gpRows, {});
    expect(html).not.toContain('ats-mb-state-select');
    expect(html).not.toContain('DPA only');
    expect(html).toContain('No matches sent (1)');
    expect(html).toContain('Awaiting reply (1)');
  });
});

describe('client-side row filtering', () => {
  const rows = [
    { job: job({ id: 'j1', days_open: 74, state: 'QLD', dpa: true, practice_name: 'Coral Coast' }), pipeline: [], suggestions: [] },
    { job: job({ id: 'j2', days_open: 10, state: 'NSW', dpa: false, practice_name: 'Riverbend' }), pipeline: [{ user_id: 'u1', ats_stage: 'shortlisted' }], suggestions: [] },
  ];
  it('urgency, dpa, state and search all narrow the list', () => {
    expect(MB.mbFilterPositionsRows(rows, { urgency: '60' }).map((r) => r.job.id)).toEqual(['j1']);
    expect(MB.mbFilterPositionsRows(rows, { dpa: true }).map((r) => r.job.id)).toEqual(['j1']);
    expect(MB.mbFilterPositionsRows(rows, { state: 'NSW' }).map((r) => r.job.id)).toEqual(['j2']);
    expect(MB.mbFilterPositionsRows(rows, { q: 'riverbend' }).map((r) => r.job.id)).toEqual(['j2']);
    expect(MB.mbFilterPositionsRows(rows, { status: 'nomatches' }).map((r) => r.job.id)).toEqual(['j1']);
    expect(MB.mbFilterPositionsRows(rows, { status: 'awaiting' }).map((r) => r.job.id)).toEqual(['j2']);
  });
});

describe('wiring pins (source-level — network/DOM behaviour not exercised under vm)', () => {
  it('fetches the Task 4 board endpoint by direction', () => {
    expect(matchingSrc).toContain("'/api/ats/matching/board?direction=' + (isGp ? 'gps' : 'positions')");
  });
  it('shortlist goes through the existing endpoint with the {items:[...]} body', () => {
    expect(matchingSrc).toMatch(/\/api\/ats\/matching\/shortlist',\s*\{\s*method:\s*'POST',\s*body:\s*\{\s*items:\s*items\s*\}\s*\}/);
  });
  it('extend goes through the existing PATCH endpoint', () => {
    expect(matchingSrc).toMatch(/\/api\/ats\/application\?id='\s*\+\s*encodeURIComponent\(applicationId\),\s*\{\s*method:\s*'PATCH',\s*body:\s*\{\s*match_extend:\s*true\s*\}\s*\}/);
  });
  it('refresh appends &force=1 and is gated behind a confirm()', () => {
    expect(matchingSrc).toContain("if (force) path += '&force=1';");
    expect(matchingSrc).toMatch(/window\.confirm\(/);
  });
  it('run/refresh use the existing candidates/jobs ranking endpoints', () => {
    expect(matchingSrc).toContain("/api/ats/matching/candidates?job_id='");
    expect(matchingSrc).toContain("/api/ats/matching/jobs?user_id='");
  });
  it('cross-module opens use the documented hooks', () => {
    expect(matchingSrc).toContain('window.atsOpenCandidate(id)');
    expect(matchingSrc).toContain('window.atsOpenJobBoard(id)');
    expect(matchingSrc).toContain('window.atsOpenPractice(id)');
    // Final-review fix (Finding 3): drill-ins must activate the tab via the
    // skipLoad=true path (ATS.setActiveTab), NOT ATS.showMaster() — showMaster
    // also fires that tab's list loader, a second async render that can race
    // the opener call below it and clobber the just-opened detail view.
    expect(matchingSrc).toMatch(/ATS\.setActiveTab\('practices',\s*true\)/);
    expect(matchingSrc).toMatch(/ATS\.setActiveTab\('candidates',\s*true\)/);
    expect(matchingSrc).toMatch(/ATS\.setActiveTab\('jobs',\s*true\)/);
    expect(matchingSrc).not.toMatch(/ATS\.showMaster\('practices'\)/);
    expect(matchingSrc).not.toMatch(/ATS\.showMaster\('candidates'\)/);
    expect(matchingSrc).not.toMatch(/ATS\.showMaster\('jobs'\)/);
  });
  it('25 rows + Show more', () => {
    expect(matchingSrc).toContain('visibleCount: 25');
    expect(matchingSrc).toContain('data-mb-show-more');
  });
  it('renders into #panel-matching', () => {
    expect(matchingSrc).toContain("document.getElementById('panel-matching')");
  });
  it('exports window.loadMatchingTab', () => {
    expect(matchingSrc).toContain('window.loadMatchingTab = loadMatchingTab;');
  });
});

describe('sort control (spec Part A top bar: "sort (default: longest unfilled first)")', () => {
  it('positions toolbar carries the sort select: Longest unfilled (default) / Practice A–Z', () => {
    const html = MB.mbFilterChipsHtml('positions', [], {});
    expect(html).toContain('ats-mb-sort-select');
    expect(html).toMatch(/<option value="default" selected>Longest unfilled<\/option>/);
    expect(html).toMatch(/<option value="az">Practice A–Z<\/option>/);
  });
  it('gps toolbar mirrors it: Waiting longest (default) / GP A–Z', () => {
    const html = MB.mbFilterChipsHtml('gps', [], {});
    expect(html).toMatch(/<option value="default" selected>Waiting longest<\/option>/);
    expect(html).toMatch(/<option value="az">GP A–Z<\/option>/);
  });
  it('a chosen sort persists as the selected option across re-renders', () => {
    const html = MB.mbSortSelectHtml('positions', 'az');
    expect(html).toMatch(/<option value="az" selected>Practice A–Z<\/option>/);
    expect(html).not.toMatch(/value="default" selected/);
  });

  const posRows = [
    { job: job({ id: 'j-short', days_open: 10, practice_name: 'Zebra Health' }), pipeline: [], suggestions: [] },
    { job: job({ id: 'j-long', days_open: 74, practice_name: 'Mango Medical' }), pipeline: [], suggestions: [] },
    { job: job({ id: 'j-mid', days_open: 41, practice_name: 'Apple Clinic' }), pipeline: [], suggestions: [] },
  ];
  it('positions default sort = days_open desc (longest unfilled first)', () => {
    expect(MB.mbSortRows(posRows, 'positions', 'default').map((r) => r.job.id)).toEqual(['j-long', 'j-mid', 'j-short']);
  });
  it('positions A–Z sorts by practice_name', () => {
    expect(MB.mbSortRows(posRows, 'positions', 'az').map((r) => r.job.practice_name)).toEqual(['Apple Clinic', 'Mango Medical', 'Zebra Health']);
  });

  const gpSortRows = [
    { gp: { user_id: 'g-new', name: 'Zara Young', days_on_books: 2 }, live: [], suggestions: [] },
    { gp: { user_id: 'g-old', name: 'Milo Old', days_on_books: 30 }, live: [], suggestions: [] },
    { gp: { user_id: 'g-mid', name: 'Ada Mid', days_on_books: 12 }, live: [], suggestions: [] },
  ];
  it('gps default sort = days_on_books desc (waiting longest first)', () => {
    expect(MB.mbSortRows(gpSortRows, 'gps', 'default').map((r) => r.gp.user_id)).toEqual(['g-old', 'g-mid', 'g-new']);
  });
  it('gps A–Z sorts by GP name', () => {
    expect(MB.mbSortRows(gpSortRows, 'gps', 'az').map((r) => r.gp.name)).toEqual(['Ada Mid', 'Milo Old', 'Zara Young']);
  });

  it('renderBoard applies the sort before the 25-row slice (source pin)', () => {
    expect(matchingSrc).toContain('filteredRows = mbSortRows(filteredRows, state.direction, state.filters.sort);');
    const renderFn = matchingSrc.slice(matchingSrc.indexOf('function renderBoard'), matchingSrc.indexOf('function mbFindExpandedRow'));
    expect(renderFn.indexOf('mbSortRows')).toBeGreaterThan(-1);
    expect(renderFn.indexOf('mbSortRows')).toBeLessThan(renderFn.indexOf('.slice(0, state.visibleCount)'));
  });
  it('the change handler wires data-mb-sort into state.filters.sort (source pin)', () => {
    expect(matchingSrc).toContain("t.getAttribute('data-mb-sort') != null) onSortSelectChange(t.value);");
    expect(matchingSrc).toContain("function onSortSelectChange(val) { state.filters.sort = val || 'default';");
  });
});

describe('pipeline node ordering — defensive most-progressed-first sort', () => {
  // Deliberately shuffled (least-progressed first) to prove the board does
  // NOT silently depend on the server's offer-first ordering.
  const shuffled = [
    { application_id: 'a-short', user_id: 'u-short', name: 'Dr Shortlist First', ats_stage: 'shortlisted', stage_updated_at: hoursAgo(1), match: { score: 80, expires_at: daysFromNow(3), outcome: null, more_time_requested_at: null, final_reminder_sent_at: null } },
    { application_id: 'a-app', user_id: 'u-app', name: 'Dr Applied Second', ats_stage: 'applied', stage_updated_at: hoursAgo(2), match: null },
    { application_id: 'a-offer', user_id: 'u-offer', name: 'Dr Offer Last', ats_stage: 'offer', stage_updated_at: hoursAgo(3), match: null },
    { application_id: 'a-int', user_id: 'u-int', name: 'Dr Interview Mid', ats_stage: 'interview', stage_updated_at: hoursAgo(4), match: null },
  ];
  const orderOf = (html, names) => names.map((n) => html.indexOf(n));
  const isAscending = (xs) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

  it('mbSortPipeline ranks offer < interview < reviewing/submitted < applied < shortlisted, without mutating its input', () => {
    const input = shuffled.slice();
    const sorted = MB.mbSortPipeline(input);
    expect(sorted.map((p) => p.ats_stage)).toEqual(['offer', 'interview', 'applied', 'shortlisted']);
    expect(input.map((p) => p.ats_stage)).toEqual(['shortlisted', 'applied', 'offer', 'interview']); // untouched
  });
  it('mbTrackHtml renders a shuffled pipeline offer-first', () => {
    const html = MB.mbTrackHtml(row({ pipeline: shuffled }), NOW);
    expect(isAscending(orderOf(html, ['Dr Offer Last', 'Dr Interview Mid', 'Dr Applied Second', 'Dr Shortlist First']))).toBe(true);
  });
  it('mbExpandHtml lists the same shuffled pipeline offer-first', () => {
    const html = MB.mbExpandHtml(row({ pipeline: shuffled }), {}, NOW);
    expect(isAscending(orderOf(html, ['Dr Offer Last', 'Dr Interview Mid', 'Dr Applied Second', 'Dr Shortlist First']))).toBe(true);
  });
  it('mbGpTrackHtml sorts a shuffled live[] the same way', () => {
    const live = [
      { application_id: 'a1', career_role_id: 'r1', title: 'Role One', practice_name: 'Practice Shortlisted', ats_stage: 'shortlisted', stage_updated_at: hoursAgo(1), match: null },
      { application_id: 'a2', career_role_id: 'r2', title: 'Role Two', practice_name: 'Practice Offer', ats_stage: 'offer', stage_updated_at: hoursAgo(2), match: null },
    ];
    const html = MB.mbGpTrackHtml({ gp: { user_id: 'g1', name: 'Dr X', days_on_books: 3 }, live, suggestions: [], ranking: null }, NOW);
    expect(isAscending(orderOf(html, ['Practice Offer', 'Practice Shortlisted']))).toBe(true);
  });
});

describe('KPI clear + flip refetch (source pins — behaviour requires a live DOM to exercise end-to-end)', () => {
  it('the "open" KPI tile clears urgency/status/dpa/state (its "filter" is "show everything")', () => {
    const fn = matchingSrc.slice(matchingSrc.indexOf('function onKpiClick'), matchingSrc.indexOf('function onFlipClick'));
    expect(fn).toMatch(/key === 'open'/);
    expect(fn).toContain("state.filters.urgency = ''; state.filters.status = ''; state.filters.dpa = false; state.filters.state = '';");
  });
  it('flipping direction always refetches the board (never silently reuses stale data)', () => {
    const fn = matchingSrc.slice(matchingSrc.indexOf('function onFlipClick'), matchingSrc.indexOf('function onFilterChipClick'));
    expect(fn).toContain('fetchBoard();');
  });
  it('a row click never re-fetches — expand uses data already loaded in state.boardData', () => {
    const fn = matchingSrc.slice(matchingSrc.indexOf('function onRowToggle'), matchingSrc.indexOf('function onKpiClick'));
    expect(fn).not.toContain('fetchBoard');
    expect(fn).not.toContain('A.api(');
  });
});

describe('funnel line — solid through the pipeline, dashed through suggestions', () => {
  it('css/ceo-ats.css draws the connecting line via pipezone/suggzone ::before', () => {
    expect(cssSrc).toMatch(/\.ats-mb-pipezone::before\s*\{[^}]*background:var\(--ats-blue\)/);
    expect(cssSrc).toMatch(/\.ats-mb-suggzone::before\s*\{[^}]*border-top:2px dashed/);
  });
});

describe('cache buster + dead CSS pruned', () => {
  it('ceo-dashboard.html loads the bumped matching script, and only that tag', () => {
    expect(ceoHtml).toContain('/js/ceo-ats-matching.js?v=20260712a');
    expect(ceoHtml).not.toContain('/js/ceo-ats-matching.js?v=20260711a');
  });
  it('ceo-dashboard.html loads the bumped board stylesheet (a stale pin serves pre-board CSS from cache)', () => {
    expect(ceoHtml).toContain('/css/ceo-ats.css?v=20260712a');
    expect(ceoHtml).not.toContain('/css/ceo-ats.css?v=20260711b');
    expect(ceoHtml).not.toContain('/css/ceo-ats.css?v=20260707a');
  });
  it('the old picker CSS classes are gone; the kanban match-status classes survive', () => {
    // Checked as CSS rule declarations (class name + "{"), not bare
    // substrings — this file's own header comment names the removed classes
    // in prose for historical context, which a plain substring check would
    // false-positive on.
    ['.ats-match-direction {', '.ats-match-picker {', '.ats-match-toolbar {', '.ats-match-list {', '.ats-match-row {', '.ats-match-score {', '.ats-match-body {', '.ats-match-name {', '.ats-match-reasons {', '.ats-match-chips {', '.ats-match-actions {']
      .forEach((cls) => expect(cssSrc).not.toContain(cls));
    expect(cssSrc).toContain('.ats-match-status {');
    expect(cssSrc).toContain('.ats-match-status.ats-match-amber');
    expect(cssSrc).toContain('.ats-match-status.ats-match-expired');
  });
});
