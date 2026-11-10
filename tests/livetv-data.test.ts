/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import {
  LIVETV_STATE_KEYS,
  LIVETV_STATE_COPY,
  groupChannels,
  isLocalChannel,
  loadLivetvChannels,
  mapLivetvChannels,
  favouriteChannels,
  normaliseCategoryLabel,
  nowNextForChannel,
  pickResumeHero,
  recentlyWatchedChannels,
  searchChannels,
  whatsOnNow,
  type LivetvChannel,
  type LivetvRecentEntry,
} from "@/scripts/lib/livetv-data";
import type { Programme } from "@/scripts/lib/now-next";

// Fixed clock: 2026-11-10 20:00:00 UTC.
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

type ProgrammeFixture = { start: number; stop: number; title: string; desc?: string };
type ProgrammesFixture = Array<[string, ProgrammeFixture[]]>;

function programmesFor(entries: ProgrammesFixture): Map<string, Programme[]> {
  const map = new Map<string, Programme[]>();
  for (const [tvgId, list] of entries) {
    map.set(tvgId.toLowerCase(), list.map((p) => ({ ...p })));
  }
  return map;
}

describe("normaliseCategoryLabel", () => {
  it("strips a leading country prefix", () => {
    expect(normaliseCategoryLabel("UK | Sports")).toBe("Sports");
    expect(normaliseCategoryLabel("IE - News")).toBe("News");
    expect(normaliseCategoryLabel("Ireland: Movies")).toBe("Movies");
  });

  it("strips a trailing region in parens", () => {
    expect(normaliseCategoryLabel("Sports (UK)")).toBe("Sports");
  });

  it("strips resolution tags", () => {
    expect(normaliseCategoryLabel("Movies FHD")).toBe("Movies");
    expect(normaliseCategoryLabel("Sports HD")).toBe("Sports");
    expect(normaliseCategoryLabel("News 4K")).toBe("News");
    expect(normaliseCategoryLabel("Documentaries 1080p")).toBe("Documentaries");
  });

  it("collapses redundant punctuation and whitespace", () => {
    expect(normaliseCategoryLabel("  Movies  |  Drama  ")).toBe("Movies Drama");
    expect(normaliseCategoryLabel("Kids---TV")).toBe("Kids TV");
  });

  it("returns Uncategorized for empty / non-string input", () => {
    expect(normaliseCategoryLabel("")).toBe("Uncategorized");
    expect(normaliseCategoryLabel("   ")).toBe("Uncategorized");
    expect(normaliseCategoryLabel(null)).toBe("Uncategorized");
    expect(normaliseCategoryLabel(undefined)).toBe("Uncategorized");
  });

  it("keeps a bare region label (it is the group, not a prefix)", () => {
    expect(normaliseCategoryLabel("UK")).toBe("UK");
    expect(normaliseCategoryLabel("Ireland")).toBe("Ireland");
  });
});

describe("mapLivetvChannels", () => {
  it("maps provider rows to the typed contract", () => {
    const rows = mapLivetvChannels(
      [
        { id: 101, name: "RTÉ One", category: "UK | Entertainment", logo: "https://x/logo.png", tvgId: "rte.one", chno: 101, tvArchive: 1, url: "https://x/stream.m3u8" },
        { id: "abc", name: "M3U Channel", category: "Movies FHD", url: "https://x/m.m3u8" },
      ],
      new Set([101]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 101,
      name: "RTÉ One",
      displayName: "RTÉ One",
      categoryId: "UK | Entertainment",
      categoryLabel: "Entertainment",
      tvgId: "rte.one",
      chno: 101,
      catchup: true,
      favourite: true,
      hidden: false,
      streamUrl: "https://x/stream.m3u8",
    });
    expect(rows[1]).toMatchObject({
      id: "abc",
      categoryLabel: "Movies",
      favourite: false,
      catchup: false,
    });
  });

  it("skips rows without an id or a name, and keeps hidden flags", () => {
    const rows = mapLivetvChannels([
      { id: 1, name: "Good" },
      { id: 2, name: "" },
      { name: "No id" },
      { id: 3, name: "Hidden", hidden: true },
    ]);
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
    expect(rows[1].hidden).toBe(true);
  });
});

