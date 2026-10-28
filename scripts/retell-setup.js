#!/usr/bin/env node
'use strict';
// Provisioning CLI for "Hazel", the outbound lead-calling agent on Retell AI.
//
//   node scripts/retell-setup.js <command> [--env <path>] [flags]
//   node scripts/retell-setup.js --help
//
// Builds the Retell Response Engine (LLM) and Agent from config/retell/
// (hazel-prompt.md + agent.json), clones the voice, imports the Twilio number
// and places test calls. Pure payload builders (buildTools, buildLlmPayload,
// buildAgentPayload, parseArgs) are exported for tests; the CLI only runs when
// this file is the entry point.
//
// Ids land in config/retell/state.json (gitignored). Secrets never do — the
// API key, SIP password etc. are read from the environment only.
//
// Endpoints and field names were checked against docs.retellai.com on
// 2026-10-27: /clone-voice (multipart: files, voice_name, voice_provider),
// /create-retell-llm + /update-retell-llm/{llm_id}, /create-agent +
// /update-agent/{agent_id}, /publish-agent-version/{agent_id} (body
// {version}), /import-phone-number (inbound_agents / outbound_agents weight
// arrays), /v2/list-phone-numbers ({items}), /list-voices, /get-agent/{id},
// /v2/create-phone-call.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config', 'retell');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
const DEFAULT_RETELL_API = 'https://api.retellai.com';
const DEFAULT_APP_BASE_URL = 'https://app.mygplink.com.au';
const DEFAULT_AGENT_NAME = 'Hazel — GP Link leads';
const WEBHOOK_EVENTS = ['call_started', 'call_ended', 'call_analyzed'];
const AUDIO_MIME = {
  '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac'
};
const VOICE_PROVIDERS = ['elevenlabs', 'cartesia', 'minimax', 'fish_audio', 'platform', 'inworld'];
const OUTCOME_CHOICES = ['callback_requested', 'not_interested', 'not_a_gp', 'wrong_number', 'already_booked'];

// ── Pure helpers (exported) ─────────────────────────────────────────────────

function camel(key) {
  return String(key).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// `<command> --flag value --flag=value --bool --no-bool`. Values may start
// with "+" (phone numbers) but not "--".
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = { command: '', flags: {}, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') { out.rest.push(...args.slice(i + 1).map(String)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val;
      if (eq !== -1) val = a.slice(eq + 1);
      else if (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) val = String(args[++i]);
      else val = true;
      if (key.startsWith('no-') && val === true) { key = key.slice(3); val = false; }
      out.flags[camel(key)] = val;
    } else if (a === '-h') {
      out.flags.help = true;
    } else if (!out.command) {
      out.command = a;
    } else {
      out.rest.push(a);
    }
  }
  return out;
}

// Same rules as scripts/agents.js loadDotEnv: KEY=value, quotes stripped,
// never overrides a variable already in the environment. Returns the count.
function loadEnvFile(envPath) {
  let text;
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { return -1; }
  let n = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value && !process.env[key]) { process.env[key] = value; n++; }
  }
  return n;
}

function stripSlash(url) { return String(url || '').trim().replace(/\/+$/, ''); }

function readEnvConfig(env) {
  const e = env || process.env;
  const lc = require('../lib/lead-calls');
  return {
    apiKey: String(e.RETELL_API_KEY || '').trim(),
    apiBase: stripSlash(e.RETELL_API_URL) || DEFAULT_RETELL_API,
    appBaseUrl: stripSlash(e.APP_BASE_URL) || DEFAULT_APP_BASE_URL,
    transferNumber: lc.normalizeE164(e.LEAD_CALLS_TRANSFER_NUMBER),
    agentName: String(e.LEAD_CALLS_AGENT_NAME || '').trim() || 'Hazel',
    directorName: String(e.LEAD_CALLS_DIRECTOR_NAME || '').trim(),
    agentId: String(e.RETELL_AGENT_ID || '').trim(),
    fromNumbers: {
      uk: lc.normalizeE164(e.RETELL_FROM_NUMBER_UK),
      au: lc.normalizeE164(e.RETELL_FROM_NUMBER_AU)
    }
  };
}

