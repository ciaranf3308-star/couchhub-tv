// W6 branding — brand strings present / upstream brand absent.
//
// Guards the de-brand: the new Couch shell must say "NylahBox Studios"
// and carry no InfiniTV brand; the upstream name survives ONLY in the
// GPL legal attribution on the docs page (and in code/docs identifiers
// outside the UI, which this test does not cover).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("NylahBox Studios branding (W6)", () => {
  it("CouchLayout brands as NylahBox Studios, with no InfiniTV brand", () => {
    const layout = read("src/layouts/CouchLayout.astro");
    expect(layout).toContain("NylahBox Studios");
    expect(layout).not.toContain("Nylah Studios");
    expect(layout).not.toMatch(/InfiniTV|infinitel8p|infinitv/i);
    expect(layout).toContain("TvLogo");
  });

  it("TvLogo renders the wordmark as live text", () => {
    const logo = read("src/components/couch/TvLogo.astro");
    expect(logo).toContain("NylahBox Studios");
    expect(logo).toContain("/brand/nylahbox-mark.png");
    expect(logo).toContain("/brand/nylahbox-lockup.png");
    expect(logo).not.toMatch(/InfiniTV|infinitel8p|infinitv/i);
  });

  it("TvLogo wordmark is the vendored script face, not pixelated", () => {
    const logo = read("src/components/couch/TvLogo.astro");
    // Great Vibes is the wordmark; Dancing Script Bold is the fallback
    // if the Great Vibes file ever fails to load.
    expect(logo).toContain("Great Vibes");
    expect(logo).toContain("Dancing Script");
    expect(logo).toContain("/fonts/great-vibes/great-vibes-latin-400-normal.woff2");
    expect(logo).toContain(
      "/fonts/dancing-script/dancing-script-latin-700-normal.woff2",
    );
    // The pup is photographic — the old pixel-TV `pixelated` rendering
    // must never come back.
    expect(logo).not.toContain("image-rendering: pixelated");
    // Login uses the live-text lockup, not the baked PNG lockup.
    expect(read("src/pages/login.astro")).toContain(
      '<TvLogo variant="lockup" size="splash" />',
    );
    expect(read("src/pages/login.astro")).not.toContain("lockup-image");
  });

  it("script font files are vendored locally (OFL)", () => {
    for (const f of [
      "public/fonts/great-vibes/great-vibes-latin-400-normal.woff2",
      "public/fonts/great-vibes/OFL.txt",
      "public/fonts/dancing-script/dancing-script-latin-700-normal.woff2",
      "public/fonts/dancing-script/OFL.txt",
    ]) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });

  it("window title is NylahBox Studios; productName untouched", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(conf.app.windows[0].title).toBe("NylahBox Studios");
    expect(conf.productName).toBe("CouchHub TV");
  });

  it("brand assets exist", () => {
    for (const f of [
      "public/brand/nylahbox-mark.png",
      "public/brand/nylahbox-lockup.png",
      "public/brand/nylahbox-mark.svg",
    ]) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });

  it("GPL attribution lives on the docs page (only user-facing upstream mention)", () => {
    const docs = read("src/pages/docs.astro");
    expect(docs).toContain("Extreme InfiniTV");
    expect(docs).toContain("GNU General Public License v3.0 or later");
  });

  it("favicon is the NylahBox mark, not the upstream mark", () => {
    const favicon = read("public/favicon.svg");
    expect(favicon).toContain("NylahBox Studios");
    expect(favicon).not.toContain("#ec92e5");
  });
});
