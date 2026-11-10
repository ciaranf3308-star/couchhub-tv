/**
 * @vitest-environment jsdom
 */
// W8 pillfest audit + Browse filter cleanup.
//
// The Browse/Movies/Series views used to render every filter as its own
// row of small pill buttons: one button per genre (a 20-genre library
// meant 20 pills), five list tabs, and six mood chips on the Discover
// landing. This file proves the replacement holds:
//   - genre filter: ONE labelled <select> in the filter row, same
//     options (All genres + every catalogue genre with its count),
//     same filtering behaviour;
//   - list tabs: ONE joined segmented control, same five lists, same
//     switching behaviour;
//   - Discover moods: six large cards, not a pill row;
//   - every filter control is reachable by keyboard/controller focus.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCouchFocusMemory } from "@/scripts/lib/couch-focus";
import type { MovieRow } from "@/scripts/movies/couch-movies";

const here = dirname(fileURLToPath(import.meta.url));
const browseAstro = readFileSync(resolve(here, "../src/pages/browse.astro"), "utf8");
const moviesAstro = readFileSync(
  resolve(here, "../src/pages/movies/index.astro"),
  "utf8",
);
const seriesAstro = readFileSync(
  resolve(here, "../src/pages/series/index.astro"),
  "utf8",
);
const discoverView = readFileSync(
  resolve(here, "../src/components/DiscoverView.svelte"),
  "utf8",
);

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
// has a box so the grid windowing behaves like a real viewport. The
// rect must be complete — renderGridWindow divides by top/scroll math,
// and a missing `top` (undefined) turns the whole window NaN.
Element.prototype.getBoundingClientRect = function () {
  return {
    width: 100,
    height: 100,
    top: 0,
    left: 0,
    bottom: 100,
    right: 100,
    x: 0,
    y: 0,
  } as DOMRect;
};
// jsdom does not implement window.scrollTo; the controller scrolls to
// the top on every filter change — stub it instead of failing.
window.scrollTo = () => {};

function movieRow(overrides: Partial<MovieRow> = {}): MovieRow {
  return {
    id: 1,
    name: "Test Film",
    logo: null,
    year: "2024",
    rating: "8.4",
    duration: "125",
    category: "Action",
    plot: "",
    added: 100,
    norm: "test film action 2024",
    tmdb: null,
    ...overrides,
  };
}

// Four titles across three genres, three decades, four ratings.
const FAKE_ROWS: MovieRow[] = [
  movieRow({ id: 1, name: "Alpha", year: "2024", rating: "8.4", added: 300, category: "Action", norm: "alpha action 2024" }),
  movieRow({ id: 2, name: "Beta", year: "1998", rating: "6.1", added: 100, category: "Drama", norm: "beta drama 1998" }),
  movieRow({ id: 3, name: "Gamma", year: "", rating: "", added: 200, category: "Action", norm: "gamma action" }),
  movieRow({ id: 4, name: "Delta", year: "2015", rating: "7.2", added: 250, category: "Comedy", norm: "delta comedy 2015" }),
];

const { loadCouchCatalogMock } = vi.hoisted(() => ({
  loadCouchCatalogMock: vi.fn(),
}));

vi.mock("@/scripts/movies/couch-catalog.ts", () => ({
  loadCouchCatalog: loadCouchCatalogMock,
}));

// The mock is hoisted above the imports; the controller module is
// imported after it so the stubbed loader is what boot() calls.
const { mountCouchBrowse } = await import("@/scripts/movies/couch-browse.ts");
const { moviesAdapter } = await import("@/scripts/movies/couch-movies-adapter.ts");

