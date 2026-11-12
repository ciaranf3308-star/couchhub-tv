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
  catchupActionForProgramme,
  type CatchupAction,
} from "./couch-livetv-epg";

/** OSD auto-hide delay (ms). TvOsd.astro uses the same value. */
export const OSD_AUTO_HIDE_MS = 5000;

/**
 * The OSD action row (0.11.0 W5 — mockup 2, bottom-left panel):
 * exactly the mockup's seven icon actions, in the mockup's order.
 * Transport (Pause / Mute / Previous) and Restart live in the
 * Options overlay (Menu / Settings icon) — one press away, never a
 * second text-action jungle under the programme. TvOsd.astro renders
 * this set; the test asserts the contract so a future action can
 * only join it deliberately.
 */
export const OSD_ACTION_IDS = [
  "browser",
  "guide",
  "info",
  "favourite",
  "subtitles",
  "audio",
  "settings",
] as const;

export type OsdActionId = (typeof OSD_ACTION_IDS)[number];

/**
 * Live TV "landing" is the Home mode. The 0.9.0 directive names the
 * return target "landing", but the mode vocabulary in livetv.astro /
 * livetv-state.ts is home | playback | guide and the mode guard drops
 * anything else — dispatching `livetv:mode {mode:"landing"}` would
 * silently do nothing. Landing == home until W5 renames the mode;
 * every return-to-landing dispatch in the playback shell goes through
 * this constant so a rename is one edit.
 */
export const LIVETV_LANDING_MODE = "home" as const;

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
  /**
   * Release the currently held stream (provider connection) before a
   * replacement is opened. `switchChannel` and `tuneToChannel`
   * always call it first when the hook exists, and the engine's
   * `livetv:tune` listener releases again before `play()` — so a
   * tune can never open a second connection while the previous
   * stream is still held. Optional only so engines that tear the
   * prior mount down inside tune() (and test fakes) may omit it.
   * Never called for a highlight move.
   */
  release?(channelId: string | number | null | undefined): void;
}

export function dispatchTune(channelId: string | number): void {
  window.dispatchEvent(
    new CustomEvent("livetv:tune", { detail: { channelId } }),
  );
}

/**
 * Ask the engine to release the currently held stream. Cancelable
 * window event (`livetv:release {channelId}`) so the stream owner
 * can wire it to its release path (stream.ts's
 * releaseLocalPlaybackForHandoff); dispatching it with no listener
 * is a harmless no-op.
 *
 * 0.11.4 W5 — this is the ONE release-before-tune gate every tune
 * path goes through: `switchChannel` and `tuneToChannel` both
 * release first, and the engine's own `livetv:tune` listener
 * (stream.ts) releases again before `play()`, so a path that
 * dispatches the raw event (Guide, browser, landing Watch Live,
 * hero, deep link, resume-last auto-tune) can never open a second
 * connection while the previous stream is still held.
 */
export function dispatchRelease(
  channelId: string | number | null | undefined,
): void {
  window.dispatchEvent(
    new CustomEvent("livetv:release", { detail: { channelId } }),
  );
}

// ── Release on exit (0.11.2 W3) ───────────────────────────────────

/**
 * Does leaving playback for `mode` end the stream? Only the return
 * to the landing screen does. Exiting used to only hide the shell,
 * so the tuned channel kept playing hidden and held the provider's
 * single connection — the next tune was refused as connection-limit
 * ("already open") and went black a second after loading. Guide /
 * browser keep the session by design: the tuned session survives
 * mode switches (the Guide returns to playback), so they never
 * release on entry — but see `shouldReleaseHeldStreamOnModeLeave`:
 * a Guide detour must not swallow the release when the user then
 * leaves for landing. "home" is the legacy landing name
 * (requestLivetvMode maps it before dispatching, but the shell's
 * setMode sees raw modes).
 */
export function shouldReleaseStreamOnModeLeave(
  mode: string | null | undefined,
): boolean {
  return mode === "landing" || mode === "home";
}

/**
 * Does leaving for `mode` release a HELD stream? The mode rule
 * above, plus the fact that a stream is actually held.
 *
 * 0.11.4 W5 — the Guide detour: the 0.11.2 shell gate required the
 * document mode to still read "playback" when leaving for landing,
 * but a detour through the Guide had already rewritten it to
 * "guide", so playback → Guide → Landing never released and the
 * channel kept playing hidden, holding the provider's single
 * connection. The tuned channel id is the held-session signal, not
 * the mode the document happens to read — a landing leave releases
 * whenever a channel is tuned, however the user got there.
 */
