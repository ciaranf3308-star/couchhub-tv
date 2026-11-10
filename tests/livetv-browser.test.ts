/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BROWSER_ROW_HEIGHT,
  applyBrowserFilter,
  browserCategories,
  mountChannelBrowser,
} from "@/scripts/lib/livetv-browser";
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
  ch({ id: 2, name: "Alpha Sports", categoryId: "Sports", favourite: true }),
  ch({ id: 3, name: "Mid Movies", categoryId: "Movies" }),
  ch({ id: 4, name: "Beta Sports", categoryId: "Sports", favourite: true }),
];

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
});

describe("browserCategories", () => {
  it("lists All, Favourites, Recently watched, then groups — and omits empty pseudo-categories", () => {
    const cats = browserCategories(CHANNELS, [1, 2]);
    expect(cats.map((c) => c.id)).toEqual(["all", "favourites", "recents", "sports", "news", "movies"]);
    expect(cats.find((c) => c.id === "all")?.count).toBe(4);
    expect(cats.find((c) => c.id === "favourites")?.count).toBe(2);
    expect(cats.find((c) => c.id === "recents")?.count).toBe(2);
  });

  it("omits Favourites / Recently watched when empty", () => {
    const cats = browserCategories([ch({ id: 1, name: "A", categoryId: "News" })], []);
    expect(cats.map((c) => c.id)).toEqual(["all", "news"]);
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

  it("the Watch button, Enter and double-click tune — and only those", () => {
    const onSelect = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onSelect });
    const watch = root.querySelector<HTMLElement>('[data-browser-watch][data-channel-id="3"]')!;
    watch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe(3);

    handle.highlightChannel(1);
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls[1][0].id).toBe(1);
    handle.destroy();
  });

  it("arrow keys move the highlight without tuning", () => {
    const onSelect = vi.fn();
    const onHighlight = vi.fn();
    const handle = mountChannelBrowser(root, { channels: CHANNELS, onSelect, onHighlight });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(handle.getHighlightedId()).toBe(1);
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(handle.getHighlightedId()).toBe(2);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onHighlight).toHaveBeenCalledTimes(2);
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
});
