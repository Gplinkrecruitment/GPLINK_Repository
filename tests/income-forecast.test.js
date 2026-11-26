// Income forecast (lib/income-forecast.js) on the CEO "Pipeline & money" board.
// The invoices below are the REAL Xero mirror rows as of 26 Nov 2026 (ids,
// numbers, contacts, line text, dates, amounts and owner overrides copied from
// prod xero_invoices); the people are the board rows they belong to.
import { describe, it, expect } from 'vitest';
import pipeline from '../lib/ceo-pipeline.js';
import fc from '../lib/income-forecast.js';

const TZ = 'Australia/Sydney';
const NOW_MS = Date.parse('2026-11-26T03:00:00.000Z');
const D = 86400000;
const ago = (ms) => new Date(NOW_MS - ms).toISOString();

const X = (o) => Object.assign({ type: 'ACCREC', reference: null, amount_paid: 0, fully_paid_on: null, doctor_name: null, owner_status: null, owner_note: null }, o);
const PLAN_TAIL = '\n\nRecruitment placement fee — equal monthly instalments\n\nTotal fee: $25,000 excl GST\n\nDuration: 6 months';
const REAL_INVOICES = [
  X({ invoice_id: '7c638ef6', invoice_number: 'INV-0001', status: 'VOIDED', contact_name: 'Khaleed Mahmoud', line_text: 'GP successfully sourced (50% Advance)', invoice_date: '2025-12-29', due_date: '2026-01-02', total: 9500, amount_due: 0 }),
  X({ invoice_id: '75fb5be8', invoice_number: 'INV-0014', status: 'PAID', contact_name: 'Chamira Ranatunga', reference: 'INV-879', line_text: 'PAYMENT PLAN — September 2026 instalment' + PLAN_TAIL, invoice_date: '2026-09-01', due_date: '2026-09-08', total: 4583.32, amount_due: 0, amount_paid: 4583.32, fully_paid_on: '2026-09-08' }),
  X({ invoice_id: '89769a2a', invoice_number: 'INV-0015', status: 'PAID', contact_name: 'Chamira Ranatunga', reference: 'INV-879', line_text: 'PAYMENT PLAN — October 2026 instalment' + PLAN_TAIL, invoice_date: '2026-10-01', due_date: '2026-10-08', total: 4583.32, amount_due: 0, amount_paid: 4583.32, fully_paid_on: '2026-10-08' }),
  X({ invoice_id: 'a0778d3c', invoice_number: 'INV-0016', status: 'PAID', contact_name: 'Chamira Ranatunga', reference: 'INV-879', line_text: 'PAYMENT PLAN — November 2026 instalment' + PLAN_TAIL, invoice_date: '2026-11-01', due_date: '2026-11-08', total: 4583.32, amount_due: 0, amount_paid: 4583.32, fully_paid_on: '2026-11-08' }),
  X({ invoice_id: '23b8ccbe', invoice_number: 'INV-842', status: 'VOIDED', contact_name: 'Chamira Ranatunga', line_text: 'GP successfully sourced (50% Advance)\n\n- Dr Krishnaveni Sivakumar\n35% Starting Advance (15% Due on Visa Lodgement)', invoice_date: '2026-06-26', due_date: '2026-07-03', total: 9625, amount_due: 0, doctor_name: 'Krishnaveni Sivakumar' }),
  X({ invoice_id: 'b89e9bc5', invoice_number: 'INV-843', status: 'PAID', contact_name: 'Wabbas Mahmud', line_text: 'Balance amount for sourcing Dr Obvious Chikore to Boolaroo Medical Centre\nLess: Amount received as deposit', invoice_date: '2026-06-15', due_date: '2026-07-03', total: 11400, amount_due: 0, amount_paid: 11400, fully_paid_on: '2026-07-20', doctor_name: 'Obvious Chikore' }),
  X({ invoice_id: '86bbc54d', invoice_number: 'INV-8515', status: 'AUTHORISED', contact_name: 'Kiran Puttappa', line_text: 'GP successfully sourced (50% Advance)', invoice_date: '2026-02-09', due_date: '2026-05-06', total: 11000, amount_due: 11000, owner_status: 'paid_outside_xero' }),
  X({ invoice_id: '8abd30e1', invoice_number: 'INV-8516', status: 'AUTHORISED', contact_name: 'Tarig Mahmoud', line_text: 'GP successfully sourced (50% Advance) \n\nDr Sana Ahsan', invoice_date: '2026-02-21', due_date: '2026-07-25', total: 13750, amount_due: 13750, doctor_name: 'Sana Ahsan' }),
  X({ invoice_id: '9cc13e99', invoice_number: 'INV-852', status: 'AUTHORISED', contact_name: 'Fady Tadros', line_text: 'GP successfully sourced (50% Advance)', invoice_date: '2026-01-01', due_date: '2026-01-31', total: 12375, amount_due: 12375, owner_status: 'paid_outside_xero' }),
  X({ invoice_id: '8c3b3b60', invoice_number: 'INV-853', status: 'AUTHORISED', contact_name: 'Wabbas Mahmud', line_text: '50% Advance for sourcing Dr Obvious Chikore for your practice', invoice_date: '2026-01-05', due_date: '2026-01-19', total: 9500, amount_due: 9500, doctor_name: 'Obvious Chikore', owner_status: 'paid_outside_xero' }),
  X({ invoice_id: 'd1725afa', invoice_number: 'INV-874', status: 'PAID', contact_name: 'Chamira Ranatunga', line_text: 'GP successfully sourced (50% Advance)\n\n- Dr Mercy Dzungwem Obanimoh', invoice_date: '2026-07-05', due_date: '2026-07-12', total: 13750, amount_due: 0, amount_paid: 13750, fully_paid_on: '2026-07-21', doctor_name: 'Mercy Dzungwem Obanimoh' }),
  X({ invoice_id: '78f5ccb1', invoice_number: 'INV-879', status: 'PAID', contact_name: 'Chamira Ranatunga', reference: 'INV-879', line_text: 'PAYMENT PLAN:\n\nCandidate: Dr Sivakumar' + PLAN_TAIL, invoice_date: '2026-08-01', due_date: '2026-08-06', total: 4583.32, amount_due: 0, amount_paid: 4583.32, fully_paid_on: '2026-08-11', doctor_name: 'Sivakumar' }),
  X({ invoice_id: '856f0db3', invoice_number: 'INV-880', status: 'PAID', contact_name: 'Tallulah lock', line_text: 'GP successfully sourced (50% Advance)\n\nDr Yan Naing Win', invoice_date: '2026-09-02', due_date: '2026-09-09', total: 7150, amount_due: 0, amount_paid: 7150, fully_paid_on: '2026-09-07', doctor_name: 'Yan Naing Win' }),
  X({ invoice_id: '0e746845', invoice_number: 'INV-963', status: 'AUTHORISED', contact_name: 'Tarig Mahmoud', line_text: 'GP successfully sourced (50% Advance)\n\nDr Hatice Akkas', invoice_date: '2026-10-09', due_date: '2026-10-16', total: 13750, amount_due: 3863, amount_paid: 9887, owner_status: 'chase', doctor_name: 'Hatice Akkas' })
];

