// AI Discovery 3.0 (0.11.6) — TMDb verification + catalogue matching.
//
// Pipeline position: the LLM (W1 generation) proposes titles from its own
// knowledge; THIS layer decides what is real and what is playable. TMDb
// verifies what exists; the IPTV catalogue determines what is playable.
// Nothing the model says is trusted without independent verification:
// model-supplied identifiers are checked against TMDb and ignored when
// they disagree, verified titles/years always come from TMDb, and a
// catalogue entry is only ever matched confidently — never to fill a
// slot with something unrelated.
//
// Rules enforced here (brief §3):
// - Identity: exact normalised-title match against the TMDb search
//   results for the requested kind (movie -> /search/movie, series ->
//   /search/tv). One exact identity: verified, and TMDb's year wins
//   over a wrong model year (noted honestly). Several exact identities:
//   the generated year disambiguates (exact year, else within ±1 year);
//   anything still ambiguous is unverified, never guessed.
// - Kind: the verified kind must equal the generated kind. The search
//   endpoint is chosen by kind, so a series can never verify as a film.
// - External ids: verified independently via the /find endpoint (IMDb /
//   TVDb) or a direct bundle fetch (TMDb). An id that resolves to a
//   different title is ignored and the title/year path decides; an id
//   that conflicts with a confident title resolution marks the item
//   unverified. With no resolver supplied, external ids are ignored —
//   never trusted. Production wiring must pass defaultResolveExternalId.
// - Catalogue matching is conservative: normalised-name + alias + year
//   + kind, reusing cleanProviderTitle (quality suffixes, punctuation,
//   language prefixes, title variants). Exact provider-attached TMDb
//   ids match directly; a conflicting provider TMDb id excludes the
//   entry. Duplicate streams collapse to one best match; same-named
//   different-year titles are disambiguated by year, and ambiguity
//   means no match (Not in Library), never a false match.
// - Only the generated recommendations are verified (bounded count) —
//   never the whole catalogue. Concurrent TMDb requests are capped
//   (DEFAULT_VERIFICATION_CONCURRENCY). Verified identities are cached
//   (positive 7 days, authoritative no-match 24h, mirroring
//   livetv-enrichment.ts); transient failures are never cached, so a
//   retry can succeed. Catalogue matching itself is never cached: it
//   runs fresh against the catalogue passed in, so a changed library
//   can never resurrect a stale match.
// - Failure behaviour: one recommendation's TMDb failure marks only
//   that recommendation unverified (with an honest verificationNote);
//   the rest of the batch still verifies. An empty catalogue means all
//   matches are null while verification still proceeds.
//
// Presentation fields: the search result supplies the poster and a
// synopsis fallback, but TMDb search results carry no genres and no
// backdrop — those come from the details fetch (fetchDetails). When
// the caller supplies no fetchDetails, genres/backdrop stay empty and
// the search poster/overview are used. Production wiring must pass
// defaultFetchDetails for full presentation data.
//
// Privacy: only titles, years, kinds and TMDb/IMDb/TVDb ids ever reach
// TMDb. IPTV credentials and stream URLs are never sent anywhere here
// (the catalogue is matched locally, in memory).

import { getTmdbApiKey, isTmdbActive } from "@/scripts/lib/app-settings.js"
import { getActiveLocale } from "@/scripts/lib/i18n.js"
import { log } from "@/scripts/lib/log.js"
import {
  TmdbHttpError,
  tmdbFindByExternalId,
  tmdbImageUrl,
  tmdbLanguageFor,
  tmdbMovieAlternativeTitles,
  tmdbMovieBundle,
  tmdbSearchMovie,
  tmdbSearchTv,
  tmdbTvAlternativeTitles,
  tmdbTvBundle,
  TMDB_BACKDROP_SIZE,
  TMDB_POSTER_SIZE,
  type TmdbBundle,
  type TmdbSearchResult,
} from "@/scripts/lib/tmdb.ts"
import { cleanProviderTitle } from "@/scripts/lib/tmdb-match.ts"
import { normalize } from "@/scripts/lib/text.ts"
import type { DiscoverCandidate } from "@/scripts/lib/discover.ts"
import type { GeneratedRecommendation } from "./generation"

// ---------------------------------------------------------------------------
// GeneratedRecommendation — owned by W1's generation module (the single
// source of truth, imported above). Re-exported here so verification
// consumers keep importing the frozen shape from this module.
// ---------------------------------------------------------------------------

export type { GeneratedRecommendation }

