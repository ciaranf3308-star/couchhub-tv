// Live TV programme enrichment (0.11.0 W2).
//
// Resolves EPG programme titles to TMDb artwork (series / episode still /
// film) so the Live TV landing, browser, playback and guide screens can
// show real art instead of empty tiles. Confidence-aware: on any ambiguity
// it returns placeholder-source rather than wrong artwork, and it never
// invents programme titles, times, ratings or recommendations.
//
// Reuse: TMDb transport comes from tmdb.ts (search / bundle / season) and
// the pure title cleanup + exact-match picker from tmdb-match.ts — the same
// matcher the catalogue enrichment uses. tmdb-enrich.ts is deliberately NOT
// used here: its resolve/fetch helpers are keyed by playlistId+itemId and
// backed by IndexedDB cachedFetch, the wrong key shape for EPG titles;
// this module keeps its own small title-keyed cache (in-memory, persisted
// best-effort to localStorage) with a 24h negative cache for failed matches.
//
// Rules the module enforces on itself:
// - Only enriches when called (visible / soon-to-be-visible programmes);
//   it never mass-enriches on its own.
// - Max 2 concurrent TMDb requests (semaphore); prefetch is bounded to
//   8 in-flight enrichments.
// - enrichProgramme never throws: any failure degrades to placeholder.
// - Network / auth / rate-limit failures are NOT negatively cached (a
//   retry must be able to succeed); only an authoritative "no confident
//   match" is cached as a negative for 24h.
// - No TMDB key configured -> placeholder silently, no network, no nagging.
// - Never logs a key (the tmdb.ts client puts the key in the URL; this
//   module never logs URLs or the key — log.warn calls below pass only
//   the title and the error object, and log.ts redacts credential params).
import { getTmdbApiKey, isTmdbActive } from "@/scripts/lib/app-settings.js"
import { getActiveLocale } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import {
  tmdbSearchMovie,
  tmdbSearchTv,
  tmdbMovieBundle,
  tmdbTvBundle,
  tmdbTvSeason,
  tmdbImageUrl,
  tmdbLanguageFor,
  TMDB_BACKDROP_SIZE,
  TMDB_POSTER_SIZE,
  TMDB_STILL_SIZE,
  type TmdbSearchResult,
} from "@/scripts/lib/tmdb.ts"
import { cleanProviderTitle, pickTmdbMatch } from "@/scripts/lib/tmdb-match.ts"

export interface ProgrammeArtwork {
  backdropUrl: string | null
  posterUrl: string | null
  stillUrl: string | null
  source: "tmdb-episode" | "tmdb-series" | "tmdb-movie" | "channel" | "placeholder"
  /** 0..1. Placeholder is 0; a confident exact+year match is 0.95. */
  confidence: number
  matchedTitle: string | null
  synopsis: string | null
  genres: string[]
}

export interface EnrichProgrammeRequest {
  title: string
  channelName?: string
  startMs?: number
  endMs?: number
  /** Optional channel logo URL. Only used for the 'channel' fallback source
   *  when TMDb has no confident match — never as programme artwork. */
  channelLogoUrl?: string | null
}

export const PLACEHOLDER_ARTWORK: ProgrammeArtwork = {
  backdropUrl: null,
  posterUrl: null,
  stillUrl: null,
  source: "placeholder",
  confidence: 0,
  matchedTitle: null,
  synopsis: null,
  genres: [],
}

function placeholderArtwork(): ProgrammeArtwork {
  return { ...PLACEHOLDER_ARTWORK, genres: [] }
}

// ---------------------------------------------------------------------------
// Title normalisation + EPG signals (pure, unit-tested)
// ---------------------------------------------------------------------------

/** S01E01 / S1 E5 / 3x05 / "Series 3 Episode 5" / "Season 3, Episode 5". */
const SEASON_EPISODE_PATTERNS: RegExp[] = [
  /\bS(\d{1,2})\s*E(\d{1,3})\b/i,
  /\b(\d{1,2})\s*x\s*(\d{1,3})\b/,
  /\b(?:series|season)\s+(\d{1,2})\s*(?:,?\s*(?:episode|ep\.?)\s+(\d{1,3}))?\b/i,
  /\b(?:episode|ep\.?)\s+(\d{1,3})\b/i,
]

