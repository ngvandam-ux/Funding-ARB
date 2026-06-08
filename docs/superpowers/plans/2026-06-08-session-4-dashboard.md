# Session 4 — Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 dashboard (SPEC §7) — 6 live panels over the running HL×OKX ingestion/detector plus the paper-position/P&L/exec panels that light up once the Session 3 engine deploys.

**Architecture:** Anon-only Supabase reads. Pure tested helpers (`format.ts`, `heatmap.ts`) + one shared realtime hook (`useRealtimeRows`) feeding five thin domain hooks (uniform `{data,isLoading,error}`, one channel each). Presentational components take data + callbacks; the only edge-fn caller is `lib/api.ts` (anon-bearer). `App.tsx` lays them out on a 12-col grid.

**Tech Stack:** React 18 + TS + Vite + Tailwind v4, recharts, d3-scale-chromatic, react-window, @supabase/supabase-js (anon), date-fns, zod, Vitest. pnpm. Run all commands from `~/funding-arb`.

**Spec:** `docs/superpowers/specs/2026-06-08-session-4-dashboard-design.md`

**Conventions (match Sessions 1–3):** no `any` (eslint no-explicit-any=error); pure libs tested before use; components untested (CLAUDE.md — eyeball + Netlify preview); hooks return `{data,isLoading,error}`, subscribe in `useEffect`, `removeChannel` on cleanup; Tailwind tokens `bg/fg/magenta/cyan` already in `tailwind.config.ts`. Approved deps only: recharts, d3-scale-chromatic, react-window (all already allowed by CLAUDE.md).

---

## File Structure

- `src/types/domain.ts` (modify) — add `LatestFunding`, `PaperPosition`, `PnlSnapshot`, `PaperFill`, `PositionStatus`.
- `src/lib/format.ts` (+ `.test.ts`) (create) — pure formatters: USD, signed %, signed APR, relative time.
- `src/lib/heatmap.ts` (+ `.test.ts`) (create) — pure: signed-APR → diverging color, OI → cell-size class.
- `src/lib/api.ts` (create) — `openPaperPosition`/`closePaperPosition` POST to edge fns (anon bearer).
- `src/hooks/useRealtimeRows.ts` (create) — generic initial-select + realtime patch hook.
- `src/hooks/useFundingSnapshots.ts` / `useOpportunities.ts` / `usePaperPositions.ts` / `usePnlSnapshots.ts` / `useExecutionLog.ts` (create) — thin domain hooks.
- `src/components/ui/{Panel,Pill,EmptyState}.tsx` (create) — primitives.
- `src/components/{Header,FundingHeatmap,AprLeaderboard,OpportunityTable,PaperPositions,PnlCurve,ExecutionLog}.tsx` (create).
- `src/App.tsx` (modify) — 12-col grid assembly.
- `supabase/config.toml` (modify) — `verify_jwt = false` for the two invokable fns.
- `session-4-ops.sql` (create) — add `paper_fills` to the realtime publication (Nick-run).

---

## Task 1: Install UI deps

**Files:** `package.json` (modify via pnpm)

- [ ] **Step 1: Add the three approved UI deps**

Run: `pnpm add recharts d3-scale-chromatic react-window && pnpm add -D @types/d3-scale-chromatic @types/react-window`
Expected: installs succeed; `package.json` gains the deps. (All three are pre-approved in CLAUDE.md Stack.)

- [ ] **Step 2: Verify build still green**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add recharts, d3-scale-chromatic, react-window for dashboard"
```

---

## Task 2: Domain types for the reactive tables

**Files:**
- Modify: `src/types/domain.ts`

- [ ] **Step 1: Append the new types** (after the existing `Opportunity` interface)

```typescript
// --- Session 4: dashboard read models (mirror schema.sql snake_case tables) ---

export interface LatestFunding {
  instrumentId: number
  venueId: VenueId
  venueSymbol: string
  baseSymbol: string
  tier: Tier
  fundingRate1hApr: number
  markPrice: number | null
  openInterestUsd: number | null
  nextFundingTs: string | null
  ts: string
}

export type PositionStatus = 'open' | 'closed' | 'at_risk' | 'liquidated_paper'

export interface PaperPosition {
  id: number
  opportunityId: number | null
  openedAt: string
  closedAt: string | null
  status: PositionStatus
  positionSizeUsd: number
  legAInstrumentId: number
  legASide: 'long' | 'short'
  legAEntryPrice: number
  legBInstrumentId: number | null
  legBSide: 'long' | 'short' | null
  legBEntryPrice: number | null
  cumulativeFundingUsd: number
  cumulativeFeesUsd: number
  realizedPnlUsd: number | null
}

export interface PnlSnapshot {
  id: number
  ts: string
  positionId: number | null
  unrealizedPnlUsd: number
  realizedPnlUsd: number
  cumulativeFundingUsd: number
  cumulativeFeesUsd: number
  legAMark: number | null
  legBMark: number | null
  liquidationDistanceBps: number | null
}

