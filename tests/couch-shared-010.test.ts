/**
 * W5 shared components + display (0.10.0): C3 poster card, C6 white
 * strip root fix, H04 rail variants, H06 sparse rails, C5 filter
 * controls CSS, and the Library legend configs.
 *
 * CSS assertions read src/styles/couch.css as text (same pattern as
 * couch-visual-identity.test.ts); component assertions read the
 * Astro sources; legend assertions run hintsForView directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hintsForView } from "@/scripts/lib/couch-button-hints";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const couchCss = readFileSync(join(repo, "src/styles/couch.css"), "utf8");
const tvCardAstro = readFileSync(join(repo, "src/components/couch/TvCard.astro"), "utf8");
const tvRailAstro = readFileSync(join(repo, "src/components/couch/TvRail.astro"), "utf8");
const tvButtonHintsAstro = readFileSync(
  join(repo, "src/components/couch/TvButtonHints.astro"),
  "utf8",
);

describe("C6 white strip — the canvas background is set at its cause", () => {
  it("html[data-couch] itself carries the burgundy background", () => {
    // Before 0.10.0 the burgundy existed ONLY as body's background,
    // which reaches the canvas solely by propagation — and only on
    // documents that load CouchLayout. The Astro redirect stubs
    // (/movies, /series, /discover) carry no layout and no styles,
    // so they painted on the default white canvas for 2 s.
    const htmlRule = couchCss.match(/html\[data-couch\] \{[^]*?\n\}/);
    expect(htmlRule).not.toBeNull();
    expect(htmlRule![0]).toContain("background: var(--rs-bg);");
  });

  it("the body is a flex column so .rs-main flex:1 stretches short pages", () => {
    const bodyRule = couchCss.match(
      /html\[data-couch\] body,\s*html\[data-couch\] \.rs-body \{[^]*?\n\}/,
    );
    expect(bodyRule).not.toBeNull();
    expect(bodyRule![0]).toContain("display: flex;");
    expect(bodyRule![0]).toContain("flex-direction: column;");
    expect(bodyRule![0]).toContain("min-height: 100vh;");
  });

  it("the Tauri window background matches the --rs-bg token", () => {
    const conf = JSON.parse(
      readFileSync(join(repo, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { app: { windows: Array<{ backgroundColor?: string }> } };
    // #170a0c == --rs-bg: the webview background behind any
    // transparent document (redirect stub, first paint) is burgundy,
    // not the old blue-grey #0b0f14 — and never white.
    expect(conf.app.windows[0].backgroundColor).toBe("#170a0c");
  });
});

describe("C3 poster card (TvCard)", () => {
  it("renders exactly one metadata line — no subtitle span, no feedback buttons", () => {
    expect(tvCardAstro).toContain('<span class="rs-card__meta">{metaLine}</span>');
    expect(tvCardAstro).not.toContain("rs-card__subtitle");
    expect(tvCardAstro).not.toContain("More Like This");
    expect(tvCardAstro).not.toContain("Not Interested");
  });

  it("badges from the taxonomy kind label, with an explicit override", () => {
    expect(tvCardAstro).toContain('contentKind?: TvContentKind');
    expect(tvCardAstro).toContain('movie: "Movie"');
    expect(tvCardAstro).toContain('"documentary-film": "Documentary Film"');
    expect(tvCardAstro).toContain('"documentary-series": "Documentary Series"');
    expect(tvCardAstro).toContain('live: "Live TV"');
    expect(tvCardAstro).toContain("badgeText");
  });

  it("composes the meta line as year · runtime · episode count", () => {
    expect(tvCardAstro).toContain('episodes === 1\n      ? "1 episode"');
    expect(tvCardAstro).toContain('.join(" · ")');
  });

  it("keeps the data attributes the detail flow needs", () => {
    expect(tvCardAstro).toContain("data-nylah-item");
    expect(tvCardAstro).toContain("data-couch-key={itemKey}");
    expect(tvCardAstro).toContain("data-content-kind={contentKind}");
  });
});

describe("H04 rail variants + H06 sparse rails", () => {
  it("defines one variant class per rail kind (TvRail `variant` prop)", () => {
    for (const variant of ["film", "series", "documentary", "followed", "live"]) {
      expect(couchCss).toContain(`.rs-rail--variant-${variant}`);
      expect(tvRailAstro).toContain("rs-rail--variant-${variant}");
    }
    expect(tvRailAstro).toContain('variant?: TvRailVariant');
  });

  it("defines the sparse-rail restyle (default density, quieter title)", () => {
    expect(couchCss).toContain(".rs-rail--sparse");
    expect(couchCss).toContain(
      ".rs-rail--sparse.rs-rail--large .rs-rail__row > .rs-card--poster",
    );
    expect(tvRailAstro).toContain("rs-rail--sparse");
    expect(tvRailAstro).toContain("data-rail-count={count}");
  });

  it("gives the rail row headroom for the 1.05 focus scale (no clipped meta line)", () => {
    // The row's overflow-x: auto makes overflow-y clip, so the old
    // 0.75rem/1rem padding cut a focused large card's ring + meta
    // line at the row edge (seen in the W5 renders). A large card is
    // ~520px tall: the scale needs ~13px per side plus the 3px ring.
    expect(couchCss).toContain("padding: 1.25rem 0.25rem 1.5rem;");
  });

  it("variant rules use tokens only — no new colour literals", () => {
    const variantBlock = couchCss.slice(
      couchCss.indexOf("── Rail variants"),
      couchCss.indexOf("── Sparse rails"),
    );
    expect(variantBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(variantBlock).not.toMatch(/rgba?\(/);
  });
});

describe("C5 filter controls CSS", () => {
  it("styles one labelled select per filter plus the segmented alternative", () => {
    expect(couchCss).toContain(".rs-filter-row");
    expect(couchCss).toContain(".rs-filter-field");
    expect(couchCss).toContain(".rs-filter-field__label");
    expect(couchCss).toContain(".rs-filter-field select");
    expect(couchCss).toContain(".rs-filter-field select:disabled");
    expect(couchCss).toContain(".rs-filter-segmented");
    expect(couchCss).toContain(".rs-filter-segmented__option.is-active");
  });
});

describe("controller legend (H08)", () => {
  it("Library lists get the audited Followed-style config (Y = Search)", () => {
    for (const view of ["favorites", "watchlist"]) {
      const config = hintsForView(view);
      expect(config.id).toBe(view);
      const labels = config.items.map((i) => `${i.glyph}:${i.label}`);
      expect(labels).toContain("dpad:Move");
      expect(labels).toContain("a:Select");
      expect(labels).toContain("y:Search");
      expect(labels).toContain("menu:Settings");
      expect(labels).toContain("view-menu:Return home");
      expect(labels).not.toContain("x:Details");
    }
  });

  it("the legend stays a fixed, unobtrusive bottom bar", () => {
    expect(tvButtonHintsAstro).toContain("position: fixed;");
    expect(tvButtonHintsAstro).toContain("bottom: 0.75rem;");
    expect(tvButtonHintsAstro).toContain("pointer-events: none;");
  });
});
