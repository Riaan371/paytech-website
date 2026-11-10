-- Paytech: Xero invoice sync. Run in Supabase -> SQL Editor.

-- One row (id = 1) holding the single Xero connection. Tokens live here, so this table is
-- reachable ONLY by the service role (edge functions) — RLS on, no policies, no client grants.
create table if not exists public.xero_connection (
  id                  int primary key default 1 check (id = 1),
  tenant_id           text,
  tenant_name         text,
  access_token        text,
  refresh_token       text,
  expires_at          timestamptz,
  oauth_state         text,
  oauth_state_expires timestamptz,
  default_account_code text,
  default_tax_type    text,
  connected_at        timestamptz,
  updated_at          timestamptz default now()
);
alter table public.xero_connection enable row level security;
revoke all on public.xero_connection from anon, authenticated;
grant all on public.xero_connection to service_role;

-- Remember what has already been pushed so an invoice can never be created twice in Xero.
alter table public.invoices add column if not exists xero_invoice_id text;
alter table public.invoices add column if not exists xero_synced_at timestamptz;
alter table public.invoices add column if not exists xero_error text;
alter table public.clients  add column if not exists xero_contact_id text;

-- The edge functions read these tables and write the Xero ids back.
grant select, update on public.invoices to service_role;
grant select, update on public.clients  to service_role;
