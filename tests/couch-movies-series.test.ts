/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import {
  mapMovieRow,
  formatMovieRuntime,
  formatDurationSeconds,
  formatClock,
  filterMovies,
  sortMovies,
  catalogueGenres,
  movieProgressFraction,
  resumePosition,
  playButtonLabel,
  movieDetailViewModel,
  movieDetailMetaLine,
  pickFeaturedMovie,
  genreDisplayLabel,
  type MovieRow,
} from "@/scripts/movies/couch-movies";
import {
  mapSeriesRow,
  filterSeries,
  sortSeries,
  groupEpisodesBySeason,
  mapEpisode,
  selectSeason,
  nextEpisode,
  resumeEpisode,
  resumeOrNextEpisode,
  episodeAfter,
  shouldAutoplayNext,
  episodeDisplayTitle,
  episodeProgressFraction,
  episodeWatchState,
  seriesDetailViewModel,
  seriesDetailMetaLine,
  type EpisodeProgress,
} from "@/scripts/series/couch-series";
import { buildCouchCard } from "@/scripts/movies/couch-cards";
import {
  computeVisibleWindow,
  gridColumnsForWidth,
} from "@/scripts/lib/couch-grid";

// Node 24+ ships an experimental native `localStorage` /
// `sessionStorage` that shadows jsdom's; stub both with real in-memory
// Storage (same approach as tests/couch-shared.test.ts).
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
(globalThis as any).localStorage = makeStorage();
(globalThis as any).sessionStorage = makeStorage();

const catMap = new Map([
  ["1", "Action"],
  ["2", "Drama"],
]);

function movieRow(overrides: Partial<MovieRow> = {}): MovieRow {
  return {
    id: 1,
    name: "Test Film",
    logo: null,
    year: "2024",
    rating: "8.4",
    duration: "125",
    category: "Action",
    plot: "",
    added: 100,
    norm: "test film action 2024",
    tmdb: null,
    ...overrides,
  };
}

describe("mapMovieRow", () => {
  it("maps a get_vod_streams row", () => {
    const row = mapMovieRow(
      {
        stream_id: 42,
        name: "Dune",
        stream_icon: "https://x/poster.jpg",
        year: "2021",
        rating: "8.0",
        duration: "155",
        category_id: 1,
        added: 1700000000,
        container_extension: "mkv",
      },
      catMap,
    );
    expect(row).toMatchObject({
      id: 42,
      name: "Dune",
      logo: "https://x/poster.jpg",
      year: "2021",
      rating: "8.0",
      category: "Action",
      containerExt: "mkv",
    });
  });

  it("drops rows without an id or a name", () => {
    expect(mapMovieRow({ name: "Nameless" }, catMap)).toBeNull();
    expect(mapMovieRow({ stream_id: 7 }, catMap)).toBeNull();
    expect(mapMovieRow(null, catMap)).toBeNull();
  });

  it("keeps the provider category name when already present", () => {
    const row = mapMovieRow(
      { stream_id: 3, name: "X", category_name: "Comedy" },
      catMap,
    );
    expect(row?.category).toBe("Comedy");
  });
});

describe("formatMovieRuntime / formatClock", () => {
  it("parses bare minutes, H:MM:SS and 'min' suffixes", () => {
    expect(formatMovieRuntime("125")).toBe("2h 5m");
    expect(formatMovieRuntime("02:05:00")).toBe("2h 5m");
    expect(formatMovieRuntime("45 min")).toBe("45m");
    expect(formatMovieRuntime("60")).toBe("1h");
  });

  it("never invents a runtime for missing or garbage input", () => {
    expect(formatMovieRuntime("")).toBe("");
    expect(formatMovieRuntime(null)).toBe("");
    expect(formatMovieRuntime("soon")).toBe("");
    expect(formatMovieRuntime("0")).toBe("");
  });

  it("formats durations and clocks", () => {
    expect(formatDurationSeconds(3723)).toBe("1h 2m");
    expect(formatDurationSeconds(45 * 60)).toBe("45m");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(75)).toBe("1:15");
    expect(formatClock(3723)).toBe("1:02:03");
  });
});

