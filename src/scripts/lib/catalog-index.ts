// Prepared catalogue index (0.11.8 W1, brief §15.1–§15.3, fixes §1.3).
//
// One build per playlist + content kind + catalogue revision +
// metadata revision, cached and shared by every Movies/Series
// consumer (Browse engine, Movies Home, Series Home, selectors).
// The index holds REFERENCES to the caller's catalogue rows — never
// duplicated full arrays of mapped objects — plus small per-entry
// metadata computed once (normalised titles, years, rating evidence,
// runtimes, genres, group identity) and reusable SORTED ID INDEXES,
// so no consumer ever sorts 50,000 titles from scratch per focus
// move. All browse-facing id lists are DISPLAY-level: group primary
// ids, so counts reflect distinct displayed titles post-grouping.
//
// Profile-specific data (progress, favourites, watchlists) is LAYERED
// SEPARATELY (createProfileLayer): changing one favourite must never
// force a full provider-index rebuild. This module takes no profile
// input at build time.
//
// SERIES METADATA GUARDRAIL (brief §15.6 — read before touching
// season counts): season counts come ONLY from already-cached data.
// The index NEVER triggers a series-info fetch: callers pass an
// optional `seasonCountReader` that must read synchronously from
// cache (getCachedSeasonCount from series-seasons.ts). Never enqueue
// series-info for thousands of offscreen series, never call
// requestSeasonCount / requestSeriesInfo / observeSeasonCount from
// index construction. Series consumers that need fresh counts fetch
// them lazily, viewport-gated, through series-seasons.ts's own queue
// (concurrency limit 3) — outside this module.
//
// No TMDb sweeps: genre evidence comes from the rows + optional
// caller-supplied verified notes; enrichment stays incremental,
// bounded and cached via the existing detail/backfill paths.

import { normalize, scoreNormMatch } from "@/scripts/lib/text.ts"
import { cleanProviderTitle } from "@/scripts/lib/tmdb-match.ts"
import { parseNamePrefix } from "@/scripts/lib/language-tags.ts"
import {
  parseYear,
  parseRuntimeMinutes,
  decadeKeyForYear,
} from "@/scripts/lib/browse-filters.ts"
import {
  CANONICAL_MOVIE_GENRES,
  CANONICAL_SERIES_GENRES,
  UNCATEGORISED_ID,
  genresForEntryWithEvidence,
  seriesFamiliesForGenreIds,
  registerProviderCategory,
  type GenreId,
} from "@/scripts/lib/genres.ts"
import { groupEntries, type TitleGroup } from "@/scripts/lib/language-groups.ts"
import {
  normaliseRating,
  type RatingEvidence,
} from "@/scripts/lib/rating-evidence.ts"
import { bayesianRating } from "@/scripts/lib/rating-confidence.ts"
import {
  noteCatalogIndexBuild,
  noteCatalogIndexCacheHit,
} from "@/scripts/lib/browse-instrumentation.ts"

export type CatalogKind = "vod" | "series"

/**
 * A catalogue row as the index reads it. Mapped Xtream rows
 * (catalog-mappers.js) fit directly; extra provider/enrichment
 * fields are ignored except where noted. Rows are stored by
 * reference — never copied, never mutated.
 */
export interface CatalogRow {
  id: string | number
  name?: string | null
  title?: string | null
  year?: string | number | null
  rating?: string | number | null
  duration?: string | number | null
  runtime?: string | number | null
  category?: string | null
  category_id?: string | number | null
  categoryId?: string | number | null
  genre?: string | null
  genres?: string[] | string | null
  genre_ids?: number[] | null
  tmdbGenreIds?: number[] | null
  enrichmentGenres?: string[] | null
  added?: string | number | null
  tmdb?: string | number | null
  tmdb_id?: string | number | null
  logo?: string | null
  cover?: string | null
  original_title?: string | null
  originalTitle?: string | null
  alternativeTitles?: string[] | null
  seasonCount?: number | null
  seasons?: number | null
  [key: string]: unknown
}

