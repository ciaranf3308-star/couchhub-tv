/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asBrowseType,
  parseBrowseType,
  browseTypeHref,
  browseKindAdapter,
  mountBrowsePage,
  BROWSE_ID_PREFIX,
  type BrowseType,
} from "@/scripts/browse/couch-browse-page";
import { moviesAdapter } from "@/scripts/movies/couch-movies-adapter";
import { seriesAdapter } from "@/scripts/series/couch-series-adapter";
import {
  recordCouchFocus,
  clearCouchFocusMemory,
  restoreCouchFocus,
} from "@/scripts/lib/couch-focus";

// Node 24+ ships an experimental native `localStorage` /
// `sessionStorage` that shadows jsdom's; stub both with real in-memory
// Storage (same approach as tests/couch-shared.test.ts).
function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const sessionStorageMock = makeStorage();
const localStorageMock = makeStorage();
Object.defineProperty(window, "sessionStorage", { value: sessionStorageMock });
Object.defineProperty(window, "localStorage", { value: localStorageMock });

// jsdom reports zero-size boxes for everything; pretend every element
// has a box so the visibility checks in the focus layer behave like a
// real viewport.
Element.prototype.getBoundingClientRect = function () {
  return { width: 100, height: 100 } as DOMRect;
};

const here = dirname(fileURLToPath(import.meta.url));
const browseAstro = readFileSync(resolve(here, "../src/pages/browse.astro"), "utf8");

/** Minimal stand-in for the browse.astro body: three sections + chips. */
function renderBrowseDom(): void {
  document.body.innerHTML = `
    <div data-nylah-rail="browse-type">
      <button type="button" data-browse-type="all" data-nylah-item>All</button>
      <button type="button" data-browse-type="movies" data-nylah-item>Movies</button>
      <button type="button" data-browse-type="series" data-nylah-item>Series</button>
    </div>
    <div id="browse-search-slot" data-browse-search-slot></div>
    <section id="browse-discover" hidden></section>
    <section id="browse-movies" hidden>
      <div id="browse-movies-couch-browse-rails"></div>
      <div id="browse-movies-couch-browse-empty" hidden></div>
      <div id="browse-movies-couch-browse-grid" hidden></div>
    </section>
    <section id="browse-series" hidden>
      <div id="browse-series-couch-browse-rails"></div>
      <div id="browse-series-couch-browse-empty" hidden></div>
      <div id="browse-series-couch-browse-grid" hidden></div>
    </section>`;
}

function sectionHidden(id: string): boolean {
  return Boolean((document.getElementById(id) as HTMLElement).hidden);
}

function chip(type: BrowseType): HTMLElement {
  return document.querySelector(`[data-browse-type="${type}"]`) as HTMLElement;
}

describe("parseBrowseType / asBrowseType", () => {
  it("defaults to all for an empty, missing or unknown type", () => {
    expect(parseBrowseType("")).toBe("all");
    expect(parseBrowseType("?type=")).toBe("all");
    expect(parseBrowseType("?type=movie")).toBe("all");
    expect(parseBrowseType("?type=films")).toBe("all");
    expect(parseBrowseType("?q=star")).toBe("all");
    expect(asBrowseType(null)).toBe("all");
    expect(asBrowseType(undefined)).toBe("all");
  });

  it("reads movies and series, case-insensitively", () => {
    expect(parseBrowseType("?type=movies")).toBe("movies");
    expect(parseBrowseType("?type=series")).toBe("series");
    expect(parseBrowseType("?type=Movies")).toBe("movies");
    expect(parseBrowseType("?type=SERIES&foo=1")).toBe("series");
    expect(asBrowseType("  movies ")).toBe("movies");
  });
});

describe("browseTypeHref", () => {
  it("is the bare /browse for all and a deep-linkable query for the kinds", () => {
    expect(browseTypeHref("all")).toBe("/browse");
    expect(browseTypeHref("movies")).toBe("/browse?type=movies");
    expect(browseTypeHref("series")).toBe("/browse?type=series");
  });
});

