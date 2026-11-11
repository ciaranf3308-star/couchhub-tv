/**
 * @vitest-environment jsdom
 */
// Detail splash redesign (Browse 0.8.0, W5) — movie + series detail
// presentation: view models from synthetic provider payloads, artwork
// fallback states, meta chips, Play/Resume targets resolving to real
// stream URLs, season/episode presentation, back-link focus
// restoration, and the .astro page contract (Browse back-links,
// skeleton, rails). No provider, no network, no fabricated ratings.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  movieDetailViewModel,
  playButtonLabel,
  resumePosition,
  movieProgressFraction,
} from "@/scripts/movies/couch-movies";
import {
  groupEpisodesBySeason,
  selectSeason,
  resumeOrNextEpisode,
  episodeAfter,
  shouldAutoplayNext,
  seriesDetailViewModel,
  type EpisodeProgress,
} from "@/scripts/series/couch-series";
import {
  buildMovieStreamUrl,
  buildSeriesStreamUrl,
} from "@/scripts/lib/stream-urls";
import {
  detailArtwork,
  detailBackDecision,
  movieDetailChips,
  seriesDetailChips,
  seasonWatchSummary,
  paintDetailArtwork,
  paintDetailProgress,
  paintMetaChips,
} from "@/scripts/lib/couch-detail-presentation";
import { applyImageFallback } from "@/scripts/lib/couch-image";
import {
  clearCouchFocusMemory,
  recordCouchFocus,
  restoreCouchFocus,
} from "@/scripts/lib/couch-focus";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

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

// jsdom reports zero-size boxes for everything; pretend every element
// has a box so the visibility checks in the focus layer behave like a
// real viewport (same approach as tests/couch-shared.test.ts).
Element.prototype.getBoundingClientRect = function () {
  return { width: 100, height: 100 } as DOMRect;
};
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function () {};
}

// Synthetic get_vod_info payload (same shape the detail page reads).
const MOVIE_INFO = {
  movie_data: { stream_id: 101 },
  info: {
    name: "Dune: Part Two",
    releasedate: "2024-03-01",
    duration_secs: 10080,
    genre: "Sci-Fi, Adventure",
    rating: "8.6",
    plot: "Paul Atreides unites with the Fremen and seeks revenge.",
    cast: "Timothee Chalamet, Zendaya, Rebecca Ferguson",
    director: "Denis Villeneuve",
    cover_big: "https://cdn.example/poster.jpg",
    backdrop_path: ["https://cdn.example/backdrop.jpg"],
    youtube_trailer: "dQw4w9WgXcQ",
    container_extension: "mkv",
  },
};

const SERIES_INFO = {
  series_id: 202,
  info: {
    name: "Dark Skies",
    releaseDate: "2023-05-12",
    genre: "Drama, Mystery",
    rating: "8.1",
    plot: "A small town hides a signal no one can explain.",
    cast: "Ana Ruiz, Ben Cole",
    cover: "https://cdn.example/series-poster.jpg",
    backdrop_path: ["https://cdn.example/series-backdrop.jpg"],
  },
  episodes: {
    "1": [
      { id: 301, season: 1, episode_num: 1, title: "Pilot", container_extension: "mp4", info: { plot: "It begins.", duration_secs: 2700, release_date: "2023-05-12", movie_image: "https://cdn.example/ep1.jpg" } },
      { id: 302, season: 1, episode_num: 2, title: "Static", container_extension: "mp4", info: { plot: "The signal grows.", duration_secs: 2700, release_date: "2023-05-19" } },
    ],
    "2": [
      { id: 303, season: 2, episode_num: 1, title: "Return", container_extension: "mp4", info: { plot: "A year later.", duration_secs: 3000, release_date: "2024-01-05" } },
      { id: 304, season: 2, episode_num: 2, title: "Episode 2", container_extension: "mp4", info: { plot: "", duration_secs: 3000, release_date: "2024-01-12" } },
      { id: 305, season: 2, episode_num: 3, title: "Finale", container_extension: "mp4", info: { plot: "It ends.", duration_secs: 3600, release_date: "2024-01-19" } },
    ],
  },
};

const CREDS = { host: "http://provider.example:8080", port: undefined, user: "demo", pass: "secret" };

function progress(position: number, duration: number, completed = false, updatedAt = 1): EpisodeProgress {
  return { position, duration, completed, updatedAt } as EpisodeProgress;
}

