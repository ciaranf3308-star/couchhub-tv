// Nylah Studios — native XInput event bridge (0.11.4, W6).
//
// THE PRIMARY INPUT PATH. Rust (src-tauri/src/xinput.rs) polls XInput
// on a background thread from cold launch and emits three Tauri
// events; this module listens for them and feeds them into the SAME
// action pipeline the browser Gamepad API loop uses (gamepad.ts) —
// `dispatchNativeButton` / `dispatchNativeDirection`. There is one
// focus engine, not two, and the browser fallback stands down while
// native input is live (see noteNativeInputActive in gamepad.ts), so
// one physical press can never fire twice.
//
// Event surface (the contract integration verifies — keep stable):
//   xinput-button    { slot, button, pressed }   button: a | b | x | y |
//                                                lb | rb | lt | rt | view |
//                                                menu | left_stick |
//                                                right_stick
//   xinput-direction { slot, direction, phase, source }
//                                                direction: up | down |
//                                                left | right;
//                                                phase: start | end;
//                                                source: "dpad" |
//                                                "stick" (0.11.14 W2).
//                                                While Cursor Mode is
//                                                active, "stick"
//                                                directions are
//                                                dropped here — the
//                                                left stick scrolls
//                                                then — and "dpad"
//                                                directions pass, so
//                                                D-pad focus nav is
//                                                retained (no-dual-
//                                                route rule, §6).
//   xinput-stick     { slot, x, y }              right-stick axes, raw
//                                                i16 (0.11.10 W6,
//                                                Cursor Mode only)
//   xinput-scroll    { slot, x, y }              left-stick axes, raw
//                                                i16 (0.11.14 W2,
//                                                Cursor Mode scroll
//                                                only; same rate
//                                                bound as xinput-stick)
//   xinput-status    { available, slots[] }      connect / disconnect
//
// Slot discipline: only the first slot that produces input drives
// navigation (lowest connected slot wins, matching XInput's player
// numbering). A second pad's buttons are diagnostics only — they are
// still shown by ControllerStatus.svelte, they just never move focus.
//
// View+Menu return-home: the 2 s hold is enforced here, because the
// Rust thread only sends edges — a hold with no further edge would
// otherwise never complete. The timer fires dispatchReturnHome() only
// if both buttons are still held when it elapses.
//
// Outside Tauri (browser preview, Android) this module is a no-op:
// no __TAURI_INTERNALS__ means no Rust events exist, and the browser
// Gamepad API owns input there.

import { listen } from "@tauri-apps/api/event";
import {
  isCursorModeActive,
  noteNativeScrollStick,
  noteNativeStick,
  setCursorModeActive,
} from "./cursor-mode";
import {
  clearViewMenuHoldTimer,
  dispatchNativeButton,
  dispatchNativeDirection,
  dispatchReturnHome,
  noteNativeInputActive,
  setNativeDirectionActive,
  NATIVE_BUTTON_INDEX,
  type Direction,
  type NativeButtonName,
} from "./gamepad";

const RETURN_HOME_HOLD_MS = 2000;

interface XInputButtonPayload {
  slot: number;
  button: string;
  pressed: boolean;
}

interface XInputDirectionPayload {
  slot: number;
  direction: string;
  phase: string;
  /** "dpad" | "stick" (0.11.14 W2). Optional: older Rust builds omit it. */
  source?: string;
}

interface XInputStickPayload {
  slot: number;
  x: number;
  y: number;
}

interface XInputSlotPayload {
  slot: number;
  connected: boolean;
  subtype: string;
  display_name: string;
}

export interface XInputStatusPayload {
  available: boolean;
  slots: XInputSlotPayload[];
}

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    (!!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
      !!(window as unknown as Record<string, unknown>).__TAURI__)
  );
}

function isNativeButtonName(name: string): name is NativeButtonName {
  return Object.prototype.hasOwnProperty.call(NATIVE_BUTTON_INDEX, name);
}

function isDirection(name: string): name is Direction {
  return name === "up" || name === "down" || name === "left" || name === "right";
}

