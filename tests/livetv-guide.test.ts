import { describe, it, expect } from "vitest";
import {
  addGuideDays,
  availableGuideDays,
  guideCellViewModel,
  jumpToNowWindow,
  normaliseCategoryLabel,
  programmesForGuideDay,
  sanitiseGuideProgrammes,
  stableGuideSelection,
  GUIDE_DAY_MS,
} from "@/scripts/lib/livetv-guide";
import {
  catchupBadgeLabel,
  epgTimeWindow,
  catchupActionForProgramme,
} from "@/scripts/lib/couch-livetv-epg";
import { guideProgrammeKey } from "@/scripts/lib/livetv-state";

// Fixed clock: 2026-11-10 20:00:00 UTC. Day math uses the local zone;
// tests assert relative behaviour (spans, ordering, containment).
const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const HOUR = 3_600_000;
const DAY_START = Date.UTC(2026, 10, 10, 0, 0, 0);

const catchupChannel = { tvArchive: 1, tvArchiveDuration: 7 };
const plainChannel = {};

describe("sanitiseGuideProgrammes", () => {
  it("keeps valid programmes sorted by start", () => {
    const cleaned = sanitiseGuideProgrammes("ch-1", [
      { start: NOW + 2 * HOUR, stop: NOW + 3 * HOUR, title: "Late" },
      { start: NOW, stop: NOW + HOUR, title: "First" },
      { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: "Second" },
    ]);
    expect(cleaned.map((p) => p.title)).toEqual(["First", "Second", "Late"]);
  });

  it("drops missing / non-finite / inverted times instead of crashing", () => {
    const cleaned = sanitiseGuideProgrammes("ch-1", [
      { start: NOW, stop: NOW + HOUR, title: "Good" },
      { title: "No times at all" },
      { start: "soon", stop: NOW + HOUR, title: "String start" },
      { start: NOW, stop: NOW, title: "Empty span" },
      { start: NOW + HOUR, stop: NOW, title: "Inverted" },
      null,
      undefined,
    ] as never);
    expect(cleaned.map((p) => p.title)).toEqual(["Good"]);
  });

  it("never invents a title: untitled programmes get the honest fallback", () => {
    const cleaned = sanitiseGuideProgrammes("ch-1", [
      { start: NOW, stop: NOW + HOUR },
      { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: "   " },
    ]);
    expect(cleaned.map((p) => p.title)).toEqual([
      "No programme information",
      "No programme information",
    ]);
  });

  it("keeps rawStart/rawStop for catch-up URL math", () => {
    const cleaned = sanitiseGuideProgrammes("ch-1", [
      { start: NOW, stop: NOW + HOUR, title: "T", rawStart: NOW - 5000, rawStop: NOW + HOUR - 5000 },
    ]);
    expect(cleaned[0]?.rawStartMs).toBe(NOW - 5000);
    expect(cleaned[0]?.rawStopMs).toBe(NOW + HOUR - 5000);
  });

  it("returns [] for null input", () => {
    expect(sanitiseGuideProgrammes("ch-1", null)).toEqual([]);
    expect(sanitiseGuideProgrammes("ch-1", undefined)).toEqual([]);
  });
});

describe("programmesForGuideDay", () => {
  const day = sanitiseGuideProgrammes("ch-1", [
    { start: DAY_START - HOUR, stop: DAY_START + HOUR, title: "Spans midnight in" },
    { start: DAY_START + 2 * HOUR, stop: DAY_START + 3 * HOUR, title: "Morning" },
    { start: DAY_START + 23 * HOUR, stop: DAY_START + 25 * HOUR, title: "Spans midnight out" },
    { start: DAY_START + 26 * HOUR, stop: DAY_START + 27 * HOUR, title: "Next day only" },
  ]);

  it("includes programmes overlapping the day, including midnight spanners", () => {
    const titles = programmesForGuideDay(day, DAY_START).map((p) => p.title);
    expect(titles).toEqual(["Spans midnight in", "Morning", "Spans midnight out"]);
  });
});

