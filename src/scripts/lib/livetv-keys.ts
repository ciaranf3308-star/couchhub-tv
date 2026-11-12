// RedSilk Couch — Live TV controller mapping (W5, canonical owner, 0.9.0).
//
// The SINGLE mapping table for Live TV, shared by W1 (Landing), W2
// (Browser), W3 (Playback+Quick Surf) and W4 (Guide) so the same
// button always means the same thing wherever it is pressed. Pure
// and DOM-free: keyboard keys and standard gamepad button indices
// resolve to actions, and the Landing / Browser / playback / Guide
// handlers dispatch on the returned action.
//
// Contexts: "landing" (Live TV landing), "browser" (Channel
// Browser), "playback" (fullscreen player), "guide" (full programme
// guide). The legacy context name "home" is accepted as an alias
// for "landing" by every resolver below.
//
// The "back" action: B / Escape resolves to "back" in EVERY context.
// gamepad.ts turns a resolved "back" in a Live TV context into a
// `livetv:back` event (detail {context}); each mode component
// listens for it and implements its own back step. The resolvers
// here never dispatch — they only name the action.
//
// View+Menu held 2s = return to the RedSilk launcher is GLOBAL and
// is deliberately NOT in this table: gamepad.ts owns that hold, View
// (8) never resolves to an action here, and Menu (9) on its own only
// ever opens options / guide actions. No context in this table can
// intercept or remap the return-home combo.
//
// Triggers LT (6) / RT (7) ARE plumbed: the Gamepad API exposes
// them as buttons 6/7 (analog value > 0.5 counts as pressed —
// gamepad.ts snapshots them that way), so the browser maps them to
// page-prev / page-next. Outside the browser they resolve to null
// here; gamepad.ts keeps its existing volume behaviour there.

import type { GuideMode } from "./livetv-state.js";

/** Event gamepad.ts dispatches for a resolved "back" in a Live TV context. */
export const LIVETV_BACK_EVENT = "livetv:back";

/**
 * Dispatch `livetv:back` {context} on `target` (window in
 * production). Each mode component listens for it and implements
 * its own back step; the dispatcher never decides what "back"
 * means. Takes the target so tests can assert the dispatch on a
 * plain EventTarget without a DOM.
 */
export function dispatchLivetvBack(
  target: EventTarget,
  context: LivetvKeyContext,
): void {
  target.dispatchEvent(
    new CustomEvent(LIVETV_BACK_EVENT, { detail: { context } }),
  );
}

export type LivetvKeyContext = "landing" | "browser" | "playback" | "guide";

/** Legacy context name, accepted as an alias for "landing". */
export type LivetvKeyContextInput = LivetvKeyContext | "home";

/** Normalise a context input: legacy "home" → "landing". */
export function normaliseLivetvKeyContext(
  context: LivetvKeyContextInput,
): LivetvKeyContext {
  return context === "home" ? "landing" : context;
}

/** Options that refine a resolution inside the Guide. */
export interface LivetvKeyResolveOptions {
  /**
   * Guide sub-mode, for LB/RB: in By Channel mode they step days,
   * in grid mode they step time. Defaults to time nav ("grid").
   */
  guideMode?: GuideMode;
  /**
   * True when focus is on the Guide's tab row: Left/Right then
   * switch guide sub-modes instead of moving spatially.
   */
  onTabRow?: boolean;
}

export type LivetvKeyAction =
  | "move-up"
  | "move-down"
  | "move-left"
  | "move-right"
  | "select"
  | "activate"
  | "back"
  | "contextual"
  | "open-guide"
  | "open-browser"
  | "open-options"
  | "open-programme"
  | "open-search"
  | "toggle-favourite"
  | "category-prev"
  | "category-next"
  | "page-prev"
  | "page-next"
  | "guide-mode-prev"
  | "guide-mode-next"
  | "day-prev"
  | "day-next"
  | "quick-surf-up"
  | "quick-surf-down"
  | "programme-info"
  | "time-prev"
  | "time-next"
  | "jump-to-now"
  | "guide-actions"
  | "return-home";

/** Standard gamepad button indices (gamepad.ts uses the same numbers). */
export const LIVETV_GAMEPAD_BUTTONS = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  view: 8,
  menu: 9,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

