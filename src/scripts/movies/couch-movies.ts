// Couch Movies — pure data mapping, filtering, sorting and resume logic
// for the RedSilk Couch Movies screens (W4).
//
// Everything in this module is pure and side-effect free so it can be
// unit-tested without a provider, a DOM, or storage. All catalogue data
// comes from the provider (Xtream `get_vod_streams` / `get_vod_info` rows
// via the shared cache); nothing here invents ratings, runtimes or
// metadata — a field that the provider did not supply stays empty.

import { normalize } from "@/scripts/lib/text.ts";
import {
  parseYear,
  yearMatches,
  ratingMatches,
  runtimeMatches,
} from "@/scripts/lib/browse-filters.ts";
import {
  genreForCategoryName,
  parseGenreString,
  type GenreId,
} from "@/scripts/lib/genres.ts";
import { classifyTitle, isDocumentaryKind } from "@/scripts/lib/taxonomy.ts";
import { preferEvidence } from "@/scripts/lib/recommendations.ts";
import { ratingSortValue } from "@/scripts/lib/format.ts";

export interface MovieRow {
  id: number;
  name: string;
  logo: string | null;
  year: string;
  rating: string;
  duration: string;
  category: string;
  plot: string;
  added: number;
  norm: string;
  tmdb: number | null;
  containerExt?: string | null;
  /** Raw provider category id (0.11.8): keeps same-label categories distinct in the index. */
  category_id?: string | null;
  /** Raw 5-based provider rating (0.11.8): lets rating evidence double it instead of misreading it as 10-point. */
  rating_5based?: string | null;
  /** Index signature (0.11.8): mapped rows ARE W1 catalog rows — the
   * index and rating evidence read provider fields dynamically. */
  [key: string]: unknown;
}

export type MovieSortMode =
  | "default"
  | "added"
  | "rating"
  | "year-desc"
  | "year-asc"
  | "az";

export const MOVIE_SORT_MODES: Array<{ value: MovieSortMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "added", label: "Recently added" },
  { value: "rating", label: "Highest rated" },
  { value: "year-desc", label: "Newest first" },
  { value: "year-asc", label: "Oldest first" },
  { value: "az", label: "A–Z" },
];

/** Resume only counts once the viewer is 30s in (matches /movies/detail). */
export const RESUME_MIN_SECONDS = 30;

export interface MovieProgress {
  position?: number;
  duration?: number;
  completed?: boolean;
  updatedAt?: number;
}

/**
 * Map one raw `get_vod_streams` row onto a MovieRow. Mirrors the mapping
 * the legacy listing used, so the Couch screens read the same catalogue
 * the rest of the app does. Rows without an id or a name are dropped
 * (return null).
 */
export function mapMovieRow(
  raw: any,
  categoryMap?: Map<string, string> | null,
): MovieRow | null {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || raw.title || "");
  const id = Number(raw.stream_id || raw.id);
  if (!Number.isFinite(id) || !id || !name) return null;
  const logo = raw.stream_icon || raw.cover || null;
  const year = String(raw.year || raw.releaseDate || "").trim() || "";
  const rating = raw.rating || raw.rating_5based || raw.vote_average || "";
  const duration = raw.duration || raw.runtime || raw.duration_secs || "";
  const categoryId =
    (Array.isArray(raw.category_ids) &&
      raw.category_ids.length &&
      raw.category_ids[0]) ||
    raw.category_id;
  let category = String(raw.category_name || "").trim();
  if (!category && categoryId != null && categoryMap?.size) {
    category = categoryMap.get(String(categoryId)) || "";
  }
  const added = Number(raw.added) || 0;
  const tmdb = Number(raw.tmdb) || Number(raw.tmdb_id) || null;
  return {
    id,
    name,
    logo: logo || null,
    year,
    rating: rating ? String(rating) : "",
    duration: duration ? String(duration) : "",
    category,
    plot: raw.plot ? String(raw.plot) : "",
    added,
    norm: normalize(`${name} ${category} ${year}`),
    tmdb: Number.isFinite(tmdb) ? tmdb : null,
    containerExt: raw.container_extension || null,
    category_id: categoryId != null ? String(categoryId) : null,
    rating_5based: raw.rating_5based != null && raw.rating_5based !== "" ? String(raw.rating_5based) : null,
  };
}

