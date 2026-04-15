import { describe, it, expect } from 'vitest';

// ── parseGmailPubSubMessage (inline copy) ──
function parseGmailPubSubMessage(body) {
  try {
    if (!body || !body.message || !body.message.data) return null;
    var decoded = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf-8'));
    if (!decoded.emailAddress || !decoded.historyId) return null;
    return { emailAddress: decoded.emailAddress, historyId: String(decoded.historyId) };
  } catch (e) { return null; }
}

// ── extractEmailMeta (inline copy) ──
function extractEmailMeta(gmailMessage) {
  var headers = gmailMessage.payload ? gmailMessage.payload.headers || [] : [];
  var getHeader = function (name) { var h = headers.find(function (h) { return h.name.toLowerCase() === name.toLowerCase(); }); return h ? h.value : ''; };

  var fromRaw = getHeader('From');
  var sender = fromRaw;
  var senderName = '';
  var angleMatch = fromRaw.match(/<([^>]+)>/);
  if (angleMatch) {
    sender = angleMatch[1];
    senderName = fromRaw.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
  }

  var parts = gmailMessage.payload ? gmailMessage.payload.parts || [] : [];
  var bodyText = '';
  var attachments = [];
  var attachIdx = 0;

  function walkParts(partsList) {
    for (var i = 0; i < partsList.length; i++) {
      var part = partsList[i];
      if (part.mimeType === 'text/plain' && part.body && part.body.data && !bodyText) {
        bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
      if (part.filename && part.body && part.body.attachmentId) {
        var isInline = (part.headers || []).some(function (h) { return h.name === 'Content-Disposition' && h.value.startsWith('inline'); });
        var isSmallImage = (part.body.size || 0) < 10240 && part.mimeType && part.mimeType.startsWith('image/');
        if (!(isInline && isSmallImage)) {
          attachments.push({
            index: attachIdx++,
            filename: part.filename,
            mimeType: part.mimeType,
            attachmentId: part.body.attachmentId,
            size: part.body.size || 0
          });
        }
      }
      if (part.parts) walkParts(part.parts);
    }
  }
  walkParts(parts);

  return {
    messageId: gmailMessage.id,
    sender: sender,
    senderName: senderName,
    subject: getHeader('Subject'),
    to: getHeader('To'),
    date: getHeader('Date'),
    bodyText: bodyText.substring(0, 2000),
    attachments: attachments
  };
}

// ── preFilterEmail (inline copy) ──
var GMAIL_DOCUMENT_EXTENSIONS = /\.(pdf|doc|docx|jpg|jpeg|png)$/i;
var GMAIL_NOREPLY_PATTERNS = /^(noreply|no-reply|donotreply|do-not-reply|newsletter|marketing|mailer-daemon|postmaster)@/i;

function preFilterEmail(emailMeta) {
  if (emailMeta.sender && emailMeta.sender.toLowerCase().endsWith('@mygplink.com.au')) {
    return { pass: false, reason: 'internal_sender' };
  }
  if (!emailMeta.attachments || emailMeta.attachments.length === 0) {
    return { pass: false, reason: 'no_attachments' };
  }
  var hasDocAttachment = emailMeta.attachments.some(function (a) {
    return GMAIL_DOCUMENT_EXTENSIONS.test(a.filename || '');
  });
  if (!hasDocAttachment) {
    return { pass: false, reason: 'no_document_attachments' };
  }
  if (GMAIL_NOREPLY_PATTERNS.test(emailMeta.sender || '')) {
    return { pass: false, reason: 'marketing' };
  }
  if (emailMeta.headers && emailMeta.headers['list-unsubscribe']) {
    return { pass: false, reason: 'marketing' };
  }
  return { pass: true, reason: null };
}

// ── buildAIMatchPrompt (inline copy) ──
function buildAIMatchPrompt(emailMeta, openTasks) {
  var tasksSection = openTasks.length > 0
    ? JSON.stringify(openTasks, null, 2)
    : 'No open tasks currently waiting for documents.';

  return 'You are a document-matching assistant for GP Link, a medical recruitment company that helps overseas GPs register in Australia.\n\n'
    + 'An email has arrived with attachments. Match each attachment to the correct open task.\n\n'
    + 'EMAIL:\n'
    + '- From: ' + emailMeta.sender + ' (' + emailMeta.senderName + ')\n'
    + '- To: ' + emailMeta.to + '\n'
    + '- Subject: ' + emailMeta.subject + '\n'
    + '- Date: ' + emailMeta.date + '\n'
    + '- Body (first 2000 chars): ' + emailMeta.bodyText + '\n'
    + '- Attachments: ' + JSON.stringify(emailMeta.attachments.map(function (a) { return { index: a.index, filename: a.filename, mime_type: a.mimeType, size_bytes: a.size }; })) + '\n\n'
    + 'OPEN TASKS WAITING FOR DOCUMENTS:\n' + tasksSection + '\n\n'
    + 'Return ONLY a JSON object (no markdown, no explanation):\n'
    + '{\n  "matches": [\n    {\n      "attachment_index": 0,\n      "task_id": "xxx" or null,\n      "document_type": "offer_contract" or "supervisor_cv",\n      "confidence": 0.0-1.0,\n      "reasoning": "brief explanation"\n    }\n  ],\n  "is_relevant": true/false,\n  "summary": "one-line description of what this email is about"\n}\n\n'
    + 'Rules:\n'
    + '- Match based on sender domain vs practice email domain, GP names in subject/body/filename, document type clues\n'
    + '- If sender domain matches a practice contact\'s domain, that\'s a strong signal even if the exact email differs\n'
    + '- "offer", "contract", "agreement", "employment" in filename → likely offer_contract\n'
    + '- "cv", "curriculum", "resume", "supervisor" in filename → likely supervisor_cv\n'
    + '- If you cannot confidently match, set task_id to null\n'
    + '- Confidence: 0.9+ exact match, 0.7-0.9 strong signals, 0.5-0.7 partial, <0.5 uncertain\n'
    + '- If the email is completely unrelated to GP recruitment documents, set is_relevant to false';
}

// ── parseAIMatchResponse (inline copy) ──
function parseAIMatchResponse(raw) {
  try {
    var cleaned = raw.trim();
    var codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();
    var parsed = JSON.parse(cleaned);
    return {
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      is_relevant: parsed.is_relevant === true,
      summary: parsed.summary || ''
    };
  } catch (e) {
    return { matches: [], is_relevant: false, summary: '' };
  }
}


// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('parseGmailPubSubMessage', function () {
  it('decodes a valid Pub/Sub push message', function () {
    var payload = { emailAddress: 'hazel@mygplink.com.au', historyId: 12345 };
    var body = { message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } };
    var result = parseGmailPubSubMessage(body);
    expect(result).toEqual({ emailAddress: 'hazel@mygplink.com.au', historyId: '12345' });
  });

  it('returns null when body is missing', function () {
    expect(parseGmailPubSubMessage(null)).toBeNull();
    expect(parseGmailPubSubMessage({})).toBeNull();
    expect(parseGmailPubSubMessage({ message: {} })).toBeNull();
  });

  it('returns null when data decodes to invalid JSON', function () {
    var body = { message: { data: Buffer.from('not json').toString('base64') } };
    expect(parseGmailPubSubMessage(body)).toBeNull();
  });

  it('returns null when required fields are missing from decoded payload', function () {
    var payload = { emailAddress: 'test@example.com' }; // missing historyId
    var body = { message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } };
    expect(parseGmailPubSubMessage(body)).toBeNull();
  });

  it('coerces historyId to string', function () {
    var payload = { emailAddress: 'a@b.com', historyId: 99999 };
    var body = { message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } };
    var result = parseGmailPubSubMessage(body);
    expect(result.historyId).toBe('99999');
    expect(typeof result.historyId).toBe('string');
  });
});


