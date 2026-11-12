// 0.11.8 W2 — W1 shim contract semantics (brief §6.4, §12; shim deleted at integration).
// These tests pin the REAL contract semantics the W1 modules must preserve.
import { describe, expect, it, beforeEach } from "vitest";
import {
  CANONICAL_MOVIE_GENRES,
  CANONICAL_SERIES_GENRES,
  UNCATEGORISED_ID,
  buildCatalogIndex,
  compareByRatingEvidence,
  getCatalogIndex,
  getSortedGroupIds,
  genresForEntry,
  groupEntries,
  normaliseRating,
  resetShimCatalogCache,
  searchCatalogIndex,
  selectFavourites,
  selectHighestRated,
  selectUnwatched,
  shimCatalogBuildCount,
  type CatalogEntry,
} from "@/scripts/lib/browse-catalog-shim";

function entry(partial: Partial<CatalogEntry> & { id: number; name: string }): CatalogEntry {
  return { ...partial };
}

beforeEach(() => {
  resetShimCatalogCache();
});

describe("canonical genres", () => {
  it("18 movie genres, 15 series families", () => {
    expect(CANONICAL_MOVIE_GENRES).toHaveLength(18);
    expect(CANONICAL_SERIES_GENRES).toHaveLength(15);
    expect(CANONICAL_MOVIE_GENRES.map((g) => g.id)).toContain("horror");
    expect(new Set(CANONICAL_MOVIE_GENRES.map((g) => g.id)).size).toBe(18);
  });

  it("genresForEntry reads row genre + category fallback", () => {
    expect(genresForEntry(entry({ id: 1, name: "X", category: "Horror" }))).toContain("horror");
    expect(genresForEntry(entry({ id: 2, name: "Y", genre: "Comedy, Drama" }))).toEqual(
      expect.arrayContaining(["comedy", "drama"]),
    );
    expect(genresForEntry(entry({ id: 3, name: "Z" }))).toEqual([]);
  });
});

