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

// ── C5 — shared controller-friendly filter API (0.10.0) ──────────
// W2 (Movies / Series pages) consumes this API; W3 (Discover) does
// not add its own filter system. One labelled select (or, for
// <=4-option filters, one segmented control) per filter — never
// per-value pill chips. A filter is ONLY offered when the available
// metadata supports it: computeFilterAvailability() gates every
// control, and filterControlDescriptors() marks unsupported ones
// disabled instead of hiding them silently (a disabled control says
// "this catalogue has no data for that", a missing one says nothing).
//
// Persistence (detail → back): W2 saves the state with
// saveBrowseFilterState(scope, state) whenever a control changes and
// restores it with loadBrowseFilterState(scope) before first render.
// Focus survival is couch-focus.ts's job (focus memory by stable
// data-couch-key); the two compose — filters first, focus second —
// so going into a detail page and back lands on the same card in the
// same filtered list.

/** Sort orders the shared API offers. The first six are the orders
 *  the Movies / Series adapters already implement (MovieSortMode /
 *  SeriesSortMode); the two runtime orders are availability-gated —
 *  offered only when runtime metadata is present — and
 *  sortBrowseEntries() provides their comparators. */
export type BrowseSortId =
  | "default"
  | "added"
  | "rating"
  | "year-desc"
  | "year-asc"
  | "az"
  | "runtime-asc"
  | "runtime-desc"

export const SORT_OPTIONS: Array<{ value: BrowseSortId; label: string }> = [
  { value: "default", label: "Default" },
  { value: "added", label: "Recently added" },
  { value: "rating", label: "Highest rated" },
  { value: "year-desc", label: "Newest first" },
  { value: "year-asc", label: "Oldest first" },
  { value: "az", label: "A–Z" },
  { value: "runtime-asc", label: "Shortest first" },
  { value: "runtime-desc", label: "Longest first" },
]

/** Runtime buckets (max minutes). 0 = any length. */
export const RUNTIME_OPTIONS = [0, 60, 90, 120, 150, 180]

export const RUNTIME_OPTION_LABELS: Record<number, string> = {
  0: "Any length",
  60: "Under 1 hour",
  90: "Under 1½ hours",
  120: "Under 2 hours",
  150: "Under 2½ hours",
  180: "Under 3 hours",
}

/** One filter state for a Movies / Series browse scope. "" / 0 mean
 *  "any" on every field, so the default state filters nothing. */
export interface BrowseFilterState {
  /** Canonical genre id (e.g. "action") or a genre label. "" = any. */
  genre: string
  /** Content type within Browse: "movie" | "series". "" = any. */
  contentType: string
  /** Decade key from YEAR_ORDER ("2020s", "older", …). "" = any. */
  year: string
  /** Minimum rating on the 0-10 scale. 0 = any. */
  minRating: number
  /** Maximum runtime in minutes. 0 = any length. */
  maxRuntime: number
  sort: BrowseSortId
}

export const DEFAULT_BROWSE_FILTERS: BrowseFilterState = {
  genre: "",
  contentType: "",
  year: "",
  minRating: 0,
  maxRuntime: 0,
  sort: "default",
}

export function isDefaultBrowseFilterState(state: BrowseFilterState): boolean {
  return (
    !state.genre &&
    !state.contentType &&
    !state.year &&
    !state.minRating &&
    !state.maxRuntime &&
    state.sort === "default"
  )
}

/** Which filters the available metadata supports. Computed from the
 *  catalogue itself — never from a guess about the provider. */
export interface BrowseFilterAvailability {
  genre: boolean
  contentType: boolean
  year: boolean
  rating: boolean
  runtime: boolean
  /** Sort ids that have the metadata behind them. "default" and "az"
   *  are always available (title is always present). */
  sorts: BrowseSortId[]
}