describe('extractEmailMeta', function () {
  function makeMessage(overrides) {
    return Object.assign({
      id: 'msg-001',
      payload: {
        headers: [
          { name: 'From', value: '"Jane Smith" <jane@practice.com>' },
          { name: 'To', value: 'hazel@mygplink.com.au' },
          { name: 'Subject', value: 'Dr Kumar offer letter' },
          { name: 'Date', value: 'Mon, 14 Apr 2026 10:00:00 +1000' }
        ],
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Hi Hazel, please find attached the offer letter for Dr Kumar.').toString('base64url') }
          },
          {
            filename: 'offer-dr-kumar.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'att-001', size: 54321 }
          }
        ]
      }
    }, overrides);
  }

  it('extracts sender email and name from angle-bracket format', function () {
    var meta = extractEmailMeta(makeMessage());
    expect(meta.sender).toBe('jane@practice.com');
    expect(meta.senderName).toBe('Jane Smith');
  });

  it('extracts subject, to, and date headers', function () {
    var meta = extractEmailMeta(makeMessage());
    expect(meta.subject).toBe('Dr Kumar offer letter');
    expect(meta.to).toBe('hazel@mygplink.com.au');
    expect(meta.date).toContain('14 Apr 2026');
  });

  it('extracts plain-text body and truncates to 2000 chars', function () {
    var longBody = 'A'.repeat(3000);
    var msg = makeMessage();
    msg.payload.parts[0].body.data = Buffer.from(longBody).toString('base64url');
    var meta = extractEmailMeta(msg);
    expect(meta.bodyText.length).toBe(2000);
  });

  it('extracts attachments with correct metadata', function () {
    var meta = extractEmailMeta(makeMessage());
    expect(meta.attachments).toHaveLength(1);
    expect(meta.attachments[0]).toEqual({
      index: 0,
      filename: 'offer-dr-kumar.pdf',
      mimeType: 'application/pdf',
      attachmentId: 'att-001',
      size: 54321
    });
  });

  it('skips small inline images (signature logos)', function () {
    var msg = makeMessage();
    msg.payload.parts.push({
      filename: 'logo.png',
      mimeType: 'image/png',
      headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }],
      body: { attachmentId: 'att-002', size: 5000 }
    });
    var meta = extractEmailMeta(msg);
    expect(meta.attachments).toHaveLength(1); // only the PDF
  });

  it('keeps large inline images', function () {
    var msg = makeMessage();
    msg.payload.parts.push({
      filename: 'scan.jpg',
      mimeType: 'image/jpeg',
      headers: [{ name: 'Content-Disposition', value: 'inline; filename="scan.jpg"' }],
      body: { attachmentId: 'att-003', size: 500000 }
    });
    var meta = extractEmailMeta(msg);
    expect(meta.attachments).toHaveLength(2);
  });

  it('walks nested multipart parts', function () {
    var msg = {
      id: 'msg-002',
      payload: {
        headers: [
          { name: 'From', value: 'admin@clinic.com' },
          { name: 'Subject', value: 'Nested' },
          { name: 'To', value: 'hazel@mygplink.com.au' },
          { name: 'Date', value: 'Tue, 15 Apr 2026 09:00:00 +1000' }
        ],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: Buffer.from('Nested body text').toString('base64url') }
              }
            ]
          },
          {
            filename: 'cv.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            body: { attachmentId: 'att-nested', size: 12000 }
          }
        ]
      }
    };
    var meta = extractEmailMeta(msg);
    expect(meta.bodyText).toBe('Nested body text');
    expect(meta.attachments).toHaveLength(1);
    expect(meta.attachments[0].filename).toBe('cv.docx');
  });

  it('handles missing payload gracefully', function () {
    var meta = extractEmailMeta({ id: 'msg-empty' });
    expect(meta.messageId).toBe('msg-empty');
    expect(meta.sender).toBe('');
    expect(meta.attachments).toEqual([]);
  });

  it('handles From without angle brackets', function () {
    var msg = makeMessage();
    msg.payload.headers = [
      { name: 'From', value: 'plain@sender.com' },
      { name: 'Subject', value: 'Test' },
      { name: 'To', value: 'to@example.com' },
      { name: 'Date', value: 'Wed, 16 Apr 2026' }
    ];
    var meta = extractEmailMeta(msg);
    expect(meta.sender).toBe('plain@sender.com');
    expect(meta.senderName).toBe('');
  });
});


