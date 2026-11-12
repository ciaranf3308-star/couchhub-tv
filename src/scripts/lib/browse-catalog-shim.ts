// 0.11.8 SHIM — W1 contract, deleted at integration.
//
// THIS FILE IS A SHIM. It implements the W1 API surface minimally
// so the W2 browse branch builds, runs and tests against the REAL
// contract semantics documented here. Integration DELETES this
// file and wires the real W1 modules; every export below maps to
// exactly one real module (see the mapping at the end of this
// header). NEVER ship this file as real behaviour: its genre
// families, grouping and rating rules are approximations over the
// bulk rows only — W1's modules add the full evidence rules,
// language groups, collection selectors and sorted indexes.
//
// Shim semantics (what the real modules MUST preserve):
//   - getCatalogIndex builds ONCE per revision and caches; the
//     same revision returns the SAME index object (Live TV
//     category-index caching contract, livetv-category-index.ts).
//   - groupEntries groups by normalised title + release year;
//     grouping affects display counts but NEVER hides variants:
//     every group exposes all its entries, and the catalogue
//     total counts entries while the browse count counts groups.
//   - normaliseRating returns null for missing/unparseable
//     ratings; unknown ratings NEVER pass a minimum filter.
//   - searchCatalogIndex is token-AND over a normalised haystack
//     (title + alternative titles + category + year), with
//     punctuation/spacing normalised; results are relevance
//     ordered, never alphabetical.
//   - Collection selectors are pure set-membership over
//     caller-supplied id sets; an empty set yields an empty
//     selection, never invented titles.
//   - Sorted indexes are precomputed ONCE at index build;
//     getSortedGroupIds never re-sorts 50k arrays.
//
// ── Real-module mapping (integration deletes this file) ──────────
//   getCatalogIndex / CatalogIndex / CatalogEntry / TitleGroup
//       → src/scripts/lib/catalog-index.ts (W1)
//   searchCatalogIndex
//       → src/scripts/lib/catalog-index.ts (W1)
//   CANONICAL_MOVIE_GENRES / CANONICAL_SERIES_GENRES / genresForEntry
//       → src/scripts/lib/genres.ts + genre-index.ts (W1 owns the
//         18 movie genres / 15 series families; this shim derives
//         both from the existing CANONICAL_GENRES + parseGenreString)
//   UNCATEGORISED_ID → src/scripts/lib/catalog-index.ts (W1)
//   groupEntries → src/scripts/lib/catalog-index.ts (W1 grouping)
//   normaliseRating / compareByRatingEvidence
//       → src/scripts/lib/rating-evidence.ts (W1)
//   selectRecentlyAdded / selectHighestRated / selectUnwatched /
//   selectContinueWatching / selectFavourites / selectWatchLater /
//   selectFollowed / selectNewEpisodes
//       → src/scripts/lib/collection-selectors.ts (W1)
//   getSortedGroupIds / sorted indexes
//       → src/scripts/lib/catalog-index.ts (W1 sorted ID indexes)

import {
  CANONICAL_GENRES,
  parseGenreString,
  type GenreId,
} from "@/scripts/lib/genres.ts";
import { stripProviderAffixes } from "@/scripts/lib/browse-search.ts";
import { normalize, scoreNormMatch } from "@/scripts/lib/text.ts";
import type { BrowseKind, BrowseSortId } from "@/scripts/lib/browse-state.ts";

export const UNCATEGORISED_ID = "uncategorised";

/** Minimal structural shape of a catalogue row (MovieRow / SeriesRow both fit). */
export interface CatalogEntry {
  id: number | string;
  name: string;
  year?: string | number | null;
  rating?: string | number | null;
  duration?: string | number | null;
  category?: string | null;
  genre?: string | null;
  genres?: string | string[] | null;
  plot?: string | null;
  added?: number | null;
  updated?: number | null;
  logo?: string | null;
  tmdb?: number | string | null;
  language?: string | null;
  languages?: string[] | null;
  altTitles?: string[] | null;
  status?: string | null;
  /** Raw row passthrough (the adapter's row object). */
  raw?: unknown;
}

export interface CanonicalGenreDef {
  id: string;
  label: string;
}