describe("browseKindAdapter", () => {
  it("movies mount the VOD adapter and series mount the series adapter", () => {
    expect(browseKindAdapter("movies")).toBe(moviesAdapter);
    expect(browseKindAdapter("series")).toBe(seriesAdapter);
    expect(moviesAdapter.kind).toBe("vod");
    expect(moviesAdapter.spec.listAction).toBe("get_vod_streams");
    expect(seriesAdapter.kind).toBe("series");
    expect(seriesAdapter.spec.listAction).toBe("get_series");
  });

  it("each adapter links only to its own detail route", () => {
    expect(moviesAdapter.detailHref({ id: 42 } as never)).toBe("/movies/detail?id=42");
    expect(seriesAdapter.detailHref({ id: 7 } as never)).toBe("/series/detail?id=7");
  });

  it("each adapter keys its cards so focus memory can find them again", () => {
    expect(moviesAdapter.rowKey({ id: 42 } as never)).toBe("vod-42");
    expect(seriesAdapter.rowKey({ id: 7 } as never)).toBe("series-7");
  });
});

describe("mountBrowsePage sections", () => {
  beforeEach(() => {
    renderBrowseDom();
    window.history.replaceState({}, "", "/browse");
  });
  afterEach(() => {
    document.body.innerHTML = "";
    clearCouchFocusMemory();
    window.history.replaceState({}, "", "/");
  });

  it("all shows the Discover landing and mounts no catalogue controller", () => {
    const mountKind = vi.fn();
    expect(mountBrowsePage({ search: "", mountKind })).toBe("all");
    expect(sectionHidden("browse-discover")).toBe(false);
    expect(sectionHidden("browse-movies")).toBe(true);
    expect(sectionHidden("browse-series")).toBe(true);
    expect(mountKind).not.toHaveBeenCalled();
  });

  it("movies shows only the movies section, with the movies id prefix", () => {
    const mountKind = vi.fn();
    expect(mountBrowsePage({ search: "?type=movies", mountKind })).toBe("movies");
    expect(sectionHidden("browse-discover")).toBe(true);
    expect(sectionHidden("browse-movies")).toBe(false);
    expect(sectionHidden("browse-series")).toBe(true);
    expect(mountKind).toHaveBeenCalledTimes(1);
    expect(mountKind).toHaveBeenCalledWith("movies", "browse-movies-");
    expect(BROWSE_ID_PREFIX.movies).toBe("browse-movies-");
  });

  it("series shows only the series section, with the series id prefix", () => {
    const mountKind = vi.fn();
    expect(mountBrowsePage({ search: "?type=series", mountKind })).toBe("series");
    expect(sectionHidden("browse-discover")).toBe(true);
    expect(sectionHidden("browse-movies")).toBe(true);
    expect(sectionHidden("browse-series")).toBe(false);
    expect(mountKind).toHaveBeenCalledTimes(1);
    expect(mountKind).toHaveBeenCalledWith("series", "browse-series-");
    expect(BROWSE_ID_PREFIX.series).toBe("browse-series-");
  });

  it("an unknown type falls back to the Discover landing", () => {
    const mountKind = vi.fn();
    expect(mountBrowsePage({ search: "?type=films", mountKind })).toBe("all");
    expect(sectionHidden("browse-discover")).toBe(false);
    expect(mountKind).not.toHaveBeenCalled();
  });

  it("the type chips reflect the current type and navigate on change", () => {
    const navigate = vi.fn();
    mountBrowsePage({ search: "?type=movies", navigate, mountKind: vi.fn() });
    expect(chip("all").getAttribute("aria-pressed")).toBe("false");
    expect(chip("movies").getAttribute("aria-pressed")).toBe("true");
    expect(chip("series").getAttribute("aria-pressed")).toBe("false");

    chip("series").click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/browse?type=series");

    // The active chip is a no-op — the URL already says movies.
    chip("movies").click();
    expect(navigate).toHaveBeenCalledTimes(1);

    chip("all").click();
    expect(navigate).toHaveBeenCalledWith("/browse");
  });

  it("the search slot is present and empty for W2 to fill", () => {
    mountBrowsePage({ search: "", mountKind: vi.fn() });
    const slot = document.querySelector("[data-browse-search-slot]");
    expect(slot).not.toBeNull();
    expect(slot?.children.length).toBe(0);
    expect(slot?.querySelector("button, input, a")).toBeNull();
  });
});

