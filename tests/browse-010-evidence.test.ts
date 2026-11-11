// C2 evidence preference on the Movies / Series row layer (0.10.0
// integration — the confidence fix "across Home, Movies, Series").
//
// MovieRow / SeriesRow carry no vote counts; the only evidence
// signal they have is the provider's TMDb link. A no-vote 10.0 with
// no link must never headline a rating-ranked selection while any
// linked title qualifies — but a library with no links at all must
// not empty out (preferEvidence falls back to the full pool).
import { describe, it, expect } from "vitest";
import { preferEvidence } from "@/scripts/lib/recommendations";
import {
  movieGenreCollections,
  pickFeaturedMovie,
  mapMovieRow,
} from "@/scripts/movies/couch-movies";
import {
  seriesGenreCollections,
  pickFeaturedSeries,
  mapSeriesRow,
} from "@/scripts/series/couch-series";

function movie(overrides: Record<string, unknown> = {}) {
  const row = mapMovieRow({
    stream_id: overrides.id ?? 1,
    name: overrides.name ?? "Test Film",
    year: "2024",
    rating: overrides.rating ?? "8.0",
    duration: "100 min",
    category_name: overrides.category ?? "Action",
    added: overrides.added ?? 1,
    tmdb: overrides.tmdb ?? 123,
  });
  if (!row) throw new Error("fixture movie row did not map");
  return row;
}

function series(overrides: Record<string, unknown> = {}) {
  const row = mapSeriesRow({
    series_id: overrides.id ?? 1,
    name: overrides.name ?? "Test Series",
    year: "2024",
    rating: overrides.rating ?? "8.0",
    category_name: overrides.category ?? "Drama",
    added: overrides.added ?? 1,
    tmdb: overrides.tmdb ?? 456,
  });
  if (!row) throw new Error("fixture series row did not map");
  return row;
}

describe("preferEvidence (C2 row layer)", () => {
  it("keeps linked rows and drops unlinked ones when any link exists", () => {
    const rows = [
      { id: 1, tmdb: 123 },
      { id: 2, tmdb: null },
      { id: 3, tmdb: 0 },
      { id: 4 },
    ];
    expect(preferEvidence(rows).map((r) => r.id)).toEqual([1]);
  });

  it("falls back to the full pool when nothing is linked (rails never empty)", () => {
    const rows = [
      { id: 1, tmdb: null },
      { id: 2 },
    ];
    expect(preferEvidence(rows)).toEqual(rows);
    expect(preferEvidence([])).toEqual([]);
  });
});

describe("B08 genre collections — evidence preference", () => {
  it("a no-vote 10.0 with no TMDb link never tops a genre collection", () => {
    const rows = [
      movie({ id: 1, name: "Linked Eight", rating: "8.0", tmdb: 111 }),
      movie({ id: 2, name: "Unproven Ten", rating: "10.0", tmdb: 0 }),
    ];
    const action = movieGenreCollections(rows).find((c) => c.id === "movies-genre-action");
    expect(action?.rows.map((r) => r.name)).toEqual(["Linked Eight"]);
  });

  it("a series crime-drama collection demotes the unlinked 10.0", () => {
    const rows = [
      series({ id: 1, name: "Linked Crime", rating: "8.5", category: "Crime", tmdb: 222 }),
      series({ id: 2, name: "Unproven Ten", rating: "10.0", category: "Crime", tmdb: 0 }),
    ];
    const crime = seriesGenreCollections(rows).find((c) => c.id === "series-genre-crime-drama");
    expect(crime?.rows.map((r) => r.name)).toEqual(["Linked Crime"]);
  });

  it("collections still render when nothing in the library is linked", () => {
    const rows = [
      movie({ id: 1, name: "Unlinked Eight", rating: "8.0", tmdb: 0 }),
      // NB: tmdb must be 0, not null — the helper's `?? 123` would
      // turn a null into a link.
      movie({ id: 2, name: "Unlinked Ten", rating: "10.0", tmdb: 0 }),
    ];
    const action = movieGenreCollections(rows).find((c) => c.id === "movies-genre-action");
    // Fallback: the full pool is used, highest-rated first.
    expect(action?.rows.map((r) => r.name)).toEqual(["Unlinked Ten", "Unlinked Eight"]);
  });
});

describe("Featured — evidence preference", () => {
  it("a linked 8.x headlines over an unlinked 10.0", () => {
    // Four rows so the recent half (top 2 by added) holds both the
    // trap and a linked title — the pick must still be the linked one.
    const rows = [
      movie({ id: 1, name: "Linked Eight", rating: "8.0", added: 5, tmdb: 111 }),
      movie({ id: 2, name: "Unproven Ten", rating: "10.0", added: 6, tmdb: 0 }),
      movie({ id: 3, name: "Linked Eight Five", rating: "8.5", added: 4, tmdb: 112 }),
      movie({ id: 4, name: "Linked Seven Five", rating: "7.5", added: 3, tmdb: 113 }),
    ];
    expect(pickFeaturedMovie(rows)?.name).toBe("Linked Eight");
    const srows = [
      series({ id: 1, name: "Linked Eight", rating: "8.0", added: 5, tmdb: 222 }),
      series({ id: 2, name: "Unproven Ten", rating: "10.0", added: 6, tmdb: 0 }),
      series({ id: 3, name: "Linked Eight Five", rating: "8.5", added: 4, tmdb: 223 }),
      series({ id: 4, name: "Linked Seven Five", rating: "7.5", added: 3, tmdb: 224 }),
    ];
    expect(pickFeaturedSeries(srows)?.name).toBe("Linked Eight");
  });
});
