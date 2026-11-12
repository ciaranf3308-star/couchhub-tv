// App exit + hide-to-tray stream release (0.11.4 W3 — EXIT + CLOSE-TO-TRAY).
//
// One ordered exit path, used by every in-app exit surface (Settings Exit
// button, top-nav power button, Ctrl+Q / Cmd+Q):
//
//   1. Live TV: dispatch `livetv:release` FIRST — stream.ts's consumer
//      calls releaseLocalPlaybackForHandoff() synchronously (pause +
//      reset, stop external player, clear stall/dead-video/dead-audio
//      watchdogs, null lastPlayContext), so the provider connection is
//      released BEFORE the process dies. Belt-and-braces: pause every
//      <video> element in the DOM too, so a stream held outside the
//      Live TV engine (or on a page where stream.ts never loaded)
//      cannot keep playing either.
//   2. VOD: pause + flush resume position now via `vod:flush-progress`
//      (vod-mount.ts writes the current position through the normal
//      writeProgress path instead of waiting for the 5 s throttle).
//   3. In-flight downloads are marked paused (not abandoned) and any
//      audio-transcode session is unregistered.
//   4. Settings/state are already persisted continuously (localStorage
//      writes are synchronous); nothing extra to flush here.
//   5. Full process quit via the `quit_app` Tauri command (Rust
//      app.exit(0)). Outside Tauri (web preview) this is a no-op
//      after the release steps — window.close() is best-effort only.
//
// Hiding is NOT exiting: `releaseLiveTvStream()` is also the hide
// path — when close-to-tray is on and the window hides, the stream
// must be released the same way, never left playing invisibly.
// tray-handler.ts calls it on `xt:tray:hidden-to-tray`.
//
// Ctrl+Q: there is NO global-shortcut registration anywhere (no
// tauri-plugin-global-shortcut, no register call) — the tray menu's
// `CmdOrCtrl+Q` accelerator only labels the menu item. The real
// shortcut is this module's frontend keydown handler, mounted by
// every layout, so Ctrl+Q / Cmd+Q genuinely quits from the app
// window (keyboard focus). When the window is hidden to the tray
// there is no focused window, so the tray menu's Quit item is the
// quit path there — the accelerator string stays honest because the
// chord works whenever the app window is up.

import { log } from "@/scripts/lib/log.js"

export const LIVETV_RELEASE_EVENT = "livetv:release"
export const VOD_FLUSH_PROGRESS_EVENT = "vod:flush-progress"

export interface AppExitDeps {
  /** Dispatch the Live TV release (default: window CustomEvent). */
  dispatchRelease?: () => void
  /** Pause every video element (default: query all <video> + pause). */
  pauseVideos?: () => void
  /** Flush VOD resume position (default: window CustomEvent). */
  flushVodProgress?: () => void
  /** Pause in-flight downloads (default: dynamic import of downloads.js). */
  pauseDownloads?: () => Promise<void> | void
  /** Stop any audio-transcode session (default: dynamic import of audio-proxy.ts). */
  stopTranscode?: () => Promise<void> | void
  /** Quit the process (default: invoke the `quit_app` Tauri command). */
  quit?: () => Promise<void> | void
  /** Whether we are running inside Tauri (default: __TAURI_INTERNALS__ / __TAURI__ present). */
  isTauri?: boolean
}

function defaultDispatchRelease(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(LIVETV_RELEASE_EVENT, { detail: {} }))
}

function defaultPauseVideos(): void {
  if (typeof document === "undefined") return
  for (const video of Array.from(document.querySelectorAll("video"))) {
    try {
      if (!video.paused) video.pause()
    } catch {
      // Pausing is best-effort; never block the exit.
    }
  }
}

function defaultFlushVodProgress(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(VOD_FLUSH_PROGRESS_EVENT, { detail: {} }))
}

async function defaultPauseDownloads(): Promise<void> {
  try {
    const downloads = await import("@/scripts/lib/downloads.js")
    for (const item of downloads.listDownloads() ?? []) {
      if (item?.status === "downloading" || item?.status === "queued" || item?.status === "stalled") {
        downloads.pauseDownload(item.id)
      }
    }
  } catch (err) {
    log.warn("[xt:exit] pausing downloads failed (continuing exit):", err)
  }
}

