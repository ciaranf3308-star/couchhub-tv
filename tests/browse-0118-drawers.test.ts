// 0.11.8 W2 — drawer reducers + filter families (brief §7, §8, §9, §16.4). Pure.
import { describe, expect, it } from "vitest";
import {
  browseDrawerActivate,
  browseDrawerBack,
  browseDrawerInitialState,
  browseDrawerMove,
  buildBrowseDrawerFamilies,
  findBrowseDrawerSelection,
  type BrowseDrawerFamily,
} from "@/scripts/lib/browse-category-drawer";
import {
  buildFilterFamilies,
  cycleFilterFamilyValue,
  omittedFamilyNotes,
  setFilterFamilyValue,
  DEFAULT_FILTER_DRAWER_AVAILABILITY,
} from "@/scripts/lib/browse-filter-drawer";
import { createBrowseFilters } from "@/scripts/lib/browse-state";

function movieFamilies(): BrowseDrawerFamily[] {
  return buildBrowseDrawerFamilies({
    kind: "movie",
    totalGroups: 100,
    genres: [
      { id: "action", label: "Action", count: 20 },
      { id: "horror", label: "Horror", count: 5 },
      { id: "western", label: "Western", count: 0 },
    ],
    collections: [
      { id: "recent", label: "Recently Added", count: 100, available: true },
      { id: "favourites", label: "Favourites", count: 0, available: true },
      { id: "watchlater", label: "Watch Later", count: 3, available: true },
    ],
    providerCategories: [
      { id: "provider:action-fhd", label: "Action FHD", count: 12 },
      { id: "provider:empty", label: "Empty", count: 0 },
    ],
    uncategorisedCount: 7,
    // Unions are DISTINCT titles: 2 titles carry both Action and
    // Horror, so the genre union (23) is less than the sum (25).
    genreUnionCount: 23,
    collectionUnionCount: 100,
    providerUnionCount: 12,
  });
}

describe("drawer families (§7.1 structure)", () => {
  it("movies: All, Genres, Collections, Provider, Uncategorised — in order", () => {
    const ids = movieFamilies().map((f) => f.id);
    expect(ids).toEqual(["all", "genres", "collections", "provider", "uncategorised"]);
  });

  it("only populated genres/provider categories render; empty collections stay (honest empty state)", () => {
    const families = movieFamilies();
    expect(families[1].items.map((i) => i.id)).toEqual(["action", "horror"]);
    expect(families[3].items.map((i) => i.id)).toEqual(["provider:action-fhd"]);
    expect(families[2].items.find((i) => i.id === "favourites")?.count).toBe(0);
  });

  it("series collections follow the brief order incl. Followed + New Episodes", () => {
    const families = buildBrowseDrawerFamilies({
      kind: "series",
      totalGroups: 50,
      genres: [{ id: "drama", label: "Drama", count: 10 }],
      collections: [
        { id: "watchlater", label: "Watch Later", count: 1, available: true },
        { id: "followed", label: "Followed Series", count: 2, available: true },
        { id: "new-episodes", label: "New Episodes", count: 0, available: false, unavailableReason: "No detection yet." },
        { id: "recent", label: "Recently Added", count: 50, available: true },
      ],
      providerCategories: [],
      uncategorisedCount: 0,
      genreUnionCount: 10,
      collectionUnionCount: 50,
      providerUnionCount: 0,
    });
    expect(families.map((f) => f.id)).toEqual(["all", "genres", "collections"]);
    expect(families[2].items.map((i) => i.id)).toEqual([
      "recent",
      "followed",
      "new-episodes",
      "watchlater",
    ]);
    const newEp = families[2].items.find((i) => i.id === "new-episodes")!;
    expect(newEp.unavailableReason).toBe("No detection yet.");
    expect(newEp.count).toBe(0);
  });

  it("family counts are distinct-title unions, never sums of overlapping items", () => {
    const families = movieFamilies();
    // Genres: Action 20 + Horror 5 = 25 summed, but 2 titles carry
    // both — the family count must be the union (23), never 25.
    expect(families[1].count).toBe(23);
    expect(families[2].count).toBe(100);
    expect(families[3].count).toBe(12);
    for (const f of families) expect(f.count).toBeLessThanOrEqual(100);
  });

  it("uncategorised renders only when non-empty", () => {
    const families = buildBrowseDrawerFamilies({
      kind: "movie",
      totalGroups: 10,
      genres: [],
      collections: [],
      providerCategories: [],
      uncategorisedCount: 0,
      genreUnionCount: 0,
      collectionUnionCount: 0,
      providerUnionCount: 0,
    });
    expect(families.map((f) => f.id)).toEqual(["all"]);
  });
});