/** Canonical genres a movie belongs to, derived from its provider category. */
export function movieGenres(row: MovieRow): GenreId[] {
  return genreForCategoryName(row.category || null);
}

/** "2024 · 2h 5m · Action" — only the parts the provider actually supplied. */
export function movieMetaLine(row: MovieRow): string {
  const parts: string[] = [];
  if (row.year) parts.push(row.year);
  const runtime = formatMovieRuntime(row.duration);
  if (runtime) parts.push(runtime);
  if (row.category) parts.push(row.category);
  return parts.join(" · ");
}

/**
 * Human runtime from a provider duration. Accepts "125 min", "02:05:00",
 * a bare seconds number, or "125". Returns "" when unparseable — never
 * a guessed duration.
 */
export function formatMovieRuntime(value: unknown): string {
  if (value == null || value === "") return "";
  const raw = String(value).trim();
  if (!raw) return "";
  let totalSeconds: number | null = null;
  const hms = raw.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = hms[3] != null ? Number(hms[3]) : 0;
    totalSeconds = h * 3600 + m * 60 + s;
  } else {
    const minMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(?:min|mins|minutes)?$/i);
    if (minMatch) {
      const n = Number(minMatch[1]);
      // A bare number under 1000 is minutes (provider "duration" field);
      // 1000+ is treated as seconds (duration_secs).
      totalSeconds = n >= 1000 ? n : n * 60;
    }
  }
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  return formatDurationSeconds(totalSeconds);
}

