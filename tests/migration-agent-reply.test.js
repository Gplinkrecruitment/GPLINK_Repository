// The practice replied on the "engage a migration agent" card (registration granted).
// Owner report 2026-11-08: the card kept showing the original congratulations email with
// "Send again" after Dr Ranatunga had replied ("Hi Nangi, will you be able to do the below
// for this doctor?" with the migration agent copied in). lib/migration-agent-reply.js reads
// the reply and drafts the follow-up that fits it; server.js routes the card's replies there.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const lib = require('../lib/migration-agent-reply.js');
const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const DASH = /[-‐-―−]/;
const REPLY = {
  gpName: 'Mercy Obanimoh', gpEmail: 'mercy@example.test', practiceName: 'The Doctors Werribee', contactName: 'Dr Ranatunga', rsoName: 'Hazel Mwangi',
  replySender: 'chamiraranatunga@yahoo.com', replyCc: 'Surekha Kalpage <migrationnetworks@gmail.com>', replyTo: 'registration@mygplink.com.au',
  originalTo: 'chamiraranatunga@yahoo.com',
  replyText: 'Hi Nangi,\n\nWill you be able to do the below for this doctor?\n\nLet me know\n\nThanks\nChamira\n\n> On 6 Nov 2026, Hazel, GP Link wrote:\n> Wonderful news. AHPRA has approved',
};

describe('parseEmailList / thirdPartiesOnReply / suggestFollowupRecipients', () => {
  it('parses "Name <addr>" lists, lower-cases and de-duplicates', () => {
    expect(lib.parseEmailList('Surekha Kalpage <MigrationNetworks@gmail.com>, pm@practice.test; MigrationNetworks@gmail.com')).toEqual([
      { email: 'migrationnetworks@gmail.com', name: 'Surekha Kalpage' },
      { email: 'pm@practice.test', name: '' },
    ]);
    expect(lib.parseEmailList('')).toEqual([]);
  });

  it('the third parties on a reply are the CC line minus us, the sender and the doctor', () => {
    expect(lib.thirdPartiesOnReply({ replyFrom: REPLY.replySender, replyCc: REPLY.replyCc + ', hazel@mygplink.com.au, mercy@example.test', replyTo: REPLY.replyTo, gpEmail: REPLY.gpEmail }))
      .toEqual([{ email: 'migrationnetworks@gmail.com', name: 'Surekha Kalpage' }]);
    expect(lib.thirdPartiesOnReply({ replyFrom: 'pm@practice.test', replyCc: '', replyTo: 'registration@mygplink.com.au' })).toEqual([]);
  });

  it('the follow-up goes to the person they handed it to when we hold that address, copying whoever replied', () => {
    expect(lib.suggestFollowupRecipients({ replyFrom: REPLY.replySender, originalTo: REPLY.originalTo, handedToEmail: 'migrationnetworks@gmail.com' }))
      .toEqual({ to: 'migrationnetworks@gmail.com', cc: ['chamiraranatunga@yahoo.com'] });
    // Nobody handed to: back to whoever replied; the original contact is copied when different.
    expect(lib.suggestFollowupRecipients({ replyFrom: 'Naomi <naomi@practice.test>', originalTo: 'pm@practice.test' }))
      .toEqual({ to: 'naomi@practice.test', cc: ['pm@practice.test'] });
    expect(lib.suggestFollowupRecipients({ replyFrom: 'pm@practice.test', originalTo: 'pm@practice.test' })).toEqual({ to: 'pm@practice.test', cc: [] });
  });
});

