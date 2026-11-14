// Nylah Studios — Controller Cursor Mode (0.11.10, W6; 0.11.14, W2).
//
// ISOLATED: when the setting is off — or the frontend never
// subscribes — no pointer element exists, no rAF loop runs, no stick
// event moves anything, and R3 is the same no-op it always was. The
// setting (Settings → Display → Behavior → "Controller Cursor Mode")
// defaults ON for new installs since 0.11.14 (§6 discoverability);
// a deliberate disable persists as "0" and is never overwritten —
// see getCursorMode() in app-settings.js. Normal navigation stays
// primary: Cursor Mode only appears when the user presses R3.
//
// When enabled, R3 (right-stick click) toggles Cursor Mode. The right
// stick moves an on-screen pointer, the left stick scrolls the
// container under the pointer (0.11.14), A left-clicks, RB
// right-clicks, and B or R3 exits (page unchanged). D-pad focus
// movement keeps working while the cursor is up; left-stick focus
// movement does NOT — while Cursor Mode is active the left stick
// scrolls only (no-dual-route rule, see the contract below).
//
// INPUT SOURCES — one vector per stick, two feeds, native wins:
//   * Native XInput (primary): Rust forwards right-stick axes as
//     `xinput-stick` events and left-stick axes as `xinput-scroll`
//     events (see xinput.rs); native-gamepad.ts calls
//     noteNativeStick() / noteNativeScrollStick(). Rate-bounded in
//     Rust (~16 ms while deflected, plus one zero event on return to
//     centre).
//   * Browser Gamepad API (fallback): while Cursor Mode is active this
//     module's own rAF loop reads axes 2/3 (pointer) and 0/1 (scroll)
//     of the first connected pad — but ONLY after the same 1500 ms
//     native-silence window gamepad.ts uses for button arbitration
//     (NATIVE_LIVE_WINDOW_MS), so one physical stick can never drive
//     the pointer or the scroll twice.
// The two feeds write the same stick vectors; the movement loop below
// integrates whichever feed is live.
//
// REAL CLICKS — DOM-synthetic, deliberately (see the W6 report for
// the decision + evidence). The pointer dispatches the real sequence
// a mouse produces (pointerdown → mousedown → pointerup → mouseup →
// click, or contextmenu for RB) at the pointer's coordinates, via
// document.elementFromPoint, and moves DOM focus to the clicked
// control first — exactly what a real mousedown does. Every Couch
// control is a DOM element with a click/contextmenu handler (the
// gamepad's own activateFocused() already relies on el.click(), and
// poster-menu / stream rows listen for contextmenu), so synthetic
// events reach the same handlers a mouse would. No Tauri command, no
// Win32 SendInput: the OS cursor never moves, nothing can click the
// desktop or another app, and the UI never depends on Cursor Mode
// working. The pointer is clamped to the viewport, and Cursor Mode
// deactivates on window blur, tab hide, controller disconnect, or the
// setting being turned off mid-session.
//
// CONTRACT G (0.11.10): isCursorModeActive / setCursorModeActive /
// toggleCursorMode / isCursorModeEnabled. gamepad.ts calls the guard
// functions; R3 calls toggleCursorMode() (only when enabled).
//
// 0.11.14 (W2, §6) — LEFT-STICK SCROLLING + STICK-EVENT CONTRACT.
// This header is the seam contract W1 (input ownership) and W3
// (hints) build against. It is pushed before the implementation so
// the contract is visible early; the code below implements it.
//
// STICK-EVENT CONTRACT (native XInput → Tauri events → this module):
//   xinput-stick     { slot, x, y }  right-stick axes, raw i16.
//                                    UNCHANGED since 0.11.10. Moves
//                                    the pointer. Y up-positive.
//   xinput-scroll    { slot, x, y }  NEW: left-stick axes, raw i16,
//                                    same Rust poll loop, same 16 ms
//                                    rate bound + one zero event on
//                                    return to centre, emitted
//                                    whenever deflected (the
//                                    frontend ignores it unless
//                                    Cursor Mode is active, exactly
//                                    like xinput-stick). Y
//                                    up-positive; inverted here to
//                                    screen space. Drives scrolling
//                                    ONLY — never focus movement.
//   xinput-direction { slot, direction, phase, source }
//                                    source is NEW: "dpad" | "stick"
//                                    (which physical control produced
//                                    the direction; D-pad wins ties
//                                    in Rust, as before).
//                                    NO-DUAL-ROUTE RULE: while Cursor
//                                    Mode is active,
//                                    native-gamepad.ts drops
//                                    source:"stick" directions
//                                    entirely (no focus move, no held
//                                    ticker) and lets source:"dpad"
//                                    through, so D-pad focus nav is
//                                    retained per §6. On activation
//                                    (couch:cursor-mode {active:true})
//                                    native-gamepad.ts also cancels
//                                    any held native direction ticker,
//                                    so a stick held across R3 cannot
//                                    keep moving focus. The browser
//                                    Gamepad API fallback MUST behave
//                                    the same: this module's own rAF
//                                    loop reads axes 0/1 for scroll
//                                    (axes 2/3 still move the pointer)
//                                    under the same 1500 ms
//                                    native-silence rule — and W1
//                                    OWNS the gamepad.ts half:
//                                    pollLoop must skip
//                                    stickDirection() while
//                                    isCursorModeActive() (D-pad
//                                    buttons still flow). Until W1
//                                    lands that guard, the FALLBACK
//                                    path dual-routes the left stick
//                                    (scroll + focus); the NATIVE
//                                    path is correct without W1.
//   couch:cursor-mode { active }    UNCHANGED activation signal.
//
// HINTS STATES (W3 seam): html[data-cursor-mode="active"] while
// active (unchanged); html[data-cursor-scroll="available"|"none"]
// reports whether a scroll target exists under the pointer, updated
// only when the value changes (W3: add "data-cursor-scroll" to the
// TvButtonHints MutationObserver filter to re-render on it).
// CURSOR_MODE_HINTS is the legend config; the on-screen pill carries
// the stick rows (no stick glyph exists in HintGlyph).
//
// CLICKS stay DOM-synthetic in 0.11.14 (no Win32 SendInput): every
// Couch control is a DOM element with a click/contextmenu handler,
// and the 0.11.14 change closes the default-behaviour gap (checkbox /
// radio / range emulation) instead of moving the OS cursor. A native
// click could open <select> dropdowns, which synthetic clicks cannot;
// the Couch UI drives selects via focus + D-pad once the cursor click
// focuses them, so the desktop-click risk of SendInput is not
// justified. See dispatchCursorClick.
//
// HINTS — INTEGRATION-0110-W1: W1 owns the unified hints layer and
// its `setControllerHints(config)` contract (couch-button-hints.ts).
// That function does NOT exist in the 0.11.9 tree, so the cursor hint
// set is rendered through the existing legend instead: this module
// sets html[data-cursor-mode="active"], and TvButtonHints.astro's
// render() shows CURSOR_MODE_HINTS while the attribute is present
// (the attribute is in its MutationObserver filter, so activation
// and exit re-render immediately). The legend keeps exactly one
// writer — an earlier DOM-swap approach was removed after a headless
// render proved TvButtonHints' own observer clobbers it. W1 may
// replace the TvButtonHints branch with setControllerHints calls;
// CURSOR_MODE_HINTS is the config to pass. There is no right-stick
// glyph in HintGlyph yet, so the movement row lives in the on-screen
// indicator pill instead of the legend (W1 follow-up: add a stick
// glyph).

