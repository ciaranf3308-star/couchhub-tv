// RedSilk Home — Home rails data layer (W2, Home Production Pass;
// 0.10.0 W1: H01–H07).
//
// The data API the Home view (HomeView) consumes. Pure composition over the
// data loadDiscoverData already loads (DiscoverData) plus the followed
// episodes the Followed provider reports — no new data sources, no
// network, no paid AI request anywhere on this path. Routine browsing
// is ranked by the local engine (discover.ts rankCandidates) with a
// confidence adjustment through the shared C2 engine
// (recommendations.ts, which wraps rating-confidence.ts); the AI
// ranker seam is never touched per homepage load.
//
// 0.10.0 contracts (see couchhub-tv-010-contracts.md):
//   - C1 taxonomy: every item carries its classified ContentKind
//     (classifyTitle) and kindLabel — a crime documentary is a
//     documentary, never a crime drama (H03); rail titles name the
//     content type they hold (H01).
//   - C2 confidence: selection goes through confidenceScore /
//     isHeadlineEligible — a 10.0 with no votes never headlines (H02).
//     Reasons come from explain() only; explain() returning null means
//     a neutral label, never an invented taste claim (H05).
//   - H04: each rail declares a `variant` ("film" | "series" |
//     "documentary" | "followed" | "live" | "mixed"); the view renders
//     it as class `rs-rail--<variant>` (CSS owned by W5).
//   - H06: recommendation rails hide below RECO_RAIL_MIN_ITEMS items
//     rather than showing 2–3 posters in an ocean of space. Never
//     padded with irrelevant content.
//   - H07: Tonight's Picks reads real EPG programmes (slots resolved
//     from the loaded guide via epg-data.js / now-next.ts, interpreted
//     through couch-livetv-epg.ts helpers — programmeState,
//     epgTimeRangeLabel). No guide, no live cards; no times invented.
//
// Honesty rules, enforced in code:
//   - A rail is omitted entirely when it has nothing real to show —
//     never an empty shell, never padded with lookalikes.
//   - Continue Watching and Recently Added are factual rails: their
//     items are never labelled as AI-generated or personalised.
//   - Recently Added only ever shows titles with a real catalogue
//     `added` timestamp (DiscoverData.recentlyAdded). When there is
//     none, the rail hides — "recently added" is never claimed on
//     weak evidence.
//   - Short & Sweet only ever shows films whose runtime is actually
//     known (runtimeMinutes > 0). No runtime, no card.
//   - Tonight's Picks only includes live programmes when real EPG
//     data exists (DiscoverData.nowPlaying, or resolved EPG slots
//     with real start/stop times). No guide, no live cards.
//   - Only titles with a valid playback target (a detail/play href
//     resolving to real catalogue content) are returned. Trending
//     extras that match nothing in the catalogue are dropped.
//   - No hardcoded demo content. No invented titles.
//   - Not Interested suppresses a title from every personalised
//     section. Already Watched (including the explicit
//     already-watched feedback, which leaves no progress signal)
//     keeps a title out of recommendations. More Like This boosts
//     similar titles through the engine's seed mechanism.
//
// Dedupe rule: one candidate key appears in at most 2 rails, and
// never in adjacent rails — unless one of the two is Continue
// Watching or Continue Your Series (resumption is not a
// recommendation, so a series may sit in both). The "best of" rails
// (Trending, Hidden Gems, Tonight's Picks, Short & Sweet) also fill
// fresh-first: titles not yet placed anywhere lead, and titles
// already in one rail only fill gaps. That keeps each rail surfacing
// something new and stops the last rails (genre rails) starving on
// a small library, where the top titles would otherwise be consumed
// twice before the genre rails are even built.
//
// Caching: getCachedHomeRails() is synchronous and returns the last
// computed payload (module cache, then localStorage) so Home paints
// instantly. loadHomeRails() recomputes from fresh data; on any error
// it returns the cached payload rather than throwing valid content
// away.
//
// Progress rows and trending extras are optional: HomeView already
// loads them (preferences.getContinueWatching, loadTrending), and
// passing them in lets this module show real progress bars and real
// trending titles. Without them the rails still build from
// DiscoverData alone (progress unknown, trending derived from
// vote-backed popularity instead).

import {
  candidateDetailHref,
  candidateKey,
  rankCandidates,
  type DiscoverCandidate,
  type DiscoverData,
  type FollowedEpisode,
  type RankedCandidate,
} from "@/scripts/lib/discover.ts"
import { BAYESIAN_PRIOR_MEAN } from "./rating-confidence.ts"
import {
  classifyTitle,
  kindLabel,
  isDocumentaryKind,
  type ContentKind,
} from "./taxonomy.ts"
import {
  confidenceScore,
  isHeadlineEligible,
  explain,
  neutralLabel,
  trackExposure,
  type TasteSignals,
} from "./recommendations.ts"
import { tasteSignalsFromModel } from "./taste.ts"
import {
  programmeState,
  epgTimeRangeLabel,
} from "./couch-livetv-epg.ts"
import {
  ensureFollowedLoaded,
  followedProvider,
} from "@/scripts/lib/followed.ts"

// ---------------------------------------------------------------------------
// Contract (W3 builds against these — do not rename)
// ---------------------------------------------------------------------------

export type HomeRailKind =
  | "continue-watching"
  | "new-episodes"
  | "next-obsession"
  | "trending"
  | "hidden-gems"
  | "tonight"
  | "recently-added"
  | "continue-series"
  | "short"
  | "genre"

/**
 * H04 — visual variant of a rail. The data layer only decides WHICH
 * variant a rail is; the view passes it to W5's TvRail `variant`
 * prop, which renders the class `.rs-rail--variant-<variant>`
 * (CSS owned by W5 in couch.css — tasteful variation between film /
 * series / documentary / followed / live rails, no heavy panels, no
 * nested containers, burgundy identity kept). Variants:
 *   film — films only (incl. Short & Sweet, Recently Added)
 *   series — series only (Continue Your Series)
 *   documentary — documentaries only (any mix of doc films/series)
 *   followed — New Episodes, from Followed Series
 *   live — Tonight's Picks when it carries live programmes
 *   (no variant) — everything else: status rails and mixed
 *   collections are the neutral default; the view omits the prop.
 */
export type HomeRailVariant =
  | "film"
  | "series"
  | "documentary"
  | "followed"
  | "live"

/** One real EPG now/next slot for Tonight's Picks (H07). Every field
 * comes from the loaded programme guide — start/stop are ms epoch
 * from the guide itself, never invented, never guessed. */
export interface TonightEpgSlot {
  channelId: string | number
  channelName: string
  channelLogo?: string | null
  nowTitle: string
  nowStartMs: number
  nowStopMs: number
  nextTitle?: string | null
  nextStartMs?: number | null
  nextStopMs?: number | null
}

export interface HomeRailItem {
  key: string
  kind: "movie" | "series" | "live"
  id: string | number
  title: string
  year?: number
  posterUrl?: string
  backdropUrl?: string
  rating?: number
  voteCount?: number
  runtimeMinutes?: number
  progress?: number
  season?: number
  episode?: number
  episodeTitle?: string
  detectedAt?: string
  detailHref: string
  playHref?: string
  reason?: string
  isLive?: boolean
  nowTitle?: string
  nextTitle?: string
  /** Catalogue overview (the hero's description). */
  overview?: string
  /** H01 — C1 content kind: Movie / Series / Documentary Film /
   * Documentary Series / Live TV. Genres are attributes, never the
   * kind: a crime documentary classifies as a documentary. */
  contentKind?: ContentKind
  /** H01 — focused-card type line: kind label + runtime when known,
   * e.g. "Documentary Series", "Movie · 1h 58m". The view renders
   * this (or the reason) as the card subtitle; the meta line already
   * carries year + rating. Episode counts are not in the catalogue
   * candidate shape, so series cards show the kind label, and
   * episode-led cards name the episode (S2 E3 — Title) instead. */
  typeLine?: string
  /** H07 — real EPG timing for a live programme (ms epoch), present
   * only when the guide supplied it. Absent means "no time known",
   * never an invented time. */
  nowStartMs?: number
  nowStopMs?: number
  nextStartMs?: number
  nextStopMs?: number
  /** H07 — programme state from couch-livetv-epg: "now" for the
   * programme currently airing, "upcoming" for the next one. */
  programmeStatus?: "now" | "upcoming"
}

export interface HomeRail {
  id: string
  kind: HomeRailKind
  title: string
  description?: string
  items: HomeRailItem[]
  seeAllHref?: string
  /** H04 — visual variant; the view passes it to TvRail's `variant`
   * prop (`.rs-rail--variant-<variant>`). Absent = neutral default. */
  variant?: HomeRailVariant
  /** H06 — true when the rail is deliberately shown below the
   * recommendation floor (fewer than RECO_RAIL_MIN_ITEMS cards):
   * factual rails (Continue Watching, Recently Added, …) show from
   * 1 item rather than hiding. The view passes it to TvRail's
   * `sparse` prop (`.rs-rail--sparse`, count via data-rail-count). */
  sparse?: boolean
}

export interface HomeHero {
  item: HomeRailItem
  reason?: string
}

export interface HomePayload {
  hero: HomeHero | null
  rails: HomeRail[]
}

// The public functions getCachedHomeRails() and loadHomeRails(data,
// followed, extras?) are implemented below. `extras` is optional, so
// the two-argument call in the contract works as written.

// ---------------------------------------------------------------------------
// Tunables (documented in one place)
// ---------------------------------------------------------------------------

