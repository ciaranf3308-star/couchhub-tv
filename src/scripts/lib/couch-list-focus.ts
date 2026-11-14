// RedSilk Couch — focus memory + filter persistence for list/grid
// screens (Controller Experience 2.0, 0.11.10, W5).
//
// couch-focus.ts only records focus for [data-nylah-rail] items, and
// the rail model must NOT be applied to grids (its L/R step would
// hijack left/right on a vertical list, and its U/D step moves
// between rails instead of grid rows). Library grids, the Followed
// lists, the Settings home rows and Recently Added therefore keep
// their own per-route memory here: the focused card/control is
// recorded by stable data-couch-key (or element id as a fallback),
// and restored — only when nothing is focused yet — after a detail
// visit or a list re-render. Content loading alone never moves
// focus: restore is a no-op whenever an element already holds it.
//
// Storage-injected pure helpers (record/read) mirror the
// couch-keyboard.ts pattern so tests run without a DOM; the DOM
// helpers degrade silently when storage or elements are missing.
//
// 0.11.14 (§4): restored targets are revealed through couch-focus's
// container-aware scrollFocusedIntoView — the same reveal every
// other focus move uses — instead of a blind scrollIntoView.

import { scrollFocusedIntoView } from "@/scripts/lib/couch-focus.ts"

const FOCUS_PREFIX = "rs_list_focus_v1:"
const FILTER_PREFIX = "rs_list_filter_v1:"

export function listFocusStorageKey(route: string): string {
  return `${FOCUS_PREFIX}${route}`
}

export function listFilterStorageKey(route: string): string {
  return `${FILTER_PREFIX}${route}`
}

/** Record the focused key for a route. `key` is a data-couch-key value, or `id:<element-id>`. */
export function recordListFocus(
  storage: Pick<Storage, "setItem">,
  route: string,
  key: string,
): void {
  if (!key) return
  try {
    storage.setItem(listFocusStorageKey(route), key)
  } catch {
    // Focus memory is a nicety, never fatal.
  }
}

/** Read the recorded focus key for a route, or null. */
export function readListFocus(
  storage: Pick<Storage, "getItem">,
  route: string,
): string | null {
  try {
    return storage.getItem(listFocusStorageKey(route))
  } catch {
    return null
  }
}

/** Persist a list filter choice (e.g. Favourites All/Live/Movies/Series) for a route. */
export function writeListFilter(
  storage: Pick<Storage, "setItem">,
  route: string,
  filter: string,
): void {
  try {
    storage.setItem(listFilterStorageKey(route), filter)
  } catch {
    // Filter memory is a nicety, never fatal.
  }
}

/** Read a persisted filter choice, or `fallback` when absent/unreadable. */
export function readListFilter(
  storage: Pick<Storage, "getItem">,
  route: string,
  fallback: string,
): string {
  try {
    return storage.getItem(listFilterStorageKey(route)) ?? fallback
  } catch {
    return fallback
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null
  } catch {
    return null
  }
}

function cssEscape(value: string): string {
  const css = (
    globalThis as unknown as { CSS?: { escape?: (s: string) => string } }
  ).CSS
  return css && typeof css.escape === "function"
    ? css.escape(value)
    : value.replace(/["\\]/g, "\\$&")
}

/**
 * The memory key for an element: its data-couch-key when present,
 * else `id:<id>` when it has an id, else null.
 */
export function listFocusKeyFor(
  el: Element | null | undefined,
): string | null {
  if (!el) return null
  const key = el.getAttribute("data-couch-key")
  if (key) return key
  const id = (el as HTMLElement).id
  if (id) return `id:${id}`
  return null
}

function resolveListFocusKey(
  root: ParentNode,
  key: string,
): HTMLElement | null {
  if (key.startsWith("id:")) {
    const id = key.slice(3)
    if (!id) return null
    // getElementById only exists on Document; querySelector covers both.
    const doc = root as Document
    if (typeof doc.getElementById === "function") {
      return doc.getElementById(id) as HTMLElement | null
    }
    return root.querySelector<HTMLElement>(`#${cssEscape(id)}`)
  }
  return root.querySelector<HTMLElement>(
    `[data-couch-key="${cssEscape(key)}"]`,
  )
}

function isVisible(el: Element): boolean {
  // jsdom reports zero-size rects for everything; only apply the
  // geometry check when layout information exists.
  if (typeof el.getBoundingClientRect === "function") {
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) {
      try {
        return getComputedStyle(el).visibility !== "hidden"
      } catch {
        return true
      }
    }
    // Zero-size in a real browser means hidden; in jsdom it means
    // "no layout". Distinguish via offsetParent where available.
    if (typeof document !== "undefined") {
      const htmlEl = el as HTMLElement
      if (htmlEl.offsetParent === null && htmlEl.tagName !== "BODY") {
        // offsetParent is null for fixed-position elements too —
        // only treat as hidden when the element is also display:none.
        try {
          if (getComputedStyle(el).display === "none") return false
        } catch {
          return true
        }
      }
    }
  }
  return true
}

/**
 * Restore the recorded focus for a route, if the recorded element
 * still exists and nothing holds focus yet. Returns the focused
 * element, or null. Never moves focus away from a focused element,
 * never targets a hidden one.
 */
export function restoreListFocus(
  doc: Document,
  route: string,
  root: ParentNode = doc,
): HTMLElement | null {
  const store = sessionStore()
  if (!store) return null
  const key = readListFocus(store, route)
  if (!key) return null
  const active = doc.activeElement as HTMLElement | null
  if (active && active !== doc.body) return null
  const target = resolveListFocusKey(root, key)
  if (!target || !target.isConnected || !isVisible(target)) return null
  try {
    target.focus({ preventScroll: true })
    scrollFocusedIntoView(target)
  } catch {
    try {
      target.focus()
    } catch {
      return null
    }
  }
  return target
}

/**
 * Mount list focus memory for a container: records the focused
 * key on focusin, and attempts one restore on the next frame (for
 * content already rendered). Views with async data call
 * restoreListFocus themselves after each render — it is a no-op
 * whenever focus already sits somewhere live. Returns an unmount
 * function.
 */
export function initListFocusMemory(
  container: ParentNode,
  route: string,
): () => void {
  const store = sessionStore()
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target as Element | null
    if (!target || !store) return
    const key = listFocusKeyFor(target)
    if (key) recordListFocus(store, route, key)
  }
  const target = container as unknown as EventTarget
  target.addEventListener("focusin", onFocusIn as EventListener)
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      try {
        const doc =
          (container as unknown as { ownerDocument?: Document })
            .ownerDocument ?? document
        restoreListFocus(doc, route, container)
      } catch {
        // Restore is best-effort.
      }
    })
  }
  return () => {
    target.removeEventListener("focusin", onFocusIn as EventListener)
  }
}

