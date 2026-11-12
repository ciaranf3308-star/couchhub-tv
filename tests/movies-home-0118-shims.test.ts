// 0.11.8 W3 — W1 contract shim semantics (movies-home-shims.ts).
//
// These tests pin the REAL contract semantics the shims implement,
// so integration can swap in the real W1 modules against the same
// expectations: deterministic selection, evidence-honest ratings,
// no invented metadata, no randomness. If a real W1 module changes
// a semantic, the test — not just the shim — must be updated
// deliberately at integration.

import { describe, it, expect } from "vitest";
import { addedTimestampMs } from "@/scripts/movies/couch-movies";
import {
  CANONICAL_MOVIE_GENRES,
  getCatalogIndex,
  normaliseRating,
  selectFeaturedFilm,
  selectRecentlyAdded,
  selectWorthWatching,
} from "@/scripts/movies/movies-home-shims";
import { emptyTasteModel } from "@/scripts/lib/taste";
import {
  daysAgoSeconds,
  movieRow,
  resetFixtureIds,
  tasteWith,
} from "./movies-home-0118-fixtures";

const NOW = Date.parse("2026-11-12T12:00:00Z");

describe("addedTimestampMs (couch-movies.ts)", () => {
  it("reads seconds as seconds and milliseconds as milliseconds", () => {
    expect(addedTimestampMs(1_700_000_000, NOW)).toBe(1_700_000_000_000);
    expect(addedTimestampMs(1_700_000_000_000, NOW)).toBe(1_700_000_000_000);
  });
  it("rejects zero, negative, non-numeric and pre-2000 values", () => {
    expect(addedTimestampMs(0, NOW)).toBeNull();
    expect(addedTimestampMs(-5, NOW)).toBeNull();
    expect(addedTimestampMs("nope", NOW)).toBeNull();
    expect(addedTimestampMs(undefined, NOW)).toBeNull();
    expect(addedTimestampMs(900_000_000, NOW)).toBeNull();
  });
  it("rejects absurd far-future values", () => {
    expect(addedTimestampMs(Math.floor(NOW / 1000) + 48 * 3600, NOW)).toBeNull();
    expect(addedTimestampMs(Math.floor(NOW / 1000) - 60, NOW)).not.toBeNull();
  });
});

describe("getCatalogIndex (W1 shim)", () => {
  it("dedupes by id, first row wins, and preserves catalogue order", () => {
    const first = movieRow({ id: 1, name: "First" });
    const dup = movieRow({ id: 1, name: "Duplicate" });
    const second = movieRow({ id: 2, name: "Second" });
    const index = getCatalogIndex([first, dup, second], "p1");
    expect(index.rows.map((row) => row.name)).toEqual(["First", "Second"]);
    expect(index.total).toBe(2);
    expect(index.byId.get(1)?.name).toBe("First");
    expect(index.playlistId).toBe("p1");
  });
  it("drops rows without an id or a name", () => {
    const index = getCatalogIndex([
      movieRow({ id: 1, name: "Kept" }),
      movieRow({ id: 0, name: "No id" }),
      movieRow({ id: 2, name: "" }),
      null as never,
    ]);
    expect(index.rows.map((row) => row.id)).toEqual([1]);
  });
  it("counts distinct title+year groups", () => {
    const index = getCatalogIndex([
      movieRow({ id: 1, name: "Dune", year: "2021" }),
      movieRow({ id: 2, name: "Dune", year: "2021" }),
      movieRow({ id: 3, name: "Dune", year: "1984" }),
    ]);
    expect(index.total).toBe(3);
    expect(index.distinctTitles).toBe(2);
  });
});

