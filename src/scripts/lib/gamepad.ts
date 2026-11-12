// Nylah Studios — Xbox controller input: NATIVE XInput (primary) +
// browser Gamepad API (fallback).
//
// 0.11.4 (W6): the browser Gamepad API is NO LONGER the primary
// path. It failed on the user's PC twice — the controller works in
// games but the app never saw it (0.11.0, then the 0.11.1 four-break
// fix). The browser layer is where the input keeps getting lost:
// WebView2 hides an already-connected pad behind an
// anti-fingerprinting gesture gate until its first button press, and a
// `gamepadconnected` fired before this page's listener exists is lost
// forever. The primary path is now native: Rust polls XInput (the API
// games use — src-tauri/src/xinput.rs, 8 ms, from cold launch) and
// forwards button edges + directions as Tauri events; this module's
// exported `dispatchNativeButton` / `dispatchNativeDirection` feed
// them into the SAME action pipeline below (one focus engine, not
// two). The browser loop below stays only as the fallback for
// non-XInput pads — and it stands down while native input is live, so
// one physical press can never fire twice (see noteNativeInputActive).
//
// Upstream Extreme InfiniTV already navigates by keyboard / D-pad through
// spatial-navigation.js, but it has no Gamepad API support at all (no
// `gamepad` string anywhere in src/). This module bridges that gap without
// touching any screen: it polls the first standard-mapping controller and
// turns its buttons/sticks into the keyboard events the app already
// understands (arrows, Enter, Escape), so every existing view — Live TV,
// Movies, Series, EPG, search, settings, dialogs — gains controller
// navigation for free.
//
// Mapping (standard mapping, Xbox controller):
//   D-pad / left stick .... move focus (spatial navigation; on the home
//                            page the rail-aware model below takes over)
//   A .................... activate the focused item
//   B .................... back (Escape — closes dialogs, exits fullscreen
//                            playback, per the app's own handlers)
//   X .................... details of the focused card (opens its detail
//                            page without autoplay); in the player it
//                            stays play / pause — see inPlayerContext()
//   Y .................... search; in the player it stays fullscreen
//                            toggle — see inPlayerContext()
//   LB / RB .............. seek -10s / +10s (video with a duration only)
//   LT / RT .............. volume down / up
//   Menu (Start) ......... open Settings
//   View + Menu, held 2s . return home (dispatches `couchhubtv:return-home`,
//                            handled by return-home.ts; see that file)
//
// Safety rules:
//   - Edge-triggered buttons (a held button fires once); D-pad/stick
//     repeat after a 350 ms initial delay, then every 140 ms.
//   - Dead zone 0.30 on the left stick, so drift never moves focus.
//   - While a text field is focused, navigation keys are left to the
//     field (only B / View+Menu keep working, so the user can always
//     blur out and return home).
//   - While a modal dialog is open, directions / A / B belong to the
//     dialog only (see modalFocusTarget below); X / Y / Menu do
//     nothing, so the page behind the dialog receives no navigation
//     input at all. Seek / volume keep working — they are media
//     controls, not navigation — and View+Menu return-home stays
//     available as the global escape hatch.
//   - The poll loop runs on requestAnimationFrame and stops entirely
//     while the window is hidden, so a minimised/hidden app costs nothing.
//   - No double activation: synthetic keyboard events are only produced
//     from gamepad edges, and physical keyboard events take their own
//     path — one press, one action, from either device.

import {
  findOpenModal,
  firstFocusableInModal,
} from "@/scripts/lib/dialog-spatial-nav.js";
import { dispatchLivetvBack } from "@/scripts/lib/livetv-keys.ts";
// 0.11.10 (W6): Cursor Mode guard — see the guard at the top of
// handleGamepadButtonPress. This module owns the guard region only;
// cursor-mode.ts owns the pointer state machine.
import {
  dispatchCursorClick,
  isCursorModeActive,
  isCursorModeEnabled,
  setCursorModeActive,
  toggleCursorMode,
} from "@/scripts/lib/cursor-mode.ts";

const RETURN_HOME_HOLD_MS = 2000;
const STICK_DEAD_ZONE = 0.3;
const REPEAT_INITIAL_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 140;

// Standard-mapping button indices.
const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_Y = 3;
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_LT = 6;
const BTN_RT = 7;
const BTN_VIEW = 8;
const BTN_MENU = 9;
// 0.11.10 (W6): R3 — right-stick click. Toggles Cursor Mode when the
// setting is enabled; otherwise the same no-op it always was. L3 (10)
// stays unmapped.
const BTN_RIGHT_THUMB = 11;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

export type Direction = "up" | "down" | "left" | "right";

const ARROW_KEY: Record<Direction, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

// ──────────────────────────────────────────────────────────────────────
// SHARED ACTION PIPELINE (0.11.4 W6) — one focus engine, two sources.
//
// The browser poll loop in mountGamepad() and the native XInput path
// (native-gamepad.ts, fed by Rust xinput.rs events) BOTH drive the
// functions in this section. A button press from either source runs
// the same code: same modal rules, same Live TV contexts, same
// editing-field gate. Do not add a second action implementation for
// the native path — extend these functions and both paths gain it.
// ──────────────────────────────────────────────────────────────────────

