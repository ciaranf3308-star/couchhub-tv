// Homes AI wiring tests (0.11.14, W5) — pure behaviour, no mocks,
// no model calls. The W4 core request paths are covered against
// mocked transports in homes-0114-w5-core.test.ts; this file covers
// W5's pool/request assembly, shelf models, variety, honest
// labels, and Discover entry-point scoping.

import { describe, expect, it } from "vitest";
import { getCatalogIndex } from "@/scripts/lib/catalog-index.ts";
import {
  selectHiddenGems,
  selectSomethingDifferent,
} from "@/scripts/lib/collection-selectors.ts";
import { applyVerifiedAiOrder, searchBrowse } from "@/scripts/lib/browse-recommendations.ts";
import type { DiscoverCandidate } from "@/scripts/lib/discover.ts";
import { emptyTasteModel } from "@/scripts/lib/taste.ts";
import {
  buildHomeAiCatalogue,
  buildHomeAiDiscoveryRequest,
  buildHomeAiPicksRequest,
  buildHomeAiPool,
  groundedReasonForAiCard,
  homeAiShelfNote,
  isGenericReason,
  toSelectorPicks,
  HOME_AI_REQUEST_COUNT,
  type HomeAiPick,
} from "@/scripts/lib/home-ai-picks.ts";
import {
  discoverPromptById,
  discoverPromptForcesFresh,
  discoverPromptsFor,
  discoverUrlForPrompt,
  promptGenreFilter,
} from "@/scripts/lib/home-discover-entries.ts";
import {
  filterCandidatesForPrompt,
  localPromptRankedIds,
  promptCandidates,
  resolvePromptItems,
} from "@/scripts/lib/home-prompt-results.ts";
import { allocateShelves } from "@/scripts/lib/home-shelf-variety.ts";
import {
  buildMoviesHomeModel,
  chooseMoviesHomeAiAction,
  AI_PICKS_LIMIT,
} from "@/scripts/movies/movies-home.ts";
import {
  assembleSeriesHomeSections,
  chooseSeriesHomeAiAction,
} from "@/scripts/series/series-home-model.ts";
import { mapSeriesRow, type SeriesRow } from "@/scripts/series/couch-series.ts";
import {
  daysAgoSeconds,
  movieRow,
  resetFixtureIds,
  tasteWith,
} from "./movies-home-0118-fixtures.ts";

const NOW = 1_790_000_000_000;

function aiPick(overrides: Partial<HomeAiPick> = {}): HomeAiPick {
  return {
    compositeId: "movie:100",
    kind: "movie",
    id: "100",
    title: "Library Film 0",
    year: 2024,
    score: 1,
    reason: "Dark, tense, and brilliantly acted.",
    tmdbId: 1000,
    ...overrides,
  };
}

function library() {
  resetFixtureIds(100);
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

function movieIndex(rows: ReturnType<typeof library>) {
  return getCatalogIndex("vod", rows, "homes-w5-test", { playlistId: "p1" });
}

function seriesRow(
  id: number,
  name: string,
  opts: { category?: string; rating?: string; tmdb?: number } = {},
): SeriesRow {
  const mapped = mapSeriesRow({
    series_id: id,
    name,
    cover: `https://example.test/poster-${id}.jpg`,
    year: "2024",
    rating: opts.rating ?? "8.0",
    category_name: opts.category ?? "Drama",
    last_modified: 0,
    tmdb: opts.tmdb ?? id,
  });
  if (!mapped) throw new Error(`fixture row did not map: ${name}`);
  return mapped;
}

// ---------------------------------------------------------------------------
// Adapter: pool + request assembly
// ---------------------------------------------------------------------------

describe("buildHomeAiPool", () => {
  it("returns a relevance-ordered, kind-correct, deduped pool capped at 40", () => {
    const rows = library();
    const pool = buildHomeAiPool(movieIndex(rows), null, "movie");
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.length).toBeLessThanOrEqual(40);
    expect(new Set(pool.map((c) => c.id)).size).toBe(pool.length);
    expect(pool.every((c) => c.kind === "movie")).toBe(true);
    expect(pool.every((c) => rows.some((r) => String(r.id) === c.id))).toBe(true);
  });

  it("applies hard exclusions before the cap", () => {
    const rows = library();
    const pool = buildHomeAiPool(movieIndex(rows), null, "movie", {
      excludeIds: ["100", "101", "102"],
    });
    expect(pool.map((c) => c.id)).not.toContain("100");
    expect(pool.map((c) => c.id)).not.toContain("101");
    expect(pool.map((c) => c.id)).not.toContain("102");
  });

  it("is empty for an empty catalogue", () => {
    const pool = buildHomeAiPool(movieIndex([]), null, "movie");
    expect(pool).toEqual([]);
  });
});