describe("movie detail renders from synthetic provider data", () => {
  it("builds the full view model: title, meta, plot, people, art, trailer", () => {
    const detail = movieDetailViewModel(MOVIE_INFO, null);
    expect(detail.id).toBe(101);
    expect(detail.title).toBe("Dune: Part Two");
    expect(detail.year).toBe("2024");
    expect(detail.runtimeLabel).toBe("2h 48m");
    expect(detail.genres).toEqual(["adventure", "sci-fi"]);
    expect(detail.ratingLabel).toBe("8.6");
    expect(detail.plot).toContain("Paul Atreides");
    expect(detail.cast).toEqual(["Timothee Chalamet", "Zendaya", "Rebecca Ferguson"]);
    expect(detail.director).toBe("Denis Villeneuve");
    expect(detail.poster).toBe("https://cdn.example/poster.jpg");
    expect(detail.backdrop).toBe("https://cdn.example/backdrop.jpg");
    expect(detail.trailerYoutubeId).toBe("dQw4w9WgXcQ");
    expect(detail.containerExt).toBe("mkv");
  });

  it("meta chips carry only supplied parts — no rating, no rating chip", () => {
    const full = movieDetailChips(movieDetailViewModel(MOVIE_INFO, null));
    expect(full.map((c) => c.label)).toEqual(["2024", "2h 48m", "Adventure", "Sci-Fi", "★ 8.6"]);
    const noRating = movieDetailViewModel(
      { movie_data: { stream_id: 9 }, info: { name: "Untitled", genre: "" } },
      null,
    );
    expect(noRating.ratingLabel).toBe("");
    expect(movieDetailChips(noRating).map((c) => c.label)).toEqual([]);
    expect(movieDetailChips(noRating).some((c) => c.kind === "rating")).toBe(false);
  });

  it("artwork: backdrop wins for the hero, poster fills in when it is missing", () => {
    const full = detailArtwork(movieDetailViewModel(MOVIE_INFO, null));
    expect(full.heroSrc).toBe("https://cdn.example/backdrop.jpg");
    expect(full.posterSrc).toBe("https://cdn.example/poster.jpg");
    expect(full.hasArt).toBe(true);
    const posterOnly = detailArtwork({ backdrop: null, poster: "https://cdn.example/p.jpg" });
    expect(posterOnly.heroSrc).toBe("https://cdn.example/p.jpg");
    expect(posterOnly.hasArt).toBe(true);
  });

  it("missing art is an intentional fallback state, not a broken image", () => {
    const none = detailArtwork({ backdrop: null, poster: null });
    expect(none.heroSrc).toBeNull();
    expect(none.posterSrc).toBeNull();
    expect(none.hasArt).toBe(false);
    document.body.innerHTML = `<div id="backdrop"></div>`;
    const el = document.getElementById("backdrop") as HTMLElement;
    expect(paintDetailArtwork(el, null, "backdrop", "Dune: Part Two")).toBe(false);
    expect(el.classList.contains("is-fallback")).toBe(true);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".rs-image__fallback-mark")?.textContent).toBe("DP");
    expect(el.querySelector(".rs-image__fallback-title")?.textContent).toBe("Dune: Part Two");
  });

  it("a failed image swaps to the fallback (same code TvImage arms)", () => {
    document.body.innerHTML =
      `<div class="rs-image rs-image--backdrop" data-tv-image>` +
      `<img src="https://cdn.example/dead.jpg" data-tv-image-img />` +
      `<div class="rs-image__fallback"><span class="rs-image__fallback-mark">D</span></div></div>`;
    const img = document.querySelector("img") as HTMLImageElement;
    expect(applyImageFallback(img)).toBe(true);
    expect(img.closest("[data-tv-image]")?.classList.contains("is-fallback")).toBe(true);
  });

  it("meta chips paint into the hero container", () => {
    document.body.innerHTML = `<div id="meta"></div>`;
    const el = document.getElementById("meta") as HTMLElement;
    paintMetaChips(el, movieDetailChips(movieDetailViewModel(MOVIE_INFO, null)));
    expect(el.querySelectorAll(".rs-detail-chip").length).toBe(5);
    expect(el.querySelector(".rs-detail-chip--rating")?.textContent).toBe("★ 8.6");
    paintMetaChips(el, []);
    expect(el.children.length).toBe(0);
  });
});

