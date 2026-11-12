// STUB-FOR-INTEGRATION — DO NOT SHIP. DELETE ON INTEGRATION.
//
// Button-edge + cross-source dedupe harness for the LB/RB/LT/RT
// contract (test 10). The production gamepad layer already
// forwards edges only (see gamepad.ts); this stub exists so the
// dedupe requirement is testable hermetically against BOTH input
// sources (native XInput + browser Gamepad API) reporting the
// same physical press. Kept ONLY under tests/. Action resolution
// delegates to the REAL livetvGamepadActionForButton by default.
//
// INTEGRATION: delete this file. Point the tests at the real
// input path (gamepad.ts edge handling + livetv-keys mapping).
// The real path MUST preserve these semantics (adapt wiring
// only, never weaken the assertions):
//   - one physical press = exactly one action, however many
//     poll samples report it held, and whichever sources report it;
//   - a second action requires a full release first;
//   - distinct buttons are independent.

import {
  livetvGamepadActionForButton,
  type LivetvKeyAction,
  type LivetvKeyContextInput,
} from "@/scripts/lib/livetv-keys";

export type InputSource = "xinput" | "gamepad";

export interface ButtonSample {
  source: InputSource;
  /** Standard gamepad button index (see LIVETV_GAMEPAD_BUTTONS). */
  button: number;
  pressed: boolean;
  /** Sample timestamp in ms (caller clock; deterministic in tests). */
  atMs: number;
}

export interface EmittedButtonAction {
  button: number;
  action: LivetvKeyAction;
  atMs: number;
  source: InputSource;
}

export interface ButtonEdgeTrackerOptions {
  context: LivetvKeyContextInput;
  guideMode?: "now" | "tonight" | "channel" | "grid";
  resolveAction?: (
    context: LivetvKeyContextInput,
    button: number,
  ) => LivetvKeyAction | null;
}

export class ButtonEdgeTracker {
  private readonly context: LivetvKeyContextInput;
  private readonly guideMode: ButtonEdgeTrackerOptions["guideMode"];
  private readonly resolveAction: (
    context: LivetvKeyContextInput,
    button: number,
  ) => LivetvKeyAction | null;
  /** Per-button, per-source pressed state. */
  private readonly pressedBySource = new Map<number, Map<InputSource, boolean>>();
  /** Buttons whose press has already been emitted and not yet released. */
  private readonly emitted = new Set<number>();

  constructor(opts: ButtonEdgeTrackerOptions) {
    this.context = opts.context;
    this.guideMode = opts.guideMode;
    this.resolveAction =
      opts.resolveAction ??
      ((context, button) =>
        livetvGamepadActionForButton(context, button, {
          guideMode: this.guideMode,
        }));
  }

  /**
   * Feed one poll sample. Returns the action on the rising edge
   * only (first press across all sources); held samples, duplicate
   * cross-source reports and releases return null. Unmapped
   * buttons return null but still track pressed state, so a later
   * press after release is a fresh edge.
   */
  feed(sample: ButtonSample): EmittedButtonAction | null {
    let perSource = this.pressedBySource.get(sample.button);
    if (!perSource) {
      perSource = new Map();
      this.pressedBySource.set(sample.button, perSource);
    }
    const wasPressed = [...perSource.values()].some(Boolean);
    perSource.set(sample.source, sample.pressed);
    const isPressed = [...perSource.values()].some(Boolean);

    if (!isPressed) {
      // Fully released on every source: the next press is a new edge.
      this.emitted.delete(sample.button);
      return null;
    }
    if (wasPressed || this.emitted.has(sample.button)) return null;
    this.emitted.add(sample.button);
    const action = this.resolveAction(this.context, sample.button);
    if (action === null) return null;
    return { button: sample.button, action, atMs: sample.atMs, source: sample.source };
  }

  reset(): void {
    this.pressedBySource.clear();
    this.emitted.clear();
  }
}

export function createButtonEdgeTracker(
  opts: ButtonEdgeTrackerOptions,
): ButtonEdgeTracker {
  return new ButtonEdgeTracker(opts);
}
