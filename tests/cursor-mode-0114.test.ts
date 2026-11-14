/**
 * @vitest-environment jsdom
 */
// Controller Cursor Mode — left-stick scrolling (0.11.14, W2, §6).
// Focused tests for NEW / CHANGED behaviour only (§27 light scope).
// Hardware proof (scroll feel, click reliability on the mini PC,
// Rust compile) is explicitly the user's on-device test.
//
// Covered: scroll-container resolution incl. the modal guard;
// scroll speed math; frame-driven vertical/horizontal scrolling via
// xinput-scroll and via the Gamepad API fallback axes (incl.
// native-wins arbitration); the no-dual-route contract (static pins
// on Rust + the bridge + the fallback poll); exit focus restore to
// the last-interacted element / nearest control; the enabled-by-
// default preference with a durable explicit disable; synthetic
// click default-behaviour emulation (checkbox / radio / range);
// hover event dispatch; scroll-availability hints signal.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CURSOR_SCROLL_MAX_SPEED_PX_S,
  CURSOR_SCROLL_MIN_SPEED_PX_S,
  cursorPosition,
  cursorScrollSpeed,
  dispatchCursorClick,
  findScrollContainer,
  isCursorModeActive,
  isCursorScrollAvailable,
  isScrollableX,
  isScrollableY,
  nearestFocusableToPoint,
  noteNativeScrollStick,
  noteNativeStick,
  resetCursorModeForTests,
  resolveScrollTargets,
  resolveScrollTargetsFromElement,
  setCursorModeActive,
} from "@/scripts/lib/cursor-mode";
import { handleGamepadButtonPress } from "@/scripts/lib/gamepad";
import {
  getCursorMode,
  setCursorMode,
} from "@/scripts/lib/app-settings.js";

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

// elementFromPoint stub with a mutable target, so hover tests can
// move the pointer across elements mid-run.
let stubbedTarget: Element | null = null;

function stubElementAt(target: Element | null): void {
  stubbedTarget = target;
  (
    document as unknown as {
      elementFromPoint: (x: number, y: number) => Element | null;
    }
  ).elementFromPoint = () => stubbedTarget;
}

