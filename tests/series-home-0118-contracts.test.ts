// Series Home W1/W2 contract tests (0.11.8, W4) — the shim APIs
// must carry REAL contract semantics: the selectors, the 15 TV
// genre families, rating normalisation, and the mode/URL contract.
// When integration deletes the shims, these same assertions pin the
// real W1/W2 modules. Also: static guards that the home modules
// never resolve series info (cached reads only) and carry the SHIM
// marking the integration step depends on.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapSeriesRow, type SeriesRow } from "@/scripts/series/couch-series.ts";
import {
  browseModeUrl,
  CANONICAL_SERIES_GENRES,
  normaliseRating,
  parseModeFromUrl,
  rowInSeriesGenreFamily,
  selectRecentlyAdded,
  selectSeriesWorthStarting,
  seriesGenreFamilyById,
} from "@/scripts/series/series-home-shims.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcFile = (rel: string) => readFileSync(resolve(here, "..", "src", rel), "utf8");

function row(
  id: number,
  name: string,
  opts: {
    category?: string;
    rating?: string;
    year?: string;
    added?: number;
    tmdb?: number;
  } = {},
): SeriesRow {
  const mapped = mapSeriesRow({
    series_id: id,
    name,
    cover: `https://example.test/${id}.jpg`,
    year: opts.year ?? "2024",
    rating: opts.rating ?? "",
    category_name: opts.category ?? "Drama",
    last_modified: opts.added ?? 0,
    tmdb: opts.tmdb ?? 0,
  });
  if (!mapped) throw new Error(`fixture row did not map: ${name}`);
  return mapped;
}

describe("CANONICAL_SERIES_GENRES — 15 television families", () => {
  it("has exactly 15 families with stable ids and labels", () => {
    expect(CANONICAL_SERIES_GENRES).toHaveLength(15);
    const ids = CANONICAL_SERIES_GENRES.map((f) => f.id);
    expect(new Set(ids).size).toBe(15);
    for (const family of CANONICAL_SERIES_GENRES) {
      expect(family.label.length).toBeGreaterThan(0);
    }
  });

  it("is television-shaped: Reality exists, TV merges exist, no movie-only split", () => {
    const ids = CANONICAL_SERIES_GENRES.map((f) => f.id);
    expect(ids).toContain("reality");
    expect(ids).toContain("documentary");
    expect(ids).toContain("action-adventure");
    expect(ids).toContain("sci-fi-fantasy");
    expect(ids).toContain("mystery-thriller");
    expect(seriesGenreFamilyById("nope")).toBeUndefined();
    expect(seriesGenreFamilyById("drama")?.label).toBe("Drama");
  });

  it("matches families by canonical genre, and Reality by category text", () => {
    const drama = CANONICAL_SERIES_GENRES.find((f) => f.id === "drama")!;
    const reality = CANONICAL_SERIES_GENRES.find((f) => f.id === "reality")!;
    expect(rowInSeriesGenreFamily(row(1, "A", { category: "Drama" }), drama)).toBe(true);
    expect(rowInSeriesGenreFamily(row(2, "B", { category: "Comedy" }), drama)).toBe(false);
    expect(rowInSeriesGenreFamily(row(3, "C", { category: "Reality TV" }), reality)).toBe(true);
    expect(rowInSeriesGenreFamily(row(4, "Reality Star", { category: "Drama" }), reality)).toBe(false);
  });
});

describe("normaliseRating — no invented ratings", () => {
  it("normalises a provider rating to a 0–10 value and label", () => {
    expect(normaliseRating("8.4")).toEqual({ value10: 8.4, label: "★ 8.4", hasEvidence: true });
    expect(normaliseRating(7)).toEqual({ value10: 7, label: "★ 7.0", hasEvidence: true });
  });

  it("clamps above 10 and rejects garbage/empty/zero", () => {
    expect(normaliseRating("12").value10).toBe(10);
    for (const raw of ["", "0", 0, null, undefined, "N/A", Number.NaN]) {
      expect(normaliseRating(raw)).toEqual({ value10: null, label: null, hasEvidence: false });
    }
  });
});

