/**
 * @vitest-environment jsdom
 */
// 0.11.14 (W3) — region direction handling on the W1 ownership
// contract: Discover's region order holds (search -> examples ->
// quick picks -> results, Up reverses it), grids preserve columns,
// Left/Right never crosses regions, the handler yields to text
// fields / the OSK / modals, and D-pad focus nav is retained while
// Cursor Mode is active (§6). Geometry is stubbed per element
// (jsdom has no layout); the picker only reads getBoundingClientRect.

import { describe, it, expect, afterEach } from "vitest";
import {
  createRegionDirectionHandler,
  pickHorizontalTarget,
  pickVerticalTarget,
  regionItems,
  regionOf,
  regionSectionEntry,
  regionsIn,
} from "@/scripts/lib/region-direction";

function setRect(
  el: Element,
  rect: { top: number; left: number; width: number; height: number },
): void {
  const domRect = {
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as unknown as DOMRect;
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => domRect,
    configurable: true,
  });
}

function buildDiscoverDom(): HTMLElement {
  document.body.innerHTML = `
    <div id="discover-root">
      <header>
        <a href="/settings/discover-ai" id="prefs">Discovery preferences</a>
      </header>
      <div data-nav-region="search">
        <input id="query" type="search" />
        <button id="ask" type="button">Ask</button>
      </div>
      <div data-nav-region="examples">
        <button id="ex1" type="button">Example 1</button>
        <button id="ex2" type="button">Example 2</button>
      </div>
      <div data-nav-region="quick-picks">
        <button id="qp1" type="button">Pick 1</button>
        <button id="qp2" type="button">Pick 2</button>
        <button id="qp3" type="button">Pick 3</button>
      </div>
      <section data-nav-region="results">
        <button id="toggle" type="button">Available in My Library</button>
        <div>
          <a href="/movies/1" id="card-a1">A1</a>
          <a href="/movies/2" id="card-a2">A2</a>
          <a href="/movies/3" id="card-b1">B1</a>
          <a href="/movies/4" id="card-b2">B2</a>
        </div>
        <button id="diag" type="button">Why these results?</button>
      </section>
    </div>`;
  const root = document.getElementById("discover-root") as HTMLElement;
  // Layout: prefs top-right; search row; examples row; quick picks
  // row; toggle; a 2x2 card grid; diagnostics toggle last.
  setRect(document.getElementById("prefs")!, { top: 0, left: 800, width: 200, height: 40 });
  setRect(document.getElementById("query")!, { top: 100, left: 0, width: 600, height: 48 });
  setRect(document.getElementById("ask")!, { top: 100, left: 620, width: 120, height: 48 });
  setRect(document.getElementById("ex1")!, { top: 180, left: 0, width: 300, height: 48 });
  setRect(document.getElementById("ex2")!, { top: 180, left: 320, width: 300, height: 48 });
  setRect(document.getElementById("qp1")!, { top: 260, left: 0, width: 300, height: 80 });
  setRect(document.getElementById("qp2")!, { top: 260, left: 320, width: 300, height: 80 });
  setRect(document.getElementById("qp3")!, { top: 260, left: 640, width: 300, height: 80 });
  setRect(document.getElementById("toggle")!, { top: 380, left: 0, width: 300, height: 48 });
  setRect(document.getElementById("card-a1")!, { top: 450, left: 0, width: 300, height: 180 });
  setRect(document.getElementById("card-a2")!, { top: 450, left: 320, width: 300, height: 180 });
  setRect(document.getElementById("card-b1")!, { top: 650, left: 0, width: 300, height: 180 });
  setRect(document.getElementById("card-b2")!, { top: 650, left: 320, width: 300, height: 180 });
  setRect(document.getElementById("diag")!, { top: 860, left: 0, width: 240, height: 48 });
  return root;
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;

describe("regionsIn / regionOf / regionItems", () => {
  it("lists regions in DOM order and resolves membership", () => {
    const root = buildDiscoverDom();
    expect(regionsIn(root).map((r) => r.getAttribute("data-nav-region"))).toEqual([
      "search",
      "examples",
      "quick-picks",
      "results",
    ]);
    expect(regionOf(byId("qp2"), root)?.getAttribute("data-nav-region")).toBe("quick-picks");
    expect(regionOf(byId("card-b1"), root)?.getAttribute("data-nav-region")).toBe("results");
    expect(regionOf(byId("prefs"), root)).toBeNull();
    expect(regionItems(byId("qp2").closest("[data-nav-region]")!)).toHaveLength(3);
  });
});

describe("pickVerticalTarget (§7.3 region order)", () => {
  it("Down from search enters examples, then quick picks, then results", () => {
    const root = buildDiscoverDom();
    expect(pickVerticalTarget(root, byId("ask"), "down")?.id).toBe("ex2");
    expect(pickVerticalTarget(root, byId("ex1"), "down")?.id).toBe("qp1");
    expect(pickVerticalTarget(root, byId("qp2"), "down")?.id).toBe("toggle");
  });

  it("Up reverses through the same regions — never to the distant prefs link", () => {
    const root = buildDiscoverDom();
    expect(pickVerticalTarget(root, byId("qp1"), "up")?.id).toBe("ex1");
    expect(pickVerticalTarget(root, byId("ex2"), "up")?.id).toBe("query");
    expect(pickVerticalTarget(root, byId("toggle"), "up")?.id).toBe("qp1");
  });

  it("Up from the search row reaches the hero links (no dead ends)", () => {
    const root = buildDiscoverDom();
    expect(pickVerticalTarget(root, byId("ask"), "up")?.id).toBe("prefs");
    expect(pickVerticalTarget(root, byId("prefs"), "up")).toBeNull();
  });

  it("preserves the column inside the result grid", () => {
    const root = buildDiscoverDom();
    expect(pickVerticalTarget(root, byId("card-a2"), "down")?.id).toBe("card-b2");
    expect(pickVerticalTarget(root, byId("card-b1"), "up")?.id).toBe("card-a1");
  });

  it("moves from the grid to the toggle above and diagnostics below", () => {
    const root = buildDiscoverDom();
    expect(pickVerticalTarget(root, byId("card-a1"), "up")?.id).toBe("toggle");
    expect(pickVerticalTarget(root, byId("card-b2"), "down")?.id).toBe("diag");
  });

  it("returns null at the genuine bottom boundary", () => {
    const root = buildDiscoverDom();
    expect(pickVerticalTarget(root, byId("diag"), "down")).toBeNull();
  });
});

describe("pickHorizontalTarget", () => {
  it("moves within the row only", () => {
    const root = buildDiscoverDom();
    expect(pickHorizontalTarget(root, byId("qp1"), "right")?.id).toBe("qp2");
    expect(pickHorizontalTarget(root, byId("qp3"), "left")?.id).toBe("qp2");
    expect(pickHorizontalTarget(root, byId("card-a1"), "right")?.id).toBe("card-a2");
    expect(pickHorizontalTarget(root, byId("card-a2"), "left")?.id).toBe("card-a1");
  });

  it("returns null at a row edge and outside any region", () => {
    const root = buildDiscoverDom();
    expect(pickHorizontalTarget(root, byId("qp1"), "left")).toBeNull();
    expect(pickHorizontalTarget(root, byId("qp3"), "right")).toBeNull();
    // B1's row is the second grid row: right goes to B2, not up to A2.
    expect(pickHorizontalTarget(root, byId("card-b1"), "right")?.id).toBe("card-b2");
    expect(pickHorizontalTarget(root, byId("prefs"), "right")).toBeNull();
  });
});

describe("createRegionDirectionHandler (owner handleDirection)", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-cursor-mode");
    document.body.innerHTML = "";
  });

  it("consumes region moves and focuses the target", () => {
    const root = buildDiscoverDom();
    const handle = createRegionDirectionHandler(root);
    byId("qp1").focus();
    expect(handle("down", byId("qp1"))).toBe(true);
    expect(document.activeElement?.id).toBe("toggle");
    expect(handle("down", byId("toggle"))).toBe(true);
    expect(document.activeElement?.id).toBe("card-a1");
    expect(handle("right", byId("card-a1"))).toBe(true);
    expect(document.activeElement?.id).toBe("card-a2");
    expect(handle("up", byId("card-a2"))).toBe(true);
    expect(document.activeElement?.id).toBe("toggle");
    expect(handle("up", byId("toggle"))).toBe(true);
    expect(document.activeElement?.id).toBe("qp1");
  });

  it("returns false at edges so the kind's built-in behaviour runs", () => {
    const root = buildDiscoverDom();
    const handle = createRegionDirectionHandler(root);
    expect(handle("left", byId("qp1"))).toBe(false);
    expect(handle("down", byId("diag"))).toBe(false);
  });

  it("yields to text fields, the OSK and modals (§5)", () => {
    const root = buildDiscoverDom();
    const handle = createRegionDirectionHandler(root);
    // Editing target: the keyboard layer owns the arrows.
    expect(handle("down", byId("query"))).toBe(false);

    // OSK key inside the root: never a region move.
    const osk = document.createElement("div");
    osk.setAttribute("data-osk", "");
    const oskKey = document.createElement("button");
    oskKey.id = "osk-key";
    oskKey.type = "button";
    osk.appendChild(oskKey);
    root.appendChild(osk);
    setRect(oskKey, { top: 100, left: 0, width: 48, height: 48 });
    expect(handle("down", oskKey)).toBe(false);

    // Open modal: defense-in-depth (move() guards first).
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    expect(handle("down", byId("qp1"))).toBe(false);
    dialog.remove();
  });

  it("does not move focus that sits outside the root", () => {
    const root = buildDiscoverDom();
    const handle = createRegionDirectionHandler(root);
    const outside = document.createElement("button");
    outside.id = "outside";
    outside.type = "button";
    document.body.appendChild(outside);
    expect(handle("down", outside)).toBe(false);
  });

  it("keeps D-pad focus nav while Cursor Mode is active (§6)", () => {
    const root = buildDiscoverDom();
    const handle = createRegionDirectionHandler(root);
    document.documentElement.dataset.cursorMode = "active";
    expect(handle("down", byId("qp1"))).toBe(true);
    expect(document.activeElement?.id).toBe("toggle");
  });
});

describe("regionSectionEntry", () => {
  it("enters at the first region going down, the last region going up", () => {
    const root = buildDiscoverDom();
    const entry = regionSectionEntry(root);
    expect(entry("down", null)?.id).toBe("query");
    expect(entry("right", null)?.id).toBe("query");
    expect(entry("up", null)?.id).toBe("toggle");
  });

  it("returns null when the root has no region items", () => {
    document.body.innerHTML = `<div id="empty-root"></div>`;
    const root = document.getElementById("empty-root") as HTMLElement;
    expect(regionSectionEntry(root)("down", null)).toBeNull();
  });
});
