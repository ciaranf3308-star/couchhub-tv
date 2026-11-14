// NylahBox 0.11.14 (W1) — Per-view navigation ownership (§2) and the
// active-input-ownership contract (§5).
//
// THE §2 PROBLEM, FIXED HERE: gamepad.ts used to call
// handleRailDirection() for EVERY view before spatial navigation, and
// that handler discovered every visible `[data-nylah-rail]` in the
// whole document. Discover, Search and other pages also mark
// structures as rails, so they were subjected to a Home-style rail
// model their layouts never wanted. From 0.11.14 the rail model runs
// ONLY when the current view's navigation kind is "rail" or "shelf"
// AND focus is inside that view's rail scope (see
// railNavigationApplies / railScopeRoot). Every other view falls
// through to its own handler or to the generic spatial engine, which
// is the fallback — never the overriding model.
//
// HOW A VIEW DECLARES OWNERSHIP (W3 contract — read this first):
//
//   1. DEFAULT (no code): the view's logical view name — the same
//      string its owner already passes to setLogicalView() in
//      couch-focus.ts — maps to a NavigationKind through
//      NAVIGATION_KIND_BY_VIEW below. setLogicalView() syncs the
//      current view here automatically, so a view that already names
//      itself gets the right kind for free. Unknown view names fall
//      back to "spatial" (generic engine, no interception).
//
//   2. EXPLICIT (when a view needs more than its kind): the view
//      registers a NavigationOwner while it is mounted:
//
//        const unregister = registerNavigationOwner({
//          id: "discover",
//          kind: "mixed",
//          root: () => document.querySelector("[data-discover-root]"),
//          isActive: () => !document.querySelector("[hidden]")?.contains(...),
//          handleDirection: (dir, from) => { …; return consumed; },
//        });
//        // on unmount / mode switch: unregister();
//
//      Rules: an owner only applies while isActive() is true (omit
//      it to mean "always") and while focus is inside its root.
//      The most-recently-registered matching owner wins. A custom
//      handleDirection runs BEFORE the kind's built-in behaviour;
//      returning true consumes the press (nothing else runs);
//      returning false falls through to the built-in behaviour for
//      the kind. Owners must unregister on unmount — a stale owner
//      for a hidden view (e.g. a kept-alive Browse mount while Home
//      shows) must never claim input; isActive() MUST check
//      visibility when the view can be mounted-but-hidden.
//
//   3. SECTION ENTRY: an owner may supply sectionEntry(dir, from)
//      to name the sensible target when focus ENTERS its root from
//      outside (not "the first arbitrary DOM element"). When absent,
//      entry falls back to the kind's built-in behaviour (rail:
//      remembered item; grid/mixed: nearest-column element; see
//      spatial-navigation.js `enterTo: "nearest-column"`).
//
// §5 ACTIVE INPUT OWNERSHIP — the priority ladder (1 = topmost):
//   1 confirmation/modal, 2 keyboard/text-editing, 3 drawer/popover,
//   4 player controls/options, 5 full-screen mode, 6 current screen,
//   7 global navigation. The topmost applicable layer handles the
//   action; once consumed, the same press must not trigger another
//   handler. This module does NOT create a new dispatch
//   architecture: Back already resolves through the Back-layer
//   coordinator (back-handler.ts BACK_PRIORITY, same ladder, higher
//   number = earlier), directions resolve through the owner chain in
//   gamepad.ts move(), and buttons resolve through the single
//   handleGamepadButtonPress pipeline. INPUT_PRIORITY exists so
//   every layer names the same ladder in code and comments; new
//   handlers must check the layers above them before acting and
//   must return/consume exactly once.
//
// CURSOR MODE SEAM (W2): Cursor Mode is an input-ownership layer,
// not a second focus engine. W2 registers ONE direction handler via
// registerCursorDirectionHandler(); gamepad.ts routes left-stick
// directions to it ONLY while Cursor Mode is active, and a consumed
// stick direction never also reaches focus navigation. D-pad
// directions keep driving focus navigation while Cursor Mode is
// active (§6 table). Until W2 registers a handler, stick directions
// in Cursor Mode keep the pre-0.11.14 behaviour (focus navigation),
// so this seam is inert on its own. No dual routing: exactly one
// branch in gamepad.ts move() runs per press.
//
// This module imports nothing: it is pure registry + predicates, so
// gamepad.ts, couch-focus.ts, cursor-mode.ts and view components can
// all import it without cycles.

