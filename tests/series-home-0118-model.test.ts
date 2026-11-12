// Series Home model tests (0.11.8, W4) — pure builders: Continue
// Watching safety, New Episodes honesty, Followed fallback, genre
// tiles, section assembly/omission, honest labelling.

import { describe, expect, it } from "vitest";
import {
  groupEpisodesBySeason,
  mapSeriesRow,
  type SeriesRow,
} from "@/scripts/series/couch-series.ts";
import { getCatalogIndex } from "@/scripts/lib/catalog-index.ts";
import type {
  FollowedNotificationGroup,
  FollowedSubscription,
} from "@/scripts/lib/followed.ts";
import {
  assembleSeriesHomeSections,
  buildContinueWatching,
  buildContinueWatchingItem,
  buildFollowedShelfItems,
  buildNewEpisodeItems,
  buildSeriesGenreTiles,
  formatDetectedLabel,
  seriesDetailHref,
  seriesHomeCardMeta,
  type ContinueWatchingInput,
} from "@/scripts/series/series-home-model.ts";

function row(
  id: number,
  name: string,
  opts: {
    category?: string;
    rating?: string;
    year?: string;
    added?: number;
    tmdb?: number;
    logo?: string | null;
  } = {},
): SeriesRow {
  const mapped = mapSeriesRow({
    series_id: id,
    name,
    cover: opts.logo === undefined ? `https://example.test/poster-${id}.jpg` : opts.logo,
    year: opts.year ?? "2024",
    rating: opts.rating ?? "",
    category_name: opts.category ?? "Drama",
    last_modified: opts.added ?? 0,
    tmdb: opts.tmdb ?? 0,
  });
  if (!mapped) throw new Error(`fixture row did not map: ${name}`);
  return mapped;
}

function episodePayload(
  episodes: Array<{ id: number; season: number; num: number; title?: string }>,
): unknown {
  const bySeason: Record<string, unknown[]> = {};
  for (const ep of episodes) {
    const key = String(ep.season);
    (bySeason[key] ??= []).push({
      id: ep.id,
      season: ep.season,
      episode_num: ep.num,
      title: ep.title ?? `Episode ${ep.num}`,
      info: {},
    });
  }
  return { episodes: bySeason };
}

function continueInput(
  series: SeriesRow,
  opts: Partial<ContinueWatchingInput> = {},
): ContinueWatchingInput {
  return {
    row: series,
    lastProgress: null,
    hasIncompleteEpisode: false,
    completedIds: [],
    cachedGroup: null,
    progressByEpisodeId: new Map(),
    ...opts,
  };
}

function group(sub: Partial<FollowedNotificationGroup>): FollowedNotificationGroup {
  return {
    id: "g1",
    playlistId: "pl1",
    seriesId: "101",
    seriesTitle: "Followed Show",
    posterUrl: "https://example.test/followed.jpg",
    episodes: [],
    detectedAt: "2026-11-10T10:00:00.000Z",
    read: false,
    dismissed: false,
    ...sub,
  };
}

function sub(partial: Partial<FollowedSubscription>): FollowedSubscription {
  return {
    key: "pl1::101",
    playlistId: "pl1",
    seriesId: "101",
    seriesTitle: "Followed Show",
    posterUrl: "https://example.test/followed.jpg",
    sourceKind: "xtream",
    followedAt: "2026-11-01T00:00:00.000Z",
    baseline: [],
    baselineUpdatedAt: "2026-11-01T00:00:00.000Z",
    lastCheckAt: null,
    lastCheckStatus: "ok",
    consecutiveFailures: 0,
    nextCheckNotBefore: null,
    needsRebaseline: false,
    ...partial,
  };
}