describe("CANONICAL_MOVIE_GENRES (W1 shim)", () => {
  it("leads with the six prominent Explore-tiles genres in brief order", () => {
    expect(CANONICAL_MOVIE_GENRES.slice(0, 6)).toEqual([
      "action",
      "comedy",
      "horror",
      "thriller",
      "sci-fi",
      "drama",
    ]);
  });
  it("covers every canonical genre exactly once", () => {
    expect(CANONICAL_MOVIE_GENRES).toHaveLength(18);
    expect(new Set(CANONICAL_MOVIE_GENRES).size).toBe(18);
  });
});

describe("normaliseRating (W1 shim)", () => {
  it("returns none for missing, zero, negative and non-numeric ratings", () => {
    for (const raw of ["", "0", "-1", "abc", null, undefined]) {
      const rating = normaliseRating(raw);
      expect(rating.value).toBeNull();
      expect(rating.label).toBe("");
      expect(rating.credible).toBe(false);
      expect(rating.tier).toBe("none");
    }
  });
  it("a bare provider 10/10 with no link and no votes is NEVER credible", () => {
    const rating = normaliseRating("10");
    expect(rating.value).toBe(10);
    expect(rating.credible).toBe(false);
    expect(rating.tier).toBe("low");
  });
  it("a TMDb-matched rating is credible (Tier 2)", () => {
    const rating = normaliseRating("8.4", { tmdb: 123 });
    expect(rating.value).toBe(8.4);
    expect(rating.label).toBe("★ 8.4");
    expect(rating.credible).toBe(true);
    expect(rating.tier).toBe("medium");
  });
  it("vote counts drive the tier; few votes stay low", () => {
    expect(normaliseRating("8.0", { votes: 1500 }).tier).toBe("high");
    expect(normaliseRating("8.0", { votes: 150 }).tier).toBe("medium");
    expect(normaliseRating("8.0", { votes: 50 }).tier).toBe("low");
    expect(normaliseRating("8.0", { votes: 50 }).credible).toBe(false);
  });
  it("clamps above-10 values to 10", () => {
    expect(normaliseRating("11.5", { tmdb: 1 }).value).toBe(10);
  });
});