describe('buildMigrationAgentReplyMessages', () => {
  const msgs = lib.buildMigrationAgentReplyMessages(Object.assign({}, REPLY, {
    commencementDate: '25 January 2027', practiceCoversVisaCosts: true,
    requestText: 'Dr Mercy Obanimoh AHPRA registration approved, next step is the visa\n\nHi Dr Ranatunga, ...',
    knownContacts: [{ email_address: 'chamiraranatunga@yahoo.com', display_name: 'Chamira Ranatunga', signature_name: 'Chamira' }, { email_address: 'migrationnetworks@gmail.com', display_name: 'Surekha Kalpage' }],
  }));

  it('tells the model the situation, forbids re-sending the request, and asks for the JSON shape with recipients and the agent', () => {
    const sys = msgs.system[0].text;
    expect(msgs.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys).toContain('asked them to engage a registered migration agent');
    expect(sys).toContain('NEVER re-send the original request as if they had not replied');
    expect(sys).toContain('Read the CC line');
    expect(sys).toContain('"reply_to"');
    expect(sys).toContain('"agent_email"');
    expect(sys).toContain('"agent_confidence"');
    expect(sys).toContain('Do not use any dashes or hyphens');
    expect(sys).toContain(JSON.stringify(lib.OUTCOMES));
  });

  it('grounds the facts: doctor, practice, contact, start date, who was copied, who is on the thread, the request and the reply', () => {
    const u = msgs.userText;
    expect(u).toContain('"doctor": "Dr Mercy Obanimoh"');
    expect(u).toContain('"practice": "The Doctors Werribee"');
    expect(u).toContain('"practice_contact_we_wrote_to": "Dr Ranatunga"');
    expect(u).toContain('"planned_start_date": "25 January 2027"');
    expect(u).toContain('"practice_covers_visa_costs_for_the_doctor": true');
    expect(u).toContain('"copied_on_their_reply": [\n    "Surekha Kalpage <migrationnetworks@gmail.com>"\n  ]');
    expect(u).toContain('Chamira (Chamira Ranatunga) <chamiraranatunga@yahoo.com>');
    expect(u).toContain('"sign_off_as": "Hazel Mwangi"');
    expect(u).toContain('THE EMAIL WE SENT THEM:');
    expect(u).toContain('THEIR REPLY:\nHi Nangi,');
  });
});

describe('parseMigrationAgentReplyResult', () => {
  it('reads a fenced JSON answer, normalises the outcome and the addresses, and strips dashes from the body', () => {
    const raw = '```json\n' + JSON.stringify({
      outcome: 'Delegated', summary: 'Chamira asked Surekha to handle it.', handed_to: 'Surekha Kalpage <migrationnetworks@gmail.com>',
      agent_name: 'Migration Networks - Surekha Kalpage', agent_email: 'MigrationNetworks@gmail.com', agent_confidence: 'Likely',
      reply_to: 'Surekha <MigrationNetworks@gmail.com>', cc: 'chamiraranatunga@yahoo.com; hazel@mygplink.com.au',
      suggested_subject: 'Re: Dr Obanimoh - visa', suggested_reply: 'Hi Surekha,\n\nChamira has copied you in - could you confirm?\n\nWarm regards,\nHazel\nGP Link', rso_notes: 'Check MARA.',
    }) + '\n```';
    const p = lib.parseMigrationAgentReplyResult(raw);
    expect(p).toMatchObject({
      outcome: 'delegated', summary: 'Chamira asked Surekha to handle it.', handed_to: 'Surekha Kalpage <migrationnetworks@gmail.com>',
      agent_name: 'Migration Networks Surekha Kalpage', agent_email: 'migrationnetworks@gmail.com', agent_confidence: 'likely',
      reply_to: 'migrationnetworks@gmail.com', cc: ['chamiraranatunga@yahoo.com', 'hazel@mygplink.com.au'],
      suggested_subject: 'Re: Dr Obanimoh visa', rso_notes: 'Check MARA.',
    });
    expect(p.suggested_reply).toBe('Hi Surekha,\n\nChamira has copied you in could you confirm?\n\nWarm regards,\nHazel\nGP Link');
    expect(p.suggested_reply).not.toMatch(DASH);
  });

  it('returns null for junk and "unclear" for an unknown outcome', () => {
    expect(lib.parseMigrationAgentReplyResult('')).toBeNull();
    expect(lib.parseMigrationAgentReplyResult('no json here')).toBeNull();
    expect(lib.parseMigrationAgentReplyResult('{"outcome":"whatever","suggested_reply":"x"}').outcome).toBe('unclear');
    expect(lib.normalizeOutcome('agent-named')).toBe('agent_named');
  });
});