const TRAILING_PROVIDER_NOISE = /\s+(?:HD|FHD|UHD|4K|\+1)\s*$/i
const TRAILING_YEAR = /\s+\(?((?:19|20)\d{2})\)?\s*$/

export interface ProgrammeTitleSignals {
  /** Primary cleaned query (episode markers, year and provider noise stripped). */
  query: string
  /** Search variants, most-cleaned first: [query, base-before-colon/dash, ...cleanProviderTitle variants]. */
  variants: string[]
  year: number | null
  season: number | null
  episode: number | null
}

function stripSeasonEpisodeMarkers(text: string): { text: string; season: number | null; episode: number | null } {
  let season: number | null = null
  let episode: number | null = null
  let out = text
  for (let index = 0; index < SEASON_EPISODE_PATTERNS.length; index++) {
    const pattern = SEASON_EPISODE_PATTERNS[index]
    const match = out.match(pattern)
    if (!match) continue
    if (index === 3) {
      // "Episode N" alone: only an episode number, no season.
      episode = Number(match[1])
    } else if (index === 2) {
      // "Series/Season N [Episode M]": the episode group is optional.
      season = Number(match[1])
      if (match[2] != null) episode = Number(match[2])
    } else {
      // SxxExx / NxNN.
      season = Number(match[1])
      episode = Number(match[2])
    }
    out = out.replace(pattern, " ")
    break
  }
  return { text: out, season, episode }
}

/**
 * Normalise an EPG title for cache keys and matching. Strips only safe
 * provider formatting noise: quality suffixes (" HD", " 4K", " +1"),
 * season/episode markers and a trailing year. Never guesses at the title
 * itself, and never strips a word that could be part of the programme name.
 */
export function normalizeProgrammeTitle(rawTitle: string): string {
  const raw = (rawTitle || "").trim()
  if (!raw) return ""
  const { text: withoutEpisode } = stripSeasonEpisodeMarkers(raw)
  const withoutNoise = withoutEpisode.replace(TRAILING_PROVIDER_NOISE, "")
  const withoutYear = withoutNoise.replace(TRAILING_YEAR, "")
  return withoutYear.replace(/\s+/g, " ").trim()
}

/**
 * Full signal extraction for one EPG title. `channelName` is only used for
 * one clearly-safe strip: a leading "ChannelName: " / "ChannelName - "
 * prefix that exactly equals the channel name (e.g. "BBC One: EastEnders"
 * on BBC One). Anything else keeps the raw title as a fallback variant.
 */
export function parseProgrammeTitleSignals(rawTitle: string, channelName?: string): ProgrammeTitleSignals {
  const raw = (rawTitle || "").trim()
  const { variants: cleanedVariants, year: cleanedYear } = cleanProviderTitle(raw)
  const primary = normalizeProgrammeTitle(raw)
  const { season, episode } = stripSeasonEpisodeMarkers(raw)

  const variants: string[] = []
  const push = (value: string | undefined | null) => {
    const candidate = (value || "").replace(/\s+/g, " ").trim()
    if (candidate && candidate.length >= 2 && !variants.includes(candidate)) variants.push(candidate)
  }

  // Base title before a ": " / " - " split — the series name when the EPG
  // title carries an episode/scene suffix ("The Chase: Celebrity Special").
  // Only a fallback variant: pickTmdbMatch still requires an exact TMDb
  // title equality, so this can never match a differently-named programme.
  const baseBeforeSplit = primary.split(/\s*[:\-–—]\s+/)[0]
  push(primary)
  if (channelName) {
    const escaped = channelName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const channelPrefix = new RegExp(`^${escaped}\\s*[:\\-–—]\\s+`, "i")
    const stripped = primary.replace(channelPrefix, "")
    if (stripped !== primary) push(stripped)
  }
  if (baseBeforeSplit && baseBeforeSplit !== primary) push(baseBeforeSplit)
  for (const variant of cleanedVariants) push(normalizeProgrammeTitle(variant))
  push(raw)

  return {
    query: primary,
    variants: variants.slice(0, 4),
    year: cleanedYear,
    season,
    episode,
  }
}

// ---------------------------------------------------------------------------
// Cache (in-memory + best-effort localStorage persistence)
// ---------------------------------------------------------------------------