describe("drawer navigation (§7.3 — B-layer)", () => {
  it("opens on the selected category's item inside its family", () => {
    const families = movieFamilies();
    const state = browseDrawerInitialState(families, {
      kind: "genre",
      id: "horror",
      label: "Horror",
    });
    expect(state.level).toBe("items");
    expect(state.familyIndex).toBe(1);
    expect(state.itemIndex).toBe(1);
  });

  it("opens at the family level for All / unknown selections", () => {
    const families = movieFamilies();
    expect(
      browseDrawerInitialState(families, { kind: "all", id: "all", label: "All Movies" }),
    ).toMatchObject({ level: "families", familyIndex: 0 });
    expect(browseDrawerInitialState(families, null)).toMatchObject({
      level: "families",
      familyIndex: 0,
    });
  });

  it("moves clamp, never wrap", () => {
    const families = movieFamilies();
    const top = { level: "families" as const, familyIndex: 0, itemIndex: 0 };
    expect(browseDrawerMove(top, families, -1).familyIndex).toBe(0);
    const bottom = { level: "families" as const, familyIndex: 4, itemIndex: 0 };
    expect(browseDrawerMove(bottom, families, 1).familyIndex).toBe(4);
  });

  it("activate opens multi-item families, selects single-item families and items", () => {
    const families = movieFamilies();
    const open = browseDrawerActivate(
      { level: "families", familyIndex: 1, itemIndex: 0 },
      families,
    );
    expect(open.action).toBe("open-items");
    if (open.action === "open-items") expect(open.state.level).toBe("items");
    const selectAll = browseDrawerActivate(
      { level: "families", familyIndex: 0, itemIndex: 0 },
      families,
    );
    expect(selectAll.action).toBe("select");
    const selectItem = browseDrawerActivate(
      { level: "items", familyIndex: 1, itemIndex: 1 },
      families,
    );
    expect(selectItem.action).toBe("select");
    if (selectItem.action === "select") {
      expect(selectItem.selection).toEqual({ kind: "genre", id: "horror", label: "Horror" });
    }
  });

  it("unavailable rows never activate", () => {
    const families = buildBrowseDrawerFamilies({
      kind: "series",
      totalGroups: 5,
      genres: [],
      collections: [
        { id: "new-episodes", label: "New Episodes", count: 0, available: false, unavailableReason: "Nope." },
        { id: "recent", label: "Recently Added", count: 5, available: true },
      ],
      providerCategories: [],
      uncategorisedCount: 0,
      genreUnionCount: 0,
      collectionUnionCount: 5,
      providerUnionCount: 0,
    });
    const result = browseDrawerActivate(
      { level: "items", familyIndex: 1, itemIndex: 1 },
      families,
    );
    expect(result.action).toBe("none");
  });

  it("Back: items → families → close, one layer per press", () => {
    const items = { level: "items" as const, familyIndex: 1, itemIndex: 1 };
    const back1 = browseDrawerBack(items);
    expect(back1.action).toBe("to-families");
    if (back1.action === "to-families") {
      expect(browseDrawerBack(back1.state).action).toBe("close");
    }
    expect(findBrowseDrawerSelection(movieFamilies(), { kind: "genre", id: "horror", label: "Horror" })).toEqual({
      familyIndex: 1,
      itemIndex: 1,
    });
  });
});