const GENRE_LABELS: Record<string, string> = {
  action: "Action",
  adventure: "Adventure",
  animation: "Animation",
  comedy: "Comedy",
  crime: "Crime",
  documentary: "Documentary",
  drama: "Drama",
  family: "Family",
  fantasy: "Fantasy",
  history: "History",
  horror: "Horror",
  music: "Music",
  mystery: "Mystery",
  romance: "Romance",
  "sci-fi": "Science Fiction",
  thriller: "Thriller",
  war: "War",
  western: "Western",
};

/** 18 canonical movie genres (brief §7.1), in drawer display order. */
export const CANONICAL_MOVIE_GENRES: CanonicalGenreDef[] = CANONICAL_GENRES.map(
  (g) => ({ id: g.id, label: GENRE_LABELS[g.id] ?? g.id }),
);

// SHIM approximation of the 15 series families (brief §7.1): the
// 18 canonical genres minus history/music/war, which series
// catalogues rarely carry as families. W1 OWNS the real family
// list — integration replaces this constant outright.
const SERIES_FAMILY_IDS: GenreId[] = [
  "action",
  "adventure",
  "animation",
  "comedy",
  "crime",
  "documentary",
  "drama",
  "family",
  "fantasy",
  "horror",
  "mystery",
  "romance",
  "sci-fi",
  "thriller",
  "western",
];

/** 15 canonical series genre families (brief §7.1). SHIM list — see header. */
export const CANONICAL_SERIES_GENRES: CanonicalGenreDef[] =
  SERIES_FAMILY_IDS.map((id) => ({ id, label: GENRE_LABELS[id] ?? id }));

export function canonicalGenresForKind(kind: BrowseKind): CanonicalGenreDef[] {
  return kind === "movie" ? CANONICAL_MOVIE_GENRES : CANONICAL_SERIES_GENRES;
}

export function genreLabelForKind(kind: BrowseKind, id: string): string {
  return (
    canonicalGenresForKind(kind).find((g) => g.id === id)?.label ??
    GENRE_LABELS[id] ??
    id
  );
}

// parseGenreString is pure but expensive (every synonym phrase is
// scanned per call); provider categories repeat heavily across a
// catalogue, so results are memoised by raw string. Bounded: the
// cache clears past 5,000 distinct strings (a catalogue with more
// distinct category spellings than that is pathological, and a
// clear only costs recomputation, never correctness).
const GENRE_PARSE_CACHE = new Map<string, GenreId[]>();
const GENRE_PARSE_CACHE_MAX = 5000;

function parseGenresCached(raw: string | null | undefined): GenreId[] {
  if (!raw) return [];
  const hit = GENRE_PARSE_CACHE.get(raw);
  if (hit) return hit;
  const parsed = parseGenreString(raw);
  if (GENRE_PARSE_CACHE.size >= GENRE_PARSE_CACHE_MAX) GENRE_PARSE_CACHE.clear();
  GENRE_PARSE_CACHE.set(raw, parsed);
  return parsed;
}

/** Canonical genre ids for one entry (row genre + category fallback). */
export function genresForEntry(entry: CatalogEntry): GenreId[] {
  const fromGenre = parseGenresCached(
    Array.isArray(entry.genres) ? entry.genres.join(", ") : (entry.genre ?? entry.genres ?? null),
  );
  const fromCategory = parseGenresCached(entry.category ?? null);
  const merged: GenreId[] = [];
  for (const g of [...fromGenre, ...fromCategory]) {
    if (!merged.includes(g)) merged.push(g);
  }
  return merged;
}

// ── Rating evidence (SHIM for rating-evidence.ts) ────────────────

export interface NormalisedRating {
  /** Value on the 0–10 scale, or null when unknown/unparseable. */
  value: number | null;
  /** True when the provider supplied a usable rating. */
  hasEvidence: boolean;
  /** True when a TMDb link backs the entry (evidence preference). */
  tmdbLinked: boolean;
}

/**
 * Normalise a provider rating onto 0–10. Missing, blank,
 * non-numeric, <= 0 and > 10 values are UNKNOWN (null) — never a
 * guessed number, never a pass for a minimum filter. A 5-based
 * value is NOT auto-doubled: the bulk rows give no reliable scale
 * signal, so a bare 4.5 stays 4.5 (W1's rating-evidence module
 * owns scale detection from richer fields).
 */
