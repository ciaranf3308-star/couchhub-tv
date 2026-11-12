/**
 * @vitest-environment jsdom
 */
// Controller Experience 2.0 (0.11.10, W1) — mode-aware focus memory
// (Contract D, §39) and the dialog Back mechanism (§38): view-scoped
// restoration, modal layers through the coordinator, invoker restore
// with nearest-survivor fallback, non-dismissible dialogs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BACK_PRIORITY,
  registerBackLayer,
  resolveBack,
} from "@/scripts/lib/back-handler";
import {
  clearCouchFocusMemory,
  closeCouchDialog,
  findReplacementFocus,
  getLogicalView,
  openCouchDialog,
  readCouchFocusMemory,
  recordCouchFocus,
  restoreCouchFocus,
  setLogicalView,
} from "@/scripts/lib/couch-focus";
import { attachDialogSpatialNav } from "@/scripts/lib/dialog-spatial-nav";

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
Object.defineProperty(window, "sessionStorage", { value: sessionStorageMock });

Element.prototype.getClientRects = function () {
  if (this.tagName === "DIALOG" && !this.hasAttribute("open")) {
    return [] as unknown as DOMRectList;
  }
  return [{ width: 100, height: 100 }] as unknown as DOMRectList;
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

function blurActive(): void {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) active.blur();
}

const unregisters: Array<() => void> = [];

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorageMock.clear();
  clearCouchFocusMemory();
  setLogicalView("");
  blurActive();
  window.history.replaceState(null, "", "/movies");
});

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  setLogicalView("");
  window.history.replaceState(null, "", "/");
});

describe("logical view", () => {
  it("setLogicalView / getLogicalView round-trip, default unset", () => {
    expect(getLogicalView()).toBe("");
    setLogicalView("movies-browse");
    expect(getLogicalView()).toBe("movies-browse");
    setLogicalView("");
    expect(getLogicalView()).toBe("");
  });

  it("focus memory round-trips the view field", () => {
    recordCouchFocus({
      route: "/movies",
      rail: "grid",
      index: 1,
      key: "k-2",
      view: "movies-browse",
    });
    expect(readCouchFocusMemory()).toEqual({
      route: "/movies",
      rail: "grid",
      index: 1,
      key: "k-2",
      view: "movies-browse",
    });
  });

  it("legacy memory without a view reads back view-less", () => {
    recordCouchFocus({ route: "/movies", rail: "grid", index: 0 });
    const memory = readCouchFocusMemory();
    expect(memory).not.toBeNull();
    expect(memory?.view).toBeUndefined();
  });
});