export type NavigationDirection = "up" | "down" | "left" | "right";

/**
 * How a view wants directional input interpreted. The kind selects
 * the built-in movement behaviour; a registered NavigationOwner can
 * refine it with handleDirection / sectionEntry.
 */
export type NavigationKind =
  /** Home shelves: rail-oriented movement (row = rail, Up/Down = adjacent rail). */
  | "rail"
  /** Movies/Series Home: the established shelf behaviour (rail engine, scoped to the Home root). */
  | "shelf"
  /** Library grids, Favourites, Watch Later, Recently Added, Browse Everything grids: grid geometry. */
  | "grid"
  /** Discover: structured mixed layout — named sections in order, column preservation, no rail model. */
  | "mixed"
  /** Search: input / suggestions / results; the keyboard layer owns editing, results are a grid. */
  | "search"
  /** Guide: timeline + programme modes; the Guide's own key handler owns movement. */
  | "timeline"
  /** Settings and other long forms/lists: list geometry, Left/Right operate selectors. */
  | "form"
  /** Live TV landing/browser/playback: the Live TV key stack owns movement; core must not intercept. */
  | "delegate"
  /** Generic spatial engine fallback. No interception, no rail model. */
  | "spatial";

/** Logical view name (setLogicalView) → navigation kind. Unknown views → "spatial". */
export const NAVIGATION_KIND_BY_VIEW: Readonly<Record<string, NavigationKind>> = {
  home: "rail",
  "movies-home": "shelf",
  "series-home": "shelf",
  "movies-browse": "grid",
  "series-browse": "grid",
  discover: "mixed",
  search: "search",
  favorites: "grid",
  watchlist: "grid",
  "recently-added": "grid",
  followed: "grid",
  "followed-sports": "mixed",
  "livetv-guide": "timeline",
  "livetv-landing": "delegate",
  "livetv-browser": "delegate",
  "livetv-playback": "delegate",
  settings: "form",
  "playlist-editor": "form",
  login: "form",
  downloads: "grid",
  docs: "spatial",
  "controller-status": "spatial",
};

// ── Current view (synced by couch-focus.ts setLogicalView) ─────────

let currentView = "";

/** Name the logical view currently on screen. Called by setLogicalView; views do not call this directly. */
export function setCurrentNavigationView(view: string): void {
  currentView = typeof view === "string" ? view : "";
}

/** The current logical view, or "" when no owner has named one. */
export function getCurrentNavigationView(): string {
  return currentView;
}

/** The navigation kind for a view (default: the current view). Unknown views → "spatial". */
export function navigationKindForView(view: string = currentView): NavigationKind {
  const mapped = NAVIGATION_KIND_BY_VIEW[view];
  if (mapped) return mapped;
  // Unset view (no owner has named one yet — e.g. a D-pad press in
  // the first frames before the view's onMount runs): infer from
  // unambiguous page structure. Only the Home rails wrapper and the
  // Movies/Series Home roots infer a rail/shelf kind — Discover,
  // Search and grids carry neither, so they can never infer into
  // the rail model. Everything else → "spatial".
  if (view === "") return inferNavigationKindFromDom();
  return "spatial";
}

/** DOM fallback for an unnamed view: Home wrapper → "rail", Movies/Series Home root → "shelf", else "spatial". */
export function inferNavigationKindFromDom(
  doc: Document | null = typeof document !== "undefined" ? document : null,
): NavigationKind {
  if (!doc) return "spatial";
  try {
    if (doc.querySelector("[data-nylah-rails]")) return "rail";
    if (doc.querySelector("#movies-home-root, #series-home-root")) return "shelf";
  } catch {
    // No DOM access: spatial fallback.
  }
  return "spatial";
}

// ── §5 input-ownership priority ladder ─────────────────────────────
// 1 = topmost. Mirrors BACK_PRIORITY in back-handler.ts (which uses
// higher-number-wins: CONFIRM_DIALOG 100 … ROUTE 20, same order).

export const INPUT_PRIORITY = {
  /** Confirmation / modal dialog. */
  CONFIRM_MODAL: 1,
  /** Open on-screen keyboard or text-editing mode. */
  KEYBOARD: 2,
  /** Active drawer / popover. */
  DRAWER: 3,
  /** Player controls and player options. */
  PLAYER: 4,
  /** Current full-screen mode. */
  FULLSCREEN: 5,
  /** Current screen (the registered navigation owner / view handler). */
  SCREEN: 6,
  /** Global navigation fallback (spatial engine, global keys). */
  GLOBAL: 7,
} as const;

