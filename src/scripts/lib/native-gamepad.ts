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
//   xinput-direction { slot, direction, phase }  direction: up | down |
//                                                left | right;
//                                                phase: start | end
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
    const { slot, direction, phase } = event.payload;
    if (!slotOwnsEvent(slot) || !isDirection(direction)) return;
    noteNativeInputActive();
    if (phase === "start") {
      setNativeDirectionActive(true);
      dispatchNativeDirection(direction);
    } else if (phase === "end") {
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
      }
    }
  });
}
