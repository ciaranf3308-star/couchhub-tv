// DELIBERATELY BROKEN — RED-VERIFICATION ONLY. DO NOT SHIP.
//
// Mirrors the category-index stub's API but reproduces the 0.11.5
// defect: grouping/filtering reruns on EVERY access (no caching).
// The red-verification tests assert this variant FAILS the work
// invariants, proving the green tests would catch a regression.
// Delete with the rest of tests/livetv0117/stubs on integration.

import type { LivetvChannel } from "@/scripts/lib/livetv-data";
import { normalize } from "@/scripts/lib/text";
import {
  splitProviderCategory,
  type CategoryIndex,
  type DerivedChannelsOptions,
} from "../category-index.stub";

let brokenBuildCount = 0;

export function getBrokenBuildCount(): number {
  return brokenBuildCount;
}

export function __resetBrokenCategoryIndexForTests(): void {
  brokenBuildCount = 0;
}

/** Rebuilds from scratch on every call — the defect under test. */
export function buildBrokenCategoryIndex(
  channels: readonly LivetvChannel[],
  revision: number,
): CategoryIndex {
  brokenBuildCount += 1;
  // Reuse the stub's grouping (correct grouping, broken caching):
  // grouping itself is not what's broken here, the re-running is.
  const groupsById = new Map<string, CategoryIndex["groups"][number]>();
  const subsById = new Map<string, CategoryIndex["subcategories"][number]>();
  const groups: CategoryIndex["groups"] = [];
  const subcategories: CategoryIndex["subcategories"] = [];
  const slugify = (label: string): string =>
    label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  for (const channel of channels) {
    const { groupLabel, subcategoryLabel } = splitProviderCategory(channel.categoryId);
    const groupId = slugify(groupLabel);
    let group = groupsById.get(groupId);
    if (!group) {
      group = { id: groupId, label: groupLabel, subcategoryIds: [], directChannelIds: [], count: 0 };
      groupsById.set(groupId, group);
      groups.push(group);
    }
    group.count += 1;
    if (subcategoryLabel === null) {
      group.directChannelIds.push(channel.id);
      continue;
    }
    let sub = subsById.get(channel.categoryId);
    if (!sub) {
      sub = { id: channel.categoryId, label: subcategoryLabel, groupId, channelIds: [], count: 0 };
      subsById.set(channel.categoryId, sub);
      subcategories.push(sub);
      group.subcategoryIds.push(channel.categoryId);
    }
    sub.channelIds.push(channel.id);
    sub.count += 1;
  }
  return {
    revision,
    totalChannels: channels.length,
    buildCount: brokenBuildCount,
    recomputeCount: 0,
    groups,
    subcategories,
    channels: [...channels],
  };
}

/** No cache: every access rebuilds (buildCount advances every call). */
export function getBrokenCategoryIndex(
  channels: readonly LivetvChannel[],
  revision: number,
): CategoryIndex {
  return buildBrokenCategoryIndex(channels, revision);
}

/** No derived cache: every call recomputes (recomputeCount advances). */
export function getBrokenDerivedChannels(
  index: CategoryIndex,
  opts: DerivedChannelsOptions = {},
): LivetvChannel[] {
  index.recomputeCount += 1;
  const byId = new Map<string, LivetvChannel>();
  for (const channel of index.channels) byId.set(String(channel.id), channel);
  let list: LivetvChannel[];
  if (opts.subcategoryId != null) {
    const sub = index.subcategories.find((s) => s.id === opts.subcategoryId);
    list = (sub?.channelIds ?? []).map((id) => byId.get(String(id))!).filter(Boolean);
  } else if (opts.groupId != null) {
    const group = index.groups.find((g) => g.id === opts.groupId);
    const ids = group
      ? [
          ...group.directChannelIds,
          ...group.subcategoryIds.flatMap(
            (subId) => index.subcategories.find((s) => s.id === subId)?.channelIds ?? [],
          ),
        ]
      : [];
    const order = new Map<string, number>();
    index.channels.forEach((channel, i) => order.set(String(channel.id), i));
    ids.sort((a, b) => (order.get(String(a)) ?? 0) - (order.get(String(b)) ?? 0));
    list = ids.map((id) => byId.get(String(id))!).filter(Boolean);
  } else {
    list = [...index.channels];
  }
  if (opts.favouritesOnly) list = list.filter((c) => c.favourite);
  const query = normalize(opts.query ?? "").trim();
  if (query) {
    const tokens = query.split(/\s+/).filter(Boolean);
    list = list.filter((c) => tokens.every((t) => c.norm.includes(t)));
  }
  if (opts.sort === "az") list = [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));
  else if (opts.sort === "za") list = [...list].sort((a, b) => b.displayName.localeCompare(a.displayName));
  return list;
}
