'use strict';
// Graph-API-shaped fixture built from the live account on 2026-10-29 (one
// campaign, one active ad set at AU$100/day, seven live ads). Numbers are the
// real last-7-day figures; the daily series and the 30-day window are scaled
// from them. Lead rows are SYNTHETIC: counts per ad match production on that
// day, names and emails are invented.

const CAMPAIGN = '120248645727400648';
const ADSET_LIVE = '120249238461470648';
const ADSET_OLD = '120248904071200648';

function creative(id, title, body, hash, cta) {
  return {
    id: id, name: title + ' 2026-10-26-x', title: title, body: body,
    description: 'UK-trained GPs. Free 30-minute call.',
    image_url: 'https://scontent.xx.fbcdn.net/v/' + hash + '.jpg',
    thumbnail_url: 'https://external.xx.fbcdn.net/t/' + hash + '_64.jpg',
    image_hash: hash, call_to_action_type: cta || 'BOOK_TRAVEL',
    object_story_spec: { page_id: '769864969547691', link_data: { image_hash: hash, name: title, message: body } }
  };
}

const BODY = 'Eight o\'clock. The phone lines open, the duty list fills before you have sat down.\n\nAustralian general practice runs differently.\n\nIf you\'re UK-trained there\'s a recognised route to practising in Australia. Book a free 30-minute call. Completely free for doctors.';

const adsets = [
  { id: ADSET_LIVE, name: 'Test | Pain points · before vs split | 30 Sep 2026 – Copy', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '10000', optimization_goal: 'QUALITY_LEAD', learning_stage_info: { status: 'LEARNING', last_sig_edit_ts: 1793012582 } },
  { id: ADSET_OLD, name: 'Test | Pain points · before vs split | 30 Sep 2026', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '10000', optimization_goal: 'QUALITY_LEAD', learning_stage_info: { last_sig_edit_ts: 1792588538 } }
];

const ads = [
  { id: '120249238461490648', name: 'Locum drought', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: ADSET_LIVE, created_time: '2026-10-22T00:40:28+1100', creative: creative('1155547626803509', 'Australia is hiring UK-trained GPs.', BODY, 'h1') },
  { id: '120249238461520648', name: 'Dark in, dark out', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: ADSET_LIVE, created_time: '2026-10-22T00:40:28+1100', creative: creative('2096860640963070', 'Your last winter of duty days?', BODY, 'h2') },
  { id: '120249238461540648', name: '"01-no-qof · split"', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: ADSET_LIVE, created_time: '2026-10-22T00:40:28+1100', creative: creative('1464187682445323', 'No QOF. No CQC. No 8am scramble.', BODY, 'h3') },
  { id: '120249238461480648', name: 'Ten minutes', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: ADSET_LIVE, created_time: '2026-10-22T00:40:28+1100', creative: creative('1109417461791110', 'Fifteen-minute consults. As standard.', BODY, 'h4') },
  { id: '120249238461530648', name: '"01-no-qof · before"', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: ADSET_LIVE, created_time: '2026-10-22T00:40:28+1100', creative: creative('1101253582510897', 'No QOF. No CQC. No 8am scramble.', BODY, 'h5') },
  { id: '120249238461560648', name: 'CQC inspection on Tuesday.', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: ADSET_LIVE, created_time: '2026-10-22T00:40:28+1100', creative: creative('1014207681695539', 'CQC inspection on Tuesday.', BODY, 'h6') },
  { id: '120249238461500648', name: 'Ad3', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: ADSET_LIVE, created_time: '2026-10-22T00:40:28+1100', creative: creative('1556605209836033', 'General practice, the way you meant to do it', BODY, 'h7') },
  { id: '120249238461510648', name: '(BENCH)Paid on your billings', status: 'PAUSED', effective_status: 'PAUSED', adset_id: ADSET_LIVE, created_time: '2026-10-22T00:40:28+1100', creative: creative('1142285938253613', 'Paid on your billings.', BODY, 'h8') },
  { id: '120248907760920648', name: 'Ten minutes (old set)', status: 'ACTIVE', effective_status: 'ADSET_PAUSED', adset_id: ADSET_OLD, created_time: '2026-09-30T20:52:13+1000', creative: creative('1664121371800768', 'Fifteen-minute consults. As standard.', BODY, 'h9') }
];

function ins(adId, name, spend, imp, reach, clicks, link, leads) {
  const actions = [{ action_type: 'link_click', value: String(link) }];
  if (leads) actions.push({ action_type: 'lead', value: String(leads) }, { action_type: 'onsite_conversion.lead_grouped', value: String(leads) });
  return {
    ad_id: adId, ad_name: name, adset_id: ADSET_LIVE, adset_name: adsets[0].name,
    spend: String(spend), impressions: String(imp), reach: String(reach),
    frequency: String(reach ? imp / reach : 0), clicks: String(clicks),
    ctr: String(imp ? (clicks / imp * 100).toFixed(2) : 0), cpm: String(imp ? (spend / imp * 1000).toFixed(2) : 0),
    actions: actions, date_start: '2026-10-22', date_stop: '2026-10-28'
  };
}

