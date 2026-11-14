/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1 (§2/§3/§5) — gamepad direction routing: the rail model
// is view-gated, column preservation is geometric, owners consume
// before built-ins, drawers/modals own their input, and the W2
// cursor seam routes stick directions without dual-routing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  dispatchNativeDirection,
  handleGamepadButtonPress,
  nearestColumnIndex,
} from "@/scripts/lib/gamepad";
import {
  clearNavigationOwners,
  registerCursorDirectionHandler,
  registerNavigationOwner,
  setCurrentNavigationView,
} from "@/scripts/lib/navigation-ownership";
import { setCursorModeActive } from "@/scripts/lib/cursor-mode";

const BTN_LB = 4;

function stubRect(el: Element, left: number, top: number, width: number, height: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function buildRails(): void {
  document.body.innerHTML = `
    <div data-nylah-rails>
      <section data-nylah-rail="shelf-1">
        <a href="#" id="a1" data-nylah-item>One</a>
        <a href="#" id="a2" data-nylah-item>Two</a>
        <a href="#" id="a3" data-nylah-item>Three</a>
      </section>
      <section data-nylah-rail="shelf-2">
        <a href="#" id="b1" data-nylah-item>Four</a>
        <a href="#" id="b2" data-nylah-item>Five</a>
        <a href="#" id="b3" data-nylah-item>Six</a>
      </section>
    </div>`;
  // Rails + cards all visible, laid out in two rows of three.
  for (const [id, left, top] of [
    ["a1", 0, 0],
    ["a2", 200, 0],
    ["a3", 400, 0],
    ["b1", 0, 200],
    ["b2", 200, 200],
    ["b3", 400, 200],
  ] as const) {
    stubRect(document.getElementById(id) as Element, left, top, 180, 120);
  }
  for (const rail of document.querySelectorAll("[data-nylah-rail]")) {
    stubRect(rail, 0, 0, 600, 120);
  }
}

function press(dir: "up" | "down" | "left" | "right", source: "dpad" | "stick" = "dpad"): void {
  dispatchNativeDirection(dir, performance.now(), source);
  dispatchNativeDirection(null);
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-livetv-mode");
  clearNavigationOwners();
  setCurrentNavigationView("");
  localStorage.clear();
});

afterEach(() => {
  dispatchNativeDirection(null);
  try {
    setCursorModeActive(false);
  } catch {
    // Cursor mode was never activated.
  }
  localStorage.clear();
});

describe("§2 rail gating", () => {
  it("runs the rail model on Home: Down moves to the next rail, no arrow key dispatched", () => {
    setCurrentNavigationView("home");
    buildRails();
    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));
    (document.getElementById("a2") as HTMLElement).focus();
    press("down");
    expect((document.activeElement as HTMLElement).id).toBe("b2");
    expect(keys).toEqual([]);
  });

  it("never runs the rail model on Discover: Down dispatches an arrow for spatial navigation", () => {
    setCurrentNavigationView("discover");
    buildRails();
    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));
    (document.getElementById("a2") as HTMLElement).focus();
    press("down");
    // Rail model would have moved focus to b2; spatial fallback
    // dispatches the key instead (the engine is not loaded here,
    // so focus stays — the dispatched key is the observable).
    expect((document.activeElement as HTMLElement).id).toBe("a2");
    expect(keys).toContain("ArrowDown");
  });

  it("never runs the rail model on Search or Settings", () => {
    buildRails();
    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));
    for (const view of ["search", "settings", "movies-browse", "livetv-guide"]) {
      setCurrentNavigationView(view);
      (document.getElementById("a1") as HTMLElement).focus();
      press("right");
      expect((document.activeElement as HTMLElement).id).toBe("a1");
    }
    expect(keys.filter((k) => k === "ArrowRight").length).toBe(4);
  });

  it("runs the rail model on Movies Home (shelf kind)", () => {
    setCurrentNavigationView("movies-home");
    buildRails();
    (document.getElementById("a1") as HTMLElement).focus();
    press("right");
    expect((document.activeElement as HTMLElement).id).toBe("a2");
  });

  it("does not leak rails across the scope: a rail outside the owner root is invisible", () => {
    setCurrentNavigationView("home");
    document.body.innerHTML = `
      <div id="owner-root" data-nylah-rails>
        <section data-nylah-rail="shelf-1"><a href="#" id="a1" data-nylah-item>One</a></section>
      </div>
      <section data-nylah-rail="stray"><a href="#" id="s1" data-nylah-item>Stray</a></section>`;
    stubRect(document.getElementById("a1") as Element, 0, 0, 180, 120);
    stubRect(document.getElementById("s1") as Element, 0, 200, 180, 120);
    for (const rail of document.querySelectorAll("[data-nylah-rail]")) {
      stubRect(rail, 0, 0, 600, 120);
    }
    registerNavigationOwner({ id: "home", kind: "rail", root: "#owner-root" });
    (document.getElementById("a1") as HTMLElement).focus();
    press("down");
    // Only one rail in scope: bottom edge, unconsumed, focus stays.
    expect((document.activeElement as HTMLElement).id).toBe("a1");
  });
});

