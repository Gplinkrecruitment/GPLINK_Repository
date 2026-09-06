import { describe, it, expect } from 'vitest';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const derive = require(path.join(__dirname, '..', 'js', 'interview-card-state.js'));
const pageSrc = readFileSync(path.join(__dirname, '..', 'pages', 'application-detail.html'), 'utf8');

const START = Date.parse('2026-08-01T04:00:00.000Z'); // 45-minute interview -> ends 04:45
const MIN = 60000;
const booked = (over) => Object.assign({ status: 'scheduled', scheduled_at: '2026-08-01T04:00:00.000Z', duration_minutes: 45 }, over || {});

describe('deriveInterviewCardState — before the interview', () => {
  it('offers the picker when no time is booked', () => {
    const s = derive({ status: 'invited' }, START);
    expect(s.phase).toBe('scheduling');
    expect(s.isBooked).toBe(false);
    expect(s.showJoin).toBe(false);
    expect(s.title).toBe('Schedule your interview');
  });

  it('shows Upcoming Interview with Join and Calendar before it starts', () => {
    const s = derive(booked(), START - 2 * 60 * MIN);
    expect(s.phase).toBe('upcoming');
    expect(s.title).toBe('Upcoming Interview');
    expect(s.showJoin).toBe(true);
    expect(s.showCalendar).toBe(true);
    expect(s.message).toBe('');
  });
});

describe('deriveInterviewCardState — during the interview', () => {
  it('keeps Join alive while it is running', () => {
    const s = derive(booked(), START + 10 * MIN);
    expect(s.phase).toBe('live');
    expect(s.title).toBe('Interview in progress');
    expect(s.showJoin).toBe(true);
  });

  it('keeps Join alive through the overrun grace so a dropout can rejoin', () => {
    // ends 04:45, grace to 05:15
    expect(derive(booked(), START + 50 * MIN).showJoin).toBe(true);
    expect(derive(booked(), START + 74 * MIN).showJoin).toBe(true);
  });

  it('drops the Add-to-Calendar button once it has started', () => {
    expect(derive(booked(), START + 10 * MIN).showCalendar).toBe(false);
  });
});

describe('deriveInterviewCardState — after the interview', () => {
  it('the reported bug: hours later there is no Join button and the title is not "Upcoming"', () => {
    const s = derive(booked(), START + 2 * 60 * MIN);
    expect(s.showJoin).toBe(false);
    expect(s.showCalendar).toBe(false);
    expect(s.phase).toBe('done');
    expect(s.title).toBe('Interview complete');
    expect(s.title).not.toContain('Upcoming');
    expect(s.message).toContain('practice is considering');
  });

  it('still correct a week later, before the no-show sweep has touched the row', () => {
    const s = derive(booked(), START + 7 * 24 * 60 * MIN);
    expect(s.showJoin).toBe(false);
    expect(s.phase).toBe('done');
  });

  it('trusts an explicit completed status even inside the meeting window', () => {
    const s = derive(booked({ status: 'completed' }), START + 5 * MIN);
    expect(s.phase).toBe('done');
    expect(s.showJoin).toBe(false);
  });

  it('says it was missed for a no_show, and never offers Join', () => {
    const s = derive(booked({ status: 'no_show' }), START + 2 * 60 * MIN);
    expect(s.phase).toBe('no_show');
    expect(s.title).toBe('Interview missed');
    expect(s.showJoin).toBe(false);
    expect(s.message).toContain('contact GP Link');
  });

  it('handles a cancelled interview without offering Join', () => {
    const s = derive(booked({ status: 'cancelled' }), START - 60 * MIN);
    expect(s.phase).toBe('cancelled');
    expect(s.showJoin).toBe(false);
  });
});

describe('deriveInterviewCardState — input tolerance', () => {
  it('assumes 30 minutes when the row carries no duration', () => {
    // 30, not 45: scheduled_calls.duration_minutes is NOT NULL DEFAULT 30 and
    // every interview row in production says 30. The old 45 here matched the
    // hardcoded 45 in server.js, and both were wrong (owner report 2026-09-06).
    const noDur = { status: 'scheduled', scheduled_at: '2026-08-01T04:00:00.000Z' };
    expect(derive(noDur, START + 50 * MIN).showJoin).toBe(true);   // inside 30+30
    expect(derive(noDur, START + 70 * MIN).showJoin).toBe(false);  // past it
  });

  it('accepts the camelCase shape /api/career/applications emits', () => {
    const s = derive({ status: 'booked', scheduledAt: '2026-08-01T04:00:00.000Z', durationMinutes: 45 }, START + 2 * 60 * MIN);
    expect(s.phase).toBe('done');
    expect(s.showJoin).toBe(false);
  });

  it('falls back to the picker on junk input rather than throwing', () => {
    expect(derive(null, START).phase).toBe('scheduling');
    expect(derive({}, START).phase).toBe('scheduling');
    expect(derive({ scheduled_at: 'not-a-date' }, START).phase).toBe('scheduling');
  });

  it('is pure — the same inputs always give the same answer', () => {
    expect(derive(booked(), START + MIN)).toEqual(derive(booked(), START + MIN));
  });
});

