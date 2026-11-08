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

// The review's changes to the ad account itself (schema, normalising) live
// with their executor, so the model can only ask for what the app can do.
const adsActions = require('./ads-actions.js');
// Likewise the changes to the app's own automation (Hazel's calling rules,
// the chase sequence, the no-show sweep): the levers and their executor.
const automationActions = require('./automation-actions.js');

// What the account has learned, so the model argues from the same evidence
// the owner has (handovers of 2026-09-29 and the 21 Oct 2026 audit).
const HOUSE_CONTEXT = [
  'Advertiser: GP Link, an Australian recruitment agency placing UK-trained GPs in Australian practices. Service is free for doctors.',
  'Goal that matters: BOOKED CONSULTATION CALLS (30-minute Calendly call), not form leads. Cost per booking per ad decides which angles stay. Historically ~33% of instant-form leads book, most within 10 minutes of the form.',
  'Account: Meta, AUD, one campaign, OUTCOME_LEADS, Employment special ad category (GB). The category forbids occupation targeting, exclusions beyond custom audiences, lookalikes and detailed targeting, so the AD COPY must self-select GPs: profession-only jargon in the headline (QOF, CQC, 8am scramble, eConsults, appraisal, duty day, partner) is the proven mechanism and CTR runs 56-122% above Meta\'s peer benchmark because of it.',
  'Evidence so far: the "after"-led jargon line "No QOF. No CQC. No 8am scramble." (sunny Australian practice image) booked 13 of 34 leads; pain-led angles booked 4 of 9, 2 of 4, 1 of 1; the partner angle 0 of 9; lifestyle/"universally relatable" concepts (dinner on a Tuesday, etc.) produced no leads four times. Facebook feed and Facebook Stories are the placements that produce.',
  'Creative system: Figtree type, navy/blue, documentary photographs of ONE GP in a real moment (never an empty room), headline drawn on the image at 1080x1350 (4:5), sub-line underneath. No figures, no testimonials, no salary numbers, no guarantees, no named doctors, no placement counts, no promised timelines, no em dashes anywhere. Every primary text ends with the closer "Completely free for doctors." Call to action: Book now, to the straight-to-Calendly instant form.',
  'Rotation rule (owner, every Monday): pause an ad when its 7-day frequency is above 3 or its link-click-to-lead rate over 7 days is below 4%; keep at least three ads live; add the next fresh creative when one is paused.',
  'Limits: creatives are immutable, so any change to copy or image is a new ad. From this page the app can pause or resume an ad or an ad set, change an ad set\'s daily budget and launch a ready draft (account_changes). It cannot edit lead forms, targeting, placements or schedules, or create ad sets: those stay with the owner in Ads Manager. Warm/Hot retargeting is paused; dayparting UK 06:00-21:00 is pending the owner\'s automated rules.'
].join('\n');

// The photograph. Learned the hard way on 2026-11-06: with only "documentary,
// no faces to camera" to go on, the model briefed empty rooms ("a procedure
// couch with fresh paper, a dermatoscope on a tray, no people") and the ads
// looked like stock wallpaper. Every ad that has booked shows a GP in the
// moment the headline names, so that is the rule, with the place made
// obvious through where a GP works, not through postcards.
const PHOTO_DIRECTION = [
  'THE PHOTOGRAPH. Every ad is a documentary photograph of ONE GP in the exact moment the headline names, and image_prompt is the brief for it. Never an empty room, a desk, a couch or a building on its own: every ad that has booked has a person in it (the No QOF ad that booked 13 of 34 leads is a GP mid-stride with a coffee and a satchel outside a sunny brick practice). Write the brief as: who (a UK-trained GP, 35 to 55, any ethnicity, plain clothes: a cotton shirt or a jumper, never scrubs or a white coat, and no lanyard or name badge, because generators write gibberish on them), what they are doing at that second with their eyes on that task, the expression, where, the light, the lens (35mm, close enough to read the face). Say it twice in the brief: face seen from a three-quarter angle, eyes on the task, not looking at the camera; the generator defaults to a straight-to-lens portrait otherwise. No text, no logos, no screens with legible words.',
  'FRAMING. A medium shot from about two metres: the GP from the waist or hips up fills the middle of the frame, head in the upper third of the picture but not touching the top edge, face large enough to read the expression, with plain uncluttered space above the head (sky or a pale wall) where the headline can sit. Never a wide shot with a small figure at the end of a street or under a big empty sky, never a figure placed low in the frame: the headline is drawn on the photograph and must never cross the face. Say the framing in the brief.',
  'A PAIN headline shows the UK moment and the frame says UK without words: grey morning light through a sash or UPVC window, a cramped surgery or reception with the 8am phones, lever-arch folders on a desk, a kitchen table at night, a wet high street; the GP is tired or hemmed in. An AFTER headline shows the Australian moment and the frame says Australia without a landmark; the GP is unhurried and at ease.',
  'CHOOSE THE SETTING FROM THE DATA, never by habit. DPA (Distribution Priority Area) is a Medicare shortage classification, not rural: gp_link_ecosystem.demand.settings and where_examples say how many open roles are outer_metro (suburbs of Perth, Melbourne, Brisbane, Adelaide, Canberra and Sydney\'s fringe), regional_city (Newcastle, Gold Coast, Toowoomba, Bunbury and the like) and regional_town (country towns and remote), and every past ad carries image_setting with its bookings, so you can see which settings have booked. Pick each ad\'s setting to match that mix and that evidence, vary the settings across a set rather than making every ad the bush, and name the setting and the data behind it in why_strong. Outer-metro cues: a brick or weatherboard practice on a wide quiet suburban street with gum trees and a Colorbond fence, a jacaranda or bottlebrush in flower, a shopping-strip medical centre under a veranda awning, a modern medical centre with a car park, all in hard bright sun under a wide blue sky. Regional-city and coastal cues: a main street with awnings and Norfolk pines, a bright surf-town practice, a river or harbour town. Regional-town cues: a single-storey practice with a tin roof and a veranda, dry grass or red earth, a ute, a quiet main street, eucalyptus. Put at least two cues in every Australian image so the country is obvious at a glance, and only say "regional" in the copy when the roles are. No postcards: no Opera House, Harbour Bridge or city skyline, no koala or kangaroo as the subject and nothing posed with an animal; a magpie on a fence post or kangaroos far off at the paddock edge is fine as a background detail. No beaches as holiday scenes, no barbecues: lifestyle concepts produced no leads four times.',
  'The same kind of GP in the UK frame and the Australian frame reads as one person\'s choice, which is the before-and-after that works. Winning briefs look like: "A UK GP, 40s, in a grey jumper, leaning over a cluttered reception desk at 7:55am, two receptionists on headsets beside her, grey light from the window, a wall screen full of the morning list; she is pressing her lips together, eyes on the screen, not the camera; documentary, 35mm." and "The same GP in a pale blue shirt walking out of a single-storey brick practice with a tin roof in regional NSW at 8am, coffee in hand, satchel over the shoulder, eucalyptus and a wide blue sky behind, hard clean sunlight, at ease, eyes on the car park, not the camera; documentary, 35mm."'
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
    image_headline: { type: 'string', description: 'The line drawn on the image. Profession jargon, under 45 characters. A | marks where the line breaks on the image, if a particular break matters.' },
    image_sub: { type: 'string', description: 'The sub-line under it, under 90 characters.' },
    headline: { type: 'string', description: 'Ads Manager headline, usually the same as image_headline.' },
    primary_text: { type: 'string', description: 'Three short paragraphs separated by blank lines, ending with "Completely free for doctors."' },
    description: { type: 'string', description: 'Ads Manager description, under 40 characters, e.g. "UK-trained GPs. Free 30-minute call."' },
    image_prompt: { type: 'string', description: 'The photograph brief: ONE GP in the exact moment the headline names (who, doing what, expression, where, light, 35mm lens), with the UK or Australian cues that make the place obvious at a glance. No text, no logos, no one looking at the camera. Never an empty room. Never mention an aspect ratio, format or frame; the photograph fills the frame.' },
    rationale: { type: 'string', description: 'Why this ad, in one or two sentences, citing the improvements it applies.' },
    why_strong: { type: 'array', items: { type: 'string' }, description: 'Two to four reasons this is a strong ad to run, each resting on a number or pattern from the evidence given: the headline mechanism it builds on and how that ad booked (leads, bookings, cost per booking), what it avoids and what that cost, the objection from the calls it answers. The last item names the 7-day result that would prove it. One sentence each, plain English, no reason without evidence.' },
    improvements_applied: { type: 'array', items: { type: 'string' }, description: 'Ids of the improvements this ad applies, e.g. ["imp-1","imp-3"].' }
  },
  required: ['angle', 'image_headline', 'image_sub', 'headline', 'primary_text', 'description', 'image_prompt', 'rationale', 'why_strong', 'improvements_applied']
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
          where: { type: 'string', enum: ['ads_manager', 'this_page', 'automation', 'follow_up', 'none'], description: 'automation = a change to Hazel, the chase sequence or the booking flow; follow_up = only for something no automation covers.' },
          improvement_id: { type: 'string', description: 'The id of the improvement this action carries out, e.g. "imp-3", or "" when it stands alone. A point that is both an improvement and an action is listed once in improvements and once here WITH its id, never as two unrelated entries.' }
        },
        required: ['action', 'why', 'where', 'improvement_id']
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
          applies_to: { type: 'string', enum: ['headline', 'image', 'primary_text', 'cta', 'angle', 'format', 'budget', 'targeting', 'automation', 'follow_up'] },
          priority: { type: 'integer', description: '1 (do first) to 3 (nice to have).' }
        },
        required: ['id', 'title', 'evidence', 'change', 'applies_to', 'priority']
      }
    },
    account_changes: {
      type: 'array',
      description: 'At most 8 changes to make on the Meta account right now, most important first. The owner ticks them and the app applies them through the API at once, so each must be exact and safe to run as written. Empty when nothing should change today.',
      items: adsActions.CHANGE_SCHEMA
    },
    automation_changes: {
      type: 'array',
      description: 'At most 6 changes to the app\'s own automation (Hazel\'s calling rules, the chase sequence, the no-show sweep), each naming one lever from the AUTOMATION LEVERS list in the prompt and its new value inside the allowed range. The owner ticks them and the app changes its settings at once. Empty when nothing should change today.',
      items: automationActions.CHANGE_SCHEMA
    },
    what_works: {
      type: 'array',
      description: 'At most 6 patterns behind the ads that book, most important first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: 'The mechanism, specific enough to copy (e.g. "profession jargon + after-led body + sunny Australian practice photo").' },
          evidence: { type: 'string' },
          ad_ids: { type: 'array', items: { type: 'string' } }
        },
        required: ['pattern', 'evidence', 'ad_ids']
      }
    },
    what_doesnt: {
      type: 'array',
      description: 'At most 6 patterns that spend without booking.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string' },
          evidence: { type: 'string' },
          ad_ids: { type: 'array', items: { type: 'string' } }
        },
        required: ['pattern', 'evidence', 'ad_ids']
      }
    },
    new_ad_briefs: {
      type: 'array',
      description: 'Two to four new ads that apply the improvements and the what_works patterns. Each one that should go live today also gets a create_ad entry in account_changes (target_id = its angle).',
      items: BRIEF_SCHEMA
    }
  },
  required: ['headline', 'summary', 'actions_today', 'ad_verdicts', 'improvements', 'account_changes', 'automation_changes', 'what_works', 'what_doesnt', 'new_ad_briefs']
};

