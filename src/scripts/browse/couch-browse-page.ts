// Browse page controller — /browse is the ONE Browse destination
// (Browse consolidation, W1 landing + Movies/Series filters).
//
//   /browse               -> Discover landing (type=all, the default)
//   /browse?type=movies   -> movies catalogue view
//   /browse?type=series   -> series catalogue view
//
// The URL query is the source of truth for the type filter: it is
// deep-linkable, and returning from a detail screen (history back)
// lands on the same /browse?type=… URL. A type change is a full
// navigation (location.assign), so exactly one catalogue controller
// is ever mounted and the page remounts cleanly — the standalone
// /movies and /series pages keep working unchanged alongside.
//
// What mounts where:
//   - type=all: nothing here — the Discover landing is DiscoverView
//     (client:visible, same component + engines as /discover; its
//     feedback behaviour, rails, mood search and keyboard are
//     untouched). No catalogue controller starts, so Discover's
//     keyboard/filters can never fight the catalogue ones.
//   - type=movies / series: the shared browse controller
//     (couch-browse.ts) with the movies/series kind adapter and an id
//     prefix ("browse-movies-" / "browse-series-"), so the two
//     sections on this page never share a DOM id. Rails, genre chips,
//     year/rating/sort, search + on-screen keyboard, the windowed grid
//     and the detail flow are the adapters' own — no data fetching is
//     duplicated here.
//
// Focus: the type chips live in a data-nylah-rail ("browse-type") so
// D-pad nav + focus memory cover them. Focus restoration after a
// detail return is the shared couch-focus layer: it records by route
// pathname ("/browse") + rail id + stable data-couch-key, and the
// catalogue rails/cards on this page carry the same rail ids
// ("movies-continue", …) and keys ("vod-…", "series-…") as the
// standalone pages, so a card focused on /browse?type=movies is
// restored when the viewer comes back from /movies/detail.
//
// Search entry: the top bar carries a clearly-marked placeholder slot
// (#browse-search-slot) — W2 builds the search button and the
// integration wires it in. This controller does not build a search
// button of its own.

import { mountCouchBrowse } from "@/scripts/movies/couch-browse.ts";
import { moviesAdapter } from "@/scripts/movies/couch-movies-adapter.ts";
import { seriesAdapter } from "@/scripts/series/couch-series-adapter.ts";

export type BrowseType = "all" | "movies" | "series";

export const BROWSE_TYPES: readonly BrowseType[] = ["all", "movies", "series"];

/** DOM id prefix for a kind's catalogue section on this page. */
export const BROWSE_ID_PREFIX: Record<Exclude<BrowseType, "all">, string> = {
  movies: "browse-movies-",
  series: "browse-series-",
};

const SECTION_IDS: Record<BrowseType, string> = {
  all: "browse-discover",
  movies: "browse-movies",
  series: "browse-series",
};

/** Normalise one raw type value; anything unknown reads as "all". Pure. */
export function asBrowseType(value: string | null | undefined): BrowseType {
  const v = (value ?? "").trim().toLowerCase();
  return v === "movies" || v === "series" ? v : "all";
}

/** Read the type filter from a query string ("?type=movies", "" …). Pure. */
export function parseBrowseType(search: string): BrowseType {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return "all";
  }
  return asBrowseType(params.get("type"));
}

/** Canonical URL for a type; "all" is the bare /browse. Pure. */
export function browseTypeHref(type: BrowseType): string {
  return type === "all" ? "/browse" : `/browse?type=${type}`;
}

/** The kind adapter a type mounts: movies load the VOD catalogue,
    series load the series catalogue — a Movies view can never show a
    series row, and vice versa. Pure. */
export function browseKindAdapter(type: Exclude<BrowseType, "all">) {
  return type === "movies" ? moviesAdapter : seriesAdapter;
}

export interface BrowsePageDeps {
  /** Defaults to the live document. Tests pass a jsdom document. */
  doc?: Document;
  /** Defaults to window.location.search. */
  search?: string;
  /** Defaults to window.location.assign. Tests pass a recorder. */
  navigate?: (href: string) => void;
  /**
   * Mounts a kind's catalogue controller. Defaults to the real
   * mountCouchBrowse with the kind adapter + id prefix. Tests pass a
   * stub so no provider/catalogue work runs.
   */
  mountKind?: (type: Exclude<BrowseType, "all">, idPrefix: string) => void;
}

/**
 * Show the section for the current ?type=, wire the type chips, and
 * mount the catalogue controller for movies/series. Returns the
 * resolved type. Idempotent per page load (call once).
 */
export function mountBrowsePage(deps: BrowsePageDeps = {}): BrowseType {
  const doc = deps.doc ?? document;
  const search =
    deps.search ?? (typeof window !== "undefined" ? window.location.search : "");
  const type = parseBrowseType(search);
  const navigate =
    deps.navigate ??
    ((href: string) => {
      window.location.assign(href);
    });
  const mountKind =
    deps.mountKind ??
    ((kind: Exclude<BrowseType, "all">, idPrefix: string) => {
      mountCouchBrowse(browseKindAdapter(kind), {
        idPrefix,
      });
    });

  for (const t of BROWSE_TYPES) {
    const section = doc.getElementById(SECTION_IDS[t]);
    if (section) section.hidden = t !== type;
  }

  doc.querySelectorAll<HTMLElement>("[data-browse-type]").forEach((chip) => {
    const chipType = asBrowseType(chip.getAttribute("data-browse-type"));
    chip.setAttribute("aria-pressed", chipType === type ? "true" : "false");
    chip.addEventListener("click", () => {
      if (chipType !== type) navigate(browseTypeHref(chipType));
    });
  });

  if (type === "movies" || type === "series") {
    mountKind(type, BROWSE_ID_PREFIX[type]);
  }
  return type;
}
