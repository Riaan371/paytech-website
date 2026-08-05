-- Paytech: run-naming reference for WhatsApp Payslip batches, so past reports can be found
-- and printed again later by name (e.g. "August 2026 Payslips"), not just by date/client.
-- Run this in Supabase -> SQL Editor.

alter table public.payslip_sends
  add column if not exists batch_reference text;

create index if not exists payslip_sends_batch_reference_idx on public.payslip_sends (batch_reference);
