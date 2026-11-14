// Homes ↔ W4 core integration tests (0.11.14, W5). The provider
// identity, the chat transport and the TMDb verifier are all
// faked — no key, no network, no real LLM/TMDb calls. Proves W5's
// pool/request assembly works end to end through the REAL core:
// validated picks, cache reads with zero calls, discovery
// verified-but-unmatched titles never becoming playable, and the
// auto-refresh gate.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { flags, provider, verifyMock } = vi.hoisted(() => ({
  flags: { enabled: true, shareTaste: false, homeAutoRefresh: false },
  provider: { endpoint: "https://api.example.invalid/v1", model: "gpt-4o-mini" },
  verifyMock: vi.fn(),
}));

vi.mock("@/scripts/lib/app-settings.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAiEnabled: () => flags.enabled,
  getAiEndpoint: () => provider.endpoint,
  getAiModel: () => provider.model,
}));

vi.mock("@/scripts/lib/ai/status.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAiShareTaste: () => flags.shareTaste,
  getAiHomeAutoRefresh: () => flags.homeAutoRefresh,
}));

vi.mock("@/scripts/lib/ai/verification.js", () => ({
  verifyRecommendations: verifyMock,
  defaultTmdbSearch: vi.fn(() => async () => []),
  defaultFetchDetails: vi.fn(async () => null),
  defaultResolveExternalId: vi.fn(() => async () => null),
}));

import { getCatalogIndex } from "@/scripts/lib/catalog-index.ts";
import { clearAiRankCache } from "@/scripts/lib/ai/ranking.ts";
import {
  clearHomeAiAttempts,
  clearHomeAiCache,
} from "@/scripts/lib/ai/home-cache.ts";
import {
  decideHomeAiAutoRefresh,
  homeAiAllowsSelectorBoost,
  maybeAutoRefreshHomeAiPicks,
  readCachedHomeAiDiscovery,
  readCachedHomeAiPicks,
  requestHomeAiDiscovery,
  requestHomeAiPicks,
} from "@/scripts/lib/ai/home-picks.ts";
import type { AiChatTransport } from "@/scripts/lib/ai/generation.ts";
import type { VerifiedRecommendation } from "@/scripts/lib/ai/verification.ts";
import {
  buildHomeAiDiscoveryRequest,
  buildHomeAiPicksRequest,
} from "@/scripts/lib/home-ai-picks.ts";
import { emptyTasteModel } from "@/scripts/lib/taste.ts";
import { daysAgoSeconds, movieRow } from "./movies-home-0118-fixtures.ts";

const NOW = 1_790_000_000_000;

function library() {
  const genres = ["Action", "Comedy", "Horror", "Thriller", "Science Fiction", "Drama"];
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push(
      movieRow({
        id: 100 + i,
        name: `Library Film ${i}`,
        rating: i % 3 === 0 ? "8.6" : "7.4",
        tmdb: 1000 + i,
        category: genres[i % genres.length],
        plot: i % 2 === 0 ? `Synopsis for film ${i}.` : "",
        added: daysAgoSeconds((i % 12) + 1, NOW),
      }),
    );
  }
  return rows;
}

function rankReply(ids: string[]): string {
  return JSON.stringify({
    rankings: ids.map((id) => ({ id, reason: "A strong pick for tonight." })),
  });
}

function generationReply(titles: Array<{ title: string; year: number }>): string {
  return JSON.stringify({
    recommendations: titles.map((t) => ({
      title: t.title,
      year: t.year,
      kind: "movie",
      reason: "A strong pick for tonight.",
      tone: "cosy",
    })),
  });
}

function verifiedRec(overrides: Partial<VerifiedRecommendation> = {}): VerifiedRecommendation {
  return {
    generated: {
      title: "Library Film 0",
      year: 2024,
      kind: "movie",
      reason: "A strong pick for tonight.",
      tone: "cosy",
    },
    verified: true,
    tmdbId: 1000,
    title: "Library Film 0",
    year: 2024,
    kind: "movie",
    reason: "A strong pick for tonight.",
    tone: "cosy",
    genres: ["Action"],
    synopsis: null,
    posterUrl: null,
    backdropUrl: null,
    match: {
      compositeId: "movie:100",
      kind: "movie",
      title: "Library Film 0",
      year: 2024,
      catalogueKey: "movie:100",
    },
    ...overrides,
  };
}

const rows = library();
const index = getCatalogIndex("vod", rows, "homes-w5-core-test", { playlistId: "p1" });
const taste = emptyTasteModel("shared", "p1");