describe("selectFeaturedFilm (W1 shim)", () => {
  it("is stable: the same inputs always pick the same film", () => {
    resetFixtureIds();
    const rows = [
      movieRow({ id: 1, name: "Alpha", rating: "8.4", tmdb: 11, category: "Drama" }),
      movieRow({ id: 2, name: "Beta", rating: "7.9", tmdb: 22, category: "Action" }),
      movieRow({ id: 3, name: "Gamma", rating: "9.1", tmdb: 33, category: "Comedy" }),
    ];
    const index = getCatalogIndex(rows);
    const taste = emptyTasteModel("shared", "p1");
    const picks = [0, 1, 2].map(() => selectFeaturedFilm(index, taste, { nowMs: NOW })?.id);
    expect(picks[0]).toBe(picks[1]);
    expect(picks[1]).toBe(picks[2]);
  });
  it("never headlines a bare 10/10 while a credible title qualifies", () => {
    const rows = [
      movieRow({ id: 1, name: "Bare Ten", rating: "10", tmdb: null }),
      movieRow({ id: 2, name: "Supported Eight", rating: "8.1", tmdb: 42 }),
    ];
    const pick = selectFeaturedFilm(getCatalogIndex(rows), emptyTasteModel("shared", "p1"), {
      nowMs: NOW,
    });
    expect(pick?.id).toBe(2);
  });
  it("never picks first-with-poster: position plays no part", () => {
    const rows = [
      movieRow({ id: 1, name: "First Weak", rating: "", tmdb: null }),
      movieRow({ id: 2, name: "Later Strong", rating: "8.8", tmdb: 7 }),
    ];
    const pick = selectFeaturedFilm(getCatalogIndex(rows), emptyTasteModel("shared", "p1"), {
      nowMs: NOW,
    });
    expect(pick?.id).toBe(2);
  });
  it("prefers artwork when posters exist", () => {
    const rows = [
      movieRow({ id: 1, name: "No Art Strong", rating: "9.0", tmdb: 5, logo: null }),
      movieRow({ id: 2, name: "Art Good", rating: "8.0", tmdb: 6 }),
    ];
    const pick = selectFeaturedFilm(getCatalogIndex(rows), emptyTasteModel("shared", "p1"), {
      nowMs: NOW,
    });
    expect(pick?.id).toBe(2);
  });
  it("falls back to the strongest title when no artwork exists at all", () => {
    const rows = [
      movieRow({ id: 1, name: "Plain Weak", rating: "", logo: null }),
      movieRow({ id: 2, name: "Plain Strong", rating: "8.5", tmdb: 9, logo: null }),
    ];
    const pick = selectFeaturedFilm(getCatalogIndex(rows), emptyTasteModel("shared", "p1"), {
      nowMs: NOW,
    });
    expect(pick?.id).toBe(2);
  });
  it("returns null for an empty catalogue", () => {
    expect(
      selectFeaturedFilm(getCatalogIndex([]), emptyTasteModel("shared", "p1"), { nowMs: NOW }),
    ).toBeNull();
  });
  it("honours not-interested keys and explicit exclusions", () => {
    const rows = [
      movieRow({ id: 1, name: "Disliked", rating: "9.5", tmdb: 1 }),
      movieRow({ id: 2, name: "Excluded", rating: "9.4", tmdb: 2 }),
      movieRow({ id: 3, name: "Eligible", rating: "7.0", tmdb: 3 }),
    ];
    const taste = tasteWith({ notInterestedKeys: ["movie:1"] });
    const pick = selectFeaturedFilm(getCatalogIndex(rows), taste, {
      excludeIds: new Set([2]),
      nowMs: NOW,
    });
    expect(pick?.id).toBe(3);
  });
  it("taste affinity lifts a matching genre over an equal rival", () => {
    const rows = [
      movieRow({ id: 1, name: "Action Pick", rating: "8.0", tmdb: 1, category: "Action" }),
      movieRow({ id: 2, name: "Horror Pick", rating: "8.0", tmdb: 2, category: "Horror" }),
    ];
    const taste = tasteWith({ genreWeights: { horror: 5 } });
    const pick = selectFeaturedFilm(getCatalogIndex(rows), taste, { nowMs: NOW });
    expect(pick?.id).toBe(2);
  });
  it("the rotation seed rotates within the top candidates, deterministically", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      movieRow({ id: 10 + i, name: `Strong ${i}`, rating: "8.5", tmdb: 100 + i }),
    );
    const index = getCatalogIndex(rows);
    const taste = emptyTasteModel("shared", "p1");
    const picks = [0, 1, 2, 3, 4].map(
      (seed) => selectFeaturedFilm(index, taste, { rotationSeed: seed, nowMs: NOW })?.id,
    );
    expect(new Set(picks).size).toBeGreaterThan(1);
    expect(selectFeaturedFilm(index, taste, { rotationSeed: 2, nowMs: NOW })?.id).toBe(picks[2]);
  });
});

