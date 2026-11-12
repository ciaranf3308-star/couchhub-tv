// Shared fixtures for the 0.11.8 Movies Home (W3) tests. Fake rows
// only — no provider, no catalogue load. `added` is epoch SECONDS
// (Xtream convention) unless a test passes milliseconds explicitly.

import type { MovieRow } from "@/scripts/movies/couch-movies";
import { emptyTasteModel, type TasteModel } from "@/scripts/lib/taste";

let nextId = 1000;

export function movieRow(overrides: Partial<MovieRow> = {}): MovieRow {
  const id = overrides.id ?? nextId++;
  const name = overrides.name ?? `Film ${id}`;
  // Explicit nulls must win (e.g. logo: null means "no artwork") —
  // `??` would swallow them back to the default.
  const pick = <K extends keyof MovieRow>(key: K, fallback: MovieRow[K]): MovieRow[K] =>
    overrides[key] !== undefined ? (overrides[key] as MovieRow[K]) : fallback;
  return {
    id,
    name,
    logo: pick("logo", `https://example.invalid/poster-${id}.jpg`),
    year: pick("year", "2024"),
    rating: pick("rating", ""),
    duration: pick("duration", "120"),
    category: pick("category", "Action"),
    plot: pick("plot", ""),
    added: pick("added", 0),
    norm: pick("norm", name.toLowerCase()),
    tmdb: pick("tmdb", null),
    containerExt: pick("containerExt", null),
  };
}

/** Reset the auto-id counter so fixture ids are stable per test file. */
export function resetFixtureIds(start = 1000): void {
  nextId = start;
}

export function tasteWith(
  overrides: Partial<TasteModel> = {},
  base: TasteModel = emptyTasteModel("shared", "playlist-1"),
): TasteModel {
  return { ...base, ...overrides };
}

/** Epoch seconds for "n days ago" relative to `nowMs`. */
export function daysAgoSeconds(days: number, nowMs: number): number {
  return Math.floor((nowMs - days * 24 * 60 * 60 * 1000) / 1000);
}
