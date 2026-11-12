// SHIM-0110: replaced by W1 implementation at integration.
//
// Controller Experience 2.0 (0.11.10) seam contracts, implemented as a
// standalone fallback until W1's Back coordinator / provenance / hints
// modules land. W3 (keyboard + Discover + Search) builds against these
// EXACT names; at integration this file is DELETED and the imports in
// couch-keyboard.ts, SearchView.svelte and DiscoverView.svelte are
// rewired to W1's modules (back-handler.ts, the provenance module, and
// couch-button-hints.ts). Nothing here invents behaviour: the Back
// fallback dispatches through the existing Android interceptor stack
// (back-handler.ts), provenance is a validated sessionStorage record,
// and hints dispatch a window event no 0.11.9 consumer renders yet
// (the focus-driven TvButtonHints legend keeps working unchanged).
//
// The fallback is deliberately conservative:
//   - Back layers run ONLY on the Android BACK path (the one
//     registerBackInterceptor serves). Windows B/Escape keeps flowing
//     through each view's existing keydown handler, which calls the
//     SAME single-step function the layer calls — one step per press
//     on both paths, no double handling.
//   - Provenance never trusts a raw string: routes must be same-origin
//     absolute paths, and a consumed origin is single-use.

import { registerBackInterceptor } from "./back-handler";
import { goCouch } from "./couch-nav";
import type { HintConfig } from "./couch-button-hints";

/** Back-layer priorities (Contract A). Higher wins. */
export const BACK_PRIORITY = {
  MODAL: 90,
  KEYBOARD: 80,
  PAGE_STATE: 30,
  ROUTE: 20,
} as const;

export interface BackLayer {
  /** Stable layer id; re-registering the same id replaces the layer. */
  id: string;
  /** Priority from BACK_PRIORITY. */
  priority: number;
  /** True when this layer currently owns the next Back press. */
  isActive: () => boolean;
  /**
   * Perform EXACTLY one Back step. Return true when a step was
   * performed (the press is consumed); false lets lower layers run.
   */
  handle: () => boolean;
}

const layers = new Map<string, BackLayer>();
let unregisterInterceptor: (() => void) | null = null;

function dispatchLayers(): boolean {
  const ordered = [...layers.values()].sort((a, b) => b.priority - a.priority);
  for (const layer of ordered) {
    let active: boolean;
    try {
      active = layer.isActive();
    } catch {
      active = false;
    }
    if (!active) continue;
    try {
      if (layer.handle()) return true;
    } catch {
      // A broken layer must not wedge Back for every layer below it.
    }
  }
  return false;
}

/**
 * Register a Back layer. Returns an unregister function. The fallback
 * bridges to the Android interceptor stack with a single shared
 * interceptor that dispatches highest-priority-first.
 */
export function registerBackLayer(layer: BackLayer): () => void {
  layers.set(layer.id, layer);
  if (!unregisterInterceptor) {
    unregisterInterceptor = registerBackInterceptor(dispatchLayers);
  }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    if (layers.get(layer.id) === layer) layers.delete(layer.id);
    if (layers.size === 0 && unregisterInterceptor) {
      unregisterInterceptor();
      unregisterInterceptor = null;
    }
  };
}

// ── Route provenance (Contract B) ────────────────────────────────────

const ROUTE_ORIGIN_KEY = "rs-route-origin-0110";
/** An origin older than this is stale (tab left open) and ignored. */
export const ROUTE_ORIGIN_MAX_AGE_MS = 30 * 60 * 1000;

export interface RouteOrigin {
  route: string;
  label: string;
}

function isSafeRoute(route: string): boolean {
  // Same-origin absolute path only: no scheme, no protocol-relative
  // URL, no backslash tricks.
  return (
    route.startsWith("/") &&
    !route.startsWith("//") &&
    !route.includes("://") &&
    !route.includes("\\")
  );
}

/** Record where the user came from, for origin-aware Back. */
export function recordRouteOrigin(origin: RouteOrigin): void {
  if (!isSafeRoute(origin.route)) return;
  try {
    sessionStorage.setItem(
      ROUTE_ORIGIN_KEY,
      JSON.stringify({ route: origin.route, label: origin.label, at: Date.now() }),
    );
  } catch {
    // Provenance is a nicety; the fallback route still works.
  }
}

function readRouteOrigin(now: number = Date.now()): RouteOrigin | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(ROUTE_ORIGIN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { route?: unknown; label?: unknown; at?: unknown };
    if (typeof parsed.route !== "string" || !isSafeRoute(parsed.route)) return null;
    if (typeof parsed.at === "number" && (now - parsed.at < 0 || now - parsed.at > ROUTE_ORIGIN_MAX_AGE_MS)) {
      return null;
    }
    return { route: parsed.route, label: typeof parsed.label === "string" ? parsed.label : "" };
  } catch {
    return null;
  }
}

function consumeRouteOrigin(): void {
  try {
    sessionStorage.removeItem(ROUTE_ORIGIN_KEY);
  } catch {
    // Best effort.
  }
}

/**
 * Record the origin from document.referrer (full-page navigation sets
 * it): same-origin, different path only. Views call this at mount so
 * Back returns to the real launching screen without every launcher
 * needing to record the origin itself.
 */
export function recordOriginFromReferrer(currentPath: string): void {
  if (typeof document === "undefined") return;
  try {
    const ref = document.referrer;
    if (!ref) return;
    const url = new URL(ref, window.location.href);
    if (url.origin !== window.location.origin) return;
    const path = url.pathname + url.search + url.hash;
    const current = currentPath || window.location.pathname;
    if (url.pathname === current || path === current) return;
    recordRouteOrigin({ route: url.pathname, label: "" });
  } catch {
    // No usable referrer — the fallback route still works.
  }
}

/**
 * Navigate back to the recorded origin, or to fallbackRoute when
 * there is none (or it names the current page). Single-use: the
 * origin is consumed. Never uses history.length / history.back().
 */
export function navigateBackWithOrigin(fallbackRoute: string): void {
  const origin = readRouteOrigin();
  consumeRouteOrigin();
  const current = typeof window !== "undefined" ? window.location.pathname : "";
  if (origin && origin.route !== current) {
    goCouch(origin.route);
    return;
  }
  goCouch(fallbackRoute);
}

// ── Controller hints (Contract: setControllerHints) ──────────────────

/** Window event carrying a hints override until W1 renders it. */
export const CONTROLLER_HINTS_EVENT = "couch-hints:override";

let lastHints: HintConfig | null = null;

/**
 * Publish a controller-hints config. SHIM: stores it and dispatches
 * CONTROLLER_HINTS_EVENT; W1's implementation renders it through the
 * shared legend. Safe to call before W1 lands (no consumer, no-op
 * visually — the focus-driven legend is untouched).
 */
export function setControllerHints(config: HintConfig): void {
  lastHints = config;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CONTROLLER_HINTS_EVENT, { detail: { config } }),
    );
  }
}

/** Last published hints config, or null. Test seam. */
export function getLastControllerHints(): HintConfig | null {
  return lastHints;
}
