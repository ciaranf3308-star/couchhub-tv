/**
 * @vitest-environment jsdom
 */
// Controller Cursor Mode (0.11.10, W6) — focused tests for NEW /
// CHANGED behaviour only (§45 light scope). Hardware proof (pointer
// feel, real-click reliability on the mini PC, R3 detection on a
// physical pad, Rust compile) is explicitly the user's on-device
// test, not these tests.
//
// Covered: setting defaults to disabled; R3 toggle/exit/restore
// focus; the guard consumes A/RB/B before all routing (page handlers
// NOT called while active); View+Menu return-home still fires while
// active; deadzone/acceleration math; fallback axes mapping +
// native-wins arbitration; pointer/indicator DOM lifecycle; hints
// swap/restore; the Rust xinput-stick contract (static pin, following
// xinput-native.test.ts — no Rust toolchain in this sandbox).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CURSOR_DEADZONE,
  CURSOR_MAX_SPEED_PX_S,
  CURSOR_MIN_SPEED_PX_S,
  CURSOR_MODE_HINTS,
  applyStickDeadzone,
  clampCursorPosition,
  cursorPosition,
  cursorTargetSpeed,
  dispatchCursorClick,
  isCursorFallbackSuppressed,
  isCursorModeActive,
  isCursorModeEnabled,
  normalizeRawAxis,
  noteNativeStick,
  resetCursorModeForTests,
  setCursorModeActive,
  smoothVelocity,
  toggleCursorMode,
} from "@/scripts/lib/cursor-mode";
import {
  NATIVE_BUTTON_INDEX,
  dispatchNativeButton,
  handleGamepadButtonPress,
} from "@/scripts/lib/gamepad";
import {
  CURSOR_MODE_EVENT,
  getCursorMode,
  setCursorMode,
} from "@/scripts/lib/app-settings.js";

const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_RB = 5;
const BTN_MENU = 9;
const BTN_R3 = 11;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// ── rAF queue: frames run only when the test drives them ─────────────

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextRafId = 0;

function installRafQueue(): void {
  rafQueue = [];
  nextRafId = 0;
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = ++nextRafId;
    rafQueue.push({ id, cb });
    return id;
  }) as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number): void => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  }) as typeof cancelAnimationFrame;
}

function runFrameAt(t: number): void {
  const queue = rafQueue;
  rafQueue = [];
  for (const entry of queue) entry.cb(t);
}

function runFrames(count: number, start: number, step: number): void {
  for (let i = 0; i < count; i++) runFrameAt(start + i * step);
}

function enableCursorMode(): void {
  setCursorMode(true);
}

// jsdom has no elementFromPoint at all, so the stub is assigned
// directly (vi.spyOn would fail: the property does not exist). The
// production code try/catches a missing elementFromPoint, so this
// only affects tests.
function stubElementAt(target: Element | null): void {
  (
    document as unknown as {
      elementFromPoint: (x: number, y: number) => Element | null;
    }
  ).elementFromPoint = () => target;
}

function clearElementAtStub(): void {
  try {
    delete (
      document as unknown as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }
    ).elementFromPoint;
  } catch {
    // The stub was never assigned; nothing to clear.
  }
}

beforeEach(() => {
  installRafQueue();
  localStorage.clear();
  document.body.innerHTML = "";
  document.head
    .querySelectorAll("[data-cursor-mode-styles]")
    .forEach((el) => el.remove());
  delete document.documentElement.dataset.cursorMode;
  delete document.documentElement.dataset.livetvMode;
  clearElementAtStub();
  resetCursorModeForTests();
  // Release any held native buttons from a previous test so the
  // View+Menu chord state starts clean.
  dispatchNativeButton("view", false);
  dispatchNativeButton("menu", false);
  vi.restoreAllMocks();
});

afterEach(() => {
  resetCursorModeForTests();
  dispatchNativeButton("view", false);
  dispatchNativeButton("menu", false);
  delete document.documentElement.dataset.livetvMode;
});

// ── Setting ───────────────────────────────────────────────────────────

