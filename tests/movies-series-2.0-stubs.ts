// 0.11.8 TEST STUB — replaced by the real module at integration.
//
// Movies & Series 2.0 (0.11.8, W5) contract stubs. The production
// modules under test do not exist on the 0.11.7 base (W1–W4 build in
// parallel), so this file implements the FROZEN contract APIs named
// in the brief faithfully: replace semantics, safe grouping rules,
// rating-evidence rules, pagination math, the focus model, and the
// mode/URL contract. These are correct implementations of the
// CONTRACT, not mocks returning canned answers: every function below
// computes its result from its inputs. Integration DELETES this file
// and re-runs the acceptance tests against the real W1/W2 modules —
// the stub → real-module mapping (file paths + export names) lives in
// tests/movies-series-2.0-contract-map.md.
//
// Where the base already has the real semantics, the stub DELEGATES
// to it instead of re-implementing: genre taxonomy (genres.ts),
// text normalisation (text.ts), year/runtime parsing + rating/runtime
// matching (browse-filters.ts), and the resume threshold
// (couch-movies.ts RESUME_MIN_SECONDS). Anything the contract leaves
// silent is decided here, documented inline, and flagged in the
// contract map for W1/W2 to confirm or correct.
//
// Hermetic: no network, no provider calls, no storage writes except
// the focus-memory helpers the real couch-focus.ts already owns
// (tests stub storage themselves). DOM helpers throw outside a DOM.

import { normalize } from "@/scripts/lib/text.ts"
import {
  CANONICAL_GENRES,
  parseGenreString,
  genreForCategoryName,
  genresForTmdbIds,
  type GenreId,
} from "@/scripts/lib/genres.ts"
import {
  parseYear,
  parseRuntimeMinutes,
  decadeKeyForYear,
  type BrowseSortId,
} from "@/scripts/lib/browse-filters.ts"
import { RESUME_MIN_SECONDS } from "@/scripts/movies/couch-movies.ts"

// ---------------------------------------------------------------------------
// Entry model (contract-side view of a catalogue row)
// ---------------------------------------------------------------------------

/** Catalogue kind. The repo convention is "vod" | "series"; "movie" is
 *  accepted as an alias for "vod" so tests survive whichever spelling
 *  W1 freezes. */
export type CatalogKindInput = "vod" | "series" | "movie"
export type CatalogKind = "vod" | "series"

export function normaliseKind(kind: CatalogKindInput): CatalogKind {
  if (kind === "movie") return "vod"
  if (kind === "vod" || kind === "series") return kind
  throw new Error(`Unknown catalogue kind: ${String(kind)}`)
}

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
 * One catalogue entry as the 0.11.8 contracts read it. Test fixtures
 * build these from REAL provider rows via mapMovieRow / mapSeriesRow
 * (see tests/fixtures-0118-catalogue.ts); the fields below that the
 * base mappers do not produce (tmdbGenreIds, genreString, seasons,
 * episodes, variant signals, ratingScale) are the contract
 * enrichments W1 owns. Unknown metadata stays unknown: "" / null /
 * 0, never a fabricated value.
 */
export interface CatalogEntry {
  id: number
  kind: CatalogKind
  /** Provider name, verbatim (whitespace trimmed by the mappers). */
  name: string
  /** Display title: the provider name with variant suffixes stripped
   *  for grouping purposes is baseTitle; displayTitle is the name as
   *  shown (trimmed, single-spaced). */
  displayTitle: string
  /** Normalised base title used ONLY for grouping: variant suffixes
   *  stripped, then the shared `normalize` applied. */
  baseTitle: string
  year: string
  yearNum: number | null
  /** Provider rating string verbatim ("" = unknown). */
  ratingRaw: string
  /** Scale the provider rating was supplied on. 5-based provider
   *  ratings (rating_5based) must be doubled, never read as /10. */
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
  /** Confirmed season count, or null when the provider did not
   *  confirm it. NEVER fabricated. Movies: always null. */
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
// Genre constants (W1 contract)
// ---------------------------------------------------------------------------

/**
 * Canonical genre ids per kind. Both kinds share the 18-id taxonomy
 * from the real CANONICAL_GENRES (the kinds differ in their TMDb id
 * mappings, not in membership — a Horror series is still Horror).
 * Tests derive expectations from these constants, never from a
 * hardcoded count, so a W1 decision to narrow one list keeps the
 * tests meaningful.
 */
export const CANONICAL_MOVIE_GENRES: GenreId[] = CANONICAL_GENRES.map(
  (g) => g.id
)
export const CANONICAL_SERIES_GENRES: GenreId[] = CANONICAL_GENRES.map(
  (g) => g.id
)

export const UNCATEGORISED_ID = "uncategorised"
export const ALL_CATEGORIES_ID = "all"
export const DEFAULT_PAGE_SIZE = 60
/** Grid columns the stub mount lays out (fixed: the contract pins a
 *  stable column count so arrow-key movement is deterministic). */
export const BROWSE_GRID_COLUMNS = 6

export const BROWSE_SORT_IDS: BrowseSortId[] = [
  "default",
  "added",
  "rating",
  "year-desc",
  "year-asc",
  "az",
  "runtime-asc",
  "runtime-desc",
]

// ---------------------------------------------------------------------------
// Instrumentation counters (brief §15 — the harness reads these)
// ---------------------------------------------------------------------------

let catalogIndexBuilds = 0
let browseFullPasses = 0
let browseSorts = 0
let browseGroupRuns = 0
let browseDerivations = 0
let browseCacheHits = 0
let browsePageTurns = 0
let browseFocusMoves = 0

export function catalogIndexBuildCount(): number {
  return catalogIndexBuilds
}
export function resetCatalogIndexCounters(): void {
  catalogIndexBuilds = 0
}
export function resetCatalogIndexCache(): void {
  catalogIndexCache.clear()
}

export interface BrowseInstrumentation {
  derivations: number
  fullPasses: number
  sorts: number
  groupRuns: number
  cacheHits: number
  pageTurns: number
  focusMoves: number
}

export function getBrowseInstrumentation(): BrowseInstrumentation {
  return {
    derivations: browseDerivations,
    fullPasses: browseFullPasses,
    sorts: browseSorts,
    groupRuns: browseGroupRuns,
    cacheHits: browseCacheHits,
    pageTurns: browsePageTurns,
    focusMoves: browseFocusMoves,
  }
}

export function resetBrowseInstrumentation(): void {
  browseFullPasses = 0
  browseSorts = 0
  browseGroupRuns = 0
  browseDerivations = 0
  browseCacheHits = 0
  browsePageTurns = 0
  browseFocusMoves = 0
  derivationCache.clear()
}

// ---------------------------------------------------------------------------
// Rating evidence (W1 contract)
// ---------------------------------------------------------------------------

export interface RatingEvidence {
  /** Rating on the 0–10 scale, or null when there is no evidence. */
  value: number | null
  hasEvidence: boolean
  source: "provider" | "none"
}

/**
 * Parse a provider rating into evidence. "" / "0" / "N/A" / unparseable
 * / out-of-range values are UNKNOWN (null) — never 0-as-a-rating and
 * never a pass for a minimum-rating filter. A 5-based rating is
 * doubled onto the 0–10 scale.
 */
export function normaliseRating(entry: {
  ratingRaw: unknown
  ratingScale?: unknown
}): RatingEvidence {
  const raw = String(entry.ratingRaw ?? "").trim()
  if (!raw) return { value: null, hasEvidence: false, source: "none" }
  const parsed = parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { value: null, hasEvidence: false, source: "none" }
  }
  const scaled = entry.ratingScale === 5 ? parsed * 2 : parsed
  if (scaled <= 0 || scaled > 10) {
    return { value: null, hasEvidence: false, source: "none" }
  }
  return { value: scaled, hasEvidence: true, source: "provider" }
}

/** Runtime in whole minutes, or null when the provider supplied
 *  nothing parseable. Delegates to the real parseRuntimeMinutes. */
export function runtimeMinutesOf(entry: {
  durationRaw: unknown
}): number | null {
  return parseRuntimeMinutes(entry.durationRaw)
}

/**
 * Rating-evidence comparator: rated entries before unrated, higher
 * rating first, then title A–Z, then id. A TOTAL order: deterministic
 * for any pair, so sorted shelves never shuffle between renders.
 */
export function compareByRatingEvidence(
  a: CatalogEntry,
  b: CatalogEntry
): number {
  const ra = normaliseRating(a)
  const rb = normaliseRating(b)
  if (ra.hasEvidence !== rb.hasEvidence) return ra.hasEvidence ? -1 : 1
  if (ra.hasEvidence && rb.hasEvidence && ra.value !== rb.value) {
    return (rb.value as number) - (ra.value as number)
  }
  const title = a.displayTitle.localeCompare(b.displayTitle, "en", {
    sensitivity: "base",
  })
  if (title !== 0) return title
  return a.id - b.id
}

