/**
 * @vitest-environment jsdom
 *
 * Live TV 2.0 (0.11.7) W5 — RED VERIFICATION (mandatory).
 *
 * Each test below runs the SAME invariant the green tests assert,
 * but against a DELIBERATELY BROKEN variant in
 * ./stubs/broken/, and asserts the invariant FAILS there. If a
 * red test ever goes green, the green test it guards has lost
 * its power to catch the defect and must be fixed, not the red
 * test. Broken variants are deleted on integration with the
 * rest of the stubs.
 *
 *   R1 guards test 3  (work counters: rebuild/recompute on access)
 *   R2 guards test 4  (bounded DOM rows)
 *   R3 guards test 11 (B closes one layer)
 *   R4 guards test 10 (duplicate button events)
 *   R5 guards test 14 (EPG update resets focus)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LIVETV_GAMEPAD_BUTTONS } from "@/scripts/lib/livetv-keys";
import {
  getBrokenCategoryIndex,
  getBrokenDerivedChannels,
  getBrokenBuildCount,
  __resetBrokenCategoryIndexForTests,
} from "./stubs/broken/broken-category-index.stub";
import { createBrokenButtonEdgeTracker } from "./stubs/broken/broken-input-dedupe.stub";
import { createBrokenLivetvNavStack } from "./stubs/broken/broken-nav.stub";
import { mountBrokenVirtualList } from "./stubs/broken/broken-virtual-list.stub";
import { fixture2000 } from "./fixtures";

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
});

describe("R1 — broken index regroups on every access (guards test 3)", () => {
  beforeEach(() => {
    __resetBrokenCategoryIndexForTests();
  });

  it("RED: repeated getCategoryIndex calls rebuild every time", () => {
    const channels = fixture2000();
    getBrokenCategoryIndex(channels, 1);
    expect(getBrokenBuildCount()).toBe(1);
    for (let i = 0; i < 10; i++) getBrokenCategoryIndex(channels, 1);
    // The green invariant (build count stays 1) FAILS here: 11 builds.
    expect(getBrokenBuildCount()).toBe(11);
  });

  it("RED: scrolling recomputes the derived list on every access", () => {
    const channels = fixture2000();
    const index = getBrokenCategoryIndex(channels, 1);
    getBrokenDerivedChannels(index, { groupId: "sports" });
    expect(index.recomputeCount).toBe(1);
    for (let step = 0; step < 50; step++) {
      getBrokenDerivedChannels(index, { groupId: "sports" });
    }
    // The green invariant (recompute count stays 1) FAILS here.
    expect(index.recomputeCount).toBe(51);
  });
});

describe("R2 — broken list mounts every row (guards test 4)", () => {
  it("RED: 2,000 items mount 2,000 DOM rows", () => {
    const channels = fixture2000();
    const handle = mountBrokenVirtualList(root, {
      items: channels,
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
    });
    // The green invariant (mounted ≤ bound ~15) FAILS here.
    expect(handle.getMountedRowCount()).toBe(2000);
    handle.destroy();
  });
});

describe("R3 — broken nav pops two layers per B (guards test 11)", () => {
  it("RED: one back() drops two layers", () => {
    const stack = createBrokenLivetvNavStack("landing");
    stack.push("browser");
    stack.push("search");
    stack.push("sort");
    stack.back();
    // The green invariant (one layer per press) FAILS here.
    expect(stack.snapshot()).toEqual(["landing", "browser"]);
    expect(stack.depth()).toBe(2);
  });

  it("RED: back() pops through the root", () => {
    const stack = createBrokenLivetvNavStack("landing");
    stack.push("browser");
    stack.back();
    stack.back();
    // The green invariant (root never pops, depth ≥ 1) FAILS here.
    expect(stack.depth()).toBe(0);
  });
});

describe("R4 — broken tracker emits per sample (guards test 10)", () => {
  it("RED: one held LB press emits once per poll sample", () => {
    const tracker = createBrokenButtonEdgeTracker("browser");
    const emitted = [];
    for (let i = 0; i < 30; i++) {
      const result = tracker.feed({
        source: i % 2 === 0 ? "xinput" : "gamepad",
        button: LIVETV_GAMEPAD_BUTTONS.lb,
        pressed: true,
        atMs: 1000 + i * 16,
      });
      if (result) emitted.push(result);
    }
    // The green invariant (exactly one action) FAILS here: 30.
    expect(emitted).toHaveLength(30);
    expect(emitted.every((e) => e.action === "category-prev")).toBe(true);
  });
});

describe("R5 — broken list resets focus on EPG update (guards test 14)", () => {
  it("RED: an EPG update resets focus to the first row and scroll to top", () => {
    const channels = fixture2000();
    const handle = mountBrokenVirtualList(root, {
      items: channels,
      keyOf: (c) => String(c.id),
      labelOf: (c) => c.displayName,
    });
    for (let i = 0; i < 80; i++) handle.moveFocus(1);
    const focusedBefore = handle.getFocusedKey();
    expect(focusedBefore).toBe(String(channels[80]!.id));
    handle.setScrollTop(4000);
    handle.applyEpgUpdate(new Map([[focusedBefore!, "New programme"]]));
    // The green invariant (focus + scroll preserved) FAILS here.
    expect(handle.getFocusedKey()).toBe(String(channels[0]!.id));
    expect(handle.getScrollTop()).toBe(0);
    handle.destroy();
  });
});
