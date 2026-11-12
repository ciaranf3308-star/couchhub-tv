// CouchHub TV AI Discovery — W1: query-aware retrieval (0.11.5).
//
// The stage that was missing in 0.11.4: before any AI ranking, the full
// catalogue is searched by QUERY RELEVANCE, not catalogue order. The
// production failure was a query ("some fucked up dark anime") answered
// from the first 20 alphabetically-ordered entries — 'G' Men (1935),
// .com for Murder, .raw (2018) — because nothing between the query and
// the model ever asked whether an entry matched the query at all.
//
// Pipeline (all local, deterministic, no network, no paid calls):
//   parseIntent()        natural language -> structured QueryIntent
//   buildCatalogueIndex() one precomputed pass over the whole catalogue
//   applyHardFilters()    demonstrable contradictions out, BEFORE ranking
//   scoreRelevance()      local relevance ranking (query dominates)
//   retrieveCandidates()  the whole pipeline; returns ranked eligible
//                         candidates + a cost-bounded shortlist (<= 20)
//                         for W2's AI reranker.
//
// Honesty rules, baked in:
// - Missing metadata is UNKNOWN, never evidence of compliance. A hard
//   filter only excludes a candidate whose metadata DEMONSTRABLY
//   contradicts the request (e.g. a known Drama against a comedy-only
//   request, a known 1935 film against "after 2015"). A candidate with
//   no genre / no year / no runtime is kept, and ranks BELOW candidates
//   that demonstrate a match.
// - Never guess Japanese origin solely from an animation label. A
//   candidate counts as anime only when its genres tag "anime" or its
//   title/overview says so. Plain "animation" is UNKNOWN for anime:
//   kept, ranked below demonstrated anime, never claimed as anime.
// - Runtime, year and season bounds the candidate cannot verify are
//   recorded in the intent but never hard-filter on unknown data.
// - Query relevance DOMINATES rating and popularity: a highly rated
//   unrelated film is still unrelated, and scores below a modestly
//   rated exact match.
// - Opening a title is NEVER a like. Selection counts
//   (selectedRecommendations) are a tiny tiebreak at most; likes come
//   only from taste.ts (completed / favourited / explicitly liked).
// - This module NEVER imports `./ai/*` and never imports discover.ts
//   (the candidate shape below is a structural mirror of
//   DiscoverCandidate, so there is no import cycle). It never makes a
//   remote call and never preloads per-title remote metadata —
//   enrichment of promising candidates is W2/W3's job, targeted only.

import { normalize } from "@/scripts/lib/text.ts"
import { summarizeTaste, type TasteModel } from "@/scripts/lib/taste.ts"
import { confidenceScore, votesFor } from "./recommendations.ts"

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Max candidates ever handed to the AI reranker in one request. This is
 * a retrieval budget, not a raise of the old cap: the shortlist is the
 * TOP 20 by local relevance over the WHOLE catalogue, never the first
 * 20 in catalogue order. */
export const RETRIEVAL_SHORTLIST_MAX = 20

/** Max titles one title-group (title + year) may contribute to the
 * shortlist: language variants of one title must not eat the budget. */
export const RETRIEVAL_SHORTLIST_PER_GROUP = 1

// ---------------------------------------------------------------------------
// Candidate shape (structural mirror of DiscoverCandidate — no import)
// ---------------------------------------------------------------------------

export interface RetrievableCandidate {
  id: string
  kind: "movie" | "series" | "live"
  title: string
  year?: number
  rating?: number
  voteCount?: number
  genres: string[]
  cast: string[]
  director?: string
  runtimeMinutes?: number
  overview?: string
}

// ---------------------------------------------------------------------------
// Structured intent
// ---------------------------------------------------------------------------

export type ContentKind = "movie" | "series"
export type AnimeConstraint = "required" | "excluded"

export interface QueryIntent {
  rawQuery: string
  /** Firm content kind, only when the query states one. */
  contentKind?: ContentKind
  /**
   * Hard genre requirements, as ANY-of groups: the candidate must match
   * at least one genre in EVERY group. A single genre word is a group
   * of one; "rom-com" is a group of ["comedy", "romance"].
   * Genres are normalised (lower-cased, "sci-fi" -> "sci fi").
   */
  genreGroups: string[][]
  /** Flat list of the required genres (for display / debugging). */
  genres: string[]
  /** Genres implied by mood words (soft: scoring only, never filtering). */
  softGenres: string[]
  /** Anime is a CORE content constraint when stated — never a mood. */
  anime?: AnimeConstraint
  /** Explicitly live-action ("live action") — excludes animation/anime. */
  liveAction?: boolean
  /** Tones the query asks for: dark, disturbing, funny, light, ... */
  tones: string[]
  /** Moods, incl. pace words: intense, relaxing, binge, ... */
  moods: string[]
  /** Pace the query asks for, when stated. */
  pace?: "fast" | "slow" | "binge"
  /** Explicitly mature / adult / disturbing content requested. A soft
   * preference only — there is no certification metadata to filter on. */
  mature?: boolean
  minYear?: number
  maxYear?: number
  maxRuntimeMinutes?: number
  minRuntimeMinutes?: number
  /** Parsed when stated; UNVERIFIABLE — DiscoverCandidate carries no
   * season counts, so these never hard-filter. */
  minSeasons?: number
  maxSeasons?: number
  /** Languages / countries, only when stated. UNVERIFIABLE on the
   * candidate shape — recorded for the reranker, never hard-filtered. */
  languages: string[]
  countries: string[]
  /** Titles the query names or compares against ("like X", "…"). */
  referenceTitles: string[]
  /** Genres to exclude ("not horror", "no romance"). Hard, when the
   * candidate's genres are known. */
  excludedGenres: string[]
  /** True when the query asks for something not yet watched. */
  excludeWatched?: boolean
  /** Remaining content words, for title / cast / overview matching. */
  titleTokens: string[]
  /** True when the query states a real constraint (genre, kind, tone,
   * mood, anime, runtime, year, reference, exclusion, watched) — as
   * opposed to a bare title lookup like "Space Heist". Drives AI
   * eligibility in rankDiscover: a category question is a question,
   * a title lookup is not. */
  hasConstraintIntent: boolean
}

export function emptyIntent(rawQuery: string): QueryIntent {
  return {
    rawQuery,
    genreGroups: [],
    genres: [],
    softGenres: [],
    tones: [],
    moods: [],
    languages: [],
    countries: [],
    referenceTitles: [],
    excludedGenres: [],
    titleTokens: [],
    hasConstraintIntent: false,
  }
}

// ---------------------------------------------------------------------------
// Intent lexicon (deterministic, local — no model involved)
// ---------------------------------------------------------------------------

