// RedSilk Couch — route provenance (Controller Experience 2.0, §4.2).
//
// Why this exists: full-page Astro navigations wipe module state, so a
// detail page cannot know where the user came from by asking the
// router — and `history.back()` is blind (a direct link, a reload, or
// a bookmark has no meaningful "back"). Callers record where they came
// FROM when navigating to a detail page or subview; Back then returns
// to the recorded origin instead of guessing.
//
//   Movies Browse -> Detail -> Back restores Browse state
//   Series Home -> Detail -> Back returns Home
//   Discover -> Detail -> Back returns Discover
//   Home -> Search -> Back returns Home
//   Settings -> Playlist Editor -> Back returns Settings/Playlists
//
// The origin is ONE-SHOT: reading it for a Back navigation consumes
// it, so a stale origin can never send a later, unrelated Back to the
// wrong page. Direct links with no known origin fall back to the
// caller-supplied parent destination (navigateBackWithOrigin's
// argument) — never to history.length heuristics.
//
// Storage: sessionStorage, key `nylah:route-origin` — it survives
// full-page navigations within the tab and dies with the tab, which
// is exactly the lifetime of "where did I come from". Only
// same-origin app paths (leading "/", never "//") are stored or
// navigated to; anything else is ignored, so a bad caller can never
// turn Back into an open redirect.

export interface RouteOrigin {
  /** App path the user came from, e.g. "/movies" (path + query ok). */
  route: string;
  /** Human label for the origin, e.g. "Movies". Display only. Optional. */
  label?: string;
}

const ROUTE_ORIGIN_KEY = "nylah:route-origin";
// Set by navigateBackWithOrigin before it navigates, consumed by the
// destination page's recordOriginFromReferrer() call: without it the
// destination would record the page we just came back FROM as its
// origin, and the next Back would ping-pong forward again.

const BACK_NAV_FLAG_KEY = "nylah:route-back-nav";

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Same-origin app path only: leading "/" and never protocol-relative. */
function isAppPath(route: string): boolean {
  return route.startsWith("/") && !route.startsWith("//");
}

/** Record where the user came from before navigating to a detail/subview. */
export function recordRouteOrigin(origin: RouteOrigin): void {
  if (!origin || typeof origin.route !== "string" || !isAppPath(origin.route)) {
    return;
  }
  try {
    storage()?.setItem(
      ROUTE_ORIGIN_KEY,
      JSON.stringify({
        route: origin.route,
        label: typeof origin.label === "string" ? origin.label : "",
      }),
    );
  } catch {
    // Storage unavailable: provenance is a nicety, never fatal.
  }
}

/** Read the recorded origin, or null when absent/malformed. Pure. */
export function readRouteOrigin(): RouteOrigin | null {
  let raw: string | null;
  try {
    raw = storage()?.getItem(ROUTE_ORIGIN_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RouteOrigin>;
    if (typeof parsed.route !== "string" || !isAppPath(parsed.route)) {
      return null;
    }
    return {
      route: parsed.route,
      label: typeof parsed.label === "string" ? parsed.label : "",
    };
  } catch {
    return null;
  }
}

/** Discard the recorded origin without navigating. */
export function clearRouteOrigin(): void {
  try {
    storage()?.removeItem(ROUTE_ORIGIN_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Record the navigation origin from document.referrer (full-page
 * navigation sets it): same-origin, different path only. Views call
 * this at mount so Back returns to the real launching screen
 * without every launcher needing to record the origin itself.
 * `currentPath` defaults to the current pathname. No-ops when the
 * referrer is external, empty, or the current page, and when this
 * load IS a Back navigation (the flag navigateBackWithOrigin set)
 * — otherwise Back would ping-pong between the two pages.
 * Relocated from the W3/W5 shims at 0.11.10 integration; the
 * single-origin store above is the record it writes.
 */
export function recordOriginFromReferrer(currentPath?: string): void {
  try {
    if (storage()?.getItem(BACK_NAV_FLAG_KEY) === "1") {
      storage()?.removeItem(BACK_NAV_FLAG_KEY);
      return;
    }
  } catch {
    // Fall through to the referrer check.
  }
  if (typeof document === "undefined" || typeof window === "undefined") return;
  let referrer: string;
  try {
    referrer = document.referrer || "";
  } catch {
    return;
  }
  if (!referrer) return;
  try {
    const url = new URL(referrer, window.location.href);
    if (url.origin !== window.location.origin) return;
    const current = currentPath || window.location.pathname;
    const path = url.pathname + url.search + url.hash;
    if (url.pathname === current || path === current) return;
    recordRouteOrigin({ route: url.pathname, label: "" });
  } catch {
    // No usable referrer — the fallback route still works.
  }
}

/** Exported for the §7.4 landing-B return (0.11.13): livetv-landing.ts
 *  marks the navigation as a Back navigation so the destination's
 *  recordOriginFromReferrer does not record /livetv as an origin
 *  and ping-pong. Export-only; the function itself is unchanged. */
export function markBackNavigation(): void {
  try {
    storage()?.setItem(BACK_NAV_FLAG_KEY, "1");
  } catch {
    // The destination may record a redundant origin; the
    // single-use origin store bounds the damage to one press.
  }
}

/**
 * Navigate back to the recorded origin, or to `fallbackRoute` when
 * there is none (direct link / reload / bookmark). The origin is
 * consumed either way. No-op when already on the destination, when
 * the destination is not an app path, or when there is no window.
 *
 * `opts.backLink`: when no origin is recorded, click the page's own
 * Back link instead of assigning the fallback — the link's existing
 * handler (history.back() from a grid, href otherwise) stays the
 * behaviour for detail pages. The Back-navigation flag is set in
 * both navigation paths so the destination does not re-record.
 */
export function navigateBackWithOrigin(
  fallbackRoute: string,
  opts: { backLink?: HTMLElement | null } = {},
): void {
  const origin = readRouteOrigin();
  clearRouteOrigin();
  if (!origin && opts.backLink) {
    markBackNavigation();
    opts.backLink.click();
    return;
  }
  const dest = origin?.route ?? fallbackRoute;
  if (typeof dest !== "string" || !isAppPath(dest)) return;
  if (typeof window === "undefined") return;
  try {
    const target = new URL(dest, window.location.href);
    if (target.href === window.location.href) return;
  } catch {
    // Unparseable destination: fall through to navigateToRoute and
    // let the browser reject it rather than navigating nowhere silently.
  }
  markBackNavigation();
  navigateToRoute(dest);
}

// ── Navigation seam ─────────────────────────────────────────────────
// Full-page navigation for Back. jsdom cannot stub location.assign
// (own, non-writable, non-configurable), so the implementation is a
// replaceable function — the same injectable-side-effect pattern as
// AppExitDeps in app-exit.ts. Production always uses the default.

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

let navigateImpl: (url: string) => void = defaultNavigate;

/** Perform a full-page navigation to an app route. */
export function navigateToRoute(url: string): void {
  navigateImpl(url);
}

/**
 * Override the navigation implementation (tests only). Pass null to
 * restore the default (window.location.assign). Never called in
 * production code.
 */
export function setRouteNavigator(
  fn: ((url: string) => void) | null,
): void {
  navigateImpl = fn ?? defaultNavigate;
}
