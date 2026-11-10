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
