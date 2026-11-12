// STUB-FOR-INTEGRATION — DO NOT SHIP. DELETE ON INTEGRATION.
//
// Minimal implementation of the W1 category-index contract, kept
// ONLY under tests/ so W5's tests can run before W1's real module
// lands. It implements exactly the contracted surface and nothing
// more:
//
//   buildCategoryIndex(channels, revision)
//   getCategoryIndex(channels, revision)
//   getDerivedChannels(index, opts)
//   CategoryIndex.buildCount / recomputeCount counters
//
// INTEGRATION: delete this file. Point the tests at the real
// src/scripts/lib/livetv-category-index.ts. The real module MUST
// preserve these semantics (adapt names/wiring only, never weaken
// the assertions):
//   - identity is the VERBATIM raw provider category string;
//     subcategories are the raw categories themselves, never
//     invented or merged across regions;
//   - a category with no subcategory segments keeps its channels
//     as a flat, fully navigable group (no subcategory required);
//   - getCategoryIndex with the same array + revision returns the
//     SAME instance without rebuilding (buildCount does not move);
//   - getDerivedChannels caches per (index, options): identical
//     options return the same array without recomputing
//     (recomputeCount does not move) — scrolling must never
//     recompute;
//   - buildCount is the module-wide build sequence number: the
//     count of buildCategoryIndex calls so far, snapshotted onto
//     each index at build time. If W1 exposes the counter under a
//     different name, adapt the test accessor, not the assertion.
//   - recomputeCount is per-index and counts derived-list cache
//     misses only.

import type { LivetvChannel } from "@/scripts/lib/livetv-data";
import { normalize } from "@/scripts/lib/text";

export type DerivedSort = "source" | "az" | "za";

export interface DerivedChannelsOptions {
  /** Group slug, e.g. "sports". Omit for all groups. */
  groupId?: string | null;
  /** Verbatim raw provider category. Omit for the whole group. */
  subcategoryId?: string | null;
  /** Search query: every token must match the channel norm. */
  query?: string;
  sort?: DerivedSort;
  favouritesOnly?: boolean;
}

export interface CategoryIndexSubcategory {
  /** Verbatim raw provider category — the identity, never cleaned. */
  id: string;
  /** Display remainder after the group segment, verbatim. */
  label: string;
  groupId: string;
  channelIds: Array<string | number>;
  count: number;
}

export interface CategoryIndexGroup {
  id: string;
  label: string;
  /** Verbatim raw category ids under this group, first-seen order. */
  subcategoryIds: string[];
  /** Channels in raw categories with no subcategory segment. */
  directChannelIds: Array<string | number>;
  /** All channels in the group (subcategories + direct). */
  count: number;
}

export interface CategoryIndex {
  revision: number;
  totalChannels: number;
  /** Module-wide build sequence number at build time (see header). */
  buildCount: number;
  /** Derived-list cache misses on THIS index. Mutated by getDerivedChannels. */
  recomputeCount: number;
  groups: CategoryIndexGroup[];
  subcategories: CategoryIndexSubcategory[];
  /** Source-order channels this index was built from. */
  channels: readonly LivetvChannel[];
}

const REGION_PREFIX =
  /^(UK|GB|IE|IRL|USA|US|Ireland|United Kingdom|Great Britain|England|Scotland|Wales|Northern Ireland)$/i;

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "group";
}

/**
 * Split a raw provider category into its group + subcategory
 * remainder. Region prefixes ("UK | ...") are structural, not a
 * group; the first remaining segment is the group and the rest,
 * joined verbatim, is the subcategory. A single remaining segment
 * means NO subcategory (flat group). Empty raw → "Uncategorized".
 *
 * STUB-ONLY helper: W1's real parser is authoritative. Fixture raw
 * categories use only " | " separators, so both parsers must agree
 * on every fixture; if W1 parses additional separators, integration
 * adapts this helper's expectations, not the membership assertions
 * (which key on verbatim raw strings).
 */
