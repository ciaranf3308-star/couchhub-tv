// DELIBERATELY BROKEN — RED-VERIFICATION ONLY. DO NOT SHIP.
//
// Mirrors the nav stub's API but back() pops TWO layers per press
// (and can pop the root) — the defect test 11 guards against.
// Delete on integration.

import type { LivetvNavLayerId } from "../nav.stub";

export class BrokenLivetvNavStack {
  private layers: LivetvNavLayerId[];

  constructor(root: LivetvNavLayerId = "landing") {
    this.layers = [root];
  }

  push(layer: LivetvNavLayerId): void {
    this.layers.push(layer);
  }

  /** BROKEN: pops two layers, and pops through the root. */
  back(): boolean {
    if (this.layers.length === 0) return false;
    this.layers.pop();
    this.layers.pop();
    return true;
  }

  top(): LivetvNavLayerId {
    return this.layers[this.layers.length - 1] ?? "landing";
  }

  depth(): number {
    return this.layers.length;
  }

  snapshot(): readonly LivetvNavLayerId[] {
    return [...this.layers];
  }
}

export function createBrokenLivetvNavStack(
  root: LivetvNavLayerId = "landing",
): BrokenLivetvNavStack {
  return new BrokenLivetvNavStack(root);
}
