/**
 * Live TV 2.0 navigation model tests (0.11.7, W4): the pure stack
 * operations, the controller's one-layer-per-B semantics, hidden
 * layers never receiving input, entry/exit/focus hooks, preserved
 * state across re-entry, and the `livetv:back` routing guards.
 * DOM-free: controllers are built with an explicit EventTarget
 * and no document, so these run in the node environment.
 */
import { describe, it, expect, vi } from "vitest";
import {
  LIVETV_NAV_CHANGE_EVENT,
  createLivetvNavController,
  createLivetvNavStack,
  installTopLayerBackGuard,
  isLivetvNavLayerId,
  navHas,
  navIsTop,
  navLayerIds,
  navPop,
  navPopTo,
  navPush,
  navReplace,
  navTop,
  type LivetvNavChangeDetail,
  type LivetvNavLayer,
} from "@/scripts/lib/livetv-nav";

function layer(id: LivetvNavLayer["id"], extra: Partial<LivetvNavLayer> = {}): LivetvNavLayer {
  return { id, ...extra };
}

function isolated() {
  const target = new EventTarget();
  const controller = createLivetvNavController(createLivetvNavStack(), {
    document: null,
    eventTarget: target,
  });
  return { target, controller };
}

describe("layer ids", () => {
  it("recognises all eight layers and rejects anything else", () => {
    for (const id of ["landing", "browser", "drawer", "subcategory", "search", "sort", "guide", "playback"]) {
      expect(isLivetvNavLayerId(id)).toBe(true);
    }
    expect(isLivetvNavLayerId("home")).toBe(false);
    expect(isLivetvNavLayerId("options")).toBe(false);
    expect(isLivetvNavLayerId(null)).toBe(false);
    expect(isLivetvNavLayerId(42)).toBe(false);
  });
});

describe("pure stack operations", () => {
  it("starts on landing", () => {
    expect(navLayerIds(createLivetvNavStack())).toEqual(["landing"]);
    expect(navTop(createLivetvNavStack())?.id).toBe("landing");
  });

  it("push appends and never mutates the input", () => {
    const base = createLivetvNavStack();
    const next = navPush(base, layer("browser"));
    expect(navLayerIds(next)).toEqual(["landing", "browser"]);
    expect(navLayerIds(base)).toEqual(["landing"]);
    expect(navTop(next)?.id).toBe("browser");
  });

  it("pushing the same id+key replaces in place instead of duplicating", () => {
    const stack = navPush(navPush(createLivetvNavStack(), layer("browser")), layer("drawer"));
    const replaced = navPush(stack, layer("drawer", { context: { fresh: true } }));
    expect(navLayerIds(replaced)).toEqual(["landing", "browser", "drawer"]);
    expect(navTop(replaced)?.context).toEqual({ fresh: true });
    expect(navLayerIds(stack)).toEqual(["landing", "browser", "drawer"]);
  });

  it("pushing the same id with a distinct key stacks a second entry", () => {
    const stack = navPush(createLivetvNavStack(), layer("search", { key: "a" }));
    const next = navPush(stack, layer("search", { key: "b" }));
    expect(navLayerIds(next)).toEqual(["landing", "search", "search"]);
  });

  it("pop removes exactly the top layer", () => {
    const stack = navPush(navPush(createLivetvNavStack(), layer("browser")), layer("drawer"));
    const { stack: next, popped } = navPop(stack);
    expect(popped?.id).toBe("drawer");
    expect(navLayerIds(next)).toEqual(["landing", "browser"]);
    expect(navLayerIds(stack)).toEqual(["landing", "browser", "drawer"]);
  });

  it("pop on an empty stack returns null and the same stack", () => {
    const { stack, popped } = navPop([]);
    expect(popped).toBeNull();
    expect(stack).toEqual([]);
  });

  it("replace swaps the top layer at the same depth", () => {
    const stack = navPush(createLivetvNavStack(), layer("browser"));
    const { stack: next, replaced } = navReplace(stack, layer("guide"));
    expect(replaced?.id).toBe("browser");
    expect(navLayerIds(next)).toEqual(["landing", "guide"]);
  });

  it("popTo removes everything above the named layer", () => {
    const stack = ["browser", "drawer", "subcategory", "search"].reduce(
      (acc, id) => navPush(acc, layer(id as LivetvNavLayer["id"])),
      createLivetvNavStack(),
    );
    const { stack: next, popped } = navPopTo(stack, "browser");
    expect(navLayerIds(next)).toEqual(["landing", "browser"]);
    expect(popped.map((entry) => entry.id)).toEqual(["drawer", "subcategory", "search"]);
  });

  it("popTo is a no-op when the layer is not on the stack", () => {
    const stack = navPush(createLivetvNavStack(), layer("browser"));
    const { stack: next, popped } = navPopTo(stack, "guide");
    expect(next).toBe(stack);
    expect(popped).toEqual([]);
  });

  it("navIsTop / navHas answer the input-gate questions", () => {
    const stack = navPush(navPush(createLivetvNavStack(), layer("browser")), layer("drawer"));
    expect(navIsTop(stack, "drawer")).toBe(true);
    expect(navIsTop(stack, "browser")).toBe(false);
    expect(navHas(stack, "browser")).toBe(true);
    expect(navHas(stack, "guide")).toBe(false);
  });
});

