/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LIVETV_LANDING_MODE,
  OSD_AUTO_HIDE_MS,
  createOsdAutoHide,
  stepHighlight,
  confirmHighlight,
  switchChannel,
  failureRecovery,
  resolveBackStep,
  surfWindow,
  recordTune,
  previousChannelTarget,
  catchupActionForPlaybackChannel,
  findPlayerMenuButton,
  dispatchRelease,
  type PlaybackChannel,
  type PlaybackEngine,
} from "@/scripts/lib/livetv-playback";
import { livetvOsdActionForKey } from "@/scripts/lib/couch-livetv-epg";

const channels: PlaybackChannel[] = [
  { id: 101, name: "RTE One", chno: 101 },
  { id: 102, name: "RTE 2", chno: 102 },
  { id: 103, name: "TG4", chno: 103 },
  { id: 104, name: "Virgin One", chno: 104 },
  { id: 105, name: "Sky Sports", chno: 105 },
  { id: 106, name: "Sky F1", chno: 106 },
  { id: 107, name: "BBC One", chno: 107 },
  { id: 108, name: "BBC Two", chno: 108 },
  { id: 109, name: "Channel 4", chno: 109 },
  { id: 110, name: "ITV", chno: 110 },
  { id: 111, name: "More4", chno: 111 },
];

interface RecordingEngine extends PlaybackEngine {
  calls: Array<"release" | "tune">;
  released: Array<string | number | null | undefined>;
  tuned: Array<string | number>;
}

function recordingEngine(): RecordingEngine {
  const engine: RecordingEngine = {
    calls: [],
    released: [],
    tuned: [],
    tune(id) {
      this.calls.push("tune");
      this.tuned.push(id);
    },
    release(id) {
      this.calls.push("release");
      this.released.push(id);
    },
  };
  return engine;
}

describe("LIVETV_LANDING_MODE", () => {
  it("is the Home mode — landing and home are the same mode in 0.9.0", () => {
    // The mode guard in livetv.astro only accepts home | playback |
    // guide; a "landing" mode would be dropped silently.
    expect(LIVETV_LANDING_MODE).toBe("home");
  });
});

describe("OSD auto-hide timing (createOsdAutoHide)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hides after OSD_AUTO_HIDE_MS of inactivity", () => {
    const onHide = vi.fn();
    const osd = createOsdAutoHide(onHide);
    osd.show();
    vi.advanceTimersByTime(OSD_AUTO_HIDE_MS - 1);
    expect(onHide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHide).toHaveBeenCalledTimes(1);
    osd.dispose();
  });

  it("activity (poke) resets the timer — no hide while the user is active", () => {
    const onHide = vi.fn();
    const osd = createOsdAutoHide(onHide);
    osd.show();
    vi.advanceTimersByTime(OSD_AUTO_HIDE_MS - 1000);
    osd.poke();
    vi.advanceTimersByTime(OSD_AUTO_HIDE_MS - 1000);
    expect(onHide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onHide).toHaveBeenCalledTimes(1);
    osd.dispose();
  });

  it("show() re-arms after a hide, and dispose() cancels a pending hide", () => {
    const onHide = vi.fn();
    const osd = createOsdAutoHide(onHide);
    osd.show();
    vi.advanceTimersByTime(OSD_AUTO_HIDE_MS);
    expect(onHide).toHaveBeenCalledTimes(1);
    osd.show();
    vi.advanceTimersByTime(OSD_AUTO_HIDE_MS);
    expect(onHide).toHaveBeenCalledTimes(2);
    osd.show();
    osd.dispose();
    vi.advanceTimersByTime(OSD_AUTO_HIDE_MS * 2);
    expect(onHide).toHaveBeenCalledTimes(2);
  });

  it("uses OSD_AUTO_HIDE_MS as the default delay", () => {
    const onHide = vi.fn();
    const osd = createOsdAutoHide(onHide);
    osd.show();
    vi.advanceTimersByTime(4999);
    expect(onHide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHide).toHaveBeenCalledTimes(1);
    osd.dispose();
  });
});

