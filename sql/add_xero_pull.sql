-- Paytech: invoices flow Xero -> Paytech. Run AFTER add_xero_integration.sql, in Supabase SQL Editor.

alter table public.xero_connection add column if not exists invoices_synced_at timestamptz;

-- Optional per client: the exact contact name in Xero, when it differs from the company name here.
alter table public.clients add column if not exists xero_contact_name text;

-- One Paytech invoice per Xero invoice.
create unique index if not exists invoices_xero_invoice_id_key
  on public.invoices (xero_invoice_id) where xero_invoice_id is not null;

-- The sync function now creates invoices too.
grant insert on public.invoices to service_role;
