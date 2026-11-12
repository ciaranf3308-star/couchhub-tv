/**
 * @vitest-environment jsdom
 */
// Movies & Series 2.0 (0.11.8, W5) acceptance tests 31–40:
// BROWSER / NAVIGATION.
//
// Focus and input tests drive the REAL seams where they exist on the
// base: handleGamepadButtonPress / dispatchNativeButton (the shared
// action pipeline), findOpenModal / firstFocusableInModal (modal
// detection), findReplacementFocus + the focus-memory helpers
// (couch-focus.ts). The grid, drawer and detail-return surfaces are
// the W2 contract stub (mountBrowseEverything) — flagged stub-backed
// in the contract map. No network, no provider calls.

import { describe, it, expect, beforeEach } from "vitest"
import {
  dispatchNativeButton,
  handleGamepadButtonPress,
} from "@/scripts/lib/gamepad.ts"
import {
  findOpenModal,
  firstFocusableInModal,
} from "@/scripts/lib/dialog-spatial-nav.ts"
import {
  clearCouchFocusMemory,
  findReplacementFocus,
  recordCouchFocus,
} from "@/scripts/lib/couch-focus.ts"
import {
  activeFilterSummary,
  applyFilters,
  createBrowseState,
  deriveBrowsePage,
  getBrowseInstrumentation,
  getCatalogIndex,
  isDefaultBrowseState,
  mountBrowseEverything,
  pageCountFor,
  parseModeFromUrl,
  resetBrowseInstrumentation,
  resetCatalogIndexCache,
  setModeInUrl,
  setPage,
  type CatalogEntry,
  type CatalogIndex,
} from "./movies-series-2.0-stubs.ts"
import {
  adversarialFixture,
  generateCatalogue,
} from "./fixtures-0118-catalogue.ts"

const BTN_A = 0
const BTN_B = 1

let revisionCounter = 4000
function freshIndex(kind: "vod" | "series", entries: CatalogEntry[]): CatalogIndex {
  revisionCounter += 1
  return getCatalogIndex(kind, entries, revisionCounter)
}

function keydown(target: Element, key: string, extra: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }))
}

function makeVisible(el: Element): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      width: 120, height: 180, top: 0, left: 0,
      right: 120, bottom: 180, x: 0, y: 0, toJSON: () => ({}),
    }),
    configurable: true,
  })
  Object.defineProperty(el, "getClientRects", {
    value: () => [{ width: 120, height: 180, top: 0, left: 0, right: 120, bottom: 180, x: 0, y: 0 }],
    configurable: true,
  })
}

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

const ADV = adversarialFixture()

beforeEach(() => {
  document.body.innerHTML = ""
  document.documentElement.removeAttribute("data-livetv-mode")
  Object.defineProperty(globalThis, "sessionStorage", {
    value: makeStorage(),
    configurable: true,
  })
  clearCouchFocusMemory()
  resetCatalogIndexCache()
  resetBrowseInstrumentation()
})

async function mounted(index: CatalogIndex, pageSize = 60) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const activations: string[] = []
  const mount = mountBrowseEverything(container, {
    index,
    state: createBrowseState(index.kind, { pageSize }),
    onActivate: (group) => {
      activations.push(group.key)
    },
  })
  await mount.awaitSettled()
  return { container, mount, activations }
}

