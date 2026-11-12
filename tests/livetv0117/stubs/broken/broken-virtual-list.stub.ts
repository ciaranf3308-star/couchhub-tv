// DELIBERATELY BROKEN — RED-VERIFICATION ONLY. DO NOT SHIP.
//
// Mirrors the virtual-list stub's API but mounts EVERY row and
// resets focus to the first row on any EPG update — the defects
// tests 4 and 14 guard against. Delete on integration.

export interface BrokenVirtualListOptions<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  programmeOf?: (item: T) => string;
}

export interface BrokenVirtualListHandle<T> {
  getItemCount(): number;
  getMountedRowCount(): number;
  getFocusedKey(): string | null;
  getScrollTop(): number;
  moveFocus(delta: number): string | null;
  setScrollTop(px: number): void;
  applyEpgUpdate(patch: ReadonlyMap<string, string>): void;
  destroy(): void;
}

export function mountBrokenVirtualList<T>(
  root: HTMLElement,
  opts: BrokenVirtualListOptions<T>,
): BrokenVirtualListHandle<T> {
  let items: readonly T[] = [...opts.items];
  let focusedKey: string | null = items.length > 0 ? opts.keyOf(items[0]!) : null;
  let scrollTop = 0;
  const viewport = document.createElement("div");
  viewport.setAttribute("data-virtual-viewport", "");
  root.replaceChildren();
  root.appendChild(viewport);

  // BROKEN: renders every item, no windowing at all.
  function renderAll(): void {
    viewport.replaceChildren();
    for (const item of items) {
      const row = document.createElement("div");
      row.setAttribute("data-virtual-row", "");
      row.setAttribute("data-key", opts.keyOf(item));
      row.textContent = opts.labelOf(item);
      viewport.appendChild(row);
    }
  }
  renderAll();

  return {
    getItemCount: () => items.length,
    getMountedRowCount: () => viewport.childElementCount,
    getFocusedKey: () => focusedKey,
    getScrollTop: () => scrollTop,
    moveFocus(delta: number): string | null {
      if (items.length === 0) return null;
      const current = items.findIndex((item) => opts.keyOf(item) === focusedKey);
      const next = Math.max(0, Math.min(items.length - 1, (current < 0 ? 0 : current) + delta));
      focusedKey = opts.keyOf(items[next]!);
      return focusedKey;
    },
    setScrollTop(px: number): void {
      scrollTop = Math.max(0, px);
      renderAll();
    },
    // BROKEN: a full rebuild that resets focus to the first row.
    applyEpgUpdate(_patch: ReadonlyMap<string, string>): void {
      focusedKey = items.length > 0 ? opts.keyOf(items[0]!) : null;
      scrollTop = 0;
      renderAll();
    },
    destroy(): void {
      root.replaceChildren();
    },
  };
}
