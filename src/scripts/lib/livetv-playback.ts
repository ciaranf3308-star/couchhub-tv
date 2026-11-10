// RedSilk Live TV — playback session wrapper (W2).
//
// Thin logic over the existing engine. The engine stays in
// stream.ts (tuning, HLS, failover, catch-up) and player-runtime.ts
// (mountPlayer): this module NEVER builds a stream URL, mounts a
// player, or touches a <video> element. It only decides *which*
// channel to tune to, *whether* a highlight may become a tune, and
// how a failure is classified — then hands the tune to the engine
// seam (window `livetv:tune`, consumed by stream.ts) or to
// preferences.js for favourites.
//
// Highlight vs tuned is the hard rule of this module: moving the
// Quick Surf highlight NEVER tunes. A tune happens only through
// `confirmHighlight` (A / Enter on the highlighted channel) or an
// explicit `tuneToChannel` call. Tests assert that separation with
// synthetic data; the DOM/engine calls are isolated behind the
// `PlaybackEngine` seam so tests inject a fake.

import {
  previousChannelId as epgPreviousChannelId,
  stepChannel,
  channelIndexById,
} from "./couch-livetv-epg";

/** OSD auto-hide delay (ms). TvOsd.astro uses the same value. */
export const OSD_AUTO_HIDE_MS = 5000;

/** Error-state keys (W1's shared vocabulary) for a failed tune. */
export type LivetvPlaybackErrorKey = "stream-unavailable" | "provider-lost";

export interface PlaybackChannel {
  id: string | number;
  name?: string;
  displayName?: string;
  logo?: string | null;
  chno?: number | null;
  category?: string | null;
}

export interface PlaybackNowNext {
  currentTitle?: string | null;
  currentStartMs?: number | null;
  currentStopMs?: number | null;
  nextTitle?: string | null;
  nextStartMs?: number | null;
  nextStopMs?: number | null;
}

/** Minimal engine seam: everything behind it is stream.ts's job. */
export interface PlaybackEngine {
  /** Ask the engine to tune. Never called for a highlight move. */
  tune(channelId: string | number): void;
}

export function dispatchTune(channelId: string | number): void {
  window.dispatchEvent(
    new CustomEvent("livetv:tune", { detail: { channelId } }),
  );
}

/** The window-event engine: `livetv:tune` -> stream.ts `play()`. */
export const windowPlaybackEngine: PlaybackEngine = {
  tune: (channelId) => dispatchTune(channelId),
};

// ── Highlight vs tuned ────────────────────────────────────────────

/**
 * Step the Quick Surf highlight one adjacent channel (wrap-around).
 * Returns the new highlighted id, or null when there is nothing to
 * browse. Pure: stepping never tunes — the caller must still call
 * `confirmHighlight` to turn a highlight into a tune.
 */
export function stepHighlight(
  channels: ReadonlyArray<PlaybackChannel>,
  highlightedId: string | number | null | undefined,
  delta: 1 | -1,
): string | number | null {
  if (!channels.length) return null;
  const currentIndex = channelIndexById(channels, highlightedId);
  const nextIndex = stepChannel(currentIndex, channels.length, delta);
  if (nextIndex === null) return null;
  return channels[nextIndex].id;
}

/**
 * Turn a highlight into a tune (A / Enter on the highlighted
 * channel). Returns the id to tune, or null when nothing is
 * highlighted — a null highlight is never a tune.
 */
export function confirmHighlight(
  highlightedId: string | number | null | undefined,
): string | number | null {
  if (highlightedId === null || highlightedId === undefined) return null;
  return highlightedId;
}

/** Tune to an explicit channel id through the engine seam. */
export function tuneToChannel(
  engine: PlaybackEngine,
  channelId: string | number | null | undefined,
): boolean {
  if (channelId === null || channelId === undefined) return false;
  engine.tune(channelId);
  return true;
}

/** Re-exported, not duplicated: previous-channel is one rule. */
export const previousChannelId = epgPreviousChannelId;

