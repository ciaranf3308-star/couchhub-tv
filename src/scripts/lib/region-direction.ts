// Region-aware direction handling (W3, 0.11.14 §7).
//
// Views with a structured vertical layout (Discover's search →
// examples → Quick Picks → results, the library filters → grid)
// register a NavigationOwner (navigation-ownership.ts, W1) whose
// handleDirection is built here. The owner runs inside gamepad.ts
// move() AFTER the modal/drawer guards, so this module owns no
// button routing, no keydown listener, and no focus memory — it
// only answers "where does this D-pad press go inside these named
// regions", and falls through (false) wherever another layer owns
// the press.
//
// Yield rules (§5): an editing target or the on-screen keyboard
// owns arrows (the native path dispatches Up/Down while editing, so
// yielding here lets the keyboard layer's keydown handler run);
// a modal owns them too (defense-in-depth — move() already guards).
// Cursor Mode does NOT yield: D-pad keeps driving focus navigation
// while the pointer is up (§6/W2), and this handler only ever sees
// D-pad directions (stick directions route to W2's scroll handler).
// Scrolling uses W1's container-aware scrollFocusedIntoView —
// never a per-view scrollIntoView.
//
// Markup contract: the view marks its regions with
// `[data-nav-region]` in DOM (= visual) order. Regions with no
// visible focusable are skipped.

import { scrollFocusedIntoView } from "@/scripts/lib/couch-focus.ts";
import type {
  NavigationDirection,
  NavigationOwner,
} from "@/scripts/lib/navigation-ownership.ts";

/** Focusable candidates inside a region (same shape the app uses elsewhere). */
export const REGION_FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), " +
  "select:not([disabled]), textarea:not([disabled]), " +
  "[tabindex]:not([tabindex='-1'])";

function isVisible(el: Element): boolean {
  // Same visibility rule as gamepad.ts / couch-focus.ts: a zero-size
  // rect or a hidden ancestor means "not on screen". jsdom tests stub
  // getBoundingClientRect per element (see tests/region-direction-0114).
  if (el.closest("[hidden]")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  try {
    if (getComputedStyle(el).visibility === "hidden") return false;
  } catch {
    // No CSSOM (bare jsdom without a view): the rect check stands.
  }
  return true;
}

/** Visible + region-owned: on-screen keyboard keys are never region
 *  targets — the keyboard lifecycle owns them (§5), and entry is via
 *  the view's own ArrowDown handler. */
function isRegionCandidate(el: Element): boolean {
  if (el.closest("[data-osk], [data-couch-keyboard]")) return false;
  return isVisible(el);
}

/** Visible focusables of a region, in DOM order. */
export function regionItems(region: Element): HTMLElement[] {
  return Array.from(
    region.querySelectorAll<HTMLElement>(REGION_FOCUSABLE_SELECTOR),
  ).filter((el) => isRegionCandidate(el));
}

/** Regions of a view root, in DOM order (= visual order on our screens). */
export function regionsIn(root: Element): HTMLElement[] {
  const found = Array.from(
    root.querySelectorAll<HTMLElement>("[data-nav-region]"),
  );
  if (
    root instanceof HTMLElement &&
    root.hasAttribute("data-nav-region") &&
    !found.includes(root)
  ) {
    found.unshift(root);
  }
  return found.filter((region) => regionItems(region).length > 0);
}

/** The region an element belongs to (nearest ancestor region inside root). */
export function regionOf(el: Element, root: Element): HTMLElement | null {
  let node: Element | null = el;
  while (node && node !== root.parentElement) {
    if (node instanceof HTMLElement && node.hasAttribute("data-nav-region")) {
      return node;
    }
    if (node === root) return null;
    node = node.parentElement;
  }
  return null;
}

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  centerX: number;
  centerY: number;
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    top: r.top,
    bottom: r.bottom,
    left: r.left,
    right: r.right,
    centerX: (r.left + r.right) / 2,
    centerY: (r.top + r.bottom) / 2,
  };
}

/**
 * Vertical target for `active` (§3/§7.3): prefer the adjacent region
 * in that direction, then the nearest column, then the nearest row.
 * Region distance dominates, so Down from a Quick Pick enters the
 * results region instead of jumping to a distant control, and Up
 * reverses through the same regions. Within a region (e.g. the AI
 * result grid) the column term preserves the horizontal position
 * between rows. Returns null when nothing lies in that direction.
 */
