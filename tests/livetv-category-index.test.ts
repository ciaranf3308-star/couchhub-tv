import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCategoryIndex,
  categoryIndexBuildCount,
  createGenerationGuard,
  derivedListRecomputeCount,
  getCategoryIndex,
  getDerivedChannels,
  getVisibleIndex,
  groupForRawCategory,
  invalidateDerivedChannels,
  normaliseCategoryLabel,
  resetCategoryIndexCache,
  resetCategoryIndexCounters,
} from "@/scripts/lib/livetv-category-index";
import type { LivetvChannel } from "@/scripts/lib/livetv-data";

function ch(
  partial: Partial<LivetvChannel> & { id: string | number; name: string },
): LivetvChannel {
  const rawCategory = partial.categoryId ?? partial.category ?? "";
  return {
    displayName: partial.name,
    logo: null,
    category: rawCategory,
    categoryId: rawCategory,
    categoryLabel:
      partial.categoryLabel ?? normaliseCategoryLabel(rawCategory),
    streamUrl: null,
    tvgId: null,
    chno: undefined,
    catchup: false,
    favourite: false,
    hidden: false,
    norm: (partial.name + " " + rawCategory).toLowerCase(),
    ...partial,
  };
}

beforeEach(() => {
  resetCategoryIndexCache();
  resetCategoryIndexCounters();
});