/** Max cards per rail. */
export const HOME_RAILS_LIMIT = 12
/** A title may appear in at most this many rails. */
export const HOME_MAX_RAILS_PER_TITLE = 2
/** Minimum Bayesian rating for the hero. */
export const HERO_MIN_BAYESIAN = 7.0
/** Minimum real votes for the hero (medium confidence tier). */
export const HERO_MIN_VOTES = 100
/** Minimum Bayesian rating for Hidden Gems. */
export const GEM_MIN_BAYESIAN = 7.5
/** Minimum real votes for Hidden Gems. */
export const GEM_MIN_VOTES = 100
/** Minimum Bayesian rating for Trending (fallback source). */
export const TRENDING_MIN_BAYESIAN = 7.0
/** Minimum real votes for Trending (fallback source). */
export const TRENDING_MIN_VOTES = 100
/** Minimum Bayesian rating for Short & Sweet. */
export const SHORT_MIN_BAYESIAN = 7.0
/** Minimum real votes for Short & Sweet. */
export const SHORT_MIN_VOTES = 100
/** "Short" means under two hours, on verified runtime only. */
export const SHORT_MAX_RUNTIME_MINUTES = 120
/** Minimum Bayesian rating for the Prestige Drama genre rail. */
export const PRESTIGE_DRAMA_MIN_BAYESIAN = 7.5
/** Minimum real votes for the Prestige Drama genre rail. */
export const PRESTIGE_DRAMA_MIN_VOTES = 100
/** A genre rail needs at least this many titles to be worth showing. */
export const GENRE_RAIL_MIN_ITEMS = 4
/** At most this many genre rails per launch — never all of them. */
export const GENRE_RAILS_MAX = 3
/** Tonight's Picks needs at least this many cards or it hides. */
export const TONIGHT_MIN_ITEMS = 4
/** H06 — minimum items for a recommendation/collection rail
 * (Next Obsession, Trending, Hidden Gems, Short & Sweet, Tonight's
 * Picks, genre rails). Below this a rail hides rather than showing
 * 2–3 posters in an ocean of space. Factual rails (Continue
 * Watching, Continue Your Series, New Episodes, Recently Added)
 * are status, not collections — they show from 1 item. Never pad
 * with irrelevant content to reach the floor. */
export const RECO_RAIL_MIN_ITEMS = 4
/** H07 — max live programmes in Tonight's Picks. */
export const TONIGHT_MAX_LIVE = 4
/** Recently shown hero keys remembered to avoid repetition. */
export const HERO_HISTORY_MAX = 10
/** Small bonus so a title with a real backdrop wins the hero over an equal one. */
const HERO_BACKDROP_BONUS = 2
/** Small bonus so an in-progress title wins the hero over an equal one. */
const HERO_CONTINUE_BONUS = 5

// ---------------------------------------------------------------------------
// Optional extras (everything here already exists in the app; nothing new)
// ---------------------------------------------------------------------------

/**
 * One row from preferences.getContinueWatching() — the shape the app
 * already returns (kind/position/duration/episode routing). Mirrors
 * couch-home's HomeProgressRow structurally so this module stays
 * independent of the 0.5.0 assembly layer.
 */
export interface HomeProgressInput {
  kind: "vod" | "episode" | "live"
  id: string | number
  position?: number
  duration?: number
  completed?: boolean
  updatedAt?: number
  seriesId?: string | number | null
  seriesName?: string | null
  season?: number | null
  episodeNum?: number | null
  episodeTitle?: string | null
}

/** One catalogue-matched trending title, e.g. from loadTrending(). */
export interface HomeTrendingInput {
  kind: "movie" | "series"
  id: string | number
  title: string
  year?: number
  rating?: number
  posterUrl?: string
}