// Decorated sorts for the selectors below: rating evidence + a
// lowercased title key computed ONCE per entry, so a 50k shelf
// composition does not re-parse ratings and re-run localeCompare on
// every comparison (that costs seconds: ratings tie constantly at
// one decimal place). Order-equivalent to the pairwise comparators
// above on the fixture alphabet (ASCII titles); the pairwise
// comparators stay the contract definition, and W1 may use
// localeCompare/ICU collation in production.
function titleKeyOf(entry: CatalogEntry): string {
  return entry.displayTitle.toLowerCase()
}

function compareTitleKeys(a: CatalogEntry, b: CatalogEntry): number {
  const ka = titleKeyOf(a)
  const kb = titleKeyOf(b)
  if (ka !== kb) return ka < kb ? -1 : 1
  return a.id - b.id
}

/** Rating desc, then added desc, then title, then id. */
function sortByRatingThenAdded(entries: CatalogEntry[]): CatalogEntry[] {
  const decorated = entries.map((entry) => ({
    entry,
    rating: normaliseRating(entry).value,
    titleKey: titleKeyOf(entry),
  }))
  decorated.sort((a, b) => {
    const ra = a.rating
    const rb = b.rating
    if ((ra == null) !== (rb == null)) return ra == null ? 1 : -1
    if (ra != null && rb != null && ra !== rb) return rb - ra
    if (a.entry.added !== b.entry.added) return b.entry.added - a.entry.added
    if (a.titleKey !== b.titleKey) return a.titleKey < b.titleKey ? -1 : 1
    return a.entry.id - b.entry.id
  })
  return decorated.map((d) => d.entry)
}

/** Added desc, then title, then id. */
function sortByAddedDesc(entries: CatalogEntry[]): CatalogEntry[] {
  const decorated = entries.map((entry) => ({
    entry,
    titleKey: titleKeyOf(entry),
  }))
  decorated.sort((a, b) => {
    if (a.entry.added !== b.entry.added) return b.entry.added - a.entry.added
    if (a.titleKey !== b.titleKey) return a.titleKey < b.titleKey ? -1 : 1
    return a.entry.id - b.entry.id
  })
  return decorated.map((d) => d.entry)
}

// ---------------------------------------------------------------------------
// Genres for an entry (W1 contract)
// ---------------------------------------------------------------------------

/**
 * Canonical genres for an entry, from every evidence source the
 * provider gives: TMDb genre ids, a raw genre string, and the
 * provider category name. Union, deduplicated, in canonical order.
 * No evidence → [] — genres are never guessed from the title.
 * `index` is accepted for signature compatibility with the frozen
 * contract; genre resolution needs no index state.
 */
export function genresForEntry(
  entry: CatalogEntry,
  _index?: CatalogIndex | null
): GenreId[] {
  const found = new Set<GenreId>()
  for (const id of genresForTmdbIds(entry.kind, entry.tmdbGenreIds || [])) {
    found.add(id)
  }
  for (const id of parseGenreString(entry.genreString || null)) {
    found.add(id)
  }
  for (const id of genreForCategoryName(entry.categoryName || null)) {
    found.add(id)
  }
  const order = entry.kind === "vod" ? CANONICAL_MOVIE_GENRES : CANONICAL_SERIES_GENRES
  return order.filter((id) => found.has(id))
}

// ---------------------------------------------------------------------------
// Catalogue index (W1 contract) — built ONCE per revision, cached
// ---------------------------------------------------------------------------

export interface CatalogCategory {
  id: string
  /** Display label: the raw provider name trimmed, or "Uncategorised". */
  label: string
  /** Provider category string verbatim ("" for uncategorised). */
  rawName: string
  count: number
  /** Entry indexes into index.entries, in catalogue order. */
  indexes: number[]
}

export interface CatalogIndex {
  kind: CatalogKind
  revision: number
  entries: CatalogEntry[]
  byId: Map<number, CatalogEntry>
  /** Provider categories in first-seen order; uncategorised last
   *  (only when non-empty). Duplicate display labels stay DISTINCT
   *  categories with distinct ids. */
  categories: CatalogCategory[]
  /** Canonical genre id → entry indexes. */
  genreMembers: Map<string, number[]>
  /** Global build-counter value stamped at build time. */
  buildCount: number
  /** Full catalogue passes used to build (always 1). */
  fullPasses: number
}

const catalogIndexCache = new Map<string, CatalogIndex>()

function slugifyCategory(raw: string): string {
  const slug = normalize(raw)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "category"
}

export function buildCatalogIndex(
  kind: CatalogKindInput,
  catalogue: CatalogEntry[],
  revision: number
): CatalogIndex {
  const normKind = normaliseKind(kind)
  catalogIndexBuilds += 1
  const entries = [...catalogue]
  const byId = new Map<number, CatalogEntry>()
  const categoryByRaw = new Map<string, CatalogCategory>()
  const usedIds = new Set<string>([UNCATEGORISED_ID, ALL_CATEGORIES_ID])
  const categories: CatalogCategory[] = []
  const genreMembers = new Map<string, number[]>()
  // ONE full pass: ids, categories, genres.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    byId.set(entry.id, entry)
    const rawName = (entry.categoryName || "").trim()
    if (!rawName) {
      let unc = categoryByRaw.get("")
      if (!unc) {
        unc = {
          id: UNCATEGORISED_ID,
          label: "Uncategorised",
          rawName: "",
          count: 0,
          indexes: [],
        }
        categoryByRaw.set("", unc)
        categories.push(unc)
      }
      unc.indexes.push(i)
      unc.count += 1
    } else {
      let cat = categoryByRaw.get(rawName)
      if (!cat) {
        const base = `cat:${slugifyCategory(rawName)}`
        let id = base
        let n = 2
        while (usedIds.has(id)) id = `${base}-${n++}`
        usedIds.add(id)
        cat = { id, label: rawName, rawName, count: 0, indexes: [] }
        categoryByRaw.set(rawName, cat)
        categories.push(cat)
      }
      cat.indexes.push(i)
      cat.count += 1
    }
    for (const genre of genresForEntry(entry)) {
      const list = genreMembers.get(genre) ?? []
      list.push(i)
      genreMembers.set(genre, list)
    }
  }
  // Uncategorised sorts last; provider categories keep first-seen order.
  categories.sort((a, b) => {
    if (a.id === UNCATEGORISED_ID) return 1
    if (b.id === UNCATEGORISED_ID) return -1
    return 0
  })
  return {
    kind: normKind,
    revision,
    entries,
    byId,
    categories,
    genreMembers,
    buildCount: catalogIndexBuilds,
    fullPasses: 1,
  }
}

/**
 * Cached index: the same (kind, revision) returns the SAME object —
 * callers bump the revision whenever catalogue content changes (new
 * load, provider category rename, id remap). Mirrors the Live TV
 * category-index caching contract.
 */
export function getCatalogIndex(
  kind: CatalogKindInput,
  catalogue: CatalogEntry[],
  revision: number
): CatalogIndex {
  const key = `${normaliseKind(kind)}:${revision}`
  const cached = catalogIndexCache.get(key)
  if (cached) return cached
  const built = buildCatalogIndex(kind, catalogue, revision)
  catalogIndexCache.set(key, built)
  return built
}

export type SearchScope = "all" | { categoryId: string }

/**
 * Token search over the index. Every query token must appear in the
 * entry's normalised haystack (name + category + year). Scope "all"
 * searches the whole catalogue; { categoryId } restricts to that
 * category (UNCATEGORISED_ID included). Results keep catalogue order.
 * An empty query returns the whole scope.
 */
export function searchCatalogIndex(
  index: CatalogIndex,
  query: string,
  scope: SearchScope = "all"
): CatalogEntry[] {
  const tokens = normalize(query).split(" ").filter(Boolean)
  let indexes: number[]
  if (scope === "all") {
    indexes = index.entries.map((_, i) => i)
  } else {
    const cat = index.categories.find((c) => c.id === scope.categoryId)
    indexes = cat ? [...cat.indexes] : []
  }
  if (tokens.length === 0) return indexes.map((i) => index.entries[i])
  const out: CatalogEntry[] = []
  for (const i of indexes) {
    const entry = index.entries[i]
    const hay = normalize(
      `${entry.name} ${entry.categoryName} ${entry.year}`
    )
    if (tokens.every((t) => hay.includes(t))) out.push(entry)
  }
  return out
}

// ---------------------------------------------------------------------------
// Safe grouping (W1 contract)
// ---------------------------------------------------------------------------