export function shouldReleaseHeldStreamOnModeLeave(
  mode: string | null | undefined,
  tunedChannelId: string | number | null | undefined,
): boolean {
  if (tunedChannelId === null || tunedChannelId === undefined) {
    return false;
  }
  return shouldReleaseStreamOnModeLeave(mode);
}

/**
 * Settle delay before the automatic connection-limit retry
 * (stream.ts). Xtream panels free a stream slot only once the
 * sender's socket has closed (tv-cast's PROVIDER_SLOT_SETTLE_MS is
 * 600 ms for the same reason); 2 s covers the local teardown
 * (player reset + ffmpeg proxy kill) plus the slot linger, so the
 * retry opens a genuinely free slot instead of racing the release.
 */
export const CONNECTION_LIMIT_RETRY_DELAY_MS = 2000;

/**
 * Should a refused tune be retried automatically after releasing
 * the stale session? Only a provider connection-limit refusal, and
 * only once per user tune. Every other failure kind goes straight
 * to the error overlay, and a second connection-limit refusal
 * means the slot genuinely is not freeing — the user gets the
 * honest error, not a retry loop.
 */
export function shouldAutoRetryConnectionLimit(
  kind: string | null | undefined,
  alreadyRetried: boolean,
): boolean {
  return kind === "connection-limit" && !alreadyRetried;
}

/** The window-event engine: `livetv:tune` -> stream.ts `play()`. */
export const windowPlaybackEngine: PlaybackEngine = {
  tune: (channelId) => dispatchTune(channelId),
  release: (channelId) => dispatchRelease(channelId),
};

/**
 * Confirmed channel switch: release the prior stream BEFORE opening
 * the replacement, so the provider's one-stream limit is never
 * exceeded by two live connections. Returns false (and touches the
 * engine not at all) when there is no target — a null highlight is
 * never a tune. A target equal to the current channel is a restart
 * (release + re-open), not a no-op: explicit retry/confirm may
 * re-mount the same channel. Callers that must never retune to self
 * (previous-channel) gate through `previousChannelTarget` first.
 */
export function switchChannel(
  engine: PlaybackEngine,
  currentId: string | number | null | undefined,
  targetId: string | number | null | undefined,
): boolean {
  if (targetId === null || targetId === undefined) return false;
  engine.release?.(currentId);
  engine.tune(targetId);
  return true;
}

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

/** Tune to an explicit channel id through the engine seam.
 * Release-before-tune, like `switchChannel`: the previous stream
 * is released before the replacement opens, so the provider's
 * one-stream limit is never exceeded — this is the same gate every
 * tune path goes through, and the engine's `livetv:tune` listener
 * releases again before `play()`, so a caller that dispatches the
 * raw event is covered too. The release carries no channel id (the
 * engine's listener releases whatever is held); engines without a
 * release hook simply tune.
 */