describe("groupChannels", () => {
  it("groups by genre, Irish & UK for pure region buckets, provider groups as fallback", () => {
    const channels = [
      ch({ id: 1, name: "Sport 1", categoryId: "UK | Sports" }),
      ch({ id: 2, name: "News 1", categoryId: "News" }),
      ch({ id: 3, name: "RTÉ One", categoryId: "UK" }),
      ch({ id: 4, name: "Cinema 1", categoryId: "Movies FHD" }),
      ch({ id: 5, name: "Oddball", categoryId: "Zebra Corner" }),
    ];
    const groups = groupChannels(channels);
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get("sports")?.channels.map((c) => c.id)).toEqual([1]);
    expect(byId.get("news")?.channels.map((c) => c.id)).toEqual([2]);
    expect(byId.get("irish-uk")?.channels.map((c) => c.id)).toEqual([3]);
    expect(byId.get("movies")?.channels.map((c) => c.id)).toEqual([4]);
    expect(byId.get("provider:zebra-corner")?.channels.map((c) => c.id)).toEqual([5]);
    // All Channels is last and holds everything.
    expect(groups[groups.length - 1].id).toBe("all");
    expect(groups[groups.length - 1].channels).toHaveLength(5);
    // Directive order for the local groups.
    const localIds = groups.filter((g) => !g.id.startsWith("provider:") && g.id !== "all").map((g) => g.id);
    expect(localIds).toEqual(["irish-uk", "sports", "news", "movies"]);
  });

  it("never hardcodes provider naming: an unknown category survives as its own group", () => {
    const channels = [ch({ id: 9, name: "X", categoryId: "Some Provider Bucket", categoryLabel: "Some Provider Bucket" })];
    const groups = groupChannels(channels);
    expect(groups.map((g) => g.label)).toEqual(["Some Provider Bucket", "All Channels"]);
  });

  it("a channel lands in exactly one group (+ All Channels)", () => {
    const channels = [ch({ id: 1, name: "A", categoryId: "Sports" })];
    const groups = groupChannels(channels);
    const memberships = groups.filter((g) => g.channels.some((c) => c.id === 1));
    expect(memberships.map((g) => g.id)).toEqual(["sports", "all"]);
  });

  it("isLocalChannel is true for IE/UK categories only", () => {
    expect(isLocalChannel(ch({ id: 1, name: "A", categoryId: "UK | Sports" }))).toBe(true);
    expect(isLocalChannel(ch({ id: 2, name: "B", categoryId: "Ireland" }))).toBe(true);
    expect(isLocalChannel(ch({ id: 3, name: "C", categoryId: "Sports" }))).toBe(false);
  });
});

describe("searchChannels", () => {
  const channels = [
    ch({ id: 101, name: "RTÉ One", categoryId: "Entertainment", norm: "rté one entertainment rte.one" }),
    ch({ id: 102, name: "Sky Sports Main Event", categoryId: "Sports", chno: 402, norm: "sky sports main event sports" }),
    ch({ id: 103, name: "BBC News", categoryId: "News", chno: 231, norm: "bbc news news" }),
  ];

  it("matches name tokens", () => {
    expect(searchChannels(channels, "sky sports").map((c) => c.id)).toEqual([102]);
    expect(searchChannels(channels, "BBC").map((c) => c.id)).toEqual([103]);
  });

  it("matches channel number / id for digits-only tokens", () => {
    expect(searchChannels(channels, "402").map((c) => c.id)).toEqual([102]);
    expect(searchChannels(channels, "10").map((c) => c.id)).toEqual([101, 102, 103]);
  });

  it("returns a copy of everything for an empty query", () => {
    const out = searchChannels(channels, "");
    expect(out).toEqual(channels);
    expect(out).not.toBe(channels);
  });

  it("requires every token to match", () => {
    expect(searchChannels(channels, "sky news")).toEqual([]);
  });
});

