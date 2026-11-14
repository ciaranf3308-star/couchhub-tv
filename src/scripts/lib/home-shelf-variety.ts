// Shelf variety allocation (0.11.14, W5 Homes — brief §14, §15).
// Pure. Roles, not seven repetitive shelves: each shelf gets an
// over-fetched pool from its own selector, and allocation dedupes
// across shelves WITHOUT starving any of them — a title taken by an
// earlier (higher-priority) shelf is replaced in later shelves by
// the next title in that shelf's own pool, never by rubbish, and a
// shelf with no legitimate titles left renders nothing rather than
// filler.
//
// Priority order (first shelf keeps a contested title):
//   featured > AI Picks > Worth Watching/Starting > Something
//   Different > Hidden Gems/Undiscovered > Recently Added.
// Continue Watching is EXEMPT (a title can be both in progress and
// recommended) and never consumes an id. Recently Added is factual:
// it is deduped against the shelves above it (with backfill from
// its own dated pool) but no quality gate is ever applied to it.

export interface ShelfPoolItem {
  id: string;
}

export interface ShelfPool<T extends ShelfPoolItem> {
  /** Shelf role id (e.g. "ai", "worth", "different", "gems", "recent"). */
  id: string;
  /** Over-fetched pool in selector order. */
  items: T[];
  /** How many the shelf shows at most. */
  limit: number;
  /** Exempt shelves pass through untouched and never mark ids seen. */
  exempt?: boolean;
}

export interface AllocatedShelf<T extends ShelfPoolItem> {
  id: string;
  items: T[];
  /** Titles dropped as cross-shelf repeats (replaced by backfill where possible). */
  droppedRepeatCount: number;
}

/**
 * Allocate shelves from over-fetched pools. Each shelf fills to its
 * limit from its own pool, skipping ids already taken by an earlier
 * non-exempt shelf. A shelf whose pool is exhausted after dedup
 * simply shows fewer titles — allocation never invents or borrows
 * titles from another shelf's pool. Inputs are never mutated.
 */
export function allocateShelves<T extends ShelfPoolItem>(
  pools: ShelfPool<T>[],
): AllocatedShelf<T>[] {
  const seen = new Set<string>();
  return (pools ?? []).map((pool) => {
    if (pool.exempt) {
      return { id: pool.id, items: [...pool.items].slice(0, Math.max(0, pool.limit)), droppedRepeatCount: 0 };
    }
    const kept: T[] = [];
    const shelfSeen = new Set<string>();
    let dropped = 0;
    for (const item of pool.items ?? []) {
      if (kept.length >= pool.limit) break;
      if (shelfSeen.has(item.id)) {
        dropped++;
        continue;
      }
      shelfSeen.add(item.id);
      if (seen.has(item.id)) {
        dropped++;
        continue;
      }
      kept.push(item);
    }
    for (const item of kept) seen.add(item.id);
    return { id: pool.id, items: kept, droppedRepeatCount: dropped };
  });
}

/** Over-fetch factor for selector pools feeding allocation (2x the shelf limit). */
export const SHELF_POOL_OVERFETCH = 2;

/** Shelf limits (brief §15): richer rows, sensible visible counts — rails scroll horizontally. */
export const HOME_SHELF_LIMITS = {
  aiPicks: 16,
  worthWatching: 18,
  somethingDifferent: 16,
  hiddenGems: 16,
  recentlyAdded: 16,
  continueWatching: 8,
} as const;

/**
 * True when two shelves share more than `maxShared` titles — the
 * "same five titles in every row" check (§14). Used by tests and by
 * the models' own safety net; allocation itself prevents this by
 * construction, so a true result means a pool bypassed allocation.
 */
export function shelvesShareTooMany(
  a: readonly ShelfPoolItem[],
  b: readonly ShelfPoolItem[],
  maxShared = 0,
): boolean {
  const ids = new Set(a.map((item) => item.id));
  let shared = 0;
  for (const item of b) {
    if (ids.has(item.id) && ++shared > maxShared) return true;
  }
  return false;
}
