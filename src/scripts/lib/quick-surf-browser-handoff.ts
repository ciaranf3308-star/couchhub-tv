// Quick Surf → Channel Browser handoff (0.11.11 W2).
//
// SEAM CONTRACT WITH W1 (TvQuickSurf.astro — W1 owns that file; this
// module only consumes the contract, it never edits the panel):
//   W1 dispatches `quick-surf:open-browser` with detail
//   { action, channelId, categoryScope } where action is
//   'favourites' | 'recents' | 'categories' | 'search', channelId
//   is the currently tuned channel's id (or null), and
//   categoryScope is the current scope string (or null).
//   This module FIRST closes Quick Surf by dispatching
//   `quick-surf:close` (Quick Surf owns closing itself), then
//   opens the playback Channel Browser and performs the action.
//
// The browser is the EXISTING Channel Browser
// (livetv-browser.ts), mounted lazily by the playback shell with
// browserId "playback". This module creates no second browsing
// engine, no favourites list, no recents store and no search
// engine: every action goes through the real handle APIs
// (applyEntry / setSelection / openCategories / openSearch /
// focusChannel / getVisibleChannels).
//
// ASYNC-MOUNT DISCIPLINE: the shell's mount is asynchronous
// (mountCachedChannelBrowser). No handle method is ever invoked
// before the mount promise resolves. A generation token guards
// the await: the shell bumps the generation (cancelPending) when
// the browser closes, so a mount that resolves after the user
// closed the overlay applies NOTHING — it never reopens a closed
// browser, never retunes, and leaves playback untouched with the
// tuned stream intact. A second request supersedes the first.
//
// BACK: this module registers NO Back handler. Back stays with
// the existing Live TV stack: the search/sort top-layer guards,
// the browser's own one-layer handleBack for the screen
// instance, and the playback shell's handleBack (B from the
// in-playback browser closes the overlay and returns to
// fullscreen playback, stream preserved, Quick Surf never
// reopened).
//
// Y: the shell's Y key with Quick Surf closed calls
// openFullBrowser() — the same mount-guarded path, no filter,
// focus on the tuned channel. Y while Quick Surf is open belongs
// to Quick Surf (W1); it dispatches the contract event, with
// action 'browse' for the unfiltered browser. 'browse' is
// accepted here as the full-browser action alongside the four
// contract actions; it is never invented by this module as a
// W1→W2 requirement — W1 may equally map its Y to one of the
// four filtered actions.

import type { ChannelBrowserHandle } from "./livetv-browser";

/** W1 → W2: Quick Surf asks for the Channel Browser. */
export const QUICK_SURF_OPEN_BROWSER_EVENT = "quick-surf:open-browser";
/** W2 → W1: ask Quick Surf to close itself (it owns closing). */
export const QUICK_SURF_CLOSE_EVENT = "quick-surf:close";

/** The four actions W1's contract names. */
export type QuickSurfBrowserAction =
  | "favourites"
  | "recents"
  | "categories"
  | "search";

/**
 * Actions the handoff performs. 'browse' is the unfiltered
 * full-browser open (shell Y path; also accepted on the event so
 * W1 can map its Y to it). It changes no filter and opens no
 * drawer or search — it focuses the tuned channel's row.
 */
export type QuickSurfBrowserRequestAction =
  | QuickSurfBrowserAction
  | "browse";

const REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  "favourites",
  "recents",
  "categories",
  "search",
  "browse",
]);

/** Detail carried on `quick-surf:open-browser`. */
export interface QuickSurfOpenBrowserDetail {
  action: QuickSurfBrowserAction | string;
  channelId?: string | number | null;
  categoryScope?: string | null;
}

/**
 * The playback shell's side of the handoff. The module never
 * touches the shell's DOM directly except through the default
 * Quick Surf presence check (see isQuickSurfPanelOpen); the
 * adapter keeps the mount/focus discipline testable without the
 * shell.
 */