import { getCursorMode, CURSOR_MODE_EVENT } from "@/scripts/lib/app-settings.js";
import {
  RETURN_HOME_HINT,
  type HintConfig,
} from "@/scripts/lib/couch-button-hints.ts";
import {
  restoreCouchFocus,
  seedInitialCouchFocus,
} from "@/scripts/lib/couch-focus.ts";
import { findOpenModal } from "@/scripts/lib/dialog-spatial-nav.js";

/** XInput right-stick dead zone, raw i16 — matches STICK_DEADZONE in xinput.rs. */
export const CURSOR_DEADZONE_RAW = 7849;
/** The same dead zone on the normalised [-1, 1] scale the frontend uses. */
export const CURSOR_DEADZONE = CURSOR_DEADZONE_RAW / 32767;
/** Pointer speed at the lightest deflection past the dead zone (px/s). */
export const CURSOR_MIN_SPEED_PX_S = 120;
/** Pointer speed cap at full deflection (px/s). */
export const CURSOR_MAX_SPEED_PX_S = 1400;
/** Velocity smoothing time constant: smaller = snappier, larger = floatier. */
export const CURSOR_SMOOTHING_TAU_MS = 60;
/**
 * Pointer deceleration time constant (0.11.14, W2): stopping uses a
 * shorter tau than starting, so the pointer settles promptly when the
 * stick centres instead of gliding past the target.
 */
export const CURSOR_DECEL_TAU_MS = 35;
/**
 * Pointer speed below which a centred stick snaps velocity to exactly
 * zero — kills the last-pixel creep without a visible stop.
 */
export const CURSOR_VELOCITY_REST_PX_S = 24;
/** Scroll speed at the lightest left-stick deflection past the dead zone (px/s). */
export const CURSOR_SCROLL_MIN_SPEED_PX_S = 140;
/** Scroll speed cap at full left-stick deflection (px/s). */
export const CURSOR_SCROLL_MAX_SPEED_PX_S = 900;
/** Scroll velocity smoothing time constant — slightly softer than the pointer. */
export const CURSOR_SCROLL_SMOOTHING_TAU_MS = 80;
/**
 * Native-silence window before the Gamepad API fallback axes may
 * drive the pointer — mirrors NATIVE_LIVE_WINDOW_MS in gamepad.ts.
 */
export const CURSOR_NATIVE_SILENCE_MS = 1500;

/**
 * Legend shown while Cursor Mode is active (see the W1 note above).
 * 0.11.14 (W2): D-pad keeps focus nav while the cursor is up (§6), so
 * it earns a row. The stick rows (right stick moves, left stick
 * scrolls) live in the on-screen pill — HintGlyph has no stick glyph.
 */
export const CURSOR_MODE_HINTS: HintConfig = {
  id: "cursor-mode",
  items: [
    { glyph: "a", label: "Click" },
    { glyph: "rb", label: "Right-click" },
    { glyph: "dpad", label: "Move focus" },
    { glyph: "b", label: "Exit cursor" },
    RETURN_HOME_HINT,
  ],
};

export type CursorClickButton = "left" | "right";

export interface CursorVector {
  x: number;
  y: number;
}

// ── Pure movement math (unit-tested) ──────────────────────────────────

/** Raw i16 XInput axis → normalised [-1, 1]. */
export function normalizeRawAxis(value: number): number {
  return Math.max(-1, Math.min(1, value / 32767));
}

/**
 * Apply the analogue dead zone and rescale the surviving range to
 * [0, 1], preserving direction: a stick just past the dead zone moves
 * slowly, full deflection is 1. Inside the dead zone the vector is
 * exactly zero, so stick drift never moves the pointer.
 */
export function applyStickDeadzone(x: number, y: number): CursorVector {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= CURSOR_DEADZONE) return { x: 0, y: 0 };
  const scaled = (magnitude - CURSOR_DEADZONE) / (1 - CURSOR_DEADZONE);
  const scale = scaled / magnitude;
  return { x: x * scale, y: y * scale };
}

/**
 * Target pointer speed for a deadzoned magnitude in [0, 1]. Quadratic
 * easing: gentle near the centre, fast at the edge, capped at
 * CURSOR_MAX_SPEED_PX_S.
 */
export function cursorTargetSpeed(magnitude: number): number {
  const clamped = Math.max(0, Math.min(1, magnitude));
  return (
    CURSOR_MIN_SPEED_PX_S +
    (CURSOR_MAX_SPEED_PX_S - CURSOR_MIN_SPEED_PX_S) * clamped * clamped
  );
}

/**
 * Target scroll speed for a deadzoned magnitude in [0, 1] — the same
 * quadratic easing as the pointer, with the scroll speed range.
 */
