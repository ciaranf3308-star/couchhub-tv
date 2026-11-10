// C1 taxonomy classifier tests (0.10.0, W4).
import { describe, it, expect } from "vitest"
import {
  classifyTitle,
  kindLabel,
  isDocumentaryKind,
  type ContentKind,
} from "../src/scripts/lib/taxonomy"

describe("classifyTitle", () => {
  it("classifies a plain movie from provider type", () => {
    expect(classifyTitle({ type: "movie", title: "Some Film" })).toBe("movie")
    expect(classifyTitle({ type: "vod", title: "Some Film" })).toBe("movie")
    expect(classifyTitle({ category: "EN | Movies", title: "Some Film" })).toBe("movie")
  })

  it("classifies a series from provider type/category", () => {
    expect(classifyTitle({ type: "series", title: "Some Show" })).toBe("series")
    expect(classifyTitle({ category: "TV Shows", title: "Some Show" })).toBe("series")
    expect(classifyTitle({ category: "EN | TV Series", title: "Some Show" })).toBe("series")
  })

  it("classifies live from an explicit live type", () => {
    expect(classifyTitle({ type: "live", title: "BBC One" })).toBe("live")
    expect(classifyTitle({ kind: "live", title: "BBC One" })).toBe("live")
  })

  it("classifies a documentary film from the documentary genre signal", () => {
    expect(
      classifyTitle({ type: "movie", genres: ["Documentary"], title: "Planet Earth Film" }),
    ).toBe("documentary-film")
    expect(
      classifyTitle({ type: "vod", category: "Documentary", title: "Nature Film" }),
    ).toBe("documentary-film")
  })

  it("classifies a documentary series from documentary + series signals", () => {
    expect(
      classifyTitle({ type: "series", genres: ["Documentary"], title: "Nature Series" }),
    ).toBe("documentary-series")
    expect(
      classifyTitle({ type: "series", category: "Documentary Series", title: "Doc Show" }),
    ).toBe("documentary-series")
    expect(classifyTitle({ type: "movie", genres: ["Docuseries"], title: "Doc Show" })).toBe(
      "documentary-series",
    )
  })

  it("does NOT classify a crime documentary as a crime drama", () => {
    // Genres are attributes, never the kind: crime + documentary must
    // land on documentary-film, not on any crime/drama kind.
    const kind = classifyTitle({
      type: "movie",
      genres: ["Crime", "Documentary"],
      title: "The Crime Documentary",
    })
    expect(kind).toBe("documentary-film")
    expect(kindLabel(kind)).toBe("Documentary Film")
  })

  it("does NOT let a crime series' genres change its kind", () => {
    expect(
      classifyTitle({ type: "series", genres: ["Crime", "Drama"], title: "Crime Show" }),
    ).toBe("series")
  })

  it("does NOT classify from the title alone", () => {
    // "Documentary Now" is a comedy series, not a documentary — the
    // title word must never drive classification.
    expect(
      classifyTitle({ type: "series", genres: ["Comedy"], title: "Documentary Now" }),
    ).toBe("series")
  })

  it("detects documentary signals in tags too", () => {
    expect(
      classifyTitle({ type: "movie", tags: ["documentary", "history"], title: "War Film" }),
    ).toBe("documentary-film")
  })

  it("defaults an unmarked row to movie", () => {
    expect(classifyTitle({ title: "Mystery Row" })).toBe("movie")
    expect(classifyTitle({})).toBe("movie")
  })

  it("does not modify the provider item", () => {
    const item = { type: "movie", genres: ["Crime", "Documentary"], title: "Doc" }
    classifyTitle(item)
    expect(item).toEqual({ type: "movie", genres: ["Crime", "Documentary"], title: "Doc" })
  })
})

describe("kindLabel / isDocumentaryKind", () => {
  it("labels every kind", () => {
    const labels: Record<ContentKind, string> = {
      movie: "Movie",
      series: "Series",
      "documentary-film": "Documentary Film",
      "documentary-series": "Documentary Series",
      live: "Live TV",
    }
    for (const [kind, label] of Object.entries(labels)) {
      expect(kindLabel(kind as ContentKind)).toBe(label)
    }
  })

  it("flags only the documentary kinds", () => {
    expect(isDocumentaryKind("documentary-film")).toBe(true)
    expect(isDocumentaryKind("documentary-series")).toBe(true)
    expect(isDocumentaryKind("movie")).toBe(false)
    expect(isDocumentaryKind("series")).toBe(false)
    expect(isDocumentaryKind("live")).toBe(false)
  })
})
