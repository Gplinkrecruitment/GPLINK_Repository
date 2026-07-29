import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Coverage for the 2026-07-30 support change (owner decisions):
//
//  1. The Chats tab is REMOVED. It was backed by `nudge_chat_messages`, a table
//     that does not exist in the database, and `user_nudges.chat_active`, a
//     column that does not exist either — so the list could never load and a
//     chat could never open. WhatsApp replaces it.
//
//  2. Support gains a "Chat to your officer via WhatsApp" button under
//     "Create New Ticket".
//
//  3. Routing: a GP who is NOT placed at a practice belongs to the GP Link
//     Admin pool; once placed, their case's assigned RSO owns them. "Placed"
//     means a row in `placements`, not merely a practice_name on the case.
//
// Source-level assertions, the same idiom the other messages.html/server.js
// structural tests use — there is no jsdom in this repo.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const messages = fs.readFileSync(path.join(ROOT, 'pages', 'messages.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const updatesSync = fs.readFileSync(path.join(ROOT, 'js', 'updates-sync.js'), 'utf8');

describe('the Chats tab is gone', () => {
  it('no Chats tab, view, or chat-detail slide remains', () => {
    expect(messages).not.toContain('data-view="viewChats"');
    expect(messages).not.toContain('id="viewChats"');
    expect(messages).not.toContain('id="slideChatDetail"');
    expect(messages).not.toContain('id="chatList"');
    expect(messages).not.toContain('<span>Chats</span>');
  });

  it('none of its JavaScript is left behind', () => {
    for (const dead of ['openChatDetail', 'renderChatList', 'loadNudgeChats', 'nudgeChats', 'selectedChatId']) {
      expect(messages).not.toContain(dead);
    }
    // The endpoint it called reads a table that does not exist.
    expect(messages).not.toContain('/api/user/nudge-chats');
  });

  it('the two remaining tabs are Support and FAQ', () => {
    expect(messages).toContain('data-view="viewMyTickets"');
    expect(messages).toContain('data-view="viewHelpCenter"');
    expect(messages).toMatch(/const views = \{ viewMyTickets:[^}]*viewHelpCenter:[^}]*\};/);
  });

  it('legacy deep links land on Support instead of dead-ending', () => {
    // Notifications already sent carry #chat-<id>; the home page links
    // #tab-updates. Neither may point at a view that no longer exists.
    expect(messages).toMatch(/h\.startsWith\("#chat-"\)\)\{switchView\("viewMyTickets"\)/);
    expect(messages).toContain('h==="#tab-updates"){switchView("viewMyTickets");}');
    expect(messages).toContain('else switchView("viewMyTickets");');
    // And updates-sync stops minting new #chat- links.
    expect(updatesSync).not.toContain('/pages/messages#chat-');
  });
});

