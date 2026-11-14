/**
 * @vitest-environment jsdom
 */
// 0.11.14 W1b (§7.3/§7.15) — A on a focused input must not be silently
// swallowed: it enters editing through the shared keyboard lifecycle
// (couch-keyboard.ts, Contract E). These tests pin the routing AND
// the preserved behaviour: B dismisses editing first without
// clearing anything, X/Y/Menu stay swallowed in a field, non-input
// controls activate exactly as before, and one A press activates
// exactly once. The browser-fallback pollLoop half lives in
// tests/gamepad-ainput-poll-0114.test.ts (a separate file, so the
// native-liveness window dispatchNativeButton opens can never stand
// the fallback loop down mid-file).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dispatchNativeButton,
  dispatchNativeDirection,
  handleGamepadButtonPress,
} from "@/scripts/lib/gamepad";
import {
  closeCouchKeyboard,
  endCouchKeyboardSession,
  getCouchKeyboardInput,
  isCouchKeyboardOpen,
  openCouchKeyboard,
} from "@/scripts/lib/couch-keyboard";
import { setCursorModeActive } from "@/scripts/lib/cursor-mode";

const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_Y = 3;
const BTN_LB = 4;
const BTN_MENU = 9;

let keys: string[] = [];
window.addEventListener("keydown", (e) => {
  keys.push(e.key);
});

/** Minimal mounted OSK: the TvKeyboard/OnScreenKeyboard shape gamepad.ts queries. */
function mountOsk(): { firstKey: HTMLElement; secondKey: HTMLElement } {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div data-couch-keyboard><div data-osk>
      <button type="button" data-osk-key="1" id="osk-1">1</button>
      <button type="button" data-osk-key="2" id="osk-2">2</button>
    </div></div>`,
  );
  return {
    firstKey: document.getElementById("osk-1") as HTMLElement,
    secondKey: document.getElementById("osk-2") as HTMLElement,
  };
}

function mountInput(
  type = "search",
  value = "",
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = type;
  input.id = "search-input";
  input.value = value;
  document.body.appendChild(input);
  return input;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-livetv-mode");
  document.documentElement.removeAttribute("data-cursor-mode");
  localStorage.clear();
  keys = [];
  endCouchKeyboardSession();
});

afterEach(() => {
  dispatchNativeDirection(null);
  dispatchNativeButton("a", false);
  endCouchKeyboardSession();
  try {
    setCursorModeActive(false);
  } catch {
    // Cursor mode was never activated.
  }
  localStorage.clear();
});

describe("A on a text field with a live session (§7.3/§7.15)", () => {
  it("moves focus into the already-mounted key grid, dispatching no key", () => {
    const input = mountInput();
    const { firstKey } = mountOsk();
    // The Discover/Search state: the view opened the session on focus
    // (focusGrid:false — focus stays in the input for typing).
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();
    expect(document.activeElement).toBe(input);

    handleGamepadButtonPress(BTN_A, 0);

    expect(document.activeElement).toBe(firstKey);
    expect(keys).toEqual([]);
    expect(isCouchKeyboardOpen()).toBe(true);
    expect(getCouchKeyboardInput()).toBe(input);
  });

  it("does not clobber the view's commit callback (no openCouchKeyboard re-entry)", () => {
    const input = mountInput("search", "dune");
    mountOsk();
    const onCommit = vi.fn();
    openCouchKeyboard(input, onCommit, { focusGrid: false });
    input.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(onCommit).not.toHaveBeenCalled();
    closeCouchKeyboard(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("dune");
  });

  it("activates exactly once: retries never re-fire focus into the grid", async () => {
    const input = mountInput();
    const { firstKey } = mountOsk();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();
    let focusIns = 0;
    firstKey.addEventListener("focusin", () => {
      focusIns += 1;
    });

    handleGamepadButtonPress(BTN_A, 0);
    // Longer than the rAF + 80 ms retry schedule: every retry must
    // observe focus already in the grid and stand down.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(focusIns).toBe(1);
    expect(document.activeElement).toBe(firstKey);
  });

  it("works from the native XInput path (dispatchNativeButton)", () => {
    const input = mountInput();
    const { firstKey } = mountOsk();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();

    dispatchNativeButton("a", true);

    expect(document.activeElement).toBe(firstKey);
    expect(keys).toEqual([]);
  });

  it("works for a textarea with a live session", () => {
    const area = document.createElement("textarea");
    area.id = "notes";
    document.body.appendChild(area);
    const { firstKey } = mountOsk();
    openCouchKeyboard(area, undefined, { focusGrid: false });
    area.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(document.activeElement).toBe(firstKey);
  });
});

describe("A on a text field without a session", () => {
  it("opens the lifecycle when a keyboard surface is mounted", () => {
    const input = mountInput();
    const { firstKey } = mountOsk();
    input.focus();
    expect(isCouchKeyboardOpen()).toBe(false);

    handleGamepadButtonPress(BTN_A, 0);

    expect(isCouchKeyboardOpen()).toBe(true);
    expect(getCouchKeyboardInput()).toBe(input);
    expect(document.activeElement).toBe(firstKey);
  });

  it("is a no-op for a plain field with no keyboard surface (no invented session)", () => {
    const input = mountInput("text", "playlist name");
    input.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(isCouchKeyboardOpen()).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(keys).toEqual([]);
  });
});

describe("B dismisses editing first (§7.3/§7.15, unchanged)", () => {
  it("B closes the keyboard session, keeps the query, and returns focus to the input", () => {
    const input = mountInput("search", "dark thriller");
    mountOsk();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();

    handleGamepadButtonPress(BTN_B, 0);

    expect(isCouchKeyboardOpen()).toBe(false);
    expect(input.value).toBe("dark thriller");
    // closeCouchKeyboard returns focus to the input (the lifecycle's
    // focus-return contract); the query and conversation are intact.
    expect(document.activeElement).toBe(input);
    // The keyboard Back layer consumed the press: no bridge Escape
    // reached the page.
    expect(keys).toEqual([]);
  });

  it("A re-enters editing after B dismissed it (mounted-grid round trip)", () => {
    const input = mountInput();
    const { firstKey } = mountOsk();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();
    handleGamepadButtonPress(BTN_B, 0);
    expect(isCouchKeyboardOpen()).toBe(false);
    input.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(isCouchKeyboardOpen()).toBe(true);
    expect(document.activeElement).toBe(firstKey);
  });
});

describe("the rest of the editing gate is unchanged", () => {
  it("X/Y/Menu/LB in a text field are still swallowed", () => {
    const input = mountInput();
    mountOsk();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    input.focus();

    handleGamepadButtonPress(BTN_X, 0);
    handleGamepadButtonPress(BTN_Y, 0);
    handleGamepadButtonPress(BTN_MENU, 0);
    handleGamepadButtonPress(BTN_LB, 0);

    expect(keys).toEqual([]);
    expect(document.activeElement).toBe(input);
    expect(isCouchKeyboardOpen()).toBe(true);
  });

  it("Cursor Mode still owns A in a field (pointer click, never editing)", () => {
    const input = mountInput();
    mountOsk();
    input.focus();
    localStorage.setItem("xt_cursor_mode", "1");
    setCursorModeActive(true);

    handleGamepadButtonPress(BTN_A, 0);

    expect(document.activeElement).toBe(input);
    expect(isCouchKeyboardOpen()).toBe(false);
    expect(keys).toEqual([]);
  });

  it("a modal still owns A: focus outside it is pulled in, no editing starts", () => {
    const input = mountInput();
    mountOsk();
    openCouchKeyboard(input, undefined, { focusGrid: false });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<dialog id="dlg" open><button id="dlg-ok">OK</button></dialog>`,
    );
    const dlg = document.getElementById("dlg") as HTMLDialogElement;
    const ok = document.getElementById("dlg-ok") as HTMLElement;
    const rects = [{ width: 100, height: 100 }] as unknown as DOMRectList;
    (dlg as unknown as { getClientRects: () => DOMRectList }).getClientRects =
      () => rects;
    (ok as unknown as { getClientRects: () => DOMRectList }).getClientRects =
      () => rects;
    input.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(document.activeElement).toBe(ok);
  });
});

