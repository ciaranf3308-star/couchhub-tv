// RedSilk — C1 shared content taxonomy (0.10.0, W4).
//
// One canonical answer to "what kind of thing is this title?" used by
// Home, Movies, Series and Discover so a title is never a "Movie" on
// one screen and a "Series" on another.
//
// Rules (see 0.10.0 worker contracts, C1):
// - Classify from the provider type/category plus documentary signals
//   in genre/tags. Genres are ATTRIBUTES, never the kind: a crime
//   documentary is a documentary, not a crime drama — only the
//   documentary signal itself changes the kind, and it only picks
//   between Documentary Film and Documentary Series.
// - Never modify provider data; this module only reads the item.
// - Provider identifiers are preserved: classification returns a kind
//   string only, the caller's item (and its id) is untouched.
//
// Pure and deterministic: no storage, no network, no DOM.

export type ContentKind =
  | "movie"
  | "series"
  | "documentary-film"
  | "documentary-series"
  | "live"

/** Everything classifyTitle reads. Extra provider fields are ignored. */
export interface ClassifiableTitle {
  /** Provider type: 'movie' | 'vod' | 'series' | 'live' | ... */
  type?: string
  /** Some rows carry the kind under `kind` instead of `type`. */
  kind?: string
  /** Provider category name, e.g. "EN | Movies", "Documentary", "TV Shows". */
  category?: string
  /** Single genre string, when the row carries one. */
  genre?: string
  /** Genre list (TMDb / provider genres). Attributes only. */
  genres?: string[]
  /** Free-form tags, when the row carries any. */
  tags?: string[]
  /** Title — accepted for interface compatibility, NEVER used to classify. */
  title?: string
}

const KIND_LABELS: Record<ContentKind, string> = {
  movie: "Movie",
  series: "Series",
  "documentary-film": "Documentary Film",
  "documentary-series": "Documentary Series",
  live: "Live TV",
}

/** Display label for a kind — the only kind strings any screen shows. */
export function kindLabel(kind: ContentKind): string {
  return KIND_LABELS[kind] ?? "Movie"
}

/** True for the two documentary kinds. */
export function isDocumentaryKind(kind: ContentKind): boolean {
  return kind === "documentary-film" || kind === "documentary-series"
}

/** Lower-cased word tokens of a value ("TV Shows" -> ["tv", "shows"]). */
function tokens(value: string | undefined | null): string[] {
  if (!value) return []
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function allTokens(item: ClassifiableTitle): string[] {
  const out: string[] = []
  for (const field of [item.type, item.kind, item.category, item.genre]) {
    out.push(...tokens(field))
  }
  for (const genre of item.genres ?? []) out.push(...tokens(genre))
  for (const tag of item.tags ?? []) out.push(...tokens(tag))
  return out
}

function joined(item: ClassifiableTitle): string {
  return [
    item.type,
    item.kind,
    item.category,
    item.genre,
    ...(item.genres ?? []),
    ...(item.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

const SERIES_TOKENS = new Set([
  "series",
  "show",
  "shows",
  "episode",
  "episodes",
  "season",
  "seasons",
  "television",
  "tv",
])
const MOVIE_TOKENS = new Set(["movie", "movies", "film", "films", "vod", "feature"])

/**
 * Classify one catalogue title.
 *
 * Precedence:
 *  1. Live — an explicit live/channel type is Live TV, whatever else
 *     the row says (a documentary channel is still Live TV).
 *  2. Documentary — a documentary signal (the word "documentary" /
 *     "docuseries" / "docu-series" in type, category, genre or tags)
 *     makes the kind a documentary; the film/series split then comes
 *     from the base type (series tokens -> Documentary Series, movie
 *     tokens or nothing -> Documentary Film). Every other genre
 *     (crime, drama, ...) is ignored for the kind.
 *  3. Base type — series tokens -> Series, movie tokens -> Movie.
 *  4. Unknown -> Movie (the catalogue default for VOD rows; series
 *     rows always carry a series marker in practice).
 */
export function classifyTitle(item: ClassifiableTitle): ContentKind {
  const text = joined(item)
  const toks = new Set(allTokens(item))

  // 1. Live TV.
  const typeText = `${item.type ?? ""} ${item.kind ?? ""}`.trim().toLowerCase()
  if (
    typeText === "live" ||
    typeText === "livetv" ||
    typeText === "live tv" ||
    typeText === "channel" ||
    toks.has("livetv") ||
    text.includes("live tv")
  ) {
    return "live"
  }
  // A bare "live" token only counts from the type field — a VOD
  // category named e.g. "Live Concerts" is not Live TV.
  if (tokens(item.type).includes("live") || tokens(item.kind).includes("live")) {
    return "live"
  }

  // 2. Documentary signal — the ONLY genre/tag that changes the kind.
  const isDoc =
    text.includes("documentar") ||
    text.includes("docuseries") ||
    text.includes("docu-series") ||
    text.includes("docu series") ||
    toks.has("documentaries")
  const isSeries = [...toks].some((t) => SERIES_TOKENS.has(t))
  const isMovie = [...toks].some((t) => MOVIE_TOKENS.has(t))

  if (isDoc) {
    // An explicit docuseries phrase is series-shaped even without a
    // separate series token.
    if (
      isSeries ||
      text.includes("docuseries") ||
      text.includes("docu-series") ||
      text.includes("docu series")
    ) {
      return "documentary-series"
    }
    return "documentary-film"
  }

  // 3. Base type. Series wins over movie when both appear (a series
  // row whose category mentions "Movies" is still a series).
  if (isSeries) return "series"
  if (isMovie) return "movie"

  // 4. Unknown — catalogue default.
  return "movie"
}
