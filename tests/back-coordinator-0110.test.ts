/**
 * @vitest-environment jsdom
 */
// Controller Experience 2.0 (0.11.10, W1) — Back coordinator
// (Contract A), route provenance (Contract B), and the gamepad B
// wiring. Focused tests for NEW/CHANGED behaviour only (§45 light
// scope): priority resolution, exactly-one-layer, provenance
// record/read/fallback, the synthetic-Escape migration bridge, and
// the physical-Escape single-path wiring.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  BACK_PRIORITY,
  handleCoordinatorEscape,
  isSyntheticBackEvent,
  markSyntheticBackEvent,
  mountBackCoordinator,
  registerBackInterceptor,
  registerBackLayer,
  resolveBack,
} from "@/scripts/lib/back-handler";
import {
  clearRouteOrigin,
  navigateBackWithOrigin,
  readRouteOrigin,
  recordRouteOrigin,
  setRouteNavigator,
} from "@/scripts/lib/route-origin";
import { handleGamepadButtonPress } from "@/scripts/lib/gamepad";

const BTN_B = 1;

// Node 24+ ships an experimental native `sessionStorage` that shadows
// jsdom's; stub it with a real in-memory Storage (couch-shared pattern).
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

// jsdom reports zero-size boxes for everything; pretend every element
// has a box so the visibility checks behave like a real viewport —
// except a closed <dialog>, which a real browser renders as
// display:none (no box). Needed for findOpenModal in the B branch.
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

const unregisters: Array<() => void> = [];

function track(unregister: () => void): () => void {
  unregisters.push(unregister);
  return unregister;
}

function setPath(path: string): void {
  window.history.replaceState(null, "", path);
}

/** Fabricated keydown for handleCoordinatorEscape: jsdom cannot produce a trusted KeyboardEvent (isTrusted is an own, non-configurable property there), so the listener body is called directly with a minimal event-like object. */
function fakeKeyEvent(
  overrides: Partial<{
    key: string;
    isTrusted: boolean;
    defaultPrevented: boolean;
  }> = {},
): KeyboardEvent & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopImmediatePropagation: ReturnType<typeof vi.fn>;
} {
  return {
    key: "Escape",
    isTrusted: true,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopImmediatePropagation: ReturnType<typeof vi.fn>;
  };
}