export interface PaperFill {
  id: number
  positionId: number
  ts: string
  leg: 'a' | 'b'
  side: 'long' | 'short'
  action: 'open' | 'close'
  instrumentId: number
  price: number
  sizeUsd: number
  feeUsd: number
  slippageBps: number
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: exit 0 (types compile; nothing consumes them yet).

- [ ] **Step 3: Commit**

```bash
git add src/types/domain.ts
git commit -m "feat(types): dashboard read models (LatestFunding, PaperPosition, PnlSnapshot, PaperFill)"
```

---

## Task 3: `format.ts` pure formatters (TDD)

**Files:**
- Create: `src/lib/format.ts`
- Test: `src/lib/format.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/format.test.ts
import { describe, it, expect } from 'vitest'
import { fmtUsd, fmtSignedUsd, fmtApr, fmtBps, fmtRelTime } from './format'

describe('fmtUsd', () => {
  it('formats with $ and 2 decimals', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50')
    expect(fmtUsd(0)).toBe('$0.00')
  })
  it('renders null/NaN as an em dash', () => {
    expect(fmtUsd(null)).toBe('—')
    expect(fmtUsd(Number.NaN)).toBe('—')
  })
})

describe('fmtSignedUsd', () => {
  it('prefixes + for positive, − for negative', () => {
    expect(fmtSignedUsd(12.3)).toBe('+$12.30')
    expect(fmtSignedUsd(-12.3)).toBe('−$12.30')
    expect(fmtSignedUsd(0)).toBe('+$0.00')
  })
})

describe('fmtApr', () => {
  it('formats an APR percent with sign and 2 decimals', () => {
    expect(fmtApr(9.4789)).toBe('+9.48%')
    expect(fmtApr(-3.2)).toBe('−3.20%')
    expect(fmtApr(null)).toBe('—')
  })
})

describe('fmtBps', () => {
  it('rounds to whole bps with a suffix', () => {
    expect(fmtBps(3283.4)).toBe('3283 bps')
    expect(fmtBps(null)).toBe('—')
  })
})

describe('fmtRelTime', () => {
  it('renders a relative string against a reference now', () => {
    const now = new Date('2026-06-08T12:00:30Z')
    expect(fmtRelTime('2026-06-08T12:00:00Z', now)).toMatch(/30 seconds? ago/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/format.test.ts`
Expected: FAIL — `Failed to load url ./format`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/format.ts
// Pure display formatters for the dashboard. No I/O. date-fns for relative time
// (CLAUDE.md: never raw Date arithmetic). Uses a real minus sign (−) for negatives.
// formatDistanceStrict takes an explicit baseDate so fmtRelTime is deterministic/testable.
import { formatDistanceStrict } from 'date-fns'

const DASH = '—'
const MINUS = '−'

function isBad(n: number | null | undefined): n is null | undefined {
  return n === null || n === undefined || !Number.isFinite(n)
}

export function fmtUsd(n: number | null | undefined): string {
  if (isBad(n)) return DASH
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtSignedUsd(n: number | null | undefined): string {
  if (isBad(n)) return DASH
  const sign = n < 0 ? MINUS : '+'
  return `${sign}${fmtUsd(n)}`
}

export function fmtApr(n: number | null | undefined): string {
  if (isBad(n)) return DASH
  const sign = n < 0 ? MINUS : '+'
  return `${sign}${Math.abs(n).toFixed(2)}%`
}

export function fmtBps(n: number | null | undefined): string {
  if (isBad(n)) return DASH
  return `${Math.round(n)} bps`
}

export function fmtRelTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  return formatDistanceStrict(d, now, { addSuffix: true })
}
```

Note: `fmtUsd` formats the absolute value; the sign is owned by `fmtSignedUsd`/`fmtApr` so a bare `fmtUsd(-5)` is `$5.00` (used where the column already conveys sign). The tests above only assert `fmtUsd` on non-negative inputs.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "feat(format): pure dashboard formatters (TDD)"
```

---

## Task 4: `heatmap.ts` color + size scales (TDD)

**Files:**
- Create: `src/lib/heatmap.ts`
- Test: `src/lib/heatmap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/heatmap.test.ts
import { describe, it, expect } from 'vitest'
import { aprColor, oiSizeRank, HEATMAP_APR_DOMAIN } from './heatmap'

describe('aprColor', () => {
  it('maps 0 APR to a neutral mid color and clamps the domain', () => {
    const mid = aprColor(0)
    expect(mid).toMatch(/^rgb/)
    // clamps: beyond the domain returns the same as the domain edge
    expect(aprColor(HEATMAP_APR_DOMAIN * 10)).toBe(aprColor(HEATMAP_APR_DOMAIN))
    expect(aprColor(-HEATMAP_APR_DOMAIN * 10)).toBe(aprColor(-HEATMAP_APR_DOMAIN))
  })
  it('positive and negative APR map to different colors', () => {
    expect(aprColor(HEATMAP_APR_DOMAIN)).not.toBe(aprColor(-HEATMAP_APR_DOMAIN))
  })
  it('null APR is a transparent/no-data sentinel', () => {
    expect(aprColor(null)).toBe('transparent')
  })
})

describe('oiSizeRank', () => {
  it('buckets open interest into 0..3 by thresholds', () => {
    expect(oiSizeRank(null)).toBe(0)
    expect(oiSizeRank(0)).toBe(0)
    expect(oiSizeRank(5_000_000)).toBe(1)
    expect(oiSizeRank(50_000_000)).toBe(2)
    expect(oiSizeRank(500_000_000)).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/heatmap.test.ts`
Expected: FAIL — `Failed to load url ./heatmap`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/heatmap.ts
// Pure scales for the funding heatmap (SPEC §7). Diverging palette from
// d3-scale-chromatic (palette math only — NOT a charting lib; CLAUDE.md allows it).
// Color = signed 1h-APR; cell size rank = open interest bucket.
import { interpolateRdYlGn } from 'd3-scale-chromatic'

// APR (%) at which the palette saturates each side. ±50% covers our live range.
export const HEATMAP_APR_DOMAIN = 50

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// Positive funding (good for the short we'd open) → green; negative → red.
export function aprColor(apr: number | null | undefined): string {
  if (apr === null || apr === undefined || !Number.isFinite(apr)) return 'transparent'
  const c = clamp(apr, -HEATMAP_APR_DOMAIN, HEATMAP_APR_DOMAIN)
  const t = (c + HEATMAP_APR_DOMAIN) / (2 * HEATMAP_APR_DOMAIN) // 0..1
  return interpolateRdYlGn(t)
}

const OI_THRESHOLDS = [1_000_000, 25_000_000, 250_000_000] // USD

export function oiSizeRank(oiUsd: number | null | undefined): 0 | 1 | 2 | 3 {
  if (oiUsd === null || oiUsd === undefined || !Number.isFinite(oiUsd) || oiUsd <= 0) return 0
  if (oiUsd < OI_THRESHOLDS[0]) return 0
  if (oiUsd < OI_THRESHOLDS[1]) return 1
  if (oiUsd < OI_THRESHOLDS[2]) return 2
  return 3
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/heatmap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/heatmap.ts src/lib/heatmap.test.ts
git commit -m "feat(heatmap): pure APR-color + OI-size scales (TDD)"
```

---

## Task 5: `lib/api.ts` edge-fn client

**Files:**
- Create: `src/lib/api.ts`

- [ ] **Step 1: Write the client**

```typescript
// src/lib/api.ts
// The ONLY module that calls paper-engine edge functions. Browser is anon-only
// (CLAUDE.md hard rule #2) — the two invokable fns are deployed verify_jwt=false
// and use their own server-side service key. We pass the public anon key as bearer.
const URL = import.meta.env.VITE_SUPABASE_URL as string
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

async function callFn<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `${fn} failed (${res.status})`)
  return json
}