// The finished creative, judged with the picture in front of the model
// (2026-11-06, owner: "the AI should consider the actual creative"). Verdict
// plus what it shows, strengths, weaknesses and fixes; shown on the card
// under "Why it should run" and above the approval gate.
const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['run', 'fix_first'], description: 'run = publish it as it is; fix_first = change something before it runs.' },
    what_it_shows: { type: 'string', description: 'One sentence: who is in the picture, doing what, where (name the setting: outer-metro suburb, regional city, regional town, or the UK moment), and how the headline sits on it.' },
    strengths: { type: 'array', items: { type: 'string' }, description: 'Up to 4, each tied to evidence: a pattern that booked, the role mix, a house rule honoured.' },
    weaknesses: { type: 'array', items: { type: 'string' }, description: 'Up to 4, each something visible in the creative or wrong against the evidence: a setting that does not match where the roles are, no GP in frame, eyes to the lens, gibberish text or a badge, artefacts (hands, limbs, reflections), the headline hard to read, the crop cutting the face, a cliche that has not booked, copy that claims something not allowed.' },
    fixes: { type: 'array', items: { type: 'string' }, description: 'Up to 3 concrete fixes the owner can make on the card: a one-line new photo brief, headline at the top or the foot, crop focus left or right, a copy change.' }
  },
  required: ['verdict', 'what_it_shows', 'strengths', 'weaknesses', 'fixes']
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
    why_strong: { type: 'array', items: { type: 'string' }, description: 'The reasons this ad should run (two to four, each resting on evidence). Revise them only when the instruction asks, or when a change you made makes a cited reason untrue (for example the headline became after-led, so the pain-ad evidence no longer applies); otherwise return them unchanged.' },
    headline_placement: { type: 'string', enum: ['top', 'bottom'], description: 'Where the headline sits on the image: top (over sky or a light wall) or bottom (over a dark fade). Return the current value unless the instruction asks to move it.' },
    crop_focus: { type: 'number', description: 'Where the photograph is centred when it is cropped, 0 = far left, 0.5 = centre, 1 = far right. Return the current value unless the instruction asks to shift the crop.' },
    new_photo: { type: 'boolean', description: 'true when the owner asks for a different photograph, or when you changed image_prompt materially; the app then generates a new photo from image_prompt. false otherwise.' },
    change_note: { type: 'string', description: 'One sentence saying what was changed and why.' }
  },
  required: ['angle', 'image_headline', 'image_sub', 'headline', 'primary_text', 'description', 'image_prompt', 'why_strong', 'headline_placement', 'crop_focus', 'new_photo', 'change_note']
};

// The judge's points, ticked on the card and fixed in one pass (2026-11-08,
// owner: pasting the fixes into "Ask the model" did not properly fix them).
// The same answer as a rewrite, plus one line per ticked point naming the
// lever that fixed it, so the card can say what happened to each tick.
const FIX_LEVERS = ['new_photo', 'copy', 'layout', 'cannot'];
const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: Object.assign({}, ITERATE_SCHEMA.properties, {
    points_done: {
      type: 'array',
      description: 'One entry per ticked point, in the order given.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string', description: 'The ticked point, in a few words.' },
          lever: { type: 'string', enum: FIX_LEVERS, description: 'new_photo = a new photograph from the rewritten image_prompt; copy = the words changed; layout = headline_placement or crop_focus changed; cannot = nothing on this card reaches it.' },
          done: { type: 'string', description: 'One sentence: exactly what was changed to fix it, or, for cannot, why and what the owner can do instead.' }
        },
        required: ['point', 'lever', 'done']
      }
    }
  }),
  required: ITERATE_SCHEMA.required.concat(['points_done'])
};

