// 0.11.8 W3 — Movies Home pure model (movies-home.ts).
//
// Covers the Home composition rules: Continue Watching eligibility,
// cross-shelf diversity, honest labelling, genre tiles, the featured
// view model, and full-model assembly. No DOM, no storage, no
// network. Fixtures are fake rows only.

import { describe, it, expect } from "vitest";
import {
  MOVIES_HOME_BROWSE_URLS,
  applyHomeDiversity,
  buildMoviesHomeModel,
  chooseWorthWatchingLabel,
  featuredViewModel,
  genreTiles,
  movieHomeCardView,
  recentlyAddedEvidence,
  selectContinueWatchingMovies,
  tasteHasAffinity,
} from "@/scripts/movies/movies-home";
import { getCatalogIndex } from "@/scripts/movies/movies-home-shims";
import { emptyTasteModel } from "@/scripts/lib/taste";
import {
  daysAgoSeconds,
  movieRow,
  tasteWith,
} from "./movies-home-0118-fixtures";

const NOW = Date.parse("2026-11-12T12:00:00Z");

describe("selectContinueWatchingMovies (§3.3)", () => {
  it("includes only genuinely in-progress titles, most recent first", () => {
    const rows = [
      movieRow({ id: 1, name: "Recent" }),
      movieRow({ id: 2, name: "Older" }),
      movieRow({ id: 3, name: "Never Started" }),
      movieRow({ id: 4, name: "Completed" }),
      movieRow({ id: 5, name: "Zero Progress" }),
      movieRow({ id: 6, name: "Barely Started" }),
      movieRow({ id: 7, name: "Finished Fraction" }),
    ];
    const progress = new Map([
      [1, { position: 600, duration: 3600, updatedAt: 300 }],
      [2, { position: 900, duration: 3600, updatedAt: 100 }],
      [4, { position: 3600, duration: 3600, completed: true, updatedAt: 400 }],
      [5, { position: 0, duration: 3600, updatedAt: 500 }],
      [6, { position: 10, duration: 7200, updatedAt: 600 }],
      [7, { position: 3600, duration: 3600, updatedAt: 700 }],
    ]);
    const items = selectContinueWatchingMovies(rows, progress);
    expect(items.map((item) => item.row.id)).toEqual([1, 2]);
    expect(items[0].fraction).toBeCloseTo(600 / 3600);
    expect(items[0].remainingLabel).toBe("50:00 left");
  });
  it("keeps meaningful progress in short-form titles", () => {
    const rows = [movieRow({ id: 1, name: "Clip" })];
    const progress = new Map([[1, { position: 10, duration: 20, updatedAt: 1 }]]);
    expect(selectContinueWatchingMovies(rows, progress)).toHaveLength(1);
  });
  it("excludes records with no usable duration", () => {
    const rows = [movieRow({ id: 1, name: "No Duration" })];
    const progress = new Map([[1, { position: 600, updatedAt: 1 }]]);
    expect(selectContinueWatchingMovies(rows, progress)).toHaveLength(0);
  });
});

describe("applyHomeDiversity (§14.4)", () => {
  it("removes the featured film from Worth Watching and Recently Added", () => {
    const featured = movieRow({ id: 1, name: "Featured" });
    const worth = [movieRow({ id: 1, name: "Featured" }), movieRow({ id: 2, name: "Worth" })];
    const recent = [
      movieRow({ id: 1, name: "Featured" }),
      movieRow({ id: 2, name: "Worth" }),
      movieRow({ id: 3, name: "Recent" }),
    ];
    const out = applyHomeDiversity(featured, worth, recent);
    expect(out.worthWatching.map((row) => row.id)).toEqual([2]);
    expect(out.recentlyAdded.map((row) => row.id)).toEqual([3]);
  });
  it("preserves order and handles a null featured film", () => {
    const worth = [movieRow({ id: 2 }), movieRow({ id: 3 })];
    const recent = [movieRow({ id: 3 }), movieRow({ id: 4 })];
    const out = applyHomeDiversity(null, worth, recent);
    expect(out.worthWatching.map((row) => row.id)).toEqual([2, 3]);
    expect(out.recentlyAdded.map((row) => row.id)).toEqual([4]);
  });
});

