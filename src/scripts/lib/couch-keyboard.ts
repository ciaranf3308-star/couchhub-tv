// RedSilk Couch — on-screen keyboard lifecycle (Browse consolidation, W2).
//
// One shared state machine for every TvKeyboard owner (Discover mood
// field, fullscreen Search). The bug it fixes: TvKeyboard used to render
// unconditionally, so Discover showed a permanent keyboard at the top of
// the landing. The contract now:
//
//   - The keyboard is CLOSED on initial load. It opens when the owning
//     search input receives focus (pointer, controller spatial nav, or
//     physical focus) — except the Search page's programmatic mount
//     focus, which is suppressed so /search also loads keyboard-free.
//   - It closes on Escape/B while focus is on the input, on the
//     keyboard's own Hide button, on commit (Search key — focus moves
//     on to the results), and when focus leaves the search scope for a
//     real element (mood chip, filter, result, …).
//   - It does NOT close when focus leaves to nowhere (relatedTarget
//     null). That is the controller B gesture: the gamepad layer blurs
//     the input and then dispatches Escape (gamepad.ts, editing branch).
//     Closing on that blur would unmount the keys before the next D-pad
//     move can land on them, making the keyboard unreachable from a
//     controller; and refocusing the input instead would re-trap the
//     user in editing mode, where the gamepad layer swallows D-pad.
//     So a blur-to-nowhere keeps the keyboard open and only arms the
//     trailing-Escape window below.
//   - Trailing Escape: after a B-blur, the gamepad layer dispatches
//     Escape on document.body. On the Windows app isTvDevice() is false
//     (nothing sets data-tv="1" for Couch), so SearchView's window
//     key handler DOES see it. In 0.11.9 the view swallowed it (the
//     keyboard stayed open for D-pad typing); in 0.11.10 (§28) the
//     trailing Escape CLOSES the keyboard via the shared lifecycle
//     (focus returns to the input) — one B press, one step.
//     isFreshScopeExit() still identifies that trailing Escape (focus
//     on body, <500 ms after a scope exit while the keyboard was
//     open), so it is never mistaken for a fresh clear/leave gesture.
//   - Focus return: dismissing from the input keeps focus on the input;
//     dismissing from the keyboard's Hide button returns focus to the
//     input, with the reopen suppressed for that one programmatic
//     refocus (dismissToInput). Commit is the exception: focus moves to
//     the first result, as the task directs.
//
// Pure TypeScript, no DOM, no Svelte runes — unit-tested in
// tests/couch-keyboard.test.ts. Views hold one instance and mirror
// `open` into a $state rune (see DiscoverView / SearchView).
//
// CONTRACT E (Controller 2.0, 0.11.10) — the shared editing/keyboard
// lifecycle every search surface consumes: openCouchKeyboard /
// closeCouchKeyboard / isCouchKeyboardOpen (below). It is a session
// bridge over the per-view CouchKeyboardLifecycle above, NOT a second
// state machine: views keep owning `open` through their lifecycle
// instance; the session tracks WHICH input is being edited, registers
// the keyboard Back layer, moves focus into the key grid on explicit
// controller entry, and tells the owner to hide/commit through the
// `couch-keyboard:closed` event. Owners without a Svelte lifecycle
// (Live TV search overlay, Browse search overlay, Guide search) use
// the same three functions for session + Back semantics; where no OSK
// is mounted the grid-focus step is a harmless no-op.
//
// B SEMANTICS (0.11.10): B/Escape NEVER deletes. In the key grid,
// Escape dismisses the keyboard (focus returns to the input) and only
// the Backspace KEY (or the physical Backspace key) deletes. See
// oskKeyAction() — the single rule OnScreenKeyboard implements.

import { BACK_PRIORITY, registerBackLayer, setControllerHints } from "./controller-0110-seams";
import type { HintConfig } from "./couch-button-hints";

/** How long a scope exit counts as "just happened" for the trailing-Escape swallow. */
export const TRAILING_ESCAPE_WINDOW_MS = 500;

/** Search-return focus flag (TvSearchAction): set when leaving Browse for /search. */
export const SEARCH_RETURN_KEY = "rs-browse-search-return";
/** The return flag is only honoured this long after it was set. */
export const SEARCH_RETURN_MAX_AGE_MS = 10 * 60 * 1000;

export type KeyboardScopeExit = "hid" | "kept" | "was-closed";