// The ticked points as the card sends them: { kind: weakness|fix, text }.
// Anything else is dropped; at most 8, each at most 400 characters.
function fixPoints(list) {
  return (Array.isArray(list) ? list : []).map(function (p) {
    const x = typeof p === 'string' ? { text: p } : (p || {});
    return { kind: x.kind === 'weakness' ? 'weakness' : 'fix', text: str(x.text, 400) };
  }).filter(function (p) { return p.text; }).slice(0, 8);
}

// What the card can change, so each fix lands on the lever that reaches it.
// The composer (js/ceo-ads-drafts.js draw()) is fixed: colours and the fade
// cannot be chosen, only the placement, the crop, the words and the photo.
const FIX_LEVERS_NOTE = [
  'THE LEVERS, and which one each point needs. Everything this card can do is one of these four; pick the one that actually reaches the point, never a weaker one.',
  '(1) THE PHOTOGRAPH. Anything that is IN the picture can only change with a NEW photograph: clothes (scrubs, a white coat, a lanyard or badge), where the eyes look, the setting and its cues (nothing says Australia, a street that could be the US), a band of gibberish text or white padding at an edge, artefacts (hands, limbs, reflections, lettering), the wrong moment, nobody in frame. A crop cannot remove any of it and the composer cannot paint over it. Rewrite image_prompt so the brief names each fix explicitly and says it twice in different words (for example "a pale blue cotton shirt, never scrubs or a white coat"; "eyes on the car park, not the camera"; "the photograph fills the frame edge to edge: no border, no band, no text anywhere"), keep the rest of the brief, and set new_photo to true. Fold every photograph point into that ONE brief so one new photo fixes all of them.',
  '(2) THE TYPE. The composer draws the words in fixed colours. headline_placement "top" puts a navy headline and a blue sub-line at the top left, over the photograph with no fade, so it needs a plain light area there (sky or a pale wall). "bottom" puts a white headline and a pale blue sub-line over a dark fade across the lower part of the picture, which reads on any photograph. No other colour or position exists, so a sub-line that is hard to read on the sky is fixed by "bottom" (or by a new photograph with a plainer sky), never by asking for white or navy type. crop_focus 0 to 1 slides the crop (left to right on a landscape photograph, top to bottom on a portrait one) when the face or the headline area is cut or crowded. Shorter words set larger; a | in image_headline forces the line break.',
  '(3) THE COPY. A point about the words (a rule break, a claim that is not allowed, a weak or wrong line, the closer missing) is a change to that field, keeping every creative rule.',
  '(4) CANNOT. Only when no lever reaches the point: say so in points_done and what the owner can do instead.',
  'Change only what the ticked points need and keep everything else word for word. Fill points_done with one entry per ticked point, in order.'
].join('\n');

// What the photograph of each pre-app ad showed, so the model can tie a
// setting to the bookings it produced. Ads launched from this page carry
// their own image_prompt (passed in as imageSettings by meta ad id).
const KNOWN_IMAGE_SETTINGS = [
  { match: /ten minutes/i, setting: 'UK pain: a GP at her desk in a cramped consulting room looking up at the clock, grey window light.' },
  { match: /dark in/i, setting: 'UK pain: a GP leaving a brick surgery across a rain-soaked car park at night under sodium lights.' },
  { match: /locum drought|you cct/i, setting: 'UK pain: a GP at a kitchen table at night with a laptop and a phone.' },
  { match: /cqc inspection|02-cqc/i, setting: 'UK pain: a GP at a desk at night, head in hand, lever-arch folders and a sticky-note planner.' },
  { match: /paid on your billings|sessional rate/i, setting: 'UK pain: a couple at the kitchen table at night over a laptop and a calculator.' },
  { match: /^ad3\b|the way you meant to do it/i, setting: 'Australian after: a GP mid-stride with a coffee and a satchel outside a sunny single-storey brick practice, eucalyptus, blue sky (outer-suburban or regional, could be either).' },
  { match: /no-qof.*split|no qof.*split/i, setting: 'Split: a UK reception at 7:55am above, the same GP walking into a sunny Australian practice reception below.' },
  { match: /no-qof|no qof/i, setting: 'UK pain: a GP leaning over a busy reception desk at 7:55am, receptionists on headsets, grey light.' },
  { match: /03-econsults|ninety econsults/i, setting: 'UK pain: a GP at a screen in a UK surgery with the eConsult queue.' },
  { match: /04-appraisal|appraisal season/i, setting: 'UK pain: a GP at a kitchen table at night with the appraisal portfolio.' }
];
function knownImageSetting(name, headline) {
  const hay = String(name || '') + ' | ' + String(headline || '');
  const hit = KNOWN_IMAGE_SETTINGS.find(function (k) { return k.match.test(hay); });
  return hit ? hit.setting : null;
}
function imageSettingFor(ad, settings) {
  const a = ad || {};
  const fromDraft = settings && settings[String(a.id)];
  if (fromDraft) return 'Launched from this page: ' + String(fromDraft).slice(0, 300);
  return knownImageSetting(a.name, a.creative && a.creative.headline);
}

// ── trimming the snapshot for the prompt ───────────────────────────────────
function short(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function compactAd(ad, settings) {
  const a = ad || {};
  const c = a.creative || {};
  return {
    ad_id: a.id,
    name: a.name,
    image_setting: imageSettingFor(a, settings),
    // OFF_BY_SCHEDULE: the ad set is switched off right now by the owner's
    // time rule; the ad is in rotation and comes back with it.
    status: a.rotation === 'scheduled_off' ? 'OFF_BY_SCHEDULE' : a.effective_status,
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
    // What happened after the form, per ad: Hazel reached, booked, attended,
    // signed up, with cost per booking / attended / sign-up.
    after_the_lead_7d: a.deep && a.deep.d7,
    after_the_lead_30d: a.deep && a.deep.d30,
    flags: (a.flags || []).map(function (f) { return f.label; })
  };
}

// Same meaning as lib/meta-ads rotationOf/inRotation, kept local so this
// module stays free of the Graph client.
function inRotation(a) {
  const r = (a && a.rotation) || (a && a.effective_status === 'ACTIVE' ? 'live' : 'other');
  return r === 'live' || r === 'scheduled_off';
}

function clockIn(iso, tz) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  } catch (e) { return new Date(t).toISOString(); }
}

// One paragraph for the model when a time rule runs the ad set, so a 21:30 UTC
// review does not read "every ad paused" and tell the owner to switch them on.
function timeRulesNote(schedule) {
  const sc = schedule;
  if (!sc || !sc.managed) return '';
  const name = sc.adset_name || sc.adset_id || 'the ad set';
  const state = sc.state === 'off' ? 'switched OFF right now' : sc.state === 'on' ? 'switched ON right now' : 'paused by hand right now';
  const bits = [];
  if (sc.off_rule) bits.push('"' + sc.off_rule.name + '" switches it off' + (sc.off_rule.at ? ' next at ' + clockIn(sc.off_rule.at, 'Europe/London') + ' UK time' : ''));
  if (sc.on_rule) bits.push('"' + sc.on_rule.name + '" switches it on' + (sc.on_rule.at ? ' next at ' + clockIn(sc.on_rule.at, 'Europe/London') + ' UK time' : ''));
  return 'TIME RULES: the ad set "' + name + '" is run by automated rules on a daily clock and is ' + state +
    (bits.length ? ' (' + bits.join('; ') + ')' : '') + '. Ads listed under live_ads with status OFF_BY_SCHEDULE are in rotation: they deliver whenever the ad set is on, so treat them as live ads, never call them paused and never advise switching them on. A rule only changes the ad set it targets; an ad the owner has paused stays paused through the rule.' +
    (sc.state === 'paused' && sc.on_rule ? ' This ad set was paused by hand while the clock says on, and "' + sc.on_rule.name + '" will switch it back on at the next firing: say so.' : '');
}

