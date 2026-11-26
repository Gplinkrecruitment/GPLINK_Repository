// Signed-contract email scan (lib/contract-email-scan.js) + its three routes.
//
// Unit tests drive runContractEmailScan / confirmEmailFind with an in-memory
// PostgREST stand-in, a mocked Gmail client and a mocked model. Route tests
// boot the REAL server against an in-memory PostgREST emulator (same pattern
// as tests/ceo-overview.test.js). Nothing here touches real Gmail, Anthropic
// or a real database. All addresses are fake (example.test).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import scan from '../lib/contract-email-scan.js';

const NOW_MS = Date.parse('2026-11-26T03:00:00.000Z');
const MAILBOX = 'inbox@example.test';

// ── In-memory PostgREST (shared by unit + route tests) ──────────────────────
const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function cmp(cell, val) {
  const a = Number(cell), b = Number(val);
  if (cell !== null && cell !== undefined && cell !== '' && Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return String(cell) < val ? -1 : (String(cell) > val ? 1 : 0);
}
function buildMatcher(sp) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of sp.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') return val.replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
    if (cell === null || cell === undefined) return false;
    if (op === 'gte') return cmp(cell, val) >= 0;
    if (op === 'gt') return cmp(cell, val) > 0;
    if (op === 'lte') return cmp(cell, val) <= 0;
    if (op === 'lt') return cmp(cell, val) < 0;
    return true;
  });
}
const PKS = { email_contract_finds: 'gmail_message_id', pipeline_sync_state: 'source' };
function makeStore(seed) {
  const db = JSON.parse(JSON.stringify(seed || {}));
  const writes = [];
  const table = (n) => { if (!db[n]) db[n] = []; return db[n]; };
  function handle(method, name, search, body, prefer) {
    const sp = new URLSearchParams(search || '');
    const rows = table(name);
    const matches = buildMatcher(sp);
    if (method === 'GET') {
      let out = rows.filter(matches);
      const limit = parseInt(sp.get('limit') || '', 10);
      if (Number.isFinite(limit)) out = out.slice(0, limit);
      return { ok: true, status: 200, data: JSON.parse(JSON.stringify(out)) };
    }
    writes.push({ method, table: name });
    if (method === 'POST') {
      const incoming = Array.isArray(body) ? body : (body ? [body] : []);
      const pk = sp.get('on_conflict') || PKS[name];
      const saved = [];
      for (const r of incoming) {
        const existing = pk ? rows.find((x) => r[pk] !== undefined && String(x[pk]) === String(r[pk])) : null;
        if (existing) {
          if (/merge-duplicates/.test(prefer || '')) Object.assign(existing, r);
          saved.push(existing);
          continue;
        }
        const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
        rows.push(row); saved.push(row);
      }
      return { ok: true, status: 201, data: JSON.parse(JSON.stringify(saved)) };
    }
    if (method === 'PATCH') {
      const matched = rows.filter(matches);
      matched.forEach((row) => Object.assign(row, body || {}));
      return { ok: true, status: 200, data: JSON.parse(JSON.stringify(matched)) };
    }
    return { ok: true, status: 200, data: [] };
  }
  const sb = async (name, query, opts) => {
    const o = opts || {};
    return handle(o.method || 'GET', name, query, o.body, o.headers && o.headers.Prefer);
  };
  return { db, sb, writes, handle };
}

// ── Gmail fixtures ──────────────────────────────────────────────────────────
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function gmailMsg({ id, threadId, subject, from, to, body, attachments = [], internalDate }) {
  return {
    id, threadId: threadId || 't-' + id, internalDate: String(internalDate || NOW_MS - 3600000), snippet: '',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }, { name: 'To', value: to || MAILBOX }, { name: 'Date', value: new Date(internalDate || NOW_MS - 3600000).toUTCString() }],
      parts: [{ mimeType: 'text/plain', body: { data: b64u(body) } }].concat(attachments.map((a, i) => ({
        mimeType: a.mimeType || 'application/pdf', filename: a.filename, headers: [{ name: 'Content-Disposition', value: 'attachment' }],
        body: { attachmentId: 'att-' + id + '-' + i, size: a.size || 2000 }
      })))
    }
  };
}
const WIN_MSG = gmailMsg({
  id: 'msgwin0001', subject: 'Dr Yan Naing Win to Deception Bay Medical Centre', from: 'Recruitment Team <team@example.test>', to: 'practice@example.test',
  body: 'Hi team,\n\nDr. Win has informed us that he sent the signed contract back to you. Congratulations on the placement!\n\nKind regards'
});
const AKKAS_MSG = gmailMsg({
  id: 'msgakkas001', subject: 'Contract', from: 'Doctor <doctor@example.test>',
  body: 'Please find attached signed contract', attachments: [{ filename: 'Halekulani_Medical_Centre_Agreement_Dr_Hatice_Akkas.pdf' }]
});
const INVOICE_MSG = gmailMsg({ id: 'msginv00001', subject: 'Invoice INV-0042', from: 'Accounts <accounts@example.test>', body: 'Please find attached the signed service agreement invoice.', attachments: [{ filename: 'INV-0042.pdf' }] });

