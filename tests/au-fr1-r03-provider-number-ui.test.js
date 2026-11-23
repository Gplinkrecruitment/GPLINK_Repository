// Fix bundle FR-1, defect R-03: what the doctor's provider-number step and
// checklist say about a number the doctor typed. (The routes and the storage
// are tested in tests/au-wp12-server.test.js, "ADM-21".)
import { describe, it, expect } from 'vitest';

const prestartUi = require('../js/au-prestart.js');
const gpApp = require('../lib/au-gp-app.js');
const words = require('./helpers/au-banned-words.js');

const view = (providerNumber) => ({
  ok: true, placed: true, practiceName: 'Test Metro Practice (FAKE)', items: [], steps: [],
  providerStep: { intro: 'Your new practice location needs its own provider number.', steps: [] },
  details: { existingProviderNumbers: [], prescriberNumber: '' }, providerNumber
});

describe('R-03: the provider-number step', () => {
  it('a number the doctor entered reads "Being confirmed", never "On file", and can still be corrected', () => {
    const html = prestartUi._providerHtml(view({ recorded: false, number: '', pending: true, pendingNumber: '246810AB', locked: false }), {});
    expect(html).toContain('Being confirmed');
    expect(html).not.toContain('On file');
    expect(html).toContain('246810AB');
    expect(html).toContain('This is the number you entered. We are confirming it.');
    expect(html).toContain('data-au-new-number');
    expect(html).toContain('Save corrected number');
    expect(words.bannedLines([html.replace(/<[^>]+>/g, ' ')])).toEqual([]);
  });
  it('a staff-recorded number reads "On file" and offers no input', () => {
    const html = prestartUi._providerHtml(view({ recorded: true, number: '4567893C', pending: false, pendingNumber: '', locked: true }), {});
    expect(html).toContain('On file');
    expect(html).toContain('4567893C');
    expect(html).not.toContain('data-au-new-number');
    expect(html).toContain('Message us if it is wrong.');
  });
  it('once the case is complete with nothing recorded there is no input either', () => {
    const html = prestartUi._providerHtml(view({ recorded: false, number: '', pending: false, pendingNumber: '', locked: true }), {});
    expect(html).not.toContain('data-au-new-number');
  });
  it('a script in a number is drawn as text', () => {
    const html = prestartUi._providerHtml(view({ recorded: false, pending: true, pendingNumber: '<img src=x onerror=alert(1)>', locked: false }), {});
    expect(html).not.toContain('<img src=x');
  });
});

describe('R-03: the checklist item', () => {
  const build = (providerNumber, commencedAt) => gpApp.buildPrestartChecklist({
    placement: { key: 'app-1', practiceName: 'Test Metro Practice (FAKE)', startDate: '2027-01-11' },
    tasks: [
      { task_type: 'start_date_tracking', status: 'completed', metadata: { placement_key: 'app-1', confirmed_start_date: '2027-01-11' } },
      { task_type: 'indemnity_certificate', status: 'completed', metadata: { placement_key: 'app-1' } },
      { task_type: 'credentialing_pack', status: 'completed', metadata: { placement_key: 'app-1' } },
      { task_type: 'provider_number_new_location', status: providerNumber.recorded ? 'completed' : 'open', metadata: { placement_key: 'app-1' } }
    ],
    documents: [], allDocuments: [], registerChecked: true, registerCheckOpen: false, details: {}, providerNumber, commencedAt: commencedAt || ''
  });
  it('pending: waiting on GP Link, says "we are confirming it", and pre-start is NOT complete', () => {
    const out = build({ recorded: false, pending: true, pendingNumber: '246810AB' });
    const item = out.items.find((x) => x.key === 'provider_number');
    expect(item.status).toBe('waiting');
    expect(item.whatToDo).toMatch(/We are confirming it/);
    expect(out.complete).toBe(false);
    expect(out.facts.providerNumberRecorded).toBe(false);
  });
  it('recorded by staff: done, and pre-start is complete', () => {
    const out = build({ recorded: true, number: '246810AB' });
    expect(out.items.find((x) => x.key === 'provider_number').status).toBe('done');
    expect(out.complete).toBe(true);
  });
  it('after the start date, a pending number still reads as being confirmed (not "we still need this from you")', () => {
    const out = build({ recorded: false, pending: true, pendingNumber: '246810AB' }, '2027-01-11');
    const item = out.items.find((x) => x.key === 'provider_number');
    expect(item.stillNeeded).toBe(true);
    expect(item.why).toBe('We have the number you entered and are confirming it.');
  });
});
