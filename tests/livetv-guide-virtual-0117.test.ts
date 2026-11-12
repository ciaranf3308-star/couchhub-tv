// @vitest-environment jsdom
// Live TV 0.11.7 (W3) — Guide virtualisation + shared category model.
//
// Covers: the real category index (W1: real provider
// subcategories, no invented structure), the ONE Guide adapter,
// virtual window math, the keyed DOM virtual list at 2,000+
// entries (bounded mounts, node reuse, focus preservation across
// data refreshes), the category picker's drawer contract (built
// on W2's shared drawer module), and source-level guards that
// the old <select> is gone and the Guide consumes the index only
// through the adapter.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  getCategoryIndex,
  getDerivedChannels,
} from "@/scripts/lib/livetv-category-index";
import {
  GUIDE_CATEGORY_FAVOURITES,
  GUIDE_CATEGORY_RECENTS,
  guideCategoryValueFromDrawer,
  guideCategoryValueToDrawer,
  resolveGuideCategory,
  sameGuideCategoryValue,
} from "@/scripts/lib/livetv-guide-categories";
import {
  createVirtualList,
  focusWindowForIndex,
  focusWindowSize,
  gridRenderSignature,
  preserveGuideFocus,
  virtualListWindow,
} from "@/scripts/lib/livetv-guide-virtual";
import { mountGuideCategoryPicker } from "@/scripts/lib/livetv-guide-category-picker";
import type { LivetvChannel } from "@/scripts/lib/livetv-data";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// ── Fixtures ────────────────────────────────────────────────────

/** Full LivetvChannel shape for direct index calls. */
function ch(partial: Partial<LivetvChannel> & { id: string | number; name: string }): LivetvChannel {
  const rawCategory = partial.categoryId ?? partial.category ?? "";
  return {
    displayName: partial.name,
    logo: null,
    category: rawCategory,
    categoryId: rawCategory,
    categoryLabel: partial.categoryLabel ?? rawCategory,
    streamUrl: null,
    tvgId: null,
    chno: undefined,
    catchup: false,
    favourite: false,
    hidden: false,
    norm: (partial.name + " " + rawCategory).toLowerCase(),
    ...partial,
  };
}

function indexFixtureChannels(): LivetvChannel[] {
  return [
    ch({ id: 1, name: "BBC One", categoryId: "UK | Entertainment" }),
    ch({ id: 2, name: "Sky Sports Main", categoryId: "UK | Sports" }),
    ch({ id: 3, name: "Football 1", categoryId: "Sports | Football" }),
    ch({ id: 4, name: "Football 2", categoryId: "Sports | Football" }),
    ch({ id: 5, name: "F1 Channel", categoryId: "Sports | F1" }),
    ch({ id: 6, name: "Sky News", categoryId: "News" }),
    ch({ id: 7, name: "Movie Max", categoryId: "Movies FHD" }),
    ch({ id: 8, name: "Mystery", categoryId: "" }),
    ch({ id: 9, name: "RTE One", categoryId: "IE | Entertainment" }),
    ch({ id: 10, name: "Sports Extra", categoryId: "Sports" }),
  ];
}

function fixtureChannels() {
  return [
    { id: 1, name: "BBC One", category: "UK | Entertainment" },
    { id: 2, name: "Sky Sports Main", category: "UK | Sports" },
    { id: 3, name: "Football 1", category: "Sports | Football" },
    { id: 4, name: "Football 2", category: "Sports | Football" },
    { id: 5, name: "F1 Channel", category: "Sports | F1" },
    { id: 6, name: "Sky News", category: "News" },
    { id: 7, name: "Movie Max", category: "Movies FHD" },
    { id: 8, name: "Mystery", category: "" },
    { id: 9, name: "RTE One", category: "IE | Entertainment" },
    { id: 10, name: "Sports Extra", category: "Sports" },
  ];
}

