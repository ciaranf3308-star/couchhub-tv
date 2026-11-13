/**
 * Guide data path — Live TV 0.11.11 W3 (freeze fix + failure states).
 *
 * Covers the new livetv-guide-data.ts module, the sanitise /
 * availableGuideDays changes in livetv-guide.ts, and (via the
 * repo's source-text pattern) the TvGuideView.astro call-site
 * wiring that unit tests cannot mount.
 *
 * Fixtures populate the EPG store the way the real loader does
 * (lower-cased tvg-id keys, pre-built nameIndex from
 * buildChannelNameIndex) — the headless EPG store is always empty,
 * so live EPG-path verification is hardware-only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChannelNameIndex,
  resolveTvgId,
} from "@/scripts/lib/epg-data.js";
import {
  availableGuideDays,
  normaliseCategoryLabel,
  nowNextRows,
  sanitiseGuideProgrammes,
  GUIDE_DAY_MS,
  type GuideProgramme,
} from "@/scripts/lib/livetv-guide";
import {
  buildTonightSections,
  chronologicalTonight,
  eveningWindowMs,
  type TonightItem,
} from "@/scripts/lib/livetv-tonight";
import { startOfLocalDayMs } from "@/scripts/lib/livetv-state";
import {
  collectTonightItems,
  createGuideTvgResolver,
  createNowNextRowsCache,
  loadGuideProgrammes,
  resolveGuideLoadFailed,
} from "@/scripts/lib/livetv-guide-data";

const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const HOUR = 3_600_000;

function programme(
  startMs: number,
  stopMs: number,
  title: string,
  desc = "",
): { start: number; stop: number; title: string; desc: string } {
  return { start: startMs, stop: stopMs, title, desc };
}

function epgState(
  entries: Array<{ id: string; name: string; programmes: unknown[] }>,
  withIndex = true,
) {
  const programmes = new Map<string, unknown[]>();
  const channelNames = new Map<string, string>();
  for (const entry of entries) {
    programmes.set(entry.id, entry.programmes);
    channelNames.set(entry.id, entry.name);
  }
  return {
    programmes,
    channelNames,
    nameIndex: withIndex ? buildChannelNameIndex(channelNames) : undefined,
  };
}

// ── Indexed resolution: identical results to the pure path ───────

describe("createGuideTvgResolver: indexed resolution", () => {
  const state = epgState([
    {
      id: "bbc1.uk",
      name: "BBC One",
      programmes: [programme(NOW, NOW + HOUR, "News")],
    },
    {
      id: "mdr.sachsen.de",
      name: "MDR Sachsen",
      programmes: [programme(NOW, NOW + HOUR, "Show")],
    },
    {
      id: "bbc2.uk",
      name: "BBC Two",
      programmes: [programme(NOW, NOW + HOUR, "Film")],
    },
  ]);
  const programmes = state.programmes as Map<string, unknown[]>;
  const channelNames = state.channelNames;

  const channels = [
    // Matching raw tvg-id (fast path in both).
    { id: 1, name: "BBC One", tvgId: "bbc1.uk" },
    // No tvg-id at all: name match.
    { id: 2, name: "BBC One HD" },
    // tvg-id not in programmes: name match with quality suffix.
    { id: 3, name: "MDR Sachsen HD", tvgId: "mdr.sx.hd.de" },
    // Provider-group prefix: stripped-prefix retry (colon + pipe).
    { id: 4, name: "Basic UK: BBC One", tvgId: "bbc-one.provider" },
    { id: 5, name: "UK | BBC Two", tvgId: "bbc-two.provider" },
    // Non-matching: falls back to the raw tvg-id.
    { id: 6, name: "Some Obscure Channel", tvgId: "obscure.provider" },
    { id: 7, name: "Basic UK: Some Obscure Channel", tvgId: "obscure.provider" },
    // No tvg-id and no name match: empty.
    { id: 8, name: "Nothing Like This" },
    { id: 9 },
    // Override wins over everything.
    { id: 10, name: "BBC One", tvgId: "bbc1.uk" },
  ];
  const overrides = { "10": "Mapped.ID" };

  it("returns identical results to resolveTvgId (matching + non-matching + prefixed)", () => {
    const resolver = createGuideTvgResolver(state, overrides);
    for (const channel of channels) {
      expect(
        resolver.resolve(channel),
        `channel ${JSON.stringify(channel)}`,
      ).toBe(resolveTvgId(channel, overrides, programmes, channelNames));
    }
  });

  it("returns identical results when the state has no pre-built index", () => {
    const noIndex = epgState(
      [
        {
          id: "bbc1.uk",
          name: "BBC One",
          programmes: [programme(NOW, NOW + HOUR, "News")],
        },
        {
          id: "mdr.sachsen.de",
          name: "MDR Sachsen",
          programmes: [programme(NOW, NOW + HOUR, "Show")],
        },
      ],
      false,
    );
    const resolver = createGuideTvgResolver(noIndex, overrides);
    for (const channel of channels) {
      expect(resolver.resolve(channel)).toBe(
        resolveTvgId(
          channel,
          overrides,
          noIndex.programmes as Map<string, unknown[]>,
          noIndex.channelNames,
        ),
      );
    }
  });

  it("reuses the state's pre-built index (zero rebuilds)", () => {
    const resolver = createGuideTvgResolver(state, {});
    expect(resolver.nameIndex).toBe(state.nameIndex);
  });

  it("builds the index once and reuses it across resolves", () => {
    const noIndex = epgState(
      [{ id: "bbc1.uk", name: "BBC One", programmes: [] }],
      false,
    );
    const resolver = createGuideTvgResolver(noIndex, {});
    const first = resolver.nameIndex;
    resolver.resolve({ id: 1, name: "BBC One" });
    resolver.resolve({ id: 2, name: "BBC One HD" });
    resolver.resolve({ id: 3, name: "Nope" });
    expect(resolver.nameIndex).toBe(first);
    expect(first).toEqual(buildChannelNameIndex(noIndex.channelNames));
  });

  it("refuses ambiguous names exactly like the pure path", () => {
    // Two tvg-ids normalise to the same name: the index marks a
    // collision and both paths fall back to the raw tvg-id.
    const ambiguous = epgState([
      { id: "a.tv", name: "Channel One", programmes: [] },
      { id: "b.tv", name: "Channel One HD", programmes: [] },
    ]);
    const channel = { id: 1, name: "Channel One", tvgId: "raw.tv" };
    expect(createGuideTvgResolver(ambiguous, {}).resolve(channel)).toBe(
      resolveTvgId(
        channel,
        {},
        ambiguous.programmes as Map<string, unknown[]>,
        ambiguous.channelNames,
      ),
    );
    expect(createGuideTvgResolver(ambiguous, {}).resolve(channel)).toBe(
      "raw.tv",
    );
  });

  it("tolerates null channel / null state / null overrides", () => {
    expect(createGuideTvgResolver(null, null).resolve(null)).toBe("");
    expect(
      createGuideTvgResolver(null, null).resolve({ id: 1, tvgId: "x.tv" }),
    ).toBe("x.tv");
    expect(createGuideTvgResolver(state, null).resolve({ id: 1 })).toBe("");
  });
});

// ── Batch load ───────────────────────────────────────────────────

describe("loadGuideProgrammes", () => {
  it("loads + shifts + sanitises, and accounts mapped/unmapped", () => {
    const state = epgState([
      {
        id: "bbc1.uk",
        name: "BBC One",
        programmes: [
          programme(NOW, NOW + HOUR, "News"),
          programme(NOW + HOUR, NOW + 2 * HOUR, "Film"),
        ],
      },
    ]);
    const channels = [
      { id: 1, name: "BBC One", tvgId: "bbc1.uk", tvgShift: 1 },
      { id: 2, name: "No EPG Here", tvgId: "nothing.tv" },
      { id: 3, name: "BBC One HD" },
    ];
    const loaded = loadGuideProgrammes(channels, state, {});
    // Channel 1: tvg-shift moves programmes +1h.
    const shifted = loaded.programmesByChannel.get("1")!;
    expect(shifted.map((p) => p.startMs)).toEqual([NOW + HOUR, NOW + 2 * HOUR]);
    // Channel 3: name match, no shift.
    expect(loaded.programmesByChannel.get("3")!.map((p) => p.title)).toEqual([
      "News",
      "Film",
    ]);
    expect(loaded.programmesByChannel.has("2")).toBe(false);
    expect(loaded.mappedChannelCount).toBe(2);
    expect(loaded.resolvedChannelCount).toBe(3);
    expect(loaded.unmappedChannelIds).toEqual(["2"]);
    expect(loaded.failedChannelIds).toEqual([]);
    expect(loaded.totalProgrammes).toBe(4);
  });

  it("skips a corrupt channel instead of aborting the load", () => {
    const programmes = new Map<string, unknown>([
      ["good.tv", [programme(NOW, NOW + HOUR, "Good")]],
      // A corrupt cached row: an object with .length but no .map.
      // With a tvg-shift, shiftChannelProgrammes throws on .map;
      // the loader isolates the channel instead of aborting.
      ["bad.tv", { length: 2 }],
      // A corrupt row with no shift: shift passes it through and
      // sanitise's Array.isArray guard turns it into [] (mapped
      // but empty) instead of throwing out of the for...of.
      ["weird.tv", "not-an-array"],
    ]);
    const names = new Map([
      ["good.tv", "Good"],
      ["bad.tv", "Bad"],
      ["weird.tv", "Weird"],
    ]);
    const state = {
      programmes: programmes as Map<string, unknown[]>,
      channelNames: names,
      nameIndex: buildChannelNameIndex(names),
    };
    const loaded = loadGuideProgrammes(
      [
        { id: 1, name: "Bad", tvgId: "bad.tv", tvgShift: 1 },
        { id: 2, name: "Good", tvgId: "good.tv" },
        { id: 3, name: "Weird", tvgId: "weird.tv" },
      ],
      state,
      {},
    );
    expect(loaded.failedChannelIds).toEqual(["1"]);
    expect(loaded.programmesByChannel.get("2")!.map((p) => p.title)).toEqual([
      "Good",
    ]);
    expect(loaded.programmesByChannel.get("3")).toEqual([]);
    expect(loaded.mappedChannelCount).toBe(2);
  });

  it("returns empty maps (never throws) with no EPG state", () => {
    const loaded = loadGuideProgrammes(
      [{ id: 1, name: "BBC One", tvgId: "bbc1.uk" }],
      null,
      {},
    );
    expect(loaded.programmesByChannel.size).toBe(0);
    expect(loaded.unmappedChannelIds).toEqual(["1"]);
    expect(loaded.totalProgrammes).toBe(0);
  });
});

// ── Now/Next cache ───────────────────────────────────────────────

describe("createNowNextRowsCache", () => {
  function fixture() {
    // Programmes built around NOW itself (30 min either side), so
    // "current" is stable within the minute bucket in any zone.
    const around = (id: string): GuideProgramme[] => [
      {
        channelId: id,
        startMs: NOW - 30 * 60 * 1000,
        stopMs: NOW + 30 * 60 * 1000,
        title: "Current",
      },
      {
        channelId: id,
        startMs: NOW + 30 * 60 * 1000,
        stopMs: NOW + 90 * 60 * 1000,
        title: "Next",
      },
    ];
    const programmesByChannel = new Map<string, GuideProgramme[]>([
      ["1", around("1")],
      ["2", around("2")],
      ["3", around("3")],
    ]);
    return { programmesByChannel };
  }

  it("returns the same rows as nowNextRows on a cold call", () => {
    const cache = createNowNextRowsCache();
    const { programmesByChannel } = fixture();
    const cached = cache.getRows({
      programmesByChannel,
      visibleChannels: [{ id: 1 }, { id: 2 }, { id: 3 }],
      nowMs: NOW,
      revision: 1,
    });
    expect(cached).toEqual(nowNextRows(programmesByChannel, NOW));
  });

  it("reuses the scan within a minute bucket, with fresh progress", () => {
    const cache = createNowNextRowsCache();
    const { programmesByChannel } = fixture();
    const first = cache.getRows({
      programmesByChannel,
      visibleChannels: [{ id: 1 }, { id: 2 }],
      nowMs: NOW,
      revision: 1,
    });
    // Same bucket, 30s later: same current/next pairs, progress moved.
    const second = cache.getRows({
      programmesByChannel,
      visibleChannels: [{ id: 1 }, { id: 2 }],
      nowMs: NOW + 30_000,
      revision: 1,
    });
    expect(second.map((r) => r.channelId)).toEqual(
      first.map((r) => r.channelId),
    );
    expect(second.map((r) => r.current.title)).toEqual(
      first.map((r) => r.current.title),
    );
    expect(second[0]!.progress).toBeGreaterThan(first[0]!.progress);
  });

  it("invalidates on EPG revision change", () => {
    const cache = createNowNextRowsCache();
    const { programmesByChannel } = fixture();
    const args = {
      programmesByChannel,
      visibleChannels: [{ id: 1 }, { id: 2 }, { id: 3 }],
      nowMs: NOW,
    };
    const before = cache.getRows({ ...args, revision: 1 });
    // EPG refresh swaps channel 3's programmes for an empty list.
    const refreshed = new Map(programmesByChannel);
    refreshed.set("3", []);
    const after = cache.getRows({
      programmesByChannel: refreshed,
      visibleChannels: args.visibleChannels,
      nowMs: NOW,
      revision: 2,
    });
    expect(after.map((r) => r.channelId)).toEqual(["1", "2"]);
    expect(before.map((r) => r.channelId)).toEqual(["1", "2", "3"]);
  });

  it("invalidates when the visible set changes at the same revision", () => {
    const cache = createNowNextRowsCache();
    const { programmesByChannel } = fixture();
    const all = cache.getRows({
      programmesByChannel,
      visibleChannels: [{ id: 1 }, { id: 2 }, { id: 3 }],
      nowMs: NOW,
      revision: 1,
    });
    const subset = cache.getRows({
      programmesByChannel,
      visibleChannels: [{ id: 2 }],
      nowMs: NOW,
      revision: 1,
    });
    expect(all.map((r) => r.channelId)).toEqual(["1", "2", "3"]);
    expect(subset.map((r) => r.channelId)).toEqual(["2"]);
  });

  it("recomputes in a new minute bucket", () => {
    const cache = createNowNextRowsCache();
    const { programmesByChannel } = fixture();
    const first = cache.getRows({
      programmesByChannel,
      visibleChannels: [{ id: 1 }],
      nowMs: NOW,
      revision: 1,
    });
    // 61s later (next bucket): the scan runs again. Rows agree with
    // a direct nowNextRows call at the later time.
    const later = cache.getRows({
      programmesByChannel,
      visibleChannels: [{ id: 1 }],
      nowMs: NOW + 61_000,
      revision: 1,
    });
    const direct = nowNextRows(
      new Map([["1", programmesByChannel.get("1")!]]),
      NOW + 61_000,
    );
    expect(later).toEqual(direct);
    expect(later[0]!.current.title).toBe(first[0]!.current.title);
  });

  it("invalidate() drops the cached scan", () => {
    const cache = createNowNextRowsCache();
    const { programmesByChannel } = fixture();
    cache.getRows({
      programmesByChannel,
      visibleChannels: [{ id: 1 }],
      nowMs: NOW,
      revision: 1,
    });
    cache.invalidate();
    const refreshed = new Map(programmesByChannel);
    refreshed.set("1", []);
    expect(
      cache.getRows({
        programmesByChannel: refreshed,
        visibleChannels: [{ id: 1 }],
        nowMs: NOW,
        revision: 1,
      }),
    ).toEqual([]);
  });
});

// ── Tonight collection: identical output, bounded input work ─────

describe("collectTonightItems", () => {
  function oldLoop(
    channels: Array<{ id: number; name: string; category?: string }>,
    programmesByChannel: Map<string, GuideProgramme[]>,
    needle: string,
  ): TonightItem[] {
    let items: TonightItem[] = [];
    for (const channel of channels) {
      const list = programmesByChannel.get(String(channel.id)) || [];
      if (list.length === 0) continue;
      const tonightChannel = {
        id: String(channel.id),
        displayName: channel.name || "",
        logo: null,
        categoryLabel: normaliseCategoryLabel(channel.category || ""),
        favourite: false,
        watched: false,
      };
      for (const programme of list) {
        items.push({ programme, channel: tonightChannel });
      }
    }
    if (needle) {
      items = items.filter((item) =>
        `${item.channel.displayName} ${item.programme.title} ${item.programme.desc ?? ""}`
          .toLowerCase()
          .includes(needle),
      );
    }
    return items;
  }

  function fixture() {
    // Programmes across 3 days: only the evening window survives.
    const dayStart = startOfLocalDayMs(NOW);
    const channels = [
      { id: 1, name: "BBC One", category: "Entertainment" },
      { id: 2, name: "Sky Sports", category: "Sport" },
      { id: 3, name: "Film 4", category: "Movies" },
    ];
    const programmesByChannel = new Map<string, GuideProgramme[]>();
    for (const channel of channels) {
      const list: GuideProgramme[] = [];
      for (let d = -1; d <= 1; d++) {
        for (let h = 0; h < 24; h++) {
          const start = dayStart + d * GUIDE_DAY_MS + h * HOUR;
          list.push({
            channelId: String(channel.id),
            startMs: start,
            stopMs: start + HOUR,
            title: h === 20 ? `Evening Film ${channel.id}` : `Show ${h}`,
            desc: h === 21 ? "live football match" : "",
          });
        }
      }
      programmesByChannel.set(String(channel.id), list);
    }
    return { channels, programmesByChannel };
  }

  it("produces identical sections + fallback to the old full loop", () => {
    const { channels, programmesByChannel } = fixture();
    const { windowStartMs, windowEndMs } = eveningWindowMs(NOW);
    const collected = collectTonightItems(channels, programmesByChannel, {
      favouriteIds: new Set(),
      watchedIds: new Set(),
      windowStartMs,
      windowEndMs,
    });
    const old = oldLoop(channels, programmesByChannel, "");
    const key = (item: TonightItem) =>
      `${item.channel.id}@${item.programme.startMs}`;
    // Same evening items (the old loop's extra items are all
    // outside the window and filtered out downstream).
    expect(collected.map(key).sort()).toEqual(
      chronologicalTonight(old, NOW).map(key).sort(),
    );
    expect(buildTonightSections(collected, NOW)).toEqual(
      buildTonightSections(old, NOW),
    );
    expect(chronologicalTonight(collected, NOW)).toEqual(
      chronologicalTonight(old, NOW),
    );
    // Bounded input work: 216 total programmes, evening only.
    expect(collected.length).toBeLessThan(old.length);
    expect(collected.length).toBeGreaterThan(0);
  });

  it("applies the search filter identically to the old loop", () => {
    const { channels, programmesByChannel } = fixture();
    const { windowStartMs, windowEndMs } = eveningWindowMs(NOW);
    const collected = collectTonightItems(channels, programmesByChannel, {
      favouriteIds: new Set(),
      watchedIds: new Set(),
      windowStartMs,
      windowEndMs,
      searchNeedle: "football",
    });
    const old = oldLoop(channels, programmesByChannel, "football");
    expect(buildTonightSections(collected, NOW)).toEqual(
      buildTonightSections(old, NOW),
    );
    expect(chronologicalTonight(collected, NOW)).toEqual(
      chronologicalTonight(old, NOW),
    );
    expect(collected.length).toBeGreaterThan(0);
    expect(
      collected.every((item) =>
        `${item.programme.title} ${item.programme.desc ?? ""}`
          .toLowerCase()
          .includes("football"),
      ),
    ).toBe(true);
  });

  it("carries favourite/watched/category identity per channel", () => {
    const { channels, programmesByChannel } = fixture();
    const { windowStartMs, windowEndMs } = eveningWindowMs(NOW);
    const collected = collectTonightItems(channels, programmesByChannel, {
      favouriteIds: new Set([1]),
      watchedIds: new Set([2]),
      windowStartMs,
      windowEndMs,
    });
    const byChannel = new Map(collected.map((i) => [i.channel.id, i.channel]));
    expect(byChannel.get("1")!.favourite).toBe(true);
    expect(byChannel.get("2")!.watched).toBe(true);
    expect(byChannel.get("3")!.favourite).toBe(false);
    expect(byChannel.get("2")!.categoryLabel).toBe("Sport");
  });

  it("returns [] when no programme overlaps the window", () => {
    const { windowStartMs, windowEndMs } = eveningWindowMs(NOW);
    const programmesByChannel = new Map<string, GuideProgramme[]>([
      [
        "1",
        [
          {
            channelId: "1",
            startMs: NOW - 10 * HOUR,
            stopMs: NOW - 9 * HOUR,
            title: "Morning",
          },
        ],
      ],
    ]);
    expect(
      collectTonightItems([{ id: 1, name: "BBC One" }], programmesByChannel, {
        favouriteIds: new Set(),
        watchedIds: new Set(),
        windowStartMs,
        windowEndMs,
      }),
    ).toEqual([]);
  });
});

// ── Failure signal (W4 `loadFailed` seam) ────────────────────────
// W4 owns the single classifier (`guideDataState`, livetv-guide.ts).
// This module defines only the signal it reads: either genuine
// failure condition means the EPG load genuinely failed.

describe("resolveGuideLoadFailed", () => {
  it("is false when neither failure condition holds", () => {
    expect(
      resolveGuideLoadFailed({
        pipelineFailed: false,
        epgSourcesFailed: false,
      }),
    ).toBe(false);
  });

  it("is true when the pipeline threw and has not recovered", () => {
    expect(
      resolveGuideLoadFailed({
        pipelineFailed: true,
        epgSourcesFailed: false,
      }),
    ).toBe(true);
  });

  it("is true when every EPG source errored", () => {
    expect(
      resolveGuideLoadFailed({
        pipelineFailed: false,
        epgSourcesFailed: true,
      }),
    ).toBe(true);
  });

  it("is true when both conditions hold", () => {
    expect(
      resolveGuideLoadFailed({
        pipelineFailed: true,
        epgSourcesFailed: true,
      }),
    ).toBe(true);
  });
});

// ── sanitiseGuideProgrammes: dedupe + corrupt-input guard ────────

describe("sanitiseGuideProgrammes (0.11.11 W3)", () => {
  it("collapses exact duplicates (same start, stop, title)", () => {
    const cleaned = sanitiseGuideProgrammes("ch-1", [
      { start: NOW, stop: NOW + HOUR, title: "News" },
      { start: NOW, stop: NOW + HOUR, title: "News" },
      { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: "Film" },
      { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: "Film" },
    ]);
    expect(cleaned.map((p) => p.title)).toEqual(["News", "Film"]);
  });

  it("keeps programmes that merely share a start time", () => {
    const cleaned = sanitiseGuideProgrammes("ch-1", [
      { start: NOW, stop: NOW + HOUR, title: "News" },
      { start: NOW, stop: NOW + 2 * HOUR, title: "News" },
      { start: NOW, stop: NOW + HOUR, title: "Other" },
    ]);
    expect(cleaned).toHaveLength(3);
  });

  it("returns [] for non-array corrupt input instead of throwing", () => {
    expect(
      sanitiseGuideProgrammes("ch-1", "not-an-array" as never),
    ).toEqual([]);
    expect(sanitiseGuideProgrammes("ch-1", { 0: {} } as never)).toEqual([]);
    expect(sanitiseGuideProgrammes("ch-1", 42 as never)).toEqual([]);
  });
});

// ── availableGuideDays: exact fast path ──────────────────────────

describe("availableGuideDays (0.11.11 W3 fast path)", () => {
  /** The naive loop, as it was before the optimisation. */
  function naive(
    programmesByChannel: ReadonlyMap<string, ReadonlyArray<GuideProgramme>>,
    nowMs: number,
  ): number[] {
    const earliest = startOfLocalDayMs(nowMs) - 7 * GUIDE_DAY_MS;
    const latest = startOfLocalDayMs(nowMs) + 14 * GUIDE_DAY_MS;
    const days = new Set<number>();
    for (const programmes of programmesByChannel.values()) {
      for (const programme of programmes) {
        const day = startOfLocalDayMs(programme.startMs);
        if (day >= earliest && day <= latest) days.add(day);
        const endDay = startOfLocalDayMs(programme.stopMs - 1);
        if (endDay >= earliest && endDay <= latest) days.add(endDay);
      }
    }
    return [...days].sort((a, b) => a - b);
  }

  function spanFixture(): Map<string, GuideProgramme[]> {
    // 5 days of hourly programmes + midnight-spanning programmes.
    const dayStart = startOfLocalDayMs(NOW);
    const map = new Map<string, GuideProgramme[]>();
    for (const id of ["1", "2"]) {
      const list: GuideProgramme[] = [];
      for (let d = -2; d <= 2; d++) {
        for (let h = 0; h < 24; h++) {
          const start = dayStart + d * GUIDE_DAY_MS + h * HOUR;
          list.push({
            channelId: id,
            startMs: start,
            stopMs: start + HOUR,
            title: `P${d}:${h}`,
          });
        }
      }
      // Spans midnight exactly, and a 26-hour programme.
      list.push({
        channelId: id,
        startMs: dayStart - HOUR,
        stopMs: dayStart + HOUR,
        title: "Spanner",
      });
      list.push({
        channelId: id,
        startMs: dayStart,
        stopMs: dayStart + 26 * HOUR,
        title: "Long",
      });
      list.sort((a, b) => a.startMs - b.startMs || a.stopMs - b.stopMs);
      map.set(id, list);
    }
    return map;
  }

  it("matches the naive loop on sorted multi-day input", () => {
    const fixture = spanFixture();
    expect(availableGuideDays(fixture, NOW)).toEqual(naive(fixture, NOW));
  });

  it("matches the naive loop on unsorted input", () => {
    const fixture = spanFixture();
    const shuffled = new Map<string, GuideProgramme[]>();
    for (const [id, list] of fixture) {
      shuffled.set(id, [...list].reverse());
    }
    expect(availableGuideDays(shuffled, NOW)).toEqual(naive(shuffled, NOW));
  });

  it("matches the naive loop on random spans", () => {
    // Deterministic pseudo-random spans across ±10 days.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const dayStart = startOfLocalDayMs(NOW);
    const map = new Map<string, GuideProgramme[]>();
    for (let c = 0; c < 20; c++) {
      const list: GuideProgramme[] = [];
      for (let i = 0; i < 200; i++) {
        const start =
          dayStart +
          Math.floor(rand() * 20 - 10) * GUIDE_DAY_MS +
          Math.floor(rand() * 24) * HOUR +
          Math.floor(rand() * 3600) * 1000;
        const dur = (1 + Math.floor(rand() * 5)) * HOUR;
        list.push({
          channelId: String(c),
          startMs: start,
          stopMs: start + dur,
          title: `R${i}`,
        });
      }
      list.sort((a, b) => a.startMs - b.startMs);
      map.set(String(c), list);
    }
    expect(availableGuideDays(map, NOW)).toEqual(naive(map, NOW));
  });

  it("matches the naive loop around DST transitions", () => {
    // Europe/Dublin 2026: spring forward 29 Mar, fall back 25 Oct.
    // The test asserts equivalence in whatever zone the runner uses;
    // the naive loop is the oracle, so zone differences cancel.
    for (const pivot of [
      Date.UTC(2026, 2, 29, 12, 0, 0),
      Date.UTC(2026, 9, 25, 12, 0, 0),
    ]) {
      const dayStart = startOfLocalDayMs(pivot);
      const list: GuideProgramme[] = [];
      for (let h = 0; h < 72; h++) {
        const start = dayStart - 24 * HOUR + h * HOUR;
        list.push({
          channelId: "1",
          startMs: start,
          stopMs: start + HOUR,
          title: `H${h}`,
        });
      }
      const map = new Map([["1", list]]);
      expect(availableGuideDays(map, pivot)).toEqual(naive(map, pivot));
    }
  });
});

