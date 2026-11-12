// 0.11.8 SHIM — W2 contract, deleted at integration.
//
// TEMPORARY implementations of the W2 home–browse mode contract and
// Browse Everything mount, so Movies Home builds, runs and verifies
// while W2 builds the real engine in parallel. Integration deletes
// this file and rewires the imports in couch-index.ts (router) and
// movies-home.ts (buildModeUrl only) to:
//
//   parseModeFromUrl / setModeInUrl / HomeBrowseMode
//     -> src/scripts/lib/home-browse-modes.ts (W2)
//   mountBrowseEverything
//     -> src/scripts/movies/couch-browse.ts (W2's Browse Everything
//        engine mount — the real mount renders W2's virtualised
//        browser into the container and honours the mode natively)
//
// The URL contract below IS the contract Movies Home depends on:
//   /movies                    -> Home (default; `view` absent)
//   /movies?view=home          -> Home (explicit)
//   /movies?view=browse        -> Browse Everything
//   ?genre=<canonical genre>   -> genre applied in Browse
//   ?sort=added|rating|...     -> sort applied in Browse
//   ?page=<n>                 -> page (W2 honours; shim preserves)
//   ?q=<query>                -> search text applied in Browse
//   ?list=continue|recent|... -> list tab applied in Browse
//   ?focus=search             -> focus the Browse search input
// A return from a detail page (history.back) restores the exact URL,
// hence the exact mode, category, page and — via couch-focus memory —
// the selected poster.
//
// SHIM LIMITS (honest, temporary): the shim mount reuses the legacy
// browse controller (mountCouchBrowse + moviesAdapter) inside the
// scaffold markup in src/pages/movies/index.astro, because W2's
// engine does not exist on this branch. URL state is applied by
// seeding the controller's persisted filter state and (for the list
// tab / search text) by driving the rendered controls after mount —
// polling, guarded, best-effort. The `page` param is preserved in
// the URL but the legacy controller has no pagination; W2 honours
// it. Do NOT extend this file.

import { mountCouchBrowse } from "@/scripts/movies/couch-browse.ts";
import { moviesAdapter } from "@/scripts/movies/couch-movies-adapter.ts";
import {
  saveBrowseFilterState,
  type BrowseSortId,
} from "@/scripts/lib/browse-filters.ts";

const KNOWN_SORTS: ReadonlySet<string> = new Set([
  "default",
  "added",
  "rating",
  "year-desc",
  "year-asc",
  "az",
  "runtime-asc",
  "runtime-desc",
]);

export interface HomeBrowseMode {
  view: "home" | "browse";
  /** Canonical genre id applied in Browse. "" / absent = any. */
  genre?: string;
  /** Browse sort id (MOVIE_SORT_MODES values). */
  sort?: string;
  /** Browse page (1-based). Preserved; honoured by W2. */
  page?: number;
  /** Search text applied in Browse. */
  query?: string;
  /** List tab: all | continue | recent | favorites | watchlater. */
  list?: string;
  /** Focus target on mount ("search" focuses the Browse search input). */
  focus?: string;
}

const MOVIES_PATH = "/movies";

/**
 * Parse the home–browse mode from a query string, a path+query, or
 * a full URL. Defaults to Home for a missing, empty or unknown
 * `view` — an unknown mode must never strand the viewer on a blank
 * browser. Pure; pass `window.location.search` explicitly from the
 * router, or a literal in tests.
 */
export function parseModeFromUrl(search?: string): HomeBrowseMode {
  const raw =
    typeof search === "string"
      ? search
      : typeof window !== "undefined"
        ? window.location.search
        : "";
  // Accept "?view=…", "view=…", "/movies?view=…" and full URLs: the
  // mode lives after the first "?" (buildModeUrl always encodes any
  // "?" inside values, so the first one is the separator).
  const queryIndex = raw.indexOf("?");
  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1) : raw;
  const params = new URLSearchParams(query);
  const viewRaw = (params.get("view") || "").trim().toLowerCase();
  const mode: HomeBrowseMode = { view: viewRaw === "browse" ? "browse" : "home" };
  const genre = (params.get("genre") || "").trim();
  if (genre) mode.genre = genre;
  const sort = (params.get("sort") || "").trim();
  if (sort) mode.sort = sort;
  const pageRaw = params.get("page");
  if (pageRaw != null) {
    const page = Math.floor(Number(pageRaw));
    if (Number.isFinite(page) && page >= 1) mode.page = page;
  }
  const q = (params.get("q") || "").trim();
  if (q) mode.query = q;
  const list = (params.get("list") || "").trim().toLowerCase();
  if (list) mode.list = list;
  const focus = (params.get("focus") || "").trim().toLowerCase();
  if (focus) mode.focus = focus;
  return mode;
}

/**
 * Build the Movies URL for a mode. Home omits `view` (clean
 * canonical URL); Browse always carries `view=browse`. Pure.
 */
