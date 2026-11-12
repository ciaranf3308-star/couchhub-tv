// Couch browse controller (W4) — shared by the Movies and Series
// Couch index pages.
//
// 0.11.8 (W2): the NEW Browse Everything framework lives in
// src/scripts/lib/browse-everything.ts (mountBrowseEverything,
// re-exported at the bottom of this file for adapter migration).
// This legacy controller (mountCouchBrowse + CouchBrowseAdapter)
// is PRESERVED unchanged until W3/W4 replace the /movies and
// /series pages: the adapters import CouchBrowseAdapter from
// here, and deleting the controller before the pages land would
// break the build. Integration removes mountCouchBrowse once no
// page mounts it. New browse work goes to browse-everything.ts,
// never here.
//
// The two pages share one DOM contract (see the .astro templates) and
// one controller; each screen supplies a small kind adapter (row
// mapping, rails, card views, filtering). The controller owns:
//   - catalogue load state (loading skeleton -> rails + grid / empty /
//     error), via loadCouchCatalog,
//   - rails (Continue Watching, Recently Added, Recommended, Favourites,
//     Watch Later — only the non-empty ones render),
//   - list tabs (All / Continue / Recent / Favourites / Watch Later),
//     as one joined segmented control,
//   - the genre filter, as one labelled select in the filter row,
//     year + rating selects, sort select, search input +
//     on-screen keyboard dialog, and — when the catalogue carries
//     runtime metadata (C5 availability gate) — a runtime select,
//     as one labelled select in the same row,
//   - filter persistence (B09): genre / decade / rating / runtime /
//     sort survive a full reload via the shared C5 sessionStorage
//     API (loadBrowseFilterState / saveBrowseFilterState), so a
//     return from a detail page — or a fresh load — keeps the
//     viewer's filters. The list tab and search query are not
//     persisted (a reload starts on All with an empty search).
//   - Reset Filters (0.11.6, W4): ONE obvious action in the filter
//     row that clears genre, decade, rating, runtime, sort, the text
//     query and the list tab — and the persisted entry — in one
//     press. Genre selection REPLACES via selectGenreFilter (the one
//     funnel): the reported Comedy→Horror progressive sub-filter was
//     composition, not accumulation — a genre word left in the search
//     box matches the provider category (filterMovies/filterSeries
//     haystack) and intersected the new genre, and persisted filters
//     restored with no way to clear them all at once.
//   - Back rule (0.11.6, W4 — documented, no new handler): Back is
//     browser history. Detail pages history.back() into this grid,
//     and the persisted state + focus memory restore the exact
//     filtered view the viewer came from — Back never silently
//     un-filters or re-filters. Reset Filters is the explicit clear,
//     and it wipes the persisted entry too, so Back after a reset
//     cannot resurrect a cleared filter.
//   - the full catalogue grid, windowed with computeVisibleWindow +
//     gridColumnsForWidth so a 10,000-title catalogue never builds
//     10,000 card nodes. The focused card is pinned into the window
//     so windowing never steals focus.
//
// DOM contract (ids the .astro templates provide, optionally prefixed
// with `opts.idPrefix` — the /browse page hosts two controllers at
// once, one per kind, so its ids carry a "browse-movies-" /
// "browse-series-" prefix; the standalone /movies and /series pages
// use the bare ids):
//   couch-browse-status, couch-browse-hero-count, couch-browse-tabs,
//   couch-browse-genres, couch-browse-runtime, couch-browse-year,
//   couch-browse-rating, couch-browse-sort, couch-browse-search,
//   couch-browse-reset, couch-search-open, couch-browse-rails,
//   couch-browse-grid, couch-browse-skeleton, couch-browse-empty,
//   couch-browse-error.

