// Followed Series — global boot wiring (mounted once from Layout.astro).
//
// - Deep links: first-instance CLI args (`--open-series <id>
//   [--episode <s>:<e>]`) via the Rust `followed_take_pending_deep_link`
//   command, and second-instance forwards via the `xt:open-series` Tauri
//   event (single-instance plugin). Both validate before navigating.
// - Stale check: on a normal app open, if the last check is older than the
//   configured interval, run one background check (metadata only).
// - Scheduled checks: on Windows, if scheduled checks are enabled, repair
//   / re-register the Scheduled Task when the exe path changed (updates
//   move the exe), so the 6-hourly check survives an update.
// - Headless mode (`--check-followed`): run one check, then tell Rust to
//   exit. No UI, no toasts, no schedule repair — the window never shows.

import { log } from "@/scripts/lib/log.js"
import {
  runFollowedCheck,
  ensureFollowedLoaded,
  isFollowedCheckStale,
  getFollowedCheckEnabled,
  getFollowedCheckIntervalHours,
  setFollowedWatchedChecker,
  parseDeepLinkTarget,
  buildSeriesDetailUrl,
  type DeepLinkTarget,
} from "@/scripts/lib/followed.ts"
import { toastSuccess } from "@/scripts/lib/toast.ts"
import { t } from "@/scripts/lib/i18n.js"

const isTauri =
  typeof window !== "undefined" &&
  (!!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
    !!(window as unknown as Record<string, unknown>).__TAURI__)

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "")

let installed = false

function navigateToSeries(target: DeepLinkTarget): void {
  const url = buildSeriesDetailUrl(target)
  if (window.location.pathname + window.location.search === url) return
  window.location.href = url
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core")
  return tauriInvoke<T>(command, args)
}

async function runCheckAndToast(manual: boolean): Promise<void> {
  try {
    const summary = await runFollowedCheck({ manual })
    if (summary.newEpisodes > 0) {
      toastSuccess(t("followed.newEpisodesTitle"), {
        description: t("followed.newEpisodesBody", { count: summary.newEpisodes }),
      })
    }
  } catch (err) {
    log.warn("[xt:followed] background check failed:", err)
  }
}

async function repairSchedule(): Promise<void> {
  if (!isTauri || !isWindows) return
  if (!getFollowedCheckEnabled()) return
  try {
    await invoke("followed_schedule_repair", {
      intervalHours: getFollowedCheckIntervalHours(),
    })
  } catch (err) {
    // Repair is best-effort: a missing task only means background checks
    // pause until the user re-enables them in Settings.
    log.warn("[xt:followed] scheduled-task repair failed:", err)
  }
}

export async function initFollowedStartup(): Promise<void> {
  if (installed) return
  installed = true
  try {
    if (typeof document === "undefined") return
    if (window.location.pathname.startsWith("/login")) return

    // Watched state for the Discover seam: an episode counts as watched
    // once preferences records it completed (playback finish / manual mark).
    try {
      const prefs = await import("@/scripts/lib/preferences.js")
      try {
        prefs.ensureLoaded()
      } catch {}
      setFollowedWatchedChecker((playlistId, _seriesId, ep) =>
        ep.episodeId != null ? prefs.isCompleted(playlistId, "episode", ep.episodeId) : false
      )
    } catch (err) {
      log.warn("[xt:followed] watched checker wiring failed:", err)
    }

    await ensureFollowedLoaded().catch(() => {})

    if (isTauri) {
      // Headless check mode: the Rust side started hidden and will exit
      // when we say done. Run the check, then exit — with a safety timer
      // so a hung provider can never leave a ghost process behind.
      let headless = false
      try {
        headless = await invoke<boolean>("followed_headless_mode")
      } catch {}
      if (headless) {
        const safety = setTimeout(() => {
          invoke("followed_headless_done").catch(() => {})
        }, 8 * 60 * 1000)
        try {
          await runFollowedCheck({ manual: true })
        } catch (err) {
          log.warn("[xt:followed] headless check failed:", err)
        } finally {
          clearTimeout(safety)
          await invoke("followed_headless_done").catch(() => {})
        }
        return
      }

      // First-instance deep link from CLI args (consumed once).
      try {
        const pending = await invoke<unknown>("followed_take_pending_deep_link")
        const target = parseDeepLinkTarget(pending)
        if (target) navigateToSeries(target)
      } catch (err) {
        log.warn("[xt:followed] pending deep link read failed:", err)
      }

      // Second-instance forwards + headless-check requests from the
      // scheduled task while the app is already running.
      try {
        const { listen } = await import("@tauri-apps/api/event")
        await listen<unknown>("xt:open-series", (event) => {
          const target = parseDeepLinkTarget(event.payload)
          if (target) navigateToSeries(target)
          else log.warn("[xt:followed] ignoring invalid open-series payload:", event.payload)
        })
        await listen("xt:headless-check-request", () => {
          void runCheckAndToast(true)
        })
      } catch (err) {
        log.warn("[xt:followed] deep-link listener install failed:", err)
      }
    }

    // Normal boot: repair the scheduled task, then run one check if stale.
    void repairSchedule()
    if (!getFollowedCheckEnabled()) return
    try {
      if (await isFollowedCheckStale()) {
        // Let first paint win; the check is metadata-only and cheap.
        setTimeout(() => {
          void runCheckAndToast(false)
        }, 5000)
      }
    } catch (err) {
      log.warn("[xt:followed] stale-check probe failed:", err)
    }
  } catch (err) {
    log.warn("[xt:followed] startup failed:", err)
  }
}
