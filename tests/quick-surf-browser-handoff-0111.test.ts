/**
 * @vitest-environment jsdom
 *
 * Quick Surf → Channel Browser handoff (0.11.11 W2): the seam
 * contract with W1 (`quick-surf:open-browser` in, `quick-surf:close`
 * out first), the four actions reaching the real browser APIs with
 * the right arguments, the async-mount generation guard, and the
 * spurious-event no-op. Synthetic data only; nothing here plays a
 * stream or depends on W1's branch — the Quick Surf panel is a
 * minimal stub element.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  QUICK_SURF_CLOSE_EVENT,
  QUICK_SURF_OPEN_BROWSER_EVENT,
  installQuickSurfBrowserHandoff,
  isQuickSurfPanelOpen,
  type QuickSurfBrowserAdapter,
} from "@/scripts/lib/quick-surf-browser-handoff";
import {
  mountChannelBrowser,
  type ChannelBrowserHandle,
} from "@/scripts/lib/livetv-browser";
import { livetvNav } from "@/scripts/lib/livetv-nav";
import type { LivetvChannel } from "@/scripts/lib/livetv-data";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ── Fake handle: records calls and mimics setSelection's unknown-id
// fallback to "all" (the real browser's behaviour) ────────────────

const KNOWN_GROUPS = new Set(["all", "favourites", "recents", "sports", "news"]);

interface FakeHandleState {
  groupId: string;
  subcategoryId: string | null;
  highlightedId: string | number | null;
  drawerOpen: boolean;
  visibleByGroup: Record<string, LivetvChannel[]>;
}

function fakeChannel(id: number, name: string): LivetvChannel {
  return {
    id,
    name,
    displayName: name,
    logo: null,
    category: "",
    categoryId: "",
    categoryLabel: "",
    streamUrl: null,
    tvgId: null,
    chno: undefined,
    catchup: false,
    favourite: false,
    hidden: false,
    norm: name.toLowerCase(),
  };
}

function makeFakeHandle(visibleByGroup: Record<string, LivetvChannel[]>) {
  const state: FakeHandleState = {
    groupId: "all",
    subcategoryId: null,
    highlightedId: null,
    drawerOpen: false,
    visibleByGroup,
  };
  const calls = {
    setSelection: [] as Array<[string, string | null | undefined]>,
    applyEntry: [] as unknown[],
    openCategories: 0,
    closeCategories: 0,
    openSearch: 0,
    focusChannel: [] as Array<string | number>,
    getVisibleChannels: 0,
  };
  const applySelection = (groupId: string, subcategoryId: string | null) => {
    if (KNOWN_GROUPS.has(groupId)) {
      state.groupId = groupId;
      state.subcategoryId = subcategoryId;
    } else {
      state.groupId = "all";
      state.subcategoryId = null;
    }
  };
  const handle: ChannelBrowserHandle = {
    root: document.createElement("div"),
    setChannels: () => undefined,
    getHighlightedId: () => state.highlightedId,
    highlightChannel: (id) => {
      state.highlightedId = id;
    },
    focusChannel: (id) => {
      calls.focusChannel.push(id);
      state.highlightedId = id;
    },
    applyEntry: (entry) => {
      calls.applyEntry.push(entry);
      if (!entry) return;
      if (entry.kind === "favourites") applySelection("favourites", null);
      else if (entry.kind === "recents") applySelection("recents", null);
      else if (entry.kind === "category") applySelection(entry.value ?? "all", null);
      else applySelection("all", null);
    },
    openSearch: () => {
      calls.openSearch += 1;
    },
    openSort: () => undefined,
    closeSearch: () => false,
    isSearchOpen: () => false,
    getCategoryId: () => state.groupId,
    getSubcategoryId: () => state.subcategoryId,
    getSelection: () => ({ groupId: state.groupId, subcategoryId: state.subcategoryId }),
    setSelection: (groupId, subcategoryId) => {
      calls.setSelection.push([groupId, subcategoryId]);
      applySelection(groupId, subcategoryId ?? null);
    },
    getVisibleChannels: () => {
      calls.getVisibleChannels += 1;
      return state.visibleByGroup[state.groupId] ?? [];
    },
    cycleCategory: () => undefined,
    jumpPage: () => undefined,
    toggleFavouriteHighlighted: async () => null,
    openCategories: () => {
      calls.openCategories += 1;
      state.drawerOpen = true;
    },
    closeCategories: () => {
      calls.closeCategories += 1;
      state.drawerOpen = false;
    },
    isDrawerOpen: () => state.drawerOpen,
    destroy: () => undefined,
  };
  return { handle, calls, state };
}

// ── Fake adapter: controllable mount, presence and visibility ───

function makeFakeAdapter(opts: {
  qsPresent?: boolean;
  tunedId?: string | number | null;
  handle: ChannelBrowserHandle | null;
} = { handle: null }) {
  const mount = deferred<ChannelBrowserHandle | null>();
  const state = {
    qsPresent: opts.qsPresent ?? true,
    browserOpen: false,
    tunedId: opts.tunedId ?? null,
  };
  const calls = { openBrowser: 0, awaitHandle: 0, focusList: 0 };
  const adapter: QuickSurfBrowserAdapter = {
    isQuickSurfPresent: () => state.qsPresent,
    openBrowser: () => {
      calls.openBrowser += 1;
      state.browserOpen = true;
    },
    isBrowserOpen: () => state.browserOpen,
    awaitBrowserHandle: () => {
      calls.awaitHandle += 1;
      return mount.promise;
    },
    focusBrowserList: () => {
      calls.focusList += 1;
    },
    getTunedChannelId: () => state.tunedId,
  };
  return { adapter, calls, state, mount, resolveMount: () => mount.resolve(opts.handle) };
}

function dispatchOpen(target: EventTarget, detail: unknown) {
  target.dispatchEvent(
    new CustomEvent(QUICK_SURF_OPEN_BROWSER_EVENT, { detail }),
  );
}

const FAVS = [fakeChannel(2, "RTÉ One"), fakeChannel(3, "Sky Sports Main Event")];
const RECENTS = [fakeChannel(3, "Sky Sports Main Event"), fakeChannel(1, "BBC One")];
const ALL = [fakeChannel(1, "BBC One"), ...FAVS];

describe("quick-surf-browser-handoff (fake adapter)", () => {
  it("favourites: closes Quick Surf first, then applies the existing favourites filter and focuses a real row", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL, favourites: FAVS });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const order: string[] = [];
    target.addEventListener(QUICK_SURF_CLOSE_EVENT, () => order.push("close"));
    const origOpen = fake.adapter.openBrowser;
    fake.adapter.openBrowser = () => {
      order.push("open");
      origOpen();
    };
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "favourites", channelId: 3, categoryScope: null });
    // Nothing reaches the handle before the mount resolves.
    expect(handleCalls.applyEntry).toEqual([]);
    expect(handleCalls.focusChannel).toEqual([]);
    fake.resolveMount();
    await flush();
    expect(order).toEqual(["close", "open"]);
    expect(handleCalls.applyEntry).toEqual([{ kind: "favourites" }]);
    expect(handleCalls.focusChannel).toEqual([3]);
    expect(handleCalls.openSearch).toBe(0);
    expect(handleCalls.openCategories).toBe(0);
    handoff.dispose();
  });

  it("recents: applies the existing recents scope, keeps actual recent ordering, focuses the first recent", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL, recents: RECENTS });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "recents", channelId: null, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(handleCalls.applyEntry).toEqual([{ kind: "recents" }]);
    // Most-recent-first: Sky Sports (id 3) heads the recents list.
    expect(handleCalls.focusChannel).toEqual([3]);
    handoff.dispose();
  });

  it("categories: selects a known scope group, then opens the category drawer", async () => {
    const { handle, calls: handleCalls, state } = makeFakeHandle({ all: ALL, sports: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "categories", channelId: 1, categoryScope: "sports" });
    fake.resolveMount();
    await flush();
    expect(handleCalls.setSelection).toEqual([["sports", null]]);
    expect(handleCalls.openCategories).toBe(1);
    expect(state.groupId).toBe("sports");
    expect(handleCalls.applyEntry).toEqual([]);
    expect(handleCalls.focusChannel).toEqual([]);
    handoff.dispose();
  });

  it("categories: an unknown scope string leaves the current selection untouched and still opens the drawer", async () => {
    const { handle, calls: handleCalls, state } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "categories", channelId: 1, categoryScope: "UK | Sports" });
    fake.resolveMount();
    await flush();
    expect(handleCalls.openCategories).toBe(1);
    // The unknown id was attempted and the prior selection restored.
    expect(state.groupId).toBe("all");
    expect(handleCalls.setSelection).toEqual([
      ["UK | Sports", null],
      ["all", null],
    ]);
    handoff.dispose();
  });

  it("categories: no scope opens the drawer on the current group without reselecting", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "categories", channelId: 1, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(handleCalls.setSelection).toEqual([]);
    expect(handleCalls.openCategories).toBe(1);
    handoff.dispose();
  });

  it("search: calls the existing search action and nothing else", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "search", channelId: 1, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(handleCalls.openSearch).toBe(1);
    expect(handleCalls.applyEntry).toEqual([]);
    expect(handleCalls.focusChannel).toEqual([]);
    expect(handleCalls.openCategories).toBe(0);
    handoff.dispose();
  });

  it("no handle method is invoked before the mount resolves", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "favourites", channelId: 2, categoryScope: null });
    await flush();
    await flush();
    expect(handleCalls.applyEntry).toEqual([]);
    expect(handleCalls.focusChannel).toEqual([]);
    expect(handleCalls.openSearch).toBe(0);
    expect(fake.calls.openBrowser).toBe(1);
    fake.resolveMount();
    await flush();
    expect(handleCalls.applyEntry).toEqual([{ kind: "favourites" }]);
    handoff.dispose();
  });

  it("close-during-mount (cancelPending) leaves no reopened browser and applies nothing", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL, favourites: FAVS });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "favourites", channelId: 2, categoryScope: null });
    // The shell closes the browser while the mount is resolving.
    fake.state.browserOpen = false;
    handoff.cancelPending();
    fake.resolveMount();
    await flush();
    expect(handleCalls.applyEntry).toEqual([]);
    expect(handleCalls.focusChannel).toEqual([]);
    expect(handleCalls.openSearch).toBe(0);
    expect(handleCalls.openCategories).toBe(0);
    // Opened exactly once (the initial open); the late mount reopened nothing.
    expect(fake.calls.openBrowser).toBe(1);
    handoff.dispose();
  });

  it("close-during-mount (browser hidden, no cancel) still applies nothing", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "search", channelId: 1, categoryScope: null });
    fake.state.browserOpen = false;
    fake.resolveMount();
    await flush();
    expect(handleCalls.openSearch).toBe(0);
    handoff.dispose();
  });

  it("a mount resolving to null (no playlist) is a quiet no-op", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    void handle;
    const fake = makeFakeAdapter({ handle: null });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "favourites", channelId: 2, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(handleCalls.applyEntry).toEqual([]);
    expect(fake.calls.openBrowser).toBe(1);
    handoff.dispose();
  });

  it("a second request supersedes the first: only the latest action applies", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({
      all: ALL,
      favourites: FAVS,
      recents: RECENTS,
    });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "favourites", channelId: 2, categoryScope: null });
    dispatchOpen(target, { action: "recents", channelId: null, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(handleCalls.applyEntry).toEqual([{ kind: "recents" }]);
    expect(handleCalls.focusChannel).toEqual([3]);
    handoff.dispose();
  });

  it("spurious event with no Quick Surf present is a safe no-op", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle, qsPresent: false });
    const target = new EventTarget();
    const closeSpy = vi.fn();
    target.addEventListener(QUICK_SURF_CLOSE_EVENT, closeSpy);
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "favourites", channelId: 2, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(fake.calls.openBrowser).toBe(0);
    expect(fake.calls.awaitHandle).toBe(0);
    expect(handleCalls.applyEntry).toEqual([]);
    handoff.dispose();
  });

  it("unknown actions and malformed details are safe no-ops", async () => {
    const { handle } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "explode", channelId: 1, categoryScope: null });
    dispatchOpen(target, null);
    dispatchOpen(target, "favourites");
    dispatchOpen(target, {});
    await flush();
    expect(fake.calls.openBrowser).toBe(0);
    handoff.dispose();
  });

  it("the handoff dispatches nothing but quick-surf:close: no tune, no release, playback untouched", async () => {
    const { handle } = makeFakeHandle({ all: ALL, favourites: FAVS });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const seen: string[] = [];
    for (const type of ["quick-surf:close", "livetv:tune", "livetv:release", "livetv:mode", "livetv:back"]) {
      target.addEventListener(type, () => seen.push(type));
    }
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "favourites", channelId: 2, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(seen).toEqual(["quick-surf:close"]);
    handoff.dispose();
  });

  it("dispose stops listening and cancels a pending mount", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "search", channelId: 1, categoryScope: null });
    handoff.dispose();
    fake.resolveMount();
    await flush();
    expect(handleCalls.openSearch).toBe(0);
    dispatchOpen(target, { action: "search", channelId: 1, categoryScope: null });
    await flush();
    expect(fake.calls.openBrowser).toBe(1);
  });

  it("browse via the event opens the full browser and focuses the tuned row without filtering", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "browse", channelId: 1, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(handleCalls.applyEntry).toEqual([]);
    expect(handleCalls.openCategories).toBe(0);
    expect(handleCalls.focusChannel).toEqual([1]);
    handoff.dispose();
  });

  it("openFullBrowser (shell Y): works with Quick Surf closed, focuses the tuned channel", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle, qsPresent: false, tunedId: 1 });
    const target = new EventTarget();
    const closeSpy = vi.fn();
    target.addEventListener(QUICK_SURF_CLOSE_EVENT, closeSpy);
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    handoff.openFullBrowser();
    fake.resolveMount();
    await flush();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(fake.calls.openBrowser).toBe(1);
    expect(handleCalls.focusChannel).toEqual([1]);
    handoff.dispose();
  });

  it("openFullBrowser closes Quick Surf first when it is present", async () => {
    const { handle } = makeFakeHandle({ all: ALL });
    const fake = makeFakeAdapter({ handle, qsPresent: true, tunedId: 1 });
    const target = new EventTarget();
    const closeSpy = vi.fn();
    target.addEventListener(QUICK_SURF_CLOSE_EVENT, closeSpy);
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    handoff.openFullBrowser();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    fake.resolveMount();
    await flush();
    handoff.dispose();
  });

  it("an empty filtered list falls back to focusing the browser list", async () => {
    const { handle, calls: handleCalls } = makeFakeHandle({ all: ALL, favourites: [] });
    const fake = makeFakeAdapter({ handle });
    const target = new EventTarget();
    const handoff = installQuickSurfBrowserHandoff(fake.adapter, target);
    dispatchOpen(target, { action: "favourites", channelId: 2, categoryScope: null });
    fake.resolveMount();
    await flush();
    expect(handleCalls.applyEntry).toEqual([{ kind: "favourites" }]);
    expect(handleCalls.focusChannel).toEqual([]);
    expect(fake.calls.focusList).toBe(1);
    handoff.dispose();
  });
});

describe("isQuickSurfPanelOpen", () => {
  it("reads the stub panel's hidden state like the shell does", () => {
    const panel = document.createElement("section");
    panel.setAttribute("data-livetv-quicksurf", "");
    document.body.appendChild(panel);
    try {
      expect(isQuickSurfPanelOpen()).toBe(true);
      panel.hidden = true;
      expect(isQuickSurfPanelOpen()).toBe(false);
      panel.hidden = false;
      panel.dataset.hidden = "true";
      expect(isQuickSurfPanelOpen()).toBe(false);
    } finally {
      panel.remove();
    }
    expect(isQuickSurfPanelOpen()).toBe(false);
  });
});

// ── Real browser: the four actions against mountChannelBrowser ──

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

const REAL_CHANNELS = [
  ch({ id: 1, name: "BBC One", categoryId: "UK | General" }),
  ch({ id: 2, name: "RTÉ One", categoryId: "Ireland | General", favourite: true }),
  ch({ id: 3, name: "Sky Sports Main Event", categoryId: "UK | Sports", favourite: true }),
  ch({ id: 4, name: "TG4", categoryId: "Ireland | General" }),
  ch({ id: 5, name: "Sky News", categoryId: "UK | News" }),
];
const REAL_RECENT_IDS = [3, 1];

describe("quick-surf-browser-handoff (real Channel Browser)", () => {
  let container: HTMLElement;
  let qsPanel: HTMLElement;
  let mounted: ChannelBrowserHandle | null;
  let openCount: number;
  let handoff: ReturnType<typeof installQuickSurfBrowserHandoff> | null;

  beforeEach(() => {
    livetvNav.reset();
    sessionStorage.clear();
    container = document.createElement("div");
    container.hidden = true;
    document.body.appendChild(container);
    qsPanel = document.createElement("section");
    qsPanel.setAttribute("data-livetv-quicksurf", "");
    document.body.appendChild(qsPanel);
    mounted = null;
    openCount = 0;
    const adapter: QuickSurfBrowserAdapter = {
      isQuickSurfPresent: () => isQuickSurfPanelOpen(),
      openBrowser: () => {
        openCount += 1;
        container.hidden = false;
        if (!mounted) {
          mounted = mountChannelBrowser(container, {
            channels: REAL_CHANNELS,
            browserId: "playback",
            recentIds: REAL_RECENT_IDS,
            onClose: () => {
              container.hidden = true;
            },
          });
        }
      },
      isBrowserOpen: () => !container.hidden,
      awaitBrowserHandle: async () => mounted,
      focusBrowserList: () => {
        container.querySelector<HTMLElement>("[data-browser-list]")?.focus?.();
      },
      getTunedChannelId: () => 1,
    };
    handoff = installQuickSurfBrowserHandoff(adapter, window);
  });

  afterEach(() => {
    handoff?.dispose();
    handoff = null;
    mounted?.destroy();
    mounted = null;
    container.remove();
    qsPanel.remove();
    livetvNav.reset();
    sessionStorage.clear();
  });

  it("favourites reaches the real favourites selection and highlights the tuned favourite row", async () => {
    const tunes: unknown[] = [];
    const onTune = (ev: Event) => tunes.push((ev as CustomEvent).detail);
    window.addEventListener("livetv:tune", onTune);
    try {
      dispatchOpen(window, { action: "favourites", channelId: 3, categoryScope: null });
      await flush();
      expect(openCount).toBe(1);
      expect(mounted?.getSelection().groupId).toBe("favourites");
      expect(mounted?.getVisibleChannels().map((c) => c.id)).toEqual([2, 3]);
      expect(mounted?.getHighlightedId()).toBe(3);
      // Highlighting never tunes.
      expect(tunes).toEqual([]);
    } finally {
      window.removeEventListener("livetv:tune", onTune);
    }
  });

  it("recents reaches the real recents selection in most-recent-first order", async () => {
    dispatchOpen(window, { action: "recents", channelId: null, categoryScope: null });
    await flush();
    expect(mounted?.getSelection().groupId).toBe("recents");
    expect(mounted?.getVisibleChannels().map((c) => c.id)).toEqual([3, 1]);
    expect(mounted?.getHighlightedId()).toBe(3);
  });

  it("categories opens the real category drawer on the scoped group", async () => {
    dispatchOpen(window, { action: "categories", channelId: 1, categoryScope: "favourites" });
    await flush();
    expect(mounted?.getSelection().groupId).toBe("favourites");
    expect(mounted?.isDrawerOpen()).toBe(true);
  });

  it("categories with an unknown scope keeps the current selection and still opens the drawer", async () => {
    dispatchOpen(window, { action: "categories", channelId: 1, categoryScope: "UK | Sports" });
    await flush();
    expect(mounted?.getSelection().groupId).toBe("all");
    expect(mounted?.isDrawerOpen()).toBe(true);
  });

  it("search dispatches the existing livetv:open-search request for BBC One / RTÉ One / Sky Sports lookup", async () => {
    const seen: unknown[] = [];
    const onSearch = (ev: Event) => seen.push((ev as CustomEvent).detail);
    window.addEventListener("livetv:open-search", onSearch);
    try {
      dispatchOpen(window, { action: "search", channelId: 1, categoryScope: null });
      await flush();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ groupId: "all", query: "" });
      // Search changes no selection.
      expect(mounted?.getSelection().groupId).toBe("all");
    } finally {
      window.removeEventListener("livetv:open-search", onSearch);
    }
  });

  it("spurious event with the panel hidden opens nothing", async () => {
    qsPanel.hidden = true;
    dispatchOpen(window, { action: "favourites", channelId: 2, categoryScope: null });
    await flush();
    expect(openCount).toBe(0);
    expect(mounted).toBeNull();
  });

  it("openFullBrowser focuses the tuned channel's row in the unfiltered browser", async () => {
    handoff?.openFullBrowser();
    await flush();
    expect(openCount).toBe(1);
    expect(mounted?.getSelection().groupId).toBe("all");
    expect(mounted?.getHighlightedId()).toBe(1);
  });

  it("Back-exit via the browser's Close control hides the overlay with no tune (stream preserved)", async () => {
    const tunes: unknown[] = [];
    const onTune = (ev: Event) => tunes.push((ev as CustomEvent).detail);
    window.addEventListener("livetv:tune", onTune);
    try {
      dispatchOpen(window, { action: "favourites", channelId: 3, categoryScope: null });
      await flush();
      expect(container.hidden).toBe(false);
      // The browser's Close control is the onClose path the shell
      // wires to closeBrowser (the same exit B takes from the
      // browser overlay): hide, no tune, tuned stream intact.
      const closeBtn = container.querySelector<HTMLElement>("[data-browser-close]");
      expect(closeBtn).not.toBeNull();
      closeBtn?.click();
      expect(container.hidden).toBe(true);
      expect(tunes).toEqual([]);
    } finally {
      window.removeEventListener("livetv:tune", onTune);
    }
  });
});
