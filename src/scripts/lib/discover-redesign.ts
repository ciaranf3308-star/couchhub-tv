// Discover redesign (0.11.18) — the guided three-step flow.
//
//   Step 1 "What are we watching?" — pick a kind: movie / series / either.
//   Step 2 "What are you drawn to?" — pick one or more genre draws.
//   Step 3 "Tell me what you really want." — optional free-text brief.
//
// This module owns ONLY the pure flow logic, so it runs under vitest
// with no browser globals and no model calls:
//
//   - the flow state machine (fresh / kind / categories / brief /
//     refine-back-to-brief, all transitions pure, inputs never mutated)
//   - the request text sent to the real Discovery 3.0 orchestrator
//     (runAiDiscovery): kind + category draws + brief, composed as
//     ONE natural-language request for the LLM to interpret by
//     meaning — never reduced to literal keyword matching, and the
//     session's request always takes priority over usual viewing habits
//   - the reveal queue: only TMDB-verified recommendations with a
//     confirmed catalogue match are ever playable, and Next pick never
//     repeats a title within the session (shown ids are tracked and
//     excluded from the next pick AND from any refetch request)
//
// Hard rules enforced here, not in the view:
//   - unplayable titles never surface (playableRecommendations)
//   - skipping is NOT a dislike: nothing here records a skip anywhere
//     (there is no dislike/skipped store in this module at all)
//   - refine keeps the original choices and brief (refineFlowState)
//   - the mockup's example selections/text are illustrative only:
//     nothing in this module hard-codes a genre, a title, or a brief
//
// The view (DiscoverView.svelte) owns rendering, the orchestrator
// call, playback links (detail routes), Watch Later (preferences.js
// toggleWatchlist) and controller focus. It must never re-implement
// any of this.

import type { VerifiedRecommendation } from "./ai/verification.js"

// ---------------------------------------------------------------------------
// Kind + categories
// ---------------------------------------------------------------------------

export type DiscoverKind = "movie" | "series" | "either"

/** Step 1 cards, in display order. */
export const KIND_CARDS: Array<{
  id: DiscoverKind
  label: string
  subtitle: string
  art: string
}> = [
  { id: "movie", label: "Movie", subtitle: "One great film", art: "/art/discover/card-movie.png" },
  { id: "series", label: "Series", subtitle: "Your next obsession", art: "/art/discover/card-series.png" },
  { id: "either", label: "Either", subtitle: "Surprise me", art: "/art/discover/card-either.png" },
]

export const KIND_LABELS: Record<DiscoverKind, string> = {
  movie: "Movie",
  series: "Series",
  either: "Either",
}

/** Step 2 tiles, in display order. Labels are the only copy here. */
export const GENRE_CATEGORIES: Array<{
  id: string
  label: string
  art: string
  /** One-line subtitle shown under the tile label. */
  tagline: string
}> = [
  { id: "anime", label: "Anime", art: "/art/discover/genre-anime.png", tagline: "Bold, stylised worlds" },
  { id: "thriller", label: "Thriller", art: "/art/discover/genre-thriller.png", tagline: "Tension that never lets up" },
  { id: "horror", label: "Horror", art: "/art/discover/genre-horror.png", tagline: "Best watched with the lights on" },
  { id: "scifi", label: "Sci-Fi", art: "/art/discover/genre-scifi.png", tagline: "Other worlds, big ideas" },
  { id: "crime", label: "Crime", art: "/art/discover/genre-crime.png", tagline: "Mysteries and mean streets" },
  { id: "comedy", label: "Comedy", art: "/art/discover/genre-comedy.png", tagline: "Something to laugh at" },
  { id: "drama", label: "Drama", art: "/art/discover/genre-drama.png", tagline: "Stories that stay with you" },
  { id: "documentary", label: "Documentary", art: "/art/discover/genre-documentary.png", tagline: "Real life, stranger than fiction" },
]

export const GENRE_LABELS: Record<string, string> = Object.fromEntries(
  GENRE_CATEGORIES.map((g) => [g.id, g.label]),
)

