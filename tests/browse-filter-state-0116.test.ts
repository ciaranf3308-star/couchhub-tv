// Genre-filter state audit + fix (0.11.6, AI Discovery 3.0, W4).
//
// USER-REPORTED BUG: selecting Comedy, then selecting Horror, appeared
// to progressively sub-filter results (Comedy AND Horror). The audit
// (see the report + the comments at the fix sites) found NO code path
// that accumulates two genre values into one filter state — every
// genre control in 0.11.5 is already single-value:
//
//   - BrowseFilterState.genre is one string (browse-filters.ts);
//   - the Movies/Series Genre control is one <select> whose change
//     handler assigns filter.genre (couch-browse.ts renderGenres);
//   - Discover's activeMood is one preset id, pickMood clears the
//     query (DiscoverView.svelte);
//   - the legacy TV grid's category is one nullable string
//     (tv-grid-filter.ts / catalog-grid.ts).
//
// The AND the user saw is manufactured by COMPOSITION, and two
// mechanisms reproduce it exactly:
//
//   (1) Text-query/category composition. filterMovies/filterSeries
//       match query tokens against `row.norm`, which includes the
//       provider category (couch-movies.ts / couch-series.ts). A
//       genre word left in the search box ("comedy") keeps filtering
//       by category while the Genre select adds its own genre
//       condition — the grid then shows only titles matching BOTH,
//       which reads as Comedy AND Horror. Reproduced below.
//   (2) Persisted filters with no escape hatch. Genre/decade/rating/
//       runtime/sort restore from sessionStorage on every load and
//       every detail→back trip (B09), and 0.11.5 had NO Reset Filters
//       control anywhere — each condition had to be undone by hand,
//       so a stale condition silently narrowed every later selection.
//
// The fix pins the semantics in the state layer so no future control
// can accumulate: selectGenreFilter REPLACES (with toggle-off on
// re-select), resetBrowseFilters returns fresh defaults, the
// Movies/Series controller routes genre changes through the funnel
// and gains ONE Reset Filters action, and discover-state.ts gives
// Discover (W3) fresh-request helpers so a quick pick / New Search
// can never carry hidden filters.
//
// Reproduce-first: on the unmodified 0.11.5 base this file FAILS —
// the state helpers and the Reset wiring do not exist (import /
// source assertions fail), while the mechanism-reproduction tests
// PASS on base behaviour, proving the AND exists before the fix.
// After the fix the whole file passes: the mechanism tests keep
// pinning the (intended, visible-query) matcher composition, and the
// state/wiring tests pin the remedy.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BROWSE_FILTERS,
  isDefaultBrowseFilterState,
  applyBrowseFilters,
  parseBrowseFilterState,
  serializeBrowseFilterState,
  saveBrowseFilterState,
  loadBrowseFilterState,
  clearBrowseFilterState,
  selectGenreFilter,
  resetBrowseFilters,
  type BrowseFilterState,
} from "@/scripts/lib/browse-filters";
import {
  freshDiscoveryState,
  applyQuickPick,
  applyNewSearch,
  selectDiscoveryGenre,
  type DiscoverySearchState,
} from "@/scripts/lib/discover-state";
import { filterMovies, mapMovieRow } from "@/scripts/movies/couch-movies";
import { filterSeries, mapSeriesRow } from "@/scripts/series/couch-series";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// In-memory sessionStorage (same approach as
// tests/browse-010-runtime-filter.test.ts).
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function withStorage<T>(fn: () => T): T {
  const prev = (globalThis as Record<string, unknown>).sessionStorage;
  (globalThis as Record<string, unknown>).sessionStorage = makeStorage();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
    else (globalThis as Record<string, unknown>).sessionStorage = prev;
  }
}

function movie(overrides: Record<string, unknown> = {}) {
  const row = mapMovieRow({
    stream_id: overrides.id ?? 1,
    name: overrides.name ?? "Test Film",
    year: overrides.year ?? "2024",
    rating: overrides.rating ?? "8.0",
    duration: overrides.duration ?? "125 min",
    category_name: overrides.category ?? "Action",
    added: 1,
  });
  if (!row) throw new Error("fixture row did not map");
  return row;
}

