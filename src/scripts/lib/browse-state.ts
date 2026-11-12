// 0.11.8 W2 — Browse Everything state (Phase B, brief §6–§12, §16).
//
// ONE state model for BOTH Movies and Series browsing. Pure and
// DOM-free: every transition returns a NEW state object, so the
// controller, the URL mode module and the tests all share one
// meaning for "select", "apply" and "reset".
//
// ── Semantics (brief §10, HARD) ──────────────────────────────────
//   - Category selection REPLACES: selectCategory overwrites the
//     previous category outright. There is no code path that holds
//     two categories at once (the 0.11.6 Comedy-AND-Horror defect
//     class is structurally impossible here).
//   - Different-family filters MAY combine, but every active
//     constraint must be VISIBLE: activeFilterSummary() renders
//     the full constraint set as one concise line, and the browse
//     header renders it next to Reset All. No hidden constraints.
//   - resetAllFilters() clears EVERYTHING: category, genre, year,
//     rating, runtime/seasons, watch status, favourites/Watch
//     Later/followed/new-episodes, language, provider category,
//     search (+ scope), sort and pagination — back to the full
//     catalogue, page 1. It is the ONE reset.
//   - Changing category resets to page 1 and clears a
//     category-scoped search (the Live TV search-scope rule from
//     livetv-search-sort.ts: a query scoped to Sports must never
//     silently intersect Movies). A scope-"all" search survives a
//     category change because the user chose "search everything".
//   - Applying filters (drawer Apply) resets to page 1. Changing
//     sort resets to page 1. Changing search resets to page 1.
//     Paging never touches filters, and filters never touch the
//     selected poster except through the dataset change itself.
//
// ── Genre multi-select ───────────────────────────────────────────
// BrowseFilters carries genreMode/genres for a future advanced
// multi-select, but the 0.11.8 filter drawer exposes SINGLE genre
// only (brief §8: multi-select ONLY if genuinely clear with
// explicit OR vs AND, never default). applyFilters() accepts a
// multi-select patch but the drawer never produces one; the
// default is always single. Do not wire multi-select UI without
// the explicit OR/AND control the brief requires.

export type BrowseKind = "movie" | "series";

/** Which family a category selection belongs to (brief §7.1). */
export type BrowseCategoryKind =
  | "all"
  | "genre"
  | "collection"
  | "provider"
  | "uncategorised";

/**
 * ONE category selection. `id` is stable for the catalogue
 * revision (genre id, collection id, provider subcategory id, or
 * "all"/UNCATEGORISED_ID). `label` is the display label the
 * drawer showed — never invented by this module.
 */
export interface BrowseCategorySelection {
  kind: BrowseCategoryKind;
  id: string;
  label: string;
}

/** Sort orders (brief §11). Availability is gated by metadata —
// see browseSortOptions() and the drawer's availability input. */
export type BrowseSortId =
  | "recommended"
  | "added"
  | "year-desc"
  | "year-asc"
  | "rating"
  | "az"
  | "za"
  | "updated"
  | "seasons";

export const BROWSE_SORT_LABELS: Record<BrowseSortId, string> = {
  recommended: "Recommended",
  added: "Recently Added",
  "year-desc": "Release Year · Newest",
  "year-asc": "Release Year · Oldest",
  rating: "Highest Rated",
  az: "Title A–Z",
  za: "Title Z–A",
  updated: "Most Recently Updated",
  seasons: "Most Seasons",
};

/** Sort options in display order, per kind, before availability gating. */
export function browseSortIdsForKind(kind: BrowseKind): BrowseSortId[] {
  const base: BrowseSortId[] = [
    "recommended",
    "added",
    "year-desc",
    "year-asc",
    "rating",
    "az",
    "za",
  ];
  // Series-only orders (brief §11): only with real evidence —
  // the caller gates them via BrowseSortAvailability.
  return kind === "series" ? [...base, "updated", "seasons"] : base;
}

/** Which sort orders the catalogue's metadata actually supports. */
export interface BrowseSortAvailability {
  /** Provider added/updated timestamps present. */
  added: boolean;
  /** Release/first-air years present. */
  year: boolean;
  /** Credible ratings present. */
  rating: boolean;
  /** Real series update evidence (series only). */
  updated: boolean;
  /** Sufficient confirmed season-count coverage (series only). */
  seasons: boolean;
}

export const DEFAULT_BROWSE_SORT_AVAILABILITY: BrowseSortAvailability = {
  added: true,
  year: true,
  rating: true,
  updated: false,
  seasons: false,
};

