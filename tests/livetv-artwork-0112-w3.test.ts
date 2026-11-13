/**
 * @vitest-environment jsdom
 *
 * Live TV Artwork Enrichment 2.0 (0.11.12, W3 — consumers): the four
 * Live TV consumers honour the resolver's artworkKind per the DISPLAY
 * RULE — a displayable kind (exact-programme / exact-sports-event /
 * league-team / generic-sport) shows its art when a usable URL exists
 * for the slot, generic-sport art is NOT gated on identity
 * confidence, and channel-branding / placeholder kinds never paint
 * as programme art. A missing kind is legacy resolver output and
 * keeps the pre-0.11.12 behaviour. Consumers trust the kind; none of
 * them re-derives classification.
 *
 * Covers ONLY W3's consumer wiring: hero + category tiles
 * (livetv-landing), the channel browser detail panel
 * (livetv-browser), the Guide featured art (TvGuideView On Now +
 * Tonight), Quick Surf row art (TvQuickSurf), and the
 * TvProgrammeArt slot contract. The resolver, classifier,
 * hierarchy, cache and manifest are W1/W2/W4's — nothing here
 * tests them, and the artworkKind/provenance fields are the
 * SHIM-0112 type-only definitions until W1 lands the real ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCategoryTileArtwork,
  applyHeroArtwork,
  buildCategoryTileElement,
  fillLandingHero,
  wideArtworkUrl,
  type LandingCategory,
  type LandingHeroModel,
} from "@/scripts/lib/livetv-landing";
import {
  detailArtworkUrl,
  mountChannelBrowser,
} from "@/scripts/lib/livetv-browser";
import {
  clearProgrammeArtworkCache,
  placeholderArtwork,
  type ProgrammeArtwork,
} from "@/scripts/lib/livetv-enrichment";
import type { LivetvChannel, LivetvNowNext } from "@/scripts/lib/livetv-data";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const read = (rel: string) => readFileSync(join(repo, rel), "utf8");

function ch(
  partial: Partial<LivetvChannel> & { id: string | number; name: string },
): LivetvChannel {
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

/** Full ProgrammeArtwork fixture; `kind` omitted = legacy resolver output. */
function art(
  over: Partial<ProgrammeArtwork> & {
    artworkKind?: ProgrammeArtwork["artworkKind"];
  } = {},
): ProgrammeArtwork {
  return {
    backdropUrl: null,
    posterUrl: null,
    stillUrl: null,
    source: "placeholder",
    confidence: 0,
    matchedTitle: null,
    synopsis: null,
    genres: [],
    ...over,
  };
}

const SPORT_BACKDROP = "https://fixtures.invalid/art/snooker-wide.jpg";
const HOCKEY_BACKDROP = "https://fixtures.invalid/art/hockey-wide.jpg";
const FILM_BACKDROP = "https://fixtures.invalid/art/film-wide.jpg";
const LOGO_POSTER = "https://fixtures.invalid/logos/channel.png";

beforeEach(() => {
  window.localStorage.removeItem("xt_tmdb_key");
  window.localStorage.removeItem("xt_livetv_enrichment_v1");
  clearProgrammeArtworkCache();
  sessionStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.removeItem("xt_tmdb_key");
  window.localStorage.removeItem("xt_livetv_enrichment_v1");
  clearProgrammeArtworkCache();
});

// ── Landing: wide-slot helper ─────────────────────────────────────

describe("wideArtworkUrl (hero + category tiles, 16:9 slots)", () => {
  it("returns the backdrop for every displayable kind, whatever the identity confidence", () => {
    for (const kind of [
      "exact-programme",
      "exact-sports-event",
      "league-team",
      "generic-sport",
    ] as const) {
      expect(
        wideArtworkUrl(
          art({ artworkKind: kind, backdropUrl: SPORT_BACKDROP, confidence: 0 }),
        ),
      ).toBe(SPORT_BACKDROP);
    }
  });

  it("never returns channel-branding or placeholder art, even with a backdrop URL", () => {
    expect(
      wideArtworkUrl(
        art({ artworkKind: "channel-branding", backdropUrl: SPORT_BACKDROP, confidence: 0.5 }),
      ),
    ).toBeNull();
    expect(
      wideArtworkUrl(
        art({ artworkKind: "placeholder", backdropUrl: SPORT_BACKDROP, confidence: 0 }),
      ),
    ).toBeNull();
  });

  it("never returns a poster-only result: portrait logos must not stretch across the band", () => {
    expect(
      wideArtworkUrl(
        art({ artworkKind: "generic-sport", posterUrl: LOGO_POSTER, confidence: 0 }),
      ),
    ).toBeNull();
    expect(
      wideArtworkUrl(art({ artworkKind: "league-team", stillUrl: SPORT_BACKDROP })),
    ).toBeNull();
  });

  it("keeps the legacy backdrop-only rule when no kind is reported", () => {
    expect(
      wideArtworkUrl(art({ source: "tmdb-series", backdropUrl: FILM_BACKDROP, confidence: 0.85 })),
    ).toBe(FILM_BACKDROP);
    expect(
      wideArtworkUrl(art({ source: "channel", posterUrl: LOGO_POSTER, confidence: 0.5 })),
    ).toBeNull();
    expect(wideArtworkUrl(placeholderArtwork())).toBeNull();
  });
});

