// Sports Corner — EPG listing vs feed kick-off: the pre-match window
// (bug 4b, 2026-11-21). A listing starting with pre-match coverage
// must match its fixture; a listing starting far before kick-off
// must not. These tests pin the shared rule in
// sports-corner-v2-hub.ts — the two call sites that still match on
// the exact kick-off minute (matchFixtureStation in football-data.ts
// and buildNextMatchRows in sports-reminder-fire.ts) must both use
// it, so station and Watch can never disagree.
import { describe, it, expect } from "vitest"
import {
  epgListingMatchesKickoff,
  SPORTS_PREMATCH_WINDOW_MS,
} from "@/scripts/lib/sports-corner-v2-hub.ts"

const KICKOFF = Date.UTC(2026, 10, 22, 16, 30, 0)
const MINUTE = 60_000

describe("epgListingMatchesKickoff — pre-match window", () => {
  it("the window is 60 minutes", () => {
    expect(SPORTS_PREMATCH_WINDOW_MS).toBe(60 * MINUTE)
  })

  it("a listing starting exactly at kick-off matches (the old behaviour)", () => {
    expect(epgListingMatchesKickoff(KICKOFF, KICKOFF)).toBe(true)
  })

  it("a listing starting 30 minutes before kick-off matches (pre-match coverage)", () => {
    expect(epgListingMatchesKickoff(KICKOFF - 30 * MINUTE, KICKOFF)).toBe(
      true,
    )
  })

  it("a listing starting 60 minutes before kick-off matches (the window edge)", () => {
    expect(epgListingMatchesKickoff(KICKOFF - 60 * MINUTE, KICKOFF)).toBe(
      true,
    )
  })

  it("a listing starting 61 minutes before kick-off does not match", () => {
    expect(epgListingMatchesKickoff(KICKOFF - 61 * MINUTE, KICKOFF)).toBe(
      false,
    )
  })

  it("a listing starting far before kick-off (an earlier programme) does not match", () => {
    expect(epgListingMatchesKickoff(KICKOFF - 3 * 60 * MINUTE, KICKOFF)).toBe(
      false,
    )
  })

  it("a listing starting after kick-off does not match", () => {
    expect(epgListingMatchesKickoff(KICKOFF + 5 * MINUTE, KICKOFF)).toBe(
      false,
    )
  })

  it("non-finite times never match", () => {
    expect(epgListingMatchesKickoff(Number.NaN, KICKOFF)).toBe(false)
    expect(epgListingMatchesKickoff(KICKOFF, Number.NaN)).toBe(false)
  })
})
