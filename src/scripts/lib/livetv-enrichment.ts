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
//
// 0.11.12 (sports-aware hierarchy): titles classify through
// livetv-sports-classifier.ts BEFORE any TMDb search. Resolution order:
// (1) exact verified programme artwork via the TMDb path above (confident-
// match requirements unchanged); (2) verified sports event artwork via
// the provider hook; (3) team/venue photography from the bundled manifest
// (entries carrying `subjects` match keys); (4) generic sport photography
// from the bundled manifest; (5) channel branding; (6) branded placeholder.
// High-confidence fixtures, tournaments
// and league broadcasts skip the blind TMDb search entirely — TMDb has no
// fixture art, and searching wastes requests. Exact-event and generic-
// sport images carry distinct artworkKind/provenance and must never be
// confused: a generic photo is suitable art for the sport, never evidence
// of the actual fixture, so it keeps identity confidence 0. The persisted
// cache namespace is v2: 0.11.11 v1 negative entries must not suppress
// the new sport fallbacks.
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
import {
  classifySportsProgramme,
  type SportsClassification,
  type SportId,
} from "@/scripts/lib/livetv-sports-classifier.ts"
import { SPORT_ARTWORK_MANIFEST, type SportsArtworkEntry } from "@/scripts/lib/sports-artwork-manifest.ts"
import { lookupSportsEventArtwork, type ExactSportsArtwork } from "@/scripts/lib/thesportsdb-provider.ts"

export interface ProgrammeArtwork {
  backdropUrl: string | null
  posterUrl: string | null
  stillUrl: string | null
  source: "tmdb-episode" | "tmdb-series" | "tmdb-movie" | "channel" | "sports" | "placeholder"
  /** 0..1. Placeholder is 0; a confident exact+year match is 0.95. */
  confidence: number
  matchedTitle: string | null
  synopsis: string | null
  genres: string[]
  /** 0.11.12: which hierarchy level produced this artwork. Consumers
   *  (W3) build against this: displayable kinds show their art
   *  regardless of identity confidence, while channel-branding and
   *  placeholder kinds keep the branded placeholder. `confidence`
   *  keeps its identity-match meaning — visual suitability is
   *  expressed here, never by inflating confidence. */
  artworkKind?: "exact-programme" | "exact-sports-event" | "league-team" | "generic-sport" | "channel-branding" | "placeholder"
  /** 0.11.12: artwork origin and rights attribution. TMDb results
   *  carry { source: "TMDb" }; generic sport photos carry the
   *  manifest entry's creator/licence; provider results carry the
   *  provider's rights basis. Absent on legacy cached entries. */
  provenance?: { source: string; attribution?: string; licence?: string; licenceUrl?: string; sourcePage?: string }
}

export interface EnrichProgrammeRequest {
  title: string
  channelName?: string
  startMs?: number
  endMs?: number
  /** Optional provider category (e.g. "Sports"). Supporting evidence
   *  for the sports classifier only — it can raise a weak title signal,
   *  never create a sport classification on its own. */
  category?: string
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
  artworkKind: "placeholder",
}

/** Fresh honest-miss shape (exported for callers/tests that need a
 *  placeholder ProgrammeArtwork without sharing one object). */
export function placeholderArtwork(): ProgrammeArtwork {
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
// 0.11.12: sports outcomes re-check sooner than TMDb negatives — event
// artwork can appear closer to the fixture, and a stale generic photo
// must yield to it. Applies to provider negatives, generic-sport title
// entries, and sport-title placeholder negatives.
const SPORTS_TTL_MS = 6 * 60 * 60 * 1000
// v2 namespace (0.11.12): a v1 negative entry (e.g. "NHL Hockey" cached
// as no-match under 0.11.11) must NOT suppress the new sport fallbacks,
// so the persisted key is bumped and v1 blobs are never hydrated.
const PERSIST_KEY = "xt_livetv_enrichment_v2"
const LEGACY_PERSIST_KEY = "xt_livetv_enrichment_v1"
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

function readCacheEntry(key: string): CacheEntry | null {
  hydratePersistedCache()
  const entry = memoryCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key)
    return null
  }
  return entry
}

