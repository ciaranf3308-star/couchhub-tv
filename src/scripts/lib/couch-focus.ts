// RedSilk Couch — ONE focus/navigation layer (W1 shared system).
//
// Extends src/scripts/lib/gamepad.ts; it does NOT replace it and does
// not change gamepad.ts behaviour (no gamepad.ts edit was needed: this
// layer hooks the same DOM events the rail model already emits).
// It aligns with the existing contract — sections
// `section[data-nylah-rail]` + focusables `a[data-nylah-item]` — and
// adds what the Couch screens need on top:
//
//   - focus MEMORY per route (sessionStorage): returning from a
//     detail/playback page restores the selected card, by stable
//     `data-couch-key` when the card has one, else by rail + index.
//   - scroll focused items into view (scrollIntoView "nearest" is a
//     no-op when already visible, so manual scrolling is never fought).
//   - focus is NEVER moved just because content loaded; it moves only
//     when the focused target disappears from the DOM, and then to the
//     nearest surviving sibling in the same rail.
//   - no invisible focus: restoration only targets visible elements,
//     and only when nothing is focused yet (body / null).
//   - no focus trapped in inactive panels: replacement search skips
//     hidden elements and falls back to the top nav.
//   - controller reconnection (gamepadconnected) must NOT reset the
//     UI: this module deliberately installs NO gamepadconnected
//     handler that touches focus — gamepad.ts's own handler only
//     (re)starts its poll loop.
//   - modal awareness delegates to dialog-spatial-nav.ts: while a
//     modal is open, restoration and replacement never pull focus out
//     of it (see findOpenModal).

import { findOpenModal } from "@/scripts/lib/dialog-spatial-nav.js";
import {
  BACK_PRIORITY,
  registerBackLayer,
} from "@/scripts/lib/back-handler.js";
import {
  drawerContaining,
  setCurrentNavigationView,
} from "@/scripts/lib/navigation-ownership.ts";

const STORAGE_KEY = "rs_couch_focus_memory";
const MOUNT_FLAG = "__rsCouchFocusMounted" as const;

export interface CouchFocusMemory {
  route: string;
  rail: string;
  index: number;
  key?: string;
  /**
   * Logical view the memory belongs to (Controller 2.0, §39), e.g.
   * "movies-home" vs "movies-browse" — same pathname, different
   * visible content. Optional for backward compatibility: memory
   * without a view restores as before. When present, restoration
   * only happens while the same logical view is current, so Home
   * focus is never restored into a hidden Browse view or vice versa.
   */
  view?: string;
}

// ── Logical view (§39) ──────────────────────────────────────────────
// Module state, set by the page/mode owner on mount and on every mode
// switch (setLogicalView). Full-page Astro navigations reset it to ""
// (unset) until the new page's owner sets it — memory recorded while
// unset carries no view and restores under the legacy rules.

let logicalView = "";

/** Name the logical view currently on screen (mode switches included). */
export function setLogicalView(view: string): void {
  logicalView = typeof view === "string" ? view : "";
  // 0.11.14 (§2): the navigation-ownership registry keys off the
  // same name, so a view that names itself here gets its movement
  // kind (rail / grid / mixed / …) with no second registration.
  setCurrentNavigationView(logicalView);
}

/** The current logical view, or "" when no owner has named one. */
export function getLogicalView(): string {
  return logicalView;
}

/** True when the memory belongs to the current logical view (or to no view). */
function viewMatches(memory: CouchFocusMemory): boolean {
  if (!memory.view) return true;
  return memory.view === logicalView;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Record the focused rail item for the current route. Pure-ish (storage only). */
export function recordCouchFocus(memory: CouchFocusMemory): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage full / unavailable: focus memory is a nicety, never fatal.
  }
}

