// RedSilk Couch — Live TV category index (0.11.7 W1, canonical owner).
//
// ONE shared category index for Live TV Landing, the Channel
// Browser and the Guide. It replaces the two confirmed 0.11.5
// defects:
//
//   (A) groupChannels() collapsed anything matching /sport/ into
//       one Sports bucket, destroying useful provider structure
//       ("Sports Football", "Sports F1", "UK | Sports" became
//       indistinguishable).
//   (B) The browser recalculated groupChannels() on every render /
//       scroll / focus move, re-filtering thousands of channels.
//
// The index is built ONCE per catalogue revision and cached; the
// derived (filtered/sorted) lists are memoised and recomputed
// only when the selection changes. Scrolling and focus movement
// reuse the existing derived list and never touch grouping.
//
// ── Hierarchy ────────────────────────────────────────────────────
//   top-level group → provider subcategory → channels
//
// A subcategory is ONE raw provider category, kept verbatim: the
// raw string is the identity (rawName), the display label is the
// cleaned form (normaliseCategoryLabel). Every raw provider
// category survives as a subcategory of exactly one group, and no
// channel is lost or duplicated across ordinary provider
// categories. (A channel may additionally appear in All Channels /
// Favourites views — those are separate selections over the same
// index, not extra membership.)
//
// ── Grouping rule (conservative, documented) ─────────────────────
// A subcategory is assigned to exactly one group, in this order:
//
//   1. GENRE: the normalised label matches a genre keyword rule
//      (first match wins, in the order below). The genre decides
//      the GROUP only — distinct raw categories stay distinct
//      subcategories inside it, so "UK | Sports", "Sports FHD"
//      and "Sports Football" are three subcategories of Sports,
//      never one merged bucket.
//        entertainment: entertainment|general|variety|lifestyle|
//          reality|comedy|talk|shows?
//        sports:        sport
//        news:          news
//        movies:        movi|film|cinema
//        documentaries: documentar|docu|nature|history|science|
//          wildlife
//        kids:          kid|children|cartoon|animation|family|
//          junior
//        music:         music
//   2. REGION: no genre match, and the RAW category names Ireland
//      / the UK (LOCAL_REGION_RE — the literal provider string,
//      never an inference about a channel) → "Irish & UK". This
//      covers pure region buckets ("UK", "Ireland", "UK Channels").
//      A genre match always wins over region, so "UK | Sports" is
//      Sports (it is still local for ordering purposes — see
//      isLocalChannel).
//   3. PROVIDER FALLBACK: anything else forms (or joins) a group
//      named by its normalised label, id `provider:<slug>`. All
//      raw categories sharing one normalised label share the
//      group as separate subcategories; unknown provider naming
//      is never discarded and never renamed into a genre.
//   4. UNCATEGORISED: a channel with no (or blank) raw category
//      lands in index.uncategorised, which is also the single
//      subcategory of the trailing "Uncategorized" group when it
//      is non-empty. Uncategorised channels are always reachable.
//
// If a provider supplies one enormous Sports category, the index
// represents it faithfully as ONE subcategory of Sports —
// subcategories are never invented. The browser handles a huge
// subcategory with search / sort / fast-jump, not by splitting
// what the provider did not split. Country / league membership is
// never inferred: only the literal provider category string is
// read, and only for rules 1–2 above.
//
// Group order is fixed: Irish & UK, Entertainment, Sports, News,
// Movies, Documentaries, Kids, Music, then provider groups in
// first-seen order, then Uncategorized. Subcategories keep
// first-seen (provider) order inside their group, and channels
// keep provider order inside their subcategory.
//
// Group ids are stable for a given catalogue: the genre / region
// ids above, `provider:<slug>` for fallback groups, and
// "uncategorised". Subcategory ids are `sub:<slug-of-raw-name>`,
// disambiguated with a -2, -3, … suffix in first-seen order when
// distinct raw names slug-collide; the bare `sub:uncategorised`
// id is reserved for the uncategorised subcategory so real
// categories never take it.
//
// ── Caching contract ─────────────────────────────────────────────
//   - buildCategoryIndex(channels, revision) always builds.
//   - getCategoryIndex(channels, revision) returns the cached
//     index when the revision is unchanged, and rebuilds only
//     when it changes. Callers MUST bump the revision whenever
//     the catalogue content changes (new load, favourites /
//     recents refresh that re-maps channels); the same revision
//     means the same catalogue.
//   - getDerivedChannels(index, opts) memoises per index: the
//     same opts on the same index return the SAME array
//     reference. Recompute happens only when the opts change
//     (group, subcategory, search, search scope, sort,
//     favourites-only) or the index is a new revision. Favourite
//     flags mutated in place (an in-session star toggle) do NOT
//     invalidate the memo — call invalidateDerivedChannels() (or
//     bump the revision) after toggling.
//   - Counters for tests: categoryIndexBuildCount() and
//     derivedListRecomputeCount(), reset with
//     resetCategoryIndexCounters(). The build count is also
//     stamped on each index as `buildCount`.
//   - Generation guards (createGenerationGuard) let async
//     consumers (category switches, search) drop stale work: take
//     a generation with next(), and after awaiting, proceed only
//     when isCurrent(generation) is still true.
//
// This module is dependency-light on purpose: it imports only the
// LivetvChannel TYPE from livetv-data (erased at compile time —
// no runtime import cycle) and the shared `normalize` helper.
// normaliseCategoryLabel / isLocalChannel live here because they
// ARE the category rule; livetv-data re-exports them so every
// existing importer keeps working.
import { normalize } from "./text";
import type { LivetvChannel } from "./livetv-data";