describe('applyRecipientGuard', () => {
  const allowed = ['chamiraranatunga@yahoo.com', 'Surekha Kalpage <migrationnetworks@gmail.com>', 'registration@mygplink.com.au'];
  it('keeps addresses that are on the thread and drops invented ones, falling back to the deterministic recipients', () => {
    const kept = lib.applyRecipientGuard({ reply_to: 'migrationnetworks@gmail.com', cc: ['chamiraranatunga@yahoo.com', 'registration@mygplink.com.au'], agent_email: 'migrationnetworks@gmail.com', rso_notes: '' },
      { allowed, replyFrom: 'chamiraranatunga@yahoo.com', originalTo: 'chamiraranatunga@yahoo.com' });
    // Our own hub address is never a CC we need to add; the agent's address is on the thread so it stands.
    expect(kept).toMatchObject({ reply_to: 'migrationnetworks@gmail.com', cc: ['chamiraranatunga@yahoo.com'], agent_email: 'migrationnetworks@gmail.com', rso_notes: '' });
    const guarded = lib.applyRecipientGuard({ reply_to: 'made.up@nowhere.test', cc: ['also.made.up@nowhere.test'], agent_email: 'made.up@nowhere.test', agent_confidence: 'confirmed', rso_notes: '' },
      { allowed, replyFrom: 'chamiraranatunga@yahoo.com', originalTo: 'chamiraranatunga@yahoo.com' });
    expect(guarded.reply_to).toBe('chamiraranatunga@yahoo.com');
    expect(guarded.cc).toEqual([]);
    expect(guarded.agent_email).toBe('');
    expect(guarded.agent_confidence).toBe('');
    expect(guarded.rso_notes).toContain('made.up@nowhere.test) does not appear anywhere on the thread');
  });
});

describe('buildMigrationAgentFallback (AI unavailable)', () => {
  it('with exactly one person copied in, talks to that person and copies the contact: never the original request', () => {
    const d = lib.buildMigrationAgentFallback(REPLY);
    expect(d).toMatchObject({
      outcome: 'delegated', handed_to: 'Surekha Kalpage <migrationnetworks@gmail.com>', agent_name: 'Surekha Kalpage', agent_email: 'migrationnetworks@gmail.com', agent_confidence: 'likely',
      reply_to: 'migrationnetworks@gmail.com', cc: ['chamiraranatunga@yahoo.com'], source: 'fallback',
    });
    expect(d.summary).toBe('The practice passed the request to Surekha Kalpage, who was copied on the reply. Nothing is confirmed yet.');
    expect(d.suggested_subject).toBe('Re: Dr Mercy Obanimoh Subclass 482 nomination and visa, migration agent');
    expect(d.suggested_reply.startsWith('Hi Surekha,\n\nDr Ranatunga has copied you in on the next step for Dr Mercy Obanimoh')).toBe(true);
    expect(d.suggested_reply).toContain('preparing the Subclass 482 nomination for The Doctors Werribee and lodging Dr Obanimoh\'s visa');
    expect(d.suggested_reply).toContain('Warm regards,\nHazel Mwangi\nGP Link');
    expect(d.suggested_reply).not.toContain('Wonderful news');
    expect(d.suggested_reply).not.toContain('Could you please engage a registered migration agent');
    expect(d.suggested_reply).not.toMatch(DASH);
    expect(d.suggested_subject).not.toMatch(DASH);
    expect(d.rso_notes).toContain('Confirm Surekha Kalpage is a registered migration agent');
  });

  it('with nobody copied in, acknowledges the reply and asks the contact to confirm the agent', () => {
    const d = lib.buildMigrationAgentFallback({ gpName: 'Sam Solo', practiceName: 'Co-op Medical', contactName: 'Naomi Milne', rsoName: 'Priya', replySender: 'pm@practice.test', replyCc: '', originalTo: 'pm@practice.test' });
    expect(d).toMatchObject({ outcome: 'unclear', agent_name: '', agent_email: '', reply_to: 'pm@practice.test', cc: [], source: 'fallback' });
    expect(d.suggested_reply.startsWith('Hi Naomi,\n\nThank you for coming back to us about Dr Sam Solo\'s visa.')).toBe(true);
    expect(d.suggested_reply).toContain('could you please confirm who will be acting as the migration agent, with their name and email address?');
    expect(d.suggested_reply).not.toMatch(DASH);
    expect(d.suggested_subject).not.toMatch(DASH);
  });

  it('the guidance lines and guide line exist for every outcome', () => {
    lib.OUTCOMES.forEach((o) => expect(lib.outcomeGuidance(o).length).toBeGreaterThan(20));
    expect(lib.GUIDE_LINE).toBe('Practice replied — read the reply and send the follow-up');
  });
});