/** Bare-id Movies section markup, mirroring src/pages/movies/index.astro. */
function renderMoviesDom(): void {
  document.body.innerHTML = `
    <header><h1>Movies</h1>
      <p><span id="couch-browse-hero-count">—</span><span id="couch-browse-status">Loading…</span></p>
    </header>
    <section class="rs-browse-toolbar" aria-label="Browse controls">
      <div class="rs-browse-search">
        <label for="couch-browse-search">Search movies</label>
        <input id="couch-browse-search" type="search" placeholder="Search movies…" autocomplete="off" />
      </div>
      <div class="rs-browse-selects">
        <label for="couch-browse-sort">Sort</label>
        <select id="couch-browse-sort">
          <option value="default">Default</option>
          <option value="added">Recently added</option>
          <option value="rating">Rating</option>
          <option value="year-desc">Year (newest)</option>
          <option value="year-asc">Year (oldest)</option>
          <option value="az">A–Z</option>
        </select>
        <label for="couch-browse-year">Decade</label>
        <select id="couch-browse-year">
          <option value="">Any decade</option>
          <option value="2020s">2020s</option>
          <option value="2010s">2010s</option>
          <option value="1990s">1990s</option>
        </select>
        <label for="couch-browse-rating">Rating</label>
        <select id="couch-browse-rating">
          <option value="0">Any rating</option>
          <option value="6">6+</option>
          <option value="7">7+</option>
          <option value="8">8+</option>
          <option value="9">9+</option>
        </select>
        <div id="couch-browse-genres" class="rs-browse-genre-filter"></div>
      </div>
    </section>
    <div id="couch-browse-tabs" class="rs-browse-tabs rs-browse-segmented" role="group" aria-label="Movie lists"></div>
    <div id="couch-browse-rails"></div>
    <div id="couch-browse-skeleton"></div>
    <div id="couch-browse-empty" hidden></div>
    <div id="couch-browse-error" hidden role="alert"><p data-role="error-message"></p></div>
    <div id="couch-browse-grid" class="rs-grid" data-couch-grid aria-label="All movies" hidden></div>`;
}

const gridKeys = (): string[] =>
  Array.from(document.querySelectorAll("#couch-browse-grid [data-couch-key]")).map(
    (el) => el.getAttribute("data-couch-key")!,
  );

const heroCount = (): string =>
  document.getElementById("couch-browse-hero-count")?.textContent ?? "";

async function mountLoadedCatalogue(): Promise<void> {
  loadCouchCatalogMock.mockResolvedValue({
    rows: FAKE_ROWS,
    playlistId: "pl-1",
    playlistTitle: "Test",
    fromCache: true,
    loadError: false,
  });
  mountCouchBrowse(moviesAdapter);
  // boot() is async (initI18n + catalogue load); wait until the genre
  // select — rendered last, after the load — is on the page.
  await vi.waitFor(() => {
    expect(document.querySelector("#couch-browse-genres select")).not.toBeNull();
  });
  // Let the grid's rAF render settle.
  await new Promise((r) => setTimeout(r, 50));
}