// ── Category labels (canonical rule, moved from livetv-data) ─────

/**
 * Display label for a raw provider category. Strips what is noise
 * for a human label — a leading country/region prefix ("UK | ",
 * "IE - ", "Sports (UK)"), resolution / quality tags (FHD, HD, 4K,
 * 1080p) and redundant punctuation — and collapses whitespace.
 * The raw value stays the identity (categoryId); only the label is
 * cleaned. "" / missing → "Uncategorized".
 */
export function normaliseCategoryLabel(raw: unknown): string {
  if (typeof raw !== "string") return "Uncategorized";
  let label = raw.trim();
  // Leading region prefix: "UK | Sports", "IE - News", "Ireland: Movies".
  label = label.replace(
    /^(?:UK|GB|IE|IRL|USA|US|Ireland|United Kingdom|Great Britain|England|Scotland|Wales|Northern Ireland)\s*[-–—|:]\s*/i,
    "",
  );
  // Trailing region in parens: "Sports (UK)".
  label = label.replace(
    /\s*\((?:UK|GB|IE|IRL|USA|US|Ireland|United Kingdom|England|Scotland|Wales)\)\s*$/i,
    "",
  );
  // Resolution / quality tags.
  label = label.replace(/\b(?:FHD|UHD|4K|HD|SD|HEVC|H\.?265|1080p|720p|2160p)\b/gi, "");
  // Redundant separators / punctuation, then whitespace.
  label = label.replace(/[-–—_|:/]+/g, " ");
  label = label.replace(/\s{2,}/g, " ").trim();
  label = label.replace(/^[.,\s]+|[.,\s]+$/g, "");
  return label || "Uncategorized";
}

/** True when the channel's provider category names Ireland / the UK. */
const LOCAL_REGION_RE =
  /\b(?:UK|GB|IE|IRL|Ireland|United Kingdom|Great Britain|England|Scotland|Wales|Northern Ireland|British|Irish|RT[EÉ]|TG4)\b/i;

export function isLocalChannel(channel: LivetvChannel): boolean {
  return LOCAL_REGION_RE.test(channel.categoryId || "");
}

// ── Shapes ───────────────────────────────────────────────────────

export interface ProviderSubcategory {
  /** Stable id: `sub:<slug-of-raw-name>`, disambiguated on slug collision. */
  id: string;
  /** Display label: normaliseCategoryLabel(rawName). */
  label: string;
  /** Raw provider category, kept verbatim — the identity. "" for uncategorised. */
  rawName: string;
  /** Channel ids (String-compared) in provider order. */
  channelIds: string[];
  channelCount: number;
}

