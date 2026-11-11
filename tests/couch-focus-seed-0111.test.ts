/**
 * @vitest-environment jsdom
 */
// W2 — 0.11.1 gamepad fix pass: cold-launch focus. On a cold launch
// there is no stored focus memory, so restoreCouchFocus() returns
// null and nothing is focused — A then dispatches Enter to <body>
// and does nothing, and component-scoped key handlers never see the
// gamepad's synthetic keys. seedInitialCouchFocus() seeds the active
// top-nav link (server-rendered, always present) so D-pad / A have a
// focused element from the first press. Seeding is mount-time only:
// it never moves focus that already exists, never pulls focus out of
// a modal, and content loading later never moves focus.

import { describe, it, expect, beforeEach } from "vitest";
import {
  seedInitialCouchFocus,
  restoreCouchFocus,
  recordCouchFocus,
  clearCouchFocusMemory,
} from "@/scripts/lib/couch-focus";

function fullRect(top = 0): DOMRect {
  return {
    width: 120,
    height: 40,
    top,
    left: 0,
    right: 120,
    bottom: top + 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

function buildDom(): void {
  document.body.innerHTML = `
    <header data-couch-nav><nav><div data-nylah-rail="couch-nav">
      <a data-nylah-item href="/" aria-current="page" id="nav-home">Home</a>
      <a data-nylah-item href="/movies" id="nav-movies">Movies</a>
    </div></nav></header>
    <main><section data-nylah-rail="continue">
      <a data-nylah-item href="/movies/a" data-couch-key="a" id="card-a">A</a>
      <a data-nylah-item href="/movies/b" data-couch-key="b" id="card-b">B</a>
    </section></main>`;
  const proto = Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
    scrollIntoView: () => void;
  };
  proto.getBoundingClientRect = () => fullRect();
  proto.scrollIntoView = () => {};
}

beforeEach(() => {
  buildDom();
  clearCouchFocusMemory();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe("seedInitialCouchFocus (cold launch)", () => {
  it("focus is present on cold launch: seeds the active nav link", () => {
    expect(document.activeElement).toBe(document.body);
    const seeded = seedInitialCouchFocus(document);
    expect(seeded?.id).toBe("nav-home");
    expect(document.activeElement?.id).toBe("nav-home");
  });

  it("does not move focus when something is already focused", () => {
    const card = document.getElementById("card-a") as HTMLElement;
    card.focus();
    expect(seedInitialCouchFocus(document)).toBeNull();
    expect(document.activeElement?.id).toBe("card-a");
  });

  it("does not seed while a modal is open", () => {
    const dlg = document.createElement("dialog");
    dlg.setAttribute("open", "");
    dlg.innerHTML = `<button id="dlg-btn">OK</button>`;
    document.body.appendChild(dlg);
    Object.defineProperty(dlg, "getClientRects", {
      value: () => [{ width: 10, height: 10 }],
      configurable: true,
    });
    expect(seedInitialCouchFocus(document)).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("focus surviving navigation (stored memory)", () => {
  it("restores the remembered card by stable key after the rail re-renders", () => {
    recordCouchFocus({
      route: window.location.pathname,
      rail: "continue",
      index: 1,
      key: "b",
    });
    // Simulate a route / content swap: the rail re-renders with
    // fresh elements carrying the same stable keys.
    const section = document.querySelector(
      '[data-nylah-rail="continue"]',
    ) as HTMLElement;
    section.innerHTML = `
      <a data-nylah-item href="/movies/a" data-couch-key="a" id="card-a2">A</a>
      <a data-nylah-item href="/movies/b" data-couch-key="b" id="card-b2">B</a>`;
    expect(document.activeElement).toBe(document.body);
    const restored = restoreCouchFocus(document);
    expect(restored?.id).toBe("card-b2");
    expect(document.activeElement?.id).toBe("card-b2");
  });
});
