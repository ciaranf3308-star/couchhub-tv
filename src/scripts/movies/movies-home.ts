// Movies Home — pure view-model assembly for the 0.11.8 Movies Home
// screen (brief §1.1, §2, §3, §14, §17, §18 Home parts).
//
// Discovery is curated, browsing is exhaustive, and they are not the
// same screen: this module builds ONLY the curated Home model — one
// featured film, Continue Watching, Worth Watching, Recently Added,
// Explore Genres, and the Browse Everything entry. It never builds a
// full catalogue grid (acceptance test 1) and never fetches, calls a
// paid model, or invents metadata: every field comes from the
// catalogue rows, saved progress, or the local taste model the
// caller supplies.
//
// Selection itself comes from the W1 contract (collection selectors
// + catalog index + rating evidence, via movies-home-shims.ts until
// integration wires the real W1 modules). This module owns the Home
// composition rules on top of those selections: Continue Watching
// eligibility, cross-shelf diversity, honest shelf labelling, genre
// tile counts, and the featured view model (including the compact
// fallback when no suitable artwork/description exists).
//
// Pure and side-effect free: no DOM, no storage, no network. The DOM
// mount lives in movies-home-mount.ts.

import {
  addedTimestampMs,
  formatClock,
  formatMovieRuntime,
  genreDisplayLabel,
  movieGenres,
  movieMetaLine,
  movieProgressFraction,
  RESUME_MIN_SECONDS,
  type MovieRow,
} from "@/scripts/movies/couch-movies.ts";
import type { GenreId } from "@/scripts/lib/genres.ts";
import { parseYear } from "@/scripts/lib/browse-filters.ts";
import type { TasteModel } from "@/scripts/lib/taste.ts";
import type { CouchCardView } from "@/scripts/movies/couch-cards.ts";
import {
  CANONICAL_MOVIE_GENRES,
  getCatalogIndex,
  normaliseRating,
  selectFeaturedFilm,
  selectRecentlyAdded,
  selectWorthWatching,
  type CatalogIndex,
} from "@/scripts/movies/movies-home-shims.ts";
import { buildModeUrl } from "@/scripts/movies/movies-home-modes-shim.ts";

export type { CatalogIndex };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Continue Watching shows at most this many posters (§3.3). */
export const CONTINUE_WATCHING_VISIBLE = 8;
/** Worth Watching shelf size (§3.4: ~8–12). */
export const WORTH_WATCHING_LIMIT = 12;
/** Recently Added shelf size (§3.5). */
export const RECENTLY_ADDED_LIMIT = 12;
/** Prominent genre tiles (§3.6) — the first six canonical genres. */
export const PROMINENT_GENRE_COUNT = 6;
/** Genre tile rows: 4 tiles per rail row (controller D-pad friendly). */
export const GENRE_TILES_PER_ROW = 4;
/** Featured synopsis cap — a useful short synopsis, never a wall. */
export const FEATURED_SYNOPSIS_MAX_CHARS = 220;

/** Focus-memory rail ids for every Home section (§16.5). */
export const MOVIES_HOME_RAILS = {
  actions: "movies-home-actions",
  featured: "movies-featured",
  continue: "movies-continue",
  worth: "movies-worth",
  recent: "movies-recent",
  genresA: "movies-genres-a",
  genresB: "movies-genres-b",
  browseEntry: "movies-browse-entry",
} as const;

/** Detail route for one movie row (existing app pattern). */
export function movieDetailHref(row: MovieRow): string {
  return `/movies/detail?id=${encodeURIComponent(row.id)}`;
}

/** Display label for a canonical genre on Movies Home (§3.6). */
export function movieGenreLabel(id: GenreId): string {
  if (id === "sci-fi") return "Science Fiction";
  return genreDisplayLabel(id);
}

// ---------------------------------------------------------------------------
// Continue Watching (§3.3)
// ---------------------------------------------------------------------------

