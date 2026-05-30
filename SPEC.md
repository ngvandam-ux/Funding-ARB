# Funding-Rate Arbitrage Scanner & Paper-Trade Engine — v1 Spec

**Status:** Greenfield. Paper-trade only. No real-money code paths in v1.
**Owner:** Nick Vandam
**Target completion:** v1 in ~4 Claude Code sessions
**Last updated:** May 22, 2026

---

## 1. What we're building

A live dashboard + paper-trade engine that:

1. **Ingests funding rates** from Hyperliquid, Binance Futures, Bybit, and OKX every minute.
2. **Normalizes** them to a common schema (per-hour rate, annualized APR, next funding timestamp).
3. **Identifies opportunities** — both single-venue (high APR funding to harvest delta-neutral) and cross-venue (basis arb: long the cheap perp, short the expensive perp).
4. **Simulates paper trades** with realistic fee + slippage + funding settlement math.
5. **Tracks P&L** of paper positions over time, with a live dashboard that looks like the reference Instagram screenshot but with content that actually matters.

The point is to generate **30 days of real, logged data** that tells us empirically whether funding-rate arb is +EV for someone running this stack (no colo, no HFT, no Rust). If yes, we graduate to real money in a v2. If no, we know without losing a dollar.

---

## 2. Why funding-rate arb is the right target

Verified from current sources (see `api-notes.md`):

- **Hyperliquid** funds **every hour**, not every 8 hours. Higher cadence = faster compounding and faster paper-trade signal. No KYC, US-accessible via wallet.
- **Phemex's funding-rate arb bot reported 419% estimated APR in Q1 2026** during the peak retail bullishness window. Sustained realistic yield: 8–20% APY on BTC/ETH, higher on alts.
- **Edge does not require speed.** Funding settles on a schedule. We compete on capital discipline and breadth of venue coverage, not microseconds.
- **All required data is on free public endpoints** — no auth needed for funding rates, mark prices, or open interest.

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Ingestion Workers (Supabase Edge Functions, cron every 60s)    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────┐ │
│  │ Hyperliquid  │ │ Binance      │ │ Bybit        │ │ OKX     │ │
│  │ /info POST   │ │ /fapi/v1     │ │ /v5/market   │ │ /api/v5 │ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └────┬────┘ │
│         └────────────────┴────────────────┴───────────────┘     │
│                              │                                   │
│              Normalize → { venue, symbol, funding_rate_8h,       │
│                            funding_rate_1h, next_funding_ts,     │
│                            mark_price, index_price, oi, ts }     │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                   ┌───────────▼────────────┐
                   │  Supabase (Postgres)   │
                   │  - venues              │
                   │  - instruments         │
                   │  - funding_snapshots   │
                   │  - opportunities       │
                   │  - paper_positions     │
                   │  - paper_fills         │
                   │  - pnl_snapshots       │
                   └───────────┬────────────┘
                               │
       ┌───────────────────────┼─────────────────────────┐
       │                       │                          │
┌──────▼──────┐    ┌───────────▼─────────┐   ┌────────────▼──────┐
│ Opportunity │    │ Paper-Trade Engine  │   │ P&L Engine        │
│ Detector    │    │ (Edge Function,     │   │ (cron, every 5m)  │
│ (Edge Fn,   │    │  triggered by user) │   │                   │
│  every 60s) │    │                     │   │ - mark-to-market  │
│             │    │ - opens simulated   │   │ - applies funding │
│ - APR rank  │    │   positions         │   │   payments        │
│ - basis arb │    │ - applies fees      │   │ - records         │
│ - filters   │    │   + slippage        │   │   snapshots       │
│   noise     │    │ - logs fills        │   │                   │
└─────────────┘    └─────────────────────┘   └───────────────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │  React + Vite + Tailwind UI    │
              │  (Netlify, Supabase Realtime)  │
              │  ─ Funding heatmap             │
              │  ─ APR leaderboard             │
              │  ─ Opportunity table           │
              │  ─ Paper positions panel       │
              │  ─ P&L curve                   │
              │  ─ Execution log               │
              │  ─ Risk panel                  │
              └────────────────────────────────┘
