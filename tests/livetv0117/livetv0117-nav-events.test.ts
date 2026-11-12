/**
 * @vitest-environment jsdom
 *
 * Live TV 2.0 (0.11.7) W5 — tests 10, 11, 12, 13, 14: controller
 * input, nav layers, hidden modes, playback return, EPG refresh.
 *
 *  10. LB/RB and LT/RT work without duplicate events.
 *  11. B closes precisely one navigation level.
 *  12. Hidden Live TV modes cannot steal input.
 *  13. Returning from playback restores relevant browser context.
 *  14. EPG updates don't reset channel focus unnecessarily.
 *
 * Real seams: livetv-keys mapping, livetv-state transitions,
 * stableGuideSelection, mountChannelBrowser back/hidden gating.
 * Stubs (marked STUB): the nav stack / input gate (W4 contract)
 * and the button-edge tracker (cross-source dedupe harness).
 * Synthetic data only; nothing here plays a stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountChannelBrowser } from "@/scripts/lib/livetv-browser";
import { stableGuideSelection } from "@/scripts/lib/livetv-guide";
import {
  LIVETV_GAMEPAD_BUTTONS,
  livetvGamepadActionForButton,
} from "@/scripts/lib/livetv-keys";
import {
  createLivetvState,
  enterBrowser,
  enterPlayback,
  exitPlaybackToLanding,
  guideProgrammeKey,
  tuneTo,
} from "@/scripts/lib/livetv-state";
import {
  buildCategoryIndex,
  getDerivedChannels,
} from "./stubs/category-index.stub";
import { dispatchLivetvCloseOverlay } from "./stubs/events.stub";
import {
  createButtonEdgeTracker,
  type ButtonSample,
} from "./stubs/input-dedupe.stub";
import {
  attachNavEventWiring,
  createLivetvInputGate,
  createLivetvNavStack,
} from "./stubs/nav.stub";
import { mountVirtualList } from "./stubs/virtual-list.stub";
import { FIXTURE_NOW_MS, buildFixtureProgrammes, fixture2000 } from "./fixtures";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
});

function holdSamples(
  button: number,
  samples: number,
  sources: Array<"xinput" | "gamepad"> = ["xinput", "gamepad"],
): ButtonSample[] {
  // Both sources report the same held press, interleaved, as a
  // poll loop would see them.
  const out: ButtonSample[] = [];
  for (let i = 0; i < samples; i++) {
    out.push({ source: sources[i % sources.length]!, button, pressed: true, atMs: 1000 + i * 16 });
  }
  return out;
}

function releaseSamples(button: number, atMs: number): ButtonSample[] {
  return [
    { source: "xinput", button, pressed: false, atMs },
    { source: "gamepad", button, pressed: false, atMs },
  ];
}

describe("test 10 — LB/RB and LT/RT work without duplicate events", () => {
  it("REAL mapping: LB/RB step categories, LT/RT step pages in the browser", () => {
    expect(livetvGamepadActionForButton("browser", LIVETV_GAMEPAD_BUTTONS.lb)).toBe("category-prev");
    expect(livetvGamepadActionForButton("browser", LIVETV_GAMEPAD_BUTTONS.rb)).toBe("category-next");
    expect(livetvGamepadActionForButton("browser", LIVETV_GAMEPAD_BUTTONS.lt)).toBe("page-prev");
    expect(livetvGamepadActionForButton("browser", LIVETV_GAMEPAD_BUTTONS.rt)).toBe("page-next");
  });

  it("STUB tracker: one held LB press from both sources emits exactly once", () => {
    const tracker = createButtonEdgeTracker({ context: "browser" });
    const emitted = holdSamples(LIVETV_GAMEPAD_BUTTONS.lb, 60).map((s) => tracker.feed(s));
    expect(emitted.filter(Boolean)).toHaveLength(1);
    expect(emitted.find(Boolean)).toMatchObject({
      button: LIVETV_GAMEPAD_BUTTONS.lb,
      action: "category-prev",
    });
  });

  it("STUB tracker: RB / LT / RT holds emit exactly once each", () => {
    const tracker = createButtonEdgeTracker({ context: "browser" });
    for (const [button, action] of [
      [LIVETV_GAMEPAD_BUTTONS.rb, "category-next"],
      [LIVETV_GAMEPAD_BUTTONS.lt, "page-prev"],
      [LIVETV_GAMEPAD_BUTTONS.rt, "page-next"],
    ] as const) {
      const emitted = holdSamples(button, 30).map((s) => tracker.feed(s));
      expect(emitted.filter(Boolean)).toHaveLength(1);
      expect(emitted.find(Boolean)?.action).toBe(action);
      for (const sample of releaseSamples(button, 5000)) tracker.feed(sample);
    }
  });

  it("STUB tracker: a second action requires a full release first", () => {
    const tracker = createButtonEdgeTracker({ context: "browser" });
    const button = LIVETV_GAMEPAD_BUTTONS.rb;
    expect(tracker.feed({ source: "xinput", button, pressed: true, atMs: 100 })).not.toBeNull();
    // The second source reports the same held press: still one press.
    expect(tracker.feed({ source: "gamepad", button, pressed: true, atMs: 108 })).toBeNull();
    // Only one source releases: still held, no new edge.
    expect(tracker.feed({ source: "xinput", button, pressed: false, atMs: 116 })).toBeNull();
    expect(tracker.feed({ source: "xinput", button, pressed: true, atMs: 132 })).toBeNull();
    // Full release, then a fresh press: a second action.
    for (const sample of releaseSamples(button, 200)) tracker.feed(sample);
    expect(tracker.feed({ source: "gamepad", button, pressed: true, atMs: 216 })).not.toBeNull();
  });

  it("STUB tracker: distinct buttons are independent", () => {
    const tracker = createButtonEdgeTracker({ context: "browser" });
    expect(
      tracker.feed({ source: "xinput", button: LIVETV_GAMEPAD_BUTTONS.lb, pressed: true, atMs: 100 }),
    ).not.toBeNull();
    expect(
      tracker.feed({ source: "xinput", button: LIVETV_GAMEPAD_BUTTONS.rb, pressed: true, atMs: 100 }),
    ).not.toBeNull();
    expect(
      tracker.feed({ source: "gamepad", button: LIVETV_GAMEPAD_BUTTONS.lb, pressed: true, atMs: 116 }),
    ).toBeNull();
  });

  it("deduped LB/RB steps through every category exactly once", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    const groupIds = index.groups.map((g) => g.id);
    const tracker = createButtonEdgeTracker({ context: "browser" });
    let current = 0;
    const visited: string[] = [groupIds[0]!];
    // Press RB (held, both sources) once per step around the ring.
    for (let step = 0; step < groupIds.length; step++) {
      for (const sample of holdSamples(LIVETV_GAMEPAD_BUTTONS.rb, 10)) {
        const emitted = tracker.feed(sample);
        if (emitted) current = (current + 1) % groupIds.length;
      }
      for (const sample of releaseSamples(LIVETV_GAMEPAD_BUTTONS.rb, 9000 + step)) {
        tracker.feed(sample);
      }
      visited.push(groupIds[current]!);
      // Each step lands on a real, non-empty derived list.
      expect(getDerivedChannels(index, { groupId: groupIds[current]! }).length).toBeGreaterThan(0);
    }
    expect(visited).toHaveLength(groupIds.length + 1);
    expect(new Set(visited.slice(0, -1)).size).toBe(groupIds.length);
    expect(visited[visited.length - 1]).toBe(groupIds[0]);
  });
});

describe("test 11 — B closes precisely one navigation level", () => {
  it("STUB stack: back() pops exactly one layer per press", () => {
    const stack = createLivetvNavStack("landing");
    stack.push("browser");
    stack.push("search");
    stack.push("sort");
    expect(stack.snapshot()).toEqual(["landing", "browser", "search", "sort"]);
    expect(stack.back()).toBe(true);
    expect(stack.snapshot()).toEqual(["landing", "browser", "search"]);
    expect(stack.back()).toBe(true);
    expect(stack.snapshot()).toEqual(["landing", "browser"]);
    expect(stack.back()).toBe(true);
    expect(stack.snapshot()).toEqual(["landing"]);
  });

  it("STUB stack: back() at the root closes nothing", () => {
    const stack = createLivetvNavStack("landing");
    expect(stack.back()).toBe(false);
    expect(stack.snapshot()).toEqual(["landing"]);
    expect(stack.back()).toBe(false);
    expect(stack.depth()).toBe(1);
  });

  it("STUB events: one livetv:close-overlay closes exactly one overlay layer", () => {
    const stack = createLivetvNavStack("landing");
    stack.push("browser");
    stack.push("search");
    stack.push("options");
    const detach = attachNavEventWiring(stack);
    dispatchLivetvCloseOverlay();
    expect(stack.snapshot()).toEqual(["landing", "browser", "search"]);
    dispatchLivetvCloseOverlay();
    expect(stack.snapshot()).toEqual(["landing", "browser"]);
    // Top is a mode, not an overlay: the event closes nothing.
    dispatchLivetvCloseOverlay();
    expect(stack.snapshot()).toEqual(["landing", "browser"]);
    detach();
    dispatchLivetvCloseOverlay();
    expect(stack.snapshot()).toEqual(["landing", "browser"]);
  });

  it("REAL browser: B closes search first, then exits — one level per press", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const handle = mountChannelBrowser(root, {
      channels: fixture2000().slice(0, 50),
      onClose,
      acceptModeEntry: true,
    });
    handle.openSearch();
    window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    expect(handle.isSearchOpen()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.destroy();
    vi.useRealTimers();
  });
});

describe("test 12 — hidden Live TV modes cannot steal input", () => {
  it("STUB gate: only the active mode accepts input", () => {
    const gate = createLivetvInputGate("browser");
    const seen: string[] = [];
    expect(gate.deliverInput("guide", () => seen.push("guide"))).toBe(false);
    expect(gate.deliverInput("playback", () => seen.push("playback"))).toBe(false);
    expect(gate.deliverInput("landing", () => seen.push("landing"))).toBe(false);
    expect(gate.deliverInput("browser", () => seen.push("browser"))).toBe(true);
    expect(seen).toEqual(["browser"]);
    gate.setActiveMode("guide");
    expect(gate.deliverInput("browser", () => seen.push("browser"))).toBe(false);
    expect(gate.deliverInput("guide", () => seen.push("guide"))).toBe(true);
    expect(seen).toEqual(["browser", "guide"]);
  });

  it("STUB gate: an open overlay gates the mode underneath it", () => {
    const gate = createLivetvInputGate("browser");
    gate.openOverlay("search");
    expect(gate.canAcceptInput("browser")).toBe(false);
    expect(gate.canAcceptInput("search")).toBe(true);
    expect(gate.canAcceptInput("sort")).toBe(false);
    gate.closeOverlay();
    expect(gate.canAcceptInput("browser")).toBe(true);
    expect(gate.canAcceptInput("search")).toBe(false);
  });

  it("STUB gate: switching modes re-gates without leaking handlers", () => {
    const gate = createLivetvInputGate("landing");
    const counts = { landing: 0, browser: 0, guide: 0, playback: 0 };
    for (const mode of ["browser", "guide", "playback", "landing"] as const) {
      gate.setActiveMode(mode);
      for (const target of ["landing", "browser", "guide", "playback"] as const) {
        gate.deliverInput(target, () => {
          counts[target] += 1;
        });
      }
    }
    expect(counts).toEqual({ landing: 1, browser: 1, guide: 1, playback: 1 });
  });

  it("REAL browser: a hidden browser ignores livetv:back; visible, it answers", () => {
    const onClose = vi.fn();
    root.setAttribute("hidden", "");
    const handle = mountChannelBrowser(root, {
      channels: fixture2000().slice(0, 20),
      onClose,
    });
    window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    expect(onClose).not.toHaveBeenCalled();
    root.removeAttribute("hidden");
    window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.destroy();
  });
});

describe("test 13 — returning from playback restores browser context", () => {
  it("REAL state: leaving playback keeps the tuned and previous channels", () => {
    let state = createLivetvState(FIXTURE_NOW_MS);
    state = enterBrowser(state, { kind: "category", value: "sports" });
    state = tuneTo(state, "42");
    state = enterPlayback(state, "42");
    expect(state.mode).toBe("playback");
    expect(state.tunedChannelId).toBe("42");
    state = enterPlayback(state, "87");
    expect(state.previousChannelId).toBe("42");
    expect(state.tunedChannelId).toBe("87");
    state = exitPlaybackToLanding(state);
    expect(state.mode).toBe("landing");
    expect(state.tunedChannelId).toBe("87");
    expect(state.previousChannelId).toBe("42");
    expect(state.highlightedChannelId).toBe("87");
  });

  it("STUB list: capture/restore returns focus and scroll to the same place", () => {
    const channels = fixture2000();
    const handle = mountVirtualList(root, {
      items: channels,
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
      rowHeight: 76,
      viewportHeight: 600,
      overscanRows: 3,
    });
    for (let i = 0; i < 137; i++) handle.moveFocus(1);
    const context = handle.captureContext();
    expect(context.focusedKey).toBe(String(channels[137]!.id));
    expect(context.scrollTop).toBeGreaterThan(0);
    // Simulate playback: focus/scroll move elsewhere, then return.
    handle.setFocusedKey(String(channels[0]!.id));
    handle.setScrollTop(0);
    expect(handle.getFocusedKey()).toBe(String(channels[0]!.id));
    handle.restoreContext(context);
    expect(handle.getFocusedKey()).toBe(context.focusedKey);
    expect(handle.getScrollTop()).toBe(context.scrollTop);
    expect(handle.getMountedKeys()).toContain(context.focusedKey);
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute("data-key")).toBe(context.focusedKey);
    handle.destroy();
  });

  it("STUB list: restore survives the focused channel leaving the catalogue", () => {
    const channels = fixture2000();
    const handle = mountVirtualList(root, {
      items: channels,
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
    });
    for (let i = 0; i < 50; i++) handle.moveFocus(1);
    const context = handle.captureContext();
    const removed = channels.filter((c) => String(c.id) !== context.focusedKey);
    handle.setItems(removed);
    handle.restoreContext(context);
    // Focus falls back to a live row instead of crashing or
    // pointing at a removed channel.
    expect(handle.getFocusedKey()).not.toBe(context.focusedKey);
    expect(handle.getFocusedKey()).not.toBeNull();
    handle.destroy();
  });
});

describe("test 14 — EPG updates don't reset channel focus unnecessarily", () => {
  it("STUB list: an EPG-only update keeps focus, scroll and row identity", () => {
    const channels = fixture2000();
    const handle = mountVirtualList(root, {
      items: channels,
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
      programmeOf: (c) => `Old programme for ${c.displayName}`,
      rowHeight: 76,
      viewportHeight: 600,
      overscanRows: 3,
    });
    for (let i = 0; i < 80; i++) handle.moveFocus(1);
    const focusedKey = handle.getFocusedKey()!;
    const scrollTop = handle.getScrollTop();
    const rowBefore = root.querySelector(`[data-virtual-row][data-key="${focusedKey}"]`)!;
    const patch = new Map<string, string>();
    for (const key of handle.getMountedKeys()) {
      patch.set(key, `New programme for ${key}`);
    }
    handle.applyEpgUpdate(patch);
    expect(handle.getFocusedKey()).toBe(focusedKey);
    expect(handle.getScrollTop()).toBe(scrollTop);
    const rowAfter = root.querySelector(`[data-virtual-row][data-key="${focusedKey}"]`)!;
    expect(rowAfter).toBe(rowBefore);
    expect(rowAfter.querySelector("[data-virtual-programme]")?.textContent).toBe(
      `New programme for ${focusedKey}`,
    );
    handle.destroy();
  });

  it("REAL guide: selection stays on the same programme across an EPG refresh", () => {
    const channels = fixture2000().slice(0, 5);
    const programmes = buildFixtureProgrammes(channels, { coverage: 1 });
    const first = channels[0]!;
    const list = programmes.get(String(first.id))!;
    const current = list.find(
      (p) => p.startMs <= FIXTURE_NOW_MS && p.stopMs > FIXTURE_NOW_MS,
    )!;
    const key = guideProgrammeKey(String(first.id), current.startMs);
    // Refresh with the same programmes (new array instances): kept.
    const refreshed = list.map((p) => ({ ...p }));
    expect(stableGuideSelection(key, refreshed, FIXTURE_NOW_MS)).toBe(key);
    // Refresh where the programme is gone: falls back to on-now,
    // never to null while programmes exist.
    const without = refreshed.filter((p) => p.startMs !== current.startMs);
    const fallback = stableGuideSelection(key, without, FIXTURE_NOW_MS);
    expect(fallback).not.toBeNull();
    expect(fallback).not.toBe(key);
  });

  it("REAL browser: a data refresh keeps highlight and scroll", () => {
    const channels = fixture2000().slice(0, 60);
    const handle = mountChannelBrowser(root, { channels });
    handle.highlightChannel(channels[30]!.id);
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    list.scrollTop = 500;
    handle.setChannels([...channels]);
    expect(handle.getHighlightedId()).toBe(channels[30]!.id);
    expect(list.scrollTop).toBe(500);
    handle.destroy();
  });
});
