-- Practice client pipeline (2026-07-05).
-- Apply via rpc/exec_sql with the service key (param name: query). exec_sql returns void; verify via PostgREST reads.

-- practices: lifecycle + intake + agreement
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'active';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS website text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS dpa boolean;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS billing_style text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS nearest_city text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS suburb text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS agreement_status text NOT NULL DEFAULT 'unsigned';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS agreement_signed_at timestamptz;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS agreement_signed_by text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS agreement_signed_pdf_key text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS intro_text text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS intro_video_url text NOT NULL DEFAULT '';
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS intake_token text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.practices DROP CONSTRAINT IF EXISTS practices_stage_check;
ALTER TABLE public.practices ADD CONSTRAINT practices_stage_check CHECK (stage IN ('prospective','active','declined','archived'));
ALTER TABLE public.practices DROP CONSTRAINT IF EXISTS practices_agreement_status_check;
ALTER TABLE public.practices ADD CONSTRAINT practices_agreement_status_check CHECK (agreement_status IN ('unsigned','sent','signed'));
ALTER TABLE public.practices DROP CONSTRAINT IF EXISTS practices_source_check;
ALTER TABLE public.practices ADD CONSTRAINT practices_source_check CHECK (source IN ('zoho_sync','internal_ats','manual','backfill','facebook_lead'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_practices_intake_token ON public.practices(intake_token) WHERE intake_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_practices_stage ON public.practices(stage, name);

-- career_roles: masking + display + approval
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS masked_title text NOT NULL DEFAULT '';
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS header_image_url text NOT NULL DEFAULT '';
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS nearest_city text NOT NULL DEFAULT '';
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS suburb text NOT NULL DEFAULT '';
ALTER TABLE public.career_roles ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE public.career_roles DROP CONSTRAINT IF EXISTS career_roles_approval_status_check;
ALTER TABLE public.career_roles ADD CONSTRAINT career_roles_approval_status_check CHECK (approval_status IN ('pending','approved','rejected'));
CREATE INDEX IF NOT EXISTS idx_career_roles_approval ON public.career_roles(approval_status) WHERE approval_status <> 'approved';

-- gp_applications: reveal + origin
ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS revealed boolean NOT NULL DEFAULT false;
ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'gp_applied';
ALTER TABLE public.gp_applications DROP CONSTRAINT IF EXISTS gp_applications_origin_check;
ALTER TABLE public.gp_applications ADD CONSTRAINT gp_applications_origin_check CHECK (origin IN ('gp_applied','admin_applied'));

-- user_profiles: Australia-trained flag (onboarding mirror)
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS australia_trained boolean;
