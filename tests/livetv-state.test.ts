import { describe, it, expect } from "vitest";
import {
  LIVETV_STATE_STORAGE_KEY,
  closeOverlay,
  createLivetvState,
  enterBrowser,
  enterGuide,
  enterLanding,
  enterPlayback,
  exitBrowser,
  exitGuide,
  exitPlaybackToHome,
  exitPlaybackToLanding,
  guideProgrammeKey,
  highlightChannel,
  normaliseLivetvMode,
  openOverlay,
  parseLivetvModeParam,
  parseLivetvState,
  persistLivetvState,
  restoreLivetvState,
  serializeLivetvState,
  setGuideMode,
  startOfLocalDayMs,
  tuneTo,
} from "@/scripts/lib/livetv-state";

// Fixed clock: 2026-11-10 20:00:00 local-neutral (midnight math uses
// the local zone; tests only assert relative behaviour + round-trips).
const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const HOUR = 3_600_000;

/** Minimal in-memory Storage for persistence tests. */
function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("createLivetvState", () => {
  it("starts on the landing with nothing tuned and the Guide on today / On Now", () => {
    const state = createLivetvState(NOW);
    expect(state.mode).toBe("landing");
    expect(state.overlay).toBe("none");
    expect(state.tunedChannelId).toBeNull();
    expect(state.highlightedChannelId).toBeNull();
    expect(state.previousChannelId).toBeNull();
    expect(state.guideDateMs).toBe(startOfLocalDayMs(NOW));
    expect(state.guideChannelId).toBeNull();
    expect(state.guideProgrammeKey).toBeNull();
    expect(state.returnFocusKey).toBeNull();
    expect(state.guideMode).toBe("now");
    expect(state.browserFilter).toBeNull();
    expect(state.openSearch).toBe(false);
    expect(state.lastLandingCard).toBeNull();
    expect(state.guideReturnTo).toBe("landing");
  });

  it("never mutates its input: transitions return new objects", () => {
    const before = createLivetvState(NOW);
    const after = enterPlayback(before, "ch-1");
    expect(before.mode).toBe("landing");
    expect(before.tunedChannelId).toBeNull();
    expect(after.mode).toBe("playback");
    expect(after.tunedChannelId).toBe("ch-1");
  });
});

describe("highlight vs tuned — the core invariant", () => {
  it("highlightChannel changes ONLY the highlight, tuned untouched, always", () => {
    const playing = enterPlayback(createLivetvState(NOW), "ch-1");
    const browsed = highlightChannel(playing, "ch-2");
    expect(browsed.highlightedChannelId).toBe("ch-2");
    expect(browsed.tunedChannelId).toBe("ch-1");
    expect(browsed.mode).toBe("playback");
    // And again from the landing with nothing tuned.
    const home = highlightChannel(createLivetvState(NOW), "ch-9");
    expect(home.highlightedChannelId).toBe("ch-9");
    expect(home.tunedChannelId).toBeNull();
  });

  it("highlighting the tuned channel does not disturb previous", () => {
    const state = tuneTo(enterPlayback(createLivetvState(NOW), "ch-1"), "ch-2");
    const highlighted = highlightChannel(state, "ch-1");
    expect(highlighted.previousChannelId).toBe("ch-1");
    expect(highlighted.tunedChannelId).toBe("ch-2");
  });
});

describe("enterPlayback / tuneTo / previous channel", () => {
  it("enterPlayback tunes, highlights and clears overlays", () => {
    const state = openOverlay(createLivetvState(NOW), "browser");
    const playing = enterPlayback(state, "ch-1");
    expect(playing.mode).toBe("playback");
    expect(playing.tunedChannelId).toBe("ch-1");
    expect(playing.highlightedChannelId).toBe("ch-1");
    expect(playing.overlay).toBe("none");
    expect(playing.previousChannelId).toBeNull();
  });

  it("tuneTo records the old channel as previous", () => {
    const state = tuneTo(enterPlayback(createLivetvState(NOW), "ch-1"), "ch-2");
    expect(state.tunedChannelId).toBe("ch-2");
    expect(state.previousChannelId).toBe("ch-1");
    expect(state.mode).toBe("playback");
  });

  it("tuning to the channel already playing never clobbers previous with itself", () => {
    const state = tuneTo(enterPlayback(createLivetvState(NOW), "ch-1"), "ch-2");
    const again = tuneTo(state, "ch-2");
    expect(again.tunedChannelId).toBe("ch-2");
    expect(again.previousChannelId).toBe("ch-1");
  });

  it("a second retune moves previous forward", () => {
    let state = enterPlayback(createLivetvState(NOW), "ch-1");
    state = tuneTo(state, "ch-2");
    state = tuneTo(state, "ch-3");
    expect(state.tunedChannelId).toBe("ch-3");
    expect(state.previousChannelId).toBe("ch-2");
  });
});