export function normaliseRating(entry: CatalogEntry): NormalisedRating {
  const tmdbLinked = Number(entry.tmdb) > 0;
  const raw = entry.rating;
  if (raw == null || raw === "") return { value: null, hasEvidence: false, tmdbLinked };
  const value = parseFloat(String(raw).trim());
  if (!Number.isFinite(value) || value <= 0 || value > 10) {
    return { value: null, hasEvidence: false, tmdbLinked };
  }
  return { value, hasEvidence: true, tmdbLinked };
}

/**
 * Evidence-first rating comparison for "Highest Rated": entries
 * WITH a rating sort above entries without; TMDb-linked entries
 * sort above unlinked ones at the same value (the C2 evidence
 * preference); ties fall back to title order via the caller.
 * Returns negative when a sorts before b.
 */
export function compareByRatingEvidence(
  a: CatalogEntry,
  b: CatalogEntry,
): number {
  const ra = normaliseRating(a);
  const rb = normaliseRating(b);
  if (ra.hasEvidence !== rb.hasEvidence) return ra.hasEvidence ? -1 : 1;
  if (ra.value != null && rb.value != null && ra.value !== rb.value) {
    return rb.value - ra.value;
  }
  if (ra.tmdbLinked !== rb.tmdbLinked) return ra.tmdbLinked ? -1 : 1;
  return 0;
}

// ── Grouping (SHIM for catalog-index.ts grouping) ────────────────

export interface TitleGroup {
  /** Stable group id: `group:<normalised title>:<year or ''>`. */
  id: string;
  /** Display title (first entry's name, verbatim). */
  title: string;
  /** Release/first-air year string, or "" when unknown. */
  year: string;
  /** All variant entries, in catalogue order. NEVER a subset. */
  entries: CatalogEntry[];
  /** The entry the grid card renders (first entry). */
  displayEntry: CatalogEntry;
  /** Number of variant entries (1 = no variants). */
  variantCount: number;
  /** Normalised search haystack, built once at index time. */
  norm: string;
}