describe("genre filter: one select, every option, same behaviour", () => {
  beforeEach(() => {
    renderMoviesDom();
    sessionStorageMock.clear();
    localStorageMock.clear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    clearCouchFocusMemory();
    loadCouchCatalogMock.mockReset();
  });

  it("renders ONE labelled Genre select — no per-genre buttons", async () => {
    await mountLoadedCatalogue();
    const host = document.getElementById("couch-browse-genres")!;
    expect(host.querySelectorAll("button").length).toBe(0);
    const selects = host.querySelectorAll("select");
    expect(selects.length).toBe(1);
    const select = selects[0] as HTMLSelectElement;
    expect(select.id).toBe("couch-browse-genre");
    expect(select.getAttribute("aria-label")).toBe("Filter by genre");
    const label = host.querySelector("label");
    expect(label?.textContent).toBe("Genre");
    expect(label?.htmlFor).toBe("couch-browse-genre");
  });

  it("lists every catalogue genre with its count, most frequent first", async () => {
    await mountLoadedCatalogue();
    const options = Array.from(
      document.querySelectorAll("#couch-browse-genres select option"),
    ).map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent }));
    expect(options).toEqual([
      { value: "", text: "All genres" },
      { value: "action", text: "Action (2)" },
      { value: "comedy", text: "Comedy (1)" },
      { value: "drama", text: "Drama (1)" },
    ]);
    expect((document.querySelector("#couch-browse-genres select") as HTMLSelectElement).value).toBe("");
  });

  it("filters the grid by genre and back to All", async () => {
    await mountLoadedCatalogue();
    expect(heroCount()).toBe("4 movies");
    const select = document.querySelector(
      "#couch-browse-genres select",
    ) as HTMLSelectElement;
    select.value = "action";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(heroCount()).toBe("2 movies");
    expect(gridKeys()).toEqual(["vod-1", "vod-3"]);
    select.value = "drama";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(heroCount()).toBe("1 movie");
    expect(gridKeys()).toEqual(["vod-2"]);
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(heroCount()).toBe("4 movies");
    expect(gridKeys()).toEqual(["vod-1", "vod-2", "vod-3", "vod-4"]);
  });

  it("keeps focus on the genre select across re-renders", async () => {
    await mountLoadedCatalogue();
    const select = document.querySelector(
      "#couch-browse-genres select",
    ) as HTMLSelectElement;
    select.focus();
    expect(document.activeElement).toBe(select);
    select.value = "comedy";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.activeElement).toBe(select);
    expect(gridKeys()).toEqual(["vod-4"]);
  });
});

