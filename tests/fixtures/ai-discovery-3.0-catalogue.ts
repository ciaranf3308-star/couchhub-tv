// Deterministic AI Discovery 3.0 catalogue fixture (0.11.6, W5).
//
// Follows the 0.11.5 fixture style (tests/fixtures/ai-discovery-catalogue.ts):
// a punctuation-first block sits at the head of the catalogue so any code
// that slices the first N entries before relevance can only see irrelevant
// titles — and so substitution filler is visible the moment it appears in
// a result list. Unlike the 0.11.5 fixture (invented titles only), this
// fixture deliberately uses REAL film/series titles: mocks are not
// production recommendations, and Tests A–D/I assert identity matching
// against the exact titles the mocked model generates and the mocked
// TMDB search resolves. Title spellings here are the canonical mock
// spellings — the model fixture and the TMDB fixture use these exact
// strings, so a mismatch anywhere fails loudly instead of silently.
//
// Guarantees (asserted by tests/ai-discovery-3.0.test.ts):
//   - indices 0..9: punctuation-prefixed titles with no anime/comedy/
//     horror signal in title, genres, or overview.
//   - anime / comedy / horror entries sit beyond the punctuation block.
//   - "The Shawshank Redemption" and "Parasite" are ABSENT (Test C's
//     strong-but-unavailable titles). "The Glimmering Void" is absent
//     and unresolvable (Test H).
//   - same-name different-year pairs: Dune 1984/2021, The Thing
//     1982/2011, It series-1990/movie-2017 (the It pair ALSO shares
//     provider id "900" across kinds — composite-id disambiguation).
//   - quality-suffixed provider names: "Dune (2021) 1080p BluRay",
//     "Hereditary (2018) 2160p WEB-DL", "The Thing [1982] 720p BluRay",
//     "Get Out (2017) 1080p WEBRip".
//   - duplicate streams: two Hereditary (2018) entries, different ids.
//   - western-animation entries (The Simpsons, Family Guy, Rick and
//     Morty, Bob's Burgers) exist ONLY as substitution guards for Test D.
//   - ids are unique per (kind, id) pair; catalogue order is fixed.
//
// Deterministic: fully literal, no generation, no randomness.

import type { DiscoverCandidate } from "../../src/scripts/lib/discover"

function candidate(
  partial: Partial<DiscoverCandidate> & { id: string; title: string },
): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  }
}

// --- Punctuation-first block (indices 0..9): irrelevant by design ---

export const PUNCTUATION_TITLES_30 = [
  "'G' Men",
  ".com for Murder",
  ".raw",
  "'71",
  "...And Justice for All",
  "!Hero",
  "#Blackbird",
  "$9.99",
  "(Untitled)",
  "@Midnight",
] as const

const PUNCTUATION_ROWS: Array<{
  title: string
  genres: string[]
  year: number
  rating: number
}> = [
  { title: "'G' Men", genres: ["Crime", "Drama"], year: 1935, rating: 7.2 },
  { title: ".com for Murder", genres: ["Thriller", "Crime"], year: 2002, rating: 6.1 },
  { title: ".raw", genres: ["Drama"], year: 2018, rating: 5.8 },
  { title: "'71", genres: ["War", "Drama"], year: 2014, rating: 7.0 },
  { title: "...And Justice for All", genres: ["Drama", "Crime"], year: 1979, rating: 7.5 },
  { title: "!Hero", genres: ["Drama"], year: 2011, rating: 6.2 },
  { title: "#Blackbird", genres: ["Thriller"], year: 2019, rating: 5.9 },
  { title: "$9.99", genres: ["Drama"], year: 2008, rating: 6.8 },
  { title: "(Untitled)", genres: ["Mystery"], year: 2021, rating: 5.5 },
  { title: "@Midnight", genres: ["Mystery"], year: 2020, rating: 5.4 },
]

function punctuationBlock(): DiscoverCandidate[] {
  return PUNCTUATION_ROWS.map((row, index) =>
    candidate({
      id: `p30-${index}`,
      title: row.title,
      year: row.year,
      rating: row.rating,
      voteCount: 200 + index * 37,
      genres: row.genres,
      overview: `A ${row.genres[0].toLowerCase()} title from ${row.year}.`,
    }),
  )
}

// --- Dark anime (real titles; the mocked model generates these) ---