export interface MoviesHomeProgress {
  position?: number;
  duration?: number;
  completed?: boolean;
  updatedAt?: number;
}

export type ProgressById =
  | Map<number, MoviesHomeProgress | null | undefined>
  | Record<number, MoviesHomeProgress | null | undefined>;

function progressFor(progressById: ProgressById, id: number): MoviesHomeProgress | null {
  if (progressById instanceof Map) return progressById.get(id) ?? null;
  return (progressById as Record<number, MoviesHomeProgress | null | undefined>)[id] ?? null;
}

export interface ContinueWatchingItem {
  row: MovieRow;
  /** Watched fraction in (0, 1). */
  fraction: number;
  /** "42:10 left" — empty when the remaining time is unknown. */
  remainingLabel: string;
  /** Raw saved progress (for card views). */
  progress: MoviesHomeProgress;
}

/**
 * Genuinely in-progress movies only: a saved position with a known
 * duration, strictly between started and finished, not completed.
 * Never-started (no record / zero position), completed, and
 * meaningless zero-progress entries (under 30s into a feature-length
 * title — the same resume threshold the detail page uses) are all
 * excluded. Short-form titles (≤5 min) keep any positive progress:
 * 10s into a 20s clip is half-watched, not meaningless.
 * Most recently watched first. Pure.
 */
export function selectContinueWatchingMovies(
  rows: MovieRow[],
  progressById: ProgressById,
): ContinueWatchingItem[] {
  const scored: Array<ContinueWatchingItem & { updatedAt: number }> = [];
  for (const row of rows) {
    const progress = progressFor(progressById, row.id);
    if (!progress || progress.completed) continue;
    const duration = Number(progress.duration) || 0;
    const position = Number(progress.position) || 0;
    if (!(duration > 0) || !(position > 0)) continue;
    const fraction = movieProgressFraction(progress);
    if (!(fraction > 0) || fraction >= 1) continue;
    if (position < RESUME_MIN_SECONDS && duration > 300) continue;
    const remaining = duration - position;
    scored.push({
      row,
      fraction,
      remainingLabel: remaining > 0 ? `${formatClock(remaining)} left` : "",
      progress,
      updatedAt: progress.updatedAt || 0,
    });
  }
  scored.sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    if (b.fraction !== a.fraction) return b.fraction - a.fraction;
    return (a.row.name || "").localeCompare(b.row.name || "", "en", { sensitivity: "base" });
  });
  return scored.map(({ row, fraction, remainingLabel, progress }) => ({
    row,
    fraction,
    remainingLabel,
    progress,
  }));
}

// ---------------------------------------------------------------------------
// Diversity (§14.4)
// ---------------------------------------------------------------------------

/**
 * Remove cross-shelf repeats: the featured film never reappears in
 * Worth Watching or Recently Added, and Worth Watching titles never
 * reappear in Recently Added, on the same page. Continue Watching is
 * EXEMPT (a film can be both featured and in progress). Order is
 * preserved; no backfilling here — the selectors already exclude by
 * id, so this is the composition safety net. Pure.
 */
export function applyHomeDiversity(
  featured: MovieRow | null,
  worthWatching: MovieRow[],
  recentlyAdded: MovieRow[],
): { worthWatching: MovieRow[]; recentlyAdded: MovieRow[] } {
  const featuredId = featured?.id;
  const worth = featuredId == null ? [...worthWatching] : worthWatching.filter((row) => row.id !== featuredId);
  const worthIds = new Set(worth.map((row) => row.id));
  const recent = recentlyAdded.filter(
    (row) => row.id !== featuredId && !worthIds.has(row.id),
  );
  return { worthWatching: worth, recentlyAdded: recent };
}

// ---------------------------------------------------------------------------
// Featured film (§3.2)
// ---------------------------------------------------------------------------

