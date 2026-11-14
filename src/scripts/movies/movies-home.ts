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
// Selection itself comes from the W1 data layer (collection
// selectors + catalog index + rating evidence). This module owns
// the Home composition rules on top of those selections: Continue
// Watching eligibility, cross-shelf diversity, honest shelf
// labelling, genre tile counts, and the featured view model
// (including the compact fallback when no suitable
// artwork/description exists).
//
// Pure and side-effect free: no DOM, no storage, no network. The DOM
// mount lives in movies-home-mount.ts.

import {
  addedTimestampMs,
  formatClock,
  formatMovieRuntime,
  movieMetaLine,
  movieProgressFraction,
  RESUME_MIN_SECONDS,
  type MovieRow,
} from "@/scripts/movies/couch-movies.ts";
import {
  genreLabelForId,
  genresForEntry,
  type GenreId,
} from "@/scripts/lib/genres.ts";
import {
  getCatalogIndex,
  type CatalogIndex,
} from "@/scripts/lib/catalog-index.ts";
import {
  hasCredibleRating,
  normaliseRating,
} from "@/scripts/lib/rating-evidence.ts";
import {
  selectAiRankedPicks,
  selectFeaturedFilm,
  selectHiddenGems,
  selectRecentlyAdded,
  selectSomethingDifferent,
  selectWorthWatching,
  type SelectorResult,
} from "@/scripts/lib/collection-selectors.ts";
import {
  allocateShelves,
  HOME_SHELF_LIMITS,
  SHELF_POOL_OVERFETCH,
} from "@/scripts/lib/home-shelf-variety.ts";
import {
  groundedReasonForAiCard,
  homeAiSourceNote,
  type HomeAiPick,
  type HomeAiSource,
} from "@/scripts/lib/home-ai-picks.ts";
import { parseYear } from "@/scripts/lib/browse-filters.ts";
import type { BrowseSortId } from "@/scripts/lib/browse-state.ts";
import type { TasteModel } from "@/scripts/lib/taste.ts";
import type { CouchCardView } from "@/scripts/movies/couch-cards.ts";
import { modeToSearchParams } from "@/scripts/lib/home-browse-modes.ts";

export type { CatalogIndex } from "@/scripts/lib/catalog-index.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Continue Watching shows at most this many posters (§3.3). */
export const CONTINUE_WATCHING_VISIBLE = 8;
/** Worth Watching shelf size (0.11.14 §15: richer rows; rails scroll horizontally). */
export const WORTH_WATCHING_LIMIT = HOME_SHELF_LIMITS.worthWatching;
/** Recently Added shelf size (0.11.14 §15). */
export const RECENTLY_ADDED_LIMIT = HOME_SHELF_LIMITS.recentlyAdded;
/** AI Picks shelf size (0.11.14 §12–§13; the ranker caps at 20). */
export const AI_PICKS_LIMIT = HOME_SHELF_LIMITS.aiPicks;
/** Something Different shelf size (0.11.14 §14). */
export const SOMETHING_DIFFERENT_LIMIT = HOME_SHELF_LIMITS.somethingDifferent;
/** Hidden Gems shelf size (0.11.14 §14). */
export const HIDDEN_GEMS_LIMIT = HOME_SHELF_LIMITS.hiddenGems;
/** Prominent genre tiles (§3.6) — the first six canonical genres. */
export const PROMINENT_GENRE_COUNT = 6;
/** The prominent six, in brief §3.6 order (not taxonomy order). */
export const PROMINENT_GENRES: GenreId[] = [
  "action",
  "comedy",
  "horror",
  "thriller",
  "sci-fi",
  "drama",
];
/** Genre tile rows: 4 tiles per rail row (controller D-pad friendly). */
export const GENRE_TILES_PER_ROW = 4;
/** Featured synopsis cap — a useful short synopsis, never a wall. */
export const FEATURED_SYNOPSIS_MAX_CHARS = 220;

