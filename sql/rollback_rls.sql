-- Paytech: INSTANT ROLLBACK — disables RLS enforcement again (does not drop policies)
-- Run this if enable_rls.sql breaks any portal/admin/consultant functionality.

alter table public.profiles disable row level security;
alter table public.clients disable row level security;
alter table public.invoices disable row level security;
alter table public.invoice_queries disable row level security;
alter table public.job_cards disable row level security;
alter table public.quotes disable row level security;
alter table public.consultant_clients disable row level security;
