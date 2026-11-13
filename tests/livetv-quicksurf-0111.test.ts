/**
 * @vitest-environment jsdom
 */
/**
 * Quick Surf rebuild (0.11.11, W1) — focused tests for the new /
 * changed behaviour only: category-wall removal, bounded
 * navigation, scope-aware list resolution through the shared
 * category index, highlight-never-tunes, the W1↔W2 seam contract,
 * and close-on-event. The shared wrapping stepHighlight /
 * surfWindow keep their own suites (livetv-playback.test.ts);
 * Quick Surf no longer calls them.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  buildCategoryIndex,
  normaliseCategoryLabel,
  resetCategoryIndexCache,
  resetCategoryIndexCounters,
} from "@/scripts/lib/livetv-category-index";
import {
  stepHighlightBounded,
  surfWindowBounded,
  resolveQuickSurfList,
  quickSurfScopeLabel,
  groupLabelForChannel,
  resolveHighlightInList,
  quickSurfPositionText,
  createQuickSurfOpenBrowserDetail,
  parseQuickSurfScopeDetail,
  isQuickSurfBrowserAction,
  QUICK_SURF_OPEN_BROWSER_EVENT,
  QUICK_SURF_CLOSE_EVENT,
  QUICK_SURF_SET_SCOPE_EVENT,
  QUICK_SURF_BROWSER_ACTIONS,
  QUICK_SURF_WINDOW_SIZE,
} from "@/scripts/lib/livetv-quicksurf";
import {
  confirmHighlight,
  switchChannel,
  type PlaybackEngine,
} from "@/scripts/lib/livetv-playback";
import type { LivetvChannel } from "@/scripts/lib/livetv-data";

function ch(
  partial: Partial<LivetvChannel> & { id: string | number; name: string },
): LivetvChannel {
  const rawCategory = partial.categoryId ?? partial.category ?? "";
  return {
    displayName: partial.name,
    logo: null,
    category: rawCategory,
    categoryId: rawCategory,
    categoryLabel:
      partial.categoryLabel ?? normaliseCategoryLabel(rawCategory),
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

beforeEach(() => {
  resetCategoryIndexCache();
  resetCategoryIndexCounters();
});

// Mixed catalogue in provider order: local channels first, then
// sports, then movies, then an unrelated provider group — the
// drift case from the brief (a UK channel must never surf into a
// US provider group under a scope).
const catalogue: LivetvChannel[] = [
  ch({ id: 101, name: "RTE One", categoryId: "Ireland Channels" }),
  ch({ id: 102, name: "RTE 2", categoryId: "Ireland Channels" }),
  ch({ id: 103, name: "BBC One", categoryId: "UK Channels" }),
  ch({ id: 104, name: "Sky Sports", categoryId: "Sports" }),
  ch({ id: 105, name: "ESPN", categoryId: "Sports" }),
  ch({ id: 106, name: "Film4", categoryId: "Movies" }),
  ch({ id: 107, name: "TCM", categoryId: "Movies" }),
  ch({ id: 108, name: "US Cooking", categoryId: "USA Cooking" }),
];

describe("stepHighlightBounded — bounded navigation, no wrap", () => {
  it("steps one adjacent channel at a time", () => {
    expect(stepHighlightBounded(catalogue, 102, 1)).toBe(103);
    expect(stepHighlightBounded(catalogue, 102, -1)).toBe(101);
  });

  it("retains position at the end of the list (no wrap to channel 1)", () => {
    expect(stepHighlightBounded(catalogue, 108, 1)).toBeNull();
  });

  it("retains position at the beginning of the list (no wrap to the last channel)", () => {
    expect(stepHighlightBounded(catalogue, 101, -1)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(stepHighlightBounded([], 101, 1)).toBeNull();
    expect(stepHighlightBounded([], 101, -1)).toBeNull();
  });

  it("steps to the first / last entry when the highlight is outside the list", () => {
    expect(stepHighlightBounded(catalogue, null, 1)).toBe(101);
    expect(stepHighlightBounded(catalogue, null, -1)).toBe(108);
    expect(stepHighlightBounded(catalogue, 999, 1)).toBe(101);
    expect(stepHighlightBounded(catalogue, 999, -1)).toBe(108);
  });

  it("matches ids String-compared (shell dataset ids are strings)", () => {
    expect(stepHighlightBounded(catalogue, "102", 1)).toBe(103);
    expect(stepHighlightBounded(catalogue, "101", -1)).toBeNull();
  });
});

describe("surfWindowBounded — clamped window, no wrap", () => {
  it("shows two before, highlight, two after in the middle of the list", () => {
    const win = surfWindowBounded(catalogue, 104, 5);
    expect(win.entries.map((c) => c.id)).toEqual([102, 103, 104, 105, 106]);
    expect(win.position).toBe(4);
    expect(win.total).toBe(8);
  });

  it("clamps at the start: the first window never contains the last channel", () => {
    const win = surfWindowBounded(catalogue, 101, 5);
    expect(win.entries.map((c) => c.id)).toEqual([101, 102, 103, 104, 105]);
    expect(win.position).toBe(1);
  });

  it("clamps at the end: the last window never contains the first channel", () => {
    const win = surfWindowBounded(catalogue, 108, 5);
    expect(win.entries.map((c) => c.id)).toEqual([104, 105, 106, 107, 108]);
    expect(win.position).toBe(8);
  });

  it("keeps the highlight visible one step in from each end", () => {
    expect(surfWindowBounded(catalogue, 102, 5).entries.map((c) => c.id)).toEqual(
      [101, 102, 103, 104, 105],
    );
    expect(surfWindowBounded(catalogue, 107, 5).entries.map((c) => c.id)).toEqual(
      [104, 105, 106, 107, 108],
    );
  });

  it("handles short and empty lists", () => {
    const short = catalogue.slice(0, 3);
    expect(surfWindowBounded(short, 102, 5).entries.map((c) => c.id)).toEqual([101, 102, 103]);
    expect(surfWindowBounded([], 101, 5)).toEqual({ entries: [], position: 0, total: 0 });
  });

  it("defaults to the 5-entry Quick Surf window", () => {
    expect(QUICK_SURF_WINDOW_SIZE).toBe(5);
    expect(surfWindowBounded(catalogue, 104).entries).toHaveLength(5);
  });
});

describe("resolveQuickSurfList — scope-aware, shared index only", () => {
  it("resolves the whole catalogue in provider order with no scope", () => {
    const index = buildCategoryIndex(catalogue, 1);
    expect(resolveQuickSurfList(index, null).map((c) => c.id)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 108,
    ]);
  });

  it("resolves only the scoped group's channels (no drift across groups)", () => {
    const index = buildCategoryIndex(catalogue, 1);
    // Irish & UK scope: the local channels only — stepping here
    // can never drift into Sports, Movies, or the US group.
    expect(resolveQuickSurfList(index, "irish-uk").map((c) => c.id)).toEqual([101, 102, 103]);
    expect(resolveQuickSurfList(index, "sports").map((c) => c.id)).toEqual([104, 105]);
    expect(resolveQuickSurfList(index, "movies").map((c) => c.id)).toEqual([106, 107]);
  });

  it("returns the SAME array reference for the same scope (memoised — no per-press re-filter)", () => {
    const index = buildCategoryIndex(catalogue, 1);
    expect(resolveQuickSurfList(index, "sports")).toBe(resolveQuickSurfList(index, "sports"));
    expect(resolveQuickSurfList(index, null)).toBe(resolveQuickSurfList(index, null));
  });

  it("yields [] for an unknown group id (the component falls back to All)", () => {
    const index = buildCategoryIndex(catalogue, 1);
    expect(resolveQuickSurfList(index, "no-such-group")).toEqual([]);
  });

  it("labels scopes from the index, falling back to All channels", () => {
    const index = buildCategoryIndex(catalogue, 1);
    expect(quickSurfScopeLabel(index, null)).toBe("All channels");
    expect(quickSurfScopeLabel(index, "irish-uk")).toBe("Irish & UK");
    expect(quickSurfScopeLabel(index, "sports")).toBe("Sports");
    expect(quickSurfScopeLabel(index, "no-such-group")).toBe("All channels");
  });

  it("names the group a channel belongs to for the header", () => {
    expect(groupLabelForChannel(catalogue[0])).toBe("Irish & UK");
    expect(groupLabelForChannel(catalogue[3])).toBe("Sports");
    expect(groupLabelForChannel(null)).toBe("All channels");
  });
});

describe("resolveHighlightInList — highlight stays inside the scope", () => {
  it("prefers the current highlight when it is in the list", () => {
    const scoped = catalogue.slice(3, 5);
    expect(resolveHighlightInList(scoped, 105, 104)).toBe(105);
  });

  it("falls back to the tuned channel, then the first entry", () => {
    const scoped = catalogue.slice(3, 5);
    expect(resolveHighlightInList(scoped, 101, 104)).toBe(104);
    expect(resolveHighlightInList(scoped, 101, 999)).toBe(104);
  });

  it("returns null for an empty list and canonical (list-owned) ids", () => {
    expect(resolveHighlightInList([], 101, 102)).toBeNull();
    // String highlight against numeric ids resolves to the numeric id.
    expect(resolveHighlightInList(catalogue, "103", null)).toBe(103);
  });
});

describe("quickSurfPositionText", () => {
  it("formats position within the scope, empty when there is nothing to show", () => {
    expect(quickSurfPositionText(5, 42)).toBe("5 / 42");
    expect(quickSurfPositionText(0, 0)).toBe("");
  });
});

describe("seam contract — quick-surf:open-browser detail", () => {
  it("uses the exact event names", () => {
    expect(QUICK_SURF_OPEN_BROWSER_EVENT).toBe("quick-surf:open-browser");
    expect(QUICK_SURF_CLOSE_EVENT).toBe("quick-surf:close");
    expect(QUICK_SURF_SET_SCOPE_EVENT).toBe("quick-surf:set-scope");
  });

  it("offers exactly the four discovery actions", () => {
    expect([...QUICK_SURF_BROWSER_ACTIONS]).toEqual([
      "favourites",
      "recents",
      "categories",
      "search",
    ]);
  });

  it("builds the exact detail shape: action, tuned channelId, categoryScope", () => {
    expect(createQuickSurfOpenBrowserDetail("categories", 103, "irish-uk")).toEqual({
      action: "categories",
      channelId: 103,
      categoryScope: "irish-uk",
    });
    expect(createQuickSurfOpenBrowserDetail("search", null, null)).toEqual({
      action: "search",
      channelId: null,
      categoryScope: null,
    });
    // Undefined normalises to null — the detail never carries undefined.
    expect(createQuickSurfOpenBrowserDetail("favourites", undefined, undefined)).toEqual({
      action: "favourites",
      channelId: null,
      categoryScope: null,
    });
  });

  it("accepts 'browse' for the Y key: unfiltered full-browser open", () => {
    expect(createQuickSurfOpenBrowserDetail("browse", 103, "irish-uk")).toEqual({
      action: "browse",
      channelId: 103,
      categoryScope: "irish-uk",
    });
  });

  it("guards action values from markup (four buttons only — 'browse' is Y-only)", () => {
    expect(isQuickSurfBrowserAction("recents")).toBe(true);
    expect(isQuickSurfBrowserAction("browse")).toBe(false);
    expect(isQuickSurfBrowserAction("guide")).toBe(false);
    expect(isQuickSurfBrowserAction(undefined)).toBe(false);
  });

  it("dispatches the contract event with the detail intact (window event shape)", () => {
    const seen: Array<unknown> = [];
    const handler = (ev: Event) => seen.push((ev as CustomEvent).detail);
    window.addEventListener(QUICK_SURF_OPEN_BROWSER_EVENT, handler);
    try {
      window.dispatchEvent(
        new CustomEvent(QUICK_SURF_OPEN_BROWSER_EVENT, {
          detail: createQuickSurfOpenBrowserDetail("recents", "102", null),
        }),
      );
      expect(seen).toEqual([
        { action: "recents", channelId: "102", categoryScope: null },
      ]);
    } finally {
      window.removeEventListener(QUICK_SURF_OPEN_BROWSER_EVENT, handler);
    }
  });
});

describe("quick-surf:set-scope parsing (additive inbound seam)", () => {
  it("accepts a scope group id and an explicit clear", () => {
    expect(parseQuickSurfScopeDetail({ categoryScope: "sports" })).toBe("sports");
    expect(parseQuickSurfScopeDetail({ categoryScope: null })).toBeNull();
    expect(parseQuickSurfScopeDetail({ categoryScope: "" })).toBeNull();
  });

  it("ignores details with no usable scope", () => {
    expect(parseQuickSurfScopeDetail({})).toBeUndefined();
    expect(parseQuickSurfScopeDetail({ categoryScope: 42 })).toBeUndefined();
    expect(parseQuickSurfScopeDetail(null)).toBeUndefined();
    expect(parseQuickSurfScopeDetail("sports")).toBeUndefined();
  });
});

describe("highlight-never-tunes under the bounded rebuild", () => {
  function fakeEngine(): PlaybackEngine & { tuned: Array<string | number> } {
    const tuned: Array<string | number> = [];
    return { tuned, tune: (id) => tuned.push(id) };
  }

  it("browsing a whole scoped list end to end never tunes and never wraps", () => {
    const engine = fakeEngine();
    const index = buildCategoryIndex(catalogue, 1);
    const scoped = resolveQuickSurfList(index, "irish-uk");
    let highlighted: string | number | null = 101;
    const tunedId = 101;
    // Step down past the end: the highlight sticks at 103.
    for (let i = 0; i < 10; i++) {
      const next = stepHighlightBounded(scoped, highlighted, 1);
      if (next !== null) highlighted = next;
      surfWindowBounded(scoped, highlighted);
    }
    expect(highlighted).toBe(103);
    expect(engine.tuned).toEqual([]);
    expect(tunedId).toBe(101);
  });

  it("only a confirm tunes, through the release-before-tune gate", () => {
    const released: Array<string | number | null | undefined> = [];
    const tuned: Array<string | number> = [];
    const engine: PlaybackEngine = {
      tune: (id) => tuned.push(id),
      release: (id) => released.push(id),
    };
    const target = confirmHighlight(103);
    expect(switchChannel(engine, 101, target)).toBe(true);
    expect(released).toEqual([101]);
    expect(tuned).toEqual([103]);
  });
});

// The component script itself is not importable in vitest, so the
// structural guarantees are pinned against its source — the same
// approach the existing Quick Surf suite uses.
describe("TvQuickSurf.astro — 0.11.11 rebuild structure", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src/components/couch/TvQuickSurf.astro"),
    "utf8",
  );

  it("deletes the raw provider-category button wall (no per-category generation)", () => {
    expect(src).not.toContain("rs-livetv-play-quicksurf__categories");
    expect(src).not.toContain("rs-livetv-play-quicksurf__chip");
    expect(src).not.toContain("[data-qs-categories]");
    expect(src).not.toContain("new Set(channels.map");
    expect(src).not.toContain("category ? channels.filter");
    expect(src).not.toContain("const surfList");
  });

  it("never calls the wrapping stepHighlight / surfWindow", () => {
    expect(src).not.toContain("stepHighlight(");
    expect(src).not.toContain("surfWindow(");
    expect(src).toContain("stepHighlightBounded");
    expect(src).toContain("surfWindowBounded");
  });

  it("resolves its list through the shared category index", () => {
    expect(src).toContain("getCategoryIndex");
    expect(src).toContain("resolveQuickSurfList");
    expect(src).toContain("scopedList");
  });

  it("renders exactly the four discovery actions as focusable buttons", () => {
    for (const action of QUICK_SURF_BROWSER_ACTIONS) {
      expect(src).toContain(`data-qs-discovery="${action}"`);
    }
    expect(src).toContain("rs-livetv-play-quicksurf__discovery-action");
    expect(src).toContain("Favourites");
    expect(src).toContain("Recently Watched");
    expect(src).toContain("Categories");
    expect(src).toContain(">Search<");
  });

  it("dispatches the exact seam event and listens for close + scope", () => {
    expect(src).toContain("QUICK_SURF_OPEN_BROWSER_EVENT");
    expect(src).toContain("createQuickSurfOpenBrowserDetail");
    expect(src).toContain("QUICK_SURF_CLOSE_EVENT");
    expect(src).toContain("QUICK_SURF_SET_SCOPE_EVENT");
    expect(src).toContain("quick-surf:open-browser");
    expect(src).toContain("quick-surf:close");
  });

  it("owns Y while open: dispatches the seam event with action 'browse'", () => {
    expect(src).toContain('ev.key === "y" || ev.key === "Y"');
    expect(src).toContain('openBrowser("browse")');
    expect(src).toContain("QuickSurfBrowserRequestAction");
  });

  it("keeps the compact panel, group header, rows, and honest hints", () => {
    expect(src).toContain("rs-livetv-play-quicksurf__panel");
    expect(src).toContain("[data-qs-group]");
    expect(src).toContain("[data-qs-position]");
    expect(src).toContain("[data-qs-list]");
    expect(src).toContain("TvChannelRow");
    expect(src).toContain("↑↓ browse · ←→ discovery · A select · B back · X guide · Y browser");
  });

  it("keeps the highlighted-only artwork enrichment with cancellation", () => {
    expect(src).toContain("scheduleHighlightedArt");
    expect(src).toContain("artGeneration++");
  });
});
