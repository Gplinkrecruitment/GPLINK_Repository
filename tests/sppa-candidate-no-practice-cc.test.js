import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The SPPA-00 "Send to candidate" composer must never offer a practice CC.
//
// Seen live on Dr Mercy Obanimoh (2026-08-11): the CC box on her own SPPA-00
// carried "Practice Manager <pm@thefamilydoctors.com.au>". loadCcContacts fills
// EVERY [data-email-cc] on the page from the case's harvested contacts, and
// those are all practice-side — but this one composer is addressed to the
// DOCTOR, and the SPPA-00 is her personal declaration (Section A + her
// signature). Worse on this case specifically: the scan had just found her
// supervisor IS the practice owner, so the practice was the last party that
// should have been copied.
//
// /email-contacts already strips the practice's PRIMARY contact for exactly
// this reason, but anyone else picked off a reply thread walks past that
// filter, so the composer itself must not have the field.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(ROOT, 'pages', 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// Drop whole-line // comments before asserting — the comment that replaced the
// CC row names the very attribute these tests check for, and the same idiom is
// used by the support-handoff tests for exactly this reason.
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// The block that renders the SPPA-00 composer addressed to the candidate:
// from its "Send SPPA-00 to candidate" heading up to its send button.
const candidateComposer = stripComments((admin.match(
  /Send SPPA-00 to candidate<\/div>'[\s\S]*?data-ops-send-email/
) || [''])[0]);

// The sibling block addressed to the practice.
const practiceComposer = (admin.match(
  /Send SPPA-00 to practice<\/div>'[\s\S]*?data-ops-send-email/
) || [''])[0];

describe('SPPA-00 to the candidate carries no practice CC', () => {
  it('the candidate composer exists and is addressed to the candidate', () => {
    expect(candidateComposer).toBeTruthy();
    expect(candidateComposer).toContain('esc(candidateEmail)');
  });

  it('has NO CC field at all', () => {
    expect(candidateComposer).not.toContain('data-email-cc');
    expect(candidateComposer).not.toContain('ops-cc-row');
  });

  it('the practice-facing composer KEEPS its CC — that one is meant to copy them', () => {
    expect(practiceComposer).toBeTruthy();
    expect(practiceComposer).toContain('esc(practiceEmail)');
    expect(practiceComposer).toContain('data-email-cc');
  });

  it('sending still works with no CC control present', () => {
    // The send handler reads selectedOptions off the CC select; it has to stay
    // null-safe or removing the field would break the send outright.
    expect(admin).toContain(
      "var ccVal=ccEl?Array.from(ccEl.selectedOptions).map(function(o){return o.value;}).filter(Boolean).join(', '):'';"
    );
  });

  it('the CEO dashboard route to the candidate sends without a CC', () => {
    // CEO uses a server endpoint rather than an inline composer — it must not
    // grow a practice CC either, or the same leak reappears on that surface.
    const ep = server.slice(server.indexOf("pathname.endsWith('/sppa-send-to-candidate')"));
    const handler = ep.slice(0, ep.indexOf('\n  }'));
    expect(handler).toContain('to: candidateEmail');
    expect(handler).not.toMatch(/\bcc:/);
  });
});
