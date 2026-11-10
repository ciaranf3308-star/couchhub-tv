// RedSilk Couch — Live TV controller mapping (W3, canonical owner).
//
// The SINGLE mapping table for Live TV, shared by W1 (Home), W2
// (playback) and W3 (Guide) so the same button always means the same
// thing wherever it is pressed. Pure and DOM-free: keyboard keys and
// standard gamepad button indices resolve to actions, and the Guide /
// Home / playback handlers dispatch on the returned action.
//
// Contexts: "home" (Live TV Home browser), "playback" (fullscreen
// player), "guide" (full programme guide).
//
// View+Menu held 2s = return to the RedSilk launcher is GLOBAL and is
// deliberately NOT in this table: gamepad.ts owns that hold, View (8)
// never resolves to an action here, and Menu (9) on its own only ever
// opens options / guide actions. No context in this table can
// intercept or remap the return-home combo.

export type LivetvKeyContext = "home" | "playback" | "guide";

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
 * means nothing there. Arrow keys always move; Enter/Space select
 * (Home/Guide) or reveal/confirm (playback); Escape always goes
 * back. Letter keys are the keyboard aliases for the gamepad buttons
 * of the same name (Y = guide, X = contextual / full guide).
 */
export function livetvKeyActionForKey(
  context: LivetvKeyContext,
  key: string | null | undefined,
): LivetvKeyAction | null {
  if (!key) return null;
  switch (key) {
    case "ArrowUp":
      return context === "playback" ? "quick-surf-up" : "move-up";
    case "ArrowDown":
      return context === "playback" ? "quick-surf-down" : "move-down";
    case "ArrowLeft":
      return context === "playback" ? "programme-info" : "move-left";
    case "ArrowRight":
      return context === "playback" ? "programme-info" : "move-right";
    case "Enter":
    case " ":
      return context === "playback" ? "activate" : "select";
    case "Escape":
    case "Backspace":
      return "back";
    case "ContextMenu":
      return context === "guide" ? "guide-actions" : "open-options";
    default:
      break;
  }
  const lower = key.toLowerCase();
  if (context === "home") {
    if (lower === "x") return "contextual";
    if (lower === "y" || lower === "g") return "open-guide";
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
  if (key === "PageUp") return "time-prev";
  if (key === "PageDown") return "time-next";
  return null;
}

// ── Gamepad ─────────────────────────────────────────────────────

/**
 * Standard gamepad button index -> action for a context, or null
 * when the button means nothing there. View (8) ALWAYS returns null:
 * it is half of the global return-home combo and no Live TV context
 * may claim it. Axes / sticks resolve separately via
 * livetvStickAction (direction only — magnitude is the caller's).
 */
export function livetvGamepadActionForButton(
  context: LivetvKeyContext,
  buttonIndex: number,
): LivetvKeyAction | null {
  switch (buttonIndex) {
    case LIVETV_GAMEPAD_BUTTONS.dpadUp:
      return context === "playback" ? "quick-surf-up" : "move-up";
    case LIVETV_GAMEPAD_BUTTONS.dpadDown:
      return context === "playback" ? "quick-surf-down" : "move-down";
    case LIVETV_GAMEPAD_BUTTONS.dpadLeft:
      return context === "playback" ? "programme-info" : "move-left";
    case LIVETV_GAMEPAD_BUTTONS.dpadRight:
      return context === "playback" ? "programme-info" : "move-right";
    case LIVETV_GAMEPAD_BUTTONS.a:
      return context === "playback" ? "activate" : "select";
    case LIVETV_GAMEPAD_BUTTONS.b:
      return "back";
    case LIVETV_GAMEPAD_BUTTONS.x:
      // Home: contextual action. Playback: full Guide. Guide: unmapped.
      return context === "home"
        ? "contextual"
        : context === "playback"
          ? "open-guide"
          : null;
    case LIVETV_GAMEPAD_BUTTONS.y:
      return context === "home"
        ? "open-guide"
        : context === "playback"
          ? "open-browser"
          : "guide-actions";
    case LIVETV_GAMEPAD_BUTTONS.lb:
      return context === "guide" ? "time-prev" : null;
    case LIVETV_GAMEPAD_BUTTONS.rb:
      return context === "guide" ? "time-next" : null;
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
  // Home browsing.
  { context: "home", input: "D-pad / stick", action: "move-up", label: "Move" },
  { context: "home", input: "D-pad / stick", action: "move-down", label: "Move" },
  { context: "home", input: "D-pad / stick", action: "move-left", label: "Move" },
  { context: "home", input: "D-pad / stick", action: "move-right", label: "Move" },
  { context: "home", input: "A / Enter", action: "select", label: "Select / watch" },
  { context: "home", input: "B / Esc", action: "back", label: "Back" },
  { context: "home", input: "X", action: "contextual", label: "Contextual action" },
  { context: "home", input: "Y", action: "open-guide", label: "Open Guide" },
  { context: "home", input: "Menu", action: "open-options", label: "Options" },
  // Fullscreen playback.
  { context: "playback", input: "A / Enter", action: "activate", label: "Reveal / confirm" },
  { context: "playback", input: "B / Esc", action: "back", label: "Close overlay, then return to Live Home" },
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
  { context: "guide", input: "A / Enter", action: "select", label: "Select programme" },
  { context: "guide", input: "B / Esc", action: "back", label: "Return" },
  { context: "guide", input: "LB / Page Up", action: "time-prev", label: "Earlier in time" },
  { context: "guide", input: "RB / Page Down", action: "time-next", label: "Later in time" },
  { context: "guide", input: "N", action: "jump-to-now", label: "Jump to Now" },
  { context: "guide", input: "Menu / Y", action: "guide-actions", label: "Guide actions" },
  // Global — stated here so no context can claim it. The resolvers
  // above never return this action; gamepad.ts owns the hold.
  { context: "home", input: "View + Menu held 2s", action: "return-home", label: "Return home (global — never intercepted)" },
];
