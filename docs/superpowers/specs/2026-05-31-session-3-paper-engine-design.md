# Session 3 — Paper-trade engine (design)

**Date:** 2026-05-31 · **Status:** approved (design), pending spec review
**Scope:** Backend only. No UI (Session 4). Paper-only v1. SPEC §6 / §8 Session 3.

## Goal
Stand up the delta-neutral paper-trade engine so the 30-day unattended run can
begin collecting `pnl_snapshots`: open positions from opportunities, mark them to
market every 5 minutes (accruing funding), enforce paper risk controls, and close
them (manually later, or automatically on liquidation). The resulting P&L series
is the data that decides whether funding arb is +EV on a no-HFT stack.

## Architecture (matches Sessions 1–2)
Pure tested TS math → Deno mirror → thin edge functions, plus one Nick-run SQL file.

- `src/lib/pnl.ts` (+ `pnl.test.ts`) — the PURE, Vitest-tested core (no I/O, no clock).
- `supabase/functions/_shared/pnl.ts` — Deno mirror (diff-verified identical, like Session 2).
- `supabase/functions/open-paper-position/` — open one position (+ README).
- `supabase/functions/close-paper-position/` — close one position (+ README).
- `supabase/functions/snapshot-pnl/` — 5-min P&L cron (+ README).
- `supabase/functions/auto-open/` — 5-min auto-open cron (+ README).
- `session-3-ops.sql` (repo root) — additive migration + 2 crons (idempotent, Nick-run).

Four edge functions total (open/close are invokable primitives reused by the
Session 4 UI; snapshot-pnl and auto-open run on independent 5-min crons).

