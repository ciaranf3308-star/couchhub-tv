// 0.10.0 integration reconciliations (source level, repo style).
//
// Guards the merges the five workers could not own alone: one
// taxonomy source, the HomeView wiring, the dead browse-page module,
// the detail back-link paths, and the last /browse destination links.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("0.10.0 integration — single taxonomy source", () => {
  it("TvCard takes its badge label from taxonomy kindLabel, not a local map", () => {
    const src = read("src/components/couch/TvCard.astro");
    expect(src).toContain('import { kindLabel } from "@/scripts/lib/taxonomy.ts"');
    expect(src).toContain("kindLabel(contentKind)");
    expect(src).not.toContain("CONTENT_KIND_LABELS");
  });

  it("B08 documentary separation goes through classifyTitle, not a genre check", () => {
    const movies = read("src/scripts/movies/couch-movies.ts");
    expect(movies).toContain("classifyTitle({ type: \"movie\", category: row.category })");
    expect(movies).not.toContain('movieGenres(row).includes("documentary")');
    const series = read("src/scripts/series/couch-series.ts");
    expect(series).toContain("classifyTitle({ type: \"series\", category: row.category })");
    expect(series).not.toContain('seriesGenres(row).includes("documentary")');
  });
});

describe("0.10.0 integration — HomeView wiring (H01/H04/H06)", () => {
  it("HomeView passes rail.variant / rail.sparse and the item kind badge", () => {
    const src = read("src/components/HomeView.svelte");
    expect(src).toContain("rs-rail--variant-${rail.variant}");
    expect(src).toContain("rs-rail--sparse");
    expect(src).toContain("data-rail-count={rail.items.length}");
    expect(src).toContain("data-rail-variant={rail.variant}");
    expect(src).toContain("kindLabel(item.contentKind)");
    expect(src).toContain("data-content-kind={item.contentKind}");
    expect(src).not.toContain('href="/browse"');
  });
});

describe("0.10.0 integration — dead code + back links + /browse refs", () => {
  it("couch-browse-page.ts and its only test are gone", () => {
    expect(existsSync(join(root, "src/scripts/browse/couch-browse-page.ts"))).toBe(false);
    expect(existsSync(join(root, "tests/couch-browse-landing.test.ts"))).toBe(false);
    expect(existsSync(join(root, "src/scripts/browse"))).toBe(false);
  });

  it("detail controllers point back at their own catalogue page", () => {
    expect(read("src/scripts/movies/couch-detail.ts")).toContain(
      'wireDetailBackLink($("movie-detail-back"), "/movies")',
    );
    expect(read("src/scripts/series/couch-detail.ts")).toContain(
      'wireDetailBackLink($("series-detail-back"), "/series")',
    );
    expect(read("src/scripts/movies/couch-detail.ts")).not.toContain('"/browse"');
    expect(read("src/scripts/series/couch-detail.ts")).not.toContain('"/browse"');
  });

  it("no detail page wires a second back-link listener", () => {
    // The controller (couch-detail.ts) owns the back link now; the
    // pages only carry the anchor itself.
    expect(read("src/pages/movies/detail.astro")).not.toContain(
      'getElementById("movie-detail-back")',
    );
    expect(read("src/pages/series/detail.astro")).not.toContain(
      'getElementById("series-detail-back")',
    );
  });

  it("no real destination link still points at /browse", () => {
    // The only remaining /browse mentions are the redirect shim
    // itself, its nav mapping, and a tray known-route entry.
    const allowed = new Set([
      "src/pages/browse.astro",
      "src/scripts/lib/couch-nav.ts",
      "src/scripts/lib/tray-handler.ts",
      "src/scripts/lib/browse-filters.ts",
      "src/scripts/movies/couch-browse.ts",
      "src/scripts/movies/couch-index.ts",
      "src/scripts/series/couch-index.ts",
      "src/scripts/movies/couch-movies-adapter.ts",
      "src/scripts/series/couch-series-adapter.ts",
    ]);
    const hits: string[] = [];
    const out = execSync(
      "grep -rn --include='*.astro' --include='*.svelte' --include='*.ts' '/browse' src",
      { cwd: root, encoding: "utf8" },
    ) as string;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // "/browser", "/browse-filters", "/browse-movies" … are module
      // or word matches, not the retired /browse route.
      if (/\/browse[-a-z]/i.test(line)) continue;
      const rel = line.split(":")[0];
      if (!allowed.has(rel)) hits.push(line);
    }
    expect(hits).toEqual([]);
  });

  it("Followed's empty state links to /series, not the retired /browse", () => {
    expect(read("src/pages/followed.astro")).toContain('actionHref="/series"');
    expect(read("src/pages/followed.astro")).not.toContain("/browse");
  });
});

describe("0.10.0 integration — genre-rail evidence floor", () => {
  it("genre pools require evidence (votes or a TMDb match)", () => {
    expect(read("src/scripts/lib/home-rails.ts")).toContain("if (!hasAnyEvidence(candidate)) return false");
  });
});
