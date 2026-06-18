import { describe, it, expect, beforeAll } from 'vitest';

// Regression coverage for the rejected-document bug: when an RSO rejects a "You
// Prepare" document, user_documents.status becomes 'rejected' (+ rejection_reason).
// The prepared-documents serializer previously omitted `status`, so the GP's view
// never learned the doc was rejected and stayed on the cached "under review".
// mapPreparedDocumentRow must now surface the authoritative review status.

let mapPreparedDocumentRow;
let toStatusLabel;

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  const mod = await import('../server.js');
  mapPreparedDocumentRow = mod.__testUtils.mapPreparedDocumentRow;
  toStatusLabel = mod.__testUtils.toStatusLabel;
});

describe('toStatusLabel (review status normalization)', () => {
  it('maps approved/accepted to accepted', () => {
    expect(toStatusLabel('approved', true)).toBe('accepted');
    expect(toStatusLabel('accepted', true)).toBe('accepted');
  });
  it('preserves rejected', () => {
    expect(toStatusLabel('rejected', true)).toBe('rejected');
    expect(toStatusLabel('rejected', false)).toBe('rejected');
  });
  it('treats an uploaded-but-unreviewed doc as under_review', () => {
    expect(toStatusLabel('uploaded', true)).toBe('under_review');
    expect(toStatusLabel('pending', true)).toBe('under_review');
    expect(toStatusLabel('', true)).toBe('under_review');
  });
  it('treats a doc with no file as pending', () => {
    expect(toStatusLabel('pending', false)).toBe('pending');
    expect(toStatusLabel('', false)).toBe('pending');
  });
});

describe('mapPreparedDocumentRow surfaces status + rejection reason', () => {
  it('exposes a rejection so the GP view can show "Rejected, upload required"', () => {
    const mapped = mapPreparedDocumentRow(
      { status: 'rejected', rejection_reason: 'Image is too blurry to read.', file_url: 'uk/u1/mrcgp.pdf', file_name: 'MRCGP.pdf' },
      '/api/prepared-documents/download?country=uk&key=mrcgp_certified'
    );
    expect(mapped.status).toBe('rejected');
    expect(mapped.rejection_reason).toBe('Image is too blurry to read.');
    // The rejected file stays downloadable (crossed-out chip links to it).
    expect(mapped.downloadUrl).toContain('/api/prepared-documents/download');
    expect(mapped.fileName).toBe('MRCGP.pdf');
  });

  it('reports an approved doc as accepted', () => {
    const mapped = mapPreparedDocumentRow({ status: 'approved', file_url: 'uk/u1/x.pdf' }, '');
    expect(mapped.status).toBe('accepted');
    expect(mapped.rejection_reason).toBe('');
  });

  it('reports an uploaded-but-unreviewed doc as under_review', () => {
    const mapped = mapPreparedDocumentRow({ status: 'uploaded', storage_path: 'uk/u1/x.pdf' }, '');
    expect(mapped.status).toBe('under_review');
  });

  it('reports a doc with no file as pending', () => {
    const mapped = mapPreparedDocumentRow({ status: 'pending' }, '');
    expect(mapped.status).toBe('pending');
  });
});
