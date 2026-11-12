// Deterministic mocked-TMDB fixture (0.11.6, W5).
//
// Canned TmdbSearchResult objects + details records for every title the
// mocked model generates in tests/ai-discovery-3.0.test.ts. TMDB ids are
// MOCK ids (900001+) — identity consistency within the mock is what the
// tests assert (displayed id == TMDB id, never the model's externalId),
// not real-world TMDB ids. Title spellings match
// tests/fixtures/ai-discovery-3.0-catalogue.ts exactly.
//
// Lookup semantics belong to the MOCK (tests/helpers/mocked-tmdb.ts),
// not to this table: the mock returns the full candidate set for a
// (kind, normalised title) key and ignores the requested year — picking
// the right year / refusing a bad year is production logic under test,
// never mock behaviour.
//
// Coverage:
//   - alternative titles: "Shingeki no Kyojin" resolves to Attack on
//     Titan via original_name; "Shin Seiki Evangelion" to Neon Genesis
//     Evangelion.
//   - year correction: "Dune" returns both 1984 and 2021; "The Thing"
//     returns both 1982 and 2011; "Blade Runner 2049" resolves to 2017.
//   - no-details fallback: Neon Genesis Evangelion has NO details
//     record — synopsis/poster must fall back to the search result and
//     genres must stay honestly empty.
//   - unresolvable: "The Glimmering Void" has no table entry at all.

import type { TmdbSearchResult } from "../../src/scripts/lib/tmdb"

/**
 * Details shape, defined locally (not imported from the verification
 * stub) so this fixture does not depend on W2's naming for the
 * fetchDetails return type: the mocked-TMDB helper adapts it
 * structurally. Fields mirror the frozen VerifiedRecommendation
 * display fields.
 */
export interface MockTmdbDetails {
  genres?: string[]
  synopsis?: string
  posterUrl?: string
  backdropUrl?: string
}

function movie(
  id: number,
  title: string,
  year: number,
  extra: Partial<TmdbSearchResult> = {},
): TmdbSearchResult {
  return {
    id,
    title,
    release_date: `${year}-01-01`,
    vote_count: 1000,
    popularity: 50,
    poster_path: `/mock-${id}.jpg`,
    overview: `Overview for ${title} (${year}).`,
    ...extra,
  }
}

function series(
  id: number,
  name: string,
  year: number,
  extra: Partial<TmdbSearchResult> = {},
): TmdbSearchResult {
  return {
    id,
    name,
    first_air_date: `${year}-01-01`,
    vote_count: 1000,
    popularity: 50,
    poster_path: `/mock-${id}.jpg`,
    overview: `Overview for ${name} (${year}).`,
    ...extra,
  }
}

export const TMDB_ATTACK_ON_TITAN = series(900001, "Attack on Titan", 2013, {
  original_name: "Shingeki no Kyojin",
  vote_count: 5200,
})
export const TMDB_DEATH_NOTE = series(900002, "Death Note", 2006, { vote_count: 4100 })
export const TMDB_PERFECT_BLUE = movie(900003, "Perfect Blue", 1997, { vote_count: 2300 })
export const TMDB_BERSERK = series(900004, "Berserk", 1997, { vote_count: 1900 })
export const TMDB_ELFEN_LIED = series(900005, "Elfen Lied", 2004, { vote_count: 1500 })
export const TMDB_EVANGELION = series(900006, "Neon Genesis Evangelion", 1995, {
  original_name: "Shin Seiki Evangelion",
  vote_count: 3800,
})
export const TMDB_MUGEN_TRAIN = movie(900007, "Demon Slayer: Mugen Train", 2020, {
  vote_count: 2900,
})
export const TMDB_JUJUTSU_0 = movie(900008, "Jujutsu Kaisen 0", 2021, { vote_count: 2600 })
export const TMDB_REZE_ARC = movie(900009, "Chainsaw Man: Reze Arc", 2025, { vote_count: 1200 })
export const TMDB_SUPERBAD = movie(900010, "Superbad", 2007, { vote_count: 6100 })
export const TMDB_HOT_FUZZ = movie(900011, "Hot Fuzz", 2007, { vote_count: 5400 })
export const TMDB_STEP_BROTHERS = movie(900012, "Step Brothers", 2008, { vote_count: 4300 })
export const TMDB_BRIDESMAIDS = movie(900013, "Bridesmaids", 2011, { vote_count: 3900 })
export const TMDB_GRAND_BUDAPEST = movie(900014, "The Grand Budapest Hotel", 2014, {
  vote_count: 7200,
})
export const TMDB_HEREDITARY = movie(900015, "Hereditary", 2018, { vote_count: 6800 })
export const TMDB_GET_OUT = movie(900016, "Get Out", 2017, { vote_count: 8100 })
export const TMDB_THING_1982 = movie(900017, "The Thing", 1982, { vote_count: 7400 })
export const TMDB_THING_2011 = movie(900018, "The Thing", 2011, { vote_count: 2100 })
export const TMDB_IT_FOLLOWS = movie(900019, "It Follows", 2014, { vote_count: 3200 })
export const TMDB_BABADOOK = movie(900020, "The Babadook", 2014, { vote_count: 3600 })
export const TMDB_DUNE_1984 = movie(900021, "Dune", 1984, { vote_count: 2800 })
export const TMDB_DUNE_2021 = movie(900022, "Dune", 2021, { vote_count: 9500 })
export const TMDB_IT_SERIES_1990 = series(900023, "It", 1990, { vote_count: 1700 })
export const TMDB_IT_MOVIE_2017 = movie(900024, "It", 2017, { vote_count: 8900 })
export const TMDB_BLADE_RUNNER_2049 = movie(900025, "Blade Runner 2049", 2017, {
  vote_count: 9100,
})
export const TMDB_SHAWSHANK = movie(900026, "The Shawshank Redemption", 1994, {
  vote_count: 12000,
})
export const TMDB_PARASITE = movie(900027, "Parasite", 2019, { vote_count: 11000 })

