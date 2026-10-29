import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const hf = require('../lib/higgsfield.js');

// Records every call and answers from a script keyed on "METHOD path".
function stub(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = (init && init.method ? init.method : 'GET') + ' ' + u.pathname;
    calls.push({ key, url, headers: (init && init.headers) || {}, body: init && init.body ? JSON.parse(init.body) : null });
    const handler = script[key] || script['*'];
    const r = typeof handler === 'function' ? handler(calls.length, u) : handler;
    if (!r) return { ok: false, status: 404, json: async () => ({ detail: 'Not Found' }) };
    return {
      ok: r.status ? r.status < 400 : true, status: r.status || 200,
      json: async () => r.json, arrayBuffer: async () => Buffer.from(r.bytes || 'img'), headers: { get: (h) => (r.headers || {})[h.toLowerCase()] || null }
    };
  };
  return { fetchImpl, calls };
}
const CFG = hf.higgsfieldConfig({ HIGGSFIELD_API_KEY: 'kid:ksecret' });
const noSleep = async () => {};

describe('config', () => {
  it('reads KEY_ID:KEY_SECRET from one variable or two', () => {
    expect(hf.higgsfieldConfig({}).configured).toBe(false);
    expect(hf.configProblems(hf.higgsfieldConfig({}))[0]).toMatch(/HIGGSFIELD_API_KEY/);
    expect(CFG.keyId).toBe('kid'); expect(CFG.keySecret).toBe('ksecret'); expect(CFG.configured).toBe(true);
    const two = hf.higgsfieldConfig({ HIGGSFIELD_API_KEY_ID: 'a', HIGGSFIELD_API_KEY_SECRET: 'b:c' });
    expect(two.keySecret).toBe('b:c');
    expect(hf.higgsfieldConfig({ HIGGSFIELD_API_KEY: 'nocolon' }).configured).toBe(false);
  });
  it('a custom image path goes first, the known paths stay as fallbacks', () => {
    const c = hf.higgsfieldConfig({ HIGGSFIELD_API_KEY: 'a:b', HIGGSFIELD_IMAGE_PATH: '/x/y' });
    expect(c.paths[0]).toBe('/x/y');
    expect(c.paths).toContain('/higgsfield-ai/soul/standard');
  });
  it('the prompt carries the house constraints', () => {
    expect(hf.photoPrompt('UK reception at 7:55am')).toMatch(/^UK reception at 7:55am /);
    expect(hf.photoPrompt('x')).toMatch(/no text/);
    expect(hf.photoPrompt('x')).toMatch(/4:5/);
  });
});