function cacheGet(key: string): ProgrammeArtwork | null {
  return readCacheEntry(key)?.art ?? null
}

function cachePut(key: string, art: ProgrammeArtwork, negative: boolean, ttlMs?: number): void {
  memoryCache.set(key, {
    art,
    expiresAt: Date.now() + (ttlMs ?? (negative ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS)),
    negative,
  })
  persistCache()
}

/** Test/support hook: clears the in-memory cache and its persisted copy. */
export function clearProgrammeArtworkCache(): void {
  memoryCache.clear()
  persistedHydrated = true
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(PERSIST_KEY)
      // Drop the pre-0.11.12 blob too, so stale v1 negatives can never
      // be re-read by an older build running alongside this one.
      localStorage.removeItem(LEGACY_PERSIST_KEY)
    }
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
      artworkKind: "exact-programme",
      provenance: { source: "TMDb" },
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
    artworkKind: "exact-programme",
    provenance: { source: "TMDb" },
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
// Sports artwork (0.11.12): provider hook + generic manifest fallback
// ---------------------------------------------------------------------------

/** The provider hook runs only for sport classifications with high or
 *  medium confidence — never for non-sport titles, and never for weak
 *  (low) sport signals, where only the generic fallback may apply. */
function isProviderEligible(classification: SportsClassification): boolean {
  return classification.isSport && (classification.confidence === "high" || classification.confidence === "medium")
}

/**
 * High-confidence fixtures, tournaments and league broadcasts never need
 * a blind TMDb search: TMDb has no fixture art, and searching wastes
 * requests on titles like "NHL Hockey". General-sport titles and
 * anything below high confidence still try exact TMDb art first, so a
 * series or film with a sport-shaped title keeps its exact artwork.
 */
function shouldSkipTmdb(classification: SportsClassification): boolean {
  return classification.isSport && classification.confidence === "high" && classification.kind !== "general-sport"
}

/** Broadcast date (local YYYY-MM-DD) for the sports-event cache key and
 *  the provider hook. Dateless calls describe now-playing rows, so they
 *  default to today: the same programme enriched with and without
 *  startMs shares one entry, and tomorrow's fixture gets a fresh key. */
