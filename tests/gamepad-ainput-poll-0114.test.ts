/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1b (§7.3/§7.15) — the browser Gamepad API fallback half:
// pollLoop's editing branch must route A through the shared pipeline
// (exactly like the native XInput path), while directions stay
// swallowed there (the documented editing-direction asymmetry) and B
// keeps working. Drives the real poll loop frame by frame (stubbed
// rAF, mocked navigator.getGamepads), following
// tests/gamepad-cursor-guard-0114.test.ts. Kept in its own file so
// no native-path call can open the native-liveness window and stand
// the fallback loop down.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mountGamepad } from "@/scripts/lib/gamepad";
import {
  endCouchKeyboardSession,
  isCouchKeyboardOpen,
  openCouchKeyboard,
} from "@/scripts/lib/couch-keyboard";

const BTN_A = 0;
const BTN_B = 1;
const BTN_DPAD_DOWN = 13;

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

function pressButton(index: number): void {
  buttons[index].pressed = true;
  buttons[index].value = 1;
  runFrames(2);
  releaseAll();
  runFrames(2);
}

function buildEditingDom(): { input: HTMLInputElement; firstKey: HTMLElement } {
  document.body.innerHTML = `
    <input type="search" id="search-input" />
    <div data-couch-keyboard><div data-osk>
      <button type="button" data-osk-key="1" id="osk-1">1</button>
      <button type="button" data-osk-key="2" id="osk-2">2</button>
    </div></div>`;
  return {
    input: document.getElementById("search-input") as HTMLInputElement,
    firstKey: document.getElementById("osk-1") as HTMLElement,
  };
}

describe("pollLoop A-in-editing (§7.3/§7.15 fallback path)", () => {
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
    endCouchKeyboardSession();
    document.body.innerHTML = "";
    runFrames(2);
  });

  it("A on a focused input enters the key grid on the fallback path", () => {
    const { input, firstKey } = buildEditingDom();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();
    expect(document.activeElement).toBe(input);

    pressButton(BTN_A);

    expect(document.activeElement).toBe(firstKey);
    expect(seenKeys).toEqual([]);
    expect(isCouchKeyboardOpen()).toBe(true);
  });

  it("directions while editing are still swallowed on the fallback path (asymmetry preserved)", () => {
    const { input } = buildEditingDom();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();

    pressButton(BTN_DPAD_DOWN);

    expect(document.activeElement).toBe(input);
    expect(seenKeys).toEqual([]);
  });

  it("B while editing still dismisses the session on the fallback path", () => {
    const { input } = buildEditingDom();
    input.value = "keep me";
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();

    pressButton(BTN_B);

    expect(isCouchKeyboardOpen()).toBe(false);
    expect(input.value).toBe("keep me");
    expect(document.activeElement).toBe(input);
  });

  it("A on a plain field with no keyboard surface stays a no-op on the fallback path", () => {
    document.body.innerHTML = `<input type="text" id="plain" />`;
    const input = document.getElementById("plain") as HTMLInputElement;
    input.focus();

    pressButton(BTN_A);

    expect(document.activeElement).toBe(input);
    expect(isCouchKeyboardOpen()).toBe(false);
    expect(seenKeys).toEqual([]);
  });
});