import { computeVisibleWindow, gridColumnsForWidth } from "@/scripts/lib/couch-grid.ts";
import { restoreCouchFocus } from "@/scripts/lib/couch-focus.ts";
import {
  computeFilterAvailability,
  loadBrowseFilterState,
  saveBrowseFilterState,
  clearBrowseFilterState,
  selectGenreFilter,
  resetBrowseFilters,
  isDefaultBrowseFilterState,
  RUNTIME_OPTIONS,
  RUNTIME_OPTION_LABELS,
  type BrowseFilterEntry,
  type BrowseFilterState,
  type BrowseSortId,
} from "@/scripts/lib/browse-filters.ts";
import { buildCouchCard, type CouchCardView } from "@/scripts/movies/couch-cards.ts";
import { loadCouchCatalog, type CouchCatalogSpec } from "@/scripts/movies/couch-catalog.ts";
import { debounce } from "@/scripts/lib/debounce.ts";
import { initI18n } from "@/scripts/lib/i18n.js";
import { log } from "@/scripts/lib/log.js";
import type { GenreId } from "@/scripts/lib/genres.ts";

export type CouchBrowseList =
  | "all"
  | "continue"
  | "recent"
  | "favorites"
  | "watchlater";

export interface CouchBrowseFilter {
  query: string;
  genre: GenreId | "";
  year: string;
  minRating: number;
  /** Maximum runtime in minutes (0 = any length). B09. */
  maxRuntime: number;
  sort: string;
  list: CouchBrowseList;
}

export interface CouchRail<T> {
  id: string;
  title: string;
  rows: T[];
}

export interface CouchBrowseAdapter<T> {
  /** "vod" | "series" — cache kind + log tag. */
  kind: "vod" | "series";
  spec: CouchCatalogSpec<T>;
  /** Tabs shown for this kind (series adds nothing; kept for symmetry). */
  lists: Array<{ value: CouchBrowseList; label: string }>;
  /** Rails above the grid, in order. Only non-empty rails render. */
  rails: (rows: T[], playlistId: string) => CouchRail<T>[];
  /** Genres present in this catalogue (shown as one Genre select). */
  genres: (rows: T[]) => Array<{ id: GenreId; label: string; count: number }>;
  /** Apply the current filter (query/genre/year/rating/list). */
  applyFilter: (rows: T[], filter: CouchBrowseFilter, playlistId: string) => T[];
  /** Display sort for the grid (receives the whole filter — the "recent"
   *  list sorts newest-first regardless of the sort select). */
  applySort: (rows: T[], filter: CouchBrowseFilter) => T[];
  /** Card view for one row. */
  cardView: (row: T, playlistId: string) => CouchCardView;
  /** Stable key for one row (matches cardView's itemKey). */
  rowKey: (row: T) => string;
  /** Optional per-card enrichment after the element is built (e.g.
   *  resolving a series' season count into its meta line). */
  decorateCard?: (card: HTMLElement, row: T, playlistId: string) => void;
  /** Detail route for one row. */
  detailHref: (row: T) => string;
  /** Human count label for the hero, e.g. "1,240 movies". */
  countLabel: (count: number) => string;
  emptyTitle: string;
  emptyMessage: string;
}

const RAIL_LIMIT = 12;
const MIN_CARD_WIDTH = 200;
const GRID_GAP = 20;
const ROW_HEIGHT_FALLBACK = 430;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export interface CouchBrowseMountOptions {
  /**
   * Prefix prepended to every DOM id in the contract above. "" keeps
   * the standalone /movies and /series pages on their bare ids.
   * /browse mounts one controller per kind with "browse-movies-" /
   * "browse-series-" so the two sections never share an id.
   */
  idPrefix?: string;
}

