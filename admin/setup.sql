-- ============================================================
-- PAYTECH ADMIN — Full Database Setup
-- Run this in Supabase → SQL Editor
-- ============================================================

-- 1. CLIENTS
CREATE TABLE IF NOT EXISTS clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name   text NOT NULL,
  contact_person text,
  email          text,
  phone          text,
  vat_number     text,
  company_reg    text,
  address        text,
  service_type   text DEFAULT 'Payroll Consulting',
  monthly_fee    numeric(10,2) DEFAULT 0,
  employees      integer DEFAULT 0,
  invoice_day    integer DEFAULT 1,
  notes          text,
  created_at     timestamptz DEFAULT now()
);

-- 2. INVOICES
CREATE TABLE IF NOT EXISTS invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid REFERENCES clients(id) ON DELETE CASCADE,
  invoice_number text UNIQUE,
  invoice_date   date,
  due_date       date,
  period         text,
  status         text DEFAULT 'Draft',
  subtotal       numeric(10,2) DEFAULT 0,
  vat            numeric(10,2) DEFAULT 0,
  total          numeric(10,2) DEFAULT 0,
  line_items     jsonb DEFAULT '[]',
  notes          text,
  created_at     timestamptz DEFAULT now()
);

-- 3. QUOTES
CREATE TABLE IF NOT EXISTS quotes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid REFERENCES clients(id) ON DELETE CASCADE,
  quote_number text UNIQUE,
  quote_date   date,
  valid_until  date,
  service_type text,
  status       text DEFAULT 'Draft',
  subtotal     numeric(10,2) DEFAULT 0,
  vat          numeric(10,2) DEFAULT 0,
  total        numeric(10,2) DEFAULT 0,
  line_items   jsonb DEFAULT '[]',
  notes        text,
  created_at   timestamptz DEFAULT now()
);

-- 4. USER ROLES
CREATE TABLE IF NOT EXISTS user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  role       text NOT NULL CHECK (role IN ('admin','client','consultant')),
  client_id  uuid REFERENCES clients(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- 5. CONSULTANT → CLIENT MAPPING
CREATE TABLE IF NOT EXISTS consultant_clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultant_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE(consultant_id, client_id)
);

-- 6. INVOICE QUERIES (from client portal)
CREATE TABLE IF NOT EXISTS invoice_queries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid REFERENCES invoices(id) ON DELETE CASCADE,
  client_id   uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  subject     text NOT NULL,
  message     text NOT NULL,
  status      text DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Resolved')),
  admin_reply text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE clients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultant_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_queries   ENABLE ROW LEVEL SECURITY;

-- Policies (authenticated users only)
DO $$ BEGIN
  CREATE POLICY "auth_clients"           ON clients           FOR ALL USING (auth.role() = 'authenticated');
  CREATE POLICY "auth_invoices"          ON invoices          FOR ALL USING (auth.role() = 'authenticated');
  CREATE POLICY "auth_quotes"            ON quotes            FOR ALL USING (auth.role() = 'authenticated');
  CREATE POLICY "auth_user_roles"        ON user_roles        FOR ALL USING (auth.role() = 'authenticated');
  CREATE POLICY "auth_consultant_clients" ON consultant_clients FOR ALL USING (auth.role() = 'authenticated');
  CREATE POLICY "auth_invoice_queries"   ON invoice_queries   FOR ALL USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Set admin role for owner account
INSERT INTO user_roles (user_id, role)
SELECT id, 'admin' FROM auth.users WHERE email = 'mnrriaanvangraan@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- HOW TO ADD A CLIENT LOGIN:
-- 1. Create user in Supabase Auth (Authentication > Users > Add user)
-- 2. Run:
--    INSERT INTO user_roles (user_id, role, client_id)
--    VALUES ('<user-id-from-auth>', 'client', '<client-id-from-clients-table>');
--
-- HOW TO ADD A CONSULTANT:
-- 1. Create user in Supabase Auth
-- 2. INSERT INTO user_roles (user_id, role) VALUES ('<id>', 'consultant');
-- 3. INSERT INTO consultant_clients (consultant_id, client_id) VALUES ('<consultant-id>', '<client-id>');
-- ============================================================
