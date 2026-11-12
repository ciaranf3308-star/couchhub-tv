// STUB-FOR-INTEGRATION — DO NOT SHIP. DELETE ON INTEGRATION.
//
// Minimal virtualised-list harness implementing the W2 browser /
// W3 Guide DOM contract: a bounded number of mounted rows, keyed
// row reuse, focus that survives fast movement and EPG-only
// updates. Kept ONLY under tests/. Window math reuses the REAL
// computeVisibleWindow from src/scripts/lib/couch-grid.ts — the
// same helper the production browser uses.
//
// INTEGRATION: delete this file. Point the tests at W2's real
// virtualised browser list and W3's real Guide lists. The real
// lists MUST preserve these semantics (adapt selectors/wiring
// only, never weaken the assertions):
//   - mounted DOM rows stay bounded by
//     ceil(viewportHeight / rowHeight) + 2 * overscanRows,
//     independent of total item count;
//   - rows are keyed: an EPG-only update patches text in place and
//     never resets focus or scroll (focused row element identity
//     is preserved);
//   - focus movement is exact at speed: after N moves the focused
//     key is the Nth item, and the focused row is always mounted;
//   - setItems preserves focus/scroll when the focused key survives.

import { computeVisibleWindow } from "@/scripts/lib/couch-grid";

export interface VirtualListOptions<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** Label rendered in the row (channel / programme name). */
  labelOf: (item: T) => string;
  /** Programme line rendered in the row; EPG updates patch this. */
  programmeOf?: (item: T) => string;
  rowHeight?: number;
  viewportHeight?: number;
  overscanRows?: number;
  /** Explicit select action — the ONLY path that may tune. */
  onSelect?: (item: T) => void;
  onFocusChange?: (item: T) => void;
}

export interface VirtualListHandle<T> {
  root: HTMLElement;
  getItemCount(): number;
  getMountedRowCount(): number;
  getMountedKeys(): string[];
  getFocusedKey(): string | null;
  getFocusedItem(): T | null;
  getScrollTop(): number;
  setScrollTop(px: number): void;
  scrollByRows(rows: number): void;
  moveFocus(delta: number): string | null;
  setFocusedKey(key: string | null, opts?: { focusDom?: boolean }): void;
  /** Explicit select of the focused item (A / Enter). */
  selectFocused(): void;
  setItems(items: readonly T[]): void;
  /**
   * EPG-only update: patch programme text for mounted rows.
   * Never moves focus, never moves scroll, never rebuilds rows.
   */
  applyEpgUpdate(patch: ReadonlyMap<string, string>): void;
  /** Snapshot of browser context for playback-return restore. */
  captureContext(): { focusedKey: string | null; scrollTop: number };
  restoreContext(ctx: { focusedKey: string | null; scrollTop: number }): void;
  destroy(): void;
}

