/**
 * @vitest-environment jsdom
 *
 * W7 — Live TV Home fixes: true-duplicate collapse, distinct
 * same-name labelling, hero fallback with no history / no EPG,
 * collection "now playing" from real EPG only, and the stale
 * playlist-selection fallback.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  collectionNowPlaying,
  dedupeLivetvChannels,
  disambiguateLivetvDisplayNames,
  loadLivetvHomeData,
  mapLivetvChannels,
  normaliseChannelName,
  pickResumeHero,
  readActivePlaylistId,
  type LivetvChannel,
  type LivetvGroup,
  type LivetvRawChannel,
} from "@/scripts/lib/livetv-data";
import { invalidateEntry, setCached } from "@/scripts/lib/cache.js";
import type { Programme } from "@/scripts/lib/now-next";

const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const HOUR = 3_600_000;

function ch(partial: Partial<LivetvChannel> & { id: string | number; name: string }): LivetvChannel {
  const rawCategory = partial.categoryId ?? partial.category ?? "";
  return {
    displayName: partial.name,
    logo: null,
    category: rawCategory,
    categoryId: rawCategory,
    categoryLabel: partial.categoryLabel ?? rawCategory,
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

function programmesFor(entries: Array<[string, Array<{ start: number; stop: number; title: string }>]>) {
  const map = new Map<string, Programme[]>();
  for (const [tvgId, list] of entries) {
    map.set(tvgId.toLowerCase(), list.map((p) => ({ ...p })));
  }
  return map;
}

describe("normaliseChannelName", () => {
  it("strips trailing quality tags (provider mirrors of one broadcast)", () => {
    expect(normaliseChannelName("BBC One FHD")).toBe("bbc one");
    expect(normaliseChannelName("BBC One HD")).toBe("bbc one");
    expect(normaliseChannelName("Sky Cinema 4K")).toBe("sky cinema");
    expect(normaliseChannelName("AFN Sports 1080p")).toBe("afn sports");
  });

  it("keeps region words: a regional feed is a distinct channel", () => {
    expect(normaliseChannelName("BBC One Scotland")).toBe("bbc one scotland");
    expect(normaliseChannelName("BBC One London")).toBe("bbc one london");
  });

  it("keeps real title words that merely contain a quality token", () => {
    expect(normaliseChannelName("Sky Cinema Premiere")).toBe("sky cinema premiere");
    expect(normaliseChannelName("HDNet Movies")).toBe("hdnet movies");
  });
});

describe("dedupeLivetvChannels", () => {
  it("collapses the same provider id to one tile", () => {
    const out = dedupeLivetvChannels([
      ch({ id: 101, name: "BBC One", tvgId: "bbc.one", logo: "https://x/bbc.png" }),
      ch({ id: 101, name: "BBC One", tvgId: "bbc.one", logo: "https://x/bbc.png" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(101);
    expect(out[0].duplicateIds).toEqual([101]);
  });

  it("collapses rows sharing one direct stream URL (M3U duplicates)", () => {
    const out = dedupeLivetvChannels([
      ch({ id: "a", name: "AFN Sports", streamUrl: "https://x/afn.m3u8" }),
      ch({ id: "b", name: "AFN Sports", streamUrl: "https://x/afn.m3u8" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a");
    expect(out[0].duplicateIds).toEqual(["b"]);
  });

  it("collapses quality mirrors: BBC One / BBC One FHD / BBC One HD, one tvg-id, one tile", () => {
    const out = dedupeLivetvChannels([
      ch({ id: 1, name: "BBC One", tvgId: "bbc.one", logo: "https://x/bbc.png" }),
      ch({ id: 2, name: "BBC One FHD", tvgId: "bbc.one", logo: "https://x/bbc.png" }),
      ch({ id: 3, name: "BBC One HD", tvgId: "bbc.one", logo: "https://x/bbc.png" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].duplicateIds).toEqual([2, 3]);
  });

  it("keeps the first row and adopts a logo the first row lacked", () => {
    const out = dedupeLivetvChannels([
      ch({ id: 1, name: "BBC One", tvgId: "bbc.one", logo: null }),
      ch({ id: 2, name: "BBC One FHD", tvgId: "bbc.one", logo: "https://x/bbc.png" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].logo).toBe("https://x/bbc.png");
  });

  it("never drops a visible copy for a hidden one, and ORs favourites", () => {
    const out = dedupeLivetvChannels([
      ch({ id: 1, name: "BBC One", tvgId: "bbc.one", hidden: true }),
      ch({ id: 2, name: "BBC One", tvgId: "bbc.one", hidden: false, favourite: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].hidden).toBe(false);
    expect(out[0].favourite).toBe(true);
  });

  it("does NOT merge same name + same tvg-id when the logos differ", () => {
    const out = dedupeLivetvChannels([
      ch({ id: 1, name: "AFN Sports", tvgId: "afn.sports", logo: "https://x/a.png" }),
      ch({ id: 2, name: "AFN Sports", tvgId: "afn.sports", logo: "https://x/b.png" }),
    ]);
    expect(out.map((c) => c.id)).toEqual([1, 2]);
  });

  it("does NOT merge on a similar name alone", () => {
    const out = dedupeLivetvChannels([
      ch({ id: 1, name: "Sky Cinema Premiere", tvgId: "sky.premiere" }),
      ch({ id: 2, name: "Sky Cinema Action", tvgId: "sky.action" }),
      ch({ id: 3, name: "Sky Cinema", tvgId: "sky.cinema" }),
    ]);
    expect(out).toHaveLength(3);
  });

  it("preserves source order", () => {
    const out = dedupeLivetvChannels([
      ch({ id: 1, name: "RTÉ One", tvgId: "rte.one" }),
      ch({ id: 2, name: "RTÉ One FHD", tvgId: "rte.one" }),
      ch({ id: 3, name: "BBC Two", tvgId: "bbc.two" }),
    ]);
    expect(out.map((c) => c.id)).toEqual([1, 3]);
  });
});

describe("disambiguateLivetvDisplayNames", () => {
  it("labels distinct same-name channels by provider group", () => {
    const out = disambiguateLivetvDisplayNames([
      ch({ id: 1, name: "AFN Sports", categoryId: "UK | Sports", categoryLabel: "Sports" }),
      ch({ id: 2, name: "AFN Sports", categoryId: "UK | Movies", categoryLabel: "Movies" }),
    ]);
    expect(out.map((c) => c.displayName)).toEqual([
      "AFN Sports — Sports",
      "AFN Sports — Movies",
    ]);
    // The raw name is never rewritten.
    expect(out.map((c) => c.name)).toEqual(["AFN Sports", "AFN Sports"]);
  });

  it("falls back to channel number, then tvg-id, when groups match", () => {
    const byChno = disambiguateLivetvDisplayNames([
      ch({ id: 1, name: "BBC One", categoryId: "Sports", categoryLabel: "Sports", chno: 101 }),
      ch({ id: 2, name: "BBC One", categoryId: "Sports", categoryLabel: "Sports", chno: 102 }),
    ]);
    expect(byChno.map((c) => c.displayName)).toEqual([
      "BBC One — CH 101",
      "BBC One — CH 102",
    ]);
    const byTvg = disambiguateLivetvDisplayNames([
      ch({ id: 1, name: "BBC One", categoryId: "Sports", categoryLabel: "Sports", tvgId: "bbc.one.a" }),
      ch({ id: 2, name: "BBC One", categoryId: "Sports", categoryLabel: "Sports", tvgId: "bbc.one.b" }),
    ]);
    expect(byTvg.map((c) => c.displayName)).toEqual([
      "BBC One — bbc.one.a",
      "BBC One — bbc.one.b",
    ]);
  });

  it("leaves unique names untouched", () => {
    const out = disambiguateLivetvDisplayNames([
      ch({ id: 1, name: "RTÉ One" }),
      ch({ id: 2, name: "BBC Two" }),
    ]);
    expect(out.map((c) => c.displayName)).toEqual(["RTÉ One", "BBC Two"]);
  });
});

describe("mapLivetvChannels (dedupe + disambiguation end to end)", () => {
  it("reproduces the user's case: BBC One x2, AFN Sports x2, Sky Cinema x3 collapse to one tile each", () => {
    const rows: LivetvRawChannel[] = [
      { id: 1, name: "BBC One", category: "UK | Entertainment", tvgId: "bbc.one", logo: "https://x/bbc.png" },
      { id: 2, name: "BBC One FHD", category: "UK | Entertainment", tvgId: "bbc.one", logo: "https://x/bbc.png" },
      { id: 3, name: "AFN Sports", category: "UK | Sports", tvgId: "afn.sports", logo: "https://x/afn.png" },
      { id: 4, name: "AFN Sports HD", category: "UK | Sports", tvgId: "afn.sports", logo: "https://x/afn.png" },
      { id: 5, name: "Sky Cinema", category: "Movies", tvgId: "sky.cinema", logo: "https://x/sky.png" },
      { id: 6, name: "Sky Cinema HD", category: "Movies", tvgId: "sky.cinema", logo: "https://x/sky.png" },
      { id: 7, name: "Sky Cinema FHD", category: "Movies", tvgId: "sky.cinema", logo: "https://x/sky.png" },
      { id: 8, name: "RTÉ One", category: "UK", tvgId: "rte.one", logo: "https://x/rte.png" },
    ];
    const out = mapLivetvChannels(rows);
    expect(out.map((c) => c.displayName)).toEqual([
      "BBC One",
      "AFN Sports",
      "Sky Cinema",
      "RTÉ One",
    ]);
    expect(out[0].duplicateIds).toEqual([2]);
    expect(out[2].duplicateIds).toEqual([6, 7]);
  });

  it("keeps genuinely distinct same-name channels and labels them", () => {
    const rows: LivetvRawChannel[] = [
      { id: 1, name: "BBC One", category: "UK | Entertainment", tvgId: "bbc.one.london", logo: "https://x/bbc.png" },
      { id: 2, name: "BBC One", category: "UK | Sports", tvgId: "bbc.one.scotland", logo: "https://x/bbc.png" },
    ];
    const out = mapLivetvChannels(rows);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.displayName)).toEqual([
      "BBC One — Entertainment",
      "BBC One — Sports",
    ]);
  });
});

describe("pickResumeHero featured fallback (W7)", () => {
  it("renders a hero with no history, no favourites and no EPG", () => {
    const channels = [
      ch({ id: 1, name: "Sky Sports", tvgId: "sky.sports" }),
      ch({ id: 2, name: "RTÉ One", tvgId: "rte.one", categoryId: "UK", logo: "https://x/rte.png" }),
    ];
    // No EPG at all (null and empty Map alike).
    for (const programmes of [null, new Map()]) {
      const pick = pickResumeHero(channels, [], programmes as never, "", NOW);
      expect(pick?.eyebrow).toBe("Featured Channel");
      // Local channel with a logo wins over the catalogue order.
      expect(pick?.channel.id).toBe(2);
    }
  });

  it("falls back to any logo channel, then the first channel, when nothing is local", () => {
    const withLogo = [
      ch({ id: 1, name: "A", categoryId: "Movies" }),
      ch({ id: 2, name: "B", categoryId: "Movies", logo: "https://x/b.png" }),
    ];
    expect(pickResumeHero(withLogo, [], new Map(), "", NOW)?.channel.id).toBe(2);
    const noLogos = [ch({ id: 1, name: "A" }), ch({ id: 2, name: "B" })];
    expect(pickResumeHero(noLogos, [], new Map(), "", NOW)?.channel.id).toBe(1);
  });

  it("still returns null only when there are no channels", () => {
    expect(pickResumeHero([], [], new Map(), "", NOW)).toBeNull();
  });

  it("still prefers history and favourites over the featured fallback", () => {
    const programmes = programmesFor([
      ["rte.one", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "Evening News" }]],
    ]);
    const channels = [
      ch({ id: 1, name: "RTÉ One", tvgId: "rte.one", categoryId: "UK", favourite: true }),
      ch({ id: 2, name: "Sky Sports", tvgId: "sky.sports" }),
    ];
    expect(pickResumeHero(channels, [], programmes, "", NOW)?.eyebrow).toBe("Favourite Channel");
    expect(
      pickResumeHero(channels, [{ id: 2, name: "Sky Sports", logo: null, ts: 1 }], programmes, "", NOW)?.eyebrow,
    ).toBe("Resume Watching");
  });
});

describe("collectionNowPlaying", () => {
  const group: LivetvGroup = {
    id: "sports",
    label: "Sports",
    channels: [
      ch({ id: 1, name: "Sky Sports", tvgId: "sky.sports" }),
      ch({ id: 2, name: "No Guide", tvgId: "no.guide" }),
    ],
  };

  it("returns null with no EPG — never invents a programme", () => {
    expect(collectionNowPlaying(group, null)).toBeNull();
    expect(collectionNowPlaying(group, new Map())).toBeNull();
  });

  it("returns the first real live programme in the group", () => {
    const programmes = programmesFor([
      ["sky.sports", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "Match Live" }]],
    ]);
    expect(collectionNowPlaying(group, programmes, "", NOW)).toEqual({
      channelName: "Sky Sports",
      programmeTitle: "Match Live",
    });
  });
});

describe("loadLivetvHomeData (W7 cold-load hydration)", () => {
  afterEach(() => {
    invalidateEntry("demo-w7");
    invalidateEntry("demo-no-cache");
  });

  it("returns an empty Home (not a throw) with no cache and no IndexedDB", async () => {
    const data = await loadLivetvHomeData("demo-no-cache");
    expect(data.playlistId).toBe("demo-no-cache");
    expect(data.channels).toEqual([]);
    expect(data.recents).toEqual([]);
    expect(data.programmes).toBeNull();
    expect(data.hasEpg).toBe(false);
  });

  it("reads the hydrated in-memory cache, through dedupe", async () => {
    setCached(
      "demo-w7",
      "live",
      [
        { id: 1, name: "BBC One", category: "UK | Entertainment", tvgId: "bbc.one", logo: "https://x/bbc.png" },
        { id: 2, name: "BBC One FHD", category: "UK | Entertainment", tvgId: "bbc.one", logo: "https://x/bbc.png" },
        { id: 3, name: "RTÉ One", category: "UK", tvgId: "rte.one", logo: "https://x/rte.png" },
      ],
      30 * 24 * 3600 * 1000,
    );
    const data = await loadLivetvHomeData("demo-w7");
    expect(data.channels.map((c) => c.displayName)).toEqual(["BBC One", "RTÉ One"]);
    expect(data.channels[0].duplicateIds).toEqual([2]);
    expect(data.hasEpg).toBe(false);
  });
});

describe("readActivePlaylistId stale-selection fallback", () => {
  afterEach(() => {
    window.localStorage.removeItem("xt_playlists");
  });

  it("falls back to the first entry when the stored selection matches nothing", () => {
    window.localStorage.setItem(
      "xt_playlists",
      JSON.stringify({ entries: [{ _id: "first" }, { _id: "second" }], selectedId: "gone" }),
    );
    expect(readActivePlaylistId()).toBe("first");
  });

  it("still honours a matching selection, and returns '' with no entries", () => {
    window.localStorage.setItem(
      "xt_playlists",
      JSON.stringify({ entries: [{ _id: "first" }, { _id: "second" }], selectedId: "second" }),
    );
    expect(readActivePlaylistId()).toBe("second");
    window.localStorage.setItem("xt_playlists", JSON.stringify({ entries: [], selectedId: "gone" }));
    expect(readActivePlaylistId()).toBe("");
    window.localStorage.removeItem("xt_playlists");
    expect(readActivePlaylistId()).toBe("");
  });
});
