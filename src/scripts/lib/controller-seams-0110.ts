// SHIM-0110: replaced by W1/W2/W3 implementation at integration.
//
// Controller Experience 2.0 seam contracts (brief §45 / coordinator
// spec), implemented against the REAL 0.11.9 mechanisms so W5 screens
// work standalone on this branch. The signatures below are the
// contract: W1 owns the Back coordinator + provenance + focus +
// hints, W2 owns the title context menu, W3 owns the keyboard
// lifecycle. At integration this file is DELETED and its exports are
// re-provided by those owners' modules with identical signatures —
// every consumer in this branch imports ONLY from this module (plus
// openCouchDialog/closeCouchDialog, which already exist in
// couch-focus.ts), so integration re-points one import path per file
// (or replaces this file's body with re-exports).
//
// What the shim actually does on 0.11.9:
//   - Back layers: one bubble-phase document Escape listener. Native
//     <dialog>s, popovers and open menus own B first (their own
//     handlers consume the press); otherwise the highest-priority
//     active layer runs EXACTLY one step. The gamepad layer's
//     trailing Escape after a B-blur out of a text field is
//     swallowed (see TRAILING_ESCAPE_WINDOW_MS in
//     couch-keyboard.ts) so one B never exits editing AND navigates.
//   - Provenance: a sessionStorage stack of same-origin routes the
//     user arrived from. navigateBackWithOrigin pops the stack;
//     the destination page's recordOriginFromReferrer() call skips
//     the push when the navigation was a Back (no ping-pong).
//   - Hints: setControllerHints stores the config, mirrors it to
//     html[data-couch-hints-override], and dispatches
//     `couchhubtv:set-hints`. It deliberately does NOT rewrite the
//     TvButtonHints bar DOM — that component re-renders from its
//     static HINT_CONFIGS on every focus/mutation event and would
//     overwrite a DOM write. W1 wires the bar to honour the
//     override/event at integration; until then the static audited
//     per-view configs apply.
//   - Keyboard: openCouchKeyboard/closeCouchKeyboard manage the
//     editing lifecycle (focus, editing marker, commit callback)
//     around the field itself. No OSK is mounted by the shim —
//     W3's implementation mounts the shared on-screen keyboard.
//   - Context menu: openTitleContextMenu renders a poster-menu-
//     styled menu for arbitrary actions (Escape/outside-click
//     close, focus first item, invoker restore). W2 replaces it
//     with the poster-menu-based implementation.
//
// Extra helpers beyond the contract (recordOriginFromReferrer,
// getLogicalView, closeTitleContextMenu, isTitleContextMenuOpen):
// integration must preserve them or re-point the call sites — they
// are used by W5 views and listed in the W5 hand-back.

import type { HintConfig } from "@/scripts/lib/couch-button-hints.js"

// ── Back layers ───────────────────────────────────────────────────

/** Back-layer priorities. Values are the shim's; W1's real values win at integration — consumers must use the names, never literals. */
export const BACK_PRIORITY = {
  /** Open modal dialogs / confirmations. */
  MODAL: 100,
  /** Drawers and overlay panels. */
  DRAWER: 90,
  /** Text-field editing / OSK. */
  EDITING: 80,
  /** Open context menus. */
  MENU: 70,
  /** Other overlays (search overlays, pickers). */
  OVERLAY: 60,
  /** Section-level step (e.g. section page → All Settings). */
  SECTION: 40,
  /** Page-level step (e.g. page → origin). */
  PAGE: 20,
  /** Root step (e.g. Home no-op). */
  ROOT: 10,
} as const

export interface BackLayer {
  /** Stable id, for debugging and de-duplication. */
  id: string
  /** One of BACK_PRIORITY. Higher runs first. */
  priority: number
  /** True when this layer owns the next Back press. */
  isActive: () => boolean
  /** Perform EXACTLY one back step. Must not navigate twice. */
  handle: () => void
}

interface RegisteredLayer extends BackLayer {
  seq: number
}

const layers: RegisteredLayer[] = []
let layerSeq = 0
let dispatcherInstalled = false

/** How long after leaving a text field an Escape counts as the gamepad's trailing Escape. Matches TRAILING_ESCAPE_WINDOW_MS. */
export const SHIM_TRAILING_ESCAPE_WINDOW_MS = 500