export function mountVirtualList<T>(
  root: HTMLElement,
  opts: VirtualListOptions<T>,
): VirtualListHandle<T> {
  const rowHeight = opts.rowHeight ?? 76;
  const viewportHeight = opts.viewportHeight ?? 600;
  const overscanRows = opts.overscanRows ?? 3;
  let items: readonly T[] = [...opts.items];
  let scrollTop = 0;
  let focusedIndex = items.length > 0 ? 0 : -1;
  let destroyed = false;
  const programmeOverrides = new Map<string, string>();
  // Keyed row reuse: elements survive re-renders while their key
  // stays in the window. Label/programme element refs are cached
  // alongside the row so a re-render never re-queries the DOM.
  const rowByKey = new Map<
    string,
    { row: HTMLElement; label: HTMLElement; programme: HTMLElement }
  >();
  const spacer = document.createElement("div");
  spacer.setAttribute("data-virtual-spacer", "");
  const viewport = document.createElement("div");
  viewport.setAttribute("data-virtual-viewport", "");
  viewport.className = "virtual-viewport";

  root.replaceChildren();
  root.appendChild(spacer);
  root.appendChild(viewport);

  function focusedKey(): string | null {
    return focusedIndex >= 0 && focusedIndex < items.length
      ? opts.keyOf(items[focusedIndex]!)
      : null;
  }

  function render(): void {
    if (destroyed) return;
    spacer.style.height = `${items.length * rowHeight}px`;
    const win = computeVisibleWindow({
      total: items.length,
      columns: 1,
      rowHeight,
      scrollTop,
      viewportHeight,
      overscanRows,
    });
    viewport.style.transform = `translateY(${win.topSpacer}px)`;
    const wanted = new Set<string>();
    const fragment = document.createDocumentFragment();
    const key = focusedKey();
    for (let i = win.startIndex; i < win.endIndex; i++) {
      const item = items[i]!;
      const itemKey = opts.keyOf(item);
      wanted.add(itemKey);
      let entry = rowByKey.get(itemKey);
      if (!entry) {
        const row = document.createElement("div");
        row.setAttribute("data-virtual-row", "");
        row.setAttribute("data-key", itemKey);
        row.tabIndex = 0;
        const label = document.createElement("span");
        label.setAttribute("data-virtual-label", "");
        row.appendChild(label);
        const programme = document.createElement("span");
        programme.setAttribute("data-virtual-programme", "");
        row.appendChild(programme);
        entry = { row, label, programme };
        rowByKey.set(itemKey, entry);
      }
      entry.label.textContent = opts.labelOf(item);
      entry.programme.textContent =
        programmeOverrides.get(itemKey) ?? opts.programmeOf?.(item) ?? "";
      entry.row.classList.toggle("is-focused", itemKey === key);
      entry.row.setAttribute("aria-selected", String(itemKey === key));
      fragment.appendChild(entry.row);
    }
    // Drop elements whose keys left the window.
    for (const [itemKey, entry] of [...rowByKey.entries()]) {
      if (!wanted.has(itemKey)) {
        entry.row.remove();
        rowByKey.delete(itemKey);
      }
    }
    viewport.replaceChildren(fragment);
  }

  function focusDomRow(): void {
    const key = focusedKey();
    if (key === null) return;
    rowByKey.get(key)?.row.focus({ preventScroll: true });
  }

  function ensureFocusedVisible(): void {
    if (focusedIndex < 0) return;
    const firstVisible = Math.floor(scrollTop / rowHeight);
    const visibleCount = Math.max(1, Math.floor(viewportHeight / rowHeight));
    if (focusedIndex < firstVisible) scrollTop = focusedIndex * rowHeight;
    else if (focusedIndex >= firstVisible + visibleCount) {
      scrollTop = (focusedIndex - visibleCount + 1) * rowHeight;
    }
  }

  render();

  return {
    root,
    getItemCount: () => items.length,
    getMountedRowCount: () => viewport.childElementCount,
    getMountedKeys: () =>
      [...viewport.querySelectorAll("[data-virtual-row]")].map(
        (row) => row.getAttribute("data-key") ?? "",
      ),
    getFocusedKey: () => focusedKey(),
    getFocusedItem: () =>
      focusedIndex >= 0 && focusedIndex < items.length ? items[focusedIndex]! : null,
    getScrollTop: () => scrollTop,
    setScrollTop(px: number): void {
      scrollTop = Math.max(0, px);
      render();
    },
    scrollByRows(rows: number): void {
      scrollTop = Math.max(0, scrollTop + rows * rowHeight);
      render();
    },
    moveFocus(delta: number): string | null {
      if (items.length === 0) {
        focusedIndex = -1;
        return null;
      }
      const previousKey = focusedKey();
      const previousScrollTop = scrollTop;
      const base = focusedIndex < 0 ? (delta > 0 ? -1 : 0) : focusedIndex;
      focusedIndex = Math.max(0, Math.min(items.length - 1, base + delta));
      ensureFocusedVisible();
      const nextKey = focusedKey();
      if (
        scrollTop === previousScrollTop &&
        nextKey !== null &&
        rowByKey.has(nextKey)
      ) {
        // The window did not move: a focus-only update. Rows are
        // keyed and stay mounted — only the focus markers change.
        // Rebuilding the window here is exactly the defect the
        // brief calls out (replaceChildren destroying focus).
        if (previousKey !== null && previousKey !== nextKey) {
          const prev = rowByKey.get(previousKey);
          prev?.row.classList.remove("is-focused");
          prev?.row.setAttribute("aria-selected", "false");
        }
        const entry = rowByKey.get(nextKey);
        entry?.row.classList.add("is-focused");
        entry?.row.setAttribute("aria-selected", "true");
        focusDomRow();
      } else {
        render();
        focusDomRow();
      }
      const item = items[focusedIndex]!;
      opts.onFocusChange?.(item);
      return focusedKey();
    },
    setFocusedKey(key: string | null, setOpts?: { focusDom?: boolean }): void {
      focusedIndex =
        key === null ? -1 : items.findIndex((item) => opts.keyOf(item) === key);
      ensureFocusedVisible();
      render();
      if (setOpts?.focusDom !== false) focusDomRow();
    },
    selectFocused(): void {
      if (focusedIndex >= 0 && focusedIndex < items.length) {
        opts.onSelect?.(items[focusedIndex]!);
      }
    },
    setItems(nextItems: readonly T[]): void {
      const previousKey = focusedKey();
      items = [...nextItems];
      // Focus survives when its key survives; otherwise clamp to
      // the nearest surviving index instead of resetting to top
      // when the list merely refreshed around it.
      if (previousKey !== null) {
        const kept = items.findIndex((item) => opts.keyOf(item) === previousKey);
        focusedIndex = kept >= 0 ? kept : items.length > 0 ? 0 : -1;
      } else {
        focusedIndex = -1;
      }
      const maxScroll = Math.max(0, items.length * rowHeight - viewportHeight);
      scrollTop = Math.min(scrollTop, maxScroll);
      render();
    },
    applyEpgUpdate(patch: ReadonlyMap<string, string>): void {
      for (const [key, text] of patch) programmeOverrides.set(key, text);
      // Patch ONLY the programme text nodes of mounted rows. No
      // re-render, no focus move, no scroll move, no row rebuild.
      for (const [key, text] of patch) {
        const entry = rowByKey.get(key);
        if (entry) entry.programme.textContent = text;
      }
    },
    captureContext: () => ({ focusedKey: focusedKey(), scrollTop }),
    restoreContext(ctx: { focusedKey: string | null; scrollTop: number }): void {
      scrollTop = Math.max(0, ctx.scrollTop);
      if (ctx.focusedKey !== null) {
        const kept = items.findIndex((item) => opts.keyOf(item) === ctx.focusedKey);
        if (kept >= 0) focusedIndex = kept;
      }
      render();
      focusDomRow();
    },
    destroy(): void {
      destroyed = true;
      rowByKey.clear();
      root.replaceChildren();
    },
  };
}

/** Upper bound on mounted rows for a virtual list configuration. */
export function virtualRowBound(viewportHeight: number, rowHeight: number, overscanRows: number): number {
  return Math.ceil(viewportHeight / rowHeight) + 2 * overscanRows + 1;
}