describe("selectSeriesWorthStarting — unwatched, evidenced, diverse", () => {
  it("returns at most the limit, highest-rated first, unwatched only", () => {
    const rows = [
      row(1, "Low", { rating: "7.1", tmdb: 1 }),
      row(2, "High", { rating: "9.2", tmdb: 2 }),
      row(3, "Watched High", { rating: "9.9", tmdb: 3 }),
      row(4, "Unrated", { rating: "", tmdb: 4 }),
      row(5, "Below Bar", { rating: "6.5", tmdb: 5 }),
    ];
    const picked = selectSeriesWorthStarting(rows, {
      hasProgress: (r) => r.id === 3,
      limit: 3,
    });
    expect(picked.map((r) => r.id)).toEqual([2, 1]);
  });

  it("prefers TMDb-linked titles over unlinked ones at the same level (C2)", () => {
    const rows = [
      row(1, "Unlinked Ten", { rating: "10.0" }),
      row(2, "Linked Eight", { rating: "8.0", tmdb: 9 }),
    ];
    const picked = selectSeriesWorthStarting(rows);
    expect(picked.map((r) => r.id)).toEqual([2]);
  });

  it("spreads across genres instead of collapsing to one", () => {
    const rows: SeriesRow[] = [];
    for (let i = 1; i <= 6; i++) {
      rows.push(row(i, `Drama ${i}`, { category: "Drama", rating: "9.0", tmdb: i }));
    }
    rows.push(row(7, "Comedy Gem", { category: "Comedy", rating: "7.5", tmdb: 7 }));
    rows.push(row(8, "Horror Gem", { category: "Horror", rating: "7.5", tmdb: 8 }));
    const picked = selectSeriesWorthStarting(rows, { limit: 4 });
    const categories = picked.map((r) => r.category);
    expect(categories).toContain("Comedy");
    expect(categories).toContain("Horror");
    expect(picked).toHaveLength(4);
  });

  it("never pads: a small catalogue yields a short honest shelf", () => {
    expect(selectSeriesWorthStarting([row(1, "Only", { rating: "8.0", tmdb: 1 })])).toHaveLength(1);
    expect(selectSeriesWorthStarting([])).toEqual([]);
    expect(selectSeriesWorthStarting([row(1, "Low", { rating: "5.0", tmdb: 1 })])).toEqual([]);
  });

  it("returns series rows, never episode-shaped records", () => {
    const picked = selectSeriesWorthStarting([row(1, "Show", { rating: "8.0", tmdb: 1 })]);
    expect(picked[0]).toHaveProperty("id", 1);
    expect(picked[0]).not.toHaveProperty("episodeNum");
    expect(picked[0]).not.toHaveProperty("season");
  });
});

