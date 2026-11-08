/**
 * AHPRA registration granted → visa stage: the RSO side in pages/admin.html.
 *
 * When AHPRA's Final Notice lands the server records the registration on the case and
 * creates three kinds of registration_tasks for the assigned RSO:
 *   migration_agent  (metadata.outbound_email)  — email the practice, record the agent
 *   visa_stage       (metadata.gp_request)      — request passports from the GP + family
 *   followup         (metadata.conditions_tracker) — dated conditions review, display only
 *
 * These are static assertions on the page source (the console is one IIFE with no
 * module boundary, so this is how the other admin UI tests pin behaviour too). They
 * guard: the endpoints each button calls, the letter-type select on the Log AHPRA
 * letter modal, the task-type branches in every dispatch point, the registration strip
 * in the GP header, and the WhatsApp preview substitution.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin.html'), 'utf8');

function fnSource(name) {
  const re = new RegExp('\\n  (?:async )?function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}\\n');
  const m = ADMIN.match(re);
  if (!m) throw new Error('function ' + name + ' not found in admin.html');
  return m[0];
}

describe('registration-granted task cards call the right endpoints', () => {
  const handler = fnSource('handleRegGrantedClick');

  it('"Send to practice" posts task_id/to/cc/subject/bodyHtml to send-practice-email', () => {
    expect(handler).toContain("/api/admin/registration-granted/send-practice-email");
    expect(handler).toMatch(/send-practice-email[\s\S]*?body:JSON\.stringify\(\{task_id:tid,to:to,cc:cc,subject:subject,bodyHtml:rgTextToHtml\(bodyText\),followup:followup,nudge:nudge\}\)/);
    // The follow-up composer (practice replied) flags itself so the server threads onto their reply.
    expect(handler).toContain("var followup=sendBtn.getAttribute('data-rg-followup')==='1';");
    // The 422 internal-note guard is surfaced to the RSO, not swallowed.
    expect(handler).toContain("internal_note_in_body");
  });

  it('"Send email + WhatsApp" / "Retry WhatsApp" post { task_id } to send-gp-request and report both legs', () => {
    expect(handler).toContain("/api/admin/registration-granted/send-gp-request");
    // Plain send/retry posts { task_id }; the reminder button adds kind:'reminder'.
    expect(handler).toMatch(/send-gp-request[\s\S]*?body:JSON\.stringify\(kind3\?\{task_id:tid3,kind:kind3\}:\{task_id:tid3\}\)/);
    expect(handler).toContain("var kind3=gpBtn.getAttribute('data-rg-kind')||'';");
    // Reported per leg; the reminder button reuses the same reporting ("Reminder sent. WhatsApp not sent: …").
    expect(handler).toContain("' sent. WhatsApp not sent: '");
    expect(handler).toContain("var what3=kind3==='reminder'?'Reminder':'Email';");
  });

  it('"Save agent" writes migration_agent + migration_agent_contact to the case-update route', () => {
    expect(handler).toMatch(/\/api\/admin\/ops\/case\?id='\+encodeURIComponent\(caseId\)/);
    expect(handler).toMatch(/body:JSON\.stringify\(\{caseId:caseId,migration_agent:name\|\|null,migration_agent_contact:contact\|\|null\}\)/);
  });

  it('"Mark complete" reuses the existing task PUT with status completed', () => {
    expect(handler).toMatch(/data-rg-complete[\s\S]*?\/api\/admin\/task\?id='\+encodeURIComponent\(tid4\)[\s\S]*?status:'completed'/);
  });

  it('is wired into BOTH click surfaces (GP profile pane and Ops Queue rows)', () => {
    const detailIdx = ADMIN.indexOf('document.getElementById("detailContent").addEventListener("click"');
    const opsIdx = ADMIN.indexOf('document.getElementById("opsTableBody").addEventListener("click"');
    expect(detailIdx).toBeGreaterThan(0);
    expect(opsIdx).toBeGreaterThan(0);
    expect(ADMIN.slice(detailIdx, detailIdx + 600)).toContain('if(await handleRegGrantedClick(e))return;');
    expect(ADMIN.slice(opsIdx, opsIdx + 600)).toContain('if(await handleRegGrantedClick(e))return;');
  });

  it('uses data-* delegation, never inline onclick (which the IIFE would not expose)', () => {
    const panels = fnSource('renderOpsMigrationAgent') + fnSource('renderOpsGpPassports');
    expect(panels).not.toMatch(/onclick=/);
    for (const attr of ['data-rg-send-practice', 'data-rg-save-agent', 'data-rg-send-gp', 'data-rg-complete']) {
      expect(panels).toContain(attr);
    }
  });
});

describe('migration_agent and visa_stage branches exist at every dispatch point', () => {
  it('defines the type guards on metadata, not just task_type', () => {
    expect(ADMIN).toContain("function isMigrationAgentTask(t){ return !!(t&&t.task_type==='migration_agent'&&rgMeta(t).outbound_email); }");
    expect(ADMIN).toContain("function isGpPassportsTask(t){ return !!(t&&t.task_type==='visa_stage'&&rgMeta(t).gp_request); }");
    expect(ADMIN).toContain("function isConditionsTrackerTask(t){ return !!(t&&t.task_type==='followup'&&rgMeta(t).conditions_tracker); }");
  });

  it('marks the cards as expand-on-click panels wherever the other panel types are listed', () => {
    const sites = ADMIN.split('\n').filter((l) => l.includes("t.task_type==='ahpra_conflict_letter'") && l.includes("t.task_type==='alt_supervisor_cv_request'"));
    // _hasDetailPanel, the st-actions gate, the detail-panel container, the auto-expand loop.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    sites.forEach((l) => expect(l).toContain('isRegGrantedPanelTask(t)'));
  });

  it('routes the cards to their renderers in the GP profile and the Ops Queue', () => {
    // Both renderers get the task's message thread; the passports card also gets the live
    // passport status (what is in, what is missing, the reminder draft) from the server.
    expect(fnSource('loadGpTaskDetail')).toMatch(/isMigrationAgentTask\(adapted\)[\s\S]*?renderOpsMigrationAgent\(adapted,msgs\)[\s\S]*?isGpPassportsTask\(adapted\)[\s\S]*?renderOpsGpPassports\(adapted,msgs,await rgLoadPassportStatus\(taskId\)\)/);
    expect(fnSource('renderExpandedOpsRow')).toMatch(/isMigrationAgentTask\(task\)[\s\S]*?renderOpsMigrationAgent\(task,msgs\)[\s\S]*?isGpPassportsTask\(task\)[\s\S]*?renderOpsGpPassports\(task,msgs,await rgLoadPassportStatus\(task\.id\)\)/);
    expect(fnSource('rgLoadPassportStatus')).toContain("/api/admin/registration-granted/gp-request-status?task_id='+encodeURIComponent(taskId)");
  });

  it('gives the new types a guided prompt and an Ops Queue subtitle', () => {
    const guided = fnSource('getGuidedAction');
    expect(guided).toContain('isMigrationAgentTask(t)');
    expect(guided).toContain('isGpPassportsTask(t)');
    expect(guided).toContain('isConditionsTrackerTask(t)');
    const subtitle = fnSource('opsGetSubtitle');
    expect(subtitle).toContain('tt==="migration_agent"');
    expect(subtitle).toContain('tt==="visa_stage"');
    expect(subtitle).toContain('isConditionsTrackerTask(t)');
  });

  it('a conditions-tracker task is a dated reminder, not an overdue ball-in-court item', () => {
    // status 'waiting' gets its own pill instead of defaulting to "Hazel".
    expect(fnSource('opsGetBallPill')).toContain('if(status==="waiting")return {cls:"ball-ahpra",label:"Scheduled"};');
    // The GP Tasks pane shows a green tracker pill with the review date.
    expect(ADMIN).toMatch(/isConditionsTrackerTask\(t\)\)\{\s*html\+='<div><span class="st-waiting-pill" style="background:#ecfdf5;color:#047857">/);
    // Overdue is still computed from the due date only, so a future review date never flags.
    expect(ADMIN).toContain("const isOverdue=t.is_overdue||(t.due_date&&new Date(t.due_date)<new Date());");
  });
});

describe('migration-agent card contents', () => {
  const src = fnSource('renderOpsMigrationAgent');
  it('has editable To / Cc / Subject / Body and a Send to practice button; once sent it offers a nudge, never "Send again"', () => {
    for (const attr of ['data-rg-to', 'data-rg-cc', 'data-rg-subject', 'data-rg-body']) expect(src).toContain(attr);
    expect(src).toContain('Send to practice');
    // Owner report 2026-11-08 (second screenshot): the congratulations email was offered again
    // after the follow-up had gone. It is offered once, in the not-yet-sent branch only.
    expect(src).not.toContain('Send again');
    expect(src).toContain("}else if(!sent){");
    expect(src.indexOf('Email the practice</div>')).toBeGreaterThan(src.indexOf("}else if(!sent){"));
    expect(src).toMatch(/Sent '\+esc\(fmtDT\(em\.sent_at\)\)\+\(em\.by\?' by '\+esc\(em\.by\)/);
  });
  it('has the Record the migration agent block reading the case row and offering Mark complete once saved', () => {
    expect(src).toContain('rgCaseForTask(task)');
    expect(src).toContain('c.migration_agent');
    expect(src).toContain('c.migration_agent_contact');
    expect(src).toContain('data-rg-agent-name');
    expect(src).toContain('data-rg-agent-contact');
    expect(src).toMatch(/if\(hasAgent\)h\+='<button class="ops-btn-green" data-rg-complete=/);
  });
});

describe('GP passports card contents', () => {
  const src = fnSource('renderOpsGpPassports');
  it('lists the people, previews the email and the WhatsApp text, and sends both with one button', () => {
    expect(src).toContain('Passports needed for');
    expect(src).toContain('Email preview');
    expect(src).toContain('WhatsApp preview');
    expect(src).toContain('rgWhatsappPreview(wa)');
    expect(src).toContain('Send email + WhatsApp');
  });
  it('shows the WhatsApp failure plainly with a retry', () => {
    expect(src).toContain('WhatsApp not sent: ');
    expect(src).toContain('Retry WhatsApp');
    expect(src).toContain('data-rg-retry="whatsapp"');
  });
  it('substitutes {{1}} / {{2}} from gp_request.whatsapp.placeholders', () => {
    const tpl = ADMIN.match(/var RG_WHATSAPP_TEMPLATE_TEXT='([^']+)';/);
    expect(tpl).toBeTruthy();
    expect(tpl[1]).toBe('Great news {{1}}, your AHPRA registration has come through. Next step is the visa. Your practice is engaging a migration agent now, and we need a clear photo of the passport photo page for you and everyone moving with you. Upload them here: {{2}} Shout if anything is unclear, I read these myself.');
    const fn = fnSource('rgWhatsappPreview');
    // eslint-disable-next-line no-new-func
    const preview = new Function('RG_WHATSAPP_TEMPLATE_TEXT', 'return (' + fn.trim().replace(/^function rgWhatsappPreview/, 'function') + ')')(tpl[1]);
    const out = preview({ placeholders: ['Amira', 'https://app.mygplink.com.au/pages/visa'] });
    expect(out.startsWith('Great news Amira, your AHPRA registration')).toBe(true);
    expect(out).toContain('Upload them here: https://app.mygplink.com.au/pages/visa Shout');
    expect(out).not.toContain('{{');
    // Missing placeholders are left visible rather than silently blanked.
    expect(preview({})).toContain('{{1}}');
  });
});

describe('GP header registration strip', () => {
  const src = fnSource('rgRegistrationLineHtml');
  it('renders "Registered <number> · effective <date> · current to <date>" only when a number is set', () => {
    expect(src).toContain("if(!c||!c.ahpra_registration_number)return '';");
    expect(src).toContain('Registered ');
    expect(src).toContain("effective '+esc(fmtD(c.ahpra_registration_effective_date))");
    expect(src).toContain("current to '+esc(fmtD(c.ahpra_registration_expiry_date))");
  });
  it('shows the conditions summary on hover (title) and the detail on expand', () => {
    expect(src).toContain('<details');
    expect(src).toMatch(/<summary title="'\+esc\(tip\)\+'"/);
    expect(src).toContain('cond.review_period_months');
    expect(src).toContain('cond.supervised_practice');
  });
  it('is placed in the profile bar next to the stage pill', () => {
    const idx = ADMIN.indexOf('${rgRegistrationLineHtml(c)}');
    expect(idx).toBeGreaterThan(0);
    expect(ADMIN.slice(idx, idx + 900)).toContain('case-stage-pill stage-${esc(c.stage||\'\')}');
  });
});

describe('Log AHPRA letter modal — letter type', () => {
  const src = fnSource('openAhpraLetterModal');
  it('has a Letter type select with the RFI default and the granted final notice', () => {
    expect(src).toMatch(/<select id="ahpraLetterType"[^>]*><option value="rfi" selected>Request for further information \(default\)<\/option><option value="granted">Registration granted \(final notice\)<\/option><\/select>/);
  });
  it('shows the registration fields for the granted type', () => {
    for (const id of ['ahpraGrantRegNo', 'ahpraGrantRegType', 'ahpraGrantEffective', 'ahpraGrantExpiry', 'ahpraGrantHasCond', 'ahpraGrantCondSummary', 'ahpraGrantCommence', 'ahpraGrantSupervisor', 'ahpraGrantFile']) {
      expect(src).toContain('id="' + id + '"');
    }
  });
  it('posts the granted notice to /api/admin/ahpra/registration-granted with the documented body', () => {
    expect(src).toContain("/api/admin/ahpra/registration-granted");
    expect(src).toContain('var payload={registrationNumber:regNo,registrationType:regType,effectiveDate:effective,expiryDate:expiry||null,hasConditions:hasCond,conditionsSummary:condSummary||null,commencementDate:commence||null,supervisor:supervisor||null};');
    expect(src).toContain('if(caseId)payload.caseId=caseId;');
    expect(src).toContain('if(email)payload.gpEmail=email;');
    expect(src).toContain('payload.fileDataUrl=await readFileAsDataUrl(file); payload.fileName=file.name; payload.mimeType=');
  });
  it('keeps the default RFI path on /api/admin/ahpra/ingest-manual', () => {
    expect(src).toContain("/api/admin/ahpra/ingest-manual");
    expect(src).toContain("body:JSON.stringify({gp_email:email,subject:subject,body:bodyTxt,officer_name:officerName,officer_email:officerEmail})");
  });
  it('receives the case id from the Log AHPRA letter button', () => {
    expect(src).toMatch(/function openAhpraLetterModal\(gpEmail,caseId\)/);
    expect(ADMIN).toContain('openAhpraLetterModal(logAhpra.getAttribute("data-gp-email")||"",logAhpra.getAttribute("data-log-ahpra-letter")||"")');
  });
});

describe('migration-agent card: the practice replied (owner report 2026-11-08)', () => {
  const src = fnSource('renderOpsMigrationAgent');
  it('takes the message thread and shows their reply + the AI read + a follow-up composer instead of "Send again"', () => {
    expect(src).toMatch(/^\n  function renderOpsMigrationAgent\(task,msgs\)\{/);
    expect(src).toContain("var awaitingOurReply=lastMsg?lastMsg.direction==='inbound':!!(pr&&pr.received_at&&!pr.answered_at);");
    expect(src).toContain('if(sent&&awaitingOurReply){');
    expect(src).toContain('Practice replied');
    expect(src).toContain('rgMigrationOutcomeGuidance(pr.outcome)');
    expect(src).toContain('data-rg-followup="1">Send follow-up</button>');
    expect(src).toContain('data-rg-practice-draft="\'+tid+\'">');
    // The follow-up goes where the AI read says (the person they handed it to), falling back to whoever replied.
    expect(src).toContain("var fuTo=(pr&&pr.reply_to)||replyFrom||em.to||'';");
    expect(src).toContain('var fuBody=prReady?pr.suggested_reply:');
    expect(src).toContain('opsRenderThread(thread)');
  });
  it('while waiting on the practice it offers a collapsed nudge to whoever we last wrote to, drafted from the thread', () => {
    expect(src).toContain('data-rg-nudge-toggle="\'+tid+\'">Nudge \'+(lastFollowup?\'them\':\'the practice\')+\'</button>');
    expect(src).toContain("var nudgeTo=(lastFollowup&&lastFollowup.to)||em.to||'';");
    expect(src).toContain('data-rg-followup="1" data-rg-nudge="1" disabled>Send nudge</button>');
    expect(src).toContain('data-rg-nudge-draft="\'+tid+\'">Re-draft with AI</button>');
    expect(src).toContain('⏳ Waiting on the practice to ');
    const ensure = fnSource('rgEnsureMigrationNudge');
    expect(ensure).toMatch(/\/api\/admin\/practice-nudge\/draft[\s\S]*?body:JSON\.stringify\(\{taskId:tid\}\)/);
    expect(fnSource('rgApplyMigrationNudge')).toContain("if(sendBtn)sendBtn.disabled=false;");
    const handler = fnSource('handleRegGrantedClick');
    expect(handler).toContain("var nudge=sendBtn.getAttribute('data-rg-nudge')==='1';");
    expect(handler).toMatch(/data-rg-nudge-toggle[\s\S]*?if\(openingN\)rgEnsureMigrationNudge\(tidN\);/);
    expect(handler).toMatch(/data-rg-nudge-draft[\s\S]*?rgEnsureMigrationNudge\(nudgeDraftBtn\.getAttribute\('data-rg-nudge-draft'\),true\)/);
    const guided = fnSource('getGuidedAction');
    expect(guided).toContain("' — send the nudge on the card'");
  });
  it('pre-fills Record the migration agent from the AI read until something is on file', () => {
    expect(src).toContain("var suggestedName=(!hasAgent&&pr&&pr.agent_name)||'';");
    expect(src).toContain('value="\'+esc(agentName||suggestedName)+\'"');
    expect(src).toContain('value="\'+esc(agentContact||suggestedContact)+\'"');
  });
  it('guided line and Ops subtitle say the practice replied, never "record the agent once they confirm"', () => {
    const guided = fnSource('getGuidedAction');
    expect(guided).toContain("prompt:'Practice replied — read the reply and send the follow-up',label:'Read Reply'");
    expect(guided).toContain("if(_rgEm.sent_at&&_rgPr&&_rgPr.received_at&&!_rgPr.answered_at&&String(t.status||'').indexOf('waiting')!==0){");
    expect(guided.indexOf("Practice replied — read the reply")).toBeLessThan(guided.indexOf("Practice emailed — record the migration agent once they confirm"));
    expect(fnSource('opsGetSubtitle')).toContain('"Migration agent · practice replied "+fmtD(_mpr.received_at)');
  });
  it('the Draft with AI button posts { taskId } to the shared practice-reply draft endpoint', () => {
    const handler = fnSource('handleRegGrantedClick');
    expect(handler).toMatch(/data-rg-practice-draft[\s\S]*?\/api\/admin\/practice-reply\/draft[\s\S]*?body:JSON\.stringify\(\{taskId:tidD\}\)/);
  });
});

describe('GP passports card: a reminder nudge after the first send (owner report 2026-11-08)', () => {
  const src = fnSource('renderOpsGpPassports');
  it('takes the thread and the live passport status, and only shows the congratulations email before the first send', () => {
    expect(src).toMatch(/^\n  function renderOpsGpPassports\(task,msgs,ps\)\{/);
    expect(src).toContain('var firstSent=emailSent||waOk;');
    expect(src).toContain('if(!firstSent){');
    expect(src).toContain('}else if(ps&&ps.all_received){');
    expect(src).toContain('Reminder nudge');
    expect(src).toContain('data-rg-kind="reminder">Send reminder (email + WhatsApp)</button>');
    expect(src).toContain('rgWhatsappPreview(remWa,RG_WHATSAPP_REMINDER_TEMPLATE_TEXT)');
    // The congratulations preview lives only in the not-yet-sent branch.
    expect(src.indexOf('Email preview')).toBeGreaterThan(src.indexOf('if(!firstSent){'));
    expect(src.indexOf('Email preview')).toBeLessThan(src.indexOf('}else if(ps&&ps.all_received){'));
  });
  it('marks each passport as in or still missing from the live status', () => {
    expect(src).toContain("var got=p.status==='uploaded'||p.status==='approved';");
    expect(src).toContain("(got?'ball-ahpra':'ball-gp')");
  });
  it('shows the doctor\'s first name in the preview where the server substitutes {{name}}', () => {
    expect(src).toContain("var fillName=function(s){return String(s||'').replace(/\\{\\{name\\}\\}/g,firstName);};");
    expect(src).toContain('esc(fillName(em.title))');
    expect(src).toContain('esc(fillName(remEm.body||\'\'))');
  });
  it('the reminder WhatsApp preview matches the DoubleTick template body (gp_link_visa_passports_reminder)', () => {
    const tpl = ADMIN.match(/var RG_WHATSAPP_REMINDER_TEMPLATE_TEXT='([^']+)';/);
    expect(tpl).toBeTruthy();
    expect(tpl[1]).toBe('Hi {{1}}, a quick reminder from GP Link. For your visa we are still waiting on {{2}}. Please upload a clear photo of the passport photo page for each person here: {{3}} If a passport is delayed, just reply here and let me know.');
    const fn = fnSource('rgWhatsappPreview');
    // eslint-disable-next-line no-new-func
    const preview = new Function('RG_WHATSAPP_TEMPLATE_TEXT', 'return (' + fn.trim().replace(/^function rgWhatsappPreview/, 'function') + ')')('unused');
    expect(preview({ placeholders: ['Mercy', "your partner's passport", 'https://app.mygplink.com.au/pages/visa'] }, tpl[1]))
      .toBe("Hi Mercy, a quick reminder from GP Link. For your visa we are still waiting on your partner's passport. Please upload a clear photo of the passport photo page for each person here: https://app.mygplink.com.au/pages/visa If a passport is delayed, just reply here and let me know.");
  });
  it('guided line reports reminders sent and the subtitle counts them', () => {
    const guided = fnSource('getGuidedAction');
    expect(guided).toContain("' — waiting on the GP to upload the passports'");
    expect(guided).toContain('reminder nudge ready on the card');
    expect(fnSource('opsGetSubtitle')).toContain('"Passport reminder "+_vr.length+" sent "');
  });
});
