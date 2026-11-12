// 0.11.8 fixtures — deterministic, seeded catalogue generators shared by
// ALL forty acceptance tests and the benchmark harness (brief §20).
//
// Every catalogue is generated from REAL provider row shapes (Xtream
// get_vod_streams / get_series) and mapped through the REAL
// mapMovieRow / mapSeriesRow, so the rows under test carry exactly
// the quirks the real catalogue does: missing posters, unrated
// titles, sparse years, malformed names, language/quality variants,
// and provider categories — including duplicate display labels and
// one enormous category. Titles are INVENTED (combinatorial word
// lists), never real film/series titles.
//
// Each entry is a REAL W1 CatalogRow (the mapped row's fields, plus
// the enrichments the index reads: tmdbGenreIds, genre, category_id,
// rating_5based, seasonCount, episodeCount, episodes) with
// test-only ground-truth fields alongside (yearNum, ratingRaw,
// categoryName, poster, language, quality, baseTitle). Tests build
// REAL CatalogIndexes from these rows; no stub stands between the
// fixture and the module under test.
//
// Determinism: one mulberry32 stream per catalogue, seeded. The same
// seed + counts produce a byte-identical catalogue (proven by
// tests/fixtures-0118-determinism.test.ts via hashCatalogue).
// Generation is a single pass with precomputed word lists — the 50k
// catalogue generates in well under a second.

import { createHash } from "node:crypto"
import { mapMovieRow } from "@/scripts/movies/couch-movies.ts"
import { mapSeriesRow } from "@/scripts/series/couch-series.ts"
import { parseYear } from "@/scripts/lib/browse-filters.ts"
import type { CatalogRow } from "@/scripts/lib/catalog-index.ts"
import { normalize } from "@/scripts/lib/text.ts"

// ---------------------------------------------------------------------------
// Fixture entry shape: a real W1 CatalogRow + ground-truth extras
// ---------------------------------------------------------------------------

export interface EpisodeRef {
  id: number
  season: number
  episode: number
  title: string
}

export interface EntryProgress {
  position: number
  duration: number
  completed: boolean
  updatedAt: number
}

export type ProgressMap =
  | Map<number, EntryProgress>
  | Record<number, EntryProgress>

export function progressOf(
  progress: ProgressMap | null | undefined,
  id: number
): EntryProgress | undefined {
  if (!progress) return undefined
  if (progress instanceof Map) return progress.get(id)
  return (progress as Record<number, EntryProgress>)[id]
}

/**
 * Variant-suffix vocabulary for the fixture's informational baseTitle
 * (ported from the W5 stub contract — test ground truth, not
 * production code). Mirrors the D4 strip list in language-groups.ts:
 * quality/language/edition tokens that differ between variants of
 * one title. A group's members must share one baseTitle.
 */
const VARIANT_TOKENS = new Set([
  "2160p", "1080p", "720p", "480p", "360p",
  "4k", "uhd", "fhd", "hd", "sd",
  "web-dl", "webdl", "webrip", "web-rip", "bluray", "brrip",
  "hdr", "hevc", "x265", "x264", "h265", "h264", "10bit",
  "hindi", "tamil", "telugu", "malayalam", "kannada", "punjabi",
  "bengali", "marathi", "english", "spanish", "french", "german",
  "dual", "audio", "multi", "dubbed", "subbed", "subs", "esub",
  "uncut", "extended", "remux", "proper", "repack",
])
const BRACKETED_VARIANT = /[[(][^\])]*[\])]\s*$/

function stripVariantSuffix(name: string): string {
  let title = String(name || "").trim().replace(/\s+/g, " ")
  for (;;) {
    const before = title
    const bracket = title.match(BRACKETED_VARIANT)
    if (bracket) {
      const inner = bracket[0].replace(/^[[(]|[\])]$/g, " ").trim()
      const words = inner.split(/[^a-z0-9]+/i).filter(Boolean)
      if (
        words.length > 0 &&
        words.every((w) => VARIANT_TOKENS.has(w.toLowerCase()))
      ) {
        title = title.slice(0, title.length - bracket[0].length).trim()
        continue
      }
    }
    // The token may be hyphenated ("WEB-DL" is one variant token,
    // not "DL") — without the compound match, "Title WEB-DL" would
    // keep a "web dl" tail and disagree with W1's grouping key.
    const tokenMatch = title.match(/[-–—:]?\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\s*$/)
    if (tokenMatch) {
      const token = tokenMatch[1].toLowerCase()
      if (VARIANT_TOKENS.has(token)) {
        title = title.slice(0, tokenMatch.index).trim()
        continue
      }
    }
    if (title === before) break
  }
  return title.replace(/[-–—:,\s]+$/, "").trim()
}

/**
 * Normalised base title for grouping display in tests: variant
 * suffixes stripped, then normalised. Informational only — the
 * authoritative grouping is W1's TitleGroup (language-groups.ts),
 * which applies its own variant-suffix stripping; the two must agree
 * (acceptance test 9 pins it).
 */
export function baseTitleOf(name: string): string {
  return normalize(stripVariantSuffix(name))
}

/**
 * One catalogue entry: the mapped provider row (a real CatalogRow —
 * id, name, year, rating, duration, category, category_id, logo,
 * tmdb, added, seasonCount) plus the enrichments the index reads
 * (tmdbGenreIds, genre, rating_5based, episodeCount, episodes) and
 * test-only ground truth (yearNum, ratingRaw, ratingScale,
 * durationRaw, categoryName, poster, language, quality, baseTitle).
 * Unknown metadata stays unknown: "" / null / 0, never fabricated.
 */
