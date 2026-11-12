// 0.11.8 W2 — Browse Everything (Phase B, brief §6, §11, §12, §16).
//
// ONE controller-driven browsing framework used by BOTH Movies
// and Series. There is deliberately no second browser engine:
// kind-specific behaviour arrives through the BrowseDataSource
// (rows, card views, watch sets) and the kind-aware state/drawer
// modules — never through a fork of this controller.
//
// ── Reuse-vs-new decisions (0.11.7) ──────────────────────────────
//   REUSED (imported, unmodified):
//     - couch-grid.ts computeVisibleWindow/gridColumnsForWidth
//       (column math) + the NEW createKeyedPageGrid in the same
//       module (keyed reuse-pool, ported from tv/ui/grid.ts).
//     - browse-filters.ts matchers (year/rating/runtime/genre)
//       + the 0.11.8 bucket extensions in the same module.
//     - buildCouchCard / couchCardSignature / updateCouchCard
//       (movies/couch-cards.ts) — same card markup as TvCard.
//     - The shared `normalize` search helper (text.ts) via the
//       W1 search contract (catalog-index.ts searchCatalogIndex,
//       ranked retrieval over display-level groups).
//     - createGenerationGuard (livetv-category-index.ts) for
//       stale-load cancellation — a generic guard, not Live TV
//       behaviour.
//     - couch-focus.ts restoreCouchFocus (consume-only) for
//       focus memory after the first paint.
//     - The native XInput → shared action pipeline (gamepad.ts):
//       this controller consumes ONLY KeyboardEvents (arrows,
//       Enter, Escape, x/y/m, PageUp/PageDown, [/]) — the same
//       keys gamepad.ts synthesises. It creates NO second
//       controller handler and never touches gamepad.ts.
//   GENERALISED (pattern ported, Live TV untouched):
//     - The 0.11.7 category drawer (livetv-category-drawer.ts):
//       two-level reducer, clamped focus, paintFocus, scrim,
//       B-layer rule → browse-category-drawer.ts (browse shapes).
//     - The B-layer model (livetv-nav.ts): a minimal layer stack
//       here (grid + one overlay); B pops exactly one layer.
//       livetv-nav itself is Live TV layer ids — not imported.
//     - The search-scope rule (livetv-search-sort.ts): category
//       change clears category-scoped search; scope "all"
//       survives. Implemented in browse-state.ts selectCategory.
//     - The one-hints-bar pattern (TvLivetvHints): one bar,
//       layer-driven. Rendered locally (hints modules are not
//       in W2 ownership; unification is an integration flag).
//   NEW (no 0.11.7 equivalent):
//     - browse-state.ts, home-browse-modes.ts, the keyed page
//       grid, the filter drawer, the search/sort overlays, and
//       this controller. tv/ui/grid.ts was NOT reused directly:
//       it is a row-windowed full-catalogue grid with view
//       transitions + TV focus sections — the wrong shape for a
//       page-bounded browse grid. Its reuse-pool + focus-pin
//       patterns were ported into createKeyedPageGrid instead,
//       and tv/ui/grid.ts itself is untouched (Live TV tests
//       stay green by construction).
//
// ── Controller contract (§16.2–§16.3) ───────────────────────────
//   D-pad moves between cards (spatial nav owns the movement;
//   this controller owns only the EDGES: Left from the first
//   column opens Categories, Up from the first row focuses the
//   header, Down from the last row focuses pagination).
//   A/Enter opens the focused card (onOpenDetail). B/Escape pops
//   one layer (overlay → grid → onExit). X dispatches a
//   `browse:card-context` event for the focused card (context
//   menu is owned by the card/detail layer — flagged). Y opens
//   search. LB/RB turn pages (PageUp/PageDown and [ / ] keys).
//   Menu (m/ContextMenu) opens Filters. One press = one action:
//   edge handlers preventDefault + stopPropagation so spatial
//   nav never double-moves; all other keys pass through.
//   NOTE (integration flag): gamepad.ts currently routes LB/RB,
//   Y, Menu and X to seek/goSearch/openSettings/openDetails on
//   non-Live-TV pages. The browse key equivalents handled here
//   (PageUp/PageDown, "y", "m", "x") work from a keyboard today
//   and from the controller once gamepad.ts gains a browse-active
//   branch (predicate: this controller sets
//   [data-browse-everything] on its root + [data-browse-layer]).
//   B/Escape, arrows and A/Enter already reach this controller
//   from the controller today.
//
// ── Focus/scroll distinction (§1.5) — five named operations ──────
//   1. moveFocus (controller): spatial nav + edge handlers.
//      Never re-renders, never touches the dataset.
//   2. pointer scroll: the page is bounded (one page, no
//      infinite scroll); scrolling never changes the dataset.
//      There is deliberately NO scroll listener that re-derives.
//   3. restoreFocusAfterDetail: mount-time restoreFocus (or the
//      URL `selected` param) → goto page, focus the exact poster
//      or the nearest surviving item. Never into unmounted rows.
//   4. applyDatasetChange: category/filter/search/sort change →
//      re-derive, clamp page, render, focus the FIRST result.
//   5. programmaticJump: gotoPage keeps the focus column/index
//      where the new page has a card there (page turns preserve
//      position; dataset changes reset to the first result).
//
// ── Leaks (§15.8) ────────────────────────────────────────────────
// destroy() removes the window keydown listener, the
// xt:active-changed listener, the ResizeObserver, cancels the
// grid rAF + prefetch timers + the debounced search, destroys
// the grid and any open overlay, and removes the root. Repeated
// mount/unmount accumulates nothing (asserted in tests).

import { createGenerationGuard } from "@/scripts/lib/livetv-category-index.ts";
import {
  buildBrowseDrawerFamilies,
  mountBrowseCategoryDrawer,
  type BrowseCategoryDrawerHandle,
  type BrowseDrawerStats,
} from "@/scripts/lib/browse-category-drawer.ts";
import {
  DEFAULT_FILTER_DRAWER_AVAILABILITY,
  mountBrowseFilterDrawer,
  type BrowseFilterDrawerAvailability,
  type BrowseFilterDrawerHandle,
} from "@/scripts/lib/browse-filter-drawer.ts";
import {
  browseYearMatches,
  browseYearRangeMatches,
  languageMatches,
  seasonCountMatches,
} from "@/scripts/lib/browse-filters.ts";
import {
  createKeyedPageGrid,
  gridColumnsForWidth,
  pageSizeForGrid,
  type KeyedPageGrid,
} from "@/scripts/lib/couch-grid.ts";
import {
  buildBrowseGridCard,
  couchCardSignature,
  updateCouchCard,
  type CouchCardView,
} from "@/scripts/movies/couch-cards.ts";
import {
  getCatalogIndex,
  searchCatalogIndex,
  type CatalogIndex,
  type CatalogRow,
  type GroupAggregate,
} from "@/scripts/lib/catalog-index.ts";
import {
  CANONICAL_MOVIE_GENRES,
  CANONICAL_SERIES_GENRES,
  UNCATEGORISED_ID,
  genreLabelForId,
  providerCategoryInfo,
} from "@/scripts/lib/genres.ts";
import { ratingPassesMinimum } from "@/scripts/lib/rating-evidence.ts";
import type { TitleGroup } from "@/scripts/lib/language-groups.ts";
import {
  noteDecoratedSort,
  noteDeriveCall,
  noteFocusMove,
  notePageTurn,
} from "@/scripts/lib/browse-instrumentation.ts";
import {
  BROWSE_DEFAULT_PAGE_SIZE,
  activeFilterSummary,
  allCategoryForKind,
  browsePageInfo,
  browsePageJumpWindow,
  browseSortOptions,
  browseTotalPages,
  createBrowseState,
  hasActiveBrowseConstraints,
  isDefaultBrowseFilters,
  resetAllFilters,
  selectCategory,
  setPage,
  setSearch,
  setSort,
  type BrowseCategorySelection,
  type BrowseFilters,
  type BrowseKind,
  type BrowseSearchScope,
  type BrowseSortAvailability,
  type BrowseSortId,
  type BrowseState,
  type BrowseStatePatch,
} from "@/scripts/lib/browse-state.ts";
import {
  createDebouncedSearch,
  hasSearchableQuery,
  resolveSearchScope,
  searchScopeOptions,
} from "@/scripts/lib/browse-search.ts";
import { restoreCouchFocus } from "@/scripts/lib/couch-focus.ts";
import {
  browseStateFromMode,
  modeFromBrowseState,
  parseModeFromUrl,
  setModeInUrl,
} from "@/scripts/lib/home-browse-modes.ts";

// ── Data source (the W3/W4 seam) ─────────────────────────────────

export interface BrowseWatchSets {
  favouriteIds: ReadonlySet<number | string>;
  watchLaterIds: ReadonlySet<number | string>;
  inProgressIds: ReadonlySet<number | string>;
  watchedIds: ReadonlySet<number | string>;
  followedIds: ReadonlySet<number | string>;
  newEpisodeIds: ReadonlySet<number | string>;
  /** True when Followed Series detection is wired (series). */
  followedSupported?: boolean;
  /** True when New Episodes detection is wired (series). */
  newEpisodesSupported?: boolean;
}

export interface BrowseLoadResult {
  /** Catalogue rows (MovieRow / SeriesRow shaped). */
  rows: readonly unknown[];
  playlistId: string;
  playlistTitle: string;
  fromCache: boolean;
  loadError: boolean;
  /** Truthful error detail for the error state (never a fake "empty"). */
  errorMessage?: string;
  /** True when no playlist is configured at all. */
  noPlaylist?: boolean;
}