function series(overrides: Record<string, unknown> = {}) {
  const row = mapSeriesRow({
    series_id: overrides.id ?? 1,
    name: overrides.name ?? "Test Series",
    year: overrides.year ?? "2024",
    rating: overrides.rating ?? "8.0",
    category_name: overrides.category ?? "Drama",
    added: 1,
  });
  if (!row) throw new Error("fixture row did not map");
  return row;
}

const COMEDY_STATE: BrowseFilterState = {
  ...DEFAULT_BROWSE_FILTERS,
  genre: "comedy",
};

describe("W4 — selectGenreFilter: replace, never accumulate", () => {
  it("Comedy -> Horror replaces the genre (no Comedy AND Horror state)", () => {
    const next = selectGenreFilter(COMEDY_STATE, "horror");
    expect(next.genre).toBe("horror");
    expect(next).not.toBe(COMEDY_STATE);
    // The input is untouched: the old state never gains a second genre.
    expect(COMEDY_STATE.genre).toBe("comedy");
  });

  it("re-selecting the same genre clears it (toggle off)", () => {
    expect(selectGenreFilter(COMEDY_STATE, "comedy").genre).toBe("");
    // Case-insensitive: the select carries canonical ids, labels vary.
    expect(selectGenreFilter(COMEDY_STATE, "Comedy").genre).toBe("");
    expect(selectGenreFilter({ ...COMEDY_STATE, genre: "horror" }, "horror").genre).toBe("");
  });

  it("null / empty clears the genre", () => {
    expect(selectGenreFilter(COMEDY_STATE, null).genre).toBe("");
    expect(selectGenreFilter(COMEDY_STATE, "").genre).toBe("");
    expect(selectGenreFilter(COMEDY_STATE, "   ").genre).toBe("");
  });

  it("trims the incoming genre and preserves every other field", () => {
    const state: BrowseFilterState = {
      genre: "comedy",
      contentType: "",
      year: "2020s",
      minRating: 8,
      maxRuntime: 120,
      sort: "rating",
    };
    const next = selectGenreFilter(state, "  horror  ");
    expect(next).toEqual({
      genre: "horror",
      contentType: "",
      year: "2020s",
      minRating: 8,
      maxRuntime: 120,
      sort: "rating",
    });
  });

  it("a replaced genre filters exactly that genre at the apply layer", () => {
    const entries = [
      { title: "Funny Only", genreIds: ["comedy"], year: "2024", rating: "8" },
      { title: "Scary Only", genreIds: ["horror"], year: "2024", rating: "8" },
      { title: "Both Genres", genreIds: ["comedy", "horror"], year: "2024", rating: "8" },
      { title: "Neither", genreIds: ["drama"], year: "2024", rating: "8" },
    ];
    const horror = selectGenreFilter(COMEDY_STATE, "horror");
    expect(applyBrowseFilters(entries, horror).map((e) => e.title)).toEqual([
      "Scary Only",
      "Both Genres",
    ]);
    const comedy = selectGenreFilter(horror, "comedy");
    expect(applyBrowseFilters(entries, comedy).map((e) => e.title)).toEqual([
      "Funny Only",
      "Both Genres",
    ]);
    // Toggle-off returns the whole catalogue: no hidden genre survives.
    expect(
      applyBrowseFilters(entries, selectGenreFilter(comedy, "comedy")).map((e) => e.title),
    ).toEqual(["Funny Only", "Scary Only", "Both Genres", "Neither"]);
  });
});

describe("W4 — resetBrowseFilters", () => {
  it("returns the default state", () => {
    expect(resetBrowseFilters()).toEqual(DEFAULT_BROWSE_FILTERS);
    expect(isDefaultBrowseFilterState(resetBrowseFilters())).toBe(true);
  });

  it("returns a fresh object every call (mutating one never poisons the next)", () => {
    const first = resetBrowseFilters();
    first.genre = "horror";
    first.minRating = 9;
    expect(resetBrowseFilters()).toEqual(DEFAULT_BROWSE_FILTERS);
    expect(DEFAULT_BROWSE_FILTERS.genre).toBe("");
    expect(DEFAULT_BROWSE_FILTERS.minRating).toBe(0);
    expect(resetBrowseFilters()).not.toBe(resetBrowseFilters());
  });
});

