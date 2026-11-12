/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  shouldReleaseStreamOnModeLeave,
  dispatchRelease,
  switchChannel,
  type PlaybackEngine,
} from "@/scripts/lib/livetv-playback";

// 0.11.2 W3 — playback exit releases the stream.
//
// The reported defect: play loads for a second, then black; replay
// does the same; the only error seen is the provider refusing
// ("already open" / "something else may still be playing"). Root
// cause: leaving playback only hid the shell — the tuned channel
// kept playing hidden and held the provider's single connection, so
// the next tune was refused as connection-limit. The fix: leaving
// playback FOR THE LANDING SCREEN releases the stream (Guide /
// browser keep the session by design — see the helper's docs).
//
// The harness below models the provider's one-stream guard exactly:
// a tune is refused while a session is held. It replays the user's
// sequence — play, back out, play again — and shows the stale
// session blocking the second play without the release, and the
// second play succeeding with it. Headless cannot play a real
// stream; the fake stands in for the provider slot, and the
// decision + event contract it exercises are the app's own code.

describe("shouldReleaseStreamOnModeLeave — exit releases, browsing keeps", () => {
  it("releases on return to landing (and the legacy home name)", () => {
    expect(shouldReleaseStreamOnModeLeave("landing")).toBe(true);
    expect(shouldReleaseStreamOnModeLeave("home")).toBe(true);
  });

  it("keeps the session for guide / browser / playback", () => {
    expect(shouldReleaseStreamOnModeLeave("guide")).toBe(false);
    expect(shouldReleaseStreamOnModeLeave("browser")).toBe(false);
    expect(shouldReleaseStreamOnModeLeave("playback")).toBe(false);
  });

  it("releases on nothing else — unknown / empty modes never release", () => {
    expect(shouldReleaseStreamOnModeLeave("settings")).toBe(false);
    expect(shouldReleaseStreamOnModeLeave("")).toBe(false);
    expect(shouldReleaseStreamOnModeLeave(null)).toBe(false);
    expect(shouldReleaseStreamOnModeLeave(undefined)).toBe(false);
  });
});

/** Fake provider slot: one connection max, like the Xtream panel. */
function oneStreamProvider() {
  let heldBy: string | number | null = null;
  return {
    heldBy: () => heldBy,
    /** Tune refused while another session is held. */
    tune(id: string | number): boolean {
      if (heldBy !== null && heldBy !== id) return false;
      heldBy = id;
      return true;
    },
    release() {
      heldBy = null;
    },
  };
}

describe("harness: play → back out → play again", () => {
  it("without the exit release the stale session blocks the next play", () => {
    const provider = oneStreamProvider();
    // Watch channel A.
    expect(provider.tune(101)).toBe(true);
    // Back out to landing WITHOUT releasing (the 0.11.1 behaviour):
    // nothing runs — the shell only hid, the stream kept playing.
    // Pick channel B: the provider still counts A.
    expect(provider.tune(102)).toBe(false);
    expect(provider.heldBy()).toBe(101);
  });

  it("with the exit release the next play succeeds", () => {
    const provider = oneStreamProvider();
    // The engine's `livetv:release` listener (stream.ts
    // releaseLocalPlaybackForHandoff) drops the held session.
    const onRelease = () => provider.release();
    window.addEventListener("livetv:release", onRelease);
    try {
      expect(provider.tune(101)).toBe(true);
      // Back out to landing: the shell releases (decision + event).
      expect(shouldReleaseStreamOnModeLeave("landing")).toBe(true);
      dispatchRelease(101);
      expect(provider.heldBy()).toBeNull();
      // Pick channel B: the slot is free.
      expect(provider.tune(102)).toBe(true);
      expect(provider.heldBy()).toBe(102);
    } finally {
      window.removeEventListener("livetv:release", onRelease);
    }
  });

  it("channel-to-channel switching still releases before tuning", () => {
    const provider = oneStreamProvider();
    const engine: PlaybackEngine = {
      tune: (id) => {
        if (!provider.tune(id)) throw new Error("provider refused");
      },
      release: () => provider.release(),
    };
    expect(provider.tune(101)).toBe(true);
    expect(switchChannel(engine, 101, 102)).toBe(true);
    expect(provider.heldBy()).toBe(102);
  });
});

describe("shell wiring — the exit release is wired, not just decided", () => {
  it("TvPlaybackShell releases on leaving playback for landing", () => {
    const shell = readFileSync(
      "src/components/couch/TvPlaybackShell.astro",
      "utf8",
    );
    expect(shell).toContain("shouldReleaseStreamOnModeLeave(mode)");
    expect(shell).toContain("dispatchRelease(tunedId)");
    // Guide / browser must NOT release: the predicate is the gate,
    // and the shell only calls it on the landing path.
    expect(shell).toContain('tunedId = null;');
  });
});

// ── VOD dispose ───────────────────────────────────────────────────
// createCouchVodPlayer's dispose() used to only pause the handle, so
// the engine stayed attached with its source loaded after exit and
// the provider connection stayed held. dispose() must reset the
// engine (destroys hls/shaka/mpegts, unloads the source) while
// keeping the <video> element for the next mount.

