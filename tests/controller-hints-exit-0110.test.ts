/**
 * @vitest-environment jsdom
 */
// Controller Experience 2.0 (0.11.10, W1) — hints single source of
// truth (Contract C, §42) and top-nav Exit two-press safety (§5).

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  GENERIC_HINTS,
  HINT_CONFIGS,
  getControllerHints,
  glyphsOf,
  hintsForView,
  setControllerHints,
  type HintConfig,
} from "@/scripts/lib/couch-button-hints";
import { resolveBack } from "@/scripts/lib/back-handler";
import { mountCouchExitButton } from "@/scripts/lib/couch-nav";

describe("controller hints override (Contract C)", () => {
  afterEach(() => {
    setControllerHints(null);
  });

  it("defaults to no override (view-derived config applies)", () => {
    expect(getControllerHints()).toBeNull();
  });

  it("set/get round-trip, and null releases the legend", () => {
    const config: HintConfig = {
      id: "drawer-filters",
      items: [
        { glyph: "a", label: "Apply" },
        { glyph: "b", label: "Close" },
      ],
    };
    setControllerHints(config);
    expect(getControllerHints()).toBe(config);
    setControllerHints(null);
    expect(getControllerHints()).toBeNull();
  });

  it("fires a change event so the legend re-renders", () => {
    const onChange = vi.fn();
    window.addEventListener("couchhints:change", onChange);
    try {
      setControllerHints(GENERIC_HINTS);
      expect(onChange).toHaveBeenCalledTimes(1);
      setControllerHints(null);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("couchhints:change", onChange);
    }
  });

  it("the deprecated livetv-home key is the SAME object as livetv-landing (one source, no drift)", () => {
    expect(HINT_CONFIGS["livetv-home"]).toBe(HINT_CONFIGS["livetv-landing"]);
    expect(HINT_CONFIGS["livetv-home"].id).toBe("livetv-landing");
    expect(glyphsOf(HINT_CONFIGS["livetv-home"])).toEqual(
      glyphsOf(HINT_CONFIGS["livetv-landing"]),
    );
  });

  it("hintsForView behaviour is unchanged by the override API", () => {
    expect(hintsForView("home").id).toBe("home");
    expect(hintsForView("search").id).toBe("search");
    expect(hintsForView("nope").id).toBe("generic");
    expect(hintsForView("livetv", { livetvMode: "guide" }).id).toBe(
      "livetv-guide",
    );
    expect(hintsForView("home", { editing: true }).id).toBe("editing");
  });
});

describe("top-nav Exit two-press safety (§5)", () => {
  let btn: HTMLButtonElement;
  let requestExit: Mock<() => Promise<void>>;
  let unmount: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<button type="button" id="couch-exit-btn">⏻ Exit</button>`;
    btn = document.getElementById("couch-exit-btn") as HTMLButtonElement;
    requestExit = vi.fn(async () => {});
    unmount = mountCouchExitButton(btn, requestExit);
  });

  afterEach(() => {
    unmount();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("one press arms, never exits", async () => {
    btn.click();
    expect(btn.textContent).toBe("Exit?");
    expect(btn.classList.contains("is-armed")).toBe(true);
    expect(requestExit).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(requestExit).not.toHaveBeenCalled();
  });

  it("two presses confirm: exit requested, button disables then re-enables", async () => {
    btn.click();
    btn.click();
    expect(requestExit).toHaveBeenCalledTimes(1);
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.textContent).toBe("Exiting…");
    // Flush the promise chain (then/catch/finally): the exit promise
    // resolved, so the web-preview path re-enables the button.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(btn.hasAttribute("disabled")).toBe(false);
    expect(btn.textContent).toBe("⏻ Exit");
  });

  it("B while armed cancels the armed state without leaving or exiting", () => {
    btn.click();
    expect(btn.classList.contains("is-armed")).toBe(true);
    expect(resolveBack()).toBe(true);
    expect(btn.classList.contains("is-armed")).toBe(false);
    expect(btn.textContent).toBe("⏻ Exit");
    expect(requestExit).not.toHaveBeenCalled();
    // The disarm consumed exactly one Back: a second Back finds the
    // layer inert and falls through (no exit, no re-arm).
    expect(resolveBack()).toBe(false);
    expect(requestExit).not.toHaveBeenCalled();
  });

  it("the arm lapses after the timeout", () => {
    btn.click();
    expect(btn.classList.contains("is-armed")).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(btn.classList.contains("is-armed")).toBe(false);
    expect(btn.textContent).toBe("⏻ Exit");
    expect(requestExit).not.toHaveBeenCalled();
  });

  it("a stray press after lapse starts a fresh arm, never a confirm", () => {
    btn.click();
    vi.advanceTimersByTime(4000);
    btn.click();
    expect(btn.textContent).toBe("Exit?");
    expect(requestExit).not.toHaveBeenCalled();
  });

  it("clicks while disabled are ignored", async () => {
    btn.click();
    btn.click();
    expect(requestExit).toHaveBeenCalledTimes(1);
    btn.click();
    btn.click();
    expect(requestExit).toHaveBeenCalledTimes(1);
  });

  it("mounting twice does not double-arm or double-exit", () => {
    const second = mountCouchExitButton(btn, requestExit);
    btn.click();
    btn.click();
    expect(requestExit).toHaveBeenCalledTimes(1);
    second();
  });

  it("null button mounts to a no-op", () => {
    const noop = mountCouchExitButton(null, requestExit);
    expect(() => noop()).not.toThrow();
  });
});