describe("W4 — reproduction: the AND the user saw (matcher composition)", () => {
  it("Movies: a genre word left in the search box ANDs with the Genre select", () => {
    const rows = [
      movie({ id: 1, name: "Funny Bone", category: "Comedy" }),
      movie({ id: 2, name: "Night Terrors", category: "Horror" }),
    ];
    // Search alone finds the comedy (the query matches the category).
    expect(filterMovies(rows, { query: "comedy" }).map((r) => r.name)).toEqual(["Funny Bone"]);
    // Genre alone finds the horror.
    expect(filterMovies(rows, { genre: "horror" }).map((r) => r.name)).toEqual(["Night Terrors"]);
    // Both together: NOTHING matches — the stale "comedy" query
    // (category haystack) intersects the new Horror selection. This
    // is the Comedy AND Horror the user reported. The composition is
    // intended while the query is visibly active in the search box;
    // the remedy is replace semantics + the one-press Reset Filters
    // action (wired below), not a second genre value.
    expect(filterMovies(rows, { query: "comedy", genre: "horror" })).toEqual([]);
  });

  it("Series: same composition via the shared haystack design", () => {
    const rows = [
      series({ id: 1, name: "Funny Bone", category: "Comedy" }),
      series({ id: 2, name: "Night Terrors", category: "Horror" }),
    ];
    expect(filterSeries(rows, { query: "comedy", genre: "horror" })).toEqual([]);
    expect(filterSeries(rows, { genre: "horror" }).map((r) => r.name)).toEqual(["Night Terrors"]);
  });
});

describe("W4 — persisted state: only visible filters survive a fresh genre selection", () => {
  it("a stored state carries no text query: unknown stored fields are dropped", () => {
    const parsed = parseBrowseFilterState({
      genre: "comedy",
      year: "2020s",
      minRating: 8,
      maxRuntime: 120,
      sort: "rating",
      // A stale text query must never smuggle itself through persistence.
      query: "comedy",
      genreList: ["comedy", "horror"],
    });
    expect(parsed).toEqual({
      genre: "comedy",
      contentType: "",
      year: "2020s",
      minRating: 8,
      maxRuntime: 120,
      sort: "rating",
    });
    expect(serializeBrowseFilterState(parsed)).not.toContain("query");
  });

  it("selecting Horror over stale persisted Comedy keeps ONLY the visible filters", () => {
    const entries = [
      { title: "Horror 2020s 8+", genreIds: ["horror"], year: "2024", rating: "8.5" },
      { title: "Horror 1990s", genreIds: ["horror"], year: "1995", rating: "8.5" },
      { title: "Comedy 2020s 8+", genreIds: ["comedy"], year: "2024", rating: "8.5" },
      { title: "Horror 2020s low", genreIds: ["horror"], year: "2024", rating: "5" },
    ];
    const stale = parseBrowseFilterState(
      JSON.stringify({
        genre: "comedy",
        contentType: "",
        year: "2020s",
        minRating: 8,
        maxRuntime: 0,
        sort: "default",
      }),
    );
    const next = selectGenreFilter(stale, "horror");
    // Genre replaced; decade + rating are VISIBLE selects the user set,
    // so they still apply — and nothing else does.
    expect(next.genre).toBe("horror");
    expect(applyBrowseFilters(entries, next).map((e) => e.title)).toEqual(["Horror 2020s 8+"]);
  });

  it("scopes do not leak: a Movies filter never narrows Series", () => {
    withStorage(() => {
      saveBrowseFilterState("movies", { ...DEFAULT_BROWSE_FILTERS, genre: "horror" });
      expect(loadBrowseFilterState("series")).toBeNull();
      expect(loadBrowseFilterState("movies")?.genre).toBe("horror");
    });
  });

  it("reset clears the persisted entry: a later load cannot resurrect it", () => {
    withStorage(() => {
      saveBrowseFilterState("movies", { ...DEFAULT_BROWSE_FILTERS, genre: "comedy" });
      clearBrowseFilterState("movies");
      expect(loadBrowseFilterState("movies")).toBeNull();
      // And saving the reset state is equally clean on the next load.
      saveBrowseFilterState("movies", resetBrowseFilters());
      expect(loadBrowseFilterState("movies")).toEqual(DEFAULT_BROWSE_FILTERS);
    });
  });
});