export function cursorScrollSpeed(magnitude: number): number {
  const clamped = Math.max(0, Math.min(1, magnitude));
  return (
    CURSOR_SCROLL_MIN_SPEED_PX_S +
    (CURSOR_SCROLL_MAX_SPEED_PX_S - CURSOR_SCROLL_MIN_SPEED_PX_S) *
      clamped *
      clamped
  );
}

/**
 * Exponential approach of `current` toward `target` over `dtMs` —
 * smooth acceleration and deceleration instead of instant starts and
 * stops. Converges: repeated calls with a fixed target reach it.
 */
export function smoothVelocity(
  current: number,
  target: number,
  dtMs: number,
  tauMs: number = CURSOR_SMOOTHING_TAU_MS,
): number {
  if (dtMs <= 0) return current;
  const alpha = 1 - Math.exp(-dtMs / Math.max(1, tauMs));
  return current + (target - current) * alpha;
}

/** Clamp a pointer position inside the viewport (never off-screen). */
export function clampCursorPosition(
  x: number,
  y: number,
  width: number,
  height: number,
): CursorVector {
  return {
    x: Math.max(0, Math.min(Math.max(0, width - 1), x)),
    y: Math.max(0, Math.min(Math.max(0, height - 1), y)),
  };
}

// ── Scroll-container resolution (0.11.14, W2, §6) ────────────────────
//
// The left stick scrolls the container beneath the pointer. Vertical
// and horizontal targets resolve independently — the nearest ancestor
// that can actually scroll in that axis — so a vertical list inside a
// horizontal shelf scrolls the right container in each direction. If
// nothing under the pointer scrolls, the page itself
// (document.scrollingElement) is the fallback. MODAL GUARD: while a
// modal is open, resolution never escapes the modal — a pointer over
// the background page scrolls nothing, and a pointer inside the modal
// scrolls at most the modal itself. The background page is never
// scrolled while a modal is open.

export type ScrollAxis = "vertical" | "horizontal";

export interface CursorScrollTargets {
  vertical: Element | null;
  horizontal: Element | null;
  /** True when a modal is open and the pointer is outside it. */
  blockedByModal: boolean;
}

function overflowAllowsScroll(value: string): boolean {
  return value === "auto" || value === "scroll" || value === "overlay";
}

function overflowFor(el: Element, axis: ScrollAxis): string {
  try {
    const style = getComputedStyle(el);
    return axis === "vertical" ? style.overflowY : style.overflowX;
  } catch {
    return "";
  }
}

/**
 * True when `el` can scroll in `axis`: it has overflowing content and
 * its overflow in that axis permits scrolling. The document scroller
 * is the exception — <html>/<body> scroll with any overflow value, so
 * only the content check applies there.
 */
export function isScrollableInAxis(el: Element, axis: ScrollAxis): boolean {
  const element = el as HTMLElement;
  const overflowing =
    axis === "vertical"
      ? element.scrollHeight > element.clientHeight + 1
      : element.scrollWidth > element.clientWidth + 1;
  if (!overflowing) return false;
  const doc = el.ownerDocument;
  if (doc && el === doc.scrollingElement) return true;
  if (
    doc &&
    (el === doc.documentElement || el === doc.body) &&
    !doc.scrollingElement
  ) {
    return true;
  }
  return overflowAllowsScroll(overflowFor(el, axis));
}

export function isScrollableY(el: Element): boolean {
  return isScrollableInAxis(el, "vertical");
}

export function isScrollableX(el: Element): boolean {
  return isScrollableInAxis(el, "horizontal");
}

/**
 * Nearest ancestor-or-self of `start` that can scroll in `axis`,
 * walking up to (and including) `boundary` and no further. A null
 * boundary walks to the document root. Returns null when nothing in
 * the chain scrolls — callers add the document fallback themselves,
 * because the modal guard must be able to withhold it.
 */
export function findScrollContainer(
  start: Element | null,
  axis: ScrollAxis,
  boundary: Element | null = null,
): Element | null {
  let current: Element | null = start;
  while (current) {
    if (isScrollableInAxis(current, axis)) return current;
    if (boundary && current === boundary) return null;
    current = current.parentElement;
  }
  return null;
}

/**
 * Resolve both scroll targets for the element under the pointer.
 * `modal` is the open modal (findOpenModal), or null: when a modal is
 * open and `target` is outside it, both targets are null and
 * blockedByModal is true; when the target is inside, the walk is
 * bounded to the modal and the document fallback is withheld.
 */
export function resolveScrollTargetsFromElement(
  target: Element | null,
  modal: Element | null,
  doc: Document = document,
): CursorScrollTargets {
  if (!target) return { vertical: null, horizontal: null, blockedByModal: !!modal };
  if (modal && !modal.contains(target)) {
    return { vertical: null, horizontal: null, blockedByModal: true };
  }
  const boundary = modal ?? null;
  let vertical = findScrollContainer(target, "vertical", boundary);
  let horizontal = findScrollContainer(target, "horizontal", boundary);
  if (!modal) {
    // Page fallback: the nearest suitable page container when nothing
    // under the pointer scrolls. scrollingElement is checked even
    // when the walk already passed <html>/<body> without matching —
    // the walk matches them too, so this only fires when the walk
    // never reached the root (detached target) or the root is not an
    // ancestor in this tree.
    const page = doc.scrollingElement;
    if (page) {
      if (!vertical && isScrollableInAxis(page, "vertical")) vertical = page;
      if (!horizontal && isScrollableInAxis(page, "horizontal")) horizontal = page;
    }
  }
  return { vertical, horizontal, blockedByModal: false };
}

function safeElementFromPoint(doc: Document, x: number, y: number): Element | null {
  try {
    return doc.elementFromPoint(x, y);
  } catch {
    return null;
  }
}

function safeFindOpenModal(doc: Document): Element | null {
  try {
    return findOpenModal(doc);
  } catch {
    return null;
  }
}

/** Point-based wrapper: elementFromPoint + the open-modal lookup. */
export function resolveScrollTargets(
  x: number,
  y: number,
  doc: Document = document,
): CursorScrollTargets {
  return resolveScrollTargetsFromElement(
    safeElementFromPoint(doc, x, y),
    safeFindOpenModal(doc),
    doc,
  );
}

// ── State ─────────────────────────────────────────────────────────────

