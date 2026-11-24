// 0.11.27 — the dead-audio watchdog must catch a direct-played MKV
// whose audio codec Chromium cannot decode: video decodes, audio
// bytes stay at zero, and no error event ever fires. The verdict
// logic is pure (assessDeadAudioSample); the attach function drives
// the sampling timer against a video element.
//
// Only the verdict/attach behaviour is tested here; the mount
// integration (pin + remux retry) lives in
// tests/vod-couch-pipeline-0119.test.ts, which runs the real
// container plan and remux memory against a fake engine.

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assessDeadAudioSample,
  attachVodDeadAudioWatchdog,
  VOD_DEAD_AUDIO_CHECK_MS,
  type DeadAudioSample,
} from "@/scripts/lib/vod-dead-audio-watchdog.ts";
import { tryPinMkvToRemuxAndRetry } from "@/scripts/lib/vod-remux-recovery.ts";
import {
  buildRemuxContentKey,
  isRemuxPinnedContent,
} from "@/scripts/lib/vod-remux-memory.ts";

function sample(overrides: Partial<DeadAudioSample> = {}): DeadAudioSample {
  return {
    audioBytes: 0,
    audioCodec: null,
    frames: 40,
    videoWidth: 1280,
    playedSeconds: 5,
    paused: false,
    muted: false,
    volume: 1,
    ...overrides,
  };
}

describe("assessDeadAudioSample", () => {
  it("video decoding with zero audio bytes is dead", () => {
    expect(assessDeadAudioSample(sample())).toBe("dead");
  });

  it("frames alone qualify a stuttering stream with almost no playhead movement", () => {
    expect(assessDeadAudioSample(sample({ playedSeconds: 0.5 }))).toBe("dead");
  });

  it("too little played and too few frames is inconclusive, not dead", () => {
    expect(assessDeadAudioSample(sample({ playedSeconds: 1, frames: 10 }))).toBe("inconclusive");
  });

  it("zero decoded frames is inconclusive — video has not started", () => {
    expect(assessDeadAudioSample(sample({ frames: 0 }))).toBe("inconclusive");
  });

  it("unknown frame count is inconclusive", () => {
    expect(assessDeadAudioSample(sample({ frames: null }))).toBe("inconclusive");
  });

  it("zero video width is inconclusive — nothing is presenting", () => {
    expect(assessDeadAudioSample(sample({ videoWidth: 0 }))).toBe("inconclusive");
  });

  it("any decoded audio bytes means alive", () => {
    expect(assessDeadAudioSample(sample({ audioBytes: 4096 }))).toBe("alive");
  });

  it("no byte counter plus an undecodable codec is dead", () => {
    for (const codec of ["ac3", "eac3", "dts", "mp2"]) {
      expect(assessDeadAudioSample(sample({ audioBytes: null, audioCodec: codec }))).toBe("dead");
    }
  });

  it("no byte counter plus a decodable codec stays innocent", () => {
    expect(assessDeadAudioSample(sample({ audioBytes: null, audioCodec: "mp4a.40.2" }))).toBe("alive");
    expect(assessDeadAudioSample(sample({ audioBytes: null, audioCodec: null }))).toBe("alive");
  });

  it("paused, muted, or volume 0 never produce a verdict", () => {
    expect(assessDeadAudioSample(sample({ paused: true }))).toBe("inconclusive");
    expect(assessDeadAudioSample(sample({ muted: true }))).toBe("inconclusive");
    expect(assessDeadAudioSample(sample({ volume: 0 }))).toBe("inconclusive");
  });
});

describe("tryPinMkvToRemuxAndRetry (code-4 recovery, shared with the watchdog)", () => {
  // The pin store caches per playlist in module state, so localStorage
  // alone cannot reset it — every case uses its own playlist.
  let playlistCounter = 0;
  function freshPin() {
    playlistCounter += 1;
    const playlistId = `playlist-${playlistCounter}`;
    const contentKey = buildRemuxContentKey("episode", 7);
    return { playlistId, contentKey };
  }

  function pinOptions(overrides: Record<string, unknown> = {}) {
    const { playlistId, contentKey } = freshPin();
    return {
      options: {
        logTag: "[test]",
        desktopPlatform: true,
        remuxAvailable: true,
        activePlaylistId: playlistId,
        contentKey,
        localDownloadPath: null,
        resolvedContainer: "mkv" as const,
        playSrc: "https://provider.invalid/series/user/pass/7.mkv",
        retirePreviousPlaybackAndRetryRemux: () => {},
        ...overrides,
      } as Parameters<typeof tryPinMkvToRemuxAndRetry>[0],
      playlistId,
      contentKey,
    };
  }

  it("pins an MKV and retries when remux is available", () => {
    const retire = vi.fn();
    const { options, playlistId, contentKey } = pinOptions({
      retirePreviousPlaybackAndRetryRemux: retire,
    });
    const pinned = tryPinMkvToRemuxAndRetry(options);
    expect(pinned).toBe(true);
    expect(isRemuxPinnedContent(playlistId, contentKey)).toBe(true);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-MKV container and retries nothing", () => {
    const retire = vi.fn();
    const { options, playlistId, contentKey } = pinOptions({
      resolvedContainer: "mp4",
      playSrc: "https://provider.invalid/series/user/pass/7.mp4",
      retirePreviousPlaybackAndRetryRemux: retire,
    });
    const pinned = tryPinMkvToRemuxAndRetry(options);
    expect(pinned).toBe(false);
    expect(isRemuxPinnedContent(playlistId, contentKey)).toBe(false);
    expect(retire).not.toHaveBeenCalled();
  });

  it("refuses when remux is unavailable, off-desktop, or playlist-less", () => {
    for (const overrides of [
      { remuxAvailable: false },
      { desktopPlatform: false },
      { activePlaylistId: null },
    ]) {
      const retire = vi.fn();
      const { options, playlistId, contentKey } = pinOptions({
        ...overrides,
        retirePreviousPlaybackAndRetryRemux: retire,
      });
      const pinned = tryPinMkvToRemuxAndRetry(options);
      expect(pinned).toBe(false);
      expect(isRemuxPinnedContent(playlistId, contentKey)).toBe(false);
      expect(retire).not.toHaveBeenCalled();
    }
  });
});

