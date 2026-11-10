import { describe, it, expect } from "vitest";
import {
  LIVETV_CONTROLLER_MAP,
  LIVETV_GAMEPAD_BUTTONS,
  LIVETV_RETURN_HOME_HOLD_MS,
  livetvGamepadActionForButton,
  livetvKeyActionForKey,
  livetvReturnHomeComboPressed,
  livetvStickAction,
} from "@/scripts/lib/livetv-keys";

describe("keyboard mapping — Home browsing", () => {
  it("arrows move, Enter selects, Esc goes back", () => {
    expect(livetvKeyActionForKey("home", "ArrowUp")).toBe("move-up");
    expect(livetvKeyActionForKey("home", "ArrowDown")).toBe("move-down");
    expect(livetvKeyActionForKey("home", "ArrowLeft")).toBe("move-left");
    expect(livetvKeyActionForKey("home", "ArrowRight")).toBe("move-right");
    expect(livetvKeyActionForKey("home", "Enter")).toBe("select");
    expect(livetvKeyActionForKey("home", " ")).toBe("select");
    expect(livetvKeyActionForKey("home", "Escape")).toBe("back");
  });

  it("Y opens the Guide, X is contextual, Menu opens options", () => {
    expect(livetvKeyActionForKey("home", "y")).toBe("open-guide");
    expect(livetvKeyActionForKey("home", "Y")).toBe("open-guide");
    expect(livetvKeyActionForKey("home", "x")).toBe("contextual");
    expect(livetvKeyActionForKey("home", "ContextMenu")).toBe("open-options");
  });

  it("unknown keys resolve to nothing", () => {
    expect(livetvKeyActionForKey("home", "q")).toBeNull();
    expect(livetvKeyActionForKey("home", "F5")).toBeNull();
    expect(livetvKeyActionForKey("home", null)).toBeNull();
  });
});

describe("keyboard mapping — fullscreen playback", () => {
  it("A reveals/confirms, B closes, Up/Down Quick Surf, Left/Right programme info", () => {
    expect(livetvKeyActionForKey("playback", "Enter")).toBe("activate");
    expect(livetvKeyActionForKey("playback", "Escape")).toBe("back");
    expect(livetvKeyActionForKey("playback", "ArrowUp")).toBe("quick-surf-up");
    expect(livetvKeyActionForKey("playback", "ArrowDown")).toBe("quick-surf-down");
    expect(livetvKeyActionForKey("playback", "ArrowLeft")).toBe("programme-info");
    expect(livetvKeyActionForKey("playback", "ArrowRight")).toBe("programme-info");
  });

  it("X opens the full Guide, Y opens the Channel Browser, Menu opens options", () => {
    expect(livetvKeyActionForKey("playback", "x")).toBe("open-guide");
    expect(livetvKeyActionForKey("playback", "y")).toBe("open-browser");
    expect(livetvKeyActionForKey("playback", "ContextMenu")).toBe("open-options");
  });
});

describe("keyboard mapping — Guide", () => {
  it("arrows move spatially, Enter selects, Esc returns", () => {
    expect(livetvKeyActionForKey("guide", "ArrowUp")).toBe("move-up");
    expect(livetvKeyActionForKey("guide", "ArrowDown")).toBe("move-down");
    expect(livetvKeyActionForKey("guide", "ArrowLeft")).toBe("move-left");
    expect(livetvKeyActionForKey("guide", "ArrowRight")).toBe("move-right");
    expect(livetvKeyActionForKey("guide", "Enter")).toBe("select");
    expect(livetvKeyActionForKey("guide", "Escape")).toBe("back");
  });

  it("Page Up/Down shift time, N jumps to now, Menu/Y open guide actions", () => {
    expect(livetvKeyActionForKey("guide", "PageUp")).toBe("time-prev");
    expect(livetvKeyActionForKey("guide", "PageDown")).toBe("time-next");
    expect(livetvKeyActionForKey("guide", "n")).toBe("jump-to-now");
    expect(livetvKeyActionForKey("guide", "N")).toBe("jump-to-now");
    expect(livetvKeyActionForKey("guide", "ContextMenu")).toBe("guide-actions");
    expect(livetvKeyActionForKey("guide", "y")).toBe("guide-actions");
  });

  it("X is unmapped in the Guide (it means Full Guide only in playback)", () => {
    expect(livetvKeyActionForKey("guide", "x")).toBeNull();
  });
});