function picksRequest(overrides: Record<string, unknown> = {}) {
  return buildHomeAiPicksRequest(index, taste, "movie", {
    trigger: "explicit",
    profileId: "prof",
    playlistId: "p1",
    ...overrides,
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  flags.enabled = true;
  flags.shareTaste = false;
  flags.homeAutoRefresh = false;
  provider.endpoint = "https://api.example.invalid/v1";
  provider.model = "gpt-4o-mini";
  clearAiRankCache();
  clearHomeAiCache();
  clearHomeAiAttempts();
  verifyMock.mockImplementation(async (recs: Array<{ title: string; year: number }>) =>
    recs.map((rec) =>
      verifiedRec({
        title: rec.title,
        year: rec.year,
        generated: { title: rec.title, year: rec.year, kind: "movie", reason: "A strong pick.", tone: "cosy" },
      }),
    ),
  );
});

describe("picks path through the real core", () => {
  it("returns validated, kind-correct picks from a mocked model reply", async () => {
    const chat: AiChatTransport = vi.fn(async () => ({
      text: rankReply(["movie:102", "movie:100", "movie:99999", "series:5"]),
      model: "gpt-4o-mini",
    }));
    const result = await requestHomeAiPicks(picksRequest({ forceFresh: true }), { chat });
    expect(result.source).toBe("fresh-ai");
    expect(result.sentToModelCount).toBeGreaterThan(0);
    expect(result.picks.map((p) => p.compositeId)).toEqual(["movie:102", "movie:100"]);
    expect(result.picks.every((p) => p.kind === "movie")).toBe(true);
    expect(homeAiAllowsSelectorBoost(result)).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("serves a cached answer with zero model calls (no call on load)", async () => {
    const chat: AiChatTransport = vi.fn(async () => ({
      text: rankReply(["movie:101", "movie:100"]),
      model: "gpt-4o-mini",
    }));
    const first = await requestHomeAiPicks(picksRequest({ forceFresh: true }), { chat });
    expect(first.source).toBe("fresh-ai");
    expect(chat).toHaveBeenCalledTimes(1);
    // A fresh mount reads the cache synchronously: zero requests.
    const cached = readCachedHomeAiPicks(picksRequest());
    expect(cached).not.toBeNull();
    expect(cached!.source).toBe("cached-ai");
    expect(cached!.picks.map((p) => p.compositeId)).toEqual(["movie:101", "movie:100"]);
    expect(chat).toHaveBeenCalledTimes(1);
    // And a non-forced request also answers from the cache.
    const second = await requestHomeAiPicks(picksRequest(), { chat });
    expect(second.source).toBe("cached-ai");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("returns ai-unavailable with an honest reason when AI is off, without calling the model", async () => {
    flags.enabled = false;
    const chat: AiChatTransport = vi.fn(async () => ({ text: rankReply(["movie:100"]), model: "gpt-4o-mini" }));
    const result = await requestHomeAiPicks(picksRequest({ forceFresh: true }), { chat });
    expect(result.source).toBe("ai-unavailable");
    expect(result.picks).toEqual([]);
    expect(result.fallbackReason).toBeTruthy();
    expect(homeAiAllowsSelectorBoost(result)).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  it("auto-refresh stays silent when the preference is off", async () => {
    flags.homeAutoRefresh = false;
    const decision = decideHomeAiAutoRefresh(picksRequest({ trigger: "auto-refresh" }));
    expect(decision.shouldRefresh).toBe(false);
    expect(decision.reason).toBe("auto-refresh-off");
    const chat: AiChatTransport = vi.fn(async () => ({ text: rankReply(["movie:100"]), model: "gpt-4o-mini" }));
    await expect(
      maybeAutoRefreshHomeAiPicks(picksRequest({ trigger: "auto-refresh" }), { chat }),
    ).resolves.toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it("auto-refresh fires once when allowed and the cache is empty", async () => {
    flags.homeAutoRefresh = true;
    const chat: AiChatTransport = vi.fn(async () => ({
      text: rankReply(["movie:100"]),
      model: "gpt-4o-mini",
    }));
    const result = await maybeAutoRefreshHomeAiPicks(picksRequest({ trigger: "auto-refresh" }), { chat });
    expect(result).not.toBeNull();
    expect(result!.picks.map((p) => p.compositeId)).toEqual(["movie:100"]);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("discovery path through the real core", () => {
  function discoveryRequest(brief: string, forceFresh = false) {
    return buildHomeAiDiscoveryRequest(index, taste, "movie", {
      brief,
      profileId: "prof",
      playlistId: "p1",
      shareTaste: false,
      forceFresh,
    });
  }

  it("returns verified+matched picks only; verified-but-unmatched titles never become playable", async () => {
    verifyMock.mockImplementation(async (recs: Array<{ title: string; year: number }>) =>
      recs.map((rec) => {
        if (rec.title === "Not In Library") {
          return verifiedRec({ title: rec.title, year: rec.year, tmdbId: 9999, match: null });
        }
        return verifiedRec({ title: rec.title, year: rec.year });
      }),
    );
    const chat: AiChatTransport = vi.fn(async () => ({
      text: generationReply([
        { title: "Library Film 0", year: 2024 },
        { title: "Not In Library", year: 2023 },
      ]),
      model: "gpt-4o-mini",
    }));
    const result = await requestHomeAiDiscovery(discoveryRequest("Something dark and tense"), { chat });
    expect(result.source).toBe("fresh-ai");
    expect(result.picks.map((p) => p.compositeId)).toEqual(["movie:100"]);
    expect(result.verifiedUnmatched.map((v) => v.title)).toEqual(["Not In Library"]);
    expect(result.picks.every((p) => rows.some((r) => String(r.id) === p.id))).toBe(true);
  });

  it("serves a repeat brief from the cache with zero calls; Surprise me forces fresh", async () => {
    const chat: AiChatTransport = vi.fn(async () => ({
      text: generationReply([{ title: "Library Film 0", year: 2024 }]),
      model: "gpt-4o-mini",
    }));
    const first = await requestHomeAiDiscovery(discoveryRequest("A genuinely funny film"), { chat });
    expect(first.source).toBe("fresh-ai");
    expect(chat).toHaveBeenCalledTimes(1);
    const cached = readCachedHomeAiDiscovery(discoveryRequest("A genuinely funny film"));
    expect(cached?.source).toBe("cached-ai");
    expect(chat).toHaveBeenCalledTimes(1);
    const repeat = await requestHomeAiDiscovery(discoveryRequest("A genuinely funny film"), { chat });
    expect(repeat.source).toBe("cached-ai");
    expect(chat).toHaveBeenCalledTimes(1);
    const surprise = await requestHomeAiDiscovery(discoveryRequest("Surprise me", true), { chat });
    expect(surprise.source).toBe("fresh-ai");
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
