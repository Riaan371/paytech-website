-- Paytech: Xero is the source of truth for clients. Run AFTER add_xero_integration.sql and
-- add_xero_pull.sql, in Supabase -> SQL Editor.

alter table public.clients add column if not exists xero_account_number text;
alter table public.clients add column if not exists xero_synced_at timestamptz;

-- When set, the first (reviewed) client sync has been approved, so the morning job may run it.
alter table public.xero_connection add column if not exists clients_synced_at timestamptz;

-- One Paytech client per Xero contact.
create unique index if not exists clients_xero_contact_id_key
  on public.clients (xero_contact_id) where xero_contact_id is not null;

-- The sync function now creates clients too.
grant insert on public.clients to service_role;