// Native (XInput) button names -> standard-mapping indices, so the
// Rust event payload ("a", "menu", ...) lands on the same branch the
// browser loop uses. D-pad buttons are directions, not actions: Rust
// sends them as xinput-direction events, never here.
export const NATIVE_BUTTON_INDEX: Record<string, number> = {
  a: BTN_A,
  b: BTN_B,
  x: BTN_X,
  y: BTN_Y,
  lb: BTN_LB,
  rb: BTN_RB,
  lt: BTN_LT,
  rt: BTN_RT,
  view: BTN_VIEW,
  menu: BTN_MENU,
  left_stick: 10,
  right_stick: 11,
};

export type NativeButtonName = keyof typeof NATIVE_BUTTON_INDEX;

interface HeldDirection {
  dir: Direction;
  since: number;
  lastRepeat: number;
}

// Action state shared by both input paths. It used to live inside
// mountGamepad's closure; it is module-level now so the native path
// (which never enters the browser poll loop) sees the same held
// direction / View+Menu hold as the browser path. One mount per page
// either way — the mount guard below still applies.
const actionState: {
  held: HeldDirection | null;
  viewMenuHoldStart: number | null;
  menuPressedWithView: boolean;
} = { held: null, viewMenuHoldStart: null, menuPressedWithView: false };

function markGamepadActive(): void {
  document.documentElement.classList.add("gamepad-active");
}

/** The return-home escape hatch, shared by both paths. */
export function dispatchReturnHome(): void {
  markGamepadActive();
  window.dispatchEvent(new CustomEvent("couchhubtv:return-home"));
}

// Native-path liveness: the browser fallback stands down while the
// native path is provably delivering input, so one physical press on
// an Xbox pad (visible to BOTH XInput and the Gamepad API once its
// gesture gate opens) can never fire twice. A native event refreshes
// the window; a held native direction holds it open; 1500 ms of
// native silence hands input back to the browser fallback.
let nativeLiveUntil = 0;
let nativeDirectionHeld = false;
const NATIVE_LIVE_WINDOW_MS = 1500;

export function noteNativeInputActive(): void {
  nativeLiveUntil = performance.now() + NATIVE_LIVE_WINDOW_MS;
}

export function setNativeDirectionActive(active: boolean): void {
  nativeDirectionHeld = active;
  if (active) noteNativeInputActive();
}

function isNativePathLive(now: number): boolean {
  return nativeDirectionHeld || now < nativeLiveUntil;
}

// View + Menu held together for 2 s -> return home. Runs before the
// button branches in both paths, so Menu never opens Settings when it
// arrived as half of the return-home chord.
function noteViewMenuHeld(viewHeld: boolean, menuHeld: boolean, now: number): void {
  if (viewHeld && menuHeld) {
    actionState.menuPressedWithView = true;
    if (actionState.viewMenuHoldStart === null) actionState.viewMenuHoldStart = now;
    if (now - actionState.viewMenuHoldStart >= RETURN_HOME_HOLD_MS) {
      actionState.viewMenuHoldStart = null;
      dispatchReturnHome();
    }
  } else {
    actionState.viewMenuHoldStart = null;
    if (!menuHeld) actionState.menuPressedWithView = false;
  }
}

/**
 * Called by the native path after ITS hold timer fires return-home
 * (native-gamepad.ts): the shared hold clock must restart, or the
 * next button press while View+Menu are still held would re-fire
 * return-home immediately. menuPressedWithView stays true — Menu
 * still must not open Settings while the chord is held.
 */
export function clearViewMenuHoldTimer(): void {
  actionState.viewMenuHoldStart = null;
}

function move(dir: Direction): void {
  markGamepadActive();
  // A modal dialog owns all navigation while it is open (v0.2.1):
  // never run the rail model — it would carry focus into the page
  // behind the dialog. If focus never landed in the dialog (or
  // escaped it), pull it onto the dialog's first item and consume
  // the press; otherwise the arrow goes to spatial navigation,
  // which is restricted to the dialog's own section.
  if (findOpenModal()) {
    const pull = modalFocusTarget();
    if (pull) {
      pull.focus({ preventScroll: true });
      return;
    }
    dispatchKey(ARROW_KEY[dir]);
    return;
  }
  // Home rails get the rail-aware model; everything else falls
  // through to plain arrow keys into spatial navigation.
  if (handleRailDirection(dir)) return;
  dispatchKey(ARROW_KEY[dir]);
}

function handleDirection(dir: Direction | null, now: number): void {
  if (dir === null) {
    actionState.held = null;
    return;
  }
  if (actionState.held === null || actionState.held.dir !== dir) {
    actionState.held = { dir, since: now, lastRepeat: now };
    move(dir);
    return;
  }
  if (
    now - actionState.held.since >= REPEAT_INITIAL_DELAY_MS &&
    now - actionState.held.lastRepeat >= REPEAT_INTERVAL_MS
  ) {
    actionState.held.lastRepeat = now;
    move(dir);
  }
}

