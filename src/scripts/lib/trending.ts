// Trending this week, matched to the household's own library.
//
// Source order (decided in the v0.2.0 redesign plan):
//   1. Google Trends daily trends — NO official API and NO key needed.
//      Fetched through the app's own providerFetch (Tauri plugin-http on
//      desktop, which is not subject to the webview's CORS rules; plain
//      window fetch in the browser). The unofficial daily-trends endpoint
//      is fragile: it 429s, changes shape, or is unreachable, and any
//      failure here is treated as "no Google data", never as an error to
//      paper over. Google titles are news-shaped, not movie-shaped, so
//      every candidate is matched against the library — only titles the
//      household can actually play are ever shown.
//   2. TMDb "Trending this week" — official API, via the existing client
//      (tmdb.ts). It needs the user's own TMDb API key, entered in
//      Settings (localStorage `xt_tmdb_key`, see app-settings.js). There is
//      no bundled key and no env key; with no key this path is skipped.
//   3. Neither — the rail shows an honest empty state, never invented
//      entries.
//
// The rail label always names the source that is actually live:
// "Trending on Google this week" only when Google data is live,
// "Trending this week" when the TMDb fallback is live.

import { providerFetch } from "@/scripts/lib/provider-fetch.js"
import { tmdbTrending } from "@/scripts/lib/tmdb.ts"
import { isTmdbActive } from "@/scripts/lib/app-settings.js"
import { matchTrendingToCatalog } from "@/scripts/lib/ambient-trending.ts"
import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
import { fmtImdbRating } from "@/scripts/lib/format.ts"
import { log } from "@/scripts/lib/log.js"

export type TrendingSource = "google" | "tmdb" | "none"

export type TrendingEmptyReason =
  | "no-library-match"
  | "no-tmdb-key"
  | "fetch-failed"

export interface TrendingRailItem {
  kind: "vod" | "series"
  id: number
  name: string
  logo: string | null
  year: string
  rating: string
}

export interface TrendingResult {
  source: TrendingSource
  items: TrendingRailItem[]
  /** Why the rail is empty, when it is — drives the honest empty message. */
  reason?: TrendingEmptyReason
}

const GOOGLE_TRENDS_URL =
  "https://trends.google.com/trends/api/dailytrends?hl=en-GB&tz=0&geo=IE&ns=15"
const GOOGLE_TIMEOUT_MS = 8000
const TRENDING_LIMIT = 12

const CACHE_KEY = "nylah_trending_cache_v1"
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

interface CachedTrending {
  playlistId: string
  at: number
  source: TrendingSource
  items: TrendingRailItem[]
}

function readCache(playlistId: string): TrendingResult | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedTrending
    if (
      !cached ||
      cached.playlistId !== playlistId ||
      !Array.isArray(cached.items) ||
      Date.now() - (cached.at || 0) > CACHE_TTL_MS
    ) {
      return null
    }
    return { source: cached.source, items: cached.items }
  } catch {
    return null
  }
}

function writeCache(playlistId: string, result: TrendingResult): void {
  if (!result.items.length) return
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        playlistId,
        at: Date.now(),
        source: result.source,
        items: result.items,
      } satisfies CachedTrending)
    )
  } catch {
    // Cache is a nicety; a full quota must never break the rail.
  }
}

function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return providerFetch(url, { signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  )
}

/** Pull the daily-trend search titles out of Google's unofficial JSON. */
function parseGoogleDailyTrends(text: string): string[] {
  const cleaned = text.replace(/^\)\]\}',?\s*/, "")
  let data: unknown
  try {
    data = JSON.parse(cleaned)
  } catch {
    return []
  }
  const days = (data as any)?.default?.trendingSearchesDays
  if (!Array.isArray(days)) return []
  const titles: string[] = []
  for (const day of days) {
    const searches = day?.trendingSearches
    if (!Array.isArray(searches)) continue
    for (const search of searches) {
      const query = search?.title?.query
      if (typeof query === "string" && query.trim()) titles.push(query.trim())
    }
  }
  return [...new Set(titles)]
}

async function fetchGoogleTrendTitles(): Promise<string[]> {
  const response = await fetchWithTimeout(GOOGLE_TRENDS_URL, GOOGLE_TIMEOUT_MS)
  if (!response.ok) {
    throw new Error(`Google Trends ${response.status}`)
  }
  return parseGoogleDailyTrends(await response.text())
}

async function loadCatalogRows(
  playlistId: string,
  kind: "vod" | "series"
): Promise<any[]> {
  await hydrateCache(playlistId, kind)
  return getCached(playlistId, kind)?.data || []
}

