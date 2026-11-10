// RedSilk Couch — Home assembly (W3).
// Synthetic fixtures only; no live catalogue, no network, no DOM
// except the jsdom focus-restoration section at the bottom.
import { describe, it, expect } from "vitest";
// jsdom ships no types and @types/jsdom is not installed; test-only.
// @ts-ignore
import { JSDOM } from "jsdom";
import {
  cardToHomeItem,
  channelToHomeItem,
  dropEmptyRails,
  episodeToHomeItem,
  getCachedHomeRails,
  heroPickToHomeHero,
  loadHomeRails,
  mergeHomePayload,
  readHomeCache,
  writeHomeCache,
  HOME_CACHE_KEY,
  type HomePayload,
  type HomeRail,
  type HomeRailItem,
} from "../src/scripts/lib/home-assembly";
import {
  recordCouchFocus,
  restoreCouchFocus,
  readCouchFocusMemory,
} from "../src/scripts/lib/couch-focus";
import {
  emptyTasteModel,
  type TasteModel,
} from "../src/scripts/lib/taste";
import {
  type DiscoverCandidate,
  type DiscoverData,
  type FollowedEpisode,
} from "../src/scripts/lib/discover";
import type { HomeCard } from "../src/scripts/lib/couch-home";

function candidate(
  partial: Partial<DiscoverCandidate> & { id: string; title: string },
): DiscoverCandidate {
  return {
    kind: "movie",
    genres: [],
    cast: [],
    source: "catalog",
    ...partial,
  };
}

function card(partial: Partial<HomeCard> & { key: string; title: string; href: string }): HomeCard {
  return { kind: "poster", ...partial };
}

function item(partial: Partial<HomeRailItem> & { id: string; title: string }): HomeRailItem {
  return {
    key: `${partial.kind ?? "movie"}:${partial.id}`,
    kind: partial.kind ?? "movie",
    detailHref: `/movies/detail?id=${partial.id}`,
    ...partial,
  };
}

function rail(partial: Partial<HomeRail> & { id: string; title: string }): HomeRail {
  return { kind: "trending", items: [], ...partial };
}

function discoverData(partial: Partial<DiscoverData> = {}): DiscoverData {
  const taste: TasteModel = emptyTasteModel("shared", "playlist-1");
  return {
    candidates: [],
    taste,
    hasHistory: false,
    watchedKeys: new Set<string>(),
    continueWatching: [],
    recentlyAdded: [],
    nowPlaying: [],
    becauseItems: [],
    ...partial,
  };
}

function memoryStore(): {
  store: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    store: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    },
  };
}

describe("home cache (cached first paint)", () => {
  it("returns null when nothing is cached", () => {
    const { store } = memoryStore();
    expect(readHomeCache(store)).toBeNull();
  });

  it("round-trips a payload and getCachedHomeRails reads it", () => {
    const { store } = memoryStore();
    const payload: HomePayload = {
      hero: null,
      rails: [rail({ id: "trending", title: "Trending", items: [item({ id: "1", title: "Dune" })] })],
    };
    writeHomeCache(payload, store);
    expect(readHomeCache(store)).toMatchObject({ rails: [{ id: "trending" }] });
    // getCachedHomeRails uses the ambient sessionStorage; with none
    // present it must return null rather than throw.
    expect(getCachedHomeRails()).toBeNull();
  });

  it("rejects malformed or wrongly-shaped cache entries", () => {
    const { store, map } = memoryStore();
    map.set(HOME_CACHE_KEY, "{not json");
    expect(readHomeCache(store)).toBeNull();
    map.set(HOME_CACHE_KEY, JSON.stringify({ hero: null, rails: "nope" }));
    expect(readHomeCache(store)).toBeNull();
    map.set(HOME_CACHE_KEY, JSON.stringify({ hero: null, rails: [{ id: 7, items: [] }] }));
    expect(readHomeCache(store)).toBeNull();
  });

  it("never caches an empty payload", () => {
    const { store, map } = memoryStore();
    writeHomeCache({ hero: null, rails: [] }, store);
    expect(map.has(HOME_CACHE_KEY)).toBe(false);
  });
});

describe("mergeHomePayload (metadata failure keeps cached content)", () => {
  const cached: HomePayload = {
    hero: { item: item({ id: "1", title: "Dune" }), reason: "Picked for You" },
    rails: [rail({ id: "trending", title: "Trending", items: [item({ id: "1", title: "Dune" })] })],
  };

  it("keeps cached content when the fresh load fails (null)", () => {
    expect(mergeHomePayload(cached, null)).toBe(cached);
  });

  it("keeps cached content when the fresh load is empty", () => {
    expect(mergeHomePayload(cached, { hero: null, rails: [] })).toBe(cached);
  });

  it("replaces the cache when the fresh load has real content", () => {
    const fresh: HomePayload = {
      hero: null,
      rails: [rail({ id: "trending", title: "Trending", items: [item({ id: "2", title: "Arrival" })] })],
    };
    expect(mergeHomePayload(cached, fresh)).toBe(fresh);
  });

  it("returns null when there is nothing cached and nothing fresh", () => {
    expect(mergeHomePayload(null, null)).toBeNull();
    expect(mergeHomePayload(null, { hero: null, rails: [] })).toBeNull();
  });
});

