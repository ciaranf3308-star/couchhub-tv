// 0.11.8 W3 — home/browse mode + URL contract (W2 shim).
//
// Pins the URL contract Movies Home depends on: Home is the
// default, Browse is explicit, and mode/category/page/query survive
// a parse → build round-trip so a detail return restores the exact
// view. Integration swaps the shim for W2's real home-browse-modes
// module against these same expectations.

import { describe, it, expect } from "vitest";
import {
  buildModeUrl,
  parseModeFromUrl,
  setModeInUrl,
  shouldMountBrowse,
  type HomeBrowseMode,
} from "@/scripts/movies/movies-home-modes-shim";

describe("parseModeFromUrl", () => {
  it("defaults to Home for a missing, empty or unknown view", () => {
    expect(parseModeFromUrl("")).toEqual({ view: "home" });
    expect(parseModeFromUrl("?")).toEqual({ view: "home" });
    expect(parseModeFromUrl("?view=home")).toEqual({ view: "home" });
    expect(parseModeFromUrl("?view=weird")).toEqual({ view: "home" });
    expect(parseModeFromUrl("view=browse")).toEqual({ view: "browse" });
  });
  it("reads Browse mode case-insensitively", () => {
    expect(parseModeFromUrl("?view=BROWSE").view).toBe("browse");
    expect(parseModeFromUrl("?view=Browse").view).toBe("browse");
  });
  it("reads genre, sort, page, query, list and focus", () => {
    expect(parseModeFromUrl("?view=browse&genre=horror&sort=added&page=3&q=star&list=recent&focus=search")).toEqual({
      view: "browse",
      genre: "horror",
      sort: "added",
      page: 3,
      query: "star",
      list: "recent",
      focus: "search",
    });
  });
  it("rejects invalid page values", () => {
    expect(parseModeFromUrl("?view=browse&page=0").page).toBeUndefined();
    expect(parseModeFromUrl("?view=browse&page=-2").page).toBeUndefined();
    expect(parseModeFromUrl("?view=browse&page=abc").page).toBeUndefined();
    expect(parseModeFromUrl("?view=browse&page=2").page).toBe(2);
  });
  it("trims values and drops empties", () => {
    expect(parseModeFromUrl("?view=browse&genre=%20%20&q=%20")).toEqual({ view: "browse" });
  });
});

describe("buildModeUrl", () => {
  it("builds the clean canonical Home URL", () => {
    expect(buildModeUrl({ view: "home" })).toBe("/movies");
  });
  it("always carries view=browse for Browse mode", () => {
    expect(buildModeUrl({ view: "browse" })).toBe("/movies?view=browse");
    expect(buildModeUrl({ view: "browse", genre: "action" })).toBe("/movies?view=browse&genre=action");
    expect(buildModeUrl({ view: "browse", sort: "added" })).toBe("/movies?view=browse&sort=added");
    expect(buildModeUrl({ view: "browse", list: "continue" })).toBe("/movies?view=browse&list=continue");
    expect(buildModeUrl({ view: "browse", focus: "search" })).toBe("/movies?view=browse&focus=search");
  });
  it("round-trips through parseModeFromUrl without loss", () => {
    const modes: HomeBrowseMode[] = [
      { view: "home" },
      { view: "browse" },
      { view: "browse", genre: "sci-fi", sort: "rating", page: 4 },
      { view: "browse", query: "star voyage", list: "favorites" },
      { view: "browse", genre: "drama", page: 1, focus: "search" },
    ];
    for (const mode of modes) {
      expect(parseModeFromUrl(buildModeUrl(mode))).toEqual(mode);
    }
  });
  it("encodes query text safely", () => {
    const url = buildModeUrl({ view: "browse", query: "a & b" });
    expect(parseModeFromUrl(url).query).toBe("a & b");
  });
});

describe("shouldMountBrowse", () => {
  it("mounts Browse only for Browse mode", () => {
    expect(shouldMountBrowse({ view: "browse" })).toBe(true);
    expect(shouldMountBrowse({ view: "home" })).toBe(false);
  });
});

describe("setModeInUrl", () => {
  it("is a safe no-op without a window (non-DOM runtimes)", () => {
    expect(() => setModeInUrl({ view: "browse", genre: "action" })).not.toThrow();
  });
});
