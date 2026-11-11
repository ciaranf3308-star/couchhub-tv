/**
 * C5 shared filter API (0.10.0, W5): genre / content type / decade /
 * rating / runtime / sort — only the filters the available metadata
 * supports — plus the detail → back persistence round-trip.
 * Also pins the pre-existing year/rating helpers W2's adapters use.
 */
import { describe, it, expect } from "vitest";
import {
  YEAR_ORDER,
  RATING_OPTIONS,
  parseYear,
  decadeKeyForYear,
  yearMatches,
  ratingMatches,
  computeYearOptions,
  SORT_OPTIONS,
  RUNTIME_OPTIONS,
  DEFAULT_BROWSE_FILTERS,
  isDefaultBrowseFilterState,
  parseRuntimeMinutes,
  formatRuntimeMinutes,
  runtimeMatches,
  genreMatches,
  genreTokensOf,
  computeGenreOptions,
  contentTypeMatches,
  computeContentTypeOptions,
  computeFilterAvailability,
  applyBrowseFilters,
  sortBrowseEntries,
  filterControlDescriptors,
  serializeBrowseFilterState,
  parseBrowseFilterState,
  browseFilterStorageKey,
  saveBrowseFilterState,
  loadBrowseFilterState,
  clearBrowseFilterState,
  type BrowseFilterState,
  type BrowseFilterEntry,
} from "@/scripts/lib/browse-filters";

const FULL: BrowseFilterEntry[] = [
  { name: "Alpha", year: "2024", rating: "8.5", duration: "2h 5m", genreIds: ["action"], type: "movie", added: 300 },
  { name: "Beta", year: "1998", rating: "7.1", duration: "45m", genreIds: ["comedy"], type: "movie", added: 100 },
  { name: "Gamma", year: "2021", rating: "9.2", duration: "1h 30m", genres: ["Drama", "Crime"], type: "series", added: 200 },
  { name: "Delta", year: "", rating: "", duration: "", category: "Documentary", type: "series", added: 0 },
];

function state(patch: Partial<BrowseFilterState> = {}): BrowseFilterState {
  return { ...DEFAULT_BROWSE_FILTERS, ...patch };
}

describe("legacy year/rating helpers (unchanged)", () => {
  it("parses the first 4-digit year and rejects out-of-range values", () => {
    expect(parseYear("2024")).toBe(2024);
    expect(parseYear("2024-03-01")).toBe(2024);
    expect(parseYear("")).toBeNull();
    expect(parseYear("1899")).toBeNull();
    expect(parseYear("2101")).toBeNull();
  });

  it("maps years to decade keys", () => {
    expect(decadeKeyForYear(2024)).toBe("2020s");
    expect(decadeKeyForYear(1975)).toBe("older");
    expect(decadeKeyForYear(null)).toBe("");
  });

  it("yearMatches honours the decade filter and passes empty filters", () => {
    expect(yearMatches("2024", "2020s")).toBe(true);
    expect(yearMatches("1998", "2020s")).toBe(false);
    expect(yearMatches("", "2020s")).toBe(false);
    expect(yearMatches("1998", "")).toBe(true);
  });

  it("ratingMatches treats unrated titles as 0 (hidden by any minimum)", () => {
    expect(ratingMatches("8.5", 8)).toBe(true);
    expect(ratingMatches("7.1", 8)).toBe(false);
    expect(ratingMatches("", 6)).toBe(false);
    expect(ratingMatches("", 0)).toBe(true);
  });

  it("computeYearOptions lists only the decades actually present", () => {
    expect(computeYearOptions(FULL)).toEqual(["2020s", "1990s"]);
    expect(computeYearOptions([])).toEqual([]);
    expect(YEAR_ORDER[0]).toBe("2030s");
    expect(RATING_OPTIONS).toEqual([0, 6, 7, 8, 9]);
  });
});

