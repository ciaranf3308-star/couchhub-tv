// 0.11.8 integration — Browse Everything data sources.
//
// The W3/W4 seam W2 specified: BrowseDataSource factories over the
// REAL catalogue path (loadCouchCatalog + the Couch adapters), the
// REAL profile stores (preferences.js progress/favourites/watchlist,
// the followed store), and the REAL cached season counts. No second
// loader, no second cache, no second followed system.
//
// Watch sets are memoised per (playlist, kind, revision): the mount
// calls watchSets() on every derive, and a full progress-bucket scan
// per derive would be wasteful. One revision counter, bumped by the
// profile/followed change events (single global listener set,
// installed once), invalidates the memo. A favourite change never
// rebuilds the provider index (that lives in the W1 index cache);
// it only re-derives the watch sets.
//
// Followed/new-episode sets are async (the followed store is IDB
// backed) while watchSets() is sync: the series source refreshes a
// per-playlist cache at load() time and the series controller
// refreshes it on followed-change events before calling
// controller.refresh(). Until the first refresh the sets are empty
// — never stale, never invented.

import { loadCouchCatalog } from "@/scripts/movies/couch-catalog.ts";
import { moviesAdapter } from "@/scripts/movies/couch-movies-adapter.ts";
import { seriesAdapter } from "@/scripts/series/couch-series-adapter.ts";
import type { MovieRow } from "@/scripts/movies/couch-movies.ts";
import type { SeriesRow } from "@/scripts/series/couch-series.ts";
import {
  PROGRESS_CHANGED_EVENT,
  getContinueWatching,
  getFavorites,
  getWatchedSignals,
  getWatchlist,
} from "@/scripts/lib/preferences.js";
import {
  FOLLOWED_CHANGED_EVENT,
  FOLLOWED_NOTIFICATIONS_EVENT,
  listNotificationGroups,
  listSubscriptions,
} from "@/scripts/lib/followed.ts";
import { getCachedSeasonCount } from "@/scripts/lib/series-seasons.ts";
import {
  hasCredibleRating,
  normaliseRating,
} from "@/scripts/lib/rating-evidence.ts";
import {
  genreLabelForId,
  providerCategoryInfo,
} from "@/scripts/lib/genres.ts";
import type {
  BrowseDataSource,
  BrowseWatchSets,
} from "@/scripts/lib/browse-everything.ts";
import type { CatalogRow } from "@/scripts/lib/catalog-index.ts";
import {
  allCategoryForKind,
  type BrowseCategorySelection,
  type BrowseKind,
} from "@/scripts/lib/browse-state.ts";

// ── Watch sets ───────────────────────────────────────────────────

// Progress scans are capped by the preferences accessors' `limit`
// (most-recent-first slices). 100k entries is beyond any plausible
// household history; the cap only guards pathological stores.
const PROGRESS_SCAN_LIMIT = 100_000;

const EMPTY_SET: ReadonlySet<string> = new Set();

let watchSetsRevision = 0;
let watchSetsListenersInstalled = false;
const watchSetsCache = new Map<
  string,
  { revision: number; sets: BrowseWatchSets }
>();

function installWatchSetsListeners(): void {
  if (watchSetsListenersInstalled) return;
  watchSetsListenersInstalled = true;
  if (typeof document === "undefined") return;
  const bump = () => {
    watchSetsRevision += 1;
  };
  // The favourites/watchlist event names are module-private in
  // preferences.js (only the progress event is exported) — the
  // literals below are the exact strings it dispatches.
  for (const event of [
    PROGRESS_CHANGED_EVENT,
    "xt:favorites-changed",
    "xt:watchlist-changed",
    FOLLOWED_CHANGED_EVENT,
    FOLLOWED_NOTIFICATIONS_EVENT,
  ]) {
    document.addEventListener(event, bump);
  }
}

