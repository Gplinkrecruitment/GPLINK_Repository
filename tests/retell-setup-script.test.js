// Pure-helper tests for scripts/retell-setup.js (the Hazel / Retell
// provisioning CLI). Nothing here touches the network or state.json; the CLI
// itself only runs when the script is the process entry point.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildTools, buildLlmPayload, buildAgentPayload, parseArgs, readEnvConfig,
  normalizeModelConfig, helpText, COMMANDS, WEBHOOK_EVENTS
} from '../scripts/retell-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', 'config', 'retell');
const APP = 'https://app.mygplink.com.au';
const TOOL_PATHS = {
  check_availability: 'check-availability',
  book_consult: 'book-consult',
  send_booking_link: 'send-booking-link',
  mark_outcome: 'mark-outcome'
};

describe('buildTools', () => {
  it('builds the four custom tools with the app urls, POST and a 20s timeout', () => {
    const tools = buildTools(APP, '');
    const custom = tools.filter((t) => t.type === 'custom');
    expect(custom.map((t) => t.name)).toEqual(Object.keys(TOOL_PATHS));
    for (const t of custom) {
      expect(t.url).toBe(APP + '/api/retell/tools/' + TOOL_PATHS[t.name]);
      expect(t.method).toBe('POST');
      expect(t.timeout_ms).toBe(20000);
      expect(t.speak_during_execution).toBe(true);
      expect(t.speak_after_execution).toBe(true);
      expect(typeof t.execution_message_description).toBe('string');
      expect(t.parameters.type).toBe('object');
      expect(Array.isArray(t.parameters.required)).toBe(true);
    }
  });

  it('pins the parameter contracts the app endpoints expect', () => {
    const by = Object.fromEntries(buildTools(APP, '').map((t) => [t.name, t]));
    expect(by.check_availability.parameters.required).toEqual([]);
    expect(by.check_availability.parameters.properties.time_of_day.enum).toEqual(['morning', 'afternoon', 'evening', 'any']);
    expect(by.book_consult.parameters.required).toEqual(['slot_id']);
    expect(Object.keys(by.book_consult.parameters.properties)).toEqual(['slot_id', 'email']);
    expect(by.send_booking_link.parameters.properties).toEqual({});
    expect(by.mark_outcome.parameters.required).toEqual(['outcome']);
    expect(by.mark_outcome.parameters.properties.outcome.enum).toEqual(['callback_requested', 'not_interested', 'not_a_gp', 'wrong_number', 'already_booked']);
    expect(by.mark_outcome.parameters.properties.callback_hours.type).toBe('number');
  });

  it('always includes end_call and only adds transfer_to_team when a number is given', () => {
    const without = buildTools(APP, '');
    expect(without.map((t) => t.type)).toEqual(['custom', 'custom', 'custom', 'custom', 'end_call']);
    expect(without.find((t) => t.type === 'end_call').name).toBe('end_call');
    expect(without.some((t) => t.type === 'transfer_call')).toBe(false);

    const withNum = buildTools(APP, '+61280000000');
    const transfer = withNum.find((t) => t.type === 'transfer_call');
    expect(withNum).toHaveLength(6);
    expect(transfer.name).toBe('transfer_to_team');
    expect(transfer.transfer_destination).toEqual({ type: 'predefined', number: '+61280000000' });
    expect(transfer.transfer_option).toEqual({ type: 'warm_transfer', show_transferee_as_caller: false });
  });

  it('strips a trailing slash from the base url and falls back to production', () => {
    expect(buildTools(APP + '/', '')[0].url).toBe(APP + '/api/retell/tools/check-availability');
    expect(buildTools('', '')[0].url).toBe(APP + '/api/retell/tools/check-availability');
  });
});

