// RedSilk Couch — large-list windowing math (W1 shared system).
//
// TvGrid paints rows with CSS `content-visibility: auto` (browser
// native windowing). JS-rendered grids (screen workers) use the pure
// helpers here to render only the visible window plus overscan rows,
// so a 10,000-item catalogue never builds 10,000 card nodes.

export interface GridWindowOptions {
  /** Total item count. */
  total: number;
  /** Columns in the grid. */
  columns: number;
  /** One row's height in px (card + row gap). */
  rowHeight: number;
  /** Current vertical scroll offset in px. */
  scrollTop: number;
  /** Viewport (scroll container) height in px. */
  viewportHeight: number;
  /** Extra rows rendered above/below the viewport. Default 2. */
  overscanRows?: number;
}

export interface GridWindow {
  /** First rendered item index (inclusive). */
  startIndex: number;
  /** Last rendered item index (exclusive). */
  endIndex: number;
  /** First rendered row. */
  startRow: number;
  /** Last rendered row (inclusive). */
  endRow: number;
  /** px of empty space above the rendered window. */
  topSpacer: number;
  /** px of empty space below the rendered window. */
  bottomSpacer: number;
  /** Total rows in the list. */
  totalRows: number;
}

/** Pure: which slice of a grid to render for a scroll position. */
export function computeVisibleWindow(opts: GridWindowOptions): GridWindow {
  const total = Math.max(0, Math.floor(opts.total));
  const columns = Math.max(1, Math.floor(opts.columns));
  const rowHeight = Math.max(1, opts.rowHeight);
  const overscan = Math.max(0, Math.floor(opts.overscanRows ?? 2));
  const totalRows = Math.ceil(total / columns);
  if (total === 0 || totalRows === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      startRow: 0,
      endRow: -1,
      topSpacer: 0,
      bottomSpacer: 0,
      totalRows: 0,
    };
  }
  const firstVisibleRow = Math.max(
    0,
    Math.floor(Math.max(0, opts.scrollTop) / rowHeight),
  );
  const lastVisibleRow = Math.min(
    totalRows - 1,
    Math.floor(
      (Math.max(0, opts.scrollTop) + Math.max(0, opts.viewportHeight)) /
        rowHeight,
    ),
  );
  const startRow = Math.max(0, firstVisibleRow - overscan);
  const endRow = Math.min(totalRows - 1, lastVisibleRow + overscan);
  return {
    startIndex: startRow * columns,
    endIndex: Math.min(total, (endRow + 1) * columns),
    startRow,
    endRow,
    topSpacer: startRow * rowHeight,
    bottomSpacer: (totalRows - 1 - endRow) * rowHeight,
    totalRows,
  };
}

/** Pure: how many columns fit a container width at a minimum card width. */
export function gridColumnsForWidth(
  containerWidth: number,
  minCardWidth: number,
  gap: number,
): number {
  const width = Math.max(0, containerWidth);
  const card = Math.max(1, minCardWidth);
  const g = Math.max(0, gap);
  if (width <= 0) return 1;
  return Math.max(1, Math.floor((width + g) / (card + g)));
}

// ── 0.11.8 W2 — Browse Everything pagination + keyed page grid ───
// Brief §6.2/§6.3/§1.4. This EXTENDS the shared windowing math
// above; it does not replace it and does not touch
// src/scripts/tv/ui/grid.ts (the TV row-windowed grid keeps its
// own behaviour and tests — see the reuse note in
// browse-everything.ts). The paged grid below ports that grid's
// reuse-pool + focus-pin patterns to a page-bounded renderer:
// only the current page's cards exist as DOM nodes, nodes are
// REUSED by stable key across page/dataset changes, and ordinary
// focus movement never triggers a re-render at all.

/** Page-size bounds (brief §6.2): ~30 posters, 24–36 responsive target. */
export const BROWSE_PAGE_SIZE_MIN = 24;
export const BROWSE_PAGE_SIZE_MAX = 36;
export const BROWSE_PAGE_SIZE_TARGET = 30;

/**
 * Pure: page size for a grid shape — columns × rows, clamped to
 * the 24–36 band. At 1920×1080 a 6-column grid with 5 rows lands
 * exactly on the 30 target. Fewer columns (narrower viewports)
 * still fill whole rows; the clamp keeps a page bounded.
 */
export function pageSizeForGrid(columns: number, rowsPerPage = 5): number {
  const cols = Math.max(1, Math.floor(columns));
  const rows = Math.max(1, Math.floor(rowsPerPage));
  return Math.max(
    BROWSE_PAGE_SIZE_MIN,
    Math.min(BROWSE_PAGE_SIZE_MAX, cols * rows),
  );
}

/** Pure: slice of a result list for one 1-based page. */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const size = Math.max(1, Math.floor(pageSize));
  const p = Math.max(1, Math.floor(page));
  const start = (p - 1) * size;
  if (start >= items.length) return [];
  return items.slice(start, start + size);
}

// ── Keyed page grid (DOM) ────────────────────────────────────────

export interface KeyedPageGridItem {
  /** Stable title-group id — the reuse key. */
  key: string;
  /** Render signature: same key + same signature = node reused untouched. */
  signature: string;
}

export interface KeyedPageGridOptions<T extends KeyedPageGridItem> {
  /** Build a fresh card node for an item. */
  buildCard: (item: T) => HTMLElement;
  /**
   * Update a reused node in place when the key matches but the
   * signature changed. Return true when the node was updated;
   * false rebuilds the card. Omit to always rebuild on signature
   * change (keys still pin focus; nodes just don't update).
   */
  updateCard?: (node: HTMLElement, item: T) => boolean;
  /** Called after a page render settles (for spatial-nav refresh). */
  onRendered?: () => void;
}