export type GeneratedExternalId = NonNullable<GeneratedRecommendation["externalId"]>

// ---------------------------------------------------------------------------
// Frozen contracts (W1/W3/W5 build against these exact signatures)
// ---------------------------------------------------------------------------

export interface TmdbSearchQuery {
  title: string
  kind: "movie" | "series"
  year: number | null
}

export type TmdbSearchFn = (query: TmdbSearchQuery) => Promise<TmdbSearchResult[]>

export interface CatalogueMatch {
  compositeId: string
  kind: "movie" | "series"
  title: string
  year: number | null
  catalogueKey: string
}

export interface VerifiedRecommendation {
  generated: GeneratedRecommendation
  verified: boolean
  tmdbId: number | null
  title: string
  year: number | null
  kind: "movie" | "series"
  reason: string
  tone: string
  genres: string[]
  synopsis: string | null
  posterUrl: string | null
  backdropUrl: string | null
  match: CatalogueMatch | null
  verificationNote?: string
}

/** Details payload: genres/backdrop/synopsis/poster + title aliases for matching. */
export interface VerificationDetails {
  genres: string[]
  synopsis: string | null
  posterUrl: string | null
  backdropUrl: string | null
  alternativeTitles: string[]
}

/** Details fetch seam: genres/backdrop/synopsis/poster + aliases for one identity. */
export type TmdbDetailsFn = (
  tmdbId: number,
  kind: "movie" | "series"
) => Promise<VerificationDetails | null>

/**
 * Independent external-id resolution (additive, optional — see the
 * integration note on verifyRecommendations). Returns the TMDb
 * identity the id resolves to, or null when it resolves to nothing,
 * is ambiguous, or cannot be checked. Must never throw for a bad id;
 * transport failures may throw and are treated as "could not check".
 */
export type ExternalIdResolver = (
  externalId: GeneratedExternalId,
  kind: "movie" | "series"
) => Promise<{ tmdbId: number; title: string; year: number | null } | null>

export interface VerifyRecommendationsDeps {
  searchTmdb: TmdbSearchFn
  /**
   * Optional: an absent catalogue means availability is unknown
   * (matches stay null), never "not in library". The implementation
   * already tolerates absence; the type says so too.
   */
  catalogue?: DiscoverCandidate[]
  fetchDetails?: TmdbDetailsFn
  concurrency?: number
  /**
   * ADDITIVE (optional, backwards-compatible): when absent, model
   * supplied external ids are ignored entirely — never trusted.
   * Production wiring passes defaultResolveExternalId.
   */
  resolveExternalId?: ExternalIdResolver
}

// ---------------------------------------------------------------------------
// Concurrency + cache constants
// ---------------------------------------------------------------------------

/** Cap on concurrent TMDb requests per verifyRecommendations call. */
export const DEFAULT_VERIFICATION_CONCURRENCY = 3

/** Positive identity cache TTL — mirrors livetv-enrichment.ts. */
export const VERIFICATION_POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Authoritative no-match cache TTL — mirrors livetv-enrichment.ts. */
export const VERIFICATION_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

const VERIFICATION_CACHE_PERSIST_KEY = "xt_ai_verification_v1"
const MAX_PERSISTED_ENTRIES = 200
const CACHE_KEY_VERSION = "ai-verify-v1"

/** Year tolerance when disambiguating same-named titles (mirrors pickTmdbMatch). */
const CLOSE_YEAR_TOLERANCE = 1

// ---------------------------------------------------------------------------
// Pure helpers: TMDb search-result reading + identity picking
// ---------------------------------------------------------------------------

function resultDisplayTitle(result: TmdbSearchResult, kind: "movie" | "series"): string {
  return kind === "movie"
    ? result.title || result.original_title || ""
    : result.name || result.original_name || ""
}

function resultYear(result: TmdbSearchResult, kind: "movie" | "series"): number | null {
  const dateField = kind === "movie" ? result.release_date : result.first_air_date
  if (!dateField) return null
  const match = dateField.match(/^(\d{4})/)
  return match ? Number(match[1]) : null
}

/** True when any title field of the result exactly equals the generated title (normalised). */
function resultMatchesGeneratedTitle(
  result: TmdbSearchResult,
  kind: "movie" | "series",
  normalizedGeneratedTitle: string
): boolean {
  const fields =
    kind === "movie" ? [result.title, result.original_title] : [result.name, result.original_name]
  return fields.some((field) => !!field && normalize(field) === normalizedGeneratedTitle)
}