// ── Landing: hero ─────────────────────────────────────────────────

function heroEl(): HTMLElement {
  const section = document.createElement("section");
  section.setAttribute("data-livetv-hero", "");
  section.setAttribute("hidden", "");
  section.innerHTML = `
    <div data-hero-art><div data-programme-art data-art-state="placeholder"><span class="rs-livetv-programme-art__brand">Sky Sports</span></div></div>
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
  `;
  document.body.appendChild(section);
  return section;
}

const heroModel: LandingHeroModel = {
  channel: ch({ id: 106, name: "Sky Sports Snooker", logo: "https://x/snooker.png" }),
  eyebrow: "On Now",
  current: {
    title: "World Snooker Championship",
    start: 1000,
    stop: 2000,
    progress: 0.5,
    timeRange: "17:30–19:00",
    description: null,
  },
  next: null,
  isResume: false,
};

describe("applyHeroArtwork (0.11.12 kinds)", () => {
  it("paints generic-sport backdrop art with zero identity confidence", () => {
    const el = heroEl();
    fillLandingHero(el, heroModel);
    expect(
      applyHeroArtwork(
        el,
        art({
          artworkKind: "generic-sport",
          backdropUrl: SPORT_BACKDROP,
          confidence: 0,
          source: "placeholder",
        }),
        "World Snooker Championship",
      ),
    ).toBe(true);
    expect(el.querySelector("[data-hero-art] img")?.getAttribute("src")).toBe(
      SPORT_BACKDROP,
    );
    expect(el.classList.contains("rs-livetv-landing-hero--has-art")).toBe(true);
  });

  it("paints exact-sports-event and league-team backdrops", () => {
    for (const kind of ["exact-sports-event", "league-team"] as const) {
      const el = heroEl();
      fillLandingHero(el, heroModel);
      expect(
        applyHeroArtwork(
          el,
          art({ artworkKind: kind, backdropUrl: HOCKEY_BACKDROP, confidence: 0.4 }),
          "World Snooker Championship",
        ),
      ).toBe(true);
      expect(el.querySelector("[data-hero-art] img")?.getAttribute("src")).toBe(
        HOCKEY_BACKDROP,
      );
      el.remove();
    }
  });

  it("refuses channel-branding art even when it carries a backdrop URL", () => {
    const el = heroEl();
    fillLandingHero(el, heroModel);
    expect(
      applyHeroArtwork(
        el,
        art({ artworkKind: "channel-branding", backdropUrl: SPORT_BACKDROP, confidence: 0.5 }),
        "World Snooker Championship",
      ),
    ).toBe(false);
    expect(el.querySelector("[data-hero-art] img")).toBeNull();
    expect(el.querySelector("[data-hero-art] [data-programme-art]")).not.toBeNull();
  });

  it("refuses poster-only sports art: no stretched portrait in the widescreen hero", () => {
    const el = heroEl();
    fillLandingHero(el, heroModel);
    expect(
      applyHeroArtwork(
        el,
        art({ artworkKind: "generic-sport", posterUrl: LOGO_POSTER, confidence: 0 }),
        "World Snooker Championship",
      ),
    ).toBe(false);
    expect(el.querySelector("[data-hero-art] img")).toBeNull();
  });

  it("keeps the stale-request guard for the new art: superseded heroes drop late art", () => {
    const el = heroEl();
    fillLandingHero(el, heroModel);
    expect(
      applyHeroArtwork(
        el,
        art({ artworkKind: "generic-sport", backdropUrl: SPORT_BACKDROP, confidence: 0 }),
        "Some Other Show",
      ),
    ).toBe(false);
    expect(el.querySelector("[data-hero-art] img")).toBeNull();
  });

  it("keeps the load/error fallback: a broken sports URL restores the placeholder", () => {
    const el = heroEl();
    fillLandingHero(el, heroModel);
    applyHeroArtwork(
      el,
      art({ artworkKind: "generic-sport", backdropUrl: SPORT_BACKDROP, confidence: 0 }),
      "World Snooker Championship",
    );
    const img = el.querySelector("[data-hero-art] img") as HTMLImageElement;
    expect(img).not.toBeNull();
    img.dispatchEvent(new Event("error"));
    expect(el.querySelector("[data-hero-art] img")).toBeNull();
    expect(el.classList.contains("rs-livetv-landing-hero--no-art")).toBe(true);
  });
});

