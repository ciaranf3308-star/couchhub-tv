/**
 * @vitest-environment jsdom
 */
// 0.11.8 gamepad seam — the browse-active / home-active branches in
// handleGamepadButtonPress. Live TV, playback, modal, and global
// handling must be untouched: these tests pin the new routing AND
// the precedence (Live TV first, modal swallows, hidden mounts are
// inactive, Home keeps global Y/Menu behaviour).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dispatchNativeButton,
  handleGamepadButtonPress,
} from "@/scripts/lib/gamepad";

const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_Y = 3;
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_MENU = 9;

let keys: string[] = [];
// One listener for the whole file: registering per-test would stack
// listeners that all push into the current array.
window.addEventListener("keydown", (e) => keys.push(e.key));

function mountBrowseRoot(hidden = false): HTMLButtonElement {
  const mount = document.createElement("div");
  mount.id = "movies-browse-mount";
  if (hidden) mount.hidden = true;
  const root = document.createElement("div");
  root.setAttribute("data-browse-everything", "");
  root.setAttribute("data-browse-layer", "grid");
  const card = document.createElement("button");
  card.setAttribute("data-browse-key", "g1");
  card.textContent = "Card";
  root.appendChild(card);
  mount.appendChild(root);
  document.body.appendChild(mount);
  card.focus();
  return card;
}

function mountHomeRoot(id = "movies-home-root", hidden = false): HTMLButtonElement {
  const root = document.createElement("div");
  root.id = id;
  if (hidden) root.hidden = true;
  const rail = document.createElement("div");
  rail.setAttribute("data-nylah-rail", "movies-worth");
  const card = document.createElement("button");
  card.setAttribute("data-nylah-item", "");
  card.textContent = "Card";
  rail.appendChild(card);
  root.appendChild(rail);
  document.body.appendChild(root);
  card.focus();
  return card;
}

function openModal(): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  // findOpenModal requires a real box (getClientRects non-empty);
  // jsdom has no layout, so stub one — the pattern used by
  // modal-nav-trap.test.ts and couch-focus-seed-0111.test.ts.
  Object.defineProperty(dialog, "getClientRects", {
    value: () => [{ width: 100, height: 100 }],
  });
  const btn = document.createElement("button");
  btn.textContent = "OK";
  dialog.appendChild(btn);
  document.body.appendChild(dialog);
  // jsdom's dialog lacks showModal semantics; the open attribute is
  // what findOpenModal matches (dialog[open]).
  btn.focus();
  return dialog;
}

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-livetv-mode");
  window.history.replaceState(null, "", "/movies");
  keys = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browse-active routing (§16.2)", () => {
  it("routes X/Y/LB/RB/Menu to the browse controller's keys", () => {
    mountBrowseRoot();
    handleGamepadButtonPress(BTN_X, 0);
    handleGamepadButtonPress(BTN_Y, 0);
    handleGamepadButtonPress(BTN_LB, 0);
    handleGamepadButtonPress(BTN_RB, 0);
    handleGamepadButtonPress(BTN_MENU, 0);
    expect(keys).toEqual(["x", "y", "PageUp", "PageDown", "m"]);
  });

  it("routes the native XInput names onto the same keys", () => {
    mountBrowseRoot();
    dispatchNativeButton("x", true, 0);
    dispatchNativeButton("x", false, 0);
    dispatchNativeButton("y", true, 0);
    dispatchNativeButton("y", false, 0);
    dispatchNativeButton("lb", true, 0);
    dispatchNativeButton("lb", false, 0);
    dispatchNativeButton("rb", true, 0);
    dispatchNativeButton("rb", false, 0);
    dispatchNativeButton("menu", true, 0);
    dispatchNativeButton("menu", false, 0);
    expect(keys).toEqual(["x", "y", "PageUp", "PageDown", "m"]);
  });

  it("B still dispatches exactly one Escape (the controller pops layers, then exits)", () => {
    mountBrowseRoot();
    handleGamepadButtonPress(BTN_B, 0);
    expect(keys).toEqual(["Escape"]);
  });

  it("A still activates the focused card", () => {
    const card = mountBrowseRoot();
    const onClick = vi.fn();
    card.addEventListener("click", onClick);
    handleGamepadButtonPress(BTN_A, 0);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([]);
  });

  it("a hidden mount is inactive: LB/RB fall through to seek (no keys, no video)", () => {
    mountBrowseRoot(true);
    handleGamepadButtonPress(BTN_LB, 0);
    handleGamepadButtonPress(BTN_RB, 0);
    expect(keys).toEqual([]);
  });

  it("a hidden mount does not steal Y: the key is dispatched, global search still runs", () => {
    mountBrowseRoot(true);
    handleGamepadButtonPress(BTN_Y, 0);
    // 0.11.10: Y dispatches "y" first (page handlers may claim it);
    // with no handler consuming it, the global-search fallback runs.
    // No browse-layer handling: the hidden mount never sees the key
    // as its own (its controller is suspended while hidden).
    expect(keys).toEqual(["y"]);
  });
});

