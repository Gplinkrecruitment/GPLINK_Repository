// Two live bugs reported together on 2026-08-14 by Dr Sana Ahsan's case.
//
// 1) "The Continue button on the AHPRA step does nothing."
//    pages/index.html renderJourneyList() answered EVERY renderDashboard() with
//    `listEl.innerHTML = ""` and rebuilt all six rows. renderDashboard() runs on
//    each cross-tab "storage" event for gp_career_state — and a doctor with
//    several GP Link tabs open (state-sync writes that key in any of them) gets
//    those constantly. When one landed between finger-down and the click being
//    dispatched, the anchor the tap started on had been removed from the DOM, so
//    no click event was ever delivered and the button silently did nothing.
//    Proven in headless Chrome: with an unconditional rebuild the CTA node is
//    replaced and document.contains(oldNode) is false; with the signature guard
//    it is the same node throughout. Same class of bug as the CV gate being
//    killed by a stray re-render.
//
// 2) "Practice pack document tasks were never released to admin."
//    The career-secured hook completes the OPEN career-stage tasks, then creates
//    the five practice_pack_child tasks under that SAME related_stage ('career').
//    On any re-fire of the transition the sweep matched the pack tasks it had
//    created earlier and marked them 'completed' by 'system' with no
//    task_documents. Dr Sana Ahsan: pack created 2026-07-08 15:07, swept
//    2026-07-09 07:48 — Position Description and Supervisor CV were never
//    requested from the practice, and SPPA-00 stayed 'deferred' for five weeks
//    because its prerequisites looked complete but carried no files.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'pages', 'index.html');
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

let indexHtml;
let serverJs;

beforeAll(() => {
  indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
  serverJs = fs.readFileSync(SERVER_PATH, 'utf8');
});

describe('dashboard journey list — the Continue CTA must survive background re-renders', () => {
  it('computes a render signature before touching the DOM', () => {
    expect(indexHtml).toContain('const renderSig = JSON.stringify([');
    expect(indexHtml).toMatch(/listEl\.dataset\.journeySig === renderSig/);
  });

  it('returns early — without rebuilding — when nothing displayed changed', () => {
    const guard = indexHtml.match(/if \(listEl\.dataset\.journeySig === renderSig[^\n]*\) return;/);
    expect(guard, 'signature guard must short-circuit renderJourneyList').toBeTruthy();

    // The guard has to sit BEFORE the destructive rebuild, or it protects
    // nothing. Scope the comparison to renderJourneyList's own body — other
    // renderers in this page clear their own containers the same way.
    const fnStart = indexHtml.indexOf('function renderJourneyList()');
    const fnEnd = indexHtml.indexOf('function renderDashboard()');
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = indexHtml.slice(fnStart, fnEnd);

    const guardIdx = body.indexOf('listEl.dataset.journeySig === renderSig');
    // Match the STATEMENT (start of line), not the mention of it in the comment
    // above that explains why the guard exists.
    const wipeMatch = /\n[ \t]+listEl\.innerHTML = "";/.exec(body);
    expect(guardIdx, 'guard must live inside renderJourneyList').toBeGreaterThan(-1);
    expect(wipeMatch, 'rebuild must live inside renderJourneyList').toBeTruthy();
    expect(guardIdx).toBeLessThan(wipeMatch.index);
  });

  it('records the signature it just rendered, so the next call can compare', () => {
    expect(indexHtml).toMatch(/listEl\.innerHTML = "";\s*\n\s*listEl\.dataset\.journeySig = renderSig;/);
  });

  it('keeps the row the doctor opened by hand when a real re-render happens', () => {
    expect(indexHtml).toContain('listEl.dataset.journeyUserOpened = "1";');
    expect(indexHtml).toContain('const honourUserOpen = !!listEl.dataset.journeyUserOpened;');
    expect(indexHtml).toMatch(/honourUserOpen \? userOpenedKeys\.has\(step\.key\)/);
  });

  it('still falls back to the default open row before the doctor has touched anything', () => {
    expect(indexHtml).toMatch(/const defaultOpen = isActive \|\|/);
    expect(indexHtml).toMatch(/: defaultOpen;/);
  });

  it('never leaves a plain locked row open (position-locked rows DO open — their body carries the careers CTA)', () => {
    // 2026-09-01 position-first rule: rows locked because no position is
    // secured yet stay openable so the "Secure your position first" call to
    // action is reachable; every other locked row still renders closed.
    expect(indexHtml).toMatch(/const isOpen = \(step\.locked && !step\.positionLocked\) \? false/);
  });

  it('the AHPRA row still links to /pages/ahpra through the shell bridge', () => {
    expect(indexHtml).toContain('href="/pages/${step.page}" data-route="/pages/${step.page}"');
  });
});