/**
 * Sort options a kind may offer given the metadata available.
 * "recommended" and title sorts are always available (provider
 * order and title are always present); everything else needs its
 * evidence. An unavailable order is OMITTED, never offered dead.
 */
export function browseSortOptions(
  kind: BrowseKind,
  availability: BrowseSortAvailability = DEFAULT_BROWSE_SORT_AVAILABILITY,
): Array<{ value: BrowseSortId; label: string }> {
  const out: Array<{ value: BrowseSortId; label: string }> = [];
  for (const id of browseSortIdsForKind(kind)) {
    if (id === "added" && !availability.added) continue;
    if ((id === "year-desc" || id === "year-asc") && !availability.year) continue;
    if (id === "rating" && !availability.rating) continue;
    if (id === "updated" && !availability.updated) continue;
    if (id === "seasons" && !availability.seasons) continue;
    out.push({ value: id, label: BROWSE_SORT_LABELS[id] });
  }
  return out;
}

export function isBrowseSortId(value: unknown): value is BrowseSortId {
  return (
    value === "recommended" ||
    value === "added" ||
    value === "year-desc" ||
    value === "year-asc" ||
    value === "rating" ||
    value === "az" ||
    value === "za" ||
    value === "updated" ||
    value === "seasons"
  );
}

/** Runtime buckets (brief §8.5): verified runtime only; unknown stays unknown. */
export type BrowseRuntimeBucket =
  | ""
  | "under-60"
  | "under-90"
  | "under-120"
  | "under-150"
  | "under-180"
  | "over-180";

export const BROWSE_RUNTIME_BUCKETS: Array<{
  value: BrowseRuntimeBucket;
  label: string;
  /** Max minutes (inclusive) for "under-*" buckets; null for any/over. */
  maxMinutes: number | null;
}> = [
  { value: "", label: "Any length", maxMinutes: null },
  { value: "under-60", label: "Under 1 hour", maxMinutes: 60 },
  { value: "under-90", label: "Under 1½ hours", maxMinutes: 90 },
  { value: "under-120", label: "Under 2 hours", maxMinutes: 120 },
  { value: "under-150", label: "Under 2½ hours", maxMinutes: 150 },
  { value: "under-180", label: "Under 3 hours", maxMinutes: 180 },
  { value: "over-180", label: "Over 3 hours", maxMinutes: null },
];

export function browseRuntimeBucketLabel(bucket: BrowseRuntimeBucket): string {
  return (
    BROWSE_RUNTIME_BUCKETS.find((b) => b.value === bucket)?.label ?? "Any length"
  );
}

/** Season-count buckets (brief §9.4): CONFIRMED counts only. */
export type BrowseSeasonCountBucket = "" | "1" | "2" | "3+" | "5+" | "10+";

export const BROWSE_SEASON_COUNT_BUCKETS: Array<{
  value: BrowseSeasonCountBucket;
  label: string;
}> = [
  { value: "", label: "Any seasons" },
  { value: "1", label: "1 season" },
  { value: "2", label: "2 seasons" },
  { value: "3+", label: "3+ seasons" },
  { value: "5+", label: "5+ seasons" },
  { value: "10+", label: "10+ seasons" },
];

export function browseSeasonCountBucketLabel(
  bucket: BrowseSeasonCountBucket,
): string {
  return (
    BROWSE_SEASON_COUNT_BUCKETS.find((b) => b.value === bucket)?.label ??
    "Any seasons"
  );
}

/** Series status (brief §9.5): only with genuine metadata, else omitted. */
export type BrowseSeriesStatus = "" | "returning" | "ended" | "limited";

export const BROWSE_SERIES_STATUS_OPTIONS: Array<{
  value: BrowseSeriesStatus;
  label: string;
}> = [
  { value: "", label: "Any status" },
  { value: "returning", label: "Returning" },
  { value: "ended", label: "Ended" },
  { value: "limited", label: "Limited" },
];

export type BrowseWatchStatus = "" | "unwatched" | "in-progress" | "watched";

export const BROWSE_WATCH_STATUS_OPTIONS: Array<{
  value: BrowseWatchStatus;
  label: string;
}> = [
  { value: "", label: "Any watch status" },
  { value: "unwatched", label: "Unwatched" },
  { value: "in-progress", label: "In progress" },
  { value: "watched", label: "Watched" },
];

