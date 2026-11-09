// V1 suggestions engine: similarity matching against the library.
//
// NOT an LLM call (that is a later step). For each person this takes the
// titles they actually watched (and loved) and finds more like them using
// the app's existing local similarity heuristic — same Xtream category
// (the provider's genre grouping), shared cast, same director — via
// buildBecauseRow / pickLocalSimilar. "Mood" is not in the provider data,
// so it is not a signal here; the rails say plainly what they do
// ("Based on what Ciaran watched") and never claim an AI picked them.
//
// Sources of truth:
//   - Shared (household) profile: the app's own getWatchedSignals +
//     favorites from preferences.js.
//   - Ciaran / Aisling: their namespaced history + favorites in
//     profiles.ts (one-time claim of the shared history on first pick,
//     then whatever they watch while their profile is active).
// Cold start: no history means no suggestions — the rail says so
// honestly instead of inventing picks.

import {
  buildBecauseRow,
  pickBecauseSeedPool,
  type BecauseSeed,
} from "@/scripts/lib/because-watched.ts"
import {
  parseProviderPeople,
  type LocalSimilarInfo,
} from "@/scripts/lib/similar-local.ts"
import {
  getCached,
  getCachedByKindPrefix,
  hydrate as hydrateCache,
} from "@/scripts/lib/cache.js"
import {
  getWatchedSignals,
  getFavorites,
} from "@/scripts/lib/preferences.js"
import {
  getProfileHistory,
  getProfileFavorites,
  ensureProfileClaimed,
  SHARED_PROFILE_ID,
  type ProfileWatchedSignal,
} from "@/scripts/lib/profiles.ts"
import { cleanProviderTitle } from "@/scripts/lib/tmdb-match.ts"
import { fmtImdbRating, ratingSortValue } from "@/scripts/lib/format.ts"
import { log } from "@/scripts/lib/log.js"
import type { RailItem } from "@/scripts/lib/rail-card.ts"

export interface SuggestionsResult {
  items: RailItem[]
  /** False when the profile has no watch history yet (cold start). */
  hasHistory: boolean
  /** Cleaned display names of the seeds that produced the row. */
  seedNames: string[]
}

const SUGGESTION_LIMIT = 12
const SEED_POOL_SIZE = 5
const PER_SEED_LIMIT = 12

function providerInfoForVod(cachedData: any): any {
  return cachedData?.info || cachedData?.movie_data || cachedData || {}
}

function buildInfoLookup(
  rows: Array<{ kind: string; data: any }>,
  prefixLength: number,
  kind: "vod" | "series"
): (id: number | string) => LocalSimilarInfo | null {
  const mapEntries = rows
    .map((row) => {
      const id = Number(row.kind.slice(prefixLength))
      if (!Number.isFinite(id)) return null
      const info =
        kind === "vod" ? providerInfoForVod(row.data) : row.data?.info || {}
      return [id, parseProviderPeople(info)] as const
    })
    .filter((entry): entry is readonly [number, LocalSimilarInfo] => !!entry)
  const map = new Map(mapEntries)
  return (id) => map.get(Number(id)) || null
}

async function loadCatalog(
  playlistId: string,
  kind: "vod" | "series"
): Promise<any[]> {
  await hydrateCache(playlistId, kind)
  return getCached(playlistId, kind)?.data || []
}

async function loadInfoLookup(
  playlistId: string,
  kind: "vod" | "series"
): Promise<(id: number | string) => LocalSimilarInfo | null> {
  const prefix = kind === "vod" ? "vod_info_" : "series_info_"
  const rows = await getCachedByKindPrefix(playlistId, prefix)
  return buildInfoLookup(rows, prefix.length, kind)
}

function toRailItem(kind: "vod" | "series", row: any): RailItem {
  return {
    kind,
    id: Number(row.id),
    name: String(row.name || ""),
    logo: row.logo || null,
    year: String(row.year || ""),
    rating: fmtImdbRating(row.rating),
  }
}

/**
 * Suggestions for one profile. `profileId` is "ciaran", "aisling" or
 * "shared" (household — reads the app's shared store directly).
 */