/** Search table: `${kind}:${normalised title}` -> candidate results. */
export const TMDB_SEARCH_TABLE: Record<string, TmdbSearchResult[]> = {
  "series:attack on titan": [TMDB_ATTACK_ON_TITAN],
  "series:shingeki no kyojin": [TMDB_ATTACK_ON_TITAN],
  "series:death note": [TMDB_DEATH_NOTE],
  "movie:perfect blue": [TMDB_PERFECT_BLUE],
  "series:berserk": [TMDB_BERSERK],
  "series:elfen lied": [TMDB_ELFEN_LIED],
  "series:neon genesis evangelion": [TMDB_EVANGELION],
  "series:shin seiki evangelion": [TMDB_EVANGELION],
  "movie:demon slayer mugen train": [TMDB_MUGEN_TRAIN],
  "movie:jujutsu kaisen 0": [TMDB_JUJUTSU_0],
  "movie:chainsaw man reze arc": [TMDB_REZE_ARC],
  "movie:superbad": [TMDB_SUPERBAD],
  "movie:hot fuzz": [TMDB_HOT_FUZZ],
  "movie:step brothers": [TMDB_STEP_BROTHERS],
  "movie:bridesmaids": [TMDB_BRIDESMAIDS],
  "movie:the grand budapest hotel": [TMDB_GRAND_BUDAPEST],
  "movie:hereditary": [TMDB_HEREDITARY],
  "movie:get out": [TMDB_GET_OUT],
  "movie:the thing": [TMDB_THING_1982, TMDB_THING_2011],
  "movie:it follows": [TMDB_IT_FOLLOWS],
  "movie:the babadook": [TMDB_BABADOOK],
  "movie:dune": [TMDB_DUNE_1984, TMDB_DUNE_2021],
  "series:it": [TMDB_IT_SERIES_1990],
  "movie:it": [TMDB_IT_MOVIE_2017],
  "movie:blade runner 2049": [TMDB_BLADE_RUNNER_2049],
  "movie:the shawshank redemption": [TMDB_SHAWSHANK],
  "movie:parasite": [TMDB_PARASITE],
}

