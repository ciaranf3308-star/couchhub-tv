// STUB-FOR-INTEGRATION — DO NOT SHIP. DELETE ON INTEGRATION.
//
// Minimal virtualised Guide harness for the W3 contract: On Now
// and By Channel lists that mount only a bounded window of rows
// no matter how many entries the guide holds. Kept ONLY under
// tests/. Rows are built by the REAL nowNextRows helper in the
// tests; this stub owns only the virtualised mounting.
//
// INTEGRATION: delete this file. Point the tests at W3's real
// Guide lists. The real lists MUST preserve these semantics
// (adapt selectors/wiring only, never weaken the assertions):
//   - On Now and By Channel mount at most the virtual row bound
//     with 2,000+ entries;
//   - scrolling / focus movement never grows the mounted count
//     past the bound;
//   - the focused row is always mounted.

import type { GuideNowRow, GuideProgramme } from "@/scripts/lib/livetv-guide";
import { guideProgrammeKey } from "@/scripts/lib/livetv-state";
import { mountVirtualList, virtualRowBound } from "./virtual-list.stub";

export { virtualRowBound };

export type GuideListMode = "now" | "channel";

export interface GuideChannelRow {
  channelId: string;
  channelName: string;
  programmes: readonly GuideProgramme[];
}

export type GuideListRow = GuideNowRow | GuideChannelRow;

export function isGuideNowRow(row: GuideListRow): row is GuideNowRow {
  return "current" in row;
}

export interface GuideListHandle {
  mode: GuideListMode;
  getRowCount(): number;
  getMountedRowCount(): number;
  getMountedKeys(): string[];
  getFocusedKey(): string | null;
  moveFocus(delta: number): string | null;
  setScrollTop(px: number): void;
  scrollByRows(rows: number): void;
  destroy(): void;
}

export function mountGuideList(
  root: HTMLElement,
  opts: {
    mode: GuideListMode;
    rows: readonly GuideListRow[];
    rowHeight?: number;
    viewportHeight?: number;
    overscanRows?: number;
  },
): GuideListHandle {
  const inner = mountVirtualList<GuideListRow>(root, {
    items: opts.rows,
    // On Now rows are keyed by programme (channel + start); By
    // Channel rows are keyed by channel.
    keyOf: (row) =>
      opts.mode === "now" && isGuideNowRow(row)
        ? guideProgrammeKey(row.channelId, row.current.startMs)
        : row.channelId,
    labelOf: (row) => (isGuideNowRow(row) ? row.current.title : row.channelName),
    programmeOf: (row) =>
      isGuideNowRow(row)
        ? (row.next?.title ?? "")
        : `${row.programmes.length} programmes`,
    rowHeight: opts.rowHeight,
    viewportHeight: opts.viewportHeight,
    overscanRows: opts.overscanRows,
  });
  return {
    mode: opts.mode,
    getRowCount: () => inner.getItemCount(),
    getMountedRowCount: () => inner.getMountedRowCount(),
    getMountedKeys: () => inner.getMountedKeys(),
    getFocusedKey: () => inner.getFocusedKey(),
    moveFocus: (delta: number) => inner.moveFocus(delta),
    setScrollTop: (px: number) => inner.setScrollTop(px),
    scrollByRows: (rows: number) => inner.scrollByRows(rows),
    destroy: () => inner.destroy(),
  };
}