export const ATTACK_ON_TITAN = candidate({
  id: "anime-aot",
  kind: "series",
  title: "Attack on Titan",
  year: 2013,
  rating: 8.7,
  genres: ["Animation", "Drama", "Action"],
  overview: "Humanity fights for survival behind walled cities.",
})
export const DEATH_NOTE = candidate({
  id: "anime-death-note",
  kind: "series",
  title: "Death Note",
  year: 2006,
  rating: 8.5,
  genres: ["Animation", "Thriller", "Mystery"],
  overview: "A student gains a notebook that kills anyone whose name he writes.",
})
export const PERFECT_BLUE = candidate({
  id: "anime-perfect-blue",
  kind: "movie",
  title: "Perfect Blue",
  year: 1997,
  rating: 8.0,
  genres: ["Animation", "Thriller"],
  overview: "A pop idol's grip on reality unravels.",
})
export const BERSERK = candidate({
  id: "anime-berserk",
  kind: "series",
  title: "Berserk",
  year: 1997,
  rating: 8.4,
  genres: ["Animation", "Action", "Horror"],
  overview: "A lone swordsman battles demons in a bleak medieval world.",
})
export const ELFEN_LIED = candidate({
  id: "anime-elfen-lied",
  kind: "series",
  title: "Elfen Lied",
  year: 2004,
  rating: 7.9,
  genres: ["Animation", "Horror", "Drama"],
  overview: "An escaped mutant with telekinetic powers leaves a trail of violence.",
})
export const EVANGELION = candidate({
  id: "anime-evangelion",
  kind: "series",
  title: "Neon Genesis Evangelion",
  year: 1995,
  rating: 8.5,
  genres: ["Animation", "Drama", "Sci-Fi"],
  overview: "Teenagers pilot giant biomechs against alien Angels.",
})
export const MUGEN_TRAIN = candidate({
  id: "anime-mugen-train",
  kind: "movie",
  title: "Demon Slayer: Mugen Train",
  year: 2020,
  rating: 8.2,
  genres: ["Animation", "Action"],
  overview: "Demon slayers board a train haunted by a dream demon.",
})
export const JUJUTSU_KAISEN_0 = candidate({
  id: "anime-jujutsu-0",
  kind: "movie",
  title: "Jujutsu Kaisen 0",
  year: 2021,
  rating: 7.8,
  genres: ["Animation", "Action"],
  overview: "A cursed teenager enrolls in a school for sorcerers.",
})
export const REZE_ARC = candidate({
  id: "anime-reze-arc",
  kind: "movie",
  title: "Chainsaw Man: Reze Arc",
  year: 2025,
  rating: 8.0,
  genres: ["Animation", "Action", "Horror"],
  overview: "Denji falls for a mysterious girl with a deadly secret.",
})

export const ANIME_ENTRIES = [
  ATTACK_ON_TITAN,
  DEATH_NOTE,
  PERFECT_BLUE,
  BERSERK,
  ELFEN_LIED,
  EVANGELION,
  MUGEN_TRAIN,
  JUJUTSU_KAISEN_0,
  REZE_ARC,
]

// --- Western animation: substitution guards for Test D only ---

export const WESTERN_ANIMATION_TITLES = [
  "The Simpsons",
  "Family Guy",
  "Rick and Morty",
  "Bob's Burgers",
] as const

const WESTERN_ANIMATION_ENTRIES = [
  candidate({
    id: "west-simpsons",
    kind: "series",
    title: "The Simpsons",
    year: 1989,
    rating: 8.0,
    genres: ["Animation", "Comedy"],
  }),
  candidate({
    id: "west-family-guy",
    kind: "series",
    title: "Family Guy",
    year: 1999,
    rating: 7.5,
    genres: ["Animation", "Comedy"],
  }),
  candidate({
    id: "west-rick-morty",
    kind: "series",
    title: "Rick and Morty",
    year: 2013,
    rating: 8.8,
    genres: ["Animation", "Comedy", "Sci-Fi"],
  }),
  candidate({
    id: "west-bobs-burgers",
    kind: "series",
    title: "Bob's Burgers",
    year: 2011,
    rating: 7.9,
    genres: ["Animation", "Comedy"],
  }),
]

// --- Comedies ---

export const SUPERBAD = candidate({
  id: "com-superbad",
  kind: "movie",
  title: "Superbad",
  year: 2007,
  rating: 7.6,
  genres: ["Comedy"],
})
export const HOT_FUZZ = candidate({
  id: "com-hot-fuzz",
  kind: "movie",
  title: "Hot Fuzz",
  year: 2007,
  rating: 7.8,
  genres: ["Comedy", "Action"],
})
export const STEP_BROTHERS = candidate({
  id: "com-step-brothers",
  kind: "movie",
  title: "Step Brothers",
  year: 2008,
  rating: 6.9,
  genres: ["Comedy"],
})
export const BRIDESMAIDS = candidate({
  id: "com-bridesmaids",
  kind: "movie",
  title: "Bridesmaids",
  year: 2011,
  rating: 6.8,
  genres: ["Comedy", "Romance"],
})
export const GRAND_BUDAPEST = candidate({
  id: "com-grand-budapest",
  kind: "movie",
  title: "The Grand Budapest Hotel",
  year: 2014,
  rating: 8.0,
  genres: ["Comedy", "Drama"],
})

export const COMEDY_ENTRIES = [SUPERBAD, HOT_FUZZ, STEP_BROTHERS, BRIDESMAIDS, GRAND_BUDAPEST]

// --- Horrors (incl. duplicate Hereditary streams + suffix variants) ---

