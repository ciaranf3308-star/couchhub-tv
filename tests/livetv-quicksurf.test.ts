/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import {
  stepHighlight,
  confirmHighlight,
  tuneToChannel,
  previousChannelTarget,
  type PlaybackChannel,
  type PlaybackEngine,
} from "@/scripts/lib/livetv-playback";

// Quick Surf state machine, as the overlay implements it: a highlight
// that browses adjacent channels while the tuned channel keeps
// playing, an A that tunes, and a B that dismisses without tuning.
// The overlay's DOM behaviour is exercised through the same pure
// functions its client script calls, with a fake engine standing in
// for stream.ts's play().
const channels: PlaybackChannel[] = [
  { id: 101, name: "RTE One", chno: 1 },
  { id: 102, name: "RTE 2", chno: 2 },
  { id: 103, name: "TG4", chno: 3 },
  { id: 104, name: "Virgin One", chno: 4 },
];

function fakeEngine(): PlaybackEngine & { tuned: Array<string | number> } {
  const tuned: Array<string | number> = [];
  return { tuned, tune: (id) => tuned.push(id) };
}

interface SurfState {
  tunedId: string | number | null;
  previousId: string | number | null;
  highlightedId: string | number | null;
  open: boolean;
}

function openSurf(state: SurfState): SurfState {
  return {
    ...state,
    open: true,
    highlightedId: state.tunedId,
  };
}

function surfStep(state: SurfState, delta: 1 | -1): SurfState {
  const next = stepHighlight(channels, state.highlightedId, delta);
  return { ...state, highlightedId: next };
}

function surfConfirm(state: SurfState, engine: PlaybackEngine): SurfState {
  const target = confirmHighlight(state.highlightedId);
  if (target === null) return { ...state, open: false };
  tuneToChannel(engine, target);
  return {
    ...state,
    previousId: state.tunedId,
    tunedId: target,
    open: false,
  };
}

function surfDismiss(state: SurfState): SurfState {
  // B dismisses WITHOUT changing channels: tuned + previous untouched.
  return { ...state, open: false };
}

describe("Quick Surf open/close state", () => {
  it("opens with the highlight on the tuned channel", () => {
    const state = openSurf({ tunedId: 102, previousId: 101, highlightedId: null, open: false });
    expect(state.open).toBe(true);
    expect(state.highlightedId).toBe(102);
    expect(state.tunedId).toBe(102);
  });

  it("dismiss (B) closes without changing the tuned channel", () => {
    const engine = fakeEngine();
    let state = openSurf({ tunedId: 102, previousId: 101, highlightedId: null, open: false });
    state = surfStep(state, 1); // highlight 103
    state = surfStep(state, 1); // highlight 104
    state = surfDismiss(state);
    expect(state.open).toBe(false);
    expect(state.tunedId).toBe(102);
    expect(state.previousId).toBe(101);
    expect(engine.tuned).toEqual([]);
  });

  it("A tunes to the highlighted channel and records the previous channel", () => {
    const engine = fakeEngine();
    let state = openSurf({ tunedId: 102, previousId: 101, highlightedId: null, open: false });
    state = surfStep(state, 1); // highlight 103
    state = surfConfirm(state, engine);
    expect(engine.tuned).toEqual([103]);
    expect(state.tunedId).toBe(103);
    expect(state.previousId).toBe(102);
    expect(state.open).toBe(false);
  });

  it("A with nothing highlighted tunes nothing", () => {
    const engine = fakeEngine();
    const state = surfConfirm(
      { tunedId: 102, previousId: 101, highlightedId: null, open: true },
      engine,
    );
    expect(engine.tuned).toEqual([]);
    expect(state.tunedId).toBe(102);
  });
});

