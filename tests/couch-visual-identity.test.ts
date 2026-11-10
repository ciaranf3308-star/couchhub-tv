/**
 * RedSilk visual-identity regressions (W4).
 *
 * The app background read PURPLE on the projector while the token hex
 * looked burgundy-ish on paper: the old tokens sat at HSL hue 313–329°
 * (magenta/purple) and the hardcoded scrims rgb(10 5 8)/rgb(8 4 7) at
 * hue 315–324°. These tests pin the fix at the token level — every
 * colour literal in couch.css must be achromatic or in the wine hue
 * family (340–355°), and the key tokens must hold their exact values
 * — plus the branded fallback system (kind labels, per-kind rules,
 * channel-logo :has() fallbacks) that replaced the generic fallback.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fallbackKindLabel,
  defaultMediaForKind,
} from "@/scripts/lib/couch-image";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const couchCss = readFileSync(join(repo, "src/styles/couch.css"), "utf8");
const tvImageAstro = readFileSync(
  join(repo, "src/components/couch/TvImage.astro"),
  "utf8",
);
// Comments carry audit notes that name the old purple values — strip
// them so the scan only sees live code.
const cssNoComments = couchCss.replace(/\/\*[\s\S]*?\*\//g, "");

function hueOfRgb(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min <= 12) return null; // achromatic (grey / white / black)
  let h: number;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  return ((h * 60) % 360 + 360) % 360;
}

/** Burgundy/wine hue family: red-dominant, blue only just above green. */
function isBurgundyHue(hue: number | null): boolean {
  return hue === null || (hue >= 340 && hue <= 355);
}

describe("burgundy tokens (purple audit)", () => {
  it("holds the canonical token values in the wine hue family", () => {
    const expected: Record<string, string> = {
      "--rs-bg": "#170a0c",
      "--rs-bg-2": "#281015",
      "--rs-surface": "#3c1a21",
      "--rs-accent": "#a83a54",
      "--rs-focus": "#eaa9b8",
      "--rs-text": "#f8f1f2",
      "--rs-text-2": "#c4abb1",
      "--rs-ink": "#0d0406",
      "--rs-panel": "#1f0a0f",
    };
    for (const [token, value] of Object.entries(expected)) {
      expect(couchCss).toContain(`${token}: ${value}`);
      const hex = value.slice(1);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const hue = hueOfRgb(r, g, b);
      // Near-white text is achromatic by definition; its warmth is
      // carried by the channel ordering (red > blue >= green).
      if (hue !== null) {
        expect(hue).toBeGreaterThanOrEqual(340);
        expect(hue).toBeLessThanOrEqual(355);
      }
      // Red-dominant: never blue-leaning.
      expect(r).toBeGreaterThan(b);
      expect(b).toBeGreaterThanOrEqual(g);
    }
  });

  it("has no purple/blue-dominant hex anywhere in live couch.css", () => {
    const hexes = [...cssNoComments.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)];
    expect(hexes.length).toBeGreaterThan(0);
    for (const [full] of hexes) {
      const h = full.slice(1);
      const [r, g, b] =
        h.length === 3
          ? [h[0] + h[0], h[1] + h[1], h[2] + h[2]].map((x) => parseInt(x, 16))
          : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((x) =>
              parseInt(x, 16),
            );
      expect(
        isBurgundyHue(hueOfRgb(r, g, b)),
        `${full} must be achromatic or burgundy (hue 340–355°)`,
      ).toBe(true);
    }
  });

  it("has no purple/blue-dominant rgb() literal anywhere in live couch.css", () => {
    const rgbs = [
      ...cssNoComments.matchAll(
        /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/[^)]*)?\)/g,
      ),
    ];
    expect(rgbs.length).toBeGreaterThan(0);
    for (const [, rs, gs, bs] of rgbs) {
      const hue = hueOfRgb(Number(rs), Number(gs), Number(bs));
      expect(
        isBurgundyHue(hue),
        `rgb(${rs} ${gs} ${bs}) must be achromatic or burgundy (hue 340–355°)`,
      ).toBe(true);
    }
  });

  it("has no purple/blue oklch hue in live couch.css", () => {
    const hues = [
      ...cssNoComments.matchAll(/oklch\([\d.]+ [\d.]+ ([\d.]+)/g),
    ].map((m) => Number(m[1]));
    expect(hues.length).toBeGreaterThan(0);
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(340);
      expect(hue).toBeLessThanOrEqual(355);
    }
  });

  it("never reintroduces the old purple tokens or scrims", () => {
    for (const banned of [
      "#160d14",
      "#24131e",
      "#35202d",
      "#a84365",
      "#e5a6bd",
      "#bfa9b5",
      "rgb(10 5 8",
      "rgb(8 4 7",
      "rgb(20 10 16",
    ]) {
      expect(cssNoComments.toLowerCase()).not.toContain(banned);
    }
  });

  it("pins the upstream global.css tokens to burgundy under data-couch", () => {
    // global.css defaults the accent to fuchsia (hue 330) and the
    // accent picker can set data-accent blue/violet; any Couch surface
    // consuming --color-* would render purple without this guard.
    expect(couchCss).toContain(":root[data-couch]");
    expect(couchCss).toContain("--xt-tint-hue: 350");
    expect(couchCss).toContain("--color-accent: oklch(0.72 0.17 350)");
    expect(couchCss).toContain("--color-bg: oklch(0.155 0.045 350)");
  });

  it("keeps the browser chrome + redirect page on the new background", () => {
    const layout = readFileSync(
      join(repo, "src/layouts/CouchLayout.astro"),
      "utf8",
    );
    expect(layout).toContain('content="#170A0C"');
    expect(layout.toLowerCase()).not.toContain("#160d14");
    const epg = readFileSync(join(repo, "src/pages/epg.astro"), "utf8");
    expect(epg).toContain("background:#170a0c");
  });
});

