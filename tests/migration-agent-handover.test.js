// Handing the doctor over to the migration agent (visa stage).
// Owner report 2026-11-25 (Dr Obanimoh, The Doctors Werribee, Syed Rahman at Pace Migration):
// the practice told the agent to go ahead, our team promised the doctor's documents, the send
// parked the migration-agent card as "waiting on the practice" and nothing said the next step
// was ours. lib/migration-agent-handover.js builds the one email that connects the doctor and
// the agent (documents on file attached); server.js creates the card, sends it and keeps it
// parked while the two of them talk with us copied.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const lib = require('../lib/migration-agent-handover.js');
const replyLib = require('../lib/migration-agent-reply.js');
const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const adminSrc = readFileSync(new URL('../pages/admin.html', import.meta.url), 'utf8');

const DASH = /[-‐-―−]/;

// Dr Obanimoh's real file shape (prod, 25 Nov 2026): some rows live in Supabase storage, some
// only in Drive, and the onboarding upload sits beside the certified copy of the same thing.
const USER_DOCS = [
  { id: 'd-sup', document_key: 'supervisor_cv', status: 'approved', file_name: 'CCF_000522.pdf', storage_path: null, google_drive_file_id: 'drv1' },
  { id: 'd-onb-spec', document_key: 'onboarding_specialist_qualification', status: 'approved', file_name: '327488.jpg', storage_path: null, google_drive_file_id: 'drv2' },
  { id: 'd-onb-deg', document_key: 'onboarding_primary_med_degree', status: 'approved', file_name: '326650.jpg', storage_path: null, google_drive_file_id: 'drv3' },
  { id: 'd-contract', document_key: 'offer_contract', status: 'approved', file_name: 'Signed agreement (4).pdf', storage_path: 'users/u/offer-documents/offer_contract.pdf' },
  { id: 'd-cct', document_key: 'cct_certified', status: 'approved', file_name: 'Certificate of Completion of Training', storage_path: 'users/u/prepared-documents/uk/cct_certified.pdf', file_size: 256462 },
  { id: 'd-cv', document_key: 'cv_signed_dated', status: 'approved', file_name: 'CV (Signed and dated)', storage_path: 'users/u/prepared-documents/uk/cv_signed_dated.pdf', file_size: 1103444 },
  { id: 'd-mrcgp', document_key: 'mrcgp_certified', status: 'approved', file_name: 'MRCGP Certificate', storage_path: 'users/u/prepared-documents/uk/mrcgp.pdf' },
  { id: 'd-deg', document_key: 'primary_medical_degree', status: 'approved', file_name: 'Primary Medical Degree', storage_path: 'users/u/onboarding-documents/uk/deg.pdf' },
  { id: 'd-notice', document_key: 'ahpra_registration_notice', status: 'approved', file_name: 'Final notice.pdf', storage_path: 'users/u/gplink-delivered/notice.pdf' },
  { id: 'd-sppa', document_key: 'sppa_00', status: 'approved', file_name: 'SPPA-00 Completed.pdf', storage_path: null, google_drive_file_id: 'drv9' },
];

