// 0.11.9 — the Couch VOD player must run the shared remux pipeline
// (container plan, tee-proxy prepare, error classification with a
// remux retry, stall watchdog, audio switcher) instead of feeding the
// raw provider URL to the engine with no error listener. A simulated
// engine error must ALWAYS surface a message — never silent black.
//
// The container plan, remux memory and the start-error classifier run
// REAL; only the engine, the platform probes and the toast UI are
// faked. The plan is asserted through behaviour (direct vs remux
// mount, pin written, retry fired), not by spying on the planner.

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const harness = vi.hoisted(() => {
  class FakeHandle {
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    srcCalls: Array<Record<string, unknown>> = [];
    errorValue: { code?: number; message?: string } | null = null;
    resetCalls = 0;
    playCalls = 0;
    pauseCalls = 0;
    audioSources: unknown[] = [];
    on(event: string, fn: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
    }
    off(event: string, fn: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        list.filter((candidate) => candidate !== fn)
      );
    }
    one(event: string, fn: (...args: unknown[]) => void) {
      this.on(event, fn);
    }
    emit(event: string) {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn();
    }
    src(opts: Record<string, unknown>) {
      this.srcCalls.push(opts);
    }
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    }
    pause() {
      this.pauseCalls += 1;
    }
    reset() {
      this.resetCalls += 1;
    }
    paused() {
      return true;
    }
    currentTime() {
      return 0;
    }
    duration() {
      return 0;
    }
    getMediaElement() {
      return document.getElementById("test-player");
    }
    error() {
      return this.errorValue;
    }
    codecInfo() {
      return undefined;
    }
    setAudioSource(source: unknown) {
      this.audioSources.push(source);
    }
  }

  class FakeSwitcher {
    source = { kind: "remux", trackId: "default" };
    setTracksCalls: unknown[][] = [];
    recoverCalls = 0;
    disposeCalls = 0;
    recovering = false;
    constructor(public options: Record<string, unknown>) {}
    setTracks(tracks: unknown[]) {
      this.setTracksCalls.push(tracks);
    }
    recoverRemuxStall() {
      this.recoverCalls += 1;
    }
    isRecovering() {
      return this.recovering;
    }
    dispose() {
      this.disposeCalls += 1;
    }
  }

  return {
    FakeHandle,
    FakeSwitcher,
    desktopPlatform: false,
    isWindows: false,
    remuxAvailable: false,
    probeResult: null as { url: string; container: "mkv" | "mp4" } | null,
    audioTracks: [] as Array<{ id: string }>,
    handles: [] as FakeHandle[],
    switchers: [] as FakeSwitcher[],
    watchdogCalls: [] as Array<Record<string, unknown>>,
    watchdogDetaches: 0,
    toasts: { container: 0, format: 0, source: 0, hevc: 0, audio: 0 },
    prepareCalls: [] as string[],
    prepareSession: null as { playbackUrl: string; mkvSession: null } | null,
  };
});

vi.mock("@/scripts/lib/player-runtime.ts", () => ({
  get desktopPlatform() {
    return harness.desktopPlatform;
  },
  get isWindows() {
    return harness.isWindows;
  },
  mountPlayer: vi.fn(async () => {
    const handle = new harness.FakeHandle();
    harness.handles.push(handle);
    return { kind: "embedded", backend: "videojs", handle };
  }),
  playWhenReady: (handle: { play?: () => unknown }) => {
    void handle.play?.();
  },
}));

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getPlayerBackend: () => "videojs",
}));

vi.mock("@/scripts/lib/vod-audio-proxy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/vod-audio-proxy.ts")>();
  return {
    ...actual,
    vodAudioRemuxAvailable: async () => harness.remuxAvailable,
  };
});

vi.mock("@/scripts/lib/vod-proxy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/vod-proxy.ts")>();
  return {
    ...actual,
    prepareVodPlayback: async (sourceUrl: string) => {
      harness.prepareCalls.push(sourceUrl);
      return harness.prepareSession ?? { playbackUrl: sourceUrl, mkvSession: null };
    },
  };
});

vi.mock("@/scripts/lib/vod-playback-toasts.ts", () => ({
  createVodPlaybackToasts: () => ({
    showContainerUnsupportedToast: () => {
      harness.toasts.container += 1;
    },
    showFormatUnsupportedToast: () => {
      harness.toasts.format += 1;
    },
    showSourceUnavailableToast: () => {
      harness.toasts.source += 1;
    },
    showHevcUnsupportedToast: () => {
      harness.toasts.hevc += 1;
    },
    showAudioUnsupportedToast: () => {
      harness.toasts.audio += 1;
    },
  }),
}));

vi.mock("@/scripts/lib/vod-audio-switch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/vod-audio-switch.ts")>();
  return {
    ...actual,
    createVodAudioSwitcher: (options: Record<string, unknown>) => {
      const switcher = new harness.FakeSwitcher(options);
      harness.switchers.push(switcher);
      return switcher;
    },
    discoverVodAudioTracks: async () => harness.audioTracks,
  };
});

