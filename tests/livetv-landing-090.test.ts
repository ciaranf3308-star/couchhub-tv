/**
 * @vitest-environment jsdom
 *
 * 0.9.0 Live TV Landing (W1): cinematic hero pick + fallback,
 * fixed-size category tiles with no stacked logos, quick-access
 * dispatches, restore-last-card, landing open never tunes, and
 * B/Escape → app Home.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LANDING_FOCUS_STORAGE_KEY,
  LANDING_MAX_CATEGORIES,
  buildCategoryTileElement,
  buildLandingHeroModel,
  categoryTileVariant,
  dispatchLandingMode,
  fillLandingHero,
  handleLandingBack,
  landingCategories,
  mountLivtvLanding,
  openLandingCategory,
  performLandingQuickAction,
  readLandingFocusKey,
  recordLandingFocus,
  restoreLandingFocus,
  type LandingCategory,
  type LandingHeroModel,
} from "@/scripts/lib/livetv-landing";
import {
  mapLivetvChannels,
  type LivetvChannel,
  type LivetvHomeData,
  type LivetvRawChannel,
} from "@/scripts/lib/livetv-data";
import { invalidateEntry, setCached } from "@/scripts/lib/cache.js";
import type { Programme } from "@/scripts/lib/now-next";

const NOW = Date.UTC(2026, 10, 10, 18, 24, 0);
const HOUR = 3_600_000;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const couchCss = readFileSync(join(repo, "src/styles/couch.css"), "utf8");
const landingCss = couchCss.slice(
  couchCss.indexOf("/* Live TV 0.11.0 — Landing (W3) */"),
);
const heroAstro = readFileSync(
  join(repo, "src/components/couch/TvLiveHero.astro"),
  "utf8",
);
const tileAstro = readFileSync(
  join(repo, "src/components/couch/TvCategoryTile.astro"),
  "utf8",
);
const landingAstro = readFileSync(
  join(repo, "src/components/couch/TvLiveLanding.astro"),
  "utf8",
);

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

function programmesFor(entries: Array<[string, Array<{ start: number; stop: number; title: string }>]>) {
  const map = new Map<string, Programme[]>();
  for (const [tvgId, list] of entries) {
    map.set(tvgId.toLowerCase(), list.map((p) => ({ ...p })));
  }
  return map;
}

function homeData(
  channels: LivetvChannel[],
  recents: LivetvHomeData["recents"] = [],
  programmes: Map<string, Programme[]> | null = null,
): LivetvHomeData {
  return {
    playlistId: "demo-landing",
    channels,
    recents,
    programmes,
    hasEpg: !!programmes && programmes.size > 0,
  };
}

function collectEvents(types: string[]): { events: Array<{ type: string; detail: unknown }>; stop: () => void } {
  const events: Array<{ type: string; detail: unknown }> = [];
  const listeners = types.map((type) => {
    const listener = (event: Event) => {
      events.push({ type, detail: (event as CustomEvent).detail });
    };
    window.addEventListener(type, listener);
    return { type, listener };
  });
  return {
    events,
    stop: () => {
      for (const { type, listener } of listeners) {
        window.removeEventListener(type, listener);
      }
    },
  };
}

beforeEach(() => {
  sessionStorage.clear();
  window.localStorage.removeItem("xt_playlists");
});

afterEach(() => {
  sessionStorage.clear();
  window.localStorage.removeItem("xt_playlists");
  document.body.replaceChildren();
});

// ── Hero pick + fallback ────────────────────────────────────────