describe("movie Play / Resume resolves to a real playback target", () => {
  it("fresh film: Play from the start, stream URL keeps host + id + extension", () => {
    expect(playButtonLabel(null)).toEqual({ label: "Play", sub: "" });
    expect(resumePosition(null)).toBe(0);
    const detail = movieDetailViewModel(MOVIE_INFO, null);
    const url = buildMovieStreamUrl(CREDS, detail.id, detail.containerExt);
    expect(url).toBe("http://provider.example:8080/movie/demo/secret/101.mkv");
  });

  it("part-watched film: Resume at the saved position with time left", () => {
    const saved = { position: 2520, duration: 10080, completed: false } as never;
    expect(resumePosition(saved)).toBe(2520);
    expect(playButtonLabel(saved)).toEqual({ label: "Resume", sub: "2:06:00 left" });
    expect(movieProgressFraction(saved)).toBeCloseTo(0.25);
  });

  it("positions under 30s and completed films restart from the beginning", () => {
    expect(resumePosition({ position: 12, duration: 10080, completed: false } as never)).toBe(0);
    expect(resumePosition({ position: 9000, duration: 10080, completed: true } as never)).toBe(0);
    expect(playButtonLabel({ position: 9000, duration: 10080, completed: true } as never).label).toBe("Play");
  });

  it("progress bar paints the watched fraction and hides at zero", () => {
    document.body.innerHTML =
      `<div id="bar" hidden><div class="rs-detail-progress__track">` +
      `<span data-role="detail-progress-fill"></span></div>` +
      `<span data-role="detail-progress-label"></span></div>`;
    const el = document.getElementById("bar") as HTMLElement;
    paintDetailProgress(el, 0.25, "25% watched");
    expect(el.hidden).toBe(false);
    expect((el.querySelector("[data-role='detail-progress-fill']") as HTMLElement).style.width).toBe("25%");
    expect(el.querySelector("[data-role='detail-progress-label']")?.textContent).toBe("25% watched");
    paintDetailProgress(el, 0, "");
    expect(el.hidden).toBe(true);
  });
});

describe("series detail renders from synthetic provider data", () => {
  it("builds the full view model: title, seasons, meta, plot, art", () => {
    const detail = seriesDetailViewModel(SERIES_INFO, null);
    expect(detail.id).toBe(202);
    expect(detail.title).toBe("Dark Skies");
    expect(detail.year).toBe("2023");
    expect(detail.seasonsCount).toBe(2);
    expect(detail.seasonsLabel).toBe("2 seasons");
    expect(detail.genres).toEqual(["drama", "mystery"]);
    expect(detail.rating).toBe("8.1");
    expect(detail.plot).toContain("small town");
    expect(detail.poster).toBe("https://cdn.example/series-poster.jpg");
    expect(detail.backdrop).toBe("https://cdn.example/series-backdrop.jpg");
  });

  it("meta chips carry seasons and rating, and nothing when nothing is supplied", () => {
    const chips = seriesDetailChips(seriesDetailViewModel(SERIES_INFO, null));
    expect(chips.map((c) => c.label)).toEqual(["2023", "2 seasons", "Drama", "Mystery", "★ 8.1"]);
    const bare = seriesDetailViewModel({ series_id: 7, info: { name: "Bare" } }, null);
    expect(seriesDetailChips(bare)).toEqual([]);
  });

  it("missing series art is an intentional fallback state", () => {
    const bare = seriesDetailViewModel({ series_id: 7, info: { name: "Bare" } }, null);
    const art = detailArtwork(bare);
    expect(art.hasArt).toBe(false);
    expect(art.heroSrc).toBeNull();
    document.body.innerHTML = `<div id="poster"></div>`;
    const el = document.getElementById("poster") as HTMLElement;
    expect(paintDetailArtwork(el, art.posterSrc, "poster", "Bare")).toBe(false);
    expect(el.querySelector(".rs-image__fallback-mark")?.textContent).toBe("B");
  });
});