describe("buildHomeAiCatalogue", () => {
  it("covers every group primary of the kind, once", () => {
    const rows = library();
    const catalogue = buildHomeAiCatalogue(movieIndex(rows), "movie");
    expect(catalogue).toHaveLength(30);
    expect(catalogue.every((c) => c.kind === "movie")).toBe(true);
  });
});

describe("buildHomeAiPicksRequest / buildHomeAiDiscoveryRequest", () => {
  it("assembles a core picks request with identity, composite exclusions and count 12", () => {
    const rows = library();
    const taste = tasteWith({ updatedAt: 4242 });
    const request = buildHomeAiPicksRequest(movieIndex(rows), taste, "movie", {
      trigger: "explicit",
      profileId: "prof",
      playlistId: "p1",
      excludeIds: ["100"],
      forceFresh: true,
    });
    expect(request.kind).toBe("movie");
    expect(request.count).toBe(HOME_AI_REQUEST_COUNT);
    expect(HOME_AI_REQUEST_COUNT).toBe(12);
    expect(request.trigger).toBe("explicit");
    expect(request.forceFresh).toBe(true);
    expect(request.excludeCompositeIds).toEqual(["movie:100"]);
    expect(request.tasteRevision).toBe("4242");
    expect(request.catalogueRevision).toBeTruthy();
    expect(request.profileId).toBe("prof");
    expect(request.playlistId).toBe("p1");
    expect(request.candidates.length).toBeGreaterThan(0);
    expect(request.candidates.map((c) => c.id)).not.toContain("100");
  });

  it("formats taste summary only when sharing is allowed", () => {
    const rows = library();
    const taste = tasteWith({ genreWeights: { action: 5 } });
    const shared = buildHomeAiDiscoveryRequest(movieIndex(rows), taste, "movie", {
      brief: "Something dark and tense",
      shareTaste: true,
    });
    expect(shared.tasteSummary).toContain("action");
    expect(shared.brief).toBe("Something dark and tense");
    expect(shared.catalogue).toHaveLength(30);
    const gated = buildHomeAiDiscoveryRequest(movieIndex(rows), taste, "movie", {
      brief: "Something dark and tense",
      shareTaste: false,
    });
    expect(gated.tasteSummary).toBeNull();
  });

  it("passes forceFresh through only when the caller says so", () => {
    const rows = library();
    const plain = buildHomeAiDiscoveryRequest(movieIndex(rows), null, "movie", {
      brief: "A genuinely funny film",
      shareTaste: false,
    });
    expect(plain.forceFresh).toBeUndefined();
    const forced = buildHomeAiDiscoveryRequest(movieIndex(rows), null, "movie", {
      brief: "Surprise me",
      shareTaste: false,
      forceFresh: true,
    });
    expect(forced.forceFresh).toBe(true);
  });
});