describe('preFilterEmail', function () {
  function makeEmail(overrides) {
    return Object.assign({
      sender: 'jane@practice.com',
      attachments: [{ filename: 'offer.pdf' }]
    }, overrides);
  }

  it('passes email with valid document attachment', function () {
    var result = preFilterEmail(makeEmail());
    expect(result).toEqual({ pass: true, reason: null });
  });

  it('rejects internal @mygplink.com.au senders', function () {
    var result = preFilterEmail(makeEmail({ sender: 'hazel@mygplink.com.au' }));
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('internal_sender');
  });

  it('rejects emails with no attachments', function () {
    var result = preFilterEmail(makeEmail({ attachments: [] }));
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('no_attachments');
  });

  it('rejects emails with undefined attachments', function () {
    var result = preFilterEmail({ sender: 'a@b.com' });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('no_attachments');
  });

  it('rejects emails with only non-document attachments', function () {
    var result = preFilterEmail(makeEmail({ attachments: [{ filename: 'data.zip' }, { filename: 'music.mp3' }] }));
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('no_document_attachments');
  });

  it('accepts various document extensions', function () {
    var extensions = ['offer.pdf', 'cv.doc', 'contract.docx', 'scan.jpg', 'photo.jpeg', 'cert.png'];
    for (var i = 0; i < extensions.length; i++) {
      var result = preFilterEmail(makeEmail({ attachments: [{ filename: extensions[i] }] }));
      expect(result.pass).toBe(true);
    }
  });

  it('rejects noreply senders', function () {
    var patterns = ['noreply@company.com', 'no-reply@corp.com', 'donotreply@service.com', 'newsletter@spam.com', 'marketing@ads.com', 'mailer-daemon@bounce.com'];
    for (var i = 0; i < patterns.length; i++) {
      var result = preFilterEmail(makeEmail({ sender: patterns[i] }));
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('marketing');
    }
  });

  it('rejects emails with list-unsubscribe header', function () {
    var result = preFilterEmail(makeEmail({ headers: { 'list-unsubscribe': '<https://unsubscribe.example.com>' } }));
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('marketing');
  });

  it('case-insensitive internal sender check', function () {
    var result = preFilterEmail(makeEmail({ sender: 'Hazel@MyGPLink.com.au' }));
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('internal_sender');
  });
});