/** Focus-memory rail ids for every Home section (§16.5). */
export const MOVIES_HOME_RAILS = {
  actions: "movies-home-actions",
  featured: "movies-featured",
  continue: "movies-continue",
  ai: "movies-ai-picks",
  worth: "movies-worth",
  different: "movies-different",
  gems: "movies-gems",
  recent: "movies-recent",
  discover: "movies-discover-entries",
  genresA: "movies-genres-a",
  genresB: "movies-genres-b",
  browseEntry: "movies-browse-entry",
} as const;

/** Detail route for one movie row (existing app pattern). */
export function movieDetailHref(row: MovieRow): string {
  return `/movies/detail?id=${encodeURIComponent(row.id)}`;
}

/** Browse Everything URL for one mode (W2 URL contract). */
function browseUrl(opts: { category?: string; sort?: BrowseSortId }): string {
  const params = modeToSearchParams({
    view: "browse",
    kind: "movie",
    category: opts.category,
    sort: opts.sort,
  });
  return `/movies?${params.toString()}`;
}

/** Display label for a canonical genre on Movies Home (§3.6). */
export function movieGenreLabel(id: GenreId): string {
  return genreLabelForId(id, "vod");
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
  const rating = normaliseRating(row);
  const ratingLabel = hasCredibleRating(rating)
    ? `★ ${rating!.score10.toFixed(1)}`
    : "";
  const posterSrc = row.logo || null;
  const synopsis = truncateSynopsis(row.plot || "");
  const fraction = movieProgressFraction(progress);
  const inProgress = !!progress && !progress.completed && fraction > 0 && fraction < 1;
  const genres = genresForEntry(row, "vod").slice(0, 3).map((id) => genreLabelForId(id, "vod"));
  return {
    row,
    title: row.name,
    year: year != null ? String(year) : "",
    runtimeLabel: formatMovieRuntime(row.duration),
    genreSummary: genres.join(" · "),
    synopsis,
    ratingLabel,
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
 * Genre tiles: the prominent six (in brief §3.6 order, NOT the
 * taxonomy's alphabetical order) that have at least one title, plus
 * All Genres. Counts come from the W1 index's display-level genre
 * buckets, so a tile count ALWAYS equals the Browse result count
 * for that genre. No artwork — typographic tiles only, so no
 * unrelated poster can mislead. Pure.
 */
export function genreTiles(index: CatalogIndex): GenreTile[] {
  const tiles: GenreTile[] = [];
  for (const genre of PROMINENT_GENRES) {
    const count = index.idsByGenre.get(genre)?.length || 0;
    if (count <= 0) continue;
    tiles.push({
      id: genre,
      label: movieGenreLabel(genre),
      count,
      href: browseUrl({ category: `genre:${genre}` }),
    });
  }
  tiles.push({
    id: "all",
    label: "All Genres",
    count: index.totalGroups,
    href: browseUrl({}),
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
  opts: { metaSuffix?: string; detail?: string | null } = {},
): CouchCardView {
  const rating = normaliseRating(row);
  const fraction = movieProgressFraction(progress);
  const meta = [movieMetaLine(row), opts.metaSuffix || ""].filter(Boolean).join(" · ");
  return {
    title: row.name,
    meta,
    detail: opts.detail || undefined,
    image: row.logo,
    kind: "poster",
    progress: fraction > 0 && fraction < 1 ? fraction : 0,
    badge: hasCredibleRating(rating) ? `★ ${rating!.score10.toFixed(1)}` : undefined,
    href: movieDetailHref(row),
    itemKey: `vod-${row.id}`,
  };
}

// ---------------------------------------------------------------------------
// Recommendation shelf items (0.11.14 §14, §22)
// ---------------------------------------------------------------------------

/** One recommendation-shelf card: the row plus its grounded reason (focus detail). */
export interface HomeShelfItem {
  row: MovieRow;
  /** Grounded reason for the focus overlay, or null when nothing honest can be said. */
  reason: string | null;
}

/**
 * The AI action the mount offers, chosen by what is true — never a
 * misleading button. "generate" = no verified picks yet, AI is
 * configured: one explicit request. "request-fresh" = verified picks
 * are showing: asking again costs one more request. "none" = AI is
 * not configured: no AI button at all, local shelves only. The hint
 * always says whether an API call happens; the local Refresh Picks
 * action (seed rotation, no call) is separate and labelled local.
 */
export interface MoviesHomeAiAction {
  kind: "generate" | "request-fresh" | "none";
  /** Button label. */
  label: string;
  /** Honest hint under/near the button (API call or not). */
  hint: string;
}

export function chooseMoviesHomeAiAction(input: {
  aiConfigured: boolean;
  hasVerifiedPicks: boolean;
  aiRequestInFlight?: boolean;
}): MoviesHomeAiAction {
  if (!input.aiConfigured) {
    return { kind: "none", label: "", hint: "" };
  }
  if (input.hasVerifiedPicks) {
    return {
      kind: "request-fresh",
      label: "Request fresh AI picks",
      hint: "Requests fresh picks from your AI provider — one request.",
    };
  }
  return {
    kind: "generate",
    label: "Generate AI Picks",
    hint: "Uses your configured AI provider — one request. Results are cached for a day.",
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
  /** Verified AI picks only — empty unless real verified AI input was supplied and allowed. */
  aiPicks: { items: HomeShelfItem[]; source: HomeAiSource; label: string; note: string };
  worthWatching: { items: MovieRow[]; label: string; reasons: Record<string, string> };
  /** Controlled exploration outside the strongest taste genres (local, never AI-labelled). */
  somethingDifferent: { items: HomeShelfItem[] };
  /** Quality + underexposure (local, never AI-labelled). */
  hiddenGems: { items: HomeShelfItem[] };
  recentlyAdded: { items: MovieRow[]; evidence: RecentlyAddedEvidence };
  genres: GenreTile[];
  /** The AI action for the mount (generate / request-fresh / none). */
  aiAction: MoviesHomeAiAction;
  /** Honest note when AI was attempted/unavailable (mount shows it; local shelves stay). */
  aiNote: string | null;
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
  /**
   * Verified AI picks (home-ai-picks.ts) in model order. Ignored
   * unless `aiAllowed` is true — supplying picks without permission
   * must never produce an "AI" shelf.
   */
  aiPicks?: HomeAiPick[] | null;
  /** True only when verified AI input may be shown (privacy conditions met). */
  aiAllowed?: boolean;
  /** What actually produced `aiPicks` — the shelf label source. */
  aiSource?: HomeAiSource;
  /** Model id behind `aiPicks`, when known. */
  aiModel?: string;
  /** Honest note when AI was attempted but unavailable (shown with local shelves). */
  aiNote?: string | null;
  /** True when an AI request could run (enabled + endpoint + model set). */
  aiConfigured?: boolean;
}

/**
 * Group-level progress: the Home shelves show one poster per title
 * group, so progress rolls up across a group's variants. A group is
 * in progress when any member is genuinely in progress (the 30s
 * rule from selectContinueWatchingMovies applies per member); the
 * most recently updated in-progress member supplies the position.
 * A group counts as completed only when NO member is in progress
 * and at least one member is completed — a completed variant must
 * not hide an in-progress one.
 */
function groupProgressForHome(
  index: CatalogIndex,
  progressById: ProgressById,
): {
  continueByPrimary: Map<number, MoviesHomeProgress>;
  completedIds: Set<string>;
} {
  const continueByPrimary = new Map<number, MoviesHomeProgress>();
  const completedIds = new Set<string>();
  for (const group of index.groups) {
    let latestInProgress: MoviesHomeProgress | null = null;
    let latestUpdated = -1;
    const completedMembers: string[] = [];
    for (const memberId of group.variantIds) {
      const progress = progressFor(progressById, Number(memberId));
      if (!progress) continue;
      const fraction = movieProgressFraction(progress);
      if (progress.completed || fraction >= 1) {
        completedMembers.push(memberId);
        continue;
      }
      const duration = Number(progress.duration) || 0;
      const position = Number(progress.position) || 0;
      if (!(duration > 0) || !(position > 0)) continue;
      if (position < RESUME_MIN_SECONDS && duration > 300) continue;
      if (!(fraction > 0) || fraction >= 1) continue;
      const updatedAt = progress.updatedAt || 0;
      if (updatedAt >= latestUpdated) {
        latestInProgress = progress;
        latestUpdated = updatedAt;
      }
    }
    if (latestInProgress) {
      continueByPrimary.set(Number(group.primaryId), latestInProgress);
    } else if (completedMembers.length > 0) {
      for (const id of completedMembers) completedIds.add(id);
    }
  }
  return { continueByPrimary, completedIds };
}

/** Resolve selector result ids to their primary rows (order kept). */
function resolveGroupRows(index: CatalogIndex, ids: string[]): MovieRow[] {
  const rows: MovieRow[] = [];
  for (const id of ids) {
    const row = index.byId.get(id) as MovieRow | undefined;
    if (row) rows.push(row);
  }
  return rows;
}

/** Resolve selector results to pool items carrying their first evidence reason. */
function poolItemsFor(
  index: CatalogIndex,
  results: SelectorResult[],
): Array<{ id: string; row: MovieRow; reason: string | null }> {
  const items: Array<{ id: string; row: MovieRow; reason: string | null }> = [];
  for (const result of results) {
    const row = index.byId.get(result.id) as MovieRow | undefined;
    if (row) {
      items.push({ id: result.id, row, reason: result.reasons[0] ?? null });
    }
  }
  return items;
}

/** Grounded focus reason for one AI pick: model reason wins, evidence follows, neutral last. */
function aiPickReason(row: MovieRow, result: SelectorResult): string {
  const rating = normaliseRating(row);
  const genres = genresForEntry(row, "vod")
    .slice(0, 2)
    .map((id) => genreLabelForId(id, "vod"));
  const year = parseYear(row.year);
  return groundedReasonForAiCard({
    modelReason: result.reasons[0] ?? null,
    selectorReasons: result.reasons.slice(1),
    genres,
    ratingLabel: hasCredibleRating(rating) ? `★ ${rating!.score10.toFixed(1)}` : "",
    year: year != null ? String(year) : "",
  });
}

/**
 * Assemble the full Movies Home model. Selection via the W1
 * selectors; composition (continue eligibility, cross-shelf
 * allocation with backfill, honest labels, genre counts) here.
 * Completed titles never headline and never fill Worth Watching.
 * AI picks appear ONLY when the caller supplied verified picks AND
 * aiAllowed is true — otherwise the AI shelf is empty and local
 * shelves carry the page. Pure.
 */
export function buildMoviesHomeModel(input: BuildMoviesHomeInput): MoviesHomeModel {
  const nowMs = input.nowMs ?? Date.now();
  const seed = input.rotationSeed ?? 0;
  const revision = `${input.playlistId}:${input.rows.length}`;
  const index = getCatalogIndex("vod", input.rows, revision, {
    playlistId: input.playlistId,
  });
  const primaries = resolveGroupRows(
    index,
    index.groups.map((group) => group.primaryId),
  );

  const { continueByPrimary, completedIds } = groupProgressForHome(
    index,
    input.progressById,
  );

  // D26: the selector cache does not fingerprint the completed-set
  // contents, so the cache key carries them explicitly — a completed
  // title must drop out of Featured/Worth on the next build.
  const cacheKeyBase = [
    "movies-home",
    revision,
    `seed:${seed}`,
    `completed:${[...completedIds].sort().join(",")}`,
  ].join("|");

  const continueItems = selectContinueWatchingMovies(primaries, continueByPrimary);

  const featuredResult = selectFeaturedFilm(index, input.taste, 1, {
    rotationSeed: seed,
    excludeCompleted: true,
    completedIds,
    cacheKey: `${cacheKeyBase}|featured`,
    nowMs,
  });
  const featuredRow = featuredResult
    ? ((index.byId.get(featuredResult.id) as MovieRow | undefined) ?? null)
    : null;
  const featured = featuredRow
    ? featuredViewModel(featuredRow, continueByPrimary.get(featuredRow.id) ?? null)
    : null;

  // Verified AI picks (0.11.14 §19): model order preserved, hard
  // exclusions + completed exclusion applied inside the selector.
  // No verified input (or not allowed) = no AI shelf, no AI label.
  const aiAllowed = input.aiAllowed === true && Array.isArray(input.aiPicks);
  const aiResults = aiAllowed
    ? selectAiRankedPicks(index, input.aiPicks, input.taste, AI_PICKS_LIMIT, {
        excludeCompleted: true,
        completedIds,
      })
    : [];
  const aiPool = poolItemsFor(index, aiResults).map((item) => ({
    ...item,
    reason: aiPickReason(
      item.row,
      aiResults.find((result) => result.id === item.id)!,
    ),
  }));
  const aiSource: HomeAiSource =
    aiResults.length > 0 ? (input.aiSource ?? "ai") : "local";

  const worthResults = selectWorthWatching(
    index,
    input.taste,
    WORTH_WATCHING_LIMIT * SHELF_POOL_OVERFETCH,
    {
      rotationSeed: seed,
      excludeCompleted: true,
      completedIds,
      cacheKey: `${cacheKeyBase}|worth`,
      // Worth Watching stays LOCAL (§14): AI input is never passed
      // here, so the shelf can never be mislabelled as AI-generated.
      nowMs,
    },
  );
  const worthPool = poolItemsFor(index, worthResults);

  const differentResults = selectSomethingDifferent(
    index,
    input.taste,
    SOMETHING_DIFFERENT_LIMIT * SHELF_POOL_OVERFETCH,
    {
      rotationSeed: seed,
      excludeCompleted: true,
      completedIds,
      cacheKey: `${cacheKeyBase}|different`,
      nowMs,
    },
  );
  const differentPool = poolItemsFor(index, differentResults);

  const gemsResults = selectHiddenGems(
    index,
    input.taste,
    HIDDEN_GEMS_LIMIT * SHELF_POOL_OVERFETCH,
    {
      excludeCompleted: true,
      completedIds,
      cacheKey: `${cacheKeyBase}|gems`,
      nowMs,
    },
  );
  const gemsPool = poolItemsFor(index, gemsResults);

  // Recently Added: a 90-day cutoff first (brief §3.5's meaningful
  // cutoff); when fewer than 4 titles survive allocation, extend to
  // the newest dated titles WITHOUT implying just-uploaded — the
  // evidence note stays honest either way. No quality gate, ever:
  // this shelf is factual.
  const cutoff90 = nowMs - 90 * 24 * 60 * 60 * 1000;
  const recentPoolFor = (cutoff: number | null) =>
    poolItemsFor(
      index,
      selectRecentlyAdded(index, RECENTLY_ADDED_LIMIT * SHELF_POOL_OVERFETCH, cutoff, {
        cacheKey: `${cacheKeyBase}|recent`,
        nowMs,
      }),
    );

  const featuredPool =
    featuredRow != null
      ? [{ id: String(featuredRow.id), row: featuredRow, reason: null as string | null }]
      : [];

  const allocate = (recentPool: Array<{ id: string; row: MovieRow; reason: string | null }>) =>
    allocateShelves([
      { id: "featured", items: featuredPool, limit: 1 },
      { id: "ai", items: aiPool, limit: AI_PICKS_LIMIT },
      { id: "worth", items: worthPool, limit: WORTH_WATCHING_LIMIT },
      { id: "recent", items: recentPool, limit: RECENTLY_ADDED_LIMIT, minFill: 4 },
      { id: "different", items: differentPool, limit: SOMETHING_DIFFERENT_LIMIT },
      { id: "gems", items: gemsPool, limit: HIDDEN_GEMS_LIMIT },
    ]);

  let allocated = allocate(recentPoolFor(cutoff90));
  let recentAllocated = allocated.find((shelf) => shelf.id === "recent")!;
  if (recentAllocated.items.length < 4) {
    allocated = allocate(recentPoolFor(null));
    recentAllocated = allocated.find((shelf) => shelf.id === "recent")!;
  }
  const byId = new Map(allocated.map((shelf) => [shelf.id, shelf.items]));
  const aiItems: HomeShelfItem[] = (byId.get("ai") ?? []).map((item) => ({
    row: item.row,
    reason: item.reason,
  }));
  const worthWatching = (byId.get("worth") ?? []).map((item) => item.row);
  const differentItems: HomeShelfItem[] = (byId.get("different") ?? []).map((item) => ({
    row: item.row,
    reason: item.reason,
  }));
  const gemsItems: HomeShelfItem[] = (byId.get("gems") ?? []).map((item) => ({
    row: item.row,
    reason: item.reason,
  }));
  const recentlyAdded = recentAllocated.items.map((item) => item.row);

  const credibleCount = worthWatching.filter((row) =>
    hasCredibleRating(normaliseRating(row)),
  ).length;
  const worthReasons: Record<string, string> = {};
  for (const result of worthResults) {
    if (result.reasons[0]) worthReasons[result.id] = result.reasons[0];
  }

  const hasVerifiedPicks = aiItems.length > 0;
  return {
    totalCount: index.totalGroups,
    featured,
    continueWatching: {
      items: continueItems.slice(0, CONTINUE_WATCHING_VISIBLE),
      total: continueItems.length,
    },
    aiPicks: {
      items: aiItems,
      source: hasVerifiedPicks ? aiSource : "local",
      label: "AI Picks for You",
      note: hasVerifiedPicks
        ? homeAiSourceNote(aiSource, input.aiModel)
        : "",
    },
    worthWatching: {
      items: worthWatching,
      label: chooseWorthWatchingLabel({
        hasTasteAffinity: tasteHasAffinity(input.taste),
        credibleCount,
        total: worthWatching.length,
      }),
      reasons: worthReasons,
    },
    somethingDifferent: { items: differentItems },
    hiddenGems: { items: gemsItems },
    recentlyAdded: {
      items: recentlyAdded,
      evidence: recentlyAddedEvidence(recentlyAdded, nowMs),
    },
    genres: genreTiles(index),
    aiAction: chooseMoviesHomeAiAction({
      aiConfigured: input.aiConfigured === true,
      hasVerifiedPicks,
    }),
    aiNote: hasVerifiedPicks ? null : (input.aiNote ?? null),
    hasContent: index.totalGroups > 0,
  };
}

/** Browse Everything URLs used by Home entry points (§3.5, §3.7, 0.11.14 §15 View All). */
export const MOVIES_HOME_BROWSE_URLS = {
  everything: browseUrl({}),
  continueWatching: browseUrl({ category: "collection:continue" }),
  aiPicks: browseUrl({ sort: "recommended" }),
  worthWatching: browseUrl({ sort: "rating" }),
  somethingDifferent: browseUrl({ sort: "recommended" }),
  hiddenGems: browseUrl({ sort: "rating" }),
  recentlyAdded: browseUrl({ sort: "added" }),
  search: `${browseUrl({})}&focus=search`,
} as const;
