/**
 * @vitest-environment jsdom
 */
// 0.11.8 W3 — Movies Home DOM render (movies-home-mount.ts).
//
// Paints the model into a DOM mirroring src/pages/movies/index.astro
// and proves the structural contract: Home never mounts the full
// catalogue grid (acceptance test 1), empty sections are omitted,
// states are honest and distinct, focus restores to the exact
// poster, and keyboard shelf-jump moves between sections. Fake
// models only — no provider, no catalogue load. Rect mocking follows
// tests/couch-focus-seed-0111.test.ts (couchRailItems needs visible
// geometry).

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  adjacentHomeSectionId,
  installHomeShelfJump,
  paintMoviesHome,
  readPicksSeed,
  repaintPicks,
  restoreMoviesHomeFocus,
  showMoviesHomeMessage,
  writePicksSeed,
} from "@/scripts/movies/movies-home-mount";
import {
  RECENTLY_ADDED_LIMIT,
  WORTH_WATCHING_LIMIT,
  buildMoviesHomeModel,
} from "@/scripts/movies/movies-home";
import { clearCouchFocusMemory, recordCouchFocus } from "@/scripts/lib/couch-focus";
import { emptyTasteModel } from "@/scripts/lib/taste";
import { daysAgoSeconds, movieRow } from "./movies-home-0118-fixtures";

const NOW = Date.parse("2026-11-12T12:00:00Z");

