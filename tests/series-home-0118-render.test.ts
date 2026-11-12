
// @vitest-environment jsdom
// Series Home render tests (0.11.8, W4) — DOM shelves: rail/focus
// contract, card content, omission, no full-catalogue grid, focus
// restoration by stable key, and the §18 states.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapSeriesRow, type SeriesRow } from "@/scripts/series/couch-series.ts";
import {
  assembleSeriesHomeSections,
  type ContinueWatchingInput,
} from "@/scripts/series/series-home-model.ts";
import {
  renderSeriesHome,
  renderSeriesHomeState,
} from "@/scripts/series/series-home-render.ts";
import {
  readCouchFocusMemory,
  recordCouchFocus,
  restoreCouchFocus,
} from "@/scripts/lib/couch-focus.ts";

function row(
  id: number,
  name: string,
  opts: {
    category?: string;
    rating?: string;
    year?: string;
    added?: number;
    tmdb?: number;
    logo?: string | null;
  } = {},
): SeriesRow {
  const mapped = mapSeriesRow({
    series_id: id,
    name,
    cover: opts.logo === undefined ? `https://example.test/${id}.jpg` : opts.logo,
    year: opts.year ?? "2024",
    rating: opts.rating ?? "",
    category_name: opts.category ?? "Drama",
    last_modified: opts.added ?? 0,
    tmdb: opts.tmdb ?? 0,
  });
  if (!mapped) throw new Error(`fixture row did not map: ${name}`);
  return mapped;
}

let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("div");
  root.id = "series-home-root";
  document.body.appendChild(root);
  window.history.replaceState(null, "", "/series");
  sessionStorage.clear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 200,
    height: 300,
    top: 0,
    left: 0,
    right: 200,
    bottom: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sectionsFor(rows: SeriesRow[], continueInputs: ContinueWatchingInput[] = []) {
  return assembleSeriesHomeSections({
    rows,
    rowsById: new Map(rows.map((r) => [r.id, r])),
    continueInputs,
    notificationGroups: [],
    subscriptions: [],
    hasProgress: () => false,
  });
}