describe("0.11.8 browser/navigation acceptance (tests 31–40)", { timeout: 120000 }, () => {
  it("31. Paging reaches every title", () => {
    const catalogue = generateCatalogue({ seed: 0x1031, movieCount: 500, seriesCount: 0 })
    const index = freshIndex("vod", catalogue.movies)
    const pageSize = 25
    const base = createBrowseState("vod", { pageSize })
    const first = deriveBrowsePage(index, base)
    expect(first.pageCount).toBe(Math.ceil(first.totalGroups / pageSize))
    const seen = new Set<number>()
    for (let page = 0; page < first.pageCount; page++) {
      const derived = deriveBrowsePage(index, setPage(base, page, first.totalGroups))
      expect(derived.page).toBe(page)
      for (const group of derived.groups) {
        for (const variant of group.variants) {
          expect(seen.has(variant.id)).toBe(false)
          seen.add(variant.id)
        }
      }
    }
    // Every catalogue entry appears on exactly one page.
    expect(seen.size).toBe(catalogue.movies.length)
    expect([...seen].sort((a, b) => a - b)).toEqual(
      catalogue.movies.map((e) => e.id).sort((a, b) => a - b)
    )
    // The mount agrees: walking pages with the handle visits all groups.
    return (async () => {
      const { mount } = await mounted(index, pageSize)
      const walked = new Set<string>()
      for (let page = 0; page < first.pageCount; page++) {
        mount.setPage(page)
        await mount.awaitSettled()
        for (const key of mount.getRenderedGroupKeys()) {
          expect(walked.has(key)).toBe(false)
          walked.add(key)
        }
      }
      expect(walked.size).toBe(first.totalGroups)
      mount.unmount()
    })()
  })

  it("32. Boundary pages are correct", () => {
    const index = freshIndex("vod", ADV.movies)
    const total = deriveBrowsePage(index, createBrowseState("vod")).totalGroups
    expect(total).toBeGreaterThan(2)
    // Page size == total → exactly one page.
    expect(pageCountFor(total, total)).toBe(1)
    expect(deriveBrowsePage(index, createBrowseState("vod", { pageSize: total })).groups).toHaveLength(total)
    // Page size == total - 1 → two pages, last page holds exactly one group.
    const two = deriveBrowsePage(
      index,
      setPage(createBrowseState("vod", { pageSize: total - 1 }), 1, total)
    )
    expect(two.pageCount).toBe(2)
    expect(two.groups).toHaveLength(1)
    // Page size > total → one page, no phantom second page.
    expect(pageCountFor(total, total + 1)).toBe(1)
    // Clamping: negative → 0, overlarge → last page.
    expect(setPage(createBrowseState("vod"), -5, total).page).toBe(0)
    const last = setPage(createBrowseState("vod", { pageSize: 5 }), 99, total)
    expect(last.page).toBe(Math.ceil(total / 5) - 1)
    // Empty result: zero pages, page 0, no cards.
    const empty = deriveBrowsePage(
      index,
      setPage(createBrowseState("vod"), 0, 0)
    )
    expect(pageCountFor(0, 60)).toBe(0)
    expect(empty.page).toBe(0)
    const noMatch = deriveBrowsePage(
      index,
      applyFilters(createBrowseState("vod"), { minRating: 10, maxRuntime: 1 })
    )
    expect(noMatch.pageCount).toBe(0)
    expect(noMatch.groups).toEqual([])
  })

  it("33. Filters preserve correct page counts", () => {
    const catalogue = generateCatalogue({ seed: 0x1033, movieCount: 800, seriesCount: 0 })
    const index = freshIndex("vod", catalogue.movies)
    const pageSize = 30
    const states = [
      createBrowseState("vod", { pageSize }),
      applyFilters(createBrowseState("vod", { pageSize }), { genre: "action" }),
      applyFilters(createBrowseState("vod", { pageSize }), { minRating: 8 }),
      applyFilters(createBrowseState("vod", { pageSize }), { maxRuntime: 120 }),
      applyFilters(createBrowseState("vod", { pageSize }), { genre: "comedy", minRating: 7 }),
    ]
    for (const state of states) {
      const first = deriveBrowsePage(index, state)
      expect(first.pageCount).toBe(pageCountFor(first.totalGroups, pageSize))
      let walked = 0
      for (let page = 0; page < first.pageCount; page++) {
        const derived = deriveBrowsePage(index, setPage(state, page, first.totalGroups))
        const expected =
          page < first.pageCount - 1
            ? pageSize
            : first.totalGroups - pageSize * (first.pageCount - 1)
        expect(derived.groups).toHaveLength(expected)
        walked += derived.groups.length
      }
      expect(walked).toBe(first.totalGroups)
    }
  })

  it("34. B returns to the correct page and card", async () => {
    const catalogue = generateCatalogue({ seed: 0x1034, movieCount: 300, seriesCount: 0 })
    const index = freshIndex("vod", catalogue.movies)
    const { mount } = await mounted(index, 30)
    mount.setPage(2)
    await mount.awaitSettled()
    expect(mount.getState().page).toBe(2)
    const card = mount.focusCard(5)
    const key = card?.getAttribute("data-group-key")
    expect(key).toBeTruthy()
    mount.openDetail(key as string)
    expect(mount.isDetailOpen()).toBe(true)
    // B through the REAL shared action pipeline (gamepad.ts): B
    // dispatches Escape, the mount's back step runs exactly once.
    handleGamepadButtonPress(BTN_B, performance.now())
    expect(mount.isDetailOpen()).toBe(false)
    expect(mount.getState().page).toBe(2)
    expect(mount.getFocusedCard()?.getAttribute("data-group-key")).toBe(key)
    // And again via a raw Escape keydown: same page, same card.
    const card2 = mount.focusCard(7)
    const key2 = card2?.getAttribute("data-group-key") as string
    mount.openDetail(key2)
    keydown(document.activeElement as Element, "Escape")
    expect(mount.isDetailOpen()).toBe(false)
    expect(mount.getState().page).toBe(2)
    expect(mount.getFocusedCard()?.getAttribute("data-group-key")).toBe(key2)
    mount.unmount()
  })

  it("35. Filter drawer traps focus", async () => {
    const index = freshIndex("vod", ADV.movies)
    const { container, mount } = await mounted(index, 30)
    mount.focusCard(0)
    const drawer = mount.openFilterDrawer()
    makeVisible(drawer.element)
    drawer.element.querySelectorAll("select, button").forEach(makeVisible)
    // The REAL modal detection sees the drawer as an open modal.
    expect(findOpenModal(document)).toBe(drawer.element)
    expect(firstFocusableInModal(drawer.element)).not.toBeNull()
    // Focus starts inside the drawer.
    expect(drawer.element.contains(document.activeElement)).toBe(true)
    const controls = [...drawer.element.querySelectorAll<HTMLElement>("select, button")]
    expect(controls.length).toBeGreaterThanOrEqual(3)
    const first = controls[0]
    const last = controls[controls.length - 1]
    // Tab on the last control wraps to the first.
    last.focus()
    keydown(last, "Tab")
    expect(document.activeElement).toBe(first)
    // Shift+Tab on the first control wraps to the last.
    first.focus()
    keydown(first, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)
    // Tab from a middle control never leaves the drawer.
    controls[1].focus()
    keydown(controls[1], "Tab")
    expect(drawer.element.contains(document.activeElement)).toBe(true)
    // No grid card can be focused while the drawer owns input: focus
    // stays inside even after repeated Tabs.
    for (let i = 0; i < controls.length + 2; i++) {
      keydown(document.activeElement as Element, "Tab")
      expect(drawer.element.contains(document.activeElement)).toBe(true)
    }
    expect(container.querySelector("[data-filter-drawer]")).not.toBeNull()
    mount.unmount()
  })

  it("36. Closing the drawer restores focus", async () => {
    const index = freshIndex("vod", ADV.movies)
    const { mount } = await mounted(index, 30)
    const card = mount.focusCard(4)
    const key = card?.getAttribute("data-group-key")
    const drawer = mount.openFilterDrawer()
    expect(mount.getFocusedCard()).toBeNull() // focus moved into the drawer
    // Close via the Done button: focus returns to the same card.
    const done = drawer.element.querySelector<HTMLElement>("[data-filter-close]")
    done?.click()
    expect(mount.getDrawer()).toBeNull()
    expect(mount.getFocusedCard()?.getAttribute("data-group-key")).toBe(key)
    // Close via Escape: same restore.
    mount.openFilterDrawer()
    keydown(document.activeElement as Element, "Escape")
    expect(mount.getDrawer()).toBeNull()
    expect(mount.getFocusedCard()?.getAttribute("data-group-key")).toBe(key)
    // Drawer Reset All removes every constraint (mount-level test 26).
    mount.applyFilters({ genre: "horror", minRating: 8 })
    await mount.awaitSettled()
    expect(isDefaultBrowseState(mount.getState())).toBe(false)
    const drawer2 = mount.openFilterDrawer()
    const reset = drawer2.element.querySelector<HTMLElement>("[data-filter-reset]")
    reset?.click()
    await mount.awaitSettled()
    expect(isDefaultBrowseState(mount.getState())).toBe(true)
    expect(activeFilterSummary(mount.getState())).toEqual([])
    mount.unmount()
  })

  it("37. A never double-activates", async () => {
    const index = freshIndex("vod", ADV.movies)
    const { mount, activations } = await mounted(index, 30)
    const card = mount.focusCard(2)
    expect(card).not.toBeNull()
    // One Enter keydown → one activation.
    keydown(card as Element, "Enter")
    expect(activations).toHaveLength(1)
    // A held key (repeat) → no additional activation.
    keydown(card as Element, "Enter", { repeat: true })
    keydown(card as Element, "Enter", { repeat: true })
    expect(activations).toHaveLength(1)
    // A through the REAL gamepad pipeline → exactly one more.
    handleGamepadButtonPress(BTN_A, performance.now())
    expect(activations).toHaveLength(2)
    // A through the REAL native XInput path → exactly one more.
    dispatchNativeButton("a", true, performance.now())
    dispatchNativeButton("a", false, performance.now())
    expect(activations).toHaveLength(3)
    // A genuine second press is a genuine second activation (no
    // debounce swallowing real input).
    keydown(card as Element, "Enter")
    expect(activations).toHaveLength(4)
    // All activations named the same focused card.
    const key = card?.getAttribute("data-group-key")
    expect(new Set(activations)).toEqual(new Set([key]))
    mount.unmount()
  })

  it("38. Repeated navigation never loses focus", async () => {
    const catalogue = generateCatalogue({ seed: 0x1038, movieCount: 300, seriesCount: 0 })
    const index = freshIndex("vod", catalogue.movies)
    const { container, mount } = await mounted(index, 30)
    mount.focusCard(0)
    const moves: Array<[string, KeyboardEventInit?]> = [
      ["ArrowRight"], ["ArrowRight"], ["ArrowDown"], ["ArrowLeft"],
      ["ArrowUp"], ["ArrowDown"], ["ArrowDown"], ["End"], ["Home"],
      ["ArrowRight"], ["PageDown"], ["ArrowRight"], ["PageUp"],
      ["ArrowLeft"], ["ArrowDown"], ["End"], ["Home"],
    ]
    for (let round = 0; round < 12; round++) {
      for (const [key, extra] of moves) {
        const active = document.activeElement as Element
        keydown(active, key, extra)
        await mount.awaitSettled()
        const focused = mount.getFocusedCard()
        expect(focused).not.toBeNull()
        expect(document.activeElement).not.toBe(document.body)
        expect(container.contains(document.activeElement)).toBe(true)
      }
    }
    // The REAL replacement-focus helper: when the focused card is
    // removed from the DOM, focus goes to a surviving sibling in the
    // same rail — never to a hidden element, never to the removed one.
    const cards = [...container.querySelectorAll<HTMLElement>("[data-browse-card]")]
    cards.forEach(makeVisible)
    const rail = container.querySelector("[data-nylah-rail]")
    if (rail) makeVisible(rail)
    const victim = cards[3]
    recordCouchFocus({
      route: window.location.pathname,
      rail: "browse-grid",
      index: 3,
      key: victim.getAttribute("data-group-key") as string,
    })
    victim.remove()
    const replacement = findReplacementFocus(victim, document)
    expect(replacement).not.toBeNull()
    expect(replacement).not.toBe(victim)
    expect(replacement?.isConnected).toBe(true)
    expect(replacement?.hasAttribute("data-browse-card")).toBe(true)
    mount.unmount()
  })

  it("39. Rapid category switching never shows stale results", async () => {
    const index = freshIndex("vod", ADV.movies)
    const { mount } = await mounted(index, 30)
    const cats = index.categories.slice(0, 3)
    expect(cats.length).toBe(3)
    const paintsBefore = mount.getPaintCount()
    // Three switches in one synchronous burst: only the last paints.
    mount.setCategory(cats[0].id)
    mount.setCategory(cats[1].id)
    mount.setCategory(cats[2].id)
    await mount.awaitSettled()
    expect(mount.getPaintCount() - paintsBefore).toBe(1)
    expect(mount.getState().categoryId).toBe(cats[2].id)
    const expected = deriveBrowsePage(
      index,
      mount.getState()
    ).groups.map((g) => g.key)
    expect(mount.getRenderedGroupKeys()).toEqual(expected)
    // A second burst after settling: same guarantee, no residue.
    const paintsBefore2 = mount.getPaintCount()
    mount.setCategory(cats[1].id)
    mount.setCategory(cats[0].id)
    await mount.awaitSettled()
    expect(mount.getPaintCount() - paintsBefore2).toBe(1)
    expect(mount.getState().categoryId).toBe(cats[0].id)
    expect(mount.getRenderedGroupKeys()).toEqual(
      deriveBrowsePage(index, mount.getState()).groups.map((g) => g.key)
    )
    mount.unmount()
  })

  it("40. Keyboard + mouse still work alongside controller", async () => {
    const index = freshIndex("vod", ADV.movies)
    const { mount, activations } = await mounted(index, 30)
    // Keyboard: arrows move focus.
    const first = mount.focusCard(0)
    keydown(first as Element, "ArrowRight")
    const second = mount.getFocusedCard()
    expect(second).not.toBe(first)
    expect(second?.getAttribute("data-group-key")).toBe(
      mount.getRenderedGroupKeys()[1]
    )
    // Keyboard: Enter activates the focused card.
    keydown(second as Element, "Enter")
    expect(activations).toHaveLength(1)
    // Mouse: clicking another card activates THAT card.
    const cards = [...document.querySelectorAll<HTMLElement>("[data-browse-card]")]
    cards[4].click()
    expect(activations).toHaveLength(2)
    expect(activations[1]).toBe(cards[4].getAttribute("data-group-key"))
    // Controller: D-pad-equivalent focus move + A activate the same grid.
    mount.focusCard(1)
    handleGamepadButtonPress(BTN_A, performance.now())
    expect(activations).toHaveLength(3)
    expect(activations[2]).toBe(mount.getRenderedGroupKeys()[1])
    // Focus movement costs no full passes or sorts (instrumentation).
    const before = getBrowseInstrumentation()
    const focused = mount.getFocusedCard() as Element
    keydown(focused, "ArrowRight")
    keydown(document.activeElement as Element, "ArrowRight")
    keydown(document.activeElement as Element, "ArrowDown")
    const after = getBrowseInstrumentation()
    expect(after.fullPasses).toBe(before.fullPasses)
    expect(after.sorts).toBe(before.sorts)
    expect(after.focusMoves).toBeGreaterThan(before.focusMoves)
    mount.unmount()
  })
})