/** Details table: tmdbId -> genres/synopsis/artwork. Evangelion deliberately absent. */
export const TMDB_DETAILS_TABLE: Record<number, MockTmdbDetails> = {
  [TMDB_ATTACK_ON_TITAN.id]: {
    genres: ["Animation", "Drama", "Action"],
    synopsis: "Humanity's last stand against the Titans.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900001.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/mock-900001-bg.jpg",
  },
  [TMDB_DEATH_NOTE.id]: {
    genres: ["Animation", "Thriller", "Mystery"],
    synopsis: "A notebook that kills, and the mind games around it.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900002.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/mock-900002-bg.jpg",
  },
  [TMDB_PERFECT_BLUE.id]: {
    genres: ["Animation", "Thriller"],
    synopsis: "A retired idol loses herself between performance and reality.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900003.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/mock-900003-bg.jpg",
  },
  [TMDB_BERSERK.id]: {
    genres: ["Animation", "Action", "Horror"],
    synopsis: "A swordsman walks a cursed path through a merciless world.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900004.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/mock-900004-bg.jpg",
  },
  [TMDB_ELFEN_LIED.id]: {
    genres: ["Animation", "Horror", "Drama"],
    synopsis: "An escaped experiment turns a coastal town into a bloodbath.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900005.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/mock-900005-bg.jpg",
  },
  [TMDB_MUGEN_TRAIN.id]: {
    genres: ["Animation", "Action"],
    synopsis: "A demon turns a train full of passengers into a dream trap.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900007.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/mock-900007-bg.jpg",
  },
  [TMDB_JUJUTSU_0.id]: {
    genres: ["Animation", "Action"],
    synopsis: "A haunted boy learns to fight curses at sorcery school.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900008.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/mock-900008-bg.jpg",
  },
  [TMDB_REZE_ARC.id]: {
    genres: ["Animation", "Action", "Horror"],
    synopsis: "A devil hunter's new romance hides a lethal agenda.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900009.jpg",
    backdropUrl: "https://image.tmdb.org/t/p/w1280/mock-900009-bg.jpg",
  },
  [TMDB_SUPERBAD.id]: {
    genres: ["Comedy"],
    synopsis: "Two friends chase one legendary night before graduation.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900010.jpg",
  },
  [TMDB_HOT_FUZZ.id]: {
    genres: ["Comedy", "Action"],
    synopsis: "A hotshot cop uncovers a conspiracy in a quiet village.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900011.jpg",
  },
  [TMDB_STEP_BROTHERS.id]: {
    genres: ["Comedy"],
    synopsis: "Two grown layabouts become stepbrothers and chaos follows.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900012.jpg",
  },
  [TMDB_BRIDESMAIDS.id]: {
    genres: ["Comedy", "Romance"],
    synopsis: "A maid of honour unravels as the wedding approaches.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900013.jpg",
  },
  [TMDB_GRAND_BUDAPEST.id]: {
    genres: ["Comedy", "Drama"],
    synopsis: "A concierge and his protege get tangled in a murder and a will.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900014.jpg",
  },
  [TMDB_HEREDITARY.id]: {
    genres: ["Horror", "Drama"],
    synopsis: "A family unravels after the grandmother's death.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900015.jpg",
  },
  [TMDB_GET_OUT.id]: {
    genres: ["Horror", "Thriller"],
    synopsis: "A weekend with the parents turns sinister.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900016.jpg",
  },
  [TMDB_THING_1982.id]: {
    genres: ["Horror", "Sci-Fi"],
    synopsis: "An Antarctic crew faces a shape-shifting alien.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900017.jpg",
  },
  [TMDB_THING_2011.id]: {
    genres: ["Horror", "Sci-Fi"],
    synopsis: "The discovery that preceded the 1982 outbreak.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900018.jpg",
  },
  [TMDB_IT_FOLLOWS.id]: {
    genres: ["Horror", "Thriller"],
    synopsis: "A curse passed from person to person, always walking closer.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900019.jpg",
  },
  [TMDB_BABADOOK.id]: {
    genres: ["Horror", "Drama"],
    synopsis: "A storybook monster haunts a grieving mother and son.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900020.jpg",
  },
  [TMDB_DUNE_1984.id]: {
    genres: ["Sci-Fi", "Adventure"],
    synopsis: "Paul Atreides journeys to the desert planet Arrakis.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900021.jpg",
  },
  [TMDB_DUNE_2021.id]: {
    genres: ["Sci-Fi", "Adventure"],
    synopsis: "Paul Atreides leads the Fremen against House Harkonnen.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900022.jpg",
  },
  [TMDB_IT_SERIES_1990.id]: {
    genres: ["Horror", "Drama"],
    synopsis: "The Losers Club faces Pennywise, twice.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900023.jpg",
  },
  [TMDB_IT_MOVIE_2017.id]: {
    genres: ["Horror"],
    synopsis: "Seven kids face the clown haunting Derry.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900024.jpg",
  },
  [TMDB_BLADE_RUNNER_2049.id]: {
    genres: ["Sci-Fi", "Drama"],
    synopsis: "A replicant blade runner unearths a buried secret.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900025.jpg",
  },
  [TMDB_SHAWSHANK.id]: {
    genres: ["Drama", "Crime"],
    synopsis: "A banker holds onto hope through decades in prison.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900026.jpg",
  },
  [TMDB_PARASITE.id]: {
    genres: ["Thriller", "Drama", "Comedy"],
    synopsis: "A poor family cons its way into a rich household.",
    posterUrl: "https://image.tmdb.org/t/p/w500/mock-900027.jpg",
  },
}