describe("dropEmptyRails", () => {
  it("renders nothing for empty rails and keeps rails with items", () => {
    const rails = [
      rail({ id: "a", title: "A", items: [] }),
      rail({ id: "b", title: "B", items: [item({ id: "1", title: "Dune" })] }),
      rail({ id: "c", title: "C", items: [] }),
    ];
    expect(dropEmptyRails(rails).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("cardToHomeItem", () => {
  const byKey = new Map<string, DiscoverCandidate>([
    [
      "movie:1",
      candidate({
        id: "1",
        title: "Dune",
        year: 2021,
        rating: 8.0,
        runtimeMinutes: 155,
        overview: "Spice.",
        posterUrl: "https://img/dune.jpg",
      }),
    ],
  ]);

  it("enriches from the candidate and falls back to the poster as backdrop", () => {
    const result = cardToHomeItem(
      card({ key: "movie:1", title: "Dune", href: "/movies/detail?id=1", image: "https://img/dune.jpg" }),
      byKey,
    );
    expect(result).toMatchObject({
      kind: "movie",
      id: "1",
      year: 2021,
      rating: 8.0,
      runtimeMinutes: 155,
      overview: "Spice.",
      posterUrl: "https://img/dune.jpg",
      backdropUrl: "https://img/dune.jpg",
      detailHref: "/movies/detail?id=1",
    });
    expect(result.playHref).toBeUndefined();
  });

  it("sets playHref only when the card href already autoplays", () => {
    const resume = cardToHomeItem(
      card({ key: "movie:1", title: "Dune", href: "/movies/detail?id=1&autoplay=1", progress: 0.4 }),
      byKey,
    );
    expect(resume.playHref).toBe("/movies/detail?id=1&autoplay=1");
    expect(resume.progress).toBe(0.4);
  });

  it("marks live-channel cards live", () => {
    const result = cardToHomeItem(
      card({ key: "live:7", title: "RTÉ One", kind: "channel", href: "/livetv?channel=7" }),
      byKey,
    );
    expect(result).toMatchObject({ kind: "live", id: "7", isLive: true });
  });

  it("parses year and rating from meta when the candidate is unknown", () => {
    const result = cardToHomeItem(
      card({ key: "movie:9", title: "Unknown", href: "/movies/detail?id=9", meta: "2024 · ★ 7.5" }),
      byKey,
    );
    expect(result).toMatchObject({ year: 2024, rating: 7.5 });
  });
});

describe("episodeToHomeItem / channelToHomeItem", () => {
  it("carries season, episode and detection time without parsing subtitles", () => {
    const episode: FollowedEpisode = {
      seriesId: "42",
      seriesTitle: "Severance",
      season: 2,
      episode: 3,
      episodeTitle: "Goodbye",
      detectedAt: "2026-11-10T10:00:00Z",
      posterUrl: "https://img/sev.jpg",
      watched: false,
    };
    const result = episodeToHomeItem(episode, new Map());
    expect(result).toMatchObject({
      kind: "series",
      id: "42",
      season: 2,
      episode: 3,
      episodeTitle: "Goodbye",
      detectedAt: "2026-11-10T10:00:00Z",
    });
    expect(result.playHref).toContain("autoplay=1");
    expect(result.playHref).toContain("season=2");
  });

  it("carries real now/next for live channels", () => {
    const result = channelToHomeItem({
      id: 7,
      name: "RTÉ One",
      logo: "https://img/rte.png",
      nowTitle: "News",
      nextTitle: "Weather",
    });
    expect(result).toMatchObject({
      kind: "live",
      isLive: true,
      nowTitle: "News",
      nextTitle: "Weather",
    });
  });
});

describe("heroPickToHomeHero", () => {
  it("returns null with no pick and builds autoplay play hrefs", () => {
    expect(heroPickToHomeHero(null)).toBeNull();
    const hero = heroPickToHomeHero({
      candidate: candidate({ id: "1", title: "Dune", year: 2021, rating: 8.0, overview: "Spice." }),
      eyebrow: "Picked for You",
    });
    expect(hero?.item.playHref).toBe("/movies/detail?id=1&autoplay=1");
    expect(hero?.item.detailHref).toBe("/movies/detail?id=1");
    expect(hero?.reason).toBe("Picked for You");
    expect(hero?.item.overview).toBe("Spice.");
  });

  it("carries progress so the view can label the action Resume", () => {
    const hero = heroPickToHomeHero(
      {
        candidate: candidate({ id: "1", title: "Dune" }),
        eyebrow: "Continue Watching",
      },
      0.5,
    );
    expect(hero?.item.progress).toBe(0.5);
  });
});

describe("loadHomeRails (no playlist: catalogue-only assembly)", () => {
  const dune = candidate({
    id: "1",
    title: "Dune",
    year: 2021,
    rating: 8.6,
    posterUrl: "https://img/dune.jpg",
    overview: "Spice.",
  });
  const gem = candidate({
    id: "2",
    title: "Arrival",
    year: 2016,
    rating: 7.9,
    posterUrl: "https://img/arrival.jpg",
  });
  const weak = candidate({ id: "3", title: "Boring", year: 2020, rating: 5.1 });

  it("builds picked, new-episode and hidden-gem rails; omits empty ones", async () => {
    // 13 highly-rated titles: Picked for You takes the top 12, so the
    // 13th is the honest hidden gem (gems exclude picked titles).
    const many = Array.from({ length: 13 }, (_, i) =>
      candidate({
        id: `g${i}`,
        title: `Gem ${String(i).padStart(2, "0")}`,
        year: 2000 + i,
        rating: 9.0 - i * 0.1,
        posterUrl: `https://img/g${i}.jpg`,
      }),
    );
    const data = discoverData({
      candidates: [dune, gem, weak, ...many],
      recentlyAdded: [dune],
    });
    const followed: FollowedEpisode[] = [
      {
        seriesId: "9",
        seriesTitle: "Severance",
        season: 2,
        episode: 1,
        detectedAt: "2026-11-10T09:00:00Z",
        watched: false,
      },
      {
        seriesId: "9",
        seriesTitle: "Severance",
        season: 1,
        episode: 9,
        detectedAt: "2026-11-01T09:00:00Z",
        watched: true,
      },
    ];
    const payload = await loadHomeRails(data, followed);
    const ids = payload.rails.map((r) => r.id);
    expect(ids).toContain("new-episodes");
    expect(ids).toContain("hidden-gems");
    expect(ids).not.toContain("continue-watching");
    expect(ids).not.toContain("trending");
    const episodes = payload.rails.find((r) => r.id === "new-episodes");
    expect(episodes?.items).toHaveLength(1);
    expect(episodes?.items[0]).toMatchObject({ season: 2, episode: 1 });
    expect(episodes?.seeAllHref).toBe("/followed");
    const gems = payload.rails.find((r) => r.id === "hidden-gems");
    expect(gems?.items.length).toBeGreaterThan(0);
    for (const g of gems?.items ?? []) {
      expect(g.rating).toBeGreaterThanOrEqual(7.5);
    }
    expect(payload.hero?.item.title).toBe("Gem 00");
  });

  it("omits hidden gems when every gem is already picked", async () => {
    const data = discoverData({ candidates: [dune, gem, weak] });
    const payload = await loadHomeRails(data, []);
    expect(payload.rails.map((r) => r.id)).not.toContain("hidden-gems");
  });

  it("returns an empty payload (never invented titles) for an empty library", async () => {
    const payload = await loadHomeRails(discoverData(), []);
    expect(payload).toEqual({ hero: null, rails: [] });
  });
});

describe("focus restoration (same rail + card after a detail return)", () => {
  function setupDom(): { doc: Document; win: Window } {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <section data-nylah-rail="continue-watching">
          <a data-nylah-item data-couch-key="movie:1" href="/movies/detail?id=1">Dune</a>
          <a data-nylah-item data-couch-key="movie:2" href="/movies/detail?id=2">Arrival</a>
        </section>
        <section data-nylah-rail="trending">
          <a data-nylah-item data-couch-key="movie:3" href="/movies/detail?id=3">Boring</a>
        </section>
      </body></html>`,
      { url: "http://localhost/" },
    );
    const win = dom.window as unknown as Window;
    // jsdom reports zero-size rects; the focus layer treats those as
    // invisible, so give every element a visible box for this test.
    const elementCtor = (win as unknown as { Element: typeof Element }).Element;
    elementCtor.prototype.getBoundingClientRect = () =>
      ({ width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    (globalThis as Record<string, unknown>).window = win;
    (globalThis as Record<string, unknown>).document = win.document;
    (globalThis as Record<string, unknown>).sessionStorage = win.sessionStorage;
    (globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
    return { doc: win.document, win };
  }

  it("restores the same card by stable key after returning from detail", () => {
    const { doc } = setupDom();
    recordCouchFocus({ route: "/", rail: "continue-watching", index: 1, key: "movie:2" });
    expect(readCouchFocusMemory()).toMatchObject({ rail: "continue-watching", key: "movie:2" });
    const restored = restoreCouchFocus(doc);
    expect(restored?.getAttribute("data-couch-key")).toBe("movie:2");
    expect(doc.activeElement?.getAttribute("data-couch-key")).toBe("movie:2");
  });

  it("falls back to rail + index when the remembered card is gone", () => {
    const { doc } = setupDom();
    recordCouchFocus({ route: "/", rail: "trending", index: 0, key: "movie:gone" });
    const restored = restoreCouchFocus(doc);
    expect(restored?.getAttribute("data-couch-key")).toBe("movie:3");
  });

  it("restores nothing for a different route", () => {
    const { doc } = setupDom();
    recordCouchFocus({ route: "/discover", rail: "continue-watching", index: 0, key: "movie:1" });
    expect(restoreCouchFocus(doc)).toBeNull();
    expect(doc.activeElement).toBe(doc.body);
  });
});