const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000
const PERSIST_KEY = "xt_livetv_enrichment_v1"
const MAX_PERSISTED_ENTRIES = 200

interface CacheEntry {
  art: ProgrammeArtwork
  expiresAt: number
  negative: boolean
}

const memoryCache = new Map<string, CacheEntry>()
let persistedHydrated = false

function readPersistedCache(): Record<string, CacheEntry> {
  try {
    if (typeof localStorage === "undefined") return {}
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>
    if (!parsed || typeof parsed !== "object") return {}
    return parsed
  } catch {
    return {}
  }
}

function hydratePersistedCache(): void {
  if (persistedHydrated) return
  persistedHydrated = true
  try {
    const now = Date.now()
    const persisted = readPersistedCache()
    for (const [key, entry] of Object.entries(persisted)) {
      if (!entry || !entry.art || entry.expiresAt <= now) continue
      if (!memoryCache.has(key)) memoryCache.set(key, entry)
    }
  } catch {
    // Persistence is best-effort; a corrupt entry must never break enrichment.
  }
}

function persistCache(): void {
  try {
    if (typeof localStorage === "undefined") return
    const now = Date.now()
    const entries = [...memoryCache.entries()]
      .filter(([, entry]) => entry.expiresAt > now)
      .slice(-MAX_PERSISTED_ENTRIES)
    localStorage.setItem(PERSIST_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Best-effort only (private mode / quota). The in-memory cache still works.
  }
}

function cacheGet(key: string): ProgrammeArtwork | null {
  hydratePersistedCache()
  const entry = memoryCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key)
    return null
  }
  return entry.art
}

function cachePut(key: string, art: ProgrammeArtwork, negative: boolean): void {
  memoryCache.set(key, {
    art,
    expiresAt: Date.now() + (negative ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS),
    negative,
  })
  persistCache()
}

/** Test/support hook: clears the in-memory cache and its persisted copy. */
export function clearProgrammeArtworkCache(): void {
  memoryCache.clear()
  persistedHydrated = true
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(PERSIST_KEY)
  } catch {
    // Ignore — cache is already cleared in memory.
  }
}

// ---------------------------------------------------------------------------
// TMDb concurrency (max 2 requests in flight) + in-flight dedupe
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_TMDB = 2
let tmdbInFlight = 0
const tmdbWaiters: Array<() => void> = []

async function withTmdbSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (tmdbInFlight >= MAX_CONCURRENT_TMDB) {
    await new Promise<void>((resolve) => tmdbWaiters.push(resolve))
  }
  tmdbInFlight += 1
  try {
    return await fn()
  } finally {
    tmdbInFlight -= 1
    const next = tmdbWaiters.shift()
    if (next) next()
  }
}

const inflightEnrichments = new Map<string, Promise<ProgrammeArtwork>>()

