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
 * All seams are REAL: the gamepad poll loop's rising-edge +
 * native-path stand-down (gamepad.ts), the W4 nav controller and
 * top-layer back guards (livetv-nav.ts), livetv-keys mapping,
 * livetv-state transitions, stableGuideSelection, and
 * mountChannelBrowser back/hidden gating. The poll-loop tests
 * drive mountGamepad with a mocked Gamepad API; the native path
 * sends edges only (Rust), so cross-source dedupe is the loop
 * standing down while the native path is live.
 * Synthetic data only; nothing here plays a stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { browserCategories, mountChannelBrowser } from "@/scripts/lib/livetv-browser";
import { mountGamepad, noteNativeInputActive } from "@/scripts/lib/gamepad";
import { stableGuideSelection } from "@/scripts/lib/livetv-guide";
import {
  LIVETV_GAMEPAD_BUTTONS,
  livetvGamepadActionForButton,
} from "@/scripts/lib/livetv-keys";
import {
  LivetvNavController,
  installTopLayerBackGuard,
  livetvNav,
} from "@/scripts/lib/livetv-nav";
import { dispatchLivetvSearchSubmit } from "@/scripts/lib/livetv-search-sort";
import {
  createLivetvState,
  enterBrowser,
  enterPlayback,
  exitPlaybackToLanding,
  guideProgrammeKey,
  tuneTo,
} from "@/scripts/lib/livetv-state";
import { FIXTURE_NOW_MS, buildFixtureProgrammes, fixture2000 } from "./fixtures";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
  livetvNav.reset();
  delete document.documentElement.dataset.livetvMode;
});

