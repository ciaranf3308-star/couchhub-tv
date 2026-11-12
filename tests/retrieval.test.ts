// CouchHub TV AI Discovery — W1 retrieval tests (0.11.5).
// Synthetic fixtures only; no live catalogue, no AI key, no EPG fetch.
// The punctuation-first fixture below is the production failure:
// "some fucked up dark anime" must NEVER return 'G' Men (1935) et al.
import { describe, it, expect } from "vitest"
import {
  parseIntent,
  retrieveCandidates,
  applyHardFilters,
  buildCatalogueIndex,
  animeEvidence,
  RETRIEVAL_SHORTLIST_MAX,
  type RetrievableCandidate,
} from "../src/scripts/lib/retrieval"
import { emptyTasteModel, recordFeedback } from "../src/scripts/lib/taste"

function candidate(
  partial: Partial<RetrievableCandidate> & { id: string; title: string }
): RetrievableCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    ...partial,
  } as RetrievableCandidate
}

const EMPTY_TASTE = () => emptyTasteModel("shared", "pl1")

/**
 * The production failure, as a fixture: the first 20 catalogue entries
 * in catalogue order are punctuation-first, high-rated, live-action
 * films — exactly what the old code fed the model. The relevant dark
 * anime sits at position 24, past the old 20-cap.
 */
function punctuationFirstCatalogue(): RetrievableCandidate[] {
  const early: RetrievableCandidate[] = [
    candidate({ id: "1", title: "'G' Men", year: 1935, genres: ["Crime", "Drama"], rating: 9.6, voteCount: 5000, overview: "A lawyer joins the FBI to fight gangsters." }),
    candidate({ id: "2", title: ".com for Murder", year: 2002, genres: ["Thriller"], rating: 9.4, voteCount: 4000, overview: "A web designer becomes a murder suspect." }),
    candidate({ id: "3", title: ".raw", year: 2018, genres: ["Drama"], rating: 9.2, voteCount: 3000, overview: "A photographer's life unravels." }),
    candidate({ id: "4", title: "'71", year: 2014, genres: ["War", "Thriller"], rating: 9.1, voteCount: 6000, overview: "A soldier is stranded in Belfast." }),
    candidate({ id: "5", title: "...And Justice for All", year: 1979, genres: ["Drama", "Crime"], rating: 9.0, voteCount: 8000, overview: "A lawyer defends a judge accused of rape." }),
    candidate({ id: "6", title: "!Three Amigos", year: 1986, genres: ["Comedy", "Western"], rating: 8.9, voteCount: 9000, overview: "Three silent film stars become heroes." }),
    candidate({ id: "7", title: "(500) Days of Summer", year: 2009, genres: ["Romance", "Comedy"], rating: 8.8, voteCount: 12000, overview: "A greeting card writer falls for his colleague." }),
    candidate({ id: "8", title: "[REC]", year: 2007, genres: ["Horror"], rating: 8.7, voteCount: 7000, overview: "A reporter is trapped in a quarantined building." }),
    candidate({ id: "9", title: "12 Angry Men", year: 1957, genres: ["Drama", "Crime"], rating: 8.6, voteCount: 15000, overview: "A jury deliberates a murder case." }),
    candidate({ id: "10", title: "2001: A Space Odyssey", year: 1968, genres: ["Sci-Fi", "Adventure"], rating: 8.5, voteCount: 20000, overview: "A voyage to Jupiter after a monolith discovery." }),
    candidate({ id: "11", title: "3:10 to Yuma", year: 2007, genres: ["Western", "Action"], rating: 8.4, voteCount: 11000, overview: "A rancher escorts an outlaw to prison." }),
    candidate({ id: "12", title: "8½", year: 1963, genres: ["Drama"], rating: 8.3, voteCount: 5000, overview: "A director suffers creative block." }),
    candidate({ id: "13", title: "'Allo 'Allo! The Movie", year: 1985, genres: ["Comedy"], rating: 8.2, voteCount: 2000, overview: "A café owner hides British airmen." }),
    candidate({ id: "14", title: ".38 Special: Live", year: 1999, genres: ["Music"], rating: 8.1, voteCount: 1500, overview: "A concert film." }),
    candidate({ id: "15", title: "10 Things I Hate About You", year: 1999, genres: ["Comedy", "Romance"], rating: 8.0, voteCount: 13000, overview: "A teenager is paid to date a sharp-tongued girl." }),
    candidate({ id: "16", title: "101 Dalmatians", year: 1961, genres: ["Animation", "Family"], rating: 7.9, voteCount: 10000, overview: "Puppies are stolen by a fur-obsessed villain." }),
    candidate({ id: "17", title: "127 Hours", year: 2010, genres: ["Drama", "Adventure"], rating: 7.8, voteCount: 9000, overview: "A climber is trapped by a boulder." }),
    candidate({ id: "18", title: "1917", year: 2019, genres: ["War", "Drama"], rating: 7.7, voteCount: 14000, overview: "Two soldiers race to stop an attack." }),
    candidate({ id: "19", title: "20th Century Women", year: 2016, genres: ["Drama", "Comedy"], rating: 7.6, voteCount: 4000, overview: "A mother raises her son with two women." }),
    candidate({ id: "20", title: "21 Jump Street", year: 2012, genres: ["Comedy", "Action"], rating: 7.5, voteCount: 16000, overview: "Two cops go undercover at a high school." }),
    candidate({ id: "21", title: "25th Hour", year: 2002, genres: ["Drama", "Crime"], rating: 7.4, voteCount: 8000, overview: "A drug dealer's last day of freedom." }),
    candidate({ id: "22", title: "28 Days Later", year: 2002, genres: ["Horror", "Thriller"], rating: 7.3, voteCount: 11000, overview: "A virus empties London in a dark, bleak nightmare." }),
    candidate({ id: "23", title: "30 Days of Night", year: 2007, genres: ["Horror", "Thriller"], rating: 7.2, voteCount: 6000, overview: "Vampires descend on an Alaskan town." }),
    candidate({ id: "24", title: "300", year: 2006, genres: ["Action", "War"], rating: 7.1, voteCount: 18000, overview: "Spartans hold a mountain pass." }),
  ]
  const anime = candidate({
    id: "25",
    title: "Perfect Blue",
    year: 1997,
    genres: ["Anime", "Horror", "Thriller"],
    rating: 7.5,
    voteCount: 9000,
    overview: "A pop idol turned actress is stalked as her mind unravels — a dark, disturbing psychological nightmare.",
  })
  const animationOnly = candidate({
    id: "26",
    title: "Toy Story",
    year: 1995,
    genres: ["Animation", "Family", "Comedy"],
    rating: 8.3,
    voteCount: 25000,
    overview: "Toys come to life when their owner is away.",
  })
  return [...early, anime, animationOnly]
}

