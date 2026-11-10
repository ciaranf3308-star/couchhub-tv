// RedSilk Couch — Live TV + EPG pure helpers (W3).
//
// Pure, DOM-free math for the rebuilt Live TV and EPG screens. No
// fetching, no invented data: every function derives its answer from
// real programme / channel records handed in by the caller. The
// rendering engines stay where they are — stream.ts owns channel
// loading + playback, epg.ts owns the guide grid — this module only
// holds the small, testable decisions both screens share:
//
//   - programme state / progress / time labels (EPG cells, channel
//     rows, the now/next strip),
//   - EPG cell geometry (programme -> px on the timeline track),
//   - EPG row windowing for large channel counts (thin wrapper over
//     the W1 computeVisibleWindow, columns = 1),
//   - channel selection (index lookup, previous-channel, digit zap
//     via the shared osd-zap resolver),
//   - catch-up gating (replay vs watch-from-start vs none — the same
//     channelSupportsCatchup / isCatchupPlayable rules epg.ts uses,
//     so a catch-up action is only ever offered where the provider
//     actually supports it),
//   - the Live OSD action table (which key / button does what).
//
// Reused, never rewritten: computeVisibleWindow (couch-grid),
// stepChannelIndex / channelKeyDirection (channel-step),
// formatTimeRange (now-next), channelSupportsCatchup /
// isCatchupPlayable (catchup), resolveZapTarget (tv/osd-zap).
import { computeVisibleWindow } from "./couch-grid";
import type { GridWindow } from "./couch-grid";
import { stepChannelIndex } from "./channel-step";
import { formatTimeRange } from "./now-next";
import {
  channelSupportsCatchup,
  isCatchupPlayable,
} from "./catchup";
import type { CatchupCapableChannel } from "./catchup";
import { resolveZapTarget } from "../tv/osd-zap";

// ── Programme state / progress / labels ─────────────────────────

/** "now" when [start, stop) contains `nowMs`, else past / upcoming. */
export type ProgrammeState = "now" | "past" | "upcoming";

export function programmeState(
  startMs: number,
  stopMs: number,
  nowMs: number = Date.now(),
): ProgrammeState {
  if (stopMs <= nowMs) return "past";
  if (startMs <= nowMs) return "now";
  return "upcoming";
}

/**
 * Fraction of [start, stop) elapsed at `nowMs`, clamped to 0..1.
 * 0 when the span is empty or inverted — never NaN, never > 1.
 */
export function programmeProgress(
  startMs: number,
  stopMs: number,
  nowMs: number = Date.now(),
): number {
  const span = stopMs - startMs;
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(1, (nowMs - startMs) / span));
}

/**
 * "20:00–21:00" style range label. Same shape as now-next's
 * formatTimeRange — re-exported here so the EPG screens have one
 * import surface for all their time math.
 */
export function epgTimeRangeLabel(
  startMs: number,
  stopMs: number,
  locale?: string,
): string {
  return formatTimeRange(startMs, stopMs, locale);
}

// ── EPG cell geometry ───────────────────────────────────────────

export interface EpgCellGeometryInput {
  /** Programme start (ms epoch, display time — same clock as the view). */
  startMs: number;
  /** Programme stop (ms epoch). */
  stopMs: number;
  /** Left edge of the visible time window (ms epoch). */
  viewStartMs: number;
  /** Pixels per hour on the timeline track. */
  pxPerHour: number;
  /** Total px width of the timeline track. */
  trackWidthPx: number;
}

export interface EpgCellGeometry {
  /** px from the track's left edge, clamped to [0, trackWidth]. */
  leftPx: number;
  /** px wide, clamped to the track, minimum 2 so a sliver stays visible. */
  widthPx: number;
}

/**
 * Programme -> px on the timeline track. Mirrors the geometry epg.ts
 * paints (left = (start - viewStart) / hour * pxPerHour, clamped to
 * the visible window). A programme entirely outside the window
 * collapses to a 2px sliver at the nearest edge — it is never given
 * a negative position or a negative width.
 */
export function epgCellGeometry(input: EpgCellGeometryInput): EpgCellGeometry {
  const { startMs, stopMs, viewStartMs, pxPerHour, trackWidthPx } = input;
  const width = Math.max(0, trackWidthPx);
  const perHour = Math.max(0, pxPerHour);
  const toX = (ts: number) => ((ts - viewStartMs) / 3_600_000) * perHour;
  const left = Math.max(0, Math.min(width, toX(startMs)));
  const right = Math.max(0, Math.min(width, toX(stopMs)));
  return { leftPx: left, widthPx: Math.max(2, right - left) };
}

// ── EPG row windowing (large channel counts) ────────────────────

export interface EpgRowWindowInput {
  /** Total channel rows in the guide. */
  totalRows: number;
  /** One row's height in px. */
  rowHeightPx: number;
  /** Current vertical scroll offset in px. */
  scrollTopPx: number;
  /** Viewport (scroll container) height in px. */
  viewportHeightPx: number;
  /** Extra rows rendered above/below the viewport. Default 2. */
  overscanRows?: number;
}

