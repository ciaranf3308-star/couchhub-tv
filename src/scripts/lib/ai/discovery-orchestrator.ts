// SHIM — 0.11.6 W3: replaced at integration by the real implementation
// (W1 owns the orchestrator; W2 owns verification/matching). This file
// exists only so the Discover UI (W3) can build against the FROZEN
// contracts while W1/W2 build the real modules in parallel.
// Integration DELETES this file and drops in the real orchestrator;
// the exported names, request/response shapes and the
// VerifiedRecommendation fields below are the frozen contract.
//
// What this shim does (and nothing more):
// - Returns canned-but-shape-correct recommendations from a small
//   fixture table of REAL, well-known titles, so renders exercise the
//   real UI states (mixed availability, refinement, cache, failure).
//   The fixture table, poster URLs and TMDB ids in it are FIXTURE
//   DATA ONLY — they are not verified metadata and must never survive
//   integration. No other file in this branch hardcodes recommendations.
// - Matches canned titles against `deps.catalogue` (when the caller
//   passes the loaded catalogue) by normalised title + kind + year, so
//   "In your library" vs "Not in your library" in renders reflects the
//   fixture catalogue, not a guess. With no catalogue, nothing matches.
// - Emits staged progress through `deps.onPhase` (asking -> verifying
//   -> checking) with short delays, so the in-flight states are
//   observable. The real orchestrator may emit the same phases or none
//   at all — the UI degrades to a single "Asking AI…" state when no
//   progress events arrive.
// - Simulates a cache: an identical repeat request returns a
//   cached-ai receipt with no new "request".
// - Honours AbortSignal: an aborted run rejects with an AbortError and
//   produces no receipt.
// - Render/test scenarios, read ONLY from sessionStorage key
//   `rs-discovery-shim-scenario` (set by the render harness, never by
//   production UI): "unavailable" (throws a provider error),
//   "unverified" (every title unverified, no artwork),
//   "no-matches" (nothing matches the catalogue), "empty" (no results).
//   `deps.handler`, when supplied, overrides everything: tests use it
//   to count model calls and control outcomes exactly.
//
// Deviations / open questions for integration (see W3 report):
// - `match.compositeId` and `match.catalogueKey` are both set to the
//   candidate key (`kind:id`, the 0.11.5 composite identity). W2 to
//   confirm whether they ever differ.
// - `deps` is open-ended in the frozen contract; this shim defines
//   { model, catalogue, onPhase, handler }. W1 to confirm how the
//   catalogue and the configured model reach the real orchestrator.

import type { AiSearchDiagnostics, AiSearchReceipt } from "./status.ts"
import {
  conversationContextFor,
  type ConversationState,
} from "./generation.ts"
import type { DiscoverCandidate } from "@/scripts/lib/discover.ts"

// ---------------------------------------------------------------------------
// Frozen types (W2 owns VerifiedRecommendation; the shape is frozen here
// so the UI can build against it — integration reconciles the canonical
// home of the type).
// ---------------------------------------------------------------------------

export interface RecommendationMatch {
  compositeId: string
  kind: "movie" | "series"
  title: string
  year: number | null
  /** Candidate key (`kind:id`) — the UI derives the detail href from it. */
  catalogueKey: string
}

export interface VerifiedRecommendation {
  /** Title exactly as the model generated it, before TMDB canonicalisation. */
  generated: string
  /** True only when TMDB verified the identity. False stays visibly unverified. */
  verified: boolean
  tmdbId: number | null
  title: string
  year: number | null
  kind: "movie" | "series"
  /** The model's brief, specific reason for this title. */
  reason: string
  /** Tone/theme, e.g. "Dark and tense". */
  tone: string
  genres: string[]
  synopsis: string
  posterUrl: string | null
  backdropUrl: string | null
  /** Catalogue match for playability, or null when not in the library. */
  match: RecommendationMatch | null
  /** Why verification failed, when verified is false. */
  verificationNote?: string
}

export interface DiscoveryRequest {
  query: string
  conversation: ConversationState
  tasteSummary?: string | null
  availableOnly: boolean
  count?: number
  signal?: AbortSignal
}

/** Staged progress the UI may display while a run is in flight. */
export type DiscoveryProgressPhase = "asking" | "verifying" | "checking"