describe("filterMovies / sortMovies", () => {
  const rows = [
    movieRow({ id: 1, name: "Alpha", year: "2024", rating: "8.4", added: 300, category: "Action", norm: "alpha action 2024" }),
    movieRow({ id: 2, name: "Beta", year: "1998", rating: "6.1", added: 100, category: "Drama", norm: "beta drama 1998" }),
    movieRow({ id: 3, name: "Gamma", year: "", rating: "", added: 200, category: "Action", norm: "gamma action" }),
  ];

  it("matches every search token", () => {
    expect(filterMovies(rows, { query: "alpha" }).map((r) => r.id)).toEqual([1]);
    expect(filterMovies(rows, { query: "action 2024" }).map((r) => r.id)).toEqual([1]);
    expect(filterMovies(rows, { query: "alpha 1998" })).toEqual([]);
  });

  it("filters by genre through the provider category", () => {
    expect(filterMovies(rows, { genre: "action" }).map((r) => r.id)).toEqual([1, 3]);
    expect(filterMovies(rows, { genre: "drama" }).map((r) => r.id)).toEqual([2]);
  });

  it("filters by decade and minimum rating", () => {
    expect(filterMovies(rows, { year: "2020s" }).map((r) => r.id)).toEqual([1]);
    expect(filterMovies(rows, { year: "1990s" }).map((r) => r.id)).toEqual([2]);
    expect(filterMovies(rows, { minRating: 8 }).map((r) => r.id)).toEqual([1]);
  });

  it("narrows to a personal list by id set", () => {
    expect(filterMovies(rows, { favoriteIds: new Set([2, 3]) }).map((r) => r.id)).toEqual([2, 3]);
    expect(filterMovies(rows, { inProgressIds: new Set([1]) }).map((r) => r.id)).toEqual([1]);
  });

  it("sorts by rating, year and A–Z, with yearless titles last", () => {
    expect(sortMovies(rows, "rating").map((r) => r.id)).toEqual([1, 2, 3]);
    expect(sortMovies(rows, "year-desc").map((r) => r.id)).toEqual([1, 2, 3]);
    expect(sortMovies(rows, "year-asc").map((r) => r.id)).toEqual([2, 1, 3]);
    expect(sortMovies(rows, "az").map((r) => r.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(sortMovies(rows, "added").map((r) => r.id)).toEqual([1, 3, 2]);
  });

  it("counts catalogue genres most-frequent first", () => {
    const genres = catalogueGenres(rows);
    expect(genres[0]).toEqual({ id: "action", count: 2 });
  });
});

describe("movie resume", () => {
  it("ignores positions under 30s and completed titles", () => {
    expect(resumePosition({ position: 10, duration: 6000 })).toBe(0);
    expect(resumePosition({ position: 120, duration: 6000, completed: true })).toBe(0);
    expect(resumePosition({ position: 120, duration: 6000 })).toBe(120);
    expect(resumePosition(null)).toBe(0);
  });

  it("clamps progress fractions to [0, 1]", () => {
    expect(movieProgressFraction({ position: 30, duration: 60 })).toBe(0.5);
    expect(movieProgressFraction({ position: 90, duration: 60 })).toBe(1);
    expect(movieProgressFraction({ completed: true, position: 1, duration: 60 })).toBe(1);
    expect(movieProgressFraction(null)).toBe(0);
    expect(movieProgressFraction({ position: 10 })).toBe(0);
  });

  it("labels Play vs Resume with remaining time", () => {
    expect(playButtonLabel(null)).toEqual({ label: "Play", sub: "" });
    expect(playButtonLabel({ position: 3600, duration: 7200 })).toEqual({
      label: "Resume",
      sub: "1:00:00 left",
    });
  });
});

describe("movieDetailViewModel", () => {
  it("maps a get_vod_info payload and never invents a rating", () => {
    const detail = movieDetailViewModel(
      {
        info: {
          name: "Dune",
          releasedate: "2021-10-22",
          duration_secs: 9300,
          genre: "Sci-Fi, Adventure",
          rating: "8.0",
          plot: "Spice.",
          cast: "Timothée Chalamet, Zendaya",
          director: "Denis Villeneuve",
          cover_big: "https://x/poster.jpg",
          backdrop_path: ["https://x/backdrop.jpg"],
          youtube_trailer: "abc123",
          container_extension: "mkv",
        },
      },
      movieRow({ id: 42, name: "Dune" }),
    );
    expect(detail.title).toBe("Dune");
    expect(detail.year).toBe("2021");
    expect(detail.runtimeLabel).toBe("2h 35m");
    expect(detail.genres).toContain("sci-fi");
    expect(detail.rating).toBe("8.0");
    expect(detail.cast).toEqual(["Timothée Chalamet", "Zendaya"]);
    expect(detail.director).toBe("Denis Villeneuve");
    expect(detail.trailerYoutubeId).toBe("abc123");
    expect(movieDetailMetaLine(detail)).toBe("2021 · 2h 35m · adventure · sci-fi · ★ 8.0");
  });

  it("leaves a missing rating empty", () => {
    const detail = movieDetailViewModel({ info: { name: "Unknown" } }, null);
    expect(detail.rating).toBe("");
    expect(movieDetailMetaLine(detail)).not.toContain("★");
  });
});

describe("pickFeaturedMovie", () => {
  it("picks deterministically: top-rated among the recent half", () => {
    const rows = [
      movieRow({ id: 1, name: "Old Hit", rating: "9.5", added: 1, logo: "https://x/a.jpg" }),
      movieRow({ id: 2, name: "New Hit", rating: "8.9", added: 300, logo: "https://x/b.jpg" }),
      movieRow({ id: 3, name: "New Mid", rating: "7.0", added: 200, logo: "https://x/c.jpg" }),
    ];
    expect(pickFeaturedMovie(rows)?.id).toBe(2);
    expect(pickFeaturedMovie([])).toBeNull();
  });
});

describe("genreDisplayLabel", () => {
  it("capitalises genre ids", () => {
    expect(genreDisplayLabel("sci-fi")).toBe("Sci-Fi");
    expect(genreDisplayLabel("drama")).toBe("Drama");
  });
});

describe("mapSeriesRow / filterSeries / sortSeries", () => {
  const rows = [
    mapSeriesRow({ series_id: 1, name: "Alpha Show", year: "2023", rating: "9.1", category_name: "Drama", last_modified: 300 }, catMap)!,
    mapSeriesRow({ series_id: 2, name: "Beta Show", year: "2010", rating: "7.2", category_name: "Comedy", last_modified: 100 }, catMap)!,
  ];

  it("maps series rows and drops bad ones", () => {
    expect(rows[0]).toMatchObject({ id: 1, name: "Alpha Show", category: "Drama" });
    expect(mapSeriesRow({ name: "No id" }, catMap)).toBeNull();
  });

  it("filters and sorts", () => {
    expect(filterSeries(rows, { query: "beta" }).map((r) => r.id)).toEqual([2]);
    expect(filterSeries(rows, { genre: "comedy" }).map((r) => r.id)).toEqual([2]);
    expect(sortSeries(rows, "rating").map((r) => r.id)).toEqual([1, 2]);
    expect(sortSeries(rows, "added").map((r) => r.id)).toEqual([1, 2]);
  });
});

const seriesInfo = {
  info: {
    name: "Test Show",
    releaseDate: "2022-01-01",
    genre: "Drama",
    rating: "8.8",
    plot: "A show.",
    cast: "Actor One, Actor Two",
    director: "Director One",
    cover: "https://x/cover.jpg",
    backdrop_path: ["https://x/back.jpg"],
  },
  seasons: [{ season_number: 1 }, { season_number: 2 }],
  episodes: {
    "1": [
      { id: 11, title: "Pilot", episode_num: 1, season: 1, container_extension: "mp4", info: { duration_secs: 2400, plot: "First." } },
      { id: 12, title: "Test Show S01E02", episode_num: 2, season: 1, container_extension: "mp4", info: { duration_secs: 2500 } },
    ],
    "2": [
      { id: 21, title: "Return", episode_num: 1, season: 2, container_extension: "mp4", info: { duration_secs: 2600 } },
    ],
    "0": [
      { id: 1, title: "Special", episode_num: 1, season: 0, container_extension: "mp4", info: {} },
    ],
  },
};

describe("groupEpisodesBySeason", () => {
  it("groups the season-keyed payload, seasons ascending, episodes sorted", () => {
    const group = groupEpisodesBySeason(seriesInfo);
    expect(group.seasons).toEqual([0, 1, 2]);
    expect(group.totalEpisodes).toBe(4);
    expect(group.bySeason.get(1)?.map((ep) => ep.id)).toEqual([11, 12]);
    expect(group.bySeason.get(1)?.[0]).toMatchObject({
      title: "Pilot",
      durationSeconds: 2400,
      durationLabel: "40m",
    });
  });

  it("accepts a flat episode array too", () => {
    const group = groupEpisodesBySeason({
      episodes: [
        { id: 5, episode_num: 2, season: 3, title: "B" },
        { id: 4, episode_num: 1, season: 3, title: "A" },
      ],
    });
    expect(group.seasons).toEqual([3]);
    expect(group.bySeason.get(3)?.map((ep) => ep.id)).toEqual([4, 5]);
  });

  it("returns empty groups when the provider lists no episodes", () => {
    expect(groupEpisodesBySeason({})).toEqual({ seasons: [], bySeason: new Map(), totalEpisodes: 0 });
    expect(groupEpisodesBySeason(null)).toEqual({ seasons: [], bySeason: new Map(), totalEpisodes: 0 });
  });

  it("drops episodes without an id", () => {
    expect(mapEpisode({ title: "No id" })).toBeNull();
    expect(mapEpisode(null)).toBeNull();
  });
});

describe("season / episode selection", () => {
  const group = groupEpisodesBySeason(seriesInfo);
  const noProgress: Record<number, EpisodeProgress> = {};
  const partial: Record<number, EpisodeProgress> = {
    11: { position: 120, duration: 2400, updatedAt: 100 },
    12: { position: 0, duration: 2500, updatedAt: 50 },
  };
  const watchedFirst: Record<number, EpisodeProgress> = {
    11: { position: 2400, duration: 2400, completed: true, updatedAt: 100 },
    1: { position: 600, duration: 600, completed: true, updatedAt: 90 },
  };

  it("selectSeason prefers the requested season, then resume, then first", () => {
    expect(selectSeason(group, 2)).toBe(2);
    expect(selectSeason(group, 99, 1)).toBe(1);
    expect(selectSeason(group)).toBe(0);
    expect(selectSeason({ seasons: [], bySeason: new Map(), totalEpisodes: 0 })).toBeNull();
  });

  it("nextEpisode is the first uncompleted episode in watch order", () => {
    expect(nextEpisode(group, noProgress)?.id).toBe(1);
    expect(nextEpisode(group, watchedFirst)?.id).toBe(12);
    const allWatched: Record<number, EpisodeProgress> = {
      1: { completed: true },
      11: { completed: true },
      12: { completed: true },
      21: { completed: true },
    };
    expect(nextEpisode(group, allWatched)).toBeNull();
  });

  it("resumeEpisode is the most recently touched in-progress episode", () => {
    expect(resumeEpisode(group, partial)?.id).toBe(11);
    expect(resumeEpisode(group, noProgress)).toBeNull();
    expect(resumeEpisode(group, watchedFirst)).toBeNull();
  });

  it("resumeOrNextEpisode prefers resume, then next, then null", () => {
    expect(resumeOrNextEpisode(group, partial)).toMatchObject({
      episode: { id: 11 },
      label: "Resume",
      resumeSeconds: 120,
    });
    expect(resumeOrNextEpisode(group, watchedFirst)).toMatchObject({
      episode: { id: 12 },
      label: "Next Episode",
      resumeSeconds: 0,
    });
    const allWatched: Record<number, EpisodeProgress> = {
      1: { completed: true },
      11: { completed: true },
      12: { completed: true },
      21: { completed: true },
    };
    expect(resumeOrNextEpisode(group, allWatched)).toBeNull();
  });

  it("episodeAfter walks across seasons and stops at the finale", () => {
    const ep11 = group.bySeason.get(1)![0];
    const ep12 = group.bySeason.get(1)![1];
    const ep21 = group.bySeason.get(2)![0];
    expect(episodeAfter(group, ep11)?.id).toBe(12);
    expect(episodeAfter(group, ep12)?.id).toBe(21);
    expect(episodeAfter(group, ep21)).toBeNull();
  });

  it("shouldAutoplayNext only when enabled and a next episode exists", () => {
    const ep12 = group.bySeason.get(1)![1];
    const ep21 = group.bySeason.get(2)![0];
    expect(shouldAutoplayNext(true, group, ep12)?.id).toBe(21);
    expect(shouldAutoplayNext(false, group, ep12)).toBeNull();
    expect(shouldAutoplayNext(true, group, ep21)).toBeNull();
  });

  it("episodeDisplayTitle replaces generic filler titles", () => {
    const ep12 = group.bySeason.get(1)![1];
    expect(episodeDisplayTitle(ep12, "Test Show")).toBe("Episode 2");
    const ep11 = group.bySeason.get(1)![0];
    expect(episodeDisplayTitle(ep11, "Test Show")).toBe("Pilot");
  });

  it("episode watch state derives from progress records", () => {
    expect(episodeWatchState(undefined)).toBe("unwatched");
    expect(episodeWatchState({ position: 120, duration: 2400 })).toBe("in-progress");
    expect(episodeWatchState({ completed: true })).toBe("watched");
    expect(episodeProgressFraction({ position: 1200, duration: 2400 })).toBe(0.5);
  });
});

describe("seriesDetailViewModel", () => {
  it("maps get_series_info with seasons from the metadata array", () => {
    const detail = seriesDetailViewModel(seriesInfo, null);
    expect(detail.title).toBe("Test Show");
    expect(detail.year).toBe("2022");
    expect(detail.seasonsCount).toBe(2);
    expect(detail.rating).toBe("8.8");
    expect(detail.cast).toEqual(["Actor One", "Actor Two"]);
    expect(detail.poster).toBe("https://x/cover.jpg");
    expect(seriesDetailMetaLine(detail)).toBe("2022 · 2 seasons · drama · ★ 8.8");
  });

  it("falls back to episode seasons when no metadata array exists", () => {
    const { seasons, ...rest } = seriesInfo as any;
    void seasons;
    const detail = seriesDetailViewModel(rest, null);
    expect(detail.seasonsCount).toBe(3);
  });
});

describe("large-grid behaviour", () => {
  it("windows 10,000 items to a small slice", () => {
    const win = computeVisibleWindow({
      total: 10000,
      columns: 6,
      rowHeight: 430,
      scrollTop: 4300,
      viewportHeight: 1080,
    });
    expect(win.endIndex - win.startIndex).toBeLessThan(120);
    expect(win.startIndex).toBeGreaterThanOrEqual(0);
    expect(win.endIndex).toBeLessThanOrEqual(10000);
    expect(win.totalRows).toBe(Math.ceil(10000 / 6));
    expect(win.topSpacer + win.bottomSpacer).toBeGreaterThan(0);
  });

  it("returns an empty window for an empty catalogue", () => {
    const win = computeVisibleWindow({
      total: 0,
      columns: 6,
      rowHeight: 430,
      scrollTop: 0,
      viewportHeight: 1080,
    });
    expect(win).toMatchObject({ startIndex: 0, endIndex: 0, totalRows: 0 });
  });

  it("derives columns from width", () => {
    expect(gridColumnsForWidth(1920, 200, 20)).toBeGreaterThanOrEqual(8);
    expect(gridColumnsForWidth(800, 200, 20)).toBe(3);
    expect(gridColumnsForWidth(0, 200, 20)).toBe(1);
  });
});

describe("buildCouchCard", () => {
  it("renders TvCard-identical markup with progress and badge", () => {
    const card = buildCouchCard({
      title: "Dune",
      meta: "2021 · 2h 35m",
      image: "https://x/poster.jpg",
      kind: "poster",
      progress: 0.42,
      badge: "★ 8.0",
      href: "/movies/detail?id=42",
      itemKey: "vod-42",
    });
    expect(card.tagName).toBe("A");
    expect(card.getAttribute("data-couch-key")).toBe("vod-42");
    expect(card.getAttribute("data-nylah-item")).toBe("");
    expect(card.querySelector(".rs-card__title")?.textContent).toBe("Dune");
    expect(card.querySelector(".rs-card__meta")?.textContent).toBe("2021 · 2h 35m");
    expect(card.querySelector(".rs-card__badge")?.textContent).toBe("★ 8.0");
    expect(
      (card.querySelector(".rs-card__progress-fill") as HTMLElement)?.style.width,
    ).toBe("42%");
    expect(card.querySelector("img")?.getAttribute("src")).toBe("https://x/poster.jpg");
  });

  it("never renders a broken image: missing art falls back to initials", () => {
    const card = buildCouchCard({
      title: "No Poster Film",
      kind: "poster",
      itemKey: "vod-9",
    });
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".rs-image")?.classList.contains("is-fallback")).toBe(true);
    expect(card.querySelector(".rs-image__fallback-mark")?.textContent).toBe("NP");
  });

  it("clamps progress and renders a landscape card without a link", () => {
    const card = buildCouchCard({
      title: "Ep",
      kind: "landscape",
      progress: 2,
    });
    expect(card.tagName).toBe("DIV");
    expect(card.classList.contains("rs-card--landscape")).toBe(true);
    expect(
      (card.querySelector(".rs-card__progress-fill") as HTMLElement)?.style.width,
    ).toBe("100%");
  });
});