function tmdbLanguage(): string {
  try {
    return tmdbLanguageFor(getActiveLocale())
  } catch {
    return "en-US"
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface ConfidentMatch {
  kind: "tv" | "movie"
  id: number
  title: string
  year: number | null
  /** True when the TMDb title matched a base-title variant, not the full title. */
  baseTitleMatch: boolean
}

async function searchConfidentMatch(
  apiKey: string,
  signals: ProgrammeTitleSignals,
  language: string
): Promise<ConfidentMatch | null> {
  const { variants, year } = signals
  if (!variants.length) return null

  // EPG is mostly series; try TV first, then film.
  const tvResults: TmdbSearchResult[] = await withTmdbSlot(() =>
    tmdbSearchTv(apiKey, variants[0], { year, language })
  )
  const tvMatch = pickTmdbMatch(tvResults, { variants, year, mediaType: "tv" })
  if (tvMatch) {
    return {
      kind: "tv",
      id: tvMatch.id,
      title: tvMatch.title,
      year: tvMatch.year,
      baseTitleMatch: normalizeProgrammeTitle(tvMatch.title) !== normalizeProgrammeTitle(signals.query),
    }
  }

  const movieResults: TmdbSearchResult[] = await withTmdbSlot(() =>
    tmdbSearchMovie(apiKey, variants[0], { year, language })
  )
  const movieMatch = pickTmdbMatch(movieResults, { variants, year, mediaType: "movie" })
  if (movieMatch) {
    return {
      kind: "movie",
      id: movieMatch.id,
      title: movieMatch.title,
      year: movieMatch.year,
      baseTitleMatch: normalizeProgrammeTitle(movieMatch.title) !== normalizeProgrammeTitle(signals.query),
    }
  }
  return null
}

function confidenceFor(match: ConfidentMatch, hasYearSignal: boolean): number {
  if (match.baseTitleMatch) return 0.75
  if (hasYearSignal && match.year != null) return 0.95
  return 0.85
}

async function fetchArtworkForMatch(
  apiKey: string,
  match: ConfidentMatch,
  signals: ProgrammeTitleSignals,
  language: string
): Promise<ProgrammeArtwork | null> {
  const confidence = confidenceFor(match, signals.year != null)
  if (match.kind === "movie") {
    const bundle = await withTmdbSlot(() => tmdbMovieBundle(apiKey, match.id, language))
    return {
      backdropUrl: tmdbImageUrl(bundle.backdrop_path, TMDB_BACKDROP_SIZE),
      posterUrl: tmdbImageUrl(bundle.poster_path, TMDB_POSTER_SIZE),
      stillUrl: null,
      source: "tmdb-movie",
      confidence,
      matchedTitle: bundle.title || match.title,
      synopsis: bundle.overview || null,
      genres: (bundle.genres || []).map((genre) => genre.name),
    }
  }

  const bundle = await withTmdbSlot(() => tmdbTvBundle(apiKey, match.id, language))
  const art: ProgrammeArtwork = {
    backdropUrl: tmdbImageUrl(bundle.backdrop_path, TMDB_BACKDROP_SIZE),
    posterUrl: tmdbImageUrl(bundle.poster_path, TMDB_POSTER_SIZE),
    stillUrl: null,
    source: "tmdb-series",
    confidence,
    matchedTitle: bundle.name || match.title,
    synopsis: bundle.overview || null,
    genres: (bundle.genres || []).map((genre) => genre.name),
  }

  // Episode still when the EPG title carries SxxExx / Series N Episode M.
  if (signals.season != null && signals.episode != null) {
    try {
      const season = await withTmdbSlot(() => tmdbTvSeason(apiKey, match.id, signals.season as number, language))
      const episode = (season.episodes || []).find(
        (item) => item.episode_number === (signals.episode as number)
      )
      if (episode?.still_path) {
        art.stillUrl = tmdbImageUrl(episode.still_path, TMDB_STILL_SIZE)
        art.source = "tmdb-episode"
        if (episode.overview) art.synopsis = episode.overview
        if (episode.name) art.matchedTitle = `${art.matchedTitle} — ${episode.name}`
      }
    } catch {
      // A missing season / failed season fetch never loses the series art.
    }
  }
  return art
}

// ---------------------------------------------------------------------------
// Public API (contracts)
// ---------------------------------------------------------------------------

interface UncachedResult {
  art: ProgrammeArtwork
  /**
   * True only for an authoritative "no confident match" (searches completed
   * and nothing matched, or a match with no usable art). False for the
   * no-key path and for network/auth/rate-limit failures — those must
   * never be negatively cached.
   */
  negative: boolean
}

async function enrichProgrammeUncached(req: EnrichProgrammeRequest): Promise<UncachedResult> {
  const signals = parseProgrammeTitleSignals(req.title, req.channelName)
  if (!signals.query) return { art: placeholderArtwork(), negative: true }

  // Channel branding is a valid fallback with or without a TMDb key — but
  // it is never cached (see enrichProgramme): a key added later must win.
  const channelFallback = channelArtwork(req)

  // No key configured: degrade silently to placeholder — no network, and
  // deliberately NOT cached, so adding a key later enriches immediately.
  if (!isTmdbActive()) {
    return { art: channelFallback ?? placeholderArtwork(), negative: false }
  }
  const apiKey = getTmdbApiKey()
  if (!apiKey) return { art: channelFallback ?? placeholderArtwork(), negative: false }

  const language = tmdbLanguage()
  try {
    const match = await searchConfidentMatch(apiKey, signals, language)
    if (!match) {
      return channelFallback
        ? { art: channelFallback, negative: false }
        : { art: placeholderArtwork(), negative: true }
    }
    const art = await fetchArtworkForMatch(apiKey, match, signals, language)
    if (!art || (!art.backdropUrl && !art.posterUrl && !art.stillUrl)) {
      // Matched but TMDb has no usable art: fall back to channel, else no match.
      return channelFallback
        ? { art: channelFallback, negative: false }
        : { art: placeholderArtwork(), negative: true }
    }
    return { art, negative: false }
  } catch (error) {
    // Network / auth / rate-limit failure: placeholder, never thrown, and
    // never negatively cached — a retry must be able to succeed.
    log.warn("[xt:livetv-enrich] enrich failed:", req.title, error)
    return { art: channelFallback ?? placeholderArtwork(), negative: false }
  }
}

/** 'channel'-source artwork from an explicit channel logo URL, or null. */
function channelArtwork(req: EnrichProgrammeRequest): ProgrammeArtwork | null {
  if (!req.channelLogoUrl) return null
  return {
    backdropUrl: null,
    posterUrl: req.channelLogoUrl,
    stillUrl: null,
    source: "channel",
    confidence: 0.5,
    matchedTitle: req.title.trim() || null,
    synopsis: null,
    genres: [],
  }
}

/**
 * Enrich one EPG programme title. Never throws; returns placeholder-source
 * on any failure. Only enriches when called — callers decide visibility.
 * Successful matches are cached 7 days; authoritative "no confident
 * match" results are negatively cached 24h.
 */
export async function enrichProgramme(req: EnrichProgrammeRequest): Promise<ProgrammeArtwork> {
  const key = normalizeProgrammeTitle(req.title)
  if (!key) return placeholderArtwork()

  const cached = cacheGet(key)
  if (cached) return cached

  const inFlight = inflightEnrichments.get(key)
  if (inFlight) return inFlight

  const promise = (async (): Promise<ProgrammeArtwork> => {
    const { art, negative } = await enrichProgrammeUncached(req)
    if (art.source === "placeholder") {
      // Negative-cache only an authoritative no-match while a key is
      // configured. No-key and network-failure placeholders are transient
      // by design (see enrichProgrammeUncached) and must not be cached:
      // re-checking is cheap and a later key / recovered network must work.
      if (negative && isTmdbActive()) cachePut(key, placeholderArtwork(), true)
      return art
    }
    // Channel-source art is never cached: a TMDb key added later must win
    // over the logo fallback on the next enrich.
    if (art.source === "channel") return art
    cachePut(key, art, false)
    return art
  })()

  inflightEnrichments.set(key, promise)
  try {
    return await promise
  } finally {
    inflightEnrichments.delete(key)
  }
}

/**
 * Cache peek only — no network. Returns the cached artwork for a title
 * (including a negatively-cached placeholder), or null when the title has
 * never been enriched or the entry expired.
 */
export function getProgrammeArtworkSync(title: string): ProgrammeArtwork | null {
  const key = normalizeProgrammeTitle(title)
  if (!key) return null
  return cacheGet(key)
}

/**
 * Best-effort, non-blocking prefetch of a batch of titles. Bounded to 8
 * enrichments in flight; each individual enrichment is still capped by
 * the 2-concurrent TMDb semaphore. Never throws.
 */
export function prefetchProgrammes(titles: string[]): void {
  const seen = new Set<string>()
  const queue: string[] = []
  for (const raw of titles || []) {
    const key = normalizeProgrammeTitle(raw)
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (cacheGet(key)) continue
    queue.push(raw)
  }
  if (!queue.length) return

  const MAX_PREFETCH_IN_FLIGHT = 8
  let inFlight = 0
  let index = 0
  const pump = (): void => {
    while (inFlight < MAX_PREFETCH_IN_FLIGHT && index < queue.length) {
      const title = queue[index++]
      inFlight += 1
      void enrichProgramme({ title })
        .catch(() => undefined)
        .finally(() => {
          inFlight -= 1
          pump()
        })
    }
  }
  pump()
}

// ---------------------------------------------------------------------------
// DOM upgrade helper for TvProgrammeArt + client-rendered callers
// ---------------------------------------------------------------------------

function pickArtworkUrl(art: ProgrammeArtwork, variant: string): string | null {
  if (variant === "card") return art.posterUrl || art.backdropUrl || art.stillUrl
  return art.backdropUrl || art.stillUrl || art.posterUrl
}

function applyArtworkToElement(element: HTMLElement, art: ProgrammeArtwork, variant: string): void {
  const url = pickArtworkUrl(art, variant)
  element.setAttribute("data-art-source", art.source)
  if (!url) {
    element.setAttribute("data-art-state", "done")
    return
  }
  const existing = element.querySelector<HTMLImageElement>("img.rs-livetv-programme-art__img")
  if (existing) {
    if (existing.getAttribute("src") === url) {
      element.setAttribute("data-art-state", "done")
      return
    }
    existing.remove()
  }
  const img = document.createElement("img")
  img.className = "rs-livetv-programme-art__img"
  img.alt = ""
  img.loading = "lazy"
  img.decoding = "async"
  // Astro scopes the component CSS with a data-astro-cid-* attribute that
  // only template-rendered elements carry. A JS-created <img> needs the
  // same attribute copied from its container, or none of the scoped rules
  // (absolute fill, object-fit, fade-in) apply and the absolutely-
  // positioned placeholder paints straight over it. The essential geometry
  // is also set inline so hand-written [data-programme-art] markup (no
  // Astro scope at all) still lays out correctly.
  for (const attr of Array.from(element.attributes)) {
    if (attr.name.startsWith("data-astro-cid-")) img.setAttribute(attr.name, attr.value)
  }
  const isChannelLogo = art.source === "channel"
  img.style.position = "absolute"
  img.style.inset = "0"
  img.style.zIndex = "1"
  img.style.width = "100%"
  img.style.height = "100%"
  // Border-box is essential: the channel-logo padding (14%) is a
  // percentage of the container, and with content-box it would push the
  // image 28% past the container edge (cropped by overflow: hidden).
  img.style.boxSizing = "border-box"
  img.style.objectFit = isChannelLogo ? "contain" : "cover"
  img.style.objectPosition = "center 28%"
  if (isChannelLogo) img.style.padding = "14%"
  // Listeners BEFORE src: a data-URI / already-cached image can fire
  // `load` synchronously on src assignment, before a later listener exists.
  img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true })
  img.addEventListener(
    "error",
    () => {
      // Broken art URL: drop the img, keep the premium placeholder.
      img.remove()
      element.setAttribute("data-art-state", "done")
    },
    { once: true }
  )
  img.src = url
  // Already complete (cached / data-URI): the load event may already have
  // fired, so mark it loaded directly.
  if (img.complete && img.naturalWidth > 0) img.classList.add("is-loaded")
  element.prepend(img)
  element.setAttribute("data-art-state", "done")
}

