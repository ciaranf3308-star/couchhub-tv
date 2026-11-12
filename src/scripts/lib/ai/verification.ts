// STUB — 0.11.6 W5: deleted at integration, replaced by the real implementation.
//
// Minimal, behaviourally transparent stand-in for W2's verification +
// catalogue-matching service, written ONLY so the 0.11.6 acceptance tests
// (tests/ai-discovery-3.0.test.ts) compile and their LOGIC is verified in
// the W5 worktree. It calls through to the injected TMDB search and
// applies only the frozen contract's stated semantics in the most literal
// way possible: TMDB resolves the identity, the catalogue decides
// playability, nothing is invented.
//
// Rules this stub pins (see the W5 report — if W2 chooses differently,
// the tests adapt at integration, not silently):
//   - Displayed title/year come from the TMDB result when one is picked;
//     kind stays the generated kind (TmdbSearchResult carries no media
//     type — the kind IS what was searched). The model's year and
//     externalId are NEVER trusted over TMDB.
//   - TMDB pick: the real pickTmdbMatch first; then an alias fallback
//     (normalised equality against title / original_title / name /
//     original_name) with a ±1 year gate whenever both years are known.
//     No fuzzy matching, no popularity rescue, no guessing.
//   - No TMDB pick, or a TMDB failure for that title, means UNVERIFIED:
//     generated title/year/kind kept as the model's claim, verified
//     false, tmdbId null, no genres/synopsis/poster, no catalogue match,
//     verificationNote set. Items are never dropped and never replaced.
//   - Catalogue matching runs ONLY for verified items, on the VERIFIED
//     title, against cleanProviderTitle(normalised) + kind + the same
//     ±1 year gate. First catalogue-order match wins; duplicates collapse
//     to one match. compositeId and catalogueKey are both the real
//     candidateKey of the matched entry.
//   - fetchDetails is assumed to be (tmdbId, kind) => details with
//     genres/synopsis/posterUrl/backdropUrl. Without it, genres are [],
//     synopsis is the search overview (or ""), poster comes from the
//     search poster_path, and there is no backdrop. A fetchDetails
//     failure falls back the same way — never invented data.
//   - concurrency is accepted and ignored: verification is sequential
//     and order-preserving, so results always follow generation order.
//   - Per-title failures are isolated: one title's TMDB failure never
//     affects the others.

import { candidateKey, type DiscoverCandidate } from "@/scripts/lib/discover.ts"
import { normalize } from "@/scripts/lib/text.ts"
import { cleanProviderTitle, pickTmdbMatch } from "@/scripts/lib/tmdb-match.ts"
import {
  TMDB_POSTER_SIZE,
  tmdbImageUrl,
  type TmdbSearchResult,
} from "@/scripts/lib/tmdb.ts"
import type { GeneratedRecommendation } from "./generation.ts"

export interface TmdbSearchQuery {
  title: string
  kind: "movie" | "series"
  year: number | null
}

export type TmdbSearchFn = (query: TmdbSearchQuery) => Promise<TmdbSearchResult[]>

export interface TmdbDetails {
  genres?: string[]
  synopsis?: string
  posterUrl?: string
  backdropUrl?: string
}

export type TmdbDetailsFn = (
  tmdbId: number,
  kind: "movie" | "series",
) => Promise<TmdbDetails | null>

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
  synopsis: string
  posterUrl?: string
  backdropUrl?: string
  match: CatalogueMatch | null
  verificationNote?: string
}

export interface VerifyRecommendationsDeps {
  searchTmdb: TmdbSearchFn
  catalogue: DiscoverCandidate[]
  fetchDetails?: TmdbDetailsFn
  concurrency?: number
}

function yearFromDate(dateField: string | undefined): number | null {
  if (!dateField) return null
  const match = dateField.match(/^(\d{4})/)
  return match ? Number(match[1]) : null
}

function resultTitle(result: TmdbSearchResult, kind: "movie" | "series"): string {
  return kind === "movie"
    ? result.title || result.original_title || ""
    : result.name || result.original_name || ""
}

function resultYear(result: TmdbSearchResult, kind: "movie" | "series"): number | null {
  return yearFromDate(kind === "movie" ? result.release_date : result.first_air_date)
}

function aliasTitles(result: TmdbSearchResult): string[] {
  return [result.title, result.original_title, result.name, result.original_name]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .map((value) => normalize(value))
}

