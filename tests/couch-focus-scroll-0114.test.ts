/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1 (§4/§24) — container-aware scrolling + focus
// preservation across re-renders in couch-focus.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  computeScrollAdjustment,
  measureViewportClearance,
  scrollableAncestors,
  scrollFocusedIntoView,
  withPreservedFocus,
} from "@/scripts/lib/couch-focus";

function rect(
  top: number,
  left: number,
  width: number,
  height: number,
): { top: number; bottom: number; left: number; right: number } {
  return { top, bottom: top + height, left, right: left + width };
}

function stubRect(el: Element, r: { top: number; left: number; width: number; height: number }): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      top: r.top,
      bottom: r.top + r.height,
      left: r.left,
      right: r.left + r.width,
      width: r.width,
      height: r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function stubScrollSize(el: Element, scroll: { h: number; w: number }, client: { h: number; w: number }): void {
  Object.defineProperty(el, "scrollHeight", { value: scroll.h, configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: scroll.w, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: client.h, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: client.w, configurable: true });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("computeScrollAdjustment (pure core)", () => {
  const visible = rect(100, 0, 800, 500);

  it("returns null when the element is already fully visible", () => {
    expect(
      computeScrollAdjustment(rect(150, 10, 100, 50), visible, { scrollTop: 0, scrollLeft: 0 }, { scrollTop: 1000, scrollLeft: 1000 }),
    ).toBeNull();
  });

  it("scrolls down only by the clipped amount when clipped at the bottom", () => {
    const out = computeScrollAdjustment(rect(580, 10, 100, 50), visible, { scrollTop: 100, scrollLeft: 0 }, { scrollTop: 1000, scrollLeft: 1000 });
    // bottom 630 vs visible bottom 600 → +30, and only vertically.
    expect(out).toEqual({ scrollTop: 130, scrollLeft: 0 });
  });

  it("scrolls up only by the clipped amount when clipped at the top", () => {
    const out = computeScrollAdjustment(rect(80, 10, 100, 50), visible, { scrollTop: 100, scrollLeft: 0 }, { scrollTop: 1000, scrollLeft: 1000 });
    expect(out).toEqual({ scrollTop: 80, scrollLeft: 0 });
  });

  it("scrolls horizontally only when clipped horizontally", () => {
    const out = computeScrollAdjustment(rect(150, 780, 100, 50), visible, { scrollTop: 0, scrollLeft: 0 }, { scrollTop: 1000, scrollLeft: 1000 });
    expect(out).toEqual({ scrollTop: 0, scrollLeft: 80 });
  });

  it("never scrolls past either end", () => {
    const out = computeScrollAdjustment(rect(580, 10, 100, 50), visible, { scrollTop: 990, scrollLeft: 0 }, { scrollTop: 1000, scrollLeft: 1000 });
    expect(out?.scrollTop).toBe(1000);
    const up = computeScrollAdjustment(rect(10, 10, 100, 50), visible, { scrollTop: 20, scrollLeft: 0 }, { scrollTop: 1000, scrollLeft: 1000 });
    expect(up?.scrollTop).toBe(0);
  });

  it("respects clearance already inset into the visible rect", () => {
    // Sticky header occupies the top 120px of the viewport.
    const cleared = rect(120, 0, 800, 480);
    const out = computeScrollAdjustment(rect(110, 10, 100, 50), cleared, { scrollTop: 0, scrollLeft: 0 }, { scrollTop: 1000, scrollLeft: 1000 });
    expect(out?.scrollTop).toBe(0); // clamped: already at top, cannot reveal more
    const out2 = computeScrollAdjustment(rect(110, 10, 100, 50), cleared, { scrollTop: 200, scrollLeft: 0 }, { scrollTop: 1000, scrollLeft: 1000 });
    expect(out2?.scrollTop).toBe(190);
  });
});

describe("scrollableAncestors", () => {
  it("walks nearest-first and only through genuinely scrollable containers", () => {
    document.body.innerHTML = `
      <div id="outer" style="overflow-y: auto"><div id="mid"><div id="inner" style="overflow-x: auto"><button id="t">T</button></div></div></div>`;
    const outer = document.getElementById("outer") as HTMLElement;
    const inner = document.getElementById("inner") as HTMLElement;
    stubScrollSize(outer, { h: 2000, w: 800 }, { h: 600, w: 800 });
    stubScrollSize(inner, { h: 200, w: 2000 }, { h: 200, w: 800 });
    const chain = scrollableAncestors(document.getElementById("t") as Element);
    expect(chain.map((el) => (el as HTMLElement).id)).toEqual(["inner", "outer"]);
  });

  it("stops at a modal dialog boundary", () => {
    document.body.innerHTML = `
      <div id="page" style="overflow-y: auto"><dialog id="dlg" open><div id="panel" style="overflow-y: auto"><button id="t">T</button></div></dialog></div>`;
    const page = document.getElementById("page") as HTMLElement;
    const panel = document.getElementById("panel") as HTMLElement;
    stubScrollSize(page, { h: 2000, w: 800 }, { h: 600, w: 800 });
    stubScrollSize(panel, { h: 1000, w: 400 }, { h: 300, w: 400 });
    const chain = scrollableAncestors(document.getElementById("t") as Element);
    expect(chain.map((el) => (el as HTMLElement).id)).toEqual(["panel"]);
  });

  it("stops at a drawer boundary", () => {
    document.body.innerHTML = `
      <div id="page" style="overflow-y: auto"><div data-browse-filter-drawer id="drawer"><div id="panel" style="overflow-y: auto"><button id="t">T</button></div></div></div>`;
    const page = document.getElementById("page") as HTMLElement;
    const panel = document.getElementById("panel") as HTMLElement;
    stubScrollSize(page, { h: 2000, w: 800 }, { h: 600, w: 800 });
    stubScrollSize(panel, { h: 1000, w: 400 }, { h: 300, w: 400 });
    const chain = scrollableAncestors(document.getElementById("t") as Element);
    expect(chain.map((el) => (el as HTMLElement).id)).toEqual(["panel"]);
  });
});

describe("scrollFocusedIntoView", () => {
  it("scrolls the owning panel, not the document, by the clipped amount", () => {
    document.body.innerHTML = `
      <div id="panel" style="overflow-y: auto; height: 300px"><button id="t">T</button></div>`;
    const panel = document.getElementById("panel") as HTMLElement;
    const target = document.getElementById("t") as HTMLElement;
    stubScrollSize(panel, { h: 1000, w: 400 }, { h: 300, w: 400 });
    stubRect(panel, { top: 100, left: 0, width: 400, height: 300 });
    // Target hangs 40px below the panel's visible bottom (400 - 4 padding = 396; bottom 430).
    stubRect(target, { top: 380, left: 10, width: 100, height: 50 });
    panel.scrollTop = 0;
    scrollFocusedIntoView(target);
    expect(panel.scrollTop).toBe(34);
  });

  it("does not move a panel when the target is already fully visible", () => {
    document.body.innerHTML = `
      <div id="panel" style="overflow-y: auto; height: 300px"><button id="t">T</button></div>`;
    const panel = document.getElementById("panel") as HTMLElement;
    const target = document.getElementById("t") as HTMLElement;
    stubScrollSize(panel, { h: 1000, w: 400 }, { h: 300, w: 400 });
    stubRect(panel, { top: 100, left: 0, width: 400, height: 300 });
    stubRect(target, { top: 150, left: 10, width: 100, height: 50 });
    panel.scrollTop = 120;
    scrollFocusedIntoView(target);
    expect(panel.scrollTop).toBe(120);
  });
});

describe("measureViewportClearance", () => {
  it("measures the sticky nav and fixed hint pill as rendered", () => {
    document.body.innerHTML = `
      <header data-couch-nav style="position: sticky"></header>
      <nav data-button-hints style="position: fixed"></nav>`;
    const nav = document.querySelector("[data-couch-nav]") as HTMLElement;
    const hints = document.querySelector("[data-button-hints]") as HTMLElement;
    stubRect(nav, { top: 0, left: 0, width: 800, height: 96 });
    stubRect(hints, { top: 720, left: 100, width: 600, height: 36 });
    const clearance = measureViewportClearance(document);
    expect(clearance.top).toBe(96);
    expect(clearance.bottom).toBe(768 - 720);
  });

  it("is zero when the chrome is absent", () => {
    expect(measureViewportClearance(document)).toEqual({ top: 0, bottom: 0 });
  });
});

describe("withPreservedFocus (§24)", () => {
  it("restores the same-key control after a wholesale re-render", () => {
    document.body.innerHTML = `
      <section data-nylah-rail="shelf-1">
        <a href="#" id="c1" data-couch-key="movie:1">One</a>
        <a href="#" id="c2" data-couch-key="movie:2">Two</a>
      </section>`;
    const root = document.querySelector("section") as HTMLElement;
    const c2 = document.getElementById("c2") as HTMLElement;
    c2.focus();
    expect(document.activeElement).toBe(c2);
    const result = withPreservedFocus(document, () => {
      root.innerHTML = `
        <a href="#" id="n1" data-couch-key="movie:1">One</a>
        <a href="#" id="n2" data-couch-key="movie:2">Two</a>`;
      for (const el of root.querySelectorAll("a")) {
        stubRect(el, { top: 0, left: 0, width: 120, height: 40 });
      }
      return "rendered";
    });
    expect(result).toBe("rendered");
    expect((document.activeElement as HTMLElement).id).toBe("n2");
  });

  it("falls back to the same rail + index when the key is gone", () => {
    document.body.innerHTML = `
      <section data-nylah-rail="shelf-1">
        <a href="#" id="c1" data-couch-key="movie:1">One</a>
        <a href="#" id="c2" data-couch-key="movie:2">Two</a>
      </section>`;
    const root = document.querySelector("section") as HTMLElement;
    // Give the items layout so isVisible() passes in jsdom.
    for (const el of root.querySelectorAll("a")) {
      stubRect(el, { top: 0, left: 0, width: 120, height: 40 });
    }
    (document.getElementById("c2") as HTMLElement).focus();
    withPreservedFocus(document, () => {
      root.innerHTML = `
        <a href="#" id="n1" data-couch-key="movie:9">Nine</a>
        <a href="#" id="n2" data-couch-key="movie:8">Eight</a>`;
      for (const el of root.querySelectorAll("a")) {
        stubRect(el, { top: 0, left: 0, width: 120, height: 40 });
      }
    });
    expect((document.activeElement as HTMLElement).id).toBe("n2");
  });

  it("never steals focus from a live element", () => {
    document.body.innerHTML = `
      <section data-nylah-rail="shelf-1"><a href="#" id="c1" data-couch-key="movie:1">One</a></section>
      <button id="outside">Outside</button>`;
    const root = document.querySelector("section") as HTMLElement;
    (document.getElementById("c1") as HTMLElement).focus();
    withPreservedFocus(document, () => {
      root.innerHTML = `<a href="#" id="n1" data-couch-key="movie:1">One</a>`;
      // The mutation itself moved focus somewhere live.
      (document.getElementById("outside") as HTMLElement).focus();
    });
    expect((document.activeElement as HTMLElement).id).toBe("outside");
  });

  it("leaves focus alone when the focused control survives the mutation", () => {
    document.body.innerHTML = `
      <section data-nylah-rail="shelf-1">
        <a href="#" id="c1" data-couch-key="movie:1">One</a>
        <a href="#" id="c2" data-couch-key="movie:2">Two</a>
      </section>`;
    const c1 = document.getElementById("c1") as HTMLElement;
    c1.focus();
    withPreservedFocus(document, () => {
      document.getElementById("c2")?.remove();
    });
    expect(document.activeElement).toBe(c1);
  });
});