export interface CategoryGroup {
  /** Stable id: a genre id, "irish-uk", `provider:<slug>`, or "uncategorised". */
  id: string;
  label: string;
  /** Raw provider category names in this group, in subcategory order. */
  rawNames: string[];
  subcategories: ProviderSubcategory[];
  channelCount: number;
}

/** Catalogue revision: bump whenever the channel set changes. */
export type CategoryIndexRevision = string | number;

export interface CategoryIndex {
  revision: CategoryIndexRevision;
  groups: CategoryGroup[];
  /**
   * The uncategorised subcategory. When non-empty it is the SAME
   * object as the single subcategory of the trailing
   * "Uncategorized" group; when empty it is a standalone empty
   * subcategory present so consumers never null-check.
   */
  uncategorised: ProviderSubcategory;
  /** Channel lookup by String(id); first occurrence wins. Insertion order is provider order. */
  byId: Map<string, LivetvChannel>;
  /** Cumulative build counter value at the time this index was built. */
  buildCount: number;
}

export type DerivedSort = "provider" | "az" | "za" | "category";
export type DerivedSearchScope = "category" | "all";

export interface DerivedChannelsOptions {
  /** Top-level group id. Ignored when searchScope is "all" and a search is present. */
  groupId?: string;
  /** Provider subcategory id. When given with a groupId from another group, the result is empty. */
  subcategoryId?: string;
  /** Search query; token-AND over the cached normalised haystacks (see below). */
  search?: string;
  /** "category" (default): search within the selected group/subcategory. "all": search the whole catalogue. */
  searchScope?: DerivedSearchScope;
  /** "provider" (default): catalogue order. "az"/"za": by display name. "category": by category label, then name. */
  sort?: DerivedSort;
  /** Keep favourite-flagged channels only. */
  favouritesOnly?: boolean;
}

// ── Grouping rule ────────────────────────────────────────────────

interface GenreGroupDef {
  id: string;
  label: string;
  /** Regex over the NORMALISED label (lowercased). First match wins. */
  match: RegExp;
}

const GENRE_GROUP_DEFS: GenreGroupDef[] = [
  { id: "entertainment", label: "Entertainment", match: /entertainment|general|variety|lifestyle|reality|comedy|talk|shows?/ },
  { id: "sports", label: "Sports", match: /sport/ },
  { id: "news", label: "News", match: /news/ },
  { id: "movies", label: "Movies", match: /movi|film|cinema/ },
  { id: "documentaries", label: "Documentaries", match: /documentar|docu|nature|history|science|wildlife/ },
  { id: "kids", label: "Kids", match: /kid|children|cartoon|animation|family|junior/ },
  { id: "music", label: "Music", match: /music/ },
];

export const LIVETV_IRISH_UK_GROUP_ID = "irish-uk";
export const LIVETV_IRISH_UK_GROUP_LABEL = "Irish & UK";
export const LIVETV_UNCATEGORISED_GROUP_ID = "uncategorised";
export const LIVETV_UNCATEGORISED_LABEL = "Uncategorized";
export const LIVETV_UNCATEGORISED_SUBCATEGORY_ID = "sub:uncategorised";

/** Directive order for the genre / region groups; provider groups follow in first-seen order. */
const GROUP_ORDER = [
  LIVETV_IRISH_UK_GROUP_ID,
  ...GENRE_GROUP_DEFS.map((d) => d.id),
];

function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "group";
}

/**
 * The group a raw provider category belongs to: genre match on
 * the normalised label, else the Irish & UK region bucket for raw
 * categories that literally name Ireland / the UK, else a
 * provider group named by the normalised label. Pure and total —
 * every raw name maps to exactly one group.
 */
