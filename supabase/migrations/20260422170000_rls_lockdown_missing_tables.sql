-- Fix Supabase security alert: enable RLS on server-only tables
-- that were missing it. With RLS enabled and no policies,
-- only service_role (used by server.js) can access these tables.
-- 2026-04-22

-- 1. gmail_watch_state (server-only Gmail watch tracking)
ALTER TABLE gmail_watch_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE gmail_watch_state FROM anon, authenticated;

-- 2. processed_gmail_messages (server-only processing log)
ALTER TABLE processed_gmail_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE processed_gmail_messages FROM anon, authenticated;

-- 3. zoho_sign_envelopes (server-only Zoho Sign lifecycle)
ALTER TABLE zoho_sign_envelopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE zoho_sign_envelopes FROM anon, authenticated;

-- 4. processed_zoho_sign_events (server-only webhook idempotency)
ALTER TABLE processed_zoho_sign_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE processed_zoho_sign_events FROM anon, authenticated;

-- 5. incoming_email_todos (server-only AI triage items)
ALTER TABLE incoming_email_todos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE incoming_email_todos FROM anon, authenticated;