describe('submitImage', () => {
  it('posts the prompt with 4:5 and the auth header, and reads the status url', async () => {
    const s = stub({ 'POST /higgsfield-ai/soul/v2/standard': { json: { status: 'queued', request_id: 'r1', status_url: 'https://api.higgsfield.ai/requests/r1/status' } } });
    const r = await hf.submitImage({ config: CFG, prompt: 'a desk', fetchImpl: s.fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.requestId).toBe('r1');
    expect(r.statusUrl).toMatch(/requests\/r1\/status/);
    expect(s.calls[0].headers.Authorization).toBe('Key kid:ksecret');
    expect(s.calls[0].headers['Idempotency-Key']).toBeTruthy();
    expect(s.calls[0].body.aspect_ratio).toBe('4:5');
    expect(s.calls[0].body.num_images).toBe(1);
    expect(s.calls[0].body.prompt).toMatch(/a desk/);
  });
  it('falls back to the spec path when v2 is a 404', async () => {
    const s = stub({ 'POST /higgsfield-ai/soul/standard': { json: { status: 'queued', request_id: 'r2' } } });
    const r = await hf.submitImage({ config: CFG, prompt: 'x', fetchImpl: s.fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/higgsfield-ai/soul/standard');
    expect(r.statusUrl).toBe('https://api.higgsfield.ai/requests/r2/status');
    expect(s.calls.map((c) => c.key)).toEqual(['POST /higgsfield-ai/soul/v2/standard', 'POST /higgsfield-ai/soul/standard']);
  });
  it('retries with the bare prompt when a 400 names an optional field', async () => {
    let n = 0;
    const s = stub({ 'POST /higgsfield-ai/soul/v2/standard': () => (++n === 1 ? { status: 400, json: { detail: 'aspect_ratio: extra field not permitted' } } : { json: { status: 'queued', request_id: 'r3', status_url: 'https://api.higgsfield.ai/requests/r3/status' } }) });
    const r = await hf.submitImage({ config: CFG, prompt: 'x', fetchImpl: s.fetchImpl });
    expect(r.ok).toBe(true);
    expect(s.calls[1].body).toEqual({ prompt: hf.photoPrompt('x') });
  });
  it('a 401 is reported as an auth problem and does not try other paths', async () => {
    const s = stub({ 'POST /higgsfield-ai/soul/v2/standard': { status: 401, json: { detail: 'Invalid API key' } } });
    const r = await hf.submitImage({ config: CFG, prompt: 'x', fetchImpl: s.fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.auth).toBe(true);
    expect(s.calls.length).toBe(1);
  });
  it('no key → no network', async () => {
    const s = stub({});
    const r = await hf.submitImage({ config: hf.higgsfieldConfig({}), prompt: 'x', fetchImpl: s.fetchImpl });
    expect(r.ok).toBe(false);
    expect(s.calls.length).toBe(0);
  });
});

describe('pollRequest', () => {
  it('waits through queued and in_progress and returns the first image url on completed', async () => {
    let n = 0;
    const s = stub({ 'GET /requests/r1/status': () => { n++; return { json: n < 3 ? { status: n === 1 ? 'queued' : 'in_progress' } : { status: 'completed', images: [{ url: 'https://cdn/x.jpg' }], expires_at: '2026-11-05T00:00:00Z' } }; } });
    const r = await hf.pollRequest('https://api.higgsfield.ai/requests/r1/status', { config: CFG, fetchImpl: s.fetchImpl, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.imageUrl).toBe('https://cdn/x.jpg');
    expect(r.expiresAt).toBe('2026-11-05T00:00:00Z');
    expect(s.calls.length).toBe(3);
  });
  it('nsfw and failed are terminal errors with the reason', async () => {
    const a = stub({ 'GET /requests/r1/status': { json: { status: 'nsfw' } } });
    expect((await hf.pollRequest('https://api.higgsfield.ai/requests/r1/status', { config: CFG, fetchImpl: a.fetchImpl, sleep: noSleep })).error).toMatch(/moderation/);
    const b = stub({ 'GET /requests/r1/status': { json: { status: 'failed', error: 'GPU on fire' } } });
    expect((await hf.pollRequest('https://api.higgsfield.ai/requests/r1/status', { config: CFG, fetchImpl: b.fetchImpl, sleep: noSleep })).error).toMatch(/GPU on fire/);
  });
  it('gives up after maxWaitMs with timeout:true', async () => {
    const s = stub({ 'GET /requests/r1/status': { json: { status: 'in_progress' } } });
    let t = 0;
    const realNow = Date.now;
    Date.now = () => (t += 1000);
    try {
      const r = await hf.pollRequest('https://api.higgsfield.ai/requests/r1/status', { config: CFG, fetchImpl: s.fetchImpl, sleep: noSleep, maxWaitMs: 3000 });
      expect(r.ok).toBe(false);
      expect(r.timeout).toBe(true);
    } finally { Date.now = realNow; }
  });
});

describe('generatePhoto', () => {
  it('submits, polls, downloads, and returns the bytes to store', async () => {
    const s = stub({
      'POST /higgsfield-ai/soul/v2/standard': { json: { status: 'queued', request_id: 'r9', status_url: 'https://api.higgsfield.ai/requests/r9/status' } },
      'GET /requests/r9/status': { json: { status: 'completed', images: [{ url: 'https://cdn.example/r9.jpg' }] } },
      'GET /r9.jpg': { bytes: 'JPEGBYTES', headers: { 'content-type': 'image/jpeg' } }
    });
    const r = await hf.generatePhoto({ config: CFG, prompt: 'a quiet surgery', fetchImpl: s.fetchImpl, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.buffer.toString()).toBe('JPEGBYTES');
    expect(r.contentType).toBe('image/jpeg');
    expect(r.requestId).toBe('r9');
  });
});
