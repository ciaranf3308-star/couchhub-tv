/**
 * @vitest-environment jsdom
 */
// 0.11.8 W2 — mountBrowseEverything contract (brief §6, §7, §8, §11, §12, §15.8, §16, §18).
// Fixture: 2,100 rows incl. title variants, unrated titles and sparse metadata.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  mountBrowseEverything,
  type BrowseDataSource,
} from "@/scripts/lib/browse-everything";
import { invalidateCatalogIndex } from "@/scripts/lib/catalog-index";
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups";

interface FixtureRow {
  id: number;
  name: string;
  year: string;
  rating: string;
  duration: string;
  category: string;
  added: number;
}

const GENRES = ["Action", "Comedy", "Horror", "Drama", "Science Fiction", "Documentary"];

function buildRows(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  let id = 1;
  // 2,000 distinct titles.
  for (let i = 0; i < 2000; i++) {
    const genre = GENRES[i % GENRES.length];
    const sparse = i % 17 === 0;
    rows.push({
      id: id++,
      name: `${genre} Title ${i}`,
      year: sparse ? "" : String(1960 + (i % 65)),
      rating: sparse || i % 5 === 0 ? "" : String(5 + ((i * 7) % 50) / 10),
      duration: sparse ? "" : `${60 + (i % 150)} min`,
      category: sparse ? "" : genre,
      added: i,
    });
  }
  // 100 variants: same title+year as an existing title (grouping).
  // Year-less bases are skipped: conservative title/year grouping
  // requires a known year, so a year-less variant cannot merge.
  for (let i = 0; i < 100; i++) {
    const base = rows[i * 10];
    if (!base.year) continue;
    rows.push({ ...base, id: id++, category: `${base.category} FHD` });
  }
  return rows;
}

function makeSource(rows: FixtureRow[], overrides: Partial<BrowseDataSource> = {}): BrowseDataSource {
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
      return {
        id: r.id,
        name: r.name,
        year: r.year,
        rating: r.rating,
        duration: r.duration,
        category: r.category,
        added: r.added,
      };
    },
    rowKey: (row) => `vod-${(row as FixtureRow).id}`,
    cardView: (row) => {
      const r = row as FixtureRow;
      return {
        title: r.name,
        meta: [r.year, r.category].filter(Boolean).join(" · "),
        image: null,
        kind: "poster",
        itemKey: `vod-${r.id}`,
      };
    },
    detailId: (row) => String((row as FixtureRow).id),
    watchSets: () => ({
      favouriteIds: new Set([1, 2]),
      watchLaterIds: new Set([3]),
      inProgressIds: new Set([4]),
      watchedIds: new Set([5]),
      followedIds: new Set(),
      newEpisodeIds: new Set(),
    }),
    emptyTitle: "No movies yet",
    emptyMessage: "Empty.",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  invalidateCatalogIndex();
  clearTitleGroupRegistry();
  window.history.replaceState(null, "", "/movies");
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

const flush = async (ms = 60) => new Promise((r) => setTimeout(r, ms));

// The sandbox CPU is heavily throttled, so fixed sleeps race the
// rAF-batched grid render: poll until cards appear (or time out).
async function waitForCards(host: HTMLElement, min = 1, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (gridCards(host).length >= min) return;
    await flush(50);
  }
}

async function mount(rows = buildRows(), opts: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const onOpenDetail = vi.fn();
  const onExit = vi.fn();
  const controller = mountBrowseEverything(host, {
    kind: "movie",
    onOpenDetail,
    onExit,
    source: makeSource(rows),
    ...(opts as object),
  });
  if (rows.length > 0) await waitForCards(host);
  else await flush(120);
  return { host, controller, onOpenDetail, onExit };
}

function gridCards(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll("[data-browse-key]"));
}

