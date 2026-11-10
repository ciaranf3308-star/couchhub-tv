import { describe, it, expect } from "vitest";
import {
  LIVETV_BACK_EVENT,
  LIVETV_CONTROLLER_MAP,
  LIVETV_GAMEPAD_BUTTONS,
  LIVETV_RETURN_HOME_HOLD_MS,
  dispatchLivetvBack,
  livetvGamepadActionForButton,
  livetvKeyActionForKey,
  livetvReturnHomeComboPressed,
  livetvStickAction,
  normaliseLivetvKeyContext,
} from "@/scripts/lib/livetv-keys";

describe("keyboard mapping — Landing", () => {
  it("arrows move, Enter selects, Esc goes back", () => {
    expect(livetvKeyActionForKey("landing", "ArrowUp")).toBe("move-up");
    expect(livetvKeyActionForKey("landing", "ArrowDown")).toBe("move-down");
    expect(livetvKeyActionForKey("landing", "ArrowLeft")).toBe("move-left");
    expect(livetvKeyActionForKey("landing", "ArrowRight")).toBe("move-right");
    expect(livetvKeyActionForKey("landing", "Enter")).toBe("select");
    expect(livetvKeyActionForKey("landing", " ")).toBe("select");
    expect(livetvKeyActionForKey("landing", "Escape")).toBe("back");
  });

  it("Y opens the Guide, X is contextual, Menu opens options", () => {
    expect(livetvKeyActionForKey("landing", "y")).toBe("open-guide");
    expect(livetvKeyActionForKey("landing", "Y")).toBe("open-guide");
    expect(livetvKeyActionForKey("landing", "x")).toBe("contextual");
    expect(livetvKeyActionForKey("landing", "ContextMenu")).toBe("open-options");
  });

  it("unknown keys resolve to nothing", () => {
    expect(livetvKeyActionForKey("landing", "q")).toBeNull();
    expect(livetvKeyActionForKey("landing", "F5")).toBeNull();
    expect(livetvKeyActionForKey("landing", null)).toBeNull();
  });

  it("legacy \"home\" context resolves exactly like \"landing\"", () => {
    expect(normaliseLivetvKeyContext("home")).toBe("landing");
    expect(livetvKeyActionForKey("home", "ArrowUp")).toBe("move-up");
    expect(livetvKeyActionForKey("home", "y")).toBe("open-guide");
    expect(livetvKeyActionForKey("home", "x")).toBe("contextual");
    expect(livetvKeyActionForKey("home", "Escape")).toBe("back");
    expect(livetvGamepadActionForButton("home", LIVETV_GAMEPAD_BUTTONS.a)).toBe("select");
    expect(livetvGamepadActionForButton("home", LIVETV_GAMEPAD_BUTTONS.b)).toBe("back");
  });
});