let active = false;
let mounted = false;
let rafId = 0;
let lastFrameAt: number | null = null;
let pointerEl: HTMLElement | null = null;
let indicatorEl: HTMLElement | null = null;
let styleEl: HTMLStyleElement | null = null;
let pos: CursorVector = { x: 0, y: 0 };
let velocity: CursorVector = { x: 0, y: 0 };
// Normalised stick vector, screen space (Y down-positive). Written by
// noteNativeStick (native path, Y inverted from XInput up-positive)
// or the fallback axes poll (Gamepad API axes are already Y-down).
let stickVector: CursorVector = { x: 0, y: 0 };
// Left-stick scroll vector, same conventions: noteNativeScrollStick
// (xinput-scroll) or the fallback axes 0/1 poll in the same frame.
let scrollVector: CursorVector = { x: 0, y: 0 };
let scrollVelocity: CursorVector = { x: 0, y: 0 };
// performance.now() of the last native stick vector of EITHER stick,
// or 0 if none — either stick proves the native path is live, so one
// timestamp gates the whole Gamepad API fallback.
let lastNativeStickAt = 0;
let focusBeforeCursor: HTMLElement | null = null;
// Last element the user actually interacted with during this Cursor
// Mode session (clicked, or focused via D-pad while the cursor was
// up). Exit restores focus here — NOT blindly to focusBeforeCursor —
// when it is still valid. See restoreFocusOnExit.
let lastInteracted: HTMLElement | null = null;
let interactedDuringSession = false;
// Last-computed scroll availability under the pointer (the W3 hints
// signal); false while inactive. Updated in the frame loop.
let scrollAvailable = false;
// Hover tracking for synthetic pointermove/mouseover dispatch: the
// element under the pointer on the previous frame, and the position
// the last hover events were dispatched for.
let lastHoverTarget: Element | null = null;
let lastHoverPos: CursorVector = { x: -1, y: -1 };

// ── Contract G ────────────────────────────────────────────────────────

export function isCursorModeActive(): boolean {
  return active;
}

export function isCursorModeEnabled(): boolean {
  return getCursorMode();
}

export function toggleCursorMode(): void {
  setCursorModeActive(!active);
}

export function setCursorModeActive(next: boolean): void {
  if (next === active) return;
  // Activation requires the setting; deactivation always works, so
  // turning the setting off mid-session can always exit cleanly.
  if (next && !isCursorModeEnabled()) return;
  mountCursorMode();
  active = next;
  if (next) {
    focusBeforeCursor =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    lastInteracted = null;
    interactedDuringSession = false;
    pos = initialCursorPosition();
    velocity = { x: 0, y: 0 };
    scrollVelocity = { x: 0, y: 0 };
    lastHoverTarget = null;
    lastHoverPos = { x: -1, y: -1 };
    ensurePointerDom();
    positionPointer();
    // The hints signals: TvButtonHints.astro renders
    // CURSOR_MODE_HINTS while data-cursor-mode is present;
    // data-cursor-scroll reports scroll availability under the
    // pointer for W3 (the frame loop updates it on change).
    document.documentElement.dataset.cursorMode = "active";
    setScrollAvailable(false);
    lastFrameAt = null;
    rafId = requestAnimationFrame(frame);
  } else {
    cancelAnimationFrame(rafId);
    rafId = 0;
    removePointerDom();
    delete document.documentElement.dataset.cursorMode;
    delete document.documentElement.dataset.cursorScroll;
    stickVector = { x: 0, y: 0 };
    scrollVector = { x: 0, y: 0 };
    velocity = { x: 0, y: 0 };
    scrollVelocity = { x: 0, y: 0 };
    scrollAvailable = false;
    lastHoverTarget = null;
    restoreFocusOnExit();
  }
  window.dispatchEvent(
    new CustomEvent("couch:cursor-mode", { detail: { active } }),
  );
}

/** Current pointer position (viewport coordinates). Read-only copy. */
export function cursorPosition(): CursorVector {
  return { ...pos };
}

/**
 * Whether a scroll target exists under the pointer right now (the
 * last frame's resolution). False while inactive. W3 reads this — or
 * html[data-cursor-scroll] — for hints accuracy.
 */
export function isCursorScrollAvailable(): boolean {
  return active && scrollAvailable;
}

function setScrollAvailable(next: boolean): void {
  if (next === scrollAvailable) return;
  scrollAvailable = next;
  // Change-only DOM write: the value flips at most when the pointer
  // crosses a scroll boundary, never every frame.
  document.documentElement.dataset.cursorScroll = next
    ? "available"
    : "none";
}

// ── Input feeds ───────────────────────────────────────────────────────

/**
 * Native XInput right-stick vector, raw i16 axes, from
 * native-gamepad.ts (`xinput-stick`). Cheap when Cursor Mode is off:
 * it only stores the vector + timestamp, so activation mid-deflection
 * starts moving immediately and the fallback poll knows native is
 * live. XInput Y is up-positive; it is inverted here to screen space.
 */
export function noteNativeStick(
  x: number,
  y: number,
  now: number = performance.now(),
): void {
  lastNativeStickAt = now;
  stickVector = { x: normalizeRawAxis(x), y: -normalizeRawAxis(y) };
}

/**
 * Native XInput left-stick vector, raw i16 axes, from
 * native-gamepad.ts (`xinput-scroll`). Same storage semantics as
 * noteNativeStick: cheap when Cursor Mode is off, and it refreshes
 * the shared native-liveness timestamp, so the Gamepad API fallback
 * stands down while EITHER native stick is moving. XInput Y is
 * up-positive; inverted here to screen space (stick down scrolls
 * down, like a mouse wheel pulled toward the user).
 */
export function noteNativeScrollStick(
  x: number,
  y: number,
  now: number = performance.now(),
): void {
  lastNativeStickAt = now;
  scrollVector = { x: normalizeRawAxis(x), y: -normalizeRawAxis(y) };
}

/**
 * True while a recent native stick vector suppresses the Gamepad API
 * fallback — the same silence rule gamepad.ts applies to buttons.
 */
