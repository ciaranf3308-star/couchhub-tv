// RedSilk Couch — Guide virtual lists (Live TV 0.11.7, W3).
//
// The Guide's On Now list and By Channel picker used to build one
// DOM button per channel (renderNow / renderChannelList, innerHTML
// over the whole catalogue) — thousands of mounted buttons with a
// 2,000+ channel subscription. This module is the bounded
// replacement: only the visible window plus a controlled overscan
// is ever mounted, rows are stable keyed nodes that survive window
// slides and data refreshes, and rendering is
// requestAnimationFrame-scheduled on scroll.
//
// Two modes, one reconciler:
//
//   - "spacer" — fixed-height rows (On Now, channel picker). A top
//     / bottom spacer pair carries the unmounted height so the
//     scrollbar stays true; the window follows scrollTop through
//     computeVisibleWindow (the same math the EPG grid uses).
//   - "focus-window" — variable-height rows (the Tonight
//     chronological fallback, whose rows carry 0–2 synopsis lines
//     and have no fixed height). A bounded page of rows follows
//     the focused row; the window only slides when focus nears an
//     edge, so focus movement never rebuilds the list.
//
// Keyed reuse is the point: a row node is created once per key and
// moved, never rebuilt, while its key stays in the window — so a
// focused row keeps DOM focus across scroll renders and EPG
// refreshes, and a node holding document focus is never removed
// (it is kept as a single extra node until focus moves on). Row
// CONTENT refreshes only when the data set changes (setItems), not
// on scroll.
//
// Pure math (virtualListWindow / focusWindowForIndex /
// gridRenderSignature) is DOM-free and unit-tested; the DOM
// controller is tested under jsdom. Empty / loading states stay
// owned by the Guide: the controller reports emptiness through
// onEmptyChange and never invents placeholder rows.

import { computeVisibleWindow } from "./couch-grid";

// ── Pure window math ────────────────────────────────────────────

/** Extra rows mounted above/below the viewport in both modes. */
export const GUIDE_VIRTUAL_OVERSCAN_ROWS = 4;

/** Minimum rows a focus window holds (so short lists never page). */
export const GUIDE_FOCUS_WINDOW_MIN_ROWS = 12;

export interface VirtualListWindow {
  /** First mounted item index (inclusive). */
  startIndex: number;
  /** Last mounted item index (exclusive). */
  endIndex: number;
  /** px of unmounted space above the window. */
  topSpacerPx: number;
  /** px of unmounted space below the window. */
  bottomSpacerPx: number;
  /** Total items. */
  total: number;
}

export interface VirtualListWindowInput {
  total: number;
  rowHeightPx: number;
  scrollTopPx: number;
  viewportHeightPx: number;
  overscanRows?: number;
}

/**
 * Which slice of a fixed-height list to mount for a scroll
 * position. Thin wrapper over computeVisibleWindow (columns = 1):
 * visible rows plus overscan, never the whole list.
 */
export function virtualListWindow(
  input: VirtualListWindowInput,
): VirtualListWindow {
  const win = computeVisibleWindow({
    total: input.total,
    columns: 1,
    rowHeight: input.rowHeightPx,
    scrollTop: input.scrollTopPx,
    viewportHeight: input.viewportHeightPx,
    overscanRows: input.overscanRows ?? GUIDE_VIRTUAL_OVERSCAN_ROWS,
  });
  return {
    startIndex: win.startIndex,
    endIndex: win.endIndex,
    topSpacerPx: win.topSpacer,
    bottomSpacerPx: win.bottomSpacer,
    total: input.total,
  };
}

export interface FocusWindowInput {
  total: number;
  /** Index that must be mounted (usually the focused row). */
  focusIndex: number;
  /** Rows the window holds. */
  windowSize: number;
  /** Rows of margin before the window slides. */
  overscanRows?: number;
  /** Current window start, or null when no window exists yet. */
  currentStart: number | null;
}

export interface FocusWindow {
  startIndex: number;
  endIndex: number;
}