export function parseEntryYear(entry: CatalogEntry): number | null {
  const match = String(entry.year ?? "").match(/(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1900 && year <= 2100 ? year : null;
}

/**
 * Group entries by normalised title + year. Display counts use
 * groups; variants are never hidden (every group keeps all its
 * entries). Entries with no usable name are dropped (they cannot
 * be displayed or searched — the row mappers already drop them).
 */
export function groupEntries(entries: readonly CatalogEntry[]): TitleGroup[] {
  const byKey = new Map<string, TitleGroup>();
  const order: TitleGroup[] = [];
  for (const entry of entries) {
    const name = String(entry.name ?? "").trim();
    if (!name) continue;
    const yearNum = parseEntryYear(entry);
    // Grouping key: provider affixes ([1080p], FHD, region
    // prefixes) are version noise, not title identity — strip
    // them so "Title [1080p]" groups with "Title" (same year).
    // Variants are never hidden: every entry stays in
    // group.entries and variantCount counts them all.
    const keyName = normalize(stripProviderAffixes(name));
    const key = `${keyName}|${yearNum ?? ""}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        id: `group:${keyName}:${yearNum ?? ""}`,
        title: name,
        year: yearNum != null ? String(yearNum) : "",
        entries: [],
        displayEntry: entry,
        variantCount: 0,
        norm: "",
      };
      byKey.set(key, group);
      order.push(group);
    }
    group.entries.push(entry);
  }
  for (const group of order) {
    group.variantCount = group.entries.length;
    const alt = group.entries.flatMap((e) => e.altTitles ?? []);
    group.norm = normalize(
      [
        group.title,
        ...alt,
        group.displayEntry.category ?? "",
        group.year,
      ].join(" "),
    );
  }
  return order;
}

// ── Catalog index (SHIM for catalog-index.ts) ────────────────────

export interface ProviderCategoryInfo {
  /** Stable id: `provider:<slug>`, disambiguated on slug collision. */
  id: string;
  /** Real provider label, verbatim. */
  label: string;
  /** Raw provider category string (the identity). */
  rawName: string;
  /** Group ids in this category, in catalogue order. */
  groupIds: string[];
  count: number;
}

export interface CatalogIndex {
  kind: BrowseKind;
  revision: string | number;
  groups: TitleGroup[];
  byId: Map<string, TitleGroup>;
  /** Group ids per canonical genre id. */
  genreSets: Map<string, Set<string>>;
  /** Provider categories in first-seen order. */
  providerCategories: ProviderCategoryInfo[];
  /** Uncategorised group ids (no usable provider category). */
  uncategorisedIds: string[];
  /** Languages actually present in the catalogue (verbatim tags). */
  languages: string[];
  /** Total entries (all variants) vs total groups (display titles). */
  totalEntries: number;
  totalGroups: number;
  /** Precomputed sorted group-id orders (never re-sorted per query). */
  sorted: Record<string, string[]>;
  buildCount: number;
}

let shimBuildCount = 0;
let cachedShimIndex: CatalogIndex | null = null;
let cachedShimRevision: string | number | null = null;
let cachedShimHasRevision = false;

export function shimCatalogBuildCount(): number {
  return shimBuildCount;
}

export function resetShimCatalogCache(): void {
  cachedShimIndex = null;
  cachedShimRevision = null;
  cachedShimHasRevision = false;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "category";
}

function entryTitle(entry: CatalogEntry): string {
  return String(entry.name ?? "");
}

function buildSortedIndexes(groups: TitleGroup[]): Record<string, string[]> {
  // Sort keys are computed ONCE per group: comparators below read
  // precomputed numbers/strings instead of re-parsing ratings,
  // years and titles on every comparison (a 50k catalogue pays
  // ~800k comparisons per sort — key computation must be O(1)
  // per group, not O(1) per comparison). Title order uses
  // code-point comparison on lowercased titles (deterministic;
  // W1's real index may substitute locale order — flagged in the
  // header mapping).
  interface SortKey {
    id: string;
    titleKey: string;
    added: number;
    updated: number;
    year: number | null;
    rating: number | null;
    rated: boolean;
    tmdbLinked: boolean;
  }
  const keys: SortKey[] = groups.map((g) => {
    const entry = g.displayEntry;
    const rating = normaliseRating(entry);
    return {
      id: g.id,
      titleKey: entryTitle(entry).toLowerCase(),
      added: Number(entry.added) || 0,
      updated: Number(entry.updated ?? entry.added) || 0,
      year: parseEntryYear(entry),
      rating: rating.value,
      rated: rating.hasEvidence,
      tmdbLinked: rating.tmdbLinked,
    };
  });
  const byTitle = (a: SortKey, b: SortKey) =>
    a.titleKey < b.titleKey ? -1 : a.titleKey > b.titleKey ? 1 : 0;
  const byId = (sorted: SortKey[]) => sorted.map((k) => k.id);
  const provider = keys.map((k) => k.id);
  const added = byId(
    [...keys].sort((a, b) => b.added - a.added || byTitle(a, b)),
  );
  const rating = byId(
    [...keys].sort((a, b) => {
      if (a.rated !== b.rated) return a.rated ? -1 : 1;
      if (a.rating != null && b.rating != null && a.rating !== b.rating) {
        return b.rating - a.rating;
      }
      if (a.tmdbLinked !== b.tmdbLinked) return a.tmdbLinked ? -1 : 1;
      return byTitle(a, b);
    }),
  );
  const yearDesc = byId(
    [...keys].sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || byTitle(a, b)),
  );
  const yearAsc = byId(
    [...keys].sort(
      (a, b) =>
        (a.year ?? Number.POSITIVE_INFINITY) -
          (b.year ?? Number.POSITIVE_INFINITY) || byTitle(a, b),
    ),
  );
  const az = byId([...keys].sort(byTitle));
  const za = byId([...keys].sort((a, b) => byTitle(b, a)));
  const updated = byId(
    [...keys].sort((a, b) => b.updated - a.updated || byTitle(a, b)),
  );
  return {
    recommended: provider,
    added,
    rating,
    "year-desc": yearDesc,
    "year-asc": yearAsc,
    az,
    za,
    updated,
    // "seasons" has no bulk evidence: the derive layer falls back
    // to provider order and gates the option off (see
    // browse-everything.ts). The index never invents season counts.
    seasons: provider,
  };
}

export function buildCatalogIndex(
  kind: BrowseKind,
  entries: readonly CatalogEntry[],
  revision: string | number,
): CatalogIndex {
  shimBuildCount += 1;
  const groups = groupEntries(entries);
  const byId = new Map<string, TitleGroup>();
  const genreSets = new Map<string, Set<string>>();
  const providerByRaw = new Map<string, ProviderCategoryInfo>();
  const usedProviderIds = new Set<string>();
  const uncategorisedIds: string[] = [];
  const languageSet = new Set<string>();
  let totalEntries = 0;

  for (const group of groups) {
    byId.set(group.id, group);
    totalEntries += group.entries.length;
    const entry = group.displayEntry;
    for (const genre of genresForEntry(entry)) {
      let set = genreSets.get(genre);
      if (!set) {
        set = new Set();
        genreSets.set(genre, set);
      }
      set.add(group.id);
    }
    // A group is uncategorised only when NONE of its variants
    // carries a usable provider category.
    const rawNames = group.entries
      .map((e) => String(e.category ?? "").trim())
      .filter(Boolean);
    if (rawNames.length === 0) {
      uncategorisedIds.push(group.id);
    } else {
      // First variant's category is the group's provider home;
      // every distinct raw category still lists the group so no
      // provider structure is lost.
      const seen = new Set<string>();
      for (const rawName of rawNames) {
        if (seen.has(rawName)) continue;
        seen.add(rawName);
        let info = providerByRaw.get(rawName);
        if (!info) {
          let id = `provider:${slugify(rawName)}`;
          let n = 2;
          while (usedProviderIds.has(id)) id = `provider:${slugify(rawName)}-${n++}`;
          usedProviderIds.add(id);
          info = { id, label: rawName, rawName, groupIds: [], count: 0 };
          providerByRaw.set(rawName, info);
        }
        info.groupIds.push(group.id);
      }
    }
    for (const e of group.entries) {
      const langs = e.languages ?? (e.language ? [e.language] : []);
      for (const lang of langs) {
        const tag = String(lang).trim();
        if (tag) languageSet.add(tag);
      }
    }
  }

  const providerCategories = [...providerByRaw.values()];
  for (const info of providerCategories) info.count = info.groupIds.length;

  return {
    kind,
    revision,
    groups,
    byId,
    genreSets,
    providerCategories,
    uncategorisedIds,
    languages: [...languageSet].sort((a, b) => a.localeCompare(b)),
    totalEntries,
    totalGroups: groups.length,
    sorted: buildSortedIndexes(groups),
    buildCount: shimBuildCount,
  };
}

/** Cached index: rebuilt only when the revision changes. */
export function getCatalogIndex(
  kind: BrowseKind,
  entries: readonly CatalogEntry[],
  revision: string | number,
): CatalogIndex {
  if (
    cachedShimHasRevision &&
    cachedShimIndex &&
    cachedShimRevision === revision &&
    cachedShimIndex.kind === kind
  ) {
    return cachedShimIndex;
  }
  cachedShimIndex = buildCatalogIndex(kind, entries, revision);
  cachedShimRevision = revision;
  cachedShimHasRevision = true;
  return cachedShimIndex;
}

/** Sorted group ids for an order — precomputed, never re-sorted here. */
export function getSortedGroupIds(
  index: CatalogIndex,
  sort: BrowseSortId,
): string[] {
  return index.sorted[sort] ?? index.sorted.recommended;
}

// ── Search (SHIM for catalog-index.ts searchCatalogIndex) ────────

export interface CatalogSearchHit {
  group: TitleGroup;
  score: number;
}

/**
 * Token-AND search over the index's prebuilt haystacks.
 * Normalisation (punctuation, spacing, diacritics) is the shared
 * `normalize` helper — the same one the row mappers use — so
 * "Spider-Man", "spider man" and "SPIDERMAN" all match. A 4-digit
 * year token must match the group's year exactly (year
 * disambiguation: "Dune 2021" does not return the 1984 film).
 * Results are relevance ordered (scoreNormMatch); alphabetical
 * order is a SORT choice, never the search default.
 */
export function searchCatalogIndex(
  index: CatalogIndex,
  query: string,
  onlyIds?: ReadonlySet<string> | null,
): CatalogSearchHit[] {
  const q = normalize(query ?? "").trim();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const yearTokens = tokens.filter((t) => /^\d{4}$/.test(t));
  const hits: CatalogSearchHit[] = [];
  for (const group of index.groups) {
    if (onlyIds && !onlyIds.has(group.id)) continue;
    if (!tokens.every((token) => group.norm.includes(token))) continue;
    if (yearTokens.length > 0) {
      const year = parseEntryYear(group.displayEntry);
      if (year == null || !yearTokens.includes(String(year))) continue;
    }
    const score = scoreNormMatch(group.norm, tokens);
    if (score > 0) hits.push({ group, score });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      entryTitle(a.group.displayEntry).localeCompare(
        entryTitle(b.group.displayEntry),
        "en",
        { sensitivity: "base" },
      ),
  );
  return hits;
}

// ── Collection selectors (SHIM for collection-selectors.ts) ──────

export interface CollectionContext {
  favouriteIds: ReadonlySet<number | string>;
  watchLaterIds: ReadonlySet<number | string>;
  inProgressIds: ReadonlySet<number | string>;
  watchedIds: ReadonlySet<number | string>;
  followedIds: ReadonlySet<number | string>;
  newEpisodeIds: ReadonlySet<number | string>;
}

export const EMPTY_COLLECTION_CONTEXT: CollectionContext = {
  favouriteIds: new Set(),
  watchLaterIds: new Set(),
  inProgressIds: new Set(),
  watchedIds: new Set(),
  followedIds: new Set(),
  newEpisodeIds: new Set(),
};

function groupMatchesIds(
  group: TitleGroup,
  ids: ReadonlySet<number | string>,
): boolean {
  for (const entry of group.entries) {
    if (ids.has(entry.id) || ids.has(String(entry.id))) return true;
  }
  return false;
}

/** Recently Added: provider `added` order (newest first), whole catalogue. */
export function selectRecentlyAdded(index: CatalogIndex): TitleGroup[] {
  return getSortedGroupIds(index, "added").map((id) => index.byId.get(id)!).filter(Boolean);
}

/** Highest Rated: credible-evidence rating order; unrated titles sort last, never excluded here. */
export function selectHighestRated(index: CatalogIndex): TitleGroup[] {
  // Rated titles only, best first. Unrated titles never appear
  // here (the drawer count for this collection is the rated
  // count, so the count and the selection always agree); the
  // "rating" SORT is the view that shows everything with rated
  // titles first and unrated titles placed after them.
  return getSortedGroupIds(index, "rating")
    .map((id) => index.byId.get(id)!)
    .filter((g) => g && normaliseRating(g.displayEntry).hasEvidence);
}

/** Unwatched: groups with no watched/in-progress variant. */
export function selectUnwatched(
  index: CatalogIndex,
  ctx: CollectionContext,
): TitleGroup[] {
  return index.groups.filter(
    (g) => !groupMatchesIds(g, ctx.watchedIds) && !groupMatchesIds(g, ctx.inProgressIds),
  );
}

/** Continue Watching: groups with an in-progress variant. */
export function selectContinueWatching(
  index: CatalogIndex,
  ctx: CollectionContext,
): TitleGroup[] {
  return index.groups.filter((g) => groupMatchesIds(g, ctx.inProgressIds));
}

/** Favourites: groups with a favourited variant. */
export function selectFavourites(
  index: CatalogIndex,
  ctx: CollectionContext,
): TitleGroup[] {
  return index.groups.filter((g) => groupMatchesIds(g, ctx.favouriteIds));
}

/** Watch Later: groups with a Watch Later variant. */
export function selectWatchLater(
  index: CatalogIndex,
  ctx: CollectionContext,
): TitleGroup[] {
  return index.groups.filter((g) => groupMatchesIds(g, ctx.watchLaterIds));
}

/** Followed Series: groups with a followed variant (series). */
export function selectFollowed(
  index: CatalogIndex,
  ctx: CollectionContext,
): TitleGroup[] {
  return index.groups.filter((g) => groupMatchesIds(g, ctx.followedIds));
}

/** New Episodes: groups with a new-episode flag (series, existing detection). */
export function selectNewEpisodes(
  index: CatalogIndex,
  ctx: CollectionContext,
): TitleGroup[] {
  return index.groups.filter((g) => groupMatchesIds(g, ctx.newEpisodeIds));
}
