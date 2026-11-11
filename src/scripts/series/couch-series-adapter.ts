// Couch Series adapter — the kind adapter for the shared browse
// controller (src/scripts/movies/couch-browse.ts). Kept in its own
// module so both the standalone /series page (couch-index.ts) and the
// consolidated /browse page can mount it; importing this file has no
// side effects beyond the followed-subscription cache warm-up and
// mounts nothing.
//
// Catalogue loading, rails, filtering, sorting and the windowed grid
// all live in the controller; this file only says what a series is
// and how its rails are built, reusing the app's preferences
// (favourites, Watch Later, episode progress), the season-count
// resolver, the followed store, and the pure helpers in
// couch-series.ts.

import {
  getFavorites,
  getWatchlist,
  getSeriesEpisodeProgress,
  getSeriesProgressSummary,
  ensureLoaded as ensurePrefsLoaded,
} from "@/scripts/lib/preferences.js";
import { type CouchBrowseAdapter } from "@/scripts/movies/couch-browse.ts";
import { preferEvidence } from "@/scripts/lib/recommendations.ts";
import {
  getCachedSeasonCount,
  observeSeasonCount,
} from "@/scripts/lib/series-seasons.ts";
import {
  listSubscriptions,
  FOLLOWED_CHANGED_EVENT,
} from "@/scripts/lib/followed.ts";
import {
  mapSeriesRow,
  filterSeries,
  sortSeries,
  catalogueSeriesGenres,
  seriesMetaLine,
  pickFeaturedSeries,
  seriesGenreCollections,
  type SeriesRow,
} from "@/scripts/series/couch-series.ts";
import { SERIES_SORT_MODES } from "@/scripts/series/couch-series.ts";
import { genreDisplayLabel } from "@/scripts/movies/couch-movies.ts";

const SERIES_TTL_MS = 24 * 60 * 60 * 1000;

void ensurePrefsLoaded();

// Followed ids are async (Tauri store) — cached here and refreshed on
// the followed-changed event so rails/filter stay synchronous.
let followedIds = new Set<number>();
async function refreshFollowed(): Promise<void> {
  try {
    const subs = await listSubscriptions();
    followedIds = new Set(subs.map((sub) => Number(sub.seriesId)).filter((n) => Number.isFinite(n)));
  } catch {
    followedIds = new Set();
  }
}
void refreshFollowed();
document.addEventListener(FOLLOWED_CHANGED_EVENT, () => {
  void refreshFollowed();
});

/** "S2 E4/12" resume badge for a series with in-progress episodes. */
function seriesResumeBadge(row: SeriesRow, playlistId: string): string | undefined {
  const summary = getSeriesProgressSummary(playlistId, row.id);
  if (!summary || !summary.lastSeason) return undefined;
  const ep = summary.lastEpisodeNum;
  return ep != null ? `S${summary.lastSeason} E${ep}` : `S${summary.lastSeason}`;
}

