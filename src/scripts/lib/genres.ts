// Canonical genre taxonomy: pure name/TMDb-id matching, no fetch/storage/DOM.

import { normalize } from "@/scripts/lib/text.ts"

export type GenreId =
  | "action"
  | "adventure"
  | "animation"
  | "comedy"
  | "crime"
  | "documentary"
  | "drama"
  | "family"
  | "fantasy"
  | "history"
  | "horror"
  | "music"
  | "mystery"
  | "romance"
  | "sci-fi"
  | "thriller"
  | "war"
  | "western"

export interface CanonicalGenre {
  id: GenreId
  labelKey: string
  tmdbMovieIds: number[]
  tmdbTvIds: number[]
}

const GENRE_IDS: GenreId[] = [
  "action",
  "adventure",
  "animation",
  "comedy",
  "crime",
  "documentary",
  "drama",
  "family",
  "fantasy",
  "history",
  "horror",
  "music",
  "mystery",
  "romance",
  "sci-fi",
  "thriller",
  "war",
  "western",
]

// 10770 (TV Movie) is deliberately unmapped.
const TMDB_MOVIE_GENRE_MAP: Record<number, GenreId[]> = {
  28: ["action"],
  12: ["adventure"],
  16: ["animation"],
  35: ["comedy"],
  80: ["crime"],
  99: ["documentary"],
  18: ["drama"],
  10751: ["family"],
  14: ["fantasy"],
  36: ["history"],
  27: ["horror"],
  10402: ["music"],
  9648: ["mystery"],
  10749: ["romance"],
  878: ["sci-fi"],
  53: ["thriller"],
  10752: ["war"],
  37: ["western"],
}

// 10763 (News) / 10764 (Reality) / 10766 (Soap) / 10767 (Talk) are deliberately unmapped.
// Order matters for the multi-genre ids below (10759, 10765): it drives output order.
const TMDB_TV_GENRE_MAP: Record<number, GenreId[]> = {
  10759: ["action", "adventure"],
  16: ["animation"],
  35: ["comedy"],
  80: ["crime"],
  99: ["documentary"],
  18: ["drama"],
  10751: ["family"],
  10762: ["family"],
  9648: ["mystery"],
  10765: ["sci-fi", "fantasy"],
  10768: ["war"],
  37: ["western"],
}

function idsForGenre(map: Record<number, GenreId[]>, genreId: GenreId): number[] {
  return Object.keys(map)
    .map(Number)
    .filter((tmdbId) => map[tmdbId].includes(genreId))
}

export const CANONICAL_GENRES: CanonicalGenre[] = GENRE_IDS.map((id) => ({
  id,
  labelKey: `genres.${id}`,
  tmdbMovieIds: idsForGenre(TMDB_MOVIE_GENRE_MAP, id),
  tmdbTvIds: idsForGenre(TMDB_TV_GENRE_MAP, id),
}))