describe("selectWorthWatching (W1 shim)", () => {
  it("respects the limit and is deterministic for a fixed seed", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      movieRow({ id: 20 + i, name: `Title ${i}`, rating: "7.5", tmdb: 200 + i }),
    );
    const index = getCatalogIndex(rows);
    const taste = emptyTasteModel("shared", "p1");
    const first = selectWorthWatching(index, taste, { limit: 12, nowMs: NOW });
    const second = selectWorthWatching(index, taste, { limit: 12, nowMs: NOW });
    expect(first).toHaveLength(12);
    expect(first.map((row) => row.id)).toEqual(second.map((row) => row.id));
  });
  it("is NOT the rating-8+ shortcut: credible 7s beat bare 9s", () => {
    const rows = [
      movieRow({ id: 1, name: "Bare Nine", rating: "9.5", tmdb: null }),
      movieRow({ id: 2, name: "Supported Seven", rating: "7.2", tmdb: 55 }),
    ];
    const picked = selectWorthWatching(getCatalogIndex(rows), emptyTasteModel("shared", "p1"), {
      nowMs: NOW,
    });
    expect(picked[0].id).toBe(2);
  });
  it("excludes completed, explicitly excluded and not-interested titles", () => {
    const rows = [
      movieRow({ id: 1, name: "Done", rating: "9.0", tmdb: 1 }),
      movieRow({ id: 2, name: "Excluded", rating: "9.0", tmdb: 2 }),
      movieRow({ id: 3, name: "Disliked", rating: "9.0", tmdb: 3 }),
      movieRow({ id: 4, name: "Kept", rating: "7.0", tmdb: 4 }),
    ];
    const taste = tasteWith({ notInterestedKeys: ["movie:3"] });
    const picked = selectWorthWatching(getCatalogIndex(rows), taste, {
      completedIds: new Set([1]),
      excludeIds: new Set([2]),
      nowMs: NOW,
    });
    expect(picked.map((row) => row.id)).toEqual([4]);
  });
  it("caps the first pass at two per primary genre (diversity)", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        movieRow({ id: 30 + i, name: `Action ${i}`, rating: "8.0", tmdb: 300 + i, category: "Action" }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        movieRow({ id: 40 + i, name: `Comedy ${i}`, rating: "8.0", tmdb: 400 + i, category: "Comedy" }),
      ),
    ];
    const picked = selectWorthWatching(getCatalogIndex(rows), emptyTasteModel("shared", "p1"), {
      limit: 4,
      nowMs: NOW,
    });
    const actionCount = picked.filter((row) => row.category === "Action").length;
    expect(actionCount).toBe(2);
    expect(picked).toHaveLength(4);
  });
  it("dedupes identical title+year entries", () => {
    const rows = [
      movieRow({ id: 1, name: "Dune", year: "2021", rating: "8.0", tmdb: 1 }),
      movieRow({ id: 2, name: "Dune", year: "2021", rating: "8.0", tmdb: 1 }),
      movieRow({ id: 3, name: "Other", rating: "8.0", tmdb: 3 }),
    ];
    const picked = selectWorthWatching(getCatalogIndex(rows), emptyTasteModel("shared", "p1"), {
      nowMs: NOW,
    });
    expect(picked.map((row) => row.name)).toEqual(["Dune", "Other"]);
  });
  it("verified AI titles boost ranking only via the explicit input — and never invent titles", () => {
    const rows = [
      movieRow({ id: 1, name: "Plain", rating: "7.5", tmdb: 1 }),
      movieRow({ id: 2, name: "Verified", rating: "7.5", tmdb: 2 }),
    ];
    const index = getCatalogIndex(rows);
    const taste = emptyTasteModel("shared", "p1");
    const without = selectWorthWatching(index, taste, { nowMs: NOW });
    const withAi = selectWorthWatching(index, taste, {
      verifiedAiTitles: [{ id: 2 }, { id: 9999 }],
      nowMs: NOW,
    });
    expect(withAi[0].id).toBe(2);
    expect(withAi.map((row) => row.id).sort()).toEqual([1, 2]);
    expect(without.map((row) => row.id).sort()).toEqual([1, 2]);
  });
  it("rotation reorders neighbours deterministically across seeds", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      movieRow({ id: 50 + i, name: `Twin ${i}`, rating: "7.5", tmdb: 500 + i, added: 1_700_000_000 }),
    );
    const index = getCatalogIndex(rows);
    const taste = emptyTasteModel("shared", "p1");
    const firsts = [0, 1, 2, 3, 4].map(
      (seed) => selectWorthWatching(index, taste, { rotationSeed: seed, nowMs: NOW })[0].id,
    );
    expect(new Set(firsts).size).toBeGreaterThan(1);
  });
});