export function groupForRawCategory(
  rawName: string,
): { id: string; label: string } {
  const label = normaliseCategoryLabel(rawName);
  const labelLower = label.toLowerCase();
  const def = GENRE_GROUP_DEFS.find((d) => d.match.test(labelLower));
  if (def) return { id: def.id, label: def.label };
  if (LOCAL_REGION_RE.test(rawName)) {
    return { id: LIVETV_IRISH_UK_GROUP_ID, label: LIVETV_IRISH_UK_GROUP_LABEL };
  }
  return { id: `provider:${slugifyLabel(label)}`, label };
}

/** Raw provider category for a channel: the verbatim identity, never the display label. */
function rawCategoryOf(channel: LivetvChannel): string {
  const raw = channel.categoryId ?? channel.category ?? "";
  return typeof raw === "string" ? raw : "";
}

// ── Counters (for tests / W5 work-count checks) ──────────────────

let indexBuildCount = 0;
let derivedRecomputeCount = 0;

/** Cumulative number of index builds performed by this module. */
export function categoryIndexBuildCount(): number {
  return indexBuildCount;
}

/** Cumulative number of derived-list recomputes (cache misses in getDerivedChannels). */
export function derivedListRecomputeCount(): number {
  return derivedRecomputeCount;
}

/** Reset both counters (test isolation). Does not clear caches. */
export function resetCategoryIndexCounters(): void {
  indexBuildCount = 0;
  derivedRecomputeCount = 0;
}

// ── Index build ──────────────────────────────────────────────────

/**
 * Build the category index in a single pass over the channels.
 * Always builds — callers that want caching use getCategoryIndex.
 * Channels keep provider order inside their subcategory;
 * subcategories keep first-seen order inside their group.
 */
export function buildCategoryIndex(
  channels: readonly LivetvChannel[],
  revision: CategoryIndexRevision,
): CategoryIndex {
  indexBuildCount += 1;

  const byId = new Map<string, LivetvChannel>();
  const groupsById = new Map<string, CategoryGroup>();
  const groupOrder: CategoryGroup[] = [];
  const subByRawName = new Map<string, ProviderSubcategory>();
  const usedSubIds = new Set<string>([LIVETV_UNCATEGORISED_SUBCATEGORY_ID]);

  const uncategorised: ProviderSubcategory = {
    id: LIVETV_UNCATEGORISED_SUBCATEGORY_ID,
    label: LIVETV_UNCATEGORISED_LABEL,
    rawName: "",
    channelIds: [],
    channelCount: 0,
  };

  const ensureGroup = (id: string, label: string): CategoryGroup => {
    let group = groupsById.get(id);
    if (!group) {
      group = { id, label, rawNames: [], subcategories: [], channelCount: 0 };
      groupsById.set(id, group);
      groupOrder.push(group);
    }
    return group;
  };

  /** Stable subcategory id; distinct raw names that slug-collide get -2, -3, … in first-seen order. */
  const allocateSubId = (rawName: string): string => {
    const base = `sub:${slugifyLabel(rawName)}`;
    if (!usedSubIds.has(base)) {
      usedSubIds.add(base);
      return base;
    }
    let n = 2;
    while (usedSubIds.has(`${base}-${n}`)) n += 1;
    const id = `${base}-${n}`;
    usedSubIds.add(id);
    return id;
  };

  for (const channel of channels) {
    const key = String(channel.id);
    if (!byId.has(key)) byId.set(key, channel);

    const rawName = rawCategoryOf(channel);
    if (!rawName.trim()) {
      uncategorised.channelIds.push(key);
      continue;
    }

    let sub = subByRawName.get(rawName);
    if (!sub) {
      sub = {
        id: allocateSubId(rawName),
        label: normaliseCategoryLabel(rawName),
        rawName,
        channelIds: [],
        channelCount: 0,
      };
      subByRawName.set(rawName, sub);
      const { id, label } = groupForRawCategory(rawName);
      const group = ensureGroup(id, label);
      group.subcategories.push(sub);
      group.rawNames.push(rawName);
    }
    sub.channelIds.push(key);
  }

  // Counts + the uncategorised group (only when non-empty; the
  // subcategory object is shared with index.uncategorised).
  for (const group of groupOrder) {
    for (const sub of group.subcategories) sub.channelCount = sub.channelIds.length;
    group.channelCount = group.subcategories.reduce((n, s) => n + s.channelCount, 0);
  }
  uncategorised.channelCount = uncategorised.channelIds.length;
  if (uncategorised.channelCount > 0) {
    const group = ensureGroup(LIVETV_UNCATEGORISED_GROUP_ID, LIVETV_UNCATEGORISED_LABEL);
    group.subcategories.push(uncategorised);
    group.rawNames.push("");
    group.channelCount = uncategorised.channelCount;
  }

  // Directive order for genre/region groups, provider groups in
  // first-seen order, Uncategorized last. Array.prototype.sort is
  // stable, so equal keys keep first-seen order.
  const groups = groupOrder
    .filter((g) => g.channelCount > 0)
    .sort((a, b) => {
      if (a.id === LIVETV_UNCATEGORISED_GROUP_ID) return 1;
      if (b.id === LIVETV_UNCATEGORISED_GROUP_ID) return -1;
      const ai = GROUP_ORDER.indexOf(a.id);
      const bi = GROUP_ORDER.indexOf(b.id);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0;
    });

  const index: CategoryIndex = {
    revision,
    groups,
    uncategorised,
    byId,
    buildCount: indexBuildCount,
  };
  // Cache the normalised search fields once per index: the
  // channel's precomputed `norm` haystack when present, else a
  // haystack normalised here once (name + category label + tvgId)
  // so search never re-normalises per keystroke or per call.
  searchFieldsByIndex.set(index, buildSearchFields(channels));
  subcategoryLookupByIndex.set(index, buildSubcategoryLookup(index));
  return index;
}