/**
 * Recognised provider variant suffixes. ONLY these (trailing, after
 * the base title) mark two rows as variants of one title. Anything
 * else — "Part 2", a year, a different word — is a different title.
 * Matching is case-insensitive and repeatable (several suffixes may
 * stack: "Title 1080p HINDI").
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

/** Strip trailing recognised variant suffixes from a raw title. */
export function stripVariantSuffix(name: string): string {
  let title = String(name || "").trim().replace(/\s+/g, " ")
  for (;;) {
    const before = title
    // Trailing bracketed tag whose content is all variant tokens.
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
    // Trailing bare token(s), e.g. "Title 1080p HINDI" / "Title - FHD".
    const tokenMatch = title.match(/[-–—:]?\s*([A-Za-z0-9+]+)\s*$/)
    if (tokenMatch) {
      const token = tokenMatch[1].toLowerCase()
      // "dual audio" is two tokens; "audio" alone also strips, then
      // "dual" strips on the next pass — same result.
      if (VARIANT_TOKENS.has(token)) {
        title = title.slice(0, tokenMatch.index).trim()
        continue
      }
    }
    if (title === before) break
  }
  return title.replace(/[-–—:,\s]+$/, "").trim()
}

/** Normalised base title for grouping (suffix-stripped + normalize). */
export function baseTitleOf(name: string): string {
  return normalize(stripVariantSuffix(name))
}

/**
 * Do two raw names differ ONLY by recognised variant suffixes?
 * Same base title, different raw normalised names, and every
 * differing trailing token is a variant token.
 */
export function differsOnlyByVariantSuffix(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return false
  if (baseTitleOf(a) !== baseTitleOf(b)) return false
  return true
}

export interface EntryGroup {
  key: string
  kind: CatalogKind
  baseTitle: string
  /** Known year shared by the group, or null when unknown. */
  year: number | null
  representative: CatalogEntry
  /** All variants, catalogue order. */
  variants: CatalogEntry[]
}

function pickRepresentative(variants: CatalogEntry[]): CatalogEntry {
  return [...variants].sort((a, b) => {
    const posterA = a.poster ? 0 : 1
    const posterB = b.poster ? 0 : 1
    if (posterA !== posterB) return posterA - posterB
    const byRating = compareByRatingEvidence(a, b)
    if (byRating !== 0) return byRating
    return a.id - b.id
  })[0]
}

/**
 * Group provider variants safely. Merge rules (ALL must hold):
 *   1. Same kind (a movie never groups with a series).
 *   2. Same base title (suffix-stripped, normalised).
 *   3. Years: both known → must be EQUAL. Either unknown → merge
 *      ONLY when the raw names differ solely by a recognised
 *      variant suffix (an unknown-year remake must never be
 *      swallowed into another film's group).
 * Groups keep first-seen order; the representative prefers a poster,
 * then rating evidence, then the lowest id. Singletons are groups of
 * one, so callers never special-case.
 */
export function groupEntries(
  entries: CatalogEntry[],
  _index?: CatalogIndex | null
): EntryGroup[] {
  browseGroupRuns += 1
  const groups: EntryGroup[] = []
  // Keyed by kind + base title: candidates for a merge are only the
  // groups sharing the entry's base title (usually one — the same
  // title in different years). A linear scan over ALL groups here is
  // O(n × groups) and takes minutes on a 50k catalogue; the keyed
  // lookup is O(n) with identical results, because a group whose
  // base title differs can never match.
  const byBase = new Map<string, EntryGroup[]>()
  for (const entry of entries) {
    const baseKey = `${entry.kind}|${entry.baseTitle}`
    const candidates = byBase.get(baseKey)
    let target: EntryGroup | null = null
    if (candidates) {
      for (const group of candidates) {
        const groupYear = group.year
        const entryYear = entry.yearNum
        if (groupYear != null && entryYear != null) {
          if (groupYear !== entryYear) continue
        } else {
          // Unknown year on either side: suffix-only difference required.
          const differs = group.variants.some((v) =>
            differsOnlyByVariantSuffix(v.name, entry.name)
          )
          if (!differs) continue
        }
        target = group
        break
      }
    }
    if (!target) {
      const group: EntryGroup = {
        key: "",
        kind: entry.kind,
        baseTitle: entry.baseTitle,
        year: entry.yearNum,
        representative: entry,
        variants: [entry],
      }
      groups.push(group)
      if (candidates) candidates.push(group)
      else byBase.set(baseKey, [group])
    } else {
      target.variants.push(entry)
      if (target.year == null) target.year = entry.yearNum
    }
  }
  // Stable keys: kind + base + year, disambiguated in first-seen order.
  const used = new Map<string, number>()
  for (const group of groups) {
    const base = `${group.kind}|${group.baseTitle}|${group.year ?? "unknown"}`
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    group.key = n === 1 ? base : `${base}#${n}`
    group.representative = pickRepresentative(group.variants)
  }
  return groups
}

// ---------------------------------------------------------------------------
// Home selectors (W1 contract)
// ---------------------------------------------------------------------------

export interface SelectorOptions {
  limit?: number
  excludeIds?: Iterable<number>
  progress?: ProgressMap
  /** Followed series ids, read from the REAL followed store
   *  (listSubscriptions). The home shelf never invents follows. */
  followedIds?: Iterable<number>
}

function excludedSet(opts?: SelectorOptions): Set<number> {
  return new Set(opts?.excludeIds ?? [])
}

/**
 * Featured film: the best-evidenced film with a poster. Fallback
 * chain (deterministic): poster + rated → rated → poster → first
 * entry. Never an unrated, posterless pick while better evidence
 * exists. Null on an empty catalogue.
 */