export interface DiscoveryOrchestratorDeps {
  /** Configured model id, carried onto the receipt when a request runs. */
  model?: string
  /** Loaded catalogue candidates, for playability matching. */
  catalogue?: DiscoverCandidate[]
  /** Optional progress callback; the UI works fine without it. */
  onPhase?: (phase: DiscoveryProgressPhase) => void
  /**
   * Test/render override: replaces the canned shim result entirely.
   * When present, the cache, scenarios and staged delays are bypassed
   * and the handler's result is returned verbatim.
   */
  handler?: (request: DiscoveryRequest) => Promise<DiscoveryResult>
}

export interface DiscoveryResult {
  results: VerifiedRecommendation[]
  receipt: AiSearchReceipt
  diagnostics: AiSearchDiagnostics
  conversation: ConversationState
}

// ---------------------------------------------------------------------------
// Fixture table (FIXTURE DATA ONLY — deleted with this shim).
// ---------------------------------------------------------------------------

interface FixtureTitle {
  title: string
  year: number
  kind: "movie" | "series"
  tmdbId: number
  slug: string
  genres: string[]
  tone: string
  reason: string
  synopsis: string
}

const FIXTURE_SETS: Record<string, FixtureTitle[]> = {
  default: [
    {
      title: "The Shawshank Redemption",
      year: 1994,
      kind: "movie",
      tmdbId: 278,
      slug: "shawshank",
      genres: ["Drama"],
      tone: "Warm and hopeful",
      reason: "A patient, deeply humane story about hope that earns its ending — the kind of film that stays with you after the credits.",
      synopsis: "Imprisoned for a crime he did not commit, a banker forms an unlikely friendship and finds hope in the darkest of places.",
    },
    {
      title: "Spirited Away",
      year: 2001,
      kind: "movie",
      tmdbId: 129,
      slug: "spirited-away",
      genres: ["Animation", "Fantasy", "Family"],
      tone: "Dreamlike and gentle",
      reason: "Pure imagination: a bathhouse full of spirits, a brave young heroine, and animation that still has no equal.",
      synopsis: "A young girl wanders into a spirit world and must work in a bathhouse to free her transformed parents.",
    },
    {
      title: "Parasite",
      year: 2019,
      kind: "movie",
      tmdbId: 496243,
      slug: "parasite",
      genres: ["Thriller", "Drama"],
      tone: "Sharp and unpredictable",
      reason: "A con-artist family scheme that twists from comedy into something far darker — impossible to predict, impossible to stop watching.",
      synopsis: "A poor family schemes its way into the employ of a wealthy household, with unexpected consequences.",
    },
    {
      title: "Breaking Bad",
      year: 2008,
      kind: "series",
      tmdbId: 1396,
      slug: "breaking-bad",
      genres: ["Crime", "Drama"],
      tone: "Gripping and intense",
      reason: "The definitive slow-burn transformation: a chemistry teacher's descent, told with total commitment across five seasons.",
      synopsis: "A chemistry teacher turned methamphetamine manufacturer navigates the criminal underworld.",
    },
    {
      title: "Paddington 2",
      year: 2017,
      kind: "movie",
      tmdbId: 346648,
      slug: "paddington-2",
      genres: ["Family", "Comedy"],
      tone: "Warm and funny",
      reason: "Kindness as a superpower — Hugh Grant at his hammiest, a marmalade-fuelled plot, and a genuinely good-hearted film.",
      synopsis: "Paddington tries to buy a birthday present for his aunt, but a thief frames him for a crime.",
    },
    {
      title: "The Grand Budapest Hotel",
      year: 2014,
      kind: "movie",
      tmdbId: 120467,
      slug: "grand-budapest",
      genres: ["Comedy", "Drama"],
      tone: "Witty and ornate",
      reason: "A caper wrapped in pastel symmetry — rapid-fire dialogue, a wonderful ensemble, and Wes Anderson at his most playful.",
      synopsis: "A legendary concierge and his trusted protégé become entangled in a battle over a priceless painting.",
    },
    {
      title: "Dark",
      year: 2017,
      kind: "series",
      tmdbId: 70523,
      slug: "dark",
      genres: ["Sci-Fi", "Mystery", "Drama"],
      tone: "Haunting and intricate",
      reason: "A time-travel puzzle that respects its audience: four families, three decades, and a knot that tightens with every episode.",
      synopsis: "The disappearance of two children exposes the secrets of four families in a small German town.",
    },
    {
      title: "Hot Fuzz",
      year: 2007,
      kind: "movie",
      tmdbId: 4638,
      slug: "hot-fuzz",
      genres: ["Comedy", "Action"],
      tone: "Fast and funny",
      reason: "A big-city cop in a sleepy village where nothing is quite right — quotable, kinetic, and endlessly rewatchable.",
      synopsis: "A London policeman is transferred to a quiet village where a series of accidents begins to look like murder.",
    },
  ],
  comedy: [
    {
      title: "Hot Fuzz",
      year: 2007,
      kind: "movie",
      tmdbId: 4638,
      slug: "hot-fuzz",
      genres: ["Comedy", "Action"],
      tone: "Fast and funny",
      reason: "A big-city cop in a sleepy village where nothing is quite right — quotable, kinetic, and endlessly rewatchable.",
      synopsis: "A London policeman is transferred to a quiet village where a series of accidents begins to look like murder.",
    },
    {
      title: "Paddington 2",
      year: 2017,
      kind: "movie",
      tmdbId: 346648,
      slug: "paddington-2",
      genres: ["Family", "Comedy"],
      tone: "Warm and funny",
      reason: "Kindness as a superpower — Hugh Grant at his hammiest, and a genuinely good-hearted film the whole room will enjoy.",
      synopsis: "Paddington tries to buy a birthday present for his aunt, but a thief frames him for a crime.",
    },
    {
      title: "What We Do in the Shadows",
      year: 2014,
      kind: "movie",
      tmdbId: 246741,
      slug: "shadows",
      genres: ["Comedy", "Horror"],
      tone: "Deadpan and silly",
      reason: "A mockumentary about vampire flatmates arguing over dishes — the jokes land because everyone plays it completely straight.",
      synopsis: "A documentary crew follows four vampire housemates navigating modern life in Wellington.",
    },
    {
      title: "The Grand Budapest Hotel",
      year: 2014,
      kind: "movie",
      tmdbId: 120467,
      slug: "grand-budapest",
      genres: ["Comedy", "Drama"],
      tone: "Witty and ornate",
      reason: "A caper wrapped in pastel symmetry — rapid-fire dialogue and Wes Anderson at his most playful.",
      synopsis: "A legendary concierge and his trusted protégé become entangled in a battle over a priceless painting.",
    },
    {
      title: "Brooklyn Nine-Nine",
      year: 2013,
      kind: "series",
      tmdbId: 48866,
      slug: "brooklyn-nine-nine",
      genres: ["Comedy"],
      tone: "Warm and quick",
      reason: "A precinct full of weirdos who genuinely like each other — 22-minute episodes that are easy to keep watching.",
      synopsis: "A talented but carefree detective and his colleagues solve cases in a Brooklyn precinct.",
    },
    {
      title: "Airplane!",
      year: 1980,
      kind: "movie",
      tmdbId: 813,
      slug: "airplane",
      genres: ["Comedy"],
      tone: "Relentlessly silly",
      reason: "A joke every few seconds, delivered with total sincerity — the template for every spoof since, and still the funniest.",
      synopsis: "A former pilot must land a plane when the crew succumbs to food poisoning.",
    },
  ],
  darkAnime: [
    {
      title: "Attack on Titan",
      year: 2013,
      kind: "series",
      tmdbId: 1429,
      slug: "attack-on-titan",
      genres: ["Animation", "Action", "Drama"],
      tone: "Dark and relentless",
      reason: "Humanity's last city against the Titans — brutal, political, and constantly reframing what you thought the story was.",
      synopsis: "Humanity fights for survival behind giant walls against the monstrous Titans.",
    },
    {
      title: "Death Note",
      year: 2006,
      kind: "series",
      tmdbId: 12971,
      slug: "death-note",
      genres: ["Animation", "Thriller", "Mystery"],
      tone: "Cold and cerebral",
      reason: "A notebook that kills anyone whose name is written in it — a cat-and-mouse duel of two geniuses that never lets up.",
      synopsis: "A student gains a notebook with the power to kill and begins a crusade against criminals.",
    },
    {
      title: "Perfect Blue",
      year: 1997,
      kind: "movie",
      tmdbId: 10494,
      slug: "perfect-blue",
      genres: ["Animation", "Thriller"],
      tone: "Unsettling and stylish",
      reason: "A pop idol's reality unravels in Satoshi Kon's psychological thriller — the film Black Swan openly owes a debt to.",
      synopsis: "A retired pop singer pursuing acting finds her sense of reality slipping away.",
    },
    {
      title: "Akira",
      year: 1988,
      kind: "movie",
      tmdbId: 149,
      slug: "akira",
      genres: ["Animation", "Sci-Fi", "Action"],
      tone: "Apocalyptic and electric",
      reason: "Neo-Tokyo, biker gangs and a psychic awakening — the landmark of anime cinema, animated frame by frame by hand.",
      synopsis: "A biker gang leader's friend develops terrifying psychic powers in post-apocalyptic Neo-Tokyo.",
    },
    {
      title: "Ghost in the Shell",
      year: 1995,
      kind: "movie",
      tmdbId: 1213,
      slug: "ghost-in-the-shell",
      genres: ["Animation", "Sci-Fi"],
      tone: "Philosophical and cool",
      reason: "A cybernetic major hunts a hacker while asking what makes a mind human — the film that shaped The Matrix.",
      synopsis: "A cyborg policewoman tracks a mysterious hacker known as the Puppet Master.",
    },
    {
      title: "Cyberpunk: Edgerunners",
      year: 2022,
      kind: "series",
      tmdbId: 97400,
      slug: "edgerunners",
      genres: ["Animation", "Sci-Fi", "Action"],
      tone: "Neon and heartbreaking",
      reason: "Ten episodes, no filler: a street kid augments his body to survive Night City, and the ending earns its reputation.",
      synopsis: "A street kid tries to survive in Night City by becoming an edgerunner, a mercenary outlaw.",
    },
  ],
  others: [
    {
      title: "The Thing",
      year: 1982,
      kind: "movie",
      tmdbId: 1091,
      slug: "the-thing",
      genres: ["Horror", "Sci-Fi"],
      tone: "Paranoid and icy",
      reason: "Twelve men in Antarctica, one shape-shifting creature, and no way to know who to trust — practical effects that still shock.",
      synopsis: "Researchers in Antarctica are hunted by a shape-shifting alien that imitates its victims.",
    },
    {
      title: "Fargo",
      year: 1996,
      kind: "movie",
      tmdbId: 275,
      slug: "fargo",
      genres: ["Crime", "Drama"],
      tone: "Deadpan and grim",
      reason: "A kidnapping gone wrong in the snow, told with the Coens' politest possible menace — and Frances McDormand is perfect.",
      synopsis: "A car salesman's plan to have his wife kidnapped unravels into murder in snowy Minnesota.",
    },
    {
      title: "Severance",
      year: 2022,
      kind: "series",
      tmdbId: 95396,
      slug: "severance",
      genres: ["Sci-Fi", "Mystery", "Drama"],
      tone: "Uncanny and precise",
      reason: "Office workers who surgically split their work and home selves — a premise that keeps getting stranger and more compelling.",
      synopsis: "Employees at Lumon Industries have their memories surgically divided between work and personal lives.",
    },
    {
      title: "Knives Out",
      year: 2019,
      kind: "movie",
      tmdbId: 546554,
      slug: "knives-out",
      genres: ["Mystery", "Comedy", "Crime"],
      tone: "Playful and twisty",
      reason: "A whodunit that tells you whodunit in the first act and stays gripping anyway — Daniel Craig's drawl does the rest.",
      synopsis: "A detective investigates the death of a patriarch of an eccentric, combative family.",
    },
    {
      title: "Chernobyl",
      year: 2019,
      kind: "series",
      tmdbId: 87108,
      slug: "chernobyl",
      genres: ["Drama", "History"],
      tone: "Grave and harrowing",
      reason: "Five episodes on the disaster and the cover-up — meticulous, devastating, and built on the human cost of lies.",
      synopsis: "The story of the 1986 nuclear disaster and the men and women who sacrificed everything to save Europe.",
    },
    {
      title: "Amélie",
      year: 2001,
      kind: "movie",
      tmdbId: 194,
      slug: "amelie",
      genres: ["Comedy", "Romance"],
      tone: "Whimsical and warm",
      reason: "A shy waitress quietly improves the lives of everyone around her — Paris, accordions, and pure charm.",
      synopsis: "A shy Parisian waitress decides to change the lives of those around her for the better.",
    },
  ],
}