export interface LoadHomeRailsExtras {
  /** Progress rows for real Continue Watching / Continue Your Series cards. */
  progressRows?: HomeProgressInput[]
  /** Trending titles already matched to the catalogue (unmatched ones are dropped). */
  trending?: HomeTrendingInput[]
  /** Injectable clock (tests); defaults to Date.now(). */
  nowMs?: number
  /** AbortSignal from the view: loadHomeRails throws AbortError when
   * it is already aborted, so a superseded load never paints. The
   * view also checks the signal after each of its own awaits. */
  signal?: AbortSignal
  /** H07 — pre-resolved real EPG slots for Tonight's Picks (tests /
   * future view wiring). When absent, loadHomeRails resolves them
   * best-effort from the already-loaded guide (browser only, no
   * extra fetch); when that fails too, Tonight's Picks falls back
   * to DiscoverData.nowPlaying titles with no times attached. */
  tonightEpg?: TonightEpgSlot[]
  /** H07 — playlist id for the best-effort EPG resolve; otherwise
   * read from the active playlist entry. */
  playlistId?: string
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cleanTitle(title: string | undefined | null): string {
  return (title || "").trim()
}

/** Sane year, or undefined when the catalogue year cannot be trusted. */
function cleanYear(year: number | undefined | null, nowMs: number): number | undefined {
  if (typeof year !== "number" || !Number.isFinite(year)) return undefined
  const currentYear = new Date(nowMs).getFullYear()
  if (year < 1900 || year > currentYear + 1) return undefined
  return year
}

function progressFraction(row: HomeProgressInput): number | undefined {
  if (!row.duration || row.duration <= 0) return undefined
  const fraction = (row.position || 0) / row.duration
  if (!Number.isFinite(fraction) || fraction <= 0) return undefined
  return Math.max(0, Math.min(1, fraction))
}

function withAutoplay(href: string): string {
  return href.includes("?") ? `${href}&autoplay=1` : `${href}?autoplay=1`
}

function candidateToItem(
  candidate: DiscoverCandidate,
  overrides: Partial<HomeRailItem> = {},
): HomeRailItem {
  const detailHref = candidateDetailHref(candidate)
  const contentKind = contentKindOf(candidate)
  return {
    key: candidateKey(candidate),
    kind: candidate.kind,
    id: candidate.id,
    title: candidate.title,
    year: candidate.year,
    posterUrl: candidate.posterUrl,
    // No true backdrop art exists in the catalogue pipeline (the
    // provider rows carry no `backdrop` field, and TMDb enrichment is
    // per-title on demand, never joined into candidates) — the poster
    // is the honest fallback, and the hero renders it full-bleed
    // under the burgundy scrim. Never a broken image.
    backdropUrl: candidate.backdropUrl ?? candidate.posterUrl,
    rating: candidate.rating,
    voteCount: candidate.voteCount,
    runtimeMinutes: candidate.runtimeMinutes,
    overview: candidate.overview,
    detailHref,
    playHref:
      candidate.kind === "live" ? detailHref : withAutoplay(detailHref),
    contentKind,
    typeLine: typeLineFor(candidate, contentKind),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// H01 / H03 / H04 — content types (C1 taxonomy) and rail presentation
// ---------------------------------------------------------------------------

/** C1 kind of a catalogue candidate. Genres are attributes: only a
 * documentary signal changes the kind (H03 — a crime documentary
 * classifies as a documentary, never as a crime drama). */
export function contentKindOf(candidate: DiscoverCandidate): ContentKind {
  return classifyTitle({
    type: candidate.kind,
    kind: candidate.kind,
    genres: candidate.genres,
    title: candidate.title,
  })
}

/** "1h 58m" / "88 min" from verified runtime minutes, else undefined. */
export function formatRuntime(minutes?: number): string | undefined {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return undefined
  }
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m} min`
}

/**
 * H01 — focused-card type line: the C1 kind label, plus the runtime
 * for films when it is actually known ("Movie · 1h 58m",
 * "Documentary Series"). Year and rating already live in the card
 * meta line; episode counts are not carried by catalogue
 * candidates, so series cards show the kind label and episode-led
 * cards name the episode instead (S2 E3 — Title).
 */
export function typeLineFor(
  candidate: DiscoverCandidate,
  kind: ContentKind = contentKindOf(candidate),
): string {
  const label = kindLabel(kind)
  const runtime =
    kind === "movie" || kind === "documentary-film"
      ? formatRuntime(candidate.runtimeMinutes)
      : undefined
  return runtime ? `${label} · ${runtime}` : label
}

/** Display plural of a C1 kind label, anchored to kindLabel itself
 * (C1: no invented kind strings): Movie → Films, Documentary Film →
 * Documentary Films, Series / Documentary Series / Live TV unchanged. */
export function kindPluralLabel(kind: ContentKind): string {
  const label = kindLabel(kind)
  if (label === "Movie") return "Films"
  if (label.endsWith("Film")) return `${label}s`
  return label
}

/** H01 — content-type suffix for a rail title, from the kinds its
 * items actually hold: "Films", "Series", "Films & Series",
 * "Documentary Series", "Live TV". Null when no item carries a kind.
 * A rail mixing documentaries with fiction collapses to the broad
 * types ("Films & Series") — spelling out every precise kind piles
 * up ("Documentary Series & Films & Series"). Documentary-ness
 * stays visible on the cards themselves (type line / neutral
 * reason), and an all-documentary rail keeps the precise labels. */
export function contentTypeSuffix(items: HomeRailItem[]): string | null {
  const kinds = [
    ...new Set(
      items
        .map((item) => item.contentKind)
        .filter((kind): kind is ContentKind => !!kind),
    ),
  ]
  if (!kinds.length) return null
  if (kinds.length === 1) return kindPluralLabel(kinds[0] as ContentKind)
  const docKinds = kinds.filter((kind) => isDocumentaryKind(kind))
  const plainKinds = kinds.filter((kind) => !isDocumentaryKind(kind))
  if (docKinds.length && plainKinds.length) {
    const broad: string[] = []
    if (kinds.some((kind) => kind === "movie" || kind === "documentary-film")) {
      broad.push("Films")
    }
    if (kinds.some((kind) => kind === "series" || kind === "documentary-series")) {
      broad.push("Series")
    }
    if (kinds.includes("live")) broad.push("Live TV")
    return broad.join(" & ")
  }
  if (
    kinds.length === 2 &&
    kinds.includes("movie") &&
    kinds.includes("series")
  ) {
    return "Films & Series"
  }
  return kinds.map((kind) => kindPluralLabel(kind)).join(" & ")
}

/** H04 — which visual variant a rail is, from its kind + content.
 * The view passes the result to TvRail's `variant` prop
 * (`.rs-rail--variant-<variant>`). Mixed / status rails return
 * undefined: the neutral default, prop omitted. */
export function variantForRail(
  railKind: HomeRailKind,
  items: HomeRailItem[],
): HomeRailVariant | undefined {
  if (railKind === "new-episodes") return "followed"
  if (railKind === "tonight" && items.some((item) => item.isLive)) return "live"
  const kinds = [
    ...new Set(
      items
        .map((item) => item.contentKind)
        .filter((kind): kind is ContentKind => !!kind),
    ),
  ]
  if (kinds.length && kinds.every((kind) => isDocumentaryKind(kind))) {
    return "documentary"
  }
  if (kinds.length === 1) {
    const only = kinds[0] as ContentKind
    if (only === "movie") return "film"
    if (only === "series") return "series"
    if (only === "live") return "live"
  }
  return undefined
}

/**
 * H05 — the reason shown for a personalised pick: W4's explain()
 * when it returns a real signal-backed string, else the neutral
 * label ("Featured True Crime Series"). A "Matches your taste…"
 * claim is never shown without a real signal behind it. The
 * candidate's own kind (movie/series) is what explain() keys on —
 * taste refs are keyed that way — while the neutral label uses the
 * classified C1 kind, so a crime documentary is neutrally a
 * "Documentary Series", never a "Crime Series".
 */
export function personalisedReason(
  signals: TasteSignals,
  candidate: DiscoverCandidate,
): string {
  const explained = explain(candidate, signals)
  if (explained) return explained
  return neutralLabel({ ...candidate, kind: contentKindOf(candidate) })
}

// ---------------------------------------------------------------------------
// H07 — real EPG slots for Tonight's Picks
// ---------------------------------------------------------------------------

/**
 * Resolve real now/next EPG slots for Tonight's Picks.
 *
 * Order: injected `extras.tonightEpg` first (tests / view wiring);
 * otherwise best-effort from the guide loadDiscoverData already
 * warmed — the in-memory programme map (epg-data.js) + the cached
 * live channels (live-catalog.ts) + the now/next resolver
 * (now-next.ts). couch-livetv-epg.ts itself holds no programme
 * data; its helpers (programmeState, epgTimeRangeLabel) interpret
 * the records once resolved.
 *
 * Never fetches here: if the guide map is empty the resolve returns
 * null and Tonight's Picks falls back to DiscoverData.nowPlaying
 * titles (no times attached, never invented). Never throws, never
 * blocks on abort (the caller re-checks the signal). Node/SSR
 * returns null immediately — there is no live guide there.
 */
export async function resolveTonightEpg(
  extras: LoadHomeRailsExtras,
  nowMs: number,
): Promise<TonightEpgSlot[] | null> {
  if (extras.tonightEpg) return extras.tonightEpg
  if (typeof window === "undefined") return null
  try {
    const playlistId =
      extras.playlistId ??
      (await import("@/scripts/lib/creds.js")
        .then((mod) => mod.getActiveEntry())
        .then((entry) => entry?._id ?? null)
        .catch(() => null))
    if (!playlistId) return null
    const epg = await import("@/scripts/lib/epg-data.js")
    const programmes = epg.getProgrammesSync(playlistId)?.programmes ?? null
    if (!programmes?.size) return null
    const liveCatalog = await import("@/scripts/lib/live-catalog.ts")
    const nowNext = await import("@/scripts/lib/now-next.ts")
    const channels = liveCatalog.readCachedLiveChannels(playlistId) as Array<{
      id: number | string
      name?: string
      logo?: string | null
      stream_icon?: string | null
    }>
    const slots: TonightEpgSlot[] = []
    for (const channel of channels.slice(0, 60)) {
      const slot = nowNext.computeNowNext(programmes, channel, playlistId, nowMs)
      if (!slot.current) continue
      slots.push({
        channelId: channel.id,
        channelName: String(channel.name || ""),
        channelLogo: channel.logo ?? channel.stream_icon ?? null,
        nowTitle: slot.current.title,
        nowStartMs: slot.current.start,
        nowStopMs: slot.current.stop,
        nextTitle: slot.next?.title ?? null,
        nextStartMs: slot.next?.start ?? null,
        nextStopMs: slot.next?.stop ?? null,
      })
      if (slots.length >= TONIGHT_MAX_LIVE) break
    }
    return slots
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Vote-count decision (integration, 0.6.0) — tiered eligibility.
//
// EVIDENCE (read 2026-11-10, integration):
//   - Candidates get their rating from the Xtream provider row
//     (`catalog-mappers.js`: rating = m.rating || m.rating_5based ||
//     m.vote_average — a TMDb-style average the provider supplies).
//     The mapped rows carry NO vote_count field, so
//     `catalogRowToCandidate`'s voteCount is undefined in practice:
//     nothing in the codebase ever writes vote_count onto a
//     vod/series row.
//   - TMDb enrichment (`tmdb-enrich.ts`) is per-title and on demand
//     (detail pages only), cached 30 days — and its
//     `TmdbTitleEnrichment` drops vote_count entirely (only
//     voteAverage survives; `TmdbBundle` does not even declare
//     vote_count). There is no bulk join of TMDb data into
//     candidates, and building one would mean per-title network
//     calls at Home load or a bulk scan of on-demand caches that
//     only cover titles the user has already opened. FIRST CHOICE
//     (plumb real vote counts through the rating path) is therefore
//     NOT cheaply possible — rejected, not deferred silently.
//   - SECOND CHOICE (implemented here): tiered eligibility. The
//     mapped rows DO carry the TMDb id the provider itself attached
//     (`tmdb`, see discover.ts `tmdbId`). A title carrying one is
//     TMDb-matched by definition, and its provider rating IS TMDb's
//     vote_average surfaced through the provider — vote-backed in
//     substance, just with the count unsurfaced. So:
//       Tier 1 — real vote count (>= minVotes): Bayesian rating, as
//         before. Vote-backed titles always win when any qualify.
//       Tier 2 — TMDb-matched (tmdbId present) with a real rating:
//         the raw provider rating stands in for the Bayesian one.
//         Used ONLY when no Tier 1 title qualifies for that
//         selection, so the gates never soften while real counts
//         exist — and a no-vote 10.0 with no TMDb match still scores
//         the prior mean (6.5) and never qualifies.
//     No vote counts are fabricated anywhere: Tier 2 never claims a
//     count, it only treats a TMDb-matched rating as evidence the
//     provider's TMDb link already asserts.
// ---------------------------------------------------------------------------

/** True when the provider itself linked this title to a TMDb id. */
function isTmdbMatched(candidate: DiscoverCandidate): boolean {
  return typeof candidate.tmdbId === "number" && candidate.tmdbId > 0
}

/** Raw provider rating, or undefined when the catalogue has none. */
function rawRating(candidate: DiscoverCandidate): number | undefined {
  const rating = candidate.rating
  if (typeof rating !== "number" || !Number.isFinite(rating) || rating <= 0) {
    return undefined
  }
  return Math.min(rating, 10)
}

/**
 * Quality score for ranking: Bayesian when real votes exist, the raw
 * TMDb-backed rating when the title is TMDb-matched, the prior mean
 * otherwise ("average until proven otherwise"). The vote-backed leg
 * is C2's confidenceScore (recommendations.ts, wrapping
 * rating-confidence.ts) — this module never forks its own Bayesian
 * math. A null/unknown rating scores -Infinity through C2 and can
 * never headline.
 */
function tieredQuality(candidate: DiscoverCandidate): number {
  if (typeof candidate.voteCount === "number" && candidate.voteCount >= 1) {
    return confidenceScore(candidate.rating ?? null, candidate.voteCount)
  }
  if (isTmdbMatched(candidate)) {
    return rawRating(candidate) ?? BAYESIAN_PRIOR_MEAN
  }
  return BAYESIAN_PRIOR_MEAN
}

/**
 * Quality support for a gate: real votes at the floor (C2
 * isHeadlineEligible), OR a TMDb match with a real rating (Tier 2 —
 * see the decision note above).
 */
function hasTieredSupport(
  candidate: DiscoverCandidate,
  minVotes: number,
): boolean {
  if (isHeadlineEligible(candidate, minVotes)) return true
  return isTmdbMatched(candidate) && rawRating(candidate) !== undefined
}

/**
 * The quality-gated pool for one selection: Tier 1 (vote-backed,
 * Bayesian via C2) when any title qualifies, else Tier 2
 * (TMDb-matched, raw rating). Never both mixed, never softened
 * while real counts exist — and never an unmatched no-vote title.
 */
function qualityPool(
  candidates: DiscoverCandidate[],
  minBayesian: number,
  minVotes: number,
): DiscoverCandidate[] {
  const backed = candidates.filter(
    (c) =>
      isHeadlineEligible(c, minVotes) &&
      confidenceScore(c.rating ?? null, c.voteCount ?? null) >= minBayesian,
  )
  if (backed.length) return backed
  return candidates.filter(
    (c) =>
      isTmdbMatched(c) &&
      (rawRating(c) ?? BAYESIAN_PRIOR_MEAN) >= minBayesian,
  )
}

/**
 * Parse the "Now: X · Next: Y" overview liveChannelToCandidate builds
 * (discover.ts) back into its parts. Returns empty when the overview
 * is not in that shape — the caller falls back to the raw overview.
 */
function parseNowNext(overview: string | undefined): {
  nowTitle?: string
  nextTitle?: string
} {
  if (!overview) return {}
  const withNext = /^Now: (.+?) · Next: (.+)$/.exec(overview)
  if (withNext) {
    return { nowTitle: withNext[1]?.trim(), nextTitle: withNext[2]?.trim() }
  }
  const nowOnly = /^Now: (.+)$/.exec(overview)
  if (nowOnly) return { nowTitle: nowOnly[1]?.trim() }
  return {}
}

/** Detail URL for a followed episode (autoplay: a new episode is Watch Now). */
export function newEpisodeHref(episode: FollowedEpisode): string {
  const params = new URLSearchParams({ id: String(episode.seriesId) })
  params.set("season", String(episode.season))
  params.set("epnum", String(episode.episode))
  params.set("autoplay", "1")
  return `/series/detail?${params.toString()}`
}

/**
 * Confidence-adjusted rank score: rankCandidates' rating term is the
 * raw catalogue rating, so a no-vote 10.0 would outscore a
 * well-supported 8.0 on rating alone. Swap the raw term for the
 * Bayesian term — the rest of the score (taste, seeds, mood, recency)
 * is untouched, so personalisation still decides between titles of
 * equal proven quality.
 */
function confidenceAdjustedScore(item: RankedCandidate): number {
  const raw = item.candidate.rating
  const rawPoints =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? Math.min(10, raw)
      : 0
  const bayesianPoints = tieredQuality(item.candidate)
  return item.score - rawPoints + bayesianPoints
}

/**
 * H02 — the ranking comparator for the taste-ranked rails (Next
 * Obsession, genre rails, Tonight's Picks fillers). Titles WITH any
 * quality evidence (real votes, or a TMDb match — the same Tier 1 /
 * Tier 2 support the gates use) always sort before titles with none:
 * a no-vote 10.0 can never outrank a proven title, however recent
 * it is — the raw score's recency term used to let exactly that
 * happen (a 2024 no-vote 10.0 outscoring a 2023 vote-backed 8.5).
 * Within each group the confidence-adjusted score decides, so taste
 * still orders proven titles. When NOTHING in the library has any
 * evidence, the order falls back to the adjusted score alone — the
 * hero and the quality-gated rails still exclude unproven titles
 * entirely, so an unproven title can only lead a ranked rail when
 * the library holds no proven title at all.
 */
function hasAnyEvidence(candidate: DiscoverCandidate): boolean {
  return hasTieredSupport(candidate, 1)
}

function byAdjustedScore(a: RankedCandidate, b: RankedCandidate): number {
  const supportDiff =
    Number(hasAnyEvidence(b.candidate)) - Number(hasAnyEvidence(a.candidate))
  if (supportDiff !== 0) return supportDiff
  const scoreDiff = confidenceAdjustedScore(b) - confidenceAdjustedScore(a)
  if (scoreDiff !== 0) return scoreDiff
  const bayesDiff =
    tieredQuality(b.candidate) - tieredQuality(a.candidate)
  if (bayesDiff !== 0) return bayesDiff
  return a.candidate.title.localeCompare(b.candidate.title)
}

// ---------------------------------------------------------------------------
// Dedupe tracker (the at-most-2-rails / never-adjacent rule)
// ---------------------------------------------------------------------------

const ADJACENCY_EXEMPT_RAILS = new Set(["continue-watching", "continue-series"])

class PlacementTracker {
  private counts = new Map<string, number>()
  private lastRailIndex = new Map<string, number>()
  private lastRailId = new Map<string, string>()

  canPlace(key: string, railIndex: number, railId: string): boolean {
    if ((this.counts.get(key) || 0) >= HOME_MAX_RAILS_PER_TITLE) return false
    const last = this.lastRailIndex.get(key)
    // Already in this rail: a title never appears twice in one row
    // (this also makes fresh-first two-pass loops safe).
    if (last !== undefined && last === railIndex) return false
    if (last !== undefined && last === railIndex - 1) {
      // Adjacent rails — allowed only when resumption is involved
      // (this rail or the previous one is Continue Watching /
      // Continue Your Series).
      if (ADJACENCY_EXEMPT_RAILS.has(railId)) return true
      const prevId = this.lastRailId.get(key)
      if (prevId && ADJACENCY_EXEMPT_RAILS.has(prevId)) return true
      return false
    }
    return true
  }

  place(key: string, railIndex: number, railId: string): void {
    this.counts.set(key, (this.counts.get(key) || 0) + 1)
    this.lastRailIndex.set(key, railIndex)
    this.lastRailId.set(key, railId)
  }

  count(key: string): number {
    return this.counts.get(key) || 0
  }
}

// ---------------------------------------------------------------------------
// Cache (module + localStorage) + hero history
// ---------------------------------------------------------------------------

const PAYLOAD_STORAGE_KEY = "nylah_home_rails_v1"
const HERO_HISTORY_STORAGE_KEY = "nylah_home_hero_history_v1"

let moduleCache: HomePayload | null = null
let heroHistory: string[] = []

function storageAvailable(): boolean {
  return typeof localStorage !== "undefined"
}

function readStoredPayload(): HomePayload | null {
  if (!storageAvailable()) return null
  try {
    const raw = localStorage.getItem(PAYLOAD_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HomePayload>
    if (!parsed || !Array.isArray(parsed.rails)) return null
    return {
      hero: parsed.hero ?? null,
      rails: parsed.rails,
    }
  } catch {
    return null
  }
}

function writeStoredPayload(payload: HomePayload): void {
  if (!storageAvailable()) return
  try {
    localStorage.setItem(PAYLOAD_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Storage full / unavailable: the module cache still serves.
  }
}

function readStoredHeroHistory(): string[] {
  if (!storageAvailable()) return []
  try {
    const raw = localStorage.getItem(HERO_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((k): k is string => typeof k === "string")
  } catch {
    return []
  }
}

function writeStoredHeroHistory(): void {
  if (!storageAvailable()) return
  try {
    localStorage.setItem(
      HERO_HISTORY_STORAGE_KEY,
      JSON.stringify(heroHistory.slice(0, HERO_HISTORY_MAX)),
    )
  } catch {
    // History is a nicety; losing it never breaks the hero.
  }
}

function currentHeroHistory(): string[] {
  if (!heroHistory.length) {
    const stored = readStoredHeroHistory()
    if (stored.length) heroHistory = stored
  }
  return heroHistory
}

function recordHeroShown(key: string): void {
  heroHistory = [key, ...heroHistory.filter((k) => k !== key)].slice(
    0,
    HERO_HISTORY_MAX,
  )
  writeStoredHeroHistory()
}

/** Test helper (also useful on profile switch): clear every cache. */
export function clearHomeRailsCache(): void {
  moduleCache = null
  heroHistory = []
  if (!storageAvailable()) return
  try {
    localStorage.removeItem(PAYLOAD_STORAGE_KEY)
    localStorage.removeItem(HERO_HISTORY_STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

export function getCachedHomeRails(): HomePayload | null {
  if (moduleCache) return moduleCache
  const stored = readStoredPayload()
  if (stored) moduleCache = stored
  return moduleCache
}

// ---------------------------------------------------------------------------
// Build context
// ---------------------------------------------------------------------------

interface BuildContext {
  data: DiscoverData
  followed: FollowedEpisode[]
  extras: LoadHomeRailsExtras
  nowMs: number
  byKey: Map<string, DiscoverCandidate>
  /** Keys excluded from every recommendation rail. */
  recommendationExcluded: Set<string>
  notInterested: Set<string>
  continueWatchingKeys: Set<string>
  placements: PlacementTracker
  ranked: RankedCandidate[]
  /** H05 — the C2 signals explain() may cite (from the taste model). */
  signals: TasteSignals
  /** H07 — resolved real EPG slots for Tonight's Picks, or null. */
  tonightEpg: TonightEpgSlot[] | null
}

function buildContext(
  data: DiscoverData,
  followed: FollowedEpisode[],
  extras: LoadHomeRailsExtras,
  tonightEpg: TonightEpgSlot[] | null = null,
): BuildContext {
  const nowMs = extras.nowMs ?? Date.now()
  const byKey = new Map(
    data.candidates.map((c) => [candidateKey(c), c] as const),
  )
  const taste = data.taste
  const notInterested = new Set(taste.notInterestedKeys || [])

  // Already Watched prevents repeated recommendations. The explicit
  // already-watched feedback leaves no progress signal, so it never
  // lands in watchedKeys — but it does land in likedTitles (weight
  // 0.6, see taste.ts). Excluding every liked title closes that gap:
  // finished, favourited, liked and already-watched titles alike
  // stay out of the recommendation rails.
  const recommendationExcluded = new Set<string>([
    ...data.watchedKeys,
    ...notInterested,
  ])
  for (const ref of taste.likedTitles || []) {
    recommendationExcluded.add(`${ref.kind}:${ref.id}`)
  }
  for (const ref of taste.dislikedTitles || []) {
    if (ref.weight >= 1) recommendationExcluded.add(`${ref.kind}:${ref.id}`)
  }

  const continueWatchingKeys = new Set(
    data.continueWatching.map((c) => candidateKey(c)),
  )

  // More Like This boosts relevant ranking: the engine's seed
  // mechanism (+genre/+cast/+director) is fed from the titles the
  // user explicitly picked as "more like this".
  const seedTitles: Array<{
    title: string
    genres: string[]
    cast: string[]
    director?: string | null
  }> = []
  const selected = taste.selectedRecommendations || {}
  for (const key of Object.keys(selected)) {
    const candidate = byKey.get(key)
    if (!candidate || !cleanTitle(candidate.title)) continue
    seedTitles.push({
      title: candidate.title,
      genres: candidate.genres,
      cast: candidate.cast,
      director: candidate.director ?? null,
    })
    if (seedTitles.length >= 5) break
  }

  // One ranked pass, reused by Next Obsession, Tonight's Picks, hero
  // and the genre rails — a single local-engine ranking per load,
  // never one AI call per rail. The limit must cover every rail that
  // consumes the ranking (Next Obsession + Tonight's Picks + up to
  // three genre rails), or the later rails starve on a small library.
  const ranked = rankCandidates(data.candidates, taste, {
    excludeKeys: notInterested,
    watchedKeys: data.watchedKeys,
    excludeWatched: true,
    seedTitles,
    limit: HOME_RAILS_LIMIT * 4,
    perGroupCap: 1,
    nowMs,
  }).sort(byAdjustedScore)

  return {
    data,
    followed,
    extras,
    nowMs,
    byKey,
    recommendationExcluded,
    notInterested,
    continueWatchingKeys,
    placements: new PlacementTracker(),
    ranked,
    // H05 — C2 signals, projected from the taste model. The first
    // More Like This seed is the because-watched seed explain() may
    // cite ("Because you watched X") — it is a title the household
    // explicitly picked, so the citation is real.
    signals: tasteSignalsFromModel(
      taste,
      seedTitles.length
        ? { title: seedTitles[0].title, genres: seedTitles[0].genres }
        : null,
    ),
    tonightEpg,
  }
}

// ---------------------------------------------------------------------------
// Rail builders (each returns null when it has nothing real to show)
// ---------------------------------------------------------------------------

function buildContinueWatching(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  const seen = new Set<string>()
  const rows = ctx.extras.progressRows
  if (rows) {
    // Progress rows carry the real resume state. Live-channel history
    // is dropped by rule — tuning back to a channel is not resuming
    // a film or an episode — as are completed rows and rows with no
    // real progress.
    for (const row of rows) {
      if (row.kind !== "vod" && row.kind !== "episode") continue
      if (row.completed || (row.position ?? 0) <= 0) continue
      const progress = progressFraction(row)
      if (row.kind === "vod") {
        const candidate = ctx.byKey.get(`movie:${row.id}`)
        if (!candidate || !cleanTitle(candidate.title)) continue
        const key = candidateKey(candidate)
        if (seen.has(key)) continue
        seen.add(key)
        if (!ctx.placements.canPlace(key, railIndex, "continue-watching")) continue
        ctx.placements.place(key, railIndex, "continue-watching")
        items.push(
          candidateToItem(candidate, {
            progress,
            // H01 — the rail title already says "Continue Watching"
            // and the progress bar shows the resume state; the
            // subtitle names the content type + runtime instead of
            // repeating the rail title ("Movie · 2h 30m").
            reason: typeLineFor(candidate),
          }),
        )
        continue
      }
      if (row.seriesId == null) continue
      const candidate = ctx.byKey.get(`series:${row.seriesId}`)
      if (!candidate || !cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (!ctx.placements.canPlace(key, railIndex, "continue-watching")) continue
      ctx.placements.place(key, railIndex, "continue-watching")
      const detailHref = candidateDetailHref(candidate)
      items.push(
        candidateToItem(candidate, {
          progress,
          season: row.season ?? undefined,
          episode: row.episodeNum ?? undefined,
          episodeTitle: row.episodeTitle ?? undefined,
          detailHref,
          playHref: `${detailHref}&autoplay=1&episode=${encodeURIComponent(row.id)}`,
          reason: "Continue watching",
        }),
      )
    }
  } else {
    // No progress rows supplied: fall back to the genuinely unfinished
    // candidates loadDiscoverData already derived from the progress
    // store (progress itself unknown here — no bar, no invented %).
    for (const candidate of ctx.data.continueWatching) {
      if (!cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (!ctx.placements.canPlace(key, railIndex, "continue-watching")) continue
      ctx.placements.place(key, railIndex, "continue-watching")
      items.push(candidateToItem(candidate, { reason: typeLineFor(candidate) }))
    }
  }
  if (!items.length) return null
  const finalItems = items.slice(0, HOME_RAILS_LIMIT)
  const suffix = contentTypeSuffix(finalItems)
  return {
    id: "continue-watching",
    kind: "continue-watching",
    title: suffix ? `Continue Watching — ${suffix}` : "Continue Watching",
    items: finalItems,
    variant: variantForRail("continue-watching", finalItems),
  }
}

function buildNewEpisodes(ctx: BuildContext, railIndex: number): HomeRail | null {
  const episodes = [...ctx.followed]
    .filter((ep) => !ep.watched && cleanTitle(ep.seriesTitle))
    .sort((a, b) => {
      const at = Date.parse(a.detectedAt || "") || 0
      const bt = Date.parse(b.detectedAt || "") || 0
      if (bt !== at) return bt - at
      return a.seriesTitle.localeCompare(b.seriesTitle)
    })
  const items: HomeRailItem[] = []
  const seen = new Set<string>()
  for (const ep of episodes) {
    const key = `followed:${ep.seriesId}:S${ep.season}E${ep.episode}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!ctx.placements.canPlace(key, railIndex, "new-episodes")) continue
    ctx.placements.place(key, railIndex, "new-episodes")
    const href = newEpisodeHref(ep)
    items.push({
      key,
      kind: "series",
      id: String(ep.seriesId),
      title: ep.seriesTitle,
      posterUrl: ep.posterUrl,
      season: ep.season,
      episode: ep.episode,
      episodeTitle: ep.episodeTitle,
      detectedAt: ep.detectedAt,
      detailHref: href,
      playHref: href,
      reason: `New: S${ep.season} E${ep.episode}${ep.episodeTitle ? ` — ${ep.episodeTitle}` : ""}`,
      contentKind: "series",
      typeLine: "Series",
    })
  }
  if (!items.length) return null
  const finalItems = items.slice(0, HOME_RAILS_LIMIT)
  return {
    id: "new-episodes",
    kind: "new-episodes",
    title: "New Episodes — Series",
    description: "From the series you follow",
    items: finalItems,
    seeAllHref: "/followed",
    variant: "followed",
  }
}

