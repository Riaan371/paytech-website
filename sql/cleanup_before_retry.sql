-- Run this BEFORE re-running enable_rls.sql, to remove any partially-created policies

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_select_staff" on public.profiles;
drop policy if exists "profiles_admin_write" on public.profiles;

drop policy if exists "clients_select_own" on public.clients;
drop policy if exists "clients_staff_all" on public.clients;

drop policy if exists "invoices_select_own" on public.invoices;
drop policy if exists "invoices_staff_all" on public.invoices;

drop policy if exists "invoice_queries_client_rw" on public.invoice_queries;
drop policy if exists "invoice_queries_client_insert" on public.invoice_queries;
drop policy if exists "invoice_queries_staff_all" on public.invoice_queries;

drop policy if exists "job_cards_staff_all" on public.job_cards;

drop policy if exists "quotes_admin_all" on public.quotes;

drop policy if exists "consultant_clients_admin_all" on public.consultant_clients;