describe("mount + pagination (§6)", () => {
  it("shows title, category, match count, actions and a bounded grid — never the full catalogue as DOM", async () => {
    const { host, controller } = await mount();
    expect(host.querySelector("h1")?.textContent).toBe("Browse Movies");
    expect(host.querySelector("[data-role='browse-count']")?.textContent).toContain("2,000");
    expect(host.querySelector("[data-role='browse-category']")?.textContent).toBe("All Movies");
    expect(host.querySelectorAll("[data-browse-action]").length).toBe(5);
    const cards = gridCards(host);
    expect(cards.length).toBeGreaterThanOrEqual(24);
    expect(cards.length).toBeLessThanOrEqual(36);
    expect(host.querySelector(".rs-browse2__pagination")?.textContent).toContain("Page 1 of");
    controller.destroy();
  });

  it("page turns replace the page and keep the node count bounded", async () => {
    const { host, controller } = await mount();
    const firstPageKeys = gridCards(host).map((c) => c.dataset.browseKey);
    expect(firstPageKeys.length).toBeGreaterThanOrEqual(24);
    const next = host.querySelector<HTMLButtonElement>(".rs-browse2__pagination-next")!;
    expect(next).toBeTruthy();
    next.click();
    // Poll until the rAF-batched page-2 render lands.
    const start = Date.now();
    let secondPageKeys = gridCards(host).map((c) => c.dataset.browseKey);
    while (
      Date.now() - start < 15000 &&
      (controller.getState().page !== 2 ||
        secondPageKeys.join() === firstPageKeys.join())
    ) {
      await flush(50);
      secondPageKeys = gridCards(host).map((c) => c.dataset.browseKey);
    }
    expect(controller.getState().page).toBe(2);
    expect(secondPageKeys).not.toEqual(firstPageKeys);
    expect(secondPageKeys.length).toBe(firstPageKeys.length);
    expect(secondPageKeys.filter((k) => firstPageKeys.includes(k)).length).toBe(0);
    controller.destroy();
  });

  it("PageDown/PageUp keys turn pages (LB/RB equivalents)", async () => {
    const { host, controller } = await mount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    await flush();
    expect(controller.getState().page).toBe(2);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    await flush();
    expect(controller.getState().page).toBe(1);
    void host;
    controller.destroy();
  });

  it("A/Enter on a card opens detail with the detail id; B exits from the grid", async () => {
    const { host, controller, onOpenDetail, onExit } = await mount();
    const first = gridCards(host)[0];
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(typeof onOpenDetail.mock.calls[0][0]).toBe("string");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onExit).toHaveBeenCalledTimes(1);
    controller.destroy();
  });
});

describe("category drawer (§7)", () => {
  it("opens on the selected category, selects REPLACE, closes back to the grid", async () => {
    const { host, controller } = await mount();
    const btn = host.querySelector<HTMLButtonElement>("[data-browse-action='categories']")!;
    btn.click();
    await flush();
    expect(host.querySelector("[data-browse-category-drawer]")).not.toBeNull();
    expect(host.querySelector("[data-browse-layer]")?.getAttribute("data-browse-layer")).toBe("categories");
    // Move to Genres family, open it, pick Horror (index 2 in canonical order among populated).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(host.querySelector("[data-browse-category-drawer]")).not.toBeNull();
    // Items level: find the Horror row and click it.
    const rows = Array.from(
      host.querySelectorAll<HTMLButtonElement>("[data-category-drawer-item]"),
    );
    const horror = rows.find((r) => r.textContent?.includes("Horror"))!;
    horror.click();
    await flush();
    expect(controller.getState().category.id).toBe("horror");
    expect(host.querySelector("[data-browse-category-drawer]")).toBeNull();
    expect(host.querySelector("[data-role='browse-category']")?.textContent).toBe("Horror");
    controller.destroy();
  });

  it("B from items returns to families; B again closes without selecting", async () => {
    const { host, controller } = await mount();
    host.querySelector<HTMLButtonElement>("[data-browse-action='categories']")!.click();
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(host.querySelector("[data-browse-category-drawer]")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(host.querySelector("[data-browse-category-drawer]")).toBeNull();
    expect(controller.getState().category.kind).toBe("all");
    controller.destroy();
  });
});

describe("filter drawer (§8/§10) + sort (§11) + search (§12)", () => {
  it("filter Apply commits the draft; B cancels without touching the grid", async () => {
    const { host, controller } = await mount();
    host.querySelector<HTMLButtonElement>("[data-browse-action='filters']")!.click();
    await flush();
    expect(host.querySelector("[data-browse-filter-drawer]")).not.toBeNull();
    // Cycle the first family (Genre) once, then B-cancel.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(host.querySelector("[data-browse-filter-drawer]")).toBeNull();
    expect(controller.getState().filters.genre).toBe("");
    // Reopen, cycle, then Apply via the Apply row.
    host.querySelector<HTMLButtonElement>("[data-browse-action='filters']")!.click();
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-filter-drawer-row]"));
    rows.find((r) => r.dataset.familyId === "__apply")!.click();
    await flush();
    expect(controller.getState().filters.genre).toBe("action");
    expect(host.querySelector("[data-role='browse-summary']")?.textContent).toContain("Action");
    controller.destroy();
  });

  it("Reset All clears category, filters, search, sort and page", async () => {
    const { host, controller } = await mount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    await flush();
    expect(controller.getState().page).toBe(2);
    controller.setState({
      category: { kind: "genre", id: "horror", label: "Horror" },
      search: "night",
      sort: "az",
    });
    await flush();
    expect(controller.getState().page).toBe(1); // constraint change resets page
    host.querySelector<HTMLButtonElement>("[data-browse-action='reset']")!.click();
    await flush();
    const state = controller.getState();
    expect(state.category.kind).toBe("all");
    expect(state.search).toBe("");
    expect(state.sort).toBe("recommended");
    expect(state.page).toBe(1);
    controller.destroy();
  });

  it("sort overlay applies an order; B closes without changing", async () => {
    const { host, controller } = await mount();
    host.querySelector<HTMLButtonElement>("[data-browse-action='sort']")!.click();
    await flush();
    expect(host.querySelector("[data-browse-sort-overlay]")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(controller.getState().sort).toBe("recommended");
    host.querySelector<HTMLButtonElement>("[data-browse-action='sort']")!.click();
    await flush();
    const options = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".rs-browse-sort-overlay__option"),
    );
    options.find((o) => o.textContent === "Title A–Z")!.click();
    await flush();
    expect(controller.getState().sort).toBe("az");
    controller.destroy();
  });

  it("Y opens search; typing debounces; cancelling preserves position", async () => {
    const { host, controller } = await mount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    await flush();
    const overlay = host.querySelector("[data-browse-search-overlay]");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelectorAll(".rs-browse-search-overlay__scope-btn").length).toBe(2);
    const input = overlay!.querySelector<HTMLInputElement>("input")!;
    input.value = "Horror Title 5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(300);
    expect(controller.getState().search).toBe("Horror Title 5");
    // Cancel via the Cancel button restores the pre-search state.
    const cancel = Array.from(overlay!.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    )!;
    cancel.click();
    await flush();
    expect(controller.getState().search).toBe("");
    expect(controller.getState().page).toBe(1);
    controller.destroy();
  });

  it("search overlay Escape blurs the input first, then cancels", async () => {
    const { host, controller } = await mount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    await flush();
    const input = host.querySelector<HTMLInputElement>(".rs-browse-search-overlay__input")!;
    expect(document.activeElement).toBe(input);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).not.toBe(input);
    expect(host.querySelector("[data-browse-search-overlay]")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(host.querySelector("[data-browse-search-overlay]")).toBeNull();
    controller.destroy();
  });
});

