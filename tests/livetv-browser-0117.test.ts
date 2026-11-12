/**
 * @vitest-environment jsdom
 *
 * Channel Browser 0.11.7 (W2) tests: incremental virtualisation
 * (keyed row reuse, bounded mounted rows, rAF-coalesced scroll
 * paints), the category drawer (navigation semantics, focus
 * memory, one-layer Back), the W4 overlay event contract, no
 * auto-tune on highlight, and the category-index seam (W1's real
 * index module).
 * Synthetic data only; nothing here plays a stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BROWSER_ROW_HEIGHT,
  applyBrowserFilter,
  browserSelectionLabel,
  mountChannelBrowser,
} from "@/scripts/lib/livetv-browser";
import {
  drawerActivate,
  drawerBack,
  drawerBreadcrumb,
  drawerInitialState,
  drawerMove,
  mountCategoryDrawer,
  type DrawerGroup,
} from "@/scripts/lib/livetv-category-drawer";
import {
  getCategoryIndex,
  getDerivedChannels,
} from "@/scripts/lib/livetv-category-index";
import { livetvNav } from "@/scripts/lib/livetv-nav";
import type { LivetvChannel } from "@/scripts/lib/livetv-data";

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

const CHANNELS = [
  ch({ id: 1, name: "Zebra News", categoryId: "News" }),
  ch({ id: 2, name: "Alpha Sports", categoryId: "UK | Sports", favourite: true }),
  ch({ id: 3, name: "Mid Movies", categoryId: "Movies" }),
  ch({ id: 4, name: "Beta Sports", categoryId: "Sports HD", favourite: true }),
  ch({ id: 5, name: "Gamma Sports", categoryId: "UK | Sports" }),
];

function keyOn(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

async function nextFrames(count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function drawerItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-category-drawer-item]")];
}

function drawerItemLabels(root: HTMLElement): string[] {
  return drawerItems(root).map(
    (item) => item.querySelector(".rs-tv-category-drawer__item-label")?.textContent ?? "",
  );
}

function focusedDrawerLabel(root: HTMLElement): string | null {
  const item = root.querySelector<HTMLElement>("[data-category-drawer-item].is-focused");
  return item?.querySelector(".rs-tv-category-drawer__item-label")?.textContent ?? null;
}

function focusedDrawerKey(root: HTMLElement): string | null {
  const item = root.querySelector<HTMLElement>("[data-category-drawer-item].is-focused");
  return item?.getAttribute("data-drawer-item-key") ?? null;
}

function breadcrumbParts(root: HTMLElement): { group: string; sub: string | null; count: string } {
  const crumb = root.querySelector("[data-browser-breadcrumb]")!;
  return {
    group: crumb.querySelector(".lv2-breadcrumb__group")?.textContent ?? "",
    sub: crumb.querySelector(".lv2-breadcrumb__sub")?.textContent ?? null,
    count: crumb.querySelector(".lv2-breadcrumb__count")?.textContent ?? "",
  };
}

describe("category index seam (W1 real index)", () => {
  it("groups channels and exposes real provider subcategories", () => {
    const index = getCategoryIndex(CHANNELS, "browser-0117:seam");
    const sports = index.groups.find((g) => g.id === "sports");
    expect(sports?.channelCount).toBe(3);
    // Subcategory ids are `sub:<slug-of-raw-name>`; rawName is
    // the verbatim provider category, label the normalised one.
    expect(sports?.subcategories.map((s) => s.id)).toEqual([
      "sub:uk-sports",
      "sub:sports-hd",
    ]);
    expect(sports?.subcategories.map((s) => s.rawName)).toEqual([
      "UK | Sports",
      "Sports HD",
    ]);
    expect(sports?.subcategories.map((s) => s.channelCount)).toEqual([2, 1]);
    expect(index.groups.reduce((n, g) => n + g.channelCount, 0)).toBe(5);
  });

  it("getDerivedChannels returns the group slice or one subcategory slice", () => {
    const index = getCategoryIndex(CHANNELS, "browser-0117:derived");
    // Group slice: subcategories in first-seen order, channels in
    // provider order within each subcategory.
    expect(
      getDerivedChannels(index, { groupId: "sports" }).map((c) => c.id),
    ).toEqual([2, 5, 4]);
    expect(
      getDerivedChannels(index, { groupId: "sports", subcategoryId: "sub:uk-sports" }).map((c) => c.id),
    ).toEqual([2, 5]);
    expect(
      getDerivedChannels(index, { groupId: "sports", subcategoryId: "sub:sports-hd" }).map((c) => c.id),
    ).toEqual([4]);
    expect(getDerivedChannels(index, { groupId: "no-such-group" })).toEqual([]);
    expect(getDerivedChannels(index, { groupId: "sports", subcategoryId: "nope" })).toEqual([]);
    // Memoised: the same options return the SAME array reference.
    expect(getDerivedChannels(index, { groupId: "sports" })).toBe(
      getDerivedChannels(index, { groupId: "sports" }),
    );
  });

  it("caches the index per revision and rebuilds on a new revision", () => {
    const first = getCategoryIndex(CHANNELS, "browser-0117:cache-a");
    expect(getCategoryIndex(CHANNELS, "browser-0117:cache-a")).toBe(first);
    const second = getCategoryIndex([...CHANNELS], "browser-0117:cache-b");
    expect(second).not.toBe(first);
    expect(second.revision).toBe("browser-0117:cache-b");
    expect(first.revision).toBe("browser-0117:cache-a");
  });

  it("applyBrowserFilter narrows a group to one subcategory", () => {
    // Canonical W1 id, and the legacy verbatim spelling (accepted
    // at the selection boundary and translated to the canonical
    // id) — both resolve to the same slice.
    expect(
      applyBrowserFilter(CHANNELS, { categoryId: "sports", subcategoryId: "sub:uk-sports" }).map((c) => c.id),
    ).toEqual([2, 5]);
    expect(
      applyBrowserFilter(CHANNELS, { categoryId: "sports", subcategoryId: "UK | Sports" }).map((c) => c.id),
    ).toEqual([2, 5]);
    expect(
      applyBrowserFilter(CHANNELS, { categoryId: "sports", subcategoryId: "nope" }),
    ).toEqual([]);
  });

  it("browserSelectionLabel renders group and group/subcategory breadcrumbs", () => {
    const index = getCategoryIndex(CHANNELS, "browser-0117:label");
    // Production passes the drawer's group list, which adds the
    // pseudo entries (All Channels, Favourites, Recents) around
    // the index groups.
    const labelGroups = [
      ...index.groups,
      { id: "all", label: "All Channels", subcategories: [] },
    ];
    expect(browserSelectionLabel({ groupId: "all", subcategoryId: null }, labelGroups)).toBe("All Channels");
    expect(browserSelectionLabel({ groupId: "sports", subcategoryId: null }, labelGroups)).toBe("Sports");
    const sports = index.groups.find((g) => g.id === "sports")!;
    const ukSports = sports.subcategories.find((s) => s.rawName === "UK | Sports")!;
    expect(
      browserSelectionLabel({ groupId: "sports", subcategoryId: ukSports.id }, labelGroups),
    ).toBe(`Sports / ${ukSports.label}`);
  });
});

describe("drawer navigation reducer (pure)", () => {
  const GROUPS: DrawerGroup[] = [
    { id: "favourites", label: "Favourites", count: 2, icon: "★", opensSubcategories: false, subcategories: [] },
    {
      id: "sports",
      label: "Sports",
      count: 3,
      icon: "◉",
      opensSubcategories: true,
      subcategories: [
        { id: "UK | Sports", label: "UK | Sports", count: 2 },
        { id: "Sports HD", label: "Sports HD", count: 1 },
      ],
    },
    { id: "all", label: "All Channels", count: 5, icon: "▦", opensSubcategories: false, subcategories: [] },
  ];

  it("starts focused on the selected group, or the first group", () => {
    expect(drawerInitialState(GROUPS, "sports").groupIndex).toBe(1);
    expect(drawerInitialState(GROUPS, null).groupIndex).toBe(0);
    expect(drawerInitialState(GROUPS, "unknown").groupIndex).toBe(0);
  });

  it("movement clamps at the ends, never wraps", () => {
    const top = drawerInitialState(GROUPS, "favourites");
    expect(drawerMove(top, GROUPS, -1).groupIndex).toBe(0);
    const bottom = { ...top, groupIndex: 2 };
    expect(drawerMove(bottom, GROUPS, 1).groupIndex).toBe(2);
    const subs = { level: "subcategories" as const, groupIndex: 1, subIndex: 2 };
    expect(drawerMove(subs, GROUPS, 1).subIndex).toBe(2);
    expect(drawerMove({ ...subs, subIndex: 0 }, GROUPS, -1).subIndex).toBe(0);
  });

  it("activating a group opens subcategories starting at All <Group>", () => {
    const state = drawerInitialState(GROUPS, "sports");
    const result = drawerActivate(state, GROUPS);
    expect(result.action).toBe("open-subcategories");
    if (result.action === "open-subcategories") {
      expect(result.state.level).toBe("subcategories");
      expect(result.state.subIndex).toBe(0);
    }
  });

  it("activating a pseudo-entry selects it immediately", () => {
    const result = drawerActivate(drawerInitialState(GROUPS, "favourites"), GROUPS);
    expect(result).toMatchObject({
      action: "select",
      selection: { groupId: "favourites", subcategoryId: null },
    });
  });

  it("subcategory index 0 selects the whole group; later indices select the subcategory", () => {
    const subs = { level: "subcategories" as const, groupIndex: 1, subIndex: 0 };
    expect(drawerActivate(subs, GROUPS)).toMatchObject({
      action: "select",
      selection: { groupId: "sports", subcategoryId: null },
    });
    expect(drawerActivate({ ...subs, subIndex: 2 }, GROUPS)).toMatchObject({
      action: "select",
      selection: { groupId: "sports", subcategoryId: "Sports HD" },
    });
  });

  it("Back from subcategories returns to groups; Back from groups closes", () => {
    const subs = { level: "subcategories" as const, groupIndex: 1, subIndex: 2 };
    const up = drawerBack(subs);
    expect(up.action).toBe("to-groups");
    if (up.action === "to-groups") {
      expect(up.state.level).toBe("groups");
      expect(up.state.groupIndex).toBe(1);
    }
    expect(drawerBack(drawerInitialState(GROUPS, "sports")).action).toBe("close");
  });

  it("breadcrumb names the applied selection at the top level and the path below", () => {
    expect(drawerBreadcrumb(drawerInitialState(GROUPS, "sports"), GROUPS, "Sports")).toBe(
      "Now showing: Sports",
    );
    expect(
      drawerBreadcrumb({ level: "subcategories", groupIndex: 1, subIndex: 0 }, GROUPS, "Sports"),
    ).toBe("Categories / Sports");
  });
});

describe("mountCategoryDrawer (standalone)", () => {
  let root: HTMLElement;
  const GROUPS: DrawerGroup[] = [
    { id: "favourites", label: "Favourites", count: 2, icon: "★", opensSubcategories: false, subcategories: [] },
    {
      id: "sports",
      label: "Sports",
      count: 3,
      icon: "◉",
      opensSubcategories: true,
      subcategories: [
        { id: "UK | Sports", label: "UK | Sports", count: 2 },
        { id: "Sports HD", label: "Sports HD", count: 1 },
      ],
    },
  ];
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => root.remove());

  it("keyboard: Down + Enter opens subcategories; Enter on a subcategory selects it", () => {
    const onSelect = vi.fn();
    const onBack = vi.fn();
    const handle = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "favourites",
      onSelect,
      onBack,
    });
    handle.focusCurrent();
    expect(document.activeElement?.textContent).toContain("Favourites");
    expect(handle.handleKey(new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(true);
    expect(handle.handleKey(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
    expect(handle.getLevel()).toBe("subcategories");
    expect(root.querySelector("[data-category-drawer-breadcrumb]")?.textContent).toBe("Categories / Sports");
    const labels = drawerItemLabels(root);
    expect(labels[0]).toBe("All Sports");
    expect(labels).toEqual(["All Sports", "UK | Sports", "Sports HD"]);
    expect(handle.handleKey(new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(true);
    expect(handle.handleKey(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ groupId: "sports", subcategoryId: "UK | Sports" });
    expect(onBack).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("keyboard: Left in subcategories returns to groups; Right returns (onBack); Escape closes from groups", () => {
    const onBack = vi.fn();
    const handle = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "sports",
      onSelect: vi.fn(),
      onBack,
    });
    handle.handleKey(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(handle.getLevel()).toBe("subcategories");
    expect(handle.handleKey(new KeyboardEvent("keydown", { key: "ArrowLeft" }))).toBe(true);
    expect(handle.getLevel()).toBe("groups");
    expect(onBack).not.toHaveBeenCalled();
    // Left at the top level is not consumed.
    expect(handle.handleKey(new KeyboardEvent("keydown", { key: "ArrowLeft" }))).toBe(false);
    expect(handle.handleKey(new KeyboardEvent("keydown", { key: "ArrowRight" }))).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(1);
    handle.destroy();

    const handle2 = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "sports",
      onSelect: vi.fn(),
      onBack,
    });
    handle2.handleKey(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onBack).toHaveBeenCalledTimes(2);
    handle2.destroy();
  });

  it("scrim click fires onBack; a click selects", () => {
    const onSelect = vi.fn();
    const onBack = vi.fn();
    const handle = mountCategoryDrawer(root, { groups: GROUPS, onSelect, onBack });
    root.querySelector<HTMLElement>("[data-category-drawer-scrim]")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
    drawerItems(root)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith({ groupId: "favourites", subcategoryId: null });
    handle.destroy();
  });

  it("updateGroups refreshes counts and keeps focus by id", () => {
    const handle = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "sports",
      onSelect: vi.fn(),
      onBack: vi.fn(),
    });
    handle.updateGroups([
      { ...GROUPS[0]!, count: 9 },
      { ...GROUPS[1]!, count: 8 },
    ]);
    expect(handle.getFocusedGroupId()).toBe("sports");
    expect(
      drawerItems(root)[1]?.querySelector(".rs-tv-category-drawer__item-count")?.textContent,
    ).toBe("8");
    handle.destroy();
  });

  it("initialFocusGroupId overrides the selection for initial focus", () => {
    const handle = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "favourites",
      initialFocusGroupId: "sports",
      onSelect: vi.fn(),
      onBack: vi.fn(),
    });
    expect(handle.getFocusedGroupId()).toBe("sports");
    handle.destroy();
    const fallback = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "favourites",
      initialFocusGroupId: "unknown",
      onSelect: vi.fn(),
      onBack: vi.fn(),
    });
    expect(fallback.getFocusedGroupId()).toBe("favourites");
    fallback.destroy();
  });

  it("breadcrumb shows the applied selection at the top level", () => {
    const handle = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "sports",
      selectedSubcategoryId: "Sports HD",
      onSelect: vi.fn(),
      onBack: vi.fn(),
    });
    expect(root.querySelector("[data-category-drawer-breadcrumb]")?.textContent).toBe(
      "Now showing: Sports / Sports HD",
    );
    handle.destroy();
  });

  it("an empty groups list renders the empty note, never a fabricated entry", () => {
    const handle = mountCategoryDrawer(root, { groups: [], onSelect: vi.fn(), onBack: vi.fn() });
    expect(root.querySelector(".rs-tv-category-drawer__empty")?.textContent).toContain("No categories");
    expect(drawerItems(root)).toHaveLength(0);
    handle.destroy();
  });
});

describe("mountChannelBrowser 0.11.7", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  it("bounds mounted rows on a 15,000-channel list across scrolls", async () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 15_000; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: i % 2 ? "News" : "Sports" }));
    }
    const handle = mountChannelBrowser(root, { channels: many });
    const viewport = root.querySelector<HTMLElement>("[data-browser-viewport]")!;
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    expect(viewport.childElementCount).toBeGreaterThan(0);
    expect(viewport.childElementCount).toBeLessThan(40);
    list.scrollTop = 5000 * BROWSER_ROW_HEIGHT;
    list.dispatchEvent(new Event("scroll"));
    await nextFrames();
    expect(viewport.childElementCount).toBeLessThan(40);
    expect(viewport.childElementCount).toBeGreaterThan(0);
    list.scrollTop = 14_990 * BROWSER_ROW_HEIGHT;
    list.dispatchEvent(new Event("scroll"));
    await nextFrames();
    expect(viewport.childElementCount).toBeLessThan(40);
    handle.destroy();
  });

  it("reuses the same row nodes across scroll paints and highlight moves", async () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 200; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: "Sports" }));
    }
    const handle = mountChannelBrowser(root, { channels: many });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    const rowFor = (id: number) =>
      root.querySelector<HTMLElement>(`[data-browser-row][data-channel-id="${id}"]`)!;
    const before = rowFor(3);
    list.scrollTop = 2 * BROWSER_ROW_HEIGHT;
    list.dispatchEvent(new Event("scroll"));
    await nextFrames();
    expect(rowFor(3)).toBe(before);
    // Highlight moves do not rebuild rows either.
    keyOn(list, "ArrowDown");
    keyOn(list, "ArrowDown");
    keyOn(list, "ArrowDown");
    expect(rowFor(3)).toBe(before);
    expect(rowFor(3).getAttribute("aria-selected")).toBe("true");
    handle.destroy();
  });

  it("one controller input performs no row DOM churn (no childList mutations in-window)", async () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 200; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: "Sports" }));
    }
    const handle = mountChannelBrowser(root, { channels: many });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    const viewport = root.querySelector<HTMLElement>("[data-browser-viewport]")!;
    keyOn(list, "ArrowDown");
    keyOn(list, "ArrowDown");
    let childMutations = 0;
    const observer = new MutationObserver((records) => {
      childMutations += records.filter((r) => r.type === "childList").length;
    });
    observer.observe(viewport, { childList: true });
    keyOn(list, "ArrowDown");
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    expect(handle.getHighlightedId()).toBe(3);
    expect(childMutations).toBe(0);
    handle.destroy();
  });

  it("scroll paints are rAF-coalesced: many scroll events, one paint", async () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 200; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: "Sports" }));
    }
    const handle = mountChannelBrowser(root, { channels: many });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    const viewport = root.querySelector<HTMLElement>("[data-browser-viewport]")!;
    const firstBefore = viewport.firstElementChild?.getAttribute("data-channel-id");
    // Ten scroll events before any frame: no paint runs yet.
    for (let i = 1; i <= 10; i++) {
      list.scrollTop = i * BROWSER_ROW_HEIGHT;
      list.dispatchEvent(new Event("scroll"));
    }
    expect(viewport.firstElementChild?.getAttribute("data-channel-id")).toBe(firstBefore);
    await nextFrames();
    // One coalesced paint lands on the final window.
    expect(viewport.firstElementChild?.getAttribute("data-channel-id")).not.toBe(firstBefore);
    handle.destroy();
  });

  it("scrolling and focus reuse the derived list (same array) and touch only visible rows", async () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 2000; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: "Sports" }));
    }
    let nowNextCalls = 0;
    const handle = mountChannelBrowser(root, {
      channels: many,
      nowNextFor: () => {
        nowNextCalls += 1;
        return { current: null, next: null };
      },
    });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    const derivedBefore = handle.getVisibleChannels();
    expect(nowNextCalls).toBeLessThan(40);
    keyOn(list, "ArrowDown");
    keyOn(list, "ArrowDown");
    list.scrollTop = 100 * BROWSER_ROW_HEIGHT;
    list.dispatchEvent(new Event("scroll"));
    await nextFrames();
    list.scrollTop = 500 * BROWSER_ROW_HEIGHT;
    list.dispatchEvent(new Event("scroll"));
    await nextFrames();
    expect(handle.getVisibleChannels()).toBe(derivedBefore);
    // Visible rows only, per paint — nowhere near the catalogue size.
    expect(nowNextCalls).toBeLessThan(200);
    handle.destroy();
  });

  it("the focused row is never destroyed by scroll paints or highlight moves", async () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 200; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: "Sports" }));
    }
    const handle = mountChannelBrowser(root, { channels: many });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    handle.highlightChannel(5, { focus: true });
    const row = root.querySelector<HTMLElement>('[data-browser-row][data-channel-id="5"]')!;
    expect(document.activeElement).toBe(row);
    list.scrollTop = 3 * BROWSER_ROW_HEIGHT;
    list.dispatchEvent(new Event("scroll"));
    await nextFrames();
    expect(row.isConnected).toBe(true);
    expect(document.activeElement).toBe(row);
    keyOn(list, "ArrowDown");
    keyOn(list, "ArrowDown");
    expect(row.isConnected).toBe(true);
    handle.destroy();
  });

  it("focus is preserved across category changes and restored from selection memory", () => {
    const handle = mountChannelBrowser(root, {
      channels: CHANNELS,
      autoHighlightFirst: true,
      acceptModeEntry: true,
    });
    handle.highlightChannel(4);
    expect(handle.getHighlightedId()).toBe(4);
    handle.setSelection("sports", null);
    expect(handle.getHighlightedId()).toBe(4);
    handle.setSelection("news", null);
    expect(handle.getHighlightedId()).toBe(1);
    // Returning to Sports restores the remembered channel.
    handle.setSelection("sports", null);
    expect(handle.getHighlightedId()).toBe(4);
    // A subcategory selection keeps a highlight inside it. The
    // verbatim provider spelling is translated to the canonical
    // W1 id at the selection boundary.
    handle.setSelection("sports", "UK | Sports");
    expect(handle.getSubcategoryId()).toBe("sub:uk-sports");
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([2, 5]);
    expect(handle.getHighlightedId()).toBe(2);
    expect(breadcrumbParts(root)).toEqual({ group: "Sports", sub: "Sports", count: "2 channels" });
    handle.destroy();
  });

  it("LB/RB cycle resets the subcategory to All <Group>", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS, recentIds: [1, 2] });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    handle.setSelection("sports", "UK | Sports");
    expect(handle.getSubcategoryId()).toBe("sub:uk-sports");
    keyOn(list, "]");
    expect(handle.getSubcategoryId()).toBeNull();
    expect(handle.getCategoryId()).toBe("movies");
    handle.destroy();
  });

  it("entry filters carry a subcategory", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.applyEntry({ kind: "category", value: "sports", subcategory: "UK | Sports" });
    expect(handle.getSelection()).toEqual({ groupId: "sports", subcategoryId: "sub:uk-sports" });
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([2, 5]);
    // An unknown subcategory falls back to the whole group.
    handle.applyEntry({ kind: "category", value: "sports", subcategory: "nope" });
    expect(handle.getSelection()).toEqual({ groupId: "sports", subcategoryId: null });
    handle.destroy();
  });

  it("D-pad Left opens the drawer; drawer selection applies and returns focus to the list", () => {
    const onSelect = vi.fn();
    const handle = mountChannelBrowser(root, {
      channels: CHANNELS,
      onSelect,
      autoHighlightFirst: true,
    });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "ArrowLeft");
    expect(handle.isDrawerOpen()).toBe(true);
    expect(document.activeElement?.closest("[data-category-drawer-item]")).not.toBeNull();
    // Focus starts on the selected group (All Channels, last).
    expect(focusedDrawerLabel(root)).toBe("All Channels");
    // Move up to Sports (order: Favourites, Sports, Movies, News, Recents, All).
    const focused = () => document.activeElement as HTMLElement;
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    expect(focusedDrawerLabel(root)).toBe("Sports");
    keyOn(focused(), "Enter");
    expect(drawerItemLabels(root)[0]).toBe("All Sports");
    expect(root.querySelector("[data-category-drawer-breadcrumb]")?.textContent).toBe("Categories / Sports");
    keyOn(focused(), "ArrowDown");
    keyOn(focused(), "Enter");
    expect(handle.isDrawerOpen()).toBe(false);
    expect(handle.getSelection()).toEqual({ groupId: "sports", subcategoryId: "sub:uk-sports" });
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([2, 5]);
    expect(breadcrumbParts(root)).toEqual({ group: "Sports", sub: "Sports", count: "2 channels" });
    // Focus returned to the list (highlighted row), never to <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(onSelect).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("drawer remembers the last focused category when reopened", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.openCategories();
    const focused = () => document.activeElement as HTMLElement;
    // Selected group is All Channels (last); move up to Sports.
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    expect(focusedDrawerLabel(root)).toBe("Sports");
    keyOn(focused(), "Enter");
    expect(handle.isDrawerOpen()).toBe(true);
    // Back to groups (focus stays on Sports), then close.
    keyOn(focused(), "Escape");
    expect(focusedDrawerLabel(root)).toBe("Sports");
    keyOn(focused(), "Escape");
    expect(handle.isDrawerOpen()).toBe(false);
    // Reopening returns focus to Sports, not the selection.
    handle.openCategories();
    expect(focusedDrawerLabel(root)).toBe("Sports");
    handle.destroy();
  });

  it("Right from the drawer returns to the list without changing the selection", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.openCategories();
    const focused = () => document.activeElement as HTMLElement;
    keyOn(focused(), "ArrowDown");
    keyOn(focused(), "ArrowRight");
    expect(handle.isDrawerOpen()).toBe(false);
    expect(handle.getSelection()).toEqual({ groupId: "all", subcategoryId: null });
    expect(document.activeElement).not.toBe(document.body);
    handle.destroy();
  });

  it("Left in drawer subcategories returns to groups; LB/RB move within the level only", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.openCategories();
    const focused = () => document.activeElement as HTMLElement;
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    expect(focusedDrawerLabel(root)).toBe("Sports");
    keyOn(focused(), "Enter");
    expect(drawerItemLabels(root)[0]).toBe("All Sports");
    // LB/RB move within the subcategory level, applying nothing.
    // (Both subcategories normalise to the label "Sports" in this
    // fixture, so the focused item KEY pins the exact row.)
    keyOn(focused(), "]");
    expect(focusedDrawerKey(root)).toBe("sub:sports:sub:uk-sports");
    keyOn(focused(), "[");
    expect(focusedDrawerLabel(root)).toBe("All Sports");
    expect(handle.getSelection()).toEqual({ groupId: "all", subcategoryId: null });
    keyOn(focused(), "ArrowLeft");
    expect(drawerItemLabels(root)).toContain("Sports");
    expect(focusedDrawerLabel(root)).toBe("Sports");
    handle.destroy();
  });

  it("keys behind the open drawer do nothing to the list", () => {
    const onSelect = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onSelect });
    handle.highlightChannel(1);
    handle.openCategories();
    const focused = () => document.activeElement as HTMLElement;
    keyOn(focused(), "x");
    keyOn(focused(), "y");
    expect(handle.getHighlightedId()).toBe(1);
    expect(onSelect).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("B closes exactly one layer per press: drawer levels, then search, then exit", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onClose });
    const back = () =>
      window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    const tick = () => vi.advanceTimersByTime(300);

    handle.openCategories();
    const focused = () => document.activeElement as HTMLElement;
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "Enter");
    expect(drawerItemLabels(root)[0]).toBe("All Sports");

    // One Back: subcategories → groups. Drawer still open.
    back();
    expect(handle.isDrawerOpen()).toBe(true);
    expect(focusedDrawerLabel(root)).toBe("Sports");
    // A duplicate Back inside the coalescing window is swallowed.
    back();
    expect(handle.isDrawerOpen()).toBe(true);
    expect(focusedDrawerLabel(root)).toBe("Sports");
    tick();
    // Next Back: drawer closes. onClose not called.
    back();
    expect(handle.isDrawerOpen()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    tick();
    // Search layer: apply a filter, Back clears it (one layer).
    window.dispatchEvent(
      new CustomEvent("livetv:search-submit", { detail: { query: "sports" } }),
    );
    expect(handle.isSearchOpen()).toBe(true);
    back();
    expect(handle.isSearchOpen()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    tick();
    // Final Back: exit.
    back();
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("highlight never tunes: arrows, clicks and drawer picks dispatch no tune or mode event", () => {
    const tuneSpy = vi.fn();
    const modeSpy = vi.fn();
    const onSelect = vi.fn();
    window.addEventListener("livetv:tune", tuneSpy);
    window.addEventListener("livetv:mode", modeSpy);
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onSelect });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "ArrowDown");
    keyOn(list, "ArrowDown");
    const row = root.querySelector<HTMLElement>('[data-browser-row][data-channel-id="3"]')!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    keyOn(list, "ArrowLeft");
    const focused = () => document.activeElement as HTMLElement;
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "Enter");
    keyOn(focused(), "Enter");
    expect(handle.getSelection()).toEqual({ groupId: "sports", subcategoryId: null });
    expect(onSelect).not.toHaveBeenCalled();
    expect(tuneSpy).not.toHaveBeenCalled();
    expect(modeSpy).not.toHaveBeenCalled();
    window.removeEventListener("livetv:tune", tuneSpy);
    window.removeEventListener("livetv:mode", modeSpy);
    handle.destroy();
  });

  it("Menu (m) dispatches livetv:open-sort with context; a sort-submit sorts; invalid sorts are ignored", () => {
    const openSpy = vi.fn();
    window.addEventListener("livetv:open-sort", openSpy);
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.setSelection("sports", "UK | Sports");
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "m");
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0][0].detail).toEqual({
      groupId: "sports",
      subcategoryId: "sub:uk-sports",
      sort: "source",
    });
    window.removeEventListener("livetv:open-sort", openSpy);
    window.dispatchEvent(
      new CustomEvent("livetv:sort-submit", { detail: { sort: "za" } }),
    );
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([5, 2]);
    expect(root.querySelector("[data-browser-sort-button]")?.textContent).toContain("Z–A");
    window.dispatchEvent(
      new CustomEvent("livetv:sort-submit", { detail: { sort: "bogus" } }),
    );
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([5, 2]);
    handle.destroy();
  });

  it("search scope all searches the whole catalogue; category scope searches the selection", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.setSelection("sports", null);
    window.dispatchEvent(
      new CustomEvent("livetv:search-submit", { detail: { query: "zebra" } }),
    );
    expect(handle.getVisibleChannels()).toEqual([]);
    window.dispatchEvent(
      new CustomEvent("livetv:search-submit", { detail: { query: "zebra", scope: "all" } }),
    );
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([1]);
    expect(root.querySelector("[data-browser-breadcrumb]")?.textContent).toContain("All channels");
    handle.destroy();
  });

  it("Y dispatches open-search with the current selection context", () => {
    const openSpy = vi.fn();
    window.addEventListener("livetv:open-search", openSpy);
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.setSelection("sports", "UK | Sports");
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "y");
    expect(openSpy.mock.calls[0][0].detail).toEqual({
      groupId: "sports",
      subcategoryId: "sub:uk-sports",
      query: "",
      scope: "category",
    });
    window.removeEventListener("livetv:open-search", openSpy);
    handle.destroy();
  });

  it("the category button shows the selection and opens the drawer on click", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    const button = root.querySelector<HTMLElement>("[data-browser-category-button]")!;
    expect(button.textContent).toContain("All Channels");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handle.isDrawerOpen()).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Clicking again closes without changing the selection.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handle.isDrawerOpen()).toBe(false);
    expect(handle.getSelection()).toEqual({ groupId: "all", subcategoryId: null });
    handle.destroy();
  });

  it("no pills, no selects, no inline search box remain in the browser", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS, acceptModeEntry: true });
    expect(root.querySelector("[data-browser-category]")).toBeNull();
    expect(root.querySelector("[data-browser-categories]")).toBeNull();
    expect(root.querySelector("select")).toBeNull();
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector("[data-browser-category-button]")).not.toBeNull();
    expect(root.querySelector("[data-browser-breadcrumb]")).not.toBeNull();
    handle.destroy();
  });
});

describe("integration seams (0.11.7)", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    livetvNav.reset();
    sessionStorage.clear();
  });
  afterEach(() => {
    root.remove();
    livetvNav.reset();
    sessionStorage.clear();
  });

  it("a category-scoped search is cleared on ANY category change; scope-all survives", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.setSelection("sports", null);
    window.dispatchEvent(
      new CustomEvent("livetv:search-submit", { detail: { query: "alpha", scope: "category" } }),
    );
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([2]);
    expect(handle.isSearchOpen()).toBe(true);
    // Drawer/LB-RB/collection category changes all route through
    // setSelection: the category-scoped search clears.
    handle.setSelection("news", null);
    expect(handle.isSearchOpen()).toBe(false);
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([1]);
    // Scope "all" survives the same change.
    window.dispatchEvent(
      new CustomEvent("livetv:search-submit", { detail: { query: "alpha", scope: "all" } }),
    );
    expect(handle.isSearchOpen()).toBe(true);
    handle.setSelection("sports", null);
    expect(handle.isSearchOpen()).toBe(true);
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([2]);
    handle.destroy();
  });

  it("sort persists across mounts (sessionStorage) and sort-submit writes it", () => {
    sessionStorage.setItem("redsilk:livetv:sort", "za");
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.setSelection("sports", null);
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([5, 4, 2]);
    window.dispatchEvent(
      new CustomEvent("livetv:sort-submit", { detail: { sort: "az" } }),
    );
    expect(sessionStorage.getItem("redsilk:livetv:sort")).toBe("az");
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([2, 4, 5]);
    handle.destroy();
  });

  it("livetv:guide-channel highlights a channel in the current list, ignores the rest, never tunes", () => {
    const onSelect = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onSelect });
    handle.setSelection("sports", null);
    handle.highlightChannel(2);
    window.dispatchEvent(
      new CustomEvent("livetv:guide-channel", {
        detail: { channelId: 4, programmeKey: "4@0", source: "guide" },
      }),
    );
    expect(handle.getHighlightedId()).toBe(4);
    // A channel outside the current selection is ignored.
    window.dispatchEvent(
      new CustomEvent("livetv:guide-channel", {
        detail: { channelId: 1, programmeKey: "1@0", source: "guide" },
      }),
    );
    expect(handle.getHighlightedId()).toBe(4);
    expect(handle.getSelection()).toEqual({ groupId: "sports", subcategoryId: null });
    expect(onSelect).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("drawer arrows move exactly one row per press (N arrows → index N)", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.openCategories();
    const focused = () => document.activeElement as HTMLElement;
    // Focus starts on All Channels (last row, index 5 of 6).
    expect(focusedDrawerLabel(root)).toBe("All Channels");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    expect(focusedDrawerLabel(root)).toBe("Movies");
    expect(root.querySelectorAll("[data-category-drawer-item].is-focused")).toHaveLength(1);
    handle.destroy();
  });

  it("the drawer is one nav layer: open pushes, Back pops, selection pops", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    expect(livetvNav.topId()).toBe("landing");
    handle.openCategories();
    expect(livetvNav.topId()).toBe("drawer");
    expect(livetvNav.isTop("drawer")).toBe(true);
    // Back via the shared stack closes the drawer layer only.
    expect(livetvNav.back()).toBe(true);
    expect(handle.isDrawerOpen()).toBe(false);
    expect(livetvNav.topId()).toBe("landing");
    // A drawer selection pops the layer too.
    handle.openCategories();
    const focused = () => document.activeElement as HTMLElement;
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "ArrowUp");
    keyOn(focused(), "Enter");
    keyOn(focused(), "Enter");
    expect(handle.isDrawerOpen()).toBe(false);
    expect(livetvNav.topId()).toBe("landing");
    handle.destroy();
  });
});
