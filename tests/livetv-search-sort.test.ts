/**
 * Live TV 2.0 search + sort contract tests (0.11.7, W4): search
 * scoping (subcategory by default, obvious All), the
 * category-change clearing rule (Sports → Movies never
 * intersects; an explicit global search survives), sort
 * selection persistence, and the overlay event contract
 * (open/submit/close shapes and parsers).
 */
import { describe, it, expect } from "vitest";
import {
  LIVETV_CLOSE_OVERLAY_EVENT,
  LIVETV_DEFAULT_SORT,
  LIVETV_OPEN_SEARCH_EVENT,
  LIVETV_OPEN_SORT_EVENT,
  LIVETV_SEARCH_SUBMIT_EVENT,
  LIVETV_SORT_OPTIONS,
  LIVETV_SORT_STORAGE_KEY,
  LIVETV_SORT_SUBMIT_EVENT,
  applyCategoryChangeToSearch,
  defaultSearchScope,
  dispatchLivetvCloseOverlay,
  dispatchLivetvOpenSearch,
  dispatchLivetvOpenSort,
  dispatchLivetvSearchSubmit,
  dispatchLivetvSortSubmit,
  emptySearchState,
  isLivetvSortValue,
  livetvSortLabel,
  nextSearchDraftOnContextChange,
  parseLivetvSearchContext,
  parseOpenSearchDetail,
  parseOpenSortDetail,
  parseSearchSubmitDetail,
  parseSortSubmitDetail,
  readPersistedLivetvSort,
  searchContextCategoryId,
  searchContextLabel,
  searchScopeButtonLabel,
  writePersistedLivetvSort,
  type LivetvSearchContext,
  type LivetvSearchState,
} from "@/scripts/lib/livetv-search-sort";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
    _map: map,
  };
}

describe("search context parsing", () => {
  it("normalises group + subcategory spellings", () => {
    expect(
      parseLivetvSearchContext({
        groupId: "sports",
        groupLabel: "Sports",
        subcategoryId: "football",
        subcategoryLabel: "Football",
      }),
    ).toEqual({
      groupId: "sports",
      groupLabel: "Sports",
      subcategoryId: "football",
      subcategoryLabel: "Football",
    });
  });

  it("accepts the flat categoryId / categoryLabel spelling", () => {
    expect(parseLivetvSearchContext({ categoryId: "sports", categoryLabel: "Sports" })).toEqual({
      groupId: "sports",
      groupLabel: "Sports",
      subcategoryId: null,
      subcategoryLabel: null,
    });
  });

  it("accepts a nested context object", () => {
    expect(
      parseLivetvSearchContext({ context: { groupId: "movies", subcategoryId: "comedy" } }),
    ).toEqual({
      groupId: "movies",
      groupLabel: null,
      subcategoryId: "comedy",
      subcategoryLabel: null,
    });
  });

  it("tolerates garbage: empty strings, wrong types, null", () => {
    expect(parseLivetvSearchContext(null)).toEqual({});
    expect(parseLivetvSearchContext("sports")).toEqual({});
    expect(parseLivetvSearchContext({ groupId: "  ", subcategoryId: 42 })).toEqual({
      groupId: null,
      groupLabel: null,
      subcategoryId: null,
      subcategoryLabel: null,
    });
  });

  it("subcategory wins over group for id and label", () => {
    const context: LivetvSearchContext = {
      groupId: "sports",
      groupLabel: "Sports",
      subcategoryId: "football",
      subcategoryLabel: "Football",
    };
    expect(searchContextCategoryId(context)).toBe("football");
    expect(searchContextLabel(context)).toBe("Football");
    expect(searchContextCategoryId({ groupId: "sports" })).toBe("sports");
    expect(searchContextCategoryId(null)).toBeNull();
    expect(searchContextLabel(null)).toBeNull();
  });
});

describe("default search scope", () => {
  it("searches the subcategory by default", () => {
    expect(defaultSearchScope({ groupId: "sports", subcategoryId: "football" })).toBe("category");
    expect(defaultSearchScope({ groupId: "sports" })).toBe("category");
  });

  it("searches favourites / recents by default (a specific category)", () => {
    expect(defaultSearchScope({ groupId: "favourites" })).toBe("category");
    expect(defaultSearchScope({ groupId: "recents" })).toBe("category");
  });

  it("searches all when the context is All or absent", () => {
    expect(defaultSearchScope({ groupId: "all" })).toBe("all");
    expect(defaultSearchScope({})).toBe("all");
    expect(defaultSearchScope(null)).toBe("all");
  });

  it("labels the scope buttons with the real category name", () => {
    const context = { groupId: "sports", groupLabel: "Sports", subcategoryId: "football", subcategoryLabel: "Football" };
    expect(searchScopeButtonLabel("category", context)).toBe("In Football");
    expect(searchScopeButtonLabel("all", context)).toBe("All channels");
    expect(searchScopeButtonLabel("category", null)).toBe("In this category");
  });
});

