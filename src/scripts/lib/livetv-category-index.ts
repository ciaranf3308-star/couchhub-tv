// STUB-FOR-INTEGRATION — Live TV 0.11.7 (W3, Guide).
//
// This module is a MINIMAL stand-in for W1's shared category index.
// It implements exactly the interface the Guide was told to consume
// (`getCategoryIndex` / `getDerivedChannels`, shapes below) so the
// Guide can be built, tested and verified against the 0.11.5 base
// before W1's real index lands. INTEGRATION MUST DELETE THIS FILE
// and replace it with W1's `livetv-category-index.ts`; the Guide
// consumes the index ONLY through the single adapter in
// `livetv-guide-categories.ts`, so the swap touches one seam.
//
// What the stub does (honestly, from real provider data only):
//
//   - Groups reuse the ONE existing grouping, `groupChannels` from
//     livetv-data.ts — the stub invents no second grouping. That
//     means the stub inherits groupChannels' known collapse (a
//     `/sport/` label collapses every sports provider group into
//     one Sports bucket); W1's real index is the fix for that, and
//     the subcategory level below is what keeps a collapsed group
//     navigable in the meantime.
//   - Subcategories are the REAL provider structure: every distinct
//     verbatim raw provider category string inside a group, in
//     first-seen order. No subcategory is invented, split, merged
//     or renamed — the raw string is the identity, and only the
//     display label is normalised (normaliseCategoryLabel).
//   - No dedupe: the stub never drops or merges channels. The
//     Guide's channel list is the cached catalogue verbatim;
//     dedupe lives in mapLivetvChannels and must never silently
//     remove a channel the Guide (and its EPG mapping) expects.
//
// Favourites / recents are NOT part of the index — they are
// preference-derived, not provider structure. The Guide adapter
// handles those pseudo-selections itself and only calls
// getDerivedChannels for real provider groups.

import {
  groupChannels,
  LIVETV_ALL_GROUP_ID,
  normaliseCategoryLabel,
} from "./livetv-data";
import type { LivetvChannel } from "./livetv-data";

/** Minimal channel shape the index needs: identity + raw category. */
export interface CategoryIndexInput {
  id: string | number;
  /** Raw provider category string (verbatim identity). */
  category?: string | null;
  /** Provider `group-title` list; first entry is the category when `category` is absent. */
  categories?: string[] | null;
  /** Display name (unused by the index, carried for callers that pass full rows). */
  name?: string;
  [key: string]: unknown;
}

/** One real provider subcategory: a verbatim raw category string. */
export interface CategoryIndexSubcategory {
  /** Verbatim raw provider category string (the identity). */
  id: string;
  /** Display label: normaliseCategoryLabel(id). */
  label: string;
  /** Channels in this subcategory. */
  channelCount: number;
  /** String channel ids in this subcategory, in catalogue order. */
  channelIds: string[];
}

/** One group: provider subcategories under a shared group label. */
export interface CategoryIndexGroup {
  /** Group identity from groupChannels (e.g. "sports", "irish-uk", "provider:…"). */
  id: string;
  /** Display label from groupChannels. */
  label: string;
  /** Channels in this group (sum of its subcategories). */
  channelCount: number;
  /** Real provider subcategories, first-seen order. Never invented. */
  subcategories: CategoryIndexSubcategory[];
}

/** The shared category index: group → provider subcategory → channels. */
export interface CategoryIndex {
  groups: CategoryIndexGroup[];
  /** Total channels indexed. */
  totalChannels: number;
  /** Catalogue revision the index was built from (caller-supplied). */
  revision: number;
}

/** A category selection: a whole group, or one subcategory of it. */
export interface CategorySelection {
  /** Group id, or null for "all channels". */
  groupId: string | null;
  /** Verbatim raw category string, or null for the whole group. */
  subcategoryId: string | null;
}

/** The "all channels" selection. */
export const CATEGORY_SELECTION_ALL: CategorySelection = {
  groupId: null,
  subcategoryId: null,
};

const UNCATEGORIZED_ID = "__uncategorized__";

/** Raw category string for a channel row (verbatim, trimmed). */
function rawCategoryOf(channel: CategoryIndexInput): string {
  const direct =
    typeof channel.category === "string" ? channel.category.trim() : "";
  if (direct) return direct;
  if (Array.isArray(channel.categories) && channel.categories.length > 0) {
    const first = channel.categories[0];
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  return "";
}

/**
 * Build the category index for a catalogue. Groups come from the
 * canonical groupChannels; subcategories are the distinct verbatim
 * raw categories inside each group. Pure: the input is never
 * mutated, and the same input always yields the same index.
 */
export function getCategoryIndex(
  channels: readonly CategoryIndexInput[],
  opts: { revision?: number } = {},
): CategoryIndex {
  // groupChannels only reads categoryLabel / categoryId, so the
  // lite rows carry exactly those (plus id) — no dedupe, no
  // display-name rewriting, no invented fields.
  const lite: LivetvChannel[] = channels.map((channel) => {
    const raw = rawCategoryOf(channel);
    return {
      id: channel.id,
      name: typeof channel.name === "string" ? channel.name : String(channel.id),
      displayName:
        typeof channel.name === "string" ? channel.name : String(channel.id),
      logo: null,
      category: raw,
      categoryId: raw,
      categoryLabel: normaliseCategoryLabel(raw),
      streamUrl: null,
      tvgId: null,
      catchup: false,
      favourite: false,
      hidden: false,
      norm: "",
    };
  });
  const grouped = groupChannels(lite);
  const groups: CategoryIndexGroup[] = [];
  for (const group of grouped) {
    if (group.id === LIVETV_ALL_GROUP_ID) continue;
    const subById = new Map<string, CategoryIndexSubcategory>();
    for (const channel of group.channels) {
      const raw = channel.categoryId || "";
      const id = raw || UNCATEGORIZED_ID;
      let sub = subById.get(id);
      if (!sub) {
        sub = {
          id,
          label: raw ? normaliseCategoryLabel(raw) : "Uncategorized",
          channelCount: 0,
          channelIds: [],
        };
        subById.set(id, sub);
      }
      sub.channelCount += 1;
      sub.channelIds.push(String(channel.id));
    }
    const subcategories = [...subById.values()];
    groups.push({
      id: group.id,
      label: group.label,
      channelCount: group.channels.length,
      subcategories,
    });
  }
  return {
    groups,
    totalChannels: channels.length,
    revision: opts.revision ?? 0,
  };
}

/**
 * Channels for a selection, in catalogue order. `null` groupId
 * returns every channel; a groupId returns that group's channels;
 * a subcategoryId narrows to that verbatim provider category.
 * An unknown group / subcategory returns [] — a stale selection
 * must show the honest empty state, never silently fall back to
 * the whole catalogue. The input array is never mutated.
 */
export function getDerivedChannels<T extends CategoryIndexInput>(
  channels: readonly T[],
  index: CategoryIndex,
  selection: CategorySelection,
): T[] {
  if (selection.groupId === null) return [...channels];
  const group = index.groups.find((candidate) => candidate.id === selection.groupId);
  if (!group) return [];
  if (selection.subcategoryId === null) {
    const ids = new Set<string>();
    for (const sub of group.subcategories) {
      for (const id of sub.channelIds) ids.add(id);
    }
    return channels.filter((channel) => ids.has(String(channel.id)));
  }
  const sub = group.subcategories.find(
    (candidate) => candidate.id === selection.subcategoryId,
  );
  if (!sub) return [];
  const ids = new Set(sub.channelIds);
  return channels.filter((channel) => ids.has(String(channel.id)));
}
