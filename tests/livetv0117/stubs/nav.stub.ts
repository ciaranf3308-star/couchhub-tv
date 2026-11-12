// STUB-FOR-INTEGRATION — DO NOT SHIP. DELETE ON INTEGRATION.
//
// Minimal implementation of the W4 nav layer-stack contract, kept
// ONLY under tests/. W4's real module is
// src/scripts/lib/livetv-nav.ts.
//
// INTEGRATION: delete this file. Point the tests at the real
// livetv-nav module. The real module MUST preserve these semantics
// (adapt names/wiring only, never weaken the assertions):
//   - back() pops EXACTLY ONE layer, and never pops the root;
//   - only the visible (top) mode accepts input; hidden modes
//     reject input without side effects (LivetvInputGate);
//   - one `livetv:close-overlay` event closes exactly one overlay
//     layer (attachNavEventWiring).

export type LivetvNavLayerId =
  | "landing"
  | "browser"
  | "guide"
  | "playback"
  | "search"
  | "sort"
  | "options"
  | "programme"
  | "osd"
  | "quicksurf";

const OVERLAY_LAYERS: ReadonlySet<LivetvNavLayerId> = new Set([
  "search",
  "sort",
  "options",
  "programme",
  "osd",
  "quicksurf",
]);

export function isOverlayLayer(layer: LivetvNavLayerId): boolean {
  return OVERLAY_LAYERS.has(layer);
}

/** One explicit nav model: a stack, root first, top last. */
export class LivetvNavStack {
  private layers: LivetvNavLayerId[];

  constructor(root: LivetvNavLayerId = "landing") {
    this.layers = [root];
  }

  push(layer: LivetvNavLayerId): void {
    this.layers.push(layer);
  }

  /** Pop the top layer. Returns null at the root (root never pops). */
  pop(): LivetvNavLayerId | null {
    if (this.layers.length <= 1) return null;
    return this.layers.pop() ?? null;
  }

  /**
   * B / back: pop exactly ONE layer. True when a layer closed,
   * false at the root (nothing to close).
   */
  back(): boolean {
    return this.pop() !== null;
  }

  top(): LivetvNavLayerId {
    return this.layers[this.layers.length - 1]!;
  }

  depth(): number {
    return this.layers.length;
  }

  snapshot(): readonly LivetvNavLayerId[] {
    return [...this.layers];
  }

  contains(layer: LivetvNavLayerId): boolean {
    return this.layers.includes(layer);
  }

  reset(root: LivetvNavLayerId = "landing"): void {
    this.layers = [root];
  }
}

export function createLivetvNavStack(
  root: LivetvNavLayerId = "landing",
): LivetvNavStack {
  return new LivetvNavStack(root);
}

export type LivetvNavMode = "landing" | "browser" | "guide" | "playback";

/**
 * Input gate: hidden Live TV modes cannot steal input. Only the
 * active mode accepts input; when an overlay is on top, only the
 * overlay accepts input and the mode underneath is gated too.
 */
export class LivetvInputGate {
  private activeMode: LivetvNavMode;
  private overlay: LivetvNavLayerId | null;

  constructor(activeMode: LivetvNavMode = "landing") {
    this.activeMode = activeMode;
    this.overlay = null;
  }

  setActiveMode(mode: LivetvNavMode): void {
    this.activeMode = mode;
    this.overlay = null;
  }

  openOverlay(layer: LivetvNavLayerId): void {
    this.overlay = layer;
  }

  closeOverlay(): void {
    this.overlay = null;
  }

  getActiveMode(): LivetvNavMode {
    return this.activeMode;
  }

  getOverlay(): LivetvNavLayerId | null {
    return this.overlay;
  }

  /** True only for the layer that is actually on top. */
  canAcceptInput(layer: LivetvNavLayerId): boolean {
    if (this.overlay !== null) return layer === this.overlay;
    return layer === this.activeMode;
  }

  /**
   * Deliver input to `layer` only when it can accept it. Returns
   * true when the handler ran, false when the input was gated
   * (handler never invoked, no side effects).
   */
  deliverInput(layer: LivetvNavLayerId, handler: () => void): boolean {
    if (!this.canAcceptInput(layer)) return false;
    handler();
    return true;
  }
}

export function createLivetvInputGate(
  activeMode: LivetvNavMode = "landing",
): LivetvInputGate {
  return new LivetvInputGate(activeMode);
}

/**
 * Wire `livetv:close-overlay` to the stack: one event pops exactly
 * one overlay layer (and only when the top layer IS an overlay).
 * Returns a detach function. The listener is registered on window,
 * matching the existing livetv:* event surface.
 */
export function attachNavEventWiring(stack: LivetvNavStack): () => void {
  const onCloseOverlay = (): void => {
    if (isOverlayLayer(stack.top())) stack.back();
  };
  window.addEventListener("livetv:close-overlay", onCloseOverlay);
  return () => window.removeEventListener("livetv:close-overlay", onCloseOverlay);
}
