// 0.11.8 SHIM — W1 contract, deleted at integration.
//
// TEMPORARY implementations of the W1 data-architecture APIs that
// Movies Home consumes, so this branch builds, runs and verifies
// while W1 builds the real modules in parallel. Every export here
// implements the REAL contract semantics (deterministic, evidence
// honest, no invented metadata) at minimal scope; integration
// deletes this file and rewires the imports in
// src/scripts/movies/movies-home.ts to the real modules:
//
//   getCatalogIndex      -> src/scripts/lib/catalog-index.ts (W1)
//   selectFeaturedFilm   -> src/scripts/lib/collection-selectors.ts (W1)
//   selectWorthWatching  -> src/scripts/lib/collection-selectors.ts (W1)
//   selectRecentlyAdded  -> src/scripts/lib/collection-selectors.ts (W1)
//   CANONICAL_MOVIE_GENRES -> src/scripts/lib/genres.ts (W1; shim shape
//     is a GenreId[] in display order — if the real export is richer,
//     adapt the single use site in movies-home.ts)
//   normaliseRating      -> src/scripts/lib/rating-evidence.ts (W1)
//
// Do NOT extend this file: missing behaviour belongs in the real W1
// modules, and anything added here is deleted at integration.

import {
  addedTimestampMs,
  movieGenres,
  type MovieRow,
} from "@/scripts/movies/couch-movies.ts";
import type { GenreId } from "@/scripts/lib/genres.ts";
import { normalize } from "@/scripts/lib/text.ts";
import {
  CONFIDENCE_MIN_HIGH_VOTES,
  CONFIDENCE_MIN_MEDIUM_VOTES,
} from "@/scripts/lib/rating-confidence.ts";
import type { TasteModel } from "@/scripts/lib/taste.ts";

// ---------------------------------------------------------------------------
// Catalog index (W1: catalog-index.ts)
// ---------------------------------------------------------------------------

export interface CatalogIndex {
  /** Deduped rows, in catalogue order. */
  rows: MovieRow[];
  /** Distinct titles after id dedupe. */
  total: number;
  /** Distinct normalised title+year groups (safe-duplicate view). */
  distinctTitles: number;
  byId: Map<number, MovieRow>;
  playlistId: string;
}

function titleGroupKey(row: MovieRow): string {
  return `${normalize(row.name || "")}|${String(row.year || "").slice(0, 4)}`;
}

/**
 * Minimal catalog index: dedupes by provider id (first row wins) and
 * drops rows without an id or a name. The real W1 index adds
 * language grouping, safe duplicate grouping and the genre index;
 * this shim only guarantees the dedupe + lookup shape Movies Home
 * depends on. Pure.
 */
