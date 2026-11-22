/**
 * @vitest-environment jsdom
 */
// Settings polish (0.11.24, worker 2) — GAP 3: the fixed controller
// pill overlaps Settings content.
//
// Measured on 0.11.23 in a real browser (Playwright, /settings):
//   1672x941  pill 29.16px tall, top edge 39.59px above viewport bottom
//   1920x1080 pill 33.17px tall, top edge 45.16px above viewport bottom
//   scroll-padding-bottom was `auto` (unset) at both widths
//   bottom clearance at page end: 139.75px / 160.33px — already ample
//   element under the pill's centre at a mid-scroll rest position:
//   live settings content (e.g. a "Reset to defaults" row), i.e. the
//   overlap is real and the footer spacer cannot fix it: the spacer
//   only helps at the document end, while a fixed overlay covers
//   whatever sits at the viewport bottom at ANY scroll position.
//
// This test pins the three-part fix at the source level (the live
// behaviour is pinned by tests/e2e/settings-pill-focus.spec.ts):
//
//   (a) bottom clearance (spacer + .rs-main padding) exceeds the
//       pill's full rendered extent (height + bottom offset) with
//       margin — verified, no change needed, pinned so nobody
//       shrinks the spacer below the pill;
//   (b) scroll-padding-bottom on Settings pages exceeds the pill
//       extent, so anchor jumps and focus scrolling never land
//       content under the pill;
//   (c) on Settings pages the pill auto-hides at rest (hide on
//       scroll, hide after an idle timeout, show on input), so a
//       mid-scroll rest position is never covered — scoped to
//       Settings, other pages keep the always-on legend.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

const HINTS = () => read("src/components/couch/TvButtonHints.astro")
const GLOBAL_CSS = () => read("src/styles/global.css")
const SHELL = () => read("src/components/settings/SettingsShell.astro")
const COUCH_CSS = () => read("src/styles/couch.css")

/** First `Nrem` value for a `prop: Nrem` declaration in `source`. */
function remValue(source: string, prop: string): number {
  const m = source.match(new RegExp(`${prop}:\\s*([0-9.]+)rem`))
  expect(m, `${prop} in rem expected`).not.toBeNull()
  return parseFloat(m![1])
}

describe("GAP 3 — pill geometry (measured 0.11.23, pinned)", () => {
  it("pill height + bottom offset derive from the stylesheet values", () => {
    const hints = HINTS()
    // Fixed bottom-anchored pill, unchanged by this polish.
    expect(hints).toContain("position: fixed")
    expect(hints).toContain("bottom: 0.75rem")
    expect(hints).toContain("pointer-events: none")
    const bottomOffset = remValue(hints, "bottom")
    // List padding 0.45rem top/bottom; tallest glyph 1.05rem; 1px border.
    const listPad = parseFloat(
      hints.match(/\.rs-button-hints__list \{[^}]*padding:\s*([0-9.]+)rem/)?.[1] ?? "",
    )
    expect(listPad).toBe(0.45)
    const glyphH = parseFloat(
      hints.match(/\.rs-hint-glyph \{[^}]*height:\s*([0-9.]+)rem/)?.[1] ?? "",
    )
    expect(glyphH).toBe(1.05)
    const pillHeightRem = 2 * listPad + glyphH
    expect(pillHeightRem).toBeCloseTo(1.95, 2)
    // Full rendered extent from the viewport bottom, in rem, with a
    // generous allowance for the 1px border + sub-pixel rounding.
    const extentRem = bottomOffset + pillHeightRem + 0.25
    expect(extentRem).toBeCloseTo(2.95, 2)
    // Cross-check against the live measurements: 39.59px @1672px
    // (root ~13.9px) and 45.16px @1920px (root 16px) — both under
    // 3rem, so the 2.95rem extent bound holds at both widths.
    expect(extentRem).toBeLessThan(3)
  })
})

describe("GAP 3 (a) — bottom clearance at page end exceeds the pill", () => {
  it("footer spacer + .rs-main padding clear the pill extent with margin", () => {
    const shell = SHELL()
    const spacer = parseFloat(
      shell.match(/\.settings-footer-spacer \{[^}]*height:\s*([0-9.]+)rem/)?.[1] ?? "",
    )
    expect(spacer).toBe(5.5)
    const mainPadDecl =
      COUCH_CSS().match(
        /html\[data-couch\] \.rs-main \{[^}]*padding:\s*([^;]+);/s,
      )?.[1] ?? ""
    // .rs-main padding is `0 clamp(1.5rem, 3vw, 3rem) 3rem` — the
    // LAST rem in the shorthand is the bottom padding.
    const mainPad = parseFloat(
      [...mainPadDecl.matchAll(/([0-9.]+)rem/g)].at(-1)?.[1] ?? "",
    )
    expect(mainPad).toBe(3)
    const clearanceRem = spacer + mainPad
    expect(clearanceRem).toBe(8.5)
    // Pill extent is < 3rem (see geometry test); clearance must
    // exceed it by at least 1rem. Measured live: 139.75px @1672px,
    // 160.33px @1920px — ~3.5x the pill extent.
    expect(clearanceRem).toBeGreaterThan(3 + 1)
  })
})