describe("featuredViewModel (§3.2)", () => {
  it("builds year, runtime, genre summary and credible rating from supplied fields only", () => {
    const row = movieRow({
      year: "2024-03-01",
      duration: "125",
      category: "Action, Thriller",
      rating: "8.4",
      tmdb: 42,
      plot: "A heist goes wrong.",
    });
    const featured = featuredViewModel(row, null);
    expect(featured.year).toBe("2024");
    expect(featured.runtimeLabel).toBe("2h 5m");
    expect(featured.genreSummary).toBe("Action · Thriller");
    expect(featured.ratingLabel).toBe("★ 8.4");
    expect(featured.synopsis).toBe("A heist goes wrong.");
    expect(featured.compact).toBe(false);
    expect(featured.primaryLabel).toBe("View Details");
    expect(featured.detailHref).toBe(`/movies/detail?id=${row.id}`);
  });
  it("never shows an uncredible rating and never invents a synopsis", () => {
    const row = movieRow({ rating: "10", tmdb: null, plot: "", year: "", duration: "" });
    const featured = featuredViewModel(row, null);
    expect(featured.ratingLabel).toBe("");
    expect(featured.synopsis).toBe("");
    expect(featured.year).toBe("");
    expect(featured.runtimeLabel).toBe("");
  });
  it("truncates a long synopsis to a useful short one", () => {
    const row = movieRow({ plot: `Word `.repeat(80).trim() });
    const featured = featuredViewModel(row, null);
    expect(featured.synopsis.length).toBeLessThanOrEqual(221);
    expect(featured.synopsis.endsWith("…")).toBe(true);
  });
  it("uses the compact fallback when no artwork and no description exist", () => {
    const row = movieRow({ logo: null, plot: "" });
    expect(featuredViewModel(row, null).compact).toBe(true);
    const withPlot = movieRow({ logo: null, plot: "Something happens." });
    expect(featuredViewModel(withPlot, null).compact).toBe(false);
  });
  it("labels the primary action Continue when genuinely in progress", () => {
    const row = movieRow({});
    expect(
      featuredViewModel(row, { position: 600, duration: 3600 }).primaryLabel,
    ).toBe("Continue Watching");
    expect(featuredViewModel(row, { position: 3600, duration: 3600, completed: true }).primaryLabel).toBe(
      "View Details",
    );
    expect(featuredViewModel(row, null).primaryLabel).toBe("View Details");
  });
});

describe("honest shelf labelling (§3.4, §3.5)", () => {
  it("Worth Watching keeps its name only on real evidence", () => {
    expect(
      chooseWorthWatchingLabel({ hasTasteAffinity: true, credibleCount: 0, total: 8 }),
    ).toBe("Worth Watching");
    expect(
      chooseWorthWatchingLabel({ hasTasteAffinity: false, credibleCount: 6, total: 10 }),
    ).toBe("Worth Watching");
    expect(
      chooseWorthWatchingLabel({ hasTasteAffinity: false, credibleCount: 2, total: 10 }),
    ).toBe("Popular in Your Library");
    expect(
      chooseWorthWatchingLabel({ hasTasteAffinity: false, credibleCount: 0, total: 10 }),
    ).toBe("Explore Movies");
    expect(
      chooseWorthWatchingLabel({ hasTasteAffinity: false, credibleCount: 0, total: 0 }),
    ).toBe("Explore Movies");
  });
  it("no honest label ever claims AI picks", () => {
    const labels = [
      chooseWorthWatchingLabel({ hasTasteAffinity: true, credibleCount: 5, total: 5 }),
      chooseWorthWatchingLabel({ hasTasteAffinity: false, credibleCount: 1, total: 5 }),
      chooseWorthWatchingLabel({ hasTasteAffinity: false, credibleCount: 0, total: 5 }),
    ];
    for (const label of labels) expect(label).not.toMatch(/AI/i);
  });
  it("tasteHasAffinity reads liked titles, favourites and genre weights", () => {
    expect(tasteHasAffinity(emptyTasteModel("shared", "p1"))).toBe(false);
    expect(tasteHasAffinity(null)).toBe(false);
    expect(
      tasteHasAffinity(tasteWith({ likedTitles: [{ kind: "movie", id: "1", title: "X", weight: 1, updatedAt: 1 }] })),
    ).toBe(true);
    expect(tasteHasAffinity(tasteWith({ genreWeights: { action: 2 } }))).toBe(true);
    expect(tasteHasAffinity(tasteWith({ genreWeights: { action: 0 } }))).toBe(false);
  });
  it("Recently Added notes never imply just-uploaded-today without dates to prove it", () => {
    const fresh = [
      movieRow({ added: daysAgoSeconds(5, NOW) }),
      movieRow({ added: daysAgoSeconds(20, NOW) }),
    ];
    const freshEvidence = recentlyAddedEvidence(fresh, NOW);
    expect(freshEvidence.hasValidDates).toBe(true);
    expect(freshEvidence.note).toBe("Added to your library in the last 30 days");

    const stale = [movieRow({ added: daysAgoSeconds(200, NOW) })];
    expect(recentlyAddedEvidence(stale, NOW).note).toBe("Newest additions to your library");

    const dateless = [movieRow({ added: 0 })];
    const datelessEvidence = recentlyAddedEvidence(dateless, NOW);
    expect(datelessEvidence.hasValidDates).toBe(false);
    expect(datelessEvidence.newestAgeDays).toBeNull();
    expect(datelessEvidence.note).toBe("Newest titles in your library");
  });
});

