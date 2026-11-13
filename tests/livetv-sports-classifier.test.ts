// 0.11.12 W1 — sports classifier. Pure function, no mocks. Covers all
// 12 brief §18 examples plus the honesty guards (no guessed identities,
// channel/category never create sport, film-shaped fixtures stay
// TMDb-first).
import { describe, it, expect } from "vitest"
import { classifySportsProgramme } from "@/scripts/lib/livetv-sports-classifier.ts"

describe("classifySportsProgramme — brief §18 examples", () => {
  it("Man Utd v Sunderland: football fixture, teams as written, no invented identity", () => {
    const result = classifySportsProgramme("Man Utd v Sunderland")
    expect(result.isSport).toBe(true)
    expect(result.sport).toBe("football")
    expect(result.kind).toBe("fixture")
    expect(result.teams).toEqual(["Man Utd", "Sunderland"])
    expect(result.competition).toBeUndefined()
    // Both sides are known club aliases, so confidence is high — but the
    // output still never expands "Man Utd" to "Manchester United".
    expect(result.confidence).toBe("high")
    expect(JSON.stringify(result)).not.toContain("Manchester United")
  })

  it("NHL Hockey: ice-hockey league broadcast, high confidence", () => {
    const result = classifySportsProgramme("NHL Hockey")
    expect(result).toMatchObject({
      isSport: true,
      sport: "ice-hockey",
      kind: "league-broadcast",
      competition: "NHL",
      confidence: "high",
    })
    expect(result.teams).toBeUndefined()
  })

  it("Toronto Maple Leafs vs Boston Bruins: ice-hockey fixture, both sides known", () => {
    const result = classifySportsProgramme("Toronto Maple Leafs vs Boston Bruins")
    expect(result).toMatchObject({
      isSport: true,
      sport: "ice-hockey",
      kind: "fixture",
      confidence: "high",
    })
    expect(result.teams).toEqual(["Toronto Maple Leafs", "Boston Bruins"])
    expect(result.competition).toBeUndefined()
  })

  it("World Snooker Championship: snooker tournament, high confidence", () => {
    const result = classifySportsProgramme("World Snooker Championship")
    expect(result).toMatchObject({
      isSport: true,
      sport: "snooker",
      kind: "tournament",
      competition: "World Snooker Championship",
      confidence: "high",
    })
  })

  it("Snooker: Northern Ireland Open: snooker tournament from the Sport: Event label", () => {
    const result = classifySportsProgramme("Snooker: Northern Ireland Open")
    expect(result).toMatchObject({
      isSport: true,
      sport: "snooker",
      kind: "tournament",
      competition: "Northern Ireland Open",
      confidence: "high",
    })
  })

  it("Formula 1 Qualifying: motorsport tournament, high confidence", () => {
    const result = classifySportsProgramme("Formula 1 Qualifying")
    expect(result).toMatchObject({
      isSport: true,
      sport: "motorsport",
      kind: "tournament",
      competition: "Formula 1",
      confidence: "high",
    })
  })

  it("Six Nations Rugby: rugby tournament, high confidence", () => {
    const result = classifySportsProgramme("Six Nations Rugby")
    expect(result).toMatchObject({
      isSport: true,
      sport: "rugby",
      kind: "tournament",
      competition: "Six Nations",
      confidence: "high",
    })
  })

  it("PDC World Darts Championship: darts tournament, full competition name", () => {
    const result = classifySportsProgramme("PDC World Darts Championship")
    expect(result).toMatchObject({
      isSport: true,
      sport: "darts",
      kind: "tournament",
      competition: "PDC World Darts Championship",
      confidence: "high",
    })
  })

  it("EastEnders: non-sport, even on a sports channel in a Sports category", () => {
    expect(classifySportsProgramme("EastEnders")).toMatchObject({
      isSport: false,
      sport: null,
      kind: "non-sport",
    })
    expect(
      classifySportsProgramme("EastEnders", { channelName: "Sky Sports Main Event", category: "Sports" })
    ).toMatchObject({ isSport: false, kind: "non-sport" })
  })

  it("Peppa Pig: non-sport", () => {
    expect(classifySportsProgramme("Peppa Pig")).toMatchObject({
      isSport: false,
      sport: null,
      kind: "non-sport",
    })
  })

  it("a genuine film: non-sport, even on a sports channel", () => {
    expect(classifySportsProgramme("Inception", { channelName: "Sky Sports" })).toMatchObject({
      isSport: false,
      kind: "non-sport",
    })
    expect(classifySportsProgramme("The Shawshank Redemption")).toMatchObject({
      isSport: false,
      kind: "non-sport",
    })
  })

  it("unrecognised title: non-sport, low confidence", () => {
    expect(classifySportsProgramme("Xyzzy Quux Weekly")).toEqual({
      isSport: false,
      sport: null,
      kind: "non-sport",
      confidence: "low",
    })
  })
})

