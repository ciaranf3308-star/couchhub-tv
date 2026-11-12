// SHIM-0110: replaced by W1/W3 implementation at integration.
//
// Controller Experience 2.0 seam contracts (brief §4, §5, §45),
// implemented on top of the REAL 0.11.9 tree so W2's Movies/Series
// integration works before W1 (Back coordinator / focus / hints)
// and W3 (shared OSK) land. Every export here carries the EXACT
// name + signature the brief defines; integration deletes this
// file and re-points the imports at back-handler.ts,
// couch-focus.ts, couch-keyboard.ts and couch-button-hints.ts.
//
// What the shim does, honestly:
//   - Back layers: a priority-sorted registry + ONE window-capture
//     Escape/BrowserBack dispatcher. It claims the event only when
//     a registered layer is active and handles it; dialogs,
//     unhandled keys and pages with no layers behave exactly as
//     before. An Android __xtHandleBack interceptor runs the same
//     registry. It does NOT replace gamepad.ts routing — B still
//     arrives as Escape, X/Y still arrive as keys only where
//     gamepad.ts dispatches them (see the W1 dependency note in
//     the W2 report).
//   - Route provenance: sessionStorage-backed origin record, only
//     honoured when the referrer names the same route (a stale
//     record from another tab/session can never hijack Back).
//   - Logical view: a session-persisted view key. The view-tagged
//     focus memory itself is W1's CouchFocusMemory.view field;
//     this shim only carries the key so mounts can record it.
//   - Keyboard: open/close state + window events W3's OSK listens
//     for. There is no DOM OSK in the 0.11.9 tree for the Browse
//     search overlay, so opening focuses the input and editing
//     works with a physical keyboard today; controller typing
//     awaits W3's shared keyboard.
//   - Hints: writes the shared [data-button-hints-list] bar
//     directly (same hintItemHtml renderer TvButtonHints uses)
//     and dispatches a change event. TvButtonHints re-renders
//     from its view config on focus/mutation, so layer hints may
//     be overwritten until W1's unification lands — callers keep
//     their local legend until then (flagged in the W2 report).

import { registerBackInterceptor } from "@/scripts/lib/back-handler.ts";
import {
  hintItemHtml,
  type HintConfig,
} from "@/scripts/lib/couch-button-hints.ts";

// ── Back layers ─────────────────────────────────────────────────

export const BACK_PRIORITY = {
  CONFIRM_DIALOG: 100,
  MODAL: 90,
  KEYBOARD: 80,
  DRAWER: 70,
  PLAYER_OPTIONS: 60,
  PLAYBACK: 50,
  DETAIL_SUBVIEW: 40,
  PAGE_STATE: 30,
  ROUTE: 20,
} as const;

export interface BackLayer {
  id: string;
  priority: number;
  isActive: () => boolean;
  /** Perform EXACTLY one Back step. Return true when handled. */
  handle: () => boolean;
}

const layers: BackLayer[] = [];
const dispatcherWindows = new WeakSet<object>();
let interceptorInstalled = false;

/** Run the topmost active layer. True when a layer handled the press. */
export function runBackLayers(): boolean {
  const ordered = [...layers].sort((a, b) => b.priority - a.priority);
  for (const layer of ordered) {
    let active: boolean;
    try {
      active = layer.isActive();
    } catch {
      active = false;
    }
    if (!active) continue;
    let handled: boolean;
    try {
      handled = layer.handle();
    } catch {
      handled = false;
    }
    if (handled) return true;
  }
  return false;
}

function dialogOwnsBack(doc: Document): boolean {
  try {
    if (doc.querySelector("dialog[open]")) return true;
    return !!doc.querySelector("[popover]:popover-open");
  } catch {
    return false;
  }
}

