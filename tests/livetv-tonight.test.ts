import { describe, it, expect } from "vitest";
import {
  buildTonightSections,
  chronologicalTonight,
  eveningWindowMs,
  isHighlight,
  isLiveSport,
  isMovie,
  isNewOrPremiere,
  isStartingSoon,
  programmesForTonight,
  TONIGHT_END_HOUR,
  TONIGHT_START_HOUR,
  type TonightItem,
} from "@/scripts/lib/livetv-tonight";
import { sanitiseGuideProgrammes } from "@/scripts/lib/livetv-guide";

// Fixed clock: 2026-11-10 20:00:00 UTC. Evening math uses the local
// zone; tests assert relative behaviour (window span, ordering,
// section gating), never absolute zone values.
const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);
const HOUR = 3_600_000;

function item(
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

const plainEvening = [
  item("rte-one", -2, 1, "The Six O'Clock Show", { desc: "Chat and lifestyle." }),
  item("rte-two", -1.5, 1, "Home and Away", { desc: "Evening serial." }),
  item("bbc-one", -2, 2, "Pointless", { desc: "Quiz show." }),
];

describe("eveningWindowMs", () => {
  it("is the 17:00–23:00 local evening containing now", () => {
    const { windowStartMs, windowEndMs } = eveningWindowMs(NOW);
    expect(windowEndMs - windowStartMs).toBe(
      (TONIGHT_END_HOUR - TONIGHT_START_HOUR) * HOUR,
    );
    expect(new Date(windowStartMs).getHours()).toBe(TONIGHT_START_HOUR);
    expect(new Date(windowEndMs).getHours()).toBe(TONIGHT_END_HOUR);
    expect(windowStartMs).toBeLessThanOrEqual(NOW);
    expect(windowEndMs).toBeGreaterThan(NOW);
  });

  it("rolls to tomorrow evening once tonight is over", () => {
    const late = Date.UTC(2026, 10, 10, 23, 30, 0);
    const { windowStartMs, windowEndMs } = eveningWindowMs(late);
    expect(windowStartMs).toBeGreaterThan(late);
    expect(new Date(windowStartMs).getHours()).toBe(TONIGHT_START_HOUR);
    expect(windowEndMs - windowStartMs).toBe(6 * HOUR);
  });
});

describe("programmesForTonight / chronologicalTonight", () => {
  it("keeps only programmes overlapping the evening, chronological", () => {
    const items = [
      item("a", -5, 1, "Afternoon Show"), // 15:00–16:00, before the window
      item("b", -2, 1, "Evening One"),
      item("c", 1, 1, "Evening Two"),
      item("d", 5, 1, "After Midnight"), // 01:00, after the window
    ];
    const titles = programmesForTonight(items, NOW).map((i) => i.programme.title);
    expect(titles).toEqual(["Evening One", "Evening Two"]);
    expect(chronologicalTonight(items, NOW).map((i) => i.programme.title)).toEqual(
      ["Evening One", "Evening Two"],
    );
  });

  it("returns [] when nothing airs in the evening", () => {
    expect(programmesForTonight([item("a", -5, 1, "Afternoon")], NOW)).toEqual([]);
  });
});

describe("Tonight section gating — no signal, no section", () => {
  it("omits every section when metadata is poor (chronological fallback only)", () => {
    const built = buildTonightSections(plainEvening, NOW);
    expect(built.hasEditorialSignal).toBe(false);
    expect(built.sections).toEqual([]);
    // The fallback still lists the real evening, chronologically
    // (18:00 tie breaks on channel name: bbc-one before rte-one).
    expect(
      chronologicalTonight(plainEvening, NOW).map((i) => i.programme.title),
    ).toEqual(["Pointless", "The Six O'Clock Show", "Home and Away"]);
  });

  it("Starting Soon appears only when something starts within 60 minutes", () => {
    const soon = item("a", 0.5, 1, "Starts in 30 min");
    const later = item("b", 2, 1, "Starts in 2 hours");
    const withSoon = buildTonightSections([soon, later], NOW);
    expect(withSoon.sections.map((s) => s.id)).toContain("starting-soon");
    const withoutSoon = buildTonightSections([later], NOW);
    expect(withoutSoon.sections.map((s) => s.id)).not.toContain("starting-soon");
  });

  it("Highlights needs a favourite/watched channel or a new/premiere flag", () => {
    expect(buildTonightSections(plainEvening, NOW).sections).toEqual([]);
    const fav = item("a", -1, 2, "On a favourite", { favourite: true });
    expect(
      buildTonightSections([fav], NOW).sections.map((s) => s.id),
    ).toContain("highlights");
    const watched = item("a", -1, 2, "Recently watched", { watched: true });
    expect(
      buildTonightSections([watched], NOW).sections.map((s) => s.id),
    ).toContain("highlights");
    const premiere = item("a", -1, 2, "Brand New Series: The Drama", {});
    expect(isNewOrPremiere(premiere)).toBe(true);
    expect(
      buildTonightSections([premiere], NOW).sections.map((s) => s.id),
    ).toContain("highlights");
  });

  it("Movies on Tonight needs a movie category or an explicit film/movie mention", () => {
    const byCategory = item("a", -1, 2, "Some Title", { categoryLabel: "Movies" });
    expect(isMovie(byCategory)).toBe(true);
    const byTitle = item("a", -1, 2, "The Great Film", {});
    expect(isMovie(byTitle)).toBe(true);
    expect(isMovie(plainEvening[0]!)).toBe(false);
    const built = buildTonightSections([byCategory, plainEvening[0]!], NOW);
    const movies = built.sections.find((s) => s.id === "movies");
    expect(movies?.items.map((i) => i.programme.title)).toEqual(["Some Title"]);
  });

  it("Live Sport needs a sports category or an explicit sport/event mention", () => {
    const byCategory = item("a", -1, 2, "Matchday Live", { categoryLabel: "Sports" });
    expect(isLiveSport(byCategory)).toBe(true);
    const byTitle = item("a", -1, 2, "Premier League Live", {});
    expect(isLiveSport(byTitle)).toBe(true);
    expect(isLiveSport(plainEvening[0]!)).toBe(false);
    const built = buildTonightSections([byTitle], NOW);
    expect(built.sections.find((s) => s.id === "sport")?.items).toHaveLength(1);
  });

  it("Drama & Entertainment needs an entertainment/drama category or mention", () => {
    const drama = item("a", -1, 2, "The Drama", { categoryLabel: "Entertainment" });
    const built = buildTonightSections([drama], NOW);
    expect(built.sections.find((s) => s.id === "drama")?.items).toHaveLength(1);
    expect(buildTonightSections(plainEvening, NOW).sections).not.toContainEqual(
      expect.objectContaining({ id: "drama" }),
    );
  });

  it("Later Tonight lists only programmes starting at/after 21:00 local", () => {
    const early = item("a", -1, 1, "Early evening"); // 19:00–20:00
    const late = item("b", 1.5, 1, "Late show"); // 21:30–22:30
    const built = buildTonightSections([early, late], NOW);
    const later = built.sections.find((s) => s.id === "later");
    expect(later?.items.map((i) => i.programme.title)).toEqual(["Late show"]);
    expect(
      buildTonightSections([early], NOW).sections.map((s) => s.id),
    ).not.toContain("later");
  });
});

describe("Tonight never invents", () => {
  it("every listed programme comes from the input — no fabricated titles, times or art", () => {
    const items = [
      item("a", -1, 2, "Real One", { favourite: true, categoryLabel: "Movies" }),
      item("b", 0.5, 1, "Real Two", { categoryLabel: "Sports" }),
      item("c", 2, 1, "Real Three", {}),
    ];
    const built = buildTonightSections(items, NOW);
    const inputTitles = new Set(items.map((i) => i.programme.title));
    for (const section of built.sections) {
      for (const listed of section.items) {
        expect(inputTitles.has(listed.programme.title)).toBe(true);
        const source = items.find((i) => i.programme.title === listed.programme.title)!;
        expect(listed.programme.startMs).toBe(source.programme.startMs);
        expect(listed.programme.stopMs).toBe(source.programme.stopMs);
      }
    }
    // No section exists without input behind it.
    expect(buildTonightSections([], NOW).sections).toEqual([]);
  });

  it("isStartingSoon is false for programmes already on or long past", () => {
    expect(isStartingSoon(plainEvening[0]!, NOW)).toBe(false);
    expect(isStartingSoon(item("a", 2, 1, "In two hours"), NOW)).toBe(false);
    expect(isStartingSoon(item("a", 0.25, 1, "In 15 min"), NOW)).toBe(true);
  });

  it("isHighlight is false for plain programmes on plain channels", () => {
    expect(isHighlight(plainEvening[0]!)).toBe(false);
  });
});

describe("Tonight ordering", () => {
  it("sections are chronological within themselves", () => {
    const items = [
      item("a", 2, 1, "Third", { categoryLabel: "Movies" }),
      item("b", -1, 2, "First", { categoryLabel: "Movies" }),
      item("c", 1, 1, "Second", { categoryLabel: "Movies" }),
    ];
    const built = buildTonightSections(items, NOW);
    const movies = built.sections.find((s) => s.id === "movies")!;
    expect(movies.items.map((i) => i.programme.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });
});
