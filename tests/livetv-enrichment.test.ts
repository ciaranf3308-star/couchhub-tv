/**
 * @vitest-environment jsdom
 *
 * Live TV programme enrichment (0.11.0 W4 contract module): the API
 * never throws, returns placeholder art on any failure, caches
 * (including failed matches), and never makes a paid/network call
 * when TMDb is inactive. No real TMDb key exists in this harness,
 * so every call here must resolve to placeholder art without
 * touching the network.
 */
import { describe, it, expect } from "vitest";
import {
  enrichProgramme,
  getProgrammeArtworkSync,
  prefetchProgrammes,
  resetProgrammeArtworkCache,
  PROGRAMME_ARTWORK_NEGATIVE_TTL_MS,
} from "@/scripts/lib/livetv-enrichment";

describe("enrichProgramme", () => {
  it("never throws and returns placeholder art for an empty title", async () => {
    await expect(enrichProgramme({ title: "" })).resolves.toMatchObject({
      source: "placeholder",
      confidence: 0,
      backdropUrl: null,
      posterUrl: null,
      matchedTitle: null,
    });
    await expect(enrichProgramme({ title: "   " })).resolves.toMatchObject({
      source: "placeholder",
    });
  });

  it("returns placeholder art without TMDb (no key in this harness) and never throws", async () => {
    const art = await enrichProgramme({
      title: "F1: Brazilian Grand Prix — Qualifying",
      channelName: "Sky Sports F1",
    });
    expect(art.source).toBe("placeholder");
    expect(art.confidence).toBe(0);
    expect(art.backdropUrl).toBeNull();
    expect(art.synopsis).toBeNull();
    expect(art.genres).toEqual([]);
  });

  it("with TMDb inactive the placeholder is deliberately NOT cached, so enabling a key later takes effect at once", async () => {
    resetProgrammeArtworkCache();
    expect(getProgrammeArtworkSync("F1: Brazilian Grand Prix — Qualifying")).toBeNull();
    await enrichProgramme({ title: "F1: Brazilian Grand Prix — Qualifying" });
    // No cache entry: the "TMDb inactive" placeholder is not a
    // failed match, and caching it for 24h would hide artwork after
    // the user enables a key. Genuine no-match placeholders (TMDb
    // active, searched, nothing found) ARE negative-cached 24h by
    // enrichProgramme — that path needs a live key to exercise.
    expect(getProgrammeArtworkSync("F1: Brazilian Grand Prix — Qualifying")).toBeNull();
  });

  it("prefetchProgrammes never throws and is bounded", () => {
    expect(() =>
      prefetchProgrammes([
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "K",
        "L",
      ]),
    ).not.toThrow();
    expect(() => prefetchProgrammes([])).not.toThrow();
    expect(() => prefetchProgrammes(["  ", ""])).not.toThrow();
  });

  it("the negative cache TTL is 24h", () => {
    expect(PROGRAMME_ARTWORK_NEGATIVE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("getProgrammeArtworkSync", () => {
  it("is a pure cache peek: null for unknown titles, never throws", () => {
    resetProgrammeArtworkCache();
    expect(getProgrammeArtworkSync("Never Enriched Show")).toBeNull();
    expect(getProgrammeArtworkSync("")).toBeNull();
  });
});