/** Normalised search haystacks, cached once per index (id → haystack). */
const searchFieldsByIndex = new WeakMap<CategoryIndex, Map<string, string>>();

function buildSearchFields(
  channels: readonly LivetvChannel[],
): Map<string, string> {
  const fields = new Map<string, string>();
  for (const channel of channels) {
    const key = String(channel.id);
    if (fields.has(key)) continue;
    fields.set(
      key,
      channel.norm ||
        normalize(
          `${channel.displayName || channel.name} ${channel.categoryLabel || ""} ${channel.tvgId ?? ""}`,
        ),
    );
  }
  return fields;
}

/** Subcategory lookup, cached once per index (subcategory id → { subcategory, groupId }). */
const subcategoryLookupByIndex = new WeakMap<
  CategoryIndex,
  Map<string, { subcategory: ProviderSubcategory; groupId: string }>
>();

function buildSubcategoryLookup(
  index: CategoryIndex,
): Map<string, { subcategory: ProviderSubcategory; groupId: string }> {
  const lookup = new Map<string, { subcategory: ProviderSubcategory; groupId: string }>();
  for (const group of index.groups) {
    for (const sub of group.subcategories) {
      lookup.set(sub.id, { subcategory: sub, groupId: group.id });
    }
  }
  if (!lookup.has(index.uncategorised.id)) {
    lookup.set(index.uncategorised.id, {
      subcategory: index.uncategorised,
      groupId: LIVETV_UNCATEGORISED_GROUP_ID,
    });
  }
  return lookup;
}

// ── Cached index ─────────────────────────────────────────────────

let cachedIndex: CategoryIndex | null = null;
let cachedRevision: CategoryIndexRevision | null = null;
let cachedHasRevision = false;

/**
 * The shared index for a catalogue revision: rebuilt only when
 * the revision changes. Callers MUST bump the revision whenever
 * the catalogue content changes — the same revision means the
 * same catalogue, and a stale revision returns a stale index.
 */
export function getCategoryIndex(
  channels: readonly LivetvChannel[],
  revision: CategoryIndexRevision,
): CategoryIndex {
  if (cachedHasRevision && cachedIndex && cachedRevision === revision) {
    return cachedIndex;
  }
  cachedIndex = buildCategoryIndex(channels, revision);
  cachedRevision = revision;
  cachedHasRevision = true;
  return cachedIndex;
}