/**
 * Upgrades every `[data-programme-art]` element under `root` (default
 * document): sync-cache art is applied immediately, otherwise the title is
 * enriched in the background and the <img> swapped in when it resolves.
 * Idempotent — already-upgraded elements are skipped. Used by the
 * TvProgrammeArt component script; client-rendered callers (guide rows,
 * browser detail) can call it after injecting programme-art markup.
 */
export function upgradeProgrammeArtElements(root: ParentNode = document): void {
  const elements = root.querySelectorAll<HTMLElement>("[data-programme-art]")
  for (const element of elements) {
    if (element.getAttribute("data-art-state")) continue
    const title = element.getAttribute("data-title") || ""
    if (!title.trim()) {
      element.setAttribute("data-art-state", "done")
      continue
    }
    const variant = element.getAttribute("data-variant") || "card"
    const channelName = element.getAttribute("data-channel") || undefined
    const channelLogoUrl = element.getAttribute("data-channel-logo") || undefined
    element.setAttribute("data-art-state", "loading")

    const cached = getProgrammeArtworkSync(title)
    if (cached && (cached.backdropUrl || cached.posterUrl || cached.stillUrl)) {
      applyArtworkToElement(element, cached, variant)
      continue
    }
    void enrichProgramme({ title, channelName, channelLogoUrl })
      .then((art) => applyArtworkToElement(element, art, variant))
      .catch(() => element.setAttribute("data-art-state", "done"))
  }
}
