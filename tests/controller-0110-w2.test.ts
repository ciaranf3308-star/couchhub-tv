/**
 * @vitest-environment jsdom
 */
// Controller Experience 2.0 (0.11.10), W2 — focused tests for
// NEW/CHANGED behaviour only: Back-layer seams, route provenance,
// logical view, keyboard seam, hints routing, the Contract F X
// context menu, Browse X/B/Y behaviour, and Movies Home keys.
// Detail-page Back wiring is covered in
// controller-0110-w2-detail.test.ts (page modules need mocks).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  BACK_PRIORITY,
  handleCoordinatorEscape,
  installDetailBackLayers,
  registerBackLayer,
  resolveBack,
} from "@/scripts/lib/back-handler";
import {
  getControllerHints,
  setControllerHints,
} from "@/scripts/lib/couch-button-hints";
import { getLogicalView, setLogicalView } from "@/scripts/lib/couch-focus";
import {
  closeCouchKeyboard,
  endCouchKeyboardSession,
  isCouchKeyboardOpen,
  openCouchKeyboard,
} from "@/scripts/lib/couch-keyboard";
import {
  navigateBackWithOrigin,
  readRouteOrigin,
  recordRouteOrigin,
  setRouteNavigator,
} from "@/scripts/lib/route-origin";
import {
  closeTitleContextMenu,
  isTitleContextMenuOpen,
  openTitleContextMenu,
  titleContextActionsForEntry,
} from "@/scripts/lib/poster-menu";
import { isFavorite } from "@/scripts/lib/preferences.js";
import {
  installMoviesHomeControllerKeys,
  moviesHomeCardIdentity,
  recordMoviesHomeReturnFocus,
  restoreMoviesHomeFocus,
} from "@/scripts/movies/movies-home-mount";
import {
  mountBrowseEverything,
  type BrowseDataSource,
} from "@/scripts/lib/browse-everything";
import { invalidateCatalogIndex } from "@/scripts/lib/catalog-index";
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups";

// Back layers are module state: track every registration so tests
// cannot leak layers into each other (the real coordinator has no
// test reset — unregister functions are the isolation mechanism).
const unregisters: Array<() => void> = [];
function trackLayer(unregister: () => void): void {
  unregisters.push(unregister);
}

/**
 * One Back press through the real coordinator. jsdom events are
 * untrusted, so a dispatched Escape would never reach the
 * coordinator's capture listener; resolveBack() is the same chain
 * controller B and Android BACK run.
 */
function pressBack(): boolean {
  return resolveBack();
}

function pressKey(key: string, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  setRouteNavigator(null);
});

afterEach(() => {
  closeTitleContextMenu();
  endCouchKeyboardSession();
  for (const off of unregisters.splice(0)) off();
  setControllerHints(null);
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  setRouteNavigator(null);
  vi.restoreAllMocks();
});

// ── Back layers ─────────────────────────────────────────────────