describe("view-aware restore", () => {
  it("restores memory whose view matches the current logical view", () => {
    document.body.innerHTML = railHtml("grid", 3, "k");
    setLogicalView("movies-browse");
    recordCouchFocus({
      route: "/movies",
      rail: "grid",
      index: 1,
      key: "k-2",
      view: "movies-browse",
    });
    const restored = restoreCouchFocus(document);
    expect(restored?.getAttribute("data-couch-key")).toBe("k-2");
    expect(document.activeElement).toBe(restored);
  });

  it("does NOT restore Home focus into the Browse view (or vice versa)", () => {
    document.body.innerHTML = railHtml("grid", 3, "k");
    setLogicalView("movies-home");
    recordCouchFocus({
      route: "/movies",
      rail: "grid",
      index: 1,
      key: "k-2",
      view: "movies-browse",
    });
    expect(restoreCouchFocus(document)).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("view-scoped memory does not restore while no logical view is current", () => {
    document.body.innerHTML = railHtml("grid", 3, "k");
    setLogicalView("");
    recordCouchFocus({
      route: "/movies",
      rail: "grid",
      index: 1,
      key: "k-2",
      view: "movies-browse",
    });
    expect(restoreCouchFocus(document)).toBeNull();
  });

  it("legacy view-less memory still restores under any logical view", () => {
    document.body.innerHTML = railHtml("grid", 3, "k");
    setLogicalView("movies-home");
    recordCouchFocus({ route: "/movies", rail: "grid", index: 2, key: "k-3" });
    const restored = restoreCouchFocus(document);
    expect(restored?.getAttribute("data-couch-key")).toBe("k-3");
  });

  it("route mismatch still blocks restore, view or not", () => {
    document.body.innerHTML = railHtml("grid", 3, "k");
    setLogicalView("movies-browse");
    recordCouchFocus({
      route: "/series",
      rail: "grid",
      index: 1,
      key: "k-2",
      view: "movies-browse",
    });
    expect(restoreCouchFocus(document)).toBeNull();
  });
});

describe("view-aware replacement focus", () => {
  it("memory from another view never picks the replacement", () => {
    document.body.innerHTML =
      railHtml("rail-a", 2, "a") + railHtml("rail-b", 3, "b");
    setLogicalView("movies-home");
    const removed = document.createElement("div");
    const replacement = findReplacementFocus(removed, document, {
      route: "/movies",
      rail: "rail-b",
      index: 2,
      key: "b-3",
      view: "movies-browse",
    });
    // Falls back to the first item of the first visible rail.
    expect(replacement?.getAttribute("data-couch-key")).toBe("a-1");
  });

  it("memory from the current view picks the replacement as before", () => {
    document.body.innerHTML =
      railHtml("rail-a", 2, "a") + railHtml("rail-b", 3, "b");
    setLogicalView("movies-browse");
    const removed = document.createElement("div");
    const replacement = findReplacementFocus(removed, document, {
      route: "/movies",
      rail: "rail-b",
      index: 2,
      key: "b-3",
      view: "movies-browse",
    });
    expect(replacement?.getAttribute("data-couch-key")).toBe("b-3");
  });
});

describe("dialog Back mechanism (§38)", () => {
  it("opening a dialog moves focus inside; Back through the coordinator closes it and restores the invoker", () => {
    document.body.innerHTML =
      `<button id="opener">Open</button>` +
      `<dialog id="dlg"><button id="inside">Inside</button></dialog>`;
    const opener = document.getElementById("opener") as HTMLElement;
    opener.focus();
    expect(openCouchDialog("dlg", opener)).toBe(true);
    expect(document.activeElement?.id).toBe("inside");
    const pageHandled = vi.fn(() => true);
    unregisters.push(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: pageHandled,
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(
      (document.getElementById("dlg") as HTMLDialogElement).hasAttribute("open"),
    ).toBe(false);
    // The modal layer consumed the press: the page layer never ran,
    // and focus returned to the invoker — no second Back.
    expect(pageHandled).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("closing restores the nearest survivor when the invoker left the DOM", () => {
    document.body.innerHTML =
      railHtml("grid", 3, "k") +
      `<button id="opener">Open</button>` +
      `<dialog id="dlg"><button id="inside">Inside</button></dialog>`;
    const opener = document.getElementById("opener") as HTMLElement;
    opener.focus();
    expect(openCouchDialog("dlg", opener)).toBe(true);
    opener.remove();
    expect(closeCouchDialog("dlg")).toBe(true);
    // Focus lands on a live, visible element — never <body>.
    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBe(document.body);
    expect(active?.isConnected).toBe(true);
    expect(active?.getAttribute("data-couch-key")).toBe("k-1");
  });

  it("a non-dismissible dialog swallows B: stays open, lower layers never run", () => {
    document.body.innerHTML =
      `<button id="opener">Open</button>` +
      `<dialog id="dlg"><button id="inside">Inside</button></dialog>`;
    const opener = document.getElementById("opener") as HTMLElement;
    expect(
      openCouchDialog("dlg", opener, { dismissible: false }),
    ).toBe(true);
    const pageHandled = vi.fn(() => true);
    unregisters.push(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: pageHandled,
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(
      (document.getElementById("dlg") as HTMLDialogElement).hasAttribute("open"),
    ).toBe(true);
    expect(pageHandled).not.toHaveBeenCalled();
    expect(closeCouchDialog("dlg")).toBe(true);
  });

  it("a natively closed dialog drops its layer (no stale Back handling)", () => {
    document.body.innerHTML =
      `<button id="opener">Open</button>` +
      `<dialog id="dlg"><button id="inside">Inside</button></dialog>`;
    const opener = document.getElementById("opener") as HTMLElement;
    expect(openCouchDialog("dlg", opener)).toBe(true);
    const dlg = document.getElementById("dlg") as HTMLDialogElement;
    // jsdom's <dialog> has no close(): simulate the native close
    // (attribute removed + close event fired) directly.
    dlg.removeAttribute("open");
    dlg.dispatchEvent(new Event("close"));
    // Layer is inert now: Back falls through to the page layer.
    const pageHandled = vi.fn(() => true);
    unregisters.push(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: pageHandled,
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(pageHandled).toHaveBeenCalledTimes(1);
  });

  it("attachDialogSpatialNav registers a modal layer for dialogs it attaches", () => {
    document.body.innerHTML = `<dialog id="dlg"><button>Inside</button></dialog>`;
    const dlg = document.getElementById("dlg") as HTMLDialogElement;
    const cleanup = attachDialogSpatialNav(dlg);
    try {
      dlg.setAttribute("open", "");
      expect(resolveBack()).toBe(true);
      expect(dlg.hasAttribute("open")).toBe(false);
    } finally {
      cleanup?.();
    }
  });

  it("openCouchDialog on a missing dialog still returns false", () => {
    expect(openCouchDialog("nope")).toBe(false);
    expect(closeCouchDialog("nope")).toBe(false);
  });
});