describe("availableGuideDays / addGuideDays", () => {
  it("offers only days that actually have programmes", () => {
    const byChannel = new Map([
      ["ch-1", sanitiseGuideProgrammes("ch-1", [
        { start: DAY_START + HOUR, stop: DAY_START + 2 * HOUR, title: "Today" },
        { start: DAY_START + 3 * GUIDE_DAY_MS + HOUR, stop: DAY_START + 3 * GUIDE_DAY_MS + 2 * HOUR, title: "In 3 days" },
      ])],
      ["ch-2", sanitiseGuideProgrammes("ch-2", [
        { start: DAY_START + GUIDE_DAY_MS + HOUR, stop: DAY_START + GUIDE_DAY_MS + 2 * HOUR, title: "Tomorrow" },
      ])],
    ]);
    // availableGuideDays works off local-midnight day starts; compare
    // by day offset from today rather than absolute zone values.
    const days = availableGuideDays(byChannel, NOW);
    expect(days.length).toBe(3);
    expect(days[0]).toBeLessThan(days[1]);
    expect(days[1]).toBeLessThan(days[2]);
    expect(days[1] - days[0]).toBe(GUIDE_DAY_MS);
    expect(days[2] - days[1]).toBe(2 * GUIDE_DAY_MS);
  });

  it("returns [] when there is no EPG at all", () => {
    expect(availableGuideDays(new Map(), NOW)).toEqual([]);
  });

  it("addGuideDays steps whole local days", () => {
    expect(addGuideDays(DAY_START, 1) - DAY_START).toBe(GUIDE_DAY_MS);
    expect(addGuideDays(DAY_START, -2)).toBe(DAY_START - 2 * GUIDE_DAY_MS);
  });
});

describe("jumpToNowWindow", () => {
  it("lands now inside the window with an hour-aligned start", () => {
    const { viewStartMs, viewEndMs } = jumpToNowWindow(NOW, 6);
    expect(viewEndMs - viewStartMs).toBe(6 * HOUR);
    expect(viewStartMs % HOUR).toBe(0);
    expect(viewStartMs).toBeLessThanOrEqual(NOW);
    expect(viewEndMs).toBeGreaterThan(NOW);
    // Now sits one hour into the window.
    expect(NOW - viewStartMs).toBe(HOUR);
  });
});

describe("stableGuideSelection", () => {
  const list = sanitiseGuideProgrammes("ch-1", [
    { start: NOW - 2 * HOUR, stop: NOW - HOUR, title: "Past" },
    { start: NOW - HOUR, stop: NOW + HOUR, title: "Now" },
    { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: "Next" },
  ]);

  it("keeps the previous selection when it still exists after a refresh", () => {
    const key = guideProgrammeKey("ch-1", NOW + HOUR);
    expect(stableGuideSelection(key, list, NOW)).toBe(key);
  });

  it("falls back to the programme on now when the selection vanished", () => {
    expect(stableGuideSelection("ch-1@1", list, NOW)).toBe(
      guideProgrammeKey("ch-1", NOW - HOUR),
    );
  });

  it("falls back to the first programme when nothing is on now", () => {
    const future = sanitiseGuideProgrammes("ch-1", [
      { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: "Later" },
      { start: NOW + 2 * HOUR, stop: NOW + 3 * HOUR, title: "Even later" },
    ]);
    expect(stableGuideSelection(null, future, NOW)).toBe(
      guideProgrammeKey("ch-1", NOW + HOUR),
    );
  });

  it("returns null for an empty day", () => {
    expect(stableGuideSelection(null, [], NOW)).toBeNull();
  });
});

describe("epgTimeWindow (horizontal virtualisation)", () => {
  // One programme per hour across two days, sorted.
  const row = Array.from({ length: 48 }, (_, i) => ({
    startMs: DAY_START + i * HOUR,
    stopMs: DAY_START + (i + 1) * HOUR,
  }));

  it("windows to the visible 6-hour slice plus overscan", () => {
    const window = epgTimeWindow({
      programmes: row,
      viewStartMs: DAY_START + 10 * HOUR,
      viewEndMs: DAY_START + 16 * HOUR,
    });
    // 10:00–16:00 is indices 10..15, plus 1 overscan each side.
    expect(window.startIndex).toBe(9);
    expect(window.endIndex).toBe(17);
    expect(window.total).toBe(48);
  });

  it("clamps overscan at the edges of the row", () => {
    const window = epgTimeWindow({
      programmes: row,
      viewStartMs: DAY_START,
      viewEndMs: DAY_START + 2 * HOUR,
    });
    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe(3);
  });

  it("returns an empty window for an empty row or an inverted window", () => {
    expect(
      epgTimeWindow({ programmes: [], viewStartMs: NOW, viewEndMs: NOW + HOUR }),
    ).toEqual({ startIndex: 0, endIndex: 0, total: 0 });
    expect(
      epgTimeWindow({ programmes: row, viewStartMs: NOW + HOUR, viewEndMs: NOW }),
    ).toEqual({ startIndex: 0, endIndex: 0, total: 48 });
  });
});

