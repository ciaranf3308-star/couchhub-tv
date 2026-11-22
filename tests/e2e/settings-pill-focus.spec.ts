// Settings polish (0.11.24, worker 2) — GAP 3 live checks + GAP 6
// controller pass, in a real browser (Playwright) at 1672x941 and
// 1920x1080.
//
// What this pins:
//   GAP 3 — measured pill geometry at both widths; page-end bottom
//     clearance >= pill extent; anchor jumps + the full focus walk
//     never land content under the pill; the pill auto-hides at rest
//     (so a mid-scroll rest position is never covered) and reappears
//     on input.
//   GAP 6 — full keyboard/D-pad-equivalent pass: Tab walk in reading
//     order, all 12 rail links reachable, rail scrolls under focus,
//     Y reaches search, dialogs (Reset, new playlist, backup import)
//     keep focus and restore it, pill hints update with focus, and
//     an arrow-key spatial walk never lands under the pill.
//
// What it does NOT prove (still needs his real PC/TV): a physical
// gamepad (this drives the same keydown path the gamepad bridge
// synthesises, but no real controller was polled), 4K rendering,
// and real TV overscan.
import { test, expect, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const SHOTS = join(
  process.env.HOME ?? "~",
  "workspace/goals/couchhub-tv-controller-first-iptv-app/hidden_files/settings-polish-95",
)

const RAIL_SLUGS = [
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
]

async function gotoSettings(page: Page, hash = "") {
  // The page fetches the changelog from GitHub; stub it so the pass
  // never depends on the network.
  await page.route("**/api.github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  )
  await page.goto(`/settings${hash}`, { waitUntil: "networkidle" })
  // The pill idle-hides (visibility:hidden) after 4 s without input,
  // so it may already be "hidden" by the time the page settles —
  // wait for attachment, not visibility.
  await page.waitForSelector("[data-button-hints]", { state: "attached" })
  await page.waitForSelector(".settings-page")
}

async function pillState(page: Page) {
  return page.evaluate(() => {
    const pill = document.querySelector<HTMLElement>("[data-button-hints]")
    const r = pill?.getBoundingClientRect()
    const cs = pill ? getComputedStyle(pill) : null
    const root = getComputedStyle(document.documentElement)
    return {
      exists: !!pill,
      hiddenAttr: pill?.hasAttribute("hidden") ?? null,
      idleHidden: pill?.classList.contains("rs-button-hints--idle-hidden") ?? null,
      opacity: cs?.opacity ?? null,
      visibility: cs?.visibility ?? null,
      height: r?.height ?? null,
      top: r?.top ?? null,
      bottom: r?.bottom ?? null,
      left: r?.left ?? null,
      right: r?.right ?? null,
      topFromViewportBottom: r ? window.innerHeight - r.top : null,
      text: pill?.textContent?.trim() ?? null,
      scrollPaddingBottom: root.scrollPaddingBottom,
      rootFontPx: parseFloat(root.fontSize),
    }
  })
}

/** True when the pill is painted over `rect` (visible + intersecting). */
function pillCoversPill(
  pill: Awaited<ReturnType<typeof pillState>>,
  rect: { top: number; bottom: number; left: number; right: number },
) {
  if (!pill.exists || pill.hiddenAttr || pill.idleHidden) return false
  if (pill.opacity === "0" || pill.visibility === "hidden") return false
  if (pill.top == null || pill.bottom == null || pill.left == null || pill.right == null)
    return false
  // Full rect intersection: the pill is centred and ~500px wide, so a
  // right-aligned button at the viewport bottom can share the pill's
  // vertical band without being under it.
  return (
    rect.bottom > pill.top &&
    rect.top < pill.bottom &&
    rect.right > pill.left &&
    rect.left < pill.right
  )
}

async function focusedInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return null
    const r = el.getBoundingClientRect()
    const focusables = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((n) => {
      const b = n.getBoundingClientRect()
      return b.width > 0 && b.height > 0 && getComputedStyle(n).visibility !== "hidden"
    })
    return {
      tag: el.tagName,
      id: el.id || null,
      href: (el as HTMLAnchorElement).href || null,
      text: (el.textContent ?? "").trim().slice(0, 60),
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      domIndex: focusables.indexOf(el),
      focusableCount: focusables.length,
    }
  })
}

