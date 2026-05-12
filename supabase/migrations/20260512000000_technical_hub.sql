-- Technical Hub: system_bugs + client_errors tables

CREATE TABLE IF NOT EXISTS system_bugs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scan_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  category TEXT NOT NULL DEFAULT 'reliability'
    CHECK (category IN ('security', 'reliability')),
  file_path TEXT NOT NULL,
  line_number INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggestion TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'fixed', 'dismissed')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  scan_type TEXT NOT NULL DEFAULT 'daily'
    CHECK (scan_type IN ('daily', 'push', 'weekly_full')),
  commit_sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_bugs_status ON system_bugs (status, severity);
CREATE INDEX IF NOT EXISTS idx_system_bugs_scan ON system_bugs (scan_id);

CREATE TABLE IF NOT EXISTS client_errors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  page_url TEXT,
  user_email TEXT,
  user_agent TEXT,
  browser_info TEXT,
  user_context TEXT,
  error_hash TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'investigating', 'resolved', 'ignored')),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_client_errors_status ON client_errors (status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_hash ON client_errors (error_hash);