describe("catch-up gating in the Guide", () => {
  it("unsupported channel: no action, no badge, ever", () => {
    const past = { channelId: "ch-1", startMs: NOW - 2 * HOUR, stopMs: NOW - HOUR, title: "Past" };
    expect(
      catchupActionForProgramme({ channel: plainChannel, startMs: past.startMs, stopMs: past.stopMs, nowMs: NOW }),
    ).toBe("none");
    const vm = guideCellViewModel(past, plainChannel, NOW);
    expect(vm.catchupAction).toBe("none");
    expect(vm.badge).toBeNull();
    expect(vm.canCatchup).toBe(false);
  });

  it("supported channel, past programme inside the archive: replay + Catch-up badge", () => {
    const past = { channelId: "ch-1", startMs: NOW - 2 * HOUR, stopMs: NOW - HOUR, title: "Past" };
    const vm = guideCellViewModel(past, catchupChannel, NOW);
    expect(vm.catchupAction).toBe("replay");
    expect(vm.badge).toBe("Catch-up");
    expect(vm.canCatchup).toBe(true);
    expect(vm.watchLive).toBe(false);
    expect(vm.state).toBe("past");
  });

  it("supported channel, live programme: watch-from-start + Restart badge", () => {
    const now = { channelId: "ch-1", startMs: NOW - HOUR, stopMs: NOW + HOUR, title: "Now" };
    const vm = guideCellViewModel(now, catchupChannel, NOW);
    expect(vm.catchupAction).toBe("watch-from-start");
    expect(vm.badge).toBe("Restart");
    expect(vm.canCatchup).toBe(true);
    expect(vm.watchLive).toBe(true);
  });

  it("future programme: no catch-up even on a supported channel", () => {
    const future = { channelId: "ch-1", startMs: NOW + HOUR, stopMs: NOW + 2 * HOUR, title: "Next" };
    expect(guideCellViewModel(future, catchupChannel, NOW).catchupAction).toBe("none");
  });

  it("past programme outside the archive window: no catch-up", () => {
    const old = { channelId: "ch-1", startMs: NOW - 8 * 24 * HOUR, stopMs: NOW - 8 * 24 * HOUR + HOUR, title: "Old" };
    expect(guideCellViewModel(old, catchupChannel, NOW).catchupAction).toBe("none");
  });

  it("catchupBadgeLabel maps actions to badge text and none to null", () => {
    expect(catchupBadgeLabel("replay")).toBe("Catch-up");
    expect(catchupBadgeLabel("watch-from-start")).toBe("Restart");
    expect(catchupBadgeLabel("none")).toBeNull();
  });
});

describe("guideCellViewModel live state", () => {
  it("marks the current programme now with progress, and future ones upcoming", () => {
    const now = { channelId: "ch-1", startMs: NOW - HOUR, stopMs: NOW + HOUR, title: "Now" };
    const vm = guideCellViewModel(now, plainChannel, NOW);
    expect(vm.state).toBe("now");
    expect(vm.progress).toBe(0.5);
    expect(vm.watchLive).toBe(true);
    const future = { channelId: "ch-1", startMs: NOW + HOUR, stopMs: NOW + 2 * HOUR, title: "Next" };
    const fvm = guideCellViewModel(future, plainChannel, NOW);
    expect(fvm.state).toBe("upcoming");
    expect(fvm.progress).toBe(0);
    expect(fvm.watchLive).toBe(false);
  });
});

describe("normaliseCategoryLabel", () => {
  it("re-exports the canonical W1 rule from livetv-data", () => {
    expect(normaliseCategoryLabel("  Movies   &  TV  ")).toBe("Movies & TV");
    expect(normaliseCategoryLabel("UK | Sports")).toBe("Sports");
    expect(normaliseCategoryLabel("Movies FHD")).toBe("Movies");
    expect(normaliseCategoryLabel("")).toBe("Uncategorized");
    expect(normaliseCategoryLabel(null)).toBe("Uncategorized");
    expect(normaliseCategoryLabel("Documentary")).toBe("Documentary");
  });
});