function compactSnapshot(snapshot, imageSettings) {
  const s = snapshot || {};
  const ads = Array.isArray(s.ads) ? s.ads : [];
  const compact = function (a) { return compactAd(a, imageSettings); };
  return {
    fetched_at: s.fetched_at,
    time_zone: s.account && s.account.time_zone,
    currency: s.account && s.account.currency,
    ad_sets: (s.adsets || []).map(function (x) {
      return { id: x.id, name: x.name, status: x.effective_status, rotation: x.rotation || (x.effective_status === 'ACTIVE' ? 'live' : 'paused'), daily_budget: x.daily_budget, goal: x.optimization_goal, learning: x.learning };
    }),
    time_rules: s.schedule && s.schedule.managed ? s.schedule : null,
    totals: s.totals,
    app_funnel: s.funnel,
    app_funnel_unattributed: s.funnel_unattributed,
    daily_last_14_days: s.daily,
    // live_ads = in rotation (delivering, or off for the night by the clock);
    // paused_ads = everything a rule will not bring back.
    live_ads: ads.filter(inRotation).map(compact),
    paused_ads: ads.filter(function (a) { return !inRotation(a); }).map(function (a) {
      const c = compact(a);
      delete c.primary_text;
      delete c.yesterday;
      return c;
    }),
    data_problems: s.errors,
    // The rest of GP Link: what runs automatically after every lead, how
    // Hazel's calls and the chase sequence are going, what leads say, what the
    // consults reveal, what jobs there are to fill, and the organic schedule.
    gp_link_ecosystem: s.ecosystem || null
  };
}

// ── prompts ────────────────────────────────────────────────────────────────
const REVIEW_SYSTEM = [
  'You are the head of marketing for GP Link, reviewing the Meta campaign every morning for the owner, who is not an ads specialist. Write in plain English, short sentences, no jargon that is not explained, no em dashes. Be direct: say what is working, what is not, and what to do today. Never invent a number; every claim must trace to the data you are given. When the data is thin (few leads), say so and avoid strong verdicts.',
  '',
  'YOU SEE THE WHOLE BUSINESS, NOT JUST THE ADS. The snapshot carries gp_link_ecosystem: what the app does automatically after every lead (automation), how Hazel the AI phone agent is doing (hazel), how the WhatsApp/email chase is doing (nudges), the full funnel per ad after the form (after_the_lead_*: reached by Hazel, booked, attended the consultation, signed up), what leads say on the phone (voice_of_lead: objections, timeframes, unanswered questions), what the consultations reveal (consult_themes: the newest recaps; gp_questions: every past consultation analysed, what GPs ask about by theme with counts and the questions in their words), the jobs waiting to be filled (demand) and the organic posting schedule (organic). Use all of it.',
  '',
  'RULES THAT COME FROM THE ECOSYSTEM. (1) Never tell the owner to call, message or email leads by hand: Hazel rings every qualified lead within minutes, the chase sequence follows, and the owner is paged automatically when a lead has not booked. If the follow-up numbers show a weakness (for example Hazel mostly reaching voicemail, few replies, bookings arriving slowly), say exactly what to change in that automation and file it under where: "automation": its timing, retry rule, calling hours, channel, or a fact Hazel should have to hand. Never write Hazel\'s lines for her: no scripted opening, no fixed order of questions, no "offer two named slots", no canned answer to an objection. Hazel holds a natural conversation and the owner has rejected scripts because they make the call sound like a machine; if the calls themselves are the weakness, name the outcome that is missing (for example callbacks that never turn into a booking) and leave the words to her. (2) A lead is only worth what happens after it. Judge ads on booked, attended and signed-up per ad, and on cost per booking, before cost per lead or CTR. A cheap lead that never books is a bad lead. (3) Use voice_of_lead, consult_themes and gp_questions as the reason behind the numbers: if leads object on timing or money, or the consultations keep coming back to visas, registration, income or family, that is the brief for the next copy. (4) Use demand so copy points doctors at the places and practice types that actually have roles. (5) If the organic schedule is empty while ads run, say so once.',
  '',
  'How to judge: cost per BOOKING outranks cost per lead; cost per lead outranks CTR. Apply the owner\'s rotation rule literally for pause verdicts. Treat an ad under 7 days old as settling unless it is already clearly wasting money. Compare against the previous week from the daily series and against the account\'s evidence below.',
  '',
  'WHAT WORKS AND WHY. Fill what_works with the patterns behind the ads that book (the headline mechanism, the angle, the image, the offer line), each with the ads and numbers that prove it, and what_doesnt with the patterns that spend without booking. These two lists steer every new ad written from this page, so be specific enough to copy.',
  '',
  'Improvements must be concrete and testable in the NEXT ads (a headline mechanism, an image direction, a copy structure, a CTA, a format) or in the automation, each with the evidence it rests on. New ad briefs must follow every creative rule below; the image_headline must self-select a GP with profession-only jargon. When an action in actions_today carries out one of your improvements, set its improvement_id to that improvement\'s id; never repeat the same point as a second, unrelated entry in either list.',
  '',
  PHOTO_DIRECTION,
  '',
  'CHANGES YOU CAN MAKE DIRECTLY. account_changes is the list of changes to the Meta account itself. The owner ticks the ones to make and the app applies them through the API at once, so every entry must be exact and safe to run as written: the action, the exact id from the data (ad_id for an ad, the ad set id for an ad set, draft_id for a draft) and, for a budget, the new daily figure. Put every change the rotation rule or the numbers call for here: pause an ad that fails the rule, resume one worth another go, launch a draft that is ready (listed under DRAFTS READY TO LAUNCH; never a draft that is not listed), write and launch a NEW ad (put the complete ad in new_ad_briefs AND add a create_ad change whose target_id is that brief\'s angle: the app writes the draft, generates the photograph, composes the creative and launches it), pause or resume an ad set, raise or lower an ad set\'s daily budget (never more than double in one step). When the fix is fresh creative, a proven angle on a new image, or a replacement for an ad you are pausing, that is a create_ad change, not just a brief. Order them so that after all of them at least three ads are live, counting launches and new ads as live. Do not propose pausing an ad under 7 days old unless it is clearly wasting money. If nothing should change today, return an empty list. Anything the API cannot do (lead form questions, targeting, placements, new ad sets) goes in actions_today with where: ads_manager, not here, and an account change is not repeated in actions_today.',
  '',
  'CHANGES TO THE APP\'S OWN AUTOMATION. automation_changes is the list of changes to Hazel\'s calling rules, the chase sequence and the no-show sweep that the app makes itself when the owner ticks them. The prompt lists the AUTOMATION LEVERS with their current values and allowed ranges: propose a change ONLY by naming a lever key and its new value, with the numbers that justify it (for example most calls unanswered → hazel.max_attempts 3 and hazel.vary_retry_time true; leads arriving at night and ringing late → hazel.weekday_start 07:30; a missed call leaving the lead with nothing → hazel.text_after_missed_call true). There is no lever for Hazel\'s words, so never propose a script. Anything about the automation that no lever reaches (a new kind of message, a tracking gap, a code fix) goes in actions_today with where: "automation" as a to-do, and a change made in automation_changes is not repeated in actions_today or improvements.',
  '',
  'ACCOUNT CONTEXT',
  HOUSE_CONTEXT
].join('\n');

