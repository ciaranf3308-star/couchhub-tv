/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import {
  programmeState,
  programmeProgress,
  epgTimeRangeLabel,
  epgCellGeometry,
  epgRowWindow,
  channelIndexById,
  stepChannel,
  previousChannelId,
  zapChannelForDigits,
  catchupActionForProgramme,
  livetvOsdActionForKey,
  isOsdOwnedKey,
} from "@/scripts/lib/couch-livetv-epg";
import { computeNowNext, programmesForDay } from "@/scripts/lib/now-next";
import { resolveZapTarget } from "@/scripts/tv/osd-zap";
import { stepChannelIndex } from "@/scripts/lib/channel-step";

// Fixed clock so time math is deterministic: 2026-11-10 20:00:00 UTC.
const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const HOUR = 3_600_000;

describe("programmeState / programmeProgress", () => {
  it("marks a programme containing now as now", () => {
    expect(programmeState(NOW - HOUR, NOW + HOUR, NOW)).toBe("now");
    expect(programmeState(NOW, NOW + HOUR, NOW)).toBe("now");
  });

  it("marks ended programmes past and future ones upcoming", () => {
    expect(programmeState(NOW - 2 * HOUR, NOW - HOUR, NOW)).toBe("past");
    expect(programmeState(NOW, NOW, NOW)).toBe("past");
    expect(programmeState(NOW + HOUR, NOW + 2 * HOUR, NOW)).toBe("upcoming");
  });

  it("progress is 0 at start, 0.5 halfway, 1 at end, clamped outside", () => {
    expect(programmeProgress(NOW - HOUR, NOW + HOUR, NOW)).toBe(0.5);
    expect(programmeProgress(NOW, NOW + HOUR, NOW)).toBe(0);
    expect(programmeProgress(NOW - HOUR, NOW, NOW)).toBe(1);
    expect(programmeProgress(NOW + HOUR, NOW + 2 * HOUR, NOW)).toBe(0);
    expect(programmeProgress(NOW - 2 * HOUR, NOW - HOUR, NOW)).toBe(1);
  });

  it("progress is 0 for an empty or inverted span, never NaN", () => {
    expect(programmeProgress(NOW, NOW, NOW)).toBe(0);
    expect(programmeProgress(NOW + HOUR, NOW, NOW)).toBe(0);
  });
});

describe("epgTimeRangeLabel", () => {
  it("formats a range with an en-dash between start and stop", () => {
    const label = epgTimeRangeLabel(NOW, NOW + HOUR, "en-IE");
    expect(label).toContain("–");
    expect(label).toMatch(/20:00/);
    expect(label).toMatch(/21:00/);
  });
});

describe("epgCellGeometry", () => {
  const view = { viewStartMs: NOW - HOUR, pxPerHour: 200, trackWidthPx: 1200 };

  it("places a programme at its time offset with width by duration", () => {
    const g = epgCellGeometry({ startMs: NOW, stopMs: NOW + HOUR, ...view });
    expect(g.leftPx).toBe(200);
    expect(g.widthPx).toBe(200);
  });

  it("clamps a programme starting before the window to the left edge", () => {
    const g = epgCellGeometry({
      startMs: NOW - 2 * HOUR,
      stopMs: NOW + HOUR,
      ...view,
    });
    expect(g.leftPx).toBe(0);
    expect(g.widthPx).toBe(400);
  });

  it("clamps a programme running past the window to the right edge", () => {
    const g = epgCellGeometry({
      startMs: NOW + 4 * HOUR,
      stopMs: NOW + 8 * HOUR,
      ...view,
    });
    expect(g.leftPx).toBe(1000);
    expect(g.widthPx).toBe(200);
  });

  it("never returns a negative width or position for an out-of-window programme", () => {
    const g = epgCellGeometry({
      startMs: NOW + 9 * HOUR,
      stopMs: NOW + 10 * HOUR,
      ...view,
    });
    expect(g.leftPx).toBe(1200);
    expect(g.widthPx).toBe(2);
  });
});