describe("buildLandingHeroModel", () => {
  it("picks the last-watched channel with its real programme, times and progress", () => {
    const channels = [
      ch({ id: 106, name: "Sky Sports F1", tvgId: "sky.f1", categoryId: "Sports", logo: "https://x/f1.png" }),
      ch({ id: 101, name: "RTÉ One", tvgId: "rte.one", categoryId: "UK" }),
    ];
    const programmes = programmesFor([
      ["sky.f1", [
        { start: NOW - 30 * 60_000, stop: NOW + 90 * 60_000, title: "F1: Brazilian Grand Prix — Qualifying" },
        { start: NOW + 90 * 60_000, stop: NOW + 120 * 60_000, title: "F1: Qualifying Highlights" },
      ]],
    ]);
    const model = buildLandingHeroModel(
      homeData(channels, [{ id: 106, name: "Sky Sports F1", logo: null, ts: 1 }], programmes),
      NOW,
    );
    expect(model?.channel.id).toBe(106);
    expect(model?.eyebrow).toBe("Resume Watching");
    expect(model?.isResume).toBe(true);
    expect(model?.current?.title).toBe("F1: Brazilian Grand Prix — Qualifying");
    expect(model?.current?.timeRange).toContain("–");
    expect(model?.current?.progress).toBeCloseTo(0.25, 2);
    expect(model?.next?.title).toBe("F1: Qualifying Highlights");
  });

  it("never leaves the hero empty: no history, no favourites, no EPG still yields a featured channel", () => {
    const channels = [
      ch({ id: 1, name: "Sky Sports", tvgId: "sky.sports", categoryId: "Sports" }),
      ch({ id: 2, name: "RTÉ One", tvgId: "rte.one", categoryId: "UK", logo: "https://x/rte.png" }),
    ];
    for (const programmes of [null, new Map<string, Programme[]>()]) {
      const model = buildLandingHeroModel(homeData(channels, [], programmes), NOW);
      expect(model).not.toBeNull();
      expect(model?.eyebrow).toBe("Featured Channel");
      expect(model?.channel.id).toBe(2);
      // No EPG: no invented programme line.
      expect(model?.current).toBeNull();
      expect(model?.next).toBeNull();
    }
  });

  it("prefers a favourite over the featured fallback", () => {
    const channels = [
      ch({ id: 1, name: "RTÉ One", tvgId: "rte.one", categoryId: "UK", favourite: true }),
      ch({ id: 2, name: "Sky Sports", tvgId: "sky.sports", categoryId: "Sports" }),
    ];
    const model = buildLandingHeroModel(homeData(channels), NOW);
    expect(model?.eyebrow).toBe("Favourite Channel");
    expect(model?.channel.id).toBe(1);
  });

  it("returns null only when there are no channels at all", () => {
    expect(buildLandingHeroModel(homeData([]), NOW)).toBeNull();
  });
});

describe("fillLandingHero", () => {
  function heroEl(): HTMLElement {
    const section = document.createElement("section");
    section.setAttribute("data-livetv-hero", "");
    section.setAttribute("hidden", "");
    section.innerHTML = `
      <div data-hero-logo></div>
      <p data-hero-eyebrow></p>
      <h2 data-hero-title></h2>
      <p data-hero-programme-title></p>
      <p data-hero-programme-time></p>
      <div data-hero-progress-wrap hidden><div data-hero-progress-fill></div></div>
      <p data-hero-next hidden></p>
      <button data-hero-watch></button>
      <button data-hero-guide></button>
    `;
    document.body.appendChild(section);
    return section;
  }

  it("fills title, programme, times, progress and up-next from real EPG", () => {
    const model: LandingHeroModel = {
      channel: ch({ id: 106, name: "Sky Sports F1", tvgId: "sky.f1", logo: "https://x/f1.png" }),
      eyebrow: "Resume Watching",
      current: { title: "Qualifying", start: NOW - HOUR, stop: NOW + HOUR, progress: 0.5, timeRange: "17:30–19:00" },
      next: { title: "Highlights", start: NOW + HOUR, stop: NOW + 2 * HOUR, timeRange: "19:00–19:30" },
      isResume: true,
    };
    const el = heroEl();
    expect(fillLandingHero(el, model)).toBe(true);
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector("[data-hero-title]")?.textContent).toBe("Sky Sports F1");
    expect(el.querySelector("[data-hero-programme-title]")?.textContent).toBe("Qualifying");
    expect(el.querySelector("[data-hero-programme-time]")?.textContent).toBe("17:30–19:00");
    expect(el.querySelector<HTMLElement>("[data-hero-progress-fill]")?.style.width).toBe("50%");
    expect(el.querySelector("[data-hero-next]")?.textContent).toContain("Highlights");
    expect(el.querySelector("[data-hero-watch]")?.getAttribute("data-channel-id")).toBe("106");
    // Real logo, one <img> only.
    expect(el.querySelectorAll("[data-hero-logo] img")).toHaveLength(1);
  });

  it("shows 'Live TV' with no programme and the branded fallback mark with no logo — never invented art", () => {
    const model: LandingHeroModel = {
      channel: ch({ id: 1, name: "RTÉ One", tvgId: "rte.one" }),
      eyebrow: "Featured Channel",
      current: null,
      next: null,
      isResume: false,
    };
    const el = heroEl();
    expect(fillLandingHero(el, model)).toBe(true);
    expect(el.querySelector("[data-hero-programme-title]")?.textContent).toBe("Live TV");
    expect(el.querySelector("[data-hero-progress-wrap]")?.hasAttribute("hidden")).toBe(true);
    expect(el.querySelector("[data-hero-next]")?.hasAttribute("hidden")).toBe(true);
    expect(el.querySelectorAll("[data-hero-logo] img")).toHaveLength(0);
    expect(el.querySelector("[data-hero-logo]")?.textContent).toBeTruthy();
  });

  it("returns false with no model (caller hides the hero)", () => {
    const el = heroEl();
    expect(fillLandingHero(el, null)).toBe(false);
    expect(el.hasAttribute("hidden")).toBe(true);
  });
});