describe("Quick Surf window (surfWindow)", () => {
  it("centres five nearby entries on the highlight", () => {
    const { entries, position, total } = surfWindow(channels, 105, 5);
    expect(entries.map((c) => c.id)).toEqual([103, 104, 105, 106, 107]);
    expect(position).toBe(5);
    expect(total).toBe(11);
  });

  it("wraps at the ends of the list", () => {
    const first = surfWindow(channels, 101, 5);
    expect(first.entries.map((c) => c.id)).toEqual([110, 111, 101, 102, 103]);
    expect(first.position).toBe(1);
    const last = surfWindow(channels, 111, 5);
    expect(last.entries.map((c) => c.id)).toEqual([109, 110, 111, 101, 102]);
    expect(last.position).toBe(11);
  });

  it("clamps to the list when it is shorter than the window", () => {
    const short = surfWindow(channels.slice(0, 3), 102, 5);
    expect(short.entries.map((c) => c.id)).toEqual([101, 102, 103]);
    expect(short.position).toBe(2);
    expect(short.total).toBe(3);
  });

  it("is empty with no channels, and never tunes", () => {
    const engine = recordingEngine();
    const { entries, position, total } = surfWindow([], 101, 5);
    expect(entries).toEqual([]);
    expect(position).toBe(0);
    expect(total).toBe(0);
    expect(engine.calls).toEqual([]);
  });
});

describe("Quick Surf highlight never tunes", () => {
  it("stepping through the whole list performs no tune and no release", () => {
    const engine = recordingEngine();
    let highlighted: string | number | null = 101;
    for (let i = 0; i < channels.length * 2; i++) {
      highlighted = stepHighlight(channels, highlighted, 1);
    }
    expect(highlighted).toBe(101);
    expect(engine.calls).toEqual([]);
    expect(engine.tuned).toEqual([]);
  });

  it("windowing the list performs no tune", () => {
    const engine = recordingEngine();
    surfWindow(channels, 105, 5);
    surfWindow(channels, 103, 5);
    expect(engine.calls).toEqual([]);
  });
});

describe("confirmed switch releases the prior stream before opening the replacement", () => {
  it("release precedes tune, in order, with the current id released", () => {
    const engine = recordingEngine();
    expect(switchChannel(engine, 102, 105)).toBe(true);
    expect(engine.calls).toEqual(["release", "tune"]);
    expect(engine.released).toEqual([102]);
    expect(engine.tuned).toEqual([105]);
  });

  it("a confirmed highlight tunes exactly the highlighted channel, once", () => {
    const engine = recordingEngine();
    let highlighted = stepHighlight(channels, 102, 1); // 103
    highlighted = stepHighlight(channels, highlighted, 1); // 104
    const target = confirmHighlight(highlighted);
    expect(switchChannel(engine, 102, target)).toBe(true);
    expect(engine.calls).toEqual(["release", "tune"]);
    expect(engine.tuned).toEqual([104]);
  });

  it("a null target releases and tunes nothing", () => {
    const engine = recordingEngine();
    expect(switchChannel(engine, 102, null)).toBe(false);
    expect(switchChannel(engine, 102, undefined)).toBe(false);
    expect(engine.calls).toEqual([]);
  });

  it("an engine without a release hook still tunes (release is optional)", () => {
    const plain: PlaybackEngine & { tuned: Array<string | number> } = {
      tuned: [],
      tune(id) {
        this.tuned.push(id);
      },
    };
    expect(switchChannel(plain, 102, 105)).toBe(true);
    expect(plain.tuned).toEqual([105]);
  });

  it("dispatchRelease posts the cancelable livetv:release window event", () => {
    const seen: Array<unknown> = [];
    const handler = (ev: Event) => seen.push((ev as CustomEvent).detail);
    window.addEventListener("livetv:release", handler);
    try {
      dispatchRelease(102);
      expect(seen).toEqual([{ channelId: 102 }]);
    } finally {
      window.removeEventListener("livetv:release", handler);
    }
  });
});

describe("failed switch keeps the current stream + offers recovery", () => {
  it("a failed tune to another channel keeps the tuned channel and offers retry + previous", () => {
    const recovery = failureRecovery(105, 102, 101, 102);
    expect(recovery.keepId).toBe(102);
    expect(recovery.retryId).toBe(105);
    expect(recovery.previousId).toBe(101);
  });

  it("a failed tune of the current channel keeps nothing but still offers retry", () => {
    const recovery = failureRecovery(102, 102, 101, null);
    expect(recovery.keepId).toBeNull();
    expect(recovery.retryId).toBe(102);
    expect(recovery.previousId).toBe(101);
  });

  it("with no failed id and no last working channel, only Home is left", () => {
    const recovery = failureRecovery(null, 102, null, null);
    expect(recovery.keepId).toBe(102);
    expect(recovery.retryId).toBeNull();
    expect(recovery.previousId).toBeNull();
  });

  it("resolving a failure never tunes by itself", () => {
    const engine = recordingEngine();
    failureRecovery(105, 102, 101, 102);
    expect(engine.calls).toEqual([]);
  });
});