describe("parseRuntimeMinutes / formatRuntimeMinutes", () => {
  it("reads every provider duration shape the adapters carry", () => {
    expect(parseRuntimeMinutes("2h 5m")).toBe(125);
    expect(parseRuntimeMinutes("1h 30m")).toBe(90);
    expect(parseRuntimeMinutes("45m")).toBe(45);
    expect(parseRuntimeMinutes("1h")).toBe(60);
    expect(parseRuntimeMinutes("125 min")).toBe(125);
    expect(parseRuntimeMinutes("02:05:00")).toBe(125);
    expect(parseRuntimeMinutes("1:30")).toBe(90);
    expect(parseRuntimeMinutes("125")).toBe(125);
    expect(parseRuntimeMinutes(5400)).toBe(90); // bare seconds (duration_secs)
    expect(parseRuntimeMinutes(90)).toBe(90);
  });

  it("never guesses: unparseable or empty reads as null", () => {
    expect(parseRuntimeMinutes("")).toBeNull();
    expect(parseRuntimeMinutes(null)).toBeNull();
    expect(parseRuntimeMinutes("abc")).toBeNull();
    expect(parseRuntimeMinutes("0")).toBeNull();
    expect(parseRuntimeMinutes("0m")).toBeNull();
  });

  it("formats whole minutes back to human text", () => {
    expect(formatRuntimeMinutes(125)).toBe("2h 5m");
    expect(formatRuntimeMinutes(45)).toBe("45m");
    expect(formatRuntimeMinutes(60)).toBe("1h");
    expect(formatRuntimeMinutes(0)).toBe("");
    expect(formatRuntimeMinutes(null)).toBe("");
  });

  it("runtimeMatches hides titles with no parseable runtime under any limit", () => {
    expect(runtimeMatches({ duration: "45m" }, 60)).toBe(true);
    expect(runtimeMatches({ duration: "2h 5m" }, 60)).toBe(false);
    expect(runtimeMatches({ duration: "" }, 60)).toBe(false);
    expect(runtimeMatches({ duration: "" }, 0)).toBe(true);
    expect(runtimeMatches({ runtime: "90" }, 90)).toBe(true);
  });
});

describe("genre / content-type matching", () => {
  it("genreMatches reads ids, lists and category strings (case-insensitive)", () => {
    expect(genreMatches({ genreIds: ["action"] }, "action")).toBe(true);
    expect(genreMatches({ genreIds: ["Action"] }, "ACTION")).toBe(true);
    expect(genreMatches({ genres: ["Drama", "Crime"] }, "crime")).toBe(true);
    expect(genreMatches({ genre: "Comedy, Drama" }, "drama")).toBe(true);
    expect(genreMatches({ category: "Documentary" }, "documentary")).toBe(true);
    expect(genreMatches({ genreIds: ["action"] }, "comedy")).toBe(false);
    expect(genreMatches({ genreIds: ["action"] }, "")).toBe(true);
    expect(genreMatches(null, "action")).toBe(false);
  });

  it("genreTokensOf dedupes and never throws on junk", () => {
    expect(genreTokensOf(null)).toEqual([]);
    expect(genreTokensOf({ genreIds: ["action", "action"], genre: "Action" })).toEqual(["action"]);
  });

  it("computeGenreOptions ranks the genres actually present", () => {
    const opts = computeGenreOptions(FULL);
    expect(opts[0]).toEqual({ id: "action", count: 1 });
    expect(opts.map((o) => o.id)).toContain("drama");
  });

  it("contentTypeMatches reads the kind field only — never the genre", () => {
    expect(contentTypeMatches({ type: "movie" }, "movie")).toBe(true);
    expect(contentTypeMatches({ type: "vod" }, "movie")).toBe(true);
    expect(contentTypeMatches({ type: "film" }, "movie")).toBe(true);
    expect(contentTypeMatches({ kind: "series" }, "series")).toBe(true);
    expect(contentTypeMatches({ kind: "tv" }, "series")).toBe(true);
    expect(contentTypeMatches({ type: "movie" }, "series")).toBe(false);
    // A crime documentary's category must NOT make it a series/drama.
    expect(contentTypeMatches({ category: "Crime", type: "movie" }, "series")).toBe(false);
    expect(contentTypeMatches({ type: "movie" }, "")).toBe(true);
  });

  it("computeContentTypeOptions lists only the kinds present", () => {
    expect(computeContentTypeOptions(FULL)).toEqual(["movie", "series"]);
    expect(computeContentTypeOptions([{ type: "movie" }])).toEqual(["movie"]);
    expect(computeContentTypeOptions([])).toEqual([]);
  });
});

