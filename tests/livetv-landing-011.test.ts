/**
 * @vitest-environment jsdom
 *
 * 0.11.0 Live TV Landing (W3): programme-led cinematic hero via
 * the enrichment layer, Recently Watched quick access, and
 * category tiles with contextual artwork or a small glyph — the
 * giant initial is gone. Enrichment without a TMDb key resolves
 * to placeholder art and never throws or touches the network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCategoryTileArtwork,
  applyHeroArtwork,
  buildCategoryTileElement,
  categoryGlyphFor,
  enrichCategoryTiles,
  fillLandingHero,
  upgradeLandingHeroArt,
  type LandingCategory,
  type LandingHeroModel,
} from "@/scripts/lib/livetv-landing";
import {
  enrichProgramme,
  getProgrammeArtworkSync,
  normaliseProgrammeTitle,
  placeholderArtwork,
  prefetchProgrammes,
  __clearEnrichmentMemoryCache,
} from "@/scripts/lib/livetv-enrichment";
import type { LivetvChannel } from "@/scripts/lib/livetv-data";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const couchCss = readFileSync(join(repo, "src/styles/couch.css"), "utf8");
const landingCss = couchCss.slice(
  couchCss.indexOf("/* Live TV 0.11.0 — Landing (W3) */"),
);
const artAstro = readFileSync(
  join(repo, "src/components/couch/TvProgrammeArt.astro"),
  "utf8",
);

function ch(partial: Partial<LivetvChannel> & { id: string | number; name: string }): LivetvChannel {
  return {
    displayName: partial.name,
    logo: null,
    category: "",
    categoryId: "",
    categoryLabel: "",
    streamUrl: null,
    tvgId: null,
    catchup: false,
    favourite: false,
    hidden: false,
    norm: partial.name.toLowerCase(),
    ...partial,
  };
}