/** 2,000 channels across provider categories (Sports-heavy, like the reported lag). */
function bigCatalogue(total = 2000) {
  const cats = [
    "UK | Sports",
    "Sports | Football",
    "Sports | F1",
    "Sports | Rugby",
    "UK | Entertainment",
    "News",
    "Movies FHD",
    "Kids",
    "Documentaries",
    "Music",
  ];
  const out = [];
  for (let i = 0; i < total; i++) {
    out.push({ id: i + 1, name: `Channel ${i + 1}`, category: cats[i % cats.length] });
  }
  return out;
}

function flushFrames(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Category index (W1 real module) ─────────────────────────────

describe("category index (W1 real module)", () => {
  it("derives subcategories from verbatim provider categories, nothing invented", () => {
    const index = getCategoryIndex(indexFixtureChannels(), "guide-0117:subs");
    const sports = index.groups.find((g) => g.id === "sports");
    expect(sports).toBeDefined();
    // `sub:<slug-of-raw-name>` ids, first-seen order — "Sports |
    // Football" and "Sports" are distinct provider subcategories;
    // rawName carries the verbatim provider string.
    expect(sports!.subcategories.map((s) => s.id)).toEqual([
      "sub:uk-sports",
      "sub:sports-football",
      "sub:sports-f1",
      "sub:sports",
    ]);
    expect(sports!.subcategories.map((s) => s.rawName)).toEqual([
      "UK | Sports",
      "Sports | Football",
      "Sports | F1",
      "Sports",
    ]);
    expect(sports!.subcategories.find((s) => s.id === "sub:sports-football")!.channelCount).toBe(2);
    expect(sports!.channelCount).toBe(5);
  });

  it("counts sum to the catalogue total and no channel is dropped", () => {
    const channels = bigCatalogue().map((c) => ch({ id: c.id, name: c.name, categoryId: c.category }));
    const index = getCategoryIndex(channels, "guide-0117:counts");
    const sum = index.groups.reduce((n, g) => n + g.channelCount, 0);
    expect(sum).toBe(2000);
    const subSum = index.groups.reduce(
      (n, g) => n + g.subcategories.reduce((m, s) => m + s.channelCount, 0),
      0,
    );
    expect(subSum).toBe(2000);
    expect(getDerivedChannels(index, {})).toHaveLength(2000);
  });

  it("getDerivedChannels slices by group and subcategory in subcategory order", () => {
    const channels = indexFixtureChannels();
    const index = getCategoryIndex(channels, "guide-0117:slices");
    expect(getDerivedChannels(index, {})).toHaveLength(10);
    const sports = getDerivedChannels(index, { groupId: "sports" });
    expect(sports.map((c) => c.id)).toEqual([2, 3, 4, 5, 10]);
    const football = getDerivedChannels(index, { groupId: "sports", subcategoryId: "sub:sports-football" });
    expect(football.map((c) => c.id)).toEqual([3, 4]);
  });

  it("unknown groups / subcategories yield [] (never a silent whole-catalogue fallback)", () => {
    const channels = indexFixtureChannels();
    const index = getCategoryIndex(channels, "guide-0117:unknown");
    expect(getDerivedChannels(index, { groupId: "nope" })).toEqual([]);
    expect(getDerivedChannels(index, { groupId: "sports", subcategoryId: "nope" })).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const channels = indexFixtureChannels();
    const before = channels.map((c) => c.id);
    const index = getCategoryIndex(channels, "guide-0117:nomutate");
    getDerivedChannels(index, { groupId: "sports" });
    expect(channels.map((c) => c.id)).toEqual(before);
  });
});

// ── The ONE adapter ─────────────────────────────────────────────

describe("resolveGuideCategory (the one adapter)", () => {
  const context = {
    revision: 1,
    favouriteIds: new Set<string | number>([1, "6"]),
    recentIds: ["7", "2", "7", "99"],
  };

  it("resolves all / favourites / recents with the old select's semantics", () => {
    const channels = fixtureChannels();
    const all = resolveGuideCategory(channels, { kind: "all" }, context);
    expect(all.channels).toHaveLength(10);
    expect(all.triggerLabel).toBe("All categories");
    const favs = resolveGuideCategory(channels, { kind: "favourites" }, context);
    expect(favs.channels.map((c) => c.id)).toEqual([1, 6]);
    expect(favs.triggerLabel).toBe("Favourites");
    const recents = resolveGuideCategory(channels, { kind: "recents" }, context);
    expect(recents.channels.map((c) => c.id)).toEqual([7, 2]);
    expect(recents.triggerLabel).toBe("Recently watched");
  });

  it("resolves groups and subcategories through the index", () => {
    const channels = fixtureChannels();
    const group = resolveGuideCategory(
      channels,
      { kind: "group", groupId: "sports", subcategoryId: null },
      context,
    );
    expect(group.channels.map((c) => c.id)).toEqual([2, 3, 4, 5, 10]);
    expect(group.triggerLabel).toBe("Sports");
    const sub = resolveGuideCategory(
      channels,
      { kind: "group", groupId: "sports", subcategoryId: "sub:sports-f1" },
      context,
    );
    expect(sub.channels.map((c) => c.id)).toEqual([5]);
    expect(sub.triggerLabel).toBe("Sports F1");
  });

  it("validates stale selections back to all / whole group", () => {
    const channels = fixtureChannels();
    const stale = resolveGuideCategory(
      channels,
      { kind: "group", groupId: "gone", subcategoryId: null },
      context,
    );
    expect(stale.selection).toEqual({ kind: "all" });
    expect(stale.channels).toHaveLength(10);
    const staleSub = resolveGuideCategory(
      channels,
      { kind: "group", groupId: "sports", subcategoryId: "Gone" },
      context,
    );
    expect(staleSub.selection).toEqual({ kind: "group", groupId: "sports", subcategoryId: null });
  });

  it("exposes picker groups with pseudo-groups first and real counts", () => {
    const channels = fixtureChannels();
    const res = resolveGuideCategory(channels, { kind: "all" }, context);
    expect(res.groups[0]!.label).toBe("All categories");
    expect(res.groups[0]!.channelCount).toBe(10);
    expect(res.groups[1]!.channelCount).toBe(2);
    expect(res.groups[2]!.channelCount).toBe(2);
    const sports = res.groups.find((g) => g.id === "sports")!;
    expect(sports.subcategories.length).toBe(4);
  });

  it("maps drawer-contract ids to values and back", () => {
    expect(guideCategoryValueFromDrawer(null, null)).toEqual({ kind: "all" });
    expect(guideCategoryValueFromDrawer(GUIDE_CATEGORY_FAVOURITES, null)).toEqual({ kind: "favourites" });
    expect(guideCategoryValueFromDrawer(GUIDE_CATEGORY_RECENTS, null)).toEqual({ kind: "recents" });
    expect(guideCategoryValueFromDrawer("sports", "sub:sports-f1")).toEqual({
      kind: "group",
      groupId: "sports",
      subcategoryId: "sub:sports-f1",
    });
    expect(guideCategoryValueToDrawer({ kind: "group", groupId: "sports", subcategoryId: "sub:sports-f1" })).toEqual({
      groupId: "sports",
      subcategoryId: "sub:sports-f1",
    });
    expect(sameGuideCategoryValue({ kind: "all" }, { kind: "all" })).toBe(true);
    expect(
      sameGuideCategoryValue(
        { kind: "group", groupId: "sports", subcategoryId: null },
        { kind: "group", groupId: "sports", subcategoryId: "sub:sports-f1" },
      ),
    ).toBe(false);
  });
});

// ── Pure window math ────────────────────────────────────────────

describe("virtualListWindow", () => {
  it("bounds a 2,000-item list to visible + overscan", () => {
    const win = virtualListWindow({
      total: 2000,
      rowHeightPx: 112,
      scrollTopPx: 0,
      viewportHeightPx: 600,
      overscanRows: 4,
    });
    expect(win.startIndex).toBe(0);
    expect(win.endIndex - win.startIndex).toBeLessThanOrEqual(14);
    expect(win.topSpacerPx).toBe(0);
    expect(win.topSpacerPx + win.bottomSpacerPx).toBe((2000 - (win.endIndex - win.startIndex)) * 112);
  });

  it("slides with scroll and stays bounded mid-list", () => {
    const win = virtualListWindow({
      total: 2000,
      rowHeightPx: 112,
      scrollTopPx: 112 * 100,
      viewportHeightPx: 600,
      overscanRows: 4,
    });
    expect(win.startIndex).toBe(96);
    expect(win.endIndex - win.startIndex).toBeLessThanOrEqual(14);
    expect(win.startIndex).toBeLessThanOrEqual(100);
    expect(win.endIndex).toBeGreaterThan(100);
  });

  it("handles empty and short lists", () => {
    expect(
      virtualListWindow({ total: 0, rowHeightPx: 112, scrollTopPx: 0, viewportHeightPx: 600 }),
    ).toMatchObject({ startIndex: 0, endIndex: 0 });
    const short = virtualListWindow({ total: 3, rowHeightPx: 112, scrollTopPx: 0, viewportHeightPx: 600 });
    expect([short.startIndex, short.endIndex]).toEqual([0, 3]);
  });
});

describe("focusWindowForIndex", () => {
  it("is sticky inside the comfortable zone and contains the focus index", () => {
    const first = focusWindowForIndex({ total: 500, focusIndex: 10, windowSize: 20, overscanRows: 4, currentStart: null });
    expect(first).toEqual({ startIndex: 6, endIndex: 26 });
    const same = focusWindowForIndex({ total: 500, focusIndex: 12, windowSize: 20, overscanRows: 4, currentStart: first.startIndex });
    expect(same).toEqual(first);
  });

  it("slides only when focus crosses the margin", () => {
    const win = focusWindowForIndex({ total: 500, focusIndex: 24, windowSize: 20, overscanRows: 4, currentStart: 6 });
    expect(win.startIndex).toBeGreaterThan(6);
    expect(win.startIndex).toBeLessThanOrEqual(24);
    expect(win.endIndex).toBeGreaterThan(24);
  });

  it("clamps at both ends", () => {
    expect(focusWindowForIndex({ total: 500, focusIndex: 0, windowSize: 20, overscanRows: 4, currentStart: null }).startIndex).toBe(0);
    const end = focusWindowForIndex({ total: 500, focusIndex: 499, windowSize: 20, overscanRows: 4, currentStart: null });
    expect(end.endIndex).toBe(500);
    expect(end.startIndex).toBe(480);
    expect(focusWindowSize(600, 150, 4)).toBeGreaterThanOrEqual(12);
  });
});

describe("gridRenderSignature", () => {
  const base = {
    startRow: 0,
    endRow: 9,
    scrollLeftPx: 0,
    viewportWidthPx: 1200,
    dayStartMs: 1000,
    revision: 1,
    selectedKey: "1@2",
    channelCount: 50,
  };
  it("is stable for identical inputs and sensitive to every input", () => {
    expect(gridRenderSignature(base)).toBe(gridRenderSignature({ ...base }));
    expect(gridRenderSignature({ ...base, endRow: 10 })).not.toBe(gridRenderSignature(base));
    expect(gridRenderSignature({ ...base, scrollLeftPx: 10 })).not.toBe(gridRenderSignature(base));
    expect(gridRenderSignature({ ...base, revision: 2 })).not.toBe(gridRenderSignature(base));
    expect(gridRenderSignature({ ...base, selectedKey: "1@3" })).not.toBe(gridRenderSignature(base));
    expect(gridRenderSignature({ ...base, channelCount: 51 })).not.toBe(gridRenderSignature(base));
  });
});

// ── DOM virtual list ────────────────────────────────────────────

function scrollableContainer(): { container: HTMLElement; setScrollTop: (px: number) => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
    configurable: true,
  });
  Object.defineProperty(container, "clientHeight", {
    get: () => 600,
    configurable: true,
  });
  return { container, setScrollTop: (px: number) => { scrollTop = px; } };
}

