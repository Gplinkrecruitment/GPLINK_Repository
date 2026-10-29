'use strict';

// lib/ads-review.js — the model's side of the Ads hub: a daily plain-English
// review of the Meta campaign, new ad briefs that apply the review's
// improvements, and one-instruction rewrites of a draft.
//
// Prompt building and answer parsing are pure. callClaude() is raw HTTP (the
// server has no SDK dependency and calls the Messages API with fetch
// everywhere else) with an injectable fetch, so every runner is testable
// without a key. The model is Claude Opus 5.5 by default — the owner asked for
// Opus specifically — with thinking left adaptive (the model decides) at
// medium effort: high effort spent the whole output budget reasoning and
// returned nothing, and the review has to fit inside one Vercel function call.

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
const ANTHROPIC_VERSION = '2023-06-01';

// What the account has learned, so the model argues from the same evidence
// the owner has (handovers of 2026-09-29 and the 21 Oct 2026 audit).
const HOUSE_CONTEXT = [
  'Advertiser: GP Link, an Australian recruitment agency placing UK-trained GPs in Australian practices. Service is free for doctors.',
  'Goal that matters: BOOKED CONSULTATION CALLS (30-minute Calendly call), not form leads. Cost per booking per ad decides which angles stay. Historically ~33% of instant-form leads book, most within 10 minutes of the form.',
  'Account: Meta, AUD, one campaign, OUTCOME_LEADS, Employment special ad category (GB). The category forbids occupation targeting, exclusions beyond custom audiences, lookalikes and detailed targeting, so the AD COPY must self-select GPs: profession-only jargon in the headline (QOF, CQC, 8am scramble, eConsults, appraisal, duty day, partner) is the proven mechanism and CTR runs 56-122% above Meta\'s peer benchmark because of it.',
  'Evidence so far: the "after"-led jargon line "No QOF. No CQC. No 8am scramble." (sunny Australian practice image) booked 13 of 34 leads; pain-led angles booked 4 of 9, 2 of 4, 1 of 1; the partner angle 0 of 9; lifestyle/"universally relatable" concepts (dinner on a Tuesday, etc.) produced no leads four times. Facebook feed and Facebook Stories are the placements that produce.',
  'Creative system: Figtree type, navy/blue, documentary photographs, headline drawn on the image at 1080x1350 (4:5), sub-line underneath. No figures, no testimonials, no salary numbers, no guarantees, no named doctors, no placement counts, no promised timelines, no em dashes anywhere. Every primary text ends with the closer "Completely free for doctors." Call to action: Book now, to the straight-to-Calendly instant form.',
  'Rotation rule (owner, every Monday): pause an ad when its 7-day frequency is above 3 or its link-click-to-lead rate over 7 days is below 4%; keep at least three ads live; add the next fresh creative when one is paused.',
  'Limits: creatives are immutable, so any change is a new ad; the connector cannot edit lead-form ad sets (owner does that in Ads Manager); Warm/Hot retargeting is paused; dayparting UK 06:00-21:00 is pending the owner\'s automated rules.'
].join('\n');