/**
 * One pressed button, from either input path. `index` is a
 * standard-mapping button index (see BTN_* above). Edge-triggered by
 * the caller: call only on the press edge, never while held. The
 * text-field gate lives here so both paths honour it: in a field only
 * B works (blur + back), every other button is swallowed.
 */
export function handleGamepadButtonPress(index: number, _now: number): void {
  // 0.11.10 (W6) CURSOR MODE GUARD — runs before ALL button routing.
  // Both input paths (native XInput + browser Gamepad API) share this
  // function, so guarding once here consumes A / RB everywhere: while
  // Cursor Mode is active they can never also activate a focused
  // control, change Live TV categories, turn Browse pages, seek
  // playback, or open a second context menu. R3 toggles (only when
  // the setting is enabled); B exits without changing the page.
  // View+Menu return-home is unaffected: the chord fires in
  // noteViewMenuHeld before this function runs on either path.
  if (index === BTN_RIGHT_THUMB) {
    if (isCursorModeEnabled()) {
      markGamepadActive();
      toggleCursorMode();
    }
    return;
  }
  if (isCursorModeActive()) {
    markGamepadActive();
    if (index === BTN_B) setCursorModeActive(false);
    else if (index === BTN_A) dispatchCursorClick("left");
    else if (index === BTN_RB) dispatchCursorClick("right");
    // Every other button is swallowed while Cursor Mode is active.
    return;
  }
  if (isEditingTarget(document.activeElement)) {
    if (index === BTN_B) {
      markGamepadActive();
      (document.activeElement as HTMLElement | null)?.blur?.();
      dispatchKey("Escape");
    }
    return;
  }
  if (index === BTN_A) {
    markGamepadActive();
    activateFocused();
    return;
  }
  if (index === BTN_B) {
    markGamepadActive();
    // W5 (0.9.0): B resolves to "back" in every Live TV context
    // (livetv-keys.ts). The gamepad dispatches `livetv:back`
    // {context} and the mode component listening for it
    // implements its own back step — landing backs out of the
    // landing, the browser returns to the landing, playback
    // closes its overlay first and then returns, the Guide
    // returns to the mode it was entered from. The gamepad does
    // NOT also dispatch a synthetic Escape here: a mode's back
    // step must run exactly once, and keyboard Escape keeps its
    // own keydown path (the mode components' existing handlers).
    // While a modal dialog is open the dialog still owns B, so
    // Escape goes to it as before.
    const liveContext = livetvContext();
    if (liveContext && findOpenModal() === null) {
      dispatchLivetvBack(window, liveContext);
    } else {
      dispatchKey("Escape");
    }
    return;
  }
  if (index === BTN_X && findOpenModal() === null) {
    markGamepadActive();
    // W3: X is unmapped in the Guide — swallow it.
    if (livetvGuideActive()) {
      // No-op by design.
    } else if (livetvPlaybackActive()) {
      dispatchKey("x");
    } else if (livetvLandingActive() || livetvBrowserActive()) {
      // W5 (0.9.0): landing X = contextual, browser X =
      // toggle-favourite — both as keys for the mode's own
      // keydown handler (livetv-keys.ts keyboard table).
      dispatchKey("x");
    } else if (browseEverythingActive()) {
      // 0.11.8: Browse Everything owns X as the card-context key
      // for the controller's layer routing.
      dispatchKey("x");
    } else if (inPlayerContext()) togglePlayPause();
    else openDetailsOfFocused();
    return;
  }
  if (index === BTN_Y && findOpenModal() === null) {
    markGamepadActive();
    // W3: in the Guide Y is guide actions (Guide key "y").
    if (livetvGuideActive()) {
      dispatchKey("y");
    } else if (livetvPlaybackActive()) {
      dispatchKey("y");
    } else if (livetvLandingActive() || livetvBrowserActive()) {
      // W5 (0.9.0): landing Y = open Guide, browser Y = open
      // search — both as keys for the mode's own keydown handler.
      dispatchKey("y");
    } else if (browseEverythingActive()) {
      // 0.11.8: Browse Everything owns Y as its search key. On
      // Home, Y keeps falling through to goSearch() (global
      // search) — series/movies-scoped search stays on the header
      // button (D19).
      dispatchKey("y");
    } else if (inPlayerContext()) toggleFullscreen();
    else goSearch();
    return;
  }
  if (index === BTN_LB) {
    markGamepadActive();
    // W3: in the Guide LB shifts time earlier (Guide key "PageUp").
    // W5: in the Browser LB steps to the previous category ("[").
    // 0.11.8: in Browse Everything LB turns the page; on Movies /
    // Series Home LB jumps to the previous shelf (the Home
    // shelf-jump listener owns PageUp/PageDown). Both are gated on
    // no open modal, so a dialog keeps owning the press.
    if (livetvGuideActive()) dispatchKey("PageUp");
    else if (livetvBrowserActive()) dispatchKey("[");
    else if (browseEverythingActive() && findOpenModal() === null) dispatchKey("PageUp");
    else if (moviesSeriesHomeActive() && findOpenModal() === null) dispatchKey("PageUp");
    else seekBy(-10);
    return;
  }
  if (index === BTN_RB) {
    markGamepadActive();
    // W3: in the Guide RB shifts time later (Guide key "PageDown").
    // W5: in the Browser RB steps to the next category ("]").
    // 0.11.8: Browse Everything page turn / Home shelf jump (see LB).
    if (livetvGuideActive()) dispatchKey("PageDown");
    else if (livetvBrowserActive()) dispatchKey("]");
    else if (browseEverythingActive() && findOpenModal() === null) dispatchKey("PageDown");
    else if (moviesSeriesHomeActive() && findOpenModal() === null) dispatchKey("PageDown");
    else seekBy(10);
    return;
  }
  if (index === BTN_LT) {
    markGamepadActive();
    // W5 (0.9.0): triggers ARE plumbed (buttons 6/7, analog value
    // > 0.5 counts as pressed). In the Browser LT steps to the
    // previous page (PageUp); elsewhere it stays volume down.
    if (livetvBrowserActive()) dispatchKey("PageUp");
    else adjustVolume(-0.1);
    return;
  }
  if (index === BTN_RT) {
    markGamepadActive();
    // W5 (0.9.0): in the Browser RT steps to the next page
    // (PageDown); elsewhere it stays volume up.
    if (livetvBrowserActive()) dispatchKey("PageDown");
    else adjustVolume(0.1);
    return;
  }
  if (
    index === BTN_MENU &&
    !actionState.menuPressedWithView &&
    findOpenModal() === null
  ) {
    markGamepadActive();
    // W3: in the Guide Menu is guide actions (Guide key "ContextMenu").
    if (livetvGuideActive()) {
      dispatchKey("ContextMenu");
    } else if (livetvPlaybackActive()) {
      // W2: in RedSilk Live TV playback Menu opens the playback
      // options overlay instead of navigating to Settings (which
      // would leave the stream).
      window.dispatchEvent(
        new CustomEvent("livetv:overlay", { detail: { overlay: "options" } }),
      );
    } else if (livetvLandingActive() || livetvBrowserActive()) {
      // W5 (0.9.0): landing / browser Menu = open options, as
      // the "m" key for the mode's own keydown handler.
      dispatchKey("m");
    } else if (browseEverythingActive()) {
      // 0.11.8: Browse Everything Menu = Filters drawer ("m").
      // Menu on Home keeps opening Settings: no page-options
      // surface exists on Home (D20 — §16.1 Menu-on-Home GAP).
      dispatchKey("m");
    } else {
      openSettings();
    }
    return;
  }
  // BTN_VIEW alone does nothing; View+Menu is the return-home chord
  // (noteViewMenuHeld, above). Unknown indices are ignored.
}

