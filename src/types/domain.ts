// Domain types for the Funding-Arb dashboard.
// NOTE: venue-payload parsing types are zod-derived in src/lib/normalize.ts
// (CLAUDE.md hard rule #5: no `any`; the schema defines the type).
// These mirror the snake_case Postgres tables in schema.sql.

export type VenueId = 'hyperliquid' | 'binance_futures' | 'bybit' | 'okx'

export type Tier = 'major' | 'mid' | 'alt'

export interface FundingSnapshot {
  id: number
  instrumentId: number
  ts: string
  fundingRateNative: number
  fundingRate1hApr: number
  nextFundingTs: string | null
  markPrice: number | null
  indexPrice: number | null
  openInterestUsd: number | null
}

export type OpportunityKind =
  | 'single_venue_funding_harvest'
  | 'cross_venue_basis_arb'

export type OpportunityStatus = 'open' | 'expired' | 'paper_traded'

export interface Opportunity {
  id: number
  detectedAt: string
  kind: OpportunityKind
  baseSymbol: string
  grossApr: number
  netApr: number
  minPositionUsd: number
  status: OpportunityStatus
}