function fixtureSetFor(query: string, hasTurns: boolean): FixtureTitle[] {
  const q = query.trim().toLowerCase()
  // A refinement asks for something different from the last set: the
  // "others" table is disjoint from the intent tables, so a follow-up
  // visibly returns new titles instead of repeating the first set.
  if (hasTurns) return FIXTURE_SETS.others
  if (/(funny|comedy|laugh|hilarious|light)/.test(q)) return FIXTURE_SETS.comedy
  if (/(anime|dark|scary|horror|gripping|intense)/.test(q)) return FIXTURE_SETS.darkAnime
  return FIXTURE_SETS.default
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim()
}

function findMatch(
  fixture: FixtureTitle,
  catalogue: DiscoverCandidate[] | undefined
): RecommendationMatch | null {
  if (!catalogue?.length) return null
  const wanted = normalizeTitle(fixture.title)
  for (const candidate of catalogue) {
    if (candidate.kind !== fixture.kind) continue
    if (normalizeTitle(candidate.title) !== wanted) continue
    if (candidate.year != null && candidate.year !== fixture.year) continue
    const key = `${candidate.kind}:${candidate.id}`
    return {
      compositeId: key,
      kind: fixture.kind,
      title: candidate.title,
      year: candidate.year ?? fixture.year,
      catalogueKey: key,
    }
  }
  return null
}