// ── Landing: category tiles ───────────────────────────────────────

describe("category tiles (0.11.12 kinds)", () => {
  it("applyCategoryTileArtwork still swaps the glyph for one <img> and restores it on error", () => {
    const cat: LandingCategory = {
      id: "sports",
      label: "Sports",
      count: 12,
      nowPlaying: { channelName: "Sky Sports", programmeTitle: "World Snooker Championship" },
      variant: 1,
      artworkUrl: null,
    };
    const tile = buildCategoryTileElement(cat);
    expect(tile.querySelector("img")).toBeNull();
    expect(applyCategoryTileArtwork(tile, SPORT_BACKDROP)).toBe(true);
    const img = tile.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(SPORT_BACKDROP);
    img.dispatchEvent(new Event("error"));
    expect(tile.querySelector("img")).toBeNull();
    expect(
      tile.querySelector(".rs-livetv-landing-category-tile__glyph")?.textContent,
    ).toBe("⚽");
  });

  it("enrichCategoryTiles routes tile art through the wide-slot kind rule", () => {
    // The tile loop composes wideArtworkUrl + applyCategoryTileArtwork;
    // the helper tests above pin the rule, this pins the wiring.
    const src = read("src/scripts/lib/livetv-landing.ts");
    const start = src.indexOf("export async function enrichCategoryTiles");
    const end = src.indexOf("function heroLogoFallback", start);
    const fn = src.slice(start, end);
    expect(fn).toContain("wideArtworkUrl(cached)");
    expect(fn).toContain("wideArtworkUrl(art)");
    expect(fn).toContain("applyCategoryTileArtwork(tile, cachedWide)");
    expect(fn).toContain("applyCategoryTileArtwork(tile, wide)");
    expect(fn).not.toContain("cached.backdropUrl");
    expect(fn).not.toContain("art.backdropUrl");
  });
});

// ── Browser: detail-panel helper ──────────────────────────────────

describe("detailArtworkUrl (browser 16:9 detail slot)", () => {
  it("returns wide art for displayable kinds regardless of identity confidence", () => {
    expect(
      detailArtworkUrl(art({ artworkKind: "generic-sport", backdropUrl: HOCKEY_BACKDROP, confidence: 0 })),
    ).toBe(HOCKEY_BACKDROP);
    expect(
      detailArtworkUrl(art({ artworkKind: "exact-sports-event", stillUrl: HOCKEY_BACKDROP, confidence: 0 })),
    ).toBe(HOCKEY_BACKDROP);
    expect(
      detailArtworkUrl(art({ artworkKind: "league-team", posterUrl: LOGO_POSTER, confidence: 0 })),
    ).toBe(LOGO_POSTER);
  });

  it("keeps the backdrop → still → poster order for displayable and legacy art", () => {
    expect(
      detailArtworkUrl(
        art({ artworkKind: "exact-programme", backdropUrl: "b", stillUrl: "s", posterUrl: "p" }),
      ),
    ).toBe("b");
    expect(
      detailArtworkUrl(art({ artworkKind: "exact-programme", stillUrl: "s", posterUrl: "p" })),
    ).toBe("s");
    expect(
      detailArtworkUrl(art({ source: "tmdb-movie", backdropUrl: "b", posterUrl: "p", confidence: 0.9 })),
    ).toBe("b");
  });

  it("returns null for channel-branding / placeholder kinds even with URLs", () => {
    expect(
      detailArtworkUrl(
        art({ artworkKind: "channel-branding", backdropUrl: "b", posterUrl: LOGO_POSTER, confidence: 0.5 }),
      ),
    ).toBeNull();
    expect(
      detailArtworkUrl(art({ artworkKind: "placeholder", backdropUrl: "b", confidence: 0 })),
    ).toBeNull();
    expect(detailArtworkUrl(null)).toBeNull();
    expect(detailArtworkUrl(undefined)).toBeNull();
    expect(detailArtworkUrl(placeholderArtwork())).toBeNull();
  });
});