describe("focus restoration after a detail return", () => {
  beforeEach(() => {
    renderBrowseDom();
    window.history.replaceState({}, "", "/browse?type=movies");
  });
  afterEach(() => {
    document.body.innerHTML = "";
    clearCouchFocusMemory();
    window.history.replaceState({}, "", "/");
  });

  it("restores the focused movie card when coming back from /movies/detail", () => {
    // The shared controller renders rails with the same ids and card
    // keys as the standalone /movies page; simulate that render here.
    const mountKind = vi.fn(() => {
      const rails = document.getElementById("browse-movies-couch-browse-rails");
      const host = document.createElement("div");
      host.id = "browse-movies-couch-browse-rails";
      host.innerHTML = `
        <section class="rs-rail" data-nylah-rail="movies-recent" aria-label="Recently Added">
          <div class="rs-rail__row">
            <a href="/movies/detail?id=7" data-nylah-item data-couch-key="vod-7" class="rs-card">Seven</a>
            <a href="/movies/detail?id=8" data-nylah-item data-couch-key="vod-8" class="rs-card">Eight</a>
          </div>
        </section>`;
      rails?.replaceWith(host);
    });
    mountBrowsePage({ search: "?type=movies", mountKind });

    // Viewer focused the first card, opened its detail, pressed B:
    // history is back on /browse?type=movies with the memory intact.
    recordCouchFocus({ route: "/browse", rail: "movies-recent", index: 0, key: "vod-7" });
    const restored = restoreCouchFocus(document);
    expect(restored).not.toBeNull();
    expect(restored?.getAttribute("data-couch-key")).toBe("vod-7");
    expect(document.activeElement).toBe(restored);
  });

  it("does not restore a card from the other kind's rails", () => {
    const mountKind = vi.fn(() => {
      const host = document.createElement("div");
      host.id = "browse-series-couch-browse-rails";
      host.innerHTML = `
        <section class="rs-rail" data-nylah-rail="series-recent" aria-label="Recently Added">
          <div class="rs-rail__row">
            <a href="/series/detail?id=9" data-nylah-item data-couch-key="series-9" class="rs-card">Nine</a>
          </div>
        </section>`;
      document.getElementById("browse-series")?.appendChild(host);
    });
    mountBrowsePage({ search: "?type=series", mountKind });

    // Memory points at a movies rail that is not on this view.
    recordCouchFocus({ route: "/browse", rail: "movies-recent", index: 0, key: "vod-7" });
    expect(restoreCouchFocus(document)).toBeNull();
  });
});

describe("browse.astro markup contract", () => {
  it("hosts DiscoverView and both catalogue sections, each with its own prefixed ids", () => {
    expect(browseAstro).toContain("DiscoverView");
    expect(browseAstro).toContain('id="browse-discover"');
    expect(browseAstro).toContain('id="browse-movies"');
    expect(browseAstro).toContain('id="browse-series"');
    for (const prefix of ["browse-movies-", "browse-series-"]) {
      for (const id of [
        "couch-browse-status",
        "couch-browse-hero-count",
        "couch-browse-tabs",
        "couch-browse-genres",
        "couch-browse-year",
        "couch-browse-rating",
        "couch-browse-sort",
        "couch-browse-search",
        "couch-browse-rails",
        "couch-browse-grid",
        "couch-browse-skeleton",
        "couch-browse-empty",
        "couch-browse-error",
      ]) {
        expect(browseAstro).toContain(`id="${prefix}${id}"`);
      }
      // One search dialog per kind, wired to its own open button.
      expect(browseAstro).toContain(`id="${prefix}couch-search-dialog"`);
      expect(browseAstro).toContain(
        `data-couch-dialog-open="${prefix}couch-search-dialog"`,
      );
    }
  });

  it("has no bare (unprefixed) couch-browse ids — the two controllers would collide", () => {
    const bare = browseAstro.match(/id="couch-browse-[a-z-]+"/g) ?? [];
    expect(bare).toEqual([]);
    const bareDialog = browseAstro.match(/id="couch-search-dialog"/g) ?? [];
    expect(bareDialog).toEqual([]);
  });

  it("keeps the empty states for both kinds on the page", () => {
    expect(browseAstro).toContain('id="browse-movies-couch-browse-empty"');
    expect(browseAstro).toContain('id="browse-series-couch-browse-empty"');
    expect(browseAstro).toContain("No movies yet");
    expect(browseAstro).toContain("No series yet");
  });

  it("mounts W2's TvSearchAction in the search slot (integration)", () => {
    // Integration wired W2's component into W1's slot: the slot is
    // no longer empty — it mounts the search action client:load so
    // the return trip from /search restores focus to it.
    expect(browseAstro).toContain("browse-search-slot");
    expect(browseAstro).toContain(
      'import TvSearchAction from "@/components/couch/TvSearchAction.svelte"',
    );
    expect(browseAstro).toMatch(/<TvSearchAction client:load \/>/);
  });

  it("does not reintroduce serif or rebuild the Discover engines", () => {
    expect(browseAstro.toLowerCase()).not.toContain("serif");
    expect(browseAstro).not.toContain("discover.ts");
    expect(browseAstro).not.toContain("taste.ts");
  });
});
