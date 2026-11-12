/**
 * @vitest-environment jsdom
 */
/**
 * Movies & Series 2.0 — navigation acceptance tests 31–40 + mode/URL contract.
 *
 * INTEGRATION ADAPTATION (0.11.8): the W5 versions of these tests ran against
 * the faithful stub browse mount (`movies-series-2.0-stubs.ts`, deleted at
 * integration). This file re-implements every test against the REAL modules:
 * W2 `mountBrowseEverything` / `deriveBrowseGroups` / `browse-state.ts` /
 * `home-browse-modes.ts`, W1 `getCatalogIndex`, the real `couch-focus.ts`
 * memory, the real `dialog-spatial-nav.ts` modal detection, and the real
 * gamepad pipeline. Where the real API differs from the stub contract the
 * adaptation is recorded here (0.11.6 pattern — what changed, why, and the
 * requirement preserved):
 *
 * - 31/33: paging is 1-based and mount-level. Derive returns ALL groups for
 *   the state; page slices are computed with `browsePageInfo` start/end
 *   indices. The mount's pageSize is viewport-derived (columns x rows,
 *   24-36), NOT a caller option: tests read the live pageSize from
 *   `controller.getState()` after settle instead of requesting one.
 * - 32: `setPage(state, page, totalPages)` takes total PAGES (not entries);
 *   clamping lands on page 1 (never 0). Empty results report totalPages 0
 *   with page 1 (`browsePageInfo` convention). The guaranteed-empty combo is
 *   minRating 10 alone (the adversarial catalogue tops out at 9.7).
 * - 34: there is NO in-mount detail simulation in the real mount — detail is
 *   full page navigation (`onOpenDetail` hands the id to the router). The
 *   stub's openDetail/returnFromDetail half is replaced by the two real
 *   restore paths: (a) B through the gamepad pipeline fires `onExit` exactly
 *   once; (b) a URL mode round-trip (`modeFromBrowseState` ->
 *   `browseStateFromMode` -> fresh mount) restores page + focused poster.
 * - 35: the filter drawer is a DIV overlay with role="dialog", not a
 *   `<dialog>` — `findOpenModal` returns null for it, and Tab is NOT trapped
 *   (neither drawer handles Tab). What the brief requires (§7.3/§16.3) is
 *   controller-arrow containment: focus starts inside and arrow navigation
 *   never leaves. That is what is asserted; the stub's modal-detection and
 *   Tab-wrap assertions are replaced, not preserved. The drawer has buttons
 *   only — no <select> elements (§17).
 * - 36: the real drawer has no `getDrawer()`/`[data-filter-close]` API. The
 *   test drives the real DOM: rows are buttons (`.is-clear` / `.is-apply`),
 *   Apply/Cancel/Escape close through the mount's `closeOverlay`. Cancel and
 *   Escape restore the previously focused card; Apply focuses the FIRST
 *   result of the new dataset (`applyDatasetChange`, mode "first").
 * - 37: activations are `onOpenDetail` calls naming the primary row id.
 *   Repeat Enter is swallowed by the mount's `ev.repeat` guard; gamepad A
 *   and native XInput A both activate through `activateFocused()` clicks.
 * - 38: arrow-key focus MOVEMENT is spatial navigation's job (browser-only,
 *   no layout in jsdom), so headless the test pins the containment half:
 *   focus never leaves the container and never falls to <body> across 12
 *   rounds of arrows / page keys / Home / End. Page turns keep the focus
 *   index. Arrow-to-arrow movement itself is verified by the W2 render
 *   harness and needs the physical PC check. `findReplacementFocus` runs
 *   against `[data-browse-key]` cards (there is no `data-browse-card`).
 * - 39: paint-count is stub-only instrumentation; rAF coalescing is covered
 *   by W2's own mount tests. The requirement preserved is final-render
 *   correctness after a burst: rendered keys equal the derived keys for the
 *   final state, and the state category is the last one selected.
 * - 40: keyboard Enter + mouse click + controller A are all exercised. The
 *   DOM-stability proxy is STRONGER than the stub's: the same card node
 *   objects must survive focus moves, and the D1 instrumentation must show
 *   zero derives/sorts/group-runs while focus moves register (the stub's
 *   focusMoves===0 was stub semantics — the real mount counts focusin).
 * - Mode/URL: the stub used `mode=`/`category=cat:…`/0-based pages. The real
 *   shape is `view=`/`category=genre:horror|collection:…|provider:id:…|all|
 *   uncategorised`/1-based `page`/`q`/`scope`/`sort`/filter params, kind
 *   from the route argument (never the URL), unknown view -> home, bad page
 *   omitted -> state page 1, unknown sort omitted -> recommended, a
 *   well-formed `genre:<unknown-id>` preserved (derive matches nothing —
 *   D12) while malformed/unknown-kind params fall back to All, and category
 *   labels resolved by the router's resolver (default: the id itself).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  adversarialFixture,
  generateCatalogueOfSize,
  type CatalogEntry,
} from "./fixtures-0118-catalogue"
import { getCatalogIndex, invalidateCatalogIndex } from "@/scripts/lib/catalog-index"
import { clearTitleGroupRegistry } from "@/scripts/lib/language-groups"
import { providerCategoryInfo } from "@/scripts/lib/genres"
import {
  deriveBrowseGroups,
  mountBrowseEverything,
  type BrowseDataSource,
  type BrowseDeriveContext,
  type BrowseController,
} from "@/scripts/lib/browse-everything"
import {
  createBrowseState,
  selectCategory,
  setPage,
  browseTotalPages,
  browsePageInfo,
  activeFilterSummary,
  hasActiveBrowseConstraints,
  type BrowseCategorySelection,
  type BrowseState,
} from "@/scripts/lib/browse-state"
import {
  modeFromSearchParams,
  modeToSearchParams,
  parseModeFromUrl,
  setModeInUrl,
  modeFromBrowseState,
  browseStateFromMode,
  categoryParamFor,
  type HomeBrowseMode,
} from "@/scripts/lib/home-browse-modes"
import {
  recordCouchFocus,
  clearCouchFocusMemory,
  findReplacementFocus,
} from "@/scripts/lib/couch-focus"
import { findOpenModal, firstFocusableInModal } from "@/scripts/lib/dialog-spatial-nav"
import {
  handleGamepadButtonPress,
  dispatchNativeButton,
} from "@/scripts/lib/gamepad"

// Standard-mapping button indices (gamepad.ts keeps its BTN_* constants
// private; these mirror them: A=0, B=1).
const BTN_A = 0
const BTN_B = 1
import {
  readBrowseInstrumentation,
  resetBrowseInstrumentation,
} from "@/scripts/lib/browse-instrumentation"

// ---------------------------------------------------------------------------
// Harness (pattern from tests/browse-0118-mount.test.ts + the series file)
// ---------------------------------------------------------------------------

const EMPTY_SETS = {
  favouriteIds: new Set<string | number>(),
  watchLaterIds: new Set<string | number>(),
  inProgressIds: new Set<string | number>(),
  watchedIds: new Set<string | number>(),
  followedIds: new Set<string | number>(),
  newEpisodeIds: new Set<string | number>(),
}

function deriveCtx(): BrowseDeriveContext {
  return { collection: EMPTY_SETS, seasonCounts: new Map() }
}

function makeVisible(el: Element): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      width: 120, height: 180, top: 0, left: 0,
      right: 120, bottom: 180, x: 0, y: 0, toJSON: () => ({}),
    }),
    configurable: true,
  })
}

function gridCards(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-browse-key]")]
}

async function waitForCards(host: HTMLElement, min = 1, timeoutMs = 15000): Promise<HTMLElement[]> {
  const start = Date.now()
  for (;;) {
    const cards = gridCards(host)
    if (cards.length >= min) return cards
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${min} cards (got ${cards.length})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function flush(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function keydown(target: Element, key: string, opts: { repeat?: boolean } = {}): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      repeat: opts.repeat ?? false,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function makeSource(rows: CatalogEntry[], prefix: "vod" | "series"): BrowseDataSource {
  return {
    load: async () => ({
      rows,
      playlistId: "test-playlist",
      playlistTitle: "Test",
      fromCache: false,
      loadError: false,
    }),
    toEntry: (row) => row as never,
    rowKey: (row) => `${prefix}-${(row as CatalogEntry).id}`,
    cardView: (row) => {
      const r = row as CatalogEntry
      return {
        title: r.name,
        meta: [r.year, r.category].filter(Boolean).join(" · "),
        image: r.logo || null,
        kind: "poster" as const,
        itemKey: `${prefix}-${r.id}`,
      }
    },
    detailId: (row) => String((row as CatalogEntry).id),
    watchSets: () => EMPTY_SETS,
    emptyTitle: "Nothing here",
    emptyMessage: "Try different filters.",
  }
}

interface Mounted {
  container: HTMLElement
  mount: BrowseController
  activations: string[]
  exits: number[]
}

function mountCatalogue(
  rows: CatalogEntry[],
  kind: "movie" | "series" = "movie",
  initialState?: BrowseState,
): Mounted {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const activations: string[] = []
  const exits: number[] = []
  const mount = mountBrowseEverything(container, {
    kind,
    source: makeSource(rows, kind === "movie" ? "vod" : "series"),
    initialState,
    onOpenDetail: (id) => activations.push(id),
    onExit: () => exits.push(1),
  })
  return { container, mount, activations, exits }
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number,
  )
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
  window.history.replaceState({}, "", "/movies")
  document.body.replaceChildren()
  invalidateCatalogIndex()
  clearTitleGroupRegistry()
  clearCouchFocusMemory()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState({}, "", "/")
  document.body.replaceChildren()
  clearCouchFocusMemory()
})

const ADV = adversarialFixture()

function advMovies(): CatalogEntry[] {
  return ADV.movies
}

// ---------------------------------------------------------------------------
// 31. Paging: every entry on exactly one page, mount walk matches derive
// ---------------------------------------------------------------------------

describe("31 — paging covers the whole catalogue exactly once", () => {
  it("derive-level: page slices partition every entry exactly once", () => {
    const { movies } = generateCatalogueOfSize(200, 4242)
    const index = getCatalogIndex("vod", movies, "nav-31")
    const state = createBrowseState("movie", { pageSize: 30 })
    const derived = deriveBrowseGroups(index, state, deriveCtx())
    const total = derived.totalGroups
    expect(total).toBeGreaterThan(30)
    const pageCount = browseTotalPages(total, 30)
    expect(pageCount).toBeGreaterThan(1)

    const seen = new Set<string>()
    for (let page = 1; page <= pageCount; page++) {
      const info = browsePageInfo({ ...state, page }, total)
      const slice = derived.groups.slice(info.startIndex, info.endIndex)
      expect(slice.length).toBeGreaterThan(0)
      expect(slice.length).toBeLessThanOrEqual(30)
      for (const group of slice) {
        for (const variantId of group.group.variantIds) {
          expect(seen.has(variantId)).toBe(false)
          seen.add(variantId)
        }
      }
    }
    expect(seen.size).toBe(movies.length)
    expect(seen).toEqual(new Set(movies.map((r) => String(r.id))))
  })

  it("mount walk: rendered keys per page match the derived slices", async () => {
    const { movies } = generateCatalogueOfSize(200, 4242)
    const { container, mount } = mountCatalogue(movies)
    try {
      await waitForCards(container)
      const pageSize = mount.getState().pageSize
      expect(pageSize).toBeGreaterThanOrEqual(24)
      expect(pageSize).toBeLessThanOrEqual(36)

      const index = getCatalogIndex("vod", movies, "nav-31-mount")
      const derived = deriveBrowseGroups(
        index,
        createBrowseState("movie", { pageSize }),
        deriveCtx(),
      )
      const pageCount = browseTotalPages(derived.totalGroups, pageSize)
      expect(pageCount).toBeGreaterThan(1)

      const renderedAll: string[] = []
      for (let page = 1; page <= pageCount; page++) {
        mount.setState({ page })
        await flush(80)
        const keys = gridCards(container).map((c) => c.dataset.browseKey as string)
        const info = browsePageInfo(
          { ...mount.getState(), page },
          derived.totalGroups,
        )
        const expected = derived.groups
          .slice(info.startIndex, info.endIndex)
          .map((g) => g.id)
        expect(keys).toEqual(expected)
        renderedAll.push(...keys)
      }
      expect(new Set(renderedAll).size).toBe(renderedAll.length)
      expect(renderedAll).toHaveLength(derived.totalGroups)
    } finally {
      mount.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 32. Page boundaries and clamping
// ---------------------------------------------------------------------------

describe("32 — page boundaries", () => {
  it("page counts at exact multiples and clamping never lands on page 0", () => {
    const index = getCatalogIndex("vod", advMovies(), "nav-32")
    const derived = deriveBrowseGroups(index, createBrowseState("movie"), deriveCtx())
    const total = derived.totalGroups
    expect(total).toBeGreaterThan(5)

    expect(browseTotalPages(total, total)).toBe(1)
    expect(browseTotalPages(total, total - 1)).toBe(2)
    expect(browseTotalPages(total, total + 1)).toBe(1)

    const base = createBrowseState("movie")
    expect(setPage(base, -5, 3).page).toBe(1)
    expect(setPage(base, 0, 3).page).toBe(1)
    expect(setPage(base, 99, 3).page).toBe(3)
    expect(setPage(base, 2, 3).page).toBe(2)
  })

  it("empty result set: zero pages, page reported as 1, no groups", () => {
    const index = getCatalogIndex("vod", advMovies(), "nav-32-empty")
    // minRating 10 alone: the adversarial catalogue tops out at 9.7.
    const state = createBrowseState("movie", {
      filters: { minRating: 10 },
    })
    const derived = deriveBrowseGroups(index, state, deriveCtx())
    expect(derived.groups).toHaveLength(0)
    expect(derived.totalGroups).toBe(0)
    expect(browseTotalPages(0, 60)).toBe(0)
    const info = browsePageInfo(state, 0)
    expect(info.totalPages).toBe(0)
    expect(info.page).toBe(1)
    expect(info.startIndex).toBe(0)
    expect(info.endIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 33. Page counts under filters
// ---------------------------------------------------------------------------

describe("33 — page counts under filters", () => {
  it("every filtered result set pages completely with no loss or overlap", () => {
    const index = getCatalogIndex("vod", advMovies(), "nav-33")
    const cases: Array<{ name: string; state: BrowseState }> = [
      { name: "all", state: createBrowseState("movie", { pageSize: 7 }) },
      {
        name: "genre action",
        state: createBrowseState("movie", {
          pageSize: 7,
          category: { kind: "genre", id: "action", label: "Action" },
        }),
      },
      {
        name: "rating 8+",
        state: createBrowseState("movie", {
          pageSize: 7,
          filters: { minRating: 8 },
        }),
      },
      {
        name: "under 120 min",
        state: createBrowseState("movie", {
          pageSize: 7,
          filters: { runtime: "under-120" },
        }),
      },
      {
        name: "comedy + 7+",
        state: createBrowseState("movie", {
          pageSize: 7,
          filters: { genre: "comedy", minRating: 7 },
        }),
      },
    ]
    let allTotal = 0
    for (const { name, state } of cases) {
      const derived = deriveBrowseGroups(index, state, deriveCtx())
      const total = derived.totalGroups
      if (name === "all") allTotal = total
      else expect(total).toBeLessThan(allTotal)
      const pageCount = browseTotalPages(total, 7)
      let walked = 0
      for (let page = 1; page <= pageCount; page++) {
        const info = browsePageInfo({ ...state, page }, total)
        const slice = derived.groups.slice(info.startIndex, info.endIndex)
        expect(slice.length).toBeGreaterThan(0)
        expect(slice.length).toBeLessThanOrEqual(7)
        walked += slice.length
      }
      expect(walked).toBe(total)
    }
  })
})

// ---------------------------------------------------------------------------
// 34. B returns + URL-mode restore
// ---------------------------------------------------------------------------

describe("34 — B returns and detail-return restore", () => {
  it("B through the gamepad pipeline fires onExit exactly once", async () => {
    const { container, mount, exits } = mountCatalogue(advMovies())
    try {
      const cards = await waitForCards(container)
      cards[0].focus()
      handleGamepadButtonPress(BTN_B, performance.now())
      expect(exits).toHaveLength(1)
    } finally {
      mount.destroy()
    }
  })

  it("URL mode round-trip restores page and focused poster on remount", async () => {
    const { movies } = generateCatalogueOfSize(200, 777)
    const first = mountCatalogue(movies)
    let mode: ReturnType<typeof modeFromBrowseState>
    let focusedKey: string | null
    let focusedGroup: string | null
    try {
      await waitForCards(first.container)
      first.mount.setState({ page: 3 })
      await flush(80)
      const cards = gridCards(first.container)
      expect(cards.length).toBeGreaterThan(2)
      cards[2].focus()
      focusedKey = cards[2].getAttribute("data-couch-key")
      focusedGroup = cards[2].dataset.browseKey ?? null
      expect(focusedKey).toBeTruthy()
      mode = modeFromBrowseState(first.mount.getState())
      expect(mode.page).toBe(3)
      expect(mode.selectedId).toBe(focusedGroup)
    } finally {
      first.mount.destroy()
    }

    const second = mountCatalogue(movies, "movie", browseStateFromMode(mode!))
    try {
      await waitForCards(second.container)
      await flush(80)
      expect(second.mount.getState().page).toBe(3)
      const active = document.activeElement as HTMLElement | null
      expect(active?.getAttribute("data-couch-key")).toBe(focusedKey)
      expect(active?.dataset.browseKey).toBe(focusedGroup)
    } finally {
      second.mount.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 35. Filter drawer focus containment (controller arrows, §7.3/§16.3)
// ---------------------------------------------------------------------------

describe("35 — filter drawer focus containment", () => {
  it("opens on the drawer, arrows never escape, Escape restores the card", async () => {
    const { container, mount } = mountCatalogue(advMovies())
    try {
      const cards = await waitForCards(container)
      cards[0].focus()
      const cardKey = cards[0].getAttribute("data-couch-key")

      keydown(cards[0], "m")
      await flush(60)
      const drawer = container.querySelector<HTMLElement>("[data-browse-filter-drawer]")
      expect(drawer).not.toBeNull()
      expect(drawer!.getAttribute("role")).toBe("dialog")
      // Div overlay, not a <dialog>: modal detection does not claim it.
      expect(findOpenModal(document)).toBeNull()
      // Focus starts inside the drawer.
      expect(drawer!.contains(document.activeElement)).toBe(true)
      // Buttons only — no <select> elements (§17).
      expect(drawer!.querySelector("select")).toBeNull()
      expect(drawer!.querySelectorAll("button").length).toBeGreaterThanOrEqual(3)

      // Arrow navigation never leaves the drawer.
      for (let i = 0; i < 12; i++) {
        keydown(document.activeElement as Element, "ArrowDown")
        expect(drawer!.contains(document.activeElement)).toBe(true)
      }
      for (let i = 0; i < 12; i++) {
        keydown(document.activeElement as Element, "ArrowUp")
        expect(drawer!.contains(document.activeElement)).toBe(true)
      }

      // Escape cancels and restores focus to the card.
      keydown(document.activeElement as Element, "Escape")
      await flush(60)
      expect(container.querySelector("[data-browse-filter-drawer]")).toBeNull()
      expect((document.activeElement as HTMLElement)?.getAttribute("data-couch-key")).toBe(cardKey)
    } finally {
      mount.destroy()
    }
  })

  it("modal helpers still find a real dialog (regression, real seam)", () => {
    const dialog = document.createElement("dialog")
    dialog.setAttribute("open", "")
    const button = document.createElement("button")
    button.textContent = "Close"
    dialog.appendChild(button)
    document.body.appendChild(dialog)
    Object.defineProperty(dialog, "getClientRects", {
      value: () => [{ width: 100, height: 100 }] as unknown as DOMRectList,
      configurable: true,
    })
    Object.defineProperty(button, "getClientRects", {
      value: () => [{ width: 80, height: 30 }] as unknown as DOMRectList,
      configurable: true,
    })
    try {
      expect(findOpenModal(document)).toBe(dialog)
      expect(firstFocusableInModal(dialog)).toBe(button)
    } finally {
      dialog.remove()
    }
  })
})

// ---------------------------------------------------------------------------
// 36. Drawer close restores focus; Reset All clears everything
// ---------------------------------------------------------------------------

describe("36 — drawer close and Reset All", () => {
  it("Clear All + Apply resets to the full catalogue; Cancel restores focus", async () => {
    const { container, mount } = mountCatalogue(advMovies())
    try {
      await waitForCards(container)
      mount.setState({ filters: { genre: "horror", minRating: 7 } })
      await flush(80)
      expect(hasActiveBrowseConstraints(mount.getState())).toBe(true)
      expect(activeFilterSummary(mount.getState())).not.toBe("")

      // Open the filter drawer from the first card.
      const openCards = gridCards(container)
      openCards[0].focus()
      keydown(openCards[0], "m")
      await flush(60)
      let drawer = container.querySelector<HTMLElement>("[data-browse-filter-drawer]")
      expect(drawer).not.toBeNull()

      // Clear All resets the draft; Apply applies the cleared draft.
      const clearRow = drawer!.querySelector<HTMLElement>(".rs-browse-filter-drawer__row.is-clear")
      expect(clearRow).not.toBeNull()
      clearRow!.click()
      await flush(30)
      drawer = container.querySelector<HTMLElement>("[data-browse-filter-drawer]")
      const applyRow = drawer!.querySelector<HTMLElement>(".rs-browse-filter-drawer__row.is-apply")
      expect(applyRow).not.toBeNull()
      applyRow!.click()
      await flush(80)

      expect(container.querySelector("[data-browse-filter-drawer]")).toBeNull()
      const state = mount.getState()
      expect(state.category.kind).toBe("all")
      expect(hasActiveBrowseConstraints(state)).toBe(false)
      expect(activeFilterSummary(state)).toBe("")
      expect(state.page).toBe(1)
      expect(state.sort).toBe("recommended")
      // Apply lands focus on the first result of the new dataset.
      expect((document.activeElement as HTMLElement)?.hasAttribute("data-browse-key")).toBe(true)

      // Cancel path: open again, Escape, focus returns to the same card.
      const firstCard = document.activeElement as HTMLElement
      const firstKey = firstCard.getAttribute("data-couch-key")
      keydown(firstCard, "m")
      await flush(60)
      expect(container.querySelector("[data-browse-filter-drawer]")).not.toBeNull()
      keydown(document.activeElement as Element, "Escape")
      await flush(60)
      expect(container.querySelector("[data-browse-filter-drawer]")).toBeNull()
      expect((document.activeElement as HTMLElement)?.getAttribute("data-couch-key")).toBe(firstKey)
    } finally {
      mount.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 37. A double-activation: one press = one activation
// ---------------------------------------------------------------------------

describe("37 — one press, one activation", () => {
  it("repeat Enters collapse, gamepad A and native A each activate once", async () => {
    const { container, mount, activations } = mountCatalogue(advMovies())
    try {
      const cards = await waitForCards(container)
      const index = getCatalogIndex("vod", advMovies(), "nav-37")
      const derived = deriveBrowseGroups(index, createBrowseState("movie"), deriveCtx())
      const expectedId = derived.groups[0].primaryId

      cards[0].focus()
      keydown(cards[0], "Enter")
      expect(activations).toEqual([expectedId])

      // Held-down repeats are swallowed by the mount's ev.repeat guard.
      keydown(cards[0], "Enter", { repeat: true })
      keydown(cards[0], "Enter", { repeat: true })
      expect(activations).toEqual([expectedId])

      // Controller A through the shared pipeline.
      handleGamepadButtonPress(BTN_A, performance.now())
      expect(activations).toEqual([expectedId, expectedId])

      // Native XInput A through the dispatch path.
      dispatchNativeButton("a", true, performance.now())
      dispatchNativeButton("a", false, performance.now())
      expect(activations).toEqual([expectedId, expectedId, expectedId])

      // A second genuine Enter is a second activation.
      keydown(cards[0], "Enter")
      expect(activations).toEqual([expectedId, expectedId, expectedId, expectedId])
    } finally {
      mount.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 38. Repeated navigation never loses focus; replacement focus after removal
// ---------------------------------------------------------------------------

describe("38 — repeated navigation keeps focus inside the grid", () => {
  it("12 rounds of arrows / page keys / Home / End never leave the container", async () => {
    const { movies } = generateCatalogueOfSize(200, 31337)
    const { container, mount } = mountCatalogue(movies)
    try {
      const cards = await waitForCards(container)
      // Start mid-grid (column 1 of 4+) so edge handlers do not fire.
      cards[5].focus()
      const startKey = cards[5].dataset.browseKey
      const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "PageDown", "PageUp", "Home", "End"]
      for (let round = 0; round < 12; round++) {
        for (const key of keys) {
          const target = document.activeElement as Element
          keydown(target, key)
          await flush(30)
          const active = document.activeElement as HTMLElement | null
          expect(active).not.toBeNull()
          expect(active).not.toBe(document.body as unknown as Element)
          expect(container.contains(active)).toBe(true)
          expect(active!.hasAttribute("data-browse-key")).toBe(true)
        }
        // Page-turn round trip preserves the exact focus index: after
        // PageDown + PageUp the same card holds focus (regression test
        // for the stale-node index drift fixed at integration).
        expect((document.activeElement as HTMLElement)?.dataset.browseKey).toBe(startKey)
      }
    } finally {
      mount.destroy()
    }
  })

  it("findReplacementFocus lands on a surviving sibling after removal", async () => {
    const { container, mount } = mountCatalogue(advMovies())
    try {
      const cards = await waitForCards(container)
      const rail = container.querySelector<HTMLElement>('[data-nylah-rail="browse-grid"]')
      if (rail) makeVisible(rail)
      cards.forEach(makeVisible)
      const victim = cards[3]
      recordCouchFocus({
        route: window.location.pathname,
        rail: "browse-grid",
        index: 3,
        key: victim.getAttribute("data-couch-key") as string,
      })
      victim.remove()
      const replacement = findReplacementFocus(victim, document)
      expect(replacement).not.toBeNull()
      expect(replacement).not.toBe(victim)
      expect(replacement!.isConnected).toBe(true)
      expect(replacement!.hasAttribute("data-browse-key")).toBe(true)
    } finally {
      mount.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 39. Rapid category switching: final render matches the final state
// ---------------------------------------------------------------------------

describe("39 — rapid category switching lands on the last selection", () => {
  it("burst of category changes renders exactly the final category", async () => {
    const movies = advMovies()
    const index = getCatalogIndex("vod", movies, "nav-39")
    const providerKey = [...index.idsByProviderCategory.keys()][0]
    expect(providerKey).toBeTruthy()
    const providerLabel =
      providerCategoryInfo(providerKey).rawLabel || providerKey
    const finalSelection: BrowseCategorySelection = {
      kind: "provider",
      id: providerKey,
      label: providerLabel,
    }

    const { container, mount } = mountCatalogue(movies)
    try {
      await waitForCards(container)
      mount.setState({
        category: { kind: "genre", id: "action", label: "Action" },
      })
      mount.setState({
        category: { kind: "genre", id: "comedy", label: "Comedy" },
      })
      mount.setState({ category: finalSelection })
      await flush(120)

      expect(mount.getState().category).toEqual(finalSelection)
      const expected = deriveBrowseGroups(
        index,
        selectCategory(createBrowseState("movie"), finalSelection),
        deriveCtx(),
      ).groups.map((g) => g.id)
      const rendered = gridCards(container).map((c) => c.dataset.browseKey as string)
      expect(rendered).toEqual(expected.slice(0, rendered.length))
      expect(rendered.length).toBeGreaterThan(0)
      expect(rendered.length).toBeLessThanOrEqual(mount.getState().pageSize)
    } finally {
      mount.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// 40. Keyboard + mouse + controller agree; focus never rebuilds the grid
// ---------------------------------------------------------------------------

describe("40 — keyboard, mouse and controller activate the same cards", () => {
  it("Enter, click and controller A activate the focused/clicked card", async () => {
    const { container, mount, activations } = mountCatalogue(advMovies())
    try {
      const cards = await waitForCards(container)
      const index = getCatalogIndex("vod", advMovies(), "nav-40")
      const derived = deriveBrowseGroups(index, createBrowseState("movie"), deriveCtx())
      const nodesBefore = [...cards]

      // Keyboard: Enter activates the focused card.
      cards[0].focus()
      keydown(cards[0], "Enter")
      expect(activations).toEqual([derived.groups[0].primaryId])

      // Mouse: clicking a card activates THAT card.
      cards[4].click()
      expect(activations).toEqual([
        derived.groups[0].primaryId,
        derived.groups[4].primaryId,
      ])

      // Controller: A activates the focused card.
      cards[1].focus()
      handleGamepadButtonPress(BTN_A, performance.now())
      expect(activations).toEqual([
        derived.groups[0].primaryId,
        derived.groups[4].primaryId,
        derived.groups[1].primaryId,
      ])

      // Focus moves never rebuild the grid: same node objects survive.
      const nodesAfter = gridCards(container)
      expect(nodesAfter).toHaveLength(nodesBefore.length)
      nodesAfter.forEach((node, i) => expect(node).toBe(nodesBefore[i]))
    } finally {
      mount.destroy()
    }
  })

  it("focus moves register without re-deriving, re-sorting or re-grouping", async () => {
    const { container, mount } = mountCatalogue(advMovies())
    try {
      const cards = await waitForCards(container)
      resetBrowseInstrumentation()
      cards[2].focus()
      cards[3].focus()
      cards[4].focus()
      await flush(30)
      const counts = readBrowseInstrumentation()
      expect(counts.focusMoves).toBeGreaterThanOrEqual(3)
      expect(counts.deriveCalls).toBe(0)
      expect(counts.decoratedSorts).toBe(0)
      expect(counts.groupRuns).toBe(0)
    } finally {
      mount.destroy()
    }
  })
})

// ---------------------------------------------------------------------------
// Mode / URL contract (real W2 home-browse-modes.ts shape)
// ---------------------------------------------------------------------------

describe("mode / URL contract", () => {
  it("parses a full browse URL: view, category, page, search, scope, sort", () => {
    const mode = modeFromSearchParams(
      "view=browse&category=genre%3Ahorror&page=2&q=harbour&scope=category&sort=rating",
      "movie",
    )
    expect(mode.view).toBe("browse")
    expect(mode.kind).toBe("movie")
    expect(mode.category).toBe("genre:horror")
    expect(mode.page).toBe(2)
    expect(mode.search).toBe("harbour")
    expect(mode.searchScope).toBe("category")
    expect(mode.sort).toBe("rating")
  })

  it("bare route and unknown view mean home; kind comes from the route argument", () => {
    expect(modeFromSearchParams("", "series")).toEqual({ view: "home", kind: "series" })
    expect(modeFromSearchParams("view=grid", "movie")).toEqual({
      view: "home",
      kind: "movie",
    })
    // No kind parameter exists in the URL: the route decides.
    expect(modeFromSearchParams("view=browse", "series").kind).toBe("series")
    expect(modeFromSearchParams("view=browse", "movie").kind).toBe("movie")
  })

  it("bad page is omitted (state defaults to 1); unknown sort is omitted (recommended)", () => {
    const badPage = modeFromSearchParams("view=browse&page=abc", "movie")
    expect(badPage.page).toBeUndefined()
    expect(browseStateFromMode(badPage).page).toBe(1)
    const zeroPage = modeFromSearchParams("view=browse&page=0", "movie")
    expect(browseStateFromMode(zeroPage).page).toBe(1)
    const badSort = modeFromSearchParams("view=browse&sort=runtime-asc", "movie")
    expect(badSort.sort).toBeUndefined()
    expect(browseStateFromMode(badSort).sort).toBe("recommended")
  })

  it("unknown genre id is preserved and matches nothing; malformed params fall back to All", () => {
    // A well-formed kind:id param is preserved verbatim (labels resolve via
    // the router's resolver); the derive layer matches nothing for an
    // unknown genre id, so a stale link lands on an honest empty state with
    // Reset All — never a crash, never a silent full catalogue.
    const mode = modeFromSearchParams("view=browse&category=genre%3Anot-a-genre", "movie")
    expect(mode.category).toBe("genre:not-a-genre")
    const state = browseStateFromMode(mode)
    expect(state.category).toEqual({ kind: "genre", id: "not-a-genre", label: "not-a-genre" })
    const index = getCatalogIndex("vod", advMovies(), "nav-unknown-category")
    expect(deriveBrowseGroups(index, state, deriveCtx()).groups).toHaveLength(0)
    // Malformed or unknown-kind params fall back to All.
    expect(modeFromSearchParams("view=browse&category=bogus", "movie").category).toBe("all")
    expect(modeFromSearchParams("view=browse&category=weird%3Athing", "movie").category).toBe("all")
    expect(browseStateFromMode(modeFromSearchParams("view=browse&category=bogus", "movie")).category.kind).toBe("all")
  })

  it("mode -> params -> mode round-trips, including filters", () => {
    const mode: HomeBrowseMode = {
      view: "browse",
      kind: "movie",
      category: "genre:horror",
      page: 3,
      selectedId: "vod-7003",
      filters: { genre: "drama", minRating: 7, runtime: "under-120" },
      search: "harbour",
      searchScope: "category",
      sort: "rating",
    }
    const params = modeToSearchParams(mode)
    expect(params.get("category")).toBe("genre:horror")
    expect(params.get("page")).toBe("3")
    const back = modeFromSearchParams(params, "movie")
    expect(back).toEqual(mode)
  })

  it("setModeInUrl rewrites only owned keys and preserves unrelated params", () => {
    window.history.replaceState({}, "", "/movies?unrelated=keep&view=home")
    setModeInUrl({
      view: "browse",
      kind: "movie",
      category: "genre:horror",
      page: 2,
    })
    const params = new URLSearchParams(window.location.search)
    expect(params.get("view")).toBe("browse")
    expect(params.get("category")).toBe("genre:horror")
    expect(params.get("page")).toBe("2")
    expect(params.get("unrelated")).toBe("keep")
    const mode = parseModeFromUrl("movie")
    expect(mode.view).toBe("browse")
    expect(mode.category).toBe("genre:horror")
    expect(mode.page).toBe(2)
  })

  it("parseModeFromUrl on a bare route returns home", () => {
    window.history.replaceState({}, "", "/series")
    expect(parseModeFromUrl("series")).toEqual({ view: "home", kind: "series" })
  })

  it("browse state -> mode -> browse state preserves category, filters, page, sort", () => {
    const state = selectCategory(createBrowseState("movie"), {
      kind: "collection",
      id: "continue",
      label: "Continue Watching",
    })
    const withFilters: BrowseState = {
      ...state,
      filters: { ...state.filters, minRating: 8 },
      search: "harbour",
      searchScope: "category",
      sort: "year-desc",
      page: 2,
      selectedId: "vod-7001",
    }
    const mode = modeFromBrowseState(withFilters)
    expect(mode.view).toBe("browse")
    expect(mode.category).toBe("collection:continue")
    expect(categoryParamFor(withFilters.category)).toBe("collection:continue")
    // Without a resolver the label defaults to the id; the router supplies
    // resolveBrowseCategoryLabel, which restores the display label.
    const back = browseStateFromMode(mode, (sel) =>
      sel.kind === "collection" && sel.id === "continue" ? "Continue Watching" : sel.id,
    )
    expect(back.category).toEqual(withFilters.category)
    expect(browseStateFromMode(mode).category.label).toBe("continue")
    expect(back.filters.minRating).toBe(8)
    expect(back.search).toBe("harbour")
    expect(back.searchScope).toBe("category")
    expect(back.sort).toBe("year-desc")
    expect(back.page).toBe(2)
    expect(back.selectedId).toBe("vod-7001")
  })
})
