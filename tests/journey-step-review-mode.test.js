// Going BACK to a completed journey step (2026-08-17, reported for Ibrahim Fashola)
//
// Two separate defects were reported together from one screenshot of his dashboard:
//
//   1. Doctors click straight through the journey to preview what is coming, then
//      want to go back and actually read the tutorial they skipped — and could not.
//      The home page's completed row held an inert green "Completed" chip (a dead
//      end), and every OTHER way in (nav dropdown, mobile sheet, bookmark) landed on
//      the step page and was immediately BOUNCED on to the next unfinished stage by
//      redirectToAllowedStage(). The one escape hatch, gp_registration_return_
//      overrides, could not help either: the server writes that map keyed
//      "myintealth" (its STAGE_ORDER / PAGE_STAGE_MAP spelling) while every client
//      copy asked for "myinthealth" (the js/journey-stages.js key), so an admin
//      re-opening MyIntealth granted the doctor precisely nothing.
//
//   2. His dashboard claimed "Secure Placement · Placement secured · DONE" and a
//      banner offering "your secured placement details" — while he had ZERO
//      gp_applications rows, registration_cases.practice_name NULL and
//      gp_career_state.applications []. Cause: `careerSecured || overrideIdx > 0`
//      over the stage rail ["placement","myintealth","amc","career",...]. The
//      server's _deriveStageFromState NEVER returns 'placement' (its floor is
//      'myintealth') and returns 'career' precisely while the doctor is STILL
//      LOOKING for a position, so index > 0 was true for every doctor with a case.
//
// These pages/scripts are static files served verbatim, so reading them from disk is
// an honest check of what the browser receives. Where it matters the real function
// bodies are EXTRACTED and EXECUTED rather than grepped — a source grep would have
// passed happily on the misspelled override lookup.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Every surface that answers "may this doctor go back into a finished step?".
const RETURN_ALLOWED_FILES = [
  ['pages', 'index.html'],
  ['js', 'app-shell.js'],
  ['pages', 'myinthealth.html'],
  ['pages', 'amc.html'],
  ['pages', 'ahpra.html'],
  ['pages', 'my-documents.html']
];

// The three step pages that used to bounce a doctor off a completed step.
const STEP_PAGES = [
  { file: ['pages', 'myinthealth.html'], stageKey: 'myinthealth', progressKey: 'gp_epic_progress', doneFlag: 'verification_issued' },
  { file: ['pages', 'amc.html'], stageKey: 'amc', progressKey: 'gp_amc_progress', doneFlag: 'qualifications_verified' },
  { file: ['pages', 'ahpra.html'], stageKey: 'ahpra', progressKey: 'gp_ahpra_progress', doneFlag: 'awaiting_outcome' }
];

// Ibrahim Fashola's real prod user_state value on 2026-08-17 — the server writes
// the MyIntealth stage as "myintealth" (no 'h' after "myint").
const SERVER_WRITTEN_OVERRIDES = {
  placement: true, myintealth: true, amc: true, career: false,
  ahpra: false, visa: false, pbs: false, commencement: false
};
// /api/admin/registration-return-overrides defaults to the CLIENT spelling instead,
// so both live in the same key and both must be honoured.
const ADMIN_WRITTEN_OVERRIDES = {
  career: true, myinthealth: true, amc: true, ahpra: true, pbs: true, commencement: true
};

// ── Extract a top-level `function name(...) { ... }` by balancing braces. ──
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

// Build a callable from extracted sources plus named stub bindings.
function compile(sources, exportName, stubs) {
  const names = Object.keys(stubs);
  const body = sources.join('\n\n') + '\nreturn ' + exportName + ';';
  // eslint-disable-next-line no-new-func
  return new Function(...names, body)(...names.map((n) => stubs[n]));
}

let files = {};

beforeAll(() => {
  for (const parts of RETURN_ALLOWED_FILES) files[parts.join('/')] = read(...parts);
});

