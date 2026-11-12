// 0.11.8 SHIM — W1/W2 contract, deleted at integration.
//
// Series Home (W4) consumes the W1 data architecture and the W2
// mode/URL contract by their exact agreed names. W1/W2 build in
// parallel, so this file implements those APIs minimally — with REAL
// contract semantics, asserted by tests/series-home-0118-*.test.ts —
// so this branch builds, runs and is verifiable on its own.
//
// INTEGRATION: delete this file and rewire the imports in
// series-home-model.ts / series-home-render.ts / couch-series-home.ts
// to the real modules:
//
//   selectSeriesWorthStarting -> W1 src/scripts/lib/collection-selectors.ts
//   selectRecentlyAdded       -> W1 src/scripts/lib/collection-selectors.ts
//   CANONICAL_SERIES_GENRES   -> W1 src/scripts/lib/genres.ts
//   normaliseRating           -> W1 src/scripts/lib/rating-evidence.ts
//   parseModeFromUrl          -> W2 src/scripts/lib/home-browse-modes.ts
//   setModeInUrl              -> W2 src/scripts/lib/home-browse-modes.ts
//   browseModeUrl             -> W2 src/scripts/lib/home-browse-modes.ts
//                                (pure URL builder behind setModeInUrl)
//
// getCatalogIndex / mountBrowseEverything live in the companion shim
// series-home-catalog-shim.ts (they touch the network/DOM and must
// stay out of the pure modules and node tests).
//
// Everything in this file is pure except setModeInUrl's history write,
// which is guarded so the module stays import-safe under node/vitest.

import {
  isDocumentarySeries,
  isRealitySeries,
  seriesGenres,
  type SeriesRow,
} from "@/scripts/series/couch-series.ts";
import { ratingSortValue } from "@/scripts/lib/format.ts";
import { preferEvidence } from "@/scripts/lib/recommendations.ts";
import type { GenreId } from "@/scripts/lib/genres.ts";

// ---------------------------------------------------------------------------
// W1: CANONICAL_SERIES_GENRES — 15 television genre families.
// Real module: src/scripts/lib/genres.ts (W1).
//
// Television families, NOT the movie taxonomy copied over: Action &
// Adventure and Sci-Fi & Fantasy are merged the way TV listings merge
// them, Reality is a first-class family (TMDb 10764, deliberately
// unmapped in the shared GenreId taxonomy — matched on the provider
// category text, exactly as isRealitySeries does), and Mystery &
// Thriller share a family. A series may belong to several families;
// the Documentary kind rule (C1) still applies — see
// familyMembersForRow in series-home-model.ts.
// ---------------------------------------------------------------------------

export interface SeriesGenreFamily {
  /** Stable family id, used as the Browse Everything genre param. */
  id: string;
  /** Display label, e.g. "Sci-Fi & Fantasy". */
  label: string;
  /** Canonical genre ids that place a series in this family. */
  genreIds: GenreId[];
  /**
   * Provider-category pattern for families with no canonical genre id
   * (Reality). Matched against the row's provider category only —
   * never against the title alone.
   */
  categoryPattern?: RegExp;
}

export const CANONICAL_SERIES_GENRES: readonly SeriesGenreFamily[] = [
  { id: "drama", label: "Drama", genreIds: ["drama"] },
  { id: "comedy", label: "Comedy", genreIds: ["comedy"] },
  { id: "crime", label: "Crime", genreIds: ["crime"] },
  { id: "action-adventure", label: "Action & Adventure", genreIds: ["action", "adventure"] },
  { id: "sci-fi-fantasy", label: "Sci-Fi & Fantasy", genreIds: ["sci-fi", "fantasy"] },
  { id: "animation", label: "Animation", genreIds: ["animation"] },
  { id: "documentary", label: "Documentary", genreIds: ["documentary"] },
  { id: "reality", label: "Reality", genreIds: [], categoryPattern: /reality/i },
  { id: "mystery-thriller", label: "Mystery & Thriller", genreIds: ["mystery", "thriller"] },
  { id: "horror", label: "Horror", genreIds: ["horror"] },
  { id: "romance", label: "Romance", genreIds: ["romance"] },
  { id: "family", label: "Family", genreIds: ["family"] },
  { id: "history", label: "History", genreIds: ["history"] },
  { id: "war-western", label: "War & Western", genreIds: ["war", "western"] },
  { id: "music", label: "Music", genreIds: ["music"] },
];

