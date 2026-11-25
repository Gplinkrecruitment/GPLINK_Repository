// WP-12 overseas parity. A doctor who is not on an Australian pathway (nothing
// recorded, with the switch on; and everyone with the switch off) must see,
// in the files WP-12 changed, exactly what they saw before it.
//
// "Before" is a capture taken from origin/au-gp-testing at 1003edb2, the
// commit WP-12 started from (tests/fixtures/au-wp12-overseas-parity.snapshot.json,
// written by tests/helpers/au-wp12-parity.js --write-baseline). "After" is the
// working tree, captured the same way here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import vm from 'vm';

const requireCjs = createRequire(import.meta.url);
const parity = requireCjs('./helpers/au-wp12-parity.js');
const before = JSON.parse(fs.readFileSync(parity.FIXTURE, 'utf8'));
const after = parity.capture(parity.readTree);

describe('WP-12 overseas parity: the pure builders, with no Australian helper on the page', () => {
  it('the snapshot was taken from the commit WP-12 started from', () => {
    expect(before.commit).toBe(parity.BASELINE_COMMIT);
    expect(Object.keys(before.strings).sort()).toEqual(parity.SHARED_FILES.slice().sort());
  });

  it('the stage list, every stage state, both slide decks and the careers strip are identical', () => {
    expect(after.behaviour.stageList).toEqual(before.behaviour.stageList);
    expect(after.behaviour.allStages).toEqual(before.behaviour.allStages);
    expect(after.behaviour.stageStates).toEqual(before.behaviour.stageStates);
    expect(after.behaviour.findStage).toEqual(before.behaviour.findStage);
    expect(after.behaviour.welcomeSlides).toEqual(before.behaviour.welcomeSlides);
    expect(after.behaviour.registrationSlides).toEqual(before.behaviour.registrationSlides);
    expect(after.behaviour.careerStrip).toEqual(before.behaviour.careerStrip);
    expect(after.behaviour.stripSteps).toEqual(before.behaviour.stripSteps);
  });

  it('the capture really exercises the journey (it is not comparing two empty things)', () => {
    expect(before.behaviour.stageList.map((s) => s.key)).toEqual(['career', 'myinthealth', 'amc', 'ahpra', 'visa', 'pbs']);
    expect(before.behaviour.stageStates.length).toBeGreaterThan(8);
    expect(before.behaviour.welcomeSlides[0]).toHaveLength(6);
    expect(before.behaviour.registrationSlides[0][3].cta).toBe('Start my registration');
    expect(before.behaviour.careerStrip[0].steps.map((s) => s.label)).toEqual(['Job Search', 'Interview', 'Offer & contract', 'Registration']);
  });

  it('the entry route for anyone who is not an Australian doctor is the one it always was', () => {
    const win = {};
    vm.runInNewContext(parity.readTree('js/journey-stages.js'), { window: win });
    expect(win.GPJourneyStages.entryRoute()).toBe('/pages/myinthealth');
    expect(win.GPJourneyStages.isAuDoctor()).toBe(false);
    expect(win.GPJourneyStages.stagesForDoctor()).toEqual(win.GPJourneyStages.STAGES);
    // A helper that is present but does not recognise the doctor changes nothing either.
    const win2 = { GPAuDoctor: { cached: () => null, stageStates: () => { throw new Error('must not be asked'); } } };
    vm.runInNewContext(parity.readTree('js/journey-stages.js'), { window: win2 });
    expect(JSON.parse(JSON.stringify(win2.GPJourneyStages.getStageStates({ careerSecured: true }, false))))
      .toEqual(before.behaviour.stageStates.find((x) => x.snap.careerSecured && Object.keys(x.snap).length === 1).normal);
  });
});