export function getCatalogIndex(rows: MovieRow[], playlistId = ""): CatalogIndex {
  const byId = new Map<number, MovieRow>();
  for (const row of rows || []) {
    if (!row || !Number.isFinite(row.id) || !row.id || !row.name) continue;
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const deduped = [...byId.values()];
  const groups = new Set(deduped.map(titleGroupKey));
  return {
    rows: deduped,
    total: deduped.length,
    distinctTitles: groups.size,
    byId,
    playlistId,
  };
}

// ---------------------------------------------------------------------------
// Canonical movie genres (W1: genres.ts)
// ---------------------------------------------------------------------------

/**
 * Canonical movie genres in display order. The first six are the
 * prominent Explore-tiles genres from the 0.11.8 brief (§3.6):
 * Action, Comedy, Horror, Thriller, Science Fiction, Drama.
 * Labels live in movies-home.ts (movieGenreLabel) so this list stays
 * a plain id ordering.
 */
export const CANONICAL_MOVIE_GENRES: readonly GenreId[] = [
  "action",
  "comedy",
  "horror",
  "thriller",
  "sci-fi",
  "drama",
  "adventure",
  "animation",
  "crime",
  "documentary",
  "family",
  "fantasy",
  "history",
  "music",
  "mystery",
  "romance",
  "war",
  "western",
] as const;

// ---------------------------------------------------------------------------
// Rating evidence (W1: rating-evidence.ts)
// ---------------------------------------------------------------------------

export type RatingCredibility = "high" | "medium" | "low" | "none";

export interface NormalisedRating {
  /** 0–10 value, or null when the provider supplied no usable rating. */
  value: number | null;
  /** Display label ("★ 8.4") — empty when there is no usable rating. */
  label: string;
  /**
   * True only when the rating carries real evidence: known votes at
   * medium/high confidence, or a TMDb-matched title whose provider
   * rating is TMDb's vote_average (the documented Tier 2 fallback
   * from rating-confidence.ts). A bare provider 10/10 with no link
   * and no votes is NEVER credible.
   */
  credible: boolean;
  tier: RatingCredibility;
}

/**
 * Normalise one provider rating to the 0–10 scale with a credibility
 * tier. Never invents votes: a missing vote count is zero evidence.
 * The 5-based provider field is NOT rescaled here — mapMovieRow
 * already folds rating_5based into the same field and the rest of
 * the app reads it on the 0–10 scale; W1's real module owns any
 * scale disambiguation. Pure.
 */
export function normaliseRating(
  raw: unknown,
  opts: { tmdb?: number | null; votes?: number | null } = {},
): NormalisedRating {
  const value = parseFloat(String(raw ?? "").trim());
  if (raw == null || raw === "" || !Number.isFinite(value) || value <= 0) {
    return { value: null, label: "", credible: false, tier: "none" };
  }
  const clamped = Math.min(10, value);
  const votes = opts.votes;
  let tier: RatingCredibility;
  if (typeof votes === "number" && Number.isFinite(votes) && votes > 0) {
    tier =
      votes >= CONFIDENCE_MIN_HIGH_VOTES
        ? "high"
        : votes >= CONFIDENCE_MIN_MEDIUM_VOTES
          ? "medium"
          : "low";
  } else if (opts.tmdb != null && Number(opts.tmdb) > 0) {
    // Tier 2: TMDb-matched, provider rating is TMDb's vote_average.
    tier = "medium";
  } else {
    tier = "low";
  }
  return {
    value: clamped,
    label: `★ ${clamped.toFixed(1)}`,
    credible: tier === "high" || tier === "medium",
    tier,
  };
}

// ---------------------------------------------------------------------------
// Shared selector helpers
// ---------------------------------------------------------------------------

/** Deterministic FNV-1a hash with a murmur-style finalizer — stable
 * ordering jitter, never random. The finalizer avalanches small
 * input differences (a raw FNV over "id:seed" leaves same-id seeds
 * within 0.01 of each other, so rotation would never reorder). */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0xffffffff;
}

/** Candidate keys the household marked "Not interested" (hard exclusions). */
function excludedByTaste(taste: TasteModel | null | undefined): Set<string> {
  return new Set(taste?.notInterestedKeys ?? []);
}

function isExcluded(
  row: MovieRow,
  taste: TasteModel | null | undefined,
  excludeIds?: ReadonlySet<number>,
): boolean {
  if (excludeIds?.has(row.id)) return true;
  return excludedByTaste(taste).has(`movie:${row.id}`);
}

/** Genre-affinity weight for one row from liked-title affinities only. */
function tasteAffinity(row: MovieRow, taste: TasteModel | null | undefined): number {
  if (!taste) return 0;
  const weights = taste.genreWeights ?? {};
  let best = 0;
  for (const genre of movieGenres(row)) {
    const candidates: string[] = [genre];
    // Taste weights are keyed by the genre strings the Discover
    // engine saw ("science fiction"), not the canonical id.
    if (genre === "sci-fi") candidates.push("science fiction", "sci fi", "scifi");
    for (const key of candidates) {
      const w = weights[key];
      if (typeof w === "number" && Number.isFinite(w)) best = Math.max(best, w);
    }
  }
  return best;
}

/**
 * Evidence-first quality score. A rating contributes ONLY when
 * credible, so a bare 10/10 with no evidence can never outrank a
 * supported title on rating alone. Taste affinity is capped so one
 * strong affinity cannot bury every other signal. Deterministic:
 * the same rows + taste + seed always score the same way.
 */
function qualityScore(
  row: MovieRow,
  taste: TasteModel | null | undefined,
  nowMs: number,
): number {
  const rating = normaliseRating(row.rating, { tmdb: row.tmdb });
  let score = 0;
  if (rating.credible) score += 3;
  if (row.tmdb != null && Number(row.tmdb) > 0) score += 1;
  score += Math.min(3, Math.max(0, tasteAffinity(row, taste)));
  if (rating.credible && rating.value != null) {
    score += (rating.value - 6.5) * 0.4;
  }
  const added = addedTimestampMs(row.added, nowMs);
  if (added != null && nowMs - added <= 90 * 24 * 60 * 60 * 1000) score += 0.5;
  return score;
}

