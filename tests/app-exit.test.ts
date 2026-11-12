/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// 0.11.4 W3 (EXIT + CLOSE-TO-TRAY): exit order, hide release,
// close-to-tray default-off, and Ctrl+Q.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: unknown) => void) => {
    mockedListeners[event] = cb
    return () => {
      delete mockedListeners[event]
    }
  }),
}))
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}))

const mockedListeners: Record<string, (e: unknown) => void> = {}

// In-memory Storage, mirroring tests/app-settings.test.ts (Node 24
// ships a native localStorage that shadows jsdom's).
function memoryStorage() {
  const store = new Map<string, string>()
  const storage: Storage = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: (key) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  }
  return { storage, store }
}

const ls = memoryStorage()
const ss = memoryStorage()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal("localStorage", ls.storage)
  vi.stubGlobal("sessionStorage", ss.storage)
  ls.store.clear()
  ss.store.clear()
  for (const key of Object.keys(mockedListeners)) delete mockedListeners[key]
  delete (window as unknown as Record<string, unknown>).__xtExitShortcutsMounted
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  delete (window as unknown as Record<string, unknown>).__TAURI__
  document.body.innerHTML = ""
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("requestAppExit order", () => {
  it("releases Live TV BEFORE quitting, and runs every step in order", async () => {
    const { requestAppExit } = await import("@/scripts/lib/app-exit.ts")
    const order: string[] = []
    const released: string[] = []
    window.addEventListener("livetv:release", () => released.push("livetv:release"))
    await requestAppExit({
      isTauri: true,
      dispatchRelease: () => {
        order.push("release")
        window.dispatchEvent(new CustomEvent("livetv:release"))
      },
      pauseVideos: () => {
        order.push("pause-videos")
      },
      flushVodProgress: () => {
        order.push("flush-vod")
      },
      pauseDownloads: () => {
        order.push("pause-downloads")
      },
      stopTranscode: () => {
        order.push("stop-transcode")
      },
      quit: () => {
        order.push("quit")
      },
    })
    expect(released).toEqual(["livetv:release"])
    expect(order).toEqual([
      "release",
      "pause-videos",
      "flush-vod",
      "pause-downloads",
      "stop-transcode",
      "quit",
    ])
  })

  it("still quits when an early step throws", async () => {
    const { requestAppExit } = await import("@/scripts/lib/app-exit.ts")
    const quit = vi.fn()
    await requestAppExit({
      isTauri: true,
      dispatchRelease: () => {
        throw new Error("boom")
      },
      flushVodProgress: () => {
        throw new Error("boom")
      },
      pauseDownloads: () => {
        throw new Error("boom")
      },
      stopTranscode: () => {
        throw new Error("boom")
      },
      quit,
    })
    expect(quit).toHaveBeenCalledTimes(1)
  })
})

describe("releaseLiveTvStream (hide path)", () => {
  it("dispatches livetv:release and pauses playing video elements", async () => {
    const { releaseLiveTvStream } = await import("@/scripts/lib/app-exit.ts")
    const released: string[] = []
    window.addEventListener("livetv:release", () => released.push("livetv:release"))
    const video = document.createElement("video")
    document.body.appendChild(video)
    const pauseSpy = vi.spyOn(video, "pause").mockImplementation(() => {})
    Object.defineProperty(video, "paused", { configurable: true, get: () => false })
    releaseLiveTvStream()
    expect(released).toEqual(["livetv:release"])
    expect(pauseSpy).toHaveBeenCalled()
  })

  it("hide event releases the stream and arms an every-hide notice", async () => {
    // isTauri is read at module import time — set the flag first.
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    const { initTrayHandler } = await import("@/scripts/lib/tray-handler.ts")
    const released: string[] = []
    window.addEventListener("livetv:release", () => released.push("livetv:release"))
    await initTrayHandler()
    expect(mockedListeners["xt:tray:hidden-to-tray"]).toBeDefined()
    // Hide while the window is hidden: the notice must ARM, not fire
    // into a hidden webview where nobody can see it.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    })
    mockedListeners["xt:tray:hidden-to-tray"]({ payload: undefined })
    expect(released).toEqual(["livetv:release"])
    // Every hide arms the notice — no once-ever gate.
    expect(ss.store.get("xt_tray_hidden_notice_pending")).toBe("1")
    // A second hide re-arms it (the old xt_tray_notice_shown gate is gone).
    mockedListeners["xt:tray:hidden-to-tray"]({ payload: undefined })
    expect(ss.store.get("xt_tray_hidden_notice_pending")).toBe("1")
    // When the window becomes visible again the armed notice is shown
    // (and the flag consumed).
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    })
    document.dispatchEvent(new Event("visibilitychange"))
    expect(ss.store.get("xt_tray_hidden_notice_pending")).toBeUndefined()
  })
})

