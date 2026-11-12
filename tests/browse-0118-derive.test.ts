// 0.11.8 W2 — derive engine (brief §6.4, §8–§12). Pure.
import { describe, expect, it } from "vitest";
import { buildCatalogIndex, type CatalogEntry } from "@/scripts/lib/browse-catalog-shim";
import { deriveBrowseGroups, type BrowseDeriveContext } from "@/scripts/lib/browse-everything";
import {
  applyFilters,
  createBrowseState,
  selectCategory,
  setSearch,
  setSort,
} from "@/scripts/lib/browse-state";

function entry(partial: Partial<CatalogEntry> & { id: number; name: string }): CatalogEntry {
  return { ...partial };
}

const ROWS: CatalogEntry[] = [
  entry({ id: 1, name: "Dune", year: "2021", rating: "8.4", duration: "155 min", category: "Science Fiction", added: 100, tmdb: 1 }),
  entry({ id: 2, name: "Dune", year: "2021", rating: "8.4", duration: "155 min", category: "Sci-Fi FHD", added: 101 }),
  entry({ id: 3, name: "Dune", year: "1984", rating: "6.5", duration: "137 min", category: "Science Fiction", added: 50 }),
  entry({ id: 4, name: "The Comedy Show", year: "2019", rating: "", duration: "", category: "Comedy", added: 90 }),
  entry({ id: 5, name: "Obscure Foreign Film", year: "", rating: "", duration: "", category: "", added: 10, language: "fr" }),
  entry({ id: 6, name: "Old Classic", year: "1955", rating: "9.1", duration: "200 min", category: "Drama", added: 5, tmdb: 6 }),
  entry({ id: 7, name: "Horror Night", year: "2023", rating: "7.2", duration: "95 min", category: "Horror", added: 120 }),
  entry({ id: 8, name: "Short Film", year: "2022", rating: "6.0", duration: "45 min", category: "Drama", added: 110 }),
];

const INDEX = buildCatalogIndex("movie", ROWS, "derive-1");

function ctx(overrides: Partial<BrowseDeriveContext> = {}): BrowseDeriveContext {
  return {
    collection: {
      favouriteIds: new Set(),
      watchLaterIds: new Set(),
      inProgressIds: new Set(),
      watchedIds: new Set(),
      followedIds: new Set(),
      newEpisodeIds: new Set(),
    },
    seasonCounts: new Map(),
    seriesStatus: new Map(),
    ...overrides,
  };
}

describe("ALL TITLES MEANS ALL (§6.4)", () => {
  it("the default state shows every group incl. obscure/unrated/foreign/old", () => {
    const derived = deriveBrowseGroups(INDEX, createBrowseState("movie"), ctx());
    expect(derived.totalGroups).toBe(7); // Dune 2021 variants grouped
    expect(derived.totalEntries).toBe(8);
    expect(derived.groups.map((g) => g.title)).toContain("Obscure Foreign Film");
    expect(derived.groups.map((g) => g.title)).toContain("Old Classic");
    expect(derived.groups.map((g) => g.title)).toContain("The Comedy Show");
  });

  it("uncategorised selection shows only uncategorised groups", () => {
    const state = selectCategory(createBrowseState("movie"), {
      kind: "uncategorised",
      id: "uncategorised",
      label: "Uncategorised",
    });
    const derived = deriveBrowseGroups(INDEX, state, ctx());
    expect(derived.groups.map((g) => g.title)).toEqual(["Obscure Foreign Film"]);
  });
});

describe("category + filter combination (§7.2/§8/§10)", () => {
  it("genre category replaces; filters combine visibly", () => {
    const state = applyFilters(
      selectCategory(createBrowseState("movie"), { kind: "genre", id: "drama", label: "Drama" }),
      { year: "2020s" },
    );
    const derived = deriveBrowseGroups(INDEX, state, ctx());
    expect(derived.groups.map((g) => g.title)).toEqual(["Short Film"]);
  });

  it("unknown ratings never pass a minimum filter", () => {
    const state = applyFilters(createBrowseState("movie"), { minRating: 7 });
    const titles = deriveBrowseGroups(INDEX, state, ctx()).groups.map((g) => g.title);
    expect(titles).not.toContain("The Comedy Show");
    expect(titles).not.toContain("Obscure Foreign Film");
    expect(titles).toContain("Dune");
    expect(titles).toContain("Horror Night");
  });

  it("runtime buckets exclude unknown runtimes; over-3h finds the classic", () => {
    const over = applyFilters(createBrowseState("movie"), { runtime: "over-180" });
    expect(deriveBrowseGroups(INDEX, over, ctx()).groups.map((g) => g.title)).toEqual(["Old Classic"]);
    const under = applyFilters(createBrowseState("movie"), { runtime: "under-60" });
    expect(deriveBrowseGroups(INDEX, under, ctx()).groups.map((g) => g.title)).toEqual(["Short Film"]);
  });

  it("year ranges and decades use release year", () => {
    const state = applyFilters(createBrowseState("movie"), { year: "older" });
    expect(deriveBrowseGroups(INDEX, state, ctx()).groups.map((g) => g.title)).toEqual(["Old Classic"]);
    const range = applyFilters(createBrowseState("movie"), { yearFrom: 2020, yearTo: 2022 });
    expect(deriveBrowseGroups(INDEX, range, ctx()).groups.map((g) => g.title)).toContain("Dune");
    expect(deriveBrowseGroups(INDEX, range, ctx()).groups.map((g) => g.title)).not.toContain("Old Classic");
  });

  it("language filter uses actual catalogue data only", () => {
    const state = applyFilters(createBrowseState("movie"), { language: "fr" });
    expect(deriveBrowseGroups(INDEX, state, ctx()).groups.map((g) => g.title)).toEqual([
      "Obscure Foreign Film",
    ]);
    const de = applyFilters(createBrowseState("movie"), { language: "de" });
    expect(deriveBrowseGroups(INDEX, de, ctx()).groups).toEqual([]);
  });

  it("watch-status + favourites filters use caller sets", () => {
    const withSets = ctx({
      collection: {
        favouriteIds: new Set([7]),
        watchLaterIds: new Set(),
        inProgressIds: new Set([1]),
        watchedIds: new Set([6]),
        followedIds: new Set(),
        newEpisodeIds: new Set(),
      },
    });
    const fav = applyFilters(createBrowseState("movie"), { favouritesOnly: true });
    expect(deriveBrowseGroups(INDEX, fav, withSets).groups.map((g) => g.title)).toEqual(["Horror Night"]);
    const prog = applyFilters(createBrowseState("movie"), { watchStatus: "in-progress" });
    expect(deriveBrowseGroups(INDEX, prog, withSets).groups.map((g) => g.title)).toEqual(["Dune"]);
    const unw = applyFilters(createBrowseState("movie"), { watchStatus: "unwatched" });
    const unwatched = deriveBrowseGroups(INDEX, unw, withSets).groups.map((g) => g.title);
    expect(unwatched).not.toContain("Old Classic");
    expect(unwatched).toContain("Horror Night");
  });
});