## Decisions (locked with Nick 2026-05-31)
1. **Open/close = thin edge fns over tested TS math** (not plpgsql RPC). Keeps the
   math under Vitest (hard rule #6) and lets the agent deploy end-to-end. Multi-row
   inserts are sequential (not one DB transaction); a partial-failure orphan row is
   an accepted paper-grade risk.
2. **Liquidation = isolated margin, `PAPER_LEVERAGE = 3` (configurable)**, with a
   small flat `MAINTENANCE_MARGIN_FRACTION = 0.005`. Risk states keyed on buffer
   *remaining as a fraction of the initial buffer*.
3. **Funding = continuous pro-rata** accrual each tick (integrates the time-varying
   normalized APR; robust to cron hiccups), not discrete boundary settlement.
4. **Auto-open is in scope** so the 30-day run starts now. Fixed per-leg notional
   `PAPER_POSITION_USD = 1000`; one open position per opportunity `dedup_key`.
5. **Sizing:** `position_size_usd` = per-leg notional ($1000). Cross-venue puts on
   two $1000 legs (net-flat); single-venue is one $1000 perp leg + an implicit,
   unmodeled $1000 spot hedge.

## Math definitions (`src/lib/pnl.ts` — pin these exactly)
All inputs are already-normalized; reuse `VENUE_TAKER_BPS`, `SLIPPAGE_BPS_BY_TIER`
from `math.ts`. Constants: `PAPER_LEVERAGE=3`, `MAINTENANCE_MARGIN_FRACTION=0.005`,
`PAPER_POSITION_USD=1000`.

**Fills (open and close).** Per leg, at fill `price = current mark`:
- `fee_usd = notional × VENUE_TAKER_BPS[venue]/10_000`
- `slippage_bps = SLIPPAGE_BPS_BY_TIER[tier]`; `slippage_usd = notional × slippage_bps/10_000`
- Both `fee_usd` and `slippage_usd` are economic costs that reduce P&L.

**Liquidation price (isolated margin).** Initial adverse-move buffer fraction
`d0 = 1/PAPER_LEVERAGE − MAINTENANCE_MARGIN_FRACTION` (≈0.328 at 3×). Per leg:
- short leg liquidates UP: `liq_price = entry × (1 + d0)`
- long  leg liquidates DOWN: `liq_price = entry × (1 − d0)`

**Unrealized price P&L (delta-neutral).**
- Cross-venue: sum each modeled leg's mark-to-market
  (`long: (mark−entry)/entry × notional`; `short: (entry−mark)/entry × notional`).
  Legs share an underlying, so this nets ≈0 and captures only basis drift.
- Single-venue: price P&L = 0 (the perp is perfectly hedged by the implicit spot leg).
  Liquidation is still tracked on the perp leg.

**Funding accrual (per tick, per leg).** With signed normalized APR `r` (the leg's
current `funding_rate_1h_apr`) and `dtYears = dt_ms / (365×24×3600×1000)`:
- `received_apr = (side === 'short') ? +r : −r` (positive funding pays shorts)
- `Δfunding_usd = notional × received_apr/100 × dtYears`; sum over legs into
  `cumulative_funding_usd`. By construction every opened opp accrues positive funding.

**Liquidation distance + risk state.** For the adverse (losing) leg, remaining
buffer fraction `rem = d0 − a` where `a` = adverse fractional move so far
(`short: max(0,(mark−entry)/entry)`, `long: max(0,(entry−mark)/entry)`).
`liquidation_distance_bps = min over legs of (rem × 10_000)`. Then:
- `rem/d0 < 0.05` on any leg → `liquidated_paper` (auto-close this tick)
- else `rem/d0 < 0.20` → `at_risk`
- else → `open`

**Realized P&L on close.**
`realized_pnl_usd = net_price_pnl + cumulative_funding_usd − Σ fee_usd − Σ slippage_usd`
across all open+close fills on all legs. `cumulative_fees_usd` (position column) =
Σ taker `fee_usd` (open+close); slippage is captured via `paper_fills.slippage_bps`
and folded into `realized_pnl_usd`.

## Edge functions

### `open-paper-position` (invokable; also called by auto-open)
Input: `{ opportunityId, sizeUsd? }` (defaults `PAPER_POSITION_USD`). Reads the
opportunity + latest marks per leg from `latest_funding`/`funding_snapshots`,
`computeOpenFills`, then via the service-role client: insert `paper_positions`
(status `open`, entry prices, `dedup_key` copied from the opportunity, initial
`cumulative_fees_usd` = open fees) + one `paper_fills` row per leg (action `open`),
and set the opportunity `status='paper_traded'`. Returns the position. Fail loud.

### `snapshot-pnl` (cron `*/5 * * * *`)
For each `open`/`at_risk` position: pull latest marks per leg; `accrueFunding`
(dt from the previous `pnl_snapshots.ts` for this position, else `opened_at`);
`computeUnrealizedPnl`; `liquidationDistanceBps`; insert one `pnl_snapshots` row;
update the position's `cumulative_funding_usd` + `status`. If `liquidated_paper`,
write close fills + `realized_pnl_usd` + `closed_at` (forced close). A single bad
position is logged and skipped; a failed top-level read fails the run (500).

### `auto-open` (cron `*/5 * * * *`)
For each `opportunities` row with `status='open'` clearing the PAPER-OPEN bar
(single ≥15% net, cross ≥20% net) and no existing `paper_positions` in
`('open','at_risk')` with that `dedup_key`: invoke the open logic at
`PAPER_POSITION_USD`. Logs per-opp; one failure doesn't stop the rest.

### `close-paper-position` (invokable; manual close lands in Session 4 UI)
Input: `{ positionId }`. Reads the position + latest marks, `computeCloseRealizedPnl`,
inserts close `paper_fills`, sets `status='closed'`, `closed_at`, `realized_pnl_usd`,
final `cumulative_fees_usd`. Built now (small, shares the math); UI wires it later.

## Data model touches (`session-3-ops.sql`, idempotent, Nick-run)
- `alter table public.paper_positions add column if not exists dedup_key text;`
- `create index if not exists idx_paper_positions_open_dedup on public.paper_positions(dedup_key) where status in ('open','at_risk');`
  (guards the "one open position per opportunity" auto-open check; not unique —
  expired/closed positions may repeat a key over time.)
- RLS anon-read on the paper/pnl tables is ALREADY in place (Session 1) — no change.
- Two crons: `snapshot-pnl-5min`, `auto-open-5min` (pg_net + Vault key, same recipe
  as Session 2's `session-2-ops.sql`).

## Testing & verification
- **Unit (required, TDD):** `pnl.test.ts` — open fills (fee+slippage+liq price for
  long & short), unrealized P&L (cross-venue both legs; single-venue =0), funding
  accrual (sign by side, pro-rata over dt), liquidation distance + the 0.20/0.05
  state thresholds (incl. auto-close), realized P&L on close. Deterministic (`dt`,
  marks, `now` all injected).
- **Mirror:** diff-verify `_shared/pnl.ts` against `src/lib/pnl.ts` (Session 2 method).
- **Live:** Nick deploys 3 fns + runs `session-3-ops.sql`; verify a `paper_positions`
  row auto-opens for a clearing opp, `pnl_snapshots` rows accrue every 5 min, and a
  forced liquidation path works (can be checked by temporarily lowering the bar /
  inspecting an `at_risk` row). Agent verifies read-only via REST.

## Out of scope (YAGNI)
- Portfolio-level (`position_id IS NULL`) P&L rollup snapshots.
- Maker-fill probability, cross-chain bridge cost, dynamic position sizing.
- More than one concurrent open position per opportunity.
- Real orders / CLOB endpoints (v1 is paper-only, hard rule #1).

## Acceptance (SPEC §6 / acceptance.md)
- [ ] `open-paper-position` inserts a position + per-leg open fills with fee+slippage; opportunity → `paper_traded`.
- [ ] `auto-open` opens exactly one position per clearing opportunity (paper-open bar), deduped by `dedup_key`, size $1000/leg.
- [ ] `snapshot-pnl` writes a `pnl_snapshots` row every 5 min per open position with unrealized P&L, accrued funding, and `liquidation_distance_bps`.
- [ ] Funding accrues continuously pro-rata with the correct sign per leg.
- [ ] Risk states: `at_risk` < 20% buffer, `liquidated_paper` < 5% (auto-closed).
- [ ] `close-paper-position` settles funding + fees + slippage into `realized_pnl_usd`.
- [ ] `pnl.ts` unit-tested before use; `_shared/pnl.ts` mirror diff-verified.