export function isCursorFallbackSuppressed(now: number = performance.now()): boolean {
  return (
    lastNativeStickAt > 0 &&
    now >= lastNativeStickAt &&
    now - lastNativeStickAt < CURSOR_NATIVE_SILENCE_MS
  );
}

/**
 * Fallback axes poll: Gamepad API axes of the first connected pad —
 * 2/3 move the pointer (right stick), 0/1 scroll (left stick). Only
 * called from the movement loop while Cursor Mode is active, and
 * only once native input has been silent for the full window — never
 * alongside a live native feed. One loop, no second poller: the
 * pointer and the scroll share this frame. (W1 OWNS the gamepad.ts
 * half: pollLoop must skip stickDirection() while Cursor Mode is
 * active, or the fallback left stick dual-routes into focus nav.)
 */
function pollFallbackAxes(now: number): void {
  if (isCursorFallbackSuppressed(now)) return;
  if (
    typeof navigator === "undefined" ||
    typeof navigator.getGamepads !== "function"
  ) {
    return;
  }
  const pads = navigator.getGamepads();
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad && pad.connected) {
      // Gamepad API axes are already Y-down-positive: no inversion.
      stickVector = { x: pad.axes[2] ?? 0, y: pad.axes[3] ?? 0 };
      scrollVector = { x: pad.axes[0] ?? 0, y: pad.axes[1] ?? 0 };
      return;
    }
  }
}

// ── Movement loop ─────────────────────────────────────────────────────

function frame(now: number): void {
  if (!active) return;
  rafId = requestAnimationFrame(frame);
  const dtMs =
    lastFrameAt === null ? 0 : Math.min(50, Math.max(0, now - lastFrameAt));
  lastFrameAt = now;
  pollFallbackAxes(now);

  // ── Pointer: right stick ──
  const deadzoned = applyStickDeadzone(stickVector.x, stickVector.y);
  const magnitude = Math.min(1, Math.hypot(deadzoned.x, deadzoned.y));
  const speed = magnitude > 0 ? cursorTargetSpeed(magnitude) : 0;
  const targetVx = magnitude > 0 ? (deadzoned.x / magnitude) * speed : 0;
  const targetVy = magnitude > 0 ? (deadzoned.y / magnitude) * speed : 0;
  // Stopping uses the shorter decel tau (snappier settle, less
  // overshoot); starting and steering keep the smoother tau.
  const tauX =
    targetVx === 0 ? CURSOR_DECEL_TAU_MS : CURSOR_SMOOTHING_TAU_MS;
  const tauY =
    targetVy === 0 ? CURSOR_DECEL_TAU_MS : CURSOR_SMOOTHING_TAU_MS;
  velocity = {
    x: smoothVelocity(velocity.x, targetVx, dtMs, tauX),
    y: smoothVelocity(velocity.y, targetVy, dtMs, tauY),
  };
  if (targetVx === 0 && Math.abs(velocity.x) < CURSOR_VELOCITY_REST_PX_S) {
    velocity.x = 0;
  }
  if (targetVy === 0 && Math.abs(velocity.y) < CURSOR_VELOCITY_REST_PX_S) {
    velocity.y = 0;
  }
  const nextPos = clampCursorPosition(
    pos.x + (velocity.x * dtMs) / 1000,
    pos.y + (velocity.y * dtMs) / 1000,
    window.innerWidth,
    window.innerHeight,
  );
  const moved = nextPos.x !== pos.x || nextPos.y !== pos.y;
  pos = nextPos;
  if (moved) positionPointer();

  // One elementFromPoint per frame feeds both hover and scroll
  // resolution. Hover fires on movement AND when the element under a
  // still pointer changes — scrolling moves content under the
  // pointer, and hover state must follow the content, not just the
  // pointer.
  const underPointer = elementUnderPointer();
  if (moved || underPointer !== lastHoverTarget) dispatchHover(underPointer);
  stepScroll(dtMs, underPointer);
}

function dispatchHover(target: Element | null): void {
  if (
    pos.x === lastHoverPos.x &&
    pos.y === lastHoverPos.y &&
    target === lastHoverTarget
  ) {
    return;
  }
  lastHoverPos = { ...pos };
  if (target === lastHoverTarget) {
    // Same element, new position: a real mouse fires move events.
    if (target) {
      dispatchPointerLike(target, "pointermove", mouseInit(0, 0));
      target.dispatchEvent(new MouseEvent("mousemove", mouseInit(0, 0)));
    }
    return;
  }
  const previous = lastHoverTarget;
  lastHoverTarget = target;
  if (previous) {
    dispatchPointerLike(previous, "pointerout", mouseInit(0, 0));
    previous.dispatchEvent(new MouseEvent("mouseout", mouseInit(0, 0)));
    // Enter/leave do not bubble in a real mouse stream; ancestors
    // must not see a child's enter/leave.
    dispatchPointerLike(previous, "pointerleave", mouseInit(0, 0, false));
    previous.dispatchEvent(new MouseEvent("mouseleave", mouseInit(0, 0, false)));
  }
  if (target) {
    dispatchPointerLike(target, "pointerover", mouseInit(0, 0));
    target.dispatchEvent(new MouseEvent("mouseover", mouseInit(0, 0)));
    dispatchPointerLike(target, "pointerenter", mouseInit(0, 0, false));
    target.dispatchEvent(new MouseEvent("mouseenter", mouseInit(0, 0, false)));
    dispatchPointerLike(target, "pointermove", mouseInit(0, 0));
    target.dispatchEvent(new MouseEvent("mousemove", mouseInit(0, 0)));
  }
}

/**
 * Left-stick scrolling for one frame. The scroll vector is deadzoned
 * radially (same dead zone as the pointer), eased to a target speed,
 * and applied as direct scrollTop/scrollLeft deltas — immediate and
 * controlled, never through CSS smooth-scroll behaviour, which would
 * lag a held stick behind the input. Scroll availability is reported
 * for hints even at rest, so the legend can say whether scrolling is
 * possible here before the user pushes the stick.
 */