describe("cursor mode setting", () => {
  it("defaults to disabled when no key is stored", () => {
    expect(getCursorMode()).toBe(false);
    expect(isCursorModeEnabled()).toBe(false);
  });

  it("reads the stored value", () => {
    localStorage.setItem("xt_cursor_mode", "1");
    expect(isCursorModeEnabled()).toBe(true);
    localStorage.setItem("xt_cursor_mode", "");
    expect(isCursorModeEnabled()).toBe(false);
  });

  it("setCursorMode persists and dispatches the change event", () => {
    const seen: boolean[] = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent<{ value: boolean }>).detail.value);
    };
    document.addEventListener(CURSOR_MODE_EVENT, listener);
    setCursorMode(true);
    setCursorMode(false);
    document.removeEventListener(CURSOR_MODE_EVENT, listener);
    expect(localStorage.getItem("xt_cursor_mode")).toBeNull();
    expect(seen).toEqual([true, false]);
  });

  it("disabling mid-session exits cursor mode immediately", () => {
    enableCursorMode();
    setCursorModeActive(true);
    expect(isCursorModeActive()).toBe(true);
    setCursorMode(false);
    expect(isCursorModeActive()).toBe(false);
    expect(document.querySelector("[data-cursor-pointer]")).toBeNull();
  });
});

// ── Toggle / exit / focus restore ─────────────────────────────────────

describe("R3 toggle and exit", () => {
  it("R3 does nothing when the setting is disabled", () => {
    handleGamepadButtonPress(BTN_R3, 0);
    expect(isCursorModeActive()).toBe(false);
    expect(document.querySelector("[data-cursor-pointer]")).toBeNull();
  });

  it("R3 toggles when enabled, via the shared pipeline", () => {
    enableCursorMode();
    handleGamepadButtonPress(BTN_R3, 0);
    expect(isCursorModeActive()).toBe(true);
    handleGamepadButtonPress(BTN_R3, 0);
    expect(isCursorModeActive()).toBe(false);
  });

  it("R3 toggles via the native right_stick button event", () => {
    enableCursorMode();
    dispatchNativeButton("right_stick", true, 1000);
    expect(isCursorModeActive()).toBe(true);
    dispatchNativeButton("right_stick", false, 1100);
    dispatchNativeButton("right_stick", true, 1200);
    expect(isCursorModeActive()).toBe(false);
  });

  it("right_stick maps to standard index 11", () => {
    expect(NATIVE_BUTTON_INDEX.right_stick).toBe(11);
  });

  it("B exits without changing the page (no Escape dispatched)", () => {
    enableCursorMode();
    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));
    setCursorModeActive(true);
    handleGamepadButtonPress(BTN_B, 0);
    expect(isCursorModeActive()).toBe(false);
    expect(keys).not.toContain("Escape");
  });

  it("toggleCursorMode respects the setting", () => {
    toggleCursorMode();
    expect(isCursorModeActive()).toBe(false);
    enableCursorMode();
    toggleCursorMode();
    expect(isCursorModeActive()).toBe(true);
    toggleCursorMode();
    expect(isCursorModeActive()).toBe(false);
  });

  it("restores focus to the pre-cursor element on exit", () => {
    enableCursorMode();
    const before = document.createElement("button");
    before.textContent = "before";
    document.body.appendChild(before);
    before.focus();
    setCursorModeActive(true);
    setCursorModeActive(false);
    expect(document.activeElement).toBe(before);
  });

  it("creates the pointer + indicator only while active", () => {
    enableCursorMode();
    expect(document.querySelector("[data-cursor-pointer]")).toBeNull();
    expect(document.querySelector("[data-cursor-mode-indicator]")).toBeNull();
    setCursorModeActive(true);
    expect(document.querySelector("[data-cursor-pointer]")).not.toBeNull();
    const indicator = document.querySelector("[data-cursor-mode-indicator]");
    expect(indicator?.textContent).toContain("Right stick moves");
    expect(document.documentElement.dataset.cursorMode).toBe("active");
    setCursorModeActive(false);
    expect(document.querySelector("[data-cursor-pointer]")).toBeNull();
    expect(document.querySelector("[data-cursor-mode-indicator]")).toBeNull();
    expect(document.documentElement.dataset.cursorMode).toBeUndefined();
  });

  it("exposes the cursor hint set and signals it via data-cursor-mode", () => {
    // The legend itself is rendered by TvButtonHints.astro (an Astro
    // component, not unit-testable here): it shows CURSOR_MODE_HINTS
    // while html[data-cursor-mode="active"] is present — see the
    // static pin below. This test pins the config content + the
    // signal; the headless render proves the legend actually swaps.
    expect(CURSOR_MODE_HINTS.id).toBe("cursor-mode");
    expect(CURSOR_MODE_HINTS.items.map((item) => item.glyph)).toEqual([
      "a",
      "rb",
      "b",
      "view-menu",
    ]);
    expect(CURSOR_MODE_HINTS.items.map((item) => item.label)).toEqual([
      "Click",
      "Right-click",
      "Exit cursor",
      "Return home",
    ]);
    enableCursorMode();
    setCursorModeActive(true);
    expect(document.documentElement.dataset.cursorMode).toBe("active");
    setCursorModeActive(false);
    expect(document.documentElement.dataset.cursorMode).toBeUndefined();
  });

  it("dispatches a couch:cursor-mode event on transitions", () => {
    enableCursorMode();
    const seen: boolean[] = [];
    window.addEventListener("couch:cursor-mode", (event) => {
      seen.push((event as CustomEvent<{ active: boolean }>).detail.active);
    });
    setCursorModeActive(true);
    setCursorModeActive(false);
    expect(seen).toEqual([true, false]);
  });
});

