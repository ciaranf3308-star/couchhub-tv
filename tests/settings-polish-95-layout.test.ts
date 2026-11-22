/**
 * @vitest-environment jsdom
 */
// Settings polish 0.11.24 — rail reachability, jump-grid removal,
// anchor offset (gaps 1, 2, 5 of the 0.11.23 verifier pass).
//
// Source-level pins for the layout contract; the real-browser
// behaviour (all 12 rail links visible at 1672/1920, first setting
// visible without scrolling, all 12 anchors landing fully visible,
// search filtering to the football-data card) is verified with
// Playwright against the preview build — see the polish report.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SETTINGS_SECTIONS } from "../src/scripts/settings/settings-index.ts"

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

describe("settings polish 0.11.24 — rail shows all 12 sections (gap 1)", () => {
  it("the index still has all 12 sections", () => {
    expect(SETTINGS_SECTIONS).toHaveLength(12)
    expect(SETTINGS_SECTIONS.map((s) => s.slug)).toEqual([
      "playlists",
      "profile",
      "display",
      "playback",
      "live-tv",
      "followed",
      "discover-ai",
      "casting",
      "data-backup",
      "app-updates",
      "help-diagnostics",
      "danger",
    ])
  })

  it("the shell renders one rail link per section plus All settings", () => {
    const shell = read("src/components/settings/SettingsShell.astro")
    expect(shell).toContain('class="settings-nav-link"')
    expect(shell).toContain("SETTINGS_SECTIONS.map((section) => (")
    expect(shell).toContain("All settings")
  })

  it("at lg+ the rail wraps instead of scrolling horizontally", () => {
    const shell = read("src/components/settings/SettingsShell.astro")
    const style = shell.slice(shell.indexOf("<style"))
    // The nav must be able to wrap: content-width never wraps.
    expect(style).toContain(
      "      .settings-page .settings-nav {\n        flex-wrap: wrap;\n        width: 100%;\n      }",
    )
    // And the scroller must not clip the second row at lg+.
    expect(style).toContain(
      "      .settings-page .settings-nav-scroller {\n        overflow: visible;\n        max-width: 100%;\n      }",
    )
    // No horizontal scroll affordance is left at lg+: the lg+
    // scroller block carries no overflow-x.
    const scrollerLg = style.match(
      /@media \(min-width: 64em\) \{\s*\.settings-page \.settings-nav-scroller \{([^}]*)\}/s,
    )?.[1]
    expect(scrollerLg).toBeDefined()
    expect(scrollerLg).not.toContain("overflow-x")
  })

  it("the search bar stays in the sticky subheader", () => {
    const shell = read("src/components/settings/SettingsShell.astro")
    const subStart = shell.indexOf('class="settings-subheader"')
    const searchAt = shell.indexOf('id="settings-search-input"')
    const stackAt = shell.indexOf('class="settings-stack"')
    expect(subStart).toBeGreaterThan(-1)
    expect(searchAt).toBeGreaterThan(subStart)
    expect(searchAt).toBeLessThan(stackAt)
  })
})

describe("settings polish 0.11.24 — jump grid gone, first setting at top (gap 2)", () => {
  it("no jump grid anywhere on the page or in the shell", () => {
    const page = read("src/pages/settings.astro")
    const shell = read("src/components/settings/SettingsShell.astro")
    for (const hay of [page, shell]) {
      expect(hay).not.toContain("settings-home-list")
      expect(hay).not.toContain("settings-jump-grid")
      expect(hay).not.toContain("settings-home-row")
    }
    expect(page).not.toContain("SETTINGS_SECTIONS.map")
  })

  it("the Exit action row is first, before Playlists, and is not a section", () => {
    const page = read("src/pages/settings.astro")
    const exitAt = page.indexOf('id="settings-exit-row"')
    const headDivAt = page.indexOf(
      '<div class="settings-section-head" id="playlists"',
    )
    expect(exitAt).toBeGreaterThan(-1)
    expect(headDivAt).toBeGreaterThan(exitAt)
    // Nothing but the row sits between the header and Playlists:
    // the row's closing tag is followed by only whitespace, then
    // the Playlists head — no other markup, no section of its own.
    const exitCloseAt = page.indexOf("</div>", exitAt)
    expect(page.slice(exitCloseAt + "</div>".length, headDivAt).trim()).toBe("")
  })

  it("the page sub no longer tells the user to pick a section below", () => {
    const page = read("src/pages/settings.astro")
    expect(page).not.toContain("Pick a section below")
    expect(page).toContain("Jump to a section above, or just scroll.")
    const en = JSON.parse(read("src/i18n/en.json")) as Record<string, string>
    expect(en["page.settings.sub"]).toContain("Jump to a section above")
    expect(en["page.settings.sub"]).not.toContain("Pick a section below")
  })

  it("search still filters the Exit row and the sections — not a menu", () => {
    const search = read("src/scripts/settings/settings_search.ts")
    expect(search).not.toContain("settings-home-list")
    expect(search).not.toContain("applyHomeFilter")
    expect(search).toContain('const EXIT_ROW_ID = "settings-exit-row"')
    expect(search).toContain("applyExitFilter")
    expect(search).toContain("applyPageFilter")
  })
})