export interface BrowseDataSource {
  /** Load the catalogue (cached path first, like loadCouchCatalog). */
  load: () => Promise<BrowseLoadResult>;
  /** Adapt one raw row to a W1 CatalogRow (null drops the row). */
  toEntry: (row: unknown) => CatalogRow | null;
  /** Stable key for one raw row (matches the card's data-couch-key). */
  rowKey: (row: unknown) => string;
  /** Card view for one raw row. */
  cardView: (row: unknown, playlistId: string) => CouchCardView;
  /** Detail id passed to onOpenDetail for one raw row. */
  detailId: (row: unknown) => string;
  /** Optional per-card enrichment (e.g. series season counts). Called ONCE per fresh node. */
  decorateCard?: (card: HTMLElement, row: unknown, playlistId: string) => void;
  /** Current watch sets (read fresh on every derive — never cached across detail trips). */
  watchSets: (playlistId: string) => BrowseWatchSets;
  /** CACHED-ONLY confirmed season count for a series entry id (series; null = unknown). Never fetches. */
  seasonCount?: (playlistId: string, entryId: number | string) => number | null;
  /** Series status for an entry id, when genuinely known ("" = unknown). */
  seriesStatus?: (playlistId: string, entryId: number | string) => string;
  emptyTitle: string;
  emptyMessage: string;
}

export interface BrowseController {
  destroy(): void;
  /** Merge a state patch (constraint changes reset to page 1; page-only patches keep position). */
  setState(patch: BrowseStatePatch): void;
  getState(): BrowseState;
  /** Re-read watch sets + re-derive (call after a detail trip changes favourites/progress). */
  refresh(): void;
  /**
   * Suspend/resume key handling (the series controller keeps the
   * browse mount alive-but-hidden while Home shows; a suspended
   * mount ignores its key handler so Home owns the controller).
   */
  setSuspended(suspended: boolean): void;
  /** Open the search overlay (in-page Search action when already mounted). */
  openSearch(): void;
}

export interface MountBrowseEverythingOptions {
  kind: BrowseKind;
  initialState?: BrowseStatePatch;
  onOpenDetail: (id: string) => void;
  onExit: () => void;
  restoreFocus?: { id: string; page: number };
  source: BrowseDataSource;
  /** Open search after the first catalogue load (Home "Search Movies/Series" deep link). */
  autoOpenSearch?: boolean;
}

// ── Pure derive (tested directly) ────────────────────────────────

/**
 * One displayed title: a W1 group plus its primary row, member rows
 * and display aggregate. Built ONCE per index (WeakMap cache) — the
 * derive never rebuilds views, it only selects and orders them.
 */
export interface BrowseGroup {
  /** Display-level group id (W1 TitleGroup id). */
  id: string;
  /** Primary (display) entry id, as a string. */
  primaryId: string;
  /** Primary row, by reference (the card view + detail id source). */
  row: CatalogRow;
  /** All member rows, by reference, primary first. */
  rows: CatalogRow[];
  /** Display-level aggregate (year/rating/runtime/genres/added). */
  aggregate: GroupAggregate;
  /** The W1 group (variant ids, language tags, confidence). */
  group: TitleGroup;
}

interface BrowseViewCache {
  views: BrowseGroup[];
  byGroupId: Map<string, BrowseGroup>;
  byPrimaryId: Map<string, BrowseGroup>;
  /** Groups with no provider-category key on ANY member (the Uncategorised category). */
  uncategorisedIds: Set<string>;
}

const browseViewCache = new WeakMap<CatalogIndex, BrowseViewCache>();

function browseViewsFor(index: CatalogIndex): BrowseViewCache {
  const cached = browseViewCache.get(index);
  if (cached) return cached;
  const views: BrowseGroup[] = [];
  const byGroupId = new Map<string, BrowseGroup>();
  const byPrimaryId = new Map<string, BrowseGroup>();
  const uncategorisedIds = new Set<string>();
  for (const group of index.groups) {
    const aggregate = index.groupAggregates.get(group.id);
    const row = index.byId.get(group.primaryId);
    if (!aggregate || !row) continue;
    const rows: CatalogRow[] = [];
    for (const memberId of group.variantIds) {
      const member = index.byId.get(memberId);
      if (member) rows.push(member);
    }
    if (rows.length === 0) continue;
    const view: BrowseGroup = {
      id: group.id,
      primaryId: group.primaryId,
      row,
      rows,
      aggregate,
      group,
    };
    views.push(view);
    byGroupId.set(group.id, view);
    byPrimaryId.set(group.primaryId, view);
    // Uncategorised (category): no provider-category key on any
    // member. This is DELIBERATELY distinct from the genre-filter
    // value "uncategorised" (no genre evidence) — see D11.
    const hasCategory = group.variantIds.some(
      (memberId) => (index.meta.get(memberId)?.providerCategoryKey ?? "") !== "",
    );
    if (!hasCategory) uncategorisedIds.add(group.id);
  }
  const entry: BrowseViewCache = { views, byGroupId, byPrimaryId, uncategorisedIds };
  browseViewCache.set(index, entry);
  return entry;
}

export interface BrowseDeriveContext {
  /** Watch sets (read fresh per derive by the mount). */
  collection: BrowseWatchSets;
  /** Confirmed season counts by GROUP id (null = unknown). Series only. */
  seasonCounts: Map<string, number | null>;
  /** Series status by GROUP id ("" = unknown). Only genuine metadata. */
  seriesStatus?: Map<string, string>;
}

export interface BrowseDerived {
  groups: BrowseGroup[];
  /** Effective sort actually applied (relevance counts as "recommended" + search). */
  effectiveSort: BrowseSortId | "relevance";
  totalGroups: number;
  totalEntries: number;
}

function groupMatchesIds(
  group: BrowseGroup,
  ids: ReadonlySet<number | string>,
): boolean {
  for (const row of group.rows) {
    if (ids.has(row.id) || ids.has(String(row.id))) return true;
  }
  return false;
}

function groupWatchStatus(
  group: BrowseGroup,
  ctx: BrowseDeriveContext,
): "" | "unwatched" | "in-progress" | "watched" {
  // In-progress wins: any member mid-way makes the title in-progress.
  if (groupMatchesIds(group, ctx.collection.inProgressIds)) return "in-progress";
  if (groupMatchesIds(group, ctx.collection.watchedIds)) return "watched";
  return "unwatched";
}

function categoryBaseGroups(
  index: CatalogIndex,
  category: BrowseCategorySelection,
  ctx: BrowseDeriveContext,
  views: BrowseViewCache,
): BrowseGroup[] {
  switch (category.kind) {
    case "all":
      return [...views.views];
    case "genre": {
      const ids = index.idsByGenre.get(category.id);
      if (!ids) return [];
      const out: BrowseGroup[] = [];
      for (const id of ids) {
        const view = views.byPrimaryId.get(id);
        if (view) out.push(view);
      }
      return out;
    }
    case "provider": {
      const ids = index.idsByProviderCategory.get(category.id);
      if (!ids) return [];
      const out: BrowseGroup[] = [];
      for (const id of ids) {
        const view = views.byPrimaryId.get(id);
        if (view) out.push(view);
      }
      return out;
    }
    case "uncategorised":
      return views.views.filter((view) => views.uncategorisedIds.has(view.id));
    case "collection": {
      switch (category.id) {
        case "recent":
          // Every title; the derive sorts by added when no order
          // was picked (collection default, below).
          return [...views.views];
        case "highest-rated":
          return views.views.filter((view) => view.aggregate.rating != null);
        case "unwatched":
          return views.views.filter(
            (view) => groupWatchStatus(view, ctx) === "unwatched",
          );
        case "continue":
          return views.views.filter((view) =>
            groupMatchesIds(view, ctx.collection.inProgressIds),
          );
        case "favourites":
          return views.views.filter((view) =>
            groupMatchesIds(view, ctx.collection.favouriteIds),
          );
        case "watchlater":
          return views.views.filter((view) =>
            groupMatchesIds(view, ctx.collection.watchLaterIds),
          );
        case "followed":
          return views.views.filter((view) =>
            groupMatchesIds(view, ctx.collection.followedIds),
          );
        case "new-episodes":
          return views.views.filter((view) =>
            groupMatchesIds(view, ctx.collection.newEpisodeIds),
          );
        default:
          // Unknown collection id matches NOTHING — never a
          // silent All (D12: derive-level strictness; the URL
          // parser is the lenient layer for stale links).
          return [];
      }
    }
    default:
      return [...views.views];
  }
}

/**
 * Runtime bucket test over aggregate minutes. Boundaries mirror
 * browse-filters' runtimeBucketMatches exactly: under-* is strict
 * `<`, over-180 is strict `> 180`. Unknown runtimes never pass a
 * bucket (the caller excludes them before calling).
 */
function runtimeMinutesMatchesBucket(minutes: number, bucket: string): boolean {
  switch (bucket) {
    case "under-60":
      return minutes < 60;
    case "under-90":
      return minutes < 90;
    case "under-120":
      return minutes < 120;
    case "under-150":
      return minutes < 150;
    case "under-180":
      return minutes < 180;
    case "over-180":
      return minutes > 180;
    default:
      return true;
  }
}