// Strings WP-12 deliberately changed in a shared file. Every one of them is
// only ever shown to a doctor on an Australian pathway (it sits between the
// AU markers of its file), or is not text at all.
const DELIBERATELY_CHANGED = {
  // The holding card (AU-HOLD in pages/career.html; walk-findings D17): new
  // heading, and it is styled by a class now instead of inline styles.
  'pages/career.html': [
    'We are confirming your details',
    'background:var(--gp-surface,#fff);border:1px solid var(--gp-border,rgba(15,23,42,0.12));border-radius:16px;padding:22px 20px;margin:16px 0;text-align:center;box-shadow:0 1px 2px rgba(15,23,42,0.04);',
    'font-size:17px;font-weight:700;margin-bottom:8px;color:var(--gp-ink,#0f172a);',
    'font-size:14.5px;line-height:1.5;color:var(--gp-ink-soft,#475569);'
  ],
  // WP-29 (deliberate): the helper under "Does the 19AB moratorium apply to
  // you?" was rewritten to say who it usually applies to (the doctor's own
  // answer now decides what they are shown, so it has to be answerable). It
  // sits on the Australian branch of onboarding (#auMoratoriumHelp): an
  // overseas doctor never sees that screen. The old sentence:
  'pages/onboarding.html': [
    'Section 19AB of the Health Insurance Act can limit where some doctors may work under Medicare for a period of time. If you are not sure whether it applies to you, choose Not sure and our team will check with you.',
    // WP-29 (deliberate): the first Australian screen no longer shows a fixed
    // list of places ("Preferred locations", "Regional areas"): it asks "Where
    // are you based?" and "How far would you go?" (js/au-location-picker.js),
    // and the second screen no longer asks state / suburb / postcode (they
    // come from the place chosen). Every one of these strings was inside the
    // AU-BRANCH markers: an overseas doctor never saw them.
    'A postcode is four digits.',
    'Choose as many as you like.',
    'Choose at least one place you would like to work.',
    'Choose the state or territory you live in.',
    'Postcode',
    'Postcode (optional)',
    'Preferred locations',
    'Regional areas',
    'State or territory',
    'Suburb (optional)',
    'Where you live now'
  ]
};

describe('WP-12 overseas parity: nothing an overseas doctor could read was removed or reworded', () => {
  parity.SHARED_FILES.forEach((file) => {
    it(file + ': every string that was there before is still there', () => {
      const now = new Set(after.strings[file]);
      const allowed = new Set(DELIBERATELY_CHANGED[file] || []);
      const missing = before.strings[file].filter((s) => !now.has(s) && !allowed.has(s));
      expect(missing).toEqual([]);
      expect(before.strings[file].length).toBeGreaterThan(3);
    });
  });

  it('the strings the walk found (D1 to D7) are still exactly what an overseas doctor reads', () => {
    const has = (file, text) => expect(parity.readTree(file), file + ': ' + text).toContain(text);
    has('js/gp-intro-slides.js', "icon: 'unlock', kicker: 'Step 4 of 4', title: 'Your registration unlocks'");
    has('js/gp-intro-slides.js', "cta: 'Start my registration'");
    has('js/gp-walkthrough.js', 'MyIntealth, AMC, AHPRA, visa and Medicare, each unlocking in order');
    has('js/career-step-strip.js', "{ num: 4, label: 'Registration' }");
    has('pages/career.html', '<span class="at-consult-note">Talk to our team about your move &mdash; any time.</span>');
    has('pages/account.html', '<h3 class="section-title">Relocation Details</h3>');
    has('pages/account.html', '<p class="input-note">Choose the city where you would prefer to relocate.</p>');
    has('pages/messages.html', '<option value="EPIC">EPIC / MyIntealth</option>');
    has('pages/messages.html', '<option value="AMC">AMC Portfolio</option>');
    has('pages/messages.html', 'title: "Why More UK GPs Are Moving to Australia"');
    has('pages/offer-review.html', '<a id="contractSecuredCta" href="/pages/myinthealth"');
    has('pages/job.html', 'v: role.dpa ? "Yes — open to overseas-trained GPs" : "No"');
    has('js/app-shell.js', 'var REGISTRATION_ENTRY_ROUTE = "/pages/myinthealth";');
  });
});
