// Controller-navigable Year + Rating chip filters for the /movies and
// /series full-library grids.
//
// Genre already has a controller-navigable filter on both pages (the
// category picker, including the genre categories from the genre index),
// so this module adds the two missing axes: release decade and minimum
// rating. Chips are plain <button>s, so D-pad / spatial navigation moves
// between them and A selects — no hover-only or mouse-only control.
//
// Filters are per-playlist + per-kind, persisted in preferences.js
// (browseFilters), and apply at the display-group level in the page's
// applyFilter() — the same level hide-watched and the language filter
// use — so a filter can never hide a variant the group display entry
// still represents. "All" is always the default, so nothing in the
// library can become unfindable through these filters.
import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
import {
  getBrowseYearFilter,
  setBrowseYearFilter,
  getBrowseMinRating,
  setBrowseMinRating,
} from "@/scripts/lib/preferences.js"
import { ratingSortValue } from "@/scripts/lib/format.js"

export type BrowseKind = "vod" | "series"

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

const CHIP_BASE =
  "browse-filter-chip rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors " +
  "outline-none border min-h-9 " +
  "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:border-accent"
const CHIP_ACTIVE = "bg-accent-soft text-accent border-accent"
const CHIP_IDLE = "text-fg-2 border-line"

export interface BrowseFiltersHandle {
  /** Rebuild the year chips from the loaded catalog (decades present). */
  refreshYears(entries: Array<{ year?: unknown }>): void
  /** Re-read stored filters (e.g. after a playlist switch) and repaint. */
  sync(): void
  getYear(): string
  getMinRating(): number
}

export function mountBrowseFilters(opts: {
  kind: BrowseKind
  containerId: string
  getActivePlaylistId: () => string
  onChange: () => void
}): BrowseFiltersHandle | null {
  const container = document.getElementById(opts.containerId)
  if (!container) return null

  let yearOptions: string[] = []
  let yearGroupEl: HTMLElement | null = null
  let ratingGroupEl: HTMLElement | null = null
  let resetBtn: HTMLButtonElement | null = null

  const getYear = () => getBrowseYearFilter(opts.getActivePlaylistId(), opts.kind)
  const getMinRating = () => getBrowseMinRating(opts.getActivePlaylistId(), opts.kind)

  function yearLabel(key: string): string {
    if (!key) return t("list.filterYearAll")
    if (key === "older") return t("list.filterYearOlder")
    return key
  }

  function ratingLabel(minRating: number): string {
    if (!minRating) return t("list.filterRatingAll")
    return t("list.filterRatingMin", { n: minRating })
  }

  function makeChip(
    label: string,
    active: boolean,
    ariaLabel: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = `${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_IDLE}`
    btn.setAttribute("aria-pressed", String(active))
    btn.setAttribute("aria-label", ariaLabel)
    btn.textContent = label
    btn.addEventListener("click", onClick)
    return btn
  }

  function render() {
    const activeYear = getYear()
    const activeRating = getMinRating()
    container.replaceChildren()

    const wrap = document.createElement("div")
    wrap.className = "flex flex-wrap items-center gap-x-5 gap-y-2"

    // Year group.
    yearGroupEl = document.createElement("div")
    yearGroupEl.className = "flex flex-wrap items-center gap-1.5"
    yearGroupEl.setAttribute("role", "group")
    yearGroupEl.setAttribute("aria-label", t("list.filterYear"))
    const yearTitle = document.createElement("span")
    yearTitle.className = "text-xs font-medium uppercase tracking-wide text-fg-3 px-1"
    yearTitle.textContent = t("list.filterYear")
    yearGroupEl.appendChild(yearTitle)
    const yearKeys = ["", ...yearOptions]
    for (const key of yearKeys) {
      const label = yearLabel(key)
      yearGroupEl.appendChild(
        makeChip(label, key === activeYear, label, () => {
          setBrowseYearFilter(opts.getActivePlaylistId(), opts.kind, key)
          render()
          opts.onChange()
        }),
      )
    }
    wrap.appendChild(yearGroupEl)

    // Rating group.
    ratingGroupEl = document.createElement("div")
    ratingGroupEl.className = "flex flex-wrap items-center gap-1.5"
    ratingGroupEl.setAttribute("role", "group")
    ratingGroupEl.setAttribute("aria-label", t("list.filterRating"))
    const ratingTitle = document.createElement("span")
    ratingTitle.className = "text-xs font-medium uppercase tracking-wide text-fg-3 px-1"
    ratingTitle.textContent = t("list.filterRating")
    ratingGroupEl.appendChild(ratingTitle)
    for (const minRating of RATING_OPTIONS) {
      const label = ratingLabel(minRating)
      ratingGroupEl.appendChild(
        makeChip(label, minRating === activeRating, label, () => {
          setBrowseMinRating(opts.getActivePlaylistId(), opts.kind, minRating)
          render()
          opts.onChange()
        }),
      )
    }
    wrap.appendChild(ratingGroupEl)

    // Reset — only when a filter is actually active.
    resetBtn = document.createElement("button")
    resetBtn.type = "button"
    resetBtn.className =
      "rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors outline-none " +
      "border border-line text-fg-2 min-h-9 " +
      "hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:border-accent"
    resetBtn.textContent = t("list.filterReset")
    resetBtn.addEventListener("click", () => {
      setBrowseYearFilter(opts.getActivePlaylistId(), opts.kind, "")
      setBrowseMinRating(opts.getActivePlaylistId(), opts.kind, 0)
      render()
      opts.onChange()
    })
    resetBtn.hidden = !activeYear && !activeRating
    wrap.appendChild(resetBtn)

    container.appendChild(wrap)
    window.SpatialNavigation?.makeFocusable?.()
  }

  function refreshYears(entries: Array<{ year?: unknown }>): void {
    const next = computeYearOptions(entries)
    const changed =
      next.length !== yearOptions.length ||
      next.some((key, i) => key !== yearOptions[i])
    if (!changed) return
    yearOptions = next
    // A stored decade with no titles in this catalog resets to All rather
    // than silently filtering everything out.
    if (getYear() && !yearOptions.includes(getYear())) {
      setBrowseYearFilter(opts.getActivePlaylistId(), opts.kind, "")
    }
    render()
  }

  function sync(): void {
    render()
  }

  // Re-render labels when the locale changes (chips are built DOM, not
  // Astro markup, so the i18n pass does not rewrite them).
  document.addEventListener(LOCALE_EVENT, render)

  render()
  return { refreshYears, sync, getYear, getMinRating }
}
