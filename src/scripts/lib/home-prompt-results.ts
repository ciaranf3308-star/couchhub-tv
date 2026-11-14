// Discover entry-point results (0.11.14, W5 Homes — brief §21).
// Shared by the Movies and Series mounts: local fallback results
// for one pre-scoped prompt through the existing LOCAL Recommended
// engine (recommendForBrowse over the genre-filtered pool — no
// model call, and no text search: a natural-language brief like
// "A genuinely funny film" matches no title), and resolution of
// verified core picks back to shelf items. The AI request itself
// goes through the W4 core's discovery path
// (requestHomeAiDiscovery) from the mounts; this module only
// prepares candidates and resolves ids, so both mounts run the
// identical prompt flow and neither can leak a title across kinds.

import {
  catalogRowToCandidate,
  type DiscoverCandidate,
} from "@/scripts/lib/discover.ts";
import { recommendForBrowse } from "@/scripts/lib/browse-recommendations.ts";
import type { CatalogIndex } from "@/scripts/lib/catalog-index.ts";
import type { TasteModel } from "@/scripts/lib/taste.ts";
import type { DiscoverEntryPrompt } from "@/scripts/lib/home-discover-entries.ts";
import { promptGenreFilter } from "@/scripts/lib/home-discover-entries.ts";
import type { HomeAiKind, HomeAiPick } from "@/scripts/lib/home-ai-picks.ts";

export const PROMPT_RESULTS_LIMIT = 16;

function normaliseGenre(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const GENRE_SYNONYMS: Record<string, string[]> = {
  sciencefiction: ["scifi", "sciencefiction"],
  scifi: ["sciencefiction", "scifi"],
};

/**
 * Candidates for one prompt: every displayed group primary of the
 * kind, through the shared catalogue→candidate mapping. Kind is
 * fixed by the caller's index — a series index can never yield a
 * movie candidate. Pure.
 */
export function promptCandidates(index: CatalogIndex, kind: HomeAiKind): DiscoverCandidate[] {
  const candidates: DiscoverCandidate[] = [];
  for (const group of index.groups) {
    const row = index.byId.get(group.primaryId) as Parameters<typeof catalogRowToCandidate>[1] | undefined;
    if (!row) continue;
    candidates.push(catalogRowToCandidate(kind, row));
  }
  return candidates;
}

/**
 * Genre pre-filter for a prompt: keep candidates whose genres match
 * a prompt genre (synonym-aware). When the filtered pool is too
 * small to rank (< 5), the full pool is returned instead — a thin
 * genre must not starve the prompt into an empty shelf. Prompts
 * without genres return the full pool. Pure.
 */
export function filterCandidatesForPrompt(
  candidates: DiscoverCandidate[],
  prompt: DiscoverEntryPrompt,
): DiscoverCandidate[] {
  const wanted = promptGenreFilter(prompt).map(normaliseGenre).filter(Boolean);
  if (wanted.length === 0) return [...candidates];
  const wantedSet = new Set<string>();
  for (const genre of wanted) {
    wantedSet.add(genre);
    for (const synonym of GENRE_SYNONYMS[genre] ?? []) wantedSet.add(synonym);
  }
  const filtered = candidates.filter((candidate) =>
    candidate.genres.some((genre) => wantedSet.has(normaliseGenre(genre))),
  );
  return filtered.length >= 5 ? filtered : [...candidates];
}

/**
 * Local fallback results for one prompt (AI off or AI failed):
 * relevance-ranked candidates resolved to shelf items, honestly
 * labelled local by the caller. Pure.
 */
export function localPromptRankedIds(
  index: CatalogIndex,
  taste: TasteModel | null | undefined,
  kind: HomeAiKind,
  prompt: DiscoverEntryPrompt,
  playlistId = "",
): string[] {
  const pool = filterCandidatesForPrompt(promptCandidates(index, kind), prompt);
  const { items } = recommendForBrowse(pool, taste ?? undefined, {
    kind,
    limit: PROMPT_RESULTS_LIMIT * 2,
  }, playlistId);
  return items.map((entry) => entry.candidate.id);
}

/**
 * Resolve verified picks (or local ranked ids) to shelf items:
 * every id resolves to its displayed group primary in THIS index,
 * duplicates collapse, and ids outside the index are dropped. The
 * `reasonFor` callback grounds each card's focus reason from the
 * row + model reason. Generic over the row type so Movies and
 * Series share the exact resolution rule — and so a series result
 * can only ever carry a series row.
 */
export function resolvePromptItems<T extends { id: number | string }>(
  index: CatalogIndex,
  entries: Array<{ id: string | number; reason?: string | null }>,
  reasonFor: (row: T, modelReason: string | null) => string | null,
  limit: number = PROMPT_RESULTS_LIMIT,
): Array<{ row: T; reason: string | null }> {
  const items: Array<{ row: T; reason: string | null }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (items.length >= limit) break;
    const rawId = String(entry.id);
    const groupId = index.groupIdByEntryId.get(rawId);
    const group = groupId ? index.groupById.get(groupId) : undefined;
    if (!group) continue;
    if (seen.has(group.primaryId)) continue;
    const row = index.byId.get(group.primaryId) as T | undefined;
    if (!row) continue;
    seen.add(group.primaryId);
    items.push({ row, reason: reasonFor(row, entry.reason ?? null) });
  }
  return items;
}

/** Picks in the shape resolvePromptItems consumes. */
export function picksToEntries(picks: HomeAiPick[]): Array<{ id: string; reason: string | null }> {
  return picks.map((pick) => ({ id: pick.id, reason: pick.reason }));
}