/** A catalogue entry as the shared filter API reads it. Adapters
 *  pass their rows through (MovieRow / SeriesRow both fit: `year`,
 *  `rating`, `duration`, `category`, `name`, `added`); `genreIds`
 *  carries canonical genre ids when the adapter has already mapped
 *  them (movieGenres / seriesGenres), `type`/`kind` carries the
 *  provider kind for the content-type filter. */
export interface BrowseFilterEntry {
  year?: unknown
  rating?: unknown
  /** Provider duration ("125 min", "02:05:00", bare seconds/minutes). */
  duration?: unknown
  runtime?: unknown
  genre?: unknown
  genres?: unknown
  genreIds?: unknown
  category?: unknown
  type?: unknown
  kind?: unknown
  title?: unknown
  name?: unknown
  added?: unknown
}

function normToken(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

/** Genre tokens an entry carries: canonical ids first, then any
 *  genre/genre-list/category strings split on common separators. */
export function genreTokensOf(entry: BrowseFilterEntry | null | undefined): string[] {
  if (!entry) return []
  const out: string[] = []
  const push = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) push(item)
      return
    }
    const raw = String(value ?? "").trim()
    if (!raw) return
    for (const part of raw.split(/[,;/|]/)) {
      const token = normToken(part)
      if (token) out.push(token)
    }
  }
  push(entry.genreIds)
  push(entry.genres)
  push(entry.genre)
  push(entry.category)
  return [...new Set(out)]
}

/** Genre match: "" = any; otherwise one of the entry's genre tokens
 *  must equal the requested genre (case-insensitive). */
export function genreMatches(entry: BrowseFilterEntry | null | undefined, genre: string): boolean {
  if (!genre) return true
  const wanted = normToken(genre)
  if (!wanted) return true
  return genreTokensOf(entry).includes(wanted)
}

/** Genres actually present in the catalogue, most frequent first
 *  (labels as the entries carry them — adapters that map to
 *  canonical ids should pass those ids through `genreIds`). */
export function computeGenreOptions(
  entries: Array<BrowseFilterEntry | null | undefined>,
): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries || []) {
    for (const token of genreTokensOf(entry)) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/** Content-type match: "" = any. Reads the provider kind field
 *  only — never the genre/category (a crime documentary is not a
 *  crime drama; kind is taxonomy, genre is an attribute). */
export function contentTypeMatches(
  entry: BrowseFilterEntry | null | undefined,
  contentType: string,
): boolean {
  if (!contentType) return true
  const wanted = normToken(contentType)
  if (!wanted) return true
  const kind = normToken(entry?.type ?? entry?.kind)
  if (wanted === "movie") return kind === "movie" || kind === "film" || kind === "vod"
  if (wanted === "series") return kind === "series" || kind === "show" || kind === "tv"
  return kind === wanted
}

/** Distinct content types present in the catalogue ("movie" /
 *  "series"), normalised through the same mapping as
 *  contentTypeMatches. */
export function computeContentTypeOptions(
  entries: Array<BrowseFilterEntry | null | undefined>,
): string[] {
  const present = new Set<string>()
  for (const entry of entries || []) {
    const kind = normToken(entry?.type ?? entry?.kind)
    if (kind === "movie" || kind === "film" || kind === "vod") present.add("movie")
    else if (kind === "series" || kind === "show" || kind === "tv") present.add("series")
  }
  return ["movie", "series"].filter((kind) => present.has(kind))
}

// ── Runtime ──────────────────────────────────────────────────────
// Same reading as formatMovieRuntime (couch-movies.ts): "2h 5m",
// "125 min", "02:05:00", a bare number under 1000 = minutes,
// 1000+ = seconds (duration_secs). Returns whole minutes, or null
// when the provider supplied nothing parseable — never a guess.

export function parseRuntimeMinutes(value: unknown): number | null {
  if (value == null || value === "") return null
  const raw = String(value).trim()
  if (!raw) return null
  const hms = raw.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/)
  if (hms) {
    const total =
      Number(hms[1]) * 3600 + Number(hms[2]) * 60 + (hms[3] != null ? Number(hms[3]) : 0)
    return total > 0 ? Math.round(total / 60) : null
  }
  const hm = raw.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*)?(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?\s*)?$/i)
  if (hm && (hm[1] != null || hm[2] != null)) {
    const total = (Number(hm[1] || 0) * 60 + Number(hm[2] || 0))
    return total > 0 ? Math.round(total) : null
  }
  const bare = raw.match(/^(\d+(?:\.\d+)?)\s*(?:min(?:utes?)?)?$/i)
  if (bare) {
    const n = Number(bare[1])
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n >= 1000 ? n / 60 : n)
  }
  return null
}

