// RedSilk Couch — Live TV category index (0.11.7 W2).
//
// ═══════════════════════════════════════════════════════════════════
// STUB-FOR-INTEGRATION — DELETE THIS FILE AT INTEGRATION.
// ═══════════════════════════════════════════════════════════════════
// W1 owns the real shared category index (0.11.7 §2): group →
// provider subcategory → channels, built once per catalogue
// revision. W1 builds in parallel, so this module exists ONLY so
// W2's browser can be written, tested and rendered against the
// agreed seam — the export names and shapes below are the contract
// W1's module must honour when it replaces this file:
//
//   getCategoryIndex(channels) -> LivetvCategoryIndex
//   getDerivedChannels(index, selection) -> LivetvChannel[]
//
// The stub implements the contract honestly over the existing
// groupChannels() grouping (livetv-data.ts, read-only): groups are
// the real genre/provider groups, subcategories are the verbatim
// provider categories (categoryId) found inside each group —
// nothing is invented, and no subcategory is synthesised. It is
// still a STUB because it is not the shared indexed implementation:
// it rebuilds per catalogue array (cached by array identity) and
// integration MUST delete it in favour of W1's module. The browser
// consumes the index behind exactly ONE adapter function
// (getBrowserCategoryData in livetv-browser.ts), so the swap is
// one import, not a refactor.
//
// Contract details (W1: keep these):
//   - An index is built for one catalogue array and cached by that
//     array's identity; a new array (data refresh) yields a new
//     index with a higher `revision`.
//   - `groups` lists every groupChannels() group EXCEPT the
//     synthetic "all" group is included as a normal group (id
//     "all", label "All Channels") with NO subcategories — the
//     browser treats it as a top-level pseudo-entry. The adapter
//     (not this module) adds Favourites / Recents.
//   - A subcategory's `id` is the verbatim raw provider category
//     (LivetvChannel.categoryId); its `label` is the channel's
//     categoryLabel. Subcategories appear in first-seen order.
//   - getDerivedChannels returns the group's channels (or the
//     subcategory's slice) WITHOUT copying: callers must not
//     mutate the result (sort on a copy). Unknown group → [].
//     Unknown subcategory within a known group → [].

import {
  groupChannels,
  type LivetvChannel,
} from "./livetv-data";

/** One provider subcategory inside a group: a verbatim provider category. */
export interface LivetvCategorySubcategory {
  /** Raw provider category identity (LivetvChannel.categoryId), verbatim. */
  id: string;
  /** Display label (LivetvChannel.categoryLabel). */
  label: string;
  count: number;
}

/** One top-level group: a groupChannels() group + its real subcategories. */
export interface LivetvCategoryGroup {
  id: string;
  label: string;
  count: number;
  /** Real provider subcategories, first-seen order. Empty for "all". */
  subcategories: LivetvCategorySubcategory[];
}

/** A category selection: a group, optionally narrowed to one subcategory. */
export interface LivetvCategorySelection {
  groupId: string;
  /** Null = the whole group ("All <Group>"). */
  subcategoryId: string | null;
}

/**
 * The category index for one catalogue. `revision` rises on every
 * newly built index so consumers can cheaply detect a new
 * catalogue without comparing arrays.
 */
export interface LivetvCategoryIndex {
  revision: number;
  totalChannels: number;
  groups: LivetvCategoryGroup[];
  /** Channel slices, keyed `groupId` and `groupId\x00subcategoryId`. */
  slices: ReadonlyMap<string, readonly LivetvChannel[]>;
}

let nextRevision = 1;
const indexCache = new WeakMap<
  readonly LivetvChannel[],
  LivetvCategoryIndex
>();

function sliceKey(selection: LivetvCategorySelection): string {
  return selection.subcategoryId == null
    ? selection.groupId
    : `${selection.groupId}\u0000${selection.subcategoryId}`;
}

/**
 * Build (or return the cached) category index for a catalogue
 * array. Cached by array identity: the same array always yields
 * the same index object, so repeated calls during one browse are
 * free and `revision` only moves when the catalogue itself is
 * replaced (data refresh).
 */
export function getCategoryIndex(
  channels: readonly LivetvChannel[],
): LivetvCategoryIndex {
  const cached = indexCache.get(channels);
  if (cached) return cached;

  const slices = new Map<string, readonly LivetvChannel[]>();
  const groups: LivetvCategoryGroup[] = [];
  for (const group of groupChannels(channels)) {
    slices.set(group.id, group.channels);
    if (group.id === "all") {
      groups.push({
        id: group.id,
        label: group.label,
        count: group.channels.length,
        subcategories: [],
      });
      continue;
    }
    // Subcategories: distinct verbatim provider categories inside
    // this group, first-seen order. A channel belongs to exactly
    // one subcategory (its own raw category).
    const subById = new Map<string, LivetvChannel[]>();
    const subOrder: string[] = [];
    const subLabels = new Map<string, string>();
    for (const channel of group.channels) {
      const id = channel.categoryId || channel.categoryLabel || "uncategorized";
      let slice = subById.get(id);
      if (!slice) {
        slice = [];
        subById.set(id, slice);
        subOrder.push(id);
        subLabels.set(id, channel.categoryLabel || "Uncategorized");
      }
      slice.push(channel);
    }
    const subcategories: LivetvCategorySubcategory[] = subOrder.map((id) => {
      const slice = subById.get(id) ?? [];
      slices.set(`${group.id}\u0000${id}`, slice);
      return {
        id,
        label: subLabels.get(id) ?? id,
        count: slice.length,
      };
    });
    groups.push({
      id: group.id,
      label: group.label,
      count: group.channels.length,
      subcategories,
    });
  }

  const index: LivetvCategoryIndex = {
    revision: nextRevision++,
    totalChannels: channels.length,
    groups,
    slices,
  };
  indexCache.set(channels, index);
  return index;
}

/**
 * The derived channel slice for a selection: the whole group, or
 * one subcategory of it. Returns the index's stored slice — do NOT
 * mutate it. Unknown group or subcategory → [] (never a fallback
 * slice: the caller owns selection validity).
 */
export function getDerivedChannels(
  index: LivetvCategoryIndex,
  selection: LivetvCategorySelection,
): readonly LivetvChannel[] {
  return index.slices.get(sliceKey(selection)) ?? [];
}