// ── Browser: highlighted-only enrichment ──────────────────────────

const BROWSER_CHANNELS = [
  ch({ id: 1, name: "Zebra News", categoryId: "News" }),
  ch({ id: 2, name: "Alpha Sports", categoryId: "Sports", favourite: true }),
  ch({ id: 3, name: "Mid Movies", categoryId: "Movies" }),
  ch({ id: 4, name: "Beta Sports", categoryId: "Sports", favourite: true }),
];

const BROWSER_NOW_NEXT: Record<number, LivetvNowNext> = {
  2: {
    current: { title: "NHL: Bruins at Rangers", start: 17_300, stop: 19_000, desc: "" },
    next: { title: "NHL Tonight", start: 19_000, stop: 20_000, desc: "" },
  },
  3: {
    current: { title: "Casablanca", start: 17_300, stop: 19_000, desc: "" },
    next: null,
  },
};

describe("channel browser detail art (0.11.12 kinds)", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
  });

  it("paints generic-sport art for the highlighted channel only, once, with no re-enrich on scroll", async () => {
    const enrich = vi.fn(async () =>
      art({
        artworkKind: "generic-sport",
        backdropUrl: HOCKEY_BACKDROP,
        confidence: 0,
        matchedTitle: "NHL: Bruins at Rangers",
        genres: ["Sport"],
      }),
    );
    const handle = mountChannelBrowser(root, {
      channels: BROWSER_CHANNELS,
      nowNextFor: (channel) => BROWSER_NOW_NEXT[Number(channel.id)] ?? { current: null, next: null },
      enrichProgramme: enrich,
    });
    handle.highlightChannel(2);
    await vi.waitFor(() => {
      expect(root.querySelector("[data-browser-detail-art-img]")).not.toBeNull();
    });
    expect(root.querySelector("[data-browser-detail-art-img]")?.getAttribute("src")).toBe(
      HOCKEY_BACKDROP,
    );
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledWith(
      expect.objectContaining({ title: "NHL: Bruins at Rangers" }),
    );
    const list = root.querySelector<HTMLElement>("[data-browser-list]")!;
    list.dispatchEvent(new Event("scroll"));
    list.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enrich).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it("film channels keep their TMDb art unchanged (legacy kind-less result)", async () => {
    const enrich = vi.fn(async () =>
      art({
        source: "tmdb-movie",
        backdropUrl: FILM_BACKDROP,
        posterUrl: LOGO_POSTER,
        confidence: 0.95,
        matchedTitle: "Casablanca",
      }),
    );
    const handle = mountChannelBrowser(root, {
      channels: BROWSER_CHANNELS,
      nowNextFor: (channel) => BROWSER_NOW_NEXT[Number(channel.id)] ?? { current: null, next: null },
      enrichProgramme: enrich,
    });
    handle.highlightChannel(3);
    await vi.waitFor(() => {
      expect(root.querySelector("[data-browser-detail-art-img]")).not.toBeNull();
    });
    expect(root.querySelector("[data-browser-detail-art-img]")?.getAttribute("src")).toBe(
      FILM_BACKDROP,
    );
    handle.destroy();
  });

  it("channel-branding art never fills the panel: the branded logo placeholder stands", async () => {
    const enrich = vi.fn(async () =>
      art({
        artworkKind: "channel-branding",
        backdropUrl: HOCKEY_BACKDROP,
        posterUrl: LOGO_POSTER,
        confidence: 0.5,
        matchedTitle: "NHL: Bruins at Rangers",
      }),
    );
    const handle = mountChannelBrowser(root, {
      channels: BROWSER_CHANNELS,
      nowNextFor: (channel) => BROWSER_NOW_NEXT[Number(channel.id)] ?? { current: null, next: null },
      enrichProgramme: enrich,
    });
    handle.highlightChannel(2);
    await vi.waitFor(() => {
      expect(root.querySelector("[data-browser-detail-art]")).not.toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.querySelector("[data-browser-detail-art-img]")).toBeNull();
    expect(
      root.querySelector("[data-browser-detail-art] .rs-livetv-browser__detail-art-logo"),
    ).not.toBeNull();
    handle.destroy();
  });

  it("an ambiguous non-sport result (placeholder kind) paints no art", async () => {
    const enrich = vi.fn(async () =>
      art({ artworkKind: "placeholder", backdropUrl: FILM_BACKDROP, confidence: 0 }),
    );
    const handle = mountChannelBrowser(root, {
      channels: BROWSER_CHANNELS,
      nowNextFor: (channel) => BROWSER_NOW_NEXT[Number(channel.id)] ?? { current: null, next: null },
      enrichProgramme: enrich,
    });
    handle.highlightChannel(3);
    await vi.waitFor(() => {
      expect(root.querySelector("[data-browser-detail-art]")).not.toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.querySelector("[data-browser-detail-art-img]")).toBeNull();
    handle.destroy();
  });
});

// ── Guide: featured art (On Now + Tonight share usableArtUrl) ────

/**
 * Evaluate the Guide's ACTUAL usableArtUrl from the shipped
 * TvGuideView.astro source (plus the two constants it closes
 * over) — the function is self-contained by construction, so the
 * tests below exercise the real code, not a copy.
 */
function loadGuideUsableArtUrl(): (art: any) => string | null {
  const src = read("src/components/couch/TvGuideView.astro");
  const kindsStart = src.indexOf("const DISPLAYABLE_FEATURED_ART_KINDS");
  const kindsEnd = src.indexOf("]);", kindsStart) + 3;
  const confStart = src.indexOf("const FEATURED_ART_CONFIDENCE_MIN");
  const confEnd = src.indexOf(";", confStart) + 1;
  const fnStart = src.indexOf("function usableArtUrl(art)");
  if (kindsStart < 0 || confStart < 0 || fnStart < 0) {
    throw new Error("Guide featured-art code not found in TvGuideView.astro");
  }
  let depth = 0;
  let fnEnd = -1;
  for (let i = src.indexOf("{", fnStart); i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        fnEnd = i + 1;
        break;
      }
    }
  }
  if (fnEnd < 0) throw new Error("Could not extract usableArtUrl");
  const factory = new Function(
    `${src.slice(kindsStart, kindsEnd)}\n${src.slice(confStart, confEnd)}\n${src.slice(fnStart, fnEnd)}\nreturn usableArtUrl;`,
  ) as () => (art: any) => string | null;
  return factory();
}

