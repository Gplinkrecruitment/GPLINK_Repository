import { describe, it, expect } from 'vitest';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const derive = require(path.join(__dirname, '..', 'js', 'interview-card-state.js'));

const read = (rel) => readFileSync(path.join(__dirname, '..', rel), 'utf8');
const indexSrc = read('pages/index.html');
const careerSrc = read('pages/career.html');
const serverSrc = read('server.js');

// ── The onboarding gateway ────────────────────────────────────────────────────
// A fully-onboarded doctor (Khaleed Crypto: user_profiles.onboarding_completed_at AND
// user_state.gp_onboarding_complete both set) hit the onboarding screens on login.
// requireSession answers 401 with a VALID JSON body, so .json() resolves, .catch() never
// runs, `d.state` is undefined — and the old code treated that as "not onboarded".

// Replay the real gateway decision from the page source, so the test tracks the shipped code.
function gateDecision({ httpOk, body }) {
  const src = indexSrc;
  const start = src.indexOf('if (!res.httpOk || !res.body || res.body.ok !== true)');
  expect(start).toBeGreaterThan(-1);
  const marker = 'window.location.replace("onboarding");';
  const markerAt = src.indexOf(marker, start);
  expect(markerAt).toBeGreaterThan(-1);
  const block = src.slice(start, markerAt + marker.length).replace(marker, 'return "onboarding";');
  // The slice stops inside the `else {` branch, so close it before compiling.
  const fn = new Function('res', 'releaseGate', 'localStorage', block + '\n}\nreturn null;');
  let outcome = null;
  const returned = fn(
    { httpOk, body },
    () => { outcome = 'released'; },
    { setItem() {}, getItem() { return null; } }
  );
  return returned || outcome;
}

describe('onboarding gateway fails open unless the server actually answered', () => {
  it('401 right after sign-in does NOT send a doctor to onboarding', () => {
    expect(gateDecision({ httpOk: false, body: { ok: false, message: 'Unauthorized' } })).toBe('released');
  });

  it('503 (Supabase not configured) does NOT send a doctor to onboarding', () => {
    expect(gateDecision({ httpOk: false, body: { ok: false, message: 'requires Supabase' } })).toBe('released');
  });

  it('an unparseable body does NOT send a doctor to onboarding', () => {
    expect(gateDecision({ httpOk: true, body: null })).toBe('released');
  });

  it('an empty state row still passes when the profile says onboarding is done', () => {
    expect(gateDecision({ httpOk: true, body: { ok: true, state: {}, onboardingComplete: true } })).toBe('released');
  });

  it('the state flag alone still passes (fast path unchanged)', () => {
    expect(gateDecision({ httpOk: true, body: { ok: true, state: { gp_onboarding_complete: 'true' } } })).toBe('released');
  });

  it('a genuinely new user IS still sent to onboarding', () => {
    expect(gateDecision({ httpOk: true, body: { ok: true, state: {}, onboardingComplete: false } })).toBe('onboarding');
  });
});

describe('/api/state exposes the canonical onboarding marker', () => {
  it('every success branch returns onboardingComplete', () => {
    const get = serverSrc.slice(
      serverSrc.indexOf("if (pathname === '/api/state' && req.method === 'GET')"),
      serverSrc.indexOf("if (pathname === '/api/state' && req.method === 'PUT')"));
    const hits = get.match(/onboardingComplete: await resolveOnboardingCompleteFlag\(/g) || [];
    expect(hits.length).toBe(4);
  });

  it('the canonical marker is user_profiles.onboarding_completed_at', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function resolveOnboardingCompleteFlag'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('select=onboarding_completed_at');
    expect(body).toContain("st.gp_onboarding_complete === true || st.gp_onboarding_complete === 'true'");
  });

  it('only costs a lookup when the state does not already say complete', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function resolveOnboardingCompleteFlag'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // the early return must come before the query
    expect(body.indexOf('return true;')).toBeLessThan(body.indexOf('supabaseDbRequest'));
  });
});

// ── The career matches card ───────────────────────────────────────────────────
// Khaleed's interview was HELD EARLY and marked completed on 1 Aug, four days before
// its booked 5 Aug slot — but gp_applications stayed on 'interview', so the card kept
// showing "Interview confirmed" and a live Join.

describe('career card respects the interview row, not just the application stage', () => {
  it('an interview completed EARLY is done even though its slot is still in the future', () => {
    const s = derive(
      { status: 'completed', scheduledAt: '2026-08-05T01:00:00+00:00', durationMinutes: 30 },
      Date.parse('2026-08-03T00:42:00+00:00'));
    expect(s.phase).toBe('done');
    expect(s.showJoin).toBe(false);
  });

  it('the card routes that to INTERVIEW DONE instead of the booked chip', () => {
    expect(careerSrc).toContain('deriveInterviewCardState(iv).phase');
    expect(careerSrc).toContain('if (ivPhase === "done")');
    expect(careerSrc).toContain('INTERVIEW DONE');
    expect(careerSrc).toContain('if (ivPhase === "no_show")');
  });

  it('the booked chip cannot render a live Join for a finished interview', () => {
    expect(careerSrc).toContain('iv.zoomJoinUrl && ivState.showJoin');
  });

  it('the chip shows the real duration instead of a hardcoded 45', () => {
    expect(careerSrc).not.toContain('Interview confirmed · 45 min on Zoom');
    expect(careerSrc).toContain('Number(iv.durationMinutes)');
  });

  it('the server sends the duration the chip needs', () => {
    expect(serverSrc).toContain('select=application_id,status,scheduled_at,duration_minutes,zoom_join_url,timezone');
    expect(serverSrc).toContain('durationMinutes: row.duration_minutes || null');
  });
});
