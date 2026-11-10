// RedSilk Couch — Live TV state model (W3, canonical owner).
//
// ONE coherent model for the Live TV Home / playback / Guide modes.
// Pure and DOM-free: every transition takes a state and returns a NEW
// state (inputs are never mutated), so the model is fully unit-testable
// and W1 (Home) / W2 (playback) / W3 (Guide) all code against this
// exact API instead of each keeping their own copy of "which channel".
//
// The distinction the whole model exists to enforce:
//
//   - `highlightedChannelId` — the channel the user is BROWSING
//     (focused / hovered / arrowed-onto). Highlighting NEVER tunes.
//   - `tunedChannelId` — the channel actually PLAYING (or last
//     watched). Tuning is always an explicit act (enterPlayback /
//     tuneTo) and always records `previousChannelId` first.
//
// Persistence (sessionStorage key `redsilk:livetv:state`) keeps only
// mode + tuned + previous + guide date. The overlay is NEVER
// persisted: reopening the app must never restore a stale OSD /
// browser / programme dialog on top of the Home screen.

export type LivetvMode = "home" | "playback" | "guide";

export type LivetvOverlay =
  | "none"
  | "osd"
  | "quicksurf"
  | "browser"
  | "options"
  | "programme";

export interface LivetvState {
  mode: LivetvMode;
  overlay: LivetvOverlay;
  tunedChannelId: string | null;
  highlightedChannelId: string | null;
  previousChannelId: string | null;
  /** Local-midnight ms of the day the Guide is showing. */
  guideDateMs: number;
  /** Channel the Guide is anchored on (usually the tuned channel). */
  guideChannelId: string | null;
  /** Stable programme key (`guideProgrammeKey`) the Guide restores. */
  guideProgrammeKey: string | null;
  /** data-focus-key to restore when leaving the Guide / an overlay. */
  returnFocusKey: string | null;
}

/** sessionStorage key. Overlay is never written under it. */
export const LIVETV_STATE_STORAGE_KEY = "redsilk:livetv:state";

