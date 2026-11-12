// Settings card: Followed Series background checks.
// Wires the scheduled-checks toggle (registers/removes the Windows
// Scheduled Task via Rust), the 3/6/12/24h interval, a manual Check Now,
// and the last-check status line.
import { t } from "@/scripts/lib/i18n.js"
import { isTauri } from "@/scripts/lib/creds.js"
import { log } from "@/scripts/lib/log.js"
import {
  getFollowedCheckEnabled,
  setFollowedCheckEnabled,
  getFollowedCheckIntervalHours,
  setFollowedCheckIntervalHours,
  getFollowedLastCheckAt,
  getUnreadCount,
  runFollowedCheck,
  FOLLOWED_CHANGED_EVENT,
} from "@/scripts/lib/followed.ts"
import { toast, toastError } from "@/scripts/lib/toast.ts"

const isWindows =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "")

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core")
  return tauriInvoke<T>(command, args)
}

/** Push the current setting to the Windows Scheduled Task (no-op elsewhere).
 * Returns true when the task is in the requested state. On failure the
 * toggle must SHOW it (0.11.4): a toast alone leaves the toggle claiming
 * On while the while-closed checks never run. */
async function syncScheduledTask(): Promise<boolean> {
  if (!isTauri || !isWindows) return true
  try {
    await invoke("followed_schedule_set", {
      enabled: getFollowedCheckEnabled(),
      intervalHours: getFollowedCheckIntervalHours(),
    })
    setTaskError(null)
    return true
  } catch (err) {
    // Startup repair retries on the next launch; never block Settings on it.
    log.warn("[xt:followed] scheduled-task sync failed (will retry on next launch):", err)
    toastError(t("settings.followed.taskSyncFailed"))
    setTaskError(t("settings.followed.taskSyncFailed"))
    return false
  }
}

/** Persistent inline failure line next to the scheduled-checks toggle.
 * Null clears it. The toggle stays where the user put it (in-app checks
 * follow the stored flag); this line is what says the Windows task — the
 * while-closed part — did not update. */
function setTaskError(message: string | null): void {
  const errorEl = document.getElementById("settings-followed-task-error")
  if (!errorEl) return
  errorEl.textContent = message ?? ""
  errorEl.classList.toggle("hidden", !message)
}

function paintSeg(
  group: HTMLElement | null,
  attr: string,
  activeValue: string
): void {
  if (!group) return
  for (const btn of group.querySelectorAll<HTMLButtonElement>("button")) {
    btn.setAttribute("aria-pressed", btn.getAttribute(attr) === activeValue ? "true" : "false")
  }
}

async function paintStatus(): Promise<void> {
  const statusEl = document.getElementById("settings-followed-status")
  if (!statusEl) return
  try {
    const [lastCheck, unread] = await Promise.all([
      getFollowedLastCheckAt(),
      getUnreadCount(),
    ])
    const when = lastCheck
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(lastCheck)
        )
      : t("settings.followed.neverChecked")
    statusEl.textContent =
      t("settings.followed.statusLine", { when }) +
      (unread > 0 ? ` — ${t("followed.unreadCount", { count: unread })}` : "")
  } catch {
    statusEl.textContent = t("settings.followed.neverChecked")
  }
}

function init(): void {
  const scheduledGroup = document.getElementById("settings-followed-scheduled")
  const intervalGroup = document.getElementById("settings-followed-interval")
  const checkNowBtn = document.getElementById("settings-followed-check-now")

  // The Windows Scheduled Task only exists on the Windows desktop app.
  // Elsewhere the copy must not promise one: checks run while the app is
  // open, and the task note (Windows-only) is hidden.
  if (!isTauri || !isWindows) {
    const hintEl = document.getElementById("settings-followed-scheduled-hint")
    if (hintEl) hintEl.textContent = t("settings.followed.scheduledHintNonWindows")
    document.getElementById("settings-followed-task-note")?.classList.add("hidden")
  }

  const paint = () => {
    paintSeg(
      scheduledGroup,
      "data-scheduled",
      getFollowedCheckEnabled() ? "on" : "off"
    )
    paintSeg(
      intervalGroup,
      "data-interval",
      String(getFollowedCheckIntervalHours())
    )
  }
  paint()
  void paintStatus()

  scheduledGroup?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const enabled = btn.getAttribute("data-scheduled") === "on"
      setFollowedCheckEnabled(enabled)
      paint()
      void syncScheduledTask()
    })
  })

  intervalGroup?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const hours = Number(btn.getAttribute("data-interval"))
      if (!setFollowedCheckIntervalHours(hours)) return
      paint()
      if (getFollowedCheckEnabled()) void syncScheduledTask()
    })
  })

  checkNowBtn?.addEventListener("click", async () => {
    checkNowBtn.setAttribute("disabled", "")
    try {
      const summary = await runFollowedCheck({ manual: true })
      if (summary.newEpisodes > 0) {
        toast({
          title: t("followed.newEpisodesTitle"),
          description: t("followed.newEpisodesBody", { count: summary.newEpisodes }),
        })
      } else if (summary.errors > 0) {
        toastError(t("followed.checkHadErrors"))
      } else {
        toast({ title: t("followed.checkDoneNoNew") })
      }
    } catch (err) {
      log.warn("[xt:followed] manual check failed:", err)
      toastError(t("followed.checkFailed"))
    } finally {
      checkNowBtn.removeAttribute("disabled")
      await paintStatus()
    }
  })

  document.addEventListener(FOLLOWED_CHANGED_EVENT, () => void paintStatus())
}

init()