const P = {
  hatice: '44444444-4444-4444-8444-000000000001', sana: '44444444-4444-4444-8444-000000000002', siva: '44444444-4444-4444-8444-000000000003',
  yan: '44444444-4444-4444-8444-000000000004', mush: '44444444-4444-4444-8444-000000000005', chikore: '44444444-4444-4444-8444-000000000006',
  fresh: '44444444-4444-4444-8444-000000000007', avais: '44444444-4444-4444-8444-000000000008'
};
const MERCY_USER = '55555555-5555-4555-8555-000000000001';
const row = (id, name, stage, practice, metadata) => ({ id, name, source: 'manual', stage, practice_name: practice || null, metadata: metadata || {}, created_at: ago(5 * D), updated_at: ago(5 * D) });
const PEOPLE = [
  row(P.hatice, 'Dr Hatice Akkas', 'signed', 'Halekulani Medical Centre', { expected_start: '2027-07-01', expected_start_basis: 'agreed' }),
  row(P.sana, 'Dr Sana Ahsan', 'signed', 'Halekulani Medical Centre', { expected_start: '2027-02-15', expected_start_basis: 'estimated' }),
  row(P.siva, 'Dr Krishnaveni Sivakumar', 'signed', 'Forest Lake Local Doctors'),
  row(P.yan, 'Dr Yan Naing Win', 'visa', 'Deception Bay Medical Centre', { expected_start: '2027-02-01', expected_start_basis: 'estimated', history: 'kept' }),
  row(P.mush, 'Dr Musharraf', 'signed', 'Mount Hutton Medical & Skin Cancer Centre', {
    expected_start: '2027-05-01', expected_start_basis: 'estimated',
    fee_first_half_paid: { invoice: 'INV-857 (Zoho Books, before Xero)', amount_inc_gst: 10450, paid_on: '2026-01-05', payer: 'Dr Wabbas Mahmud (Mount Hutton)', evidence: 'Westpac $10,450 on 5 Jan 2026' },
    fee_second_half_inc_gst: 10450, fee_total_ex_gst: 19000
  }),
  row(P.chikore, 'Dr Obvious Chikore', 'started', 'Boolaroo Medical Centre'),
  row(P.fresh, 'Dr Fresh Signing', 'signed', 'Some Practice', { fee_total_ex_gst: 21000 }),
  row(P.avais, 'Dr Mohammed Avais Hussain', 'visa', 'Harrisdale Medical Centre (Dr Kiran Puttappa)')
];
// INV-8515 (no doctor on the invoice) was linked by hand to Dr Avais Hussain.
const INVOICES = REAL_INVOICES.map((i) => (i.invoice_number === 'INV-8515' ? Object.assign({}, i, { pipeline_person_id: P.avais }) : i));
const SYNC = [{ source: 'xero', last_ok_at: ago(10 * 60000), detail: {} }];
// Dr Mercy is an app doctor: her start comes from the placement.
const APP = {
  user_profiles: [{ user_id: MERCY_USER, first_name: 'Mercy', last_name: 'Obanimoh', email: 'mercy@example.com', created_at: ago(300 * D), account_status: 'active', target_arrival_date: '2027-03-22' }],
  placements: [{ id: 'pl-mercy', user_id: MERCY_USER, practice_name: 'The Doctors Werribee', start_date: '2027-01-01', status: 'active', placed_at: ago(100 * D), created_at: ago(100 * D) }],
  registration_cases: [{ id: 'case-mercy', user_id: MERCY_USER, stage: 'visa', status: 'active', updated_at: ago(5 * D) }]
};
const input = (over) => Object.assign({ pipeline_people: PEOPLE, xero_invoices: INVOICES, pipeline_sync_state: SYNC, nowMs: NOW_MS, tz: TZ }, APP, over || {});