export interface CatalogEntry extends CatalogRow {
  id: number
  kind: "vod" | "series"
  name: string
  /** Mapped-row fields: a CatalogEntry is assignable to MovieRow /
   *  SeriesRow as well as CatalogRow, so the same fixture rows drive
   *  the index, the selectors, and the Home models with no casts.
   *  Series rows carry duration "" (real SeriesRows have no
   *  duration; W1 runtime is vod-only, so "" is inert). */
  logo: string | null
  rating: string
  duration: string
  category: string
  plot: string
  norm: string
  tmdb: number | null
  category_id: string | null
  rating_5based: string | null
  /** Display title: the provider name as shown (trimmed, single-spaced). */
  displayTitle: string
  /** Normalised base title (see baseTitleOf). Informational. */
  baseTitle: string
  year: string
  yearNum: number | null
  /** Provider rating string verbatim ("" = unknown). */
  ratingRaw: string
  /** Scale the provider rating was supplied on. */
  ratingScale: 10 | 5
  /** Provider duration string verbatim ("" = unknown). */
  durationRaw: string
  categoryId: string | null
  /** Provider category string verbatim ("" = uncategorised). */
  categoryName: string
  tmdbGenreIds: number[]
  /** Raw genre string when the provider supplies one ("" = none). */
  genreString: string
  /** Provider `added` timestamp, unix seconds. 0 = unknown. */
  added: number
  poster: string | null
  /** Confirmed season count, or null when unknown. Movies: always null. */
  seasonCount: number | null
  /** Confirmed episode count, or null when unknown. */
  episodeCount: number | null
  /** Confirmed episodes (series only). [] when unknown. */
  episodes: EpisodeRef[]
  /** Variant signals when the provider/name carries them. */
  language: string | null
  quality: string | null
}

// ---------------------------------------------------------------------------
// Deterministic PRNG + hashing
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",")}}`
}

/** SHA-256 over the stable serialisation. Same seed → same hash. */
export function hashCatalogue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

// ---------------------------------------------------------------------------
// Raw provider rows (Xtream shapes)
// ---------------------------------------------------------------------------

export interface RawVodRow {
  stream_id: number
  name: string
  stream_icon: string | null
  year: string
  rating: string
  rating_5based?: string
  duration: string
  category_id: string | null
  added: number
  tmdb_id?: number
  plot?: string
}

export interface RawSeriesRow {
  series_id: number
  name: string
  cover: string | null
  year: string
  rating: string
  category_id: string | null
  added: number
  tmdb_id?: number
  plot?: string
}

export interface ProviderCategory {
  id: string
  name: string
}

export const MOVIE_PROVIDER_CATEGORIES: ProviderCategory[] = [
  { id: "101", name: "Movies | Action" },
  { id: "102", name: "Movies | Comedy" },
  { id: "103", name: "Movies | Horror" },
  { id: "104", name: "Movies | Drama" },
  { id: "105", name: "Movies | Sci-Fi" },
  { id: "106", name: "Movies | Thriller" },
  { id: "107", name: "Movies | Romance" },
  { id: "108", name: "Movies | Family" },
  { id: "109", name: "Movies | Animation" },
  { id: "110", name: "Movies | Crime" },
  { id: "111", name: "Documentaries" },
  { id: "112", name: "Movies FHD" },
  { id: "113", name: "4K Movies" },
  { id: "114", name: "UK | Movies" },
  { id: "115", name: "Bollywood Movies" },
  { id: "116", name: "Kids Movies" },
  // Duplicate display label, distinct raw string + id: the index must
  // keep these as TWO categories, never merge them.
  { id: "117", name: "Movies|Action" },
  { id: "118", name: "MOVIES | ACTION" },
]

export const SERIES_PROVIDER_CATEGORIES: ProviderCategory[] = [
  { id: "201", name: "Series | Drama" },
  { id: "202", name: "Series | Comedy" },
  { id: "203", name: "TV Shows | Action" },
  { id: "204", name: "Series Complete" },
  { id: "205", name: "UK | Series" },
  { id: "206", name: "Series | Documentary" },
  { id: "207", name: "Kids Series" },
  { id: "208", name: "Series | Horror" },
  { id: "209", name: "Series | Sci-Fi" },
  { id: "210", name: "Series|Drama" },
]

// ---------------------------------------------------------------------------
// Title generation (invented combinatorial titles)
// ---------------------------------------------------------------------------

const TITLE_OPENERS = [
  "The", "A", "An", "", "", "", "The", "The",
]
const TITLE_ADJECTIVES = [
  "Silent", "Crimson", "Hollow", "Burning", "Frozen", "Velvet", "Iron",
  "Glass", "Midnight", "Golden", "Broken", "Endless", "Hidden", "Wild",
  "Lonely", "Electric", "Paper", "Copper", "Amber", "Ivory", "Stormy",
  "Quiet", "Restless", "Feral", "Gilded", "Woven", "Sunken", "Drifting",
  "Hallowed", "Wayward",
]
const TITLE_NOUNS = [
  "Harbour", "Signal", "Garden", "River", "Crown", "Window", "Bridge",
  "Lantern", "Valley", "Compass", "Anchor", "Meadow", "Tower", "Archive",
  "Crossing", "Ember", "Voyage", "Orchard", "Summit", "Ledger", "Horizon",
  "Quarry", "Willow", "Marsh", "Beacon", "Fable", "Tide", "Monsoon",
  "Vigil", "Atlas",
]
const TITLE_SUFFIXES = [
  "", "", "", "", "Returns", "Rising", "Falls", "Reborn", "Unbound",
  "at Dawn", "in Winter", "of Ashes", "of Thorns", "Beyond the Sea",
]

const VARIANT_SUFFIXES = [
  "1080p", "FHD", "4K", "720p", "HINDI", "DUAL AUDIO", "[HINDI]",
  "[MULTI]", "ENGLISH", "TAMIL", "WEB-DL", "HDR", "BluRay",
]

const GENRE_WORDS: Record<string, number[]> = {
  action: [28],
  adventure: [12],
  animation: [16],
  comedy: [35],
  crime: [80],
  documentary: [99],
  drama: [18],
  family: [10751],
  fantasy: [14],
  horror: [27],
  romance: [10749],
  "sci-fi": [878],
  thriller: [53],
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)]
}

function renderDuration(rng: () => number, minutes: number): string {
  const style = Math.floor(rng() * 4)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  switch (style) {
    case 0:
      return `${minutes} min`
    case 1:
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`
    case 2:
      return `${minutes * 60}`
    default:
      return h > 0 ? `${h}h ${m}m` : `${m}m`
  }
}