export class CouchKeyboardLifecycle {
  /** Whether the keyboard is currently rendered. Views mirror this into a $state. */
  open = false;

  /** Suppress the reopen for the next single input-focus event (mount focus / dismiss refocus). */
  private suppressNextFocus: boolean;
  /** Timestamp (ms) of the last scope exit while the keyboard was open; 0 = none. */
  private lastOpenScopeExitAt = 0;

  constructor(opts: { suppressInitialFocus?: boolean } = {}) {
    this.suppressNextFocus = opts.suppressInitialFocus ?? false;
  }

  /** The owning input received focus. Opens, unless this is the suppressed programmatic focus. */
  onInputFocus(): void {
    if (this.suppressNextFocus) {
      this.suppressNextFocus = false;
      return;
    }
    this.open = true;
  }

  /** Open unconditionally (e.g. ArrowDown from the input) — also clears any focus suppression. */
  openKeyboard(): void {
    this.suppressNextFocus = false;
    this.open = true;
  }

  /** B / Escape dismiss from the input. Returns true when it actually dismissed. */
  dismiss(): boolean {
    if (!this.open) return false;
    this.open = false;
    return true;
  }

  /**
   * Dismiss and return focus to the input (keyboard Hide button path).
   * The refocus the caller performs right after must not reopen the
   * keyboard, so the next single focus event is suppressed.
   */
  dismissToInput(): boolean {
    const was = this.dismiss();
    if (was) this.suppressNextFocus = true;
    return was;
  }

  /** Commit (keyboard Search key): hide; the caller moves focus on to the results. */
  commit(): void {
    this.open = false;
  }

  /**
   * Focus left the search scope (input + keyboard).
   *
   * @param leftScope true when focus landed on a real element OUTSIDE
   *   the scope — the user navigated away (mood chip, filter, result),
   *   so hide. False when focus stayed inside the scope (input <->
   *   keyboard keys — the keys live inside the scope, so moving onto
   *   one must NOT hide) or left to nowhere (gamepad B blur /
   *   dead-space click) — keep the keyboard mounted so the next D-pad
   *   move can land on its keys (see header).
   * @returns "hid" when it closed, "kept" when it stayed open,
   *   "was-closed" when it was already closed (nothing recorded).
   */
  onScopeFocusOut(leftScope: boolean, now: number = Date.now()): KeyboardScopeExit {
    if (!this.open) return "was-closed";
    this.lastOpenScopeExitAt = now;
    if (!leftScope) return "kept";
    this.open = false;
    return "hid";
  }

  /**
   * True when an Escape arriving now is plausibly the gamepad layer's
   * trailing Escape after a B-blur scope exit (see header). Views only
   * swallow it when focus is on the body — a focused element means a
   * fresh user gesture, not a trailing one.
   */
  isFreshScopeExit(now: number = Date.now()): boolean {
    return (
      this.lastOpenScopeExitAt > 0 &&
      now - this.lastOpenScopeExitAt >= 0 &&
      now - this.lastOpenScopeExitAt <= TRAILING_ESCAPE_WINDOW_MS
    );
  }
}

/**
 * Mark that Browse is leaving for /search, so the return trip can
 * restore focus to the search action. Storage failure is never fatal.
 */
export function markSearchReturn(storage: Pick<Storage, "setItem">): void {
  try {
    storage.setItem(SEARCH_RETURN_KEY, String(Date.now()));
  } catch {
    // Focus restore is a nicety, never fatal.
  }
}

/**
 * Consume the search-return flag (single use — always removed when
 * read). Returns true only when the flag was set within maxAgeMs.
 */
export function consumeSearchReturn(
  storage: Pick<Storage, "getItem" | "removeItem">,
  now: number = Date.now(),
  maxAgeMs: number = SEARCH_RETURN_MAX_AGE_MS,
): boolean {
  let raw: string | null = null;
  try {
    raw = storage.getItem(SEARCH_RETURN_KEY);
  } catch {
    return false;
  }
  try {
    storage.removeItem(SEARCH_RETURN_KEY);
  } catch {
    // Ignore — the flag is best-effort.
  }
  if (!raw) return false;
  const at = Number(raw);
  if (!Number.isFinite(at)) return false;
  return now - at >= 0 && now - at <= maxAgeMs;
}

// ── Contract E: shared editing/keyboard lifecycle (0.11.10) ──────────

