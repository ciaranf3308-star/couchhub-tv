/**
 * @vitest-environment jsdom
 */
// W2 — 0.11.1 gamepad fix pass, cold-launch case: the controller is
// already connected BEFORE the app launches, and no gamepadconnected
// event ever fires (in production Chromium only reveals the pad on
// its first button press, and an event fired during page load can be
// missed entirely). The loop must still pick the pad up from the
// startup snapshot and drive focus from the first press — no mouse
// click or keypress first.
//
// Separate file from gamepad-0111.test.ts so this mount (pad present
// at import time) gets a fresh jsdom window with no prior mount.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { mountGamepad } from "@/scripts/lib/gamepad";
import { setCurrentNavigationView } from "@/scripts/lib/navigation-ownership";

const BTN_DPAD_DOWN = 13;

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

let rafQueue: Array<(t: number) => void> = [];
let now = 0;

function runFrames(n: number): void {
  for (let i = 0; i < n; i++) {
    const queue = rafQueue;
    rafQueue = [];
    now += 16;
    for (const cb of queue) cb(now);
  }
}

describe("already-connected pad at cold launch", () => {
  beforeAll(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const proto = Element.prototype as unknown as {
      getBoundingClientRect: () => DOMRect;
      scrollIntoView: () => void;
    };
    proto.getBoundingClientRect = () => fullRect();
    proto.scrollIntoView = () => {};

    // 0.11.14 (§2): this fixture IS the Home page — it names the
    // view "home" as HomeView does, so the rail model applies.
    setCurrentNavigationView("home");

    document.body.innerHTML = `
      <header data-couch-nav><nav><div data-nylah-rail="couch-nav">
        <a data-nylah-item href="/" aria-current="page" id="nav-home">Home</a>
        <a data-nylah-item href="/movies" id="nav-movies">Movies</a>
      </div></nav></header>
      <main><section data-nylah-rail="continue">
        <a data-nylah-item href="/movies/a" id="card-a">A</a>
        <a data-nylah-item href="/movies/b" id="card-b">B</a>
      </section></main>`;

    // The pad is already connected BEFORE mountGamepad runs, and no
    // gamepadconnected event is ever dispatched in this file.
    const buttons = Array.from({ length: 17 }, () => ({
      pressed: false,
      value: 0,
    }));
    const pad = {
      connected: true,
      index: 0,
      id: "Xbox 360 Controller (STANDARD GAMEPAD)",
      mapping: "standard",
      buttons,
      axes: [0, 0, 0, 0],
      timestamp: 0,
    };
    (globalThis as unknown as { __padButtons: typeof buttons }).__padButtons =
      buttons;
    Object.defineProperty(window.navigator, "getGamepads", {
      value: () => [pad, null, null, null],
      configurable: true,
    });

    mountGamepad();
    runFrames(2);
  });

  it("D-pad Down from a cold launch focuses the first rail, with no event and no prior input", () => {
    const buttons = (
      globalThis as unknown as {
        __padButtons: Array<{ pressed: boolean; value: number }>;
      }
    ).__padButtons;
    expect(document.activeElement).toBe(document.body);
    buttons[BTN_DPAD_DOWN].pressed = true;
    buttons[BTN_DPAD_DOWN].value = 1;
    runFrames(1);
    buttons[BTN_DPAD_DOWN].pressed = false;
    buttons[BTN_DPAD_DOWN].value = 0;
    runFrames(1);
    expect(document.activeElement?.id).toBe("nav-home");
  });
});
