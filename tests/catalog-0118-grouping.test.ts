import { describe, it, expect, beforeEach } from "vitest"
import {
  groupEntries,
  primaryEntryFor,
  variantsFor,
  titleGroupPassesLanguageFilter,
  clearTitleGroupRegistry,
  type TitleGroup,
} from "@/scripts/lib/language-groups.ts"

beforeEach(() => clearTitleGroupRegistry())

describe("groupEntries", () => {
  it("groups TMDb-verified language variants into one displayed title", () => {
    const groups = groupEntries(
      [
        { id: 1, name: "EN - Project Hail Mary (2026)", tmdb: 12345 },
        { id: 2, name: "ES - Proyecto Salvación (2026)", tmdb: 12345 },
        { id: 3, name: "FR - Projet Dernière Chance (2026)", tmdb: 12345 },
      ],
      "vod",
    )
    expect(groups).toHaveLength(1)
    const [group] = groups
    expect(group.id).toBe("vod:t:12345")
    expect(group.kind).toBe("vod")
    expect(group.tmdbId).toBe(12345)
    expect(group.year).toBe(2026)
    expect(group.confidence).toBe("high")
    expect(group.variantIds).toHaveLength(3)
    expect(group.variantIds[0]).toBe(group.primaryId)
    expect([...group.variantIds].sort()).toEqual(["1", "2", "3"])
    expect(group.tags).toEqual(["EN", "ES", "FR"])
  })

  it("never groups a movie with a series sharing a TMDb id", () => {
    const groups = groupEntries(
      [
        { id: 10, name: "Dune (2021)", tmdb: 77, kind: "movie" },
        { id: 11, name: "Dune (2021)", tmdb: 77, kind: "series" },
      ],
      null,
    )
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.id).sort()).toEqual(["series:t:77", "vod:t:77"])
    expect(groups.map((g) => g.kind).sort()).toEqual(["series", "vod"])
  })

  it("groups conservative title/year variants with distinct tags", () => {
    const groups = groupEntries(
      [
        { id: 20, name: "EN - The Batman (2022)" },
        { id: 21, name: "DE - The Batman (2022)" },
      ],
      "vod",
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].confidence).toBe("medium")
    expect(groups[0].tmdbId).toBeUndefined()
  })

  it("keeps distinct films with similar titles separate", () => {
    const groups = groupEntries(
      [
        { id: 30, name: "EN - Dune (2021)" },
        { id: 31, name: "EN - Dune: Part Two (2024)" },
        { id: 32, name: "EN - The Batman (1989)" },
        { id: 33, name: "EN - The Batman (2022)" },
      ],
      "vod",
    )
    expect(groups).toHaveLength(4)
  })

  it("keeps same-tag duplicates separate (uncertain matches stay separate)", () => {
    const groups = groupEntries(
      [
        { id: 40, name: "EN - WWE Raw" },
        { id: 41, name: "EN - WWE Raw (30/06/2025)" },
        { id: 42, name: "EN - WWE Raw (07/07/2025)" },
      ],
      "vod",
    )
    expect(groups).toHaveLength(3)
    for (const group of groups) {
      expect(group.variantIds).toHaveLength(1)
      expect(group.confidence).toBe("high")
    }
  })

  it("keeps an ambiguous TMDb bridge separate", () => {
    const groups = groupEntries(
      [
        { id: 50, name: "EN - Michael (2026)", tmdb: 900 },
        { id: 51, name: "DE - Michael (2026)", tmdb: 901 },
        { id: 52, name: "FR - Michael (2026)" },
      ],
      "vod",
    )
    expect(groups).toHaveLength(3)
  })

  it("downgrades confidence when TMDb-grouped years conflict", () => {
    const groups = groupEntries(
      [
        { id: 60, name: "EN - Confused (2010)", tmdb: 5 },
        { id: 61, name: "DE - Confused (2020)", tmdb: 5 },
      ],
      "vod",
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].confidence).toBe("medium")
  })

  it("resolves kind from an index-like object and skips unusable ids", () => {
    const groups = groupEntries(
      [
        { id: 70, name: "Reacher (2022)" },
        { id: "not-a-number", name: "Ghost" },
        { id: 70, name: "Reacher duplicate" },
      ],
      { kind: "series" },
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe("series")
    expect(groups[0].variantIds).toEqual(["70"])
  })

  it("returns groups in catalogue order", () => {
    const groups = groupEntries(
      [
        { id: 80, name: "Zulu (1964)" },
        { id: 81, name: "EN - Alpha (2020)", tmdb: 1 },
        { id: 82, name: "DE - Alpha (2020)", tmdb: 1 },
        { id: 83, name: "Midnight (1999)" },
      ],
      "vod",
    )
    expect(groups.map((g) => g.primaryId)).toEqual(["80", "81", "83"])
  })
})

describe("primaryEntryFor / variantsFor", () => {
  it("resolves the primary entry and variants from the registry", () => {
    const rows = [
      { id: 1, name: "EN - Heat (1995)", tmdb: 42 },
      { id: 2, name: "DE - Heat (1995)", tmdb: 42 },
    ]
    const [group] = groupEntries(rows, "vod")
    expect(variantsFor(group.id)).toEqual(group.variantIds)
    const primary = primaryEntryFor(group)
    expect(primary).not.toBeNull()
    expect(String(primary!.id)).toBe(group.primaryId)
    expect(primaryEntryFor(group.id)).not.toBeNull()
  })

  it("resolves the primary from supplied entries without the registry", () => {
    clearTitleGroupRegistry()
    const group: TitleGroup = {
      id: "vod:t:9",
      primaryId: "5",
      variantIds: ["5", "6"],
      kind: "vod",
      confidence: "high",
    }
    const rows = [
      { id: 5, name: "Five" },
      { id: 6, name: "Six" },
    ]
    expect(primaryEntryFor(group, rows)?.name).toBe("Five")
    expect(primaryEntryFor(group, new Map([["5", rows[0]]]))?.name).toBe("Five")
  })

  it("returns null / [] for unknown groups", () => {
    const group: TitleGroup = {
      id: "vod:e:424242",
      primaryId: "424242",
      variantIds: ["424242"],
      kind: "vod",
      confidence: "high",
    }
    expect(primaryEntryFor(group)).toBeNull()
    expect(variantsFor("vod:e:424242")).toEqual([])
  })
})

describe("titleGroupPassesLanguageFilter", () => {
  it("matches when ANY member variant satisfies the filter", () => {
    const [group] = groupEntries(
      [
        { id: 1, name: "EN - Heat (1995)", tmdb: 42 },
        { id: 2, name: "DE - Heat (1995)", tmdb: 42 },
      ],
      "vod",
    )
    expect(titleGroupPassesLanguageFilter(group, "DE")).toBe(true)
    expect(titleGroupPassesLanguageFilter(group, "FR")).toBe(false)
    expect(titleGroupPassesLanguageFilter(group, "")).toBe(true)
    expect(titleGroupPassesLanguageFilter(group.id, "EN")).toBe(true)
  })
})