describe("computeFilterAvailability (metadata gating)", () => {
  it("enables nothing on an empty catalogue except Default / A–Z sort", () => {
    const a = computeFilterAvailability([]);
    expect(a).toEqual({
      genre: false,
      contentType: false,
      year: false,
      rating: false,
      runtime: false,
      sorts: ["default", "az"],
    });
  });

  it("enables every filter on a full catalogue", () => {
    const a = computeFilterAvailability(FULL);
    expect(a.genre).toBe(true);
    expect(a.contentType).toBe(true);
    expect(a.year).toBe(true);
    expect(a.rating).toBe(true);
    expect(a.runtime).toBe(true);
    expect(a.sorts).toContain("rating");
    expect(a.sorts).toContain("year-desc");
    expect(a.sorts).toContain("runtime-asc");
    expect(a.sorts).toContain("added");
  });

  it("withholds the content-type filter when only one kind is present", () => {
    const a = computeFilterAvailability([{ type: "movie", year: "2024" }]);
    expect(a.contentType).toBe(false);
    expect(a.year).toBe(true);
  });

  it("withholds rating sort when nothing is rated", () => {
    const a = computeFilterAvailability([{ name: "X", year: "2024" }]);
    expect(a.rating).toBe(false);
    expect(a.sorts).not.toContain("rating");
  });
});