describe("toSelectorPicks", () => {
  it("maps core picks to bare ids + 1-based rank + reason, in model order", () => {
    const picks = [
      aiPick({ id: "101", compositeId: "movie:101", reason: "First reason" }),
      aiPick({ id: "100", compositeId: "movie:100", reason: "Second reason" }),
    ];
    expect(toSelectorPicks(picks)).toEqual([
      { id: "101", rank: 1, reason: "First reason" },
      { id: "100", rank: 2, reason: "Second reason" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Grounded reasons + honest shelf notes
// ---------------------------------------------------------------------------

describe("groundedReasonForAiCard", () => {
  it("keeps a specific model reason", () => {
    expect(
      groundedReasonForAiCard({ modelReason: "Dark, tense, and brilliantly acted.", genres: ["Thriller"] }),
    ).toBe("Dark, tense, and brilliantly acted.");
  });

  it("rejects generic reasons and falls back to selector evidence", () => {
    expect(isGenericReason("Because you might like it")).toBe(true);
    expect(isGenericReason("A great choice for tonight")).toBe(true);
    expect(isGenericReason("Ranked by AI for this search.")).toBe(true);
    expect(
      groundedReasonForAiCard({
        modelReason: "Because you might like it",
        selectorReasons: ["Highly rated by viewers who like Thriller"],
        genres: ["Thriller"],
      }),
    ).toBe("Highly rated by viewers who like Thriller");
  });

  it("falls back to genre + rating + year, then the honest neutral label", () => {
    expect(
      groundedReasonForAiCard({ modelReason: null, genres: ["Comedy"], ratingLabel: "★ 8.6", year: "2024" }),
    ).toBe("Comedy · ★ 8.6 · 2024");
    expect(groundedReasonForAiCard({ modelReason: null })).toBe("AI pick from your library");
  });
});

describe("homeAiShelfNote", () => {
  it("derives the label from source only, with a model receipt for real AI results", () => {
    expect(homeAiShelfNote("fresh-ai", "gpt-4o-mini")).toBe("AI picks · gpt-4o-mini");
    expect(homeAiShelfNote("cached-ai", "gpt-4o-mini")).toBe("AI picks · cached · gpt-4o-mini");
    expect(homeAiShelfNote("local-only", "gpt-4o-mini")).toBe("Local recommendations");
    expect(homeAiShelfNote("ai-unavailable", "gpt-4o-mini")).toBe("AI unavailable — local recommendations");
    expect(homeAiShelfNote("fresh-ai")).toBe("AI picks");
  });
});

// ---------------------------------------------------------------------------
// Movies model: AI gating + honest labels
// ---------------------------------------------------------------------------

describe("Movies Home AI shelf", () => {
  function build(overrides: Record<string, unknown> = {}) {
    return buildMoviesHomeModel({
      rows: library(),
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map(),
      nowMs: NOW,
      ...overrides,
    } as never);
  }

  it("shows no AI shelf without aiAllowed, even with picks supplied", () => {
    const model = build({ aiPicks: [aiPick()], aiSource: "fresh-ai" });
    expect(model.aiPicks.items).toEqual([]);
    expect(model.aiPicks.source).toBe("local-only");
  });

  it("shows verified picks in model order when allowed, with the honest source note", () => {
    const picks = [
      aiPick({ id: "102", compositeId: "movie:102", title: "Library Film 2" }),
      aiPick({ id: "100", compositeId: "movie:100", title: "Library Film 0" }),
    ];
    const model = build({ aiPicks: picks, aiAllowed: true, aiSource: "cached-ai", aiModel: "gpt-4o-mini" });
    expect(model.aiPicks.items.map((item) => String(item.row.id))).toEqual(["102", "100"]);
    expect(model.aiPicks.source).toBe("cached-ai");
    expect(model.aiPicks.note).toBe("AI picks · cached · gpt-4o-mini");
    expect(model.aiPicks.items[0].reason).toBe("Dark, tense, and brilliantly acted.");
  });

  it("drops picks naming ids outside the index (model-invented ids never surface)", () => {
    const picks = [
      aiPick({ id: "99999", compositeId: "movie:99999", title: "Invented Film" }),
      aiPick({ id: "100", compositeId: "movie:100" }),
    ];
    const model = build({ aiPicks: picks, aiAllowed: true, aiSource: "fresh-ai" });
    expect(model.aiPicks.items.map((item) => String(item.row.id))).toEqual(["100"]);
  });

  it("caps the AI shelf at AI_PICKS_LIMIT", () => {
    const picks = Array.from({ length: 30 }, (_, i) =>
      aiPick({ id: String(100 + i), compositeId: `movie:${100 + i}`, title: `Library Film ${i}` }),
    );
    const model = build({ aiPicks: picks, aiAllowed: true, aiSource: "fresh-ai" });
    expect(model.aiPicks.items.length).toBeLessThanOrEqual(AI_PICKS_LIMIT);
  });

  it("never labels Worth Watching as AI-generated", () => {
    const model = build({ aiPicks: [aiPick()], aiAllowed: true, aiSource: "fresh-ai" });
    expect(model.worthWatching.label.toLowerCase()).not.toContain("ai");
    expect(model.worthWatching.label.toLowerCase()).not.toContain("personalised");
    expect(model.worthWatching.label.toLowerCase()).not.toContain("personalized");
  });

  it("chooses Generate vs Request-fresh vs none honestly", () => {
    expect(chooseMoviesHomeAiAction({ aiConfigured: false, hasVerifiedPicks: false }).kind).toBe("none");
    const generate = chooseMoviesHomeAiAction({ aiConfigured: true, hasVerifiedPicks: false });
    expect(generate.kind).toBe("generate");
    expect(generate.label).toContain("Generate");
    const fresh = chooseMoviesHomeAiAction({ aiConfigured: true, hasVerifiedPicks: true });
    expect(fresh.kind).toBe("request-fresh");
    expect(fresh.hint.toLowerCase()).toContain("request");
  });
});

// ---------------------------------------------------------------------------
// Series model: series→series, Worth Starting exclusion, honest labels
// ---------------------------------------------------------------------------

describe("Series Home AI shelves", () => {
  const rows = [
    seriesRow(1, "Drama Hit", { category: "Drama", rating: "8.6", tmdb: 11 }),
    seriesRow(2, "Comedy Hit", { category: "Comedy", rating: "8.2", tmdb: 12 }),
    seriesRow(3, "Crime Hit", { category: "Crime", rating: "8.4", tmdb: 13 }),
  ];
  const byId = new Map(rows.map((r) => [r.id, r]));

  function assemble(overrides: Record<string, unknown> = {}) {
    return assembleSeriesHomeSections({
      index: getCatalogIndex("series", rows, "homes-w5-series-test", {}),
      rowsById: byId,
      continueInputs: [],
      notificationGroups: [],
      subscriptions: [],
      taste: null,
      startedIds: [],
      ...overrides,
    } as never);
  }

  function seriesPick(id: string, title: string): HomeAiPick {
    return {
      compositeId: `series:${id}`,
      kind: "series",
      id,
      title,
      year: 2024,
      score: 1,
      reason: "Gripping from the first episode.",
      tmdbId: Number(id),
    };
  }

  it("shows no ai-picks section without aiAllowed", () => {
    const kinds = assemble({ aiPicks: [seriesPick("1", "Drama Hit")], aiSource: "fresh-ai" }).map((s) => s.kind);
    expect(kinds).not.toContain("ai-picks");
  });

  it("renders AI picks as series items (series rows only, never episode ids)", () => {
    const sections = assemble({
      aiPicks: [seriesPick("2", "Comedy Hit"), seriesPick("1", "Drama Hit")],
      aiAllowed: true,
      aiSource: "fresh-ai",
    });
    const ai = sections.find((s) => s.kind === "ai-picks") as Extract<
      (typeof sections)[number],
      { kind: "ai-picks" }
    >;
    expect(ai).toBeTruthy();
    expect(ai.items.map((item) => item.row.id)).toEqual([2, 1]);
    expect(ai.items.every((item) => byId.has(item.row.id))).toBe(true);
    expect(ai.source).toBe("fresh-ai");
  });

  it("drops picks naming episode-like or non-index ids", () => {
    const sections = assemble({
      aiPicks: [
        seriesPick("1-1-5", "Episode 5"),
        seriesPick("999", "Not in the library"),
        seriesPick("3", "Crime Hit"),
      ],
      aiAllowed: true,
      aiSource: "fresh-ai",
    });
    const ai = sections.find((s) => s.kind === "ai-picks") as Extract<
      (typeof sections)[number],
      { kind: "ai-picks" }
    >;
    expect(ai.items.map((item) => item.row.id)).toEqual([3]);
  });

  it("excludes started series from Worth Starting", () => {
    const sections = assemble({ startedIds: ["1"] });
    const worth = sections.find((s) => s.kind === "worth-starting") as Extract<
      (typeof sections)[number],
      { kind: "worth-starting" }
    >;
    expect(worth).toBeTruthy();
    // worth-starting items are SeriesRow[] (not shelf items).
    expect(worth.items.map((item) => item.id)).not.toContain(1);
  });

  it("shows the Generate prompt (not a shelf) when configured but no picks exist", () => {
    const sections = assemble({ aiConfigured: true });
    const kinds = sections.map((s) => s.kind);
    expect(kinds).not.toContain("ai-picks");
    expect(kinds).toContain("ai-prompt");
    expect(chooseSeriesHomeAiAction({ aiConfigured: true, hasVerifiedPicks: false }).kind).toBe("generate");
    expect(chooseSeriesHomeAiAction({ aiConfigured: true, hasVerifiedPicks: true }).kind).toBe("request-fresh");
    expect(chooseSeriesHomeAiAction({ aiConfigured: false, hasVerifiedPicks: false }).kind).toBe("none");
  });

  it("always includes Discover entry points, even with AI off", () => {
    const kinds = assemble().map((s) => s.kind);
    expect(kinds).toContain("discover-entries");
  });
});

// ---------------------------------------------------------------------------
// Shelf variety: allocation, Something Different, Hidden Gems
// ---------------------------------------------------------------------------

describe("allocateShelves", () => {
  const item = (id: string) => ({ id });

  it("dedups across shelves in priority order without starving later shelves that have their own titles", () => {
    const allocated = allocateShelves([
      { id: "ai", items: [item("a"), item("b")], limit: 2 },
      { id: "worth", items: [item("a"), item("c"), item("d")], limit: 2 },
      { id: "recent", items: [item("a"), item("e")], limit: 2 },
    ]);
    const byId = new Map(allocated.map((s) => [s.id, s.items.map((i) => i.id)]));
    expect(byId.get("ai")).toEqual(["a", "b"]);
    expect(byId.get("worth")).toEqual(["c", "d"]);
    expect(byId.get("recent")).toEqual(["e"]);
  });

  it("backfills a factual shelf to minFill from its own pool when strict dedup would starve it", () => {
    const allocated = allocateShelves([
      { id: "ai", items: [item("a"), item("b"), item("c"), item("d")], limit: 4 },
      { id: "recent", items: [item("a"), item("b"), item("c"), item("d"), item("e")], limit: 4, minFill: 4 },
    ]);
    const recent = allocated.find((s) => s.id === "recent")!;
    expect(recent.items.length).toBe(4);
    expect(recent.items.map((i) => i.id)).toContain("e");
  });

  it("leaves recommendation shelves strict (empty is omitted, never padded)", () => {
    const allocated = allocateShelves([
      { id: "ai", items: [item("a")], limit: 1 },
      { id: "different", items: [item("a")], limit: 4 },
    ]);
    expect(allocated.find((s) => s.id === "different")!.items).toEqual([]);
  });

  it("passes exempt shelves through untouched and never marks their ids seen", () => {
    const allocated = allocateShelves([
      { id: "continue", items: [item("a"), item("b")], limit: 8, exempt: true },
      { id: "worth", items: [item("a"), item("c")], limit: 2 },
    ]);
    expect(allocated.find((s) => s.id === "worth")!.items.map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("selectSomethingDifferent", () => {
  it("favours titles outside the strongest taste genre, with a quality floor", () => {
    const rows: ReturnType<typeof movieRow>[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(movieRow({ id: 200 + i, name: `Action ${i}`, category: "Action", rating: "8.8", tmdb: 200 + i }));
    }
    for (let i = 0; i < 10; i++) {
      rows.push(movieRow({ id: 300 + i, name: `Comedy ${i}`, category: "Comedy", rating: "8.8", tmdb: 300 + i }));
    }
    const taste = tasteWith({ genreWeights: { action: 10 } });
    const results = selectSomethingDifferent(movieIndex(rows), taste, 8);
    expect(results.length).toBeGreaterThan(0);
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const nonAction = results.filter((r) => byId.get(r.id)?.category !== "Action");
    expect(nonAction.length).toBeGreaterThanOrEqual(results.length / 2);
    expect(results.every((r) => r.reasons.some((reason) => reason.length > 0))).toBe(true);
  });

  it("never surfaces poor-quality titles as 'different'", () => {
    const rows = [
      movieRow({ id: 400, name: "Good Drama", category: "Drama", rating: "8.5", tmdb: 400 }),
      movieRow({ id: 401, name: "Poor Drama", category: "Drama", rating: "3.0", tmdb: 401 }),
    ];
    const results = selectSomethingDifferent(
      movieIndex(rows),
      tasteWith({ genreWeights: { action: 10 } }),
      4,
    );
    expect(results.map((r) => r.id)).not.toContain("401");
  });
});

describe("selectHiddenGems", () => {
  it("never calls a provider-rating-10-no-votes title a gem", () => {
    const rows = [
      movieRow({ id: 500, name: "Suspicious Ten", category: "Drama", rating: "10", tmdb: null }),
      movieRow({ id: 501, name: "Solid Gem", category: "Drama", rating: "8.4", tmdb: 501 }),
    ];
    const results = selectHiddenGems(movieIndex(rows), null, 4);
    expect(results.map((r) => r.id)).not.toContain("500");
  });
});

describe("cross-shelf repetition in the Movies model", () => {
  it("does not repeat the same five titles in every row", () => {
    const model = buildMoviesHomeModel({
      rows: library(),
      playlistId: "p1",
      taste: emptyTasteModel("shared", "p1"),
      progressById: new Map(),
      nowMs: NOW,
      aiPicks: [
        aiPick({ id: "100", compositeId: "movie:100" }),
        aiPick({ id: "101", compositeId: "movie:101" }),
      ],
      aiAllowed: true,
      aiSource: "fresh-ai",
    });
    const shelves = [
      model.aiPicks.items.map((i) => String(i.row.id)),
      model.worthWatching.items.map((r) => String(r.id)),
      model.somethingDifferent.items.map((i) => String(i.row.id)),
      model.hiddenGems.items.map((i) => String(i.row.id)),
    ];
    // No title appears in more than two recommendation shelves.
    const counts = new Map<string, number>();
    for (const shelf of shelves) {
      for (const id of new Set(shelf)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [, count] of counts) expect(count).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Discover entry points: scoping, force-fresh, local fallback
// ---------------------------------------------------------------------------

describe("Discover entry points", () => {
  it("are kind-scoped: movie prompts never mention series and vice versa", () => {
    expect(discoverPromptsFor("movie")).toHaveLength(6);
    expect(discoverPromptsFor("series")).toHaveLength(6);
    expect(discoverPromptById("movie", "crime")).toBeNull();
    expect(discoverPromptById("series", "dark-tense")).toBeNull();
    expect(discoverPromptById("movie", "under-two-hours")?.maxRuntimeMinutes).toBe(120);
  });

  it("only 'Surprise me' forces a fresh discovery request", () => {
    for (const prompt of [...discoverPromptsFor("movie"), ...discoverPromptsFor("series")]) {
      expect(discoverPromptForcesFresh(prompt)).toBe(prompt.id === "surprise");
    }
  });

  it("builds kind-scoped Discover URLs (forward contract)", () => {
    const prompt = discoverPromptById("series", "crime")!;
    expect(discoverUrlForPrompt(prompt, "series")).toBe(
      "/discover?q=A+gripping+crime+series&kind=series",
    );
  });

  it("keeps genre filters synonym-aware and falls back to the full pool when thin", () => {
    const rows = library();
    const candidates = promptCandidates(movieIndex(rows), "movie");
    expect(candidates).toHaveLength(30);
    const sciFi = discoverPromptById("movie", "sci-fi")!;
    expect(promptGenreFilter(sciFi)).toEqual(["Science Fiction"]);
    const filtered = filterCandidatesForPrompt(candidates, sciFi);
    // 5 Science Fiction titles in the fixture library: exactly the fallback threshold.
    expect(filtered.length).toBeGreaterThanOrEqual(5);
    expect(filtered.every((c) => c.kind === "movie")).toBe(true);
    const rare = filterCandidatesForPrompt(candidates, {
      id: "rare",
      label: "Rare genre",
      genres: ["Western"],
    });
    expect(rare).toHaveLength(30);
  });

  it("ranks local fallback results within the kind only", () => {
    const rows = library();
    const ids = localPromptRankedIds(
      movieIndex(rows),
      null,
      "movie",
      discoverPromptById("movie", "funny")!,
      "p1",
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => rows.some((r) => String(r.id) === id))).toBe(true);
  });

  it("resolvePromptItems resolves to group primaries, dedups, and drops non-index ids", () => {
    const rows = library();
    const index = movieIndex(rows);
    const items = resolvePromptItems(index, [{ id: "100" }, { id: 100 }, { id: "99999" }, { id: "101" }], () => "reason");
    expect(items.map((item) => item.row.id)).toEqual([100, 101]);
    expect(items[0].reason).toBe("reason");
  });
});

describe("applyVerifiedAiOrder", () => {
  function ranked(ids: string[], kind: "movie" | "series" = "movie") {
    return ids.map((id, i) => ({
      candidate: {
        id,
        kind,
        title: `Title ${id}`,
        genres: [],
        cast: [],
        source: "catalog",
      } as DiscoverCandidate,
      score: 1 - i * 0.1,
      reason: "local",
    }));
  }

  it("reorders ranked results by verified picks, keeps unranked local order after, drops picks outside the set", () => {
    const out = applyVerifiedAiOrder(
      ranked(["1", "2", "3"]),
      [
        { id: "3", kind: "movie", rank: 1 },
        { id: "1", kind: "movie", rank: 2 },
        { id: "9", kind: "movie", rank: 3 },
      ],
      "movie",
    );
    expect(out.map((r) => r.candidate.id)).toEqual(["3", "1", "2"]);
  });

  it("enforces kind separation and leaves local order untouched without picks", () => {
    const out = applyVerifiedAiOrder(
      ranked(["1", "2"]),
      [{ id: "2", kind: "series", rank: 1 }],
      "movie",
    );
    expect(out.map((r) => r.candidate.id)).toEqual(["1", "2"]);
    expect(applyVerifiedAiOrder(ranked(["1", "2"]), null, "movie").map((r) => r.candidate.id)).toEqual(["1", "2"]);
  });

  it("does not reorder when the default local path runs (searchBrowse stays local-only)", () => {
    const rows = library();
    const pool = promptCandidates(movieIndex(rows), "movie");
    const results = searchBrowse("comedy", pool, undefined, { kind: "movie", limit: 5 }, "p1");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.candidate.kind === "movie")).toBe(true);
  });
});
