-- CEO rebuild: durable per-GP RSO owner, blocker-start timestamp, editable RSO roster

-- Durable per-GP RSO owner (oversight grouping); backfilled from assigned_va
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS assigned_rso uuid;
UPDATE registration_cases SET assigned_rso = assigned_va WHERE assigned_rso IS NULL;
CREATE INDEX IF NOT EXISTS idx_cases_assigned_rso ON registration_cases(assigned_rso);

-- When a blocker was set, so "days blocked" is real (not days-since-activity)
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS blocker_set_at timestamptz;

-- Editable RSO roster (replaces hardcoded RSO_TEAM array; array remains as seed)
CREATE TABLE IF NOT EXISTS rso_team (
  user_id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  phone text DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- seed from current RSO_TEAM
INSERT INTO rso_team (user_id, name, email, phone) VALUES
  ('2f94f870-7ab2-4f71-98ad-bf3756ed88db','Khaleed Mahmoud','khaleedmahmoud1211@gmail.com','+61406281243'),
  ('7bed5eb8-f03d-40d6-b090-eb006cd02be7','Hazel','hazel@mygplink.com.au','')
ON CONFLICT (user_id) DO NOTHING;