/** Family lookup by id, or undefined for an unknown id. Pure. */
export function seriesGenreFamilyById(id: string): SeriesGenreFamily | undefined {
  return CANONICAL_SERIES_GENRES.find((family) => family.id === id);
}

/**
 * True when a row belongs to a family. Genre membership comes from
 * the row's canonical genres; the category pattern (Reality) matches
 * the provider category text only. Documentary-kind rows belong ONLY
 * to the Documentary family (C1) — a documentary series never counts
 * toward a fictional family even when its provider category also
 * names that genre.
 */
export function rowInSeriesGenreFamily(row: SeriesRow, family: SeriesGenreFamily): boolean {
  if (family.id === "documentary") return isDocumentarySeries(row);
  if (isDocumentarySeries(row)) return false;
  if (family.categoryPattern && family.categoryPattern.test(row.category || "")) return true;
  if (!family.genreIds.length) return false;
  const genres = seriesGenres(row);
  return family.genreIds.some((genre) => genres.includes(genre));
}

// ---------------------------------------------------------------------------
// W1: normaliseRating — one honest rating value.
// Real module: src/scripts/lib/rating-evidence.ts (W1).
//
// SHIM LIMITATION (flagged for integration): the provider rating on a
// SeriesRow is a single string that may be 10-based (`rating`) or
// 5-based (`rating_5based`, folded in by mapSeriesRow) with no scale
// marker surviving. This shim mirrors the existing codebase semantics
// (ratingSortValue / ratingMatches treat the value as a 0–10 number)
// and never invents a scale conversion. W1's real normaliseRating
// owns resolving the scale from the raw row; until then a 5-based
// 4.2 displays as 4.2, exactly as it does on 0.11.7. What this shim
// DOES guarantee: unrated/garbage input yields no value and no label
// — a missing rating is never displayed as a rating.
// ---------------------------------------------------------------------------

export interface NormalisedRating {
  /** Rating on the 0–10 scale, or null when there is no usable rating. */
  value10: number | null;
  /** Display label ("★ 8.4"), or null when there is no usable rating. */
  label: string | null;
  /** True only when a real provider rating backs the value. */
  hasEvidence: boolean;
}

export function normaliseRating(raw: unknown): NormalisedRating {
  const value = ratingSortValue(raw);
  if (!(value > 0)) return { value10: null, label: null, hasEvidence: false };
  const clamped = Math.min(10, value);
  return { value10: clamped, label: `★ ${clamped.toFixed(1)}`, hasEvidence: true };
}

// ---------------------------------------------------------------------------
// W1: selectSeriesWorthStarting — Series Worth Starting shelf.
// Real module: src/scripts/lib/collection-selectors.ts (W1).
//
// Contract semantics (asserted by tests):
// - SERIES-LEVEL entries only, pointing at series detail pages —
//   never individual episode records.
// - Unwatched only: any series the caller reports progress for is
//   excluded (in-progress series live in Continue Watching).
// - Quality evidence first: TMDb-linked titles are preferred over
//   unlinked ones at the same rating (preferEvidence, C2), then
//   highest-rated first. Unrated titles never headline the shelf.
// - Meaningful diversity: at most two titles per primary genre in
//   the first pass, then remaining slots fill by rating — the shelf
//   never collapses to one genre when the catalogue has more.
// - Actual availability: every entry is a row of the supplied
//   catalogue. Nothing is padded in when fewer than the limit
//   qualify — a short honest shelf beats a padded one.
// - No season-completeness claim is made here or by the renderer:
//   a series entry proves the series exists in the catalogue, not
//   that every season/episode is available.
// ---------------------------------------------------------------------------

