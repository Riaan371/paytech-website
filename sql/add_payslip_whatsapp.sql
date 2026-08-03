-- Paytech: WhatsApp Payslip feature — per-client enable flag + send history
-- Run this in Supabase → SQL Editor, after enable_rls.sql has already been applied.
-- If anything breaks, DROP POLICY / DROP TABLE the objects created below to revert.

-- 1. Per-client feature flag — toggled by admin in admin/index.html.
--    If false, the client portal shows a "contact Paytech" message instead of the feature.
alter table public.clients
  add column if not exists whatsapp_payslip_enabled boolean not null default false;

-- 2. Send history — one row per employee payslip sent, used for:
--    (a) nothing client-visible yet (could add a history view later),
--    (b) the admin's per-client monthly invoicing dashboard.
create table if not exists public.payslip_sends (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  employee_name   text,
  cell_number     text,
  payment_date    text,
  send_status     text not null,   -- 'accepted' | 'rejected' (Twilio API accept/reject at send time)
  delivery_status text,            -- 'delivered' | 'failed' | 'read' | 'sent' | 'queued' | null (filled in after a status check)
  error_code      integer,
  error_message   text,
  message_id      text,            -- Twilio message SID, used to look up delivery status
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists payslip_sends_client_id_idx on public.payslip_sends (client_id);
create index if not exists payslip_sends_created_at_idx on public.payslip_sends (created_at);

alter table public.payslip_sends enable row level security;

-- Client can see and record only their own company's sends. Covers BOTH login types used by
-- the portal (portal/index.html): a single-company login (profiles.client_id) and a "group"
-- login covering every company in profiles.group_id (see admin/add-client-groups.sql) — a
-- group login's client_id is NULL, so the two conditions never both match the same row, but
-- either one on its own is enough to authorize a company that login is allowed to act as.
create policy "payslip_sends_client_select" on public.payslip_sends
  for select using (
    client_id in (select client_id from public.profiles where id = auth.uid())
    or client_id in (
      select c.id from public.clients c
      join public.profiles p on p.group_id = c.group_id
      where p.id = auth.uid() and p.group_id is not null
    )
  );

create policy "payslip_sends_client_insert" on public.payslip_sends
  for insert with check (
    client_id in (select client_id from public.profiles where id = auth.uid())
    or client_id in (
      select c.id from public.clients c
      join public.profiles p on p.group_id = c.group_id
      where p.id = auth.uid() and p.group_id is not null
    )
  );

-- Needed so the app can fill in real delivery_status/error_code after the initial insert,
-- once Twilio has actually resolved the message (see paytech-payslip-whatsapp's status check).
create policy "payslip_sends_client_update_own" on public.payslip_sends
  for update using (
    client_id in (select client_id from public.profiles where id = auth.uid())
    or client_id in (
      select c.id from public.clients c
      join public.profiles p on p.group_id = c.group_id
      where p.id = auth.uid() and p.group_id is not null
    )
  ) with check (
    client_id in (select client_id from public.profiles where id = auth.uid())
    or client_id in (
      select c.id from public.clients c
      join public.profiles p on p.group_id = c.group_id
      where p.id = auth.uid() and p.group_id is not null
    )
  );

-- Admin/consultant see everything, for the cross-client invoicing dashboard.
create policy "payslip_sends_staff_all" on public.payslip_sends
  for all using ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'))
  with check ((auth.jwt() -> 'user_metadata' ->> 'role') in ('admin','consultant'));

-- ============================================================
-- HOW TO ENABLE THE WHATSAPP PAYSLIP FEATURE FOR A CLIENT:
--   UPDATE clients SET whatsapp_payslip_enabled = true WHERE id = '<client-id>';
-- (Also exposed as a toggle in admin/index.html once that's updated.)
-- ============================================================
