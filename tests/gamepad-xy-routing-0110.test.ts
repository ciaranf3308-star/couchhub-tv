/**
 * @vitest-environment jsdom
 */
// Controller Experience 2.0 (0.11.10, W1) — X/Y routing extension.
//
// W2's hand-back: gamepad.ts dispatched "x"/"y" keys ONLY in Browse /
// Live TV contexts, so controller X/Y on Home and detail pages never
// reached W2's new X-menu / Y-search handlers (keyboard X/Y work).
// The generic branches now dispatch the key FIRST and run their legacy
// fallback (details / global search) only when no handler consumes
// the keydown (preventDefault — the convention every x/y handler in
// the tree follows, W2's included). The player branches stay key-less:
// the player's own key handlers would double-toggle if the gamepad
// dispatched the key AND toggled directly.
//
// These tests pin the new routing AND the preserved mappings: Browse
// X/Y, Guide X swallow, modal swallow, editing gate, player
// play/pause + fullscreen without a dispatched key.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dispatchNativeButton,
  handleGamepadButtonPress,
} from "@/scripts/lib/gamepad";

const BTN_X = 2;
const BTN_Y = 3;

let keys: string[] = [];
let keyups: string[] = [];
let keyCodes: number[] = [];
// One listener for the whole file: registering per-test would stack
// listeners that all push into the current arrays. Note a consuming
// page handler (document-level, stopPropagation) keeps the keydown
// from reaching this window listener — the key WAS dispatched, the
// handler just claimed it; those tests assert on the handler + the
// suppressed fallback instead of this array.
window.addEventListener("keydown", (e) => {
  keys.push(e.key);
  keyCodes.push(e.keyCode);
});
window.addEventListener("keyup", (e) => keyups.push(e.key));

// jsdom cannot navigate, and its location.assign is an own,
// non-writable, non-configurable property (the back-coordinator tests
// hit the same wall and used the route-origin seam instead). But
// window.location itself IS a configurable accessor here, so these
// tests replace it with a fake Location carrying an assign spy — the
// only way to observe the legacy fallbacks (openDetailsOfFocused /
// goSearch), which call window.location.assign directly. The fake
// exposes exactly the fields gamepad.ts reads (href / pathname /
// search / assign); the real location is restored after every test.
const realLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
)!;
let assignSpy: ReturnType<typeof vi.fn>;

function setTestLocation(path: string): void {
  const url = new URL(path, "http://localhost/");
  assignSpy = vi.fn();
  Object.defineProperty(window, "location", {
    value: {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      origin: url.origin,
      host: url.host,
      protocol: url.protocol,
      assign: assignSpy,
      toString: () => url.href,
    },
    configurable: true,
    writable: true,
  });
}

function restoreLocation(): void {
  Object.defineProperty(window, "location", realLocationDescriptor);
}

const docHandlers: Array<(e: KeyboardEvent) => void> = [];

/** A W2-style page handler: bubble-phase, preventDefault + stopPropagation only when it acts. */
function addPageHandler(
  key: "x" | "y",
  opts: { consume: boolean; onAct?: () => void } = { consume: true },
): ReturnType<typeof vi.fn> {
  const acted = vi.fn();
  const handler = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.repeat) return;
    if (event.key !== key && event.key !== key.toUpperCase()) return;
    if (!opts.consume) return;
    event.preventDefault();
    event.stopPropagation();
    acted();
    opts.onAct?.();
  };
  docHandlers.push(handler);
  document.addEventListener("keydown", handler);
  return acted;
}

function focusButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = "Play";
  document.body.appendChild(btn);
  btn.focus();
  return btn;
}

function focusCardLink(href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = "Card";
  document.body.appendChild(link);
  link.focus();
  return link;
}

function mountBrowseRoot(): HTMLButtonElement {
  const root = document.createElement("div");
  root.setAttribute("data-browse-everything", "");
  const card = document.createElement("button");
  card.textContent = "Card";
  root.appendChild(card);
  document.body.appendChild(root);
  card.focus();
  return card;
}

function openModal(): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  // findOpenModal requires a real box (getClientRects non-empty);
  // jsdom has no layout, so stub one — the 0118 pattern.
  Object.defineProperty(dialog, "getClientRects", {
    value: () => [{ width: 100, height: 100 }],
  });
  const btn = document.createElement("button");
  btn.textContent = "OK";
  dialog.appendChild(btn);
  document.body.appendChild(dialog);
  btn.focus();
  return dialog;
}

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-livetv-mode");
  window.history.replaceState(null, "", "/movies");
  keys = [];
  keyups = [];
  keyCodes = [];
  setTestLocation("/movies");
});

afterEach(() => {
  for (const handler of docHandlers.splice(0)) {
    document.removeEventListener("keydown", handler);
  }
  restoreLocation();
  const el = document.documentElement as unknown as Record<string, unknown>;
  if ("requestFullscreen" in document.documentElement && el.requestFullscreen !== undefined) {
    delete el.requestFullscreen;
  }
  vi.restoreAllMocks();
});