```

### Why this architecture

- **Polling, not WebSockets** — funding rates change every funding interval (1h on Hyperliquid, 8h on Binance/Bybit/OKX). Polling every 60 seconds is plenty. No persistent connections to babysit.
- **Supabase Edge Functions + cron** — no VPS, no Docker. Everything runs inside Nick's existing Supabase project. Free tier covers v1.
- **Supabase Realtime → React** — UI updates without polling. Tables enabled for Realtime publish their changes over websocket to the browser.
- **Netlify hosts the React SPA** — fits the existing toolchain.

---

## 4. Data model

See `schema.sql` for the full DDL. Conceptual model:

| Table | Purpose |
|---|---|
| `venues` | Static reference: hyperliquid, binance_futures, bybit, okx. Holds base fees, withdrawal fees, funding cadence. |
| `instruments` | Per-venue perpetual contracts (e.g. `hyperliquid:BTC`, `binance_futures:BTCUSDT`). Linked to a normalized `base_symbol` (BTC, ETH, SOL, …) so the same underlying across venues can be joined. |
| `funding_snapshots` | Time-series of funding rates. One row per (instrument, ts). Includes `funding_rate_1h_apr` (normalized) so all venues are comparable. |
| `opportunities` | Detected arb opportunities. `kind` ∈ {`single_venue_funding_harvest`, `cross_venue_basis_arb`}. Includes expected APR, capital requirement, fees, net edge. |
| `paper_positions` | Open + closed simulated positions. Long/short legs, entry/exit timestamps, current mark, cumulative funding received/paid. |
| `paper_fills` | Individual simulated fills against `paper_positions`. Models taker vs. maker, slippage. |
| `pnl_snapshots` | Periodic mark-to-market snapshot of each open position + portfolio total. Drives the P&L curve. |

Every table that the UI reacts to is published to Supabase Realtime: `funding_snapshots`, `opportunities`, `paper_positions`, `pnl_snapshots`.

---

## 5. The arb math (the part that must be correct)

### 5.1 Strategy A — Single-venue funding harvest (delta-neutral)

The classic "cash and carry" play, crypto edition. Hold spot, short the perp.

**Setup**
- Buy 1 BTC spot @ $100,000 → cost $100,000
- Short 1 BTC perp @ $100,000 → margin required ~$10,000 at 10x

**P&L drivers**
- Funding payment received every interval (assuming positive funding, longs paying shorts)
- Spot price moves are perfectly hedged by the short
- Round-trip fees (open + close on both legs)
- Borrow cost on the perp margin (zero on Hyperliquid; rolled into funding elsewhere)

**Annualized yield formula (the one Claude Code must implement)**

```
funding_apr_net = (funding_rate_per_interval × intervals_per_year)
                - (round_trip_fees / position_notional × cycles_per_year)
                - (slippage_per_cycle / position_notional × cycles_per_year)
```

For Hyperliquid (hourly funding, position held flat indefinitely):
```
intervals_per_year = 24 × 365 = 8760
cycles_per_year ≈ 1 (you only open + close once if you hold for a year)
```

**Opportunity threshold for v1** (two layers — see also §8)
- **Detect/emit:** `funding_apr_net ≥ 10%` → emit a `single_venue_funding_harvest` opportunity into the `opportunities` table. This is what the detector and dashboard use.
- **Paper-open (30-day run):** only auto-open a paper position when `funding_apr_net ≥ 15%` (the higher conviction bar in §8). Below the detect bar, don't emit — but the raw rate still lands in `funding_snapshots` for analysis.

### 5.2 Strategy B — Cross-venue basis arbitrage

When the same underlying funds at very different rates on two venues, you can long the cheap perp and short the expensive one. Zero net exposure to BTC price; you collect the funding differential.

**Setup**
- Long 1 BTC perp on Hyperliquid (funding 0.005%/h = ~44% APR if positive — you're paying)
- Short 1 BTC perp on Binance (funding 0.02%/8h = ~22% APR if positive — you're receiving)

**Wait. That's the wrong direction.** Re-derive carefully:

If Binance funding is **positive**, longs pay shorts. If you **short** on Binance, you **receive** funding.
If Hyperliquid funding is **negative**, shorts pay longs. If you **long** on Hyperliquid, you **receive** funding.

So the rule is: **long the venue with negative funding, short the venue with positive funding.** You collect both sides.

**Net APR formula**
```
gross_apr = abs(funding_apr_venue_a) + abs(funding_apr_venue_b)
            IF signs are opposite (one positive, one negative)
          = abs(funding_apr_venue_a - funding_apr_venue_b)
            IF signs are same (both positive or both negative)