export interface GeneratedCatalogue {
  seed: number
  movies: CatalogEntry[]
  series: CatalogEntry[]
  rawMovies: RawVodRow[]
  rawSeries: RawSeriesRow[]
  movieCategories: ProviderCategory[]
  seriesCategories: ProviderCategory[]
  /** Series id → get_series_info payload (season-keyed episodes). */
  seriesInfo: Map<number, unknown>
  /** Ground truth: series id → confirmed season count (null = unknown). */
  seasonCounts: Map<number, number | null>
  /** Entry id → episode-level progress (series, keyed by episode id). */
  episodeProgress: Map<number, EntryProgress>
}

export interface GenerateOptions {
  seed?: number
  movieCount?: number
  seriesCount?: number
  /** Fraction of movies emitted with language/quality variants. */
  variantRate?: number
  /** Fraction of entries with no poster. */
  missingPosterRate?: number
  /** Fraction of entries with no rating. */
  unratedRate?: number
  /** Fraction of entries with no year. */
  missingYearRate?: number
  /** Fraction of entries with unknown `added`. */
  missingAddedRate?: number
  /** Fraction of entries in no provider category. */
  uncategorisedRate?: number
  /** Fraction of series with no confirmed season info. */
  missingSeasonRate?: number
}

/**
 * Generate a deterministic catalogue. `movieCount`/`seriesCount` are
 * BASE titles; variants add extra rows on top (counted in the
 * returned arrays). The mega-category ("Movies FHD") deliberately
 * holds ~25% of movies so large-category behaviour is exercised.
 */
