// SHIM — 0.11.6 W3: replaced at integration by the real implementation
// (W1 owns ai/generation.ts). This file exists only so the Discover UI
// (W3) can build against the FROZEN conversation contracts while W1
// builds the real generation layer in parallel. Integration DELETES
// this file and drops in W1's real module; the exported names and
// shapes below are the frozen contract and must keep working.
//
// Frozen contract:
//   ConversationState = { turns: Array<{ query: string; generatedTitles: string[] }> }
//   newConversation(): ConversationState
//   conversationContextFor(state): string[]
//
// The two helpers here are pure and deliberately minimal: a fresh
// conversation has no turns, and the context is one honest line per
// turn (the question asked + the titles it generated). What the real
// generation layer does with that context (prompt construction,
// de-duplication against earlier turns) is W1's job, not this shim's.

export interface ConversationTurn {
  query: string
  generatedTitles: string[]
}

export interface ConversationState {
  turns: ConversationTurn[]
}

/** A brand-new conversation: no turns, no carried context. */
export function newConversation(): ConversationState {
  return { turns: [] }
}

/**
 * One context line per turn, oldest first: the question asked and the
 * titles it generated. Empty for a fresh conversation. The caller
 * (generation) decides how these lines enter the prompt; this helper
 * only renders what actually happened — it never invents context.
 */
export function conversationContextFor(state: ConversationState): string[] {
  const turns = Array.isArray(state?.turns) ? state.turns : []
  return turns.map((turn) => {
    const query = typeof turn?.query === "string" ? turn.query.trim() : ""
    const titles = Array.isArray(turn?.generatedTitles)
      ? turn.generatedTitles.filter((t) => typeof t === "string" && t.trim())
      : []
    if (!titles.length) return query
    return `${query} (previously suggested: ${titles.join(", ")})`
  })
}
