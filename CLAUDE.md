# Claude Code Project Rules — Funding-Rate Arb Scanner

This file tells Claude Code how to work on this repo. Read it before doing anything.

---

## Identity & context

- **Owner:** Nick Vandam, full-stack developer with a strong React/Vite/Supabase background.
- **Goal:** Build a funding-rate arbitrage scanner + paper-trade engine. PAPER ONLY in v1.
- **Reference docs:** `SPEC.md` (what to build), `api-notes.md` (how the venues work), `acceptance.md` (definition of done).

---

## Hard rules — never violate

1. **No real-money trading code paths in v1.** Do not import or call any venue's trade/order/CLOB endpoints. Funding-rate, market-data, and public reference endpoints only. If you find yourself writing a signed order request, stop and ask.
2. **No private keys, API keys, or wallet seeds in the repo.** Ever. Not in `.env`, not in comments, not in tests. If a venue needs auth for something we want, that's a signal we're going outside v1 scope.
3. **No `npm install` of HFT libraries.** No `ccxt` (kitchen-sink, slow), no `kucoin-node-sdk`, no exchange SDKs. We hit REST endpoints with `fetch`. Edge Functions are tiny.
4. **No raw funding-rate comparisons across venues.** Always normalize to APR first. Hyperliquid funds hourly; Binance funds 8-hourly. Comparing the raw numbers is the #1 source of bugs in this domain.
5. **No `any` in TypeScript.** Use `zod` schemas to parse venue responses; let the schema define the type.
6. **No skipping the math tests.** `lib/math.ts` and `lib/normalize.ts` must have unit tests before they're used in an Edge Function.
7. **No silent retries on venue API errors.** Log the venue + endpoint + status code. Fail loud; the cron will retry on the next tick.

---

## Stack — use exactly this, do not deviate

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS v4. No CSS modules, no styled-components.
- **Charts:** `recharts` — the **only** charting library (used for the P&L curve). No other charting lib (no `visx`, no `chart.js`, etc.). The funding heatmap is a hand-rolled CSS grid.
- **Backend:** Supabase (Postgres + Edge Functions + Realtime). No separate API server.
- **Cron:** Supabase scheduled Edge Functions (`pg_cron` under the hood).
- **Hosting:** Netlify for the SPA. Supabase hosts the Edge Functions.
- **Schema validation:** `zod` for all venue response parsing.
- **Dates:** `date-fns`. Never raw `Date` arithmetic.
- **Lint/format:** ESLint + Prettier with default Vite-React-TS config.
- **Package manager:** `pnpm` (faster, lockfile is cleaner for review).
- **Approved additional deps (the ONLY additions allowed beyond the stack above):**
  - `d3-scale-chromatic` — diverging color palette for the hand-rolled funding heatmap (SPEC §7). Palette/scale math only; it is **not** a charting/rendering lib and does not relax the "recharts is the only charting lib" rule.
  - `react-window` — virtualizes the execution log (SPEC §7), which grows fast.
  - Anything else — including any other charting lib (e.g. `visx`) — still requires asking first (see the escalation path).

---

## File & folder layout

```
funding-arb/
├── CLAUDE.md                 (this file)
├── SPEC.md
├── api-notes.md
├── acceptance.md
├── schema.sql                (run this in Supabase SQL editor)
├── seed_instruments.json     (instruments to track per venue)
├── .env.example
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── index.html
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── lib/
│   │   ├── supabase.ts       (singleton client)
│   │   ├── math.ts           (funding APR + arb math, PURE)
│   │   ├── math.test.ts
│   │   ├── normalize.ts      (venue payload → common shape)
│   │   └── normalize.test.ts
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── FundingHeatmap.tsx
│   │   ├── AprLeaderboard.tsx
│   │   ├── OpportunityTable.tsx
│   │   ├── PaperPositions.tsx
│   │   ├── PnlCurve.tsx
│   │   ├── ExecutionLog.tsx
│   │   └── ui/               (reusable bits: Panel, Pill, etc.)
│   ├── hooks/
│   │   ├── useFundingSnapshots.ts
│   │   ├── useOpportunities.ts
│   │   └── usePaperPositions.ts
│   └── types/
│       └── domain.ts         (FundingSnapshot, Opportunity, etc.)
└── supabase/
    └── functions/
        ├── ingest-hyperliquid/index.ts
        ├── ingest-binance/index.ts
        ├── ingest-bybit/index.ts
        ├── ingest-okx/index.ts
        ├── detect-opportunities/index.ts
        ├── snapshot-pnl/index.ts
        ├── open-paper-position/index.ts
        └── close-paper-position/index.ts
```

---

## Coding conventions

- **Components**: functional, `PascalCase`, one component per file.
- **Hooks**: `useThing.ts`, return a `{ data, isLoading, error }` shape consistent across hooks.
- **Edge Functions**: each one is a single `index.ts` exporting a Deno `serve(...)`. Keep them under 200 lines. Pull shared logic into `lib/` and import.
- **Naming**:
  - Tables: snake_case (`funding_snapshots`)
  - TS types: PascalCase (`FundingSnapshot`)
  - Functions: camelCase (`computeNetApr`)
  - Constants: SCREAMING_SNAKE (`MIN_OPPORTUNITY_APR`)
- **Comments**: only when the *why* is non-obvious. Don't restate the code. DO document any place where a venue quirk forces unusual logic (link to `api-notes.md` section).
- **Errors**: throw `Error` with descriptive messages in libs. In Edge Functions, catch at the top level, log structured JSON, return 500.

---

## Realtime subscription pattern

Always subscribe in a `useEffect`, always unsubscribe in cleanup. Use a single channel per table per component.

```ts
useEffect(() => {
  const channel = supabase
    .channel('funding_snapshots_changes')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'funding_snapshots' },
      (payload) => { /* update local state */ })
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}, [])
```

---

## Testing approach

- **Pure math + normalization**: unit tests (Vitest), required.
- **Edge Functions**: smoke test locally with `supabase functions serve`, hit them with `curl`, verify rows land. No mocked venue HTTP in v1 — we want to see real shape changes when a venue updates its API.
- **UI**: no unit tests in v1. We're shipping a dashboard, not a library. Eyeball it, deploy preview to Netlify, share with Nick.

---

## Environment variables

`.env.example` should be committed with placeholders. Real values go in `.env.local` (gitignored) and in the Supabase project secrets for Edge Functions.

Required:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (Edge Functions only — never in the browser)

Optional (for v2 only — do not use in v1):
- `HYPERLIQUID_WALLET_ADDRESS`
- `HYPERLIQUID_PRIVATE_KEY` ← if you see this being read in v1 code, that's a bug

---

## Build order — follow the sessions in SPEC.md §8

Each session ends with a working deploy to Netlify (even if some panels are empty). Don't go deep on session 4 before sessions 1-3 are landing data.

---

## When stuck — escalation path

If you hit any of these, stop and ask Nick:

1. A venue API has changed shape from what's in `api-notes.md`
2. The math in `SPEC.md §5` doesn't match what you're seeing in real data
3. Supabase Realtime + Edge Function quotas are looking tight (free tier limits)
4. You're tempted to add a venue, library, or dependency not listed in this file (the **only** pre-approved additions are `d3-scale-chromatic` and `react-window`, listed under Stack)

Do NOT push through and "make it work" — the cost of fixing a bad architectural decision later is much higher than the 5 minutes of asking now.
