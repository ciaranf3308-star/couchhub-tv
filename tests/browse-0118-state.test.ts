// 0.11.8 W2 — browse state semantics (brief §6, §7.2, §10, §11).
import { describe, expect, it } from "vitest";
import {
  activeFilterSummary,
  allCategoryForKind,
  applyFilters,
  browsePageInfo,
  browsePageJumpWindow,
  browseSortOptions,
  browseTotalPages,
  createBrowseState,
  hasActiveBrowseConstraints,
  isDefaultBrowseFilters,
  resetAllFilters,
  selectCategory,
  setPage,
  setSearch,
  setSort,
} from "@/scripts/lib/browse-state";

describe("selectCategory REPLACES (§7.2/§10)", () => {
  it("Horror after Comedy is Horror, never Comedy AND Horror", () => {
    const s0 = createBrowseState("movie");
    const s1 = selectCategory(s0, { kind: "genre", id: "comedy", label: "Comedy" });
    const s2 = selectCategory(s1, { kind: "genre", id: "horror", label: "Horror" });
    expect(s2.category).toEqual({ kind: "genre", id: "horror", label: "Horror" });
    expect(s1.category.id).toBe("comedy");
    expect(s0.category.kind).toBe("all");
  });

  it("resets to page 1 and clears a category-scoped search", () => {
    const s0 = {
      ...createBrowseState("movie"),
      page: 4,
      search: "dune",
      searchScope: "category" as const,
    };
    const s1 = selectCategory(s0, { kind: "genre", id: "horror", label: "Horror" });
    expect(s1.page).toBe(1);
    expect(s1.search).toBe("");
    expect(s1.searchScope).toBe("all");
  });

  it("keeps a scope-all search across a category change", () => {
    const s0 = {
      ...createBrowseState("movie"),
      page: 4,
      search: "dune",
      searchScope: "all" as const,
    };
    const s1 = selectCategory(s0, { kind: "genre", id: "horror", label: "Horror" });
    expect(s1.search).toBe("dune");
    expect(s1.page).toBe(1);
  });
});

describe("applyFilters / resetAllFilters (§10)", () => {
  it("applyFilters replaces the genre and resets the page", () => {
    const s0 = {
      ...createBrowseState("movie"),
      page: 3,
      filters: { ...createBrowseState("movie").filters, genre: "comedy" },
    };
    const s1 = applyFilters(s0, { genre: "horror" });
    expect(s1.filters.genre).toBe("horror");
    expect(s1.page).toBe(1);
    expect(s0.filters.genre).toBe("comedy");
  });

  it("ONE Reset All clears everything back to the full catalogue", () => {
    const s0 = createBrowseState("series", {
      category: { kind: "genre", id: "drama", label: "Drama" },
      filters: {
        genre: "drama",
        year: "2010s",
        minRating: 8,
        runtime: "under-120",
        watchStatus: "unwatched",
        favouritesOnly: true,
        watchLaterOnly: true,
        followedOnly: true,
        newEpisodesOnly: true,
        language: "en",
        providerCategory: "provider:drama",
        seasonCount: "3+",
        seriesStatus: "ended",
      },
      search: "dark",
      searchScope: "category",
      sort: "az",
      page: 5,
      selectedId: "group:x",
    });
    const s1 = resetAllFilters(s0);
    expect(s1.category).toEqual(allCategoryForKind("series"));
    expect(isDefaultBrowseFilters(s1.filters)).toBe(true);
    expect(s1.search).toBe("");
    expect(s1.searchScope).toBe("all");
    expect(s1.sort).toBe("recommended");
    expect(s1.page).toBe(1);
    expect(s1.selectedId).toBeNull();
    expect(hasActiveBrowseConstraints(s1)).toBe(false);
  });

  it("setSearch / setSort reset the page; setPage clamps", () => {
    const s0 = { ...createBrowseState("movie"), page: 3 };
    expect(setSearch(s0, "dune").page).toBe(1);
    expect(setSort(s0, "az").page).toBe(1);
    expect(setPage(s0, 99, 4).page).toBe(4);
    expect(setPage(s0, 0).page).toBe(1);
    expect(setPage(s0, 2, 4).page).toBe(2);
  });
});

