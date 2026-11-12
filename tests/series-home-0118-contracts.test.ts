// Series Home W1/W2 contract tests (0.11.8) — the REAL modules pin
// the contract semantics W4's shims stood in for: the 15 TV genre
// families, rating normalisation, and the W1 selectors. The mode/URL
// contract is pinned by W2's browse-0118-modes.test.ts. Also: static
// guards that the home modules never resolve series info (cached
// reads only), never fork the followed snapshot engine, and that the
// W4 shims are deleted.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapSeriesRow, type SeriesRow } from "@/scripts/series/couch-series.ts";
import { getCatalogIndex, type CatalogIndex } from "@/scripts/lib/catalog-index.ts";
import {
  CANONICAL_SERIES_GENRES,
  genresForEntry,
} from "@/scripts/lib/genres.ts";
import { normaliseRating } from "@/scripts/lib/rating-evidence.ts";
import {
  selectRecentlyAdded,
  selectSeriesWorthStarting,
} from "@/scripts/lib/collection-selectors.ts";
import { emptyTasteModel } from "@/scripts/lib/taste.ts";

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

/** Build a series index over fixture rows and resolve selector ids to rows. */
function indexFor(rows: SeriesRow[]): CatalogIndex {
  return getCatalogIndex("series", rows, `series-contracts:${rows.length}`, {});
}

function pickedRows(index: CatalogIndex, ids: string[]): SeriesRow[] {
  return ids
    .map((id) => index.byId.get(id) as SeriesRow | undefined)
    .filter((r): r is SeriesRow => r != null);
}

function worthStarting(rows: SeriesRow[], opts: { startedIds?: string[]; limit?: number } = {}) {
  const index = indexFor(rows);
  return pickedRows(
    index,
    selectSeriesWorthStarting(index, emptyTasteModel("shared", "pl1"), opts.limit ?? 12, {
      watchedIds: opts.startedIds ?? [],
    }).map((r) => r.id),
  );
}

function recentlyAdded(rows: SeriesRow[], limit = 12) {
  const index = indexFor(rows);
  return pickedRows(
    index,
    selectRecentlyAdded(index, limit, null, {}).map((r) => r.id),
  );
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
    // W1 has a single "mystery" family: thriller is a movie genre,
    // and series with only thriller land in Uncategorised.
    expect(ids).toContain("mystery");
    expect(ids).not.toContain("mystery-thriller");
    expect(CANONICAL_SERIES_GENRES.find((f) => f.id === "nope")).toBeUndefined();
    expect(CANONICAL_SERIES_GENRES.find((f) => f.id === "drama")?.label).toBe("Drama");
  });

  it("matches families by canonical genre, and Reality by category text", () => {
    expect(genresForEntry(row(1, "A", { category: "Drama" }), "series")).toContain("drama");
    expect(genresForEntry(row(2, "B", { category: "Comedy" }), "series")).not.toContain("drama");
    expect(genresForEntry(row(3, "C", { category: "Reality TV" }), "series")).toContain("reality");
    expect(
      genresForEntry(row(4, "Reality Star", { category: "Drama" }), "series"),
    ).not.toContain("reality");
  });
});

describe("normaliseRating — no invented ratings", () => {
  it("normalises a provider rating onto the 10-point scale with provider provenance", () => {
    const evidence = normaliseRating({ rating: "8.4" });
    expect(evidence?.score10).toBe(8.4);
    expect(evidence?.source).toBe("provider");
    expect(normaliseRating({ rating: 7 })?.score10).toBe(7);
  });

  it("rejects above-10, garbage, empty and zero — never clamps, never invents", () => {
    expect(normaliseRating({ rating: "12" })).toBeNull();
    for (const raw of ["", "0", 0, null, undefined, "N/A", Number.NaN]) {
      expect(normaliseRating({ rating: raw })).toBeNull();
    }
  });
});