describe('pickHandoverDocuments: what the agent needs from the file, one copy of each', () => {
  it('picks CV, degree, specialist qualification, CCT and the AHPRA notice, in that order', () => {
    const picked = lib.pickHandoverDocuments(USER_DOCS, []);
    expect(picked.map((d) => d.id)).toEqual(['d-cv', 'd-deg', 'd-mrcgp', 'd-cct', 'd-notice']);
    expect(picked.map((d) => d.label)).toEqual(['CV', 'Primary medical degree', 'Specialist GP qualification', 'Certificate of completion of training', 'AHPRA registration notice']);
    expect(picked.every((d) => d.source === 'user_documents')).toBe(true);
  });

  it('never offers practice paperwork, the contract or the supervisor’s CV', () => {
    const ids = lib.pickHandoverDocuments(USER_DOCS, []).map((d) => d.id);
    ['d-sup', 'd-contract', 'd-sppa'].forEach((id) => expect(ids).not.toContain(id));
  });

  it('falls back to the onboarding upload (Drive only) when there is no certified copy', () => {
    const rows = USER_DOCS.filter((r) => !['d-deg', 'd-mrcgp', 'd-cv'].includes(r.id)).concat([{ id: 'd-ccv', document_key: 'career_cv', status: 'approved', file_name: 'cv.pdf', storage_path: 'x/cv.pdf' }]);
    expect(lib.pickHandoverDocuments(rows, []).map((d) => d.id)).toEqual(['d-ccv', 'd-onb-deg', 'd-onb-spec', 'd-cct', 'd-notice']);
  });

  it('skips a rejected row and a row with no file behind it', () => {
    const rows = [
      { id: 'a', document_key: 'cv_signed_dated', status: 'rejected', storage_path: 'x' },
      { id: 'b', document_key: 'career_cv', status: 'approved', storage_path: 'None', google_drive_file_id: '' },
      { id: 'c', document_key: 'cv', status: 'approved', storage_path: 'x/cv.pdf' },
    ];
    expect(lib.pickHandoverDocuments(rows, []).map((d) => d.id)).toEqual(['c']);
    expect(lib.pickHandoverDocuments(null, null)).toEqual([]);
  });

  it('adds passports only when they were actually uploaded in the app', () => {
    const visa = [
      { id: 'v1', document_type: 'passport', label: 'Your passport', status: 'uploaded', file_path: 'users/u/visa-documents/p.pdf', original_file_name: 'pp.jpg' },
      { id: 'v2', document_type: 'passport', label: "Partner's passport", status: 'missing', file_path: '' },
      { id: 'v3', document_type: 'other', label: 'Bank statement', status: 'uploaded', file_path: 'x' },
    ];
    const picked = lib.pickHandoverDocuments([], visa);
    expect(picked).toEqual([{ source: 'visa_documents', id: 'v1', slot: 'passport', label: 'Passport', file_name: 'pp.jpg', size: 0 }]);
  });
});