describe("classifySportsProgramme — no guessed identities", () => {
  it("bare 'United v Sunderland' is never asserted as Manchester United", () => {
    const result = classifySportsProgramme("United v Sunderland")
    expect(result.kind).toBe("fixture")
    expect(result.teams).toEqual(["United", "Sunderland"])
    expect(result.competition).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("Manchester")
  })

  it("film-shaped fixtures keep sport null and medium confidence (TMDb first)", () => {
    expect(classifySportsProgramme("Kramer vs Kramer")).toMatchObject({
      isSport: true,
      sport: null,
      kind: "fixture",
      confidence: "medium",
    })
    expect(classifySportsProgramme("Alien vs Predator").sport).toBeNull()
    expect(classifySportsProgramme("Man v Food").sport).toBeNull()
  })

  it("a bare World Cup is sport with an unknown sport — never assumed football", () => {
    expect(classifySportsProgramme("World Cup")).toMatchObject({
      isSport: true,
      sport: null,
      kind: "tournament",
      competition: "World Cup",
    })
    expect(classifySportsProgramme("Rugby World Cup").sport).toBe("rugby")
    expect(classifySportsProgramme("FIFA World Cup").sport).toBe("football")
  })

  it("a bare US Open keeps sport null; a sport keyword resolves it", () => {
    expect(classifySportsProgramme("US Open").sport).toBeNull()
    expect(classifySportsProgramme("US Open Golf").sport).toBe("golf")
    expect(classifySportsProgramme("US Open Tennis").sport).toBe("tennis")
  })
})

describe("classifySportsProgramme — fixture patterns", () => {
  it("recognises 'A @ B'", () => {
    expect(classifySportsProgramme("Lakers @ Celtics")).toMatchObject({
      kind: "fixture",
      teams: ["Lakers", "Celtics"],
    })
  })

  it("recognises 'A versus B'", () => {
    expect(classifySportsProgramme("Alien versus Predator")).toMatchObject({
      kind: "fixture",
      teams: ["Alien", "Predator"],
    })
  })

  it("recognises 'A v. B' and strips a leading Live label from side A", () => {
    expect(classifySportsProgramme("Live: Man Utd v. Sunderland")).toMatchObject({
      kind: "fixture",
      teams: ["Man Utd", "Sunderland"],
    })
  })

  it("strips a trailing competition segment from side B but keeps it as the competition", () => {
    const result = classifySportsProgramme("Man Utd v Sunderland: Premier League")
    expect(result.teams).toEqual(["Man Utd", "Sunderland"])
    expect(result.competition).toBe("Premier League")
    expect(result.confidence).toBe("high")
  })

  it("both known sides of one sport is high confidence (Leinster v Munster)", () => {
    expect(classifySportsProgramme("Leinster v Munster")).toMatchObject({
      sport: "rugby",
      kind: "fixture",
      confidence: "high",
    })
  })

  it("one known side and one unknown side stays medium (TMDb first)", () => {
    expect(classifySportsProgramme("Man Utd v Springfield")).toMatchObject({
      sport: "football",
      kind: "fixture",
      confidence: "medium",
    })
  })

  it("returns non-sport for empty and blank titles", () => {
    expect(classifySportsProgramme("")).toMatchObject({ isSport: false, kind: "non-sport" })
    expect(classifySportsProgramme("   ")).toMatchObject({ isSport: false, kind: "non-sport" })
  })
})