/** Genre phrase (normalised) -> canonical genre(s). One phrase may map
 * to an ANY-of group ("rom-com" -> comedy OR romance). */
const GENRE_PHRASES: Array<{ phrase: string; genres: string[] }> = [
  { phrase: "science fiction", genres: ["sci fi"] },
  { phrase: "sci fi", genres: ["sci fi"] },
  { phrase: "romantic comedy", genres: ["comedy", "romance"] },
  { phrase: "rom com", genres: ["comedy", "romance"] },
  { phrase: "true crime", genres: ["crime"] },
  { phrase: "comedy", genres: ["comedy"] },
  { phrase: "horror", genres: ["horror"] },
  { phrase: "thriller", genres: ["thriller"] },
  { phrase: "action", genres: ["action"] },
  { phrase: "drama", genres: ["drama"] },
  { phrase: "romance", genres: ["romance"] },
  { phrase: "fantasy", genres: ["fantasy"] },
  { phrase: "crime", genres: ["crime"] },
  { phrase: "mystery", genres: ["mystery"] },
  { phrase: "documentary", genres: ["documentary"] },
  { phrase: "animation", genres: ["animation"] },
  { phrase: "musical", genres: ["musical"] },
  { phrase: "family", genres: ["family"] },
  { phrase: "war", genres: ["war"] },
  { phrase: "western", genres: ["western"] },
  { phrase: "adventure", genres: ["adventure"] },
  { phrase: "history", genres: ["history"] },
  { phrase: "biography", genres: ["biography"] },
  { phrase: "sport", genres: ["sport"] },
  { phrase: "sports", genres: ["sport"] },
  { phrase: "music", genres: ["music"] },
]

const KIND_WORDS: Array<{ words: string[]; kind: ContentKind }> = [
  { words: ["movie", "movies", "film", "films", "flick", "flicks"], kind: "movie" },
  { words: ["series", "show", "shows", "tv show", "tv series", "tv"], kind: "series" },
]

/** Tone word -> tone id. */
const TONE_WORDS: Array<{ words: string[]; tone: string }> = [
  { words: ["fucked up", "messed up", "twisted", "disturbing", "unsettling", "nightmare", "sinister", "haunting"], tone: "disturbing" },
  { words: ["dark", "bleak", "gritty", "grim", "noir", "depressing"], tone: "dark" },
  { words: ["psychological", "mind bending", "cerebral"], tone: "psychological" },
  { words: ["scary", "terrifying", "frightening", "creepy", "gory", "gore"], tone: "scary" },
  { words: ["funny", "hilarious", "comedic", "laugh"], tone: "funny" },
  { words: ["light", "easy", "relaxing", "chill", "feel good", "uplifting", "heartwarming", "cosy", "cozy", "comforting"], tone: "light" },
  { words: ["intense", "thrilling", "gripping", "tense", "adrenaline", "edge"], tone: "intense" },
  { words: ["slow", "slow burn", "meditative"], tone: "slow" },
  { words: ["epic", "sweeping"], tone: "epic" },
]

/** Tone -> genres that demonstrate it (scoring + tone matching). */
const TONE_GENRES: Record<string, string[]> = {
  disturbing: ["horror", "thriller", "crime"],
  dark: ["horror", "thriller", "crime", "mystery"],
  psychological: ["thriller", "mystery", "horror"],
  scary: ["horror", "thriller"],
  funny: ["comedy"],
  light: ["comedy", "family", "animation", "romance", "musical"],
  intense: ["action", "thriller", "horror", "crime", "war", "mystery"],
  slow: ["drama"],
  epic: ["adventure", "action", "history", "war", "fantasy"],
}

/** Tone -> overview keywords that demonstrate it. */
const TONE_KEYWORDS: Record<string, string[]> = {
  disturbing: ["disturbing", "twisted", "unsettling", "nightmare", "sinister", "haunting", "psychological", "dark"],
  dark: ["dark", "bleak", "grim", "gritty", "noir", "corruption", "murder", "death"],
  psychological: ["psychological", "mind", "reality", "identity", "obsession", "paranoia"],
  scary: ["scary", "terrifying", "haunted", "ghost", "demon", "monster", "killer"],
  funny: ["funny", "hilarious", "laugh", "comedy"],
  light: ["heartwarming", "feel good", "uplifting", "charming", "delightful"],
  intense: ["intense", "gripping", "high stakes", "race against"],
  slow: ["slow", "meditative", "contemplative"],
  epic: ["epic", "sweeping", "journey", "quest"],
}

const MATURE_WORDS = new Set([
  "explicit", "adult", "mature", "18", "nsfw", "violent", "erotic",
  "gory", "gore", "disturbing", "fucked up", "messed up", "twisted",
])

/** Preset mood words owned by the Discover quick picks — "surprise",
 * "hidden gems", "short" are presets, not title searches, so the
 * parser consumes them as moods instead of title tokens. */
const PRESET_MOOD_WORDS: Array<{ words: string[]; mood: string }> = [
  { words: ["surprise", "random"], mood: "surprise" },
  { words: ["hidden", "gem", "gems", "underrated", "obscure"], mood: "hidden-gems" },
  { words: ["short", "quick"], mood: "short" },
]

const LANGUAGE_WORDS: Array<{ words: string[]; language: string }> = [
  { words: ["japanese"], language: "japanese" },
  { words: ["korean"], language: "korean" },
  { words: ["french"], language: "french" },
  { words: ["german"], language: "german" },
  { words: ["spanish"], language: "spanish" },
  { words: ["italian"], language: "italian" },
  { words: ["chinese"], language: "chinese" },
  { words: ["bollywood", "indian"], language: "indian" },
]

const COUNTRY_WORDS: Array<{ words: string[]; country: string }> = [
  { words: ["british", "uk", "english"], country: "british" },
  { words: ["irish", "ireland"], country: "irish" },
  { words: ["american", "us", "usa"], country: "american" },
]

const EXCLUSION_MARKERS = new Set(["not", "no", "except", "without", "avoid", "minus"])
const NOT_WATCHED_PHRASES = [
  "havent seen", "havent watched", "not seen", "not watched",
  "never seen", "never watched", "unwatched", "new to me",
  "something i havent seen", "i havent seen",
]

const STOP_WORDS = new Set([
  "something", "anything", "watch", "tonight", "for", "the", "a", "an",
  "me", "us", "we", "i", "like", "fancy", "feel", "mood", "should",
  "what", "show", "movie", "film", "series", "please", "some", "give",
  "find", "looking", "want", "wants", "need", "suggest", "recommend",
  "tonights", "today", "this", "that", "with", "and", "or", "of", "to",
  "in", "on", "is", "it", "as", "at", "by", "from", "about", "after",
  "before", "good", "great", "best", "top", "really", "very", "just",
  "ive", "im", "dont", "cant", "wanna", "gonna", "yeah", "hey", "hi",
])

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}