describe("grouping (§6.4 — grouping never hides variants)", () => {
  it("groups by normalised title + year and keeps every variant", () => {
    const groups = groupEntries([
      entry({ id: 1, name: "Dune", year: "2021", category: "Sci-Fi" }),
      entry({ id: 2, name: "Dune", year: "2021", category: "Sci-Fi FHD" }),
      entry({ id: 3, name: "Dune", year: "1984", category: "Sci-Fi" }),
      entry({ id: 4, name: "Spider-Man", year: "2002" }),
      entry({ id: 5, name: "Spider Man", year: "2002" }),
    ]);
    expect(groups).toHaveLength(3);
    const dune21 = groups.find((g) => g.year === "2021")!;
    expect(dune21.variantCount).toBe(2);
    expect(dune21.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(groups.reduce((n, g) => n + g.entries.length, 0)).toBe(5);
  });

  it("provider affixes are version noise, not title identity", () => {
    const groups = groupEntries([
      entry({ id: 1, name: "Midnight Harbor", year: "2020" }),
      entry({ id: 2, name: "Midnight Harbor [1080p]", year: "2020" }),
      entry({ id: 3, name: "Midnight Harbor 4K", year: "2020" }),
      entry({ id: 4, name: "Midnight Harbor", year: "2019" }),
    ]);
    expect(groups).toHaveLength(2);
    const g2020 = groups.find((g) => g.year === "2020")!;
    expect(g2020.variantCount).toBe(3);
    expect(g2020.entries.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("uncategorised entries stay reachable", () => {
    const index = buildCatalogIndex(
      "movie",
      [
        entry({ id: 1, name: "A", category: "Action" }),
        entry({ id: 2, name: "B" }),
        entry({ id: 3, name: "C", category: "  " }),
      ],
      "r1",
    );
    expect(index.uncategorisedIds).toHaveLength(2);
    expect(index.totalGroups).toBe(3);
    expect(UNCATEGORISED_ID).toBe("uncategorised");
  });
});

describe("rating evidence", () => {
  it("unknown ratings are null and never pass a minimum", () => {
    expect(normaliseRating(entry({ id: 1, name: "A" })).value).toBeNull();
    expect(normaliseRating(entry({ id: 2, name: "B", rating: "" })).value).toBeNull();
    expect(normaliseRating(entry({ id: 3, name: "C", rating: "N/A" })).value).toBeNull();
    expect(normaliseRating(entry({ id: 4, name: "D", rating: "0" })).value).toBeNull();
    expect(normaliseRating(entry({ id: 5, name: "E", rating: "99" })).value).toBeNull();
    expect(normaliseRating(entry({ id: 6, name: "F", rating: "8.4" })).value).toBe(8.4);
  });

  it("evidence-first ordering: rated above unrated, linked above unlinked", () => {
    const rated = entry({ id: 1, name: "R", rating: "7.0" });
    const unrated = entry({ id: 2, name: "U" });
    expect(compareByRatingEvidence(rated, unrated)).toBeLessThan(0);
    const linked = entry({ id: 3, name: "L", rating: "7.0", tmdb: 123 });
    expect(compareByRatingEvidence(linked, rated)).toBeLessThan(0);
    const higher = entry({ id: 4, name: "H", rating: "9.0" });
    expect(compareByRatingEvidence(higher, rated)).toBeLessThan(0);
  });
});

describe("index caching + sorted indexes", () => {
  it("builds once per revision and returns the same object", () => {
    const rows = [entry({ id: 1, name: "A" })];
    const before = shimCatalogBuildCount();
    const a = getCatalogIndex("movie", rows, "rev-1");
    const b = getCatalogIndex("movie", rows, "rev-1");
    expect(a).toBe(b);
    expect(shimCatalogBuildCount()).toBe(before + 1);
    const c = getCatalogIndex("movie", rows, "rev-2");
    expect(c).not.toBe(a);
  });

  it("sorted indexes are precomputed (az/za/rating/year)", () => {
    const index = buildCatalogIndex(
      "movie",
      [
        entry({ id: 1, name: "Zebra", year: "2001", rating: "5", added: 1 }),
        entry({ id: 2, name: "Apple", year: "2020", rating: "9", added: 3 }),
        entry({ id: 3, name: "Mango", year: "2010", rating: "", added: 2 }),
      ],
      "r1",
    );
    const names = (ids: string[]) => ids.map((id) => index.byId.get(id)!.title);
    expect(names(getSortedGroupIds(index, "az"))).toEqual(["Apple", "Mango", "Zebra"]);
    expect(names(getSortedGroupIds(index, "za"))).toEqual(["Zebra", "Mango", "Apple"]);
    expect(names(getSortedGroupIds(index, "rating"))[0]).toBe("Apple");
    expect(names(getSortedGroupIds(index, "rating"))[2]).toBe("Mango");
    expect(names(getSortedGroupIds(index, "year-desc"))).toEqual(["Apple", "Mango", "Zebra"]);
    expect(names(getSortedGroupIds(index, "added"))).toEqual(["Apple", "Mango", "Zebra"]);
  });
});

describe("search (§12)", () => {
  const index = buildCatalogIndex(
    "movie",
    [
      entry({ id: 1, name: "Dune", year: "2021", category: "Science Fiction" }),
      entry({ id: 2, name: "Dune", year: "1984", category: "Science Fiction" }),
      entry({ id: 3, name: "Spider-Man: Homecoming", year: "2017" }),
      entry({ id: 4, name: "Amélie", year: "2001", altTitles: ["Le Fabuleux Destin d'Amélie Poulain"] }),
    ],
    "search-1",
  );

  it("matches partial + alternative names with normalised punctuation", () => {
    expect(searchCatalogIndex(index, "spider man").map((h) => h.group.displayEntry.id)).toEqual([3]);
    expect(searchCatalogIndex(index, "SPIDER-MAN").map((h) => h.group.displayEntry.id)).toEqual([3]);
    expect(searchCatalogIndex(index, "amelie").map((h) => h.group.displayEntry.id)).toEqual([4]);
    expect(searchCatalogIndex(index, "fabuleux").map((h) => h.group.displayEntry.id)).toEqual([4]);
  });

  it("year tokens disambiguate", () => {
    expect(searchCatalogIndex(index, "dune 2021").map((h) => h.group.displayEntry.id)).toEqual([1]);
    expect(searchCatalogIndex(index, "dune 1984").map((h) => h.group.displayEntry.id)).toEqual([2]);
    expect(searchCatalogIndex(index, "dune")).toHaveLength(2);
  });

  it("relevance order, and scope restriction via onlyIds", () => {
    const hits = searchCatalogIndex(index, "dune");
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    const only = new Set([index.groups[0].id]);
    expect(searchCatalogIndex(index, "dune", only)).toHaveLength(1);
    expect(searchCatalogIndex(index, "   ")).toEqual([]);
  });
});

describe("collection selectors", () => {
  it("empty sets yield empty selections, never invented titles", () => {
    const index = buildCatalogIndex("movie", [entry({ id: 1, name: "A" })], "c1");
    const empty = {
      favouriteIds: new Set<string>(),
      watchLaterIds: new Set<string>(),
      inProgressIds: new Set<string>(),
      watchedIds: new Set<string>(),
      followedIds: new Set<string>(),
      newEpisodeIds: new Set<string>(),
    };
    expect(selectFavourites(index, empty)).toEqual([]);
    expect(selectUnwatched(index, empty)).toHaveLength(1);
  });

  it("highest-rated returns rated titles only, best first", () => {
    const index = buildCatalogIndex(
      "movie",
      [
        entry({ id: 1, name: "Low", rating: "5.0" }),
        entry({ id: 2, name: "High", rating: "9.2" }),
        entry({ id: 3, name: "Unrated" }),
        entry({ id: 4, name: "Mid", rating: "7.5" }),
      ],
      "r-rated",
    );
    expect(selectHighestRated(index).map((g) => g.title)).toEqual(["High", "Mid", "Low"]);
  });
});
