-- Phase 6 C2 (audit S2): server-side error capture.
-- Distinguish server-captured errors from client-reported ones in the shared
-- client_errors table. Default 'client' keeps every existing row and the
-- existing /api/errors/report insert path meaning what it always did;
-- recordServerError() writes source='server'.
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'client';

CREATE INDEX IF NOT EXISTS idx_client_errors_source ON client_errors (source, last_seen_at DESC);