describe('attachmentFilename: a name the agent can file without opening it', () => {
  it('uses the doctor and the label, keeps a real extension, falls back to the mime type', () => {
    expect(lib.attachmentFilename({ label: 'CV', file_name: 'CV (Signed and dated)' }, 'Mercy Obanimoh', 'application/pdf')).toBe('Dr Mercy Obanimoh - CV.pdf');
    expect(lib.attachmentFilename({ label: 'Primary medical degree', file_name: '326650.jpg' }, 'Dr Mercy Obanimoh', '')).toBe('Dr Mercy Obanimoh - Primary medical degree.jpg');
    expect(lib.attachmentFilename({ label: 'Passport', file_name: '' }, '', 'image/png')).toBe('Passport.png');
  });

  it('the file’s own bytes decide the type: a JPEG recorded as a PDF goes out as a .jpg', () => {
    expect(lib.sniffMimeType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]))).toBe('image/jpeg');
    expect(lib.sniffMimeType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(lib.sniffMimeType(Buffer.from([0x89, 0x50, 0x4E, 0x47]))).toBe('image/png');
    expect(lib.sniffMimeType(Buffer.from('PK\u0003\u0004'))).toBe('');
    expect(lib.attachmentFilename({ label: 'Primary medical degree', file_name: '' }, 'Mercy Obanimoh', 'image/jpeg')).toBe('Dr Mercy Obanimoh - Primary medical degree.jpg');
    expect(serverSrc).toContain("file_name: hoSniffed ? '' : (hoFile.file_name || hoPicked[hi].file_name)");
  });

  it('never lets a path or header character into the filename', () => {
    const name = lib.attachmentFilename({ label: 'CV"\r\nBcc: x@y.z', file_name: 'a/b.pdf' }, 'A/B', 'application/pdf');
    expect(name).not.toMatch(/["\r\n\/\\]/);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('practiceConfirmedAgent: the practice told the agent to go ahead', () => {
  it('reads Dr Ranatunga’s actual go-ahead (23 Nov 2026)', () => {
    expect(lib.practiceConfirmedAgent("Hi Syed,\n\nI am very happy for Syed to progress Dr. Obanimoh's application\n\nPlease start to process.\nHazel thanks for organising the documents required to be sent to Syed.\n\nThank you\nChamira")).toBe(true);
  });

  it('does not fire on a fee question, a booking or a handover to the practice manager', () => {
    expect(lib.practiceConfirmedAgent('Syed actually I just realised you charge on an hourly basis for the meeting. Could you kindly check on this applicant and let me know your charges and your time frame.')).toBe(false);
    expect(lib.practiceConfirmedAgent('Very nice to meet you Syed. I’ll book an apt online. Thanks Chamira')).toBe(false);
    expect(lib.practiceConfirmedAgent('Hi Naomi, could you share our business details and include our business sponsorship details as well.')).toBe(false);
    expect(lib.practiceConfirmedAgent('')).toBe(false);
  });

  it('a question, a refusal or a condition is not a go-ahead', () => {
    expect(lib.practiceConfirmedAgent('What are the fees before we proceed with the application?')).toBe(false);
    expect(lib.practiceConfirmedAgent('Please do not go ahead with the application yet.')).toBe(false);
    expect(lib.practiceConfirmedAgent('We are not happy to proceed at that price.')).toBe(false);
    expect(lib.practiceConfirmedAgent('Once we have the fees we will proceed with the nomination.')).toBe(false);
    expect(lib.practiceConfirmedAgent('Thanks for the fees. Please go ahead with the application.')).toBe(true);
    expect(lib.practiceConfirmedAgent('We have engaged Pace Migration for this.')).toBe(true);
  });

  it('ignores a go-ahead that only appears in the quoted thread below the reply', () => {
    expect(lib.practiceConfirmedAgent('What are your fees?\n\nOn Monday 23 November 2026 at 01:26 pm, Hazel wrote:\n> Please proceed with the application')).toBe(false);
  });

  it('the AI reader is asked the same question and its answer is parsed', () => {
    const msgs = replyLib.buildMigrationAgentReplyMessages({ gpName: 'Mercy Obanimoh', practiceName: 'The Doctors Werribee', replyText: 'Please start to process.', replySender: 'a@b.test' });
    expect(JSON.stringify(msgs)).toContain('agent_engaged');
    expect(replyLib.parseMigrationAgentReplyResult(JSON.stringify({ outcome: 'agent_named', summary: 's', suggested_reply: 'Hi', agent_engaged: true })).agent_engaged).toBe(true);
    expect(replyLib.parseMigrationAgentReplyResult(JSON.stringify({ outcome: 'agent_named', summary: 's', suggested_reply: 'Hi' })).agent_engaged).toBe(false);
  });
});

describe('buildHandoverDraft: one email, To the agent, Cc the doctor', () => {
  const docs = lib.pickHandoverDocuments(USER_DOCS, []);
  const draft = lib.buildHandoverDraft({
    gpFirstName: 'Mercy', gpLastName: 'Obanimoh', gpEmail: 'Mercy <mercy@example.test>',
    agentName: 'Syed Rahman (Pace Migration)', agentEmail: 'syed@pacemigration.com.au', practiceName: 'The Doctors Werribee',
    registrationNumber: 'MED0004091669', commencement: '25 January 2027', whoMoving: 'me_partner_children', documents: docs, senderName: 'Hazel',
  });

  it('goes to the agent with the doctor copied, and nobody else', () => {
    expect(draft.to).toBe('syed@pacemigration.com.au');
    expect(draft.cc).toBe('mercy@example.test');
    expect(draft.subject).toBe('Dr Mercy Obanimoh, Subclass 482 visa: documents and next steps');
  });

  it('lists every attached document so the agent can check nothing is missing', () => {
    docs.forEach((d, i) => expect(draft.bodyText).toContain((i + 1) + '. ' + d.label));
    expect(draft.bodyText).toContain('Hi Syed,');
    expect(draft.bodyText).toContain('MED0004091669');
    expect(draft.bodyText).toContain('25 January 2027');
  });

  it('asks the doctor to answer the agent directly, for what only the doctor knows', () => {
    expect(draft.bodyText).toContain('Dr Obanimoh, Syed Rahman from Pace Migration is the registered migration agent looking after your visa. Could you please reply to Syed directly');
    expect(draft.bodyText).toContain('date of birth and the country of your passport');
    expect(draft.bodyText).toContain('English language test result');
    expect(draft.bodyText).toContain('each family member coming with you');
    expect(draft.bodyText).toContain('Syed, please contact Dr Obanimoh directly for anything further you need, and keep us copied');
  });

  it('follows the house style: no dashes, signed by the coordinator, html mirrors the text', () => {
    expect(draft.bodyText).not.toMatch(DASH);
    expect(draft.subject).not.toMatch(DASH);
    expect(draft.bodyText.endsWith('Warm regards,\nHazel\nGP Link')).toBe(true);
    expect(draft.bodyHtml).toContain('Hi Syed,<br><br>');
    expect(draft.bodyHtml).toContain('Dr Obanimoh&#39;s documents');
  });

  it('does not ask for a passport we are attaching, or for family when the doctor moves alone', () => {
    const solo = lib.buildHandoverDraft({
      gpFirstName: 'Sam', gpLastName: 'Lee', gpEmail: 'sam@example.test', agentName: 'Visa Co', agentEmail: 'team@visaco.test',
      whoMoving: 'just_me', documents: [{ source: 'visa_documents', id: 'v1', slot: 'passport', label: 'Passport' }], senderName: 'Hazel',
    });
    expect(solo.bodyText).not.toContain('passport photo page');
    expect(solo.bodyText).not.toContain('family members');
    expect(solo.bodyText).toContain('1. Passport');
    const family = lib.buildHandoverDraft({
      gpFirstName: 'Sam', gpLastName: 'Lee', gpEmail: 'sam@example.test', agentName: 'Visa Co', agentEmail: 'team@visaco.test',
      whoMoving: 'me_partner', documents: [{ source: 'visa_documents', id: 'v1', slot: 'passport', label: 'Passport' }], senderName: 'Hazel',
    });
    expect(family.bodyText).toContain('A copy of the passport photo page for each family member coming with you');
    expect(family.bodyText).not.toContain('for you and for each family member');
  });

  it('still connects them when nothing is on file, without promising attachments', () => {
    const bare = lib.buildHandoverDraft({ gpFirstName: 'Sam', gpLastName: 'Lee', gpEmail: 'sam@example.test', agentName: '', agentEmail: 'team@visaco.test', documents: [] });
    expect(bare.bodyText).not.toContain('attached');
    expect(bare.bodyText).toContain('Hi there,');
    expect(bare.bodyText).toContain('put you in touch with Dr Lee directly');
    expect(bare.bodyText).toContain('A copy of your passport photo page');
  });
});

describe('handoverReplyNeedsUs: the doctor and the agent talking is not work for us', () => {
  const base = { ownAddresses: ['registration@mygplink.com.au'], parties: ['syed@pacemigration.com.au', 'mercy@example.test'], names: ['Hazel'] };

  it('doctor replies to the agent with us copied → stays parked', () => {
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'Mercy <mercy@example.test>', to: 'syed@pacemigration.com.au', cc: 'registration@mygplink.com.au', text: 'Hi Syed, my date of birth is below.' })).toEqual({ needsUs: false, reason: 'between_them' });
  });

  it('reply-all with us on the To line beside the other party is still between them', () => {
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'syed@pacemigration.com.au', to: 'mercy@example.test, registration@mygplink.com.au', cc: '', text: 'Thanks Mercy, received.' }).needsUs).toBe(false);
  });

  it('the agent replying-all (us alone in To, the doctor on Cc) is still between them', () => {
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'syed@pacemigration.com.au', to: 'registration@mygplink.com.au', cc: 'mercy@example.test', text: 'Hi Mercy, thank you, please send your passports.' }).needsUs).toBe(false);
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'syed@pacemigration.com.au', to: 'registration@mygplink.com.au', cc: 'mercy@example.test', text: 'Hi Hazel, could you send the contract?' }).reason).toBe('mentions_us');
  });

  it('written to us alone, naming us, or from someone new → back with the coordinator', () => {
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'syed@pacemigration.com.au', to: 'registration@mygplink.com.au', cc: '', text: 'Could you send the contract?' }).reason).toBe('addressed_to_us');
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'mercy@example.test', to: 'syed@pacemigration.com.au', cc: 'registration@mygplink.com.au', text: 'Hazel, do you have my IELTS on file?' }).reason).toBe('mentions_us');
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'pm@thefamilydoctors.com.au', to: 'syed@pacemigration.com.au', cc: 'registration@mygplink.com.au', text: 'Hi' }).reason).toBe('someone_new');
  });

  it('a name in the quoted thread does not count, and unknown recipients are never assumed safe', () => {
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'mercy@example.test', to: 'syed@pacemigration.com.au', cc: 'registration@mygplink.com.au', text: 'Sent, thanks.\n\nOn 26 Nov 2026, Hazel, GP Link wrote:\n> Hi Syed' }).needsUs).toBe(false);
    expect(lib.handoverReplyNeedsUs({ ...base, sender: 'mercy@example.test', to: '', cc: '', text: 'ok' }).reason).toBe('unknown_recipients');
  });
});