/** Small per-entry metadata computed once at build time. */
export interface CatalogEntryMeta {
  id: string
  /** Cleaned, prefix-stripped, normalised display title. */
  normalisedTitle: string
  /** Normalised title variants for search (cleaned variants + raw + original/alternative titles). */
  titleVariants: string[]
  year: number | null
  /** Decade key ("2020s", "older") or "" when the year is unknown. */
  decade: string
  /** Provider ADDED timestamp in epoch ms, or null when unknown (never the release year). */
  addedMs: number | null
  rating: RatingEvidence | null
  /** Bayesian evidence-weighted score (prior mean when unrated). */
  bayesian: number
  runtimeMinutes: number | null
  /** Season count from CACHED data only (series); always null for movies and on cache miss. */
  seasonCount: number | null
  /**
   * Episode count when the row carries explicit episode evidence
   * (episodeCount field or an episodes array). 0 is PRESERVED — a
   * confirmed-empty series is not an unknown one. Null when the row
   * carries no episode evidence (the usual catalogue case).
   */
  episodeCount: number | null
  /** Canonical genre ids (movie taxonomy) or family ids (series). [] when no evidence. */
  genreIds: string[]
  genreProvenance: "verified" | "provider" | "category" | "none"
  /** Provider-category lookup key ("" when the row carries no category). */
  providerCategoryKey: string
  languageTag: string | null
  groupId: string
  tmdbId: number | null
  hasPoster: boolean
}

/** Display-level aggregate for one group (one displayed title). */
export interface GroupAggregate {
  groupId: string
  primaryId: string
  normalisedTitle: string
  /** Primary's year, else the first known member year. */
  year: number | null
  /** Most recent member ADDED timestamp (a new variant arriving re-dates the title). */
  addedMs: number | null
  /** Best-evidenced member rating (highest Bayesian score), or null when no member is rated. */
  rating: RatingEvidence | null
  bayesian: number
  runtimeMinutes: number | null
  /** Union of member genre ids, in canonical taxonomy order. */
  genreIds: string[]
  hasPoster: boolean
}

/**
 * Reusable sorted id indexes (display-level primary ids). Every list
 * is total-order deterministic: the stated key, then normalised
 * title, then id. Unknown values sort last on every key.
 */
export interface SortedIdIndexes {
  /** Catalogue order (first-appearance order of groups). */
  catalogue: string[]
  /** Provider ADDED, newest first. */
  added: string[]
  yearDesc: string[]
  yearAsc: string[]
  /** Evidence-weighted rating (rated first, unrated last). */
  rating: string[]
  titleAsc: string[]
  titleDesc: string[]
  /** Meaningful for movies; series rows have no runtime (title order). */
  runtimeAsc: string[]
  runtimeDesc: string[]
}

export interface CatalogIndex {
  kind: CatalogKind
  /** Normalised catalogue revision string this index was built for. */
  revision: string
  playlistId: string | null
  /** The caller's catalogue array, by reference. Never copied. */
  entries: readonly CatalogRow[]
  /** ID -> row lookup (string ids, rows by reference). */
  byId: Map<string, CatalogRow>
  meta: Map<string, CatalogEntryMeta>
  groupAggregates: Map<string, GroupAggregate>
  /** Genre/family id -> DISPLAYED group primary ids. Includes UNCATEGORISED_ID. */
  idsByGenre: Map<string, string[]>
  /** Genre/family id -> every variant entry id (search/completeness use). */
  allEntryIdsByGenre: Map<string, string[]>
  /** Provider-category key -> DISPLAYED group primary ids. */
  idsByProviderCategory: Map<string, string[]>
  allEntryIdsByProviderCategory: Map<string, string[]>
  /** Decade key -> DISPLAYED group primary ids. Includes "unknown". */
  idsByDecade: Map<string, string[]>
  sortedIds: SortedIdIndexes
  groups: TitleGroup[]
  groupById: Map<string, TitleGroup>
  groupIdByEntryId: Map<string, string>
  totalEntries: number
  totalGroups: number
  /** Rows skipped (missing/unusable id). */
  skippedRows: number
  /** Duplicate ids skipped (first occurrence wins). */
  duplicateIdsSkipped: number
  builtAt: number
  /**
   * Monotonic build sequence, unique per buildCatalogIndex call.
   * The revision STRING alone cannot identify an index: two
   * different catalogues can share a playlist + row count. Selector
   * caching keys on this sequence so a rebuilt index never serves
   * another index's cached selections (D36).
   */
  seq: number
}

export type CatalogRevision =
  | string
  | number
  | { catalogue?: string | number | null; metadata?: string | number | null }
  | null
  | undefined

export interface CatalogIndexOptions {
  playlistId?: string | null
  metadataRevision?: string | number | null
  /** Extra cache discriminator (e.g. a season-count refresh token). */
  cacheBuster?: string | null
  /**
   * Verified genre ids per entry id (e.g. detail-page notes). Treated
   * as tier-1 verified evidence, overriding row/category evidence.
   */
  genreNotes?: Record<string, string[]> | Map<string, string[]> | null
  /**
   * Season-count reader for series rows. MUST be a synchronous
   * cache-only read (getCachedSeasonCount) — never a fetch. See the
   * §15.6 guardrail in the header.
   */
  seasonCountReader?: ((entryId: string, row: CatalogRow) => number | null) | null
}