function groupPassesFilters(
  group: BrowseGroup,
  filters: BrowseFilters,
  index: CatalogIndex,
  ctx: BrowseDeriveContext,
): boolean {
  const aggregate = group.aggregate;
  // Genre (single default; multi only with explicit OR/AND).
  // The "uncategorised" genre value means NO genre evidence.
  if (filters.genreMode !== "single" && filters.genres.length > 0) {
    const have = new Set(aggregate.genreIds);
    const wanted = filters.genres;
    const ok =
      filters.genreMode === "multi-and"
        ? wanted.every((g) => (g === UNCATEGORISED_ID ? aggregate.genreIds.length === 0 : have.has(g)))
        : wanted.some((g) => (g === UNCATEGORISED_ID ? aggregate.genreIds.length === 0 : have.has(g)));
    if (!ok) return false;
  } else if (filters.genre) {
    if (filters.genre === UNCATEGORISED_ID) {
      if (aggregate.genreIds.length !== 0) return false;
    } else if (!aggregate.genreIds.includes(filters.genre)) {
      return false;
    }
  }
  if (!browseYearMatches(aggregate.year, filters.year)) return false;
  if (!browseYearRangeMatches(aggregate.year, filters.yearFrom, filters.yearTo)) {
    return false;
  }
  if (filters.minRating > 0) {
    // Unrated titles NEVER pass a positive minimum.
    if (!ratingPassesMinimum(aggregate.rating, filters.minRating)) return false;
  }
  if (filters.runtime) {
    const minutes = aggregate.runtimeMinutes;
    if (minutes == null) return false;
    if (!runtimeMinutesMatchesBucket(minutes, filters.runtime)) return false;
  }
  if (filters.watchStatus) {
    if (groupWatchStatus(group, ctx) !== filters.watchStatus) return false;
  }
  if (filters.favouritesOnly && !groupMatchesIds(group, ctx.collection.favouriteIds)) {
    return false;
  }
  if (filters.watchLaterOnly && !groupMatchesIds(group, ctx.collection.watchLaterIds)) {
    return false;
  }
  if (filters.followedOnly && !groupMatchesIds(group, ctx.collection.followedIds)) {
    return false;
  }
  if (filters.newEpisodesOnly && !groupMatchesIds(group, ctx.collection.newEpisodeIds)) {
    return false;
  }
  if (filters.language) {
    // Language evidence is prefix-tag based only (D15): group tags
    // plus member meta tags. Suffix markers are grouping signals,
    // not language evidence.
    const tags = new Set<string>(group.group.tags ?? []);
    for (const memberId of group.group.variantIds) {
      const tag = index.meta.get(memberId)?.languageTag;
      if (tag) tags.add(tag);
    }
    if (!languageMatches([...tags], filters.language)) return false;
  }
  if (filters.providerCategory) {
    const matches = group.group.variantIds.some(
      (memberId) => index.meta.get(memberId)?.providerCategoryKey === filters.providerCategory,
    );
    if (!matches) return false;
  }
  if (filters.seasonCount) {
    if (!seasonCountMatches(ctx.seasonCounts.get(group.id) ?? null, filters.seasonCount)) {
      return false;
    }
  }
  if (filters.seriesStatus) {
    const status = (ctx.seriesStatus?.get(group.id) ?? "").trim().toLowerCase();
    if (status !== filters.seriesStatus) return false;
  }
  return true;
}

function sortedIndexKeyFor(sort: BrowseSortId): keyof CatalogIndex["sortedIds"] {
  switch (sort) {
    case "added":
      return "added";
    case "year-desc":
      return "yearDesc";
    case "year-asc":
      return "yearAsc";
    case "rating":
      return "rating";
    case "az":
      return "titleAsc";
    case "za":
      return "titleDesc";
    case "recommended":
    default:
      return "catalogue";
  }
}

/**
 * Order via the precomputed sorted-id index: walk the index once,
 * collecting wanted groups — O(N), no position map, no sort. The
 * index walk is the §15.2/§15.7 contract: deriving never sorts
 * 50k titles from scratch.
 */
function orderBySortedIndex(
  groups: BrowseGroup[],
  index: CatalogIndex,
  sort: BrowseSortId,
  views: BrowseViewCache,
): BrowseGroup[] {
  const order = index.sortedIds[sortedIndexKeyFor(sort)];
  const wanted = new Set(groups.map((g) => g.primaryId));
  const out: BrowseGroup[] = [];
  for (const id of order) {
    if (!wanted.has(id)) continue;
    const view = views.byPrimaryId.get(id);
    if (view) out.push(view);
  }
  // Safety: any group missing from the sorted index (cannot happen
  // for groups built from this index) appends in input order rather
  // than vanishing.
  if (out.length !== groups.length) {
    const seen = new Set(out.map((g) => g.id));
    for (const group of groups) {
      if (!seen.has(group.id)) out.push(group);
    }
  }
  return out;
}

function compareTitleKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Decorated sort: counts + precomputed title keys, sorted once.
 * Never a per-comparison localeCompare (18s at 50k per W5's
 * finding). Unknown counts sort last.
 */
function orderBySeasons(
  groups: BrowseGroup[],
  ctx: BrowseDeriveContext,
): BrowseGroup[] {
  noteDecoratedSort();
  const decorated = groups.map((group) => ({
    group,
    count: ctx.seasonCounts.get(group.id) ?? null,
    title: group.aggregate.normalisedTitle,
  }));
  decorated.sort((a, b) => {
    if (a.count == null && b.count == null) return compareTitleKeys(a.title, b.title);
    if (a.count == null) return 1;
    if (b.count == null) return -1;
    return b.count - a.count || compareTitleKeys(a.title, b.title);
  });
  return decorated.map((d) => d.group);
}

/** "Most Recently Updated": real `updated` evidence only, unknown last. */
function orderByUpdated(groups: BrowseGroup[]): BrowseGroup[] {
  noteDecoratedSort();
  const decorated = groups.map((group) => {
    const raw = Number((group.row as CatalogRow).updated);
    return {
      group,
      updated: Number.isFinite(raw) && raw > 0 ? raw : 0,
      title: group.aggregate.normalisedTitle,
    };
  });
  decorated.sort(
    (a, b) => b.updated - a.updated || compareTitleKeys(a.title, b.title),
  );
  return decorated.map((d) => d.group);
}

function applySortOrder(
  groups: BrowseGroup[],
  index: CatalogIndex,
  sort: BrowseSortId,
  ctx: BrowseDeriveContext,
  views: BrowseViewCache,
): BrowseGroup[] {
  if (sort === "seasons") return orderBySeasons(groups, ctx);
  if (sort === "updated") return orderByUpdated(groups);
  return orderBySortedIndex(groups, index, sort, views);
}

/** W1 search cap: searchCatalogIndex clamps its limit to 500. */
const SEARCH_RESULT_LIMIT = 500;

/**
 * Pure derive: category → filters → search → sort. Called ONLY on
 * dataset changes (state transitions, catalogue loads, refreshes)
 * — never on focus movement, never on scroll. Search results use
 * relevance order unless the user explicitly picked a sort.
 */
export function deriveBrowseGroups(
  index: CatalogIndex,
  state: BrowseState,
  ctx: BrowseDeriveContext,
): BrowseDerived {
  noteDeriveCall();
  const views = browseViewsFor(index);
  const base = categoryBaseGroups(index, state.category, ctx, views);
  const query = state.search.trim();
  const searching = hasSearchableQuery(query);
  let groups: BrowseGroup[];
  let effectiveSort: BrowseSortId | "relevance";

  if (searching) {
    const scope = resolveSearchScope(state.searchScope, state.category.kind);
    let hitIds: string[];
    if (scope === "category" && state.category.kind === "genre") {
      // Genre-scoped search: W1 pools the search to the genre.
      hitIds = searchCatalogIndex(index, query, { genreId: state.category.id }, SEARCH_RESULT_LIMIT);
    } else {
      hitIds = searchCatalogIndex(index, query, null, SEARCH_RESULT_LIMIT);
      if (scope === "category") {
        // Non-genre category scope: intersect with the category
        // base set, preserving relevance rank.
        const baseIds = new Set(base.map((g) => g.primaryId));
        hitIds = hitIds.filter((id) => baseIds.has(id));
      }
    }
    groups = [];
    for (const id of hitIds) {
      const view = views.byPrimaryId.get(id);
      if (view) groups.push(view);
    }
    // Filters still apply on top of search (all visible in the summary).
    groups = groups.filter((g) => groupPassesFilters(g, state.filters, index, ctx));
    if (state.sort !== "recommended") {
      effectiveSort = state.sort;
      groups = applySortOrder(groups, index, state.sort, ctx, views);
    } else {
      // Relevance order from the search hits is preserved.
      effectiveSort = "relevance";
    }
  } else {
    groups = base.filter((g) => groupPassesFilters(g, state.filters, index, ctx));
    let sort: BrowseSortId = state.sort;
    if (sort === "recommended") {
      // Collection defaults: Recently Added / Highest Rated read
      // newest-first / best-first unless the user picked an order.
      if (state.category.kind === "collection" && state.category.id === "recent") {
        sort = "added";
      } else if (
        state.category.kind === "collection" &&
        state.category.id === "highest-rated"
      ) {
        sort = "rating";
      }
    }
    effectiveSort = sort;
    groups = applySortOrder(groups, index, sort, ctx, views);
  }

  return {
    groups,
    effectiveSort,
    totalGroups: groups.length,
    totalEntries: groups.reduce((n, g) => n + g.rows.length, 0),
  };
}

// ── Mount ────────────────────────────────────────────────────────

type BrowseLayer = "grid" | "categories" | "filters" | "search" | "sort";