/**
 * Event dispatched on the editing input (bubbling) when the shared
 * lifecycle closes the keyboard. Owners with their own open state
 * (Discover/Search lifecycles) listen for it and hide their keyboard;
 * `detail.commit` distinguishes commit from dismiss. The owner that
 * registered the session also gets its onCommit callback on commit.
 */
export const COUCH_KEYBOARD_CLOSED_EVENT = "couch-keyboard:closed";

/** What an OSK keydown means. The B-never-deletes rule, in one place. */
export type OskKeyAction = "dismiss" | "backspace" | "none";

/**
 * Pure rule for keys pressed while focus is inside the key grid:
 * Escape (controller B) dismisses the keyboard — it NEVER deletes.
 * Backspace (the physical key) deletes one character. Everything else
 * is none (character keys click, arrows move via spatial nav).
 */
export function oskKeyAction(key: string): OskKeyAction {
  if (key === "Escape") return "dismiss";
  if (key === "Backspace") return "backspace";
  return "none";
}

/** Hints while the key grid owns the controller (via setControllerHints). */
export const KEYBOARD_OPEN_HINTS: HintConfig = {
  id: "osk-0110",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Type" },
    { glyph: "b", label: "Close keyboard" },
    { glyph: "menu", label: "Settings" },
    { glyph: "view-menu", label: "Return home" },
  ],
};

/** Hints once editing ends (provisional until W1's hints unification). */
export const KEYBOARD_CLOSED_HINTS: HintConfig = {
  id: "browse-0110",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Select" },
    { glyph: "b", label: "Back" },
    { glyph: "menu", label: "Settings" },
    { glyph: "view-menu", label: "Return home" },
  ],
};

export interface OpenCouchKeyboardOptions {
  /**
   * Move focus into the key grid once the OSK is mounted (default
   * true — the explicit controller entry: A on a focused input).
   * Focus handlers pass false: the user is already editing in the
   * input and focus must stay there (pointer/physical typing).
   */
  focusGrid?: boolean;
}

interface KeyboardSession {
  input: HTMLInputElement | HTMLTextAreaElement;
  onCommit?: (value: string) => void;
  unregisterBack: () => void;
}

let activeSession: KeyboardSession | null = null;

/** The input currently being edited through the shared lifecycle, if any. */
export function getCouchKeyboardInput(): HTMLInputElement | HTMLTextAreaElement | null {
  return activeSession?.input ?? null;
}

/**
 * True while a keyboard session is live for an input still in the
 * document. A session whose input was removed (overlay closed) reads
 * closed, so a stale session can never swallow a Back press.
 */
export function isCouchKeyboardOpen(): boolean {
  return !!activeSession && activeSession.input.isConnected;
}

function registerKeyboardBackLayer(): () => void {
  return registerBackLayer({
    id: "couch-keyboard",
    priority: BACK_PRIORITY.KEYBOARD,
    isActive: () => isCouchKeyboardOpen(),
    handle: () => {
      // Exactly one step: dismiss without committing, no deletion.
      closeCouchKeyboard(false);
      return true;
    },
  });
}

function focusFirstOskKey(input: HTMLInputElement | HTMLTextAreaElement): void {
  const key = document.querySelector<HTMLElement>(
    "[data-couch-keyboard] [data-osk-key], [data-osk] [data-osk-key]",
  );
  if (!key) return;
  // Never steal focus the user has already moved elsewhere.
  const active = document.activeElement;
  if (active !== input && active !== document.body) return;
  key.focus();
}

function scheduleGridFocus(input: HTMLInputElement | HTMLTextAreaElement): void {
  // The OSK mounts on the next Svelte flush; retry across frames so
  // the first key exists by the time we focus it. Each attempt
  // re-checks that this input still owns the live session.
  const attempt = () => {
    if (activeSession?.input !== input) return;
    focusFirstOskKey(input);
  };
  attempt();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      attempt();
      setTimeout(attempt, 80);
    });
  } else {
    setTimeout(attempt, 80);
  }
}

/**
 * Begin editing `input` through the shared OSK lifecycle: focus the
 * input, register the keyboard Back layer, and (by default) move
 * focus into the key grid once mounted. Idempotent for the same
 * input — re-entry refreshes the commit callback and keeps the one
 * session. Opening for a different input ends the previous session
 * without committing it (no focus steal, no events).
 */