const GENRE_SYNONYMS: Record<GenreId, string[]> = {
  action: [
    "action",
    "aktion",
    "accion",
    "acción",
    "azione",
    "acao",
    "ação",
    "aksiyon",
    "actie",
    "akcja",
    "боевик",
    "δραση",
    "δράση",
    "اكشن",
    "أكشن",
  ],
  adventure: [
    "adventure",
    "abenteuer",
    "aventure",
    "aventura",
    "avventura",
    "macera",
    "avontuur",
    "przygoda",
    "przygodowy",
    "приключения",
    "περιπετεια",
    "περιπέτεια",
    "مغامرة",
  ],
  animation: [
    "animation",
    "animatie",
    "animacion",
    "animación",
    "animazione",
    "animacao",
    "animação",
    "animasyon",
    "animacja",
    "мультфильм",
    "анимация",
    "κινουμενα σχεδια",
    "κινούμενα σχέδια",
    "رسوم متحركة",
  ],
  comedy: [
    "comedy",
    "komodie",
    "komödie",
    "comedie",
    "comédie",
    "comedia",
    "commedia",
    "komedi",
    "komedia",
    "комедия",
    "κωμωδια",
    "κωμωδία",
    "كوميديا",
  ],
  crime: [
    "crime",
    "krimi",
    "kriminalfilm",
    "policier",
    "crimen",
    "poliziesco",
    "suc",
    "suç",
    "misdaad",
    "kryminal",
    "kryminał",
    "криминал",
    "εγκλημα",
    "έγκλημα",
    "جريمة",
  ],
  documentary: [
    "documentary",
    "dokumentation",
    "doku",
    "documentaire",
    "documental",
    "documentario",
    "documentário",
    "belgesel",
    "dokumentalny",
    "документальный",
    "ντοκιμαντερ",
    "ντοκιμαντέρ",
    "وثائقي",
  ],
  drama: [
    "drama",
    "drame",
    "dramma",
    "dram",
    "dramat",
    "драма",
    "δραμα",
    "δράμα",
    "دراما",
  ],
  family: [
    "family",
    "familie",
    "famille",
    "familia",
    "famiglia",
    "família",
    "aile",
    "familijny",
    "rodzinny",
    "семейный",
    "οικογενεια",
    "οικογένεια",
    "عائلي",
  ],
  fantasy: [
    "fantasy",
    "fantastique",
    "fantasia",
    "fantasía",
    "fantastik",
    "φαντασιας",
    "φαντασίας",
    "خيال",
  ],
  history: [
    "history",
    "historical",
    "geschichte",
    "historie",
    "histoire",
    "historia",
    "storia",
    "história",
    "tarih",
    "geschiedenis",
    "historyczny",
    "истории",
    "история",
    "ιστορια",
    "ιστορία",
    "تاريخي",
  ],
  horror: [
    "horror",
    "horreur",
    "terror",
    "orrore",
    "korku",
    "ужасы",
    "τρομου",
    "τρόμου",
    "τρομος",
    "τρόμος",
    "رعب",
  ],
  music: [
    "music",
    "musical",
    "musik",
    "musique",
    "musica",
    "música",
    "muzik",
    "müzik",
    "muziek",
    "muzyczny",
    "музыка",
    "μουσικη",
    "μουσική",
    "موسيقى",
  ],
  mystery: [
    "mystery",
    "mystere",
    "mystère",
    "misterio",
    "mistero",
    "mistério",
    "gizem",
    "mysterie",
    "tajemnica",
    "мистика",
    "μυστηριο",
    "μυστήριο",
    "غموض",
  ],
  romance: [
    "romance",
    "romantik",
    "liebesfilm",
    "romantico",
    "romantik film",
    "romans",
    "мелодрама",
    "романтика",
    "ρομαντικο",
    "ρομαντικό",
    "رومانسي",
  ],
  "sci-fi": [
    "sci fi",
    "scifi",
    "science fiction",
    "ciencia ficcion",
    "ciencia ficción",
    "fantascienza",
    "ficcao cientifica",
    "ficção científica",
    "bilim kurgu",
    "фантастика",
    "επιστημονικη φαντασια",
    "επιστημονική φαντασία",
    "خيال علمي",
  ],
  thriller: [
    "thriller",
    "suspenso",
    "suspense",
    "gerilim",
    "триллер",
    "θριλερ",
    "θρίλερ",
    "اثارة",
    "إثارة",
  ],
  war: [
    "war",
    "krieg",
    "guerre",
    "guerra",
    "savas",
    "savaş",
    "oorlog",
    "wojenny",
    "военный",
    "πολεμος",
    "πόλεμος",
    "حرب",
  ],
  western: [
    "western",
    "faroeste",
    "vahsi bati",
    "vahşi batı",
    "γουεστερν",
    "γουέστερν",
    "غربي",
  ],
}

function normalizeForMatch(raw: string): string {
  return normalize(raw.replace(/[&+]/g, " "))
}

const GENRE_SYNONYM_TOKENS: Record<GenreId, string[][]> = Object.fromEntries(
  GENRE_IDS.map((genreId) => [
    genreId,
    GENRE_SYNONYMS[genreId].map((phrase) => normalizeForMatch(phrase).split(" ").filter(Boolean)),
  ]),
) as Record<GenreId, string[][]>

