/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  COUCH_NAV_PRIMARY,
  COUCH_NAV_LIBRARY,
  COUCH_NAV_SETTINGS,
  COUCH_DESTINATIONS,
  normalizeCouchPath,
  couchNavIdFor,
  isCouchRoute,
} from "@/scripts/lib/couch-nav";
import {
  isUsableImageSrc,
  fallbackMarkFor,
  applyImageFallback,
  armTvImageFallbacks,
} from "@/scripts/lib/couch-image";
import {
  computeVisibleWindow,
  gridColumnsForWidth,
} from "@/scripts/lib/couch-grid";
import {
  recordCouchFocus,
  readCouchFocusMemory,
  clearCouchFocusMemory,
  restoreCouchFocus,
  findReplacementFocus,
  openCouchDialog,
  closeCouchDialog,
  initCouchFocus,
} from "@/scripts/lib/couch-focus";
import { findOpenModal } from "@/scripts/lib/dialog-spatial-nav";

// Node 24+ ships an experimental native `localStorage` /
// `sessionStorage` (undefined without --localstorage-file) that shadows
// jsdom's; stub both with real in-memory Storage.
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const sessionStorageMock = makeStorage();
const localStorageMock = makeStorage();
Object.defineProperty(window, "sessionStorage", { value: sessionStorageMock });
Object.defineProperty(window, "localStorage", { value: localStorageMock });

// jsdom reports zero-size boxes for everything; pretend every element
// has a box so the visibility checks in the focus layer behave like a
// real viewport — except a closed <dialog>, which a real browser
// renders as display:none (no box).
const boxRect = () => ({ width: 100, height: 100 }) as unknown as DOMRectList;
const emptyRects = () => [] as unknown as DOMRectList;
Element.prototype.getClientRects = function () {
  if (this.tagName === "DIALOG" && !this.hasAttribute("open")) return emptyRects();
  return boxRect();
};
Element.prototype.getBoundingClientRect = function () {
  if (this.tagName === "DIALOG" && !this.hasAttribute("open")) {
    return { width: 0, height: 0 } as DOMRect;
  }
  return { width: 100, height: 100 } as DOMRect;
};
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function () {};
}

function railHtml(id: string, count: number, keyPrefix: string): string {
  const items = Array.from(
    { length: count },
    (_, i) =>
      `<a href="#x" data-nylah-item data-couch-key="${keyPrefix}-${i + 1}">Item ${i + 1}</a>`,
  ).join("");
  return `<section data-nylah-rail="${id}">${items}</section>`;
}

