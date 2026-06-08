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