describe("settings polish 0.11.24 — anchor scroll-margin consistent (gap 5)", () => {
  it("exactly one scroll-margin rule governs every anchor", () => {
    const shell = read("src/components/settings/SettingsShell.astro")
    // Strip CSS comments first: the (b) comment quotes the old
    // values, which must not count as rules.
    const style = shell
      .slice(shell.indexOf("<style"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
    const margins = [...style.matchAll(/scroll-margin-top:\s*([^;}]+)/g)].map((m) =>
      m[1].trim(),
    )
    expect(margins).toEqual([
      "calc(var(--settings-header-bottom, 232px) + 8px)",
    ])
    // The old section-head override (different value, no +8px) is gone:
    // the head rule keeps layout only.
    const headRule = style.match(
      /\.settings-page \.settings-section-head \{([^}]*)\}/s,
    )?.[1]
    expect(headRule).toBeDefined()
    expect(headRule).not.toContain("scroll-margin-top")
    expect(style).not.toContain("scroll-margin-top: var(--settings-header-bottom")
  })

  it("scroll-padding uses the same single value, and outranks CouchLayout's 7.5rem", () => {
    const shell = read("src/components/settings/SettingsShell.astro")
    // Strip CSS comments first: the (b) comment quotes
    // CouchLayout's 7.5rem, which must not count as a rule.
    const style = shell
      .slice(shell.indexOf("<style"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
    const paddings = [...style.matchAll(/scroll-padding-top:\s*([^;}]+)/g)].map((m) =>
      m[1].trim(),
    )
    expect(paddings).toEqual([
      "calc(var(--settings-header-bottom, 232px) + 8px)",
    ])
    // [data-couch] lifts the selector above CouchLayout's
    // `html[data-couch]{scroll-padding-top:7.5rem}` on specificity,
    // so the winner never depends on stylesheet load order.
    expect(style).toContain("html[data-couch]:has(.settings-page)")
  })

  it("the sticky offsets are re-measured when the subheader changes size", () => {
    const shell = read("src/components/settings/SettingsShell.astro")
    const script = shell.slice(shell.indexOf("<script>"))
    expect(script).toContain("new ResizeObserver")
    expect(script).toContain("syncSettingsStickyOffsets")
    expect(script).toContain('stickyObserver.observe(subEl)')
    expect(script).toContain('stickyObserver.observe(topEl)')
    // The old event-only sync is still there underneath.
    expect(script).toContain('window.addEventListener("resize", syncSettingsStickyOffsets)')
    expect(script).toContain("document.fonts?.ready?.then(syncSettingsStickyOffsets)")
  })
})

describe("settings polish 0.11.24 — version bump", () => {
  it("package.json, Cargo.toml and tauri.conf.json all say 0.11.25", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string }
    expect(pkg.version).toBe("0.11.25")
    expect(read("src-tauri/Cargo.toml")).toContain('version = "0.11.25"')
    const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      version: string
      bundle: { android: { versionCode: number } }
    }
    expect(conf.version).toBe("0.11.25")
    // sync-version formula: major*1e8 + minor*1e6 + patch*1e4 + 9000.
    expect(conf.bundle.android.versionCode).toBe(11_259_000)
  })
})