function stepScroll(dtMs: number, underPointer: Element | null): void {
  const targets = resolveScrollTargetsFromElement(
    underPointer,
    safeFindOpenModal(document),
  );
  setScrollAvailable(targets.vertical !== null || targets.horizontal !== null);
  if (targets.blockedByModal) {
    scrollVelocity = { x: 0, y: 0 };
    return;
  }
  const deadzoned = applyStickDeadzone(scrollVector.x, scrollVector.y);
  const magnitude = Math.min(1, Math.hypot(deadzoned.x, deadzoned.y));
  const speed = magnitude > 0 ? cursorScrollSpeed(magnitude) : 0;
  const targetVx = magnitude > 0 ? (deadzoned.x / magnitude) * speed : 0;
  const targetVy = magnitude > 0 ? (deadzoned.y / magnitude) * speed : 0;
  scrollVelocity = {
    x: smoothVelocity(scrollVelocity.x, targetVx, dtMs, CURSOR_SCROLL_SMOOTHING_TAU_MS),
    y: smoothVelocity(scrollVelocity.y, targetVy, dtMs, CURSOR_SCROLL_SMOOTHING_TAU_MS),
  };
  if (targetVx === 0 && Math.abs(scrollVelocity.x) < CURSOR_VELOCITY_REST_PX_S) {
    scrollVelocity.x = 0;
  }
  if (targetVy === 0 && Math.abs(scrollVelocity.y) < CURSOR_VELOCITY_REST_PX_S) {
    scrollVelocity.y = 0;
  }
  const dx = (scrollVelocity.x * dtMs) / 1000;
  const dy = (scrollVelocity.y * dtMs) / 1000;
  if (dx !== 0 && targets.horizontal) {
    const el = targets.horizontal as HTMLElement;
    try {
      el.scrollLeft += dx;
    } catch {
      // A scroller that rejects assignment scrolls nothing; the
      // pointer and the other axis are unaffected.
    }
  }
  if (dy !== 0 && targets.vertical) {
    const el = targets.vertical as HTMLElement;
    try {
      el.scrollTop += dy;
    } catch {
      // See above.
    }
  }
}

function initialCursorPosition(): CursorVector {
  const focused = document.activeElement as HTMLElement | null;
  if (focused && focused !== document.body) {
    try {
      const rect = focused.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return clampCursorPosition(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
          window.innerWidth,
          window.innerHeight,
        );
      }
    } catch {
      // Fall through to the viewport centre.
    }
  }
  return {
    x: Math.max(0, window.innerWidth / 2),
    y: Math.max(0, window.innerHeight / 2),
  };
}