/**
 * Which channel rows to render for a scroll position. The guide is a
 * single-column list, so this is computeVisibleWindow with
 * columns = 1 — a 10,000-channel guide only ever builds the visible
 * window plus overscan, never 10,000 row nodes.
 */
export function epgRowWindow(input: EpgRowWindowInput): GridWindow {
  return computeVisibleWindow({
    total: input.totalRows,
    columns: 1,
    rowHeight: input.rowHeightPx,
    scrollTop: input.scrollTopPx,
    viewportHeight: input.viewportHeightPx,
    overscanRows: input.overscanRows ?? 2,
  });
}

// ── Channel selection ───────────────────────────────────────────

export interface ChannelIdentity {
  id: string | number;
}

/** Index of `id` in `channels`, or -1 when it is not listed. */
export function channelIndexById(
  channels: ReadonlyArray<ChannelIdentity>,
  id: string | number | null | undefined,
): number {
  if (id === null || id === undefined) return -1;
  return channels.findIndex((channel) => channel.id === id);
}

/**
 * Next / previous channel index with wrap-around (reuses the shared
 * stepChannelIndex). null when the list is empty. A current index
 * outside the list steps to the first (delta > 0) or last
 * (delta < 0) channel, matching the player behaviour.
 */
export function stepChannel(
  currentIndex: number,
  count: number,
  delta: number,
): number | null {
  return stepChannelIndex(currentIndex, count, delta);
}

/**
 * The channel to return to with "previous channel": the last-played
 * id, or null when there is none (or it is the channel already
 * playing — returning to yourself is a no-op, not a retune).
 */
export function previousChannelId(
  currentId: string | number | null | undefined,
  previousId: string | number | null | undefined,
): string | number | null {
  if (previousId === null || previousId === undefined) return null;
  if (currentId !== null && currentId !== undefined && previousId === currentId) {
    return null;
  }
  return previousId;
}

/** Digit-buffer zap: exact channel-number match wins, else 1-based list position. */
export function zapChannelForDigits(
  digits: string,
  channels: ReadonlyArray<{ id: string | number; chno?: number | null }>,
): { id: string | number; chno?: number | null } | null {
  return resolveZapTarget(digits, [...channels]);
}

// ── Catch-up gating ─────────────────────────────────────────────

export type CatchupAction = "replay" | "watch-from-start" | "none";

export interface CatchupProgrammeInput {
  channel: CatchupCapableChannel;
  /** Programme start (ms epoch, raw XMLTV time — never tvg-shifted). */
  startMs: number;
  /** Programme stop (ms epoch). */
  stopMs: number;
  nowMs?: number;
}

/**
 * Which catch-up action — if any — a programme honestly offers.
 * Past programmes on a catch-up-capable channel inside the archive
 * window can replay; a live programme on such a channel can restart
 * from the beginning. Anything else offers nothing: catch-up is
 * never invented for a channel that does not support it.
 */
export function catchupActionForProgramme(
  input: CatchupProgrammeInput,
): CatchupAction {
  const nowMs = input.nowMs ?? Date.now();
  const state = programmeState(input.startMs, input.stopMs, nowMs);
  if (!channelSupportsCatchup(input.channel)) return "none";
  if (!isCatchupPlayable(input.channel, input.startMs, nowMs)) return "none";
  if (state === "past") return "replay";
  if (state === "now") return "watch-from-start";
  return "none";
}

// ── Live OSD action table ───────────────────────────────────────

export type LivetvOsdAction =
  | "channel-up"
  | "channel-down"
  | "previous-channel"
  | "pause-toggle"
  | "mute"
  | "fullscreen"
  | "guide"
  | "channels"
  | "favourites"
  | "home"
  | "audio"
  | "subtitles"
  | "dismiss";

/**
 * Key -> OSD action. Keys marked `playerOwned` below are handled by
 * stream.ts's own keydown listener (tune, pause, mute, fullscreen):
 * the OSD buttons dispatch them as synthetic keydown events and the
 * player does the work — the OSD never reimplements tuning or
 * transport. The OSD's own keydown listener only intercepts the
 * OSD-owned keys (guide / channels / favourites / home / dismiss),
 * so there is exactly one handler per key.
 */
const OSD_KEY_ACTIONS: Readonly<Record<string, LivetvOsdAction>> = {
  "[": "channel-down",
  "]": "channel-up",
  "\\": "previous-channel",
  " ": "pause-toggle",
  spacebar: "pause-toggle",
  m: "mute",
  f: "fullscreen",
  g: "guide",
  c: "channels",
  v: "favourites",
  h: "home",
  Escape: "dismiss",
};

/** Keys the OSD's own keydown listener intercepts (the rest already have a global handler). */
const OSD_OWNED_KEYS: ReadonlySet<string> = new Set([
  "g",
  "c",
  "v",
  "h",
  "Escape",
]);

export function livetvOsdActionForKey(
  key: string | null | undefined,
): LivetvOsdAction | null {
  if (!key) return null;
  return OSD_KEY_ACTIONS[key] ?? OSD_KEY_ACTIONS[key.toLowerCase()] ?? null;
}

/** True when the OSD's keydown listener should handle this key itself. */
export function isOsdOwnedKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return OSD_OWNED_KEYS.has(key) || OSD_OWNED_KEYS.has(key.toLowerCase());
}