/** Decade keys the browse filter offers (brief §8.2/§9.2). */
export const BROWSE_DECADE_KEYS = [
  "2020s",
  "2010s",
  "2000s",
  "1990s",
  "1980s",
  "1970s",
  "1960s",
  "older",
] as const;

export type BrowseDecadeKey = (typeof BROWSE_DECADE_KEYS)[number];

/**
 * Every §8/§9 filter field. "" / 0 / false / null mean "any" on
 * every field, so the default filters object filters nothing.
 * `year` is a decade key ("" = any); `yearFrom`/`yearTo` carry an
 * optional controller-usable custom range (both null = no range).
 * When a custom range is set it wins over the decade key.
 */
export interface BrowseFilters {
  /** Single canonical genre id ("" = any). The drawer default. */
  genre: string;
  /** Advanced multi-select mode. "single" unless a future UI sets it. */
  genreMode: "single" | "multi-or" | "multi-and";
  /** Multi-select genre ids (only read when genreMode !== "single"). */
  genres: string[];
  /** Decade key ("" = any decade). */
  year: string;
  /** Custom year-range start (inclusive), or null. Release/first-air year, NOT upload time. */
  yearFrom: number | null;
  /** Custom year-range end (inclusive), or null. */
  yearTo: number | null;
  /** Minimum rating on the normalised 0–10 scale. 0 = any. Unknown ratings never pass a minimum. */
  minRating: number;
  /** Runtime bucket (movies). "" = any. Verified runtime only. */
  runtime: BrowseRuntimeBucket;
  /** Watch status. "" = any. */
  watchStatus: BrowseWatchStatus;
  /** Favourites only. Never combined with a conflicting hidden collection state. */
  favouritesOnly: boolean;
  /** Watch Later only. */
  watchLaterOnly: boolean;
  /** Followed only (series). */
  followedOnly: boolean;
  /** New Episodes only (series, backed by existing detection). */
  newEpisodesOnly: boolean;
  /** Language tag/code from actual catalogue data ("" = any). Original-language ≠ audio-variant labels. */
  language: string;
  /** Raw provider category id ("" = any). Distinct from genre; obvious when active. */
  providerCategory: string;
  /** Season-count bucket (series). "" = any. Confirmed counts only. */
  seasonCount: BrowseSeasonCountBucket;
  /** Series status (series). "" = any. Only with genuine metadata. */
  seriesStatus: BrowseSeriesStatus;
}

export function createBrowseFilters(): BrowseFilters {
  return {
    genre: "",
    genreMode: "single",
    genres: [],
    year: "",
    yearFrom: null,
    yearTo: null,
    minRating: 0,
    runtime: "",
    watchStatus: "",
    favouritesOnly: false,
    watchLaterOnly: false,
    followedOnly: false,
    newEpisodesOnly: false,
    language: "",
    providerCategory: "",
    seasonCount: "",
    seriesStatus: "",
  };
}

export function isDefaultBrowseFilters(filters: BrowseFilters): boolean {
  return (
    !filters.genre &&
    filters.genreMode === "single" &&
    filters.genres.length === 0 &&
    !filters.year &&
    filters.yearFrom == null &&
    filters.yearTo == null &&
    !filters.minRating &&
    !filters.runtime &&
    !filters.watchStatus &&
    !filters.favouritesOnly &&
    !filters.watchLaterOnly &&
    !filters.followedOnly &&
    !filters.newEpisodesOnly &&
    !filters.language &&
    !filters.providerCategory &&
    !filters.seasonCount &&
    !filters.seriesStatus
  );
}

/** Search scope (brief §12): default FULL catalogue; inside a category a VISIBLE choice. */
export type BrowseSearchScope = "all" | "category";

/** Default page size (brief §6.2): ~30 posters; responsive target 24–36 (see couch-grid.ts). */
export const BROWSE_DEFAULT_PAGE_SIZE = 30;

export interface BrowseState {
  kind: BrowseKind;
  /** The ONE active category. Never two. */
  category: BrowseCategorySelection;
  filters: BrowseFilters;
  /** Raw search query ("" = no search). */
  search: string;
  searchScope: BrowseSearchScope;
  sort: BrowseSortId;
  /** 1-based page. */
  page: number;
  pageSize: number;
  /** Last selected title-group id (focus memory), or null. */
  selectedId: string | null;
}

export function allCategoryForKind(kind: BrowseKind): BrowseCategorySelection {
  return {
    kind: "all",
    id: "all",
    label: kind === "movie" ? "All Movies" : "All Series",
  };
}

