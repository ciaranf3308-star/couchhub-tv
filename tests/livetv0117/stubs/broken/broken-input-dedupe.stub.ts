// DELIBERATELY BROKEN — RED-VERIFICATION ONLY. DO NOT SHIP.
//
// Mirrors the button-edge tracker's API but emits an action for
// EVERY pressed sample (no edge detection, no cross-source
// dedupe) — the defect test 10 guards against. Delete on
// integration.

import {
  livetvGamepadActionForButton,
  type LivetvKeyAction,
  type LivetvKeyContextInput,
} from "@/scripts/lib/livetv-keys";
import type { ButtonSample, EmittedButtonAction } from "../input-dedupe.stub";

export class BrokenButtonEdgeTracker {
  private readonly context: LivetvKeyContextInput;

  constructor(context: LivetvKeyContextInput) {
    this.context = context;
  }

  /** BROKEN: every held sample emits. */
  feed(sample: ButtonSample): EmittedButtonAction | null {
    if (!sample.pressed) return null;
    const action: LivetvKeyAction | null = livetvGamepadActionForButton(
      this.context,
      sample.button,
    );
    if (action === null) return null;
    return { button: sample.button, action, atMs: sample.atMs, source: sample.source };
  }
}

export function createBrokenButtonEdgeTracker(
  context: LivetvKeyContextInput,
): BrokenButtonEdgeTracker {
  return new BrokenButtonEdgeTracker(context);
}