function clearElementAtStub(): void {
  stubbedTarget = null;
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

function stubScrollMetrics(
  el: HTMLElement,
  metrics: {
    scrollHeight?: number;
    clientHeight?: number;
    scrollWidth?: number;
    clientWidth?: number;
  },
): void {
  if (metrics.scrollHeight !== undefined) {
    Object.defineProperty(el, "scrollHeight", {
      value: metrics.scrollHeight,
      configurable: true,
    });
  }
  if (metrics.clientHeight !== undefined) {
    Object.defineProperty(el, "clientHeight", {
      value: metrics.clientHeight,
      configurable: true,
    });
  }
  if (metrics.scrollWidth !== undefined) {
    Object.defineProperty(el, "scrollWidth", {
      value: metrics.scrollWidth,
      configurable: true,
    });
  }
  if (metrics.clientWidth !== undefined) {
    Object.defineProperty(el, "clientWidth", {
      value: metrics.clientWidth,
      configurable: true,
    });
  }
}

function stubRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function makeModalVisible(modal: HTMLElement): void {
  // findOpenModal requires a real box: jsdom reports none, so stub
  // getClientRects to a single rect.
  Object.defineProperty(modal, "getClientRects", {
    value: () => [{ width: 100, height: 100 }],
    configurable: true,
  });
}

beforeEach(() => {
  installRafQueue();
  localStorage.clear();
  // Scroll-metric stubs on <html>/<body> survive across tests in this
  // file (same jsdom document): drop the own properties so each test
  // sees the prototype's real (zero) metrics unless it stubs its own.
  for (const el of [document.documentElement, document.body]) {
    for (const prop of ["scrollHeight", "clientHeight", "scrollWidth", "clientWidth"]) {
      try {
        delete (el as unknown as Record<string, unknown>)[prop];
      } catch {
        // No own property to drop.
      }
    }
  }
  document.body.innerHTML = "";
  document.head
    .querySelectorAll("[data-cursor-mode-styles]")
    .forEach((el) => el.remove());
  delete document.documentElement.dataset.cursorMode;
  delete document.documentElement.dataset.cursorScroll;
  clearElementAtStub();
  resetCursorModeForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  resetCursorModeForTests();
  try {
    // @ts-expect-error jsdom navigator has no getGamepads by default
    delete (navigator as Record<string, unknown>).getGamepads;
  } catch {
    // Leave the stub; it is replaced per test.
  }
});

// ── Preference: enabled by default, explicit disable durable ─────────

describe("cursor mode preference (0.11.14 default)", () => {
  it("defaults to enabled when no key is stored (new installs)", () => {
    expect(getCursorMode()).toBe(true);
  });

  it("an explicit disable persists as \"0\" and reads as off", () => {
    setCursorMode(false);
    expect(localStorage.getItem("xt_cursor_mode")).toBe("0");
    expect(getCursorMode()).toBe(false);
    // A later read in a fresh call still honours the disable.
    expect(getCursorMode()).toBe(false);
  });

  it("an explicit enable persists as \"1\"", () => {
    setCursorMode(false);
    setCursorMode(true);
    expect(localStorage.getItem("xt_cursor_mode")).toBe("1");
    expect(getCursorMode()).toBe(true);
  });

  it("R3 toggles with no stored key (no explicit enable needed)", () => {
    handleGamepadButtonPress(BTN_R3, 0);
    expect(isCursorModeActive()).toBe(true);
    handleGamepadButtonPress(BTN_R3, 0);
    expect(isCursorModeActive()).toBe(false);
  });

  it("R3 does nothing after an explicit disable", () => {
    setCursorMode(false);
    handleGamepadButtonPress(BTN_R3, 0);
    expect(isCursorModeActive()).toBe(false);
    expect(document.querySelector("[data-cursor-pointer]")).toBeNull();
  });
});

// ── Scroll-container resolution ──────────────────────────────────────

describe("scroll-container resolution", () => {
  it("isScrollableY requires overflowing content and a scrolling overflow", () => {
    // Attached: getComputedStyle on a detached element caches stale
    // values in jsdom, and resolution only ever runs in-document.
    const el = document.createElement("div");
    document.body.appendChild(el);
    stubScrollMetrics(el, { scrollHeight: 2000, clientHeight: 500 });
    el.style.overflowY = "auto";
    expect(isScrollableY(el)).toBe(true);
    el.style.overflowY = "hidden";
    expect(isScrollableY(el)).toBe(false);
    el.style.overflowY = "visible";
    expect(isScrollableY(el)).toBe(false);
    el.style.overflowY = "scroll";
    stubScrollMetrics(el, { scrollHeight: 500, clientHeight: 500 });
    expect(isScrollableY(el)).toBe(false);
  });

  it("isScrollableX is independent of the vertical axis", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    stubScrollMetrics(el, {
      scrollHeight: 500,
      clientHeight: 500,
      scrollWidth: 3000,
      clientWidth: 800,
    });
    el.style.overflowX = "auto";
    el.style.overflowY = "hidden";
    expect(isScrollableX(el)).toBe(true);
    expect(isScrollableY(el)).toBe(false);
  });

  it("finds the nearest scrollable ancestor, not a farther one", () => {
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    stubScrollMetrics(outer, { scrollHeight: 3000, clientHeight: 500 });
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    stubScrollMetrics(inner, { scrollHeight: 2000, clientHeight: 500 });
    const leaf = document.createElement("span");
    inner.appendChild(leaf);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    expect(findScrollContainer(leaf, "vertical")).toBe(inner);
  });

  it("the walk is bounded by the modal: it never escapes to the page", () => {
    const page = document.createElement("div");
    page.style.overflowY = "auto";
    stubScrollMetrics(page, { scrollHeight: 3000, clientHeight: 500 });
    const modal = document.createElement("div");
    const leaf = document.createElement("span");
    modal.appendChild(leaf);
    page.appendChild(modal);
    document.body.appendChild(page);
    // Bounded walk: the scrollable page ancestor is out of reach.
    expect(findScrollContainer(leaf, "vertical", modal)).toBeNull();
    // Unbounded walk: the same chain finds the page.
    expect(findScrollContainer(leaf, "vertical")).toBe(page);
  });

  it("a pointer outside an open modal scrolls nothing (modal guard)", () => {
    const page = document.createElement("div");
    page.style.overflowY = "auto";
    stubScrollMetrics(page, { scrollHeight: 3000, clientHeight: 500 });
    const background = document.createElement("span");
    page.appendChild(background);
    const modal = document.createElement("dialog");
    document.body.appendChild(page);
    document.body.appendChild(modal);
    const targets = resolveScrollTargetsFromElement(background, modal);
    expect(targets.blockedByModal).toBe(true);
    expect(targets.vertical).toBeNull();
    expect(targets.horizontal).toBeNull();
  });

  it("a pointer inside a modal scrolls at most the modal itself", () => {
    const page = document.createElement("div");
    page.style.overflowY = "auto";
    stubScrollMetrics(page, { scrollHeight: 3000, clientHeight: 500 });
    const modal = document.createElement("div");
    modal.style.overflowY = "auto";
    stubScrollMetrics(modal, { scrollHeight: 1500, clientHeight: 400 });
    const leaf = document.createElement("span");
    modal.appendChild(leaf);
    page.appendChild(modal);
    document.body.appendChild(page);
    const targets = resolveScrollTargetsFromElement(leaf, modal);
    expect(targets.blockedByModal).toBe(false);
    expect(targets.vertical).toBe(modal);
  });

  it("falls back to the page container when nothing under the pointer scrolls", () => {
    const leaf = document.createElement("span");
    document.body.appendChild(leaf);
    const root = document.documentElement;
    stubScrollMetrics(root, { scrollHeight: 3000, clientHeight: 768 });
    const targets = resolveScrollTargetsFromElement(leaf, null);
    // documentElement IS the page scroller in Chromium
    // (document.scrollingElement); jsdom reports scrollingElement as
    // undefined, so the assertion names the element directly.
    expect(targets.vertical).toBe(document.documentElement);
  });

  it("the point-based resolver honours a real open dialog", () => {
    const page = document.createElement("div");
    page.style.overflowY = "auto";
    stubScrollMetrics(page, { scrollHeight: 3000, clientHeight: 500 });
    const background = document.createElement("span");
    page.appendChild(background);
    document.body.appendChild(page);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    makeModalVisible(dialog);
    document.body.appendChild(dialog);
    stubElementAt(background);
    const targets = resolveScrollTargets(10, 10);
    expect(targets.blockedByModal).toBe(true);
    expect(targets.vertical).toBeNull();
  });
});

