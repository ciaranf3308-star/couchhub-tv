// 0.11.8 W2 — Home / Browse mode contract (Phase B, brief §1.9).
//
// ONE mode strategy for BOTH the Movies and Series pages, so Back
// and focus-restore behaviour is identical on both. The mode lives
// in the URL query string (view state, not a route change): the
// page shell reads it on load, and the browse controller writes
// it on every state change, so browser Back, detail-return and a
// full reload all land on the same view with the same filters.
//
//   /movies?view=browse&category=genre:horror&page=2&sort=rating
//   /series?view=home
//
// ── Exact contract (consumed by W3/W4) ───────────────────────────
//   - `view=home` (or absent) → the curated Home screen.
//     `view=browse` → Browse Everything. Any other value → home.
//   - `kind` is NOT a param: the page route decides the kind
//     (/movies = movie, /series = series). parseModeFromUrl takes
//     the kind as an argument; a `kind` param, if present, is
//     ignored rather than trusted (a /movies URL must never
//     render series state).
//   - `category` is `kind:id` — "all", "genre:horror",
//     "collection:recent", "provider:sub-action", "uncategorised".
//     The LABEL is never in the URL: the drawer/index resolves
//     the id back to its label on load. An unknown category id
//     falls back to All (see the "removed category" rule in
//     browse-everything.ts — the controller re-validates the id
//     against the live catalogue and resets intelligently).
//   - Filter params mirror BrowseFilters field names: genre,
//     year, yearFrom, yearTo, rating, runtime, watch, fav,
//     watchlater, followed, newepisodes, lang, provider,
//     seasons, status. Absent = default. Unknown values fall
//     back to defaults — a bad URL can never hide the catalogue.
//   - `q` = search query, `scope` = all|category, `sort` = a
//     BrowseSortId, `page` = 1-based page, `selected` = the
//     selected title-group id (focus memory across reload).
//   - setModeInUrl(mode, {replace}) writes with history.replaceState
//     by default (filter/page/search churn must not flood the
//     Back stack — one Back press leaves Browse, it does not step
//     through 40 filter states). Callers pass {replace:false} for
//     the home→browse ENTER transition only, so Back from Browse
//     returns to Home. setModeInUrl never navigates and never
//     throws (guarded for non-DOM runtimes).
//   - modeToSearchParams / modeFromSearchParams are the pure
//     halves; tests assert them without a DOM.

import {
  allCategoryForKind,
  createBrowseFilters,
  createBrowseState,
  isBrowseSortId,
  type BrowseCategoryKind,
  type BrowseCategorySelection,
  type BrowseFilters,
  type BrowseKind,
  type BrowseSearchScope,
  type BrowseSortId,
  type BrowseState,
} from "@/scripts/lib/browse-state.ts";

export type HomeBrowseView = "home" | "browse";

export interface HomeBrowseMode {
  view: HomeBrowseView;
  kind: BrowseKind;
  /** Category id in `kind:id` form ("all" for the whole catalogue). */
  category?: string;
  page?: number;
  selectedId?: string;
  filters?: Partial<BrowseFilters>;
  search?: string;
  searchScope?: BrowseSearchScope;
  sort?: BrowseSortId;
}

const CATEGORY_KINDS: BrowseCategoryKind[] = [
  "all",
  "genre",
  "collection",
  "provider",
  "uncategorised",
];

/**
 * Parse a `kind:id` category param into a selection. The label is
 * the caller's job (resolveLabel): without one the id itself is
 * the label — the controller replaces it with the real label
 * once the catalogue loads. Unknown kinds/empty ids → All.
 */
export function parseCategoryParam(
  raw: string | null | undefined,
  kind: BrowseKind,
  resolveLabel?: (selection: BrowseCategorySelection) => string,
): BrowseCategorySelection {
  const fallback = allCategoryForKind(kind);
  const text = (raw ?? "").trim();
  if (!text || text === "all") return fallback;
  if (text === "uncategorised") {
    const sel: BrowseCategorySelection = {
      kind: "uncategorised",
      id: "uncategorised",
      label: "Uncategorised",
    };
    return resolveLabel ? { ...sel, label: resolveLabel(sel) } : sel;
  }
  const colon = text.indexOf(":");
  if (colon <= 0) return fallback;
  const catKind = text.slice(0, colon) as BrowseCategoryKind;
  const id = text.slice(colon + 1);
  if (!CATEGORY_KINDS.includes(catKind) || !id) return fallback;
  if (catKind === "all") return fallback;
  const sel: BrowseCategorySelection = { kind: catKind, id, label: id };
  return resolveLabel ? { ...sel, label: resolveLabel(sel) } : sel;
}

