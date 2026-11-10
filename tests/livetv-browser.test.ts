/**
 * @vitest-environment jsdom
 *
 * Channel Browser tests (0.9.0 W2 rebuild): the virtualised utility
 * screen — 4-column rows (Ch. / Channel / Now / Next), compact
 * contextual panel, category selector order, entry filters, search,
 * page jumps, favourite toggle, B/back, and highlight-never-tunes.
 * Synthetic data only; nothing here plays a stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BROWSER_ROW_HEIGHT,
  applyBrowserFilter,
  browserCategories,
  browserFilterFromEntry,
  mountChannelBrowser,
} from "@/scripts/lib/livetv-browser";
import type { LivetvChannel, LivetvNowNext } from "@/scripts/lib/livetv-data";

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
  ch({ id: 2, name: "Alpha Sports", categoryId: "Sports", favourite: true }),
  ch({ id: 3, name: "Mid Movies", categoryId: "Movies" }),
  ch({ id: 4, name: "Beta Sports", categoryId: "Sports", favourite: true }),
];

const NOW_NEXT: Record<number, LivetvNowNext> = {
  2: {
    current: { title: "F1: Brazilian Grand Prix — Qualifying", start: 17_300, stop: 19_000, desc: "Live from Interlagos." },
    next: { title: "F1: Build-Up", start: 19_000, stop: 20_000, desc: "" },
  },
};

function keyOn(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("applyBrowserFilter", () => {
  it("keeps source order by default and filters by category", () => {
    expect(applyBrowserFilter(CHANNELS).map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(applyBrowserFilter(CHANNELS, { categoryId: "sports" }).map((c) => c.id)).toEqual([2, 4]);
    expect(applyBrowserFilter(CHANNELS, { categoryId: "favourites" }).map((c) => c.id)).toEqual([2, 4]);
    expect(applyBrowserFilter(CHANNELS, { categoryId: "recents", recentIds: [4, 1] }).map((c) => c.id)).toEqual([4, 1]);
    expect(applyBrowserFilter(CHANNELS, { categoryId: "no-such-group" })).toEqual([]);
  });

  it("sorts A-Z, Z-A and by category", () => {
    expect(applyBrowserFilter(CHANNELS, { sort: "az" }).map((c) => c.id)).toEqual([2, 4, 3, 1]);
    expect(applyBrowserFilter(CHANNELS, { sort: "za" }).map((c) => c.id)).toEqual([1, 3, 4, 2]);
    expect(applyBrowserFilter(CHANNELS, { sort: "category" }).map((c) => c.id)).toEqual([3, 1, 2, 4]);
  });

  it("combines search with category", () => {
    expect(
      applyBrowserFilter(CHANNELS, { categoryId: "sports", query: "beta" }).map((c) => c.id),
    ).toEqual([4]);
  });

  it('"F1" finds F1 channels and "BBC" finds BBC channels (case-insensitive)', () => {
    const f1 = [
      ch({ id: 101, name: "Sky Sports F1 HD", categoryId: "Sports" }),
      ch({ id: 102, name: "Sky Sports Premier League HD", categoryId: "Sports" }),
      ch({ id: 103, name: "F1 TV", categoryId: "Sports" }),
    ];
    expect(applyBrowserFilter(f1, { query: "F1" }).map((c) => c.id)).toEqual([101, 103]);
    expect(applyBrowserFilter(f1, { query: "f1" }).map((c) => c.id)).toEqual([101, 103]);
    const bbc = [
      ch({ id: 201, name: "BBC One HD", categoryId: "Entertainment" }),
      ch({ id: 202, name: "BBC Two HD", categoryId: "Entertainment" }),
      ch({ id: 203, name: "ITV 1 HD", categoryId: "Entertainment" }),
    ];
    expect(applyBrowserFilter(bbc, { query: "BBC" }).map((c) => c.id)).toEqual([201, 202]);
    // A redundant provider prefix in the query still matches when
    // the normalised haystack carries it (category is in the norm).
    expect(
      applyBrowserFilter(
        [ch({ id: 204, name: "BBC One", categoryId: "UK | Entertainment" })],
        { query: "UK BBC" },
      ).map((c) => c.id),
    ).toEqual([204]);
  });
});

describe("browserFilterFromEntry", () => {
  it("maps entry filters onto category ids", () => {
    expect(browserFilterFromEntry({ kind: "all" })).toBe("all");
    expect(browserFilterFromEntry({ kind: "favourites" })).toBe("favourites");
    expect(browserFilterFromEntry({ kind: "recents" })).toBe("recents");
    expect(browserFilterFromEntry({ kind: "category", value: "sports" })).toBe("sports");
    expect(browserFilterFromEntry({ kind: "category" })).toBe("all");
    expect(browserFilterFromEntry(null)).toBe("all");
    expect(browserFilterFromEntry(undefined)).toBe("all");
  });
});

describe("browserCategories", () => {
  it("lists Favourites, Recents, then groups, All Channels last", () => {
    const cats = browserCategories(CHANNELS, [1, 2]);
    expect(cats.map((c) => c.id)).toEqual(["favourites", "recents", "sports", "news", "movies", "all"]);
    expect(cats.find((c) => c.id === "all")?.count).toBe(4);
    expect(cats.find((c) => c.id === "favourites")?.count).toBe(2);
    expect(cats.find((c) => c.id === "recents")?.count).toBe(2);
  });

  it("always lists Favourites / Recents, even at count 0", () => {
    const cats = browserCategories([ch({ id: 1, name: "A", categoryId: "News" })], []);
    expect(cats.map((c) => c.id)).toEqual(["favourites", "recents", "news", "all"]);
    expect(cats.find((c) => c.id === "favourites")?.count).toBe(0);
    expect(cats.find((c) => c.id === "recents")?.count).toBe(0);
  });
});

describe("mountChannelBrowser", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  it("virtualises: 15,000 channels build only the visible window", () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 15_000; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: i % 2 ? "News" : "Sports" }));
    }
    const handle = mountChannelBrowser(root, { channels: many });
    const viewport = root.querySelector<HTMLElement>("[data-browser-viewport]")!;
    const spacer = root.querySelector<HTMLElement>("[data-browser-spacer]")!;
    expect(viewport.childElementCount).toBeGreaterThan(0);
    expect(viewport.childElementCount).toBeLessThan(40);
    expect(spacer.style.height).toBe(`${15_000 * BROWSER_ROW_HEIGHT}px`);
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("15,000");
    handle.destroy();
  });

  it("virtualises a 600+ list: only the visible window is rendered", () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 600; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: "Sports" }));
    }
    const handle = mountChannelBrowser(root, { channels: many });
    const viewport = root.querySelector<HTMLElement>("[data-browser-viewport]")!;
    const spacer = root.querySelector<HTMLElement>("[data-browser-spacer]")!;
    expect(viewport.childElementCount).toBeGreaterThan(0);
    expect(viewport.childElementCount).toBeLessThan(40);
    expect(spacer.style.height).toBe(`${600 * BROWSER_ROW_HEIGHT}px`);
    handle.destroy();
  });

  it("renders the 4-column row: Ch. / Channel / Now / Next with progress", () => {
    const handle = mountChannelBrowser(root, {
      channels: CHANNELS,
      nowNextFor: (channel) => NOW_NEXT[Number(channel.id)] ?? { current: null, next: null },
    });
    expect(root.querySelectorAll("[data-browser-row]").length).toBeGreaterThan(0);
    const headCells = [...root.querySelectorAll<HTMLElement>(".rs-livetv-browser__head-cell")].map(
      (cell) => cell.textContent,
    );
    expect(headCells).toEqual(["Ch.", "Channel", "Now", "Next"]);
    const row = root.querySelector<HTMLElement>('[data-browser-row][data-channel-id="2"]')!;
    expect(row.querySelector(".rs-livetv-browser__now")?.textContent).toContain("Brazilian Grand Prix");
    expect(row.querySelector(".rs-livetv-browser__next")?.textContent).toContain("Build-Up");
    expect(row.querySelector(".rs-livetv-browser__progress > span")).not.toBeNull();
    handle.destroy();
  });

  it("clicking a row highlights only — it never tunes", () => {
    const onSelect = vi.fn();
    const onHighlight = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onSelect, onHighlight });
    const row = root.querySelector<HTMLElement>('[data-browser-row][data-channel-id="2"]')!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onHighlight).toHaveBeenCalledTimes(1);
    expect(onHighlight.mock.calls[0][0].id).toBe(2);
    expect(onSelect).not.toHaveBeenCalled();
    expect(handle.getHighlightedId()).toBe(2);
    // Highlight re-renders the visible window, so re-query the row.
    const rerendered = root.querySelector<HTMLElement>('[data-browser-row][data-channel-id="2"]')!;
    expect(rerendered.getAttribute("aria-selected")).toBe("true");
    handle.destroy();
  });

  it("highlight never dispatches a tune or mode event", () => {
    const tuneSpy = vi.fn();
    const modeSpy = vi.fn();
    window.addEventListener("livetv:tune", tuneSpy);
    window.addEventListener("livetv:mode", modeSpy);
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "ArrowDown");
    keyOn(list, "ArrowDown");
    const row = root.querySelector<HTMLElement>('[data-browser-row][data-channel-id="3"]')!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handle.getHighlightedId()).toBe(3);
    expect(tuneSpy).not.toHaveBeenCalled();
    expect(modeSpy).not.toHaveBeenCalled();
    window.removeEventListener("livetv:tune", tuneSpy);
    window.removeEventListener("livetv:mode", modeSpy);
    handle.destroy();
  });

  it("Watch Live in the panel, Enter and double-click tune — and only those", () => {
    const onSelect = vi.fn();
    const handle = mountChannelBrowser(root, {
      channels: CHANNELS,
      onSelect,
      initialFocusId: 3,
      nowNextFor: (channel) => NOW_NEXT[Number(channel.id)] ?? { current: null, next: null },
    });
    const watch = root.querySelector<HTMLElement>("[data-browser-watch-live]")!;
    expect(watch.getAttribute("data-channel-id")).toBe("3");
    watch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe(3);

    handle.highlightChannel(1);
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "Enter");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls[1][0].id).toBe(1);

    const row = root.querySelector<HTMLElement>('[data-browser-row][data-channel-id="2"]')!;
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect.mock.calls[2][0].id).toBe(2);
    handle.destroy();
  });

  it("View Guide in the panel dispatches livetv:mode guide", () => {
    const modeSpy = vi.fn();
    window.addEventListener("livetv:mode", modeSpy);
    const handle = mountChannelBrowser(root, { channels: CHANNELS, initialFocusId: 2 });
    const guide = root.querySelector<HTMLElement>("[data-browser-guide]")!;
    guide.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(modeSpy).toHaveBeenCalledTimes(1);
    expect(modeSpy.mock.calls[0][0].detail).toEqual({ mode: "guide" });
    window.removeEventListener("livetv:mode", modeSpy);
    handle.destroy();
  });

  it("the contextual panel follows the highlight (Now/Next + actions)", () => {
    const handle = mountChannelBrowser(root, {
      channels: CHANNELS,
      nowNextFor: (channel) => NOW_NEXT[Number(channel.id)] ?? { current: null, next: null },
    });
    expect(root.querySelector("[data-browser-detail]")?.textContent).toContain("Select a channel");
    handle.highlightChannel(2);
    const detail = root.querySelector<HTMLElement>("[data-browser-detail]")!;
    expect(detail.textContent).toContain("Alpha Sports");
    expect(detail.textContent).toContain("Brazilian Grand Prix");
    expect(detail.textContent).toContain("Build-Up");
    expect(detail.querySelector("[data-browser-watch-live]")).not.toBeNull();
    expect(detail.querySelector("[data-browser-favourite]")).not.toBeNull();
    expect(detail.querySelector("[data-browser-guide]")).not.toBeNull();
    // Favourite state is visible on the panel button.
    expect(detail.querySelector("[data-browser-favourite]")?.getAttribute("aria-pressed")).toBe("true");
    handle.destroy();
  });

  it("autoHighlightFirst populates the panel from the first paint", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS, autoHighlightFirst: true });
    expect(handle.getHighlightedId()).toBe(1);
    expect(root.querySelector("[data-browser-detail]")?.textContent).toContain("Zebra News");
    handle.destroy();
  });

  it("arrow keys move the highlight without tuning", () => {
    const onSelect = vi.fn();
    const onHighlight = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onSelect, onHighlight });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "ArrowDown");
    expect(handle.getHighlightedId()).toBe(1);
    keyOn(list, "ArrowDown");
    expect(handle.getHighlightedId()).toBe(2);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onHighlight).toHaveBeenCalledTimes(2);
    handle.destroy();
  });

  it("LB/RB cycle categories in selector order ([ / ])", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS, recentIds: [1, 2] });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    expect(handle.getCategoryId()).toBe("all");
    keyOn(list, "]");
    expect(handle.getCategoryId()).toBe("favourites");
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("2 channels");
    keyOn(list, "]");
    expect(handle.getCategoryId()).toBe("recents");
    keyOn(list, "[");
    expect(handle.getCategoryId()).toBe("favourites");
    keyOn(list, "[");
    expect(handle.getCategoryId()).toBe("all");
    handle.destroy();
  });

  it("LT/RT jump a page (PageUp / PageDown)", () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 20; i++) {
      many.push(ch({ id: i, name: `Channel ${i}`, categoryId: "Sports" }));
    }
    const handle = mountChannelBrowser(root, { channels: many });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "ArrowDown");
    expect(handle.getHighlightedId()).toBe(1);
    // jsdom viewport height falls back to 600px → page is 7 rows.
    keyOn(list, "PageDown");
    expect(handle.getHighlightedId()).toBe(8);
    keyOn(list, "PageDown");
    expect(handle.getHighlightedId()).toBe(15);
    keyOn(list, "PageUp");
    expect(handle.getHighlightedId()).toBe(8);
    handle.destroy();
  });

  it("X toggles the favourite on the highlighted channel", () => {
    const onToggleFavourite = vi.fn(() => true);
    const onSelect = vi.fn();
    const handle = mountChannelBrowser(root, {
      channels: CHANNELS,
      onSelect,
      onToggleFavourite,
    });
    handle.highlightChannel(2);
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "x");
    expect(onToggleFavourite).toHaveBeenCalledTimes(1);
    expect(onToggleFavourite).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(onSelect).not.toHaveBeenCalled();
    // The panel Favourite button toggles the same way.
    const favBtn = root.querySelector<HTMLElement>("[data-browser-favourite]")!;
    favBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggleFavourite).toHaveBeenCalledTimes(2);
    handle.destroy();
  });

  it("Y focuses search; typing filters the list", () => {
    vi.useFakeTimers();
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "y");
    const input = root.querySelector<HTMLInputElement>("[data-browser-search]")!;
    expect(document.activeElement).toBe(input);
    expect(handle.isSearchOpen()).toBe(true);
    input.value = "sports";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Before the debounce fires the list is unfiltered.
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("4 channels");
    vi.advanceTimersByTime(200);
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("2 channels");
    handle.destroy();
  });

  it("search is debounced and filters the list", () => {
    vi.useFakeTimers();
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    const input = root.querySelector<HTMLInputElement>("[data-browser-search]")!;
    input.value = "sports";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Before the debounce fires the list is unfiltered.
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("4 channels");
    vi.advanceTimersByTime(200);
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("2 channels");
    handle.destroy();
  });

  it("a collection event switches the category", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS, browserId: "home" });
    window.dispatchEvent(
      new CustomEvent("livetv:browser-category", { detail: { browserId: "home", categoryId: "sports" } }),
    );
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("2 channels");
    // An event naming another browser is ignored.
    window.dispatchEvent(
      new CustomEvent("livetv:browser-category", { detail: { browserId: "playback", categoryId: "news" } }),
    );
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("2 channels");
    handle.destroy();
  });

  it("initialFocusId returns focus to the last highlighted channel", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS, initialFocusId: 3 });
    expect(handle.getHighlightedId()).toBe(3);
    const row = root.querySelector<HTMLElement>('[data-browser-row][data-channel-id="3"]');
    expect(row?.getAttribute("aria-selected")).toBe("true");
    handle.destroy();
  });

  it("entry filters apply on open (all / favourites / recents / category)", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS, recentIds: [4, 1] });
    handle.applyEntry({ kind: "favourites" });
    expect(handle.getCategoryId()).toBe("favourites");
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([2, 4]);
    handle.applyEntry({ kind: "category", value: "sports" });
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([2, 4]);
    handle.applyEntry({ kind: "recents" });
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([4, 1]);
    handle.applyEntry({ kind: "all" });
    expect(handle.getVisibleChannels().map((c) => c.id)).toEqual([1, 2, 3, 4]);
    // An unknown category falls back to All rather than an empty list.
    handle.applyEntry({ kind: "category", value: "no-such-group" });
    expect(handle.getCategoryId()).toBe("all");
    handle.destroy();
  });

  it("a livetv:mode browser entry applies the filter and opens search", () => {
    const handle = mountChannelBrowser(root, {
      channels: CHANNELS,
      acceptModeEntry: true,
    });
    window.dispatchEvent(
      new CustomEvent("livetv:mode", {
        detail: { mode: "browser", browserFilter: { kind: "favourites" }, openSearch: true },
      }),
    );
    expect(handle.getCategoryId()).toBe("favourites");
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("2 channels");
    expect(document.activeElement).toBe(root.querySelector("[data-browser-search]"));
    handle.destroy();
  });

  it("a livetv:mode browser entry is ignored without acceptModeEntry", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    window.dispatchEvent(
      new CustomEvent("livetv:mode", {
        detail: { mode: "browser", browserFilter: { kind: "favourites" } },
      }),
    );
    expect(handle.getCategoryId()).toBe("all");
    handle.destroy();
  });

  it("B (livetv:back) closes search first, then exits", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const handle = mountChannelBrowser(root, {
      channels: CHANNELS,
      onClose,
      acceptModeEntry: true,
    });
    handle.openSearch();
    const input = root.querySelector<HTMLInputElement>("[data-browser-search]")!;
    input.value = "sports";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("2 channels");

    window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    expect(handle.isSearchOpen()).toBe(false);
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("4 channels");
    expect(onClose).not.toHaveBeenCalled();

    // A second back is a new press (past the coalescing window).
    vi.advanceTimersByTime(300);
    window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("B for another context is ignored", () => {
    const onClose = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onClose });
    window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "guide" } }));
    expect(onClose).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("Escape exits when search is closed", () => {
    const onClose = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onClose });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    keyOn(list, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("selection + scroll survive a data refresh", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.highlightChannel(3);
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    list.scrollTop = 500;
    handle.setChannels([
      ch({ id: 5, name: "New Channel", categoryId: "News" }),
      ...CHANNELS,
    ]);
    expect(handle.getHighlightedId()).toBe(3);
    expect(list.scrollTop).toBe(500);
    expect(root.querySelector("[data-browser-status]")?.textContent).toContain("5 channels");
    // The highlighted channel dropping out of the catalogue clears it.
    handle.setChannels([ch({ id: 5, name: "New Channel", categoryId: "News" })]);
    expect(handle.getHighlightedId()).toBeNull();
    handle.destroy();
  });
});