export function generateCatalogue(
  options: GenerateOptions = {}
): GeneratedCatalogue {
  const seed = options.seed ?? 0x0118
  const movieCount = options.movieCount ?? 1000
  const seriesCount = options.seriesCount ?? 200
  const variantRate = options.variantRate ?? 0.08
  const missingPosterRate = options.missingPosterRate ?? 0.12
  const unratedRate = options.unratedRate ?? 0.25
  const missingYearRate = options.missingYearRate ?? 0.15
  const missingAddedRate = options.missingAddedRate ?? 0.08
  const uncategorisedRate = options.uncategorisedRate ?? 0.04
  const missingSeasonRate = options.missingSeasonRate ?? 0.2
  const rng = mulberry32(seed)

  const movieCategories = MOVIE_PROVIDER_CATEGORIES
  const seriesCategories = SERIES_PROVIDER_CATEGORIES
  const movieCategoryMap = new Map(
    movieCategories.map((c) => [c.id, c.name])
  )
  const seriesCategoryMap = new Map(
    seriesCategories.map((c) => [c.id, c.name])
  )

  const usedTitles = new Set<string>()
  const freshTitle = (year: number | null): string => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const opener = pick(rng, TITLE_OPENERS)
      const title = [
        opener,
        pick(rng, TITLE_ADJECTIVES),
        pick(rng, TITLE_NOUNS),
        pick(rng, TITLE_SUFFIXES),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      const key = `${title.toLowerCase()}|${year ?? "?"}`
      if (!usedTitles.has(key)) {
        usedTitles.add(key)
        return title
      }
    }
    const fallback = `Untitled Chronicle ${usedTitles.size}`
    usedTitles.add(`${fallback.toLowerCase()}|${year ?? "?"}`)
    return fallback
  }

  const randomYear = (): { year: string; yearNum: number | null } => {
    if (rng() < missingYearRate) return { year: "", yearNum: null }
    const yearNum = 1955 + Math.floor(rng() * 72)
    return { year: String(yearNum), yearNum }
  }
  const randomAdded = (): number => {
    if (rng() < missingAddedRate) return 0
    // 2023-01-01 .. 2026-11-12, unix seconds.
    return 1672531200 + Math.floor(rng() * 121000000)
  }
  const randomRating = (): string => {
    if (rng() < unratedRate) return ""
    const value = 4 + rng() * 6
    return value.toFixed(1)
  }
  const randomPoster = (id: number): string | null => {
    if (rng() < missingPosterRate) return null
    return `https://posters.example.invalid/p/${id}.jpg`
  }
  const randomMovieCategory = (): ProviderCategory | null => {
    if (rng() < uncategorisedRate) return null
    // Mega-category: ~25% of movies land in "Movies FHD".
    if (rng() < 0.25) return movieCategories[11]
    return pick(rng, movieCategories)
  }
  const randomSeriesCategory = (): ProviderCategory | null => {
    if (rng() < uncategorisedRate) return null
    return pick(rng, seriesCategories)
  }
  const genreIdsFor = (categoryName: string): number[] => {
    const lower = categoryName.toLowerCase()
    const ids: number[] = []
    for (const [word, tmdb] of Object.entries(GENRE_WORDS)) {
      if (lower.includes(word.replace("-", " ")) || lower.includes(word)) {
        ids.push(...tmdb)
      }
    }
    return ids
  }

  const rawMovies: RawVodRow[] = []
  const movies: CatalogEntry[] = []
  let nextMovieId = 1000
  const pushMovie = (
    raw: RawVodRow,
    extra: Partial<CatalogEntry>
  ): CatalogEntry => {
    rawMovies.push(raw)
    const mapped = mapMovieRow(raw, movieCategoryMap)
    if (!mapped) throw new Error(`fixture movie failed to map: ${raw.name}`)
    const entry: CatalogEntry = {
      id: mapped.id,
      kind: "vod",
      name: mapped.name,
      // W1-visible row fields (the index reads these, not the extras).
      rating: mapped.rating,
      rating_5based: raw.rating_5based ?? null,
      duration: mapped.duration,
      category: mapped.category,
      category_id: raw.category_id,
      logo: mapped.logo,
      tmdb: mapped.tmdb,
      plot: mapped.plot,
      norm: mapped.norm,
      genre: extra.genreString ? extra.genreString : undefined,
      displayTitle: mapped.name.trim().replace(/\s+/g, " "),
      baseTitle: baseTitleOf(mapped.name),
      year: mapped.year,
      yearNum: parseYear(mapped.year),
      ratingRaw: mapped.rating,
      ratingScale: raw.rating_5based ? 5 : 10,
      durationRaw: mapped.duration,
      categoryId: raw.category_id,
      categoryName: mapped.category,
      tmdbGenreIds: extra.tmdbGenreIds ?? [],
      genreString: extra.genreString ?? "",
      added: mapped.added,
      poster: mapped.logo,
      seasonCount: null,
      episodeCount: null,
      episodes: [],
      language: extra.language ?? null,
      quality: extra.quality ?? null,
    }
    movies.push(entry)
    return entry
  }

  for (let i = 0; i < movieCount; i++) {
    const { year } = randomYear()
    const title = freshTitle(parseYear(year))
    const category = randomMovieCategory()
    const minutes = 70 + Math.floor(rng() * 110)
    const hasDuration = rng() < 0.9
    const base: RawVodRow = {
      stream_id: nextMovieId++,
      name: title,
      stream_icon: randomPoster(nextMovieId),
      year,
      rating: randomRating(),
      duration: hasDuration ? renderDuration(rng, minutes) : "",
      category_id: category?.id ?? null,
      added: randomAdded(),
    }
    const genreIds = genreIdsFor(category?.name ?? "")
    pushMovie(base, { tmdbGenreIds: genreIds })
    // Language/quality variants: same title + year, suffixed names.
    if (rng() < variantRate) {
      const variantCount = 1 + Math.floor(rng() * 3)
      const suffixes = [...VARIANT_SUFFIXES].sort(() => rng() - 0.5)
      for (let v = 0; v < variantCount; v++) {
        const suffix = suffixes[v % suffixes.length]
        pushMovie(
          {
            ...base,
            stream_id: nextMovieId++,
            name: `${title} ${suffix}`,
            stream_icon: rng() < 0.5 ? base.stream_icon : null,
            added: base.added,
          },
          {
            tmdbGenreIds: genreIds,
            language: /HINDI|TAMIL|ENGLISH/.test(suffix) ? suffix : null,
            quality: /1080p|720p|4K|FHD|HDR/.test(suffix) ? suffix : null,
          }
        )
      }
    }
    // Malformed-title spice: a few rows with padding / caps / year-in-title.
    if (rng() < 0.01) {
      const { year: y2 } = randomYear()
      const t2 = freshTitle(parseYear(y2))
      pushMovie(
        {
          stream_id: nextMovieId++,
          name: `  ${t2.toUpperCase()}   `,
          stream_icon: randomPoster(nextMovieId),
          year: y2,
          rating: randomRating(),
          duration: renderDuration(rng, 90 + Math.floor(rng() * 60)),
          category_id: category?.id ?? null,
          added: randomAdded(),
        },
        { tmdbGenreIds: genreIds }
      )
    }
  }

  const rawSeries: RawSeriesRow[] = []
  const series: CatalogEntry[] = []
  const seriesInfo = new Map<number, unknown>()
  const seasonCounts = new Map<number, number | null>()
  const episodeProgress = new Map<number, EntryProgress>()
  let nextSeriesId = 5000
  let nextEpisodeId = 90000

  for (let i = 0; i < seriesCount; i++) {
    const { year } = randomYear()
    const title = freshTitle(parseYear(year))
    const category = randomSeriesCategory()
    const id = nextSeriesId++
    const raw: RawSeriesRow = {
      series_id: id,
      name: title,
      cover: randomPoster(id),
      year,
      rating: randomRating(),
      category_id: category?.id ?? null,
      added: randomAdded(),
    }
    rawSeries.push(raw)
    const mapped = mapSeriesRow(raw, seriesCategoryMap)
    if (!mapped) throw new Error(`fixture series failed to map: ${raw.name}`)
    const missingSeasons = rng() < missingSeasonRate
    const seasonCount = missingSeasons ? null : 1 + Math.floor(rng() * 4)
    const episodes: EpisodeRef[] = []
    if (seasonCount != null) {
      const episodesBySeason: Record<string, unknown[]> = {}
      for (let s = 1; s <= seasonCount; s++) {
        const count = 4 + Math.floor(rng() * 9)
        const list: unknown[] = []
        for (let e = 1; e <= count; e++) {
          const epId = nextEpisodeId++
          episodes.push({ id: epId, season: s, episode: e, title: `Episode ${e}` })
          list.push({
            id: epId,
            season: s,
            episode_num: e,
            title: `Episode ${e}`,
            info: { duration_secs: 2400 + Math.floor(rng() * 600) },
          })
        }
        episodesBySeason[String(s)] = list
      }
      seriesInfo.set(id, { info: { name: title }, episodes: episodesBySeason })
    } else {
      // No episodes member at all: season info genuinely unknown.
      seriesInfo.set(id, { info: { name: title } })
    }
    seasonCounts.set(id, seasonCount)
    series.push({
      id: mapped.id,
      kind: "series",
      name: mapped.name,
      // W1-visible row fields (the index reads these, not the extras).
      // Series rows carry no duration; W1 runtime is vod-only.
      rating: mapped.rating,
      rating_5based: mapped.rating_5based ?? null,
      duration: "",
      category: mapped.category,
      category_id: raw.category_id,
      logo: mapped.logo,
      tmdb: mapped.tmdb,
      plot: mapped.plot,
      norm: mapped.norm,
      displayTitle: mapped.name.trim().replace(/\s+/g, " "),
      baseTitle: baseTitleOf(mapped.name),
      year: mapped.year,
      yearNum: parseYear(mapped.year),
      ratingRaw: mapped.rating,
      ratingScale: 10,
      durationRaw: "",
      categoryId: raw.category_id,
      categoryName: mapped.category,
      tmdbGenreIds: genreIdsFor(category?.name ?? ""),
      genreString: "",
      added: mapped.added,
      poster: mapped.logo,
      seasonCount,
      episodeCount: seasonCount == null ? null : episodes.length,
      episodes,
      language: null,
      quality: null,
    })
    // Partially-watched spice: some series have episode progress.
    if (seasonCount != null && episodes.length > 0 && rng() < 0.35) {
      const watched = Math.floor(rng() * episodes.length)
      for (let w = 0; w < watched; w++) {
        episodeProgress.set(episodes[w].id, {
          position: 2700,
          duration: 2700,
          completed: true,
          updatedAt: 1700000000 + w,
        })
      }
      if (watched < episodes.length && rng() < 0.7) {
        episodeProgress.set(episodes[watched].id, {
          position: 900,
          duration: 2700,
          completed: false,
          updatedAt: 1750000000,
        })
      }
    }
  }

  return {
    seed,
    movies,
    series,
    rawMovies,
    rawSeries,
    movieCategories,
    seriesCategories,
    seriesInfo,
    seasonCounts,
    episodeProgress,
  }
}

