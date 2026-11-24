// Dead-audio watchdog for VOD direct play (0.11.27).
//
// A direct-played MKV whose audio codec Chromium cannot decode (AC-3 /
// E-AC-3 / DTS / MP2) plays video with no audio and fires NO error
// event, so the code-4 remux recovery never runs and the episode
// repeats the silent play forever. This watchdog ports the Live TV
// dead-audio check (stream.ts) to the VOD mounts: it samples
// webkitAudioDecodedByteCount while video decodes, and fires once
// when video plays but no audio bytes ever decode. The watchdog
// itself never retries — the caller decides the recovery (pin + remux
// retry on direct mounts; see tryPinMkvToRemuxAndRetry).

import { log } from "@/scripts/lib/log.js"
import { isUnsupportedAudioCodec } from "@/scripts/lib/codec-hints.ts"
import { decodedFrameCount } from "@/scripts/lib/player-telemetry.ts"

/** How often (ms) to sample audio decode progress. Mirrors Live TV. */
export const VOD_DEAD_AUDIO_CHECK_MS = 5000
/** Dead-but-not-yet-qualified checks before the watchdog gives up. Mirrors Live TV. */
export const VOD_DEAD_AUDIO_MAX_CHECKS = 6
/** Minimum played time (s) before a verdict. Mirrors Live TV. */
export const VOD_DEAD_AUDIO_MIN_PLAYED_S = 3
/** Minimum decoded frames before a verdict (also qualifies a stuttering stream). Mirrors Live TV. */
export const VOD_DEAD_AUDIO_MIN_FRAMES = 25
/** Wall-clock budget from arming: a paused/muted mount must not tick forever. */
export const VOD_DEAD_AUDIO_MAX_LIFETIME_MS = 60000

export interface DeadAudioSample {
  /** webkitAudioDecodedByteCount, or null when the counter is unavailable. */
  audioBytes: number | null
  /** Reported audio codec string, if any. */
  audioCodec: string | null | undefined
  /** Decoded video frames (getVideoPlaybackQuality), or null when unknown. */
  frames: number | null
  videoWidth: number
  /** Seconds played since the watchdog armed. */
  playedSeconds: number
  paused: boolean
  muted: boolean
  volume: number
}

export type DeadAudioAssessment = "dead" | "alive" | "inconclusive"

/**
 * Pure verdict over one sample. "dead" means video is decoding but no
 * audio bytes ever decoded and enough video played to rule out
 * start-up buffering. "alive" means audio is decoding (or the codec
 * is known-decodable when no byte counter exists). Everything else —
 * paused, muted, no frames yet, not played enough — is "inconclusive"
 * and the caller should sample again.
 */
export function assessDeadAudioSample(sample: DeadAudioSample): DeadAudioAssessment {
  if (sample.paused || sample.muted || sample.volume === 0) return "inconclusive"
  // Without a byte counter the codec string is the only evidence; a decodable one stays innocent.
  const audioDead =
    sample.audioBytes === null
      ? isUnsupportedAudioCodec(sample.audioCodec)
      : sample.audioBytes === 0
  if (!audioDead) return "alive"
  if (sample.frames === null || sample.frames === 0) return "inconclusive"
  if (sample.videoWidth === 0) return "inconclusive"
  // Frame count also qualifies so a stuttering stream (slow currentTime) still gets verdicts.
  const playedEnough =
    sample.playedSeconds >= VOD_DEAD_AUDIO_MIN_PLAYED_S ||
    sample.frames >= VOD_DEAD_AUDIO_MIN_FRAMES
  return playedEnough ? "dead" : "inconclusive"
}

export interface DeadAudioWatchdogDetail {
  audioBytes: number | null
  audioCodec: string | null
}

export interface DeadAudioWatchdogOptions {
  logTag: string
  /** Live media element; read fresh on every check so a remount is observed. */
  getVideo(): HTMLVideoElement | null | undefined
  /** Reported audio codec string, if any. */
  getAudioCodec(): string | null | undefined
  /** True once this mount has been superseded; stops the watchdog. */
  isStale(): boolean
  /** Called exactly once when audio is judged dead. */
  onDeadAudio(detail: DeadAudioWatchdogDetail): void
}

/** Detaches the watchdog; safe to call repeatedly. */
export type DeadAudioWatchdogHandle = () => void

// Blink-only despite the prefix - WebKit never shipped it, hence the codec-string fallback.
function audioDecodedByteCount(video: HTMLVideoElement): number | null {
  const bytes = (video as unknown as { webkitAudioDecodedByteCount?: unknown })
    .webkitAudioDecodedByteCount
  return typeof bytes === "number" ? bytes : null
}

/**
 * Arms the dead-audio watchdog for one direct-play mount. Returns a
 * detach handle, or null when no video element exists yet. The
 * watchdog fires onDeadAudio at most once and then detaches itself;
 * it also detaches after VOD_DEAD_AUDIO_MAX_CHECKS inconclusive
 * checks or the lifetime budget, and never fires while paused,
 * muted, or silent (volume 0).
 */
export function attachVodDeadAudioWatchdog(
  options: DeadAudioWatchdogOptions,
): DeadAudioWatchdogHandle | null {
  const videoAtArm = options.getVideo()
  if (!videoAtArm) return null
  const baselineTime = videoAtArm.currentTime || 0
  const deadline = Date.now() + VOD_DEAD_AUDIO_MAX_LIFETIME_MS
  let attempts = 0
  let detached = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const detach: DeadAudioWatchdogHandle = () => {
    detached = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const schedule = () => {
    if (!detached) timer = setTimeout(check, VOD_DEAD_AUDIO_CHECK_MS)
  }

  const check = () => {
    timer = null
    if (detached || options.isStale()) return
    if (Date.now() > deadline) return
    const video = options.getVideo()
    if (!video) return
    const audioBytes = audioDecodedByteCount(video)
    const audioCodec = options.getAudioCodec() ?? null
    const frames = decodedFrameCount(video)
    const playedSeconds = (video.currentTime || 0) - baselineTime
    const assessment = assessDeadAudioSample({
      audioBytes,
      audioCodec,
      frames,
      videoWidth: video.videoWidth,
      playedSeconds,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
    })
    log.info(`${options.logTag} dead-audio check`, {
      audioBytes,
      audioCodec,
      frames,
      videoWidth: video.videoWidth,
      played: playedSeconds,
      assessment,
    })
    if (assessment === "alive") return
    if (assessment === "dead") {
      detach()
      log.warn(`${options.logTag} video decoding but no audio decoded - audio codec likely undecodable`, {
        audioBytes,
        audioCodec,
      })
      options.onDeadAudio({ audioBytes, audioCodec })
      return
    }
    attempts++
    if (attempts < VOD_DEAD_AUDIO_MAX_CHECKS) schedule()
  }

  schedule()
  return detach
}
