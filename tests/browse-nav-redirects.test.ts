// Browse consolidation (0.8.0, W3) — nav + routing + redirects.
// (0.10.0: /discover is a real destination again; /movies and
// /series are still redirects until W2 restores them.)
//
// The retired /movies and /series destinations redirect
// into the single Browse destination (with the content-type filter
// where one applies); the detail routes keep working at their own
// URLs and point back into Browse. The /browse page itself is W1's
// — this file only guards the redirect/back-link contract, so it
// reads the page sources like tests/brand.test.ts does.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("Browse consolidation redirects", () => {
  it("/movies redirects to Browse with the movies filter", () => {
    expect(existsSync(join(root, "src/pages/movies/index.astro"))).toBe(true);
    expect(read("src/pages/movies/index.astro")).toContain(
      'Astro.redirect("/browse?type=movies")',
    );
  });

  it("/series redirects to Browse with the series filter", () => {
    expect(existsSync(join(root, "src/pages/series/index.astro"))).toBe(true);
    expect(read("src/pages/series/index.astro")).toContain(
      'Astro.redirect("/browse?type=series")',
    );
  });

  it("/discover is a real destination again (0.10.0) — no redirect", () => {
    expect(existsSync(join(root, "src/pages/discover.astro"))).toBe(true);
    const page = read("src/pages/discover.astro");
    expect(page).not.toContain("Astro.redirect");
    expect(page).toContain("DiscoverView");
    expect(page).toContain('activeNav="discover"');
  });
});

describe("Browse consolidation deep links", () => {
  it("detail routes still exist at their own URLs — no redirect", () => {
    const movieDetail = read("src/pages/movies/detail.astro");
    const seriesDetail = read("src/pages/series/detail.astro");
    expect(movieDetail).not.toContain("Astro.redirect");
    expect(seriesDetail).not.toContain("Astro.redirect");
    expect(movieDetail).toContain("movie-detail-hero");
    expect(seriesDetail).toContain("series-detail-hero");
  });

  it("detail back-links return to Browse with the right filter", () => {
    expect(read("src/pages/movies/detail.astro")).toContain(
      'href="/browse?type=movies"',
    );
    expect(read("src/pages/series/detail.astro")).toContain(
      'href="/browse?type=series"',
    );
    expect(read("src/pages/movies/detail.astro")).not.toContain('href="/movies"');
    expect(read("src/pages/series/detail.astro")).not.toContain('href="/series"');
  });

  it("detail and search pages highlight the Browse tab", () => {
    expect(read("src/pages/movies/detail.astro")).toContain('activeNav="browse"');
    expect(read("src/pages/series/detail.astro")).toContain('activeNav="browse"');
    expect(read("src/pages/search.astro")).toContain('activeNav="browse"');
  });

  it("Home empty-state and Followed empty-state link into Browse", () => {
    expect(read("src/components/HomeView.svelte")).toContain('href="/browse"');
    expect(read("src/components/HomeView.svelte")).not.toContain('href="/discover"');
    expect(read("src/pages/followed.astro")).toContain(
      'actionHref="/browse?type=series"',
    );
  });

  it("Home rails link into Browse, not the retired destinations", () => {
    const home = read("src/scripts/lib/couch-home.ts");
    const rails = read("src/scripts/lib/home-rails.ts");
    expect(home).toContain('href: "/browse"');
    expect(home).toContain('href: "/browse?type=series"');
    expect(home).not.toContain('href: "/discover"');
    expect(home).not.toContain('href: "/series"');
    expect(rails).toContain('seeAllHref: "/browse"');
    expect(rails).toContain('seeAllHref: "/browse?type=series"');
    expect(rails).not.toContain('seeAllHref: "/discover"');
    expect(rails).not.toContain('seeAllHref: "/series"');
  });
});
