// Live TV 0.11.0 (W6) — Guide composition logic.
//
// Covers the two pure pieces the Guide composition depends on:
//   - pickNowFeatured: the On Now featured slot follows the focused
//     programme, else the first row — never an invented programme.
//   - rankHighlights / pickTonightFeatured: Tonight's Highlights is
//     a real pick (premiere first, favourite before watched, at most
//     two per channel), not a whole channel's evening re-listed
//     because it was tuned once (the 0.10.1 fixture behaviour).
//   - Section gating: Movies / Live Sport / Drama & Entertainment /
//     Later Tonight appear only with a real signal.
import { describe, it, expect } from "vitest";
import {
  pickNowFeatured,
  sanitiseGuideProgrammes,
  type GuideNowRow,
} from "@/scripts/lib/livetv-guide";
import {
  buildTonightSections,
  chronologicalTonight,
  highlightRank,
  pickTonightFeatured,
  rankHighlights,
  TONIGHT_HIGHLIGHT_PER_CHANNEL_CAP,
  TONIGHT_SECTION_ITEM_CAP,
  type TonightItem,
} from "@/scripts/lib/livetv-tonight";
import { guideProgrammeKey } from "@/scripts/lib/livetv-state";

// Fixed clock: 2026-11-10 20:00:00 UTC. Evening math uses the local
// zone; tests assert relative behaviour, never absolute zone values.
const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const HOUR = 3_600_000;

function tonightItem(
  channelId: string,
  startOffsetHours: number,
  durationHours: number,
  title: string,
  overrides: Partial<TonightItem["channel"]> & { desc?: string } = {},
): TonightItem {
  const { desc, ...channelOverrides } = overrides;
  const programmes = sanitiseGuideProgrammes(channelId, [
    {
      start: NOW + startOffsetHours * HOUR,
      stop: NOW + (startOffsetHours + durationHours) * HOUR,
      title,
      desc,
    },
  ]);
  return {
    programme: programmes[0]!,
    channel: {
      id: channelId,
      displayName: channelId,
      categoryLabel: "",
      ...channelOverrides,
    },
  };
}

function nowRow(
  channelId: string,
  title: string,
  startOffsetHours = -0.5,
  nextTitle = "Next Up",
): GuideNowRow {
  const programmes = sanitiseGuideProgrammes(channelId, [
    {
      start: NOW + startOffsetHours * HOUR,
      stop: NOW + (startOffsetHours + 1) * HOUR,
      title,
    },
    {
      start: NOW + (startOffsetHours + 1) * HOUR,
      stop: NOW + (startOffsetHours + 2) * HOUR,
      title: nextTitle,
    },
  ]);
  return {
    channelId,
    current: programmes[0]!,
    next: programmes[1]!,
    progress: 0.5,
  };
}

describe("pickNowFeatured", () => {
  const rows = [nowRow("a", "First On"), nowRow("b", "Second On"), nowRow("c", "Third On")];

  it("follows the selected programme when it is on now", () => {
    const key = guideProgrammeKey("b", rows[1]!.current.startMs);
    expect(pickNowFeatured(rows, key)?.current.title).toBe("Second On");
  });

  it("falls back to the first row with no selection", () => {
    expect(pickNowFeatured(rows, null)?.current.title).toBe("First On");
  });

  it("falls back to the first row when the selection is stale", () => {
    expect(pickNowFeatured(rows, "gone@123456789")?.current.title).toBe("First On");
  });

  it("returns null when nothing is on now", () => {
    expect(pickNowFeatured([], null)).toBeNull();
  });
});

describe("rankHighlights", () => {
  it("ranks a premiere above a favourite channel above a watched channel", () => {
    const items = [
      tonightItem("fav", -1, 1, "Favourite Show", { favourite: true }),
      tonightItem("watched", 0, 1, "Watched Show", { watched: true }),
      tonightItem("plain", 1, 1, "Brand New Drama", { desc: "A brand new series premiere." }),
    ];
    expect(items.map((i) => highlightRank(i))).toEqual([1, 2, 0]);
    const ranked = rankHighlights(items, NOW);
    expect(ranked.map((i) => i.programme.title)).toEqual([
      "Favourite Show",
      "Watched Show",
      "Brand New Drama",
    ]);
  });

  it("caps each channel at two highlights — one watched channel is not the whole section", () => {
    // Regression: 0.10.1 listed a tuned channel's entire evening as
    // "Tonight's Highlights" (tuning marks it watched).
    const items = [-2, -1, 0, 1, 2].map((offset) =>
      tonightItem("watched-one", offset, 1, `Show ${offset}`, { watched: true }),
    );
    const ranked = rankHighlights(items, NOW);
    expect(ranked).toHaveLength(TONIGHT_HIGHLIGHT_PER_CHANNEL_CAP);
    expect(new Set(ranked.map((i) => i.channel.id)).size).toBe(1);
  });

  it("caps the section at eight across channels", () => {
    const items = ["a", "b", "c", "d", "e"].flatMap((channel) =>
      [-2, -1, 0].map((offset) =>
        tonightItem(channel, offset, 1, `${channel} ${offset}`, { favourite: true }),
      ),
    );
    const ranked = rankHighlights(items, NOW);
    expect(ranked).toHaveLength(TONIGHT_SECTION_ITEM_CAP);
    for (const channel of ["a", "b", "c", "d", "e"]) {
      expect(ranked.filter((i) => i.channel.id === channel).length).toBeLessThanOrEqual(2);
    }
  });

  it("returns [] when nothing carries a highlight signal", () => {
    expect(rankHighlights([tonightItem("a", -1, 1, "Plain Show")], NOW)).toEqual([]);
  });
});