describe("favouriteChannels / recentlyWatchedChannels", () => {
  const channels = [
    ch({ id: 1, name: "A", favourite: true }),
    ch({ id: 2, name: "B" }),
    ch({ id: 3, name: "C", favourite: true }),
  ];

  it("favouriteChannels filters on the favourite flag", () => {
    expect(favouriteChannels(channels).map((c) => c.id)).toEqual([1, 3]);
  });

  it("recentlyWatchedChannels dedupes by id and drops gone channels", () => {
    const recents: LivetvRecentEntry[] = [
      { id: 2, name: "B", logo: null, ts: 300 },
      { id: 2, name: "B", logo: null, ts: 200 },
      { id: 99, name: "Gone", logo: null, ts: 150 },
      { id: 1, name: "A", logo: null, ts: 100 },
    ];
    expect(recentlyWatchedChannels(channels, recents).map((c) => c.id)).toEqual([2, 1]);
  });

  it("recentlyWatchedChannels never merges distinct channels on similar names", () => {
    const similar = [
      ch({ id: 10, name: "Sky Sports" }),
      ch({ id: 11, name: "Sky Sports 2" }),
    ];
    const recents: LivetvRecentEntry[] = [{ id: 11, name: "Sky Sports 2", logo: null, ts: 1 }];
    expect(recentlyWatchedChannels(similar, recents).map((c) => c.id)).toEqual([11]);
  });

  it("recentlyWatchedChannels honours the limit", () => {
    const recents: LivetvRecentEntry[] = [
      { id: 1, name: "A", logo: null, ts: 3 },
      { id: 2, name: "B", logo: null, ts: 2 },
      { id: 3, name: "C", logo: null, ts: 1 },
    ];
    expect(recentlyWatchedChannels(channels, recents, 2).map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("nowNextForChannel", () => {
  const programmes = programmesFor([
    ["rte.one", [
      { start: NOW - HOUR, stop: NOW + HOUR, title: "Evening News", desc: "The news." },
      { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: "Late Film", desc: "A film." },
    ]],
  ]);

  it("returns current + next with progress", () => {
    const channel = ch({ id: 1, name: "RTÉ One", tvgId: "rte.one" });
    const slot = nowNextForChannel(channel, programmes, "", NOW);
    expect(slot.current?.title).toBe("Evening News");
    expect(slot.current?.progress).toBeCloseTo(0.5);
    expect(slot.next?.title).toBe("Late Film");
  });

  it("is null-safe: no programmes, no channel, no tvg-id → nulls, never invented", () => {
    const channel = ch({ id: 1, name: "RTÉ One", tvgId: "rte.one" });
    expect(nowNextForChannel(channel, null)).toEqual({ current: null, next: null });
    expect(nowNextForChannel(null, programmes)).toEqual({ current: null, next: null });
    expect(nowNextForChannel(ch({ id: 2, name: "No EPG" }), programmes)).toEqual({ current: null, next: null });
    expect(nowNextForChannel(channel, new Map())).toEqual({ current: null, next: null });
  });

  it("unwraps a raw EPG state object defensively", () => {
    const channel = ch({ id: 1, name: "RTÉ One", tvgId: "rte.one" });
    const slot = nowNextForChannel(channel, { programmes } as never, "", NOW);
    expect(slot.current?.title).toBe("Evening News");
  });
});

describe("whatsOnNow", () => {
  const programmes = programmesFor([
    ["rte.one", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "Evening News" }]],
    ["sky.sports", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "Match Live" }]],
    ["bbc.news", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "World News" }]],
    ["fr.channel", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "French Film" }]],
  ]);
  const channels = [
    ch({ id: 1, name: "French", tvgId: "fr.channel", categoryId: "Movies" }),
    ch({ id: 2, name: "RTÉ One", tvgId: "rte.one", categoryId: "UK" }),
    ch({ id: 3, name: "Sky Sports", tvgId: "sky.sports", categoryId: "Sports", favourite: true }),
    ch({ id: 4, name: "BBC News", tvgId: "bbc.news", categoryId: "News" }),
  ];

  it("orders favourites, then watched, then local, then the rest", () => {
    const items = whatsOnNow(channels, programmes, {
      favouriteIds: [3],
      watchedIds: [4],
      atMs: NOW,
    });
    expect(items.map((i) => i.channel.id)).toEqual([3, 4, 2, 1]);
  });

  it("only shows channels with a real current programme", () => {
    const items = whatsOnNow(channels, new Map(), { atMs: NOW });
    expect(items).toEqual([]);
    const noEpg = whatsOnNow(channels, null, { atMs: NOW });
    expect(noEpg).toEqual([]);
  });

  it("never invents a programme for a channel without EPG", () => {
    const extra = [...channels, ch({ id: 5, name: "No Guide", tvgId: "no.guide", categoryId: "News", favourite: true })];
    const items = whatsOnNow(extra, programmes, { favouriteIds: [5, 3], atMs: NOW });
    expect(items.map((i) => i.channel.id)).not.toContain(5);
    expect(items[0].channel.id).toBe(3);
  });
});

