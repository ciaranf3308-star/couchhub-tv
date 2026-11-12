// Deterministic mocked-model recommendation sets (0.11.6, W5).
//
// What the mocked LLM "generates" for each acceptance test, as
// GeneratedRecommendation objects. These are MOCK outputs — real titles
// are expected here (mocks are not production recommendations), and the
// no-hardcoding rule applies to production code, not test fixtures.
// Every title resolves through tests/fixtures/ai-discovery-3.0-tmdb.ts
// except the deliberately unresolvable ones in Test H.
//
// Title spellings match the catalogue + TMDB fixtures exactly.

import type { GeneratedRecommendation } from "../../src/scripts/lib/ai/generation"

/** The user's own query, verbatim (brief §11 Test D). */
export const DARK_ANIME_QUERY_30 = "Some fucked up dark anime"

function rec(
  title: string,
  year: number | null,
  kind: "movie" | "series",
  reason: string,
  tone: string,
  extra: Partial<GeneratedRecommendation> = {},
): GeneratedRecommendation {
  return { title, year, kind, reason, tone, ...extra }
}

/** Genuine dark anime — the correct answer to DARK_ANIME_QUERY_30. */
export const DARK_ANIME_SET: GeneratedRecommendation[] = [
  rec(
    "Attack on Titan",
    2013,
    "series",
    "Humanity's last stand is brutal, bleak and relentless.",
    "dark and brutal",
  ),
  rec(
    "Death Note",
    2006,
    "series",
    "A psychological cat-and-mouse game with a body count.",
    "dark psychological",
  ),
  rec(
    "Perfect Blue",
    1997,
    "movie",
    "A disturbing descent into paranoia and identity loss.",
    "disturbing psychological",
  ),
  rec(
    "Berserk",
    1997,
    "series",
    "Medieval horror at its most bleak and violent.",
    "bleak and violent",
  ),
  rec(
    "Elfen Lied",
    2004,
    "series",
    "Graphic, tragic and deeply unsettling from the first scene.",
    "dark and violent",
  ),
]

/** Post-2010 dark-anime MOVIES — the refinement answer (Test F). */
export const DARK_ANIME_MOVIES_POST_2010_SET: GeneratedRecommendation[] = [
  rec(
    "Demon Slayer: Mugen Train",
    2020,
    "movie",
    "A dream demon turns a train ride into a nightmare.",
    "dark action",
  ),
  rec(
    "Jujutsu Kaisen 0",
    2021,
    "movie",
    "Curses, grief and brutal sorcery battles.",
    "dark action",
  ),
  rec(
    "Chainsaw Man: Reze Arc",
    2025,
    "movie",
    "A romance that detonates into ultraviolence.",
    "dark and violent",
  ),
]

export const COMEDY_SET: GeneratedRecommendation[] = [
  rec("Superbad", 2007, "movie", "A gloriously filthy coming-of-age night out.", "raunchy comedy"),
  rec("Hot Fuzz", 2007, "movie", "Buddy-cop action played completely straight-faced.", "witty comedy"),
  rec(
    "The Grand Budapest Hotel",
    2014,
    "movie",
    "A caper wrapped in pastel precision.",
    "whimsical comedy",
  ),
]

export const HORROR_SET: GeneratedRecommendation[] = [
  rec("Hereditary", 2018, "movie", "Grief curdles into full-blown dread.", "dread-filled horror"),
  rec("Get Out", 2017, "movie", "Social horror with a razor-sharp hook.", "tense horror"),
  rec("The Babadook", 2014, "movie", "A storybook monster that will not leave.", "creeping horror"),
]

/** Two in the catalogue, two absent (Test B). */
export const MIXED_AVAILABILITY_SET: GeneratedRecommendation[] = [
  rec("Hereditary", 2018, "movie", "Grief curdles into full-blown dread.", "dread-filled horror"),
  rec(
    "The Shawshank Redemption",
    1994,
    "movie",
    "The most rewatchable drama ever made.",
    "hopeful drama",
  ),
  rec("Superbad", 2007, "movie", "A gloriously filthy coming-of-age night out.", "raunchy comedy"),
  rec(
    "Parasite",
    2019,
    "movie",
    "Class warfare disguised as a con-artist caper.",
    "sharp thriller",
  ),
]

/** Strong titles ABSENT from the catalogue (Test C). */
export const STRONG_ABSENT_SET: GeneratedRecommendation[] = [
  rec(
    "The Shawshank Redemption",
    1994,
    "movie",
    "The most rewatchable drama ever made.",
    "hopeful drama",
  ),
  rec(
    "Parasite",
    2019,
    "movie",
    "Class warfare disguised as a con-artist caper.",
    "sharp thriller",
  ),
]

/** Wrong years the TMDB mock must correct (Test H). */
export const WRONG_YEAR_SET: GeneratedRecommendation[] = [
  rec("Dune", 2020, "movie", "Desert-planet epic, a year off in the model's memory.", "epic sci-fi"),
  rec(
    "Blade Runner 2049",
    2018,
    "movie",
    "A replicant mystery, a year off in the model's memory.",
    "noir sci-fi",
  ),
]

/** A wrong/uncertain external id the TMDB mock must override (Test H). */
export const WRONG_EXTERNAL_ID_SET: GeneratedRecommendation[] = [
  rec("Dune", 2021, "movie", "Desert-planet epic.", "epic sci-fi", { externalId: { source: "tmdb", id: "1" } }),
]

/** A year no TMDB candidate can satisfy (Test H: unverified, not guessed). */
export const UNMATCHABLE_YEAR_SET: GeneratedRecommendation[] = [
  rec("Dune", 1995, "movie", "No Dune film exists in 1995.", "epic sci-fi"),
]

/** An invented title TMDB cannot resolve (Test H). */
export const INVENTED_TITLE_SET: GeneratedRecommendation[] = [
  rec("The Glimmering Void", 2023, "movie", "A title the model invented.", "mysterious"),
]

/** Alternative (original-language) title TMDB must resolve (Tests H/I). */
export const ALIAS_TITLE_SET: GeneratedRecommendation[] = [
  rec(
    "Shingeki no Kyojin",
    2013,
    "series",
    "The original Japanese title for Attack on Titan.",
    "dark and brutal",
  ),
]

/** Evangelion: verified, but with NO details record (fallback, Test H). */
export const NO_DETAILS_SET: GeneratedRecommendation[] = [
  rec(
    "Neon Genesis Evangelion",
    1995,
    "series",
    "Teenagers pilot biomechs against the Angels.",
    "dark psychological",
  ),
]