/** Convenience: a catalogue of exactly `total` entries (80/20 movies/series). */
export function generateCatalogueOfSize(
  total: number,
  seed = 0x0118
): GeneratedCatalogue {
  const seriesCount = Math.round(total * 0.2)
  return generateCatalogue({
    seed,
    movieCount: total - seriesCount,
    seriesCount,
  })
}

/**
 * A new provider revision of a catalogue: one category renamed, some
 * entries added/removed, and a fraction of ids remapped (same titles,
 * new ids — the ID-churn scenario). The returned catalogue shares no
 * entry objects with the input.
 */
export function reviseCatalogue(
  input: GeneratedCatalogue,
  revisionSeed = 0x5eed
): GeneratedCatalogue {
  const rng = mulberry32(revisionSeed)
  const renamed = input.movieCategories.map((c, i) =>
    i === 0 ? { ...c, name: "Movies | Action & Adventure" } : c
  )
  const renamedMap = new Map(renamed.map((c) => [c.id, c.name]))
  const movies: CatalogEntry[] = []
  for (const entry of input.movies) {
    if (rng() < 0.02) continue // provider dropped the row
    const remapped = rng() < 0.05
    movies.push({
      ...entry,
      id: remapped ? entry.id + 1_000_000 : entry.id,
      // The rename must reach the W1-visible `category` field too,
      // not just the ground-truth label, or the index never sees it.
      category:
        entry.categoryId != null
          ? (renamedMap.get(entry.categoryId) ?? entry.categoryName)
          : entry.categoryName,
      categoryName:
        entry.categoryId != null
          ? (renamedMap.get(entry.categoryId) ?? entry.categoryName)
          : entry.categoryName,
    })
  }
  const extra = generateCatalogue({
    seed: revisionSeed,
    movieCount: 25,
    seriesCount: 5,
  })
  for (const entry of extra.movies) {
    movies.push({ ...entry, id: entry.id + 2_000_000 })
  }
  const series: CatalogEntry[] = input.series.map((entry) => ({ ...entry }))
  for (const entry of extra.series) {
    series.push({ ...entry, id: entry.id + 2_000_000 })
  }
  return {
    ...input,
    movies,
    series,
    movieCategories: renamed,
    seriesInfo: new Map(input.seriesInfo),
    seasonCounts: new Map(input.seasonCounts),
    episodeProgress: new Map(input.episodeProgress),
  }
}

/**
 * Entry-level progress map for selectContinueWatching: a deterministic
 * mix of in-progress, completed, untouched (absent) and barely-started
 * (≤30s) entries.
 */
export function generateEntryProgress(
  entries: CatalogEntry[],
  seed = 0x9a17
): Map<number, EntryProgress> {
  const rng = mulberry32(seed)
  const progress = new Map<number, EntryProgress>()
  for (const entry of entries) {
    const roll = rng()
    if (roll < 0.6) continue // untouched: no progress row at all
    if (roll < 0.72) {
      progress.set(entry.id, {
        position: 1800,
        duration: 5400,
        completed: false,
        updatedAt: 1700000000 + entry.id,
      })
    } else if (roll < 0.84) {
      progress.set(entry.id, {
        position: 5400,
        duration: 5400,
        completed: true,
        updatedAt: 1700000000 + entry.id,
      })
    } else if (roll < 0.92) {
      progress.set(entry.id, {
        position: 12,
        duration: 5400,
        completed: false,
        updatedAt: 1700000000 + entry.id,
      })
    } else {
      progress.set(entry.id, {
        position: 5400,
        duration: 5400,
        completed: false, // played to the end, flag missing
        updatedAt: 1700000000 + entry.id,
      })
    }
  }
  return progress
}

// ---------------------------------------------------------------------------
// Adversarial hand-written fixture
// ---------------------------------------------------------------------------

export interface AdversarialFixture {
  movies: CatalogEntry[]
  series: CatalogEntry[]
  /** Series id → get_series_info payload. */
  seriesInfo: Map<number, unknown>
  movieCategories: ProviderCategory[]
  seriesCategories: ProviderCategory[]
}