describe("§3 geometric column preservation", () => {
  it("nearestColumnIndex picks the closest centre, ties go to the preferred index", () => {
    const mk = (left: number, width: number): Element => {
      const el = document.createElement("a");
      stubRect(el, left, 0, width, 40);
      return el;
    };
    const items = [mk(0, 100), mk(200, 100), mk(400, 100)];
    expect(nearestColumnIndex(items, 450, 0)).toBe(2);
    expect(nearestColumnIndex(items, 60, 2)).toBe(0);
    // Degenerate geometry (all centres 0): the preferred index wins.
    const flat = [mk(0, 0), mk(0, 0), mk(0, 0)];
    expect(nearestColumnIndex(flat, 0, 1)).toBe(1);
    expect(nearestColumnIndex([], 0, 0)).toBe(0);
  });

  it("Down from a wide card lands on the card under its centre, not the same DOM index", () => {
    setCurrentNavigationView("home");
    document.body.innerHTML = `
      <div data-nylah-rails>
        <section data-nylah-rail="hero-row"><a href="#" id="wide" data-nylah-item>Wide</a></section>
        <section data-nylah-rail="posters">
          <a href="#" id="p1" data-nylah-item>P1</a>
          <a href="#" id="p2" data-nylah-item>P2</a>
          <a href="#" id="p3" data-nylah-item>P3</a>
        </section>
      </div>`;
    // Wide card spans 300–700 (centre 500); posters at centres 100, 500, 900.
    stubRect(document.getElementById("wide") as Element, 300, 0, 400, 120);
    stubRect(document.getElementById("p1") as Element, 0, 200, 200, 120);
    stubRect(document.getElementById("p2") as Element, 400, 200, 200, 120);
    stubRect(document.getElementById("p3") as Element, 800, 200, 200, 120);
    for (const rail of document.querySelectorAll("[data-nylah-rail]")) {
      stubRect(rail, 0, 0, 1000, 120);
    }
    (document.getElementById("wide") as HTMLElement).focus();
    press("down");
    expect((document.activeElement as HTMLElement).id).toBe("p2");
  });
});

describe("§5 owner consumption", () => {
  it("a consuming owner stops the press: no rail move, no arrow key", () => {
    setCurrentNavigationView("home");
    buildRails();
    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));
    registerNavigationOwner({
      id: "home",
      kind: "rail",
      root: "[data-nylah-rails]",
      handleDirection: () => true,
    });
    (document.getElementById("a2") as HTMLElement).focus();
    press("down");
    expect((document.activeElement as HTMLElement).id).toBe("a2");
    expect(keys).toEqual([]);
  });

  it("a declining owner falls through to the rail model", () => {
    setCurrentNavigationView("home");
    buildRails();
    registerNavigationOwner({
      id: "home",
      kind: "rail",
      root: "[data-nylah-rails]",
      handleDirection: () => false,
    });
    (document.getElementById("a2") as HTMLElement).focus();
    press("down");
    expect((document.activeElement as HTMLElement).id).toBe("b2");
  });

  it("a throwing owner never kills the press", () => {
    setCurrentNavigationView("home");
    buildRails();
    registerNavigationOwner({
      id: "home",
      kind: "rail",
      root: "[data-nylah-rails]",
      handleDirection: () => {
        throw new Error("boom");
      },
    });
    (document.getElementById("a2") as HTMLElement).focus();
    press("down");
    expect((document.activeElement as HTMLElement).id).toBe("b2");
  });
});