/**
 * The focus window for a variable-height list. Sticky: the current
 * window is kept while the focus index sits inside its comfortable
 * zone ([start + overscan, end - overscan)), so ordinary focus
 * movement never rebuilds anything; the window only slides when
 * focus crosses the margin, landing with `overscanRows` of room
 * ahead of it. The window always contains focusIndex.
 */
export function focusWindowForIndex(input: FocusWindowInput): FocusWindow {
  const total = Math.max(0, Math.floor(input.total));
  const windowSize = Math.max(
    1,
    Math.min(total === 0 ? 1 : total, Math.floor(input.windowSize)),
  );
  if (total === 0) return { startIndex: 0, endIndex: 0 };
  const focus = Math.max(0, Math.min(total - 1, Math.floor(input.focusIndex)));
  const overscan = Math.max(0, Math.floor(input.overscanRows ?? GUIDE_VIRTUAL_OVERSCAN_ROWS));
  const maxStart = Math.max(0, total - windowSize);
  const clampStart = (start: number): number =>
    Math.max(0, Math.min(maxStart, start));
  if (input.currentStart !== null) {
    const start = clampStart(Math.floor(input.currentStart));
    const end = Math.min(total, start + windowSize);
    if (focus >= start + overscan && focus < end - overscan) {
      return { startIndex: start, endIndex: end };
    }
    // Focus is inside the window but in the margin, or outside it:
    // slide only as far as needed to restore the margin.
    if (focus < start + overscan) {
      const next = clampStart(focus - overscan);
      return { startIndex: next, endIndex: Math.min(total, next + windowSize) };
    }
    const next = clampStart(focus + overscan - windowSize + 1);
    return { startIndex: next, endIndex: Math.min(total, next + windowSize) };
  }
  const start = clampStart(focus - overscan);
  return { startIndex: start, endIndex: Math.min(total, start + windowSize) };
}

/**
 * How many rows a focus window should hold for a viewport: the
 * estimated visible count plus overscan on both sides, never fewer
 * than GUIDE_FOCUS_WINDOW_MIN_ROWS.
 */
export function focusWindowSize(
  viewportHeightPx: number,
  estimatedRowHeightPx: number,
  overscanRows: number = GUIDE_VIRTUAL_OVERSCAN_ROWS,
): number {
  const estimated = Math.max(1, estimatedRowHeightPx);
  const visible = Math.ceil(Math.max(0, viewportHeightPx) / estimated);
  return Math.max(
    GUIDE_FOCUS_WINDOW_MIN_ROWS,
    visible + 2 * Math.max(0, overscanRows),
  );
}

/**
 * Render signature for the EPG grid: the grid rebuilds its rows
 * only when this changes, so scroll frames that land in the same
 * row window at the same horizontal offset (same day, same data
 * revision, same selection) skip the innerHTML rebuild entirely
 * and only the nowline moves. Horizontal scroll always changes
 * the signature — the time window (which cells mount) depends on
 * it exactly, so it must never be bucketed away.
 */
export function gridRenderSignature(input: {
  startRow: number;
  endRow: number;
  scrollLeftPx: number;
  viewportWidthPx: number;
  dayStartMs: number;
  revision: number;
  selectedKey: string | null;
  channelCount: number;
}): string {
  return [
    input.startRow,
    input.endRow,
    input.scrollLeftPx,
    input.viewportWidthPx,
    input.dayStartMs,
    input.revision,
    input.channelCount,
    input.selectedKey ?? "",
  ].join("|");
}

// ── Focus preservation ──────────────────────────────────────────

/** data-focus-key of the focused element inside `container`, or null. */
export function captureGuideFocus(container: Element): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (!container.contains(active)) return null;
  return active.getAttribute("data-focus-key");
}