describe("epgRowWindow (large channel counts)", () => {
  it("renders only the visible window plus overscan for 10,000 channels", () => {
    const w = epgRowWindow({
      totalRows: 10_000,
      rowHeightPx: 64,
      scrollTopPx: 64_000,
      viewportHeightPx: 640,
      overscanRows: 2,
    });
    expect(w.totalRows).toBe(10_000);
    expect(w.endIndex - w.startIndex).toBeLessThan(40);
    expect(w.startRow).toBeLessThanOrEqual(1000);
    expect(w.endRow).toBeGreaterThanOrEqual(1009);
    expect(w.topSpacer + w.bottomSpacer).toBeGreaterThan(0);
  });

  it("renders everything when the guide is short", () => {
    const w = epgRowWindow({
      totalRows: 5,
      rowHeightPx: 64,
      scrollTopPx: 0,
      viewportHeightPx: 640,
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(5);
    expect(w.bottomSpacer).toBe(0);
  });

  it("renders nothing for an empty guide", () => {
    const w = epgRowWindow({
      totalRows: 0,
      rowHeightPx: 64,
      scrollTopPx: 0,
      viewportHeightPx: 640,
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(0);
    expect(w.totalRows).toBe(0);
  });
});

describe("now/next math (reused now-next.ts)", () => {
  it("finds the current and next programme for a channel", () => {
    // Programmes are keyed by lower-cased tvg-id (see epg-data.js).
    const programmes = new Map([
      [
        "ch-1",
        [
          { start: NOW - HOUR, stop: NOW + HOUR, title: "Evening News" },
          { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: "Late Film" },
        ],
      ],
    ]);
    const slot = computeNowNext(
      programmes,
      { id: "ch-1", tvgId: "ch-1" },
      "playlist-1",
      NOW,
    );
    expect(slot.current?.title).toBe("Evening News");
    expect(slot.current?.progress).toBeCloseTo(0.5);
    expect(slot.next?.title).toBe("Late Film");
  });

  it("programmesForDay keeps only programmes overlapping the day", () => {
    const dayStart = Date.UTC(2026, 10, 10, 0, 0, 0);
    const list = programmesForDay(
      [
        { start: dayStart - HOUR, stop: dayStart + HOUR, title: "Late Night" },
        { start: dayStart + 10 * HOUR, stop: dayStart + 11 * HOUR, title: "Midday" },
        { start: dayStart + 25 * HOUR, stop: dayStart + 26 * HOUR, title: "Tomorrow" },
      ],
      dayStart,
    );
    expect(list.map((p) => p.title)).toEqual(["Late Night", "Midday"]);
  });
});

describe("channel selection", () => {
  const channels = [
    { id: 101, chno: 5 },
    { id: 102, chno: 12 },
    { id: 103, chno: 7 },
  ];

  it("channelIndexById finds by id and -1 when absent", () => {
    expect(channelIndexById(channels, 102)).toBe(1);
    expect(channelIndexById(channels, 999)).toBe(-1);
    expect(channelIndexById(channels, null)).toBe(-1);
    expect(channelIndexById([], 101)).toBe(-1);
  });

  it("stepChannel wraps around both ends (shared channel-step math)", () => {
    expect(stepChannel(2, 3, 1)).toBe(0);
    expect(stepChannel(0, 3, -1)).toBe(2);
    expect(stepChannel(1, 3, 1)).toBe(2);
    expect(stepChannel(-1, 3, 1)).toBe(0);
    expect(stepChannel(-1, 3, -1)).toBe(2);
    expect(stepChannel(0, 0, 1)).toBeNull();
    expect(stepChannelIndex(2, 3, 1)).toBe(0);
  });

  it("previousChannelId returns the last channel, null when none or same", () => {
    expect(previousChannelId(102, 101)).toBe(101);
    expect(previousChannelId(102, null)).toBeNull();
    expect(previousChannelId(102, undefined)).toBeNull();
    expect(previousChannelId(102, 102)).toBeNull();
    expect(previousChannelId(null, 101)).toBe(101);
  });

  it("digit zap: exact channel number wins, else 1-based position", () => {
    expect(zapChannelForDigits("12", channels)?.id).toBe(102);
    expect(zapChannelForDigits("2", channels)?.id).toBe(102);
    expect(zapChannelForDigits("99", channels)).toBeNull();
    expect(zapChannelForDigits("", channels)).toBeNull();
    // The shared resolver agrees with the wrapper.
    expect(resolveZapTarget("5", channels)?.id).toBe(101);
  });
});

describe("catchupActionForProgramme", () => {
  const archive = { tvArchive: 1, tvArchiveDuration: 7 };
  const plain = {};

  it("offers replay for a past programme on an archive channel", () => {
    expect(
      catchupActionForProgramme({
        channel: archive,
        startMs: NOW - 2 * HOUR,
        stopMs: NOW - HOUR,
        nowMs: NOW,
      }),
    ).toBe("replay");
  });

  it("offers watch-from-start for a live programme on an archive channel", () => {
    expect(
      catchupActionForProgramme({
        channel: archive,
        startMs: NOW - HOUR,
        stopMs: NOW + HOUR,
        nowMs: NOW,
      }),
    ).toBe("watch-from-start");
  });

  it("offers nothing for upcoming programmes, even on archive channels", () => {
    expect(
      catchupActionForProgramme({
        channel: archive,
        startMs: NOW + HOUR,
        stopMs: NOW + 2 * HOUR,
        nowMs: NOW,
      }),
    ).toBe("none");
  });

  it("offers nothing when the channel has no catch-up support", () => {
    expect(
      catchupActionForProgramme({
        channel: plain,
        startMs: NOW - 2 * HOUR,
        stopMs: NOW - HOUR,
        nowMs: NOW,
      }),
    ).toBe("none");
  });

  it("offers nothing when the programme predates the archive window", () => {
    expect(
      catchupActionForProgramme({
        channel: archive,
        startMs: NOW - 8 * 24 * HOUR,
        stopMs: NOW - 8 * 24 * HOUR + HOUR,
        nowMs: NOW,
      }),
    ).toBe("none");
  });
});

describe("livetvOsdActionForKey", () => {
  it("maps tuning, transport and OSD keys to actions", () => {
    expect(livetvOsdActionForKey("]")).toBe("channel-up");
    expect(livetvOsdActionForKey("[")).toBe("channel-down");
    expect(livetvOsdActionForKey("\\")).toBe("previous-channel");
    expect(livetvOsdActionForKey(" ")).toBe("pause-toggle");
    expect(livetvOsdActionForKey("m")).toBe("mute");
    expect(livetvOsdActionForKey("f")).toBe("fullscreen");
    expect(livetvOsdActionForKey("g")).toBe("guide");
    expect(livetvOsdActionForKey("c")).toBe("channels");
    expect(livetvOsdActionForKey("v")).toBe("favourites");
    expect(livetvOsdActionForKey("h")).toBe("home");
    expect(livetvOsdActionForKey("Escape")).toBe("dismiss");
  });

  it("is case-insensitive for letter keys and null for unknown keys", () => {
    expect(livetvOsdActionForKey("G")).toBe("guide");
    expect(livetvOsdActionForKey("z")).toBeNull();
    expect(livetvOsdActionForKey(null)).toBeNull();
    expect(livetvOsdActionForKey(undefined)).toBeNull();
    expect(livetvOsdActionForKey("")).toBeNull();
  });

  it("only the OSD-owned keys are intercepted by the OSD listener", () => {
    expect(isOsdOwnedKey("g")).toBe(true);
    expect(isOsdOwnedKey("G")).toBe(true);
    expect(isOsdOwnedKey("Escape")).toBe(true);
    // Tuning / transport already have a global handler in stream.ts.
    expect(isOsdOwnedKey("]")).toBe(false);
    expect(isOsdOwnedKey(" ")).toBe(false);
    expect(isOsdOwnedKey("m")).toBe(false);
    expect(isOsdOwnedKey("z")).toBe(false);
  });
});
