// RedSilk Couch — Guide category adapter (Live TV 0.11.7, W3).
//
// THE ONE adapter between the Guide and the shared category index.
// Every index read in the Guide goes through `resolveGuideCategory`
// below — no other Guide code imports `livetv-category-index.ts`,
// and no second categorisation is maintained anywhere in the
// Guide. The adapter only uses getCategoryIndex /
// getDerivedChannels from W1's real index module.
//
// Selections:
//   - "all" — every channel (the old select's "All categories").
//   - "favourites" / "recents" — preference-derived pseudo-groups,
//     resolved here (never in the index: they are not provider
//     structure). Favourites keep catalogue order; recents keep
//     most-recent-first order, exactly as the old select filter did.
//   - "group" — one index group, optionally narrowed to one verbatim
//     provider subcategory. A selection whose group / subcategory
//     no longer exists in the index (catalogue changed) is validated
//     back to "all" — a stale selection shows the whole guide, never
//     a phantom empty list.
//
// The index is cached by catalogue revision: the caller bumps
// `revision` whenever it re-reads the catalogue, and the adapter
// rebuilds the index only then. Filtering itself is O(n) per call
// and runs only on selection / data changes — never on scroll.

import {
  getCategoryIndex,
  getDerivedChannels,
} from "./livetv-category-index";
import type {
  CategoryIndex,
  DerivedChannelsOptions,
} from "./livetv-category-index";
import type { LivetvChannel } from "./livetv-data";

/**
 * The channel shape the adapter actually reads: an id plus the
 * raw provider category fields the index groups on. Production
 * callers pass full LivetvChannel objects; tests pass minimal
 * shapes. The index itself is built over the same objects
 * (cast at the boundary — the index stores references, never
 * copies, so derived results ARE the caller's objects).
 */
export interface GuideCategoryChannelLike {
  id: string | number;
  category?: unknown;
  categoryId?: unknown;
}

/** Pseudo-group ids, kept verbatim from the old category <select>. */
export const GUIDE_CATEGORY_ALL = "__all__";
export const GUIDE_CATEGORY_FAVOURITES = "__favorites__";
export const GUIDE_CATEGORY_RECENTS = "__recents__";

export type GuideCategoryValue =
  | { kind: "all" }
  | { kind: "favourites" }
  | { kind: "recents" }
  | { kind: "group"; groupId: string; subcategoryId: string | null };

export const GUIDE_CATEGORY_DEFAULT: GuideCategoryValue = { kind: "all" };

/** One picker row: a group (with its subcategories) or a pseudo-group. */
export interface GuideCategoryGroupView {
  id: string;
  label: string;
  channelCount: number;
  subcategories: Array<{ id: string; label: string; channelCount: number }>;
}

export interface GuideCategoryResolution<T> {
  /** Channels for the (validated) selection, in catalogue / recents order. */
  channels: T[];
  /** Groups for the category picker, pseudo-groups first. */
  groups: GuideCategoryGroupView[];
  /** The selection actually applied (stale selections validate to "all"). */
  selection: GuideCategoryValue;
  /** Trigger label for the current selection. */
  triggerLabel: string;
  /** The index this resolution was derived from. */
  index: CategoryIndex;
}

export interface GuideCategoryContext {
  /** Catalogue revision; bump whenever the channel array is re-read. */
  revision: number;
  /** Favourite channel ids (raw preference values). */
  favouriteIds: ReadonlySet<string | number>;
  /** Recent channel ids, most-recent-first. */
  recentIds: ReadonlyArray<string | number>;
}

// Single-entry index cache: one catalogue, one index.
let cachedRevision = -1;
let cachedChannels: readonly GuideCategoryChannelLike[] | null = null;
let cachedIndex: CategoryIndex | null = null;
/**
 * Sequence distinguishing index builds for the shared cache:
 * the shared cache is keyed by revision alone, and the caller's
 * numeric revision may repeat for a DIFFERENT channel array
 * (a re-read that forgot to bump, or two test fixtures). Every
 * adapter-cache miss therefore mints a fresh revision string,
 * so the shared cache can never serve another catalogue's
 * index. Repeat calls with the same array + revision hit this
 * adapter's cache and never reach the shared cache at all.
 */
let indexBuildSeq = 0;

function indexFor(
  channels: readonly GuideCategoryChannelLike[],
  revision: number,
): CategoryIndex {
  if (
    cachedIndex &&
    cachedRevision === revision &&
    cachedChannels === channels
  ) {
    return cachedIndex;
  }
  indexBuildSeq += 1;
  const index = getCategoryIndex(
    channels as readonly LivetvChannel[],
    `guide:${revision}:${indexBuildSeq}`,
  );
  cachedRevision = revision;
  cachedChannels = channels;
  cachedIndex = index;
  return index;
}

/** Validate a selection against the index; stale → "all". */
function validateSelection(
  selection: GuideCategoryValue,
  index: CategoryIndex,
): GuideCategoryValue {
  if (selection.kind !== "group") return selection;
  const group = index.groups.find((candidate) => candidate.id === selection.groupId);
  if (!group) return { kind: "all" };
  if (selection.subcategoryId === null) return selection;
  const sub = group.subcategories.find(
    (candidate) => candidate.id === selection.subcategoryId,
  );
  if (!sub) return { kind: "group", groupId: selection.groupId, subcategoryId: null };
  return selection;
}

