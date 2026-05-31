# Paper-Trade Engine (Session 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the delta-neutral paper-trade engine (open / 5-min mark-to-market with funding accrual / risk controls / close + auto-open) so the 30-day +EV data run can start.

**Architecture:** Pure tested TS math in `src/lib/pnl.ts` → diff-verified Deno mirror `_shared/pnl.ts` → thin Deno edge functions, with shared DB orchestration in `_shared/paper.ts`. Four edge functions: `open-paper-position`, `close-paper-position` (invokable), `snapshot-pnl`, `auto-open` (independent 5-min crons). One Nick-run `session-3-ops.sql` (additive migration + 2 crons).

**Tech Stack:** TypeScript, Vitest, zod, Supabase Edge Functions (Deno), pnpm. Reuses `src/lib/math.ts` (`VENUE_TAKER_BPS`, `SLIPPAGE_BPS_BY_TIER`).

**Spec:** `docs/superpowers/specs/2026-05-31-session-3-paper-engine-design.md`

---

## File Structure

- `src/lib/pnl.ts` (create) — pure paper-engine math + constants. No I/O, no clock.
- `src/lib/pnl.test.ts` (create) — Vitest tests for `pnl.ts`.
- `supabase/functions/_shared/pnl.ts` (create) — Deno mirror of `src/lib/pnl.ts`.
- `supabase/functions/_shared/paper.ts` (create) — shared Deno DB helpers (`loadLatestMarks`, `openPaperPosition`, `closePaperPosition`).
- `supabase/functions/open-paper-position/{index.ts,README.md}` (create).
- `supabase/functions/close-paper-position/{index.ts,README.md}` (create).
- `supabase/functions/snapshot-pnl/{index.ts,README.md}` (create).
- `supabase/functions/auto-open/{index.ts,README.md}` (create).
- `session-3-ops.sql` (create) — migration + 2 crons (Nick-run).

**Conventions (match Sessions 1–2):** edge fns are a single `Deno.serve`, `<200` lines, fetch/DB only, `getEnv` inlined, fail-loud structured JSON + HTTP 500, no `any` (zod parses), service-role client. `pnpm-workspace.yaml` already has the esbuild build-approval (do not touch). Run all pnpm commands from `~/funding-arb`.

---

## Task 1: `pnl.ts` constants + `computeOpenFills`

**Files:**
- Create: `src/lib/pnl.ts`
- Test: `src/lib/pnl.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/pnl.test.ts
import { describe, it, expect } from 'vitest'
import {
  computeOpenFills,
  INITIAL_BUFFER_FRACTION,
  PAPER_LEVERAGE,
  MAINTENANCE_MARGIN_FRACTION,
} from './pnl'

describe('constants', () => {
  it('derives the initial liquidation buffer from leverage and maintenance', () => {
    // d0 = 1/3 − 0.005 ≈ 0.32833…
    expect(PAPER_LEVERAGE).toBe(3)
    expect(MAINTENANCE_MARGIN_FRACTION).toBe(0.005)
    expect(INITIAL_BUFFER_FRACTION).toBeCloseTo(1 / 3 - 0.005, 9)
  })
})

describe('computeOpenFills', () => {
  it('builds a cross-venue pair: entry=mark, taker fee + slippage per leg, liq prices', () => {
    const r = computeOpenFills({
      legA: { venueId: 'hyperliquid', tier: 'major', side: 'long', mark: 100 },
      legB: { venueId: 'binance_futures', tier: 'major', side: 'short', mark: 100 },
      sizeUsd: 1000,
    })
    // fees: HL 4.5bps*1000=0.45 ; Binance 4.0bps*1000=0.40 ; total 0.85
    expect(r.legA.feeUsd).toBeCloseTo(0.45, 9)
    expect(r.legB!.feeUsd).toBeCloseTo(0.4, 9)
    expect(r.feesUsd).toBeCloseTo(0.85, 9)
    // slippage major 5bps*1000=0.50 each ; total 1.00
    expect(r.legA.slippageBps).toBe(5)
    expect(r.legA.slippageUsd).toBeCloseTo(0.5, 9)
    expect(r.slippageUsd).toBeCloseTo(1.0, 9)
    // entry = mark
    expect(r.legA.entryPrice).toBe(100)
    // liq: long liquidates DOWN, short liquidates UP, by d0
    expect(r.legA.liqPrice).toBeCloseTo(100 * (1 - INITIAL_BUFFER_FRACTION), 6)
    expect(r.legB!.liqPrice).toBeCloseTo(100 * (1 + INITIAL_BUFFER_FRACTION), 6)
  })

  it('single-venue: legB is null and totals come from one leg', () => {
    const r = computeOpenFills({
      legA: { venueId: 'hyperliquid', tier: 'mid', side: 'short', mark: 50 },
      legB: null,
      sizeUsd: 1000,
    })
    expect(r.legB).toBeNull()
    expect(r.feesUsd).toBeCloseTo(0.45, 9)
    expect(r.slippageUsd).toBeCloseTo(1.5, 9) // mid 15bps
  })

  it('throws on a non-positive size or mark', () => {
    expect(() =>
      computeOpenFills({ legA: { venueId: 'okx', tier: 'major', side: 'long', mark: 100 }, legB: null, sizeUsd: 0 }),
    ).toThrow()
    expect(() =>
      computeOpenFills({ legA: { venueId: 'okx', tier: 'major', side: 'long', mark: 0 }, legB: null, sizeUsd: 1000 }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: FAIL — `Failed to load url ./pnl` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/pnl.ts
// Pure paper-trade P&L math (SPEC §6 + Session 3 design). No I/O, no clock —
// marks / dt / now are all injected so this is deterministic and unit-tested.
// Reuses the fee + slippage tables from math.ts.

import type { VenueId, Tier } from '../types/domain'
import { VENUE_TAKER_BPS, SLIPPAGE_BPS_BY_TIER } from './math'

export const PAPER_LEVERAGE = 3
export const MAINTENANCE_MARGIN_FRACTION = 0.005
export const PAPER_POSITION_USD = 1000
export const AT_RISK_BUFFER_FRACTION = 0.2
export const LIQUIDATION_BUFFER_FRACTION = 0.05

// Adverse-move fraction a leg can absorb before liquidation (isolated margin).
export const INITIAL_BUFFER_FRACTION =
  1 / PAPER_LEVERAGE - MAINTENANCE_MARGIN_FRACTION

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000
const BPS = 10_000

export type Side = 'long' | 'short'

function assertPositiveFinite(v: number, label: string): void {
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`${label} must be a positive finite number, got ${v}`)
  }
}

function legFeeUsd(sizeUsd: number, venueId: VenueId): number {
  const bps = VENUE_TAKER_BPS[venueId]
  if (bps === undefined) throw new Error(`unknown venueId: ${String(venueId)}`)
  return sizeUsd * (bps / BPS)
}

function legSlippage(sizeUsd: number, tier: Tier): { bps: number; usd: number } {
  const bps = SLIPPAGE_BPS_BY_TIER[tier]
  if (bps === undefined) throw new Error(`unknown tier: ${String(tier)}`)
  return { bps, usd: sizeUsd * (bps / BPS) }
}

function liqPriceFor(side: Side, entryPrice: number): number {
  return side === 'short'
    ? entryPrice * (1 + INITIAL_BUFFER_FRACTION)
    : entryPrice * (1 - INITIAL_BUFFER_FRACTION)
}

export interface OpenLegInput {
  venueId: VenueId
  tier: Tier
  side: Side
  mark: number
}
export interface OpenFill {
  side: Side
  entryPrice: number
  liqPrice: number
  feeUsd: number
  slippageBps: number
  slippageUsd: number
}
export interface OpenResult {
  legA: OpenFill
  legB: OpenFill | null
  feesUsd: number
  slippageUsd: number
}

export function computeOpenFills(args: {
  legA: OpenLegInput
  legB: OpenLegInput | null
  sizeUsd: number
}): OpenResult {
  const { legA, legB, sizeUsd } = args
  assertPositiveFinite(sizeUsd, 'sizeUsd')
  const build = (leg: OpenLegInput): OpenFill => {
    assertPositiveFinite(leg.mark, 'mark')
    const feeUsd = legFeeUsd(sizeUsd, leg.venueId)
    const slip = legSlippage(sizeUsd, leg.tier)
    return {
      side: leg.side,
      entryPrice: leg.mark,
      liqPrice: liqPriceFor(leg.side, leg.mark),
      feeUsd,
      slippageBps: slip.bps,
      slippageUsd: slip.usd,
    }
  }
  const a = build(legA)
  const b = legB ? build(legB) : null
  return {
    legA: a,
    legB: b,
    feesUsd: a.feeUsd + (b ? b.feeUsd : 0),
    slippageUsd: a.slippageUsd + (b ? b.slippageUsd : 0),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: PASS (all `computeOpenFills` + constants tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pnl.ts src/lib/pnl.test.ts
git commit -m "feat(pnl): computeOpenFills + paper-engine constants (TDD)"
```