function computeWatchSets(
  playlistId: string,
  kind: BrowseKind,
): BrowseWatchSets {
  const prefKind = kind === "movie" ? "vod" : "series";
  // getFavorites returns the LIVE Set — copy it, or a later
  // favourite toggle would mutate a set the derive already read.
  const favouriteIds = new Set<number | string>(
    getFavorites(playlistId, prefKind) as Iterable<number | string>,
  );
  // getWatchlist returns a plain-object map keyed by string id.
  const watchLaterIds = new Set<number | string>(
    Object.keys(getWatchlist(playlistId, prefKind) ?? {}),
  );
  const inProgressIds = new Set<number | string>();
  const watchedIds = new Set<number | string>();
  if (kind === "movie") {
    for (const entry of getContinueWatching(playlistId, PROGRESS_SCAN_LIMIT)) {
      if (entry?.kind === "vod") inProgressIds.add(entry.id);
    }
    for (const signal of getWatchedSignals(playlistId, PROGRESS_SCAN_LIMIT)) {
      if (signal?.kind === "vod" && signal.completed) watchedIds.add(signal.id);
    }
  } else {
    // Series roll-up: an unfinished episode makes its series
    // in-progress; a series is "watched" only when it has
    // completed episode records and NO unfinished episode. (All
    // episodes watched is unknowable without episode lists —
    // this is the honest approximation, documented in §5.4.)
    const unfinishedSeries = new Set<string>();
    for (const entry of getContinueWatching(playlistId, PROGRESS_SCAN_LIMIT)) {
      if (entry?.kind === "episode" && entry.seriesId != null) {
        const sid = String(entry.seriesId);
        inProgressIds.add(sid);
        unfinishedSeries.add(sid);
      }
    }
    for (const signal of getWatchedSignals(playlistId, PROGRESS_SCAN_LIMIT)) {
      if (
        signal?.kind === "episode" &&
        signal.completed &&
        signal.seriesId != null
      ) {
        const sid = String(signal.seriesId);
        if (!unfinishedSeries.has(sid)) watchedIds.add(sid);
      }
    }
  }
  const followed = followedCache.get(playlistId);
  return {
    favouriteIds,
    watchLaterIds,
    inProgressIds,
    watchedIds,
    followedIds: followed?.followedIds ?? EMPTY_SET,
    newEpisodeIds: followed?.newEpisodeIds ?? EMPTY_SET,
    followedSupported: kind === "series",
    newEpisodesSupported: kind === "series",
  };
}

function getWatchSets(playlistId: string, kind: BrowseKind): BrowseWatchSets {
  installWatchSetsListeners();
  const key = `${kind}:${playlistId}`;
  const cached = watchSetsCache.get(key);
  if (cached && cached.revision === watchSetsRevision) return cached.sets;
  const sets = computeWatchSets(playlistId, kind);
  watchSetsCache.set(key, { revision: watchSetsRevision, sets });
  return sets;
}

// ── Followed sets (series) ───────────────────────────────────────

interface FollowedBrowseSets {
  followedIds: ReadonlySet<string>;
  newEpisodeIds: ReadonlySet<string>;
}

const followedCache = new Map<string, FollowedBrowseSets>();

/**
 * Refresh the followed/new-episode sets for one playlist from the
 * EXISTING followed store (read-only; no second system). The series
 * source calls this at load(); the series controller calls it on
 * followed-change events BEFORE controller.refresh() so the next
 * derive sees fresh sets. Failures yield empty sets, never stale.
 */
export async function refreshFollowedBrowseSets(
  playlistId: string,
): Promise<void> {
  try {
    const [groups, subs] = await Promise.all([
      listNotificationGroups({ includeDismissed: false }),
      listSubscriptions(),
    ]);
    const followedIds = new Set<string>();
    for (const sub of subs) {
      if (sub.playlistId === playlistId) followedIds.add(sub.seriesId);
    }
    const newEpisodeIds = new Set<string>();
    for (const group of groups) {
      if (group.playlistId !== playlistId) continue;
      if (group.read) continue;
      if (group.episodes.length === 0) continue;
      newEpisodeIds.add(group.seriesId);
    }
    followedCache.set(playlistId, { followedIds, newEpisodeIds });
  } catch {
    followedCache.set(playlistId, {
      followedIds: new Set(),
      newEpisodeIds: new Set(),
    });
  }
}

// ── Sources ──────────────────────────────────────────────────────

function toCatalogRow(row: unknown): CatalogRow | null {
  if (row == null || typeof row !== "object") return null;
  const id = (row as { id?: unknown }).id;
  if (id == null || String(id).trim() === "") return null;
  return row as CatalogRow;
}

