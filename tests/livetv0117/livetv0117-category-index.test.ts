/**
 * Live TV 2.0 (0.11.7) W5 — tests 1, 2, 3, 8: the category index.
 *
 *   1. Selecting Sports preserves its underlying provider
 *      subcategories.
 *   2. Category counts and membership are correct.
 *   3. Scroll movement does not rerun full-catalogue
 *      grouping/filtering (work-count assertions).
 *   8. A category with no subcategories remains fully navigable.
 *
 * The index under test is W1's real module
 * (src/scripts/lib/livetv-category-index.ts): groups hold nested
 * subcategories keyed by `sub:<slug-of-raw-name>` with the verbatim
 * provider string in `rawName`; counters are the module counters
 * `categoryIndexBuildCount()` / `derivedListRecomputeCount()`.
 * Membership assertions key on VERBATIM raw categoryId strings via
 * the parser-free oracles in ./fixtures.ts, so they hold however
 * W1 parses labels. Group slices are in subcategory first-seen
 * order with provider order inside each subcategory (W1's
 * contract) — membership is asserted exactly, order per
 * subcategory. Synthetic data only; nothing here plays a stream.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildCategoryIndex,
  categoryIndexBuildCount,
  derivedListRecomputeCount,
  getCategoryIndex,
  getDerivedChannels,
  resetCategoryIndexCache,
  resetCategoryIndexCounters,
  type CategoryIndex,
  type ProviderSubcategory,
} from "@/scripts/lib/livetv-category-index";
import {
  buildEnormousCategoryFixture,
  buildFlatCategoryFixture,
  channelsInRawCategory,
  distinctRawCategories,
  fixture200,
  fixture2000,
  fixture5000,
  fixture10000,
  rawCategoryCounts,
  sportsChannelsOracle,
} from "./fixtures";

beforeEach(() => {
  resetCategoryIndexCache();
  resetCategoryIndexCounters();
});

/** All subcategories across all groups, in index order. */
function allSubcategories(index: CategoryIndex): ProviderSubcategory[] {
  return index.groups.flatMap((g) => g.subcategories);
}

/** Slice helper: the window a scroll render reads (plain slice). */
function sliceDerivedWindow<T>(list: readonly T[], start: number, size: number): T[] {
  return list.slice(start, start + size);
}

describe("test 1 — Sports preserves its provider subcategories", () => {
  it("exposes every distinct Sports provider category as a subcategory", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    const sports = index.groups.find((g) => g.id === "sports");
    expect(sports).toBeDefined();
    const expectedRaws = distinctRawCategories(sportsChannelsOracle(channels));
    expect(sports!.subcategories.map((s) => s.rawName).sort()).toEqual([...expectedRaws].sort());
    // 30 distinct provider categories (3 regions × 10 subcategories).
    expect(sports!.subcategories).toHaveLength(30);
    // Ids are stable `sub:<slug>` spellings, one per raw category.
    expect(new Set(sports!.subcategories.map((s) => s.id)).size).toBe(30);
  });

  it("keeps same-label subcategories distinct (Football × 3 regions)", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    const football = allSubcategories(index).filter((s) => s.label === "Sports Football");
    expect(football.map((s) => s.rawName).sort()).toEqual([
      "IE | Sports | Football",
      "UK | Sports | Football",
      "US | Sports | Football",
    ]);
    // No merging: each holds only its own raw category's channels.
    for (const sub of football) {
      const expected = channelsInRawCategory(channels, sub.rawName).map((c) => String(c.id)).sort();
      expect(sub.channelIds.map(String).sort()).toEqual(expected);
      expect(sub.channelCount).toBe(40);
    }
  });

  it("selecting a Sports subcategory returns exactly that provider category", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    for (const raw of ["UK | Sports | F1", "US | Sports | NFL", "IE | Sports | Rugby"]) {
      const sub = allSubcategories(index).find((s) => s.rawName === raw)!;
      const derived = getDerivedChannels(index, { subcategoryId: sub.id });
      const expected = channelsInRawCategory(channels, raw);
      expect(derived.map((c) => c.id)).toEqual(expected.map((c) => c.id));
    }
  });

  it("selecting Sports returns all Sports channels, none lost or duplicated", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    const derived = getDerivedChannels(index, { groupId: "sports" });
    const expected = sportsChannelsOracle(channels);
    expect(derived).toHaveLength(expected.length);
    expect(new Set(derived.map((c) => String(c.id))).size).toBe(derived.length);
    expect(derived.map((c) => String(c.id)).sort()).toEqual(
      expected.map((c) => String(c.id)).sort(),
    );
  });

  it("preserves subcategories at 10,000 channels", () => {
    const channels = fixture10000();
    const index = buildCategoryIndex(channels, 1);
    const sports = index.groups.find((g) => g.id === "sports");
    expect(sports!.subcategories).toHaveLength(30);
    expect(sports!.channelCount).toBe(6000);
    const f1Sub = allSubcategories(index).find((s) => s.rawName === "UK | Sports | F1")!;
    const f1 = getDerivedChannels(index, { subcategoryId: f1Sub.id });
    expect(f1).toHaveLength(200);
  });
});