// ── Categories ──────────────────────────────────────────────────

describe("landingCategories", () => {
  it("builds tiles from genuine provider groups, never 'all', capped at six", () => {
    const rows: LivetvRawChannel[] = [
      { id: 1, name: "RTÉ One", category: "UK", tvgId: "rte.one" },
      { id: 2, name: "Sky Sports", category: "Sports", tvgId: "sky.sports" },
      { id: 3, name: "Sky News", category: "News", tvgId: "sky.news" },
      { id: 4, name: "Sky Cinema", category: "Movies", tvgId: "sky.cinema" },
      { id: 5, name: "Nat Geo", category: "Documentaries", tvgId: "nat.geo" },
      { id: 6, name: "Cartoon Net", category: "Kids", tvgId: "cn" },
      { id: 7, name: "MTV", category: "Music", tvgId: "mtv" },
      { id: 8, name: "Comedy Central", category: "Entertainment", tvgId: "cc" },
    ];
    const channels = mapLivetvChannels(rows);
    const cats = landingCategories(homeData(channels));
    expect(cats.length).toBeLessThanOrEqual(LANDING_MAX_CATEGORIES);
    expect(cats.length).toBe(6);
    expect(cats.map((c) => c.id)).not.toContain("all");
    expect(cats.every((c) => c.count > 0)).toBe(true);
    // Labels are the normalised provider labels, not invented names.
    expect(cats.map((c) => c.label)).toContain("Sports");
  });

  it("returns no categories when there are no channels", () => {
    expect(landingCategories(homeData([]))).toEqual([]);
  });

  it("carries the first real live programme per group, null when the EPG covers nothing", () => {
    const channels = [
      ch({ id: 1, name: "Sky Sports", tvgId: "sky.sports", categoryId: "Sports" }),
    ];
    expect(landingCategories(homeData(channels))[0].nowPlaying).toBeNull();
    const programmes = programmesFor([
      ["sky.sports", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "Match Live" }]],
    ]);
    expect(
      landingCategories(homeData(channels, [], programmes), 6, NOW)[0].nowPlaying,
    ).toEqual({ channelName: "Sky Sports", programmeTitle: "Match Live" });
  });
});