/** Movies Browse source: the Couch movies catalogue + adapter card views. */
export function createMoviesBrowseSource(): BrowseDataSource {
  return {
    load: async () => {
      const loaded = await loadCouchCatalog(moviesAdapter.spec);
      if (!loaded) {
        return {
          rows: [],
          playlistId: "",
          playlistTitle: "",
          fromCache: false,
          loadError: false,
          noPlaylist: true,
        };
      }
      return {
        rows: loaded.rows,
        playlistId: loaded.playlistId,
        playlistTitle: loaded.playlistTitle,
        fromCache: loaded.fromCache,
        loadError: loaded.loadError,
      };
    },
    toEntry: toCatalogRow,
    rowKey: (row) => moviesAdapter.rowKey(row as MovieRow),
    cardView: (row, playlistId) => {
      const movie = row as MovieRow;
      const view = moviesAdapter.cardView(movie, playlistId);
      // D7: the browse badge shows a rating ONLY when the evidence
      // is credible (vote-supported). The adapter's raw >= 8 badge
      // stays untouched on the legacy /browse route.
      const evidence = normaliseRating(movie);
      return {
        ...view,
        badge:
          evidence && hasCredibleRating(evidence)
            ? `★ ${evidence.score10.toFixed(1)}`
            : undefined,
      };
    },
    detailId: (row) => String((row as MovieRow).id),
    watchSets: (playlistId) => getWatchSets(playlistId, "movie"),
    emptyTitle: moviesAdapter.emptyTitle,
    emptyMessage: moviesAdapter.emptyMessage,
  };
}

/** Series Browse source: the Couch series catalogue + adapter card views. */
export function createSeriesBrowseSource(): BrowseDataSource {
  return {
    load: async () => {
      const loaded = await loadCouchCatalog(seriesAdapter.spec);
      if (!loaded) {
        return {
          rows: [],
          playlistId: "",
          playlistTitle: "",
          fromCache: false,
          loadError: false,
          noPlaylist: true,
        };
      }
      // Followed sets refresh with the catalogue so the first
      // derive already knows them.
      await refreshFollowedBrowseSets(loaded.playlistId);
      return {
        rows: loaded.rows,
        playlistId: loaded.playlistId,
        playlistTitle: loaded.playlistTitle,
        fromCache: loaded.fromCache,
        loadError: loaded.loadError,
      };
    },
    toEntry: toCatalogRow,
    rowKey: (row) => seriesAdapter.rowKey(row as SeriesRow),
    cardView: (row, playlistId) =>
      seriesAdapter.cardView(row as SeriesRow, playlistId),
    detailId: (row) => String((row as SeriesRow).id),
    decorateCard: (card, row, playlistId) => {
      seriesAdapter.decorateCard?.(card, row as SeriesRow, playlistId);
    },
    watchSets: (playlistId) => getWatchSets(playlistId, "series"),
    // CACHED-ONLY: the W1 index reads season counts through this
    // at build time; it must never trigger a fetch.
    seasonCount: (playlistId, entryId) =>
      getCachedSeasonCount(playlistId, entryId),
    // No seriesStatus: mapped rows carry no genuine status
    // metadata, so the filter stays correctly gated off (§9.5).
    emptyTitle: seriesAdapter.emptyTitle,
    emptyMessage: seriesAdapter.emptyMessage,
  };
}

// ── Deep-link labels ─────────────────────────────────────────────

const COLLECTION_LABELS: Record<string, string> = {
  recent: "Recently Added",
  "highest-rated": "Highest Rated",
  unwatched: "Unwatched",
  continue: "Continue Watching",
  favourites: "Favourites",
  watchlater: "Watch Later",
  followed: "Followed Series",
  "new-episodes": "New Episodes",
};

/**
 * Human label for a category selection (router deep links: the URL
 * carries ids, the header needs labels). Genre labels come from the
 * canonical tables, provider labels from the registered category
 * info (verbatim provider label), collection labels from the drawer
 * vocabulary. Unknown ids fall back to the id itself — never an
 * invented label.
 */
export function resolveBrowseCategoryLabel(
  kind: BrowseKind,
  category: BrowseCategorySelection,
): string {
  switch (category.kind) {
    case "all":
      return allCategoryForKind(kind).label;
    case "genre":
      return genreLabelForId(category.id, kind === "movie" ? "vod" : "series");
    case "provider":
      return providerCategoryInfo(category.id).rawLabel || category.id;
    case "uncategorised":
      return "Uncategorised";
    case "collection":
      return COLLECTION_LABELS[category.id] ?? category.id;
    default:
      return category.label;
  }
}
