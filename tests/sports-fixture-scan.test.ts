// Sports Corner (0.11.13) — fixture scan + matching. Plan §12, T1–T16.
// Pure functions + the batch loader against fixture EPG states built
// the way the real loader does (lower-cased tvg-id keys, pre-built
// nameIndex). Q4 refinement: squad-marked fixtures are CONFIRMED but
// routed to the Other Squads split, never the main list.
import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildChannelNameIndex } from "@/scripts/lib/epg-data.js"
import {
  getSportsScan,
  getSportsScanRunCount,
  matchUnitedFixture,
  resetSportsScanCache,
  scanSportsFixtures,
  selectNextFixture,
  splitSportsFixtures,
  type SportsScanChannel,
} from "@/scripts/lib/sports-fixture-scan.ts"

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0)
const HOUR = 3_600_000

function programme(startMs: number, stopMs: number, title: string, desc = "") {
  return { start: startMs, stop: stopMs, title, desc }
}

function epgState(
  entries: Array<{ id: string; name: string; programmes: unknown[] }>,
  fetchedAt: number | null = NOW,
) {
  const programmes = new Map<string, unknown[]>()
  const channelNames = new Map<string, string>()
  for (const entry of entries) {
    programmes.set(entry.id.toLowerCase(), entry.programmes)
    channelNames.set(entry.id.toLowerCase(), entry.name)
  }
  return {
    programmes,
    channelNames,
    nameIndex: buildChannelNameIndex(channelNames),
    fetchedAt,
  }
}

function channel(
  id: number,
  name: string,
  tvgId: string,
  extra: Partial<SportsScanChannel> = {},
): SportsScanChannel {
  return { id, name, tvgId, category: "Sports", ...extra }
}

describe("matchUnitedFixture — confirmed fixtures (T1, T2, T12)", () => {
  it("T1: Manchester United v Sunderland → CONFIRMED, teams verbatim", () => {
    const match = matchUnitedFixture(
      "Manchester United v Sunderland",
      "Sky Sports Main Event",
      "Sports",
    )
    expect(match).not.toBeNull()
    expect(match!.tier).toBe("confirmed")
    expect(match!.squad).toBe("first-team")
    expect(match!.classification.teams).toEqual([
      "Manchester United",
      "Sunderland",
    ])
    expect(match!.classification.sport).toBe("football")
    expect(match!.classification.kind).toBe("fixture")
  })

  it("T2: Man Utd alias + either side → CONFIRMED", () => {
    expect(
      matchUnitedFixture("Man Utd vs Liverpool", "", "")?.tier,
    ).toBe("confirmed")
    expect(
      matchUnitedFixture("Arsenal v Man Utd", "", "")?.tier,
    ).toBe("confirmed")
    expect(
      matchUnitedFixture("Manchester Utd v Chelsea", "", "")?.tier,
    ).toBe("confirmed")
    expect(matchUnitedFixture("Man Utd @ Fulham", "", "")?.tier).toBe(
      "confirmed",
    )
    expect(
      matchUnitedFixture("Galatasaray v Man Utd", "", "")?.tier,
    ).toBe("confirmed")
  })

  it("T2: alias forms stay verbatim, never expanded", () => {
    const match = matchUnitedFixture("Man Utd vs Liverpool", "", "")
    expect(match!.classification.teams).toEqual(["Man Utd", "Liverpool"])
    expect(JSON.stringify(match)).not.toContain("Manchester United")
  })

  it("T12: fixture-shaped highlights/build-up → CONFIRMED, title verbatim", () => {
    expect(
      matchUnitedFixture(
        "Manchester United v Sunderland: Highlights",
        "",
        "",
      )?.tier,
    ).toBe("confirmed")
    expect(
      matchUnitedFixture("Man Utd v Chelsea: Build-Up", "", "")?.tier,
    ).toBe("confirmed")
  })

  it("competition comes only from a matched indicator", () => {
    const withIndicator = matchUnitedFixture(
      "Premier League: Man Utd v Chelsea",
      "",
      "",
    )
    expect(withIndicator!.classification.competition).toBe("Premier League")
    const bare = matchUnitedFixture("Man Utd v Chelsea", "", "")
    expect(bare!.classification.competition).toBeUndefined()
  })

  it("leading-prefix form: competition kept, sides parsed from the fixture part", () => {
    const match = matchUnitedFixture("Premier League: Man Utd v Chelsea", "", "")
    expect(match?.tier).toBe("confirmed")
    expect(match!.classification.teams).toEqual(["Man Utd", "Chelsea"])
    expect(match!.classification.competition).toBe("Premier League")
  })

  it("Women's Super League titles are football, never labelled rugby's Super League", () => {
    const match = matchUnitedFixture(
      "Man Utd v Chelsea: Women's Super League",
      "",
      "",
    )
    expect(match?.tier).toBe("confirmed")
    expect(match?.squad).toBe("other-squad")
    expect(match!.classification.competition).toBeUndefined()
  })
})

