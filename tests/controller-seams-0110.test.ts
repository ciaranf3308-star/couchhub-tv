/**
 * @vitest-environment jsdom
 */
// W5 — Controller Experience 2.0 (0.11.10): the seam shim contract.
// The shim (controller-seams-0110.ts) is deleted at integration and
// re-provided by W1/W2/W3; these tests pin the behaviour views
// depend on, so the real implementations must satisfy the same
// contract: exactly-one Back step, priority order, modal/menu and
// trailing-Escape coordination, provenance without history.back,
// keyboard lifecycle, hints publishing, and context-menu focus.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  BACK_PRIORITY,
  registerBackLayer,
  recordRouteOrigin,
  recordOriginFromReferrer,
  navigateBackWithOrigin,
  readRouteOriginStack,
  isValidOriginRoute,
  setLogicalView,
  getLogicalView,
  setControllerHints,
  getControllerHints,
  openCouchKeyboard,
  closeCouchKeyboard,
  getCouchKeyboardField,
  openTitleContextMenu,
  closeTitleContextMenu,
  isTitleContextMenuOpen,
  isFreshEditingExit,
} from "../src/scripts/lib/controller-seams-0110"

function escapeEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  })
}

function dispatchEscape(): KeyboardEvent {
  const event = escapeEvent()
  document.body.dispatchEvent(event)
  return event
}

describe("BACK_PRIORITY", () => {
  it("orders modal above editing above page above root", () => {
    expect(BACK_PRIORITY.MODAL).toBeGreaterThan(BACK_PRIORITY.DRAWER)
    expect(BACK_PRIORITY.DRAWER).toBeGreaterThan(BACK_PRIORITY.EDITING)
    expect(BACK_PRIORITY.EDITING).toBeGreaterThan(BACK_PRIORITY.MENU)
    expect(BACK_PRIORITY.MENU).toBeGreaterThan(BACK_PRIORITY.OVERLAY)
    expect(BACK_PRIORITY.OVERLAY).toBeGreaterThan(BACK_PRIORITY.SECTION)
    expect(BACK_PRIORITY.SECTION).toBeGreaterThan(BACK_PRIORITY.PAGE)
    expect(BACK_PRIORITY.PAGE).toBeGreaterThan(BACK_PRIORITY.ROOT)
  })
})

describe("registerBackLayer", () => {
  const unregisters: Array<() => void> = []

  beforeEach(() => {
    document.body.innerHTML = ""
    sessionStorage.clear()
  })

  afterEach(() => {
    while (unregisters.length) unregisters.pop()?.()
    document.body.innerHTML = ""
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it("runs the highest-priority active layer and exactly one step", () => {
    const page = vi.fn()
    const section = vi.fn()
    const modal = vi.fn()
    unregisters.push(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE,
        isActive: () => true,
        handle: page,
      }),
      registerBackLayer({
        id: "section",
        priority: BACK_PRIORITY.SECTION,
        isActive: () => true,
        handle: section,
      }),
      registerBackLayer({
        id: "modal",
        priority: BACK_PRIORITY.MODAL,
        isActive: () => false,
        handle: modal,
      }),
    )
    const event = dispatchEscape()
    expect(section).toHaveBeenCalledTimes(1)
    expect(page).not.toHaveBeenCalled()
    expect(modal).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it("skips inactive layers and falls through to the next active one", () => {
    const page = vi.fn()
    unregisters.push(
      registerBackLayer({
        id: "editing",
        priority: BACK_PRIORITY.EDITING,
        isActive: () => false,
        handle: vi.fn(),
      }),
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE,
        isActive: () => true,
        handle: page,
      }),
    )
    dispatchEscape()
    expect(page).toHaveBeenCalledTimes(1)
  })

  it("unregister removes the layer", () => {
    const handle = vi.fn()
    const unregister = registerBackLayer({
      id: "temp",
      priority: BACK_PRIORITY.PAGE,
      isActive: () => true,
      handle,
    })
    unregister()
    dispatchEscape()
    expect(handle).not.toHaveBeenCalled()
  })

  it("does not run when an earlier handler consumed the press", () => {
    const handle = vi.fn()
    unregisters.push(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE,
        isActive: () => true,
        handle,
      }),
    )
    const consumer = (event: Event) => event.preventDefault()
    document.addEventListener("keydown", consumer, true)
    try {
      dispatchEscape()
    } finally {
      document.removeEventListener("keydown", consumer, true)
    }
    expect(handle).not.toHaveBeenCalled()
  })

  it("does not run while a native dialog is open", () => {
    const handle = vi.fn()
    unregisters.push(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE,
        isActive: () => true,
        handle,
      }),
    )
    const dialog = document.createElement("dialog")
    dialog.setAttribute("open", "")
    document.body.appendChild(dialog)
    dispatchEscape()
    expect(handle).not.toHaveBeenCalled()
    dialog.remove()
    dispatchEscape()
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it("swallows the trailing Escape right after leaving a text field", () => {
    const handle = vi.fn()
    unregisters.push(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE,
        isActive: () => true,
        handle,
      }),
    )
    const input = document.createElement("input")
    input.type = "text"
    document.body.appendChild(input)
    input.focus()
    input.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }))
    input.blur()
    // The swallow is silent (no preventDefault): the press simply
    // does nothing more — the layer must not run.
    dispatchEscape()
    expect(handle).not.toHaveBeenCalled()

    // Past the trailing window, the same press reaches the layer.
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 60_000)
    try {
      dispatchEscape()
    } finally {
      nowSpy.mockRestore()
    }
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it("does not swallow when focus moves to another editable field", async () => {
    const handle = vi.fn()
    unregisters.push(
      registerBackLayer({
        id: "page",
        priority: BACK_PRIORITY.PAGE,
        isActive: () => true,
        handle,
      }),
    )
    // Let any exit timestamp from earlier tests age out: the
    // trailing window is module-global by design.
    await new Promise((resolve) => setTimeout(resolve, 600))
    const first = document.createElement("input")
    first.type = "text"
    const second = document.createElement("input")
    second.type = "text"
    document.body.append(first, second)
    first.focus()
    // Moving between fields records no exit (the manual dispatch
    // carries relatedTarget; jsdom's native focusout does not
    // reliably, so the dispatch itself is the stimulus).
    first.dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: second }),
    )
    expect(isFreshEditingExit()).toBe(false)
    dispatchEscape()
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it("a throwing layer does not break the dispatcher", () => {
    unregisters.push(
      registerBackLayer({
        id: "boom",
        priority: BACK_PRIORITY.MODAL,
        isActive: () => true,
        handle: () => {
          throw new Error("layer blew up")
        },
      }),
    )
    expect(() => dispatchEscape()).not.toThrow()
  })
})