export function openPaperPosition(opportunityId: number): Promise<{ positionId: number; sizeUsd: number }> {
  return callFn('open-paper-position', { opportunityId })
}

export function closePaperPosition(positionId: number): Promise<{ positionId: number; status: string }> {
  return callFn('close-paper-position', { positionId })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): anon-bearer client for open/close-paper-position"
```

---

## Task 6: `useRealtimeRows` shared hook

**Files:**
- Create: `src/hooks/useRealtimeRows.ts`

- [ ] **Step 1: Write the hook**

```typescript
// src/hooks/useRealtimeRows.ts
// Shared data hook: initial select + Supabase Realtime patch for one table/view.
// Each domain hook supplies the table, a row→domain mapper, a stable key, and an
// optional sort. Subscribes in useEffect, removes the channel on cleanup
// (CLAUDE.md realtime pattern). Returns the uniform { data, isLoading, error }.
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Options<TDomain> {
  table: string
  select: string
  channel: string
  map: (row: Record<string, unknown>) => TDomain
  key: (d: TDomain) => number
  // Optional client-side filter applied to every row (e.g. status === 'open').
  keep?: (d: TDomain) => boolean
  // Optional comparator for display order.
  sort?: (a: TDomain, b: TDomain) => number
  // Optional PostgREST filter string for the initial select, e.g. "status=eq.open".
  initialFilter?: string
  // Realtime is INSERT+UPDATE by default; views (latest_funding) can't be subscribed
  // directly — subscribe to the backing table instead via `realtimeTable`.
  realtimeTable?: string
}

export function useRealtimeRows<TDomain>(opts: Options<TDomain>): {
  data: TDomain[]
  isLoading: boolean
  error: string | null
} {
  const [data, setData] = useState<TDomain[]>([])
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const apply = (rows: TDomain[]): TDomain[] => {
      const filtered = opts.keep ? rows.filter(opts.keep) : rows
      return opts.sort ? [...filtered].sort(opts.sort) : filtered
    }

    async function load() {
      let q = supabase.from(opts.table).select(opts.select)
      if (opts.initialFilter) {
        const [col, rest] = opts.initialFilter.split('=')
        const [op, val] = rest.split('.')
        // Only the operators we use here:
        q = op === 'eq' ? q.eq(col, val) : q.in(col, val.split(','))
      }
      const { data: rows, error: err } = await q
      if (cancelled) return
      if (err) {
        setError(err.message)
        setLoading(false)
        return
      }
      setData(apply((rows ?? []).map((r) => opts.map(r as Record<string, unknown>))))
      setLoading(false)
    }
    load()

    const channel = supabase
      .channel(opts.channel)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: opts.realtimeTable ?? opts.table },
        () => {
          // Simplest correct strategy: re-pull on any change. Tables are small
          // (≤ a few hundred rows in v1) so a refetch per tick is cheap and avoids
          // payload-shape drift. Fail-loud is unnecessary here; load() sets error.
          load()
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.table, opts.channel, opts.initialFilter, opts.realtimeTable])

  return { data, isLoading, error }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useRealtimeRows.ts
git commit -m "feat(hooks): useRealtimeRows shared select+realtime helper"
```

---

## Task 7: Domain hooks (funding, opportunities, positions, pnl, exec log)

**Files:**
- Create: `src/hooks/useFundingSnapshots.ts`, `useOpportunities.ts`, `usePaperPositions.ts`, `usePnlSnapshots.ts`, `useExecutionLog.ts`

- [ ] **Step 1: Write `useFundingSnapshots.ts`**

```typescript
// src/hooks/useFundingSnapshots.ts — latest_funding view; realtime on funding_snapshots.
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { LatestFunding, VenueId, Tier } from '../types/domain'

function num(v: unknown): number { return Number(v) }
function numOrNull(v: unknown): number | null { return v === null || v === undefined ? null : Number(v) }

export function useFundingSnapshots() {
  const opts = useMemo(
    () => ({
      table: 'latest_funding',
      realtimeTable: 'funding_snapshots',
      select: 'instrument_id, venue_id, venue_symbol, base_symbol, tier, funding_rate_1h_apr, mark_price, open_interest_usd, next_funding_ts, ts',
      channel: 'dash_funding',
      map: (r: Record<string, unknown>): LatestFunding => ({
        instrumentId: num(r.instrument_id),
        venueId: r.venue_id as VenueId,
        venueSymbol: String(r.venue_symbol),
        baseSymbol: String(r.base_symbol),
        tier: r.tier as Tier,
        fundingRate1hApr: num(r.funding_rate_1h_apr),
        markPrice: numOrNull(r.mark_price),
        openInterestUsd: numOrNull(r.open_interest_usd),
        nextFundingTs: (r.next_funding_ts as string | null) ?? null,
        ts: String(r.ts),
      }),
      key: (d: LatestFunding) => d.instrumentId,
    }),
    [],
  )
  return useRealtimeRows<LatestFunding>(opts)
}
```

- [ ] **Step 2: Write `useOpportunities.ts`**

```typescript
// src/hooks/useOpportunities.ts — open opportunities, sorted by net_apr desc.
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { Opportunity, OpportunityKind, OpportunityStatus } from '../types/domain'

export function useOpportunities() {
  const opts = useMemo(
    () => ({
      table: 'opportunities',
      select: 'id, detected_at, kind, base_symbol, gross_apr, net_apr, min_position_usd, status',
      channel: 'dash_opps',
      initialFilter: 'status=eq.open',
      map: (r: Record<string, unknown>): Opportunity => ({
        id: Number(r.id),
        detectedAt: String(r.detected_at),
        kind: r.kind as OpportunityKind,
        baseSymbol: String(r.base_symbol),
        grossApr: Number(r.gross_apr),
        netApr: Number(r.net_apr),
        minPositionUsd: Number(r.min_position_usd),
        status: r.status as OpportunityStatus,
      }),
      key: (d: Opportunity) => d.id,
      keep: (d: Opportunity) => d.status === 'open',
      sort: (a: Opportunity, b: Opportunity) => b.netApr - a.netApr,
    }),
    [],
  )
  return useRealtimeRows<Opportunity>(opts)
}
```

- [ ] **Step 3: Write `usePaperPositions.ts`**

```typescript
// src/hooks/usePaperPositions.ts — open/at_risk positions.
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { PaperPosition, PositionStatus } from '../types/domain'