---

## Task 2: `computeUnrealizedPnl`

**Files:**
- Modify: `src/lib/pnl.ts`
- Test: `src/lib/pnl.test.ts`

- [ ] **Step 1: Write the failing test** (append to `pnl.test.ts`)

```typescript
import { computeUnrealizedPnl } from './pnl'

describe('computeUnrealizedPnl', () => {
  it('single-venue (legB null) is perfectly hedged by spot → 0', () => {
    const pnl = computeUnrealizedPnl({
      legA: { side: 'short', entryPrice: 100 },
      legB: null,
      markA: 130,
      markB: null,
      sizeUsd: 1000,
    })
    expect(pnl).toBe(0)
  })

  it('cross-venue long+short on a +10% move nets ≈ 0 (delta-neutral)', () => {
    // long gains +10% * 1000 = +100 ; short loses -10% * 1000 = -100
    const pnl = computeUnrealizedPnl({
      legA: { side: 'long', entryPrice: 100 },
      legB: { side: 'short', entryPrice: 100 },
      markA: 110,
      markB: 110,
      sizeUsd: 1000,
    })
    expect(pnl).toBeCloseTo(0, 9)
  })

  it('cross-venue captures basis drift when the two marks diverge', () => {
    // long leg +10% = +100 ; short leg only +5% adverse = -50 ; net +50
    const pnl = computeUnrealizedPnl({
      legA: { side: 'long', entryPrice: 100 },
      legB: { side: 'short', entryPrice: 100 },
      markA: 110,
      markB: 105,
      sizeUsd: 1000,
    })
    expect(pnl).toBeCloseTo(50, 9)
  })

  it('throws when a cross-venue position is missing markB', () => {
    expect(() =>
      computeUnrealizedPnl({
        legA: { side: 'long', entryPrice: 100 },
        legB: { side: 'short', entryPrice: 100 },
        markA: 110,
        markB: null,
        sizeUsd: 1000,
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: FAIL — `computeUnrealizedPnl is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `pnl.ts`)

```typescript
function legPricePnl(side: Side, entryPrice: number, mark: number, sizeUsd: number): number {
  const move = (mark - entryPrice) / entryPrice
  return side === 'long' ? move * sizeUsd : -move * sizeUsd
}

export interface PositionLeg {
  side: Side
  entryPrice: number
}

export function computeUnrealizedPnl(args: {
  legA: PositionLeg
  legB: PositionLeg | null
  markA: number
  markB: number | null
  sizeUsd: number
}): number {
  const { legA, legB, markA, markB, sizeUsd } = args
  // Single-venue funding harvest is delta-neutral via the implicit spot leg.
  if (!legB) return 0
  if (markB === null) throw new Error('cross-venue position requires markB')
  return (
    legPricePnl(legA.side, legA.entryPrice, markA, sizeUsd) +
    legPricePnl(legB.side, legB.entryPrice, markB, sizeUsd)
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pnl.ts src/lib/pnl.test.ts
git commit -m "feat(pnl): computeUnrealizedPnl (delta-neutral, single=0)"
```

---

## Task 3: `accrueFunding`

**Files:**
- Modify: `src/lib/pnl.ts`
- Test: `src/lib/pnl.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```typescript
import { accrueFunding } from './pnl'