describe("couch-nav destination table", () => {
  it("normalizes paths", () => {
    expect(normalizeCouchPath("/movies/")).toBe("/movies");
    expect(normalizeCouchPath("")).toBe("/");
    expect(normalizeCouchPath("/")).toBe("/");
  });

  it("maps every primary route to its nav id", () => {
    expect(couchNavIdFor("/")).toBe("home");
    expect(couchNavIdFor("/livetv")).toBe("livetv");
    expect(couchNavIdFor("/epg")).toBe("livetv");
    expect(couchNavIdFor("/browse")).toBe("browse");
    expect(couchNavIdFor("/favorites")).toBe("favorites");
    expect(couchNavIdFor("/watchlist")).toBe("watchlist");
    expect(couchNavIdFor("/settings")).toBe("settings");
  });

  it("maps the pre-consolidation routes to browse", () => {
    // Browse consolidation (0.8.0): the old Movies / Series / Discover
    // / Search destinations redirect into the Browse flow, and their
    // detail pages resolve to the Browse section.
    expect(couchNavIdFor("/movies")).toBe("browse");
    expect(couchNavIdFor("/movies/detail?id=1")).toBe("browse");
    expect(couchNavIdFor("/series")).toBe("browse");
    expect(couchNavIdFor("/series/detail")).toBe("browse");
    expect(couchNavIdFor("/discover")).toBe("browse");
    expect(couchNavIdFor("/search")).toBe("browse");
  });

  it("has exactly one Browse tab and no Movies / Series / Discover / Search tabs", () => {
    const ids = COUCH_NAV_PRIMARY.map((item) => item.id);
    expect(ids).toEqual(["home", "livetv", "browse", "followed"]);
    expect(ids.filter((id) => id === "browse")).toHaveLength(1);
    expect(COUCH_DESTINATIONS.browse).toBe("/browse");
    expect(COUCH_DESTINATIONS.movies).toBeUndefined();
    expect(COUCH_DESTINATIONS.series).toBeUndefined();
    expect(COUCH_DESTINATIONS.discover).toBeUndefined();
    expect(COUCH_DESTINATIONS.search).toBeUndefined();
  });

  it("returns null outside the Couch UI", () => {
    expect(couchNavIdFor("/tv/live")).toBeNull();
    expect(couchNavIdFor("/login")).toBeNull();
    expect(couchNavIdFor("/receiver")).toBeNull();
    expect(isCouchRoute("/tv/live")).toBe(false);
    expect(isCouchRoute("/discover")).toBe(true);
    expect(isCouchRoute("/browse")).toBe(true);
  });

  it("covers every nav entry in the destination table", () => {
    for (const item of [
      ...COUCH_NAV_PRIMARY,
      ...COUCH_NAV_LIBRARY,
      COUCH_NAV_SETTINGS,
    ]) {
      expect(COUCH_DESTINATIONS[item.id]).toBe(item.href);
    }
    // Library is a compact group, not a submenu: both destinations
    // are first-class nav ids.
    expect(COUCH_DESTINATIONS.favorites).toBe("/favorites");
    expect(COUCH_DESTINATIONS.watchlist).toBe("/watchlist");
  });
});

describe("couch-image fallback", () => {
  it("rejects blank/missing src", () => {
    expect(isUsableImageSrc(undefined)).toBe(false);
    expect(isUsableImageSrc("   ")).toBe(false);
    expect(isUsableImageSrc("/art/hero-backdrop.jpg")).toBe(true);
  });

  it("derives fallback marks from titles", () => {
    expect(fallbackMarkFor("poster", "Dune")).toBe("D");
    expect(fallbackMarkFor("poster", "Nylah Studios")).toBe("NS");
    expect(fallbackMarkFor("poster", "")).toBe("N");
    expect(fallbackMarkFor("logo", "Anything")).toBe("N");
  });

  it("swaps a broken img to its fallback block, never leaving a broken icon", () => {
    document.body.innerHTML =
      `<div data-tv-image><img data-tv-image-img src="https://example.invalid/x.jpg" alt=""><div class="rs-image__fallback"></div></div>`;
    const img = document.querySelector("img") as HTMLImageElement;
    expect(applyImageFallback(img)).toBe(true);
    expect(
      img.closest("[data-tv-image]")?.classList.contains("is-fallback"),
    ).toBe(true);
    expect(applyImageFallback(null)).toBe(false);
  });

  it("arms a capture-phase error listener for late failures", () => {
    document.body.innerHTML =
      `<div data-tv-image><img data-tv-image-img src="https://example.invalid/y.jpg" alt=""></div>`;
    armTvImageFallbacks(document);
    const img = document.querySelector("img") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    expect(
      img.closest("[data-tv-image]")?.classList.contains("is-fallback"),
    ).toBe(true);
  });
});