export interface QuickSurfBrowserAdapter {
  /** True when Quick Surf's panel is present AND open. */
  isQuickSurfPresent(): boolean;
  /** Show the browser container and start the lazy mount. */
  openBrowser(): void;
  /** True while the browser container is visible. */
  isBrowserOpen(): boolean;
  /**
   * Resolve to the browser handle once the asynchronous mount
   * has completed, or null when there is no playlist / no
   * mount. Must never reject for a missing mount — a null
   * handle is a quiet no-op (the shell shows its
   * provider-lost text).
   */
  awaitBrowserHandle(): Promise<ChannelBrowserHandle | null>;
  /** Focus the browser's list element (empty-list fallback). */
  focusBrowserList(): void;
  /** The currently tuned channel id, for 'browse' focus. */
  getTunedChannelId?(): string | number | null;
}

/**
 * Default Quick Surf presence check: the panel element exists
 * and is not hidden. Matches the shell's own overlayOpen()
 * reading ([data-livetv-quicksurf] + hidden). A missing element
 * (panel not mounted) or a hidden panel both read as absent, so
 * a spurious event with Quick Surf closed is a safe no-op.
 */
export function isQuickSurfPanelOpen(
  doc: Pick<Document, "querySelector"> = document,
): boolean {
  const panel = doc.querySelector<HTMLElement>("[data-livetv-quicksurf]");
  if (!panel) return false;
  if (panel.hidden) return false;
  if (panel.dataset.hidden === "true") return false;
  return true;
}

function isRequestAction(value: unknown): value is QuickSurfBrowserRequestAction {
  return typeof value === "string" && REQUEST_ACTIONS.has(value);
}

function normaliseDetail(
  detail: unknown,
): { action: QuickSurfBrowserRequestAction; channelId: string | number | null; categoryScope: string | null } | null {
  if (!detail || typeof detail !== "object") return null;
  const raw = detail as Partial<QuickSurfOpenBrowserDetail>;
  if (!isRequestAction(raw.action)) return null;
  const channelId =
    typeof raw.channelId === "string" || typeof raw.channelId === "number"
      ? raw.channelId
      : null;
  const categoryScope =
    typeof raw.categoryScope === "string" && raw.categoryScope !== ""
      ? raw.categoryScope
      : null;
  return { action: raw.action, channelId, categoryScope };
}

/**
 * Focus a real channel row after a filter or browse action: the
 * preferred channel when it is visible, else the first visible
 * channel (recents keep their actual most-recent-first order —
 * getVisibleChannels() already returns it). An empty list falls
 * back to the list element itself, so focus never strands on
 * the playback surface.
 */
function focusPreferredRow(
  adapter: QuickSurfBrowserAdapter,
  handle: ChannelBrowserHandle,
  preferredId: string | number | null,
): void {
  const visible = handle.getVisibleChannels();
  const preferred =
    preferredId != null
      ? visible.find((c) => String(c.id) === String(preferredId))
      : undefined;
  const target = preferred ?? visible[0];
  if (target) {
    handle.focusChannel(target.id);
  } else {
    adapter.focusBrowserList();
  }
}

/** Apply one requested action to a mounted handle. Synchronous: no awaits inside. */
function applyBrowserAction(
  adapter: QuickSurfBrowserAdapter,
  handle: ChannelBrowserHandle,
  action: QuickSurfBrowserRequestAction,
  channelId: string | number | null,
  categoryScope: string | null,
): void {
  if (action === "favourites" || action === "recents") {
    // The EXISTING filter: applyEntry maps the kind onto the
    // browser's favourites / recents selection (existing
    // favourites state, existing recents ordering). No new
    // list, no new storage.
    handle.applyEntry({ kind: action });
    focusPreferredRow(adapter, handle, channelId);
    return;
  }
  if (action === "categories") {
    // Open the drawer's group list, focused on the
    // selected/current group (openCategories focuses the
    // current group itself). When categoryScope names a group
    // the browser knows, select it first so drawer + list
    // agree; anything else (e.g. a raw provider category
    // string, which is not a group id) leaves the current
    // selection untouched — setSelection falls back to "all"
    // for unknown ids, so verify and restore.
    if (categoryScope) {
      const before = handle.getSelection();
      if (categoryScope !== before.groupId) {
        handle.setSelection(categoryScope, null);
        if (handle.getSelection().groupId !== categoryScope) {
          handle.setSelection(before.groupId, before.subcategoryId);
        }
      }
    }
    handle.openCategories();
    return;
  }
  if (action === "search") {
    // The EXISTING search action: the browser dispatches
    // `livetv:open-search` and W4's overlay owns the input +
    // keyboard. The shell's open path already focused the
    // browser list, so a missing overlay still leaves focus
    // inside the browser. No new search engine.
    handle.openSearch();
    return;
  }
  // 'browse': full browser, current selection, focus the tuned
  // channel's row (or the first visible row).
  focusPreferredRow(adapter, handle, channelId);
}