function numOrNull(v: unknown): number | null { return v === null || v === undefined ? null : Number(v) }

export function usePaperPositions() {
  const opts = useMemo(
    () => ({
      table: 'paper_positions',
      select: 'id, opportunity_id, opened_at, closed_at, status, position_size_usd, leg_a_instrument_id, leg_a_side, leg_a_entry_price, leg_b_instrument_id, leg_b_side, leg_b_entry_price, cumulative_funding_usd, cumulative_fees_usd, realized_pnl_usd',
      channel: 'dash_positions',
      map: (r: Record<string, unknown>): PaperPosition => ({
        id: Number(r.id),
        opportunityId: numOrNull(r.opportunity_id),
        openedAt: String(r.opened_at),
        closedAt: (r.closed_at as string | null) ?? null,
        status: r.status as PositionStatus,
        positionSizeUsd: Number(r.position_size_usd),
        legAInstrumentId: Number(r.leg_a_instrument_id),
        legASide: r.leg_a_side as 'long' | 'short',
        legAEntryPrice: Number(r.leg_a_entry_price),
        legBInstrumentId: numOrNull(r.leg_b_instrument_id),
        legBSide: (r.leg_b_side as 'long' | 'short' | null) ?? null,
        legBEntryPrice: numOrNull(r.leg_b_entry_price),
        cumulativeFundingUsd: Number(r.cumulative_funding_usd),
        cumulativeFeesUsd: Number(r.cumulative_fees_usd),
        realizedPnlUsd: numOrNull(r.realized_pnl_usd),
      }),
      key: (d: PaperPosition) => d.id,
      keep: (d: PaperPosition) => d.status === 'open' || d.status === 'at_risk',
      sort: (a: PaperPosition, b: PaperPosition) => b.openedAt.localeCompare(a.openedAt),
    }),
    [],
  )
  return useRealtimeRows<PaperPosition>(opts)
}
```

- [ ] **Step 4: Write `usePnlSnapshots.ts`**

```typescript
// src/hooks/usePnlSnapshots.ts — all pnl snapshots (time-series for the curve + header).
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { PnlSnapshot } from '../types/domain'

function numOrNull(v: unknown): number | null { return v === null || v === undefined ? null : Number(v) }

export function usePnlSnapshots() {
  const opts = useMemo(
    () => ({
      table: 'pnl_snapshots',
      select: 'id, ts, position_id, unrealized_pnl_usd, realized_pnl_usd, cumulative_funding_usd, cumulative_fees_usd, leg_a_mark, leg_b_mark, liquidation_distance_bps',
      channel: 'dash_pnl',
      map: (r: Record<string, unknown>): PnlSnapshot => ({
        id: Number(r.id),
        ts: String(r.ts),
        positionId: numOrNull(r.position_id),
        unrealizedPnlUsd: Number(r.unrealized_pnl_usd),
        realizedPnlUsd: Number(r.realized_pnl_usd),
        cumulativeFundingUsd: Number(r.cumulative_funding_usd),
        cumulativeFeesUsd: Number(r.cumulative_fees_usd),
        legAMark: numOrNull(r.leg_a_mark),
        legBMark: numOrNull(r.leg_b_mark),
        liquidationDistanceBps: numOrNull(r.liquidation_distance_bps),
      }),
      key: (d: PnlSnapshot) => d.id,
      sort: (a: PnlSnapshot, b: PnlSnapshot) => a.ts.localeCompare(b.ts),
    }),
    [],
  )
  return useRealtimeRows<PnlSnapshot>(opts)
}
```

- [ ] **Step 5: Write `useExecutionLog.ts`**

```typescript
// src/hooks/useExecutionLog.ts — merged event stream: paper_fills + pnl risk flips.
// Returns newest-first ExecEvent[] for the virtualized log.
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { PaperFill, PnlSnapshot } from '../types/domain'

export interface ExecEvent {
  id: string
  ts: string
  kind: 'fill' | 'funding' | 'risk'
  text: string
}

function fillsHook() {
  return {
    table: 'paper_fills',
    select: 'id, position_id, ts, leg, side, action, instrument_id, price, size_usd, fee_usd, slippage_bps',
    channel: 'dash_fills',
    map: (r: Record<string, unknown>): PaperFill => ({
      id: Number(r.id),
      positionId: Number(r.position_id),
      ts: String(r.ts),
      leg: r.leg as 'a' | 'b',
      side: r.side as 'long' | 'short',
      action: r.action as 'open' | 'close',
      instrumentId: Number(r.instrument_id),
      price: Number(r.price),
      sizeUsd: Number(r.size_usd),
      feeUsd: Number(r.fee_usd),
      slippageBps: Number(r.slippage_bps),
    }),
    key: (d: PaperFill) => d.id,
  }
}