function rowRenderer() {
  return {
    keyOf: (item: { id: number }, _index: number) => `guide:channel:${item.id}`,
    renderRow: (item: { id: number; title: string }, _index: number, existing: HTMLElement | null) => {
      if (existing) {
        existing.textContent = item.title;
        return existing;
      }
      const node = document.createElement("button");
      node.setAttribute("data-focus-key", `guide:channel:${item.id}`);
      node.textContent = item.title;
      return node;
    },
  };
}

describe("createVirtualList (spacer mode)", () => {
  it("mounts only a bounded window for 2,000 entries", () => {
    const { container } = scrollableContainer();
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, title: `Channel ${i + 1}` }));
    const list = createVirtualList({ container, mode: "spacer", rowHeightPx: 112, ...rowRenderer() });
    list.setItems(items);
    expect(list.mountedCount()).toBeLessThanOrEqual(14);
    expect(container.querySelectorAll("button").length).toBe(list.mountedCount());
    expect(container.querySelectorAll(".rs-guide-virtual-spacer").length).toBe(2);
    list.destroy();
    container.remove();
  });

  it("slides the window on scroll with keyed node reuse (no rebuilds)", async () => {
    const { container, setScrollTop } = scrollableContainer();
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, title: `Channel ${i + 1}` }));
    const list = createVirtualList({ container, mode: "spacer", rowHeightPx: 112, ...rowRenderer() });
    list.setItems(items);
    const before = container.querySelector('[data-focus-key="guide:channel:8"]');
    expect(before).not.toBeNull();
    setScrollTop(112 * 5);
    container.dispatchEvent(new Event("scroll"));
    await flushFrames();
    const after = container.querySelector('[data-focus-key="guide:channel:8"]');
    expect(after).toBe(before);
    expect(list.mountedCount()).toBeLessThanOrEqual(14);
    list.destroy();
    container.remove();
  });

  it("preserves focus across data refreshes (EPG update) on the same key", () => {
    const { container } = scrollableContainer();
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, title: `Channel ${i + 1}` }));
    const list = createVirtualList({ container, mode: "spacer", rowHeightPx: 112, ...rowRenderer() });
    list.setItems(items);
    const node = container.querySelector<HTMLElement>('[data-focus-key="guide:channel:5"]')!;
    node.focus();
    expect(document.activeElement).toBe(node);
    const refreshed = items.map((item) => ({ ...item, title: `${item.title} (new)` }));
    list.setItems(refreshed);
    expect(document.activeElement).toBe(node);
    expect(node.textContent).toBe("Channel 5 (new)");
    list.destroy();
    container.remove();
  });

  it("keeps focus on the same programme key when earlier items drop out", () => {
    const { container } = scrollableContainer();
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: `Channel ${i + 1}` }));
    const list = createVirtualList({ container, mode: "spacer", rowHeightPx: 112, ...rowRenderer() });
    list.setItems(items);
    const node = container.querySelector<HTMLElement>('[data-focus-key="guide:channel:8"]')!;
    node.focus();
    list.setItems(items.slice(3));
    expect(document.activeElement).toBe(node);
    expect(list.indexOfKey("guide:channel:8")).toBe(4);
    list.destroy();
    container.remove();
  });

  it("ensureIndexVisible mounts and returns far rows", () => {
    const { container } = scrollableContainer();
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, title: `Channel ${i + 1}` }));
    const list = createVirtualList({ container, mode: "spacer", rowHeightPx: 112, ...rowRenderer() });
    list.setItems(items);
    const node = list.ensureIndexVisible(1500);
    expect(node?.getAttribute("data-focus-key")).toBe("guide:channel:1501");
    expect(list.mountedCount()).toBeLessThanOrEqual(15);
    list.destroy();
    container.remove();
  });

  it("reports empty / non-empty transitions and mounts nothing when empty", () => {
    const { container } = scrollableContainer();
    const seen: boolean[] = [];
    const list = createVirtualList({
      container,
      mode: "spacer",
      rowHeightPx: 112,
      ...rowRenderer(),
      onEmptyChange: (isEmpty) => seen.push(isEmpty),
    });
    list.setItems([]);
    expect(list.mountedCount()).toBe(0);
    list.setItems([{ id: 1, title: "One" }]);
    expect(seen).toEqual([false]);
    list.setItems([]);
    expect(seen).toEqual([false, true]);
    list.destroy();
    container.remove();
  });
});

