
// @vitest-environment jsdom
// Series Home mode/URL history tests (0.11.8, W4) — setModeInUrl
// writes real history: mode changes push (Back returns to the
// previous mode), same-mode param updates replace.

import { afterEach, describe, expect, it } from "vitest";
import {
  parseModeFromUrl,
  setModeInUrl,
} from "@/scripts/series/series-home-shims.ts";

afterEach(() => {
  window.history.replaceState(null, "", "/series");
});

describe("setModeInUrl — history behaviour", () => {
  it("returns the canonical URL and pushes a history entry on mode change", () => {
    window.history.replaceState(null, "", "/series");
    const before = window.history.length;
    const url = setModeInUrl("browse", { genre: "drama" });
    expect(url).toBe("/series?mode=browse&genre=drama");
    expect(window.location.pathname + window.location.search).toBe(url);
    expect(window.history.length).toBe(before + 1);
    expect(parseModeFromUrl().mode).toBe("browse");
  });

  it("replaces (no new entry) for same-mode param updates", () => {
    window.history.replaceState(null, "", "/series?mode=browse&genre=drama");
    const before = window.history.length;
    setModeInUrl("browse", { genre: "comedy" });
    expect(window.location.search).toBe("?mode=browse&genre=comedy");
    expect(window.history.length).toBe(before);
  });

  it("returns home to the bare path and parses back to home", () => {
    window.history.replaceState(null, "", "/series?mode=browse&genre=drama&page=2");
    const url = setModeInUrl("home");
    expect(url).toBe("/series");
    expect(parseModeFromUrl()).toEqual({ mode: "home", params: {} });
  });

  it("is a no-op when the URL already matches", () => {
    window.history.replaceState(null, "", "/series?mode=browse&genre=drama");
    const before = window.history.length;
    setModeInUrl("browse", { genre: "drama" });
    expect(window.history.length).toBe(before);
  });

  it("honours an explicit replace request on a mode change", () => {
    window.history.replaceState(null, "", "/series");
    const before = window.history.length;
    setModeInUrl("browse", {}, { replace: true });
    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe("?mode=browse");
  });
});