export interface QuickSurfBrowserHandoff {
  /** Stop listening for `quick-surf:open-browser` and cancel any pending mount. */
  dispose(): void;
  /** Invalidate any in-flight mount await (shell calls this when the browser closes). */
  cancelPending(): void;
  /**
   * Event-path entry: requires Quick Surf present, closes it,
   * then opens the browser and applies the action. Unknown /
   * malformed details and absent Quick Surf are safe no-ops.
   */
  openFromQuickSurf(detail: unknown): void;
  /**
   * Direct entry for the shell's Y key (Quick Surf closed):
   * same mount-guarded open, 'browse' action. Closes Quick
   * Surf first when it happens to be present.
   */
  openFullBrowser(channelId?: string | number | null): void;
}

/**
 * Install the handoff on `target` (window in production).
 * Exactly one listener, for `quick-surf:open-browser` only.
 */
export function installQuickSurfBrowserHandoff(
  adapter: QuickSurfBrowserAdapter,
  target: EventTarget = window,
): QuickSurfBrowserHandoff {
  // Generation token: every request and every cancel bumps it.
  // A mount await whose token is stale applies nothing.
  let generation = 0;
  let disposed = false;

  const runRequest = (
    action: QuickSurfBrowserRequestAction,
    channelId: string | number | null,
    categoryScope: string | null,
  ): void => {
    // Close Quick Surf FIRST — it owns closing itself — before
    // the browser opens. (The event-path caller already
    // verified presence; the direct caller checks here.)
    if (adapter.isQuickSurfPresent()) {
      target.dispatchEvent(new CustomEvent(QUICK_SURF_CLOSE_EVENT));
    }
    const token = ++generation;
    adapter.openBrowser();
    void adapter.awaitBrowserHandle().then((handle) => {
      if (disposed || token !== generation) return;
      if (!handle) return;
      // Closed while the mount was resolving: never reopen a
      // closed browser because an old Promise completed.
      if (!adapter.isBrowserOpen()) return;
      applyBrowserAction(adapter, handle, action, channelId, categoryScope);
    });
  };

  const onOpenBrowser = (event: Event): void => {
    const detail = (event as CustomEvent).detail;
    const parsed = normaliseDetail(detail);
    if (!parsed) return;
    // Spurious event / Quick Surf already closed: safe no-op.
    // No close dispatch, no browser open, no handle calls.
    if (!adapter.isQuickSurfPresent()) return;
    runRequest(parsed.action, parsed.channelId, parsed.categoryScope);
  };

  target.addEventListener(QUICK_SURF_OPEN_BROWSER_EVENT, onOpenBrowser);

  return {
    dispose(): void {
      disposed = true;
      generation++;
      target.removeEventListener(QUICK_SURF_OPEN_BROWSER_EVENT, onOpenBrowser);
    },
    cancelPending(): void {
      generation++;
    },
    openFromQuickSurf(detail: unknown): void {
      const parsed = normaliseDetail(detail);
      if (!parsed) return;
      if (!adapter.isQuickSurfPresent()) return;
      runRequest(parsed.action, parsed.channelId, parsed.categoryScope);
    },
    openFullBrowser(channelId?: string | number | null): void {
      const tuned =
        channelId ?? adapter.getTunedChannelId?.() ?? null;
      runRequest("browse", tuned, null);
    },
  };
}