describe("exitPlaybackToLanding (+ deprecated exitPlaybackToHome alias)", () => {
  it("returns to the landing keeping the tuned channel as last-watched", () => {
    const state = exitPlaybackToLanding(
      tuneTo(enterPlayback(createLivetvState(NOW), "ch-1"), "ch-2"),
    );
    expect(state.mode).toBe("landing");
    expect(state.overlay).toBe("none");
    expect(state.tunedChannelId).toBe("ch-2");
    expect(state.previousChannelId).toBe("ch-1");
    expect(state.highlightedChannelId).toBe("ch-2");
  });

  it("the deprecated alias behaves identically", () => {
    const state = exitPlaybackToHome(
      tuneTo(enterPlayback(createLivetvState(NOW), "ch-1"), "ch-2"),
    );
    expect(state.mode).toBe("landing");
    expect(state.tunedChannelId).toBe("ch-2");
  });
});

describe("enterLanding", () => {
  it("returns to the landing, keeping tuned / highlight / guide position", () => {
    const guide = enterGuide(enterPlayback(createLivetvState(NOW), "ch-1"), "k");
    const landed = enterLanding(guide);
    expect(landed.mode).toBe("landing");
    expect(landed.overlay).toBe("none");
    expect(landed.tunedChannelId).toBe("ch-1");
    expect(landed.guideChannelId).toBe("ch-1");
    expect(landed.returnFocusKey).toBe("k");
  });
});

describe("enterBrowser / exitBrowser", () => {
  it("enterBrowser opens with a filter + openSearch + return focus key", () => {
    const state = enterBrowser(
      enterPlayback(createLivetvState(NOW), "ch-1"),
      { kind: "category", value: "sports" },
      true,
      "livetv:landing:hero",
    );
    expect(state.mode).toBe("browser");
    expect(state.browserFilter).toEqual({ kind: "category", value: "sports" });
    expect(state.openSearch).toBe(true);
    expect(state.returnFocusKey).toBe("livetv:landing:hero");
    expect(state.tunedChannelId).toBe("ch-1");
  });

  it("enterBrowser with no arguments keeps the current filter / flags", () => {
    const state = enterBrowser(createLivetvState(NOW));
    expect(state.mode).toBe("browser");
    expect(state.browserFilter).toBeNull();
    expect(state.openSearch).toBe(false);
  });

  it("enterBrowser with an explicit null filter clears it", () => {
    const filtered = enterBrowser(createLivetvState(NOW), {
      kind: "favourites",
    });
    const cleared = enterBrowser(filtered, null);
    expect(cleared.browserFilter).toBeNull();
  });

  it("exitBrowser returns to the landing and drops the openSearch flag", () => {
    const state = exitBrowser(
      enterBrowser(createLivetvState(NOW), { kind: "recents" }, true),
    );
    expect(state.mode).toBe("landing");
    expect(state.openSearch).toBe(false);
    expect(state.overlay).toBe("none");
  });
});

describe("setGuideMode / enterGuide guideMode", () => {
  it("setGuideMode switches only the sub-mode", () => {
    const state = setGuideMode(createLivetvState(NOW), "tonight");
    expect(state.guideMode).toBe("tonight");
    expect(state.mode).toBe("landing");
  });

  it("enterGuide with a guideMode switches it; without one it keeps the current", () => {
    const base = setGuideMode(createLivetvState(NOW), "channel");
    expect(enterGuide(base).guideMode).toBe("channel");
    expect(enterGuide(base, null, "tonight").guideMode).toBe("tonight");
    expect(enterGuide(createLivetvState(NOW)).guideMode).toBe("now");
  });
});

describe("overlays", () => {
  it("openOverlay / closeOverlay touch only the overlay", () => {
    const playing = enterPlayback(createLivetvState(NOW), "ch-1");
    const open = openOverlay(playing, "quicksurf");
    expect(open.overlay).toBe("quicksurf");
    expect(open.mode).toBe("playback");
    expect(open.tunedChannelId).toBe("ch-1");
    const closed = closeOverlay(open);
    expect(closed.overlay).toBe("none");
    expect(closed.tunedChannelId).toBe("ch-1");
  });
});

