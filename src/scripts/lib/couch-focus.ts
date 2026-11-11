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

const STORAGE_KEY = "rs_couch_focus_memory";
const MOUNT_FLAG = "__rsCouchFocusMounted" as const;

export interface CouchFocusMemory {
  route: string;
  rail: string;
  index: number;
  key?: string;
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

/** Scroll a focused item into view; no-op when already visible. */
export function scrollFocusedIntoView(el: HTMLElement): void {
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    // Very old webviews: focus still lands, scroll just doesn't follow.
  }
}

/**
 * Restore the remembered focus for the current route, if any.
 * Only acts when nothing is focused yet (body / null) and no modal is
 * open. Prefers the stable data-couch-key, falls back to rail + index.
 * Returns the focused element, or null when there was nothing to
 * restore. Pure apart from the focus() call itself.
 */
export function restoreCouchFocus(
  doc: Document = document,
): HTMLElement | null {
  const memory = readCouchFocusMemory();
  if (!memory) return null;
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
  if (mem && mem.route === route) {
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
 */
const dialogInvokers = new Map<string, HTMLElement | null>();

export function openCouchDialog(id: string, invoker?: HTMLElement | null): boolean {
  const dlg = document.getElementById(id) as HTMLDialogElement | null;
  if (!dlg) return false;
  dialogInvokers.set(id, invoker ?? (document.activeElement as HTMLElement | null));
  try {
    if (typeof dlg.showModal === "function" && !dlg.open) dlg.showModal();
    else dlg.setAttribute("open", "");
  } catch {
    dlg.setAttribute("open", "");
  }
  const first = dlg.querySelector<HTMLElement>(
    "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])",
  );
  first?.focus({ preventScroll: true });
  return true;
}

/** Close a Couch dialog; focus returns to its invoker. */
export function closeCouchDialog(id: string): boolean {
  const dlg = document.getElementById(id) as HTMLDialogElement | null;
  if (!dlg) return false;
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