function buildAdversarialMovie(
  raw: RawVodRow,
  categoryMap: Map<string, string>,
  extra: Partial<CatalogEntry> = {}
): CatalogEntry {
  const mapped = mapMovieRow(raw, categoryMap)
  if (!mapped) throw new Error(`adversarial movie failed to map: ${raw.name}`)
  return {
    id: mapped.id,
    kind: "vod",
    name: mapped.name,
    // W1-visible row fields (the index reads these, not the extras).
    rating: mapped.rating,
    rating_5based: raw.rating_5based ?? null,
    duration: mapped.duration,
    category: mapped.category,
    category_id: raw.category_id,
    logo: mapped.logo,
    tmdb: mapped.tmdb,
    plot: mapped.plot,
    norm: mapped.norm,
    genre: extra.genreString ? extra.genreString : undefined,
    displayTitle: mapped.name.trim().replace(/\s+/g, " "),
    baseTitle: baseTitleOf(mapped.name),
    year: mapped.year,
    yearNum: parseYear(mapped.year),
    ratingRaw: mapped.rating,
    ratingScale: raw.rating_5based ? 5 : 10,
    durationRaw: mapped.duration,
    categoryId: raw.category_id,
    categoryName: mapped.category,
    tmdbGenreIds: extra.tmdbGenreIds ?? [],
    genreString: extra.genreString ?? "",
    added: mapped.added,
    poster: mapped.logo,
    seasonCount: null,
    episodeCount: null,
    episodes: [],
    language: extra.language ?? null,
    quality: extra.quality ?? null,
  }
}

function buildAdversarialSeries(
  raw: RawSeriesRow,
  categoryMap: Map<string, string>,
  extra: Partial<CatalogEntry> = {}
): CatalogEntry {
  const mapped = mapSeriesRow(raw, categoryMap)
  if (!mapped) throw new Error(`adversarial series failed to map: ${raw.name}`)
  return {
    id: mapped.id,
    kind: "series",
    name: mapped.name,
    // W1-visible row fields (the index reads these, not the extras).
    rating: mapped.rating,
    rating_5based: mapped.rating_5based ?? null,
    duration: "",
    category: mapped.category,
    category_id: raw.category_id,
    logo: mapped.logo,
    tmdb: mapped.tmdb,
    plot: mapped.plot,
    norm: mapped.norm,
    genre: extra.genreString ? extra.genreString : undefined,
    displayTitle: mapped.name.trim().replace(/\s+/g, " "),
    baseTitle: baseTitleOf(mapped.name),
    year: mapped.year,
    yearNum: parseYear(mapped.year),
    ratingRaw: mapped.rating,
    ratingScale: 10,
    durationRaw: "",
    categoryId: raw.category_id,
    categoryName: mapped.category,
    tmdbGenreIds: extra.tmdbGenreIds ?? [],
    genreString: extra.genreString ?? "",
    added: mapped.added,
    poster: mapped.logo,
    seasonCount: extra.seasonCount ?? null,
    episodeCount: extra.episodeCount ?? null,
    episodes: extra.episodes ?? [],
    language: null,
    quality: null,
  }
}

/**
 * Small hand-written catalogue pinning the nasty cases: punctuation-
 * prefixed titles, duplicate display labels, same-name/different-year
 * films, a movie+series title collision, quality/language variants,
 * unrated/zero-rated rows, runtime boundaries, added-vs-year
 * inversions, and a 5-based rating. Ids are fixed (7000+) so tests
 * can name them.
 */