describe("GAP 3 (b) — scroll-padding-bottom on Settings pages", () => {
  it("global.css reserves pill height + margin at the scrollport bottom", () => {
    const css = GLOBAL_CSS()
    const m = css.match(
      /html:has\(\.settings-page\)\s*\{\s*scroll-padding-bottom:\s*([0-9.]+)rem;/,
    )
    expect(m, "scroll-padding-bottom rule for Settings pages in global.css").not.toBeNull()
    const padBottom = parseFloat(m![1])
    // Must exceed the < 3rem pill extent with a safe margin, and
    // stay proportional (rem tracks the viewport-scaled root font).
    expect(padBottom).toBeGreaterThanOrEqual(4)
    expect(padBottom).toBe(4.5)
  })

  it("the rule lives in global.css, not in SettingsShell (polish split)", () => {
    expect(SHELL()).not.toMatch(/scroll-padding-bottom/)
  })
})

describe("GAP 3 (c) — Settings-scoped idle auto-hide", () => {
  it("hides on scroll/wheel and after an idle timeout, shows on input", () => {
    const hints = HINTS()
    // Scoped to Settings only — view prop or .settings-page presence.
    expect(hints).toMatch(/view === "settings"/)
    expect(hints).toMatch(/document\.querySelector\("\.settings-page"\)/)
    expect(hints).toMatch(/if \(isSettingsHints\)/)
    // Hide triggers: wheel (hide at once while scrolling to read),
    // any non-focus scroll, and the idle timer.
    expect(hints).toMatch(/addEventListener\("wheel"/)
    expect(hints).toMatch(/addEventListener\(\s*"scroll"/)
    expect(hints).toMatch(/PILL_IDLE_HIDE_MS = 4000/)
    expect(hints).toMatch(/setTimeout\(\s*\(\) => setPillIdleHidden\(true\)/)
    // Show triggers: keys (physical + the gamepad's synthetic
    // KeyboardEvents), pointer press, focus move.
    expect(hints).toMatch(/addEventListener\("keydown", notePillActivity\)/)
    expect(hints).toMatch(/addEventListener\("pointerdown", notePillActivity\)/)
    expect(hints).toMatch(/addEventListener\("focusin", notePillActivity\)/)
    // Focus-follow scrolls (right after a key/pointer/focus move)
    // must NOT hide the pill — the walk keeps its legend.
    expect(hints).toMatch(/PILL_FOCUS_SCROLL_WINDOW_MS = 600/)
    // Cursor Mode steers a visible pointer: never idle-hide under it.
    expect(hints).toMatch(/dataset\.cursorMode === "active"/)
  })

  it("the idle-hidden state is a fading class, not display:none", () => {
    const hints = HINTS()
    expect(hints).toContain("rs-button-hints--idle-hidden")
    expect(hints).toMatch(
      /\.rs-button-hints--idle-hidden \{\s*opacity: 0;\s*visibility: hidden;/,
    )
    expect(hints).toMatch(/transition:\s*opacity 250ms ease,\s*visibility 250ms ease;/)
    // Reduced motion: no fade.
    expect(hints).toMatch(/prefers-reduced-motion: reduce/)
  })

  it("other pages keep the always-on legend (no idle wiring outside the gate)", () => {
    const hints = HINTS()
    // Every idle listener registration sits inside the Settings gate:
    // the only `addEventListener("wheel"` / scroll / timer arming in
    // the file is the gated block — count the gated occurrences.
    const wheelCount = (hints.match(/addEventListener\("wheel"/g) ?? []).length
    expect(wheelCount).toBe(1)
    const armCount = (hints.match(/armPillIdleTimer\(\);/g) ?? []).length
    // One arm inside notePillActivity, one in the scroll guard, one
    // initial arm — all inside the gated block or its helpers.
    expect(armCount).toBe(3)
    expect(hints).not.toMatch(/isSettingsHints = false/)
  })
})