/** True for a known genre id (case-insensitive). Unknown ids are ignored. */
export function isGenreCategory(id: string): boolean {
  return GENRE_CATEGORIES.some((g) => g.id === (id ?? "").trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// Flow state
// ---------------------------------------------------------------------------

export type DiscoverFlowStep = "kind" | "categories" | "brief" | "loading" | "reveal"

export interface DiscoverFlowState {
  step: DiscoverFlowStep
  /** null until step 1 is answered. */
  kind: DiscoverKind | null
  /** Selected genre ids, in selection order. Empty = no draws yet. */
  categories: string[]
  /** Free-text brief from step 3, exactly as typed. "" = skipped. */
  brief: string
}

/** Fresh, empty flow. A NEW object every call. Step 1, nothing chosen. */
export function freshDiscoverFlow(): DiscoverFlowState {
  return { step: "kind", kind: null, categories: [], brief: "" }
}

/**
 * Step 1 answer: set the kind and move to step 2. Categories and
 * brief are preserved (a kind change mid-flow never wipes the draws).
 * Returns a NEW state object; the input is never mutated.
 */
export function selectDiscoverKind(
  state: DiscoverFlowState,
  kind: DiscoverKind,
): DiscoverFlowState {
  return { ...state, kind, categories: [...state.categories], step: "categories" }
}

/**
 * Step 2 toggle: tap a tile to select it, tap again to deselect.
 * Multi-select — selecting never clears another tile. Unknown ids
 * are ignored. Returns a NEW state object; the input is never
 * mutated. Step is unchanged (Continue moves on).
 */
export function toggleDiscoverCategory(
  state: DiscoverFlowState,
  categoryId: string,
): DiscoverFlowState {
  const id = (categoryId ?? "").trim().toLowerCase()
  if (!isGenreCategory(id)) return { ...state, categories: [...state.categories] }
  const has = state.categories.includes(id)
  return {
    ...state,
    categories: has
      ? state.categories.filter((c) => c !== id)
      : [...state.categories, id],
  }
}

/** "Surprise me" on step 2: clear every draw and move to step 3. */
export function surpriseDiscoverCategories(state: DiscoverFlowState): DiscoverFlowState {
  return { ...state, categories: [], step: "brief" }
}

/** Step 2 Continue: only meaningful with at least one draw; with none
    the caller should use surpriseDiscoverCategories instead. Moves to
    step 3 either way — an empty draw list is a valid "anything" ask. */
export function continueToBrief(state: DiscoverFlowState): DiscoverFlowState {
  return { ...state, categories: [...state.categories], step: "brief" }
}

/** Step 3 text, exactly as typed (trimmed only at request time). */
export function setDiscoverBrief(state: DiscoverFlowState, brief: string): DiscoverFlowState {
  return { ...state, brief: brief ?? "" }
}

/**
 * Refine (hard rule): return to step 3 with the ORIGINAL kind,
 * categories and brief intact, so the user can say "closer, but
 * darker" without starting over. Nothing is cleared.
 */
export function refineFlowState(state: DiscoverFlowState): DiscoverFlowState {
  return { ...state, categories: [...state.categories], step: "brief" }
}

/** One step back in the flow (Back key): reveal -> brief, brief ->
    categories, categories -> kind. Kind step has nowhere to go. */
export function stepBackFlow(state: DiscoverFlowState): DiscoverFlowState {
  switch (state.step) {
    case "reveal":
    case "loading":
      return { ...state, categories: [...state.categories], step: "brief" }
    case "brief":
      return { ...state, categories: [...state.categories], step: "categories" }
    case "categories":
      return { ...state, categories: [...state.categories], step: "kind" }
    default:
      return { ...state, categories: [...state.categories] }
  }
}

// ---------------------------------------------------------------------------
// Summaries + the request text
// ---------------------------------------------------------------------------

/** "Either · Anime · Thriller · Horror" — the step-3 choices line. */
export function choicesSummary(state: DiscoverFlowState): string {
  const parts: string[] = []
  if (state.kind) parts.push(KIND_LABELS[state.kind])
  for (const id of state.categories) {
    const label = GENRE_LABELS[id]
    if (label) parts.push(label)
  }
  return parts.join(" · ")
}

/** "Selected: Anime · Thriller · Horror" — the step-2 summary line. */
export function selectedSummary(state: DiscoverFlowState): string {
  if (!state.categories.length) return "Selected: nothing yet — pick one or more, or surprise me."
  return `Selected: ${state.categories.map((id) => GENRE_LABELS[id] ?? id).join(" · ")}`
}

export interface DiscoveryQueryOptions {
  /** Titles already shown this session (display titles, not ids). */
  shownTitles?: string[]
}

/**
 * The ONE request sent to runAiDiscovery. Composed as natural
 * language for the LLM to interpret by meaning:
 *
 *   - kind becomes a plain requirement ("Only recommend films."),
 *     or "either" means no kind constraint at all;
 *   - the category draws travel as what the user is "drawn to", not
 *     as a keyword filter — the model does the semantic work, so
 *     "Anime + Horror" can mean unsettling psychological anime, not
 *     titles tagged with both words;
 *   - the brief travels verbatim, including "already seen" and
 *     "avoid" notes — the model honours them, they are never
 *     keyword-matched against the catalogue here;
 *   - the session's request takes priority over usual viewing habits:
 *     that sentence is part of every request, so taste history can
 *     inform but never override what was just asked for;
 *   - titles already shown this session are named as do-not-repeat.
 *
 * Nothing here touches the catalogue: playability is decided later
 * by TMDB verification + matchVerifiedTitleToCatalog, exactly as in
 * Discovery 3.0.
 */
export function buildDiscoveryQuery(
  state: DiscoverFlowState,
  opts: DiscoveryQueryOptions = {},
): string {
  const lines: string[] = []
  if (state.kind === "movie") lines.push("Recommend a film for tonight.")
  else if (state.kind === "series") lines.push("Recommend a TV series for tonight.")
  else lines.push("Recommend something to watch tonight — a film or a TV series, whichever fits best.")
  if (state.categories.length) {
    const draws = state.categories.map((id) => GENRE_LABELS[id] ?? id).join(", ")
    lines.push(`I am drawn to: ${draws}.`)
  }
  const brief = (state.brief ?? "").trim()
  if (brief) lines.push(`What I really want: ${brief}`)
  lines.push(
    "This request describes what I want right now — it takes priority over my usual viewing habits. " +
      "Interpret the brief and the combination of draws by meaning, not by literal keyword matching.",
  )
  const shown = (opts.shownTitles ?? []).filter(Boolean)
  if (shown.length) {
    lines.push(`Do not suggest any of these again — I have already seen them this session: ${shown.join(", ")}.`)
  }
  return lines.join(" ")
}

// ---------------------------------------------------------------------------
// The reveal queue — playable only, no repeats in the session
// ---------------------------------------------------------------------------

/**
 * The library-match rule (hard): a recommendation may only be
 * revealed when it is TMDB-verified AND has a confirmed catalogue
 * match. Anything else — unverified, or verified but not in the
 * library — is dropped here, never shown, never substituted.
 */
export function playableRecommendations(
  results: VerifiedRecommendation[],
): VerifiedRecommendation[] {
  return (results ?? []).filter((rec) => rec?.verified && rec.match != null)
}

/**
 * Stable session id for one recommendation: the catalogue key when
 * matched ("movie:123"), else the TMDB id, else title+kind+year.
 * Used only to recognise "already shown this session".
 */
export function recommendationSessionId(rec: VerifiedRecommendation): string {
  const key = rec?.match?.catalogueKey
  if (key) return key
  if (rec?.verified && rec.tmdbId != null) return `tmdb:${rec.tmdbId}`
  const generated = rec?.generated
  return `gen:${generated?.title ?? rec?.title ?? ""}:${generated?.kind ?? rec?.kind ?? ""}:${generated?.year ?? rec?.year ?? ""}`
}

/**
 * Next pick: the first playable recommendation not yet shown this
 * session, plus the updated shown set. Returns null when the queue
 * is exhausted — the caller then refetches (with the shown titles
 * excluded from the new request) or says so honestly. Skipping a
 * pick records nothing: the shown set only prevents repeats, it is
 * never treated as a dislike and never leaves the session.
 */
export function pickNextRecommendation(
  queue: VerifiedRecommendation[],
  shownIds: ReadonlySet<string>,
): { rec: VerifiedRecommendation | null; shownIds: Set<string> } {
  const next = new Set(shownIds)
  for (const rec of queue ?? []) {
    const id = recommendationSessionId(rec)
    if (next.has(id)) continue
    next.add(id)
    return { rec, shownIds: next }
  }
  return { rec: null, shownIds: next }
}

/** Titles of the shown set, for the refetch exclusion line. */
export function shownTitles(
  queue: VerifiedRecommendation[],
  shownIds: ReadonlySet<string>,
): string[] {
  return (queue ?? [])
    .filter((rec) => shownIds.has(recommendationSessionId(rec)))
    .map((rec) => rec.title)
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Honest no-key state
// ---------------------------------------------------------------------------

/**
 * The flow may only call the model when AI is configured. Any mode
 * other than "connected" is an honest stop, not a silent fallback:
 * the view shows the reason and offers the local catalogue fallback
 * instead of pretending the model answered. (AiMode is
 * "not-configured" | "connected" | "unavailable" | "local" —
 * getAiStatus in ai/status.ts; "connected" is the runnable mode.)
 */
export function isAiReadyMode(mode: string | null | undefined): boolean {
  return mode === "connected"
}

/** Plain-language reason for a non-ready AI mode (no secrets). */
export function aiNotReadyMessage(mode: string | null | undefined, keySaved: boolean): string {
  if (mode === "not-configured" && !keySaved) {
    return "No API key saved — set one up in Settings to ask AI."
  }
  if (mode === "not-configured") {
    return "Finish AI setup in Settings to ask AI."
  }
  if (mode === "local" && keySaved) {
    return "AI is off — turn it on in Settings to ask AI."
  }
  if (mode === "local") {
    return "AI Discovery is off — turn it on in Settings to ask AI."
  }
  return "AI isn't available right now — check Settings."
}