function broadcastDateFor(startMs?: number): string {
  const date = new Date(typeof startMs === "number" && Number.isFinite(startMs) ? startMs : Date.now())
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Composite sports-event cache key: normalised title + sport +
 *  teams/event + broadcast date. Lowercased so capitalisation variants
 *  share one entry. */
function sportsCacheKey(title: string, classification: SportsClassification, startMs?: number): string {
  const event = classification.teams
    ? classification.teams.map((side) => side.toLowerCase()).join(" v ")
    : (classification.competition ?? "").toLowerCase()
  return `sport-event:${normalizeProgrammeTitle(title).toLowerCase()}|${classification.sport ?? ""}|${event}|${broadcastDateFor(startMs)}`
}

interface SportsCacheLookup {
  hit: boolean
  /** Null on a hit means the provider authoritatively returned nothing. */
  art: ProgrammeArtwork | null
}

function sportsCacheGet(key: string): SportsCacheLookup {
  const entry = readCacheEntry(key)
  if (!entry) return { hit: false, art: null }
  if (entry.negative) return { hit: true, art: null }
  return { hit: true, art: entry.art }
}

function sportsCachePut(key: string, art: ProgrammeArtwork | null): void {
  if (art) cachePut(key, art, false)
  else cachePut(key, placeholderArtwork(), true, SPORTS_TTL_MS)
}

const PROVIDER_TIMEOUT_MS = 3000
const inflightProviderLookups = new Map<string, Promise<ProgrammeArtwork | null>>()

/**
 * Map verified provider art onto ProgrammeArtwork. Both URL slots are
 * filled from whichever image the provider returned: hero and tile
 * consumers read backdropUrl only, so a poster-only result must still
 * land in the wide slot. The provider shape carries no team/league
 * distinction, so every verified result maps to "exact-sports-event";
 * "league-team" is produced only by hierarchy level 3 (team/venue
 * resolution against the bundled manifest, below), never here.
 */
function providerArtworkToProgrammeArtwork(result: ExactSportsArtwork, title: string): ProgrammeArtwork | null {
  const backdropUrl = result.backdropUrl ?? result.posterUrl ?? null
  const posterUrl = result.posterUrl ?? result.backdropUrl ?? null
  if (!backdropUrl && !posterUrl) return null
  return {
    backdropUrl,
    posterUrl,
    stillUrl: null,
    source: "sports",
    artworkKind: "exact-sports-event",
    confidence: 0.85,
    matchedTitle: result.eventName || title.trim() || null,
    synopsis: null,
    genres: [],
    provenance: { source: "TheSportsDB", licence: result.rightsBasis },
  }
}

/**
 * Provider lookup with timeout, failure isolation, in-flight dedup and
 * composite-key caching. An authoritative null is cached (short sports
 * TTL); a throw or timeout is NOT cached, so a retry can succeed.
 * Never throws; never returns a partial result.
 */
async function lookupProviderArtwork(
  classification: SportsClassification,
  req: EnrichProgrammeRequest
): Promise<ProgrammeArtwork | null> {
  const key = sportsCacheKey(req.title, classification, req.startMs)
  const cached = sportsCacheGet(key)
  if (cached.hit) return cached.art
  const inFlight = inflightProviderLookups.get(key)
  if (inFlight) return inFlight

  const promise = (async (): Promise<ProgrammeArtwork | null> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      const lookup = lookupSportsEventArtwork(classification, {
        title: req.title,
        broadcastDate: broadcastDateFor(req.startMs),
      })
      // Swallow a late rejection: if the timeout wins the race, the
      // provider promise still settles and must not surface unhandled.
      void lookup.catch(() => undefined)
      let timedOut = false
      const timeout = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true
          resolve(null)
        }, PROVIDER_TIMEOUT_MS)
      })
      const result = await Promise.race([lookup, timeout])
      if (timedOut) return null
      const art = result ? providerArtworkToProgrammeArtwork(result, req.title) : null
      sportsCachePut(key, art)
      return art
    } catch (error) {
      // Failure isolation: the provider must never break resolution.
      log.warn("[xt:livetv-enrich] sports provider failed:", req.title, error)
      return null
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      inflightProviderLookups.delete(key)
    }
  })()

  inflightProviderLookups.set(key, promise)
  return promise
}

/**
 * Generic sport photographs, resolved once per sport (the manifest is a
 * static bundled list, so the memo never goes stale). Landscape is
 * preferred: hero and tile slots read the backdrop, and a landscape
 * photo fills both slots. An empty manifest resolves to null and the
 * hierarchy falls through to channel branding.
 */
const genericSportMemo = new Map<SportId, SportsArtworkEntry | null>()

function genericEntryForSport(sport: SportId): SportsArtworkEntry | null {
  if (genericSportMemo.has(sport)) return genericSportMemo.get(sport) ?? null
  const entries = SPORT_ARTWORK_MANIFEST.filter((entry) => entry.sport === sport)
  const entry = entries.find((candidate) => candidate.orientation === "landscape") ?? entries[0] ?? null
  genericSportMemo.set(sport, entry)
  return entry
}

function genericSportArtwork(classification: SportsClassification, title: string): ProgrammeArtwork | null {
  if (!classification.sport) return null
  const entry = genericEntryForSport(classification.sport)
  if (!entry) return null
  return {
    backdropUrl: entry.path,
    posterUrl: entry.path,
    stillUrl: null,
    source: "sports",
    artworkKind: "generic-sport",
    // Identity-match confidence stays 0: a generic photo is suitable
    // art for the sport without being evidence of the actual fixture.
    // Suitability is expressed via artworkKind, not confidence.
    confidence: 0,
    matchedTitle: title.trim() || null,
    synopsis: null,
    genres: [],
    provenance: {
      // The 0.11.12 manifest is Wikimedia Commons photographs only
      // (brief hard rule); the entry carries creator/licence/attribution.
      source: "Wikimedia Commons",
      attribution: entry.attribution,
      licence: entry.licence,
      licenceUrl: entry.licenceUrl,
      sourcePage: entry.sourcePage,
    },
  }
}