// ── Focus preservation across re-renders ──────────────────────────
// Background refreshes (Followed episode checks) re-render lists
// wholesale. Focus must never be stolen by a re-render: capture the
// focused control's stable key before replacing children, restore
// it after — exact control first, else the first surviving control
// in the same card (same key prefix up to the last ":" segment),
// else leave focus alone entirely.

/**
 * Capture the focused control's key, when focus sits inside one of
 * the given containers. Returns null when focus is elsewhere.
 */
export function captureFocusKeyWithin(
  doc: Document,
  containers: ReadonlyArray<ParentNode | null | undefined>,
): string | null {
  const active = doc.activeElement as HTMLElement | null
  if (!active) return null
  for (const container of containers) {
    if (!container) continue
    if (
      container === active ||
      (typeof (container as Element).contains === "function" &&
        (container as Element).contains(active))
    ) {
      return listFocusKeyFor(active)
    }
  }
  return null
}

function findByFocusKey(root: ParentNode, key: string): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>("[data-couch-key]")
  for (const candidate of candidates) {
    if (candidate.getAttribute("data-couch-key") === key) return candidate
  }
  return null
}

/**
 * Restore focus after a re-render: the exact recorded control when
 * it survived, else the first surviving control sharing the card
 * prefix (key up to the last ":"), else nothing. Only acts when
 * focus was lost to the body — never pulls focus away from a live
 * element. Returns true when focus moved.
 */
export function restoreFocusKeyWithin(
  doc: Document,
  key: string | null,
  root: ParentNode = doc,
): boolean {
  if (!key) return false
  const active = doc.activeElement as HTMLElement | null
  if (active && active !== doc.body) return false
  const exact = findByFocusKey(root, key)
  if (exact) {
    exact.focus({ preventScroll: true })
    scrollFocusedIntoView(exact)
    return true
  }
  const cardPrefix = key.slice(0, key.lastIndexOf(":") + 1)
  if (cardPrefix && cardPrefix !== key) {
    const candidates = root.querySelectorAll<HTMLElement>("[data-couch-key]")
    for (const candidate of candidates) {
      const candidateKey = candidate.getAttribute("data-couch-key") ?? ""
      if (candidateKey.startsWith(cardPrefix)) {
        candidate.focus({ preventScroll: true })
        scrollFocusedIntoView(candidate)
        return true
      }
    }
  }
  return false
}

/**
 * §24 grid counterpart of couch-focus's withPreservedFocus: run a
 * list/grid re-render without stealing or losing focus. Captures
 * the focused control's key (when focus sits inside one of
 * `containers`), runs `mutate`, then restores the exact control —
 * else the first surviving control in the same card — only when
 * focus was lost to the body. The mutation's return value passes
 * through; a throwing mutation still restores focus before the
 * error propagates. W5's Series/Movies grid homes wrap shelf
 * refreshes in this (rail shelves use withPreservedFocus).
 */
export function withPreservedListFocus<T>(
  doc: Document,
  containers: ReadonlyArray<ParentNode | null | undefined>,
  mutate: () => T,
): T {
  const key = captureFocusKeyWithin(doc, containers)
  try {
    return mutate()
  } finally {
    if (key) restoreFocusKeyWithin(doc, key)
  }
}