describe("A on non-text controls is unchanged", () => {
  it("clicks a focused button, dispatching no key", () => {
    const button = document.createElement("button");
    button.id = "play";
    document.body.appendChild(button);
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    button.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([]);
  });

  it("dispatches Enter for a generic focused element", () => {
    const card = document.createElement("div");
    card.tabIndex = 0;
    document.body.appendChild(card);
    card.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(keys).toEqual(["Enter"]);
  });

  it("toggles a focused checkbox instead of opening a keyboard", () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    box.focus();
    expect(box.checked).toBe(false);

    handleGamepadButtonPress(BTN_A, 0);

    expect(box.checked).toBe(true);
    expect(isCouchKeyboardOpen()).toBe(false);
  });
});

describe("A on a select opens the picker", () => {
  it("calls showPicker when available, exactly once", () => {
    const select = document.createElement("select");
    select.innerHTML = "<option>One</option><option>Two</option>";
    document.body.appendChild(select);
    const showPicker = vi.fn();
    Object.defineProperty(select, "showPicker", {
      value: showPicker,
      configurable: true,
    });
    select.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(showPicker).toHaveBeenCalledTimes(1);
    expect(isCouchKeyboardOpen()).toBe(false);
  });

  it("falls back to click() where showPicker is unavailable", () => {
    const select = document.createElement("select");
    select.innerHTML = "<option>One</option><option>Two</option>";
    document.body.appendChild(select);
    const onClick = vi.fn();
    select.addEventListener("click", onClick);
    select.focus();

    handleGamepadButtonPress(BTN_A, 0);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
