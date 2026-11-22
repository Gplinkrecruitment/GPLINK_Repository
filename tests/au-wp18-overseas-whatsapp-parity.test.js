// WP-18 overseas parity: every WhatsApp an overseas doctor, an overseas lead
// and a practice receiving an overseas candidate is sent (template name,
// variables, buttons, header, and the free-text fallbacks), with the
// Australian switch ON (nothing recorded on the doctor) and OFF.
//
// The snapshot was written on the tree BEFORE WP-18 changed any behaviour.
// NEVER regenerate it to make this test pass: a difference here means an
// overseas recipient's WhatsApp changed. (WP18_WRITE_PARITY=1 exists only so
// the file could be created once.)
//
// The lead funnel, the practice introduction, the placement and the passport
// request already have their own before-snapshots, which this package must
// also leave passing: au-wp16-overseas-parity, au-wp10-overseas-parity,
// au-wp09-overseas-intro-parity, au-wp11-overseas-parity, au-wp14-*-parity.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const R = require('./helpers/au-wp18-rig.js');

const SNAPSHOT = path.join(__dirname, 'fixtures', 'au-wp18-overseas-whatsapp.snapshot.json');

// The booking confirmation goes to the doctor and to the practice AT THE SAME
// TIME (two sends started together, to two different phones), so which of the
// two reaches DoubleTick first is not something either of them can see. The
// pair is compared as a set: sorted by template name on both sides. Every
// other step is compared in the order it was sent.
function canon(capture) {
  const out = JSON.parse(JSON.stringify(capture));
  Object.keys(out).forEach((who) => {
    if (out[who] && Array.isArray(out[who].booked)) out[who].booked.sort((a, b) => String(a.templateName).localeCompare(String(b.templateName)));
  });
  return out;
}
const PEOPLE = { uk: [1, 2], ie: [3, 4] };

describe('WP-18: an overseas recipient\'s WhatsApps are byte-identical', () => {
  let rig = null;
  const got = { off: {}, on: {} };
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(R.NOW));
    const docs = {};
    for (const key of Object.keys(PEOPLE)) { docs[key] = { off: R.overseasDoctor(key, PEOPLE[key][0]), on: R.overseasDoctor(key, PEOPLE[key][1]) }; }
    rig = await R.bootWhatsAppRig({ name: 'wp18-parity', doctors: Object.keys(docs).reduce((l, k) => l.concat([docs[k].off, docs[k].on]), []) });
    for (const sw of ['off', 'on']) {
      rig.setSwitch(sw === 'on');
      for (const key of Object.keys(PEOPLE)) {
        vi.setSystemTime(new Date(R.NOW));
        // The diary is emptied so both runs are offered the same times.
        rig.table('scheduled_calls').forEach((r) => { r.status = 'cancelled'; });
        const j = await R.doctorJourney(rig, docs[key][sw], { rawStageSender: true });
        got[sw][key] = j.wa;
      }
      vi.setSystemTime(new Date(R.NOW));
      got[sw].lead = (await R.leadJourney(rig, R.leadRow('uk'))).wa;
    }
    // The two runs use two doctors each (a fresh case per run): their phone
    // numbers and surnames are the only thing that differs, and are scrubbed.
    if (process.env.WP18_WRITE_PARITY === '1') fs.writeFileSync(SNAPSHOT, JSON.stringify(got.off, null, 2) + '\n');
  }, 240000);
  afterAll(async () => { if (rig) await rig.close(); vi.useRealTimers(); });

  it('the capture is not empty: every sender really sent', () => {
    const uk = got.off.uk;
    const names = (label) => (uk[label] || []).filter((m) => m.type === 'template').map((m) => m.templateName);
    expect(names('intro')).toEqual(['gp_link_practice_candidate_intro']);
    expect(names('timesReady')).toEqual(['gp_link_interview_times_ready']);
    expect(names('booked').sort()).toEqual(['gp_link_interview_confirmed_gp', 'gp_link_interview_confirmed_practice']);
    expect(names('resend').sort()).toEqual(['gp_link_interview_confirmed_gp', 'gp_link_interview_confirmed_practice']);
    expect(uk.resend.filter((m) => m.type === 'text')).toHaveLength(2);
    expect(names('matchInvitation')).toEqual(['gp_link_app_match_invitation']);
    expect(names('matchAccepted')).toEqual(['gp_link_app_match_accepted']);
    expect(uk.matchAcceptedTemplateRefused.map((m) => m.type)).toEqual(['template', 'text']);
    expect(names('contractReady')).toEqual(['gp_link_contract_ready']);
    expect(names('accountReleased')).toEqual(['gp_link_account_released']);
    for (const label of ['assignAdminCase', 'assignOpsCase', 'assignBulk', 'assignResync', 'assignDirect']) expect(names(label), label).toEqual(['gp_link_app_rso_welcome']);
    expect(names('stageMessages')).toContain('gp_link_app_myintealth_introductiory_message_');
    expect(names('stageMessages')).toContain('gp_link_app_amc_introductiory_message_');
    expect(names('callReminder:registration:dayBefore')).toEqual(['gp_link_reg_call_reminder']);
    expect(names('callReminder:registration:starting')).toEqual(['gp_link_reg_call_starting']);
    expect(names('dropoff:career_cv')).toEqual(['gp_link_upload_cv_nudge']);
    expect(names('dropoffStep:gp_link_onboarding_step_move')).toEqual(['gp_link_onboarding_step_move']);
    const lead = got.off.lead;
    expect(lead['kind:hello_5m'][0].templateName).toBe('gp_link_consult_hello_5m');
    expect(lead['callReminder:hourBefore'][0].templateName).toBe('gp_link_consult_call_1h');
  });

  it('switch OFF: identical to the snapshot taken before WP-18', () => {
    expect(canon(got.off)).toEqual(canon(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))));
  });

  it('switch ON, nothing recorded on the doctor or the lead: identical to the same snapshot', () => {
    expect(canon(got.on)).toEqual(canon(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))));
  });
});
