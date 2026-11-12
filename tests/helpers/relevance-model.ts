// Relevance-model mock: a faithful stand-in for a real LLM behind
// `chatCompletions`, for the AI-Discovery regression suite.
//
// It behaves the way a real model behaves in the ways that matter
// for these tests, and ONLY in those ways:
//
//   - It can ONLY rank the candidate IDs the production code puts
//     in its prompt. If the prompt contains just the first 20
//     catalogue entries, the "model" can only return those — it
//     cannot rescue titles it was never shown. That is exactly how
//     the production failure happened, and why T1 fails on base.
//   - It ranks by query relevance, using the same vocabulary a
//     model would: intent words in the query ("anime", "dark",
//     "comedy", "war", "romance", "sci-fi") matched against each
//     candidate's title / genres / overview, plus a boost for the
//     favourite genres in the taste summary when taste sharing is
//     on (the prompt carries them; the mock reads them like a model
//     would). It never sees the catalogue — only the prompt.
//   - It always returns a ranking of everything it was given
//     (best first), like a model asked to "rank the candidates".
//     It never invents IDs and never drops a candidate it was
//     shown. ID-validation failures are therefore production
//     failures, never mock artefacts.
//
// It is NOT a second recommendation engine: it contains no
// retrieval, no catalogue access, no hard filtering and no caching.
// The prompt is its whole world — which is the point.

export interface ParsedPromptCandidate {
  /** Bracket contents verbatim: "c1" on base, "movie:123" once the
   * composite-ID fix lands — the mock never normalises this. */
  id: string
  title: string
  kind: string
  genres: string[]
  overview: string
}

export interface ParsedPrompt {
  query: string
  favouriteGenres: string[]
  candidates: ParsedPromptCandidate[]
}

const CANDIDATE_LINE = /^\s*\d+\.\s+\[([^\]]+)\]\s+(.*)$/

/** Parse one candidate line of the ranker prompt. Tolerant by
 * design: a line it cannot parse scores 0 rather than crashing. */
export function parsePromptCandidate(line: string): ParsedPromptCandidate | null {
  const match = CANDIDATE_LINE.exec(line)
  if (!match) return null
  const id = match[1]
  const rest = match[2] ?? ""
  const kindMatch = /·\s*(movie|series|live)\b/.exec(rest)
  const kind = kindMatch?.[1] ?? "movie"
  const titlePart = rest.split("·")[0]?.trim() ?? ""
  const title = titlePart.replace(/\s*\(\d{4}\)\s*$/, "").trim()
  const overviewSplit = rest.split(" — ")
  const overview = overviewSplit.length > 1 ? (overviewSplit[overviewSplit.length - 1] ?? "") : ""
  // Genres are the "·"-segment after the kind that is neither a
  // star rating nor a runtime ("12 min").
  const segments = rest.split("·").map((s) => s.trim())
  let genres: string[] = []
  for (const segment of segments.slice(1)) {
    const clean = segment.split(" — ")[0]?.trim() ?? ""
    if (!clean || clean.startsWith("★") || /^\d+\s*min$/.test(clean)) continue
    if (/^(movie|series|live)$/.test(clean)) continue
    genres = clean.split(",").map((g) => g.trim()).filter(Boolean)
    break
  }
  return { id, title, kind, genres, overview }
}

export function parsePrompt(userText: string): ParsedPrompt {
  const lines = userText.split("\n")
  let query = ""
  let favouriteGenres: string[] = []
  const candidates: ParsedPromptCandidate[] = []
  for (const line of lines) {
    if (line.startsWith("Search: ")) query = line.slice("Search: ".length).trim()
    if (line.startsWith("Favourite genres: ")) {
      const raw = line.slice("Favourite genres: ".length).trim()
      favouriteGenres =
        raw && raw !== "none stated"
          ? raw.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean)
          : []
    }
    const parsed = parsePromptCandidate(line)
    if (parsed) candidates.push(parsed)
  }
  return { query, favouriteGenres, candidates }
}