function numberWord(token: string): number | undefined {
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  return NUMBER_WORDS[token]
}

/** Remove one occurrence of `phrase` (word-boundary aware) from a
 * space-padded string; true when it was present. Longest phrases are
 * taken first so "live action" never leaks an "action" genre. */
function takePhrase(padded: string, phrase: string): { text: string; found: boolean } {
  const needle = ` ${phrase} `
  const idx = padded.indexOf(needle)
  if (idx === -1) return { text: padded, found: false }
  return {
    text: padded.slice(0, idx + 1) + padded.slice(idx + needle.length - 1),
    found: true,
  }
}

function takeWord(padded: string, word: string): { text: string; found: boolean } {
  return takePhrase(padded, word)
}

function tokensOf(padded: string): string[] {
  return padded
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]+/g, ""))
    .filter((t) => t.length > 0)
}

/**
 * Parse a natural-language discovery query into a structured intent.
 * Pure and deterministic: same query, same intent, every time. Slang
 * and shorthand are handled ("fucked up" -> disturbing + mature;
 * "binge" -> series + binge pace; "under two hours" -> maxRuntime 120).
 * Nothing is invented: a field is only set when the query states it,
 * and unverifiable fields (seasons, language) are flagged as such on
 * the intent rather than filtered on.
 */