function makeGmail(messages) {
  const calls = { list: [], get: [], attachments: [], watch: 0, modify: 0, send: 0 };
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  return {
    calls,
    users: {
      watch: async () => { calls.watch++; return {}; },
      messages: {
        list: async (p) => { calls.list.push(p); return { data: { messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })) } }; },
        get: async (p) => { calls.get.push(p.id); return { data: byId[p.id] }; },
        modify: async () => { calls.modify++; return {}; },
        send: async () => { calls.send++; return {}; },
        attachments: { get: async (p) => { calls.attachments.push(p); return { data: { data: b64u('%PDF-1.4 fake') } }; } }
      }
    }
  };
}

// Minimal stand-in for server.js extractEmailMeta.
function extractEmailMeta(m) {
  const h = (n) => ((m.payload.headers || []).find((x) => x.name.toLowerCase() === n.toLowerCase()) || {}).value || '';
  const from = h('From'); const am = from.match(/<([^>]+)>/);
  const textPart = (m.payload.parts || []).find((p) => p.mimeType === 'text/plain');
  return {
    messageId: m.id, threadId: m.threadId, sender: am ? am[1] : from, senderName: am ? from.replace(/<[^>]+>/, '').trim() : '',
    subject: h('Subject'), to: h('To'), cc: '', date: h('Date'),
    bodyText: textPart ? Buffer.from(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '',
    attachments: (m.payload.parts || []).filter((p) => p.filename).map((p, i) => ({ index: i, filename: p.filename, mimeType: p.mimeType, attachmentId: p.body.attachmentId, size: p.body.size }))
  };
}

// Model mock: answers by message content, records every prompt it was given.
function makeClassifier(answers) {
  const prompts = [];
  const classify = async (text) => {
    prompts.push(text);
    for (const [needle, reply] of answers) if (text.includes(needle)) return typeof reply === 'string' ? reply : JSON.stringify(reply);
    return JSON.stringify({ is_signed_placement_contract: false, confidence: 0.9, doctor_name: null, practice_name: null, signed_date: null, evidence: null, why: 'Not a contract.' });
  };
  classify.prompts = prompts;
  return classify;
}
const WIN_ANSWER = { is_signed_placement_contract: true, confidence: 0.86, doctor_name: 'Dr Yan Naing Win', practice_name: 'Deception Bay Medical Centre', signed_date: null, evidence: 'Dr. Win has informed us that he sent the signed contract back to you.', why: 'The agency confirms the doctor returned the signed contract.' };
const AKKAS_ANSWER = { is_signed_placement_contract: true, confidence: 0.95, doctor_name: 'Hatice Akkas', practice_name: 'Halekulani Medical Centre', signed_date: '2026-10-12', evidence: 'Please find attached signed contract', why: 'Doctor returned the signed agreement.' };

function baseDeps(store, gmail, classify, extra) {
  return Object.assign({ sb: store.sb, gmail, mailbox: MAILBOX, classify, extractEmailMeta, extractPdfText: () => 'AGREEMENT between Halekulani Medical Centre and Dr Hatice Akkas. Signed: H Akkas', nowMs: NOW_MS }, extra || {});
}

// ── Query building ──────────────────────────────────────────────────────────
describe('buildScanQuery', () => {
  it('looks back 14 days on the first run and excludes noise senders', () => {
    const q = scan.buildScanQuery({});
    expect(q.startsWith('newer_than:120d ')).toBe(true);
    expect(q).toContain('has:attachment');
    expect(q).toContain('"signed contract"');
    for (const noise of ['xero.com', 'gocardless.com', 'zoho.com', 'docusign.com']) expect(q).toContain(noise);
    expect(q).toContain('-category:promotions');
    // Real DocuSign envelopes (docusign.net) are NOT excluded, nor is the team's own mail.
    expect(q).not.toContain('docusign.net');
    expect(q).not.toMatch(/-from:me\b/);
  });
  it('uses after: = cursor minus 2 days once a successful scan exists', () => {
    const cursor = '2026-11-20T00:00:00.000Z';
    const q = scan.buildScanQuery({ cursorAt: cursor });
    expect(q.startsWith('after:' + Math.floor((Date.parse(cursor) - 2 * 86400000) / 1000) + ' ')).toBe(true);
    expect(q).not.toContain('newer_than');
  });
  it('accepts a configured base query', () => {
    expect(scan.buildScanQuery({ baseQuery: 'subject:contract' })).toBe('newer_than:120d subject:contract');
  });
});

// ── Classification parsing ──────────────────────────────────────────────────
describe('parseClassification', () => {
  it('reads strict JSON, strips "Dr", clamps confidence and caps evidence at 20 words', () => {
    const c = scan.parseClassification('```json\n' + JSON.stringify({ ...WIN_ANSWER, confidence: 1.7, evidence: Array(30).fill('word').join(' ') }) + '\n```');
    expect(c.doctor_name).toBe('Yan Naing Win');
    expect(c.confidence).toBe(1);
    expect(c.evidence.split(' ')).toHaveLength(20);
    expect(c.signed_date).toBeNull();
  });
  it('returns null for malformed or shapeless replies', () => {
    expect(scan.parseClassification('')).toBeNull();
    expect(scan.parseClassification('I think this is a contract')).toBeNull();
    expect(scan.parseClassification('{"is_signed_placement_contract": tru')).toBeNull();
    expect(scan.parseClassification('{"confidence": 0.9}')).toBeNull();
  });
  it('drops an invalid signed_date and treats "null" strings as missing', () => {
    const c = scan.parseClassification(JSON.stringify({ ...AKKAS_ANSWER, signed_date: '12/10/2026', practice_name: 'null' }));
    expect(c.signed_date).toBeNull();
    expect(c.practice_name).toBeNull();
  });
  it('proposes only signed + confidence >= 0.7 + a doctor name', () => {
    expect(scan.isProposable(scan.parseClassification(JSON.stringify(WIN_ANSWER)))).toBe(true);
    expect(scan.isProposable(scan.parseClassification(JSON.stringify({ ...WIN_ANSWER, confidence: 0.69 })))).toBe(false);
    expect(scan.isProposable(scan.parseClassification(JSON.stringify({ ...WIN_ANSWER, is_signed_placement_contract: false })))).toBe(false);
    expect(scan.isProposable(scan.parseClassification(JSON.stringify({ ...WIN_ANSWER, doctor_name: null })))).toBe(false);
  });
});

describe('name matching', () => {
  it('matches doctors with titles / middle names and practices without filler words', () => {
    expect(scan.doctorNamesMatch('Dr. Yan Naing Win', 'Yan Naing Win')).toBe(true);
    expect(scan.doctorNamesMatch('Yan Naing Win', 'Yan Win')).toBe(true);
    expect(scan.doctorNamesMatch('Yan Naing Win', 'Yan Smith')).toBe(false);
    expect(scan.practiceNamesMatch('Deception Bay Medical Centre', 'deception bay medical center')).toBe(true);
    expect(scan.practiceNamesMatch('The Doctors Werribee', 'Doctors Werribee Clinic')).toBe(true);
    expect(scan.practiceNamesMatch('Halekulani Medical Centre', 'Deception Bay Medical Centre')).toBe(false);
  });
});

// ── The scan ────────────────────────────────────────────────────────────────
describe('runContractEmailScan', () => {
  it('proposes the two real positive examples and ignores the invoice', async () => {
    const store = makeStore({});
    const gmail = makeGmail([WIN_MSG, AKKAS_MSG, INVOICE_MSG]);
    const classify = makeClassifier([['Dr. Win has informed us', WIN_ANSWER], ['Halekulani_Medical_Centre_Agreement', AKKAS_ANSWER]]);
    const out = await scan.runContractEmailScan(baseDeps(store, gmail, classify));
    expect(out.ok).toBe(true);
    expect(out.detail).toMatchObject({ scanned: 3, proposed: 2, ignored: 1, errors: 0, backlog: 0 });
    const finds = Object.fromEntries(store.db.email_contract_finds.map((f) => [f.gmail_message_id, f]));
    expect(finds.msgwin0001.status).toBe('proposed');
    expect(finds.msgakkas001.status).toBe('proposed');
    expect(finds.msginv00001.status).toBe('ignored');
    expect(finds.msginv00001.ai_summary).toMatch(/Not a signed contract/);
    // PDFs <= 1 MB are read and their text handed to the model with the filename.
    expect(gmail.calls.attachments).toHaveLength(2);
    const akkasPrompt = classify.prompts.find((p) => p.includes('Halekulani_Medical_Centre_Agreement_Dr_Hatice_Akkas.pdf'));
    expect(akkasPrompt).toContain('AGREEMENT between Halekulani');
    const st = store.db.pipeline_sync_state.find((s) => s.source === 'email_scan');
    expect(st.last_ok_at).toBe(new Date(NOW_MS).toISOString());
    expect(st.last_error).toBeNull();
    expect(st.detail).toMatchObject({ scanned: 3, proposed: 2, ignored: 1 });
    expect(st.detail.scan_cursor).toBe(new Date(NOW_MS).toISOString());
  });

  it('keeps the first-run look-back while a backlog is left (last_ok_at is not a cursor)', async () => {
    // Regression 2026-11-26: run 1 left a backlog (scan_cursor null) but stamped
    // last_ok_at; run 2 fell back to last_ok_at and searched only the last two days.
    const store = makeStore({ pipeline_sync_state: [{ source: 'email_scan', last_ok_at: new Date(NOW_MS - 3600000).toISOString(), detail: { scan_cursor: null, backlog: 161 } }] });
    const gmail = makeGmail([WIN_MSG]);
    await scan.runContractEmailScan(baseDeps(store, gmail, makeClassifier([['Dr. Win has informed us', WIN_ANSWER]])));
    expect(gmail.calls.list[0].q).toMatch(/^newer_than:120d /);
  });

  it('writes the pipeline_people row in the agreed shape', async () => {
    const store = makeStore({});
    await scan.runContractEmailScan(baseDeps(store, makeGmail([AKKAS_MSG]), makeClassifier([['Halekulani', AKKAS_ANSWER]])));
    const p = store.db.pipeline_people[0];
    expect(p).toMatchObject({
      name: 'Hatice Akkas', practice_name: 'Halekulani Medical Centre', stage: 'signed', source: 'email_contract',
      source_ref: 'msgakkas001', needs_confirm: true, next_step: 'Confirm the placement', user_id: null
    });
    expect(p.status_note).toBe('Signed contract found in email (12 Oct 2026)');
    expect(p.metadata).toMatchObject({ thread_id: 't-msgakkas001', evidence: 'Please find attached signed contract', gmail_message_id: 'msgakkas001' });
    expect(store.db.email_contract_finds[0].pipeline_person_id).toBe(p.id);
  });

  it('never re-classifies a message already in email_contract_finds', async () => {
    const store = makeStore({ email_contract_finds: [{ gmail_message_id: 'msgwin0001', status: 'ignored' }] });
    const classify = makeClassifier([['Halekulani', AKKAS_ANSWER]]);
    const out = await scan.runContractEmailScan(baseDeps(store, makeGmail([WIN_MSG, AKKAS_MSG]), classify));
    expect(out.detail.already_seen).toBe(1);
    expect(classify.prompts).toHaveLength(1);
    const again = await scan.runContractEmailScan(baseDeps(store, makeGmail([WIN_MSG, AKKAS_MSG]), classify));
    expect(again.detail.scanned).toBe(0);
    expect(classify.prompts).toHaveLength(1);
  });

  it('records low-confidence and malformed replies as ignored so they are not re-classified', async () => {
    const store = makeStore({});
    const classify = makeClassifier([['Dr. Win', { ...WIN_ANSWER, confidence: 0.55 }], ['Halekulani', 'Sure! It looks signed.']]);
    const out = await scan.runContractEmailScan(baseDeps(store, makeGmail([WIN_MSG, AKKAS_MSG]), classify));
    expect(out.detail).toMatchObject({ proposed: 0, ignored: 2 });
    const finds = Object.fromEntries(store.db.email_contract_finds.map((f) => [f.gmail_message_id, f]));
    expect(finds.msgwin0001).toMatchObject({ status: 'ignored', confidence: 0.55 });
    expect(finds.msgwin0001.ai_summary).toMatch(/confidence 0\.55/);
    expect(finds.msgakkas001.ai_summary).toBe('The model reply could not be read.');
    expect(store.db.pipeline_people || []).toHaveLength(0);
  });

  it('ignores a doctor already placed at that practice in the app', async () => {
    const store = makeStore({
      user_profiles: [{ user_id: 'u-akkas', first_name: 'Hatice', last_name: 'Akkas' }],
      gp_applications: [{ id: 'app-1', user_id: 'u-akkas', status: 'placement_secured', ats_stage: 'hired', career_role_id: 'role-53' }],
      career_roles: [{ id: 'role-53', practice_name: 'Halekulani Medical Centre' }]
    });
    const out = await scan.runContractEmailScan(baseDeps(store, makeGmail([AKKAS_MSG]), makeClassifier([['Halekulani', AKKAS_ANSWER]])));
    expect(out.detail).toMatchObject({ proposed: 0, ignored: 1 });
    expect(store.db.email_contract_finds[0].status).toBe('ignored');
    expect(store.db.email_contract_finds[0].ai_summary).toMatch(/^Already in the app/);
    expect(store.db.pipeline_people || []).toHaveLength(0);
  });

  it('also treats a placements row for the same practice as already placed', async () => {
    const store = makeStore({
      user_profiles: [{ user_id: 'u-akkas', first_name: 'Hatice', last_name: 'Akkas' }],
      placements: [{ id: 'pl-1', user_id: 'u-akkas', practice_name: 'Halekulani Medical Centre', status: 'active' }]
    });
    const out = await scan.runContractEmailScan(baseDeps(store, makeGmail([AKKAS_MSG]), makeClassifier([['Halekulani', AKKAS_ANSWER]])));
    expect(out.detail.ignored).toBe(1);
  });

  it('links the app account and reuses an existing board row with the same name', async () => {
    const store = makeStore({
      user_profiles: [{ user_id: 'u-win', first_name: 'Yan Naing', last_name: 'Win' }],
      pipeline_people: [{ id: 'pp-wa', name: 'Dr Yan Win', stage: 'matched', source: 'whatsapp_personal', source_ref: 'wa-1', needs_confirm: false, metadata: { chat: 'x' }, archived_at: null }]
    });
    const out = await scan.runContractEmailScan(baseDeps(store, makeGmail([WIN_MSG]), makeClassifier([['Dr. Win', WIN_ANSWER]])));
    expect(out.detail.proposed).toBe(1);
    expect(store.db.pipeline_people).toHaveLength(1);
    const p = store.db.pipeline_people[0];
    expect(p).toMatchObject({ id: 'pp-wa', source: 'whatsapp_personal', source_ref: 'wa-1', stage: 'signed', needs_confirm: true, user_id: 'u-win' });
    expect(p.metadata.chat).toBe('x');
    expect(p.metadata.gmail_message_id).toBe('msgwin0001');
  });

  it('does not propose the same deal twice from two messages in a thread', async () => {
    const store = makeStore({});
    const second = gmailMsg({ id: 'msgakkas002', subject: 'Re: Contract', from: 'Doctor <doctor@example.test>', body: 'Resending: Please find attached signed contract', attachments: [{ filename: 'Halekulani_Medical_Centre_Agreement_Dr_Hatice_Akkas.pdf' }] });
    const out = await scan.runContractEmailScan(baseDeps(store, makeGmail([AKKAS_MSG, second]), makeClassifier([['Halekulani', AKKAS_ANSWER]])));
    expect(out.detail).toMatchObject({ proposed: 1, ignored: 1 });
    expect(store.db.pipeline_people).toHaveLength(1);
  });

  it('caps model calls at 40 per run and holds the cursor while a backlog remains', async () => {
    const msgs = Array.from({ length: 45 }, (_, i) => gmailMsg({ id: 'bulk' + String(i).padStart(6, '0'), subject: 'Agreement ' + i, from: 'sender@example.test', body: 'agreement' }));
    const store = makeStore({ pipeline_sync_state: [{ source: 'email_scan', last_ok_at: '2026-11-20T00:00:00.000Z', detail: { scan_cursor: '2026-11-20T00:00:00.000Z' } }] });
    const classify = makeClassifier([]);
    const gmail = makeGmail(msgs);
    const out = await scan.runContractEmailScan(baseDeps(store, gmail, classify));
    expect(classify.prompts).toHaveLength(40);
    expect(out.detail.backlog).toBe(5);
    expect(gmail.calls.list[0].q.startsWith('after:' + Math.floor((Date.parse('2026-11-20T00:00:00.000Z') - 2 * 86400000) / 1000))).toBe(true);
    const st = store.db.pipeline_sync_state[0];
    expect(st.detail.scan_cursor).toBe('2026-11-20T00:00:00.000Z');
    expect(st.last_ok_at).toBe(new Date(NOW_MS).toISOString());
  });

  it('leaves a message unrecorded (retried next hour) when the model call fails', async () => {
    const store = makeStore({});
    const classify = async () => { throw new Error('AI service error: overloaded'); };
    const out = await scan.runContractEmailScan(baseDeps(store, makeGmail([WIN_MSG]), classify));
    expect(out.ok).toBe(true);
    expect(out.detail.errors).toBe(1);
    expect(store.db.email_contract_finds || []).toHaveLength(0);
    expect(store.db.pipeline_sync_state[0].last_error).toMatch(/retried/);
    expect(store.db.pipeline_sync_state[0].detail.scan_cursor).toBeNull();
  });

  it('records the failure in pipeline_sync_state when Gmail is not connected', async () => {
    const store = makeStore({});
    const out = await scan.runContractEmailScan(baseDeps(store, null, makeClassifier([])));
    expect(out.ok).toBe(false);
    const st = store.db.pipeline_sync_state[0];
    expect(st.last_error).toMatch(/Gmail is not connected/);
    expect(st.last_ok_at).toBeUndefined();
    expect(st.last_run_at).toBe(new Date(NOW_MS).toISOString());
  });

  it('never watches, modifies or sends mail, and only writes the four board tables', async () => {
    const store = makeStore({});
    const gmail = makeGmail([WIN_MSG, AKKAS_MSG, INVOICE_MSG]);
    await scan.runContractEmailScan(baseDeps(store, gmail, makeClassifier([['Dr. Win', WIN_ANSWER], ['Halekulani', AKKAS_ANSWER]])));
    expect(gmail.calls.watch).toBe(0);
    expect(gmail.calls.modify).toBe(0);
    expect(gmail.calls.send).toBe(0);
    const written = [...new Set(store.writes.map((w) => w.table))];
    expect(written.every((t) => scan.WRITABLE_TABLES.includes(t))).toBe(true);
    expect(written).not.toContain('registration_tasks');
    expect(written).not.toContain('incoming_email_todos');
    expect(store.db.registration_tasks).toBeUndefined();
    expect(store.db.incoming_email_todos).toBeUndefined();
  });

  it('the write guard refuses any other table', () => {
    expect(() => scan._guardedWrite(async () => ({}), 'registration_tasks', '', { method: 'POST' })).toThrow(/may not write/);
    expect(() => scan._guardedWrite(async () => ({}), 'incoming_email_todos', '', { method: 'POST' })).toThrow(/may not write/);
  });

  it('the lib source has no watch / send / modify / task-table calls at all', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'contract-email-scan.js'), 'utf8');
    expect(src).not.toMatch(/users\.watch|\.watch\(/);
    expect(src).not.toMatch(/messages\.(send|modify|insert|trash|delete)\(/);
    expect(src).not.toMatch(/sb\(\s*'(registration_tasks|incoming_email_todos)'/);
  });
});

// ── Anthropic classifier wrapper ────────────────────────────────────────────
describe('createAnthropicClassifier', () => {
  it('pins the model, disables thinking, never sends temperature and records spend', async () => {
    let sent = null; let spent = null;
    const classify = scan.createAnthropicClassifier({
      apiKey: 'k', model: 'claude-test-model', url: 'https://example.invalid/v1/messages',
      checkBudget: async () => true, recordSpend: (i, o) => { spent = [i, o]; },
      fetch: async (u, opts) => { sent = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 10, output_tokens: 5 } }) }; }
    });
    expect(await classify('hello')).toBe('{"a":1}');
    expect(sent.model).toBe('claude-test-model');
    expect(sent.thinking).toEqual({ type: 'disabled' });
    expect(sent).not.toHaveProperty('temperature');
    expect(sent.system).toMatch(/JSON/);
    expect(spent).toEqual([10, 5]);
  });
  it('throws on an API error, a spent budget or a missing key', async () => {
    const errFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) });
    await expect(scan.createAnthropicClassifier({ apiKey: 'k', model: 'm', fetch: errFetch })('x')).rejects.toThrow(/AI service error: bad/);
    await expect(scan.createAnthropicClassifier({ apiKey: 'k', model: 'm', fetch: errFetch, checkBudget: async () => false })('x')).rejects.toThrow(/budget/);
    await expect(scan.createAnthropicClassifier({ apiKey: '', model: 'm', fetch: errFetch })('x')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

// ── Confirm ─────────────────────────────────────────────────────────────────
function proposedStore(extra) {
  return makeStore(Object.assign({
    email_contract_finds: [{ gmail_message_id: 'msgakkas001', thread_id: 't1', subject: 'Contract', doctor_name: 'Hatice Akkas', practice_name: 'Halekulani Medical Centre', signed_date: '2026-10-12', confidence: 0.95, status: 'proposed', pipeline_person_id: 'pp-1' }],
    pipeline_people: [{ id: 'pp-1', name: 'Hatice Akkas', practice_name: 'Halekulani Medical Centre', stage: 'signed', source: 'email_contract', source_ref: 'msgakkas001', needs_confirm: true, confirmed_at: null, user_id: null, metadata: { gmail_message_id: 'msgakkas001' } }]
  }, extra || {}));
}
describe('confirmEmailFind', () => {
  it('confirms on the board but creates no placement when there is no app account', async () => {
    const store = proposedStore({ practices: [{ id: 'pr-h', name: 'Halekulani Medical Centre' }] });
    let placeCalls = 0;
    const out = await scan.confirmEmailFind({ sb: store.sb, placeInApp: async () => { placeCalls++; return { ok: true }; }, actor: 'ceo-user', nowMs: NOW_MS }, 'msgakkas001');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, confirmed: true, placed: false, retry: true });
    expect(out.body.message).toBe('Confirmed on the board. Hatice Akkas has no app account, so no placement was created — add them, then confirm again.');
    expect(placeCalls).toBe(0);
    expect(store.db.email_contract_finds[0].status).toBe('confirmed');
    expect(store.db.pipeline_people[0]).toMatchObject({ needs_confirm: false, confirmed_at: new Date(NOW_MS).toISOString() });
    expect(store.db.pipeline_events).toHaveLength(1);
    expect(store.db.pipeline_events[0]).toMatchObject({ person_id: 'pp-1', kind: 'confirm', created_by: 'ceo-user' });
  });

  it('says when the practice is missing from Practices', async () => {
    const store = proposedStore({ user_profiles: [{ user_id: 'u-akkas', first_name: 'Hatice', last_name: 'Akkas' }] });
    const out = await scan.confirmEmailFind({ sb: store.sb, placeInApp: async () => ({ ok: true }) }, 'msgakkas001');
    expect(out.body.placed).toBe(false);
    expect(out.body.message).toBe('Confirmed on the board. Halekulani Medical Centre isn\'t in Practices yet, so no placement was created — add them, then confirm again.');
  });

  it('creates the placement through the injected placement path when account + practice exist', async () => {
    const store = proposedStore({
      user_profiles: [{ user_id: 'u-akkas', first_name: 'Hatice', last_name: 'Akkas' }],
      practices: [{ id: 'pr-h', name: 'Halekulani Medical Centre' }, { id: 'pr-d', name: 'Deception Bay Medical Centre' }]
    });
    const seen = [];
    const out = await scan.confirmEmailFind({ sb: store.sb, placeInApp: async (pc) => { seen.push(pc); return { ok: true, application_id: 'app-9' }; }, actor: 'ceo-user', nowMs: NOW_MS }, 'msgakkas001');
    expect(out.body).toMatchObject({ ok: true, placed: true, already: false, application_id: 'app-9' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId: 'u-akkas', signedDate: '2026-10-12' });
    expect(seen[0].practice.id).toBe('pr-h');
    const p = store.db.pipeline_people[0];
    expect(p.user_id).toBe('u-akkas');
    expect(p.metadata.placement_application_id).toBe('app-9');
    expect(store.db.pipeline_events.map((e) => e.kind)).toEqual(['confirm', 'note']);
  });

  it('is idempotent: a second confirm neither re-logs nor re-places', async () => {
    const store = proposedStore({
      user_profiles: [{ user_id: 'u-akkas', first_name: 'Hatice', last_name: 'Akkas' }],
      practices: [{ id: 'pr-h', name: 'Halekulani Medical Centre' }]
    });
    let placeCalls = 0;
    const deps = { sb: store.sb, placeInApp: async () => { placeCalls++; return { ok: true, application_id: 'app-9' }; } };
    await scan.confirmEmailFind(deps, 'msgakkas001');
    const second = await scan.confirmEmailFind(deps, 'msgakkas001');
    expect(second.body).toMatchObject({ ok: true, placed: true, already: true });
    expect(placeCalls).toBe(1);
    expect(store.db.pipeline_events).toHaveLength(2);
  });

  it('a retry after the account is added creates the placement (one confirm event in total)', async () => {
    const store = proposedStore({ practices: [{ id: 'pr-h', name: 'Halekulani Medical Centre' }] });
    let placeCalls = 0;
    const deps = { sb: store.sb, placeInApp: async () => { placeCalls++; return { ok: true, application_id: 'app-9' }; } };
    const first = await scan.confirmEmailFind(deps, 'msgakkas001');
    expect(first.body.placed).toBe(false);
    store.db.user_profiles = [{ user_id: 'u-akkas', first_name: 'Hatice', last_name: 'Akkas' }];
    const second = await scan.confirmEmailFind(deps, 'msgakkas001');
    expect(second.body.placed).toBe(true);
    expect(placeCalls).toBe(1);
    expect(store.db.pipeline_events.filter((e) => e.kind === 'confirm')).toHaveLength(1);
  });

  it('refuses ambiguous accounts instead of guessing', async () => {
    const store = proposedStore({
      user_profiles: [{ user_id: 'u1', first_name: 'Hatice', last_name: 'Akkas' }, { user_id: 'u2', first_name: 'Hatice', last_name: 'Akkas' }],
      practices: [{ id: 'pr-h', name: 'Halekulani Medical Centre' }]
    });
    const out = await scan.confirmEmailFind({ sb: store.sb, placeInApp: async () => ({ ok: true }) }, 'msgakkas001');
    expect(out.body.placed).toBe(false);
    expect(out.body.message).toMatch(/More than one app account/);
  });

  it('404s an unknown find, 409s a dismissed one, 400s a bad id', async () => {
    const store = proposedStore();
    expect((await scan.confirmEmailFind({ sb: store.sb }, 'nosuchmsg01')).status).toBe(404);
    store.db.email_contract_finds[0].status = 'dismissed';
    expect((await scan.confirmEmailFind({ sb: store.sb }, 'msgakkas001')).status).toBe(409);
    expect((await scan.confirmEmailFind({ sb: store.sb }, 'bad id!')).status).toBe(400);
  });

  it('reports a placement failure without losing the confirm', async () => {
    const store = proposedStore({
      user_profiles: [{ user_id: 'u-akkas', first_name: 'Hatice', last_name: 'Akkas' }],
      practices: [{ id: 'pr-h', name: 'Halekulani Medical Centre' }]
    });
    const out = await scan.confirmEmailFind({ sb: store.sb, placeInApp: async () => ({ ok: false, message: 'could not save the offer record' }) }, 'msgakkas001');
    expect(out.body).toMatchObject({ ok: true, confirmed: true, placed: false, retry: true });
    expect(out.body.message).toMatch(/could not save the offer record/);
    expect(store.db.email_contract_finds[0].status).toBe('confirmed');
  });
});