const board = pipeline.buildPipelineBoard(input());
const f = board.forecast;
const bucket = (k) => f.buckets.find((b) => b.key === k);
const items = (k) => bucket(k).items.map((i) => [i.kind, i.doctor, i.amount_inc_gst, i.invoice_number || null]);

describe('lib/income-forecast — real Xero rows (26 Nov 2026)', () => {
  it('has Owed now, 12 months from this month in the owner\'s zone, Date unknown (and a "later" catch-all)', () => {
    expect(f.today).toBe('2026-11-26');
    expect(f.months).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10']);
    expect(f.buckets.map((b) => b.key)).toEqual(['owed'].concat(f.months, ['unknown', 'later']));
    expect(bucket('2026-11')).toMatchObject({ label: 'Nov', year: 2026 });
  });

  it('owed now: INV-8516 in full and what is left of INV-963 (marked chase); paid-outside-Xero ones never', () => {
    expect(items('owed')).toEqual([['overdue', 'Dr Sana Ahsan', 13750, 'INV-8516'], ['overdue', 'Dr Hatice Akkas', 3863, 'INV-963']]);
    expect(bucket('owed').items[1].basis).toContain('part paid $9,887');
    expect(bucket('owed').items[1].basis).toContain('you marked it to chase');
    expect(f.totals.owed_now).toBe(17613);
    expect(f.totals.owed_now).toBe(board.money.overdue); // same as the money tile
  });

  it('payment plan INV-879: the two instalments not invoiced yet, Dec 2026 and Jan 2027, and no second half for Dr Sivakumar', () => {
    const plan = f.buckets.flatMap((b) => b.items).filter((i) => i.kind === 'plan');
    expect(plan.map((i) => [i.bucket, i.date, i.amount_inc_gst])).toEqual([['2026-12', '2026-12-08', 4583.36], ['2027-01', '2027-01-08', 4583.36]]);
    expect(plan[0].doctor).toBe('Dr Krishnaveni Sivakumar');
    expect(plan.reduce((s, i) => s + i.amount_inc_gst, 0)).toBeCloseTo(board.money.coming, 2);
    expect(f.buckets.flatMap((b) => b.items).some((i) => i.kind === 'second_half' && /Sivakumar/.test(i.doctor))).toBe(false);
  });

  it('second 50% in the start month + 7 days, start taken from the owner, then the placement', () => {
    const second = f.buckets.flatMap((b) => b.items).filter((i) => i.kind === 'second_half');
    const by = (n) => second.find((i) => i.invoice_number === n);
    expect(by('INV-963')).toMatchObject({ doctor: 'Dr Hatice Akkas', amount_inc_gst: 13750, date: '2027-07-08', bucket: '2027-07', confidence: 'agreed' });
    expect(by('INV-8516')).toMatchObject({ doctor: 'Dr Sana Ahsan', amount_inc_gst: 13750, date: '2027-02-22', bucket: '2027-02', confidence: 'estimated' });
    expect(by('INV-880')).toMatchObject({ doctor: 'Dr Yan Naing Win', amount_inc_gst: 7150, date: '2027-02-08', bucket: '2027-02' });
    expect(by('INV-874')).toMatchObject({ doctor: 'Dr Mercy Obanimoh', amount_inc_gst: 13750, date: '2027-01-08', bucket: '2027-01' });
    expect(f.doctors.find((d) => d.name === 'Dr Mercy Obanimoh')).toMatchObject({ expected_start: '2027-01-01', start_basis: 'placement' });
  });

  it('INV-8515 follows its pipeline_person_id to Dr Avais Hussain; INV-852 names nobody, so Date unknown', () => {
    const avais = f.buckets.flatMap((b) => b.items).find((i) => i.invoice_number === 'INV-8515');
    expect(avais).toMatchObject({ kind: 'second_half', doctor: 'Dr Mohammed Avais Hussain', person_id: P.avais, amount_inc_gst: 11000, date: '2027-02-01', bucket: '2027-02' }); // visa → today + 60 days, + 7
    expect(items('unknown')).toEqual([['second_half', '', 12375, 'INV-852']]);
    expect(bucket('unknown').items[0]).toMatchObject({ confidence: 'unknown', from: 'Fady Tadros' });
  });

  it('no second half after INV-853: INV-843 is the balance for Dr Chikore; voided INV-842 and INV-0001 are ignored', () => {
    const nums = f.buckets.flatMap((b) => b.items).map((i) => i.invoice_number);
    expect(nums).not.toContain('INV-853');
    expect(nums).not.toContain('INV-843');
    expect(nums).not.toContain('INV-842');
    expect(nums).not.toContain('INV-0001');
  });

  it('first 50% paid outside Xero (Dr Musharraf, Zoho INV-857): not "to invoice", second half $10,450 in his start month, money line says so', () => {
    const mush = f.buckets.flatMap((b) => b.items).filter((i) => i.person_id === P.mush);
    expect(mush.map((i) => [i.kind, i.amount_inc_gst, i.date, i.bucket])).toEqual([['second_half', 10450, '2027-05-08', '2027-05']]);
    expect(mush[0].basis).toContain('INV-857');
    expect(board.money.notInvoicedNames).not.toContain('Dr Musharraf');
    expect(board.people.find((p) => p.name === 'Dr Musharraf').money).toBe('First 50% paid 5 Jan 2026 (INV-857, outside Xero)');
  });

  it('signed with no invoice at all: first 50% now (fee override honoured), second 50% at the stage estimate', () => {
    const fresh = f.buckets.flatMap((b) => b.items).filter((i) => i.person_id === P.fresh);
    expect(fresh.map((i) => [i.kind, i.amount_inc_gst, i.bucket])).toEqual([['to_invoice', 11550, '2026-11'], ['second_half', 11550, '2027-05']]); // 21,000 / 2 + GST; today + 150 + 7
    expect(board.money.notInvoicedNames).toEqual(['Dr Fresh Signing']);
  });

  it('totals and the editable doctor list', () => {
    // Nov 11,550 · Dec 4,583.36 · Jan 4,583.36 + 13,750
    expect(f.totals.next_3_months).toBe(34466.72);
    // + Feb 13,750 + 7,150 + 11,000 · May 10,450 + 11,550 · Jul 13,750
    expect(f.totals.next_12_months).toBe(34466.72 + 31900 + 22000 + 13750);
    expect(f.totals.unknown).toBe(12375);
    expect(f.totals.after_12_months).toBe(0);
    const hatice = f.doctors.find((d) => d.name === 'Dr Hatice Akkas');
    expect(hatice).toMatchObject({ id: P.hatice, stage: 'signed', expected_start: '2027-07-01', start_basis: 'owner', confidence: 'agreed', owner_basis: 'agreed', amount_inc_gst: 17613 });
    expect(f.doctors.map((d) => d.name)).not.toContain('Dr Obvious Chikore'); // started, nothing to come
    expect(board.people.every((p) => p.has_invoice === undefined && p.has_xero_invoice === undefined)).toBe(true);
  });

  it('a cancelled/closed placement takes its second half off the forecast', () => {
    const b = pipeline.buildPipelineBoard(input({ pipeline_people: PEOPLE.map((r) => (r.id === P.sana ? Object.assign({}, r, { stage: 'closed' }) : r)) }));
    const items2 = b.forecast.buckets.flatMap((x) => x.items).filter((i) => i.invoice_number === 'INV-8516');
    expect(items2.map((i) => i.kind)).toEqual(['overdue']);
    expect(items2[0].confidence).toBe('unknown');
  });

  it('without a Xero sync only hand-added money is forecast', () => {
    const b = pipeline.buildPipelineBoard(input({ pipeline_sync_state: [], income_expectations: [{ id: 'e1', label: 'Zoho balance', amount_inc_gst: 5000, expected_date: '2027-03-10', confidence: 'agreed' }] }));
    expect(b.forecast.connected).toBe(false);
    expect(b.forecast.buckets.flatMap((x) => x.items).map((i) => [i.kind, i.bucket])).toEqual([['manual', '2027-03']]);
  });
});