// ---------------------------------------------------------------------------
// Team/venue artwork (0.11.12 W5): hierarchy level 3
// ---------------------------------------------------------------------------

/**
 * Normalise a team or competition name for subject matching. Mirrors the
 * classifier's normaliseSideForAlias (livetv-sports-classifier.ts):
 * lowercase, "&" to "and", apostrophes dropped, other punctuation to
 * spaces, and trailing FC/AFC/CF, age-group (U21) and "women" suffixes
 * stripped. Kept local to this module — the classifier owns
 * classification outcomes and must not gain matching behaviour — but
 * the two must stay in step: a side the classifier recognises
 * ("Man Utd") must normalise the same way here ("man utd") or the
 * alias map below cannot fire. Manifest subjects are stored in this
 * normalised form; they are re-normalised at match time anyway, so a
 * hand-edited subject with stray caps or punctuation still matches.
 */
function normaliseSubjectKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(fc|afc|cf)$/, "")
    .replace(/\s+u\d{2}$/, "")
    .replace(/\s+women$/, "")
    .trim()
}

/**
 * Short-form -> canonical team name, for EPG sides written as
 * abbreviations or famous short forms ("Man Utd", "Spurs", "Leafs").
 * Keys and values are normalised subject keys. Deliberately small and
 * conservative: only unambiguous short forms are listed. Single-word
 * tails that already appear as manifest subjects ("oilers", "flames",
 * "sabres") need no alias — they match directly. Bare "united" is NOT
 * an entry (ambiguous across clubs), and bare "rangers" is NOT an
 * entry (Glasgow Rangers vs New York Rangers — the sport filter in
 * findTeamVenueEntry, not the alias, disambiguates same-name sides).
 */
const TEAM_SUBJECT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["man utd", "manchester united"],
  ["manchester utd", "manchester united"],
  ["man city", "manchester city"],
  ["spurs", "tottenham hotspur"],
  ["tottenham", "tottenham hotspur"],
  ["west ham", "west ham united"],
  ["wolves", "wolverhampton wanderers"],
  ["brighton", "brighton and hove albion"],
  ["newcastle", "newcastle united"],
  ["leeds", "leeds united"],
  ["sheffield utd", "sheffield united"],
  ["leicester", "leicester city"],
  ["norwich", "norwich city"],
  ["ipswich", "ipswich town"],
  ["nottm forest", "nottingham forest"],
  ["leafs", "toronto maple leafs"],
  ["bruins", "boston bruins"],
  ["habs", "montreal canadiens"],
  ["pens", "pittsburgh penguins"],
  ["caps", "washington capitals"],
  ["hawks", "chicago blackhawks"],
  ["wings", "detroit red wings"],
  ["sens", "ottawa senators"],
])

/** Match keys for one raw name: the normalised key, then its alias
 *  expansion when one exists. Both are tried, key first. */
function subjectKeysFor(raw: string): string[] {
  const key = normaliseSubjectKey(raw)
  if (!key) return []
  const alias = TEAM_SUBJECT_ALIASES.get(key)
  return alias && alias !== key ? [key, alias] : [key]
}

/**
 * First manifest entry (in manifest order) whose subjects match team A,
 * else team B, else the competition/venue — or null. Only entries
 * carrying subjects can match; entries without subjects never match
 * level 3 and stay generic-fallback-only. Candidates are scoped to the
 * classified sport when one is known, so a team name shared across
 * sports ("rangers") cannot pull the wrong sport's photo; a null sport
 * (ambiguous fixture) searches all sports, with the subject keys
 * themselves disambiguating. No randomness: manifest order decides.
 */
