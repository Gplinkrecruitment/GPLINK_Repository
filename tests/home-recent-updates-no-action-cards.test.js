// Owner rule (2026-07-15): the dashboard "Recent Updates" feed must NEVER show an
// action card. Anything that needs the GP to do something belongs in the bell panel
// (js/updates-sync.js, "Actions" filter) and on the stage card it relates to, the
// feed is a read-only news list of things that already happened.
//
// pages/index.html is a static file served verbatim, so its inline renderUpdatesFeed()
// is the exact code the browser runs. This test extracts that function from disk and
// executes it against a DOM stub, so it proves rendered output, not just source text.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'pages', 'index.html');

function extractFunctionSource(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`could not find ${signature} in pages/index.html`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${signature}`);
}

// Minimal stand-in for the handful of DOM APIs renderUpdatesFeed touches.
function makeDomStub() {
  const rows = [];
  const makeEl = () => ({
    innerHTML: '',
    className: '',
    href: '',
    textContent: '',
    querySelector: () => makeEl(),
    appendChild() {}
  });
  const listEl = {
    innerHTML: '',
    appendChild(row) { rows.push(row); }
  };
  return {
    rows,
    document: {
      getElementById: (id) => (id === 'gp-updates-list' ? listEl : makeEl()),
      createElement: () => makeEl()
    }
  };
}

function renderFeedWith({ updates = [], supportCases = [] }) {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const fnSource = extractFunctionSource(html, 'function renderUpdatesFeed()');
  const dom = makeDomStub();

  const factory = new Function(
    'document', 'window', 'parseStorage', 'getPreparedDocReviewUpdates',
    'formatUpdateTimestamp', 'updateActionCount', 'liveAppCards', 'liveAppsLoaded', 'escFeed',
    `${fnSource}\nreturn renderUpdatesFeed;`
  );

  factory(
    dom.document,
    {},                                                     // window (refreshInboxBadges absent)
    (key) => (key === 'gpLinkMessageDB' ? { updates, supportCases } : null),
    () => [],                                               // getPreparedDocReviewUpdates
    () => 'just now',                                       // formatUpdateTimestamp
    () => {},                                               // updateActionCount (no-op in the page too)
    [],                                                     // liveAppCards
    true,                                                   // liveAppsLoaded
    // Same escaper the real page defines top-level (2026-07-20 audit fix),
    // renderUpdatesFeed() now depends on it for every server-sourced string.
    (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  )();

  return dom.rows.map((row) => row.innerHTML).join('\n');
}

const ACTION_UPDATE = {
  type: 'action',
  title: 'Specialist Qualification needs attention',
  detail: 'Please re-upload a clear scan of your MRCGP certificate.',
  ts: '2026-07-13T00:00:00.000Z'
};
const SUCCESS_UPDATE = {
  type: 'success',
  title: 'Practice secured',
  detail: '',
  ts: '2026-07-11T00:00:00.000Z'
};

describe('dashboard Recent Updates never renders an action card', () => {
  let indexHtml;
  beforeAll(() => { indexHtml = fs.readFileSync(INDEX_PATH, 'utf8'); });

  it('drops action updates entirely, even when they are the only updates', () => {
    const rendered = renderFeedWith({ updates: [ACTION_UPDATE] });
    expect(rendered).not.toContain('Specialist Qualification needs attention');
    expect(rendered).not.toContain('update-badge action');
    expect(rendered).toBe(''); // nothing left to show, the empty-state copy takes over
  });

  it('still renders non-action updates alongside a suppressed action update', () => {
    const rendered = renderFeedWith({ updates: [ACTION_UPDATE, SUCCESS_UPDATE] });
    expect(rendered).toContain('Practice secured');
    expect(rendered).toContain('update-badge success');
    expect(rendered).not.toContain('Specialist Qualification needs attention');
    expect(rendered).not.toContain('update-badge action');
  });

  it('no longer lets an action update hide the regular feed, and keeps open support cases', () => {
    const rendered = renderFeedWith({
      updates: [ACTION_UPDATE, SUCCESS_UPDATE],
      supportCases: [{ id: 'c1', status: 'open', title: 'Question about my visa', thread: [], updatedAt: '2026-07-14T00:00:00.000Z' }]
    });
    expect(rendered).toContain('Question about my visa');
    expect(rendered).toContain('Practice secured');
    expect(rendered).not.toContain('update-badge action');
  });

  it('keeps the render-time guard so no future code path can leak an action card in', () => {
    expect(indexHtml).toContain('if (isActionUpdate(item)) return;');
  });

  it('empty-state copy no longer promises action items in this feed', () => {
    expect(indexHtml).toContain("No updates yet. We'll post here when something changes.");
    expect(indexHtml).not.toContain("or if we need anything from you");
  });
});
