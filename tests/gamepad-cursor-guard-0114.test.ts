/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1/W2 seam (§6, no-dual-route rule) — the browser Gamepad
// API fallback path in gamepad.ts pollLoop must skip stickDirection()
// while Cursor Mode is active: the left stick scrolls (cursor-mode
// reads axes 0/1 itself) and must never also move focus. D-pad
// buttons still flow, and the stick drives focus again the moment
// Cursor Mode exits. The native XInput path drops source:"stick"
// directions the same way (W2, native-gamepad.ts); this pins the
// fallback half, which W1 owns.
//
// Drives the real poll loop frame by frame (stubbed rAF, mocked
// navigator.getGamepads), following tests/gamepad-0111.test.ts.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mountGamepad } from "@/scripts/lib/gamepad";
import { setCurrentNavigationView } from "@/scripts/lib/navigation-ownership";
import { setCursorModeActive } from "@/scripts/lib/cursor-mode";

const BTN_DPAD_RIGHT = 15;

function fullRect(): DOMRect {
  return {
    width: 120,
    height: 40,
    top: 0,
    left: 0,
    right: 120,
    bottom: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

interface FakePad {
  connected: boolean;
  index: number;
  id: string;
  mapping: string;
  buttons: Array<{ pressed: boolean; value: number }>;
  axes: number[];
  timestamp: number;
}

const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
const pad: FakePad = {
  connected: true,
  index: 0,
  id: "test-pad",
  mapping: "standard",
  buttons,
  axes: [0, 0, 0, 0],
  timestamp: 0,
};

let rafQueue: Array<(t: number) => void> = [];
let now = 0;
const seenKeys: string[] = [];

function runFrames(n: number): void {
  for (let i = 0; i < n; i++) {
    const queue = rafQueue;
    rafQueue = [];
    now += 16;
    for (const cb of queue) cb(now);
  }
}

function releaseAll(): void {
  for (const b of buttons) {
    b.pressed = false;
    b.value = 0;
  }
  pad.axes = [0, 0, 0, 0];
}

describe("pollLoop cursor guard (§6 no-dual-route)", () => {
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

    setCurrentNavigationView("home");
    document.body.innerHTML = `
      <main><section data-nylah-rail="continue">
        <a data-nylah-item href="/movies/a" id="card-a">A</a>
        <a data-nylah-item href="/movies/b" id="card-b">B</a>
        <a data-nylah-item href="/movies/c" id="card-c">C</a>
      </section></main>`;
    Object.defineProperty(window.navigator, "getGamepads", {
      value: () => [pad],
      configurable: true,
    });
    window.addEventListener("keydown", (e) => {
      seenKeys.push(e.key);
    });
    mountGamepad();
    runFrames(2);
  });

  beforeEach(() => {
    releaseAll();
    seenKeys.length = 0;
    runFrames(2);
  });

  afterEach(() => {
    releaseAll();
    try {
      setCursorModeActive(false);
    } catch {
      // Cursor mode was never activated.
    }
    localStorage.clear();
    runFrames(2);
  });

  it("left stick does not move focus while Cursor Mode is active", () => {
    (document.getElementById("card-a") as HTMLElement).focus();
    localStorage.setItem("xt_cursor_mode", "1");
    setCursorModeActive(true);
    pad.axes = [1, 0, 0, 0]; // full right deflection
    runFrames(10);
    expect((document.activeElement as HTMLElement).id).toBe("card-a");
    expect(seenKeys).not.toContain("ArrowRight");
  });

  it("D-pad still moves focus while Cursor Mode is active", () => {
    (document.getElementById("card-a") as HTMLElement).focus();
    localStorage.setItem("xt_cursor_mode", "1");
    setCursorModeActive(true);
    buttons[BTN_DPAD_RIGHT].pressed = true;
    buttons[BTN_DPAD_RIGHT].value = 1;
    runFrames(2);
    expect((document.activeElement as HTMLElement).id).toBe("card-b");
  });

  it("a stick held across activation stops moving focus once Cursor Mode turns on", () => {
    (document.getElementById("card-a") as HTMLElement).focus();
    pad.axes = [1, 0, 0, 0];
    runFrames(2);
    expect((document.activeElement as HTMLElement).id).toBe("card-b");
    // R3 mid-hold: the held stick must not keep repeating into card-c.
    localStorage.setItem("xt_cursor_mode", "1");
    setCursorModeActive(true);
    runFrames(30);
    expect((document.activeElement as HTMLElement).id).toBe("card-b");
  });

  it("left stick drives focus again after Cursor Mode exits", () => {
    (document.getElementById("card-a") as HTMLElement).focus();
    localStorage.setItem("xt_cursor_mode", "1");
    setCursorModeActive(true);
    pad.axes = [1, 0, 0, 0];
    runFrames(5);
    expect((document.activeElement as HTMLElement).id).toBe("card-a");
    setCursorModeActive(false);
    runFrames(5);
    // The still-deflected stick is a fresh edge once the guard lifts.
    expect((document.activeElement as HTMLElement).id).toBe("card-b");
  });
});