describe("buildContinueWatchingItem — never play the wrong episode", () => {
  it("resumes the exact in-progress episode named by the progress entry", () => {
    const series = row(1, "Slow Horses");
    const item = buildContinueWatchingItem(
      continueInput(series, {
        lastProgress: {
          episodeId: 9001,
          season: 2,
          episodeNum: 4,
          episodeTitle: "The Trap",
          position: 1500,
          duration: 2400,
          completed: false,
          updatedAt: 1000,
        },
        hasIncompleteEpisode: true,
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.actionLabel).toBe("Continue");
    expect(item!.episodeLabel).toBe("S2 E4");
    expect(item!.episodeReliable).toBe(true);
    expect(item!.href).toBe("/series/detail?id=1&season=2&epnum=4&autoplay=1");
    expect(item!.progressFraction).toBeCloseTo(0.625);
    expect(item!.subtitle).toBe("Continue · S2 E4 · 63%");
    expect(item!.subtitle).toContain("S2 E4");
  });

  it("derives the next episode ONLY from the cached episode list", () => {
    const series = row(2, "The Office");
    const cachedGroup = groupEpisodesBySeason(
      episodePayload([
        { id: 11, season: 1, num: 1 },
        { id: 12, season: 1, num: 2, title: "Second One" },
        { id: 13, season: 1, num: 3 },
      ]),
    );
    const item = buildContinueWatchingItem(
      continueInput(series, {
        lastProgress: {
          episodeId: 11,
          season: 1,
          episodeNum: 1,
          position: 2400,
          duration: 2400,
          completed: true,
          updatedAt: 2000,
        },
        completedIds: [11],
        cachedGroup,
        progressByEpisodeId: new Map([[11, { completed: true }]]),
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.actionLabel).toBe("Watch next episode");
    expect(item!.episodeLabel).toBe("S1 E2");
    expect(item!.subtitle).toBe("Next up · S1 E2 · Second One");
    expect(item!.href).toBe("/series/detail?id=2&season=1&epnum=2&autoplay=1");
  });

  it("opens the detail page (no autoplay) when no next episode is provable", () => {
    const series = row(3, "Mystery Show");
    const item = buildContinueWatchingItem(
      continueInput(series, {
        lastProgress: {
          episodeId: 21,
          season: 3,
          episodeNum: 2,
          position: 2400,
          duration: 2400,
          completed: true,
          updatedAt: 3000,
        },
        hasIncompleteEpisode: true,
        completedIds: [21],
        cachedGroup: null,
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.actionLabel).toBe("Open series");
    expect(item!.episodeReliable).toBe(false);
    expect(item!.href).toBe("/series/detail?id=3");
    expect(item!.href).not.toContain("autoplay");
    expect(item!.subtitle).toContain("S3 E2");
  });

  it("excludes a series with no history at all", () => {
    expect(buildContinueWatchingItem(continueInput(row(4, "Untouched")))).toBeNull();
  });

  it("excludes a series provably fully watched against the cached list", () => {
    const series = row(5, "Finished Show");
    const cachedGroup = groupEpisodesBySeason(
      episodePayload([
        { id: 31, season: 1, num: 1 },
        { id: 32, season: 1, num: 2 },
      ]),
    );
    const item = buildContinueWatchingItem(
      continueInput(series, {
        lastProgress: {
          episodeId: 32,
          season: 1,
          episodeNum: 2,
          position: 100,
          duration: 100,
          completed: true,
          updatedAt: 4000,
        },
        completedIds: [31, 32],
        cachedGroup,
        progressByEpisodeId: new Map([
          [31, { completed: true }],
          [32, { completed: true }],
        ]),
      }),
    );
    expect(item).toBeNull();
  });

  it("excludes completions-only series with no cached list and nothing unfinished", () => {
    const series = row(6, "Done, Unproven");
    expect(
      buildContinueWatchingItem(
        continueInput(series, {
          lastProgress: {
            episodeId: 41,
            season: 1,
            episodeNum: 1,
            position: 100,
            duration: 100,
            completed: true,
            updatedAt: 5000,
          },
          completedIds: [41],
        }),
      ),
    ).toBeNull();
  });

  it("never invents an episode title: subtitle falls back to the S/E code", () => {
    const series = row(7, "No Titles");
    const item = buildContinueWatchingItem(
      continueInput(series, {
        lastProgress: {
          episodeId: 51,
          season: 1,
          episodeNum: 3,
          position: 10,
          duration: 100,
          completed: false,
          updatedAt: 6000,
        },
        hasIncompleteEpisode: true,
      }),
    );
    expect(item!.episodeTitle).toBeNull();
    expect(item!.subtitle).toBe("Continue · S1 E3 · 10%");
  });

  it("cold cache without S/E still shows the known progress fraction (§4.2)", () => {
    // 0.11.8 integration fix (screenshot gate): the detail-fallback
    // path used to discard the position/duration from the record, so
    // the shelf showed a generic subtitle and no progress bar even
    // though the fraction through the last-watched episode was known.
    // The episode stays unreliable (no S/E claim), the % is honest.
    const series = row(8, "Cold Cache Show");
    const item = buildContinueWatchingItem(
      continueInput(series, {
        lastProgress: {
          episodeId: 61,
          season: null,
          episodeNum: null,
          position: 900,
          duration: 2400,
          completed: false,
          updatedAt: 7000,
        },
        hasIncompleteEpisode: true,
      }),
    );
    expect(item).not.toBeNull();
    expect(item!.episodeReliable).toBe(false);
    expect(item!.progressFraction).toBeCloseTo(0.375, 6);
    expect(item!.subtitle).toBe("Pick up where you left off · 38% into the episode");
    expect(item!.actionLabel).toBe("Open series");
    expect(item!.href).toBe(seriesDetailHref(8));
  });

  it("orders most-recently-touched first and caps the shelf", () => {
    const mk = (id: number, at: number) =>
      continueInput(row(id, `Show ${id}`), {
        lastProgress: {
          episodeId: id * 100,
          season: 1,
          episodeNum: 1,
          position: 10,
          duration: 100,
          completed: false,
          updatedAt: at,
        },
        hasIncompleteEpisode: true,
      });
    const items = buildContinueWatching([mk(1, 100), mk(2, 300), mk(3, 200)], 2);
    expect(items.map((i) => i.row.id)).toEqual([2, 3]);
  });
});

describe("buildNewEpisodeItems — genuine detections, honest wording", () => {
  it("surfaces unread episodes with detection wording, S/E and title", () => {
    const items = buildNewEpisodeItems([
      group({
        episodes: [
          {
            seriesId: "101",
            seriesTitle: "Followed Show",
            season: 3,
            episode: 2,
            episodeTitle: "The Return",
            episodeId: 777,
            detectedAt: "2026-11-10T10:00:00.000Z",
            watched: false,
          },
        ],
      }),
    ]);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.seriesTitle).toBe("Followed Show");
    expect(item.subtitle).toBe("S3 E2 · The Return");
    expect(item.detectedLabel.startsWith("Detected ")).toBe(true);
    expect(item.detectedLabel).toContain("2026");
    // Badge carries status + detection date (the visible line holds
    // S/E + title, so the date must live on the badge to be seen).
    expect(item.badgeLabel).toMatch(/^New · /);
    expect(item.badgeLabel).toContain("Nov");
    expect(item.badgeLabel).toMatch(/\b10\b/);
    expect(item.watchHref).toBe("/series/detail?id=101&season=3&epnum=2&autoplay=1");
    expect(item.openHref).toBe("/series/detail?id=101");
  });

  it("never labels detection as a premiere, airing or release", () => {
    const items = buildNewEpisodeItems([
      group({
        episodes: [
          {
            seriesId: "101",
            seriesTitle: "Followed Show",
            season: 1,
            episode: 1,
            episodeId: 1,
            detectedAt: "2026-11-10T10:00:00.000Z",
            watched: false,
          },
        ],
      }),
    ]);
    const text = JSON.stringify(items).toLowerCase();
    expect(text).not.toContain("premier");
    expect(text).not.toContain("aired");
    expect(text).not.toContain("air date");
    expect(text).not.toContain("released");
  });

  it("excludes read and dismissed groups entirely", () => {
    const items = buildNewEpisodeItems([
      group({ id: "r", read: true, episodes: [
        { seriesId: "101", seriesTitle: "Followed Show", season: 1, episode: 1, episodeId: 1, detectedAt: "2026-11-10T10:00:00.000Z", watched: false },
      ] }),
      group({ id: "d", dismissed: true, episodes: [
        { seriesId: "101", seriesTitle: "Followed Show", season: 1, episode: 2, episodeId: 2, detectedAt: "2026-11-10T10:00:00.000Z", watched: false },
      ] }),
    ]);
    expect(items).toEqual([]);
  });

  it("excludes watched episodes when the caller supplies a watched check", () => {
    const items = buildNewEpisodeItems(
      [
        group({
          episodes: [
            { seriesId: "101", seriesTitle: "Followed Show", season: 1, episode: 1, episodeId: 1, detectedAt: "2026-11-10T10:00:00.000Z", watched: false },
            { seriesId: "101", seriesTitle: "Followed Show", season: 1, episode: 2, episodeId: 2, detectedAt: "2026-11-10T10:00:00.000Z", watched: false },
          ],
        }),
      ],
      { isWatched: (_s, _se, ep) => ep === 1 },
    );
    expect(items.map((i) => i.episode)).toEqual([2]);
  });

  it("orders newest detection first and dedupes identical detections", () => {
    const items = buildNewEpisodeItems([
      group({
        id: "old",
        detectedAt: "2026-11-09T10:00:00.000Z",
        episodes: [
          { seriesId: "101", seriesTitle: "Followed Show", season: 1, episode: 1, episodeId: 1, detectedAt: "2026-11-09T10:00:00.000Z", watched: false },
        ],
      }),
      group({
        id: "new",
        detectedAt: "2026-11-11T10:00:00.000Z",
        seriesId: "102",
        seriesTitle: "Other Show",
        episodes: [
          { seriesId: "102", seriesTitle: "Other Show", season: 2, episode: 5, episodeId: 5, detectedAt: "2026-11-11T10:00:00.000Z", watched: false },
        ],
      }),
      group({
        id: "dup",
        detectedAt: "2026-11-11T10:00:00.000Z",
        seriesId: "102",
        seriesTitle: "Other Show",
        episodes: [
          { seriesId: "102", seriesTitle: "Other Show", season: 2, episode: 5, episodeId: 5, detectedAt: "2026-11-11T10:00:00.000Z", watched: false },
        ],
      }),
    ]);
    expect(items.map((i) => i.seriesId)).toEqual(["102", "101"]);
  });

  it("formatDetectedLabel degrades honestly for a bad timestamp", () => {
    expect(formatDetectedLabel("not-a-date")).toBe("Detected recently");
    expect(formatDetectedLabel("2026-11-12T09:30:00.000Z")).toMatch(/^Detected /);
  });

  it("badge falls back to plain New when the timestamp is unusable", () => {
    const items = buildNewEpisodeItems([
      group({
        detectedAt: "not-a-date",
        episodes: [
          { seriesId: "101", seriesTitle: "Followed Show", season: 1, episode: 1, episodeId: 1, detectedAt: "not-a-date", watched: false },
        ],
      }),
    ]);
    expect(items[0].badgeLabel).toBe("New");
    expect(items[0].detectedLabel).toBe("Detected recently");
  });
});

describe("buildFollowedShelfItems — compact fallback shelf", () => {
  it("prefers catalogue rows and falls back to subscription data", () => {
    const catalogue = row(101, "Followed Show", { category: "Drama", year: "2023" });
    const items = buildFollowedShelfItems(
      [
        sub({ seriesId: "101", seriesTitle: "Followed Show" }),
        sub({ key: "pl1::999", seriesId: "999", seriesTitle: "Gone From Catalogue", posterUrl: null }),
      ],
      new Map([[101, catalogue]]),
    );
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Followed Show");
    expect(items[0].posterUrl).toBe(catalogue.logo);
    expect(items[0].href).toBe("/series/detail?id=101");
    expect(items[1].title).toBe("Gone From Catalogue");
    expect(items[1].posterUrl).toBeNull();
    expect(items[1].href).toBe("/series/detail?id=999");
  });

  it("sorts by title", () => {
    const items = buildFollowedShelfItems(
      [
        sub({ key: "pl1::2", seriesId: "2", seriesTitle: "Zebra" }),
        sub({ key: "pl1::1", seriesId: "1", seriesTitle: "Apple" }),
      ],
      new Map(),
    );
    expect(items.map((i) => i.title)).toEqual(["Apple", "Zebra"]);
  });
});

describe("buildSeriesGenreTiles — television families, real counts", () => {
  function tilesFor(rows: SeriesRow[]) {
    return buildSeriesGenreTiles(
      getCatalogIndex("series", rows, "series-home-model-test", {}),
    );
  }

  it("counts real members per family and omits empty families", () => {
    const tiles = tilesFor([
      row(1, "Drama One", { category: "Drama" }),
      row(2, "Drama Two", { category: "Drama" }),
      row(3, "Funny", { category: "Comedy" }),
    ]);
    const byId = new Map(tiles.map((t) => [t.family.id, t]));
    expect(byId.get("drama")?.count).toBe(2);
    expect(byId.get("comedy")?.count).toBe(1);
    expect(byId.has("horror")).toBe(false);
    expect(tiles.length).toBe(2);
  });

  it("counts multi-genre membership non-exclusively: a Documentary Crime series counts in both families", () => {
    // D22: the W4 C1 documentary-kind rule is dropped — tile counts
    // come from the same W1 genre buckets Browse uses, so a tile
    // count always equals the Browse result count for that family.
    const tiles = tilesFor([
      row(1, "Crime Doc", { category: "Documentary Crime" }),
    ]);
    const byId = new Map(tiles.map((t) => [t.family.id, t]));
    expect(byId.get("documentary")?.count).toBe(1);
    expect(byId.get("crime")?.count).toBe(1);
  });

  it("matches Reality on the provider category, not the title", () => {
    const tiles = tilesFor([
      row(1, "Reality Bites", { category: "Comedy" }),
      row(2, "Bake Off", { category: "Reality TV" }),
    ]);
    const reality = tiles.find((t) => t.family.id === "reality");
    expect(reality?.count).toBe(1);
  });

  it("uses real catalogue artwork or none — never placeholder art", () => {
    const tiles = tilesFor([
      row(1, "Top Drama", { category: "Drama", rating: "9.0", tmdb: 5, logo: "https://example.test/top.jpg" }),
      row(2, "Lesser Drama", { category: "Drama", rating: "6.0", logo: "https://example.test/lesser.jpg" }),
      row(3, "No Art Comedy", { category: "Comedy", logo: null }),
    ]);
    const drama = tiles.find((t) => t.family.id === "drama");
    expect(drama?.artworkUrl).toBe("https://example.test/top.jpg");
    expect(drama?.artworkTitle).toBe("Top Drama");
    const comedy = tiles.find((t) => t.family.id === "comedy");
    expect(comedy?.artworkUrl).toBeNull();
    expect(comedy?.artworkTitle).toBeNull();
  });
});

describe("assembleSeriesHomeSections — order and omission", () => {
  const baseRows = [
    row(1, "Drama Hit", { category: "Drama", rating: "8.6", tmdb: 11, added: 100 }),
    row(2, "Comedy Hit", { category: "Comedy", rating: "8.2", tmdb: 12, added: 200 }),
  ];
  const byId = new Map(baseRows.map((r) => [r.id, r]));

  function assemble(overrides: Record<string, unknown> = {}) {
    return assembleSeriesHomeSections({
      index: getCatalogIndex("series", baseRows, "series-home-model-test", {}),
      rowsById: byId,
      continueInputs: [],
      notificationGroups: [],
      subscriptions: [],
      taste: null,
      startedIds: [],
      ...overrides,
    } as never);
  }

  it("omits Continue Watching with no history and New Episodes with no detections", () => {
    const kinds = assemble().map((s) => s.kind);
    expect(kinds).not.toContain("continue");
    expect(kinds).not.toContain("new-episodes");
    expect(kinds).not.toContain("followed");
    expect(kinds).toContain("worth-starting");
    expect(kinds).toContain("recently-added");
    expect(kinds).toContain("genres");
    expect(kinds[kinds.length - 1]).toBe("browse-entry");
  });

  it("orders Continue first, then New Episodes, then the rest", () => {
    const sections = assemble({
      continueInputs: [
        continueInput(baseRows[0], {
          lastProgress: { episodeId: 1, season: 1, episodeNum: 1, position: 10, duration: 100, completed: false, updatedAt: 9 },
          hasIncompleteEpisode: true,
        }),
      ],
      notificationGroups: [
        group({
          episodes: [
            { seriesId: "101", seriesTitle: "Followed Show", season: 1, episode: 1, episodeId: 1, detectedAt: "2026-11-10T10:00:00.000Z", watched: false },
          ],
        }),
      ],
      subscriptions: [sub({})],
    });
    expect(sections.map((s) => s.kind).slice(0, 2)).toEqual(["continue", "new-episodes"]);
  });

  it("shows the Followed shelf INSTEAD of New Episodes when followed but quiet", () => {
    const kinds = assemble({ subscriptions: [sub({})] }).map((s) => s.kind);
    expect(kinds).toContain("followed");
    expect(kinds).not.toContain("new-episodes");
  });

  it("yields no sections for an empty catalogue", () => {
    expect(
      assembleSeriesHomeSections({
        index: getCatalogIndex("series", [], "series-home-model-empty", {}),
        rowsById: new Map(),
        continueInputs: [],
        notificationGroups: [],
        subscriptions: [],
        taste: null,
        startedIds: [],
      }),
    ).toEqual([]);
  });

  it("never labels a shelf as AI picks or personalised", () => {
    const text = JSON.stringify(assemble());
    expect(text).not.toMatch(/\bAI picks\b/);
    expect(text).not.toMatch(/\bAI\b/);
    expect(text.toLowerCase()).not.toContain("personalised");
    expect(text.toLowerCase()).not.toContain("personalized");
    expect(text.toLowerCase()).not.toContain("picked for you");
  });

  it("Worth Starting entries are series-level and exclude in-progress series", () => {
    const sections = assemble({ startedIds: ["1"] });
    const worth = sections.find((s) => s.kind === "worth-starting");
    expect(worth && "items" in worth ? worth.items.map((r) => r.id) : []).toEqual([2]);
  });
});

describe("seriesDetailHref / seriesHomeCardMeta", () => {
  it("builds the plain detail URL", () => {
    expect(seriesDetailHref(42)).toBe("/series/detail?id=42");
  });

  it("shows the rating only when it has evidence, and no completeness claim", () => {
    // TMDb-linked: the rating carries corroboration (D35).
    const rated = row(1, "Rated", { rating: "8.4", category: "Drama", year: "2024", tmdb: 7 });
    expect(seriesHomeCardMeta(rated, 3)).toContain("★ 8.4");
    expect(seriesHomeCardMeta(rated, 3)).toContain("3 seasons");
    const unrated = row(2, "Unrated", { rating: "", category: "Drama" });
    expect(seriesHomeCardMeta(unrated, null)).not.toContain("★");
    expect(seriesHomeCardMeta(unrated, null)).not.toContain("season");
    expect(seriesHomeCardMeta(rated, null)).not.toMatch(/complete|all episodes|full series/i);
  });
});