describe('the nudge: whoever we last wrote to has gone quiet (owner report 2026-11-08, second screenshot)', () => {
  const OUT = { to: 'chamiraranatunga@yahoo.com', cc: '', subject: 'Dr Mercy Obanimoh AHPRA registration approved, next step is the visa', sent_at: '2026-11-06T03:25:30Z' };
  const FU = { kind: 'followup', to: 'migrationnetworks@gmail.com', cc: 'chamiraranatunga@yahoo.com', subject: 'Dr Mercy Obanimoh Subclass 482 visa, introduction from GP Link', sent_at: '2026-11-08T09:34:00Z' };
  const PR = { outcome: 'delegated', handed_to: 'Surekha Kalpage <migrationnetworks@gmail.com>', reply_to: 'migrationnetworks@gmail.com', answered_at: '2026-11-08T09:34:00Z' };

  it('greetName and threadReplySubject', () => {
    expect(lib.greetName('Dr Chamira Ranatunga')).toBe('Dr Ranatunga');
    expect(lib.greetName('Dr Ranatunga')).toBe('Dr Ranatunga');
    expect(lib.greetName('Surekha Kalpage')).toBe('Surekha');
    expect(lib.greetName('Dr')).toBe('');
    expect(lib.greetName('Practice Manager')).toBe('');
    expect(lib.threadReplySubject('Re: Re: Dr X visa')).toBe('Re: Dr X visa');
    expect(lib.threadReplySubject('')).toBe('');
  });

  it('after a follow-up, the target is the person it went to (named from the reply read), copying the original contact', () => {
    const t = lib.nudgeTarget({ outboundEmail: OUT, followups: [FU], practiceReply: PR, knownContacts: [], contactName: 'Dr Ranatunga' });
    expect(t).toEqual({ to: 'migrationnetworks@gmail.com', cc: ['chamiraranatunga@yahoo.com'], name: 'Surekha Kalpage', greeting: 'Surekha', subject: 'Re: Dr Mercy Obanimoh Subclass 482 visa, introduction from GP Link', lastSentAt: '2026-11-08T09:34:00Z', waitingOn: 'followup' });
  });

  it('with no follow-up, the target is the original contact, greeted as our first email greeted them', () => {
    const t = lib.nudgeTarget({ outboundEmail: OUT, followups: [], practiceReply: null, knownContacts: [{ email_address: 'chamiraranatunga@yahoo.com', display_name: 'Chamira Ranatunga' }], contactName: 'Dr Ranatunga' });
    expect(t).toMatchObject({ to: 'chamiraranatunga@yahoo.com', cc: [], name: 'Chamira Ranatunga', greeting: 'Dr Ranatunga', subject: 'Re: Dr Mercy Obanimoh AHPRA registration approved, next step is the visa', waitingOn: 'contact' });
  });

  it('the deterministic nudge chases the open question only, never the congratulations email, with no dashes', () => {
    const base = { gpName: 'Mercy Obanimoh', practiceName: 'The Doctors Werribee', commencementDate: '25 January 2027', rsoName: 'Hazel' };
    const afterFu = lib.buildMigrationAgentNudgeFallback(Object.assign({}, base, { target: lib.nudgeTarget({ outboundEmail: OUT, followups: [FU], practiceReply: PR, contactName: 'Dr Ranatunga' }) }));
    expect(afterFu).toMatchObject({ to: 'migrationnetworks@gmail.com', cc: ['chamiraranatunga@yahoo.com'], suggested_subject: 'Re: Dr Mercy Obanimoh Subclass 482 visa, introduction from GP Link', source: 'fallback' });
    expect(afterFu.suggested_reply.startsWith("Hi Surekha,\n\nJust checking in on my note below about Dr Mercy Obanimoh's Subclass 482 nomination and visa for The Doctors Werribee.")).toBe(true);
    expect(afterFu.suggested_reply).toContain('Could you let us know whether you will be handling it');
    expect(afterFu.suggested_reply).toContain('before Dr Obanimoh starts on 25 January 2027');
    expect(afterFu.suggested_reply).toContain('Warm regards,\nHazel\nGP Link');
    expect(afterFu.suggested_reply).not.toContain('Wonderful news');
    expect(afterFu.suggested_reply).not.toMatch(DASH);
    const noReply = lib.buildMigrationAgentNudgeFallback(Object.assign({}, base, { target: lib.nudgeTarget({ outboundEmail: OUT, followups: [], contactName: 'Dr Ranatunga' }) }));
    expect(noReply.to).toBe('chamiraranatunga@yahoo.com');
    expect(noReply.suggested_reply.startsWith("Hi Dr Ranatunga,\n\nJust following up on my email below about Dr Mercy Obanimoh's visa. Have you been able to engage a registered migration agent")).toBe(true);
    expect(noReply.suggested_reply).not.toMatch(DASH);
  });

  it('the AI prompt carries who we last wrote to, the days of silence, what the practice last said and the thread', () => {
    const msgs = lib.buildMigrationAgentNudgeMessages({
      gpName: 'Mercy Obanimoh', practiceName: 'The Doctors Werribee', commencementDate: '25 January 2027', rsoName: 'Hazel',
      target: lib.nudgeTarget({ outboundEmail: OUT, followups: [FU], practiceReply: PR }), daysSinceLastContact: 4, practiceEverReplied: true,
      lastSaid: 'Dr Ranatunga forwarded our request to Surekha Kalpage.', threadText: '[2026-11-06] US (GP Link):\nHi Dr Ranatunga, ...', knownContacts: [],
    });
    expect(msgs.system[0].text).toContain('NEVER repeat the original congratulations email');
    expect(msgs.system[0].text).toContain('Write to the person in "we_last_wrote_to"');
    expect(msgs.userText).toContain('"we_last_wrote_to": "Surekha Kalpage <migrationnetworks@gmail.com>"');
    expect(msgs.userText).toContain('"days_since_our_last_email": 4');
    expect(msgs.userText).toContain('"what_the_practice_said_last": "Dr Ranatunga forwarded our request to Surekha Kalpage."');
    expect(msgs.userText).toContain('THE THREAD SO FAR (oldest first):\n[2026-11-06] US (GP Link):');
    const parsed = lib.parseMigrationAgentNudgeResult('{"suggested_subject":"Re: x - y","suggested_reply":"Hi Surekha,\\n\\nJust checking in - any news?\\n\\nWarm regards,\\nHazel\\nGP Link","rso_notes":""}');
    expect(parsed).toEqual({ suggested_subject: 'Re: x y', suggested_reply: 'Hi Surekha,\n\nJust checking in any news?\n\nWarm regards,\nHazel\nGP Link', rso_notes: '' });
    expect(lib.parseMigrationAgentNudgeResult('garbage')).toBeNull();
  });
});