describe("B behaviour — three-step sequence (resolveBackStep)", () => {
  it("step 1: Quick Surf open → dismiss it", () => {
    expect(
      resolveBackStep({ quicksurfOpen: true, overlayOpen: true, osdVisible: true }),
    ).toBe("dismiss-quicksurf");
  });

  it("step 2: surf closed, overlay/OSD open → close the overlay", () => {
    expect(
      resolveBackStep({ quicksurfOpen: false, overlayOpen: true, osdVisible: false }),
    ).toBe("close-overlay");
    expect(
      resolveBackStep({ quicksurfOpen: false, overlayOpen: false, osdVisible: true }),
    ).toBe("close-overlay");
  });

  it("step 3: nothing open → return to landing", () => {
    expect(
      resolveBackStep({ quicksurfOpen: false, overlayOpen: false, osdVisible: false }),
    ).toBe("return-landing");
  });

  it("the three steps run in order as overlays close", () => {
    // B, B, B from surf-open: dismiss surf → close OSD → landing.
    let state = { quicksurfOpen: true, overlayOpen: false, osdVisible: true };
    expect(resolveBackStep(state)).toBe("dismiss-quicksurf");
    state = { ...state, quicksurfOpen: false };
    expect(resolveBackStep(state)).toBe("close-overlay");
    state = { ...state, osdVisible: false };
    expect(resolveBackStep(state)).toBe("return-landing");
  });
});

describe("previous channel returns to previousChannelId", () => {
  it("recordTune moves the previous pointer only on a real channel change", () => {
    expect(recordTune(102, 101, 105)).toEqual({ tunedId: 105, previousId: 102 });
    expect(recordTune(null, null, 105)).toEqual({ tunedId: 105, previousId: null });
  });

  it("recordTune keeps the previous channel on a same-channel restart", () => {
    expect(recordTune(102, 101, 102)).toEqual({ tunedId: 102, previousId: 101 });
    expect(recordTune(102, 101, "102")).toEqual({ tunedId: "102", previousId: 101 });
  });

  it("a tune followed by Previous returns to the channel before it", () => {
    // Regression: 0.8.0 re-applied the tune update after the
    // synchronous livetv:tune dispatch, so previousId ended up
    // equal to the new tune and Previous silently did nothing.
    const engine = recordingEngine();
    let tuned: string | number | null = 102;
    let previous: string | number | null = 101;
    const target = 105;
    switchChannel(engine, tuned, target);
    const record = recordTune(tuned, previous, target);
    tuned = record.tunedId;
    previous = record.previousId;
    expect(tuned).toBe(105);
    expect(previous).toBe(102);
    const back = previousChannelTarget(tuned, previous);
    expect(back).toBe(102);
    expect(switchChannel(engine, tuned, back)).toBe(true);
    expect(engine.tuned).toEqual([105, 102]);
  });
  it("previous-channel target goes through switchChannel with release first", () => {
    const engine = recordingEngine();
    const target = previousChannelTarget(105, 102);
    expect(target).toBe(102);
    expect(switchChannel(engine, 105, target)).toBe(true);
    expect(engine.calls).toEqual(["release", "tune"]);
    expect(engine.tuned).toEqual([102]);
  });

  it("previous-channel with no previous tunes nothing", () => {
    const engine = recordingEngine();
    const target = previousChannelTarget(101, null);
    expect(target).toBeNull();
    expect(switchChannel(engine, 101, target)).toBe(false);
    expect(engine.calls).toEqual([]);
  });
});

