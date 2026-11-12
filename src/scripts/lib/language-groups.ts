// Groups VOD/series catalog rows by title across language variants, keyed by TMDb id with a title fallback.
import { cleanProviderTitle } from "./tmdb-match"
import { normalize } from "./text"
import { parseNamePrefix, prefixQualityTokens } from "./language-tags"
import { noteGroupRun } from "./browse-instrumentation"

export interface GroupableEntry {
  id: number
  name: string
  year?: string
  tmdb?: number | null
}

// Cached catalog rows go in as-is (ids, years and tmdb ids arrive as strings or numbers), so no view has to copy them.
export interface GroupableRow {
  id: number | string
  name?: string | null
  year?: string | number | null
  tmdb?: number | string | null
}

export interface GroupInfo {
  key: string
  entryIds: number[]
  tags: string[]
  multiVariant: boolean
}

export interface CatalogGroupingIndex {
  keyByEntryId: Map<number, string>
  tagByEntryId: Map<number, string | null>
  groupsByKey: Map<string, GroupInfo>
  qualityRankByEntryId: Map<number, number>
}

interface EntryMeta {
  tag: string | null
  tmdbKey: string | null
  titleKey: string
}

// Trailing variant tokens (0.11.8 integration fix, brief §13.2/§13.3):
// provider rows for the SAME title carry language/audio suffixes —
// "Title HINDI", "Title DUAL AUDIO", "Title TAMIL" — that
// cleanProviderTitle's quality-token strip does not remove, so the
// variants landed in separate groups and the language-variant shelf
// / detail behaviour split one title into several. These tokens are
// stripped ONLY at the very end of the cleaned title, iteratively
// ("DUAL AUDIO" strips as two passes), and only for the GROUPING
// KEY — display titles, search variants and TMDb matching are
// untouched. A mid-title occurrence ("The English Patient") never
// strips, because the match is anchored to the end. Token list
// mirrors the W5 contract's variant vocabulary.
const TRAILING_VARIANT_TOKENS = new Set([
  "hindi", "tamil", "telugu", "malayalam", "kannada", "punjabi",
  "bengali", "marathi", "english", "spanish", "french", "german",
  "dual", "audio", "multi", "dubbed", "subbed", "subs", "esub",
  "uncut", "extended", "remux", "proper", "repack",
])

function stripTrailingVariantTokens(title: string): string {
  let current = String(title || "").trim().replace(/\s+/g, " ")
  for (;;) {
    const match = current.match(/[-–—:]?\s*([A-Za-z0-9+]+)\s*$/)
    if (!match) break
    if (!TRAILING_VARIANT_TOKENS.has(match[1].toLowerCase())) break
    const stripped = current.slice(0, match.index).trim()
    if (!stripped) break
    if (stripped === current) break
    current = stripped
  }
  return current.replace(/[-–—:,\s]+$/, "").trim()
}

function computeTitleKey(
  entry: GroupableRow,
  entryId: number,
  name: string,
  prefix: { tag: string | null; rest: string }
): string {
  // Strip the prefix via parseNamePrefix first: it handles compound prefixes ("4K-FR - ") that cleanProviderTitle's regex does not.
  const { tag, rest } = prefix
  const { variants, year } = cleanProviderTitle(tag != null ? rest : name)
  const normalizedTitle = normalize(stripTrailingVariantTokens(variants[0] || ""))
  if (!normalizedTitle) return `e:${entryId}`
  const resolvedYear = year != null ? String(year) : entry.year || ""
  return `${normalizedTitle}|${resolvedYear}`
}