describe("Back coordinator — layer resolution order", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-livetv-mode");
    sessionStorageMock.clear();
    setPath("/movies");
  });

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) unregister();
    setPath("/");
  });

  it("highest priority wins over lower priorities", () => {
    const calls: string[] = [];
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: () => {
          calls.push("page");
          return true;
        },
      }),
    );
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: () => {
          calls.push("drawer");
          return true;
        },
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(calls).toEqual(["drawer"]);
  });

  it("most-recently-registered wins ties at the same priority", () => {
    const calls: string[] = [];
    track(
      registerBackLayer({
        id: "first",
        priority: BACK_PRIORITY.MODAL,
        isActive: () => true,
        handle: () => {
          calls.push("first");
          return true;
        },
      }),
    );
    track(
      registerBackLayer({
        id: "second",
        priority: BACK_PRIORITY.MODAL,
        isActive: () => true,
        handle: () => {
          calls.push("second");
          return true;
        },
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(calls).toEqual(["second"]);
  });

  it("inactive layers are skipped", () => {
    const calls: string[] = [];
    track(
      registerBackLayer({
        id: "modal",
        priority: BACK_PRIORITY.MODAL,
        isActive: () => false,
        handle: () => {
          calls.push("modal");
          return true;
        },
      }),
    );
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: () => {
          calls.push("page");
          return true;
        },
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(calls).toEqual(["page"]);
  });

  it("an active layer that declines falls through to lower layers", () => {
    const calls: string[] = [];
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: () => {
          calls.push("drawer");
          return false;
        },
      }),
    );
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: () => {
          calls.push("page");
          return true;
        },
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(calls).toEqual(["drawer", "page"]);
  });

  it("exactly one layer per press: a handling layer stops the chain (no double pop)", () => {
    const calls: string[] = [];
    let modalOpen = true;
    track(
      registerBackLayer({
        id: "modal",
        priority: BACK_PRIORITY.MODAL,
        isActive: () => modalOpen,
        handle: () => {
          calls.push("modal");
          modalOpen = false;
          return true;
        },
      }),
    );
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: () => {
          calls.push("page");
          return true;
        },
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(calls).toEqual(["modal"]);
    // Second press: the modal layer is now inactive (closed) — the
    // page layer handles it. One press, one layer, every time.
    expect(resolveBack()).toBe(true);
    expect(calls).toEqual(["modal", "page"]);
  });

  it("unregistering a layer removes it from resolution", () => {
    const unregister = registerBackLayer({
      id: "drawer",
      priority: BACK_PRIORITY.DRAWER,
      isActive: () => true,
      handle: () => true,
    });
    unregister();
    // Nothing left: falls through to the Escape bridge on /movies.
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    expect(resolveBack()).toBe(true);
    expect(seen).toContain("Escape");
  });

  it("a throwing layer never breaks the chain", () => {
    track(
      registerBackLayer({
        id: "broken",
        priority: BACK_PRIORITY.MODAL,
        isActive: () => {
          throw new Error("boom");
        },
        handle: () => true,
      }),
    );
    track(
      registerBackLayer({
        id: "throw-handle",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: () => {
          throw new Error("boom");
        },
      }),
    );
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: handled,
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("layers run before legacy interceptors", () => {
    const calls: string[] = [];
    track(
      registerBackInterceptor(() => {
        calls.push("interceptor");
        return true;
      }),
    );
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: () => {
          calls.push("layer");
          return true;
        },
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(calls).toEqual(["layer"]);
  });

  it("legacy interceptors still work (LIFO) when no layer handles", () => {
    const calls: string[] = [];
    track(
      registerBackInterceptor(() => {
        calls.push("first");
        return false;
      }),
    );
    track(
      registerBackInterceptor(() => {
        calls.push("second");
        return true;
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(calls).toEqual(["second"]);
  });

  it("legacy interceptors run before the dialog step (pre-0.11.10 order)", () => {
    document.body.innerHTML = `<dialog id="dlg" open><button>Close</button></dialog>`;
    const dlg = document.getElementById("dlg") as HTMLDialogElement;
    track(registerBackInterceptor(() => true));
    expect(resolveBack()).toBe(true);
    expect(dlg.hasAttribute("open")).toBe(true);
  });
});

describe("Back coordinator — dialog / fullscreen fallback", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sessionStorageMock.clear();
    setPath("/movies");
  });

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) unregister();
    setPath("/");
  });

  it("closes the topmost open dialog when no layer handles", () => {
    document.body.innerHTML =
      `<dialog id="a" open><button>A</button></dialog>` +
      `<dialog id="b" open><button>B</button></dialog>`;
    expect(resolveBack()).toBe(true);
    expect(
      (document.getElementById("b") as HTMLDialogElement).hasAttribute("open"),
    ).toBe(false);
    expect(
      (document.getElementById("a") as HTMLDialogElement).hasAttribute("open"),
    ).toBe(true);
  });

  it("exits fullscreen when no dialog is open", () => {
    const video = document.createElement("div");
    const exitFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "fullscreenElement", {
      value: video,
      configurable: true,
    });
    Object.defineProperty(document, "exitFullscreen", {
      value: exitFullscreen,
      configurable: true,
    });
    try {
      expect(resolveBack()).toBe(true);
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, "fullscreenElement", {
        value: null,
        configurable: true,
      });
    }
  });
});

