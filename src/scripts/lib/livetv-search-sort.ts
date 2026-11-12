// RedSilk Couch — Live TV 2.0 search + sort contract (0.11.7, W4).
//
// The event contract and pure state rules shared by the Search
// overlay, the Sort overlay (both W4) and the Channel Browser /
// Category Drawer (W2). Pure and DOM-free except for the dispatch
// helpers, which take an explicit EventTarget (window in
// production) so tests assert on a plain EventTarget.
//
// Events (all CustomEvents on window):
//
//   livetv:open-search    W2 dispatches; the Search overlay
//                         listens. Detail: LivetvOpenSearchDetail
//                         (current group/subcategory context,
//                         optional current query + scope).
//   livetv:search-submit  The Search overlay dispatches on
//                         submit. Detail: { query, scope } plus
//                         the context the search was scoped to.
//                         An empty query means "clear the
//                         search" — the browser clears, it does
//                         not search for "".
//   livetv:open-sort      W2 dispatches; the Sort overlay
//                         listens. Detail: LivetvOpenSortDetail
//                         (current sort, when known).
//   livetv:sort-submit    The Sort overlay dispatches on
//                         selection. Detail: { sort }.
//   livetv:close-overlay  Either overlay dispatches on close
//                         WITHOUT a submit (B / Cancel). Detail:
//                         { overlay: "search" | "sort" }.
//                         Submitting overlays do NOT also
//                         dispatch close-overlay: one close
//                         signal per dismissal.
//
// Search scoping — the rule that stops silent intersections:
//
//   - By default, searching from within a subcategory searches
//     THAT subcategory (scope "category").
//   - The overlay always offers an obvious "All channels"
//     scope (scope "all").
//   - Changing category CLEARS a previous category-specific
//     search. Sports → Movies must never silently intersect:
//     a query scoped to Sports never applies to Movies.
//   - The ONLY exception is an explicitly selected global
//     search: scope "all" survives a category change, because
//     the user chose "search everything" and the category is
//     irrelevant to it. There is no other persistent mode and
//     no hidden constraint is ever carried between categories.
//
// Sort vocabulary is the browser's (livetv-browser.ts
// BrowserSort): "source" (provider order), "az", "za",
// "category" (category order). The selected sort persists in
// sessionStorage (LIVETV_SORT_STORAGE_KEY) so reopening the
// browser keeps the order the user picked; the browser reads
// the persisted value on mount and applies livetv:sort-submit
// live. Persistence is a nicety, never fatal (storage errors
// are swallowed, like livetv-state.ts).

import type { BrowserSort } from "./livetv-browser.js";

/** Sort values, in overlay display order. Identical to BrowserSort. */
export type LivetvSortValue = BrowserSort;

/** One sort option in the Sort overlay. */
export interface LivetvSortOption {
  value: LivetvSortValue;
  label: string;
}

/** The four sort options, in overlay order. No other options exist. */
export const LIVETV_SORT_OPTIONS: readonly LivetvSortOption[] = [
  { value: "source", label: "Provider order" },
  { value: "az", label: "A–Z" },
  { value: "za", label: "Z–A" },
  { value: "category", label: "Category order" },
] as const;

/** Default sort: the provider's own order. */
export const LIVETV_DEFAULT_SORT: LivetvSortValue = "source";

/** True when `value` is one of the four sort values. */
export function isLivetvSortValue(value: unknown): value is LivetvSortValue {
  return (
    value === "source" || value === "az" || value === "za" || value === "category"
  );
}

/** Parse a sort value, falling back to `fallback` (default: provider order). */
export function parseLivetvSort(
  value: unknown,
  fallback: LivetvSortValue = LIVETV_DEFAULT_SORT,
): LivetvSortValue {
  return isLivetvSortValue(value) ? value : fallback;
}

/** Label for a sort value ("Provider order" for unknown values). */
export function livetvSortLabel(value: unknown): string {
  const found = LIVETV_SORT_OPTIONS.find((option) => option.value === value);
  return found ? found.label : "Provider order";
}

// ── Search scope ────────────────────────────────────────────────

/** Search scope: within the current category, or across all channels. */
export type LivetvSearchScope = "category" | "all";

/**
 * The category context a search is scoped to. W2's
 * `livetv:open-search` detail may name it as a group, a
 * subcategory, or a plain category — parseLivetvSearchContext
 * normalises every spelling to this shape. Ids are provider
 * group ids (groupChannels) or the browser pseudo-categories
 * "all" / "favourites" / "recents". Labels are display names,
 * never invented: when W2 supplies no label the id is shown.
 */