// Structured-output schemas. Meta-rules learned live on 2026-10-29: the API
// rejects `maxItems`, `minimum`/`maximum` and friends inside output_config
// .format.schema ("For 'array' type, property 'maxItems' is not supported"),
// so every limit lives in the description and is enforced by normaliseReview().
const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    angle: { type: 'string', description: 'Short slug, lowercase, hyphens, e.g. 05-duty-day. Becomes the ad name.' },
    image_headline: { type: 'string', description: 'The line drawn on the image. Profession jargon, under 45 characters.' },
    image_sub: { type: 'string', description: 'The sub-line under it, under 90 characters.' },
    headline: { type: 'string', description: 'Ads Manager headline, usually the same as image_headline.' },
    primary_text: { type: 'string', description: 'Three short paragraphs separated by blank lines, ending with "Completely free for doctors."' },
    description: { type: 'string', description: 'Ads Manager description, under 40 characters, e.g. "UK-trained GPs. Free 30-minute call."' },
    image_prompt: { type: 'string', description: 'A photograph brief for an image generator: documentary, no text, no logos, no faces to camera, what is in frame, light, mood, 4:5.' },
    rationale: { type: 'string', description: 'Why this ad, in one or two sentences, citing the improvements it applies.' },
    improvements_applied: { type: 'array', items: { type: 'string' }, description: 'Ids of the improvements this ad applies, e.g. ["imp-1","imp-3"].' }
  },
  required: ['angle', 'image_headline', 'image_sub', 'headline', 'primary_text', 'description', 'image_prompt', 'rationale', 'improvements_applied']
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string', description: 'One sentence verdict on yesterday and the week, plain English, no jargon.' },
    summary: { type: 'string', description: '3 to 6 sentences: what happened, what changed versus last week, what it means for bookings. Numbers only where they change a decision.' },
    actions_today: {
      type: 'array',
      description: 'At most 6 things to do today, most important first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          why: { type: 'string' },
          where: { type: 'string', enum: ['ads_manager', 'this_page', 'follow_up', 'none'] }
        },
        required: ['action', 'why', 'where']
      }
    },
    ad_verdicts: {
      type: 'array',
      description: 'One entry per LIVE ad.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ad_id: { type: 'string' },
          verdict: { type: 'string', enum: ['keep', 'scale', 'watch', 'pause'] },
          reason: { type: 'string' }
        },
        required: ['ad_id', 'verdict', 'reason']
      }
    },
    improvements: {
      type: 'array',
      description: 'At most 8 improvements, priority 1 first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'imp-1, imp-2, ...' },
          title: { type: 'string' },
          evidence: { type: 'string', description: 'The number or pattern in the data this rests on.' },
          change: { type: 'string', description: 'Exactly what to do differently in the next ads.' },
          applies_to: { type: 'string', enum: ['headline', 'image', 'primary_text', 'cta', 'angle', 'format', 'budget', 'targeting', 'follow_up'] },
          priority: { type: 'integer', description: '1 (do first) to 3 (nice to have).' }
        },
        required: ['id', 'title', 'evidence', 'change', 'applies_to', 'priority']
      }
    },
    new_ad_briefs: {
      type: 'array',
      description: 'Two to four new ads that apply the improvements.',
      items: BRIEF_SCHEMA
    }
  },
  required: ['headline', 'summary', 'actions_today', 'ad_verdicts', 'improvements', 'new_ad_briefs']
};

const BRIEFS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ads: { type: 'array', items: BRIEF_SCHEMA }
  },
  required: ['ads']
};

const ITERATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    angle: { type: 'string' },
    image_headline: { type: 'string' },
    image_sub: { type: 'string' },
    headline: { type: 'string' },
    primary_text: { type: 'string' },
    description: { type: 'string' },
    image_prompt: { type: 'string' },
    change_note: { type: 'string', description: 'One sentence saying what was changed and why.' }
  },
  required: ['angle', 'image_headline', 'image_sub', 'headline', 'primary_text', 'description', 'image_prompt', 'change_note']
};