export function useExecutionLog(pnl: PnlSnapshot[]): { data: ExecEvent[]; isLoading: boolean; error: string | null } {
  const fillOpts = useMemo(fillsHook, [])
  const fills = useRealtimeRows<PaperFill>(fillOpts)

  const data = useMemo<ExecEvent[]>(() => {
    const fillEvents: ExecEvent[] = fills.data.map((f) => ({
      id: `fill-${f.id}`,
      ts: f.ts,
      kind: 'fill',
      text: `${f.action.toUpperCase()} leg ${f.leg.toUpperCase()} ${f.side} #${f.positionId} @ ${f.price} (fee $${f.feeUsd.toFixed(2)}, ${f.slippageBps}bps)`,
    }))
    // Risk events: a snapshot whose liq distance is tight (≤ at_risk band).
    const riskEvents: ExecEvent[] = pnl
      .filter((s) => s.liquidationDistanceBps !== null && (s.liquidationDistanceBps as number) <= 656) // ~0.2*d0 in bps
      .map((s) => ({
        id: `risk-${s.id}`,
        ts: s.ts,
        kind: 'risk',
        text: `RISK #${s.positionId} liq distance ${Math.round(s.liquidationDistanceBps as number)}bps · funding $${s.cumulativeFundingUsd.toFixed(2)}`,
      }))
    return [...fillEvents, ...riskEvents].sort((a, b) => b.ts.localeCompare(a.ts))
  }, [fills.data, pnl])

  return { data, isLoading: fills.isLoading, error: fills.error }
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/
git commit -m "feat(hooks): funding/opportunities/positions/pnl/exec-log domain hooks"
```

---

## Task 8: UI primitives (`Panel`, `Pill`, `EmptyState`)

**Files:**
- Create: `src/components/ui/Panel.tsx`, `src/components/ui/Pill.tsx`, `src/components/ui/EmptyState.tsx`

- [ ] **Step 1: Write `Panel.tsx`**

```tsx
// src/components/ui/Panel.tsx — titled card wrapper used by every dashboard panel.
import type { ReactNode } from 'react'

export function Panel({ title, right, children, className = '' }: {
  title: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-lg border border-white/10 bg-white/[0.02] p-4 ${className}`}>
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg/70">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  )
}
```

- [ ] **Step 2: Write `Pill.tsx`**

```tsx
// src/components/ui/Pill.tsx — small status/label chip.
import type { ReactNode } from 'react'

export function Pill({ children, tone = 'neutral' }: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'bad' | 'warn'
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-white/10 text-fg/80',
    good: 'bg-emerald-500/15 text-emerald-300',
    bad: 'bg-rose-500/15 text-rose-300',
    warn: 'bg-amber-500/15 text-amber-300',
  }
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${tones[tone]}`}>{children}</span>
}
```

- [ ] **Step 3: Write `EmptyState.tsx`**

```tsx
// src/components/ui/EmptyState.tsx — placeholder for panels whose data isn't flowing yet.
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-center text-sm text-fg/40">
      {message}
    </div>
  )
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm build`
Expected: exit 0.

```bash
git add src/components/ui/
git commit -m "feat(ui): Panel, Pill, EmptyState primitives"
```

---

## Task 9: `Header` panel

**Files:**
- Create: `src/components/Header.tsx`

- [ ] **Step 1: Write `Header.tsx`**

```tsx
// src/components/Header.tsx — portfolio P&L + open count + last update (SPEC §7).
import type { PaperPosition, PnlSnapshot } from '../types/domain'
import { fmtSignedUsd, fmtRelTime } from '../lib/format'

// Latest snapshot per position.
function latestByPosition(snaps: PnlSnapshot[]): Map<number, PnlSnapshot> {
  const m = new Map<number, PnlSnapshot>()
  for (const s of snaps) {
    if (s.positionId === null) continue
    const cur = m.get(s.positionId)
    if (!cur || s.ts > cur.ts) m.set(s.positionId, s)
  }
  return m
}

