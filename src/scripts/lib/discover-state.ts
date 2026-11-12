// Discovery search state (0.11.6, AI Discovery 3.0, W4) — the state
// layer for Discover search. W3's DiscoverView rewrite owns the UI;
// this module owns the TRANSITIONS, so no Discover control can
// accumulate hidden filters.
//
// The bug this prevents: in 0.11.5 the Discover search state lived
// as three separate $state variables in DiscoverView.svelte (query /
// queryDebounced / activeMood) with the carry-over rules re-implemented
// at every call site — typing cleared the mood in a debounce timer
// that a quick pick never cancelled, and a quick pick cleared the
// query only because pickMood happened to. One missed clear at any
// call site and a stale condition silently narrowed the next request
// (the reported Comedy→Horror progressive sub-filter). Here each
// transition is one pure function with one meaning, tested in
// tests/browse-filter-state-0116.test.ts:
//
//   - A quick pick starts a FRESH request: applyQuickPick clears the
//     query, the genre and the prior mood, and sets the new mood.
//   - New Search clears everything: applyNewSearch returns a fresh
//     state. (W3 clears ConversationState alongside via
//     newConversation() — conversation is NOT part of this state; it
//     belongs to the conversational layer, and only an explicit
//     refinement preserves constraints.)
//   - Genre selection REPLACES: selectDiscoveryGenre sets the one
//     genre, or clears it when the same genre is re-selected. It
//     replaces ONLY the genre — the typed query and the active mood
//     are visible state in the Discover UI, and dropping the user's
//     typed question as a side effect of a genre tap would be a
//     second surprise. (W4 addition beyond the three frozen helpers;
//     it mirrors selectGenreFilter in browse-filters.ts.)
//
// Deliberately minimal: three fields, four functions. Results,
// receipts, AI mode and conversation state are NOT search state —
// the view owns them and clears them on a new search (see the W3
// wiring notes in the W4 report).

/** The whole of Discover's search state: one query, one mood, one genre. */
export interface DiscoverySearchState {
  /** Raw typed query, exactly as typed. "" = no query. */
  query: string
  /** Active quick-pick preset id (see MOOD_PRESETS in discover.ts). null = none. */
  activeMood: string | null
  /** Selected genre id or label. null = none. Single value: a new selection REPLACES. */
  genre: string | null
}

/** Fresh, empty search state. A NEW object every call. */
export function freshDiscoveryState(): DiscoverySearchState {
  return { query: "", activeMood: null, genre: null }
}

/**
 * A quick pick starts a FRESH request: clears the query, the genre
 * and any prior mood, and sets the new mood. No carried filters.
 *
 * The `state` parameter is intentionally unused — it exists so call
 * sites read as state transitions (`state = applyQuickPick(state, id)`)
 * and so a future, deliberate carry-over decision has a seam. The
 * toggle-off for tapping the active preset again lives in the view:
 * when `presetId === state.activeMood`, call freshDiscoveryState()
 * instead (that is the 0.11.5 pickMood behaviour, kept as a UI choice).
 */
export function applyQuickPick(state: DiscoverySearchState, presetId: string): DiscoverySearchState {
  void state
  return { ...freshDiscoveryState(), activeMood: presetId }
}

/**
 * New Search: clears everything, including (via W3's companion call
 * to newConversation()) the conversation. Identical to
 * freshDiscoveryState() — the separate name is the intent, so a
 * reader at the call site never has to guess what "fresh" means here.
 */
export function applyNewSearch(): DiscoverySearchState {
  return freshDiscoveryState()
}

/**
 * Select a Discover genre, REPLACING any previous genre. Returns a
 * NEW state object; the input is never mutated. Re-selecting the
 * active genre clears it (toggle off, case-insensitive); null/empty
 * clears it. Query and mood are preserved (see the module header).
 */
export function selectDiscoveryGenre(
  state: DiscoverySearchState,
  genre: string | null,
): DiscoverySearchState {
  const next = (genre ?? "").trim()
  const current = (state.genre ?? "").trim()
  const cleared = !next || next.toLowerCase() === current.toLowerCase()
  return { ...state, genre: cleared ? null : next }
}