export type VerifiedMatchOutcome =
  | {
      status: "match"
      result: TmdbSearchResult
      title: string
      year: number | null
    }
  | { status: "none" }
  | { status: "ambiguous" }

/**
 * Pick the verified identity from one kind-correct TMDb search page.
 * Exact normalised-title equality is required (title or original
 * title); popularity never promotes a different title. A single exact
 * identity verifies even when its year disagrees with the generated
 * year — TMDb corrects the model, and the caller notes the correction.
 * Several exact identities need the generated year to disambiguate
 * (exact year first, then within ±1 year); anything still unresolved
 * is ambiguous, never guessed. This is deliberately stricter than
 * pickTmdbMatch in one place (no vote/popularity tie-break: a guess
 * between two same-named films is still a guess) and more lenient in
 * one place (a lone exact identity corrects a wrong model year,
 * where pickTmdbMatch would reject it for being outside ±1 year).
 */
export function pickVerifiedTmdbMatch(
  results: TmdbSearchResult[] | null | undefined,
  generated: { title: string; year: number | null; kind: "movie" | "series" }
): VerifiedMatchOutcome {
  const normalizedTitle = normalize(generated.title)
  if (!normalizedTitle || !results?.length) return { status: "none" }

  const seenIds = new Set<number>()
  const exact: TmdbSearchResult[] = []
  for (const result of results) {
    if (seenIds.has(result.id)) continue
    seenIds.add(result.id)
    if (resultMatchesGeneratedTitle(result, generated.kind, normalizedTitle)) exact.push(result)
  }

  if (!exact.length) return { status: "none" }
  const toMatch = (result: TmdbSearchResult): VerifiedMatchOutcome => ({
    status: "match",
    result,
    title: resultDisplayTitle(result, generated.kind),
    year: resultYear(result, generated.kind),
  })
  if (exact.length === 1) return toMatch(exact[0])

  // Several exact identities: the generated year must disambiguate.
  if (generated.year == null) return { status: "ambiguous" }
  const exactYear = exact.filter((result) => resultYear(result, generated.kind) === generated.year)
  if (exactYear.length === 1) return toMatch(exactYear[0])
  if (exactYear.length > 1) return { status: "ambiguous" }
  const closeYear = exact.filter((result) => {
    const year = resultYear(result, generated.kind)
    return year != null && Math.abs(year - (generated.year as number)) <= CLOSE_YEAR_TOLERANCE
  })
  if (closeYear.length === 1) return toMatch(closeYear[0])
  return { status: "ambiguous" }
}

// ---------------------------------------------------------------------------
// Catalogue matching (conservative; never a false match)
// ---------------------------------------------------------------------------

function catalogueEntryYear(entry: DiscoverCandidate, nameYear: number | null): number | null {
  if (nameYear != null) return nameYear
  return typeof entry.year === "number" && Number.isFinite(entry.year) ? entry.year : null
}

export interface VerifiedIdentityForMatching {
  tmdbId: number
  title: string
  year: number | null
  kind: "movie" | "series"
  alternativeTitles?: string[]
}

/**
 * Match one verified TMDb identity against the catalogue, conservatively.
 *
 * - Kind must match; live entries never match.
 * - An entry whose provider-attached tmdbId equals the verified id is a
 *   direct match (a genuinely shared exact id), even when its provider
 *   name is translated or noisy. An entry whose provider tmdbId is a
 *   DIFFERENT id is excluded outright — the provider says it is a
 *   different TMDb identity, so a title coincidence must not override it.
 * - Otherwise the entry's cleaned provider variants (cleanProviderTitle:
 *   quality suffixes, brackets, language prefixes, punctuation) must
 *   exactly equal the verified title or one of its alternative titles
 *   (normalised). No substring or fuzzy matching.
 * - Year gate: when both the entry year (from the provider name or the
 *   row) and the TMDb year are known, they must be within ±1 year.
 * - Duplicates (same title, same year, several streams/language
 *   variants) collapse to the first entry in catalogue order — one
 *   match per recommendation, deterministically. Distinct known years
 *   surviving the gate (e.g. 1999 and 2001 against a 2000 title with
 *   no exact-year entry) mean ambiguity: null, never a guess.
 *
 * catalogueKey semantics: the composite candidate key
 * `${kind}:${id}` — exactly candidateKey() in discover.ts and
 * compositeCandidateId() in ai/ranking.ts, the key the existing detail
 * flow uses (data-couch-key + candidateDetailHref). The UI turns a
 * match into a Play action by opening the existing detail route for
 * that key: `/movies/detail?id=${id}` for movies,
 * `/series/detail?id=${id}` for series (see candidateDetailHref in
 * discover.ts); the detail page owns playback. compositeId carries
 * the same value: the composite identity IS the catalogue key.
 */