/** Drop the cached index (tests / playlist switches that reuse a revision value). */
export function resetCategoryIndexCache(): void {
  cachedIndex = null;
  cachedRevision = null;
  cachedHasRevision = false;
}

// ── Derived channel lists (memoised) ─────────────────────────────

interface DerivedCacheEntry {
  epoch: number;
  lists: Map<string, LivetvChannel[]>;
}

const derivedCacheByIndex = new WeakMap<CategoryIndex, DerivedCacheEntry>();
let derivedCacheEpoch = 0;

/**
 * Invalidate memoised derived lists: every index when called with
 * no argument, or just the given index. Call after in-session
 * favourite toggles that mutate channel flags in place, or after
 * any change that is not already a new catalogue revision.
 */
export function invalidateDerivedChannels(index?: CategoryIndex): void {
  if (index) {
    derivedCacheByIndex.delete(index);
    return;
  }
  derivedCacheEpoch += 1;
}

/** Max memoised derived lists kept per index (LRU-ish eviction by insertion order). */
const DERIVED_CACHE_MAX_ENTRIES = 16;

function derivedCacheKey(opts: DerivedChannelsOptions): string {
  return JSON.stringify([
    opts.groupId ?? null,
    opts.subcategoryId ?? null,
    opts.search ?? "",
    opts.searchScope ?? "category",
    opts.sort ?? "provider",
    opts.favouritesOnly === true,
  ]);
}

function numericTokenMatches(channel: LivetvChannel, token: string): boolean {
  const idText = String(channel.id);
  if (idText === token || idText.startsWith(token)) return true;
  if (channel.chno != null) {
    const chnoText = String(channel.chno);
    if (chnoText === token || chnoText.startsWith(token)) return true;
  }
  return false;
}

/**
 * Search over the index's cached haystacks: every token must
 * match; a digits-only token also matches channel number / id
 * exactly or by prefix (mirrors searchChannels in livetv-data).
 * The query is normalised with the shared `normalize` — callers
 * that strip redundant provider prefixes (the browser's
 * normalizeBrowserQuery) pass the already-cleaned query.
 */
function applyDerivedSearch(
  list: LivetvChannel[],
  search: string,
  fields: Map<string, string>,
): LivetvChannel[] {
  const q = normalize(search ?? "").trim();
  if (!q) return list;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return list;
  return list.filter((channel) =>
    tokens.every((token) =>
      /^\d+$/.test(token)
        ? numericTokenMatches(channel, token) ||
          (fields.get(String(channel.id)) ?? "").includes(token)
        : (fields.get(String(channel.id)) ?? "").includes(token),
    ),
  );
}

function sortDerived(list: LivetvChannel[], sort: DerivedSort): LivetvChannel[] {
  switch (sort) {
    case "az":
      return [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));
    case "za":
      return [...list].sort((a, b) => b.displayName.localeCompare(a.displayName));
    case "category":
      return [...list].sort(
        (a, b) =>
          a.categoryLabel.localeCompare(b.categoryLabel) ||
          a.displayName.localeCompare(b.displayName),
      );
    case "provider":
    default:
      return list;
  }
}

/**
 * The visible channel list for a selection, memoised per index.
 * The same opts on the same index return the SAME array
 * reference — scrolling and focus movement reuse it; recompute
 * happens only when the selection or the index changes. The
 * returned array must be treated as read-only by callers.
 *
 * Scope resolution: a subcategory id selects that subcategory
 * (and an accompanying group id from another group yields []);
 * a group id selects the whole group in subcategory order; no
 * selection selects the whole catalogue in provider order
 * (including uncategorised channels). With searchScope "all", a
 * search ignores the group/subcategory selection and searches
 * the whole catalogue; favouritesOnly still applies.
 */