function buildNextObsession(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  for (const ranked of ctx.ranked) {
    const candidate = ranked.candidate
    if (!cleanTitle(candidate.title)) continue
    const key = candidateKey(candidate)
    if (ctx.recommendationExcluded.has(key)) continue
    if (!ctx.placements.canPlace(key, railIndex, "next-obsession")) continue
    ctx.placements.place(key, railIndex, "next-obsession")
    items.push(
      candidateToItem(candidate, {
        // H05 — explain() when it has a real signal, else the neutral
        // label. The engine's own reason ("Matches your taste…") is
        // never shown on a weaker claim than explain() allows.
        reason: personalisedReason(ctx.signals, candidate),
      }),
    )
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  // H06 — a 2–3 poster personalised rail is oceans of space; hide it
  // rather than padding it with irrelevant titles.
  if (items.length < RECO_RAIL_MIN_ITEMS) return null
  const hasHistory = ctx.data.hasHistory
  const suffix = contentTypeSuffix(items)
  return {
    id: "next-obsession",
    kind: "next-obsession",
    title: suffix ? `Your Next Obsession — ${suffix}` : "Your Next Obsession",
    description: hasHistory
      ? "Based on what you've watched and loved"
      : "Highly rated in your library",
    items,
    seeAllHref: "/discover",
    variant: variantForRail("next-obsession", items),
  }
}

function buildTrending(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  const extras = ctx.extras.trending
  if (extras?.length) {
    // Real trending source (Google/TMDB, already matched to the
    // library by loadTrending). Catalogue availability is re-checked
    // here: an item with no candidate is dropped, never shown dead.
    // "Well-regarded" needs evidence — an unrated trending match is
    // dropped rather than presented as worth watching.
    const ranked = [...extras]
      .map((item) => ({ item, candidate: ctx.byKey.get(`${item.kind}:${item.id}`) }))
      .filter(
        (entry): entry is { item: HomeTrendingInput; candidate: DiscoverCandidate } =>
          !!entry.candidate && cleanTitle(entry.candidate.title) !== "",
      )
      .filter((entry) => !ctx.recommendationExcluded.has(candidateKey(entry.candidate)))
      .filter((entry) => {
        // H02 — "well-regarded" needs confidence-aware evidence,
        // not the feed's raw rating: a no-vote 10.0 from the
        // trending feed scores the prior mean and never leads.
        return tieredQuality(entry.candidate) >= TRENDING_MIN_BAYESIAN
      })
      .sort((a, b) => {
        const qualityDiff =
          tieredQuality(b.candidate) - tieredQuality(a.candidate)
        if (qualityDiff !== 0) return qualityDiff
        const votesDiff = (b.candidate.voteCount ?? 0) - (a.candidate.voteCount ?? 0)
        if (votesDiff !== 0) return votesDiff
        return a.candidate.title.localeCompare(b.candidate.title)
      })
    for (const pass of [0, 1]) {
      for (const { item, candidate } of ranked) {
        if (items.length >= HOME_RAILS_LIMIT) break
        const key = candidateKey(candidate)
        if (pass === 0 && ctx.placements.count(key) > 0) continue
        if (!ctx.placements.canPlace(key, railIndex, "trending")) continue
        ctx.placements.place(key, railIndex, "trending")
        items.push(
          candidateToItem(candidate, {
            rating: item.rating ?? candidate.rating,
            reason: "Trending now",
          }),
        )
      }
      if (items.length >= HOME_RAILS_LIMIT) break
    }
  } else {
    // No trending feed supplied: popularity = real vote volume, and
    // "well-regarded" = confidence-aware quality. Provider catalogue
    // order is never the ranking — the most-voted, best-regarded
    // titles lead. Finished, already-watched and dismissed titles
    // stay out: Trending is a personalised Home surface, not history.
    const pool = qualityPool(
      ctx.data.candidates
        .filter((c) => (c.kind === "movie" || c.kind === "series"))
        .filter((c) => cleanTitle(c.title))
        .filter((c) => !ctx.recommendationExcluded.has(candidateKey(c))),
      TRENDING_MIN_BAYESIAN,
      TRENDING_MIN_VOTES,
    ).sort((a, b) => {
      const votesDiff = (b.voteCount ?? 0) - (a.voteCount ?? 0)
      if (votesDiff !== 0) return votesDiff
      const bayesDiff = tieredQuality(b) - tieredQuality(a)
      if (bayesDiff !== 0) return bayesDiff
      return a.title.localeCompare(b.title)
    })
    for (const pass of [0, 1]) {
      for (const candidate of pool) {
        if (items.length >= HOME_RAILS_LIMIT) break
        const key = candidateKey(candidate)
        if (pass === 0 && ctx.placements.count(key) > 0) continue
        if (!ctx.placements.canPlace(key, railIndex, "trending")) continue
        ctx.placements.place(key, railIndex, "trending")
        items.push(
          candidateToItem(candidate, { reason: "Popular and well-regarded" }),
        )
      }
      if (items.length >= HOME_RAILS_LIMIT) break
    }
  }
  // H06 — hide a sparse trending rail rather than showing 2–3
  // posters in an ocean of space.
  if (items.length < RECO_RAIL_MIN_ITEMS) return null
  const suffix = contentTypeSuffix(items)
  return {
    id: "trending",
    kind: "trending",
    title: suffix
      ? `Trending & Worth Watching — ${suffix}`
      : "Trending & Worth Watching",
    description: extras?.length
      ? "Trending now, matched to your library"
      : "Popular and well-regarded in your library",
    items,
    variant: variantForRail("trending", items),
  }
}

function buildHiddenGems(ctx: BuildContext, railIndex: number): HomeRail | null {
  // Genuinely worthwhile, less obvious: high confidence-aware quality
  // with real vote support, unwatched, never dismissed. An obscure
  // 10.0 with no votes and no TMDb match is excluded by the support
  // floor — its tiered quality is the prior mean (6.5) and it fails
  // both gates (a TMDb-matched title may qualify via Tier 2 instead
  // — see the vote-count decision note above candidateToItem).
  const pool = qualityPool(
    ctx.data.candidates
      .filter((c) => (c.kind === "movie" || c.kind === "series"))
      .filter((c) => cleanTitle(c.title))
      .filter((c) => !ctx.recommendationExcluded.has(candidateKey(c))),
    GEM_MIN_BAYESIAN,
    GEM_MIN_VOTES,
  ).sort((a, b) => {
    const bayesDiff = tieredQuality(b) - tieredQuality(a)
    if (bayesDiff !== 0) return bayesDiff
    // Equal proven quality: the less-seen title is the better gem.
    const votesDiff = (a.voteCount ?? 0) - (b.voteCount ?? 0)
    if (votesDiff !== 0) return votesDiff
    return a.title.localeCompare(b.title)
  })
  const items: HomeRailItem[] = []
  // Fresh titles first: a gem already starring in Next Obsession does
  // not need to headline here too — the rail should surface new
  // discoveries, and fresh-first keeps the later genre rails fed.
  // Already-placed-once titles fill any gaps, within the cap.
  for (const pass of [0, 1]) {
    for (const candidate of pool) {
      if (items.length >= HOME_RAILS_LIMIT) break
      const key = candidateKey(candidate)
      if (pass === 0 && ctx.placements.count(key) > 0) continue
      if (!ctx.placements.canPlace(key, railIndex, "hidden-gems")) continue
      ctx.placements.place(key, railIndex, "hidden-gems")
      items.push(
        candidateToItem(candidate, { reason: "Highly rated, waiting to be discovered" }),
      )
    }
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  // H06 — hide a sparse gems rail rather than padding it.
  if (items.length < RECO_RAIL_MIN_ITEMS) return null
  const suffix = contentTypeSuffix(items)
  return {
    id: "hidden-gems",
    kind: "hidden-gems",
    title: suffix ? `Hidden Gems — ${suffix}` : "Hidden Gems",
    description: "Highly rated, not watched yet",
    items,
    seeAllHref: "/discover",
    variant: variantForRail("hidden-gems", items),
  }
}

function buildTonight(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  // Live programmes first — but ONLY from real EPG data. Resolved
  // slots (with real start/stop times) win; without them the rail
  // falls back to DiscoverData.nowPlaying titles, with no times
  // attached — never invented. A channel with no current programme
  // gets no card: never channel logos alone.
  const slots = ctx.tonightEpg ?? []
  let livePlaced = 0
  if (slots.length) {
    for (const slot of slots.slice(0, TONIGHT_MAX_LIVE)) {
      if (!cleanTitle(slot.channelName) || !cleanTitle(slot.nowTitle)) continue
      // Stale-guard: a slot whose programme already ended is dropped,
      // never shown as "on now" (couch-livetv-epg programmeState).
      if (programmeState(slot.nowStartMs, slot.nowStopMs, ctx.nowMs) !== "now") {
        continue
      }
      const key = `live:${slot.channelId}`
      if (!ctx.placements.canPlace(key, railIndex, "tonight")) continue
      ctx.placements.place(key, railIndex, "tonight")
      const nowRange = epgTimeRangeLabel(slot.nowStartMs, slot.nowStopMs)
      const nextRange =
        slot.nextTitle && slot.nextStartMs != null && slot.nextStopMs != null
          ? epgTimeRangeLabel(slot.nextStartMs, slot.nextStopMs)
          : null
      // The view renders a live card as channel title / nowTitle /
      // "Next: {nextTitle}", so the programme title, its on-now
      // status and its real time range travel in those strings; the
      // structured ms fields carry the same facts for the view.
      items.push({
        key,
        kind: "live",
        id: slot.channelId,
        title: slot.channelName,
        posterUrl: slot.channelLogo ?? undefined,
        detailHref: `/livetv?channel=${encodeURIComponent(slot.channelId)}`,
        playHref: `/livetv?channel=${encodeURIComponent(slot.channelId)}`,
        isLive: true,
        nowTitle: nowRange
          ? `${slot.nowTitle} · On now · ${nowRange}`
          : `${slot.nowTitle} · On now`,
        nextTitle:
          slot.nextTitle && nextRange
            ? `${slot.nextTitle} · ${nextRange}`
            : (slot.nextTitle ?? undefined),
        nowStartMs: slot.nowStartMs,
        nowStopMs: slot.nowStopMs,
        nextStartMs: slot.nextStartMs ?? undefined,
        nextStopMs: slot.nextStopMs ?? undefined,
        programmeStatus: "now",
        reason: nowRange ? `On now · ${nowRange}` : "On now",
        contentKind: "live",
        typeLine: "Live TV",
      })
      livePlaced++
    }
  }
  if (!livePlaced) {
    for (const candidate of ctx.data.nowPlaying.slice(0, TONIGHT_MAX_LIVE)) {
      if (candidate.kind !== "live" || !cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (!ctx.placements.canPlace(key, railIndex, "tonight")) continue
      ctx.placements.place(key, railIndex, "tonight")
      const { nowTitle, nextTitle } = parseNowNext(candidate.overview)
      items.push(
        candidateToItem(candidate, {
          isLive: true,
          nowTitle,
          nextTitle,
          reason: nowTitle ? `Now: ${nowTitle}` : "On now",
        }),
      )
      livePlaced++
    }
  }
  // Then the best taste-ranked unwatched picks not already placed.
  // Fresh titles first (a rail that just repeats Next Obsession is
  // not curation); already-placed-once titles fill any gaps, within
  // the at-most-2-rails rule. H02 — fillers are recommendations, so
  // they need quality evidence (real votes, or a TMDb match): an
  // unproven title never fills Tonight's Picks, it only ever
  // appears in the taste-ranked Next Obsession rail, below proven
  // titles.
  for (const pass of [0, 1]) {
    for (const ranked of ctx.ranked) {
      if (items.length >= HOME_RAILS_LIMIT) break
      const candidate = ranked.candidate
      if (!cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (ctx.recommendationExcluded.has(key)) continue
      if (!hasTieredSupport(candidate, 1)) continue
      if (pass === 0 && ctx.placements.count(key) > 0) continue
      if (!ctx.placements.canPlace(key, railIndex, "tonight")) continue
      ctx.placements.place(key, railIndex, "tonight")
      items.push(
        candidateToItem(candidate, {
          // H05 — explain() or the neutral label, never the raw
          // engine reason.
          reason: personalisedReason(ctx.signals, candidate),
        }),
      )
    }
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  if (items.length < TONIGHT_MIN_ITEMS) return null
  const hasLive = items.some((item) => item.isLive)
  const suffix = hasLive ? "Live TV" : contentTypeSuffix(items)
  return {
    id: "tonight",
    kind: "tonight",
    title: suffix ? `Tonight's Picks — ${suffix}` : "Tonight's Picks",
    description: hasLive
      ? "On now and up next, plus films and series for tonight"
      : "For tonight, from your library",
    items,
    variant: variantForRail("tonight", items),
  }
}

function buildRecentlyAdded(ctx: BuildContext, railIndex: number): HomeRail | null {
  // Factual rail: only titles with a real catalogue `added`
  // timestamp (DiscoverData.recentlyAdded). Movies only, per the rail
  // title. When there is no addition evidence, the rail hides.
  const items: HomeRailItem[] = []
  for (const candidate of ctx.data.recentlyAdded) {
    if (candidate.kind !== "movie") continue
    if (!cleanTitle(candidate.title)) continue
    const key = candidateKey(candidate)
    if (!ctx.placements.canPlace(key, railIndex, "recently-added")) continue
    ctx.placements.place(key, railIndex, "recently-added")
    items.push(
      candidateToItem(candidate, {
        // H01 — the rail title already says "Recently Added"; the
        // subtitle names the type + runtime ("Movie · 1h 45m").
        reason: typeLineFor(candidate),
      }),
    )
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  if (!items.length) return null
  return {
    id: "recently-added",
    kind: "recently-added",
    title: "Recently Added Movies",
    description: "New to your library",
    items,
    seeAllHref: "/recently-added",
    variant: variantForRail("recently-added", items),
  }
}

function buildContinueSeries(ctx: BuildContext, railIndex: number): HomeRail | null {
  const items: HomeRailItem[] = []
  const seen = new Set<string>()
  const rows = ctx.extras.progressRows
  if (rows) {
    for (const row of rows) {
      if (row.kind !== "episode" || row.seriesId == null) continue
      if (row.completed || (row.position ?? 0) <= 0) continue
      const candidate = ctx.byKey.get(`series:${row.seriesId}`)
      if (!candidate || !cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (!ctx.placements.canPlace(key, railIndex, "continue-series")) continue
      ctx.placements.place(key, railIndex, "continue-series")
      const detailHref = candidateDetailHref(candidate)
      items.push(
        candidateToItem(candidate, {
          progress: progressFraction(row),
          season: row.season ?? undefined,
          episode: row.episodeNum ?? undefined,
          episodeTitle: row.episodeTitle ?? undefined,
          detailHref,
          playHref: `${detailHref}&autoplay=1&episode=${encodeURIComponent(row.id)}`,
          reason: "Continue watching",
        }),
      )
    }
  } else {
    for (const candidate of ctx.data.continueWatching) {
      if (candidate.kind !== "series") continue
      if (!cleanTitle(candidate.title)) continue
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (!ctx.placements.canPlace(key, railIndex, "continue-series")) continue
      ctx.placements.place(key, railIndex, "continue-series")
      items.push(candidateToItem(candidate, { reason: "Continue watching" }))
    }
  }
  if (!items.length) return null
  const finalItems = items.slice(0, HOME_RAILS_LIMIT)
  return {
    id: "continue-series",
    kind: "continue-series",
    title: "Continue Your Series",
    description: "Pick up your series where you left off",
    items: finalItems,
    seeAllHref: "/series",
    variant: variantForRail("continue-series", finalItems),
  }
}

function buildShort(ctx: BuildContext, railIndex: number): HomeRail | null {
  // Verified runtime only: a film with no runtime metadata is never
  // presented as "under two hours". Quality-gated like the other
  // "best of" rails — a no-vote 10.0 cannot lead it.
  const pool = qualityPool(
    ctx.data.candidates
      .filter((c) => c.kind === "movie")
      .filter((c) => cleanTitle(c.title))
      .filter((c) => !ctx.recommendationExcluded.has(candidateKey(c)))
      .filter(
        (c) =>
          typeof c.runtimeMinutes === "number" &&
          c.runtimeMinutes > 0 &&
          c.runtimeMinutes < SHORT_MAX_RUNTIME_MINUTES,
      ),
    SHORT_MIN_BAYESIAN,
    SHORT_MIN_VOTES,
  ).sort((a, b) => {
    const bayesDiff = tieredQuality(b) - tieredQuality(a)
    if (bayesDiff !== 0) return bayesDiff
    const runtimeDiff = (a.runtimeMinutes ?? 0) - (b.runtimeMinutes ?? 0)
    if (runtimeDiff !== 0) return runtimeDiff
    return a.title.localeCompare(b.title)
  })
  const items: HomeRailItem[] = []
  // Fresh titles first (see Hidden Gems): the shortest great films
  // should not all be repeats of earlier rails.
  for (const pass of [0, 1]) {
    for (const candidate of pool) {
      if (items.length >= HOME_RAILS_LIMIT) break
      const key = candidateKey(candidate)
      if (pass === 0 && ctx.placements.count(key) > 0) continue
      if (!ctx.placements.canPlace(key, railIndex, "short")) continue
      ctx.placements.place(key, railIndex, "short")
      items.push(
        candidateToItem(candidate, {
          reason: `${candidate.runtimeMinutes} min · Highly rated`,
        }),
      )
    }
    if (items.length >= HOME_RAILS_LIMIT) break
  }
  // H06 — hide a sparse short-films rail rather than padding it.
  if (items.length < RECO_RAIL_MIN_ITEMS) return null
  const suffix = contentTypeSuffix(items)
  return {
    id: "short",
    kind: "short",
    title: suffix ? `Short & Sweet — ${suffix}` : "Short & Sweet",
    description: "Highly rated films under two hours",
    items,
    variant: variantForRail("short", items),
  }
}

// ---------------------------------------------------------------------------
// Genre rails
// ---------------------------------------------------------------------------

interface GenreRailDef {
  id: string
  title: string
  /** Lower-cased substrings matched against the candidate's genres. */
  match: string[]
  /** Quality floor for this rail (default: not below the prior mean). */
  minBayesian?: number
  minVotes?: number
}

const GENRE_RAIL_DEFS: GenreRailDef[] = [
  { id: "genre-crime-mystery", title: "Crime & Mystery", match: ["crime", "mystery", "detective", "noir"] },
  { id: "genre-action-thrillers", title: "Action & Thrillers", match: ["action", "thriller", "adventure"] },
  { id: "genre-sci-fi", title: "Science Fiction", match: ["sci-fi", "science fiction", "sci fi"] },
  { id: "genre-comedy", title: "Comedy", match: ["comedy"] },
  { id: "genre-documentary", title: "Documentary", match: ["documentary"] },
  {
    id: "genre-prestige-drama",
    title: "Prestige Drama",
    match: ["drama"],
    minBayesian: PRESTIGE_DRAMA_MIN_BAYESIAN,
    minVotes: PRESTIGE_DRAMA_MIN_VOTES,
  },
  { id: "genre-horror", title: "Horror", match: ["horror"] },
]

function buildGenreRails(ctx: BuildContext, startIndex: number): HomeRail[] {
  const taste = ctx.data.taste
  const scored: Array<{ def: GenreRailDef; items: RankedCandidate[]; score: number }> = []
  for (const def of GENRE_RAIL_DEFS) {
    const minBayesian = def.minBayesian ?? 6.5
    const minVotes = def.minVotes ?? 0
    const pool = ctx.ranked.filter((ranked) => {
      const candidate = ranked.candidate
      if (!cleanTitle(candidate.title)) return false
      if (ctx.recommendationExcluded.has(candidateKey(candidate))) return false
      // H03 — taxonomy, not genre strings, decides the kind. A crime
      // documentary is a documentary, never a crime drama: documentaries
      // are excluded from every fiction genre rail, and the Documentary
      // rail takes them on kind alone (its genre match would also catch
      // fiction titles merely tagged "documentary").
      const kind = contentKindOf(candidate)
      if (def.id === "genre-documentary") {
        if (!isDocumentaryKind(kind)) return false
      } else {
        if (isDocumentaryKind(kind)) return false
        const genres = candidate.genres.map((g) => g.toLowerCase())
        if (!genres.some((g) => def.match.some((m) => g.includes(m)))) return false
      }
      if (tieredQuality(candidate) < minBayesian) return false
      if (minVotes > 0 && !hasTieredSupport(candidate, minVotes)) return false
      // Genre pools require evidence too: a no-vote 10.0 with no
      // TMDb match scores the prior mean (6.5) and would otherwise
      // sit mid-list in a genre rail. Real votes (any count) or a
      // TMDb match with a real rating count as evidence; without
      // either the title stays out of every genre pool.
      if (!hasAnyEvidence(candidate)) return false
      return true
    })
    if (pool.length < GENRE_RAIL_MIN_ITEMS) continue
    // Rail priority: taste affinity for these genres first, then
    // proven quality — so the rails that surface are the ones this
    // household actually leans toward, never all seven every launch.
    const affinity = def.match.reduce(
      (sum, m) => sum + (taste.genreWeights[m] || 0),
      0,
    )
    const meanBayesian =
      pool.reduce((sum, r) => sum + tieredQuality(r.candidate), 0) /
      pool.length
    scored.push({ def, items: pool, score: affinity * 2 + meanBayesian })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.def.title.localeCompare(b.def.title)
  })
  const rails: HomeRail[] = []
  let railIndex = startIndex
  for (const { def, items } of scored.slice(0, GENRE_RAILS_MAX)) {
    const railItems: HomeRailItem[] = []
    for (const ranked of items) {
      const candidate = ranked.candidate
      const key = candidateKey(candidate)
      if (!ctx.placements.canPlace(key, railIndex, def.id)) continue
      ctx.placements.place(key, railIndex, def.id)
      railItems.push(
        candidateToItem(candidate, {
          // H05 — explain() or the neutral label.
          reason: personalisedReason(ctx.signals, candidate),
        }),
      )
      if (railItems.length >= HOME_RAILS_LIMIT) break
    }
    if (railItems.length < GENRE_RAIL_MIN_ITEMS) continue
    // H01 — the rail title names its content type ("Crime & Mystery
    // — Films", "True Crime — Documentary Series"). The Documentary
    // rail of a single kind is just that kind's plural — saying
    // "Documentary — Documentary Series" twice helps nobody.
    const suffix = contentTypeSuffix(railItems)
    let title = suffix ? `${def.title} — ${suffix}` : def.title
    if (def.id === "genre-documentary" && suffix) {
      const kinds = [
        ...new Set(
          railItems
            .map((item) => item.contentKind)
            .filter((kind): kind is ContentKind => !!kind),
        ),
      ]
      if (kinds.length === 1) title = suffix
    }
    rails.push({
      id: def.id,
      kind: "genre",
      title,
      items: railItems,
      variant: variantForRail("genre", railItems),
    })
    railIndex++
  }
  return rails
}

// ---------------------------------------------------------------------------
// Hero selection
// ---------------------------------------------------------------------------

function pickHomeHero(ctx: BuildContext): HomeHero | null {
  const taste = ctx.data.taste
  // Hard gates — a hero must be all of these:
  //   - real catalogue title with artwork (poster is the artwork the
  //     catalogue carries; backdropUrl is used when one exists)
  //   - sane year when the catalogue carries one (mismatched years
  //     and junk metadata are out)
  //   - credible, confidence-aware quality: Tier 1 is Bayesian >= 7.0
  //     with at least 100 real votes; when no title qualifies that
  //     way, Tier 2 is a TMDb-matched title rated >= 7.0 (see the
  //     vote-count decision note above candidateToItem). A perfect
  //     10.0 with no votes and no TMDb match scores the prior mean
  //     (6.5) and never qualifies.
  //   - not dismissed, not finished, not already-watched. In-progress
  //     titles stay eligible — resuming is strong relevance.
  const heroExcluded = new Set<string>([
    ...ctx.recommendationExcluded,
  ])
  for (const key of ctx.continueWatchingKeys) heroExcluded.delete(key)

  const pool = qualityPool(
    ctx.data.candidates
      .filter((c) => (c.kind === "movie" || c.kind === "series"))
      .filter((c) => cleanTitle(c.title))
      .filter((c) => !!c.posterUrl)
      .filter((c) => c.year === undefined || cleanYear(c.year, ctx.nowMs) !== undefined)
      .filter((c) => !heroExcluded.has(candidateKey(c))),
    HERO_MIN_BAYESIAN,
    HERO_MIN_VOTES,
  )
  if (!pool.length) return null

  // Relevance: the same local ranking, confidence-adjusted.
  const rankedByKey = new Map(
    ctx.ranked.map((r) => [candidateKey(r.candidate), r] as const),
  )
  const sparseProfile =
    !ctx.data.hasHistory &&
    (taste.likedTitles || []).length === 0 &&
    (taste.favouriteTitles || []).length === 0

  let ordered: DiscoverCandidate[]
  if (sparseProfile) {
    // No taste to learn from: credible catalogue-matched quality
    // decides — best Bayesian first, then most votes. Never catalogue
    // order, never random.
    ordered = [...pool].sort((a, b) => {
      const bayesDiff = tieredQuality(b) - tieredQuality(a)
      if (bayesDiff !== 0) return bayesDiff
      const votesDiff = (b.voteCount ?? 0) - (a.voteCount ?? 0)
      if (votesDiff !== 0) return votesDiff
      return a.title.localeCompare(b.title)
    })
  } else {
    ordered = [...pool].sort((a, b) => {
      const ra = rankedByKey.get(candidateKey(a))
      const rb = rankedByKey.get(candidateKey(b))
      const scoreA =
        (ra ? confidenceAdjustedScore(ra) : 0) +
        tieredQuality(a) * 2 +
        (a.backdropUrl ? HERO_BACKDROP_BONUS : 0) +
        (ctx.continueWatchingKeys.has(candidateKey(a)) ? HERO_CONTINUE_BONUS : 0)
      const scoreB =
        (rb ? confidenceAdjustedScore(rb) : 0) +
        tieredQuality(b) * 2 +
        (b.backdropUrl ? HERO_BACKDROP_BONUS : 0) +
        (ctx.continueWatchingKeys.has(candidateKey(b)) ? HERO_CONTINUE_BONUS : 0)
      if (scoreB !== scoreA) return scoreB - scoreA
      return a.title.localeCompare(b.title)
    })
  }

  // Avoid excessive repetition: prefer a hero not shown in the last
  // 10 loads; only repeat when every eligible title was recently
  // shown (then the least-recently-shown leads).
  const history = currentHeroHistory()
  const fresh = ordered.filter((c) => !history.includes(candidateKey(c)))
  let pick = fresh[0]
  if (!pick) {
    // Every eligible title was recently shown: repeat the
    // least-recently-shown one (largest history index wins).
    pick = [...ordered].sort((a, b) => {
      const ia = history.indexOf(candidateKey(a))
      const ib = history.indexOf(candidateKey(b))
      return ib - ia
    })[0]
  }
  if (!pick) return null
  recordHeroShown(candidateKey(pick))
  const item = candidateToItem(pick)
  return {
    item,
    // H05 — a signal-backed reason when explain() has one, else the
    // factual quality label. The hero is quality-gated (Tier 1
    // vote-backed or Tier 2 TMDb-matched), so "Highly rated" is an
    // honest quality claim, never a taste claim.
    reason:
      explain(pick, ctx.signals) ??
      (typeof pick.rating === "number"
        ? `Highly rated (${pick.rating.toFixed(1)}/10)`
        : "Featured in your library"),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Never replace valid cached content with an empty screen. A failed
 * or empty fresh load keeps the cache; a fresh load with real content
 * replaces it. (Ported from W3's home-assembly — the view depends on
 * this exact semantics.)
 */
export function mergeHomePayload(
  cached: HomePayload | null,
  fresh: HomePayload | null,
): HomePayload | null {
  if (!fresh) return cached
  const freshHasContent = !!fresh.hero || fresh.rails.length > 0
  if (!freshHasContent) return cached
  return fresh
}

export async function loadHomeRails(
  data: DiscoverData,
  followed: FollowedEpisode[],
  extras: LoadHomeRailsExtras = {},
): Promise<HomePayload> {
  // Abort before doing anything: a superseded load never paints.
  // (Checked again by the view after each of its own awaits.)
  if (extras.signal?.aborted) {
    throw new DOMException("Home load aborted", "AbortError")
  }
  try {
    if (!data || !Array.isArray(data.candidates) || !data.taste) {
      throw new Error("loadHomeRails: invalid DiscoverData")
    }
    // H07 — resolve real EPG slots before building (best-effort,
    // never throws; a superseded load still aborts right after).
    const tonightEpg = await resolveTonightEpg(extras, extras.nowMs ?? Date.now())
    if (extras.signal?.aborted) {
      throw new DOMException("Home load aborted", "AbortError")
    }
    const ctx = buildContext(data, followed ?? [], extras, tonightEpg)
    const rails: HomeRail[] = []
    // Rail indices count emitted rails only: an omitted rail does not
    // sit between two displayed rails, so adjacency is judged on the
    // rails the user actually sees, in order.
    const maybePush = (rail: HomeRail | null) => {
      if (rail) rails.push(rail)
    }
    maybePush(buildContinueWatching(ctx, rails.length))
    maybePush(buildNewEpisodes(ctx, rails.length))
    maybePush(buildNextObsession(ctx, rails.length))
    maybePush(buildTrending(ctx, rails.length))
    maybePush(buildHiddenGems(ctx, rails.length))
    maybePush(buildTonight(ctx, rails.length))
    maybePush(buildRecentlyAdded(ctx, rails.length))
    maybePush(buildContinueSeries(ctx, rails.length))
    maybePush(buildShort(ctx, rails.length))
    for (const genreRail of buildGenreRails(ctx, rails.length)) {
      rails.push(genreRail)
    }
    const hero = pickHomeHero(ctx)
    // H06 — mark the rails that are deliberately shown sparse (below
    // the recommendation floor): only factual rails can be sparse,
    // since recommendation rails hide instead. The view passes it
    // to TvRail's `sparse` prop (`.rs-rail--sparse`).
    for (const rail of rails) {
      rail.sparse = rail.items.length < RECO_RAIL_MIN_ITEMS
    }
    const payload: HomePayload = { hero, rails }
    // C2 — record what the recommendation rails actually showed, so
    // the same small group of titles stops dominating Home. Guarded
    // inside trackExposure (no-ops with no storage, e.g. node tests).
    trackExposure(
      payload.rails
        .filter((rail) =>
          ["next-obsession", "trending", "hidden-gems", "genre", "tonight"].includes(
            rail.kind,
          ),
        )
        .flatMap((rail) => rail.items.map((item) => item.key)),
    )
    moduleCache = payload
    writeStoredPayload(payload)
    return payload
  } catch (err) {
    // An abort is not a metadata failure: let it propagate so the
    // view can tell "superseded" apart from "refresh failed".
    if (err instanceof DOMException && err.name === "AbortError") throw err
    // Never throw valid cached content away on a metadata failure:
    // serve the last good payload, or an empty one when there is none.
    return getCachedHomeRails() ?? { hero: null, rails: [] }
  }
}

/** Convenience for the view: followed episodes via the registered provider. */
export async function loadFollowedEpisodes(): Promise<FollowedEpisode[]> {
  try {
    await ensureFollowedLoaded()
  } catch {
    // Followed store unavailable: new-episodes rail is omitted, the
    // rest of Home still renders.
  }
  try {
    return followedProvider.getNewEpisodes()
  } catch {
    return []
  }
}
