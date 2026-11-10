/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import {
  OSD_AUTO_HIDE_MS,
  stepHighlight,
  confirmHighlight,
  tuneToChannel,
  previousChannelId,
  previousChannelTarget,
  toggleFavouriteInSet,
  errorKeyForFailureKind,
  streamToKeepOnFailure,
  retryTarget,
  supportsSeek,
  nowNextProgress,
  type PlaybackChannel,
  type PlaybackEngine,
} from "@/scripts/lib/livetv-playback";

const channels: PlaybackChannel[] = [
  { id: 1, name: "One", chno: 1 },
  { id: 2, name: "Two", chno: 2 },
  { id: 3, name: "Three", chno: 3 },
];

function fakeEngine(): PlaybackEngine & { tuned: Array<string | number> } {
  const tuned: Array<string | number> = [];
  return { tuned, tune: (id) => tuned.push(id) };
}

describe("OSD_AUTO_HIDE_MS", () => {
  it("is a short few-seconds delay", () => {
    expect(OSD_AUTO_HIDE_MS).toBeGreaterThanOrEqual(3000);
    expect(OSD_AUTO_HIDE_MS).toBeLessThanOrEqual(8000);
  });
});

describe("stepHighlight — highlight never tunes", () => {
  it("steps to the adjacent channel with wrap-around", () => {
    expect(stepHighlight(channels, 1, 1)).toBe(2);
    expect(stepHighlight(channels, 3, 1)).toBe(1);
    expect(stepHighlight(channels, 1, -1)).toBe(3);
    expect(stepHighlight(channels, 2, -1)).toBe(1);
  });

  it("starts at the first/last channel when nothing is highlighted", () => {
    expect(stepHighlight(channels, null, 1)).toBe(1);
    expect(stepHighlight(channels, null, -1)).toBe(3);
    expect(stepHighlight(channels, undefined, 1)).toBe(1);
  });

  it("returns null for an empty list and never calls the engine", () => {
    const engine = fakeEngine();
    expect(stepHighlight([], 1, 1)).toBeNull();
    expect(engine.tuned).toEqual([]);
  });

  it("stepping alone performs no tune", () => {
    const engine = fakeEngine();
    stepHighlight(channels, 1, 1);
    stepHighlight(channels, 2, 1);
    expect(engine.tuned).toEqual([]);
  });
});

describe("confirmHighlight / tuneToChannel", () => {
  it("confirmHighlight returns the highlighted id and nothing else tunes", () => {
    expect(confirmHighlight(2)).toBe(2);
    expect(confirmHighlight(null)).toBeNull();
    expect(confirmHighlight(undefined)).toBeNull();
  });

  it("tuneToChannel tunes exactly once through the engine seam", () => {
    const engine = fakeEngine();
    expect(tuneToChannel(engine, 2)).toBe(true);
    expect(engine.tuned).toEqual([2]);
  });

  it("tuneToChannel with no id tunes nothing", () => {
    const engine = fakeEngine();
    expect(tuneToChannel(engine, null)).toBe(false);
    expect(tuneToChannel(engine, undefined)).toBe(false);
    expect(engine.tuned).toEqual([]);
  });

  it("highlight-then-confirm tunes only the confirmed channel", () => {
    const engine = fakeEngine();
    let highlighted = stepHighlight(channels, 1, 1); // 2
    highlighted = stepHighlight(channels, highlighted, 1); // 3
    const target = confirmHighlight(highlighted);
    tuneToChannel(engine, target);
    expect(engine.tuned).toEqual([3]);
  });
});

describe("previous channel", () => {
  it("previousChannelId returns the last-played id", () => {
    expect(previousChannelId(2, 1)).toBe(1);
  });

  it("previousChannelId is null with no previous or when it is the current channel", () => {
    expect(previousChannelId(2, null)).toBeNull();
    expect(previousChannelId(2, undefined)).toBeNull();
    expect(previousChannelId(2, 2)).toBeNull();
  });

  it("previousChannelTarget resolves the tune target or null", () => {
    expect(previousChannelTarget(2, 1)).toBe(1);
    expect(previousChannelTarget(2, null)).toBeNull();
    expect(previousChannelTarget(2, 2)).toBeNull();
  });
});

describe("toggleFavouriteInSet", () => {
  it("adds then removes, returning the new state", () => {
    const favs = new Set<string | number>();
    expect(toggleFavouriteInSet(favs, 2)).toBe(true);
    expect(favs.has(2)).toBe(true);
    expect(toggleFavouriteInSet(favs, 2)).toBe(false);
    expect(favs.has(2)).toBe(false);
  });
});

describe("failure handling — previous stream is kept", () => {
  it("errorKeyForFailureKind maps connection-limit to provider-lost", () => {
    expect(errorKeyForFailureKind("connection-limit")).toBe("provider-lost");
    expect(errorKeyForFailureKind("hevc")).toBe("stream-unavailable");
    expect(errorKeyForFailureKind("codec")).toBe("stream-unavailable");
    expect(errorKeyForFailureKind("parse")).toBe("stream-unavailable");
    expect(errorKeyForFailureKind(null)).toBe("stream-unavailable");
    expect(errorKeyForFailureKind("something-new")).toBe("stream-unavailable");
  });

  it("a failed tune to another channel keeps the tuned channel", () => {
    expect(streamToKeepOnFailure(3, 2)).toBe(2);
  });

  it("a failed tune of the current channel keeps nothing", () => {
    expect(streamToKeepOnFailure(2, 2)).toBeNull();
    expect(streamToKeepOnFailure(2, null)).toBeNull();
    expect(streamToKeepOnFailure(null, null)).toBeNull();
  });

  it("retryTarget prefers the failed channel, falls back to last working", () => {
    expect(retryTarget(3, 2)).toBe(3);
    expect(retryTarget(null, 2)).toBe(2);
    expect(retryTarget(undefined, 2)).toBe(2);
    expect(retryTarget(null, null)).toBeNull();
  });

  it("a failed tune never triggers a tune by itself", () => {
    const engine = fakeEngine();
    const keep = streamToKeepOnFailure(3, 2);
    expect(keep).toBe(2);
    expect(engine.tuned).toEqual([]);
  });
});

describe("live transport rules", () => {
  it("live has no seek", () => {
    expect(supportsSeek()).toBe(false);
  });

  it("nowNextProgress is 0.5 halfway and clamped outside", () => {
    const nowNext = { currentStartMs: 1000, currentStopMs: 3000 };
    expect(nowNextProgress(nowNext, 2000)).toBe(0.5);
    expect(nowNextProgress(nowNext, 1000)).toBe(0);
    expect(nowNextProgress(nowNext, 3000)).toBe(1);
    expect(nowNextProgress(nowNext, 9999)).toBe(1);
    expect(nowNextProgress(nowNext, 0)).toBe(0);
    expect(nowNextProgress({}, 2000)).toBe(0);
    expect(nowNextProgress({ currentStartMs: 2000, currentStopMs: 2000 }, 2000)).toBe(0);
  });
});

describe("dispatchTune posts the livetv:tune window event", () => {
  it("dispatches with the channel id in detail", async () => {
    const { dispatchTune } = await import("@/scripts/lib/livetv-playback");
    const seen: Array<unknown> = [];
    const handler = (ev: Event) => seen.push((ev as CustomEvent).detail);
    window.addEventListener("livetv:tune", handler);
    try {
      dispatchTune(7);
      expect(seen).toEqual([{ channelId: 7 }]);
    } finally {
      window.removeEventListener("livetv:tune", handler);
    }
    expect(vi.fn).toBeDefined();
  });
});
