// Mocked-model helper (0.11.6, W5).
//
// A deterministic stand-in for the LLM behind the AiChatTransport seam
// (AiChatOptions -> AiChatResult). It NEVER sees the catalogue and NEVER
// touches the network: it returns canned structured JSON from a script,
// captures every call's messages for prompt assertions, and counts calls
// for the cost/caching tests (Test K).
//
// The wire format is the one the generation stub parses: a JSON array of
// recommendation objects, or a {"recommendations": [...]} envelope.
// modelReply() is the ONE place that format is produced — if W1 chooses
// a different wire format at integration, only this helper changes.

import type { AiChatOptions, AiChatResult } from "../../src/scripts/lib/ai/client"
import type {
  AiChatTransport,
  GeneratedRecommendation,
} from "../../src/scripts/lib/ai/generation"

export const MOCK_MODEL_ID = "mock-model-1"

/** Serialise recommendations exactly as the mocked model "replies". */
export function modelReply(recs: GeneratedRecommendation[]): string {
  return JSON.stringify(recs)
}

/** Envelope variant of the wire format. */
export function modelEnvelopeReply(recs: GeneratedRecommendation[]): string {
  return JSON.stringify({ recommendations: recs })
}

/** A reply that is not JSON at all (orchestration-seam malformed case). */
export const MALFORMED_MODEL_REPLY = "Sure! Here are some great picks: Dune, etc."

/** A reply whose items are all invalid (no usable title/kind). */
export const INVALID_ITEMS_REPLY = JSON.stringify([
  { title: "", year: 2020, kind: "movie", reason: "empty title", tone: "x" },
  { title: "No Kind Here", year: 2020, kind: "podcast", reason: "bad kind", tone: "x" },
  "just a string",
  42,
])

export type MockChatResponder = (
  options: AiChatOptions,
  callIndex: number,
) => string | Promise<string>

export interface MockChat {
  transport: AiChatTransport
  /** Every AiChatOptions object received, in call order. */
  calls: AiChatOptions[]
  /** Number of model calls made (calls.length). */
  readonly callCount: number
}

/**
 * Build a capturing transport around a responder. The responder may
 * throw to simulate a provider failure (Test L), and may read the
 * captured messages to answer like a model following the conversation
 * (Tests F/G use scripted replies instead — deterministic by call).
 */
export function createMockChat(responder: MockChatResponder): MockChat {
  const calls: AiChatOptions[] = []
  const transport: AiChatTransport = async (options: AiChatOptions): Promise<AiChatResult> => {
    const index = calls.length
    calls.push(options)
    const text = await responder(options, index)
    return { text, model: MOCK_MODEL_ID }
  }
  return {
    transport,
    calls,
    get callCount() {
      return calls.length
    },
  }
}

/** One fixed reply for every call. */
export function fixedReplyMock(text: string): MockChat {
  return createMockChat(() => text)
}

/** Replies in call order; the last reply repeats for any extra calls. */
export function scriptedMock(replies: string[]): MockChat {
  return createMockChat((_options, index) => replies[Math.min(index, replies.length - 1)])
}

/** A transport that always throws (provider failure, Test L). */
export function failingMock(error: Error): MockChat {
  return createMockChat(() => {
    throw error
  })
}

/** All message contents of the nth call, joined (prompt assertions). */
export function allMessageText(mock: MockChat, callIndex = 0): string {
  const options = mock.calls[callIndex]
  if (!options) return ""
  return options.messages.map((message) => message.content).join("\n")
}

/** System-message content of the nth call. */
export function systemMessageText(mock: MockChat, callIndex = 0): string {
  const options = mock.calls[callIndex]
  if (!options) return ""
  return options.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n")
}

/** User-message content of the nth call. */
export function userMessageText(mock: MockChat, callIndex = 0): string {
  const options = mock.calls[callIndex]
  if (!options) return ""
  return options.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n")
}