vi.mock("@/scripts/lib/vod-container-probe.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/vod-container-probe.ts")>();
  return {
    ...actual,
    probeVodContainerAlternative: async () => harness.probeResult,
  };
});

vi.mock("@/scripts/lib/vod-remux-recovery.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/vod-remux-recovery.ts")>();
  return {
    ...actual,
    attachVodStallWatchdog: (
      _videoEl: unknown,
      options: Record<string, unknown>
    ) => {
      harness.watchdogCalls.push(options);
      const detach = () => {
        harness.watchdogDetaches += 1;
      };
      return Object.assign(detach, { resetStallClock: () => {} });
    },
  };
});

vi.mock("@/scripts/movies/couch-movies.ts", () => ({
  formatClock: (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`,
}));

vi.mock("@/scripts/lib/log.js", () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  redactUrl: (url: string) => url,
}));

import { createCouchVodPlayer } from "@/scripts/movies/couch-player";
import {
  buildRemuxContentKey,
  isRemuxPinnedContent,
  rememberRemuxPinnedContent,
} from "@/scripts/lib/vod-remux-memory.ts";

const PLAYLIST_ID = "playlist-1";
const CONTENT_KEY = buildRemuxContentKey("movie", 42);

function mountDom() {
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
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    logTag: "[test]",
    videoElementId: "test-player",
    src: "https://provider.invalid/movie/user/pass/42.mp4",
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
    ...overrides,
  } as Parameters<typeof createCouchVodPlayer>[0];
}

function remuxContext(onRemuxRetry: () => void) {
  return {
    playlistId: PLAYLIST_ID,
    contentKind: "movie" as const,
    contentId: 42,
    nameHintSource: "Test Movie",
    onRemuxRetry,
  };
}

beforeEach(() => {
  mountDom();
  localStorage.clear();
  harness.desktopPlatform = false;
  harness.isWindows = false;
  harness.remuxAvailable = false;
  harness.probeResult = null;
  harness.audioTracks = [];
  harness.handles = [];
  harness.switchers = [];
  harness.watchdogCalls = [];
  harness.watchdogDetaches = 0;
  harness.toasts = { container: 0, format: 0, source: 0, hevc: 0, audio: 0 };
  harness.prepareCalls = [];
  harness.prepareSession = null;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Couch VOD pipeline (0.11.9)", () => {
  it("a direct .mp4 mount loads the prepared source and registers an error listener", async () => {
    const player = await createCouchVodPlayer(baseOptions());
    expect(player).not.toBeNull();
    const handle = harness.handles[0];
    expect(harness.prepareCalls).toEqual([
      "https://provider.invalid/movie/user/pass/42.mp4",
    ]);
    expect(handle.srcCalls).toHaveLength(1);
    expect(handle.srcCalls[0].src).toBe(
      "https://provider.invalid/movie/user/pass/42.mp4"
    );
    expect(handle.srcCalls[0].type).toBe("video/mp4");
    expect(handle.listeners.has("error")).toBe(true);
    expect(harness.watchdogCalls).toHaveLength(1);
    expect(harness.watchdogCalls[0].remuxOwnsInitialMount).toBe(false);
    player?.dispose();
  });

  it("a code-4 error on an MKV pins the content and retries through remux", async () => {
    harness.desktopPlatform = true;
    harness.isWindows = true;
    harness.remuxAvailable = true;
    const onRemuxRetry = vi.fn();
    const onError = vi.fn();
    const player = await createCouchVodPlayer(
      baseOptions({
        src: "https://provider.invalid/movie/user/pass/42.mkv",
        remux: remuxContext(onRemuxRetry),
        onError,
      })
    );
    expect(player).not.toBeNull();
    // Windows plays MKV direct first (no pin yet): the player mounted it.
    const handle = harness.handles[0];
    expect(handle.srcCalls).toHaveLength(1);

    handle.errorValue = { code: 4, message: "SRC_NOT_SUPPORTED" };
    handle.emit("error");

    expect(isRemuxPinnedContent(PLAYLIST_ID, CONTENT_KEY)).toBe(true);
    expect(onRemuxRetry).toHaveBeenCalledTimes(1);
    // The failed mount released its engine before the retry.
    expect(handle.resetCalls).toBe(1);
    // A retry is in flight, so no terminal error is surfaced for the
    // failed direct attempt.
    expect(onError).not.toHaveBeenCalled();

    // The retry re-runs the tune: the pin makes the plan remux, so the
    // audio switcher owns the mount and the player never touches src.
    const retryPlayer = await createCouchVodPlayer(
      baseOptions({
        src: "https://provider.invalid/movie/user/pass/42.mkv",
        remux: remuxContext(() => {}),
        resumeSeconds: 30,
        onError,
      })
    );
    expect(retryPlayer).not.toBeNull();
    expect(harness.switchers).toHaveLength(1);
    expect(harness.switchers[0].options.mountRemuxImmediately).toBe(true);
    expect(harness.switchers[0].options.initialStartSeconds).toBe(30);
    expect(harness.handles[1].srcCalls).toHaveLength(0);
    expect(harness.watchdogCalls[1].remuxOwnsInitialMount).toBe(true);
    retryPlayer?.dispose();
  });

  it("a code-3 error routes to the remux-failure path and surfaces a message", async () => {
    harness.desktopPlatform = true;
    harness.isWindows = true;
    harness.remuxAvailable = true;
    const onError = vi.fn();
    const player = await createCouchVodPlayer(
      baseOptions({
        src: "https://provider.invalid/movie/user/pass/42.mkv",
        remux: remuxContext(() => {}),
        onError,
      })
    );
    expect(player).not.toBeNull();
    const handle = harness.handles[0];
    handle.errorValue = { code: 3, message: "DECODE failed" };
    handle.emit("error");

    // The shared classifier showed its toast…
    expect(
      harness.toasts.container +
        harness.toasts.hevc +
        harness.toasts.audio +
        harness.toasts.source
    ).toBeGreaterThan(0);
    // …and the detail page got the real message (never silent black).
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("DECODE failed");
    player?.dispose();
  });

  it("an unclassified engine error still surfaces a message (never silent black)", async () => {
    const onError = vi.fn();
    const player = await createCouchVodPlayer(
      baseOptions({ onError })
    );
    expect(player).not.toBeNull();
    const handle = harness.handles[0];
    // Code 2 is outside the shared classifier's retry/toast branches.
    handle.errorValue = { code: 2, message: "network stall" };
    handle.emit("error");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("network stall");
    player?.dispose();
  });

  it("an unsupported AVI with no alternative toasts, surfaces an error, and mounts nothing", async () => {
    harness.desktopPlatform = true;
    harness.isWindows = true;
    harness.remuxAvailable = true;
    harness.probeResult = null;
    const onError = vi.fn();
    const player = await createCouchVodPlayer(
      baseOptions({
        src: "https://provider.invalid/movie/user/pass/42.avi",
        onError,
      })
    );
    expect(player).toBeNull();
    expect(harness.toasts.container).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(harness.handles[0].srcCalls).toHaveLength(0);
  });

  it("an AVI with a playable alternative re-plans and mounts the alternative", async () => {
    harness.desktopPlatform = true;
    harness.isWindows = true;
    harness.remuxAvailable = true;
    harness.probeResult = {
      url: "https://provider.invalid/movie/user/pass/42.mp4",
      container: "mp4",
    };
    const player = await createCouchVodPlayer(
      baseOptions({
        src: "https://provider.invalid/movie/user/pass/42.avi",
      })
    );
    expect(player).not.toBeNull();
    expect(harness.handles[0].srcCalls).toHaveLength(1);
    expect(harness.handles[0].srcCalls[0].src).toBe(
      "https://provider.invalid/movie/user/pass/42.mp4"
    );
    player?.dispose();
  });

  it("a pinned remux mount wires the audio switcher and the stall watchdog", async () => {
    harness.desktopPlatform = true;
    harness.isWindows = true;
    harness.remuxAvailable = true;
    rememberRemuxPinnedContent(PLAYLIST_ID, CONTENT_KEY);
    const player = await createCouchVodPlayer(
      baseOptions({
        src: "https://provider.invalid/movie/user/pass/42.mkv",
        remux: remuxContext(() => {}),
      })
    );
    expect(player).not.toBeNull();
    expect(harness.switchers).toHaveLength(1);
    expect(harness.watchdogCalls).toHaveLength(1);
    expect(harness.watchdogCalls[0].remuxOwnsInitialMount).toBe(true);
    player?.dispose();
    expect(harness.switchers[0].disposeCalls).toBe(1);
    expect(harness.watchdogDetaches).toBe(1);
    expect(harness.handles[0].resetCalls).toBe(1);
  });

  it("a mount that goes stale during prepare never loads a source", async () => {
    let stale = false;
    const player = await createCouchVodPlayer(
      baseOptions({
        isStale: () => stale,
      })
    );
    // The mount above completed while fresh; now flip staleness
    // before a second mount's prepare resolves by reusing the flag
    // through a fresh player whose prepare sees the stale state.
    player?.dispose();
    stale = true;
    const stalePlayer = await createCouchVodPlayer(
      baseOptions({
        isStale: () => stale,
      })
    );
    expect(stalePlayer).toBeNull();
    expect(harness.handles[1].srcCalls).toHaveLength(0);
  });

  it("direct-mode audio discovery with two tracks builds a switcher", async () => {
    harness.remuxAvailable = true;
    harness.audioTracks = [{ id: "a1" }, { id: "a2" }];
    const player = await createCouchVodPlayer(baseOptions());
    expect(player).not.toBeNull();
    // Discovery is fire-and-forget; let the microtask queue drain.
    await vi.waitFor(() => {
      expect(harness.switchers).toHaveLength(1);
    });
    expect(harness.switchers[0].options.mountRemuxImmediately).toBe(false);
    expect(harness.handles[0].audioSources).toHaveLength(1);
    player?.dispose();
  });
});
