// Sports Corner (0.11.13) — follow record. Plan §12, T17–T19.
// The module guards localStorage/document access, so tests stub both
// with minimal fakes (node environment has neither).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  SPORTS_FOLLOW_CHANGED_EVENT,
  SPORTS_FOLLOW_STORAGE_KEY,
  defaultSportsFollowState,
  followSportsTeam,
  getSportsFollowState,
  isSportsTeamFollowed,
  parseSportsFollowState,
  readSportsFollowRecord,
  restoreSportsFollowState,
  unfollowSportsTeam,
} from "@/scripts/lib/sports-follow.ts"

function memoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
}

let dispatched: string[] = []

beforeEach(() => {
  dispatched = []
  vi.stubGlobal("localStorage", memoryStorage())
  vi.stubGlobal("document", {
    dispatchEvent: (event: { type: string }) => {
      dispatched.push(event.type)
      return true
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("follow record — defaults + validation", () => {
  it("first read with no stored record defaults to FOLLOWED and writes it", () => {
    const state = getSportsFollowState()
    expect(state.followed).toBe(true)
    expect(state.teamId).toBe("manchester-united")
    expect(state.displayName).toBe("Manchester United")
    expect(state.followedAt).toBeTruthy()
    // Persisted: a raw read finds the record the default write created.
    const stored = readSportsFollowRecord()
    expect(stored).toEqual(state)
    expect(
      localStorage.getItem(SPORTS_FOLLOW_STORAGE_KEY),
    ).toContain("manchester-united")
  })

  it("isSportsTeamFollowed defaults to true", () => {
    expect(isSportsTeamFollowed()).toBe(true)
  })

  it("a corrupt stored record falls back to the default", () => {
    localStorage.setItem(SPORTS_FOLLOW_STORAGE_KEY, "{not json")
    expect(getSportsFollowState().followed).toBe(true)
    localStorage.setItem(
      SPORTS_FOLLOW_STORAGE_KEY,
      JSON.stringify({ teamId: "liverpool", followed: true }),
    )
    expect(getSportsFollowState().followed).toBe(true)
    expect(getSportsFollowState().teamId).toBe("manchester-united")
  })

  it("parseSportsFollowState rejects wrong teams and bad shapes", () => {
    expect(parseSportsFollowState(null)).toBeNull()
    expect(parseSportsFollowState("followed")).toBeNull()
    expect(
      parseSportsFollowState({
        teamId: "arsenal",
        followed: true,
        followedAt: new Date().toISOString(),
      }),
    ).toBeNull()
    expect(
      parseSportsFollowState({
        teamId: "manchester-united",
        followed: "yes",
        followedAt: new Date().toISOString(),
      }),
    ).toBeNull()
    expect(
      parseSportsFollowState({
        teamId: "manchester-united",
        followed: true,
        followedAt: "not-a-date",
      }),
    ).toBeNull()
    expect(
      parseSportsFollowState({
        teamId: "manchester-united",
        followed: false,
        followedAt: "2026-11-13T00:00:00.000Z",
      }),
    ).toEqual({
      teamId: "manchester-united",
      displayName: "Manchester United",
      followedAt: "2026-11-13T00:00:00.000Z",
      followed: false,
    })
  })

  it("defaultSportsFollowState stamps the given clock", () => {
    expect(defaultSportsFollowState(0).followedAt).toBe(
      "1970-01-01T00:00:00.000Z",
    )
  })
})

describe("follow / unfollow (T17, T18)", () => {
  it("T17: follow/unfollow emit xt:sports-follow-changed, never series events", () => {
    unfollowSportsTeam()
    followSportsTeam()
    expect(dispatched).toEqual([
      SPORTS_FOLLOW_CHANGED_EVENT,
      SPORTS_FOLLOW_CHANGED_EVENT,
    ])
    expect(dispatched).not.toContain("xt:followed-changed")
    expect(dispatched).not.toContain("xt:followed-notifications-changed")
  })

  it("T17: the sports module never touches IndexedDB or series stores", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(
      join(here, "..", "src", "scripts", "lib", "sports-follow.ts"),
      "utf8",
    )
    expect(source).not.toContain("indexedDB")
    // No import of the series store — a comment may name it, an
    // import would couple the two follow systems.
    expect(source).not.toContain('from "./followed')
    expect(source).not.toContain("lib/followed")
    expect(source).not.toContain("FOLLOWED_CHANGED_EVENT")
    expect(source).toContain("xt:sports-follow-changed")
  })

  it("T18: unfollow persists followed:false; re-follow restores without data loss", () => {
    unfollowSportsTeam()
    expect(isSportsTeamFollowed()).toBe(false)
    expect(readSportsFollowRecord()?.followed).toBe(false)
    followSportsTeam()
    expect(isSportsTeamFollowed()).toBe(true)
    expect(readSportsFollowRecord()?.followed).toBe(true)
  })

  it("unfollow keeps the original followedAt; re-follow re-stamps", () => {
    const first = getSportsFollowState(1_000)
    expect(first.followedAt).toBe("1970-01-01T00:00:01.000Z")
    const unfollowed = unfollowSportsTeam()
    expect(unfollowed.followedAt).toBe("1970-01-01T00:00:01.000Z")
    const refollowed = followSportsTeam()
    expect(refollowed.followedAt).not.toBe("1970-01-01T00:00:01.000Z")
  })
})

describe("backup restore shape (T19)", () => {
  it("T19: restoreSportsFollowState writes a valid record, ignores the rest", () => {
    expect(
      restoreSportsFollowState({
        teamId: "manchester-united",
        followed: false,
        followedAt: "2026-11-13T00:00:00.000Z",
      }),
    ).toBe(true)
    expect(readSportsFollowRecord()?.followed).toBe(false)
    expect(restoreSportsFollowState({ teamId: "chelsea" })).toBe(false)
    expect(restoreSportsFollowState(null)).toBe(false)
    // The valid record survives the ignored writes.
    expect(readSportsFollowRecord()?.followed).toBe(false)
  })

  it("T19: restore does not emit the change event (restore re-renders itself)", () => {
    restoreSportsFollowState({
      teamId: "manchester-united",
      followed: false,
      followedAt: "2026-11-13T00:00:00.000Z",
    })
    expect(dispatched).toEqual([])
  })
})
