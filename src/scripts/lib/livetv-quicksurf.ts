// RedSilk Live TV — Quick Surf rebuild (0.11.11, W1).
//
// Pure, DOM-free core for TvQuickSurf.astro: bounded highlight
// stepping, a clamped (non-wrapping) surf window, scope-aware list
// resolution through the SHARED Live TV 2.0 category index, and the
// W1↔W2 playback-browser handoff contract. The component script
// owns the DOM; everything decidable here lives here so tests
// assert it without rendering Astro.
//
// Why this module exists instead of reusing livetv-playback.ts:
// `stepHighlight` / `surfWindow` WRAP at the ends of the list and
// other suites pin that behaviour for the shared player paths.
// Quick Surf must NOT wrap (brief §5): at the end of a list the
// highlight retains its position and the user picks Categories /
// Search / Favourites / Recents to move elsewhere. The bounded
// variants here are the only stepping/windowing Quick Surf uses.
//
// Scope: a category-index GROUP id (e.g. "irish-uk", "sports",
// "provider:..."), or null for the whole catalogue. Lists resolve
// through `getDerivedChannels`, which memoises per index — the
// same scope on the same index returns the SAME array reference,
// so highlight moves never re-filter the catalogue. Resolution
// happens only when the scope or the catalogue changes; per-press
// work is an index lookup and a slice of at most 5 entries.
//
// Identity: ids are String-compared throughout. The playback shell
// stores the tuned id in a dataset attribute (always a string)
// while provider ids may be numbers; strict `===` comparison
// (channelIndexById) would strand the highlight. Canonical ids
// returned here are always the list entry's own id.
//
// Seam contract (W1↔W2, exact — see the brief):
//   Quick Surf dispatches `quick-surf:open-browser` with detail
//   `{ action, channelId, categoryScope }` when a discovery action
//   activates. `action` is one of the four values below,
//   `channelId` is the tuned channel's id (or null), and
//   `categoryScope` is the current scope group id (or null).
//   Quick Surf listens for `quick-surf:close` and closes itself.
//   ADDITIVE inbound seam (not in the brief's contract, needed so
//   a scope chosen in the browser can reach Quick Surf):
//   `quick-surf:set-scope` with detail `{ categoryScope }` sets
//   the scope; a missing/unusable detail is ignored.
//   Y KEY: the shell's Y handler returns early while Quick Surf
//   is open (overlay-owns-input discipline, W2), so Quick Surf
//   owns Y itself and dispatches the same event with action
//   'browse' — W2's unfiltered full-browser open, focus on the
//   tuned channel's row. 'browse' is a request action only: it is
//   never a discovery button.

import {
  getDerivedChannels,
  groupForRawCategory,
  type CategoryIndex,
} from "./livetv-category-index";
import type { LivetvChannel } from "./livetv-data";

// ── Handoff contract ─────────────────────────────────────────────

export const QUICK_SURF_OPEN_BROWSER_EVENT = "quick-surf:open-browser";
export const QUICK_SURF_CLOSE_EVENT = "quick-surf:close";
/** Additive inbound seam: the browser (W2) telling Quick Surf which scope to surf. */
export const QUICK_SURF_SET_SCOPE_EVENT = "quick-surf:set-scope";

export type QuickSurfBrowserAction =
  | "favourites"
  | "recents"
  | "categories"
  | "search";

/**
 * Actions W2's handoff performs: the four contract actions plus
 * 'browse', the Y-key unfiltered full-browser open (focus on the
 * tuned channel's row, no filter, no drawer, no search). Mirrors
 * W2's QuickSurfBrowserRequestAction; 'browse' is never a
 * discovery button.
 */
export type QuickSurfBrowserRequestAction = QuickSurfBrowserAction | "browse";

export const QUICK_SURF_BROWSER_ACTIONS: readonly QuickSurfBrowserAction[] = [
  "favourites",
  "recents",
  "categories",
  "search",
] as const;

export function isQuickSurfBrowserAction(
  value: unknown,
): value is QuickSurfBrowserAction {
  // Four discovery buttons only: 'browse' is Y-only and must
  // never validate as a button action.
  return (
    value === "favourites" ||
    value === "recents" ||
    value === "categories" ||
    value === "search"
  );
}

export interface QuickSurfOpenBrowserDetail {
  action: QuickSurfBrowserRequestAction;
  /** Currently tuned channel's id, or null when nothing is tuned. */
  channelId: string | number | null;
  /** Current scope group id, or null for the whole catalogue. */
  categoryScope: string | null;
}

/** The exact detail shape Quick Surf dispatches on `quick-surf:open-browser`. */
export function createQuickSurfOpenBrowserDetail(
  action: QuickSurfBrowserRequestAction,
  channelId: string | number | null | undefined,
  categoryScope: string | null | undefined,
): QuickSurfOpenBrowserDetail {
  return {
    action,
    channelId: channelId ?? null,
    categoryScope: categoryScope ?? null,
  };
}

/**
 * Parse a `quick-surf:set-scope` detail. Returns undefined when the
 * detail carries no usable scope (the caller ignores the event);
 * otherwise the scope group id, or null for All channels (an
 * explicit null / empty string clears the scope).
 */