describe("list tabs: one segmented control, all five lists work", () => {
  beforeEach(() => {
    renderMoviesDom();
    sessionStorageMock.clear();
    localStorageMock.clear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    clearCouchFocusMemory();
    loadCouchCatalogMock.mockReset();
  });

  it("renders five joined segments, not five separate pills", async () => {
    await mountLoadedCatalogue();
    const host = document.getElementById("couch-browse-tabs")!;
    expect(host.classList.contains("rs-browse-segmented")).toBe(true);
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual([
      "All Movies",
      "Continue Watching",
      "Recently Added",
      "Favourites",
      "Watch Later",
    ]);
    for (const b of buttons) {
      expect(b.classList.contains("rs-browse-segment")).toBe(true);
      expect(b.getAttribute("aria-pressed")).not.toBeNull();
    }
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("switching lists filters the grid and restores on All", async () => {
    await mountLoadedCatalogue();
    const tab = (label: string) =>
      Array.from(document.querySelectorAll("#couch-browse-tabs button")).find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;
    // No favourites stored, so the Favourites list is empty.
    tab("Favourites").click();
    expect(heroCount()).toBe("0 movies");
    expect(gridKeys()).toEqual([]);
    expect(document.getElementById("couch-browse-empty")?.hidden).toBe(false);
    expect(tab("Favourites").getAttribute("aria-pressed")).toBe("true");
    tab("All Movies").click();
    expect(heroCount()).toBe("4 movies");
    expect(gridKeys()).toEqual(["vod-1", "vod-2", "vod-3", "vod-4"]);
    // Watch Later with nothing saved: the list is empty, not a crash.
    // (W8: this path used to throw — getWatchlist returns a map, and
    // the adapter called .has() on it — so rails never rendered and
    // the grid never painted on an unfiltered load.)
    tab("Watch Later").click();
    expect(heroCount()).toBe("0 movies");
    expect(gridKeys()).toEqual([]);
    expect(document.getElementById("couch-browse-empty")?.hidden).toBe(false);
    tab("All Movies").click();
    expect(heroCount()).toBe("4 movies");
  });

  it("the other filter row controls still filter and sort", async () => {
    await mountLoadedCatalogue();
    const year = document.getElementById("couch-browse-year") as HTMLSelectElement;
    year.value = "2020s";
    year.dispatchEvent(new Event("change", { bubbles: true }));
    expect(gridKeys()).toEqual(["vod-1"]);
    year.value = "";
    year.dispatchEvent(new Event("change", { bubbles: true }));

    const rating = document.getElementById("couch-browse-rating") as HTMLSelectElement;
    rating.value = "8";
    rating.dispatchEvent(new Event("change", { bubbles: true }));
    expect(gridKeys()).toEqual(["vod-1"]);
    rating.value = "0";
    rating.dispatchEvent(new Event("change", { bubbles: true }));

    const sort = document.getElementById("couch-browse-sort") as HTMLSelectElement;
    sort.value = "rating";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    expect(gridKeys()).toEqual(["vod-1", "vod-4", "vod-2", "vod-3"]);

    // Search narrows the grid too (debounced 160ms).
    const search = document.getElementById("couch-browse-search") as HTMLInputElement;
    sort.value = "default";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    search.value = "beta";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    expect(gridKeys()).toEqual(["vod-2"]);
  });

  it("keyboard/controller focus reaches every filter control", async () => {
    await mountLoadedCatalogue();
    const focusables: HTMLElement[] = [
      document.getElementById("couch-browse-search")!,
      document.getElementById("couch-browse-sort")!,
      document.getElementById("couch-browse-year")!,
      document.getElementById("couch-browse-rating")!,
      document.querySelector("#couch-browse-genres select") as HTMLElement,
      ...(Array.from(
        document.querySelectorAll("#couch-browse-tabs button"),
      ) as HTMLElement[]),
    ];
    expect(focusables.length).toBe(10);
    for (const el of focusables) {
      el.focus();
      expect(document.activeElement).toBe(el);
    }
  });
});

describe("no pill-cluster markup remains in the Browse views", () => {
  it("the genre mount point lives inside the filter row on all three pages", () => {
    for (const [name, src] of [
      ["browse.astro", browseAstro],
      ["movies/index.astro", moviesAstro],
      ["series/index.astro", seriesAstro],
    ] as const) {
      // The Genre select mount sits after the Rating select and before
      // the list tabs — i.e. inside the one filter row.
      for (const prefix of name === "browse.astro"
        ? ["browse-movies-", "browse-series-"]
        : [""]) {
        const ratingIdx = src.indexOf(`id="${prefix}couch-browse-rating"`);
        const genreIdx = src.indexOf(`id="${prefix}couch-browse-genres"`);
        const tabsIdx = src.indexOf(`id="${prefix}couch-browse-tabs"`);
        expect(ratingIdx, `${name} ${prefix} rating`).toBeGreaterThan(-1);
        expect(genreIdx, `${name} ${prefix} genre mount`).toBeGreaterThan(-1);
        expect(tabsIdx, `${name} ${prefix} tabs`).toBeGreaterThan(-1);
        expect(genreIdx, `${name} ${prefix} genre after rating`).toBeGreaterThan(ratingIdx);
        expect(genreIdx, `${name} ${prefix} genre before tabs`).toBeLessThan(tabsIdx);
      }
      expect(src).toContain("rs-browse-segmented");
      expect(src).toContain("rs-browse-genre-filter");
      expect(src).not.toContain('class="rs-browse-genres"');
    }
  });

  it("the Discover landing has large mood cards and no pill chips", () => {
    expect(discoverView).not.toContain("rs-discover-chip");
    expect(discoverView).not.toContain("border-radius: 9999px");
    expect(discoverView).toContain("rs-discover-mood");
    expect(discoverView).toContain("rs-discover__mood-grid");
    expect(discoverView).toContain("moodSubtitle");
    // Every mood preset renders as a card with D-pad focus + pressed state.
    expect(discoverView).toContain("MOOD_PRESETS");
    expect(discoverView).toContain('data-nylah-item');
    expect(discoverView).toMatch(/class="rs-discover-mood"/);
    // Feedback actions are a clean rectangular row, not pills.
    expect(discoverView).toContain("discover-fb-btn");
  });

  it("the type segmented control is untouched (three items, still the pattern)", () => {
    expect(browseAstro).toContain('data-browse-type="all"');
    expect(browseAstro).toContain('data-browse-type="movies"');
    expect(browseAstro).toContain('data-browse-type="series"');
  });
});