function distinctTagsInOrder(entryIds: number[], tagByEntryId: Map<number, string | null>): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const entryId of entryIds) {
    const tag = tagByEntryId.get(entryId)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

export function buildGroupingIndex(entries: GroupableRow[]): CatalogGroupingIndex {
  const keyByEntryId = new Map<number, string>()
  const tagByEntryId = new Map<number, string | null>()
  const groupsByKey = new Map<string, GroupInfo>()
  const qualityRankByEntryId = new Map<number, number>()

  const metaByEntryId = new Map<number, EntryMeta>()
  const tmdbGroupEntryIds = new Map<string, number[]>()
  const titleKeyToTmdbKeys = new Map<string, Set<string>>()

  for (const entry of entries) {
    const entryId = Number(entry.id)
    const name = entry.name || ""
    const prefix = parseNamePrefix(name)
    const tag = prefix.tag
    const tmdbNumber = Number(entry.tmdb)
    const tmdbKey = tmdbNumber > 0 ? `t:${tmdbNumber}` : null
    const titleKey = computeTitleKey(entry, entryId, name, prefix)
    metaByEntryId.set(entryId, { tag, tmdbKey, titleKey })
    tagByEntryId.set(entryId, tag)
    qualityRankByEntryId.set(entryId, prefixQualityTokens(name).length)

    if (!tmdbKey) continue
    const tmdbBucket = tmdbGroupEntryIds.get(tmdbKey)
    if (tmdbBucket) tmdbBucket.push(entryId)
    else tmdbGroupEntryIds.set(tmdbKey, [entryId])

    const bridgedTmdbKeys = titleKeyToTmdbKeys.get(titleKey)
    if (bridgedTmdbKeys) bridgedTmdbKeys.add(tmdbKey)
    else titleKeyToTmdbKeys.set(titleKey, new Set([tmdbKey]))
  }

  // Merge non-tmdb entries into a tmdb group only when their title key bridges to exactly one tmdb id.
  const remainingEntryIds: number[] = []
  for (const [entryId, meta] of metaByEntryId) {
    if (meta.tmdbKey) continue
    const bridgedTmdbKeys = titleKeyToTmdbKeys.get(meta.titleKey)
    if (bridgedTmdbKeys && bridgedTmdbKeys.size === 1) {
      const [onlyTmdbKey] = bridgedTmdbKeys
      tmdbGroupEntryIds.get(onlyTmdbKey)!.push(entryId)
      continue
    }
    remainingEntryIds.push(entryId)
  }

  for (const [tmdbKey, entryIds] of tmdbGroupEntryIds) {
    const tags = distinctTagsInOrder(entryIds, tagByEntryId)
    groupsByKey.set(tmdbKey, { key: tmdbKey, entryIds, tags, multiVariant: entryIds.length > 1 })
    for (const entryId of entryIds) keyByEntryId.set(entryId, tmdbKey)
  }

  const titleBuckets = new Map<string, number[]>()
  for (const entryId of remainingEntryIds) {
    const titleKey = metaByEntryId.get(entryId)!.titleKey
    const bucket = titleBuckets.get(titleKey)
    if (bucket) bucket.push(entryId)
    else titleBuckets.set(titleKey, [entryId])
  }

  for (const [titleKey, entryIds] of titleBuckets) {
    const untaggedEntryIds = entryIds.filter((entryId) => tagByEntryId.get(entryId) == null)
    for (const entryId of untaggedEntryIds) {
      const key = `e:${entryId}`
      groupsByKey.set(key, { key, entryIds: [entryId], tags: [], multiVariant: false })
      keyByEntryId.set(entryId, key)
    }

    // Require 2+ DISTINCT tags (not just 2+ members) so same-language dupes don't merge.
    const taggedEntryIds = entryIds.filter((entryId) => tagByEntryId.get(entryId) != null)
    const distinctTags = distinctTagsInOrder(taggedEntryIds, tagByEntryId)
    if (distinctTags.length >= 2) {
      const key = `n:${titleKey}`
      groupsByKey.set(key, { key, entryIds: taggedEntryIds, tags: distinctTags, multiVariant: true })
      for (const entryId of taggedEntryIds) keyByEntryId.set(entryId, key)
    } else {
      for (const entryId of taggedEntryIds) {
        const key = `e:${entryId}`
        const tag = tagByEntryId.get(entryId) ?? null
        groupsByKey.set(key, { key, entryIds: [entryId], tags: tag ? [tag] : [], multiVariant: false })
        keyByEntryId.set(entryId, key)
      }
    }
  }

  return { keyByEntryId, tagByEntryId, groupsByKey, qualityRankByEntryId }
}

// Lowest quality rank (fewest quality tokens, so plain beats "4K") wins within a bucket.
function pickLowestQualityInBucket(
  bucket: number[],
  qualityRankByEntryId?: Map<number, number>
): number {
  if (!qualityRankByEntryId || bucket.length <= 1) return bucket[0]
  let best = bucket[0]
  let bestRank = qualityRankByEntryId.get(best) ?? 0
  for (let index = 1; index < bucket.length; index++) {
    const candidateId = bucket[index]
    const candidateRank = qualityRankByEntryId.get(candidateId) ?? 0
    if (candidateRank < bestRank) {
      best = candidateId
      bestRank = candidateRank
    }
  }
  return best
}

export function pickPreferredEntryId(
  entryIds: number[],
  tagByEntryId: Map<number, string | null>,
  preferredTags: string[],
  qualityRankByEntryId?: Map<number, number>
): number {
  for (const preferredTag of preferredTags) {
    const bucket = entryIds.filter((entryId) => tagByEntryId.get(entryId) === preferredTag)
    if (bucket.length) return pickLowestQualityInBucket(bucket, qualityRankByEntryId)
  }
  const untaggedBucket = entryIds.filter((entryId) => tagByEntryId.get(entryId) == null)
  if (untaggedBucket.length) return pickLowestQualityInBucket(untaggedBucket, qualityRankByEntryId)
  return pickLowestQualityInBucket(entryIds, qualityRankByEntryId)
}

export interface DisplayGroup<T> {
  key: string
  entries: T[]
  tags: string[]
  globalEntryIds: number[]
  displayEntry: T
}

/** Collapses grouped entries down to one display entry per group, picking the variant matching preferredTags. */
export function collapseIntoDisplayGroups<T extends { id: number }>(
  entries: T[],
  groupingIndex: CatalogGroupingIndex,
  preferredTags: string[]
): DisplayGroup<T>[] {
  const groupOrder: string[] = []
  const survivorsByKey = new Map<string, T[]>()
  for (const entry of entries) {
    const groupKey = groupingIndex.keyByEntryId.get(entry.id) ?? `e:${entry.id}`
    let survivors = survivorsByKey.get(groupKey)
    if (!survivors) {
      survivors = []
      survivorsByKey.set(groupKey, survivors)
      groupOrder.push(groupKey)
    }
    survivors.push(entry)
  }

  const displayGroups: DisplayGroup<T>[] = []
  for (const groupKey of groupOrder) {
    const survivors = survivorsByKey.get(groupKey)!
    const globalInfo = groupingIndex.groupsByKey.get(groupKey)
    const ownTag = groupingIndex.tagByEntryId.get(survivors[0].id) ?? null
    const tags = globalInfo ? globalInfo.tags : ownTag ? [ownTag] : []
    const globalEntryIds = globalInfo ? globalInfo.entryIds : [survivors[0].id]

    const survivorIds = survivors.map((entry) => entry.id)
    const displayEntryId = pickPreferredEntryId(
      survivorIds,
      groupingIndex.tagByEntryId,
      preferredTags,
      groupingIndex.qualityRankByEntryId
    )
    const displayEntry = survivors.find((entry) => entry.id === displayEntryId) || survivors[0]

    displayGroups.push({ key: groupKey, entries: survivors, tags, globalEntryIds, displayEntry })
  }

  return displayGroups
}

export function groupPassesLanguageFilter(tags: string[], selected: string): boolean {
  if (!selected) return true
  if (!tags.length) return true
  return tags.includes(selected)
}

// Grouping a catalog is expensive (~800ms at 176k rows), so memoize per playlist and catalog reference.
export function createGroupingIndexMemo() {
  let cache: { playlistId: string | null; catalogRef: GroupableRow[]; index: CatalogGroupingIndex } | null = null

  return function getGroupingIndexFor(playlistId: string | null, catalog: GroupableRow[]): CatalogGroupingIndex {
    if (cache && cache.playlistId === playlistId && cache.catalogRef === catalog) {
      return cache.index
    }
    const index = getSharedGroupingIndex(catalog)
    cache = { playlistId, catalogRef: catalog, index }
    return index
  }
}

const LANGUAGE_GROUPING_KEY = "xt_lang_grouping"

/** True only when the user explicitly opted in, distinct from the feature's default-on state. */
export function isLanguageGroupingExplicitlyEnabled(): boolean {
  try {
    return localStorage.getItem(LANGUAGE_GROUPING_KEY) === "1"
  } catch {
    return false
  }
}

const sharedIndexByRows = new WeakMap<object, CatalogGroupingIndex>()

/**
 * One index per catalog array identity, shared across views and navigations. The cached catalog
 * array is the key, so a refresh that replaces it drops the stale index with it.
 */
export function getSharedGroupingIndex(rows: GroupableRow[]): CatalogGroupingIndex {
  const cached = sharedIndexByRows.get(rows)
  if (cached) return cached
  const index = buildGroupingIndex(rows)
  sharedIndexByRows.set(rows, index)
  return index
}

// ── 0.11.8 W1: safe title grouping (brief §13 / §1.6) ───────────────────
// groupEntries() is the display-level grouping API the Movies & Series
// 2.0 homes and Browse engine consume. It reuses buildGroupingIndex()
// above — the richer variant handling (TMDb bridging, distinct-tag
// rule, compound prefixes) — and adds the §13 safety contract on top:
//
//   - NEVER group a movie with a series: entries are partitioned by
//     kind first (TMDb movie ids and TV ids share one namespace, so a
//     shared TMDb id across kinds is NOT shared identity), and group
//     ids are kind-prefixed.
//   - NEVER group distinct films with similar titles: grouping uses
//     exactly buildGroupingIndex's conservative rules (shared verified
//     TMDb identity, or cleaned title + year with 2+ DISTINCT language
//     tags). Same-tag dupes, ambiguous bridges and uncertain matches
//     stay SEPARATE — a duplicate poster is less harmful than hiding
//     the right film.
//   - Counts reflect displayed groups: one TitleGroup is one displayed
//     title, whatever the variant count.

export type TitleGroupKind = "vod" | "series"
export type TitleGroupConfidence = "high" | "medium"

export interface TitleGroup {
  /** Kind-prefixed group key, e.g. "vod:t:12345", "series:n:the batman|2022", "vod:e:7". */
  id: string
  /** String id of the deterministic representative entry (untagged / lowest quality-rank wins). */
  primaryId: string
  /**
   * EVERY member id INCLUDING the primary, primary first, the rest in
   * catalogue order. Callers iterating variants get the full set; use
   * primaryId (or primaryEntryFor) to find the representative.
   */
  variantIds: string[]
  kind: TitleGroupKind
  /** Verified TMDb id when the group is TMDb-keyed. Absent otherwise — never guessed. */
  tmdbId?: number
  /** Resolved year (primary's, else the first known member year). Absent when unknown. */
  year?: number
  /**
   * "high": shared verified TMDb identity with consistent years, or a
   * singleton (identity is itself — no merge risk). "medium": title +
   * year grouping, or a TMDb group whose members' known years
   * conflict (provider year noise; the TMDb identity still holds).
   * Uncertain matches never become groups at all.
   */
  confidence: TitleGroupConfidence
  /** Distinct language tags present across variants, in catalogue order. */
  tags?: string[]
}

/** A groupable row that may also carry an explicit kind marker. */
export interface GroupableEntryInput extends GroupableRow {
  kind?: unknown
  type?: unknown
  mediaType?: unknown
}

/**
 * The index argument for groupEntries: a CatalogIndex-like object
 * (structural — this module never imports catalog-index.ts), a kind
 * string, or null. Defaults to "vod" when nothing says otherwise.
 */
export type GroupEntriesIndexLike =
  | { kind?: string | null }
  | TitleGroupKind
  | "movie"
  | "tv"
  | null
  | undefined

function kindFromValue(value: unknown): TitleGroupKind | null {
  const text = String(value ?? "").trim().toLowerCase()
  if (text === "series" || text === "tv" || text === "show") return "series"
  if (text === "vod" || text === "movie" || text === "film") return "vod"
  return null
}

function resolveGroupKind(index: GroupEntriesIndexLike): TitleGroupKind {
  if (typeof index === "string") return kindFromValue(index) ?? "vod"
  if (index && typeof index === "object") return kindFromValue(index.kind) ?? "vod"
  return "vod"
}

function resolveEntryKind(entry: GroupableEntryInput, fallback: TitleGroupKind): TitleGroupKind {
  for (const field of [entry.kind, entry.type, entry.mediaType]) {
    const resolved = kindFromValue(field)
    if (resolved) return resolved
  }
  return fallback
}

function parseEntryYear(entry: GroupableRow): number | null {
  const raw = entry.year
  if (raw != null && raw !== "") {
    const match = String(raw).match(/(\d{4})/)
    if (match) {
      const year = Number(match[1])
      if (year >= 1900 && year <= 2100) return year
    }
  }
  const { year } = cleanProviderTitle(entry.name || "")
  return year
}

interface TitleGroupRegistryEntry {
  group: TitleGroup
  /** Reference to the primary row object (no copy) for primaryEntryFor. */
  primaryRow: GroupableRow
}

// Per-kind registries, replaced wholesale by each groupEntries() call
// for that kind, so a catalogue revision can never leave stale groups
// behind. TitleGroup objects are shared by reference with the returned
// array — the registry adds Map overhead only, no duplicated arrays.
const titleGroupRegistry = new Map<TitleGroupKind, Map<string, TitleGroupRegistryEntry>>()

/** Clear the group registries (tests). Catalog-index rebuilds replace them anyway. */
export function clearTitleGroupRegistry(): void {
  titleGroupRegistry.clear()
}

function registerTitleGroups(kind: TitleGroupKind, groups: TitleGroup[], primaryRowById: Map<string, GroupableRow>): void {
  const next = new Map<string, TitleGroupRegistryEntry>()
  for (const group of groups) {
    const primaryRow = primaryRowById.get(group.primaryId)
    if (primaryRow) next.set(group.id, { group, primaryRow })
  }
  titleGroupRegistry.set(kind, next)
}

/**
 * Group provider variants of the same title into displayed titles.
 * Entries are partitioned by kind, grouped per kind via
 * buildGroupingIndex, and returned in catalogue order (first member
 * appearance). The returned groups are registered so variantsFor() /
 * primaryEntryFor() can resolve them later by id.
 */
export function groupEntries(
  entries: GroupableEntryInput[],
  index?: GroupEntriesIndexLike,
): TitleGroup[] {
  noteGroupRun()
  const defaultKind = resolveGroupKind(index)
  const rows = entries || []

  // Catalogue position per numeric id (first occurrence wins), for
  // deterministic ordering and duplicate-id handling.
  const positionById = new Map<number, number>()
  const rowById = new Map<number, GroupableRow>()
  const partitions = new Map<TitleGroupKind, GroupableRow[]>()
  rows.forEach((entry, position) => {
    const numericId = Number(entry?.id)
    if (!Number.isFinite(numericId)) return
    if (positionById.has(numericId)) return
    positionById.set(numericId, position)
    rowById.set(numericId, entry)
    const kind = resolveEntryKind(entry, defaultKind)
    const bucket = partitions.get(kind)
    if (bucket) bucket.push(entry)
    else partitions.set(kind, [entry])
  })

  const groups: TitleGroup[] = []
  const primaryRowById = new Map<string, GroupableRow>()
  // First-appearance position per group, computed once: sorting by it
  // keeps group ordering O(n log n) instead of re-scanning member
  // positions on every comparison (50k groups x spread/min per compare).
  const orderKeyByGroupId = new Map<string, number>()

  for (const [kind, partition] of partitions) {
    const grouping = buildGroupingIndex(partition)
    const built: TitleGroup[] = []
    for (const info of grouping.groupsByKey.values()) {
      const memberIds = [...info.entryIds].sort(
        (a, b) => (positionById.get(a) ?? 0) - (positionById.get(b) ?? 0),
      )
      const primaryNumericId = pickPreferredEntryId(
        memberIds,
        grouping.tagByEntryId,
        [],
        grouping.qualityRankByEntryId,
      )
      const primaryId = String(primaryNumericId)
      const variantIds = [
        primaryId,
        ...memberIds.filter((id) => id !== primaryNumericId).map((id) => String(id)),
      ]
      const tmdbMatch = /^t:(\d+)$/.exec(info.key)
      const tmdbId = tmdbMatch ? Number(tmdbMatch[1]) : undefined

      const knownYears = memberIds
        .map((id) => parseEntryYear(rowById.get(id)!))
        .filter((year): year is number => year != null)
      const primaryYear = parseEntryYear(rowById.get(primaryNumericId)!)
      const year = primaryYear ?? knownYears[0]
      const yearsConflict =
        knownYears.length > 1 && Math.max(...knownYears) - Math.min(...knownYears) > 1
      const confidence: TitleGroupConfidence =
        info.key.startsWith("n:") || yearsConflict ? "medium" : "high"

      const group: TitleGroup = {
        id: `${kind}:${info.key}`,
        primaryId,
        variantIds,
        kind,
        confidence,
        tags: info.tags,
      }
      if (tmdbId != null) group.tmdbId = tmdbId
      if (year != null) group.year = year
      built.push(group)
    }
    const merged = mergeVariantSuffixSingletons(built, kind, rowById, positionById)
    for (const group of merged) {
      // First-appearance position: the earliest member's catalogue
      // position (variantIds are primary-first, not catalogue order).
      let firstPosition = Number.POSITIVE_INFINITY
      for (const variantId of group.variantIds) {
        const position = positionById.get(Number(variantId))
        if (position != null && position < firstPosition) firstPosition = position
      }
      orderKeyByGroupId.set(group.id, Number.isFinite(firstPosition) ? firstPosition : 0)
      const primaryRow = rowById.get(Number(group.primaryId))
      if (primaryRow) primaryRowById.set(group.primaryId, primaryRow)
    }
    merged.sort(
      (a, b) => (orderKeyByGroupId.get(a.id) ?? 0) - (orderKeyByGroupId.get(b.id) ?? 0),
    )
    registerTitleGroups(kind, merged, primaryRowById)
    groups.push(...merged)
  }

  // Cross-kind calls keep global catalogue order.
  groups.sort(
    (a, b) => (orderKeyByGroupId.get(a.id) ?? 0) - (orderKeyByGroupId.get(b.id) ?? 0),
  )
  return groups
}

/**
 * Conservative title|year merge for variant-suffix singletons
 * (0.11.8 integration fix, brief §13.1/§13.2).
 *
 * buildGroupingIndex keeps untagged entries as singletons and
 * requires 2+ distinct tags for title/year merges — the right
 * conservatism for the legacy views that consume it, but it splits
 * the common provider pattern "Title (2022) / Title (2022) 1080p /
 * Title (2022) [HINDI] / Title (2022) DUAL AUDIO" into separate
 * posters. This post-pass merges ONLY singleton groups that:
 *   - carry no TMDb identity (TMDb-verified singletons are distinct
 *     identities — an ambiguous bridge must never merge),
 *   - share one cleaned title key (variant/quality suffixes stripped)
 *     with a KNOWN year (year-less rows are uncertain — WWE Raw daily
 *     episodes stay separate),
 *   - and whose raw names DIFFER (a stripped variant marker explains
 *     the difference; exact-duplicate rows stay separate).
 * The merged group is "medium" confidence, kind-prefixed "n:", with
 * the lowest-quality-rank member as primary (plain beats 4K).
 */
function mergeVariantSuffixSingletons(
  built: TitleGroup[],
  kind: TitleGroupKind,
  rowById: Map<number, GroupableRow>,
  positionById: Map<number, number>,
): TitleGroup[] {
  const buckets = new Map<string, TitleGroup[]>()
  const passthrough: TitleGroup[] = []
  for (const group of built) {
    if (group.variantIds.length !== 1 || group.tmdbId != null) {
      passthrough.push(group)
      continue
    }
    const numericId = Number(group.primaryId)
    const row = rowById.get(numericId)
    if (!row) {
      passthrough.push(group)
      continue
    }
    const name = row.name || ""
    const titleKey = computeTitleKey(row, numericId, name, parseNamePrefix(name))
    if (titleKey.startsWith("e:")) {
      passthrough.push(group)
      continue
    }
    const yearPart = titleKey.slice(titleKey.lastIndexOf("|") + 1)
    if (!yearPart) {
      passthrough.push(group)
      continue
    }
    const bucket = buckets.get(titleKey)
    if (bucket) bucket.push(group)
    else buckets.set(titleKey, [group])
  }

  const out: TitleGroup[] = [...passthrough]
  for (const [titleKey, bucket] of buckets) {
    if (bucket.length === 1) {
      out.push(bucket[0])
      continue
    }
    const rawNames = new Set(
      bucket.map((group) => rowById.get(Number(group.primaryId))?.name || ""),
    )
    if (rawNames.size === 1) {
      out.push(...bucket)
      continue
    }
    const memberIds = bucket
      .map((group) => Number(group.primaryId))
      .sort((a, b) => (positionById.get(a) ?? 0) - (positionById.get(b) ?? 0))
    const tagByEntryId = new Map<number, string | null>()
    const qualityRankByEntryId = new Map<number, number>()
    for (const memberId of memberIds) {
      const name = rowById.get(memberId)?.name || ""
      tagByEntryId.set(memberId, parseNamePrefix(name).tag)
      qualityRankByEntryId.set(memberId, prefixQualityTokens(name).length)
    }
    const primaryNumericId = pickPreferredEntryId(
      memberIds,
      tagByEntryId,
      [],
      qualityRankByEntryId,
    )
    const primaryId = String(primaryNumericId)
    const knownYears = memberIds
      .map((id) => parseEntryYear(rowById.get(id)!))
      .filter((year): year is number => year != null)
    const year = parseEntryYear(rowById.get(primaryNumericId)!) ?? knownYears[0]
    const group: TitleGroup = {
      id: `${kind}:n:${titleKey}`,
      primaryId,
      variantIds: [
        primaryId,
        ...memberIds.filter((id) => id !== primaryNumericId).map((id) => String(id)),
      ],
      kind,
      confidence: "medium",
      tags: distinctTagsInOrder(memberIds, tagByEntryId),
    }
    if (year != null) group.year = year
    out.push(group)
  }
  return out
}

/**
 * The representative entry object for a group: the registry's primary
 * row reference when the group was built by groupEntries(), or the
 * matching row from `entries` when supplied. Returns null when the
 * group is unknown and no entries were supplied — callers holding a
 * CatalogIndex should use `index.byId.get(group.primaryId)` instead.
 */
export function primaryEntryFor(
  group: TitleGroup | string,
  entries?: Iterable<GroupableRow> | Map<unknown, GroupableRow> | null,
): GroupableRow | null {
  const groupId = typeof group === "string" ? group : group.id
  const primaryId = typeof group === "string" ? null : group.primaryId
  if (entries) {
    if (entries instanceof Map) {
      if (primaryId != null) {
        return entries.get(primaryId) ?? entries.get(Number(primaryId)) ?? null
      }
      return null
    }
    if (primaryId != null) {
      for (const entry of entries) {
        if (String(entry.id) === primaryId) return entry
      }
    }
    return null
  }
  for (const registry of titleGroupRegistry.values()) {
    const found = registry.get(groupId)
    if (found) return found.primaryRow
  }
  return null
}

/** Every variant id of a group (primary included, primary first), or [] when unknown. */
export function variantsFor(groupId: string): string[] {
  for (const registry of titleGroupRegistry.values()) {
    const found = registry.get(groupId)
    if (found) return [...found.group.variantIds]
  }
  return []
}

/**
 * A grouped title matches a language filter when ANY member variant
 * satisfies it (brief §13.4). Accepts a TitleGroup or a registered
 * group id; unknown groups match only the empty (no-filter) selection.
 */
export function titleGroupPassesLanguageFilter(
  group: TitleGroup | string,
  selected: string,
): boolean {
  if (!selected) return true
  const tags =
    typeof group === "string"
      ? [...titleGroupRegistry.values()].map((r) => r.get(group)?.group.tags).find(Boolean)
      : group.tags
  return groupPassesLanguageFilter(tags ?? [], selected)
}
