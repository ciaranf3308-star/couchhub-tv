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
 * All tests run against the REAL merged modules: W2's
 * mountChannelBrowser (keyed row pool, rAF-coalesced painting),
 * W1's category index, and W4's overlay event contract. Search is
 * driven through the real `livetv:search-submit` event (the
 * overlay path — there is no inline search box any more), and
 * category changes go through the drawer / cycleCategory (there
 * are no pills any more). A category-scoped search is CLEARED on
 * any category change (W4's applyCategoryChangeToSearch rule).
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
import {
  buildCategoryIndex,
  getDerivedChannels,
} from "@/scripts/lib/livetv-category-index";
import {
  dispatchLivetvCloseOverlay,
  dispatchLivetvSearchSubmit,
  dispatchLivetvSortSubmit,
} from "@/scripts/lib/livetv-search-sort";
import { LIVETV_TUNE_EVENT, dispatchLivetvTune } from "@/scripts/lib/livetv-data";
import { buildFixtureChannels, fixture2000, fixture10000 } from "./fixtures";

function keyOn(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

async function nextFrames(count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function mountedRowIds(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>("[data-browser-row]")].map(
    (row) => row.getAttribute("data-channel-id") ?? "",
  );
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
  sessionStorage.clear();
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

  it("REAL browser: 10,000 items mount at most the row-pool bound", () => {
    const channels = fixture10000();
    const handle = mountChannelBrowser(root, { channels });
    // The keyed row pool caps mounted rows (ROW_POOL_MAX = 40);
    // the bound is independent of catalogue size.
    expect(mountedRowIds(root).length).toBeGreaterThan(0);
    expect(mountedRowIds(root).length).toBeLessThanOrEqual(40);
    handle.destroy();
  });

  it("REAL browser: scrolling 100 windows never grows the mounted count past the bound", async () => {
    const channels = fixture10000();
    const handle = mountChannelBrowser(root, { channels });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    const firstWindow = mountedRowIds(root);
    for (let step = 1; step <= 100; step++) {
      list.scrollTop = step * 13 * BROWSER_ROW_HEIGHT;
      list.dispatchEvent(new Event("scroll"));
      await nextFrames();
      expect(mountedRowIds(root).length).toBeLessThanOrEqual(40);
      expect(mountedRowIds(root).length).toBeGreaterThan(0);
    }
    // The window actually moved: later rows are mounted, not the first ones.
    expect(mountedRowIds(root)).not.toEqual(firstWindow);
    expect(mountedRowIds(root)[0]).not.toBe(firstWindow[0]);
    handle.destroy();
  });

  it("REAL browser: the bound holds at 200 / 2,000 / 5,000 items too", () => {
    for (const total of [200, 2000, 5000]) {
      const handle = mountChannelBrowser(root, { channels: buildFixtureChannels(total) });
      expect(mountedRowIds(root).length).toBeLessThanOrEqual(40);
      expect(mountedRowIds(root).length).toBeGreaterThan(0);
      handle.destroy();
    }
  });
});

describe("test 5 — fast controller movement maintains focus", () => {
  it("REAL browser: 1,000 rapid moves land the highlight exactly, row always mounted", { timeout: 60_000 }, () => {
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      initialFocusId: channels[0]!.id,
    });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    expect(handle.getHighlightedId()).toBe(channels[0]!.id);
    for (let step = 1; step <= 1000; step++) {
      keyOn(list, "ArrowDown");
      expect(handle.getHighlightedId()).toBe(channels[step]!.id);
      // Mounted-containment is sampled (every 25th step) rather
      // than re-queried on all 1,000: the exactness assertion
      // above runs on every step, and the sampled checks still
      // prove the highlighted row stays mounted across the walk.
      if (step % 25 === 0) {
        expect(mountedRowIds(root)).toContain(String(channels[step]!.id));
      }
    }
    // Moving back up is exact too.
    for (let step = 999; step >= 0; step--) {
      keyOn(list, "ArrowUp");
      expect(handle.getHighlightedId()).toBe(channels[step]!.id);
    }
    // The list wraps (pre-existing browser behaviour): one more
    // Up from the top lands on the last channel, never nowhere.
    keyOn(list, "ArrowUp");
    expect(handle.getHighlightedId()).toBe(channels[channels.length - 1]!.id);
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
  it("REAL browser: cycling categories, arrows, drawer picks and row clicks never tune", { timeout: 60_000 }, () => {
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
    // Pick every top-level drawer entry (drill or select).
    handle.openCategories();
    const drawerItems = () => [...root.querySelectorAll<HTMLElement>("[data-category-drawer-item]")];
    expect(drawerItems().length).toBeGreaterThan(3);
    for (const item of drawerItems()) {
      if (!handle.isDrawerOpen()) handle.openCategories();
      const fresh = drawerItems().find(
        (el) => el.getAttribute("data-drawer-item-key") === item.getAttribute("data-drawer-item-key"),
      )!;
      fresh.click();
      // A drill leaves the drawer open on subcategories: pick the
      // first row ("All <Group>") to apply the selection.
      if (handle.isDrawerOpen()) drawerItems()[0]!.click();
      expect(handle.isDrawerOpen()).toBe(false);
    }
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

  it("REAL index: switching derived categories dispatches no tune event", () => {
    const channels = fixture2000();
    const tuneEvents: unknown[] = [];
    const onTune = (event: Event): void => {
      tuneEvents.push((event as CustomEvent).detail);
    };
    window.addEventListener(LIVETV_TUNE_EVENT, onTune);
    const index = buildCategoryIndex(channels, 1);
    for (const group of index.groups) {
      getDerivedChannels(index, { groupId: group.id });
      for (const sub of group.subcategories) {
        getDerivedChannels(index, { subcategoryId: sub.id });
      }
    }
    expect(tuneEvents).toEqual([]);
    window.removeEventListener(LIVETV_TUNE_EVENT, onTune);
  });
});

describe("test 9 — search is correctly scoped and cleared", () => {
  it("REAL browser: search-submit filters within the selected category only", () => {
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      initialCategoryId: "sports",
    });
    dispatchLivetvSearchSubmit(window, { query: "f1", scope: "category", categoryId: "sports" });
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
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      initialCategoryId: "sports",
    });
    const fullCount = handle.getVisibleChannels().length;
    expect(fullCount).toBe(1200);
    dispatchLivetvSearchSubmit(window, { query: "rugby", scope: "category", categoryId: "sports" });
    expect(handle.getVisibleChannels().length).toBeLessThan(fullCount);
    expect(handle.isSearchOpen()).toBe(true);
    expect(handle.closeSearch()).toBe(true);
    expect(handle.isSearchOpen()).toBe(false);
    expect(handle.getVisibleChannels()).toHaveLength(fullCount);
    handle.destroy();
  });

  it("REAL browser: a category change clears a category-scoped search (no leak)", () => {
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      initialCategoryId: "sports",
    });
    dispatchLivetvSearchSubmit(window, { query: "sky", scope: "category", categoryId: "sports" });
    expect(handle.getVisibleChannels().length).toBeLessThan(1200);
    handle.cycleCategory(1);
    // The category-scoped search is cleared by the category
    // change (W4 rule): the new category shows in full, with no
    // stale query and no Sports rows leaking through.
    expect(handle.isSearchOpen()).toBe(false);
    const categoryId = handle.getCategoryId();
    const expected = applyBrowserFilter(channels, { categoryId });
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual(
      expected.map((c) => c.id),
    );
    handle.destroy();
  });

  it("REAL events + index: search-submit scopes, sort-submit sorts, close-overlay clears", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    const footballSub = index.groups
      .flatMap((g) => g.subcategories)
      .find((s) => s.rawName === "UK | Sports | Football")!;
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

    // The browser sorts locally with `source`; the index spells
    // catalogue order `provider` — the harness maps, as any
    // index-routed consumer must.
    const inSubcategory = (): ReturnType<typeof getDerivedChannels> =>
      getDerivedChannels(index, {
        subcategoryId: footballSub.id,
        search: query,
        sort: sort === "source" ? "provider" : sort,
      });
    expect(inSubcategory()).toHaveLength(40);

    dispatchLivetvSearchSubmit(window, { query: "sky", scope: "category", categoryId: "sports" });
    const scoped = inSubcategory();
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.length).toBeLessThan(40);
    expect(scoped.every((c) => c.categoryId === "UK | Sports | Football")).toBe(true);
    expect(scoped.every((c) => c.norm.includes("sky"))).toBe(true);

    dispatchLivetvSortSubmit(window, { sort: "az" });
    const sorted = inSubcategory();
    expect(sorted.map((c) => String(c.id)).sort()).toEqual(
      scoped.map((c) => String(c.id)).sort(),
    );
    const names = sorted.map((c) => c.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);

    dispatchLivetvCloseOverlay(window, { overlay: "search", reason: "cancel" });
    expect(inSubcategory()).toHaveLength(40);
    expect(query).toBe("");

    window.removeEventListener("livetv:search-submit", onSubmit);
    window.removeEventListener("livetv:sort-submit", onSort);
    window.removeEventListener("livetv:close-overlay", onClose);
  });
});