/** Read the stored focus memory, or null when absent/malformed. Pure. */
export function readCouchFocusMemory(): CouchFocusMemory | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CouchFocusMemory>;
    if (
      typeof parsed.route !== "string" ||
      typeof parsed.rail !== "string" ||
      typeof parsed.index !== "number" ||
      !Number.isFinite(parsed.index)
    ) {
      return null;
    }
    const index = Math.max(0, Math.floor(parsed.index));
    return {
      route: parsed.route,
      rail: parsed.rail,
      index,
      key: typeof parsed.key === "string" ? parsed.key : undefined,
      view: typeof parsed.view === "string" && parsed.view ? parsed.view : undefined,
    };
  } catch {
    return null;
  }
}

export function clearCouchFocusMemory(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

function cssEscape(value: string): string {
  // Call through the CSS object: a destructured CSS.escape is
  // unbound and throws in jsdom ("called on an object that is not a
  // valid instance of CSS").
  const css = (globalThis as unknown as { CSS?: { escape?: (s: string) => string } }).CSS;
  return css && typeof css.escape === "function"
    ? css.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

/** Visible focusables of a rail, in DOM order (the gamepad.ts contract). */
export function couchRailItems(rail: Element): HTMLElement[] {
  const marked = Array.from(
    rail.querySelectorAll<HTMLElement>("[data-nylah-item]"),
  ).filter(isVisible);
  if (marked.length > 0) return marked;
  return Array.from(
    rail.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
  ).filter(isVisible);
}

// ── §4 container-aware scrolling (0.11.14) ─────────────────────────
// The old implementation called el.scrollIntoView({block:"nearest"})
// and let the browser pick the containers. That scrolls the whole
// document while the user moves inside a separately scrollable
// panel, parks focus under the sticky header / hint bar, and gives
// no control over which container moves. The replacement walks the
// element's OWN scrollable ancestors nearest-first, moves each one
// only by the amount the element is clipped within it, and stops:
// no movement when already fully visible, never the wrong
// direction, focus untouched (callers focus with preventScroll).
// The sticky top nav and the fixed hint pill are clearance only
// when the document itself scrolls — inner panels get a small
// padding instead, so a shelf never jumps for chrome that does not
// overlap it. The chain stops at a modal dialog / drawer boundary:
// content behind an overlay is never scrolled.

export interface ScrollRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ScrollClearance {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const SCROLL_PADDING_PX = 4;

/**
 * Minimal scroll offsets that reveal `elRect` fully inside the
 * container's visible rect, or null when it is already fully
 * visible. Pure: every input is a number, so the "never scroll the
 * wrong direction / never move when visible" rules are unit-tested
 * without a DOM. `containerRect` must already be inset by whatever
 * clearance applies (sticky header / hint bar). An element taller
 * (or wider) than the visible area aligns to its leading edge.
 */
export function computeScrollAdjustment(
  elRect: ScrollRect,
  containerRect: ScrollRect,
  current: { scrollTop: number; scrollLeft: number },
  max: { scrollTop: number; scrollLeft: number },
): { scrollTop: number; scrollLeft: number } | null {
  let { scrollTop, scrollLeft } = current;
  let moved = false;
  const clamp = (value: number, limit: number): number =>
    Math.max(0, Math.min(value, Math.max(0, limit)));
  // Vertical: only the clipped side moves, only by the clipped amount.
  if (elRect.top < containerRect.top) {
    scrollTop = clamp(scrollTop - (containerRect.top - elRect.top), max.scrollTop);
    moved = true;
  } else if (elRect.bottom > containerRect.bottom) {
    scrollTop = clamp(scrollTop + (elRect.bottom - containerRect.bottom), max.scrollTop);
    moved = true;
  }
  if (elRect.left < containerRect.left) {
    scrollLeft = clamp(scrollLeft - (containerRect.left - elRect.left), max.scrollLeft);
    moved = true;
  } else if (elRect.right > containerRect.right) {
    scrollLeft = clamp(scrollLeft + (elRect.right - containerRect.right), max.scrollLeft);
    moved = true;
  }
  if (!moved) return null;
  return { scrollTop, scrollLeft };
}

function overflowIsScrollable(value: string): boolean {
  return value === "auto" || value === "scroll";
}

function elementScrolls(el: Element): boolean {
  try {
    const style = getComputedStyle(el);
    const html = el as HTMLElement;
    const vertical =
      overflowIsScrollable(style.overflowY) &&
      html.scrollHeight > html.clientHeight;
    const horizontal =
      overflowIsScrollable(style.overflowX) &&
      html.scrollWidth > html.clientWidth;
    return vertical || horizontal;
  } catch {
    return false;
  }
}

/** Scrollable ancestors of `el`, nearest first, stopping at a modal/drawer boundary. */
export function scrollableAncestors(el: Element): Element[] {
  const chain: Element[] = [];
  const doc = el.ownerDocument ?? document;
  const scrollingElement = doc.scrollingElement ?? doc.documentElement;
  let node: Element | null = el.parentElement;
  while (node) {
    // The document scrolling element scrolls with overflow:visible
    // (the viewport itself scrolls), so size alone decides there.
    const isDocument = node === scrollingElement;
    const html = node as HTMLElement;
    const documentScrolls =
      isDocument &&
      (html.scrollHeight > html.clientHeight ||
        html.scrollWidth > html.clientWidth);
    if (documentScrolls || elementScrolls(node)) chain.push(node);
    // Never scroll anything above an overlay boundary.
    const tag = node.tagName.toLowerCase();
    if (
      (tag === "dialog" && (node as HTMLDialogElement).open) ||
      node.hasAttribute("data-nylah-dialog") ||
      node.hasAttribute("data-browse-filter-drawer") ||
      node.hasAttribute("data-browse-category-drawer") ||
      node.hasAttribute("data-category-drawer") ||
      node.hasAttribute("data-drawer-root")
    ) {
      break;
    }
    node = node.parentElement;
  }
  return chain;
}

/**
 * Viewport clearance for document-level scrolling: the sticky top
 * nav's height at the top, the fixed hint pill's footprint at the
 * bottom. Measured from the live DOM (0 when the chrome is absent,
 * hidden, or not fixed/sticky), never hardcoded — the values are
 * what the focused item must clear, as rendered.
 */
export function measureViewportClearance(
  doc: Document = document,
): { top: number; bottom: number } {
  let top = 0;
  let bottom = 0;
  try {
    const win = doc.defaultView;
    if (!win) return { top, bottom };
    const nav = doc.querySelector("[data-couch-nav]");
    if (nav) {
      const style = win.getComputedStyle(nav);
      const rect = nav.getBoundingClientRect();
      if (
        (style.position === "sticky" || style.position === "fixed") &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      ) {
        top = rect.height;
      }
    }
    const hints = doc.querySelector("[data-button-hints]");
    if (hints && !(hints as HTMLElement).hidden) {
      const style = win.getComputedStyle(hints);
      const rect = hints.getBoundingClientRect();
      if (
        style.position === "fixed" &&
        rect.height > 0 &&
        rect.bottom <= win.innerHeight + 1 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      ) {
        bottom = Math.max(0, win.innerHeight - rect.top);
      }
    }
  } catch {
    // Chrome measurement is best-effort; scrolling still proceeds.
  }
  return { top, bottom };
}

/**
 * Reveal `el` fully inside its owning scroll containers (§4).
 * Nearest container first, minimal movement, sticky-header / hint
 * clearance on document scrolls only. No-op when already visible.
 * Falls back to scrollIntoView("nearest") only when no scrollable
 * ancestor reports layout (e.g. jsdom / no-layout webviews), so
 * focus still lands visibly there.
 */
export function scrollFocusedIntoView(el: HTMLElement): void {
  try {
    const doc = el.ownerDocument ?? document;
    const chain = scrollableAncestors(el);
    if (chain.length === 0) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    const clearance = measureViewportClearance(doc);
    const scrollingElement = doc.scrollingElement ?? doc.documentElement;
    for (const container of chain) {
      const elRect = el.getBoundingClientRect();
      if (elRect.width <= 0 && elRect.height <= 0) return;
      const html = container as HTMLElement;
      const isDocument = container === scrollingElement;
      let visible: ScrollRect;
      if (isDocument) {
        const win = doc.defaultView;
        const height = win ? win.innerHeight : elRect.bottom;
        const width = win ? win.innerWidth : elRect.right;
        visible = {
          top: clearance.top + SCROLL_PADDING_PX,
          bottom: height - clearance.bottom - SCROLL_PADDING_PX,
          left: SCROLL_PADDING_PX,
          right: width - SCROLL_PADDING_PX,
        };
      } else {
        const rect = container.getBoundingClientRect();
        visible = {
          top: rect.top + SCROLL_PADDING_PX,
          bottom: rect.bottom - SCROLL_PADDING_PX,
          left: rect.left + SCROLL_PADDING_PX,
          right: rect.right - SCROLL_PADDING_PX,
        };
      }
      const adjustment = computeScrollAdjustment(
        elRect,
        visible,
        { scrollTop: html.scrollTop, scrollLeft: html.scrollLeft },
        {
          scrollTop: Math.max(0, html.scrollHeight - html.clientHeight),
          scrollLeft: Math.max(0, html.scrollWidth - html.clientWidth),
        },
      );
      if (!adjustment) continue;
      // One assignment per axis: instant, so a held D-pad never
      // chases a smooth scroll that has not settled yet.
      html.scrollTop = adjustment.scrollTop;
      html.scrollLeft = adjustment.scrollLeft;
    }
  } catch {
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      // Very old webviews: focus still lands, scroll just doesn't follow.
    }
  }
}

// ── §24 focus preservation across async refreshes ──────────────────
// W5's AI homes (and any view that re-renders a shelf in place) wrap
// the mutation in withPreservedFocus: focus stays exactly where it
// was when the focused control survives, moves to the nearest
// surviving sibling in the same rail when it does not, and is never
// stolen when it already sits on a live element. Scroll follows the
// restored target through scrollFocusedIntoView. Views that render
// grids should use the couch-list-focus capture/restore pair (or
// withPreservedListFocus there) — same contract, key-based.

interface CapturedFocus {
  key?: string;
  rail?: string;
  index: number;
}

function captureFocusWithin(root: ParentNode): CapturedFocus | null {
  const doc =
    (root as Document).activeElement !== undefined
      ? (root as Document)
      : (root as Element).ownerDocument ?? document;
  const active = doc.activeElement as HTMLElement | null;
  if (!active || active === doc.body) return null;
  if (root instanceof Element ? !root.contains(active) : false) return null;
  if (root === doc && !doc.contains(active)) return null;
  const rail = active.closest?.("[data-nylah-rail]") as HTMLElement | null;
  let index = -1;
  if (rail) index = couchRailItems(rail).indexOf(active);
  return {
    key: active.getAttribute("data-couch-key") ?? undefined,
    rail: rail?.getAttribute("data-nylah-rail") ?? undefined,
    index,
  };
}

function restoreCapturedFocus(
  root: ParentNode,
  captured: CapturedFocus,
): HTMLElement | null {
  const doc =
    (root as Document).activeElement !== undefined
      ? (root as Document)
      : (root as Element).ownerDocument ?? document;
  const active = doc.activeElement as HTMLElement | null;
  // Never steal focus from a live element — only repair a loss.
  if (active && active !== doc.body) return null;
  if (findOpenModal(doc)) return null;
  const scope: ParentNode = root instanceof Element || root instanceof Document ? root : doc;
  let target: HTMLElement | null = null;
  if (captured.key) {
    target = scope.querySelector<HTMLElement>(
      `[data-couch-key="${cssEscape(captured.key)}"]`,
    );
    if (target && !isVisible(target)) target = null;
  }
  if (!target && captured.rail) {
    const rail = scope.querySelector(
      `[data-nylah-rail="${cssEscape(captured.rail)}"]`,
    );
    if (rail) {
      const items = couchRailItems(rail);
      if (items.length > 0) {
        target =
          items[Math.max(0, Math.min(captured.index, items.length - 1))] ??
          items[0];
      }
    }
  }
  if (!target) return null;
  target.focus({ preventScroll: true });
  scrollFocusedIntoView(target);
  return target;
}

/**
 * Run `mutate` (a shelf/list re-render) without stealing or losing
 * focus: capture the focused control first, restore it after —
 * exact key, else same rail + index (clamped), else nothing. The
 * mutation's return value passes through; a throwing mutation still
 * restores focus before the error propagates. Never moves focus
 * when the mutation leaves it on a live element.
 */
export function withPreservedFocus<T>(
  root: ParentNode,
  mutate: () => T,
): T {
  const captured = captureFocusWithin(root);
  try {
    return mutate();
  } finally {
    if (captured) restoreCapturedFocus(root, captured);
  }
}

/** Whether `el` sits inside an open drawer (re-exported seam for views that scroll drawer content). */
export function focusIsInsideDrawer(el: Element | null | undefined): boolean {
  return drawerContaining(el) !== null;
}

/**
 * Restore the remembered focus for the current route, if any.
 * Only acts when nothing is focused yet (body / null) and no modal is
 * open. Prefers the stable data-couch-key, falls back to rail + index.
 * View-aware (§39): memory recorded for another logical view is never
 * restored into this one. Returns the focused element, or null when
 * there was nothing to restore. Pure apart from the focus() call itself.
 */
export function restoreCouchFocus(
  doc: Document = document,
): HTMLElement | null {
  const memory = readCouchFocusMemory();
  if (!memory) return null;
  if (!viewMatches(memory)) return null;
  let route = "";
  try {
    route = doc.defaultView?.location.pathname ?? "";
  } catch {
    route = "";
  }
  if (route !== memory.route) return null;
  if (findOpenModal(doc)) return null;
  const active = doc.activeElement as HTMLElement | null;
  if (active && active !== doc.body) return null;
  const rail = doc.querySelector(
    `[data-nylah-rail="${cssEscape(memory.rail)}"]`,
  );
  if (!rail) return null;
  const items = couchRailItems(rail);
  if (items.length === 0) return null;
  let target: HTMLElement | undefined;
  if (memory.key) {
    target = items.find(
      (item) => item.getAttribute("data-couch-key") === memory.key,
    );
  }
  if (!target) {
    target = items[Math.min(memory.index, items.length - 1)];
  }
  target.focus({ preventScroll: true });
  scrollFocusedIntoView(target);
  return target;
}

/**
 * Find where focus should go when `removed` (the previously focused
 * element, now detached) disappears. A detached element has no
 * ancestors, so its old rail cannot be read off it — the rail + index
 * come from the recorded focus memory (`memory`, defaulting to the
 * stored memory for the current route): the same index in the same
 * rail (clamped to the last surviving item), else the first item of
 * the first visible rail, else the first top-nav link. Never returns
 * a hidden element, never returns the removed element itself.
 */
export function findReplacementFocus(
  removed: Element,
  doc: Document = document,
  memory: CouchFocusMemory | null = null,
): HTMLElement | null {
  if (findOpenModal(doc)) {
    // A modal owns focus; the dialog layer pulls stray focus inside.
    return null;
  }
  const mem = memory ?? readCouchFocusMemory();
  let route = "";
  try {
    route = doc.defaultView?.location.pathname ?? "";
  } catch {
    route = "";
  }
  // View-aware like restoreCouchFocus: memory from another logical
  // view never picks the replacement either.
  if (mem && mem.route === route && viewMatches(mem)) {
    const rail = doc.querySelector(
      `[data-nylah-rail="${cssEscape(mem.rail)}"]`,
    );
    if (rail && rail.isConnected) {
      const items = couchRailItems(rail);
      if (items.length > 0) {
        return items[Math.min(mem.index, items.length - 1)];
      }
    }
  }
  const rails = Array.from(doc.querySelectorAll("[data-nylah-rail]")).filter(
    (candidate) => couchRailItems(candidate).length > 0 && isVisible(candidate),
  );
  for (const candidate of rails) {
    const items = couchRailItems(candidate);
    if (items.length > 0) return items[0];
  }
  const nav = doc.querySelector<HTMLElement>(
    "[data-couch-nav] [data-nylah-item]",
  );
  return nav && isVisible(nav) ? nav : null;
}

/**
 * Open a Couch dialog (native <dialog>, see TvDialog) and remember the
 * invoker so focus returns to it on close. Falls back to the `open`
 * attribute when showModal() is unavailable (jsdom / old webviews).
 * Returns false when no such dialog exists.
 *
 * Controller 2.0 (§38): opening registers a MODAL-priority Back layer
 * for the dialog, so B resolves through the Back coordinator — the
 * dialog closes before anything underneath it backs out, and closing
 * never triggers a second Back (the coordinator stops after one
 * consumed layer). The layer unregisters on close (here, or via the
 * dialog's own close event when it closes natively). A dialog opened
 * with `dismissible: false` still owns B, but swallows it: B does
 * nothing rather than leaking through to the page underneath.
 */
const dialogInvokers = new Map<string, HTMLElement | null>();
const dialogBackLayers = new Map<string, () => void>();

export interface OpenCouchDialogOptions {
  /** False when B must not close the dialog (confirm flows). Default true. */
  dismissible?: boolean;
}

export function openCouchDialog(
  id: string,
  invoker?: HTMLElement | null,
  opts: OpenCouchDialogOptions = {},
): boolean {
  const dlg = document.getElementById(id) as HTMLDialogElement | null;
  if (!dlg) return false;
  dialogInvokers.set(id, invoker ?? (document.activeElement as HTMLElement | null));
  try {
    if (typeof dlg.showModal === "function" && !dlg.open) dlg.showModal();
    else dlg.setAttribute("open", "");
  } catch {
    dlg.setAttribute("open", "");
  }
  // Replace any stale layer from an earlier open that never closed
  // cleanly (a body swap can drop a dialog without firing close).
  dialogBackLayers.get(id)?.();
  dialogBackLayers.delete(id);
  const dismissible = opts.dismissible !== false;
  const unregisterBackLayer = registerBackLayer({
    id: `dialog:${id}`,
    priority: BACK_PRIORITY.MODAL,
    isActive: () => {
      const current = document.getElementById(id);
      return !!current && current.hasAttribute("open");
    },
    handle: () => {
      if (!dismissible) return true;
      return closeCouchDialog(id);
    },
  });
  dialogBackLayers.set(id, unregisterBackLayer);
  // Native close (browser cancel, .close() elsewhere) must also drop
  // the layer; closeCouchDialog does the same on its own path.
  dlg.addEventListener(
    "close",
    () => {
      dialogBackLayers.get(id)?.();
      dialogBackLayers.delete(id);
    },
    { once: true },
  );
  const first = dlg.querySelector<HTMLElement>(
    "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])",
  );
  first?.focus({ preventScroll: true });
  return true;
}

/**
 * Close a Couch dialog; focus returns to its invoker, or to the
 * nearest surviving focus target when the invoker left the DOM while
 * the dialog was open (list refresh) — never to <body>, never to a
 * hidden element, and never by activating anything behind the dialog.
 */
export function closeCouchDialog(id: string): boolean {
  const dlg = document.getElementById(id) as HTMLDialogElement | null;
  if (!dlg) return false;
  dialogBackLayers.get(id)?.();
  dialogBackLayers.delete(id);
  try {
    if (typeof dlg.close === "function" && dlg.open) dlg.close();
    else dlg.removeAttribute("open");
  } catch {
    dlg.removeAttribute("open");
  }
  const invoker = dialogInvokers.get(id);
  dialogInvokers.delete(id);
  if (invoker && invoker.isConnected) {
    invoker.focus({ preventScroll: true });
    return true;
  }
  const replacement = findReplacementFocus(dlg, document);
  if (replacement) {
    replacement.focus({ preventScroll: true });
    scrollFocusedIntoView(replacement);
  }
  return true;
}

/**
 * Seed focus on a cold launch, when nothing is focused yet and there
 * is no stored focus to restore. Focuses the active top-nav link
 * (server-rendered, always present), else the first visible nav
 * item, else the first visible rail item. Returns the focused
 * element, or null when there was nothing to seed (something already
 * focused, a modal open, or no focusable on the page). Without this,
 * A on a cold launch dispatches Enter to <body> and does nothing,
 * and component-scoped key handlers never see the gamepad's
 * synthetic keys at all — the controller looks dead until the user
 * clicks something first. Seeding is a mount-time act only: content
 * loading later never moves focus (see initCouchFocus).
 */
export function seedInitialCouchFocus(
  doc: Document = document,
): HTMLElement | null {
  if (findOpenModal(doc)) return null;
  const active = doc.activeElement as HTMLElement | null;
  if (active && active !== doc.body) return null;
  const candidates: Array<HTMLElement | null> = [
    doc.querySelector<HTMLElement>(
      '[data-couch-nav] [aria-current="page"]',
    ),
    doc.querySelector<HTMLElement>("[data-couch-nav] [data-nylah-item]"),
    ...Array.from(doc.querySelectorAll("[data-nylah-rail]")).flatMap(
      (rail) => couchRailItems(rail),
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.isConnected && isVisible(candidate)) {
      candidate.focus({ preventScroll: true });
      scrollFocusedIntoView(candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * Mount the Couch focus layer. Idempotent. Call once from CouchLayout.
 * Returns an unmount function (mainly for tests).
 *
 * NOTE on gamepadconnected: this layer intentionally does NOT listen
 * for it. gamepad.ts restarts its own poll loop on reconnect and this
 * layer never resets focus, scroll or memory on reconnect — a
 * controller dropping and reconnecting mid-browse changes nothing.
 */
export function initCouchFocus(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const win = window as unknown as Record<string, unknown>;
  if (win[MOUNT_FLAG]) return () => {};
  win[MOUNT_FLAG] = true;

  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target || target === document.body) return;
    const rail = target.closest?.("[data-nylah-rail]") as HTMLElement | null;
    if (!rail) return;
    const items = couchRailItems(rail);
    const at = items.indexOf(target);
    if (at !== -1) {
      const railId = rail.getAttribute("data-nylah-rail") ?? "";
      recordCouchFocus({
        route: window.location.pathname,
        rail: railId,
        index: at,
        key: target.getAttribute("data-couch-key") ?? undefined,
        // View-scoped memory (§39): only when a logical view is
        // current; unset views record legacy view-less memory.
        view: logicalView || undefined,
      });
    }
    scrollFocusedIntoView(target);
  };

  // Focus moves ONLY when the focused target disappears: a removal
  // (route content swap, list refresh) with focus still on the dead
  // node. Content loading alone never moves focus.
  let lastActive: Element | null = null;
  const onFocusInTrack = (event: FocusEvent): void => {
    lastActive = event.target as Element | null;
  };
  const observer = new MutationObserver(() => {
    if (!lastActive || lastActive.isConnected) return;
    if (document.activeElement && document.activeElement !== document.body) {
      // Focus already landed somewhere live; the dead node is moot.
      lastActive = null;
      return;
    }
    const replacement = findReplacementFocus(lastActive, document);
    lastActive = null;
    replacement?.focus({ preventScroll: true });
    if (replacement) scrollFocusedIntoView(replacement);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusin", onFocusInTrack);

  const restore = (): void => {
    // One frame after load so server-rendered rails are laid out.
    requestAnimationFrame(() => {
      // Stored focus first; on a cold launch (no memory) seed the
      // top nav so D-pad / A have a focused element from the first
      // press. seedInitialCouchFocus no-ops when something is
      // already focused or a modal is open.
      if (!restoreCouchFocus(document)) seedInitialCouchFocus(document);
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", restore, { once: true });
  } else {
    restore();
  }

  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusin", onFocusInTrack);
    observer.disconnect();
    delete win[MOUNT_FLAG];
  };
}