describe('the WhatsApp button on Support', () => {
  it('sits under Create New Ticket inside one shared dock', () => {
    const dock = (messages.match(/<div class="fab-dock">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
    expect(dock).toContain('id="fabCreateTicket"');
    expect(dock).toContain('id="fabWhatsApp"');
    expect(dock.indexOf('fabCreateTicket')).toBeLessThan(dock.indexOf('fabWhatsApp'));
    expect(messages).toContain('Chat to your officer via WhatsApp');
  });

  it('the dock, not the button, carries the position at every breakpoint', () => {
    // Two independently-positioned fixed buttons drift apart the moment one
    // changes height; the dock keeps them in step on mobile, desktop and
    // embedded-in-app-shell.
    expect(messages).toMatch(/\.fab-dock \{[\s\S]*?position: fixed;/);
    expect(messages).toContain('.fab-dock { bottom: calc(170px + env(safe-area-inset-bottom, 0px)); }');
    expect(messages).toContain('.fab-dock { bottom: 28px; }');
    expect(messages).toMatch(/html\.gp-shell-embedded \.fab-dock \{/);
    // The old per-button positioning must be gone, or it fights the dock.
    expect(messages).not.toMatch(/\.fab \{[^}]*position: fixed/);
  });

  it('leaves room below the list so the taller dock cannot cover the last ticket', () => {
    expect(messages).toContain('.view { padding-bottom: 214px; }');
    expect(messages).toContain('.view { padding-bottom: 118px; }');
  });

  it('opens its window on the click, not after the await', () => {
    // Mobile popup blockers only trust a window opened during the gesture, so
    // opening it after awaiting the handoff would be swallowed.
    const handler = (messages.match(/fabWhatsAppEl\.addEventListener\("click"[\s\S]*?finally \{[\s\S]*?\}/) || [''])[0];
    expect(handler).toBeTruthy();
    expect(handler.indexOf('window.open(')).toBeLessThan(handler.indexOf('await fetch'));
    expect(handler).toContain('/api/support/whatsapp-handoff');
  });
});

describe('support routing: unplaced → admin pool, placed → assigned RSO', () => {
  it('the admin pool is the app-wide fallback RSO', () => {
    expect(server).toContain("const GP_ADMIN_RSO_EMAIL = 'hello@mygplink.com.au';");
    expect(server).toContain('const DEFAULT_RSO_USER_ID = GP_ADMIN_RSO_USER_ID;');
  });

  it('"placed" means a placements row, not a practice_name on the case', () => {
    const fn = (server.match(/async function resolveSupportRsoForUser[\s\S]*?\n\}/) || [''])[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain("supabaseDbRequest('placements'");
    // practice_name gets set while a placement is still being negotiated, so it
    // must NOT be what hands a GP over to an individual RSO.
    expect(fn).not.toContain('practice_name');
    expect(fn).toContain('out.rsoUserId = out.caseRow.assigned_va || out.caseRow.assigned_rso || GP_ADMIN_RSO_USER_ID;');
  });

  it('defaults to the admin pool, including when the lookup fails', () => {
    const fn = (server.match(/async function resolveSupportRsoForUser[\s\S]*?\n\}/) || [''])[0];
    expect(fn).toContain('rsoUserId: GP_ADMIN_RSO_USER_ID');
    // A thrown error must not stop a GP messaging us.
    expect(fn).toMatch(/catch \(err\)[\s\S]*console\.error\('\[support-rso\]/);
  });

  it('never rewrites the case assignment', () => {
    // The owner asked not to disturb GPs already placed and assigned. Routing
    // decides who owns the CONVERSATION; case assignment stays a human call.
    const fn = (server.match(/async function resolveSupportRsoForUser[\s\S]*?\n\}/) || [''])[0];
    expect(fn).not.toMatch(/method: 'PATCH'/);
    expect(fn).not.toMatch(/method: 'POST'/);
  });

  it('a dead placement does not count as placed', () => {
    expect(server).toMatch(/PLACEMENT_DEAD_STATUSES = new Set\(\[[^\]]*'cancelled'[^\]]*'withdrawn'/);
  });
});

describe('the handoff endpoint', () => {
  const handler = (server.match(/if \(pathname === '\/api\/support\/whatsapp-handoff'[\s\S]*?\n  \}/) || [''])[0];

  it('exists and requires a session', () => {
    expect(handler).toBeTruthy();
    expect(handler).toContain('requireSession(req, res)');
  });

  it('assigns the DoubleTick conversation to the owning RSO', () => {
    expect(handler).toContain('syncCaseChatAssignment({ gpPhone: gpPhone, assignedVaUserId: routed.rsoUserId })');
  });

  it('creates ONE open task and refreshes it rather than stacking duplicates', () => {
    // Owner's choice: tapping five times must not leave five tasks.
    expect(handler).toContain("task_type: 'whatsapp_help'");
    expect(handler).toContain('status=in.(open,in_progress,waiting)');
    expect(handler).toMatch(/if \(existing\) \{[\s\S]*method: 'PATCH'/);
    expect(handler).toContain("source_trigger: 'app_whatsapp_button'");
    expect(handler).toContain('assignee: routed.rsoUserId || null');
  });

  it('still returns the WhatsApp URL even if the background steps fail', () => {
    // A DoubleTick outage or a DB hiccup must never stop a GP messaging us.
    expect(handler).toMatch(/catch \(waErr\)[\s\S]*console\.error\('\[support-handoff\]/);
    expect(handler).toMatch(/sendJson\(res, 200, \{\s*ok: true,\s*waUrl: waUrl/);
  });
});

describe('the admin pool reads as a team, never as a person', () => {
  it('has a GP-facing name helper that special-cases the pool', () => {
    const fn = (server.match(/function rsoGpFacingFirstName[\s\S]*?\n\}/) || [''])[0];
    expect(fn).toBeTruthy();
    // "GP Link Admin".split(' ')[0] === "GP" — "reply and GP will match you
    // personally" is what this exists to prevent.
    expect(fn).toContain('GP_ADMIN_RSO_EMAIL');
    expect(fn).toContain("fallback || 'your GP Link team'");
  });

  it('both GP-facing name sites go through it', () => {
    expect(server).not.toMatch(/String\(\(rso && rso\.name\) \|\| 'Hazel'\)/);
    const uses = server.match(/rsoGpFacingFirstName\(rso/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });
});