export interface FeaturedFilm {
  row: MovieRow;
  title: string;
  /** Release year, or "" when the provider supplied none. */
  year: string;
  /** Runtime label ("2h 5m"), or "" when unknown. */
  runtimeLabel: string;
  /** Genre summary ("Action · Thriller"), or "" when unknown. */
  genreSummary: string;
  /** Provider synopsis, truncated — "" when the provider sent none.
   * Never invented. */
  synopsis: string;
  /** Credible rating label ("★ 8.4"), or "" when unsupported. */
  ratingLabel: string;
  /** Verified poster artwork (provider-supplied), or null. */
  posterSrc: string | null;
  /**
   * True when the compact fallback must render instead of the
   * cinematic hero: no verified artwork AND no description. Never a
   * giant empty hero.
   */
  compact: boolean;
  detailHref: string;
  /** Saved progress fraction (0 when never started). */
  progressFraction: number;
  /** Primary action label: Continue when in progress, else details. */
  primaryLabel: string;
}

function truncateSynopsis(plot: string): string {
  const text = (plot || "").replace(/\s+/g, " ").trim();
  if (text.length <= FEATURED_SYNOPSIS_MAX_CHARS) return text;
  const cut = text.slice(0, FEATURED_SYNOPSIS_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Build the featured view model from one row. Pure. */
export function featuredViewModel(
  row: MovieRow,
  progress: MoviesHomeProgress | null | undefined,
): FeaturedFilm {
  const year = parseYear(row.year);
  const rating = normaliseRating(row.rating, { tmdb: row.tmdb });
  const posterSrc = row.logo || null;
  const synopsis = truncateSynopsis(row.plot || "");
  const fraction = movieProgressFraction(progress);
  const inProgress = !!progress && !progress.completed && fraction > 0 && fraction < 1;
  const genres = movieGenres(row).slice(0, 3).map(genreDisplayLabel);
  return {
    row,
    title: row.name,
    year: year != null ? String(year) : "",
    runtimeLabel: formatMovieRuntime(row.duration),
    genreSummary: genres.join(" · "),
    synopsis,
    ratingLabel: rating.credible ? rating.label : "",
    posterSrc,
    compact: posterSrc == null && synopsis === "",
    detailHref: movieDetailHref(row),
    progressFraction: fraction,
    primaryLabel: inProgress ? "Continue Watching" : "View Details",
  };
}

// ---------------------------------------------------------------------------
// Honest shelf labelling (§3.4, §3.5)
// ---------------------------------------------------------------------------

/**
 * Worth Watching heading, chosen by what the evidence actually
 * supports — never "AI picks" (the shelf is local; no model ran).
 * Strong evidence (taste affinity or mostly credible ratings) keeps
 * "Worth Watching"; thin evidence falls back to a neutral label the
 * data supports. Pure.
 */
export function chooseWorthWatchingLabel(input: {
  hasTasteAffinity: boolean;
  credibleCount: number;
  total: number;
}): string {
  const { hasTasteAffinity, credibleCount, total } = input;
  if (total <= 0) return "Explore Movies";
  if (hasTasteAffinity || credibleCount * 2 >= total) return "Worth Watching";
  if (credibleCount > 0) return "Popular in Your Library";
  return "Explore Movies";
}

/** True when the taste model carries any affinity signal at all. */
export function tasteHasAffinity(taste: TasteModel | null | undefined): boolean {
  if (!taste) return false;
  if ((taste.likedTitles ?? []).length > 0) return true;
  if ((taste.favouriteTitles ?? []).length > 0) return true;
  return Object.values(taste.genreWeights ?? {}).some(
    (w) => typeof w === "number" && w > 0,
  );
}

export interface RecentlyAddedEvidence {
  /** True when at least one shown title carries a usable ADDED date. */
  hasValidDates: boolean;
  /** Age of the newest shown title, in days — null without dates. */
  newestAgeDays: number | null;
  /** Honest supporting note for the shelf (never "just added" unless true). */
  note: string;
}

/**
 * Recently Added labelling evidence (§3.5): the note says "last 30
 * days" ONLY when every shown dated title is within 30 days;
 * otherwise it says "newest additions" without implying
 * just-uploaded-today. Without dates it says "newest titles" and
 * reports hasValidDates false. Pure.
 */
export function recentlyAddedEvidence(
  items: MovieRow[],
  nowMs: number,
): RecentlyAddedEvidence {
  const dates = items
    .map((row) => addedTimestampMs(row.added, nowMs))
    .filter((value): value is number => value != null);
  if (dates.length === 0) {
    return {
      hasValidDates: false,
      newestAgeDays: null,
      note: "Newest titles in your library",
    };
  }
  const newest = Math.max(...dates);
  const newestAgeDays = (nowMs - newest) / (24 * 60 * 60 * 1000);
  const oldest = Math.min(...dates);
  const allWithin30 = nowMs - oldest <= 30 * 24 * 60 * 60 * 1000;
  return {
    hasValidDates: true,
    newestAgeDays,
    note: allWithin30
      ? "Added to your library in the last 30 days"
      : "Newest additions to your library",
  };
}

// ---------------------------------------------------------------------------
// Explore Genres (§3.6)
// ---------------------------------------------------------------------------

export interface GenreTile {
  id: GenreId | "all";
  label: string;
  /** REAL matching title count (distinct displayed titles). */
  count: number;
  /** Browse Everything URL with this genre applied. */
  href: string;
}

/**
 * Genre tiles: the prominent six (in canonical order) that have at
 * least one title, plus All Genres. Counts use the same genre match
 * the browse filter uses (movieGenres over the provider category),
 * so a tile count equals the Browse result count for that genre.
 * No artwork — typographic tiles only, so no unrelated poster can
 * mislead. Pure.
 */
export function genreTiles(index: CatalogIndex): GenreTile[] {
  const counts = new Map<GenreId, number>();
  for (const row of index.rows) {
    for (const genre of movieGenres(row)) {
      counts.set(genre, (counts.get(genre) || 0) + 1);
    }
  }
  const tiles: GenreTile[] = [];
  for (const genre of CANONICAL_MOVIE_GENRES.slice(0, PROMINENT_GENRE_COUNT)) {
    const count = counts.get(genre) || 0;
    if (count <= 0) continue;
    tiles.push({
      id: genre,
      label: movieGenreLabel(genre),
      count,
      href: buildModeUrl({ view: "browse", genre }),
    });
  }
  tiles.push({
    id: "all",
    label: "All Genres",
    count: index.total,
    href: buildModeUrl({ view: "browse" }),
  });
  return tiles;
}

// ---------------------------------------------------------------------------
// Card views (consume couch-cards; no new card variants here)
// ---------------------------------------------------------------------------

/**
 * Card view for a Home shelf poster: credible rating badges only —
 * an uncredible provider rating never shows as a badge on Home.
 * Progress bars show only for genuinely in-progress titles.
 */
export function movieHomeCardView(
  row: MovieRow,
  progress: MoviesHomeProgress | null | undefined,
  opts: { metaSuffix?: string } = {},
): CouchCardView {
  const rating = normaliseRating(row.rating, { tmdb: row.tmdb });
  const fraction = movieProgressFraction(progress);
  const meta = [movieMetaLine(row), opts.metaSuffix || ""].filter(Boolean).join(" · ");
  return {
    title: row.name,
    meta,
    image: row.logo,
    kind: "poster",
    progress: fraction > 0 && fraction < 1 ? fraction : 0,
    badge: rating.credible ? rating.label : undefined,
    href: movieDetailHref(row),
    itemKey: `vod-${row.id}`,
  };
}

// ---------------------------------------------------------------------------
// Home model assembly (§1.1, §2)
// ---------------------------------------------------------------------------

export interface MoviesHomeModel {
  /** Distinct displayed titles in the library. */
  totalCount: number;
  featured: FeaturedFilm | null;
  continueWatching: { items: ContinueWatchingItem[]; total: number };
  worthWatching: { items: MovieRow[]; label: string };
  recentlyAdded: { items: MovieRow[]; evidence: RecentlyAddedEvidence };
  genres: GenreTile[];
  /** False when the catalogue is empty (the empty state renders). */
  hasContent: boolean;
}

export interface BuildMoviesHomeInput {
  rows: MovieRow[];
  playlistId: string;
  taste: TasteModel | null | undefined;
  progressById: ProgressById;
  /** Rotation seed — persisted by the mount, changed only by Refresh Picks. */
  rotationSeed?: number;
  nowMs?: number;
}

/**
 * Assemble the full Movies Home model. Selection via the W1
 * contract; composition (continue eligibility, diversity, honest
 * labels, genre counts) here. Completed titles never headline and
 * never fill Worth Watching. Pure.
 */
export function buildMoviesHomeModel(input: BuildMoviesHomeInput): MoviesHomeModel {
  const nowMs = input.nowMs ?? Date.now();
  const seed = input.rotationSeed ?? 0;
  const index = getCatalogIndex(input.rows, input.playlistId);
  const rows = index.rows;

  const completedIds = new Set<number>();
  for (const row of rows) {
    const progress = progressFor(input.progressById, row.id);
    if (progress?.completed || movieProgressFraction(progress) >= 1) {
      completedIds.add(row.id);
    }
  }

  const continueItems = selectContinueWatchingMovies(rows, input.progressById);

  const featuredRow = selectFeaturedFilm(index, input.taste, {
    rotationSeed: seed,
    excludeIds: completedIds,
    nowMs,
  });
  const featured = featuredRow
    ? featuredViewModel(featuredRow, progressFor(input.progressById, featuredRow.id))
    : null;

  const excludeForWorth = new Set<number>([
    ...(featuredRow ? [featuredRow.id] : []),
  ]);
  const worthRaw = selectWorthWatching(index, input.taste, {
    limit: WORTH_WATCHING_LIMIT,
    excludeIds: excludeForWorth,
    completedIds,
    rotationSeed: seed,
    // NO verified-AI input: no verified cache is plumbed and the
    // privacy conditions are unverified — the shelf stays local.
    nowMs,
  });

  const excludeForRecent = new Set<number>([
    ...(featuredRow ? [featuredRow.id] : []),
    ...worthRaw.map((row) => row.id),
  ]);
  const recentRaw = selectRecentlyAdded(index, {
    limit: RECENTLY_ADDED_LIMIT,
    excludeIds: excludeForRecent,
    nowMs,
  });

  // Composition safety net (selectors already exclude by id).
  const { worthWatching, recentlyAdded } = applyHomeDiversity(
    featuredRow,
    worthRaw,
    recentRaw,
  );

  const credibleCount = worthWatching.filter(
    (row) => normaliseRating(row.rating, { tmdb: row.tmdb }).credible,
  ).length;

  return {
    totalCount: index.total,
    featured,
    continueWatching: {
      items: continueItems.slice(0, CONTINUE_WATCHING_VISIBLE),
      total: continueItems.length,
    },
    worthWatching: {
      items: worthWatching,
      label: chooseWorthWatchingLabel({
        hasTasteAffinity: tasteHasAffinity(input.taste),
        credibleCount,
        total: worthWatching.length,
      }),
    },
    recentlyAdded: {
      items: recentlyAdded,
      evidence: recentlyAddedEvidence(recentlyAdded, nowMs),
    },
    genres: genreTiles(index),
    hasContent: rows.length > 0,
  };
}

/** Browse Everything URLs used by Home entry points (§3.5, §3.7). */
export const MOVIES_HOME_BROWSE_URLS = {
  everything: buildModeUrl({ view: "browse" }),
  continueWatching: buildModeUrl({ view: "browse", list: "continue" }),
  recentlyAdded: buildModeUrl({ view: "browse", sort: "added" }),
  search: buildModeUrl({ view: "browse", focus: "search" }),
} as const;