describe("createVirtualList (focus-window mode)", () => {
  it("bounds the Tonight fallback window and pages with focus", () => {
    const { container } = scrollableContainer();
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, title: `Programme ${i + 1}` }));
    const list = createVirtualList({ container, mode: "focus-window", rowHeightPx: 150, ...rowRenderer() });
    list.setItems(items);
    expect(list.mountedCount()).toBeLessThanOrEqual(focusWindowSize(600, 150, 4));
    const node = list.ensureIndexVisible(400);
    expect(node?.getAttribute("data-focus-key")).toBe("guide:channel:401");
    expect(list.mountedCount()).toBeLessThanOrEqual(focusWindowSize(600, 150, 4));
    list.destroy();
    container.remove();
  });
});

describe("preserveGuideFocus", () => {
  it("restores focus to the same key after a rebuild, and leaves outside focus alone", () => {
    const container = document.createElement("div");
    container.innerHTML = `<button data-focus-key="a">A</button><button data-focus-key="b">B</button>`;
    document.body.appendChild(container);
    const first = container.querySelector<HTMLElement>('[data-focus-key="a"]')!;
    first.focus();
    preserveGuideFocus(container, () => {
      container.innerHTML = `<button data-focus-key="a">A2</button><button data-focus-key="b">B2</button>`;
    });
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe("a");
    expect(document.activeElement?.textContent).toBe("A2");
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    preserveGuideFocus(container, () => {
      container.innerHTML = `<button data-focus-key="a">A3</button>`;
    });
    expect(document.activeElement).toBe(outside);
    container.remove();
    outside.remove();
  });
});