describe('buildLlmPayload', () => {
  const llmCfg = {
    model_config: { type: 'cascading', primary: 'claude-5.5-sonnet', backup: 'claude-5.5-haiku', temperature: 0.5 },
    start_speaker: 'user',
    begin_after_user_silence_ms: 2500,
    tool_call_strict_mode: true,
    default_dynamic_variables: { agent_name: 'Hazel', attempt: 1, flag: true }
  };

  it('sets the prompt + tools and passes the llm block through', () => {
    const tools = buildTools(APP, '');
    const p = buildLlmPayload('You are {{agent_name}}.', llmCfg, tools);
    expect(p.general_prompt).toBe('You are {{agent_name}}.');
    expect(p.general_tools).toBe(tools);
    expect(p.start_speaker).toBe('user');
    expect(p.begin_after_user_silence_ms).toBe(2500);
    expect(p.tool_call_strict_mode).toBe(true);
  });

  it('normalises string model names into {model} objects (docs: CascadingModelConfig)', () => {
    const p = buildLlmPayload('x', llmCfg, []);
    expect(p.model_config).toEqual({
      type: 'cascading',
      primary: { model: 'claude-5.5-sonnet' },
      backup: { model: 'claude-5.5-haiku' },
      temperature: 0.5
    });
    // Already-correct shapes are left alone.
    expect(normalizeModelConfig({ type: 'cascading', primary: { model: 'gpt-5.4', tier: 'fast' } }).primary).toEqual({ model: 'gpt-5.4', tier: 'fast' });
  });

  it('stringifies default dynamic variables and defaults start_speaker to user', () => {
    const p = buildLlmPayload('x', { default_dynamic_variables: { attempt: 1, flag: true, none: null } }, []);
    expect(p.default_dynamic_variables).toEqual({ attempt: '1', flag: 'true', none: '' });
    expect(p.start_speaker).toBe('user');
    expect(p.general_tools).toEqual([]);
  });

  it('never lets agent.json override the prompt or tools', () => {
    const p = buildLlmPayload('real', { general_prompt: 'stale', general_tools: [{ type: 'end_call' }], _comment: 'x' }, []);
    expect(p.general_prompt).toBe('real');
    expect(p.general_tools).toEqual([]);
    expect(p._comment).toBeUndefined();
  });
});

describe('buildAgentPayload', () => {
  const cfg = {
    agent_name: 'Hazel — GP Link leads',
    agent: {
      voice_id: 'voice_from_json',
      voice_model: 'eleven_v4_turbo',
      language: 'en-GB',
      enable_backchannel: true,
      voicemail_option: { action: { type: 'static_text', text: 'Hi, Hazel here.' } },
      post_call_analysis_data: [{ type: 'string', name: 'nested', description: 'should lose' }]
    },
    post_call_analysis_data: [
      { type: 'enum', name: 'outcome', description: 'how it ended', choices: ['booked', 'no_answer'] },
      { type: 'string', name: 'notes', description: 'free text', examples: ['x'] }
    ]
  };

  it('pins response_engine, webhook_url + events and the agent name', () => {
    const p = buildAgentPayload(cfg, { llm_id: 'llm_123', voice_id: 'voice_cloned' }, APP);
    expect(p.response_engine).toEqual({ type: 'retell-llm', llm_id: 'llm_123' });
    expect(p.webhook_url).toBe('https://app.mygplink.com.au/api/webhooks/retell');
    expect(p.webhook_events).toEqual(['call_started', 'call_ended', 'call_analyzed']);
    expect(p.webhook_events).toEqual(WEBHOOK_EVENTS);
    expect(p.agent_name).toBe('Hazel — GP Link leads');
  });

  it('spreads every agent field and prefers the explicit voice_id over agent.json', () => {
    const p = buildAgentPayload(cfg, { llm_id: 'llm_123', voice_id: 'voice_cloned' }, APP);
    expect(p.voice_id).toBe('voice_cloned');
    expect(p.voice_model).toBe('eleven_v4_turbo');
    expect(p.language).toBe('en-GB');
    expect(p.enable_backchannel).toBe(true);
    expect(p.voicemail_option.action.type).toBe('static_text');
    const fallback = buildAgentPayload(cfg, { llm_id: 'llm_123' }, APP);
    expect(fallback.voice_id).toBe('voice_from_json');
    const none = buildAgentPayload({ agent: {} }, { llm_id: 'llm_123' }, APP);
    expect('voice_id' in none).toBe(false);
    expect(none.agent_name).toBe('Hazel — GP Link leads');
  });

  it('passes top-level post_call_analysis_data through, preferring it over the nested one', () => {
    const p = buildAgentPayload(cfg, { llm_id: 'llm_123', voice_id: 'v' }, APP);
    expect(p.post_call_analysis_data).toBe(cfg.post_call_analysis_data);
    expect(p.post_call_analysis_data.map((d) => d.name)).toEqual(['outcome', 'notes']);
    const nestedOnly = buildAgentPayload({ agent: cfg.agent }, { llm_id: 'l', voice_id: 'v' }, APP);
    expect(nestedOnly.post_call_analysis_data.map((d) => d.name)).toEqual(['nested']);
  });

  it('builds webhook urls against a custom base without a double slash', () => {
    const p = buildAgentPayload(cfg, { llm_id: 'l', voice_id: 'v' }, 'https://staging.example.com/');
    expect(p.webhook_url).toBe('https://staging.example.com/api/webhooks/retell');
  });
});

