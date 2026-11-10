// RedSilk Couch — destination table + nav helpers (W1 shared system).
//
// The Couch UI lives at the PRIMARY routes. The legacy upstream /tv/*
// routes are out of scope and are intentionally absent here.

export interface CouchNavItem {
  /** Stable id, also used as CouchLayout's `activeNav` value. */
  id: string;
  label: string;
  href: string;
}

/** Primary top-nav destinations, in display order. */
export const COUCH_NAV_PRIMARY: readonly CouchNavItem[] = [
  { id: "home", label: "Home", href: "/" },
  { id: "livetv", label: "Live TV", href: "/livetv" },
  { id: "movies", label: "Movies", href: "/movies" },
  { id: "series", label: "Series", href: "/series" },
  { id: "discover", label: "Discover", href: "/discover" },
  { id: "followed", label: "Followed", href: "/followed" },
  { id: "search", label: "Search", href: "/search" },
];

/**
 * Library: a compact grouped entry in the top nav holding the two
 * personal lists. Deliberately NOT a submenu — a submenu would need a
 * hover/click affordance with no controller path and would hide one of
 * the two destinations behind an extra press. Both links sit in the
 * nav rail side by side under a small "Library" label, so D-pad left /
 * right reaches either in one move.
 */
export const COUCH_NAV_LIBRARY: readonly CouchNavItem[] = [
  { id: "favorites", label: "Favourites", href: "/favorites" },
  { id: "watchlist", label: "Watch Later", href: "/watchlist" },
];

/** Settings: present at the far end of the nav, not dominant. */
export const COUCH_NAV_SETTINGS: CouchNavItem = {
  id: "settings",
  label: "Settings",
  href: "/settings",
};

/** Every Couch destination id -> href (primary + library + settings). */
export const COUCH_DESTINATIONS: Readonly<Record<string, string>> =
  Object.fromEntries(
    [...COUCH_NAV_PRIMARY, ...COUCH_NAV_LIBRARY, COUCH_NAV_SETTINGS].map(
      (item) => [item.id, item.href],
    ),
  );

/** Collapse trailing slashes; "" becomes "/". Pure. */
export function normalizeCouchPath(pathname: string): string {
  const collapsed = pathname.replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

/**
 * Active nav id for a pathname. Detail / sub-routes resolve to their
 * parent section (e.g. /movies/detail -> "movies", /epg -> "livetv").
 * Returns null for paths outside the Couch UI.
 */
export function couchNavIdFor(pathname: string): string | null {
  const path = normalizeCouchPath(pathname);
  if (path === "/") return "home";
  if (path === "/livetv" || path === "/epg") return "livetv";
  if (path === "/movies" || path.startsWith("/movies/")) return "movies";
  if (path === "/series" || path.startsWith("/series/")) return "series";
  if (path === "/discover") return "discover";
  if (path === "/followed") return "followed";
  if (path === "/search") return "search";
  if (path === "/favorites") return "favorites";
  if (path === "/watchlist") return "watchlist";
  if (path === "/settings" || path.startsWith("/settings/")) return "settings";
  return null;
}

/** True when the pathname belongs to the Couch UI (primary routes). */
export function isCouchRoute(pathname: string): boolean {
  return couchNavIdFor(pathname) !== null;
}

/** Navigate to a Couch destination; no-op when already there. */
export function goCouch(href: string): void {
  if (typeof window === "undefined") return;
  const current = normalizeCouchPath(window.location.pathname);
  if (current === normalizeCouchPath(href)) return;
  window.location.assign(href);
}
