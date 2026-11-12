// Couch Series — pure data mapping, season/episode selection and
// resume/next-episode logic for the RedSilk Couch Series screens (W4).
//
// Everything here is pure and side-effect free. Episode data comes from
// the provider (`get_series` rows + `get_series_info` payloads via the
// shared cache); watch state comes from the caller-supplied progress
// records. Nothing here invents titles, runtimes or watched state — a
// field the provider did not supply stays empty.

import { normalize } from "@/scripts/lib/text.ts";
import {
  parseYear,
  yearMatches,
  ratingMatches,
  runtimeMatches,
} from "@/scripts/lib/browse-filters.ts";
import { genreForCategoryName, parseGenreString, type GenreId } from "@/scripts/lib/genres.ts";
import { classifyTitle, isDocumentaryKind } from "@/scripts/lib/taxonomy.ts";
import { preferEvidence } from "@/scripts/lib/recommendations.ts";
import { ratingSortValue } from "@/scripts/lib/format.ts";
import { isGenericEpisodeTitle } from "@/scripts/lib/episode-title.ts";
import {
  formatClock,
  formatDurationSeconds,
  RESUME_MIN_SECONDS,
} from "@/scripts/movies/couch-movies.ts";

export { formatClock, formatDurationSeconds, RESUME_MIN_SECONDS };

export interface SeriesRow {
  id: number;
  name: string;
  logo: string | null;
  year: string;
  rating: string;
  category: string;
  plot: string;
  added: number;
  norm: string;
  tmdb: number | null;
  /** Raw provider category id (0.11.8): keeps same-label categories distinct in the index. */
  category_id?: string | null;
  /** Raw 5-based provider rating (0.11.8): lets rating evidence double it instead of misreading it as 10-point. */
  rating_5based?: string | null;
  /** Index signature (0.11.8): mapped rows ARE W1 catalog rows — the
   * index and rating evidence read provider fields dynamically. */
  [key: string]: unknown;
}

export type SeriesSortMode =
  | "default"
  | "added"
  | "rating"
  | "year-desc"
  | "year-asc"
  | "az";

export const SERIES_SORT_MODES: Array<{ value: SeriesSortMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "added", label: "Recently added" },
  { value: "rating", label: "Highest rated" },
  { value: "year-desc", label: "Newest first" },
  { value: "year-asc", label: "Oldest first" },
  { value: "az", label: "A–Z" },
];

export interface EpisodeProgress {
  position?: number;
  duration?: number;
  completed?: boolean;
  updatedAt?: number;
  season?: number | string | null;
  episodeNum?: number | string | null;
  seriesId?: number | string | null;
}

export interface Episode {
  id: number;
  season: number;
  episodeNum: number;
  title: string;
  plot: string;
  durationSeconds: number | null;
  durationLabel: string;
  released: string;
  thumb: string | null;
  containerExt: string | null;
  rating: string;
}

export interface SeasonGroup {
  /** Season numbers present, ascending (0 = Specials, as Kodi reads it). */
  seasons: number[];
  /** Episodes per season, each sorted by episode number. */
  bySeason: Map<number, Episode[]>;
  totalEpisodes: number;
}

/**
 * Map one raw `get_series` row onto a SeriesRow. Mirrors the mapping
 * the legacy listing used. Rows without an id or a name are dropped.
 */
