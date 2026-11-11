-- Paytech: sync Xero every morning at 06:00 South African time (04:00 UTC).
--
-- BEFORE running this:
--   1. Supabase -> Database -> Extensions: switch ON  pg_cron  and  pg_net.
--   2. Supabase -> Edge Functions -> Secrets: add  XERO_CRON_SECRET  = a long random string
--      (e.g. 40+ random characters). Keep it out of chat/email.
--   3. Replace PASTE_THE_SAME_SECRET_HERE below with that same string, then run this file.
--      (It is stored inside the database job, which only database admins can see.)

select cron.schedule(
  'xero-daily-sync',
  '0 4 * * *',
  $$
  select net.http_post(
    url     := 'https://vqbchnbjzqfzfkdoqhhf.supabase.co/functions/v1/xero-cron',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE_THE_SAME_SECRET_HERE'),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it later:   select * from cron.job;
-- To stop it:          select cron.unschedule('xero-daily-sync');