describe("genreTiles (§3.6)", () => {
  it("counts real matching titles per genre and links to Browse with the genre applied", () => {
    const rows = [
      movieRow({ category: "Action" }),
      movieRow({ category: "Action, Thriller" }),
      movieRow({ category: "Comedy" }),
    ];
    const tiles = genreTiles(getCatalogIndex(rows));
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    expect(byId.get("action")?.count).toBe(2);
    expect(byId.get("thriller")?.count).toBe(1);
    expect(byId.get("comedy")?.count).toBe(1);
    expect(byId.get("action")?.href).toBe("/movies?view=browse&genre=action");
    expect(byId.get("action")?.label).toBe("Action");
    expect(byId.get("sci-fi")).toBeUndefined();
    expect(byId.get("all")?.count).toBe(3);
    expect(byId.get("all")?.label).toBe("All Genres");
    expect(byId.get("all")?.href).toBe("/movies?view=browse");
  });
  it("labels Science Fiction in full", () => {
    const tiles = genreTiles(getCatalogIndex([movieRow({ category: "Science Fiction" })]));
    expect(tiles.find((tile) => tile.id === "sci-fi")?.label).toBe("Science Fiction");
  });
});

describe("movieHomeCardView", () => {
  it("shows credible rating badges only, progress only when in progress", () => {
    const credible = movieHomeCardView(
      movieRow({ rating: "8.4", tmdb: 1 }),
      { position: 600, duration: 3600 },
    );
    expect(credible.badge).toBe("★ 8.4");
    expect(credible.progress).toBeCloseTo(600 / 3600);
    const bare = movieHomeCardView(movieRow({ rating: "10", tmdb: null }), null);
    expect(bare.badge).toBeUndefined();
    expect(bare.progress).toBe(0);
    const done = movieHomeCardView(movieRow({}), { position: 10, duration: 10, completed: true });
    expect(done.progress).toBe(0);
  });
  it("appends a meta suffix (remaining time) to the meta line", () => {
    const view = movieHomeCardView(movieRow({ year: "2024", duration: "120", category: "Drama" }), null, {
      metaSuffix: "50:00 left",
    });
    expect(view.meta).toContain("50:00 left");
    expect(view.meta).toContain("2024");
  });
});

