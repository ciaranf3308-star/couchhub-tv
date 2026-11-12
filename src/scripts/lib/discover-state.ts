// STUB — 0.11.6 W5: deleted at integration, replaced by the real implementation.
//
// Minimal, behaviourally transparent stand-in for W4's Discover state
// module, written ONLY so the 0.11.6 acceptance tests
// (tests/ai-discovery-3.0.test.ts) compile and their LOGIC is verified in
// the W5 worktree. It applies only the frozen contract's stated semantics
// in the most literal way possible: a quick pick REPLACES the previous
// one (never accumulates), and a new search returns a fresh state.
//
// Rules this stub pins (see the W5 report — if W4 chooses differently,
// the tests adapt at integration, not silently):
//   - All three helpers are pure: they return a new state object and
//     never mutate the input.
//   - applyQuickPick sets the active quick pick and clears the typed
//     query (a pick is a preset, not a question — the 0.11.5 Discover
//     view clears the query on pick too). It does not validate the id:
//     unknown ids are stored as given; validation is W4/W3's job.
//   - applyNewSearch takes no state and returns a fresh state.
//   - Genre selection itself lives in selectGenreFilter
//     (browse-filters.ts, also a W5 stub addition); this module only
//     tracks the quick-pick / query half of Discover state.

export interface DiscoveryState {
  /** Active quick-pick preset id, or null when none is active. */
  activeQuickPick: string | null
  /** Typed search query. Empty while a quick pick is active. */
  query: string
}

export function freshDiscoveryState(): DiscoveryState {
  return { activeQuickPick: null, query: "" }
}

export function applyQuickPick(state: DiscoveryState, presetId: string): DiscoveryState {
  return { ...state, activeQuickPick: presetId, query: "" }
}

export function applyNewSearch(): DiscoveryState {
  return freshDiscoveryState()
}
