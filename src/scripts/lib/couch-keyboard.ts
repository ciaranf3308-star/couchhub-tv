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
//     key handler DOES see it — without the swallow it would clear the
//     query or leave Search entirely, so the first B would dismiss the
//     keyboard AND eat the query. isFreshScopeExit() lets the view
//     swallow exactly that one Escape (focus on body, <500 ms after a
//     scope exit while the keyboard was open).
//   - Focus return: dismissing from the input keeps focus on the input;
//     dismissing from the keyboard's Hide button returns focus to the
//     input, with the reopen suppressed for that one programmatic
//     refocus (dismissToInput). Commit is the exception: focus moves to
//     the first result, as the task directs.
//
// Pure TypeScript, no DOM, no Svelte runes — unit-tested in
// tests/couch-keyboard.test.ts. Views hold one instance and mirror
// `open` into a $state rune (see DiscoverView / SearchView).

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