describe('cardParties: everyone this card has corresponded with, for new-thread replies', () => {
  it('splits the practice contact from the people only this card knows, drops our own addresses, de-duplicates', () => {
    const p = lib.cardParties({
      outbound_email: { to: 'chamiraranatunga@yahoo.com', cc: 'hazel@mygplink.com.au' },
      followups: [{ to: 'migrationnetworks@gmail.com', cc: 'chamiraranatunga@yahoo.com' }, { kind: 'nudge', to: 'MigrationNetworks@gmail.com', cc: '' }],
      practice_reply: { sender: 'chamiraranatunga@yahoo.com', reply_to: 'migrationnetworks@gmail.com', agent_email: '', handed_to: 'Surekha Kalpage <migrationnetworks@gmail.com>', cc: ['chamiraranatunga@yahoo.com'] },
    });
    expect(p).toEqual({ contact: ['chamiraranatunga@yahoo.com'], specific: ['migrationnetworks@gmail.com'] });
    // A reply from a different practice address becomes a known party too.
    expect(lib.cardParties({ outbound_email: { to: 'pm@practice.test' }, practice_reply: { sender: 'Naomi <naomi@practice.test>' } })).toEqual({ contact: ['pm@practice.test'], specific: ['naomi@practice.test'] });
    expect(lib.cardParties({})).toEqual({ contact: [], specific: [] });
  });
});