function byScoreThenStable(
  a: { row: MovieRow; score: number },
  b: { row: MovieRow; score: number },
  nowMs: number,
): number {
  if (b.score !== a.score) return b.score - a.score;
  const addedA = addedTimestampMs(a.row.added, nowMs) ?? 0;
  const addedB = addedTimestampMs(b.row.added, nowMs) ?? 0;
  if (addedB !== addedA) return addedB - addedA;
  const name = (a.row.name || "").localeCompare(b.row.name || "", "en", {
    sensitivity: "base",
  });
  if (name !== 0) return name;
  return a.row.id - b.row.id;
}

/** Dedupe by id, then by normalised title+year (keep the first/best). */
function dedupeTitleGroups(rows: MovieRow[]): MovieRow[] {
  const seenIds = new Set<number>();
  const seenGroups = new Set<string>();
  const out: MovieRow[] = [];
  for (const row of rows) {
    if (seenIds.has(row.id)) continue;
    const group = titleGroupKey(row);
    if (seenGroups.has(group)) continue;
    seenIds.add(row.id);
    seenGroups.add(group);
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Featured film (W1: collection-selectors.ts)
// ---------------------------------------------------------------------------

export interface SelectFeaturedOptions {
  /** Rotation seed — persisted by the caller, changed only by an
   * explicit Refresh Picks action. Default 0. The pick is STABLE
   * across page opens for a fixed seed. */
  rotationSeed?: number;
  /** Ids to exclude (e.g. completed titles — the caller owns progress). */
  excludeIds?: ReadonlySet<number>;
  nowMs?: number;
}

/**
 * The featured film: the strongest evidence-backed title with
 * artwork, chosen from the top-ranked candidates. NEVER
 * first-with-poster (position plays no part), NEVER newest-upload
 * (recency is a small tiebreak nudge only), NEVER a bare provider
 * 10/10 (uncredible ratings contribute nothing to the score).
 * Deterministic for a fixed seed; the seed rotates within the top 5
 * so Refresh Picks changes the pick without ever surfacing a weak
 * title. Pure — no network, no paid model calls.
 */
export function selectFeaturedFilm(
  index: CatalogIndex,
  taste: TasteModel | null | undefined,
  opts: SelectFeaturedOptions = {},
): MovieRow | null {
  const nowMs = opts.nowMs ?? Date.now();
  const seed = Math.max(0, Math.floor(opts.rotationSeed ?? 0));
  const pool = index.rows.filter(
    (row) => row.logo && !isExcluded(row, taste, opts.excludeIds),
  );
  if (!pool.length) {
    // No artwork anywhere: fall back to the strongest title without
    // the artwork requirement (the compact fallback renders it).
    const any = index.rows.filter((row) => !isExcluded(row, taste, opts.excludeIds));
    if (!any.length) return null;
    const ranked = any
      .map((row) => ({ row, score: qualityScore(row, taste, nowMs) }))
      .sort((a, b) => byScoreThenStable(a, b, nowMs));
    return ranked[seed % Math.min(5, ranked.length)].row;
  }
  const ranked = pool
    .map((row) => ({ row, score: qualityScore(row, taste, nowMs) }))
    .sort((a, b) => byScoreThenStable(a, b, nowMs));
  const window = ranked.slice(0, Math.min(5, ranked.length));
  return window[seed % window.length].row;
}

// ---------------------------------------------------------------------------
// Worth Watching (W1: collection-selectors.ts)
// ---------------------------------------------------------------------------

export interface SelectWorthWatchingOptions {
  limit?: number;
  excludeIds?: ReadonlySet<number>;
  /** Completed titles — excluded (unwatched/discovery bias). */
  completedIds?: ReadonlySet<number>;
  rotationSeed?: number;
  /**
   * Cached VERIFIED AI Discovery recommendations that may influence
   * the ranking — explicit optional input only. Movies Home passes
   * nothing here (no verified cache is plumbed and the privacy
   * conditions are unverified), so the shelf is local-only unless
   * integration wires a real verified source. A listed title gets a
   * small score boost; listing never invents a title (unknown ids
   * are ignored) and never bypasses exclusions.
   */
  verifiedAiTitles?: ReadonlyArray<{ id: number }>;
  nowMs?: number;
}

/**
 * The strongest recommendation shelf: quality evidence + taste
 * affinity + unwatched bias + genre diversity + exposure rotation.
 * NOT the rating-8+ shortcut — uncredible ratings contribute
 * nothing, completed titles are excluded, and at most two titles
 * per primary genre fill the first pass (the second pass backfills
 * in score order so a small library never starves). Deterministic
 * for a fixed seed. Pure — no network, no paid model calls.
 */
export function selectWorthWatching(
  index: CatalogIndex,
  taste: TasteModel | null | undefined,
  opts: SelectWorthWatchingOptions = {},
): MovieRow[] {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = Math.max(0, Math.floor(opts.limit ?? 12));
  if (limit === 0) return [];
  const seed = Math.max(0, Math.floor(opts.rotationSeed ?? 0));
  const aiBoost = new Set((opts.verifiedAiTitles ?? []).map((entry) => entry.id));
  const excluded = new Set<number>([...(opts.excludeIds ?? []), ...(opts.completedIds ?? [])]);
  const pool = index.rows.filter((row) => !isExcluded(row, taste, excluded));
  const scored = pool
    .map((row) => {
      let score = qualityScore(row, taste, nowMs);
      if (aiBoost.has(row.id)) score += 0.75;
      // Deterministic rotation jitter: small enough never to bury
      // evidence, large enough that a new seed reorders neighbours.
      score += stableHash(`${row.id}:${seed}`) * 0.3;
      return { row, score };
    })
    .sort((a, b) => byScoreThenStable(a, b, nowMs));
  const deduped = dedupeTitleGroups(scored.map((entry) => entry.row));

  // First pass: at most two per primary genre (diversity).
  const picked: MovieRow[] = [];
  const genreCounts = new Map<string, number>();
  for (const row of deduped) {
    if (picked.length >= limit) break;
    const primary = movieGenres(row)[0] ?? "other";
    const count = genreCounts.get(primary) ?? 0;
    if (count < 2) {
      picked.push(row);
      genreCounts.set(primary, count + 1);
    }
  }
  // Second pass: backfill in score order (deduped order is score
  // order) so a small or single-genre library never starves.
  const pickedIds = new Set(picked.map((row) => row.id));
  for (const row of deduped) {
    if (picked.length >= limit) break;
    if (!pickedIds.has(row.id)) {
      picked.push(row);
      pickedIds.add(row.id);
    }
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Recently Added (W1: collection-selectors.ts)
// ---------------------------------------------------------------------------

export interface SelectRecentlyAddedOptions {
  limit?: number;
  excludeIds?: ReadonlySet<number>;
  nowMs?: number;
}

/** Recent cutoff for the "meaningfully recent" window (90 days). */
export const RECENTLY_ADDED_CUTOFF_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Recently added to the LIBRARY (provider ADDED timestamps — never
 * cinema release dates). Malformed timestamps are excluded from the
 * dated selection; when no row carries a usable date, catalogue
 * order is the honest fallback (the caller labels it without
 * implying just-uploaded-today). Deduped by id and title group.
 * Pure.
 */
export function selectRecentlyAdded(
  index: CatalogIndex,
  opts: SelectRecentlyAddedOptions = {},
): MovieRow[] {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = Math.max(0, Math.floor(opts.limit ?? 12));
  if (limit === 0) return [];
  const pool = index.rows.filter((row) => !opts.excludeIds?.has(row.id));
  const dated = pool
    .map((row) => ({ row, added: addedTimestampMs(row.added, nowMs) }))
    .filter((entry): entry is { row: MovieRow; added: number } => entry.added != null)
    .sort((a, b) => b.added - a.added);
  if (dated.length > 0) {
    // Prefer the recent window, but never starve the shelf when the
    // library itself is stale: fewer than 4 recent titles extends to
    // the newest dated titles available.
    const recent = dated.filter((entry) => nowMs - entry.added <= RECENTLY_ADDED_CUTOFF_MS);
    const chosen = recent.length >= 4 ? recent : dated;
    return dedupeTitleGroups(chosen.map((entry) => entry.row)).slice(0, limit);
  }
  return dedupeTitleGroups(pool).slice(0, limit);
}