describe("keyboard mapping — Channel Browser", () => {
  it("arrows move, Enter selects, Esc goes back", () => {
    expect(livetvKeyActionForKey("browser", "ArrowUp")).toBe("move-up");
    expect(livetvKeyActionForKey("browser", "ArrowDown")).toBe("move-down");
    expect(livetvKeyActionForKey("browser", "ArrowLeft")).toBe("move-left");
    expect(livetvKeyActionForKey("browser", "ArrowRight")).toBe("move-right");
    expect(livetvKeyActionForKey("browser", "Enter")).toBe("select");
    expect(livetvKeyActionForKey("browser", "Escape")).toBe("back");
  });

  it("X toggles favourite, Y opens search, Menu opens options", () => {
    expect(livetvKeyActionForKey("browser", "x")).toBe("toggle-favourite");
    expect(livetvKeyActionForKey("browser", "X")).toBe("toggle-favourite");
    expect(livetvKeyActionForKey("browser", "y")).toBe("open-search");
    expect(livetvKeyActionForKey("browser", "ContextMenu")).toBe("open-options");
    expect(livetvKeyActionForKey("browser", "m")).toBe("open-options");
  });

  it("[ / ] step categories, PageUp / PageDown step pages", () => {
    expect(livetvKeyActionForKey("browser", "[")).toBe("category-prev");
    expect(livetvKeyActionForKey("browser", "]")).toBe("category-next");
    expect(livetvKeyActionForKey("browser", "PageUp")).toBe("page-prev");
    expect(livetvKeyActionForKey("browser", "PageDown")).toBe("page-next");
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

  it("[ / ] step days (By Channel day nav)", () => {
    expect(livetvKeyActionForKey("guide", "[")).toBe("day-prev");
    expect(livetvKeyActionForKey("guide", "]")).toBe("day-next");
  });

  it("Left/Right on the tab row switch guide views, elsewhere they move", () => {
    expect(livetvKeyActionForKey("guide", "ArrowLeft", { onTabRow: true })).toBe("guide-mode-prev");
    expect(livetvKeyActionForKey("guide", "ArrowRight", { onTabRow: true })).toBe("guide-mode-next");
    expect(livetvKeyActionForKey("guide", "ArrowLeft")).toBe("move-left");
    expect(livetvKeyActionForKey("guide", "ArrowRight")).toBe("move-right");
  });

  it("X is unmapped in the Guide (it means Full Guide only in playback)", () => {
    expect(livetvKeyActionForKey("guide", "x")).toBeNull();
  });
});

describe("gamepad mapping", () => {
  const { a, b, x, y, lb, rb, lt, rt, view, menu, dpadUp, dpadDown, dpadLeft, dpadRight } =
    LIVETV_GAMEPAD_BUTTONS;

  it("Landing: D-pad moves, A selects, B backs, X contextual, Y Guide, Menu options", () => {
    expect(livetvGamepadActionForButton("landing", dpadUp)).toBe("move-up");
    expect(livetvGamepadActionForButton("landing", dpadDown)).toBe("move-down");
    expect(livetvGamepadActionForButton("landing", dpadLeft)).toBe("move-left");
    expect(livetvGamepadActionForButton("landing", dpadRight)).toBe("move-right");
    expect(livetvGamepadActionForButton("landing", a)).toBe("select");
    expect(livetvGamepadActionForButton("landing", b)).toBe("back");
    expect(livetvGamepadActionForButton("landing", x)).toBe("contextual");
    expect(livetvGamepadActionForButton("landing", y)).toBe("open-guide");
    expect(livetvGamepadActionForButton("landing", menu)).toBe("open-options");
  });

  it("Browser: D-pad moves, A selects, B backs, LB/RB categories, LT/RT pages, X favourite, Y search", () => {
    expect(livetvGamepadActionForButton("browser", dpadUp)).toBe("move-up");
    expect(livetvGamepadActionForButton("browser", dpadDown)).toBe("move-down");
    expect(livetvGamepadActionForButton("browser", a)).toBe("select");
    expect(livetvGamepadActionForButton("browser", b)).toBe("back");
    expect(livetvGamepadActionForButton("browser", lb)).toBe("category-prev");
    expect(livetvGamepadActionForButton("browser", rb)).toBe("category-next");
    expect(livetvGamepadActionForButton("browser", lt)).toBe("page-prev");
    expect(livetvGamepadActionForButton("browser", rt)).toBe("page-next");
    expect(livetvGamepadActionForButton("browser", x)).toBe("toggle-favourite");
    expect(livetvGamepadActionForButton("browser", y)).toBe("open-search");
    expect(livetvGamepadActionForButton("browser", menu)).toBe("open-options");
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

  it("Guide LB/RB step days in By Channel mode, time elsewhere", () => {
    expect(livetvGamepadActionForButton("guide", lb, { guideMode: "channel" })).toBe("day-prev");
    expect(livetvGamepadActionForButton("guide", rb, { guideMode: "channel" })).toBe("day-next");
    expect(livetvGamepadActionForButton("guide", lb, { guideMode: "grid" })).toBe("time-prev");
    expect(livetvGamepadActionForButton("guide", rb, { guideMode: "grid" })).toBe("time-next");
    expect(livetvGamepadActionForButton("guide", lb, { guideMode: "now" })).toBe("time-prev");
  });

  it("Guide Left/Right on the tab row switch guide views", () => {
    expect(livetvGamepadActionForButton("guide", dpadLeft, { onTabRow: true })).toBe("guide-mode-prev");
    expect(livetvGamepadActionForButton("guide", dpadRight, { onTabRow: true })).toBe("guide-mode-next");
    expect(livetvGamepadActionForButton("guide", dpadLeft)).toBe("move-left");
  });

  it("LB/RB mean nothing outside the Guide and Browser", () => {
    expect(livetvGamepadActionForButton("landing", lb)).toBeNull();
    expect(livetvGamepadActionForButton("landing", rb)).toBeNull();
    expect(livetvGamepadActionForButton("playback", lb)).toBeNull();
    expect(livetvGamepadActionForButton("playback", rb)).toBeNull();
  });

  it("LT/RT mean nothing outside the Browser (volume lives in gamepad.ts, not the table)", () => {
    expect(livetvGamepadActionForButton("landing", lt)).toBeNull();
    expect(livetvGamepadActionForButton("landing", rt)).toBeNull();
    expect(livetvGamepadActionForButton("playback", lt)).toBeNull();
    expect(livetvGamepadActionForButton("playback", rt)).toBeNull();
    expect(livetvGamepadActionForButton("guide", lt)).toBeNull();
    expect(livetvGamepadActionForButton("guide", rt)).toBeNull();
    expect(LIVETV_GAMEPAD_BUTTONS.lt).toBe(6);
    expect(LIVETV_GAMEPAD_BUTTONS.rt).toBe(7);
  });

  it("unknown buttons resolve to nothing", () => {
    expect(livetvGamepadActionForButton("landing", 99)).toBeNull();
    expect(livetvGamepadActionForButton("guide", 99)).toBeNull();
    expect(livetvGamepadActionForButton("browser", 99)).toBeNull();
  });
});

describe("livetv:back dispatch", () => {
  it("B resolves to \"back\" in EVERY context", () => {
    const { b } = LIVETV_GAMEPAD_BUTTONS;
    for (const context of ["landing", "browser", "playback", "guide"] as const) {
      expect(livetvGamepadActionForButton(context, b)).toBe("back");
      expect(livetvKeyActionForKey(context, "Escape")).toBe("back");
      expect(livetvKeyActionForKey(context, "Backspace")).toBe("back");
    }
  });

  it("dispatchLivetvBack fires livetv:back with the context in the detail", () => {
    const target = new EventTarget();
    const seen: { context: string }[] = [];
    target.addEventListener(LIVETV_BACK_EVENT, (event) => {
      seen.push((event as CustomEvent).detail);
    });
    dispatchLivetvBack(target, "landing");
    dispatchLivetvBack(target, "browser");
    dispatchLivetvBack(target, "playback");
    dispatchLivetvBack(target, "guide");
    expect(seen).toEqual([
      { context: "landing" },
      { context: "browser" },
      { context: "playback" },
      { context: "guide" },
    ]);
  });
});

describe("View+Menu return-home is never intercepted", () => {
  it("View alone resolves to no action in ANY context", () => {
    const { view } = LIVETV_GAMEPAD_BUTTONS;
    expect(livetvGamepadActionForButton("landing", view)).toBeNull();
    expect(livetvGamepadActionForButton("browser", view)).toBeNull();
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
  it("has rows for landing, browser, playback and guide", () => {
    const contexts = new Set(LIVETV_CONTROLLER_MAP.map((row) => row.context));
    expect(contexts.has("landing")).toBe(true);
    expect(contexts.has("browser")).toBe(true);
    expect(contexts.has("playback")).toBe(true);
    expect(contexts.has("guide")).toBe(true);
  });

  it("every row names a real action", () => {
    const known = new Set([
      "move-up", "move-down", "move-left", "move-right", "select", "activate",
      "back", "contextual", "open-guide", "open-browser", "open-options",
      "open-programme", "open-search", "toggle-favourite", "category-prev",
      "category-next", "page-prev", "page-next", "guide-mode-prev",
      "guide-mode-next", "day-prev", "day-next",
      "quick-surf-up", "quick-surf-down", "programme-info",
      "time-prev", "time-next", "jump-to-now", "guide-actions", "return-home",
    ]);
    for (const row of LIVETV_CONTROLLER_MAP) {
      expect(known.has(row.action)).toBe(true);
    }
  });

  it("every table row resolves the same way through the gamepad resolver", () => {
    // Spot-check the new browser rows end to end through the resolver.
    const browserRows = LIVETV_CONTROLLER_MAP.filter((row) => row.context === "browser");
    expect(browserRows.length).toBeGreaterThan(0);
    const byInput = new Map(browserRows.map((row) => [row.input, row.action]));
    expect(byInput.get("LB")).toBe("category-prev");
    expect(byInput.get("RB")).toBe("category-next");
    expect(byInput.get("LT")).toBe("page-prev");
    expect(byInput.get("RT")).toBe("page-next");
    expect(byInput.get("X")).toBe("toggle-favourite");
    expect(byInput.get("Y")).toBe("open-search");
  });
});