export function selectFeaturedFilm(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry | null {
  const excluded = excludedSet(opts)
  const pool = index.entries.filter(
    (e) => e.kind === "vod" && !excluded.has(e.id)
  )
  if (pool.length === 0) return null
  const posterRated = pool.filter(
    (e) => e.poster && normaliseRating(e).hasEvidence
  )
  if (posterRated.length > 0) {
    return sortByRatingThenAdded(posterRated)[0]
  }
  const rated = pool.filter((e) => normaliseRating(e).hasEvidence)
  if (rated.length > 0) {
    return sortByRatingThenAdded(rated)[0]
  }
  const poster = pool.filter((e) => e.poster)
  if (poster.length > 0) return sortByAddedDesc(poster)[0]
  return sortByAddedDesc(pool)[0]
}

/**
 * Worth Watching: rated 8+ ONLY (unknown ratings never qualify),
 * ordered by rating evidence, then most-recently-added, then title.
 * Deliberately NOT the first N rating-8 titles in catalogue order:
 * a 9.6 added last week outranks an 8.0 that has sat in the
 * catalogue for years.
 */
export function selectWorthWatching(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry[] {
  const limit = opts?.limit ?? 12
  const excluded = excludedSet(opts)
  const qualified = index.entries.filter((e) => {
    if (e.kind !== "vod" || excluded.has(e.id)) return false
    const r = normaliseRating(e)
    return r.hasEvidence && (r.value as number) >= 8
  })
  return sortByRatingThenAdded(qualified).slice(0, limit)
}

/**
 * Recently Added: provider `added` timestamp, newest first — NOT
 * release year. Entries with unknown `added` (0) sort LAST, never
 * first. Deterministic ties by title, then id.
 */
export function selectRecentlyAdded(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry[] {
  const limit = opts?.limit ?? 12
  const excluded = excludedSet(opts)
  const pool = index.entries.filter(
    (e) => e.kind === index.kind && !excluded.has(e.id)
  )
  const known = sortByAddedDesc(pool.filter((e) => e.added > 0))
  const unknown = pool
    .filter((e) => e.added <= 0)
    .sort(compareTitleKeys)
  return [...known, ...unknown].slice(0, limit)
}

/**
 * Hidden Gems: rated 7.5+, ordered by rating evidence, then OLDEST
 * added first (buried treasure, not the new releases), excluding the
 * featured film. Unknown ratings never qualify; unknown `added`
 * sorts after known-oldest.
 */
export function selectHiddenGems(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry[] {
  const limit = opts?.limit ?? 12
  const excluded = excludedSet(opts)
  const featured = selectFeaturedFilm(index, opts)
  if (featured) excluded.add(featured.id)
  const qualified = index.entries.filter((e) => {
    if (e.kind !== "vod" || excluded.has(e.id)) return false
    const r = normaliseRating(e)
    return r.hasEvidence && (r.value as number) >= 7.5
  })
  const decorated = qualified.map((entry) => ({
    entry,
    rating: normaliseRating(entry).value as number,
    titleKey: titleKeyOf(entry),
  }))
  decorated.sort((a, b) => {
    if (a.rating !== b.rating) return b.rating - a.rating
    const aAdded = a.entry.added > 0 ? a.entry.added : Number.POSITIVE_INFINITY
    const bAdded = b.entry.added > 0 ? b.entry.added : Number.POSITIVE_INFINITY
    if (aAdded !== bAdded) return aAdded - bAdded
    if (a.titleKey !== b.titleKey) return a.titleKey < b.titleKey ? -1 : 1
    return a.entry.id - b.entry.id
  })
  return decorated.map((d) => d.entry).slice(0, limit)
}

/**
 * Series Worth Starting: SERIES-level entries only (one row per
 * series, never episode rows), rated 7+, ordered by rating evidence.
 * A series with a CONFIRMED zero episode count is excluded (nothing
 * to start); an unknown episode count is not held against it.
 */
export function selectSeriesWorthStarting(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry[] {
  const limit = opts?.limit ?? 12
  const excluded = excludedSet(opts)
  const qualified = index.entries.filter((e) => {
    if (e.kind !== "series" || excluded.has(e.id)) return false
    if (e.episodeCount === 0) return false
    const r = normaliseRating(e)
    return r.hasEvidence && (r.value as number) >= 7
  })
  return sortByRatingThenAdded(qualified).slice(0, limit)
}

/**
 * Continue Watching: in-progress ONLY. Included: position past the
 * resume threshold, not completed, and not played to the end.
 * Excluded: completed, untouched (no progress or position at/below
 * the threshold), and played-to-the-end. Ordered by most recently
 * touched. Uses the REAL resume threshold (RESUME_MIN_SECONDS).
 */
export function selectContinueWatching(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry[] {
  const limit = opts?.limit ?? 20
  const excluded = excludedSet(opts)
  const progress = opts?.progress
  if (!progress) return []
  const scored: Array<{ entry: CatalogEntry; at: number }> = []
  for (const entry of index.entries) {
    if (excluded.has(entry.id)) continue
    const p = progressOf(progress, entry.id)
    if (!p || p.completed) continue
    if ((p.position || 0) <= RESUME_MIN_SECONDS) continue
    if (p.duration > 0 && p.position >= p.duration) continue
    scored.push({ entry, at: p.updatedAt || 0 })
  }
  scored.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at
    const t = a.entry.displayTitle.localeCompare(b.entry.displayTitle, "en", {
      sensitivity: "base",
    })
    return t !== 0 ? t : a.entry.id - b.entry.id
  })
  return scored.map((s) => s.entry).slice(0, limit)
}

export interface HomeShelves {
  featured: CatalogEntry | null
  continueWatching: CatalogEntry[]
  worthWatching: CatalogEntry[]
  recentlyAdded: CatalogEntry[]
  hiddenGems: CatalogEntry[]
  seriesWorthStarting: CatalogEntry[]
  /** Followed series, from the real subscription store (title order,
   *  matching listSubscriptions). Movies home: always []. */
  followedSeries: CatalogEntry[]
  /** Populated canonical genres (count > 0), most-populated first. */
  genreTiles: Array<{ id: GenreId; count: number }>
  /** Hard bound on home cards: shelves + genre tiles, never the catalogue. */
  totalCards: number
}

/** Compose every home shelf from one index (W3/W4 home adapters
 *  consume these selectors; the home mount renders ONLY this). */
export function selectHomeShelves(
  index: CatalogIndex,
  opts?: SelectorOptions
): HomeShelves {
  const featured =
    index.kind === "vod" ? selectFeaturedFilm(index, opts) : null
  const continueWatching = selectContinueWatching(index, opts)
  const worthWatching =
    index.kind === "vod" ? selectWorthWatching(index, opts) : []
  const recentlyAdded = selectRecentlyAdded(index, opts)
  const hiddenGems =
    index.kind === "vod" ? selectHiddenGems(index, opts) : []
  const seriesWorthStarting =
    index.kind === "series" ? selectSeriesWorthStarting(index, opts) : []
  const followedIds = new Set(opts?.followedIds ?? [])
  const followedSeries =
    index.kind === "series"
      ? index.entries
          .filter((e) => followedIds.has(e.id))
          .sort((a, b) =>
            a.displayTitle.localeCompare(b.displayTitle, "en", {
              sensitivity: "base",
            })
          )
      : []
  const genreTiles = (
    index.kind === "vod" ? CANONICAL_MOVIE_GENRES : CANONICAL_SERIES_GENRES
  )
    .map((id) => ({ id, count: index.genreMembers.get(id)?.length ?? 0 }))
    .filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  const totalCards =
    (featured ? 1 : 0) +
    continueWatching.length +
    worthWatching.length +
    recentlyAdded.length +
    hiddenGems.length +
    seriesWorthStarting.length +
    followedSeries.length +
    genreTiles.length
  return {
    featured,
    continueWatching,
    worthWatching,
    recentlyAdded,
    hiddenGems,
    seriesWorthStarting,
    followedSeries,
    genreTiles,
    totalCards,
  }
}

// ---------------------------------------------------------------------------
// Browse Everything state (W2 contract) — pure transitions, no mutation
// ---------------------------------------------------------------------------

export interface BrowseState {
  kind: CatalogKind
  /** Provider category id, ALL_CATEGORIES_ID, or UNCATEGORISED_ID. */
  categoryId: string
  /** Single canonical genre id, or "" for any. REPLACE, never accumulate. */
  genre: string
  query: string
  /** "all" = search the whole catalogue; "category" = search within
   *  the selected category only. */
  searchScope: "all" | "category"
  sort: BrowseSortId
  page: number
  pageSize: number
  /** Minimum rating 0–10. 0 = any. Unknown ratings never pass > 0. */
  minRating: number
  /** Maximum runtime in minutes. 0 = any. Unknown runtimes never pass > 0. */
  maxRuntime: number
  /** Decade key ("2020s", "older", …). "" = any. */
  decade: string
  hideWatched: boolean
}

export function createBrowseState(
  kind: CatalogKindInput,
  opts?: { pageSize?: number }
): BrowseState {
  return {
    kind: normaliseKind(kind),
    categoryId: ALL_CATEGORIES_ID,
    genre: "",
    query: "",
    searchScope: "all",
    sort: "default",
    page: 0,
    pageSize: opts?.pageSize ?? DEFAULT_PAGE_SIZE,
    minRating: 0,
    maxRuntime: 0,
    decade: "",
    hideWatched: false,
  }
}

/** Is this state the unfiltered default (nothing hidden)? */
export function isDefaultBrowseState(state: BrowseState): boolean {
  return (
    state.categoryId === ALL_CATEGORIES_ID &&
    !state.genre &&
    !state.query &&
    state.searchScope === "all" &&
    state.sort === "default" &&
    state.minRating === 0 &&
    state.maxRuntime === 0 &&
    !state.decade &&
    !state.hideWatched
  )
}

/** Select a provider category (REPLACES the previous one) and reset
 *  pagination. Other filters are preserved: they are separate,
 *  visible constraints (see activeFilterSummary). */
export function selectCategory(
  state: BrowseState,
  categoryId: string
): BrowseState {
  return { ...state, categoryId, page: 0 }
}

export interface BrowseFilterPatch {
  genre?: string | null
  minRating?: number
  maxRuntime?: number
  decade?: string | null
  hideWatched?: boolean
  sort?: BrowseSortId
  query?: string
  searchScope?: "all" | "category"
}

/**
 * Apply filter changes. Every field REPLACES its previous value —
 * selecting Horror after Comedy yields Horror, never Comedy AND
 * Horror. There is deliberately no multi-genre accumulation. Any
 * change resets pagination to page 0.
 */
export function applyFilters(
  state: BrowseState,
  patch: BrowseFilterPatch
): BrowseState {
  const next: BrowseState = { ...state }
  if (patch.genre !== undefined) next.genre = patch.genre ?? ""
  if (patch.minRating !== undefined) next.minRating = patch.minRating
  if (patch.maxRuntime !== undefined) next.maxRuntime = patch.maxRuntime
  if (patch.decade !== undefined) next.decade = patch.decade ?? ""
  if (patch.hideWatched !== undefined) next.hideWatched = patch.hideWatched
  if (patch.sort !== undefined) next.sort = patch.sort
  if (patch.query !== undefined) next.query = patch.query
  if (patch.searchScope !== undefined) next.searchScope = patch.searchScope
  next.page = 0
  return next
}

/** Fresh default state for the kind (same pageSize). Removes EVERY
 *  constraint, including hidden ones: category, genre, query, scope,
 *  sort, rating, runtime, decade, hide-watched, and page. */
export function resetAllFilters(state: BrowseState): BrowseState {
  return createBrowseState(state.kind, { pageSize: state.pageSize })
}

export interface FilterSummaryItem {
  key: string
  label: string
}

/**
 * Every active constraint, in UI order, as the user must see it.
 * Empty ⟺ default state. Nothing filters silently: if a constraint
 * affects results, it appears here.
 */
export function activeFilterSummary(state: BrowseState): FilterSummaryItem[] {
  const out: FilterSummaryItem[] = []
  if (state.categoryId !== ALL_CATEGORIES_ID) {
    out.push({
      key: "category",
      label:
        state.categoryId === UNCATEGORISED_ID
          ? "Category: Uncategorised"
          : `Category: ${state.categoryId}`,
    })
  }
  if (state.genre) out.push({ key: "genre", label: `Genre: ${state.genre}` })
  if (state.query) {
    out.push({
      key: "query",
      label:
        state.searchScope === "category"
          ? `Search in current category: "${state.query}"`
          : `Search all: "${state.query}"`,
    })
  }
  if (state.minRating > 0) {
    out.push({ key: "minRating", label: `Rating ${state.minRating}+` })
  }
  if (state.maxRuntime > 0) {
    out.push({ key: "maxRuntime", label: `Under ${state.maxRuntime} min` })
  }
  if (state.decade) out.push({ key: "decade", label: `Decade: ${state.decade}` })
  if (state.hideWatched) out.push({ key: "hideWatched", label: "Hide watched" })
  if (state.sort !== "default") {
    out.push({ key: "sort", label: `Sort: ${state.sort}` })
  }
  return out
}

export function pageCountFor(totalGroups: number, pageSize: number): number {
  if (totalGroups <= 0) return 0
  return Math.ceil(totalGroups / Math.max(1, pageSize))
}

/** Set the page, clamped to the valid range for `totalGroups`.
 *  Out-of-range requests clamp, never produce an empty phantom page. */
export function setPage(
  state: BrowseState,
  page: number,
  totalGroups: number
): BrowseState {
  const pages = pageCountFor(totalGroups, state.pageSize)
  const clamped = pages === 0 ? 0 : Math.max(0, Math.min(Math.floor(page), pages - 1))
  return { ...state, page: clamped }
}

export function setSearch(
  state: BrowseState,
  query: string,
  scope?: "all" | "category"
): BrowseState {
  return {
    ...state,
    query,
    searchScope: scope ?? state.searchScope,
    page: 0,
  }
}

export function setSort(state: BrowseState, sort: BrowseSortId): BrowseState {
  const valid = (BROWSE_SORT_IDS as string[]).includes(sort)
  return { ...state, sort: valid ? sort : "default", page: 0 }
}

// ---------------------------------------------------------------------------
// Browse derivation — one full pass per NEW constraint set, cached per page
// ---------------------------------------------------------------------------

export interface BrowseDerivation {
  /** Groups matching the constraints (all pages). */
  matchedGroups: EntryGroup[]
  /** Groups on the current page. */
  groups: EntryGroup[]
  totalGroups: number
  totalEntries: number
  pageCount: number
  page: number
  pageSize: number
  state: BrowseState
}

const derivationCache = new Map<string, EntryGroup[]>()

function stateSignature(state: BrowseState): string {
  return [
    state.kind,
    state.categoryId,
    state.genre,
    state.query,
    state.searchScope,
    state.sort,
    state.minRating,
    state.maxRuntime,
    state.decade,
    state.hideWatched,
  ].join("|")
}

function sortMatched(
  entries: CatalogEntry[],
  sort: BrowseSortId
): CatalogEntry[] {
  if (sort === "default") return entries
  browseSorts += 1
  // Decorated: sort keys computed once per entry (see the selector
  // sorts above — re-running localeCompare per comparison costs
  // seconds on large catalogues). Order-equivalent to the pairwise
  // comparators on the fixture alphabet.
  const decorated = entries.map((entry) => ({
    entry,
    rating: normaliseRating(entry).value,
    titleKey: entry.displayTitle.toLowerCase(),
    year: entry.yearNum,
    runtime: runtimeMinutesOf(entry),
    added: entry.added,
  }))
  type Decorated = (typeof decorated)[number]
  const byTitleKey = (a: Decorated, b: Decorated): number => {
    if (a.titleKey !== b.titleKey) return a.titleKey < b.titleKey ? -1 : 1
    return a.entry.id - b.entry.id
  }
  const unknownLast = (
    a: Decorated,
    b: Decorated,
    key: (d: Decorated) => number | null
  ): number | null => {
    const ka = key(a)
    const kb = key(b)
    if ((ka == null) !== (kb == null)) return ka == null ? 1 : -1
    if (ka == null || kb == null) return 0
    return null
  }
  switch (sort) {
    case "added":
      decorated.sort((a, b) => {
        const ka = a.added > 0 ? 0 : 1
        const kb = b.added > 0 ? 0 : 1
        if (ka !== kb) return ka - kb
        if (a.added !== b.added) return b.added - a.added
        return byTitleKey(a, b)
      })
      break
    case "rating":
      decorated.sort((a, b) => {
        const unknown = unknownLast(a, b, (d) => d.rating)
        if (unknown !== null && unknown !== 0) return unknown
        if (unknown === 0) return byTitleKey(a, b)
        if ((a.rating as number) !== (b.rating as number)) {
          return (b.rating as number) - (a.rating as number)
        }
        return byTitleKey(a, b)
      })
      break
    case "year-desc":
      decorated.sort((a, b) => {
        const unknown = unknownLast(a, b, (d) => d.year)
        if (unknown !== null && unknown !== 0) return unknown
        if (unknown === 0) return byTitleKey(a, b)
        if ((a.year as number) !== (b.year as number)) {
          return (b.year as number) - (a.year as number)
        }
        return byTitleKey(a, b)
      })
      break
    case "year-asc":
      decorated.sort((a, b) => {
        const unknown = unknownLast(a, b, (d) => d.year)
        if (unknown !== null && unknown !== 0) return unknown
        if (unknown === 0) return byTitleKey(a, b)
        if ((a.year as number) !== (b.year as number)) {
          return (a.year as number) - (b.year as number)
        }
        return byTitleKey(a, b)
      })
      break
    case "az":
      decorated.sort(byTitleKey)
      break
    case "runtime-asc":
    case "runtime-desc": {
      const dir = sort === "runtime-asc" ? 1 : -1
      decorated.sort((a, b) => {
        const unknown = unknownLast(a, b, (d) => d.runtime)
        if (unknown !== null && unknown !== 0) return unknown
        if (unknown === 0) return byTitleKey(a, b)
        if ((a.runtime as number) !== (b.runtime as number)) {
          return ((a.runtime as number) - (b.runtime as number)) * dir
        }
        return byTitleKey(a, b)
      })
      break
    }
    default:
      break
  }
  return decorated.map((d) => d.entry)
}

/**
 * Derive the visible page for a state. ONE full catalogue pass per
 * new constraint set; the matched list is memoised per constraint
 * signature, so page turns, focus moves and scrolling NEVER re-run
 * the pass, the sort, or the grouping. Unknown metadata never
 * fabricates a match: rating/runtime/decade filters exclude unknown
 * values (mirroring ratingMatches / runtimeMatches / yearMatches).
 */
export function deriveBrowsePage(
  index: CatalogIndex,
  state: BrowseState,
  ctx?: { progress?: ProgressMap }
): BrowseDerivation {
  const sig = `${index.revision}|${stateSignature(state)}`
  let matched = derivationCache.get(sig)
  if (!matched) {
    browseDerivations += 1
    browseFullPasses += 1
    const tokens = normalize(state.query).split(" ").filter(Boolean)
    const searchingAll = tokens.length > 0 && state.searchScope === "all"
    // A genre with zero members matches NOTHING (an empty set), never
    // everything: a null set here would silently disable the filter.
    const genreSet = state.genre
      ? new Set(index.genreMembers.get(state.genre) ?? [])
      : null
    const category =
      state.categoryId === ALL_CATEGORIES_ID
        ? null
        : index.categories.find((c) => c.id === state.categoryId) ?? null
    const categorySet =
      category && !searchingAll ? new Set(category.indexes) : null
    // Unknown category id (not "all", not in the index): matches nothing.
    const unknownCategory =
      state.categoryId !== ALL_CATEGORIES_ID && !category && !searchingAll
    const kept: CatalogEntry[] = []
    if (!unknownCategory) {
      for (let i = 0; i < index.entries.length; i++) {
        const entry = index.entries[i]
        if (categorySet && !categorySet.has(i)) continue
        if (genreSet && !genreSet.has(i)) continue
        if (state.minRating > 0) {
          const r = normaliseRating(entry)
          if (!r.hasEvidence || (r.value as number) < state.minRating) continue
        }
        if (state.maxRuntime > 0) {
          const mins = runtimeMinutesOf(entry)
          if (mins == null || mins > state.maxRuntime) continue
        }
        if (state.decade) {
          if (decadeKeyForYear(parseYear(entry.year)) !== state.decade) continue
        }
        if (state.hideWatched && ctx?.progress) {
          if (progressOf(ctx.progress, entry.id)?.completed) continue
        }
        if (tokens.length > 0) {
          const hay = normalize(
            `${entry.name} ${entry.categoryName} ${entry.year}`
          )
          if (!tokens.every((t) => hay.includes(t))) continue
        }
        kept.push(entry)
      }
    }
    const sorted = sortMatched(kept, state.sort)
    matched = groupEntries(sorted, index)
    derivationCache.set(sig, matched)
  } else {
    browseCacheHits += 1
  }
  const pageCount = pageCountFor(matched.length, state.pageSize)
  const page =
    pageCount === 0 ? 0 : Math.max(0, Math.min(state.page, pageCount - 1))
  const start = page * state.pageSize
  const groups = matched.slice(start, start + state.pageSize)
  return {
    matchedGroups: matched,
    groups,
    totalGroups: matched.length,
    totalEntries: matched.reduce((n, g) => n + g.variants.length, 0),
    pageCount,
    page,
    pageSize: state.pageSize,
    state,
  }
}

// ---------------------------------------------------------------------------
// Browse Everything mount (W2 contract) — DOM, generation-guarded paints
// ---------------------------------------------------------------------------

export interface BrowseMountOptions {
  index: CatalogIndex
  state?: BrowseState
  progress?: ProgressMap
  /**
   * Provider loader. The mount must NEVER call it: Browse Everything
   * renders from the already-built index, so opening a large grid,
   * paging, scrolling and filtering cost zero provider requests.
   * Tests pass a counting spy to prove it (acceptance test 20).
   */
  loader?: () => unknown
  onActivate?: (group: EntryGroup, card: HTMLElement) => void
  onStateChange?: (state: BrowseState) => void
  onGenreTile?: (genreId: string) => void
}

export interface DrawerHandle {
  element: HTMLElement
  close(): void
}

export interface BrowseMountHandle {
  container: HTMLElement
  getState(): BrowseState
  getDerivation(): BrowseDerivation
  getMountedCardCount(): number
  getRenderedGroupKeys(): string[]
  getPaintCount(): number
  setCategory(categoryId: string): void
  applyFilters(patch: BrowseFilterPatch): void
  resetAll(): void
  setPage(page: number): void
  setSearch(query: string, scope?: "all" | "category"): void
  setSort(sort: BrowseSortId): void
  focusCard(position: number): HTMLElement | null
  getFocusedCard(): HTMLElement | null
  openFilterDrawer(): DrawerHandle
  closeFilterDrawer(): void
  getDrawer(): DrawerHandle | null
  /** Simulate opening a detail page for a group (navigation away). */
  openDetail(groupKey: string): void
  /** Back step: detail → browse at the same page, same card focused. */
  returnFromDetail(): void
  isDetailOpen(): boolean
  /** Scroll within the mounted page. Must never re-derive or repaint. */
  scrollWithinPage(deltaRows: number): void
  getScrollRow(): number
  awaitSettled(): Promise<void>
  unmount(): void
}

function requireDocument(): Document {
  if (typeof document === "undefined") {
    throw new Error("mountBrowseEverything requires a DOM")
  }
  return document
}

function cardLabel(group: EntryGroup): string {
  const rep = group.representative
  const parts = [rep.displayTitle]
  if (rep.year) parts.push(rep.year)
  if (group.variants.length > 1) parts.push(`(${group.variants.length} versions)`)
  return parts.join(" · ")
}

/**
 * Mount Browse Everything into a container. Renders ONLY the current
 * page (≤ pageSize cards, one per display group), with a roving
 * tabindex, arrow-key movement, a generation-guarded paint pipeline
 * (rapid category switches never paint stale results), a focus-trapped
 * filter drawer, and detail-return focus restore. Paints are
 * scheduled on the microtask queue so tests can awaitSettled().
 */
export function mountBrowseEverything(
  container: HTMLElement,
  opts: BrowseMountOptions
): BrowseMountHandle {
  const doc = requireDocument()
  const index = opts.index
  let state: BrowseState =
    opts.state ?? createBrowseState(index.kind)
  let generation = 0
  let paintCount = 0
  let scrollRow = 0
  let lastFocusKey: string | null = null
  let lastFocusPosition = 0
  let drawer: DrawerHandle | null = null
  let detail: { page: number; key: string } | null = null
  let derivation: BrowseDerivation = deriveBrowsePage(index, state, {
    progress: opts.progress,
  })
  let destroyed = false

  const grid = doc.createElement("section")
  grid.setAttribute("data-nylah-rail", "browse-grid")
  grid.setAttribute("data-browse-grid", "")
  const header = doc.createElement("div")
  header.setAttribute("data-browse-header", "")
  const pager = doc.createElement("div")
  pager.setAttribute("data-browse-pager", "")
  container.append(header, grid, pager)

  function renderHeader(): void {
    const summary = activeFilterSummary(state)
    header.textContent =
      summary.length === 0
        ? "Browse Everything"
        : `Browse Everything — ${summary.map((s) => s.label).join(" · ")}`
    pager.textContent =
      derivation.pageCount === 0
        ? "No titles match"
        : `Page ${derivation.page + 1} of ${derivation.pageCount} — ${derivation.totalGroups} titles`
  }

  function paint(focusKeyToRestore?: string | null): void {
    if (destroyed || detail) return
    derivation = deriveBrowsePage(index, state, { progress: opts.progress })
    paintCount += 1
    renderHeader()
    while (grid.firstChild) grid.removeChild(grid.firstChild)
    derivation.groups.forEach((group, position) => {
      const card = doc.createElement("button")
      card.type = "button"
      card.className = "browse-card"
      card.setAttribute("data-browse-card", "")
      card.setAttribute("data-nylah-item", "")
      card.setAttribute("data-couch-key", group.key)
      card.setAttribute("data-group-key", group.key)
      card.tabIndex = position === 0 ? 0 : -1
      const rep = group.representative
      if (rep.poster) {
        const img = doc.createElement("img")
        img.setAttribute("data-poster", "")
        img.alt = ""
        img.src = rep.poster
        card.appendChild(img)
      }
      const title = doc.createElement("span")
      title.textContent = cardLabel(group)
      card.appendChild(title)
      grid.appendChild(card)
    })
    // Focus restore: same group key when it survived, else the same
    // position clamped, else the first card. Focus never silently
    // drops to <body> on a repaint while the grid is on screen.
    const restoreKey = focusKeyToRestore ?? lastFocusKey
    const cards = gridCards()
    if (cards.length > 0) {
      const byKey = restoreKey
        ? cards.find((c) => c.getAttribute("data-group-key") === restoreKey)
        : undefined
      const target =
        byKey ?? cards[Math.min(lastFocusPosition, cards.length - 1)]
      setRovingTabindex(target)
      if (grid.contains(doc.activeElement) || doc.activeElement === doc.body) {
        target.focus({ preventScroll: true })
        lastFocusKey = target.getAttribute("data-group-key")
        lastFocusPosition = cards.indexOf(target)
      }
    }
  }

  function gridCards(): HTMLElement[] {
    return Array.from(grid.querySelectorAll<HTMLElement>("[data-browse-card]"))
  }

  function setRovingTabindex(target: HTMLElement): void {
    for (const card of gridCards()) card.tabIndex = card === target ? 0 : -1
  }

  function schedulePaint(): void {
    const gen = ++generation
    queueMicrotask(() => {
      if (destroyed || gen !== generation) return
      paint()
    })
  }

  function commit(next: BrowseState): void {
    state = next
    opts.onStateChange?.(state)
    schedulePaint()
  }

  function moveFocus(delta: number): void {
    const cards = gridCards()
    if (cards.length === 0) return
    const current = cards.indexOf(doc.activeElement as HTMLElement)
    const from = current >= 0 ? current : lastFocusPosition
    const to = Math.max(0, Math.min(cards.length - 1, from + delta))
    browseFocusMoves += 1
    setRovingTabindex(cards[to])
    cards[to].focus({ preventScroll: true })
    lastFocusKey = cards[to].getAttribute("data-group-key")
    lastFocusPosition = to
  }

  function onGridKeydown(event: KeyboardEvent): void {
    if (event.repeat) return
    const target = event.target as HTMLElement | null
    if (!target || !grid.contains(target)) return
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault()
        moveFocus(1)
        break
      case "ArrowLeft":
        event.preventDefault()
        moveFocus(-1)
        break
      case "ArrowDown":
        event.preventDefault()
        moveFocus(BROWSE_GRID_COLUMNS)
        break
      case "ArrowUp":
        event.preventDefault()
        moveFocus(-BROWSE_GRID_COLUMNS)
        break
      case "Home":
        event.preventDefault()
        moveFocus(-gridCards().length)
        break
      case "End":
        event.preventDefault()
        moveFocus(gridCards().length)
        break
      case "PageDown":
        event.preventDefault()
        setPageInternal(state.page + 1)
        break
      case "PageUp":
        event.preventDefault()
        setPageInternal(state.page - 1)
        break
      case "Enter":
      case " ":
        // ONE activation funnel: keyboard activation goes through
        // click, exactly like the gamepad A path (activateFocused).
        event.preventDefault()
        target.click()
        break
      default:
        break
    }
  }

  function onGridClick(event: MouseEvent): void {
    const card = (event.target as HTMLElement | null)?.closest?.(
      "[data-browse-card]"
    ) as HTMLElement | null
    if (!card || !grid.contains(card)) return
    const key = card.getAttribute("data-group-key")
    const group = derivation.groups.find((g) => g.key === key)
    if (!group) return
    lastFocusKey = key
    lastFocusPosition = gridCards().indexOf(card)
    setRovingTabindex(card)
    opts.onActivate?.(group, card)
  }

  function onGridFocusIn(event: FocusEvent): void {
    const card = (event.target as HTMLElement | null)?.closest?.(
      "[data-browse-card]"
    ) as HTMLElement | null
    if (!card || !grid.contains(card)) return
    lastFocusKey = card.getAttribute("data-group-key")
    lastFocusPosition = gridCards().indexOf(card)
    setRovingTabindex(card)
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return
    if (drawer) {
      closeFilterDrawer()
      return
    }
    if (detail) {
      returnFromDetail()
    }
  }

  function setPageInternal(page: number): void {
    const clamped = setPage(state, page, derivation.totalGroups)
    if (clamped.page !== state.page) browsePageTurns += 1
    lastFocusPosition = 0
    lastFocusKey = null
    commit(clamped)
  }

  function openFilterDrawer(): DrawerHandle {
    if (drawer) return drawer
    const panel = doc.createElement("div")
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-label", "Filters")
    panel.setAttribute("data-nylah-dialog", "")
    panel.setAttribute("data-filter-drawer", "")

    const genreSelect = doc.createElement("select")
    genreSelect.setAttribute("data-filter-genre", "")
    genreSelect.setAttribute("aria-label", "Genre")
    const anyOption = doc.createElement("option")
    anyOption.value = ""
    anyOption.textContent = "All genres"
    genreSelect.appendChild(anyOption)
    for (const id of state.kind === "vod"
      ? CANONICAL_MOVIE_GENRES
      : CANONICAL_SERIES_GENRES) {
      const opt = doc.createElement("option")
      opt.value = id
      opt.textContent = id
      genreSelect.appendChild(opt)
    }
    genreSelect.value = state.genre
    genreSelect.addEventListener("change", () => {
      commit(applyFilters(state, { genre: genreSelect.value || null }))
    })

    const ratingSelect = doc.createElement("select")
    ratingSelect.setAttribute("data-filter-rating", "")
    ratingSelect.setAttribute("aria-label", "Minimum rating")
    for (const value of [0, 6, 7, 8, 9]) {
      const opt = doc.createElement("option")
      opt.value = String(value)
      opt.textContent = value === 0 ? "Any rating" : `${value}+`
      ratingSelect.appendChild(opt)
    }
    ratingSelect.value = String(state.minRating)
    ratingSelect.addEventListener("change", () => {
      commit(applyFilters(state, { minRating: Number(ratingSelect.value) }))
    })

    const runtimeSelect = doc.createElement("select")
    runtimeSelect.setAttribute("data-filter-runtime", "")
    runtimeSelect.setAttribute("aria-label", "Maximum runtime")
    for (const value of [0, 60, 90, 120, 150, 180]) {
      const opt = doc.createElement("option")
      opt.value = String(value)
      opt.textContent = value === 0 ? "Any length" : `Under ${value} min`
      runtimeSelect.appendChild(opt)
    }
    runtimeSelect.value = String(state.maxRuntime)
    runtimeSelect.addEventListener("change", () => {
      commit(applyFilters(state, { maxRuntime: Number(runtimeSelect.value) }))
    })

    const resetButton = doc.createElement("button")
    resetButton.type = "button"
    resetButton.setAttribute("data-filter-reset", "")
    resetButton.textContent = "Reset All"
    resetButton.addEventListener("click", () => {
      commit(resetAllFilters(state))
      genreSelect.value = ""
      ratingSelect.value = "0"
      runtimeSelect.value = "0"
    })

    const closeButton = doc.createElement("button")
    closeButton.type = "button"
    closeButton.setAttribute("data-filter-close", "")
    closeButton.textContent = "Done"
    closeButton.addEventListener("click", () => closeFilterDrawer())

    panel.append(genreSelect, ratingSelect, runtimeSelect, resetButton, closeButton)
    container.appendChild(panel)

    // Focus trap: Tab / Shift+Tab wrap inside the drawer; focus can
    // never fall through to the grid behind it while open.
    const focusables = (): HTMLElement[] =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])"
        )
      )
    function onDrawerKeydown(event: KeyboardEvent): void {
      if (event.key !== "Tab") return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = doc.activeElement as HTMLElement | null
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    panel.addEventListener("keydown", onDrawerKeydown)

    drawer = {
      element: panel,
      close: () => closeFilterDrawer(),
    }
    const first = focusables()[0]
    first?.focus({ preventScroll: true })
    return drawer
  }

  function closeFilterDrawer(): void {
    if (!drawer) return
    const invoker = gridCards()[lastFocusPosition] ?? gridCards()[0] ?? null
    const panel = drawer.element
    drawer = null
    panel.remove()
    // Focus returns to the card that opened the drawer (by key when
    // it survives, else the same position) — never to <body>.
    const cards = gridCards()
    const byKey = lastFocusKey
      ? cards.find((c) => c.getAttribute("data-group-key") === lastFocusKey)
      : undefined
    const target = byKey ?? invoker ?? cards[0] ?? null
    if (target) {
      setRovingTabindex(target)
      target.focus({ preventScroll: true })
    }
  }

  function openDetail(groupKey: string): void {
    const position = gridCards().findIndex(
      (c) => c.getAttribute("data-group-key") === groupKey
    )
    detail = { page: state.page, key: groupKey }
    if (position >= 0) lastFocusPosition = position
    lastFocusKey = groupKey
    grid.style.display = "none"
    let placeholder = container.querySelector<HTMLElement>("[data-browse-detail]")
    if (!placeholder) {
      placeholder = doc.createElement("div")
      placeholder.setAttribute("data-browse-detail", "")
      const back = doc.createElement("button")
      back.type = "button"
      back.setAttribute("data-detail-back", "")
      back.textContent = "Back"
      back.addEventListener("click", () => returnFromDetail())
      placeholder.appendChild(back)
      container.appendChild(placeholder)
    }
    placeholder.querySelector<HTMLElement>("[data-detail-back]")?.focus()
  }

  function returnFromDetail(): void {
    if (!detail) return
    const { page, key } = detail
    detail = null
    container.querySelector("[data-browse-detail]")?.remove()
    grid.style.display = ""
    const restored = setPage(state, page, derivation.totalGroups)
    state = restored
    opts.onStateChange?.(state)
    // Synchronous repaint: the returning user must land on the card
    // immediately, not after a paint generation.
    generation += 1
    paint(key)
  }

  grid.addEventListener("keydown", onGridKeydown)
  grid.addEventListener("click", onGridClick)
  grid.addEventListener("focusin", onGridFocusIn)
  doc.addEventListener("keydown", onDocumentKeydown)
  paint()

  return {
    container,
    getState: () => ({ ...state }),
    getDerivation: () => derivation,
    getMountedCardCount: () => gridCards().length,
    getRenderedGroupKeys: () =>
      gridCards().map((c) => c.getAttribute("data-group-key") ?? ""),
    getPaintCount: () => paintCount,
    setCategory: (categoryId: string) => {
      lastFocusPosition = 0
      lastFocusKey = null
      commit(selectCategory(state, categoryId))
    },
    applyFilters: (patch: BrowseFilterPatch) => {
      lastFocusPosition = 0
      lastFocusKey = null
      commit(applyFilters(state, patch))
    },
    resetAll: () => {
      lastFocusPosition = 0
      lastFocusKey = null
      commit(resetAllFilters(state))
    },
    setPage: (page: number) => setPageInternal(page),
    setSearch: (query: string, scope?: "all" | "category") => {
      lastFocusPosition = 0
      lastFocusKey = null
      commit(setSearch(state, query, scope))
    },
    setSort: (sort: BrowseSortId) => {
      lastFocusPosition = 0
      lastFocusKey = null
      commit(setSort(state, sort))
    },
    focusCard: (position: number) => {
      const cards = gridCards()
      const target = cards[Math.max(0, Math.min(position, cards.length - 1))]
      if (!target) return null
      setRovingTabindex(target)
      target.focus({ preventScroll: true })
      lastFocusKey = target.getAttribute("data-group-key")
      lastFocusPosition = cards.indexOf(target)
      return target
    },
    getFocusedCard: () => {
      const active = doc.activeElement as HTMLElement | null
      return active && grid.contains(active) ? active : null
    },
    openFilterDrawer,
    closeFilterDrawer,
    getDrawer: () => drawer,
    openDetail,
    returnFromDetail,
    isDetailOpen: () => detail !== null,
    scrollWithinPage: (deltaRows: number) => {
      // Scrolling moves the viewport over the mounted page only. It
      // must never re-derive, re-sort, re-group or repaint.
      scrollRow = Math.max(0, scrollRow + deltaRows)
    },
    getScrollRow: () => scrollRow,
    awaitSettled: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    unmount: () => {
      destroyed = true
      generation += 1
      doc.removeEventListener("keydown", onDocumentKeydown)
      grid.removeEventListener("keydown", onGridKeydown)
      grid.removeEventListener("click", onGridClick)
      grid.removeEventListener("focusin", onGridFocusIn)
      drawer = null
      container.replaceChildren()
    },
  }
}

