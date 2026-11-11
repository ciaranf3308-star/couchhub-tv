/**
 * @vitest-environment jsdom
 */
// W2 — 0.11.1 gamepad fix pass: spatial-navigation.js read
// evt.keyCode only, but a synthetic KeyboardEvent carries keyCode 0
// in Chromium (the constructor has no keyCode slot) — verified in
// real Chromium before the fix, where a synthetic ArrowDown left
// focus on <body>. The engine must derive the code from `key` when
// keyCode is missing, or the gamepad bridge's arrows / Enter never
// reach it. Physical keyboards (real keyCode) are unaffected.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function fullRect(top = 0): DOMRect {
  return {
    width: 120,
    height: 30,
    top,
    left: 0,
    right: 120,
    bottom: top + 30,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

function syntheticKey(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
}

describe("spatial navigation with synthetic (gamepad-bridge) keys", () => {
  beforeAll(() => {
    document.body.innerHTML = `
      <a href="#" id="l1">One</a>
      <a href="#" id="l2">Two</a>`;
    const l1 = document.getElementById("l1") as HTMLElement;
    const l2 = document.getElementById("l2") as HTMLElement;
    for (const [el, top] of [
      [l1, 0],
      [l2, 100],
    ] as const) {
      Object.defineProperty(el, "offsetWidth", {
        value: 120,
        configurable: true,
      });
      Object.defineProperty(el, "offsetHeight", {
        value: 30,
        configurable: true,
      });
      el.getBoundingClientRect = () => fullRect(top);
    }

    const src = readFileSync(
      resolve(root, "src/scripts/spatial-navigation.js"),
      "utf8",
    );
    (window as unknown as { eval: (s: string) => unknown }).eval(src);
    const sn = (
      window as unknown as {
        SpatialNavigation: {
          init: () => void;
          add: (config: Record<string, unknown>) => void;
          makeFocusable: () => void;
        };
      }
    ).SpatialNavigation;
    sn.init();
    sn.add({ id: "main", selector: "a, button" });
    sn.makeFocusable();
  });

  it("documents the premise: a synthetic KeyboardEvent reads keyCode 0", () => {
    expect(syntheticKey("ArrowDown").keyCode).toBe(0);
    expect(syntheticKey("Enter").keyCode).toBe(0);
  });

  it("synthetic ArrowDown (keyCode 0) focuses the first element from no focus", () => {
    expect(document.activeElement).toBe(document.body);
    document.body.dispatchEvent(syntheticKey("ArrowDown"));
    expect(document.activeElement?.id).toBe("l1");
  });

  it("synthetic ArrowDown moves from the first element to the second", () => {
    expect(document.activeElement?.id).toBe("l1");
    document.body.dispatchEvent(syntheticKey("ArrowDown"));
    expect(document.activeElement?.id).toBe("l2");
  });

  it("synthetic Enter (keyCode 0) fires sn:enter-down on the focused element", () => {
    const l2 = document.getElementById("l2") as HTMLElement;
    expect(document.activeElement).toBe(l2);
    let fired = false;
    l2.addEventListener("sn:enter-down", () => {
      fired = true;
    });
    l2.dispatchEvent(syntheticKey("Enter"));
    expect(fired).toBe(true);
  });
});