describe("close-to-tray default off", () => {
  it("fresh install quits on close; a stored opt-in (\"1\") is respected", async () => {
    const settings = await import("@/scripts/lib/app-settings.js")
    expect(settings.getCloseToTray()).toBe(false)
    ls.storage.setItem("xt_close_to_tray", "1")
    expect(settings.getCloseToTray()).toBe(true)
    ls.storage.setItem("xt_close_to_tray", "0")
    expect(settings.getCloseToTray()).toBe(false)
  })

  it("setCloseToTray(true) stores \"1\" and setCloseToTray(false) stores \"0\"", async () => {
    const settings = await import("@/scripts/lib/app-settings.js")
    settings.setCloseToTray(true)
    expect(ls.store.get("xt_close_to_tray")).toBe("1")
    expect(settings.getCloseToTray()).toBe(true)
    settings.setCloseToTray(false)
    expect(ls.store.get("xt_close_to_tray")).toBe("0")
    expect(settings.getCloseToTray()).toBe(false)
  })

  it("Rust default is off", () => {
    const trayRs = readFileSync(resolve("src-tauri/src/tray.rs"), "utf8")
    expect(trayRs).toContain("AtomicBool::new(false)")
    expect(trayRs).not.toContain("AtomicBool::new(true)")
  })
})

describe("Ctrl+Q", () => {
  it("Ctrl+Q genuinely quits from the app window", async () => {
    const { mountExitShortcuts } = await import("@/scripts/lib/app-exit.ts")
    const quit = vi.fn()
    // Inject the release/flush steps so the test exercises the
    // shortcut wiring, not vitest's on-demand transform of the
    // lazy download/transcode imports.
    mountExitShortcuts({
      isTauri: true,
      dispatchRelease: () => {},
      pauseVideos: () => {},
      flushVodProgress: () => {},
      pauseDownloads: () => {},
      stopTranscode: () => {},
      quit,
    })
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "q", ctrlKey: true, bubbles: true }),
    )
    // requestAppExit is async; quit is awaited at the end of the chain.
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
  })

  it("does not fire from a text field or on key repeat", async () => {
    const { mountExitShortcuts } = await import("@/scripts/lib/app-exit.ts")
    const quit = vi.fn()
    mountExitShortcuts({ isTauri: true, quit })
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "q", ctrlKey: true, bubbles: true }),
    )
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "q", ctrlKey: true, repeat: true, bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(quit).not.toHaveBeenCalled()
  })

  it("the tray menu keeps its accelerator label now that the chord works", () => {
    const trayRs = readFileSync(resolve("src-tauri/src/tray.rs"), "utf8")
    expect(trayRs).toContain('Some("CmdOrCtrl+Q")')
  })
})

describe("VOD flush wiring", () => {
  it("app-exit and vod-mount agree on the flush event name", async () => {
    const { VOD_FLUSH_PROGRESS_EVENT } = await import("@/scripts/lib/app-exit.ts")
    expect(VOD_FLUSH_PROGRESS_EVENT).toBe("vod:flush-progress")
    const vodMount = readFileSync(resolve("src/scripts/lib/vod-mount.ts"), "utf8")
    expect(vodMount).toContain('VOD_FLUSH_PROGRESS_EVENT = "vod:flush-progress"')
    expect(vodMount).toContain("writeProgress(pos, dur)")
  })
})
