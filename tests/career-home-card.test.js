import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const derive = require(path.join(__dirname, '..', 'js', 'career-home-card.js'));

const base = { id: 'app-1', role: { id: 'internal_ats:ats_9' }, appliedAt: '2026-07-01T00:00:00.000Z' };

describe('deriveCareerHomeCard', () => {
  it('returns null for missing app or closed applications', () => {
    expect(derive(null)).toBe(null);
    expect(derive({ ...base, status: 'withdrawn' })).toBe(null);
    expect(derive({ ...base, status: 'not_proceeding' })).toBe(null);
    expect(derive({ ...base, status: 'rejected' })).toBe(null);
  });

  it('applied/submitted/reviewing -> progress page, info tone', () => {
    const c = derive({ ...base, status: 'submitted' });
    expect(c.href).toBe('application-detail?id=app-1&role=internal_ats%3Aats_9');
    expect(c.badgeClass).toBe('info');
    expect(c.title).toBeTruthy();
  });

  it('uses server statusLabel for the default stage when present', () => {
    const c = derive({ ...base, status: 'reviewing', statusLabel: 'The practice is reviewing your profile' });
    expect(c.title).toBe('The practice is reviewing your profile');
  });

  it('interview stage -> application-detail (inline confirm-time), interview label', () => {
    const c = derive({ ...base, status: 'interview' });
    expect(c.href).toBe('application-detail?id=app-1&role=internal_ats%3Aats_9');
    expect(c.title).toContain('Interview');
    expect(c.badgeLabel).toBe('Interview');
  });

  it('offerPending -> offer-review page regardless of raw status', () => {
    const c = derive({ ...base, status: 'reviewing', offerPending: true });
    expect(c.href).toBe('offer-review?applicationId=app-1');
    expect(c.title).toContain('Offer');
    expect(c.badgeClass).toBe('success');
  });

  it('secured statuses -> My Practice (career#secured), success tone', () => {
    for (const s of ['hired', 'secured', 'placed', 'placement_secured', 'offer_accepted', 'contract_signed']) {
      const c = derive({ ...base, status: s });
      expect(c.href).toBe('career#secured');
      expect(c.badgeClass).toBe('success');
      expect(c.badgeLabel).toBe('Secured');
    }
  });

  it('statusTone=secured or the placement-by-association synthetic entry -> secured', () => {
    expect(derive({ ...base, status: 'x', statusTone: 'secured' }).href).toBe('career#secured');
    expect(derive({ id: 'placement-by-association', status: 'secured' }).href).toBe('career#secured');
  });
});
