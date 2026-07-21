import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// document-prep.js is a browser IIFE (assigns window.gpDocPrep). Load it into a
// sandbox with stubbed window/localStorage so we can exercise the pure logic.
function loadDocPrep() {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const win = {};
  const code = fs.readFileSync(path.join(ROOT, 'js/document-prep.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'localStorage', code + '\nreturn window.gpDocPrep;');
  const dp = fn(win, localStorage);
  return { dp, store };
}

const setCountry = (store, name) => { store['gp_selected_country'] = JSON.stringify(name); };

describe('document-prep: country resolution', () => {
  let dp, store;
  beforeEach(() => { ({ dp, store } = loadDocPrep()); });

  it('maps training-country names to config keys', () => {
    setCountry(store, 'United Kingdom'); expect(dp.getCountry()).toBe('uk');
    setCountry(store, 'Ireland'); expect(dp.getCountry()).toBe('ie');
    setCountry(store, 'New Zealand'); expect(dp.getCountry()).toBe('nz');
  });

  it('accepts codes and is case-insensitive', () => {
    setCountry(store, 'GB'); expect(dp.getCountry()).toBe('uk');
    setCountry(store, 'ie'); expect(dp.getCountry()).toBe('ie');
    setCountry(store, 'nz'); expect(dp.getCountry()).toBe('nz');
  });

  it('reports missing country and defaults to uk', () => {
    expect(dp.hasCountry()).toBe(false);
    expect(dp.getCountry()).toBe('uk');
  });
});

describe('document-prep: scannable / outstanding / progress', () => {
  let dp, store;
  beforeEach(() => { ({ dp, store } = loadDocPrep()); setCountry(store, 'uk'); });

  it('scannable docs are the certified ones (CV excluded)', () => {
    const scan = dp.getScannableDocs('uk');
    expect(scan).toHaveLength(3);
    expect(scan.find((d) => d.key === 'cv_signed_dated')).toBeUndefined();
    expect(dp.getScannableDocs('ie')).toHaveLength(4);
    expect(dp.getScannableDocs('nz')).toHaveLength(3);
  });

  it('everything is outstanding when there is no saved state', () => {
    expect(dp.getOutstandingScannable('uk')).toHaveLength(3);
    expect(dp.getProgress('uk')).toEqual({ prepared: 0, total: 3 });
    expect(dp.getOutstandingScannable('uk')[0].key).toBe('primary_medical_degree');
  });

  it('drops satisfied docs and advances the suggestion', () => {
    store['gp_documents_prep'] = JSON.stringify({
      country: 'uk',
      docs: { primary_medical_degree: { uploaded: true, status: 'certified' } },
      certFailCounts: {}
    });
    const out = dp.getOutstandingScannable('uk');
    expect(out).toHaveLength(2);
    expect(out[0].key).toBe('mrcgp_certified');
    expect(dp.getProgress('uk')).toEqual({ prepared: 1, total: 3 });
  });

  it('isSatisfied recognises uploaded/under_review/certified, not pending', () => {
    expect(dp.isSatisfied({ status: 'pending' })).toBe(false);
    expect(dp.isSatisfied({ status: 'under_review' })).toBe(true);
    expect(dp.isSatisfied({ status: 'certified' })).toBe(true);
    expect(dp.isSatisfied({ uploaded: true })).toBe(true);
    expect(dp.isSatisfied(null)).toBe(false);
  });
});

// Drift guard: PREPARED_DOCS must stay in sync with COUNTRY_DOCS[*].prepared in
// pages/my-documents.html. This is a forward check — every shared doc must exist
// verbatim (key + title) in the page, and the certified-doc counts must match.
describe('document-prep: PREPARED_DOCS stays in sync with my-documents.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'pages/my-documents.html'), 'utf8');
  const { dp } = loadDocPrep();

  for (const country of ['uk', 'ie', 'nz']) {
    for (const doc of dp.PREPARED_DOCS[country]) {
      it(`${country}/${doc.key} key+title present in my-documents.html`, () => {
        expect(html).toContain(`key: "${doc.key}"`);
        expect(html).toContain(doc.title);
      });
    }
  }

  it('certified-doc counts match the known config (3/4/3)', () => {
    expect(dp.getScannableDocs('uk')).toHaveLength(3);
    expect(dp.getScannableDocs('ie')).toHaveLength(4);
    expect(dp.getScannableDocs('nz')).toHaveLength(3);
  });
});