/**
 * Hold time for View+Menu = return home. Owned by gamepad.ts; repeated
 * here so the table's tests and docs name the same number.
 */
export const LIVETV_RETURN_HOME_HOLD_MS = 2000;

/** True only when View AND Menu are held together (the return-home combo). */
export function livetvReturnHomeComboPressed(
  viewPressed: boolean,
  menuPressed: boolean,
): boolean {
  return viewPressed && menuPressed;
}

// ── Keyboard ────────────────────────────────────────────────────

/**
 * KeyboardEvent.key -> action for a context, or null when the key
 * means nothing there. Arrow keys always move (except playback:
 * Up/Down Quick Surf, Left/Right programme info); Enter/Space select
 * (landing/browser/guide) or reveal/confirm (playback); Escape
 * always goes back. Letter keys are the keyboard aliases for the
 * gamepad buttons of the same name. "[" / "]" step browser
 * categories (browser) or guide days (guide); PageUp/PageDown step
 * browser pages (browser) or guide time (guide).
 */
export function livetvKeyActionForKey(
  contextInput: LivetvKeyContextInput,
  key: string | null | undefined,
  opts: LivetvKeyResolveOptions = {},
): LivetvKeyAction | null {
  if (!key) return null;
  const context = normaliseLivetvKeyContext(contextInput);
  switch (key) {
    case "ArrowUp":
      return context === "playback" ? "quick-surf-up" : "move-up";
    case "ArrowDown":
      return context === "playback" ? "quick-surf-down" : "move-down";
    case "ArrowLeft":
      if (context === "playback") return "programme-info";
      if (context === "guide" && opts.onTabRow) return "guide-mode-prev";
      return "move-left";
    case "ArrowRight":
      if (context === "playback") return "programme-info";
      if (context === "guide" && opts.onTabRow) return "guide-mode-next";
      return "move-right";
    case "Enter":
    case " ":
      return context === "playback" ? "activate" : "select";
    case "Escape":
    case "Backspace":
      return "back";
    case "ContextMenu":
      if (context === "guide") return "guide-actions";
      return "open-options";
    case "[":
      if (context === "browser") return "category-prev";
      if (context === "guide") return "day-prev";
      return null;
    case "]":
      if (context === "browser") return "category-next";
      if (context === "guide") return "day-next";
      return null;
    case "PageUp":
      if (context === "browser") return "page-prev";
      if (context === "guide") return "time-prev";
      return null;
    case "PageDown":
      if (context === "browser") return "page-next";
      if (context === "guide") return "time-next";
      return null;
    default:
      break;
  }
  const lower = key.toLowerCase();
  if (context === "landing") {
    if (lower === "x") return "contextual";
    if (lower === "y" || lower === "g") return "open-guide";
    if (lower === "m") return "open-options";
    return null;
  }
  if (context === "browser") {
    if (lower === "x") return "toggle-favourite";
    if (lower === "y") return "open-search";
    if (lower === "m") return "open-options";
    return null;
  }
  if (context === "playback") {
    if (lower === "x") return "open-guide";
    if (lower === "y") return "open-browser";
    if (lower === "m") return "open-options";
    if (lower === "i") return "programme-info";
    return null;
  }
  // Guide.
  if (lower === "y" || lower === "m") return "guide-actions";
  if (lower === "n") return "jump-to-now";
  return null;
}

// ── Gamepad ─────────────────────────────────────────────────────

/**
 * Standard gamepad button index -> action for a context, or null
 * when the button means nothing there. View (8) ALWAYS returns null:
 * it is half of the global return-home combo and no Live TV context
 * may claim it. Axes / sticks resolve separately via
 * livetvStickAction (direction only — magnitude is the caller's).
 *
 * Guide LB/RB resolve by sub-mode (opts.guideMode): "channel" steps
 * days, anything else steps time. Guide Left/Right resolve to
 * guide-mode-prev/next when opts.onTabRow is true (focus on the tab
 * row), else they move spatially.
 */
