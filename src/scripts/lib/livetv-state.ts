// RedSilk Couch — Live TV state model (W5, canonical owner, 0.9.0).
//
// ONE coherent model for the Live TV landing / browser / playback /
// Guide modes. Pure and DOM-free: every transition takes a state and
// returns a NEW state (inputs are never mutated), so the model is
// fully unit-testable and W1 (Landing) / W2 (Browser) / W3
// (Playback+Quick Surf) / W4 (Guide) all code against this exact API
// instead of each keeping their own copy of "which channel".
//
// The distinction the whole model exists to enforce:
//
//   - `highlightedChannelId` — the channel the user is BROWSING
//     (focused / hovered / arrowed-onto). Highlighting NEVER tunes.
//   - `tunedChannelId` — the channel actually PLAYING (or last
//     watched). Tuning is always an explicit act (enterPlayback /
//     tuneTo) and always records `previousChannelId` first.
//
// Modes (0.9.0): "landing" | "browser" | "playback" | "guide".
// The legacy mode name "home" is an alias for "landing" wherever a
// mode is ACCEPTED (setMode in the shell, requestLivetvMode,
// parseLivetvState) — it is never stored: state.mode is always one
// of the four canonical modes.
//
// Persistence (sessionStorage key `redsilk:livetv:state`) keeps only
// mode + tuned + previous + guide date, exactly as before.
// guideMode / browserFilter / openSearch / lastLandingCard /
// guideReturnTo are session-only and are NOT persisted. The overlay
// is NEVER persisted: reopening the app must never restore a stale
// OSD / browser / programme dialog on top of the landing screen.

export type LivetvMode = "landing" | "browser" | "playback" | "guide";

/** Legacy mode name, accepted wherever a mode is accepted. */
export type LivetvModeInput = LivetvMode | "home";

/** Guide sub-mode (RTÉ Guide-style tabs): On Now / Tonight / By Channel / grid. */
export type GuideMode = "now" | "tonight" | "channel" | "grid";

/** What the Channel Browser is filtered to when it opens. */
export interface LivetvBrowserFilter {
  kind: "all" | "favourites" | "recents" | "category";
  value?: string;
}

/** Normalise a mode input: legacy "home" → "landing". */
export function normaliseLivetvMode(mode: LivetvModeInput): LivetvMode {
  return mode === "home" ? "landing" : mode;
}

/**
 * `?mode=` URL param → canonical mode, or null when the param is
 * absent / unknown. Mapping: guide→guide, browser→browser,
 * landing/home→landing, playback→playback. The shell (livetv.astro)
 * uses this for its initial mode; unknown values fall through to
 * the persisted / playing / landing default.
 */
export function parseLivetvModeParam(
  value: string | null | undefined,
): LivetvMode | null {
  if (value === "guide") return "guide";
  if (value === "browser") return "browser";
  if (value === "playback") return "playback";
  if (value === "landing" || value === "home") return "landing";
  return null;
}

/** True for any canonical mode or the legacy "home" alias. */
export function isLivetvMode(value: unknown): value is LivetvModeInput {
  return (
    value === "landing" ||
    value === "browser" ||
    value === "playback" ||
    value === "guide" ||
    value === "home"
  );
}

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
  /** Guide sub-mode (On Now / Tonight / By Channel / grid). Session-only. */
  guideMode: GuideMode;
  /** Browser filter applied when the browser opens. Session-only. */
  browserFilter: LivetvBrowserFilter | null;
  /** Entry flag: open the browser with search focused. Session-only. */
  openSearch: boolean;
  /** data-focus-key of the last selected landing card. Session-only. */
  lastLandingCard: string | null;
  /** Mode to return to on exitGuide. Session-only. */
  guideReturnTo: LivetvMode;
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

/** Fresh default state: landing, nothing tuned, Guide on today / On Now. */
export function createLivetvState(nowMs: number = Date.now()): LivetvState {
  return {
    mode: "landing",
    overlay: "none",
    tunedChannelId: null,
    highlightedChannelId: null,
    previousChannelId: null,
    guideDateMs: startOfLocalDayMs(nowMs),
    guideChannelId: null,
    guideProgrammeKey: null,
    returnFocusKey: null,
    guideMode: "now",
    browserFilter: null,
    openSearch: false,
    lastLandingCard: null,
    guideReturnTo: "landing",
  };
}

function isValidMode(value: unknown): value is LivetvMode {
  return (
    value === "landing" ||
    value === "browser" ||
    value === "playback" ||
    value === "guide"
  );
}