// Buttons the native path is currently holding, by XInput name.
// The browser loop gets its held state from the per-frame snapshot;
// the native path gets edges only, so it tracks holds here — the
// View+Menu chord needs to know both buttons are down at once.
const nativeHeldButtons = new Set<string>();

/**
 * Native XInput button edge, from native-gamepad.ts. `pressed` is
 * the edge (true = just pressed, false = just released). Presses run
 * the shared handleGamepadButtonPress above; releases only update the
 * View+Menu chord state. Unknown button names are ignored.
 */
export function dispatchNativeButton(
  button: NativeButtonName,
  pressed: boolean,
  now: number = performance.now(),
): void {
  noteNativeInputActive();
  if (pressed) nativeHeldButtons.add(button);
  else nativeHeldButtons.delete(button);
  noteViewMenuHeld(
    nativeHeldButtons.has("view"),
    nativeHeldButtons.has("menu"),
    now,
  );
  if (!pressed) return;
  const index = NATIVE_BUTTON_INDEX[button];
  if (index === undefined || index === BTN_VIEW) return;
  handleGamepadButtonPress(index, now);
}

let nativeRafId = 0;
let nativeDirection: Direction | null = null;

/**
 * Native XInput direction edge, from native-gamepad.ts. `dir` is the
 * direction that just started, or null when the pad returned to
 * centre. The first move fires immediately; repeats run on a
 * requestAnimationFrame ticker with the same 350 ms / 140 ms timing
 * the browser loop uses, so a held native D-pad repeats exactly like
 * a held browser one.
 */
export function dispatchNativeDirection(
  dir: Direction | null,
  now: number = performance.now(),
): void {
  noteNativeInputActive();
  if (dir === null) {
    nativeDirection = null;
    cancelAnimationFrame(nativeRafId);
    actionState.held = null;
    return;
  }
  if (nativeDirection !== dir) {
    nativeDirection = dir;
    handleDirection(dir, now);
  }
  cancelAnimationFrame(nativeRafId);
  const tick = (t: number): void => {
    if (nativeDirection === null) return;
    handleDirection(nativeDirection, t);
    nativeRafId = requestAnimationFrame(tick);
  };
  nativeRafId = requestAnimationFrame(tick);
}