// ── Category picker (shared drawer module) ──────────────────────

describe("Guide category picker (shared drawer)", () => {
  function mountPicker() {
    const mount = document.createElement("div");
    const trigger = document.createElement("button");
    document.body.appendChild(mount);
    document.body.appendChild(trigger);
    const selected: Array<{ groupId: string | null; subcategoryId: string | null }> = [];
    let backs = 0;
    const groups = [
      { id: "__all__", label: "All categories", channelCount: 10, subcategories: [] },
      { id: "sports", label: "Sports", channelCount: 5, subcategories: [
        { id: "sub:sports-football", label: "Sports Football", channelCount: 2 },
        { id: "sub:sports-f1", label: "Sports F1", channelCount: 1 },
      ] },
      { id: "news", label: "News", channelCount: 1, subcategories: [] },
    ];
    const picker = mountGuideCategoryPicker(mount, trigger, {
      groups,
      selectedGroupId: null,
      selectedSubcategoryId: null,
      onSelect: (selection) => selected.push(selection),
      onBack: () => { backs += 1; },
    });
    return { mount, trigger, picker, selected, get backs() { return backs; }, groups };
  }

  function drawerItems(mount: HTMLElement): HTMLElement[] {
    return [...mount.querySelectorAll<HTMLElement>("[data-category-drawer-item]")];
  }

  function itemByLabel(mount: HTMLElement, label: string): HTMLElement {
    const item = drawerItems(mount).find(
      (el) => el.querySelector(".rs-tv-category-drawer__item-label")?.textContent === label,
    );
    if (!item) throw new Error(`no drawer item labelled ${label}`);
    return item;
  }

  function focusedKey(mount: HTMLElement): string | null {
    return mount
      .querySelector("[data-category-drawer-item].is-focused")
      ?.getAttribute("data-drawer-item-key") ?? null;
  }

  function key(keyName: string): KeyboardEvent {
    return new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true });
  }

  it("opens on the selected group and selects a group with no subcategories on click", () => {
    const { mount, picker, selected } = mountPicker();
    picker.open();
    expect(picker.isOpen()).toBe(true);
    expect(picker.getLevel()).toBe("groups");
    // Selected group is "all" (null maps to __all__): focus starts there.
    expect(focusedKey(mount)).toBe("group:__all__");
    itemByLabel(mount, "News").click();
    expect(selected).toEqual([{ groupId: "news", subcategoryId: null }]);
    picker.destroy();
    mount.remove();
  });

  it("drills Enter into subcategories and selects one (replacing the filter)", () => {
    const { mount, picker, selected } = mountPicker();
    picker.open();
    // Focus starts on __all__; one ArrowDown reaches Sports.
    // Enter drills into its subcategories ("All Sports" first),
    // arrows move within the level, Enter selects.
    expect(picker.handleKey(key("ArrowDown"))).toBe(true);
    expect(focusedKey(mount)).toBe("group:sports");
    expect(picker.handleKey(key("Enter"))).toBe(true);
    expect(picker.getLevel()).toBe("subcategories");
    expect(drawerItems(mount).map((el) => el.querySelector(".rs-tv-category-drawer__item-label")?.textContent)).toEqual([
      "All Sports",
      "Sports Football",
      "Sports F1",
    ]);
    expect(picker.handleKey(key("ArrowDown"))).toBe(true);
    expect(picker.handleKey(key("ArrowDown"))).toBe(true);
    expect(focusedKey(mount)).toBe("sub:sports:sub:sports-f1");
    expect(picker.handleKey(key("Enter"))).toBe(true);
    expect(selected).toEqual([{ groupId: "sports", subcategoryId: "sub:sports-f1" }]);
    picker.destroy();
    mount.remove();
  });

  it("follows the one-layer B rule: subs → groups → onBack", () => {
    const ctx = mountPicker();
    const { mount, picker } = ctx;
    picker.open();
    picker.handleKey(key("ArrowDown"));
    picker.handleKey(key("Enter"));
    expect(picker.getLevel()).toBe("subcategories");
    expect(picker.handleBack()).toBe(true);
    expect(picker.getLevel()).toBe("groups");
    expect(focusedKey(mount)).toBe("group:sports");
    expect(picker.handleBack()).toBe(true);
    expect(ctx.backs).toBe(1);
    picker.destroy();
    mount.remove();
  });

  it("moves Up/Down within the open list and Left returns from subcategories", () => {
    const { mount, picker } = mountPicker();
    picker.open();
    const first = drawerItems(mount)[0]!;
    first.focus();
    expect(picker.handleKey(key("ArrowDown"))).toBe(true);
    expect(focusedKey(mount)).toBe("group:sports");
    picker.handleKey(key("Enter"));
    expect(picker.getLevel()).toBe("subcategories");
    expect(picker.handleKey(key("ArrowLeft"))).toBe(true);
    expect(picker.getLevel()).toBe("groups");
    expect(focusedKey(mount)).toBe("group:sports");
    picker.destroy();
    mount.remove();
  });

  it("Right closes without a selection; update refreshes groups while open", () => {
    const ctx = mountPicker();
    const { mount, picker, selected } = ctx;
    picker.open();
    expect(picker.handleKey(key("ArrowRight"))).toBe(true);
    expect(ctx.backs).toBe(1);
    expect(selected).toEqual([]);
    picker.open();
    picker.update({
      groups: [
        { id: "__all__", label: "All categories", channelCount: 12, subcategories: [] },
        { id: "news", label: "News", channelCount: 3, subcategories: [] },
      ],
    });
    expect(itemByLabel(mount, "News").querySelector(".rs-tv-category-drawer__item-count")?.textContent).toBe("3");
    expect(drawerItems(mount)).toHaveLength(2);
    picker.destroy();
    mount.remove();
  });
});