describe("parseIntent", () => {
  it("parses the production query: dark disturbing anime, no title tokens", () => {
    const intent = parseIntent("some fucked up dark anime")
    expect(intent.anime).toBe("required")
    expect(intent.tones).toContain("disturbing")
    expect(intent.tones).toContain("dark")
    expect(intent.mature).toBe(true)
    expect(intent.titleTokens).toEqual([])
    expect(intent.hasConstraintIntent).toBe(true)
  })

  it("treats 'comedy' as a hard genre, not a mood", () => {
    const intent = parseIntent("comedy")
    expect(intent.genreGroups).toEqual([["comedy"]])
    expect(intent.genres).toEqual(["comedy"])
    expect(intent.hasConstraintIntent).toBe(true)
  })

  it("parses kind, runtime and year bounds", () => {
    const series = parseIntent("a gripping crime series")
    expect(series.contentKind).toBe("series")
    expect(series.genreGroups).toEqual([["crime"]])
    expect(series.tones).toContain("intense")

    const film = parseIntent("a short film under an hour")
    expect(film.contentKind).toBe("movie")
    expect(film.maxRuntimeMinutes).toBe(60)

    const underTwo = parseIntent("something under two hours")
    expect(underTwo.maxRuntimeMinutes).toBe(120)

    const after = parseIntent("horror after 2015")
    expect(after.minYear).toBe(2016)

    const nineties = parseIntent("90s horror")
    expect(nineties.minYear).toBe(1990)
    expect(nineties.maxYear).toBe(1999)
    expect(nineties.genreGroups).toEqual([["horror"]])
  })

  it("parses exclusions without turning them into requirements", () => {
    const intent = parseIntent("comedy, not horror, no romance")
    expect(intent.genreGroups).toEqual([["comedy"]])
    expect(intent.excludedGenres).toContain("horror")
    expect(intent.excludedGenres).toContain("romance")
    expect(intent.genres).not.toContain("horror")
  })

  it("parses not-watched, references and anime series", () => {
    expect(parseIntent("hidden gems i haven't seen").excludeWatched).toBe(true)
    expect(parseIntent("something like Spirited Away").referenceTitles).toContain("spirited away")
    const animeSeries = parseIntent("dark anime series")
    expect(animeSeries.anime).toBe("required")
    expect(animeSeries.contentKind).toBe("series")
    expect(parseIntent("live action").anime).toBe("excluded")
  })

  it("keeps a bare title search free of constraint intent", () => {
    const intent = parseIntent("Space Heist")
    expect(intent.titleTokens).toEqual(["space", "heist"])
    expect(intent.hasConstraintIntent).toBe(false)
    expect(parseIntent("").hasConstraintIntent).toBe(false)
  })

  it("never guesses Japanese origin from an animation label", () => {
    // "animation" alone is a genre, not anime.
    const intent = parseIntent("animation")
    expect(intent.anime).toBeUndefined()
    expect(intent.genreGroups).toEqual([["animation"]])
  })

  it("parses 'binge' as series + binge pace, 'surprise' as a preset mood", () => {
    const binge = parseIntent("binge")
    expect(binge.contentKind).toBe("series")
    expect(binge.pace).toBe("binge")
    const surprise = parseIntent("surprise me")
    expect(surprise.moods).toContain("surprise")
    expect(surprise.titleTokens).toEqual([])
    expect(surprise.hasConstraintIntent).toBe(false)
  })
})