export function parseQuickSurfScopeDetail(detail: unknown): string | null | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  if (!("categoryScope" in detail)) return undefined;
  const scope = (detail as { categoryScope?: unknown }).categoryScope;
  if (scope === null || scope === undefined) return null;
  if (typeof scope === "string") return scope === "" ? null : scope;
  return undefined;
}

// ── Identity (String-compared) ───────────────────────────────────

/** Index of an id in a list, String-compared; -1 when absent or nullish. */
export function quickSurfIndexById(
  list: ReadonlyArray<{ id: string | number }>,
  id: string | number | null | undefined,
): number {
  if (id === null || id === undefined) return -1;
  const wanted = String(id);
  return list.findIndex((entry) => String(entry.id) === wanted);
}

// ── Bounded stepping + window ────────────────────────────────────

/** The compact Quick Surf list: two before, highlight, two after. */
export const QUICK_SURF_WINDOW_SIZE = 5;

/**
 * Step the highlight one adjacent channel WITHOUT wrapping.
 * Returns the new highlighted id, or null when there is nothing to
 * step to: an empty list, or the highlight already at the bound in
 * the stepped direction (the caller retains its position — no
 * repaint, no drift to the other end of a 15,319-channel list).
 * A highlight outside the list steps to the first (down) or last
 * (up) entry. Pure: stepping never tunes.
 */
export function stepHighlightBounded(
  list: ReadonlyArray<{ id: string | number }>,
  highlightedId: string | number | null | undefined,
  delta: 1 | -1,
): string | number | null {
  if (!list.length) return null;
  const current = quickSurfIndexById(list, highlightedId);
  if (current < 0) {
    return delta > 0 ? list[0].id : list[list.length - 1].id;
  }
  const next = current + delta;
  if (next < 0 || next >= list.length) return null;
  return list[next].id;
}

export interface QuickSurfWindow {
  /** Nearby entries around the highlight — clamped, never wrapped. */
  entries: LivetvChannel[];
  /** 1-based position of the highlight in the scoped list. */
  position: number;
  /** Length of the scoped list. */
  total: number;
}

/**
 * The compact Quick Surf list: a small window of nearby channels
 * around the highlight (default 5), CLAMPED at the ends — the
 * window slides so the highlight stays visible, and the first
 * window never contains the last channel (or vice versa). Pure —
 * windowing never tunes. `position`/`total` feed the header
 * indicator, always in the context of the current scope.
 */
export function surfWindowBounded(
  list: readonly LivetvChannel[],
  highlightedId: string | number | null | undefined,
  size: number = QUICK_SURF_WINDOW_SIZE,
): QuickSurfWindow {
  const total = list.length;
  if (total === 0) return { entries: [], position: 0, total: 0 };
  const windowSize = Math.max(1, Math.min(size, total));
  let centre = quickSurfIndexById(list, highlightedId);
  if (centre < 0) centre = 0;
  const before = Math.floor(windowSize / 2);
  const start = Math.max(0, Math.min(centre - before, total - windowSize));
  return {
    entries: list.slice(start, start + windowSize),
    position: centre + 1,
    total,
  };
}

// ── Scope-aware list resolution (shared category index) ──────────

/**
 * The surfable list for a scope, resolved through the shared
 * category index — never a fresh catalogue filter. Null scope is
 * the whole catalogue in provider order; a group id selects that
 * group's channels in subcategory order; an unknown group id
 * yields [] (the caller falls back to All channels rather than
 * stranding the user on an empty surf). Memoised per index by
 * `getDerivedChannels`: repeat calls return the same reference.
 * The returned array is read-only — never mutate it.
 */
export function resolveQuickSurfList(
  index: CategoryIndex,
  scopeGroupId: string | null | undefined,
): LivetvChannel[] {
  if (!scopeGroupId) return getDerivedChannels(index, {});
  return getDerivedChannels(index, { groupId: scopeGroupId });
}

/** Display label for a scope: the group's label, or "All channels". */
export function quickSurfScopeLabel(
  index: CategoryIndex,
  scopeGroupId: string | null | undefined,
): string {
  if (!scopeGroupId) return "All channels";
  return (
    index.groups.find((group) => group.id === scopeGroupId)?.label ??
    "All channels"
  );
}

/** The category-index group label a channel belongs to (header context). */
export function groupLabelForChannel(
  channel: Pick<LivetvChannel, "category" | "categoryId"> | null | undefined,
): string {
  if (!channel) return "All channels";
  return groupForRawCategory(channel.categoryId ?? channel.category ?? "").label;
}

/**
 * Resolve the highlight inside a (possibly newly scoped) list:
 * prefer the current highlight when it is in the list, else the
 * tuned channel, else the first entry, else null. Returns the
 * list entry's own canonical id. Keeps the highlight inside the
 * scope — a scope change never leaves it pointing at a channel
 * the user can no longer step to.
 */
export function resolveHighlightInList(
  list: readonly LivetvChannel[],
  preferredId: string | number | null | undefined,
  fallbackId: string | number | null | undefined,
): string | number | null {
  for (const candidate of [preferredId, fallbackId]) {
    const at = quickSurfIndexById(list, candidate);
    if (at >= 0) return list[at].id;
  }
  return list[0]?.id ?? null;
}

/** Header position text within the current scope ("5 / 42", "" when empty). */
export function quickSurfPositionText(position: number, total: number): string {
  return total > 0 ? `${position} / ${total}` : "";
}