describe("provenance", () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it("rejects invalid routes", () => {
    expect(isValidOriginRoute("/favorites")).toBe(true)
    expect(isValidOriginRoute("/settings/playlists")).toBe(true)
    expect(isValidOriginRoute("https://evil.example/")).toBe(false)
    expect(isValidOriginRoute("//evil.example/")).toBe(false)
    expect(isValidOriginRoute("favorites")).toBe(false)
    expect(isValidOriginRoute("")).toBe(false)
    expect(isValidOriginRoute("/a b")).toBe(false)
    expect(isValidOriginRoute("/\\evil.example/")).toBe(false)
  })

  it("pushes, skips consecutive duplicates, and caps the stack", () => {
    recordRouteOrigin({ route: "/favorites", label: "Favourites" })
    recordRouteOrigin({ route: "/favorites", label: "Favourites" })
    recordRouteOrigin({ route: "/watchlist", label: "Watch Later" })
    const stack = readRouteOriginStack()
    expect(stack).toHaveLength(2)
    expect(stack[0].route).toBe("/favorites")
    expect(stack[1].route).toBe("/watchlist")

    for (let i = 0; i < 15; i++) {
      recordRouteOrigin({ route: `/page-${i}`, label: `Page ${i}` })
    }
    expect(readRouteOriginStack()).toHaveLength(10)
    expect(readRouteOriginStack()[9].route).toBe("/page-14")
  })

  it("navigateBackWithOrigin pops the stack and never returns the current route", () => {
    // jsdom's location.assign is a no-op stub; the provenance
    // behaviour (stack pop + Back flag) is what this asserts.
    recordRouteOrigin({ route: "/favorites", label: "Favourites" })
    recordRouteOrigin({ route: window.location.pathname, label: "Here" })
    navigateBackWithOrigin("/")
    expect(readRouteOriginStack()).toHaveLength(0)
    // The Back flag is set so the landing page does not re-record
    // this page as its origin (no ping-pong).
    expect(sessionStorage.getItem("rs_route_back_nav_0110")).toBe("1")
  })

  it("recordOriginFromReferrer does not re-record after a Back navigation", () => {
    sessionStorage.setItem("rs_route_back_nav_0110", "1")
    recordOriginFromReferrer("Previous")
    expect(readRouteOriginStack()).toHaveLength(0)
    expect(sessionStorage.getItem("rs_route_back_nav_0110")).toBeNull()
  })

  it("recordOriginFromReferrer is a no-op with no referrer", () => {
    recordOriginFromReferrer("Previous")
    expect(readRouteOriginStack()).toHaveLength(0)
  })
})