export function livetvGamepadActionForButton(
  contextInput: LivetvKeyContextInput,
  buttonIndex: number,
  opts: LivetvKeyResolveOptions = {},
): LivetvKeyAction | null {
  const context = normaliseLivetvKeyContext(contextInput);
  switch (buttonIndex) {
    case LIVETV_GAMEPAD_BUTTONS.dpadUp:
      return context === "playback" ? "quick-surf-up" : "move-up";
    case LIVETV_GAMEPAD_BUTTONS.dpadDown:
      return context === "playback" ? "quick-surf-down" : "move-down";
    case LIVETV_GAMEPAD_BUTTONS.dpadLeft:
      if (context === "playback") return "programme-info";
      if (context === "guide" && opts.onTabRow) return "guide-mode-prev";
      return "move-left";
    case LIVETV_GAMEPAD_BUTTONS.dpadRight:
      if (context === "playback") return "programme-info";
      if (context === "guide" && opts.onTabRow) return "guide-mode-next";
      return "move-right";
    case LIVETV_GAMEPAD_BUTTONS.a:
      return context === "playback" ? "activate" : "select";
    case LIVETV_GAMEPAD_BUTTONS.b:
      return "back";
    case LIVETV_GAMEPAD_BUTTONS.x:
      // Landing: contextual action. Playback: full Guide.
      // Browser: toggle favourite. Guide: unmapped.
      if (context === "landing") return "contextual";
      if (context === "playback") return "open-guide";
      if (context === "browser") return "toggle-favourite";
      return null;
    case LIVETV_GAMEPAD_BUTTONS.y:
      if (context === "landing") return "open-guide";
      if (context === "playback") return "open-browser";
      if (context === "browser") return "open-search";
      return "guide-actions";
    case LIVETV_GAMEPAD_BUTTONS.lb:
      if (context === "browser") return "category-prev";
      if (context === "guide") {
        return opts.guideMode === "channel" ? "day-prev" : "time-prev";
      }
      return null;
    case LIVETV_GAMEPAD_BUTTONS.rb:
      if (context === "browser") return "category-next";
      if (context === "guide") {
        return opts.guideMode === "channel" ? "day-next" : "time-next";
      }
      return null;
    case LIVETV_GAMEPAD_BUTTONS.lt:
      return context === "browser" ? "page-prev" : null;
    case LIVETV_GAMEPAD_BUTTONS.rt:
      return context === "browser" ? "page-next" : null;
    case LIVETV_GAMEPAD_BUTTONS.menu:
      return context === "guide" ? "guide-actions" : "open-options";
    case LIVETV_GAMEPAD_BUTTONS.view:
      return null;
    default:
      return null;
  }
}

/**
 * Stick deflection -> a move action, or null inside the deadzone.
 * The dominant axis wins (no diagonals); the caller owns repeat
 * timing. Every context uses the same directions.
 */
export function livetvStickAction(
  axisX: number,
  axisY: number,
  deadzone: number = 0.5,
): LivetvKeyAction | null {
  const x = Number.isFinite(axisX) ? axisX : 0;
  const y = Number.isFinite(axisY) ? axisY : 0;
  if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? "move-right" : "move-left";
  return y > 0 ? "move-down" : "move-up";
}

// ── The table, as data (docs + tests read this, handlers read the fns) ──

export interface LivetvControllerRow {
  context: LivetvKeyContext;
  /** Gamepad button / keyboard key, as the user sees it. */
  input: string;
  action: LivetvKeyAction;
  label: string;
}