/** "2h 5m" / "45m" / "1h 30m" from seconds. */
export function formatDurationSeconds(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** "1:12:34" clock for the player timeline. */
export function formatClock(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Provider `added` timestamp normalised to epoch milliseconds, or null
 * when the value is missing or malformed (0.11.8 Movies Home).
 *
 * Xtream sends `added` as Unix seconds; some providers send
 * milliseconds. Values above 1e12 are read as milliseconds, smaller
 * positive values as seconds. Zero, negative, non-finite and absurd
 * far-future values (more than a day past `nowMs`) are malformed —
 * they must never order a "Recently Added" shelf or support a
 * "just added" claim. Pure.
 */
export function addedTimestampMs(added: unknown, nowMs?: number): number | null {
  const raw = Number(added);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const now = nowMs ?? Date.now();
  const ms = raw > 1e12 ? raw : raw * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // Earlier than 2000-01-01 cannot be a real provider timestamp.
  if (ms < 946684800000) return null;
  if (ms > now + 24 * 60 * 60 * 1000) return null;
  return ms;
}

export interface MovieFilter {
  query?: string;
  /** Canonical genre id, e.g. "action". "" = any. */
  genre?: GenreId | "";
  /** Provider category name. "" = any. */
  category?: string;
  /** Year-decade key from browse-filters ("2020s", "older", …). "" = any. */
  year?: string;
  /** Minimum rating (0 = any). */
  minRating?: number;
  /** Maximum runtime in minutes (0 = any length). B09 — reads the
   * provider duration via runtimeMatches; a title with no parseable
   * runtime cannot be shown to fit a limit. */
  maxRuntime?: number;
  /** Favourite / watchlist id sets, when filtering to a personal list. */
  favoriteIds?: Set<number> | null;
  watchlistIds?: Set<number> | null;
  /** Only titles with saved progress (Continue Watching). */
  inProgressIds?: Set<number> | null;
  /** Hide titles whose progress is completed. */
  hideWatched?: boolean;
  completedIds?: Set<number> | null;
}

function queryTokens(query: string): string[] {
  const q = normalize(query || "");
  return q ? q.split(" ").filter(Boolean) : [];
}

/**
 * Filter + score movie rows. Search tokens must all match (same
 * normalised matching the legacy listing used). Genre matches through
 * the row's provider category; favourites/watchlist/in-progress narrow
 * to the caller's id sets. Returns rows in catalogue order — call
 * sortMovies for display order.
 */
export function filterMovies(rows: MovieRow[], filter: MovieFilter): MovieRow[] {
  const tokens = queryTokens(filter.query || "");
  const genre = filter.genre || "";
  const category = filter.category || "";
  const year = filter.year || "";
  const minRating = filter.minRating || 0;
  const maxRuntime = filter.maxRuntime || 0;
  return rows.filter((row) => {
    if (tokens.length) {
      const hay = row.norm || normalize(`${row.name} ${row.category} ${row.year}`);
      if (!tokens.every((token) => hay.includes(token))) return false;
    }
    if (category && row.category !== category) return false;
    if (genre && !movieGenres(row).includes(genre)) return false;
    if (!yearMatches(row.year, year)) return false;
    if (!ratingMatches(row.rating, minRating)) return false;
    if (!runtimeMatches(row, maxRuntime)) return false;
    if (filter.favoriteIds && !filter.favoriteIds.has(row.id)) return false;
    if (filter.watchlistIds && !filter.watchlistIds.has(row.id)) return false;
    if (filter.inProgressIds && !filter.inProgressIds.has(row.id)) return false;
    if (filter.hideWatched && filter.completedIds?.has(row.id)) return false;
    return true;
  });
}

/** Display sort. "default" keeps catalogue (A–Z) order. */
export function sortMovies(rows: MovieRow[], mode: MovieSortMode): MovieRow[] {
  const out = [...rows];
  const byName = (a: MovieRow, b: MovieRow) =>
    (a.name || "").localeCompare(b.name || "", "en", { sensitivity: "base" });
  switch (mode) {
    case "added":
      out.sort((a, b) => (b.added || 0) - (a.added || 0) || byName(a, b));
      break;
    case "rating":
      out.sort(
        (a, b) => ratingSortValue(b.rating) - ratingSortValue(a.rating) || byName(a, b),
      );
      break;
    case "year-desc":
      out.sort((a, b) => {
        const ay = parseYear(a.year) ?? -1;
        const by = parseYear(b.year) ?? -1;
        return by - ay || byName(a, b);
      });
      break;
    case "year-asc":
      out.sort((a, b) => {
        const ay = parseYear(a.year) ?? Number.POSITIVE_INFINITY;
        const by = parseYear(b.year) ?? Number.POSITIVE_INFINITY;
        return ay - by || byName(a, b);
      });
      break;
    case "az":
      out.sort(byName);
      break;
    case "default":
    default:
      break;
  }
  return out;
}

/** Genres present in the catalogue, most frequent first (for filter chips). */
export function catalogueGenres(rows: MovieRow[]): Array<{ id: GenreId; count: number }> {
  const counts = new Map<GenreId, number>();
  for (const row of rows) {
    for (const genre of movieGenres(row)) {
      counts.set(genre, (counts.get(genre) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/** Provider categories present in the catalogue, most frequent first. */
export function catalogueCategories(rows: MovieRow[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.category) continue;
    counts.set(row.category, (counts.get(row.category) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Display label for a canonical genre id ("sci-fi" -> "Sci-Fi"). */
export function genreDisplayLabel(id: GenreId): string {
  if (id === "sci-fi") return "Sci-Fi";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// ---------------------------------------------------------------------------
// Genre collections (B08, 0.10.0) — meaningful rails built from real
// catalogue metadata. Only non-empty collections are returned, so the
// page never exposes an empty or unsupported category. Documentaries
// are a kind of their own: a documentary film appears ONLY in
// "Documentary Films", never in a fictional genre collection, even
// when its provider category also names that genre (C1 rule —
// genres are attributes, the documentary kind is not).
// ---------------------------------------------------------------------------

export interface GenreCollection<T> {
  /** Stable rail id, e.g. "movies-genre-action". */
  id: string;
  /** Rail title, e.g. "Action". */
  title: string;
  rows: T[];
}

/** True when the row is a documentary (C1 classifyTitle — the kind
 * decision; genres stay attributes, so a crime documentary is a
 * documentary, not a crime drama). The adapter knows this is a
 * movie row, so the base type is passed explicitly — a bare row
 * carries no type field for the film/series split. */
export function isDocumentaryMovie(row: MovieRow): boolean {
  return isDocumentaryKind(classifyTitle({ type: "movie", category: row.category }));
}

const MOVIE_GENRE_COLLECTION_DEFS: Array<{ id: string; title: string; genre: GenreId }> = [
  { id: "movies-genre-action", title: "Action", genre: "action" },
  { id: "movies-genre-thriller", title: "Thriller", genre: "thriller" },
  { id: "movies-genre-comedy", title: "Comedy", genre: "comedy" },
  { id: "movies-genre-horror", title: "Horror", genre: "horror" },
  { id: "movies-genre-sci-fi", title: "Science Fiction", genre: "sci-fi" },
  { id: "movies-genre-drama", title: "Drama", genre: "drama" },
];

/**
 * B08 movie collections, in display order: Action, Thriller, Comedy,
 * Horror, Science Fiction, Drama, Documentary Films, Recently Added.
 * Genre collections are evidence-preferred then highest-rated first
 * (C2 preferEvidence — a no-vote 10.0 with no TMDb link can never
 * top a collection while any linked title qualifies; when nothing is
 * linked the full pool is used, so a small library never empties);
 * Recently Added is newest-first. Empty collections are omitted.
 * Pure — no provider, DOM or storage access.
 */
export function movieGenreCollections(rows: MovieRow[]): GenreCollection<MovieRow>[] {
  const out: GenreCollection<MovieRow>[] = [];
  for (const def of MOVIE_GENRE_COLLECTION_DEFS) {
    const members = preferEvidence(
      rows.filter(
        (row) => !isDocumentaryMovie(row) && movieGenres(row).includes(def.genre),
      ),
    );
    if (members.length) {
      out.push({ id: def.id, title: def.title, rows: sortMovies(members, "rating") });
    }
  }
  const documentaries = preferEvidence(rows.filter((row) => isDocumentaryMovie(row)));
  if (documentaries.length) {
    out.push({
      id: "movies-genre-documentary",
      title: "Documentary Films",
      rows: sortMovies(documentaries, "rating"),
    });
  }
  if (rows.length) {
    out.push({
      id: "movies-recent",
      title: "Recently Added",
      rows: sortMovies(rows, "added"),
    });
  }
  return out;
}

/** Watched fraction in [0, 1]; 0 when there is no usable progress. */
export function movieProgressFraction(progress: MovieProgress | null | undefined): number {
  if (!progress || !(progress.duration != null && progress.duration > 0)) return 0;
  if (progress.completed) return 1;
  return Math.max(0, Math.min(1, (progress.position || 0) / progress.duration));
}

/**
 * Where playback should start: the saved position when the viewer is
 * meaningfully into the film and has not finished it, otherwise 0.
 */
export function resumePosition(progress: MovieProgress | null | undefined): number {
  if (!progress || progress.completed) return 0;
  const pos = Number(progress.position) || 0;
  return pos > RESUME_MIN_SECONDS ? pos : 0;
}

/** "Resume · 42:10 left" / "Play" label for the detail Play button. */
export function playButtonLabel(progress: MovieProgress | null | undefined): {
  label: string;
  sub: string;
} {
  const pos = resumePosition(progress);
  if (pos <= 0) return { label: "Play", sub: "" };
  const duration = Number(progress?.duration) || 0;
  const remaining = duration > pos ? duration - pos : 0;
  return {
    label: "Resume",
    sub: remaining > 0 ? `${formatClock(remaining)} left` : `Resume at ${formatClock(pos)}`,
  };
}

// ---------------------------------------------------------------------------
// Detail view model — get_vod_info payload -> paintable fields.
// ---------------------------------------------------------------------------

export interface MovieDetail {
  id: number;
  title: string;
  year: string;
  runtimeSeconds: number | null;
  runtimeLabel: string;
  genres: GenreId[];
  genreLabel: string;
  rating: string;
  ratingLabel: string;
  plot: string;
  cast: string[];
  director: string | null;
  poster: string | null;
  backdrop: string | null;
  trailerYoutubeId: string | null;
  containerExt: string | null;
  /** Provider backdrop (movie_data.backdrop_path) when present. */
  providerBackdrop: string | null;
}

function pickInfo(raw: any): any {
  if (!raw || typeof raw !== "object") return {};
  return raw.info || raw.movie_data || raw || {};
}

/**
 * Build the detail view model from a `get_vod_info` payload plus the
 * catalogue row. Every field falls back to empty — a missing rating is
 * shown as nothing, never an invented number.
 */
export function movieDetailViewModel(rawInfo: unknown, row?: MovieRow | null): MovieDetail {
  const info = pickInfo(rawInfo);
  const id = Number((rawInfo as any)?.movie_data?.stream_id ?? row?.id ?? 0) || row?.id || 0;
  const title = String(info.name || info.title || row?.name || "");
  const year = String(info.releasedate || info.release_date || info.year || row?.year || "").trim().slice(0, 4);
  const durationSecs = Number(info.duration_secs) || null;
  const runtimeLabel = durationSecs
    ? formatDurationSeconds(durationSecs)
    : formatMovieRuntime(row?.duration || info.duration || "");
  const genreIds = parseGenreString(info.genre || info.genres || "");
  const genres = genreIds.length ? genreIds : row ? movieGenres(row) : [];
  const ratingRaw = info.rating ?? info.rating_5based ?? row?.rating ?? "";
  const rating = ratingRaw != null && String(ratingRaw) !== "" ? String(ratingRaw) : "";
  const plot = String(info.plot || info.description || row?.plot || "");
  const cast = String(info.cast || info.actors || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const director = String(info.director || "").split(",")[0]?.trim() || null;
  const poster = info.cover_big || info.movie_image || info.cover || row?.logo || null;
  const backdrop = info.backdrop_path?.[0] || info.backdrop || null;
  const trailer = info.youtube_trailer || info.trailer || null;
  return {
    id,
    title,
    year,
    runtimeSeconds: durationSecs,
    runtimeLabel,
    genres,
    genreLabel: genres.join(" · "),
    rating,
    ratingLabel: rating,
    plot,
    cast,
    director,
    poster: poster || null,
    backdrop: backdrop || null,
    trailerYoutubeId: trailer ? String(trailer) : null,
    containerExt: (row?.containerExt ?? info.container_extension ?? null) as string | null,
    providerBackdrop: Array.isArray(info.backdrop_path) && info.backdrop_path[0]
      ? String(info.backdrop_path[0])
      : null,
  };
}

/** "2024 · 2h 5m · Action · ★ 8.4" — only supplied parts, in that order. */
export function movieDetailMetaLine(detail: MovieDetail): string {
  const parts: string[] = [];
  if (detail.year) parts.push(detail.year);
  if (detail.runtimeLabel) parts.push(detail.runtimeLabel);
  if (detail.genreLabel) parts.push(detail.genreLabel);
  if (detail.ratingLabel) parts.push(`★ ${detail.ratingLabel}`);
  return parts.join(" · ");
}

/**
 * Featured hero pick for the Movies home rail: the highest-rated title
 * with artwork among the most recently added half of the catalogue,
 * falling back to the most recently added title with artwork. Pure and
 * deterministic — no randomness, no invented feature.
 */
export function pickFeaturedMovie(rows: MovieRow[]): MovieRow | null {
  const withArt = rows.filter((row) => row.logo);
  if (!withArt.length) return rows[0] ?? null;
  const byAdded = [...withArt].sort((a, b) => (b.added || 0) - (a.added || 0));
  const recentHalf = byAdded.slice(0, Math.max(1, Math.ceil(byAdded.length / 2)));
  // C2 — a no-vote 10.0 with no TMDb link never headlines while any
  // recent linked title qualifies (preferEvidence falls back to the
  // full half when nothing is linked).
  const byRating = [...preferEvidence(recentHalf)].sort(
    (a, b) => ratingSortValue(b.rating) - ratingSortValue(a.rating),
  );
  return byRating[0] ?? byAdded[0] ?? null;
}