/** Serialise a category selection to its URL param form. */
export function categoryParamFor(
  selection: BrowseCategorySelection,
): string {
  if (selection.kind === "all") return "all";
  if (selection.kind === "uncategorised") return "uncategorised";
  return `${selection.kind}:${selection.id}`;
}

function parseIntParam(raw: string | null, fallback: number | null): number | null {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function parseFiltersFromParams(
  params: URLSearchParams,
): Partial<BrowseFilters> {
  const patch: Partial<BrowseFilters> = {};
  const genre = params.get("genre");
  if (genre) patch.genre = genre;
  const year = params.get("year");
  if (year) patch.year = year;
  const yearFrom = parseIntParam(params.get("yearFrom"), null);
  if (yearFrom != null) patch.yearFrom = yearFrom;
  const yearTo = parseIntParam(params.get("yearTo"), null);
  if (yearTo != null) patch.yearTo = yearTo;
  const rating = parseIntParam(params.get("rating"), null);
  if (rating != null && [0, 6, 7, 8, 9].includes(rating)) patch.minRating = rating;
  const runtime = params.get("runtime");
  if (
    runtime === "under-60" ||
    runtime === "under-90" ||
    runtime === "under-120" ||
    runtime === "under-150" ||
    runtime === "under-180" ||
    runtime === "over-180"
  ) {
    patch.runtime = runtime;
  }
  const watch = params.get("watch");
  if (watch === "unwatched" || watch === "in-progress" || watch === "watched") {
    patch.watchStatus = watch;
  }
  if (params.get("fav") === "1") patch.favouritesOnly = true;
  if (params.get("watchlater") === "1") patch.watchLaterOnly = true;
  if (params.get("followed") === "1") patch.followedOnly = true;
  if (params.get("newepisodes") === "1") patch.newEpisodesOnly = true;
  const lang = params.get("lang");
  if (lang) patch.language = lang;
  const provider = params.get("provider");
  if (provider) patch.providerCategory = provider;
  const seasons = params.get("seasons");
  if (
    seasons === "1" ||
    seasons === "2" ||
    seasons === "3+" ||
    seasons === "5+" ||
    seasons === "10+"
  ) {
    patch.seasonCount = seasons;
  }
  const status = params.get("status");
  if (status === "returning" || status === "ended" || status === "limited") {
    patch.seriesStatus = status;
  }
  return patch;
}

/**
 * Pure: parse a mode from URLSearchParams (or a query string).
 * `kind` comes from the route, never the URL. Unknown values fall
 * back to defaults; a missing `view` means home.
 */
export function modeFromSearchParams(
  input: URLSearchParams | string,
  kind: BrowseKind,
  resolveLabel?: (selection: BrowseCategorySelection) => string,
): HomeBrowseMode {
  const params =
    typeof input === "string" ? new URLSearchParams(input) : input;
  const view: HomeBrowseView = params.get("view") === "browse" ? "browse" : "home";
  const mode: HomeBrowseMode = { view, kind };
  if (view !== "browse") return mode;
  const category = parseCategoryParam(params.get("category"), kind, resolveLabel);
  mode.category = categoryParamFor(category);
  const page = parseIntParam(params.get("page"), null);
  if (page != null && page >= 1) mode.page = page;
  const selected = params.get("selected");
  if (selected) mode.selectedId = selected;
  const filters = parseFiltersFromParams(params);
  if (Object.keys(filters).length > 0) mode.filters = filters;
  const q = params.get("q");
  if (q) mode.search = q;
  const scope = params.get("scope");
  if (scope === "all" || scope === "category") mode.searchScope = scope;
  const sort = params.get("sort");
  if (sort && isBrowseSortId(sort)) mode.sort = sort;
  return mode;
}

/** Pure: serialise a mode to URLSearchParams. Defaults are omitted (short URLs). */
export function modeToSearchParams(mode: HomeBrowseMode): URLSearchParams {
  const params = new URLSearchParams();
  params.set("view", mode.view);
  if (mode.view !== "browse") return params;
  if (mode.category && mode.category !== "all") {
    params.set("category", mode.category);
  }
  const filters = mode.filters ?? {};
  const defaults = createBrowseFilters();
  if (filters.genre) params.set("genre", filters.genre);
  if (filters.year) params.set("year", filters.year);
  if (filters.yearFrom != null) params.set("yearFrom", String(filters.yearFrom));
  if (filters.yearTo != null) params.set("yearTo", String(filters.yearTo));
  if (filters.minRating) params.set("rating", String(filters.minRating));
  if (filters.runtime) params.set("runtime", filters.runtime);
  if (filters.watchStatus) params.set("watch", filters.watchStatus);
  if (filters.favouritesOnly) params.set("fav", "1");
  if (filters.watchLaterOnly) params.set("watchlater", "1");
  if (filters.followedOnly) params.set("followed", "1");
  if (filters.newEpisodesOnly) params.set("newepisodes", "1");
  if (filters.language) params.set("lang", filters.language);
  if (filters.providerCategory) params.set("provider", filters.providerCategory);
  if (filters.seasonCount) params.set("seasons", filters.seasonCount);
  if (filters.seriesStatus) params.set("status", filters.seriesStatus);
  void defaults;
  if (mode.search) params.set("q", mode.search);
  if (mode.searchScope === "category") params.set("scope", "category");
  if (mode.sort && mode.sort !== "recommended") params.set("sort", mode.sort);
  if (mode.page != null && mode.page > 1) params.set("page", String(mode.page));
  if (mode.selectedId) params.set("selected", mode.selectedId);
  return params;
}

/** Build a mode from a full BrowseState (browse view). */
export function modeFromBrowseState(state: BrowseState): HomeBrowseMode {
  return {
    view: "browse",
    kind: state.kind,
    category: categoryParamFor(state.category),
    page: state.page,
    selectedId: state.selectedId ?? undefined,
    filters: { ...state.filters },
    search: state.search || undefined,
    searchScope: state.searchScope,
    sort: state.sort,
  };
}

/** Build a BrowseState from a mode (browse view). Home modes yield a default browse state. */
export function browseStateFromMode(
  mode: HomeBrowseMode,
  resolveLabel?: (selection: BrowseCategorySelection) => string,
): BrowseState {
  const category = parseCategoryParam(mode.category, mode.kind, resolveLabel);
  return createBrowseState(mode.kind, {
    category,
    filters: mode.filters ?? {},
    search: mode.search ?? "",
    searchScope: mode.searchScope ?? "all",
    sort: mode.sort ?? "recommended",
    page: mode.page ?? 1,
    selectedId: mode.selectedId ?? null,
  });
}

/**
 * Read the current mode from the live URL. Falls back to home
 * when there is no window (tests / SSR) or the URL is unreadable.
 */
export function parseModeFromUrl(
  kind: BrowseKind,
  resolveLabel?: (selection: BrowseCategorySelection) => string,
): HomeBrowseMode {
  try {
    if (typeof window === "undefined") return { view: "home", kind };
    return modeFromSearchParams(
      new URLSearchParams(window.location.search),
      kind,
      resolveLabel,
    );
  } catch {
    return { view: "home", kind };
  }
}

/**
 * Write a mode to the URL without navigating. Default is
 * history.replaceState (state churn must not flood Back); pass
 * {replace:false} for the home→browse ENTER transition only.
 * Preserves the pathname and any unrelated params the page owns
 * (auth/session params are never stripped: only the mode keys
 * this module owns are rewritten). Never throws.
 */
export function setModeInUrl(
  mode: HomeBrowseMode,
  opts: { replace?: boolean } = {},
): void {
  try {
    if (typeof window === "undefined" || !window.history) return;
    const current = new URLSearchParams(window.location.search);
    // Remove only the keys this module owns, then write the mode.
    const owned = [
      "view",
      "category",
      "genre",
      "year",
      "yearFrom",
      "yearTo",
      "rating",
      "runtime",
      "watch",
      "fav",
      "watchlater",
      "followed",
      "newepisodes",
      "lang",
      "provider",
      "seasons",
      "status",
      "q",
      "scope",
      "sort",
      "page",
      "selected",
    ];
    for (const key of owned) current.delete(key);
    const next = modeToSearchParams(mode);
    next.forEach((value, key) => current.set(key, value));
    const query = current.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash ?? ""}`;
    if (opts.replace === false) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  } catch {
    // URL sync is a nicety: a failure must never break browsing.
  }
}