// ---------------------------------------------------------------------------
// Home mount (W3/W4 contract surface) — shelves only, never the grid
// ---------------------------------------------------------------------------

export interface HomeMountOptions {
  onActivate?: (entry: CatalogEntry, card: HTMLElement) => void
  onGenreTile?: (genreId: string) => void
}

export interface HomeMountHandle {
  container: HTMLElement
  getMountedCardCount(): number
  getShelfCounts(): Record<string, number>
  reRender(shelves: HomeShelves): void
  unmount(): void
}

/** Render home shelves into a container. Only shelf cards + genre
 *  tiles are mounted; the full catalogue grid is never built here. */
export function mountHomeShelves(
  container: HTMLElement,
  shelves: HomeShelves,
  opts?: HomeMountOptions
): HomeMountHandle {
  const doc = requireDocument()
  let destroyed = false

  function render(current: HomeShelves): void {
    container.replaceChildren()
    const shelf = (
      name: string,
      entries: CatalogEntry[],
      attr: string
    ): void => {
      if (entries.length === 0) return
      const section = doc.createElement("section")
      section.setAttribute("data-nylah-rail", name)
      section.setAttribute(attr, "")
      for (const entry of entries) {
        const card = doc.createElement("button")
        card.type = "button"
        card.setAttribute("data-home-card", "")
        card.setAttribute("data-nylah-item", "")
        card.setAttribute("data-couch-key", `home:${name}:${entry.id}`)
        card.setAttribute("data-entry-id", String(entry.id))
        card.textContent = entry.displayTitle
        card.addEventListener("click", () => opts?.onActivate?.(entry, card))
        section.appendChild(card)
      }
      container.appendChild(section)
    }
    if (current.featured) {
      const hero = doc.createElement("section")
      hero.setAttribute("data-home-featured", "")
      const card = doc.createElement("button")
      card.type = "button"
      card.setAttribute("data-home-card", "")
      card.setAttribute("data-entry-id", String(current.featured.id))
      card.textContent = current.featured.displayTitle
      card.addEventListener("click", () =>
        opts?.onActivate?.(current.featured as CatalogEntry, card)
      )
      hero.appendChild(card)
      container.appendChild(hero)
    }
    shelf("continue-watching", current.continueWatching, "data-home-shelf")
    shelf("worth-watching", current.worthWatching, "data-home-shelf")
    shelf("recently-added", current.recentlyAdded, "data-home-shelf")
    shelf("hidden-gems", current.hiddenGems, "data-home-shelf")
    shelf("worth-starting", current.seriesWorthStarting, "data-home-shelf")
    shelf("followed-series", current.followedSeries, "data-home-shelf")
    if (current.genreTiles.length > 0) {
      const tiles = doc.createElement("section")
      tiles.setAttribute("data-genre-tiles", "")
      for (const tile of current.genreTiles) {
        const button = doc.createElement("button")
        button.type = "button"
        button.setAttribute("data-genre-tile", "")
        button.setAttribute("data-genre-id", tile.id)
        button.textContent = `${tile.id} (${tile.count})`
        button.addEventListener("click", () => opts?.onGenreTile?.(tile.id))
        tiles.appendChild(button)
      }
      container.appendChild(tiles)
    }
  }

  render(shelves)
  return {
    container,
    getMountedCardCount: () =>
      container.querySelectorAll("[data-home-card]").length,
    getShelfCounts: () => {
      const counts: Record<string, number> = {}
      for (const section of container.querySelectorAll(
        "section[data-nylah-rail]"
      )) {
        const name = section.getAttribute("data-nylah-rail") ?? ""
        counts[name] = section.querySelectorAll("[data-home-card]").length
      }
      const featured = container.querySelector("[data-home-featured]")
      if (featured) counts["featured"] = 1
      counts["genre-tiles"] = container.querySelectorAll(
        "[data-genre-tile]"
      ).length
      return counts
    },
    reRender: (next: HomeShelves) => {
      if (!destroyed) render(next)
    },
    unmount: () => {
      destroyed = true
      container.replaceChildren()
    },
  }
}

