// AI client tests. No real API key, no network: providerFetch and the
// keystore are mocked; the key used here is synthetic.
import { describe, it, expect, beforeEach, vi } from "vitest"
import { AiError, chatCompletions } from "@/scripts/lib/ai/client"

const { providerFetchMock, getAiKeyMock } = vi.hoisted(() => ({
  providerFetchMock: vi.fn(),
  getAiKeyMock: vi.fn(),
}))

vi.mock("@/scripts/lib/provider-fetch.js", () => ({
  providerFetch: providerFetchMock,
}))

vi.mock("@/scripts/lib/ai/keystore.js", () => ({
  getAiKey: getAiKeyMock,
}))

vi.mock("@/scripts/lib/app-settings.js", () => ({
  getAiEndpoint: () => "https://api.openai.com/v1",
  getAiModel: () => "gpt-4o-mini",
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function okReply(text = '{"rankings":[]}'): Response {
  return jsonResponse({ choices: [{ message: { content: text } }] })
}

beforeEach(() => {
  vi.resetAllMocks()
  getAiKeyMock.mockResolvedValue("sk-test-key")
  providerFetchMock.mockResolvedValue(okReply())
})

describe("chatCompletions", () => {
  it("posts to /chat/completions with a Bearer key and returns the reply text", async () => {
    const result = await chatCompletions({
      messages: [{ role: "user", content: "something cosy" }],
    })
    expect(result.text).toBe('{"rankings":[]}')
    expect(result.model).toBe("gpt-4o-mini")
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = providerFetchMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe("https://api.openai.com/v1/chat/completions")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key")
    const body = String(init.body)
    expect(JSON.parse(body).model).toBe("gpt-4o-mini")
    // The key travels in the header only — never in the request body.
    expect(body).not.toContain("sk-test-key")
  })

  it("maps auth failures to invalid_key", async () => {
    for (const status of [401, 403]) {
      providerFetchMock.mockResolvedValueOnce(new Response("nope", { status }))
      await expect(
        chatCompletions({ messages: [{ role: "user", content: "x" }] })
      ).rejects.toMatchObject({ kind: "invalid_key", status })
    }
  })

  it("maps 429 to rate_limited and 5xx to unavailable", async () => {
    providerFetchMock.mockResolvedValueOnce(new Response("slow down", { status: 429 }))
    await expect(
      chatCompletions({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ kind: "rate_limited", status: 429 })

    providerFetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }))
    await expect(
      chatCompletions({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ kind: "unavailable", status: 500 })
  })

  it("maps unreadable or empty replies to bad_output", async () => {
    providerFetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }))
    await expect(
      chatCompletions({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ kind: "bad_output" })

    providerFetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "   " } }] }))
    await expect(
      chatCompletions({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ kind: "bad_output" })

    providerFetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }))
    await expect(
      chatCompletions({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ kind: "bad_output" })
  })

  it("throws not_configured when no key is stored", async () => {
    getAiKeyMock.mockResolvedValueOnce(null)
    await expect(
      chatCompletions({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ kind: "not_configured" })
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("throws not_configured when the model is blank", async () => {
    await expect(
      chatCompletions({
        messages: [{ role: "user", content: "x" }],
        model: "   ",
      })
    ).rejects.toMatchObject({ kind: "not_configured" })
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("surfaces a caller abort as aborted without issuing a request", async () => {
    const controller = new AbortController()
    providerFetchMock.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        })
    )
    const pending = chatCompletions({
      messages: [{ role: "user", content: "x" }],
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(AiError)
    await expect(pending).rejects.toMatchObject({ kind: "aborted" })
    // Fail-fast: an already-aborted search never reaches the provider.
    expect(providerFetchMock).not.toHaveBeenCalled()
  })

  it("maps a mid-flight abort as aborted after one request", async () => {
    const controller = new AbortController()
    providerFetchMock.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        })
    )
    const pending = chatCompletions({
      messages: [{ role: "user", content: "x" }],
      signal: controller.signal,
    })
    // Let the key lookup + fetch start before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: "aborted" })
    expect(providerFetchMock).toHaveBeenCalledTimes(1)
  })

  it("times out a hung provider as aborted", async () => {
    vi.useFakeTimers()
    try {
      providerFetchMock.mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation timed out.", "TimeoutError"))
            })
          })
      )
      const pending = chatCompletions({
        messages: [{ role: "user", content: "x" }],
        timeoutMs: 5000,
      })
      const assertion = expect(pending).rejects.toMatchObject({ kind: "aborted" })
      await vi.advanceTimersByTimeAsync(5000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("maps a network failure to unavailable", async () => {
    providerFetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
    await expect(
      chatCompletions({ messages: [{ role: "user", content: "x" }] })
    ).rejects.toMatchObject({ kind: "unavailable" })
  })
})