describe("test 2 — category counts and membership are correct", () => {
  it("counts match the raw-category oracle at every fixture size", () => {
    for (const channels of [fixture200(), fixture2000(), fixture5000(), fixture10000()]) {
      const index = buildCategoryIndex(channels, 1);
      expect([...index.byId.values()]).toHaveLength(channels.length);
      const oracle = rawCategoryCounts(channels);
      // Every raw category is exactly one subcategory, keyed by
      // its verbatim rawName, holding exactly its channels.
      const accounted = new Map<string, number>();
      for (const sub of allSubcategories(index)) {
        expect(accounted.has(sub.rawName)).toBe(false);
        accounted.set(sub.rawName, sub.channelCount);
      }
      expect(accounted).toEqual(oracle);
      // Group counts sum to the catalogue (each channel in exactly one group).
      expect(index.groups.reduce((sum, g) => sum + g.channelCount, 0)).toBe(channels.length);
    }
  });

  it("subcategory membership is exactly raw-category equality", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    for (const sub of allSubcategories(index)) {
      const derived = getDerivedChannels(index, { subcategoryId: sub.id });
      expect(derived.every((c) => c.categoryId === sub.rawName)).toBe(true);
      expect(derived).toHaveLength(channelsInRawCategory(channels, sub.rawName).length);
    }
  });

  it("group membership is a partition: no channel in two groups", () => {
    const channels = fixture5000();
    const index = buildCategoryIndex(channels, 1);
    const seen = new Map<string, string>();
    for (const group of index.groups) {
      const derived = getDerivedChannels(index, { groupId: group.id });
      expect(derived).toHaveLength(group.channelCount);
      for (const channel of derived) {
        const key = String(channel.id);
        expect(seen.has(key)).toBe(false);
        seen.set(key, group.id);
      }
    }
    expect(seen.size).toBe(channels.length);
  });

  it("unknown groups / subcategories yield empty lists, never the whole catalogue", () => {
    const index = buildCategoryIndex(fixture200(), 1);
    expect(getDerivedChannels(index, { groupId: "no-such-group" })).toEqual([]);
    expect(getDerivedChannels(index, { subcategoryId: "sub:nope" })).toEqual([]);
  });

  it("derived lists preserve provider order: whole catalogue, and within each subcategory", () => {
    const channels = fixture2000();
    const index = buildCategoryIndex(channels, 1);
    const all = getDerivedChannels(index, {});
    expect(all.map((c) => c.id)).toEqual(channels.map((c) => c.id));
    // Group slice: subcategories in first-seen order, channels in
    // provider (catalogue) order inside each subcategory.
    const sports = index.groups.find((g) => g.id === "sports")!;
    const expectedOrder = sports.subcategories.flatMap((sub) =>
      channelsInRawCategory(channels, sub.rawName).map((c) => c.id),
    );
    const derived = getDerivedChannels(index, { groupId: "sports" });
    expect(derived.map((c) => c.id)).toEqual(expectedOrder);
    // Membership is still exactly the Sports oracle.
    expect(derived.map((c) => String(c.id)).sort()).toEqual(
      sportsChannelsOracle(channels).map((c) => String(c.id)).sort(),
    );
  });

  it("A-Z / Z-A sorts order the derived list without changing membership", () => {
    const channels = fixture200();
    const index = buildCategoryIndex(channels, 1);
    const base = getDerivedChannels(index, { groupId: "sports" });
    const az = getDerivedChannels(index, { groupId: "sports", sort: "az" });
    const za = getDerivedChannels(index, { groupId: "sports", sort: "za" });
    expect(az.map((c) => String(c.id)).sort()).toEqual(base.map((c) => String(c.id)).sort());
    expect(za.map((c) => String(c.id)).sort()).toEqual(base.map((c) => String(c.id)).sort());
    const names = az.map((c) => c.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    expect(za.map((c) => c.displayName)).toEqual([...names].reverse());
  });
});