let lastEditingExitAt = 0
let editingExitTrackingInstalled = false

function isEditingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== "string") return false
  const tag = el.tagName.toLowerCase()
  if (tag === "input" || tag === "textarea" || tag === "select") return true
  return el.isContentEditable === true
}

function installEditingExitTracking(): void {
  if (editingExitTrackingInstalled) return
  editingExitTrackingInstalled = true
  // focusout bubbles: record when focus LEAVES an editable target for
  // a non-editable one (tabbing between fields is not an exit).
  document.addEventListener("focusout", (event) => {
    if (!isEditingTarget(event.target)) return
    if (isEditingTarget((event as FocusEvent).relatedTarget)) return
    lastEditingExitAt = Date.now()
  })
  // Re-entering a text field retires any pending trailing Escape:
  // the next Escape is a fresh press (exit editing), not the tail
  // of the earlier blur.
  document.addEventListener("focusin", (event) => {
    if (isEditingTarget(event.target)) lastEditingExitAt = 0
  })
}

/** True when an Escape arriving now is the trailing Escape after a B-blur out of a text field. */
export function isFreshEditingExit(now: number = Date.now()): boolean {
  return (
    lastEditingExitAt > 0 &&
    now - lastEditingExitAt >= 0 &&
    now - lastEditingExitAt <= SHIM_TRAILING_ESCAPE_WINDOW_MS
  )
}

function modalOrMenuOpen(): boolean {
  if (typeof document === "undefined") return false
  if (document.querySelector("dialog[open]")) return true
  try {
    if (document.querySelector("[popover]:popover-open")) return true
  } catch {
    // No popover support: nothing to check.
  }
  // Plain-element modal overlays (ProfilePicker) carry data-nylah-dialog.
  const overlay = document.querySelector("[data-nylah-dialog]:not([hidden])")
  if (overlay && (overlay as HTMLElement).getClientRects().length > 0) return true
  if (document.getElementById(TITLE_CONTEXT_MENU_ID)) return true
  if (document.getElementById(POSTER_MENU_ID)) return true
  return false
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return
  // A menu/dialog handler already consumed this press (poster-menu
  // preventDefaults its Escape; the settings search input
  // preventDefaults its clear-text Escape): exactly one step.
  if (event.defaultPrevented) return
  // The gamepad layer blurs a text field and then dispatches a
  // trailing Escape: that press already did its one step (exit
  // editing). Swallow it so it cannot also navigate/clear.
  if (isFreshEditingExit()) return
  // A modal dialog, popover or open menu owns B; native dialog
  // cancel and the menu handlers close them. Layers stay dormant
  // so a dialog can never be closed twice by one press.
  if (modalOrMenuOpen()) return
  const ordered = [...layers].sort(
    (a, b) => b.priority - a.priority || b.seq - a.seq,
  )
  for (const layer of ordered) {
    let active: boolean
    try {
      active = layer.isActive()
    } catch {
      active = false
    }
    if (!active) continue
    event.preventDefault()
    event.stopPropagation()
    try {
      layer.handle()
    } catch {
      // A throwing layer must not break later presses.
    }
    return
  }
}

function installDispatcher(): void {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  installEditingExitTracking()
  // Bubble phase, deliberately: capture-phase menu/dialog handlers
  // run first and preventDefault when they consume the press.
  document.addEventListener("keydown", onEscape)
}

/**
 * Register a Back layer. Returns an unregister function. The highest
 * priority active layer owns each Back press; handle() runs exactly
 * once per press.
 */
export function registerBackLayer(layer: BackLayer): () => void {
  if (typeof document !== "undefined") installDispatcher()
  const registered: RegisteredLayer = { ...layer, seq: ++layerSeq }
  layers.push(registered)
  return () => {
    const index = layers.indexOf(registered)
    if (index >= 0) layers.splice(index, 1)
  }
}

// ── Route provenance ──────────────────────────────────────────────

const ORIGIN_STACK_KEY = "rs_route_origin_stack_0110"
const BACK_NAV_FLAG_KEY = "rs_route_back_nav_0110"
const MAX_ORIGIN_STACK = 10

export interface RouteOrigin {
  route: string
  label?: string
}

function originStorage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null
  } catch {
    return null
  }
}