export interface KeyedPageGrid<T extends KeyedPageGridItem> {
  /** The grid element (a <div class="rs-grid">). */
  el: HTMLElement;
  /**
   * Render a page. Reconciliation is keyed: nodes whose key
   * survives stay mounted (and untouched when the signature
   * matches); only new/changed nodes are built; removed nodes
   * are detached. Batched on rAF; a newer setPage cancels the
   * pending one (obsolete work on category/page change).
   * Focus movement NEVER calls this — see browse-everything.ts.
   */
  setPage: (items: readonly T[], opts?: { focusKey?: string | null }) => void;
  /** Focus the card for a key, when mounted. Returns true when focused. */
  focusKey: (key: string) => boolean;
  /** Keys currently mounted, in DOM order. */
  mountedKeys: () => string[];
  /** Number of card nodes currently mounted (tests / diagnostics). */
  mountedCount: () => number;
  /** Cancel pending work and remove every node + listener. */
  destroy: () => void;
}

/**
 * Create a page-bounded keyed grid. Only the current page's items
 * are mounted — never the full catalogue as hidden DOM, never
 * artwork preloads for the full set (cards carry loading="lazy"
 * via buildCouchCard). Nodes are reused by key across renders:
 * a page turn that shares titles with the previous page keeps
 * those nodes (and their decoded images) instead of rebuilding.
 * The focused card is pinned: reconciliation never removes the
 * node holding focus when its key survives into the new page.
 */
export function createKeyedPageGrid<T extends KeyedPageGridItem>(
  options: KeyedPageGridOptions<T>,
): KeyedPageGrid<T> {
  const el = document.createElement("div");
  el.className = "rs-grid";
  el.setAttribute("data-browse-page-grid", "");

  const pool = new Map<string, HTMLElement>();
  let pendingItems: readonly T[] | null = null;
  let pendingFocusKey: string | null | undefined;
  let raf = 0;
  let destroyed = false;

  const cancelPending = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    pendingItems = null;
  };

  const renderNow = (items: readonly T[], focusKey?: string | null) => {
    if (destroyed) return;
    const wanted = new Map<string, T>();
    for (const item of items) {
      if (!wanted.has(item.key)) wanted.set(item.key, item);
    }
    // Detach nodes whose key is gone — except the focused node,
    // which stays until focus moves (it is reaped on the next
    // render once it no longer holds focus).
    const active = document.activeElement as HTMLElement | null;
    for (const [key, node] of Array.from(pool)) {
      if (wanted.has(key)) continue;
      if (node === active || node.contains(active)) continue;
      node.remove();
      pool.delete(key);
    }
    // Reconcile in order: reuse, update, or build — then append
    // in page order (appendChild moves existing nodes, so order
    // is corrected without rebuilding).
    const frag = document.createDocumentFragment();
    for (const item of wanted.values()) {
      const existing = pool.get(item.key);
      if (existing) {
        if (existing.dataset.cardSignature !== item.signature) {
          const updated = options.updateCard?.(existing, item) ?? false;
          if (!updated) {
            const replacement = options.buildCard(item);
            replacement.dataset.cardSignature = item.signature;
            existing.replaceWith(replacement);
            pool.set(item.key, replacement);
            frag.appendChild(replacement);
            continue;
          }
          existing.dataset.cardSignature = item.signature;
        }
        frag.appendChild(existing);
      } else {
        const node = options.buildCard(item);
        node.dataset.cardSignature = item.signature;
        pool.set(item.key, node);
        frag.appendChild(node);
      }
    }
    el.appendChild(frag);
    // Reap any focused node that was spared above but is now
    // unfocused and unwanted.
    for (const [key, node] of Array.from(pool)) {
      if (wanted.has(key)) continue;
      if (node === document.activeElement || node.contains(document.activeElement)) continue;
      node.remove();
      pool.delete(key);
    }
    options.onRendered?.();
    if (focusKey) {
      const target = pool.get(focusKey);
      if (target) {
        const focusable =
          target.matches("a[href], button, [tabindex]")
            ? target
            : target.querySelector<HTMLElement>("a[href], button, [tabindex]");
        focusable?.focus({ preventScroll: true });
      }
    }
  };

  const setPage: KeyedPageGrid<T>["setPage"] = (items, opts) => {
    if (destroyed) return;
    pendingItems = items;
    pendingFocusKey = opts?.focusKey;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const next = pendingItems;
      const focusKey = pendingFocusKey;
      pendingItems = null;
      if (next) renderNow(next, focusKey);
    });
  };

  return {
    el,
    setPage,
    focusKey(key: string): boolean {
      const node = pool.get(key);
      if (!node || !node.isConnected) return false;
      const focusable =
        node.matches("a[href], button, [tabindex]")
          ? node
          : node.querySelector<HTMLElement>("a[href], button, [tabindex]");
      if (!focusable) return false;
      focusable.focus({ preventScroll: true });
      return true;
    },
    mountedKeys(): string[] {
      return Array.from(el.children)
        .map((child) => (child as HTMLElement).dataset?.browseKey ?? "")
        .filter(Boolean);
    },
    mountedCount(): number {
      return pool.size;
    },
    destroy(): void {
      destroyed = true;
      cancelPending();
      for (const node of pool.values()) node.remove();
      pool.clear();
      el.remove();
    },
  };
}