// ── Guard ordering: cursor consumes A/RB before all routing ──────────

describe("cursor guard ordering", () => {

  it("A clicks under the pointer and does NOT activate the focused control", () => {
    enableCursorMode();
    const focused = document.createElement("button");
    focused.textContent = "focused";
    const focusedClicks = vi.fn();
    focused.addEventListener("click", focusedClicks);
    document.body.appendChild(focused);
    focused.focus();

    const target = document.createElement("div");
    const targetClicks = vi.fn();
    target.addEventListener("click", targetClicks);
    document.body.appendChild(target);
    stubElementAt(target);

    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));

    setCursorModeActive(true);
    handleGamepadButtonPress(BTN_A, 0);

    expect(targetClicks).toHaveBeenCalledTimes(1);
    expect(focusedClicks).not.toHaveBeenCalled();
    expect(keys).not.toContain("Enter");
  });

  it("RB right-clicks and does NOT turn pages / step categories", () => {
    // In the Live TV browser RB normally dispatches "]" (next
    // category). While Cursor Mode is active it must dispatch a
    // contextmenu instead and no key at all.
    document.documentElement.dataset.livetvMode = "browser";
    enableCursorMode();
    const target = document.createElement("div");
    const menus = vi.fn();
    target.addEventListener("contextmenu", menus);
    document.body.appendChild(target);
    stubElementAt(target);

    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));

    setCursorModeActive(true);
    handleGamepadButtonPress(BTN_RB, 0);

    expect(menus).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([]);
  });

  it("RB dispatches a key again once cursor mode exits", () => {
    document.documentElement.dataset.livetvMode = "browser";
    enableCursorMode();
    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));
    handleGamepadButtonPress(BTN_RB, 0);
    expect(keys).toContain("]");
  });

  it("other buttons are swallowed while active (X dispatches nothing)", () => {
    enableCursorMode();
    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));
    setCursorModeActive(true);
    handleGamepadButtonPress(BTN_X, 0);
    handleGamepadButtonPress(BTN_MENU, 0);
    expect(keys).toEqual([]);
    expect(isCursorModeActive()).toBe(true);
  });

  it("View+Menu held 2s still returns home while cursor mode is active", () => {
    enableCursorMode();
    const homes = vi.fn();
    window.addEventListener("couchhubtv:return-home", homes);
    setCursorModeActive(true);
    dispatchNativeButton("view", true, 1000);
    dispatchNativeButton("menu", true, 1000);
    expect(homes).not.toHaveBeenCalled();
    // A further edge past the hold window completes the chord.
    dispatchNativeButton("view", true, 3100);
    expect(homes).toHaveBeenCalledTimes(1);
  });
});

