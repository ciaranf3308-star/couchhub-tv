// 0.11.8 SHIM — W1/W2 contract, deleted at integration.
//
// Browser-only half of the W1/W2 contract (network + DOM). Kept apart
// from series-home-shims.ts so the pure modules stay import-safe under
// node/vitest: the real catalogue/legacy-browse modules are loaded
// with dynamic import() inside the functions below, never statically.
//
// INTEGRATION: delete this file and rewire couch-series-home.ts to:
//
//   getCatalogIndex       -> W1 src/scripts/lib/catalog-index.ts
//   mountBrowseEverything -> W2 mount contract (couch-browse.ts /
//                            browse-state.ts — the real mountBrowseEverything)
//
// SHIM BEHAVIOUR (honest limits, all flagged in the W4 hand-back):
// - getCatalogIndex loads through the EXISTING loadCouchCatalog path
//   (same cache, same TTL, same mapping) and wraps the rows with a
//   byId index. It memoises one load per playlist and invalidates on
//   `xt:active-changed`. It does NOT build W1's full index (grouping,
//   language groups, rating evidence); the home shelves only need
//   rows + byId, and the selectors take rows directly.
// - mountBrowseEverything delegates to the LEGACY shared browse
//   controller (mountCouchBrowse + seriesAdapter) mounted once into
//   the page's browse root. The entire catalogue stays accessible;
//   the real W2 engine (paged + virtualised browser, category/filter
//   drawers) replaces this wholesale. Genre/sort params are applied
//   best-effort: before the first mount they are seeded into the
//   legacy controller's persisted filter state; afterwards they are
//   applied through the legacy selects. A genre family id maps to its
//   primary canonical genre for the legacy select; Reality (no
//   canonical id) maps to a category-text search. Paging is parsed
//   and preserved in the URL but the legacy windowed grid has no
//   pages — W2 owns paging.

import type { SeriesRow } from "@/scripts/series/couch-series.ts";
import type { BrowseModeParams } from "@/scripts/series/series-home-shims.ts";
import {
  CANONICAL_SERIES_GENRES,
  parseModeFromUrl,
} from "@/scripts/series/series-home-shims.ts";

// ---------------------------------------------------------------------------
// W1: getCatalogIndex — real module: src/scripts/lib/catalog-index.ts
// ---------------------------------------------------------------------------

export interface SeriesCatalogIndex {
  rows: SeriesRow[];
  playlistId: string;
  playlistTitle: string;
  /** True when the provider fetch failed (rows may be empty). */
  loadError: boolean;
  /** True when the rows came from the shared cache. */
  fromCache: boolean;
  byId: Map<number, SeriesRow>;
}

let catalogPromise: Promise<SeriesCatalogIndex | null> | null = null;

function invalidateCatalogIndex(): void {
  catalogPromise = null;
}

if (typeof document !== "undefined") {
  document.addEventListener("xt:active-changed", invalidateCatalogIndex);
}

/** null = no active playlist (the screen shows its setup state). */
export function getCatalogIndex(opts: { forceReload?: boolean } = {}): Promise<SeriesCatalogIndex | null> {
  if (opts.forceReload) catalogPromise = null;
  if (!catalogPromise) {
    catalogPromise = loadCatalogIndex().catch((err) => {
      catalogPromise = null;
      throw err;
    });
  }
  return catalogPromise;
}