describe("selectSeriesWorthStarting — unstarted, evidenced, diverse", () => {
  it("returns at most the limit, unstarted only, evidence first", () => {
    const rows = [
      row(1, "Low", { rating: "7.1", tmdb: 1 }),
      // Vote-supported: genuinely the strongest evidence, so it headlines.
      Object.assign(row(2, "High", { rating: "9.2", tmdb: 2 }), {
        vote_average: 9.2,
        vote_count: 500,
      }),
      row(3, "Watched High", { rating: "9.9", tmdb: 3 }),
      row(4, "Unrated", { rating: "", tmdb: 4 }),
      row(5, "Below Bar", { rating: "6.5", tmdb: 5 }),
    ];
    const picked = worthStarting(rows, { startedIds: ["3"], limit: 3 });
    expect(picked).toHaveLength(3);
    expect(picked.map((r) => r.id)).not.toContain(3);
    expect(picked[0].id).toBe(2);
  });

  it("prefers TMDb-linked titles over unlinked ones: a bare 10 never outranks a linked 8 (C2)", () => {
    const rows = [
      row(1, "Unlinked Ten", { rating: "10.0" }),
      row(2, "Linked Eight", { rating: "8.0", tmdb: 9 }),
    ];
    const picked = worthStarting(rows);
    expect(picked.map((r) => r.id)).toEqual([2, 1]);
  });

  it("spreads across genres instead of collapsing to one", () => {
    const rows: SeriesRow[] = [];
    for (let i = 1; i <= 6; i++) {
      rows.push(row(i, `Drama ${i}`, { category: "Drama", rating: "9.0", tmdb: i }));
    }
    rows.push(row(7, "Comedy Gem", { category: "Comedy", rating: "7.5", tmdb: 7 }));
    rows.push(row(8, "Horror Gem", { category: "Horror", rating: "7.5", tmdb: 8 }));
    const picked = worthStarting(rows, { limit: 4 });
    const categories = picked.map((r) => r.category);
    expect(categories).toContain("Comedy");
    expect(picked).toHaveLength(4);
  });

  it("never pads: a small catalogue yields a short honest shelf", () => {
    expect(worthStarting([row(1, "Only", { rating: "8.0", tmdb: 1 })])).toHaveLength(1);
    expect(worthStarting([])).toEqual([]);
    // No rating floor in W1: the one available title shows honestly.
    expect(worthStarting([row(1, "Low", { rating: "5.0", tmdb: 1 })])).toHaveLength(1);
  });

  it("returns series rows, never episode-shaped records", () => {
    const picked = worthStarting([row(1, "Show", { rating: "8.0", tmdb: 1 })]);
    expect(picked[0]).toHaveProperty("id", 1);
    expect(picked[0]).not.toHaveProperty("episodeNum");
    expect(picked[0]).not.toHaveProperty("season");
  });

  it("excludes confirmed-empty series (0 episodes) but keeps unknown-coverage ones", () => {
    const rows = [
      Object.assign(row(1, "Empty", { rating: "9.0", tmdb: 1 }), { episodeCount: 0, episodes: [] }),
      row(2, "Unknown", { rating: "9.0", tmdb: 2 }),
    ];
    const picked = worthStarting(rows);
    expect(picked.map((r) => r.id)).toEqual([2]);
  });
});

describe("selectRecentlyAdded — added timestamps, never release year", () => {
  it("orders by added timestamp descending", () => {
    const rows = [
      row(1, "Old Add", { added: 100 }),
      row(2, "New Add", { added: 300 }),
      row(3, "Mid Add", { added: 200 }),
    ];
    expect(recentlyAdded(rows).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("ignores release year: a 1990 title added yesterday beats a 2026 title added last year", () => {
    const rows = [
      row(1, "Shiny New Release", { year: "2026", added: 100 }),
      row(2, "Old Classic", { year: "1990", added: 900 }),
    ];
    expect(recentlyAdded(rows).map((r) => r.id)).toEqual([2, 1]);
  });

  it("excludes rows with no added timestamp", () => {
    const rows = [row(1, "No Stamp", { added: 0 }), row(2, "Stamped", { added: 5 })];
    expect(recentlyAdded(rows).map((r) => r.id)).toEqual([2]);
  });

  it("caps at the limit", () => {
    const rows = [1, 2, 3, 4, 5].map((id) => row(id, `S${id}`, { added: id }));
    expect(recentlyAdded(rows, 2)).toHaveLength(2);
  });
});

describe("static guards — shims deleted, no series-info resolution from Home", () => {
  it("the W4 shims are deleted: no shim files remain", () => {
    expect(existsSync(resolve(here, "..", "src", "scripts", "series", "series-home-shims.ts"))).toBe(false);
    expect(
      existsSync(resolve(here, "..", "src", "scripts", "series", "series-home-catalog-shim.ts")),
    ).toBe(false);
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
    // The sanctioned cache reads stay: sync, cached-only.
    expect(srcFile("scripts/series/series-home-render.ts")).toContain("getCachedSeasonCount");
    expect(srcFile("scripts/series/couch-series-home.ts")).toContain("getCachedSeriesInfoPayload");
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