/** Alias fallback: normalised title/alias equality + the ±1 year gate. */
function pickByAlias(
  results: TmdbSearchResult[],
  rec: GeneratedRecommendation,
): TmdbSearchResult | null {
  const wanted = normalize(rec.title)
  if (!wanted) return null
  const passing: Array<{ result: TmdbSearchResult; yearDiff: number }> = []
  for (const result of results) {
    if (!aliasTitles(result).includes(wanted)) continue
    const candidateYear = resultYear(result, rec.kind)
    if (rec.year != null && candidateYear != null) {
      const diff = Math.abs(candidateYear - rec.year)
      if (diff > 1) continue
      passing.push({ result, yearDiff: diff })
    } else {
      passing.push({ result, yearDiff: 0 })
    }
  }
  if (!passing.length) return null
  // No year to disambiguate with: refuse rather than guess between
  // distinct identities (the same conservatism as pickTmdbMatch).
  if (rec.year == null && new Set(passing.map((entry) => entry.result.id)).size > 1) {
    return null
  }
  passing.sort((a, b) => {
    if (a.yearDiff !== b.yearDiff) return a.yearDiff - b.yearDiff
    return (b.result.vote_count || 0) - (a.result.vote_count || 0)
  })
  return passing[0].result
}

function pickVerifiedIdentity(
  results: TmdbSearchResult[],
  rec: GeneratedRecommendation,
): TmdbSearchResult | null {
  const strict = pickTmdbMatch(results, {
    variants: [rec.title],
    year: rec.year,
    mediaType: rec.kind === "series" ? "tv" : "movie",
  })
  if (strict) {
    return results.find((result) => result.id === strict.id) ?? null
  }
  return pickByAlias(results, rec)
}

function candidateYear(candidate: DiscoverCandidate): number | null {
  if (typeof candidate.year === "number" && Number.isFinite(candidate.year)) {
    return candidate.year
  }
  return cleanProviderTitle(candidate.title).year
}

function matchCatalogue(
  verified: VerifiedRecommendation,
  catalogue: DiscoverCandidate[],
): CatalogueMatch | null {
  const wanted = normalize(verified.title)
  if (!wanted) return null
  for (const candidate of catalogue) {
    if (candidate.kind !== verified.kind) continue
    const { variants } = cleanProviderTitle(candidate.title)
    if (normalize(variants[0] || candidate.title) !== wanted) continue
    const entryYear = candidateYear(candidate)
    if (verified.year != null && entryYear != null && Math.abs(verified.year - entryYear) > 1) {
      continue
    }
    const key = candidateKey(candidate)
    return {
      compositeId: key,
      kind: candidate.kind as "movie" | "series",
      title: candidate.title,
      year: entryYear,
      catalogueKey: key,
    }
  }
  return null
}

function unverified(
  rec: GeneratedRecommendation,
  note: string,
): VerifiedRecommendation {
  return {
    generated: rec,
    verified: false,
    tmdbId: null,
    title: rec.title,
    year: rec.year,
    kind: rec.kind,
    reason: rec.reason,
    tone: rec.tone,
    genres: [],
    synopsis: "",
    match: null,
    verificationNote: note,
  }
}

export async function verifyRecommendations(
  recs: GeneratedRecommendation[],
  deps: VerifyRecommendationsDeps,
): Promise<VerifiedRecommendation[]> {
  const catalogue = deps.catalogue ?? []
  const out: VerifiedRecommendation[] = []
  for (const rec of recs ?? []) {
    let results: TmdbSearchResult[]
    try {
      results = await deps.searchTmdb({ title: rec.title, kind: rec.kind, year: rec.year })
    } catch {
      out.push(unverified(rec, "TMDB lookup failed for this title."))
      continue
    }
    const identity = pickVerifiedIdentity(results ?? [], rec)
    if (!identity) {
      out.push(unverified(rec, "No TMDB match could confirm this title."))
      continue
    }
    const title = resultTitle(identity, rec.kind) || rec.title
    const year = resultYear(identity, rec.kind) ?? rec.year
    let details: TmdbDetails | null = null
    if (deps.fetchDetails) {
      try {
        details = await deps.fetchDetails(identity.id, rec.kind)
      } catch {
        details = null
      }
    }
    const posterFromSearch = tmdbImageUrl(identity.poster_path, TMDB_POSTER_SIZE)
    const verified: VerifiedRecommendation = {
      generated: rec,
      verified: true,
      tmdbId: identity.id,
      title,
      year,
      kind: rec.kind,
      reason: rec.reason,
      tone: rec.tone,
      genres: details?.genres ?? [],
      synopsis: details?.synopsis ?? identity.overview ?? "",
      match: null,
    }
    const posterUrl = details?.posterUrl ?? posterFromSearch ?? undefined
    if (posterUrl) verified.posterUrl = posterUrl
    if (details?.backdropUrl) verified.backdropUrl = details.backdropUrl
    verified.match = matchCatalogue(verified, catalogue)
    out.push(verified)
  }
  return out
}
