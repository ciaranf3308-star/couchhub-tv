// SHIM-0110: replaced by W1/W3 implementation at integration.
//
// Controller Experience 2.0 (0.11.10) seam contracts, as temporary
// implementations over the real 0.11.9 mechanisms. W1 owns the
// hints/focus contracts (couch-button-hints.ts / couch-focus.ts)
// and W3 owns the keyboard contract (couch-keyboard.ts); those
// modules do not export these functions yet in the 0.11.9 tree, so
// Live TV builds against THIS module's identical signatures and
// integration deletes this file and re-points the imports. Every
// function here does real work against the live DOM — nothing is
// a silent stub — but the W1/W3 implementations supersede them.
//
//   setControllerHints(config)  — W1: couch-button-hints.ts
//   getControllerHints()        — W1: couch-button-hints.ts
//   setLogicalView(view)        — W1: couch-focus.ts
//   getLogicalView()            — W1: couch-focus.ts
//   openCouchKeyboard / closeCouchKeyboard / isCouchKeyboardOpen
//                               — W3: couch-keyboard.ts
//
// Hints: the Live TV hints bar (TvLivetvHints) already re-renders
// from the nav stack, so setControllerHints both dispatches the
// `couch:controller-hints` event W1 will consume AND writes the
// bar's list directly (via the same renderer the bar uses). A
// later nav-stack change re-renders the bar from the new layer,
// which is the same config the caller passes at a mode switch —
// the two paths agree, never fight.
//
// Focus: setLogicalView mirrors the view onto
// html[data-couch-logical-view] and dispatches
// `couch:logical-view`, so focus memory stays mode-correct once
// W1's implementation reads it.
//
// Keyboard: openCouchKeyboard records the editing input + commit
// callback and focuses the input; closeCouchKeyboard optionally
// commits, blurs, and clears the record; isCouchKeyboardOpen
// reports the record (a disconnected input clears it lazily).
// Live TV + Guide search inputs invoke editing ONLY through
// these functions — never by focusing an input directly.

import type { HintConfig } from "./couch-button-hints.js";
import { livetvHintsListHtml } from "./livetv-hints.js";

export type { HintConfig };

/** Event dispatched by setControllerHints for W1's hints owner. */
export const CONTROLLER_HINTS_EVENT = "couch:controller-hints";

/** Event dispatched by setLogicalView for W1's focus owner. */
export const LOGICAL_VIEW_EVENT = "couch:logical-view";

/** Logical Live TV views, for focus memory (W1 contract values). */
export type CouchLogicalView =
  | "livetv-landing"
  | "livetv-browser"
  | "livetv-guide"
  | "livetv-playback";

/**
 * SHIM-0110: route a hint config to the controller hints bar.
 * Dispatches `couch:controller-hints` {config} on window and
 * writes the Live TV hints list directly when it is mounted.
 * A null config clears the bar (the W1 contract's clear signal).
 * Never throws; no-ops without a DOM.
 */
export function setControllerHints(config: HintConfig | null): void {
  lastHintConfig = config;
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent(CONTROLLER_HINTS_EVENT, { detail: { config } }),
      );
    } catch {
      // Dispatch failures never break navigation.
    }
  }
  if (typeof document === "undefined") return;
  try {
    const list = document.querySelector<HTMLElement>("[data-livetv-hints-list]");
    if (list) {
      if (config == null) {
        list.innerHTML = "";
        delete list.dataset["config"];
        const nav = list.closest<HTMLElement>("[data-livetv-hints]");
        if (nav) delete nav.dataset["config"];
      } else {
        list.innerHTML = livetvHintsListHtml(config);
        list.dataset["config"] = config.id;
        const nav = list.closest<HTMLElement>("[data-livetv-hints]");
        if (nav) nav.dataset["config"] = config.id;
      }
    }
  } catch {
    // A missing/mutating bar never breaks navigation.
  }
}

/** Last hint config routed through setControllerHints (null = cleared/none). */
let lastHintConfig: HintConfig | null = null;

