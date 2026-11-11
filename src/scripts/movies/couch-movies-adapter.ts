// Couch Movies adapter — the kind adapter for the shared browse
// controller (src/scripts/movies/couch-browse.ts). Kept in its own
// module so both the standalone /movies page (couch-index.ts) and the
// consolidated /browse page can mount it; importing this file has no
// side effects and mounts nothing.
//
// Catalogue loading, rails, filtering, sorting and the windowed grid
// all live in the controller; this file only says what a movie is and
// how its rails are built, reusing the app's preferences (favourites,
// Watch Later, recents, progress) and the pure helpers in
// couch-movies.ts.

import {
  getFavorites,
  getWatchlist,
  getRecents,
  getProgress,
  getProgressFraction,
  ensureLoaded as ensurePrefsLoaded,
} from "@/scripts/lib/preferences.js";
import type { CouchBrowseAdapter } from "@/scripts/movies/couch-browse.ts";
import {
  mapMovieRow,
  filterMovies,
  sortMovies,
  catalogueGenres,
  movieMetaLine,
  movieProgressFraction,
  pickFeaturedMovie,
  genreDisplayLabel,
  movieGenreCollections,
  type MovieRow,
} from "@/scripts/movies/couch-movies.ts";
import { MOVIE_SORT_MODES } from "@/scripts/movies/couch-movies.ts";

const VOD_TTL_MS = 24 * 60 * 60 * 1000;

void ensurePrefsLoaded();

export const moviesAdapter: CouchBrowseAdapter<MovieRow> = {
  kind: "vod",
  spec: {
    kind: "vod",
    listAction: "get_vod_streams",
    categoriesAction: "get_vod_categories",
    ttlMs: VOD_TTL_MS,
    mapRow: mapMovieRow,
  },
  lists: [
    { value: "all", label: "All Movies" },
    { value: "continue", label: "Continue Watching" },
    { value: "recent", label: "Recently Added" },
    { value: "favorites", label: "Favourites" },
    { value: "watchlater", label: "Watch Later" },
  ],
  rails: (rows, playlistId) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const continueRows: MovieRow[] = [];
    for (const recent of getRecents(playlistId, "vod")) {
      const row = byId.get(recent.id);
      if (!row) continue;
      const fraction = movieProgressFraction(getProgress(playlistId, "vod", row.id));
      if (fraction > 0 && fraction < 1) continueRows.push(row);
    }
    const recentRows = sortMovies(rows, "added").slice(0, 12);
    const recommendedRows = sortMovies(
      rows.filter((row) => (Number(row.rating) || 0) >= 8),
      "rating",
    ).slice(0, 12);
    const favIds = getFavorites(playlistId, "vod");
    const favoriteRows = rows.filter((row) => favIds.has(row.id));
    // W8: getWatchlist returns a plain-object map { id -> meta }, not a
    // Set — calling .has() on it threw on every unfiltered load, so the
    // rails never rendered and the grid never painted. The map keys are
    // the ids; convert them once to the Set filterMovies expects.
    const watchIds = new Set(
      Object.keys(getWatchlist(playlistId, "vod")).map(Number),
    );
    const watchLaterRows = rows.filter((row) => watchIds.has(row.id));
    const featured = pickFeaturedMovie(rows);
    const rails = [
      { id: "movies-continue", title: "Continue Watching", rows: continueRows },
      { id: "movies-featured", title: "Featured", rows: featured ? [featured] : [] },
      { id: "movies-recent", title: "Recently Added", rows: recentRows },
      { id: "movies-recommended", title: "Recommended · Rated 8+", rows: recommendedRows },
      { id: "movies-favorites", title: "Favourites", rows: favoriteRows },
      { id: "movies-watchlater", title: "Watch Later", rows: watchLaterRows },
    ];
    // B08 genre collections (Action, Thriller, Comedy, Horror,
    // Science Fiction, Drama, Documentary Films) built from real
    // catalogue metadata by movieGenreCollections — only non-empty
    // ones come back. Rails already present above (Recently Added)
    // are not duplicated: the builder is the single source of truth
    // for which genre collections exist.
    const seen = new Set(rails.map((rail) => rail.id));
    for (const collection of movieGenreCollections(rows)) {
      if (!seen.has(collection.id)) rails.push(collection);
    }
    return rails;
  },
  genres: (rows) =>
    catalogueGenres(rows).map(({ id, count }) => ({
      id,
      label: genreDisplayLabel(id),
      count,
    })),
  applyFilter: (rows, filter, playlistId) => {
    const favoriteIds =
      filter.list === "favorites" ? getFavorites(playlistId, "vod") : null;
    const watchlistIds =
      // W8: getWatchlist returns a map { id -> meta }, not a Set —
      // filterMovies calls .has() on it, so convert the keys (see rails).
      filter.list === "watchlater"
        ? new Set(Object.keys(getWatchlist(playlistId, "vod")).map(Number))
        : null;
    const inProgressIds =
      filter.list === "continue"
        ? new Set(
            rows
              .filter((row) => {
                const fraction = movieProgressFraction(getProgress(playlistId, "vod", row.id));
                return fraction > 0 && fraction < 1;
              })
              .map((row) => row.id),
          )
        : null;
    // "recent" is a sort, not a filter: the grid shows the whole
    // catalogue newest-first.
    return filterMovies(rows, {
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
        : MOVIE_SORT_MODES.some((m) => m.value === filter.sort)
          ? filter.sort
          : "default";
    return sortMovies(rows, mode as never);
  },
  cardView: (row, playlistId) => ({
    title: row.name,
    meta: movieMetaLine(row),
    image: row.logo,
    kind: "poster",
    progress: playlistId ? getProgressFraction(playlistId, "vod", row.id) : 0,
    badge: row.rating && Number(row.rating) >= 8 ? `★ ${row.rating}` : undefined,
    itemKey: `vod-${row.id}`,
  }),
  rowKey: (row) => `vod-${row.id}`,
  detailHref: (row) => `/movies/detail?id=${encodeURIComponent(row.id)}`,
  countLabel: (count) => `${count.toLocaleString()} ${count === 1 ? "movie" : "movies"}`,
  emptyTitle: "No movies yet",
  emptyMessage:
    "This playlist has no movies. Add a playlist with movies in Settings, or check the provider connection.",
};
