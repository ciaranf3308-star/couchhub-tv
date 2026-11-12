// Android BACK key routing + the Controller Experience 2.0 Back
// coordinator (§4.1). MainActivity calls window.__xtHandleBack() and
// falls through to WebView history / app exit when it returns false.
//
// ONE semantic Back path: Android Back, controller B (gamepad.ts) and
// physical Escape (mountBackCoordinator's capture listener) all
// resolve through resolveBack(). Exactly one layer is consumed per
// press — a layer that handles Back stops the chain, so Back never
// dispatches Escape into the newly exposed layer underneath.
//
// Resolution order in resolveBack():
//   1. Registered Back layers, topmost-first: highest priority wins,
//      most-recently-registered wins ties. A layer that is active but
//      declines (handle() returns false) falls through to lower
//      layers; a layer that handles (true) stops the chain.
//   2. Legacy registerBackInterceptor callbacks (LIFO) — the existing
//      Android callers (DiscoverView, legacy playback). Kept working
//      unchanged; new code registers Back layers instead.
//   3. Open <dialog> / popover / fullscreen — the pre-0.11.10
//      handleBack behaviour, preserved verbatim.
//   4. Route-level Back: the recorded route origin (route-origin.ts),
//      one-shot. Direct links have no origin, so this step is inert
//      until a worker records one.
//   5. MIGRATION BRIDGE: a synthetic Escape dispatched to the focused
//      element, for screens not yet migrated to layers — their
//      existing Escape handlers keep working exactly as before.
//      Skipped at Home root (B there is a no-op) and skipped when the
//      press IS a physical Escape (the real event keeps flowing to
//      the screen's own handler; dispatching a second Escape would
//      double-pop). Documented as a bridge: it goes away screen by
//      screen as layers land, it is not a second Back implementation.
//
// Live TV keeps its own back stack (livetv:back via dispatchLivetvBack
// in gamepad.ts) and does NOT register layers here — the B branch in
// gamepad.ts routes Live TV contexts to it before resolveBack().

import { clearRouteOrigin, navigateToRoute, readRouteOrigin } from "./route-origin.ts"

// ── Legacy interceptors (pre-0.11.10 API — preserved) ─────────────

type BackInterceptor = () => boolean

const interceptors: BackInterceptor[] = []

export function registerBackInterceptor(interceptor: BackInterceptor): () => void {
  interceptors.push(interceptor)
  return () => {
    const index = interceptors.indexOf(interceptor)
    if (index >= 0) interceptors.splice(index, 1)
  }
}

// ── Back layers (Controller 2.0 contract) ───────────────────────────

/** Priority ladder for Back layers. Higher number = handled first. */
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
} as const

export interface BackLayer {
  /** Stable id, e.g. "dialog:movie-trailer-dialog" or "drawer:filters". */
  id: string
  /** One of BACK_PRIORITY (custom numbers allowed, ladder order wins). */
  priority: number
  /** True while this layer owns Back right now. Cheap and side-effect-free. */
  isActive: () => boolean
  /** Handle one Back press. True = consumed (chain stops). False = decline. */
  handle: () => boolean
}

interface RegisteredLayer extends BackLayer {
  seq: number
}

const layers: RegisteredLayer[] = []
let layerSeq = 0

export function registerBackLayer(layer: BackLayer): () => void {
  const entry: RegisteredLayer = { ...layer, seq: layerSeq++ }
  layers.push(entry)
  return () => {
    const index = layers.indexOf(entry)
    if (index >= 0) layers.splice(index, 1)
  }
}

/** Layers in resolution order: highest priority, then most recent. */
function orderedLayers(): RegisteredLayer[] {
  return [...layers].sort((a, b) => b.priority - a.priority || b.seq - a.seq)
}

// ── Synthetic-Escape guard ──────────────────────────────────────────
//
// The gamepad bridge dispatches synthetic Escape keydowns for B on
// unmigrated screens (the migration bridge, step 5). The coordinator's
// physical-Escape listener must never re-resolve those — one press,
// one resolution. Synthetic events are marked (markSyntheticBackEvent,
// called by gamepad.ts's dispatchKey) AND untrusted (isTrusted false
// for every script-dispatched event); the listener checks both.

const SYNTHETIC_BACK_MARK = "__couchBackSynthetic"

/** Stamp a synthetic event so the coordinator's Escape listener skips it. */
export function markSyntheticBackEvent(event: Event): void {
  try {
    Object.defineProperty(event, SYNTHETIC_BACK_MARK, { value: true })
  } catch {
    // Event object refuses the stamp: the isTrusted guard still applies.
  }
}

export function isSyntheticBackEvent(event: Event): boolean {
  return (
    (event as unknown as Record<string, unknown>)[SYNTHETIC_BACK_MARK] === true
  )
}

// ── Fallback steps ──────────────────────────────────────────────────

function closeTopmostChrome(): boolean {
  if (typeof document === "undefined") return false
  const openDialogs = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"))
  const topDialog = openDialogs[openDialogs.length - 1]
  if (topDialog) {
    // Guarded like closeCouchDialog: jsdom's <dialog> has no close()
    // and very old webviews may not either — the attribute fallback
    // closes it all the same.
    try {
      if (typeof topDialog.close === "function") topDialog.close()
      else topDialog.removeAttribute("open")
    } catch {
      topDialog.removeAttribute("open")
    }
    return true
  }
  try {
    const openPopover = document.querySelector<HTMLElement>("[popover]:popover-open")
    if (openPopover) {
      openPopover.hidePopover()
      return true
    }
  } catch {}
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
    return true
  }
  return false
}

