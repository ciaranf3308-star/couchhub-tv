/**
 * @vitest-environment jsdom
 */
// W2 — 0.11.1 gamepad fix pass: the controller was completely dead on
// the user's PC ("Nope controller does NOTHING") while the same pad
// works in every game on the same machine. Three breaks in series,
// any one of which alone kills all input:
//
//   1. Detection: the poll loop only started when getGamepads()
//      already showed a pad at mount, or when a gamepadconnected
//      event arrived. Chromium hides an already-connected pad until
//      its first button press (gesture gate), and a connect event
//      fired by a press during page load — before the listener
//      exists — is lost forever. The loop must poll unconditionally.
//   2. Index: the loop read pads[0] only; a virtual device at 0
//      hides the real pad at 1+.
//   3. Delivery: synthetic KeyboardEvents carry keyCode 0 and
//      spatial-navigation.js read keyCode only (and was never even
//      initialised on CouchLayout pages), so input never reached
//      the focus engine.
//
// This file mounts the real gamepad loop against a mocked
// navigator.getGamepads() and drives it frame by frame (stubbed
// requestAnimationFrame): pad absent at mount, pad appearing at a
// non-zero index with NO gamepadconnected event, D-pad / A / B
// end to end, disconnect + reconnect.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mountGamepad, firstConnectedPad } from "@/scripts/lib/gamepad";
import { setCurrentNavigationView } from "@/scripts/lib/navigation-ownership";
// 0.11.14 (§2): this fixture IS the Home page, so it names the view
// "home" exactly as HomeView does via setLogicalView — the rail
// model only runs on rail/shelf views now.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
function pageSource(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

const BTN_A = 0;
const BTN_B = 1;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

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

interface FakePad {
  connected: boolean;
  index: number;
  id: string;
  mapping: string;
  buttons: Array<{ pressed: boolean; value: number }>;
  axes: number[];
  timestamp: number;
}

function makePad(index: number): {
  pad: FakePad;
  press: (button: number) => void;
  releaseAll: () => void;
} {
  const buttons = Array.from({ length: 17 }, () => ({
    pressed: false,
    value: 0,
  }));
  const pad: FakePad = {
    connected: true,
    index,
    id: "Xbox 360 Controller (STANDARD GAMEPAD)",
    mapping: "standard",
    buttons,
    axes: [0, 0, 0, 0],
    timestamp: 0,
  };
  return {
    pad,
    press: (button: number) => {
      buttons[button].pressed = true;
      buttons[button].value = 1;
    },
    releaseAll: () => {
      for (const b of buttons) {
        b.pressed = false;
        b.value = 0;
      }
    },
  };
}

// ── Frame driver: stubbed rAF, advanced by hand ─────────────────────

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

// ── Shared fixtures ────────────────────────────────────────────────

let pads: Array<FakePad | null> = [null, null, null, null];
const seenKeys: Array<{ key: string; keyCode: number }> = [];
const clicks: string[] = [];

beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});

  // jsdom reports zero-size boxes; the rail model requires visible
  // boxes, and scrollIntoView is stubbed to a no-op.
  const proto = Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
    scrollIntoView: () => void;
  };
  proto.getBoundingClientRect = () => fullRect();
  proto.scrollIntoView = () => {};

  setCurrentNavigationView("home");

  document.body.innerHTML = `
    <header data-couch-nav><nav><div data-nylah-rail="couch-nav">
      <a data-nylah-item href="/" aria-current="page" id="nav-home">Home</a>
      <a data-nylah-item href="/movies" id="nav-movies">Movies</a>
    </div></nav></header>
    <main><section data-nylah-rail="continue">
      <a data-nylah-item href="/movies/a" id="card-a">A</a>
      <a data-nylah-item href="/movies/b" id="card-b">B</a>
      <a data-nylah-item href="/movies/c" id="card-c">C</a>
    </section></main>`;

  Object.defineProperty(window.navigator, "getGamepads", {
    value: () => pads,
    configurable: true,
  });
  window.addEventListener("keydown", (e) => {
    seenKeys.push({ key: e.key, keyCode: e.keyCode });
  });
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && target.id) clicks.push(target.id);
  });

  // Mount with NO pad connected and NO gamepadconnected event: the
  // loop must already be polling (unconditional start), or the pad
  // that appears below is never discovered.
  mountGamepad();
  runFrames(3);
});

describe("firstConnectedPad", () => {
  it("returns null when nothing is connected", () => {
    expect(firstConnectedPad(null)).toBeNull();
    expect(firstConnectedPad(undefined)).toBeNull();
    expect(firstConnectedPad([null, null])).toBeNull();
    expect(
      firstConnectedPad([{ connected: false } as unknown as Gamepad]),
    ).toBeNull();
  });

  it("skips a disconnected pad at 0 and takes the live pad at 1", () => {
    const dead = { connected: false, index: 0 } as unknown as Gamepad;
    const live = { connected: true, index: 1 } as unknown as Gamepad;
    expect(firstConnectedPad([dead, live])).toBe(live);
  });

  it("takes the pad at 0 when it is connected", () => {
    const live = { connected: true, index: 0 } as unknown as Gamepad;
    expect(firstConnectedPad([live, null])).toBe(live);
  });
});