export function buildModeUrl(mode: HomeBrowseMode, base: string = MOVIES_PATH): string {
  const params = new URLSearchParams();
  if (mode.view === "browse") params.set("view", "browse");
  if (mode.genre) params.set("genre", mode.genre);
  if (mode.sort) params.set("sort", mode.sort);
  if (mode.page != null && mode.page >= 1) params.set("page", String(Math.floor(mode.page)));
  if (mode.query) params.set("q", mode.query);
  if (mode.list) params.set("list", mode.list);
  if (mode.focus) params.set("focus", mode.focus);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Navigate to a mode (full page load — the router mounts exactly one
 * mode per load, so Home can never mount the Browse grid and Browse
 * state never leaks into Home). Falls back to history.pushState when
 * navigation is unavailable (test runtimes). Callers treat this as
 * terminal: code after it may not run.
 */
export function setModeInUrl(mode: HomeBrowseMode, opts: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const url = buildModeUrl(mode);
  try {
    if (opts.replace) window.location.replace(url);
    else window.location.assign(url);
  } catch {
    try {
      if (opts.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    } catch {
      // No navigation surface at all (non-DOM runtime): no-op.
    }
  }
}

/** True when the mode mounts Browse Everything (else Movies Home). */
export function shouldMountBrowse(mode: HomeBrowseMode): boolean {
  return mode.view === "browse";
}

// ---------------------------------------------------------------------------
// Browse Everything mount (SHIM — legacy controller bridge)
// ---------------------------------------------------------------------------

let browseMounted = false;

/**
 * Mount Browse Everything into `container` for `mode`. SHIM: unhides
 * the legacy scaffold, seeds the controller's persisted filter state
 * from the mode, and mounts the existing browse controller once, on
 * its own unchanged DOM contract (bare `couch-browse-*` ids — this
 * page hosts exactly one controller, so no prefix is needed).
 * The real W2 mount replaces this whole function. Guarded against
 * double-mount (mode changes are full navigations, so this fires at
 * most once per load).
 */
export function mountBrowseEverything(
  container: HTMLElement,
  mode: HomeBrowseMode,
): void {
  if (browseMounted) return;
  browseMounted = true;
  container.hidden = false;

  // Seed the persisted filter state BEFORE the controller reads it
  // at mount: genre + sort survive as the controller's own restored
  // state. Values the controller does not know fall back to defaults
  // inside its own validation.
  try {
    saveBrowseFilterState("movies", {
      genre: mode.genre || "",
      contentType: "",
      year: "",
      minRating: 0,
      maxRuntime: 0,
      sort: (KNOWN_SORTS.has(mode.sort || "")
        ? mode.sort
        : "default") as BrowseSortId,
    });
  } catch {
    // Persistence unavailable: the browser still mounts unfiltered.
  }

  mountCouchBrowse(moviesAdapter);

  // List tab + search text + search focus are not part of the
  // persisted state, so drive the rendered controls once the
  // controller's async boot has painted them. Best-effort polling,
  // bounded, no-ops when the controls never appear.
  if (mode.list || mode.query || mode.focus === "search") {
    applyBrowseModeControls(mode, container, 0);
  }
}

function applyBrowseModeControls(
  mode: HomeBrowseMode,
  container: HTMLElement,
  attempt: number,
): void {
  if (attempt > 20) return;
  const tabsEl = container.querySelector(`#couch-browse-tabs`);
  const searchEl = container.querySelector(
    `#couch-browse-search`,
  ) as HTMLInputElement | null;
  const ready = (mode.list ? tabsEl && tabsEl.childElementCount > 0 : true) && (mode.query || mode.focus === "search" ? !!searchEl : true);
  if (!ready) {
    window.setTimeout(() => applyBrowseModeControls(mode, container, attempt + 1), 100);
    return;
  }
  if (mode.list && tabsEl) {
    const wanted = mode.list.toLowerCase();
    const buttons = Array.from(tabsEl.querySelectorAll("button"));
    // Tab order matches the adapter lists: all, continue, recent,
    // favorites, watchlater. Match by pressed state target via the
    // label text — the controller sets no value attribute.
    const labels: Record<string, string> = {
      all: "All Movies",
      continue: "Continue Watching",
      recent: "Recently Added",
      favorites: "Favourites",
      watchlater: "Watch Later",
    };
    const label = labels[wanted];
    const target = label ? buttons.find((btn) => btn.textContent?.trim() === label) : undefined;
    target?.click();
  }
  if (mode.query && searchEl) {
    searchEl.value = mode.query;
    searchEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (mode.focus === "search") {
    searchEl?.focus({ preventScroll: true });
  }
}

/** Test-only reset for the double-mount guard. */
export function __resetBrowseMountForTests(): void {
  browseMounted = false;
}