describe("enterGuide / exitGuide preserve tuned + focus", () => {
  it("enterGuide anchors on the tuned channel and records the return focus key", () => {
    const playing = enterPlayback(createLivetvState(NOW), "ch-7");
    const guide = enterGuide(playing, "livetv:channel:ch-7");
    expect(guide.mode).toBe("guide");
    expect(guide.tunedChannelId).toBe("ch-7");
    expect(guide.guideChannelId).toBe("ch-7");
    expect(guide.returnFocusKey).toBe("livetv:channel:ch-7");
    expect(guide.overlay).toBe("none");
  });

  it("enterGuide without a focus key keeps the previously recorded one", () => {
    const guide = enterGuide(createLivetvState(NOW), "landing:guide-button");
    const again = enterGuide(guide);
    expect(again.returnFocusKey).toBe("landing:guide-button");
  });

  it("enterGuide with no tuned channel keeps the existing guide anchor", () => {
    const state = { ...createLivetvState(NOW), guideChannelId: "ch-4" };
    expect(enterGuide(state).guideChannelId).toBe("ch-4");
  });

  it("exitGuide returns to the landing by default, keeping guide position + focus key", () => {
    const guide = {
      ...enterGuide(enterPlayback(createLivetvState(NOW), "ch-7"), "k"),
      guideProgrammeKey: guideProgrammeKey("ch-7", NOW),
    };
    const back = exitGuide(guide);
    expect(back.mode).toBe("landing");
    expect(back.tunedChannelId).toBe("ch-7");
    expect(back.guideChannelId).toBe("ch-7");
    expect(back.guideProgrammeKey).toBe(guideProgrammeKey("ch-7", NOW));
    expect(back.returnFocusKey).toBe("k");
  });

  it("exitGuide can return to playback when the Guide was opened from there", () => {
    const guide = enterGuide(enterPlayback(createLivetvState(NOW), "ch-7"));
    expect(exitGuide(guide, "playback").mode).toBe("playback");
    expect(exitGuide(guide, "playback").tunedChannelId).toBe("ch-7");
  });

  it("exitGuide accepts the legacy \"home\" return target as landing", () => {
    const guide = enterGuide(enterPlayback(createLivetvState(NOW), "ch-7"));
    expect(exitGuide(guide, "home").mode).toBe("landing");
  });

  it("guide date survives a guide round-trip", () => {
    const day = startOfLocalDayMs(NOW) + 2 * 24 * HOUR;
    const state = { ...createLivetvState(NOW), guideDateMs: day };
    expect(exitGuide(enterGuide(state)).guideDateMs).toBe(day);
  });
});

describe("guideProgrammeKey", () => {
  it("is stable and channel-scoped", () => {
    expect(guideProgrammeKey("ch-1", NOW)).toBe(`ch-1@${NOW}`);
    expect(guideProgrammeKey("ch-1", NOW)).not.toBe(
      guideProgrammeKey("ch-2", NOW),
    );
    expect(guideProgrammeKey("ch-1", NOW)).not.toBe(
      guideProgrammeKey("ch-1", NOW + HOUR),
    );
  });
});