function onBackKey(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  if (event.key !== "Escape" && event.key !== "BrowserBack") return;
  if (typeof document === "undefined") return;
  // A modal dialog owns B: native Escape closes it; no layer runs.
  if (dialogOwnsBack(document)) return;
  if (runBackLayers()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function ensureBackDispatcher(): void {
  if (typeof window === "undefined") return;
  if (dispatcherWindows.has(window)) return;
  dispatcherWindows.add(window);
  // Capture phase on window: runs before document/window bubble
  // handlers (incl. the Browse controller's layer routing), so a
  // claimed press never also pops a second layer downstream.
  window.addEventListener("keydown", onBackKey, true);
  if (!interceptorInstalled) {
    interceptorInstalled = true;
    registerBackInterceptor(() => runBackLayers());
  }
}

export function registerBackLayer(layer: BackLayer): () => void {
  layers.push(layer);
  ensureBackDispatcher();
  return () => {
    const at = layers.indexOf(layer);
    if (at >= 0) layers.splice(at, 1);
  };
}

/** Test-only: drop every registered layer (jsdom module reuse). */
export function __resetBackLayersForTests(): void {
  layers.length = 0;
}

// ── Route provenance ────────────────────────────────────────────

export interface RouteOrigin {
  route: string;
  label: string;
}

const ORIGIN_KEY = "rs_route_origin_0110";

export function recordRouteOrigin(origin: RouteOrigin): void {
  try {
    sessionStorage.setItem(ORIGIN_KEY, JSON.stringify(origin));
  } catch {
    // Provenance is a nicety; Back falls back to the link/href.
  }
}

export function readRouteOrigin(): RouteOrigin | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(ORIGIN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RouteOrigin>;
    if (typeof parsed.route !== "string" || !parsed.route) return null;
    return {
      route: parsed.route,
      label: typeof parsed.label === "string" ? parsed.label : "",
    };
  } catch {
    return null;
  }
}

export type BackNavigationDecision =
  | { kind: "history-back" }
  | { kind: "assign"; route: string }
  | { kind: "click-back-link" }
  | { kind: "assign-fallback"; route: string };

/**
 * Pure Back decision for a detail page. The recorded origin is
 * honoured ONLY when the referrer names the same route pathname —
 * a stale record (direct landing, another tab) can never hijack
 * Back. When the referrer matches, history.back() restores the
 * exact origin state (Browse URL, scroll, focus memory); when
 * there is no history to go back to, assign the origin route.
 * Without a matching origin, the existing Back link decides
 * (its wireDetailBackLink handler), else the fallback route.
 */
export function resolveBackNavigation(opts: {
  origin: RouteOrigin | null;
  referrer: string;
  originOrigin: string;
  historyLength: number;
}): BackNavigationDecision {
  if (opts.origin) {
    let originPath: string;
    try {
      originPath = new URL(opts.origin.route, opts.originOrigin).pathname;
    } catch {
      originPath = "";
    }
    let referrerPath: string;
    try {
      const ref = new URL(opts.referrer);
      referrerPath = ref.origin === opts.originOrigin ? ref.pathname : "";
    } catch {
      referrerPath = "";
    }
    if (originPath && referrerPath === originPath) {
      if (opts.historyLength > 1) return { kind: "history-back" };
      return { kind: "assign", route: opts.origin.route };
    }
  }
  return { kind: "click-back-link" };
}

/**
 * Perform detail Back: provenance first, else the Back link's own
 * navigation, else the fallback route. The Back link is clicked
 * (not assigned) so its existing wireDetailBackLink decision —
 * history.back() from the grid, href otherwise — stays the
 * behaviour when no provenance applies.
 */
export function navigateBackWithOrigin(
  fallbackRoute: string,
  opts: { backLink?: HTMLElement | null } = {},
): void {
  const decision = resolveBackNavigation({
    origin: readRouteOrigin(),
    referrer: typeof document !== "undefined" ? document.referrer : "",
    originOrigin: typeof location !== "undefined" ? location.origin : "",
    historyLength: typeof history !== "undefined" ? history.length : 1,
  });
  if (decision.kind === "history-back") {
    history.back();
    return;
  }
  if (decision.kind === "assign") {
    window.location.assign(decision.route);
    return;
  }
  if (opts.backLink) {
    opts.backLink.click();
    return;
  }
  window.location.assign(fallbackRoute);
}

// ── Logical view (focus) ────────────────────────────────────────

export type LogicalView =
  | "movies-home"
  | "movies-browse"
  | "series-home"
  | "series-browse";

const VIEW_KEY = "rs_couch_logical_view";
let currentView: LogicalView | null = null;

export function setLogicalView(view: LogicalView): void {
  currentView = view;
  try {
    sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    // View memory is a nicety.
  }
}

export function getLogicalView(): LogicalView | null {
  if (currentView) return currentView;
  try {
    const raw = sessionStorage.getItem(VIEW_KEY);
    if (
      raw === "movies-home" ||
      raw === "movies-browse" ||
      raw === "series-home" ||
      raw === "series-browse"
    ) {
      currentView = raw;
      return raw;
    }
  } catch {
    // Ignore.
  }
  return null;
}

// ── Shared keyboard (W3) ────────────────────────────────────────

export type CouchKeyboardCommit = (committed: boolean, value: string) => void;

let keyboardInput: HTMLInputElement | null = null;
let keyboardOnCommit: CouchKeyboardCommit | null = null;

export function isCouchKeyboardOpen(): boolean {
  return keyboardInput != null;
}

export function openCouchKeyboard(
  input: HTMLInputElement,
  onCommit?: CouchKeyboardCommit,
): void {
  keyboardInput = input;
  keyboardOnCommit = onCommit ?? null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("couch-keyboard:open", { detail: { input } }),
    );
  }
  if (document.activeElement !== input) {
    try {
      input.focus();
    } catch {
      // Focus failure never blocks editing state.
    }
  }
}