function buildReviewMessages(input) {
  const i = input || {};
  const today = i.today || new Date().toISOString().slice(0, 10);
  const parts = [
    'Today is ' + today + ' (' + ((i.snapshot && i.snapshot.account && i.snapshot.account.time_zone) || 'Australia/Melbourne') + ').',
    'Here is the campaign snapshot: Meta metrics per ad for yesterday, the last 7 days and the last 30 days; the app\'s own funnel per ad (leads received by the app, qualified GPs, booked calls, sign-ups) for 7 and 30 days; the 14-day daily series; and any data problems.'
  ];
  const rulesNote = timeRulesNote(i.snapshot && i.snapshot.schedule);
  if (rulesNote) parts.push(rulesNote);
  parts.push('', JSON.stringify(compactSnapshot(i.snapshot, i.imageSettings)));
  if (i.previousReview && i.previousReview.improvements && i.previousReview.improvements.length) {
    parts.push('', 'Yesterday\'s improvements, for continuity (keep an id if the same point still stands, retire it if the data no longer supports it):',
      JSON.stringify(i.previousReview.improvements.map(function (x) { return { id: x.id, title: x.title, change: x.change }; })));
  }
  const drafts = Array.isArray(i.drafts) ? i.drafts.filter(Boolean) : [];
  if (drafts.length) {
    parts.push('', 'DRAFTS READY TO LAUNCH FROM THIS PAGE (complete ads with a composed creative; propose launch_draft with the draft_id when one should go live):',
      JSON.stringify(drafts.map(function (d) { return { draft_id: d.draft_id || d.id, angle: d.angle, headline: d.headline, status: d.status, adset_id: d.adset_id }; })));
  } else {
    parts.push('', 'No drafts are ready to launch from this page today, so do not propose launch_draft.');
  }
  if (i.automation && typeof i.automation === 'object') {
    parts.push('', 'AUTOMATION LEVERS (what the app\'s own automation is set to now, and the range each may take; propose a change in automation_changes by lever key and new value, with the numbers behind it):',
      JSON.stringify(automationActions.leversForPrompt(i.automation)));
  }
  parts.push('', 'Return the review as JSON matching the schema.');
  return { system: REVIEW_SYSTEM, user: parts.join('\n') };
}

const BRIEF_SYSTEM = [
  'You write Meta lead ads for GP Link. Every ad must follow the creative rules exactly; a rule break makes the ad unusable. Plain English, short sentences, UK spelling, no em dashes (use a full stop or comma instead), no salary figures, no testimonials, no guarantees, no named doctors, no placement counts, no promised timelines, no claims about the owner\'s business size.',
  '',
  'ANALYSE BEFORE YOU WRITE. You are given every ad the account has run with its results, and gp_questions: every past consultation analysed, what GPs ask about by theme with counts and the questions in their words. Work out, from the numbers: which headline mechanisms turned leads into booked and attended consultations and at what cost per booking; which spent without booking and why (a generic claim, a worn image, a weak click-to-lead rate, a high frequency); what the photograph and the copy structure of the winners have in common; what leads object to on the phone; and what GPs most often want answered in the consultation (the ad that speaks to the top themes, truthfully and within the claims allowed, is the ad that books). Build every new ad on a pattern with a number behind it and steer it away from the ones that lost money. why_strong is that case for the ad, in the owner\'s language, each reason citing the figure, pattern or consultation theme it rests on; a reason without evidence is not a reason. When the data is thin, say so in why_strong rather than overclaiming. One of the reasons always names the photograph\'s setting (outer-metro suburb, regional city, regional town, or the UK moment) and the role data or past image that justifies it.',
  '',
  'Structure of primary_text: three short paragraphs separated by a blank line. Paragraph 1: the UK pain, in the GP\'s own vocabulary, concrete and specific (a time, a document, a screen). Paragraph 2: how Australian general practice runs differently on that exact point, hedged with "most" where it is not universal. Paragraph 3, always this shape: "If you\'re UK-trained there\'s a recognised route to practising in Australia, and we handle the whole thing: AHPRA, the visa, English requirements, and finding you the right practice. Book a free 30-minute call. Completely free for doctors."',
  '',
  'image_headline: profession-only jargon that only a GP recognises, under 45 characters, no exclamation marks. image_sub: one calm line under 90 characters that names Australia and UK-trained GPs. headline: same as image_headline. description: under 40 characters.',
  '',
  PHOTO_DIRECTION,
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
  if (i.review && Array.isArray(i.review.what_works) && i.review.what_works.length) {
    parts.push('', 'WHAT WORKS IN THIS ACCOUNT (build on these; each new ad must name the pattern it uses in its rationale)', JSON.stringify(i.review.what_works));
  }
  if (i.review && Array.isArray(i.review.what_doesnt) && i.review.what_doesnt.length) {
    parts.push('', 'WHAT DOES NOT WORK (avoid)', JSON.stringify(i.review.what_doesnt));
  }
  const eco = i.snapshot && i.snapshot.ecosystem;
  if (eco) {
    parts.push('', 'WHAT LEADS SAY ON THE PHONE AND IN CONSULTATIONS (write to these objections and questions where relevant, truthfully)',
      JSON.stringify({ voice_of_lead: eco.voice_of_lead, consult_themes: (eco.consult_themes || []).map(function (t) { return t.recap; }), demand: eco.demand, funnel_30d: eco.funnel_30d }));
    if (eco.gp_questions && eco.gp_questions.consults) {
      parts.push('', 'WHAT GPS ASK ABOUT IN CONSULTATIONS (' + eco.gp_questions.consults + ' consultations analysed since ' + (eco.gp_questions.since || 'the start') + '; the most common themes first; cite a theme in why_strong when an ad answers it)',
        JSON.stringify(eco.gp_questions));
    }
  }
  if (i.instructions) parts.push('', 'OWNER\'S INSTRUCTIONS (take precedence over everything except the creative rules)', String(i.instructions));
  const allAds = (i.snapshot && i.snapshot.ads) || [];
  const live = allAds.filter(inRotation);
  if (live.length) {
    parts.push('', 'LIVE ADS (do not duplicate these headlines; learn from what books)',
      JSON.stringify(live.map(function (a) {
        return { headline: a.creative && a.creative.headline, image_setting: imageSettingFor(a, i.imageSettings), leads_7d: a.metrics && a.metrics.last_7d && a.metrics.last_7d.leads, booked_30d: a.funnel && a.funnel.d30 && a.funnel.d30.booked, cost_per_lead_7d: a.metrics && a.metrics.last_7d && a.metrics.last_7d.cost_per_lead };
      })));
  }
  // Every ad that has had a lead, with what its photograph showed, so the
  // setting of the next photograph is chosen from evidence.
  const history = creativeHistory(i.snapshot, i.imageSettings);
  if (history.length) parts.push('', 'CREATIVE HISTORY (what each photograph showed, and what it booked; choose the next setting from this and from demand.settings)', JSON.stringify(history));
  const results = adResultsForBrief(i.snapshot, i.review);
  if (results.length) {
    parts.push('', 'EVERY AD AND ITS RESULTS, 30 DAYS (live and paused; analyse these before writing, and cite them in why_strong)',
      JSON.stringify(results));
  }
  const existing = Array.isArray(i.existingDrafts) ? i.existingDrafts : [];
  if (existing.length) {
    parts.push('', 'DRAFTS ALREADY ON THE PAGE (do not repeat these angles)',
      JSON.stringify(existing.map(function (d) { return { angle: d.angle, headline: d.headline }; })));
  }
  parts.push('', 'Return JSON matching the schema.');
  return { system: BRIEF_SYSTEM, user: parts.join('\n') };
}