describe("matchUnitedFixture — ambiguous bare United (T3, T4, T5)", () => {
  it("T3: United v Sunderland + Premier League indicator → POSSIBLE", () => {
    const match = matchUnitedFixture(
      "United v Sunderland: Premier League",
      "Generic Channel",
      "Entertainment",
    )
    expect(match).not.toBeNull()
    expect(match!.tier).toBe("possible")
    expect(match!.classification.teams).toEqual(["United", "Sunderland"])
  })

  it("T3: United v Sunderland on a sports channel → POSSIBLE (corroboration b)", () => {
    const match = matchUnitedFixture(
      "United v Sunderland",
      "Sky Sports Main Event",
      "Entertainment",
    )
    expect(match?.tier).toBe("possible")
  })

  it("T4: United v Sunderland, no corroboration → excluded", () => {
    expect(
      matchUnitedFixture("United v Sunderland", "Generic Channel", "Movies"),
    ).toBeNull()
  })

  it("T4: bare United vs an unknown club, sports channel → excluded (rule 1)", () => {
    expect(
      matchUnitedFixture("United v Unknowntown Rovers", "Sky Sports", "Sports"),
    ).toBeNull()
  })

  it("T5: Newcastle United v Leeds United → excluded", () => {
    expect(
      matchUnitedFixture("Newcastle United v Leeds United", "Sky Sports", "Sports"),
    ).toBeNull()
  })
})

describe("matchUnitedFixture — kind/sport guards (T6, T9, T10, T13)", () => {
  it("T6: magazine/review/talk shows → excluded (kind gate)", () => {
    expect(matchUnitedFixture("The United Stand", "", "")).toBeNull()
    expect(matchUnitedFixture("Match of the Day", "BBC One", "")).toBeNull()
    expect(
      matchUnitedFixture("Manchester United: Season Review", "", ""),
    ).toBeNull()
  })

  it("T9: rugby fixture with a United side → excluded (sport guard)", () => {
    expect(
      matchUnitedFixture(
        "Leinster v Munster: United Rugby Championship",
        "",
        "",
      ),
    ).toBeNull()
  })

  it("T10: Kramer vs Kramer → excluded", () => {
    expect(matchUnitedFixture("Kramer vs Kramer", "", "")).toBeNull()
  })

  it("T13: a film on a sports channel → excluded", () => {
    expect(
      matchUnitedFixture("The Godfather", "Sky Sports", "Sports"),
    ).toBeNull()
  })
})

describe("matchUnitedFixture — squads (T7, T8, Q4 refinement)", () => {
  it("T7: Manchester United Women → CONFIRMED, other-squad split, verbatim", () => {
    const match = matchUnitedFixture(
      "Manchester United Women v Chelsea Women",
      "",
      "",
    )
    expect(match?.tier).toBe("confirmed")
    expect(match?.squad).toBe("other-squad")
    expect(match!.classification.teams).toEqual([
      "Manchester United Women",
      "Chelsea Women",
    ])
  })

  it("T8: Man Utd U21 → CONFIRMED, other-squad split", () => {
    const match = matchUnitedFixture("Man Utd U21 v Man City U21", "", "")
    expect(match?.tier).toBe("confirmed")
    expect(match?.squad).toBe("other-squad")
  })

  it("academy/youth markers route to other-squad", () => {
    expect(
      matchUnitedFixture("Man Utd Academy v Liverpool Academy", "", "")?.squad,
    ).toBe("other-squad")
    expect(
      matchUnitedFixture("Manchester United U18 v Everton U18", "", "")?.squad,
    ).toBe("other-squad")
  })

  it("a squad marker in the title segment routes to other-squad", () => {
    expect(
      matchUnitedFixture("Man Utd v Chelsea: Women's Super League", "", "")
        ?.squad,
    ).toBe("other-squad")
  })

  it("first-team fixtures carry no squad marker", () => {
    expect(
      matchUnitedFixture("Manchester United v Sunderland", "", "")?.squad,
    ).toBe("first-team")
  })
})

