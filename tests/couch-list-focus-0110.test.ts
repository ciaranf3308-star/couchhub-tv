/**
 * @vitest-environment jsdom
 */
// W5 — Controller Experience 2.0 (0.11.10): durable list focus
// memory + filter persistence for grids that cannot join the
// [data-nylah-rail] model (Favourites, Watch Later, Followed,
// Recently Added, Settings lists). Restore never steals focus.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  recordListFocus,
  readListFocus,
  writeListFilter,
  readListFilter,
  listFocusKeyFor,
  restoreListFocus,
  initListFocusMemory,
  captureFocusKeyWithin,
  restoreFocusKeyWithin,
} from "../src/scripts/lib/couch-list-focus"

function memoryStore(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

describe("list focus + filter storage", () => {
  it("records and reads focus keys per route", () => {
    const store = memoryStore()
    expect(readListFocus(store, "/favorites")).toBeNull()
    recordListFocus(store, "/favorites", "vod:42")
    recordListFocus(store, "/watchlist", "series:7")
    expect(readListFocus(store, "/favorites")).toBe("vod:42")
    expect(readListFocus(store, "/watchlist")).toBe("series:7")
  })

  it("records and reads filters per route with a fallback", () => {
    const store = memoryStore()
    expect(readListFilter(store, "/favorites", "all")).toBe("all")
    writeListFilter(store, "/favorites", "vod")
    expect(readListFilter(store, "/favorites", "all")).toBe("vod")
    expect(readListFilter(store, "/watchlist", "all")).toBe("all")
  })

  it("a throwing store never breaks callers", () => {
    const failing = {
      getItem: () => {
        throw new Error("nope")
      },
      setItem: () => {
        throw new Error("nope")
      },
    } as unknown as Storage
    expect(() => recordListFocus(failing, "/favorites", "vod:1")).not.toThrow()
    expect(readListFocus(failing, "/favorites")).toBeNull()
    expect(() => writeListFilter(failing, "/favorites", "vod")).not.toThrow()
    expect(readListFilter(failing, "/favorites", "all")).toBe("all")
  })

  it("listFocusKeyFor prefers data-couch-key, then id, else null", () => {
    const keyed = document.createElement("a")
    keyed.setAttribute("data-couch-key", "vod:42")
    keyed.id = "card-42"
    expect(listFocusKeyFor(keyed)).toBe("vod:42")
    const idOnly = document.createElement("button")
    idOnly.id = "load-more"
    expect(listFocusKeyFor(idOnly)).toBe("id:load-more")
    const bare = document.createElement("div")
    expect(listFocusKeyFor(bare)).toBeNull()
    expect(listFocusKeyFor(null)).toBeNull()
  })
})

describe("restoreListFocus", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    sessionStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ""
    sessionStorage.clear()
  })

  function grid(): HTMLElement {
    const root = document.createElement("div")
    root.innerHTML = `
      <a href="/a" data-couch-key="vod:1">One</a>
      <a href="/b" data-couch-key="vod:2">Two</a>
      <button type="button" data-couch-key="filter:vod">VOD</button>
    `
    document.body.appendChild(root)
    return root
  }

  it("restores the recorded card when nothing holds focus", () => {
    const root = grid()
    sessionStorage.setItem("rs_list_focus_v1:/favorites", "vod:2")
    expect(document.activeElement).toBe(document.body)
    restoreListFocus(document, "/favorites", root)
    expect(
      (document.activeElement as HTMLElement)?.getAttribute("data-couch-key"),
    ).toBe("vod:2")
  })

  it("never steals focus from a live element", () => {
    const root = grid()
    sessionStorage.setItem("rs_list_focus_v1:/favorites", "vod:2")
    const first = root.querySelector<HTMLElement>("[data-couch-key='vod:1']")!
    first.focus()
    restoreListFocus(document, "/favorites", root)
    expect(document.activeElement).toBe(first)
  })

  it("is a no-op when the recorded card is gone", () => {
    grid()
    sessionStorage.setItem("rs_list_focus_v1:/favorites", "vod:gone")
    restoreListFocus(document, "/favorites")
    expect(document.activeElement).toBe(document.body)
  })

  it("skips hidden targets", () => {
    const root = grid()
    const target = root.querySelector<HTMLElement>("[data-couch-key='vod:2']")!
    target.setAttribute("hidden", "")
    sessionStorage.setItem("rs_list_focus_v1:/favorites", "vod:2")
    restoreListFocus(document, "/favorites", root)
    expect(document.activeElement).toBe(document.body)
  })
})