// Every ad that has spent or produced a lead in 30 days, live or paused, with
// what came of it: the evidence the brief's why_strong has to rest on.
function adResultsForBrief(snapshot, review) {
  const ads = (snapshot && Array.isArray(snapshot.ads)) ? snapshot.ads : [];
  const verdicts = {};
  ((review && review.ad_verdicts) || []).forEach(function (v) { if (v && v.ad_id) verdicts[String(v.ad_id)] = v; });
  return ads.filter(function (a) {
    const m = (a.metrics && a.metrics.last_30d) || {};
    const f = (a.funnel && a.funnel.d30) || {};
    return (Number(m.spend) || 0) > 0 || (Number(m.leads) || 0) > 0 || (Number(f.leads) || 0) > 0;
  }).map(function (a) {
    const c = a.creative || {};
    const m7 = (a.metrics && a.metrics.last_7d) || {};
    const m30 = (a.metrics && a.metrics.last_30d) || {};
    const f30 = (a.funnel && a.funnel.d30) || {};
    const deep = (a.deep && a.deep.d30) || {};
    const v = verdicts[String(a.id)];
    const row = {
      name: a.name,
      headline: c.headline,
      first_line: short(String(c.primary_text || '').split(/\n/)[0], 140),
      status: a.rotation === 'scheduled_off' ? 'OFF_BY_SCHEDULE' : a.effective_status,
      days_live: a.days_live,
      spend_30d: m30.spend, leads_30d: m30.leads, cost_per_lead_30d: m30.cost_per_lead,
      link_clicks_30d: m30.link_clicks, click_to_lead_pct_30d: m30.click_to_lead_pct, frequency_7d: m7.frequency,
      booked_30d: f30.booked, signed_up_30d: f30.signed_up, cost_per_booking_30d: f30.cost_per_booking
    };
    if (deep.attended !== undefined) { row.attended_30d = deep.attended; row.cost_per_attended_30d = deep.cost_per_attended; }
    if (v) row.review_verdict = { verdict: v.verdict, reason: v.reason };
    const flags = (a.flags || []).map(function (f) { return f.label; });
    if (flags.length) row.flags = flags;
    return row;
  });
}

// Every ad that has had a lead, with what its photograph showed, so a setting
// can be chosen (or judged) from evidence. Used by the brief prompt and the
// creative critique.
function creativeHistory(snapshot, imageSettings) {
  const allAds = (snapshot && snapshot.ads) || [];
  return allAds.filter(function (a) { return a.funnel && a.funnel.d30 && Number(a.funnel.d30.leads) > 0; }).map(function (a) {
    const f = a.funnel.d30;
    return { name: a.name, headline: a.creative && a.creative.headline, image_setting: imageSettingFor(a, imageSettings), leads_30d: f.leads, booked_30d: f.booked, cost_per_booking_30d: f.cost_per_booking };
  });
}

const CRITIQUE_SYSTEM = [
  'You judge a finished Meta ad creative for GP Link before the owner approves it. You are shown the composed 1080x1350 image (the photograph with the headline and sub-line drawn on it) together with the ad copy, where the open roles are, and what past creatives booked. Plain English, short sentences, no em dashes, UK spelling. Be specific about what you can SEE: say what is in the picture, not what the brief asked for.',
  '',
  'Judge, in this order: (1) Is there one GP, in the moment the headline names, face visible, eyes off the lens? (2) Does the place read at a glance, and does the setting match where the roles are (demand.settings) and what has booked (creative history)? A UK-pain headline should look like the UK; an after headline should look like Australia in the kind of place the roles are, not a postcard. (3) Artefacts: gibberish lettering, a badge or lanyard with nonsense, odd hands, extra limbs, a reflection that gives the game away, a white coat or scrubs. (4) Type: is the headline readable over the photo, does the crop cut the face, would the top or the foot placement work better? (5) Copy against the rules below: no figures, no testimonials, no guarantees, no named doctors, no promised timelines, "Completely free for doctors." as the closer. (6) Would a UK GP scrolling Facebook stop? Verdict run only when nothing in 1 to 5 needs fixing.',
  '',
  PHOTO_DIRECTION,
  '',
  'ACCOUNT CONTEXT',
  HOUSE_CONTEXT
].join('\n');

function buildCritiqueMessages(input) {
  const i = input || {};
  const d = i.draft || {};
  const review = i.review || {};
  const eco = i.snapshot && i.snapshot.ecosystem;
  const parts = [
    'THE AD (the composed creative is attached as the image)',
    JSON.stringify({ angle: d.angle, image_headline: d.image_headline, image_sub: d.image_sub, headline: d.headline, primary_text: d.primary_text, description: d.description, photo_brief: d.image_prompt, headline_placement: (d.layout && d.layout.placement) || 'bottom' }),
    '',
    'WHY THE WRITER SAID IT SHOULD RUN',
    JSON.stringify(Array.isArray(d.why_strong) ? d.why_strong : [])
  ];
  if (eco && eco.demand) parts.push('', 'WHERE THE OPEN ROLES ARE (demand)', JSON.stringify(eco.demand));
  const history = creativeHistory(i.snapshot, i.imageSettings);
  if (history.length) parts.push('', 'CREATIVE HISTORY (what each past photograph showed, and what it booked)', JSON.stringify(history));
  if (Array.isArray(review.what_works) && review.what_works.length) parts.push('', 'WHAT WORKS IN THIS ACCOUNT', JSON.stringify(review.what_works));
  if (Array.isArray(review.what_doesnt) && review.what_doesnt.length) parts.push('', 'WHAT DOES NOT WORK', JSON.stringify(review.what_doesnt));
  parts.push('', 'Judge the attached creative. Return JSON matching the schema.');
  return { system: CRITIQUE_SYSTEM, user: parts.join('\n') };
}

function normaliseCritique(obj) {
  const r = obj || {};
  const list = function (v, n) { return (Array.isArray(v) ? v : []).map(function (x) { return str(x, 400); }).filter(Boolean).slice(0, n); };
  return {
    verdict: r.verdict === 'run' ? 'run' : 'fix_first',
    what_it_shows: str(r.what_it_shows, 500),
    strengths: list(r.strengths, 4),
    weaknesses: list(r.weaknesses, 4),
    fixes: list(r.fixes, 3)
  };
}

