// B09 runtime filter + sessionStorage persistence (0.10.0 integration).
//
// The shared browse controller (couch-browse.ts) wires the runtime
// filter through W5's C5 API: a Length select built only when the
// catalogue carries runtime metadata, and filter state saved to /
// restored from sessionStorage on every change / load. The pure
// halves are tested here; the controller wiring is asserted at the
// source level, the way tests/browse-nav-redirects.test.ts does.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_OPTIONS,
  RUNTIME_OPTION_LABELS,
  parseRuntimeMinutes,
  runtimeMatches,
  computeFilterAvailability,
  saveBrowseFilterState,
  loadBrowseFilterState,
  parseBrowseFilterState,
  DEFAULT_BROWSE_FILTERS,
} from "@/scripts/lib/browse-filters";
import { filterMovies, mapMovieRow } from "@/scripts/movies/couch-movies";
import { filterSeries } from "@/scripts/series/couch-series";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// In-memory sessionStorage (same approach as
// tests/couch-browse-landing.test.ts used before its module was deleted).
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

describe("B09 — runtime filter (pure halves)", () => {
  it("parses provider durations the same way the meta line does", () => {
    expect(parseRuntimeMinutes("125 min")).toBe(125);
    expect(parseRuntimeMinutes("2h 5m")).toBe(125);
    expect(parseRuntimeMinutes("02:05:00")).toBe(125);
    expect(parseRuntimeMinutes(7260)).toBe(121); // duration_secs
    expect(parseRuntimeMinutes("")).toBeNull();
    expect(parseRuntimeMinutes(undefined)).toBeNull();
  });

  it("runtimeMatches keeps only titles within the limit; unrated runtime hides", () => {
    expect(runtimeMatches({ duration: "90 min" }, 120)).toBe(true);
    expect(runtimeMatches({ duration: "150 min" }, 120)).toBe(false);
    expect(runtimeMatches({ duration: "120 min" }, 120)).toBe(true);
    expect(runtimeMatches({ duration: "" }, 120)).toBe(false);
    expect(runtimeMatches({ duration: "90 min" }, 0)).toBe(true);
  });

  it("filterMovies honours maxRuntime and leaves everything with 0", () => {
    const rows = [
      movie({ id: 1, name: "Short", duration: "85 min" }),
      movie({ id: 2, name: "Long", duration: "180 min" }),
      movie({ id: 3, name: "No runtime", duration: "" }),
    ];
    expect(filterMovies(rows, { maxRuntime: 90 }).map((r) => r.name)).toEqual(["Short"]);
    expect(filterMovies(rows, { maxRuntime: 0 }).map((r) => r.name)).toEqual([
      "Short",
      "Long",
      "No runtime",
    ]);
    expect(filterMovies(rows, {}).map((r) => r.name)).toEqual(["Short", "Long", "No runtime"]);
  });

  it("filterSeries honours maxRuntime when a row carries one (never offered otherwise)", () => {
    const rows = [
      {
        id: 1,
        name: "A",
        logo: null,
        year: "2024",
        rating: "8",
        category: "Drama",
        plot: "",
        added: 1,
        norm: "a",
        tmdb: null,
        duration: "45 min",
      } as never,
      {
        id: 2,
        name: "B",
        logo: null,
        year: "2024",
        rating: "8",
        category: "Drama",
        plot: "",
        added: 1,
        norm: "b",
        tmdb: null,
        duration: "90 min",
      } as never,
    ];
    expect(filterSeries(rows, { maxRuntime: 60 }).map((r) => r.name)).toEqual(["A"]);
  });

  it("runtime availability follows the metadata actually present", () => {
    expect(computeFilterAvailability([movie({ duration: "125 min" })]).runtime).toBe(true);
    expect(computeFilterAvailability([movie({ duration: "" })]).runtime).toBe(false);
    // Series rows carry no duration, so the Length control is never
    // offered on /series — the C5 rule, not a special case.
    expect(
      computeFilterAvailability([
        {
          id: 1,
          name: "A",
          year: "2024",
          rating: "8",
          category: "Drama",
        } as never,
      ]).runtime,
    ).toBe(false);
  });

  it("runtime buckets are labelled, ordered, and include Any", () => {
    expect(RUNTIME_OPTIONS).toEqual([0, 60, 90, 120, 150, 180]);
    expect(RUNTIME_OPTION_LABELS[0]).toBe("Any length");
    expect(RUNTIME_OPTION_LABELS[90]).toBe("Under 1½ hours");
  });
});

describe("B09 — filter persistence (sessionStorage, C5 API)", () => {
  it("round-trips a full filter state per scope", () => {
    const storage = makeStorage();
    vi.stubGlobal("sessionStorage", storage);
    try {
      saveBrowseFilterState("movies", {
        ...DEFAULT_BROWSE_FILTERS,
        genre: "action",
        year: "2020s",
        minRating: 8,
        maxRuntime: 120,
        sort: "rating",
      });
      const restored = loadBrowseFilterState("movies");
      expect(restored).toEqual({
        genre: "action",
        contentType: "",
        year: "2020s",
        minRating: 8,
        maxRuntime: 120,
        sort: "rating",
      });
      // Scopes are independent; series keeps its own state.
      expect(loadBrowseFilterState("series")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("unknown stored values fall back to defaults instead of hiding the catalogue", () => {
    expect(
      parseBrowseFilterState(
        JSON.stringify({ genre: "action", year: "1990s", minRating: 42, maxRuntime: 999, sort: "nope" }),
      ),
    ).toEqual({ ...DEFAULT_BROWSE_FILTERS, genre: "action", year: "1990s" });
    expect(parseBrowseFilterState("not json")).toEqual(DEFAULT_BROWSE_FILTERS);
    expect(parseBrowseFilterState(null)).toEqual(DEFAULT_BROWSE_FILTERS);
  });
});

describe("B09 — controller + page wiring (source level)", () => {
  it("the shared controller restores, saves and renders the runtime filter", () => {
    const src = read("src/scripts/movies/couch-browse.ts");
    expect(src).toContain("loadBrowseFilterState(filterScope)");
    expect(src).toContain("saveBrowseFilterState(filterScope,");
    expect(src).toContain("renderRuntime()");
    expect(src).toContain("computeFilterAvailability(all as BrowseFilterEntry[]).runtime");
    expect(src).toContain("maxRuntime: filter.maxRuntime");
    expect(src).toContain('adapter.kind === "vod" ? "movies" : "series"');
    // The built select must NOT share the mount div's id
    // (duplicate ids made getElementById return the div).
    expect(src).toContain("couch-browse-runtime-select");
  });

  it("both catalogue pages carry the runtime mount point", () => {
    for (const rel of ["src/pages/movies/index.astro", "src/pages/series/index.astro"]) {
      const src = read(rel);
      expect(src).toContain('id="couch-browse-runtime"');
      expect(src).toContain("rs-browse-runtime-filter");
    }
  });

  it("both adapters pass maxRuntime into their filter functions", () => {
    expect(read("src/scripts/movies/couch-movies-adapter.ts")).toContain(
      "maxRuntime: filter.maxRuntime",
    );
    expect(read("src/scripts/series/couch-series-adapter.ts")).toContain(
      "maxRuntime: filter.maxRuntime",
    );
  });
});