// Synthetic KeyboardEvent.keyCode values. Chromium's KeyboardEvent
// constructor has no keyCode slot, so a synthetic event reads
// keyCode 0 — and spatial-navigation.js reads keyCode only. Stamp
// the real code onto each dispatched event (see dispatchKey); the
// map also feeds the spatial-nav key fallback.
const KEY_CODE: Record<string, number> = {
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Enter: 13,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  "[": 219,
  "]": 221,
  ContextMenu: 93,
};

function keyCodeForKey(key: string): number | undefined {
  const direct = KEY_CODE[key];
  if (direct !== undefined) return direct;
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return undefined;
}

/** First connected pad at ANY index — never just slot 0. */
export function firstConnectedPad(
  pads: ArrayLike<Gamepad | null> | null | undefined,
): Gamepad | null {
  if (!pads) return null;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad && pad.connected) return pad;
  }
  return null;
}

function isEditingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

function dispatchKey(key: string): void {
  const target = document.activeElement ?? document.body;
  const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true };
  // A synthetic KeyboardEvent reads keyCode 0 in Chromium (the
  // constructor has no keyCode slot), and spatial-navigation.js reads
  // keyCode only — without the stamp every gamepad arrow / Enter /
  // Escape is invisible to the focus engine. Object.defineProperty
  // shadows the prototype getter and survives dispatch (verified in
  // Chromium); if an old webview refuses it, e.key readers still see
  // the press.
  const keyCode = keyCodeForKey(key);
  for (const type of ["keydown", "keyup"] as const) {
    const event = new KeyboardEvent(type, init);
    if (keyCode !== undefined) {
      try {
        Object.defineProperty(event, "keyCode", { value: keyCode });
        Object.defineProperty(event, "which", { value: keyCode });
      } catch {
        // Very old webviews: the key-only event still goes out.
      }
    }
    target.dispatchEvent(event);
  }
}

function currentVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>("#tv-player-video") ??
    document.querySelector<HTMLVideoElement>("video")
  );
}

function activateFocused(): void {
  // While a modal is open, A must never activate something behind
  // it: pull stray focus into the dialog instead.
  const pull = modalFocusTarget();
  if (pull) {
    pull.focus({ preventScroll: true });
    return;
  }
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) {
    dispatchKey("Enter");
    return;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (
    tag === "button" ||
    tag === "a" ||
    el.getAttribute("role") === "button"
  ) {
    el.click();
    return;
  }
  dispatchKey("Enter");
}

function togglePlayPause(): void {
  const video = currentVideo();
  if (!video) return;
  if (video.paused) void video.play().catch(() => {});
  else video.pause();
}

// The player owns X / Y while it is the thing on screen: a video is
// playing, fullscreen is active, or the dedicated player video exists.
// Everywhere else X opens details and Y opens search, per the redesign
// navigation model. This keeps the player controllable (there is no
// other controller path to play/pause or fullscreen) without stealing
// X / Y from browsing.
function inPlayerContext(): boolean {
  if (document.fullscreenElement) return true;
  const playerVideo = document.querySelector<HTMLVideoElement>("#tv-player-video");
  if (playerVideo) return true;
  const video = currentVideo();
  return !!video && !video.paused;
}

// X on a focused card: open its detail page without autoplay, so X is
// "details" and A stays "play / resume". Only acts when stripping the
// autoplay param actually changes the destination (movie / series
// detail links); live channels and plain buttons are left alone.
// W5 (0.9.0): the Live TV context the shell is showing, from
// html[data-livetv-mode] (set by livetv.astro's setMode). Legacy
// "home" reads as "landing". Null off the Live TV page (or before
// the shell sets the attribute) — the generic branches below then
// apply. The mode components own their back step via the
// `livetv:back` event (see the B branch in pollLoop); this helper
// only names the context.
type LivetvContext = "landing" | "browser" | "playback" | "guide";

function livetvContext(): LivetvContext | null {
  const mode = document.documentElement.dataset.livetvMode;
  if (mode === "landing" || mode === "home") return "landing";
  if (mode === "browser" || mode === "playback" || mode === "guide") {
    return mode;
  }
  return null;
}

function livetvLandingActive(): boolean {
  return livetvContext() === "landing";
}

function livetvBrowserActive(): boolean {
  return livetvContext() === "browser";
}

// W2: RedSilk fullscreen Live TV playback owns X / Y / Menu while
// it is the thing on screen (html[data-livetv-mode="playback"]).
// Without this the generic player branch below would swallow X as
// play/pause, Y as fullscreen, and Menu as a navigation away to
// Settings — killing the stream. In playback mode X/Y are dispatched
// as keys for the playback shell (X guide, Y channel browser) and
// Menu opens the playback options overlay; View+Menu 2s
// return-home above is untouched.
function livetvPlaybackActive(): boolean {
  return livetvContext() === "playback";
}

// W3: the full programme Guide owns X / Y / LB / RB / Menu while it
// is the thing on screen (html[data-livetv-mode="guide"], set by
// TvGuideView on activation). Without this the generic branches below
// would swallow Y as a navigation to Search, LB/RB as a 10s seek and
// Menu as a navigation to Settings — none of which the Guide wants.
// In guide mode the buttons are dispatched as keys for the Guide's
// own keydown handler (Y guide actions, LB/RB time nav, Menu guide
// actions); X is deliberately swallowed (unmapped in the Guide, per
// the livetv-keys.ts table). View+Menu 2s return-home above is
// untouched.
function livetvGuideActive(): boolean {
  return livetvContext() === "guide";
}

