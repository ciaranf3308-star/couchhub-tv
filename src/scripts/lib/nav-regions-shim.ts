// SHIM-0114 — Navigation-region seam (W3, screens + hints).
//
// TEMPORARY. Integration deletes this file and re-points its two call
// sites at W1's navigation-ownership API (§2/§5 of the 0.11.14 brief).
// Until W1 lands, views that need explicit region ownership declare
// it here instead of inventing their own handlers:
//
//   1. `declareNavOwner(root, ownerId)` — marks the view root with
//      `data-nav-owner="<id>"`. That attribute is the contract shape
//      W1's gamepad layer is expected to read: an owned view's arrows
//      must NOT run the global `data-nylah-rail` model in gamepad.ts
//      (the §2 bug — Discover/Search rows hijacked by Home rails).
//      Today the attribute is declarative only at the gamepad layer;
//      the live behaviour below is the keydown half.
//   2. `installRegionNavigation(root)` — ONE capture-phase keydown
//      listener on the view root that routes ArrowUp/Down/Left/Right
//      between the view's `[data-nav-region]` regions. Capture runs
//      before spatial-navigation's bubble-phase window listener, so a
//      consumed arrow never also moves spatial focus (one press, one
//      move). It deliberately does NOT run while a modal, the
//      on-screen keyboard, a text field, or Cursor Mode owns input
//      (§5 priority) — those owners keep their own handlers.
//
// What this shim is NOT: a second ownership system. It owns no button
// routing (A/B/X/Y/Menu stay with gamepad.ts + the Back coordinator),
// no scrolling engine (it calls the existing scrollIntoView nearest
// discipline; W1's scroll-container selection replaces that call),
// and no focus memory (couch-focus / couch-list-focus stay canonical).
// Pure geometry helpers (pickVerticalTarget / pickHorizontalTarget /
// regionItems) are DOM-testable and SHOULD survive integration —
// only the install/declare wiring is shim.
//
// Every SHIM-0114 marker in this release:
//   - this file (whole module)
//   - DiscoverView.svelte: data-nav-owner / data-nav-region markup +
//     installRegionNavigation call (marked SHIM-0114 in comments)
//   - AllFavoritesView.svelte / AllWatchlistView.svelte: same pattern
//   - TvLivetvHints.astro: NO shim (Cursor Mode branch is permanent)

export type NavDirection = "up" | "down" | "left" | "right";

const ARROW_KEY: Record<NavDirection, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

/** Focusable candidates inside a region (same shape the app uses elsewhere). */
export const REGION_FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), " +
  "select:not([disabled]), textarea:not([disabled]), " +
  "[tabindex]:not([tabindex='-1'])";

function isVisible(el: Element): boolean {
  // Same visibility rule as gamepad.ts / couch-focus.ts: a zero-size
  // rect or a hidden ancestor means "not on screen". jsdom tests stub
  // getBoundingClientRect per element (see tests/nav-regions-0114).
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
 * move falls through to spatial navigation (the caller leaves the
 * event unconsumed). Returns null at the edge or outside a region.
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

function cursorModeActive(doc: Document): boolean {
  // W2's signal (cursor-mode.ts owns html[data-cursor-mode]); read
  // only — the shim never sets it.
  return doc.documentElement.dataset.cursorMode === "active";
}

/**
 * Declare navigation ownership for a view root (SHIM-0114). Sets
 * `data-nav-owner` — the attribute W1's gamepad layer reads to skip
 * the global rail model for this view. Returns a cleanup that removes
 * the attribute (only when it still carries this owner id).
 */
export function declareNavOwner(root: HTMLElement, ownerId: string): () => void {
  root.setAttribute("data-nav-owner", ownerId);
  return () => {
    if (root.getAttribute("data-nav-owner") === ownerId) {
      root.removeAttribute("data-nav-owner");
    }
  };
}

/**
 * Install region-aware arrow routing on a view root (SHIM-0114).
 * Capture-phase: a consumed arrow never reaches spatial navigation.
 * Skips (leaves the event untouched) while a modal, the on-screen
 * keyboard, a text field, or Cursor Mode owns input, and when focus
 * is outside the root. Idempotent per root: installing twice returns
 * the same uninstaller without adding a second listener.
 */
export function installRegionNavigation(root: HTMLElement): () => void {
  const flag = "__shim0114RegionNavInstalled" as const;
  const record = root as unknown as Record<string, unknown>;
  if (record[flag]) return () => {};
  record[flag] = true;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const dir = (Object.keys(ARROW_KEY) as NavDirection[]).find(
      (d) => ARROW_KEY[d] === event.key,
    );
    if (!dir) return;
    const doc = root.ownerDocument ?? document;
    if (modalOpen(doc) || cursorModeActive(doc)) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("[data-osk]")) return;
    if (isEditingTarget(target)) return;
    const active = doc.activeElement as HTMLElement | null;
    if (!active || !root.contains(active)) return;
    const next =
      dir === "up" || dir === "down"
        ? pickVerticalTarget(root, active, dir)
        : pickHorizontalTarget(root, active, dir);
    if (!next || next === active) return;
    event.preventDefault();
    event.stopPropagation();
    next.focus({ preventScroll: true });
    // W1's scroll-container selection replaces this call at
    // integration; until then the existing nearest discipline keeps
    // the focused item visible without fighting manual scroll.
    try {
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      // Very old webviews: focus still lands.
    }
  };

  root.addEventListener("keydown", onKeyDown, true);
  return () => {
    root.removeEventListener("keydown", onKeyDown, true);
    delete record[flag];
  };
}
