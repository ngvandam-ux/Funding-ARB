# Session 4 — Dashboard Design

**Goal:** Build the v1 dashboard (SPEC §7) — the read-only funding/opportunity view that's
live now (HL×OKX) plus the paper-position / P&L / execution panels that light up once the
Session 3 engine deploys. After this ships and the engine deploys, the 30-day +EV run is
fully observable.

**Spec authority:** `SPEC.md §7` (panels, 12-col layout, theme) + `CLAUDE.md` (stack, file
layout, realtime pattern, "no UI unit tests" rule). This doc reconciles SPEC §7 with the
current repo state and records the decisions made in brainstorming (2026-06-08).

**Stack (fixed, CLAUDE.md):** React 18 + TS + Vite + Tailwind v4, `recharts` (only charting
lib), hand-rolled CSS-grid heatmap with `d3-scale-chromatic` palette, `react-window` for the
execution log, Supabase JS (anon-only in the browser), `date-fns`, zod. pnpm.

---

## Decisions (brainstorming 2026-06-08)

1. **All 6 panels this session** (Header, Funding Heatmap, APR Leaderboard, Opportunity Table,
   Paper Positions, P&L Curve, Execution Log). Read-only panels have live data; position/P&L/
   exec panels render empty-states until the S3 engine deploys.
