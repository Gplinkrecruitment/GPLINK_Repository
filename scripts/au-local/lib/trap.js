'use strict';
/*
 * The outbound trap, gateway side.
 *
 * preload.js redirects every request the app makes to an outside host to
 * POST/GET/... http://127.0.0.1:<gateway>/__trap__ with the real address in the
 * `x-aulocal-target` header. This module records the request in the Outbox and
 * answers with a realistic canned success, so the app carries on as if the
 * outside service had accepted the message. Nothing is forwarded anywhere.
 *
 * An unrecognised host is recorded too and answered with HTTP 503 (default-deny).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config.js');
const { clip } = require('./outbox.js');

const uid = () => crypto.randomUUID();
const json = (body, status, headers) => ({ status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });

function parseJson(buf) { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } }
function parseForm(buf) { const out = {}; try { for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) out[k] = v; } catch (e) { /* none */ } return out; }
function asList(v) { return (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])).map(String); }
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => label.replace(/<[^>]+>/g, '').trim() + ' [' + href + ']')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── minimal RFC 822 / MIME reader (for Gmail API "raw" messages) ──────────────
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, data) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8');
      return Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))), 'binary').toString('utf8');
    } catch (e) { return m; }
  });
}
function parseMime(buffer) {
  const text = buffer.toString('binary');
  const split = text.search(/\r?\n\r?\n/);
  const headText = split === -1 ? text : text.slice(0, split);
  const bodyText = split === -1 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  headText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = decodeWords(Buffer.from(line.slice(i + 1).trim(), 'binary').toString('utf8'));
  });
  const ctype = headers['content-type'] || 'text/plain';
  const out = { headers, text: '', html: '', attachments: [] };
  const boundary = /boundary="?([^";]+)"?/i.exec(ctype);
  if (/^multipart\//i.test(ctype) && boundary) {
    const parts = bodyText.split('--' + boundary[1]);
    for (const part of parts.slice(1)) {
      if (part.startsWith('--')) break;
      const sub = parseMime(Buffer.from(part.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), 'binary'));
      if (sub.text && !out.text) out.text = sub.text;
      if (sub.html && !out.html) out.html = sub.html;
      out.attachments.push(...sub.attachments);
    }
    return out;
  }
  const enc = String(headers['content-transfer-encoding'] || '').toLowerCase();
  let data;
  if (enc === 'base64') data = Buffer.from(bodyText.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') data = Buffer.from(bodyText.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
  else data = Buffer.from(bodyText, 'binary');
  const disp = headers['content-disposition'] || '';
  const fname = /filename\*?="?([^";]+)"?/i.exec(disp) || /name="?([^";]+)"?/i.exec(ctype);
  if (/attachment/i.test(disp) || (fname && !/^text\//i.test(ctype))) {
    out.attachments.push({ name: decodeWords(fname ? fname[1] : 'attachment'), type: ctype.split(';')[0].trim(), buffer: data });
  } else if (/^text\/html/i.test(ctype)) out.html = data.toString('utf8');
  else out.text = data.toString('utf8');
  return out;
}

function futureSlots() {
  const slots = [];
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  for (let day = 1; slots.length < 24 && day < 14; day++) {
    const base = new Date(d.getTime() + day * 86400000);
    if (base.getUTCDay() === 0 || base.getUTCDay() === 6) continue;
    for (const hour of [0, 1, 2, 22, 23]) { // roughly Australian business hours, in UTC
      const t = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, 0, 0));
      slots.push({ status: 'available', invitees_remaining: 1, start_time: t.toISOString(), scheduling_url: 'https://calendly.com/aulocal-fake/30min/' + t.toISOString() });
    }
  }
  return slots;
}

