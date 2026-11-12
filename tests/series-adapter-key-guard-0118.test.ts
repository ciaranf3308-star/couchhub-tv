/**
 * @vitest-environment jsdom
 */
// 0.11.8 integration (decision x): the series adapter's decorateCard
// resolves the season count asynchronously. If the card node is
// reused for a different series before the count resolves, the stale
// callback must not write the old series' count into the new card.
// The key guard checks data-couch-key before writing.
import { describe, it, expect } from "vitest"
import { setCached } from "@/scripts/lib/cache.js"
import { buildCouchCard } from "@/scripts/movies/couch-cards.ts"
import { seriesAdapter } from "@/scripts/series/couch-series-adapter.ts"
import type { SeriesRow } from "@/scripts/series/couch-series.ts"

function seriesRow(id: number): SeriesRow {
  return {
    id,
    name: `Guarded Show ${id}`,
    logo: null,
    year: "2023",
    rating: "",
    category: "Drama",
    plot: "",
    added: 0,
    norm: "",
    tmdb: null,
  }
}

describe("seriesAdapter.decorateCard key guard", () => {
  it("writes the resolved season count when the card still shows that series", () => {
    const row = seriesRow(771)
    const card = buildCouchCard(seriesAdapter.cardView(row, "pl-guard"))
    expect(card.querySelector(".rs-card__meta")?.textContent).not.toContain("seasons")
    setCached("pl-guard", "series_info_771", { episodes: { "1": [{ id: 1 }], "2": [{ id: 2 }] } }, 60_000)
    seriesAdapter.decorateCard(card, row, "pl-guard")
    expect(card.querySelector(".rs-card__meta")?.textContent).toContain("2 seasons")
  })

  it("never writes the count into a card re-keyed for another series", () => {
    const row = seriesRow(772)
    const card = buildCouchCard(seriesAdapter.cardView(row, "pl-guard"))
    expect(card.querySelector(".rs-card__meta")?.textContent).not.toContain("seasons")
    setCached("pl-guard", "series_info_772", { episodes: { "1": [{ id: 1 }], "2": [{ id: 2 }] } }, 60_000)
    card.setAttribute("data-couch-key", "series-999")
    seriesAdapter.decorateCard(card, row, "pl-guard")
    expect(card.querySelector(".rs-card__meta")?.textContent).not.toContain("seasons")
  })
})