describe("scanSportsFixtures — grouping + scan shape (T11)", () => {
  const start = NOW + 2 * HOUR

  it("T11: same fixture, same start, 3 channels → ONE row + Also on", () => {
    const state = epgState([
      {
        id: "sky-main",
        name: "Sky Sports Main Event",
        programmes: [programme(start, start + 2 * HOUR, "Man Utd v Sunderland")],
      },
      {
        id: "sky-pl",
        name: "Sky Sports Premier League",
        programmes: [programme(start, start + 2 * HOUR, "Man Utd v Sunderland")],
      },
      {
        id: "mutv",
        name: "MUTV",
        programmes: [programme(start, start + 2 * HOUR, "Man Utd v Sunderland")],
      },
    ])
    const channels = [
      channel(1, "Sky Sports Main Event", "sky-main"),
      channel(2, "Sky Sports Premier League", "sky-pl"),
      channel(3, "MUTV", "mutv"),
    ]
    const result = scanSportsFixtures(channels, state, {}, "pl1", NOW)
    expect(result.fixtures).toHaveLength(1)
    const fixture = result.fixtures[0]!
    expect(fixture.channelName).toBe("Sky Sports Main Event")
    expect(fixture.alsoOn).toHaveLength(2)
    expect(fixture.alsoOn.map((c) => c.channelName).sort()).toEqual([
      "MUTV",
      "Sky Sports Premier League",
    ])
    expect(result.mappedChannelCount).toBe(3)
    expect(result.channelCount).toBe(3)
  })

  it("T11: different start times → separate rows", () => {
    const state = epgState([
      {
        id: "sky-main",
        name: "Sky Sports Main Event",
        programmes: [programme(start, start + 2 * HOUR, "Man Utd v Sunderland")],
      },
      {
        id: "sky-pl",
        name: "Sky Sports Premier League",
        programmes: [
          programme(start + HOUR, start + 3 * HOUR, "Man Utd v Sunderland"),
        ],
      },
    ])
    const result = scanSportsFixtures(
      [
        channel(1, "Sky Sports Main Event", "sky-main"),
        channel(2, "Sky Sports Premier League", "sky-pl"),
      ],
      state,
      {},
      "pl1",
      NOW,
    )
    expect(result.fixtures).toHaveLength(2)
  })

  it("alias-form simulcasts group: Man Utd + Manchester United → ONE row", () => {
    const state = epgState([
      {
        id: "ch-a",
        name: "Channel A",
        programmes: [
          programme(start, start + 2 * HOUR, "Man Utd v Sunderland"),
        ],
      },
      {
        id: "ch-b",
        name: "Channel B",
        programmes: [
          programme(
            start,
            start + 2 * HOUR,
            "Manchester United v Sunderland",
          ),
        ],
      },
    ])
    const result = scanSportsFixtures(
      [channel(1, "Channel A", "ch-a"), channel(2, "Channel B", "ch-b")],
      state,
      {},
      "pl1",
      NOW,
    )
    expect(result.fixtures).toHaveLength(1)
    // First in catalogue order is primary; its verbatim title stands.
    expect(result.fixtures[0]!.title).toBe("Man Utd v Sunderland")
    expect(result.fixtures[0]!.alsoOn).toHaveLength(1)
  })

  it("a bare-United listing never merges into a confirmed row", () => {
    const state = epgState([
      {
        id: "ch-a",
        name: "Channel A",
        programmes: [
          programme(start, start + 2 * HOUR, "United v Sunderland"),
        ],
      },
      {
        id: "ch-b",
        name: "Channel B",
        programmes: [
          programme(start, start + 2 * HOUR, "Man Utd v Sunderland"),
        ],
      },
    ])
    const result = scanSportsFixtures(
      [
        channel(1, "Channel A", "ch-a", { category: "Sports" }),
        channel(2, "Channel B", "ch-b", { category: "Sports" }),
      ],
      state,
      {},
      "pl1",
      NOW,
    )
    // Two rows: the ambiguous listing stays flagged in Possible
    // Matches instead of silently joining the confirmed row.
    expect(result.fixtures).toHaveLength(2)
    expect(result.fixtures.map((f) => f.tier).sort()).toEqual([
      "confirmed",
      "possible",
    ])
  })

  it("squad fixtures never group with first-team fixtures", () => {
    const state = epgState([
      {
        id: "ch-a",
        name: "Channel A",
        programmes: [
          programme(start, start + 2 * HOUR, "Man Utd v Chelsea"),
        ],
      },
      {
        id: "ch-b",
        name: "Channel B",
        programmes: [
          programme(
            start,
            start + 2 * HOUR,
            "Manchester United Women v Chelsea Women",
          ),
        ],
      },
    ])
    const result = scanSportsFixtures(
      [channel(1, "Channel A", "ch-a"), channel(2, "Channel B", "ch-b")],
      state,
      {},
      "pl1",
      NOW,
    )
    expect(result.fixtures).toHaveLength(2)
  })

  it("empty state → no fixtures, honest counts", () => {
    const result = scanSportsFixtures(
      [channel(1, "BBC One", "bbc-one")],
      null,
      {},
      "pl1",
      NOW,
    )
    expect(result.fixtures).toEqual([])
    expect(result.mappedChannelCount).toBe(0)
    expect(result.channelCount).toBe(1)
    expect(result.epgFetchedAt).toBeNull()
  })

  it("non-fixture programmes never reach the result", () => {
    const state = epgState([
      {
        id: "bbc-one",
        name: "BBC One",
        programmes: [
          programme(NOW, NOW + HOUR, "Match of the Day"),
          programme(NOW + HOUR, NOW + 2 * HOUR, "The Godfather"),
        ],
      },
    ])
    const result = scanSportsFixtures(
      [channel(1, "BBC One", "bbc-one")],
      state,
      {},
      "pl1",
      NOW,
    )
    expect(result.fixtures).toEqual([])
  })
})

