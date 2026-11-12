// W5 — Controller Experience 2.0 (0.11.10): detailHrefWithoutAutoplay.
// Cards must carry an explicit detail href (no autoplay) so the X
// menu and A/Play routing never depend on fragile `?autoplay` URL
// checks. Only the autoplay param is removed; season/epnum/episode
// and hashes survive.
import { describe, it, expect } from "vitest"
import { detailHrefWithoutAutoplay } from "../src/scripts/lib/home-rails"

describe("detailHrefWithoutAutoplay", () => {
  it("returns plain hrefs unchanged", () => {
    expect(detailHrefWithoutAutoplay("/movies/detail?id=42")).toBe(
      "/movies/detail?id=42",
    )
    expect(detailHrefWithoutAutoplay("/series/detail?id=9")).toBe(
      "/series/detail?id=9",
    )
  })

  it("removes only the autoplay param, preserving the rest", () => {
    expect(
      detailHrefWithoutAutoplay("/movies/detail?id=42&autoplay=1"),
    ).toBe("/movies/detail?id=42")
    expect(
      detailHrefWithoutAutoplay("/movies/detail?autoplay=1&id=42"),
    ).toBe("/movies/detail?id=42")
    expect(
      detailHrefWithoutAutoplay(
        "/series/detail?id=9&season=2&epnum=3&autoplay=1",
      ),
    ).toBe("/series/detail?id=9&season=2&epnum=3")
    expect(
      detailHrefWithoutAutoplay("/movies/detail?id=42&episode=7&autoplay=1"),
    ).toBe("/movies/detail?id=42&episode=7")
  })

  it("preserves hashes", () => {
    expect(
      detailHrefWithoutAutoplay("/movies/detail?id=42&autoplay=1#player"),
    ).toBe("/movies/detail?id=42#player")
  })

  it("leaves lookalike params alone", () => {
    expect(
      detailHrefWithoutAutoplay("/movies/detail?id=42&autoplayx=1"),
    ).toBe("/movies/detail?id=42&autoplayx=1")
  })

  it("returns unparseable hrefs unchanged", () => {
    expect(detailHrefWithoutAutoplay("")).toBe("")
    expect(detailHrefWithoutAutoplay("::::")).toBe("::::")
  })

  it("collapses absolute URLs to their in-app path", () => {
    // All call sites pass relative in-app hrefs; an absolute URL
    // degrades to its path rather than leaking an origin.
    expect(
      detailHrefWithoutAutoplay(
        "https://example.invalid/movies/detail?id=42&autoplay=1",
      ),
    ).toBe("/movies/detail?id=42")
  })
})