export function normaliseCatalogKind(kind: unknown): CatalogKind {
  const text = String(kind ?? "").trim().toLowerCase()
  if (text === "series" || text === "tv" || text === "show") return "series"
  if (text === "vod" || text === "movie" || text === "film") return "vod"
  throw new TypeError(`[catalog-index] unknown catalogue kind: ${String(kind)}`)
}

function revisionParts(
  revision: CatalogRevision,
  opts: CatalogIndexOptions,
): { revision: string; metadataRevision: string } {
  let cataloguePart: string | number | null | undefined
  let metadataPart: string | number | null | undefined
  if (revision != null && typeof revision === "object") {
    cataloguePart = revision.catalogue
    metadataPart = revision.metadata
  } else if (revision != null) {
    cataloguePart = revision
  }
  if (opts.metadataRevision != null) metadataPart = opts.metadataRevision
  return {
    revision: cataloguePart == null || cataloguePart === "" ? "0" : String(cataloguePart),
    metadataRevision: metadataPart == null ? "" : String(metadataPart),
  }
}

function normaliseAddedMs(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  // Provider `added` is epoch seconds; tolerate epoch ms.
  const ms = n > 1e11 ? n : n * 1000
  // Future timestamps beyond clock skew are provider noise, not recency.
  if (ms > Date.now() + 24 * 60 * 60 * 1000) return null
  return ms
}

function tmdbIdOf(row: CatalogRow): number | null {
  const n = Number(row.tmdb ?? row.tmdb_id)
  return Number.isInteger(n) && n > 0 ? n : null
}