export interface WorthStartingOptions {
  /** Shelf size. Defaults to 12; the brief asks for ~8–12. */
  limit?: number;
  /** True when the viewer has any recorded progress for the series. */
  hasProgress?: (row: SeriesRow) => boolean;
  /** Minimum normalised rating. Defaults to 7 — "worth starting". */
  minRating?: number;
}

export const WORTH_STARTING_DEFAULT_LIMIT = 12;
export const WORTH_STARTING_DEFAULT_MIN_RATING = 7;
const WORTH_STARTING_PER_GENRE_FIRST_PASS = 2;

function primaryGenreOf(row: SeriesRow): string {
  return seriesGenres(row)[0] ?? "other";
}

export function selectSeriesWorthStarting(
  rows: SeriesRow[],
  opts: WorthStartingOptions = {},
): SeriesRow[] {
  const limit = Math.max(0, opts.limit ?? WORTH_STARTING_DEFAULT_LIMIT);
  if (limit === 0 || rows.length === 0) return [];
  const minRating = opts.minRating ?? WORTH_STARTING_DEFAULT_MIN_RATING;
  const hasProgress = opts.hasProgress ?? (() => false);
  const eligible = preferEvidence(
    rows.filter((row) => {
      if (hasProgress(row)) return false;
      const rating = normaliseRating(row.rating);
      return rating.hasEvidence && (rating.value10 ?? 0) >= minRating;
    }),
  ).sort(
    (a, b) =>
      ratingSortValue(b.rating) - ratingSortValue(a.rating) ||
      (a.name || "").localeCompare(b.name || "", "en", { sensitivity: "base" }),
  );
  // First pass: diversity — at most two per primary genre.
  const picked: SeriesRow[] = [];
  const perGenre = new Map<string, number>();
  const deferred: SeriesRow[] = [];
  for (const row of eligible) {
    if (picked.length >= limit) break;
    const genre = primaryGenreOf(row);
    const count = perGenre.get(genre) ?? 0;
    if (count < WORTH_STARTING_PER_GENRE_FIRST_PASS) {
      picked.push(row);
      perGenre.set(genre, count + 1);
    } else {
      deferred.push(row);
    }
  }
  // Second pass: fill remaining slots by rating order.
  for (const row of deferred) {
    if (picked.length >= limit) break;
    picked.push(row);
  }
  // Whatever the first pass skipped past the limit stays skipped;
  // the loop above already stopped at the limit, so this is exact.
  return picked.slice(0, limit);
}

// ---------------------------------------------------------------------------
// W1: selectRecentlyAdded — Recently Added shelf.
// Real module: src/scripts/lib/collection-selectors.ts (W1).
//
// Ordered by the provider ADDED timestamp (`added`, from
// `last_modified`) ONLY. Release year is never substituted: a row
// with no added timestamp carries no recency evidence and is
// excluded, however new its release year looks.
// ---------------------------------------------------------------------------

export interface RecentlyAddedOptions {
  /** Shelf size. Defaults to 12. */
  limit?: number;
}

