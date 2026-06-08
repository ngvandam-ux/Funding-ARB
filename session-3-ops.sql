-- Session 3 ops — RUN BY NICK in the Supabase SQL editor (classifier blocks the
-- agent from prod-DB writes). Idempotent. Deploy the 4 paper-engine functions
-- (open-paper-position, close-paper-position, snapshot-pnl, auto-open) FIRST,
-- then run this.
--
-- Project ref is hardcoded to the FRANKFURT/EU project (lfgmqpeaicqygzfgystu)
-- below — the permanent home after the Session-2 region migration (see Decision
-- 0004). The Vault `service_role_key` was set on Frankfurt during that migration.

-- 1. Migration: dedup key on paper_positions (auto-open "one open per opp" guard).
alter table public.paper_positions add column if not exists dedup_key text;
create index if not exists idx_paper_positions_open_dedup
  on public.paper_positions(dedup_key) where status in ('open', 'at_risk');
-- (RLS anon-read on paper_positions/paper_fills/pnl_snapshots already set in Session 1.)

-- 2. Prerequisites (no-ops if already enabled).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 3. Crons (5-min each, independent).
select cron.schedule(
  'auto-open-5min', '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://lfgmqpeaicqygzfgystu.supabase.co/functions/v1/auto-open',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);

select cron.schedule(
  'snapshot-pnl-5min', '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://lfgmqpeaicqygzfgystu.supabase.co/functions/v1/snapshot-pnl',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);

-- Verify:
--   select jobname, schedule from cron.job order by jobname;
--   select * from paper_positions order by opened_at desc;
--   select position_id, ts, unrealized_pnl_usd, cumulative_funding_usd, liquidation_distance_bps
--     from pnl_snapshots order by ts desc limit 20;
