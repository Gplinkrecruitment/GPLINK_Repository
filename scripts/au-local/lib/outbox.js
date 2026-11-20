'use strict';
/*
 * The Outbox: every message the app tried to send to the outside world, kept on
 * this Mac instead. One JSON object per line in ~/gplink-tools/au-local/outbox.jsonl.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config.js');

const MAX_TEXT = 400000;

function clip(value, max) {
  const s = typeof value === 'string' ? value : (value == null ? '' : JSON.stringify(value));
  const limit = max || MAX_TEXT;
  return s.length > limit ? s.slice(0, limit) + '\n...[truncated ' + (s.length - limit) + ' characters]' : s;
}

function createOutbox() {
  cfg.ensureDirs();

  function append(entry) {
    const full = Object.assign({ id: crypto.randomUUID(), ts: new Date().toISOString(), kind: 'message', channel: 'other' }, entry);
    fs.appendFileSync(cfg.PATHS.outbox, JSON.stringify(full) + '\n');
    return full;
  }

  // Saves an attachment so it can be opened from the Outbox page.
  function saveFile(name, buffer, type) {
    const id = crypto.randomUUID();
    const safe = String(name || 'attachment').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'attachment';
    const dir = path.join(cfg.PATHS.outboxFiles, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), buffer);
    return { name: safe, type: type || 'application/octet-stream', size: buffer.length, file: id + '/' + safe };
  }

  function readAll() {
    let text = '';
    try { text = fs.readFileSync(cfg.PATHS.outbox, 'utf8'); } catch (e) { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* skip a damaged line */ }
    }
    return out;
  }

  function clear() {
    fs.writeFileSync(cfg.PATHS.outbox, '');
    fs.rmSync(cfg.PATHS.outboxFiles, { recursive: true, force: true });
    fs.mkdirSync(cfg.PATHS.outboxFiles, { recursive: true });
  }

  // Emails Supabase Auth itself would send in production (not the app).
  function recordSystemEmail(msg) {
    return append({
      kind: 'message', channel: 'email', service: 'Supabase Auth (its own email)',
      to: [msg.to], from: 'Supabase Auth <noreply@mail.app.supabase.io>', subject: msg.subject,
      text: msg.text, html: msg.html, note: msg.note, status: 200
    });
  }

  function note(service, text) {
    return append({ kind: 'system', channel: 'other', service, subject: text, text, status: 0 });
  }

  return { append, saveFile, readAll, clear, recordSystemEmail, note, clip };
}

module.exports = { createOutbox, clip };