describe("controller: one layer per B", () => {
  it("each back() pops exactly one layer, in stack order", () => {
    const { controller } = isolated();
    controller.push(layer("browser"));
    controller.push(layer("drawer"));
    controller.push(layer("search"));
    expect(controller.layerIds()).toEqual(["landing", "browser", "drawer", "search"]);
    expect(controller.back()).toBe(true);
    expect(controller.layerIds()).toEqual(["landing", "browser", "drawer"]);
    expect(controller.back()).toBe(true);
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
    expect(controller.back()).toBe(true);
    expect(controller.layerIds()).toEqual(["landing"]);
  });

  it("back() on a lone landing layer declines and never empties the stack", () => {
    const { controller } = isolated();
    expect(controller.back()).toBe(false);
    expect(controller.layerIds()).toEqual(["landing"]);
    expect(controller.back()).toBe(false);
    expect(controller.layerIds()).toEqual(["landing"]);
  });

  it("back() on an empty stack declines", () => {
    const controller = createLivetvNavController([], { document: null, eventTarget: new EventTarget() });
    expect(controller.back()).toBe(false);
    expect(controller.layerIds()).toEqual([]);
  });

  it("only the top layer's onBack is consulted", () => {
    const { controller } = isolated();
    const browserBack = vi.fn(() => true);
    const drawerBack = vi.fn(() => true);
    controller.push(layer("browser", { onBack: browserBack }));
    controller.push(layer("drawer", { onBack: drawerBack }));
    controller.back();
    expect(drawerBack).toHaveBeenCalledTimes(1);
    expect(browserBack).not.toHaveBeenCalled();
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
  });

  it("an onBack veto consumes B without popping anything", () => {
    const { controller } = isolated();
    controller.push(layer("browser"));
    controller.push(layer("search", { onBack: () => false }));
    expect(controller.back()).toBe(true);
    expect(controller.layerIds()).toEqual(["landing", "browser", "search"]);
  });

  it("a throwing onBack never wedges navigation: the layer still pops", () => {
    const { controller } = isolated();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      controller.push(layer("browser"));
      controller.push(
        layer("drawer", {
          onBack: () => {
            throw new Error("boom");
          },
        }),
      );
      expect(controller.back()).toBe(true);
      expect(controller.layerIds()).toEqual(["landing", "browser"]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("controller: hidden layers never receive input", () => {
  it("isTop gates per-surface handlers: only the top acts", () => {
    const { controller } = isolated();
    const acted: string[] = [];
    const browserHandler = () => {
      if (controller.isTop("browser")) acted.push("browser");
    };
    const drawerHandler = () => {
      if (controller.isTop("drawer")) acted.push("drawer");
    };
    controller.push(layer("browser"));
    controller.push(layer("drawer"));
    // Both handlers "hear" the key; only the top one acts.
    browserHandler();
    drawerHandler();
    expect(acted).toEqual(["drawer"]);
    controller.back();
    browserHandler();
    drawerHandler();
    expect(acted).toEqual(["drawer", "browser"]);
  });

  it("central back routing consumes B once and stops hidden handlers", () => {
    const { target, controller } = isolated();
    controller.push(layer("browser"));
    controller.push(layer("drawer"));
    const uninstall = controller.installBackRouting(target);
    const hiddenHandler = vi.fn();
    // A per-surface handler registered AFTER the router (the
    // browser's own livetv:back listener, pre-unification).
    target.addEventListener("livetv:back", hiddenHandler);
    target.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "browser" } }));
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
    expect(hiddenHandler).not.toHaveBeenCalled();
    uninstall();
  });

  it("central back routing lets B through on a lone landing layer", () => {
    const { target, controller } = isolated();
    const uninstall = controller.installBackRouting(target);
    const shellHandler = vi.fn();
    target.addEventListener("livetv:back", shellHandler);
    target.dispatchEvent(new CustomEvent("livetv:back", { detail: { context: "landing" } }));
    expect(shellHandler).toHaveBeenCalledTimes(1);
    expect(controller.layerIds()).toEqual(["landing"]);
    uninstall();
  });

  it("re-installing back routing never double-attaches", () => {
    const { target, controller } = isolated();
    controller.push(layer("browser"));
    controller.push(layer("drawer"));
    controller.installBackRouting(target);
    controller.installBackRouting(target);
    target.dispatchEvent(new CustomEvent("livetv:back", { detail: {} }));
    // One B press, one pop — not two.
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
    controller.uninstallBackRouting();
  });

  it("top-layer back guard ignores B while its layer is hidden", () => {
    const { target, controller } = isolated();
    controller.push(layer("browser"));
    const uninstall = installTopLayerBackGuard(controller, "search", target);
    const after = vi.fn();
    target.addEventListener("livetv:back", after);
    target.dispatchEvent(new CustomEvent("livetv:back", { detail: {} }));
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
    expect(after).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("top-layer back guard consumes B once while its layer is top", () => {
    const { target, controller } = isolated();
    controller.push(layer("browser"));
    controller.push(layer("search"));
    const uninstall = installTopLayerBackGuard(controller, "search", target);
    const after = vi.fn();
    target.addEventListener("livetv:back", after);
    target.dispatchEvent(new CustomEvent("livetv:back", { detail: {} }));
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
    expect(after).not.toHaveBeenCalled();
    uninstall();
  });
});

describe("controller: hooks and preserved state", () => {
  it("runs onEnter on push, onExit + onReveal on pop, in order", () => {
    const { controller } = isolated();
    const calls: string[] = [];
    controller.push(
      layer("browser", {
        onEnter: () => calls.push("browser:enter"),
        onReveal: () => calls.push("browser:reveal"),
      }),
    );
    controller.push(
      layer("drawer", {
        onEnter: () => calls.push("drawer:enter"),
        onExit: () => calls.push("drawer:exit"),
      }),
    );
    expect(calls).toEqual(["browser:enter", "drawer:enter"]);
    controller.pop();
    expect(calls).toEqual([
      "browser:enter",
      "drawer:enter",
      "drawer:exit",
      "browser:reveal",
    ]);
  });

  it("runs the focus-restore hook on pop, before the reveal", () => {
    const { controller } = isolated();
    const calls: string[] = [];
    controller.push(layer("browser", { onReveal: () => calls.push("reveal") }));
    controller.push(
      layer("search", {
        onFocusRestore: () => {
          calls.push("focus");
          return true;
        },
      }),
    );
    controller.pop();
    expect(calls).toEqual(["focus", "reveal"]);
  });

  it("a same-position re-push does not re-run onEnter", () => {
    const { controller } = isolated();
    const onEnter = vi.fn();
    controller.push(layer("browser"));
    controller.push(layer("drawer", { onEnter }));
    controller.push(layer("drawer", { onEnter }));
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(controller.layerIds()).toEqual(["landing", "browser", "drawer"]);
  });

  it("preserves category/selection/scroll across a pop and reattaches on push", () => {
    const { controller } = isolated();
    controller.push(
      layer("browser", {
        preserved: { categoryId: "sports", selectedId: "42", scrollTop: 760 },
      }),
    );
    controller.push(layer("drawer"));
    controller.pop(); // drawer pops; browser still on stack
    expect(controller.preservedFor("browser")).toBeNull();
    controller.pop(); // browser pops, preserving its state
    expect(controller.preservedFor("browser")).toEqual({
      categoryId: "sports",
      selectedId: "42",
      scrollTop: 760,
    });
    const entered: LivetvNavLayer[] = [];
    controller.push(layer("browser", { onEnter: (entry) => entered.push(entry) }));
    expect(entered[0]?.preserved).toEqual({
      categoryId: "sports",
      selectedId: "42",
      scrollTop: 760,
    });
    expect(controller.preservedFor("browser")).toBeNull();
  });

  it("replace runs exit + enter hooks and keeps the depth", () => {
    const { controller } = isolated();
    const calls: string[] = [];
    controller.push(layer("browser", { onExit: () => calls.push("browser:exit") }));
    controller.replace(layer("guide", { onEnter: () => calls.push("guide:enter") }));
    expect(calls).toEqual(["browser:exit", "guide:enter"]);
    expect(controller.layerIds()).toEqual(["landing", "guide"]);
  });

  it("popTo exits every popped layer and reveals the survivor once", () => {
    const { controller } = isolated();
    const calls: string[] = [];
    controller.push(layer("browser", { onReveal: () => calls.push("browser:reveal") }));
    controller.push(layer("drawer", { onExit: () => calls.push("drawer:exit") }));
    controller.push(layer("search", { onExit: () => calls.push("search:exit") }));
    const popped = controller.popTo("browser");
    expect(popped.map((entry) => entry.id)).toEqual(["search", "drawer"]);
    expect(calls).toEqual(["search:exit", "drawer:exit", "browser:reveal"]);
    expect(controller.layerIds()).toEqual(["landing", "browser"]);
  });

  it("reset exits removed layers and enters the new base", () => {
    const { controller } = isolated();
    const calls: string[] = [];
    controller.push(layer("browser", { onExit: () => calls.push("browser:exit") }));
    controller.push(layer("drawer", { onExit: () => calls.push("drawer:exit") }));
    controller.reset({ id: "landing", onEnter: () => calls.push("landing:enter") });
    expect(calls).toEqual(["drawer:exit", "browser:exit", "landing:enter"]);
    expect(controller.layerIds()).toEqual(["landing"]);
  });
});

describe("controller: notifications and mirrors", () => {
  it("notifies subscribers and dispatches livetv:nav-change on change", () => {
    const { target, controller } = isolated();
    const seen: LivetvNavChangeDetail[] = [];
    const unsubscribe = controller.subscribe((detail) => seen.push(detail));
    const events: LivetvNavChangeDetail[] = [];
    target.addEventListener(LIVETV_NAV_CHANGE_EVENT, (event) => {
      events.push((event as CustomEvent).detail as LivetvNavChangeDetail);
    });
    controller.push(layer("browser"));
    controller.push(layer("drawer"));
    controller.back();
    expect(seen.map((detail) => detail.top)).toEqual(["browser", "drawer", "browser"]);
    expect(seen[2]).toEqual({ top: "browser", stack: ["landing", "browser"], previousTop: "drawer" });
    expect(events).toEqual(seen);
    unsubscribe();
    controller.push(layer("guide"));
    expect(seen).toHaveLength(3);
  });

  it("mirrors the top layer to html[data-livetv-nav-layer]", () => {
    const dataset: Record<string, string | undefined> = {};
    const controller = createLivetvNavController(createLivetvNavStack(), {
      document: { documentElement: { dataset } },
      eventTarget: new EventTarget(),
    });
    expect(dataset["livetvNavLayer"]).toBe("landing");
    controller.push(layer("browser"));
    expect(dataset["livetvNavLayer"]).toBe("browser");
    controller.push(layer("search"));
    expect(dataset["livetvNavLayer"]).toBe("search");
    controller.back();
    expect(dataset["livetvNavLayer"]).toBe("browser");
  });
});