// ---------------------------------------------------------------------------
// Mode / URL contract (W2 contract)
// ---------------------------------------------------------------------------

export type BrowseMode = "home" | "browse"

export interface ParsedModeUrl {
  kind: CatalogKind | null
  mode: BrowseMode
  categoryId: string | null
  page: number
  query: string
}

/**
 * Parse the mode/URL contract: the PATH names the kind
 * (/movies → vod, /series → series, /browse reads ?kind=), the `mode`
 * query param names home vs browse-everything, and category/page/q
 * ride along. Unknown modes fall back to "home"; unknown kinds to
 * null. Accepts absolute or path-only URLs.
 */
export function parseModeFromUrl(url: string): ParsedModeUrl {
  const parsed = new URL(url, "http://localhost")
  const path = parsed.pathname.replace(/\/+$/, "") || "/"
  let kind: CatalogKind | null = null
  if (path === "/movies" || path.startsWith("/movies/")) kind = "vod"
  else if (path === "/series" || path.startsWith("/series/")) kind = "series"
  else if (path === "/browse" || path.startsWith("/browse/")) {
    const kindParam = parsed.searchParams.get("kind")
    if (kindParam === "movies" || kindParam === "vod") kind = "vod"
    else if (kindParam === "series") kind = "series"
  }
  const modeParam = parsed.searchParams.get("mode")
  const mode: BrowseMode = modeParam === "browse" ? "browse" : "home"
  const pageRaw = Number(parsed.searchParams.get("page"))
  return {
    kind,
    mode,
    categoryId: parsed.searchParams.get("category"),
    page: Number.isFinite(pageRaw) && pageRaw >= 0 ? Math.floor(pageRaw) : 0,
    query: parsed.searchParams.get("q") ?? "",
  }
}

/**
 * Set the mode in a URL, preserving every other param. Switching
 * modes resets the page (a fresh Browse Everything starts at page
 * 0; Home has no page). Category and query survive the switch.
 * Returns the same URL form it was given (path-only stays path-only).
 */
export function setModeInUrl(
  url: string,
  mode: BrowseMode,
  extra?: { categoryId?: string | null; query?: string | null }
): string {
  const absolute = /^https?:\/\//i.test(url)
  const parsed = new URL(url, "http://localhost")
  const current = parseModeFromUrl(url)
  parsed.searchParams.set("mode", mode)
  if (current.mode !== mode) parsed.searchParams.delete("page")
  if (extra?.categoryId !== undefined) {
    if (extra.categoryId == null) parsed.searchParams.delete("category")
    else parsed.searchParams.set("category", extra.categoryId)
  }
  if (extra?.query !== undefined) {
    if (extra.query == null) parsed.searchParams.delete("q")
    else parsed.searchParams.set("q", extra.query)
  }
  const pathAndQuery = `${parsed.pathname}${parsed.search}`
  return absolute ? parsed.toString() : pathAndQuery
}