describe("search (§12)", () => {
  it("defaults to relevance, never alphabetical", () => {
    const state = setSearch(createBrowseState("movie"), "dune");
    const derived = deriveBrowseGroups(INDEX, state, ctx());
    expect(derived.effectiveSort).toBe("relevance");
    expect(derived.groups).toHaveLength(2);
  });

  it("an explicit sort overrides relevance", () => {
    const state = setSort(setSearch(createBrowseState("movie"), "dune"), "az");
    const derived = deriveBrowseGroups(INDEX, state, ctx());
    expect(derived.effectiveSort).toBe("az");
  });

  it("scope=category restricts to the current category; scope=all searches everything", () => {
    const inHorror = setSearch(
      selectCategory(createBrowseState("movie"), { kind: "genre", id: "horror", label: "Horror" }),
      "dune",
      "category",
    );
    expect(deriveBrowseGroups(INDEX, inHorror, ctx()).groups).toEqual([]);
    const all = setSearch(
      selectCategory(createBrowseState("movie"), { kind: "genre", id: "horror", label: "Horror" }),
      "dune",
      "all",
    );
    expect(deriveBrowseGroups(INDEX, all, ctx()).groups).toHaveLength(2);
  });

  it("search + filters combine (both visible in the summary)", () => {
    const state = applyFilters(setSearch(createBrowseState("movie"), "dune"), { minRating: 8 });
    const titles = deriveBrowseGroups(INDEX, state, ctx()).groups.map((g) => `${g.title} ${g.year}`);
    expect(titles).toEqual(["Dune 2021"]);
  });
});

describe("sort (§11)", () => {
  it("rating sort puts evidence first and unrated last", () => {
    const state = setSort(createBrowseState("movie"), "rating");
    const titles = deriveBrowseGroups(INDEX, state, ctx()).groups.map((g) => g.title);
    expect(titles[0]).toBe("Old Classic");
    expect(titles.slice(-2)).toEqual(expect.arrayContaining(["The Comedy Show", "Obscure Foreign Film"]));
  });

  it("recent collection defaults to added order; explicit sort wins", () => {
    const recent = selectCategory(createBrowseState("movie"), {
      kind: "collection",
      id: "recent",
      label: "Recently Added",
    });
    const derived = deriveBrowseGroups(INDEX, recent, ctx());
    expect(derived.effectiveSort).toBe("added");
    expect(derived.groups[0].title).toBe("Horror Night");
    const az = deriveBrowseGroups(INDEX, setSort(recent, "az"), ctx());
    expect(az.groups[0].title).toBe("Dune");
  });

  it("seasons sort orders by confirmed counts, unknown last", () => {
    const seriesIndex = buildCatalogIndex(
      "series",
      [
        entry({ id: 1, name: "Long Show", year: "2010", category: "Drama" }),
        entry({ id: 2, name: "Short Show", year: "2020", category: "Drama" }),
        entry({ id: 3, name: "Unknown Show", year: "2021", category: "Drama" }),
      ],
      "series-1",
    );
    const counts = new Map<string, number | null>();
    for (const g of seriesIndex.groups) {
      counts.set(g.id, g.title === "Long Show" ? 10 : g.title === "Short Show" ? 1 : null);
    }
    const state = setSort(createBrowseState("series"), "seasons");
    const titles = deriveBrowseGroups(seriesIndex, state, ctx({ seasonCounts: counts })).groups.map(
      (g) => g.title,
    );
    expect(titles).toEqual(["Long Show", "Short Show", "Unknown Show"]);
  });
});

describe("search helpers", () => {
  it("strips provider affixes but keeps years", async () => {
    const { stripProviderAffixes, normalizeBrowseQuery, yearTokensInQuery, resolveSearchScope } =
      await import("@/scripts/lib/browse-search");
    expect(stripProviderAffixes("Dune [1080p] FHD")).toBe("Dune");
    expect(stripProviderAffixes("UK | Dune (2021)")).toBe("Dune 2021");
    expect(normalizeBrowseQuery("Spider-Man")).toBe("spider man");
    expect(yearTokensInQuery("dune 2021")).toEqual(["2021"]);
    expect(resolveSearchScope("category", "all")).toBe("all");
    expect(resolveSearchScope("category", "genre")).toBe("category");
  });
});