export type BrowseStatePatch = Omit<Partial<BrowseState>, "filters"> & {
  filters?: Partial<BrowseFilters>;
};

export function createBrowseState(
  kind: BrowseKind,
  patch: BrowseStatePatch = {},
): BrowseState {
  const state: BrowseState = {
    kind,
    category: allCategoryForKind(kind),
    filters: createBrowseFilters(),
    search: "",
    searchScope: "all",
    sort: "recommended",
    page: 1,
    pageSize: BROWSE_DEFAULT_PAGE_SIZE,
    selectedId: null,
  };
  if (patch.category) state.category = { ...patch.category };
  if (patch.filters) state.filters = { ...state.filters, ...patch.filters };
  if (patch.search !== undefined) state.search = patch.search;
  if (patch.searchScope) state.searchScope = patch.searchScope;
  if (patch.sort) state.sort = patch.sort;
  if (patch.page !== undefined) state.page = Math.max(1, Math.floor(patch.page));
  if (patch.pageSize !== undefined)
    state.pageSize = Math.max(1, Math.floor(patch.pageSize));
  if (patch.selectedId !== undefined) state.selectedId = patch.selectedId;
  return state;
}

/**
 * Select a category, REPLACING the previous one. Resets to page 1.
 * A category-scoped search is cleared (it belonged to the old
 * category); a scope-"all" search survives. Other filters are
 * retained ONLY because they stay visibly represented in the
 * filter summary — the caller renders activeFilterSummary().
 */
export function selectCategory(
  state: BrowseState,
  category: BrowseCategorySelection,
): BrowseState {
  const scopedSearchCleared = state.searchScope === "category";
  return {
    ...state,
    category: { ...category },
    search: scopedSearchCleared ? "" : state.search,
    searchScope: scopedSearchCleared ? "all" : state.searchScope,
    page: 1,
    selectedId: null,
  };
}

/**
 * Apply a filter patch (drawer Apply). Returns a NEW state; the
 * input is never mutated. Resets to page 1. A genre in the patch
 * REPLACES the previous genre (single string assignment through
 * this one funnel — see browse-filters.ts selectGenreFilter).
 */
export function applyFilters(
  state: BrowseState,
  patch: Partial<BrowseFilters>,
): BrowseState {
  return {
    ...state,
    filters: { ...state.filters, ...patch },
    page: 1,
    selectedId: null,
  };
}

/**
 * ONE Reset All: clears category, every filter, search (+ scope),
 * sort and pagination back to the full catalogue, page 1. The
 * kind and pageSize survive (they describe the surface, not a
 * constraint). Returns a NEW state.
 */
export function resetAllFilters(state: BrowseState): BrowseState {
  return {
    ...state,
    category: allCategoryForKind(state.kind),
    filters: createBrowseFilters(),
    search: "",
    searchScope: "all",
    sort: "recommended",
    page: 1,
    selectedId: null,
  };
}

/** True when ANY constraint beyond the bare catalogue is active. */
export function hasActiveBrowseConstraints(state: BrowseState): boolean {
  return (
    state.category.kind !== "all" ||
    !isDefaultBrowseFilters(state.filters) ||
    state.search.trim() !== "" ||
    state.sort !== "recommended"
  );
}

/**
 * Concise visible summary of EVERY active constraint, e.g.
 * "Horror · 2010s · Under 2h" (brief §10). The category is named
 * first when it is not All; the search query is quoted; the sort
 * is named only when it is not the default. "" when unconstrained.
 * `genreLabel`/`providerLabel`/`languageLabel` resolve ids to the
 * labels the drawer showed; unknown ids render verbatim, never blank.
 */