describe('buildAIMatchPrompt', function () {
  var emailMeta = {
    sender: 'jane@sop-medical.com.au',
    senderName: 'Jane Smith',
    to: 'hazel@mygplink.com.au',
    subject: 'Re: Dr Kumar documents',
    date: 'Mon, 14 Apr 2026 10:00:00 +1000',
    bodyText: 'Hi Hazel, please find the offer letter attached.',
    attachments: [
      { index: 0, filename: 'offer-dr-kumar.pdf', mimeType: 'application/pdf', size: 54321 }
    ]
  };

  it('includes email metadata in prompt', function () {
    var prompt = buildAIMatchPrompt(emailMeta, []);
    expect(prompt).toContain('jane@sop-medical.com.au');
    expect(prompt).toContain('Jane Smith');
    expect(prompt).toContain('Dr Kumar documents');
    expect(prompt).toContain('offer-dr-kumar.pdf');
  });

  it('includes open tasks as JSON when present', function () {
    var tasks = [{ task_id: 't1', document_type: 'offer_contract', gp_name: 'Dr Kumar' }];
    var prompt = buildAIMatchPrompt(emailMeta, tasks);
    expect(prompt).toContain('"task_id": "t1"');
    expect(prompt).toContain('Dr Kumar');
  });

  it('shows placeholder text when no open tasks', function () {
    var prompt = buildAIMatchPrompt(emailMeta, []);
    expect(prompt).toContain('No open tasks currently waiting for documents.');
  });

  it('contains matching rules', function () {
    var prompt = buildAIMatchPrompt(emailMeta, []);
    expect(prompt).toContain('offer_contract');
    expect(prompt).toContain('supervisor_cv');
    expect(prompt).toContain('confidence');
  });
});


describe('parseAIMatchResponse', function () {
  it('parses valid JSON response', function () {
    var raw = JSON.stringify({
      matches: [{ attachment_index: 0, task_id: 't1', document_type: 'offer_contract', confidence: 0.95, reasoning: 'filename match' }],
      is_relevant: true,
      summary: 'Offer letter for Dr Kumar'
    });
    var result = parseAIMatchResponse(raw);
    expect(result.is_relevant).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].task_id).toBe('t1');
    expect(result.summary).toBe('Offer letter for Dr Kumar');
  });

  it('parses JSON wrapped in markdown code block', function () {
    var raw = '```json\n{"matches": [], "is_relevant": false, "summary": "Unrelated email"}\n```';
    var result = parseAIMatchResponse(raw);
    expect(result.is_relevant).toBe(false);
    expect(result.summary).toBe('Unrelated email');
  });

  it('parses JSON wrapped in generic code block', function () {
    var raw = '```\n{"matches": [{"attachment_index": 0}], "is_relevant": true, "summary": "test"}\n```';
    var result = parseAIMatchResponse(raw);
    expect(result.is_relevant).toBe(true);
    expect(result.matches).toHaveLength(1);
  });

  it('returns safe defaults on invalid JSON', function () {
    var result = parseAIMatchResponse('This is not JSON at all');
    expect(result.matches).toEqual([]);
    expect(result.is_relevant).toBe(false);
    expect(result.summary).toBe('');
  });

  it('returns safe defaults on empty string', function () {
    var result = parseAIMatchResponse('');
    expect(result.matches).toEqual([]);
    expect(result.is_relevant).toBe(false);
  });

  it('handles missing matches array gracefully', function () {
    var raw = JSON.stringify({ is_relevant: true, summary: 'test' });
    var result = parseAIMatchResponse(raw);
    expect(result.matches).toEqual([]);
    expect(result.is_relevant).toBe(true);
  });

  it('treats non-true is_relevant as false', function () {
    var raw = JSON.stringify({ matches: [], is_relevant: 'yes', summary: 'test' });
    var result = parseAIMatchResponse(raw);
    expect(result.is_relevant).toBe(false);
  });

  it('handles JSON with leading/trailing whitespace', function () {
    var raw = '   \n  {"matches": [], "is_relevant": true, "summary": "ok"}  \n  ';
    var result = parseAIMatchResponse(raw);
    expect(result.is_relevant).toBe(true);
    expect(result.summary).toBe('ok');
  });
});