export function closeCouchKeyboard(commit: boolean): void {
  const input = keyboardInput;
  const onCommit = keyboardOnCommit;
  keyboardInput = null;
  keyboardOnCommit = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("couch-keyboard:close", { detail: { commit } }),
    );
  }
  if (input && document.activeElement === input) {
    try {
      input.blur();
    } catch {
      // Ignore.
    }
  }
  if (onCommit && input) {
    try {
      onCommit(commit, input.value);
    } catch {
      // A throwing commit handler never breaks the close.
    }
  }
}

// ── Hints ───────────────────────────────────────────────────────

let lastHints: HintConfig | null = null;

export function setControllerHints(config: HintConfig): void {
  lastHints = config;
  if (typeof document !== "undefined") {
    const list = document.querySelector<HTMLElement>("[data-button-hints-list]");
    if (list) {
      list.innerHTML = config.items.map((item) => hintItemHtml(item)).join("");
      list.dataset.config = config.id;
      const nav = list.closest<HTMLElement>("[data-button-hints]");
      if (nav) nav.dataset.config = config.id;
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("couch-hints:change", { detail: { config } }),
    );
  }
}

/** Last config routed through the shim (tests / W1 handoff). */
export function getLastControllerHints(): HintConfig | null {
  return lastHints;
}

// ── Detail Back layer wiring (shared by both detail pages) ──────

export interface DetailBackLayersOptions {
  /** True while the player is mounted (B exits playback first). */
  isPlayerOpen: () => boolean;
  /** Close the topmost playback sub-layer (track list). True when one closed. */
  closePlaybackSubLayer?: () => boolean;
  /** Exit playback to the detail (focus Play/Resume / episode card). */
  onPlayerBack: () => void;
  /** True when focus sits in a detail subview (episodes/seasons). */
  isInDetailSubView?: () => boolean;
  /** One subview Back step (e.g. episodes → primary actions). */
  onDetailSubViewBack?: () => void;
  /** Route Back (provenance / Back link). */
  onDetailBack: () => void;
}

/**
 * Register the detail Back stack: playback sub-layer, playback,
 * detail subview, route — exactly one step per press, highest
 * priority first. Returns the unregister function.
 */
export function installDetailBackLayers(
  opts: DetailBackLayersOptions,
): () => void {
  const unregisters: Array<() => void> = [];
  unregisters.push(
    registerBackLayer({
      id: "detail-playback",
      priority: BACK_PRIORITY.PLAYBACK,
      isActive: () => opts.isPlayerOpen(),
      handle: () => {
        if (opts.closePlaybackSubLayer?.()) return true;
        opts.onPlayerBack();
        return true;
      },
    }),
  );
  if (opts.onDetailSubViewBack) {
    unregisters.push(
      registerBackLayer({
        id: "detail-subview",
        priority: BACK_PRIORITY.DETAIL_SUBVIEW,
        isActive: () =>
          !opts.isPlayerOpen() && (opts.isInDetailSubView?.() ?? false),
        handle: () => {
          opts.onDetailSubViewBack?.();
          return true;
        },
      }),
    );
  }
  unregisters.push(
    registerBackLayer({
      id: "detail-route",
      priority: BACK_PRIORITY.ROUTE,
      isActive: () => !opts.isPlayerOpen(),
      handle: () => {
        opts.onDetailBack();
        return true;
      },
    }),
  );
  return () => {
    for (const fn of unregisters) fn();
  };
}