const MIN_CARD_WIDTH = 200;
const GRID_GAP = 20;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function mountBrowseEverything(
  container: HTMLElement,
  opts: MountBrowseEverythingOptions,
): BrowseController {
  const kind = opts.kind;
  const source = opts.source;
  const guard = createGenerationGuard();

  // Initial state: explicit initialState wins; otherwise the URL
  // mode (home-browse-modes contract) so reloads restore the view.
  let state: BrowseState =
    opts.initialState != null
      ? createBrowseState(kind, opts.initialState)
      : browseStateFromMode(parseModeFromUrl(kind));
  if (opts.restoreFocus) {
    state = { ...state, page: opts.restoreFocus.page, selectedId: opts.restoreFocus.id };
  }

  let destroyed = false;
  let suspended = false;
  let pendingOpenSearch = opts.autoOpenSearch ?? false;
  let layer: BrowseLayer = "grid";
  let index: CatalogIndex | null = null;
  let playlistId = "";
  let playlistTitle = "";
  let derived: BrowseDerived = { groups: [], effectiveSort: "recommended", totalGroups: 0, totalEntries: 0 };
  let seasonCounts = new Map<string, number | null>();
  let seriesStatusMap = new Map<string, string>();
  let columns = 6;
  let loadFailed = false;
  let loadErrorMessage = "";
  let noPlaylist = false;
  let categoryNotice = "";
  let preSearchState: BrowseState | null = null;
  let firstRenderDone = false;
  let disposed: Array<() => void> = [];

  const onDispose = (fn: () => void) => {
    disposed.push(fn);
  };

  // ── DOM skeleton ────────────────────────────────────────────
  const root = el("div", "rs-browse2");
  root.setAttribute("data-browse-everything", "");
  root.setAttribute("data-browse-kind", kind);
  root.setAttribute("data-browse-layer", "grid");

  const head = el("header", "rs-browse2__head");
  const titleEl = el("h1", "rs-page-title");
  titleEl.textContent = kind === "movie" ? "Browse Movies" : "Browse Series";
  head.appendChild(titleEl);
  const metaEl = el("p", "rs-browse2__meta");
  const countEl = el("span", "rs-browse2__count");
  countEl.setAttribute("data-role", "browse-count");
  const categoryEl = el("span", "rs-browse2__category");
  categoryEl.setAttribute("data-role", "browse-category");
  metaEl.append(countEl, document.createTextNode(" · "), categoryEl);
  head.appendChild(metaEl);
  const summaryRow = el("p", "rs-browse2__summary-row");
  const summaryEl = el("span", "rs-browse2__summary");
  summaryEl.setAttribute("data-role", "browse-summary");
  summaryRow.appendChild(summaryEl);
  head.appendChild(summaryRow);
  root.appendChild(head);

  const actionsEl = el("div", "rs-browse2__actions");
  actionsEl.setAttribute("role", "group");
  actionsEl.setAttribute("aria-label", "Browse actions");
  const mkAction = (id: string, label: string, hint: string): HTMLButtonElement => {
    const btn = el("button", "rs-hero__action rs-hero__action--secondary rs-browse2__action") as HTMLButtonElement;
    btn.type = "button";
    btn.setAttribute("data-browse-action", id);
    btn.setAttribute("aria-label", `${label} (${hint})`);
    btn.innerHTML = "";
    const glyph = el("span", "rs-browse2__action-glyph");
    glyph.textContent = hint;
    glyph.setAttribute("aria-hidden", "true");
    const text = el("span", "rs-browse2__action-label");
    text.textContent = label;
    btn.append(glyph, text);
    actionsEl.appendChild(btn);
    return btn;
  };
  const searchBtn = mkAction("search", "Search", "Y");
  const categoriesBtn = mkAction("categories", "Categories", "◀");
  const filtersBtn = mkAction("filters", "Filters", "☰");
  const sortBtn = mkAction("sort", "Sort", "⇅");
  const resetBtn = mkAction("reset", "Reset All", "✕");
  root.appendChild(actionsEl);

  const statusEl = el("div", "rs-browse2__status");
  statusEl.setAttribute("data-role", "browse-status");
  statusEl.setAttribute("aria-live", "polite");
  root.appendChild(statusEl);

  const gridHost = el("div", "rs-browse2__grid-host");
  gridHost.setAttribute("data-role", "browse-grid-host");
  root.appendChild(gridHost);

  const paginationEl = el("nav", "rs-browse2__pagination");
  paginationEl.setAttribute("aria-label", "Browse pages");
  root.appendChild(paginationEl);

  const hintsEl = el("div", "rs-browse2__hints");
  hintsEl.setAttribute("data-role", "browse-hints");
  hintsEl.setAttribute("aria-hidden", "true");
  root.appendChild(hintsEl);

  const overlayHost = el("div", "rs-browse2__overlay-host");
  overlayHost.setAttribute("data-role", "browse-overlay-host");
  root.appendChild(overlayHost);

  container.appendChild(root);

  // ── Keyed grid ──────────────────────────────────────────────
  const decorated = new WeakSet<HTMLElement>();
  interface GridItem {
    key: string;
    signature: string;
    group: BrowseGroup;
    view: CouchCardView;
  }
  const grid: KeyedPageGrid<GridItem> = createKeyedPageGrid<GridItem>({
    buildCard: (item) => {
      const card = buildBrowseGridCard(
        { ...item.view, href: undefined },
        item.key,
      );
      // Cards are buttons, not links: activation goes through
      // onOpenDetail (the mount contract), never a navigation.
      card.setAttribute("data-couch-key", item.view.itemKey ?? item.key);
      card.addEventListener("click", (ev) => {
        ev.preventDefault();
        openDetailFor(item.group);
      });
      card.addEventListener("keydown", (ev) => {
        // Held-key repeats must not double-activate (§16.6).
        if (ev.repeat) return;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openDetailFor(item.group);
        }
      });
      if (source.decorateCard && !decorated.has(card)) {
        decorated.add(card);
        try {
          source.decorateCard(card, item.group.row, playlistId);
        } catch {
          // Decoration is enrichment; a failure never breaks the card.
        }
      }
      return card;
    },
    updateCard: (node, item) => updateCouchCard(node, { ...item.view, href: undefined }),
    onRendered: () => {
      try {
        (window as unknown as { SpatialNavigation?: { makeFocusable?: () => void } })
          .SpatialNavigation?.makeFocusable?.();
      } catch {
        // Non-DOM / no spatial nav: focus still works natively.
      }
    },
  });
  grid.el.setAttribute("data-nylah-rail", "browse-grid");
  grid.el.setAttribute("aria-label", kind === "movie" ? "All movies" : "All series");
  gridHost.appendChild(grid.el);

  // ── Prefetch (bounded: next page only, cancellable) ─────────
  let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  const prefetched = new Set<string>();
  const cancelPrefetch = () => {
    if (prefetchTimer !== undefined) {
      clearTimeout(prefetchTimer);
      prefetchTimer = undefined;
    }
  };
  const schedulePrefetch = (urls: string[]) => {
    cancelPrefetch();
    const fresh = urls.filter((u) => u && !prefetched.has(u)).slice(0, BROWSE_DEFAULT_PAGE_SIZE);
    if (fresh.length === 0) return;
    const run = () => {
      if (destroyed || document.hidden) return;
      for (const url of fresh) {
        prefetched.add(url);
        const img = new Image();
        img.decoding = "async";
        img.src = url;
      }
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric(run, { timeout: 800 });
      prefetchTimer = setTimeout(() => {}, 0);
      onDispose(() => {
        try {
          (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
        } catch {
          // ignore
        }
      });
    } else {
      prefetchTimer = setTimeout(run, 300);
    }
  };

  // ── Derive + render ─────────────────────────────────────────
  const buildDeriveContext = (): BrowseDeriveContext => {
    const sets = source.watchSets(playlistId);
    return { collection: sets, seasonCounts, seriesStatus: seriesStatusMap };
  };

  const computeColumns = (): number => {
    const width = gridHost.clientWidth || container.clientWidth || window.innerWidth;
    return Math.max(4, Math.min(8, gridColumnsForWidth(width, MIN_CARD_WIDTH, GRID_GAP)));
  };

  const syncUrl = () => {
    setModeInUrl(modeFromBrowseState(state));
  };

  const setLayer = (next: BrowseLayer) => {
    layer = next;
    root.setAttribute("data-browse-layer", next);
    renderHints();
  };

  const renderHints = () => {
    const hints: Record<BrowseLayer, string> = {
      grid: "D-pad Move · A Open · B Back · X Details · Y Search · LB/RB Page · Menu Filters",
      categories: "D-pad Move · A Select · B Back · ◀ ▶ List",
      filters: "↕ Family · ↔ Value · A Select · B Cancel",
      search: "Type to search · Enter Apply · B Close",
      sort: "D-pad Move · A Select · B Close without changing",
    };
    hintsEl.textContent = hints[layer];
  };

  const renderHeader = () => {
    const info = browsePageInfo(state, derived.totalGroups);
    countEl.textContent =
      derived.totalGroups === 0
        ? "No titles"
        : `${derived.totalGroups.toLocaleString()} ${derived.totalGroups === 1 ? "title" : "titles"}`;
    categoryEl.textContent = state.category.label;
    const summary = activeFilterSummary(state, {
      genreLabel: (id) => genreLabelForId(id, kind === "movie" ? "vod" : "series"),
      providerLabel: (id) => providerCategoryInfo(id).rawLabel || id,
    });
    summaryEl.textContent = summary
      ? `Showing: ${summary}`
      : index
        ? `All titles · ${index.totalEntries.toLocaleString()} versions`
        : "";
    resetBtn.disabled = !hasActiveBrowseConstraints(state) && !categoryNotice;
    void info;
  };

  const renderPagination = () => {
    const info = browsePageInfo(state, derived.totalGroups);
    paginationEl.replaceChildren();
    if (info.totalPages <= 1) {
      paginationEl.hidden = true;
      return;
    }
    paginationEl.hidden = false;
    const label = el("span", "rs-browse2__page-label");
    label.textContent = `Page ${info.page} of ${info.totalPages} · ${info.totalResults.toLocaleString()} results`;
    const mkPageBtn = (
      text: string,
      target: number,
      disabled: boolean,
      aria: string,
      extraClass?: string,
    ) => {
      const btn = el(
        "button",
        `rs-browse2__page-btn${extraClass ? ` ${extraClass}` : ""}`,
      ) as HTMLButtonElement;
      btn.type = "button";
      btn.textContent = text;
      btn.disabled = disabled;
      btn.setAttribute("aria-label", aria);
      btn.addEventListener("click", () => gotoPage(target));
      return btn;
    };
    paginationEl.append(
      mkPageBtn("« First", 1, !info.hasPrev, "First page", "rs-browse2__pagination-first"),
      mkPageBtn("‹ Prev", info.page - 1, !info.hasPrev, "Previous page", "rs-browse2__pagination-prev"),
    );
    for (const p of browsePageJumpWindow(info.page, info.totalPages)) {
      const btn = mkPageBtn(String(p), p, false, `Page ${p}`, "rs-browse2__pagination-jump");
      if (p === info.page) {
        btn.classList.add("is-current");
        btn.setAttribute("aria-current", "page");
      }
      paginationEl.appendChild(btn);
    }
    paginationEl.append(
      mkPageBtn("Next ›", info.page + 1, !info.hasNext, "Next page", "rs-browse2__pagination-next"),
      mkPageBtn("Last »", info.totalPages, !info.hasNext, "Last page", "rs-browse2__pagination-last"),
      label,
    );
  };

  const renderStatus = () => {
    statusEl.replaceChildren();
    if (!index && !loadFailed && !noPlaylist) {
      // Loading skeleton (12 placeholders, no fake titles).
      const skel = el("div", "rs-browse2__skeleton");
      skel.setAttribute("aria-label", "Loading catalogue");
      for (let i = 0; i < 12; i++) {
        skel.appendChild(el("div", "rs-browse2__skeleton-card"));
      }
      statusEl.appendChild(skel);
      const loading = el("p", "rs-browse2__status-text");
      loading.textContent = "Loading…";
      statusEl.appendChild(loading);
      return;
    }
    if (loadFailed) {
      const box = el("div", "rs-browse2__notice rs-browse2__notice--error");
      box.setAttribute("role", "alert");
      const text = el("p", "rs-browse2__status-text");
      text.textContent = `Could not reach ${playlistTitle || "the provider"}${loadErrorMessage ? ` — ${loadErrorMessage.replace(/\.+$/, "")}` : ""}. Showing nothing rather than stale data.`;
      const retry = el("button", "rs-hero__action rs-hero__action--secondary") as HTMLButtonElement;
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => void reload());
      box.append(text, retry);
      statusEl.appendChild(box);
      return;
    }
    if (noPlaylist) {
      const box = el("div", "rs-browse2__notice");
      const text = el("p", "rs-browse2__status-text");
      text.textContent = "No playlist yet. Add a playlist in Settings to browse your library.";
      const link = el("a", "rs-hero__action rs-hero__action--secondary") as HTMLAnchorElement;
      link.href = "/settings";
      link.textContent = "Open Settings";
      box.append(text, link);
      statusEl.appendChild(box);
      return;
    }
    if (index && index.totalGroups === 0) {
      const box = el("div", "rs-browse2__notice");
      const title = el("h2", "rs-browse2__empty-title");
      title.textContent = source.emptyTitle;
      const text = el("p", "rs-browse2__status-text");
      text.textContent = source.emptyMessage;
      box.append(title, text);
      statusEl.appendChild(box);
      return;
    }
    if (categoryNotice) {
      const box = el("div", "rs-browse2__notice");
      const text = el("p", "rs-browse2__status-text");
      text.textContent = categoryNotice;
      box.appendChild(text);
      statusEl.appendChild(box);
    }
    if (index && derived.totalGroups === 0) {
      const box = el("div", "rs-browse2__notice");
      const title = el("h2", "rs-browse2__empty-title");
      title.textContent = state.search.trim() ? "No results for this search" : "No matches";
      const text = el("p", "rs-browse2__status-text");
      const summary = activeFilterSummary(state, {
        genreLabel: (id) => genreLabelForId(id, kind === "movie" ? "vod" : "series"),
        providerLabel: (id) => providerCategoryInfo(id).rawLabel || id,
      });
      text.textContent = summary
        ? `Applied filters: ${summary}. Nothing in the catalogue matches all of them.`
        : "Nothing in the catalogue matches.";
      const reset = el("button", "rs-hero__action rs-hero__action--secondary") as HTMLButtonElement;
      reset.type = "button";
      reset.textContent = "Reset All";
      reset.addEventListener("click", () => resetAll());
      box.append(title, text, reset);
      if (state.search.trim()) {
        const ai = el("button", "rs-hero__action rs-hero__action--secondary") as HTMLButtonElement;
        ai.type = "button";
        ai.textContent = "Ask AI for Recommendations";
        ai.addEventListener("click", () => askAi());
        box.appendChild(ai);
      }
      statusEl.appendChild(box);
    }
  };

  const renderGridPage = (focus: { mode: "first" | "keep-key" | "keep-index" | "none"; key?: string | null; index?: number } = { mode: "none" }) => {
    if (!index) return;
    const info = browsePageInfo(state, derived.totalGroups);
    const pageGroups = derived.groups.slice(info.startIndex, info.endIndex);
    const items: GridItem[] = pageGroups.map((group) => {
      const view = source.cardView(group.row, playlistId);
      return {
        key: group.id,
        signature: couchCardSignature({ ...view, href: undefined }),
        group,
        view: { ...view, href: undefined },
      };
    });
    let focusKey: string | null = null;
    if (focus.mode === "first") focusKey = items[0]?.key ?? null;
    else if (focus.mode === "keep-key" && focus.key) {
      focusKey = items.some((i) => i.key === focus.key)
        ? focus.key
        : (items[Math.min(focus.index ?? 0, Math.max(0, items.length - 1))]?.key ?? null);
    } else if (focus.mode === "keep-index") {
      focusKey = items[Math.min(focus.index ?? 0, Math.max(0, items.length - 1))]?.key ?? null;
    }
    grid.setPage(items, { focusKey });
    // Bounded prefetch: the NEXT page's posters only.
    if (info.hasNext) {
      const nextGroups = derived.groups.slice(info.endIndex, info.endIndex + state.pageSize);
      schedulePrefetch(
        nextGroups
          .map((g) => source.cardView(g.row, playlistId).image)
          .filter((u): u is string => typeof u === "string" && u.length > 0),
      );
    } else {
      cancelPrefetch();
    }
    grid.el.style.setProperty("--rs-grid-cols", String(columns));
  };

  const renderAll = (focus: Parameters<typeof renderGridPage>[0] = { mode: "none" }) => {
    renderHeader();
    renderStatus();
    renderPagination();
    renderGridPage(focus);
    renderHints();
  };

  // ── State transitions (§1.5 operations 4–5) ──────────────────
  const rederive = () => {
    if (!index) return;
    derived = deriveBrowseGroups(index, state, buildDeriveContext());
    // Clamp the page into the new result set.
    const totalPages = browseTotalPages(derived.totalGroups, state.pageSize);
    if (totalPages > 0 && state.page > totalPages) {
      state = setPage(state, totalPages, totalPages);
    }
  };

  /** Operation 4 — dataset change: re-derive, render, focus the FIRST result. */
  const applyDatasetChange = () => {
    categoryNotice = "";
    rederive();
    syncUrl();
    renderAll({ mode: "first" });
  };

  /** Operation 5 — programmatic jump: turn the page, keep column/index. */
  const gotoPage = (page: number, keepIndex?: number) => {
    const totalPages = browseTotalPages(derived.totalGroups, state.pageSize);
    if (totalPages <= 1 && page === state.page) return;
    const focusedIdx = keepIndex ?? currentFocusedPageIndex();
    const prevPage = state.page;
    state = setPage(state, page, Math.max(1, totalPages));
    if (state.page !== prevPage) notePageTurn();
    syncUrl();
    renderHeader();
    renderPagination();
    renderGridPage({ mode: "keep-index", index: focusedIdx });
  };

  const currentFocusedPageIndex = (): number => {
    const active = document.activeElement as HTMLElement | null;
    const card = active?.closest?.("[data-browse-key]") as HTMLElement | null;
    if (!card || !grid.el.contains(card)) return 0;
    const children = Array.from(grid.el.children);
    return Math.max(0, children.indexOf(card));
  };

  const currentFocusedKey = (): string | null => {
    const active = document.activeElement as HTMLElement | null;
    const card = active?.closest?.("[data-browse-key]") as HTMLElement | null;
    return card?.dataset.browseKey ?? state.selectedId;
  };

  /** Operation 3 — restore focus after detail: exact poster or nearest survivor. */
  const restoreFocusAfterDetail = (id: string, page: number) => {
    const totalPages = browseTotalPages(derived.totalGroups, state.pageSize);
    state = setPage(state, page, Math.max(1, totalPages));
    const info = browsePageInfo(state, derived.totalGroups);
    const pageGroups = derived.groups.slice(info.startIndex, info.endIndex);
    const at = pageGroups.findIndex((g) => {
      return source.detailId(g.row) === id || g.id === id;
    });
    renderAll({
      mode: "keep-key",
      key: at >= 0 ? pageGroups[at].id : null,
      index: at >= 0 ? at : 0,
    });
    if (at < 0 && pageGroups.length > 0) {
      // Nearest surviving item: first card of the restored page.
      grid.focusKey(pageGroups[0].id);
    }
  };

  const resetAll = () => {
    const kindPageSize = state.pageSize;
    state = resetAllFilters(state);
    state = { ...state, pageSize: kindPageSize };
    applyDatasetChange();
    categoriesBtn.focus({ preventScroll: true });
  };

  const askAi = () => {
    // Handoff into Discover — NO LLM call here, NO competing
    // workflow. Discover owns the AI; this only carries the query.
    window.dispatchEvent(
      new CustomEvent("browse:ask-ai", {
        detail: { kind, query: state.search.trim() },
      }),
    );
  };

  const openDetailFor = (group: BrowseGroup) => {
    state = { ...state, selectedId: group.id };
    syncUrl();
    opts.onOpenDetail(source.detailId(group.row));
  };

  // ── Overlays ────────────────────────────────────────────────
  let categoryDrawer: BrowseCategoryDrawerHandle | null = null;
  let filterDrawer: BrowseFilterDrawerHandle | null = null;
  let sortOverlay: HTMLElement | null = null;
  let searchOverlay: HTMLElement | null = null;
  let sortFocusIndex = 0;
  let searchInput: HTMLInputElement | null = null;
  let searchScope: BrowseSearchScope = "all";
  let searchDebounced = createDebouncedSearch(() => {}, 200);

  const closeOverlay = (restoreFocusToGrid: boolean) => {
    searchDebounced.cancel();
    categoryDrawer?.destroy();
    categoryDrawer = null;
    filterDrawer?.destroy();
    filterDrawer = null;
    sortOverlay?.remove();
    sortOverlay = null;
    searchOverlay?.remove();
    searchOverlay = null;
    searchInput = null;
    overlayHost.replaceChildren();
    setLayer("grid");
    if (restoreFocusToGrid) {
      const key = currentFocusedKey() ?? state.selectedId;
      if (key && !grid.focusKey(key)) {
        const first = grid.el.querySelector<HTMLElement>("[data-browse-key]");
        first?.focus({ preventScroll: true });
      }
    }
  };

  const drawerStats = (): BrowseDrawerStats | null => {
    if (!index) return null;
    const ctx = buildDeriveContext();
    const views = browseViewsFor(index);
    const canonical =
      kind === "movie" ? CANONICAL_MOVIE_GENRES : CANONICAL_SERIES_GENRES;
    const genres = canonical.map((g) => ({
      id: g.id,
      label: g.label,
      count: index!.idsByGenre.get(g.id)?.length ?? 0,
    }));
    const sets = source.watchSets(playlistId);
    // Collection counts reuse the derive's own category bases, so
    // the drawer count ALWAYS equals the Browse result count.
    const countCollection = (id: string): number =>
      categoryBaseGroups(
        index!,
        { kind: "collection", id, label: id },
        ctx,
        views,
      ).length;
    const ratedCount = countCollection("highest-rated");
    const collections: BrowseDrawerStats["collections"] = [
      { id: "recent", label: "Recently Added", count: index.totalGroups, available: true },
      { id: "highest-rated", label: "Highest Rated", count: ratedCount, available: ratedCount > 0, unavailableReason: "No rated titles in this catalogue." },
      { id: "unwatched", label: "Unwatched", count: countCollection("unwatched"), available: true },
      { id: "continue", label: "Continue Watching", count: countCollection("continue"), available: true },
      { id: "favourites", label: "Favourites", count: countCollection("favourites"), available: true },
      { id: "watchlater", label: "Watch Later", count: countCollection("watchlater"), available: true },
    ];
    if (kind === "series") {
      const followedOk = sets.followedSupported ?? sets.followedIds.size > 0;
      const newEpOk = sets.newEpisodesSupported ?? sets.newEpisodeIds.size > 0;
      collections.push(
        {
          id: "followed",
          label: "Followed Series",
          count: countCollection("followed"),
          available: followedOk,
          unavailableReason: "Follow a series to see it here.",
        },
        {
          id: "new-episodes",
          label: "New Episodes",
          count: countCollection("new-episodes"),
          available: newEpOk,
          unavailableReason: "No new-episode detection for this catalogue yet.",
        },
      );
    }
    const genreUnion = new Set<string>();
    for (const [genreId, ids] of index.idsByGenre) {
      if (genreId === UNCATEGORISED_ID) continue;
      for (const id of ids) genreUnion.add(id);
    }
    const providerUnion = new Set<string>();
    for (const ids of index.idsByProviderCategory.values()) {
      for (const id of ids) providerUnion.add(id);
    }
    return {
      kind,
      totalGroups: index.totalGroups,
      genres,
      collections,
      providerCategories: [...index.idsByProviderCategory.entries()].map(([key, ids]) => ({
        id: key,
        label: providerCategoryInfo(key).rawLabel || key,
        count: ids.length,
      })),
      uncategorisedCount: views.uncategorisedIds.size,
      genreUnionCount: genreUnion.size,
      // Recently Added reaches every title, so the collection
      // family union is the full catalogue by construction.
      // (If "recent" is ever removed, union the member lists.)
      collectionUnionCount: index.totalGroups,
      providerUnionCount: providerUnion.size,
    };
  };

  const openCategories = () => {
    const stats = drawerStats();
    if (!stats) return;
    closeOverlay(false);
    preSearchState = null;
    setLayer("categories");
    categoryDrawer = mountBrowseCategoryDrawer(overlayHost, {
      families: buildBrowseDrawerFamilies(stats),
      selected: state.category,
      label: "Categories",
      onSelect: (selection) => {
        closeOverlay(false);
        state = selectCategory(state, selection);
        applyDatasetChange();
      },
      onBack: () => {
        // Close-without-select: restore the previous result focus.
        closeOverlay(true);
      },
    });
    categoryDrawer.focusCurrent();
  };

  const filterAvailability = (): BrowseFilterDrawerAvailability => {
    const base = { ...DEFAULT_FILTER_DRAWER_AVAILABILITY };
    if (!index) return base;
    const sets = source.watchSets(playlistId);
    const aggregates = [...index.groupAggregates.values()];
    const anyGenre = [...index.idsByGenre.entries()].some(
      ([genreId, ids]) => genreId !== UNCATEGORISED_ID && ids.length > 0,
    );
    const anyYear = aggregates.some((a) => a.year != null);
    const anyRating = aggregates.some((a) => a.rating != null);
    const anyRuntime =
      kind === "movie" && aggregates.some((a) => a.runtimeMinutes != null);
    const confirmed = [...seasonCounts.values()].filter((c) => c != null).length;
    const languageSet = new Set<string>();
    for (const group of index.groups) {
      for (const tag of group.tags ?? []) languageSet.add(tag);
    }
    for (const meta of index.meta.values()) {
      if (meta.languageTag) languageSet.add(meta.languageTag);
    }
    return {
      ...base,
      genre: anyGenre,
      year: anyYear,
      rating: anyRating,
      runtime: anyRuntime,
      seasonCounts: confirmed > 0,
      seasonCoverage: index.totalGroups > 0 ? confirmed / index.totalGroups : 0,
      seriesStatus: [...seriesStatusMap.values()].some(Boolean),
      languages: [...languageSet],
      providerCategories: [...index.idsByProviderCategory.keys()].map((key) => ({
        id: key,
        label: providerCategoryInfo(key).rawLabel || key,
      })),
      followedAvailable: sets.followedSupported ?? sets.followedIds.size > 0,
      newEpisodesAvailable: sets.newEpisodesSupported ?? sets.newEpisodeIds.size > 0,
    };
  };

  const openFilters = () => {
    if (!index) return;
    closeOverlay(false);
    setLayer("filters");
    const genreIds = (kind === "movie" ? CANONICAL_MOVIE_GENRES : CANONICAL_SERIES_GENRES).map((g) => g.id);
    filterDrawer = mountBrowseFilterDrawer(overlayHost, {
      kind,
      initial: state.filters,
      availability: filterAvailability(),
      genreIds,
      onApply: (filters) => {
        closeOverlay(false);
        state = { ...state, filters: { ...filters }, page: 1, selectedId: null };
        applyDatasetChange();
      },
      onCancel: () => {
        // Draft discarded; grid underneath untouched.
        closeOverlay(true);
      },
    });
    filterDrawer.focusCurrent();
  };

  const sortAvailability = (): BrowseSortAvailability => {
    if (!index) {
      return { added: false, year: false, rating: false, updated: false, seasons: false };
    }
    const aggregates = [...index.groupAggregates.values()];
    const anyAdded = aggregates.some((a) => a.addedMs != null);
    const anyYear = aggregates.some((a) => a.year != null);
    const anyRating = aggregates.some((a) => a.rating != null);
    const confirmed = [...seasonCounts.values()].filter((c) => c != null).length;
    const coverage = index.totalGroups > 0 ? confirmed / index.totalGroups : 0;
    return {
      added: anyAdded,
      year: anyYear,
      rating: anyRating,
      // "Most Recently Updated" needs real update evidence: a row
      // carrying an `updated` timestamp. Mapped rows carry none,
      // so the sort stays correctly gated off for bulk catalogues.
      updated: index.entries.some((row) => Number((row as CatalogRow).updated) > 0),
      // "Most Seasons" needs sufficient confirmed coverage (>= 50%).
      seasons: coverage >= 0.5,
    };
  };

  const openSort = () => {
    if (!index) return;
    closeOverlay(false);
    setLayer("sort");
    const options = browseSortOptions(kind, sortAvailability());
    sortFocusIndex = Math.max(0, options.findIndex((o) => o.value === state.sort));
    const overlay = el("div", "rs-browse-sort-overlay");
    overlay.setAttribute("data-browse-sort-overlay", "");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Sort");
    const scrim = el("div", "rs-browse-sort-overlay__scrim");
    scrim.setAttribute("aria-hidden", "true");
    const panel = el("div", "rs-browse-sort-overlay__panel");
    const title = el("h2", "rs-browse-sort-overlay__title");
    title.textContent = "Sort";
    panel.appendChild(title);
    if (state.search.trim()) {
      const note = el("p", "rs-browse-sort-overlay__note");
      note.textContent = "Search results use relevance unless you pick an order.";
      panel.appendChild(note);
    }
    const list = el("div", "rs-browse-sort-overlay__list");
    list.setAttribute("role", "listbox");
    options.forEach((option, i) => {
      const btn = el("button", "rs-browse-sort-overlay__option") as HTMLButtonElement;
      btn.type = "button";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(option.value === state.sort));
      btn.tabIndex = -1;
      if (i === sortFocusIndex) btn.classList.add("is-focused");
      if (option.value === state.sort) btn.classList.add("is-selected");
      btn.textContent = option.label;
      btn.addEventListener("click", () => {
        sortFocusIndex = i;
        applySort(option.value);
      });
      btn.addEventListener("mouseenter", () => {
        sortFocusIndex = i;
        paintSortFocus();
      });
      list.appendChild(btn);
    });
    panel.appendChild(list);
    const hints = el("p", "rs-browse-sort-overlay__hints");
    hints.setAttribute("aria-hidden", "true");
    hints.textContent = "D-pad Move · A Select · B Close without changing";
    panel.appendChild(hints);
    overlay.append(panel, scrim);
    overlayHost.appendChild(overlay);
    sortOverlay = overlay;
    scrim.addEventListener("click", () => closeOverlay(true));
    const paintSortFocus = () => {
      const btns = list.querySelectorAll<HTMLElement>("[role='option']");
      btns.forEach((b, i) => b.classList.toggle("is-focused", i === sortFocusIndex));
      btns[sortFocusIndex]?.focus({ preventScroll: true });
    };
    (overlay as unknown as { __paintSortFocus: () => void }).__paintSortFocus = paintSortFocus;
    (overlay as unknown as { __sortOptions: typeof options }).__sortOptions = options;
    paintSortFocus();
  };

  const applySort = (sort: BrowseSortId) => {
    closeOverlay(false);
    state = setSort(state, sort);
    applyDatasetChange();
  };

  const openSearch = () => {
    if (!index) return;
    closeOverlay(false);
    preSearchState = { ...state, filters: { ...state.filters } };
    searchScope = resolveSearchScope(state.searchScope, state.category.kind);
    setLayer("search");
    const overlay = el("div", "rs-browse-search-overlay");
    overlay.setAttribute("data-browse-search-overlay", "");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Search");
    const scrim = el("div", "rs-browse-search-overlay__scrim");
    scrim.setAttribute("aria-hidden", "true");
    const panel = el("div", "rs-browse-search-overlay__panel");
    const title = el("h2", "rs-browse-search-overlay__title");
    title.textContent = kind === "movie" ? "Search Movies" : "Search Series";
    panel.appendChild(title);
    const input = el("input", "rs-browse-search-overlay__input") as HTMLInputElement;
    input.type = "search";
    input.placeholder = kind === "movie" ? "Type a movie title…" : "Type a series title…";
    input.autocomplete = "off";
    input.value = state.search;
    panel.appendChild(input);
    searchInput = input;
    const scopeRow = el("div", "rs-browse-search-overlay__scope");
    scopeRow.setAttribute("role", "group");
    scopeRow.setAttribute("aria-label", "Search scope");
    for (const option of searchScopeOptions(state.category.label)) {
      const btn = el("button", "rs-browse-search-overlay__scope-btn") as HTMLButtonElement;
      btn.type = "button";
      btn.textContent = option.label;
      btn.setAttribute("aria-pressed", String(option.value === searchScope));
      if (option.value === searchScope) btn.classList.add("is-selected");
      if (option.value === "category" && state.category.kind === "all") {
        btn.disabled = true;
        btn.title = "You are already searching everything.";
      }
      btn.addEventListener("click", () => {
        searchScope = option.value;
        scopeRow.querySelectorAll("button").forEach((b) => {
          const selected = b === btn;
          b.classList.toggle("is-selected", selected);
          b.setAttribute("aria-pressed", String(selected));
        });
        applySearchQuery(input.value, true);
      });
      scopeRow.appendChild(btn);
    }
    panel.appendChild(scopeRow);
    const countNote = el("p", "rs-browse-search-overlay__count");
    countNote.setAttribute("data-role", "search-count");
    panel.appendChild(countNote);
    const actions = el("div", "rs-browse-search-overlay__actions");
    const applyBtn = el("button", "rs-hero__action") as HTMLButtonElement;
    applyBtn.type = "button";
    applyBtn.textContent = "Show Results";
    applyBtn.addEventListener("click", () => {
      searchDebounced.flush();
      const query = input.value;
      closeOverlay(false);
      state = setSearch(state, query, searchScope);
      applyDatasetChange();
    });
    const aiBtn = el("button", "rs-hero__action rs-hero__action--secondary") as HTMLButtonElement;
    aiBtn.type = "button";
    aiBtn.textContent = "Ask AI for Recommendations";
    aiBtn.addEventListener("click", () => {
      state = setSearch(state, input.value, searchScope);
      closeOverlay(false);
      applyDatasetChange();
      askAi();
    });
    const cancelBtn = el("button", "rs-hero__action rs-hero__action--secondary") as HTMLButtonElement;
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => cancelSearch());
    actions.append(applyBtn, aiBtn, cancelBtn);
    panel.appendChild(actions);
    overlay.append(panel, scrim);
    overlayHost.appendChild(overlay);
    searchOverlay = overlay;
    scrim.addEventListener("click", () => cancelSearch());

    const applySearchQuery = (query: string, immediate: boolean) => {
      const next = setSearch(state, query, searchScope);
      state = next;
      rederive();
      syncUrl();
      renderHeader();
      renderPagination();
      renderGridPage({ mode: "none" });
      countNote.textContent =
        derived.totalGroups === 0
          ? "No matches yet."
          : `${derived.totalGroups.toLocaleString()} ${derived.totalGroups === 1 ? "match" : "matches"}`;
      void immediate;
    };
    searchDebounced = createDebouncedSearch((q) => applySearchQuery(q, false), 200);
    input.addEventListener("input", () => searchDebounced.queue(input.value));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        searchDebounced.flush();
        const query = input.value;
        closeOverlay(false);
        state = setSearch(state, query, searchScope);
        applyDatasetChange();
      }
    });
    input.focus();
  };

  const cancelSearch = () => {
    // Cancelling preserves the browse position: restore the
    // exact pre-search state (query, scope, page, focus).
    const restore = preSearchState;
    preSearchState = null;
    closeOverlay(false);
    if (restore) {
      state = restore;
      rederive();
      syncUrl();
      renderAll({ mode: "keep-key", key: restore.selectedId ?? currentFocusedKey(), index: 0 });
      if (restore.selectedId) grid.focusKey(restore.selectedId);
    } else {
      renderAll({ mode: "none" });
    }
  };

  // ── Loading ─────────────────────────────────────────────────
  const reload = async () => {
    const generation = guard.next();
    loadFailed = false;
    loadErrorMessage = "";
    noPlaylist = false;
    index = null;
    renderAll({ mode: "none" });
    let result: BrowseLoadResult;
    try {
      result = await source.load();
    } catch (err) {
      if (!guard.isCurrent(generation) || destroyed) return;
      loadFailed = true;
      loadErrorMessage = err instanceof Error ? err.message : "The provider did not respond.";
      renderAll({ mode: "none" });
      return;
    }
    if (!guard.isCurrent(generation) || destroyed) return;
    if (result.noPlaylist) {
      noPlaylist = true;
      renderAll({ mode: "none" });
      return;
    }
    if (result.loadError) {
      loadFailed = true;
      loadErrorMessage = result.errorMessage ?? "";
      playlistTitle = result.playlistTitle;
      renderAll({ mode: "none" });
      return;
    }
    playlistId = result.playlistId;
    playlistTitle = result.playlistTitle;
    const entries: CatalogRow[] = [];
    for (const row of result.rows) {
      const entry = source.toEntry(row);
      if (entry) entries.push(entry);
    }
    const revision = `${playlistId}:${entries.length}:${result.fromCache ? "cache" : "live"}`;
    index = getCatalogIndex(kind, entries, revision, {
      playlistId,
      // §15.6: CACHED-ONLY season counts via the source's reader.
      // The index never fetches; a missing reader yields nulls.
      seasonCountReader: (id) => source.seasonCount?.(playlistId, id) ?? null,
    });
    // Season counts: read from the index meta (populated by the
    // cached-only reader above) — no second pass over the source,
    // no series-info requests. Status: genuine source metadata
    // only, keyed by group, primary id first.
    seasonCounts = new Map();
    seriesStatusMap = new Map();
    for (const group of index.groups) {
      let count = index.meta.get(group.primaryId)?.seasonCount ?? null;
      if (count == null) {
        for (const memberId of group.variantIds) {
          const memberCount = index.meta.get(memberId)?.seasonCount;
          if (memberCount != null) {
            count = memberCount;
            break;
          }
        }
      }
      seasonCounts.set(group.id, count);
      if (kind === "series" && source.seriesStatus) {
        try {
          const status = source.seriesStatus(playlistId, group.primaryId) ?? "";
          if (status) seriesStatusMap.set(group.id, status);
        } catch {
          // Unknown stays unknown.
        }
      }
    }
    // Removed-category rule (§18): a selected category that no
    // longer exists after refresh resets intelligently to All,
    // with a truthful notice — never a silent empty grid.
    const stats = drawerStats();
    if (stats && state.category.kind !== "all") {
      const families = buildBrowseDrawerFamilies(stats);
      const exists = families.some((f) =>
        f.items.some(
          (item) =>
            item.category.kind === state.category.kind &&
            item.category.id === state.category.id,
        ),
      );
      if (!exists) {
        categoryNotice = `The category “${state.category.label}” is no longer available — showing ${allCategoryForKind(kind).label}.`;
        state = { ...state, category: allCategoryForKind(kind), page: 1 };
      }
    }
    // Columns/page size for this viewport.
    columns = computeColumns();
    const rowsPerPage = Math.max(4, Math.min(6, Math.round(BROWSE_DEFAULT_PAGE_SIZE / columns)));
    state = { ...state, pageSize: pageSizeForGrid(columns, rowsPerPage) };
    rederive();
    syncUrl();
    if (!firstRenderDone) {
      firstRenderDone = true;
      if (opts.restoreFocus) {
        restoreFocusAfterDetail(opts.restoreFocus.id, opts.restoreFocus.page);
      } else if (state.selectedId) {
        renderAll({ mode: "keep-key", key: state.selectedId, index: 0 });
      } else {
        renderAll({ mode: "none" });
      }
      // Focus memory: after the first paint, restore where the
      // viewer was (couch-focus, consume-only).
      try {
        restoreCouchFocus();
      } catch {
        // Focus memory is a nicety, never fatal.
      }
      if (pendingOpenSearch) {
        pendingOpenSearch = false;
        openSearch();
      }
    } else {
      renderAll({ mode: "keep-key", key: currentFocusedKey(), index: currentFocusedPageIndex() });
    }
  };

  // ── Key handling (shared pipeline: KeyboardEvents only) ─────
  const onKeyDown = (event: KeyboardEvent) => {
    if (destroyed || suspended) return;
    // Never steal keys from a text field outside the search layer.
    const target = event.target as HTMLElement | null;
    const inField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    if (layer === "categories" && categoryDrawer) {
      if (categoryDrawer.handleKey(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (layer === "filters" && filterDrawer) {
      if (filterDrawer.handleKey(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (layer === "sort" && sortOverlay) {
      const options = (sortOverlay as unknown as { __sortOptions?: Array<{ value: BrowseSortId }> }).__sortOptions ?? [];
      const paint = (sortOverlay as unknown as { __paintSortFocus?: () => void }).__paintSortFocus;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        sortFocusIndex = Math.max(0, Math.min(options.length - 1, sortFocusIndex + (event.key === "ArrowDown" ? 1 : -1)));
        paint?.();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        const option = options[sortFocusIndex];
        if (option) applySort(option.value);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeOverlay(true);
        return;
      }
      return;
    }
    if (layer === "search" && searchOverlay) {
      if (event.key === "Escape") {
        // B closes the keyboard first, then the search layer:
        // while the input holds focus, Escape blurs it; the next
        // Escape cancels the search (position preserved).
        event.preventDefault();
        event.stopPropagation();
        if (document.activeElement === searchInput) {
          searchInput?.blur();
        } else {
          cancelSearch();
        }
        return;
      }
      // Arrows/Enter inside the overlay belong to its controls.
      return;
    }
    if (inField) return;

    // ── Grid layer ──
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      opts.onExit();
      return;
    }
    if (key === "y" || key === "Y") {
      event.preventDefault();
      event.stopPropagation();
      openSearch();
      return;
    }
    if (key === "m" || key === "M" || key === "ContextMenu") {
      event.preventDefault();
      event.stopPropagation();
      openFilters();
      return;
    }
    if (key === "x" || key === "X") {
      // X = context for the focused card. The context menu is
      // owned by the card/detail layer; this dispatches the event
      // it listens for and changes nothing itself.
      const focused = currentFocusedKey();
      if (focused) {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("browse:card-context", { detail: { kind, groupId: focused } }),
        );
      }
      return;
    }
    if (key === "PageUp" || key === "[") {
      event.preventDefault();
      event.stopPropagation();
      gotoPage(state.page - 1);
      return;
    }
    if (key === "PageDown" || key === "]") {
      event.preventDefault();
      event.stopPropagation();
      gotoPage(state.page + 1);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowUp" || key === "ArrowDown") {
      // Edge handling only — interior moves belong to spatial nav.
      const active = document.activeElement as HTMLElement | null;
      const card = active?.closest?.("[data-browse-key]") as HTMLElement | null;
      if (card && grid.el.contains(card)) {
        const idx = Array.from(grid.el.children).indexOf(card);
        const col = idx % Math.max(1, columns);
        if (key === "ArrowLeft" && col === 0) {
          event.preventDefault();
          event.stopPropagation();
          openCategories();
          return;
        }
        if (key === "ArrowUp" && idx < columns) {
          event.preventDefault();
          event.stopPropagation();
          searchBtn.focus({ preventScroll: true });
          return;
        }
        if (key === "ArrowDown") {
          const info = browsePageInfo(state, derived.totalGroups);
          const pageCount = info.endIndex - info.startIndex;
          const lastRowStart = pageCount - (pageCount % columns || columns);
          if (idx >= lastRowStart && info.totalPages > 1) {
            event.preventDefault();
            event.stopPropagation();
            paginationEl.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
            return;
          }
        }
      }
      // Up from pagination returns to the last grid row.
      if (key === "ArrowUp" && active && paginationEl.contains(active)) {
        event.preventDefault();
        event.stopPropagation();
        const cards = grid.el.querySelectorAll<HTMLElement>("[data-browse-key]");
        cards[cards.length - 1]?.focus({ preventScroll: true });
        return;
      }
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onDispose(() => window.removeEventListener("keydown", onKeyDown));

  // Focus tracking: record the selected poster (focus memory +
  // URL `selected`) without re-rendering anything.
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target as HTMLElement | null;
    const card = target?.closest?.("[data-browse-key]") as HTMLElement | null;
    if (!card || !grid.el.contains(card)) return;
    noteFocusMove();
    const key = card.dataset.browseKey;
    if (key && key !== state.selectedId) {
      state = { ...state, selectedId: key };
    }
  };
  root.addEventListener("focusin", onFocusIn);

  // Playlist switch: reload the catalogue (same as the legacy controller).
  const onActiveChanged = () => {
    if (!destroyed) void reload();
  };
  document.addEventListener("xt:active-changed", onActiveChanged);
  onDispose(() => document.removeEventListener("xt:active-changed", onActiveChanged));

  // Resize: recompute columns/page size; re-render the current
  // page preserving the focused key (debounced, like tv/ui/grid.ts).
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (destroyed || !index) return;
        const nextColumns = computeColumns();
        if (nextColumns === columns) return;
        columns = nextColumns;
        const rowsPerPage = Math.max(4, Math.min(6, Math.round(BROWSE_DEFAULT_PAGE_SIZE / columns)));
        const focusedKey = currentFocusedKey();
        state = { ...state, pageSize: pageSizeForGrid(columns, rowsPerPage) };
        rederive();
        renderAll({ mode: "keep-key", key: focusedKey, index: currentFocusedPageIndex() });
      }, 120);
    });
    resizeObserver.observe(container);
    onDispose(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
    });
  }

  // Header actions.
  searchBtn.addEventListener("click", () => openSearch());
  categoriesBtn.addEventListener("click", () => openCategories());
  filtersBtn.addEventListener("click", () => openFilters());
  sortBtn.addEventListener("click", () => openSort());
  resetBtn.addEventListener("click", () => resetAll());

  renderHints();
  void reload();

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      guard.cancel();
      searchDebounced.cancel();
      cancelPrefetch();
      closeOverlay(false);
      grid.destroy();
      for (const fn of disposed) {
        try {
          fn();
        } catch {
          // Teardown must not throw.
        }
      }
      disposed = [];
      root.remove();
    },
    setState(patch: BrowseStatePatch): void {
      if (destroyed) return;
      const constraintChanged =
        patch.category !== undefined ||
        patch.filters !== undefined ||
        patch.search !== undefined ||
        patch.searchScope !== undefined ||
        patch.sort !== undefined;
      const prevPage = state.page;
      state = {
        ...state,
        ...patch,
        filters: patch.filters ? { ...state.filters, ...patch.filters } : state.filters,
        category: patch.category ? { ...patch.category } : state.category,
      };
      if (constraintChanged && patch.page === undefined) {
        state = { ...state, page: 1 };
      }
      if (constraintChanged || state.page !== prevPage) {
        if (!index) {
          renderAll({ mode: "none" });
          return;
        }
        rederive();
        syncUrl();
        renderAll({ mode: constraintChanged ? "first" : "keep-key", key: state.selectedId, index: 0 });
      }
    },
    getState(): BrowseState {
      return {
        ...state,
        category: { ...state.category },
        filters: { ...state.filters, genres: [...state.filters.genres] },
      };
    },
    refresh(): void {
      if (destroyed || !index) return;
      rederive();
      renderAll({ mode: "keep-key", key: currentFocusedKey(), index: currentFocusedPageIndex() });
    },
    setSuspended(next: boolean): void {
      suspended = next;
    },
    openSearch(): void {
      if (destroyed) return;
      if (!index) {
        // Catalogue still loading: open search once it lands.
        pendingOpenSearch = true;
        return;
      }
      pendingOpenSearch = false;
      openSearch();
    },
  };
}

// Re-exported for tests/consumers that build drawer stats without mounting.
export { UNCATEGORISED_ID, CANONICAL_MOVIE_GENRES, CANONICAL_SERIES_GENRES };
export type { BrowseCategorySelection };
export { isDefaultBrowseFilters };