export interface LivetvSearchContext {
  /** Group id (provider group or pseudo-category), when known. */
  groupId?: string | null;
  /** Group display label, when known. */
  groupLabel?: string | null;
  /** Subcategory id within the group, when known. */
  subcategoryId?: string | null;
  /** Subcategory display label, when known. */
  subcategoryLabel?: string | null;
}

/** The category id a scope applies to: subcategory wins over group. */
export function searchContextCategoryId(
  context: LivetvSearchContext | null | undefined,
): string | null {
  if (!context) return null;
  return context.subcategoryId ?? context.groupId ?? null;
}

/** Display label for the scoped category: subcategory wins over group. */
export function searchContextLabel(
  context: LivetvSearchContext | null | undefined,
): string | null {
  if (!context) return null;
  return (
    context.subcategoryLabel ??
    context.subcategoryId ??
    context.groupLabel ??
    context.groupId ??
    null
  );
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Normalise a `livetv:open-search` context from any spelling W2
 * uses: { groupId, groupLabel, subcategoryId, subcategoryLabel }
 * or the flat { categoryId, categoryLabel } / { category, label }
 * forms. Unknown / empty values become null. Never throws.
 */
export function parseLivetvSearchContext(detail: unknown): LivetvSearchContext {
  if (typeof detail !== "object" || detail === null) return {};
  const record = detail as Record<string, unknown>;
  // The context may sit at the top level of the detail or under
  // a nested `context` object; both spellings are accepted.
  const nested =
    typeof record["context"] === "object" && record["context"] !== null
      ? (record["context"] as Record<string, unknown>)
      : null;
  const read = (key: string): string | null =>
    asNonEmptyString(record[key]) ??
    (nested ? asNonEmptyString(nested[key]) : null);
  const groupId = read("groupId") ?? read("categoryId") ?? read("category");
  const groupLabel = read("groupLabel") ?? read("categoryLabel") ?? read("label");
  return {
    groupId,
    groupLabel,
    subcategoryId: read("subcategoryId") ?? read("subcategory"),
    subcategoryLabel: read("subcategoryLabel"),
  };
}

/**
 * Default scope for a context: "category" when the context
 * names a specific group/subcategory, "all" when it names
 * "all" (or nothing at all). Favourites / recents count as a
 * specific category — searching within them is meaningful.
 */
export function defaultSearchScope(
  context: LivetvSearchContext | null | undefined,
): LivetvSearchScope {
  const id = searchContextCategoryId(context);
  if (!id || id === "all") return "all";
  return "category";
}

/** True when `value` is a search scope. */
export function isLivetvSearchScope(value: unknown): value is LivetvSearchScope {
  return value === "category" || value === "all";
}

/**
 * Label for the category-scope button: "In <label>" when the
 * context names a category, "In this category" when it does
 * not. The all-scope button is always "All channels".
 */
export function searchScopeButtonLabel(
  scope: LivetvSearchScope,
  context: LivetvSearchContext | null | undefined,
): string {
  if (scope === "all") return "All channels";
  const label = searchContextLabel(context);
  return label ? `In ${label}` : "In this category";
}

// ── Category-change clearing ────────────────────────────────────

/**
 * An applied (or drafted) search: its query, its scope, and the
 * category it was scoped to (null for scope "all", which has no
 * category). This is the shape W2 holds for the browser's
 * active search and the overlay holds for its draft.
 */
export interface LivetvSearchState {
  query: string;
  scope: LivetvSearchScope;
  /** Category id the search was scoped to (category scope only). */
  categoryId: string | null;
}

/** Empty search state: no query, default scope for the context. */
export function emptySearchState(
  context: LivetvSearchContext | null | undefined,
): LivetvSearchState {
  return {
    query: "",
    scope: defaultSearchScope(context),
    categoryId: searchContextCategoryId(context),
  };
}

/**
 * Category-change rule, pure: given the previous search state
 * and the category the browser just moved to, return the search
 * state that must now apply.
 *
 *   - Scope "all" (explicitly selected global search): kept
 *     verbatim — the category is irrelevant to it.
 *   - Scope "category" and the category is UNCHANGED: kept.
 *   - Scope "category" and the category CHANGED: cleared —
 *     query "", scope reset to the new context's default.
 *     Sports → Movies never silently intersects.
 *   - No previous search: empty state for the new context.
 *
 * W2 calls this whenever the browser's category changes (drawer
 * selection, LB/RB, collection card). The overlay calls the
 * draft variant below when it reopens under a new context.
 */
export function applyCategoryChangeToSearch(
  previous: LivetvSearchState | null | undefined,
  nextContext: LivetvSearchContext | null | undefined,
): LivetvSearchState {
  const nextCategoryId = searchContextCategoryId(nextContext);
  if (!previous || previous.query.trim() === "") {
    return emptySearchState(nextContext);
  }
  if (previous.scope === "all") {
    return { ...previous, categoryId: null };
  }
  if (previous.categoryId === nextCategoryId) {
    return { ...previous };
  }
  return emptySearchState(nextContext);
}

/**
 * Draft variant for the Search overlay reopening under a new
 * context: same rule as applyCategoryChangeToSearch, but the
 * "previous" draft carries the context it was drafted under
 * instead of a stored category id. A category-scoped draft is
 * dropped when the context category changed; a global draft
 * survives with its query intact.
 */
export function nextSearchDraftOnContextChange(
  previousDraft: {
    query: string;
    scope: LivetvSearchScope;
    context: LivetvSearchContext | null | undefined;
  } | null | undefined,
  nextContext: LivetvSearchContext | null | undefined,
): LivetvSearchState {
  if (!previousDraft) return emptySearchState(nextContext);
  return applyCategoryChangeToSearch(
    {
      query: previousDraft.query,
      scope: previousDraft.scope,
      categoryId: searchContextCategoryId(previousDraft.context),
    },
    nextContext,
  );
}

// ── Sort persistence ────────────────────────────────────────────

/** sessionStorage key for the selected browser sort order. */
export const LIVETV_SORT_STORAGE_KEY = "redsilk:livetv:sort";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Read the persisted sort, or the default when absent / garbage. Never throws. */
export function readPersistedLivetvSort(
  storage: StorageLike | null = sessionStore(),
): LivetvSortValue {
  try {
    return parseLivetvSort(storage?.getItem(LIVETV_SORT_STORAGE_KEY) ?? null);
  } catch {
    return LIVETV_DEFAULT_SORT;
  }
}

/** Persist the selected sort. Storage errors are swallowed (nicety, never fatal). */
export function writePersistedLivetvSort(
  sort: LivetvSortValue,
  storage: StorageLike | null = sessionStore(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LIVETV_SORT_STORAGE_KEY, sort);
  } catch {
    // Storage full / unavailable: persistence is a nicety, never fatal.
  }
}

