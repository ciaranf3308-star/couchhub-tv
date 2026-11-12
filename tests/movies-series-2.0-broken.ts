// 0.11.8 TEST STUB — DELIBERATELY BROKEN VARIANTS (red verification).
//
// Each export below breaks EXACTLY ONE contract rule. The red-
// verification tests (tests/movies-series-2.0-red-verification.test.ts)
// run the same requirement predicates against these variants and
// assert the requirement is VIOLATED — proving the green tests
// actually test the requirement instead of passing vacuously.
// NEVER import this file from a green test. Deleted at integration
// along with the correct stubs.

import {
  applyFilters as correctApplyFilters,
  baseTitleOf,
  compareByRatingEvidence,
  createBrowseState,
  deriveBrowsePage as correctDerive,
  groupEntries as correctGroupEntries,
  normaliseRating,
  runtimeMinutesOf,
  selectCategory as correctSelectCategory,
  selectWorthWatching as correctWorthWatching,
  type BrowseFilterPatch,
  type BrowseState,
  type CatalogEntry,
  type CatalogIndex,
  type EntryGroup,
  type SelectorOptions,
} from "./movies-series-2.0-stubs.ts"

// --- BROKEN 1: genre selection INTERSECTS (the 0.11.5 user-reported bug).
// Selecting Horror after Comedy keeps Comedy as a hidden constraint.
export interface IntersectingState extends BrowseState {
  hiddenGenres: string[]
}

export function brokenSelectGenreIntersect(
  state: BrowseState,
  genre: string
): IntersectingState {
  const prev = (state as IntersectingState).hiddenGenres ?? []
  const base = correctApplyFilters(state, { genre })
  return { ...base, hiddenGenres: [...prev, genre] }
}

/** Derivation honouring the hidden accumulated genres (AND semantics). */
export function brokenDeriveWithHiddenGenres(
  index: CatalogIndex,
  state: IntersectingState
): CatalogEntry[] {
  const derived = correctDerive(index, state)
  const hidden = state.hiddenGenres ?? []
  if (hidden.length <= 1) {
    return derived.matchedGroups.flatMap((g) => g.variants)
  }
  // AND: an entry must carry EVERY accumulated genre. (Genre
  // membership approximated from the category name + tmdb ids via the
  // correct genresForEntry is overkill here: the category-name check
  // below is enough to demonstrate the intersection.)
  return derived.matchedGroups
    .flatMap((g) => g.variants)
    .filter((entry) =>
      hidden.every(
        (genre) =>
          entry.categoryName.toLowerCase().includes(genre) ||
          entry.genreString.toLowerCase().includes(genre)
      )
    )
}

// --- BROKEN 2: grouping merges distinct titles (ignores year + kind).
export function brokenGroupEntries(entries: CatalogEntry[]): EntryGroup[] {
  const groups = new Map<string, EntryGroup>()
  for (const entry of entries) {
    const key = entry.baseTitle // no kind, no year: collisions merge
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        kind: entry.kind,
        baseTitle: entry.baseTitle,
        year: entry.yearNum,
        representative: entry,
        variants: [],
      }
      groups.set(key, group)
    }
    group.variants.push(entry)
  }
  return [...groups.values()]
}

// --- BROKEN 3: rating filter passes unknowns (unknown reads as 10).
export function brokenRatingPassesUnknown(
  entries: CatalogEntry[],
  minRating: number
): CatalogEntry[] {
  return entries.filter((entry) => {
    const r = normaliseRating(entry)
    const value = r.hasEvidence ? (r.value as number) : 10
    return value >= minRating
  })
}

// --- BROKEN 4: pagination drops the last partial page (floor, not ceil).
export function brokenPageCountFor(totalGroups: number, pageSize: number): number {
  if (totalGroups <= 0) return 0
  return Math.floor(totalGroups / Math.max(1, pageSize))
}

export function brokenPageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const pages = brokenPageCountFor(items.length, pageSize)
  const clamped = Math.max(0, Math.min(page, Math.max(0, pages - 1)))
  return items.slice(clamped * pageSize, clamped * pageSize + pageSize)
}