function readOriginStack(): RouteOrigin[] {
  let raw: string | null
  try {
    raw = originStorage()?.getItem(ORIGIN_STACK_KEY) ?? null
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is RouteOrigin =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RouteOrigin).route === "string",
    )
  } catch {
    return []
  }
}

function writeOriginStack(stack: RouteOrigin[]): void {
  try {
    originStorage()?.setItem(ORIGIN_STACK_KEY, JSON.stringify(stack))
  } catch {
    // Provenance is a nicety, never fatal.
  }
}

/** Only same-origin absolute paths are valid origins (never `//evil`, never a full URL). */
export function isValidOriginRoute(route: string): boolean {
  // Same-origin absolute paths only. Backslashes are rejected too:
  // the URL parser treats them as slashes, so "/\evil.example"
  // would resolve as the host-relative "//evil.example".
  return (
    route.startsWith("/") &&
    !route.startsWith("//") &&
    !/[\s\\]/.test(route)
  )
}

function currentPath(): string {
  try {
    return window.location.pathname
  } catch {
    return ""
  }
}

/**
 * Read the current provenance stack (copy). Used by diagnostics and
 * tests; views navigate with navigateBackWithOrigin.
 */
export function readRouteOriginStack(): RouteOrigin[] {
  return readOriginStack()
}

/**
 * Record where the user came from. Pushes onto the provenance stack
 * (consecutive duplicates and the current route are skipped).
 */
export function recordRouteOrigin(origin: RouteOrigin): void {
  if (!isValidOriginRoute(origin.route)) return
  if (origin.route === currentPath()) return
  const stack = readOriginStack()
  const top = stack[stack.length - 1]
  if (top && top.route === origin.route) return
  stack.push({ route: origin.route, label: origin.label })
  writeOriginStack(stack.slice(-MAX_ORIGIN_STACK))
}

/**
 * Record the navigation origin from document.referrer (the usual
 * case on full page loads). No-ops when the referrer is external,
 * empty, or the current page, and when this load IS a Back
 * navigation (the flag navigateBackWithOrigin set) — otherwise
 * Back would ping-pong between the two pages.
 */
export function recordOriginFromReferrer(label?: string): void {
  const storage = originStorage()
  try {
    if (storage?.getItem(BACK_NAV_FLAG_KEY) === "1") {
      storage.removeItem(BACK_NAV_FLAG_KEY)
      return
    }
  } catch {
    // Fall through to the referrer check.
  }
  let referrer: string
  try {
    referrer = document.referrer || ""
  } catch {
    return
  }
  if (!referrer) return
  try {
    const url = new URL(referrer)
    if (url.origin !== window.location.origin) return
    recordRouteOrigin({ route: url.pathname, label })
  } catch {
    // Unparseable referrer: no origin recorded.
  }
}

/**
 * Go back via provenance: pop the origin stack and navigate there,
 * else navigate to the fallback route. Never history.back().
 */
export function navigateBackWithOrigin(fallbackRoute: string): void {
  const stack = readOriginStack()
  const fallback = isValidOriginRoute(fallbackRoute) ? fallbackRoute : "/"
  let target: string | null = null
  while (stack.length > 0) {
    const top = stack.pop() as RouteOrigin
    if (top.route !== currentPath()) {
      target = top.route
      break
    }
  }
  writeOriginStack(stack)
  try {
    originStorage()?.setItem(BACK_NAV_FLAG_KEY, "1")
  } catch {
    // The destination may record a redundant origin; dedupe covers it.
  }
  window.location.assign(target ?? fallback)
}

// ── Logical view ──────────────────────────────────────────────────

let logicalView: string | null = null

/** Declare the screen's logical view (hints + focus scoping). Mirrors to main[data-couch-view] when present. */
export function setLogicalView(view: string): void {
  logicalView = view
  try {
    const main = document.querySelector("main[data-couch-view]")
    if (main) main.setAttribute("data-couch-view", view)
    document.dispatchEvent(
      new CustomEvent("couchhubtv:logical-view", { detail: { view } }),
    )
  } catch {
    // View declaration is a nicety, never fatal.
  }
}

/** The last logical view declared via setLogicalView, if any. */
export function getLogicalView(): string | null {
  return logicalView
}