net_apr = gross_apr
        - (round_trip_fees_a + round_trip_fees_b) / position_notional × cycles_per_year
        - (slippage_a + slippage_b) / position_notional × cycles_per_year
        - bridge_cost_per_year (if rebalancing across chains)
```

**Opportunity threshold for v1** (two layers — see also §8)
- **Detect/emit:** `net_apr ≥ 15%` → emit a `cross_venue_basis_arb` opportunity (higher bar than Strategy A because basis arb has more moving parts).
- **Paper-open (30-day run):** only auto-open when `net_apr ≥ 20%` (the §8 conviction bar).

### 5.3 What MUST be modeled correctly

1. **Fees per venue** — from `venues` table, applied per-leg, taker fees by default in v1 (the paper engine assumes we take liquidity). Future: model maker fills with a fill probability.
2. **Slippage** — v1 uses a flat 5 bps assumption per leg on majors, 25 bps on alts. v2 will pull from orderbook depth.
3. **Funding cadence mismatch** — Hyperliquid pays every hour; Binance every 8h. Snapshots must be normalized to APR before comparison. NEVER compare raw rates across venues.
4. **Liquidation distance** — track this in `paper_positions`. If a paper short gets within 20% of liquidation, log a `risk_event` and force-close in the engine (simulating a real risk control).

### 5.4 What is explicitly OUT of scope for v1

- Real money orders. The CLOB/trade endpoints are not called.
- Maker-fill probability modeling.
- Cross-chain bridge cost modeling beyond a flat $5 + 6 minute assumption.
- Smart routing across spot venues.
- Tax accounting.

---

## 6. The paper-trade engine

### 6.1 User-triggered opening

User clicks "Paper-trade this opportunity" on the dashboard. The engine:

1. Reads the opportunity row.
2. Inserts a `paper_position` (status = `open`, opened_at = now).
3. Inserts `paper_fills` for each leg, applying the venue's taker fee + flat slippage.
4. Records initial margin used + liquidation prices for each leg.
5. Returns the position to the UI.

### 6.2 Continuous P&L update (cron, every 5 minutes)

For each `open` paper position:

1. Pull latest mark prices for each leg from `funding_snapshots` (or a separate `mark_snapshots` if we add one — for v1 we piggyback on funding_snapshots since most venues return mark in the same payload).
2. Compute unrealized P&L per leg.
3. **If a funding interval has elapsed since the last update for that venue**, apply the funding payment to the position's `cumulative_funding`.
4. Insert a `pnl_snapshot` row.
5. Check liquidation distance. If any leg < 20% buffer, mark the position `at_risk`. If < 5%, auto-close it and mark `liquidated_paper`.

### 6.3 Closing a position

User clicks "Close". Engine:

1. Inserts closing `paper_fills` at current mark + slippage + taker fee.
2. Settles cumulative funding.
3. Updates position to `closed`, computes final realized P&L.

---

## 7. The dashboard (panel-by-panel)

The reference Instagram screenshot is the **vibe**, not the content. We're keeping the dark theme, the dense info, the "live" feel — but every panel earns its pixels.

### Layout (12-col grid, dark theme: bg #0a0a0f, text #e5e7eb, accent magenta #e879f9 + cyan #22d3ee)

```
┌──────────────────────────────────────────────────────────────────┐
│  HEADER: Portfolio P&L · open positions count · last update ts   │
├────────────────────────────┬─────────────────────────────────────┤
│  FUNDING HEATMAP           │  APR LEADERBOARD                    │
│  Grid: rows = symbols      │  Sortable table:                    │
│  cols = venues             │  symbol | venue | apr | next_fund   │
│  cell color = APR signed   │  Click row → opportunity detail     │
│  cell size = open interest │                                     │
│  (replaces the green/red   │                                     │
│   bubble field from ref)   │                                     │
├────────────────────────────┼─────────────────────────────────────┤
│  OPPORTUNITY TABLE         │  PAPER POSITIONS                    │
│  Filtered to net_apr ≥     │  Open positions w/ live P&L,        │
│  threshold. Strategy A     │  liquidation distance, cumulative    │
│  + B mixed, sortable.      │  funding. Close button per row.     │
│  "Paper-trade" button.     │                                     │
├────────────────────────────┴─────────────────────────────────────┤
│  P&L CURVE (full width)                                          │
│  Cumulative paper P&L over time. Lines: realized, unrealized,    │
│  funding-only, fees-only. (replaces the green curve from ref)    │
├──────────────────────────────────────────────────────────────────┤
│  EXECUTION LOG (full width, scrolling, monospace)                │
│  All paper fills + funding settlements + risk events, newest top │
└──────────────────────────────────────────────────────────────────┘
```

### Component-level notes

- **Funding heatmap**: use a simple CSS grid + d3-scale-chromatic diverging palette. Hover shows raw APR, next funding ts.
- **P&L curve**: `recharts` (the only charting lib — see CLAUDE.md Stack). Avoid heavy charting libs.
- **Execution log**: virtualized list (`react-window`) — it'll grow fast.
- **Realtime**: each panel subscribes to its own Supabase Realtime channel. No global event bus.

---

## 8. Build order (this is the order Claude Code should work in)

### Session 1 — Foundation
1. `npm create vite@latest` with React+TS template
2. Install: tailwind, supabase-js, recharts, date-fns, zod
3. Apply `schema.sql` in Supabase SQL editor
4. Enable Realtime on the four reactive tables
5. Write the Hyperliquid ingestion Edge Function (it's the cleanest API, start here)
6. Verify rows landing in `funding_snapshots` every 60s

### Session 2 — Multi-venue ingestion + opportunity detector
1. Binance, Bybit, OKX ingestion Edge Functions
2. Normalization layer (`lib/normalize.ts` — pure functions, unit-tested)
3. Opportunity detector Edge Function (runs every 60s, reads latest snapshots, writes to `opportunities`)
4. Verify single-venue + cross-venue opportunities are being emitted

### Session 3 — Paper-trade engine
1. RPC functions in Supabase for `open_paper_position`, `close_paper_position`
2. P&L snapshot cron (every 5 min)
3. Funding-settlement logic + liquidation check
4. Unit tests for the math (pure TS, in `lib/math.test.ts`)

### Session 4 — Dashboard
1. Header + grid scaffolding + dark theme
2. Funding heatmap + APR leaderboard
3. Opportunity table with "Paper-trade" CTA
4. Paper positions panel + P&L curve + execution log
5. Deploy to Netlify

After session 4 ships, **run it for 30 days**. The detector emits opportunities at the lower **detect** thresholds (§5: A ≥ 10%, B ≥ 15%) so the dashboard and `opportunities` table stay populated — but auto-open paper positions only at the higher **paper-open** thresholds: every Strategy A opportunity ≥ 15% APR and every Strategy B opportunity ≥ 20% APR. (Detect = what you see; open = what you commit paper capital to.) The resulting `pnl_snapshots` table is the data that decides whether to build v2 (real money).

---

## 9. Stretch goals (post-v1, do not build now)

- Maker-fill simulation with orderbook-depth-informed fill probability
- Real orderbook depth ingestion (for proper slippage modeling)
- Telegram/Discord alert webhook when opportunities exceed thresholds
- Backtester against historical funding data (Tardis.dev has it, paid)
- Real-money mode behind a feature flag + multiple confirmation gates
- Stablecoin peg arb module

---

## 10. Acceptance criteria — see `acceptance.md`