// 0.11.8: Browse Everything / Movies & Series Home contexts. The
// browse controller sets [data-browse-everything] on its root; the
// series controller keeps the mount alive-but-hidden while Home
// shows, so visibility is part of the predicate — a [hidden]
// ancestor means Home is showing, not Browse. The browse overlays
// (drawers, sort, search) are divs, not <dialog>s, so findOpenModal
// stays null while they are open and dispatched keys reach the
// controller's layer routing. Live TV checks always run first: on
// the Live TV page these predicates are false (no browse/home roots
// exist there), and the Live TV branches below win regardless.
function browseEverythingActive(): boolean {
  const root = document.querySelector("[data-browse-everything]");
  if (!root || !root.isConnected) return false;
  return root.closest("[hidden]") == null;
}

function moviesSeriesHomeActive(): boolean {
  if (browseEverythingActive()) return false;
  const home = document.querySelector("#movies-home-root, #series-home-root");
  if (!home || !home.isConnected) return false;
  return home.closest("[hidden]") == null;
}

function openDetailsOfFocused(): void {
  const el = document.activeElement as HTMLElement | null;
  const link = el?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link) return;
  const raw = link.getAttribute("href") || "";
  if (!raw || raw === "#") return;
  let href: string;
  try {
    const url = new URL(raw, window.location.href);
    if (!url.searchParams.has("autoplay")) return;
    url.searchParams.delete("autoplay");
    href = url.pathname + url.search + url.hash;
  } catch {
    return;
  }
  if (href && href !== window.location.pathname + window.location.search) {
    window.location.assign(href);
  }
}

function goSearch(): void {
  if (window.location.pathname === "/search") return;
  window.location.assign("/search");
}

// ──────────────────────────────────────────────────────────────────────
// Modal dialogs own navigation while open (v0.2.1).
//
// The rail model below must never run while a modal is open: it would
// carry focus into the page behind the dialog. Spatial navigation is
// restricted to the dialog's own section (see dialog-spatial-nav.ts),
// so arrows dispatched while a dialog is open stay inside it — for
// keyboard and for gamepad alike. modalFocusTarget() is the testable
// half of that contract: when a modal is open and focus is outside it,
// it names the element focus must be pulled to instead; it returns
// null when navigation may proceed normally (no modal open, or focus
// already inside the open modal).
// ──────────────────────────────────────────────────────────────────────

/** Element focus must be pulled to when a modal is open and focus is outside it, else null. */
export function modalFocusTarget(): HTMLElement | null {
  const modal = findOpenModal();
  if (!modal) return null;
  const active = document.activeElement as HTMLElement | null;
  if (active && modal.contains(active)) return null;
  return firstFocusableInModal(modal);
}

// ──────────────────────────────────────────────────────────────────────
// Nylah home rails — rail-aware navigation model (v0.2.0).
//
// Contract for rail components (worker 2's four rails + the Continue
// Watching rail): each rail renders
//   <section data-nylah-rail="<id>" class="nylah-rail"> … </section>
// and marks the primary focusable of every card with `data-nylah-item`.
// The home page wraps the stack in `[data-nylah-rails]`. Rail header
// and row classes live in global.css (.nylah-rail__head / __title /
// __row); a strip may reuse its existing .hub-section-head instead.
//
// Behaviour, only while the focused element is inside a rail (or no
// element is focused yet):
//   left / right ... move within the rail; at either end the move is
//                    NOT consumed, so spatial navigation can carry it
//                    on into the sidebar (left edge) as before.
//   up / down ...... move to the adjacent rail, restoring that rail's
//                    remembered column (focus memory); at the top /
//                    bottom edge the move is NOT consumed, so spatial
//                    navigation can carry it to the hero / nav.
//   focus .......... is never lost: every handled move lands on a real
//                    item, and a focusin handler scrolls the focused
//                    item into view (both axes, nearest edge) so the
//                    focused card is always visible.
// Anything outside the rails (sidebar, dialogs, grids, player) keeps
// the previous behaviour: plain arrow keys into spatial navigation.
// ──────────────────────────────────────────────────────────────────────

const railMemory = new Map<Element, number>();

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

function railItems(rail: Element): HTMLElement[] {
  const marked = Array.from(
    rail.querySelectorAll<HTMLElement>("[data-nylah-item]"),
  ).filter((el) => isVisible(el));
  if (marked.length > 0) return marked;
  // Fallback for a rail whose cards carry no marker: top-level links
  // and buttons only (a nested button inside a card link is not its
  // own item).
  const candidates = Array.from(
    rail.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
  ).filter((el) => isVisible(el));
  return candidates.filter(
    (el) =>
      !candidates.some(
        (other) => other !== el && other.contains(el),
      ),
  );
}

function homeRails(): Element[] {
  return Array.from(document.querySelectorAll("[data-nylah-rail]")).filter(
    (rail) => railItems(rail).length > 0 && isVisible(rail),
  );
}

