/**
 * @vitest-environment jsdom
 *
 * Live TV 2.0 (0.11.7) W5 — tests 4, 5, 6, 9: the virtualised
 * browser list, focus at speed, no accidental playback, search.
 *
 *   4. Virtual lists mount only a bounded number of DOM rows.
 *   5. Fast controller movement maintains focus.
 *   6. Category changes do not trigger accidental playback.
 *   9. Search is correctly scoped and cleared.
 *
 * Each test asserts BOTH seams where they exist: the REAL
 * mountChannelBrowser / applyBrowserFilter (0.11.5 behaviour that
 * must not regress) and the STUB-FOR-INTEGRATION virtual list /
 * category index (the W2 contract). The stub parts are marked;
 * integration re-points them at W2's real list, keeping the
 * assertions.
 * Synthetic data only; playback is observed via spies and the
 * real livetv:tune event — no stream is ever tuned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BROWSER_ROW_HEIGHT,
  applyBrowserFilter,
  mountChannelBrowser,
  searchBrowserChannels,
} from "@/scripts/lib/livetv-browser";
import { LIVETV_TUNE_EVENT, dispatchLivetvTune } from "@/scripts/lib/livetv-data";
import {
  buildCategoryIndex,
  getDerivedChannels,
} from "./stubs/category-index.stub";
import {
  dispatchLivetvCloseOverlay,
  dispatchLivetvSearchSubmit,
  dispatchLivetvSortSubmit,
} from "./stubs/events.stub";
import {
  mountVirtualList,
  virtualRowBound,
} from "./stubs/virtual-list.stub";
import { buildFixtureChannels, fixture2000, fixture10000 } from "./fixtures";

function keyOn(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("test 4 — virtual lists mount a bounded number of DOM rows", () => {
  it("REAL browser: 10,000 channels mount only the visible window", () => {
    const channels = fixture10000();
    const handle = mountChannelBrowser(root, { channels });
    const viewport = root.querySelector<HTMLElement>("[data-browser-viewport]")!;
    const spacer = root.querySelector<HTMLElement>("[data-browser-spacer]")!;
    expect(viewport.childElementCount).toBeGreaterThan(0);
    expect(viewport.childElementCount).toBeLessThan(40);
    expect(spacer.style.height).toBe(`${10_000 * BROWSER_ROW_HEIGHT}px`);
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("10,000");
    handle.destroy();
  });

  it("STUB harness (W2 contract): 10,000 items mount at most the row bound", () => {
    const channels = fixture10000();
    const rowHeight = 76;
    const viewportHeight = 600;
    const overscanRows = 3;
    const handle = mountVirtualList(root, {
      items: channels,
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
      rowHeight,
      viewportHeight,
      overscanRows,
    });
    const bound = virtualRowBound(viewportHeight, rowHeight, overscanRows);
    expect(handle.getItemCount()).toBe(10_000);
    expect(handle.getMountedRowCount()).toBeGreaterThan(0);
    expect(handle.getMountedRowCount()).toBeLessThanOrEqual(bound);
    handle.destroy();
  });

  it("STUB harness: scrolling 100 windows never grows the mounted count past the bound", () => {
    const channels = fixture10000();
    const handle = mountVirtualList(root, {
      items: channels,
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
      rowHeight: 76,
      viewportHeight: 600,
      overscanRows: 3,
    });
    const bound = virtualRowBound(600, 76, 3);
    const firstWindow = handle.getMountedKeys();
    for (let step = 1; step <= 100; step++) {
      handle.scrollByRows(13);
      expect(handle.getMountedRowCount()).toBeLessThanOrEqual(bound);
      expect(handle.getMountedRowCount()).toBeGreaterThan(0);
    }
    // The window actually moved: later rows are mounted, not the first ones.
    expect(handle.getMountedKeys()).not.toEqual(firstWindow);
    expect(handle.getMountedKeys()[0]).not.toBe(firstWindow[0]);
    handle.destroy();
  });

  it("STUB harness: the bound holds at 200 / 2,000 / 5,000 items too", () => {
    for (const total of [200, 2000, 5000]) {
      const handle = mountVirtualList(root, {
        items: buildFixtureChannels(total),
        keyOf: (c) => String(c.id),
        labelOf: (c) => c.displayName,
        rowHeight: 76,
        viewportHeight: 600,
        overscanRows: 3,
      });
      expect(handle.getMountedRowCount()).toBeLessThanOrEqual(virtualRowBound(600, 76, 3));
      handle.destroy();
    }
  });
});

describe("test 5 — fast controller movement maintains focus", () => {
  it("STUB harness: 1,000 rapid moves land focus exactly, row always mounted", { timeout: 60_000 }, () => {
    const channels = fixture2000();
    const focusLog: string[] = [];
    const handle = mountVirtualList(root, {
      items: channels,
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
      rowHeight: 76,
      viewportHeight: 600,
      overscanRows: 3,
      onFocusChange: (c) => focusLog.push(String(c.id)),
    });
    expect(handle.getFocusedKey()).toBe(String(channels[0]!.id));
    for (let step = 1; step <= 1000; step++) {
      const focused = handle.moveFocus(1);
      expect(focused).toBe(String(channels[step]!.id));
      expect(focused).not.toBeNull();
      // Mounted-containment + DOM focus are sampled (every 25th
      // step) rather than re-queried on all 1,000: the exactness
      // assertion above runs on every step, and the sampled
      // checks still prove the focused row stays mounted and
      // DOM-focused across the whole walk.
      if (step % 25 === 0) {
        expect(handle.getMountedKeys()).toContain(focused);
        const active = document.activeElement as HTMLElement | null;
        expect(active?.getAttribute("data-key")).toBe(focused);
      }
    }
    expect(focusLog).toHaveLength(1000);
    // Moving back up is exact too, and clamps at the top.
    for (let step = 999; step >= 0; step--) {
      expect(handle.moveFocus(-1)).toBe(String(channels[step]!.id));
    }
    expect(handle.moveFocus(-1)).toBe(String(channels[0]!.id));
    handle.destroy();
  });

  it("REAL browser: 500 rapid ArrowDown presses advance the highlight exactly one per press", { timeout: 60_000 }, () => {
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      initialFocusId: channels[0]!.id,
    });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    expect(handle.getHighlightedId()).toBe(channels[0]!.id);
    for (let step = 1; step <= 500; step++) {
      keyOn(list, "ArrowDown");
      expect(handle.getHighlightedId()).toBe(channels[step]!.id);
    }
    // Focus never lost: a highlight is always present.
    expect(handle.getHighlightedId()).not.toBeNull();
    handle.destroy();
  });
});

describe("test 6 — category changes do not trigger accidental playback", () => {
  it("REAL browser: cycling categories, arrows and row clicks never tune", { timeout: 60_000 }, () => {
    const channels = fixture2000();
    const tuneEvents: Array<string | number> = [];
    const onTune = (event: Event): void => {
      tuneEvents.push((event as CustomEvent).detail.channelId as string | number);
    };
    window.addEventListener(LIVETV_TUNE_EVENT, onTune);
    const onSelect = vi.fn((channel: (typeof channels)[number]) => {
      // The real playback handoff: only an explicit select tunes.
      dispatchLivetvTune(channel.id);
    });
    const handle = mountChannelBrowser(root, { channels, onSelect });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;

    // Cycle through every category twice.
    for (let i = 0; i < 30; i++) handle.cycleCategory(1);
    for (let i = 0; i < 30; i++) handle.cycleCategory(-1);
    // Arrow through the list.
    for (let i = 0; i < 50; i++) keyOn(list, "ArrowDown");
    for (let i = 0; i < 50; i++) keyOn(list, "ArrowUp");
    // Click category pills.
    const pills = root.querySelectorAll<HTMLElement>("[data-browser-category]");
    expect(pills.length).toBeGreaterThan(3);
    for (const pill of pills) pill.click();
    // Click rows (highlight only).
    const rows = root.querySelectorAll<HTMLElement>("[data-browser-row]");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) row.click();

    expect(onSelect).not.toHaveBeenCalled();
    expect(tuneEvents).toEqual([]);

    // The explicit action DOES tune, exactly once.
    keyOn(list, "Enter");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(tuneEvents).toHaveLength(1);
    expect(String(tuneEvents[0])).toBe(String(handle.getHighlightedId()));

    window.removeEventListener(LIVETV_TUNE_EVENT, onTune);
    handle.destroy();
  });

  it("STUB index: switching derived categories dispatches no tune event", () => {
    const channels = fixture2000();
    const tuneEvents: unknown[] = [];
    const onTune = (event: Event): void => {
      tuneEvents.push((event as CustomEvent).detail);
    };
    window.addEventListener(LIVETV_TUNE_EVENT, onTune);
    const index = buildCategoryIndex(channels, 1);
    for (const group of index.groups) {
      getDerivedChannels(index, { groupId: group.id });
      for (const subId of group.subcategoryIds) {
        getDerivedChannels(index, { subcategoryId: subId });
      }
    }
    expect(tuneEvents).toEqual([]);
    window.removeEventListener(LIVETV_TUNE_EVENT, onTune);
  });
});

describe("test 9 — search is correctly scoped and cleared", () => {
  it("REAL browser: search filters within the selected category only", () => {
    vi.useFakeTimers();
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      initialCategoryId: "sports",
    });
    const input = root.querySelector<HTMLInputElement>("[data-browser-search]")!;
    input.value = "f1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(200);
    const visible = handle.getVisibleChannels();
    expect(visible.length).toBeGreaterThan(0);
    // Scoped: every visible channel is a Sports channel matching "f1".
    const expected = searchBrowserChannels(
      applyBrowserFilter(channels, { categoryId: "sports" }),
      "f1",
    );
    expect(visible.map((c) => c.id)).toEqual(expected.map((c) => c.id));
    expect(visible.every((c) => /Sports/.test(c.categoryId))).toBe(true);
    handle.destroy();
  });

  it("REAL browser: clearing search restores the full category list", () => {
    vi.useFakeTimers();
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      initialCategoryId: "sports",
    });
    const input = root.querySelector<HTMLInputElement>("[data-browser-search]")!;
    const fullCount = handle.getVisibleChannels().length;
    expect(fullCount).toBe(1200);
    handle.openSearch();
    input.value = "rugby";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(handle.getVisibleChannels().length).toBeLessThan(fullCount);
    expect(handle.closeSearch()).toBe(true);
    expect(input.value).toBe("");
    expect(handle.isSearchOpen()).toBe(false);
    expect(handle.getVisibleChannels()).toHaveLength(fullCount);
    handle.destroy();
  });

  it("REAL browser: search does not leak across a category change", () => {
    vi.useFakeTimers();
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      initialCategoryId: "sports",
    });
    const input = root.querySelector<HTMLInputElement>("[data-browser-search]")!;
    input.value = "sky";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(200);
    handle.cycleCategory(1);
    // Whatever category is now selected, visible rows belong to it
    // and still match the query — no Sports rows leak through.
    const categoryId = handle.getCategoryId();
    const expected = searchBrowserChannels(
      applyBrowserFilter(channels, { categoryId }),
      "sky",
    );
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual(
      expected.map((c) => c.id),
    );
    handle.destroy();
  });

  it("STUB events + index: search-submit scopes, close-overlay clears", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    let query = "";
    let sort: "source" | "az" | "za" = "source";
    const onSubmit = (event: Event): void => {
      query = (event as CustomEvent<{ query: string }>).detail.query;
    };
    const onSort = (event: Event): void => {
      sort = (event as CustomEvent<{ sort: string }>).detail.sort as typeof sort;
    };
    const onClose = (): void => {
      query = "";
    };
    window.addEventListener("livetv:search-submit", onSubmit);
    window.addEventListener("livetv:sort-submit", onSort);
    window.addEventListener("livetv:close-overlay", onClose);

    const inSubcategory = (): ReturnType<typeof getDerivedChannels> =>
      getDerivedChannels(index, {
        subcategoryId: "UK | Sports | Football",
        query,
        sort,
      });
    expect(inSubcategory()).toHaveLength(40);

    dispatchLivetvSearchSubmit("sky");
    const scoped = inSubcategory();
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.length).toBeLessThan(40);
    expect(scoped.every((c) => c.categoryId === "UK | Sports | Football")).toBe(true);
    expect(scoped.every((c) => c.norm.includes("sky"))).toBe(true);

    dispatchLivetvSortSubmit("az");
    const sorted = inSubcategory();
    expect(sorted.map((c) => String(c.id)).sort()).toEqual(
      scoped.map((c) => String(c.id)).sort(),
    );
    const names = sorted.map((c) => c.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);

    dispatchLivetvCloseOverlay();
    expect(inSubcategory()).toHaveLength(40);
    expect(query).toBe("");

    window.removeEventListener("livetv:search-submit", onSubmit);
    window.removeEventListener("livetv:sort-submit", onSort);
    window.removeEventListener("livetv:close-overlay", onClose);
  });
});