// ── trimming the snapshot for the prompt ───────────────────────────────────
function short(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function compactAd(ad) {
  const a = ad || {};
  const c = a.creative || {};
  return {
    ad_id: a.id,
    name: a.name,
    status: a.effective_status,
    ad_set: a.adset_name,
    days_live: a.days_live,
    headline: c.headline,
    description: c.description,
    primary_text: short(c.primary_text, 420),
    cta: c.cta_label || c.cta,
    yesterday: a.metrics && a.metrics.yesterday,
    last_7d: a.metrics && a.metrics.last_7d,
    last_30d: a.metrics && a.metrics.last_30d,
    app_funnel_7d: a.funnel && a.funnel.d7,
    app_funnel_30d: a.funnel && a.funnel.d30,
    flags: (a.flags || []).map(function (f) { return f.label; })
  };
}

function compactSnapshot(snapshot) {
  const s = snapshot || {};
  const ads = Array.isArray(s.ads) ? s.ads : [];
  return {
    fetched_at: s.fetched_at,
    time_zone: s.account && s.account.time_zone,
    currency: s.account && s.account.currency,
    ad_sets: (s.adsets || []).map(function (x) {
      return { id: x.id, name: x.name, status: x.effective_status, daily_budget: x.daily_budget, goal: x.optimization_goal, learning: x.learning };
    }),
    totals: s.totals,
    app_funnel: s.funnel,
    app_funnel_unattributed: s.funnel_unattributed,
    daily_last_14_days: s.daily,
    live_ads: ads.filter(function (a) { return a.effective_status === 'ACTIVE'; }).map(compactAd),
    paused_ads: ads.filter(function (a) { return a.effective_status !== 'ACTIVE'; }).map(function (a) {
      const c = compactAd(a);
      delete c.primary_text;
      delete c.yesterday;
      return c;
    }),
    data_problems: s.errors
  };
}

// ── prompts ────────────────────────────────────────────────────────────────
const REVIEW_SYSTEM = [
  'You are the performance marketer reviewing GP Link\'s Meta campaign every morning for the owner, who is not an ads specialist. Write in plain English, short sentences, no jargon that is not explained, no em dashes. Be direct: say what is working, what is not, and what to do today. Never invent a number; every claim must trace to the data you are given. When the data is thin (few leads), say so and avoid strong verdicts.',
  '',
  'How to judge: cost per BOOKING (app_funnel booked ÷ spend) outranks cost per lead; cost per lead outranks CTR. Apply the owner\'s rotation rule literally for pause verdicts. Treat an ad under 7 days old as settling unless it is already clearly wasting money. Compare against the previous week from the daily series and against the account\'s evidence below.',
  '',
  'Improvements must be concrete and testable in the NEXT ads (a headline mechanism, an image direction, a copy structure, a CTA, a format), each with the evidence it rests on. New ad briefs must follow every creative rule below; the image_headline must self-select a GP with profession-only jargon.',
  '',
  'ACCOUNT CONTEXT',
  HOUSE_CONTEXT
].join('\n');

function buildReviewMessages(input) {
  const i = input || {};
  const today = i.today || new Date().toISOString().slice(0, 10);
  const parts = [
    'Today is ' + today + ' (' + ((i.snapshot && i.snapshot.account && i.snapshot.account.time_zone) || 'Australia/Melbourne') + ').',
    'Here is the campaign snapshot: Meta metrics per ad for yesterday, the last 7 days and the last 30 days; the app\'s own funnel per ad (leads received by the app, qualified GPs, booked calls, sign-ups) for 7 and 30 days; the 14-day daily series; and any data problems.',
    '',
    JSON.stringify(compactSnapshot(i.snapshot))
  ];
  if (i.previousReview && i.previousReview.improvements && i.previousReview.improvements.length) {
    parts.push('', 'Yesterday\'s improvements, for continuity (keep an id if the same point still stands, retire it if the data no longer supports it):',
      JSON.stringify(i.previousReview.improvements.map(function (x) { return { id: x.id, title: x.title, change: x.change }; })));
  }
  parts.push('', 'Return the review as JSON matching the schema.');
  return { system: REVIEW_SYSTEM, user: parts.join('\n') };
}

const BRIEF_SYSTEM = [
  'You write Meta lead ads for GP Link. Every ad must follow the creative rules exactly; a rule break makes the ad unusable. Plain English, short sentences, UK spelling, no em dashes (use a full stop or comma instead), no salary figures, no testimonials, no guarantees, no named doctors, no placement counts, no promised timelines, no claims about the owner\'s business size.',
  '',
  'Structure of primary_text: three short paragraphs separated by a blank line. Paragraph 1: the UK pain, in the GP\'s own vocabulary, concrete and specific (a time, a document, a screen). Paragraph 2: how Australian general practice runs differently on that exact point, hedged with "most" where it is not universal. Paragraph 3, always this shape: "If you\'re UK-trained there\'s a recognised route to practising in Australia, and we handle the whole thing: AHPRA, the visa, English requirements, and finding you the right practice. Book a free 30-minute call. Completely free for doctors."',
  '',
  'image_headline: profession-only jargon that only a GP recognises, under 45 characters, no exclamation marks. image_sub: one calm line under 90 characters that names Australia and UK-trained GPs. headline: same as image_headline. description: under 40 characters.',
  '',
  'Claims you may use because they are true and already in the account: no QOF and no CQC in Australia; practices are accredited at practice level; most GPs work as contractors inside a practice that carries the building, staff and systems; paid on billings; fifteen-minute consults as standard; online triage is not the front door for most practices; registration kept through CPD and annual AHPRA renewal, no appraisal meeting or revalidation cycle; UK training is recognised (eligibility depends on MRCGP from August 2007 onward plus a GMC CCT, which the call covers). Do not invent other claims.',
  '',
  'ACCOUNT CONTEXT',
  HOUSE_CONTEXT
].join('\n');

function buildBriefMessages(input) {
  const i = input || {};
  const count = Math.max(1, Math.min(6, Number(i.count) || 3));
  const imps = Array.isArray(i.improvements) ? i.improvements : [];
  const parts = [
    'Write ' + count + ' new ad' + (count === 1 ? '' : 's') + '. Each must apply every improvement listed below and name which ones in improvements_applied. Each ad needs a different angle; none may reuse a live ad\'s headline.',
    '',
    'IMPROVEMENTS TO APPLY',
    JSON.stringify(imps.map(function (x) { return { id: x.id, title: x.title, change: x.change, evidence: x.evidence }; }))
  ];
  if (i.review && i.review.summary) parts.push('', 'THIS MORNING\'S REVIEW', String(i.review.summary));
  if (i.instructions) parts.push('', 'OWNER\'S INSTRUCTIONS (take precedence over everything except the creative rules)', String(i.instructions));
  const live = ((i.snapshot && i.snapshot.ads) || []).filter(function (a) { return a.effective_status === 'ACTIVE'; });
  if (live.length) {
    parts.push('', 'LIVE ADS (do not duplicate these headlines; learn from what books)',
      JSON.stringify(live.map(function (a) {
        return { headline: a.creative && a.creative.headline, leads_7d: a.metrics && a.metrics.last_7d && a.metrics.last_7d.leads, booked_30d: a.funnel && a.funnel.d30 && a.funnel.d30.booked, cost_per_lead_7d: a.metrics && a.metrics.last_7d && a.metrics.last_7d.cost_per_lead };
      })));
  }
  const existing = Array.isArray(i.existingDrafts) ? i.existingDrafts : [];
  if (existing.length) {
    parts.push('', 'DRAFTS ALREADY ON THE PAGE (do not repeat these angles)',
      JSON.stringify(existing.map(function (d) { return { angle: d.angle, headline: d.headline }; })));
  }
  parts.push('', 'Return JSON matching the schema.');
  return { system: BRIEF_SYSTEM, user: parts.join('\n') };
}

function buildIterateMessages(input) {
  const i = input || {};
  const d = i.draft || {};
  const parts = [
    'Revise this ad according to the owner\'s instruction. Change only what the instruction needs; keep everything else as it is, word for word. Keep every creative rule. Return the complete revised ad.',
    '',
    'CURRENT AD',
    JSON.stringify({
      angle: d.angle, image_headline: d.image_headline, image_sub: d.image_sub,
      headline: d.headline, primary_text: d.primary_text, description: d.description, image_prompt: d.image_prompt
    }),
    '',
    'OWNER\'S INSTRUCTION',
    String(i.instruction || '')
  ];
  parts.push('', 'Return JSON matching the schema.');
  return { system: BRIEF_SYSTEM, user: parts.join('\n') };
}

// ── parsing ────────────────────────────────────────────────────────────────
function extractJson(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (err) { /* fall through */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) { try { return JSON.parse(fence[1]); } catch (err) { /* fall through */ } }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (err) { return null; } }
  return null;
}