describe("category-change clearing (no silent intersections)", () => {
  const sports: LivetvSearchState = { query: "arsenal", scope: "category", categoryId: "sports" };

  it("Sports → Movies clears a category-scoped search", () => {
    const next = applyCategoryChangeToSearch(sports, { groupId: "movies" });
    expect(next).toEqual({ query: "", scope: "category", categoryId: "movies" });
  });

  it("Sports → Sports keeps a category-scoped search", () => {
    const next = applyCategoryChangeToSearch(sports, { groupId: "sports" });
    expect(next).toEqual(sports);
  });

  it("an explicitly global search survives a category change", () => {
    const global: LivetvSearchState = { query: "arsenal", scope: "all", categoryId: null };
    expect(applyCategoryChangeToSearch(global, { groupId: "movies" })).toEqual(global);
    expect(applyCategoryChangeToSearch(global, { groupId: "sports" })).toEqual(global);
  });

  it("a subcategory change inside the same group clears the search", () => {
    const football: LivetvSearchState = { query: "arsenal", scope: "category", categoryId: "football" };
    const next = applyCategoryChangeToSearch(football, { groupId: "sports", subcategoryId: "rugby" });
    expect(next.query).toBe("");
    expect(next.categoryId).toBe("rugby");
  });

  it("no previous search yields an empty state for the new context", () => {
    expect(applyCategoryChangeToSearch(null, { groupId: "movies" })).toEqual({
      query: "",
      scope: "category",
      categoryId: "movies",
    });
    expect(applyCategoryChangeToSearch(undefined, null)).toEqual(emptySearchState(null));
  });

  it("an empty query never carries a stale scope forward", () => {
    const blank: LivetvSearchState = { query: "   ", scope: "category", categoryId: "sports" };
    expect(applyCategoryChangeToSearch(blank, { groupId: "sports" }).query).toBe("");
  });

  it("the overlay draft follows the same rule on reopen", () => {
    const draft = { query: "arsenal", scope: "category" as const, context: { groupId: "sports" } };
    expect(nextSearchDraftOnContextChange(draft, { groupId: "movies" }).query).toBe("");
    expect(nextSearchDraftOnContextChange(draft, { groupId: "sports" }).query).toBe("arsenal");
    const globalDraft = { query: "arsenal", scope: "all" as const, context: { groupId: "sports" } };
    expect(nextSearchDraftOnContextChange(globalDraft, { groupId: "movies" }).query).toBe("arsenal");
    expect(nextSearchDraftOnContextChange(null, { groupId: "movies" }).query).toBe("");
  });
});

describe("sort options and parsing", () => {
  it("offers exactly the four orders, in overlay order", () => {
    expect(LIVETV_SORT_OPTIONS.map((option) => option.value)).toEqual([
      "source",
      "az",
      "za",
      "category",
    ]);
    expect(LIVETV_SORT_OPTIONS.map((option) => option.label)).toEqual([
      "Provider order",
      "A–Z",
      "Z–A",
      "Category order",
    ]);
  });

  it("defaults to provider order", () => {
    expect(LIVETV_DEFAULT_SORT).toBe("source");
    expect(isLivetvSortValue("source")).toBe(true);
    expect(isLivetvSortValue("number")).toBe(false);
    expect(isLivetvSortValue("cataz")).toBe(false);
    expect(livetvSortLabel("az")).toBe("A–Z");
    expect(livetvSortLabel("bogus")).toBe("Provider order");
  });
});

describe("sort selection persistence", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    expect(readPersistedLivetvSort(storage)).toBe("source");
    writePersistedLivetvSort("za", storage);
    expect(readPersistedLivetvSort(storage)).toBe("za");
    expect(storage._map.get(LIVETV_SORT_STORAGE_KEY)).toBe("za");
    writePersistedLivetvSort("category", storage);
    expect(readPersistedLivetvSort(storage)).toBe("category");
  });

  it("falls back to the default on garbage or missing storage", () => {
    expect(readPersistedLivetvSort(memoryStorage({ [LIVETV_SORT_STORAGE_KEY]: "bogus" }))).toBe("source");
    expect(readPersistedLivetvSort(null)).toBe("source");
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
    };
    expect(readPersistedLivetvSort(throwing)).toBe("source");
    expect(() => writePersistedLivetvSort("az", throwing)).not.toThrow();
  });

  it("dispatching a sort submit persists the selection", () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    dispatchLivetvSortSubmit(target, { sort: "az" }, storage);
    expect(readPersistedLivetvSort(storage)).toBe("az");
  });
});