export function matchVerifiedTitleToCatalog(
  verified: VerifiedIdentityForMatching,
  catalogue: DiscoverCandidate[] | null | undefined
): CatalogueMatch | null {
  if (!catalogue?.length) return null

  const aliases = new Set<string>()
  for (const alias of [verified.title, ...(verified.alternativeTitles || [])]) {
    const normalized = normalize(alias)
    if (normalized) aliases.add(normalized)
  }
  if (!aliases.size) return null

  const kindEntries = catalogue.filter((entry) => entry.kind === verified.kind)
  if (!kindEntries.length) return null

  // Tier 1: exact shared TMDb id. First in catalogue order wins among
  // duplicate streams of the same identity.
  for (const entry of kindEntries) {
    if (entry.tmdbId != null && entry.tmdbId === verified.tmdbId) {
      const key = `${entry.kind}:${entry.id}`
      return {
        compositeId: key,
        kind: verified.kind,
        title: verified.title,
        year: verified.year,
        catalogueKey: key,
      }
    }
  }

  interface PassingEntry {
    entry: DiscoverCandidate
    entryYear: number | null
  }
  const passing: PassingEntry[] = []
  for (const entry of kindEntries) {
    // A conflicting provider-attached TMDb id vetoes the entry.
    if (entry.tmdbId != null && entry.tmdbId !== verified.tmdbId) continue
    const { variants, year: nameYear } = cleanProviderTitle(entry.title)
    const titleMatches = variants.some((variant) => aliases.has(normalize(variant)))
    if (!titleMatches) continue
    const entryYear = catalogueEntryYear(entry, nameYear)
    if (
      entryYear != null &&
      verified.year != null &&
      Math.abs(entryYear - verified.year) > CLOSE_YEAR_TOLERANCE
    ) {
      continue
    }
    passing.push({ entry, entryYear })
  }
  if (!passing.length) return null

  // Prefer exact-year entries; the ±1 allowance is a fallback pool.
  let pool = passing
  if (verified.year != null) {
    const exactYear = passing.filter((candidate) => candidate.entryYear === verified.year)
    if (exactYear.length) pool = exactYear
  }

  // Distinct known years in the pool = genuinely ambiguous: no match.
  const knownYears = new Set(pool.map((candidate) => candidate.entryYear).filter((y) => y != null))
  if (knownYears.size > 1) return null

  const best = pool[0].entry
  const key = `${best.kind}:${best.id}`
  return {
    compositeId: key,
    kind: verified.kind,
    title: verified.title,
    year: verified.year,
    catalogueKey: key,
  }
}

// ---------------------------------------------------------------------------
// Identity cache (positive 7d / authoritative-negative 24h; failures uncached)
// ---------------------------------------------------------------------------

interface ResolvedIdentity {
  verified: boolean
  tmdbId: number | null
  title: string
  year: number | null
  genres: string[]
  synopsis: string | null
  posterUrl: string | null
  backdropUrl: string | null
  alternativeTitles: string[]
  /** True when a details fetch contributed (or was attempted and none was needed). */
  detailsFetched: boolean
  verificationNote?: string
}

interface CacheEntry {
  identity: ResolvedIdentity
  expiresAt: number
  negative: boolean
}

const memoryCache = new Map<string, CacheEntry>()
let persistedHydrated = false
const inflightResolutions = new Map<string, Promise<ResolvedIdentity>>()

function verificationCacheKey(rec: GeneratedRecommendation): string {
  const external = rec.externalId ? `${rec.externalId.source}:${rec.externalId.id}` : ""
  return [CACHE_KEY_VERSION, rec.kind, normalize(rec.title), rec.year ?? "", external].join("|")
}

function readPersistedCache(): Record<string, CacheEntry> {
  try {
    if (typeof localStorage === "undefined") return {}
    const raw = localStorage.getItem(VERIFICATION_CACHE_PERSIST_KEY)
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
    for (const [key, entry] of Object.entries(readPersistedCache())) {
      if (!entry?.identity || typeof entry.expiresAt !== "number" || entry.expiresAt <= now) continue
      if (!memoryCache.has(key)) memoryCache.set(key, entry)
    }
  } catch {
    // Persistence is best-effort; a corrupt entry must never break verification.
  }
}