// ── Navigation owners ──────────────────────────────────────────────

export interface NavigationOwner {
  /** Stable id, e.g. "discover" or "movies-browse". Re-registering the same id replaces the owner. */
  id: string;
  /** The kind this owner implements. */
  kind: NavigationKind;
  /**
   * The view's root: an element, a selector string, or a thunk
   * returning the current root (preferred for re-rendered views).
   * The owner only applies while focus is inside this root. Omit
   * to scope to the whole document (only correct for full-page
   * owners that are the only content on screen).
   */
  root?: Element | string | (() => Element | null);
  /**
   * True while this owner is the live one. MUST check visibility
   * when the view can be mounted-but-hidden (kept-alive Browse
   * mounts, tabbed modes). Omit to mean "always active".
   */
  isActive?: () => boolean;
  /**
   * Handle one directional press. Return true when consumed (the
   * press stops here — no built-in behaviour, no spatial fallback).
   * Return false to fall through to the kind's built-in behaviour.
   * `from` is the element that held focus when the press arrived.
   */
  handleDirection?: (dir: NavigationDirection, from: Element) => boolean;
  /**
   * Name the sensible entry target when focus enters this owner's
   * root from outside in direction `dir` (`from` is the element
   * focus is leaving, or null). Return null to use the kind's
   * built-in entry behaviour. Never return a hidden or detached
   * element.
   */
  sectionEntry?: (
    dir: NavigationDirection,
    from: Element | null,
  ) => HTMLElement | null;
}

interface RegisteredOwner extends NavigationOwner {
  seq: number;
}

const owners: RegisteredOwner[] = [];
let ownerSeq = 0;

/**
 * Register (or replace, by id) a navigation owner. Returns an
 * unregister function — call it on unmount / mode switch.
 */
export function registerNavigationOwner(owner: NavigationOwner): () => void {
  const existing = owners.findIndex((entry) => entry.id === owner.id);
  if (existing >= 0) owners.splice(existing, 1);
  const entry: RegisteredOwner = { ...owner, seq: ownerSeq++ };
  owners.push(entry);
  return () => {
    const index = owners.indexOf(entry);
    if (index >= 0) owners.splice(index, 1);
  };
}

/** Remove every registered owner. Tests and full page resets only. */
export function clearNavigationOwners(): void {
  owners.length = 0;
}

/** Resolve an owner's root to an element, or null when it has none / is detached. */
export function resolveOwnerRoot(
  owner: Pick<NavigationOwner, "root">,
): Element | null {
  const root = owner.root;
  if (!root) return null;
  if (typeof root === "string") {
    try {
      return document.querySelector(root);
    } catch {
      return null;
    }
  }
  if (typeof root === "function") {
    try {
      return root() ?? null;
    } catch {
      return null;
    }
  }
  return root;
}

function ownerIsActive(owner: RegisteredOwner): boolean {
  if (!owner.isActive) return true;
  try {
    return owner.isActive();
  } catch {
    return false;
  }
}

function ownerContains(owner: RegisteredOwner, el: Element | null): boolean {
  const root = resolveOwnerRoot(owner);
  if (!root) return true; // Document-scoped owner.
  if (!root.isConnected) return false;
  if (!el) return true; // No focus yet: the owner may claim entry.
  return root.contains(el);
}

/**
 * The owner that owns directional input for `from` (default: the
 * focused element): the most-recently-registered active owner whose
 * root contains it, or null when no owner claims it (the caller
 * falls back to the current view's kind).
 */
export function resolveNavigationOwner(
  from?: Element | null,
): NavigationOwner | null {
  const el =
    from !== undefined
      ? from
      : typeof document !== "undefined"
        ? ((document.activeElement as Element | null) ===
          document.body
            ? null // <body> focused = nothing focused (entry may run).
            : (document.activeElement as Element | null))
        : null;
  for (let i = owners.length - 1; i >= 0; i--) {
    const owner = owners[i];
    if (ownerIsActive(owner) && ownerContains(owner, el)) return owner;
  }
  return null;
}

/** The effective navigation kind for `from`: the resolving owner's kind, else the current view's kind. */
export function effectiveNavigationKind(
  from?: Element | null,
): NavigationKind {
  return resolveNavigationOwner(from)?.kind ?? navigationKindForView();
}

// ── §2 rail gating ─────────────────────────────────────────────────