describe('lib/income-forecast — pure rules', () => {
  const base = { nowMs: NOW_MS, tz: TZ, connected: true };

  it('expected start: owner date → placement → profile → stage guess; stale recorded dates are skipped', () => {
    const today = '2026-11-26';
    expect(fc.expectedStart({ stage: 'signed', expected_start: '2027-03-01', expected_start_basis: 'agreed', placement_start: '2027-01-01' }, today)).toMatchObject({ date: '2027-03-01', basis: 'owner', confidence: 'agreed' });
    expect(fc.expectedStart({ stage: 'signed', expected_start: '2027-03-01' }, today)).toMatchObject({ basis: 'owner', confidence: 'estimated' });
    expect(fc.expectedStart({ stage: 'signed', placement_start: '2027-01-01', target_arrival: '2027-03-22' }, today)).toMatchObject({ date: '2027-01-01', basis: 'placement', confidence: 'estimated' });
    expect(fc.expectedStart({ stage: 'signed', placement_start: '2026-01-01', target_arrival: '2027-03-22' }, today)).toMatchObject({ date: '2027-03-22', basis: 'profile' });
    expect(fc.expectedStart({ stage: 'signed', target_arrival: '' }, today)).toMatchObject({ date: '2027-04-25', basis: 'stage' });
    expect(fc.expectedStart({ stage: 'visa' }, today)).toMatchObject({ date: '2027-01-25', basis: 'stage' });
    expect(fc.expectedStart({ stage: 'matched' }, today)).toMatchObject({ date: null, confidence: 'unknown' });
  });

  it('the owner\'s time zone picks the month: 1 Dec 06:00 in Sydney is still 30 Nov in London', () => {
    const t = Date.parse('2026-11-30T19:00:00Z');
    expect(fc.buildIncomeForecast(Object.assign({}, base, { nowMs: t, tz: 'Australia/Sydney' })).months[0]).toBe('2026-12');
    expect(fc.buildIncomeForecast(Object.assign({}, base, { nowMs: t, tz: 'Europe/London' })).months[0]).toBe('2026-11');
  });

  it('a start date already passed with no balance invoice lands this month; past 12 months goes to "later"', () => {
    const out = fc.buildIncomeForecast(Object.assign({}, base, {
      invoices: [
        { invoice_id: 'a', invoice_number: 'INV-1', status: 'PAID', contact_name: 'A', line_text: '50% Advance', total: 100, amount_due: 0, person_id: 'p1' },
        { invoice_id: 'b', invoice_number: 'INV-2', status: 'PAID', contact_name: 'B', line_text: '50% Advance', total: 200, amount_due: 0, person_id: 'p2' }
      ],
      people: [{ id: 'p1', name: 'Dr One', stage: 'signed', expected_start: '2026-10-01', has_invoice: true }, { id: 'p2', name: 'Dr Two', stage: 'signed', expected_start: '2028-06-01', has_invoice: true }]
    }));
    expect(out.buckets.find((b) => b.key === '2026-11').items[0]).toMatchObject({ amount_inc_gst: 100 });
    expect(out.buckets.find((b) => b.key === '2026-11').items[0].basis).toContain('has passed');
    expect(out.totals.after_12_months).toBe(200);
  });

  it('an unpaid invoice not due yet goes in its due month; manual rows without a date are Date unknown', () => {
    const out = fc.buildIncomeForecast(Object.assign({}, base, {
      invoices: [{ invoice_id: 'c', invoice_number: 'INV-3', status: 'AUTHORISED', contact_name: 'C', line_text: 'Locum fees', total: 500, amount_due: 500, due_date: '2026-12-03' }],
      expectations: [{ id: 'e', label: 'Old Zoho balance', amount_inc_gst: 900, expected_date: null }, { id: 'x', label: 'gone', amount_inc_gst: 1, archived_at: ago(D) }]
    }));
    expect(out.buckets.find((b) => b.key === '2026-12').items[0]).toMatchObject({ kind: 'invoiced', amount_inc_gst: 500 });
    expect(out.buckets.find((b) => b.key === 'unknown').items.map((i) => [i.kind, i.amount_inc_gst, i.confidence])).toEqual([['manual', 900, 'unknown']]);
    expect(out.expectations.map((e) => e.id)).toEqual(['e']);
  });

  it('sameDoctor: board rule plus a lone surname', () => {
    expect(fc.sameDoctor('Dr Sivakumar', 'Krishnaveni Sivakumar')).toBe(true);
    expect(fc.sameDoctor('Mercy Dzungwem Obanimoh', 'Dr Mercy Obanimoh')).toBe(true);
    expect(fc.sameDoctor('Dr Sana Ahsan', 'Dr Hatice Akkas')).toBe(false);
  });
});