describe("category tiles", () => {
  it("categoryTileVariant is deterministic and in range", () => {
    for (const id of ["sports", "news", "irish-uk", "provider:foo"]) {
      const v = categoryTileVariant(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      expect(categoryTileVariant(id)).toBe(v);
    }
  });

  it("tile DOM has fixed height in CSS (bounded width via the six-across grid, never auto height)", () => {
    expect(landingCss).toContain("/* Live TV 0.11.0 — Landing (W3) */");
    const tileRule = landingCss.match(
      /\.rs-livetv-landing-category-tile\s*\{[^}]*\}/,
    )?.[0];
    expect(tileRule).toBeTruthy();
    expect(tileRule).toContain("height: 10.625rem");
    expect(tileRule).not.toContain("height: auto");
    // Six-across grid, not a horizontal scroller.
    expect(landingCss).toContain("repeat(auto-fit, minmax(16rem, 1fr))");
    // The giant-initial motif is gone.
    expect(landingCss).not.toContain("rs-livetv-landing-category-tile__motif");
  });

  it("tile markup has NO stacked logos and NO giant initial: a small glyph, no <img> without artwork", () => {
    const cat: LandingCategory = {
      id: "sports",
      label: "Sports",
      count: 142,
      nowPlaying: { channelName: "Sky Sports", programmeTitle: "Match Live" },
      variant: 2,
    };
    const tile = buildCategoryTileElement(cat);
    expect(tile.tagName).toBe("BUTTON");
    expect(tile.querySelectorAll("img")).toHaveLength(0);
    expect(tile.outerHTML).not.toContain("logo");
    expect(tile.outerHTML).not.toContain("data-channel-card");
    expect(tile.getAttribute("data-focus-key")).toBe("landing-category-sports");
    expect(tile.className).toContain("rs-livetv-landing-category-tile--v2");
    expect(tile.querySelector(".rs-livetv-landing-category-tile__label")?.textContent).toBe("Sports");
    expect(tile.querySelector(".rs-livetv-landing-category-tile__count")?.textContent).toBe("142 channels");
    expect(tile.querySelector(".rs-livetv-landing-category-tile__now")?.textContent).toContain("Match Live");
    // Small glyph accent, not a giant initial motif.
    expect(tile.querySelector(".rs-livetv-landing-category-tile__motif")).toBeNull();
    expect(tile.querySelector(".rs-livetv-landing-category-tile__glyph")?.textContent).toBe("⚽");
    // Contextual artwork swaps the glyph for one <img>.
    const withArt = buildCategoryTileElement({ ...cat, artworkUrl: "https://x/art.jpg" });
    expect(withArt.querySelectorAll("img")).toHaveLength(1);
    expect(withArt.querySelector(".rs-livetv-landing-category-tile__glyph")).toBeNull();
  });

  it("the Astro tile twin renders the same contract (art layer + glyph, no giant initial)", () => {
    expect(tileAstro).toContain("rs-livetv-landing-category-tile");
    expect(tileAstro).toContain("data-focus-key");
    expect(tileAstro).not.toContain("__motif");
    expect(tileAstro).toContain("rs-livetv-landing-category-tile__art");
    expect(tileAstro).toContain("categoryGlyphFor");
    const heroMarkup = heroAstro.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^---[\s\S]*?---/m, "");
    expect(heroAstro).toContain("data-hero-logo");
    expect(heroMarkup).not.toContain("<img");
    expect(heroAstro).toContain("data-hero-art");
    expect(heroAstro).toContain("TvProgrammeArt");
    expect(landingAstro).toContain("data-landing-action");
    expect(landingAstro).toContain("Browse by Category");
  });
});

// ── Quick access dispatches ─────────────────────────────────────

describe("quick-access dispatches", () => {
  it("Continue Watching tunes the last-watched channel and requests playback", () => {
    const { events, stop } = collectEvents(["livetv:tune", "livetv:mode"]);
    try {
      expect(performLandingQuickAction("continue", { lastWatchedChannelId: 106 })).toBe(true);
      expect(events).toEqual([
        { type: "livetv:tune", detail: { channelId: 106 } },
        { type: "livetv:mode", detail: { mode: "playback" } },
      ]);
    } finally {
      stop();
    }
  });

  it("Continue Watching with no last-watched channel dispatches nothing", () => {
    const { events, stop } = collectEvents(["livetv:tune", "livetv:mode"]);
    try {
      expect(performLandingQuickAction("continue", {})).toBe(false);
      expect(performLandingQuickAction("continue")).toBe(false);
      expect(events).toEqual([]);
    } finally {
      stop();
    }
  });

  it("Favourites / Recently Watched / All Channels / Guide / Search each emit the contracted mode + detail", () => {
    const { events, stop } = collectEvents(["livetv:mode"]);
    try {
      performLandingQuickAction("favourites");
      performLandingQuickAction("recent");
      performLandingQuickAction("all");
      performLandingQuickAction("guide");
      performLandingQuickAction("search");
      expect(events).toEqual([
        { type: "livetv:mode", detail: { mode: "browser", browserFilter: { kind: "favourites" } } },
        { type: "livetv:mode", detail: { mode: "browser", browserFilter: { kind: "recents" } } },
        { type: "livetv:mode", detail: { mode: "browser", browserFilter: { kind: "all" } } },
        { type: "livetv:mode", detail: { mode: "guide" } },
        { type: "livetv:mode", detail: { mode: "browser", browserFilter: { kind: "all" }, openSearch: true } },
      ]);
    } finally {
      stop();
    }
  });

  it("a category tile requests the browser filtered to that group", () => {
    const { events, stop } = collectEvents(["livetv:mode"]);
    try {
      expect(openLandingCategory("sports")).toBe(true);
      expect(events).toEqual([
        { type: "livetv:mode", detail: { mode: "browser", browserFilter: { kind: "category", value: "sports" } } },
      ]);
      expect(openLandingCategory("")).toBe(false);
    } finally {
      stop();
    }
  });

  it("dispatchLandingMode matches the requestLivetvMode(mode, detail?) contract shape", () => {
    const { events, stop } = collectEvents(["livetv:mode"]);
    try {
      dispatchLandingMode("browser", { browserFilter: { kind: "all" }, openSearch: true });
      expect(events[0].detail).toEqual({
        mode: "browser",
        browserFilter: { kind: "all" },
        openSearch: true,
      });
    } finally {
      stop();
    }
  });
});