function fixturePosterUrl(slug: string): string {
  // FIXTURE poster URL: the render harness intercepts image.tmdb.org
  // and serves generated art keyed by slug. The real orchestrator
  // returns genuine TMDB artwork URLs from W2 verification.
  return `https://image.tmdb.org/t/p/w342/shim-${slug}.jpg`
}

function fixtureBackdropUrl(slug: string): string {
  return `https://image.tmdb.org/t/p/w780/shim-${slug}-backdrop.jpg`
}

/** Render/test scenario flag. Production UI never sets this. */
export const DISCOVERY_SHIM_SCENARIO_KEY = "rs-discovery-shim-scenario"

function readScenario(): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null
    return sessionStorage.getItem(DISCOVERY_SHIM_SCENARIO_KEY)
  } catch {
    return null
  }
}

function queryTypeOf(query: string): "natural-language" | "keyword" {
  const q = query.trim().toLowerCase()
  if (q.split(/\s+/).length > 3) return "natural-language"
  if (q.includes("?") || q.includes("something") || q.includes("in the mood")) {
    return "natural-language"
  }
  return "keyword"
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The discovery request was cancelled.", "AbortError")
  }
  const error = new Error("The discovery request was cancelled.")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Simulated cache (shim-only): identical repeat requests reuse the first
