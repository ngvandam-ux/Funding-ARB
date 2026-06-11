# Momentum Harvest — mean-reversion funding-spike detector (detect-only)

**Date:** 2026-06-11
**Status:** Approved (Nick, 2026-06-11)
**Scope:** Detect-only. No auto-open, no paper-engine changes.

## Hypothesis

Funding rates are mean-reverting. When an instrument's funding APR moves more
than 2 standard deviations beyond its 7-day rolling mean and stays there for
two consecutive settlements, entering a delta-neutral harvest at that point
captures a higher APR than Strategy A's flat threshold — provided the rate
does not revert before enough settlements amortize round-trip costs.

This phase only **measures**. It answers:

1. Do |z| > 2 funding spikes revert, and how fast (settlements to |z| < 1)?
2. What funding would a momentum entry have captured, net of honest costs,
   versus a Strategy A entry on the same instrument?

Promotion to auto-open is a separate, later decision gated on this data.

## Known tensions (recorded up front)

- Mean reversion cuts both ways: entering near the top of a spike means
  harvesting a decaying rate. The 2-settlement persistence filter delays entry
  deeper into the spike's life — on 8h venues that is 16h, so this is
  primarily a Hyperliquid (1h cadence) strategy in practice.
- The first paper cohort closed all-negative because round-trip costs exceeded
  funding collected. Spike-chasing shortens holds, so the edge must come from
  materially higher APR at entry. That is exactly what the logged data will
  confirm or refute.

## Design decisions (locked with Nick)

| Decision | Choice |
|---|---|
| Cohort scope | Detect-only; excluded from auto-open. 30-day honest cohort (restarted 2026-06-10) stays pure. |
| Persistence interval | Venue funding settlements: 2 consecutive settled rates beyond the band. |
| Tails | Both, symmetric. z > +2 → short perp; z < −2 → long perp. |
| APR floor | Strategy A's bar (net ≥ 10%) gates **entry** only. Momentum is a higher-conviction subset of A's universe. |
| Hold/expiry | Hysteresis: stays detected while latest settled \|z\| ≥ 1 (same sign); below → reconcile expires it. One spike = one opportunity row. |

## Architecture (Approach 1: SQL view + pure TS lib)

### Schema — `session-6-ops.sql` (idempotent)

- **View `funding_interval_rates`** — one row per instrument per funding
  interval: the last snapshot in each bucket, where bucket =
  `floor(epoch(ts) / (venues.funding_cadence_minutes * 60))`. Bounded to the
  trailing 8 days. ~1.3k rows across 13 instruments.
- **Table `funding_stats`** — append-only, one row per instrument per
  completed settlement, upsert on `(instrument_id, interval_ts)`:
  `instrument_id, interval_ts, computed_at, n_intervals, mean_apr,
  stddev_apr, current_apr, z_score`.
- **`opportunities.kind`** CHECK re-created to admit `'momentum_harvest'`.

### Pure lib — `src/lib/stats.ts` (Vitest; mirrored to `_shared/stats.ts`)

- **Baseline:** trailing 7d of settled interval rates **excluding the 2
  newest** (the persistence-test intervals). Sample stddev (n−1). With only
  21 samples on 8h venues, including the spike in its own baseline
  self-dampens the trigger.
- **Entry:** 2 newest settled intervals both |z| > 2, same sign, AND live
  `net_apr ≥ 10` using `computeLegDrag` (cost-model parity with Strategy A).
- **Hold:** dedup_key already open → stays detected while latest settled
  |z| ≥ 1 (same sign). Floor does not gate the hold.
- **Guards:** baseline n ≥ 14 else skip; `σ_eff = max(σ, MIN_SIGMA_APR = 0.5)`
  APR points so flat weeks cannot fire on noise.
- `dedupKey = momentum:{base}:{venue}`.

### Edge functions

- **`detect-opportunities`** — additionally reads `funding_interval_rates`
  and the `kind` of open opps; passes open momentum keys into the lib
  (hysteresis); merges momentum candidates into the detected set — existing
  reconcile (insert / update-in-place / expire) is unchanged; upserts new
  `funding_stats` rows.
- **`auto-open`** — query gains
  `.in('kind', ['single_venue_funding_harvest','cross_venue_basis_arb'])`.
  This is both the detect-only guarantee and a crash fix: its zod enum only
  admits the two legacy kinds, so an unfiltered momentum row would 500 the
  whole cron. The enum deliberately stays two-kind to fail loud if the gate
  is ever removed without a decision.

### Frontend (minimal)

`OpportunityKind` gains `'momentum_harvest'` in `src/types/domain.ts` (and
the hook's zod schema if present); OpportunityTable renders a "Momentum"
label. No other UI.

### Backtest one-off — `docs/momentum-backtest.sql`

Over existing snapshot history: every historical 2-consecutive-settlement
|z| > 2 crossing → rate path after, settlements to |z| < 1, hypothetical
funding captured minus round-trip costs. Run once in the SQL editor; paste
findings below.

## Deploy order (matters)

1. `session-6-ops.sql` (additive SQL).
2. `auto-open` (gate must precede new kind existing).
3. `detect-opportunities`.
4. Frontend push.

## Testing

- `stats.test.ts`: mean/σ math, z, both tails, persistence, hysteresis
  enter/hold/exit, n-guard, σ-floor, baseline-exclusion, deterministic output.
- Edge functions: `supabase functions serve` + curl smoke (repo convention).
- UI: eyeball on deploy preview.

## Out of scope

Auto-open for momentum, paper-engine/exit-rule changes, new venues,
dashboard stats charts.

## Backtest findings

_(to be filled after running `docs/momentum-backtest.sql`)_
