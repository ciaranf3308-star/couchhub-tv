/**
 * @vitest-environment jsdom
 */
// AI model single control (0.11.4 fix #6): resolveAiModelControl is the pure
// core of the Settings select + Custom field pairing. The Rust keystore and
// provider fetch are mocked like tests/ai-status.test.ts; the resolver
// itself is exercised for real.
import { describe, it, expect, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  enabled: { value: false },
  endpoint: { value: "https://api.openai.com/v1" },
  model: { value: "gpt-4o-mini" },
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getAiEnabled: () => hoisted.enabled.value,
  getAiEndpoint: () => hoisted.endpoint.value,
  getAiModel: () => hoisted.model.value,
}))

vi.mock("@/scripts/lib/ai/keystore.js", () => ({
  getAiKey: async () => null,
  hasAiKey: async () => false,
  testAiConnection: async () => ({ ok: false, error: "no_key" }),
}))

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: async () => {
    throw new Error("no network in tests")
  },
}))

import { resolveAiModelControl } from "@/scripts/lib/ai/status.ts"

describe("resolveAiModelControl (single model control)", () => {
  it("keeps a supported model on the select, custom field hidden", () => {
    expect(resolveAiModelControl("gpt-4o-mini")).toEqual({
      selectValue: "gpt-4o-mini",
      showCustom: false,
      customValue: "",
    })
    expect(resolveAiModelControl("o4-mini")).toEqual({
      selectValue: "o4-mini",
      showCustom: false,
      customValue: "",
    })
  })

  it("routes an unknown model through Custom with the name kept", () => {
    expect(resolveAiModelControl("llama-3.1-8b")).toEqual({
      selectValue: "custom",
      showCustom: true,
      customValue: "llama-3.1-8b",
    })
  })

  it("routes an empty model through Custom with an empty field", () => {
    expect(resolveAiModelControl("")).toEqual({
      selectValue: "custom",
      showCustom: true,
      customValue: "",
    })
    expect(resolveAiModelControl("   ")).toEqual({
      selectValue: "custom",
      showCustom: true,
      customValue: "",
    })
  })
})
