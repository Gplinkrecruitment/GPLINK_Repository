import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { describe, it, expect } from 'vitest';

/*
 * WP-25: privacy policy, terms and consent wording were DRAFTED for legal review
 * and deliberately NOT published.
 *
 * Pinned here:
 *   1. The drafts exist and every one carries the DRAFT banner.
 *   2. The live privacy and terms pages are byte-identical to what they were
 *      before this package, and carry none of the draft-only markers.
 *   3. Nothing the website serves or runs (pages/, js/, lib/, server.js) refers
 *      to the drafts, so none of the wording can reach a doctor or a practice.
 *   4. The draft pages keep the live pages' structure, so they can be dropped in
 *      after review, and the Australian consent lines avoid the banned words.
 *
 * PUBLISHING LATER (docs/au-gp/privacy-terms-legal-review.md, section 7): when the
 * reviewed text replaces pages/privacy.html and pages/terms.html, update the two
 * hashes below in the same commit. That is the only reason to change them.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

const BANNER = 'DRAFT - FOR LEGAL REVIEW - NOT PUBLISHED';
const DRAFT_DIR = 'docs/au-gp/legal-draft';
const DRAFTS = [
  DRAFT_DIR + '/privacy-policy-draft.html',
  DRAFT_DIR + '/terms-draft.html',
  DRAFT_DIR + '/consent-wording.md',
  DRAFT_DIR + '/data-access-rule.md',
  'docs/au-gp/privacy-terms-legal-review.md'
];
// Text that exists only in the drafts.
const DRAFT_ONLY_MARKERS = [BANNER, '[LEGAL REVIEW', '[OWNER TO CONFIRM', 'data-wp25-draft', 'legal-draft'];
// File names of this package's drafts (the folder also holds WP-28's agreement draft).
// "[LEGAL REVIEW n]" and "[OWNER TO CONFIRM ...]" are how the documents talk ABOUT markers.
const isGenericMention = (marker) => /^\[(LEGAL REVIEW|OWNER TO CONFIRM) (n|…|\.\.\.)\]$/.test(marker);
const WP25_FILE_NAMES = ['privacy-policy-draft', 'terms-draft', 'consent-wording', 'data-access-rule', 'privacy-terms-legal-review'];

function listFiles(dirRel, exts) {
  const out = [];
  const walk = (rel) => {
    fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).forEach((entry) => {
      const child = rel + '/' + entry.name;
      if (entry.isDirectory()) walk(child);
      else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(child);
    });
  };
  walk(dirRel);
  return out;
}

describe('WP-25 drafts exist and are marked', () => {
  DRAFTS.forEach((rel) => {
    it(rel + ' exists and carries the DRAFT banner', () => {
      expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
      expect(read(rel)).toContain(BANNER);
    });
  });

  it('both draft pages put the banner in the first lines a reader sees and ask search engines not to index', () => {
    ['privacy-policy-draft.html', 'terms-draft.html'].forEach((name) => {
      const html = read(DRAFT_DIR + '/' + name);
      const main = html.slice(html.indexOf('<main class="card">'));
      expect(main.indexOf(BANNER), name).toBeGreaterThan(-1);
      expect(main.indexOf(BANNER), name).toBeLessThan(main.indexOf('<h1>'));
      expect(html, name).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(html, name).toMatch(/<title>DRAFT /);
    });
  });

  it('every legal-review marker in the drafts is numbered, and every number is listed for the lawyer', () => {
    const review = read('docs/au-gp/privacy-terms-legal-review.md');
    const listed = new Set((review.match(/^\| LR (\d+) \|/gm) || []).map((row) => Number(row.match(/\d+/)[0])));
    expect(listed.size).toBeGreaterThan(0);
    DRAFTS.forEach((rel) => {
      const used = read(rel).match(/\[LEGAL REVIEW[^\]]*\]/g) || [];
      used.filter((marker) => !isGenericMention(marker)).forEach((marker) => {
        const num = marker.match(/^\[LEGAL REVIEW (\d+)/);
        expect(num, rel + ' has an unnumbered marker: ' + marker).not.toBeNull();
        expect(listed.has(Number(num[1])), rel + ' uses ' + marker + ' which is not in the lawyer list').toBe(true);
      });
    });
  });

  it('every owner placeholder is numbered and listed for the owner', () => {
    const review = read('docs/au-gp/privacy-terms-legal-review.md');
    const listed = new Set((review.match(/^\| OQ (\d+) \|/gm) || []).map((row) => Number(row.match(/\d+/)[0])));
    expect(listed.size).toBeGreaterThan(0);
    [DRAFT_DIR + '/privacy-policy-draft.html', DRAFT_DIR + '/terms-draft.html'].forEach((rel) => {
      const used = (read(rel).match(/\[OWNER TO CONFIRM[^\]]*\]/g) || []).filter((marker) => !isGenericMention(marker));
      expect(used.length, rel).toBeGreaterThan(0);
      used.forEach((marker) => {
        const num = marker.match(/^\[OWNER TO CONFIRM (\d+)/);
        expect(num, rel + ' has an unnumbered placeholder: ' + marker).not.toBeNull();
        expect(listed.has(Number(num[1])), rel + ' uses ' + marker + ' which is not in the owner list').toBe(true);
      });
    });
  });
});

describe('WP-25 published nothing', () => {
  it('the live privacy and terms pages are byte-identical to before this package', () => {
    expect(sha256('pages/privacy.html')).toBe('4d8f4b727405c8d98c0d410a15be94c999ca4581c9c3c1749c2de67f8c39b07f');
    expect(sha256('pages/terms.html')).toBe('bdf608060990cfb890701be850a0b665e4cd7cc81ba982cce27bdf320676015d');
  });

  it('the live privacy and terms pages carry no draft-only marker', () => {
    ['pages/privacy.html', 'pages/terms.html'].forEach((rel) => {
      const text = read(rel);
      DRAFT_ONLY_MARKERS.forEach((marker) => expect(text, rel + ' contains ' + marker).not.toContain(marker));
    });
  });

  it('no page or browser script refers to the drafts or carries a draft marker', () => {
    const files = listFiles('pages', ['.html']).concat(listFiles('js', ['.js']));
    expect(files.length).toBeGreaterThan(50);
    files.forEach((rel) => {
      const text = read(rel);
      ['legal-draft', '[LEGAL REVIEW', '[OWNER TO CONFIRM', 'data-wp25-draft', BANNER].forEach((marker) => {
        expect(text.includes(marker), rel + ' contains ' + marker).toBe(false);
      });
    });
  });

  it('server.js and lib/ never name a WP-25 draft file', () => {
    const files = ['server.js'].concat(listFiles('lib', ['.js']));
    files.forEach((rel) => {
      const text = read(rel);
      WP25_FILE_NAMES.forEach((name) => expect(text.includes(name), rel + ' names ' + name).toBe(false));
      expect(text.includes('data-wp25-draft'), rel).toBe(false);
      // The only lib/ file allowed to mention the folder is WP-28's agreement
      // variant list (its own draft, pinned by tests/agreement-au-draft-variant.test.js).
      if (rel !== 'lib/agreement-variants.js') expect(text.includes('legal-draft'), rel + ' mentions legal-draft').toBe(false);
    });
  });

  it('the drafts sit outside every folder the website serves', () => {
    const serverJs = read('server.js');
    const dirs = serverJs.match(/const PUBLIC_STATIC_DIRS = new Set\(\[([^\]]*)\]\)/);
    expect(dirs).not.toBeNull();
    const served = dirs[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(served).not.toContain('docs');
    DRAFTS.forEach((rel) => expect(served).not.toContain(rel.split('/')[0]));
  });

  it('the consent line on the booking form is unchanged', () => {
    expect(read('pages/site-start.html')).toContain(
      '<p class="book-consent">We\'ll only contact you about your enquiry. <a href="/pages/privacy" target="_blank" rel="noopener">Privacy policy</a>.</p>'
    );
  });
});

describe('WP-25 drafts can be dropped in after review', () => {
  const pairs = [
    ['pages/privacy.html', DRAFT_DIR + '/privacy-policy-draft.html'],
    ['pages/terms.html', DRAFT_DIR + '/terms-draft.html']
  ];

  it('each draft page keeps the live page\'s stylesheet, top bar and footer', () => {
    pairs.forEach(([liveRel, draftRel]) => {
      const live = read(liveRel);
      const draft = read(draftRel);
      const style = (html) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
      expect(style(draft), draftRel).toBe(style(live));
      const topbar = (html) => html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
      expect(topbar(draft), draftRel).toBe(topbar(live));
      expect(draft, draftRel).toContain('<main class="card">');
      expect(draft, draftRel).toContain('<div class="legal-footer">');
      expect(draft.trim().endsWith('</html>'), draftRel).toBe(true);
    });
  });

  it('each draft page uses only the tags the live pages use inside the card, plus the removable draft markers', () => {
    pairs.forEach(([, draftRel]) => {
      const draft = read(draftRel);
      const main = draft.slice(draft.indexOf('<main class="card">'), draft.indexOf('</main>')).replace(/<!--[\s\S]*?-->/g, '');
      const tags = new Set((main.match(/<([a-z0-9]+)[\s>]/g) || []).map((t) => t.replace(/[<\s>]/g, '')));
      const allowed = new Set(['main', 'h1', 'h2', 'p', 'ul', 'li', 'strong', 'br', 'div', 'span', 'a']);
      tags.forEach((tag) => expect(allowed.has(tag), draftRel + ' uses <' + tag + '>').toBe(true));
      // Every div and span inside the card is a draft marker that the publish step strips.
      (main.match(/<(div|span)\b[^>]*>/g) || []).forEach((open) => expect(open, draftRel).toContain('data-wp25-draft='));
    });
  });

  it('the privacy draft covers every item the review said was missing (WEB-19)', () => {
    const text = read(DRAFT_DIR + '/privacy-policy-draft.html');
    [
      'AI voice assistant', 'recorded', 'WhatsApp', 'Calendly', 'Zoom',
      'Ahpra registration number', 'provider number', 'prescriber number', 'indemnity',
      'right to work', 'current practice or employer', 'only after you have agreed',
      'public Ahpra register', 'Who Can See', 'How Long We Keep', 'outside Australia',
      'Office of the Australian Information Commissioner'
    ].forEach((needle) => expect(text.includes(needle), 'privacy draft is missing: ' + needle).toBe(true));
  });

  it('the terms draft is no longer only about relocation and covers the Australian service', () => {
    const text = read(DRAFT_DIR + '/terms-draft.html');
    [
      'GPs already registered and working in Australia', 'free for doctors', 'Practices pay our fees',
      'No Guarantee of Outcomes', 'accuracy of what you tell us about your registration',
      'Ahpra Register of practitioners', 'only after you have agreed to be put forward to that practice',
      'We do not contact your current practice or employer'
    ].forEach((needle) => expect(text.includes(needle), 'terms draft is missing: ' + needle).toBe(true));
    expect(text).not.toContain('relocation coordination services for medical practitioners');
  });
});

describe('WP-25 consent wording', () => {
  const consent = read(DRAFT_DIR + '/consent-wording.md');

  // The quoted lines under an "**Australian audience**" label, up to the next label or heading.
  function australianLines(md) {
    const out = [];
    const parts = md.split(/\n\*\*Australian audience\*\*[^\n]*\n/).slice(1);
    parts.forEach((part) => {
      const end = part.search(/\n(\*\*[A-Z][^\n]*\*\*|#{2,3} |---)/);
      const block = end === -1 ? part : part.slice(0, end);
      block.split('\n').filter((line) => line.startsWith('>')).forEach((line) => out.push(line));
    });
    return out;
  }

  it('has a line for each of the four places, with an Australian and an overseas variant where they differ', () => {
    ['## A. ', '## B. ', '## C. ', '## D. '].forEach((heading) => expect(consent).toContain(heading));
    expect((consent.match(/\*\*Australian audience\*\*/g) || []).length).toBeGreaterThanOrEqual(4);
    expect((consent.match(/\*\*Overseas audience\*\*/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('the AI-call consent is a separate, optional, unticked box that promises no call', () => {
    const start = consent.indexOf('### A2.');
    const block = consent.slice(start, consent.indexOf('### A3.'));
    expect(block).toContain('> ☐ Optional:');
    expect(block).toContain('AI phone assistant');
    expect(block).toContain('recorded');
    expect(block).toContain('only a person will call me');
    expect(block).not.toMatch(/> ☑|will call you/);
  });

  it('no Australian line uses a word an Australian doctor must never see', () => {
    const lines = australianLines(consent);
    expect(lines.length).toBeGreaterThan(8);
    const banned = [/myintealth/i, /\bAMC\b/, /\bEPIC\b/, /\bvisas?\b/i, /relocat/i, /your move/i, /overseas/i,
      /internationally trained/i, /\bGMC\b/, /\bSPPA\b/, /section g/i, /supervisor cv/i, /not yet eligible/i, /AHPRA/];
    lines.forEach((line) => banned.forEach((re) => expect(re.test(line), 'banned ' + re + ' in: ' + line).toBe(false)));
  });

  it('the per-practice consent names the practice and promises the current employer is not contacted', () => {
    const start = consent.indexOf('## C. ');
    const block = consent.slice(start, consent.indexOf('## D. '));
    expect(block).toContain('☐ I agree to GP Link sending my details to [Practice name] for this role.');
    expect(block).toContain('We never contact your current practice without asking you first.');
    expect(block).toContain('One consent covers one practice.');
  });
});