export function mapSeriesRow(
  raw: any,
  categoryMap?: Map<string, string> | null,
): SeriesRow | null {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || raw.title || "");
  const id = Number(raw.series_id || raw.id);
  if (!Number.isFinite(id) || !id || !name) return null;
  const logo = raw.cover || raw.stream_icon || null;
  const year = String(
    raw.year || raw.releaseDate || raw.release_date || "",
  ).trim();
  const rating = raw.rating || raw.rating_5based || "";
  const categoryId =
    (Array.isArray(raw.category_ids) &&
      raw.category_ids.length &&
      raw.category_ids[0]) ||
    raw.category_id;
  let category = String(raw.category_name || "").trim();
  if (!category && categoryId != null && categoryMap?.size) {
    category = categoryMap.get(String(categoryId)) || "";
  }
  const added =
    Number(raw.last_modified) ||
    Number(raw.added) ||
    Number(raw.releaseDate ? Date.parse(raw.releaseDate) / 1000 : 0) ||
    0;
  const tmdb = Number(raw.tmdb) || Number(raw.tmdb_id) || null;
  return {
    id,
    name,
    logo: logo || null,
    year: year || "",
    rating: rating ? String(rating) : "",
    category,
    plot: raw.plot ? String(raw.plot) : "",
    added,
    norm: normalize(`${name} ${category} ${year}`),
    tmdb: Number.isFinite(tmdb) ? tmdb : null,
    category_id: categoryId != null ? String(categoryId) : null,
    rating_5based: raw.rating_5based != null && raw.rating_5based !== "" ? String(raw.rating_5based) : null,
  };
}

/** Canonical genres for a series, derived from its provider category. */
export function seriesGenres(row: SeriesRow): GenreId[] {
  return genreForCategoryName(row.category || null);
}

/** "2024 · 3 seasons · Drama" — only the parts actually known. */
export function seriesMetaLine(row: SeriesRow, seasonCount: number | null): string {
  const parts: string[] = [];
  if (row.year) parts.push(row.year);
  if (seasonCount != null && seasonCount > 0) {
    parts.push(seasonCount === 1 ? "1 season" : `${seasonCount} seasons`);
  }
  if (row.category) parts.push(row.category);
  return parts.join(" · ");
}

export interface SeriesFilter {
  query?: string;
  genre?: GenreId | "";
  category?: string;
  year?: string;
  minRating?: number;
  /** Maximum runtime in minutes (0 = any length). B09 — series rows
   * carry no runtime metadata, so the runtime control is never
   * offered on /series (C5 availability gate); the check stays here
   * so the filter is honoured if rows ever gain a duration. */
  maxRuntime?: number;
  favoriteIds?: Set<number> | null;
  watchlistIds?: Set<number> | null;
  followedIds?: Set<number> | null;
  inProgressIds?: Set<number> | null;
  hideWatched?: boolean;
  fullyWatchedIds?: Set<number> | null;
}

export function filterSeries(rows: SeriesRow[], filter: SeriesFilter): SeriesRow[] {
  const q = normalize(filter.query || "");
  const tokens = q ? q.split(" ").filter(Boolean) : [];
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
    if (genre && !seriesGenres(row).includes(genre)) return false;
    if (!yearMatches(row.year, year)) return false;
    if (!ratingMatches(row.rating, minRating)) return false;
    if (!runtimeMatches(row, maxRuntime)) return false;
    if (filter.favoriteIds && !filter.favoriteIds.has(row.id)) return false;
    if (filter.watchlistIds && !filter.watchlistIds.has(row.id)) return false;
    if (filter.followedIds && !filter.followedIds.has(row.id)) return false;
    if (filter.inProgressIds && !filter.inProgressIds.has(row.id)) return false;
    if (filter.hideWatched && filter.fullyWatchedIds?.has(row.id)) return false;
    return true;
  });
}