/**
 * True only when the rail model may run for `from`: the effective
 * kind is "rail" or "shelf" AND focus is inside the rail scope (or
 * there is no focus yet, so Down-from-hero entry may run). On every
 * other kind — Discover ("mixed"), Search ("search"), grids,
 * Guide, Settings, Live TV — this is false, so the rail model can
 * never hijack those layouts however many `[data-nylah-rail]`
 * markers they contain.
 */
export function railNavigationApplies(from?: Element | null): boolean {
  const kind = effectiveNavigationKind(from);
  if (kind !== "rail" && kind !== "shelf") return false;
  const el =
    from !== undefined
      ? from
      : typeof document !== "undefined"
        ? (document.activeElement as Element | null)
        : null;
  if (!el || el === (typeof document !== "undefined" ? document.body : null)) {
    return true; // No focus yet: entry (Down from hero / first rail) may run.
  }
  if (typeof (el as Element).closest === "function" && (el as Element).closest("[data-nylah-hero]")) {
    return true; // Hero focus: Down enters the first rail (entry zone).
  }
  const owner = resolveNavigationOwner(el);
  const root = owner ? resolveOwnerRoot(owner) : null;
  if (root) return root.contains(el);
  // No registered owner: the rail scope below bounds the model.
  const scope = railScopeRoot();
  return scope === document.documentElement || scope.contains(el);
}

/**
 * The element rails are queried within: the resolving owner's root,
 * else the Home `[data-nylah-rails]` wrapper, else the Movies/Series
 * Home root, else the document element. On rail/shelf views the
 * document fallback is safe — the kind gate above already excluded
 * every non-rail view — but the narrower scopes keep a stray rail
 * marker elsewhere on the page (hero, nav) out of the model.
 */
export function railScopeRoot(from?: Element | null): Element {
  const owner = resolveNavigationOwner(from);
  const ownerRoot = owner ? resolveOwnerRoot(owner) : null;
  if (ownerRoot) return ownerRoot;
  if (typeof document === "undefined") {
    // No DOM (pure unit context): callers must not query rails.
    throw new Error("railScopeRoot requires a document");
  }
  return (
    document.querySelector("[data-nylah-rails]") ??
    document.querySelector("#movies-home-root, #series-home-root") ??
    document.documentElement
  );
}

// ── §5 drawer scoping ──────────────────────────────────────────────

/** Roots of div-based drawers (not <dialog>s): input inside one belongs to the drawer, never to the page behind it. */
export const DRAWER_ROOT_SELECTOR =
  "[data-browse-filter-drawer], [data-browse-category-drawer], [data-category-drawer], [data-drawer-root]";

/** The open drawer containing `el`, or null. Drawers own directions/A/B while focus is inside them. */
export function drawerContaining(el: Element | null | undefined): Element | null {
  if (!el || typeof (el as Element).closest !== "function") return null;
  return (el as Element).closest(DRAWER_ROOT_SELECTOR);
}

// ── Cursor Mode direction seam (W2) ────────────────────────────────

/** Where a direction came from: D-pad presses keep focus navigation in Cursor Mode; the left stick scrolls. */
export type CursorDirectionSource = "dpad" | "stick";

/**
 * W2's Cursor Mode scroll handler: scroll the container under the
 * pointer for `dir`. Return true when the press was consumed as a
 * scroll (focus navigation must NOT also run); false to fall
 * through to focus navigation.
 */
export type CursorDirectionHandler = (dir: NavigationDirection) => boolean;

let cursorDirectionHandler: CursorDirectionHandler | null = null;

/** Register W2's cursor-scroll handler. Returns an unregister function. Only one handler may exist. */
export function registerCursorDirectionHandler(
  handler: CursorDirectionHandler,
): () => void {
  cursorDirectionHandler = handler;
  return () => {
    if (cursorDirectionHandler === handler) cursorDirectionHandler = null;
  };
}

/** True when W2 has registered a cursor-scroll handler. */
export function hasCursorDirectionHandler(): boolean {
  return cursorDirectionHandler !== null;
}

/**
 * Offer a stick direction to the cursor-scroll handler. False when
 * no handler is registered (caller falls through to focus
 * navigation — the pre-0.11.14 behaviour, preserved until W2 lands).
 */
export function routeDirectionToCursor(dir: NavigationDirection): boolean {
  if (!cursorDirectionHandler) return false;
  try {
    return cursorDirectionHandler(dir);
  } catch {
    return false;
  }
}
