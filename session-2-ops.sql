-- Session 2 ops — RUN BY NICK in the Supabase SQL editor (the agent classifier
-- blocks direct prod-DB writes). Idempotent: safe to re-run.
--
-- Order: (1) migration, (2) prerequisites, (3) one 60s cron per function.
-- Deploy the functions FIRST (`supabase functions deploy <name>`), then run this.
--
-- Project ref is hardcoded to the SINGAPORE project (kpadovajkxnkbeuybzgi) below —
-- the project the app migrated to on 2026-05-31. (Old East-US ref efsaspkngkzgmppajnne
-- is decommissioned.) Store the new service-role key in Vault ONCE (do NOT paste the
-- literal key into a cron body):
--   select vault.create_secret('<service-role-key>', 'service_role_key');

-- =====================================================================
-- 1. Migration — opportunities dedup key + partial unique index
--    (the detector reconciles the live "open" set keyed by dedup_key)
-- =====================================================================
alter table public.opportunities add column if not exists dedup_key text;

create unique index if not exists opportunities_dedup_open
  on public.opportunities(dedup_key) where status = 'open';

-- =====================================================================
-- 2. Prerequisites (no-ops if already enabled from Session 1)
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- =====================================================================
-- 3. One independent 60s cron per function (pausing one venue must not
--    break others — CLAUDE.md hard rule / SPEC §8). pg_cron min granularity
--    is 1 minute, which satisfies the 60s cadence.
-- =====================================================================

-- ingest-binance  (⚠️ may fail if the Supabase egress region is Binance-restricted)
select cron.schedule(
  'ingest-binance-60s', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://kpadovajkxnkbeuybzgi.supabase.co/functions/v1/ingest-binance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);

-- ingest-bybit  (⚠️ may fail if the Supabase egress region is CloudFront-blocked)
select cron.schedule(
  'ingest-bybit-60s', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://kpadovajkxnkbeuybzgi.supabase.co/functions/v1/ingest-bybit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);

-- ingest-okx
select cron.schedule(
  'ingest-okx-60s', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://kpadovajkxnkbeuybzgi.supabase.co/functions/v1/ingest-okx',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);

-- detect-opportunities  (run AFTER the migration above has been applied)
select cron.schedule(
  'detect-opportunities-60s', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://kpadovajkxnkbeuybzgi.supabase.co/functions/v1/detect-opportunities',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);

-- =====================================================================
-- Verify / manage
-- =====================================================================
-- List jobs:        select jobid, jobname, schedule from cron.job order by jobname;
-- Recent runs:      select jobid, status, return_message, start_time
--                     from cron.job_run_details order by start_time desc limit 20;
-- Unschedule one:   select cron.unschedule('ingest-binance-60s');
-- Per-venue rows:   select i.venue_id, count(*) from funding_snapshots fs
--                     join instruments i on i.id = fs.instrument_id group by 1;
-- Live opps:        select kind, base_symbol, net_apr, status, dedup_key
--                     from opportunities order by detected_at desc;