describe("test 3 — scroll does not rerun grouping/filtering", () => {
  it("repeated getCategoryIndex calls reuse the cached index (same revision)", () => {
    const channels = fixture2000();
    const first = getCategoryIndex(channels, 1);
    const buildsAfterFirst = categoryIndexBuildCount();
    expect(buildsAfterFirst).toBe(1);
    for (let i = 0; i < 50; i++) {
      expect(getCategoryIndex(channels, 1)).toBe(first);
    }
    expect(categoryIndexBuildCount()).toBe(buildsAfterFirst);
    expect(first.buildCount).toBe(1);
  });

  it("a new revision rebuilds exactly once", () => {
    const channels = fixture2000();
    const first = getCategoryIndex(channels, 1);
    const second = getCategoryIndex(channels, 2);
    expect(second).not.toBe(first);
    expect(categoryIndexBuildCount()).toBe(2);
    expect(second.buildCount).toBe(2);
    expect(getCategoryIndex(channels, 2)).toBe(second);
    expect(categoryIndexBuildCount()).toBe(2);
  });

  it("scrolling a derived list never recomputes it", () => {
    const channels = fixture10000();
    const index = getCategoryIndex(channels, 1);
    const derived = getDerivedChannels(index, { groupId: "sports" });
    const recomputes = derivedListRecomputeCount();
    expect(recomputes).toBe(1);
    // Simulate 200 scroll steps: re-request the same derived list
    // and slice a new window each time, as a scroll render does.
    for (let step = 0; step < 200; step++) {
      const again = getDerivedChannels(index, { groupId: "sports" });
      expect(again).toBe(derived);
      const window = sliceDerivedWindow(again, step * 7, 14);
      expect(window.length).toBeLessThanOrEqual(14);
    }
    expect(derivedListRecomputeCount()).toBe(recomputes);
    expect(categoryIndexBuildCount()).toBe(1);
  });

  it("only a genuinely new option set recomputes", () => {
    const index = buildCategoryIndex(fixture2000(), 1);
    getDerivedChannels(index, { groupId: "sports" });
    expect(derivedListRecomputeCount()).toBe(1);
    getDerivedChannels(index, { groupId: "sports" });
    getDerivedChannels(index, { groupId: "sports" });
    expect(derivedListRecomputeCount()).toBe(1);
    getDerivedChannels(index, { groupId: "news" });
    expect(derivedListRecomputeCount()).toBe(2);
    getDerivedChannels(index, { groupId: "sports", sort: "az" });
    expect(derivedListRecomputeCount()).toBe(3);
    getDerivedChannels(index, { groupId: "sports", sort: "az" });
    expect(derivedListRecomputeCount()).toBe(3);
  });

  it("category switching recomputes once per new category, not per scroll", () => {
    const channels = fixture5000();
    const index = getCategoryIndex(channels, 1);
    const categories: Array<{ groupId: string }> = [
      { groupId: "sports" },
      { groupId: "news" },
      { groupId: "movies" },
    ];
    for (const opts of categories) {
      const before = derivedListRecomputeCount();
      getDerivedChannels(index, opts);
      expect(derivedListRecomputeCount()).toBe(before + 1);
      // 50 scroll steps inside the new category: no recompute.
      for (let step = 0; step < 50; step++) {
        getDerivedChannels(index, opts);
      }
      expect(derivedListRecomputeCount()).toBe(before + 1);
    }
    expect(categoryIndexBuildCount()).toBe(1);
  });
});

describe("test 8 — a category with no subcategories stays navigable", () => {
  it("the enormous single category is one group holding all channels", () => {
    const channels = buildEnormousCategoryFixture(3000);
    const index = buildCategoryIndex(channels, 1);
    expect(index.groups).toHaveLength(1);
    const group = index.groups[0]!;
    // One raw provider category → one subcategory carrying the
    // verbatim raw name; the group itself is the flat list.
    expect(group.subcategories).toHaveLength(1);
    expect(group.subcategories[0]!.rawName).toBe("UK | International");
    expect(group.channelCount).toBe(3000);
    expect(group.subcategories[0]!.channelCount).toBe(3000);
  });

  it("the enormous category's derived list is complete and ordered", () => {
    const channels = buildEnormousCategoryFixture(3000);
    const index = buildCategoryIndex(channels, 1);
    const group = index.groups[0]!;
    const derived = getDerivedChannels(index, { groupId: group.id });
    expect(derived.map((c) => c.id)).toEqual(channels.map((c) => c.id));
    // Every channel is reachable by windowed scrolling.
    const seen = new Set<string>();
    for (let start = 0; start < derived.length; start += 14) {
      for (const channel of sliceDerivedWindow(derived, start, 14)) {
        seen.add(String(channel.id));
      }
    }
    expect(seen.size).toBe(3000);
  });

  it("bare single-segment categories navigate as flat groups", () => {
    const channels = buildFlatCategoryFixture();
    const index = buildCategoryIndex(channels, 1);
    expect(index.groups.map((g) => g.id).sort()).toEqual(["movies", "news", "sports"]);
    // Each bare category is one group with one subcategory.
    for (const group of index.groups) {
      expect(group.subcategories).toHaveLength(1);
    }
    for (const raw of ["Sports", "News", "Movies"]) {
      const group = index.groups.find((g) => g.label === raw)!;
      const derived = getDerivedChannels(index, { groupId: group.id });
      expect(derived).toHaveLength(12);
      expect(derived.every((c) => c.categoryId === raw)).toBe(true);
    }
  });

  it("search and sort still work inside a flat category", () => {
    const channels = buildEnormousCategoryFixture(3000);
    const index = buildCategoryIndex(channels, 1);
    const group = index.groups[0]!;
    const searched = getDerivedChannels(index, { groupId: group.id, search: "World TV" });
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.every((c) => c.displayName.includes("World TV"))).toBe(true);
    const sorted = getDerivedChannels(index, { groupId: group.id, sort: "az" });
    expect(sorted).toHaveLength(3000);
    const names = sorted.map((c) => c.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});
