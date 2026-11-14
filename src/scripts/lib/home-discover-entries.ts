// Discover entry points (0.11.14, W5 Homes — brief §21). Pure.
// Lightweight pre-scoped prompts into the existing Discover AI
// experience. Homes does NOT build a second AI chat app: tapping a
// prompt runs ONE explicit AI-ranked in-library request and shows
// the results browsable directly on the originating Movies/Series
// page (via home-ai-picks + the existing ranker). The "Open in
// Discover" link is the escape hatch to the full Discover flow.
//
// URL CONTRACT (for W3, DiscoverView navigation owner): entry
// points link to `/discover?q=<prompt>&kind=<movie|series>`.
// DiscoverView does not consume these params yet — the link is a
// forward contract, and nothing on Homes depends on it: on-page
// results are the primary behaviour, and the link is labelled
// "Open in Discover", never "Continue this search in Discover".
// Until W3 lands param consumption, opening Discover starts a
// fresh Discover session; the prompt text is NOT silently
// re-submitted anywhere.

import type { HomeAiKind } from "@/scripts/lib/home-ai-picks.ts";

export interface DiscoverEntryPrompt {
  /** Stable id for focus keys / tests. */
  id: string;
  /** The prompt text shown on the chip and sent as the ranker query. */
  label: string;
  /** Hard intent for the ranker (kind is always enforced separately). */
  genres?: string[];
  maxRuntimeMinutes?: number;
  mood?: string;
}

/** Brief §21 movie prompts, pre-scoped to Movies. */
export const MOVIE_DISCOVER_PROMPTS: DiscoverEntryPrompt[] = [
  { id: "dark-tense", label: "Something dark and tense", genres: ["Thriller", "Horror", "Mystery"], mood: "dark and tense" },
  { id: "funny", label: "A genuinely funny film", genres: ["Comedy"], mood: "funny" },
  { id: "sci-fi", label: "An excellent sci-fi film", genres: ["Science Fiction"], mood: "sci-fi" },
  { id: "under-two-hours", label: "Something under two hours", maxRuntimeMinutes: 120 },
  { id: "hidden-gems", label: "Hidden gems", mood: "hidden gems" },
  { id: "surprise", label: "Surprise me" },
];

/** Brief §21 series prompts, pre-scoped to Series. */
export const SERIES_DISCOVER_PROMPTS: DiscoverEntryPrompt[] = [
  { id: "crime", label: "A gripping crime series", genres: ["Crime", "Drama"], mood: "gripping crime" },
  { id: "dark-fantasy", label: "Dark fantasy", genres: ["Fantasy", "Horror"], mood: "dark fantasy" },
  { id: "short-series", label: "Short series worth finishing", mood: "short and worth finishing" },
  { id: "like-favourites", label: "Something like my favourites", mood: "like my favourites" },
  { id: "great-pacing", label: "A series with great pacing", mood: "great pacing" },
  { id: "completely-different", label: "Something completely different", mood: "completely different" },
];

export function discoverPromptsFor(kind: HomeAiKind): DiscoverEntryPrompt[] {
  return kind === "movie" ? MOVIE_DISCOVER_PROMPTS : SERIES_DISCOVER_PROMPTS;
}

export function discoverPromptById(kind: HomeAiKind, id: string): DiscoverEntryPrompt | null {
  return discoverPromptsFor(kind).find((prompt) => prompt.id === id) ?? null;
}

/** Forward-contract Discover URL for a prompt (see header). Kind-scoped, never cross-kind. */
export function discoverUrlForPrompt(prompt: DiscoverEntryPrompt, kind: HomeAiKind): string {
  const params = new URLSearchParams({ q: prompt.label, kind });
  return `/discover?${params.toString()}`;
}

/** Cache request-type dimension for a prompt run (one cached answer per prompt+kind). */
export function discoverPromptRequestType(prompt: DiscoverEntryPrompt, kind: HomeAiKind): string {
  return `prompt:${kind}:${prompt.id}`;
}

/**
 * Shortlist intent for a prompt run: genre filters the local
 * relevance pool uses BEFORE the ranker sees it. "Surprise me" and
 * prompts without genres intentionally return no genre filter —
 * surprise means the whole diverse pool, not one genre.
 */
export function promptGenreFilter(prompt: DiscoverEntryPrompt): string[] {
  return [...(prompt.genres ?? [])];
}
