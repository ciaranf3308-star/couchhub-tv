// Discover Orbology (0.11.20) — the glowing neural orb replaces the
// three brain PNGs; entry beat, step transitions, floating primaries,
// neural-blue nav pill, single hints source, and the step-3 fit
// budget. Source-level assertions (the orb itself is canvas-drawn,
// so geometry/behaviour values are pinned here and verified live by
// the Playwright pass in the spec's §11).
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as redesign from "../src/scripts/lib/discover-redesign"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..")
const view = readFileSync(join(repo, "src/components/DiscoverView.svelte"), "utf8")
const redesignSrc = readFileSync(
  join(repo, "src/scripts/lib/discover-redesign.ts"),
  "utf8",
)
const couchCss = readFileSync(join(repo, "src/styles/couch.css"), "utf8")

describe("Orbology: brain art is gone, the orb owns the glow", () => {
  it("has no brain markup, brain CSS, or brain asset references", () => {
    expect(view).not.toContain("rs-brain")
    expect(view).not.toContain("brain-step")
    expect(redesignSrc).not.toContain("brain-step")
  })

  it("deletes the STEP_BRAIN_ART export (and nothing imports it)", () => {
    expect("STEP_BRAIN_ART" in redesign).toBe(false)
    expect(redesignSrc).not.toContain("STEP_BRAIN_ART")
  })

  it("deletes the three brain PNGs and adds no new asset", () => {
    for (const n of [1, 2, 3]) {
      expect(existsSync(join(repo, `public/art/discover/brain-step${n}.png`))).toBe(false)
    }
  })

  it("keeps the card and genre art", () => {
    expect(redesign.KIND_CARDS.map((c) => c.art)).toEqual([
      "/art/discover/card-movie.png",
      "/art/discover/card-series.png",
      "/art/discover/card-either.png",
    ])
    expect(redesign.GENRE_CATEGORIES).toHaveLength(8)
    for (const g of redesign.GENRE_CATEGORIES) {
      expect(g.art).toMatch(/^\/art\/discover\/genre-[a-z]+\.png$/)
      expect(existsSync(join(repo, "public", g.art))).toBe(true)
    }
  })
})

describe("Orbology: the orb", () => {
  it("defines per-step geometry (kind centre-top, categories top-right, brief right, loading centre, reveal dim ember)", () => {
    expect(view).toContain("kind: { cx: 0.5, cy: 0.24, r: 150, alpha: 1 }")
    expect(view).toContain("categories: { cx: 0.84, cy: 0.16, r: 120, alpha: 1 }")
    expect(view).toContain("brief: { cx: 0.82, cy: 0.28, r: 165, alpha: 1 }")
    expect(view).toContain("loading: { cx: 0.5, cy: 0.36, r: 165, alpha: 1 }")
    expect(view).toContain("reveal: { cx: 0.5, cy: 0.12, r: 80, alpha: 0.45 }")
  })

  it("draws 14 dots on two tilted elliptical orbits, advancing by wall-clock time", () => {
    expect(view).toContain("Array.from({ length: 14 }")
    expect(view).toContain("0.85")
    expect(view).toContain("1.15")
    expect(view).toContain("now / 1000")
  })

  it("breathes 6s (loading 2.4s, doubled amplitude) and glides 500ms on step change", () => {
    expect(view).toContain("breathingPeriod = step === \"loading\" ? 2400 : 6000")
    expect(view).toContain("breathingAmp = step === \"loading\" ? 0.06 : 0.03")
    expect(view).toContain("elapsed / 500")
    expect(view).toContain("orbEase(p)")
  })

  it("flashes for 600ms on every pick, and pulses converge on the orb centre", () => {
    expect(view).toContain("orbFlashUntil = performance.now() + 600")
    expect(view).toContain("const tx = showOrb ? orbCx")
    expect(view).toContain("const ty = showOrb ? orbCy")
  })

  it("pulses on surpriseMe and goToBrief too, not just pick/toggle", () => {
    const surprise = view.slice(view.indexOf("function surpriseMe()"), view.indexOf("function goToBrief()"))
    expect(surprise).toContain("pulseNeural()")
    const brief = view.slice(view.indexOf("function goToBrief()"), view.indexOf("function skipBrief()"))
    expect(brief).toContain("pulseNeural()")
  })

  it("skips the orb below 1100px wide", () => {
    expect(view).toContain("getBoundingClientRect().width >= 1100")
  })

  it("thins the neuron field by half (1 per 52000 px², cap 32, filament alpha 0.10)", () => {
    expect(view).toContain("/ 52000")
    expect(view).toContain("Math.min(32, Math.max(14, count))")
    expect(view).toContain("d < 130")
    expect(view).toContain("0.1 * (1 - d / 130)")
    expect(view).toContain("rgba(140, 200, 255, 0.6)")
    expect(view).toContain("Math.random() < 0.012")
  })
})