// ── Scroll math + frame-driven scrolling ─────────────────────────────

describe("left-stick scrolling", () => {
  it("scroll speed eases quadratically and is capped", () => {
    expect(cursorScrollSpeed(0)).toBe(CURSOR_SCROLL_MIN_SPEED_PX_S);
    expect(cursorScrollSpeed(1)).toBe(CURSOR_SCROLL_MAX_SPEED_PX_S);
    expect(cursorScrollSpeed(0.5)).toBe(
      CURSOR_SCROLL_MIN_SPEED_PX_S +
        (CURSOR_SCROLL_MAX_SPEED_PX_S - CURSOR_SCROLL_MIN_SPEED_PX_S) * 0.25,
    );
    expect(cursorScrollSpeed(2)).toBe(CURSOR_SCROLL_MAX_SPEED_PX_S);
    expect(cursorScrollSpeed(-1)).toBe(CURSOR_SCROLL_MIN_SPEED_PX_S);
  });

  function scrollFixture(): { scroller: HTMLElement; leaf: HTMLElement } {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    scroller.style.overflowX = "auto";
    stubScrollMetrics(scroller, {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollWidth: 2000,
      clientWidth: 800,
    });
    const leaf = document.createElement("span");
    scroller.appendChild(leaf);
    document.body.appendChild(scroller);
    return { scroller, leaf };
  }

  it("a deflected native scroll stick scrolls the container down", () => {
    const { scroller, leaf } = scrollFixture();
    stubElementAt(leaf);
    setCursorModeActive(true);
    // XInput Y up-positive: -32767 is stick DOWN → scrollTop grows.
    noteNativeScrollStick(0, -32767, 1000);
    runFrames(10, 1000, 16);
    expect(scroller.scrollTop).toBeGreaterThan(20);
  });

  it("stick up scrolls back toward the top", () => {
    const { scroller, leaf } = scrollFixture();
    scroller.scrollTop = 400;
    stubElementAt(leaf);
    setCursorModeActive(true);
    noteNativeScrollStick(0, 32767, 1000);
    runFrames(10, 1000, 16);
    expect(scroller.scrollTop).toBeLessThan(400);
  });

  it("stick left/right scrolls horizontally when appropriate", () => {
    const { scroller, leaf } = scrollFixture();
    stubElementAt(leaf);
    setCursorModeActive(true);
    noteNativeScrollStick(32767, 0, 1000);
    runFrames(10, 1000, 16);
    expect(scroller.scrollLeft).toBeGreaterThan(20);
    expect(scroller.scrollTop).toBe(0);
  });

  it("a centred scroll stick settles the scroll (zero event)", () => {
    const { scroller, leaf } = scrollFixture();
    stubElementAt(leaf);
    setCursorModeActive(true);
    noteNativeScrollStick(0, -32767, 1000);
    runFrames(10, 1000, 16);
    const moving = scroller.scrollTop;
    noteNativeScrollStick(0, 0, 1200);
    runFrames(60, 1200, 16);
    const settled = scroller.scrollTop;
    expect(settled - moving).toBeLessThan(200);
    runFrames(30, 2200, 16);
    expect(scroller.scrollTop).toBe(settled);
  });

  it("scrolling stops on exit and the vector is cleared", () => {
    const { scroller, leaf } = scrollFixture();
    stubElementAt(leaf);
    setCursorModeActive(true);
    noteNativeScrollStick(0, -32767, 1000);
    runFrames(5, 1000, 16);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    setCursorModeActive(false);
    const atExit = scroller.scrollTop;
    setCursorModeActive(true);
    runFrames(10, 2000, 16);
    expect(scroller.scrollTop).toBe(atExit);
  });

  it("a modal blocks background scrolling in the frame loop", () => {
    const { scroller, leaf } = scrollFixture();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    makeModalVisible(dialog);
    document.body.appendChild(dialog);
    stubElementAt(leaf);
    setCursorModeActive(true);
    noteNativeScrollStick(0, -32767, 1000);
    runFrames(10, 1000, 16);
    expect(scroller.scrollTop).toBe(0);
    expect(isCursorScrollAvailable()).toBe(false);
  });

  it("scroll availability is reported for hints", () => {
    const { leaf } = scrollFixture();
    stubElementAt(leaf);
    expect(isCursorScrollAvailable()).toBe(false);
    setCursorModeActive(true);
    runFrames(2, 1000, 16);
    expect(isCursorScrollAvailable()).toBe(true);
    expect(document.documentElement.dataset.cursorScroll).toBe("available");
    const plain = document.createElement("span");
    document.body.appendChild(plain);
    stubElementAt(plain);
    runFrames(2, 1100, 16);
    // The plain span's ancestors include <body>/<html>; jsdom reports
    // no overflow there, so nothing is scrollable under it.
    expect(document.documentElement.dataset.cursorScroll).toBe("none");
    setCursorModeActive(false);
    expect(document.documentElement.dataset.cursorScroll).toBeUndefined();
  });

  it("fallback axes 0/1 scroll when native is silent", () => {
    const { scroller, leaf } = scrollFixture();
    const pad = { connected: true, axes: [0, 1, 0, 0], index: 0, id: "pad" };
    Object.defineProperty(navigator, "getGamepads", {
      value: () => [pad],
      configurable: true,
    });
    stubElementAt(leaf);
    setCursorModeActive(true);
    runFrames(10, 1000, 16);
    expect(scroller.scrollTop).toBeGreaterThan(20);
  });

  it("a recent native scroll vector suppresses the fallback axes", () => {
    const { scroller, leaf } = scrollFixture();
    const pad = { connected: true, axes: [0, 1, 0, 0], index: 0, id: "pad" };
    Object.defineProperty(navigator, "getGamepads", {
      value: () => [pad],
      configurable: true,
    });
    stubElementAt(leaf);
    setCursorModeActive(true);
    noteNativeScrollStick(0, 0, 1000);
    runFrames(10, 1000, 16);
    expect(scroller.scrollTop).toBe(0);
    // Past the 1500 ms silence window the fallback resumes.
    runFrames(10, 2600, 16);
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it("the scroll stick never moves the pointer, and vice versa", () => {
    const { leaf } = scrollFixture();
    stubElementAt(leaf);
    setCursorModeActive(true);
    const start = cursorPosition();
    noteNativeScrollStick(0, -32767, 1000);
    runFrames(10, 1000, 16);
    expect(cursorPosition()).toEqual(start);
    noteNativeScrollStick(0, 0, 1200);
    noteNativeStick(32767, 0, 1200);
    runFrames(10, 1200, 16);
    expect(cursorPosition().x).toBeGreaterThan(start.x);
  });
});

// ── No-dual-route contract (static pins) ─────────────────────────────

describe("no-dual-route stick contract", () => {
  const rust = readFileSync(resolve(repoRoot, "src-tauri/src/xinput.rs"), "utf8");
  const bridge = readFileSync(
    resolve(repoRoot, "src/scripts/lib/native-gamepad.ts"),
    "utf8",
  );
  const cursor = readFileSync(
    resolve(repoRoot, "src/scripts/lib/cursor-mode.ts"),
    "utf8",
  );

  it("Rust forwards left-stick axes as a bounded xinput-scroll event", () => {
    expect(rust).toContain('"xinput-scroll"');
    expect(rust).toContain("struct XInputScrollEvent");
    expect(rust).toContain("scroll_active");
    expect(rust).toContain("last_scroll_emit");
    expect(rust).toContain("s_thumb_lx");
    expect(rust).toContain("s_thumb_ly");
  });

  it("Rust tags every direction with its source", () => {
    expect(rust).toContain('source: &\'static str');
    expect(rust).toContain('("up", "dpad")');
    expect(rust).toContain('"stick"');
    expect(rust).toContain("direction_of");
  });

  it("the bridge drops stick directions while cursor mode is active", () => {
    expect(bridge).toContain('"xinput-scroll"');
    expect(bridge).toContain("noteNativeScrollStick");
    expect(bridge).toContain('source === "stick" && isCursorModeActive()');
  });

  it("the bridge cancels a held direction when cursor mode activates", () => {
    expect(bridge).toContain('"couch:cursor-mode"');
    expect(bridge).toContain("dispatchNativeDirection(null)");
    expect(bridge).toContain("setNativeDirectionActive(false)");
  });

  it("the fallback poll reads axes 0/1 for scroll in the same loop", () => {
    expect(cursor).toContain("pad.axes[0]");
    expect(cursor).toContain("pad.axes[1]");
    expect(cursor).toContain("scrollVector = { x: pad.axes[0]");
  });

  it("no second poller: one rAF loop, one Rust poll thread", () => {
    // The cursor module schedules exactly one rAF chain (frame
    // re-schedules itself); the scroll step runs inside it.
    expect(cursor).toContain("stepScroll(dtMs, underPointer)");
    expect(rust).toContain('name("xinput-poll"');
    expect(rust).not.toContain("xinput-scroll-poll");
  });
});

// ── Exit focus restore ───────────────────────────────────────────────

describe("exit focus restore (last interacted wins)", () => {
  it("restores focus to the element clicked during the session, not the pre-cursor one", () => {
    const before = document.createElement("button");
    before.textContent = "before";
    const other = document.createElement("button");
    other.textContent = "other";
    document.body.appendChild(before);
    document.body.appendChild(other);
    before.focus();
    setCursorModeActive(true);
    stubElementAt(other);
    dispatchCursorClick("left");
    expect(document.activeElement).toBe(other);
    setCursorModeActive(false);
    expect(document.activeElement).toBe(other);
  });

  it("a D-pad focus move during the session counts as interaction", () => {
    const before = document.createElement("button");
    const other = document.createElement("button");
    document.body.appendChild(before);
    document.body.appendChild(other);
    before.focus();
    setCursorModeActive(true);
    other.focus();
    setCursorModeActive(false);
    expect(document.activeElement).toBe(other);
  });

  it("with no interaction, the pre-cursor element is restored", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    setCursorModeActive(true);
    setCursorModeActive(false);
    expect(document.activeElement).toBe(before);
  });

  it("when the interacted element is gone, the nearest control wins — not the pre-cursor one", () => {
    const before = document.createElement("button");
    const clicked = document.createElement("button");
    const near = document.createElement("button");
    const far = document.createElement("button");
    document.body.appendChild(before);
    document.body.appendChild(clicked);
    document.body.appendChild(near);
    document.body.appendChild(far);
    // The pointer starts at the centre of the focused element: put
    // `before` at the origin, so the pointer starts at (20, 15) and
    // `near` sits on top of it. `before` is then re-stubbed far away
    // (a layout shift after activation) so it cannot win on
    // proximity — the point is that the gone interaction's nearest
    // neighbour wins, not the pre-cursor element.
    stubRect(before, { left: 0, top: 0, width: 40, height: 30 });
    stubRect(near, { left: 10, top: 5, width: 20, height: 20 });
    stubRect(far, { left: 900, top: 700, width: 40, height: 30 });
    before.focus();
    setCursorModeActive(true);
    stubRect(before, { left: 900, top: 0, width: 40, height: 30 });
    stubElementAt(clicked);
    dispatchCursorClick("left");
    clicked.remove();
    setCursorModeActive(false);
    expect(document.activeElement).toBe(near);
  });

  it("nearestFocusableToPoint picks the closest boxed control", () => {
    const a = document.createElement("button");
    const b = document.createElement("button");
    document.body.appendChild(a);
    document.body.appendChild(b);
    stubRect(a, { left: 100, top: 100, width: 50, height: 50 });
    stubRect(b, { left: 800, top: 600, width: 50, height: 50 });
    expect(nearestFocusableToPoint(120, 120)).toBe(a);
    expect(nearestFocusableToPoint(820, 620)).toBe(b);
  });

  it("an open modal keeps focus on exit (no steal back)", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const modalButton = document.createElement("button");
    dialog.appendChild(modalButton);
    document.body.appendChild(dialog);
    makeModalVisible(dialog);
    before.focus();
    modalButton.focus();
    setCursorModeActive(true);
    setCursorModeActive(false);
    expect(document.activeElement).toBe(modalButton);
  });
});