describe('server wiring', () => {
  const fn = (name) => {
    const start = serverSrc.indexOf('async function ' + name + '(');
    expect(start).toBeGreaterThan(-1);
    const next = serverSrc.indexOf('\nasync function ', start + 10);
    return serverSrc.slice(start, next > -1 ? next : start + 12000);
  };
  const route = (path) => {
    const start = serverSrc.indexOf("pathname === '" + path + "'");
    expect(start).toBeGreaterThan(-1);
    return serverSrc.slice(start, serverSrc.indexOf('\n  if (pathname === ', start + 10));
  };

  it('one handover card per case, and a failed lookup never creates a second', () => {
    const src = fn('_ensureAgentHandoverTask');
    expect(src).toContain("if (!vsRes.ok || !Array.isArray(vsRes.data)) return { created: false, reason: 'lookup_failed' };");
    expect(src).toContain("if (existing) return { created: false, reason: 'exists', task: existing };");
    expect(src.indexOf("reason: 'exists'")).toBeLessThan(src.indexOf('_createRegTask('));
  });

  it('is created only once the practice has told the agent to go ahead, unless the coordinator asks', () => {
    const src = fn('_ensureAgentHandoverTask');
    expect(src).toContain("return t.task_type === 'migration_agent' && !!m.agent_engaged_at;");
    expect(src).toContain("if (!engaged) return { created: false, reason: 'not_confirmed' };");
    expect(src).toContain("if (!agentEmail) return { created: false, reason: 'no_agent_email' };");
  });

  it('the practice’s go-ahead is recorded on the migration-agent card and triggers the handover; the agent’s own email never does', () => {
    const src = fn('_recordMigrationAgentReply');
    expect(src).toContain('var engagedNow = !!(draft && draft.agent_engaged === true) || migrationAgentHandover.practiceConfirmedAgent(reply.text);');
    expect(src).toContain('if (engSender && engAgent && engSender === engAgent) engagedNow = false;');
    expect(src).toContain('if (engagedNow && !meta2.agent_engaged_at) meta2.agent_engaged_at = nowIso;');
    expect(src).toContain("await _ensureAgentHandoverTask(caseId, { fromTaskId: task.id, reason: 'practice_confirmed' });");
  });

  it('saving the agent’s email is the second moment the card can be created', () => {
    const start = serverSrc.indexOf("pathname === '/api/admin/ops/case' && req.method === 'PUT'");
    expect(start).toBeGreaterThan(-1);
    const src = serverSrc.slice(start, start + 4000);
    expect(src).toContain("if (Object.prototype.hasOwnProperty.call(patch, 'migration_agent_contact') && patch.migration_agent_contact) {");
    expect(src).toContain("await _ensureAgentHandoverTask(caseId, { actor: adminCtx.email, reason: 'agent_saved_after_confirmation' });");
  });

  it('the send route attaches only offered documents, re-checks ownership and never sends twice', () => {
    const src = route('/api/admin/registration-granted/send-agent-handover');
    expect(src).toContain('requireAdminSession(req, res)');
    expect(src).toContain('ensureAdminCaseAccess(adminCtx, await fetchCaseAssignmentByTaskId(hoTaskId), res)');
    expect(src).toContain('if (hoAh.sent_at && !(hoBody && hoBody.resend === true))');
    expect(src).toContain('var hoPicked = hoOffered.filter(function (d) { return hoWanted.indexOf(String(d.id)) > -1; });');
    expect(src).toContain("code: 'attachment_unavailable'");
    expect(src).toContain('migrationAgentHandover.MAX_ATTACHMENT_BYTES');
    expect(src).toContain('internalNoteGuard.findInternalNotes(hoBodyHtml');
    // The ball is with the doctor and the agent: parked, with the chase clock.
    expect(src).toContain("status: 'waiting_on_external', metadata: hoMeta, gmail_thread_id: hoSend.threadId || null, updated_at: hoNow, due_date: _waitingChaseDueDate()");
    // Two tabs cannot both send: the send is claimed on the row as it was read, before anything leaves.
    expect(src).toContain("(hoTask.updated_at ? '&updated_at=eq.' + encodeURIComponent(hoTask.updated_at) : '&updated_at=is.null')");
    expect(src.indexOf("code: 'send_in_progress'")).toBeLessThan(src.indexOf('await sendGmailEmail('));
    expect(src).toContain("code: 'send_unconfirmed'");
    expect(src).toContain("hoTask.status === 'completed' || hoTask.status === 'cancelled'");
    const load = fn('_loadHandoverAttachment');
    expect(load).toContain("'&user_id=eq.' + encodeURIComponent(ctx.userId)");
    expect(load).toContain("'&visa_application_id=eq.' + encodeURIComponent(ctx.visaCaseId)");
  });

  it('a reply between the doctor and the agent re-parks the card; one that needs us leaves it open', () => {
    const src = fn('_recordAgentHandoverReply');
    expect(src).toContain("if (!verdict.needsUs && status !== 'completed' && status !== 'cancelled') { patch.status = 'waiting_on_external'; patch.due_date = _waitingChaseDueDate(); }");
    expect(src).toContain("if (verdict.needsUs && status.indexOf('waiting') === 0) patch.status = 'open';");
    expect(fn('_recordPracticeReplyFollowup')).toContain("if (task && task.task_type === 'visa_stage') return _recordAgentHandoverReply(caseId, task, reply);");
    // Both inbound paths hand over the recipient lines the verdict depends on.
    expect(serverSrc.split("to: emailMeta.to || '', cc: emailMeta.cc || '',").length - 1).toBe(2);
  });
});