export function tuneToChannel(
  engine: PlaybackEngine,
  channelId: string | number | null | undefined,
): boolean {
  if (channelId === null || channelId === undefined) return false;
  engine.release?.(null);
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

export interface TuneRecord {
  tunedId: string | number;
  previousId: string | number | null;
}

/**
 * Record a tune in the tuned/previous pair. Only a real channel
 * change moves the previous pointer — a same-channel restart must
 * not clobber it, and the caller must not re-apply the update after
 * the (synchronous) `livetv:tune` dispatch, or previousId ends up
 * equal to the new tune and Previous stops working. Both the shell
 * and Quick Surf record through this rule.
 */
export function recordTune(
  currentId: string | number | null | undefined,
  previousId: string | number | null | undefined,
  targetId: string | number,
): TuneRecord {
  const changed =
    currentId !== null &&
    currentId !== undefined &&
    String(currentId) !== String(targetId);
  return {
    tunedId: targetId,
    previousId: changed ? currentId : (previousId ?? null),
  };
}

// ── Quick Surf window ─────────────────────────────────────────────

export interface SurfWindow {
  /** Nearby entries centred on the highlight (wraps at the ends). */
  entries: PlaybackChannel[];
  /** 1-based position of the highlight in the full surf list. */
  position: number;
  /** Length of the full surf list. */
  total: number;
}

/**
 * The compact Quick Surf list: a small window of nearby channels
 * around the highlight (default 5: two before, highlight, two
 * after), wrapping at the ends of the list. Pure — windowing never
 * tunes. `position`/`total` feed the "5 / 11" indicator.
 */
export function surfWindow(
  channels: ReadonlyArray<PlaybackChannel>,
  highlightedId: string | number | null | undefined,
  size: number = 5,
): SurfWindow {
  const total = channels.length;
  if (total === 0) return { entries: [], position: 0, total: 0 };
  const windowSize = Math.max(1, Math.min(size, total));
  let centre = channelIndexById(channels, highlightedId);
  if (centre < 0) centre = 0;
  const before = Math.floor(windowSize / 2);
  const entries: PlaybackChannel[] = [];
  for (let offset = -before; offset < windowSize - before; offset++) {
    const index = (((centre + offset) % total) + total) % total;
    entries.push(channels[index]);
  }
  return { entries, position: centre + 1, total };
}

// ── B / back ──────────────────────────────────────────────────────

/** What one B press does in fullscreen playback, in priority order. */
export type PlaybackBackStep =
  | "dismiss-quicksurf"
  | "close-overlay"
  | "return-landing";

export interface PlaybackOverlayState {
  quicksurfOpen: boolean;
  /** Options panel, channel browser, or error overlay open. */
  overlayOpen: boolean;
  /** OSD lower third currently visible (no other overlay open). */
  osdVisible: boolean;
}

/**
 * One B press, resolved in order: dismiss Quick Surf; else close
 * the open overlay (options / browser / error / visible OSD); else
 * return to the landing screen. Pure — the caller performs the step.
 * The error overlay counts as an overlay (B never jumps to landing
 * from under a failure state); the caller closes it and shows the
 * OSD so the kept stream still has a way out.
 */
export function resolveBackStep(state: PlaybackOverlayState): PlaybackBackStep {
  if (state.quicksurfOpen) return "dismiss-quicksurf";
  if (state.overlayOpen || state.osdVisible) return "close-overlay";
  return "return-landing";
}

// ── OSD auto-hide (timer half — the DOM half lives in TvOsd) ─────

export interface OsdAutoHideHandle {
  /** Show the OSD and (re)arm the hide timer. */
  show(): void;
  /** Activity without showing: re-arm the timer while visible. */
  poke(): void;
  /** Stop the timer for good (unmount / mode change). */
  dispose(): void;
}

/**
 * Auto-hide timer for the OSD lower third: visible on `show()`,
 * hidden `delayMs` after the last `show()`/`poke()` with no further
 * activity. The DOM script owns the focus rule (never hide while
 * focus is inside the OSD) via the `onHide` callback — this helper
 * only owns timing, so vitest fake timers can assert it exactly.
 */
export function createOsdAutoHide(
  onHide: () => void,
  delayMs: number = OSD_AUTO_HIDE_MS,
): OsdAutoHideHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const arm = () => {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onHide();
    }, delayMs);
  };
  return {
    show: () => arm(),
    poke: () => arm(),
    dispose: () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// ── Player control-bar menus (audio / subtitles) ──────────────────

/** Which player-owned track menu an OSD button opens. */
export type PlayerMenuKind = "audio" | "subtitles";

/**
 * video.js control-bar buttons for the player's own track menus.
 * The OSD never reimplements track selection: it clicks the
 * player's own menu button (audioTrackButton / subsCapsButton in
 * player-runtime.ts) so the menu that opens is the engine's. Null
 * when the mount has no such button (native / artplayer mount) —
 * the caller then falls back to revealing the player control bar.
 */
export const PLAYER_MENU_BUTTON_SELECTORS: Readonly<
  Record<PlayerMenuKind, ReadonlyArray<string>>
> = {
  audio: [".vjs-audio-track-button", ".vjs-audio-button"],
  subtitles: [
    ".vjs-subs-caps-button",
    ".vjs-subtitles-button",
    ".vjs-captions-button",
  ],
};

export function findPlayerMenuButton(
  kind: PlayerMenuKind,
  root: ParentNode = document,
): HTMLElement | null {
  const player = root.querySelector?.("#player") ?? null;
  const scope = player ?? root;
  for (const selector of PLAYER_MENU_BUTTON_SELECTORS[kind]) {
    const button = scope.querySelector<HTMLElement>(selector);
    if (button) return button;
  }
  return null;
}

// ── Catch-up for the cached channel shape ─────────────────────────

/**
 * Catch-up action for the OSD's current programme, from the cached
 * channel row. LivetvChannel keeps only the boolean `catchup` flag
 * (the raw tvArchive/catchupDays fields are dropped at load), so
 * the adapter carries that flag through as the capability signal
 * and the archive window defaults to 7 days — never invented per
 * channel, never shown where the flag says the provider offers none.
 */
export function catchupActionForPlaybackChannel(
  channel: { catchup?: boolean | null } | null | undefined,
  startMs: number,
  stopMs: number,
  nowMs: number = Date.now(),
): CatchupAction {
  if (!channel) return "none";
  return catchupActionForProgramme({
    channel: { catchup: channel.catchup ? "1" : null },
    startMs,
    stopMs,
    nowMs,
  });
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
 * Raw failure kinds the engine reports on `livetv:playback-error`
 * (stream.ts `failurePanelReasonKind`): the classified start-failure
 * kind, "hevc-likely" when the name hints HEVC but no codec was
 * observed, or "unknown".
 */
export type LivetvFailureKind =
  | "hevc"
  | "hevc-likely"
  | "codec"
  | "audio"
  | "parse"
  | "connection-limit"
  | "unknown";

export interface FailureRecoveryActions {
  /**
   * Offer "Enable HEVC playback": the channel needs the HEVC Video
   * Extensions and the shell can install them through the public
   * `ensureHevcDecodable()` lib (the same call the legacy panel
   * made) — only for HEVC-classified failures.
   */
  hevc: boolean;
  /**
   * Offer "Open in external player": the embedded decoder cannot
   * play this stream (HEVC / codec / audio) and an external player
   * may. The shell clicks the engine's own `#external-launch-btn`
   * (wired with the real stream URL + headers by stream.ts) — it
   * never rebuilds the launch itself. Availability is checked at
   * click time via `hasAvailableExternalPlayer()`.
   */
  external: boolean;
}

/**
 * Which kind-aware recovery actions the shell error overlay offers
 * for a failed tune. Pure: the caller still gates on runtime
 * availability (Windows desktop for HEVC, a configured external
 * player + the engine's launch button for external).
 *
 * Audio is deliberately absent: the engine auto-attempts its
 * one-shot audio-proxy fix on an audio start failure BEFORE the
 * failure panel (stream.ts `fixAudioNow`), and the fix flag +
 * replay live inside the engine with no public seam — by the time
 * the shell overlay shows, the fix has already run once and a
 * second shell-side button could not re-arm it. Retry stays the
 * audio path. Connection-limit / parse / unknown offer Retry /
 * Previous / Home only.
 */
export function recoveryActionsForFailureKind(
  kind: string | null | undefined,
): FailureRecoveryActions {
  const hevc = kind === "hevc" || kind === "hevc-likely";
  const external =
    kind === "hevc" || kind === "hevc-likely" || kind === "codec" || kind === "audio";
  return { hevc, external };
}

// ── Highlighted-row programme artwork (Quick Surf) ───────────────

/**
 * Structural shape of W2's `ProgrammeArtwork` (contracts) as the
 * surf row needs it. The surf script loads the W2 module
 * (`src/scripts/lib/livetv-enrichment.ts`) only when it exists
 * (import.meta.glob — absent at 0.10.1 base, present after W2
 * lands); this type is the local contract so the row never depends
 * on W2's module being importable at build time.
 */
export interface SurfProgrammeArtwork {
  backdropUrl: string | null;
  posterUrl: string | null;
  stillUrl: string | null;
  source: string;
}

/**
 * Best single artwork URL for a Quick Surf highlighted row: the
 * episode still first (most specific to what's on now), then the
 * series/movie backdrop, then the poster. Null when the enrichment
 * has nothing usable — the row then shows no thumb at all, never a
 * placeholder rectangle.
 */
export function artworkUrlForSurf(
  art: SurfProgrammeArtwork | null | undefined,
): string | null {
  if (!art) return null;
  return art.stillUrl ?? art.backdropUrl ?? art.posterUrl ?? null;
}

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

export interface FailureRecovery {
  /** Stream that keeps playing under the error state (null: none). */
  keepId: string | number | null;
  /** Retry target (failed channel, else last working). */
  retryId: string | number | null;
  /** Previous-channel escape hatch (null: no previous to go to). */
  previousId: string | number | null;
}

/**
 * One failed switch, resolved as a whole: the current stream is
 * preserved (never torn down by the failure), and the caller is
 * offered retry of the failed channel, return to the previous
 * channel, or Home — at least one recovery is always present while
 * any stream exists. Pure: resolving a failure never tunes.
 */
export function failureRecovery(
  failedChannelId: string | number | null | undefined,
  currentChannelId: string | number | null | undefined,
  previousChannelIdValue: string | number | null | undefined,
  lastWorkingChannelId: string | number | null | undefined,
): FailureRecovery {
  const keepId = streamToKeepOnFailure(failedChannelId, currentChannelId);
  return {
    keepId,
    retryId: retryTarget(failedChannelId, lastWorkingChannelId),
    previousId: previousChannelTarget(currentChannelId, previousChannelIdValue),
  };
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