// ── Event contract ──────────────────────────────────────────────

/** W2 dispatches; the Search overlay listens. */
export const LIVETV_OPEN_SEARCH_EVENT = "livetv:open-search";
/** The Search overlay dispatches on submit. */
export const LIVETV_SEARCH_SUBMIT_EVENT = "livetv:search-submit";
/** W2 dispatches; the Sort overlay listens. */
export const LIVETV_OPEN_SORT_EVENT = "livetv:open-sort";
/** The Sort overlay dispatches on selection. */
export const LIVETV_SORT_SUBMIT_EVENT = "livetv:sort-submit";
/** Either overlay dispatches on close WITHOUT a submit (B / Cancel). */
export const LIVETV_CLOSE_OVERLAY_EVENT = "livetv:close-overlay";

/** Detail of `livetv:open-search`. Context spellings: see parseLivetvSearchContext. */
export interface LivetvOpenSearchDetail extends LivetvSearchContext {
  /** Flat aliases, accepted by the parser. */
  categoryId?: string | null;
  categoryLabel?: string | null;
  /** Nested context object, accepted by the parser. */
  context?: LivetvSearchContext | null;
  /** Current query to prefill, when the browser holds one. */
  query?: string | null;
  /** Current scope, when the browser holds one. */
  scope?: LivetvSearchScope | null;
}

/** Detail of `livetv:search-submit`. */
export interface LivetvSearchSubmitDetail {
  /** Trimmed query; "" means "clear the search". */
  query: string;
  scope: LivetvSearchScope;
  /** Category the search was scoped to (category scope only). */
  categoryId: string | null;
}

/** Detail of `livetv:open-sort`. */
export interface LivetvOpenSortDetail {
  /** Current sort, when the browser knows it. */
  sort?: LivetvSortValue | null;
  /** Alias some callers use. */
  currentSort?: LivetvSortValue | null;
}