export function pickVerticalTarget(
  root: Element,
  active: Element,
  dir: "up" | "down",
): HTMLElement | null {
  const regions = regionsIn(root);
  const activeRegion = regionOf(active, root);
  const activeIndex = activeRegion ? regions.indexOf(activeRegion) : -1;
  const from = rectOf(active);
  let best: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(REGION_FOCUSABLE_SELECTOR),
  ).filter((el) => el !== active && isRegionCandidate(el));
  for (const candidate of candidates) {
    const rect = rectOf(candidate);
    const inDirection =
      dir === "down" ? rect.centerY > from.centerY : rect.centerY < from.centerY;
    if (!inDirection) continue;
    const candidateRegion = regionOf(candidate, root);
    const candidateIndex = candidateRegion
      ? regions.indexOf(candidateRegion)
      : -1;
    // Region distance: same region 0, adjacent 1, further 2+. An
    // element outside any region (e.g. a stray control) counts as
    // adjacent — reachable, but never preferred over a real region.
    let regionDistance: number;
    if (activeIndex === -1 || candidateIndex === -1) {
      regionDistance = candidateRegion === activeRegion ? 0 : 1;
    } else {
      regionDistance = Math.abs(candidateIndex - activeIndex);
    }
    // Wrong-side regions (above when moving down) are unreachable:
    // region order follows visual order, so a lower index is above.
    if (activeIndex !== -1 && candidateIndex !== -1) {
      if (dir === "down" && candidateIndex < activeIndex) continue;
      if (dir === "up" && candidateIndex > activeIndex) continue;
    }
    const columnDistance = Math.abs(rect.centerX - from.centerX);
    const rowDistance = Math.abs(rect.centerY - from.centerY);
    // Cross-region: enter the next region at its nearest edge (row
    // distance first), so Down from any Quick Pick lands on the
    // results toggle rather than skipping it for a same-column card.
    // Same region: preserve the column (grid rows), then the row.
    const sameRegion = candidateRegion === activeRegion;
    const score =
      regionDistance * 100000 +
      (sameRegion
        ? columnDistance * 10 + rowDistance
        : rowDistance * 10 + columnDistance);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * Horizontal target for `active`: same region, same visual row only.
 * Left/Right never crosses into another region — at a row edge the
 * move falls through to the kind's built-in behaviour (the handler
 * returns false). Returns null at the edge or outside a region.
 */
export function pickHorizontalTarget(
  root: Element,
  active: Element,
  dir: "left" | "right",
): HTMLElement | null {
  const region = regionOf(active, root);
  if (!region) return null;
  const from = rectOf(active);
  let best: HTMLElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of regionItems(region)) {
    if (candidate === active) continue;
    const rect = rectOf(candidate);
    // Same visual row: vertical centres overlap the active row band.
    const sameRow =
      rect.centerY >= from.top && rect.centerY <= from.bottom;
    if (!sameRow) continue;
    const inDirection =
      dir === "right" ? rect.centerX > from.centerX : rect.centerX < from.centerX;
    if (!inDirection) continue;
    const distance = Math.abs(rect.centerX - from.centerX);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function isEditingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

function modalOpen(doc: Document): boolean {
  if (doc.querySelector("dialog[open]")) return true;
  try {
    return !!doc.querySelector("[popover]:popover-open");
  } catch {
    return false;
  }
}

/**
 * The `handleDirection` for a region-structured view root. Returns
 * true when the press moved focus inside the root (consumed), false
 * to fall through to the kind's built-in behaviour. Yields while a
 * modal, the on-screen keyboard, or a text field owns input, and
 * when focus is outside the root.
 */
export function createRegionDirectionHandler(
  root: Element,
): NonNullable<NavigationOwner["handleDirection"]> {
  return (dir: NavigationDirection, from: Element): boolean => {
    const doc = root.ownerDocument ?? document;
    if (modalOpen(doc)) return false;
    if (from.closest?.("[data-osk], [data-couch-keyboard]")) return false;
    if (isEditingTarget(from)) return false;
    if (!root.contains(from)) return false;
    const next =
      dir === "up" || dir === "down"
        ? pickVerticalTarget(root, from, dir)
        : pickHorizontalTarget(root, from, dir);
    if (!next || next === from) return false;
    next.focus({ preventScroll: true });
    scrollFocusedIntoView(next);
    return true;
  };
}

/**
 * The `sectionEntry` for a region-structured view root: the sensible
 * target when focus enters the root with nothing focused. Down /
 * Left / Right enter at the first region's first item (the view's
 * starting region — Discover's search, the library filters); Up
 * enters at the last region's first item (the nearest edge from
 * below). Returns null when the root has no region items, so the
 * kind's built-in entry behaviour runs instead.
 */
export function regionSectionEntry(
  root: Element,
): NonNullable<NavigationOwner["sectionEntry"]> {
  return (dir: NavigationDirection): HTMLElement | null => {
    const regions = regionsIn(root);
    if (regions.length === 0) return null;
    const edge = dir === "up" ? regions[regions.length - 1] : regions[0];
    return regionItems(edge)[0] ?? null;
  };
}