describe("grouping preservation", () => {
  it("keeps every distinct raw provider category as its own subcategory of one group", () => {
    const channels = [
      ch({ id: 1, name: "A", categoryId: "UK | Sports" }),
      ch({ id: 2, name: "B", categoryId: "Sports FHD" }),
      ch({ id: 3, name: "C", categoryId: "Sports Football" }),
      ch({ id: 4, name: "D", categoryId: "UK | Sports" }),
    ];
    const index = buildCategoryIndex(channels, 1);
    expect(index.groups.map((g) => g.id)).toEqual(["sports"]);
    const sports = index.groups[0];
    expect(sports.rawNames).toEqual(["UK | Sports", "Sports FHD", "Sports Football"]);
    expect(sports.subcategories.map((s) => s.rawName)).toEqual([
      "UK | Sports",
      "Sports FHD",
      "Sports Football",
    ]);
    expect(sports.subcategories.map((s) => s.channelIds)).toEqual([
      ["1", "4"],
      ["2"],
      ["3"],
    ]);
    // Labels are normalised; raw identity is preserved verbatim.
    expect(sports.subcategories.map((s) => s.label)).toEqual([
      "Sports",
      "Sports",
      "Sports Football",
    ]);
    expect(sports.channelCount).toBe(4);
  });

  it("loses or duplicates no channel across ordinary provider categories", () => {
    const channels = [
      ch({ id: 1, name: "A", categoryId: "Sports" }),
      ch({ id: 2, name: "B", categoryId: "News" }),
      ch({ id: 3, name: "C", categoryId: "Zebra Corner" }),
      ch({ id: 4, name: "D", categoryId: "Sports" }),
      ch({ id: 5, name: "E", categoryId: "UK" }),
    ];
    const index = buildCategoryIndex(channels, 1);
    const seen = index.groups.flatMap((g) =>
      g.subcategories.flatMap((s) => s.channelIds),
    );
    expect(seen.sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(index.groups.reduce((n, g) => n + g.channelCount, 0)).toBe(5);
    expect(index.byId.size).toBe(5);
    expect(index.byId.get("3")?.name).toBe("C");
  });

  it("groups by genre first, region buckets second, provider fallback last", () => {
    expect(groupForRawCategory("UK | Sports")).toEqual({ id: "sports", label: "Sports" });
    expect(groupForRawCategory("UK")).toEqual({ id: "irish-uk", label: "Irish & UK" });
    expect(groupForRawCategory("Ireland")).toEqual({ id: "irish-uk", label: "Irish & UK" });
    expect(groupForRawCategory("Movies FHD")).toEqual({ id: "movies", label: "Movies" });
    expect(groupForRawCategory("Zebra Corner")).toEqual({
      id: "provider:zebra-corner",
      label: "Zebra Corner",
    });
    expect(groupForRawCategory("Some Provider Bucket")).toEqual({
      id: "provider:some-provider-bucket",
      label: "Some Provider Bucket",
    });
  });

  it("orders groups: Irish & UK, genres, provider groups, uncategorised last", () => {
    const channels = [
      ch({ id: 1, name: "A", categoryId: "Zebra Corner" }),
      ch({ id: 2, name: "B", categoryId: "Sports" }),
      ch({ id: 3, name: "C", categoryId: "UK" }),
      ch({ id: 4, name: "D", categoryId: "" }),
      ch({ id: 5, name: "E", categoryId: "News" }),
    ];
    const index = buildCategoryIndex(channels, 1);
    expect(index.groups.map((g) => g.id)).toEqual([
      "irish-uk",
      "sports",
      "news",
      "provider:zebra-corner",
      "uncategorised",
    ]);
  });

  it("groups from the raw category, not a stale display label", () => {
    // A channel whose categoryLabel was never normalised still
    // groups by its raw identity.
    const channels = [
      ch({ id: 1, name: "A", categoryId: "Movies FHD", categoryLabel: "Movies FHD" }),
    ];
    const index = buildCategoryIndex(channels, 1);
    expect(index.groups.map((g) => g.id)).toEqual(["movies"]);
    expect(index.groups[0].subcategories[0].label).toBe("Movies");
  });

  it("disambiguates subcategory ids when distinct raw names slug-collide", () => {
    const channels = [
      ch({ id: 1, name: "A", categoryId: "Sports!" }),
      ch({ id: 2, name: "B", categoryId: "Sports" }),
      ch({ id: 3, name: "C", categoryId: "Sports?" }),
    ];
    const index = buildCategoryIndex(channels, 1);
    const ids = index.groups[0].subcategories.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("sub:sports");
    expect(ids).toContain("sub:sports-2");
    // No real category ever takes the reserved uncategorised id.
    expect(ids).not.toContain("sub:uncategorised");
  });

  it("never invents subcategories: one enormous provider category stays one subcategory", () => {
    const channels = Array.from({ length: 2000 }, (_, i) =>
      ch({ id: i + 1, name: `Sport ${i + 1}`, categoryId: "Sports" }),
    );
    const index = buildCategoryIndex(channels, 1);
    expect(index.groups).toHaveLength(1);
    expect(index.groups[0].subcategories).toHaveLength(1);
    expect(index.groups[0].subcategories[0].channelCount).toBe(2000);
    expect(index.groups[0].channelCount).toBe(2000);
    expect(getDerivedChannels(index, { groupId: "sports" })).toHaveLength(2000);
  });

  it("handles hundreds of raw category names", () => {
    const channels = Array.from({ length: 300 }, (_, i) =>
      ch({ id: i + 1, name: `Ch ${i + 1}`, categoryId: `Bucket ${i + 1}` }),
    );
    const index = buildCategoryIndex(channels, 1);
    const subs = index.groups.flatMap((g) => g.subcategories);
    expect(subs).toHaveLength(300);
    expect(index.groups.reduce((n, g) => n + g.channelCount, 0)).toBe(300);
  });
});

describe("uncategorised handling", () => {
  it("keeps uncategorised channels reachable via index.uncategorised and the trailing group", () => {
    const channels = [
      ch({ id: 1, name: "A", categoryId: "Sports" }),
      ch({ id: 2, name: "B", categoryId: "" }),
      ch({ id: 3, name: "C", categoryId: "   " }),
    ];
    const index = buildCategoryIndex(channels, 1);
    expect(index.uncategorised.channelIds).toEqual(["2", "3"]);
    expect(index.uncategorised.channelCount).toBe(2);
    const last = index.groups[index.groups.length - 1];
    expect(last.id).toBe("uncategorised");
    expect(last.subcategories[0]).toBe(index.uncategorised);
    expect(getDerivedChannels(index, { groupId: "uncategorised" }).map((c) => c.id)).toEqual([2, 3]);
    // No selection includes uncategorised channels in provider order.
    expect(getDerivedChannels(index).map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("presents an empty uncategorised subcategory when every channel is categorised", () => {
    const index = buildCategoryIndex([ch({ id: 1, name: "A", categoryId: "News" })], 1);
    expect(index.uncategorised.channelIds).toEqual([]);
    expect(index.groups.map((g) => g.id)).toEqual(["news"]);
  });

  it("handles an empty catalogue", () => {
    const index = buildCategoryIndex([], 1);
    expect(index.groups).toEqual([]);
    expect(index.uncategorised.channelIds).toEqual([]);
    expect(index.byId.size).toBe(0);
    expect(getDerivedChannels(index)).toEqual([]);
  });
});

describe("index caching", () => {
  it("getCategoryIndex reuses the cached index while the revision is unchanged", () => {
    const channels = [ch({ id: 1, name: "A", categoryId: "Sports" })];
    const first = getCategoryIndex(channels, "rev-1");
    const second = getCategoryIndex(channels, "rev-1");
    expect(second).toBe(first);
    expect(categoryIndexBuildCount()).toBe(1);
    expect(first.buildCount).toBe(1);
    // Repeated calls — the scroll / focus path — never rebuild.
    for (let i = 0; i < 10; i++) getCategoryIndex(channels, "rev-1");
    expect(categoryIndexBuildCount()).toBe(1);
  });

  it("getCategoryIndex rebuilds only when the revision changes", () => {
    const channels = [ch({ id: 1, name: "A", categoryId: "Sports" })];
    const first = getCategoryIndex(channels, 1);
    const second = getCategoryIndex(channels, 2);
    expect(second).not.toBe(first);
    expect(categoryIndexBuildCount()).toBe(2);
    expect(second.buildCount).toBe(2);
    expect(second.revision).toBe(2);
  });

  it("buildCategoryIndex always builds and stamps the cumulative count", () => {
    const channels = [ch({ id: 1, name: "A", categoryId: "Sports" })];
    const a = buildCategoryIndex(channels, 1);
    const b = buildCategoryIndex(channels, 1);
    expect(a).not.toBe(b);
    expect(categoryIndexBuildCount()).toBe(2);
    expect(b.buildCount).toBe(2);
  });

  it("resetCategoryIndexCache drops the cached index", () => {
    const channels = [ch({ id: 1, name: "A", categoryId: "Sports" })];
    const first = getCategoryIndex(channels, 1);
    resetCategoryIndexCache();
    expect(getCategoryIndex(channels, 1)).not.toBe(first);
    expect(categoryIndexBuildCount()).toBe(2);
  });
});

describe("derived lists", () => {
  const channels = [
    ch({ id: 1, name: "Zebra News", categoryId: "News" }),
    ch({ id: 2, name: "Alpha Sports", categoryId: "Sports", favourite: true }),
    ch({ id: 3, name: "Mid Movies", categoryId: "Movies" }),
    ch({ id: 4, name: "Beta Sports", categoryId: "Sports", favourite: true }),
    ch({ id: 5, name: "Sky Sports F1", categoryId: "UK | Sports", chno: 402 }),
  ];

  it("memoises: repeated identical selections return the same array without recomputing", () => {
    const index = buildCategoryIndex(channels, 1);
    const first = getDerivedChannels(index, { groupId: "sports" });
    expect(derivedListRecomputeCount()).toBe(1);
    for (let i = 0; i < 10; i++) {
      expect(getDerivedChannels(index, { groupId: "sports" })).toBe(first);
    }
    expect(derivedListRecomputeCount()).toBe(1);
    expect(categoryIndexBuildCount()).toBe(1);
  });

  it("recomputes when the selection changes", () => {
    const index = buildCategoryIndex(channels, 1);
    getDerivedChannels(index, { groupId: "sports" });
    getDerivedChannels(index, { groupId: "news" });
    getDerivedChannels(index, { groupId: "sports", sort: "az" });
    getDerivedChannels(index, { groupId: "sports", search: "beta" });
    expect(derivedListRecomputeCount()).toBe(4);
  });

  it("selects a group in subcategory order, preserving provider order inside each subcategory", () => {
    const index = buildCategoryIndex(channels, 1);
    expect(getDerivedChannels(index, { groupId: "sports" }).map((c) => c.id)).toEqual([2, 4, 5]);
    expect(getDerivedChannels(index, { groupId: "news" }).map((c) => c.id)).toEqual([1]);
    expect(getDerivedChannels(index, { groupId: "no-such-group" })).toEqual([]);
  });

  it("selects a single subcategory by id", () => {
    const index = buildCategoryIndex(channels, 1);
    const ukSports = index.groups[0].subcategories.find((s) => s.rawName === "UK | Sports")!;
    expect(getDerivedChannels(index, { subcategoryId: ukSports.id }).map((c) => c.id)).toEqual([5]);
    // A subcategory id paired with another group yields nothing.
    expect(
      getDerivedChannels(index, { groupId: "news", subcategoryId: ukSports.id }),
    ).toEqual([]);
    expect(
      getDerivedChannels(index, { groupId: "sports", subcategoryId: ukSports.id }).map((c) => c.id),
    ).toEqual([5]);
  });

  it("searches within the selected category by default", () => {
    const index = buildCategoryIndex(channels, 1);
    expect(
      getDerivedChannels(index, { groupId: "sports", search: "beta" }).map((c) => c.id),
    ).toEqual([4]);
    expect(
      getDerivedChannels(index, { groupId: "sports", search: "news" }).map((c) => c.id),
    ).toEqual([]);
  });

  it("searchScope 'all' searches the whole catalogue, ignoring the category selection", () => {
    const index = buildCategoryIndex(channels, 1);
    expect(
      getDerivedChannels(index, {
        groupId: "sports",
        search: "news",
        searchScope: "all",
      }).map((c) => c.id),
    ).toEqual([1]);
  });

  it("matches every search token and numeric channel numbers", () => {
    const index = buildCategoryIndex(channels, 1);
    expect(getDerivedChannels(index, { search: "sky sports" }).map((c) => c.id)).toEqual([5]);
    expect(getDerivedChannels(index, { search: "402" }).map((c) => c.id)).toEqual([5]);
    expect(getDerivedChannels(index, { search: "sky movies" })).toEqual([]);
  });

  it("filters favourites only, within the selection", () => {
    const index = buildCategoryIndex(channels, 1);
    expect(getDerivedChannels(index, { favouritesOnly: true }).map((c) => c.id)).toEqual([2, 4]);
    expect(
      getDerivedChannels(index, { groupId: "sports", favouritesOnly: true }).map((c) => c.id),
    ).toEqual([2, 4]);
    expect(
      getDerivedChannels(index, { groupId: "news", favouritesOnly: true }),
    ).toEqual([]);
  });

  it("sorts provider / az / za / category", () => {
    const index = buildCategoryIndex(channels, 1);
    expect(getDerivedChannels(index, {}).map((c) => c.id)).toEqual([1, 2, 3, 4, 5]);
    expect(getDerivedChannels(index, { sort: "az" }).map((c) => c.id)).toEqual([2, 4, 3, 5, 1]);
    expect(getDerivedChannels(index, { sort: "za" }).map((c) => c.id)).toEqual([1, 5, 3, 4, 2]);
    expect(getDerivedChannels(index, { sort: "category" }).map((c) => c.id)).toEqual([
      3, 1, 2, 4, 5,
    ]);
  });

  it("invalidateDerivedChannels drops memoised lists", () => {
    const index = buildCategoryIndex(channels, 1);
    const first = getDerivedChannels(index, { groupId: "sports" });
    invalidateDerivedChannels(index);
    const second = getDerivedChannels(index, { groupId: "sports" });
    expect(second).not.toBe(first);
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
    expect(derivedListRecomputeCount()).toBe(2);
  });
});

describe("visible index", () => {
  it("maps channel id to position and caches per list identity", () => {
    const index = buildCategoryIndex(
      [ch({ id: 1, name: "A", categoryId: "News" }), ch({ id: 2, name: "B", categoryId: "News" })],
      1,
    );
    const list = getDerivedChannels(index, { groupId: "news" });
    const visible = getVisibleIndex(list);
    expect(visible.get("1")).toBe(0);
    expect(visible.get("2")).toBe(1);
    expect(getVisibleIndex(list)).toBe(visible);
  });
});

describe("generation guards", () => {
  it("marks older generations stale when a newer one starts", () => {
    const guard = createGenerationGuard();
    const first = guard.next();
    expect(guard.isCurrent(first)).toBe(true);
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    expect(guard.generation).toBe(second);
  });

  it("cancel() invalidates all outstanding generations", () => {
    const guard = createGenerationGuard();
    const gen = guard.next();
    guard.cancel();
    expect(guard.isCurrent(gen)).toBe(false);
  });
});