function fullRect(): DOMRect {
  return {
    width: 200,
    height: 300,
    top: 0,
    left: 0,
    right: 200,
    bottom: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

/** DOM mirroring the home root in src/pages/movies/index.astro. */
function buildHomeDom(): HTMLElement {
  document.body.innerHTML = `
    <header data-couch-nav><nav><div data-nylah-rail="couch-nav">
      <a data-nylah-item href="/" id="nav-home">Home</a>
      <a data-nylah-item href="/movies" aria-current="page" id="nav-movies">Movies</a>
    </div></nav></header>
    <div id="movies-home-root">
      <header class="mh-header">
        <div class="mh-header__titles">
          <h1 class="rs-page-title">Movies</h1>
          <p class="rs-meta"><span id="movies-home-count">Loading…</span></p>
        </div>
        <div class="mh-header__actions" data-nylah-rail="movies-home-actions">
          <a data-nylah-item data-couch-key="movies-search" href="/movies?view=browse&focus=search">Search Movies</a>
          <a data-nylah-item data-couch-key="movies-browse" href="/movies?view=browse">Browse Everything</a>
        </div>
      </header>
      <div id="movies-home-skeleton"><div>loading</div></div>
      <div id="movies-home-nolist" hidden><h2>No playlist yet</h2></div>
      <div id="movies-home-empty" hidden><h2>No movies yet</h2></div>
      <div id="movies-home-error" hidden role="alert">
        <p id="movies-home-error-message"></p>
        <button id="movies-home-retry" type="button">Try again</button>
      </div>
      <div id="movies-home-featured"></div>
      <div id="movies-home-continue"></div>
      <div id="movies-home-worth"></div>
      <div id="movies-home-recent"></div>
      <div id="movies-home-genres"></div>
      <section id="movies-home-browse-entry" data-nylah-rail="movies-browse-entry" hidden>
        <a data-nylah-item data-couch-key="movies-browse-entry" href="/movies?view=browse">
          <span>Browse Everything</span>
          <span id="movies-home-browse-count"></span>
        </a>
      </section>
    </div>`;
  const proto = Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
    scrollIntoView: () => void;
  };
  proto.getBoundingClientRect = () => fullRect();
  proto.scrollIntoView = () => {};
  return document.getElementById("movies-home-root") as HTMLElement;
}

function libraryModel(overrides: { progressCount?: number } = {}) {
  const genres = ["Action", "Comedy", "Horror", "Thriller", "Science Fiction", "Drama"];
  const rows = Array.from({ length: 40 }, (_, i) =>
    movieRow({
      id: 200 + i,
      name: `Library Film ${i}`,
      rating: i % 3 === 0 ? "8.6" : "7.4",
      tmdb: 2000 + i,
      category: genres[i % genres.length],
      plot: i % 2 === 0 ? `Synopsis for film ${i}.` : "",
      added: daysAgoSeconds((i % 12) + 1, NOW),
    }),
  );
  const progress = new Map(
    rows.slice(0, overrides.progressCount ?? 3).map((row, i) => [
      row.id,
      { position: 600, duration: 3600, updatedAt: 1000 - i },
    ]),
  );
  return buildMoviesHomeModel({
    rows,
    playlistId: "p1",
    taste: emptyTasteModel("shared", "p1"),
    progressById: progress,
    nowMs: NOW,
  });
}

beforeEach(() => {
  clearCouchFocusMemory();
  sessionStorage.clear();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe("paintMoviesHome — structure (§1.1, §2, §3)", () => {
  it("ACCEPTANCE 1: Home never mounts the full catalogue grid", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    expect(root.querySelector("[data-couch-grid]")).toBeNull();
    expect(root.querySelector("#couch-browse-grid")).toBeNull();
    expect(document.querySelector("[data-couch-grid]")).toBeNull();
    // Curated shelves only: far fewer cards than the 40-title catalogue.
    const cards = root.querySelectorAll(".rs-card");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(40);
  });

  it("paints featured, shelves, genre tiles and the browse entry with real counts", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    expect(document.getElementById("movies-home-skeleton")?.hidden).toBe(true);
    expect(document.getElementById("movies-home-count")?.textContent).toBe("40 movies");
    expect(document.getElementById("movies-home-browse-count")?.textContent).toBe(
      "Browse all 40 films",
    );
    expect(document.getElementById("movies-home-browse-entry")?.hidden).toBe(false);

    const featured = document.getElementById("movies-home-featured");
    expect(featured?.querySelector(".mh-featured__title")?.textContent).toBeTruthy();
    expect(featured?.querySelector(".mh-featured__link")?.getAttribute("href")).toMatch(
      /^\/movies\/detail\?id=\d+$/,
    );
    expect(featured?.querySelector('[data-couch-key="movies-refresh-picks"]')).not.toBeNull();

    expect(
      document.querySelectorAll('[data-nylah-rail="movies-continue"] .rs-card').length,
    ).toBe(3);
    expect(
      document.querySelectorAll('[data-nylah-rail="movies-worth"] .rs-card').length,
    ).toBeLessThanOrEqual(WORTH_WATCHING_LIMIT);
    expect(
      document.querySelectorAll('[data-nylah-rail="movies-recent"] .rs-card').length,
    ).toBeLessThanOrEqual(RECENTLY_ADDED_LIMIT);

    const tiles = root.querySelectorAll(".mh-genre-tile");
    expect(tiles.length).toBe(7);
    const actionTile = root.querySelector('[data-couch-key="movies-genre-action"]');
    expect(actionTile?.getAttribute("href")).toBe("/movies?view=browse&category=genre%3Aaction");
    expect(actionTile?.textContent).toContain("films");
  });

  it("caps Continue Watching at 8 visible with a View All destination", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel({ progressCount: 12 }));
    const cards = document.querySelectorAll('[data-nylah-rail="movies-continue"] .rs-card');
    expect(cards.length).toBe(8);
    const viewAll = document.querySelector('[data-couch-key="movies-viewall-continue"]');
    expect(viewAll?.getAttribute("href")).toBe("/movies?view=browse&category=collection%3Acontinue");
    expect(viewAll?.textContent).toContain("12 in progress");
  });

  it("View All Recently Added opens Browse sorted by date added", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    const viewAll = document.querySelector('[data-couch-key="movies-viewall-recent"]');
    expect(viewAll?.getAttribute("href")).toBe("/movies?view=browse&sort=added");
  });

  it("omits empty sections entirely — no blank shelves", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel({ progressCount: 0 }));
    expect(document.getElementById("movies-home-continue")?.hidden).toBe(true);
    expect(document.querySelector('[data-nylah-rail="movies-continue"]')).toBeNull();
    expect(document.getElementById("movies-home-worth")?.hidden).toBe(false);
  });

  it("renders the compact featured fallback without artwork or description", () => {
    const root = buildHomeDom();
    const model = buildMoviesHomeModel({
      rows: [movieRow({ id: 1, name: "Plain", logo: null, plot: "", rating: "", tmdb: null })],
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map(),
      nowMs: NOW,
    });
    paintMoviesHome(root, model);
    expect(
      document.querySelector(".mh-featured")?.classList.contains("mh-featured--compact"),
    ).toBe(true);
  });

  it("never labels local rankings as AI picks anywhere on Home", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    expect(root.textContent ?? "").not.toMatch(/AI picks/i);
    expect(root.textContent ?? "").not.toMatch(/AI recommendations/i);
  });

  it("Refresh Picks invokes the refresh callback", () => {
    const root = buildHomeDom();
    const onRefreshPicks = vi.fn();
    paintMoviesHome(root, libraryModel(), { onRefreshPicks });
    const button = root.querySelector(
      '[data-couch-key="movies-refresh-picks"]',
    ) as HTMLButtonElement;
    button.click();
    expect(onRefreshPicks).toHaveBeenCalledTimes(1);
  });

  it("repaintPicks keeps focus on Refresh Picks after the featured film changes", () => {
    const root = buildHomeDom();
    const onRefreshPicks = vi.fn();
    const first = libraryModel();
    paintMoviesHome(root, first, { onRefreshPicks });
    const before = root.querySelector('[data-couch-key="movies-refresh-picks"]') as HTMLElement;
    before.focus();
    expect(document.activeElement).toBe(before);
    const next = buildMoviesHomeModel({
      rows: Array.from({ length: 10 }, (_, i) =>
        movieRow({ id: 300 + i, name: `Alt ${i}`, rating: "8.5", tmdb: 3000 + i }),
      ),
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map(),
      rotationSeed: 2,
      nowMs: NOW,
    });
    repaintPicks(root, next, onRefreshPicks);
    const after = root.querySelector('[data-couch-key="movies-refresh-picks"]') as HTMLElement;
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });
});

