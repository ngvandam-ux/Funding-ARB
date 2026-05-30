# Session 2 — Multi-venue ingestion + opportunity detector (design)

**Date:** 2026-05-30 · **Status:** approved (design), pending spec review
**Scope:** Backend only. No UI (deferred to Session 4). Paper-only v1.

## Goal
Complete SPEC §8 Session 2: ingest Binance/Bybit/OKX funding into `funding_snapshots`,
and emit arb opportunities into `opportunities` via a detector that runs every 60s.

## Architecture
Four new Edge Functions (reuse the `ingest-hyperliquid` pattern) + one pure lib:
- `supabase/functions/ingest-binance/index.ts`
- `supabase/functions/ingest-bybit/index.ts`
- `supabase/functions/ingest-okx/index.ts`
- `supabase/functions/detect-opportunities/index.ts` (thin I/O wrapper)
- `src/lib/detect.ts` (+ `detect.test.ts`) — pure detection logic, the tested core

Each function gets its OWN pg_cron job (5 total). Honors hard rule: pausing one
venue must not break others. All cron/SQL run by Nick (classifier blocks prod DB
from the agent side); verification via read-only REST.

## Ingest functions (3)
Mirror `ingest-hyperliquid`: public GET → zod-parse → `normalizeX` (already written
+ tested in `supabase/functions/_shared/normalize.ts` and `src/lib/normalize.ts`) →
map `venue_symbol → instrument_id` → insert `funding_snapshots` with full `raw` jsonb
→ fail loud (log `{venue,endpoint,status}`, HTTP 500). <200 lines each, fetch only,
no SDKs, service_role from `Deno.env`, no `any`.

Per-venue (already handled in `_shared/normalize.ts`):
- **Binance** `GET https://fapi.binance.com/fapi/v1/premiumIndex` (all symbols, weight 40).
  OI is per-symbol (`/fapi/v1/openInterest?symbol=`) — fetch only our 3 tracked.
- **Bybit** `GET https://api.bybit.com/v5/market/tickers?category=linear`.
  `openInterestValue` already USD.
- **OKX** `GET https://www.okx.com/api/v5/public/funding-rate?instType=SWAP` + tickers.
  **4h-vs-8h cadence detection** is the landmine — `normalizeOkx` detects via
  fundingTime delta (×6 not ×3) and has a dedicated test.

`venue-api-researcher` agent verifies each LIVE shape vs `api-notes.md` before
`edge-fn-builder` writes the function. A shape change = stop-and-tell-Nick.

## `src/lib/detect.ts` — pure core (TDD, hard rule #6)
`detectOpportunities(snapshots: LatestSnapshot[], thresholds) → Opportunity[]`
- **Staleness filter:** drop any instrument whose latest snapshot is >5 min old.
  A cross-venue opp requires BOTH legs fresh.
- **Single-venue harvest:** per instrument, `computeNetApr` → emit if net_apr ≥ 10%.
- **Cross-venue basis arb:** group by `base_symbol`, pair venues, `computeBasisArbNetApr`
  (long negative-funding venue, short positive-funding venue — SPEC §5.2 corrected
  rule) → emit if net_apr ≥ 15%.
- Pure: no DB, no fetch. Returns plain objects.
- Uses existing `src/lib/math.ts` (`computeNetApr`, `computeBasisArbNetApr`,
  `applySlippage`, `VENUE_TAKER_BPS`, `SLIPPAGE_BPS_BY_TIER`).

Thresholds are the DETECT layer (10% / 15%). Paper-OPEN layer (15% / 20%) is
Session 3's engine concern, not the detector. (Two-layer model, see 0001/0002.)

## Detector Edge Function + opportunity lifecycle
Thin wrapper: read `latest_funding` view → `detectOpportunities(...)` →
**upsert one live row per (kind, base_symbol, legs)**. Each tick updates the
existing `open` row's APRs in place; any previously-open opp that no longer clears
threshold OR has a stale leg is marked `expired`.

Requires a small additive migration (Nick runs in SQL editor):
```sql
alter table public.opportunities add column if not exists dedup_key text;
create unique index if not exists opportunities_dedup_open
  on public.opportunities(dedup_key) where status = 'open';
```
`dedup_key` examples: `single:HYPE:hyperliquid`,
`cross:BTC:hyperliquid:binance_futures` (legs sorted for stability).
Keeps the table to the live set; Session 4 dashboard = `select * where status='open'`.

## Testing & verification
- **Unit (required):** `detect.test.ts` — above/below threshold, sign-pairing &
  direction, staleness drop, single + cross. Deterministic.
- **Live observation:** deploy all 4; confirm Binance/Bybit/OKX rows land in
  `funding_snapshots`; confirm detector RUNS and emits whatever genuinely clears
  the bar (HYPE ~-43% likely yields a single-venue opp; cross-venue may not appear
  naturally any given minute). NO fake data injected into prod.
- Read-only REST checks from the agent side; cron + migration SQL run by Nick.

## Out of scope (YAGNI)
- No `expires_at` timer beyond threshold/staleness expiry.
- No opportunity history/time-series table (upsert model = live set only).
- No UI — deferred to Session 4.

## Session 4 design intent (recorded now, locked in)
When the dashboard is built it MUST feel **intuitive, beautiful, and professional**.
Visual direction to be decided at Session 4 with real mockups via the frontend-design
plugin (candidate: refined dark terminal per SPEC §7 — bg #0a0a0f, magenta #e879f9 +
cyan #22d3ee, generous spacing, crisp type, subtle motion). Not built in Session 2.

## Acceptance (SPEC §8 / acceptance.md)
- [ ] Binance/Bybit/OKX functions each insert rows for their tracked instruments every 60s
- [ ] OKX correct 4h-vs-8h cadence detection
- [ ] All normalize to `funding_rate_1h_apr`; full raw payload stored
- [ ] Pausing one venue doesn't break others (independent cron)
- [ ] `detect.ts` unit-tested before use
- [ ] Detector emits single_venue ≥10% and cross_venue ≥15%; marks stale opps `expired`
- [ ] Opportunity rows include gross_apr, fee drag, slippage drag, net_apr, min_position_usd