const vodCalls = vi.hoisted(() => ({
  reset: 0,
  pause: 0,
  src: 0,
  play: 0,
}));

vi.mock("@/scripts/lib/player-runtime.ts", () => ({
  // jsdom harness: not a Tauri desktop, so the container plan is direct.
  desktopPlatform: false,
  isWindows: false,
  mountPlayer: vi.fn(async () => ({
    kind: "embedded",
    backend: "videojs",
    handle: {
      src: () => {
        vodCalls.src += 1;
      },
      play: () => {
        vodCalls.play += 1;
        return Promise.resolve();
      },
      pause: () => {
        vodCalls.pause += 1;
      },
      reset: () => {
        vodCalls.reset += 1;
      },
      paused: () => true,
      currentTime: () => 0,
      getMediaElement: () => document.getElementById("test-player"),
      on: () => {},
      off: () => {},
      one: () => {},
    },
  })),
  playWhenReady: (handle: { play?: () => unknown }) => {
    void handle.play?.();
  },
}));

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getPlayerBackend: () => "videojs",
}));

vi.mock("@/scripts/movies/couch-movies.ts", () => ({
  formatClock: (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`,
}));

vi.mock("@/scripts/lib/log.js", () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { createCouchVodPlayer } from "@/scripts/movies/couch-player";

describe("VOD dispose releases the engine", () => {
  beforeEach(() => {
    vodCalls.reset = 0;
    vodCalls.pause = 0;
    vodCalls.src = 0;
    vodCalls.play = 0;
    document.body.innerHTML = `
      <video id="test-player"></video>
      <button id="test-play-pause"></button>
      <button id="test-back10"></button>
      <button id="test-fwd10"></button>
      <input id="test-timeline" type="range" />
      <span id="test-time"></span>
      <button id="test-fullscreen"></button>
      <button id="test-back"></button>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("dispose() pauses AND resets the mounted engine", async () => {
    const player = await createCouchVodPlayer({
      logTag: "[test]",
      videoElementId: "test-player",
      src: "https://example.invalid/movie.mp4",
      ids: {
        playPause: "test-play-pause",
        back10: "test-back10",
        fwd10: "test-fwd10",
        timeline: "test-timeline",
        timeLabel: "test-time",
        fullscreen: "test-fullscreen",
        back: "test-back",
      },
      onProgress: () => {},
      onEnded: () => {},
      onExit: () => {},
    });
    expect(player).not.toBeNull();
    expect(vodCalls.src).toBe(1);
    player?.dispose();
    expect(vodCalls.pause).toBeGreaterThanOrEqual(1);
    // The regression: dispose() used to pause only (reset 0), so the
    // engine — and the provider connection — survived the exit.
    expect(vodCalls.reset).toBe(1);
  });
});

// ── OSD split ─────────────────────────────────────────────────────
// Live TV keeps TvOsd (channel + Now/Next + the seven Live actions);
// movies/series use TvVodOsd (title + timeline + transport). The
// 0.9.0 W3 restyle removed TvOsd's slots, so the VOD pages' slotted
// children were silently dropped from the DOM — movies rendered the
// Live overlay (LIVE badge, dead Channels/Guide buttons) with no
// Play/Pause, seek, timeline, Back, Next Episode or Autoplay
// controls at all. These tests pin the split at the source so the
// slots can never silently vanish again (the build check in the
// 0.11.2 report greps the built HTML for the same ids).

describe("OSD split — Live TV overlay vs VOD overlay", () => {
  it("TvVodOsd renders the VOD slots (info / timeline / controls)", () => {
    const vod = readFileSync(
      "src/components/couch/TvVodOsd.astro",
      "utf8",
    );
    expect(vod).toContain('<slot name="info"');
    expect(vod).toContain("<slot />");
    expect(vod).toContain('<slot name="controls"');
    expect(vod).toContain("data-vod-osd");
    // No Live-TV behaviour in the component code (the header
    // comment names the events only to say they are absent, so
    // assert on the markup + script below it).
    const code = vod.slice(vod.indexOf("<div"));
    expect(code).not.toContain("requestLivetvMode");
    expect(code).not.toContain('CustomEvent("livetv:');
    expect(code).not.toContain("livetv:osd-action");
    expect(code).not.toContain("__live");
  });

  it("movies + series detail pages use TvVodOsd, not TvOsd", () => {
    for (const page of [
      "src/pages/movies/detail.astro",
      "src/pages/series/detail.astro",
    ]) {
      const src = readFileSync(page, "utf8");
      expect(src).toContain("TvVodOsd");
      expect(src).toContain("<TvVodOsd");
      expect(src).not.toContain("TvOsd.astro");
      expect(src).not.toContain("<TvOsd");
    }
  });

  it("TvOsd stays Live-TV-only (no slots — it is not a slot shell)", () => {
    const live = readFileSync("src/components/couch/TvOsd.astro", "utf8");
    expect(live).not.toContain("<slot");
    expect(live).toContain("data-livetv-osd");
  });

  it("the playback shell still uses the Live TV overlay", () => {
    const shell = readFileSync(
      "src/components/couch/TvPlaybackShell.astro",
      "utf8",
    );
    expect(shell).toContain("<TvOsd />");
    expect(shell).not.toContain("TvVodOsd");
  });
});
