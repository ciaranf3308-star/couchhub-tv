// Deterministic AI-Discovery regression fixture.
//
// A ~590-title synthetic catalogue built to reproduce the production
// failure of 2026-11-12 (query "some fucked up dark anime" returned
// 'G' Men (1935), .com for Murder, .raw (2018), '71 (2014),
// ...And Justice for All): the first 20 catalogue entries are
// deliberately irrelevant punctuation-prefixed titles, and every
// title relevant to any test intent sits BEYOND index 20. Any code
// that slices the first N catalogue entries before relevance ranking
// can only ever see the punctuation block — the fixture makes that
// failure visible instead of accidental.
//
// Rules the fixture guarantees (asserted by the regression suite):
//   - indices 0..19: punctuation-prefixed, no anime/comedy/war/
//     romance/sci-fi signal anywhere (title, genres, overview).
//   - every anime / comedy / war / romance / sci-fi-series entry
//     sits at index >= 100.
//   - intent groups are disjoint by genre/kind, so per-intent
//     candidate pools must not overlap.
//   - filler titles/overviews contain no intent keywords at all.
//   - ids are unique per kind, EXCEPT the deliberate composite pair
//     movie:123 / series:123 (same numeric provider id, both kinds).
//   - all titles are invented. Nothing here is a real catalogue
//     title; the five punctuation titles in the production report
//     are reproduced verbatim because the regression is about them.
//
// Deterministic: filler is generated from a seeded LCG, never
// Math.random / Date.now, so the catalogue is identical every run.

import type { DiscoverCandidate } from "../../src/scripts/lib/discover"

export const DARK_ANIME_QUERY = "some fucked up dark anime"

/** The five titles the production failure actually returned. */
export const PUNCTUATION_TITLES = [
  "'G' Men",
  ".com for Murder",
  ".raw",
  "'71",
  "...And Justice for All",
] as const

function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]
}

function candidate(partial: Partial<DiscoverCandidate> & { id: string; title: string }): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  }
}

// --- Punctuation-first block (indices 0..19): irrelevant by design ---

const PUNCTUATION_EXTRA: Array<{ title: string; genres: string[]; year: number; rating: number }> = [
  { title: "!Hero", genres: ["Drama"], year: 2011, rating: 6.2 },
  { title: "#Blackbird", genres: ["Thriller"], year: 2019, rating: 5.9 },
  { title: "$9.99", genres: ["Drama"], year: 2008, rating: 6.8 },
  { title: "% Whole", genres: ["Documentary"], year: 2015, rating: 7.1 },
  { title: "& Sons", genres: ["Drama"], year: 2003, rating: 6.4 },
  { title: "(Untitled)", genres: ["Mystery"], year: 2021, rating: 5.5 },
  { title: "*Batteries Not Included", genres: ["Family"], year: 1987, rating: 6.0 },
  { title: "+1", genres: ["Thriller"], year: 2013, rating: 5.7 },
  { title: "-1", genres: ["Drama"], year: 2017, rating: 6.6 },
  { title: "? The Question", genres: ["Mystery"], year: 2009, rating: 6.9 },
  { title: "@Midnight", genres: ["Horror"], year: 2020, rating: 5.4 },
  { title: "~Summer", genres: ["Drama"], year: 1998, rating: 7.3 },
  { title: "^Heads", genres: ["Crime"], year: 2016, rating: 6.3 },
  { title: "`Tick`", genres: ["Thriller"], year: 2022, rating: 5.8 },
  { title: "¡Viva!", genres: ["Musical"], year: 1974, rating: 6.7 },
]

const PUNCTUATION_HEAD: Array<{ title: string; genres: string[]; year: number; rating: number }> = [
  { title: "'G' Men", genres: ["Crime", "Drama"], year: 1935, rating: 7.2 },
  { title: ".com for Murder", genres: ["Thriller", "Crime"], year: 2002, rating: 6.1 },
  { title: ".raw", genres: ["Horror"], year: 2018, rating: 5.8 },
  { title: "'71", genres: ["War", "Drama"], year: 2014, rating: 7.0 },
  { title: "...And Justice for All", genres: ["Drama", "Crime"], year: 1979, rating: 7.5 },
]