/** Focus the element with `key` inside `container` (no scrolling). */
export function restoreGuideFocus(container: Element, key: string | null): boolean {
  if (!key) return false;
  const target = container.querySelector(
    `[data-focus-key="${CSS.escape(key)}"]`,
  );
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/**
 * Run `render`, then restore focus to the same data-focus-key when
 * focus was inside `container` before the render and the keyed node
 * still exists afterwards. Focus outside the container is untouched.
 */
export function preserveGuideFocus<T>(container: Element, render: () => T): T {
  const key = captureGuideFocus(container);
  const result = render();
  if (key) restoreGuideFocus(container, key);
  return result;
}

/** First row child's measured height, or null when unmeasurable (jsdom / empty). */
export function measureRowHeight(container: Element): number | null {
  const first = container.querySelector("[data-guide-row], [data-guide-channel-pick]");
  if (!(first instanceof HTMLElement)) return null;
  const height = first.offsetHeight;
  return height > 0 ? height : null;
}

// ── DOM virtual list ────────────────────────────────────────────

export interface VirtualListOptions<T> {
  /** Scroll container OWNED by the list (its children are managed). */
  container: HTMLElement;
  mode: "spacer" | "focus-window";
  /** Fixed row height (spacer mode) / height estimate (focus-window). */
  rowHeightPx: number;
  overscanRows?: number;
  /** Stable key per item. Must equal the row node's data-focus-key (focus preservation keys off it). */
  keyOf: (item: T, index: number) => string;
  /**
   * Build or refresh a row node. When `existing` is a node for the
   * same key, update it in place and return it (node identity —
   * and focus — must survive); when null, create the node. The
   * returned node must carry data-focus-key equal to the key.
   */
  renderRow: (item: T, index: number, existing: HTMLElement | null) => HTMLElement;
  /** Called whenever the list transitions between empty / non-empty. */
  onEmptyChange?: (isEmpty: boolean) => void;
}

export interface VirtualListHandle<T> {
  setItems(items: readonly T[], opts?: { resetScroll?: boolean }): void;
  getItems(): readonly T[];
  getWindow(): { startIndex: number; endIndex: number };
  /** Mounted row nodes (spacers excluded). */
  mountedCount(): number;
  indexOfKey(key: string): number;
  ensureIndexVisible(index: number): HTMLElement | null;
  scrollToIndex(index: number): void;
  setRowHeight(px: number): void;
  renderNow(): void;
  destroy(): void;
}

const SPACER_CLASS = "rs-guide-virtual-spacer";

function scheduleFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
  } else {
    setTimeout(callback, 0);
  }
}