export function mountCouchBrowse<T>(
  adapter: CouchBrowseAdapter<T>,
  opts: CouchBrowseMountOptions = {},
): void {
  const prefix = opts.idPrefix ?? "";
  const statusEl = $(`${prefix}couch-browse-status`);
  const heroCountEl = $(`${prefix}couch-browse-hero-count`);
  const tabsEl = $(`${prefix}couch-browse-tabs`);
  const genresEl = $(`${prefix}couch-browse-genres`);
  const runtimeEl = $(`${prefix}couch-browse-runtime`);
  const yearEl = $(`${prefix}couch-browse-year`) as HTMLSelectElement | null;
  const ratingEl = $(`${prefix}couch-browse-rating`) as HTMLSelectElement | null;
  const sortEl = $(`${prefix}couch-browse-sort`) as HTMLSelectElement | null;
  const searchEl = $(`${prefix}couch-browse-search`) as HTMLInputElement | null;
  const resetEl = $(`${prefix}couch-browse-reset`);
  const railsEl = $(`${prefix}couch-browse-rails`);
  const gridEl = $(`${prefix}couch-browse-grid`);
  const skeletonEl = $(`${prefix}couch-browse-skeleton`);
  const emptyEl = $(`${prefix}couch-browse-empty`);
  const errorEl = $(`${prefix}couch-browse-error`);

  let all: T[] = [];
  let filtered: T[] = [];
  let playlistId = "";
  let playlistTitle = "";
  let loaded = false;
  let rowHeight = ROW_HEIGHT_FALLBACK;
  let columns = 6;
  let renderRaf = 0;

  // B09 — restore the shared filter state saved in sessionStorage
  // (genre / decade / rating / runtime / sort), so a full reload or
  // a return from a detail page keeps the viewer's filters. Values
  // are already validated by parseBrowseFilterState (unknown values
  // fall back to defaults); the genre is re-validated against this
  // catalogue in renderGenres, and the sort against the page's own
  // sort options when the static selects are synced below.
  const filterScope = adapter.kind === "vod" ? "movies" : "series";
  const restoredFilters = loadBrowseFilterState(filterScope);

  const filter: CouchBrowseFilter = {
    query: "",
    genre: (restoredFilters?.genre || "") as GenreId | "",
    year: restoredFilters?.year || "",
    minRating: restoredFilters?.minRating || 0,
    maxRuntime: restoredFilters?.maxRuntime || 0,
    sort: restoredFilters?.sort || "default",
    list: "all",
  };

  // The controller's filter as a shared BrowseFilterState: the query
  // and list tab are view-local (never persisted), contentType is
  // always "" here (each page is one kind). Used by the genre funnel
  // and the Reset state check; the persistence save below keeps its
  // literal object shape (pinned by tests/browse-010-runtime-filter).
  const toBrowseFilterState = (f: CouchBrowseFilter): BrowseFilterState => ({
    genre: f.genre,
    contentType: "",
    year: f.year,
    minRating: f.minRating,
    maxRuntime: f.maxRuntime,
    sort: f.sort as BrowseSortId,
  });

  // Sync the static selects with any restored state (the genre
  // select is built by renderGenres, which reads filter.genre
  // itself; the runtime select is built by renderRuntime).
  if (yearEl) yearEl.value = filter.year;
  if (ratingEl) ratingEl.value = String(filter.minRating);
  if (sortEl) {
    const sortKnown = [...sortEl.options].some((o) => o.value === filter.sort);
    if (sortKnown) sortEl.value = filter.sort;
    else filter.sort = "default";
  }

  const setVisible = (el: HTMLElement | null, visible: boolean) => {
    if (el) el.hidden = !visible;
  };

  const makeCard = (row: T): HTMLElement => {
    const view = adapter.cardView(row, playlistId);
    const card = buildCouchCard({ ...view, href: adapter.detailHref(row) }, false);
    adapter.decorateCard?.(card, row, playlistId);
    return card;
  };

  // --- Rails -------------------------------------------------------------
  // (W8 pillfest cleanup: the list tabs are ONE joined segmented
  // control and the genre filter is ONE labelled <select> in the
  // filter row — no more per-genre pill buttons. Same options, same
  // behaviour; presentation only.)
  const renderRails = () => {
    if (!railsEl) return;
    railsEl.replaceChildren();
    if (!loaded || filter.query || filter.genre || filter.year || filter.minRating > 0 || filter.maxRuntime > 0 || filter.list !== "all") {
      return;
    }
    for (const rail of adapter.rails(all, playlistId)) {
      const rows = rail.rows.slice(0, RAIL_LIMIT);
      if (!rows.length) continue;
      const section = document.createElement("section");
      section.className = "rs-rail";
      section.setAttribute("data-nylah-rail", rail.id);
      section.setAttribute("aria-label", rail.title);
      const head = document.createElement("div");
      head.className = "rs-rail__head";
      const h2 = document.createElement("h2");
      h2.className = "rs-section-title";
      h2.textContent = rail.title;
      head.appendChild(h2);
      section.appendChild(head);
      const rowEl = document.createElement("div");
      rowEl.className = "rs-rail__row";
      for (const row of rows) {
        rowEl.appendChild(makeCard(row));
      }
      section.appendChild(rowEl);
      railsEl.appendChild(section);
    }
    try {
      (window as any).SpatialNavigation?.makeFocusable?.();
    } catch {}
  };

  // --- Virtualised grid --------------------------------------------------
  const measureRowHeight = () => {
    if (!gridEl) return;
    const card = gridEl.querySelector(".rs-card") as HTMLElement | null;
    if (card) {
      const h = card.getBoundingClientRect().height + GRID_GAP;
      if (h > 100 && h < 1200) rowHeight = h;
    }
  };

  const renderGridWindow = () => {
    if (!gridEl) return;
    const total = filtered.length;
    if (total === 0) {
      gridEl.replaceChildren();
      return;
    }
    const gridTop = gridEl.getBoundingClientRect().top + window.scrollY;
    const scrollTop = Math.max(0, window.scrollY - gridTop + 80);
    const viewportHeight = window.innerHeight + 400;
    columns = Math.max(
      1,
      gridColumnsForWidth(gridEl.clientWidth || window.innerWidth, MIN_CARD_WIDTH, GRID_GAP),
    );
    let win = computeVisibleWindow({
      total,
      columns,
      rowHeight,
      scrollTop,
      viewportHeight,
    });
    // Pin the focused card into the window so windowing never removes
    // the node that holds focus.
    const active = document.activeElement as HTMLElement | null;
    const focusedKey = active?.closest?.("[data-couch-key]")?.getAttribute("data-couch-key");
    if (focusedKey) {
      const idx = filtered.findIndex((row) => adapter.rowKey(row) === focusedKey);
      if (idx >= 0 && (idx < win.startIndex || idx >= win.endIndex)) {
        const row = Math.floor(idx / columns);
        const startRow = Math.max(0, row - 1);
        const endRow = Math.min(Math.ceil(total / columns) - 1, row + 2);
        win = {
          startIndex: startRow * columns,
          endIndex: Math.min(total, (endRow + 1) * columns),
          startRow,
          endRow,
          topSpacer: startRow * rowHeight,
          bottomSpacer: (Math.ceil(total / columns) - 1 - endRow) * rowHeight,
          totalRows: Math.ceil(total / columns),
        };
      }
    }
    const frag = document.createDocumentFragment();
    if (win.topSpacer > 0) {
      const top = document.createElement("div");
      top.setAttribute("aria-hidden", "true");
      top.style.height = `${win.topSpacer}px`;
      top.style.gridColumn = "1 / -1";
      frag.appendChild(top);
    }
    for (let i = win.startIndex; i < win.endIndex; i++) {
      frag.appendChild(makeCard(filtered[i]));
    }
    if (win.bottomSpacer > 0) {
      const bottom = document.createElement("div");
      bottom.setAttribute("aria-hidden", "true");
      bottom.style.height = `${win.bottomSpacer}px`;
      bottom.style.gridColumn = "1 / -1";
      frag.appendChild(bottom);
    }
    const hadFocus = gridEl.contains(document.activeElement);
    gridEl.replaceChildren(frag);
    gridEl.style.setProperty("--rs-grid-cols", String(columns));
    measureRowHeight();
    try {
      (window as any).SpatialNavigation?.makeFocusable?.();
    } catch {}
    if (hadFocus) {
      restoreCouchFocus();
    }
  };

  const scheduleGridRender = () => {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(() => {
      renderRaf = 0;
      renderGridWindow();
    });
  };

  // --- Filter bar ----------------------------------------------------------
  // List tabs: ONE joined segmented control (same buttons, same
  // aria-pressed behaviour, same click handling — the segments just
  // share one border instead of floating as separate pills).
  const renderTabs = () => {
    if (!tabsEl) return;
    tabsEl.replaceChildren();
    for (const list of adapter.lists) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "rs-hero__action rs-hero__action--secondary rs-browse-segment";
      btn.textContent = list.label;
      btn.setAttribute("aria-pressed", filter.list === list.value ? "true" : "false");
      btn.addEventListener("click", () => {
        filter.list = list.value;
        renderTabs();
        applyFilterAndRender();
      });
      tabsEl.appendChild(btn);
    }
  };

  // Genre filter: ONE labelled <select> in the filter row (next to
  // Sort / Decade / Rating) instead of one pill button per genre.
  // Same options (All genres + every catalogue genre with its count),
  // same behaviour (picking one filters the grid; re-picking All
  // clears it). The select is built once and its options refreshed
  // in place so focus is never stolen by a re-render.
  const renderGenres = () => {
    if (!genresEl) return;
    const genres = adapter.genres(all);
    let select = genresEl.querySelector("select") as HTMLSelectElement | null;
    if (!select) {
      genresEl.replaceChildren();
      const label = document.createElement("label");
      label.className = "rs-browse-label";
      label.htmlFor = `${prefix}couch-browse-genre`;
      label.textContent = "Genre";
      const built = document.createElement("select");
      built.id = `${prefix}couch-browse-genre`;
      built.setAttribute("aria-label", "Filter by genre");
      built.addEventListener("change", () => {
        // 0.11.6 (W4): genre selection REPLACES — selectGenreFilter
        // is the one funnel, so the previous genre can never survive
        // alongside the new one (the reported Comedy AND Horror).
        // The <select> clears via its "All genres" option (""); the
        // same-genre toggle-off in the funnel is for chip/button UIs.
        const next = selectGenreFilter(toBrowseFilterState(filter), built.value || null);
        filter.genre = (next.genre || "") as GenreId | "";
        applyFilterAndRender();
      });
      genresEl.append(label, built);
      select = built;
    }
    // A stored genre with no titles in this catalogue resets to All
    // rather than silently filtering everything out.
    if (filter.genre && !genres.some((g) => g.id === filter.genre)) {
      filter.genre = "";
    }
    select.replaceChildren();
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All genres";
    select.appendChild(allOpt);
    for (const genre of genres) {
      const opt = document.createElement("option");
      opt.value = genre.id;
      opt.textContent = `${genre.label} (${genre.count})`;
      select.appendChild(opt);
    }
    select.value = filter.genre;
  };

  // Runtime filter (B09): ONE labelled <select> in the filter row,
  // built by the controller like the genre select — and ONLY when
  // the catalogue actually carries runtime metadata (C5 availability
  // rule: computeFilterAvailability). Movie rows carry a provider
  // duration; series rows carry none, so the control simply never
  // appears on /series. A stored runtime limit with no metadata
  // behind it resets to Any rather than filtering everything out.
  const renderRuntime = () => {
    if (!runtimeEl) return;
    if (!computeFilterAvailability(all as BrowseFilterEntry[]).runtime) {
      runtimeEl.replaceChildren();
      if (filter.maxRuntime) filter.maxRuntime = 0;
      return;
    }
    let select = runtimeEl.querySelector("select") as HTMLSelectElement | null;
    if (!select) {
      runtimeEl.replaceChildren();
      const label = document.createElement("label");
      label.className = "rs-browse-label";
      label.htmlFor = `${prefix}couch-browse-runtime-select`;
      label.textContent = "Length";
      const built = document.createElement("select");
      built.id = `${prefix}couch-browse-runtime-select`;
      built.setAttribute("aria-label", "Filter by maximum length");
      built.addEventListener("change", () => {
        filter.maxRuntime = Number(built.value) || 0;
        applyFilterAndRender();
      });
      runtimeEl.append(label, built);
      select = built;
    }
    select.replaceChildren();
    for (const max of RUNTIME_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = String(max);
      opt.textContent = RUNTIME_OPTION_LABELS[max] ?? `Under ${max} minutes`;
      select.appendChild(opt);
    }
    select.value = String(filter.maxRuntime);
  };

  // Reset Filters (0.11.6, W4): ONE obvious action that clears
  // everything — genre, decade, rating, runtime, sort, the text
  // query and the list tab — plus the persisted entry, so a later
  // return trip cannot resurrect a cleared filter. The button is
  // built once (like the genre/runtime selects) and lives last in
  // the filter row, after the Length select, in normal DOM order so
  // controller focus reaches it after the selects and before the
  // list tabs. It is disabled while the view is already unfiltered,
  // so its state always says whether anything is active; whenever
  // a filter IS active it is enabled and controller-reachable with
  // the standard focus ring. No filter pills: one button, one press.
  let resetButton: HTMLButtonElement | null = null;
  const syncResetState = () => {
    if (!resetButton) return;
    const active =
      !isDefaultBrowseFilterState(toBrowseFilterState(filter)) ||
      filter.query.trim() !== "" ||
      filter.list !== "all";
    resetButton.disabled = !active;
  };
  const resetFilters = () => {
    const defaults = resetBrowseFilters();
    filter.genre = "";
    filter.year = defaults.year;
    filter.minRating = defaults.minRating;
    filter.maxRuntime = defaults.maxRuntime;
    filter.sort = defaults.sort;
    filter.query = "";
    filter.list = "all";
    if (searchEl) searchEl.value = "";
    if (yearEl) yearEl.value = filter.year;
    if (ratingEl) ratingEl.value = String(filter.minRating);
    if (sortEl) sortEl.value = filter.sort;
    // Clear the persisted entry outright; the funnel below re-saves
    // the defaults, so either way a later load/return lands clean.
    clearBrowseFilterState(filterScope);
    renderTabs();
    renderGenres();
    renderRuntime();
    applyFilterAndRender();
    // The button just disabled itself under focus; land focus on the
    // Genre select — the head of the filter row — so controller
    // users are never stranded on a disabled control.
    genresEl?.querySelector("select")?.focus();
  };
  const renderReset = () => {
    if (!resetEl) return;
    if (!resetButton) {
      resetEl.replaceChildren();
      const built = document.createElement("button");
      built.type = "button";
      built.id = `${prefix}couch-browse-reset-button`;
      built.className = "rs-hero__action rs-hero__action--secondary";
      built.textContent = "Reset filters";
      built.setAttribute("aria-label", "Reset all filters");
      built.addEventListener("click", () => {
        resetFilters();
      });
      resetEl.appendChild(built);
      resetButton = built;
    }
    syncResetState();
  };

  const applyFilterAndRender = () => {
    const base = adapter.applyFilter(all, filter, playlistId);
    filtered = adapter.applySort(base, filter);
    // B09 — persist the filter state for the next load / return
    // trip (sessionStorage, per scope). One call, one funnel: every
    // filter change runs through here.
    saveBrowseFilterState(filterScope, {
      genre: filter.genre,
      contentType: "",
      year: filter.year,
      minRating: filter.minRating,
      maxRuntime: filter.maxRuntime,
      sort: filter.sort as BrowseSortId,
    });
    syncResetState();
    if (heroCountEl) heroCountEl.textContent = adapter.countLabel(filtered.length);
    if (statusEl) {
      statusEl.textContent =
        filtered.length === 0
          ? "Nothing matches these filters."
          : `${filtered.length.toLocaleString()} of ${all.length.toLocaleString()} titles`;
    }
    setVisible(emptyEl, filtered.length === 0 && loaded);
    setVisible(gridEl, filtered.length > 0);
    renderRails();
    if (gridEl) gridEl.scrollTop = 0;
    window.scrollTo({ top: 0 });
    renderGridWindow();
  };

  const debouncedSearch = debounce(() => {
    filter.query = searchEl?.value || "";
    applyFilterAndRender();
  }, 160);

  searchEl?.addEventListener("input", debouncedSearch);
  yearEl?.addEventListener("change", () => {
    filter.year = yearEl.value;
    applyFilterAndRender();
  });
  ratingEl?.addEventListener("change", () => {
    filter.minRating = Number(ratingEl.value) || 0;
    applyFilterAndRender();
  });
  sortEl?.addEventListener("change", () => {
    filter.sort = sortEl.value;
    applyFilterAndRender();
  });
  window.addEventListener("scroll", scheduleGridRender, { passive: true });
  window.addEventListener("resize", scheduleGridRender);
  window.addEventListener("couch-keyboard:input", (ev) => {
    const value = (ev as CustomEvent).detail?.value ?? "";
    if (searchEl) searchEl.value = value;
    filter.query = value;
    applyFilterAndRender();
  });

  // --- Load ---------------------------------------------------------------
  const showError = (message: string) => {
    setVisible(skeletonEl, false);
    setVisible(emptyEl, false);
    setVisible(gridEl, false);
    if (errorEl) {
      errorEl.hidden = false;
      const msg = errorEl.querySelector("[data-role='error-message']");
      if (msg) msg.textContent = message;
    }
    if (statusEl) statusEl.textContent = message;
  };

  const boot = async () => {
    await initI18n().catch(() => {});
    renderTabs();
    setVisible(skeletonEl, true);
    setVisible(emptyEl, false);
    setVisible(errorEl, false);
    if (statusEl) statusEl.textContent = "Loading…";
    let result;
    try {
      result = await loadCouchCatalog(adapter.spec);
    } catch (err) {
      log.error(`[xt:couch-${adapter.kind}] browse boot failed:`, err);
      showError("Could not load the catalogue. Check the provider connection in Settings.");
      return;
    }
    if (!result) {
      loaded = true;
      setVisible(skeletonEl, false);
      setVisible(emptyEl, true);
      if (statusEl) statusEl.textContent = "No playlist selected.";
      if (emptyEl) {
        const title = emptyEl.querySelector(
          "[data-role='empty-title'], .rs-empty__title",
        );
        if (title) title.textContent = "No playlist yet";
        const msg = emptyEl.querySelector(
          "[data-role='empty-message'], .rs-empty__message",
        );
        if (msg) msg.textContent = "Add a playlist in Settings to browse your library.";
      }
      return;
    }
    if (result.loadError) {
      showError(
        `Could not reach ${result.playlistTitle || "the provider"}. Showing nothing rather than stale data — retry from Settings.`,
      );
      return;
    }
    all = result.rows;
    playlistId = result.playlistId;
    playlistTitle = result.playlistTitle;
    loaded = true;
    setVisible(skeletonEl, false);
    setVisible(errorEl, false);
    if (all.length === 0) {
      setVisible(emptyEl, true);
      if (emptyEl) {
        const title = emptyEl.querySelector(
          "[data-role='empty-title'], .rs-empty__title",
        );
        if (title) title.textContent = adapter.emptyTitle;
        const msg = emptyEl.querySelector(
          "[data-role='empty-message'], .rs-empty__message",
        );
        if (msg) msg.textContent = adapter.emptyMessage;
      }
      if (statusEl) statusEl.textContent = "This library is empty.";
      if (heroCountEl) heroCountEl.textContent = adapter.countLabel(0);
      return;
    }
    renderGenres();
    renderRuntime();
    renderReset();
    applyFilterAndRender();
    // Focus memory: after the first paint, restore where the viewer was.
    restoreCouchFocus();
  };

  document.addEventListener("xt:active-changed", () => {
    loaded = false;
    all = [];
    filtered = [];
    playlistId = "";
    void boot();
  });

  void boot();
}

// ── 0.11.8 W2 — Browse Everything re-exports ────────────────────
// The canonical implementation is src/scripts/lib/browse-everything.ts.
// Re-exported here so the kind adapters and page entries can
// migrate off mountCouchBrowse one import at a time.
export {
  mountBrowseEverything,
  deriveBrowseGroups,
  type BrowseController,
  type BrowseDataSource,
  type BrowseLoadResult,
  type BrowseWatchSets,
  type MountBrowseEverythingOptions,
} from "@/scripts/lib/browse-everything.ts";
export {
  createBrowseState,
  selectCategory,
  applyFilters,
  resetAllFilters,
  activeFilterSummary,
  setPage,
  setSearch,
  setSort,
  type BrowseState,
  type BrowseFilters,
  type BrowseKind,
  type BrowseCategorySelection,
  type BrowseSortId,
} from "@/scripts/lib/browse-state.ts";
export {
  parseModeFromUrl,
  setModeInUrl,
  type HomeBrowseMode,
} from "@/scripts/lib/home-browse-modes.ts";