describe("W4 — discover-state: quick picks and New Search start fresh", () => {
  it("freshDiscoveryState is empty on every field, fresh object every call", () => {
    expect(freshDiscoveryState()).toEqual({ query: "", activeMood: null, genre: null });
    const first = freshDiscoveryState();
    first.query = "comedy";
    expect(freshDiscoveryState().query).toBe("");
    expect(freshDiscoveryState()).not.toBe(freshDiscoveryState());
  });

  it("a quick pick clears query, genre and the prior mood — nothing carries over", () => {
    const dirty: DiscoverySearchState = {
      query: "something funny",
      activeMood: "easy",
      genre: "comedy",
    };
    const next = applyQuickPick(dirty, "intense");
    expect(next).toEqual({ query: "", activeMood: "intense", genre: null });
    expect(next).not.toBe(dirty);
    expect(dirty).toEqual({ query: "something funny", activeMood: "easy", genre: "comedy" });
  });

  it("quick pick after quick pick replaces the mood (no accumulation)", () => {
    const first = applyQuickPick(freshDiscoveryState(), "easy");
    const second = applyQuickPick(first, "intense");
    expect(second.activeMood).toBe("intense");
    expect(second.query).toBe("");
    expect(second.genre).toBeNull();
  });

  it("New Search clears everything (conversation is cleared alongside by W3)", () => {
    const dirty: DiscoverySearchState = {
      query: "comedy horror",
      activeMood: "intense",
      genre: "horror",
    };
    void dirty;
    expect(applyNewSearch()).toEqual(freshDiscoveryState());
  });

  it("Discover genre selection replaces, and re-selecting the same genre clears it", () => {
    const state: DiscoverySearchState = { query: "", activeMood: null, genre: "comedy" };
    expect(selectDiscoveryGenre(state, "horror")).toEqual({
      query: "",
      activeMood: null,
      genre: "horror",
    });
    expect(selectDiscoveryGenre(state, "comedy").genre).toBeNull();
    expect(selectDiscoveryGenre(state, null).genre).toBeNull();
    expect(state.genre).toBe("comedy");
  });

  it("Discover genre selection replaces only the genre (query/mood are visible state)", () => {
    const state: DiscoverySearchState = {
      query: "for tonight",
      activeMood: "easy",
      genre: "comedy",
    };
    expect(selectDiscoveryGenre(state, "horror")).toEqual({
      query: "for tonight",
      activeMood: "easy",
      genre: "horror",
    });
  });
});

describe("W4 — Movies/Series controller wiring (source level, repo convention)", () => {
  const browse = () => read("src/scripts/movies/couch-browse.ts");

  it("genre changes route through selectGenreFilter (the one replace funnel)", () => {
    expect(browse()).toContain("selectGenreFilter(");
  });

  it("ONE Reset Filters action exists, wired to resetBrowseFilters + persisted-state clear", () => {
    const src = browse();
    expect(src).toContain("resetBrowseFilters(");
    expect(src).toContain("clearBrowseFilterState(");
    expect(src).toContain("Reset filters");
    expect(src).toContain("couch-browse-reset");
  });

  it("both Movies and Series pages host the Reset mount in the filter row", () => {
    expect(read("src/pages/movies/index.astro")).toContain("couch-browse-reset");
    expect(read("src/pages/series/index.astro")).toContain("couch-browse-reset");
  });

  it("DiscoverView uses the one W4 state module, not a second filter system", () => {
    // Integration: W3's DiscoverView rewrite consumes W4's real
    // transitions (applyQuickPick/applyNewSearch from
    // discover-state.ts) — the branch-local "untouched" guard cannot
    // hold once the branches merge. The durable invariant is that
    // DiscoverView gains no SECOND filter system: no BrowseFilterState
    // helper (selectGenreFilter) on a screen with no browse filters.
    const view = read("src/components/DiscoverView.svelte")
    expect(view).toContain("@/scripts/lib/discover-state.ts")
    expect(view).toContain("applyQuickPick")
    expect(view).toContain("applyNewSearch")
    expect(view).not.toContain("selectGenreFilter")
  });
});
