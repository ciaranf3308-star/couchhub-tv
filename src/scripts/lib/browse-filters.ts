// Pure Year + Rating filter helpers for the Browse movies/series
// grids (couch-movies.ts / couch-series.ts).
//
// The legacy controller-navigable chip system that used to live here
// (mountBrowseFilters) is gone: its only callers were the legacy
// standalone /movies and /series entry scripts (movies.ts /
// series.ts), deleted in the 0.8.0 Browse consolidation when those
// pages became redirects into /browse. Browse now filters with one
// labelled Genre select + Sort / Decade / Rating selects — no
// per-value pill chips. The pure helpers below stay: the Browse
// adapters use parseYear / yearMatches / ratingMatches, and
// computeYearOptions lists the decades actually present in a catalog.
//
// Filters are per-playlist + per-kind, persisted in preferences.js
// (browseFilters), and apply at the display-group level in the
// adapter's filter — the same level hide-watched and the language
// filter use — so a filter can never hide a variant the group
// display entry still represents. "All" is always the default, so
// nothing in the library can become unfindable through these filters.
import { ratingSortValue } from "@/scripts/lib/format.js"

/** Decade keys, newest first. "older" means before 1980. */
export const YEAR_ORDER = ["2030s", "2020s", "2010s", "2000s", "1990s", "1980s", "older"]
export const RATING_OPTIONS = [0, 6, 7, 8, 9]

/** First 4-digit year in a catalog `year` value ("2024", "2024-03-01", ...). */
export function parseYear(value: unknown): number | null {
  const match = String(value ?? "").match(/(\d{4})/)
  if (!match) return null
  const year = Number(match[1])
  return year >= 1900 && year <= 2100 ? year : null
}

export function decadeKeyForYear(year: number | null): string {
  if (year == null) return ""
  if (year < 1980) return "older"
  return `${Math.floor(year / 10) * 10}s`
}

export function yearMatches(yearValue: unknown, filter: string): boolean {
  if (!filter) return true
  const year = parseYear(yearValue)
  if (year == null) return false
  return decadeKeyForYear(year) === filter
}

/** Minimum rating on the 0-10 scale. Titles with no rating read as 0, so
    any minimum rating hides unrated titles rather than guessing. */
export function ratingMatches(rating: unknown, minRating: number): boolean {
  if (!minRating) return true
  return ratingSortValue(rating) >= minRating
}

/** Only the decades actually present in the catalog, newest first. */
export function computeYearOptions(entries: Array<{ year?: unknown }>): string[] {
  const present = new Set<string>()
  for (const entry of entries || []) {
    const year = parseYear(entry?.year)
    if (year != null) present.add(decadeKeyForYear(year))
  }
  return YEAR_ORDER.filter((key) => present.has(key))
}