// ── Controller hints ──────────────────────────────────────────────

let currentHints: HintConfig | null = null

/**
 * Publish the controller hint legend for the current screen state.
 * SHIM: stores the config, mirrors it to
 * html[data-couch-hints-override], and dispatches
 * `couchhubtv:set-hints`. W1's TvButtonHints wiring honours the
 * override at integration; until then the static audited
 * HINT_CONFIGS render. Never build an inline hint bar instead.
 */
export function setControllerHints(config: HintConfig): void {
  currentHints = config
  try {
    document.documentElement.setAttribute(
      "data-couch-hints-override",
      JSON.stringify(config),
    )
    document.dispatchEvent(
      new CustomEvent("couchhubtv:set-hints", { detail: { config } }),
    )
  } catch {
    // Hints are display-only, never fatal.
  }
}

/** The last hints config published via setControllerHints, if any. */
export function getControllerHints(): HintConfig | null {
  return currentHints
}

// ── Keyboard lifecycle ────────────────────────────────────────────

type KeyboardField = HTMLInputElement | HTMLTextAreaElement

let activeKeyboardField: KeyboardField | null = null
let activeKeyboardCommit: (() => void) | null = null

/**
 * Enter text editing for a field (Contract E). SHIM: focuses the
 * field, marks it as the editing target, and remembers the commit
 * callback. W3's implementation additionally mounts the shared
 * on-screen keyboard. Returns a close handle (equivalent to
 * closeCouchKeyboard(false)).
 */
export function openCouchKeyboard(
  input: KeyboardField,
  onCommit?: () => void,
): () => void {
  activeKeyboardField = input
  activeKeyboardCommit = onCommit ?? null
  try {
    input.setAttribute("data-couch-editing", "1")
    if (document.activeElement !== input) input.focus({ preventScroll: true })
    document.dispatchEvent(
      new CustomEvent("couchhubtv:keyboard-open", { detail: { input } }),
    )
  } catch {
    // Focus failure leaves the field usable by pointer/keyboard.
  }
  return () => closeCouchKeyboard(false)
}

/**
 * Leave text editing. When commit is true the onCommit callback
 * given to openCouchKeyboard runs (the view moves focus on to the
 * results); otherwise editing simply ends. Always blurs the field.
 */
export function closeCouchKeyboard(commit: boolean): void {
  const field = activeKeyboardField
  const onCommit = activeKeyboardCommit
  activeKeyboardField = null
  activeKeyboardCommit = null
  try {
    field?.removeAttribute("data-couch-editing")
    if (field && document.activeElement === field) field.blur()
    document.dispatchEvent(
      new CustomEvent("couchhubtv:keyboard-close", { detail: { commit } }),
    )
  } catch {
    // Ignore.
  }
  if (commit) {
    try {
      onCommit?.()
    } catch {
      // A throwing commit must not break later presses.
    }
  }
}

/** The field currently in the keyboard editing lifecycle, if any. */
export function getCouchKeyboardField(): KeyboardField | null {
  return activeKeyboardField
}

// ── Title context menu ────────────────────────────────────────────

export interface TitleContextAction {
  id: string
  label: string
  action: () => void
  disabled?: boolean
}

export const TITLE_CONTEXT_MENU_ID = "xt-title-context-menu"
/** poster-menu.ts's menu id (private there): the Back dispatcher must recognise its menu as open. */
const POSTER_MENU_ID = "xt-poster-menu"

let titleMenuEl: HTMLElement | null = null
let titleMenuAnchor: HTMLElement | null = null
let titleMenuLayerUnregister: (() => void) | null = null

function restoreTitleMenuFocus(): void {
  const anchor = titleMenuAnchor
  titleMenuAnchor = null
  if (anchor && anchor.isConnected) {
    anchor.focus({ preventScroll: true })
  }
}

function onTitleMenuOutside(event: PointerEvent): void {
  if (!titleMenuEl) return
  if (titleMenuEl.contains(event.target as Node)) return
  closeTitleContextMenu()
}

function onTitleMenuKey(event: KeyboardEvent): void {
  if (event.key !== "Escape") return
  // Consume: exactly one step — the shim Back dispatcher skips
  // default-prevented presses, so the page layer cannot also fire.
  event.preventDefault()
  event.stopPropagation()
  closeTitleContextMenu()
  restoreTitleMenuFocus()
}