export function parseIntent(query: string): QueryIntent {
  const rawQuery = query ?? ""
  const intent = emptyIntent(rawQuery)
  // Apostrophes collapse ("haven't" -> "havent") so phrase matching is
  // stable; normalize() then lower-cases and strips punctuation.
  let padded = ` ${normalize(rawQuery.replace(/['’]/g, ""))} `
  if (!padded.trim()) return intent

  // --- Reference titles: quoted phrases first (from the raw query, so
  // capitalisation/punctuation inside quotes is preserved for display).
  for (const match of rawQuery.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const ref = (match[1] ?? match[2] ?? "").trim()
    if (ref.length > 1) intent.referenceTitles.push(ref)
    // Drop the quoted span from the working text so its words are not
    // re-read as genre/tone/title tokens.
    const span = match[0]
    const normSpan = normalize(span.replace(/['’]/g, ""))
    if (normSpan) padded = takePhrase(padded, normSpan).text
  }

  // --- "like X" / "similar to X" reference titles (narrow: 1–4 words,
  // stopped at a comma / "and" / "but" / end; never a genre/mood word).
  const likeMatch = /(?:^| )(?:like|similar to) ([a-z0-9][a-z0-9 ]{0,40}?)(?:,| and | but | with |$)/.exec(padded)
  if (likeMatch) {
    const ref = likeMatch[1].trim().split(/\s+/).slice(0, 4).join(" ")
    const refTokens = ref.split(" ")
    const isGenreOrMood = refTokens.some((t) =>
      GENRE_PHRASES.some((g) => g.phrase === t) ||
      TONE_WORDS.some((tw) => tw.words.includes(t))
    )
    if (ref && !isGenreOrMood && !STOP_WORDS.has(refTokens[0])) {
      intent.referenceTitles.push(ref)
      padded = takePhrase(padded, `like ${ref}`).text
      padded = takePhrase(padded, `similar to ${ref}`).text
    }
  }

  // --- Not-watched: "haven't seen" / "unwatched" / "new to me".
  for (const phrase of [...NOT_WATCHED_PHRASES].sort((a, b) => b.length - a.length)) {
    const taken = takePhrase(padded, phrase)
    if (taken.found) {
      intent.excludeWatched = true
      padded = taken.text
    }
  }

  // --- Anime / live-action (phrases first — "japanese animation" must
  // not leak an "animation" genre requirement, "live action" must not
  // leak an "action" genre requirement). "not anime" is checked BEFORE
  // the bare "anime" word, or the exclusion would read as a requirement.
  let taken = takePhrase(padded, "not anime")
  if (taken.found) {
    intent.anime = "excluded"
    padded = taken.text
  }
  taken = takePhrase(padded, "studio ghibli")
  if (taken.found) {
    intent.anime = "required"
    intent.referenceTitles.push("Studio Ghibli")
    padded = taken.text
  }
  taken = takePhrase(padded, "japanese animation")
  if (taken.found) {
    intent.anime = "required"
    padded = taken.text
  }
  taken = takePhrase(padded, "live action")
  if (taken.found) {
    intent.liveAction = true
    intent.anime = "excluded"
    if (!intent.excludedGenres.includes("animation")) intent.excludedGenres.push("animation")
    padded = taken.text
  }
  taken = takeWord(padded, "anime")
  if (taken.found && intent.anime === undefined) {
    intent.anime = "required"
    padded = taken.text
  } else if (taken.found) {
    // "anime" appeared but an exclusion already claimed it: drop the word.
    padded = taken.text
  }

  // --- Runtime bounds ("under two hours", "less than 90 minutes",
  // "over an hour", "short film"). Numeric bounds are HARD; a bare
  // "short" is only a soft pace hint (see TONE_WORDS).
  const runtimeMatch =
    /(?:under|less than|below|max|up to) (an|one|two|three|four|\d+) ?(hours?|hrs?|minutes?|mins?)/.exec(padded) ??
    /(?:over|at least|minimum|more than) (an|one|two|three|four|\d+) ?(hours?|hrs?|minutes?|mins?)/.exec(padded)
  if (runtimeMatch) {
    const amount = runtimeMatch[1] === "an" ? 1 : numberWord(runtimeMatch[1]) ?? 0
    const unit = runtimeMatch[2]
    const minutes = /hour|hr/.test(unit) ? amount * 60 : amount
    if (minutes > 0) {
      if (/^(?:under|less than|below|max|up to)/.test(runtimeMatch[0].trim())) {
        intent.maxRuntimeMinutes = minutes
      } else {
        intent.minRuntimeMinutes = minutes
      }
      padded = takePhrase(padded, runtimeMatch[0].trim()).text
    }
  }
  taken = takePhrase(padded, "short film")
  if (taken.found) {
    intent.contentKind = "movie"
    intent.maxRuntimeMinutes = 60
    padded = taken.text
  }

  // --- Year bounds ("after 2015", "since 2020", "before 2000",
  // "from the 90s" / "90s"). "recent" / "new" stay soft (no hard bound).
  const afterMatch = /(?:after|since|from) (19|20)\d{2}/.exec(padded)
  if (afterMatch) {
    const year = parseInt(afterMatch[0].slice(-4), 10)
    intent.minYear = /after/.test(afterMatch[0]) ? year + 1 : year
    padded = takePhrase(padded, afterMatch[0].trim()).text
  }
  const beforeMatch = /(?:before|up to) (19|20)\d{2}/.exec(padded)
  if (beforeMatch) {
    const year = parseInt(beforeMatch[0].slice(-4), 10)
    intent.maxYear = /before/.test(beforeMatch[0]) ? year - 1 : year
    padded = takePhrase(padded, beforeMatch[0].trim()).text
  }
  const decadeMatch =
    /(?:the )?((?:19|20)\d{2})s\b/.exec(padded) ??
    /(?:the )?(\d{2})s\b/.exec(padded)
  if (decadeMatch && intent.minYear === undefined && intent.maxYear === undefined) {
    const digits = decadeMatch[1]
    // "1990s" -> 1990; bare "90s" -> 1990, "00s" -> 2000, "20s" -> 2020.
    const start =
      digits.length === 4
        ? parseInt(digits, 10)
        : parseInt(digits, 10) <= 29
          ? 2000 + parseInt(digits, 10)
          : 1900 + parseInt(digits, 10)
    intent.minYear = start
    intent.maxYear = start + 9
    padded = takePhrase(padded, decadeMatch[0].trim()).text
  }

  // --- Season counts ("at least 2 seasons"). Recorded only — the
  // candidate shape carries no season data, so this never filters.
  const seasonsMatch = /(?:at least |minimum |more than )?(\d+|one|two|three|four|five) seasons?/.exec(padded)
  if (seasonsMatch) {
    const n = numberWord(seasonsMatch[1]) ?? 0
    if (n > 0) {
      if (/at least|minimum|more than/.test(seasonsMatch[0])) intent.minSeasons = n
      else intent.maxSeasons = n
      padded = takePhrase(padded, seasonsMatch[0].trim()).text
    }
  }

  // --- Exclusions ("not horror", "no romance", "except musical").
  // Phrase-level first, so "not science fiction" / "not sci-fi" does
  // not leak a genre requirement through the single-token loop below.
  for (const entry of [...GENRE_PHRASES].sort((a, b) => b.phrase.length - a.phrase.length)) {
    for (const marker of ["not", "no", "except", "without", "avoid"]) {
      const takenPhrase = takePhrase(padded, `${marker} ${entry.phrase}`)
      if (takenPhrase.found) {
        for (const g of entry.genres) {
          if (!intent.excludedGenres.includes(g)) intent.excludedGenres.push(g)
        }
        padded = takenPhrase.text
        break
      }
    }
  }
  // Single-token exclusions on the remaining stream ("not horror").
  // Handled on the token stream so the excluded genre is not also
  // read as a required genre.
  let tokenList = tokensOf(padded)
  const remainingTokens: string[] = []
  for (let i = 0; i < tokenList.length; i++) {
    const token = tokenList[i]
    if (EXCLUSION_MARKERS.has(token)) {
      const next = tokenList[i + 1]
      const genreEntry = next
        ? GENRE_PHRASES.find((g) => g.phrase === next)
        : undefined
      if (genreEntry) {
        for (const g of genreEntry.genres) {
          if (!intent.excludedGenres.includes(g)) intent.excludedGenres.push(g)
        }
        i++ // consume the genre word too
        continue
      }
      if (next === "anime") {
        intent.anime = "excluded"
        i++
        continue
      }
      // Marker with nothing mappable after it: drop the marker only.
      continue
    }
    remainingTokens.push(token)
  }
  tokenList = remainingTokens

  // --- Kind words ("film", "series", "show") and kind phrases.
  // "anime movie" / "anime series" were already reduced above only if
  // "anime" was taken; re-check the kind words here. A bare "show"
  // is a stop word elsewhere, so kind detection runs on tokens.
  const tokenSet = new Set(tokenList)
  for (const { words, kind } of KIND_WORDS) {
    if (words.some((w) => tokenSet.has(w))) {
      // "tv" alone (e.g. "tv show") is a series marker only with a
      // companion word; a lone "tv" is not enough.
      if (kind === "series" && tokenSet.has("tv") && !tokenSet.has("show") && !tokenSet.has("series")) continue
      intent.contentKind = kind
    }
  }
  // "binge" implies series-watching.
  if (tokenSet.has("binge")) {
    intent.contentKind = "series"
    intent.pace = "binge"
    intent.moods.push("binge")
  }
  if (tokenSet.has("episode") || tokenSet.has("episodes") || tokenSet.has("season") || tokenSet.has("seasons")) {
    intent.contentKind = "series"
  }

  // --- Genre phrases (longest first) on the remaining text.
  let rest = ` ${tokenList.join(" ")} `
  for (const entry of [...GENRE_PHRASES].sort((a, b) => b.phrase.length - a.phrase.length)) {
    const result = takePhrase(rest, entry.phrase)
    if (result.found) {
      rest = result.text
      intent.genreGroups.push(entry.genres)
      for (const g of entry.genres) {
        if (!intent.genres.includes(g)) intent.genres.push(g)
      }
    }
  }
  tokenList = tokensOf(rest)

  // --- Tones / moods (single words + the multiword phrases above
  // that survive as tokens, e.g. "feel good" was taken as a phrase).
  const toneSet = new Set<string>()
  for (const { words, tone } of TONE_WORDS) {
    if (words.some((w) => w.split(" ").every((part) => tokenList.includes(part)))) {
      toneSet.add(tone)
    }
  }
  // Multiword tone phrases ("fucked up", "mind bending", "feel good")
  // were collapsed by tokenisation, so re-scan the padded text too.
  for (const { words, tone } of TONE_WORDS) {
    for (const phrase of words) {
      if (phrase.includes(" ") && padded.includes(` ${phrase} `)) toneSet.add(tone)
    }
  }
  intent.tones = [...toneSet]
  if (toneSet.has("funny") || toneSet.has("light")) intent.moods.push("light")
  if (toneSet.has("intense") || toneSet.has("dark") || toneSet.has("disturbing") || toneSet.has("scary")) {
    intent.moods.push("intense")
  }
  if (toneSet.has("slow")) intent.pace = "slow"
  if (tokenList.includes("fast") && tokenList.includes("paced")) intent.pace = "fast"
  if (toneSet.has("disturbing") || [...MATURE_WORDS].some((w) => padded.includes(` ${w} `))) {
    intent.mature = true
  }

  // --- Languages / countries (recorded, unverifiable on candidates).
  for (const { words, language } of LANGUAGE_WORDS) {
    if (words.some((w) => tokenList.includes(w))) intent.languages.push(language)
  }
  for (const { words, country } of COUNTRY_WORDS) {
    if (words.some((w) => tokenList.includes(w))) intent.countries.push(country)
  }

  // --- Soft genres implied by the tones (scoring only).
  const soft = new Set<string>()
  for (const tone of intent.tones) {
    for (const g of TONE_GENRES[tone] ?? []) soft.add(g)
  }
  intent.softGenres = [...soft].filter((g) => !intent.genres.includes(g))

  // --- Title tokens: whatever content words are left.
  const consumed = new Set<string>()
  for (const { words } of KIND_WORDS) for (const w of words) consumed.add(w)
  for (const { words } of TONE_WORDS) for (const w of words) for (const part of w.split(" ")) consumed.add(part)
  for (const { words } of LANGUAGE_WORDS) for (const w of words) consumed.add(w)
  for (const { words } of COUNTRY_WORDS) for (const w of words) consumed.add(w)
  for (const g of intent.genres) consumed.add(g)
  for (const g of intent.softGenres) consumed.add(g)
  consumed.add("binge")
  consumed.add("episode")
  consumed.add("episodes")
  consumed.add("season")
  consumed.add("seasons")
  // Preset mood words ("surprise", "hidden gems", "short") belong to
  // the Discover presets, not to title search — consume them as moods.
  for (const { words, mood } of PRESET_MOOD_WORDS) {
    if (words.some((w) => tokenList.includes(w))) {
      if (!intent.moods.includes(mood)) intent.moods.push(mood)
      for (const w of words) consumed.add(w)
    }
  }
  intent.titleTokens = tokenList.filter(
    (t) => t.length > 1 && !STOP_WORDS.has(t) && !consumed.has(t)
  )

  intent.hasConstraintIntent =
    intent.genreGroups.length > 0 ||
    intent.contentKind !== undefined ||
    intent.anime !== undefined ||
    intent.tones.length > 0 ||
    // "surprise" is not a constraint — it asks for a random pick, and
    // must not by itself make a bare word AI-eligible.
    intent.moods.filter((m) => m !== "surprise").length > 0 ||
    intent.maxRuntimeMinutes !== undefined ||
    intent.minRuntimeMinutes !== undefined ||
    intent.minYear !== undefined ||
    intent.maxYear !== undefined ||
    intent.referenceTitles.length > 0 ||
    intent.excludedGenres.length > 0 ||
    intent.excludeWatched === true ||
    intent.languages.length > 0 ||
    intent.countries.length > 0

  return intent
}

// ---------------------------------------------------------------------------
// Local catalogue index
// ---------------------------------------------------------------------------

export type AnimeEvidence = "anime" | "animation" | "none"

/**
 * What the catalogue actually says about a candidate being anime.
 * "anime": genres tag anime, or title/overview says so. "animation":
 * animation genre with no anime evidence — UNKNOWN for anime, never
 * guessed as Japanese. "none": neither.
 */
export function animeEvidence(candidate: RetrievableCandidate): AnimeEvidence {
  const genres = (candidate.genres ?? []).map((g) => normalize(g))
  if (genres.includes("anime")) return "anime"
  const text = `${normalize(candidate.title)} ${normalize(candidate.overview ?? "")}`
  if (/(^| )anime( |$)/.test(` ${text} `)) return "anime"
  if (genres.includes("animation")) return "animation"
  return "none"
}

export interface IndexedCandidate<T extends RetrievableCandidate> {
  candidate: T
  key: string
  titleNorm: string
  titleTokens: string[]
  genreSet: Set<string>
  hasGenres: boolean
  overviewNorm: string
  overviewTokens: Set<string>
  castNorm: string
  directorNorm: string
  anime: AnimeEvidence
  year?: number
  runtimeMinutes?: number
  rating?: number
  votes: number
}

function titleGroupKeyOf(candidate: RetrievableCandidate): string {
  const title = normalize(candidate.title)
  if (!title) return `id:${candidate.kind}:${candidate.id}`
  return `${title}|${candidate.year ?? ""}`
}

export function candidateKeyOf(candidate: RetrievableCandidate): string {
  return `${candidate.kind}:${candidate.id}`
}

/**
 * One precomputed pass over the whole catalogue. Retrieval then scans
 * precomputed strings — O(n) with tiny constants, no per-title remote
 * work, no database, no background service. A few thousand titles is
 * milliseconds on the mini PC.
 */
export function buildCatalogueIndex<T extends RetrievableCandidate>(
  candidates: T[]
): Array<IndexedCandidate<T>> {
  return candidates.map((candidate) => {
    const genreSet = new Set((candidate.genres ?? []).map((g) => normalize(g)))
    const overviewNorm = normalize(candidate.overview ?? "")
    return {
      candidate,
      key: candidateKeyOf(candidate),
      titleNorm: normalize(candidate.title),
      titleTokens: tokensOf(` ${normalize(candidate.title)} `),
      genreSet,
      hasGenres: genreSet.size > 0,
      overviewNorm,
      overviewTokens: new Set(tokensOf(` ${overviewNorm} `)),
      castNorm: normalize((candidate.cast ?? []).join(" ")),
      directorNorm: normalize(candidate.director ?? ""),
      anime: animeEvidence(candidate),
      year: candidate.year,
      runtimeMinutes: candidate.runtimeMinutes,
      rating: candidate.rating,
      votes: votesFor(candidate),
    }
  })
}

// ---------------------------------------------------------------------------
// Hard filtering — BEFORE any ranking
// ---------------------------------------------------------------------------

export interface HardFilterOptions {
  /** Hard-excluded candidate keys (not-interested / disliked). */
  excludeKeys?: Set<string>
  /** Keys the profile already watched; dropped when excludeWatched. */
  watchedKeys?: Set<string>
  excludeWatched?: boolean
}

export interface HardFilterResult<T extends RetrievableCandidate> {
  eligible: Array<IndexedCandidate<T>>
  excluded: Array<{ key: string; reason: string }>
  exclusionReasons: Record<string, number>
}

function exclusionReason(
  entry: IndexedCandidate<RetrievableCandidate>,
  intent: QueryIntent,
  taste: TasteModel | null,
  opts: HardFilterOptions
): string | null {
  const key = entry.key
  if (opts.excludeKeys?.has(key)) return "not-interested"
  if (taste?.notInterestedKeys?.includes(key)) return "not-interested"
  const disliked = taste?.dislikedTitles.find(
    (ref) => `${ref.kind}:${ref.id}` === key
  )
  if (disliked && disliked.weight >= 1) return "disliked"
  const excludeWatched = intent.excludeWatched === true || opts.excludeWatched === true
  if (excludeWatched && opts.watchedKeys?.has(key)) return "already-watched"

  // Firm constraints first: kind is known for every candidate.
  if (intent.contentKind && entry.candidate.kind !== intent.contentKind) {
    return "wrong-kind"
  }
  // Genre groups: only a candidate WITH genre metadata can
  // demonstrably contradict. No genres = unknown = kept.
  if (intent.genreGroups.length > 0 && entry.hasGenres) {
    for (const group of intent.genreGroups) {
      if (!group.some((g) => entry.genreSet.has(g))) return "genre-mismatch"
    }
  }
  // Anime: a candidate with genre metadata and no animation/anime
  // evidence demonstrably is not anime. Animation-only is unknown
  // (kept, ranked below demonstrated anime); no genres at all is
  // unknown too (kept).
  if (intent.anime === "required" && entry.anime === "none" && entry.hasGenres) {
    return "not-anime"
  }
  if (intent.anime === "excluded" && entry.anime === "anime") {
    return "anime-excluded"
  }
  if (intent.excludedGenres.length > 0 && entry.hasGenres) {
    if (intent.excludedGenres.some((g) => entry.genreSet.has(g))) {
      return "excluded-genre"
    }
  }
  if (
    intent.maxRuntimeMinutes !== undefined &&
    entry.runtimeMinutes !== undefined &&
    entry.runtimeMinutes > intent.maxRuntimeMinutes
  ) {
    return "too-long"
  }
  if (
    intent.minRuntimeMinutes !== undefined &&
    entry.runtimeMinutes !== undefined &&
    entry.runtimeMinutes < intent.minRuntimeMinutes
  ) {
    return "too-short"
  }
  if (
    intent.minYear !== undefined &&
    entry.year !== undefined &&
    entry.year < intent.minYear
  ) {
    return "too-old"
  }
  if (
    intent.maxYear !== undefined &&
    entry.year !== undefined &&
    entry.year > intent.maxYear
  ) {
    return "too-new"
  }
  // Seasons, languages and countries are unverifiable on the candidate
  // shape: recorded in the intent, never a filter reason.
  return null
}

export function applyHardFilters<T extends RetrievableCandidate>(
  intent: QueryIntent,
  index: Array<IndexedCandidate<T>>,
  taste: TasteModel | null,
  opts: HardFilterOptions = {}
): HardFilterResult<T> {
  const eligible: Array<IndexedCandidate<T>> = []
  const excluded: Array<{ key: string; reason: string }> = []
  const exclusionReasons: Record<string, number> = {}
  for (const entry of index) {
    const reason = exclusionReason(entry, intent, taste, opts)
    if (reason) {
      excluded.push({ key: entry.key, reason })
      exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1
    } else {
      eligible.push(entry)
    }
  }
  return { eligible, excluded, exclusionReasons }
}

// ---------------------------------------------------------------------------
// Local relevance ranking
// ---------------------------------------------------------------------------

export interface RelevanceContext {
  /** Favourite genres + pace from taste.ts (local use only). */
  favouriteGenres: string[]
  pace?: string
  /** Previously recommended + selected titles (weak tiebreak only). */
  selectedRecommendations?: Record<string, number>
  watchedKeys?: Set<string>
  nowMs?: number
}

export interface RelevanceScore {
  score: number
  reasons: string[]
  components: Record<string, number>
}

// Scoring weights. Query relevance dominates by construction: the
// query terms sum to ~100+ while taste is <= 10 and rating <= 5.
const W_GENRE_GROUP = 25
const W_GENRE_GROUP_CAP = 50
const W_SOFT_GENRE = 10
const W_ANIME_DEMONSTRATED = 30
const W_ANIME_ANIMATION_ONLY = 8
const W_KIND = 10
const W_TONE = 18
const W_TONE_CAP = 36
const W_TITLE_TOKEN = 20
const W_TITLE_START = 10
const W_PERSON_TOKEN = 8
const W_TITLE_TOKEN_CAP = 60
const W_OVERVIEW_TOKEN = 2
const W_OVERVIEW_CAP = 20
const W_REFERENCE_TITLE = 25
const W_RUNTIME_FIT = 5
const W_YEAR_FIT = 5
const W_TASTE_GENRE = 4
const W_TASTE_GENRE_CAP = 8
const W_TASTE_PACE = 3
const W_RATING_MAX = 5
const W_NOVELTY = 2
const W_SELECTED_BEFORE = 2
const W_ABANDONED_PENALTY = -10

function referenceSeedGenres(
  intent: QueryIntent,
  index: Array<IndexedCandidate<RetrievableCandidate>>
): Set<string> {
  const seeds = new Set<string>()
  for (const ref of intent.referenceTitles) {
    const refNorm = normalize(ref)
    if (!refNorm) continue
    const match = index.find(
      (entry) =>
        entry.titleNorm === refNorm || entry.titleNorm.includes(refNorm)
    )
    if (match) for (const g of match.genreSet) seeds.add(g)
  }
  return seeds
}

/**
 * Local relevance of one eligible candidate for the parsed intent.
 * Deterministic: same inputs, same score. Rating contributes at most
 * 5 points and only when votes back it (confidenceScore) — a 9.8
 * nobody voted for cannot outrank a 7.0 that matches the query.
 */
export function scoreRelevance(
  entry: IndexedCandidate<RetrievableCandidate>,
  intent: QueryIntent,
  ctx: RelevanceContext,
  seedGenres: Set<string> = new Set()
): RelevanceScore {
  const components: Record<string, number> = {}
  const reasons: string[] = []
  const add = (key: string, points: number, reason?: string) => {
    if (points === 0) return
    components[key] = (components[key] ?? 0) + points
    if (reason) reasons.push(reason)
  }

  // (1) Query intent match — genre groups (hard requirements, already
  // filtered, so a match here is a demonstrated match, worth most).
  if (intent.genreGroups.length > 0) {
    let matched = 0
    for (const group of intent.genreGroups) {
      if (group.some((g) => entry.genreSet.has(g))) matched++
    }
    if (matched > 0) {
      add(
        "genre",
        Math.min(W_GENRE_GROUP_CAP, matched * W_GENRE_GROUP),
        `Matches ${intent.genres.slice(0, 2).join(" / ")}`
      )
    }
  } else if (intent.softGenres.length > 0) {
    if (intent.softGenres.some((g) => entry.genreSet.has(g))) {
      add("genre", W_SOFT_GENRE, `Fits the ${intent.moods[0] ?? intent.tones[0] ?? "requested"} mood`)
    }
  }

  // Anime is a core constraint: demonstrated anime outranks everything
  // else in the pool; animation-only is a weak maybe.
  if (intent.anime === "required") {
    if (entry.anime === "anime") add("anime", W_ANIME_DEMONSTRATED, "Anime")
    else if (entry.anime === "animation") add("anime", W_ANIME_ANIMATION_ONLY, "Animated — anime unconfirmed")
  }

  // (2) Content kind, when the query states one.
  if (intent.contentKind && entry.candidate.kind === intent.contentKind) {
    add("kind", W_KIND)
  }

  // (3) Synopsis / theme similarity + (4) mood / tone compatibility.
  let tonePoints = 0
  for (const tone of intent.tones) {
    const toneGenres = TONE_GENRES[tone] ?? []
    const toneKeywords = TONE_KEYWORDS[tone] ?? []
    const genreHit = toneGenres.some((g) => entry.genreSet.has(g))
    const keywordHit = toneKeywords.some((kw) => entry.overviewTokens.has(kw))
    if (genreHit || keywordHit) {
      tonePoints += W_TONE
      reasons.push(`${tone[0].toUpperCase()}${tone.slice(1)} tone`)
    }
  }
  if (tonePoints > 0) {
    add("tone", Math.min(W_TONE_CAP, tonePoints))
  }

  // Title / cast / director tokens — partial credit per token (the old
  // text match was all-or-nothing, which is how a near-miss could beat
  // a real match). Title hits outrank cast/director hits.
  if (intent.titleTokens.length > 0) {
    let tokenPoints = 0
    for (const token of intent.titleTokens) {
      const inTitle = entry.titleNorm.includes(token)
      if (inTitle) {
        tokenPoints += W_TITLE_TOKEN
        if (entry.titleNorm.startsWith(token)) tokenPoints += W_TITLE_START
      } else if (
        entry.castNorm.includes(token) ||
        entry.directorNorm.includes(token) ||
        entry.genreSet.has(token)
      ) {
        tokenPoints += W_PERSON_TOKEN
      }
    }
    if (tokenPoints > 0) {
      add("title", Math.min(W_TITLE_TOKEN_CAP, tokenPoints), `Matches “${intent.titleTokens.join(" ")}”`)
    }
  }

  // Overview token overlap with the query's content words.
  if (intent.titleTokens.length > 0 || intent.tones.length > 0) {
    const queryWords = new Set([
      ...intent.titleTokens,
      ...intent.tones.flatMap((t) => TONE_KEYWORDS[t] ?? []),
    ])
    let overlap = 0
    for (const word of queryWords) {
      if (entry.overviewTokens.has(word)) overlap++
    }
    if (overlap > 0) {
      add("overview", Math.min(W_OVERVIEW_CAP, overlap * W_OVERVIEW_TOKEN))
    }
  }

  // Reference titles: a catalogue match for the named title seeds its
  // genres; candidates sharing those genres (or the title words) rank up.
  if (intent.referenceTitles.length > 0) {
    let refPoints = 0
    for (const ref of intent.referenceTitles) {
      const refTokens = tokensOf(` ${normalize(ref)} `)
      const shared = refTokens.filter((t) => entry.titleTokens.includes(t)).length
      if (refTokens.length > 0 && shared === refTokens.length) {
        refPoints += W_REFERENCE_TITLE
      } else if (shared > 0) {
        refPoints += Math.round((shared / refTokens.length) * W_REFERENCE_TITLE)
      }
    }
    if (seedGenres.size > 0) {
      const sharedSeed = [...seedGenres].some((g) => entry.genreSet.has(g))
      if (sharedSeed) refPoints += 15
    }
    if (refPoints > 0) add("reference", refPoints, `Like ${intent.referenceTitles[0]}`)
  }

  // (5) Runtime / year fit (bounds already enforced; fit is a bonus,
  // unknown metadata earns nothing — never a guess).
  if (intent.maxRuntimeMinutes !== undefined || intent.minRuntimeMinutes !== undefined) {
    if (entry.runtimeMinutes !== undefined) add("runtime", W_RUNTIME_FIT)
  }
  if (intent.minYear !== undefined || intent.maxYear !== undefined) {
    if (entry.year !== undefined) add("year", W_YEAR_FIT)
  }

  // (6) Opt-in user taste — deliberately small: taste must never
  // outrank the query itself.
  const favGenres = new Set((ctx.favouriteGenres ?? []).map((g) => normalize(g)))
  let tasteGenrePoints = 0
  for (const genre of entry.genreSet) {
    if (favGenres.has(genre)) tasteGenrePoints += W_TASTE_GENRE
  }
  if (tasteGenrePoints > 0) {
    add("taste", Math.min(W_TASTE_GENRE_CAP, tasteGenrePoints), "Matches your taste")
  }
  if (
    ctx.pace &&
    ((ctx.pace === "intense" && intent.tones.includes("intense")) ||
      (ctx.pace === "light" && (intent.tones.includes("light") || intent.tones.includes("funny"))))
  ) {
    add("taste-pace", W_TASTE_PACE)
  }

  // (7) Rating confidence + (8) popularity/quality evidence — capped
  // small, and only with real votes behind the rating.
  if (
    typeof entry.rating === "number" &&
    Number.isFinite(entry.rating) &&
    entry.rating > 0 &&
    entry.votes >= 1
  ) {
    const confidence = confidenceScore(entry.rating, entry.votes)
    if (Number.isFinite(confidence)) {
      add("rating", Math.min(W_RATING_MAX, (confidence / 10) * W_RATING_MAX))
    }
  }

  // (9) Diversity / novelty: unwatched earns a nudge; a title the
  // user previously picked from recommendations earns a tiny one.
  // Neither is a like — opening a title never counts as liking it.
  if (ctx.watchedKeys && !ctx.watchedKeys.has(entry.key)) {
    add("novelty", W_NOVELTY)
  }
  if (ctx.selectedRecommendations?.[entry.key]) {
    add("selected-before", W_SELECTED_BEFORE)
  }

  // Weak abandoned signal: stopped early once. A penalty, not an
  // exclusion — a rewatch is still possible.
  // (The taste model marks these at weight 0.5; scoreOne in discover.ts
  // applies the same -15 for rails. Retrieval keeps it small so the
  // query still dominates.)
  // Note: dislikedTitles is consulted by the caller through the taste
  // model; this term is applied when the caller passes the model via
  // ctx — see retrieveCandidates, which folds it in below.

  const score = Object.values(components).reduce((sum, p) => sum + p, 0)
  return { score, reasons, components }
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

export interface RetrievalScored<T extends RetrievableCandidate> {
  candidate: T
  /** Local relevance score (query dominates; see scoreRelevance). */
  relevanceScore: number
  reasons: string[]
  components: Record<string, number>
}

export interface RetrievalResult<T extends RetrievableCandidate> {
  intent: QueryIntent
  /** ALL eligible candidates, best relevance first. */
  ranked: Array<RetrievalScored<T>>
  /** Cost-bounded shortlist for the AI reranker: top of `ranked`,
   * at most RETRIEVAL_SHORTLIST_MAX, one title-group each. */
  shortlist: T[]
  shortlistScored: Array<RetrievalScored<T>>
  eligibleCount: number
  excludedCount: number
  exclusionReasons: Record<string, number>
  /** Set when hard filtering emptied the pool: what was asked for. */
  emptyReason?: string
}

export interface RetrieveOptions extends HardFilterOptions {
  /** Shortlist cap (default RETRIEVAL_SHORTLIST_MAX). */
  limit?: number
  nowMs?: number
}

/**
 * The retrieval pipeline: parse -> index -> hard-filter -> relevance-rank
 * -> shortlist. Pure and local: no network, no model calls, no remote
 * metadata fetches. The shortlist is what W2's reranker receives — the
 * ranker never sees catalogue order, only relevance order.
 */
/**
 * Honest "nothing matches" text for a parsed intent (0.11.5): what was
 * asked for, in the user's terms. The UI's broaden hook — it says what
 * to broaden (anime, a genre, films/series, a year bound, a runtime
 * cap), never a bare "no results". Shared by retrieveCandidates'
 * emptyReason and by rankDiscover's no-demonstrated-match fallback.
 */
export function describeNoMatch(intent: QueryIntent): string {
  const parts: string[] = []
  if (intent.anime === "required") parts.push("anime")
  if (intent.genres.length) parts.push(intent.genres.join(" / "))
  if (intent.contentKind) parts.push(intent.contentKind === "movie" ? "films" : "series")
  if (intent.minYear !== undefined) parts.push(`after ${intent.minYear - 1}`)
  if (intent.maxYear !== undefined) parts.push(`before ${intent.maxYear + 1}`)
  if (intent.maxRuntimeMinutes !== undefined) {
    parts.push(`under ${intent.maxRuntimeMinutes} min`)
  }
  return parts.length > 0
    ? `No titles in your library match this request (${parts.join(", ")}).`
    : "No titles in your library match this request."
}

/**
 * True when at least one scored entry DEMONSTRATES the query's hard
 * constraints — with metadata, not as an unknown. A genre-less row is
 * kept by retrieval as "unknown" (it might be a match), but it never
 * demonstrates one: for anime, only a demonstrated anime title counts
 * (plain Animation is unconfirmed, never claimed as anime); for a
 * genre question, only a title carrying the required genre; for a kind
 * question, only a title of that kind. Soft queries (tones, moods,
 * title tokens, "something for tonight") state no hard constraint, so
 * they always count as demonstrated — the local engine may answer
 * them with its best picks. rankDiscover's fallback uses this: when
 * the model was asked, kept nothing, AND nothing demonstrates the
 * hard constraint, the honest answer is an empty rail with the
 * no-match text — never a genre-less unknown presented as a match.
 */
export function hasDemonstratedHardMatch(
  intent: QueryIntent,
  scored: Array<RetrievalScored<RetrievableCandidate>>
): boolean {
  const needsAnime = intent.anime === "required"
  const needsGenres = intent.genreGroups.length > 0
  const needsKind = intent.contentKind !== undefined
  if (!needsAnime && !needsGenres && !needsKind) return true
  return scored.some((entry) => {
    if (needsAnime && entry.components.anime !== W_ANIME_DEMONSTRATED) return false
    if (needsGenres && !(entry.components.genre > 0)) return false
    if (needsKind && !(entry.components.kind > 0)) return false
    return true
  })
}

export function retrieveCandidates<T extends RetrievableCandidate>(
  query: string,
  candidates: T[],
  taste: TasteModel | null,
  opts: RetrieveOptions = {}
): RetrievalResult<T> {
  const intent = parseIntent(query)
  const index = buildCatalogueIndex(candidates)
  const seedGenres = referenceSeedGenres(intent, index)
  const filtered = applyHardFilters(intent, index, taste, opts)

  const summary = taste ? summarizeTaste(taste) : { favouriteGenres: [], likedTitles: [], dislikedTitles: [] }
  const ctx: RelevanceContext = {
    favouriteGenres: summary.favouriteGenres ?? [],
    pace: summary.pace,
    selectedRecommendations: taste?.selectedRecommendations,
    watchedKeys: opts.watchedKeys,
    nowMs: opts.nowMs,
  }

  const ranked: Array<RetrievalScored<T>> = filtered.eligible.map((entry) => {
    const scored = scoreRelevance(entry, intent, ctx, seedGenres)
    // Weak abandoned signal (weight < 1): small penalty, applied here
    // so the query still dominates the final order.
    const weakDislike = taste?.dislikedTitles.find(
      (ref) => `${ref.kind}:${ref.id}` === entry.key && ref.weight < 1
    )
    let relevanceScore = scored.score
    const components = { ...scored.components }
    const reasons = [...scored.reasons]
    if (weakDislike) {
      components["abandoned"] = W_ABANDONED_PENALTY
      relevanceScore += W_ABANDONED_PENALTY
      reasons.push("You stopped this one early before")
    }
    return {
      candidate: entry.candidate,
      relevanceScore,
      reasons,
      components,
    }
  })

  ranked.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore
    const aConf = confidenceScore(a.candidate.rating ?? null, votesFor(a.candidate))
    const bConf = confidenceScore(b.candidate.rating ?? null, votesFor(b.candidate))
    if (bConf !== aConf) return bConf - aConf
    return a.candidate.title.localeCompare(b.candidate.title)
  })

  // Shortlist: relevance order, one title-group each, then fill any
  // leftover slots from deferred entries (a repeat title-group never
  // re-enters — language variants of one title stay out).
  const limit = opts.limit ?? RETRIEVAL_SHORTLIST_MAX
  const groupCounts = new Map<string, number>()
  const shortlistScored: Array<RetrievalScored<T>> = []
  const deferred: Array<RetrievalScored<T>> = []
  for (const item of ranked) {
    const group = titleGroupKeyOf(item.candidate)
    if ((groupCounts.get(group) ?? 0) >= RETRIEVAL_SHORTLIST_PER_GROUP) {
      deferred.push(item)
      continue
    }
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1)
    shortlistScored.push(item)
    if (shortlistScored.length >= limit) break
  }
  for (const item of deferred) {
    if (shortlistScored.length >= limit) break
    const group = titleGroupKeyOf(item.candidate)
    if ((groupCounts.get(group) ?? 0) >= RETRIEVAL_SHORTLIST_PER_GROUP) continue
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1)
    shortlistScored.push(item)
  }

  let emptyReason: string | undefined
  if (filtered.eligible.length === 0 && candidates.length > 0) {
    emptyReason = describeNoMatch(intent)
  }

  return {
    intent,
    ranked,
    shortlist: shortlistScored.map((item) => item.candidate),
    shortlistScored,
    eligibleCount: filtered.eligible.length,
    excludedCount: filtered.excluded.length,
    exclusionReasons: filtered.exclusionReasons,
    emptyReason,
  }
}