function customTool(base, name, pathName, description, executionMessage, properties, required) {
  return {
    type: 'custom',
    name,
    description,
    url: base + '/api/retell/tools/' + pathName,
    method: 'POST',
    timeout_ms: 20000,
    // Only tools with a natural spoken bridge ("let me just have a look at the
    // diary") speak while they run; the rest stay silent so Hazel never
    // narrates housekeeping ("I'll send that over", "let me note that down").
    speak_during_execution: Boolean(executionMessage),
    ...(executionMessage ? { execution_message_type: 'static_text', execution_message_description: executionMessage } : {}),
    speak_after_execution: true,
    parameters: { type: 'object', properties: properties || {}, required: required || [] }
  };
}

// The tools Hazel can call mid-conversation. Every custom tool posts to the
// app, which verifies X-Retell-Signature before doing anything.
function buildTools(appBaseUrl, transferNumber) {
  const base = stripSlash(appBaseUrl) || DEFAULT_APP_BASE_URL;
  const tools = [
    customTool(base, 'check_availability', 'check-availability',
      'Look up open times for the consultation call with {{director_name}}. Call this as soon as the doctor is open to booking, and again whenever they want a different day or time of day. Results are already converted to the doctor\'s own local time.',
      'Let me just have a look at the diary.',
      {
        preferred_day: { type: 'string', description: "'today', 'tomorrow', a weekday name, or YYYY-MM-DD — only if the doctor stated one." },
        time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'], description: 'The part of the day the doctor prefers, in their own local time.' }
      }, []),
    customTool(base, 'book_consult', 'book-consult',
      'Book the consultation at a slot_id returned by check_availability, exactly as written, once the doctor has clearly chosen it. Confirm the email first if it is not on file.',
      null,
      {
        slot_id: { type: 'string', description: 'The slot_id exactly as returned by check_availability.' },
        email: { type: 'string', description: 'Email address for the invitation, only if there is none on file or the doctor gave a different one.' }
      }, ['slot_id']),
    customTool(base, 'send_booking_link', 'send-booking-link',
      'Send the doctor the self-service booking link by email and WhatsApp. Use when they would rather pick a time themselves, are busy, or booking on the call failed.',
      "I'll send that over to you now.",
      {}, []),
    customTool(base, 'mark_outcome', 'mark-outcome',
      'Record how the call went when it did not end in a booking: callback_requested (also pass callback_hours if they said when), not_interested, not_a_gp, wrong_number, already_booked. Call once, just before ending.',
      null,
      {
        outcome: { type: 'string', enum: OUTCOME_CHOICES, description: 'How the call ended.' },
        callback_hours: { type: 'number', description: 'Hours from now the doctor asked to be rung back, if they said when.' },
        note: { type: 'string', description: 'One sentence of context for the team.' }
      }, ['outcome']),
    {
      type: 'end_call',
      name: 'end_call',
      description: 'Hang up politely once the conversation has naturally finished, after saying goodbye.'
    }
  ];
  const transfer = String(transferNumber || '').trim();
  if (transfer) {
    tools.push({
      type: 'transfer_call',
      name: 'transfer_to_team',
      description: 'Warm transfer to a human at GP Link when the doctor explicitly asks for a person or a question is beyond you.',
      transfer_destination: { type: 'predefined', number: transfer },
      transfer_option: { type: 'warm_transfer', show_transferee_as_caller: false }
    });
  }
  return tools;
}

// agent.json writes `primary: "claude-5.5-sonnet"`; the API wants
// `primary: { model: "claude-5.5-sonnet" }` (CascadingModelConfig).
function normalizeModelConfig(mc) {
  if (!mc || typeof mc !== 'object') return mc;
  const out = Object.assign({}, mc);
  if (!out.type) out.type = 'cascading';
  if (typeof out.primary === 'string') out.primary = { model: out.primary };
  if (typeof out.backup === 'string') out.backup = { model: out.backup };
  return out;
}