// ── TvGuideView wiring (source-text pattern, repo convention) ────

describe("TvGuideView.astro — 0.11.11 W3 wiring", () => {
  const src = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src/components/couch/TvGuideView.astro",
    ),
    "utf8",
  );

  it("loads programmes through the indexed batch loader, not per-channel resolveTvgId", () => {
    expect(src).toContain("loadGuideProgrammes(allChannels, state, overrides)");
    expect(src).toContain('from "@/scripts/lib/livetv-guide-data.ts"');
    expect(src).not.toContain("resolveTvgId(channel, overrides");
  });

  it("serves On Now rows from the revision cache", () => {
    expect(src).toContain("nowNextCache.getRows({");
    expect(src).toContain("revision: gridRevision,");
    expect(src).toContain("createNowNextRowsCache()");
  });

  it("collects Tonight items through the evening-window collector over the scoped set", () => {
    // W4 §12 scope line, preserved: the scoped channel set
    // (visibleChannels), not the full catalogue.
    expect(src).toContain("collectTonightItems(visibleChannels, programmesByChannel, {");
    expect(src).not.toContain("collectTonightItems(allChannels,");
    expect(src).toContain("searchNeedle: searchQuery.trim().toLowerCase(),");
    expect(src).not.toContain("tonightChannelFor(channel)");
  });

  it("wraps finishActivation: flag reset + honest error + bounded retry", () => {
    const fn = src.slice(src.indexOf("function finishActivation()"));
    const body = fn.slice(0, fn.indexOf("function maybeFinishActivation()"));
    expect(body).toContain("try {");
    expect(body).toContain("} catch (error) {");
    expect(body).toContain("activationFinished = false;");
    expect(body).toContain("guideDataError = error;");
    expect(body).toContain("showEmpty(GUIDE_LOAD_ERROR_TEXT);");
    expect(body).toContain("activationErrorRetries < 2");
    expect(body).toContain("scheduleCatalogRetry(1)");
  });

  it("wraps the EPG handler: playlist filter + try/catch + error clearing", () => {
    const handler = src.slice(
      src.indexOf("document.addEventListener(EPG_LOADED_EVENT"),
    );
    const body = handler.slice(
      0,
      handler.indexOf("document.addEventListener(EPG_SOURCE_STATUS_EVENT"),
    );
    expect(body).toContain("detail.playlistId !== playlistId");
    expect(body).toContain("try {");
    expect(body).toContain("} catch (error) {");
    expect(body).toContain("guideDataError = null;");
    expect(body).toContain("programmesByChannel.size === 0");
  });

  it("tracks the W4 loadFailed signal inputs and defines no second classifier", () => {
    // The two genuine-failure conditions live in the Guide script;
    // W4's guideDataState classifier consumes them via
    // resolveGuideLoadFailed (see livetv-guide-data.ts).
    expect(src).toContain("let guideDataError = null;");
    expect(src).toContain("let epgLoadFailed = false;");
    expect(src).toContain("epgLoadFailed = allFailed;");
    expect(src).toContain(
      "document.addEventListener(EPG_SOURCE_STATUS_EVENT",
    );
    expect(src).toContain('source.status === "error"');
    // No second classifier, no competing state vocabulary.
    expect(src).not.toContain("classifyGuideDataState");
    expect(src).not.toContain("data-guide-data-state");
    expect(src).not.toContain("guideDataState =");
  });
});