function punctuationBlock(): DiscoverCandidate[] {
  const rows = [...PUNCTUATION_HEAD, ...PUNCTUATION_EXTRA]
  return rows.map((row, index) =>
    candidate({
      id: `p${index}`,
      title: row.title,
      year: row.year,
      rating: row.rating,
      voteCount: 200 + index * 37,
      genres: row.genres,
      overview: `A ${row.genres[0].toLowerCase()} title from ${row.year}.`,
    })
  )
}

// --- Intent groups (all placed beyond index 20) ---

const ANIME_TITLES: Array<{ title: string; genres: string[]; kind: "movie" | "series"; dark: boolean }> = [
  { title: "Crimson Ronin", genres: ["Animation", "Horror"], kind: "series", dark: true },
  { title: "The Hollow School", genres: ["Animation", "Horror"], kind: "series", dark: true },
  { title: "Ashen Blades", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "Black Sakura", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "Dead Lanterns", genres: ["Animation", "Thriller"], kind: "series", dark: true },
  { title: "Rotten Petals", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "Neon Graveyard", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "Iron Widow", genres: ["Animation", "Horror"], kind: "series", dark: true },
  { title: "The Drowned Shrine", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "Wolf Hour", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "The Bleeding Moon", genres: ["Animation", "Horror"], kind: "series", dark: true },
  { title: "Paper Demons", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "The Salt Witch", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "Hollow Crown", genres: ["Animation", "Thriller"], kind: "series", dark: true },
  { title: "The Gutter Choir", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "Bone Orchard", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "The Red Static", genres: ["Animation", "Horror"], kind: "series", dark: true },
  { title: "Midnight Ferry", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "The Glass Teeth", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "Witch Hazel", genres: ["Animation", "Thriller"], kind: "series", dark: true },
  { title: "The Long Night Shift", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "The Lantern Eater", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "Grave Weather", genres: ["Animation", "Horror"], kind: "series", dark: true },
  { title: "The Rust Saint", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "Moth Country", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "The Widow's Garden", genres: ["Animation", "Thriller"], kind: "series", dark: true },
  { title: "Copper Ghosts", genres: ["Animation", "Horror"], kind: "movie", dark: true },
  { title: "The Ninth Bell", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "Violet Static", genres: ["Animation", "Horror"], kind: "series", dark: true },
  { title: "The Dog Star", genres: ["Animation", "Thriller"], kind: "movie", dark: true },
  { title: "The Quiet Ones", genres: ["Animation", "Drama"], kind: "movie", dark: false },
  { title: "Paper Cranes", genres: ["Animation", "Drama"], kind: "series", dark: false },
  { title: "The Tea House", genres: ["Animation", "Drama"], kind: "movie", dark: false },
  { title: "Slow Summer", genres: ["Animation", "Drama"], kind: "series", dark: false },
  { title: "The Old Ferry", genres: ["Animation", "Drama"], kind: "movie", dark: false },
  { title: "Hillside", genres: ["Animation", "Drama"], kind: "series", dark: false },
  { title: "The Kite Maker", genres: ["Animation", "Drama"], kind: "movie", dark: false },
  { title: "Winter Letters", genres: ["Animation", "Drama"], kind: "series", dark: false },
  { title: "The Apricot Tree", genres: ["Animation", "Drama"], kind: "movie", dark: false },
  { title: "Rainy Afternoons", genres: ["Animation", "Drama"], kind: "series", dark: false },
]

