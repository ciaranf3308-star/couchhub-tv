/**
 * @vitest-environment jsdom
 *
 * Controller Experience 2.0 (0.11.10, W4 — Live TV navigation):
 * focused tests for NEW/CHANGED behaviour only.
 *
 * Covered here: Guide/playback origin resolution, landing key
 * resolution + options-menu Back behaviour, the category drawer
 * B-layer sequence and LB/RB no-apply rule (mounted drawer AND
 * full browser mount through the nav-stack veto), the browser's
 * remembered-highlight scroll repair, filter-less entry keeping
 * the selection, close-overlay focus restore, the two-step nav
 * veto mechanism the search overlay's B hierarchy relies on, and
 * the SHIM-0110 seam contracts (hints / logical view / keyboard).
 *
 * Deliberately NOT duplicated: the onTabRow resolver table and
 * stepHighlight (tests/livetv-controller.test.ts), the single
 * onBack veto (tests/livetv-nav.test.ts), the drawer reducer
 * (tests/livetv-browser-0117.test.ts). Astro component scripts
 * (Guide keydown, playback shell, Quick Surf, overlays) are not
 * importable in vitest — their wiring is verified by render and
 * code review, not unit tests. Synthetic data only; nothing here
 * plays a stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BROWSER_ROW_HEIGHT,
  LIVETV_OPEN_SEARCH_EVENT,
  mountChannelBrowser,
} from "@/scripts/lib/livetv-browser";
import {
  drawerInitialState,
  mountCategoryDrawer,
  type DrawerGroup,
} from "@/scripts/lib/livetv-category-drawer";
import {
  livetvNav,
  resolveGuideOrigin,
  resolvePlaybackOrigin,
} from "@/scripts/lib/livetv-nav";
import {
  closeLandingOptions,
  handleLandingBack,
  isLandingOptionsMenuOpen,
  openLandingOptions,
  resolveLandingKeyAction,
} from "@/scripts/lib/livetv-landing";
import {
  CONTROLLER_HINTS_EVENT,
  LOGICAL_VIEW_EVENT,
  closeCouchKeyboard,
  getControllerHints,
  getLogicalView,
  isCouchKeyboardOpen,
  openCouchKeyboard,
  setControllerHints,
  setLogicalView,
} from "@/scripts/lib/livetv-0110-seams";
import { hintsForLivetvLayer } from "@/scripts/lib/livetv-hints";
import { dispatchLivetvCloseOverlay } from "@/scripts/lib/livetv-search-sort";
import type { LivetvChannel } from "@/scripts/lib/livetv-data";

function ch(partial: Partial<LivetvChannel> & { id: string | number; name: string }): LivetvChannel {
  const rawCategory = partial.categoryId ?? partial.category ?? "";
  return {
    displayName: partial.name,
    logo: null,
    category: rawCategory,
    categoryId: rawCategory,
    categoryLabel: partial.categoryLabel ?? rawCategory,
    streamUrl: null,
    tvgId: null,
    chno: undefined,
    catchup: false,
    favourite: false,
    hidden: false,
    norm: (partial.name + " " + rawCategory).toLowerCase(),
    ...partial,
  };
}

const CHANNELS = [
  ch({ id: 1, name: "Zebra News", categoryId: "News" }),
  ch({ id: 2, name: "Alpha Sports", categoryId: "UK | Sports", favourite: true }),
  ch({ id: 3, name: "Mid Movies", categoryId: "Movies" }),
  ch({ id: 4, name: "Beta Sports", categoryId: "Sports HD", favourite: true }),
  ch({ id: 5, name: "Gamma Sports", categoryId: "UK | Sports" }),
];

function keyOn(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function keyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

const GROUPS: DrawerGroup[] = [
  { id: "favourites", label: "Favourites", count: 2, icon: "★", opensSubcategories: false, subcategories: [] },
  {
    id: "sports",
    label: "Sports",
    count: 3,
    icon: "◉",
    opensSubcategories: true,
    subcategories: [
      { id: "UK | Sports", label: "UK | Sports", count: 2 },
      { id: "Sports HD", label: "Sports HD", count: 1 },
    ],
  },
  { id: "all", label: "All Channels", count: 5, icon: "▦", opensSubcategories: false, subcategories: [] },
];

describe("origin resolution (0.11.10 W4 §11/§12)", () => {
  it("resolveGuideOrigin: the invoker mount wins over persisted mode", () => {
    // Persisted mode may already read "guide" by activation time;
    // the live mount is the truth about where the user came from.
    expect(resolveGuideOrigin("browser", "guide", false)).toBe("browser");
    expect(resolveGuideOrigin("browser", "playback", true)).toBe("browser");
    expect(resolveGuideOrigin("playback", "landing", false)).toBe("playback");
    expect(resolveGuideOrigin("landing", "playback", true)).toBe("landing");
  });

  it("resolveGuideOrigin: persisted mode, then tuned session, then landing", () => {
    expect(resolveGuideOrigin(null, "browser", false)).toBe("browser");
    expect(resolveGuideOrigin("guide", "browser", false)).toBe("browser");
    expect(resolveGuideOrigin(null, "home", false)).toBe("landing");
    expect(resolveGuideOrigin(null, "guide", true)).toBe("playback");
    expect(resolveGuideOrigin(null, null, false)).toBe("landing");
    expect(resolveGuideOrigin(null, undefined, false)).toBe("landing");
  });

  it("resolvePlaybackOrigin: browser and guide survive, everything else lands", () => {
    expect(resolvePlaybackOrigin("browser")).toBe("browser");
    expect(resolvePlaybackOrigin("guide")).toBe("guide");
    expect(resolvePlaybackOrigin("landing")).toBe("landing");
    expect(resolvePlaybackOrigin("home")).toBe("landing");
    expect(resolvePlaybackOrigin(null)).toBe("landing");
    expect(resolvePlaybackOrigin(undefined)).toBe("landing");
    expect(resolvePlaybackOrigin("playback")).toBe("landing");
  });
});

describe("landing keys + options menu (0.11.10 W4 §7)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    livetvNav.reset();
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    closeLandingOptions(document);
    root.remove();
    livetvNav.reset();
  });

  it("resolveLandingKeyAction: Y/G guide, M options, Escape back, X hero-only", () => {
    expect(resolveLandingKeyAction("y", false)).toBe("guide");
    expect(resolveLandingKeyAction("G", false)).toBe("guide");
    expect(resolveLandingKeyAction("m", false)).toBe("options");
    expect(resolveLandingKeyAction("Escape", false)).toBe("back");
    expect(resolveLandingKeyAction("Backspace", false)).toBe("back");
    expect(resolveLandingKeyAction("x", true)).toBe("guide");
    // X outside the hero is deliberately nothing — no
    // unadvertised action fires in the background.
    expect(resolveLandingKeyAction("x", false)).toBeNull();
    expect(resolveLandingKeyAction("ArrowDown", true)).toBeNull();
    expect(resolveLandingKeyAction("Enter", true)).toBeNull();
    expect(resolveLandingKeyAction(null, false)).toBeNull();
  });

  it("openLandingOptions builds the action list and reports open", () => {
    // Without a hero channel there is nothing to continue:
    // the Continue action is omitted (never a dead button).
    const closeNoHero = openLandingOptions(root);
    expect(isLandingOptionsMenuOpen()).toBe(true);
    const menu = root.querySelector("[data-landing-options]");
    expect(menu?.getAttribute("role")).toBe("dialog");
    const labelsNoHero = [...root.querySelectorAll("[data-landing-action]")].map(
      (b) => b.getAttribute("data-landing-action"),
    );
    expect(labelsNoHero).toEqual(["favourites", "recent", "all", "guide", "search"]);
    expect(root.querySelector("[data-landing-options-close]")).not.toBeNull();
    // First action takes focus on open.
    expect(document.activeElement?.getAttribute("data-landing-action")).toBe("favourites");
    closeNoHero();
    expect(isLandingOptionsMenuOpen()).toBe(false);
    expect(root.querySelector("[data-landing-options]")).toBeNull();

    // With a hero channel, Continue leads the list.
    const close = openLandingOptions(root, () => 7);
    const labels = [...root.querySelectorAll("[data-landing-action]")].map(
      (b) => b.getAttribute("data-landing-action"),
    );
    expect(labels).toEqual(["continue", "favourites", "recent", "all", "guide", "search"]);
    expect(document.activeElement?.getAttribute("data-landing-action")).toBe("continue");
    close();
    expect(isLandingOptionsMenuOpen()).toBe(false);
  });

  it("a menu action dispatches its mode event and closes the menu", () => {
    const seen: Array<Record<string, unknown>> = [];
    const onMode = (event: Event) => {
      seen.push({ ...(event as CustomEvent).detail });
    };
    window.addEventListener("livetv:mode", onMode);
    try {
      openLandingOptions(root);
      const guide = root.querySelector<HTMLElement>('[data-landing-action="guide"]')!;
      guide.click();
      expect(isLandingOptionsMenuOpen()).toBe(false);
      expect(seen).toEqual([{ mode: "guide" }]);
    } finally {
      window.removeEventListener("livetv:mode", onMode);
    }
  });

  it("closing the menu returns focus to the opener", () => {
    const opener = document.createElement("button");
    opener.textContent = "opener";
    root.appendChild(opener);
    opener.focus();
    const close = openLandingOptions(root);
    expect(document.activeElement).not.toBe(opener);
    close();
    expect(document.activeElement).toBe(opener);
  });

  it("handleLandingBack does NOT navigate while the options menu is open", () => {
    const navigate = vi.fn();
    openLandingOptions(root);
    expect(handleLandingBack(null, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    closeLandingOptions(root);
    expect(handleLandingBack(null, navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("handleLandingBack ignores other contexts and non-landing layers", () => {
    const navigate = vi.fn();
    expect(handleLandingBack({ detail: { context: "browser" } }, navigate)).toBe(false);
    livetvNav.push({ id: "browser", key: "w4-test-browser" });
    expect(handleLandingBack(null, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("focus leaving the open menu is pulled back inside (containment)", () => {
    const outside = document.createElement("button");
    outside.textContent = "outside";
    root.appendChild(outside);
    openLandingOptions(root);
    const menu = root.querySelector("[data-landing-options]")!;
    expect(menu.contains(document.activeElement)).toBe(true);
    // Spatial nav is geometric and cannot see the scrim: focus
    // escaping to a landing tile behind the menu must return.
    outside.focus();
    expect(menu.contains(document.activeElement)).toBe(true);
    closeLandingOptions(root);
    // After close the guard is gone: focus is free to leave.
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });
});

describe("category drawer LB/RB + B-layer sequence (0.11.10 W4 §9)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    livetvNav.reset();
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    livetvNav.reset();
  });

  it("LB/RB ([ / ]) move one item and never apply the category", () => {
    const onSelect = vi.fn();
    const handle = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "favourites",
      onSelect,
      onBack: () => {},
    });
    expect(handle.getFocusedGroupId()).toBe("favourites");
    // "]" is RB / category-next: moves focus, applies nothing.
    expect(handle.handleKey(keyEvent("]"))).toBe(true);
    expect(handle.getFocusedGroupId()).toBe("sports");
    expect(onSelect).not.toHaveBeenCalled();
    // "[" is LB / category-prev: moves back, applies nothing.
    expect(handle.handleKey(keyEvent("["))).toBe(true);
    expect(handle.getFocusedGroupId()).toBe("favourites");
    expect(onSelect).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("B drills back subs → groups → close, without selecting", () => {
    const onSelect = vi.fn();
    const onBack = vi.fn();
    const handle = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "sports",
      onSelect,
      onBack,
    });
    // Enter on the Sports group drills into subcategories.
    handle.handleKey(keyEvent("Enter"));
    expect(handle.getLevel()).toBe("subcategories");
    expect(onSelect).not.toHaveBeenCalled();
    // First B: subs → groups, still open.
    handle.pressBack();
    expect(handle.getLevel()).toBe("groups");
    expect(onBack).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    // Second B: groups → close.
    handle.pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    handle.destroy();
  });

  it("the drawer carries no inline hints line (one hints bar owns legends)", () => {
    const handle = mountCategoryDrawer(root, {
      groups: GROUPS,
      selectedGroupId: "all",
      onSelect: () => {},
      onBack: () => {},
    });
    expect(root.querySelector(".rs-tv-category-drawer__hints")).toBeNull();
    handle.destroy();
  });

  it("drawerInitialState focuses the applied group on entry", () => {
    expect(drawerInitialState(GROUPS, "sports").groupIndex).toBe(1);
    expect(drawerInitialState(GROUPS, null).groupIndex).toBe(0);
  });

  it("full browser mount: nav B vetoes at subs, pops at groups, highlight preserved", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.setSelection("sports");
    handle.highlightChannel(2);
    expect(handle.getHighlightedId()).toBe(2);
    handle.openCategories();
    expect(handle.isDrawerOpen()).toBe(true);
    expect(livetvNav.topId()).toBe("drawer");
    // Enter drills into Sports subcategories (focus starts on
    // the applied Sports group).
    const focused = document.activeElement as HTMLElement;
    keyOn(focused, "Enter");
    // First nav B: the drawer layer's onBack vetoes (subs →
    // groups), the layer stays, the drawer stays open.
    expect(livetvNav.back()).toBe(true);
    expect(livetvNav.topId()).toBe("drawer");
    expect(handle.isDrawerOpen()).toBe(true);
    // Second nav B: groups level pops the layer and the drawer
    // closes — without changing the selection or highlight.
    expect(livetvNav.back()).toBe(true);
    expect(handle.isDrawerOpen()).toBe(false);
    expect(handle.getSelection().groupId).toBe("sports");
    expect(handle.getHighlightedId()).toBe(2);
    handle.destroy();
  });
});

describe("browser selection + focus (0.11.10 W4 §8/§10)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    livetvNav.reset();
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    livetvNav.reset();
  });

  it("returning to a selection scrolls its remembered deep highlight into view", () => {
    const many: LivetvChannel[] = [];
    for (let i = 1; i <= 60; i++) {
      many.push(ch({ id: i, name: `Channel ${String(i).padStart(2, "0")}`, categoryId: "News" }));
    }
    many.push(ch({ id: 61, name: "Solo Sports", categoryId: "Sports" }));
    const handle = mountChannelBrowser(root, { channels: many });
    const listEl = root.querySelector<HTMLElement>("[data-browser-list]")!;
    handle.highlightChannel(50);
    handle.setSelection("sports");
    // Leaving for Sports resets the scroll (no memory there).
    expect(listEl.scrollTop).toBe(0);
    handle.setSelection("all");
    expect(handle.getHighlightedId()).toBe(50);
    const visible = handle.getVisibleChannels();
    const index = visible.findIndex((c) => String(c.id) === "50");
    expect(index).toBeGreaterThan(0);
    const top = index * BROWSER_ROW_HEIGHT;
    const bottom = top + BROWSER_ROW_HEIGHT;
    // The remembered row is inside the visible window (jsdom
    // reports clientHeight 0, so the window is the 600px
    // fallback) — before the fix scrollTop stayed 0 and the
    // highlight sat off-screen.
    expect(listEl.scrollTop).toBeGreaterThan(0);
    expect(top).toBeGreaterThanOrEqual(listEl.scrollTop);
    expect(bottom).toBeLessThanOrEqual(listEl.scrollTop + 600);
    handle.destroy();
  });

  it("applyEntry with no filter keeps the selection (a return, not a reset)", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.setSelection("sports");
    handle.highlightChannel(5);
    handle.applyEntry(undefined);
    expect(handle.getSelection().groupId).toBe("sports");
    expect(handle.getHighlightedId()).toBe(5);
    handle.applyEntry(null);
    expect(handle.getSelection().groupId).toBe("sports");
    expect(handle.getHighlightedId()).toBe(5);
    // An explicit "all" still resets, as before.
    handle.applyEntry({ kind: "all" });
    expect(handle.getSelection().groupId).toBe("all");
    handle.destroy();
  });

  it("applyEntry with no filter still honours openSearch", () => {
    const seen: Array<Record<string, unknown>> = [];
    const onOpen = (event: Event) => {
      seen.push({ ...(event as CustomEvent).detail });
    };
    window.addEventListener(LIVETV_OPEN_SEARCH_EVENT, onOpen);
    try {
      const handle = mountChannelBrowser(root, { channels: CHANNELS });
      handle.setSelection("sports");
      handle.applyEntry(undefined, { openSearch: true });
      expect(handle.getSelection().groupId).toBe("sports");
      expect(seen).toHaveLength(1);
      handle.destroy();
    } finally {
      window.removeEventListener(LIVETV_OPEN_SEARCH_EVENT, onOpen);
    }
  });

  it("close-overlay (search cancel) refocuses the list / highlighted row", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    handle.highlightChannel(2, { focus: true });
    const row = document.activeElement as HTMLElement;
    expect(row.getAttribute("data-browser-row")).not.toBeNull();
    // Simulate the overlay having taken focus away: blur to body.
    row.blur();
    expect(document.activeElement).toBe(document.body);
    dispatchLivetvCloseOverlay(window, { overlay: "search", reason: "back" });
    const active = document.activeElement as HTMLElement;
    expect(active).not.toBe(document.body);
    expect(
      active.hasAttribute("data-browser-row") || active.hasAttribute("data-browser-list"),
    ).toBe(true);
    handle.destroy();
  });

  it("close-overlay for other overlays is ignored by the browser", () => {
    const handle = mountChannelBrowser(root, { channels: CHANNELS });
    (document.activeElement as HTMLElement | null)?.blur?.();
    dispatchLivetvCloseOverlay(window, { overlay: "sort", reason: "cancel" });
    // Sort close DOES refocus (same rule); an unknown overlay
    // name must not — dispatch one and confirm focus is
    // untouched from wherever the sort close left it.
    const afterSort = document.activeElement;
    dispatchLivetvCloseOverlay(window, {
      overlay: "something-else",
      reason: "back",
    } as never);
    expect(document.activeElement).toBe(afterSort);
    handle.destroy();
  });
});

describe("two-step nav veto (search B hierarchy mechanism, §10)", () => {
  beforeEach(() => livetvNav.reset());
  afterEach(() => livetvNav.reset());

  it("an editing veto consumes the first back; the second back pops", () => {
    let editing = true;
    const exits: string[] = [];
    livetvNav.push({
      id: "search",
      key: "w4-test-search",
      onBack: () => {
        if (editing) {
          editing = false;
          return false;
        }
        return true;
      },
      onExit: () => {
        exits.push("search");
      },
    });
    // First B: veto — the layer stays, no exit runs.
    expect(livetvNav.back()).toBe(true);
    expect(livetvNav.topId()).toBe("search");
    expect(exits).toEqual([]);
    // Second B: editing is over, the layer pops exactly once.
    expect(livetvNav.back()).toBe(true);
    expect(livetvNav.topId()).toBe("landing");
    expect(exits).toEqual(["search"]);
  });
});

describe("SHIM-0110 seam contracts (replaced by W1/W3 at integration)", () => {
  afterEach(() => {
    closeCouchKeyboard(false);
    delete document.documentElement.dataset.couchLogicalView;
  });

  it("setControllerHints dispatches the event and writes the hints list", () => {
    const list = document.createElement("ul");
    list.setAttribute("data-livetv-hints-list", "");
    document.body.appendChild(list);
    const seen: Array<Record<string, unknown>> = [];
    const onHints = (event: Event) => {
      seen.push({ ...(event as CustomEvent).detail });
    };
    window.addEventListener(CONTROLLER_HINTS_EVENT, onHints);
    try {
      const config = hintsForLivetvLayer("browser");
      setControllerHints(config);
      expect(seen).toHaveLength(1);
      expect((seen[0].config as { id?: string }).id).toBe(config.id);
      expect(list.children.length).toBeGreaterThan(0);
      expect(list.dataset.config).toBe(config.id);
    } finally {
      window.removeEventListener(CONTROLLER_HINTS_EVENT, onHints);
      list.remove();
    }
  });

  it("setLogicalView mirrors the view and dispatches the event", () => {
    const seen: string[] = [];
    const onView = (event: Event) => {
      seen.push((event as CustomEvent).detail.view as string);
    };
    window.addEventListener(LOGICAL_VIEW_EVENT, onView);
    try {
      setLogicalView("livetv-guide");
      expect(document.documentElement.dataset.couchLogicalView).toBe("livetv-guide");
      expect(seen).toEqual(["livetv-guide"]);
      expect(getLogicalView()).toBe("livetv-guide");
    } finally {
      window.removeEventListener(LOGICAL_VIEW_EVENT, onView);
    }
  });

  it("getControllerHints reads back the last config; null clears the bar", () => {
    const list = document.createElement("ul");
    list.setAttribute("data-livetv-hints-list", "");
    document.body.appendChild(list);
    try {
      const config = hintsForLivetvLayer("landing");
      setControllerHints(config);
      expect(getControllerHints()).toBe(config);
      expect(list.children.length).toBeGreaterThan(0);
      setControllerHints(null);
      expect(getControllerHints()).toBeNull();
      expect(list.children.length).toBe(0);
      expect(list.dataset.config).toBeUndefined();
    } finally {
      list.remove();
    }
  });

  it("keyboard lifecycle: open → commit-close runs onCommit; cancel-close does not", () => {
    const input = document.createElement("input");
    input.value = "sports";
    document.body.appendChild(input);
    try {
      const onCommit = vi.fn();
      expect(openCouchKeyboard(input, onCommit)).toBe(true);
      expect(isCouchKeyboardOpen()).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(closeCouchKeyboard(true)).toBe(true);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith("sports");
      expect(isCouchKeyboardOpen()).toBe(false);

      expect(openCouchKeyboard(input, onCommit)).toBe(true);
      expect(closeCouchKeyboard(false)).toBe(true);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(isCouchKeyboardOpen()).toBe(false);
      expect(closeCouchKeyboard(false)).toBe(false);
    } finally {
      input.remove();
    }
  });

  it("a keyboard record whose input left the document clears lazily", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    openCouchKeyboard(input);
    expect(isCouchKeyboardOpen()).toBe(true);
    input.remove();
    expect(isCouchKeyboardOpen()).toBe(false);
  });
});