describe('admin card', () => {
  it('is recognised, rendered by both dispatchers and parked on the handover thread’s last activity', () => {
    expect(adminSrc).toContain("function isAgentHandoverTask(t){ var ah=rgMeta(t).agent_handover; return !!(t&&t.task_type==='visa_stage'&&ah&&typeof ah==='object'); }");
    expect(adminSrc).toContain('function isRegGrantedPanelTask(t){ return isMigrationAgentTask(t)||isGpPassportsTask(t)||isAgentHandoverTask(t); }');
    expect(adminSrc).toContain('html=renderOpsAgentHandover(task,msgs);');
    expect(adminSrc).toContain('container.innerHTML=renderOpsAgentHandover(adapted,msgs);');
    expect(adminSrc).toContain("if(isAgentHandoverTask(t)){var ah=m.agent_handover||{};var lr=ah.last_reply||null;return (lr&&lr.needs_us===false&&lr.received_at)||ah.sent_at||t.updated_at||null;}");
  });

  it('sends the ticked documents and offers the manual button only when the case has no handover card', () => {
    expect(adminSrc).toContain("fetch('/api/admin/registration-granted/send-agent-handover'");
    expect(adminSrc).toContain('document_ids:hoDocIds');
    expect(adminSrc).toContain("fetch('/api/admin/registration-granted/agent-handover'");
    expect(adminSrc).toContain("if(agentContact&&!(S.tasks||[]).some(function(x){return x.case_id===task.case_id&&isAgentHandoverTask(x);}))");
  });

  it('the handover card is checked before the passports card in the guided line (both are visa_stage)', () => {
    expect(adminSrc.indexOf('if(isAgentHandoverTask(t)){\n      var _rgAh=')).toBeGreaterThan(-1);
    expect(adminSrc.indexOf('if(isAgentHandoverTask(t)){\n      var _rgAh=')).toBeLessThan(adminSrc.indexOf('if(isGpPassportsTask(t)){\n      var _rgGr='));
  });
});
