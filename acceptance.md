# Acceptance Criteria — v1

v1 is **done** when every box below is checked. Don't claim done early; don't stop short. If a box is impossible, raise it with Nick before moving on.

---

## Data layer

- [ ] `schema.sql` runs cleanly on a fresh Supabase project, idempotent on re-run
- [ ] `venues` table seeded with 4 rows (hyperliquid, binance_futures, bybit, okx)
- [ ] `instruments` table seeded with at least BTC, ETH, SOL on all 4 venues (12 rows minimum)
- [ ] Realtime publication includes `funding_snapshots`, `opportunities`, `paper_positions`, `pnl_snapshots`
- [ ] RLS policies allow anon SELECT, deny anon writes

## Ingestion

- [ ] Hyperliquid Edge Function inserts a row to `funding_snapshots` for each tracked HL instrument every 60s
- [ ] Binance Edge Function does the same for tracked Binance instruments
- [ ] Bybit Edge Function does the same
- [ ] OKX Edge Function does the same, with **correct 4h-vs-8h cadence detection**
- [ ] All four functions normalize to `funding_rate_1h_apr` using the formulas in `api-notes.md`
- [ ] No raw venue payloads are dropped — each snapshot stores the full payload in `raw` jsonb
- [ ] Manual test: pause Binance ingestion; the rest keep running. No cross-function dependencies.

## Math & opportunity detection

- [ ] `lib/math.ts` has unit tests for `computeNetApr`, `computeBasisArbNetApr`, `applySlippage`
- [ ] `lib/normalize.ts` has unit tests for each venue's payload → `NormalizedFunding`
- [ ] Detector emits `single_venue_funding_harvest` opportunities when `net_apr ≥ 10%`
- [ ] Detector emits `cross_venue_basis_arb` opportunities when `net_apr ≥ 15%`
- [ ] Detector marks stale opportunities as `expired` when no longer meeting threshold (don't accumulate forever)
- [ ] Opportunity rows include all of: gross_apr, fee drag, slippage drag, net_apr, min_position_usd

## Paper-trade engine

- [ ] RPC `open_paper_position(opportunity_id, size_usd)` inserts a `paper_positions` row + opening `paper_fills`
- [ ] RPC `close_paper_position(position_id)` inserts closing `paper_fills`, sets status='closed', writes `realized_pnl_usd`
- [ ] `snapshot-pnl` cron runs every 5 minutes
- [ ] Each `snapshot-pnl` run inserts one `pnl_snapshots` row per open position
- [ ] Funding payments are applied to `cumulative_funding_usd` on each interval boundary (per-venue cadence)
- [ ] Positions whose liquidation distance drops below 5% are auto-closed with status `liquidated_paper`
- [ ] Positions whose distance is 5–20% are flagged `at_risk` but not closed
- [ ] Closing a position correctly aggregates: realized P&L = price P&L + funding − fees

## Dashboard

- [ ] Deploys to Netlify at a preview URL
- [ ] Dark theme matches the spec colors
- [ ] **Funding heatmap** renders one cell per (base_symbol × venue), color-coded by signed APR
- [ ] **APR leaderboard** is sortable, shows top funding APRs across all instruments
- [ ] **Opportunity table** shows open opportunities with Paper-trade button
- [ ] Clicking Paper-trade opens a modal asking for position size (default $1000), then calls the RPC
- [ ] **Paper positions panel** shows open positions with live unrealized P&L, cumulative funding, liquidation distance
- [ ] **P&L curve** plots portfolio cumulative P&L over the last 7 / 30 / all days
- [ ] **Execution log** shows the latest 50 paper_fills + funding settlements, newest first
- [ ] Every panel updates via Supabase Realtime — no client-side polling

## Code quality

- [ ] No `any` types in TS
- [ ] No real-money endpoints called anywhere
- [ ] No secrets committed
- [ ] `pnpm build` runs clean, no warnings
- [ ] README documents: setup, env vars, how to run locally, how to deploy

## End-to-end behavior

- [ ] Open a paper position from the UI, wait 1 funding interval, verify funding payment landed
- [ ] Open a position, manually edit a `funding_snapshots` row to spike the rate, verify P&L curve reflects the funding settlement
- [ ] Close the position, verify `realized_pnl_usd` is set and matches manual calculation
- [ ] Refresh the page — open positions persist (data is server-side, not local state)

## Done means

After 24h of continuous operation:
- [ ] `funding_snapshots` has ≥ 1000 rows (≈ 12 instruments × 60s polling × 24h)
- [ ] `opportunities` has at least 5 entries
- [ ] At least 1 paper position has been opened, accrued funding, and is visible on the P&L curve

If all that holds, ship it and start the 30-day collection window.
