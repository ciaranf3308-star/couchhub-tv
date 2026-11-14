/**
 * @vitest-environment jsdom
 */
// Homes render tests (0.11.14, W5) — Movies + Series Home DOM:
// new shelves paint with honest labels, refresh preserves focus
// and rail scroll through W1's mechanism, series links stay
// series-level, and Discover chips render with the AI prompt
// banner. Fake models only — no provider, no catalogue load.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  paintMoviesHome,
  repaintAiShelf,
  repaintDiscoverResults,
  repaintHomeShelves,
} from "@/scripts/movies/movies-home-mount";
import { buildMoviesHomeModel } from "@/scripts/movies/movies-home";
import { clearCouchFocusMemory } from "@/scripts/lib/couch-focus";
import { emptyTasteModel } from "@/scripts/lib/taste";
import { getCatalogIndex } from "@/scripts/lib/catalog-index.ts";
import {
  assembleSeriesHomeSections,
  seriesDetailHref,
} from "@/scripts/series/series-home-model";
import { renderSeriesHome } from "@/scripts/series/series-home-render";
import { mapSeriesRow, type SeriesRow } from "@/scripts/series/couch-series.ts";
import type { HomeAiPick } from "@/scripts/lib/home-ai-picks.ts";
import { discoverPromptsFor } from "@/scripts/lib/home-discover-entries.ts";
import { daysAgoSeconds, movieRow } from "./movies-home-0118-fixtures";

const NOW = Date.parse("2026-11-12T12:00:00Z");

