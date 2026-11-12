// STUB-FOR-INTEGRATION — DO NOT SHIP. DELETE ON INTEGRATION.
//
// The five contracted CustomEvent names for Live TV 2.0 overlays
// (W2/W4 surface), with their detail shapes and dispatch helpers.
// These events do NOT exist on the 0.11.5 base; W2/W4 will dispatch
// them from the real search/sort overlays. Kept ONLY under tests/.
//
// INTEGRATION: delete this file. The real event names/details live
// with the W2/W4 overlay code; tests must import the real constants
// (or keep asserting the literal names below, which are the
// contract). Detail shapes MUST be preserved:
//   livetv:search-submit → { query: string }
//   livetv:sort-submit   → { sort: string }
//   the open/close events carry no detail.

export const LIVETV_OPEN_SEARCH_EVENT = "livetv:open-search";
export const LIVETV_SEARCH_SUBMIT_EVENT = "livetv:search-submit";
export const LIVETV_OPEN_SORT_EVENT = "livetv:open-sort";
export const LIVETV_SORT_SUBMIT_EVENT = "livetv:sort-submit";
export const LIVETV_CLOSE_OVERLAY_EVENT = "livetv:close-overlay";

export interface LivetvSearchSubmitDetail {
  query: string;
}

export interface LivetvSortSubmitDetail {
  sort: string;
}

function target(): EventTarget {
  return typeof window !== "undefined" ? window : globalThis;
}

export function dispatchLivetvOpenSearch(): void {
  target().dispatchEvent(new CustomEvent(LIVETV_OPEN_SEARCH_EVENT));
}

export function dispatchLivetvSearchSubmit(query: string): void {
  target().dispatchEvent(
    new CustomEvent<LivetvSearchSubmitDetail>(LIVETV_SEARCH_SUBMIT_EVENT, {
      detail: { query },
    }),
  );
}

export function dispatchLivetvOpenSort(): void {
  target().dispatchEvent(new CustomEvent(LIVETV_OPEN_SORT_EVENT));
}

export function dispatchLivetvSortSubmit(sort: string): void {
  target().dispatchEvent(
    new CustomEvent<LivetvSortSubmitDetail>(LIVETV_SORT_SUBMIT_EVENT, {
      detail: { sort },
    }),
  );
}

export function dispatchLivetvCloseOverlay(): void {
  target().dispatchEvent(new CustomEvent(LIVETV_CLOSE_OVERLAY_EVENT));
}