function animeEntries(): DiscoverCandidate[] {
  return ANIME_TITLES.map((row, index) =>
    candidate({
      id: `a${index}`,
      kind: row.kind,
      title: row.title,
      year: 1995 + ((index * 7) % 29),
      rating: 6.5 + ((index * 13) % 25) / 10,
      voteCount: 1500 + index * 211,
      genres: row.genres,
      overview: row.dark
        ? `A dark anime about ${row.title.toLowerCase()} — disturbing, violent and bleak.`
        : `A quiet anime drama about ${row.title.toLowerCase()}.`,
    })
  )
}

const COMEDY_TITLES = [
  "The Awkward Reunion", "My Neighbour's Goat", "The Committee", "Lawn Order",
  "The Backup Plan", "Dinner for One Too Many", "The Substitute Teacher", "Flatpack",
  "The Group Chat", "Auntie Mabel's Revenge", "The Office Party", "Two Left Feet",
  "The Dog Ate It", "Speed Dating", "The Wrong Funeral", "Mild Panic",
  "The In-Laws", "Karaoke Night", "The House Swap", "Bingo Wings",
  "The Teapot", "Mr. Fixit", "The Rehearsal Dinner", "Couch Surfers",
  "The PTA Meeting", "Grandad's Taxi", "The Hen Do", "Wi-Fi Down",
  "The Car Boot Sale", "Socks in Sandals",
]

const WAR_TITLES = [
  "The Winter Offensive", "Letters from the Front", "The Last Platoon", "No Man's Land",
  "The Siege of Dunmore", "Brothers at Arms", "The Home Front", "A Soldier's Return",
  "The Forgotten Regiment", "Trenches", "The Medics", "Operation Nightingale",
  "The Silent Guns", "Valley of Smoke", "The Evacuees", "War Correspondent",
  "The Ration Book", "The Bombed-Out Church", "The Conscientious Objector", "The Prisoner Exchange",
  "The Resistance Cell", "The Air Raid", "The Widow's Pension", "The Draft Letter",
  "The Military Wife", "The Fallen Oak", "The Armistice", "The Field Hospital",
  "The Minefield", "The Surrender",
]

const ROMANCE_TITLES = [
  "Letters in June", "The Summer We Met", "A Second Chance", "The Bookshop on the Corner",
  "Rain in Lisbon", "The Last Dance", "Two Tickets", "The Wedding Guest",
  "Autumn Hearts", "The Lighthouse Keeper's Wife", "A Table for Two", "The Slow Goodbye",
  "Pen Pals", "The Florist", "Sunday Mornings", "The Train to Verona",
  "A Winter Wedding", "The Olive Grove", "The Violinist", "First Light",
  "The Garden Party", "The Photograph", "The Long Weekend", "The Corner Café",
  "The Dressmaker's Daughter", "The Postman", "The Balcony", "A Quiet Affair",
  "The Honeymoon", "The Anniversary",
]

const SCIFI_SERIES_TITLES = [
  "The Andromeda Protocol", "Station Nine", "The Terraformers", "Quantum Drift",
  "The Far Side", "The Colony Ship", "The Horizon Signal", "The Void Engineers",
  "The Starfarers", "The Dyson Ring", "The Alien Embassy", "The Time Cartographers",
  "The Robot Uprising", "The Mars Compact", "The Lunar Base", "The Wormhole",
  "The Clone Registry", "The Asteroid Miners", "The Neural Net", "The Cyborg Detective",
  "The Space Elevator", "The Galactic Census", "The Ion Storm", "The Cryo Sleepers",
  "The Orbital Ring", "The Deep Field", "The First Contact", "The Synthetic Dawn",
  "The Zero-Gravity Bar", "The Parallel City",
]

function titledGroup(
  titles: readonly string[],
  prefix: string,
  genres: string[],
  kind: "movie" | "series",
  overviewWord: string,
): DiscoverCandidate[] {
  return titles.map((title, index) =>
    candidate({
      id: `${prefix}${index}`,
      kind,
      title,
      year: 1980 + ((index * 11) % 45),
      rating: 6.0 + ((index * 7) % 30) / 10,
      voteCount: 800 + index * 173,
      genres,
      overview: `A ${overviewWord} title about ${title.toLowerCase()}.`,
    })
  )
}