describe("serialize / parse round-trip", () => {
  it("round-trips mode + tuned + previous + guide date", () => {
    const day = startOfLocalDayMs(NOW) + 24 * HOUR;
    let state = enterPlayback(createLivetvState(NOW), "ch-1");
    state = tuneTo(state, "ch-2");
    state = { ...state, guideDateMs: day };
    const parsed = parseLivetvState(serializeLivetvState(state));
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("playback");
    expect(parsed!.tunedChannelId).toBe("ch-2");
    expect(parsed!.previousChannelId).toBe("ch-1");
    expect(parsed!.guideDateMs).toBe(day);
  });

  it("never persists the overlay: a parsed state always starts with none", () => {
    const state = openOverlay(enterPlayback(createLivetvState(NOW), "ch-1"), "osd");
    const raw = serializeLivetvState(state);
    expect(raw).not.toContain("osd");
    expect(parseLivetvState(raw)!.overlay).toBe("none");
  });

  it("never persists the session-only fields (guideMode / filter / flags)", () => {
    let state = setGuideMode(createLivetvState(NOW), "tonight");
    state = enterBrowser(state, { kind: "favourites" }, true, "k");
    const raw = serializeLivetvState(state);
    expect(raw).not.toContain("tonight");
    expect(raw).not.toContain("favourites");
    expect(raw).not.toContain("openSearch");
    const parsed = parseLivetvState(raw)!;
    expect(parsed.guideMode).toBe("now");
    expect(parsed.browserFilter).toBeNull();
    expect(parsed.openSearch).toBe(false);
    expect(parsed.lastLandingCard).toBeNull();
    expect(parsed.guideReturnTo).toBe("landing");
  });

  it("maps the legacy persisted mode \"home\" to \"landing\"", () => {
    const parsed = parseLivetvState(
      JSON.stringify({
        v: 1,
        mode: "home",
        tunedChannelId: "ch-1",
        previousChannelId: null,
        guideDateMs: startOfLocalDayMs(NOW),
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("landing");
    expect(parsed!.tunedChannelId).toBe("ch-1");
    expect(parsed!.highlightedChannelId).toBe("ch-1");
  });

  it("parses the new \"browser\" mode", () => {
    const parsed = parseLivetvState(
      JSON.stringify({
        v: 1,
        mode: "browser",
        tunedChannelId: null,
        previousChannelId: null,
        guideDateMs: startOfLocalDayMs(NOW),
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("browser");
  });

  it("normaliseLivetvMode maps \"home\" to \"landing\" and keeps the rest", () => {
    expect(normaliseLivetvMode("home")).toBe("landing");
    expect(normaliseLivetvMode("landing")).toBe("landing");
    expect(normaliseLivetvMode("browser")).toBe("browser");
    expect(normaliseLivetvMode("playback")).toBe("playback");
    expect(normaliseLivetvMode("guide")).toBe("guide");
  });

  it("returns null on garbage", () => {
    expect(parseLivetvState("")).toBeNull();
    expect(parseLivetvState("not json")).toBeNull();
    expect(parseLivetvState("{}")).toBeNull();
    expect(parseLivetvState(JSON.stringify({ v: 2, mode: "home" }))).toBeNull();
    expect(parseLivetvState(JSON.stringify({ v: 1, mode: "nope" }))).toBeNull();
    expect(
      parseLivetvState(
        JSON.stringify({ v: 1, mode: "home", tunedChannelId: 42, previousChannelId: null, guideDateMs: 1 }),
      ),
    ).toBeNull();
    expect(
      parseLivetvState(
        JSON.stringify({ v: 1, mode: "home", tunedChannelId: null, previousChannelId: null, guideDateMs: "soon" }),
      ),
    ).toBeNull();
    expect(parseLivetvState(null)).toBeNull();
    expect(parseLivetvState(undefined)).toBeNull();
    expect(parseLivetvState(42)).toBeNull();
  });
});

describe("sessionStorage persistence", () => {
  it("persists under redsilk:livetv:state and restores it", () => {
    const storage = fakeStorage();
    const state = tuneTo(enterPlayback(createLivetvState(NOW), "ch-1"), "ch-2");
    persistLivetvState(state, storage);
    expect(storage.getItem(LIVETV_STATE_STORAGE_KEY)).toContain("ch-2");
    const restored = restoreLivetvState(storage);
    expect(restored.tunedChannelId).toBe("ch-2");
    expect(restored.previousChannelId).toBe("ch-1");
    expect(restored.mode).toBe("playback");
    expect(restored.overlay).toBe("none");
  });

  it("restore falls back to a fresh default when nothing (or garbage) is stored", () => {
    const storage = fakeStorage();
    expect(restoreLivetvState(storage).mode).toBe("landing");
    storage.setItem(LIVETV_STATE_STORAGE_KEY, "garbage{{{");
    expect(restoreLivetvState(storage).mode).toBe("landing");
    expect(restoreLivetvState(storage).tunedChannelId).toBeNull();
  });
});

describe("parseLivetvModeParam — shell ?mode= mapping", () => {
  it("maps guide / browser / playback / landing, with home as the landing alias", () => {
    expect(parseLivetvModeParam("guide")).toBe("guide");
    expect(parseLivetvModeParam("browser")).toBe("browser");
    expect(parseLivetvModeParam("playback")).toBe("playback");
    expect(parseLivetvModeParam("landing")).toBe("landing");
    expect(parseLivetvModeParam("home")).toBe("landing");
  });

  it("returns null for absent / unknown values", () => {
    expect(parseLivetvModeParam(null)).toBeNull();
    expect(parseLivetvModeParam(undefined)).toBeNull();
    expect(parseLivetvModeParam("")).toBeNull();
    expect(parseLivetvModeParam("nope")).toBeNull();
    expect(parseLivetvModeParam("HOME")).toBeNull();
  });
});