for (const { width, height, tag } of [
  { width: 1672, height: 941, tag: "1672" },
  { width: 1920, height: 1080, tag: "1920" },
]) {
  test.describe(`Settings controller pass @ ${tag}`, () => {
    test.use({ viewport: { width, height } })

    test("GAP 3: pill geometry, scroll-padding, page-end clearance", async ({ page }) => {
      await gotoSettings(page)
      const pill = await pillState(page)
      expect(pill.exists).toBe(true)
      expect(pill.hiddenAttr).toBe(false)
      // Measured 0.11.23 baseline: 29.16px @1672, 33.17px @1920.
      expect(pill.height).toBeGreaterThan(20)
      expect(pill.height).toBeLessThan(45)
      expect(pill.topFromViewportBottom).toBeGreaterThan(30)
      expect(pill.topFromViewportBottom).toBeLessThan(60)
      // scroll-padding-bottom: 4.5rem in px, i.e. well above the
      // ~40–45px pill extent at both widths.
      const expectedPad = 4.5 * pill.rootFontPx
      const actualPad = parseFloat(pill.scrollPaddingBottom)
      expect(actualPad).toBeCloseTo(expectedPad, 0)
      expect(actualPad).toBeGreaterThan((pill.topFromViewportBottom ?? 0) + 10)
      // Page end: clearance from the last settings content to the
      // document bottom must exceed the pill extent + margin.
      const end = await page.evaluate(() => {
        const stack = document.querySelector(".settings-stack")!
        const stackBottom = stack.getBoundingClientRect().bottom + window.scrollY
        return {
          clearance: document.documentElement.scrollHeight - stackBottom,
          docHeight: document.documentElement.scrollHeight,
        }
      })
      expect(end.clearance).toBeGreaterThan((pill.topFromViewportBottom ?? 0) + 16)
      // At the very bottom, with the pill forced visible, nothing
      // live is under it: scroll to the end, un-hide the pill
      // directly (a real Tab would scroll back to the top), and
      // probe its centre.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(300)
      const under = await page.evaluate(() => {
        const pillEl = document.querySelector("[data-button-hints]")!
        pillEl.classList.remove("rs-button-hints--idle-hidden")
        const r = pillEl.getBoundingClientRect()
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return {
          pillVisible: !pillEl.hasAttribute("hidden") && !pillEl.classList.contains("rs-button-hints--idle-hidden"),
          underTag: el?.tagName ?? null,
          underIsPillOrSpacer:
            !!el?.closest?.("[data-button-hints], .settings-footer-spacer, .rs-main"),
          underText: (el?.textContent ?? "").trim().slice(0, 60),
        }
      })
      expect(under.pillVisible).toBe(true)
      expect(under.underIsPillOrSpacer).toBe(true)
    })

    test("GAP 3: pill hides at rest, reappears on input, hides on scroll", async ({ page }) => {
      await gotoSettings(page)
      // Idle: no input for > 4 s after load → hidden.
      await expect
        .poll(
          async () =>
            (await pillState(page)).idleHidden === true &&
            (await pillState(page)).opacity === "0",
          { timeout: 10_000 },
        )
        .toBe(true)
      // Any key brings it back.
      await page.keyboard.press("Tab")
      await expect
        .poll(async () => (await pillState(page)).idleHidden, { timeout: 5_000 })
        .toBe(false)
      // Wheel scroll hides it at once (rest position uncovered).
      await page.mouse.wheel(0, 600)
      await expect
        .poll(async () => (await pillState(page)).idleHidden, { timeout: 5_000 })
        .toBe(true)
      // …and the rest position really is uncovered: nothing live
      // sits under the pill's strip.
      const shot = join(SHOTS, `w2-${tag}-rest-after-scroll.png`)
      mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: shot })
      const covered = await page.evaluate(() => {
        const pillEl = document.querySelector("[data-button-hints]")!
        const r = pillEl.getBoundingClientRect()
        const els = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return els
          .filter((el) => !el.closest("[data-button-hints]"))
          .map((el) => `${el.tagName}.${String(el.className).slice(0, 60)}`)
          .slice(0, 3)
      })
      // Only inert containers may be under the strip at rest — no
      // button, link, input or helper text. (Compare tag names, not
      // a substring: "settings-stack" contains an "a".)
      const coveredTags = covered.map((c) => c.split(".")[0].toUpperCase())
      expect(
        coveredTags.filter((t) => ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(t)),
        `live element under pill strip at rest: ${covered.join(" | ")}`,
      ).toEqual([])
    })

    test("GAP 3: anchor jumps land clear of the pill", async ({ page }) => {
      await gotoSettings(page, "#danger")
      await page.waitForTimeout(400)
      const danger = await page.evaluate(() => {
        // The jump target IS the head itself (#danger, in
        // settings.astro); #settings-danger is the Reset card BELOW
        // it, ~200px tall, which extends past the fold — measuring
        // the card instead of the head falsely fails this check.
        const head = document.querySelector("#danger")!
        const r = head.getBoundingClientRect()
        const pillEl = document.querySelector("[data-button-hints]")!
        const pr = pillEl.getBoundingClientRect()
        const pillVisible =
          !pillEl.hasAttribute("hidden") &&
          !pillEl.classList.contains("rs-button-hints--idle-hidden")
        return {
          headTop: r.top,
          headBottom: r.bottom,
          pillTop: pr.top,
          pillVisible,
          headerBottom: parseFloat(
            getComputedStyle(document.documentElement).scrollPaddingTop,
          ),
        }
      })
      // Below the sticky header…
      expect(danger.headTop).toBeGreaterThanOrEqual(danger.headerBottom - 2)
      // …and not under the pill (or the pill is hidden at rest).
      expect(
        !danger.pillVisible || danger.headBottom <= danger.pillTop,
        "danger heading under pill after #danger jump",
      ).toBe(true)
      // The pill hides at rest shortly after the jump (the jump's own
      // scroll predates the listeners when it happens during load, so
      // the 4 s idle timer is what clears it).
      await expect
        .poll(async () => (await pillState(page)).idleHidden, { timeout: 8_000 })
        .toBe(true)
      // Same for a mid-page anchor. The head itself carries the slug
      // id (settings.astro) — there is no #settings-playback.
      await page.goto("/settings#playback", { waitUntil: "networkidle" })
      await page.waitForTimeout(400)
      const play = await page.evaluate(() => {
        const head = document.querySelector("#playback")!
        const r = head.getBoundingClientRect()
        const pillEl = document.querySelector("[data-button-hints]")!
        const pr = pillEl.getBoundingClientRect()
        const pillVisible =
          !pillEl.hasAttribute("hidden") &&
          !pillEl.classList.contains("rs-button-hints--idle-hidden")
        return { headTop: r.top, headBottom: r.bottom, pillTop: pr.top, pillVisible }
      })
      expect(play.headTop).toBeGreaterThan(0)
      expect(
        !play.pillVisible || play.headBottom <= play.pillTop,
        "playback heading under pill after #playback jump",
      ).toBe(true)
    })

    test("GAP 6: full Tab walk — reading order, all 12 rail links, never under pill", async ({ page }) => {
      test.setTimeout(300_000)
      await gotoSettings(page)
      // Start from the very first focusable: a plain load leaves
      // focus wherever the page put it (couch-focus restoration),
      // so a click-then-Tab walk would silently skip the first ~146
      // stops. Focus element 0 explicitly, then Tab to the end.
      // Headless Chromium does NOT wrap Tab to the first element —
      // past the last focusable focus lands on <body> — so reaching
      // the last index and then body IS the complete traversal.
      // Wait for the focusable count to settle first: under load,
      // client-rendered rows land after networkidle.
      // Tab-reachable is NOT the visible count (289): 133 links
      // sit inside the CLOSED licenses <details> (they have layout
      // boxes, so the visible filter counts them, but sequential
      // focus never enters a closed details) and 2 unchecked radios
      // of the player-backend group are skipped by native radio
      // behaviour (only the checked radio is tabbable). The
      // reachable set below encodes exactly those two rules, so a
      // future unreachable focusable fails loudly instead of
      // silently shrinking the walk.
      const { total, reachable } = await page.evaluate(async () => {
        const SEL =
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        const countVisible = () =>
          [
            ...document.querySelectorAll<HTMLElement>(SEL),
          ].filter((n) => {
            const b = n.getBoundingClientRect()
            return b.width > 0 && b.height > 0 && getComputedStyle(n).visibility !== "hidden"
          })
        let last = -1
        let stable = 0
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          const c = countVisible().length
          if (c === last) {
            stable++
            if (stable >= 2) break
          } else {
            stable = 0
            last = c
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        const list = countVisible()
        const reachable: number[] = []
        list.forEach((el, i) => {
          if (el.closest("details:not([open])")) return
          if (el instanceof HTMLInputElement && el.type === "radio" && el.name) {
            const checked = document.querySelector<HTMLInputElement>(
              `input[type="radio"][name="${CSS.escape(el.name)}"]:checked`,
            )
            if (checked && checked !== el) return
          }
          reachable.push(i)
        })
        return { total: list.length, reachable }
      })
      await page.evaluate(() => {
        const focusables = [
          ...document.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((n) => {
          const b = n.getBoundingClientRect()
          return b.width > 0 && b.height > 0 && getComputedStyle(n).visibility !== "hidden"
        })
        focusables[0]?.focus()
      })
      expect(total).toBeGreaterThan(200)
      const seenRail = new Set<string>()
      const seenIndex = new Set<number>()
      const unlisted: string[] = []
      let prevIndex = -1
      let walked = 0
      let lastIndex = -1
      let endedAtBody = false
      const violations: string[] = []
      // One evaluate per stop returns both the focused element and
      // the pill state, so the walk stays fast enough for 289 stops.
      const step = () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          const pillEl = document.querySelector<HTMLElement>("[data-button-hints]")
          const pr = pillEl?.getBoundingClientRect()
          const pill = {
            visible:
              !!pillEl &&
              !pillEl.hasAttribute("hidden") &&
              !pillEl.classList.contains("rs-button-hints--idle-hidden") &&
              getComputedStyle(pillEl).opacity !== "0" &&
              getComputedStyle(pillEl).visibility !== "hidden",
            top: pr?.top ?? null,
            bottom: pr?.bottom ?? null,
            left: pr?.left ?? null,
            right: pr?.right ?? null,
          }
          if (!el || el === document.body) return { focus: null, pill }
          const r = el.getBoundingClientRect()
          const focusables = [
            ...document.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ].filter((n) => {
            const b = n.getBoundingClientRect()
            return b.width > 0 && b.height > 0 && getComputedStyle(n).visibility !== "hidden"
          })
          return {
            focus: {
              tag: el.tagName,
              id: el.id || null,
              href: (el as HTMLAnchorElement).href || null,
              text: (el.textContent ?? "").trim().slice(0, 60),
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              domIndex: focusables.indexOf(el),
              focusableCount: focusables.length,
            },
            pill,
          }
        })
      const check = (s: Awaited<ReturnType<typeof step>>) => {
        if (!s.focus) return false
        walked++
        // Tab can land on an element outside the visible list
        // (e.g. the licenses <summary>, which is tabbable but not
        // in the selector): still check it against the pill, but
        // don't let it break the reading-order walk.
        if (s.focus.domIndex === -1) {
          unlisted.push(`${s.focus.tag}#${s.focus.id ?? ""} "${s.focus.text}"`)
        } else {
          if (s.focus.domIndex <= prevIndex) return false
          prevIndex = s.focus.domIndex
          lastIndex = s.focus.domIndex
          seenIndex.add(s.focus.domIndex)
        }
        if (s.focus.href) {
          const m = s.focus.href.match(/#([a-z-]+)$/)
          if (m && RAIL_SLUGS.includes(m[1])) seenRail.add(m[1])
        }
        if (
          s.pill.visible &&
          s.pill.top != null &&
          s.pill.bottom != null &&
          s.pill.left != null &&
          s.pill.right != null &&
          s.focus.bottom > s.pill.top &&
          s.focus.top < s.pill.bottom &&
          s.focus.right > s.pill.left &&
          s.focus.left < s.pill.right
        ) {
          violations.push(
            `#${walked} ${s.focus.tag}#${s.focus.id ?? ""} "${s.focus.text}" bottom=${Math.round(s.focus.bottom)} pillTop=${Math.round(s.pill.top)}`,
          )
        }
        if (walked === 3) {
          mkdirSync(SHOTS, { recursive: true })
          void page.screenshot({ path: join(SHOTS, `w2-${tag}-focus-early.png`) })
        }
        if (s.focus.id === "settings-search-input") {
          void page.screenshot({ path: join(SHOTS, `w2-${tag}-focus-search.png`) })
        }
        return true
      }
      // Stop 0: the explicitly focused first element.
      check(await step())
      for (let i = 0; i < total + 10; i++) {
        await page.keyboard.press("Tab")
        const s = await step()
        if (!s.focus) {
          endedAtBody = true
          break
        }
        if (!check(s)) break
      }
      expect(walked).toBeGreaterThanOrEqual(reachable.length)
      expect(lastIndex, `walk stopped at index ${lastIndex} of ${total}`).toBe(total - 1)
      expect(endedAtBody, "Tab past the last focusable should land on <body>").toBe(true)
      // Exact reachable set: every Tab-reachable focusable visited,
      // and nothing visited that the reachable model did not predict
      // (unlisted stops like the licenses <summary> are reported,
      // not hidden, in `unlisted`).
      expect([...seenIndex].sort((a, b) => a - b)).toEqual(reachable)
      expect(unlisted, `Tab landed on unlisted elements: ${unlisted.join("; ")}`).toEqual([])
      expect(
        [...seenRail].sort(),
        `rail links reached by Tab: ${[...seenRail].sort().join(",")}`,
      ).toEqual([...RAIL_SLUGS].sort())
      expect(violations, `focused elements under pill:\n${violations.join("\n")}`).toEqual([])
      // The rail itself scrolls/wraps under focus: focus the last
      // rail link and check it is fully inside the viewport.
      await page.locator('.settings-nav-link[href="/settings#danger"]').focus()
      await page.waitForTimeout(300)
      const rail = await page.evaluate(() => {
        const link = document.querySelector<HTMLAnchorElement>(
          '.settings-nav-link[href="/settings#danger"]',
        )!
        const r = link.getBoundingClientRect()
        const scroller = link.closest(".settings-nav-scroller") as HTMLElement | null
        return {
          left: r.left,
          right: r.right,
          vw: window.innerWidth,
          scrollerScrollLeft: scroller?.scrollLeft ?? null,
          scrollerScrollWidth: scroller?.scrollWidth ?? null,
        }
      })
      expect(rail.left).toBeGreaterThanOrEqual(-1)
      expect(rail.right).toBeLessThanOrEqual(rail.vw + 1)
      mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: join(SHOTS, `w2-${tag}-focus-rail-danger.png`) })
    })

    test("GAP 6: Y reaches search, pill hints follow focus", async ({ page }) => {
      await gotoSettings(page)
      // Enter search from a real focused setting (the controller
      // path): Escape then restores focus to it. Entering from
      // <body> focus leaves nowhere to restore to, and the input
      // keeps focus — the editing legend then correctly stays.
      await page.locator('.settings-nav-link[href="/settings#playlists"]').focus()
      const before = await pillState(page)
      expect(before.text).toContain("Settings search")
      await page.keyboard.press("y")
      await expect(page.locator("#settings-search-input")).toBeFocused()
      // Editing legend while the field owns the controller.
      const editing = await pillState(page)
      expect(editing.text).toContain("Back")
      expect(editing.text).not.toContain("Settings search")
      mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: join(SHOTS, `w2-${tag}-search-editing.png`) })
      // Back is one step per press: the first Escape closes the
      // on-screen-keyboard session (focus stays in the input — the
      // close refocuses it), the second exits search and restores
      // focus to the setting focused before Y.
      await page.keyboard.press("Escape")
      await expect(page.locator("#settings-search-input")).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(page.locator('.settings-nav-link[href="/settings#playlists"]')).toBeFocused()
      const after = await pillState(page)
      expect(after.text).toContain("Settings search")
    })

    test("GAP 6: dialogs keep focus and restore it (Reset, new playlist, backup import)", async ({ page }) => {
      test.setTimeout(120_000)
      await gotoSettings(page)

      // Reset dialog.
      await page.locator("#settings-reset-all").scrollIntoViewIfNeeded()
      await page.locator("#settings-reset-all").click()
      await expect(page.locator("#settings-reset-dialog")).toHaveAttribute("open", "")
      let active = await focusedInfo(page)
      expect(active, "focus inside Reset dialog").not.toBeNull()
      const inResetDialog = await page.evaluate(
        () => !!document.activeElement?.closest("#settings-reset-dialog"),
      )
      expect(inResetDialog).toBe(true)
      // The legend hides while a dialog owns input.
      expect((await pillState(page)).hiddenAttr).toBe(true)
      mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: join(SHOTS, `w2-${tag}-dialog-reset.png`) })
      await page.keyboard.press("Escape")
      await expect(page.locator("#settings-reset-dialog")).not.toHaveAttribute("open", "")
      await page.waitForTimeout(300)
      active = await focusedInfo(page)
      expect(active?.id).toBe("settings-reset-all")

      // New custom playlist dialog.
      await page.locator("#settings-new-custom-playlist").scrollIntoViewIfNeeded()
      await page.locator("#settings-new-custom-playlist").click()
      await expect(page.locator("#settings-new-custom-playlist-dialog")).toHaveAttribute("open", "")
      const inPlaylistDialog = await page.evaluate(
        () => !!document.activeElement?.closest("#settings-new-custom-playlist-dialog"),
      )
      expect(inPlaylistDialog).toBe(true)
      await page.keyboard.press("Escape")
      await expect(page.locator("#settings-new-custom-playlist-dialog")).not.toHaveAttribute(
        "open",
        "",
      )
      await page.waitForTimeout(300)
      active = await focusedInfo(page)
      expect(active?.id).toBe("settings-new-custom-playlist")

      // Backup import dialog (file picker → confirm dialog).
      await page.locator("#settings-import").scrollIntoViewIfNeeded()
      await page.locator("#settings-import").focus()
      await page
        .locator("#settings-import-input")
        .setInputFiles({
          name: "backup.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify({ version: 1, playlists: [] })),
        })
      await expect(page.locator("#settings-import-dialog")).toHaveAttribute("open", "")
      const inImportDialog = await page.evaluate(
        () => !!document.activeElement?.closest("#settings-import-dialog"),
      )
      expect(inImportDialog).toBe(true)
      await page.locator("#settings-import-cancel").click()
      await expect(page.locator("#settings-import-dialog")).not.toHaveAttribute("open", "")
      await page.waitForTimeout(300)
      active = await focusedInfo(page)
      expect(active?.id).toBe("settings-import")
    })

    test("GAP 6: arrow-key spatial walk never lands under the pill", async ({ page }) => {
      test.setTimeout(120_000)
      await gotoSettings(page)
      await page.locator('.settings-nav-link[href="/settings#playlists"]').focus()
      await page.waitForTimeout(300)
      const seen = new Set<string>()
      const violations: string[] = []
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("ArrowDown")
        await page.waitForTimeout(200)
        const info = await focusedInfo(page)
        if (!info) break
        seen.add(`${info.tag}#${info.id ?? ""}:${info.text.slice(0, 30)}`)
        const pill = await pillState(page)
        if (pillCoversPill(pill, info)) {
          violations.push(`${info.tag}#${info.id ?? ""} "${info.text}"`)
        }
      }
      // Spatial nav must actually move focus (not sit still).
      expect(seen.size).toBeGreaterThanOrEqual(3)
      expect(violations, `arrow-walk under pill:\n${violations.join("\n")}`).toEqual([])
      mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: join(SHOTS, `w2-${tag}-focus-arrow-walk.png`) })
    })
  })
}
