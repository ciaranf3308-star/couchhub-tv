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
  /** Human label for the origin, e.g. "Movies". Display only. */
  label: string;
}

const ROUTE_ORIGIN_KEY = "nylah:route-origin";

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
 * Navigate back to the recorded origin, or to `fallbackRoute` when
 * there is none (direct link / reload / bookmark). The origin is
 * consumed either way. No-op when already on the destination, when
 * the destination is not an app path, or when there is no window.
 */
export function navigateBackWithOrigin(fallbackRoute: string): void {
  const origin = readRouteOrigin();
  clearRouteOrigin();
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