export function activeFilterSummary(
  state: BrowseState,
  labels: {
    genreLabel?: (id: string) => string;
    providerLabel?: (id: string) => string;
    languageLabel?: (id: string) => string;
  } = {},
): string {
  const parts: string[] = [];
  if (state.category.kind !== "all") parts.push(state.category.label);
  const f = state.filters;
  if (f.genreMode !== "single" && f.genres.length > 0) {
    const names = f.genres.map((g) => labels.genreLabel?.(g) ?? g);
    const joiner = f.genreMode === "multi-and" ? " AND " : " OR ";
    parts.push(names.join(joiner));
  } else if (f.genre) {
    parts.push(labels.genreLabel?.(f.genre) ?? f.genre);
  }
  if (f.yearFrom != null || f.yearTo != null) {
    const from = f.yearFrom != null ? String(f.yearFrom) : "…";
    const to = f.yearTo != null ? String(f.yearTo) : "…";
    parts.push(`${from}–${to}`);
  } else if (f.year) {
    parts.push(f.year === "older" ? "Before 1960" : f.year);
  }
  if (f.minRating > 0) parts.push(`${f.minRating}+ rated`);
  if (f.runtime) parts.push(browseRuntimeBucketLabel(f.runtime));
  if (f.seasonCount) parts.push(browseSeasonCountBucketLabel(f.seasonCount));
  if (f.seriesStatus) {
    parts.push(
      BROWSE_SERIES_STATUS_OPTIONS.find((o) => o.value === f.seriesStatus)
        ?.label ?? f.seriesStatus,
    );
  }
  if (f.watchStatus) {
    parts.push(
      BROWSE_WATCH_STATUS_OPTIONS.find((o) => o.value === f.watchStatus)
        ?.label ?? f.watchStatus,
    );
  }
  if (f.favouritesOnly) parts.push("Favourites");
  if (f.watchLaterOnly) parts.push("Watch Later");
  if (f.followedOnly) parts.push("Followed");
  if (f.newEpisodesOnly) parts.push("New Episodes");
  if (f.language) parts.push(labels.languageLabel?.(f.language) ?? f.language);
  if (f.providerCategory) {
    parts.push(
      labels.providerLabel?.(f.providerCategory) ?? f.providerCategory,
    );
  }
  const query = state.search.trim();
  if (query) {
    const scope =
      state.searchScope === "category" ? " in this category" : "";
    parts.push(`“${query}”${scope}`);
  }
  if (state.sort !== "recommended") {
    parts.push(BROWSE_SORT_LABELS[state.sort]);
  }
  return parts.join(" · ");
}

/** Set the page, clamped to [1, totalPages] when totalPages is known. */
export function setPage(
  state: BrowseState,
  page: number,
  totalPages?: number,
): BrowseState {
  const max = totalPages != null && totalPages >= 1 ? totalPages : 1;
  const clamped = Math.max(1, Math.min(max, Math.floor(page) || 1));
  return { ...state, page: clamped };
}

/** Set the search query + scope. Resets to page 1. */
export function setSearch(
  state: BrowseState,
  query: string,
  scope: BrowseSearchScope = "all",
): BrowseState {
  return {
    ...state,
    search: query,
    searchScope: scope,
    page: 1,
    selectedId: null,
  };
}

/** Set the sort. Resets to page 1. Unknown ids fall back to Recommended. */
export function setSort(state: BrowseState, sort: BrowseSortId): BrowseState {
  return {
    ...state,
    sort: isBrowseSortId(sort) ? sort : "recommended",
    page: 1,
    selectedId: null,
  };
}

// ── Pagination math (brief §6.2) ────────────────────────────────

export interface BrowsePageInfo {
  page: number;
  totalPages: number;
  totalResults: number;
  pageSize: number;
  startIndex: number;
  endIndex: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Total pages for a result count (0 results → 0 pages, never 1 phantom page). */
export function browseTotalPages(totalResults: number, pageSize: number): number {
  const total = Math.max(0, Math.floor(totalResults));
  const size = Math.max(1, Math.floor(pageSize));
  return Math.ceil(total / size);
}

/** Page window for a state + result count; the page is clamped into range. */
export function browsePageInfo(
  state: BrowseState,
  totalResults: number,
): BrowsePageInfo {
  const totalPages = browseTotalPages(totalResults, state.pageSize);
  const page =
    totalPages === 0 ? 1 : Math.max(1, Math.min(totalPages, state.page));
  const startIndex = totalResults === 0 ? 0 : (page - 1) * state.pageSize;
  const endIndex = Math.min(totalResults, page * state.pageSize);
  return {
    page,
    totalPages,
    totalResults: Math.max(0, Math.floor(totalResults)),
    pageSize: state.pageSize,
    startIndex,
    endIndex,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

/**
 * Page numbers for the quick-jump row: a window of up to 5 pages
 * centred on the current page, clamped into [1, totalPages].
 * [] when there is 1 or 0 pages (nothing to jump between).
 */
export function browsePageJumpWindow(
  page: number,
  totalPages: number,
  windowSize = 5,
): number[] {
  if (totalPages <= 1) return [];
  const size = Math.max(1, Math.min(windowSize, totalPages));
  const start = Math.max(1, Math.min(totalPages - size + 1, page - Math.floor(size / 2)));
  const out: number[] = [];
  for (let i = 0; i < size; i++) out.push(start + i);
  return out;
}