function persistCache(): void {
  try {
    if (typeof localStorage === "undefined") return
    const now = Date.now()
    const entries = [...memoryCache.entries()]
      .filter(([, entry]) => entry.expiresAt > now)
      .slice(-MAX_PERSISTED_ENTRIES)
    localStorage.setItem(VERIFICATION_CACHE_PERSIST_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Best-effort only (private mode / quota). The in-memory cache still works.
  }
}

function cacheGet(key: string): ResolvedIdentity | null {
  hydratePersistedCache()
  const entry = memoryCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key)
    return null
  }
  return entry.identity
}

function cachePut(key: string, identity: ResolvedIdentity, negative: boolean): void {
  memoryCache.set(key, {
    identity,
    expiresAt: Date.now() + (negative ? VERIFICATION_NEGATIVE_TTL_MS : VERIFICATION_POSITIVE_TTL_MS),
    negative,
  })
  persistCache()
}

/** Test/support hook: clears the in-memory cache and its persisted copy. */
export function clearVerificationCache(): void {
  memoryCache.clear()
  inflightResolutions.clear()
  persistedHydrated = true
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(VERIFICATION_CACHE_PERSIST_KEY)
  } catch {
    // Ignore — the cache is already cleared in memory.
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter (per verifyRecommendations call)
// ---------------------------------------------------------------------------

type LimitedCall = <T>(fn: () => Promise<T>) => Promise<T>

function createLimiter(limit: number): LimitedCall {
  const max = Math.max(1, Math.floor(limit) || DEFAULT_VERIFICATION_CONCURRENCY)
  let active = 0
  const waiters: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      const next = waiters.shift()
      if (next) next()
    }
  }
}

// ---------------------------------------------------------------------------
// Identity resolution (search -> external-id check -> details)
// ---------------------------------------------------------------------------

function verificationFailureNote(error: unknown): string {
  if (error instanceof TmdbHttpError) {
    if (error.status === 401) return "TMDb verification failed: the configured TMDb key was rejected."
    if (error.status === 429) return "TMDb verification failed: rate limited. Try again shortly."
    return `TMDb verification failed (TMDb error ${error.status}), so this title could not be confirmed.`
  }
  if (error instanceof Error && /not configured/i.test(error.message)) {
    return "TMDb is not configured, so this title could not be verified."
  }
  return "TMDb verification failed, so this title could not be confirmed."
}

function unverifiedIdentity(
  rec: GeneratedRecommendation,
  verificationNote: string
): ResolvedIdentity {
  return {
    verified: false,
    tmdbId: null,
    title: rec.title,
    year: rec.year,
    genres: [],
    synopsis: null,
    posterUrl: null,
    backdropUrl: null,
    alternativeTitles: [],
    detailsFetched: false,
    verificationNote,
  }
}

function joinNotes(...notes: Array<string | undefined>): string {
  return notes.filter(Boolean).join(" ")
}

interface ResolutionContext {
  searchTmdb: TmdbSearchFn
  fetchDetails?: VerifyRecommendationsDeps["fetchDetails"]
  resolveExternalId?: ExternalIdResolver
  limit: LimitedCall
}