2. **Keep the manual open/close CTAs** (SPEC §6.1) alongside S3 auto-open. Browser is anon-only
   (CLAUDE.md hard rule #2) → the two invokable fns are deployed `verify_jwt = false` so the
   anon client can call them; each fn uses its OWN env `SERVICE_ROLE_KEY` for writes. Service
   key never reaches the browser.
3. **Deliverable cadence:** spec → plan → (user reviews plan) → execute in a fresh session.
4. **Risk events in the exec log** are derived from `pnl_snapshots` status transitions
   (open→at_risk, →liquidated_paper). No separate events table.
5. **`verify_jwt` declared in `config.toml`** (committed, declarative) — not a hidden
   `--no-verify-jwt` deploy flag.
6. **Heatmap shows only symbols with live data** (HL×OKX). Binance/Bybit render as empty
   columns (geo-blocked — see Decision 0004); honest about coverage.

---

## Architecture / file layout (matches CLAUDE.md)

```
src/
├── App.tsx                      # 12-col CSS grid, assembles panels
├── lib/
│   ├── supabase.ts              # anon-only singleton (EXISTS, unchanged)
│   ├── api.ts                   # (new) openPaperPosition / closePaperPosition — POST to edge fns
│   ├── heatmap.ts (+ .test.ts)  # (new) PURE: APR → diverging color, cell-size scale
│   └── format.ts (+ .test.ts)   # (new) PURE: $ / %, signed APR, relative-time formatters
├── hooks/
│   ├── useFundingSnapshots.ts   # latest_funding + realtime funding_snapshots
│   ├── useOpportunities.ts      # opportunities (status=open), realtime
│   ├── usePaperPositions.ts     # paper_positions (open/at_risk), realtime
│   ├── usePnlSnapshots.ts       # pnl_snapshots, realtime → P&L series + portfolio totals
│   └── useExecutionLog.ts       # paper_fills + pnl_snapshots merged stream, realtime
├── components/
│   ├── Header.tsx
│   ├── FundingHeatmap.tsx
│   ├── AprLeaderboard.tsx
│   ├── OpportunityTable.tsx
│   ├── PaperPositions.tsx
│   ├── PnlCurve.tsx
│   ├── ExecutionLog.tsx
│   └── ui/ { Panel.tsx, Pill.tsx, EmptyState.tsx }
└── types/domain.ts              # ADD PaperPosition, PnlSnapshot, PaperFill, LatestFunding
```

Plus repo-root `session-4-ops.sql` (Nick-run): `alter publication supabase_realtime add table
public.paper_fills;` so the exec log is fully live. `supabase/config.toml`: `verify_jwt = false`
for `open-paper-position` + `close-paper-position`.

### Unit boundaries
- **Pure libs** (`heatmap.ts`, `format.ts`) — no I/O, Vitest-tested. Color/size math + formatting.
- **Hooks** — single responsibility, uniform `{ data, isLoading, error }`, own exactly one
  Realtime channel each, unsubscribe on cleanup (CLAUDE.md pattern). One table (or view) per hook.
- **Components** — presentational; take data + callbacks as props; no direct Supabase calls
  except via hooks/`api.ts`. Untested per CLAUDE.md (eyeball + Netlify preview).
- **`api.ts`** — the only module that calls edge functions; isolates the anon-bearer detail.

---

## Data layer & Realtime

Realtime publication (schema.sql §179) currently covers `funding_snapshots`, `opportunities`,
`paper_positions`, `pnl_snapshots`. **`paper_fills` is NOT in it** → `session-4-ops.sql` adds it.

Each panel subscribes to its own channel (SPEC §7: no global event bus). Pattern: initial
`select` for the seed rows, then a `postgres_changes` subscription that patches local state;
`removeChannel` on unmount.

| Panel | Source | Realtime channel | Notes |
|---|---|---|---|
| Header | `pnl_snapshots` (latest per position) + `paper_positions` | pnl_snapshots | portfolio P&L = Σ over open positions of (latest unrealized + cumulative_funding − cumulative_fees) + Σ closed positions' realized_pnl_usd; plus open-position count + last-update ts |
| Funding Heatmap | `latest_funding` view | funding_snapshots | rows=base_symbol, cols=venue; color=signed 1h-APR; size=OI |
| APR Leaderboard | `latest_funding` view | funding_snapshots | sortable; row→scroll/hl matching opportunity |
| Opportunity Table | `opportunities` where status=open | opportunities | A+B mixed, sortable by net_apr; "Paper-trade" CTA |
| Paper Positions | `paper_positions` in (open, at_risk) | paper_positions | live unrealized (latest pnl_snapshot), liq distance, cum funding; Close CTA |
| P&L Curve | `pnl_snapshots` (time-series) | pnl_snapshots | recharts; 4 lines realized / unrealized / funding-only / fees-only |
| Execution Log | `paper_fills` ∪ `pnl_snapshots` (risk flips) | paper_fills + pnl_snapshots | react-window virtualized, monospace, newest-top |

**Empty states:** position / P&L / exec panels show `EmptyState` ("No paper positions yet —
engine deploys soon") while their tables are empty. Heatmap / leaderboard / opportunities are
live immediately off the running ingestion + detector.

---

## Manual CTA auth path

`lib/api.ts`:
```
POST ${VITE_SUPABASE_URL}/functions/v1/open-paper-position
  headers: { apikey: <anon>, Authorization: Bearer <anon>, Content-Type: application/json }
  body: { opportunityId }            // sizeUsd omitted → fn default $1000/leg
POST .../close-paper-position  body: { positionId }
```
Works because the two fns are deployed `verify_jwt = false`; they build their service-role
client from their own `SUPABASE_SERVICE_ROLE_KEY` env (already set in the project). The anon key
is the public browser key — safe to ship. On non-2xx, surface the fn's `{error}` JSON in a toast/
inline error; the optimistic row reconciles via the Realtime update.

---

## Deploy (Nick-run)

- App auto-deploys to **Netlify** from `main` (prod) / deploy-preview on the feature branch.
- **Open item:** Netlify env → Frankfurt (`VITE_SUPABASE_URL=https://lfgmqpeaicqygzfgystu.supabase.co`,
  `VITE_SUPABASE_ANON_KEY=<frankfurt anon>`). Without this the dashboard reads the dead project.
- Redeploy the two invokable fns after `config.toml` `verify_jwt` change:
  `supabase functions deploy open-paper-position close-paper-position`.
- Run `session-4-ops.sql` once (adds paper_fills to the realtime publication).

---

## Testing (CLAUDE.md)

- **Pure libs only:** `heatmap.ts`, `format.ts` get Vitest tests (color thresholds, sign,
  formatting edge cases). These are the bug-prone parts.
- **No component/hook unit tests** in v1 — eyeball locally (`pnpm dev`) against live Frankfurt
  data + Netlify deploy preview. UI is a dashboard, not a library.
- Keep `pnpm lint` (no-explicit-any=error) + `pnpm build` green.

---

## Out of scope (this session)
- Real-money / order endpoints (v1 = paper only, forever in v1).
- Auth / multi-tenant (single-tenant, anon-read RLS).
- Mobile-specific layout (desktop dashboard).
- Historical backfill charts beyond what `pnl_snapshots` accumulates live.
- Changing the engine (S3) or detector (S2) — dashboard consumes them as-is.

## Acceptance (maps to SPEC §7 + acceptance.md)
- All 6 panels render; read-only three show live HL×OKX data.
- Sortable leaderboard + opportunity table; heatmap colored by signed APR, sized by OI.
- "Paper-trade" opens a position (post-deploy); "Close" closes one; both reflect via Realtime.
- P&L curve draws 4 series; exec log streams fills + risk events, virtualized.
- `pnpm lint` + `pnpm build` exit 0; pure libs tested.
```