describe("§5 drawer ownership", () => {
  it("focus outside an open drawer is pulled in instead of navigating the page", () => {
    setCurrentNavigationView("home");
    buildRails();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div data-browse-filter-drawer id="drawer"><button id="d1">Apply</button><button id="d2">Clear</button></div>`,
    );
    stubRect(document.getElementById("drawer") as Element, 0, 0, 400, 600);
    stubRect(document.getElementById("d1") as Element, 0, 0, 200, 40);
    stubRect(document.getElementById("d2") as Element, 0, 50, 200, 40);
    (document.getElementById("a1") as HTMLElement).focus();
    press("down");
    expect((document.activeElement as HTMLElement).id).toBe("d1");
  });

  it("directions inside a drawer dispatch arrows to the drawer's handler, never the rail model", () => {
    setCurrentNavigationView("home");
    buildRails();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div data-browse-filter-drawer id="drawer"><button id="d1">Apply</button></div>`,
    );
    stubRect(document.getElementById("drawer") as Element, 0, 0, 400, 600);
    stubRect(document.getElementById("d1") as Element, 0, 0, 200, 40);
    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));
    (document.getElementById("d1") as HTMLElement).focus();
    press("down");
    expect((document.activeElement as HTMLElement).id).toBe("d1");
    expect(keys).toContain("ArrowDown");
  });
});

describe("§5 modal gating for LB/RB navigation", () => {
  it("LB in the Guide dispatches PageUp without a modal, and never with one open", () => {
    document.documentElement.dataset.livetvMode = "guide";
    document.body.innerHTML = `<button id="g">Guide</button><dialog id="dlg"><button id="ok">OK</button></dialog>`;
    const dlg = document.getElementById("dlg") as HTMLDialogElement;
    (dlg as unknown as { getClientRects: () => DOMRectList }).getClientRects = () =>
      [{ width: 100, height: 100 }] as unknown as DOMRectList;
    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));
    (document.getElementById("g") as HTMLElement).focus();
    handleGamepadButtonPress(BTN_LB, performance.now());
    expect(keys).toContain("PageUp");
    keys.length = 0;
    dlg.setAttribute("open", "");
    handleGamepadButtonPress(BTN_LB, performance.now());
    expect(keys).not.toContain("PageUp");
  });
});

describe("W2 cursor seam", () => {
  it("a stick direction in Cursor Mode scrolls via the handler and never moves focus", () => {
    setCurrentNavigationView("home");
    buildRails();
    localStorage.setItem("xt_cursor_mode", "1");
    setCursorModeActive(true);
    const seen: string[] = [];
    const unregister = registerCursorDirectionHandler((dir) => {
      seen.push(dir);
      return true;
    });
    (document.getElementById("a2") as HTMLElement).focus();
    press("down", "stick");
    expect(seen).toEqual(["down"]);
    expect((document.activeElement as HTMLElement).id).toBe("a2");
    unregister();
  });

  it("a D-pad direction in Cursor Mode still moves focus", () => {
    setCurrentNavigationView("home");
    buildRails();
    localStorage.setItem("xt_cursor_mode", "1");
    setCursorModeActive(true);
    const seen: string[] = [];
    const unregister = registerCursorDirectionHandler((dir) => {
      seen.push(dir);
      return true;
    });
    (document.getElementById("a2") as HTMLElement).focus();
    press("down", "dpad");
    expect(seen).toEqual([]);
    expect((document.activeElement as HTMLElement).id).toBe("b2");
    unregister();
  });

  it("without a registered handler, stick directions keep focus navigation", () => {
    setCurrentNavigationView("home");
    buildRails();
    localStorage.setItem("xt_cursor_mode", "1");
    setCursorModeActive(true);
    (document.getElementById("a2") as HTMLElement).focus();
    press("down", "stick");
    expect((document.activeElement as HTMLElement).id).toBe("b2");
  });
});