// ── Click default-behaviour emulation ────────────────────────────────

describe("cursor click control emulation", () => {
  it("toggles a checkbox exactly once and fires input + change", () => {
    // jsdom performs the native checkbox toggle on a dispatched
    // click (browsers do not); the emulation's before/after guard
    // must therefore NOT toggle a second time. Either engine ends
    // here: checked once, one input + one change.
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    const events: string[] = [];
    box.addEventListener("input", () => events.push("input"));
    box.addEventListener("change", () => events.push("change"));
    stubElementAt(box);
    setCursorModeActive(true);
    dispatchCursorClick("left");
    expect(box.checked).toBe(true);
    expect(events).toEqual(["input", "change"]);
    dispatchCursorClick("left");
    expect(box.checked).toBe(false);
  });

  it("a cancelled click does not toggle the checkbox", () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("click", (event) => event.preventDefault());
    document.body.appendChild(box);
    stubElementAt(box);
    setCursorModeActive(true);
    dispatchCursorClick("left");
    expect(box.checked).toBe(false);
  });

  it("checks a radio and unchecks its group", () => {
    const first = document.createElement("input");
    first.type = "radio";
    first.name = "group";
    first.checked = true;
    const second = document.createElement("input");
    second.type = "radio";
    second.name = "group";
    document.body.appendChild(first);
    document.body.appendChild(second);
    const changes: HTMLInputElement[] = [];
    for (const radio of [first, second]) {
      radio.addEventListener("change", () => changes.push(radio));
    }
    stubElementAt(second);
    setCursorModeActive(true);
    dispatchCursorClick("left");
    expect(second.checked).toBe(true);
    expect(first.checked).toBe(false);
    // jsdom performs the native radio toggle itself (firing change
    // on the newly checked radio); in a browser the emulation fires
    // change on both the unchecked and the checked radio. The
    // end-state is what both engines must agree on; the newly
    // checked radio's change event is asserted, the group's is
    // engine-dependent.
    expect(changes).toContain(second);
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });

  it("sets a range value from the pointer position", () => {
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.value = "0";
    document.body.appendChild(range);
    // Pointer at viewport centre (512, 384): rect centred on it.
    stubRect(range, { left: 412, top: 370, width: 200, height: 30 });
    const events: string[] = [];
    range.addEventListener("input", () => events.push("input"));
    range.addEventListener("change", () => events.push("change"));
    stubElementAt(range);
    setCursorModeActive(true);
    dispatchCursorClick("left");
    expect(range.value).toBe("50");
    expect(events).toEqual(["input", "change"]);
  });

  it("clicking a select focuses it without throwing", () => {
    const select = document.createElement("select");
    const option = document.createElement("option");
    option.textContent = "One";
    select.appendChild(option);
    document.body.appendChild(select);
    stubElementAt(select);
    setCursorModeActive(true);
    expect(() => dispatchCursorClick("left")).not.toThrow();
    expect(document.activeElement).toBe(select);
  });

  it("pointer events carry mouse-like pointer identity when PointerEvent exists", () => {
    if (typeof window.PointerEvent !== "function") return;
    const target = document.createElement("button");
    document.body.appendChild(target);
    const seen: PointerEvent[] = [];
    target.addEventListener("pointerdown", (event) =>
      seen.push(event as PointerEvent),
    );
    stubElementAt(target);
    setCursorModeActive(true);
    dispatchCursorClick("left");
    expect(seen).toHaveLength(1);
    expect(seen[0].pointerType).toBe("mouse");
    expect(seen[0].isPrimary).toBe(true);
  });
});