export async function loadSuggestions(
  playlistId: string,
  profileId: string,
  options: { limit?: number } = {}
): Promise<SuggestionsResult> {
  const limit = options.limit ?? SUGGESTION_LIMIT
  if (!playlistId) return { items: [], hasHistory: false, seedNames: [] }

  let signals: ProfileWatchedSignal[]
  const favoriteKeys = new Set<string>()
  if (profileId === SHARED_PROFILE_ID) {
    signals = (getWatchedSignals(playlistId, 60) || []).map((signal) => ({
      kind: signal.kind,
      id: signal.id,
      name: signal.name ?? null,
      seriesId: signal.seriesId ?? null,
      seriesName: signal.seriesName ?? null,
      updatedAt: signal.updatedAt || 0,
      completed: !!signal.completed,
    }))
    for (const kind of ["vod", "series"] as const) {
      const ids = (getFavorites(playlistId, kind as any) ||
        new Set<number>()) as Set<number>
      for (const id of ids) favoriteKeys.add(`${kind}:${Number(id)}`)
    }
  } else {
    ensureProfileClaimed(playlistId, profileId)
    signals = getProfileHistory(profileId)
    for (const fav of getProfileFavorites(profileId)) {
      favoriteKeys.add(`${fav.kind}:${Number(fav.id)}`)
    }
  }

  const seeds = pickBecauseSeedPool(signals, SEED_POOL_SIZE)
  if (!seeds.length) return { items: [], hasHistory: false, seedNames: [] }

  // Never suggest something the profile already watched or favorited.
  const excluded = new Set<string>()
  for (const signal of signals) {
    if (signal.kind === "vod") excluded.add(`vod:${Number(signal.id)}`)
    else if (signal.seriesId != null) {
      excluded.add(`series:${Number(signal.seriesId)}`)
    }
  }
  for (const key of favoriteKeys) excluded.add(key)
  const isExcluded = (kind: "vod" | "series", id: number | string): boolean =>
    excluded.has(`${kind}:${Number(id)}`)

  const catalogByKind: Record<"vod" | "series", any[]> = {
    vod: [],
    series: [],
  }
  const infoLookupByKind: Record<
    "vod" | "series",
    (id: number | string) => LocalSimilarInfo | null
  > = {
    vod: () => null,
    series: () => null,
  }
  try {
    const [vodCatalog, seriesCatalog, vodInfo, seriesInfo] = await Promise.all([
      loadCatalog(playlistId, "vod"),
      loadCatalog(playlistId, "series"),
      loadInfoLookup(playlistId, "vod"),
      loadInfoLookup(playlistId, "series"),
    ])
    catalogByKind.vod = vodCatalog
    catalogByKind.series = seriesCatalog
    infoLookupByKind.vod = vodInfo
    infoLookupByKind.series = seriesInfo
  } catch (error) {
    log.warn("[nylah:suggestions] catalog load failed:", error)
    return { items: [], hasHistory: true, seedNames: [] }
  }

  // One similar-row per seed, merged round-robin in seed (recency) order.
  const perSeedRows: RailItem[][] = []
  const seedNames: string[] = []
  for (const seed of seeds) {
    const kind: "vod" | "series" = seed.kind === "series" ? "series" : "vod"
    const catalog = catalogByKind[kind]
    if (!catalog.length) continue
    const rows = buildBecauseRow(seed as BecauseSeed, catalog, {
      limit: PER_SEED_LIMIT,
      infoLookup: infoLookupByKind[kind],
      isWatched: (id) => isExcluded(kind, id),
    })
    if (!rows.length) continue
    seedNames.push(
      cleanProviderTitle(seed.name).variants[0] || seed.name
    )
    perSeedRows.push(rows.map((row) => toRailItem(kind, row)))
  }

  const items: RailItem[] = []
  const seen = new Set<string>()
  for (let round = 0; round < PER_SEED_LIMIT && items.length < limit; round++) {
    for (const rows of perSeedRows) {
      if (items.length >= limit) break
      const row = rows[round]
      if (!row) continue
      const key = `${row.kind}:${row.id}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(row)
    }
  }
  return { items, hasHistory: true, seedNames }
}

// ---------------------------------------------------------------------------
// Top rated — the highest-rated titles already in the library.
// ---------------------------------------------------------------------------

export interface TopRatedResult {
  items: RailItem[]
  /** The cutoff actually applied (8.0+ by default). */
  minRating: number
}

function groupKeyForEntry(row: any): string {
  const cleaned = cleanProviderTitle(String(row.name || ""))
  const titleKey = (cleaned.variants[0] || String(row.name || ""))
    .trim()
    .toLowerCase()
  if (!titleKey) return `id:${row.id}`
  const year = row.year ?? cleaned.year ?? ""
  return `${titleKey}|${year}`
}

/**
 * Highest-rated movies + series in the local catalog, at or above
 * `minRating` (default 8.0). The rating is the provider-supplied `rating`
 * field on each catalog row — the same value the app already renders as
 * an IMDb rating elsewhere (fmtImdbRating). There is no live IMDb lookup:
 * IMDb has no free official API and no IMDb key or endpoint exists in the
 * repo. Language-prefixed duplicates of one title collapse to the
 * highest-rated variant.
 */
export async function loadTopRated(
  playlistId: string,
  options: { minRating?: number; limit?: number } = {}
): Promise<TopRatedResult> {
  const minRating = options.minRating ?? 8.0
  const limit = options.limit ?? SUGGESTION_LIMIT
  if (!playlistId) return { items: [], minRating }

  const [vodRows, seriesRows] = await Promise.all([
    loadCatalog(playlistId, "vod"),
    loadCatalog(playlistId, "series"),
  ])

  const bestByGroup = new Map<string, RailItem & { score: number }>()
  for (const [kind, rows] of [
    ["vod", vodRows],
    ["series", seriesRows],
  ] as const) {
    for (const row of rows) {
      const score = ratingSortValue(row.rating)
      if (score < minRating) continue
      const key = groupKeyForEntry(row)
      const item: RailItem & { score: number } = {
        ...toRailItem(kind, row),
        score,
      }
      const existing = bestByGroup.get(key)
      if (!existing || item.score > existing.score) bestByGroup.set(key, item)
    }
  }

  const items = [...bestByGroup.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.name.localeCompare(b.name)
    })
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item)
  return { items, minRating }
}