/** One row per (context, input) the mapping defines. */
export const LIVETV_CONTROLLER_MAP: readonly LivetvControllerRow[] = [
  // Landing.
  { context: "landing", input: "D-pad / stick", action: "move-up", label: "Move" },
  { context: "landing", input: "D-pad / stick", action: "move-down", label: "Move" },
  { context: "landing", input: "D-pad / stick", action: "move-left", label: "Move" },
  { context: "landing", input: "D-pad / stick", action: "move-right", label: "Move" },
  { context: "landing", input: "A / Enter", action: "select", label: "Select / watch" },
  { context: "landing", input: "B / Esc", action: "back", label: "Back" },
  { context: "landing", input: "X", action: "contextual", label: "Contextual action" },
  { context: "landing", input: "Y", action: "open-guide", label: "Open Guide" },
  { context: "landing", input: "Menu", action: "open-options", label: "Options" },
  // Channel Browser.
  { context: "browser", input: "D-pad / stick", action: "move-up", label: "Move" },
  { context: "browser", input: "D-pad / stick", action: "move-down", label: "Move" },
  { context: "browser", input: "D-pad / stick", action: "move-left", label: "Move" },
  { context: "browser", input: "D-pad / stick", action: "move-right", label: "Move" },
  { context: "browser", input: "A / Enter", action: "select", label: "Select / watch" },
  { context: "browser", input: "B / Esc", action: "back", label: "Back to landing" },
  // 0.11.7 W2 — category drawer layering (the browser interprets
  // the same move-left / move-right / back / select actions by
  // layer; the resolvers above are unchanged).
  { context: "browser", input: "D-pad Left in channel list", action: "move-left", label: "Open category drawer" },
  { context: "browser", input: "D-pad Right in drawer", action: "move-right", label: "Return to channel list" },
  { context: "browser", input: "A / Enter in drawer", action: "select", label: "Open group / apply subcategory" },
  { context: "browser", input: "B / Esc in drawer", action: "back", label: "Back one drawer level, then close" },
  { context: "browser", input: "LB", action: "category-prev", label: "Previous category" },
  { context: "browser", input: "RB", action: "category-next", label: "Next category" },
  { context: "browser", input: "LT", action: "page-prev", label: "Previous page" },
  { context: "browser", input: "RT", action: "page-next", label: "Next page" },
  { context: "browser", input: "X", action: "toggle-favourite", label: "Favourite / unfavourite" },
  { context: "browser", input: "Y", action: "open-search", label: "Search" },
  { context: "browser", input: "Menu", action: "open-options", label: "Options" },
  // Fullscreen playback.
  { context: "playback", input: "A / Enter", action: "activate", label: "Reveal / confirm" },
  { context: "playback", input: "B / Esc", action: "back", label: "Close overlay, then return to landing" },
  { context: "playback", input: "D-pad Up", action: "quick-surf-up", label: "Quick Surf — previous channel" },
  { context: "playback", input: "D-pad Down", action: "quick-surf-down", label: "Quick Surf — next channel" },
  { context: "playback", input: "D-pad Left / Right", action: "programme-info", label: "Programme info" },
  { context: "playback", input: "X", action: "open-guide", label: "Full Guide" },
  { context: "playback", input: "Y", action: "open-browser", label: "Channel Browser" },
  { context: "playback", input: "Menu", action: "open-options", label: "Playback options" },
  // Guide.
  { context: "guide", input: "D-pad / stick", action: "move-up", label: "Move (spatial)" },
  { context: "guide", input: "D-pad / stick", action: "move-down", label: "Move (spatial)" },
  { context: "guide", input: "D-pad / stick", action: "move-left", label: "Move (spatial)" },
  { context: "guide", input: "D-pad / stick", action: "move-right", label: "Move (spatial)" },
  { context: "guide", input: "D-pad Left / Right on tab row", action: "guide-mode-prev", label: "Previous guide view" },
  { context: "guide", input: "D-pad Left / Right on tab row", action: "guide-mode-next", label: "Next guide view" },
  { context: "guide", input: "A / Enter", action: "select", label: "Select programme" },
  { context: "guide", input: "B / Esc", action: "back", label: "Return" },
  { context: "guide", input: "LB / Page Up", action: "time-prev", label: "Earlier in time (grid)" },
  { context: "guide", input: "RB / Page Down", action: "time-next", label: "Later in time (grid)" },
  { context: "guide", input: "LB / [ in By Channel", action: "day-prev", label: "Previous day" },
  { context: "guide", input: "RB / ] in By Channel", action: "day-next", label: "Next day" },
  { context: "guide", input: "N", action: "jump-to-now", label: "Jump to Now" },
  { context: "guide", input: "Menu / Y", action: "guide-actions", label: "Guide actions" },
  // Global — stated here so no context can claim it. The resolvers
  // above never return this action; gamepad.ts owns the hold.
  { context: "landing", input: "View + Menu held 2s", action: "return-home", label: "Return home (global — never intercepted)" },
];
