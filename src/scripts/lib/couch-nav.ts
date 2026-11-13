// RedSilk Couch — destination table + nav helpers (W1 shared system).
//
// The Couch UI lives at the PRIMARY routes. The legacy upstream /tv/*
// routes are out of scope and are intentionally absent here.

import {
  BACK_PRIORITY,
  registerBackLayer,
} from "@/scripts/lib/back-handler.ts";

export interface CouchNavItem {
  /** Stable id, also used as CouchLayout's `activeNav` value. */
  id: string;
  label: string;
  href: string;
}

/** Primary top-nav destinations, in display order.
 * 0.10.0 reverses the 0.8.0 Browse consolidation (user's explicit
 * call): Movies, Series and Discover are distinct destinations again.
 * NO Browse entry. Search stays one tap away at the top of each
 * catalogue page (in-page search + /search), as now. */
export const COUCH_NAV_PRIMARY: readonly CouchNavItem[] = [
  { id: "home", label: "Home", href: "/" },
  { id: "movies", label: "Movies", href: "/movies" },
  { id: "series", label: "Series", href: "/series" },
  { id: "discover", label: "Discover", href: "/discover" },
  { id: "livetv", label: "Live TV", href: "/livetv" },
  { id: "followed", label: "Followed", href: "/followed" },
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
 * /browse is a thin redirect (to /movies, /series or /discover) and
 * never renders, so it resolves to "discover", its default target.
 * /search has no top-nav entry of its own; it keeps the legacy
 * "browse" id so isCouchRoute stays true and no nav item highlights.
 * Returns null for paths outside the Couch UI.
 */
export function couchNavIdFor(pathname: string): string | null {
  const path = normalizeCouchPath(pathname);
  if (path === "/") return "home";
  if (path === "/livetv" || path === "/epg") return "livetv";
  if (path === "/browse") return "discover";
  if (path === "/movies" || path.startsWith("/movies/")) return "movies";
  if (path === "/series" || path.startsWith("/series/")) return "series";
  if (path === "/discover") return "discover";
  if (path === "/search") return "browse";
  if (path === "/followed" || path.startsWith("/followed/")) return "followed";
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

// ── Top-nav Exit button: two-press safety (§5) ──────────────────────
//
// A arms, A again confirms while armed, B while armed cancels the
// armed state without leaving or exiting, and the arm lapses after
// `armMs` — a stray press can never quit. The B-cancel runs through
// the Back coordinator as a PAGE_STATE layer, so a modal or drawer
// above the nav still owns B first (higher priorities win) and the
// disarm consumes exactly one Back press. The layer is inert while
// disarmed. Mounted once per button (dataset guard); returns an
// unmount function (mainly for tests).

const EXIT_ARMED_LABEL = "Exit?";
const EXIT_IDLE_LABEL = "⏻ Exit";
const EXIT_BUSY_LABEL = "Exiting…";

export function mountCouchExitButton(
  btn: HTMLButtonElement | null,
  requestExit: () => Promise<unknown> | void,
  armMs = 4000,
): () => void {
  if (!btn) return () => {};
  if (btn.dataset.exitMounted) return () => {};
  btn.dataset.exitMounted = "1";

  let armed = false;
  let armTimer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    if (armTimer !== null) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    btn.classList.remove("is-armed");
    btn.textContent = EXIT_IDLE_LABEL;
  };

  const unregisterBackLayer = registerBackLayer({
    id: "couch-exit-armed",
    priority: BACK_PRIORITY.PAGE_STATE,
    isActive: () => armed,
    handle: () => {
      disarm();
      return true;
    },
  });

  const onClick = (): void => {
    if (btn.hasAttribute("disabled")) return;
    if (!armed) {
      armed = true;
      btn.classList.add("is-armed");
      btn.textContent = EXIT_ARMED_LABEL;
      if (armTimer !== null) clearTimeout(armTimer);
      armTimer = setTimeout(disarm, armMs);
      return;
    }
    if (armTimer !== null) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    armed = false;
    btn.classList.remove("is-armed");
    btn.setAttribute("disabled", "");
    btn.textContent = EXIT_BUSY_LABEL;
    // Synchronous request, like the pre-0.11.10 inline handler: the
    // exit is asked for in the click itself, not deferred a tick.
    // Only the re-enable waits on the promise.
    let result: Promise<unknown> | void;
    try {
      result = requestExit();
    } catch {
      result = undefined;
    }
    Promise.resolve(result)
      .catch(() => {
        // Exit failed: the button still re-enables below.
      })
      .finally(() => {
        // Web preview: quit is a no-op, re-enable the button.
        btn.removeAttribute("disabled");
        btn.textContent = EXIT_IDLE_LABEL;
      });
  };

  btn.addEventListener("click", onClick);

  return () => {
    btn.removeEventListener("click", onClick);
    unregisterBackLayer();
    if (armTimer !== null) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    delete btn.dataset.exitMounted;
  };
}
