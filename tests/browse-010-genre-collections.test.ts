// B08 (0.10.0, W2) — genre collections built from real catalogue
// metadata. Movies: Action, Thriller, Comedy, Horror, Science
// Fiction, Drama, Documentary Films, Recently Added. Series: Crime
// Drama, Comedy, Science Fiction, Documentary Series, Reality,
// Recently Added, Continue Watching. Only non-empty collections are
// returned; documentaries never mix with fictional kinds.
import { describe, it, expect } from "vitest";
import {
  movieGenreCollections,
  type MovieRow,
} from "@/scripts/movies/couch-movies.ts";
import {
  seriesGenreCollections,
  type SeriesRow,
} from "@/scripts/series/couch-series.ts";

function movieRow(overrides: Partial<MovieRow> = {}): MovieRow {
  return {
    id: 1,
    name: "Test Film",
    logo: null,
    year: "2024",
    rating: "8.0",
    duration: "120",
    category: "Action",
    plot: "",
    added: 100,
    norm: "test film",
    tmdb: null,
    ...overrides,
  };
}

function seriesRow(overrides: Partial<SeriesRow> = {}): SeriesRow {
  return {
    id: 1,
    name: "Test Series",
    logo: null,
    year: "2024",
    rating: "8.0",
    category: "Drama",
    plot: "",
    added: 100,
    norm: "test series",
    tmdb: null,
    ...overrides,
  };
}

describe("movieGenreCollections (B08)", () => {
  const rows: MovieRow[] = [
    movieRow({ id: 1, name: "Alpha", category: "Action", rating: "9.0", added: 300 }),
    movieRow({ id: 2, name: "Beta", category: "Action Thriller", rating: "7.0", added: 100 }),
    movieRow({ id: 3, name: "Gamma", category: "Comedy", rating: "8.0", added: 200 }),
    movieRow({ id: 4, name: "Delta", category: "Documentary", rating: "9.5", added: 400 }),
    movieRow({ id: 5, name: "Epsilon", category: "Documentary Drama", rating: "6.0", added: 50 }),
    movieRow({ id: 6, name: "Zeta", category: "Horror", rating: "", added: 250 }),
  ];

  it("returns the B08 collections in order, highest-rated first", () => {
    const collections = movieGenreCollections(rows);
    expect(collections.map((c) => c.title)).toEqual([
      "Action",
      "Thriller",
      "Comedy",
      "Horror",
      "Documentary Films",
      "Recently Added",
    ]);
    // No Drama collection: the only Drama row is a documentary.
    expect(collections.map((c) => c.title)).not.toContain("Drama");
    expect(collections.map((c) => c.title)).not.toContain("Science Fiction");
    const action = collections.find((c) => c.title === "Action")!;
    expect(action.rows.map((r) => r.name)).toEqual(["Alpha", "Beta"]);
    const recent = collections.find((c) => c.title === "Recently Added")!;
    expect(recent.rows.map((r) => r.name)).toEqual([
      "Delta",
      "Alpha",
      "Zeta",
      "Gamma",
      "Beta",
      "Epsilon",
    ]);
  });

  it("documentaries never mix with fictional kinds", () => {
    const collections = movieGenreCollections(rows);
    const docs = collections.find((c) => c.title === "Documentary Films")!;
    expect(docs.rows.map((r) => r.name)).toEqual(["Delta", "Epsilon"]);
    // "Documentary Drama" (Epsilon) must not appear in any fictional
    // genre collection — "Recently Added" is a recency list, not a
    // genre collection, so documentaries legitimately appear there.
    for (const collection of collections) {
      if (
        collection.title === "Documentary Films" ||
        collection.title === "Recently Added"
      ) {
        continue;
      }
      expect(collection.rows.map((r) => r.name)).not.toContain("Epsilon");
      expect(collection.rows.map((r) => r.name)).not.toContain("Delta");
    }
  });

  it("returns no collections for an empty catalogue", () => {
    expect(movieGenreCollections([])).toEqual([]);
  });

  it("omits empty or unsupported categories", () => {
    const onlyAction = movieGenreCollections([
      movieRow({ id: 1, name: "Solo", category: "Action", added: 1 }),
    ]);
    expect(onlyAction.map((c) => c.title)).toEqual(["Action", "Recently Added"]);
  });
});

describe("seriesGenreCollections (B08)", () => {
  const rows: SeriesRow[] = [
    seriesRow({ id: 1, name: "Alpha", category: "Crime Drama", rating: "9.0", added: 300 }),
    seriesRow({ id: 2, name: "Beta", category: "Comedy", rating: "7.0", added: 100 }),
    seriesRow({ id: 3, name: "Gamma", category: "Science Fiction", rating: "8.0", added: 200 }),
    seriesRow({ id: 4, name: "Delta", category: "Documentary", rating: "9.5", added: 400 }),
    seriesRow({ id: 5, name: "Epsilon", category: "Reality TV", rating: "6.0", added: 50 }),
    seriesRow({ id: 6, name: "Zeta", category: "Crime Documentary", rating: "8.5", added: 250 }),
  ];

  it("returns the B08 collections in order", () => {
    const collections = seriesGenreCollections(rows);
    expect(collections.map((c) => c.title)).toEqual([
      "Crime Drama",
      "Comedy",
      "Science Fiction",
      "Documentary Series",
      "Reality",
      "Recently Added",
    ]);
    const crime = collections.find((c) => c.title === "Crime Drama")!;
    expect(crime.rows.map((r) => r.name)).toEqual(["Alpha"]);
    const reality = collections.find((c) => c.title === "Reality")!;
    expect(reality.rows.map((r) => r.name)).toEqual(["Epsilon"]);
  });

  it("a crime documentary is a documentary, never crime drama", () => {
    const collections = seriesGenreCollections(rows);
    const crime = collections.find((c) => c.title === "Crime Drama")!;
    expect(crime.rows.map((r) => r.name)).not.toContain("Zeta");
    const docs = collections.find((c) => c.title === "Documentary Series")!;
    expect(docs.rows.map((r) => r.name)).toEqual(["Delta", "Zeta"]);
  });

  it("Continue Watching only appears with in-progress ids", () => {
    expect(
      seriesGenreCollections(rows).map((c) => c.title),
    ).not.toContain("Continue Watching");
    const continuing = seriesGenreCollections(rows, {
      inProgressIds: new Set([2, 5]),
    });
    const collection = continuing.find((c) => c.title === "Continue Watching")!;
    expect(collection.rows.map((r) => r.name)).toEqual(["Beta", "Epsilon"]);
  });

  it("returns no collections for an empty catalogue", () => {
    expect(seriesGenreCollections([])).toEqual([]);
  });
});
