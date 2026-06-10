-- Session 5 ops — measurement fixes (idempotent; run once against prod).
-- Pairs with the measurement-fixes branch: discrete funding settlement,
-- spot-leg costs, stale-mark guard, negative-funding exit rule.

-- 1) Exit-rule state: consecutive 5-min ticks with non-positive net funding
--    receipt. snapshot-pnl reads/writes this; auto-close at 6 (30 min).
alter table public.paper_positions
  add column if not exists negative_funding_streak int not null default 0;

-- 2) paper_fills was missing from the realtime publication, so the dashboard
--    execution log never live-updated (review finding M1).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'paper_fills'
  ) then
    alter publication supabase_realtime add table public.paper_fills;
  end if;
end $$;

-- 3) Purge residue of the 2026-06-09 coinalyze 100x incident: snapshots with
--    impossible APRs and the bogus expired opportunities they spawned. The
--    incident itself is documented in git history (PR #7/#8); keeping the rows
--    would poison any rate-history analysis of the 30-day run.
delete from public.funding_snapshots where abs(funding_rate_1h_apr) > 500;
delete from public.opportunities where abs(net_apr) > 200 and status = 'expired';