describe("classifySportsProgramme — labels, aliases and precedence", () => {
  it("Premier League Darts resolves to darts, not football", () => {
    expect(classifySportsProgramme("Premier League Darts").sport).toBe("darts")
  })

  it("an explicit Sport: label wins over other indicators", () => {
    expect(classifySportsProgramme("Darts: Premier League").sport).toBe("darts")
    expect(classifySportsProgramme("Snooker: The Masters").sport).toBe("snooker")
  })

  it("a bare 'The Masters' defaults to golf at low confidence", () => {
    expect(classifySportsProgramme("The Masters")).toMatchObject({
      sport: "golf",
      kind: "general-sport",
      confidence: "low",
    })
  })

  it("F1: Brazilian Grand Prix — Qualifying names the Grand Prix event", () => {
    expect(classifySportsProgramme("F1: Brazilian Grand Prix — Qualifying")).toMatchObject({
      sport: "motorsport",
      kind: "tournament",
      competition: "Brazilian Grand Prix",
      confidence: "high",
    })
  })

  it("F1: Build-Up is a league broadcast with the Formula 1 competition", () => {
    expect(classifySportsProgramme("F1: Build-Up")).toMatchObject({
      sport: "motorsport",
      kind: "league-broadcast",
      competition: "Formula 1",
    })
  })

  it("Cricket: The Ashes is a cricket tournament", () => {
    expect(classifySportsProgramme("Cricket: The Ashes")).toMatchObject({
      sport: "cricket",
      kind: "tournament",
    })
  })

  it("recognises other competitions: Super Bowl, Wimbledon, Tour de France, UFC", () => {
    expect(classifySportsProgramme("Super Bowl")).toMatchObject({ sport: "american-football", kind: "tournament" })
    expect(classifySportsProgramme("Wimbledon")).toMatchObject({ sport: "tennis", kind: "tournament" })
    expect(classifySportsProgramme("Tour de France")).toMatchObject({ sport: "cycling", kind: "tournament" })
    expect(classifySportsProgramme("UFC 300")).toMatchObject({ sport: "mma", confidence: "high" })
  })

  it("bare 'Hockey' maps to other-sport without an NHL signal (may be field hockey)", () => {
    expect(classifySportsProgramme("Hockey").sport).toBe("other-sport")
    expect(classifySportsProgramme("Ice Hockey").sport).toBe("ice-hockey")
  })

  it("Match of the Day stays non-sport so exact TMDb series art wins", () => {
    expect(classifySportsProgramme("Match of the Day")).toMatchObject({
      isSport: false,
      kind: "non-sport",
    })
  })
})

describe("classifySportsProgramme — channel/category as supporting evidence only", () => {
  it("a bare sport word is low alone and medium with sports-channel support", () => {
    expect(classifySportsProgramme("Snooker").confidence).toBe("low")
    expect(classifySportsProgramme("Snooker", { channelName: "Sky Sports" }).confidence).toBe("medium")
    expect(classifySportsProgramme("Snooker", { category: "Sports" }).confidence).toBe("medium")
  })

  it("channel support never lifts a title to high confidence", () => {
    expect(classifySportsProgramme("Golf", { channelName: "Sky Sports Golf" }).confidence).toBe("medium")
  })

  it("sport keyword + broadcast context is medium without any channel", () => {
    expect(classifySportsProgramme("Golf Highlights")).toMatchObject({
      sport: "golf",
      kind: "general-sport",
      confidence: "medium",
    })
  })

  it("a movie on a sports channel in a Sports category stays non-sport", () => {
    expect(
      classifySportsProgramme("The Godfather", { channelName: "Sky Sports Main Event", category: "Sports" })
    ).toMatchObject({ isSport: false, kind: "non-sport" })
  })
})