describe("season / episode presentation", () => {
  it("groups episodes by season, ascending, with a season count", () => {
    const group = groupEpisodesBySeason(SERIES_INFO);
    expect(group.seasons).toEqual([1, 2]);
    expect(group.totalEpisodes).toBe(5);
    expect(group.bySeason.get(2)?.map((ep) => ep.episodeNum)).toEqual([1, 2, 3]);
    expect(group.bySeason.get(1)?.[0].title).toBe("Pilot");
  });

  it("season picker prefers the resume season, then the first season", () => {
    const group = groupEpisodesBySeason(SERIES_INFO);
    expect(selectSeason(group, null, 2)).toBe(2);
    expect(selectSeason(group, 1, 2)).toBe(1);
    expect(selectSeason(group, 9, null)).toBe(1);
    expect(selectSeason({ seasons: [], bySeason: new Map(), totalEpisodes: 0 }, null, null)).toBeNull();
  });

  it("Resume picks the in-progress episode, otherwise the next unwatched one", () => {
    const group = groupEpisodesBySeason(SERIES_INFO);
    const inProgress = new Map<number, EpisodeProgress>([[302, progress(900, 2700, false, 5)]]);
    const resume = resumeOrNextEpisode(group, inProgress);
    expect(resume?.label).toBe("Resume");
    expect(resume?.episode.id).toBe(302);
    expect(resume?.resumeSeconds).toBe(900);
    const fresh = resumeOrNextEpisode(group, new Map());
    expect(fresh?.label).toBe("Next Episode");
    expect(fresh?.episode.id).toBe(301);
    const allWatched = new Map<number, EpisodeProgress>(
      [301, 302, 303, 304, 305].map((id) => [id, progress(2700, 2700, true, id)]),
    );
    expect(resumeOrNextEpisode(group, allWatched)).toBeNull();
  });

  it("season watch summary counts watched episodes across all seasons", () => {
    const group = groupEpisodesBySeason(SERIES_INFO);
    const partial = new Map<number, EpisodeProgress>([
      [301, progress(2700, 2700, true, 1)],
      [302, progress(900, 2700, false, 2)],
      [303, progress(3000, 3000, true, 3)],
    ]);
    const summary = seasonWatchSummary(group, partial);
    expect(summary).toEqual({ watched: 2, total: 5, percent: 0.4, label: "2 of 5 watched" });
    const empty = seasonWatchSummary(
      { seasons: [], bySeason: new Map(), totalEpisodes: 0 },
      new Map(),
    );
    expect(empty.label).toBe("");
    expect(empty.percent).toBe(0);
  });

  it("Next Episode crosses the season boundary; autoplay honours its toggle", () => {
    const group = groupEpisodesBySeason(SERIES_INFO);
    const lastOfSeason1 = group.bySeason.get(1)![1];
    expect(episodeAfter(group, lastOfSeason1)?.id).toBe(303);
    const finale = group.bySeason.get(2)![2];
    expect(episodeAfter(group, finale)).toBeNull();
    expect(shouldAutoplayNext(true, group, lastOfSeason1)?.id).toBe(303);
    expect(shouldAutoplayNext(false, group, lastOfSeason1)).toBeNull();
    expect(shouldAutoplayNext(true, group, finale)).toBeNull();
  });
});

describe("series Resume / Next Episode resolves to a real playback target", () => {
  it("resume target episode id is the stream id in the playback URL", () => {
    const group = groupEpisodesBySeason(SERIES_INFO);
    const inProgress = new Map<number, EpisodeProgress>([[302, progress(900, 2700, false, 5)]]);
    const target = resumeOrNextEpisode(group, inProgress);
    expect(target).not.toBeNull();
    const url = buildSeriesStreamUrl(CREDS, target!.episode.id, target!.episode.containerExt);
    expect(url).toBe("http://provider.example:8080/series/demo/secret/302.mp4");
  });

  it("first unwatched episode plays from the start", () => {
    const group = groupEpisodesBySeason(SERIES_INFO);
    const target = resumeOrNextEpisode(group, new Map());
    expect(target?.episode.id).toBe(301);
    expect(target?.resumeSeconds).toBe(0);
    expect(buildSeriesStreamUrl(CREDS, 301, "mp4")).toBe(
      "http://provider.example:8080/series/demo/secret/301.mp4",
    );
  });
});

describe("detail back link — history.back() restores the Browse card", () => {
  const origin = "http://localhost:4321";
  it("backs out when the referrer is the Browse grid", () => {
    expect(
      detailBackDecision({
        referrer: `${origin}/browse?type=movies`,
        origin,
        gridPath: "/browse",
        historyLength: 3,
      }),
    ).toBe("history-back");
  });

  it("follows the href otherwise: deep link, cross-origin, or no history", () => {
    expect(
      detailBackDecision({ referrer: `${origin}/movies`, origin, gridPath: "/browse", historyLength: 3 }),
    ).toBe("follow-link");
    expect(
      detailBackDecision({ referrer: "https://other.example/browse", origin, gridPath: "/browse", historyLength: 3 }),
    ).toBe("follow-link");
    expect(
      detailBackDecision({ referrer: `${origin}/browse`, origin, gridPath: "/browse", historyLength: 1 }),
    ).toBe("follow-link");
    expect(
      detailBackDecision({ referrer: "not a url", origin, gridPath: "/browse", historyLength: 3 }),
    ).toBe("follow-link");
    expect(
      detailBackDecision({ referrer: "", origin, gridPath: "/browse", historyLength: 3 }),
    ).toBe("follow-link");
  });
});