async function defaultStopTranscode(): Promise<void> {
  try {
    const audioProxy = await import("@/scripts/lib/audio-proxy.ts")
    await audioProxy.stopAudioTranscode()
  } catch (err) {
    log.warn("[xt:exit] stopping audio transcode failed (continuing exit):", err)
  }
}

async function defaultQuit(isTauri: boolean): Promise<void> {
  if (!isTauri) {
    try {
      window.close()
    } catch {
      // Web preview: nothing to quit.
    }
    return
  }
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("quit_app")
}

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false
  return !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
    !!(window as unknown as Record<string, unknown>).__TAURI__
}

/**
 * Release the Live TV stream WITHOUT quitting — the hide path.
 * Dispatches `livetv:release` (the engine's synchronous release) and
 * pauses any video element, so hiding can never leave a stream
 * playing invisibly. Safe to call when nothing is playing.
 */
export function releaseLiveTvStream(deps: Pick<AppExitDeps, "dispatchRelease" | "pauseVideos"> = {}): void {
  try {
    ;(deps.dispatchRelease ?? defaultDispatchRelease)()
  } catch (err) {
    log.warn("[xt:exit] livetv release dispatch failed:", err)
  }
  try {
    ;(deps.pauseVideos ?? defaultPauseVideos)()
  } catch (err) {
    log.warn("[xt:exit] pausing videos failed:", err)
  }
}

/**
 * Full exit, in order: release Live TV -> pause VOD + flush resume ->
 * pause downloads -> stop transcode -> quit. Every step is
 * best-effort except the final quit; a failing step is logged and
 * the exit continues — a stuck download must never trap the user
 * inside the app. Returns only via the process exiting (or, outside
 * Tauri, after the best-effort window.close()).
 */
export async function requestAppExit(deps: AppExitDeps = {}): Promise<void> {
  const isTauri = deps.isTauri ?? isTauriRuntime()
  log.info("[xt:exit] exiting app", { isTauri })
  // (1) Live TV release BEFORE anything else — the provider
  // connection must be freed before the process dies.
  releaseLiveTvStream(deps)
  // (2) VOD: pause + persist resume position now.
  try {
    ;(deps.flushVodProgress ?? defaultFlushVodProgress)()
  } catch (err) {
    log.warn("[xt:exit] VOD resume flush failed (continuing exit):", err)
  }
  // (3) In-flight download/transcode state: paused, not abandoned.
  try {
    await (deps.pauseDownloads ?? defaultPauseDownloads)()
  } catch (err) {
    log.warn("[xt:exit] pausing downloads failed (continuing exit):", err)
  }
  try {
    await (deps.stopTranscode ?? defaultStopTranscode)()
  } catch (err) {
    log.warn("[xt:exit] stopping audio transcode failed (continuing exit):", err)
  }
  // (4) Settings/state persist continuously via synchronous
  // localStorage writes — nothing to flush.
  // (5) Full process quit.
  try {
    await (deps.quit ?? (() => defaultQuit(isTauri)))()
  } catch (err) {
    log.warn("[xt:exit] quit failed:", err)
    // Last resort: ask the window to close so a broken invoke can
    // never trap the user.
    try {
      window.close()
    } catch {
      // Nothing left to try.
    }
  }
}

const EXIT_SHORTCUTS_FLAG = "__xtExitShortcutsMounted" as const

/**
 * Mount the real Ctrl+Q / Cmd+Q handler: the chord genuinely quits
 * from the app window (keyboard focus). Mounted once per page load
 * by every layout; safe to call repeatedly. Typing in a field is
 * left alone, and the chord never fires from an OSD or during
 * playback-gesture handling — it is a deliberate key chord, not a
 * single press.
 */
export function mountExitShortcuts(deps: AppExitDeps = {}): void {
  if (typeof window === "undefined") return
  const flagHolder = window as unknown as Record<string, unknown>
  if (flagHolder[EXIT_SHORTCUTS_FLAG]) return
  flagHolder[EXIT_SHORTCUTS_FLAG] = true
  document.addEventListener("keydown", (event) => {
    const isQuitChord =
      (event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "q" || event.key === "Q")
    if (!isQuitChord || event.repeat || event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return
    event.preventDefault()
    void requestAppExit(deps)
  })
}