// ── Source-level guards ─────────────────────────────────────────

describe("Guide source guards (0.11.7)", () => {
  const guide = read("src/components/couch/TvGuideView.astro");

  it("has no category <select>; the trigger + drawer mount replace it", () => {
    // Markup-level check (comments may still name the old <select>).
    expect(guide).not.toMatch(/^\s*<select[\s>]/m);
    expect(guide).not.toContain("HTMLSelectElement");
    expect(guide).not.toContain('data-guide-category"');
    expect(guide).toContain("data-guide-category-trigger");
    expect(guide).toContain("data-guide-category-drawer");
    expect(guide).toContain("mountGuideCategoryPicker");
  });

  it("consumes the category index only through the one adapter", () => {
    expect(guide).toContain("resolveGuideCategory");
    expect(guide).not.toContain("getCategoryIndex(");
    expect(guide).not.toContain("getDerivedChannels(");
    expect(guide).not.toContain("function applyCategoryFilter");
    const adapter = read("src/scripts/lib/livetv-guide-categories.ts");
    expect(adapter).toContain("getCategoryIndex");
    expect(adapter).toContain("getDerivedChannels");
  });

  it("announces Guide channel selection on the Browser seam and keeps the one-layer B section", () => {
    expect(guide).toContain("livetv:guide-channel");
    expect(guide).toContain("guideChannelId");
    expect(guide).toContain("ONE-LAYER RULE");
  });

  it("has no stub/swap markers: the real index and the shared drawer are integrated", () => {
    expect(read("src/scripts/lib/livetv-category-index.ts")).not.toContain("STUB-FOR-INTEGRATION");
    const picker = read("src/scripts/lib/livetv-guide-category-picker.ts");
    expect(picker).not.toContain("SWAP TARGET");
    expect(picker).not.toContain("STUB-FOR-INTEGRATION");
    expect(picker).toContain("mountCategoryDrawer");
    expect(picker).toContain("selectedGroupId");
    expect(picker).toContain("selectedSubcategoryId");
    expect(picker).toContain("onSelect");
    expect(picker).toContain("onBack");
  });

  it("styles the virtual spacers and the drawer", () => {
    const css = read("src/styles/couch.css");
    expect(css).toContain("rs-guide-virtual-spacer");
    expect(css).toContain("rs-guide-catdrawer");
    expect(css).toContain("rs-guide-tonight-fallback");
  });

  it("keeps fixed-height virtual rows unshrinkable (harness: flex crush sliced titles)", () => {
    const css = read("src/styles/couch.css");
    // overflow:hidden zeroes the automatic minimum size, so the
    // flex column crushes fixed-height rows without flex-shrink:0.
    expect(css).toMatch(/rs-guide-row--nownav \{[^}]*flex-shrink: 0/s);
    expect(css).toMatch(/rs-guide-channel-pick \{[^}]*flex-shrink: 0/s);
  });

  it("disables scroll anchoring on virtual lists (harness: anchoring feedback marched scrollTop and lost focus)", () => {
    const css = read("src/styles/couch.css");
    expect(css).toContain("overflow-anchor: none");
    expect(css).toMatch(/\[data-guide-now-list\][\s\S]{0,200}overflow-anchor: none/);
    expect(css).toMatch(/\[data-guide-channel-list\][\s\S]{0,200}overflow-anchor: none/);
    expect(css).toMatch(/\[data-guide-tonight-fallback\][\s\S]{0,200}overflow-anchor: none/);
  });

  it("claims handled Guide keys so SpatialNavigation cannot double-move them (harness: double-step + focus thrown to chrome)", () => {
    expect(guide).toContain("const claim = () => {");
    expect(guide).toContain("event.stopPropagation();");
    expect(guide).toContain("claim();");
  });
});