describe("Orbology: entry beat + step transitions", () => {
  it("renders the mount-only Welcome to Discovery card with the step-1 sub copy", () => {
    expect(view).toContain("Welcome to Discovery")
    expect(view).toContain("rs-discover-entry__title")
    expect(view).toContain("rs-discover-entry__sub")
    expect(view).toContain("setTimeout(() => {")
    expect(view).toContain("}, 950)")
  })

  it("never blocks input and never shows under reduced motion", () => {
    expect(view).toContain("pointer-events: none;")
    expect(view).toContain(".rs-discover-entry {\n      display: none;")
  })

  it("animates steps in 380ms (opacity + translate only) with a 150ms first-mount delay", () => {
    expect(view).toContain("rs-step-in 380ms cubic-bezier(0.16, 1, 0.3, 1)")
    expect(view).toContain("transform: translateY(10px)")
    expect(view).toContain("animation-delay: 150ms")
  })
})

describe("Orbology: blemish fixes", () => {
  it("paints the Discover nav pill neural blue from DiscoverView, never from couch.css", () => {
    expect(view).toContain("#0D8CFD")
    expect(view).toContain('.rs-nav__link.is-active[href="/discover"]')
    expect(couchCss).not.toContain("#0D8CFD")
    expect(couchCss).not.toContain("#0d8cfd")
  })

  it("has exactly one hints source: no in-view .rs-flow-hints rows", () => {
    expect(view).not.toContain("rs-flow-hints")
    // The shell pill is still fed per step.
    expect(view).toContain('id: "discover-kind"')
    expect(view).toContain('id: "discover-categories"')
    expect(view).toContain('id: "discover-brief"')
    expect(view).toContain('id: "discover-reveal"')
  })

  it("fits step 3: the itemised budget values are in the CSS", () => {
    expect(view).toContain("padding-bottom: 2rem;")
    expect(view).toContain("min-height: 10.6rem;")
    // rows="2", not 3: rows set the intrinsic height and min-height
    // only raises it — rows="3" left the box at ~185px and the
    // min-height cut nothing (spec §7 item 3 as written is a no-op).
    expect(view).toContain('rows="2"')
    expect(view).toContain("font-size: 4.3rem;")
    expect(view).toContain("padding: 0.5rem 2.01rem;")
  })

  it("keeps the honest no-key first line, drops the redundant second line", () => {
    expect(view).toContain("No API key saved — set one up in Settings to ask AI.")
    expect(view).not.toContain("AI picks need a key — or browse your library locally instead.")
    expect(view).toContain("Open AI settings")
    expect(view).toContain("Browse similar titles in my library")
  })

  it("makes the no-key panel and the flow notice exclusive", () => {
    expect(view).toContain("{#if !canAskAi && !flowNotice}")
  })

  it("removes the duplicated mode detail row but keeps its title attribute", () => {
    expect(view).not.toContain("rs-discover-mode__detail")
    expect(view).toContain("title={aiDetail}")
  })
})

describe("Orbology: float + focus", () => {
  it("floats primaries only, 5s ±3px, paused on hover/focus", () => {
    expect(view).toContain("rs-float 5s ease-in-out infinite")
    expect(view).toContain("transform: translateY(-3px)")
    expect(view).toContain("animation-play-state: paused;")
  })

  it("gives Discover controls a neural focus outline, not the pink global ring", () => {
    expect(view).toContain(".rs-discover .rs-flow-link:focus-visible,")
    expect(view).toContain("outline: 3px solid #CDFFFF;")
  })
})