describe("Guide featured art (usableArtUrl, On Now + Tonight)", () => {
  const usableArtUrl = loadGuideUsableArtUrl();

  it("accepts generic-sport art with low identity confidence", () => {
    expect(
      usableArtUrl({
        artworkKind: "generic-sport",
        backdropUrl: SPORT_BACKDROP,
        stillUrl: null,
        source: "placeholder",
        confidence: 0,
      }),
    ).toBe(SPORT_BACKDROP);
  });

  it("accepts exact-sports-event / league-team / exact-programme art", () => {
    expect(
      usableArtUrl({ artworkKind: "exact-sports-event", backdropUrl: HOCKEY_BACKDROP, confidence: 0.2 }),
    ).toBe(HOCKEY_BACKDROP);
    expect(
      usableArtUrl({ artworkKind: "league-team", backdropUrl: HOCKEY_BACKDROP, confidence: 0 }),
    ).toBe(HOCKEY_BACKDROP);
    expect(
      usableArtUrl({ artworkKind: "exact-programme", backdropUrl: FILM_BACKDROP, confidence: 0.9 }),
    ).toBe(FILM_BACKDROP);
  });

  it("prefers the backdrop, then the still, and never a poster in the wide slot", () => {
    expect(
      usableArtUrl({ artworkKind: "generic-sport", backdropUrl: "b", stillUrl: "s", posterUrl: "p" }),
    ).toBe("b");
    expect(
      usableArtUrl({ artworkKind: "exact-sports-event", backdropUrl: null, stillUrl: "s", posterUrl: "p" }),
    ).toBe("s");
    expect(
      usableArtUrl({ artworkKind: "generic-sport", backdropUrl: null, stillUrl: null, posterUrl: "p" }),
    ).toBeNull();
  });

  it("rejects channel-branding and placeholder kinds even with a backdrop URL", () => {
    expect(
      usableArtUrl({ artworkKind: "channel-branding", backdropUrl: SPORT_BACKDROP, confidence: 0.5 }),
    ).toBeNull();
    expect(
      usableArtUrl({ artworkKind: "placeholder", backdropUrl: SPORT_BACKDROP, confidence: 0 }),
    ).toBeNull();
    expect(
      usableArtUrl({ artworkKind: "something-else", backdropUrl: SPORT_BACKDROP, confidence: 1 }),
    ).toBeNull();
  });

  it("rejects an ambiguous non-sport title: no kind + low confidence paints nothing", () => {
    expect(
      usableArtUrl({ source: "tmdb-movie", backdropUrl: FILM_BACKDROP, confidence: 0.3 }),
    ).toBeNull();
    expect(
      usableArtUrl({ source: "placeholder", backdropUrl: null, confidence: 0 }),
    ).toBeNull();
    expect(usableArtUrl(null)).toBeNull();
  });

  it("keeps the legacy confidence gate for kind-less confident matches", () => {
    expect(
      usableArtUrl({ source: "tmdb-series", backdropUrl: FILM_BACKDROP, confidence: 0.85 }),
    ).toBe(FILM_BACKDROP);
    expect(
      usableArtUrl({ source: "tmdb-series", backdropUrl: FILM_BACKDROP, confidence: 0.6 }),
    ).toBe(FILM_BACKDROP);
    expect(
      usableArtUrl({ source: "tmdb-series", backdropUrl: FILM_BACKDROP, confidence: "high" }),
    ).toBeNull();
  });

  it("both featured slots (On Now + Tonight) route through the one painter", () => {
    const guide = read("src/components/couch/TvGuideView.astro");
    expect(guide).toContain('scheduleFeaturedArt("now"');
    expect(guide).toContain('scheduleFeaturedArt("tonight"');
    expect(guide).toContain("usableArtUrl(mod.getProgrammeArtworkSync(programme.title))");
    expect(guide).toContain("usableArtUrl(art)");
    // The EPG data path is untouched by the consumer wiring.
    expect(guide).toContain("loadGuideProgrammes");
    expect(guide).toContain("guideDataState");
  });
});