describe("animeEvidence", () => {
  it("distinguishes anime, animation-only and none", () => {
    expect(animeEvidence(candidate({ id: "a", title: "Akira", genres: ["Anime", "Sci-Fi"] }))).toBe("anime")
    expect(animeEvidence(candidate({ id: "b", title: "Toy Story", genres: ["Animation", "Family"] }))).toBe("animation")
    expect(animeEvidence(candidate({ id: "c", title: "'G' Men", genres: ["Crime"] }))).toBe("none")
    // No genres at all is unknown, not "none by contradiction" — the
    // hard filter treats it as unknown (kept); evidence reports none.
    expect(animeEvidence(candidate({ id: "d", title: "Mystery Title", genres: [] }))).toBe("none")
  })
})

describe("applyHardFilters", () => {
  it("excludes demonstrably non-anime live-action, keeps animation-only and no-genre unknowns", () => {
    const intent = parseIntent("some fucked up dark anime")
    const index = buildCatalogueIndex(punctuationFirstCatalogue())
    const { eligible, exclusionReasons } = applyHardFilters(intent, index, EMPTY_TASTE())
    const titles = eligible.map((e) => e.candidate.title)
    expect(titles).toContain("Perfect Blue")
    expect(titles).toContain("Toy Story") // animation-only: unknown, kept
    expect(titles).not.toContain("'G' Men")
    expect(titles).not.toContain(".com for Murder")
    expect(exclusionReasons["not-anime"]).toBeGreaterThan(0)
  })

  it("enforces movies-only / series-only on known kinds", () => {
    const catalogue = [
      candidate({ id: "m1", title: "Film One", genres: ["Drama"] }),
      candidate({ id: "s1", title: "Show One", kind: "series", genres: ["Drama"] }),
    ]
    const movies = applyHardFilters(parseIntent("drama movies"), buildCatalogueIndex(catalogue), EMPTY_TASTE())
    expect(movies.eligible.map((e) => e.candidate.id)).toEqual(["m1"])
    const series = applyHardFilters(parseIntent("drama series"), buildCatalogueIndex(catalogue), EMPTY_TASTE())
    expect(series.eligible.map((e) => e.candidate.id)).toEqual(["s1"])
  })

  it("excludes confirmed-long / confirmed-old, keeps unknown runtime / year", () => {
    const catalogue = [
      candidate({ id: "long", title: "Epic Long", genres: ["Drama"], runtimeMinutes: 180, year: 2020 }),
      candidate({ id: "short", title: "Tight Short", genres: ["Drama"], runtimeMinutes: 95, year: 2020 }),
      candidate({ id: "unknown", title: "No Metadata", genres: ["Drama"] }),
      candidate({ id: "old", title: "Old One", genres: ["Drama"], runtimeMinutes: 90, year: 1935 }),
    ]
    const underTwo = applyHardFilters(
      parseIntent("drama under two hours"),
      buildCatalogueIndex(catalogue),
      EMPTY_TASTE()
    )
    // "old" is 90 min, so it survives the runtime bound and only
    // falls to the year bound below; "unknown" survives both (unknown
    // metadata is never evidence of contradiction).
    expect(underTwo.eligible.map((e) => e.candidate.id).sort()).toEqual(["old", "short", "unknown"])
    const after2015 = applyHardFilters(
      parseIntent("drama after 2015"),
      buildCatalogueIndex(catalogue),
      EMPTY_TASTE()
    )
    expect(after2015.eligible.map((e) => e.candidate.id).sort()).toEqual(["long", "short", "unknown"])
  })

  it("excludes watched when the query asks for unseen, and disliked / not-interested always", () => {
    let taste = EMPTY_TASTE()
    taste = recordFeedback(taste, { kind: "movie", id: "seen", title: "Seen It", action: "dislike", genres: ["Drama"] })
    taste.notInterestedKeys = ["movie:boring"]
    const catalogue = [
      candidate({ id: "seen", title: "Seen It", genres: ["Drama"] }),
      candidate({ id: "boring", title: "Boring One", genres: ["Drama"] }),
      candidate({ id: "fresh", title: "Fresh One", genres: ["Drama"] }),
    ]
    const out = applyHardFilters(
      parseIntent("drama i haven't seen"),
      buildCatalogueIndex(catalogue),
      taste,
      { watchedKeys: new Set(["movie:fresh", "movie:seen"]) }
    )
    expect(out.eligible.map((e) => e.candidate.id)).toEqual([])
    // Without the not-watched ask, the unseen title survives (the
    // disliked / not-interested ones still do not).
    const out2 = applyHardFilters(
      parseIntent("drama"),
      buildCatalogueIndex(catalogue),
      taste,
      { watchedKeys: new Set(["movie:fresh"]) }
    )
    expect(out2.eligible.map((e) => e.candidate.id)).toEqual(["fresh"])
  })

  it("excludes known non-comedy for a comedy request, keeps no-genre unknowns", () => {
    const catalogue = [
      candidate({ id: "c", title: "Funny One", genres: ["Comedy"] }),
      candidate({ id: "f", title: "Family One", genres: ["Family"] }),
      candidate({ id: "u", title: "Unknown One", genres: [] }),
    ]
    const out = applyHardFilters(parseIntent("comedy"), buildCatalogueIndex(catalogue), EMPTY_TASTE())
    expect(out.eligible.map((e) => e.candidate.id).sort()).toEqual(["c", "u"])
  })
})