describe("pickResumeHero", () => {
  const programmes = programmesFor([
    ["rte.one", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "Evening News" }]],
    ["sky.sports", [{ start: NOW - HOUR, stop: NOW + HOUR, title: "Match Live" }]],
  ]);

  it("prefers the last watched channel", () => {
    const channels = [
      ch({ id: 1, name: "RTÉ One", tvgId: "rte.one", favourite: true }),
      ch({ id: 2, name: "Sky Sports", tvgId: "sky.sports" }),
    ];
    const recents: LivetvRecentEntry[] = [{ id: 2, name: "Sky Sports", logo: null, ts: 1 }];
    const pick = pickResumeHero(channels, recents, programmes, "", NOW);
    expect(pick).toEqual({ channel: channels[1], eyebrow: "Resume Watching" });
  });

  it("falls back to a favourite with a live programme, then any favourite", () => {
    const channels = [
      ch({ id: 1, name: "RTÉ One", tvgId: "rte.one", favourite: true }),
      ch({ id: 2, name: "Sky Sports", tvgId: "sky.sports", favourite: true }),
    ];
    expect(pickResumeHero(channels, [], programmes, "", NOW)?.channel.id).toBe(1);
    const noEpg = pickResumeHero(channels, [], new Map(), "", NOW);
    expect(noEpg).toEqual({ channel: channels[0], eyebrow: "Favourite Channel" });
  });

  it("falls back to the first channel with a live programme, else null (never invented)", () => {
    const channels = [ch({ id: 2, name: "Sky Sports", tvgId: "sky.sports" })];
    expect(pickResumeHero(channels, [], programmes, "", NOW)?.eyebrow).toBe("On Now");
    expect(pickResumeHero(channels, [], new Map(), "", NOW)).toBeNull();
    expect(pickResumeHero([], [], programmes, "", NOW)).toBeNull();
  });
});

describe("shared state keys", () => {
  it("defines every state key W2/W3 reuse, with copy", () => {
    expect([...LIVETV_STATE_KEYS]).toEqual([
      "no-favourites",
      "no-recents",
      "missing-epg",
      "empty-category",
      "no-replay",
      "stream-unavailable",
      "provider-lost",
    ]);
    for (const key of LIVETV_STATE_KEYS) {
      expect(LIVETV_STATE_COPY[key].title.length).toBeGreaterThan(0);
      expect(LIVETV_STATE_COPY[key].message.length).toBeGreaterThan(0);
    }
  });
});

describe("loadLivetvChannels", () => {
  it("returns [] for an empty playlist id without touching storage", async () => {
    await expect(loadLivetvChannels("")).resolves.toEqual([]);
  });
});