// ── Restore last card ───────────────────────────────────────────

describe("restore last selected card", () => {
  it("records and restores the focused card's data-focus-key", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-focus-key", "landing-category-sports");
    document.body.appendChild(btn);
    recordLandingFocus("landing-category-sports");
    expect(readLandingFocusKey()).toBe("landing-category-sports");
    expect(sessionStorage.getItem(LANDING_FOCUS_STORAGE_KEY)).toBe("landing-category-sports");
    const restored = restoreLandingFocus(document);
    expect(restored).toBe(btn);
    expect(document.activeElement).toBe(btn);
  });

  it("restores nothing when no card was recorded", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-focus-key", "landing-category-sports");
    document.body.appendChild(btn);
    expect(restoreLandingFocus(document)).toBeNull();
    expect(document.activeElement).not.toBe(btn);
  });

  it("falls back to the couch-focus memory record for a landing rail on this route", () => {
    const btn = document.createElement("button");
    btn.setAttribute("data-focus-key", "landing-quick-guide");
    btn.setAttribute("data-couch-key", "landing-quick-guide");
    document.body.appendChild(btn);
    sessionStorage.setItem(
      "rs_couch_focus_memory",
      JSON.stringify({
        route: window.location.pathname,
        rail: "livetv-landing-quick",
        index: 3,
        key: "landing-quick-guide",
      }),
    );
    expect(restoreLandingFocus(document)).toBe(btn);
  });

  it("does not move focus when something is already focused", () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    second.setAttribute("data-focus-key", "landing-category-news");
    document.body.append(first, second);
    first.focus();
    recordLandingFocus("landing-category-news");
    expect(restoreLandingFocus(document)).toBeNull();
    expect(document.activeElement).toBe(first);
  });
});

// ── Back → app Home ─────────────────────────────────────────────

describe("livetv:back on the landing", () => {
  it("navigates to the app Home (/) for context 'landing' or no context", () => {
    const seen: string[] = [];
    expect(handleLandingBack({ detail: { context: "landing" } }, (url) => seen.push(url))).toBe(true);
    expect(handleLandingBack(null, (url) => seen.push(url))).toBe(true);
    expect(handleLandingBack(undefined, (url) => seen.push(url))).toBe(true);
    expect(seen).toEqual(["/", "/", "/"]);
  });

  it("ignores back events for another context", () => {
    const seen: string[] = [];
    expect(handleLandingBack({ detail: { context: "guide" } }, (url) => seen.push(url))).toBe(false);
    expect(handleLandingBack({ detail: { context: "playback" } }, (url) => seen.push(url))).toBe(false);
    expect(seen).toEqual([]);
  });
});

// ── Mount: landing open never tunes ─────────────────────────────