describe('application-detail wiring', () => {
  it('loads the helper without defer so the cached-preview render cannot race it', () => {
    expect(pageSrc).toMatch(/<script src="\.\.\/js\/interview-card-state\.js\?v=[^"]+"><\/script>/);
  });

  it('titles the card from the derived state instead of a hardcoded "Upcoming Interview"', () => {
    expect(pageSrc).toContain('ivTitleEl.textContent = ivState.title;');
    expect(pageSrc).not.toContain('ivTitleEl.textContent = "Upcoming Interview";');
  });

  it('gates the Join button on the derived window as well as the format', () => {
    expect(pageSrc).toContain('!ivState.showJoin || !!(interviewObj.format && interviewObj.format !== "video")');
  });

  it('gates Add-to-Calendar on the same window', () => {
    expect(pageSrc).toContain('interviewObj.scheduled_at && ivState.showCalendar');
  });

  it('renders the status note element the derived message goes into', () => {
    expect(pageSrc).toContain('id="interviewStatusNote"');
    expect(pageSrc).toContain('ivNoteEl.textContent = ivState.message');
  });
});

// ── Run the REAL page function, not just grep for it ──────────────────────────
// Memory rule for this repo: there is no jsdom, so inline page JS is tested by
// extracting the function body and running it against a stub document.
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found: ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

function runRenderBookedInterview(interviewObj, ivState) {
  const els = {
    interviewMeta: { innerHTML: '' },
    joinInterviewBtn: { hidden: false },
    interviewStatusNote: { textContent: '', hidden: false },
  };
  const document = { getElementById: (id) => els[id] || null };
  const esc = (v) => String(v == null ? '' : v);
  const fn = new Function('document', 'esc', 'latestInterviewState',
    extractFunction(pageSrc, 'renderBookedInterview') + '; return renderBookedInterview;'
  )(document, esc, null);
  fn(interviewObj, {}, ivState);
  return els;
}

describe('application-detail renderBookedInterview (real function, stub DOM)', () => {
  const iv = { scheduled_at: '2026-08-01T04:00:00.000Z', duration_minutes: 45, format: 'video' };

  it('shows Join while the interview is still joinable', () => {
    const els = runRenderBookedInterview(iv, derive(iv, START - 30 * MIN));
    expect(els.joinInterviewBtn.hidden).toBe(false);
    expect(els.interviewStatusNote.hidden).toBe(true);
  });

  it('HIDES Join once the interview is over, and explains what happens next', () => {
    const els = runRenderBookedInterview(iv, derive(iv, START + 3 * 60 * MIN));
    expect(els.joinInterviewBtn.hidden).toBe(true);
    expect(els.interviewStatusNote.hidden).toBe(false);
    expect(els.interviewStatusNote.textContent).toContain('practice is considering');
  });

  it('still hides Join for a non-video interview even while it is joinable', () => {
    const phone = Object.assign({}, iv, { format: 'phone' });
    const els = runRenderBookedInterview(phone, derive(phone, START - 30 * MIN));
    expect(els.joinInterviewBtn.hidden).toBe(true);
  });

  it('renders the meeting details either way', () => {
    const els = runRenderBookedInterview(iv, derive(iv, START + 3 * 60 * MIN));
    expect(els.interviewMeta.innerHTML).toContain('Duration');
  });
});

// ── The buttons must ACTUALLY disappear ───────────────────────────────────────
// `el.hidden = true` was already being set correctly, but `.btn-join-interview` and
// `.btn-add-calendar` set `display: flex`, and an author `display` beats the browser's
// `[hidden] { display: none }`. So the doctor kept seeing "Join Video Call" under an
// "Interview complete" heading. This also silently broke the pre-existing
// `format !== "video"` gate.
describe('hiding actually hides on application-detail', () => {
  it('neutralises the display rules that overrode [hidden]', () => {
    expect(pageSrc).toContain('[hidden] { display: none !important; }');
  });

  it('the override is declared BEFORE the display:flex buttons that need it', () => {
    const rule = pageSrc.indexOf('[hidden] { display: none !important; }');
    const joinCss = pageSrc.indexOf('.btn-join-interview {');
    const calCss = pageSrc.indexOf('.btn-add-calendar {');
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(joinCss);
    expect(rule).toBeLessThan(calCss);
  });

  it('nothing toggled via style.display also carries the hidden attribute', () => {
    // A page-wide !important hide is only dangerous if something is SHOWN via
    // style.display while still carrying [hidden]. #offerCard is the page's only
    // style.display user and it has no hidden attribute (it uses an inline
    // style="display:none"), so the rule cannot reach it.
    const users = (pageSrc.match(/(\w+)\.style\.display\s*=/g) || []).map((m) => m.split('.')[0]);
    expect(users).toEqual(['offerCard']);
    expect(pageSrc).toMatch(/id="offerCard" style="display:none;"/);
    expect(pageSrc).not.toMatch(/id="offerCard"[^>]*\shidden/);
  });
});

// ── "Next step" must not tell an interviewed doctor to book an interview ──────
describe('next step respects a finished interview', () => {
  const careerSrc2 = readFileSync(path.join(__dirname, '..', 'pages', 'career.html'), 'utf8');

  it('application-detail overrides the cached "Next step" from the live interview', () => {
    expect(pageSrc).toContain('String(m.label || "").toLowerCase() !== "next step"');
    expect(pageSrc).toContain("Awaiting the practice's decision");
    expect(pageSrc).toContain('Contact GP Link to rebook');
  });

  it('career.html checks the interview BEFORE falling back to the stage', () => {
    const fn = careerSrc2.slice(careerSrc2.indexOf('function nextStepForApplication'));
    const body = fn.slice(0, fn.indexOf('\n    }\n'));
    const ivAt = body.indexOf('deriveInterviewCardState(interview).phase');
    const stageAt = body.indexOf('return "Confirm your interview time"');
    expect(ivAt).toBeGreaterThan(-1);
    expect(ivAt).toBeLessThan(stageAt);
  });

  it('the meta builder passes the interview through', () => {
    expect(careerSrc2).toContain('nextStepForApplication(app.status, app.interview)');
  });
});