const last_7d = [
  ins('120249238461490648', 'Locum drought', 208.6, 12128, 5547, 382, 117, 5),
  ins('120249238461520648', 'Dark in, dark out', 82.82, 4973, 3115, 170, 37, 2),
  ins('120249238461540648', '01-no-qof · split', 45.73, 2431, 1623, 61, 14, 1),
  ins('120249238461480648', 'Ten minutes', 4.31, 228, 184, 2, 1, 0),
  ins('120249238461530648', '01-no-qof · before', 228.81, 12778, 6373, 374, 74, 2),
  ins('120249238461560648', 'CQC inspection on Tuesday.', 13.87, 773, 563, 26, 4, 0),
  ins('120249238461500648', 'Ad3', 5.51, 232, 173, 3, 0, 0)
];
const yesterday = last_7d.map(function (r) {
  return Object.assign({}, r, {
    spend: String((Number(r.spend) / 7).toFixed(2)), impressions: String(Math.round(Number(r.impressions) / 7)),
    reach: String(Math.round(Number(r.reach) / 7)), clicks: String(Math.round(Number(r.clicks) / 7)),
    actions: r.actions.map(function (a) { return { action_type: a.action_type, value: String(Math.round(Number(a.value) / 7)) }; }),
    date_start: '2026-10-28', date_stop: '2026-10-28'
  });
});
const last_30d = last_7d.map(function (r) {
  return Object.assign({}, r, {
    spend: String((Number(r.spend) * 1.15).toFixed(2)), impressions: String(Math.round(Number(r.impressions) * 1.15)),
    reach: String(Math.round(Number(r.reach) * 1.1)), clicks: String(Math.round(Number(r.clicks) * 1.15)),
    actions: r.actions.map(function (a) { return { action_type: a.action_type, value: String(Math.round(Number(a.value) * 1.2)) }; }),
    date_start: '2026-09-29', date_stop: '2026-10-28'
  });
});

// 14 daily rows for the campaign: the previous week quieter than this one.
const daily = [];
for (let i = 13; i >= 0; i--) {
  const d = new Date(Date.UTC(2026, 9, 28) - i * 86400000);
  const thisWeek = i < 7;
  const spend = thisWeek ? 84.2 : 61.5;
  const leads = thisWeek ? (i % 2 ? 2 : 1) : (i % 3 === 0 ? 1 : 0);
  daily.push({
    date_start: d.toISOString().slice(0, 10), date_stop: d.toISOString().slice(0, 10),
    spend: String(spend), impressions: String(thisWeek ? 4800 : 3500), reach: String(thisWeek ? 2600 : 2100), clicks: String(thisWeek ? 145 : 90),
    actions: [{ action_type: 'link_click', value: String(thisWeek ? 35 : 22) }, { action_type: 'lead', value: String(leads) }]
  });
}

// Synthetic app rows with production's per-ad counts (1-28 Oct 2026).
const leadRows = [];
function lead(adId, daysAgo, booked, qualified) {
  const at = new Date(Date.UTC(2026, 9, 29) - daysAgo * 86400000).toISOString();
  leadRows.push({
    id: 'lead-' + leadRows.length, kind: 'gp', name: 'Dr Test ' + leadRows.length, email: 'lead' + leadRows.length + '@example.test',
    created_at: at, status: 'new',
    metadata: { source: 'meta_lead_ad', fb_ad_id: adId, fb_form_id: '1065996865920792', fb_lead_id: '1234567890123' + leadRows.length,
      consult: { qualified: qualified !== false, call_booked: !!booked, call_booked_at: booked ? at : undefined } }
  });
}
// Locum drought: 5 leads this week, 2 booked; older: 4 more, 2 booked
[1, 2, 3, 4, 6].forEach(function (d, i) { lead('120249238461490648', d, i < 2); });
[9, 12, 15, 20].forEach(function (d, i) { lead('120249238461490648', d, i < 2); });
// Dark in dark out: 2 this week, 0 booked
[2, 5].forEach(function (d) { lead('120249238461520648', d, false); });
// 01-no-qof split: 1 lead, 0 booked
lead('120249238461540648', 3, false);
// 01-no-qof before: 2 leads, 1 booked
lead('120249238461530648', 1, true); lead('120249238461530648', 4, false);
// Ten minutes old set: 9 leads over the month, 4 booked
[8, 10, 11, 13, 14, 17, 19, 22, 25].forEach(function (d, i) { lead('120248907760920648', d, i < 4); });
// a lead with no ad id (landing page) and a non-meta lead
leadRows.push({ id: 'x1', kind: 'gp', created_at: new Date(Date.UTC(2026, 9, 27)).toISOString(), metadata: { source: 'site_start_form', consult: { qualified: true } } });
leadRows.push({ id: 'x2', kind: 'gp', created_at: new Date(Date.UTC(2026, 9, 27)).toISOString(), metadata: { source: 'meta_lead_ad', consult: { qualified: true, call_booked: true } } });

module.exports = {
  CAMPAIGN, ADSET_LIVE, ADSET_OLD, adsets, ads,
  insights: { yesterday: yesterday, last_7d: last_7d, last_30d: last_30d },
  daily: daily, leadRows: leadRows,
  NOW: Date.UTC(2026, 9, 29, 2, 0, 0)
};