describe("mountLivtvLanding", () => {
  afterEach(() => {
    invalidateEntry("demo-landing");
  });
  function hostEl(): HTMLElement {
    const host = document.createElement("div");
    host.setAttribute("data-livetv-landing", "");
    host.innerHTML = `
      <section data-livetv-hero hidden>
        <div data-hero-art><div data-programme-art data-art-state="placeholder"></div></div>
        <div data-hero-logo></div>
        <p data-hero-eyebrow></p>
        <h2 data-hero-title></h2>
        <p data-hero-programme-title></p>
        <p data-hero-programme-time></p>
        <div data-hero-progress-wrap hidden><div data-hero-progress-fill></div></div>
        <p data-hero-description hidden></p>
        <p data-hero-next hidden></p>
        <button data-hero-watch></button>
        <button data-hero-guide></button>
      </section>
      <nav data-nylah-rail="livetv-landing-quick">
        <button data-landing-action="continue" hidden><span data-landing-sublabel-for="continue"></span></button>
        <button data-landing-action="favourites"><span data-landing-sublabel-for="favourites"></span></button>
        <button data-landing-action="recent" hidden><span data-landing-sublabel-for="recent"></span></button>
        <button data-landing-action="all"><span data-landing-sublabel-for="all"></span></button>
        <button data-landing-action="guide"><span data-landing-sublabel-for="guide"></span></button>
        <button data-landing-action="search"><span data-landing-sublabel-for="search"></span></button>
      </nav>
      <section data-landing-categories-section hidden>
        <div data-landing-categories></div>
      </section>
      <div data-landing-empty hidden></div>
    `;
    document.body.appendChild(host);
    return host;
  }

  function seedPlaylist(): void {
    window.localStorage.setItem(
      "xt_playlists",
      JSON.stringify({ entries: [{ _id: "demo-landing" }], selectedId: "demo-landing" }),
    );
    setCached(
      "demo-landing",
      "live",
      [
        { id: 101, name: "RTÉ One", category: "UK", tvgId: "rte.one", logo: "https://x/rte.png" },
        { id: 106, name: "Sky Sports F1", category: "Sports", tvgId: "sky.f1", logo: "https://x/f1.png" },
        { id: 107, name: "Sky News", category: "News", tvgId: "sky.news" },
      ],
      30 * 24 * 3600 * 1000,
    );
  }

  it("mounting renders hero + categories and dispatches NO tune and NO mode event", async () => {
    seedPlaylist();
    const { events, stop } = collectEvents(["livetv:tune", "livetv:mode"]);
    const host = hostEl();
    try {
      const handle = await mountLivtvLanding(host);
      expect(handle).not.toBeNull();
      expect(events).toEqual([]);
      // Hero filled from the featured fallback (no history / no EPG).
      const hero = host.querySelector("[data-livetv-hero]");
      expect(hero?.hasAttribute("hidden")).toBe(false);
      expect(host.querySelector("[data-hero-title]")?.textContent).toBe("RTÉ One");
      expect(host.querySelector("[data-hero-programme-title]")?.textContent).toBe("Live TV");
      // Categories rendered, one tile per group, no <img> anywhere in them.
      const tiles = host.querySelectorAll("[data-landing-categories] button");
      expect(tiles.length).toBeGreaterThan(0);
      expect(host.querySelectorAll("[data-landing-categories] img")).toHaveLength(0);
      // Continue Watching and Recently Watched stay hidden with no history.
      expect(
        host.querySelector('[data-landing-action="continue"]')?.hasAttribute("hidden"),
      ).toBe(true);
      expect(
        host.querySelector('[data-landing-action="recent"]')?.hasAttribute("hidden"),
      ).toBe(true);
      // Favourites sublabel is a real count.
      expect(
        host.querySelector('[data-landing-sublabel-for="favourites"]')?.textContent,
      ).toBe("0 channels");
      handle?.unmount();
    } finally {
      stop();
    }
  });

  it("clicking a rendered category tile requests the browser for that group", async () => {
    seedPlaylist();
    const { events, stop } = collectEvents(["livetv:mode"]);
    const host = hostEl();
    try {
      const handle = await mountLivtvLanding(host);
      const tile = host.querySelector<HTMLButtonElement>(
        "[data-landing-categories] button",
      );
      expect(tile).not.toBeNull();
      tile?.click();
      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({
        mode: "browser",
        browserFilter: { kind: "category", value: tile?.getAttribute("data-category-id") },
      });
      handle?.unmount();
    } finally {
      stop();
    }
  });

  it("returns null and shows the empty state with no active playlist", async () => {
    const host = hostEl();
    const handle = await mountLivtvLanding(host);
    expect(handle).toBeNull();
    expect(host.querySelector("[data-landing-empty]")?.hasAttribute("hidden")).toBe(false);
  });
});