describe("renderSeriesHome — shelves and the rail/focus contract", () => {
  it("renders shelves as data-nylah-rail sections with marked, keyed cards", () => {
    const rows = [
      row(1, "Drama Hit", { rating: "8.6", tmdb: 11, added: 100 }),
      row(2, "Comedy Hit", { category: "Comedy", rating: "8.2", tmdb: 12, added: 200 }),
    ];
    renderSeriesHome(root, sectionsFor(rows), { playlistId: "pl1" });
    const rails = root.querySelectorAll("[data-nylah-rail]");
    expect(rails.length).toBeGreaterThan(0);
    for (const rail of rails) {
      expect(rail.querySelectorAll("[data-nylah-item]").length).toBeGreaterThan(0);
    }
    const keys = [...root.querySelectorAll("[data-couch-key]")].map((el) =>
      el.getAttribute("data-couch-key"),
    );
    expect(keys).toContain("series-1");
    expect(keys).toContain("series-2");
    expect(keys).toContain("browse-everything");
    // Keys are unique WITHIN each rail (focus memory resolves
    // rail-first, then key). The same series legitimately appears in
    // several shelves — as on the existing browse page (rails + grid
    // share row keys) — so global uniqueness is not required.
    for (const rail of rails) {
      const railKeys = [...rail.querySelectorAll("[data-couch-key]")].map((el) =>
        el.getAttribute("data-couch-key"),
      );
      expect(new Set(railKeys).size).toBe(railKeys.length);
    }
  });

  it("never mounts the full catalogue grid: card count stays shelf-bounded on a big catalogue", () => {
    const rows: SeriesRow[] = [];
    for (let i = 1; i <= 500; i++) {
      rows.push(
        row(i, `Show ${i}`, {
          category: i % 2 ? "Drama" : "Comedy",
          rating: "8.0",
          tmdb: i,
          added: i,
        }),
      );
    }
    renderSeriesHome(root, sectionsFor(rows), { playlistId: "pl1" });
    expect(root.querySelector("#couch-browse-grid")).toBeNull();
    expect(root.querySelector("[data-couch-grid]")).toBeNull();
    // Shelves cap at 12 each + view-all tiles + genre tiles + entry:
    // far below 500, and bounded no matter how big the catalogue is.
    expect(root.querySelectorAll("[data-nylah-item]").length).toBeLessThan(80);
  });

  it("renders Continue Watching cards with episode badge, progress and the safe href", () => {
    const series = row(1, "Slow Horses", { rating: "8.6", tmdb: 11, added: 100 });
    renderSeriesHome(
      root,
      sectionsFor(
        [series],
        [
          {
            row: series,
            lastProgress: {
              episodeId: 9001,
              season: 2,
              episodeNum: 4,
              episodeTitle: "The Trap",
              position: 1500,
              duration: 2400,
              completed: false,
              updatedAt: 1000,
            },
            hasIncompleteEpisode: true,
            completedIds: [],
            cachedGroup: null,
            progressByEpisodeId: new Map(),
          },
        ],
      ),
      { playlistId: "pl1" },
    );
    const shelf = root.querySelector('[data-series-home-section="continue"]');
    expect(shelf).not.toBeNull();
    expect(shelf!.querySelector("h2")?.textContent).toBe("Continue Watching");
    const card = shelf!.querySelector<HTMLElement>('[data-couch-key="series-1"]');
    expect(card).not.toBeNull();
    expect(card!.getAttribute("href")).toBe("/series/detail?id=1&season=2&epnum=4&autoplay=1");
    expect(card!.textContent).toContain("S2 E4");
    expect(card!.textContent).toContain("63% watched");
    // The % must be on the VISIBLE secondary line: poster cards hide
    // the meta line when a subtitle exists, so a % in meta alone
    // would never be seen.
    expect(card!.querySelector(".rs-card__subtitle")?.textContent).toBe("Continue · S2 E4 · 63%");
    expect(card!.querySelector(".rs-card__progress-fill")).not.toBeNull();
    expect(card!.getAttribute("data-series-home-action")).toBe("Continue");
  });

  it("renders New Episodes with detection labels and no premiere wording", () => {
    const rows = [row(1, "Drama Hit", { rating: "8.6", tmdb: 11, added: 100 })];
    const sections = assembleSeriesHomeSections({
      rows,
      rowsById: new Map(rows.map((r) => [r.id, r])),
      continueInputs: [],
      notificationGroups: [
        {
          id: "g1",
          playlistId: "pl1",
          seriesId: "101",
          seriesTitle: "Followed Show",
          posterUrl: "https://example.test/f.jpg",
          episodes: [
            {
              seriesId: "101",
              seriesTitle: "Followed Show",
              season: 3,
              episode: 2,
              episodeTitle: "The Return",
              episodeId: 777,
              detectedAt: "2026-11-10T10:00:00.000Z",
              watched: false,
            },
          ],
          detectedAt: "2026-11-10T10:00:00.000Z",
          read: false,
          dismissed: false,
        },
      ],
      subscriptions: [],
      hasProgress: () => false,
    });
    renderSeriesHome(root, sections, { playlistId: "pl1" });
    const shelf = root.querySelector('[data-series-home-section="new-episodes"]');
    expect(shelf).not.toBeNull();
    expect(shelf!.textContent).toContain("S3 E2");
    expect(shelf!.textContent).toContain("The Return");
    expect(shelf!.textContent).toMatch(/Detected /);
    expect(shelf!.textContent?.toLowerCase()).not.toContain("premier");
    const card = shelf!.querySelector('[data-couch-key^="series-101-"]');
    expect(card?.getAttribute("href")).toBe("/series/detail?id=101&season=3&epnum=2&autoplay=1");
    // Badge carries status + detection date (visible at a glance);
    // the subtitle carries S/E + episode title.
    const badge = card?.querySelector(".rs-card__badge")?.textContent ?? "";
    expect(badge).toMatch(/^New · /);
    expect(badge).toContain("Nov");
    expect(card?.querySelector(".rs-card__subtitle")?.textContent).toBe("S3 E2 · The Return");
  });

  it("renders genre tiles with real counts and browse-mode hrefs", () => {
    const rows = [
      row(1, "D1", { category: "Drama" }),
      row(2, "D2", { category: "Drama" }),
      row(3, "C1", { category: "Comedy" }),
    ];
    renderSeriesHome(root, sectionsFor(rows), { playlistId: "pl1" });
    const grid = root.querySelector(".rs-series-home-genre-grid");
    expect(grid).not.toBeNull();
    const tiles = [...grid!.querySelectorAll(".rs-series-home-genre")];
    expect(tiles.length).toBe(2);
    const drama = tiles.find((t) => t.textContent?.includes("Drama"));
    expect(drama?.textContent).toContain("2 series");
    expect(drama?.getAttribute("href")).toBe("/series?mode=browse&genre=drama");
    expect(drama?.getAttribute("data-series-home-genre")).toBe("drama");
    expect(drama?.getAttribute("data-couch-key")).toBe("genre-drama");
  });

  it("renders the Browse Everything entry with the real total", () => {
    renderSeriesHome(root, sectionsFor([row(1, "Only", { added: 5 })]), { playlistId: "pl1" });
    const entry = root.querySelector(".rs-series-home-browse-entry");
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain("Browse Everything");
    expect(entry!.textContent).toContain("1 series");
    expect(entry!.getAttribute("href")).toBe("/series?mode=browse");
  });

  it("omits empty shelves: no Continue, no New Episodes, no Followed without data", () => {
    renderSeriesHome(root, sectionsFor([row(1, "Only", { added: 5 })]), { playlistId: "pl1" });
    expect(root.querySelector('[data-series-home-section="continue"]')).toBeNull();
    expect(root.querySelector('[data-series-home-section="new-episodes"]')).toBeNull();
    expect(root.querySelector('[data-series-home-section="followed"]')).toBeNull();
  });

  it("renders a branded fallback (no broken image) when a series has no artwork", () => {
    const rows = [row(1, "No Art", { rating: "8.0", tmdb: 1, added: 5, logo: null })];
    renderSeriesHome(root, sectionsFor(rows), { playlistId: "pl1" });
    const card = root.querySelector('[data-couch-key="series-1"]');
    expect(card?.querySelector("img")).toBeNull();
    expect(card?.querySelector(".rs-image__fallback")).not.toBeNull();
    expect(card?.querySelector(".rs-image__fallback-title")?.textContent).toBe("No Art");
  });

  it("escapes provider text: a hostile title cannot inject markup", () => {
    const rows = [
      row(1, "<img src=x onerror=alert(1)>", { rating: "8.0", tmdb: 1, added: 5 }),
    ];
    renderSeriesHome(root, sectionsFor(rows), { playlistId: "pl1" });
    // No element is created from the hostile text: the only <img>
    // elements carry the real poster URL, and nothing gains an
    // onerror handler. (The literal text legitimately appears inside
    // aria-label/alt attribute values — attribute context, not markup.)
    expect(root.querySelector("img[src='x']")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    for (const img of root.querySelectorAll("img")) {
      expect(img.getAttribute("src")).toBe("https://example.test/1.jpg");
    }
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("focus restoration (§16.5) — detail return restores the exact poster", () => {
  it("restoreCouchFocus lands on the recorded card by stable key after a re-render", () => {
    const rows = [
      row(1, "Drama Hit", { rating: "8.6", tmdb: 11, added: 100 }),
      row(2, "Comedy Hit", { category: "Comedy", rating: "8.2", tmdb: 12, added: 200 }),
    ];
    renderSeriesHome(root, sectionsFor(rows), { playlistId: "pl1" });
    const first = root.querySelector<HTMLElement>('[data-couch-key="series-2"]');
    expect(first).not.toBeNull();
    // Simulate the focusin recording couch-focus.ts performs, then a
    // detail return: the home re-renders fresh nodes, and restoration
    // must find the same poster by key.
    recordCouchFocus({
      route: "/series",
      rail: "series-home-worth-starting",
      index: 1,
      key: "series-2",
    });
    expect(readCouchFocusMemory()?.key).toBe("series-2");
    renderSeriesHome(root, sectionsFor(rows), { playlistId: "pl1" });
    (document.activeElement as HTMLElement | null)?.blur?.();
    const restored = restoreCouchFocus(document);
    expect(restored).not.toBeNull();
    expect(restored!.getAttribute("data-couch-key")).toBe("series-2");
    expect(document.activeElement).toBe(restored);
  });
});

describe("renderSeriesHomeState — §18 loading / empty / error", () => {
  it("loading shows skeleton rows with no fake titles", () => {
    renderSeriesHomeState(root, "loading");
    expect(root.querySelectorAll(".rs-series-home-skeleton-card").length).toBeGreaterThan(0);
    expect(root.textContent).toContain("Loading your series");
    expect(root.querySelector("[data-nylah-item]")).toBeNull();
  });

  it("no-playlist state points at Settings", () => {
    renderSeriesHomeState(root, "no-playlist");
    expect(root.textContent).toContain("No playlist yet");
    expect(root.querySelector("a[href='/settings']")).not.toBeNull();
  });

  it("empty state is honest about the playlist having no series", () => {
    renderSeriesHomeState(root, "empty");
    expect(root.textContent).toContain("No series yet");
    expect(root.textContent).toContain("This playlist has no series");
  });

  it("error state never calls a failed connection an empty catalogue", () => {
    renderSeriesHomeState(root, "error", { message: "Could not reach the provider." });
    expect(root.textContent).toContain("Could not reach the provider");
    expect(root.textContent).not.toContain("No series yet");
    expect(root.querySelector("[data-series-home-retry]")).not.toBeNull();
  });
});