describe("activeFilterSummary (§10 — every constraint visible)", () => {
  it("renders the concise summary: category · decade · runtime", () => {
    const s = applyFilters(
      selectCategory(createBrowseState("movie"), {
        kind: "genre",
        id: "horror",
        label: "Horror",
      }),
      { year: "2010s", runtime: "under-120" },
    );
    expect(activeFilterSummary(s)).toBe("Horror · 2010s · Under 2 hours");
  });

  it("names search, scope, sort, rating, language and provider category", () => {
    const s = setSort(
      setSearch(
        applyFilters(createBrowseState("movie"), {
          minRating: 8,
          language: "fr",
          providerCategory: "provider:action",
        }),
        "dune",
        "category",
      ),
      "rating",
    );
    const summary = activeFilterSummary(s, {
      providerLabel: (id) => (id === "provider:action" ? "Action" : id),
    });
    expect(summary).toContain("8+ rated");
    expect(summary).toContain("fr");
    expect(summary).toContain("Action");
    expect(summary).toContain("“dune” in this category");
    expect(summary).toContain("Highest Rated");
  });

  it("is empty when unconstrained and names multi-select OR/AND explicitly", () => {
    expect(activeFilterSummary(createBrowseState("movie"))).toBe("");
    const s = applyFilters(createBrowseState("movie"), {
      genreMode: "multi-or",
      genres: ["action", "comedy"],
    });
    expect(activeFilterSummary(s)).toContain(" OR ");
    const s2 = applyFilters(createBrowseState("movie"), {
      genreMode: "multi-and",
      genres: ["action", "comedy"],
    });
    expect(activeFilterSummary(s2)).toContain(" AND ");
  });
});

describe("pagination (§6.2)", () => {
  it("computes pages, windows and clamps", () => {
    expect(browseTotalPages(0, 30)).toBe(0);
    expect(browseTotalPages(1, 30)).toBe(1);
    expect(browseTotalPages(90, 30)).toBe(3);
    expect(browseTotalPages(91, 30)).toBe(4);
    const info = browsePageInfo({ ...createBrowseState("movie"), page: 2 }, 90);
    expect(info).toMatchObject({
      page: 2,
      totalPages: 3,
      startIndex: 30,
      endIndex: 60,
      hasPrev: true,
      hasNext: true,
    });
    const clamped = browsePageInfo({ ...createBrowseState("movie"), page: 9 }, 90);
    expect(clamped.page).toBe(3);
  });

  it("quick-jump window centres on the current page", () => {
    expect(browsePageJumpWindow(1, 1)).toEqual([]);
    expect(browsePageJumpWindow(1, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(browsePageJumpWindow(5, 10)).toEqual([3, 4, 5, 6, 7]);
    expect(browsePageJumpWindow(10, 10)).toEqual([6, 7, 8, 9, 10]);
  });
});

describe("sort options (§11)", () => {
  it("offers the browse orders; series adds updated/seasons only with evidence", () => {
    const movie = browseSortOptions("movie", {
      added: true,
      year: true,
      rating: true,
      updated: false,
      seasons: false,
    });
    expect(movie.map((o) => o.value)).toEqual([
      "recommended",
      "added",
      "year-desc",
      "year-asc",
      "rating",
      "az",
      "za",
    ]);
    const seriesNoEvidence = browseSortOptions("series", {
      added: true,
      year: true,
      rating: true,
      updated: false,
      seasons: false,
    });
    expect(seriesNoEvidence.map((o) => o.value)).not.toContain("updated");
    expect(seriesNoEvidence.map((o) => o.value)).not.toContain("seasons");
    const seriesEvidence = browseSortOptions("series", {
      added: true,
      year: true,
      rating: true,
      updated: true,
      seasons: true,
    });
    expect(seriesEvidence.map((o) => o.value)).toContain("updated");
    expect(seriesEvidence.map((o) => o.value)).toContain("seasons");
  });

  it("omits orders without metadata instead of offering them dead", () => {
    const bare = browseSortOptions("movie", {
      added: false,
      year: false,
      rating: false,
      updated: false,
      seasons: false,
    });
    expect(bare.map((o) => o.value)).toEqual(["recommended", "az", "za"]);
  });
});