describe('accrueFunding', () => {
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000

  it('short leg receives positive funding (longs pay shorts)', () => {
    // +36.5% APR, short, $1000, over exactly 1 day → 36.5/100/365 * 1000 = $1.00
    const f = accrueFunding({
      legA: { side: 'short', fundingRate1hApr: 36.5 },
      legB: null,
      sizeUsd: 1000,
      dtMs: YEAR_MS / 365,
    })
    expect(f).toBeCloseTo(1.0, 9)
  })

  it('long leg on positive funding pays (negative accrual)', () => {
    const f = accrueFunding({
      legA: { side: 'long', fundingRate1hApr: 36.5 },
      legB: null,
      sizeUsd: 1000,
      dtMs: YEAR_MS / 365,
    })
    expect(f).toBeCloseTo(-1.0, 9)
  })

  it('cross-venue: both legs receive funding (long neg-funding, short pos-funding)', () => {
    // legA long on −20% APR → receives +20% ; legB short on +40% APR → receives +40%
    // over 1 year, $1000 → +200 + 400 = +600
    const f = accrueFunding({
      legA: { side: 'long', fundingRate1hApr: -20 },
      legB: { side: 'short', fundingRate1hApr: 40 },
      sizeUsd: 1000,
      dtMs: YEAR_MS,
    })
    expect(f).toBeCloseTo(600, 6)
  })

  it('scales linearly with dt', () => {
    const oneHour = accrueFunding({ legA: { side: 'short', fundingRate1hApr: 10 }, legB: null, sizeUsd: 1000, dtMs: 3_600_000 })
    const twoHour = accrueFunding({ legA: { side: 'short', fundingRate1hApr: 10 }, legB: null, sizeUsd: 1000, dtMs: 7_200_000 })
    expect(twoHour).toBeCloseTo(oneHour * 2, 9)
  })

  it('throws on negative dt', () => {
    expect(() => accrueFunding({ legA: { side: 'short', fundingRate1hApr: 10 }, legB: null, sizeUsd: 1000, dtMs: -1 })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: FAIL — `accrueFunding is not a function`.

- [ ] **Step 3: Write minimal implementation** (append)

```typescript
export function accrueFunding(args: {
  legA: { side: Side; fundingRate1hApr: number }
  legB: { side: Side; fundingRate1hApr: number } | null
  sizeUsd: number
  dtMs: number
}): number {
  const { legA, legB, sizeUsd, dtMs } = args
  if (!Number.isFinite(dtMs) || dtMs < 0) {
    throw new Error(`dtMs must be a finite number >= 0, got ${dtMs}`)
  }
  const dtYears = dtMs / MS_PER_YEAR
  // Positive funding pays shorts: a short RECEIVES +r, a long pays (−r).
  const legFunding = (leg: { side: Side; fundingRate1hApr: number }): number => {
    const receivedApr = leg.side === 'short' ? leg.fundingRate1hApr : -leg.fundingRate1hApr
    return sizeUsd * (receivedApr / 100) * dtYears
  }
  return legFunding(legA) + (legB ? legFunding(legB) : 0)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pnl.ts src/lib/pnl.test.ts
git commit -m "feat(pnl): accrueFunding (continuous pro-rata, sign by side)"
```

---

## Task 4: `assessRisk` (liquidation distance + state)

**Files:**
- Modify: `src/lib/pnl.ts`
- Test: `src/lib/pnl.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```typescript
import { assessRisk, INITIAL_BUFFER_FRACTION as D0 } from './pnl'

describe('assessRisk', () => {
  it('fresh position (mark == entry) is open with full buffer', () => {
    const r = assessRisk({ legA: { side: 'short', entryPrice: 100 }, legB: null, markA: 100, markB: null })
    expect(r.status).toBe('open')
    expect(r.liquidationDistanceBps).toBeCloseTo(D0 * 10_000, 4)
  })

  it('short leg: price rising consumes buffer; >80% consumed → at_risk', () => {
    // d0 ≈ 0.3283. at_risk when remaining/d0 < 0.20 → consumed > 0.8*d0 ≈ 0.2627.
    // move +0.27 (27%) adverse → remaining ≈ 0.0583, ratio ≈ 0.178 < 0.20
    const r = assessRisk({ legA: { side: 'short', entryPrice: 100 }, legB: null, markA: 127, markB: null })
    expect(r.status).toBe('at_risk')
  })

  it('>95% consumed → liquidated_paper', () => {
    // move +0.32 adverse → remaining ≈ 0.0083, ratio ≈ 0.025 < 0.05
    const r = assessRisk({ legA: { side: 'short', entryPrice: 100 }, legB: null, markA: 132, markB: null })
    expect(r.status).toBe('liquidated_paper')
  })

  it('long leg: price falling is the adverse direction', () => {
    const r = assessRisk({ legA: { side: 'long', entryPrice: 100 }, legB: null, markA: 68, markB: null })
    expect(r.status).toBe('liquidated_paper')
  })

  it('cross-venue: the binding (losing) leg drives the state', () => {
    // legA long unharmed (price up), legB short deep in adverse → liquidated
    const r = assessRisk({
      legA: { side: 'long', entryPrice: 100 },
      legB: { side: 'short', entryPrice: 100 },
      markA: 132,
      markB: 132,
    })
    expect(r.status).toBe('liquidated_paper')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: FAIL — `assessRisk is not a function`.

- [ ] **Step 3: Write minimal implementation** (append)

```typescript
function adverseFraction(side: Side, entryPrice: number, mark: number): number {
  const a = side === 'short' ? (mark - entryPrice) / entryPrice : (entryPrice - mark) / entryPrice
  return Math.max(0, a)
}

export interface RiskLeg {
  side: Side
  entryPrice: number
}
export interface RiskAssessment {
  liquidationDistanceBps: number
  status: 'open' | 'at_risk' | 'liquidated_paper'
}

export function assessRisk(args: {
  legA: RiskLeg
  legB: RiskLeg | null
  markA: number
  markB: number | null
}): RiskAssessment {
  const { legA, legB, markA, markB } = args
  const d0 = INITIAL_BUFFER_FRACTION
  const remaining = (leg: RiskLeg, mark: number): number =>
    d0 - adverseFraction(leg.side, leg.entryPrice, mark)
  const rems = [remaining(legA, markA)]
  if (legB) {
    if (markB === null) throw new Error('cross-venue position requires markB')
    rems.push(remaining(legB, markB))
  }
  const minRem = Math.min(...rems)
  const ratio = minRem / d0
  const status =
    ratio < LIQUIDATION_BUFFER_FRACTION
      ? 'liquidated_paper'
      : ratio < AT_RISK_BUFFER_FRACTION
        ? 'at_risk'
        : 'open'
  return { liquidationDistanceBps: minRem * BPS, status }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pnl.ts src/lib/pnl.test.ts
git commit -m "feat(pnl): assessRisk (liq distance + at_risk/liquidated states)"
```

---

## Task 5: `computeClose` (realized P&L)

**Files:**
- Modify: `src/lib/pnl.ts`
- Test: `src/lib/pnl.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```typescript
import { computeClose } from './pnl'

describe('computeClose', () => {
  it('realized = price P&L + funding − round-trip fees − round-trip slippage', () => {
    // cross-venue, marks unchanged (pricePnl 0), $1000/leg, HL+Binance major.
    // per-leg close fee: HL 0.45 + Binance 0.40 = 0.85 ; round trip (open+close) = 1.70
    // per-leg close slip: 0.50 each = 1.00 ; round trip = 2.00
    // cumulative funding so far = +12.00
    // realized = 0 + 12 − 1.70 − 2.00 = 8.30
    const r = computeClose({
      legA: { venueId: 'hyperliquid', tier: 'major', side: 'long', entryPrice: 100 },
      legB: { venueId: 'binance_futures', tier: 'major', side: 'short', entryPrice: 100 },
      markA: 100,
      markB: 100,
      sizeUsd: 1000,
      cumulativeFundingUsd: 12,
    })
    expect(r.pricePnl).toBeCloseTo(0, 9)
    expect(r.closeFeesUsd).toBeCloseTo(0.85, 9)
    expect(r.totalFeesUsd).toBeCloseTo(1.7, 9)
    expect(r.totalSlippageUsd).toBeCloseTo(2.0, 9)
    expect(r.realizedPnlUsd).toBeCloseTo(8.3, 9)
    expect(r.legA.exitPrice).toBe(100)
  })

  it('single-venue: pricePnl 0, one leg of costs', () => {
    // HL short, mid tier. close fee 0.45, round trip 0.90 ; close slip 1.50, round trip 3.00
    // funding +5 → realized = 0 + 5 − 0.90 − 3.00 = 1.10
    const r = computeClose({
      legA: { venueId: 'hyperliquid', tier: 'mid', side: 'short', entryPrice: 50 },
      legB: null,
      markA: 50,
      markB: null,
      sizeUsd: 1000,
      cumulativeFundingUsd: 5,
    })
    expect(r.legB).toBeNull()
    expect(r.realizedPnlUsd).toBeCloseTo(1.1, 9)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/pnl.test.ts`
Expected: FAIL — `computeClose is not a function`.

- [ ] **Step 3: Write minimal implementation** (append)

```typescript
export interface CloseLegInput {
  venueId: VenueId
  tier: Tier
  side: Side
  entryPrice: number
}
export interface CloseFill {
  side: Side
  exitPrice: number
  feeUsd: number
  slippageBps: number
  slippageUsd: number
}
export interface CloseResult {
  legA: CloseFill
  legB: CloseFill | null
  pricePnl: number
  closeFeesUsd: number
  closeSlippageUsd: number
  totalFeesUsd: number
  totalSlippageUsd: number
  realizedPnlUsd: number
}

export function computeClose(args: {
  legA: CloseLegInput
  legB: CloseLegInput | null
  markA: number
  markB: number | null
  sizeUsd: number
  cumulativeFundingUsd: number
}): CloseResult {
  const { legA, legB, markA, markB, sizeUsd, cumulativeFundingUsd } = args
  assertPositiveFinite(sizeUsd, 'sizeUsd')
  const buildClose = (leg: CloseLegInput, mark: number): CloseFill => {
    assertPositiveFinite(mark, 'mark')
    const feeUsd = legFeeUsd(sizeUsd, leg.venueId)
    const slip = legSlippage(sizeUsd, leg.tier)
    return { side: leg.side, exitPrice: mark, feeUsd, slippageBps: slip.bps, slippageUsd: slip.usd }
  }
  const a = buildClose(legA, markA)
  const b = legB ? buildClose(legB, markB as number) : null
  const pricePnl = computeUnrealizedPnl({
    legA: { side: legA.side, entryPrice: legA.entryPrice },
    legB: legB ? { side: legB.side, entryPrice: legB.entryPrice } : null,
    markA,
    markB,
    sizeUsd,
  })
  const closeFeesUsd = a.feeUsd + (b ? b.feeUsd : 0)
  const closeSlippageUsd = a.slippageUsd + (b ? b.slippageUsd : 0)
  // Open incurred the same per-leg fee + slippage, so round-trip = 2× close.
  const totalFeesUsd = 2 * closeFeesUsd
  const totalSlippageUsd = 2 * closeSlippageUsd
  const realizedPnlUsd =
    pricePnl + cumulativeFundingUsd - totalFeesUsd - totalSlippageUsd
  return {
    legA: a,
    legB: b,
    pricePnl,
    closeFeesUsd,
    closeSlippageUsd,
    totalFeesUsd,
    totalSlippageUsd,
    realizedPnlUsd,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test` (full suite — confirm all prior tests still green)
Expected: PASS (math + normalize + detect + pnl).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pnl.ts src/lib/pnl.test.ts
git commit -m "feat(pnl): computeClose (realized P&L = price + funding − costs)"
```

---

## Task 6: Deno mirror `_shared/pnl.ts`

**Files:**
- Create: `supabase/functions/_shared/pnl.ts`

- [ ] **Step 1: Create the mirror** — copy `src/lib/pnl.ts` verbatim, changing ONLY the two import lines to the Deno `_shared` equivalents:

Replace:
```typescript
import type { VenueId, Tier } from '../types/domain'
import { VENUE_TAKER_BPS, SLIPPAGE_BPS_BY_TIER } from './math'
```
with:
```typescript
import type { VenueId, Tier } from './domain.ts'
import { VENUE_TAKER_BPS, SLIPPAGE_BPS_BY_TIER } from './math.ts'
```
(Everything else — constants, helpers, all five exported functions — is byte-for-byte identical.)

- [ ] **Step 2: Verify the logic is diff-identical to the tested source**

Run:
```bash
cd ~/funding-arb && diff \
  <(grep -vE "^import" src/lib/pnl.ts) \
  <(grep -vE "^import" supabase/functions/_shared/pnl.ts)
```
Expected: no output (identical apart from the import lines).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/pnl.ts
git commit -m "feat(pnl): Deno mirror _shared/pnl.ts (diff-verified)"
```

---

## Task 7: Shared DB helpers `_shared/paper.ts`

**Files:**
- Create: `supabase/functions/_shared/paper.ts`

- [ ] **Step 1: Write the full helper file**

```typescript
// Shared Deno DB orchestration for the paper engine. Pure math lives in pnl.ts;
// this is thin I/O reused by open-paper-position/auto-open (open path) and
// close-paper-position/snapshot-pnl (close path). No `any`; fail loud.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import type { VenueId, Tier } from './domain.ts'
import { computeOpenFills, computeClose, type Side } from './pnl.ts'

// Latest snapshot fields we need per instrument (from the latest_funding view).
export interface LatestMark {
  mark: number
  tier: Tier
  venueId: VenueId
  fundingRate1hApr: number
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const MarkRow = z.object({
  instrument_id: z.number(),
  venue_id: z.enum(['hyperliquid', 'binance_futures', 'bybit', 'okx']),
  tier: z.enum(['major', 'mid', 'alt']),
  mark_price: numeric,
  funding_rate_1h_apr: numeric,
})

export async function loadLatestMarks(
  supabase: SupabaseClient,
  instrumentIds: number[],
): Promise<Map<number, LatestMark>> {
  const { data, error } = await supabase
    .from('latest_funding')
    .select('instrument_id, venue_id, tier, mark_price, funding_rate_1h_apr')
    .in('instrument_id', instrumentIds)
  if (error) throw new Error(`db read latest_funding failed: ${error.message}`)
  const map = new Map<number, LatestMark>()
  for (const r of data ?? []) {
    const row = MarkRow.parse(r)
    map.set(row.instrument_id, {
      mark: row.mark_price,
      tier: row.tier,
      venueId: row.venue_id,
      fundingRate1hApr: row.funding_rate_1h_apr,
    })
  }
  return map
}

// An opportunities row, as needed to open a position.
export interface OpportunityRow {
  id: number
  leg_a_instrument_id: number
  leg_a_side: Side
  leg_b_instrument_id: number | null
  leg_b_side: Side | null
  dedup_key: string
}

export async function openPaperPosition(
  supabase: SupabaseClient,
  opp: OpportunityRow,
  sizeUsd: number,
): Promise<number> {
  const ids = [opp.leg_a_instrument_id]
  if (opp.leg_b_instrument_id !== null) ids.push(opp.leg_b_instrument_id)
  const marks = await loadLatestMarks(supabase, ids)

  const markA = marks.get(opp.leg_a_instrument_id)
  if (!markA) throw new Error(`no fresh mark for leg A instrument ${opp.leg_a_instrument_id}`)
  let markB: LatestMark | null = null
  if (opp.leg_b_instrument_id !== null) {
    markB = marks.get(opp.leg_b_instrument_id) ?? null
    if (!markB) throw new Error(`no fresh mark for leg B instrument ${opp.leg_b_instrument_id}`)
  }

  const fills = computeOpenFills({
    legA: { venueId: markA.venueId, tier: markA.tier, side: opp.leg_a_side, mark: markA.mark },
    legB:
      markB && opp.leg_b_side
        ? { venueId: markB.venueId, tier: markB.tier, side: opp.leg_b_side, mark: markB.mark }
        : null,
    sizeUsd,
  })

  const { data: posData, error: posErr } = await supabase
    .from('paper_positions')
    .insert({
      opportunity_id: opp.id,
      status: 'open',
      position_size_usd: sizeUsd,
      leg_a_instrument_id: opp.leg_a_instrument_id,
      leg_a_side: fills.legA.side,
      leg_a_entry_price: fills.legA.entryPrice,
      leg_b_instrument_id: opp.leg_b_instrument_id,
      leg_b_side: fills.legB ? fills.legB.side : null,
      leg_b_entry_price: fills.legB ? fills.legB.entryPrice : null,
      cumulative_fees_usd: fills.feesUsd,
      dedup_key: opp.dedup_key,
    })
    .select('id')
    .single()
  if (posErr) throw new Error(`db insert paper_positions failed: ${posErr.message}`)
  const positionId = (posData as { id: number }).id

  const fillRows = [
    {
      position_id: positionId,
      leg: 'a',
      side: fills.legA.side,
      action: 'open',
      instrument_id: opp.leg_a_instrument_id,
      price: fills.legA.entryPrice,
      size_usd: sizeUsd,
      fee_usd: fills.legA.feeUsd,
      slippage_bps: fills.legA.slippageBps,
    },
  ]
  if (fills.legB && opp.leg_b_instrument_id !== null) {
    fillRows.push({
      position_id: positionId,
      leg: 'b',
      side: fills.legB.side,
      action: 'open',
      instrument_id: opp.leg_b_instrument_id,
      price: fills.legB.entryPrice,
      size_usd: sizeUsd,
      fee_usd: fills.legB.feeUsd,
      slippage_bps: fills.legB.slippageBps,
    })
  }
  const { error: fillErr } = await supabase.from('paper_fills').insert(fillRows)
  if (fillErr) throw new Error(`db insert paper_fills failed: ${fillErr.message}`)

  const { error: oppErr } = await supabase
    .from('opportunities')
    .update({ status: 'paper_traded' })
    .eq('id', opp.id)
  if (oppErr) throw new Error(`db update opportunity ${opp.id} failed: ${oppErr.message}`)

  return positionId
}

// A paper_positions row, as needed to close.
export interface PositionRow {
  id: number
  position_size_usd: number
  leg_a_instrument_id: number
  leg_a_side: Side
  leg_a_entry_price: number
  leg_b_instrument_id: number | null
  leg_b_side: Side | null
  leg_b_entry_price: number | null
  cumulative_funding_usd: number
}

export async function closePaperPosition(
  supabase: SupabaseClient,
  pos: PositionRow,
  finalStatus: 'closed' | 'liquidated_paper',
  closedAtIso: string,
): Promise<number> {
  const ids = [pos.leg_a_instrument_id]
  if (pos.leg_b_instrument_id !== null) ids.push(pos.leg_b_instrument_id)
  const marks = await loadLatestMarks(supabase, ids)

  const markA = marks.get(pos.leg_a_instrument_id)
  if (!markA) throw new Error(`no fresh mark for leg A instrument ${pos.leg_a_instrument_id}`)
  let markB: LatestMark | null = null
  if (pos.leg_b_instrument_id !== null) {
    markB = marks.get(pos.leg_b_instrument_id) ?? null
    if (!markB) throw new Error(`no fresh mark for leg B instrument ${pos.leg_b_instrument_id}`)
  }

  const result = computeClose({
    legA: {
      venueId: markA.venueId,
      tier: markA.tier,
      side: pos.leg_a_side,
      entryPrice: pos.leg_a_entry_price,
    },
    legB:
      markB && pos.leg_b_side && pos.leg_b_entry_price !== null
        ? { venueId: markB.venueId, tier: markB.tier, side: pos.leg_b_side, entryPrice: pos.leg_b_entry_price }
        : null,
    markA: markA.mark,
    markB: markB ? markB.mark : null,
    sizeUsd: pos.position_size_usd,
    cumulativeFundingUsd: pos.cumulative_funding_usd,
  })

  const closeRows = [
    {
      position_id: pos.id,
      leg: 'a',
      side: result.legA.side,
      action: 'close',
      instrument_id: pos.leg_a_instrument_id,
      price: result.legA.exitPrice,
      size_usd: pos.position_size_usd,
      fee_usd: result.legA.feeUsd,
      slippage_bps: result.legA.slippageBps,
    },
  ]
  if (result.legB && pos.leg_b_instrument_id !== null) {
    closeRows.push({
      position_id: pos.id,
      leg: 'b',
      side: result.legB.side,
      action: 'close',
      instrument_id: pos.leg_b_instrument_id,
      price: result.legB.exitPrice,
      size_usd: pos.position_size_usd,
      fee_usd: result.legB.feeUsd,
      slippage_bps: result.legB.slippageBps,
    })
  }
  const { error: fillErr } = await supabase.from('paper_fills').insert(closeRows)
  if (fillErr) throw new Error(`db insert close fills failed: ${fillErr.message}`)

  const { error: updErr } = await supabase
    .from('paper_positions')
    .update({
      status: finalStatus,
      closed_at: closedAtIso,
      realized_pnl_usd: result.realizedPnlUsd,
      cumulative_fees_usd: result.totalFeesUsd,
    })
    .eq('id', pos.id)
  if (updErr) throw new Error(`db update paper_position ${pos.id} failed: ${updErr.message}`)

  return pos.id
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/paper.ts
git commit -m "feat(paper): shared Deno DB helpers (loadLatestMarks, open/close)"
```

---

## Task 8: `open-paper-position` edge function

**Files:**
- Create: `supabase/functions/open-paper-position/index.ts`
- Create: `supabase/functions/open-paper-position/README.md`

- [ ] **Step 1: Write `index.ts`**

```typescript
// open-paper-position — Supabase Edge Function (Deno). SPEC §6.1.
// Input: POST { opportunityId: number, sizeUsd?: number }. Loads the opportunity,
// reads latest marks, computes fills (tested pnl.ts), inserts a paper_position +
// per-leg open fills via service role, flips the opportunity to paper_traded.
// Hard rules: no secrets in code, no `any` (zod), fail loud (500). No venue I/O.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { PAPER_POSITION_USD } from '../_shared/pnl.ts'
import { openPaperPosition, type OpportunityRow } from '../_shared/paper.ts'

const FN = 'open-paper-position'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const Body = z.object({
  opportunityId: z.number(),
  sizeUsd: z.number().positive().optional(),
})

const OppRow = z.object({
  id: z.number(),
  leg_a_instrument_id: z.number(),
  leg_a_side: z.enum(['long', 'short']),
  leg_b_instrument_id: z.number().nullable(),
  leg_b_side: z.enum(['long', 'short']).nullable(),
  dedup_key: z.string(),
})

Deno.serve(async (req) => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const body = Body.parse(await req.json())
    const sizeUsd = body.sizeUsd ?? PAPER_POSITION_USD

    const { data, error } = await supabase
      .from('opportunities')
      .select('id, leg_a_instrument_id, leg_a_side, leg_b_instrument_id, leg_b_side, dedup_key')
      .eq('id', body.opportunityId)
      .single()
    if (error) throw new Error(`db read opportunity failed: ${error.message}`)
    const opp = OppRow.parse(data) as OpportunityRow

    const positionId = await openPaperPosition(supabase, opp, sizeUsd)
    return Response.json({ positionId, sizeUsd })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
```

- [ ] **Step 2: Write `README.md`**

```markdown
# open-paper-position

Supabase Edge Function (Deno). SPEC §6.1. Opens one delta-neutral paper position
from an opportunity: reads latest marks, computes fills via the tested `pnl.ts`
(entry=mark, taker fee + slippage, liquidation prices), inserts `paper_positions`
+ per-leg `paper_fills` (action `open`) via the service-role client, and flips the
opportunity to `status='paper_traded'`. Shared open logic lives in `_shared/paper.ts`.

## Invoke

```bash
supabase functions serve open-paper-position --env-file .env.local
curl -i -X POST http://localhost:54321/functions/v1/open-paper-position \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"opportunityId": 123}'   # sizeUsd optional, defaults to $1000/leg
# expect: {"positionId": N, "sizeUsd": 1000}
```

## Deploy

```bash
supabase functions deploy open-paper-position
```

No cron — invoked by `auto-open` (via the shared helper) and the Session 4 dashboard CTA.

## Failure behavior

No silent retries (hard rule #7). Missing opportunity, missing fresh mark for a leg,
or a DB write error → structured `{fn, error}` log + HTTP 500.
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/open-paper-position/
git commit -m "feat(paper): open-paper-position edge function"
```

---

## Task 9: `auto-open` edge function (5-min cron)

**Files:**
- Create: `supabase/functions/auto-open/index.ts`
- Create: `supabase/functions/auto-open/README.md`

- [ ] **Step 1: Write `index.ts`**

```typescript
// auto-open — Supabase Edge Function (Deno), 5-min cron. SPEC §8 30-day run.
// Opens one paper position per open opportunity that clears the PAPER-OPEN bar
// (single ≥15% net, cross ≥20% net), deduped so only one open/at_risk position
// exists per opportunity dedup_key. Reuses _shared/paper.ts openPaperPosition.
// Hard rules: no secrets, no `any` (zod), fail loud; one opp failure is logged
// and skipped so the rest still open.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { PAPER_POSITION_USD } from '../_shared/pnl.ts'
import { openPaperPosition, type OpportunityRow } from '../_shared/paper.ts'

const FN = 'auto-open'
const SINGLE_OPEN_APR = 15
const CROSS_OPEN_APR = 20

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const OppRow = z.object({
  id: z.number(),
  kind: z.enum(['single_venue_funding_harvest', 'cross_venue_basis_arb']),
  net_apr: numeric,
  leg_a_instrument_id: z.number(),
  leg_a_side: z.enum(['long', 'short']),
  leg_b_instrument_id: z.number().nullable(),
  leg_b_side: z.enum(['long', 'short']).nullable(),
  dedup_key: z.string(),
})

Deno.serve(async () => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })

    const { data: oppData, error: oppErr } = await supabase
      .from('opportunities')
      .select('id, kind, net_apr, leg_a_instrument_id, leg_a_side, leg_b_instrument_id, leg_b_side, dedup_key')
      .eq('status', 'open')
    if (oppErr) throw new Error(`db read opportunities failed: ${oppErr.message}`)
    const opps = (oppData ?? []).map((r) => OppRow.parse(r))

    const { data: posData, error: posErr } = await supabase
      .from('paper_positions')
      .select('dedup_key')
      .in('status', ['open', 'at_risk'])
    if (posErr) throw new Error(`db read open positions failed: ${posErr.message}`)
    const openKeys = new Set((posData ?? []).map((r) => (r as { dedup_key: string | null }).dedup_key))

    let opened = 0
    let skipped = 0
    for (const opp of opps) {
      const bar = opp.kind === 'cross_venue_basis_arb' ? CROSS_OPEN_APR : SINGLE_OPEN_APR
      if (opp.net_apr < bar || openKeys.has(opp.dedup_key)) {
        skipped++
        continue
      }
      try {
        await openPaperPosition(supabase, opp as OpportunityRow, PAPER_POSITION_USD)
        openKeys.add(opp.dedup_key)
        opened++
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        console.error(JSON.stringify({ fn: FN, oppId: opp.id, error: m }))
      }
    }

    return Response.json({ candidates: opps.length, opened, skipped })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
```

- [ ] **Step 2: Write `README.md`**

```markdown
# auto-open

Supabase Edge Function (Deno), 5-min cron. SPEC §8 (30-day run). Opens one paper
position per `open` opportunity clearing the PAPER-OPEN bar — single-venue ≥15% net,
cross-venue ≥20% net — deduped so only one `open`/`at_risk` position exists per
opportunity `dedup_key`. Fixed size `PAPER_POSITION_USD` ($1000/leg). Reuses
`_shared/paper.ts` `openPaperPosition`. One opportunity failing is logged and skipped.

## Deploy + schedule (its own 5-min cron)

```bash
supabase functions deploy auto-open
```

```sql
select cron.schedule(
  'auto-open-5min', '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/auto-open',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
```

Unschedule: `select cron.unschedule('auto-open-5min');`

## Failure behavior

No silent retries (hard rule #7). Top-level DB read error → `{fn, error}` log + 500.
Per-opportunity open errors are logged `{fn, oppId, error}` and skipped.
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/auto-open/
git commit -m "feat(paper): auto-open edge function (5-min cron)"
```

---

## Task 10: `snapshot-pnl` edge function (5-min cron)

**Files:**
- Create: `supabase/functions/snapshot-pnl/index.ts`
- Create: `supabase/functions/snapshot-pnl/README.md`

- [ ] **Step 1: Write `index.ts`**

```typescript
// snapshot-pnl — Supabase Edge Function (Deno), 5-min cron. SPEC §6.2.
// For each open/at_risk position: pull latest marks, accrue funding pro-rata since
// the last snapshot, mark to market, assess risk, insert a pnl_snapshots row and
// update the position. On liquidated_paper, force-close via _shared/paper.ts.
// Hard rules: no secrets, no `any` (zod), fail loud; one bad position is skipped.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { accrueFunding, computeUnrealizedPnl, assessRisk } from '../_shared/pnl.ts'
import { closePaperPosition, loadLatestMarks, type PositionRow } from '../_shared/paper.ts'

const FN = 'snapshot-pnl'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const PosRow = z.object({
  id: z.number(),
  opened_at: z.string(),
  position_size_usd: numeric,
  leg_a_instrument_id: z.number(),
  leg_a_side: z.enum(['long', 'short']),
  leg_a_entry_price: numeric,
  leg_b_instrument_id: z.number().nullable(),
  leg_b_side: z.enum(['long', 'short']).nullable(),
  leg_b_entry_price: numeric.nullable(),
  cumulative_funding_usd: numeric,
  cumulative_fees_usd: numeric,
})
type PosRowT = z.infer<typeof PosRow>

async function lastSnapshotMs(supabase: ReturnType<typeof createClient>, positionId: number, openedAt: string): Promise<number> {
  const { data, error } = await supabase
    .from('pnl_snapshots')
    .select('ts')
    .eq('position_id', positionId)
    .order('ts', { ascending: false })
    .limit(1)
  if (error) throw new Error(`db read pnl_snapshots failed: ${error.message}`)
  const last = (data ?? [])[0] as { ts: string } | undefined
  return new Date(last ? last.ts : openedAt).getTime()
}

async function processPosition(supabase: ReturnType<typeof createClient>, pos: PosRowT, nowMs: number, nowIso: string): Promise<string> {
  const ids = [pos.leg_a_instrument_id]
  if (pos.leg_b_instrument_id !== null) ids.push(pos.leg_b_instrument_id)
  const marks = await loadLatestMarks(supabase, ids)
  const markA = marks.get(pos.leg_a_instrument_id)
  if (!markA) throw new Error(`no fresh mark for leg A instrument ${pos.leg_a_instrument_id}`)
  let markB = null as (typeof markA) | null
  if (pos.leg_b_instrument_id !== null) {
    markB = marks.get(pos.leg_b_instrument_id) ?? null
    if (!markB) throw new Error(`no fresh mark for leg B instrument ${pos.leg_b_instrument_id}`)
  }

  const dtMs = nowMs - (await lastSnapshotMs(supabase, pos.id, pos.opened_at))
  const fundingDelta = accrueFunding({
    legA: { side: pos.leg_a_side, fundingRate1hApr: markA.fundingRate1hApr },
    legB: markB && pos.leg_b_side ? { side: pos.leg_b_side, fundingRate1hApr: markB.fundingRate1hApr } : null,
    sizeUsd: pos.position_size_usd,
    dtMs,
  })
  const newCumFunding = pos.cumulative_funding_usd + fundingDelta

  const legA = { side: pos.leg_a_side, entryPrice: pos.leg_a_entry_price }
  const legB = markB && pos.leg_b_side && pos.leg_b_entry_price !== null ? { side: pos.leg_b_side, entryPrice: pos.leg_b_entry_price } : null
  const unrealized = computeUnrealizedPnl({ legA, legB, markA: markA.mark, markB: markB ? markB.mark : null, sizeUsd: pos.position_size_usd })
  const risk = assessRisk({ legA, legB, markA: markA.mark, markB: markB ? markB.mark : null })

  const { error: snapErr } = await supabase.from('pnl_snapshots').insert({
    position_id: pos.id,
    unrealized_pnl_usd: unrealized,
    realized_pnl_usd: 0,
    cumulative_funding_usd: newCumFunding,
    cumulative_fees_usd: pos.cumulative_fees_usd,
    leg_a_mark: markA.mark,
    leg_b_mark: markB ? markB.mark : null,
    liquidation_distance_bps: risk.liquidationDistanceBps,
  })
  if (snapErr) throw new Error(`db insert pnl_snapshots failed: ${snapErr.message}`)

  const { error: updErr } = await supabase
    .from('paper_positions')
    .update({ cumulative_funding_usd: newCumFunding, status: risk.status })
    .eq('id', pos.id)
  if (updErr) throw new Error(`db update paper_position failed: ${updErr.message}`)

  if (risk.status === 'liquidated_paper') {
    const posForClose: PositionRow = {
      id: pos.id,
      position_size_usd: pos.position_size_usd,
      leg_a_instrument_id: pos.leg_a_instrument_id,
      leg_a_side: pos.leg_a_side,
      leg_a_entry_price: pos.leg_a_entry_price,
      leg_b_instrument_id: pos.leg_b_instrument_id,
      leg_b_side: pos.leg_b_side,
      leg_b_entry_price: pos.leg_b_entry_price,
      cumulative_funding_usd: newCumFunding,
    }
    await closePaperPosition(supabase, posForClose, 'liquidated_paper', nowIso)
  }
  return risk.status
}

Deno.serve(async () => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const { data, error } = await supabase
      .from('paper_positions')
      .select(
        'id, opened_at, position_size_usd, leg_a_instrument_id, leg_a_side, leg_a_entry_price, leg_b_instrument_id, leg_b_side, leg_b_entry_price, cumulative_funding_usd, cumulative_fees_usd',
      )
      .in('status', ['open', 'at_risk'])
    if (error) throw new Error(`db read paper_positions failed: ${error.message}`)
    const positions = (data ?? []).map((r) => PosRow.parse(r))

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    let snapped = 0
    let liquidated = 0
    for (const pos of positions) {
      try {
        const status = await processPosition(supabase, pos, nowMs, nowIso)
        snapped++
        if (status === 'liquidated_paper') liquidated++
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        console.error(JSON.stringify({ fn: FN, positionId: pos.id, error: m }))
      }
    }
    return Response.json({ positions: positions.length, snapped, liquidated })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
```

- [ ] **Step 2: Write `README.md`**

```markdown
# snapshot-pnl

Supabase Edge Function (Deno), 5-min cron. SPEC §6.2. For each `open`/`at_risk`
paper position: pulls latest marks, accrues funding pro-rata since the last snapshot
(continuous model), marks to market, assesses liquidation risk, inserts a
`pnl_snapshots` row, and updates the position's `cumulative_funding_usd` + `status`.
On `liquidated_paper` it force-closes via `_shared/paper.ts`. Math is the tested
`pnl.ts`. One bad position is logged and skipped.

## Deploy + schedule (its own 5-min cron)

```bash
supabase functions deploy snapshot-pnl
```

```sql
select cron.schedule(
  'snapshot-pnl-5min', '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/snapshot-pnl',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
```

Unschedule: `select cron.unschedule('snapshot-pnl-5min');`

## Failure behavior

No silent retries (hard rule #7). Top-level DB read error → `{fn, error}` + 500.
Per-position errors are logged `{fn, positionId, error}` and skipped.
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/snapshot-pnl/
git commit -m "feat(paper): snapshot-pnl edge function (5-min cron)"
```

---

## Task 11: `close-paper-position` edge function

**Files:**
- Create: `supabase/functions/close-paper-position/index.ts`
- Create: `supabase/functions/close-paper-position/README.md`

- [ ] **Step 1: Write `index.ts`**

```typescript
// close-paper-position — Supabase Edge Function (Deno). SPEC §6.3.
// Input: POST { positionId: number }. Reads the position + latest marks, settles
// funding + round-trip fees + slippage into realized_pnl_usd (tested pnl.ts via
// _shared/paper.ts), writes close fills, marks the position 'closed'.
// Hard rules: no secrets, no `any` (zod), fail loud (500). No venue I/O.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { closePaperPosition, type PositionRow } from '../_shared/paper.ts'

const FN = 'close-paper-position'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const Body = z.object({ positionId: z.number() })

const PosRow = z.object({
  id: z.number(),
  status: z.string(),
  position_size_usd: numeric,
  leg_a_instrument_id: z.number(),
  leg_a_side: z.enum(['long', 'short']),
  leg_a_entry_price: numeric,
  leg_b_instrument_id: z.number().nullable(),
  leg_b_side: z.enum(['long', 'short']).nullable(),
  leg_b_entry_price: numeric.nullable(),
  cumulative_funding_usd: numeric,
})

Deno.serve(async (req) => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const body = Body.parse(await req.json())

    const { data, error } = await supabase
      .from('paper_positions')
      .select(
        'id, status, position_size_usd, leg_a_instrument_id, leg_a_side, leg_a_entry_price, leg_b_instrument_id, leg_b_side, leg_b_entry_price, cumulative_funding_usd',
      )
      .eq('id', body.positionId)
      .single()
    if (error) throw new Error(`db read paper_position failed: ${error.message}`)
    const row = PosRow.parse(data)
    if (row.status === 'closed' || row.status === 'liquidated_paper') {
      throw new Error(`position ${row.id} already ${row.status}`)
    }

    const pos: PositionRow = {
      id: row.id,
      position_size_usd: row.position_size_usd,
      leg_a_instrument_id: row.leg_a_instrument_id,
      leg_a_side: row.leg_a_side,
      leg_a_entry_price: row.leg_a_entry_price,
      leg_b_instrument_id: row.leg_b_instrument_id,
      leg_b_side: row.leg_b_side,
      leg_b_entry_price: row.leg_b_entry_price,
      cumulative_funding_usd: row.cumulative_funding_usd,
    }
    await closePaperPosition(supabase, pos, 'closed', new Date().toISOString())
    return Response.json({ positionId: pos.id, status: 'closed' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
```

- [ ] **Step 2: Write `README.md`**

```markdown
# close-paper-position

Supabase Edge Function (Deno). SPEC §6.3. Closes one open paper position: reads it +
latest marks, settles funding + round-trip fees + slippage into `realized_pnl_usd`
(tested `pnl.ts` via `_shared/paper.ts`), writes per-leg close fills, sets
`status='closed'` + `closed_at`. Rejects an already-closed/liquidated position.

## Invoke

```bash
supabase functions serve close-paper-position --env-file .env.local
curl -i -X POST http://localhost:54321/functions/v1/close-paper-position \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"positionId": 1}'
# expect: {"positionId": 1, "status": "closed"}
```

## Deploy

```bash
supabase functions deploy close-paper-position
```

No cron — invoked by the Session 4 dashboard "Close" CTA. (Liquidation auto-close is
handled inside `snapshot-pnl`.)

## Failure behavior

No silent retries (hard rule #7). Missing position, already-closed, missing fresh
mark, or DB write error → `{fn, error}` log + HTTP 500.
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/close-paper-position/
git commit -m "feat(paper): close-paper-position edge function"
```

---

## Task 12: `session-3-ops.sql` (Nick-run migration + crons)

**Files:**
- Create: `session-3-ops.sql`

- [ ] **Step 1: Write the SQL file**

```sql
-- Session 3 ops — RUN BY NICK in the Supabase SQL editor (classifier blocks the
-- agent from prod-DB writes). Idempotent. Deploy the 4 paper-engine functions
-- FIRST, then run this. Replace <project-ref> (efsaspkngkzgmppajnne). Vault
-- service_role_key was stored in Session 1.

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
    url     := 'https://<project-ref>.supabase.co/functions/v1/auto-open',
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
    url     := 'https://<project-ref>.supabase.co/functions/v1/snapshot-pnl',
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
```

- [ ] **Step 2: Commit**

```bash
git add session-3-ops.sql
git commit -m "feat(paper): session-3-ops.sql (dedup migration + 2 crons)"
```

---

## Task 13: Verify, push, update vault + memory

**Files:**
- Modify: `~/Funding-ARB-Vault/Reference/Codebase Map.md`, `~/Funding-ARB-Vault/Decisions/0003 — Session 2 multi-venue + detector.md` (add a 0004 note), project memory.

- [ ] **Step 1: Full verification**

Run: `cd ~/funding-arb && pnpm test && pnpm lint && pnpm build`
Expected: all tests pass (math + normalize + detect + **pnl**), lint exit 0, build exit 0.

- [ ] **Step 2: Diff-verify the Deno mirror once more**

Run:
```bash
diff <(grep -vE "^import" src/lib/pnl.ts) <(grep -vE "^import" supabase/functions/_shared/pnl.ts)
```
Expected: no output.

- [ ] **Step 3: Secret-safety scan**

Run:
```bash
git diff --cached --name-only; git grep -nE 'eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}' -- . ':(exclude).env*' || echo "OK no JWT"
```
Expected: no `.env.local`, no real JWT.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin session-3-paper-engine
```

- [ ] **Step 5: Write a Session 3 decision note** in the vault (`Decisions/0004 — Session 3 paper engine.md`) and update `Reference/Codebase Map.md` (move paper fns into Backend, add `src/lib/pnl.ts`, bump test count) + the `funding-arb-project` memory (Session 3 BUILT, not deployed; deploy = 4 fns + `session-3-ops.sql`; then 30-day run starts).

- [ ] **Step 6: Open a PR** (stacked on Session 2 until PR #1 merges)

```bash
gh pr create --base main --head session-3-paper-engine \
  --title "Session 3: paper-trade engine" \
  --body "Delta-neutral paper engine (SPEC §6). pnl.ts (TDD) + Deno mirror; open/close/auto-open/snapshot-pnl edge fns; session-3-ops.sql. Stacked on PR #1 — rebase onto main after #1 merges."
```

---

## Self-Review notes
- **Spec coverage:** open (Task 8), auto-open + paper-open bar (Task 9), snapshot-pnl + funding + risk states (Tasks 3/4/10), close + realized (Tasks 5/11), migration + crons (Task 12), pnl.ts tested before use + mirror diff-verified (Tasks 1–6/13). All acceptance boxes mapped.
- **Type consistency:** `Side`, `OpenResult`/`OpenFill`, `CloseResult`/`CloseFill`, `RiskAssessment`, `OpportunityRow`, `PositionRow`, `LatestMark` are defined once and reused across edge-fn tasks exactly as named.
- **Known runtime note:** Deno isn't installed locally, so edge-fn type/runtime checks happen at `supabase functions deploy` (smoke-test curls in each README). Pure math is fully covered by Vitest.