describe("gamepad mapping", () => {
  const { a, b, x, y, lb, rb, view, menu, dpadUp, dpadDown, dpadLeft, dpadRight } =
    LIVETV_GAMEPAD_BUTTONS;

  it("Home: D-pad moves, A selects, B backs, X contextual, Y Guide, Menu options", () => {
    expect(livetvGamepadActionForButton("home", dpadUp)).toBe("move-up");
    expect(livetvGamepadActionForButton("home", dpadDown)).toBe("move-down");
    expect(livetvGamepadActionForButton("home", dpadLeft)).toBe("move-left");
    expect(livetvGamepadActionForButton("home", dpadRight)).toBe("move-right");
    expect(livetvGamepadActionForButton("home", a)).toBe("select");
    expect(livetvGamepadActionForButton("home", b)).toBe("back");
    expect(livetvGamepadActionForButton("home", x)).toBe("contextual");
    expect(livetvGamepadActionForButton("home", y)).toBe("open-guide");
    expect(livetvGamepadActionForButton("home", menu)).toBe("open-options");
  });

  it("Playback: A activates, B backs, D-pad Up/Down Quick Surf, Left/Right info, X Guide, Y Browser", () => {
    expect(livetvGamepadActionForButton("playback", a)).toBe("activate");
    expect(livetvGamepadActionForButton("playback", b)).toBe("back");
    expect(livetvGamepadActionForButton("playback", dpadUp)).toBe("quick-surf-up");
    expect(livetvGamepadActionForButton("playback", dpadDown)).toBe("quick-surf-down");
    expect(livetvGamepadActionForButton("playback", dpadLeft)).toBe("programme-info");
    expect(livetvGamepadActionForButton("playback", dpadRight)).toBe("programme-info");
    expect(livetvGamepadActionForButton("playback", x)).toBe("open-guide");
    expect(livetvGamepadActionForButton("playback", y)).toBe("open-browser");
    expect(livetvGamepadActionForButton("playback", menu)).toBe("open-options");
  });

  it("Guide: D-pad moves spatially, A selects, B returns, LB/RB shift time, Y/Menu guide actions", () => {
    expect(livetvGamepadActionForButton("guide", dpadUp)).toBe("move-up");
    expect(livetvGamepadActionForButton("guide", dpadDown)).toBe("move-down");
    expect(livetvGamepadActionForButton("guide", dpadLeft)).toBe("move-left");
    expect(livetvGamepadActionForButton("guide", dpadRight)).toBe("move-right");
    expect(livetvGamepadActionForButton("guide", a)).toBe("select");
    expect(livetvGamepadActionForButton("guide", b)).toBe("back");
    expect(livetvGamepadActionForButton("guide", lb)).toBe("time-prev");
    expect(livetvGamepadActionForButton("guide", rb)).toBe("time-next");
    expect(livetvGamepadActionForButton("guide", y)).toBe("guide-actions");
    expect(livetvGamepadActionForButton("guide", menu)).toBe("guide-actions");
    expect(livetvGamepadActionForButton("guide", x)).toBeNull();
  });

  it("LB/RB mean nothing outside the Guide", () => {
    expect(livetvGamepadActionForButton("home", lb)).toBeNull();
    expect(livetvGamepadActionForButton("home", rb)).toBeNull();
    expect(livetvGamepadActionForButton("playback", lb)).toBeNull();
    expect(livetvGamepadActionForButton("playback", rb)).toBeNull();
  });

  it("unknown buttons resolve to nothing", () => {
    expect(livetvGamepadActionForButton("home", 6)).toBeNull();
    expect(livetvGamepadActionForButton("guide", 99)).toBeNull();
  });
});

describe("View+Menu return-home is never intercepted", () => {
  it("View alone resolves to no action in ANY context", () => {
    const { view } = LIVETV_GAMEPAD_BUTTONS;
    expect(livetvGamepadActionForButton("home", view)).toBeNull();
    expect(livetvGamepadActionForButton("playback", view)).toBeNull();
    expect(livetvGamepadActionForButton("guide", view)).toBeNull();
  });

  it("the combo helper is true only when View AND Menu are both held", () => {
    expect(livetvReturnHomeComboPressed(true, true)).toBe(true);
    expect(livetvReturnHomeComboPressed(true, false)).toBe(false);
    expect(livetvReturnHomeComboPressed(false, true)).toBe(false);
    expect(livetvReturnHomeComboPressed(false, false)).toBe(false);
  });

  it("the hold time is 2 seconds", () => {
    expect(LIVETV_RETURN_HOME_HOLD_MS).toBe(2000);
  });

  it("the table documents return-home as a global row, not a context action", () => {
    const row = LIVETV_CONTROLLER_MAP.find(
      (entry) => entry.action === "return-home",
    );
    expect(row).toBeDefined();
    expect(row!.input).toContain("View + Menu");
  });
});

describe("stick movement", () => {
  it("dominant axis wins, inside the deadzone nothing happens", () => {
    expect(livetvStickAction(0.8, 0.1)).toBe("move-right");
    expect(livetvStickAction(-0.8, 0.1)).toBe("move-left");
    expect(livetvStickAction(0.1, 0.8)).toBe("move-down");
    expect(livetvStickAction(0.1, -0.8)).toBe("move-up");
    expect(livetvStickAction(0.2, 0.2)).toBeNull();
    expect(livetvStickAction(0, 0)).toBeNull();
    expect(livetvStickAction(0.6, 0.7)).toBe("move-down");
  });

  it("a tighter deadzone still filters small drift", () => {
    expect(livetvStickAction(0.3, 0, 0.5)).toBeNull();
    expect(livetvStickAction(0.3, 0, 0.2)).toBe("move-right");
  });
});

describe("the mapping table covers every context", () => {
  it("has rows for home, playback and guide", () => {
    const contexts = new Set(LIVETV_CONTROLLER_MAP.map((row) => row.context));
    expect(contexts.has("home")).toBe(true);
    expect(contexts.has("playback")).toBe(true);
    expect(contexts.has("guide")).toBe(true);
  });

  it("every row names a real action", () => {
    const known = new Set([
      "move-up", "move-down", "move-left", "move-right", "select", "activate",
      "back", "contextual", "open-guide", "open-browser", "open-options",
      "open-programme", "quick-surf-up", "quick-surf-down", "programme-info",
      "time-prev", "time-next", "jump-to-now", "guide-actions", "return-home",
    ]);
    for (const row of LIVETV_CONTROLLER_MAP) {
      expect(known.has(row.action)).toBe(true);
    }
  });
});