function tokensContainPhrase(tokens: string[], phraseTokens: string[]): boolean {
  if (!phraseTokens.length) return false
  for (let i = 0; i <= tokens.length - phraseTokens.length; i++) {
    let matches = true
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

// Pure-function memo: provider catalogues repeat the same genre
// strings and category labels thousands of times, and index builds
// classify every row. Bounded FIFO cache (insertion-order eviction);
// hits return a copy so no caller can poison the cached array.
const PARSE_CACHE_MAX = 1024
const parseGenreCache = new Map<string, GenreId[]>()

function parseGenreStringUncached(raw: string): GenreId[] {
  const tokens = normalizeForMatch(raw).split(" ").filter(Boolean)
  if (!tokens.length) return []
  const matched: GenreId[] = []
  for (const genreId of GENRE_IDS) {
    const phraseLists = GENRE_SYNONYM_TOKENS[genreId]
    if (phraseLists.some((phraseTokens) => tokensContainPhrase(tokens, phraseTokens))) {
      matched.push(genreId)
    }
  }
  return matched
}

export function parseGenreString(raw: string | null | undefined): GenreId[] {
  if (!raw) return []
  if (raw.length > 200) return parseGenreStringUncached(raw)
  const hit = parseGenreCache.get(raw)
  if (hit) return [...hit]
  const matched = parseGenreStringUncached(raw)
  if (parseGenreCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseGenreCache.keys().next().value
    if (oldest !== undefined) parseGenreCache.delete(oldest)
  }
  parseGenreCache.set(raw, matched)
  return [...matched]
}

export function genreForCategoryName(name: string | null | undefined): GenreId[] {
  return parseGenreString(name)
}

export function genresForTmdbIds(kind: "vod" | "series", tmdbGenreIds: number[]): GenreId[] {
  const map = kind === "vod" ? TMDB_MOVIE_GENRE_MAP : TMDB_TV_GENRE_MAP
  const result: GenreId[] = []
  for (const tmdbGenreId of tmdbGenreIds) {
    const genreIds = map[tmdbGenreId]
    if (!genreIds) continue
    for (const genreId of genreIds) {
      if (!result.includes(genreId)) result.push(genreId)
    }
  }
  return result
}

// ── 0.11.8 W1: canonical taxonomies, series families, provider categories ──
// Brief §5 / §1.7. This section is additive: the 18-id GenreId taxonomy,
// CANONICAL_GENRES and genresForTmdbIds above are unchanged (existing
// tests pin their behaviour, including the deliberately unmapped TV ids).
// Genres are NOT mutually exclusive: every function here returns a SET.
//
// Display rule: "Science Fiction" is the one display label for the
// "sci-fi" id — there is no separate "Sci-Fi" category. The id stays
// "sci-fi" (the existing canonical id); only the display label changes.
// NOTE: the i18n string genres.sci-fi still reads "Sci-Fi"; screens in
// 0.11.8 must take the label from CANONICAL_MOVIE_GENRES /
// CANONICAL_SERIES_GENRES below, not from the i18n key. (Integration
// flag: sync the i18n value if the old key is ever retired.)

/** Bucket id for titles with no genre evidence at all. Never a real genre. */
export const UNCATEGORISED_ID = "uncategorised" as const

export interface CanonicalGenreEntry {
  /** Existing canonical id where one exists ("sci-fi", not "science-fiction"). */
  id: string
  /** The one display label. "Science Fiction" for id "sci-fi". */
  label: string
  /** Display variants / synonyms that refer to this same genre. */
  aliases: string[]
  tmdbMovieIds: number[]
  tmdbTvIds: number[]
}

const MOVIE_GENRE_LABELS: Record<GenreId, string> = {
  action: "Action",
  adventure: "Adventure",
  animation: "Animation",
  comedy: "Comedy",
  crime: "Crime",
  documentary: "Documentary",
  drama: "Drama",
  family: "Family",
  fantasy: "Fantasy",
  history: "History",
  horror: "Horror",
  music: "Music",
  mystery: "Mystery",
  romance: "Romance",
  "sci-fi": "Science Fiction",
  thriller: "Thriller",
  war: "War",
  western: "Western",
}

const MOVIE_GENRE_ALIASES: Record<GenreId, string[]> = {
  action: [],
  adventure: [],
  animation: [],
  comedy: [],
  crime: [],
  documentary: ["Documentaries"],
  drama: [],
  family: [],
  fantasy: [],
  history: ["Historical"],
  horror: [],
  music: ["Musical"],
  mystery: [],
  romance: ["Romantic"],
  "sci-fi": ["Sci-Fi", "SciFi", "Science-Fiction"],
  thriller: ["Suspense"],
  war: [],
  western: ["Westerns"],
}

/** The 18 canonical movie genres (brief §5.1), in taxonomy order. */
export const CANONICAL_MOVIE_GENRES: CanonicalGenreEntry[] = CANONICAL_GENRES.map((genre) => ({
  id: genre.id,
  label: MOVIE_GENRE_LABELS[genre.id],
  aliases: MOVIE_GENRE_ALIASES[genre.id],
  tmdbMovieIds: genre.tmdbMovieIds,
  tmdbTvIds: genre.tmdbTvIds,
}))

export interface CanonicalSeriesFamily {
  /**
   * Family id: the existing canonical GenreId when the family is a
   * single genre ("animation"), a composite id for combined families
   * ("action-adventure", "sci-fi-fantasy", "war-politics") and a new
   * id for TV-only families ("kids", "reality", "soap", "talk").
   */
  id: string
  label: string
  aliases: string[]
  /** Canonical GenreIds whose membership implies this family. [] for TV-only families. */
  memberGenreIds: GenreId[]
  /** TMDb TV genre ids that imply this family (verified ids only). */
  tmdbTvIds: number[]
}

/**
 * The 15 canonical series families (brief §5.2). Combined families are
 * aliases backed by verified genre ids: a series belongs to
 * "Action & Adventure" when verified evidence says Action OR
 * Adventure (TMDb TV 10759 maps to both). TV-only families (Kids,
 * Reality, Soap, Talk) have no GenreId members and match only on
 * their TMDb TV id or explicit name evidence — they are never
 * inferred from a bare "Series" provider category.
 */
export const CANONICAL_SERIES_GENRES: CanonicalSeriesFamily[] = [
  { id: "action-adventure", label: "Action & Adventure", aliases: ["Action", "Adventure", "Action and Adventure"], memberGenreIds: ["action", "adventure"], tmdbTvIds: [10759] },
  { id: "animation", label: "Animation", aliases: [], memberGenreIds: ["animation"], tmdbTvIds: [16] },
  { id: "comedy", label: "Comedy", aliases: [], memberGenreIds: ["comedy"], tmdbTvIds: [35] },
  { id: "crime", label: "Crime", aliases: [], memberGenreIds: ["crime"], tmdbTvIds: [80] },
  { id: "documentary", label: "Documentary", aliases: ["Documentaries"], memberGenreIds: ["documentary"], tmdbTvIds: [99] },
  { id: "drama", label: "Drama", aliases: [], memberGenreIds: ["drama"], tmdbTvIds: [18] },
  { id: "family", label: "Family", aliases: [], memberGenreIds: ["family"], tmdbTvIds: [10751] },
  { id: "kids", label: "Kids", aliases: ["Children", "Children's", "Childrens"], memberGenreIds: [], tmdbTvIds: [10762] },
  { id: "mystery", label: "Mystery", aliases: [], memberGenreIds: ["mystery"], tmdbTvIds: [9648] },
  { id: "reality", label: "Reality", aliases: ["Reality TV", "Unscripted"], memberGenreIds: [], tmdbTvIds: [10764] },
  { id: "sci-fi-fantasy", label: "Science Fiction & Fantasy", aliases: ["Sci-Fi & Fantasy", "Science Fiction", "Fantasy", "Sci-Fi", "SciFi"], memberGenreIds: ["sci-fi", "fantasy"], tmdbTvIds: [10765] },
  { id: "soap", label: "Soap", aliases: ["Soap Opera", "Telenovela"], memberGenreIds: [], tmdbTvIds: [10766] },
  { id: "talk", label: "Talk", aliases: ["Talk Show", "Talkshow"], memberGenreIds: [], tmdbTvIds: [10767] },
  { id: "war-politics", label: "War & Politics", aliases: ["War", "Politics", "War and Politics", "Political"], memberGenreIds: ["war"], tmdbTvIds: [10768] },
  { id: "western", label: "Western", aliases: ["Westerns"], memberGenreIds: ["western"], tmdbTvIds: [37] },
]

const SERIES_FAMILY_ORDER = new Map(CANONICAL_SERIES_GENRES.map((family, i) => [family.id, i]))
const MOVIE_GENRE_ORDER = new Map(CANONICAL_MOVIE_GENRES.map((genre, i) => [genre.id, i]))

function sortCanonical(ids: string[], kind: "vod" | "series"): string[] {
  const order = kind === "series" ? SERIES_FAMILY_ORDER : MOVIE_GENRE_ORDER
  return [...new Set(ids)].sort((a, b) => {
    const rankA = order.get(a)
    const rankB = order.get(b)
    if (rankA != null && rankB != null) return rankA - rankB
    if (rankA != null) return -1
    if (rankB != null) return 1
    return a.localeCompare(b)
  })
}

/** Display label for a canonical movie-genre id or series-family id. Falls back to the id itself. */
export function genreLabelForId(id: string, kind: "vod" | "series" = "vod"): string {
  const table = kind === "series" ? CANONICAL_SERIES_GENRES : CANONICAL_MOVIE_GENRES
  return table.find((entry) => entry.id === id)?.label ?? id
}

// Name tokens that imply a TV-only family. Checked as whole tokens /
// phrases on normalised text, never as substrings ("reality" must not
// match inside an unrelated word).
const TV_ONLY_FAMILY_PHRASES: Array<{ familyId: string; phrases: string[][] }> = [
  { familyId: "kids", phrases: [["kids"], ["kid"], ["children"], ["childrens"], ["child"]] },
  { familyId: "reality", phrases: [["reality"], ["reality", "tv"], ["unscripted"]] },
  { familyId: "soap", phrases: [["soap"], ["soap", "opera"], ["telenovela"]] },
  { familyId: "talk", phrases: [["talk"], ["talk", "show"], ["talkshow"]] },
  { familyId: "war-politics", phrases: [["politics"], ["political"]] },
]

function tvOnlyFamiliesForTokens(tokens: string[]): string[] {
  const found: string[] = []
  for (const { familyId, phrases } of TV_ONLY_FAMILY_PHRASES) {
    if (phrases.some((phrase) => tokensContainPhrase(tokens, phrase))) found.push(familyId)
  }
  return found
}

/**
 * Series families implied by TMDb TV genre ids. Unlike the legacy
 * genresForTmdbIds("series", …) — which deliberately leaves 10762 /
 * 10764 / 10766 / 10767 unmapped — this mapping covers the TV-only
 * families, and maps 10762 (Kids) to "kids", NOT to "family".
 * 10763 (News) and 10770 (TV Movie) stay unmapped: no family exists
 * for them, and none is invented.
 */
export function seriesFamiliesForTmdbIds(tmdbGenreIds: number[]): string[] {
  const found = new Set<string>()
  for (const tmdbId of tmdbGenreIds || []) {
    for (const family of CANONICAL_SERIES_GENRES) {
      if (family.tmdbTvIds.includes(tmdbId)) found.add(family.id)
    }
    // Member expansion: a TV id that maps to canonical genres (e.g.
    // 10759 -> action+adventure) also implies the families owning
    // those members. 10762 is excluded here: its legacy "family"
    // mapping must not leak the Kids family into Family.
    if (tmdbId === 10762) continue
    for (const genreId of genresForTmdbIds("series", [tmdbId])) {
      for (const family of CANONICAL_SERIES_GENRES) {
        if (family.memberGenreIds.includes(genreId)) found.add(family.id)
      }
    }
  }
  return sortCanonical([...found], "series")
}

/** Series families implied by canonical GenreIds (member expansion). */
export function seriesFamiliesForGenreIds(genreIds: GenreId[]): string[] {
  const found = new Set<string>()
  for (const genreId of genreIds || []) {
    for (const family of CANONICAL_SERIES_GENRES) {
      if (family.memberGenreIds.includes(genreId)) found.add(family.id)
    }
  }
  return sortCanonical([...found], "series")
}

/** Series families implied by a genre/category string (names + TV-only phrases). */
export function parseSeriesGenreString(raw: string | null | undefined): string[] {
  if (!raw) return []
  const tokens = normalizeForMatch(raw).split(" ").filter(Boolean)
  if (!tokens.length) return []
  const viaMembers = seriesFamiliesForGenreIds(parseGenreString(raw))
  const viaTvOnly = tvOnlyFamiliesForTokens(tokens)
  return sortCanonical([...viaMembers, ...viaTvOnly], "series")
}

// Words that describe the KIND of content, never a genre. A provider
// category made only of these words ("Series", "TV Shows", "EN |
// Movies") carries no genre evidence — in particular it must never
// classify a series as Drama, or anything else.
const KIND_ONLY_TOKENS = new Set([
  "series", "show", "shows", "tv", "television", "episode", "episodes",
  "season", "seasons", "movie", "movies", "film", "films", "vod",
  "video", "ondemand", "on", "demand", "live", "channel", "channels",
])

const kindOnlyCache = new Map<string, boolean>()

/** True when a label carries kind words only and no genre evidence. Memoized like parseGenreString. */
export function isKindOnlyCategory(label: string | null | undefined): boolean {
  const key = label ?? ""
  if (key.length <= 200) {
    const hit = kindOnlyCache.get(key)
    if (hit !== undefined) return hit
  }
  const tokens = normalizeForMatch(key).split(" ").filter(Boolean)
  const result = tokens.length === 0 || tokens.every((token) => KIND_ONLY_TOKENS.has(token))
  if (key.length <= 200) {
    if (kindOnlyCache.size >= PARSE_CACHE_MAX) {
      const oldest = kindOnlyCache.keys().next().value
      if (oldest !== undefined) kindOnlyCache.delete(oldest)
    }
    kindOnlyCache.set(key, result)
  }
  return result
}

// ── genresForEntry: evidence-aware classification ────────────────────

/** Everything genresForEntry reads. Extra provider fields are ignored. */
export interface GenreEntryInput {
  /** Provider genre string ("Action, Crime") or list. */
  genre?: unknown
  genres?: unknown
  /** Canonical genre ids already resolved by the caller. */
  genreIds?: unknown
  /** Verified TMDb genre ids (numeric). Strongest evidence. */
  genre_ids?: unknown
  tmdbGenreIds?: unknown
  verifiedGenreIds?: unknown
  /** Verified genre names from enrichment (TMDb/TVDB detail payloads). */
  enrichmentGenres?: unknown
  /** Provider category label(s). Weakest evidence: fallback only. */
  category?: unknown
  category_name?: unknown
  categories?: unknown
  kind?: unknown
  type?: unknown
  mediaType?: unknown
  /** Title fields — accepted for row-shape compatibility, NEVER used to classify. */
  name?: unknown
  title?: unknown
}

export type GenreProvenance = "verified" | "provider" | "category" | "none"
export type GenreConfidence = "high" | "medium" | "low"

/**
 * The kind/index argument for genresForEntry: a CatalogIndex-like
 * object (structural — this module never imports catalog-index.ts),
 * a kind string, or null. "movie"/"vod" -> movie taxonomy,
 * "series"/"tv" -> series families. Defaults to the movie taxonomy.
 */
export type GenreIndexLike =
  | { kind?: string | null }
  | "vod"
  | "series"
  | "movie"
  | "tv"
  | null
  | undefined

export function resolveGenreKind(
  indexOrKind: GenreIndexLike,
  entry?: GenreEntryInput | null,
): "vod" | "series" {
  const fromValue = (value: unknown): "vod" | "series" | null => {
    const text = String(value ?? "").trim().toLowerCase()
    if (text === "series" || text === "tv" || text === "show") return "series"
    if (text === "vod" || text === "movie" || text === "film") return "vod"
    return null
  }
  if (typeof indexOrKind === "string") {
    const resolved = fromValue(indexOrKind)
    if (resolved) return resolved
  } else if (indexOrKind && typeof indexOrKind === "object") {
    const resolved = fromValue(indexOrKind.kind)
    if (resolved) return resolved
  }
  if (entry) {
    for (const field of [entry.kind, entry.type, entry.mediaType]) {
      const resolved = fromValue(field)
      if (resolved) return resolved
    }
  }
  return "vod"
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) out.push(...stringList(item))
    return out
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  return []
}

function numberList(value: unknown): number[] {
  if (Array.isArray(value)) {
    const out: number[] = []
    for (const item of value) {
      const n = Number(item)
      if (Number.isFinite(n) && n > 0) out.push(n)
    }
    return out
  }
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? [n] : []
}

function mapVerifiedIds(ids: number[], kind: "vod" | "series"): string[] {
  if (!ids.length) return []
  return kind === "series" ? seriesFamiliesForTmdbIds(ids) : genresForTmdbIds("vod", ids)
}

function mapGenreNames(names: string[], kind: "vod" | "series"): string[] {
  const found: string[] = []
  for (const name of names) {
    if (kind === "series") found.push(...parseSeriesGenreString(name))
    else found.push(...parseGenreString(name))
  }
  return sortCanonical(found, kind)
}

function mapCanonicalIds(ids: string[], kind: "vod" | "series"): string[] {
  const valid = ids.filter((id): id is GenreId => (GENRE_IDS as string[]).includes(id))
  if (kind === "series") {
    // Notes may already carry family ids; keep those, expand the rest.
    const direct = ids.filter((id) => SERIES_FAMILY_ORDER.has(id))
    return sortCanonical([...direct, ...seriesFamiliesForGenreIds(valid)], "series")
  }
  return sortCanonical(valid, "vod")
}

export interface GenresForEntryResult {
  genreIds: string[]
  provenance: GenreProvenance
  confidence: GenreConfidence
}

/**
 * Evidence-aware genre classification for one entry.
 *
 * Precedence (brief §5.5): validated external ids + verified metadata
 * FIRST; provider genre strings next; provider category info LAST and
 * only as a fallback. When verified evidence exists, category
 * fallback is NOT unioned on top — a verified Comedy is not also a
 * Horror because its provider shelf is labelled "Horror Movies".
 * With no verified evidence, provider + category evidence union.
 * Nothing is ever invented: no evidence -> [] (the caller buckets
 * the title under UNCATEGORISED_ID).
 */
export function genresForEntryWithEvidence(
  entry: GenreEntryInput | null | undefined,
  indexOrKind?: GenreIndexLike,
): GenresForEntryResult {
  if (!entry || typeof entry !== "object") {
    return { genreIds: [], provenance: "none", confidence: "low" }
  }
  const kind = resolveGenreKind(indexOrKind, entry)

  // Tier 1 — verified: TMDb genre ids, verified ids, enrichment names.
  const verifiedIds = [
    ...numberList(entry.genre_ids),
    ...numberList(entry.tmdbGenreIds),
    ...numberList(entry.verifiedGenreIds),
  ]
  const verifiedFromIds = mapVerifiedIds(verifiedIds, kind)
  const verifiedFromNames = mapGenreNames(stringList(entry.enrichmentGenres), kind)
  const verified = sortCanonical([...verifiedFromIds, ...verifiedFromNames], kind)
  if (verified.length) {
    return { genreIds: verified, provenance: "verified", confidence: "high" }
  }

  // Tier 2 — provider genre data (genre string/list, caller-resolved ids).
  const providerNames = [...stringList(entry.genre), ...stringList(entry.genres)]
  const providerFromNames = mapGenreNames(providerNames, kind)
  const providerFromIds = mapCanonicalIds(
    [...stringList(entry.genreIds)].flatMap((value) => value.split(/[,;/|]/)).map((v) => v.trim().toLowerCase()),
    kind,
  )
  const provider = sortCanonical([...providerFromNames, ...providerFromIds], kind)
  if (provider.length) {
    return { genreIds: provider, provenance: "provider", confidence: "medium" }
  }

  // Tier 3 — provider category fallback. Kind-only categories ("Series",
  // "TV Shows") yield nothing: never classify every series as Drama.
  const categories = [
    ...stringList(entry.category),
    ...stringList(entry.category_name),
    ...stringList(entry.categories),
  ]
  const fromCategory: string[] = []
  for (const label of categories) {
    if (isKindOnlyCategory(label)) continue
    if (kind === "series") fromCategory.push(...parseSeriesGenreString(label))
    else fromCategory.push(...parseGenreString(label))
  }
  const categorised = sortCanonical(fromCategory, kind)
  if (categorised.length) {
    return { genreIds: categorised, provenance: "category", confidence: "low" }
  }
  return { genreIds: [], provenance: "none", confidence: "low" }
}

/** Canonical genre/family ids for one entry (see genresForEntryWithEvidence for precedence). */
export function genresForEntry(
  entry: GenreEntryInput | null | undefined,
  indexOrKind?: GenreIndexLike,
): string[] {
  return genresForEntryWithEvidence(entry, indexOrKind).genreIds
}

// ── Provider categories: preserved, never rewritten ──────────────────

export interface ProviderCategoryInfo {
  /** Raw provider category id as supplied ("" when the row carries no id). */
  rawId: string
  /** Original provider label, verbatim ("" when unknown). */
  rawLabel: string
  /** Normalised label (diacritics/punctuation folded, lower-cased). */
  normalisedLabel: string
  /** Canonical GenreIds derived from the label. Kind-neutral base: series consumers map through seriesFamiliesForGenreIds. */
  derivedGenreIds: GenreId[]
  provenance: "provider-category" | "unregistered-label"
  /** Category-derived evidence is always "low" — a shelf label is weak genre evidence. */
  confidence: GenreConfidence
}

interface RegisteredCategory {
  rawId: string
  rawLabel: string
}

// Populated by catalog-index.ts during index builds (the one place that
// sees every distinct provider category). Keyed by the caller's lookup
// key — normally the catalog index's provider-category key. This is a
// pure in-memory registry: no storage, no network.
const providerCategoryRegistry = new Map<string, RegisteredCategory>()

/** Register one provider category under a lookup key (catalog-index build step). */
export function registerProviderCategory(
  lookupKey: string,
  rawId: string | number | null | undefined,
  rawLabel: string | null | undefined,
): void {
  const key = String(lookupKey ?? "").trim()
  if (!key) return
  providerCategoryRegistry.set(key, {
    rawId: rawId == null ? "" : String(rawId).trim(),
    rawLabel: (rawLabel ?? "").trim(),
  })
}

/** Clear the registry (tests / playlist switches that rebuild indexes anyway). */
export function clearProviderCategoryRegistry(): void {
  providerCategoryRegistry.clear()
}

function deriveFromLabel(label: string): GenreId[] {
  if (!label || isKindOnlyCategory(label)) return []
  return parseGenreString(label)
}

/**
 * Preserved provider-category info for a lookup key (normally a
 * catalog-index provider-category key, or a raw label/id). Registered
 * categories return their verbatim raw id + label; unregistered keys
 * are derived from the key itself as a label (provenance
 * "unregistered-label"), or — for a bare numeric id with no known
 * label — with an empty label and no derived genres. Never invents a
 * label for an unknown id.
 */
export function providerCategoryInfo(categoryId: string | number | null | undefined): ProviderCategoryInfo {
  const key = String(categoryId ?? "").trim()
  const registered = key ? providerCategoryRegistry.get(key) : undefined
  if (registered) {
    return {
      rawId: registered.rawId,
      rawLabel: registered.rawLabel,
      normalisedLabel: normalize(registered.rawLabel),
      derivedGenreIds: deriveFromLabel(registered.rawLabel),
      provenance: "provider-category",
      confidence: "low",
    }
  }
  // Catalog-index keys carry a `label:` / `id:` prefix; strip it for derivation.
  const unprefixed = key.replace(/^(label|id):/, "")
  if (/^\d+$/.test(unprefixed) && key.startsWith("id:")) {
    return {
      rawId: unprefixed,
      rawLabel: "",
      normalisedLabel: "",
      derivedGenreIds: [],
      provenance: "unregistered-label",
      confidence: "low",
    }
  }
  const label = key.startsWith("label:") ? unprefixed : key
  return {
    rawId: /^\d+$/.test(key) ? key : "",
    rawLabel: label,
    normalisedLabel: normalize(label),
    derivedGenreIds: deriveFromLabel(label),
    provenance: "unregistered-label",
    confidence: "low",
  }
}