describe("buildTonightSections highlights (0.10.1 regression)", () => {
  it("never lets one watched channel fill Tonight's Highlights", () => {
    const items = [-2, -1, 0, 1, 2].map((offset) =>
      tonightItem("news-one", offset, 1, `Bulletin ${offset}`, { watched: true }),
    );
    const built = buildTonightSections(items, NOW);
    const highlights = built.sections.find((s) => s.id === "highlights");
    expect(highlights).toBeDefined();
    expect(highlights!.items.length).toBeLessThanOrEqual(
      TONIGHT_HIGHLIGHT_PER_CHANNEL_CAP,
    );
    expect(highlights!.items.length).toBeLessThan(items.length);
  });
});

describe("pickTonightFeatured", () => {
  it("prefers a premiere highlight over an earlier favourite highlight", () => {
    const items = [
      tonightItem("fav", -1, 1, "Favourite Show", { favourite: true }),
      tonightItem("plain", 1, 1, "Brand New Drama", { desc: "A brand new series premiere." }),
    ];
    const built = buildTonightSections(items, NOW);
    expect(pickTonightFeatured(built, chronologicalTonight(items, NOW))?.programme.title).toBe(
      "Brand New Drama",
    );
  });

  it("falls back to the first programme starting soon, then the first evening programme", () => {
    const plain = [
      tonightItem("a", -2, 1, "Evening One"),
      tonightItem("b", 0.5, 1, "Starts Soon"),
    ];
    const built = buildTonightSections(plain, NOW);
    expect(pickTonightFeatured(built, chronologicalTonight(plain, NOW))?.programme.title).toBe(
      "Starts Soon",
    );
    const noSoon = [tonightItem("a", -2, 1, "Evening One")];
    const builtNoSoon = buildTonightSections(noSoon, NOW);
    expect(
      pickTonightFeatured(builtNoSoon, chronologicalTonight(noSoon, NOW))?.programme.title,
    ).toBe("Evening One");
  });

  it("returns null when the evening is empty", () => {
    const built = buildTonightSections([], NOW);
    expect(pickTonightFeatured(built, [])).toBeNull();
  });
});

describe("Tonight section gating — signal only", () => {
  it("shows Movies, Live Sport and Drama only where the metadata says so", () => {
    const items = [
      tonightItem("movie-ch", -1, 2, "Midnight Movie", {
        categoryLabel: "Movies",
        desc: "A classic feature film.",
      }),
      tonightItem("sport-ch", 0, 2, "Premier League Live", {
        categoryLabel: "Sports",
        desc: "Live football from the top flight.",
      }),
      tonightItem("drama-ch", 1, 1, "Primetime Drama", {
        categoryLabel: "Entertainment",
        desc: "A gripping drama.",
      }),
      tonightItem("news-ch", -2, 1, "Evening News", {
        categoryLabel: "News",
        desc: "The day's headlines.",
      }),
    ];
    const built = buildTonightSections(items, NOW);
    expect(built.hasEditorialSignal).toBe(true);
    // The sport programme starts exactly now (Starting Soon), and
    // the 21:00 drama also lands in Later Tonight — both gated on
    // real times, not invented.
    expect(built.sections.map((s) => s.id)).toEqual([
      "starting-soon",
      "movies",
      "sport",
      "drama",
      "later",
    ]);
  });

  it("Later Tonight appears only when something starts at or after 21:00", () => {
    const early = [tonightItem("a", -2, 1, "Early Evening")];
    expect(buildTonightSections(early, NOW).sections.map((s) => s.id)).not.toContain("later");
    const late = [
      tonightItem("a", -2, 1, "Early Evening"),
      tonightItem("b", 1.5, 1, "Late Show"), // 21:30
    ];
    expect(buildTonightSections(late, NOW).sections.map((s) => s.id)).toContain("later");
  });
});