// One instruction (a rewrite), or the judge's ticked points (a fix pass: the
// levers are spelled out, the judge's verdict comes along, and the composed
// creative is attached as the image when the caller has one).
// The photograph before it is composed (2026-11-08, owner: "the headline is
// drawn straight across her face … she is small and low in the frame"):
// where the GP and the face sit and how big they are, as fractions of the
// image, plus where the plain space for a headline is. The composer reads it
// to choose the headline's zone and the crop, and a generated photograph with
// no GP in it, or a face too small to read, is re-shot once before anyone
// sees it.
const BOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
  required: ['x', 'y', 'w', 'h']
};
const FRAMING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    person: { type: 'boolean', description: 'true when one person is clearly in the picture.' },
    face: Object.assign({}, BOX_SCHEMA, { description: 'The head, hair to chin, as fractions of the whole image: x and y are the top-left corner, w and h the size, each between 0 and 1. All 0 when no face is visible.' }),
    body: Object.assign({}, BOX_SCHEMA, { description: 'The whole visible person, same units. All 0 when nobody is in the picture.' }),
    clear: { type: 'string', enum: ['top', 'bottom', 'both', 'neither'], description: 'Where a headline could sit without crossing the person or clutter: the top third, the bottom third, both, or neither.' },
    top_light: { type: 'boolean', description: 'true when the top third is light and plain (sky, a pale wall), so dark navy type would read on it.' },
    notes: { type: 'string', description: 'One sentence on the framing: how far the person is from the camera, where they sit in the frame, anything cut off.' }
  },
  required: ['person', 'face', 'body', 'clear', 'top_light', 'notes']
};
const FRAMING_SYSTEM = 'You locate the person in a photograph for an ad composer that draws a headline on it. Measure, do not judge: give the head (hair to chin) and the whole visible person as boxes in fractions of the whole image, x and y for the top-left corner, w and h for the size, 0 to 1, and say where plain space for a headline is. Be precise to about two hundredths; the headline is placed from these numbers so that it never crosses the face.';

function buildFramingMessages(input) {
  const i = input || {};
  const d = i.draft || {};
  return {
    system: FRAMING_SYSTEM,
    user: 'Locate the person in the attached photograph' + (d.image_prompt ? ' (the brief asked for: ' + str(d.image_prompt, 300) + ')' : '') + '. Return JSON matching the schema.'
  };
}

function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function normaliseBox(b) {
  const x = clamp01(b && b.x), y = clamp01(b && b.y);
  const w = Math.min(clamp01(b && b.w), 1 - x), h = Math.min(clamp01(b && b.h), 1 - y);
  return (w > 0 && h > 0) ? { x: round3(x), y: round3(y), w: round3(w), h: round3(h) } : null;
}
function normaliseFraming(obj) {
  const r = obj || {};
  const face = normaliseBox(r.face);
  const body = normaliseBox(r.body);
  return {
    person: r.person === true && !!(face || body),
    face: face,
    body: body,
    face_share: face ? face.h : 0,
    clear: ['top', 'bottom', 'both', 'neither'].indexOf(r.clear) !== -1 ? r.clear : 'neither',
    top_light: r.top_light === true,
    notes: str(r.notes, 300)
  };
}

// Nobody there, or a face too small to read: the photograph is re-shot.
const FRAMING_MIN_FACE_SHARE = 0.07;
function framingProblem(f) {
  const fr = f || {};
  if (!fr.person) return 'no GP in the frame';
  if (!fr.face) return 'the face is not visible';
  if (fr.face_share < FRAMING_MIN_FACE_SHARE) return 'the GP is too small in the frame (the face is ' + Math.round(fr.face_share * 100) + '% of the height)';
  return null;
}

async function frameCreativePhoto(opts) {
  const o = opts || {};
  if (!o.imageBase64) return { ok: false, error: 'No photograph to measure.' };
  const m = buildFramingMessages(o);
  const r = await callClaude(Object.assign({}, o, {
    system: m.system, user: m.user, schema: FRAMING_SCHEMA, effort: o.effort || 'low', maxTokens: o.maxTokens || 2000,
    images: [{ data: o.imageBase64, mediaType: o.imageMediaType || 'image/jpeg' }]
  }));
  if (!r.ok) return r;
  if (!r.json) return { ok: false, error: 'The model did not return JSON.', text: r.text, usage: r.usage, model: r.model };
  return { ok: true, framing: normaliseFraming(r.json), usage: r.usage, model: r.model };
}