/**
 * SHIM-0110: the last hint config routed through
 * setControllerHints, or null when none was set / it was
 * cleared. Lets callers read back the current owner without
 * depending on the hints bar's DOM.
 */
export function getControllerHints(): HintConfig | null {
  return lastHintConfig;
}

/**
 * SHIM-0110: record the logical view for focus memory.
 * Mirrors onto html[data-couch-logical-view] and dispatches
 * `couch:logical-view` {view} on window. Never throws; no-ops
 * without a DOM.
 */
export function setLogicalView(view: CouchLogicalView | string): void {
  lastLogicalView = view;
  if (typeof document !== "undefined") {
    try {
      const root = document.documentElement;
      if (root) root.dataset["couchLogicalView"] = view;
    } catch {
      // Mirror failures never break navigation.
    }
  }
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent(LOGICAL_VIEW_EVENT, { detail: { view } }),
      );
    } catch {
      // Dispatch failures never break navigation.
    }
  }
}

/** Last logical view recorded through setLogicalView (null = none yet). */
let lastLogicalView: string | null = null;

/**
 * SHIM-0110: the last logical view recorded through
 * setLogicalView, or null when none was recorded yet.
 */
export function getLogicalView(): string | null {
  return lastLogicalView;
}

// ── Couch keyboard (W3 contract) ────────────────────────────────

/** Commit callback: receives the input's value on commit-close. */
export type CouchKeyboardCommit = (value: string) => void;

interface OpenKeyboardRecord {
  input: HTMLInputElement;
  onCommit?: CouchKeyboardCommit;
}

let openKeyboard: OpenKeyboardRecord | null = null;

/**
 * SHIM-0110: begin editing `input` through the shared keyboard
 * contract. Focuses the input (when it is not already focused)
 * and records it as the open keyboard, so isCouchKeyboardOpen()
 * and closeCouchKeyboard() agree with the editing state. The
 * optional onCommit runs only on a committing close. Returns
 * false when there is no input to edit.
 */
export function openCouchKeyboard(
  input: HTMLInputElement | null | undefined,
  onCommit?: CouchKeyboardCommit,
): boolean {
  if (!input) return false;
  openKeyboard = { input, onCommit };
  try {
    if (
      typeof document !== "undefined" &&
      document.activeElement !== input &&
      typeof input.focus === "function"
    ) {
      input.focus({ preventScroll: true });
    }
  } catch {
    // Focus failures never break the record: editing state is
    // what callers branch on, not the focus call itself.
  }
  return true;
}

/**
 * SHIM-0110: end the open keyboard edit. When `commit` is true
 * the recorded onCommit runs with the input's current value;
 * otherwise the value is left untouched. Blurs the input when it
 * holds focus and clears the record. Returns true when a
 * keyboard was actually open. A committing close that throws in
 * the callback still clears the record (editing ended).
 */
export function closeCouchKeyboard(commit: boolean): boolean {
  const record = openKeyboard;
  openKeyboard = null;
  if (!record) return false;
  if (commit && record.onCommit) {
    try {
      record.onCommit(record.input.value ?? "");
    } catch {
      // A throwing commit callback never re-opens editing.
    }
  }
  try {
    if (
      typeof document !== "undefined" &&
      document.activeElement === record.input &&
      typeof record.input.blur === "function"
    ) {
      record.input.blur();
    }
  } catch {
    // Blur failures never break the close.
  }
  return true;
}

/**
 * SHIM-0110: true while a keyboard edit opened through
 * openCouchKeyboard is still active. A record whose input left
 * the document is stale and clears lazily (returns false).
 */
export function isCouchKeyboardOpen(): boolean {
  if (!openKeyboard) return false;
  try {
    if (
      typeof document !== "undefined" &&
      !openKeyboard.input.isConnected
    ) {
      openKeyboard = null;
      return false;
    }
  } catch {
    return false;
  }
  return true;
}