/**
 * Resolve the previous-channel tune target. Returns null when there
 * is no previous channel (or it is the one already playing) — the
 * caller must then stay on the current stream, never retune to self.
 */
export function previousChannelTarget(
  currentId: string | number | null | undefined,
  previousId: string | number | null | undefined,
): string | number | null {
  return epgPreviousChannelId(currentId, previousId);
}

// ── Favourites (pure set half + thin preferences.js half) ────────

/**
 * Pure favourite toggle over a Set of ids. Returns the new
 * favourite state. The shell's live path uses `toggleFavourite`
 * below, which persists through preferences.js; tests use this.
 */
export function toggleFavouriteInSet(
  favourites: Set<string | number>,
  channelId: string | number,
): boolean {
  if (favourites.has(channelId)) {
    favourites.delete(channelId);
    return false;
  }
  favourites.add(channelId);
  return true;
}

/**
 * Persist a favourite toggle for a live channel and return the new
 * state. `playlistId` is required — without a playlist there is
 * nothing to persist against, so this returns null and touches
 * nothing. Emits `xt:favorites-changed` via preferences.js.
 */
export async function toggleFavourite(
  playlistId: string | null | undefined,
  channel: PlaybackChannel,
): Promise<boolean | null> {
  if (!playlistId || channel.id === null || channel.id === undefined) {
    return null;
  }
  const { toggleFavorite } = await import("./preferences.js");
  return toggleFavorite(playlistId, "live", channel.id as number, {
    name: channel.displayName || channel.name || "",
    logo: channel.logo ?? null,
  });
}

// ── Failure / retry ───────────────────────────────────────────────

/**
 * Map the engine's failure-panel kind (stream.ts
 * `showPlaybackFailurePanel`) onto W1's shared error-state keys.
 * Connection-limit / unreachable provider reads as provider-lost;
 * decode / parse / anything else reads as stream-unavailable.
 * Unknown kinds default to stream-unavailable — never invent a
 * more specific cause than the engine reported.
 */
export function errorKeyForFailureKind(
  kind: string | null | undefined,
): LivetvPlaybackErrorKey {
  if (kind === "connection-limit") return "provider-lost";
  return "stream-unavailable";
}

/**
 * Which stream stays on screen after a failed tune: the previously
 * working channel when the failed tune was for a *different*
 * channel. When the failed tune WAS the current channel there is
 * no previous working stream to keep — the caller shows the error
 * state instead. Returns the id to keep, or null.
 */
export function streamToKeepOnFailure(
  failedChannelId: string | number | null | undefined,
  tunedChannelId: string | number | null | undefined,
): string | number | null {
  if (tunedChannelId === null || tunedChannelId === undefined) return null;
  if (failedChannelId === tunedChannelId) return null;
  return tunedChannelId;
}

/**
 * Retry target after a failure: retry the channel that failed when
 * one was named, else fall back to the last working channel. Null
 * only when neither exists — the caller then shows the error state
 * with a return-to-Home action instead of a retry.
 */
export function retryTarget(
  failedChannelId: string | number | null | undefined,
  lastWorkingChannelId: string | number | null | undefined,
): string | number | null {
  if (failedChannelId !== null && failedChannelId !== undefined) {
    return failedChannelId;
  }
  if (lastWorkingChannelId !== null && lastWorkingChannelId !== undefined) {
    return lastWorkingChannelId;
  }
  return null;
}

// ── Live-only transport rules ─────────────────────────────────────

/**
 * Live TV has no seek: there is no seek UI on live, ever. (Catch-up
 * sessions seek through the engine's own timeshift path, not through
 * a playback-shell control.)
 */
export function supportsSeek(): false {
  return false;
}

/** Programme progress fraction for the OSD bar (0..1, never NaN). */
export function nowNextProgress(
  nowNext: PlaybackNowNext,
  nowMs: number = Date.now(),
): number {
  const start = nowNext.currentStartMs;
  const stop = nowNext.currentStopMs;
  if (start === null || start === undefined) return 0;
  if (stop === null || stop === undefined) return 0;
  const span = stop - start;
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(1, (nowMs - start) / span));
}