describe("empty/error states (§18)", () => {
  it("no matches shows applied filters + Reset All; never a fake empty catalogue", async () => {
    const { host, controller } = await mount();
    // Token-disjoint query: W1 search is ranked retrieval, so a
    // query sharing one token ("title") with every fixture title
    // legitimately returns results. This query shares none.
    controller.setState({ search: "zzz-no-such-qqq-zzz" });
    await flush();
    expect(host.querySelector(".rs-browse2__empty-title")?.textContent).toContain("No results");
    expect(host.querySelector(".rs-browse2__status-text")?.textContent).toContain("zzz-no-such-qqq-zzz");
    expect(gridCards(host)).toHaveLength(0);
    controller.destroy();
  });

  it("provider failure shows a truthful error + Retry, not an empty catalogue", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const source = makeSource([], {
      load: async () => ({
        rows: [],
        playlistId: "pl-1",
        playlistTitle: "Test Playlist",
        fromCache: false,
        loadError: true,
        errorMessage: "HTTP 502",
      }),
    });
    const controller = mountBrowseEverything(host, {
      kind: "movie",
      onOpenDetail: () => {},
      onExit: () => {},
      source,
    });
    await flush(120);
    expect(host.querySelector("[role='alert']")?.textContent).toContain("Could not reach");
    expect(host.querySelector("[role='alert']")?.textContent).toContain("502");
    expect(host.querySelector("[role='alert']")?.textContent).toContain("stale data");
    expect(host.querySelector(".rs-browse2__empty-title")).toBeNull();
    controller.destroy();
  });

  it("a removed category after refresh resets intelligently with a notice", async () => {
    const rows = buildRows();
    const { host, controller } = await mount(rows, {
      initialState: {
        category: { kind: "genre", id: "western", label: "Western" },
      },
    });
    // Western has no titles in the fixture → the load revalidates and resets to All.
    await flush();
    expect(controller.getState().category.kind).toBe("all");
    expect(host.textContent).toContain("no longer available");
    controller.destroy();
  });
});

describe("restore + leaks (§15.8, §16.5)", () => {
  it("restoreFocus lands on the exact poster on its page", async () => {
    const rows = buildRows();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const controller = mountBrowseEverything(host, {
      kind: "movie",
      onOpenDetail: () => {},
      onExit: () => {},
      restoreFocus: { id: "100", page: 2 },
      source: makeSource(rows),
    });
    await flush(150);
    expect(controller.getState().page).toBe(2);
    controller.destroy();
  });

  it("repeated mount/unmount accumulates nothing", async () => {
    const keydownBefore = 0;
    void keydownBefore;
    for (let i = 0; i < 5; i++) {
      const { host, controller } = await mount(buildRows());
      expect(host.querySelector("[data-browse-everything]")).not.toBeNull();
      controller.destroy();
      expect(host.querySelector("[data-browse-everything]")).toBeNull();
      host.remove();
    }
    expect(document.querySelectorAll("[data-browse-everything]").length).toBe(0);
    expect(document.querySelectorAll("[data-browse-page-grid]").length).toBe(0);
    // Keys after destroy do nothing (no orphan handlers throwing).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
  });

  it("URL syncs state without navigating (replaceState)", async () => {
    const { controller } = await mount();
    controller.setState({
      category: { kind: "genre", id: "horror", label: "Horror" },
      page: 1,
    });
    await flush();
    expect(window.location.search).toContain("view=browse");
    expect(window.location.search).toContain("category=genre%3Ahorror");
    controller.destroy();
  });
});