describe("retrieveCandidates — the production regression", () => {
  it("ranks the dark anime at catalogue position 25 first, ahead of every punctuation-first film", () => {
    const catalogue = punctuationFirstCatalogue()
    const out = retrieveCandidates("some fucked up dark anime", catalogue, EMPTY_TASTE())
    expect(out.ranked[0].candidate.title).toBe("Perfect Blue")
    expect(out.ranked[0].relevanceScore).toBeGreaterThan(50)
    // The shortlist is the top of `ranked` by RELEVANCE, and the anime
    // leads it. Only 3 titles survive the anime hard filter here
    // (Perfect Blue, plus the two animation unknowns) — the shortlist
    // never pads itself with titles that contradict the request.
    expect(out.shortlist[0].title).toBe("Perfect Blue")
    expect(out.shortlist.length).toBeLessThanOrEqual(RETRIEVAL_SHORTLIST_MAX)
    expect(out.shortlist.length).toBe(out.eligibleCount)
    // No punctuation-first live-action film outranks the anime.
    const animeIdx = out.ranked.findIndex((r) => r.candidate.title === "Perfect Blue")
    expect(animeIdx).toBe(0)
    expect(out.eligibleCount).toBeLessThan(catalogue.length)
    expect(out.excludedCount).toBeGreaterThan(0)
    expect(out.exclusionReasons["not-anime"]).toBeGreaterThan(0)
  })

  it("a relevant item beyond position 20 beats highly rated irrelevant early entries", () => {
    // 25 irrelevant-but-gloriously-rated comedies, then the one horror
    // the query actually wants — rated lower, with fewer votes. The
    // query states tones only (no hard genre), so the comedies survive
    // the hard filter and must still lose on relevance alone.
    const catalogue: RetrievableCandidate[] = Array.from({ length: 25 }, (_, i) =>
      candidate({
        id: `early-${i}`,
        title: `Comedy Hit ${i}`,
        genres: ["Comedy"],
        rating: 9.9,
        voteCount: 50000,
        year: 2024,
      })
    )
    catalogue.push(
      candidate({
        id: "late",
        title: "The Dark Woods",
        genres: ["Horror", "Thriller"],
        rating: 7.0,
        voteCount: 800,
        year: 2023,
        overview: "A dark, disturbing night in the woods.",
      })
    )
    const out = retrieveCandidates("something dark and scary", catalogue, EMPTY_TASTE())
    expect(out.ranked[0].candidate.id).toBe("late")
    expect(out.shortlist[0].id).toBe("late")
    // Query relevance dominates rating: the 9.9 comedies never lead,
    // and the relevant title scores far above every one of them.
    expect(out.ranked[0].relevanceScore).toBeGreaterThan(out.ranked[1].relevanceScore * 3)
    expect(out.ranked[1].candidate.genres).toContain("Comedy")
  })

  it("returns an honest empty result (with a reason) when nothing can match", () => {
    const catalogue = [
      candidate({ id: "1", title: "Comedy One", genres: ["Comedy"] }),
      candidate({ id: "2", title: "Drama One", genres: ["Drama"] }),
    ]
    const out = retrieveCandidates("some fucked up dark anime", catalogue, EMPTY_TASTE())
    expect(out.ranked).toHaveLength(0)
    expect(out.shortlist).toHaveLength(0)
    expect(out.emptyReason).toMatch(/anime/)
  })

  it("caps the shortlist at 20 with one title-group each", () => {
    const catalogue: RetrievableCandidate[] = Array.from({ length: 40 }, (_, i) =>
      candidate({
        id: `t${i}`,
        title: `Drama ${i}`,
        genres: ["Drama"],
        rating: 7,
        voteCount: 100,
        year: 2020 + (i % 3),
      })
    )
    // Language variants of one title must not eat the shortlist.
    catalogue.push(candidate({ id: "dup-fr", title: "Drama 0", genres: ["Drama"], rating: 7, voteCount: 100, year: 2020 }))
    const out = retrieveCandidates("drama", catalogue, EMPTY_TASTE())
    expect(out.shortlist.length).toBeLessThanOrEqual(RETRIEVAL_SHORTLIST_MAX)
    const keys = out.shortlist.map((c) => `${c.title}|${c.year}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("keeps local taste as a small tiebreak, never above the query", () => {
    let taste = EMPTY_TASTE()
    taste = recordFeedback(taste, {
      kind: "movie", id: "fav", title: "Fav Drama",
      action: "like", genres: ["Drama"], cast: [], runtimeMinutes: 100,
    })
    const catalogue = [
      candidate({ id: "drama", title: "Plain Drama", genres: ["Drama"], rating: 6.0, voteCount: 100 }),
      candidate({ id: "horror", title: "Dark Horror", genres: ["Horror"], rating: 6.0, voteCount: 100, overview: "A dark disturbing tale." }),
    ]
    const out = retrieveCandidates("dark", catalogue, taste)
    // The query match wins even though taste prefers drama.
    expect(out.ranked[0].candidate.id).toBe("horror")
  })
})