describe("buildMoviesHomeModel (§1.1, §2)", () => {
  function library(): ReturnType<typeof movieRow>[] {
    const rows: ReturnType<typeof movieRow>[] = [];
    const genres = ["Action", "Comedy", "Horror", "Thriller", "Science Fiction", "Drama"];
    for (let i = 0; i < 30; i++) {
      rows.push(
        movieRow({
          id: 100 + i,
          name: `Library Film ${i}`,
          rating: i % 3 === 0 ? "8.6" : "7.4",
          tmdb: 1000 + i,
          category: genres[i % genres.length],
          plot: i % 2 === 0 ? `Synopsis for film ${i}.` : "",
          added: daysAgoSeconds((i % 12) + 1, NOW),
        }),
      );
    }
    return rows;
  }

  it("assembles every section with no film repeated across featured/worth/recent", () => {
    const model = buildMoviesHomeModel({
      rows: library(),
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map(),
      nowMs: NOW,
    });
    expect(model.hasContent).toBe(true);
    expect(model.totalCount).toBe(30);
    expect(model.featured).not.toBeNull();
    expect(model.worthWatching.items.length).toBeGreaterThan(0);
    expect(model.worthWatching.items.length).toBeLessThanOrEqual(12);
    expect(model.recentlyAdded.items.length).toBeGreaterThan(0);
    const featuredId = model.featured!.row.id;
    expect(model.worthWatching.items.map((row) => row.id)).not.toContain(featuredId);
    expect(model.recentlyAdded.items.map((row) => row.id)).not.toContain(featuredId);
    const worthIds = new Set(model.worthWatching.items.map((row) => row.id));
    for (const row of model.recentlyAdded.items) expect(worthIds.has(row.id)).toBe(false);
    expect(model.genres.length).toBe(7);
    expect(model.continueWatching.total).toBe(0);
  });
  it("is stable across rebuilds and rotates only on a new seed", () => {
    const input = {
      rows: library(),
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map(),
      nowMs: NOW,
    };
    const first = buildMoviesHomeModel({ ...input, rotationSeed: 0 });
    const second = buildMoviesHomeModel({ ...input, rotationSeed: 0 });
    expect(first.featured?.row.id).toBe(second.featured?.row.id);
    expect(first.worthWatching.items.map((row) => row.id)).toEqual(
      second.worthWatching.items.map((row) => row.id),
    );
    const picks = [0, 1, 2, 3, 4].map(
      (seed) => buildMoviesHomeModel({ ...input, rotationSeed: seed }).featured?.row.id,
    );
    expect(new Set(picks).size).toBeGreaterThan(1);
  });
  it("caps Continue Watching at 8 visible and reports the true total", () => {
    const rows = library();
    const progress = new Map(
      rows.slice(0, 12).map((row, i) => [
        row.id,
        { position: 600, duration: 3600, updatedAt: 1000 - i },
      ]),
    );
    const model = buildMoviesHomeModel({
      rows,
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: progress,
      nowMs: NOW,
    });
    expect(model.continueWatching.items).toHaveLength(8);
    expect(model.continueWatching.total).toBe(12);
  });
  it("Continue Watching is exempt from diversity: an in-progress film can also be featured", () => {
    const rows = [
      movieRow({ id: 1, name: "Star", rating: "9.2", tmdb: 1, category: "Drama", plot: "Great." }),
      movieRow({ id: 2, name: "Also Ran", rating: "6.0", tmdb: 2, category: "Comedy" }),
    ];
    const model = buildMoviesHomeModel({
      rows,
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map([[1, { position: 600, duration: 3600, updatedAt: 5 }]]),
      nowMs: NOW,
    });
    expect(model.featured?.row.id).toBe(1);
    expect(model.continueWatching.items.map((item) => item.row.id)).toContain(1);
  });
  it("completed titles never headline and never fill Worth Watching", () => {
    const rows = [
      movieRow({ id: 1, name: "Watched Star", rating: "9.5", tmdb: 1 }),
      movieRow({ id: 2, name: "Unwatched", rating: "7.0", tmdb: 2 }),
    ];
    const model = buildMoviesHomeModel({
      rows,
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map([[1, { position: 100, duration: 100, completed: true }]]),
      nowMs: NOW,
    });
    expect(model.featured?.row.id).toBe(2);
    expect(model.worthWatching.items.map((row) => row.id)).not.toContain(1);
  });
  it("an empty catalogue yields an empty, honest model", () => {
    const model = buildMoviesHomeModel({
      rows: [],
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map(),
      nowMs: NOW,
    });
    expect(model.hasContent).toBe(false);
    expect(model.totalCount).toBe(0);
    expect(model.featured).toBeNull();
    expect(model.worthWatching.items).toEqual([]);
    expect(model.recentlyAdded.items).toEqual([]);
    expect(model.continueWatching.total).toBe(0);
  });
  it("labels Worth Watching honestly from the evidence available", () => {
    const thin = buildMoviesHomeModel({
      rows: [movieRow({ rating: "", tmdb: null }), movieRow({ rating: "", tmdb: null })],
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map(),
      nowMs: NOW,
    });
    expect(thin.worthWatching.label).toBe("Explore Movies");
  });
});

describe("MOVIES_HOME_BROWSE_URLS", () => {
  it("names the Browse Everything entry points", () => {
    expect(MOVIES_HOME_BROWSE_URLS.everything).toBe("/movies?view=browse");
    expect(MOVIES_HOME_BROWSE_URLS.continueWatching).toBe("/movies?view=browse&list=continue");
    expect(MOVIES_HOME_BROWSE_URLS.recentlyAdded).toBe("/movies?view=browse&sort=added");
    expect(MOVIES_HOME_BROWSE_URLS.search).toBe("/movies?view=browse&focus=search");
  });
});