export function createVirtualList<T>(
  options: VirtualListOptions<T>,
): VirtualListHandle<T> {
  const container = options.container;
  const overscan = Math.max(0, Math.floor(options.overscanRows ?? GUIDE_VIRTUAL_OVERSCAN_ROWS));
  let rowHeightPx = Math.max(1, options.rowHeightPx);
  let items: readonly T[] = [];
  let destroyed = false;
  let renderQueued = false;
  let focusStart: number | null = null;
  let wasEmpty = true;
  /** Key → mounted node. Nodes are reused, never rebuilt, while in-window. */
  const mounted = new Map<string, HTMLElement>();
  /** The one stale node kept mounted because it holds focus. */
  let pinnedNode: HTMLElement | null = null;

  const topSpacer = document.createElement("div");
  topSpacer.className = SPACER_CLASS;
  topSpacer.setAttribute("aria-hidden", "true");
  const bottomSpacer = document.createElement("div");
  bottomSpacer.className = SPACER_CLASS;
  bottomSpacer.setAttribute("aria-hidden", "true");

  container.replaceChildren();
  if (options.mode === "spacer") {
    container.appendChild(topSpacer);
    container.appendChild(bottomSpacer);
  }

  function viewportHeight(): number {
    return container.clientHeight || 600;
  }

  function currentWindow(): { startIndex: number; endIndex: number; topSpacerPx: number; bottomSpacerPx: number } {
    if (options.mode === "spacer") {
      const win = virtualListWindow({
        total: items.length,
        rowHeightPx,
        scrollTopPx: container.scrollTop,
        viewportHeightPx: viewportHeight(),
        overscanRows: overscan,
      });
      return win;
    }
    const size = focusWindowSize(viewportHeight(), rowHeightPx, overscan);
    const focusedKey = captureGuideFocus(container);
    const focusIndex = focusedKey ? indexOfKey(focusedKey) : -1;
    const anchor = focusIndex >= 0 ? focusIndex : (focusStart ?? 0);
    const win = focusWindowForIndex({
      total: items.length,
      focusIndex: anchor,
      windowSize: size,
      overscanRows: overscan,
      currentStart: focusStart,
    });
    focusStart = win.startIndex;
    return { ...win, topSpacerPx: 0, bottomSpacerPx: 0 };
  }

  function indexOfKey(key: string): number {
    for (let i = 0; i < items.length; i++) {
      if (options.keyOf(items[i]!, i) === key) return i;
    }
    return -1;
  }

  /** Reconcile mounted nodes with the window. `refresh` re-runs renderRow on kept nodes. */
  function renderWindow(refresh: boolean): void {
    if (destroyed) return;
    const win = currentWindow();
    const desired = new Map<string, HTMLElement>();
    for (let i = win.startIndex; i < win.endIndex; i++) {
      const item = items[i]!;
      const key = options.keyOf(item, i);
      const existing = mounted.get(key) ?? null;
      const node =
        existing && !refresh
          ? existing
          : options.renderRow(item, i, existing);
      desired.set(key, node);
      mounted.set(key, node);
    }
    // Drop nodes that left the window — except the node holding
    // focus, which stays mounted (pinned) until focus moves on.
    // Removing a focused node mid-scroll is how focus gets lost.
    const active = document.activeElement;
    for (const [key, node] of [...mounted]) {
      if (desired.has(key)) continue;
      if (node === pinnedNode && node.contains(active as Node)) continue;
      if (node.contains(active as Node)) {
        pinnedNode = node;
        continue;
      }
      node.remove();
      mounted.delete(key);
    }
    if (pinnedNode && !pinnedNode.contains(active as Node)) {
      pinnedNode.remove();
      mounted.delete(pinnedNode.getAttribute("data-focus-key") ?? "");
      pinnedNode = null;
    }
    // Order the window's nodes (appending moves existing nodes;
    // no node is rebuilt to reorder it). A pinned (focused) node is
    // deliberately left where it is — moving it would visibly jump
    // the focused row; it is removed once focus moves on.
    if (options.mode === "spacer") {
      topSpacer.style.height = `${win.topSpacerPx}px`;
      bottomSpacer.style.height = `${win.bottomSpacerPx}px`;
      for (const node of desired.values()) {
        container.insertBefore(node, bottomSpacer);
      }
    } else {
      for (const node of desired.values()) {
        container.appendChild(node);
      }
    }
    const isEmpty = items.length === 0;
    if (isEmpty !== wasEmpty) {
      wasEmpty = isEmpty;
      options.onEmptyChange?.(isEmpty);
    }
  }

  function queueRender(): void {
    if (renderQueued || destroyed) return;
    renderQueued = true;
    scheduleFrame(() => {
      renderQueued = false;
      renderWindow(false);
    });
  }

  /** Scroll-driven slides are rate-limited: a slide swaps rows,
   *  which moves scrollHeight/scrollTop and fires more scroll
   *  events — without a cooldown one wheel gesture cascades
   *  through every page. Focus-driven slides set it too, so the
   *  scrollTop reset after a page turn never slides back. */
  let slideCooldownUntil = 0;
  const SLIDE_COOLDOWN_MS = 200;

  function onScroll(): void {
    if (options.mode === "focus-window" && Date.now() >= slideCooldownUntil) {
      // Wheel / drag scrolling: slide the page when the user
      // reaches an edge. No scrollTop writes here — the swapped
      // rows change scrollHeight and the browser clamps; writing
      // scrollTop would fire another scroll event and cascade.
      const nearBottom =
        container.scrollTop + viewportHeight() >=
        container.scrollHeight - rowHeightPx;
      const nearTop = container.scrollTop <= rowHeightPx;
      const size = focusWindowSize(viewportHeight(), rowHeightPx, overscan);
      if (nearBottom && focusStart !== null && focusStart + size < items.length) {
        focusStart = Math.min(
          items.length - size,
          focusStart + Math.max(1, Math.floor(size / 2)),
        );
        slideCooldownUntil = Date.now() + SLIDE_COOLDOWN_MS;
        renderWindow(false);
        return;
      }
      if (nearTop && focusStart !== null && focusStart > 0) {
        focusStart = Math.max(0, focusStart - Math.max(1, Math.floor(size / 2)));
        slideCooldownUntil = Date.now() + SLIDE_COOLDOWN_MS;
        renderWindow(false);
        return;
      }
    }
    queueRender();
  }

  container.addEventListener("scroll", onScroll, { passive: true });

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => queueRender());
    resizeObserver.observe(container);
  }

  function ensureIndexVisible(index: number): HTMLElement | null {
    if (destroyed || items.length === 0) return null;
    const clamped = Math.max(0, Math.min(items.length - 1, Math.floor(index)));
    if (options.mode === "spacer") {
      const top = clamped * rowHeightPx;
      const bottom = top + rowHeightPx;
      if (top < container.scrollTop) {
        container.scrollTop = Math.max(0, top - overscan * rowHeightPx);
      } else if (bottom > container.scrollTop + viewportHeight()) {
        container.scrollTop = Math.max(
          0,
          bottom - viewportHeight() + overscan * rowHeightPx,
        );
      }
      renderWindow(false);
    } else {
      const size = focusWindowSize(viewportHeight(), rowHeightPx, overscan);
      const win = focusWindowForIndex({
        total: items.length,
        focusIndex: clamped,
        windowSize: size,
        overscanRows: overscan,
        currentStart: focusStart,
      });
      const moved = focusStart !== win.startIndex;
      focusStart = win.startIndex;
      renderWindow(false);
      if (moved) {
        // Put the window's start at the top after a page turn.
        // The cooldown stops the resulting scroll event from
        // sliding the window straight back.
        slideCooldownUntil = Date.now() + SLIDE_COOLDOWN_MS;
        container.scrollTop = 0;
      }
    }
    const key = options.keyOf(items[clamped]!, clamped);
    return mounted.get(key) ?? null;
  }

  return {
    setItems(next: readonly T[], opts: { resetScroll?: boolean } = {}): void {
      if (destroyed) return;
      const focusedKey = captureGuideFocus(container);
      items = next;
      if (opts.resetScroll) {
        container.scrollTop = 0;
        focusStart = null;
      }
      if (options.mode === "focus-window" && focusedKey) {
        // Keep the focused row's page stable across data refreshes.
        const idx = indexOfKey(focusedKey);
        if (idx >= 0) {
          const size = focusWindowSize(viewportHeight(), rowHeightPx, overscan);
          const win = focusWindowForIndex({
            total: items.length,
            focusIndex: idx,
            windowSize: size,
            overscanRows: overscan,
            currentStart: focusStart,
          });
          focusStart = win.startIndex;
        } else {
          focusStart = null;
        }
      }
      renderWindow(true);
      // Spacer mode: a data refresh must not strand scrollTop past
      // the end of a shorter list.
      if (options.mode === "spacer") {
        const maxScroll = Math.max(0, items.length * rowHeightPx - viewportHeight());
        if (container.scrollTop > maxScroll) {
          container.scrollTop = maxScroll;
          renderWindow(false);
        }
      }
      if (focusedKey) restoreGuideFocus(container, focusedKey);
    },
    getItems(): readonly T[] {
      return items;
    },
    getWindow(): { startIndex: number; endIndex: number } {
      const win = currentWindow();
      return { startIndex: win.startIndex, endIndex: win.endIndex };
    },
    mountedCount(): number {
      return mounted.size;
    },
    indexOfKey,
    ensureIndexVisible,
    scrollToIndex(index: number): void {
      if (options.mode === "spacer") {
        const clamped = Math.max(0, Math.min(items.length - 1, Math.floor(index)));
        container.scrollTop = Math.max(0, clamped * rowHeightPx - viewportHeight() / 2);
        renderWindow(false);
      } else {
        ensureIndexVisible(index);
      }
    },
    setRowHeight(px: number): void {
      const next = Math.max(1, Math.floor(px));
      if (next === rowHeightPx) return;
      rowHeightPx = next;
      renderWindow(false);
    },
    renderNow(): void {
      renderWindow(false);
    },
    destroy(): void {
      destroyed = true;
      container.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      mounted.clear();
      pinnedNode = null;
    },
  };
}