describe("couch-grid windowing", () => {
  it("returns an empty window for an empty list", () => {
    const win = computeVisibleWindow({
      total: 0,
      columns: 6,
      rowHeight: 400,
      scrollTop: 0,
      viewportHeight: 1080,
    });
    expect(win.startIndex).toBe(0);
    expect(win.endIndex).toBe(0);
    expect(win.totalRows).toBe(0);
  });

  it("windows the first viewport plus overscan rows", () => {
    // 120 items, 6 cols = 20 rows; viewport shows ~2.7 rows.
    const win = computeVisibleWindow({
      total: 120,
      columns: 6,
      rowHeight: 400,
      scrollTop: 0,
      viewportHeight: 1080,
    });
    expect(win.startIndex).toBe(0);
    expect(win.endIndex).toBeLessThan(120);
    expect(win.topSpacer).toBe(0);
    expect(win.bottomSpacer).toBeGreaterThan(0);
    expect(win.endIndex - win.startIndex).toBeLessThanOrEqual(6 * 5);
  });

  it("slides the window when scrolled and clamps at the end", () => {
    const mid = computeVisibleWindow({
      total: 120,
      columns: 6,
      rowHeight: 400,
      scrollTop: 4000,
      viewportHeight: 1080,
    });
    expect(mid.startIndex).toBeGreaterThan(0);
    expect(mid.topSpacer).toBeGreaterThan(0);
    expect(mid.endIndex).toBeLessThanOrEqual(120);

    const end = computeVisibleWindow({
      total: 120,
      columns: 6,
      rowHeight: 400,
      scrollTop: 100000,
      viewportHeight: 1080,
    });
    expect(end.endIndex).toBe(120);
    expect(end.bottomSpacer).toBe(0);
  });

  it("sizes columns from container width", () => {
    expect(gridColumnsForWidth(1920, 280, 20)).toBe(6);
    expect(gridColumnsForWidth(0, 280, 20)).toBe(1);
    expect(gridColumnsForWidth(300, 280, 20)).toBe(1);
  });
});

describe("couch-focus memory", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    clearCouchFocusMemory();
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("round-trips focus memory through storage", () => {
    recordCouchFocus({ route: "/", rail: "home-rail", index: 2, key: "k-3" });
    expect(readCouchFocusMemory()).toEqual({
      route: "/",
      rail: "home-rail",
      index: 2,
      key: "k-3",
    });
  });

  it("rejects malformed stored memory", () => {
    sessionStorageMock.setItem("rs_couch_focus_memory", "{not json");
    expect(readCouchFocusMemory()).toBeNull();
  });

  it("restores the remembered card by stable key when returning to a route", () => {
    document.body.innerHTML =
      railHtml("home-rail", 4, "k") + railHtml("other-rail", 3, "o");
    // jsdom default pathname is "/".
    recordCouchFocus({ route: "/", rail: "home-rail", index: 1, key: "k-3" });
    const restored = restoreCouchFocus(document);
    expect(restored?.getAttribute("data-couch-key")).toBe("k-3");
    expect(document.activeElement).toBe(restored);
  });

  it("falls back to rail + index when the key is gone", () => {
    document.body.innerHTML = railHtml("home-rail", 4, "k");
    recordCouchFocus({ route: "/", rail: "home-rail", index: 3, key: "gone" });
    const restored = restoreCouchFocus(document);
    expect(restored?.getAttribute("data-couch-key")).toBe("k-4");
  });

  it("does not restore on a different route, or when focus is already set", () => {
    document.body.innerHTML = railHtml("home-rail", 4, "k");
    recordCouchFocus({ route: "/movies", rail: "home-rail", index: 1, key: "k-2" });
    expect(restoreCouchFocus(document)).toBeNull();
    expect(document.activeElement).toBe(document.body);

    recordCouchFocus({ route: "/", rail: "home-rail", index: 1, key: "k-2" });
    const first = document.querySelector(
      '[data-couch-key="k-1"]',
    ) as HTMLElement;
    first.focus();
    expect(restoreCouchFocus(document)).toBeNull();
    expect(document.activeElement).toBe(first);
  });

  it("finds the nearest surviving sibling when the focused card disappears", () => {
    document.body.innerHTML = railHtml("home-rail", 4, "k");
    const items = Array.from(
      document.querySelectorAll<HTMLElement>("[data-nylah-item]"),
    );
    items[1].focus();
    recordCouchFocus({ route: "/", rail: "home-rail", index: 1, key: "k-2" });
    const removed = items[1];
    removed.remove();
    const replacement = findReplacementFocus(removed, document);
    expect(replacement?.getAttribute("data-couch-key")).toBe("k-3");
  });

  it("falls back to the first item of the first rail when a rail empties", () => {
    document.body.innerHTML =
      railHtml("gone-rail", 1, "g") + railHtml("home-rail", 2, "k");
    const removed = document.querySelector(
      '[data-couch-key="g-1"]',
    ) as HTMLElement;
    recordCouchFocus({ route: "/", rail: "gone-rail", index: 0, key: "g-1" });
    removed.remove();
    const replacement = findReplacementFocus(removed, document);
    expect(replacement?.getAttribute("data-couch-key")).toBe("k-1");
  });
});