async function loadCatalogIndex(): Promise<SeriesCatalogIndex | null> {
  const [{ loadCouchCatalog }, { mapSeriesRow }] = await Promise.all([
    import("@/scripts/movies/couch-catalog.ts"),
    import("@/scripts/series/couch-series.ts"),
  ]);
  const result = await loadCouchCatalog<SeriesRow>({
    kind: "series",
    listAction: "get_series",
    categoriesAction: "get_series_categories",
    ttlMs: 24 * 60 * 60 * 1000,
    mapRow: mapSeriesRow,
  });
  if (!result) return null;
  const byId = new Map<number, SeriesRow>();
  for (const row of result.rows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return {
    rows: result.rows,
    playlistId: result.playlistId,
    playlistTitle: result.playlistTitle,
    loadError: result.loadError,
    fromCache: result.fromCache,
    byId,
  };
}

// ---------------------------------------------------------------------------
// W2: mountBrowseEverything — real module: W2 mount contract
// ---------------------------------------------------------------------------

export interface MountBrowseEverythingOptions {
  /** Initial mode params from the URL. */
  initialParams?: BrowseModeParams;
}

export interface BrowseEverythingHandle {
  /** Apply new params (genre/sort/query) to the mounted browser. */
  setParams: (params: BrowseModeParams) => void;
  /** Focus the browser's search control. */
  focusSearch: () => void;
  /** True once the underlying controller has mounted. */
  readonly mounted: boolean;
}

let browseMounted = false;
let browseMountPromise: Promise<void> | null = null;
let pendingParams: BrowseModeParams | null = null;

/**
 * Map a genre family id to the legacy genre <select> value (a
 * canonical GenreId). Families spanning two ids use the first;
 * Reality has no canonical id and maps to null (handled as a
 * category-text search instead). Unknown ids pass through unchanged
 * — the legacy controller resets an unmatched genre to All rather
 * than filtering everything out.
 */
export function legacyGenreSelectValue(genreParam: string | undefined): string | null {
  if (!genreParam) return null;
  const family = CANONICAL_SERIES_GENRES.find((candidate) => candidate.id === genreParam);
  if (!family) return genreParam;
  if (family.id === "reality") return null;
  return family.genreIds[0] ?? null;
}

function seedLegacyFilterState(params: BrowseModeParams): void {
  // The legacy controller restores its persisted filter state at
  // boot; seeding it before the first mount is the only way to land
  // on a pre-filtered browse view. Fire-and-forget dynamic import:
  // a seeding failure must never block the mount.
  void import("@/scripts/lib/browse-filters.ts")
    .then(({ saveBrowseFilterState, loadBrowseFilterState }) => {
      const previous = loadBrowseFilterState("series");
      const genre = legacyGenreSelectValue(params.genre);
      saveBrowseFilterState("series", {
        genre: genre ?? previous?.genre ?? "",
        contentType: "",
        year: previous?.year ?? "",
        minRating: previous?.minRating ?? 0,
        maxRuntime: previous?.maxRuntime ?? 0,
        sort: (params.sort ?? previous?.sort ?? "default") as never,
      });
    })
    .catch(() => {});
}

function setSelectValue(select: HTMLSelectElement | null, value: string): boolean {
  if (!select) return false;
  const known = [...select.options].some((option) => option.value === value);
  if (!known) return false;
  if (select.value === value) return true;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function applyParamsToLegacyControls(params: BrowseModeParams): void {
  const genre = legacyGenreSelectValue(params.genre);
  if (genre != null) {
    setSelectValue(
      document.querySelector<HTMLSelectElement>("#couch-browse-genres select"),
      genre,
    );
  } else if (params.genre === "reality") {
    // Reality has no legacy genre option: the category text is part
    // of the search haystack, so a "reality" query approximates the
    // family. Best-effort shim behaviour; W2 handles families natively.
    const search = document.getElementById("couch-browse-search") as HTMLInputElement | null;
    if (search) {
      search.value = "reality";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  if (params.sort) {
    setSelectValue(document.getElementById("couch-browse-sort") as HTMLSelectElement | null, params.sort);
  }
  if (params.query != null) {
    const search = document.getElementById("couch-browse-search") as HTMLInputElement | null;
    if (search && search.value !== params.query) {
      search.value = params.query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

async function mountLegacyBrowse(): Promise<void> {
  const [{ mountCouchBrowse }, { seriesAdapter }] = await Promise.all([
    import("@/scripts/movies/couch-browse.ts"),
    import("@/scripts/series/couch-series-adapter.ts"),
  ]);
  mountCouchBrowse(seriesAdapter);
  browseMounted = true;
  // Params that arrived while the controller was booting apply once
  // its controls exist; the legacy selects render during boot, so a
  // short deferred pass catches them without polling the DOM.
  const pending = pendingParams;
  pendingParams = null;
  if (pending) {
    window.setTimeout(() => applyParamsToLegacyControls(pending), 0);
    window.setTimeout(() => applyParamsToLegacyControls(pending), 500);
  }
}

export function mountBrowseEverything(
  opts: MountBrowseEverythingOptions = {},
): BrowseEverythingHandle {
  const initial = opts.initialParams ?? parseModeFromUrl().params;
  if (!browseMounted && !browseMountPromise) {
    seedLegacyFilterState(initial);
    browseMountPromise = mountLegacyBrowse().catch(() => {
      browseMountPromise = null;
    });
  } else if (browseMounted) {
    applyParamsToLegacyControls(initial);
  } else {
    pendingParams = initial;
  }
  return {
    setParams(params: BrowseModeParams): void {
      if (browseMounted) applyParamsToLegacyControls(params);
      else pendingParams = params;
    },
    focusSearch(): void {
      const search = document.getElementById("couch-browse-search") as HTMLInputElement | null;
      search?.focus({ preventScroll: false });
    },
    get mounted(): boolean {
      return browseMounted;
    },
  };
}