describe("initListFocusMemory", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    sessionStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ""
    sessionStorage.clear()
  })

  it("records focusin keys and stops after unmount", () => {
    const root = document.createElement("div")
    root.innerHTML = `
      <a href="/a" data-couch-key="vod:1">One</a>
      <a href="/b" data-couch-key="vod:2">Two</a>
    `
    document.body.appendChild(root)
    const unmount = initListFocusMemory(document, "/favorites")
    const first = root.querySelector<HTMLElement>("[data-couch-key='vod:1']")!
    first.focus()
    expect(sessionStorage.getItem("rs_list_focus_v1:/favorites")).toBe("vod:1")
    unmount()
    const second = root.querySelector<HTMLElement>("[data-couch-key='vod:2']")!
    second.focus()
    expect(sessionStorage.getItem("rs_list_focus_v1:/favorites")).toBe("vod:1")
  })
})

describe("focus preservation across re-renders (Followed)", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  afterEach(() => {
    document.body.innerHTML = ""
  })

  function followedLists(): {
    newList: HTMLElement
    list: HTMLElement
  } {
    const newList = document.createElement("div")
    newList.id = "followed-new-list"
    newList.innerHTML = `
      <div class="card">
        <button type="button" data-couch-key="new:g1:watch:S01E02">Watch</button>
        <button type="button" data-couch-key="new:g1:mark-read">Mark read</button>
      </div>
    `
    const list = document.createElement("div")
    list.id = "followed-list"
    list.innerHTML = `
      <div class="card">
        <button type="button" data-couch-key="sub:p1:s9:open">Open</button>
        <button type="button" data-couch-key="sub:p1:s9:unfollow">Unfollow</button>
      </div>
    `
    document.body.append(newList, list)
    return { newList, list }
  }

  it("captures only when focus sits inside a list", () => {
    const { newList, list } = followedLists()
    const outside = document.createElement("button")
    outside.textContent = "Outside"
    document.body.appendChild(outside)
    outside.focus()
    expect(captureFocusKeyWithin(document, [newList, list])).toBeNull()

    const watch = newList.querySelector<HTMLElement>(
      "[data-couch-key='new:g1:watch:S01E02']",
    )!
    watch.focus()
    expect(captureFocusKeyWithin(document, [newList, list])).toBe(
      "new:g1:watch:S01E02",
    )
  })

  it("restores the exact control after a wholesale re-render", () => {
    const { newList, list } = followedLists()
    const watch = newList.querySelector<HTMLElement>(
      "[data-couch-key='new:g1:watch:S01E02']",
    )!
    watch.focus()
    const key = captureFocusKeyWithin(document, [newList, list])

    // Background check re-renders: replaceChildren drops focus to body.
    newList.replaceChildren()
    newList.innerHTML = `
      <div class="card">
        <button type="button" data-couch-key="new:g1:watch:S01E02">Watch</button>
        <button type="button" data-couch-key="new:g1:mark-read">Mark read</button>
      </div>
    `
    list.replaceChildren()
    list.innerHTML = `
      <div class="card">
        <button type="button" data-couch-key="sub:p1:s9:open">Open</button>
        <button type="button" data-couch-key="sub:p1:s9:unfollow">Unfollow</button>
      </div>
    `
    expect(document.activeElement).toBe(document.body)
    expect(restoreFocusKeyWithin(document, key)).toBe(true)
    expect(
      (document.activeElement as HTMLElement)?.getAttribute("data-couch-key"),
    ).toBe("new:g1:watch:S01E02")
  })

  it("falls back to the first surviving control in the same card", () => {
    const { newList } = followedLists()
    const markRead = newList.querySelector<HTMLElement>(
      "[data-couch-key='new:g1:mark-read']",
    )!
    markRead.focus()
    const key = captureFocusKeyWithin(document, [newList])

    // The episode was marked read elsewhere: its card survives
    // without the mark-read button.
    newList.replaceChildren()
    newList.innerHTML = `
      <div class="card">
        <button type="button" data-couch-key="new:g1:watch:S01E02">Watch</button>
        <button type="button" data-couch-key="new:g1:dismiss">Dismiss</button>
      </div>
    `
    expect(restoreFocusKeyWithin(document, key)).toBe(true)
    expect(
      (document.activeElement as HTMLElement)?.getAttribute("data-couch-key"),
    ).toBe("new:g1:watch:S01E02")
  })

  it("leaves focus alone when the whole card vanished", () => {
    const { newList } = followedLists()
    const watch = newList.querySelector<HTMLElement>(
      "[data-couch-key='new:g1:watch:S01E02']",
    )!
    watch.focus()
    const key = captureFocusKeyWithin(document, [newList])
    newList.replaceChildren()
    expect(restoreFocusKeyWithin(document, key)).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it("never pulls focus from a live element", () => {
    const { newList, list } = followedLists()
    const open = list.querySelector<HTMLElement>(
      "[data-couch-key='sub:p1:s9:open']",
    )!
    open.focus()
    expect(restoreFocusKeyWithin(document, "new:g1:watch:S01E02")).toBe(false)
    expect(document.activeElement).toBe(open)
    void newList
  })
})
