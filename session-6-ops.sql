-- Session 6 ops — momentum_harvest detect-only (idempotent; run once against prod).
-- Pairs with the feature/momentum-detect branch: funding_interval_rates view,
-- funding_stats table, opportunities.kind admits 'momentum_harvest'.
-- Design doc: docs/superpowers/specs/2026-06-11-momentum-harvest-design.md
--
-- DEPLOY ORDER (matters): this SQL first, then the auto-open gate, then the
-- new detect-opportunities. auto-open's zod enum rejects momentum rows, so the
-- gate must be live before the detector can emit the new kind.

-- 1) One settled rate per instrument per venue funding interval.
--    Bucket = snapshot ts floored to the venue cadence (60m HL, 480m CEX);
--    the bucket's LAST snapshot approximates the rate that settled at the
--    boundary. Only COMPLETED intervals are exposed — the in-progress bucket
--    is still moving and must not enter the persistence test (design doc).
--    Bounded to 8 days: the lib applies the exact 7-day baseline window.
create or replace view public.funding_interval_rates as
with bucketed as (
  select
    fs.instrument_id,
    to_timestamp(
      floor(extract(epoch from fs.ts) / (v.funding_cadence_minutes * 60))
      * (v.funding_cadence_minutes * 60)
    ) as interval_ts,
    v.funding_cadence_minutes,
    fs.funding_rate_1h_apr,
    fs.ts
  from public.funding_snapshots fs
  join public.instruments i on i.id = fs.instrument_id
  join public.venues v on v.id = i.venue_id
  where i.is_active
    and fs.ts >= now() - interval '8 days'
)
select distinct on (instrument_id, interval_ts)
  instrument_id,
  interval_ts,
  funding_rate_1h_apr,
  ts as snapshot_ts
from bucketed
where interval_ts + make_interval(mins => funding_cadence_minutes) <= now()
order by instrument_id, interval_ts, ts desc;

-- 2) Rolling-baseline stats history: one row per instrument per completed
--    settlement, written by detect-opportunities (first write wins; the row
--    is deterministic moments after the interval completes).
create table if not exists public.funding_stats (
  id              bigserial primary key,
  instrument_id   bigint not null references public.instruments(id) on delete cascade,
  interval_ts     timestamptz not null,        -- the settled interval described
  computed_at     timestamptz not null default now(),
  n_intervals     integer not null,            -- baseline samples (excludes 2 newest)
  mean_apr        numeric(20,8) not null,
  stddev_apr      numeric(20,8) not null,      -- raw sample stddev; NOT σ_eff-floored
  current_apr     numeric(20,8) not null,      -- the settled interval's rate
  z_score         numeric(20,8) not null,      -- vs σ_eff = max(stddev, 0.5)
  unique (instrument_id, interval_ts)
);

create index if not exists idx_funding_stats_instrument_ts
  on public.funding_stats(instrument_id, interval_ts desc);

alter table public.funding_stats enable row level security;

drop policy if exists "anon_read_funding_stats" on public.funding_stats;
create policy "anon_read_funding_stats" on public.funding_stats
  for select to anon using (true);

-- 3) opportunities.kind admits the new detect-only kind.
alter table public.opportunities drop constraint if exists opportunities_kind_check;
alter table public.opportunities add constraint opportunities_kind_check
  check (kind in (
    'single_venue_funding_harvest',
    'cross_venue_basis_arb',
    'momentum_harvest'
  ));
