/**
 * Live TV 2.0 (0.11.7) W5 — fixture self-checks.
 *
 * The fixtures are the foundation of all fourteen tests: these
 * checks prove the generators deliver the sizes and shapes the
 * brief requires, deterministically, before any test trusts them.
 * Synthetic data only; nothing here plays a stream or touches a
 * network.
 */
import { describe, it, expect } from "vitest";
import {
  DUPLICATE_DISPLAY_NAMES,
  FIXTURE_NOW_MS,
  FIXTURE_SIZES,
  SPORTS_SUBCATEGORIES,
  buildEnormousCategoryFixture,
  buildFixtureChannels,
  buildFixtureProgrammes,
  buildFlatCategoryFixture,
  buildGuideFixture,
  channelsInRawCategory,
  distinctRawCategories,
  fixture200,
  fixture2000,
  fixture5000,
  fixture10000,
  hash32,
  rawCategoryCounts,
  sportsChannelsOracle,
} from "./fixtures";

describe("fixture sizes", () => {
  it("builds exactly 200 / 2,000 / 5,000 / 10,000 channels", () => {
    expect(fixture200()).toHaveLength(200);
    expect(fixture2000()).toHaveLength(2000);
    expect(fixture5000()).toHaveLength(5000);
    expect(fixture10000()).toHaveLength(10000);
    for (const size of FIXTURE_SIZES) {
      expect(buildFixtureChannels(size)).toHaveLength(size);
    }
  });

  it("is deterministic: the same size builds the same catalogue", () => {
    const a = buildFixtureChannels(2000);
    const b = buildFixtureChannels(2000);
    expect(a).toEqual(b);
    expect(buildFixtureChannels(200)).toEqual(buildFixtureChannels(200));
    expect(hash32(JSON.stringify(a))).toBe(hash32(JSON.stringify(b)));
  });

  it("gives every channel a unique provider id", () => {
    for (const channels of [fixture200(), fixture2000(), fixture10000()]) {
      const ids = new Set(channels.map((c) => String(c.id)));
      expect(ids.size).toBe(channels.length);
    }
  });

  it("rejects non-positive sizes", () => {
    expect(() => buildFixtureChannels(0)).toThrow();
    expect(() => buildFixtureChannels(-5)).toThrow();
  });
});

describe("fixture Sports shape", () => {
  it("Sports is the large group with all ten provider subcategories", () => {
    const channels = fixture2000();
    const sports = sportsChannelsOracle(channels);
    // 60% share at 2,000 channels.
    expect(sports.length).toBe(1200);
    const sportsRaws = distinctRawCategories(sports);
    // 3 regions × 10 subcategories = 30 distinct provider categories.
    expect(sportsRaws).toHaveLength(30);
    for (const sub of SPORTS_SUBCATEGORIES) {
      expect(sportsRaws.some((raw) => raw.endsWith(`| ${sub}`))).toBe(true);
    }
  });

  it("scales the Sports group at every size", () => {
    expect(sportsChannelsOracle(fixture200())).toHaveLength(120);
    expect(sportsChannelsOracle(fixture5000())).toHaveLength(3000);
    expect(sportsChannelsOracle(fixture10000())).toHaveLength(6000);
  });

  it("keeps same-label subcategories distinct across regions", () => {
    const channels = fixture2000();
    // "Football" appears under UK, US and IE as three raw categories.
    const footballRaws = distinctRawCategories(channels).filter((raw) =>
      raw.endsWith("| Football"),
    );
    expect(footballRaws).toEqual([
      "UK | Sports | Football",
      "US | Sports | Football",
      "IE | Sports | Football",
    ]);
    for (const raw of footballRaws) {
      expect(channelsInRawCategory(channels, raw).length).toBeGreaterThan(0);
    }
  });

  it("distributes Sports channels across every subcategory", () => {
    const counts = rawCategoryCounts(fixture2000());
    for (const [raw, count] of counts) {
      if (raw.includes("Sports")) {
        // 1200 sports / 30 raw categories = 40 each.
        expect(count).toBe(40);
      }
    }
  });
});

describe("fixture duplicate labels", () => {
  it("reuses display names across distinct provider ids", () => {
    const channels = fixture2000();
    for (const name of DUPLICATE_DISPLAY_NAMES) {
      const matches = channels.filter((c) => c.displayName === name);
      expect(matches.length).toBeGreaterThan(1);
      expect(new Set(matches.map((c) => String(c.id))).size).toBe(matches.length);
    }
  });

  it("never merges duplicates: ids stay unique per display name", () => {
    const channels = fixture10000();
    const byName = new Map<string, Set<string>>();
    for (const channel of channels) {
      const ids = byName.get(channel.displayName) ?? new Set();
      expect(ids.has(String(channel.id))).toBe(false);
      ids.add(String(channel.id));
      byName.set(channel.displayName, ids);
    }
  });
});

describe("fixture EPG shape", () => {
  it("is sparse by default: roughly 30% of channels carry programmes", () => {
    const channels = fixture2000();
    const programmes = buildFixtureProgrammes(channels);
    expect(programmes.size).toBeGreaterThan(400);
    expect(programmes.size).toBeLessThan(800);
    // Uncovered channels have NO entry (not an empty list).
    expect(programmes.size).toBeLessThan(channels.length);
  });

  it("gives every covered channel a programme on now and a next one", () => {
    const channels = fixture200();
    const programmes = buildFixtureProgrammes(channels);
    for (const list of programmes.values()) {
      expect(list.length).toBe(8);
      const current = list.find((p) => p.startMs <= FIXTURE_NOW_MS && p.stopMs > FIXTURE_NOW_MS);
      expect(current).toBeDefined();
      const next = list.find((p) => p.startMs > FIXTURE_NOW_MS);
      expect(next).toBeDefined();
    }
  });

  it("builds a full-coverage guide fixture with 2,000+ rows", () => {
    const { channels, programmes } = buildGuideFixture(2500);
    expect(channels).toHaveLength(2500);
    expect(programmes.size).toBe(2500);
  });
});

describe("fixture enormous / flat categories", () => {
  it("builds a single enormous provider category with no subcategories", () => {
    const channels = buildEnormousCategoryFixture(3000);
    expect(channels).toHaveLength(3000);
    expect(distinctRawCategories(channels)).toEqual(["UK | International"]);
    expect(rawCategoryCounts(channels).get("UK | International")).toBe(3000);
  });

  it("builds bare single-segment categories", () => {
    const channels = buildFlatCategoryFixture();
    expect(distinctRawCategories(channels)).toEqual(["Sports", "News", "Movies"]);
    expect(channelsInRawCategory(channels, "Sports")).toHaveLength(12);
  });
});