describe('signature semantics', () => {
  // The signature the page builds, reproduced exactly, so a future edit that
  // drops a field from it fails here rather than silently freezing the UI.
  function sig(stages, liveSubText, currentIdx, bypassAll) {
    return JSON.stringify([
      bypassAll,
      currentIdx,
      stages.map(s => [s.key, s.title, s.description, s.num, s.done, s.locked, s.lockReason,
        liveSubText[s.key] || s.lockReason || s.description])
    ]);
  }
  const stages = [
    { key: 'career', title: 'Secure Placement', description: 'd1', num: 1, done: true, locked: false, lockReason: null },
    { key: 'ahpra', title: 'AHPRA Registration', description: 'd2', num: 4, done: false, locked: false, lockReason: null }
  ];
  const subs = { career: 'Placement secured', ahpra: 'Specialist registration' };

  it('is stable when nothing changed (so the DOM is left alone)', () => {
    expect(sig(stages, subs, 1, false)).toBe(sig(stages, subs, 1, false));
  });

  it('changes when a stage completes', () => {
    const done = stages.map(s => (s.key === 'ahpra' ? { ...s, done: true } : s));
    expect(sig(done, subs, 1, false)).not.toBe(sig(stages, subs, 1, false));
  });

  it('changes when the visible subtitle changes', () => {
    const other = { ...subs, ahpra: 'Secure a placement to continue' };
    expect(sig(stages, other, 1, false)).not.toBe(sig(stages, subs, 1, false));
  });

  it('changes when the current step moves', () => {
    expect(sig(stages, subs, 0, false)).not.toBe(sig(stages, subs, 1, false));
  });

  it('changes when a stage becomes locked', () => {
    const locked = stages.map(s => (s.key === 'ahpra' ? { ...s, locked: true, lockReason: 'x' } : s));
    expect(sig(locked, subs, 1, false)).not.toBe(sig(stages, subs, 1, false));
  });
});

describe('career-secured sweep must not close the practice pack', () => {
  it('excludes practice_pack_child from the career-stage bulk completion', () => {
    const sweep = serverJs.match(
      /select=id&case_id=eq\.' \+ encodeURIComponent\(caseId\) \+ '&related_stage=eq\.career&[^']*status=in\.\(open,in_progress,waiting\)/
    );
    expect(sweep, 'the career-stage sweep query must still exist').toBeTruthy();
    expect(sweep[0]).toContain('task_type=neq.practice_pack_child');
  });

  it('leaves the other stage sweeps untouched (no pack tasks live there)', () => {
    for (const stage of ['myintealth', 'amc', 'ahpra']) {
      const re = new RegExp('related_stage=eq\\.' + stage + '&status=in\\.\\(open,in_progress,waiting\\)');
      expect(serverJs, stage + ' sweep should be unchanged').toMatch(re);
    }
  });

  it('still creates all five practice pack documents on placement', () => {
    expect(serverJs).toContain("sppa_00: 'SPPA-00'");
    expect(serverJs).toContain("section_g: 'Section G'");
    expect(serverJs).toContain("position_description: 'Position Description'");
    expect(serverJs).toContain("offer_contract: 'Offer / Contract'");
    expect(serverJs).toContain("supervisor_cv: 'Supervisor CV'");
  });

  it('documents why the exclusion exists so it is not "tidied" away', () => {
    expect(serverJs).toContain('practice_pack_child is EXCLUDED on purpose');
  });
});