// --- BROKEN 5: Recently Added sorts by release year, not `added`.
export function brokenRecentlyAddedByYear(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry[] {
  const limit = opts?.limit ?? 12
  return [...index.entries]
    .filter((e) => e.kind === index.kind)
    .sort((a, b) => (b.yearNum ?? 0) - (a.yearNum ?? 0) || a.id - b.id)
    .slice(0, limit)
}

// --- BROKEN 6: Worth Watching = first 12 rating-8 titles in catalogue order.
export function brokenWorthWatchingFirstTwelve(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry[] {
  const limit = opts?.limit ?? 12
  return index.entries
    .filter((e) => {
      if (e.kind !== "vod") return false
      const r = normaliseRating(e)
      return r.hasEvidence && (r.value as number) >= 8
    })
    .slice(0, limit)
}

// --- BROKEN 7: Continue Watching includes completed + untouched + barely-started.
export function brokenContinueWatchingEverything(
  index: CatalogIndex,
  opts?: SelectorOptions
): CatalogEntry[] {
  const limit = opts?.limit ?? 20
  const progress = opts?.progress
  if (!progress) return index.entries.slice(0, limit)
  const ids = new Set<number>()
  if (progress instanceof Map) {
    for (const id of progress.keys()) ids.add(id)
  } else {
    for (const id of Object.keys(progress)) ids.add(Number(id))
  }
  // Includes every entry with ANY progress row, completed or 12s in,
  // plus untouched entries to fill the shelf.
  const withProgress = index.entries.filter((e) => ids.has(e.id))
  const untouched = index.entries.filter((e) => !ids.has(e.id))
  return [...withProgress, ...untouched].slice(0, limit)
}

// --- BROKEN 8: Reset leaves genre + query behind (hidden constraints).
export function brokenResetAllFilters(state: BrowseState): BrowseState {
  const fresh = createBrowseState(state.kind, { pageSize: state.pageSize })
  return { ...fresh, genre: state.genre, query: state.query, searchScope: state.searchScope }
}

// --- BROKEN 9: category change keeps the old page.
export function brokenSelectCategoryKeepsPage(
  state: BrowseState,
  categoryId: string
): BrowseState {
  return { ...state, categoryId }
}

// --- BROKEN 10: "Search Current Category" searches everything.
export function brokenSearchIgnoresScope(
  entries: CatalogEntry[],
  query: string
): CatalogEntry[] {
  const tokens = query.toLowerCase().split(" ").filter(Boolean)
  return entries.filter((entry) =>
    tokens.every((t) =>
      `${entry.name} ${entry.categoryName} ${entry.year}`.toLowerCase().includes(t)
    )
  )
}

// --- BROKEN 11: runtime filter passes unknown runtimes.
export function brokenRuntimePassesUnknown(
  entries: CatalogEntry[],
  maxRuntime: number
): CatalogEntry[] {
  return entries.filter((entry) => {
    const mins = runtimeMinutesOf(entry)
    if (mins == null) return true
    return mins <= maxRuntime
  })
}

// --- BROKEN 12: season counts fabricated (unknown reads as 1 season).
export function brokenSeasonCount(entry: CatalogEntry): number {
  return entry.seasonCount ?? 1
}

// --- BROKEN 13: rating sort puts unrated titles FIRST.
export function brokenRatingSortUnratedFirst(
  entries: CatalogEntry[]
): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    const ra = normaliseRating(a)
    const rb = normaliseRating(b)
    if (ra.hasEvidence !== rb.hasEvidence) return ra.hasEvidence ? 1 : -1
    return compareByRatingEvidence(a, b)
  })
}

// --- BROKEN 14: naive episode diff keyed by provider id ONLY.
// A provider id remap (same S/E, new ids) reads as all-new episodes.
export function brokenNaiveEpisodeDiff(
  baseline: Array<{ episodeId?: number | null; season: number; episode: number }>,
  snapshot: Array<{ episodeId?: number | null; season: number; episode: number }>
): Array<{ episodeId?: number | null; season: number; episode: number }> {
  const oldIds = new Set(baseline.map((ep) => ep.episodeId))
  return snapshot.filter((ep) => !oldIds.has(ep.episodeId))
}

// --- BROKEN 15: home mount renders the FULL catalogue grid.
export function brokenHomeRendersFullCatalogue(
  container: HTMLElement,
  entries: CatalogEntry[]
): number {
  const doc = container.ownerDocument
  for (const entry of entries) {
    const card = doc.createElement("button")
    card.type = "button"
    card.setAttribute("data-home-card", "")
    card.textContent = entry.displayTitle
    container.appendChild(card)
  }
  return container.querySelectorAll("[data-home-card]").length
}

// --- BROKEN 16: filter drawer with no focus trap and no focus restore.
export function brokenOpenDrawer(container: HTMLElement): HTMLElement {
  const doc = container.ownerDocument
  const panel = doc.createElement("div")
  panel.setAttribute("role", "dialog")
  panel.setAttribute("data-filter-drawer", "")
  const button = doc.createElement("button")
  button.type = "button"
  button.textContent = "Done"
  panel.appendChild(button)
  container.appendChild(panel)
  // No trap: Tab leaves the drawer. No invoker recorded: close drops
  // focus to <body>.
  return panel
}

export function brokenCloseDrawer(panel: HTMLElement): void {
  panel.remove()
  ;(panel.ownerDocument.activeElement as HTMLElement | null)?.blur?.()
}

// --- BROKEN 17: activation with no repeat guard (held Enter re-fires).
export function brokenActivationCountForKeyEvents(
  events: Array<{ key: string; repeat: boolean }>,
  onActivate: () => void
): number {
  let count = 0
  for (const event of events) {
    if (event.key === "Enter") {
      onActivate()
      count += 1
    }
  }
  return count
}

// --- BROKEN 18: stale paint wins (no generation guard; slowest paint lands last).
export async function brokenStalePaintSequence(
  paints: Array<{ label: string; delayMs: number }>,
  paint: (label: string) => void
): Promise<string> {
  let last = ""
  const apply = async (label: string, delayMs: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    paint(label)
    last = label
  }
  // Fire A (slow), then B (fast): without a generation guard the
  // SLOWER, STALE paint lands last and the screen shows A.
  await Promise.all(paints.map((p) => apply(p.label, p.delayMs)))
  return last
}

// Re-export the correct functions the red tests compare against, so a
// red test file imports both sides from the two stub modules.
export const CORRECT = {
  applyFilters: correctApplyFilters,
  selectCategory: correctSelectCategory,
  deriveBrowsePage: correctDerive,
  groupEntries: correctGroupEntries,
  selectWorthWatching: correctWorthWatching,
  baseTitleOf,
}

export type { BrowseFilterPatch }