/** Close the title context menu, if open. Does not move focus (callers that close for a Back press restore focus themselves). */
export function closeTitleContextMenu(): void {
  if (!titleMenuEl) return
  titleMenuEl.remove()
  titleMenuEl = null
  document.removeEventListener("pointerdown", onTitleMenuOutside, true)
  document.removeEventListener("keydown", onTitleMenuKey, true)
  window.removeEventListener("blur", closeTitleContextMenu)
  window.removeEventListener("resize", closeTitleContextMenu)
  window.removeEventListener("scroll", closeTitleContextMenu, true)
  titleMenuLayerUnregister?.()
  titleMenuLayerUnregister = null
}

export function isTitleContextMenuOpen(): boolean {
  return titleMenuEl !== null
}

/**
 * Open the X context menu for a card (Contract F). Actions run the
 * view's existing preference functions. SHIM: renders a
 * poster-menu-styled menu; W2 replaces this with the
 * poster-menu-based implementation at integration.
 */
export function openTitleContextMenu(
  anchor: HTMLElement,
  actions: TitleContextAction[],
): void {
  closeTitleContextMenu()
  if (actions.length === 0) return
  titleMenuAnchor = anchor

  const menu = document.createElement("div")
  menu.id = TITLE_CONTEXT_MENU_ID
  menu.className =
    "fixed z-50 min-w-[12rem] rounded-xl border border-line bg-surface text-fg shadow-2xl " +
    "p-1 flex flex-col gap-0.5 poster-menu-enter"
  menu.setAttribute("role", "menu")

  for (const item of actions) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.setAttribute("role", "menuitem")
    btn.dataset.actionId = item.id
    btn.className =
      "w-full text-left px-3 py-2.5 min-h-11 rounded-lg text-sm " +
      "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-accent " +
      "outline-none transition-colors"
    btn.textContent = item.label
    if (item.disabled) {
      btn.disabled = true
      btn.setAttribute("aria-disabled", "true")
      btn.classList.add("opacity-50")
    } else {
      btn.addEventListener("click", () => {
        closeTitleContextMenu()
        try {
          item.action()
        } catch {
          // A throwing action must not break later presses.
        }
        // The action may have removed the card (e.g. Remove from
        // Favourites re-renders the grid): restore only when the
        // anchor survived and focus has nowhere to go.
        if (
          anchor.isConnected &&
          (!document.activeElement || document.activeElement === document.body)
        ) {
          anchor.focus({ preventScroll: true })
        }
        titleMenuAnchor = null
      })
    }
    menu.appendChild(btn)
  }

  document.body.appendChild(menu)

  // Position beside the anchor, clamped to the viewport (same
  // geometry as poster-menu.ts's anchor branch).
  const margin = 8
  const rect = menu.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const left = Math.min(
    anchorRect.right + 6,
    window.innerWidth - rect.width - margin,
  )
  const top = Math.min(
    anchorRect.top,
    window.innerHeight - rect.height - margin,
  )
  menu.style.left = `${Math.max(margin, left)}px`
  menu.style.top = `${Math.max(margin, top)}px`

  titleMenuEl = menu
  document.addEventListener("pointerdown", onTitleMenuOutside, true)
  document.addEventListener("keydown", onTitleMenuKey, true)
  window.addEventListener("blur", closeTitleContextMenu)
  window.addEventListener("resize", closeTitleContextMenu)
  window.addEventListener("scroll", closeTitleContextMenu, true)

  // Back-layer registration for the W1 coordinator: in shim world
  // the dispatcher skips while the menu element exists (the menu's
  // own Escape handler owns B); at integration this layer owns it.
  titleMenuLayerUnregister = registerBackLayer({
    id: "title-context-menu",
    priority: BACK_PRIORITY.MENU,
    isActive: () => isTitleContextMenuOpen(),
    handle: () => {
      closeTitleContextMenu()
      restoreTitleMenuFocus()
    },
  })

  // Focus the first enabled item so D-pad / keyboard can step through.
  const first = menu.querySelector<HTMLButtonElement>(
    "button[role='menuitem']:not([disabled])",
  )
  first?.focus({ preventScroll: true })
}