export function splitProviderCategory(raw: string): {
  groupLabel: string;
  subcategoryLabel: string | null;
} {
  const segments = raw
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (segments.length === 0) {
    return { groupLabel: "Uncategorized", subcategoryLabel: null };
  }
  if (segments.length > 1 && REGION_PREFIX.test(segments[0]!)) {
    segments.shift();
  }
  const groupLabel = segments[0]!;
  const rest = segments.slice(1);
  return {
    groupLabel,
    subcategoryLabel: rest.length > 0 ? rest.join(" | ") : null,
  };
}

let moduleBuildCount = 0;

/** Module-wide build count (test accessor for the buildCount counter). */
export function getCategoryIndexBuildCount(): number {
  return moduleBuildCount;
}

let cached: {
  channels: readonly LivetvChannel[];
  revision: number;
  index: CategoryIndex;
  derivedCache: Map<string, LivetvChannel[]>;
} | null = null;

/** Test-only reset for the module cache/counters. Never used in production. */
export function __resetCategoryIndexCacheForTests(): void {
  cached = null;
  moduleBuildCount = 0;
}

export function buildCategoryIndex(
  channels: readonly LivetvChannel[],
  revision: number,
): CategoryIndex {
  moduleBuildCount += 1;
  const groupsById = new Map<string, CategoryIndexGroup>();
  const subsById = new Map<string, CategoryIndexSubcategory>();
  const groups: CategoryIndexGroup[] = [];
  const subcategories: CategoryIndexSubcategory[] = [];

  for (const channel of channels) {
    const { groupLabel, subcategoryLabel } = splitProviderCategory(channel.categoryId);
    const groupId = slugify(groupLabel);
    let group = groupsById.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        label: groupLabel,
        subcategoryIds: [],
        directChannelIds: [],
        count: 0,
      };
      groupsById.set(groupId, group);
      groups.push(group);
    }
    group.count += 1;
    if (subcategoryLabel === null) {
      group.directChannelIds.push(channel.id);
      continue;
    }
    // Identity is the verbatim raw category: two raw categories
    // with the same display remainder stay DISTINCT subcategories.
    const subId = channel.categoryId;
    let sub = subsById.get(subId);
    if (!sub) {
      sub = {
        id: subId,
        label: subcategoryLabel,
        groupId,
        channelIds: [],
        count: 0,
      };
      subsById.set(subId, sub);
      subcategories.push(sub);
      group.subcategoryIds.push(subId);
    }
    sub.channelIds.push(channel.id);
    sub.count += 1;
  }

  return {
    revision,
    totalChannels: channels.length,
    buildCount: moduleBuildCount,
    recomputeCount: 0,
    groups,
    subcategories,
    channels: [...channels],
  };
}

export function getCategoryIndex(
  channels: readonly LivetvChannel[],
  revision: number,
): CategoryIndex {
  if (cached && cached.channels === channels && cached.revision === revision) {
    return cached.index;
  }
  const index = buildCategoryIndex(channels, revision);
  cached = { channels, revision, index, derivedCache: new Map() };
  return index;
}

function derivedCacheKey(opts: DerivedChannelsOptions): string {
  return JSON.stringify({
    groupId: opts.groupId ?? null,
    subcategoryId: opts.subcategoryId ?? null,
    query: normalize(opts.query ?? "").trim(),
    sort: opts.sort ?? "source",
    favouritesOnly: opts.favouritesOnly ?? false,
  });
}

// Per-index lookups, built lazily once: an index owns its id →
// channel / id → source-order maps so a derivation never rescans
// the catalogue to resolve membership.
const indexLookups = new WeakMap<
  CategoryIndex,
  {
    byId: Map<string, LivetvChannel>;
    order: Map<string, number>;
    subById: Map<string, CategoryIndex["subcategories"][number]>;
  }