function fullRect(): DOMRect {
  return {
    width: 200, height: 300, top: 0, left: 0, right: 200, bottom: 300, x: 0, y: 0,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

/** DOM mirroring the home root in src/pages/movies/index.astro — including ALL 0.11.14 mounts. */
function buildMoviesDom(): HTMLElement {
  document.body.innerHTML = `
    <div id="movies-home-root">
      <header class="mh-header">
        <div class="mh-header__titles">
          <h1 class="rs-page-title">Movies</h1>
          <p class="rs-meta"><span id="movies-home-count">Loading…</span></p>
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
      <div id="movies-home-ai"></div>
      <div id="movies-home-discover"></div>
      <div id="movies-home-discover-results"></div>
      <div id="movies-home-worth"></div>
      <div id="movies-home-different"></div>
      <div id="movies-home-gems"></div>
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

function libraryRows(count = 40) {
  const genres = ["Action", "Comedy", "Horror", "Thriller", "Science Fiction", "Drama"];
  return Array.from({ length: count }, (_, i) =>
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
}

function aiPick(id: string, title: string): HomeAiPick {
  return {
    compositeId: `movie:${id}`,
    kind: "movie",
    id,
    title,
    year: 2024,
    score: 1,
    reason: "Dark, tense, and brilliantly acted.",
    tmdbId: 2000,
  };
}

function moviesModel(overrides: Record<string, unknown> = {}, rowCount = 40) {
  return buildMoviesHomeModel({
    rows: libraryRows(rowCount),
    playlistId: "p1",
    taste: emptyTasteModel("shared", "p1"),
    progressById: new Map(),
    nowMs: NOW,
    ...overrides,
  } as never);
}

beforeEach(() => {
  clearCouchFocusMemory();
  sessionStorage.clear();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe("Movies Home render — new shelves + honest labels", () => {
  it("paints AI / Discover / Different / Gems shelves with verified picks", () => {
    const root = buildMoviesDom();
    // The Gems shelf renders whenever the model carries gems items
    // (render contract); whether the pipeline fills it depends on
    // catalogue evidence, so override the model directly here.
    const base = moviesModel({
      aiPicks: [aiPick("200", "Library Film 0"), aiPick("201", "Library Film 1")],
      aiAllowed: true,
      aiSource: "fresh-ai",
      aiModel: "gpt-4o-mini",
      aiConfigured: true,
    });
    const rows = libraryRows();
    const model = {
      ...base,
      hiddenGems: { items: [{ row: rows[5], reason: "Well-rated, rarely surfaced" }] },
    };
    paintMoviesHome(root, model, {});
    expect(root.querySelector('[data-nylah-rail="movies-ai-picks"]')).not.toBeNull();
    expect(root.querySelector('[data-nylah-rail="movies-discover-entries"]')).not.toBeNull();
    expect(root.querySelector('[data-nylah-rail="movies-different"]')).not.toBeNull();
    expect(root.querySelector('[data-nylah-rail="movies-gems"]')).not.toBeNull();
    expect(document.getElementById("movies-home-gems")!.textContent).toContain("Hidden Gems");
    const aiMount = document.getElementById("movies-home-ai")!;
    expect(aiMount.textContent).toContain("AI Picks for You");
    expect(aiMount.textContent).toContain("AI picks");
    expect(aiMount.textContent).toContain("gpt-4o-mini");
    // The AI card carries its grounded reason as focus detail.
    expect(aiMount.querySelector(".rs-card__detail")?.textContent).toContain("Dark, tense");
  });

  it("paints a Generate banner (not a shelf) when configured but no picks exist", () => {
    const root = buildMoviesDom();
    paintMoviesHome(root, moviesModel({ aiConfigured: true }), { onAiAction: vi.fn() });
    const aiMount = document.getElementById("movies-home-ai")!;
    // The banner carries the AI rail id (it IS the AI rail's prompt
    // state) but renders no cards — only the Generate action.
    expect(aiMount.querySelector(".rs-card")).toBeNull();
    expect(aiMount.textContent).toContain("Generate AI Picks");
    expect(aiMount.querySelector("button")?.textContent).toContain("Generate AI Picks");
  });

  it("hides the AI shelf entirely when AI is off, but keeps Discover chips (local fallback)", () => {
    const root = buildMoviesDom();
    paintMoviesHome(root, moviesModel({ aiConfigured: false }), {});
    const aiMount = document.getElementById("movies-home-ai")!;
    expect(aiMount.textContent).not.toContain("Generate AI Picks");
    expect(aiMount.hidden || aiMount.children.length === 0).toBe(true);
    const discover = document.getElementById("movies-home-discover")!;
    expect(discover.querySelectorAll(".mh-chip").length).toBe(6);
    expect(discover.textContent).toContain("Surprise me");
  });

  it("labels the featured refresh as local-only, distinct from Generate", () => {
    const root = buildMoviesDom();
    paintMoviesHome(root, moviesModel({ aiConfigured: true }), {
      onRefreshPicks: vi.fn(),
      onAiAction: vi.fn(),
    });
    const featured = document.getElementById("movies-home-featured")!;
    const refresh = [...featured.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Refresh local picks"),
    );
    expect(refresh).toBeTruthy();
    expect(refresh!.getAttribute("aria-label")).toContain("no AI request");
  });

  it("repaintAiShelf swaps only the AI shelf and keeps focus on a Worth card", () => {
    const root = buildMoviesDom();
    paintMoviesHome(root, moviesModel({ aiConfigured: true }), { onAiAction: vi.fn() });
    const worthCard = root.querySelector<HTMLElement>(
      '[data-nylah-rail="movies-worth"] [data-nylah-item]',
    )!;
    worthCard.focus();
    const keyBefore = worthCard.getAttribute("data-couch-key");
    repaintAiShelf(
      root,
      moviesModel({
        aiPicks: [aiPick("200", "Library Film 0")],
        aiAllowed: true,
        aiSource: "fresh-ai",
        aiConfigured: true,
      }),
      { onAiAction: vi.fn() },
    );
    expect(document.activeElement?.getAttribute("data-couch-key")).toBe(keyBefore);
    expect(root.querySelector('[data-nylah-rail="movies-ai-picks"]')).not.toBeNull();
  });

  it("repaintHomeShelves preserves focus and rail scroll positions", () => {
    const root = buildMoviesDom();
    paintMoviesHome(root, moviesModel({}), {});
    const worthRow = root.querySelector<HTMLElement>(
      '[data-nylah-rail="movies-worth"] .rs-rail__row',
    )!;
    worthRow.scrollLeft = 240;
    const cards = [...root.querySelectorAll<HTMLElement>('[data-nylah-rail="movies-worth"] [data-nylah-item]')];
    cards[2].focus();
    const keyBefore = cards[2].getAttribute("data-couch-key");
    repaintHomeShelves(root, moviesModel({}), {});
    expect(document.activeElement?.getAttribute("data-couch-key")).toBe(keyBefore);
    const worthRowAfter = root.querySelector<HTMLElement>(
      '[data-nylah-rail="movies-worth"] .rs-rail__row',
    )!;
    expect(worthRowAfter.scrollLeft).toBe(240);
  });

  it("repaintDiscoverResults returns the first result card for the user-initiated focus move", () => {
    const root = buildMoviesDom();
    paintMoviesHome(root, moviesModel({}), {});
    const rows = libraryRows();
    const first = repaintDiscoverResults(root, {
      prompt: discoverPromptsFor("movie")[0],
      items: [{ row: rows[0], reason: "Dark, tense." }],
      source: "fresh-ai",
      note: "AI picks",
      discoverHref: "/discover?q=x&kind=movie",
    });
    expect(first).not.toBeNull();
    expect(first!.closest('[data-nylah-rail="movies-discover-results"]')).not.toBeNull();
    expect(document.getElementById("movies-home-discover-results")!.textContent).toContain("Open in Discover");
  });
});

describe("Series Home render — sections, series-only hrefs, chips", () => {
  function seriesRow(id: number, name: string, category = "Drama"): SeriesRow {
    const mapped = mapSeriesRow({
      series_id: id,
      name,
      cover: `https://example.test/poster-${id}.jpg`,
      year: "2024",
      rating: "8.5",
      category_name: category,
      last_modified: 0,
      tmdb: id,
    });
    if (!mapped) throw new Error(`fixture row did not map: ${name}`);
    return mapped;
  }

  function render(overrides: Record<string, unknown> = {}, rowCount = 3) {
    const categories = ["Drama", "Comedy", "Crime", "Fantasy", "Horror", "Thriller"];
    const rows = Array.from({ length: rowCount }, (_, i) =>
      seriesRow(i + 1, `${categories[i % categories.length]} Hit ${i}`, categories[i % categories.length]),
    );
    const sections = assembleSeriesHomeSections({
      index: getCatalogIndex("series", rows, "homes-w5-render-test", {}),
      rowsById: new Map(rows.map((r) => [r.id, r])),
      continueInputs: [],
      notificationGroups: [],
      subscriptions: [],
      taste: null,
      startedIds: [],
      ...overrides,
    } as never);
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderSeriesHome(root, sections, { playlistId: "p1", onAiAction: vi.fn() });
    return { root, sections, rows };
  }

  it("renders AI picks with series detail hrefs — never episode URLs", () => {
    const pick: HomeAiPick = {
      compositeId: "series:2",
      kind: "series",
      id: "2",
      title: "Comedy Hit",
      year: 2024,
      score: 1,
      reason: "Gripping from the first episode.",
      tmdbId: 2,
    };
    const { root } = render({ aiPicks: [pick], aiAllowed: true, aiSource: "fresh-ai" });
    const aiRail = root.querySelector('[data-nylah-rail="series-home-ai-picks"]')!;
    expect(aiRail).not.toBeNull();
    const links = [...aiRail.querySelectorAll("a[href]")];
    expect(links.length).toBeGreaterThan(0);
    expect(links.map((a) => a.getAttribute("href"))).toContain(seriesDetailHref(2));
    expect(links.every((a) => !/episode|season/i.test(a.getAttribute("href") ?? ""))).toBe(true);
    expect(aiRail.textContent).toContain("Gripping from the first episode.");
  });

  it("renders the AI prompt banner + Discover chips when configured without picks", () => {
    const { root } = render({ aiConfigured: true });
    expect(root.querySelector(".rs-series-home-ai-prompt")).not.toBeNull();
    expect(root.textContent).toContain("Generate AI Picks");
    const chips = root.querySelectorAll(".rs-series-home-chip");
    expect(chips.length).toBe(6);
    expect(root.textContent).toContain("A gripping crime series");
  });

  it("renders Something Different / Undiscovered sections with View All tiles", () => {
    const { root } = render({}, 24);
    expect(root.querySelector('[data-nylah-rail="series-home-something-different"]')).not.toBeNull();
    // Undiscovered renders whenever the model carries the section;
    // pipeline fill depends on catalogue evidence (see the Movies
    // gems test above), so render the section directly here.
    const rows = [seriesRow(9, "Hidden Drama", "Drama")];
    const direct = document.createElement("div");
    document.body.appendChild(direct);
    renderSeriesHome(
      direct,
      [
        {
          kind: "undiscovered",
          id: "series-home-undiscovered",
          title: "Undiscovered Series",
          subtitle: "Well-rated series that rarely get surfaced",
          items: [{ row: rows[0], reason: "Well-rated, rarely surfaced" }],
        },
      ],
      { playlistId: "p1" },
    );
    expect(direct.querySelector('[data-nylah-rail="series-home-undiscovered"]')).not.toBeNull();
    expect(direct.textContent).toContain("Undiscovered Series");
  });
});