async function resolveIdentityUncached(
  rec: GeneratedRecommendation,
  ctx: ResolutionContext
): Promise<{ identity: ResolvedIdentity; negative: boolean }> {
  const trimmedTitle = rec.title?.trim() ?? ""
  if (!trimmedTitle) {
    return { identity: unverifiedIdentity(rec, "No title was supplied to verify."), negative: true }
  }

  // 1. Title/year search on the kind-correct endpoint.
  let results: TmdbSearchResult[]
  try {
    results = await ctx.limit(() =>
      ctx.searchTmdb({ title: trimmedTitle, kind: rec.kind, year: rec.year })
    )
  } catch (error) {
    log.warn("[xt:ai-verify] TMDb search failed:", trimmedTitle, error)
    // Transient failure: never cached, so a retry can succeed.
    return { identity: unverifiedIdentity(rec, verificationFailureNote(error)), negative: false }
  }
  const pick = pickVerifiedTmdbMatch(results, rec)

  // 2. Independent external-id check (when the model supplied one and
  // a resolver was wired). The id is evidence, never authority.
  let externalNote: string | undefined
  let externalIdentity: { tmdbId: number; title: string; year: number | null } | null = null
  const resolver = ctx.resolveExternalId
  if (rec.externalId && resolver) {
    const suppliedId = rec.externalId
    try {
      const resolved = await ctx.limit(() => resolver(suppliedId, rec.kind))
      if (resolved && normalize(resolved.title) === normalize(trimmedTitle)) {
        externalIdentity = resolved
      } else if (resolved) {
        externalNote = "The supplied external ID pointed at a different title, so it was ignored."
      } else {
        externalNote = "The supplied external ID could not be checked, so it was ignored."
      }
    } catch {
      externalNote = "The supplied external ID could not be checked, so it was ignored."
    }
  }

  // A confident title resolution that disagrees with a title-agreeing
  // external id is conflicting evidence: unverified, never guessed.
  if (externalIdentity && pick.status === "match" && externalIdentity.tmdbId !== pick.result.id) {
    return {
      identity: unverifiedIdentity(
        rec,
        "Conflicting identities: the supplied external ID and the title search point at different TMDb entries."
      ),
      negative: true,
    }
  }

  // An external id that agrees on title resolves a missing or
  // ambiguous title search — the id disambiguates, the title confirms.
  const useExternal = externalIdentity && pick.status !== "match"
  if (pick.status === "none" && !useExternal) {
    return {
      identity: unverifiedIdentity(
        rec,
        joinNotes("No confident TMDb match for this title.", externalNote)
      ),
      negative: true,
    }
  }
  if (pick.status === "ambiguous" && !useExternal) {
    return {
      identity: unverifiedIdentity(
        rec,
        joinNotes(
          "Several TMDb titles share this name, so the exact title could not be confirmed.",
          externalNote
        )
      ),
      negative: true,
    }
  }

  // 3. Verified identity: title/year come from TMDb, never the model.
  // (The early returns above leave only: an external identity, or a
  // confident title match. The defensive branch is unreachable.)
  let tmdbId: number
  let tmdbTitle: string
  let tmdbYear: number | null
  let searchResult: TmdbSearchResult | null
  if (useExternal && externalIdentity) {
    tmdbId = externalIdentity.tmdbId
    tmdbTitle = externalIdentity.title
    tmdbYear = externalIdentity.year
    searchResult = null
  } else if (pick.status === "match") {
    tmdbId = pick.result.id
    tmdbTitle = pick.title
    tmdbYear = pick.year
    searchResult = pick.result
  } else {
    return {
      identity: unverifiedIdentity(rec, "No confident TMDb match for this title."),
      negative: true,
    }
  }

  let genres: string[] = []
  let synopsis: string | null = searchResult?.overview || null
  let posterUrl: string | null = searchResult
    ? tmdbImageUrl(searchResult.poster_path, TMDB_POSTER_SIZE)
    : null
  let backdropUrl: string | null = searchResult
    ? tmdbImageUrl(searchResult.backdrop_path, TMDB_BACKDROP_SIZE)
    : null
  let alternativeTitles: string[] = []
  let detailsFetched = false
  let detailsNote: string | undefined

  // 4. Details enrich genres/backdrop/aliases. Search results carry
  // no genres and (in this client's shape) are the only source of a
  // poster/synopsis when no details fetch is wired. A failed details
  // fetch degrades presentation only — the identity stays verified.
  if (ctx.fetchDetails) {
    const fetchDetails = ctx.fetchDetails
    try {
      const details = await ctx.limit(() => fetchDetails(tmdbId, rec.kind))
      if (details) {
        detailsFetched = true
        genres = details.genres
        synopsis = details.synopsis || synopsis
        posterUrl = details.posterUrl || posterUrl
        backdropUrl = details.backdropUrl || backdropUrl
        alternativeTitles = details.alternativeTitles
      } else {
        detailsNote = "TMDb details were unavailable for this title."
      }
    } catch {
      detailsNote = "TMDb details were unavailable for this title."
    }
  }

  let yearNote: string | undefined
  if (rec.year != null && tmdbYear != null && tmdbYear !== rec.year) {
    yearNote = `TMDb lists this as ${tmdbYear}, not ${rec.year}.`
  }

  return {
    identity: {
      verified: true,
      tmdbId,
      title: tmdbTitle,
      year: tmdbYear,
      genres,
      synopsis,
      posterUrl,
      backdropUrl,
      alternativeTitles,
      detailsFetched,
      verificationNote: joinNotes(yearNote, useExternal ? undefined : externalNote, detailsNote),
    },
    negative: false,
  }
}