>();

function lookupsFor(index: CategoryIndex): {
  byId: Map<string, LivetvChannel>;
  order: Map<string, number>;
  subById: Map<string, CategoryIndex["subcategories"][number]>;
} {
  let lookups = indexLookups.get(index);
  if (!lookups) {
    const byId = new Map<string, LivetvChannel>();
    const order = new Map<string, number>();
    index.channels.forEach((channel, i) => {
      byId.set(String(channel.id), channel);
      order.set(String(channel.id), i);
    });
    const subById = new Map(index.subcategories.map((sub) => [sub.id, sub]));
    lookups = { byId, order, subById };
    indexLookups.set(index, lookups);
  }
  return lookups;
}

function findGroup(index: CategoryIndex, groupId: string): CategoryIndexGroup | undefined {
  return index.groups.find((group) => group.id === groupId);
}

/**
 * Derived channel list for a group / subcategory / query / sort.
 * Results are cached per (index, options): repeated calls with
 * identical options return the SAME array and do not advance
 * recomputeCount. Only a genuinely new option set recomputes.
 */
export function getDerivedChannels(
  index: CategoryIndex,
  opts: DerivedChannelsOptions = {},
): LivetvChannel[] {
  // The derived cache lives with the module cache entry when this
  // index came from getCategoryIndex; indexes built directly get a
  // per-index cache via a WeakMap so direct builds cache too.
  const cache = derivedCacheFor(index);
  const key = derivedCacheKey(opts);
  const hit = cache.get(key);
  if (hit) return hit;

  index.recomputeCount += 1;
  const { byId, order, subById } = lookupsFor(index);

  let ids: Array<string | number>;
  if (opts.subcategoryId != null) {
    const sub = subById.get(opts.subcategoryId);
    ids = sub ? [...sub.channelIds] : [];
  } else if (opts.groupId != null) {
    const group = findGroup(index, opts.groupId);
    if (!group) {
      ids = [];
    } else {
      ids = [...group.directChannelIds];
      for (const subId of group.subcategoryIds) {
        const sub = subById.get(subId);
        if (sub) ids.push(...sub.channelIds);
      }
      // Restore source order: group membership is a set, display
      // order is the catalogue's.
      ids.sort((a, b) => (order.get(String(a)) ?? 0) - (order.get(String(b)) ?? 0));
    }
  } else {
    ids = index.channels.map((channel) => channel.id);
  }

  let list = ids
    .map((id) => byId.get(String(id)))
    .filter((channel): channel is LivetvChannel => channel !== undefined);

  if (opts.favouritesOnly) {
    list = list.filter((channel) => channel.favourite);
  }
  const query = normalize(opts.query ?? "").trim();
  if (query) {
    const tokens = query.split(/\s+/).filter(Boolean);
    list = list.filter((channel) =>
      tokens.every((token) => channel.norm.includes(token)),
    );
  }
  if (opts.sort === "az") {
    list = [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));
  } else if (opts.sort === "za") {
    list = [...list].sort((a, b) => b.displayName.localeCompare(a.displayName));
  }
  cache.set(key, list);
  return list;
}

const directCaches = new WeakMap<CategoryIndex, Map<string, LivetvChannel[]>>();

function derivedCacheFor(index: CategoryIndex): Map<string, LivetvChannel[]> {
  if (cached && cached.index === index) return cached.derivedCache;
  let cache = directCaches.get(index);
  if (!cache) {
    cache = new Map();
    directCaches.set(index, cache);
  }
  return cache;
}

/** Pure window slice for scroll simulation: never touches counters. */
export function sliceDerivedWindow(
  derived: readonly LivetvChannel[],
  startIndex: number,
  count: number,
): LivetvChannel[] {
  const start = Math.max(0, Math.min(derived.length, Math.floor(startIndex)));
  return derived.slice(start, start + Math.max(0, count));
}