// ── Routes: real server + PostgREST emulator ────────────────────────────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-contract-scan-${RUN_ID}.json`;
const SUPER_HOST = 'ats-test.local';
let server, port, sbServer, sbPort, realFetch;
let routeStore;
function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
        if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
        const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
        if (!m) { send(404, { message: 'not found' }); return; }
        let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
        const out = routeStore.handle(req.method, decodeURIComponent(m[1]), u.search, body, req.headers.prefer);
        send(out.status, out.data);
      });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ Host: SUPER_HOST }, extra || {});
    if (cookie) headers.Cookie = cookie;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch { /* raw */ } resolve({ status: res.statusCode, body: parsed, raw }); });
    });
    r.on('error', reject); r.end(payload);
  });
}

describe('contract-scan routes (real server)', () => {
  beforeAll(async () => {
    routeStore = makeStore({});
    await startSupabaseEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'contract-scan-test-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
    process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
    process.env.ADMIN_EMAILS = '';
    process.env.CRON_SECRET = 'cron-test-' + RUN_ID;
    process.env.CONTRACT_SCAN_MAILBOX = MAILBOX;
    // No Google service account → getGmailClient can never authorise.
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '';
    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      const u = String(url && url.url ? url.url : url);
      if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
      if (u.includes('anthropic.com')) throw new Error('test must not call Anthropic');
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const mod = await import('../server.js');
    server = mod.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
  });
  afterAll(async () => {
    if (realFetch) globalThis.fetch = realFetch;
    if (server) await new Promise((r) => server.close(r));
    if (sbServer) await new Promise((r) => sbServer.close(r));
    try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
  });
  beforeEach(() => {
    const fresh = proposedStore();
    for (const k of Object.keys(routeStore.db)) delete routeStore.db[k];
    Object.assign(routeStore.db, fresh.db);
    routeStore.writes.length = 0;
  });

  it('the cron needs the CRON_SECRET bearer', async () => {
    expect((await httpReq('GET', '/api/cron/contract-scan')).status).toBe(401);
    expect((await httpReq('GET', '/api/cron/contract-scan', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('the cron records "Gmail not connected" in pipeline_sync_state and writes nothing else', async () => {
    const res = await httpReq('GET', '/api/cron/contract-scan', { headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/Gmail is not connected for inbox@example\.test/);
    const st = routeStore.db.pipeline_sync_state.find((s) => s.source === 'email_scan');
    expect(st.last_error).toMatch(/Gmail is not connected/);
    const written = [...new Set(routeStore.writes.map((w) => w.table))];
    expect(written).toEqual(['pipeline_sync_state']);
  });

  it('run-now and confirm are CEO-only', async () => {
    expect([401, 403]).toContain((await httpReq('POST', '/api/ceo/contract-scan/run', { body: {} })).status);
    expect([401, 403]).toContain((await httpReq('POST', '/api/ceo/pipeline/email-find/msgakkas001/confirm', { body: {} })).status);
  });

  it('run-now returns a readable message', async () => {
    const res = await httpReq('POST', '/api/ceo/contract-scan/run', { cookie: superCookie(), body: {} });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/^The email check failed: Gmail is not connected/);
  });

  it('confirm without an app account confirms on the board only', async () => {
    routeStore.db.practices = [{ id: 'pr-h', name: 'Halekulani Medical Centre' }];
    const res = await httpReq('POST', '/api/ceo/pipeline/email-find/msgakkas001/confirm', { cookie: superCookie(), body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, confirmed: true, placed: false });
    expect(res.body.message).toMatch(/Hatice Akkas has no app account/);
    expect(routeStore.db.email_contract_finds[0].status).toBe('confirmed');
    expect(routeStore.db.pipeline_people[0].needs_confirm).toBe(false);
    expect(routeStore.db.pipeline_events[0]).toMatchObject({ kind: 'confirm', created_by: 'super@gplink-test.local' });
    expect(routeStore.db.gp_applications || []).toHaveLength(0);
  });

  it('confirm with account + practice runs the real placement path (job, application, offer, finalize)', async () => {
    routeStore.db.practices = [{ id: 'pr-h', name: 'Halekulani Medical Centre', location_state: 'NSW', suburb: 'Gorokan', contact_email: 'practice@example.test' }];
    routeStore.db.user_profiles = [{ user_id: 'u-akkas', first_name: 'Hatice', last_name: 'Akkas', email: 'doctor@example.test' }];
    routeStore.db.user_state = [{ user_id: 'u-akkas', state: { gp_career_state: { applications: [] } } }];
    const res = await httpReq('POST', '/api/ceo/pipeline/email-find/msgakkas001/confirm', { cookie: superCookie(), body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, confirmed: true, placed: true });
    const job = (routeStore.db.career_roles || []).find((r) => r.practice_id === 'pr-h');
    expect(job).toMatchObject({ provider: 'internal_ats', is_active: false, approval_status: 'pending' });
    const app = routeStore.db.gp_applications.find((a) => a.user_id === 'u-akkas');
    expect(app).toMatchObject({ career_role_id: job.id, origin: 'admin_applied', revealed: true, status: 'placement_secured' });
    const offer = (routeStore.db.ats_offers || []).find((o) => String(o.application_id) === String(app.id));
    expect(offer && offer.status).toBe('accepted');
    const us = routeStore.db.user_state.find((s) => s.user_id === 'u-akkas');
    expect(us.state.gp_career_state.career_secured).toBe(true);
    expect(routeStore.db.pipeline_people[0].metadata.placement_application_id).toBe(app.id);
    const appsBefore = routeStore.db.gp_applications.length;
    const again = await httpReq('POST', '/api/ceo/pipeline/email-find/msgakkas001/confirm', { cookie: superCookie(), body: {} });
    expect(again.body).toMatchObject({ ok: true, placed: true, already: true });
    expect(routeStore.db.gp_applications.length).toBe(appsBefore);
  });
});
