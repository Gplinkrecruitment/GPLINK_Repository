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
//     means a recorded placement — in gp_applications (authoritative) or the
//     `placements` mirror — not merely a practice_name on the case.
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

  // Regression (2026-07-30): the first version opened a blank tab on click and
  // only pointed it somewhere after the handoff had done several database
  // round-trips. On mobile that showed a blank page. It must be a plain link
  // navigation, which is also what hands off to the installed WhatsApp app.
  it('is a real anchor, so phones open the WhatsApp app', () => {
    expect(messages).toMatch(/<a class="fab-wa" id="fabWhatsApp"[^>]*>/);
    expect(messages).not.toMatch(/<button class="fab-wa"/);
    // An <a> needs the link styling stripped or it renders underlined/purple.
    expect(messages).toMatch(/\.fab-wa, \.fab-wa:visited, \.fab-wa:hover \{ text-decoration: none;/);
  });

  it('fills the href at load time, not on click', () => {
    expect(messages).toContain('/api/support/whatsapp-link');
    expect(messages).toContain('fabWhatsAppEl.setAttribute("href", d.waUrl)');
  });

  it('never blocks the tap on the handoff request', () => {
    const handler = (messages.match(/fabWhatsAppEl\.addEventListener\("click"[\s\S]*?\n      \}\);/) || [''])[0];
    expect(handler).toBeTruthy();
    // keepalive lets it outlive the navigation; awaiting it is what caused the
    // blank page, so the handler must not await anything before navigating.
    // Comments are stripped first — the code explains itself using the word
    // "await", which a naive substring check trips over.
    const code = handler.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(handler).toContain('keepalive: true');
    expect(code).not.toMatch(/\bawait\b/);
    expect(code).not.toContain('window.open(');
    // With an href present the browser navigates natively — no preventDefault.
    expect(handler).toMatch(/if \(fabWhatsAppEl\.getAttribute\("href"\)\) return;/);
  });
});

describe('support routing: unplaced → admin pool, placed → assigned RSO', () => {
  it('the admin pool is the app-wide fallback RSO', () => {
    expect(server).toContain("const GP_ADMIN_RSO_EMAIL = 'hello@mygplink.com.au';");
    expect(server).toContain('const DEFAULT_RSO_USER_ID = GP_ADMIN_RSO_USER_ID;');
  });

  it('"placed" means a recorded placement, not a practice_name on the case', () => {
    const fn = (server.match(/async function resolveSupportRsoForUser[\s\S]*?\n\}/) || [''])[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain("supabaseDbRequest('placements'");
    // practice_name gets set while a placement is still being negotiated, so it
    // must NOT be what hands a GP over to an individual RSO.
    expect(fn).not.toContain('practice_name');
    expect(fn).toContain('out.rsoUserId = out.caseRow.assigned_va || out.caseRow.assigned_rso || GP_ADMIN_RSO_USER_ID;');
  });

  // Regression (2026-08-11), Dr Mercy Obanimoh: placed at The Doctors Werribee
  // and assigned to Hazel, but every WhatsApp she sent re-assigned her chat to
  // the admin pool's number. `placements` is the newer mirror and only the ATS
  // offer-accept flow writes it — it held ONE row in all of production — while
  // the staff placement paths write gp_applications. Reading the mirror alone
  // made a placed GP look unplaced and displaced the RSO looking after her.
  it('reads the AUTHORITATIVE gp_applications store, not just the placements mirror', () => {
    const fn = (server.match(/async function resolveSupportRsoForUser[\s\S]*?\n\}/) || [''])[0];
    expect(fn).toContain('hasPlacedApplicationRow(userId)');
    // Either store counts — a mirror row must not be required.
    expect(fn).toMatch(/out\.placed = placedApp \|\| rows\.some\(/);
  });

  it('decides which statuses count in ONE place, shared with every other placement lookup', () => {
    const helper = (server.match(/async function hasPlacedApplicationRow[\s\S]*?\n\}/) || [''])[0];
    expect(helper).toBeTruthy();
    expect(helper).toContain("supabaseDbRequest('gp_applications'");
    // The shared constant, not a hand-rolled status list: a placement written
    // straight to the database carries status='placement_secured' with
    // ats_stage='hired', so status='hired' alone misses it.
    expect(helper).toContain('practiceContactLib.PLACED_APPLICATION_FILTER');
    expect(helper).not.toContain('status.eq.hired');
    // Fail-soft, like the placements probe beside it: no row / failed read = not placed.
    expect(helper).toContain('return !!(r.ok && Array.isArray(r.data) && r.data.length > 0);');
  });

  it('the two placement lookups run together, not one after the other', () => {
    // This is on the inbound-message path — it must not add a serial round-trip.
    const fn = (server.match(/async function resolveSupportRsoForUser[\s\S]*?\n\}/) || [''])[0];
    expect(fn).toMatch(/const \[p, placedApp\] = await Promise\.all\(\[/);
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

describe('the link endpoint and the inbound path', () => {
  it('GET /api/support/whatsapp-link returns the URL with no database work', () => {
    const h = (server.match(/if \(pathname === '\/api\/support\/whatsapp-link'[\s\S]*?\n  \}/) || [''])[0];
    expect(h).toBeTruthy();
    expect(h).toContain('requireSession(req, res)');
    expect(h).toContain("'https://wa.me/' + wlNumber");
    // It runs on every page load — it must not touch Supabase.
    expect(h).not.toContain('supabaseDbRequest');
  });

  it('an inbound WhatsApp message routes to the same officer as the button', () => {
    // Reading assigned_va here while the button used the placed/unplaced rule
    // would let the two disagree: the GP taps, gets routed to admin, then their
    // first message re-assigns the chat to somebody else.
    expect(server).toContain('const dtRouted = await resolveSupportRsoForUser(activeCase.user_id, activeCase)');
    expect(server).toContain('syncCaseChatAssignment({ gpPhone: fromPhone, assignedVaUserId: dtRouted.rsoUserId })');
    expect(server).not.toContain('syncCaseChatAssignment({ gpPhone: fromPhone, assignedVaUserId: activeCase.assigned_va })');
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
