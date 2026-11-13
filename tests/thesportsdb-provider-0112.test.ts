import { describe, it, expect, vi, afterEach } from "vitest"
import {
  lookupSportsEventArtwork,
  type SportsClassification,
} from "../src/scripts/lib/thesportsdb-provider"

// TheSportsDB provider is a DOCUMENTED NO-OP (see the investigation
// record in src/scripts/lib/thesportsdb-provider.ts): image rights
// cannot be established for event/team/league artwork, so the provider
// must return null for every input and never touch the network. These
// tests pin that contract. There is no mocked-success case: a live
// provider does not exist, and inventing one in tests would assert a
// behaviour the app must not have.

const fixture: SportsClassification = {
  isSport: true,
  sport: "football",
  kind: "fixture",
  teams: ["Manchester United", "Sunderland"],
  competition: "English Premier League",
  confidence: "high",
}

const nonSport: SportsClassification = {
  isSport: false,
  sport: null,
  kind: "non-sport",
  confidence: "high",
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("lookupSportsEventArtwork (documented no-op)", () => {
  it("returns null for a high-confidence fixture", async () => {
    await expect(
      lookupSportsEventArtwork(fixture, {
        title: "Manchester United v Sunderland",
        broadcastDate: "2026-12-30",
      })
    ).resolves.toBeNull()
  })

  it("returns null without a broadcast date", async () => {
    await expect(
      lookupSportsEventArtwork(fixture, { title: "Manchester United v Sunderland" })
    ).resolves.toBeNull()
  })

  it("returns null for tournament, league-broadcast and general-sport kinds", async () => {
    for (const kind of ["tournament", "league-broadcast", "general-sport"] as const) {
      await expect(
        lookupSportsEventArtwork(
          { ...fixture, kind, teams: undefined, competition: undefined },
          { title: "Some sports broadcast" }
        )
      ).resolves.toBeNull()
    }
  })

  it("returns null for non-sport classifications", async () => {
    await expect(
      lookupSportsEventArtwork(nonSport, { title: "Evening News" })
    ).resolves.toBeNull()
  })

  it("returns null for low-confidence classifications", async () => {
    await expect(
      lookupSportsEventArtwork(
        { ...fixture, confidence: "low", teams: undefined },
        { title: "United v Sunderland?" }
      )
    ).resolves.toBeNull()
  })

  it("never throws and always resolves", async () => {
    await expect(
      lookupSportsEventArtwork(undefined as unknown as SportsClassification, {
        title: "",
      })
    ).resolves.toBeNull()
    await expect(
      lookupSportsEventArtwork(null as unknown as SportsClassification, {
        title: "x",
      })
    ).resolves.toBeNull()
  })

  it("makes no network requests", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    await lookupSportsEventArtwork(fixture, {
      title: "Manchester United v Sunderland",
      broadcastDate: "2026-12-30",
    })
    await lookupSportsEventArtwork(nonSport, { title: "Evening News" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