export const seriesAdapter: CouchBrowseAdapter<SeriesRow> = {
  kind: "series",
  spec: {
    kind: "series",
    listAction: "get_series",
    categoriesAction: "get_series_categories",
    ttlMs: SERIES_TTL_MS,
    mapRow: mapSeriesRow,
  },
  lists: [
    { value: "all", label: "All Series" },
    { value: "continue", label: "Continue Watching" },
    { value: "recent", label: "Recently Added" },
    { value: "favorites", label: "Favourites" },
    { value: "watchlater", label: "Watch Later" },
  ],
  rails: (rows, playlistId) => {
    const continueRows = rows.filter((row) => {
      const progress = getSeriesEpisodeProgress(playlistId, row.id);
      return progress.completedIds.length > 0 && progress.hasIncompleteEpisode;
    });
    const recentRows = sortSeries(rows, "added").slice(0, 12);
    // C2 — same evidence preference as the movies Recommended rail.
    const recommendedRows = sortSeries(
      preferEvidence(rows.filter((row) => (Number(row.rating) || 0) >= 8)),
      "rating",
    ).slice(0, 12);
    // See the note on the getFavorites call in applyFilter: the
    // shared JSDoc omits "series" although favKey handles it.
    const favIds = getFavorites(playlistId, "series" as "vod");
    const favoriteRows = rows.filter((row) => favIds.has(row.id));
    // W8: getWatchlist returns a plain-object map { id -> meta }, not a
    // Set — calling .has() on it threw on every unfiltered load, so the
    // rails never rendered and the grid never painted. The map keys are
    // the ids; convert them once to the Set filterSeries expects.
    const watchIds = new Set(
      Object.keys(getWatchlist(playlistId, "series")).map(Number),
    );
    const watchLaterRows = rows.filter((row) => watchIds.has(row.id));
    const followedRows = rows.filter((row) => followedIds.has(row.id));
    const featured = pickFeaturedSeries(rows);
    const rails = [
      { id: "series-continue", title: "Continue Watching", rows: continueRows },
      { id: "series-featured", title: "Featured", rows: featured ? [featured] : [] },
      { id: "series-recent", title: "Recently Added", rows: recentRows },
      { id: "series-recommended", title: "Recommended · Rated 8+", rows: recommendedRows },
      { id: "series-followed", title: "Followed", rows: followedRows },
      { id: "series-favorites", title: "Favourites", rows: favoriteRows },
      { id: "series-watchlater", title: "Watch Later", rows: watchLaterRows },
    ];
    // B08 genre collections (Crime Drama, Comedy, Science Fiction,
    // Documentary Series, Reality) built from real catalogue metadata
    // by seriesGenreCollections — only non-empty ones come back.
    // Rails already present above (Continue Watching, Recently Added)
    // are not duplicated: the builder is the single source of truth
    // for which genre collections exist.
    const seen = new Set(rails.map((rail) => rail.id));
    for (const collection of seriesGenreCollections(rows)) {
      if (!seen.has(collection.id)) rails.push(collection);
    }
    return rails;
  },
  genres: (rows) =>
    catalogueSeriesGenres(rows).map(({ id, count }) => ({
      id,
      label: genreDisplayLabel(id),
      count,
    })),
  applyFilter: (rows, filter, playlistId) => {
    const favoriteIds =
      // getFavorites' JSDoc omits "series" although favKey handles it
      // (legacy callers pass it under @ts-nocheck); shared-file JSDoc
      // fix requested, not made here.
      filter.list === "favorites" ? getFavorites(playlistId, "series" as "vod") : null;
    const watchlistIds =
      // W8: getWatchlist returns a map { id -> meta }, not a Set —
      // filterSeries calls .has() on it, so convert the keys (see rails).
      filter.list === "watchlater"
        ? new Set(Object.keys(getWatchlist(playlistId, "series")).map(Number))
        : null;
    const inProgressIds =
      filter.list === "continue"
        ? new Set(
            rows
              .filter((row) => {
                const progress = getSeriesEpisodeProgress(playlistId, row.id);
                return progress.completedIds.length > 0 && progress.hasIncompleteEpisode;
              })
              .map((row) => row.id),
          )
        : null;
    return filterSeries(rows, {
      query: filter.query,
      genre: filter.genre,
      year: filter.year,
      minRating: filter.minRating,
      maxRuntime: filter.maxRuntime,
      favoriteIds,
      watchlistIds,
      inProgressIds,
    });
  },
  applySort: (rows, filter) => {
    const mode =
      filter.list === "recent"
        ? "added"
        : SERIES_SORT_MODES.some((m) => m.value === filter.sort)
          ? filter.sort
          : "default";
    return sortSeries(rows, mode as never);
  },
  cardView: (row, playlistId) => {
    const seasonCount = playlistId ? getCachedSeasonCount(playlistId, row.id) : null;
    return {
      title: row.name,
      meta: seriesMetaLine(row, seasonCount),
      image: row.logo,
      kind: "poster",
      badge: seriesResumeBadge(row, playlistId),
      itemKey: `series-${row.id}`,
    };
  },
  rowKey: (row) => `series-${row.id}`,
  decorateCard: (card, row, playlistId) => {
    if (!playlistId) return;
    const metaEl = card.querySelector(".rs-card__meta");
    if (!metaEl) return;
    observeSeasonCount(card, playlistId, row.id, (count) => {
      metaEl.textContent = seriesMetaLine(row, count);
    });
  },
  detailHref: (row) => `/series/detail?id=${encodeURIComponent(row.id)}`,
  countLabel: (count) => `${count.toLocaleString()} ${count === 1 ? "series" : "series"}`,
  emptyTitle: "No series yet",
  emptyMessage:
    "This playlist has no series. Add a playlist with series in Settings, or check the provider connection.",
};