describe('server wiring', () => {
  it('the nudge-draft endpoint hands a migration_agent task to its own drafter, and a nudge send is recorded as such', () => {
    const route = serverSrc.slice(serverSrc.indexOf("pathname === '/api/admin/practice-nudge/draft'"), serverSrc.indexOf("pathname === '/api/admin/email-triage/suggest-reply'"));
    expect(route).toContain("if (pnTask.task_type === 'migration_agent' && pnMeta.registration_granted && pnMeta.outbound_email) {");
    expect(route).toContain('var maNudge = await _draftMigrationAgentNudge(pnTask, pnMeta);');
    expect(serverSrc).toContain('async function _draftMigrationAgentNudge(task, meta) {');
    const send = serverSrc.slice(serverSrc.indexOf("pathname === '/api/admin/registration-granted/send-practice-email'"), serverSrc.indexOf("pathname === '/api/admin/registration-granted/gp-request-status'"));
    expect(send).toContain('var rgIsNudge = !!(rgBody && rgBody.nudge === true);');
    expect(send).toContain("kind: rgIsNudge ? 'nudge' : 'followup'");
    expect(send).toContain("'Nudge sent to the practice about the migration agent'");
  });

  it('routes a migration_agent task from the shared practice-reply recorder to its own reader, before the practice-pack guard', () => {
    const i = serverSrc.indexOf("if (task && task.task_type === 'migration_agent') return _recordMigrationAgentReply(caseId, task, reply);");
    const j = serverSrc.indexOf("if (!task || task.task_type !== 'practice_pack_child' || !task.related_document_key) return null;");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(serverSrc).toContain('async function _recordMigrationAgentReply(caseId, task, reply) {');
    expect(serverSrc).toContain('async function _buildMigrationAgentReplyDraft(caseId, task, meta, reply) {');
    // Both inbound-mail paths still hand every matched reply to the shared recorder (so the new card is covered).
    expect(serverSrc.split('await _recordPracticeReplyFollowup(').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('the reader writes the deterministic marker first, flips a waiting task to open, and layers the draft on top', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _recordMigrationAgentReply('), serverSrc.indexOf('async function _buildMigrationAgentReplyDraft('));
    expect(fn).toContain("kind: 'migration_agent'");
    expect(fn).toContain("draft_status: 'pending'");
    expect(fn).toContain("if (status.indexOf('waiting') === 0) firstPatch.status = 'open';");
    expect(fn.indexOf("draft_status: 'pending'")).toBeLessThan(fn.indexOf('await _buildMigrationAgentReplyDraft('));
    expect(fn).toContain("draft_status: 'ready'");
    // A re-draft of the same message keeps its arrival time and answered state.
    expect(fn).toContain('var sameMessage = !!(prev.message_id && reply.messageId && String(prev.message_id) === String(reply.messageId));');
  });

  it('every address the model proposes is checked against the thread; the fallback gets the CC line', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _buildMigrationAgentReplyDraft('), serverSrc.indexOf('async function _loadPassportRequestStatus('));
    expect(fn).toContain('migrationAgentReply.applyRecipientGuard(parsed, { allowed: allowed, replyFrom: replySender');
    expect(fn).toContain("var replyCc = (inbound && inbound.cc) || '';");
    expect(fn).toContain('migrationAgentReply.buildMigrationAgentFallback({');
    expect(fn).toContain('if (!apiKey) return fallback;');
  });

  it('send-practice-email threads onto their reply and, for a follow-up, keeps the congratulations draft and marks the reply answered', () => {
    const route = serverSrc.slice(serverSrc.indexOf("pathname === '/api/admin/registration-granted/send-practice-email'"), serverSrc.indexOf("pathname === '/api/admin/registration-granted/gp-request-status'"));
    expect(route).toContain('threadId: rgThreadId || undefined, inReplyTo: rgInReplyTo || undefined, references: rgReferences || undefined');
    expect(route).toContain("var rgIsFollowup = rgIsNudge || !!(rgBody && rgBody.followup === true)");
    expect(route).toContain('rgMeta.followups = rgFollowups;');
    // The first follow-up marks the reply answered; a later nudge keeps that first answered_at.
    expect(route).toContain("if (rgPr) rgMeta.practice_reply = Object.assign({}, rgPr, { answered_at: rgPr.answered_at || rgNow, draft_status: 'sent', sent_to: rgPr.sent_to || rgTo });");
    // The text part is the body actually sent, never the stored draft.
    expect(route).toContain('bodyText: rgBodyText || undefined');
    expect(route).not.toContain('bodyText: rgDraft.bodyText || undefined');
    expect(route).toContain("'Follow-up sent to the practice about the migration agent'");
  });

  it('the on-demand draft endpoint also accepts the cron secret for a maintenance re-draft', () => {
    const route = serverSrc.slice(serverSrc.indexOf("pathname === '/api/admin/practice-reply/draft'"), serverSrc.indexOf("pathname === '/api/admin/practice-nudge/draft'"));
    expect(route).toContain("var prViaCron = /^Bearer\\s+/i.test(prAuthHdr) && isValidCronSecret(prAuthHdr.replace(/^Bearer\\s+/i, ''));");
    expect(route).toContain('var prScope = prViaCron ? { superAdmin: true } : await resolveAdminGpScope(prCtx, url);');
  });
});