export const HEREDITARY_A = candidate({
  id: "hor-hereditary-a",
  kind: "movie",
  title: "Hereditary",
  year: 2018,
  rating: 7.3,
  genres: ["Horror", "Drama"],
})
export const HEREDITARY_B = candidate({
  id: "hor-hereditary-b",
  kind: "movie",
  title: "Hereditary (2018) 2160p WEB-DL",
  year: 2018,
  rating: 7.3,
  genres: ["Horror", "Drama"],
})
export const GET_OUT = candidate({
  id: "hor-get-out",
  kind: "movie",
  title: "Get Out (2017) 1080p WEBRip",
  year: 2017,
  rating: 7.7,
  genres: ["Horror", "Thriller"],
})
export const THING_1982 = candidate({
  id: "hor-thing-1982",
  kind: "movie",
  title: "The Thing [1982] 720p BluRay",
  year: 1982,
  rating: 8.2,
  genres: ["Horror", "Sci-Fi"],
})
export const THING_2011 = candidate({
  id: "hor-thing-2011",
  kind: "movie",
  title: "The Thing",
  year: 2011,
  rating: 6.2,
  genres: ["Horror", "Sci-Fi"],
})
export const IT_FOLLOWS = candidate({
  id: "hor-it-follows",
  kind: "movie",
  title: "It Follows",
  year: 2014,
  rating: 6.8,
  genres: ["Horror", "Thriller"],
})
export const BABADOOK = candidate({
  id: "hor-babadook",
  kind: "movie",
  title: "The Babadook",
  year: 2014,
  rating: 6.8,
  genres: ["Horror", "Drama"],
})

export const HORROR_ENTRIES = [
  HEREDITARY_A,
  HEREDITARY_B,
  GET_OUT,
  THING_1982,
  THING_2011,
  IT_FOLLOWS,
  BABADOOK,
]

// --- Same-name different-year pairs ---

export const DUNE_1984 = candidate({
  id: "pair-dune-1984",
  kind: "movie",
  title: "Dune",
  year: 1984,
  rating: 6.3,
  genres: ["Sci-Fi", "Adventure"],
})
export const DUNE_2021 = candidate({
  id: "pair-dune-2021",
  kind: "movie",
  title: "Dune (2021) 1080p BluRay",
  year: 2021,
  rating: 8.0,
  genres: ["Sci-Fi", "Adventure"],
})
/** Composite-id pair: same provider id "900", both kinds. */
export const IT_SERIES_1990 = candidate({
  id: "900",
  kind: "series",
  title: "It",
  year: 1990,
  rating: 6.8,
  genres: ["Horror", "Drama"],
})
export const IT_MOVIE_2017 = candidate({
  id: "900",
  kind: "movie",
  title: "It",
  year: 2017,
  rating: 7.3,
  genres: ["Horror"],
})

export const SAME_NAME_ENTRIES = [DUNE_1984, DUNE_2021, IT_SERIES_1990, IT_MOVIE_2017]

// --- Year-correction target ---

export const BLADE_RUNNER_2049 = candidate({
  id: "yc-blade-runner-2049",
  kind: "movie",
  title: "Blade Runner 2049",
  year: 2017,
  rating: 8.0,
  genres: ["Sci-Fi", "Drama"],
})

// --- Catalogue-only famous titles (substitution guards) ---

const CATALOGUE_ONLY_ENTRIES = [
  candidate({
    id: "only-casablanca",
    kind: "movie",
    title: "Casablanca",
    year: 1942,
    rating: 8.5,
    genres: ["Drama", "Romance"],
  }),
  candidate({
    id: "only-godfather",
    kind: "movie",
    title: "The Godfather",
    year: 1972,
    rating: 9.2,
    genres: ["Crime", "Drama"],
  }),
]

// --- Assembled catalogues ---

/** Full 3.0 catalogue: punctuation block first, intent groups after. */
export const AI30_CATALOGUE: DiscoverCandidate[] = [
  ...punctuationBlock(),
  ...ANIME_ENTRIES,
  ...WESTERN_ANIMATION_ENTRIES,
  ...COMEDY_ENTRIES,
  ...HORROR_ENTRIES,
  ...SAME_NAME_ENTRIES,
  BLADE_RUNNER_2049,
  ...CATALOGUE_ONLY_ENTRIES,
]

const ANIME_TITLES = new Set(ANIME_ENTRIES.map((entry) => entry.title))

/** Full catalogue with every anime entry removed (Test A). */
export const NO_ANIME_CATALOGUE: DiscoverCandidate[] = AI30_CATALOGUE.filter(
  (entry) => !ANIME_TITLES.has(entry.title),
)

/** Comedy + horror entries only, no punctuation block (Test E adapter checks). */
export const GENRE_FILTER_CATALOGUE: DiscoverCandidate[] = [...COMEDY_ENTRIES, ...HORROR_ENTRIES]

export function catalogueIndexOf(id: string, kind?: string): number {
  return AI30_CATALOGUE.findIndex(
    (entry) => entry.id === id && (kind == null || entry.kind === kind),
  )
}