describe('an admin re-opening MyIntealth must actually grant it (both spellings)', () => {
  for (const parts of RETURN_ALLOWED_FILES) {
    const key = parts.join('/');

    it(`${key} honours the SERVER spelling "myintealth" for the client key "myinthealth"`, () => {
      const src = files[key];
      const isAllowed = compile(
        [extractFn(src, 'registrationReturnKeysFor'), extractFn(src, 'isRegistrationReturnAllowed')],
        'isRegistrationReturnAllowed',
        {
          getRegistrationReturnOverrides: () => SERVER_WRITTEN_OVERRIDES,
          // Only index.html / app-shell.js reference these; harmless elsewhere.
          BYPASS_LOCK_EMAILS: {},
          getCurrentUserEmail: () => 'defashe31@gmail.com'
        }
      );
      expect(isAllowed('myinthealth')).toBe(true);
      // Not a blanket widening — a stage the map says false for stays false.
      expect(isAllowed('ahpra')).toBe(false);
      expect(isAllowed('pbs')).toBe(false);
    });

    it(`${key} still honours the CLIENT spelling written by the admin endpoint`, () => {
      const src = files[key];
      const isAllowed = compile(
        [extractFn(src, 'registrationReturnKeysFor'), extractFn(src, 'isRegistrationReturnAllowed')],
        'isRegistrationReturnAllowed',
        {
          getRegistrationReturnOverrides: () => ADMIN_WRITTEN_OVERRIDES,
          BYPASS_LOCK_EMAILS: {},
          getCurrentUserEmail: () => 'defashe31@gmail.com'
        }
      );
      expect(isAllowed('myinthealth')).toBe(true);
      expect(isAllowed('amc')).toBe(true);
    });

    it(`${key} refuses when nothing was granted`, () => {
      const src = files[key];
      const isAllowed = compile(
        [extractFn(src, 'registrationReturnKeysFor'), extractFn(src, 'isRegistrationReturnAllowed')],
        'isRegistrationReturnAllowed',
        {
          getRegistrationReturnOverrides: () => ({}),
          BYPASS_LOCK_EMAILS: {},
          getCurrentUserEmail: () => 'defashe31@gmail.com'
        }
      );
      expect(isAllowed('myinthealth')).toBe(false);
      expect(isAllowed('amc')).toBe(false);
    });
  }

  it('the server and the client genuinely disagree on the spelling (the bug is real)', () => {
    const serverJs = read('server.js');
    // The server's own rail — this is what gets written into the shared key.
    expect(serverJs).toMatch(/STAGE_ORDER = \['placement', 'myintealth'/);
    expect(serverJs).toMatch(/'\/pages\/myinthealth\.html': 'myintealth'/);
    // The client journey key.
    expect(read('js', 'journey-stages.js')).toMatch(/key: "myinthealth"/);
  });
});

describe('a completed step opens READ-ONLY instead of bouncing the doctor out', () => {
  for (const step of STEP_PAGES) {
    const key = step.file.join('/');

    function buildResolver(src, overrides, progressBlob, email) {
      return compile(
        [
          extractFn(src, 'registrationReturnKeysFor'),
          extractFn(src, 'isRegistrationReturnAllowed'),
          extractFn(src, 'resolveStepReviewMode')
        ],
        'resolveStepReviewMode',
        {
          getRegistrationReturnOverrides: () => overrides,
          BYPASS_LOCK_EMAILS: { 'bypass@mygplink.com.au': true },
          getPageUserEmail: () => email || 'defashe31@gmail.com',
          parseStorage: () => progressBlob,
          STORAGE_KEY: step.progressKey,
          AMC_KEY: step.progressKey,
          EPIC_KEY: step.progressKey
        }
      );
    }

    const doneBlob = () => ({ stage: 'x', completed: { [step.doneFlag]: true } });
    const liveBlob = () => ({ stage: 'x', completed: { [step.doneFlag]: false } });

    it(`${key}: finished step + no admin re-open ⇒ read-only review`, () => {
      expect(buildResolver(files[key], {}, doneBlob())()).toBe(true);
    });

    it(`${key}: finished step + admin re-open ⇒ FULL edit, not read-only`, () => {
      const overrides = step.stageKey === 'myinthealth' ? SERVER_WRITTEN_OVERRIDES : { [step.stageKey]: true };
      expect(buildResolver(files[key], overrides, doneBlob())()).toBe(false);
    });

    it(`${key}: step still in progress ⇒ editable`, () => {
      expect(buildResolver(files[key], {}, liveBlob())()).toBe(false);
    });

    it(`${key}: no progress blob yet (state-sync has not hydrated) ⇒ editable, never a silent lock`, () => {
      expect(buildResolver(files[key], {}, null)()).toBe(false);
    });

    it(`${key}: bypass emails are never put into review mode`, () => {
      expect(buildResolver(files[key], {}, doneBlob(), 'bypass@mygplink.com.au')()).toBe(false);
    });

    it(`${key}: saveProgress refuses to persist anything while reviewing`, () => {
      const writes = [];
      const saveProgress = compile([extractFn(files[key], 'saveProgress')], 'saveProgress', {
        STEP_REVIEW_ONLY: true,
        queueBatchedSave: (...args) => writes.push(args),
        STORAGE_KEY: step.progressKey
      });
      saveProgress({ stage: 'create_account', completed: {} }, true);
      expect(writes).toHaveLength(0);
    });

    it(`${key}: saveProgress still writes normally when NOT reviewing`, () => {
      const writes = [];
      const saveProgress = compile([extractFn(files[key], 'saveProgress')], 'saveProgress', {
        STEP_REVIEW_ONLY: false,
        queueBatchedSave: (...args) => writes.push(args),
        STORAGE_KEY: step.progressKey
      });
      saveProgress({ stage: 'create_account', completed: {} }, true);
      expect(writes).toHaveLength(1);
    });

    it(`${key}: every progress mutator is guarded, not just the write`, () => {
      const src = files[key];
      for (const fn of ['markStageComplete', 'undoToStage', 'rewindToPreviousStep', 'resetProgressToStage']) {
        expect(extractFn(src, fn), `${fn} must refuse in review mode`).toMatch(/blockedByStepReview\(\)/);
      }
      // ...and it tells the doctor why rather than dying silently.
      expect(extractFn(src, 'blockedByStepReview')).toMatch(/showToast\(/);
    });

    it(`${key}: shows the read-only banner and a way back, and hides the advance/revert buttons`, () => {
      const src = files[key];
      expect(src).toMatch(/id="stepReviewBanner"/);
      expect(src).toMatch(/data-route="\/pages\/index"/);
      expect(src).toMatch(/read-only view/);
      // display:none must be !important — an author `display:` rule on these buttons
      // would otherwise win and leave a live "mark complete" on a read-only page.
      expect(src).toMatch(/html\[data-step-review="1"\] #actionMarkBtn[\s\S]{0,220}display: none !important/);
      expect(src).toMatch(/html\[data-step-review="1"\] \.step-review-banner \{ display: flex; \}/);
      // The mode is stamped on <html> so the CSS above can ever apply.
      expect(extractFn(src, 'applyStepReviewMode')).toMatch(/setAttribute\("data-step-review"/);
    });

    it(`${key}: redirectToAllowedStage no longer throws a finished doctor off the page`, () => {
      const body = extractFn(files[key], 'redirectToAllowedStage');
      expect(body).toMatch(/applyStepReviewMode\(\)/);
      expect(body).not.toMatch(/shellNavigate\("\/pages\/index"\)/);
    });
  }

  it('amc.html keeps its FORWARD gate — AMC is genuinely shut until MyIntealth is done', () => {
    const body = extractFn(read('pages', 'amc.html'), 'redirectToAllowedStage');
    expect(body).toMatch(/shellNavigate\("\/pages\/myinthealth"\)/);
  });
});

describe('"Placement secured" is never inferred from the stage rail alone', () => {
  // Ibrahim's real state: MyIntealth finished, no AMC blob, case stage 'amc',
  // and an EMPTY career blob (no application, no practice).
  const IBRAHIM = {
    gp_epic_progress: { stage: 'verification_issued', completed: { verification_issued: true }, updatedAt: '2026-08-06T15:57:27.022Z' },
    gp_amc_progress: null,
    gp_ahpra_progress: { stage: 'create_account', completed: {} },
    gp_career_state: { applications: [] },
    gp_admin_stage_override: 'amc'
  };
  const SECURED_CAREER = { applications: [{ isPlacementSecured: true }] };

  function indexSnapshot(state) {
    const src = read('pages', 'index.html');
    return compile(
      [
        extractFn(src, 'hasCareerSecured'),
        extractFn(src, 'getProgressSnapshot')
      ],
      'getProgressSnapshot',
      {
        parseStorage: (k) => (Object.prototype.hasOwnProperty.call(state, k) ? state[k] : null),
        EPIC_KEY: 'gp_epic_progress',
        AMC_KEY: 'gp_amc_progress',
        AHPRA_KEY: 'gp_ahpra_progress',
        DOC_KEY: 'gp_documents_prep',
        PREPARED_DOCS_KEY: 'gp_prepared_docs',
        CAREER_STATE_KEY: 'gp_career_state',
        epicStageLabels: { create_account: 'Create your account' },
        amcStageLabels: { create_portfolio: 'Create an AMC account' },
        getStorageTimestamp: () => Date.parse('2026-08-14T14:39:13.125Z'),
        wasProgressUpdatedAfter: () => false,
        UK_DOC_KEYS: [], UK_INST_KEYS: [], UK_SUPERVISED_KEYS: [],
        TOTAL_STEPS: 6,
        window: {}
      }
    );
  }

  function shellSnapshot(state) {
    const src = read('js', 'app-shell.js');
    return compile(
      [extractFn(src, 'hasCareerSecured'), extractFn(src, 'getProgressSnapshot')],
      'getProgressSnapshot',
      {
        parseStorage: (k) => (Object.prototype.hasOwnProperty.call(state, k) ? state[k] : null),
        EPIC_PROGRESS_KEY: 'gp_epic_progress',
        AMC_PROGRESS_KEY: 'gp_amc_progress',
        AHPRA_PROGRESS_KEY: 'gp_ahpra_progress',
        CAREER_STATE_KEY: 'gp_career_state',
        EPIC_STAGE_LABELS: { create_account: 'Create your account' },
        AMC_STAGE_LABELS: { create_portfolio: 'Create an AMC account' },
        getStorageTimestamp: () => Date.parse('2026-08-14T14:39:13.125Z'),
        wasProgressUpdatedAfter: () => false
      }
    );
  }

  for (const [label, snapshotFor] of [['pages/index.html', indexSnapshot], ['js/app-shell.js', shellSnapshot]]) {
    it(`${label}: a doctor at case stage 'amc' with NO application is NOT placed`, () => {
      expect(snapshotFor(IBRAHIM)().careerSecured).toBe(false);
    });

    it(`${label}: a doctor sitting ON the 'career' stage is NOT placed`, () => {
      const state = { ...IBRAHIM, gp_admin_stage_override: 'career' };
      expect(snapshotFor(state)().careerSecured).toBe(false);
    });

    it(`${label}: a stage PAST 'career' does still imply a placement`, () => {
      // _deriveStageFromState only gets to 'ahpra' once the career gate passed, so
      // this inference stays — it is the reason the override is consulted at all.
      const state = { ...IBRAHIM, gp_admin_stage_override: 'ahpra' };
      expect(snapshotFor(state)().careerSecured).toBe(true);
    });

    it(`${label}: a real secured application is placed regardless of the rail`, () => {
      const state = { ...IBRAHIM, gp_career_state: SECURED_CAREER };
      expect(snapshotFor(state)().careerSecured).toBe(true);
    });

    it(`${label}: the "off index 0 means placed" inference is gone from the source`, () => {
      const src = label === 'js/app-shell.js' ? read('js', 'app-shell.js') : read('pages', 'index.html');
      const body = extractFn(src, 'getProgressSnapshot');
      // Match the assignment, not the comment that explains why it was wrong.
      expect(body).not.toMatch(/careerSecured\s*=\s*careerSecured\s*\|\|\s*overrideIdx > 0/);
      expect(body).toMatch(/careerSecured\s*=\s*careerSecured\s*\|\|\s*overrideIdx > OVERRIDE_ORDER\.indexOf\("career"\)/);
    });
  }

  it('the dashboard only promises secured-placement details when careerSecured', () => {
    const indexHtml = read('pages', 'index.html');
    expect(extractFn(indexHtml, 'updateHeroStats')).toMatch(/snap\.careerSecured[\s\S]*View your secured placement details/);
    // The journey row's subtitle is driven off the same flag.
    expect(indexHtml).toMatch(/career: snap\.careerSecured \? "Placement secured"/);
  });

  it('no surface offers to SHOW a placement the doctor does not have', () => {
    // Every "your secured placement" line must sit behind the careerSecured flag —
    // three of them were unconditional, so an unplaced doctor was invited to view a
    // placement that did not exist.
    for (const [label, src] of [['pages/index.html', read('pages', 'index.html')], ['js/app-shell.js', read('js', 'app-shell.js')]]) {
      const rows = label === 'js/app-shell.js'
        ? extractFn(src, 'getRegistrationRows')
        : extractFn(src, 'getRegistrationRows');
      expect(rows, `${label} career sub must branch on careerSecured`)
        .toMatch(/sub: snap\.careerSecured \? "View your secured practice placement\." : /);
      expect(rows, `${label} must not hand an unplaced doctor "View placement"`)
        .not.toMatch(/: "View placement"/);
    }
    // The hero's next-action line for an unplaced doctor points at finding one.
    const snapshot = extractFn(read('pages', 'index.html'), 'getProgressSnapshot');
    expect(snapshot).toMatch(/!careerSecured[\s\S]{0,160}Browse open positions and secure your placement/);
  });
});

describe('the Current highlight tracks the hero\'s next action', () => {
  it('an unplaced doctor working on AMC sees AMC flagged Current, not Secure Placement', () => {
    // Regression guard for the knock-on of the careerSecured fix: with step 1 no
    // longer falsely "done", the old first-open-step fallback would have flagged
    // (and auto-opened) "Secure Placement" while the hero said "AMC Portfolio".
    const body = extractFn(read('pages', 'index.html'), 'renderJourneyList');
    expect(body).toMatch(/currentIdx = stages\.findIndex\(s => s\.key === snap\.currentRoute && !s\.done && !s\.locked\)/);
    // The old fallbacks are kept behind it, so nothing can end up with no Current row.
    expect(body).toMatch(/currentIdx === -1\) currentIdx = stages\.findIndex\(s => !s\.done && !s\.locked\)/);
    expect(body).toMatch(/currentIdx === -1\) currentIdx = stages\.length - 1/);
  });
});

describe('the journey list gives a completed step a way back in', () => {
  it('a done step renders a real link, not an inert "Completed" chip', () => {
    const body = extractFn(read('pages', 'index.html'), 'renderJourneyList');
    expect(body).toMatch(/if \(step\.done\) \{[\s\S]{0,1400}?<a class="journey-body-cta done-cta"/);
    expect(body).toMatch(/Quick view/);
    expect(body).toMatch(/data-route="\/pages\/\$\{step\.page\}"/);
    // The dead end is gone.
    expect(body).not.toMatch(/<span class="journey-body-cta done-cta"/);
  });

  it('the done CTA is styled as something you can click', () => {
    const indexHtml = read('pages', 'index.html');
    const rule = indexHtml.slice(indexHtml.indexOf('.journey-body-cta.done-cta {'));
    expect(rule.slice(0, 320)).not.toMatch(/cursor: default/);
    expect(rule.slice(0, 320)).toMatch(/cursor: pointer/);
  });

  it('the header pill still reports Done, so dropping the chip loses no status', () => {
    const body = extractFn(read('pages', 'index.html'), 'renderJourneyList');
    expect(body).toMatch(/step\.done \? "Done"/);
  });
});