export function adversarialFixture(): AdversarialFixture {
  const movieCategories: ProviderCategory[] = [
    { id: "301", name: "Movies | Action" },
    { id: "302", name: "Movies | Comedy" },
    { id: "303", name: "Movies | Horror" },
    { id: "304", name: "Movies|Action" },
    { id: "305", name: "Movies | Drama" },
  ]
  const seriesCategories: ProviderCategory[] = [
    { id: "401", name: "Series | Drama" },
    { id: "402", name: "Series | Comedy" },
  ]
  const movieMap = new Map(movieCategories.map((c) => [c.id, c.name]))
  const seriesMap = new Map(seriesCategories.map((c) => [c.id, c.name]))

  const poster = (id: number): string => `https://posters.example.invalid/a/${id}.jpg`
  const movies: CatalogEntry[] = [
    // Punctuation-prefixed titles sort/search first — never lost.
    buildAdversarialMovie({ stream_id: 7001, name: "!Revolt of the Silent", stream_icon: poster(7001), year: "2021", rating: "8.4", duration: "118 min", category_id: "301", added: 1750000000 }, movieMap, { tmdbGenreIds: [28] }),
    buildAdversarialMovie({ stream_id: 7002, name: "...And Then the Rain", stream_icon: poster(7002), year: "2019", rating: "7.9", duration: "102 min", category_id: "305", added: 1750000100 }, movieMap, { tmdbGenreIds: [18] }),
    buildAdversarialMovie({ stream_id: 7003, name: "#Signal Lost", stream_icon: poster(7003), year: "2023", rating: "8.9", duration: "131 min", category_id: "301", added: 1750000200 }, movieMap, { tmdbGenreIds: [28, 878] }),
    // Same name, different years: NEVER one group.
    buildAdversarialMovie({ stream_id: 7004, name: "The Crossing", stream_icon: poster(7004), year: "2018", rating: "7.1", duration: "110 min", category_id: "305", added: 1700000000 }, movieMap, { tmdbGenreIds: [18] }),
    buildAdversarialMovie({ stream_id: 7005, name: "The Crossing", stream_icon: poster(7005), year: "2021", rating: "6.8", duration: "125 min", category_id: "305", added: 1700001000 }, movieMap, { tmdbGenreIds: [18] }),
    // Harbour Lights variants: same year, suffix-only differences → ONE group of 5.
    buildAdversarialMovie({ stream_id: 7010, name: "Harbour Lights", stream_icon: poster(7010), year: "2022", rating: "8.1", duration: "105 min", category_id: "301", added: 1720000000 }, movieMap, { tmdbGenreIds: [28] }),
    buildAdversarialMovie({ stream_id: 7011, name: "Harbour Lights 1080p", stream_icon: null, year: "2022", rating: "8.1", duration: "105 min", category_id: "301", added: 1720000000 }, movieMap, { tmdbGenreIds: [28], quality: "1080p" }),
    buildAdversarialMovie({ stream_id: 7012, name: "Harbour Lights FHD", stream_icon: null, year: "2022", rating: "", duration: "105 min", category_id: "301", added: 1720000000 }, movieMap, { tmdbGenreIds: [28], quality: "FHD" }),
    buildAdversarialMovie({ stream_id: 7013, name: "Harbour Lights [HINDI]", stream_icon: null, year: "2022", rating: "8.1", duration: "105 min", category_id: "301", added: 1720000000 }, movieMap, { tmdbGenreIds: [28], language: "HINDI" }),
    buildAdversarialMovie({ stream_id: 7014, name: "Harbour Lights DUAL AUDIO", stream_icon: null, year: "2022", rating: "8.1", duration: "105 min", category_id: "301", added: 1720000000 }, movieMap, { tmdbGenreIds: [28], language: "DUAL AUDIO" }),
    // Same base, different year: separate group, never merged into the 2022 group.
    buildAdversarialMovie({ stream_id: 7015, name: "Harbour Lights", stream_icon: poster(7015), year: "1998", rating: "7.4", duration: "98 min", category_id: "305", added: 1690000000 }, movieMap, { tmdbGenreIds: [18] }),
    // Malformed names.
    buildAdversarialMovie({ stream_id: 7020, name: "  Whitespace   Title  ", stream_icon: poster(7020), year: "2020", rating: "6.5", duration: "95 min", category_id: "302", added: 1710000000 }, movieMap, { tmdbGenreIds: [35] }),
    buildAdversarialMovie({ stream_id: 7021, name: "UPPERCASE TITLE", stream_icon: poster(7021), year: "2020", rating: "6.9", duration: "88 min", category_id: "302", added: 1710001000 }, movieMap, { tmdbGenreIds: [35] }),
    buildAdversarialMovie({ stream_id: 7022, name: "Sandstorm (2021) - Part 2", stream_icon: poster(7022), year: "2021", rating: "7.7", duration: "140 min", category_id: "301", added: 1710002000 }, movieMap, { tmdbGenreIds: [28] }),
    // Unrated / zero-rated: must never pass an 8+ filter or top a rating sort.
    buildAdversarialMovie({ stream_id: 7030, name: "Unrated Masterpiece", stream_icon: poster(7030), year: "2024", rating: "", duration: "115 min", category_id: "305", added: 1760000000 }, movieMap, { tmdbGenreIds: [18] }),
    buildAdversarialMovie({ stream_id: 7031, name: "Zero Rated Oddity", stream_icon: poster(7031), year: "2024", rating: "0", duration: "115 min", category_id: "305", added: 1760001000 }, movieMap, { tmdbGenreIds: [18] }),
    buildAdversarialMovie({ stream_id: 7032, name: "Not Applicable Rating", stream_icon: poster(7032), year: "2024", rating: "N/A", duration: "115 min", category_id: "305", added: 1760002000 }, movieMap, { tmdbGenreIds: [18] }),
    // Runtime boundaries: 119 / 120 / 121 / unknown.
    buildAdversarialMovie({ stream_id: 7040, name: "Just Under Two Hours", stream_icon: poster(7040), year: "2022", rating: "7.0", duration: "119 min", category_id: "302", added: 1710003000 }, movieMap, { tmdbGenreIds: [35] }),
    buildAdversarialMovie({ stream_id: 7041, name: "Exactly Two Hours", stream_icon: poster(7041), year: "2022", rating: "7.0", duration: "02:00:00", category_id: "302", added: 1710004000 }, movieMap, { tmdbGenreIds: [35] }),
    buildAdversarialMovie({ stream_id: 7042, name: "Just Over Two Hours", stream_icon: poster(7042), year: "2022", rating: "7.0", duration: "121 min", category_id: "302", added: 1710005000 }, movieMap, { tmdbGenreIds: [35] }),
    buildAdversarialMovie({ stream_id: 7043, name: "Runtime Unknown Film", stream_icon: poster(7043), year: "2022", rating: "7.0", duration: "", category_id: "302", added: 1710006000 }, movieMap, { tmdbGenreIds: [35] }),
    // Added-vs-year inversion: old film added yesterday beats new film added years ago.
    buildAdversarialMovie({ stream_id: 7050, name: "Old Classic Freshly Added", stream_icon: poster(7050), year: "1962", rating: "8.8", duration: "150 min", category_id: "305", added: 1790000000 }, movieMap, { tmdbGenreIds: [18] }),
    buildAdversarialMovie({ stream_id: 7051, name: "Fresh Release Added Long Ago", stream_icon: poster(7051), year: "2026", rating: "8.8", duration: "150 min", category_id: "305", added: 1673000000 }, movieMap, { tmdbGenreIds: [18] }),
    // No-poster high-rated film (featured fallback) + obscure search target.
    buildAdversarialMovie({ stream_id: 7060, name: "Posterless Wonder", stream_icon: null, year: "2023", rating: "9.7", duration: "100 min", category_id: "303", added: 1740000000 }, movieMap, { tmdbGenreIds: [27] }),
    buildAdversarialMovie({ stream_id: 7061, name: "The Quixotic Zither", stream_icon: poster(7061), year: "2017", rating: "5.4", duration: "91 min", category_id: "302", added: 1680000000 }, movieMap, { tmdbGenreIds: [35] }),
    // 5-based provider rating: 4.5/5 == 9.0/10.
    buildAdversarialMovie({ stream_id: 7070, name: "Five Based Gem", stream_icon: poster(7070), year: "2020", rating: "", rating_5based: "4.5", duration: "108 min", category_id: "301", added: 1730000000 }, movieMap, { tmdbGenreIds: [28] }),
    // Uncategorised + duplicate-label category members.
    buildAdversarialMovie({ stream_id: 7080, name: "Nowhere Category Film", stream_icon: poster(7080), year: "2021", rating: "7.3", duration: "99 min", category_id: null, added: 1725000000 }, movieMap, { tmdbGenreIds: [18], genreString: "Drama" }),
    buildAdversarialMovie({ stream_id: 7081, name: "Duplicate Label Actioner", stream_icon: poster(7081), year: "2021", rating: "7.3", duration: "99 min", category_id: "304", added: 1725001000 }, movieMap, { tmdbGenreIds: [28] }),
    // Genre-replace pair: a pure Comedy and a pure Horror, no overlap.
    buildAdversarialMovie({ stream_id: 7090, name: "Pure Comedy Vehicle", stream_icon: poster(7090), year: "2023", rating: "7.6", duration: "94 min", category_id: "302", added: 1745000000 }, movieMap, { tmdbGenreIds: [35] }),
    buildAdversarialMovie({ stream_id: 7091, name: "Pure Horror Vehicle", stream_icon: poster(7091), year: "2023", rating: "7.6", duration: "94 min", category_id: "303", added: 1745001000 }, movieMap, { tmdbGenreIds: [27] }),
    // Unknown added: sorts last in Recently Added, never first.
    buildAdversarialMovie({ stream_id: 7095, name: "Added Unknown Film", stream_icon: poster(7095), year: "2025", rating: "8.2", duration: "100 min", category_id: "301", added: 0 }, movieMap, { tmdbGenreIds: [28] }),
  ]

  const seriesInfo = new Map<number, unknown>()
  const episodesFor = (
    seriesId: number,
    seasons: number,
    perSeason: number
  ): EpisodeRef[] => {
    const episodes: EpisodeRef[] = []
    const bySeason: Record<string, unknown[]> = {}
    let epId = seriesId * 100
    for (let s = 1; s <= seasons; s++) {
      const list: unknown[] = []
      for (let e = 1; e <= perSeason; e++) {
        epId += 1
        episodes.push({ id: epId, season: s, episode: e, title: `Episode ${e}` })
        list.push({
          id: epId,
          season: s,
          episode_num: e,
          title: `Episode ${e}`,
          info: { duration_secs: 2700 },
        })
      }
      bySeason[String(s)] = list
    }
    seriesInfo.set(seriesId, {
      info: { name: `Series ${seriesId}` },
      episodes: bySeason,
    })
    return episodes
  }

  const crossingEpisodes = episodesFor(7101, 2, 6)
  const watchedEpisodes = episodesFor(7102, 2, 4)
  const series: CatalogEntry[] = [
    // Movie+series title collision: never grouped with the films.
    buildAdversarialSeries({ series_id: 7101, name: "The Crossing", cover: poster(7101), year: "2020", rating: "8.3", category_id: "401", added: 1720000000 }, seriesMap, { tmdbGenreIds: [18], seasonCount: 2, episodeCount: crossingEpisodes.length, episodes: crossingEpisodes }),
    // Partially watched: S1 complete, S2E1 in progress (progress in tests).
    buildAdversarialSeries({ series_id: 7102, name: "The Long Watch", cover: poster(7102), year: "2022", rating: "8.6", category_id: "401", added: 1730000000 }, seriesMap, { tmdbGenreIds: [18], seasonCount: 2, episodeCount: watchedEpisodes.length, episodes: watchedEpisodes }),
    // Missing season info: no episodes member — counts must stay unknown.
    buildAdversarialSeries({ series_id: 7103, name: "Mystery Seasons Show", cover: poster(7103), year: "2021", rating: "7.8", category_id: "402", added: 1710000000 }, seriesMap, { tmdbGenreIds: [35], seasonCount: null, episodeCount: null, episodes: [] }),
    // Confirmed zero episodes: nothing to start.
    buildAdversarialSeries({ series_id: 7104, name: "Empty Shell Series", cover: poster(7104), year: "2023", rating: "9.0", category_id: "401", added: 1740000000 }, seriesMap, { tmdbGenreIds: [18], seasonCount: 0, episodeCount: 0, episodes: [] }),
    // Unrated series: never in Worth Starting.
    buildAdversarialSeries({ series_id: 7105, name: "Unrated Serial", cover: poster(7105), year: "2020", rating: "", category_id: "402", added: 1700000000 }, seriesMap, { tmdbGenreIds: [35], seasonCount: 1, episodeCount: 3, episodes: episodesFor(7105, 1, 3) }),
  ]
  seriesInfo.set(7103, { info: { name: "Mystery Seasons Show" } })
  seriesInfo.set(7104, { info: { name: "Empty Shell Series" }, episodes: {} })

  return { movies, series, seriesInfo, movieCategories, seriesCategories }
}

/**
 * Followed-series ID-churn scenario in get_series_info shape:
 *  - baseline: S1E1–E10, provider ids 101–110.
 *  - remapped: SAME episodes (same S/E + titles), provider ids 901–910.
 *  - genuinelyNew: baseline + S1E11–E12 with fresh ids.
 * The bulk-remap guard must flag `remapped` (no false alerts) while
 * `genuinelyNew` diffs to exactly E11+E12.
 */
export function buildChurnScenario(): {
  baseline: unknown
  remapped: unknown
  genuinelyNew: unknown
} {
  const season = (ids: number[]): unknown => ({
    info: { name: "Churn Show" },
    episodes: {
      "1": ids.map((id, i) => ({
        id,
        season: 1,
        episode_num: i + 1,
        title: `Episode ${i + 1}`,
      })),
    },
  })
  const baselineIds = Array.from({ length: 10 }, (_, i) => 101 + i)
  const remappedIds = Array.from({ length: 10 }, (_, i) => 901 + i)
  return {
    baseline: season(baselineIds),
    remapped: season(remappedIds),
    genuinelyNew: season([...baselineIds, 201, 202]),
  }
}