async function resolveIdentity(
  rec: GeneratedRecommendation,
  ctx: ResolutionContext
): Promise<ResolvedIdentity> {
  const key = verificationCacheKey(rec)
  try {
    const cached = cacheGet(key)
    if (cached) {
      // A cached identity resolved without details can still gain
      // them when this call wires a details fetch — without a new
      // search. (A cached negative never re-fetches details.)
      if (cached.verified && !cached.detailsFetched && ctx.fetchDetails && cached.tmdbId != null) {
        const fetchDetails = ctx.fetchDetails
        const cachedTmdbId = cached.tmdbId
        try {
          const details = await ctx.limit(() => fetchDetails(cachedTmdbId, rec.kind))
          if (details) {
            const enriched: ResolvedIdentity = {
              ...cached,
              genres: details.genres,
              synopsis: details.synopsis || cached.synopsis,
              posterUrl: details.posterUrl || cached.posterUrl,
              backdropUrl: details.backdropUrl || cached.backdropUrl,
              alternativeTitles: details.alternativeTitles,
              detailsFetched: true,
            }
            cachePut(key, enriched, false)
            return enriched
          }
        } catch {
          // Keep the cached identity; details stay unavailable.
        }
      }
      return cached
    }

    const inFlight = inflightResolutions.get(key)
    if (inFlight) return inFlight

    const promise = (async (): Promise<ResolvedIdentity> => {
      const { identity, negative } = await resolveIdentityUncached(rec, ctx)
      // Only cache verified identities and authoritative no-matches.
      // Transient failures (negative=false, unverified) are not cached.
      if (identity.verified || negative) cachePut(key, identity, negative)
      return identity
    })()
    inflightResolutions.set(key, promise)
    try {
      return await promise
    } finally {
      inflightResolutions.delete(key)
    }
  } catch (error) {
    // Resolution must never throw: one bad recommendation must not
    // fail the batch. Belt-and-braces — resolveIdentityUncached
    // already catches search/details failures.
    log.warn("[xt:ai-verify] resolution failed:", rec.title, error)
    return unverifiedIdentity(rec, verificationFailureNote(error))
  }
}

// ---------------------------------------------------------------------------
// Public entry point (frozen signature)
// ---------------------------------------------------------------------------

/**
 * Verify generated recommendations against TMDb and match the verified
 * titles against the catalogue. Output order matches input order.
 *
 * Frozen deps are searchTmdb + catalogue (+ optional fetchDetails and
 * concurrency). The optional resolveExternalId dep is additive: when
 * absent, model-supplied external ids are ignored, never trusted.
 * Production wiring passes defaultTmdbSearch, defaultFetchDetails and
 * defaultResolveExternalId.
 */
export async function verifyRecommendations(
  recs: GeneratedRecommendation[],
  deps: VerifyRecommendationsDeps
): Promise<VerifiedRecommendation[]> {
  const list = Array.isArray(recs) ? recs : []
  const catalogue = Array.isArray(deps?.catalogue) ? deps.catalogue : []
  const ctx: ResolutionContext = {
    searchTmdb: deps.searchTmdb,
    fetchDetails: deps.fetchDetails,
    resolveExternalId: deps.resolveExternalId,
    limit: createLimiter(deps.concurrency ?? DEFAULT_VERIFICATION_CONCURRENCY),
  }
  return Promise.all(
    list.map(async (rec): Promise<VerifiedRecommendation> => {
      const identity = await resolveIdentity(rec, ctx)
      const match =
        identity.verified && identity.tmdbId != null
          ? matchVerifiedTitleToCatalog(
              {
                tmdbId: identity.tmdbId,
                title: identity.title,
                year: identity.year,
                kind: rec.kind,
                alternativeTitles: identity.alternativeTitles,
              },
              catalogue
            )
          : null
      return {
        generated: rec,
        verified: identity.verified,
        tmdbId: identity.tmdbId,
        title: identity.title,
        year: identity.year,
        kind: rec.kind,
        reason: rec.reason,
        tone: rec.tone,
        genres: identity.genres,
        synopsis: identity.synopsis,
        posterUrl: identity.posterUrl,
        backdropUrl: identity.backdropUrl,
        match,
        ...(identity.verificationNote ? { verificationNote: identity.verificationNote } : {}),
      }
    })
  )
}

// ---------------------------------------------------------------------------
// Default production wiring (real TMDb client, configured key)
// ---------------------------------------------------------------------------

function tmdbRequestLanguage(): string {
  try {
    return tmdbLanguageFor(getActiveLocale())
  } catch {
    return "en-US"
  }
}