describe("couch-focus live behaviour", () => {
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML =
      railHtml("home-rail", 4, "k") + railHtml("other-rail", 3, "o");
    clearCouchFocusMemory();
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("records focus memory on keyboard focus moves and never moves focus when content loads", async () => {
    unmount = initCouchFocus();
    const second = document.querySelector(
      '[data-couch-key="k-2"]',
    ) as HTMLElement;
    second.focus();
    expect(readCouchFocusMemory()).toMatchObject({
      route: "/",
      rail: "home-rail",
      index: 1,
      key: "k-2",
    });
    // Content loading: new cards appear — focus must stay put.
    const rail = document.querySelector('[data-nylah-rail="home-rail"]')!;
    rail.insertAdjacentHTML(
      "beforeend",
      `<a href="#x" data-nylah-item data-couch-key="k-5">Item 5</a>`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(second);
  });

  it("moves focus to the nearest survivor only when the focused card is removed", async () => {
    unmount = initCouchFocus();
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-nylah-rail="home-rail"] [data-nylah-item]'),
    );
    items[1].focus();
    items[1].remove();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (document.activeElement as HTMLElement | null)?.getAttribute(
        "data-couch-key",
      ),
    ).toBe("k-3");
  });

  it("controller reconnection does not reset focus or memory", async () => {
    unmount = initCouchFocus();
    const third = document.querySelector(
      '[data-couch-key="k-3"]',
    ) as HTMLElement;
    third.focus();
    window.dispatchEvent(new Event("gamepadconnected"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(third);
    expect(readCouchFocusMemory()).toMatchObject({ key: "k-3" });
  });
});

describe("couch dialog trap", () => {
  beforeEach(() => {
    document.body.innerHTML =
      `<button id="opener" type="button">Open</button>
       <dialog id="dlg" data-nylah-dialog aria-labelledby="dlg-title">
         <h2 id="dlg-title">Dialog</h2>
         <button id="dlg-close" type="button">Close</button>
       </dialog>
       <section data-nylah-rail="home-rail"><a href="#x" data-nylah-item>Behind</a></section>`;
    clearCouchFocusMemory();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the dialog, reports it as the open modal, and returns focus to the invoker on close", () => {
    const opener = document.getElementById("opener") as HTMLElement;
    opener.focus();
    expect(openCouchDialog("dlg", opener)).toBe(true);
    expect(findOpenModal(document)?.id).toBe("dlg");
    expect(document.activeElement?.id).toBe("dlg-close");
    expect(closeCouchDialog("dlg")).toBe(true);
    expect(findOpenModal(document)).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("never pulls focus out of an open modal for replacement", () => {
    const opener = document.getElementById("opener") as HTMLElement;
    openCouchDialog("dlg", opener);
    const behind = document.querySelector(
      "[data-nylah-item]",
    ) as HTMLElement;
    behind.remove();
    expect(findReplacementFocus(behind, document)).toBeNull();
    closeCouchDialog("dlg");
  });

  it("returns false for an unknown dialog id", () => {
    expect(openCouchDialog("nope")).toBe(false);
    expect(closeCouchDialog("nope")).toBe(false);
  });
});
