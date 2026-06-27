-- Paytech: Enable RLS + policies matching actual app access patterns
-- Run this in Supabase SQL Editor. If anything breaks, run rollback_rls.sql immediately.

-- profiles: each user sees/owns their own row; admin/consultant see all; only admin writes
alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());

create policy "profiles_select_staff" on public.profiles
  for select using ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'));

create policy "profiles_admin_write" on public.profiles
  for all using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');

-- clients: client sees only their own company row (via profiles.client_id); staff see/write all
alter table public.clients enable row level security;

create policy "clients_select_own" on public.clients
  for select using (
    id in (select client_id from public.profiles where id = auth.uid())
  );

create policy "clients_staff_all" on public.clients
  for all using ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'))
  with check ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'));

-- invoices: client sees only their own invoices; consultant/admin full access
alter table public.invoices enable row level security;

create policy "invoices_select_own" on public.invoices
  for select using (
    client_id in (select client_id from public.profiles where id = auth.uid())
  );

create policy "invoices_staff_all" on public.invoices
  for all using ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'))
  with check ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'));

-- invoice_queries: client can read/insert their own; consultant/admin full access
alter table public.invoice_queries enable row level security;

create policy "invoice_queries_client_rw" on public.invoice_queries
  for select using (
    client_id in (select client_id from public.profiles where id = auth.uid())
  );

create policy "invoice_queries_client_insert" on public.invoice_queries
  for insert with check (
    client_id in (select client_id from public.profiles where id = auth.uid())
  );

create policy "invoice_queries_staff_all" on public.invoice_queries
  for all using ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'))
  with check ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'));

-- job_cards: consultant/admin only (no client-facing use)
alter table public.job_cards enable row level security;

create policy "job_cards_staff_all" on public.job_cards
  for all using ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'))
  with check ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'));

-- quotes: admin only (no client/consultant use in code)
alter table public.quotes enable row level security;

create policy "quotes_admin_all" on public.quotes
  for all using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');

-- consultant_clients: admin only (assignment management)
alter table public.consultant_clients enable row level security;

create policy "consultant_clients_admin_all" on public.consultant_clients
  for all using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