export function getDerivedChannels(
  index: CategoryIndex,
  opts: DerivedChannelsOptions = {},
): LivetvChannel[] {
  let entry = derivedCacheByIndex.get(index);
  if (!entry || entry.epoch !== derivedCacheEpoch) {
    entry = { epoch: derivedCacheEpoch, lists: new Map() };
    derivedCacheByIndex.set(index, entry);
  }
  const key = derivedCacheKey(opts);
  const hit = entry.lists.get(key);
  if (hit) return hit;

  derivedRecomputeCount += 1;

  const fields = searchFieldsByIndex.get(index) ?? new Map<string, string>();
  const hasSearch = (opts.search ?? "").trim() !== "";
  const searchAll = hasSearch && opts.searchScope === "all";

  let list: LivetvChannel[];
  if (!searchAll && opts.subcategoryId) {
    const found = subcategoryLookupByIndex.get(index)?.get(opts.subcategoryId);
    if (!found || (opts.groupId && found.groupId !== opts.groupId)) {
      list = [];
    } else {
      list = idsToChannels(index, found.subcategory.channelIds);
    }
  } else if (!searchAll && opts.groupId) {
    const group = index.groups.find((g) => g.id === opts.groupId);
    if (!group) {
      list = [];
    } else {
      list = [];
      for (const sub of group.subcategories) {
        list.push(...idsToChannels(index, sub.channelIds));
      }
    }
  } else {
    // Whole catalogue in provider order (byId insertion order),
    // including uncategorised channels.
    list = [...index.byId.values()];
  }

  if (opts.favouritesOnly === true) {
    list = list.filter((channel) => channel.favourite);
  }
  if (hasSearch) {
    list = applyDerivedSearch(list, opts.search ?? "", fields);
  }
  list = sortDerived(list, opts.sort ?? "provider");

  if (entry.lists.size >= DERIVED_CACHE_MAX_ENTRIES) {
    const oldest = entry.lists.keys().next().value;
    if (oldest !== undefined) entry.lists.delete(oldest);
  }
  entry.lists.set(key, list);
  return list;
}

function idsToChannels(index: CategoryIndex, ids: readonly string[]): LivetvChannel[] {
  const out: LivetvChannel[] = [];
  for (const id of ids) {
    const channel = index.byId.get(id);
    if (channel) out.push(channel);
  }
  return out;
}

// ── Visible index (channel id → position in a derived list) ──────

const visibleIndexByList = new WeakMap<readonly LivetvChannel[], Map<string, number>>();

/**
 * Channel-id → visible-index lookup for a derived list, cached
 * per list identity. Lets scroll / focus restoration find a
 * channel's position without scanning the list.
 */
export function getVisibleIndex(
  list: readonly LivetvChannel[],
): Map<string, number> {
  let cached = visibleIndexByList.get(list);
  if (!cached) {
    cached = new Map<string, number>();
    for (const [i, channel] of list.entries()) {
      const key = String(channel.id);
      if (!cached.has(key)) cached.set(key, i);
    }
    visibleIndexByList.set(list, cached);
  }
  return cached;
}

// ── Generation / cancellation guards ─────────────────────────────

export interface GenerationGuard {
  /** Current generation; increases on every next() / cancel(). */
  readonly generation: number;
  /** Advance to a new generation and return it. Call when starting new async work. */
  next(): number;
  /** True when `generation` is still the current one (no newer work started, no cancel). */
  isCurrent(generation: number): boolean;
  /** Invalidate all outstanding generations without starting new work. */
  cancel(): void;
}

/**
 * Guard against stale async work overwriting the current
 * selection: rapid category changes, fast scrolling and search
 * updates each take a generation before awaiting, and drop their
 * result when a newer generation has started.
 *
 *   const guard = createGenerationGuard();
 *   async function onCategoryChange(id: string) {
 *     const gen = guard.next();
 *     const list = await loadSomething(id);
 *     if (!guard.isCurrent(gen)) return; // superseded — drop it
 *     show(list);
 *   }
 */
export function createGenerationGuard(): GenerationGuard {
  let current = 0;
  return {
    get generation() {
      return current;
    },
    next() {
      current += 1;
      return current;
    },
    isCurrent(generation: number) {
      return generation === current;
    },
    cancel() {
      current += 1;
    },
  };
}
