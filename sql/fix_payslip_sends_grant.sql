-- Paytech: fix "permission denied for table payslip_sends"
--
-- RLS policies control which ROWS a query can see, but Postgres checks base table-level
-- GRANTs first — without them, every query is blocked before RLS even runs. New tables in
-- this project apparently don't inherit default grants automatically (see the same issue
-- called out for client_groups in admin/add-client-groups.sql's "Fix the permission error
-- from the bulk login script" comment) — add_payslip_whatsapp.sql created payslip_sends
-- but never granted it to the `authenticated` role, so every logged-in user — admin,
-- consultant, or client — got blocked identically.
--
-- Run this in Supabase -> SQL Editor.

grant select, insert, update on public.payslip_sends to authenticated;

-- ============================================================
-- VERIFY: run this, then reload the "Payslip Sends" admin page — it should load with no error.
--   select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'payslip_sends';
-- ============================================================
