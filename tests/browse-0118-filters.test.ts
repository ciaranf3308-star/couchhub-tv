// 0.11.8 W2 — browse-filters 0.11.8 extensions (brief §8/§9).
import { describe, expect, it } from "vitest";
import {
  browseDecadeKeyForYear,
  browseYearMatches,
  browseYearRangeMatches,
  languageMatches,
  providerCategoryMatches,
  runtimeBucketMatches,
  seasonCountMatches,
  watchStatusMatches,
} from "@/scripts/lib/browse-filters";

describe("browse decades (§8.2)", () => {
  it("1960s…2020s + Older (< 1960); unknown years never pass", () => {
    expect(browseDecadeKeyForYear(2024)).toBe("2020s");
    expect(browseDecadeKeyForYear(1965)).toBe("1960s");
    expect(browseDecadeKeyForYear(1959)).toBe("older");
    expect(browseDecadeKeyForYear(null)).toBe("");
    expect(browseYearMatches("2024", "2020s")).toBe(true);
    expect(browseYearMatches("1955", "older")).toBe(true);
    expect(browseYearMatches("", "2020s")).toBe(false);
    expect(browseYearMatches("", "")).toBe(true);
  });

  it("custom year ranges use release year and exclude unknowns", () => {
    expect(browseYearRangeMatches("2015", 2010, 2019)).toBe(true);
    expect(browseYearRangeMatches("2009", 2010, 2019)).toBe(false);
    expect(browseYearRangeMatches("", 2010, 2019)).toBe(false);
    expect(browseYearRangeMatches("2015", null, null)).toBe(true);
    expect(browseYearRangeMatches("2021", 2020, null)).toBe(true);
  });
});

describe("runtime buckets (§8.5 — unknown never passes)", () => {
  it("buckets match verified runtimes; unknown fails every constraint", () => {
    expect(runtimeBucketMatches({ duration: "45 min" }, "under-60")).toBe(true);
    expect(runtimeBucketMatches({ duration: "45 min" }, "under-90")).toBe(true);
    expect(runtimeBucketMatches({ duration: "02:05:00" }, "under-120")).toBe(false);
    expect(runtimeBucketMatches({ duration: "02:05:00" }, "under-150")).toBe(true);
    expect(runtimeBucketMatches({ duration: "200 min" }, "over-180")).toBe(true);
    expect(runtimeBucketMatches({ duration: "200 min" }, "under-180")).toBe(false);
    expect(runtimeBucketMatches({}, "under-60")).toBe(false);
    expect(runtimeBucketMatches({}, "over-180")).toBe(false);
    expect(runtimeBucketMatches({ duration: "garbage" }, "under-60")).toBe(false);
    expect(runtimeBucketMatches({}, "")).toBe(true);
  });
});

describe("season counts (§9.4 — confirmed only)", () => {
  it("buckets match confirmed counts; unknown fails every constraint", () => {
    expect(seasonCountMatches(1, "1")).toBe(true);
    expect(seasonCountMatches(2, "1")).toBe(false);
    expect(seasonCountMatches(4, "3+")).toBe(true);
    expect(seasonCountMatches(12, "10+")).toBe(true);
    expect(seasonCountMatches(9, "10+")).toBe(false);
    expect(seasonCountMatches(null, "1")).toBe(false);
    expect(seasonCountMatches(null, "3+")).toBe(false);
    expect(seasonCountMatches(null, "")).toBe(true);
    expect(seasonCountMatches(undefined, "5+")).toBe(false);
  });
});

describe("language / provider / watch status", () => {
  it("language matches exact catalogue tags only", () => {
    expect(languageMatches(["en", "fr"], "fr")).toBe(true);
    expect(languageMatches(["en"], "fr")).toBe(false);
    expect(languageMatches([], "fr")).toBe(false);
    expect(languageMatches([], "")).toBe(true);
    expect(languageMatches("EN", "en")).toBe(true);
  });

  it("provider category matches the raw provider string", () => {
    expect(providerCategoryMatches("Action FHD", "Action FHD")).toBe(true);
    expect(providerCategoryMatches("Action", "Action FHD")).toBe(false);
    expect(providerCategoryMatches("", "")).toBe(true);
  });

  it("watch status: in-progress wins, unwatched means in neither set", () => {
    const sets = { inProgressIds: new Set([1]), watchedIds: new Set([2]) };
    expect(watchStatusMatches(1, "in-progress", sets)).toBe(true);
    expect(watchStatusMatches(1, "watched", sets)).toBe(false);
    expect(watchStatusMatches(2, "watched", sets)).toBe(true);
    expect(watchStatusMatches(3, "unwatched", sets)).toBe(true);
    expect(watchStatusMatches(1, "unwatched", sets)).toBe(false);
    expect(watchStatusMatches(1, "", sets)).toBe(true);
  });
});
