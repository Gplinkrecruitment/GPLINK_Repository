'use strict';

// Phase 6 I1 (audit M2) — outbound canned-template library for the admin dashboard
// email composers. Curated in-code defaults (always available, even with an empty
// DB) + optional public.email_templates rows the CEO can add/edit. A DB row whose
// template_key matches a default OVERRIDES that default (including hiding it with
// active=false); rows without a matching key are extra custom templates.
//
// Placeholders use {{token}} form: {{firstName}}, {{gpName}}, {{practiceName}},
// {{rsoName}}, {{documentName}}. renderEmailTemplate substitutes only tokens the
// context actually provides — unknown/empty tokens stay visible so the sender can
// fill them in before sending.

var DEFAULT_EMAIL_TEMPLATES = [
  {
    key: 'request_document_gp',
    name: 'Request document from GP',
    category: 'document_request',
    stage: '',
    subject: 'Document needed for your registration — {{documentName}}',
    body: 'Hi {{firstName}},\n\nAs part of your registration we need a copy of your {{documentName}}. Could you please upload it through your GP Link portal, or reply to this email with it attached?\n\nIf anything is unclear, just reply and we will help.\n\nKind regards,\n{{rsoName}}\nGP Link Registration Team'
  },
  {
    key: 'chase_practice_sppa',
    name: 'Chase practice for SPPA return',
    category: 'practice_enquiry',
    stage: 'ahpra',
    subject: 'Following up — supervised practice plan (SPPA-00) for {{gpName}}',
    body: 'Dear {{practiceName}} team,\n\nJust following up on the supervised practice plan (SPPA-00) for {{gpName}}. AHPRA cannot progress the registration until the completed and signed form is returned.\n\nCould you please complete the practice sections and reply to this email with the signed copy attached? If anything on the form is unclear, we are happy to walk it through with you.\n\nKind regards,\n{{rsoName}}\nGP Link Registration Team'
  },
  {
    key: 'ahpra_followup',
    name: 'AHPRA follow-up',
    category: 'regulator',
    stage: 'ahpra',
    subject: 'Follow-up — registration application for {{gpName}}',
    body: 'Dear Officer,\n\nWe are writing to follow up on the registration application for {{gpName}}. Could you please advise the current status of the application, and whether anything further is required from the practitioner, the practice, or from us?\n\nThank you for your time.\n\nKind regards,\n{{rsoName}}\nGP Link Registration Team'
  },
  {
    key: 'interview_confirmation',
    name: 'Interview confirmation',
    category: 'schedule_query',
    stage: 'placement',
    subject: 'Interview confirmed — {{practiceName}}',
    body: 'Hi {{firstName}},\n\nGreat news — your interview with {{practiceName}} is confirmed. You will receive a calendar invitation with the meeting link shortly.\n\nA few quick tips:\n- Join a couple of minutes early and check your camera and microphone.\n- Have a copy of your CV handy.\n- Prepare one or two questions about the role and the practice.\n\nIf you need to reschedule, reply to this email as soon as you can and we will arrange a new time.\n\nKind regards,\n{{rsoName}}\nGP Link Registration Team'
  },
  {
    key: 'welcome_next_steps',
    name: 'Welcome / next steps',
    category: 'status_update',
    stage: 'onboarding',
    subject: 'Welcome to GP Link — your next steps',
    body: 'Hi {{firstName}},\n\nWelcome to GP Link! We are delighted to be supporting your move to general practice in Australia.\n\nYour next steps:\n1. Sign in to your GP Link portal and complete your profile.\n2. Upload your qualification documents so we can verify them.\n3. We will guide you through each registration stage from there — you will always be able to see what is in progress and what we need from you.\n\nI am your Registration Support Officer, so reply to this email any time you have a question.\n\nKind regards,\n{{rsoName}}\nGP Link Registration Team'
  }
];

// Substitute {{token}} placeholders where ctx provides a non-empty value; leave
// everything else untouched (visible) so the sender can fill it in manually.
function renderTemplateText(text, ctx) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, function (match, token) {
    var v = ctx && ctx[token];
    return (v !== undefined && v !== null && String(v).trim() !== '') ? String(v) : match;
  });
}

function renderEmailTemplate(tpl, ctx) {
  tpl = tpl || {};
  return {
    subject: renderTemplateText(tpl.subject, ctx),
    body: renderTemplateText(tpl.body, ctx)
  };
}

function _normalizeRow(row) {
  return {
    id: row.id || null,
    key: row.template_key || row.key || null,
    name: String(row.name || '').trim(),
    category: String(row.category || '').trim(),
    stage: String(row.stage || '').trim(),
    subject: String(row.subject || ''),
    body: String(row.body || ''),
    active: row.active !== false,
    source: 'custom'
  };
}

// Merge in-code defaults with DB rows. A row with template_key === a default's key
// replaces that default (active=false hides it); other rows are appended. Inactive
// custom rows are dropped. Order: defaults first (stable), then customs by name.
function mergeEmailTemplates(defaults, rows) {
  var byKey = {};
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    var k = r && (r.template_key || r.key);
    if (k) byKey[k] = r;
  });
  var out = [];
  (Array.isArray(defaults) ? defaults : []).forEach(function (d) {
    var override = byKey[d.key];
    if (override) {
      delete byKey[d.key];
      var n = _normalizeRow(override);
      if (!n.active) return; // hidden default
      // Fall back to default fields the override left blank.
      out.push({
        id: n.id, key: d.key,
        name: n.name || d.name,
        category: n.category || d.category,
        stage: n.stage || d.stage,
        subject: n.subject || d.subject,
        body: n.body || d.body,
        active: true, source: 'custom'
      });
    } else {
      out.push({ id: null, key: d.key, name: d.name, category: d.category, stage: d.stage, subject: d.subject, body: d.body, active: true, source: 'default' });
    }
  });
  // Extras: rows without a template_key, or with a key that didn't match any
  // default (matching overrides were consumed — and removed from byKey — above).
  var extras = (Array.isArray(rows) ? rows : []).filter(function (r) {
    var k = r && (r.template_key || r.key);
    return !k || byKey[k]; // no key at all, or a key that didn't match a default
  }).map(_normalizeRow).filter(function (r) { return r.active && (r.name || r.body); });
  extras.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out.concat(extras);
}

module.exports = {
  DEFAULT_EMAIL_TEMPLATES: DEFAULT_EMAIL_TEMPLATES,
  renderEmailTemplate: renderEmailTemplate,
  renderTemplateText: renderTemplateText,
  mergeEmailTemplates: mergeEmailTemplates
};