function triggerLabelFor(
  selection: GuideCategoryValue,
  index: CategoryIndex,
): string {
  if (selection.kind === "all") return "All categories";
  if (selection.kind === "favourites") return "Favourites";
  if (selection.kind === "recents") return "Recently watched";
  const group = index.groups.find((candidate) => candidate.id === selection.groupId);
  if (!group) return "All categories";
  if (selection.subcategoryId === null) return group.label;
  const sub = group.subcategories.find(
    (candidate) => candidate.id === selection.subcategoryId,
  );
  return sub ? sub.label : group.label;
}

/**
 * THE adapter: resolve a Guide category selection to channels +
 * picker groups through the shared category index. Pure except for
 * the index cache (keyed by revision + array identity). Never
 * mutates the input channels.
 */
export function resolveGuideCategory<T extends GuideCategoryChannelLike>(
  channels: readonly T[],
  selection: GuideCategoryValue,
  context: GuideCategoryContext,
): GuideCategoryResolution<T> {
  const index = indexFor(channels, context.revision);
  const valid = validateSelection(selection, index);
  let resolved: T[];
  if (valid.kind === "all") {
    resolved = [...channels];
  } else if (valid.kind === "favourites") {
    const favs = new Set<string>();
    for (const id of context.favouriteIds) favs.add(String(id));
    resolved = channels.filter((channel) => favs.has(String(channel.id)));
  } else if (valid.kind === "recents") {
    const byId = new Map<string, T>();
    for (const channel of channels) byId.set(String(channel.id), channel);
    resolved = [];
    const seen = new Set<string>();
    for (const id of context.recentIds) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const channel = byId.get(key);
      if (channel) resolved.push(channel);
    }
  } else {
    const opts: DerivedChannelsOptions = { groupId: valid.groupId };
    if (valid.subcategoryId != null) {
      opts.subcategoryId = valid.subcategoryId;
    }
    // The index stores the caller's channel objects by
    // reference, so this cast recovers exactly the input type.
    resolved = getDerivedChannels(index, opts) as unknown as T[];
  }
  const favCount = (() => {
    const favs = new Set<string>();
    for (const id of context.favouriteIds) favs.add(String(id));
    return channels.filter((channel) => favs.has(String(channel.id))).length;
  })();
  const recentCount = (() => {
    const ids = new Set<string>();
    for (const channel of channels) ids.add(String(channel.id));
    const seen = new Set<string>();
    let count = 0;
    for (const id of context.recentIds) {
      const key = String(id);
      if (!seen.has(key) && ids.has(key)) {
        seen.add(key);
        count += 1;
      }
    }
    return count;
  })();
  const groups: GuideCategoryGroupView[] = [
    {
      id: GUIDE_CATEGORY_ALL,
      label: "All categories",
      channelCount: channels.length,
      subcategories: [],
    },
    {
      id: GUIDE_CATEGORY_FAVOURITES,
      label: "Favourites",
      channelCount: favCount,
      subcategories: [],
    },
    {
      id: GUIDE_CATEGORY_RECENTS,
      label: "Recently watched",
      channelCount: recentCount,
      subcategories: [],
    },
    ...index.groups.map((group) => ({
      id: group.id,
      label: group.label,
      channelCount: group.channelCount,
      subcategories: group.subcategories.map((sub) => ({
        id: sub.id,
        label: sub.label,
        channelCount: sub.channelCount,
      })),
    })),
  ];
  return {
    channels: resolved,
    groups,
    selection: valid,
    triggerLabel: triggerLabelFor(valid, index),
    index,
  };
}

/**
 * Map a drawer-contract selection ({groupId, subcategoryId}) onto a
 * GuideCategoryValue. Pseudo-group ids map to their kinds; a null
 * groupId means "all". Pure value mapping — touches no index.
 */
export function guideCategoryValueFromDrawer(
  groupId: string | null,
  subcategoryId: string | null,
): GuideCategoryValue {
  if (groupId === null || groupId === GUIDE_CATEGORY_ALL) return { kind: "all" };
  if (groupId === GUIDE_CATEGORY_FAVOURITES) return { kind: "favourites" };
  if (groupId === GUIDE_CATEGORY_RECENTS) return { kind: "recents" };
  return { kind: "group", groupId, subcategoryId };
}

/**
 * Map a GuideCategoryValue back onto drawer-contract ids (for the
 * picker's selectedGroupId / selectedSubcategoryId props).
 */
export function guideCategoryValueToDrawer(
  selection: GuideCategoryValue,
): { groupId: string | null; subcategoryId: string | null } {
  if (selection.kind === "all") return { groupId: null, subcategoryId: null };
  if (selection.kind === "favourites") {
    return { groupId: GUIDE_CATEGORY_FAVOURITES, subcategoryId: null };
  }
  if (selection.kind === "recents") {
    return { groupId: GUIDE_CATEGORY_RECENTS, subcategoryId: null };
  }
  return { groupId: selection.groupId, subcategoryId: selection.subcategoryId };
}

/** True when two selections name the same filter. */
export function sameGuideCategoryValue(
  a: GuideCategoryValue,
  b: GuideCategoryValue,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "group" && b.kind === "group") {
    return a.groupId === b.groupId && a.subcategoryId === b.subcategoryId;
  }
  return true;
}