/**
 * Default TMDb search: wraps the real client and reads the configured
 * key internally, like the existing enrichment. Throws when TMDb is
 * not configured (the verifier turns that into an honest unverified
 * note per recommendation — it never reports "not found" for a
 * missing key).
 *
 * The generated year is deliberately NOT passed as a TMDb search
 * filter: TMDb's year parameter is exact, and the model year is
 * unverified input — filtering on a wrong model year would hide the
 * correct identity. The verifier applies its own year policy
 * (single-identity correction, multi-identity disambiguation) to the
 * unfiltered title results instead.
 */
export function defaultTmdbSearch(): TmdbSearchFn {
  return async ({ title, kind }) => {
    if (!isTmdbActive()) throw new Error("TMDb is not configured")
    const apiKey = getTmdbApiKey()
    const language = tmdbRequestLanguage()
    return kind === "movie"
      ? tmdbSearchMovie(apiKey, title, { language })
      : tmdbSearchTv(apiKey, title, { language })
  }
}

type TmdbBundleWithDates = TmdbBundle & {
  release_date?: string | null
  first_air_date?: string | null
}

function bundleYear(bundle: TmdbBundleWithDates, kind: "movie" | "series"): number | null {
  const dateField = kind === "movie" ? bundle.release_date : bundle.first_air_date
  if (!dateField) return null
  const match = dateField.match(/^(\d{4})/)
  return match ? Number(match[1]) : null
}

/**
 * Default external-id resolver: verifies a model-supplied id
 * independently. TMDb ids resolve via a direct bundle fetch on the
 * kind-correct endpoint (404 = no such identity); IMDb/TVDb ids via
 * TMDb's /find endpoint. Returns null for anything unresolvable or
 * ambiguous. Never sends catalogue or credential data — only the id.
 */
export function defaultResolveExternalId(): ExternalIdResolver {
  return async (externalId, kind) => {
    if (!isTmdbActive()) return null
    const apiKey = getTmdbApiKey()
    if (externalId.source === "tmdb") {
      const tmdbId = Number(externalId.id)
      if (!Number.isFinite(tmdbId) || tmdbId < 1) return null
      try {
        const bundle: TmdbBundleWithDates =
          kind === "movie"
            ? await tmdbMovieBundle(apiKey, tmdbId)
            : await tmdbTvBundle(apiKey, tmdbId)
        const title = kind === "movie" ? bundle.title || "" : bundle.name || ""
        if (!title) return null
        return { tmdbId, title, year: bundleYear(bundle, kind) }
      } catch (error) {
        if (error instanceof TmdbHttpError && error.status === 404) return null
        throw error
      }
    }
    const externalSource = externalId.source === "imdb" ? "imdb_id" : "tvdb_id"
    const found = await tmdbFindByExternalId(apiKey, externalSource, externalId.id)
    const results = kind === "movie" ? found.movieResults : found.tvResults
    if (results.length !== 1) return null
    const result = results[0]
    const title = resultDisplayTitle(result, kind)
    if (!title) return null
    return { tmdbId: result.id, title, year: resultYear(result, kind) }
  }
}

/**
 * Default details fetch: reuses the existing cached enrichment
 * (fetchMovieEnrichment / fetchSeriesEnrichment, 30-day IndexedDB
 * detail cache) for genres/synopsis/poster/backdrop, plus a minimal
 * alternative-titles fetch used only for catalogue matching. The
 * enrichment module is dynamic-imported so unit tests using injected
 * deps never pull in the IndexedDB cache layer. Returns null when
 * TMDb is inactive or the title has no enrichment.
 */
export async function defaultFetchDetails(
  tmdbId: number,
  kind: "movie" | "series"
): Promise<VerificationDetails | null> {
  if (!isTmdbActive()) return null
  const { fetchMovieEnrichment, fetchSeriesEnrichment } =
    await import("@/scripts/lib/tmdb-enrich.ts")
  const enrichment =
    kind === "movie" ? await fetchMovieEnrichment(tmdbId) : await fetchSeriesEnrichment(tmdbId)
  if (!enrichment) return null
  let alternativeTitles: string[] = []
  try {
    const apiKey = getTmdbApiKey()
    alternativeTitles =
      kind === "movie"
        ? await tmdbMovieAlternativeTitles(apiKey, tmdbId)
        : await tmdbTvAlternativeTitles(apiKey, tmdbId)
  } catch {
    // Alternative titles only widen matching; their absence must never
    // lose an otherwise complete details payload. alternativeTitles
    // stays [] here.
  }
  return {
    genres: enrichment.genres,
    synopsis: enrichment.overview || null,
    posterUrl: enrichment.posterUrl,
    backdropUrl: enrichment.backdropUrl,
    alternativeTitles,
  }
}