function buildLlmPayload(prompt, llmCfg, tools) {
  const llm = Object.assign({}, llmCfg || {});
  delete llm._comment;
  delete llm.general_prompt;
  delete llm.general_tools;
  const payload = Object.assign({}, llm, {
    general_prompt: String(prompt || ''),
    general_tools: Array.isArray(tools) ? tools : []
  });
  if (!payload.start_speaker) payload.start_speaker = 'user';
  if (payload.model_config) payload.model_config = normalizeModelConfig(payload.model_config);
  if (payload.default_dynamic_variables && typeof payload.default_dynamic_variables === 'object') {
    // Retell accepts string values only.
    const vars = {};
    for (const k of Object.keys(payload.default_dynamic_variables)) {
      const v = payload.default_dynamic_variables[k];
      vars[k] = v == null ? '' : String(v);
    }
    payload.default_dynamic_variables = vars;
  }
  return payload;
}

// `ids` = { llm_id, voice_id }. Every key of agent.json `agent` is passed
// through; the fields the app depends on are pinned here. Top-level
// post_call_analysis_data wins over one nested inside `agent`.
function buildAgentPayload(cfg, ids, appBaseUrl) {
  const c = cfg || {};
  const agent = Object.assign({}, c.agent || {});
  delete agent._comment;
  const base = stripSlash(appBaseUrl) || DEFAULT_APP_BASE_URL;
  const payload = Object.assign({}, agent, {
    response_engine: { type: 'retell-llm', llm_id: String((ids && ids.llm_id) || '') },
    agent_name: String(c.agent_name || agent.agent_name || '').trim() || DEFAULT_AGENT_NAME,
    webhook_url: base + '/api/webhooks/retell',
    webhook_events: WEBHOOK_EVENTS.slice()
  });
  const voiceId = String((ids && ids.voice_id) || agent.voice_id || '').trim();
  if (voiceId) payload.voice_id = voiceId; else delete payload.voice_id;
  const pcad = Array.isArray(c.post_call_analysis_data) ? c.post_call_analysis_data
    : (Array.isArray(agent.post_call_analysis_data) ? agent.post_call_analysis_data : null);
  if (pcad) payload.post_call_analysis_data = pcad; else delete payload.post_call_analysis_data;
  return payload;
}

// ── I/O helpers (CLI only) ──────────────────────────────────────────────────

function fail(msg) {
  console.error('Error: ' + msg);
  process.exit(1);
}

function printJson(obj) { console.log(JSON.stringify(obj, null, 2)); }

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file || STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}

