// RedSilk Couch — search presentation helpers (W5).
//
// Pure functions only: the catalogue indexing / scoring itself lives in
// the existing search services (catalog.js, genre-index.ts,
// person-search.ts) and SearchView.svelte. These helpers only shape
// already-scored results into the Film / Series / Channel categories
// the Couch search screen renders, and derive suggestion chips from
// the query + recent searches. No data is invented here.

export type CouchSearchKind = "live" | "vod" | "series" | "epg" | "person";

export interface CouchSearchItem {
  kind: CouchSearchKind;
  id: string | number;
  name: string;
  [key: string]: unknown;
}

export interface CategorizedSearchResults {
  /** Live channels. */
  channels: CouchSearchItem[];
  /** Films (VOD movies). */
  films: CouchSearchItem[];
  /** Series. */
  series: CouchSearchItem[];
  /** EPG programmes. */
  programmes: CouchSearchItem[];
  /** People (actors / person candidates). */
  people: CouchSearchItem[];
}

/** Split scored results into the Couch search categories. Unknown kinds are dropped. */
export function categorizeSearchResults(
  items: readonly CouchSearchItem[],
): CategorizedSearchResults {
  const out: CategorizedSearchResults = {
    channels: [],
    films: [],
    series: [],
    programmes: [],
    people: [],
  };
  for (const item of items) {
    if (item.kind === "live") out.channels.push(item);
    else if (item.kind === "vod") out.films.push(item);
    else if (item.kind === "series") out.series.push(item);
    else if (item.kind === "epg") out.programmes.push(item);
    else if (item.kind === "person") out.people.push(item);
  }
  return out;
}

/** Category labels in Couch display order. */
export const COUCH_SEARCH_CATEGORIES = [
  { id: "channels", label: "Channels" },
  { id: "films", label: "Films" },
  { id: "series", label: "Series" },
  { id: "programmes", label: "Programmes" },
  { id: "people", label: "People" },
] as const;

/**
 * Suggestion chips for the current query: recent searches that start
 * with the query first (most recent first), then top result names that
 * start with it. Capped, de-duplicated (case-insensitive), and never
 * echoes the query itself back as a suggestion.
 */
export function suggestionsFor(
  query: string,
  recentSearches: readonly string[],
  topResultNames: readonly string[],
  max = 6,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const seen = new Set<string>([needle]);
  const out: string[] = [];
  const push = (value: string) => {
    const text = value.trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    if (!key.startsWith(needle)) return;
    seen.add(key);
    out.push(text);
  };
  for (const recent of recentSearches) {
    push(recent);
    if (out.length >= max) return out;
  }
  for (const name of topResultNames) {
    push(name);
    if (out.length >= max) return out;
  }
  return out;
}