describe("Back layers (coordinator)", () => {
  it("highest-priority active layer handles; lower layers never run", () => {
    const route = vi.fn(() => true);
    const drawer = vi.fn(() => true);
    trackLayer(registerBackLayer({ id: "r", priority: BACK_PRIORITY.ROUTE, isActive: () => true, handle: route }));
    trackLayer(registerBackLayer({ id: "d", priority: BACK_PRIORITY.DRAWER, isActive: () => true, handle: drawer }));
    expect(pressBack()).toBe(true);
    expect(drawer).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
  });

  it("one press pops exactly one layer; the next press pops the next", () => {
    let drawerActive = true;
    const route = vi.fn(() => true);
    const drawer = vi.fn(() => {
      drawerActive = false;
      return true;
    });
    trackLayer(registerBackLayer({ id: "r", priority: BACK_PRIORITY.ROUTE, isActive: () => true, handle: route }));
    trackLayer(registerBackLayer({ id: "d", priority: BACK_PRIORITY.DRAWER, isActive: () => drawerActive, handle: drawer }));
    pressBack();
    expect(drawer).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
    pressBack();
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("unregister stops the layer claiming presses", () => {
    const handle = vi.fn(() => true);
    const off = registerBackLayer({ id: "x", priority: BACK_PRIORITY.ROUTE, isActive: () => true, handle });
    off();
    pressBack();
    expect(handle).not.toHaveBeenCalled();
  });

  it("a dialog-guarded layer stays dormant while a dialog is open", () => {
    // The coordinator runs layers before its chrome fallback, so
    // layers self-guard on open dialogs (findOpenModal in views);
    // the fallback then closes the dialog itself.
    const handle = vi.fn(() => true);
    trackLayer(
      registerBackLayer({
        id: "x",
        priority: BACK_PRIORITY.ROUTE,
        isActive: () => !document.querySelector("dialog[open]"),
        handle,
      }),
    );
    const dlg = document.createElement("dialog");
    dlg.setAttribute("open", "");
    document.body.appendChild(dlg);
    expect(pressBack()).toBe(true);
    expect(handle).not.toHaveBeenCalled();
    expect(dlg.hasAttribute("open")).toBe(false);
    pressBack();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("a handled physical Escape is claimed (preventDefault + stop)", () => {
    trackLayer(registerBackLayer({ id: "x", priority: BACK_PRIORITY.ROUTE, isActive: () => true, handle: () => true }));
    // Fabricated trusted-like event: jsdom cannot produce a trusted
    // KeyboardEvent, so the listener body is called directly (the
    // W1 test pattern).
    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();
    const consumed = handleCoordinatorEscape({
      key: "Escape",
      isTrusted: true,
      defaultPrevented: false,
      preventDefault,
      stopImmediatePropagation,
    } as unknown as KeyboardEvent);
    expect(consumed).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });
});

// ── Route provenance ────────────────────────────────────────────

describe("route provenance", () => {
  it("record/read round-trips; malformed storage reads null", () => {
    recordRouteOrigin({ route: "/series?view=browse", label: "Browse Series" });
    expect(readRouteOrigin()).toEqual({ route: "/series?view=browse", label: "Browse Series" });
    sessionStorage.setItem("nylah:route-origin", "{broken");
    expect(readRouteOrigin()).toBeNull();
  });

  it("unsafe routes are never recorded", () => {
    recordRouteOrigin({ route: "https://evil.example/x", label: "x" });
    expect(readRouteOrigin()).toBeNull();
    recordRouteOrigin({ route: "//evil.example/x", label: "x" });
    expect(readRouteOrigin()).toBeNull();
  });

  it("navigateBackWithOrigin goes to the recorded origin, single-use", () => {
    const navigated: string[] = [];
    setRouteNavigator((url) => navigated.push(url));
    recordRouteOrigin({ route: "/movies?view=browse&page=3", label: "Browse" });
    navigateBackWithOrigin("/movies");
    expect(navigated).toEqual(["/movies?view=browse&page=3"]);
    expect(readRouteOrigin()).toBeNull();
    navigateBackWithOrigin("/movies");
    expect(navigated).toEqual(["/movies?view=browse&page=3", "/movies"]);
  });

  it("navigateBackWithOrigin clicks the Back link when no origin applies", () => {
    const link = document.createElement("a");
    link.href = "/movies";
    const clicked = vi.fn();
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      clicked();
    });
    document.body.appendChild(link);
    navigateBackWithOrigin("/movies", { backLink: link });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});

// ── Logical view / keyboard / hints ─────────────────────────────

describe("logical view, keyboard lifecycle, hints", () => {
  it("setLogicalView/getLogicalView round-trips; unset reads empty string", () => {
    // W1 semantics: module state, "" when unset (never null), no
    // persistence — full-page navigations reset it.
    setLogicalView("series-browse");
    expect(getLogicalView()).toBe("series-browse");
    setLogicalView("series-home");
    expect(getLogicalView()).toBe("series-home");
    setLogicalView("");
    expect(getLogicalView()).toBe("");
  });

  it("openCouchKeyboard focuses the input and tracks state; close commits the value", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const onCommit = vi.fn();
    openCouchKeyboard(input, onCommit, { focusGrid: false });
    expect(isCouchKeyboardOpen()).toBe(true);
    expect(document.activeElement).toBe(input);
    input.value = "horror";
    closeCouchKeyboard(true);
    expect(isCouchKeyboardOpen()).toBe(false);
    expect(onCommit).toHaveBeenCalledWith("horror");
  });

  it("setControllerHints publishes the override; null releases it", () => {
    setControllerHints({
      id: "browse-movie",
      items: [
        { glyph: "x", label: "Options" },
        { glyph: "y", label: "Search Movies" },
      ],
    });
    expect(getControllerHints()?.id).toBe("browse-movie");
    setControllerHints(null);
    expect(getControllerHints()).toBeNull();
  });
});

// ── Detail Back stack ───────────────────────────────────────────

describe("installDetailBackLayers", () => {
  it("track-list close wins over player exit; player exit wins over route", () => {
    let playerOpen = true;
    let listOpen = true;
    const onPlayerBack = vi.fn();
    const onDetailBack = vi.fn();
    trackLayer(installDetailBackLayers({
      isPlayerOpen: () => playerOpen,
      closePlaybackSubLayer: () => {
        if (!listOpen) return false;
        listOpen = false;
        return true;
      },
      onPlayerBack: () => {
        playerOpen = false;
        onPlayerBack();
      },
      onDetailBack,
    }));
    pressBack();
    expect(onPlayerBack).not.toHaveBeenCalled();
    expect(onDetailBack).not.toHaveBeenCalled();
    pressBack();
    expect(onPlayerBack).toHaveBeenCalledTimes(1);
    expect(onDetailBack).not.toHaveBeenCalled();
    pressBack();
    expect(onDetailBack).toHaveBeenCalledTimes(1);
  });

  it("subview step runs before route Back, exactly once per press", () => {
    const onSubView = vi.fn();
    const onDetailBack = vi.fn();
    let inSubView = true;
    trackLayer(installDetailBackLayers({
      isPlayerOpen: () => false,
      onPlayerBack: vi.fn(),
      isInDetailSubView: () => inSubView,
      onDetailSubViewBack: () => {
        inSubView = false;
        onSubView();
      },
      onDetailBack,
    }));
    pressBack();
    expect(onSubView).toHaveBeenCalledTimes(1);
    expect(onDetailBack).not.toHaveBeenCalled();
    pressBack();
    expect(onDetailBack).toHaveBeenCalledTimes(1);
  });
});

// ── Contract F context menu ─────────────────────────────────────

describe("openTitleContextMenu (Contract F)", () => {
  function anchorCard(): HTMLElement {
    const card = document.createElement("button");
    card.type = "button";
    card.textContent = "Card";
    document.body.appendChild(card);
    card.focus();
    return card;
  }

  it("renders actions, skips disabled in D-pad movement, runs on click", () => {
    const card = anchorCard();
    const ran = vi.fn();
    openTitleContextMenu(card, [
      { id: "open", label: "Open Details", action: ran },
      { id: "dead", label: "Disabled", action: vi.fn(), disabled: true },
      { id: "fav", label: "Favourite", action: vi.fn() },
    ]);
    expect(isTitleContextMenuOpen()).toBe(true);
    const items = [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
    expect(items.map((b) => b.textContent)).toEqual(["Open Details", "Disabled", "Favourite"]);
    expect(items[1].disabled).toBe(true);
    // First enabled item focused; ArrowDown skips the disabled one.
    expect(document.activeElement).toBe(items[0]);
    items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[2]);
    items[0].click();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(isTitleContextMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(card);
  });

  it("B closes the menu and restores focus without popping a lower layer", () => {
    const card = anchorCard();
    const lower = vi.fn(() => true);
    trackLayer(registerBackLayer({ id: "lower", priority: BACK_PRIORITY.ROUTE, isActive: () => true, handle: lower }));
    openTitleContextMenu(card, [{ id: "open", label: "Open", action: vi.fn() }]);
    pressBack();
    expect(isTitleContextMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(card);
    expect(lower).not.toHaveBeenCalled();
    pressBack();
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it("title actions: vod set has Open/Favourite/Watch Later/Watched and toggles state", async () => {
    const changed = vi.fn();
    const actions = await titleContextActionsForEntry({
      kind: "vod",
      entryId: 42,
      name: "Test Film",
      playlistId: "pl-1",
      onOpen: vi.fn(),
      onChanged: changed,
    });
    expect(actions.map((a) => a.id)).toEqual(["open", "favourite", "watchlater", "watched"]);
    expect(isFavorite("pl-1", "vod", 42)).toBe(false);
    actions[1].action();
    expect(isFavorite("pl-1", "vod", 42)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    const relabelled = await titleContextActionsForEntry({
      kind: "vod",
      entryId: 42,
      name: "Test Film",
      playlistId: "pl-1",
      onOpen: vi.fn(),
    });
    expect(relabelled[1].label).not.toBe(actions[1].label);
  });

  it("series actions never offer Follow from Browse/Home (no episode baseline)", async () => {
    const actions = await titleContextActionsForEntry({
      kind: "series",
      entryId: 7,
      name: "Test Series",
      playlistId: "pl-1",
      onOpen: vi.fn(),
    });
    expect(actions.map((a) => a.id)).not.toContain("follow");
    expect(actions.map((a) => a.id)).toEqual(["open", "favourite", "watchlater", "watched"]);
  });
});

// ── Movies Home keys ────────────────────────────────────────────

describe("Movies Home controller keys", () => {
  it("moviesHomeCardIdentity parses vod cards, rejects genre tiles", () => {
    const card = document.createElement("a");
    card.setAttribute("data-couch-key", "vod-42");
    card.innerHTML = '<span class="rs-card__title">Dune</span><img src="https://x/poster.jpg">';
    expect(moviesHomeCardIdentity(card)).toEqual({ id: 42, name: "Dune", logo: "https://x/poster.jpg" });
    const tile = document.createElement("a");
    tile.setAttribute("data-couch-key", "movies-genre-horror");
    expect(moviesHomeCardIdentity(tile)).toBeNull();
  });

  it("Y navigates to scoped Search Movies; B navigates Home; X opens the menu", async () => {
    const root = document.createElement("div");
    root.id = "movies-home-root";
    const card = document.createElement("a");
    card.setAttribute("data-couch-key", "vod-9");
    card.setAttribute("href", "/movies/detail?id=9");
    card.innerHTML = '<span class="rs-card__title">Film</span>';
    root.appendChild(card);
    document.body.appendChild(root);
    const navigate = vi.fn();
    const off = installMoviesHomeControllerKeys(root, {
      getPlaylistId: () => "pl-1",
      navigate,
    });
    card.focus();
    pressKey("y");
    expect(navigate).toHaveBeenCalledWith("/movies?view=browse&focus=search");
    pressKey("x");
    await new Promise((r) => setTimeout(r, 0));
    expect(isTitleContextMenuOpen()).toBe(true);
    pressBack();
    expect(isTitleContextMenuOpen()).toBe(false);
    pressBack();
    expect(navigate).toHaveBeenCalledWith("/");
    off();
  });

  it("Browse-exit return focus lands on the recorded genre tile", () => {
    const root = document.createElement("div");
    root.id = "movies-home-root";
    const rail = document.createElement("div");
    rail.setAttribute("data-nylah-rail", "movies-genres-a");
    const tile = document.createElement("a");
    tile.setAttribute("data-nylah-item", "");
    tile.setAttribute("data-couch-key", "movies-genre-horror");
    tile.href = "/movies?view=browse";
    rail.appendChild(tile);
    root.appendChild(rail);
    document.body.appendChild(root);
    window.history.replaceState(null, "", "/movies");
    recordMoviesHomeReturnFocus("movies-genre-horror");
    const focused = restoreMoviesHomeFocus(document);
    expect(focused).toBe(tile);
    expect(document.activeElement).toBe(tile);
  });
});

// ── Browse integration ──────────────────────────────────────────

interface FixtureRow {
  id: number;
  name: string;
  year: string;
  category: string;
}

function buildRows(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  for (let i = 0; i < 60; i++) {
    const genre = i % 2 === 0 ? "Horror" : "Comedy";
    rows.push({ id: i + 1, name: `${genre} Title ${i}`, year: "2020", category: genre });
  }
  return rows;
}

function makeSource(rows: FixtureRow[]): BrowseDataSource {
  return {
    load: async () => ({
      rows,
      playlistId: "pl-1",
      playlistTitle: "Test Playlist",
      fromCache: false,
      loadError: false,
    }),
    toEntry: (row) => {
      const r = row as FixtureRow;
      return { id: r.id, name: r.name, year: r.year, category: r.category };
    },
    rowKey: (row) => `vod-${(row as FixtureRow).id}`,
    cardView: (row) => {
      const r = row as FixtureRow;
      return { title: r.name, meta: r.category, image: null, kind: "poster", itemKey: `vod-${r.id}` };
    },
    detailId: (row) => String((row as FixtureRow).id),
    watchSets: () => ({
      favouriteIds: new Set(),
      watchLaterIds: new Set(),
      inProgressIds: new Set(),
      watchedIds: new Set(),
      followedIds: new Set(),
      newEpisodeIds: new Set(),
    }),
    emptyTitle: "No movies yet",
    emptyMessage: "Empty.",
  };
}

describe("Browse Everything (0.11.10 integration)", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    invalidateCatalogIndex();
    clearTitleGroupRegistry();
    window.history.replaceState(null, "", "/movies?view=browse");
  });

  const mounted: Array<{ destroy: () => void }> = [];

  afterEach(() => {
    for (const m of mounted.splice(0)) {
      try {
        m.destroy();
      } catch {
        // Already destroyed by the test itself.
      }
    }
    vi.unstubAllGlobals();
  });

  const flush = async (ms = 80) => new Promise((r) => setTimeout(r, ms));

  async function mountBrowse() {
    const mountedBrowse = await mountBrowseInner();
    mounted.push(mountedBrowse.controller);
    return mountedBrowse;
  }

  async function mountBrowseInner() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onOpenDetail = vi.fn();
    const onExit = vi.fn();
    const controller = mountBrowseEverything(container, {
      kind: "movie",
      source: makeSource(buildRows()),
      onOpenDetail,
      onExit,
    });
    await flush();
    return { container, controller, onOpenDetail, onExit };
  }

  function firstCard(container: HTMLElement): HTMLElement {
    const card = container.querySelector<HTMLElement>("[data-browse-key]");
    if (!card) throw new Error("no card rendered");
    return card;
  }

  it("X opens a REAL menu; Open Details navigates; B closes the menu without exiting", async () => {
    const { container, controller, onOpenDetail, onExit } = await mountBrowse();
    const card = firstCard(container);
    card.focus();
    pressKey("x");
    await flush(20);
    expect(isTitleContextMenuOpen()).toBe(true);
    const items = [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
    expect(items.length).toBe(4);
    pressBack();
    expect(isTitleContextMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(card);
    expect(onExit).not.toHaveBeenCalled();
    // Reopen and choose Open.
    pressKey("x");
    await flush(20);
    const openItem = document.querySelector<HTMLButtonElement>("[data-action-id='open']");
    expect(openItem).not.toBeNull();
    openItem!.click();
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it("each Escape press on the grid exits once (one step per press)", async () => {
    const { container, controller, onExit } = await mountBrowse();
    firstCard(container).focus();
    pressBack();
    pressBack();
    // First press exits; the layer stays registered until destroy,
    // so a second press calls onExit again — one call per press.
    expect(onExit).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  it("Escape in Sort closes the overlay first; the next Escape exits", async () => {
    const { container, controller, onExit } = await mountBrowse();
    const sortBtn = container.querySelector<HTMLButtonElement>("[data-browse-action='sort']");
    sortBtn!.click();
    expect(container.querySelector("[data-browse-sort-overlay]")).not.toBeNull();
    pressBack();
    expect(container.querySelector("[data-browse-sort-overlay]")).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
    pressBack();
    expect(onExit).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it("Y opens Movies-scoped search, not global /search", async () => {
    const { container, controller } = await mountBrowse();
    firstCard(container).focus();
    pressKey("y");
    await flush(20);
    const overlay = container.querySelector("[data-browse-search-overlay]");
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector("h2")?.textContent).toBe("Search Movies");
    expect(window.location.pathname).toBe("/movies");
    expect(isCouchKeyboardOpen()).toBe(true);
    // B exits editing first (keyboard closes, overlay stays)…
    pressBack();
    expect(isCouchKeyboardOpen()).toBe(false);
    expect(container.querySelector("[data-browse-search-overlay]")).not.toBeNull();
    // …then B cancels the search without changing browse state.
    pressBack();
    expect(container.querySelector("[data-browse-search-overlay]")).toBeNull();
    controller.destroy();
  });

  it("category selection REPLACES and B from Browse keeps the mount's exit contract", async () => {
    const { container, controller, onExit } = await mountBrowse();
    const categoriesBtn = container.querySelector<HTMLButtonElement>("[data-browse-action='categories']");
    categoriesBtn!.click();
    await flush(20);
    // Open the Genres family, pick Horror, then reopen and pick Comedy.
    const drawerItems = () => [...container.querySelectorAll<HTMLElement>("[data-category-drawer-item]")];
    const genres = drawerItems().find((b) => b.textContent?.includes("Genres"));
    genres!.click();
    await flush(20);
    const horror = drawerItems().find((b) => b.textContent?.includes("Horror"));
    horror!.click();
    await flush(20);
    expect(controller.getState().category.id).toBe("horror");
    categoriesBtn!.click();
    await flush(20);
    // Reopening lands on the selected family (items level) or the
    // family list — either way, reach Comedy and select it.
    const comedyDirect = drawerItems().find((b) => b.textContent?.includes("Comedy"));
    if (comedyDirect) {
      comedyDirect.click();
    } else {
      drawerItems().find((b) => b.textContent?.includes("Genres"))!.click();
      await flush(20);
      drawerItems().find((b) => b.textContent?.includes("Comedy"))!.click();
    }
    await flush(20);
    const state = controller.getState();
    expect(state.category.id).toBe("comedy");
    expect(state.page).toBe(1);
    pressBack();
    expect(onExit).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
});