/** Detail of `livetv:sort-submit`. */
export interface LivetvSortSubmitDetail {
  sort: LivetvSortValue;
}

/** Detail of `livetv:close-overlay`. */
export interface LivetvCloseOverlayDetail {
  overlay: "search" | "sort";
  /** Why the overlay closed: B/Escape ("back") or an explicit Cancel. */
  reason: "back" | "cancel";
}

/** Parsed `livetv:open-search` detail: normalised context + prefill. */
export function parseOpenSearchDetail(detail: unknown): {
  context: LivetvSearchContext;
  query: string;
  scope: LivetvSearchScope | null;
} {
  const context = parseLivetvSearchContext(detail);
  const record =
    typeof detail === "object" && detail !== null
      ? (detail as Record<string, unknown>)
      : {};
  const query = asNonEmptyString(record["query"]) ?? "";
  const scope = isLivetvSearchScope(record["scope"])
    ? (record["scope"] as LivetvSearchScope)
    : null;
  return { context, query, scope };
}

/** Parse a `livetv:search-submit` detail; null when the shape is unusable. */
export function parseSearchSubmitDetail(
  detail: unknown,
): LivetvSearchSubmitDetail | null {
  if (typeof detail !== "object" || detail === null) return null;
  const record = detail as Record<string, unknown>;
  if (typeof record["query"] !== "string") return null;
  if (!isLivetvSearchScope(record["scope"])) return null;
  const categoryId = asNonEmptyString(record["categoryId"]);
  return {
    query: (record["query"] as string).trim(),
    scope: record["scope"] as LivetvSearchScope,
    categoryId: record["scope"] === "category" ? categoryId : null,
  };
}

/** Parse a `livetv:open-sort` detail: current sort or the default. */
export function parseOpenSortDetail(detail: unknown): {
  sort: LivetvSortValue;
} {
  if (typeof detail !== "object" || detail === null) {
    return { sort: LIVETV_DEFAULT_SORT };
  }
  const record = detail as Record<string, unknown>;
  return {
    sort: parseLivetvSort(record["sort"] ?? record["currentSort"]),
  };
}

/** Parse a `livetv:sort-submit` detail; null when the shape is unusable. */
export function parseSortSubmitDetail(
  detail: unknown,
): LivetvSortSubmitDetail | null {
  if (typeof detail !== "object" || detail === null) return null;
  const record = detail as Record<string, unknown>;
  if (!isLivetvSortValue(record["sort"])) return null;
  return { sort: record["sort"] as LivetvSortValue };
}

/** Dispatch `livetv:open-search` (W2's entry point; also used by tests/harness). */
export function dispatchLivetvOpenSearch(
  target: EventTarget,
  detail: LivetvOpenSearchDetail = {},
): void {
  target.dispatchEvent(
    new CustomEvent(LIVETV_OPEN_SEARCH_EVENT, { detail }),
  );
}

/** Dispatch `livetv:search-submit` (the Search overlay, on submit). */
export function dispatchLivetvSearchSubmit(
  target: EventTarget,
  detail: LivetvSearchSubmitDetail,
): void {
  target.dispatchEvent(
    new CustomEvent(LIVETV_SEARCH_SUBMIT_EVENT, {
      detail: { ...detail, query: detail.query.trim() },
    }),
  );
}

/** Dispatch `livetv:open-sort` (W2's entry point; also used by tests/harness). */
export function dispatchLivetvOpenSort(
  target: EventTarget,
  detail: LivetvOpenSortDetail = {},
): void {
  target.dispatchEvent(new CustomEvent(LIVETV_OPEN_SORT_EVENT, { detail }));
}

/** Dispatch `livetv:sort-submit` (the Sort overlay, on selection). Persists the sort. */
export function dispatchLivetvSortSubmit(
  target: EventTarget,
  detail: LivetvSortSubmitDetail,
  storage: StorageLike | null = sessionStore(),
): void {
  writePersistedLivetvSort(detail.sort, storage);
  target.dispatchEvent(
    new CustomEvent(LIVETV_SORT_SUBMIT_EVENT, { detail: { ...detail } }),
  );
}

/** Dispatch `livetv:close-overlay` (either overlay, on close without submit). */
export function dispatchLivetvCloseOverlay(
  target: EventTarget,
  detail: LivetvCloseOverlayDetail,
): void {
  target.dispatchEvent(
    new CustomEvent(LIVETV_CLOSE_OVERLAY_EVENT, { detail: { ...detail } }),
  );
}
