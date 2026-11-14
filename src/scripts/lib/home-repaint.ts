// Home shelf repaints (0.11.14, W5) — one wrapper for every Home
// shelf refresh, built on W1's focus mechanism (§24). Focus
// preservation is W1's withPreservedFocus (exact key → same
// rail/index → nothing, never steals live focus, restores even on
// throw); Homes adds ONLY a rail scrollLeft snapshot, because
// shelf painters replace the row element itself on every repaint,
// which would otherwise reset every rail's horizontal position to
// the left edge. Page scroll follows the restored focus target
// through W1's container-aware scrollFocusedIntoView — Homes keeps
// no page-scroll snapshot and no focus logic of its own.
//
// NOTE for integration/W1: withPreservedFocus restores the focused
// rail's scroll via scroll-into-view, but non-focused repainted
// rails are not covered by the W1 mechanism — that gap is what the
// scroll snapshot below closes. If W1 absorbs rail-scroll
// preservation, this module should shrink to a bare re-export.

import { withPreservedFocus } from "@/scripts/lib/couch-focus.ts"

function snapshotRailScroll(root: ParentNode): Map<string, number> {
  const scrolls = new Map<string, number>()
  for (const row of root.querySelectorAll("[data-nylah-rail] .rs-rail__row")) {
    const rail = row.closest("[data-nylah-rail]")?.getAttribute("data-nylah-rail")
    if (rail) scrolls.set(rail, (row as HTMLElement).scrollLeft || 0)
  }
  return scrolls
}

function restoreRailScroll(root: ParentNode, scrolls: Map<string, number>): void {
  for (const row of root.querySelectorAll("[data-nylah-rail] .rs-rail__row")) {
    const rail = row.closest("[data-nylah-rail]")?.getAttribute("data-nylah-rail")
    if (!rail) continue
    const left = scrolls.get(rail)
    if (left !== undefined) (row as HTMLElement).scrollLeft = left
  }
}

/**
 * Run a shelf re-render preserving focus (W1) and rail scroll
 * positions. The mutation's return value passes through; a
 * throwing mutation still restores focus and scroll before the
 * error propagates. Rail scroll is restored BEFORE W1's focus
 * restore runs, so scroll-into-view of the restored target wins
 * when the two disagree.
 */
export function repaintHomePreserving<T>(root: HTMLElement, mutate: () => T): T {
  const scrolls = snapshotRailScroll(root)
  return withPreservedFocus(root, () => {
    try {
      return mutate()
    } finally {
      restoreRailScroll(root, scrolls)
    }
  })
}