describe("setLogicalView / setControllerHints", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    document.documentElement.removeAttribute("data-couch-hints-override")
  })

  afterEach(() => {
    document.body.innerHTML = ""
    document.documentElement.removeAttribute("data-couch-hints-override")
  })

  it("mirrors the logical view onto main[data-couch-view]", () => {
    const main = document.createElement("main")
    main.setAttribute("data-couch-view", "home")
    document.body.appendChild(main)
    setLogicalView("favorites")
    expect(main.getAttribute("data-couch-view")).toBe("favorites")
    expect(getLogicalView()).toBe("favorites")
  })

  it("publishes hints without touching the hint bar DOM", () => {
    const bar = document.createElement("div")
    bar.id = "hint-bar"
    bar.textContent = "original"
    document.body.appendChild(bar)
    const seen: Array<CustomEvent> = []
    const listener = (event: Event) => seen.push(event as CustomEvent)
    document.addEventListener("couchhubtv:set-hints", listener)
    try {
      setControllerHints({ id: "favorites", items: [] })
    } finally {
      document.removeEventListener("couchhubtv:set-hints", listener)
    }
    expect(bar.textContent).toBe("original")
    expect(getControllerHints()?.id).toBe("favorites")
    expect(seen).toHaveLength(1)
    expect(
      document.documentElement.getAttribute("data-couch-hints-override"),
    ).toContain("favorites")
  })
})

describe("keyboard lifecycle", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("open focuses and marks the field; close without commit blurs only", () => {
    const input = document.createElement("input")
    input.type = "text"
    document.body.appendChild(input)
    const onCommit = vi.fn()
    const close = openCouchKeyboard(input, onCommit)
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute("data-couch-editing")).toBe("1")
    expect(getCouchKeyboardField()).toBe(input)

    closeCouchKeyboard(false)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.getAttribute("data-couch-editing")).toBeNull()
    expect(document.activeElement).not.toBe(input)
    expect(getCouchKeyboardField()).toBeNull()
    close()
  })

  it("close with commit runs onCommit exactly once", () => {
    const input = document.createElement("input")
    input.type = "text"
    document.body.appendChild(input)
    const onCommit = vi.fn()
    openCouchKeyboard(input, onCommit)
    closeCouchKeyboard(true)
    expect(onCommit).toHaveBeenCalledTimes(1)
    closeCouchKeyboard(true)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})

describe("openTitleContextMenu", () => {
  let anchor: HTMLAnchorElement

  beforeEach(() => {
    document.body.innerHTML = ""
    anchor = document.createElement("a")
    anchor.href = "/movies/detail?id=1"
    anchor.textContent = "Poster"
    document.body.appendChild(anchor)
    anchor.focus()
  })

  afterEach(() => {
    closeTitleContextMenu()
    document.body.innerHTML = ""
  })

  it("opens, focuses the first enabled item, and Escape closes + restores the anchor", () => {
    const action = vi.fn()
    openTitleContextMenu(anchor, [
      { id: "disabled", label: "Disabled", action: vi.fn(), disabled: true },
      { id: "open", label: "Open", action },
    ])
    expect(isTitleContextMenuOpen()).toBe(true)
    const menu = document.getElementById("xt-title-context-menu")
    expect(menu).not.toBeNull()
    expect(menu?.getAttribute("role")).toBe("menu")
    const items = menu?.querySelectorAll<HTMLElement>("[role='menuitem']")
    expect(items?.length).toBe(2)
    expect(document.activeElement?.getAttribute("data-action-id")).toBe("open")

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })
    document.activeElement?.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(isTitleContextMenuOpen()).toBe(false)
    expect(document.activeElement).toBe(anchor)
    expect(action).not.toHaveBeenCalled()
  })

  it("clicking an action runs it, closes the menu, and keeps focus sane", () => {
    const action = vi.fn()
    openTitleContextMenu(anchor, [{ id: "open", label: "Open", action }])
    const item = document.querySelector<HTMLElement>("[data-action-id='open']")
    expect(item).not.toBeNull()
    item?.click()
    expect(action).toHaveBeenCalledTimes(1)
    expect(isTitleContextMenuOpen()).toBe(false)
    expect(document.activeElement).toBe(anchor)
  })

  it("an outside pointerdown closes the menu without running actions", () => {
    const action = vi.fn()
    openTitleContextMenu(anchor, [{ id: "open", label: "Open", action }])
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    )
    expect(isTitleContextMenuOpen()).toBe(false)
    expect(action).not.toHaveBeenCalled()
  })

  it("the Back dispatcher skips layers while the menu is open", async () => {
    const handle = vi.fn()
    const unregister = registerBackLayer({
      id: "page",
      priority: BACK_PRIORITY.PAGE,
      isActive: () => true,
      handle,
    })
    try {
      openTitleContextMenu(anchor, [
        { id: "open", label: "Open", action: vi.fn() },
      ])
      dispatchEscape()
      expect(handle).not.toHaveBeenCalled()
      // The menu's own Escape handler closed it; the next press
      // reaches the layer (exactly one step per press). Wait out
      // the trailing window first: earlier tests' input blurs
      // leave a fresh exit timestamp in the module-global tracker.
      expect(isTitleContextMenuOpen()).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 600))
      dispatchEscape()
      expect(handle).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })
})