function str(v, max) { return short(String(v == null ? '' : v).trim(), max || 4000); }

const APPLIES = ['headline', 'image', 'primary_text', 'cta', 'angle', 'format', 'budget', 'targeting', 'follow_up'];
const VERDICTS = ['keep', 'scale', 'watch', 'pause'];
const WHERE = ['ads_manager', 'this_page', 'follow_up', 'none'];

function normaliseBrief(b, idx) {
  const x = b || {};
  const angle = String(x.angle || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || ('ad-' + (idx + 1));
  return {
    angle: angle,
    image_headline: str(x.image_headline, 120),
    image_sub: str(x.image_sub, 200),
    headline: str(x.headline || x.image_headline, 255),
    primary_text: str(x.primary_text, 3000),
    description: str(x.description, 255),
    image_prompt: str(x.image_prompt, 1200),
    rationale: str(x.rationale, 600),
    improvements_applied: (Array.isArray(x.improvements_applied) ? x.improvements_applied : []).map(function (s) { return str(s, 40); }).filter(Boolean)
  };
}

// Brand-rule checks that are cheap to run on anything the model wrote.
function briefWarnings(b) {
  const out = [];
  const x = b || {};
  ['image_headline', 'image_sub', 'headline', 'primary_text', 'description'].forEach(function (f) {
    if (String(x[f] || '').indexOf('—') !== -1) out.push(f + ' contains an em dash.');
  });
  if (!/completely free for doctors\.?\s*$/i.test(String(x.primary_text || ''))) out.push('primary_text does not end with "Completely free for doctors."');
  if (String(x.image_headline || '').length > 45) out.push('image_headline is over 45 characters.');
  if (/\$|£|€|\d{2,3},\d{3}/.test(String(x.primary_text || '') + String(x.headline || ''))) out.push('copy appears to contain a money figure.');
  return out;
}

function normaliseReview(obj) {
  const r = obj || {};
  const imps = (Array.isArray(r.improvements) ? r.improvements : []).slice(0, 8).map(function (x, i) {
    const y = x || {};
    return {
      id: /^imp-\d+$/.test(String(y.id || '')) ? String(y.id) : ('imp-' + (i + 1)),
      title: str(y.title, 160),
      evidence: str(y.evidence, 600),
      change: str(y.change, 800),
      applies_to: APPLIES.indexOf(y.applies_to) !== -1 ? y.applies_to : 'angle',
      priority: Math.min(3, Math.max(1, Number(y.priority) || 2))
    };
  });
  // Ids must be unique: a duplicate would make "apply imp-2" ambiguous.
  const seen = {};
  imps.forEach(function (x, i) { if (seen[x.id]) x.id = 'imp-' + (i + 1) + 'b'; seen[x.id] = true; });
  const briefs = (Array.isArray(r.new_ad_briefs) ? r.new_ad_briefs : []).slice(0, 4).map(normaliseBrief);
  return {
    headline: str(r.headline, 300),
    summary: str(r.summary, 2500),
    actions_today: (Array.isArray(r.actions_today) ? r.actions_today : []).slice(0, 6).map(function (x) {
      const y = x || {};
      return { action: str(y.action, 300), why: str(y.why, 500), where: WHERE.indexOf(y.where) !== -1 ? y.where : 'none' };
    }).filter(function (x) { return x.action; }),
    ad_verdicts: (Array.isArray(r.ad_verdicts) ? r.ad_verdicts : []).map(function (x) {
      const y = x || {};
      return { ad_id: str(y.ad_id, 40), verdict: VERDICTS.indexOf(y.verdict) !== -1 ? y.verdict : 'watch', reason: str(y.reason, 500) };
    }).filter(function (x) { return x.ad_id; }),
    improvements: imps,
    new_ad_briefs: briefs,
    warnings: briefs.reduce(function (acc, b, i) {
      return acc.concat(briefWarnings(b).map(function (w) { return 'Brief ' + (i + 1) + ': ' + w; }));
    }, [])
  };
}

// ── the call ───────────────────────────────────────────────────────────────
// Non-streaming on purpose: the server waits for the whole answer anyway and
// Vercel's 300s function ceiling is far above a 16k-token Opus reply. Structured
// output (output_config.format) is asked for first; if the API refuses the
// parameter the call is retried once without it and the JSON is extracted
// from the text, so a schema mismatch cannot take the morning review down.
async function callClaude(opts) {
  const o = opts || {};
  const doFetch = o.fetchImpl || globalThis.fetch;
  const apiKey = String(o.apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY is not set.' };
  const model = o.model || DEFAULT_MODEL;

  function body(withFormat) {
    const b = {
      model: model,
      // Thinking tokens count against max_tokens. A high-effort Opus pass used the
      // whole 16k on reasoning and returned no JSON at all (measured 2026-10-29),
      // so the cap is generous and the effort default is medium.
      max_tokens: o.maxTokens || 24000,
      system: [{ type: 'text', text: String(o.system || ''), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: String(o.user || '') }],
      output_config: { effort: o.effort || 'medium' }
    };
    if (withFormat && o.schema) b.output_config.format = { type: 'json_schema', schema: o.schema };
    return b;
  }

  async function once(withFormat) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, o.timeoutMs || 240000) : null;
    let r;
    try {
      r = await doFetch(o.url || MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body(withFormat)),
        signal: controller ? controller.signal : undefined
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      return { ok: false, error: 'Could not reach the model: ' + String((err && err.message) || err), network: true };
    }
    if (timer) clearTimeout(timer);
    let data = null;
    try { data = await r.json(); } catch (err) { data = null; }
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
      return { ok: false, status: r.status, error: msg, data: data };
    }
    return { ok: true, status: r.status, data: data };
  }

  let r = await once(true);
  if (!r.ok && r.status === 400 && /output_config|format|json_schema|schema/i.test(String(r.error))) {
    r = await once(false);
    if (r.ok) r.formatFallback = true;
  }
  if (!r.ok) return r;
  const msg = r.data || {};
  if (msg.stop_reason === 'max_tokens') {
    return { ok: false, error: 'The model ran out of room before finishing (max_tokens).', stop_reason: 'max_tokens', usage: msg.usage };
  }
  if (msg.stop_reason === 'refusal') {
    return { ok: false, error: 'The model declined this request (' + ((msg.stop_details && msg.stop_details.category) || 'refusal') + ').', stop_reason: 'refusal' };
  }
  const text = (Array.isArray(msg.content) ? msg.content : [])
    .filter(function (b) { return b && b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n');
  const json = extractJson(text);
  return {
    ok: true,
    model: msg.model || model,
    stop_reason: msg.stop_reason,
    text: text,
    json: json,
    formatFallback: !!r.formatFallback,
    usage: {
      input_tokens: Number(msg.usage && msg.usage.input_tokens) || 0,
      output_tokens: Number(msg.usage && msg.usage.output_tokens) || 0,
      cache_read_input_tokens: Number(msg.usage && msg.usage.cache_read_input_tokens) || 0,
      cache_creation_input_tokens: Number(msg.usage && msg.usage.cache_creation_input_tokens) || 0
    }
  };
}

// ── runners ────────────────────────────────────────────────────────────────
async function runDailyReview(opts) {
  const o = opts || {};
  const m = buildReviewMessages({ snapshot: o.snapshot, previousReview: o.previousReview, today: o.today });
  const r = await callClaude(Object.assign({}, o, { system: m.system, user: m.user, schema: REVIEW_SCHEMA }));
  if (!r.ok) return r;
  if (!r.json) return { ok: false, error: 'The model did not return JSON.', text: r.text, usage: r.usage, model: r.model };
  return { ok: true, review: normaliseReview(r.json), usage: r.usage, model: r.model, formatFallback: r.formatFallback, text: r.text };
}

async function generateBriefs(opts) {
  const o = opts || {};
  const m = buildBriefMessages(o);
  const r = await callClaude(Object.assign({}, o, { system: m.system, user: m.user, schema: BRIEFS_SCHEMA }));
  if (!r.ok) return r;
  const ads = r.json && Array.isArray(r.json.ads) ? r.json.ads : null;
  if (!ads) return { ok: false, error: 'The model did not return ads.', text: r.text, usage: r.usage, model: r.model };
  const briefs = ads.slice(0, 6).map(normaliseBrief);
  return {
    ok: true,
    briefs: briefs,
    warnings: briefs.map(briefWarnings),
    usage: r.usage,
    model: r.model
  };
}

async function iterateDraft(opts) {
  const o = opts || {};
  const m = buildIterateMessages(o);
  const r = await callClaude(Object.assign({}, o, { system: m.system, user: m.user, schema: ITERATE_SCHEMA, effort: o.effort || 'low' }));
  if (!r.ok) return r;
  if (!r.json) return { ok: false, error: 'The model did not return JSON.', text: r.text, usage: r.usage, model: r.model };
  const revised = normaliseBrief(Object.assign({}, o.draft || {}, r.json), 0);
  return {
    ok: true,
    revised: revised,
    change_note: str(r.json.change_note, 400),
    warnings: briefWarnings(revised),
    usage: r.usage,
    model: r.model
  };
}

module.exports = {
  MESSAGES_URL,
  DEFAULT_MODEL,
  HOUSE_CONTEXT,
  BRIEF_SCHEMA,
  REVIEW_SCHEMA,
  BRIEFS_SCHEMA,
  ITERATE_SCHEMA,
  compactAd,
  compactSnapshot,
  buildReviewMessages,
  buildBriefMessages,
  buildIterateMessages,
  extractJson,
  normaliseBrief,
  briefWarnings,
  normaliseReview,
  callClaude,
  runDailyReview,
  generateBriefs,
  iterateDraft
};
