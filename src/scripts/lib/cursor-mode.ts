// Nylah Studios — Controller Cursor Mode (0.11.10, W6).
//
// OPT-IN, ISOLATED: off by default (Settings → Display → Behavior →
// "Controller Cursor Mode"), and when the setting is off — or the
// frontend never subscribes — behaviour is byte-identical to 0.11.9:
// no pointer element exists, no rAF loop runs, no stick event moves
// anything, and R3 is the same no-op it always was.
//
// When enabled, R3 (right-stick click) toggles Cursor Mode. The right
// stick moves an on-screen pointer, A left-clicks, RB right-clicks,
// and B or R3 exits (page unchanged). D-pad / left-stick focus
// movement keeps working: directions never pass through the cursor
// guard in gamepad.ts, so they are untouched by this module.
//
// INPUT SOURCES — one vector, two feeds, native wins:
//   * Native XInput (primary): Rust forwards right-stick axes as
//     `xinput-stick` events (see xinput.rs); native-gamepad.ts calls
//     noteNativeStick(). Rate-bounded in Rust (~16 ms while deflected,
//     plus one zero event on return to centre).
//   * Browser Gamepad API (fallback): while Cursor Mode is active this
//     module's own rAF loop reads axes 2/3 of the first connected pad
//     — but ONLY after the same 1500 ms native-silence window
//     gamepad.ts uses for button arbitration (NATIVE_LIVE_WINDOW_MS),
//     so one physical stick can never drive the pointer twice.
// The two feeds write the same stick vector; the movement loop below
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
 * Native-silence window before the Gamepad API fallback axes may
 * drive the pointer — mirrors NATIVE_LIVE_WINDOW_MS in gamepad.ts.
 */
export const CURSOR_NATIVE_SILENCE_MS = 1500;

/** Legend shown while Cursor Mode is active (see the W1 note above). */
export const CURSOR_MODE_HINTS: HintConfig = {
  id: "cursor-mode",
  items: [
    { glyph: "a", label: "Click" },
    { glyph: "rb", label: "Right-click" },
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
// performance.now() of the last native stick vector, or 0 if none.
let lastNativeStickAt = 0;
let focusBeforeCursor: HTMLElement | null = null;

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
    pos = initialCursorPosition();
    velocity = { x: 0, y: 0 };
    ensurePointerDom();
    positionPointer();
    // The hints signal: TvButtonHints.astro renders
    // CURSOR_MODE_HINTS while this attribute is present.
    document.documentElement.dataset.cursorMode = "active";
    lastFrameAt = null;
    rafId = requestAnimationFrame(frame);
  } else {
    cancelAnimationFrame(rafId);
    rafId = 0;
    removePointerDom();
    delete document.documentElement.dataset.cursorMode;
    stickVector = { x: 0, y: 0 };
    velocity = { x: 0, y: 0 };
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
 * Fallback axes poll: Gamepad API axes 2/3 of the first connected
 * pad. Only called from the movement loop while Cursor Mode is
 * active, and only once native input has been silent for the full
 * window — never alongside a live native feed.
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
  const deadzoned = applyStickDeadzone(stickVector.x, stickVector.y);
  const magnitude = Math.min(1, Math.hypot(deadzoned.x, deadzoned.y));
  const speed = magnitude > 0 ? cursorTargetSpeed(magnitude) : 0;
  const targetVx = magnitude > 0 ? (deadzoned.x / magnitude) * speed : 0;
  const targetVy = magnitude > 0 ? (deadzoned.y / magnitude) * speed : 0;
  velocity = {
    x: smoothVelocity(velocity.x, targetVx, dtMs),
    y: smoothVelocity(velocity.y, targetVy, dtMs),
  };
  pos = clampCursorPosition(
    pos.x + (velocity.x * dtMs) / 1000,
    pos.y + (velocity.y * dtMs) / 1000,
    window.innerWidth,
    window.innerHeight,
  );
  positionPointer();
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
  indicatorEl.textContent = "Cursor · Right stick moves · A clicks · B exits";
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
  "select:not([disabled]), textarea:not([disabled]), " +
  "[tabindex]:not([tabindex='-1']), [role='button']";

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
 * the pointer is over non-focusable content.
 */
function focusClickTarget(target: Element): void {
  const focusable = (target as HTMLElement).closest?.(
    CLICK_FOCUSABLE,
  ) as HTMLElement | null;
  if (!focusable) return;
  try {
    focusable.focus({ preventScroll: true });
  } catch {
    // Focus is best-effort; the click still goes out below.
  }
}

function mouseInit(button: number, buttons: number): MouseEventInit {
  // No `view`: it is optional, no handler reads event.view, and some
  // webview/jsdom realms reject a cross-realm Window here.
  return {
    bubbles: true,
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
      target.dispatchEvent(new pointerCtor(type, init));
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
 * calling both would fire handlers twice.
 */
export function dispatchCursorClick(button: CursorClickButton): void {
  if (!active) return;
  const target = elementUnderPointer();
  if (!target) return;
  focusClickTarget(target);
  if (button === "left") {
    dispatchPointerLike(target, "pointerdown", mouseInit(0, 1));
    target.dispatchEvent(new MouseEvent("mousedown", mouseInit(0, 1)));
    dispatchPointerLike(target, "pointerup", mouseInit(0, 0));
    target.dispatchEvent(new MouseEvent("mouseup", mouseInit(0, 0)));
    target.dispatchEvent(new MouseEvent("click", mouseInit(0, 0)));
  } else {
    dispatchPointerLike(target, "pointerdown", mouseInit(2, 2));
    target.dispatchEvent(new MouseEvent("mousedown", mouseInit(2, 2)));
    target.dispatchEvent(new MouseEvent("contextmenu", mouseInit(2, 2)));
    dispatchPointerLike(target, "pointerup", mouseInit(2, 0));
    target.dispatchEvent(new MouseEvent("mouseup", mouseInit(2, 0)));
  }
}

// ── Focus restore on exit ─────────────────────────────────────────────

function restoreFocusOnExit(): void {
  const prev = focusBeforeCursor;
  focusBeforeCursor = null;
  // A modal owns focus while open (dialog layer pulls stray focus
  // inside); never steal it back to the pre-cursor element.
  if (findOpenModal()) return;
  if (prev && prev.isConnected) {
    prev.focus({ preventScroll: true });
    return;
  }
  // The pre-cursor element is gone: the couch-focus layer's own
  // restore/seed, in the same order initCouchFocus uses.
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
}

/**
 * Test-only reset: deactivate (restoring focus/hints through the
 * normal path) and clear the stick/arbitration state so focused tests
 * start clean. Not used by production code.
 */
export function resetCursorModeForTests(): void {
  if (active) setCursorModeActive(false);
  stickVector = { x: 0, y: 0 };
  velocity = { x: 0, y: 0 };
  lastNativeStickAt = 0;
  focusBeforeCursor = null;
}