function keyOn(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

async function nextFrames(count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

describe("test 10 — LB/RB and LT/RT work without duplicate events", () => {
  it("REAL mapping: LB/RB step categories, LT/RT step pages in the browser", () => {
    expect(livetvGamepadActionForButton("browser", LIVETV_GAMEPAD_BUTTONS.lb)).toBe("category-prev");
    expect(livetvGamepadActionForButton("browser", LIVETV_GAMEPAD_BUTTONS.rb)).toBe("category-next");
    expect(livetvGamepadActionForButton("browser", LIVETV_GAMEPAD_BUTTONS.lt)).toBe("page-prev");
    expect(livetvGamepadActionForButton("browser", LIVETV_GAMEPAD_BUTTONS.rt)).toBe("page-next");
  });

  describe("REAL poll loop (mocked Gamepad API)", () => {
    const BUTTON_COUNT = 17;
    let pressed: boolean[];
    let keys: string[];
    let keyListener: (event: Event) => void;
    let originalGetGamepads: typeof navigator.getGamepads | undefined;

    function fakePad(): Gamepad {
      return {
        index: 0,
        connected: true,
        buttons: pressed.map((p) => ({ pressed: p, value: p ? 1 : 0 })) as GamepadButton[],
        axes: [0, 0, 0, 0],
      } as Gamepad;
    }

    beforeAll(() => {
      document.documentElement.dataset.livetvMode = "browser";
      pressed = new Array(BUTTON_COUNT).fill(false);
      keys = [];
      originalGetGamepads = navigator.getGamepads;
      Object.defineProperty(navigator, "getGamepads", {
        value: () => [fakePad()],
        configurable: true,
      });
      keyListener = (event: Event) => {
        keys.push((event as KeyboardEvent).key);
      };
      window.addEventListener("keydown", keyListener, true);
      mountGamepad();
      window.dispatchEvent(new Event("gamepadconnected"));
    });

    afterAll(() => {
      window.removeEventListener("keydown", keyListener, true);
      Object.defineProperty(navigator, "getGamepads", {
        value: originalGetGamepads,
        configurable: true,
      });
      delete document.documentElement.dataset.livetvMode;
    });

    beforeEach(async () => {
      // The outer afterEach clears the mode mirror; restore the
      // browser context the poll loop's button mapping reads.
      document.documentElement.dataset.livetvMode = "browser";
      // Settle the loop with everything released before each case.
      pressed.fill(false);
      await nextFrames(3);
      keys.length = 0;
    });

    function setPressed(button: number, value: boolean): void {
      pressed[button] = value;
    }

    it("one held LB press emits exactly once across 60 poll frames", { timeout: 60_000 }, async () => {
      setPressed(LIVETV_GAMEPAD_BUTTONS.lb, true);
      await nextFrames(60);
      expect(keys.filter((k) => k === "[")).toHaveLength(1);
      setPressed(LIVETV_GAMEPAD_BUTTONS.lb, false);
      await nextFrames(3);
    });

    it("RB / LT / RT holds emit exactly once each", { timeout: 60_000 }, async () => {
      const cases = [
        [LIVETV_GAMEPAD_BUTTONS.rb, "]"],
        [LIVETV_GAMEPAD_BUTTONS.lt, "PageUp"],
        [LIVETV_GAMEPAD_BUTTONS.rt, "PageDown"],
      ] as const;
      for (const [button, key] of cases) {
        keys.length = 0;
        setPressed(button, true);
        await nextFrames(30);
        expect(keys.filter((k) => k === key)).toHaveLength(1);
        setPressed(button, false);
        await nextFrames(3);
      }
    });

    it("a second action requires a full release first", { timeout: 60_000 }, async () => {
      const button = LIVETV_GAMEPAD_BUTTONS.rb;
      setPressed(button, true);
      await nextFrames(10);
      expect(keys.filter((k) => k === "]")).toHaveLength(1);
      // Still held across more frames: no new edge.
      await nextFrames(20);
      expect(keys.filter((k) => k === "]")).toHaveLength(1);
      // Full release, then a fresh press: a second action.
      setPressed(button, false);
      await nextFrames(3);
      setPressed(button, true);
      await nextFrames(10);
      expect(keys.filter((k) => k === "]")).toHaveLength(2);
      setPressed(button, false);
      await nextFrames(3);
    });

    it("distinct buttons are independent", { timeout: 60_000 }, async () => {
      setPressed(LIVETV_GAMEPAD_BUTTONS.lb, true);
      setPressed(LIVETV_GAMEPAD_BUTTONS.rb, true);
      await nextFrames(10);
      expect(keys.filter((k) => k === "[")).toHaveLength(1);
      expect(keys.filter((k) => k === "]")).toHaveLength(1);
      await nextFrames(20);
      expect(keys.filter((k) => k === "[")).toHaveLength(1);
      expect(keys.filter((k) => k === "]")).toHaveLength(1);
      setPressed(LIVETV_GAMEPAD_BUTTONS.lb, false);
      setPressed(LIVETV_GAMEPAD_BUTTONS.rb, false);
      await nextFrames(3);
    });

    it("while the native XInput path is live, the browser loop stands down (no cross-source duplicates)", { timeout: 60_000 }, async () => {
      // The same physical pad is visible to BOTH XInput and the
      // Gamepad API: while native input is live, the poll loop
      // must process nothing, so no press can fire twice.
      noteNativeInputActive();
      setPressed(LIVETV_GAMEPAD_BUTTONS.lb, true);
      await nextFrames(30);
      expect(keys.filter((k) => k === "[")).toHaveLength(0);
      setPressed(LIVETV_GAMEPAD_BUTTONS.lb, false);
      await nextFrames(3);
    });
  });

  it("LB/RB key steps through every category exactly once (real browser)", () => {
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, {
      channels,
      recentIds: [channels[0]!.id],
    });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    const expectedCount = browserCategories(channels, [channels[0]!.id]).length;
    const start = handle.getCategoryId();
    const visited: string[] = [start];
    for (let step = 0; step < expectedCount; step++) {
      keyOn(list, "]");
      visited.push(handle.getCategoryId());
      // Each step lands on a real, non-empty list.
      expect(handle.getVisibleChannels().length).toBeGreaterThan(0);
    }
    expect(visited).toHaveLength(expectedCount + 1);
    expect(new Set(visited.slice(0, -1)).size).toBe(expectedCount);
    expect(visited[visited.length - 1]).toBe(start);
    handle.destroy();
  });
});

describe("test 11 — B closes precisely one navigation level", () => {
  function freshController(): LivetvNavController {
    // Null deps: pure stack behaviour, no document mirror.
    return new LivetvNavController(undefined, { document: null, eventTarget: null });
  }

  it("REAL stack: back() pops exactly one layer per press", () => {
    const controller = freshController();
    controller.push({ id: "browser" });
    controller.push({ id: "search" });
    controller.push({ id: "sort" });
    expect(controller.layerIds()).toEqual(["landing", "browser", "search", "sort"]);
    expect(controller.back()).toBe(true);
    expect(controller.layerIds()).toEqual(["landing", "browser", "search"]);
    expect(controller.back()).toBe(true);
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
    expect(controller.back()).toBe(true);
    expect(controller.layerIds()).toEqual(["landing"]);
  });

  it("REAL stack: back() at the root closes nothing", () => {
    const controller = freshController();
    expect(controller.back()).toBe(false);
    expect(controller.layerIds()).toEqual(["landing"]);
    expect(controller.back()).toBe(false);
    expect(controller.stack).toHaveLength(1);
  });

  it("REAL stack: an onBack veto consumes B without popping", () => {
    const controller = freshController();
    controller.push({ id: "browser" });
    controller.push({ id: "drawer", onBack: () => false });
    expect(controller.back()).toBe(true);
    expect(controller.layerIds()).toEqual(["landing", "browser", "drawer"]);
  });

  it("REAL guards: one livetv:back pops exactly one guarded overlay layer", () => {
    const target = new EventTarget();
    const controller = freshController();
    controller.push({ id: "browser" });
    controller.push({ id: "search" });
    controller.push({ id: "sort" });
    const uninstallSort = installTopLayerBackGuard(controller, "sort", target);
    const uninstallSearch = installTopLayerBackGuard(controller, "search", target);
    const back = () => target.dispatchEvent(new CustomEvent("livetv:back"));
    back();
    expect(controller.layerIds()).toEqual(["landing", "browser", "search"]);
    back();
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
    // Top is a mode, not a guarded overlay: the event pops nothing.
    back();
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
    uninstallSort();
    uninstallSearch();
    back();
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
  });

  it("REAL browser: B closes search first, then exits — one level per press", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const handle = mountChannelBrowser(root, {
      channels: fixture2000().slice(0, 50),
      onClose,
      acceptModeEntry: true,
    });
    dispatchLivetvSearchSubmit(window, { query: "sports", scope: "all", categoryId: null });
    expect(handle.isSearchOpen()).toBe(true);
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
  function freshController(): LivetvNavController {
    return new LivetvNavController(undefined, { document: null, eventTarget: null });
  }

  it("REAL stack: only the top layer accepts input (isTop gate)", () => {
    const controller = freshController();
    controller.push({ id: "browser" });
    expect(controller.isTop("browser")).toBe(true);
    expect(controller.isTop("guide")).toBe(false);
    expect(controller.isTop("playback")).toBe(false);
    expect(controller.isTop("landing")).toBe(false);
    controller.pop();
    controller.push({ id: "guide" });
    expect(controller.isTop("browser")).toBe(false);
    expect(controller.isTop("guide")).toBe(true);
  });

  it("REAL stack: an open overlay gates the mode underneath it", () => {
    const controller = freshController();
    controller.push({ id: "browser" });
    controller.push({ id: "search" });
    expect(controller.isTop("browser")).toBe(false);
    expect(controller.isTop("search")).toBe(true);
    expect(controller.isTop("sort")).toBe(false);
    controller.pop();
    expect(controller.isTop("browser")).toBe(true);
    expect(controller.isTop("search")).toBe(false);
  });

  it("REAL stack: switching modes re-gates (shell marker discipline)", () => {
    const controller = freshController();
    const seen: Record<string, number> = { landing: 0, browser: 0, guide: 0, playback: 0 };
    for (const mode of ["browser", "guide", "playback", "landing"] as const) {
      controller.popTo("landing");
      if (mode !== "landing") controller.push({ id: mode, key: `shell:${mode}` });
      for (const target of ["landing", "browser", "guide", "playback"] as const) {
        if (controller.isTop(target)) seen[target] += 1;
      }
    }
    expect(seen).toEqual({ landing: 1, browser: 1, guide: 1, playback: 1 });
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

  it("REAL browser: B is blocked while another surface's drawer layer is on top", () => {
    const onClose = vi.fn();
    const handle = mountChannelBrowser(root, {
      channels: fixture2000().slice(0, 20),
      onClose,
    });
    livetvNav.push({ id: "drawer", key: "other-drawer" });
    window.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    expect(onClose).not.toHaveBeenCalled();
    livetvNav.pop();
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

  it("REAL browser: highlight and scroll survive hide/show + refresh (playback round-trip)", () => {
    const channels = fixture2000();
    const handle = mountChannelBrowser(root, { channels });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    handle.highlightChannel(channels[137]!.id, { focus: true });
    const scrollTop = list.scrollTop;
    expect(scrollTop).toBeGreaterThan(0);
    expect(handle.getHighlightedId()).toBe(channels[137]!.id);
    // Simulate playback: the browser hides, a refresh lands, return.
    root.setAttribute("hidden", "");
    handle.setChannels([...channels]);
    root.removeAttribute("hidden");
    expect(handle.getHighlightedId()).toBe(channels[137]!.id);
    expect(list.scrollTop).toBe(scrollTop);
    const row = root.querySelector<HTMLElement>(
      `[data-browser-row][data-channel-id="${channels[137]!.id}"]`,
    );
    expect(row).not.toBeNull();
    handle.highlightChannel(channels[137]!.id, { focus: true });
    expect(document.activeElement).toBe(row);
    handle.destroy();
  });

  it("REAL browser: restore survives the highlighted channel leaving the catalogue", () => {
    const channels = fixture2000();
    // Screen mode: the highlight always names a visible channel.
    const handle = mountChannelBrowser(root, { channels, autoHighlightFirst: true });
    handle.highlightChannel(channels[50]!.id);
    const removed = channels.filter((c) => c.id !== channels[50]!.id);
    handle.setChannels(removed);
    // Focus falls back to a live row instead of crashing or
    // pointing at a removed channel.
    expect(handle.getHighlightedId()).not.toBe(channels[50]!.id);
    expect(handle.getHighlightedId()).not.toBeNull();
    expect(
      removed.some((c) => String(c.id) === String(handle.getHighlightedId())),
    ).toBe(true);
    handle.destroy();
  });
});

describe("test 14 — EPG updates don't reset channel focus unnecessarily", () => {
  it("REAL browser: an EPG-only refresh keeps highlight, scroll and row identity", () => {
    const channels = fixture2000();
    const titles = new Map<string, string>();
    for (const channel of channels) {
      titles.set(String(channel.id), `Old programme for ${channel.displayName}`);
    }
    const handle = mountChannelBrowser(root, {
      channels,
      nowNextFor: (channel) => ({
        current: { title: titles.get(String(channel.id)) ?? "", start: 0, stop: 1, desc: "" },
        next: null,
      }),
    });
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    handle.highlightChannel(channels[80]!.id, { focus: true });
    const highlightedId = handle.getHighlightedId();
    const scrollTop = list.scrollTop;
    const rowBefore = root.querySelector<HTMLElement>(
      `[data-browser-row][data-channel-id="${channels[80]!.id}"]`,
    )!;
    expect(rowBefore.textContent).toContain(`Old programme for ${channels[80]!.displayName}`);
    // EPG refresh: same channels, new programme titles.
    for (const channel of channels) {
      titles.set(String(channel.id), `New programme for ${channel.displayName}`);
    }
    handle.setChannels([...channels]);
    expect(handle.getHighlightedId()).toBe(highlightedId);
    expect(list.scrollTop).toBe(scrollTop);
    const rowAfter = root.querySelector<HTMLElement>(
      `[data-browser-row][data-channel-id="${channels[80]!.id}"]`,
    )!;
    expect(rowAfter).toBe(rowBefore);
    expect(rowAfter.textContent).toContain(`New programme for ${channels[80]!.displayName}`);
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