export function sortSeries(rows: SeriesRow[], mode: SeriesSortMode): SeriesRow[] {
  const out = [...rows];
  const byName = (a: SeriesRow, b: SeriesRow) =>
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

export function catalogueSeriesGenres(rows: SeriesRow[]): Array<{ id: GenreId; count: number }> {
  const counts = new Map<GenreId, number>();
  for (const row of rows) {
    for (const genre of seriesGenres(row)) {
      counts.set(genre, (counts.get(genre) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Genre collections (B08, 0.10.0) — meaningful rails built from real
// catalogue metadata. Only non-empty collections are returned, so the
// page never exposes an empty or unsupported category. Documentaries
// are a kind of their own: a documentary series appears ONLY in
// "Documentary Series", never in a fictional genre collection, even
// when its provider category also names that genre (C1 rule).
// "Reality" has no canonical genre id (TMDb 10764 is deliberately
// unmapped in genres.ts), so it is matched on the provider category
// text ("Reality", "Reality TV") — never on the title alone.
// ---------------------------------------------------------------------------

export interface GenreCollection<T> {
  /** Stable rail id, e.g. "series-genre-crime-drama". */
  id: string;
  /** Rail title, e.g. "Crime Drama". */
  title: string;
  rows: T[];
}

/** True when the row is a documentary (C1 classifyTitle — the kind
 * decision; genres stay attributes). The adapter knows this is a
 * series row, so the base type is passed explicitly — without it a
 * documentary series whose category carries no series token would
 * misclassify as a documentary film. */
export function isDocumentarySeries(row: SeriesRow): boolean {
  return isDocumentaryKind(classifyTitle({ type: "series", category: row.category }));
}

/** True when the provider category names reality TV. */
export function isRealitySeries(row: SeriesRow): boolean {
  return /reality/i.test(row.category || "");
}

const SERIES_GENRE_COLLECTION_DEFS: Array<{ id: string; title: string; genre: GenreId }> = [
  { id: "series-genre-crime-drama", title: "Crime Drama", genre: "crime" },
  { id: "series-genre-comedy", title: "Comedy", genre: "comedy" },
  { id: "series-genre-sci-fi", title: "Science Fiction", genre: "sci-fi" },
];

export interface SeriesCollectionOptions {
  /** Ids with saved in-progress episode state (Continue Watching). */
  inProgressIds?: Set<number> | null;
}

/**
 * B08 series collections, in display order: Crime Drama, Comedy,
 * Science Fiction, Documentary Series, Reality, Recently Added,
 * Continue Watching. Genre collections are evidence-preferred then
 * highest-rated first (C2 preferEvidence — see movieGenreCollections);
 * Recently Added is newest-first; Continue Watching keeps catalogue
 * order. Empty collections are omitted. Pure — no provider, DOM or
 * storage access.
 */
export function seriesGenreCollections(
  rows: SeriesRow[],
  opts: SeriesCollectionOptions = {},
): GenreCollection<SeriesRow>[] {
  const out: GenreCollection<SeriesRow>[] = [];
  const fictional = (row: SeriesRow) => !isDocumentarySeries(row);
  for (const def of SERIES_GENRE_COLLECTION_DEFS) {
    const members = preferEvidence(
      rows.filter(
        (row) => fictional(row) && seriesGenres(row).includes(def.genre),
      ),
    );
    if (members.length) {
      out.push({ id: def.id, title: def.title, rows: sortSeries(members, "rating") });
    }
  }
  const documentaries = preferEvidence(rows.filter((row) => isDocumentarySeries(row)));
  if (documentaries.length) {
    out.push({
      id: "series-genre-documentary",
      title: "Documentary Series",
      rows: sortSeries(documentaries, "rating"),
    });
  }
  const reality = preferEvidence(rows.filter((row) => fictional(row) && isRealitySeries(row)));
  if (reality.length) {
    out.push({
      id: "series-genre-reality",
      title: "Reality",
      rows: sortSeries(reality, "rating"),
    });
  }
  if (rows.length) {
    out.push({
      id: "series-recent",
      title: "Recently Added",
      rows: sortSeries(rows, "added"),
    });
  }
  if (opts.inProgressIds?.size) {
    const continuing = rows.filter((row) => opts.inProgressIds!.has(row.id));
    if (continuing.length) {
      out.push({
        id: "series-continue",
        title: "Continue Watching",
        rows: continuing,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Episodes — get_series_info payload -> grouped, sorted episodes.
// ---------------------------------------------------------------------------

function episodeNumber(raw: any): number {
  const n = Number(raw?.episode_num ?? raw?.episode ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function seasonNumber(raw: any): number {
  const n = Number(raw?.season ?? 1);
  return Number.isFinite(n) ? n : 1;
}

/** Map one raw episode object from a `get_series_info` payload. */
export function mapEpisode(raw: any): Episode | null {
  if (!raw || typeof raw !== "object") return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id) || !id) return null;
  const info = raw.info && typeof raw.info === "object" ? raw.info : {};
  const durationSecs = Number(info.duration_secs) || null;
  const durationLabel =
    durationSecs != null
      ? formatDurationSeconds(durationSecs)
      : String(info.duration || "").trim();
  return {
    id,
    season: seasonNumber(raw),
    episodeNum: episodeNumber(raw),
    title: String(raw.title || ""),
    plot: String(info.plot || info.description || ""),
    durationSeconds: durationSecs,
    durationLabel,
    released: String(info.release_date || info.releaseDate || ""),
    thumb: info.movie_image || info.cover || null,
    containerExt: raw.container_extension || null,
    rating: info.rating != null ? String(info.rating) : "",
  };
}

/**
 * Group a `get_series_info` payload's episodes by season. Accepts both
 * payload shapes: `episodes` as a season-keyed object, or a flat array.
 * Seasons ascend numerically; episodes ascend by episode number.
 * Returns empty groups (no seasons) when the payload carries no episodes
 * — never invented episodes.
 */
export function groupEpisodesBySeason(info: unknown): SeasonGroup {
  const empty: SeasonGroup = { seasons: [], bySeason: new Map(), totalEpisodes: 0 };
  if (!info || typeof info !== "object") return empty;
  const rawEpisodes = (info as any).episodes;
  if (!rawEpisodes || typeof rawEpisodes !== "object") return empty;
  const bySeason = new Map<number, Episode[]>();
  const collect = (raw: any) => {
    const ep = mapEpisode(raw);
    if (!ep) return;
    const bucket = bySeason.get(ep.season) ?? [];
    bucket.push(ep);
    bySeason.set(ep.season, bucket);
  };
  if (Array.isArray(rawEpisodes)) {
    rawEpisodes.forEach(collect);
  } else {
    for (const season of Object.values(rawEpisodes)) {
      if (Array.isArray(season)) season.forEach(collect);
    }
  }
  for (const eps of bySeason.values()) {
    eps.sort((a, b) => a.episodeNum - b.episodeNum || a.id - b.id);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const eps of bySeason.values()) total += eps.length;
  return { seasons, bySeason, totalEpisodes: total };
}

/** All episodes in watch order (season asc, episode asc). */
export function allEpisodesInOrder(group: SeasonGroup): Episode[] {
  const out: Episode[] = [];
  for (const season of group.seasons) {
    out.push(...(group.bySeason.get(season) ?? []));
  }
  return out;
}

/** Display title: the provider title, or "Episode N" when it is generic filler. */
export function episodeDisplayTitle(ep: Episode, seriesName: string): string {
  if (!isGenericEpisodeTitle(ep.title, { seriesName })) return ep.title;
  return `Episode ${ep.episodeNum || ""}`.trim();
}

/** "S1 E3" marker. */
export function episodeCode(ep: Episode): string {
  return `S${ep.season} E${ep.episodeNum}`;
}

/** "S1 E3 · Title" / "S1 E3 · 42m" — only supplied parts. */
export function episodeMetaLine(ep: Episode, seriesName: string): string {
  const parts = [episodeCode(ep)];
  if (ep.durationLabel) parts.push(ep.durationLabel);
  if (ep.released) parts.push(ep.released.slice(0, 10));
  const title = episodeDisplayTitle(ep, seriesName);
  return `${parts.join(" · ")} — ${title}`;
}

/**
 * Pick the season to show. Preference order: the caller's preferred
 * season when it exists, otherwise the season of the resume/next episode
 * when known, otherwise the first season. Never returns a season with
 * no episodes.
 */
export function selectSeason(
  group: SeasonGroup,
  preferred?: number | null,
  resumeSeason?: number | null,
): number | null {
  if (!group.seasons.length) return null;
  if (preferred != null && group.bySeason.has(preferred)) return preferred;
  if (resumeSeason != null && group.bySeason.has(resumeSeason)) return resumeSeason;
  return group.seasons[0];
}

/** Watched fraction in [0, 1]; 0 when there is no usable progress. */
export function episodeProgressFraction(progress: EpisodeProgress | null | undefined): number {
  if (!progress || !(progress.duration != null && progress.duration > 0)) return 0;
  if (progress.completed) return 1;
  return Math.max(0, Math.min(1, (progress.position || 0) / progress.duration));
}

/** Where episode playback should start (same 30s rule as movies). */
export function episodeResumePosition(progress: EpisodeProgress | null | undefined): number {
  if (!progress || progress.completed) return 0;
  const pos = Number(progress.position) || 0;
  return pos > RESUME_MIN_SECONDS ? pos : 0;
}

export type EpisodeWatchState = "unwatched" | "in-progress" | "watched";

export function episodeWatchState(progress: EpisodeProgress | null | undefined): EpisodeWatchState {
  if (!progress) return "unwatched";
  if (progress.completed) return "watched";
  if ((progress.position || 0) > 0) return "in-progress";
  return "unwatched";
}

/**
 * The episode to resume: the most recently touched in-progress episode
 * (by updatedAt), or null when nothing is in progress. The caller passes
 * progress keyed by episode id.
 */
export function resumeEpisode(
  group: SeasonGroup,
  progressByEpisodeId: Map<number, EpisodeProgress> | Record<number, EpisodeProgress>,
): Episode | null {
  const get = (id: number): EpisodeProgress | undefined =>
    progressByEpisodeId instanceof Map
      ? progressByEpisodeId.get(id)
      : (progressByEpisodeId as Record<number, EpisodeProgress>)[id];
  let best: Episode | null = null;
  let bestAt = -1;
  for (const ep of allEpisodesInOrder(group)) {
    const p = get(ep.id);
    if (!p || p.completed) continue;
    if ((p.position || 0) <= RESUME_MIN_SECONDS) continue;
    const at = p.updatedAt || 0;
    if (at >= bestAt) {
      best = ep;
      bestAt = at;
    }
  }
  return best;
}

/**
 * The next episode to watch: the first episode (in watch order) that is
 * not completed. Returns null when every episode is watched.
 */
export function nextEpisode(
  group: SeasonGroup,
  progressByEpisodeId: Map<number, EpisodeProgress> | Record<number, EpisodeProgress>,
): Episode | null {
  const get = (id: number): EpisodeProgress | undefined =>
    progressByEpisodeId instanceof Map
      ? progressByEpisodeId.get(id)
      : (progressByEpisodeId as Record<number, EpisodeProgress>)[id];
  for (const ep of allEpisodesInOrder(group)) {
    if (!get(ep.id)?.completed) return ep;
  }
  return null;
}

/** The episode after `current` in watch order, or null at the finale. */
export function episodeAfter(group: SeasonGroup, current: Episode): Episode | null {
  const ordered = allEpisodesInOrder(group);
  const idx = ordered.findIndex((ep) => ep.id === current.id);
  if (idx < 0 || idx + 1 >= ordered.length) return null;
  return ordered[idx + 1];
}

/**
 * Resume / Next-Episode button model for a series detail page: resume the
 * in-progress episode when there is one, otherwise offer the next
 * unwatched episode. Returns null when everything is watched.
 */
export function resumeOrNextEpisode(
  group: SeasonGroup,
  progressByEpisodeId: Map<number, EpisodeProgress> | Record<number, EpisodeProgress>,
): { episode: Episode; label: "Resume" | "Next Episode"; resumeSeconds: number } | null {
  const resumed = resumeEpisode(group, progressByEpisodeId);
  if (resumed) {
    const p =
      progressByEpisodeId instanceof Map
        ? progressByEpisodeId.get(resumed.id)
        : (progressByEpisodeId as Record<number, EpisodeProgress>)[resumed.id];
    return { episode: resumed, label: "Resume", resumeSeconds: episodeResumePosition(p) };
  }
  const next = nextEpisode(group, progressByEpisodeId);
  if (!next) return null;
  return { episode: next, label: "Next Episode", resumeSeconds: 0 };
}

/**
 * Autoplay decision at end-of-episode: play the following episode only
 * when autoplay is enabled and there is a next episode. The player
 * itself owns the "enabled" toggle; this keeps the decision testable.
 */
export function shouldAutoplayNext(
  autoplayEnabled: boolean,
  group: SeasonGroup,
  ended: Episode,
): Episode | null {
  if (!autoplayEnabled) return null;
  return episodeAfter(group, ended);
}

// ---------------------------------------------------------------------------
// Detail view model — get_series_info payload -> paintable fields.
// ---------------------------------------------------------------------------

export interface SeriesDetail {
  id: number;
  title: string;
  year: string;
  seasonsCount: number;
  seasonsLabel: string;
  genres: GenreId[];
  genreLabel: string;
  rating: string;
  plot: string;
  cast: string[];
  director: string | null;
  poster: string | null;
  backdrop: string | null;
  trailerYoutubeId: string | null;
}

export function seriesDetailViewModel(rawInfo: unknown, row?: SeriesRow | null): SeriesDetail {
  const data = (rawInfo && typeof rawInfo === "object" ? rawInfo : {}) as any;
  const info = data.info && typeof data.info === "object" ? data.info : {};
  const group = groupEpisodesBySeason(data);
  const seasonsCount = Array.isArray(data.seasons)
    ? data.seasons.length
    : group.seasons.length;
  const title = String(info.name || info.title || row?.name || "");
  const yearRaw = String(info.releaseDate || info.releasedate || info.year || row?.year || "").trim();
  const year = yearRaw.slice(0, 4);
  const genreIds = parseGenreString(info.genre || info.category || "");
  const genres: GenreId[] = genreIds.length ? genreIds : row ? seriesGenres(row) : [];
  const ratingRaw = info.rating ?? info.rating_5based ?? row?.rating ?? "";
  const rating = ratingRaw != null && String(ratingRaw) !== "" ? String(ratingRaw) : "";
  const plot = String(info.plot || info.description || row?.plot || "");
  const cast = String(info.cast || info.actors || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const director = String(info.director || "").split(",")[0]?.trim() || null;
  const poster = info.cover || info.cover_big || info.movie_image || row?.logo || null;
  const backdropPath = info.backdrop_path;
  const backdrop = Array.isArray(backdropPath)
    ? backdropPath[0] || null
    : typeof backdropPath === "string"
      ? backdropPath
      : null;
  return {
    id: Number(data.series_id ?? row?.id ?? 0) || row?.id || 0,
    title,
    year,
    seasonsCount,
    seasonsLabel: seasonsCount === 1 ? "1 season" : `${seasonsCount} seasons`,
    genres,
    genreLabel: genres.join(" · "),
    rating,
    plot,
    cast,
    director,
    poster: poster || null,
    backdrop: backdrop || null,
    trailerYoutubeId: info.youtube_trailer ? String(info.youtube_trailer) : null,
  };
}

/** "2024 · 3 seasons · Drama · ★ 8.4" — only supplied parts. */
export function seriesDetailMetaLine(detail: SeriesDetail): string {
  const parts: string[] = [];
  if (detail.year) parts.push(detail.year);
  if (detail.seasonsCount > 0) parts.push(detail.seasonsLabel);
  if (detail.genreLabel) parts.push(detail.genreLabel);
  if (detail.rating) parts.push(`★ ${detail.rating}`);
  return parts.join(" · ");
}

/**
 * Featured hero pick for the Series home rail: the highest-rated title
 * with artwork among the most recently added half of the catalogue,
 * falling back to the most recently added title with artwork.
 */
export function pickFeaturedSeries(rows: SeriesRow[]): SeriesRow | null {
  const withArt = rows.filter((row) => row.logo);
  if (!withArt.length) return rows[0] ?? null;
  const byAdded = [...withArt].sort((a, b) => (b.added || 0) - (a.added || 0));
  const recentHalf = byAdded.slice(0, Math.max(1, Math.ceil(byAdded.length / 2)));
  // C2 — a no-vote 10.0 with no TMDb link never headlines while any
  // recent linked title qualifies (see pickFeaturedMovie).
  const byRating = [...preferEvidence(recentHalf)].sort(
    (a, b) => ratingSortValue(b.rating) - ratingSortValue(a.rating),
  );
  return byRating[0] ?? byAdded[0] ?? null;
}