describe("overlay event contract", () => {
  it("open-search carries a parseable context + prefill", () => {
    const target = new EventTarget();
    let seen: unknown;
    target.addEventListener(LIVETV_OPEN_SEARCH_EVENT, (event) => {
      seen = (event as CustomEvent).detail;
    });
    dispatchLivetvOpenSearch(target, {
      groupId: "sports",
      subcategoryId: "football",
      query: "arsenal",
      scope: "category",
    });
    const parsed = parseOpenSearchDetail(seen);
    expect(parsed.context).toEqual({
      groupId: "sports",
      groupLabel: null,
      subcategoryId: "football",
      subcategoryLabel: null,
    });
    expect(parsed.query).toBe("arsenal");
    expect(parsed.scope).toBe("category");
    expect(parseOpenSearchDetail(null)).toEqual({ context: {}, query: "", scope: null });
  });

  it("search-submit dispatches {query, scope, categoryId} and parses back", () => {
    const target = new EventTarget();
    let seen: unknown;
    target.addEventListener(LIVETV_SEARCH_SUBMIT_EVENT, (event) => {
      seen = (event as CustomEvent).detail;
    });
    dispatchLivetvSearchSubmit(target, { query: "  arsenal ", scope: "category", categoryId: "football" });
    expect(parseSearchSubmitDetail(seen)).toEqual({ query: "arsenal", scope: "category", categoryId: "football" });
    dispatchLivetvSearchSubmit(target, { query: "news", scope: "all", categoryId: "sports" });
    expect(parseSearchSubmitDetail(seen)).toEqual({ query: "news", scope: "all", categoryId: null });
  });

  it("search-submit parsing rejects malformed details", () => {
    expect(parseSearchSubmitDetail(null)).toBeNull();
    expect(parseSearchSubmitDetail({ query: 42, scope: "all" })).toBeNull();
    expect(parseSearchSubmitDetail({ query: "x", scope: "global" })).toBeNull();
    expect(parseSearchSubmitDetail({ query: "x" })).toBeNull();
  });

  it("an empty search-submit query means clear (still a valid submit)", () => {
    expect(parseSearchSubmitDetail({ query: "   ", scope: "all", categoryId: null })).toEqual({
      query: "",
      scope: "all",
      categoryId: null,
    });
  });

  it("open-sort / sort-submit carry and parse the sort value", () => {
    const target = new EventTarget();
    let openSeen: unknown;
    let submitSeen: unknown;
    target.addEventListener(LIVETV_OPEN_SORT_EVENT, (event) => {
      openSeen = (event as CustomEvent).detail;
    });
    target.addEventListener(LIVETV_SORT_SUBMIT_EVENT, (event) => {
      submitSeen = (event as CustomEvent).detail;
    });
    dispatchLivetvOpenSort(target, { sort: "za" });
    expect(parseOpenSortDetail(openSeen)).toEqual({ sort: "za" });
    dispatchLivetvOpenSort(target, { currentSort: "az" });
    expect(parseOpenSortDetail(openSeen)).toEqual({ sort: "az" });
    expect(parseOpenSortDetail(null)).toEqual({ sort: "source" });
    expect(parseOpenSortDetail({ sort: "bogus" })).toEqual({ sort: "source" });
    dispatchLivetvSortSubmit(target, { sort: "category" }, memoryStorage());
    expect(parseSortSubmitDetail(submitSeen)).toEqual({ sort: "category" });
    expect(parseSortSubmitDetail({ sort: "bogus" })).toBeNull();
    expect(parseSortSubmitDetail(null)).toBeNull();
  });

  it("close-overlay names the overlay and the reason", () => {
    const target = new EventTarget();
    let seen: unknown;
    target.addEventListener(LIVETV_CLOSE_OVERLAY_EVENT, (event) => {
      seen = (event as CustomEvent).detail;
    });
    dispatchLivetvCloseOverlay(target, { overlay: "search", reason: "back" });
    expect(seen).toEqual({ overlay: "search", reason: "back" });
    dispatchLivetvCloseOverlay(target, { overlay: "sort", reason: "cancel" });
    expect(seen).toEqual({ overlay: "sort", reason: "cancel" });
  });
});