function seasonCountOf(row: CatalogRow): number | null {
  for (const field of [row.seasonCount, row.seasons]) {
    const n = Number(field)
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

/**
 * Explicit episode evidence only. A numeric episodeCount >= 0 wins;
 * otherwise an episodes array's length counts (an EMPTY array is a
 * confirmed 0, not unknown). Anything else is null — most catalogue
 * rows carry no episode evidence at all.
 */
function episodeCountOf(row: CatalogRow): number | null {
  const direct = Number(row.episodeCount)
  if (Number.isInteger(direct) && direct >= 0) return direct
  if (Array.isArray(row.episodes)) return row.episodes.length
  return null
}

const MOVIE_ID_SET = new Set<string>(CANONICAL_MOVIE_GENRES.map((g) => g.id))
const SERIES_FAMILY_SET = new Set<string>(CANONICAL_SERIES_GENRES.map((f) => f.id))
const MOVIE_ORDER = new Map(CANONICAL_MOVIE_GENRES.map((g, i) => [g.id, i]))
const SERIES_ORDER = new Map(CANONICAL_SERIES_GENRES.map((f, i) => [f.id, i]))

function orderGenreIds(ids: Iterable<string>, kind: CatalogKind): string[] {
  const order = kind === "series" ? SERIES_ORDER : MOVIE_ORDER
  return [...new Set(ids)].sort((a, b) => {
    const rankA = order.get(a)
    const rankB = order.get(b)
    if (rankA != null && rankB != null) return rankA - rankB
    if (rankA != null) return -1
    if (rankB != null) return 1
    return a.localeCompare(b)
  })
}

/** Map caller-supplied verified note ids onto the index kind's taxonomy. */
function genreIdsFromNotes(noteIds: string[], kind: CatalogKind): string[] {
  const cleaned = noteIds.map((id) => String(id ?? "").trim().toLowerCase()).filter(Boolean)
  if (kind === "series") {
    const direct = cleaned.filter((id) => SERIES_FAMILY_SET.has(id))
    const viaMembers = seriesFamiliesForGenreIds(
      cleaned.filter((id): id is GenreId => MOVIE_ID_SET.has(id)),
    )
    return orderGenreIds([...direct, ...viaMembers], kind)
  }
  return orderGenreIds(cleaned.filter((id) => MOVIE_ID_SET.has(id)), kind)
}

/**
 * Search normalisation: shared normalize() plus stripping of leftover
 * ASCII punctuation ("Amélie!" -> "amelie"), applied symmetrically to
 * indexed variants and queries. Letters in all scripts are preserved.
 */
function searchNorm(value: unknown): string {
  return normalize(value)
    .replace(/['’"“”«»!?;:*&+@#%~=`^$<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function titleVariantsOf(row: CatalogRow, cleanedVariants: string[], rawName: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const seenRaw = new Set<string>()
  const push = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) push(item)
      return
    }
    // Skip repeat normalisation of identical raw strings (common:
    // the raw name often equals the first cleaned variant).
    if (typeof value === "string") {
      if (seenRaw.has(value)) return
      seenRaw.add(value)
    }
    const normed = searchNorm(value)
    if (normed && !seen.has(normed)) {
      seen.add(normed)
      out.push(normed)
    }
  }
  for (const variant of cleanedVariants) push(variant)
  push(rawName)
  push(row.original_title)
  push(row.originalTitle)
  push(row.alternativeTitles)
  return out.slice(0, 6)
}

function compareTitle(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function compareId(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Build a prepared index (uncached). Prefer getCatalogIndex(), which
 * memoizes per catalogue identity + revision. Pure apart from the
 * optional caller-supplied seasonCountReader (cache-only by contract)
 * and provider-category registration.
 */
export function buildCatalogIndex(
  kindInput: unknown,
  catalogueInput: CatalogRow[] | null | undefined,
  revisionInput: CatalogRevision,
  opts: CatalogIndexOptions = {},
): CatalogIndex {
  const kind = normaliseCatalogKind(kindInput)
  noteCatalogIndexBuild()
  if (catalogueInput != null && !Array.isArray(catalogueInput)) {
    throw new TypeError("[catalog-index] catalogue must be an array of rows")
  }
  const catalogue = catalogueInput ?? []
  const { revision } = revisionParts(revisionInput, opts)
  const playlistId = opts.playlistId ?? null

  const notesById = new Map<string, string[]>()
  if (opts.genreNotes) {
    if (opts.genreNotes instanceof Map) {
      for (const [key, value] of opts.genreNotes) {
        if (Array.isArray(value)) notesById.set(String(key), value)
      }
    } else {
      for (const [key, value] of Object.entries(opts.genreNotes)) {
        if (Array.isArray(value)) notesById.set(key, value)
      }
    }
  }

  const byId = new Map<string, CatalogRow>()
  const meta = new Map<string, CatalogEntryMeta>()
  const orderedRows: CatalogRow[] = []
  const orderedIds: string[] = []
  let skippedRows = 0
  let duplicateIdsSkipped = 0
  const registeredCategoryKeys = new Set<string>()

  for (const row of catalogue) {
    if (!row || typeof row !== "object" || row.id == null || String(row.id).trim() === "") {
      skippedRows++
      continue
    }
    const id = String(row.id)
    if (byId.has(id)) {
      duplicateIdsSkipped++
      continue
    }
    byId.set(id, row)
    orderedRows.push(row)
    orderedIds.push(id)

    const rawName = String(row.name ?? row.title ?? "")
    const prefix = parseNamePrefix(rawName)
    const cleaned = cleanProviderTitle(prefix.tag != null ? prefix.rest : rawName)
    const normalisedTitle = normalize(cleaned.variants[0] || rawName)
    const year =
      parseYear(row.year) ?? cleaned.year ?? parseYear(row.release_date ?? row.first_air_date)
    const rating = normaliseRating(row)
    const runtimeMinutes =
      kind === "vod" ? parseRuntimeMinutes(row.duration ?? row.runtime) : null

    // §15.6: CACHED season data only, via the caller's reader. No fetch
    // is ever triggered here; a throwing/missing reader yields null.
    let seasonCount: number | null = null
    if (kind === "series") {
      seasonCount = seasonCountOf(row)
      if (seasonCount == null && opts.seasonCountReader) {
        try {
          const read = opts.seasonCountReader(id, row)
          if (typeof read === "number" && Number.isInteger(read) && read > 0) {
            seasonCount = read
          }
        } catch {
          seasonCount = null
        }
      }
    }

    const noted = notesById.get(id)
    let genreIds: string[]
    let genreProvenance: CatalogEntryMeta["genreProvenance"]
    if (noted) {
      const fromNotes = genreIdsFromNotes(noted, kind)
      if (fromNotes.length) {
        genreIds = fromNotes
        genreProvenance = "verified"
      } else {
        const resolved = genresForEntryWithEvidence(row, kind)
        genreIds = resolved.genreIds
        genreProvenance = resolved.provenance
      }
    } else {
      const resolved = genresForEntryWithEvidence(row, kind)
      genreIds = resolved.genreIds
      genreProvenance = resolved.provenance
    }

    const categoryLabel = String(row.category ?? row.category_name ?? "").trim()
    const categoryIdRaw = row.category_id ?? row.categoryId
    let providerCategoryKey = ""
    if (categoryIdRaw != null && String(categoryIdRaw).trim() !== "") {
      providerCategoryKey = `id:${String(categoryIdRaw).trim()}`
    } else if (categoryLabel) {
      providerCategoryKey = `label:${normalize(categoryLabel)}`
    }
    if (providerCategoryKey && !registeredCategoryKeys.has(providerCategoryKey)) {
      registeredCategoryKeys.add(providerCategoryKey)
      registerProviderCategory(
        providerCategoryKey,
        categoryIdRaw == null ? "" : String(categoryIdRaw).trim(),
        categoryLabel,
      )
    }

    meta.set(id, {
      id,
      normalisedTitle,
      titleVariants: titleVariantsOf(row, cleaned.variants, rawName),
      year,
      decade: decadeKeyForYear(year),
      addedMs: normaliseAddedMs(row.added),
      rating,
      bayesian: rating ? bayesianRating(rating.score10, rating.voteCount) : bayesianRating(null, null),
      runtimeMinutes,
      seasonCount,
      episodeCount: episodeCountOf(row),
      genreIds,
      genreProvenance,
      providerCategoryKey,
      languageTag: prefix.tag,
      groupId: "",
      tmdbId: tmdbIdOf(row),
      hasPoster: Boolean(String(row.logo ?? row.cover ?? "").trim()),
    })
  }

  // Safe grouping (§13): kind-partitioned, TMDb-first, conservative.
  const groups = groupEntries(orderedRows, kind)
  const groupById = new Map<string, TitleGroup>()
  const groupIdByEntryId = new Map<string, string>()
  const groupAggregates = new Map<string, GroupAggregate>()
  for (const group of groups) {
    groupById.set(group.id, group)
    for (const memberId of group.variantIds) {
      groupIdByEntryId.set(memberId, group.id)
      const memberMeta = meta.get(memberId)
      if (memberMeta) memberMeta.groupId = group.id
    }
    const memberMetas = group.variantIds
      .map((memberId) => meta.get(memberId))
      .filter((m): m is CatalogEntryMeta => m != null)
    const primaryMeta = meta.get(group.primaryId)
    let bestRating: RatingEvidence | null = null
    let bestBayesian = bayesianRating(null, null)
    for (const member of memberMetas) {
      if (member.rating && member.bayesian > bestBayesian) {
        bestBayesian = member.bayesian
        bestRating = member.rating
      } else if (member.rating && bestRating == null) {
        bestRating = member.rating
        bestBayesian = member.bayesian
      }
    }
    const addedValues = memberMetas
      .map((m) => m.addedMs)
      .filter((v): v is number => v != null)
    groupAggregates.set(group.id, {
      groupId: group.id,
      primaryId: group.primaryId,
      normalisedTitle: primaryMeta?.normalisedTitle ?? "",
      year: primaryMeta?.year ?? memberMetas.map((m) => m.year).find((y) => y != null) ?? null,
      addedMs: addedValues.length ? Math.max(...addedValues) : null,
      rating: bestRating,
      bayesian: bestRating ? bestBayesian : bayesianRating(null, null),
      runtimeMinutes:
        primaryMeta?.runtimeMinutes ?? memberMetas.map((m) => m.runtimeMinutes).find((r) => r != null) ?? null,
      genreIds: orderGenreIds(memberMetas.flatMap((m) => m.genreIds), kind),
      hasPoster: memberMetas.some((m) => m.hasPoster),
    })
  }

  const primaryIds = groups.map((g) => g.primaryId)
  const aggregateOf = (primaryId: string): GroupAggregate | undefined =>
    groupAggregates.get(groupIdByEntryId.get(primaryId) ?? "")

  // Display-level genre/category/decade maps (distinct displayed titles).
  const idsByGenre = new Map<string, string[]>()
  const idsByProviderCategory = new Map<string, string[]>()
  const idsByDecade = new Map<string, string[]>()
  const pushTo = (map: Map<string, string[]>, key: string, value: string) => {
    const bucket = map.get(key)
    if (bucket) bucket.push(value)
    else map.set(key, [value])
  }
  for (const group of groups) {
    const aggregate = groupAggregates.get(group.id)!
    if (aggregate.genreIds.length) {
      for (const genreId of aggregate.genreIds) pushTo(idsByGenre, genreId, group.primaryId)
    } else {
      pushTo(idsByGenre, UNCATEGORISED_ID, group.primaryId)
    }
    const categoryKeys = new Set(
      group.variantIds
        .map((memberId) => meta.get(memberId)?.providerCategoryKey ?? "")
        .filter(Boolean),
    )
    for (const key of categoryKeys) pushTo(idsByProviderCategory, key, group.primaryId)
    pushTo(idsByDecade, aggregate.year == null ? "unknown" : decadeKeyForYear(aggregate.year), group.primaryId)
  }

  // Variant-inclusive maps (search / completeness).
  const allEntryIdsByGenre = new Map<string, string[]>()
  const allEntryIdsByProviderCategory = new Map<string, string[]>()
  for (const id of orderedIds) {
    const entryMeta = meta.get(id)!
    if (entryMeta.genreIds.length) {
      for (const genreId of entryMeta.genreIds) pushTo(allEntryIdsByGenre, genreId, id)
    } else {
      pushTo(allEntryIdsByGenre, UNCATEGORISED_ID, id)
    }
    if (entryMeta.providerCategoryKey) {
      pushTo(allEntryIdsByProviderCategory, entryMeta.providerCategoryKey, id)
    }
  }

  // Sorted id indexes. Comparators are total orders: key, title, id.
  // Sorts run over (id, aggregate) pairs — never over bare ids with a
  // Map lookup per comparison (that costs ~2s per 8 sorts at 50k).
  // The rating comparator inlines compareByRatingEvidence's semantics
  // (unrated last; Bayesian desc; votes desc; raw score desc) over
  // the precomputed aggregate fields.
  const pairs = primaryIds
    .map((id) => ({ id, aggregate: aggregateOf(id) }))
    .filter((pair): pair is { id: string; aggregate: GroupAggregate } => pair.aggregate != null)
  const nullsLastDesc = (a: number | null, b: number | null): number => {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    return b - a
  }
  const nullsLastAsc = (a: number | null, b: number | null): number => {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    return a - b
  }
  const sortPairs = (
    keyCompare: (a: GroupAggregate, b: GroupAggregate) => number,
  ): string[] =>
    [...pairs]
      .sort(
        (a, b) =>
          keyCompare(a.aggregate, b.aggregate) ||
          compareTitle(a.aggregate.normalisedTitle, b.aggregate.normalisedTitle) ||
          compareId(a.id, b.id),
      )
      .map((pair) => pair.id)
  const compareRatingAggregates = (a: GroupAggregate, b: GroupAggregate): number => {
    if (!a.rating && !b.rating) return 0
    if (!a.rating) return 1
    if (!b.rating) return -1
    return (
      b.bayesian - a.bayesian ||
      (b.rating.voteCount ?? 0) - (a.rating.voteCount ?? 0) ||
      b.rating.score10 - a.rating.score10
    )
  }

  const sortedIds: SortedIdIndexes = {
    catalogue: [...primaryIds],
    added: sortPairs((a, b) => nullsLastDesc(a.addedMs, b.addedMs)),
    yearDesc: sortPairs((a, b) => nullsLastDesc(a.year, b.year)),
    yearAsc: sortPairs((a, b) => nullsLastAsc(a.year, b.year)),
    rating: sortPairs(compareRatingAggregates),
    titleAsc: [...pairs]
      .sort((a, b) => compareTitle(a.aggregate.normalisedTitle, b.aggregate.normalisedTitle) || compareId(a.id, b.id))
      .map((pair) => pair.id),
    titleDesc: [...pairs]
      .sort((a, b) => compareTitle(b.aggregate.normalisedTitle, a.aggregate.normalisedTitle) || compareId(a.id, b.id))
      .map((pair) => pair.id),
    runtimeAsc: sortPairs((a, b) => nullsLastAsc(a.runtimeMinutes, b.runtimeMinutes)),
    runtimeDesc: sortPairs((a, b) => nullsLastDesc(a.runtimeMinutes, b.runtimeMinutes)),
  }

  return {
    kind,
    revision,
    playlistId,
    entries: catalogue,
    byId,
    meta,
    groupAggregates,
    idsByGenre,
    allEntryIdsByGenre,
    idsByProviderCategory,
    allEntryIdsByProviderCategory,
    idsByDecade,
    sortedIds,
    groups,
    groupById,
    groupIdByEntryId,
    totalEntries: orderedIds.length,
    totalGroups: groups.length,
    skippedRows,
    duplicateIdsSkipped,
    builtAt: Date.now(),
    seq: ++catalogIndexBuildSeq,
  }
}

// ── Revision-aware caching ───────────────────────────────────────────
// Keyed by catalogue array identity (WeakMap: a refresh that replaces
// the array drops the stale index with it) + kind + catalogue
// revision + metadata revision + playlist + cache buster. Same
// revision + same playlist + same array returns the cached index
// without rebuilding; any revision bump rebuilds.

/** Monotonic build sequence for CatalogIndex.seq (D36). */
let catalogIndexBuildSeq = 0

const indexCacheByCatalogue = new WeakMap<object, Map<string, CatalogIndex>>()
const cacheRecords = new Set<{ kind: CatalogKind; catalogue: WeakRef<object>; key: string }>()

function cacheKeyFor(
  kind: CatalogKind,
  revision: string,
  metadataRevision: string,
  opts: CatalogIndexOptions,
): string {
  return [kind, revision, metadataRevision, opts.playlistId ?? "", opts.cacheBuster ?? ""].join("|")
}

function pruneCacheRecords(): void {
  if (cacheRecords.size <= 64) return
  for (const record of [...cacheRecords]) {
    if (record.catalogue.deref() == null) cacheRecords.delete(record)
  }
}

/**
 * Get (or build) the prepared index for a catalogue. Same revision +
 * same playlist + same catalogue array returns the cached index.
 * Profile data is never an input here — layer it separately with
 * createProfileLayer so favourite/progress changes never rebuild.
 */
export function getCatalogIndex(
  kind: unknown,
  catalogue: CatalogRow[] | null | undefined,
  revision: CatalogRevision,
  opts: CatalogIndexOptions = {},
): CatalogIndex {
  const normalisedKind = normaliseCatalogKind(kind)
  const { revision: revisionString, metadataRevision } = revisionParts(revision, opts)
  const key = cacheKeyFor(normalisedKind, revisionString, metadataRevision, opts)
  const catalogueRef: object = catalogue ?? EMPTY_CATALOGUE
  const inner = indexCacheByCatalogue.get(catalogueRef)
  const cached = inner?.get(key)
  if (cached) {
    noteCatalogIndexCacheHit()
    return cached
  }
  const built = buildCatalogIndex(normalisedKind, catalogue, revision, opts)
  const bucket = inner ?? new Map<string, CatalogIndex>()
  bucket.set(key, built)
  if (!inner) indexCacheByCatalogue.set(catalogueRef, bucket)
  cacheRecords.add({ kind: normalisedKind, catalogue: new WeakRef(catalogueRef), key })
  pruneCacheRecords()
  return built
}

const EMPTY_CATALOGUE: CatalogRow[] = []

/**
 * Invalidate cached indexes for a kind (or all kinds when omitted).
 * Call on playlist switches and catalogue/metadata revision changes
 * that bypass getCatalogIndex's revision key. Also clears the
 * provider-category registry (rebuilds re-register before use).
 */
export function invalidateCatalogIndex(kind?: unknown): void {
  const normalised = kind == null ? null : normaliseCatalogKind(kind)
  for (const record of [...cacheRecords]) {
    const catalogue = record.catalogue.deref()
    if (catalogue == null) {
      cacheRecords.delete(record)
      continue
    }
    if (normalised != null && record.kind !== normalised) continue
    indexCacheByCatalogue.get(catalogue)?.delete(record.key)
    cacheRecords.delete(record)
  }
}

// ── Profile layer (separate from the provider index) ─────────────────

export interface ProfileProgressValue {
  /** Progress fraction in [0, 1]. */
  fraction: number
  completed?: boolean
  updatedAt?: number
  /** Owning series id for episode progress (roll-up key). */
  seriesId?: string | number | null
}

export interface ProfileLayerInput {
  progress?: Map<string, ProfileProgressValue> | Record<string, ProfileProgressValue> | null
  favouriteIds?: Iterable<string | number> | null
  watchLaterIds?: Iterable<string | number> | null
  followedSeriesIds?: Iterable<string | number> | null
}

export interface ProfileLayer {
  /** Caller-supplied revision ("" when none — selectors then skip caching). */
  revision: string
  progressById: Map<string, { fraction: number; completed: boolean; updatedAt: number; seriesId: string | null }>
  favouriteIds: Set<string>
  watchLaterIds: Set<string>
  followedSeriesIds: Set<string>
}

function idSetOf(values: Iterable<string | number> | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!values) return out
  for (const value of values) {
    const id = String(value ?? "").trim()
    if (id) out.add(id)
  }
  return out
}

/**
 * Build the lightweight profile overlay for an index. Cheap (no
 * catalogue scan, no rebuild): callers rebuild this on every
 * favourite/progress change while the provider index stays cached.
 * Pass a stable `revision` (e.g. the profile store's updatedAt) so
 * collection selectors can cache against profile+taste revisions.
 */
export function createProfileLayer(
  input: ProfileLayerInput | null | undefined,
  revision?: string | number | null,
): ProfileLayer {
  const progressById: ProfileLayer["progressById"] = new Map()
  const raw = input?.progress
  const entries: Array<[string, ProfileProgressValue]> = []
  if (raw instanceof Map) {
    for (const [key, value] of raw) entries.push([String(key), value])
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) entries.push([key, value])
  }
  for (const [key, value] of entries) {
    if (!value || typeof value !== "object") continue
    const fraction = Number(value.fraction)
    progressById.set(key, {
      fraction: Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0,
      completed: !!value.completed,
      updatedAt: Number(value.updatedAt) || 0,
      seriesId: value.seriesId == null ? null : String(value.seriesId),
    })
  }
  return {
    revision: revision == null ? "" : String(revision),
    progressById,
    favouriteIds: idSetOf(input?.favouriteIds),
    watchLaterIds: idSetOf(input?.watchLaterIds),
    followedSeriesIds: idSetOf(input?.followedSeriesIds),
  }
}

// ── Normalised title search ──────────────────────────────────────────

export interface CatalogSearchScope {
  /** Canonical genre/family id (or UNCATEGORISED_ID). Omit for all titles. */
  genreId?: string | null
}

/**
 * Ranked normalised-title search over the index, returning DISPLAYED
 * group primary ids. Matches full/partial titles across cleaned
 * variants, alternative/original titles, punctuation normalisation
 * and provider prefixes/suffixes (all stripped at build time). A
 * year in the query disambiguates: same-year groups rank higher, and
 * far-year groups rank lower — but a strong title match is never
 * excluded on year alone. Empty/blank queries return [].
 */
export function searchCatalogIndex(
  index: CatalogIndex,
  query: string | null | undefined,
  scope: CatalogSearchScope | null,
  limit = 100,
): string[] {
  if (!index || !query || !query.trim()) return []
  const cleaned = cleanProviderTitle(query.trim())
  const queryNorm = searchNorm(cleaned.variants[0] || query)
  const queryYear = cleaned.year ?? parseYear(query)
  // The year token is handled by the year bonus/disambiguation below,
  // never by token matching — otherwise a year-only query ("1995")
  // could only match titles carrying the year in the name itself.
  const tokens = queryNorm
    .split(" ")
    .filter(Boolean)
    .filter((token) => queryYear == null || token !== String(queryYear))
  const cappedLimit = Math.max(1, Math.min(500, Math.floor(limit) || 100))

  const pool =
    scope?.genreId != null && scope.genreId !== ""
      ? index.idsByGenre.get(scope.genreId) ?? []
      : index.sortedIds.catalogue

  // Year-only query: exact-year groups, title order.
  if (!tokens.length) {
    if (queryYear == null) return []
    const yearMatches = pool.filter((primaryId) => {
      const aggregate = index.groupAggregates.get(index.groupIdByEntryId.get(primaryId) ?? "")
      return aggregate?.year === queryYear
    })
    return yearMatches
      .sort((a, b) => {
        const aggregateA = index.groupAggregates.get(index.groupIdByEntryId.get(a) ?? "")
        const aggregateB = index.groupAggregates.get(index.groupIdByEntryId.get(b) ?? "")
        return (
          compareTitle(aggregateA?.normalisedTitle ?? "", aggregateB?.normalisedTitle ?? "") ||
          compareId(a, b)
        )
      })
      .slice(0, cappedLimit)
  }

  const scored: Array<{ id: string; score: number; title: string }> = []
  for (const primaryId of pool) {
    const groupId = index.groupIdByEntryId.get(primaryId)
    const group = groupId ? index.groupById.get(groupId) : undefined
    const aggregate = groupId ? index.groupAggregates.get(groupId) : undefined
    if (!group || !aggregate) continue
    let best = 0
    for (const memberId of group.variantIds) {
      const memberMeta = index.meta.get(memberId)
      if (!memberMeta) continue
      for (const variant of memberMeta.titleVariants) {
        let titleScore = 0
        if (variant === queryNorm) titleScore = 1000
        else if (variant.startsWith(queryNorm)) titleScore = 800
        else {
          const tokenScore = scoreNormMatch(variant, tokens)
          if (tokenScore > 0) titleScore = 300 + tokenScore
          else {
            const matchedTokens = tokens.filter((token) => variant.includes(token)).length
            if (matchedTokens > 0) titleScore = 50 + matchedTokens * 10
          }
        }
        if (titleScore > best) best = titleScore
      }
    }
    if (best <= 0) continue
    if (queryYear != null && aggregate.year != null) {
      const diff = Math.abs(aggregate.year - queryYear)
      if (diff === 0) best += 200
      else if (diff === 1) best += 100
      else best -= 300
    }
    scored.push({ id: primaryId, score: best, title: aggregate.normalisedTitle })
  }
  scored.sort((a, b) => b.score - a.score || compareTitle(a.title, b.title) || compareId(a.id, b.id))
  return scored.slice(0, cappedLimit).map((entry) => entry.id)
}