function heroEl(): HTMLElement {
  const section = document.createElement("section");
  section.setAttribute("data-livetv-hero", "");
  section.setAttribute("hidden", "");
  section.innerHTML = `
    <div data-hero-art><div data-programme-art data-art-state="placeholder"><span class="rs-livetv-programme-art__brand">Sky Sports F1</span></div></div>
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

beforeEach(() => {
  window.localStorage.removeItem("xt_tmdb_key");
  window.localStorage.removeItem("redsilk:livetv:enrichment:v1");
  __clearEnrichmentMemoryCache();
  sessionStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.removeItem("xt_tmdb_key");
  window.localStorage.removeItem("redsilk:livetv:enrichment:v1");
  __clearEnrichmentMemoryCache();
});

// ── Enrichment contract (no key → placeholder, never throws) ───

describe("livetv-enrichment (W2 contract)", () => {
  it("normaliseProgrammeTitle strips only safe provider noise", () => {
    expect(normaliseProgrammeTitle("F1: Brazilian GP [HD]")).toBe("F1: Brazilian GP");
    expect(normaliseProgrammeTitle("LIVE: Match of the Day")).toBe("Match of the Day");
    expect(normaliseProgrammeTitle("The Chase S12E04")).toBe("The Chase");
    expect(normaliseProgrammeTitle("Friends 1x02")).toBe("Friends");
    expect(normaliseProgrammeTitle("News at Ten | Sky")).toBe("News at Ten");
    // The programme name itself is never rewritten.
    expect(normaliseProgrammeTitle("F1: Brazilian Grand Prix — Qualifying")).toBe(
      "F1: Brazilian Grand Prix — Qualifying",
    );
    expect(normaliseProgrammeTitle("  ")).toBe("");
  });

  it("placeholderArtwork is the honest miss shape", () => {
    const art = placeholderArtwork();
    expect(art.source).toBe("placeholder");
    expect(art.confidence).toBe(0);
    expect(art.backdropUrl).toBeNull();
    expect(art.matchedTitle).toBeNull();
  });

  it("enrichProgramme without a TMDb key resolves placeholder and never throws", async () => {
    const art = await enrichProgramme({ title: "F1: Brazilian Grand Prix — Qualifying" });
    expect(art.source).toBe("placeholder");
    expect(art.backdropUrl).toBeNull();
    expect(await enrichProgramme({ title: "" })).toEqual(placeholderArtwork());
    expect(await enrichProgramme({ title: "   " })).toEqual(placeholderArtwork());
  });

  it("getProgrammeArtworkSync is a cache peek only (null on a miss, no network)", () => {
    expect(getProgrammeArtworkSync("Nothing Cached Here")).toBeNull();
    expect(getProgrammeArtworkSync("")).toBeNull();
  });

  it("prefetchProgrammes never throws and does nothing without a key", () => {
    expect(() => prefetchProgrammes(["A", "B", "A", ""])).not.toThrow();
    expect(() => prefetchProgrammes([])).not.toThrow();
  });
});

// ── Category glyphs ─────────────────────────────────────────────

describe("categoryGlyphFor", () => {
  it("maps familiar labels to small glyphs and unknown labels to a neutral spark", () => {
    expect(categoryGlyphFor("Sports")).toBe("⚽");
    expect(categoryGlyphFor("UK | Sports")).toBe("⚽");
    expect(categoryGlyphFor("Movies")).toBe("🎬");
    expect(categoryGlyphFor("Series")).toBe("📺");
    expect(categoryGlyphFor("Entertainment")).toBe("★");
    expect(categoryGlyphFor("Documentaries")).toBe("🏔");
    expect(categoryGlyphFor("Kids")).toBe("🧸");
    expect(categoryGlyphFor("News")).toBe("📰");
    expect(categoryGlyphFor("Music")).toBe("♪");
    expect(categoryGlyphFor("Something Entirely New")).toBe("✦");
  });
});

// ── Hero art upgrade ────────────────────────────────────────────

describe("hero artwork", () => {
  const model: LandingHeroModel = {
    channel: ch({ id: 106, name: "Sky Sports F1", tvgId: "sky.f1", logo: "https://x/f1.png" }),
    eyebrow: "Resume Watching",
    current: {
      title: "Qualifying",
      start: 1000,
      stop: 2000,
      progress: 0.5,
      timeRange: "17:30–19:00",
      description: "Live coverage from Interlagos.",
    },
    next: { title: "Highlights", start: 2000, stop: 3000, timeRange: "19:00–19:30" },
    isResume: true,
  };

  it("fillLandingHero shows the EPG synopsis and stamps the art title", () => {
    const el = heroEl();
    expect(fillLandingHero(el, model)).toBe(true);
    expect(el.querySelector("[data-hero-programme-title]")?.textContent).toBe("Qualifying");
    const desc = el.querySelector("[data-hero-description]");
    expect(desc?.textContent).toBe("Live coverage from Interlagos.");
    expect(desc?.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector("[data-hero-art]")?.getAttribute("data-art-title")).toBe("Qualifying");
  });

  it("fillLandingHero hides the synopsis line with no description and no programme", () => {
    const el = heroEl();
    const noDesc: LandingHeroModel = {
      ...model,
      current: { ...model.current!, description: null },
    };
    fillLandingHero(el, noDesc);
    expect(el.querySelector("[data-hero-description]")?.hasAttribute("hidden")).toBe(true);
    const noProg: LandingHeroModel = { ...model, current: null, next: null };
    fillLandingHero(el, noProg);
    expect(el.querySelector("[data-hero-programme-title]")?.textContent).toBe("Live TV");
    expect(el.querySelector("[data-hero-art]")?.getAttribute("data-art-title")).toBe("");
  });

  it("applyHeroArtwork swaps the placeholder for the backdrop <img>", () => {
    const el = heroEl();
    fillLandingHero(el, model);
    const art = placeholderArtwork();
    art.backdropUrl = "https://image.tmdb.org/t/p/w1280/backdrop.jpg";
    art.source = "tmdb-series";
    expect(applyHeroArtwork(el, art, "Qualifying")).toBe(true);
    const img = el.querySelector("[data-hero-art] img");
    expect(img?.getAttribute("src")).toBe("https://image.tmdb.org/t/p/w1280/backdrop.jpg");
    expect(img?.className).toContain("rs-livetv-programme-art__img");
    expect(el.querySelector("[data-hero-art] [data-programme-art]")).toBeNull();
  });

  it("applyHeroArtwork refuses art for a programme the hero no longer shows", () => {
    const el = heroEl();
    fillLandingHero(el, model);
    const art = placeholderArtwork();
    art.backdropUrl = "https://image.tmdb.org/t/p/w1280/other.jpg";
    art.source = "tmdb-movie";
    expect(applyHeroArtwork(el, art, "Some Other Show")).toBe(false);
    expect(el.querySelector("[data-hero-art] img")).toBeNull();
  });

  it("applyHeroArtwork returns false with no backdrop (placeholder stands)", () => {
    const el = heroEl();
    fillLandingHero(el, model);
    expect(applyHeroArtwork(el, placeholderArtwork(), "Qualifying")).toBe(false);
    expect(el.querySelector("[data-hero-art] [data-programme-art]")).not.toBeNull();
  });

  it("upgradeLandingHeroArt without a key leaves the branded placeholder in place", async () => {
    const el = heroEl();
    fillLandingHero(el, model);
    expect(await upgradeLandingHeroArt(el, model)).toBe(false);
    expect(el.querySelector("[data-hero-art] [data-programme-art]")).not.toBeNull();
    expect(await upgradeLandingHeroArt(el, null)).toBe(false);
    const noProg: LandingHeroModel = { ...model, current: null, next: null };
    expect(await upgradeLandingHeroArt(el, noProg)).toBe(false);
  });
});

// ── Category tile artwork ───────────────────────────────────────

describe("category tile artwork", () => {
  const cat: LandingCategory = {
    id: "sports",
    label: "Sports",
    count: 142,
    nowPlaying: { channelName: "Sky Sports", programmeTitle: "Match Live" },
    variant: 2,
  };

  it("applyCategoryTileArtwork swaps the glyph for the backdrop <img>", () => {
    const tile = buildCategoryTileElement(cat);
    expect(tile.querySelector(".rs-livetv-landing-category-tile__glyph")).not.toBeNull();
    expect(applyCategoryTileArtwork(tile, "https://image.tmdb.org/t/p/w1280/art.jpg")).toBe(true);
    expect(tile.querySelectorAll("img")).toHaveLength(1);
    expect(tile.querySelector(".rs-livetv-landing-category-tile__glyph")).toBeNull();
    expect(applyCategoryTileArtwork(tile, null)).toBe(false);
  });

  it("enrichCategoryTiles without a key leaves every tile on gradient + glyph", async () => {
    const row = document.createElement("div");
    row.appendChild(buildCategoryTileElement(cat));
    row.appendChild(
      buildCategoryTileElement({
        id: "news",
        label: "News",
        count: 41,
        nowPlaying: { channelName: "Sky News", programmeTitle: "News at Ten" },
        variant: 1,
      }),
    );
    await enrichCategoryTiles(row, [
      cat,
      {
        id: "news",
        label: "News",
        count: 41,
        nowPlaying: { channelName: "Sky News", programmeTitle: "News at Ten" },
        variant: 1,
      },
    ]);
    expect(row.querySelectorAll("img")).toHaveLength(0);
    expect(row.querySelectorAll(".rs-livetv-landing-category-tile__glyph")).toHaveLength(2);
  });

  it("enrichCategoryTiles does nothing when no tile has a now-playing programme", async () => {
    const row = document.createElement("div");
    row.appendChild(
      buildCategoryTileElement({ id: "sports", label: "Sports", count: 3, nowPlaying: null, variant: 0 }),
    );
    await enrichCategoryTiles(row, [
      { id: "sports", label: "Sports", count: 3, nowPlaying: null, variant: 0 },
    ]);
    expect(row.querySelectorAll("img")).toHaveLength(0);
  });
});

// ── TvProgrammeArt component contract ───────────────────────────

describe("TvProgrammeArt.astro", () => {
  it("renders the branded placeholder shell, never a giant initial or an empty rectangle", () => {
    expect(artAstro).toContain("rs-livetv-programme-art");
    expect(artAstro).toContain("data-programme-art");
    expect(artAstro).toContain("data-art-state");
    expect(artAstro).toContain("__brand");
    const markup = artAstro.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^---[\s\S]*?---/m, "");
    expect(markup).not.toContain("<img");
    // No giant initial anywhere in the component.
    expect(artAstro).not.toContain("__motif");
    expect(artAstro).not.toContain("toUpperCase");
  });

  it("the shared programme-art CSS covers the hero layer and the brand treatment", () => {
    expect(landingCss).toContain(".rs-livetv-programme-art");
    expect(landingCss).toContain(".rs-livetv-programme-art__img");
    expect(landingCss).toContain("object-fit: cover");
    expect(landingCss).toContain(".rs-livetv-programme-art__brand");
  });
});

// ── Landing CSS: hero composition + quick hierarchy ─────────────

describe("landing CSS (0.11.0)", () => {
  it("the hero is a programme-art band with fades, not a flat gradient + logo block", () => {
    expect(landingCss).toContain(".rs-livetv-landing-hero__art");
    expect(landingCss).toContain(".rs-livetv-landing-hero__art::after");
    expect(landingCss).toContain("linear-gradient(90deg");
    expect(landingCss).toContain(".rs-livetv-landing-hero__description");
    expect(landingCss).toContain(".rs-livetv-landing-hero__channel");
  });

  it("quick access has one primary pill and quieter pills", () => {
    expect(landingCss).toContain(".rs-livetv-landing-quick__action--primary");
    expect(landingCss).toContain("border-radius: 999px");
  });

  it("no colour literals outside tokens: every literal is achromatic or wine 340–355°", () => {
    // Scope to the landing / programme-art rules only (the file
    // interleaves other screens' blocks between the landing's).
    const rules = couchCss.match(
      /html\[data-couch\] \.(?:rs-livetv-landing|rs-livetv-programme-art)[^{]*\{[^}]*\}/g,
    );
    expect(rules).not.toBeNull();
    expect(rules!.length).toBeGreaterThan(20);
    const joined = rules!.join("\n");
    expect(joined).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(joined).not.toMatch(/\brgb\(/);
    expect(joined).not.toMatch(/\bhsl\(/);
  });
});
