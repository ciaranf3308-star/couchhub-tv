// Followed Series management view (/followed): New Episodes + followed shows.
// Controller-first: every action is a native <button>, lists re-render on
// the followed-changed events, and all provider text goes through
// textContent (never innerHTML).
import { log } from "@/scripts/lib/log.js"
import {
  listSubscriptions,
  listNotificationGroups,
  runFollowedCheck,
  unfollowSeries,
  rebaselineSeries,
  markNotificationRead,
  dismissNotification,
  getFollowedLastCheckAt,
  buildSeriesDetailUrl,
  FOLLOWED_CHANGED_EVENT,
  FOLLOWED_NOTIFICATIONS_EVENT,
  type FollowedNotificationGroup,
  type FollowedSubscription,
} from "@/scripts/lib/followed.ts"
import { isCompleted } from "@/scripts/lib/preferences.js"
import { toast, toastError } from "@/scripts/lib/toast.ts"
import { t } from "@/scripts/lib/i18n.js"

const newListEl = document.getElementById("followed-new-list")
const newEmptyEl = document.getElementById("followed-new-empty")
const unreadCountEl = document.getElementById("followed-unread-count")
const listEl = document.getElementById("followed-list")
const listEmptyEl = document.getElementById("followed-list-empty")
const lastCheckEl = document.getElementById("followed-last-check")
const checkNowBtn = document.getElementById("followed-check-now")

const dateFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function fmtDate(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return dateFmt.format(d)
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "btn"
  btn.textContent = label
  btn.addEventListener("click", onClick)
  return btn
}

function posterImg(url: string | null, title: string): HTMLImageElement | null {
  if (!url) return null
  const img = document.createElement("img")
  img.src = url
  img.alt = ""
  img.loading = "lazy"
  img.className = "followed-poster w-16 shrink-0 rounded-lg object-cover aspect-2/3"
  return img
}

function statusText(sub: FollowedSubscription): string {
  switch (sub.lastCheckStatus) {
    case "never":
      return t("followed.status.never")
    case "ok":
      return t("followed.status.ok", { when: fmtDate(sub.lastCheckAt) })
    case "error":
      return t("followed.status.error")
    case "incomplete":
      return t("followed.status.incomplete")
    case "unsupported-m3u":
      return t("followed.status.unsupportedM3u")
    case "playlist-missing":
      return t("followed.status.playlistMissing")
    case "bulk-remap-suspected":
      return t("followed.status.bulkRemap")
    default:
      return ""
  }
}

function renderNewEpisodes(groups: FollowedNotificationGroup[]): void {
  if (!newListEl) return
  newListEl.replaceChildren()
  const unread = groups.filter((g) => !g.read && !g.dismissed)
  const read = groups.filter((g) => g.read && !g.dismissed)
  const totalUnread = unread.reduce((n, g) => n + g.episodes.length, 0)
  if (unreadCountEl) {
    unreadCountEl.textContent =
      totalUnread > 0 ? t("followed.unreadCount", { count: totalUnread }) : ""
  }
  newEmptyEl?.toggleAttribute("hidden", unread.length > 0 || read.length > 0)
  if (unread.length === 0 && read.length === 0) return

  for (const group of [...unread, ...read]) {
    const card = el("article", "followed-card nylah-card flex gap-4 p-4")
    const poster = posterImg(group.posterUrl, group.seriesTitle)
    if (poster) card.appendChild(poster)
    const body = el("div", "flex min-w-0 flex-1 flex-col gap-2")
    const title = el("h3", "font-serif text-xl leading-tight")
    title.textContent = group.seriesTitle
    body.appendChild(title)
    const detected = el("p", "text-xs text-fg-3 tabular-nums")
    detected.textContent = t("followed.detectedOn", { when: fmtDate(group.detectedAt) })
    body.appendChild(detected)
    const eps = el("ul", "flex flex-col gap-2")
    for (const ep of group.episodes) {
      const li = el("li", "flex flex-wrap items-center gap-2 text-sm")
      const label = el("span", "min-w-0 flex-1")
      const watched = ep.episodeId != null && isCompleted(group.playlistId, "episode", ep.episodeId)
      label.textContent =
        `S${ep.season}E${ep.episode}` +
        (ep.episodeTitle ? ` — ${ep.episodeTitle}` : "") +
        (watched ? ` (${t("followed.watched")})` : "")
      li.appendChild(label)
      const watchBtn = actionButton(t("followed.watchNow"), () => {
        window.location.href = buildSeriesDetailUrl({
          seriesId: group.seriesId,
          season: ep.season,
          episode: ep.episode,
        })
      })
      li.appendChild(watchBtn)
      eps.appendChild(li)
    }
    body.appendChild(eps)
    const actions = el("div", "flex flex-wrap gap-2")
    if (!group.read) {
      actions.appendChild(
        actionButton(t("followed.markRead"), () => {
          void markNotificationRead(group.id).then(render)
        })
      )
    }
    actions.appendChild(
      actionButton(t("followed.dismiss"), () => {
        void dismissNotification(group.id).then(render)
      })
    )
    body.appendChild(actions)
    card.appendChild(body)
    newListEl.appendChild(card)
  }
}