describe("splitSportsFixtures + selectNextFixture", () => {
  function scanFor(
    entries: Array<{ id: string; name: string; programmes: unknown[] }>,
  ) {
    const channels = entries.map((entry, i) =>
      channel(i + 1, entry.name, entry.id),
    )
    return scanSportsFixtures(channels, epgState(entries), {}, "pl1", NOW)
  }

  it("splits upcoming / possible / other-squads / recent; hero never possible", () => {
    const result = scanFor([
      {
        id: "sky",
        name: "Sky Sports",
        programmes: [
          programme(NOW + 2 * HOUR, NOW + 4 * HOUR, "Man Utd v Sunderland"),
          programme(NOW - 3 * HOUR, NOW - HOUR, "Liverpool v Man Utd"),
          programme(
            NOW + 5 * HOUR,
            NOW + 7 * HOUR,
            "United v Chelsea: Premier League",
          ),
          programme(
            NOW + 6 * HOUR,
            NOW + 8 * HOUR,
            "Manchester United Women v Arsenal Women",
          ),
        ],
      },
    ])
    const split = splitSportsFixtures(result.fixtures, NOW)
    expect(split.upcoming.map((f) => f.title)).toEqual([
      "Man Utd v Sunderland",
    ])
    expect(split.possible.map((f) => f.title)).toEqual([
      "United v Chelsea: Premier League",
    ])
    expect(split.otherSquadsUpcoming.map((f) => f.title)).toEqual([
      "Manchester United Women v Arsenal Women",
    ])
    expect(split.recent.map((f) => f.title)).toEqual(["Liverpool v Man Utd"])
    const hero = selectNextFixture(result.fixtures, NOW)
    expect(hero?.title).toBe("Man Utd v Sunderland")
  })

  it("a live fixture beats an upcoming one for the hero", () => {
    const result = scanFor([
      {
        id: "sky",
        name: "Sky Sports",
        programmes: [
          programme(NOW + 2 * HOUR, NOW + 4 * HOUR, "Man Utd v Sunderland"),
          programme(NOW - HOUR, NOW + HOUR, "Man Utd v Fulham"),
        ],
      },
    ])
    expect(selectNextFixture(result.fixtures, NOW)?.title).toBe(
      "Man Utd v Fulham",
    )
  })

  it("no confirmed first-team upcoming/live fixture → no hero", () => {
    const result = scanFor([
      {
        id: "sky",
        name: "Sky Sports",
        programmes: [
          programme(
            NOW + 2 * HOUR,
            NOW + 4 * HOUR,
            "United v Chelsea: Premier League",
          ),
        ],
      },
    ])
    expect(selectNextFixture(result.fixtures, NOW)).toBeNull()
  })

  it("possible-tier past fixtures appear in no section", () => {
    const result = scanFor([
      {
        id: "sky",
        name: "Sky Sports",
        programmes: [
          programme(
            NOW - 3 * HOUR,
            NOW - HOUR,
            "United v Chelsea: Premier League",
          ),
        ],
      },
    ])
    const split = splitSportsFixtures(result.fixtures, NOW)
    expect(split.upcoming).toEqual([])
    expect(split.possible).toEqual([])
    expect(split.recent).toEqual([])
    expect(split.otherSquadsUpcoming).toEqual([])
    expect(split.otherSquadsRecent).toEqual([])
  })
})

