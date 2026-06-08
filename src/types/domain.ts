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
