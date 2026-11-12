// 0.11.8 W2 — Browse search helpers (brief §12).
//
// Pure query handling for Browse Everything search. The actual
// index lookup is the W1 searchCatalogIndex contract
// (catalog-index.ts); this module owns
// query normalisation, provider-affix stripping, year-token
// extraction, scope resolution and the debounced-apply helper.
//
// ── Rules ────────────────────────────────────────────────────────
//   - Full/partial/alternative names match through the index
//     haystack (title + alt titles + category + year).
//   - Punctuation, spacing and diacritics are normalised by the
//     shared `normalize` helper (text.ts) — the same one the row
//     mappers use — so "Spider-Man" == "spider man".
//   - Provider affixes (quality tags in brackets, "FHD"/"4K"
//     suffixes, "UK |" prefixes) are stripped from the QUERY so
//     a pasted provider-style title still finds its film. Year
//     tokens are KEPT: "Dune 2021" disambiguates by year.
//   - Scope: default FULL catalogue. Inside a category the
//     search overlay offers a VISIBLE choice: Search All vs
//     Search Current Category. An old genre/category filter is
//     NEVER silently retained: scope "category" binds to the
//     CURRENT category at submit time, and changing category
//     clears a category-scoped search (browse-state.ts).
//   - Search results default to relevance order, never
//     alphabetical unless the user picks a title sort.
//   - Debounced: no per-character full DOM regeneration — the
//     controller applies the query after the debounce settles
//     and the keyed grid reconciles only the new page.

import { normalize } from "@/scripts/lib/text.ts";
import type { BrowseSearchScope } from "@/scripts/lib/browse-state.ts";

const QUALITY_TAG_RE =
  /\b(?:FHD|UHD|4K|HD|SD|HEVC|H\.?265|H\.?264|X264|X265|1080P|720P|2160P|BLURAY|BRRIP|WEBRIP|WEB-DL|HDR|DOLBY|ATMOS|AAC|AC3|DTS)\b/gi;

const REGION_PREFIX_RE =
  /^(?:UK|GB|IE|IRL|USA|US|Ireland|United Kingdom)\s*[-–—|:]\s*/i;

/**
 * Strip provider affixes from a query: bracketed/parenthesised
 * quality tags, bare quality tokens, and leading region
 * prefixes. The title words and any year survive. "" stays "".
 */
export function stripProviderAffixes(query: string): string {
  let text = (query ?? "").trim();
  if (!text) return "";
  text = text.replace(REGION_PREFIX_RE, "");
  // Bracketed groups that are ONLY quality/format noise.
  text = text.replace(/\[[^\]]*\]|\([^)]*\)/g, (group) => {
    const inner = group.slice(1, -1);
    // Keep a bare year in parens: "(2021)" is disambiguation.
    if (/^\d{4}$/.test(inner.trim())) return ` ${inner.trim()} `;
    if (QUALITY_TAG_RE.test(inner)) return " ";
    QUALITY_TAG_RE.lastIndex = 0;
    // Keep other parentheticals (e.g. "(Director's Cut)") — they
    // may be part of the title.
    return ` ${inner} `;
  });
  QUALITY_TAG_RE.lastIndex = 0;
  text = text.replace(QUALITY_TAG_RE, " ");
  return text.replace(/\s{2,}/g, " ").trim();
}

/** Normalised query for matching: affixes stripped, then shared normalize. */
export function normalizeBrowseQuery(query: string): string {
  return normalize(stripProviderAffixes(query));
}

/** 4-digit year tokens in a query (for year disambiguation). */
export function yearTokensInQuery(query: string): string[] {
  const matches = (query ?? "").match(/\b(19|20)\d{2}\b/g);
  return matches ? [...new Set(matches)] : [];
}

/** True when the query carries any searchable text after normalisation. */
export function hasSearchableQuery(query: string): boolean {
  return normalizeBrowseQuery(query).length > 0;
}

/**
 * Resolve the effective search scope. "category" is only
 * meaningful when the browse is inside a non-All category;
 * otherwise it degrades to "all" (searching "the current
 * category" when the category IS everything is just "all").
 */
export function resolveSearchScope(
  requested: BrowseSearchScope,
  categoryKind: string,
): BrowseSearchScope {
  if (requested === "category" && categoryKind !== "all") return "category";
  return "all";
}

/** Scope choice labels for the search overlay (the VISIBLE choice, §12). */
export function searchScopeOptions(categoryLabel: string): Array<{
  value: BrowseSearchScope;
  label: string;
}> {
  return [
    { value: "all", label: "Search All Titles" },
    { value: "category", label: `Search Current Category (${categoryLabel})` },
  ];
}

// ── Debounced apply ──────────────────────────────────────────────

/**
 * Debounced search applier with cancel/flush. The callback fires
 * once, `ms` after the last keystroke; cancel() drops a pending
 * apply (drawer close / unmount); flush() applies immediately
 * (submit). No per-character DOM work happens here — the
 * controller applies the settled query in one pass.
 */
export function createDebouncedSearch(
  apply: (query: string) => void,
  ms = 200,
): {
  queue: (query: string) => void;
  cancel: () => void;
  flush: () => void;
  pending: () => string | null;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingQuery: string | null = null;
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    queue(query: string): void {
      pendingQuery = query;
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        const q = pendingQuery;
        pendingQuery = null;
        if (q != null) apply(q);
      }, ms);
    },
    cancel(): void {
      clear();
      pendingQuery = null;
    },
    flush(): void {
      const q = pendingQuery;
      clear();
      pendingQuery = null;
      if (q != null) apply(q);
    },
    pending(): string | null {
      return pendingQuery;
    },
  };
}