describe("X routing — dispatch first, fallback only when unconsumed", () => {
  it("X on a generic page dispatches the 'x' key (keydown + keyup, real keyCode)", () => {
    focusButton();
    handleGamepadButtonPress(BTN_X, 0);
    expect(keys).toEqual(["x"]);
    expect(keyups).toEqual(["x"]);
    expect(keyCodes).toEqual([88]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("X falls back to the focused card's detail without autoplay when no handler consumes", () => {
    focusCardLink("/movies/detail?id=7&autoplay=1");
    handleGamepadButtonPress(BTN_X, 0);
    expect(keys).toEqual(["x"]);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/movies/detail?id=7");
  });

  it("X consumed by a page handler (W2-style X-menu) suppresses the details fallback", () => {
    focusCardLink("/movies/detail?id=7&autoplay=1");
    const acted = addPageHandler("x", { consume: true });
    handleGamepadButtonPress(BTN_X, 0);
    expect(acted).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
    // The keyup still fires (a real key always comes back up).
    expect(keyups).toEqual(["x"]);
  });

  it("X declined by a page handler (no card, no preventDefault) still falls back", () => {
    focusCardLink("/movies/detail?id=7&autoplay=1");
    addPageHandler("x", { consume: false });
    handleGamepadButtonPress(BTN_X, 0);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/movies/detail?id=7");
  });

  it("X on a detail page reaches the detail handler", () => {
    setTestLocation("/movies/detail?id=7");
    focusButton();
    const acted = addPageHandler("x", { consume: true });
    handleGamepadButtonPress(BTN_X, 0);
    expect(acted).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("X via native XInput reaches the same dispatch-first path", () => {
    focusCardLink("/movies/detail?id=7&autoplay=1");
    const acted = addPageHandler("x", { consume: true });
    dispatchNativeButton("x", true, 0);
    dispatchNativeButton("x", false, 0);
    expect(acted).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
  });
});

describe("Y routing — dispatch first, fallback only when unconsumed", () => {
  it("Y on a generic page dispatches the 'y' key, then falls back to global search", () => {
    focusButton();
    handleGamepadButtonPress(BTN_Y, 0);
    expect(keys).toEqual(["y"]);
    expect(keyups).toEqual(["y"]);
    expect(keyCodes).toEqual([89]);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/search");
  });

  it("Y consumed by a scoped-search handler (W2-style) suppresses global search", () => {
    focusButton();
    const acted = addPageHandler("y", { consume: true });
    handleGamepadButtonPress(BTN_Y, 0);
    expect(acted).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
    expect(keyups).toEqual(["y"]);
  });

  it("Y declined by a page handler still falls back to global search", () => {
    focusButton();
    addPageHandler("y", { consume: false });
    handleGamepadButtonPress(BTN_Y, 0);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/search");
  });

  it("Y on the search page dispatches the key and does not re-navigate", () => {
    setTestLocation("/search");
    focusButton();
    handleGamepadButtonPress(BTN_Y, 0);
    expect(keys).toEqual(["y"]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("Y via native XInput reaches the same dispatch-first path", () => {
    focusButton();
    const acted = addPageHandler("y", { consume: true });
    dispatchNativeButton("y", true, 0);
    dispatchNativeButton("y", false, 0);
    expect(acted).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
  });
});

describe("X/Y preserved mappings", () => {
  it("X in Browse still dispatches 'x' with no fallback navigation", () => {
    mountBrowseRoot();
    handleGamepadButtonPress(BTN_X, 0);
    expect(keys).toEqual(["x"]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("Y in Browse still dispatches 'y' with no fallback navigation", () => {
    mountBrowseRoot();
    handleGamepadButtonPress(BTN_Y, 0);
    expect(keys).toEqual(["y"]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("X in the Guide is still swallowed", () => {
    focusButton();
    document.documentElement.dataset.livetvMode = "guide";
    handleGamepadButtonPress(BTN_X, 0);
    expect(keys).toEqual([]);
    expect(keyups).toEqual([]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("X/Y with a modal open are swallowed", () => {
    openModal();
    handleGamepadButtonPress(BTN_X, 0);
    handleGamepadButtonPress(BTN_Y, 0);
    expect(keys).toEqual([]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("X/Y in a text field are swallowed (editing gate unchanged)", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    handleGamepadButtonPress(BTN_X, 0);
    handleGamepadButtonPress(BTN_Y, 0);
    expect(keys).toEqual([]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("X in the player toggles play and dispatches NO key (no double-toggle)", () => {
    const video = document.createElement("video");
    video.id = "tv-player-video";
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    video.play = play as unknown as typeof video.play;
    video.pause = pause;
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    document.body.appendChild(video);
    focusButton();
    // The player's own "x" handler (couch-player.ts style): if the
    // gamepad dispatched the key AND toggled, play would fire twice.
    const playerHandler = addPageHandler("x", { consume: true });
    handleGamepadButtonPress(BTN_X, 0);
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    expect(playerHandler).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("Y in the player toggles fullscreen and dispatches NO key (no double-toggle)", () => {
    const video = document.createElement("video");
    video.id = "tv-player-video";
    document.body.appendChild(video);
    focusButton();
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: requestFullscreen,
      configurable: true,
    });
    const playerHandler = addPageHandler("y", { consume: true });
    handleGamepadButtonPress(BTN_Y, 0);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(playerHandler).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("X in Live TV playback still dispatches 'x' (Guide) with no fallback", () => {
    focusButton();
    document.documentElement.dataset.livetvMode = "playback";
    handleGamepadButtonPress(BTN_X, 0);
    expect(keys).toEqual(["x"]);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("Y in Live TV playback still dispatches 'y' (channel browser) with no fallback", () => {
    focusButton();
    document.documentElement.dataset.livetvMode = "playback";
    handleGamepadButtonPress(BTN_Y, 0);
    expect(keys).toEqual(["y"]);
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
