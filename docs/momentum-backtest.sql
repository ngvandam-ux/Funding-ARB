-- momentum-backtest.sql — one-off hypothesis check (design doc 2026-06-11).
-- Run in the Supabase SQL editor; paste findings into the design doc.
--
-- Replays the momentum_harvest entry rule over ALL snapshot history:
--   entry  = 2 consecutive settled intervals with |z| > 2 vs the trailing-7d
--            baseline (baseline EXCLUDES those 2 intervals; σ floored at 0.5),
--            baseline n ≥ 14.
--   revert = first later interval back inside mean ± 1σ (baseline FROZEN at
--            entry — a simplification; the live detector re-baselines).
--   One event per elevated cluster (first triggering interval only — a
--   simplification of the live hysteresis, which re-arms only after |z| < 1).
--
-- Outputs:
--   A) per-event list: when, instrument, side, entry rate, z, settlements to
--      revert, hours held, funding captured per $1,000 notional.
--   B) summary: event count, median hold, median capture, and % of events
--      whose capture clears a $5/round-trip cost hurdle (old cohort's honest
--      round-trip costs landed at $2.27–$4.62 per $1,000 position).

with intervals as (
  select distinct on (fs.instrument_id, bucket.interval_ts)
    fs.instrument_id,
    i.base_symbol,
    i.venue_id,
    bucket.interval_ts,
    v.funding_cadence_minutes,
    fs.funding_rate_1h_apr as apr
  from public.funding_snapshots fs
  join public.instruments i on i.id = fs.instrument_id
  join public.venues v on v.id = i.venue_id
  cross join lateral (
    select to_timestamp(
      floor(extract(epoch from fs.ts) / (v.funding_cadence_minutes * 60))
      * (v.funding_cadence_minutes * 60)
    ) as interval_ts
  ) bucket
  where bucket.interval_ts + make_interval(mins => v.funding_cadence_minutes) <= now()
  order by fs.instrument_id, bucket.interval_ts, fs.ts desc
),
seq as (
  select
    x.*,
    lag(apr) over w as prev_apr,
    lag(interval_ts) over w as prev_interval_ts
  from intervals x
  window w as (partition by instrument_id order by interval_ts)
),
scored as (
  select
    s.*,
    b.mu,
    greatest(b.sigma, 0.5) as sigma_eff,
    b.n,
    (s.apr - b.mu) / greatest(b.sigma, 0.5) as z,
    (s.prev_apr - b.mu) / greatest(b.sigma, 0.5) as z_prev
  from seq s
  cross join lateral (
    select avg(apr) as mu, stddev_samp(apr) as sigma, count(*) as n
    from intervals b
    where b.instrument_id = s.instrument_id
      and b.interval_ts >= s.interval_ts - interval '7 days'
      and b.interval_ts < s.prev_interval_ts        -- excludes the 2 persistence intervals
  ) b
  where s.prev_interval_ts is not null and b.n >= 2 and b.sigma is not null
),
signals as (
  select
    *,
    (n >= 14 and ((z > 2 and z_prev > 2) or (z < -2 and z_prev < -2))) as is_entry
  from scored
),
entries as (
  -- first triggering interval of each elevated cluster
  select *
  from (
    select *, lag(is_entry) over (partition by instrument_id order by interval_ts) as prev_entry
    from signals
  ) t
  where is_entry and (prev_entry is distinct from true)
),
events as (
  select
    e.instrument_id,
    e.base_symbol,
    e.venue_id,
    e.interval_ts as entry_ts,
    case when e.z > 0 then 'short' else 'long' end as side,
    round(e.apr::numeric, 2) as entry_apr,
    round(e.mu::numeric, 2) as baseline_mean,
    round(e.sigma_eff::numeric, 2) as sigma_eff,
    round(e.z::numeric, 2) as entry_z,
    r.revert_ts,
    hold.n_settlements,
    round(hold.hours_held::numeric, 1) as hours_held,
    -- funding captured per $1,000: each settled interval pays
    -- apr%/100 / 8760 × cadence_hours × 1000, signed toward the harvest side.
    round(hold.captured_usd_per_1k::numeric, 2) as captured_usd_per_1k
  from entries e
  cross join lateral (
    select min(f.interval_ts) as revert_ts
    from intervals f
    where f.instrument_id = e.instrument_id
      and f.interval_ts > e.interval_ts
      and abs(f.apr - e.mu) <= e.sigma_eff       -- back inside mean ± 1σ (frozen)
  ) r
  cross join lateral (
    select
      count(*) as n_settlements,
      coalesce(sum(f.funding_cadence_minutes) / 60.0, 0) as hours_held,
      coalesce(sum(
        sign(e.z) * f.apr / 100.0 / 8760.0 * (f.funding_cadence_minutes / 60.0) * 1000.0
      ), 0) as captured_usd_per_1k
    from intervals f
    where f.instrument_id = e.instrument_id
      and f.interval_ts > e.interval_ts
      and (r.revert_ts is null or f.interval_ts <= r.revert_ts)
  ) hold
)
-- A) per-event detail (comment this out and re-run for B)
select * from events order by entry_ts;

-- B) summary — uncomment to run after reviewing A.
-- with ev as (<paste the CTE chain above>)
-- select
--   count(*)                                                   as events,
--   count(*) filter (where revert_ts is not null)              as reverted,
--   percentile_cont(0.5) within group (order by n_settlements) as median_settlements,
--   percentile_cont(0.5) within group (order by hours_held)    as median_hours,
--   percentile_cont(0.5) within group (order by captured_usd_per_1k) as median_captured_usd_per_1k,
--   avg(captured_usd_per_1k)                                   as avg_captured_usd_per_1k,
--   100.0 * count(*) filter (where captured_usd_per_1k > 5) / nullif(count(*), 0)
--                                                              as pct_clearing_5usd_costs
-- from events;