function findTeamVenueEntry(classification: SportsClassification): SportsArtworkEntry | null {
  if (!classification.isSport) return null
  const candidates = SPORT_ARTWORK_MANIFEST.filter(
    (entry) =>
      (entry.subjects?.length ?? 0) > 0 &&
      (classification.sport == null || entry.sport === classification.sport)
  )
  if (candidates.length === 0) return null
  const lookupKeys: string[][] = []
  if (classification.teams) {
    lookupKeys.push(subjectKeysFor(classification.teams[0]), subjectKeysFor(classification.teams[1]))
  }
  if (classification.competition) lookupKeys.push(subjectKeysFor(classification.competition))
  for (const keys of lookupKeys) {
    for (const key of keys) {
      const entry = candidates.find((candidate) =>
        (candidate.subjects ?? []).some((subject) => normaliseSubjectKey(subject) === key)
      )
      if (entry) return entry
    }
  }
  return null
}

/**
 * Hierarchy level 3: a team/venue photograph from the bundled manifest
 * for a fixture naming a depicted team, or a broadcast naming a
 * depicted competition/venue. This is supplementary team/venue imagery
 * — a previous fixture or a stadium/arena shot — never a photograph of
 * the actual current fixture, so identity confidence stays 0 (the same
 * convention as the generic-sport level) and the EPG title is carried
 * unchanged. The artworkKind and provenance stay distinct from
 * exact-event images: consumers must never present this as the fixture.
 */
function teamVenueArtwork(classification: SportsClassification, title: string): ProgrammeArtwork | null {
  const entry = findTeamVenueEntry(classification)
  if (!entry) return null
  return {
    backdropUrl: entry.path,
    posterUrl: entry.path,
    stillUrl: null,
    source: "sports",
    artworkKind: "league-team",
    confidence: 0,
    matchedTitle: title.trim() || null,
    synopsis: null,
    genres: [],
    provenance: {
      source: "Wikimedia Commons",
      attribution: entry.attribution,
      licence: entry.licence,
      licenceUrl: entry.licenceUrl,
      sourcePage: entry.sourcePage,
    },
  }
}

// ---------------------------------------------------------------------------
// Public API (contracts)
// ---------------------------------------------------------------------------

interface UncachedResult {
  art: ProgrammeArtwork
  /**
   * True only for an authoritative "no artwork" outcome: a TMDb key is
   * configured, the search ran (or was skipped by design for a
   * high-confidence sport title) without failure, and no hierarchy
   * level produced art. False for the no-key path and for network /
   * auth / rate-limit failures — those must never be negatively cached.
   */
  negative: boolean
  /**
   * TTL for a negatively-cached placeholder. Sport titles re-check
   * after the short sports TTL (event art can appear closer to the
   * fixture); non-sport titles keep the 24h TMDb negative TTL.
   */
  negativeTtlMs: number
}

