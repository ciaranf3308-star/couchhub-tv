/**
 * @vitest-environment jsdom
 */
// Controller Experience 2.0 (0.11.10, W3) — shared keyboard lifecycle
// (Contract E), B-never-deletes, Back-step hierarchies, and origin
// handling. The Svelte views are guarded by source assertions in the
// repo's usual style (the suite mounts no Svelte components); the
// lifecycle itself runs against real jsdom inputs.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  openCouchKeyboard,
  closeCouchKeyboard,
  isCouchKeyboardOpen,
  endCouchKeyboardSession,
  getCouchKeyboardInput,
  oskKeyAction,
  nextSearchBackStep,
  nextDiscoverBackStep,
  COUCH_KEYBOARD_CLOSED_EVENT,
  KEYBOARD_OPEN_HINTS,
} from "@/scripts/lib/couch-keyboard";
import {
  BACK_PRIORITY,
  mountBackCoordinator,
  registerBackLayer,
} from "@/scripts/lib/back-handler";
import { getControllerHints } from "@/scripts/lib/couch-button-hints";
import {
  navigateBackWithOrigin,
  recordRouteOrigin,
  setRouteNavigator,
} from "@/scripts/lib/route-origin";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
function pageSource(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function makeInput(value = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "search";
  input.value = value;
  document.body.appendChild(input);
  return input;
}

function makeOskGrid(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-couch-keyboard", "");
  const grid = document.createElement("div");
  grid.setAttribute("data-osk", "");
  const key = document.createElement("button");
  key.setAttribute("data-osk-key", "Q");
  key.textContent = "Q";
  grid.appendChild(key);
  wrap.appendChild(grid);
  document.body.appendChild(wrap);
  return key;
}

beforeEach(() => {
  mountBackCoordinator();
});

afterEach(() => {
  endCouchKeyboardSession();
  setRouteNavigator(null);
  document.body.innerHTML = "";
  try {
    sessionStorage.clear();
  } catch {
    // jsdom storage may be unavailable; provenance tests use try/catch too.
  }
  vi.restoreAllMocks();
});

describe("oskKeyAction: B never deletes", () => {
  it("Escape dismisses, Backspace deletes, other keys are none", () => {
    expect(oskKeyAction("Escape")).toBe("dismiss");
    expect(oskKeyAction("Backspace")).toBe("backspace");
    expect(oskKeyAction("Enter")).toBe("none");
    expect(oskKeyAction("ArrowDown")).toBe("none");
    expect(oskKeyAction("x")).toBe("none");
    expect(oskKeyAction("a")).toBe("none");
  });

  it("the OSK implements the rule and the Backspace key still deletes", () => {
    const src = pageSource("src/components/OnScreenKeyboard.svelte");
    expect(src).toContain("oskKeyAction(ev.key)");
    // Dismiss path: shared lifecycle, onDismiss fallback.
    expect(src).toContain("closeCouchKeyboard(false)");
    expect(src).toContain("onDismiss?.()");
    // The Backspace KEY and the physical Backspace key delete.
    expect(src).toContain('data-osk-action="backspace"');
    expect(src).toContain("onclick={backspace}");
    // No Escape-as-backspace anywhere in the component.
    expect(src).not.toMatch(/Escape.*backspace\(\)/);
  });
});

describe("Contract E: open / close lifecycle", () => {
  it("open focuses the input, marks the session open, publishes OSK hints", () => {
    const input = makeInput("hello");
    openCouchKeyboard(input, undefined, { focusGrid: false });
    expect(isCouchKeyboardOpen()).toBe(true);
    expect(getCouchKeyboardInput()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(getControllerHints()).toEqual(KEYBOARD_OPEN_HINTS);
  });

  it("open moves focus into the key grid by default (controller entry)", () => {
    const input = makeInput("");
    const key = makeOskGrid();
    openCouchKeyboard(input);
    expect(document.activeElement).toBe(key);
  });

  it("open with focusGrid:false leaves focus in the input (focus-handler entry)", () => {
    const input = makeInput("");
    makeOskGrid();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    expect(document.activeElement).toBe(input);
  });

  it("close(false) dismisses without committing, value untouched, focus returns", () => {
    const input = makeInput("typed");
    const onCommit = vi.fn();
    openCouchKeyboard(input, onCommit, { focusGrid: false });
    const closed = vi.fn();
    input.addEventListener(COUCH_KEYBOARD_CLOSED_EVENT, closed);
    makeOskGrid();
    document.querySelector<HTMLElement>("[data-osk-key]")?.focus();
    expect(document.activeElement).not.toBe(input);
    closeCouchKeyboard(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("typed");
    expect(document.activeElement).toBe(input);
    expect(isCouchKeyboardOpen()).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    expect((closed.mock.calls[0][0] as CustomEvent).detail).toEqual({
      commit: false,
      value: "typed",
    });
    // Closing releases the override: the view config applies again.
    expect(getControllerHints()).toBeNull();
  });

  it("close(true) commits: onCommit + closed event + focus returns", () => {
    const input = makeInput("query");
    const onCommit = vi.fn();
    openCouchKeyboard(input, onCommit, { focusGrid: false });
    const closed = vi.fn();
    input.addEventListener(COUCH_KEYBOARD_CLOSED_EVENT, closed);
    closeCouchKeyboard(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("query");
    expect((closed.mock.calls[0][0] as CustomEvent).detail).toEqual({
      commit: true,
      value: "query",
    });
    expect(document.activeElement).toBe(input);
    expect(isCouchKeyboardOpen()).toBe(false);
  });

  it("close with no session is a no-op", () => {
    expect(() => closeCouchKeyboard(false)).not.toThrow();
    expect(() => closeCouchKeyboard(true)).not.toThrow();
    expect(isCouchKeyboardOpen()).toBe(false);
  });

  it("opening a second input ends the first session without committing", () => {
    const first = makeInput("one");
    const second = makeInput("two");
    const onCommit = vi.fn();
    openCouchKeyboard(first, onCommit, { focusGrid: false });
    openCouchKeyboard(second, undefined, { focusGrid: false });
    expect(onCommit).not.toHaveBeenCalled();
    expect(getCouchKeyboardInput()).toBe(second);
    expect(isCouchKeyboardOpen()).toBe(true);
  });

  it("re-opening the same input refreshes the commit callback, one session", () => {
    const input = makeInput("");
    const first = vi.fn();
    const second = vi.fn();
    openCouchKeyboard(input, first, { focusGrid: false });
    openCouchKeyboard(input, second, { focusGrid: false });
    closeCouchKeyboard(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a removed input reads closed (stale sessions never swallow Back)", () => {
    const input = makeInput("");
    openCouchKeyboard(input, undefined, { focusGrid: false });
    expect(isCouchKeyboardOpen()).toBe(true);
    input.remove();
    expect(isCouchKeyboardOpen()).toBe(false);
  });

  it("endCouchKeyboardSession is silent: no event, no focus move", () => {
    const input = makeInput("x");
    const other = document.createElement("button");
    document.body.appendChild(other);
    const closed = vi.fn();
    input.addEventListener(COUCH_KEYBOARD_CLOSED_EVENT, closed);
    openCouchKeyboard(input, undefined, { focusGrid: false });
    other.focus();
    endCouchKeyboardSession();
    expect(closed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
    expect(isCouchKeyboardOpen()).toBe(false);
  });

  it("Back layer: Android BACK dismisses the keyboard in exactly one step", () => {
    const input = makeInput("keep me");
    const onCommit = vi.fn();
    openCouchKeyboard(input, onCommit, { focusGrid: false });
    const handled = (window as unknown as { __xtHandleBack: () => boolean }).__xtHandleBack();
    expect(handled).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("keep me");
    expect(document.activeElement).toBe(input);
    expect(isCouchKeyboardOpen()).toBe(false);
    // Second BACK with no session: nothing consumes it here.
    const again = (window as unknown as { __xtHandleBack: () => boolean }).__xtHandleBack();
    expect(again).toBe(false);
  });
});

describe("Back layers (coordinator): priority + activity gating", () => {
  it("BACK_PRIORITY matches the contract", () => {
    expect(BACK_PRIORITY.MODAL).toBe(90);
    expect(BACK_PRIORITY.KEYBOARD).toBe(80);
    expect(BACK_PRIORITY.PAGE_STATE).toBe(30);
    expect(BACK_PRIORITY.ROUTE).toBe(20);
  });

  it("highest-priority active layer wins; inactive layers are skipped", () => {
    const calls: string[] = [];
    const unregisterLow = registerBackLayer({
      id: "low",
      priority: BACK_PRIORITY.ROUTE,
      isActive: () => true,
      handle: () => {
        calls.push("low");
        return true;
      },
    });
    const unregisterHigh = registerBackLayer({
      id: "high",
      priority: BACK_PRIORITY.KEYBOARD,
      isActive: () => false,
      handle: () => {
        calls.push("high");
        return true;
      },
    });
    const handled = (window as unknown as { __xtHandleBack: () => boolean }).__xtHandleBack();
    expect(handled).toBe(true);
    expect(calls).toEqual(["low"]);
    unregisterLow();
    unregisterHigh();
  });

  it("a layer returning false falls through to the next layer", () => {
    const calls: string[] = [];
    const unregisterA = registerBackLayer({
      id: "a",
      priority: BACK_PRIORITY.KEYBOARD,
      isActive: () => true,
      handle: () => {
        calls.push("a");
        return false;
      },
    });
    const unregisterB = registerBackLayer({
      id: "b",
      priority: BACK_PRIORITY.PAGE_STATE,
      isActive: () => true,
      handle: () => {
        calls.push("b");
        return true;
      },
    });
    const handled = (window as unknown as { __xtHandleBack: () => boolean }).__xtHandleBack();
    expect(handled).toBe(true);
    expect(calls).toEqual(["a", "b"]);
    unregisterA();
    unregisterB();
  });

  it("duplicate ids are independent registrations; unregister removes only its own", () => {
    // The coordinator keys layers by registration, not by id (ids
    // are for debugging): same priority resolves most-recent-first,
    // and unregistering the newer registration revives the older.
    const calls: string[] = [];
    const unregisterOld = registerBackLayer({
      id: "dup",
      priority: BACK_PRIORITY.PAGE_STATE,
      isActive: () => true,
      handle: () => {
        calls.push("old");
        return true;
      },
    });
    const unregisterNew = registerBackLayer({
      id: "dup",
      priority: BACK_PRIORITY.PAGE_STATE,
      isActive: () => true,
      handle: () => {
        calls.push("new");
        return true;
      },
    });
    (window as unknown as { __xtHandleBack: () => boolean }).__xtHandleBack();
    expect(calls).toEqual(["new"]);
    unregisterNew();
    const handled = (window as unknown as { __xtHandleBack: () => boolean }).__xtHandleBack();
    expect(handled).toBe(true);
    expect(calls).toEqual(["new", "old"]);
    unregisterOld();
  });
});

describe("nextSearchBackStep (§27 hierarchy)", () => {
  it("orders keyboard -> person -> focus -> clear -> leave", () => {
    const base = { keyboardOpen: false, personMode: false, focusInResults: false, hasQuery: false };
    expect(nextSearchBackStep(base)).toBe("leave");
    expect(nextSearchBackStep({ ...base, hasQuery: true })).toBe("clear-query");
    expect(nextSearchBackStep({ ...base, hasQuery: true, focusInResults: true })).toBe("focus-input");
    expect(nextSearchBackStep({ ...base, hasQuery: true, focusInResults: true, personMode: true })).toBe("exit-person");
    expect(
      nextSearchBackStep({ ...base, hasQuery: true, focusInResults: true, personMode: true, keyboardOpen: true }),
    ).toBe("close-keyboard");
  });
});

describe("nextDiscoverBackStep (§25 hierarchy)", () => {
  it("orders diagnostics -> keyboard -> focus -> root -> leave", () => {
    const base = { diagnosticsOpen: false, keyboardOpen: false, focusInResults: false, hasResultsView: false };
    expect(nextDiscoverBackStep(base)).toBe("leave");
    expect(nextDiscoverBackStep({ ...base, hasResultsView: true })).toBe("root-state");
    expect(nextDiscoverBackStep({ ...base, hasResultsView: true, focusInResults: true })).toBe("focus-search");
    expect(nextDiscoverBackStep({ ...base, hasResultsView: true, focusInResults: true, keyboardOpen: true })).toBe(
      "close-keyboard",
    );
    expect(
      nextDiscoverBackStep({
        ...base,
        hasResultsView: true,
        focusInResults: true,
        keyboardOpen: true,
        diagnosticsOpen: true,
      }),
    ).toBe("close-diagnostics");
  });
});

describe("provenance: validated, single-use origins", () => {
  it("records a safe route and rejects unsafe ones", () => {
    recordRouteOrigin({ route: "/movies", label: "Movies" });
    expect(sessionStorage.getItem("nylah:route-origin")).toContain("/movies");
    recordRouteOrigin({ route: "https://evil.example/x", label: "x" });
    expect(sessionStorage.getItem("nylah:route-origin")).toContain("/movies");
    recordRouteOrigin({ route: "//evil.example/x", label: "x" });
    expect(sessionStorage.getItem("nylah:route-origin")).toContain("/movies");
  });

  it("navigateBackWithOrigin consumes the origin (single-use)", () => {
    const navigated: string[] = [];
    setRouteNavigator((url) => navigated.push(url));
    recordRouteOrigin({ route: "/movies", label: "Movies" });
    navigateBackWithOrigin("/");
    expect(navigated).toEqual(["/movies"]);
    expect(sessionStorage.getItem("nylah:route-origin")).toBeNull();
    navigateBackWithOrigin("/home");
    expect(navigated).toEqual(["/movies", "/home"]);
  });
});

describe("SearchView wiring (§27)", () => {
  it("uses one Back step + provenance, never history.length", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain("searchBackStep()");
    expect(src).toContain("nextSearchBackStep(");
    expect(src).toContain("navigateBackWithOrigin(\"/\")");
    expect(src).toContain("recordOriginFromReferrer(");
    expect(src).toContain('registerBackLayer({');
    expect(src).toContain('id: "search-page"');
    expect(src).not.toContain("history.length");
    expect(src).not.toContain("history.back()");
    expect(src).toContain("openCouchKeyboard(inputEl, focusFirstResult, { focusGrid: false })");
    expect(src).toContain("COUCH_KEYBOARD_CLOSED_EVENT");
  });

  it("trailing Escape closes the keyboard instead of swallowing it", () => {
    const src = pageSource("src/components/SearchView.svelte");
    expect(src).toContain("keyboard.isFreshScopeExit()");
    expect(src).toContain("document.activeElement === document.body");
    // The old swallow returned without acting; the new branch steps.
    expect(src).toContain("searchBackStep()");
  });
});

describe("DiscoverView wiring (§25–§26)", () => {
  function fnBody(src: string, name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\n  /**", start + 1);
    const end = src.indexOf("\n  function ", start + 1);
    const cut = [next, end].filter((i) => i > start);
    return src.slice(start, cut.length ? Math.min(...cut) : undefined);
  }

  it("Escape and Android BACK share one step function", () => {
    const src = pageSource("src/components/DiscoverView.svelte");
    expect(src).toContain("discoverBackStep()");
    expect(src).toContain("nextDiscoverBackStep(");
    expect(src).toContain('registerBackLayer({');
    expect(src).toContain('id: "discover-page"');
    expect(src).not.toContain("registerBackInterceptor");
    expect(src).toContain("navigateBackWithOrigin(\"/\")");
    expect(src).toContain("recordOriginFromReferrer(");
    expect(src).toContain("openCouchKeyboard(inputEl, onKeyboardCommit, { focusGrid: false })");
    expect(src).toContain("couch:discover-focus-search");
  });

  it("Back never triggers an AI request or submits a prompt", () => {
    const src = pageSource("src/components/DiscoverView.svelte");
    for (const name of ["discoverBackStep", "backToDiscoverRoot", "onDiscoverKeyDown"]) {
      const body = fnBody(src, name);
      expect(body).not.toContain("runAiDiscovery");
      expect(body).not.toContain("submitSearch");
      expect(body).not.toContain("applyQuickPick");
      expect(body).not.toContain("pickExample");
    }
  });

  it("Back-to-root preserves the refinement conversation (only New Search clears it)", () => {
    const src = pageSource("src/components/DiscoverView.svelte");
    const body = fnBody(src, "backToDiscoverRoot");
    expect(body).not.toContain("newConversation");
    expect(body).not.toContain("conversation =");
    expect(body).toContain("searchResults = null");
    expect(body).toContain("aiResults = null");
    // New Search remains the conversation-clearing path.
    expect(fnBody(src, "newSearch")).toContain("conversation = newConversation()");
  });

  it("the library toggle stays filter-only (no model request)", () => {
    const src = pageSource("src/components/DiscoverView.svelte");
    const body = fnBody(src, "toggleAvailableOnly");
    expect(body).toContain("availableOnly = !availableOnly");
    expect(body).not.toContain("runAiDiscovery");
    expect(body).not.toContain("submitSearch");
  });
});

describe("invocation lines: every search surface uses Contract E", () => {
  it("Browse overlay, Live TV overlay and Guide search open a session", () => {
    expect(pageSource("src/scripts/lib/browse-everything.ts")).toContain("openCouchKeyboard(");
    expect(pageSource("src/components/couch/TvLivetvSearchOverlay.astro")).toContain("openCouchKeyboard(");
    expect(pageSource("src/components/couch/TvGuideView.astro")).toContain("openCouchKeyboard(");
  });

  it("TvKeyboard passes dismiss through to the OSK", () => {
    const src = pageSource("src/components/couch/TvKeyboard.svelte");
    expect(src).toContain("onDismiss={handleDismiss}");
    expect(src).toContain("open = true");
    expect(src).toContain("{#if open}");
  });

  it("the keyboard hint text names the new mapping", () => {
    const en = JSON.parse(pageSource("src/i18n/en.json")) as Record<string, string>;
    expect(en["search.keyboardHint"]).toContain("B closes");
    expect(en["search.keyboardHint"]).not.toContain("B deletes");
    expect(en["search.keyboardHint"]).not.toContain("X clears");
  });
});