export function mountNativeGamepad(): void {
  if (typeof window === "undefined" || !isTauri()) return;
  const flag = "__couchhubTvNativeGamepadMounted" as const;
  if ((window as unknown as Record<string, unknown>)[flag]) return;
  (window as unknown as Record<string, unknown>)[flag] = true;

  // First slot that produces input wins; a second pad never drives
  // navigation (see the module docs).
  let activeSlot: number | null = null;
  // Buttons currently held on the active slot, by XInput name.
  const held = new Set<string>();
  let returnHomeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearReturnHomeTimer(): void {
    if (returnHomeTimer !== null) {
      clearTimeout(returnHomeTimer);
      returnHomeTimer = null;
    }
  }

  function armReturnHomeTimer(): void {
    if (returnHomeTimer !== null) return;
    if (!held.has("view") || !held.has("menu")) return;
    returnHomeTimer = setTimeout(() => {
      returnHomeTimer = null;
      // Only fire while the chord is still held — a release in the
      // meantime cancels the return-home.
      if (held.has("view") && held.has("menu")) {
        dispatchReturnHome();
        clearViewMenuHoldTimer();
      }
    }, RETURN_HOME_HOLD_MS);
  }

  function slotOwnsEvent(slot: number): boolean {
    if (activeSlot === null) {
      activeSlot = slot;
      return true;
    }
    return activeSlot === slot;
  }

  void listen<XInputButtonPayload>("xinput-button", (event) => {
    const { slot, button, pressed } = event.payload;
    if (!slotOwnsEvent(slot) || !isNativeButtonName(button)) return;
    noteNativeInputActive();
    if (pressed) held.add(button);
    else held.delete(button);
    if (held.has("view") && held.has("menu")) armReturnHomeTimer();
    else clearReturnHomeTimer();
    dispatchNativeButton(button, pressed);
  });

  void listen<XInputDirectionPayload>("xinput-direction", (event) => {
    const { slot, direction, phase, source } = event.payload;
    if (!slotOwnsEvent(slot) || !isDirection(direction)) return;
    noteNativeInputActive();
    // 0.11.14 (W2, §6) NO-DUAL-ROUTE: while Cursor Mode is active the
    // left stick scrolls (xinput-scroll, below) and must never also
    // move focus. Stick-sourced directions are dropped entirely — no
    // dispatch, no held-direction state — while D-pad directions pass
    // through untouched, so D-pad focus nav is retained. A missing
    // source (older Rust) is treated as D-pad: dropping an
    // unattributed direction would strand focus navigation.
    if (source === "stick" && isCursorModeActive()) return;
    if (phase === "start") {
      setNativeDirectionActive(true);
      dispatchNativeDirection(direction);
    } else if (phase === "end") {
      setNativeDirectionActive(false);
      dispatchNativeDirection(null);
    }
  });

  // 0.11.10 (W6): right-stick axes for Cursor Mode. Same slot
  // discipline as buttons/directions — only the driving slot's stick
  // moves the pointer — and the same native-liveness note, so the
  // browser fallback stands down while the stick is moving. Deadzone
  // + scaling live in cursor-mode.ts; when Cursor Mode is off this
  // only stores a vector and moves nothing.
  void listen<XInputStickPayload>("xinput-stick", (event) => {
    const { slot, x, y } = event.payload;
    if (!slotOwnsEvent(slot)) return;
    noteNativeInputActive();
    noteNativeStick(x, y);
  });

  // 0.11.14 (W2, §6): left-stick axes for Cursor Mode scrolling.
  // Same slot discipline and native-liveness note as xinput-stick;
  // deadzone + scroll speed live in cursor-mode.ts, and when Cursor
  // Mode is off this only stores a vector and scrolls nothing.
  void listen<XInputStickPayload>("xinput-scroll", (event) => {
    const { slot, x, y } = event.payload;
    if (!slotOwnsEvent(slot)) return;
    noteNativeInputActive();
    noteNativeScrollStick(x, y);
  });

  // 0.11.14 (W2, §6): a left stick held deflected across R3 already
  // started a native direction (with its repeat ticker in gamepad.ts)
  // before Cursor Mode existed — Rust sends no new edge until the
  // stick re-centres, so without this the ticker would keep moving
  // focus under the cursor. Activation cancels the held direction;
  // the stick must re-deflect to move focus again after exit, which
  // matches the edge semantics everywhere else. D-pad directions
  // after activation still flow (see the suppression above).
  window.addEventListener("couch:cursor-mode", (event) => {
    const detail = (event as CustomEvent<{ active?: boolean }>).detail;
    if (detail?.active === true) {
      setNativeDirectionActive(false);
      dispatchNativeDirection(null);
    }
  });

  void listen<XInputStatusPayload>("xinput-status", (event) => {
    // A status event proves the Rust poll thread is alive. A
    // disconnect of the driving slot releases it, so a reconnected
    // pad (possibly at a new slot) can take over.
    noteNativeInputActive();
    for (const slot of event.payload.slots ?? []) {
      if (slot.slot === activeSlot && !slot.connected) {
        activeSlot = null;
        held.clear();
        clearReturnHomeTimer();
        setNativeDirectionActive(false);
        dispatchNativeDirection(null);
        // 0.11.10 (W6): a disconnected pad must never leave the
        // cursor stranded on screen — Cursor Mode stops with it.
        setCursorModeActive(false);
      }
    }
  });
}
