import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const meta = require('../lib/meta-ads.js');
const ctx = require('../lib/ads-context.js');

const NOW = Date.UTC(2026, 10, 2, 8, 0, 0); // Mon 2 Nov 2026, 19:00 Sydney
const TZ = 'Australia/Sydney';
const CFG = meta.adsConfig({ META_ADS_ACCESS_TOKEN: 't' });

function stub(handler) {
  const calls = [];
  const impl = async (url) => {
    const u = new URL(url);
    const params = {};
    u.searchParams.forEach((v, k) => { params[k] = k === 'time_range' ? JSON.parse(v) : v; });
    calls.push({ path: u.pathname.replace(/^\/v[\d.]+/, ''), params });
    const data = handler(params) || [];
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { impl, calls };
}
function row(over) {
  return Object.assign({ spend: '100', impressions: '5000', reach: '3000', frequency: '1.67', clicks: '150', ctr: '3', cpm: '20', actions: [{ action_type: 'link_click', value: '40' }, { action_type: 'lead', value: '4' }] }, over || {});
}

describe('presets on the account calendar', () => {
  it('matches the Ads Manager presets (Sydney day, week starts Monday)', () => {
    expect(meta.presetRange('today', NOW, TZ)).toMatchObject({ since: '2026-11-02', until: '2026-11-02' });
    expect(meta.presetRange('yesterday', NOW, TZ)).toMatchObject({ since: '2026-11-01', until: '2026-11-01' });
    expect(meta.presetRange('last_7d', NOW, TZ)).toMatchObject({ since: '2026-10-26', until: '2026-11-01' });
    expect(meta.presetRange('last_30d', NOW, TZ)).toMatchObject({ since: '2026-10-03', until: '2026-11-01' });
    expect(meta.presetRange('this_week', NOW, TZ)).toMatchObject({ since: '2026-11-02', until: '2026-11-02' });
    expect(meta.presetRange('last_week', NOW, TZ)).toMatchObject({ since: '2026-10-26', until: '2026-11-01' });
    expect(meta.presetRange('this_month', NOW, TZ)).toMatchObject({ since: '2026-11-01', until: '2026-11-02' });
    expect(meta.presetRange('last_month', NOW, TZ)).toMatchObject({ since: '2026-10-01', until: '2026-10-31' });
    expect(meta.presetRange('nope', NOW, TZ)).toBeNull();
  });
  it('a late-evening UTC moment is already the next day in Sydney', () => {
    const lateUtc = Date.UTC(2026, 10, 2, 15, 0, 0); // 02:00 on 3 Nov in Sydney
    expect(meta.presetRange('today', lateUtc, TZ).since).toBe('2026-11-03');
  });
  it('compare is the previous period of the same length; resolveRange validates', () => {
    expect(meta.comparePeriod('2026-10-26', '2026-11-01')).toEqual({ since: '2026-10-19', until: '2026-10-25' });
    expect(meta.comparePeriod('2026-11-01', '2026-11-01')).toEqual({ since: '2026-10-31', until: '2026-10-31' });
    expect(meta.resolveRange({ preset: 'last_7d' }, NOW, TZ)).toMatchObject({ ok: true, days: 7, label: 'Last 7 days' });
    expect(meta.resolveRange({ since: '2026-10-01', until: '2026-10-15' }, NOW, TZ)).toMatchObject({ ok: true, days: 15, preset: null });
    expect(meta.resolveRange({ since: '2026-10-15', until: '2026-10-01' }, NOW, TZ).ok).toBe(false);
    expect(meta.resolveRange({ since: '2024-01-01', until: '2026-10-01' }, NOW, TZ).error).toMatch(/year/);
    expect(meta.resolveRange({ since: 'x' }, NOW, TZ).ok).toBe(false);
  });
  it('range bounds are Sydney midnights in UTC', () => {
    const b = meta.rangeBoundsMs('2026-11-01', '2026-11-01', TZ);
    expect(new Date(b.start).toISOString()).toBe('2026-10-31T13:00:00.000Z'); // AEDT = UTC+11
    expect(b.end - b.start).toBe(86400000);
  });
});

describe('buildRangeReport', () => {
  const facts = ctx.enrichLeads({ now: NOW, leads: [
    { id: 'l1', email: 'l1@x', created_at: '2026-10-28T10:00:00Z', status: 'new', metadata: { source: 'meta_lead_ad', fb_ad_id: '101', consult: { qualified: true, call_booked: true, call_booked_at: '2026-10-28T10:05:00Z' } } },
    { id: 'l2', email: 'l2@x', created_at: '2026-10-29T10:00:00Z', status: 'converted', metadata: { source: 'meta_lead_ad', fb_ad_id: '102', consult: { qualified: true, call_booked: true, call_booked_at: '2026-10-30T10:00:00Z' } } },
    { id: 'l3', email: 'l3@x', created_at: '2026-10-20T10:00:00Z', status: 'new', metadata: { source: 'meta_lead_ad', fb_ad_id: '101', consult: { qualified: true } } }
  ], consults: [{ invitee_email: 'l1@x', status: 'completed', completed_at: '2026-10-29T10:00:00Z', created_at: '2026-10-28T10:05:00Z' }] });

  function handler(params) {
    const r = params.time_range;
    const isCompare = r.since === '2026-10-19';
    if (params.level === 'ad') {
      return [row({ ad_id: '101', ad_name: 'One', spend: isCompare ? '50' : '200', actions: [{ action_type: 'link_click', value: '60' }, { action_type: 'lead', value: '3' }] }),
        row({ ad_id: '102', ad_name: 'Two', spend: '80' })];
    }
    if (params.time_increment) {
      return ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'].map((d) => row({ date_start: d, date_stop: d, spend: '40' }));
    }
    return [row({ spend: isCompare ? '130' : '280', reach: '9000', frequency: '2.1' })];
  }

  it('returns totals, the series with the app bookings per day, the per-ad table with the app funnel, and compare deltas', async () => {
    const s = stub(handler);
    const r = await meta.buildRangeReport({ config: CFG, fetchImpl: s.impl, now: NOW, preset: 'last_7d', compare: true, leadFacts: facts, adsMeta: { 101: { name: 'One', headline: 'H1', image_url: 'u', effective_status: 'ACTIVE' } } });
    expect(r.ok).toBe(true);
    expect(r.range).toMatchObject({ since: '2026-10-26', until: '2026-11-01', days: 7, preset: 'last_7d' });
    expect(r.increment).toBe('1');
    expect(s.calls).toHaveLength(5);
    expect(s.calls.every((c) => c.path.endsWith('/insights'))).toBe(true);
    expect(s.calls[1].params.time_increment).toBe('1');
    expect(r.totals.spend).toBe(280);
    expect(r.totals.reach).toBe(9000); // campaign row, not a sum of ads
    expect(r.series).toHaveLength(7);
    expect(r.series[2]).toMatchObject({ since: '2026-10-28', booked: 1, app_leads: 1 });
    expect(r.series[3]).toMatchObject({ since: '2026-10-29', app_leads: 1, booked: 1 });
    expect(r.ads[0]).toMatchObject({ id: '101', headline: 'H1', status: 'ACTIVE' });
    expect(r.ads[0].metrics.spend).toBe(200);
    expect(r.ads[0].funnel).toMatchObject({ leads: 1, booked: 1, attended: 1, cost_per_booking: 200 });
    expect(r.ads[1].funnel).toMatchObject({ leads: 1, booked: 1, signed_up: 1, cost_per_booking: 80 });
    expect(r.funnel).toMatchObject({ leads: 2, booked: 2, attended: 1, signed_up: 1, cost_per_booking: 140 });
    expect(r.compare.range).toEqual({ since: '2026-10-19', until: '2026-10-25', days: 7 });
    expect(r.compare.totals.spend).toBe(130);
    expect(r.compare.funnel.leads).toBe(1); // l3 on 20 Oct
    expect(r.deltas.spend).toBe(115);
    expect(r.deltas.booked).toBeNull(); // 0 bookings before: no percentage
    expect(r.compare.ads_by_id['101'].metrics.spend).toBe(50);
  });
  it('lists an ad that had bookings but no delivery rows, picks the step from the length, and skips compare when off', async () => {
    const s = stub((params) => (params.level === 'ad' ? [row({ ad_id: '102', ad_name: 'Two' })] : params.time_increment ? [row({ date_start: '2026-10-01', date_stop: '2026-10-31' })] : [row()]));
    const r = await meta.buildRangeReport({ config: CFG, fetchImpl: s.impl, now: NOW, since: '2026-09-01', until: '2026-11-01', compare: false, leadFacts: facts, adsMeta: {} });
    expect(r.increment).toBe('monthly');
    expect(s.calls).toHaveLength(3);
    expect(r.compare).toBeNull();
    expect(r.deltas).toBeNull();
    const a1 = r.ads.find((a) => a.id === '101');
    expect(a1).toBeTruthy();
    expect(a1.metrics.spend).toBe(0);
    expect(a1.funnel.booked).toBe(1);
  });
  it('without a token reports the problem and still carries the app funnel', async () => {
    const r = await meta.buildRangeReport({ config: meta.adsConfig({}), now: NOW, preset: 'last_30d', leadFacts: facts });
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(false);
    expect(r.errors[0]).toMatch(/META_ADS_ACCESS_TOKEN/);
    expect(r.funnel.leads).toBe(3);
  });
  it('a bad range is an error, not a report', async () => {
    const r = await meta.buildRangeReport({ config: CFG, now: NOW, since: '2026-11-05', until: '2026-11-01' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/after/);
  });
});