describe("selectRecentlyAdded — added timestamps, never release year", () => {
  it("orders by added timestamp descending", () => {
    const rows = [
      row(1, "Old Add", { added: 100 }),
      row(2, "New Add", { added: 300 }),
      row(3, "Mid Add", { added: 200 }),
    ];
    expect(selectRecentlyAdded(rows).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("ignores release year: a 1990 title added yesterday beats a 2026 title added last year", () => {
    const rows = [
      row(1, "Shiny New Release", { year: "2026", added: 100 }),
      row(2, "Old Classic", { year: "1990", added: 900 }),
    ];
    expect(selectRecentlyAdded(rows).map((r) => r.id)).toEqual([2, 1]);
  });

  it("excludes rows with no added timestamp", () => {
    const rows = [row(1, "No Stamp", { added: 0 }), row(2, "Stamped", { added: 5 })];
    expect(selectRecentlyAdded(rows).map((r) => r.id)).toEqual([2]);
  });

  it("caps at the limit", () => {
    const rows = [1, 2, 3, 4, 5].map((id) => row(id, `S${id}`, { added: id }));
    expect(selectRecentlyAdded(rows, { limit: 2 })).toHaveLength(2);
  });
});

describe("mode/URL contract — parseModeFromUrl / browseModeUrl", () => {
  it("defaults to home on a bare path, empty query, or unknown mode", () => {
    expect(parseModeFromUrl("")).toEqual({ mode: "home", params: {} });
    expect(parseModeFromUrl("?mode=home")).toEqual({ mode: "home", params: {} });
    expect(parseModeFromUrl("?mode=banana")).toEqual({ mode: "home", params: {} });
    expect(parseModeFromUrl("?genre=drama")).toEqual({ mode: "home", params: {} });
  });

  it("parses browse mode with genre, category, page, sort and query", () => {
    expect(parseModeFromUrl("?mode=browse&genre=drama&page=3&sort=added&query=slow")).toEqual({
      mode: "browse",
      params: { genre: "drama", page: 3, sort: "added", query: "slow" },
    });
    expect(parseModeFromUrl("?mode=browse&category=Crime%20Drama")).toEqual({
      mode: "browse",
      params: { category: "Crime Drama", page: 1 },
    });
  });

  it("is total: bad page falls back to 1, unknown sort is dropped", () => {
    expect(parseModeFromUrl("?mode=browse&page=0").params.page).toBe(1);
    expect(parseModeFromUrl("?mode=browse&page=abc").params.page).toBe(1);
    expect(parseModeFromUrl("?mode=browse&page=-4").params.page).toBe(1);
    expect(parseModeFromUrl("?mode=browse&sort=nope").params.sort).toBeUndefined();
  });

  it("builds canonical URLs: home is the bare path, browse carries params", () => {
    expect(browseModeUrl("home")).toBe("/series");
    expect(browseModeUrl("home", { genre: "drama" })).toBe("/series");
    expect(browseModeUrl("browse")).toBe("/series?mode=browse");
    expect(browseModeUrl("browse", { genre: "drama", page: 2, sort: "added" })).toBe(
      "/series?mode=browse&genre=drama&page=2&sort=added",
    );
    expect(browseModeUrl("browse", { page: 1 })).toBe("/series?mode=browse");
  });

  it("round-trips: parse(build(x)) preserves mode and params", () => {
    const params = { genre: "sci-fi-fantasy", page: 4, sort: "rating", query: "space" };
    const parsed = parseModeFromUrl(new URL(browseModeUrl("browse", params), "https://x.test").search);
    expect(parsed).toEqual({ mode: "browse", params });
  });
});

describe("static guards — shims marked, no series-info resolution from Home", () => {
  it("marks both shim files for deletion at integration with real-module mappings", () => {
    for (const rel of [
      "scripts/series/series-home-shims.ts",
      "scripts/series/series-home-catalog-shim.ts",
    ]) {
      const src = srcFile(rel);
      expect(src).toContain("0.11.8 SHIM");
      expect(src).toContain("deleted at integration");
    }
    expect(srcFile("scripts/series/series-home-shims.ts")).toContain("collection-selectors.ts");
    expect(srcFile("scripts/series/series-home-shims.ts")).toContain("home-browse-modes.ts");
    expect(srcFile("scripts/series/series-home-catalog-shim.ts")).toContain("catalog-index.ts");
  });

  it("home modules never resolve/request/observe series info (cached reads only)", () => {
    const forbidden = [
      "observeSeasonCount",
      "requestSeasonCount",
      "requestSeriesInfo",
      "requestEpisodeIds",
    ];
    for (const rel of [
      "scripts/series/series-home-model.ts",
      "scripts/series/series-home-render.ts",
      "scripts/series/couch-series-home.ts",
    ]) {
      const src = srcFile(rel);
      for (const name of forbidden) {
        expect(src, `${rel} must not reference ${name}`).not.toContain(name);
      }
    }
    // The one sanctioned cache read stays: sync, cached-only.
    expect(srcFile("scripts/series/series-home-render.ts")).toContain("getCachedSeasonCount");
  });

  it("followed.ts and series-seasons.ts are consumed, never forked: no second snapshot/diff engine", () => {
    for (const rel of [
      "scripts/series/series-home-model.ts",
      "scripts/series/series-home-render.ts",
      "scripts/series/couch-series-home.ts",
    ]) {
      const src = srcFile(rel);
      expect(src, `${rel} must not fork snapshot diffing`).not.toContain("diffSnapshots");
      expect(src, `${rel} must not fork snapshot normalisation`).not.toContain("normalizeSnapshot");
      expect(src, `${rel} must not fork episode-key identity`).not.toContain("BULK_REMAP");
    }
    expect(srcFile("scripts/series/couch-series-home.ts")).toContain("listNotificationGroups");
    expect(srcFile("scripts/series/couch-series-home.ts")).toContain("FOLLOWED_CHANGED_EVENT");
    expect(srcFile("scripts/series/couch-series-home.ts")).toContain("FOLLOWED_NOTIFICATIONS_EVENT");
  });
});