describe("focus restoration on the detail screen", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clearCouchFocusMemory();
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  function railHtml(rail: string, count: number, prefix: string): string {
    const items = Array.from(
      { length: count },
      (_, i) =>
        `<a href="#" data-nylah-item data-couch-key="${prefix}-${i + 1}" tabindex="0">${prefix} ${i + 1}</a>`,
    ).join("");
    return `<section data-nylah-rail="${rail}">${items}</section>`;
  }

  it("restores the remembered Similar card when returning to the detail page", () => {
    document.body.innerHTML = railHtml("detail-similar", 4, "vod");
    // jsdom default pathname is "/".
    recordCouchFocus({ route: "/", rail: "detail-similar", index: 1, key: "vod-2" });
    const restored = restoreCouchFocus(document);
    expect(restored?.getAttribute("data-couch-key")).toBe("vod-2");
    expect(document.activeElement).toBe(restored);
  });

  it("falls back to rail + index when the remembered card is gone", () => {
    document.body.innerHTML = railHtml("detail-actions", 3, "act");
    recordCouchFocus({ route: "/", rail: "detail-actions", index: 2, key: "gone" });
    const restored = restoreCouchFocus(document);
    expect(restored?.getAttribute("data-couch-key")).toBe("act-3");
  });

  it("does not restore on a different route", () => {
    document.body.innerHTML = railHtml("detail-similar", 4, "vod");
    recordCouchFocus({ route: "/browse", rail: "detail-similar", index: 1, key: "vod-2" });
    expect(restoreCouchFocus(document)).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("detail page contract (Browse 0.8.0)", () => {
  const movie = read("src/pages/movies/detail.astro");
  const series = read("src/pages/series/detail.astro");

  it("detail routes keep working at their own URLs — no redirect", () => {
    expect(movie).not.toContain("Astro.redirect");
    expect(series).not.toContain("Astro.redirect");
    expect(movie).toContain("movie-detail-hero");
    expect(series).toContain("series-detail-hero");
  });

  it("back-links return to their own catalogue page and highlight it", () => {
    expect(movie).toContain('href="/movies"');
    expect(series).toContain('href="/series"');
    expect(movie).not.toContain('href="/browse?type=movies"');
    expect(series).not.toContain('href="/browse?type=series"');
    expect(movie).toContain('activeNav="movies"');
    expect(series).toContain('activeNav="series"');
  });

  it("detail screens carry the one feedback menu (B06)", () => {
    for (const page of [movie, series]) {
      expect(page).toContain("feedback-dialog");
      expect(page).toContain("More Like This");
      expect(page).toContain("Not Interested");
      expect(page).toContain("Why This?");
      expect(page).toContain("feedback-watched");
    }
    expect(movie).toContain('id="movie-feedback-dialog"');
    expect(series).toContain('id="series-feedback-dialog"');
  });

  it("hero is a cinematic splash: poster inside the hero, chips, progress, actions rail", () => {
    for (const page of [movie, series]) {
      expect(page).toContain('class="rs-hero rs-detail-hero"');
    expect(movie).toContain('id="movie-detail-poster"');
    expect(series).toContain('id="series-detail-poster"');
      expect(page).toContain("rs-detail-chips");
      expect(page).toContain("rs-detail-progress");
      expect(page).toContain('data-nylah-rail="detail-actions"');
      expect(page).toContain("rs-detail-hints");
    }
    expect(movie).toContain('id="movie-detail-play"');
    expect(movie).toContain('id="movie-detail-trailer"');
    expect(series).toContain('id="series-detail-resume"');
    expect(series).toContain('id="series-detail-follow"');
  });

  it("series page presents seasons and episodes: picker, grid rail, summary", () => {
    expect(series).toContain('id="series-season-picker"');
    expect(series).toContain('id="series-episode-list"');
    expect(series).toContain('data-nylah-rail="series-episodes"');
    expect(series).toContain('id="series-episodes-summary"');
    expect(series).toContain('data-nylah-rail="detail-similar"');
  });

  it("loading shows a skeleton, and Manrope is the only display face (no serif)", () => {
    expect(movie).toContain("TvSkeleton");
    expect(series).toContain("TvSkeleton");
    expect(movie).not.toMatch(/serif/i);
    expect(series).not.toMatch(/serif/i);
  });
});
