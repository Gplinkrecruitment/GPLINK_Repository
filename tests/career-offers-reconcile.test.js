// The career "Offers" tab had two defects the owner hit while testing:
//   1. GHOST OFFERS — applications live in the server's gp_applications table
//      and are merged into the browser's careerState. mergeRemoteApplications
//      only reconciled when the server returned >=1 application, so once an
//      application was cleared server-side (Reset GP / data cleanup / the
//      Zoho→in-app migration) the browser copy lingered forever as a phantom
//      "Under Review" card for a role the system no longer had any record of.
//   2. APPLY ≠ OFFER — the Offers tab badge counted EVERY application, so a
//      freshly-applied "Under Review" row lit the badge as though it were an
//      offer. Applying only puts you under review; only a genuine practice
//      offer (server flag offerPending) is an offer.
// These pages are static files served verbatim, so asserting on the source is
// an honest check of what the browser runs.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAREER_PATH = path.join(__dirname, '..', 'pages', 'career.html');
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

let careerHtml;
let serverJs;

beforeAll(() => {
  careerHtml = fs.readFileSync(CAREER_PATH, 'utf8');
  serverJs = fs.readFileSync(SERVER_PATH, 'utf8');
});

describe('career Offers — reconcile to server truth (no ghost offers)', () => {
  it('mergeRemoteApplications only proceeds on an authoritative server payload', () => {
    // Non-ok / non-array payloads (e.g. a network error) must bail so an
    // offline blip never wipes the list.
    expect(careerHtml).toContain(
      'if (!payload || !payload.ok || !Array.isArray(payload.applications)) return;'
    );
  });

  it('reconciles unconditionally — an empty server list clears local ghosts', () => {
    // The bug was this guard: it skipped reconciliation when the server had
    // zero applications, so a stale local one survived. It must be gone.
    const merge = careerHtml.slice(
      careerHtml.indexOf('function mergeRemoteApplications'),
      careerHtml.indexOf('async function loadRemoteApplications')
    );
    expect(merge).not.toContain('if (remote.length > 0)');
    // The local list becomes exactly the server's list (empty clears ghosts).
    expect(merge).toContain('careerState.applications = remote;');
    // And it must NOT re-add "local-only" apps the server doesn't know about —
    // that carryover is precisely what let a deleted application persist.
    expect(merge).not.toMatch(/\[\s*\.\.\.remote\s*,\s*\.\.\.localOnly\s*\]/);
    expect(merge).toContain('persistCareerState();');
  });
});

describe('career Offers — applying is Under Review, not an offer', () => {
  it('the Offers tab badge counts genuine offers only, not every application', () => {
    const shortcuts = careerHtml.slice(
      careerHtml.indexOf('function renderHeroShortcuts'),
      careerHtml.indexOf('function renderHeroShortcuts') + 1400
    );
    // Must filter on the server-decided offer flag…
    expect(shortcuts).toMatch(/offersTabBadge[\s\S]*?offerPending === true/);
    // …and must NOT count the raw application total for the offers badge.
    expect(shortcuts).not.toContain('offersTabBadgeEl.textContent = String(careerState.applications.length)');
    // Hidden when there are no offers.
    expect(shortcuts).toContain('offersTabBadgeEl.hidden = offerCount === 0;');
  });

  it('server only marks offerPending for a genuine waiting offer, never on apply', () => {
    // Guards the flag the badge/grouping trust: reviewing/interview/applied
    // stages are offerPending:false; only the real "offer waiting" case is true.
    expect(serverJs).toMatch(/statusLabel:\s*'Offer waiting for you[^']*',\s*statusTone:\s*'offer',\s*offerPending:\s*true/);
    expect(serverJs).toMatch(/statusLabel:\s*'The practice is reviewing your profile',\s*statusTone:\s*'review',\s*offerPending:\s*false/);
  });

  it('the panel still groups genuine offers separately from applications', () => {
    // The card copy stays honest: applied rows read "Under Review", and the
    // grouped "Offers" list is driven by the same offerPending flag.
    expect(careerHtml).toContain('offerPending === true');
    expect(careerHtml).toContain('UNDER REVIEW');
    expect(careerHtml).toContain("Your Registration Support Officer is reviewing your application before it reaches the practice.");
  });
});