export function Header({ positions, pnl }: { positions: PaperPosition[]; pnl: PnlSnapshot[] }) {
  const latest = latestByPosition(pnl)
  let total = 0
  for (const p of positions) {
    if (p.status === 'closed' || p.status === 'liquidated_paper') {
      total += p.realizedPnlUsd ?? 0
    } else {
      const s = latest.get(p.id)
      total += (s?.unrealizedPnlUsd ?? 0) + p.cumulativeFundingUsd - p.cumulativeFeesUsd
    }
  }
  const openCount = positions.filter((p) => p.status === 'open' || p.status === 'at_risk').length
  const lastTs = pnl.length ? pnl[pnl.length - 1].ts : null

  return (
    <header className="flex flex-wrap items-baseline justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.02] px-5 py-4">
      <h1 className="text-xl font-semibold">
        Funding-Arb <span className="text-magenta">·</span> <span className="text-cyan">paper only</span>
      </h1>
      <div className="flex items-baseline gap-6 text-sm">
        <span>
          Portfolio P&L{' '}
          <strong className={total >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{fmtSignedUsd(total)}</strong>
        </span>
        <span>Open <strong>{openCount}</strong></span>
        <span className="text-fg/60">Updated {fmtRelTime(lastTs)}</span>
      </div>
    </header>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`
Expected: exit 0.

```bash
git add src/components/Header.tsx
git commit -m "feat(dash): Header panel (portfolio P&L + open count + last update)"
```

---

## Task 10: `FundingHeatmap` panel

**Files:**
- Create: `src/components/FundingHeatmap.tsx`

- [ ] **Step 1: Write `FundingHeatmap.tsx`**

```tsx
// src/components/FundingHeatmap.tsx — CSS grid rows=base symbol, cols=venue.
// Color = signed 1h-APR (heatmap.ts); cell size rank = open interest. SPEC §7.
import { useMemo } from 'react'
import type { LatestFunding, VenueId } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { aprColor, oiSizeRank } from '../lib/heatmap'
import { fmtApr } from '../lib/format'

const VENUES: VenueId[] = ['hyperliquid', 'okx', 'binance_futures', 'bybit']
const VENUE_LABEL: Record<VenueId, string> = {
  hyperliquid: 'HL', okx: 'OKX', binance_futures: 'BIN', bybit: 'BYB',
}
const SIZE_OPACITY = [0.35, 0.6, 0.8, 1]

export function FundingHeatmap({ rows }: { rows: LatestFunding[] }) {
  const { symbols, cell } = useMemo(() => {
    const cellMap = new Map<string, LatestFunding>()
    const syms = new Set<string>()
    for (const r of rows) {
      syms.add(r.baseSymbol)
      cellMap.set(`${r.baseSymbol}|${r.venueId}`, r)
    }
    return { symbols: [...syms].sort(), cell: cellMap }
  }, [rows])

  if (!rows.length) return <Panel title="Funding Heatmap"><EmptyState message="Waiting for funding snapshots…" /></Panel>

  return (
    <Panel title="Funding Heatmap">
      <div className="grid gap-1 text-xs" style={{ gridTemplateColumns: `4rem repeat(${VENUES.length}, 1fr)` }}>
        <div />
        {VENUES.map((v) => <div key={v} className="text-center text-fg/60">{VENUE_LABEL[v]}</div>)}
        {symbols.map((sym) => (
          <FragmentRow key={sym} sym={sym} cell={cell} />
        ))}
      </div>
    </Panel>
  )
}

function FragmentRow({ sym, cell }: { sym: string; cell: Map<string, LatestFunding> }) {
  return (
    <>
      <div className="flex items-center font-medium text-fg/80">{sym}</div>
      {VENUES.map((v) => {
        const c = cell.get(`${sym}|${v}`)
        const color = aprColor(c ? c.fundingRate1hApr : null)
        const opacity = c ? SIZE_OPACITY[oiSizeRank(c.openInterestUsd)] : 0
        return (
          <div
            key={v}
            title={c ? `${sym} ${VENUE_LABEL[v]} ${fmtApr(c.fundingRate1hApr)} · next ${c.nextFundingTs ?? '—'}` : 'no data'}
            className="flex h-8 items-center justify-center rounded"
            style={{ backgroundColor: color === 'transparent' ? 'rgba(255,255,255,0.03)' : color, opacity: c ? opacity : 1 }}
          >
            {c ? <span className="text-[10px] text-black/70">{fmtApr(c.fundingRate1hApr)}</span> : ''}
          </div>
        )
      })}
    </>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`
Expected: exit 0.

```bash
git add src/components/FundingHeatmap.tsx
git commit -m "feat(dash): FundingHeatmap (CSS grid, APR color, OI size)"
```

---

## Task 11: `AprLeaderboard` panel

**Files:**
- Create: `src/components/AprLeaderboard.tsx`

- [ ] **Step 1: Write `AprLeaderboard.tsx`**

```tsx
// src/components/AprLeaderboard.tsx — sortable table: symbol | venue | apr | next funding.
import { useMemo, useState } from 'react'
import type { LatestFunding } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { fmtApr, fmtRelTime } from '../lib/format'

type SortKey = 'apr' | 'symbol'

export function AprLeaderboard({ rows }: { rows: LatestFunding[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('apr')
  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) =>
      sortKey === 'apr'
        ? Math.abs(b.fundingRate1hApr) - Math.abs(a.fundingRate1hApr)
        : a.baseSymbol.localeCompare(b.baseSymbol),
    )
    return copy
  }, [rows, sortKey])

  if (!rows.length) return <Panel title="APR Leaderboard"><EmptyState message="Waiting for funding snapshots…" /></Panel>

  return (
    <Panel
      title="APR Leaderboard"
      right={
        <button className="text-xs text-cyan hover:underline" onClick={() => setSortKey(sortKey === 'apr' ? 'symbol' : 'apr')}>
          sort: {sortKey}
        </button>
      }
    >
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg/80 text-fg/50">
            <tr><th className="py-1">Symbol</th><th>Venue</th><th className="text-right">1h APR</th><th className="text-right">Next</th></tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.instrumentId} className="border-t border-white/5">
                <td className="py-1 font-medium">{r.baseSymbol}</td>
                <td className="text-fg/70">{r.venueId.replace('_futures', '')}</td>
                <td className={`text-right ${r.fundingRate1hApr >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtApr(r.fundingRate1hApr)}</td>
                <td className="text-right text-fg/50">{fmtRelTime(r.nextFundingTs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`
Expected: exit 0.

```bash
git add src/components/AprLeaderboard.tsx
git commit -m "feat(dash): AprLeaderboard sortable table"
```

---

## Task 12: `OpportunityTable` panel (+ Paper-trade CTA)

**Files:**
- Create: `src/components/OpportunityTable.tsx`

- [ ] **Step 1: Write `OpportunityTable.tsx`**

```tsx
// src/components/OpportunityTable.tsx — open opportunities, sortable, with paper-trade CTA.
import { useState } from 'react'
import type { Opportunity } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { Pill } from './ui/Pill'
import { fmtApr } from '../lib/format'
import { openPaperPosition } from '../lib/api'

export function OpportunityTable({ rows }: { rows: Opportunity[] }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function trade(id: number) {
    setBusy(id); setErr(null)
    try { await openPaperPosition(id) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  if (!rows.length) return <Panel title="Opportunities"><EmptyState message="No open opportunities clearing the detect bar." /></Panel>

  return (
    <Panel title="Opportunities" right={err ? <span className="text-xs text-rose-300">{err}</span> : undefined}>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg/80 text-fg/50">
            <tr><th className="py-1">Symbol</th><th>Kind</th><th className="text-right">Net APR</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t border-white/5">
                <td className="py-1 font-medium">{o.baseSymbol}</td>
                <td><Pill tone={o.kind === 'cross_venue_basis_arb' ? 'warn' : 'neutral'}>{o.kind === 'cross_venue_basis_arb' ? 'cross' : 'single'}</Pill></td>
                <td className="text-right text-emerald-300">{fmtApr(o.netApr)}</td>
                <td className="text-right">
                  <button
                    disabled={busy === o.id}
                    onClick={() => trade(o.id)}
                    className="rounded bg-magenta/20 px-2 py-0.5 text-magenta hover:bg-magenta/30 disabled:opacity-40"
                  >
                    {busy === o.id ? '…' : 'Paper-trade'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`
Expected: exit 0.

```bash
git add src/components/OpportunityTable.tsx
git commit -m "feat(dash): OpportunityTable + paper-trade CTA"
```

---

## Task 13: `PaperPositions` panel (+ Close CTA)

**Files:**
- Create: `src/components/PaperPositions.tsx`

- [ ] **Step 1: Write `PaperPositions.tsx`**

```tsx
// src/components/PaperPositions.tsx — open/at_risk positions w/ live P&L + close CTA.
import { useMemo, useState } from 'react'
import type { PaperPosition, PnlSnapshot } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { Pill } from './ui/Pill'
import { fmtSignedUsd, fmtBps } from '../lib/format'
import { closePaperPosition } from '../lib/api'

function latestByPosition(snaps: PnlSnapshot[]): Map<number, PnlSnapshot> {
  const m = new Map<number, PnlSnapshot>()
  for (const s of snaps) {
    if (s.positionId === null) continue
    const cur = m.get(s.positionId)
    if (!cur || s.ts > cur.ts) m.set(s.positionId, s)
  }
  return m
}

export function PaperPositions({ positions, pnl }: { positions: PaperPosition[]; pnl: PnlSnapshot[] }) {
  const latest = useMemo(() => latestByPosition(pnl), [pnl])
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function close(id: number) {
    setBusy(id); setErr(null)
    try { await closePaperPosition(id) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  if (!positions.length) return <Panel title="Paper Positions"><EmptyState message="No paper positions yet — engine deploys soon." /></Panel>

  return (
    <Panel title="Paper Positions" right={err ? <span className="text-xs text-rose-300">{err}</span> : undefined}>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg/80 text-fg/50">
            <tr><th className="py-1">#</th><th>Status</th><th className="text-right">Unreal.</th><th className="text-right">Funding</th><th className="text-right">Liq dist</th><th /></tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const s = latest.get(p.id)
              const unreal = s?.unrealizedPnlUsd ?? 0
              return (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="py-1">{p.id}</td>
                  <td><Pill tone={p.status === 'at_risk' ? 'warn' : 'good'}>{p.status}</Pill></td>
                  <td className={`text-right ${unreal >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtSignedUsd(unreal)}</td>
                  <td className="text-right text-fg/80">{fmtSignedUsd(p.cumulativeFundingUsd)}</td>
                  <td className="text-right text-fg/60">{fmtBps(s?.liquidationDistanceBps ?? null)}</td>
                  <td className="text-right">
                    <button disabled={busy === p.id} onClick={() => close(p.id)} className="rounded bg-rose-500/20 px-2 py-0.5 text-rose-300 hover:bg-rose-500/30 disabled:opacity-40">
                      {busy === p.id ? '…' : 'Close'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`
Expected: exit 0.

```bash
git add src/components/PaperPositions.tsx
git commit -m "feat(dash): PaperPositions panel + close CTA"
```

---

## Task 14: `PnlCurve` panel

**Files:**
- Create: `src/components/PnlCurve.tsx`

- [ ] **Step 1: Write `PnlCurve.tsx`**

```tsx
// src/components/PnlCurve.tsx — cumulative portfolio P&L over time, 4 series (SPEC §7).
// recharts is the ONLY charting lib (CLAUDE.md). Aggregates pnl_snapshots across
// positions per timestamp into portfolio totals.
import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts'
import type { PnlSnapshot } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'

interface Point { ts: number; realized: number; unrealized: number; funding: number; fees: number }

// Sum the latest-known value per position at each snapshot timestamp (step-forward).
function buildSeries(snaps: PnlSnapshot[]): Point[] {
  const byTs = new Map<string, PnlSnapshot[]>()
  for (const s of snaps) {
    const arr = byTs.get(s.ts) ?? []
    arr.push(s)
    byTs.set(s.ts, arr)
  }
  const latestPerPos = new Map<number, PnlSnapshot>()
  const points: Point[] = []
  for (const ts of [...byTs.keys()].sort()) {
    for (const s of byTs.get(ts)!) if (s.positionId !== null) latestPerPos.set(s.positionId, s)
    let realized = 0, unrealized = 0, funding = 0, fees = 0
    for (const s of latestPerPos.values()) {
      realized += s.realizedPnlUsd; unrealized += s.unrealizedPnlUsd
      funding += s.cumulativeFundingUsd; fees += s.cumulativeFeesUsd
    }
    points.push({ ts: new Date(ts).getTime(), realized, unrealized, funding, fees: -fees })
  }
  return points
}

export function PnlCurve({ pnl }: { pnl: PnlSnapshot[] }) {
  const data = useMemo(() => buildSeries(pnl), [pnl])
  if (!data.length) return <Panel title="P&L Curve"><EmptyState message="No P&L snapshots yet — engine deploys soon." /></Panel>

  return (
    <Panel title="P&L Curve">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time"
              tickFormatter={(t) => new Date(t).toLocaleDateString()} stroke="#6b7280" fontSize={11} />
            <YAxis stroke="#6b7280" fontSize={11} tickFormatter={(v) => `$${v}`} />
            <Tooltip contentStyle={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.1)' }}
              labelFormatter={(t) => new Date(t as number).toLocaleString()} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="unrealized" name="Unrealized" stroke="#22d3ee" dot={false} />
            <Line type="monotone" dataKey="realized" name="Realized" stroke="#e879f9" dot={false} />
            <Line type="monotone" dataKey="funding" name="Funding" stroke="#34d399" dot={false} />
            <Line type="monotone" dataKey="fees" name="Fees" stroke="#fb7185" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`
Expected: exit 0.

```bash
git add src/components/PnlCurve.tsx
git commit -m "feat(dash): PnlCurve (recharts, 4 portfolio series)"
```

---

## Task 15: `ExecutionLog` panel

**Files:**
- Create: `src/components/ExecutionLog.tsx`

- [ ] **Step 1: Write `ExecutionLog.tsx`**

```tsx
// src/components/ExecutionLog.tsx — virtualized newest-top event stream (SPEC §7).
import { FixedSizeList } from 'react-window'
import type { ExecEvent } from '../hooks/useExecutionLog'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'

const TONE: Record<ExecEvent['kind'], string> = { fill: 'text-fg/80', funding: 'text-emerald-300', risk: 'text-amber-300' }

export function ExecutionLog({ events }: { events: ExecEvent[] }) {
  if (!events.length) return <Panel title="Execution Log"><EmptyState message="No fills or risk events yet." /></Panel>

  return (
    <Panel title="Execution Log">
      <FixedSizeList height={220} itemCount={events.length} itemSize={22} width="100%">
        {({ index, style }) => {
          const e = events[index]
          return (
            <div style={style} className={`flex gap-3 font-mono text-[11px] ${TONE[e.kind]}`}>
              <span className="text-fg/40">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="truncate">{e.text}</span>
            </div>
          )
        }}
      </FixedSizeList>
    </Panel>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm build`
Expected: exit 0.

```bash
git add src/components/ExecutionLog.tsx
git commit -m "feat(dash): ExecutionLog (react-window virtualized)"
```

---

## Task 16: `App.tsx` grid assembly

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace `App.tsx`**

```tsx
// src/App.tsx — 12-col dashboard grid (SPEC §7). Each panel owns its own data hook.
import { useFundingSnapshots } from './hooks/useFundingSnapshots'
import { useOpportunities } from './hooks/useOpportunities'
import { usePaperPositions } from './hooks/usePaperPositions'
import { usePnlSnapshots } from './hooks/usePnlSnapshots'
import { useExecutionLog } from './hooks/useExecutionLog'
import { Header } from './components/Header'
import { FundingHeatmap } from './components/FundingHeatmap'
import { AprLeaderboard } from './components/AprLeaderboard'
import { OpportunityTable } from './components/OpportunityTable'
import { PaperPositions } from './components/PaperPositions'
import { PnlCurve } from './components/PnlCurve'
import { ExecutionLog } from './components/ExecutionLog'

export default function App() {
  const funding = useFundingSnapshots()
  const opps = useOpportunities()
  const positions = usePaperPositions()
  const pnl = usePnlSnapshots()
  const exec = useExecutionLog(pnl.data)

  return (
    <div className="min-h-screen bg-bg p-4 text-fg">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <Header positions={positions.data} pnl={pnl.data} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <FundingHeatmap rows={funding.data} />
          <AprLeaderboard rows={funding.data} />
          <OpportunityTable rows={opps.data} />
          <PaperPositions positions={positions.data} pnl={pnl.data} />
        </div>
        <PnlCurve pnl={pnl.data} />
        <ExecutionLog events={exec.data} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + lint + build**

Run: `pnpm lint && pnpm build`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(dash): assemble 12-col dashboard grid in App.tsx"
```

---

## Task 17: `config.toml` verify_jwt + `session-4-ops.sql`

**Files:**
- Modify: `supabase/config.toml`
- Create: `session-4-ops.sql`

- [ ] **Step 1: Add verify_jwt overrides to `config.toml`** (append at end)

```toml
# Browser-invoked paper CTAs: the anon client must reach these (CLAUDE.md hard rule
# #2 keeps the service key server-side; the fn uses its own env key for writes).
[functions.open-paper-position]
verify_jwt = false

[functions.close-paper-position]
verify_jwt = false
```

- [ ] **Step 2: Write `session-4-ops.sql`**

```sql
-- Session 4 ops — RUN BY NICK in the Supabase SQL editor (Frankfurt project
-- lfgmqpeaicqygzfgystu). Idempotent. Makes the execution log fully live by adding
-- paper_fills to the realtime publication (Session 1 added the other four tables).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'paper_fills'
  ) then
    alter publication supabase_realtime add table public.paper_fills;
  end if;
end $$;

-- Verify:
--   select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1;
```

- [ ] **Step 3: Commit**

```bash
git add supabase/config.toml session-4-ops.sql
git commit -m "feat(dash): verify_jwt=false for paper CTAs + session-4-ops.sql (paper_fills realtime)"
```

---

## Task 18: Verify, push, PR, vault + memory

**Files:**
- Modify: `~/Funding-ARB-Vault/Reference/Codebase Map.md`, vault Decisions, project memory.

- [ ] **Step 1: Full verification**

Run: `cd ~/funding-arb && pnpm test && pnpm lint && pnpm build`
Expected: tests pass (math + normalize + detect + pnl + **format + heatmap**), lint exit 0, build exit 0.

- [ ] **Step 2: Secret-safety scan**

Run:
```bash
git grep -nE 'eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}' -- . ':(exclude).env*' || echo "OK no JWT"
grep -E '^VITE_.*(SERVICE|SECRET)' .env.local && echo "DANGER: admin key VITE-prefixed" || echo "OK no admin key in VITE_"
```
Expected: no JWT in tree; no service key under a `VITE_` name (CLAUDE.md gotcha 3).

- [ ] **Step 3: Push the branch**

```bash
git push -u origin session-4-dashboard
```

- [ ] **Step 4: Open a PR** (stacked on Session 3)

```bash
gh pr create --base session-3-paper-engine --head session-4-dashboard \
  --title "Session 4: dashboard" \
  --body "Dashboard (SPEC §7): 6 panels over live HL×OKX ingestion/detector + paper-position/P&L/exec panels (empty-state until engine deploys). Pure format/heatmap libs (TDD); shared useRealtimeRows + 5 domain hooks; anon-bearer api.ts; config.toml verify_jwt=false for CTAs; session-4-ops.sql adds paper_fills to realtime. Stacked on Session 3 — rebase onto main after #1/#2 merge."
```

- [ ] **Step 5: Update the vault** — new Decision `Decisions/0006 — Session 4 dashboard.md` (panels, anon-CTA auth, empty-state strategy, deploy needs Netlify→Frankfurt + config.toml redeploy + session-4-ops.sql) + `Reference/Codebase Map.md` (move dashboard components/hooks into Frontend, bump test count, mark Session 4 BUILT) + a `2026-06-08` journal note + the `funding-arb-project` memory (Session 4 BUILT, not deployed; deploy = Netlify env→Frankfurt + redeploy 2 fns verify_jwt + run session-4-ops.sql).

- [ ] **Step 6: Confirm done** — report PR URL + the Nick-run deploy checklist.

---

## Self-Review notes
- **Spec coverage:** Header (T9), Funding Heatmap (T10), APR Leaderboard (T11), Opportunity Table + CTA (T12), Paper Positions + Close (T13), P&L Curve (T14), Execution Log (T15), 12-col grid (T16); anon-CTA auth (T5 + T17 verify_jwt); per-panel realtime (T6/T7); paper_fills realtime (T17); empty states (T8 EmptyState used in every data-dependent panel); pure libs tested (T3/T4). All SPEC §7 + design-doc sections mapped.
- **Type consistency:** `LatestFunding`/`PaperPosition`/`PnlSnapshot`/`PaperFill`/`PositionStatus` defined once (T2) and consumed by hooks (T7) + components (T9–T15) with matching field names. `ExecEvent` defined in `useExecutionLog` (T7) and imported by `ExecutionLog` (T15). `useRealtimeRows<TDomain>` Options shape (T6) matches every hook's call (T7).
- **No UI tests** by design (CLAUDE.md) — only `format.ts`/`heatmap.ts` are TDD; component tasks verify via `pnpm build`/`lint`.
- **Known runtime note:** realtime hooks refetch-on-change (small tables, v1) — simple + correct; optimize later only if row counts grow. `react-window`/`recharts`/`d3-scale-chromatic` are the pre-approved deps (T1).
- **Deploy is Nick-run:** Netlify env → Frankfurt, redeploy the 2 CTAs (verify_jwt), run `session-4-ops.sql`. Dashboard renders empty position/P&L/exec panels until the S3 engine is also deployed.
```
