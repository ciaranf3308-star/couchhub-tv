// SHIM — 0.11.6 W3: replaced at integration by the real implementation
// (W4 owns discover-state). This file exists only so the Discover UI
// (W3) can build against the FROZEN state-transition contracts while
// W4 builds the real state module in parallel. Integration DELETES
// this file and drops in W4's real module; the exported names and
// signatures below are the frozen contract.
//
// Frozen contract:
//   freshDiscoveryState(): DiscoverySearchState
//   applyQuickPick(state, presetId): DiscoverySearchState
//   applyNewSearch(): DiscoverySearchState
//   selectGenreFilter(state: BrowseFilterState, genre: string | null): BrowseFilterState
//
// Semantics (frozen by the brief):
// - A quick pick starts a FRESH request: no carried query, no carried
//   conversation, no carried filters. Only the picked mood survives.
// - New Search clears EVERYTHING, including the conversation.
// - Genre selection REPLACES: picking Horror after Comedy means
//   Horror, never Comedy∩Horror. (The user-reported progressive
//   sub-filter bug.) `null` clears the genre. Other filter fields are
//   untouched, and a NEW object is returned — the input is never mutated.

import {
  newConversation,
  type ConversationState,
} from "./ai/generation.ts"
import type { BrowseFilterState } from "./browse-filters.ts"

/** The Discover search state a transition produces. */
export interface DiscoverySearchState {
  /** The submitted query text ("" when nothing has been asked). */
  query: string
  /** Conversational context for refinements; fresh = no turns. */
  conversation: ConversationState
  /** "Available in My Library" toggle: client-side filter only. */
  availableOnly: boolean
  /** Active quick-pick preset id, or null when none is active. */
  activeMood: string | null
}

/** A clean Discover state: no query, no conversation, no filters. */
export function freshDiscoveryState(): DiscoverySearchState {
  return {
    query: "",
    conversation: newConversation(),
    availableOnly: false,
    activeMood: null,
  }
}

/**
 * Start a fresh discovery request for one quick pick. Nothing is
 * carried from the previous state — not the query, not the
 * conversation, not the available-only toggle. The `state` argument
 * exists for the frozen signature; its contents are intentionally
 * ignored, because a quick pick must never inherit hidden filters.
 */
export function applyQuickPick(
  _state: DiscoverySearchState,
  presetId: string
): DiscoverySearchState {
  return {
    ...freshDiscoveryState(),
    activeMood: presetId,
  }
}

/** Clear everything, including the conversation: a genuinely new search. */
export function applyNewSearch(): DiscoverySearchState {
  return freshDiscoveryState()
}

/**
 * REPLACE genre selection: the new genre replaces the previous one
 * outright — it is never intersected with it. `null` (or "") clears
 * the genre back to "any". Every other field is carried unchanged,
 * and the input state is never mutated.
 */
export function selectGenreFilter(
  state: BrowseFilterState,
  genre: string | null
): BrowseFilterState {
  return {
    ...state,
    genre: genre ?? "",
  }
}