// Merge `patch` into state.json. Only ids, versions and names ever go in here.
function writeState(patch, file) {
  const f = file || STATE_FILE;
  const next = Object.assign({}, readState(f), patch);
  if (!next.created_at) next.created_at = new Date().toISOString();
  next.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function readAgentConfig(dir) {
  const d = dir ? path.resolve(String(dir)) : CONFIG_DIR;
  const promptFile = path.join(d, 'hazel-prompt.md');
  const agentFile = path.join(d, 'agent.json');
  let prompt = '';
  let cfg = null;
  try { prompt = fs.readFileSync(promptFile, 'utf8'); } catch { fail('Missing prompt file ' + promptFile); }
  try { cfg = JSON.parse(fs.readFileSync(agentFile, 'utf8')); } catch (e) { fail('Cannot read ' + agentFile + ': ' + (e && e.message)); }
  if (!String(prompt).trim()) fail(promptFile + ' is empty');
  if (!cfg || typeof cfg !== 'object') fail(agentFile + ' must be a JSON object');
  return { prompt: String(prompt).trim(), cfg };
}

function requireApiKey(cfg) {
  if (!cfg.apiKey) fail('RETELL_API_KEY is not set (pass --env <path to .env> or export it)');
}

// One call to Retell. Any non-2xx prints the status + body and exits 1.
async function retell(cfg, method, pathname, body) {
  const url = cfg.apiBase + pathname;
  const headers = { Authorization: 'Bearer ' + cfg.apiKey };
  const init = { method, headers };
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    fail(method + ' ' + url + ' failed: ' + (err && err.message ? err.message : err));
  }
  const text = await res.text();
  if (!res.ok) {
    console.error('Retell ' + method + ' ' + pathname + ' -> HTTP ' + res.status);
    console.error(text || '(empty body)');
    process.exit(1);
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function idFrom(flags, state, key, flagKey, envValue) {
  return String(flags[flagKey] || state[key] || envValue || '').trim();
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdCloneVoice({ cfg, flags }) {
  requireApiKey(cfg);
  const dir = flags.dir ? path.resolve(String(flags.dir)) : '';
  const name = String(flags.name || '').trim();
  const provider = String(flags.provider || 'elevenlabs').trim().toLowerCase();
  if (!dir) fail('clone-voice needs --dir <folder of audio samples>');
  if (!name) fail('clone-voice needs --name "<voice name>"');
  if (!VOICE_PROVIDERS.includes(provider)) fail('--provider must be one of ' + VOICE_PROVIDERS.join(', '));

  let entries;
  try { entries = fs.readdirSync(dir); } catch { fail('Cannot read folder ' + dir); }
  let files = entries.filter((f) => AUDIO_MIME[path.extname(f).toLowerCase()]).sort();
  const prefixes = String(flags.files || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (prefixes.length) files = files.filter((f) => prefixes.some((p) => f.startsWith(p)));
  if (!files.length) fail('No audio files (' + Object.keys(AUDIO_MIME).join(' ') + ') matched in ' + dir);
  const max = provider === 'cartesia' || provider === 'minimax' ? 1 : (provider === 'inworld' ? 3 : 25);
  if (files.length > max) fail(files.length + ' files selected; ' + provider + ' accepts at most ' + max + '. Narrow with --files 03,05');

  const fd = new FormData();
  let bytes = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    bytes += buf.length;
    fd.append('files', new Blob([buf], { type: AUDIO_MIME[path.extname(f).toLowerCase()] }), f);
  }
  fd.append('voice_name', name);
  fd.append('voice_provider', provider);
  console.log('Uploading ' + files.length + ' file(s), ' + Math.round(bytes / 1024) + ' KB, as "' + name + '" (' + provider + '):');
  files.forEach((f) => console.log('  - ' + f));

  const voice = await retell(cfg, 'POST', '/clone-voice', fd);
  console.log('');
  console.log('voice_id:          ' + voice.voice_id);
  console.log('provider:          ' + voice.provider);
  console.log('voice_name:        ' + voice.voice_name);
  if (voice.preview_audio_url) console.log('preview_audio_url: ' + voice.preview_audio_url);
  writeState({ voice_id: voice.voice_id, voice_name: voice.voice_name, voice_provider: voice.provider });
  console.log('Saved voice_id to ' + path.relative(ROOT, STATE_FILE) + '. Next: node scripts/retell-setup.js create');
}

function buildPayloadsFromConfig(cfg, flags, state) {
  const config = readAgentConfig(flags.configDir);
  const voiceId = String(flags.voiceId || state.voice_id || (config.cfg.agent && config.cfg.agent.voice_id) || '').trim();
  const tools = buildTools(cfg.appBaseUrl, cfg.transferNumber);
  const llmPayload = buildLlmPayload(config.prompt, config.cfg.llm, tools);
  return { config, voiceId, tools, llmPayload };
}

async function cmdCreate({ cfg, flags }) {
  requireApiKey(cfg);
  const state = readState();
  if ((state.llm_id || state.agent_id) && !flags.force && !flags.dryRun) {
    fail('state.json already has llm_id/agent_id. Use `update` to push changes, or `create --force` to make a second agent.');
  }
  const { config, voiceId, llmPayload } = buildPayloadsFromConfig(cfg, flags, state);
  if (!voiceId) fail('No voice_id. Run `clone-voice` first, pass --voice-id <id>, or set agent.voice_id in agent.json');
  if (!cfg.transferNumber) console.log('Note: LEAD_CALLS_TRANSFER_NUMBER not set — no transfer_to_team tool.');

  if (flags.dryRun) {
    console.log('--- POST /create-retell-llm');
    printJson(llmPayload);
    console.log('--- POST /create-agent');
    printJson(buildAgentPayload(config.cfg, { llm_id: '<llm_id>', voice_id: voiceId }, cfg.appBaseUrl));
    return;
  }

  const llm = await retell(cfg, 'POST', '/create-retell-llm', llmPayload);
  console.log('Response Engine: ' + llm.llm_id + ' (version ' + llm.version + ')');
  const agentPayload = buildAgentPayload(config.cfg, { llm_id: llm.llm_id, voice_id: voiceId }, cfg.appBaseUrl);
  const agent = await retell(cfg, 'POST', '/create-agent', agentPayload);
  console.log('Agent:           ' + agent.agent_id + ' (version ' + agent.version + ')');
  writeState({
    llm_id: llm.llm_id,
    agent_id: agent.agent_id,
    voice_id: voiceId,
    llm_version: llm.version,
    agent_version: agent.version,
    agent_name: agentPayload.agent_name,
    webhook_url: agentPayload.webhook_url
  });
  console.log('');
  console.log('Saved to ' + path.relative(ROOT, STATE_FILE) + '.');
  console.log('Next: set RETELL_AGENT_ID=' + agent.agent_id + ' in Vercel, then `publish` and `import-number`.');
}

async function cmdUpdate({ cfg, flags }) {
  requireApiKey(cfg);
  const state = readState();
  const llmId = idFrom(flags, state, 'llm_id', 'llmId', '');
  const agentId = idFrom(flags, state, 'agent_id', 'agentId', cfg.agentId);
  if (!llmId || !agentId) fail('Need llm_id and agent_id (from state.json, or --llm-id / --agent-id). Run `create` first.');
  const { config, voiceId, llmPayload } = buildPayloadsFromConfig(cfg, flags, state);
  const agentPayload = buildAgentPayload(config.cfg, { llm_id: llmId, voice_id: voiceId }, cfg.appBaseUrl);

  if (flags.dryRun) {
    console.log('--- PATCH /update-retell-llm/' + llmId);
    printJson(llmPayload);
    console.log('--- PATCH /update-agent/' + agentId);
    printJson(agentPayload);
    return;
  }

  const llm = await retell(cfg, 'PATCH', '/update-retell-llm/' + encodeURIComponent(llmId), llmPayload);
  console.log('Response Engine ' + llm.llm_id + ' -> version ' + llm.version);
  const agent = await retell(cfg, 'PATCH', '/update-agent/' + encodeURIComponent(agentId), agentPayload);
  console.log('Agent ' + agent.agent_id + ' -> version ' + agent.version + (agent.is_published ? ' (published)' : ' (draft — run `publish`)'));
  writeState({
    llm_id: llm.llm_id || llmId,
    agent_id: agent.agent_id || agentId,
    voice_id: voiceId || state.voice_id,
    llm_version: llm.version,
    agent_version: agent.version,
    agent_name: agentPayload.agent_name,
    webhook_url: agentPayload.webhook_url
  });
}

// Docs: POST /publish-agent-version/{agent_id} with { version }. There is no
// body-less /publish-agent endpoint, so we look up the latest version first.
async function cmdPublish({ cfg, flags }) {
  requireApiKey(cfg);
  const state = readState();
  const agentId = idFrom(flags, state, 'agent_id', 'agentId', cfg.agentId);
  if (!agentId) fail('No agent_id (state.json, --agent-id or RETELL_AGENT_ID)');
  let version = flags.version !== undefined ? parseInt(String(flags.version), 10) : NaN;
  if (!Number.isFinite(version)) {
    const agent = await retell(cfg, 'GET', '/get-agent/' + encodeURIComponent(agentId));
    version = Number(agent.version);
    if (!Number.isFinite(version)) fail('Could not read the agent version from /get-agent');
    if (agent.is_published) {
      console.log('Agent ' + agentId + ' version ' + version + ' is already published.');
      writeState({ agent_id: agentId, published_version: version });
      return;
    }
  }
  const body = {
    version,
    version_title: String(flags.title || ('retell-setup ' + new Date().toISOString().slice(0, 10)))
  };
  if (flags.description) body.version_description = String(flags.description);
  await retell(cfg, 'POST', '/publish-agent-version/' + encodeURIComponent(agentId), body);
  console.log('Published agent ' + agentId + ' version ' + version + '.');
  writeState({ agent_id: agentId, published_version: version });
}

async function cmdImportNumber({ cfg, flags }) {
  requireApiKey(cfg);
  const lc = require('../lib/lead-calls');
  const number = lc.normalizeE164(flags.number);
  const terminationUri = String(flags.terminationUri || '').trim();
  const username = String(flags.username || '').trim();
  const password = String(flags.password || '').trim();
  if (!number) fail('--number must be E.164, e.g. +442030000000');
  if (!terminationUri) fail('--termination-uri is required (e.g. gplink.pstn.london.twilio.com)');
  const state = readState();
  const agentId = idFrom(flags, state, 'agent_id', 'agentId', cfg.agentId);

  const body = { phone_number: number, termination_uri: terminationUri };
  if (username) body.sip_trunk_auth_username = username;
  if (password) body.sip_trunk_auth_password = password;
  if (flags.nickname) body.nickname = String(flags.nickname);
  if (flags.transport) body.transport = String(flags.transport).toUpperCase();
  if (agentId) {
    body.outbound_agents = [{ agent_id: agentId, weight: 1 }];
    if (flags.inbound !== false) body.inbound_agents = [{ agent_id: agentId, weight: 1 }];
  } else {
    console.log('Note: no agent_id yet — importing without an agent binding. Run `create` first to bind automatically.');
  }

  const num = await retell(cfg, 'POST', '/import-phone-number', body);
  console.log('phone_number:      ' + num.phone_number);
  console.log('phone_number_type: ' + num.phone_number_type);
  if (num.nickname) console.log('nickname:          ' + num.nickname);
  if (agentId) console.log('agents:            inbound ' + (flags.inbound === false ? '(none)' : agentId) + ', outbound ' + agentId);
  const country = lc.countryFromDialCode(number);
  const envKey = country === 'au' || country === 'nz' ? 'RETELL_FROM_NUMBER_AU' : 'RETELL_FROM_NUMBER_UK';
  console.log('Next: set ' + envKey + '=' + number + ' in Vercel.');
  const patch = {};
  patch[country === 'au' || country === 'nz' ? 'from_number_au' : 'from_number_uk'] = number;
  writeState(patch);
}

async function cmdListNumbers({ cfg }) {
  requireApiKey(cfg);
  const data = await retell(cfg, 'GET', '/v2/list-phone-numbers?limit=200');
  const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
  if (!items.length) { console.log('No phone numbers on this account.'); return; }
  for (const n of items) {
    const outb = (n.outbound_agents || []).map((a) => a.agent_id).join(',') || '-';
    const inb = (n.inbound_agents || []).map((a) => a.agent_id).join(',') || '-';
    console.log(n.phone_number + '  ' + (n.phone_number_type || '') + '  ' + (n.nickname || '') + '  outbound=' + outb + '  inbound=' + inb);
  }
  if (data && data.has_more) console.log('(more numbers exist — pagination_key ' + data.pagination_key + ')');
}

async function cmdListVoices({ cfg, flags }) {
  requireApiKey(cfg);
  const data = await retell(cfg, 'GET', '/list-voices');
  const all = Array.isArray(data) ? data : [];
  const q = String(flags.query || '').trim().toLowerCase();
  const prov = String(flags.provider || '').trim().toLowerCase();
  let list = all;
  if (q) list = list.filter((v) => String(v.voice_name || '').toLowerCase().includes(q) || String(v.voice_id || '').toLowerCase().includes(q));
  if (prov) list = list.filter((v) => String(v.provider || '').toLowerCase() === prov);
  if (!list.length) { console.log('No voices matched (' + all.length + ' on the account).'); return; }
  const cap = flags.all ? list.length : 60;
  list.slice(0, cap).forEach((v) => {
    console.log(v.voice_id + '  ' + v.voice_name + '  ' + (v.provider || '') + '  ' + (v.gender || '') + '  ' + (v.accent || '') + (v.preview_audio_url ? '  ' + v.preview_audio_url : ''));
  });
  if (list.length > cap) console.log('... ' + (list.length - cap) + ' more; narrow with --query or pass --all');
}

async function cmdGetAgent({ cfg, flags }) {
  requireApiKey(cfg);
  const state = readState();
  const agentId = idFrom(flags, state, 'agent_id', 'agentId', cfg.agentId);
  if (!agentId) fail('No agent_id (state.json, --agent-id or RETELL_AGENT_ID)');
  const agent = await retell(cfg, 'GET', '/get-agent/' + encodeURIComponent(agentId));
  if (flags.json) { printJson(agent); return; }
  const pcad = Array.isArray(agent.post_call_analysis_data) ? agent.post_call_analysis_data.map((d) => d.name) : [];
  printJson({
    agent_id: agent.agent_id,
    version: agent.version,
    is_published: agent.is_published,
    agent_name: agent.agent_name,
    response_engine: agent.response_engine,
    voice_id: agent.voice_id,
    voice_model: agent.voice_model,
    language: agent.language,
    webhook_url: agent.webhook_url,
    webhook_events: agent.webhook_events,
    voicemail_option: agent.voicemail_option,
    enable_dnc_detection: agent.enable_dnc_detection,
    max_call_duration_ms: agent.max_call_duration_ms,
    end_call_after_silence_ms: agent.end_call_after_silence_ms,
    stt_mode: agent.stt_mode,
    vocab_specialization: agent.vocab_specialization,
    data_storage_setting: agent.data_storage_setting,
    timezone: agent.timezone,
    post_call_analysis_data: pcad,
    post_call_analysis_model: agent.post_call_analysis_model,
    last_modification_timestamp: agent.last_modification_timestamp
      ? new Date(Number(agent.last_modification_timestamp)).toISOString() : undefined
  });
}

async function cmdTestCall({ cfg, flags }) {
  requireApiKey(cfg);
  const lc = require('../lib/lead-calls');
  const { gpTzForCountry } = require('../lib/interview-meetings');
  const to = lc.normalizeE164(flags.to);
  if (!to) fail('--to must be E.164, e.g. +447700900123');
  const country = String(flags.country || lc.countryFromDialCode(to) || 'uk').toLowerCase();
  if (!lc.SUPPORTED_COUNTRIES.includes(country)) fail('--country must be one of ' + lc.SUPPORTED_COUNTRIES.join('|'));
  const from = lc.normalizeE164(flags.from) || lc.fromNumberForCountry(country, cfg.fromNumbers);
  if (!from) fail('No from number: pass --from or set RETELL_FROM_NUMBER_' + (country === 'au' || country === 'nz' ? 'AU' : 'UK'));
  const state = readState();
  const agentId = idFrom(flags, state, 'agent_id', 'agentId', cfg.agentId);
  if (!agentId) fail('No agent_id (state.json, --agent-id or RETELL_AGENT_ID)');

  const name = String(flags.name || 'Test Doctor');
  const nowMs = Date.now();
  const variables = lc.buildLeadCallVariables({
    row: {
      name,
      email: 'test@example.com',
      phone: to,
      state: country,
      created_at: new Date(nowMs - 600000).toISOString(),
      metadata: { source: 'test', consult: { qualified: true, country } }
    },
    nowMs,
    tz: gpTzForCountry(country),
    country,
    attempt: 1,
    directorName: cfg.directorName || undefined,
    agentName: cfg.agentName
  });
  const body = {
    from_number: from,
    to_number: to,
    override_agent_id: agentId,
    metadata: { source: 'setup-test', test: true },
    retell_llm_dynamic_variables: variables
  };
  console.log('Calling ' + to + ' from ' + from + ' as agent ' + agentId + ' (' + country + ', ' + variables.lead_timezone + ', local time ' + variables.local_time_now + ')');
  const call = await retell(cfg, 'POST', '/v2/create-phone-call', body);
  console.log('call_id:     ' + call.call_id);
  console.log('call_status: ' + call.call_status);
  console.log('Watch it in the Retell dashboard; the app receives call_started / call_ended / call_analyzed at ' + cfg.appBaseUrl + '/api/webhooks/retell');
}

const COMMANDS = {
  'clone-voice': { run: cmdCloneVoice, usage: 'clone-voice --dir <folder> --name "<voice name>" [--provider elevenlabs] [--files 03,05]', help: 'Clone Hazel\'s voice from audio samples in a folder; saves voice_id to state.json' },
  'create': { run: cmdCreate, usage: 'create [--voice-id <id>] [--dry-run] [--force]', help: 'Create the Response Engine + Agent from config/retell/*; writes ids to state.json' },
  'update': { run: cmdUpdate, usage: 'update [--dry-run]', help: 'Push config/retell/* changes to the existing LLM + Agent (PATCH); prints the new versions' },
  'publish': { run: cmdPublish, usage: 'publish [--version <n>] [--title "..."]', help: 'Publish the agent\'s latest draft version so live calls use it' },
  'import-number': { run: cmdImportNumber, usage: 'import-number --number +44... --termination-uri <x.pstn.<edge>.twilio.com> --username <u> --password <p> [--nickname "UK outbound"] [--no-inbound]', help: 'Import a Twilio SIP-trunk number and bind it to the agent in state.json' },
  'list-numbers': { run: cmdListNumbers, usage: 'list-numbers', help: 'List phone numbers on the Retell account' },
  'list-voices': { run: cmdListVoices, usage: 'list-voices [--query hazel] [--provider elevenlabs] [--all]', help: 'List voices, filtered by a name substring' },
  'get-agent': { run: cmdGetAgent, usage: 'get-agent [--agent-id <id>] [--json]', help: 'Show the agent\'s key settings (id from state.json)' },
  'test-call': { run: cmdTestCall, usage: 'test-call --to +44... [--name "Test Doctor"] [--country uk|ie|nz|au] [--from +44...]', help: 'Place one real test call through the agent with lead-style variables' }
};

function helpText() {
  const lines = [
    'Hazel / Retell provisioning',
    '',
    'Usage: node scripts/retell-setup.js <command> [--env <path>] [flags]',
    ''
  ];
  for (const name of Object.keys(COMMANDS)) {
    lines.push('  ' + COMMANDS[name].usage);
    lines.push('      ' + COMMANDS[name].help);
  }
  lines.push('  --help');
  lines.push('      This text');
  lines.push('');
  lines.push('--env <path>  .env file to load (default <repo>/.env; never overrides exported variables).');
  lines.push('Env: RETELL_API_KEY (required), APP_BASE_URL (' + DEFAULT_APP_BASE_URL + '), LEAD_CALLS_TRANSFER_NUMBER,');
  lines.push('     LEAD_CALLS_AGENT_NAME (Hazel), LEAD_CALLS_DIRECTOR_NAME, RETELL_FROM_NUMBER_UK / _AU, RETELL_AGENT_ID, RETELL_API_URL.');
  lines.push('State: ' + path.relative(ROOT, STATE_FILE) + ' (ids only, gitignored).');
  return lines.join('\n');
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.flags.help || parsed.command === 'help') {
    console.log(helpText());
    return;
  }
  const handler = COMMANDS[parsed.command];
  if (!handler) fail('Unknown command "' + parsed.command + '". Run --help for the list.');
  const envPath = parsed.flags.env ? path.resolve(String(parsed.flags.env)) : path.join(ROOT, '.env');
  const loaded = loadEnvFile(envPath);
  if (loaded < 0 && parsed.flags.env) console.error('Warning: no .env file at ' + envPath + ' (using the exported environment only)');
  const cfg = readEnvConfig(process.env);
  await handler.run({ cfg, flags: parsed.flags, rest: parsed.rest });
}

module.exports = {
  parseArgs,
  loadEnvFile,
  readEnvConfig,
  buildTools,
  buildLlmPayload,
  buildAgentPayload,
  normalizeModelConfig,
  helpText,
  COMMANDS,
  DEFAULT_APP_BASE_URL,
  DEFAULT_AGENT_NAME,
  WEBHOOK_EVENTS,
  STATE_FILE,
  CONFIG_DIR
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