/** "2h 5m" / "45m" / "1h 30m" from whole minutes. "" for null/<=0. */
export function formatRuntimeMinutes(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return ""
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** Max-runtime match. A title with no parseable runtime cannot be
 *  shown to fit a limit, so any limit hides it rather than guessing. */
export function runtimeMatches(entry: BrowseFilterEntry | null | undefined, maxRuntime: number): boolean {
  if (!maxRuntime) return true
  const minutes = parseRuntimeMinutes(entry?.duration ?? entry?.runtime)
  if (minutes == null) return false
  return minutes <= maxRuntime
}

// ── Availability ─────────────────────────────────────────────────

export function computeFilterAvailability(
  entries: Array<BrowseFilterEntry | null | undefined>,
): BrowseFilterAvailability {
  const list = entries || []
  let genre = false
  let year = false
  let rating = false
  let runtime = false
  let added = false
  for (const entry of list) {
    if (!entry) continue
    if (!genre && genreTokensOf(entry).length > 0) genre = true
    if (!year && parseYear(entry.year) != null) year = true
    if (!rating && ratingSortValue(entry.rating) > 0) rating = true
    if (!runtime && parseRuntimeMinutes(entry.duration ?? entry.runtime) != null) runtime = true
    if (!added && Number(entry.added) > 0) added = true
  }
  const contentTypes = computeContentTypeOptions(list)
  const sorts: BrowseSortId[] = ["default", "az"]
  if (added) sorts.push("added")
  if (rating) sorts.push("rating")
  if (year) sorts.push("year-desc", "year-asc")
  if (runtime) sorts.push("runtime-asc", "runtime-desc")
  return {
    genre,
    contentType: contentTypes.length > 1,
    year,
    rating,
    runtime,
    sorts,
  }
}

// ── Apply + sort (pure) ──────────────────────────────────────────

/** Apply every active filter to a catalogue. Returns a new array in
 *  catalogue order — call sortBrowseEntries for display order. */
export function applyBrowseFilters<T extends BrowseFilterEntry>(
  entries: T[],
  state: BrowseFilterState,
): T[] {
  const genre = state.genre || ""
  const contentType = state.contentType || ""
  const year = state.year || ""
  const minRating = state.minRating || 0
  const maxRuntime = state.maxRuntime || 0
  return (entries || []).filter((entry) => {
    if (!genreMatches(entry, genre)) return false
    if (!contentTypeMatches(entry, contentType)) return false
    if (!yearMatches(entry.year, year)) return false
    if (!ratingMatches(entry.rating, minRating)) return false
    if (!runtimeMatches(entry, maxRuntime)) return false
    return true
  })
}

function entryTitle(entry: BrowseFilterEntry): string {
  return String(entry.title ?? entry.name ?? "")
}

/** Display sort. "default" keeps catalogue order. Unknown sort ids
 *  fall back to catalogue order rather than throwing. */
export function sortBrowseEntries<T extends BrowseFilterEntry>(
  entries: T[],
  sort: BrowseSortId,
): T[] {
  const out = [...(entries || [])]
  const byTitle = (a: T, b: T) =>
    entryTitle(a).localeCompare(entryTitle(b), "en", { sensitivity: "base" })
  switch (sort) {
    case "added":
      out.sort((a, b) => Number(b.added || 0) - Number(a.added || 0) || byTitle(a, b))
      break
    case "rating":
      out.sort(
        (a, b) => ratingSortValue(b.rating) - ratingSortValue(a.rating) || byTitle(a, b),
      )
      break
    case "year-desc":
      out.sort((a, b) => (parseYear(b.year) ?? -1) - (parseYear(a.year) ?? -1) || byTitle(a, b))
      break
    case "year-asc":
      out.sort(
        (a, b) =>
          (parseYear(a.year) ?? Number.POSITIVE_INFINITY) -
            (parseYear(b.year) ?? Number.POSITIVE_INFINITY) || byTitle(a, b),
      )
      break
    case "az":
      out.sort(byTitle)
      break
    case "runtime-asc":
      out.sort(
        (a, b) =>
          (parseRuntimeMinutes(a.duration ?? a.runtime) ?? Number.POSITIVE_INFINITY) -
            (parseRuntimeMinutes(b.duration ?? b.runtime) ?? Number.POSITIVE_INFINITY) ||
          byTitle(a, b),
      )
      break
    case "runtime-desc":
      out.sort(
        (a, b) =>
          (parseRuntimeMinutes(b.duration ?? b.runtime) ?? -1) -
            (parseRuntimeMinutes(a.duration ?? a.runtime) ?? -1) || byTitle(a, b),
      )
      break
    case "default":
    default:
      break
  }
  return out
}

// ── Control descriptors (what W2 renders) ───────────────────────
// One descriptor per filter. `kind` is always "select" for the
// rendered control; filters with <=4 options may instead render as
// a segmented control using the same options (see .rs-filter-* in
// couch.css) — never one pill per value. `disabled` means the
// catalogue has no metadata for that filter; render it disabled,
// not absent.

export interface FilterOption {
  value: string
  label: string
}

export interface FilterControlDescriptor {
  id: keyof Omit<BrowseFilterState, "sort"> | "sort"
  label: string
  kind: "select"
  value: string
  options: FilterOption[]
  disabled: boolean
}

export interface FilterDescriptorOptions {
  /** Genre options the adapter offers (canonical ids + labels).
   *  Defaults to computeGenreOptions(entries) when omitted. */
  genres?: Array<{ id: string; label?: string; count?: number }>
  /** Content-type options. Defaults to computeContentTypeOptions. */
  contentTypes?: Array<{ id: string; label?: string }>
}

const CONTENT_TYPE_LABELS: Record<string, string> = {
  movie: "Movies",
  series: "Series",
}

export function filterControlDescriptors(
  state: BrowseFilterState,
  availability: BrowseFilterAvailability,
  entries: Array<BrowseFilterEntry | null | undefined>,
  opts: FilterDescriptorOptions = {},
): FilterControlDescriptor[] {
  const genreOptions =
    opts.genres ??
    computeGenreOptions(entries).map((g) => ({ id: g.id, label: g.id, count: g.count }))
  const contentTypeOptions =
    opts.contentTypes ??
    computeContentTypeOptions(entries).map((id) => ({ id, label: CONTENT_TYPE_LABELS[id] ?? id }))
  const yearOptions = computeYearOptions(
    (entries || []).map((e) => ({ year: e?.year })),
  )
  const sortOptions = SORT_OPTIONS.filter((o) => availability.sorts.includes(o.value))
  return [
    {
      id: "genre",
      label: "Genre",
      kind: "select",
      value: state.genre || "",
      options: [
        { value: "", label: "All genres" },
        ...genreOptions.map((g) => ({
          value: g.id,
          label: g.label ?? g.id,
        })),
      ],
      disabled: !availability.genre,
    },
    {
      id: "contentType",
      label: "Type",
      kind: "select",
      value: state.contentType || "",
      options: [
        { value: "", label: "Movies & Series" },
        ...contentTypeOptions.map((t) => ({ value: t.id, label: t.label ?? t.id })),
      ],
      disabled: !availability.contentType,
    },
    {
      id: "year",
      label: "Decade",
      kind: "select",
      value: state.year || "",
      options: [
        { value: "", label: "Any decade" },
        ...yearOptions.map((key) => ({ value: key, label: key })),
      ],
      disabled: !availability.year,
    },
    {
      id: "minRating",
      label: "Rating",
      kind: "select",
      value: String(state.minRating || 0),
      options: RATING_OPTIONS.map((min) => ({
        value: String(min),
        label: min === 0 ? "Any rating" : `${min}+`,
      })),
      disabled: !availability.rating,
    },
    {
      id: "maxRuntime",
      label: "Length",
      kind: "select",
      value: String(state.maxRuntime || 0),
      options: RUNTIME_OPTIONS.map((max) => ({
        value: String(max),
        label: RUNTIME_OPTION_LABELS[max] ?? `Under ${max} min`,
      })),
      disabled: !availability.runtime,
    },
    {
      id: "sort",
      label: "Sort",
      kind: "select",
      value: state.sort || "default",
      options: sortOptions.map((o) => ({ value: o.value, label: o.label })),
      disabled: false,
    },
  ]
}

// ── Persistence: sessionStorage (detail → back) ──────────────────
// Keyed per browse scope ("movies", "series", "browse"). Corrupt or
// partial stored state falls back to the default for the missing
// fields — a bad stored value can never hide the catalogue. All
// storage access is guarded: private mode / disabled storage just
// means filters reset to default on the next visit, never a crash.

export const FILTER_STORAGE_PREFIX = "rs-browse-filters-v1"

export function browseFilterStorageKey(scope: string): string {
  return `${FILTER_STORAGE_PREFIX}:${(scope || "browse").trim() || "browse"}`
}

export function serializeBrowseFilterState(state: BrowseFilterState): string {
  return JSON.stringify({
    genre: state.genre || "",
    contentType: state.contentType || "",
    year: state.year || "",
    minRating: state.minRating || 0,
    maxRuntime: state.maxRuntime || 0,
    sort: state.sort || "default",
  })
}

/** Parse stored/URL state. Unknown values fall back to defaults. */
export function parseBrowseFilterState(raw: unknown): BrowseFilterState {
  const fallback = { ...DEFAULT_BROWSE_FILTERS }
  if (raw == null) return fallback
  let data: Record<string, unknown>
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return fallback
    }
  } else if (typeof raw === "object") {
    data = raw as Record<string, unknown>
  } else {
    return fallback
  }
  const sortValues = SORT_OPTIONS.map((o) => o.value)
  return {
    genre: typeof data.genre === "string" ? data.genre : "",
    contentType: typeof data.contentType === "string" ? data.contentType : "",
    year:
      typeof data.year === "string" && (data.year === "" || YEAR_ORDER.includes(data.year))
        ? data.year
        : "",
    minRating:
      typeof data.minRating === "number" && RATING_OPTIONS.includes(data.minRating)
        ? data.minRating
        : 0,
    maxRuntime:
      typeof data.maxRuntime === "number" && RUNTIME_OPTIONS.includes(data.maxRuntime)
        ? data.maxRuntime
        : 0,
    sort:
      typeof data.sort === "string" && (sortValues as string[]).includes(data.sort)
        ? (data.sort as BrowseSortId)
        : "default",
  }
}

function filterStorage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null
  } catch {
    return null
  }
}

export function saveBrowseFilterState(scope: string, state: BrowseFilterState): void {
  try {
    filterStorage()?.setItem(browseFilterStorageKey(scope), serializeBrowseFilterState(state))
  } catch {
    // Storage full / unavailable: filters are a nicety, never fatal.
  }
}

export function loadBrowseFilterState(scope: string): BrowseFilterState | null {
  let raw: string | null = null
  try {
    raw = filterStorage()?.getItem(browseFilterStorageKey(scope)) ?? null
  } catch {
    return null
  }
  if (raw == null) return null
  return parseBrowseFilterState(raw)
}

export function clearBrowseFilterState(scope: string): void {
  try {
    filterStorage()?.removeItem(browseFilterStorageKey(scope))
  } catch {
    // Ignore.
  }
}