async function enrichProgrammeUncached(req: EnrichProgrammeRequest): Promise<UncachedResult> {
  const signals = parseProgrammeTitleSignals(req.title, req.channelName)
  if (!signals.query) return { art: placeholderArtwork(), negative: true, negativeTtlMs: NEGATIVE_TTL_MS }

  // Classify BEFORE any TMDb search: high-confidence sport titles skip
  // the blind search entirely (see shouldSkipTmdb).
  const classification = classifySportsProgramme(req.title, {
    channelName: req.channelName,
    category: req.category,
  })
  const negativeTtlMs = classification.isSport ? SPORTS_TTL_MS : NEGATIVE_TTL_MS

  // Channel branding is a valid fallback with or without a TMDb key — but
  // it is never cached (see enrichProgramme): a key added later must win.
  const channelFallback = channelArtwork(req)

  const tmdbActive = isTmdbActive()
  const apiKey = tmdbActive ? getTmdbApiKey() : ""
  const skipTmdb = shouldSkipTmdb(classification)

  // Level 1: exact verified programme artwork via TMDb. The
  // confident-match requirements in searchConfidentMatch are unchanged.
  let tmdbSearched = false
  let tmdbFailed = false
  if (!skipTmdb && apiKey) {
    const language = tmdbLanguage()
    try {
      const match = await searchConfidentMatch(apiKey, signals, language)
      tmdbSearched = true
      if (match) {
        const art = await fetchArtworkForMatch(apiKey, match, signals, language)
        if (art && (art.backdropUrl || art.posterUrl || art.stillUrl)) {
          return { art, negative: false, negativeTtlMs }
        }
      }
    } catch (error) {
      // Network / auth / rate-limit failure: fall through to the sport
      // levels (they need no TMDb key), then channel/placeholder.
      // Never thrown, and never negatively cached — a retry must be
      // able to succeed.
      tmdbFailed = true
      log.warn("[xt:livetv-enrich] enrich failed:", req.title, error)
    }
  }

  // Level 2: verified sports event artwork via the provider hook
  // (high/medium sport only; timeout + failure isolated).
  if (isProviderEligible(classification)) {
    const providerArt = await lookupProviderArtwork(classification, req)
    if (providerArt) return { art: providerArt, negative: false, negativeTtlMs }
  }

  // Level 3: team/venue photography from the bundled manifest (W5).
  // Cached under the composite sports-entry key with the short sports
  // TTL, like provider outcomes: the same fixture on another date
  // re-resolves, and a cached entry wins without re-running the
  // hierarchy (see the fast path in enrichProgramme and the provider
  // wrapper's cache check). No title-keyed entry is written: the
  // date-keyed sports cache is the only home for this art.
  if (classification.isSport) {
    const teamVenueArt = teamVenueArtwork(classification, req.title)
    if (teamVenueArt) {
      cachePut(sportsCacheKey(req.title, classification, req.startMs), teamVenueArt, false, SPORTS_TTL_MS)
      return { art: teamVenueArt, negative: false, negativeTtlMs }
    }
  }

  // Level 4: generic sport photography from the bundled manifest.
  if (classification.isSport) {
    const genericArt = genericSportArtwork(classification, req.title)
    if (genericArt) return { art: genericArt, negative: false, negativeTtlMs }
  }

  // Level 5: channel branding.
  if (channelFallback) return { art: channelFallback, negative: false, negativeTtlMs }

  // Level 6: branded placeholder.
  const negative = tmdbActive && !tmdbFailed && (tmdbSearched || skipTmdb)
  return { art: placeholderArtwork(), negative, negativeTtlMs }
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
    artworkKind: "channel-branding",
    provenance: { source: req.channelName?.trim() || "channel" },
  }
}

/**
 * Enrich one EPG programme title. Never throws; returns placeholder-source
 * on any failure. Only enriches when called — callers decide visibility.
 * Successful matches are cached 7 days; authoritative "no confident
 * match" results are negatively cached 24h (6h for sport titles, so
 * event art appearing later still wins). Verified sports-event art is
 * cached separately under a composite title+sport+teams/event+date key;
 * team/venue art is cached under the same composite key with the 6h
 * sports TTL; generic sport photos are title-cached 6h while a TMDb key is
 * configured, and never cached without one (a key added later must win).
 */