function buildIterateMessages(input) {
  const i = input || {};
  const d = i.draft || {};
  const points = fixPoints(i.points);
  const lineBreaks = 'Line breaks on the image: image_headline may contain the character | where a line should break on the picture (for example "No appraisal. | No revalidation."). When the owner asks which words sit on which line, that is the change to make. Never put | in headline, which goes to Ads Manager.';
  const parts = points.length ? [
    'Fix the points the owner ticked from the judge\'s verdict on this ad\'s composed creative' + (i.hasImage ? ' (attached as the image: look at it before deciding what each point needs)' : '') + '. Keep every creative rule. Return the complete revised ad.',
    lineBreaks,
    '',
    FIX_LEVERS_NOTE
  ] : [
    'Revise this ad according to the owner\'s instruction. Change only what the instruction needs; keep everything else as it is, word for word. Keep every creative rule. Return the complete revised ad.',
    lineBreaks,
    'Layout and photograph: headline_placement (top or bottom) and crop_focus (0 to 1) are the current layout; change them only when the instruction asks to move the headline or shift the crop. Set new_photo to true when the owner asks for a different, regenerated or re-shot photograph, or when you rewrite image_prompt in a way the current photograph does not match; the app then generates a new photograph from image_prompt.'
  ];
  parts.push('', 'CURRENT AD', JSON.stringify({
    angle: d.angle, image_headline: d.image_headline, image_sub: d.image_sub,
    headline: d.headline, primary_text: d.primary_text, description: d.description, image_prompt: d.image_prompt,
    why_strong: Array.isArray(d.why_strong) ? d.why_strong : [],
    headline_placement: (d.layout && d.layout.placement === 'top') ? 'top' : 'bottom',
    crop_focus: d.layout && Number.isFinite(Number(d.layout.focus)) ? Number(d.layout.focus) : 0.5
  }));
  if (points.length) {
    const cr = i.critique || {};
    if (cr.verdict || cr.what_it_shows) parts.push('', 'THE JUDGE\'S VERDICT ON THE COMPOSED CREATIVE', JSON.stringify({ verdict: cr.verdict, what_it_shows: cr.what_it_shows }));
    parts.push('', 'POINTS TO FIX (ticked by the owner; [weakness] = something the judge saw wrong, work out the fix; [fix] = the judge\'s own suggested fix, apply it through the right lever)',
      points.map(function (p, n) { return (n + 1) + '. [' + p.kind + '] ' + p.text; }).join('\n'));
    if (i.instruction) parts.push('', 'OWNER\'S INSTRUCTION (as well as the points)', String(i.instruction));
  } else {
    parts.push('', 'OWNER\'S INSTRUCTION', String(i.instruction || ''));
  }
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

const APPLIES = ['headline', 'image', 'primary_text', 'cta', 'angle', 'format', 'budget', 'targeting', 'automation', 'follow_up'];
const VERDICTS = ['keep', 'scale', 'watch', 'pause'];
const WHERE = ['ads_manager', 'this_page', 'automation', 'follow_up', 'none'];

function normaliseBrief(b, idx) {
  const x = b || {};
  const angle = String(x.angle || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || ('ad-' + (idx + 1));
  return {
    angle: angle,
    image_headline: str(x.image_headline, 120),
    image_sub: str(x.image_sub, 200),
    // The Ads Manager headline never carries the image's | line-break marker.
    headline: str(String(x.headline || x.image_headline || '').replace(/\s*\|\s*/g, ' '), 255),
    primary_text: str(x.primary_text, 3000),
    description: str(x.description, 255),
    image_prompt: str(x.image_prompt, 1200),
    rationale: str(x.rationale, 600),
    why_strong: (Array.isArray(x.why_strong) ? x.why_strong : []).map(function (s) { return str(s, 300); }).filter(Boolean).slice(0, 5),
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
  const ip = String(x.image_prompt || '');
  if (ip) {
    if (/\bno (people|person|one)\b(?! (facing|looking|to|at|in the lens|into))|\bnobody\b|\bempty (room|desk|office|surgery|consulting|reception|waiting)/i.test(ip)) {
      out.push('image_prompt asks for an empty frame; every ad photograph shows a GP in the moment the headline names.');
    } else if (!/\b(GP|GPs|doctor|physician|clinician|woman|man|she|he|her|his|person|people|nurse|receptionist|colleague)\b/.test(ip)) {
      out.push('image_prompt has no GP in the frame.');
    }
  }
  return out;
}

function patterns(list) {
  return (Array.isArray(list) ? list : []).slice(0, 6).map(function (x) {
    const y = x || {};
    return {
      pattern: str(y.pattern, 300),
      evidence: str(y.evidence, 500),
      ad_ids: (Array.isArray(y.ad_ids) ? y.ad_ids : []).map(function (id) { return str(id, 40); }).filter(Boolean).slice(0, 10)
    };
  }).filter(function (x) { return x.pattern; });
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
      return {
        action: str(y.action, 300), why: str(y.why, 500), where: WHERE.indexOf(y.where) !== -1 ? y.where : 'none',
        // The improvement this action carries out, so the page shows the point once.
        improvement_id: /^imp-\d+[a-z]?$/.test(String(y.improvement_id || '')) ? String(y.improvement_id) : ''
      };
    }).filter(function (x) { return x.action; }),
    ad_verdicts: (Array.isArray(r.ad_verdicts) ? r.ad_verdicts : []).map(function (x) {
      const y = x || {};
      return { ad_id: str(y.ad_id, 40), verdict: VERDICTS.indexOf(y.verdict) !== -1 ? y.verdict : 'watch', reason: str(y.reason, 500) };
    }).filter(function (x) { return x.ad_id; }),
    improvements: imps,
    account_changes: adsActions.linkCreateAds(adsActions.normaliseChanges(r.account_changes), briefs),
    automation_changes: automationActions.normaliseChanges(r.automation_changes),
    what_works: patterns(r.what_works),
    what_doesnt: patterns(r.what_doesnt),
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
      // Images (base64) go in front of the text when the call has any, so the
      // creative critique can look at the composed picture.
      messages: [{ role: 'user', content: Array.isArray(o.images) && o.images.length
        ? o.images.map(function (img) { return { type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: String(img.data || '') } }; }).concat([{ type: 'text', text: String(o.user || '') }])
        : String(o.user || '') }],
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
  const m = buildReviewMessages({ snapshot: o.snapshot, previousReview: o.previousReview, today: o.today, drafts: o.drafts, imageSettings: o.imageSettings, automation: o.automation });
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

// What the model says it did about each ticked point, in the card's shape.
function normalisePointsDone(list, points) {
  return (Array.isArray(list) ? list : []).map(function (x) {
    const y = x || {};
    return { point: str(y.point, 200), lever: FIX_LEVERS.indexOf(y.lever) !== -1 ? y.lever : 'copy', done: str(y.done, 400) };
  }).filter(function (x) { return x.done; }).slice(0, Math.max(points.length, 1));
}

async function iterateDraft(opts) {
  const o = opts || {};
  const points = fixPoints(o.points);
  const m = buildIterateMessages(Object.assign({}, o, { points: points, hasImage: !!(points.length && o.imageBase64) }));
  // A fix pass looks at the composed creative (when there is one) and thinks
  // a little harder than a rewrite: it has to map each point to its lever.
  const call = { system: m.system, user: m.user, schema: points.length ? FIX_SCHEMA : ITERATE_SCHEMA, effort: o.effort || (points.length ? 'medium' : 'low'), images: undefined };
  if (points.length && o.imageBase64) call.images = [{ data: o.imageBase64, mediaType: o.imageMediaType || 'image/jpeg' }];
  const r = await callClaude(Object.assign({}, o, call));
  if (!r.ok) return r;
  if (!r.json) return { ok: false, error: 'The model did not return JSON.', text: r.text, usage: r.usage, model: r.model };
  const revised = normaliseBrief(Object.assign({}, o.draft || {}, r.json), 0);
  // The reasons the ad should run travel with the revision, so a changed
  // headline does not keep citing the old mechanism.
  revised.why_strong = Array.isArray(r.json.why_strong) && r.json.why_strong.length
    ? r.json.why_strong.map(function (x) { return str(x, 400); }).filter(Boolean).slice(0, 5)
    : (o.draft && Array.isArray(o.draft.why_strong) ? o.draft.why_strong : []);
  const focus = Number(r.json.crop_focus);
  const layout = {
    placement: r.json.headline_placement === 'top' ? 'top' : (r.json.headline_placement === 'bottom' ? 'bottom' : undefined),
    focus: Number.isFinite(focus) ? Math.max(0, Math.min(1, Math.round(focus * 100) / 100)) : undefined
  };
  return {
    ok: true,
    revised: revised,
    layout: layout,
    new_photo: r.json.new_photo === true,
    change_note: str(r.json.change_note, 400),
    points_done: points.length ? normalisePointsDone(r.json.points_done, points) : [],
    warnings: briefWarnings(revised),
    usage: r.usage,
    model: r.model
  };
}

// The finished creative, judged with the picture. `imageBase64` is the
// composed JPEG; effort low: it is a look and a verdict, not a plan.
async function critiqueCreative(opts) {
  const o = opts || {};
  if (!o.imageBase64) return { ok: false, error: 'No creative image to judge.' };
  const m = buildCritiqueMessages(o);
  const r = await callClaude(Object.assign({}, o, {
    system: m.system, user: m.user, schema: CRITIQUE_SCHEMA, effort: o.effort || 'low', maxTokens: o.maxTokens || 6000,
    images: [{ data: o.imageBase64, mediaType: o.imageMediaType || 'image/jpeg' }]
  }));
  if (!r.ok) return r;
  if (!r.json) return { ok: false, error: 'The model did not return JSON.', text: r.text, usage: r.usage, model: r.model };
  return { ok: true, critique: normaliseCritique(r.json), usage: r.usage, model: r.model };
}

module.exports = {
  MESSAGES_URL,
  DEFAULT_MODEL,
  HOUSE_CONTEXT,
  PHOTO_DIRECTION,
  BRIEF_SCHEMA,
  REVIEW_SCHEMA,
  BRIEFS_SCHEMA,
  ITERATE_SCHEMA,
  FIX_SCHEMA,
  FIX_LEVERS,
  fixPoints,
  CRITIQUE_SCHEMA,
  CRITIQUE_SYSTEM,
  FRAMING_SCHEMA,
  FRAMING_MIN_FACE_SHARE,
  buildFramingMessages,
  normaliseFraming,
  framingProblem,
  frameCreativePhoto,
  creativeHistory,
  buildCritiqueMessages,
  normaliseCritique,
  critiqueCreative,
  KNOWN_IMAGE_SETTINGS,
  knownImageSetting,
  imageSettingFor,
  compactAd,
  compactSnapshot,
  timeRulesNote,
  buildReviewMessages,
  buildBriefMessages,
  buildIterateMessages,
  extractJson,
  normaliseBrief,
  adResultsForBrief,
  briefWarnings,
  normaliseReview,
  callClaude,
  runDailyReview,
  generateBriefs,
  iterateDraft
};