// ── Click dispatch ────────────────────────────────────────────────────

describe("cursor clicks", () => {
  it("left click dispatches the mouse sequence with pointer coordinates", () => {
    enableCursorMode();
    const target = document.createElement("button");
    const seen: Array<{ type: string; x: number; y: number; button: number }> = [];
    for (const type of ["mousedown", "mouseup", "click"]) {
      target.addEventListener(type, (event) => {
        const mouse = event as MouseEvent;
        seen.push({ type, x: mouse.clientX, y: mouse.clientY, button: mouse.button });
      });
    }
    document.body.appendChild(target);
    stubElementAt(target);
    setCursorModeActive(true);
    const at = cursorPosition();
    dispatchCursorClick("left");
    expect(seen.map((entry) => entry.type)).toEqual(["mousedown", "mouseup", "click"]);
    for (const entry of seen) {
      expect(entry.x).toBe(at.x);
      expect(entry.y).toBe(at.y);
      expect(entry.button).toBe(0);
    }
    // A real mousedown focuses the clicked control.
    expect(document.activeElement).toBe(target);
  });

  it("right click dispatches contextmenu with button 2", () => {
    enableCursorMode();
    const target = document.createElement("div");
    const menus: MouseEvent[] = [];
    target.addEventListener("contextmenu", (event) => menus.push(event as MouseEvent));
    document.body.appendChild(target);
    stubElementAt(target);
    setCursorModeActive(true);
    dispatchCursorClick("right");
    expect(menus).toHaveLength(1);
    expect(menus[0].button).toBe(2);
  });

  it("clicks are a safe no-op when inactive or over nothing", () => {
    const target = document.createElement("button");
    const clicks = vi.fn();
    target.addEventListener("click", clicks);
    document.body.appendChild(target);
    stubElementAt(target);
    expect(() => dispatchCursorClick("left")).not.toThrow();
    expect(clicks).not.toHaveBeenCalled();

    enableCursorMode();
    setCursorModeActive(true);
    stubElementAt(null);
    expect(() => dispatchCursorClick("left")).not.toThrow();
    expect(clicks).not.toHaveBeenCalled();
  });
});

// ── Stop conditions: blur / hide / disconnect / exit clears state ─────

