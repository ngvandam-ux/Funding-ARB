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
