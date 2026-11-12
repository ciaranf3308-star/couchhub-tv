import { describe, it, expect } from "vitest"
import { setCached } from "@/scripts/lib/cache.js"
import { getCachedSeriesInfoPayload } from "@/scripts/lib/series-seasons.ts"

// 0.11.8 integration (decision xi): the Series Home continue-resolution
// needs read-only cached payload access without duplicating the cache
// key or triggering fetches. Stale payloads must not decide playback.
describe("getCachedSeriesInfoPayload", () => {
  it("returns the fresh cached payload, null on miss, null when stale", () => {
    expect(getCachedSeriesInfoPayload("pl-payload", 4242)).toBeNull()
    const payload = { episodes: { "1": [{ id: 1, season: 1, episode_num: 1 }] } }
    setCached("pl-payload", "series_info_4242", payload, 60_000)
    expect(getCachedSeriesInfoPayload("pl-payload", 4242)).toBe(payload)
    setCached("pl-payload", "series_info_4243", payload, -1)
    expect(getCachedSeriesInfoPayload("pl-payload", 4243)).toBeNull()
    expect(getCachedSeriesInfoPayload("", 4242)).toBeNull()
    expect(getCachedSeriesInfoPayload("pl-payload", null as never)).toBeNull()
  })
})