// ~/gplink-tools/au-local/whatsapp-unapproved-templates.txt: one template name per
// line ("#" starts a comment; a trailing * matches any ending, e.g. gp_link_au_*).
// Read on every send, so it can be edited while the stack is running.
function isUnapprovedTemplate(name) {
  let text = '';
  try { text = fs.readFileSync(path.join(cfg.AU_HOME, 'whatsapp-unapproved-templates.txt'), 'utf8'); } catch (e) { return false; }
  const n = String(name || '').trim().toLowerCase();
  return text.split('\n').map((l) => l.replace(/#.*$/, '').trim().toLowerCase()).filter(Boolean)
    .some((p) => (p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p));
}

function createTrap(deps) {
  const { outbox, allowAi } = deps;

  function record(entry, req) {
    return outbox.append(Object.assign({
      url: req.url, method: req.method, host: req.host,
      request: clip(req.bodyText, 60000)
    }, entry));
  }

  /*
   * req = { method, url, host, path, search (URLSearchParams), headers, body (Buffer), bodyText }
   * returns { status, headers, body }
   */
  function respond(req) {
    const { method, host, path } = req;
    const body = req.body || Buffer.alloc(0);
    const j = parseJson(body);

    // ── Email: Resend ─────────────────────────────────────────────────────────
    if (host === 'api.resend.com') {
      if (method === 'POST' && /^\/emails(\/batch)?\/?$/.test(path)) {
        const list = Array.isArray(j) ? j : [j || {}];
        const ids = [];
        for (const m of list) {
          const atts = [];
          for (const a of (Array.isArray(m.attachments) ? m.attachments : [])) {
            if (a && a.content) {
              const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content), 'base64');
              atts.push(outbox.saveFile(a.filename || 'attachment', buf, a.content_type || a.contentType));
            } else if (a && a.path) atts.push({ name: a.filename || a.path, type: 'link', size: 0, link: a.path });
          }
          const id = uid();
          ids.push({ id });
          record({
            channel: 'email', service: 'Resend', to: asList(m.to), cc: asList(m.cc), bcc: asList(m.bcc), from: m.from || '',
            replyTo: asList(m.reply_to || m.replyTo).join(', '), subject: m.subject || '(no subject)',
            html: clip(m.html || ''), text: clip(m.text || htmlToText(m.html || '')), attachments: atts,
            tags: m.tags || undefined, status: 200, providerId: id
          }, Object.assign({}, req, { bodyText: '(see message fields)' }));
        }
        return json(Array.isArray(j) ? { data: ids } : ids[0]);
      }
      record({ kind: 'system', service: 'Resend', subject: method + ' ' + path, status: 200 }, req);
      return json({ id: uid(), object: 'email', last_event: 'delivered' });
    }

    // ── WhatsApp: DoubleTick ──────────────────────────────────────────────────
    if (/(^|\.)doubletick\.io$/.test(host)) {
      const tplMatch = /\/whatsapp\/message\/(template|text|image|document|video|audio|interactive)/.exec(path) || /\/message\/(text)/.exec(path);
      if (method === 'POST' && tplMatch) {
        const list = (j && Array.isArray(j.messages)) ? j.messages : [j || {}];
        const results = [];
        for (const m of list) {
          const c = m.content || {};
          const td = c.templateData || {};
          const vars = (td.body && Array.isArray(td.body.placeholders)) ? td.body.placeholders : [];
          const id = uid();
          const lines = [];
          if (c.templateName) {
            lines.push('WhatsApp TEMPLATE: ' + c.templateName + ' (language ' + (c.language || 'en') + ')');
            vars.forEach((v, i) => lines.push('  {{' + (i + 1) + '}} = ' + v));
            if (td.header) lines.push('  header: ' + JSON.stringify(td.header));
            if (td.buttons) lines.push('  buttons: ' + JSON.stringify(td.buttons));
            lines.push('', 'The wording of an approved template lives in DoubleTick / Meta, not in the app, so only the template name and the values filled into it are shown here.');
          } else {
            lines.push(c.text || c.caption || JSON.stringify(c));
            if (c.mediaUrl || c.url) lines.push('', 'media: ' + (c.mediaUrl || c.url));
          }
          // DoubleTick answers HTTP 200 with status FAILED when a template is not
          // approved yet. Names listed in whatsapp-unapproved-templates.txt get
          // that answer, so the app's "no approved template" behaviour can be tested.
          const unapproved = !!c.templateName && isUnapprovedTemplate(c.templateName);
          record({
            channel: 'whatsapp', service: 'DoubleTick', to: asList(m.to), from: m.from || '',
            subject: (unapproved ? 'NOT DELIVERED (template not approved): ' : (c.templateName ? 'Template: ' : '')) + (c.templateName || 'Free-text WhatsApp message'),
            template: c.templateName || '', variables: vars, text: lines.join('\n'), status: 200, providerId: id,
            note: unapproved ? 'Simulated failure: this template is listed in whatsapp-unapproved-templates.txt, so the app was told WhatsApp refused it (as happens live while a template awaits approval). Nobody would have received this.' : undefined
          }, req);
          if (unapproved) results.push({ status: 'FAILED', recipient: m.to || '', errorMessage: 'Template with given name and language not found' });
          else results.push({ status: 'SENT', recipient: m.to || '', messageId: id });
        }
        return json({ messages: results });
      }
      if (path.includes('/whatsapp/templates')) {
        record({ kind: 'system', service: 'DoubleTick', subject: 'template list read', status: 200 }, req);
        return json({ templates: [], data: [], totalCount: 0 });
      }
      if (path.includes('/chat-messages')) {
        record({ kind: 'system', service: 'DoubleTick', subject: 'chat history read', status: 200 }, req);
        return json({ messages: [], data: [] });
      }
      if (path.includes('/embed/url')) {
        record({ kind: 'system', service: 'DoubleTick', subject: 'chat embed link', status: 200 }, req);
        return json({ url: 'https://web.doubletick.io/embed/aulocal-fake' });
      }
      record({ kind: 'system', service: 'DoubleTick', subject: method + ' ' + path + ' (a change in DoubleTick, e.g. assign / tag)', status: 200 }, req);
      return json({ success: true, status: 'success' });
    }

    // ── Google: tokens ────────────────────────────────────────────────────────
    if ((host === 'oauth2.googleapis.com' || host === 'www.googleapis.com' || host === 'accounts.google.com') && /\/token\/?$/.test(path)) {
      record({ kind: 'system', service: 'Google sign-in (token)', subject: 'access token requested', status: 200, request: '(credentials not kept)' }, Object.assign({}, req, { bodyText: '' }));
      return json({ access_token: 'aulocal-fake-google-token', expires_in: 3599, token_type: 'Bearer', scope: '' });
    }

    // ── Google: Gmail ─────────────────────────────────────────────────────────
    if ((host === 'gmail.googleapis.com' || host === 'www.googleapis.com') && /\/gmail\/v1\//.test(path)) {
      const user = decodeURIComponent((/\/users\/([^/]+)\//.exec(path) || [])[1] || 'me');
      if (method === 'POST' && /\/(messages|drafts)\/send/.test(path)) {
        let rawBuf = null;
        if (j && j.raw) rawBuf = Buffer.from(String(j.raw), 'base64url');
        else if (j && j.message && j.message.raw) rawBuf = Buffer.from(String(j.message.raw), 'base64url');
        else {
          const idx = body.indexOf('\r\n\r\n');
          rawBuf = /multipart|message\/rfc822/i.test(String(req.headers['content-type'] || '')) && idx !== -1 ? body : body;
        }
        const mime = parseMime(rawBuf || Buffer.alloc(0));
        const atts = mime.attachments.map((a) => outbox.saveFile(a.name, a.buffer, a.type));
        const id = crypto.randomBytes(8).toString('hex');
        record({
          channel: 'email', service: 'Gmail (sent as ' + user + ')', to: asList(mime.headers.to), cc: asList(mime.headers.cc), bcc: asList(mime.headers.bcc),
          from: mime.headers.from || user, subject: mime.headers.subject || '(no subject)',
          html: clip(mime.html), text: clip(mime.text || htmlToText(mime.html)), attachments: atts,
          threadId: (j && j.threadId) || '', status: 200, providerId: id
        }, Object.assign({}, req, { bodyText: '(raw email, see message fields)' }));
        return json({ id, threadId: (j && j.threadId) || id, labelIds: ['SENT'] });
      }
      record({ kind: 'system', service: 'Gmail', subject: method + ' ' + path.replace(/^.*\/gmail\/v1/, ''), status: 200 }, req);
      if (/\/watch$/.test(path)) return json({ historyId: '1', expiration: String(Date.now() + 6 * 86400000) });
      if (/\/stop$/.test(path)) return { status: 204, headers: {}, body: '' };
      if (/\/profile$/.test(path)) return json({ emailAddress: user, messagesTotal: 0, threadsTotal: 0, historyId: '1' });
      if (/\/history$/.test(path)) return json({ history: [], historyId: '1' });
      if (/\/labels$/.test(path) && method === 'GET') return json({ labels: [] });
      if (/\/labels$/.test(path) && method === 'POST') return json({ id: 'Label_aulocal_' + crypto.randomBytes(3).toString('hex'), name: (j && j.name) || 'label' });
      if (/\/(messages|threads|drafts)$/.test(path) && method === 'GET') return json({ messages: [], threads: [], drafts: [], resultSizeEstimate: 0 });
      if (/\/drafts$/.test(path) && method === 'POST') return json({ id: 'draft-' + uid(), message: { id: crypto.randomBytes(8).toString('hex'), threadId: crypto.randomBytes(8).toString('hex'), labelIds: ['DRAFT'] } });
      if (method === 'GET') return json({ error: { code: 404, message: 'Requested entity was not found. (local test stack: no real mailbox)', status: 'NOT_FOUND' } }, 404);
      return json({ id: crypto.randomBytes(8).toString('hex'), labelIds: [] });
    }

    // ── Google: Calendar ──────────────────────────────────────────────────────
    if (host === 'www.googleapis.com' && /\/calendar\/v3\//.test(path)) {
      if (/\/freeBusy$/.test(path)) {
        const calendars = {};
        for (const it of ((j && j.items) || [])) calendars[it.id] = { busy: [] };
        record({ kind: 'system', service: 'Google Calendar', subject: 'diary free/busy lookup (answered: nothing booked)', status: 200 }, req);
        return json({ kind: 'calendar#freeBusy', timeMin: j && j.timeMin, timeMax: j && j.timeMax, calendars });
      }
      if (method === 'POST' && /\/events(\?|$)/.test(path + '?')) {
        const id = 'aulocal' + crypto.randomBytes(8).toString('hex');
        const attendees = ((j && j.attendees) || []).map((a) => a.email).filter(Boolean);
        const when = (j && j.start && (j.start.dateTime || j.start.date)) || '';
        record({
          channel: 'calendar', service: 'Google Calendar invitation', to: attendees,
          subject: 'Calendar invitation: ' + ((j && j.summary) || '(no title)'),
          text: 'Google would email this invitation to every attendee' + (req.search.get('sendUpdates') === 'all' ? ' (sendUpdates=all).' : '.') +
            '\n\nTitle: ' + ((j && j.summary) || '') + '\nWhen: ' + when + ' to ' + ((j && j.end && (j.end.dateTime || j.end.date)) || '') +
            '\nWhere: ' + ((j && j.location) || '') + '\nAttendees: ' + attendees.join(', ') + '\n\n' + ((j && j.description) || ''),
          status: 200, providerId: id
        }, req);
        return json(Object.assign({}, j || {}, { kind: 'calendar#event', id, status: 'confirmed', htmlLink: 'https://calendar.google.com/calendar/event?eid=' + id, created: new Date().toISOString(), updated: new Date().toISOString() }));
      }
      if (method === 'DELETE') {
        record({ channel: 'calendar', service: 'Google Calendar cancellation', to: [], subject: 'Calendar event cancelled: ' + path.split('/').pop(), text: 'Google would email a cancellation to the attendees of this event.', status: 204 }, req);
        return { status: 204, headers: {}, body: '' };
      }
      if (method === 'PATCH' || method === 'PUT') {
        record({ channel: 'calendar', service: 'Google Calendar update', to: ((j && j.attendees) || []).map((a) => a.email), subject: 'Calendar event updated: ' + ((j && j.summary) || path.split('/').pop()), text: JSON.stringify(j, null, 2), status: 200 }, req);
        return json(Object.assign({ id: path.split('/').pop(), status: 'confirmed' }, j || {}));
      }
      record({ kind: 'system', service: 'Google Calendar', subject: method + ' ' + path, status: 200 }, req);
      return json({ kind: 'calendar#events', items: [] });
    }

    // ── Google: Drive / Docs / Pub/Sub ────────────────────────────────────────
    if ((host === 'www.googleapis.com' && /\/(upload\/)?drive\/v[23]\//.test(path)) || host === 'docs.googleapis.com' || host === 'sheets.googleapis.com') {
      record({ kind: 'system', service: 'Google Drive', subject: method + ' ' + path.replace(/^.*\/drive\/v[23]/, ''), status: 200, request: clip(req.bodyText, 2000) }, req);
      if (method === 'DELETE') return { status: 204, headers: {}, body: '' };
      if (method === 'GET' && /\/files\/?$/.test(path)) return json({ kind: 'drive#fileList', files: [], incompleteSearch: false });
      if (method === 'GET' && /\/permissions/.test(path)) return json({ permissions: [] });
      if (method === 'GET' && req.search.get('alt') === 'media') return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { code: 404, message: 'File not found (local test stack: no real Drive)' } }) };
      const id = 'aulocal-drive-' + crypto.randomBytes(6).toString('hex');
      if (method === 'GET') return json({ id: path.split('/').pop(), name: 'local-test-file', mimeType: 'application/vnd.google-apps.folder', parents: [], webViewLink: 'https://drive.google.com/drive/folders/' + id, trashed: false });
      const meta = (j && typeof j === 'object') ? j : {};
      return json({ kind: 'drive#file', id, name: meta.name || 'local-test-file', mimeType: meta.mimeType || 'application/octet-stream', parents: meta.parents || [], webViewLink: 'https://drive.google.com/file/d/' + id + '/view', webContentLink: 'https://drive.google.com/uc?id=' + id });
    }
    if (host === 'pubsub.googleapis.com') {
      record({ kind: 'system', service: 'Google Pub/Sub', subject: method + ' ' + path, status: 200 }, req);
      return json({});
    }
    if (host === 'maps.googleapis.com' || host === 'places.googleapis.com') {
      record({ kind: 'system', service: 'Google Maps', subject: 'lookup: ' + path, status: 200 }, req);
      return json({ status: 'ZERO_RESULTS', results: [], predictions: [], candidates: [], places: [], rows: [] });
    }

    // ── Zoom ──────────────────────────────────────────────────────────────────
    if (host === 'zoom.us' && /\/oauth\/token/.test(path)) {
      record({ kind: 'system', service: 'Zoom sign-in (token)', subject: 'access token requested', status: 200 }, Object.assign({}, req, { bodyText: '' }));
      return json({ access_token: 'aulocal-fake-zoom-token', token_type: 'bearer', expires_in: 3599, scope: 'meeting:write:admin' });
    }
    if (host === 'api.zoom.us') {
      if (method === 'POST' && /\/meetings\/?$/.test(path)) {
        const id = 80000000000 + crypto.randomInt(0, 9999999999);
        record({
          channel: 'calendar', service: 'Zoom meeting created', to: [], subject: 'Zoom meeting: ' + ((j && j.topic) || '(no topic)'),
          text: 'A Zoom meeting would be created.\n\nTopic: ' + ((j && j.topic) || '') + '\nStarts: ' + ((j && j.start_time) || '') + ' (' + ((j && j.timezone) || 'UTC') + ')\nLength: ' + ((j && j.duration) || '') + ' minutes\nFake join link: https://zoom.us/j/' + id,
          status: 201, providerId: String(id)
        }, req);
        return json({ uuid: crypto.randomBytes(12).toString('base64'), id, host_id: 'aulocal-host', host_email: 'zoom@gplink-test.local', topic: (j && j.topic) || '', type: 2, status: 'waiting',
          start_time: (j && j.start_time) || new Date().toISOString(), duration: (j && j.duration) || 30, timezone: (j && j.timezone) || 'UTC', created_at: new Date().toISOString(),
          start_url: 'https://zoom.us/s/' + id + '?zak=aulocal-fake', join_url: 'https://zoom.us/j/' + id + '?pwd=aulocalfake', password: 'aulocal', settings: (j && j.settings) || {} }, 201);
      }
      record({ kind: 'system', service: 'Zoom', subject: method + ' ' + path, status: 200 }, req);
      if (method === 'DELETE' || method === 'PATCH' || method === 'PUT') return { status: 204, headers: {}, body: '' };
      if (/\/meetings\/?$/.test(path)) return json({ page_size: 300, total_records: 0, next_page_token: '', meetings: [] });
      if (/\/meeting_summary|\/recordings|\/past_meetings/.test(path)) return json({ code: 3001, message: 'Meeting does not exist (local test stack: no real Zoom)' }, 404);
      return json({});
    }

    // ── Calendly ──────────────────────────────────────────────────────────────
    if (host === 'api.calendly.com') {
      if (method === 'POST' && /\/scheduling_links/.test(path)) {
        const url = 'https://calendly.com/d/aulocal-' + crypto.randomBytes(4).toString('hex') + '/gp-link-call';
        record({ kind: 'system', service: 'Calendly', subject: 'single-use booking link created: ' + url, status: 201 }, req);
        return json({ resource: { booking_url: url, owner: (j && j.owner) || '', owner_type: 'EventType' } }, 201);
      }
      if (method === 'POST' && /\/invitees/.test(path)) {
        const ev = 'AULOCAL' + crypto.randomBytes(6).toString('hex').toUpperCase();
        const inv = (j && j.invitee) || j || {};
        record({
          channel: 'calendar', service: 'Calendly booking', to: asList(inv.email), subject: 'Calendly booking for ' + (inv.name || inv.email || 'invitee') + ' at ' + ((j && j.start_time) || ''),
          text: 'A booking would be made in Calendly. Calendly itself would then email the invitee a confirmation and calendar invitation.\n\n' + JSON.stringify(j, null, 2) +
            '\n\nNote: the local stack does not call the app\'s Calendly webhook afterwards. Production relies on that webhook to record the booking.',
          status: 201, providerId: ev
        }, req);
        return json({ resource: { uri: 'https://api.calendly.com/scheduled_events/' + ev + '/invitees/' + uid(), event: 'https://api.calendly.com/scheduled_events/' + ev, email: inv.email || '', name: inv.name || '', status: 'active', timezone: inv.timezone || 'UTC',
          cancel_url: 'https://calendly.com/cancellations/aulocal-fake', reschedule_url: 'https://calendly.com/reschedulings/aulocal-fake', created_at: new Date().toISOString() } }, 201);
      }
      record({ kind: 'system', service: 'Calendly', subject: method + ' ' + path, status: 200 }, req);
      if (/\/users\/me/.test(path)) return json({ resource: { uri: 'https://api.calendly.com/users/AULOCALUSER', name: 'Local Test Host', email: 'calendly@gplink-test.local', scheduling_url: 'https://calendly.com/aulocal-fake', timezone: 'Australia/Sydney', current_organization: 'https://api.calendly.com/organizations/AULOCALORG' } });
      if (/\/event_type_available_times/.test(path)) return json({ collection: futureSlots() });
      if (/\/event_types\/[^/]+$/.test(path)) return json({ resource: { uri: 'https://api.calendly.com/event_types/' + path.split('/').pop(), name: 'GP Link call (local test)', active: true, slug: '30min', scheduling_url: 'https://calendly.com/aulocal-fake/30min', duration: 30, kind: 'solo', type: 'StandardEventType', profile: { type: 'User', name: 'Local Test Host', owner: 'https://api.calendly.com/users/AULOCALUSER' }, locations: [{ kind: 'zoom_conference' }], custom_questions: [] } });
      if (/\/event_types/.test(path)) return json({ collection: [], pagination: { count: 0, next_page: null, next_page_token: null } });
      if (/\/scheduled_events\/[^/]+\/invitees/.test(path)) return json({ collection: [], pagination: { count: 0, next_page: null } });
      if (/\/scheduled_events\/[^/]+$/.test(path)) return json({ title: 'Resource Not Found', message: 'No such event (local test stack: no real Calendly)' }, 404);
      if (method === 'GET') return json({ collection: [], pagination: { count: 0, next_page: null, next_page_token: null } });
      return json({ resource: {} });
    }

    // ── Hazel: Retell ─────────────────────────────────────────────────────────
    if (host === 'api.retellai.com') {
      if (method === 'POST' && /create-phone-call|create-web-call|create-batch-call/.test(path)) {
        const id = 'aulocal_call_' + crypto.randomBytes(8).toString('hex');
        record({
          channel: 'call', service: 'Retell (Hazel AI phone call)', to: asList(j && j.to_number), from: (j && j.from_number) || '',
          subject: 'AI phone call to ' + ((j && j.to_number) || '(unknown number)'),
          text: 'Hazel would ring this number now.\n\nAgent: ' + ((j && (j.override_agent_id || j.agent_id)) || '') + '\nWhat she is told about the lead:\n' + JSON.stringify((j && j.retell_llm_dynamic_variables) || {}, null, 2) + '\n\nmetadata: ' + JSON.stringify((j && j.metadata) || {}, null, 2),
          status: 201, providerId: id
        }, req);
        return json({ call_id: id, call_type: 'phone_call', call_status: 'registered', agent_id: (j && (j.override_agent_id || j.agent_id)) || 'aulocal-retell-agent', from_number: (j && j.from_number) || '', to_number: (j && j.to_number) || '', direction: 'outbound', metadata: (j && j.metadata) || {} }, 201);
      }
      record({ kind: 'system', service: 'Retell', subject: method + ' ' + path, status: 200 }, req);
      if (method === 'GET' && /get-call\//.test(path)) return json({ call_id: path.split('/').pop(), call_status: 'ended', disconnection_reason: 'dial_no_answer', transcript: '', call_analysis: {} });
      if (method === 'GET' || /list-/.test(path)) return json([]);
      return json({});
    }

    // ── SMS: Twilio ───────────────────────────────────────────────────────────
    if (/(^|\.)twilio\.com$/.test(host)) {
      const f = parseForm(body);
      if (method === 'POST' && /\/Messages/.test(path)) {
        const sid = 'SM' + crypto.randomBytes(16).toString('hex');
        record({ channel: 'sms', service: 'Twilio SMS', to: asList(f.To), from: f.From || '', subject: 'SMS to ' + (f.To || ''), text: f.Body || '', status: 201, providerId: sid }, req);
        return json({ sid, status: 'queued', to: f.To || '', from: f.From || '', body: f.Body || '' }, 201);
      }
      if (method === 'POST' && /\/Calls/.test(path)) {
        const sid = 'CA' + crypto.randomBytes(16).toString('hex');
        record({ channel: 'call', service: 'Twilio call', to: asList(f.To), from: f.From || '', subject: 'Phone call to ' + (f.To || ''), text: JSON.stringify(f, null, 2), status: 201, providerId: sid }, req);
        return json({ sid, status: 'queued' }, 201);
      }
      record({ kind: 'system', service: 'Twilio', subject: method + ' ' + path, status: 200 }, req);
      return json({});
    }

    // ── Meta (Facebook / Instagram / Conversions API) ─────────────────────────
    if (host === 'graph.facebook.com' || host === 'graph.instagram.com') {
      if (method === 'POST' && /\/events\/?$/.test(path)) {
        const data = (j && j.data) || parseJson(Buffer.from(parseForm(body).data || '[]')) || [];
        record({ kind: 'system', channel: 'other', service: 'Meta Conversions API', subject: 'Conversion event(s): ' + (Array.isArray(data) ? data.map((e) => e.event_name).join(', ') : ''), text: JSON.stringify(data, null, 2), status: 200 }, req);
        return json({ events_received: Array.isArray(data) ? data.length : 1, messages: [], fbtrace_id: 'aulocal' + crypto.randomBytes(5).toString('hex') });
      }
      if (method === 'POST') {
        record({ channel: 'other', service: 'Meta (Facebook / Instagram) change', to: [], subject: 'Meta write: ' + method + ' ' + path, text: 'The app tried to change something in Meta (post, ad, message or setting).\n\n' + clip(req.bodyText, 4000), status: 200 }, req);
        return json({ id: '1' + crypto.randomInt(0, 1e12), success: true });
      }
      record({ kind: 'system', service: 'Meta', subject: method + ' ' + path, status: 200 }, req);
      return json({ data: [], paging: {} });
    }

    // ── Xero ──────────────────────────────────────────────────────────────────
    if (/(^|\.)xero\.com$/.test(host)) {
      record({ channel: 'other', service: 'Xero', to: [], subject: 'Xero: ' + method + ' ' + path, text: clip(req.bodyText, 4000), status: 200 }, req);
      if (/\/connect\/token/.test(path)) return json({ access_token: 'aulocal-fake-xero-token', expires_in: 1800, token_type: 'Bearer', refresh_token: 'aulocal-fake-xero-refresh' });
      return json({ Id: uid(), Status: 'OK', Invoices: [], Contacts: [] });
    }

    // ── Web push ──────────────────────────────────────────────────────────────
    if (host === 'fcm.googleapis.com' || /\.push\.apple\.com$/.test(host) || host === 'updates.push.services.mozilla.com' || /\.notify\.windows\.com$/.test(host) || /(^|\.)push\.services\.mozilla\.com$/.test(host)) {
      record({ channel: 'push', service: 'Web push notification', to: [host], subject: 'Push notification to a ' + host + ' device', text: 'A push notification would be delivered. Its content is encrypted for the device, so it cannot be shown here. The in-app bell holds the same text.', status: 201, request: '(encrypted payload, ' + body.length + ' bytes)' }, Object.assign({}, req, { bodyText: '' }));
      return { status: 201, headers: { Location: 'https://' + host + '/aulocal-fake', TTL: '60' }, body: '' };
    }

    // ── AI ────────────────────────────────────────────────────────────────────
    if (host === 'api.anthropic.com' || host === 'api.openai.com') {
      const model = (j && j.model) || '';
      const notice = '[LOCAL TEST STACK: AI is switched off, so this is a placeholder and not a real AI answer. Start with AU_LOCAL_ALLOW_AI=1 to allow real AI calls.]';
      record({ kind: 'system', channel: 'ai', service: (host === 'api.anthropic.com' ? 'Anthropic' : 'OpenAI') + ' (BLOCKED, placeholder answer returned)', subject: 'AI request blocked: ' + model, status: 200, request: clip(req.bodyText, 3000) }, req);
      if (host === 'api.openai.com') {
        return json({ id: 'chatcmpl-aulocal', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: notice }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      if (/\/models/.test(path)) return json({ data: [], has_more: false, first_id: null, last_id: null });
      if (j && j.stream) {
        const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n';
        const sse = ev('message_start', { message: { id: 'msg_aulocal', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }) +
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: notice } }) +
          ev('content_block_stop', { index: 0 }) +
          ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }) +
          ev('message_stop', {});
        return { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse };
      }
      return json({ id: 'msg_aulocal', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: notice }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } });
    }

    // ── Read-only lookups the app makes (answered "nothing found") ────────────
    if (host === 'nominatim.openstreetmap.org') {
      record({ kind: 'system', service: 'OpenStreetMap lookup', subject: 'address lookup (answered: nothing found)', status: 200 }, req);
      return json([]);
    }

    // ── Anything else: default-deny ───────────────────────────────────────────
    record({ kind: 'system', channel: 'blocked', service: 'BLOCKED: ' + host, subject: 'Blocked request to an outside address: ' + method + ' https://' + host + path, text: 'This address is not one the local stack fakes, so the request was stopped and answered with an error (HTTP 503).', status: 503 }, req);
    return json({ error: 'blocked_by_local_test_stack', message: 'Outbound request to ' + host + ' was blocked by the GP Link local test stack.' }, 503);
  }

  void allowAi;
  return { respond };
}

module.exports = { createTrap, parseMime, htmlToText };