function toRailItem(kind: "vod" | "series", row: any): TrendingRailItem {
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
 * Match one trending list against both catalogs and tag each hit with its
 * kind, preserving trending order and capping the row.
 */
function matchToLibrary(
  trending: Array<{ tmdbId: number | null; name: string; year: number | null }>,
  vodRows: any[],
  seriesRows: any[],
  limit: number
): TrendingRailItem[] {
  const matched: TrendingRailItem[] = []
  const seen = new Set<string>()
  for (const row of matchTrendingToCatalog(trending, vodRows)) {
    const key = `vod:${row.id}`
    if (seen.has(key)) continue
    seen.add(key)
    matched.push(toRailItem("vod", row))
  }
  for (const row of matchTrendingToCatalog(trending, seriesRows)) {
    const key = `series:${row.id}`
    if (seen.has(key)) continue
    seen.add(key)
    matched.push(toRailItem("series", row))
  }
  // matchTrendingToCatalog preserves trending order within each kind; the
  // cross-kind merge above keeps movies first. Re-slice to the limit.
  return matched.slice(0, limit)
}

async function loadFromGoogle(
  vodRows: any[],
  seriesRows: any[]
): Promise<TrendingResult | null> {
  let titles: string[]
  try {
    titles = await fetchGoogleTrendTitles()
  } catch (error) {
    log.warn("[nylah:trending] Google Trends fetch failed:", error)
    return null
  }
  if (!titles.length) return null
  const items = matchToLibrary(
    titles.map((name) => ({ tmdbId: null, name, year: null })),
    vodRows,
    seriesRows,
    TRENDING_LIMIT
  )
  // Google returned data but nothing in it is in the library: that is a
  // real answer ("nothing trending is playable here"), not a fetch failure.
  return { source: "google", items, reason: items.length ? undefined : "no-library-match" }
}

async function loadFromTmdb(
  vodRows: any[],
  seriesRows: any[]
): Promise<TrendingResult | null> {
  if (!isTmdbActive()) return null
  const [movies, series] = await Promise.all([
    tmdbTrending("vod", "week"),
    tmdbTrending("series", "week"),
  ])
  // Interleave the two weekly lists so movies and series share the row.
  const merged: Array<{
    tmdbId: number | null
    name: string
    year: number | null
  }> = []
  const max = Math.max(movies.length, series.length)
  for (let i = 0; i < max; i++) {
    if (movies[i]) merged.push(movies[i])
    if (series[i]) merged.push(series[i])
  }
  const items = matchToLibrary(merged, vodRows, seriesRows, TRENDING_LIMIT)
  return {
    source: "tmdb",
    items,
    reason: items.length ? undefined : "no-library-match",
  }
}

/**
 * Load the trending row for one playlist. Google first, TMDb fallback,
 * honest empty result when neither can produce a playable title.
 * Results are cached for 6h per playlist; pass { force: true } to skip it.
 */
export async function loadTrending(
  playlistId: string,
  options: { force?: boolean } = {}
): Promise<TrendingResult> {
  if (!playlistId) {
    return { source: "none", items: [], reason: "fetch-failed" }
  }
  if (!options.force) {
    const cached = readCache(playlistId)
    if (cached) return cached
  }

  const [vodRows, seriesRows] = await Promise.all([
    loadCatalogRows(playlistId, "vod"),
    loadCatalogRows(playlistId, "series"),
  ])

  const google = await loadFromGoogle(vodRows, seriesRows)
  if (google && google.items.length) {
    writeCache(playlistId, google)
    return google
  }

  const tmdb = await loadFromTmdb(vodRows, seriesRows)
  if (tmdb && tmdb.items.length) {
    writeCache(playlistId, tmdb)
    return tmdb
  }
  if (tmdb && tmdb.reason === "no-library-match") {
    // TMDb answered but nothing trending is in the library.
    return tmdb
  }
  if (google && google.reason === "no-library-match") {
    // Google answered but nothing in it is in the library, and TMDb
    // could not add anything (no key, or it also found no match).
    return { source: "none", items: [], reason: "no-library-match" }
  }
  if (!isTmdbActive()) {
    return { source: "none", items: [], reason: "no-tmdb-key" }
  }
  return { source: "none", items: [], reason: "fetch-failed" }
}

/** Human label for the source that is actually live. */
export function trendingSourceLabel(source: TrendingSource): string {
  if (source === "google") return "Trending on Google this week"
  return "Trending this week"
}