describe("home-active routing (§16.1)", () => {
  it("routes LB/RB to shelf-jump keys on Movies Home", () => {
    mountHomeRoot("movies-home-root");
    handleGamepadButtonPress(BTN_LB, 0);
    handleGamepadButtonPress(BTN_RB, 0);
    expect(keys).toEqual(["PageUp", "PageDown"]);
  });

  it("routes LB/RB to shelf-jump keys on Series Home", () => {
    mountHomeRoot("series-home-root");
    handleGamepadButtonPress(BTN_LB, 0);
    handleGamepadButtonPress(BTN_RB, 0);
    expect(keys).toEqual(["PageUp", "PageDown"]);
  });

  it("Menu on Home still opens Settings (D20: no page-options surface)", () => {
    mountHomeRoot();
    handleGamepadButtonPress(BTN_MENU, 0);
    // No browse key: Menu fell through to Settings.
    expect(keys).toEqual([]);
  });

  it("Y on Home dispatches 'y' first, then falls back to global search when unconsumed (D19 superseded by W2 scoped search)", () => {
    mountHomeRoot();
    handleGamepadButtonPress(BTN_Y, 0);
    // 0.11.10: the "y" key reaches Home handlers (scoped search
    // claims it when present); with no handler registered, the
    // global-search fallback runs as before.
    expect(keys).toEqual(["y"]);
  });

  it("a hidden home root is inactive", () => {
    mountHomeRoot("movies-home-root", true);
    handleGamepadButtonPress(BTN_LB, 0);
    handleGamepadButtonPress(BTN_RB, 0);
    expect(keys).toEqual([]);
  });

  it("browse wins over home when both roots are visible", () => {
    mountHomeRoot();
    mountBrowseRoot();
    handleGamepadButtonPress(BTN_Y, 0);
    handleGamepadButtonPress(BTN_MENU, 0);
    expect(keys).toEqual(["y", "m"]);
  });
});

describe("precedence: Live TV, modal, detail pages", () => {
  it("Live TV wins over a browse root: Guide swallows X, Browser owns LB/RB", () => {
    mountBrowseRoot();
    document.documentElement.dataset.livetvMode = "guide";
    handleGamepadButtonPress(BTN_X, 0);
    expect(keys).toEqual([]);
    document.documentElement.dataset.livetvMode = "browser";
    handleGamepadButtonPress(BTN_LB, 0);
    handleGamepadButtonPress(BTN_RB, 0);
    expect(keys).toEqual(["[", "]"]);
  });

  it("an open modal swallows X/Y/Menu/LB/RB over Browse", () => {
    mountBrowseRoot();
    openModal();
    handleGamepadButtonPress(BTN_X, 0);
    handleGamepadButtonPress(BTN_Y, 0);
    handleGamepadButtonPress(BTN_MENU, 0);
    handleGamepadButtonPress(BTN_LB, 0);
    handleGamepadButtonPress(BTN_RB, 0);
    expect(keys).toEqual([]);
  });

  it("a detail page (no browse/home roots): LB/RB seek, Y dispatches then falls back to global search", () => {
    window.history.replaceState(null, "", "/movies/detail?id=1");
    const btn = document.createElement("button");
    btn.textContent = "Play";
    document.body.appendChild(btn);
    btn.focus();
    handleGamepadButtonPress(BTN_LB, 0);
    handleGamepadButtonPress(BTN_RB, 0);
    expect(keys).toEqual([]);
    handleGamepadButtonPress(BTN_Y, 0);
    // 0.11.10: Y dispatches "y" so detail handlers (scoped search)
    // can claim it; unconsumed, it falls through to global search.
    expect(keys).toEqual(["y"]);
  });

  it("in a text field, browse keys are swallowed and only B backs out", () => {
    mountBrowseRoot();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    handleGamepadButtonPress(BTN_Y, 0);
    handleGamepadButtonPress(BTN_LB, 0);
    expect(keys).toEqual([]);
    handleGamepadButtonPress(BTN_B, 0);
    expect(keys).toEqual(["Escape"]);
  });
});