// ── Quick Surf: artwork lookup/rendering only ────────────────────

describe("TvQuickSurf artwork (0.11.12 kinds)", () => {
  const surf = read("src/components/couch/TvQuickSurf.astro");

  it("gates row art on artworkKind through one wrapper around the shared picker", () => {
    expect(surf).toContain("DISPLAYABLE_SURF_ART_KINDS");
    expect(surf).toContain('"exact-programme"');
    expect(surf).toContain('"exact-sports-event"');
    expect(surf).toContain('"league-team"');
    expect(surf).toContain('"generic-sport"');
    expect(surf).toContain("displayableSurfArtUrl");
    expect(surf).toContain("return artworkUrlForSurf(art);");
    // Both lookup sites (sync cache peek + settled async enrich)
    // route through the gate — no direct picker calls remain.
    expect(surf).toContain("displayableSurfArtUrl(cached)");
    expect(surf).toContain("displayableSurfArtUrl(art ?? null)");
    expect(surf.match(/artworkUrlForSurf\(/g)?.length).toBe(1);
  });

  it("carries the new kind on its local enrichment-result type", () => {
    expect(surf).toContain("type SurfArtworkResult = SurfProgrammeArtwork");
    expect(surf).toContain("artworkKind?");
    expect(surf).toContain('"channel-branding"');
    expect(surf).toContain("Promise<SurfArtworkResult | null>");
    expect(surf).toContain("=> SurfArtworkResult | null");
  });

  it("preserves the 0.11.11 highlighted-only lookup with cancellation", () => {
    expect(surf).toContain("scheduleHighlightedArt");
    expect(surf).toContain("artGeneration++");
    expect(surf).toContain("}, 250);");
    expect(surf).toContain("paintHighlightedArt");
    expect(surf).toContain("highlightedArtKey");
  });

  it("preserves navigation, tuning, and the four discovery actions; adds no overlays or buttons", () => {
    expect(surf).toContain("stepHighlightBounded");
    expect(surf).toContain("surfWindowBounded");
    expect(surf).toContain("confirmHighlight");
    expect(surf).toContain("switchChannel");
    expect(surf).toContain("QUICK_SURF_CLOSE_EVENT");
    expect(surf).toContain("QUICK_SURF_OPEN_BROWSER_EVENT");
    expect(surf.match(/data-qs-discovery=/g)?.length).toBe(4);
    const qsHooks = new Set([...surf.matchAll(/data-qs-[a-z-]+/g)].map((m) => m[0]));
    expect([...qsHooks].sort()).toEqual([
      "data-qs-discovery",
      "data-qs-discovery-actions",
      "data-qs-group",
      "data-qs-list",
      "data-qs-position",
      "data-qs-row",
      "data-qs-row-template",
      "data-qs-step",
    ]);
  });
});

// ── TvProgrammeArt slots + SHIM discipline ───────────────────────

describe("TvProgrammeArt slots + SHIM-0112 discipline", () => {
  it("keeps the slot order (card: poster first; wide: backdrop first) behind the kind gate", () => {
    const astro = read("src/components/couch/TvProgrammeArt.astro");
    expect(astro).toContain("kindDisplayable");
    expect(astro).toContain('cachedKind === "generic-sport"');
    expect(astro).toContain("cached.posterUrl ?? cached.backdropUrl ?? cached.stillUrl");
    expect(astro).toContain("cached.backdropUrl ?? cached.stillUrl ?? cached.posterUrl");
    expect(astro).toContain("rs-livetv-programme-art__placeholder");
    expect(astro).toContain("upgradeProgrammeArtElements");
  });

  it("the enrichment module carries ONLY the two SHIM type fields", () => {
    const enrichment = read("src/scripts/lib/livetv-enrichment.ts");
    expect(enrichment.match(/SHIM-0112: type-only, W1 owns the real definition/g)?.length).toBe(2);
    expect(enrichment).toContain("artworkKind?");
    expect(enrichment).toContain("provenance?");
    expect(enrichment).toContain('"generic-sport"');
    expect(enrichment).toContain("licenceUrl?: string");
  });
});

// ── Category tiles, end to end through the seeded cache ──────────
// Runs LAST: it resets the module registry so the enrichment cache
// hydrates from a seeded localStorage entry, proving the tile loop
// paints seeded generic-sport art and refuses seeded
// channel-branding art without any network call.
describe("enrichCategoryTiles through the seeded enrichment cache", () => {
  const PERSIST_KEY = "xt_livetv_enrichment_v1";

  async function runWithSeededCache(seed: Record<string, unknown>) {
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify(seed));
    vi.resetModules();
    const landing = await import("@/scripts/lib/livetv-landing");
    const row = document.createElement("div");
    const category: LandingCategory = {
      id: "sports",
      label: "Sports",
      count: 12,
      nowPlaying: { channelName: "Sky Sports", programmeTitle: "World Snooker Championship" },
      variant: 1,
      artworkUrl: null,
    };
    row.appendChild(landing.buildCategoryTileElement(category));
    document.body.appendChild(row);
    await landing.enrichCategoryTiles(row, [category]);
    return row;
  }

  afterEach(() => {
    window.localStorage.removeItem(PERSIST_KEY);
    vi.resetModules();
  });

  it("paints the seeded generic-sport backdrop on the sport tile", async () => {
    const row = await runWithSeededCache({
      "World Snooker Championship": {
        art: art({
          artworkKind: "generic-sport",
          backdropUrl: SPORT_BACKDROP,
          confidence: 0,
          source: "placeholder",
        }),
        expiresAt: Date.now() + 60_000,
        negative: false,
      },
    });
    expect(
      row.querySelector("img.rs-livetv-landing-category-tile__art-img")?.getAttribute("src"),
    ).toBe(SPORT_BACKDROP);
    row.remove();
  });

  it("keeps the glyph when the seeded art is channel-branding", async () => {
    const row = await runWithSeededCache({
      "World Snooker Championship": {
        art: art({
          artworkKind: "channel-branding",
          backdropUrl: SPORT_BACKDROP,
          posterUrl: LOGO_POSTER,
          confidence: 0.5,
          source: "channel",
        }),
        expiresAt: Date.now() + 60_000,
        negative: false,
      },
    });
    expect(row.querySelector("img")).toBeNull();
    expect(
      row.querySelector(".rs-livetv-landing-category-tile__glyph")?.textContent,
    ).toBe("⚽");
    row.remove();
  });
});