describe("applyBrowseFilters + sortBrowseEntries", () => {
  it("the default state filters nothing", () => {
    expect(applyBrowseFilters(FULL, state())).toHaveLength(4);
    expect(isDefaultBrowseFilterState(state())).toBe(true);
    expect(isDefaultBrowseFilterState(state({ genre: "action" }))).toBe(false);
  });

  it("combines genre, decade, rating and runtime", () => {
    expect(applyBrowseFilters(FULL, state({ genre: "action" })).map((e) => e.name)).toEqual(["Alpha"]);
    expect(applyBrowseFilters(FULL, state({ year: "2020s" })).map((e) => e.name)).toEqual(["Alpha", "Gamma"]);
    expect(applyBrowseFilters(FULL, state({ minRating: 9 })).map((e) => e.name)).toEqual(["Gamma"]);
    expect(applyBrowseFilters(FULL, state({ maxRuntime: 60 })).map((e) => e.name)).toEqual(["Beta"]);
    expect(applyBrowseFilters(FULL, state({ contentType: "series" })).map((e) => e.name)).toEqual(["Gamma", "Delta"]);
    expect(
      applyBrowseFilters(FULL, state({ year: "2020s", minRating: 9 })).map((e) => e.name),
    ).toEqual(["Gamma"]);
  });

  it("sorts by year, rating, title and runtime with a title tiebreak", () => {
    expect(sortBrowseEntries(FULL, "year-desc").map((e) => e.name)).toEqual(["Alpha", "Gamma", "Beta", "Delta"]);
    expect(sortBrowseEntries(FULL, "year-asc").map((e) => e.name)).toEqual(["Beta", "Gamma", "Alpha", "Delta"]);
    expect(sortBrowseEntries(FULL, "rating").map((e) => e.name)).toEqual(["Gamma", "Alpha", "Beta", "Delta"]);
    expect(sortBrowseEntries(FULL, "az").map((e) => e.name)).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
    expect(sortBrowseEntries(FULL, "runtime-asc").map((e) => e.name)).toEqual(["Beta", "Gamma", "Alpha", "Delta"]);
    expect(sortBrowseEntries(FULL, "runtime-desc").map((e) => e.name)).toEqual(["Alpha", "Gamma", "Beta", "Delta"]);
    expect(sortBrowseEntries(FULL, "default").map((e) => e.name)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(sortBrowseEntries(FULL, "bogus" as never).map((e) => e.name)).toEqual([
      "Alpha", "Beta", "Gamma", "Delta",
    ]);
  });

  it("SORT_OPTIONS covers the adapter sort modes plus the gated runtime orders", () => {
    const ids = SORT_OPTIONS.map((o) => o.value);
    for (const id of ["default", "added", "rating", "year-desc", "year-asc", "az"] as const) {
      expect(ids).toContain(id);
    }
    expect(ids).toContain("runtime-asc");
    expect(ids).toContain("runtime-desc");
  });
});

describe("filterControlDescriptors (one control per filter)", () => {
  it("returns exactly six select descriptors — never per-value pills", () => {
    const a = computeFilterAvailability(FULL);
    const descs = filterControlDescriptors(state(), a, FULL);
    expect(descs.map((d) => d.id)).toEqual([
      "genre", "contentType", "year", "minRating", "maxRuntime", "sort",
    ]);
    for (const d of descs) expect(d.kind).toBe("select");
  });

  it("disables unsupported filters instead of hiding them", () => {
    const a = computeFilterAvailability([]);
    const descs = filterControlDescriptors(state(), a, []);
    const byId = Object.fromEntries(descs.map((d) => [d.id, d]));
    expect(byId.genre.disabled).toBe(true);
    expect(byId.contentType.disabled).toBe(true);
    expect(byId.year.disabled).toBe(true);
    expect(byId.minRating.disabled).toBe(true);
    expect(byId.maxRuntime.disabled).toBe(true);
    expect(byId.sort.disabled).toBe(false); // Default / A–Z always work
    expect(byId.genre.options[0]).toEqual({ value: "", label: "All genres" });
    expect(byId.sort.options.map((o) => o.value)).toEqual(["default", "az"]);
  });

  it("carries the current state as the selected value", () => {
    const a = computeFilterAvailability(FULL);
    const descs = filterControlDescriptors(
      state({ genre: "action", year: "2020s", minRating: 8, maxRuntime: 120, sort: "rating" }),
      a,
      FULL,
    );
    const byId = Object.fromEntries(descs.map((d) => [d.id, d]));
    expect(byId.genre.value).toBe("action");
    expect(byId.year.value).toBe("2020s");
    expect(byId.minRating.value).toBe("8");
    expect(byId.maxRuntime.value).toBe("120");
    expect(byId.sort.value).toBe("rating");
    expect(byId.maxRuntime.options.map((o) => o.value)).toEqual(
      RUNTIME_OPTIONS.map(String),
    );
  });
});

describe("filter persistence (detail → back)", () => {
  it("serializes and parses a full state, and falls back on garbage", () => {
    const s = state({ genre: "action", year: "2020s", minRating: 8, maxRuntime: 120, sort: "rating" });
    expect(parseBrowseFilterState(serializeBrowseFilterState(s))).toEqual(s);
    expect(parseBrowseFilterState("not json")).toEqual(DEFAULT_BROWSE_FILTERS);
    expect(parseBrowseFilterState(null)).toEqual(DEFAULT_BROWSE_FILTERS);
    expect(parseBrowseFilterState({ genre: "action" })).toEqual(
      state({ genre: "action" }),
    );
    expect(
      parseBrowseFilterState({ year: "2050s", minRating: 3, maxRuntime: 42, sort: "nope" }),
    ).toEqual(DEFAULT_BROWSE_FILTERS);
  });

  it("keys storage per scope", () => {
    expect(browseFilterStorageKey("movies")).toBe("rs-browse-filters-v1:movies");
    expect(browseFilterStorageKey("")).toBe("rs-browse-filters-v1:browse");
  });

  it("round-trips through sessionStorage and clears cleanly", () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const prev = (globalThis as Record<string, unknown>).sessionStorage;
    (globalThis as Record<string, unknown>).sessionStorage = fake;
    try {
      expect(loadBrowseFilterState("movies")).toBeNull();
      const s = state({ genre: "comedy", sort: "az" });
      saveBrowseFilterState("movies", s);
      expect(loadBrowseFilterState("movies")).toEqual(s);
      expect(loadBrowseFilterState("series")).toBeNull();
      clearBrowseFilterState("movies");
      expect(loadBrowseFilterState("movies")).toBeNull();
    } finally {
      if (prev === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
      else (globalThis as Record<string, unknown>).sessionStorage = prev;
    }
  });

  it("never throws when storage is unavailable (node / private mode)", () => {
    expect(() => saveBrowseFilterState("movies", DEFAULT_BROWSE_FILTERS)).not.toThrow();
    expect(() => loadBrowseFilterState("movies")).not.toThrow();
    expect(() => clearBrowseFilterState("movies")).not.toThrow();
  });
});