describe("audio / subtitle actions preserved (no regression)", () => {
  it("the OSD transport keys still map to the player-owned actions", () => {
    expect(livetvOsdActionForKey(" ")).toBe("pause-toggle");
    expect(livetvOsdActionForKey("m")).toBe("mute");
    expect(livetvOsdActionForKey("f")).toBe("fullscreen");
    expect(livetvOsdActionForKey("[")).toBe("channel-down");
    expect(livetvOsdActionForKey("]")).toBe("channel-up");
    expect(livetvOsdActionForKey("\\")).toBe("previous-channel");
    expect(livetvOsdActionForKey("g")).toBe("guide");
    expect(livetvOsdActionForKey("c")).toBe("channels");
    expect(livetvOsdActionForKey("h")).toBe("home");
    expect(livetvOsdActionForKey("Escape")).toBe("dismiss");
    expect(livetvOsdActionForKey("q")).toBeNull();
  });

  it("finds the player's own audio menu button inside #player", () => {
    document.body.innerHTML =
      '<div id="player"><div class="video-js">' +
      '<button class="vjs-audio-track-button" type="button">Audio</button>' +
      '<button class="vjs-subs-caps-button" type="button">Subs</button>' +
      "</div></div>";
    expect(findPlayerMenuButton("audio")?.className).toContain("vjs-audio-track-button");
    expect(findPlayerMenuButton("subtitles")?.className).toContain("vjs-subs-caps-button");
    document.body.innerHTML = "";
  });

  it("returns null when the mount has no track menu (fallback path)", () => {
    document.body.innerHTML = '<div id="player"><video></video></div>';
    expect(findPlayerMenuButton("audio")).toBeNull();
    expect(findPlayerMenuButton("subtitles")).toBeNull();
    document.body.innerHTML = "";
  });
});

describe("catch-up on the OSD (catchupActionForPlaybackChannel)", () => {
  const now = Date.UTC(2026, 10, 10, 18, 0, 0);
  const liveStart = now - 30 * 60 * 1000;
  const liveStop = now + 30 * 60 * 1000;

  it("offers watch-from-start for a live programme on a catch-up channel", () => {
    expect(
      catchupActionForPlaybackChannel({ catchup: true }, liveStart, liveStop, now),
    ).toBe("watch-from-start");
  });

  it("offers replay for a past programme on a catch-up channel", () => {
    expect(
      catchupActionForPlaybackChannel(
        { catchup: true },
        now - 2 * 60 * 60 * 1000,
        now - 60 * 60 * 1000,
        now,
      ),
    ).toBe("replay");
  });

  it("offers nothing where the provider offers no catch-up", () => {
    expect(
      catchupActionForPlaybackChannel({ catchup: false }, liveStart, liveStop, now),
    ).toBe("none");
    expect(
      catchupActionForPlaybackChannel({ catchup: null }, liveStart, liveStop, now),
    ).toBe("none");
    expect(catchupActionForPlaybackChannel(null, liveStart, liveStop, now)).toBe("none");
  });

  it("offers nothing for a future programme even on a catch-up channel", () => {
    expect(
      catchupActionForPlaybackChannel(
        { catchup: true },
        now + 60 * 60 * 1000,
        now + 2 * 60 * 60 * 1000,
        now,
      ),
    ).toBe("none");
  });
});

// INTEGRATION (0.9.0) — mockup 2/3 playback chrome: the OSD
// hides while Quick Surf is open (the panel docks over its right
// side), the slim top bar (mark + Live TV + clock) persists over
// the video, and the bottom hints legend stays out of fullscreen
// playback (the OSD carries its own hint line).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

describe("playback chrome — mockup 2/3 (integration)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const osd = readFileSync(join(root, "src/components/couch/TvOsd.astro"), "utf8");
  const shell = readFileSync(join(root, "src/components/couch/TvPlaybackShell.astro"), "utf8");
  const css = readFileSync(join(root, "src/styles/couch.css"), "utf8");

  it("hides the OSD when Quick Surf opens", () => {
    expect(osd).toContain('else if (overlay === "quicksurf") el.setAttribute("data-hidden", "true");');
  });

  it("renders a slim top bar with brand lockup, Live TV label and live clock", () => {
    // 0.11.0 W5 — the mockup's full lockup ("NylahBox Studios" +
    // "Live TV") replaces the 0.9.0 mark-only bar, and the clock is
    // two lines, 24-hour ("18:24" / "Tue 10 Nov").
    expect(shell).toContain("rs-livetv-play-topbar");
    expect(shell).toContain('variant="lockup"');
    expect(shell).toContain("Live TV</span>");
    expect(shell).toContain("[data-play-clock-time]");
    expect(shell).toContain("[data-play-clock-date]");
    expect(shell).toContain("setInterval(paintClock, 15000)");
  });

  it("keeps the bottom hints legend out of fullscreen playback", () => {
    // The pill is the layout-level TvButtonHints nav, not the empty
    // [data-livetv-legend] mount in the Live TV head.
    expect(css).toContain('[data-livetv-mode="playback"] .rs-button-hints');
  });
});