describe("cursor stop conditions", () => {
  it("window blur exits cursor mode and removes the pointer", () => {
    enableCursorMode();
    setCursorModeActive(true);
    expect(isCursorModeActive()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(isCursorModeActive()).toBe(false);
    expect(document.querySelector("[data-cursor-pointer]")).toBeNull();
  });

  it("hiding the tab exits cursor mode", () => {
    enableCursorMode();
    setCursorModeActive(true);
    const descriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(isCursorModeActive()).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(document, "hidden", descriptor);
      else delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it("controller disconnect exits cursor mode", () => {
    enableCursorMode();
    setCursorModeActive(true);
    window.dispatchEvent(new Event("gamepaddisconnected"));
    expect(isCursorModeActive()).toBe(false);
    expect(document.querySelector("[data-cursor-pointer]")).toBeNull();
  });

  it("exit clears the stick vector, so reactivation starts still", () => {
    enableCursorMode();
    setCursorModeActive(true);
    noteNativeStick(32767, 0, 1000);
    runFrames(5, 1000, 16);
    expect(cursorPosition().x).toBeGreaterThan(0);
    setCursorModeActive(false);
    // Reactivate with no new stick event: the cleared vector means
    // no movement, and no stale deflection resumes the pointer.
    setCursorModeActive(true);
    const start = cursorPosition();
    runFrames(10, 2000, 16);
    expect(cursorPosition()).toEqual(start);
  });
});

// ── Movement math ─────────────────────────────────────────────────────

describe("pointer movement math", () => {
  it("normalises raw i16 axes", () => {
    expect(normalizeRawAxis(32767)).toBe(1);
    expect(normalizeRawAxis(-32767)).toBe(-1);
    expect(normalizeRawAxis(-32768)).toBe(-1);
    expect(normalizeRawAxis(0)).toBe(0);
    expect(normalizeRawAxis(7849)).toBeCloseTo(CURSOR_DEADZONE, 10);
  });

  it("deadzone swallows drift and rescales the surviving range", () => {
    expect(applyStickDeadzone(0, 0)).toEqual({ x: 0, y: 0 });
    expect(applyStickDeadzone(0.1, 0)).toEqual({ x: 0, y: 0 });
    expect(applyStickDeadzone(CURSOR_DEADZONE, 0)).toEqual({ x: 0, y: 0 });
    const full = applyStickDeadzone(1, 0);
    expect(full.x).toBeCloseTo(1, 10);
    expect(full.y).toBe(0);
    const half = applyStickDeadzone(0.5, 0);
    const expected = (0.5 - CURSOR_DEADZONE) / (1 - CURSOR_DEADZONE);
    expect(half.x).toBeCloseTo(expected, 10);
    // Direction is preserved on diagonals.
    const diag = applyStickDeadzone(0.6, 0.6);
    expect(diag.x).toBeCloseTo(diag.y, 10);
    expect(diag.x).toBeGreaterThan(0);
  });

  it("speed eases quadratically and is capped", () => {
    expect(cursorTargetSpeed(0)).toBe(CURSOR_MIN_SPEED_PX_S);
    expect(cursorTargetSpeed(1)).toBe(CURSOR_MAX_SPEED_PX_S);
    expect(cursorTargetSpeed(0.5)).toBe(
      CURSOR_MIN_SPEED_PX_S + (CURSOR_MAX_SPEED_PX_S - CURSOR_MIN_SPEED_PX_S) * 0.25,
    );
    expect(cursorTargetSpeed(2)).toBe(CURSOR_MAX_SPEED_PX_S);
    expect(cursorTargetSpeed(-1)).toBe(CURSOR_MIN_SPEED_PX_S);
    expect(cursorTargetSpeed(0.25)).toBeLessThan(cursorTargetSpeed(0.5));
  });

  it("velocity smoothing converges on the target", () => {
    let velocity = 0;
    for (let i = 0; i < 120; i++) velocity = smoothVelocity(velocity, 100, 16.7);
    expect(velocity).toBeGreaterThan(99);
    expect(smoothVelocity(50, 100, 0)).toBe(50);
  });

  it("clamps positions to the viewport", () => {
    expect(clampCursorPosition(-5, -5, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(clampCursorPosition(5000, 5000, 1920, 1080)).toEqual({ x: 1919, y: 1079 });
    expect(clampCursorPosition(100, 100, 1920, 1080)).toEqual({ x: 100, y: 100 });
  });

  it("a deflected native stick moves the pointer right across frames", () => {
    enableCursorMode();
    setCursorModeActive(true);
    const start = cursorPosition();
    noteNativeStick(32767, 0, 1000);
    runFrames(10, 1000, 16);
    const end = cursorPosition();
    expect(end.x).toBeGreaterThan(start.x + 20);
    expect(end.y).toBe(start.y);
  });

  it("a centred stick stops the pointer (zero event)", () => {
    enableCursorMode();
    setCursorModeActive(true);
    noteNativeStick(32767, 0, 1000);
    runFrames(10, 1000, 16);
    const moving = cursorPosition();
    noteNativeStick(0, 0, 1200);
    runFrames(120, 1200, 16);
    const settled = cursorPosition();
    // Smoothing overshoot is bounded: the pointer glides to a stop
    // instead of running away after the stick centres.
    expect(settled.x - moving.x).toBeLessThan(200);
    runFrames(30, 3200, 16);
    expect(cursorPosition().x).toBeCloseTo(settled.x, 6);
  });

  it("native Y is inverted to screen space (stick up moves up)", () => {
    enableCursorMode();
    setCursorModeActive(true);
    const start = cursorPosition();
    // XInput Y up-positive: +32767 is stick UP, so screen Y falls.
    noteNativeStick(0, 32767, 1000);
    runFrames(10, 1000, 16);
    expect(cursorPosition().y).toBeLessThan(start.y);
  });
});

// ── Fallback axes + arbitration ───────────────────────────────────────

describe("gamepad fallback axes and arbitration", () => {
  function stubPad(axes: number[]): void {
    const pad = { connected: true, axes, index: 0, id: "test pad" };
    Object.defineProperty(navigator, "getGamepads", {
      value: () => [pad],
      configurable: true,
    });
  }

  afterEach(() => {
    // Remove the stub so other tests see the real (absent) API.
    try {
      // @ts-expect-error jsdom navigator has no getGamepads by default
      delete (navigator as Record<string, unknown>).getGamepads;
    } catch {
      // Leave the stub; the file's other tests do not poll axes.
    }
  });

  it("fallback axes 2/3 drive the pointer when native is silent", () => {
    enableCursorMode();
    stubPad([0, 0, 1, 0]);
    setCursorModeActive(true);
    const start = cursorPosition();
    runFrames(10, 1000, 16);
    expect(cursorPosition().x).toBeGreaterThan(start.x + 20);
  });

  it("a recent native stick vector suppresses the fallback axes", () => {
    enableCursorMode();
    stubPad([0, 0, 1, 0]);
    setCursorModeActive(true);
    // Native stick centred at t=1000: fallback must stand down for
    // the 1500 ms silence window even though the pad reports axes.
    noteNativeStick(0, 0, 1000);
    expect(isCursorFallbackSuppressed(1100)).toBe(true);
    expect(isCursorFallbackSuppressed(2499)).toBe(true);
    expect(isCursorFallbackSuppressed(2500)).toBe(false);
    const start = cursorPosition();
    runFrames(10, 1000, 16);
    expect(cursorPosition().x).toBe(start.x);
    // Past the window the fallback resumes.
    runFrames(10, 2600, 16);
    expect(cursorPosition().x).toBeGreaterThan(start.x);
  });

  it("fallback Y is already screen-down (no inversion)", () => {
    enableCursorMode();
    stubPad([0, 0, 0, 1]);
    setCursorModeActive(true);
    const start = cursorPosition();
    runFrames(10, 1000, 16);
    expect(cursorPosition().y).toBeGreaterThan(start.y);
  });
});

// ── Rust contract (static pin) ────────────────────────────────────────

describe("xinput-stick Rust contract", () => {
  const rust = readFileSync(resolve(repoRoot, "src-tauri/src/xinput.rs"), "utf8");
  const bridge = readFileSync(
    resolve(repoRoot, "src/scripts/lib/native-gamepad.ts"),
    "utf8",
  );

  it("forwards right-stick axes as a bounded xinput-stick event", () => {
    expect(rust).toContain('"xinput-stick"');
    expect(rust).toContain("struct XInputStickEvent");
    expect(rust).toContain("x: i16");
    expect(rust).toContain("y: i16");
    expect(rust).toContain("STICK_EVENT_INTERVAL_MS");
    expect(rust).toContain("stick_active");
    expect(rust).toContain("last_stick_emit");
    expect(rust).toContain("s_thumb_rx");
    expect(rust).toContain("s_thumb_ry");
  });

  it("uses the XInput dead zone for the stick gate", () => {
    expect(rust).toContain("STICK_DEADZONE: i16 = 7849");
  });

  it("still maps the R3 button bit to the right_stick event", () => {
    expect(rust).toContain('(BTN_RIGHT_THUMB, "right_stick")');
  });

  it("the frontend bridge listens for xinput-stick on the driving slot", () => {
    expect(bridge).toContain('"xinput-stick"');
    expect(bridge).toContain("noteNativeStick");
    expect(bridge).toContain("slotOwnsEvent(slot)");
  });

  it("the hints legend renders the cursor set while data-cursor-mode is active", () => {
    // Static pin: TvButtonHints.astro is the legend's single writer.
    // A DOM swap from cursor-mode.ts does NOT survive its
    // MutationObserver re-render (proven by the headless render), so
    // the attribute + observer filter below are the real wiring.
    const legend = readFileSync(
      resolve(repoRoot, "src/components/couch/TvButtonHints.astro"),
      "utf8",
    );
    expect(legend).toContain("CURSOR_MODE_HINTS");
    expect(legend).toContain('dataset.cursorMode === "active"');
    expect(legend).toContain('"data-cursor-mode"');
  });
});