describe('real config/retell files', () => {
  const agentFile = path.join(CONFIG_DIR, 'agent.json');
  const promptFile = path.join(CONFIG_DIR, 'hazel-prompt.md');
  const present = fs.existsSync(agentFile) && fs.existsSync(promptFile);

  it.skipIf(!present)('produce API-shaped payloads from agent.json + hazel-prompt.md', () => {
    const cfg = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    const prompt = fs.readFileSync(promptFile, 'utf8');
    const llm = buildLlmPayload(prompt, cfg.llm, buildTools(APP, '+61280000000'));
    expect(llm.general_prompt.length).toBeGreaterThan(200);
    expect(llm.general_tools).toHaveLength(6);
    expect(typeof llm.model_config.primary).toBe('object');
    expect(typeof llm.model_config.primary.model).toBe('string');
    for (const v of Object.values(llm.default_dynamic_variables)) expect(typeof v).toBe('string');

    const agent = buildAgentPayload(cfg, { llm_id: 'llm_x', voice_id: 'voice_x' }, APP);
    expect(agent.voice_id).toBe('voice_x');
    expect(agent.webhook_url).toBe(APP + '/api/webhooks/retell');
    expect(Array.isArray(agent.post_call_analysis_data)).toBe(true);
    for (const item of agent.post_call_analysis_data) {
      expect(['string', 'enum', 'boolean', 'number']).toContain(item.type);
      expect(typeof item.name).toBe('string');
      expect(typeof item.description).toBe('string');
      if (item.type === 'enum') expect(item.choices.length).toBeGreaterThan(0);
    }
    // Every {{variable}} the prompt uses has a default so a missing value never reads literally.
    const used = Array.from(new Set((prompt.match(/{{\s*([a-z_]+)\s*}}/g) || []).map((m) => m.replace(/[{}\s]/g, ''))));
    for (const v of used) expect(Object.keys(llm.default_dynamic_variables)).toContain(v);
  });
});

describe('parseArgs + env', () => {
  it('parses command, --flag value, --flag=value, booleans and --no- flags', () => {
    const p = parseArgs(['test-call', '--to', '+447700900123', '--name', 'Test Doctor', '--country=uk', '--dry-run', '--no-inbound', '--env', '/tmp/x.env']);
    expect(p.command).toBe('test-call');
    expect(p.flags).toEqual({ to: '+447700900123', name: 'Test Doctor', country: 'uk', dryRun: true, inbound: false, env: '/tmp/x.env' });
    expect(parseArgs(['--help']).flags.help).toBe(true);
    expect(parseArgs(['import-number', '--termination-uri', 'x.pstn.london.twilio.com']).flags.terminationUri).toBe('x.pstn.london.twilio.com');
    expect(parseArgs([]).command).toBe('');
  });

  it('reads env with the documented defaults and never needs a real key', () => {
    const c = readEnvConfig({});
    expect(c.apiKey).toBe('');
    expect(c.apiBase).toBe('https://api.retellai.com');
    expect(c.appBaseUrl).toBe('https://app.mygplink.com.au');
    expect(c.agentName).toBe('Hazel');
    expect(c.transferNumber).toBe('');
    const d = readEnvConfig({
      RETELL_API_KEY: 'key_x', APP_BASE_URL: 'https://x.test/', RETELL_API_URL: 'http://127.0.0.1:9/',
      LEAD_CALLS_TRANSFER_NUMBER: '+61 2 8000 0000', RETELL_FROM_NUMBER_UK: '+442030000000'
    });
    expect(d.appBaseUrl).toBe('https://x.test');
    expect(d.apiBase).toBe('http://127.0.0.1:9');
    expect(d.transferNumber).toBe('+61280000000');
    expect(d.fromNumbers).toEqual({ uk: '+442030000000', au: '' });
  });

  it('documents every command in --help', () => {
    const text = helpText();
    for (const name of Object.keys(COMMANDS)) expect(text).toContain('  ' + name);
    expect(Object.keys(COMMANDS)).toEqual(['clone-voice', 'create', 'update', 'publish', 'import-number', 'list-numbers', 'list-voices', 'get-agent', 'test-call']);
  });
});
