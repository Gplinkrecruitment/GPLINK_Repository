-- Gmail Label Organization System
-- Adds label tracking, VA account registry, and detected contacts

-- ── VA Gmail Accounts: maps admin users to their Gmail accounts ──
CREATE TABLE IF NOT EXISTS va_gmail_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  watch_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_va_gmail_email ON va_gmail_accounts(email_address);
CREATE INDEX IF NOT EXISTS idx_va_gmail_user ON va_gmail_accounts(user_id);

-- ── Practice Detected Contacts: discovered emails from practice domains ──
CREATE TABLE IF NOT EXISTS practice_detected_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES registration_cases(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  display_name TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  seen_count INTEGER DEFAULT 1,
  UNIQUE(case_id, email_address)
);

CREATE INDEX IF NOT EXISTS idx_practice_contacts_case ON practice_detected_contacts(case_id);

-- ── Add label tracking columns to registration_cases ──
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS gmail_label_id TEXT;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS gmail_label_hello_id TEXT;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS gmail_label_name TEXT;

-- ── RLS for new tables ──
ALTER TABLE va_gmail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_detected_contacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE va_gmail_accounts FROM anon, authenticated;
REVOKE ALL ON TABLE practice_detected_contacts FROM anon, authenticated;

CREATE POLICY va_gmail_service_all ON va_gmail_accounts
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY practice_contacts_service_all ON practice_detected_contacts
  FOR ALL USING (auth.role() = 'service_role');