function positionPointer(): void {
  if (!pointerEl) return;
  pointerEl.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) translate(-50%, -50%)`;
}

// ── Pointer + indicator DOM (exist ONLY while active) ─────────────────

function ensurePointerDom(): void {
  if (pointerEl) return;
  styleEl = document.createElement("style");
  styleEl.dataset.cursorModeStyles = "true";
  styleEl.textContent = [
    "html[data-couch] .rs-cursor-pointer {",
    "  position: fixed; left: 0; top: 0; z-index: 200;",
    "  width: 26px; height: 26px; border-radius: 50%;",
    "  border: 2px solid rgba(255, 255, 255, 0.95);",
    "  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.45), 0 2px 10px rgba(0, 0, 0, 0.5);",
    "  pointer-events: none;",
    "}",
    "html[data-couch] .rs-cursor-pointer::after {",
    '  content: ""; position: absolute; left: 50%; top: 50%;',
    "  width: 5px; height: 5px; border-radius: 50%;",
    "  background: #fff; transform: translate(-50%, -50%);",
    "  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);",
    "}",
    "html[data-couch] .rs-cursor-mode-indicator {",
    "  position: fixed; right: 1rem; bottom: 0.75rem; z-index: 60;",
    "  padding: 0.45rem 0.9rem; border-radius: 999px;",
    "  font-family: var(--rs-font-body, inherit);",
    "  font-size: 0.8125rem; line-height: 1; font-weight: 600;",
    "  color: var(--rs-text, #fff);",
    "  background: color-mix(in srgb, var(--rs-bg, #14060a) 74%, transparent);",
    "  border: 1px solid var(--rs-line-soft, rgba(255,255,255,0.16));",
    "  box-shadow: var(--rs-shadow, 0 4px 16px rgba(0,0,0,0.4));",
    "  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);",
    "  pointer-events: none; white-space: nowrap;",
    "}",
  ].join("\n");
  document.head.appendChild(styleEl);

  pointerEl = document.createElement("div");
  pointerEl.className = "rs-cursor-pointer";
  pointerEl.dataset.cursorPointer = "true";
  pointerEl.setAttribute("aria-hidden", "true");
  document.body.appendChild(pointerEl);

  indicatorEl = document.createElement("div");
  indicatorEl.className = "rs-cursor-mode-indicator";
  indicatorEl.dataset.cursorModeIndicator = "true";
  indicatorEl.setAttribute("aria-hidden", "true");
  indicatorEl.textContent =
    "Cursor · Right stick moves · Left stick scrolls · A clicks · B exits";
  document.body.appendChild(indicatorEl);
}

function removePointerDom(): void {
  pointerEl?.remove();
  indicatorEl?.remove();
  styleEl?.remove();
  pointerEl = null;
  indicatorEl = null;
  styleEl = null;
}

// ── Click dispatch (DOM-synthetic; see the module docs) ───────────────

const CLICK_FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), " +
  "select:not([disabled]), textarea:not([disabled]), summary, " +
  "[tabindex]:not([tabindex='-1']), [role='button'], [role='tab']";

function elementUnderPointer(): Element | null {
  try {
    return document.elementFromPoint(pos.x, pos.y);
  } catch {
    return null;
  }
}

/**
 * Move DOM focus to the control under the pointer, like a real
 * mousedown does — spatial navigation follows real focus, so a click
 * that only dispatched events would leave focus behind. No-op when
 * the pointer is over non-focusable content. The focused control is
 * recorded as the session's last interaction, so exit restores focus
 * here rather than to the pre-cursor element (§6).
 */
function focusClickTarget(target: Element): HTMLElement | null {
  let focusable = (target as HTMLElement).closest?.(
    CLICK_FOCUSABLE,
  ) as HTMLElement | null;
  if (!focusable) {
    // A click on a <label> focuses its labelled control, like a
    // real mouse click does.
    const label = (target as HTMLElement).closest?.(
      "label",
    ) as HTMLLabelElement | null;
    const control = label?.control as HTMLElement | null;
    if (control) focusable = control;
  }
  if (!focusable) return null;
  recordInteraction(focusable);
  try {
    focusable.focus({ preventScroll: true });
  } catch {
    // Focus is best-effort; the click still goes out below.
  }
  return focusable;
}

/** Record a control the user interacted with during this session. */
function recordInteraction(el: HTMLElement): void {
  if (!active) return;
  if (el === document.body || el === document.documentElement) return;
  lastInteracted = el;
  interactedDuringSession = true;
}

function mouseInit(
  button: number,
  buttons: number,
  bubbles: boolean = true,
): MouseEventInit {
  // No `view`: it is optional, no handler reads event.view, and some
  // webview/jsdom realms reject a cross-realm Window here.
  return {
    bubbles,
    cancelable: true,
    composed: true,
    detail: 1,
    clientX: pos.x,
    clientY: pos.y,
    screenX: pos.x,
    screenY: pos.y,
    button,
    buttons,
  };
}

function dispatchPointerLike(
  target: Element,
  type: string,
  init: MouseEventInit,
): void {
  const pointerCtor = (window as unknown as { PointerEvent?: typeof PointerEvent })
    .PointerEvent;
  if (typeof pointerCtor === "function") {
    try {
      // Pointer handlers in the wild check pointerType / isPrimary;
      // a cursor click is a primary mouse-like pointer.
      target.dispatchEvent(
        new pointerCtor(type, {
          ...init,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
      return;
    } catch {
      // Fall through to a plain MouseEvent below.
    }
  }
  target.dispatchEvent(new MouseEvent(type, init));
}

/**
 * Click at the current pointer position. Left = the full mouse
 * sequence ending in `click`; right = the sequence ending in
 * `contextmenu` (the app's card/row menus listen for it). No-op while
 * inactive or when the pointer is over nothing. Never calls
 * el.click() — the dispatched `click` event IS the activation, and
 * calling both would fire handlers twice (and el.click() carries
 * zero coordinates, which would lie to handlers that read them).
 *
 * SYNTHETIC CLICKS AND DEFAULT BEHAVIOUR (0.11.14, W2): a dispatched
 * click event does not run a control's native default action the way
 * a trusted click does — a checkbox would not toggle, a radio would
 * not check, a range would not move. Handlers still fire, which
 * covers every custom Couch control, but native form controls need
 * the default action emulated explicitly. emulateControlDefault()
 * does that for checkbox / radio / range, and only when no handler
 * cancelled the click (a cancelled click means a handler claimed the
 * interaction). <select> dropdowns cannot be opened synthetically;
 * the click still focuses the select, and D-pad focus nav (retained
 * while Cursor Mode is active) changes its value. That is the one
 * known gap synthetic clicks leave, and it does not justify moving
 * the OS cursor with Win32 input — see the module docs.
 */
export function dispatchCursorClick(button: CursorClickButton): void {
  if (!active) return;
  const target = elementUnderPointer();
  if (!target) return;
  focusClickTarget(target);
  if (button === "left") {
    // Captured BEFORE the click dispatch: some engines (jsdom)
    // perform the control's default action on a dispatched click,
    // while browsers do not. The emulation below compares against
    // this snapshot and only acts when the state did not already
    // change — so a checkbox can never double-toggle in either.
    const before = captureControlState(target);
    dispatchPointerLike(target, "pointerdown", mouseInit(0, 1));
    target.dispatchEvent(new MouseEvent("mousedown", mouseInit(0, 1)));
    dispatchPointerLike(target, "pointerup", mouseInit(0, 0));
    target.dispatchEvent(new MouseEvent("mouseup", mouseInit(0, 0)));
    const notCancelled = target.dispatchEvent(
      new MouseEvent("click", mouseInit(0, 0)),
    );
    if (notCancelled) emulateControlDefault(before);
  } else {
    dispatchPointerLike(target, "pointerdown", mouseInit(2, 2));
    target.dispatchEvent(new MouseEvent("mousedown", mouseInit(2, 2)));
    target.dispatchEvent(new MouseEvent("contextmenu", mouseInit(2, 2)));
    dispatchPointerLike(target, "pointerup", mouseInit(2, 0));
    target.dispatchEvent(new MouseEvent("mouseup", mouseInit(2, 0)));
  }
}

function fireInputChange(el: HTMLElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

interface ControlStateBefore {
  input: HTMLInputElement;
  checked: boolean;
}

/**
 * The form control under (or wrapping) the click target, if any — the
 * input itself, or the labelled control when the click landed on a
 * <label> (a real label click activates its control).
 */
function captureControlState(target: Element): ControlStateBefore | null {
  let input = (target as HTMLElement).closest?.(
    "input",
  ) as HTMLInputElement | null;
  if (!input) {
    const label = (target as HTMLElement).closest?.(
      "label",
    ) as HTMLLabelElement | null;
    const control = label?.control;
    if (control instanceof HTMLInputElement) input = control;
  }
  if (!input || input.disabled) return null;
  return { input, checked: input.checked };
}

/**
 * Emulate the native default action of the clicked form control.
 * Best-effort and narrow: checkbox, radio, range. Anything else is a
 * handler-driven control, and the synthetic click above already
 * activated it. Each branch first checks whether the state already
 * moved (see captureControlState) — an engine that performed the
 * default action itself must not get a second, cancelling toggle.
 */
function emulateControlDefault(before: ControlStateBefore | null): void {
  if (!before) return;
  const { input } = before;
  try {
    const type = (input.type || "").toLowerCase();
    if (type === "checkbox") {
      if (input.checked !== before.checked) return;
      input.checked = !input.checked;
      fireInputChange(input);
    } else if (type === "radio") {
      if (input.checked) return;
      // Uncheck the rest of the group (same non-empty name, same
      // form root), like a real radio click does. Names are compared
      // directly instead of interpolated into a selector, so unusual
      // names can never break the query. An unnamed radio is its own
      // group and unchecks nothing.
      if (input.name) {
        const root = input.form ?? input.ownerDocument;
        const group = root.querySelectorAll('input[type="radio"]');
        group.forEach((other) => {
          const radio = other as HTMLInputElement;
          if (radio !== input && radio.name === input.name && radio.checked) {
            radio.checked = false;
            fireInputChange(radio);
          }
        });
      }
      input.checked = true;
      fireInputChange(input);
    } else if (type === "range") {
      const rect = input.getBoundingClientRect();
      if (rect.width <= 0) return;
      const parsedMin = parseFloat(input.min);
      const parsedMax = parseFloat(input.max);
      const parsedStep = parseFloat(input.step);
      const min = Number.isFinite(parsedMin) ? parsedMin : 0;
      const max = Number.isFinite(parsedMax) ? parsedMax : 100;
      const step = Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 1;
      const ratio = Math.max(0, Math.min(1, (pos.x - rect.left) / rect.width));
      const raw = min + ratio * (max - min);
      const stepped = min + Math.round((raw - min) / step) * step;
      const value = Math.max(min, Math.min(max, stepped));
      if (input.valueAsNumber !== value) {
        input.valueAsNumber = value;
        fireInputChange(input);
      }
    }
  } catch {
    // Emulation is best-effort; the synthetic click already fired.
  }
}

// ── Focus restore on exit ─────────────────────────────────────────────

const NEAREST_FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), " +
  "select:not([disabled]), textarea:not([disabled]), summary, " +
  "[tabindex]:not([tabindex='-1']), [role='button'], [role='tab']";

function isUsableFocusTarget(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const disabled = (el as HTMLButtonElement | HTMLInputElement).disabled;
  if (disabled) return false;
  try {
    if (getComputedStyle(el).visibility === "hidden") return false;
  } catch {
    // A style lookup failure must not veto an otherwise valid target.
  }
  return true;
}

/**
 * The meaningful control nearest to a viewport point (centre-to-point
 * distance), for exit restore when neither the last-interacted nor
 * the pre-cursor element is usable. Elements with no box (zero-size
 * rects) sort last — they are still candidates, so a page whose
 * layout has not been measured yet still yields a target.
 */
export function nearestFocusableToPoint(
  x: number,
  y: number,
  doc: Document = document,
): HTMLElement | null {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>(NEAREST_FOCUSABLE),
  ).filter(isUsableFocusTarget);
  if (candidates.length === 0) return null;
  let best: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    let rect: { left: number; top: number; width: number; height: number };
    try {
      rect = candidate.getBoundingClientRect();
    } catch {
      continue;
    }
    const hasBox = rect.width > 0 && rect.height > 0;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const distance = Math.hypot(cx - x, cy - y);
    // Box-less candidates lose to any boxed one, whatever the
    // distance — a zero rect reports the origin, which is meaningless.
    const score = hasBox ? distance : Number.MAX_SAFE_INTEGER + distance;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function restoreFocusOnExit(): void {
  const prev = focusBeforeCursor;
  const interacted = lastInteracted;
  const didInteract = interactedDuringSession;
  focusBeforeCursor = null;
  lastInteracted = null;
  interactedDuringSession = false;
  // A modal owns focus while open (dialog layer pulls stray focus
  // inside); never steal it back to any pre-cursor element.
  if (findOpenModal()) return;
  // §6: restore focus to the element last interacted with, if still
  // valid — the user may have clicked an entirely different part of
  // the page, and jumping back to the pre-cursor element would undo
  // that. The pre-cursor element only wins when nothing was
  // interacted with during the session.
  if (interacted && isUsableFocusTarget(interacted)) {
    interacted.focus({ preventScroll: true });
    return;
  }
  if (!didInteract && prev && isUsableFocusTarget(prev)) {
    prev.focus({ preventScroll: true });
    return;
  }
  // The interacted element is gone (or was never valid): the nearest
  // meaningful control to where the pointer ended up.
  const nearest = nearestFocusableToPoint(pos.x, pos.y);
  if (nearest) {
    nearest.focus({ preventScroll: true });
    return;
  }
  // Last resort: the couch-focus layer's own restore/seed, in the
  // same order initCouchFocus uses.
  if (!restoreCouchFocus(document)) seedInitialCouchFocus(document);
}

// ── Lifecycle: stop on focus loss, hide, disconnect, disable ─────────

export function mountCursorMode(): void {
  if (mounted || typeof window === "undefined") return;
  mounted = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setCursorModeActive(false);
  });
  window.addEventListener("blur", () => {
    setCursorModeActive(false);
  });
  window.addEventListener("gamepaddisconnected", () => {
    setCursorModeActive(false);
  });
  document.addEventListener(CURSOR_MODE_EVENT, (event) => {
    const value = (event as CustomEvent<{ value?: boolean }>).detail?.value;
    if (value === false) setCursorModeActive(false);
  });
  // 0.11.14 (W2): focus moves during a session — a D-pad move while
  // the cursor is up, or a click landing focus somewhere new — mark
  // the last-interacted element, so exit restore follows the user's
  // actual journey instead of the pre-cursor element.
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement) recordInteraction(target);
  });
  // A resize (window move, display change) must never strand the
  // pointer off-screen: re-clamp to the new viewport.
  window.addEventListener("resize", () => {
    if (!active) return;
    pos = clampCursorPosition(pos.x, pos.y, window.innerWidth, window.innerHeight);
    positionPointer();
  });
}

/**
 * Test-only reset: deactivate (restoring focus/hints through the
 * normal path) and clear the stick/arbitration state so focused tests
 * start clean. Not used by production code.
 */
export function resetCursorModeForTests(): void {
  if (active) setCursorModeActive(false);
  stickVector = { x: 0, y: 0 };
  scrollVector = { x: 0, y: 0 };
  velocity = { x: 0, y: 0 };
  scrollVelocity = { x: 0, y: 0 };
  lastNativeStickAt = 0;
  focusBeforeCursor = null;
  lastInteracted = null;
  interactedDuringSession = false;
  scrollAvailable = false;
  lastHoverTarget = null;
  lastHoverPos = { x: -1, y: -1 };
  try {
    delete document.documentElement.dataset.cursorScroll;
  } catch {
    // The dataset may be unavailable in a bare test realm.
  }
}