function isValidGuideMode(value: unknown): value is GuideMode {
  return (
    value === "now" ||
    value === "tonight" ||
    value === "channel" ||
    value === "grid"
  );
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
 * Leave playback for the Live TV landing. The tuned channel is KEPT
 * as the last-watched channel (it is still the "active stream" for
 * resume / previous-channel), only the mode and overlay change.
 */
export function exitPlaybackToLanding(state: LivetvState): LivetvState {
  return { ...state, mode: "landing", overlay: "none" };
}

/**
 * @deprecated Renamed in 0.9.0: use `exitPlaybackToLanding`. Kept so
 * existing callers (W3's playback shell) keep working unchanged.
 */
export const exitPlaybackToHome: typeof exitPlaybackToLanding =
  exitPlaybackToLanding;

/**
 * Enter the landing screen. Mode + overlay only — the tuned channel,
 * highlight and Guide position are kept, so Resume / What's On Now
 * still know what was playing.
 */
export function enterLanding(state: LivetvState): LivetvState {
  return { ...state, mode: "landing", overlay: "none" };
}

/**
 * Enter the Channel Browser. `filter` selects what the browser
 * shows (all / favourites / recents / one category); `openSearch`
 * opens it with search focused; `returnFocusKey` remembers the
 * landing card to restore focus to on exit. Omitted arguments keep
 * the current values (a null filter clears the filter).
 */
export function enterBrowser(
  state: LivetvState,
  filter?: LivetvBrowserFilter | null,
  openSearch?: boolean,
  returnFocusKey?: string | null,
): LivetvState {
  return {
    ...state,
    mode: "browser",
    overlay: "none",
    browserFilter: filter !== undefined ? filter : state.browserFilter,
    openSearch: openSearch !== undefined ? openSearch : state.openSearch,
    returnFocusKey:
      returnFocusKey !== undefined ? returnFocusKey : state.returnFocusKey,
  };
}

/** Leave the Channel Browser for the landing screen. */
export function exitBrowser(state: LivetvState): LivetvState {
  return { ...state, mode: "landing", overlay: "none", openSearch: false };
}

/** Switch the Guide sub-mode (On Now / Tonight / By Channel / grid). */
export function setGuideMode(
  state: LivetvState,
  guideMode: GuideMode,
): LivetvState {
  return { ...state, guideMode };
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
 * previously recorded key is kept. `guideMode` switches the
 * sub-mode; when omitted the current sub-mode is kept (defaulting
 * to "now" when the state somehow has none). `guideReturnTo`
 * records the mode exitGuide returns to when it is called without
 * an explicit mode (0.11.0: previously the field existed but no
 * transition ever wrote it — TvGuideView set it with an object
 * spread after enterGuide, and leaveGuide read a local instead,
 * so the field was write-only decoration).
 */
export function enterGuide(
  state: LivetvState,
  returnFocusKey?: string | null,
  guideMode?: GuideMode,
  guideReturnTo?: LivetvModeInput | null,
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
    guideMode:
      guideMode ?? (isValidGuideMode(state.guideMode) ? state.guideMode : "now"),
    guideReturnTo:
      guideReturnTo != null
        ? normaliseLivetvMode(guideReturnTo)
        : state.guideReturnTo,
  };
}

/**
 * Leave the Guide. `returnTo` is the mode the Guide was entered
 * from — "landing" by default; callers that opened the Guide from
 * fullscreen playback pass "playback". When `returnTo` is omitted
 * the mode recorded by enterGuide (`guideReturnTo`) is used, so the
 * Guide's entry mode is the single source of truth instead of a
 * caller-local copy. Guide position (`guideChannelId` /
 * `guideProgrammeKey` / `guideDateMs` / `guideMode`) is kept so
 * re-entering restores it, and `returnFocusKey` is kept for the
 * caller to focus on exit.
 */
export function exitGuide(
  state: LivetvState,
  returnTo?: LivetvModeInput,
): LivetvState {
  return {
    ...state,
    mode: normaliseLivetvMode(returnTo ?? state.guideReturnTo ?? "landing"),
    overlay: "none",
  };
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
 * date. The legacy persisted mode "home" maps to "landing". A parsed
 * state always starts with overlay "none" and the highlight / guide
 * anchor on the tuned channel; the session-only fields
 * (guideMode / browserFilter / openSearch / lastLandingCard /
 * guideReturnTo) take their defaults.
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
  if (!isLivetvMode(record["mode"])) return null;
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
  const mode = normaliseLivetvMode(record["mode"]);
  return {
    mode,
    overlay: "none",
    tunedChannelId: tuned,
    highlightedChannelId: tuned,
    previousChannelId: asId(record["previousChannelId"]),
    guideDateMs: record["guideDateMs"],
    guideChannelId: tuned,
    guideProgrammeKey: null,
    returnFocusKey: null,
    guideMode: "now",
    browserFilter: null,
    openSearch: false,
    lastLandingCard: null,
    guideReturnTo: "landing",
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
 * Persist a mode change WITHOUT knowing the rest of the state.
 * The shell (livetv.astro) is the single writer of the current
 * mode, but it holds no LivetvState — it only knows the mode. So
 * this reads back whatever is stored, replaces just the mode, and
 * re-persists: tuned / previous / guide date survive untouched.
 * (0.11.0: before this, only TvGuideView ever persisted, so a
 * mode change made anywhere else was lost on reload and the
 * stored mode could disagree with the mode on screen.)
 */
export function persistLivetvMode(
  mode: LivetvModeInput,
  storage: StorageLike | null = sessionStore(),
): void {
  if (!storage) return;
  const restored = restoreLivetvState(storage);
  persistLivetvState(
    { ...restored, mode: normaliseLivetvMode(mode) },
    storage,
  );
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
export { isValidOverlay, isValidGuideMode, isValidMode };