function focusRailItem(rail: Element, index: number): void {
  const items = railItems(rail);
  if (items.length === 0) return;
  const clamped = Math.max(0, Math.min(index, items.length - 1));
  railMemory.set(rail, clamped);
  items[clamped].focus({ preventScroll: true });
  // The focusin handler below scrolls it into view; calling it here
  // too covers the (rare) case where focus was already on the item.
  items[clamped].scrollIntoView({ block: "nearest", inline: "nearest" });
}

// Returns true when the direction was consumed by the rail model.
function handleRailDirection(dir: Direction): boolean {
  const rails = homeRails();
  if (rails.length === 0) return false;
  const active = document.activeElement as HTMLElement | null;
  const rail = active?.closest?.("[data-nylah-rail]") ?? null;

  if (dir === "left" || dir === "right") {
    if (!rail) return false;
    const items = railItems(rail);
    const at = items.indexOf(active as HTMLElement);
    if (at === -1) return false;
    const next = dir === "right" ? at + 1 : at - 1;
    // Past either end: don't consume — spatial navigation carries the
    // move on (left edge reaches the sidebar).
    if (next < 0 || next >= items.length) return false;
    focusRailItem(rail, next);
    return true;
  }

  // up / down
  if (!rail) {
    // Nothing in a rail focused yet: Down from the hero (or from no
    // focus at all) enters the first rail at its remembered item.
    if (
      dir === "down" &&
      (!active ||
        active === document.body ||
        active.closest?.("[data-nylah-hero]"))
    ) {
      focusRailItem(rails[0], railMemory.get(rails[0]) ?? 0);
      return true;
    }
    return false;
  }
  const atRail = rails.indexOf(rail);
  const target = dir === "down" ? rails[atRail + 1] : rails[atRail - 1];
  // Past the top / bottom rail: don't consume — spatial navigation
  // carries the move to the hero / nav as before.
  if (!target) return false;
  const items = railItems(rail);
  const col = items.indexOf(active as HTMLElement);
  const remembered = railMemory.get(target) ?? 0;
  const index = col === -1 ? remembered : Math.min(col, railItems(target).length - 1);
  focusRailItem(target, Math.max(0, index));
  return true;
}

function mountRailAutoScroll(): void {
  const flag = "__couchhubTvRailAutoScrollMounted" as const;
  if ((window as unknown as Record<string, unknown>)[flag]) return;
  (window as unknown as Record<string, unknown>)[flag] = true;

  document.addEventListener("focusin", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || target === document.body) return;
    const rail = target.closest?.("[data-nylah-rail]");
    if (!rail) return;
    // Remember the column so up/down restores it on return.
    const items = railItems(rail);
    const at = items.indexOf(target);
    if (at !== -1) railMemory.set(rail, at);
    // Auto-scroll: keep the focused item fully in view, both axes.
    // block/inline "nearest" is a no-op when it is already visible,
    // so manual scrolling is never fought. Instant, not smooth: a
    // held D-pad repeats faster than a smooth scroll settles.
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
  } else {
    void document.documentElement.requestFullscreen().catch(() => {});
  }
}

function seekBy(seconds: number): void {
  const video = currentVideo();
  if (!video || !Number.isFinite(video.duration)) return;
  video.currentTime = Math.min(
    Math.max(0, video.currentTime + seconds),
    video.duration,
  );
}

function adjustVolume(delta: number): void {
  const video = currentVideo();
  if (!video) return;
  video.volume = Math.min(1, Math.max(0, video.volume + delta));
}

// 0.11.4 W1: one Settings only — the duplicate /tv/settings UI is gone.
function openSettings(): void {
  const path = window.location.pathname;
  if (path === "/settings" || path.startsWith("/settings/")) return;
  window.location.assign("/settings");
}