describe("Back coordinator — migration bridge", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="focus-target">Target</button>`;
    (document.getElementById("focus-target") as HTMLElement).focus();
    sessionStorageMock.clear();
  });

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) unregister();
    setPath("/");
  });

  it("dispatches a synthetic Escape (keydown + keyup, keyCode 27, marked) on unmigrated screens", () => {
    setPath("/movies");
    const seen: Array<{ type: string; keyCode: number; marked: boolean }> = [];
    document.addEventListener("keydown", (event) => {
      seen.push({
        type: "keydown",
        keyCode: event.keyCode,
        marked: isSyntheticBackEvent(event),
      });
    });
    document.addEventListener("keyup", (event) => {
      seen.push({
        type: "keyup",
        keyCode: event.keyCode,
        marked: isSyntheticBackEvent(event),
      });
    });
    expect(resolveBack()).toBe(true);
    expect(seen).toEqual([
      { type: "keydown", keyCode: 27, marked: true },
      { type: "keyup", keyCode: 27, marked: true },
    ]);
  });

  it("is a no-op at Home root: B dispatches no Escape there", () => {
    setPath("/");
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    document.addEventListener("keyup", (event) => seen.push(event.key));
    expect(resolveBack()).toBe(false);
    expect(seen).toEqual([]);
  });

  it("markSyntheticBackEvent / isSyntheticBackEvent round-trip", () => {
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    expect(isSyntheticBackEvent(event)).toBe(false);
    markSyntheticBackEvent(event);
    expect(isSyntheticBackEvent(event)).toBe(true);
  });
});

describe("Route provenance", () => {
  // jsdom cannot stub location.assign, so navigation is observed
  // through the route-origin test seam (setRouteNavigator).
  const navigated: string[] = [];

  beforeEach(() => {
    document.body.innerHTML = "";
    sessionStorageMock.clear();
    navigated.length = 0;
    setRouteNavigator((url) => {
      navigated.push(url);
    });
  });

  afterEach(() => {
    setRouteNavigator(null);
    for (const unregister of unregisters.splice(0)) unregister();
    setPath("/");
  });

  it("records and reads an origin", () => {
    recordRouteOrigin({ route: "/movies", label: "Movies" });
    expect(readRouteOrigin()).toEqual({ route: "/movies", label: "Movies" });
  });

  it("returns null when nothing was recorded", () => {
    expect(readRouteOrigin()).toBeNull();
  });

  it("rejects malformed stored values", () => {
    sessionStorageMock.setItem("nylah:route-origin", "not json{");
    expect(readRouteOrigin()).toBeNull();
    sessionStorageMock.setItem(
      "nylah:route-origin",
      JSON.stringify({ route: 42 }),
    );
    expect(readRouteOrigin()).toBeNull();
  });

  it("rejects non-app-path origins (never an open redirect)", () => {
    recordRouteOrigin({ route: "https://evil.example/x", label: "Evil" });
    expect(readRouteOrigin()).toBeNull();
    recordRouteOrigin({ route: "//evil.example/x", label: "Evil" });
    expect(readRouteOrigin()).toBeNull();
    recordRouteOrigin({ route: "movies", label: "Relative" });
    expect(readRouteOrigin()).toBeNull();
  });

  it("route step navigates to the recorded origin and consumes it (one-shot)", () => {
    setPath("/movies/detail");
    recordRouteOrigin({ route: "/movies", label: "Movies" });
    expect(resolveBack()).toBe(true);
    expect(navigated).toEqual(["/movies"]);
    expect(readRouteOrigin()).toBeNull();
    // Second press: origin consumed — falls through to the bridge.
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    expect(resolveBack()).toBe(true);
    expect(navigated).toHaveLength(1);
    expect(seen).toContain("Escape");
  });

  it("a self-origin is discarded, not navigated to", () => {
    setPath("/movies/detail");
    recordRouteOrigin({ route: "/movies/detail", label: "Self" });
    expect(resolveBack()).toBe(true); // bridge fires after the discard
    expect(navigated).toEqual([]);
    expect(readRouteOrigin()).toBeNull();
  });

  it("layers win over the route step", () => {
    setPath("/movies/detail");
    recordRouteOrigin({ route: "/movies", label: "Movies" });
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: () => true,
      }),
    );
    expect(resolveBack()).toBe(true);
    expect(navigated).toEqual([]);
    expect(readRouteOrigin()).not.toBeNull();
  });

  it("navigateBackWithOrigin uses the origin when present", () => {
    setPath("/movies/detail");
    recordRouteOrigin({ route: "/discover", label: "Discover" });
    navigateBackWithOrigin("/movies");
    expect(navigated).toEqual(["/discover"]);
    expect(readRouteOrigin()).toBeNull();
  });

  it("navigateBackWithOrigin falls back to the parent route on direct links", () => {
    setPath("/movies/detail");
    navigateBackWithOrigin("/movies");
    expect(navigated).toEqual(["/movies"]);
  });

  it("navigateBackWithOrigin is a no-op when already on the destination", () => {
    setPath("/movies");
    navigateBackWithOrigin("/movies");
    expect(navigated).toEqual([]);
  });

  it("navigateBackWithOrigin rejects a non-app-path fallback", () => {
    setPath("/movies/detail");
    navigateBackWithOrigin("https://evil.example/x");
    expect(navigated).toEqual([]);
  });

  it("clearRouteOrigin discards the origin", () => {
    recordRouteOrigin({ route: "/movies", label: "Movies" });
    clearRouteOrigin();
    expect(readRouteOrigin()).toBeNull();
  });
});

describe("Back coordinator mount — __xtHandleBack + physical Escape", () => {
  beforeAll(() => {
    mountBackCoordinator();
  });

  beforeEach(() => {
    document.body.innerHTML = `<button id="focus-target">Target</button>`;
    (document.getElementById("focus-target") as HTMLElement).focus();
    sessionStorageMock.clear();
    setPath("/movies");
  });

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) unregister();
    setPath("/");
  });

  it("wires __xtHandleBack to resolveBack", () => {
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: handled,
      }),
    );
    const xtHandleBack = (window as unknown as { __xtHandleBack: () => boolean })
      .__xtHandleBack;
    expect(typeof xtHandleBack).toBe("function");
    expect(xtHandleBack()).toBe(true);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("mounting twice keeps one working __xtHandleBack wiring", () => {
    mountBackCoordinator();
    mountBackCoordinator();
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: handled,
      }),
    );
    const xtHandleBack = (window as unknown as { __xtHandleBack: () => boolean })
      .__xtHandleBack;
    expect(xtHandleBack()).toBe(true);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("physical Escape consumed by a layer stops the event (no page handler sees it)", () => {
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: () => true,
      }),
    );
    const event = fakeKeyEvent();
    expect(handleCoordinatorEscape(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("physical Escape with nothing registered is unconsumed and untouched (flows to the screen handler)", () => {
    const event = fakeKeyEvent();
    expect(handleCoordinatorEscape(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("synthetic (untrusted) Escape never re-enters the coordinator", () => {
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: handled,
      }),
    );
    const event = fakeKeyEvent({ isTrusted: false });
    expect(handleCoordinatorEscape(event)).toBe(false);
    expect(handled).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("a marked synthetic Escape is skipped even if trusted", () => {
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: handled,
      }),
    );
    const event = fakeKeyEvent({ isTrusted: true });
    markSyntheticBackEvent(event);
    expect(handleCoordinatorEscape(event)).toBe(false);
    expect(handled).not.toHaveBeenCalled();
  });

  it("an already-prevented Escape is left alone", () => {
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: handled,
      }),
    );
    const event = fakeKeyEvent({ defaultPrevented: true });
    expect(handleCoordinatorEscape(event)).toBe(false);
    expect(handled).not.toHaveBeenCalled();
  });

  it("physical Escape closes an open dialog through the coordinator (single close)", () => {
    document.body.innerHTML = `<dialog id="dlg" open><button>Close</button></dialog>`;
    const dlg = document.getElementById("dlg") as HTMLDialogElement;
    const event = fakeKeyEvent();
    expect(handleCoordinatorEscape(event)).toBe(true);
    expect(dlg.hasAttribute("open")).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("non-Escape keys are untouched by the coordinator", () => {
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: handled,
      }),
    );
    expect(handleCoordinatorEscape(fakeKeyEvent({ key: "Enter" }))).toBe(false);
    expect(handled).not.toHaveBeenCalled();
  });

  it("a dispatched synthetic Escape reaches page handlers without consulting layers (end-to-end guard)", () => {
    // The one Escape path jsdom CAN dispatch: untrusted events must
    // pass the registered capture listener untouched.
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: handled,
      }),
    );
    const pageHandler = vi.fn();
    document.addEventListener("keydown", pageHandler);
    try {
      const synthetic = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      expect(synthetic.isTrusted).toBe(false);
      document.activeElement?.dispatchEvent(synthetic);
      expect(handled).not.toHaveBeenCalled();
      expect(pageHandler).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", pageHandler);
    }
  });
});

describe("Gamepad B wiring", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="focus-target">Target</button>`;
    (document.getElementById("focus-target") as HTMLElement).focus();
    document.documentElement.removeAttribute("data-livetv-mode");
    sessionStorageMock.clear();
    setPath("/movies");
  });

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) unregister();
    document.documentElement.removeAttribute("data-livetv-mode");
    setPath("/");
  });

  it("B resolves through the coordinator: a handling layer stops the chain and no Escape is dispatched", () => {
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "drawer",
        priority: BACK_PRIORITY.DRAWER,
        isActive: () => true,
        handle: handled,
      }),
    );
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    handleGamepadButtonPress(BTN_B, 0);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("B with no layer falls back to the synthetic Escape bridge", () => {
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    handleGamepadButtonPress(BTN_B, 0);
    expect(seen).toEqual(["Escape"]);
  });

  it("B at Home root is a no-op", () => {
    setPath("/");
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    handleGamepadButtonPress(BTN_B, 0);
    expect(seen).toEqual([]);
  });

  it("B in a text field blurs, then resolves through the coordinator (keyboard layer consumes)", () => {
    document.body.innerHTML = `<input id="q" type="text" />`;
    const input = document.getElementById("q") as HTMLInputElement;
    input.focus();
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "keyboard",
        priority: BACK_PRIORITY.KEYBOARD,
        isActive: () => true,
        handle: handled,
      }),
    );
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    handleGamepadButtonPress(BTN_B, 0);
    expect(document.activeElement).not.toBe(input);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("B in a text field with no keyboard layer blurs and bridges (no blind Escape into a layer)", () => {
    document.body.innerHTML = `<input id="q" type="text" />`;
    const input = document.getElementById("q") as HTMLInputElement;
    input.focus();
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    handleGamepadButtonPress(BTN_B, 0);
    expect(document.activeElement).not.toBe(input);
    expect(seen).toEqual(["Escape"]);
  });

  it("B in Live TV context dispatches livetv:back UNCHANGED and never touches the coordinator", () => {
    document.documentElement.dataset.livetvMode = "browser";
    const handled = vi.fn(() => true);
    track(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE_STATE,
        isActive: () => true,
        handle: handled,
      }),
    );
    const backs: Array<{ context: string }> = [];
    const onBack = (event: Event) => {
      backs.push((event as CustomEvent).detail);
    };
    window.addEventListener("livetv:back", onBack);
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => seen.push(event.key));
    try {
      handleGamepadButtonPress(BTN_B, 0);
    } finally {
      window.removeEventListener("livetv:back", onBack);
    }
    expect(backs).toEqual([{ context: "browser" }]);
    expect(handled).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("B in Live TV with a modal open resolves through the coordinator (dialog owns B)", () => {
    document.documentElement.dataset.livetvMode = "browser";
    document.body.innerHTML = `<dialog id="dlg" open><button>Close</button></dialog>`;
    const backs: Array<unknown> = [];
    const onBack = (event: Event) => {
      backs.push((event as CustomEvent).detail);
    };
    window.addEventListener("livetv:back", onBack);
    try {
      handleGamepadButtonPress(BTN_B, 0);
    } finally {
      window.removeEventListener("livetv:back", onBack);
    }
    expect(backs).toEqual([]);
    expect(
      (document.getElementById("dlg") as HTMLDialogElement).hasAttribute("open"),
    ).toBe(false);
  });
});