describe("W2 mode/URL contract (supporting the forty)", { timeout: 120000 }, () => {
  it("parses kind, mode, category, page and query from URLs", () => {
    expect(parseModeFromUrl("/movies?mode=browse&category=cat:action&page=2&q=harbour")).toEqual({
      kind: "vod",
      mode: "browse",
      categoryId: "cat:action",
      page: 2,
      query: "harbour",
    })
    expect(parseModeFromUrl("/series")).toEqual({
      kind: "series",
      mode: "home",
      categoryId: null,
      page: 0,
      query: "",
    })
    expect(parseModeFromUrl("/browse?kind=series&mode=browse")).toMatchObject({
      kind: "series",
      mode: "browse",
    })
    expect(parseModeFromUrl("/browse?kind=movies")).toMatchObject({ kind: "vod" })
    // Unknown mode falls back to home; unknown kind to null.
    expect(parseModeFromUrl("/movies?mode=party")).toMatchObject({ mode: "home" })
    expect(parseModeFromUrl("/settings?mode=browse")).toMatchObject({ kind: null, mode: "browse" })
    // Bad page values clamp to 0, never NaN.
    expect(parseModeFromUrl("/movies?page=-3").page).toBe(0)
    expect(parseModeFromUrl("/movies?page=abc").page).toBe(0)
    // Absolute URLs parse identically.
    expect(parseModeFromUrl("https://localhost/movies?mode=browse")).toMatchObject({
      kind: "vod",
      mode: "browse",
    })
  })

  it("sets the mode preserving other params, resetting the page on switch", () => {
    const url = "/movies?mode=home&category=cat:action&page=2&q=harbour"
    const switched = setModeInUrl(url, "browse")
    const parsed = parseModeFromUrl(switched)
    expect(parsed.mode).toBe("browse")
    expect(parsed.categoryId).toBe("cat:action")
    expect(parsed.query).toBe("harbour")
    expect(parsed.page).toBe(0) // fresh browse starts at page 0
    // Same-mode set keeps the page.
    const same = setModeInUrl("/movies?mode=browse&page=2", "browse")
    expect(parseModeFromUrl(same).page).toBe(2)
    // Round-trip: set then parse is stable.
    const roundTripped = setModeInUrl(setModeInUrl("/series", "browse"), "home")
    expect(parseModeFromUrl(roundTripped)).toMatchObject({ kind: "series", mode: "home" })
    // Extra params can be set/cleared atomically with the mode.
    const withExtra = setModeInUrl("/movies", "browse", { categoryId: "cat:horror", query: "lights" })
    expect(parseModeFromUrl(withExtra)).toMatchObject({
      mode: "browse",
      categoryId: "cat:horror",
      query: "lights",
    })
  })
})