/** Local-midnight ms for `ms` (the Guide's day granularity). */
export function startOfLocalDayMs(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Stable programme key: `<channelId>@<startMs>`. Survives EPG refreshes. */
export function guideProgrammeKey(
  channelId: string,
  startMs: number,
): string {
  return `${channelId}@${startMs}`;
}

/** Fresh default state: Home, nothing tuned, Guide on today. */
export function createLivetvState(nowMs: number = Date.now()): LivetvState {
  return {
    mode: "home",
    overlay: "none",
    tunedChannelId: null,
    highlightedChannelId: null,
    previousChannelId: null,
    guideDateMs: startOfLocalDayMs(nowMs),
    guideChannelId: null,
    guideProgrammeKey: null,
    returnFocusKey: null,
  };
}

function isValidMode(value: unknown): value is LivetvMode {
  return value === "home" || value === "playback" || value === "guide";
}

function isValidOverlay(value: unknown): value is LivetvOverlay {
  return (
    value === "none" ||
    value === "osd" ||
    value === "quicksurf" ||
    value === "browser" ||
    value === "options" ||
    value === "programme"
  );
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Start (or resume) playback of a channel. Records the previously
 * tuned channel as `previousChannelId` (when it differs), tunes, and
 * highlights the playing channel. Any open overlay is dismissed.
 */
export function enterPlayback(
  state: LivetvState,
  channelId: string,
): LivetvState {
  const previous =
    state.tunedChannelId !== null && state.tunedChannelId !== channelId
      ? state.tunedChannelId
      : state.previousChannelId;
  return {
    ...state,
    mode: "playback",
    overlay: "none",
    tunedChannelId: channelId,
    highlightedChannelId: channelId,
    previousChannelId: previous,
  };
}

/**
 * Leave playback for Live TV Home. The tuned channel is KEPT as the
 * last-watched channel (it is still the "active stream" for resume /
 * previous-channel), only the mode and overlay change.
 */
export function exitPlaybackToHome(state: LivetvState): LivetvState {
  return { ...state, mode: "home", overlay: "none" };
}

/**
 * Retune while staying in the current mode. Records the previously
 * tuned channel as `previousChannelId` (when it differs) and moves
 * the highlight onto the new channel. Tuning to the channel already
 * playing is a no-op for `previousChannelId` (it is never clobbered
 * with the channel itself).
 */
export function tuneTo(state: LivetvState, channelId: string): LivetvState {
  const previous =
    state.tunedChannelId !== null && state.tunedChannelId !== channelId
      ? state.tunedChannelId
      : state.previousChannelId;
  return {
    ...state,
    tunedChannelId: channelId,
    highlightedChannelId: channelId,
    previousChannelId: previous,
  };
}

/**
 * Browse onto a channel. Highlight ONLY — `tunedChannelId` is
 * untouched, ALWAYS, even when a channel is already playing. This is
 * the invariant the whole model exists to enforce: moving around the
 * browser / Guide / Quick Surf must never retune the stream.
 */
export function highlightChannel(
  state: LivetvState,
  channelId: string,
): LivetvState {
  return { ...state, highlightedChannelId: channelId };
}

/** Open an overlay on top of the current mode. */
export function openOverlay(
  state: LivetvState,
  overlay: LivetvOverlay,
): LivetvState {
  return { ...state, overlay };
}

/** Close whatever overlay is open. Mode and channel state are untouched. */
export function closeOverlay(state: LivetvState): LivetvState {
  return { ...state, overlay: "none" };
}

/**
 * Enter the Guide. The tuned channel and the caller's focus are
 * preserved: the Guide anchors on the tuned channel (when there is
 * one) and `returnFocusKey` remembers where focus goes back to on
 * exit. Pass the focus key of the element that opened the Guide
 * (e.g. the Guide button / playing channel card); when omitted the
 * previously recorded key is kept.
 */
export function enterGuide(
  state: LivetvState,
  returnFocusKey?: string | null,
): LivetvState {
  return {
    ...state,
    mode: "guide",
    overlay: "none",
    guideChannelId: state.tunedChannelId ?? state.guideChannelId,
    returnFocusKey:
      returnFocusKey !== undefined ? returnFocusKey : state.returnFocusKey,
    guideDateMs: Number.isFinite(state.guideDateMs)
      ? state.guideDateMs
      : startOfLocalDayMs(Date.now()),
  };
}

/**
 * Leave the Guide. `returnTo` is the mode the Guide was entered
 * from — "home" by default; callers that opened the Guide from
 * fullscreen playback pass "playback". Guide position
 * (`guideChannelId` / `guideProgrammeKey` / `guideDateMs`) is kept
 * so re-entering restores it, and `returnFocusKey` is kept for the
 * caller to focus on exit.
 */
export function exitGuide(
  state: LivetvState,
  returnTo: LivetvMode = "home",
): LivetvState {
  return { ...state, mode: returnTo, overlay: "none" };
}

/** Persisted shape: mode + tuned + previous + guide date ONLY. */
export interface SerializedLivetvState {
  v: 1;
  mode: LivetvMode;
  tunedChannelId: string | null;
  previousChannelId: string | null;
  guideDateMs: number;
}

/** Serialise for storage. The overlay is deliberately not included. */
export function serializeLivetvState(state: LivetvState): string {
  const persisted: SerializedLivetvState = {
    v: 1,
    mode: state.mode,
    tunedChannelId: state.tunedChannelId,
    previousChannelId: state.previousChannelId,
    guideDateMs: state.guideDateMs,
  };
  return JSON.stringify(persisted);
}

/**
 * Parse a serialised state. Returns null on ANY garbage: unparseable
 * JSON, wrong shape, unknown mode, non-string ids, non-finite guide
 * date. A parsed state always starts with overlay "none" and the
 * highlight / guide anchor on the tuned channel.
 */
export function parseLivetvState(raw: unknown): LivetvState | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== 1) return null;
  if (!isValidMode(record["mode"])) return null;
  if (
    record["tunedChannelId"] !== null &&
    typeof record["tunedChannelId"] !== "string"
  ) {
    return null;
  }
  if (
    record["previousChannelId"] !== null &&
    typeof record["previousChannelId"] !== "string"
  ) {
    return null;
  }
  if (
    typeof record["guideDateMs"] !== "number" ||
    !Number.isFinite(record["guideDateMs"])
  ) {
    return null;
  }
  const tuned = asId(record["tunedChannelId"]);
  return {
    mode: record["mode"],
    overlay: "none",
    tunedChannelId: tuned,
    highlightedChannelId: tuned,
    previousChannelId: asId(record["previousChannelId"]),
    guideDateMs: record["guideDateMs"],
    guideChannelId: tuned,
    guideProgrammeKey: null,
    returnFocusKey: null,
  };
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Persist the state (mode + tuned + previous + guide date only). */
export function persistLivetvState(
  state: LivetvState,
  storage: StorageLike | null = sessionStore(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LIVETV_STATE_STORAGE_KEY, serializeLivetvState(state));
  } catch {
    // Storage full / unavailable: persistence is a nicety, never fatal.
  }
}

/**
 * Restore the persisted state, or a fresh default when nothing was
 * stored (or what was stored is garbage). Never throws.
 */
export function restoreLivetvState(
  storage: StorageLike | null = sessionStore(),
): LivetvState {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(LIVETV_STATE_STORAGE_KEY) ?? null;
  } catch {
    return createLivetvState();
  }
  return parseLivetvState(raw) ?? createLivetvState();
}

/** Re-exported so callers can validate a raw overlay value. */
export { isValidOverlay };