describe("filter families (§8/§9 + §16.4 draft semantics)", () => {
  it("movies: genre, year, range, rating, runtime, watch, lists, language, provider + actions", () => {
    const families = buildFilterFamilies(
      "movie",
      createBrowseFilters(),
      {
        ...DEFAULT_FILTER_DRAWER_AVAILABILITY,
        runtime: true,
        languages: ["en", "fr"],
        providerCategories: [{ id: "provider:x", label: "X" }],
      },
      ["action", "horror"],
    );
    expect(families.map((f) => f.id)).toEqual([
      "genre",
      "year",
      "yearRange",
      "rating",
      "runtime",
      "watchStatus",
      "favourites",
      "watchLater",
      "language",
      "providerCategory",
      "__apply",
      "__clear",
    ]);
  });

  it("series: seasons + status only with evidence; followed/new-episodes gated", () => {
    const bare = buildFilterFamilies("series", createBrowseFilters(), DEFAULT_FILTER_DRAWER_AVAILABILITY, ["drama"]);
    expect(bare.map((f) => f.id)).not.toContain("seasons");
    expect(bare.map((f) => f.id)).not.toContain("status");
    expect(bare.map((f) => f.id)).not.toContain("followed");
    const rich = buildFilterFamilies(
      "series",
      createBrowseFilters(),
      {
        ...DEFAULT_FILTER_DRAWER_AVAILABILITY,
        seasonCounts: true,
        seasonCoverage: 0.8,
        seriesStatus: true,
        followedAvailable: true,
        newEpisodesAvailable: true,
      },
      ["drama"],
    );
    expect(rich.map((f) => f.id)).toContain("seasons");
    expect(rich.map((f) => f.id)).toContain("status");
    expect(rich.find((f) => f.id === "seasons")?.note).toContain("80%");
  });

  it("cycling replaces values (genre REPLACE) and wraps; draft is immutable", () => {
    const draft = createBrowseFilters();
    const families = buildFilterFamilies("movie", draft, DEFAULT_FILTER_DRAWER_AVAILABILITY, ["action", "horror"]);
    const genre = families.find((f) => f.id === "genre")!;
    const next = cycleFilterFamilyValue(draft, genre, 1);
    expect(next.genre).toBe("action");
    expect(draft.genre).toBe("");
    const families2 = buildFilterFamilies("movie", next, DEFAULT_FILTER_DRAWER_AVAILABILITY, ["action", "horror"]);
    const next2 = cycleFilterFamilyValue(next, families2.find((f) => f.id === "genre")!, 1);
    expect(next2.genre).toBe("horror");
    const wrapped = cycleFilterFamilyValue(next2, buildFilterFamilies("movie", next2, DEFAULT_FILTER_DRAWER_AVAILABILITY, ["action", "horror"]).find((f) => f.id === "genre")!, 1);
    expect(wrapped.genre).toBe("");
  });

  it("year-range cycles set from/to and clear the decade", () => {
    const draft = { ...createBrowseFilters(), year: "2010s" };
    const families = buildFilterFamilies("movie", draft, DEFAULT_FILTER_DRAWER_AVAILABILITY, []);
    const range = families.find((f) => f.id === "yearRange")!;
    const next = cycleFilterFamilyValue(draft, range, 1);
    expect(next.yearFrom).toBe(2020);
    expect(next.yearTo).toBe(2026);
    expect(next.year).toBe("");
    expect(setFilterFamilyValue(next, "year", "2010s").yearFrom).toBeNull();
  });

  it("omitted families get honest footnotes, never silent absence", () => {
    const notes = omittedFamilyNotes("movie", {
      ...DEFAULT_FILTER_DRAWER_AVAILABILITY,
      genre: false,
      runtime: false,
    });
    expect(notes.join(" ")).toContain("genre");
    expect(notes.join(" ")).toContain("runtime");
  });
});