function renderFollowedList(subs: FollowedSubscription[]): void {
  if (!listEl) return
  listEl.replaceChildren()
  listEmptyEl?.toggleAttribute("hidden", subs.length > 0)
  for (const sub of subs) {
    const card = el("article", "followed-card nylah-card flex gap-4 p-4")
    const poster = posterImg(sub.posterUrl, sub.seriesTitle)
    if (poster) card.appendChild(poster)
    const body = el("div", "flex min-w-0 flex-1 flex-col gap-2")
    const title = el("h3", "font-serif text-xl leading-tight")
    title.textContent = sub.seriesTitle
    body.appendChild(title)
    const meta = el("p", "text-xs text-fg-3 tabular-nums")
    meta.textContent = t("followed.episodesBaselined", { count: sub.baseline.length })
    body.appendChild(meta)
    const status = el("p", "text-sm text-fg-2")
    status.textContent = statusText(sub)
    body.appendChild(status)
    const actions = el("div", "flex flex-wrap gap-2")
    if (sub.needsRebaseline) {
      const rebaselineBtn = actionButton(t("followed.rebaseline"), async () => {
        rebaselineBtn.disabled = true
        try {
          const { xtreamApiFetch } = await import("@/scripts/lib/xtream-api.js")
          const response = await xtreamApiFetch(
            "get_series_info",
            { series_id: sub.seriesId, series: sub.seriesId },
            { entryId: sub.playlistId }
          )
          if (!response.ok) throw new Error(`get_series_info HTTP ${response.status}`)
          const info = await response.json()
          const result = await rebaselineSeries(sub.playlistId, sub.seriesId, info)
          if (result.ok) toast({ title: t("followed.rebaselined") })
          else toastError(t("followed.rebaselineFailed"))
        } catch (err) {
          log.warn("[xt:followed] re-baseline failed:", err)
          toastError(t("followed.rebaselineFailed"))
        } finally {
          await render()
        }
      })
      actions.appendChild(rebaselineBtn)
    }
    actions.appendChild(
      actionButton(t("followed.unfollow"), () => {
        void unfollowSeries(sub.playlistId, sub.seriesId).then(() => {
          toast({ title: t("followed.unfollowed"), description: sub.seriesTitle })
          void render()
        })
      })
    )
    const openBtn = actionButton(t("followed.openSeries"), () => {
      window.location.href = buildSeriesDetailUrl({ seriesId: sub.seriesId })
    })
    actions.appendChild(openBtn)
    body.appendChild(actions)
    card.appendChild(body)
    listEl.appendChild(card)
  }
}

async function render(): Promise<void> {
  try {
    const [groups, subs, lastCheck] = await Promise.all([
      listNotificationGroups({ includeDismissed: false }),
      listSubscriptions(),
      getFollowedLastCheckAt(),
    ])
    renderNewEpisodes(groups)
    renderFollowedList(subs)
    if (lastCheckEl) {
      lastCheckEl.textContent = lastCheck
        ? t("followed.lastCheck", { when: fmtDate(lastCheck) })
        : t("followed.neverChecked")
    }
  } catch (err) {
    log.warn("[xt:followed] page render failed:", err)
  }
}

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
    await render()
  }
})

document.addEventListener(FOLLOWED_CHANGED_EVENT, () => void render())
document.addEventListener(FOLLOWED_NOTIFICATIONS_EVENT, () => void render())

void render()
