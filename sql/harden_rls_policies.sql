-- Paytech: close the RLS gap left by setup.sql's old blanket policies.
--
-- enable_rls.sql added restrictive per-table policies (clients_select_own, invoices_select_own,
-- etc.) but never dropped the older, much looser policies from admin/setup.sql — things like
-- "auth_clients ... USING (auth.role() = 'authenticated')", which let ANY logged-in user read
-- ALL rows in that table. Postgres combines permissive RLS policies with OR, so as long as
-- both existed, the older blanket policy silently overrode the newer restrictive one — meaning
-- clients could very likely read each other's invoices, queries, and company records.
--
-- The old policies can't just be dropped outright, though: none of enable_rls.sql's
-- replacement policies account for "group" logins (profiles.group_id / clients.group_id,
-- see admin/add-client-groups.sql) — a group login's profiles.client_id is NULL, so the
-- existing restrictive policies match nothing for it. Dropping the blanket policy without
-- first adding a group-aware one would break the working multi-company switcher feature.
-- So this migration adds the missing group-aware policies FIRST, then drops the old ones.
--
-- Run this in Supabase -> SQL Editor, after enable_rls.sql and admin/add-client-groups.sql
-- have already been applied. If anything breaks, the dropped policies' definitions are in
-- admin/setup.sql and can be re-created from there.

-- ============================================================
-- 1. ADD group-aware policies (mirrors payslip_sends' pattern in add_payslip_whatsapp.sql)
-- ============================================================

-- clients: group members can see every company in their group (previously relied entirely
-- on the loose auth_clients policy below — this replaces that reliance with a real policy).
create policy "clients_select_group" on public.clients
  for select using (
    group_id in (select group_id from public.profiles where id = auth.uid() and group_id is not null)
  );

-- invoices: group members can see invoices for any company in their group.
create policy "invoices_select_group" on public.invoices
  for select using (
    client_id in (
      select c.id from public.clients c
      join public.profiles p on p.group_id = c.group_id
      where p.id = auth.uid() and p.group_id is not null
    )
  );

-- invoice_queries: group members can read and log queries for any company in their group.
create policy "invoice_queries_select_group" on public.invoice_queries
  for select using (
    client_id in (
      select c.id from public.clients c
      join public.profiles p on p.group_id = c.group_id
      where p.id = auth.uid() and p.group_id is not null
    )
  );

create policy "invoice_queries_insert_group" on public.invoice_queries
  for insert with check (
    client_id in (
      select c.id from public.clients c
      join public.profiles p on p.group_id = c.group_id
      where p.id = auth.uid() and p.group_id is not null
    )
  );

-- NOTE: admin/setup.sql defines a "user_roles" table + an "auth_user_roles" policy, but
-- running this migration confirmed the table was never actually created on the live database
-- (CREATE TABLE IF NOT EXISTS user_roles in setup.sql apparently never ran) — so there's
-- nothing to harden here. Skipped entirely; nothing below references user_roles.

-- ============================================================
-- 2. DROP the old blanket policies now that real ones cover every legitimate access path.
-- ============================================================
drop policy if exists "auth_clients"            on public.clients;
drop policy if exists "auth_invoices"           on public.invoices;
drop policy if exists "auth_quotes"             on public.quotes;              -- quotes is admin-only in enable_rls.sql; not read anywhere client-facing
drop policy if exists "auth_invoice_queries"    on public.invoice_queries;
drop policy if exists "auth_consultant_clients" on public.consultant_clients;  -- admin-only in enable_rls.sql; only read from the admin-only Assign Clients page

-- ============================================================
-- VERIFY AFTER RUNNING:
--   select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public'
--   order by tablename, policyname;
-- You should no longer see any policy named "auth_*" in the list above.
-- ============================================================