describe("selectRecentlyAdded (W1 shim)", () => {
  it("orders by provider ADDED timestamp, newest first", () => {
    const rows = [
      movieRow({ id: 1, name: "Old", added: daysAgoSeconds(60, NOW) }),
      movieRow({ id: 2, name: "New", added: daysAgoSeconds(2, NOW) }),
      movieRow({ id: 3, name: "Mid", added: daysAgoSeconds(20, NOW) }),
    ];
    const picked = selectRecentlyAdded(getCatalogIndex(rows), { nowMs: NOW });
    expect(picked.map((row) => row.id)).toEqual([2, 3, 1]);
  });
  it("reads millisecond timestamps correctly", () => {
    const rows = [
      movieRow({ id: 1, name: "Seconds", added: daysAgoSeconds(10, NOW) }),
      movieRow({ id: 2, name: "Millis", added: NOW - 24 * 60 * 60 * 1000 }),
    ];
    const picked = selectRecentlyAdded(getCatalogIndex(rows), { nowMs: NOW });
    expect(picked[0].id).toBe(2);
  });
  it("excludes malformed timestamps when valid dates exist", () => {
    const rows = [
      movieRow({ id: 1, name: "Zero", added: 0 }),
      movieRow({ id: 2, name: "Negative", added: -100 }),
      movieRow({ id: 3, name: "Future", added: Math.floor(NOW / 1000) + 48 * 3600 }),
      movieRow({ id: 4, name: "Valid", added: daysAgoSeconds(5, NOW) }),
    ];
    const picked = selectRecentlyAdded(getCatalogIndex(rows), { nowMs: NOW });
    expect(picked.map((row) => row.id)).toEqual([4]);
  });
  it("falls back to catalogue order when no row carries a usable date", () => {
    const rows = [
      movieRow({ id: 1, name: "First", added: 0 }),
      movieRow({ id: 2, name: "Second", added: 0 }),
    ];
    const picked = selectRecentlyAdded(getCatalogIndex(rows), { nowMs: NOW });
    expect(picked.map((row) => row.id)).toEqual([1, 2]);
  });
  it("prefers the recent window but never starves a stale library", () => {
    const recent = Array.from({ length: 6 }, (_, i) =>
      movieRow({ id: 60 + i, name: `Recent ${i}`, added: daysAgoSeconds(3, NOW) }),
    );
    const old = Array.from({ length: 10 }, (_, i) =>
      movieRow({ id: 70 + i, name: `Old ${i}`, added: daysAgoSeconds(200, NOW) }),
    );
    const picked = selectRecentlyAdded(getCatalogIndex([...recent, ...old]), { nowMs: NOW });
    expect(picked).toHaveLength(6);
    expect(picked.every((row) => row.name.startsWith("Recent"))).toBe(true);

    const staleOnly = selectRecentlyAdded(
      getCatalogIndex([
        movieRow({ id: 1, name: "Stale A", added: daysAgoSeconds(200, NOW) }),
        movieRow({ id: 2, name: "Stale B", added: daysAgoSeconds(300, NOW) }),
      ]),
      { nowMs: NOW },
    );
    expect(staleOnly.map((row) => row.id)).toEqual([1, 2]);
  });
  it("dedupes and respects limit + exclusions", () => {
    const rows = [
      movieRow({ id: 1, name: "Dup", year: "2020", added: daysAgoSeconds(1, NOW) }),
      movieRow({ id: 2, name: "Dup", year: "2020", added: daysAgoSeconds(1, NOW) }),
      movieRow({ id: 3, name: "Excluded", added: daysAgoSeconds(2, NOW) }),
      movieRow({ id: 4, name: "Kept", added: daysAgoSeconds(3, NOW) }),
    ];
    const picked = selectRecentlyAdded(getCatalogIndex(rows), {
      limit: 2,
      excludeIds: new Set([3]),
      nowMs: NOW,
    });
    expect(picked.map((row) => row.id)).toEqual([1, 4]);
  });
});