/** Route-level Back: navigate to the recorded origin, one-shot. */
function navigateToRecordedOrigin(): boolean {
  const origin = readRouteOrigin()
  if (!origin) return false
  // Consumed either way: a stale origin must never fire twice, and a
  // self-origin (recorded on the page we are already on) is discarded.
  clearRouteOrigin()
  if (typeof window === "undefined") return false
  try {
    const target = new URL(origin.route, window.location.href)
    if (target.href === window.location.href) return false
  } catch {
    return false
  }
  navigateToRoute(origin.route)
  return true
}

function isHomeRoot(): boolean {
  try {
    const path = window.location.pathname
    return path === "/" || path === ""
  } catch {
    return false
  }
}

/**
 * Migration bridge: dispatch a synthetic Escape (keydown + keyup, with
 * the keyCode stamp spatial-navigation.js needs) to the focused
 * element, so unmigrated screens' existing Escape handlers run. Kept
 * in this module — not in gamepad.ts — because gamepad.ts imports the
 * coordinator and the reverse import would be a cycle.
 */
function dispatchBackEscapeFallback(): boolean {
  if (typeof document === "undefined") return false
  if (isHomeRoot()) return false
  const target = document.activeElement ?? document.body
  if (!target) return false
  for (const type of ["keydown", "keyup"] as const) {
    const event = new KeyboardEvent(type, {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    })
    try {
      Object.defineProperty(event, "keyCode", { value: 27 })
      Object.defineProperty(event, "which", { value: 27 })
    } catch {
      // Very old webviews: the key-only event still goes out.
    }
    markSyntheticBackEvent(event)
    target.dispatchEvent(event)
  }
  return true
}

// ── Resolution ──────────────────────────────────────────────────────

/** Legacy interceptors, LIFO. Shared by resolveBack() and handleBack(). */
function runLegacyInterceptors(): boolean {
  for (let i = interceptors.length - 1; i >= 0; i--) {
    try {
      if (interceptors[i]()) return true
    } catch {}
  }
  return false
}

function resolveBackInternal(fromPhysicalEscape: boolean): boolean {
  for (const layer of orderedLayers()) {
    let active: boolean
    try {
      active = layer.isActive()
    } catch {
      active = false
    }
    if (!active) continue
    let handled: boolean
    try {
      handled = layer.handle()
    } catch {
      handled = false
    }
    if (handled) return true
  }
  if (runLegacyInterceptors()) return true
  if (closeTopmostChrome()) return true
  if (navigateToRecordedOrigin()) return true
  // Physical Escape: the real event is still propagating to the
  // screen's own handler — never dispatch a synthetic second one.
  if (fromPhysicalEscape) return false
  return dispatchBackEscapeFallback()
}

/**
 * Resolve one Back press through the layer stack. True when something
 * consumed it. The single semantic Back path for Android Back,
 * controller B and physical Escape.
 */
export function resolveBack(): boolean {
  return resolveBackInternal(false)
}

/** Pre-0.11.10 behaviour, preserved for mountBackHandler callers. */
function handleBack(): boolean {
  return runLegacyInterceptors() || closeTopmostChrome()
}

export function mountBackHandler(): void {
  ;(window as any).__xtHandleBack = handleBack
}

// ── Coordinator mount (Couch pages) ─────────────────────────────────

const COORDINATOR_FLAG = "__rsBackCoordinatorMounted" as const

/**
 * The testable half of the physical-Escape listener: decide whether
 * the coordinator consumes this keydown, and stop it when it does.
 * Exported because jsdom cannot produce a trusted KeyboardEvent
 * (isTrusted is an own, non-configurable property there), so tests
 * call this directly with fabricated events; the registered listener
 * below is this same function. Returns true when the press was
 * consumed (the caller need not act further).
 */
export function handleCoordinatorEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape") return false
  // Synthetic Escapes (gamepad bridge, migration bridge) keep their
  // own path — resolving them again would double-pop.
  if (isSyntheticBackEvent(event)) return false
  if (event.isTrusted === false) return false
  if (event.defaultPrevented) return false
  // Capture phase on window: this runs before every page handler, so
  // a consumed Back must stop the event here or the page handler
  // would act on the same press too. stopImmediatePropagation (not
  // just stopPropagation): same-target capture listeners would
  // otherwise still run, and a consumed Back belongs to exactly one
  // layer. An unconsumed Back lets the event flow on to the screen's
  // own Escape handler untouched.
  if (resolveBackInternal(true)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    return true
  }
  return false
}

/**
 * Wire the coordinator: Android Back (__xtHandleBack) resolves through
 * resolveBack(), and physical Escape resolves through the same chain
 * via ONE capture-phase window listener (no capture/bubble pair, so
 * no double-firing). Idempotent. Controller B reaches resolveBack()
 * via gamepad.ts, not through this listener.
 */
export function mountBackCoordinator(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  ;(window as any).__xtHandleBack = () => resolveBack()
  const win = window as unknown as Record<string, unknown>
  if (win[COORDINATOR_FLAG]) return
  win[COORDINATOR_FLAG] = true
  window.addEventListener("keydown", handleCoordinatorEscape, true)
}