// --- Composite pair: one numeric provider id, both kinds ---

export const COMPOSITE_MOVIE_123: DiscoverCandidate = candidate({
  id: "123",
  kind: "movie",
  title: "The 123rd Laugh",
  year: 2019,
  rating: 7.4,
  voteCount: 4200,
  genres: ["Comedy"],
  overview: "A funny comedy about a very unlucky comedian.",
})

export const COMPOSITE_SERIES_123: DiscoverCandidate = candidate({
  id: "123",
  kind: "series",
  title: "The 123rd Laugh: The Series",
  year: 2021,
  rating: 7.1,
  voteCount: 3100,
  genres: ["Comedy"],
  overview: "A funny comedy series about the same unlucky comedian.",
})

// --- Sparse metadata: incomplete genres / synopsis / rating / year ---

function sparseEntries(): DiscoverCandidate[] {
  return [
    candidate({ id: "sp0", kind: "movie", title: "Dark Anime Nights", genres: [] }),
    candidate({ id: "sp1", kind: "series", title: "Quiet Anime Afternoon", genres: [] }),
    candidate({ id: "sp2", kind: "movie", title: "Untitled Reel 7", genres: [] }),
    candidate({ id: "sp3", kind: "movie", title: "A Film With No Data", genres: [] }),
    candidate({
      id: "sp4", kind: "movie", title: "Genreless Drama", genres: [],
      overview: "A drama with no genre tags.",
    }),
    candidate({
      id: "sp5", kind: "movie", title: "The Missing Synopsis", genres: ["Comedy"],
      rating: 7.0, year: 2020,
    }),
    candidate({
      id: "sp6", kind: "movie", title: "No Rating Comedy", genres: ["Comedy"],
      overview: "A funny film.", year: 2019,
    }),
    candidate({
      id: "sp7", kind: "movie", title: "No Year Anime", genres: ["Animation"],
      overview: "A dark anime with no year attached.", rating: 8.0,
    }),
  ]
}

// --- Filler: neutral titles, no intent keywords anywhere ---

const FILLER_ADJECTIVES = [
  "Silent", "Copper", "Velvet", "Iron", "Amber", "Hollow", "Granite", "Willow",
  "Cobalt", "Marble", "Cedar", "Slate", "Ember", "Frost", "Harbor", "Meadow",
  "Summit", "Valley", "Beacon", "Anchor",
] as const

const FILLER_NOUNS = [
  "Road", "House", "River", "Garden", "Station", "Bridge", "Harbor", "Letter",
  "Winter", "Portrait", "Voyage", "Country", "Morning", "Evening", "Island",
  "Church", "Market", "Theatre", "Library", "School",
] as const

/** Genres that carry NO test intent (no Animation/Comedy/War/History/Romance/Sci-Fi). */
const FILLER_GENRES = [
  "Drama", "Documentary", "Family", "Musical", "Western", "Mystery", "Action", "Thriller", "Crime",
] as const

function fillerEntries(count: number, seed: number): DiscoverCandidate[] {
  const rand = lcg(seed)
  const usedTitles = new Set<string>()
  const out: DiscoverCandidate[] = []
  for (let index = 0; index < count; index++) {
    let title = ""
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidateTitle = `${pick(rand, FILLER_ADJECTIVES)} ${pick(rand, FILLER_NOUNS)}`
      if (!usedTitles.has(candidateTitle)) {
        title = candidateTitle
        break
      }
    }
    if (!title) title = `${pick(rand, FILLER_ADJECTIVES)} ${pick(rand, FILLER_NOUNS)} ${index}`
    usedTitles.add(title)
    const genre = pick(rand, FILLER_GENRES)
    const kind = rand() < 0.7 ? "movie" : "series"
    out.push(
      candidate({
        id: `f${index}`,
        kind,
        title,
        year: 1950 + Math.floor(rand() * 76),
        rating: Math.round((5 + rand() * 4.5) * 10) / 10,
        voteCount: rand() < 0.8 ? 50 + Math.floor(rand() * 5000) : undefined,
        genres: [genre],
        overview: `A ${genre.toLowerCase()} story set around ${title.toLowerCase()}.`,
      })
    )
  }
  return out
}