describe("gamepad loop with a mocked navigator.getGamepads()", () => {
  it("no pad at mount: frames run, focus stays on body, nothing throws", () => {
    runFrames(3);
    expect(document.activeElement).toBe(document.body);
  });

  it("pad appears at index 1 with NO gamepadconnected event: D-pad discovers it", () => {
    const { pad, press, releaseAll } = makePad(1);
    pads = [null, pad, null, null];
    // First press opens Chromium's gesture gate in production; the
    // loop must see the pad on the next frame without any event.
    press(BTN_DPAD_DOWN);
    runFrames(1);
    releaseAll();
    runFrames(1);
    // Down from no focus enters the first rail (the top nav).
    expect(document.activeElement?.id).toBe("nav-home");
    // Down again moves to the next rail (content).
    press(BTN_DPAD_DOWN);
    runFrames(1);
    releaseAll();
    runFrames(1);
    expect(document.activeElement?.id).toBe("card-a");
  });

  it("D-pad Right / Left move within the rail", () => {
    const { pad, press, releaseAll } = makePad(1);
    pads = [null, pad, null, null];
    expect(document.activeElement?.id).toBe("card-a");
    press(BTN_DPAD_RIGHT);
    runFrames(1);
    releaseAll();
    runFrames(1);
    expect(document.activeElement?.id).toBe("card-b");
    press(BTN_DPAD_LEFT);
    runFrames(1);
    releaseAll();
    runFrames(1);
    expect(document.activeElement?.id).toBe("card-a");
  });

  it("A activates the focused card", () => {
    const { pad, press, releaseAll } = makePad(1);
    pads = [null, pad, null, null];
    expect(document.activeElement?.id).toBe("card-a");
    clicks.length = 0;
    press(BTN_A);
    runFrames(1);
    releaseAll();
    runFrames(1);
    expect(clicks).toContain("card-a");
  });

  it("B dispatches Escape with a real keyCode (not 0)", () => {
    // 0.11.10 (Controller 2.0): B resolves through the Back
    // coordinator; with nothing registered, the migration bridge
    // dispatches the synthetic Escape — but only off Home root
    // (at "/" B is a no-op). This fixture renders the Home DOM at
    // jsdom's default "/" URL, so the bridge only fires once the
    // path is a non-Home route. The keyCode stamp itself is the
    // behaviour under test (break #3 in the header).
    window.history.replaceState(null, "", "/movies");
    const { pad, press, releaseAll } = makePad(1);
    pads = [null, pad, null, null];
    seenKeys.length = 0;
    press(BTN_B);
    runFrames(1);
    releaseAll();
    runFrames(1);
    expect(
      seenKeys.some((k) => k.key === "Escape" && k.keyCode === 27),
    ).toBe(true);
  });

  it("B at Home root dispatches nothing (0.11.10: root Home is a no-op)", () => {
    window.history.replaceState(null, "", "/");
    const { pad, press, releaseAll } = makePad(1);
    pads = [null, pad, null, null];
    seenKeys.length = 0;
    press(BTN_B);
    runFrames(1);
    releaseAll();
    runFrames(1);
    expect(seenKeys).toEqual([]);
  });

  it("pad disconnects and reconnects at index 0: navigation resumes", () => {
    pads = [null, null, null, null];
    runFrames(2);
    expect(document.activeElement?.id).toBe("card-a");
    const { pad, press, releaseAll } = makePad(0);
    pads = [pad, null, null, null];
    press(BTN_DPAD_RIGHT);
    runFrames(1);
    releaseAll();
    runFrames(1);
    expect(document.activeElement?.id).toBe("card-b");
  });
});

describe("wiring (source assertions)", () => {
  it("CouchLayout initialises spatial navigation (init + main section + makeFocusable)", () => {
    const src = pageSource("src/layouts/CouchLayout.astro");
    expect(src).toContain("sn.init()");
    expect(src).toContain('id: "main"');
    expect(src).toContain("sn.makeFocusable()");
  });

  it("gamepad.ts no longer reads pads[0] only", () => {
    const src = pageSource("src/scripts/lib/gamepad.ts");
    expect(src).not.toContain("pads[0]");
    expect(src).toContain("firstConnectedPad(pads)");
  });

  it("spatial-navigation.js derives the code from key for synthetic events", () => {
    const src = pageSource("src/scripts/spatial-navigation.js");
    expect(src).toContain("KEYCODE_BY_KEY");
    expect(src).toContain("evt.keyCode || KEYCODE_BY_KEY[evt.key]");
  });
});
