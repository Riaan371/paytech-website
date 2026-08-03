-- ============================================================
-- CLIENT GROUPS — one login sees every company in its group
-- Run in Supabase -> SQL Editor
-- ============================================================

-- 1. Fix the permission error from the bulk login script
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO service_role;

-- 2. New table: client_groups
CREATE TABLE IF NOT EXISTS client_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE client_groups ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "auth_client_groups" ON client_groups FOR ALL USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_groups TO service_role;

-- 3. Link clients to a group (nullable - most clients stay ungrouped)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES client_groups(id) ON DELETE SET NULL;

-- 4. Let a profile be linked to a group instead of (or alongside) a single client
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES client_groups(id) ON DELETE SET NULL;

-- ============================================================
-- EXAMPLE: create a group and assign companies to it
--
-- INSERT INTO client_groups (name) VALUES ('Trempak Group') RETURNING id;
-- -- copy the returned id, then:
-- UPDATE clients SET group_id = '<group-id>'
--   WHERE id IN ('adff5c0b-3f9f-4070-870b-1656c86ea1c5',  -- Trempak Trading
--                'b060a4c3-621f-4169-923a-4c7666b3de7a',  -- Didget Printing
--                'c8fa60e5-f7ff-4cff-a299-b85bdb74b9df'); -- Trempak Machinery
--
-- -- link the login's profile to the group instead of a single client:
-- UPDATE profiles SET client_id = NULL, group_id = '<group-id>'
--   WHERE email = 'matthewb@trempak.co.za';
-- ============================================================