export function selectRecentlyAdded(
  rows: SeriesRow[],
  opts: RecentlyAddedOptions = {},
): SeriesRow[] {
  const limit = Math.max(0, opts.limit ?? 12);
  if (limit === 0) return [];
  return [...rows]
    .filter((row) => (row.added || 0) > 0)
    .sort(
      (a, b) =>
        (b.added || 0) - (a.added || 0) ||
        (a.name || "").localeCompare(b.name || "", "en", { sensitivity: "base" }),
    )
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// W2: Home / Browse mode + URL contract.
// Real module: src/scripts/lib/home-browse-modes.ts (W2).
//
// URL shape (single Series nav item, two explicit modes):
//   /series                                    -> home (canonical)
//   /series?mode=browse                        -> browse everything
//   /series?mode=browse&genre=drama&sort=added&page=2&query=...
//   /series?mode=browse&category=<provider category>
//
// parseModeFromUrl is total: unknown/missing mode values fall back to
// home, an invalid page falls back to 1, an unknown sort is dropped.
// Genre/category/query pass through opaquely (validated by the browse
// engine against the live catalogue). Home mode carries no params —
// a genre param on a home URL is ignored, never silently applied.
// setModeInUrl pushes a history entry for a mode change (so B/back
// returns to the previous mode) and replaces for same-mode param
// updates, unless the caller asks otherwise.
// ---------------------------------------------------------------------------

export type HomeBrowseMode = "home" | "browse";

export interface BrowseModeParams {
  /** Series genre family id (CANONICAL_SERIES_GENRES) or canonical genre id. */
  genre?: string;
  /** Raw provider category name. */
  category?: string;
  /** 1-based browse page. Defaults to 1. */
  page?: number;
  /** Browse sort id (SeriesSortMode). */
  sort?: string;
  /** Search query. */
  query?: string;
}

export interface ParsedHomeBrowseMode {
  mode: HomeBrowseMode;
  params: BrowseModeParams;
}

const SERIES_BASE_PATH = "/series";
const KNOWN_SORTS = new Set(["default", "added", "rating", "year-desc", "year-asc", "az"]);

function readSearchParams(search?: string | URLSearchParams): URLSearchParams {
  if (typeof search === "string") return new URLSearchParams(search);
  if (search instanceof URLSearchParams) return search;
  if (typeof window !== "undefined") return new URLSearchParams(window.location.search);
  return new URLSearchParams();
}

export function parseModeFromUrl(search?: string | URLSearchParams): ParsedHomeBrowseMode {
  const params = readSearchParams(search);
  const mode: HomeBrowseMode = params.get("mode") === "browse" ? "browse" : "home";
  if (mode === "home") return { mode, params: {} };
  const out: BrowseModeParams = {};
  const genre = (params.get("genre") || "").trim();
  if (genre) out.genre = genre;
  const category = (params.get("category") || "").trim();
  if (category) out.category = category;
  const pageRaw = Number(params.get("page"));
  out.page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const sort = (params.get("sort") || "").trim();
  if (sort && KNOWN_SORTS.has(sort)) out.sort = sort;
  const query = (params.get("query") || "").trim();
  if (query) out.query = query;
  return { mode, params: out };
}

/** Pure URL builder behind setModeInUrl. Home mode is the bare path. */
export function browseModeUrl(mode: HomeBrowseMode, params: BrowseModeParams = {}): string {
  if (mode === "home") return SERIES_BASE_PATH;
  const search = new URLSearchParams();
  search.set("mode", "browse");
  if (params.genre) search.set("genre", params.genre);
  if (params.category) search.set("category", params.category);
  if (params.page && params.page > 1) search.set("page", String(params.page));
  if (params.sort) search.set("sort", params.sort);
  if (params.query) search.set("query", params.query);
  return `${SERIES_BASE_PATH}?${search.toString()}`;
}

/**
 * Write a mode + params into the URL and return the new URL string.
 * No-op (except returning the URL) outside a browser. Mode changes
 * push a history entry; same-mode param updates replace, so the Back
 * stack holds modes, not every filter tweak.
 */
export function setModeInUrl(
  mode: HomeBrowseMode,
  params: BrowseModeParams = {},
  opts: { replace?: boolean } = {},
): string {
  const url = browseModeUrl(mode, params);
  if (typeof window === "undefined" || typeof window.history === "undefined") return url;
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === url) return url;
  const currentMode = parseModeFromUrl().mode;
  const replace = opts.replace ?? currentMode === mode;
  try {
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  } catch {
    // History unavailable (sandboxed iframe): the returned URL is
    // still the truth; callers may navigate with it directly.
  }
  return url;
}