describe("showMoviesHomeMessage (§18)", () => {
  it("shows exactly one state block at a time", () => {
    const root = buildHomeDom();
    showMoviesHomeMessage(root, "nolist");
    expect(document.getElementById("movies-home-nolist")?.hidden).toBe(false);
    expect(document.getElementById("movies-home-empty")?.hidden).toBe(true);
    expect(document.getElementById("movies-home-error")?.hidden).toBe(true);
    expect(document.getElementById("movies-home-skeleton")?.hidden).toBe(true);
    expect(document.getElementById("movies-home-browse-entry")?.hidden).toBe(true);
    expect(document.getElementById("movies-home-count")?.textContent).toBe("No playlist selected");

    showMoviesHomeMessage(root, "empty");
    expect(document.getElementById("movies-home-empty")?.hidden).toBe(false);
    expect(document.getElementById("movies-home-nolist")?.hidden).toBe(true);
    expect(document.getElementById("movies-home-count")?.textContent).toBe("0 movies");
  });

  it("an error state never calls a failed connection an empty catalogue", () => {
    const root = buildHomeDom();
    showMoviesHomeMessage(root, "error", "Could not reach Demo Provider. This is a connection problem.");
    const message = document.getElementById("movies-home-error-message")?.textContent ?? "";
    expect(message).toContain("connection problem");
    expect(message).not.toMatch(/no movies yet/i);
    expect(document.getElementById("movies-home-error")?.hidden).toBe(false);
  });
});

describe("restoreMoviesHomeFocus (§16.5)", () => {
  it("restores the exact poster by data-couch-key after paint", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    const worthCards = Array.from(
      document.querySelectorAll('[data-nylah-rail="movies-worth"] [data-couch-key]'),
    ) as HTMLElement[];
    expect(worthCards.length).toBeGreaterThan(1);
    const target = worthCards[1];
    const key = target.getAttribute("data-couch-key") as string;
    // Focus the nav (the layout's cold-launch seed) then restore.
    (document.getElementById("nav-movies") as HTMLElement).focus();
    recordCouchFocus({ route: window.location.pathname, rail: "movies-worth", index: 1, key });
    const restored = restoreMoviesHomeFocus(document);
    expect(restored).toBe(target);
    expect(document.activeElement).toBe(target);
  });

  it("falls back to rail + index (nearest surviving item) when the key is gone", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    (document.getElementById("nav-movies") as HTMLElement).focus();
    recordCouchFocus({
      route: window.location.pathname,
      rail: "movies-worth",
      index: 999,
      key: "vod-gone",
    });
    const restored = restoreMoviesHomeFocus(document);
    const cards = document.querySelectorAll('[data-nylah-rail="movies-worth"] [data-couch-key]');
    expect(restored).toBe(cards[cards.length - 1]);
  });

  it("never steals focus the viewer already moved", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    const card = document.querySelector(
      '[data-nylah-rail="movies-recent"] [data-couch-key]',
    ) as HTMLElement;
    card.focus();
    recordCouchFocus({ route: window.location.pathname, rail: "movies-worth", index: 0 });
    expect(restoreMoviesHomeFocus(document)).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("ignores memory recorded for another route", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    recordCouchFocus({ route: "/series", rail: "movies-worth", index: 0 });
    expect(restoreMoviesHomeFocus(document)).toBeNull();
  });
});

describe("shelf jump (§16.1 keyboard parity)", () => {
  it("adjacentHomeSectionId moves without wrapping", () => {
    const ids = ["a", "b", "c"];
    expect(adjacentHomeSectionId(ids, "a", "next")).toBe("b");
    expect(adjacentHomeSectionId(ids, "b", "prev")).toBe("a");
    expect(adjacentHomeSectionId(ids, "a", "prev")).toBeNull();
    expect(adjacentHomeSectionId(ids, "c", "next")).toBeNull();
    expect(adjacentHomeSectionId(ids, "missing", "next")).toBeNull();
  });

  it("PageDown moves focus to the first item of the next section", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    installHomeShelfJump(root);
    const first = document.querySelector(
      '[data-nylah-rail="movies-worth"] [data-couch-key]',
    ) as HTMLElement;
    first.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    const recentFirst = document.querySelector(
      '[data-nylah-rail="movies-recent"] [data-couch-key]',
    ) as HTMLElement;
    expect(document.activeElement).toBe(recentFirst);
  });

  it("PageUp at the first section does nothing", () => {
    const root = buildHomeDom();
    paintMoviesHome(root, libraryModel());
    installHomeShelfJump(root);
    const action = root.querySelector('[data-couch-key="movies-search"]') as HTMLElement;
    action.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(document.activeElement).toBe(action);
  });
});

describe("picks seed persistence", () => {
  it("round-trips and defaults invalid values to 0", () => {
    expect(readPicksSeed("p1")).toBe(0);
    writePicksSeed("p1", 3);
    expect(readPicksSeed("p1")).toBe(3);
    expect(readPicksSeed("other")).toBe(0);
    sessionStorage.setItem("movies-home-picks-seed:p1", "nonsense");
    expect(readPicksSeed("p1")).toBe(0);
  });
});