/** Relevance of one prompted candidate to the query, per the intent
 * vocabulary above. Deterministic; ties keep prompt order. */
export function relevanceScore(
  candidate: ParsedPromptCandidate,
  query: string,
  favouriteGenres: string[],
): number {
  const q = query.toLowerCase()
  const genresLower = candidate.genres.map((g) => g.toLowerCase())
  const text = `${candidate.title} ${candidate.genres.join(" ")} ${candidate.overview}`.toLowerCase()
  const overviewLower = candidate.overview.toLowerCase()
  let score = 0
  if (/anime/.test(q) && /anime|animation/.test(text)) score += 3
  if (/dark|fucked|disturbing|twisted|grim|bleak|violent|gore/.test(q)) {
    if (
      genresLower.some((g) => ["horror", "thriller", "crime", "mystery", "war"].includes(g)) ||
      /dark|disturbing|grim|bleak|violent|bloody|twisted/.test(overviewLower)
    ) {
      score += 1
    }
  }
  if (/comedy|funny|humou?r/.test(q) && (/comedy/.test(text) || /funny/.test(overviewLower))) score += 3
  if (/light-hearted|lighthearted|feel-good|feelgood/.test(q)) {
    if (genresLower.some((g) => ["comedy", "romance", "family"].includes(g))) score += 1
  }
  if (/war|historical|history/.test(q) && /war|history|historical/.test(text)) score += 3
  if (/romance|romantic|love/.test(q) && /romance/.test(text)) score += 3
  if (/sci-?fi|science[- ]fiction/.test(q) && /sci-?fi|science fiction/.test(text)) score += 3
  if (/series|show|season/.test(q) && candidate.kind === "series") score += 1
  for (const genre of favouriteGenres) {
    if (genresLower.includes(genre)) score += 1
  }
  return score
}

/**
 * Rank every candidate in the prompt by query relevance, best
 * first, ties in prompt order — the model's reply. Returns the
 * `{ text, model }` shape of `chatCompletions`.
 */
export function relevanceModelReply(messages: Array<{ role: string; content: string }>): {
  text: string
  model: string
} {
  const user = messages.find((m) => m.role === "user")?.content ?? ""
  const parsed = parsePrompt(user)
  const scored = parsed.candidates.map((candidate, index) => ({
    candidate,
    index,
    score: relevanceScore(candidate, parsed.query, parsed.favouriteGenres),
  }))
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  const intentGenres: string[] = []
  if (/anime/.test(parsed.query.toLowerCase())) intentGenres.push("Animation")
  if (/comedy/.test(parsed.query.toLowerCase())) intentGenres.push("Comedy")
  if (/war|historical/.test(parsed.query.toLowerCase())) intentGenres.push("War")
  if (/romance/.test(parsed.query.toLowerCase())) intentGenres.push("Romance")
  if (/sci-?fi|science[- ]fiction/.test(parsed.query.toLowerCase())) intentGenres.push("Sci-Fi")
  const rankings = scored.map(({ candidate, score }) => ({
    id: candidate.id,
    reason:
      score >= 3
        ? `Strong match for this search (${candidate.title}).`
        : score >= 1
          ? `Loosely related to this search (${candidate.title}).`
          : `Included for completeness (${candidate.title}).`,
  }))
  return {
    text: JSON.stringify({
      intent: { genres: intentGenres, mood: "", pace: "", maxRuntimeMinutes: 0, exclude: [], referenceTitles: [] },
      rankings,
    }),
    model: "gpt-4o-mini",
  }
}

/** Candidate ids in the order they appear in a prompt's user text. */
export function promptCandidateIds(userText: string): string[] {
  return parsePrompt(userText).candidates.map((c) => c.id)
}

/** Jaccard similarity between two id sets (1 = identical pools). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const union = new Set([...a, ...b])
  if (!union.size) return 1
  let intersection = 0
  for (const id of a) if (b.has(id)) intersection++
  return intersection / union.size
}