// --- Assembly: fixed order, intent groups always beyond index 20 ---

function buildCatalogue(): DiscoverCandidate[] {
  const punctuation = punctuationBlock() // 0..19
  const anime = animeEntries() // 40
  const comedy = titledGroup(COMEDY_TITLES, "c", ["Comedy"], "movie", "funny comedy")
  const war = titledGroup(WAR_TITLES, "w", ["War"], "movie", "historical war")
  const romance = titledGroup(ROMANCE_TITLES, "r", ["Romance"], "movie", "romantic")
  const scifiSeries = titledGroup(SCIFI_SERIES_TITLES, "s", ["Sci-Fi"], "series", "science-fiction")
  const sparse = sparseEntries() // 8
  const filler = fillerEntries(400, 0xA11CE5)
  return [
    ...punctuation, // 0..19
    ...filler.slice(0, 80), // 20..99
    ...anime, // 100..139
    ...filler.slice(80, 140), // 140..199
    ...comedy, // 200..229
    ...filler.slice(140, 170), // 230..259
    ...war, // 260..289
    ...filler.slice(170, 200), // 290..319
    COMPOSITE_MOVIE_123, // 320
    COMPOSITE_SERIES_123, // 321
    ...romance, // 322..351
    ...filler.slice(200, 250), // 352..401
    ...scifiSeries, // 402..431
    ...sparse, // 432..439
    ...filler.slice(250, 400), // 440..589
  ]
}

/** The full deterministic catalogue (~590 entries). */
export const AI_DISCOVERY_CATALOGUE: DiscoverCandidate[] = buildCatalogue()

export const ANIME_IDS = new Set(animeEntries().map((c) => c.id))
export const COMEDY_IDS = new Set(
  titledGroup(COMEDY_TITLES, "c", ["Comedy"], "movie", "funny comedy").map((c) => c.id),
)
export const WAR_IDS = new Set(
  titledGroup(WAR_TITLES, "w", ["War"], "movie", "historical war").map((c) => c.id),
)
export const ROMANCE_IDS = new Set(
  titledGroup(ROMANCE_TITLES, "r", ["Romance"], "movie", "romantic").map((c) => c.id),
)
export const SCIFI_SERIES_IDS = new Set(
  titledGroup(SCIFI_SERIES_TITLES, "s", ["Sci-Fi"], "series", "science-fiction").map((c) => c.id),
)
export const SPARSE_IDS = new Set(sparseEntries().map((c) => c.id))

/** True when a candidate carries any anime signal (genre, title or overview). */
export function hasAnimeSignal(c: DiscoverCandidate): boolean {
  const genres = (c.genres ?? []).map((g) => g.toLowerCase())
  if (genres.includes("animation") || genres.includes("anime")) return true
  const text = `${c.title} ${c.overview ?? ""}`.toLowerCase()
  return text.includes("anime")
}

/** Catalogue with every anime-signalled title removed (T8: empty matches). */
export const NO_ANIME_CATALOGUE: DiscoverCandidate[] = AI_DISCOVERY_CATALOGUE.filter(
  (c) => !hasAnimeSignal(c),
)

/** Index of a candidate in the full catalogue (-1 when absent). */
export function catalogueIndexOf(id: string, kind?: string): number {
  return AI_DISCOVERY_CATALOGUE.findIndex(
    (c) => c.id === id && (kind === undefined || c.kind === kind),
  )
}