// result with a cached-ai receipt. Keyed on the query + conversation
// turns + availableOnly + count, so a refinement is never a cache hit
// for the original question.
// ---------------------------------------------------------------------------

const shimCache = new Map<string, DiscoveryResult>()

function cacheKeyFor(request: DiscoveryRequest): string {
  return JSON.stringify([
    request.query.trim(),
    request.conversation.turns,
    request.availableOnly,
    request.count ?? 8,
  ])
}

/** Test/render-only: clear the shim's simulated cache between cases. */
export function resetDiscoveryShimCache(): void {
  shimCache.clear()
}

// ---------------------------------------------------------------------------
// Frozen entry point.
// ---------------------------------------------------------------------------

export async function runAiDiscovery(
  request: DiscoveryRequest,
  deps: DiscoveryOrchestratorDeps = {}
): Promise<DiscoveryResult> {
  const query = request.query.trim()
  if (!query) {
    throw new TypeError("runAiDiscovery requires a non-empty query")
  }
  throwIfAborted(request.signal)

  // Test override: exact control, no cache, no scenarios, no delays.
  if (deps.handler) {
    return deps.handler(request)
  }

  const startedAt = performance.now()
  const key = cacheKeyFor(request)
  const cached = shimCache.get(key)
  if (cached) {
    const diagnostics: AiSearchDiagnostics = {
      ...cached.diagnostics,
      cacheHit: true,
      durationMs: 2,
    }
    const receipt: AiSearchReceipt = {
      ...cached.receipt,
      phase: "cached",
      engine: "cached-ai",
      model: undefined,
      answeredAt: null,
      durationMs: 2,
      cacheHit: true,
      diagnostics,
    }
    return { ...cached, receipt, diagnostics }
  }

  const scenario = readScenario()
  const onPhase = deps.onPhase
  onPhase?.("asking")
  await delay(140, request.signal)

  if (scenario === "unavailable") {
    const error = new Error("The AI provider could not be reached.")
    ;(error as Error & { providerError?: string }).providerError = "unavailable"
    throw error
  }

  onPhase?.("verifying")
  await delay(140, request.signal)
  onPhase?.("checking")
  await delay(100, request.signal)
  throwIfAborted(request.signal)

  const hasTurns = request.conversation.turns.length > 0
  const fixtures =
    scenario === "empty" ? [] : fixtureSetFor(query, hasTurns)
  const count = Math.max(1, Math.min(request.count ?? 8, 12))
  const unverified = scenario === "unavailable" ? false : scenario === "unverified"
  const noMatches = scenario === "no-matches"

  // Counts describe the generated set, before the count/availableOnly
  // slicing below; acceptedCount describes what is actually returned.
  let verifiedCount = 0
  let matchedCount = 0
  const generated: VerifiedRecommendation[] = fixtures.map((fixture) => {
    const verified = !unverified
    if (verified) verifiedCount++
    // Matching requires a verified identity: an unverified title can
    // never be claimed to be in the library, even if a catalogue row
    // shares its generated name.
    const match = noMatches || !verified ? null : findMatch(fixture, deps.catalogue)
    if (match) matchedCount++
    return {
      generated: fixture.title,
      verified,
      tmdbId: verified ? fixture.tmdbId : null,
      title: fixture.title,
      year: fixture.year,
      kind: fixture.kind,
      reason: fixture.reason,
      tone: fixture.tone,
      genres: [...fixture.genres],
      synopsis: fixture.synopsis,
      posterUrl: verified ? fixturePosterUrl(fixture.slug) : null,
      backdropUrl: verified ? fixtureBackdropUrl(fixture.slug) : null,
      match,
      ...(verified
        ? {}
        : { verificationNote: "TMDB could not verify this title — the details shown are unconfirmed." }),
    }
  })

  let results = generated.slice(0, count)
  if (request.availableOnly) {
    results = results.filter((rec) => rec.match != null)
  }

  const generatedTitles = results.map((rec) => rec.generated)
  const conversation: ConversationState = {
    turns: [
      ...request.conversation.turns,
      { query, generatedTitles },
    ],
  }
  // Keep the frozen context helper exercised: the real orchestrator
  // builds its prompt from this; the shim only needs the turns.
  void conversationContextFor(conversation)

  const durationMs = Math.max(1, Math.round(performance.now() - startedAt))
  const diagnostics: AiSearchDiagnostics = {
    queryType: queryTypeOf(query),
    intention: hasTurns
      ? `Refinement of “${request.conversation.turns[0]?.query ?? query}”`
      : undefined,
    catalogueSize: deps.catalogue?.length,
    acceptedCount: results.length,
    rejectedCount: 0,
    model: deps.model || undefined,
    cacheHit: false,
    durationMs,
    generatedCount: fixtures.length,
    verifiedCount,
    matchedCount,
    verificationFailures: fixtures.length - verifiedCount,
  }
  const receipt: AiSearchReceipt = {
    phase: results.length === 0 && fixtures.length === 0 ? "rejected" : "validated",
    engine: "ai",
    query,
    model: deps.model || undefined,
    answeredAt: Date.now(),
    durationMs,
    cacheHit: false,
    diagnostics,
  }
  const result: DiscoveryResult = { results, receipt, diagnostics, conversation }
  shimCache.set(key, result)
  return result
}