describe("branded fallback art", () => {
  it("labels every fallback honestly by type, never fabricating art", () => {
    expect(fallbackKindLabel("poster", "movie")).toBe("Movie · No artwork");
    expect(fallbackKindLabel("poster", "series")).toBe("Series · No artwork");
    expect(fallbackKindLabel("logo", "channel")).toBe("Channel · No artwork");
    expect(fallbackKindLabel("logo")).toBe("Channel · No artwork");
    expect(fallbackKindLabel("thumb", "episode")).toBe("Episode · No artwork");
    expect(fallbackKindLabel("thumb")).toBe("Episode · No artwork");
    // Posters/backdrops cover movies AND series: no guessing.
    expect(fallbackKindLabel("poster")).toBe("No artwork");
    expect(fallbackKindLabel("backdrop")).toBe("No artwork");
  });

  it("defaults media only where the kind settles it", () => {
    expect(defaultMediaForKind("logo")).toBe("channel");
    expect(defaultMediaForKind("thumb")).toBe("episode");
    expect(defaultMediaForKind("poster")).toBeUndefined();
    expect(defaultMediaForKind("backdrop")).toBeUndefined();
  });

  it("TvImage renders the branded fallback automatically, by kind", () => {
    expect(tvImageAstro).toContain("fallbackKindLabel");
    expect(tvImageAstro).toContain("rs-image__fallback-kind");
    expect(tvImageAstro).toContain("rs-image__fallback-mark");
    expect(tvImageAstro).toContain("rs-image__fallback-title");
    expect(tvImageAstro).toContain("data-media");
    // The fallback is automatic: no caller passes a fallback prop.
    expect(tvImageAstro).not.toMatch(/fallback\s*[,?:]/);
    // Never a broken-image icon: error handling arms the CSS fallback.
    expect(tvImageAstro).toContain("armTvImageFallbacks");
    expect(tvImageAstro).not.toContain("onerror");
  });

  it("styles the fallback per kind in couch.css", () => {
    for (const rule of [
      ".rs-image__fallback-mark",
      ".rs-image__fallback-kind",
      ".rs-image--backdrop .rs-image__fallback-mark",
      ".rs-image--logo .rs-image__fallback-mark",
      ".rs-image--thumb .rs-image__fallback-mark",
      // Hero already renders the title as its H1: no duplicate line.
      ".rs-hero__backdrop .rs-image.is-fallback .rs-image__fallback-title",
      // A broken image icon must never render.
      ".rs-image.is-fallback img",
    ]) {
      expect(couchCss).toContain(rule);
    }
    // Medallion, not a bare letter: ringed disc behind the initials.
    expect(couchCss).toContain("border-radius: 50%");
    // Manrope only — the serif/sans split stays gone.
    expect(couchCss).not.toMatch(/\.rs-image__fallback[^}]*serif/);
  });

  it("gives logo-less channel chips the same burgundy fallback art", () => {
    // TvChannelCard / OSD / Quick Surf / Channel Browser render a bare
    // initial span when there is no logo at all; :has() swaps the white
    // real-logo chip for the burgundy gradient in exactly that case.
    for (const rule of [
      ".rs-livetv-play-osd__logo:has(.rs-livetv-play-osd__initial)",
      ".rs-livetv-channel-card__logo:has(.rs-livetv-channel-card__initial)",
      ".rs-livetv-browser__logo:has(.rs-livetv-browser__initial)",
    ]) {
      expect(couchCss).toContain(rule);
    }
  });
});