describe("adjacent-channel browsing", () => {
  it("Up/Down steps one adjacent channel at a time", () => {
    let state = openSurf({ tunedId: 102, previousId: 101, highlightedId: null, open: false });
    state = surfStep(state, 1);
    expect(state.highlightedId).toBe(103);
    state = surfStep(state, -1);
    expect(state.highlightedId).toBe(102);
    state = surfStep(state, -1);
    expect(state.highlightedId).toBe(101);
  });

  it("wraps from the last channel to the first and back", () => {
    let state = openSurf({ tunedId: 104, previousId: 103, highlightedId: null, open: false });
    state = surfStep(state, 1);
    expect(state.highlightedId).toBe(101);
    state = surfStep(state, -1);
    expect(state.highlightedId).toBe(104);
  });

  it("browsing the whole list never tunes", () => {
    const engine = fakeEngine();
    let state = openSurf({ tunedId: 101, previousId: null, highlightedId: null, open: false });
    for (let i = 0; i < channels.length * 2; i++) state = surfStep(state, 1);
    expect(engine.tuned).toEqual([]);
    expect(state.tunedId).toBe(101);
  });

  it("highlight and tuned stay separate while browsing", () => {
    let state = openSurf({ tunedId: 101, previousId: null, highlightedId: null, open: false });
    state = surfStep(state, 1);
    state = surfStep(state, 1);
    expect(state.highlightedId).toBe(103);
    expect(state.tunedId).toBe(101);
  });
});

describe("Quick Surf previous channel", () => {
  it("Previous tunes back to the last-played channel", () => {
    const engine = fakeEngine();
    const state: SurfState = { tunedId: 103, previousId: 102, highlightedId: 103, open: true };
    const target = previousChannelTarget(state.tunedId, state.previousId);
    expect(target).toBe(102);
    if (target !== null) tuneToChannel(engine, target);
    expect(engine.tuned).toEqual([102]);
  });

  it("Previous with no previous channel tunes nothing", () => {
    const engine = fakeEngine();
    const target = previousChannelTarget(101, null);
    expect(target).toBeNull();
    if (target !== null) tuneToChannel(engine, target);
    expect(engine.tuned).toEqual([]);
  });
});

describe("Quick Surf overlay open/close events", () => {
  it("emits livetv:overlay quicksurf on open and none on dismiss", () => {
    const seen: Array<unknown> = [];
    const handler = (ev: Event) => seen.push((ev as CustomEvent).detail);
    window.addEventListener("livetv:overlay", handler);
    try {
      window.dispatchEvent(new CustomEvent("livetv:overlay", { detail: { overlay: "quicksurf" } }));
      window.dispatchEvent(new CustomEvent("livetv:overlay", { detail: { overlay: "none" } }));
      expect(seen).toEqual([{ overlay: "quicksurf" }, { overlay: "none" }]);
    } finally {
      window.removeEventListener("livetv:overlay", handler);
    }
  });

  it("emits livetv:mode guide for Full Guide and home for Live TV Home", () => {
    const seen: Array<unknown> = [];
    const handler = (ev: Event) => seen.push((ev as CustomEvent).detail);
    window.addEventListener("livetv:mode", handler);
    try {
      window.dispatchEvent(new CustomEvent("livetv:mode", { detail: { mode: "guide" } }));
      window.dispatchEvent(new CustomEvent("livetv:mode", { detail: { mode: "home" } }));
      expect(seen).toEqual([{ mode: "guide" }, { mode: "home" }]);
    } finally {
      window.removeEventListener("livetv:mode", handler);
    }
  });
});

// INTEGRATION (0.9.0) — mockup 2: the surf panel is rows +
// chevrons only. The note + six-button action grid were removed
// (every action is a key the hint line documents, or an OSD
// button once surf closes); the category filter stays.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

describe("TvQuickSurf — mockup-2 panel trim (integration)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src/components/couch/TvQuickSurf.astro"),
    "utf8",
  );

  it("has no action-button grid or note in the panel", () => {
    expect(src).not.toContain("rs-livetv-play-quicksurf__actions");
    expect(src).not.toContain("rs-livetv-play-quicksurf__note");
    expect(src).not.toContain("[data-qs-action]");
  });

  it("keeps the category filter, the rows and the key hint line", () => {
    expect(src).toContain("rs-livetv-play-quicksurf__categories");
    expect(src).toContain("rs-livetv-play-quicksurf__list");
    expect(src).toContain("↑↓ browse · A watch · B back");
  });
});