export async function enrichProgramme(req: EnrichProgrammeRequest): Promise<ProgrammeArtwork> {
  const key = normalizeProgrammeTitle(req.title)
  if (!key) return placeholderArtwork()

  const classification = classifySportsProgramme(req.title, {
    channelName: req.channelName,
    category: req.category,
  })

  // Verified sports-event art is checked first under its composite key:
  // a cached event image wins without re-running the TMDb search that
  // already lost on the first resolution — but only when TMDb is
  // skipped by design (high confidence) or inactive. For medium
  // confidence with an active key, exact TMDb art (level 1) must get
  // its chance first, so the check below falls through to the full
  // resolution, where the provider wrapper reuses the cached entry.
  if (isProviderEligible(classification) && (shouldSkipTmdb(classification) || !isTmdbActive())) {
    const sportsCached = sportsCacheGet(sportsCacheKey(req.title, classification, req.startMs))
    if (sportsCached.hit && sportsCached.art) return sportsCached.art
  }

  const cached = cacheGet(key)
  if (cached) return cached

  // In-flight dedup: sports resolutions dedup on the composite key (the
  // same fixture on different dates resolves independently); everything
  // else dedups on the normalised title as before.
  const dedupKey = isProviderEligible(classification)
    ? sportsCacheKey(req.title, classification, req.startMs)
    : key
  const inFlight = inflightEnrichments.get(dedupKey)
  if (inFlight) return inFlight

  const promise = (async (): Promise<ProgrammeArtwork> => {
    const { art, negative, negativeTtlMs } = await enrichProgrammeUncached(req)
    if (art.source === "placeholder") {
      // Negative-cache only an authoritative no-match while a key is
      // configured. No-key and network-failure placeholders are transient
      // by design (see enrichProgrammeUncached) and must not be cached:
      // re-checking is cheap and a later key / recovered network must work.
      if (negative && isTmdbActive()) cachePut(key, placeholderArtwork(), true, negativeTtlMs)
      return art
    }
    // Channel-source art is never cached: a TMDb key added later must win
    // over the logo fallback on the next enrich.
    if (art.source === "channel") return art
    if (art.source === "sports") {
      // Verified event art lives only in the date-keyed sports cache —
      // a title-keyed entry would serve one date's fixture art for
      // another. Team/venue (league-team) art likewise lives only
      // there: the level-3 resolution writes it under the composite
      // key with the short sports TTL, so nothing is written here.
      // Generic sport photos ARE title-cached while a key is
      // configured (TMDb already had its chance) with the short sports
      // TTL, so event art appearing later still wins.
      if (art.artworkKind === "generic-sport" && isTmdbActive()) {
        cachePut(key, art, false, SPORTS_TTL_MS)
      }
      return art
    }
    cachePut(key, art, false)
    return art
  })()

  inflightEnrichments.set(dedupKey, promise)
  try {
    return await promise
  } finally {
    inflightEnrichments.delete(dedupKey)
  }
}

/**
 * Cache peek only — no network. Returns the cached artwork for a title
 * (including a negatively-cached placeholder), or null when the title has
 * never been enriched or the entry expired. Dateless peeks check the
 * sports-event cache under today's broadcast date, with the same
 * hierarchy guard as enrichProgramme.
 */
export function getProgrammeArtworkSync(title: string): ProgrammeArtwork | null {
  const key = normalizeProgrammeTitle(title)
  if (!key) return null
  const classification = classifySportsProgramme(title)
  if (isProviderEligible(classification) && (shouldSkipTmdb(classification) || !isTmdbActive())) {
    const sportsCached = sportsCacheGet(sportsCacheKey(title, classification))
    if (sportsCached.hit && sportsCached.art) return sportsCached.art
  }
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

// 0.11.12 DISPLAY RULE (mirrors the consumer rule in TvProgrammeArt /
// Quick Surf / landing / browser / guide): when the resolver reports an
// artworkKind, only a displayable kind may supply an image — a
// displayable kind shows its art regardless of identity confidence (a
// confidently classified hockey title gets the hockey photo even though
// no exact event identity is established), and channel-branding /
// placeholder kinds never paint (the branded placeholder stays). A
// missing kind is legacy resolver output and keeps the slot order below
// unchanged.
const DISPLAYABLE_ARTWORK_KINDS: ReadonlySet<NonNullable<ProgrammeArtwork["artworkKind"]>> = new Set([
  "exact-programme",
  "exact-sports-event",
  "league-team",
  "generic-sport",
])

/** Pick the display URL for one artwork + variant under the display rule. */
export function pickArtworkUrl(art: ProgrammeArtwork, variant: string): string | null {
  if (art.artworkKind != null && !DISPLAYABLE_ARTWORK_KINDS.has(art.artworkKind)) return null
  if (variant === "card") return art.posterUrl || art.backdropUrl || art.stillUrl
  return art.backdropUrl || art.stillUrl || art.posterUrl
}

function applyArtworkToElement(element: HTMLElement, art: ProgrammeArtwork, variant: string): void {
  const url = pickArtworkUrl(art, variant)
  if (!url) {
    element.setAttribute("data-art-source", "placeholder")
    element.setAttribute("data-art-state", "done")
    return
  }
  element.setAttribute("data-art-source", art.source)
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