// ── Hover dispatch + pointer settle ──────────────────────────────────

describe("hover dispatch and pointer settle", () => {
  it("dispatches pointermove while moving and over/out on target change", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.appendChild(a);
    document.body.appendChild(b);
    const seenA: string[] = [];
    const seenB: string[] = [];
    for (const type of ["pointermove", "pointerover", "pointerout", "mouseover", "mouseout"]) {
      a.addEventListener(type, () => seenA.push(type));
      b.addEventListener(type, () => seenB.push(type));
    }
    stubElementAt(a);
    setCursorModeActive(true);
    noteNativeStick(32767, 0, 1000);
    runFrames(5, 1000, 16);
    expect(seenA).toContain("pointermove");
    stubbedTarget = b;
    runFrames(5, 1100, 16);
    expect(seenA).toContain("pointerout");
    expect(seenA).toContain("mouseout");
    expect(seenB).toContain("pointerover");
    expect(seenB).toContain("mouseover");
  });

  it("the pointer fully settles promptly after the stick centres", () => {
    setCursorModeActive(true);
    noteNativeStick(32767, 0, 1000);
    runFrames(10, 1000, 16);
    noteNativeStick(0, 0, 1200);
    runFrames(30, 1200, 16);
    const settled = cursorPosition();
    runFrames(10, 1700, 16);
    expect(cursorPosition().x).toBe(settled.x);
    expect(cursorPosition().y).toBe(settled.y);
  });
});
