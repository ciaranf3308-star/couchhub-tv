/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1 (§3) — spatial-navigation `enterTo: "nearest-column"`:
// entering a new section lands on the element under the source's
// centre (column preservation), not on the geometrically closest
// centre / leftmost element. Default enterTo behaviour is unchanged.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

interface SN {
  init: () => void;
  add: (config: Record<string, unknown>) => void;
  remove: (sectionId: string) => boolean;
  makeFocusable: () => void;
  clear: () => void;
}

function fullRect(left: number, top: number, width = 100, height = 40): DOMRect {
  return {
    width,
    height,
    top,
    left,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

function syntheticKey(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

function layOut(el: HTMLElement, left: number, top: number, width: number): void {
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: 40, configurable: true });
  el.getBoundingClientRect = () => fullRect(left, top, width);
}

describe("enterTo nearest-column (§3)", () => {
  beforeAll(() => {
    document.body.innerHTML = `
      <div id="sec-a"><a href="#" id="a1">Wide source</a></div>
      <div id="sec-b">
        <a href="#" id="b1">Left</a>
        <a href="#" id="b2">Centre</a>
        <a href="#" id="b3">Right</a>
      </div>`;
    // Source spans 0–600 (centre 300). Row below: centres 50, 300, 550.
    layOut(document.getElementById("a1") as HTMLElement, 0, 0, 600);
    layOut(document.getElementById("b1") as HTMLElement, 0, 100, 100);
    layOut(document.getElementById("b2") as HTMLElement, 250, 100, 100);
    layOut(document.getElementById("b3") as HTMLElement, 500, 100, 100);

    const src = readFileSync(resolve(root, "src/scripts/spatial-navigation.js"), "utf8");
    (window as unknown as { eval: (s: string) => unknown }).eval(src);
    const sn = (window as unknown as { SpatialNavigation: SN }).SpatialNavigation;
    sn.init();
    sn.add({ id: "a", selector: "#sec-a a" });
    sn.add({ id: "b", selector: "#sec-b a", enterTo: "nearest-column" });
    sn.makeFocusable();
  });

  it("Down enters the target section at the source's column, not the leftmost element", () => {
    (document.getElementById("a1") as HTMLElement).focus();
    document.body.dispatchEvent(syntheticKey("ArrowDown"));
    // Pure geometry would pick b1 (same horizon, leftmost); the
    // column rule picks b2, directly under the source's centre.
    expect(document.activeElement?.id).toBe("b2");
  });

  it("Up returns to the source section", () => {
    expect(document.activeElement?.id).toBe("b2");
    document.body.dispatchEvent(syntheticKey("ArrowUp"));
    expect(document.activeElement?.id).toBe("a1");
  });

  it("without nearest-column the same layout keeps the geometric (leftmost) pick", () => {
    const sn = (window as unknown as { SpatialNavigation: SN }).SpatialNavigation;
    sn.remove("b");
    sn.add({ id: "b", selector: "#sec-b a" });
    (document.getElementById("a1") as HTMLElement).focus();
    document.body.dispatchEvent(syntheticKey("ArrowDown"));
    expect(document.activeElement?.id).toBe("b1");
  });
});