export function openCouchKeyboard(
  input: HTMLInputElement | HTMLTextAreaElement,
  onCommit?: (value: string) => void,
  opts: OpenCouchKeyboardOptions = {},
): void {
  if (activeSession && activeSession.input !== input) {
    endCouchKeyboardSession();
  }
  if (activeSession) {
    activeSession.onCommit = onCommit;
  } else {
    activeSession = { input, onCommit, unregisterBack: registerKeyboardBackLayer() };
  }
  setControllerHints(KEYBOARD_OPEN_HINTS);
  try {
    input.focus();
  } catch {
    // Focus failure never blocks the session: the Back layer and the
    // owner's own open-on-focus path still apply.
  }
  if (opts.focusGrid !== false) scheduleGridFocus(input);
}

/** Set an input's value through the native setter and fire input/change. */
function setValueAndFireEvents(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  if (input.value === value) return;
  try {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) descriptor.set.call(input, value);
    else input.value = value;
  } catch {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Close the keyboard. Commit fires onCommit + the input/change events
 * the owner's search logic listens for; dismiss fires neither. Both
 * return focus to the input (the owner's onCommit may then move focus
 * onward, e.g. to the first result). No session → no-op. Never
 * deletes a character, never navigates.
 */
export function closeCouchKeyboard(commit: boolean): void {
  const session = activeSession;
  if (!session) return;
  // Clear first: onCommit may re-enter the lifecycle (a view commit
  // handler that opens the next surface), and re-entry must see a
  // clean slate, never this closing session.
  activeSession = null;
  session.unregisterBack();
  const { input, onCommit } = session;
  const value = input.value;
  setControllerHints(KEYBOARD_CLOSED_HINTS);
  input.dispatchEvent(
    new CustomEvent(COUCH_KEYBOARD_CLOSED_EVENT, {
      bubbles: true,
      detail: { commit, value },
    }),
  );
  if (commit) {
    setValueAndFireEvents(input, value);
  }
  try {
    if (input.isConnected) input.focus();
  } catch {
    // Focus is best-effort on close.
  }
  if (commit) onCommit?.(value);
}

/**
 * End the session silently: no events, no focus move, no commit.
 * For owners that manage their own hide/focus (view commit handlers
 * that already hid the keyboard, overlay dismiss paths).
 */
export function endCouchKeyboardSession(): void {
  const session = activeSession;
  if (!session) return;
  activeSession = null;
  session.unregisterBack();
}

// ── Single-step Back decisions (pure; views execute the step) ────────

/** One Back step on Global Search (§27), in hierarchy order. */
export type SearchBackStep =
  | "close-keyboard"
  | "exit-person"
  | "focus-input"
  | "clear-query"
  | "leave";

export interface SearchBackState {
  keyboardOpen: boolean;
  personMode: boolean;
  /** Focus is on a result / recent / filter control, not the input. */
  focusInResults: boolean;
  hasQuery: boolean;
}

/**
 * The next Search Back step — exactly one. Keyboard first, then the
 * person subview, then focus back to the input, then an explicit
 * query-clear step, then leave via provenance. No single press ever
 * performs two of these.
 */
export function nextSearchBackStep(state: SearchBackState): SearchBackStep {
  if (state.keyboardOpen) return "close-keyboard";
  if (state.personMode) return "exit-person";
  if (state.focusInResults) return "focus-input";
  if (state.hasQuery) return "clear-query";
  return "leave";
}

/** One Back step on Discover (§25), in hierarchy order. */
export type DiscoverBackStep =
  | "close-diagnostics"
  | "close-keyboard"
  | "focus-search"
  | "root-state"
  | "leave";

export interface DiscoverBackState {
  diagnosticsOpen: boolean;
  keyboardOpen: boolean;
  /** Focus is inside the results rail, not the search control. */
  focusInResults: boolean;
  /** A results/refinement view is showing (AI/local results, mood, query). */
  hasResultsView: boolean;
}

/**
 * The next Discover Back step — exactly one. Diagnostics first, then
 * the keyboard, then focus back to the search control (state
 * untouched — a focus move never discards the refinement
 * conversation), then the results view back to the root state, then
 * leave via provenance. Never triggers an AI request: the executing
 * view performs only state changes + navigation.
 */
export function nextDiscoverBackStep(state: DiscoverBackState): DiscoverBackStep {
  if (state.diagnosticsOpen) return "close-diagnostics";
  if (state.keyboardOpen) return "close-keyboard";
  if (state.focusInResults) return "focus-search";
  if (state.hasResultsView) return "root-state";
  return "leave";
}