describe("batch-loader discipline (T14)", () => {
  it("T14: the scan module uses the batch loader and never per-channel resolution", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(
      join(here, "..", "src", "scripts", "lib", "sports-fixture-scan.ts"),
      "utf8",
    )
    expect(source).toContain("loadGuideProgrammes(")
    // The per-channel resolution function must not appear anywhere in
    // this module — not even in a comment — so the freeze shape
    // cannot creep back in unnoticed.
    expect(source).not.toContain("resolveTvgId")
    expect(source).not.toContain("epg-data.js")
  })
})

describe("memoisation (T16)", () => {
  beforeEach(() => {
    resetSportsScanCache()
  })

  it("T16: same revision re-render does not re-scan; new revision does", () => {
    const state = epgState([
      {
        id: "sky",
        name: "Sky Sports",
        programmes: [
          programme(NOW, NOW + HOUR, "Man Utd v Sunderland"),
        ],
      },
    ])
    const channels = [channel(1, "Sky Sports", "sky")]
    const before = getSportsScanRunCount()
    const first = getSportsScan(channels, state, {}, "pl1", NOW)
    const second = getSportsScan(channels, state, {}, "pl1", NOW)
    expect(second).toBe(first)
    expect(getSportsScanRunCount()).toBe(before + 1)
    const refreshed = epgState(
      [
        {
          id: "sky",
          name: "Sky Sports",
          programmes: [
            programme(NOW, NOW + HOUR, "Man Utd v Sunderland"),
          ],
        },
      ],
      NOW + 1000,
    )
    getSportsScan(channels, refreshed, {}, "pl1", NOW)
    expect(getSportsScanRunCount()).toBe(before + 2)
  })
})

describe("synthetic 15,319-channel scan (T15)", () => {
  it(
    "T15: scan completes on a 15,319-channel EPG; time is reported",
    () => {
      const CHANNELS = 15_319
      const PER_CHANNEL = 60
      const entries: Array<{ id: string; name: string; programmes: unknown[] }> =
        []
      const channels: SportsScanChannel[] = []
      for (let i = 0; i < CHANNELS; i++) {
        const programmes: unknown[] = []
        for (let j = 0; j < PER_CHANNEL; j++) {
          const start = NOW - 7 * 24 * HOUR + j * 3 * HOUR
          programmes.push(
            programme(start, start + 2 * HOUR, `Programme ${i}-${j}`),
          )
        }
        // Plant one real fixture in the middle of the catalogue.
        if (i === 7000) {
          programmes.push(
            programme(
              NOW + 2 * HOUR,
              NOW + 4 * HOUR,
              "Manchester United v Sunderland",
            ),
          )
        }
        entries.push({ id: `ch-${i}`, name: `Channel ${i}`, programmes })
        channels.push(channel(i + 1, `Channel ${i}`, `ch-${i}`))
      }
      const state = epgState(entries)
      const started = Date.now()
      const result = scanSportsFixtures(channels, state, {}, "pl1", NOW)
      const elapsedMs = Date.now() - started
      // The number is the evidence — reported, not asserted against
      // a brittle threshold (sandbox CPU is throttled).
      console.info(
        `[sports-scan T15] 15,319 channels x ${PER_CHANNEL} programmes scanned in ${elapsedMs}ms, ${result.fixtures.length} fixture(s) found`,
      )
      expect(result.fixtures).toHaveLength(1)
      expect(result.fixtures[0]!.title).toBe(
        "Manchester United v Sunderland",
      )
      expect(result.channelCount).toBe(CHANNELS)
    },
    120_000,
  )
})