export function mountGamepad(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  const flag = "__couchhubTvGamepadMounted" as const;
  if ((window as unknown as Record<string, unknown>)[flag]) return;
  (window as unknown as Record<string, unknown>)[flag] = true;

  let rafId = 0;
  let running = false;
  let prevSnapshot: boolean[] = [];
  // Index of the pad the loop is currently reading. The pad can move
  // (reconnect at a new index, a different pad taking over); edge
  // state from the previous pad must never fire on the new one.
  let activePadIndex: number | null = null;

  // Held direction / View+Menu hold live in module-level actionState
  // now (shared with the native XInput path); markGamepadActive,
  // move() and handleDirection() are module-level too. This loop only
  // owns its own frame state (rafId / running / prevSnapshot).
  // Rail auto-scroll + focus memory live here so keyboard (spatial
  // nav) focus moves get them too, not only gamepad moves.
  mountRailAutoScroll();
  window.addEventListener("pointerdown", () => {
    document.documentElement.classList.remove("gamepad-active");
  }, { passive: true });
  window.addEventListener("keydown", () => {
    document.documentElement.classList.remove("gamepad-active");
  });

  function stickDirection(gp: Gamepad): Direction | null {
    const x = gp.axes[0] ?? 0;
    const y = gp.axes[1] ?? 0;
    if (Math.abs(x) > STICK_DEAD_ZONE && Math.abs(x) >= Math.abs(y)) {
      return x > 0 ? "right" : "left";
    }
    if (Math.abs(y) > STICK_DEAD_ZONE) {
      return y > 0 ? "down" : "up";
    }
    return null;
  }

  function pollLoop(now: number): void {
    if (!running) return;
    rafId = requestAnimationFrame(pollLoop);
    if (document.hidden) return;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    // First connected pad at ANY index: a virtual / second device can
    // sit at 0 while the real controller is at 1+. Reading slot 0
    // only made the controller invisible on exactly those machines.
    const gp = firstConnectedPad(pads);
    if (!gp) {
      prevSnapshot = [];
      actionState.held = null;
      actionState.viewMenuHoldStart = null;
      activePadIndex = null;
      return;
    }
    if (activePadIndex !== gp.index) {
      activePadIndex = gp.index;
      prevSnapshot = [];
      actionState.held = null;
      actionState.viewMenuHoldStart = null;
    }

    const snapshot = gp.buttons.map((b) => b.pressed || b.value > 0.5);
    // Capture the previous frame BEFORE reassigning: justPressed
    // closes over this binding, so assigning prevSnapshot = snapshot
    // first made every edge compare the snapshot against itself and
    // always return false — A / B / X / Y / LB / RB / LT / RT / Menu
    // could never fire, on any screen. (0.11.0 bug: the assign sat
    // between the justPressed definition and its first call.)
    const prev = prevSnapshot;
    prevSnapshot = snapshot;
    const justPressed = (index: number): boolean =>
      snapshot[index] === true && prev[index] !== true;

    // Native XInput path is live: stand down. The same physical pad
    // is visible to BOTH XInput and the Gamepad API, so processing
    // this snapshot too would double every press. prevSnapshot was
    // already updated above, so the fallback resumes cleanly (no
    // stale edges) when the native path goes quiet.
    if (isNativePathLive(now)) return;

    const editing = isEditingTarget(document.activeElement);

    // View + Menu held together for 2 s -> return home (shared with
    // the native path — see noteViewMenuHeld).
    noteViewMenuHeld(snapshot[BTN_VIEW], snapshot[BTN_MENU], now);

    if (editing) {
      // In a text field the controller only gets B (blur/back) and the
      // View+Menu return-home hold — arrows and A belong to the field.
      // The gate lives in handleGamepadButtonPress; calling it for B
      // is enough here. R3 is routed too, so Cursor Mode can always
      // be exited from a field on the fallback path (0.11.10 W6).
      if (justPressed(BTN_B)) handleGamepadButtonPress(BTN_B, now);
      if (justPressed(BTN_RIGHT_THUMB))
        handleGamepadButtonPress(BTN_RIGHT_THUMB, now);
      actionState.held = null;
      return;
    }

    // D-pad (edge + repeat) and left stick (repeat) share one direction.
    let dir: Direction | null = null;
    if (snapshot[BTN_DPAD_UP]) dir = "up";
    else if (snapshot[BTN_DPAD_DOWN]) dir = "down";
    else if (snapshot[BTN_DPAD_LEFT]) dir = "left";
    else if (snapshot[BTN_DPAD_RIGHT]) dir = "right";
    else dir = stickDirection(gp);
    handleDirection(dir, now);

    // Every button runs the shared pipeline (same code the native
    // XInput path calls) — see handleGamepadButtonPress. R3 (11) is
    // the Cursor Mode toggle (0.11.10 W6); L3 (10) stays unmapped.
    for (const index of [
      BTN_A,
      BTN_B,
      BTN_X,
      BTN_Y,
      BTN_LB,
      BTN_RB,
      BTN_LT,
      BTN_RT,
      BTN_MENU,
      BTN_RIGHT_THUMB,
    ]) {
      if (justPressed(index)) handleGamepadButtonPress(index, now);
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    rafId = requestAnimationFrame(pollLoop);
  }

  function stop(): void {
    running = false;
    cancelAnimationFrame(rafId);
    actionState.held = null;
    actionState.viewMenuHoldStart = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  window.addEventListener("gamepadconnected", () => start());
  window.addEventListener("gamepaddisconnected", () => {
    // The loop keeps polling: a reconnect (or a first press that
    // opens Chromium's gesture gate) is picked up on the next frame
    // without depending on the connect event arriving. Only the
    // edge state is reset, so a held button cannot fire stale.
    prevSnapshot = [];
    actionState.held = null;
    actionState.viewMenuHoldStart = null;
    activePadIndex = null;
  });

  // Start the poll loop UNCONDITIONALLY at mount. The old code only
  // started it when getGamepads() already showed a pad, or when a
  // gamepadconnected event arrived — both miss the cold-launch case:
  // Chromium hides an already-connected pad until its first button
  // press (anti-fingerprinting gesture gate), and a gamepadconnected
  // fired by a press during page load — before this listener exists
  // — is lost forever, leaving the loop stopped and the controller
  // dead for the whole session. Polling every frame costs nothing
  // when no pad is present (early return above) and discovers the
  // pad on the first frame its gate opens, event or no event.
  start();
}