describe("attachVodDeadAudioWatchdog", () => {
  interface FakeVideo {
    currentTime: number;
    paused: boolean;
    muted: boolean;
    volume: number;
    videoWidth: number;
    webkitAudioDecodedByteCount: number;
    getVideoPlaybackQuality: () => { totalVideoFrames: number };
  }

  function fakeVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
    return {
      currentTime: 0,
      paused: false,
      muted: false,
      volume: 1,
      videoWidth: 1280,
      webkitAudioDecodedByteCount: 0,
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 40 }),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function arm(video: FakeVideo, onDeadAudio = vi.fn(), isStale = () => false) {
    return attachVodDeadAudioWatchdog({
      logTag: "[test]",
      getVideo: () => video as unknown as HTMLVideoElement,
      getAudioCodec: () => null,
      isStale,
      onDeadAudio,
    });
  }

  it("fires once when video plays with zero audio bytes", async () => {
    const video = fakeVideo();
    const onDeadAudio = vi.fn();
    const detach = arm(video, onDeadAudio);
    expect(detach).not.toBeNull();
    await vi.advanceTimersByTimeAsync(VOD_DEAD_AUDIO_CHECK_MS);
    expect(onDeadAudio).toHaveBeenCalledTimes(1);
    expect(onDeadAudio).toHaveBeenCalledWith({ audioBytes: 0, audioCodec: null });
    // One-shot: no second verdict on later checks.
    await vi.advanceTimersByTimeAsync(VOD_DEAD_AUDIO_CHECK_MS * 3);
    expect(onDeadAudio).toHaveBeenCalledTimes(1);
  });

  it("waits for enough played time when frames are few, then fires", async () => {
    const video = fakeVideo({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 10 }) });
    const onDeadAudio = vi.fn();
    arm(video, onDeadAudio);
    await vi.advanceTimersByTimeAsync(VOD_DEAD_AUDIO_CHECK_MS);
    expect(onDeadAudio).not.toHaveBeenCalled();
    video.currentTime = 4;
    await vi.advanceTimersByTimeAsync(VOD_DEAD_AUDIO_CHECK_MS);
    expect(onDeadAudio).toHaveBeenCalledTimes(1);
  });

  it("never fires while muted or paused, and gives up after the check budget", async () => {
    const video = fakeVideo({ muted: true });
    const onDeadAudio = vi.fn();
    arm(video, onDeadAudio);
    await vi.advanceTimersByTimeAsync(VOD_DEAD_AUDIO_CHECK_MS * 8);
    expect(onDeadAudio).not.toHaveBeenCalled();
  });

  it("never fires when audio bytes decode", async () => {
    const video = fakeVideo({ webkitAudioDecodedByteCount: 8192 });
    const onDeadAudio = vi.fn();
    arm(video, onDeadAudio);
    await vi.advanceTimersByTimeAsync(VOD_DEAD_AUDIO_CHECK_MS * 8);
    expect(onDeadAudio).not.toHaveBeenCalled();
  });

  it("detach stops all future checks", async () => {
    const video = fakeVideo({ getVideoPlaybackQuality: () => ({ totalVideoFrames: 10 }) });
    const onDeadAudio = vi.fn();
    const detach = arm(video, onDeadAudio);
    detach?.();
    await vi.advanceTimersByTimeAsync(VOD_DEAD_AUDIO_CHECK_MS * 8);
    expect(onDeadAudio).not.toHaveBeenCalled();
  });

  it("a stale mount never fires", async () => {
    const video = fakeVideo();
    const onDeadAudio = vi.fn();
    arm(video, onDeadAudio, () => true);
    await vi.advanceTimersByTimeAsync(VOD_DEAD_AUDIO_CHECK_MS * 3);
    expect(onDeadAudio).not.toHaveBeenCalled();
  });

  it("returns null when no video element exists", () => {
    const detach = attachVodDeadAudioWatchdog({
      logTag: "[test]",
      getVideo: () => null,
      getAudioCodec: () => null,
      isStale: () => false,
      onDeadAudio: vi.fn(),
    });
    expect(detach).toBeNull();
  });
});
