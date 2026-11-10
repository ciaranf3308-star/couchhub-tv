// Browse split (0.10.0, W2) — nav + routing.
//
// Reverses the 0.8.0 Browse consolidation (user's explicit call):
// /movies, /series and /discover are real destinations again, and
// /browse is only a thin redirect (?type=movies -> /movies,
// ?type=series -> /series, anything else -> /discover). Detail routes
// keep working at their own URLs and point back to their own
// catalogue page. The nav is Home | Movies | Series | Discover |
// Live TV | Followed — NO Browse entry.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  COUCH_NAV_PRIMARY,
  couchNavIdFor,
} from "@/scripts/lib/couch-nav.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("Browse split: /movies, /series, /discover are real pages", () => {
  it("/movies renders the catalogue (no redirect)", () => {
    expect(existsSync(join(root, "src/pages/movies/index.astro"))).toBe(true);
    const src = read("src/pages/movies/index.astro");
    expect(src).not.toContain("Astro.redirect");
    expect(src).toContain('activeNav="movies"');
    expect(src).toContain('id="couch-browse-rails"');
    expect(src).toContain('id="couch-browse-grid"');
  });

  it("/series renders the catalogue (no redirect)", () => {
    expect(existsSync(join(root, "src/pages/series/index.astro"))).toBe(true);
    const src = read("src/pages/series/index.astro");
    expect(src).not.toContain("Astro.redirect");
    expect(src).toContain('activeNav="series"');
    expect(src).toContain('id="couch-browse-rails"');
    expect(src).toContain('id="couch-browse-grid"');
  });

  it("/discover renders the Discover page (no redirect)", () => {
    expect(existsSync(join(root, "src/pages/discover.astro"))).toBe(true);
    const src = read("src/pages/discover.astro");
    expect(src).not.toContain("Astro.redirect");
    expect(src).toContain('activeNav="discover"');
    expect(src).toContain("DiscoverView");
  });

  it("no catalogue page carries a Live TV section (B11)", () => {
    for (const rel of [
      "src/pages/movies/index.astro",
      "src/pages/series/index.astro",
    ]) {
      const src = read(rel);
      expect(src).not.toContain("On TV Right Now");
      expect(src).not.toContain("on-tv");
      expect(src).not.toContain("livetv");
    }
  });
});

describe("Browse split: /browse is only a thin redirect", () => {
  it("redirects ?type=movies -> /movies, ?type=series -> /series, else -> /discover", () => {
    // Client-side redirect on purpose: the app ships as a static
    // build, so a frontmatter Astro.redirect would bake in one target
    // at build time and could never branch on the query string.
    const src = read("src/pages/browse.astro");
    expect(src).toContain('"/movies"');
    expect(src).toContain('"/series"');
    expect(src).toContain('"/discover"');
    expect(src).toContain("location.replace");
    expect(src).not.toContain("Astro.redirect");
    expect(src).not.toContain("CouchLayout");
    expect(src).not.toContain('id="browse-movies"');
    expect(src).not.toContain('id="browse-series"');
  });
});

describe("Browse split: nav order and active state (H08-nav)", () => {
  it("top nav is Home | Movies | Series | Discover | Live TV | Followed, no Browse", () => {
    expect(COUCH_NAV_PRIMARY.map((item) => item.id)).toEqual([
      "home",
      "movies",
      "series",
      "discover",
      "livetv",
      "followed",
    ]);
    expect(COUCH_NAV_PRIMARY.map((item) => item.href)).toEqual([
      "/",
      "/movies",
      "/series",
      "/discover",
      "/livetv",
      "/followed",
    ]);
  });

  it("active-state matching resolves each destination to itself", () => {
    expect(couchNavIdFor("/")).toBe("home");
    expect(couchNavIdFor("/movies")).toBe("movies");
    expect(couchNavIdFor("/movies/detail?id=1")).toBe("movies");
    expect(couchNavIdFor("/series")).toBe("series");
    expect(couchNavIdFor("/series/detail?id=1")).toBe("series");
    expect(couchNavIdFor("/discover")).toBe("discover");
    expect(couchNavIdFor("/livetv")).toBe("livetv");
    expect(couchNavIdFor("/followed")).toBe("followed");
  });

  it("the layout renders the nav from the destination table", () => {
    const layout = read("src/layouts/CouchLayout.astro");
    expect(layout).toContain("COUCH_NAV_PRIMARY");
    expect(layout).not.toContain('"browse"');
  });
});

describe("Browse split deep links", () => {
  it("detail routes still exist at their own URLs — no redirect", () => {
    const movieDetail = read("src/pages/movies/detail.astro");
    const seriesDetail = read("src/pages/series/detail.astro");
    expect(movieDetail).not.toContain("Astro.redirect");
    expect(seriesDetail).not.toContain("Astro.redirect");
    expect(movieDetail).toContain("movie-detail-hero");
    expect(seriesDetail).toContain("series-detail-hero");
  });

  it("detail back-links return to their own catalogue page and highlight it", () => {
    expect(read("src/pages/movies/detail.astro")).toContain('href="/movies"');
    expect(read("src/pages/series/detail.astro")).toContain('href="/series"');
    expect(read("src/pages/movies/detail.astro")).not.toContain(
      'href="/browse?type=movies"',
    );
    expect(read("src/pages/series/detail.astro")).not.toContain(
      'href="/browse?type=series"',
    );
    expect(read("src/pages/movies/detail.astro")).toContain('activeNav="movies"');
    expect(read("src/pages/series/detail.astro")).toContain('activeNav="series"');
  });

  it("detail screens carry the feedback menu (B06) and no poster feedback", () => {
    for (const rel of [
      "src/pages/movies/detail.astro",
      "src/pages/series/detail.astro",
    ]) {
      const src = read(rel);
      expect(src).toContain("feedback-dialog");
      expect(src).toContain("More Like This");
      expect(src).toContain("Not Interested");
      expect(src).toContain("Why This?");
      expect(src).toContain("feedback-watched");
    }
    expect(read("src/pages/movies/index.astro")).not.toContain("feedback");
    expect(read("src/pages/series/index.astro")).not.toContain("feedback");
  });
});
