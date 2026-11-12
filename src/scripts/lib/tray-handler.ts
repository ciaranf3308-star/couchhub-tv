// Frontend handler for system-tray menu actions.
//
// The Rust side (`src-tauri/src/tray.rs`) emits `xt:tray:navigate` with
// the target route string when the user picks a nav item from the tray
// menu. Astro is multi-page, so a full document navigation is correct;
// route changes via `window.location.href` give us a clean load with
// the page's own bundle.
//
// Desktop-only: imports `@tauri-apps/api/event` lazily so the web build
// and Android can skip the bundle entirely.
//
// Hide contract (0.11.4 W3): hiding must NEVER mean "keeps playing
// invisibly". On `xt:tray:hidden-to-tray` the Live TV stream is
// released immediately (dispatch `livetv:release` + pause every
// video), and the notice is shown EVERY hide — the old once-ever
// `xt_tray_notice_shown` gate is gone. A toast fired while the window
// is hidden would never be seen, so the hide only arms a pending
// notice; it is shown when the window becomes visible again, and the
// Rust side sets the tray tooltip ("running in tray, Live TV
// stopped") as the persistent signal while hidden.

import { log } from "@/scripts/lib/log.js"
import { notify } from "@/scripts/lib/notify"
import { t } from "@/scripts/lib/i18n"
import { syncCloseToTrayToBackend } from "@/scripts/lib/app-settings.js"
import { releaseLiveTvStream } from "@/scripts/lib/app-exit"

type UnlistenFn = () => void

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__)

const isAndroid = (() => {
  if (typeof navigator === "undefined") return false
  return /Android/i.test(navigator.userAgent || "")
})()

const KNOWN_ROUTES = new Set([
  "/",
  "/livetv",
  "/browse",
  "/movies",
  "/series",
  "/followed",
  "/search",
  "/epg",
  "/downloads",
  "/settings",
  "/favorites",
  "/watchlist",
  "/recently-added",
])

/** Set on hide; the notice is shown when the window is visible again. */
const TRAY_HIDDEN_NOTICE_PENDING_KEY = "xt_tray_hidden_notice_pending"

function showHiddenNotice(): void {
  notify({
    title: t("tray.notice.title"),
    body: t("tray.notice.body"),
  }).catch(() => {})
}

/** Show the armed every-hide notice now that the window is visible. */
export function flushPendingTrayHiddenNotice(): void {
  try {
    if (sessionStorage.getItem(TRAY_HIDDEN_NOTICE_PENDING_KEY) !== "1") return
    sessionStorage.removeItem(TRAY_HIDDEN_NOTICE_PENDING_KEY)
  } catch {
    return
  }
  showHiddenNotice()
}

let installed = false

export async function initTrayHandler(): Promise<UnlistenFn | null> {
  if (installed) return null
  if (!isTauri || isAndroid) return null
  installed = true

  syncCloseToTrayToBackend()

  // If a previous hide armed the notice and this page loaded while
  // visible, show it now; otherwise the visibilitychange listener
  // below fires when the window comes back.
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    flushPendingTrayHiddenNotice()
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") flushPendingTrayHiddenNotice()
    })
  }

  try {
    const { listen } = await import("@tauri-apps/api/event")
    const [unlistenNavigate, unlistenHidden] = await Promise.all([
      listen<string>("xt:tray:navigate", (event) => {
        const route = String(event.payload || "").trim()
        if (!KNOWN_ROUTES.has(route)) {
          log.warn("[xt:tray] unknown navigate route:", route)
          return
        }
        if (window.location.pathname === route) return
        window.location.href = route
      }),
      listen("xt:tray:hidden-to-tray", () => {
        // (1) Release the stream FIRST — hiding must never leave
        // Live TV playing invisibly and holding the provider's
        // single connection.
        releaseLiveTvStream()
        // (2) Arm the every-hide notice. It is shown when the window
        // is visible again — a toast in a hidden webview is invisible.
        // The Rust side sets the tray tooltip as the signal while hidden.
        try {
          sessionStorage.setItem(TRAY_HIDDEN_NOTICE_PENDING_KEY, "1")
        } catch {}
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
          flushPendingTrayHiddenNotice()
        }
      }),
    ])
    return () => {
      unlistenNavigate()
      unlistenHidden()
    }
  } catch (err) {
    log.warn("[xt:tray] handler init failed:", err)
    installed = false
    return null
  }
}
