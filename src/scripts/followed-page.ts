// Followed Series management view (/followed): New Episodes + followed shows.
// Controller-first: every action is a native <button>, lists re-render on
// the followed-changed events, and all provider text goes through
// textContent (never innerHTML). Rendering uses the W1 RedSilk classes
// (rs-followed-* in followed.astro + rs-image fallback structure); all
// data and actions come from followed.ts, unchanged.
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
import { confirmDialog } from "@/scripts/lib/confirm-dialog.js"
import {
  registerBackLayer,
  BACK_PRIORITY,
} from "@/scripts/lib/back-handler.js"
import {
  recordOriginFromReferrer,
  navigateBackWithOrigin,
} from "@/scripts/lib/route-origin.js"
import { setLogicalView } from "@/scripts/lib/couch-focus.js"
import {
  openTitleContextMenu,
  isTitleContextMenuOpen,
  type TitleContextAction,
} from "@/scripts/lib/poster-menu.js"
import {
  initListFocusMemory,
  restoreListFocus,
  captureFocusKeyWithin,
  restoreFocusKeyWithin,
} from "@/scripts/lib/couch-list-focus.js"
import { findOpenModal } from "@/scripts/lib/dialog-spatial-nav.js"
import {
  RETURN_HOME_HINT,
  setControllerHints,
} from "@/scripts/lib/couch-button-hints.js"
import {
  armTvImageFallbacks,
  fallbackMarkFor,
} from "@/scripts/lib/couch-image.ts"
import { getActiveEntry } from "@/scripts/lib/creds.js"
import {
  EPG_LOADED_EVENT,
  EPG_SOURCE_STATUS_EVENT,
  getProgrammesSync,
} from "@/scripts/lib/epg-data.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.js"
import { getChannelEpgOverride } from "@/scripts/lib/preferences.js"
import {
  isSportsTeamFollowed,
  SPORTS_FOLLOW_CHANGED_EVENT,
} from "@/scripts/lib/sports-follow.js"
import {
  getSportsScan,
  type SportsScanChannel,
  type SportsScanResult,
} from "@/scripts/lib/sports-fixture-scan.js"
import {
  buildSportsEntryCardModel,
  createSportsHubCallbacks,
  renderSportsEntryCard,
} from "@/scripts/followed-sports-page.js"

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

function actionButton(
  label: string,
  onClick: () => void,
  primary = false,
  focusKey?: string,
): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = primary ? "rs-followed-btn rs-followed-btn--primary" : "rs-followed-btn"
  btn.textContent = label
  if (focusKey) btn.setAttribute("data-couch-key", focusKey)
  btn.addEventListener("click", onClick)
  return btn
}

// Last rendered data, for the X context menu's lookups.
let lastGroups: FollowedNotificationGroup[] = []
let lastSubs: FollowedSubscription[] = []

/**
 * Focus preservation across re-renders (background checks must NEVER
 * steal focus): capture the focused control's stable key before a
 * render, restore it after — exact control first, else the first
 * control in the same card, else leave focus alone (the shared
 * couch-focus replacement only engages when a whole card vanished).
 * Implemented by the shared helpers in couch-list-focus.ts.
 */
function captureFocusedKey(): string | null {
  return captureFocusKeyWithin(document, [newListEl, listEl])
}

function restoreFocusedKey(key: string | null): void {
  restoreFocusKeyWithin(document, key)
}

function findByFocusKey(key: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>("[data-couch-key]")
  for (const candidate of candidates) {
    if (candidate.getAttribute("data-couch-key") === key) return candidate
  }
  return null
}

async function confirmUnfollow(sub: FollowedSubscription): Promise<void> {
  const confirmed = await confirmDialog({
    title: t("followed.unfollow"),
    message: `Stop following "${sub.seriesTitle}"? New-episode checks for this show will stop.`,
    confirmLabel: t("followed.unfollow"),
    cancelLabel: t("common.cancel"),
    destructive: true,
  })
  if (!confirmed) return
  await unfollowSeries(sub.playlistId, sub.seriesId)
  toast({ title: t("followed.unfollowed"), description: sub.seriesTitle })
  await render()
}

async function confirmRebaseline(
  sub: FollowedSubscription,
  trigger: HTMLButtonElement,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: t("followed.rebaseline"),
    message: `Re-baseline "${sub.seriesTitle}" to its current episodes? No alerts will be sent for episodes already in your library.`,
    confirmLabel: t("followed.rebaseline"),
    cancelLabel: t("common.cancel"),
  })
  if (!confirmed) return
  trigger.disabled = true
  try {
    const { xtreamApiFetch } = await import("@/scripts/lib/xtream-api.js")
    const response = await xtreamApiFetch(
      "get_series_info",
      { series_id: sub.seriesId, series: sub.seriesId },
      { entryId: sub.playlistId },
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
}

/**
 * Poster in the W1 TvImage structure (rs-image + branded fallback, never
 * a broken-image icon). No poster URL means no poster block at all.
 */
function posterBlock(url: string | null, title: string): HTMLElement | null {
  if (!url) return null
  const wrap = el("div", "rs-followed-poster")
  const image = el("div", "rs-image rs-image--poster")
  image.setAttribute("data-tv-image", "")
  image.setAttribute("data-kind", "poster")
  const img = document.createElement("img")
  img.src = url
  img.alt = ""
  img.loading = "lazy"
  img.setAttribute("data-tv-image-img", "")
  image.appendChild(img)
  const fallback = el("div", "rs-image__fallback")
  fallback.setAttribute("aria-hidden", "true")
  const mark = el("span", "rs-image__fallback-mark")
  mark.textContent = fallbackMarkFor("poster", title)
  fallback.appendChild(mark)
  const fallbackTitle = el("span", "rs-image__fallback-title")
  fallbackTitle.textContent = title
  fallback.appendChild(fallbackTitle)
  image.appendChild(fallback)
  wrap.appendChild(image)
  return wrap
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
    const card = el("article", "rs-followed-card")
    const poster = posterBlock(group.posterUrl, group.seriesTitle)
    if (poster) card.appendChild(poster)
    const body = el("div", "rs-followed-body")
    const title = el("h3", "rs-followed-title")
    title.textContent = group.seriesTitle
    body.appendChild(title)
    const detected = el("p", "rs-meta")
    detected.textContent = t("followed.detectedOn", { when: fmtDate(group.detectedAt) })
    body.appendChild(detected)
    const eps = el("ul", "rs-followed-episodes")
    for (const ep of group.episodes) {
      const li = el("li", "rs-followed-episode")
      const label = el("span", "rs-followed-episode-label")
      const watched = ep.episodeId != null && isCompleted(group.playlistId, "episode", ep.episodeId)
      label.textContent =
        `S${ep.season}E${ep.episode}` +
        (ep.episodeTitle ? ` — ${ep.episodeTitle}` : "") +
        (watched ? ` (${t("followed.watched")})` : "")
      li.appendChild(label)
      const watchBtn = actionButton(
        t("followed.watchNow"),
        () => {
          window.location.href = buildSeriesDetailUrl({
            seriesId: group.seriesId,
            season: ep.season,
            episode: ep.episode,
          })
        },
        true,
        `new:${group.id}:watch:${ep.season}x${ep.episode}`,
      )
      li.appendChild(watchBtn)
      eps.appendChild(li)
    }
    body.appendChild(eps)
    const actions = el("div", "rs-followed-actions")
    if (!group.read) {
      actions.appendChild(
        actionButton(
          t("followed.markRead"),
          () => {
            void markNotificationRead(group.id).then(render)
          },
          false,
          `new:${group.id}:mark-read`,
        ),
      )
    }
    actions.appendChild(
      actionButton(
        t("followed.dismiss"),
        () => {
          void dismissNotification(group.id).then(render)
        },
        false,
        `new:${group.id}:dismiss`,
      ),
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
    const card = el("article", "rs-followed-card")
    const poster = posterBlock(sub.posterUrl, sub.seriesTitle)
    if (poster) card.appendChild(poster)
    const body = el("div", "rs-followed-body")
    const title = el("h3", "rs-followed-title")
    title.textContent = sub.seriesTitle
    body.appendChild(title)
    const meta = el("p", "rs-meta")
    meta.textContent = t("followed.episodesBaselined", { count: sub.baseline.length })
    body.appendChild(meta)
    const status = el("p", "rs-body-text")
    status.textContent = statusText(sub)
    body.appendChild(status)
    const actions = el("div", "rs-followed-actions")
    const subKey = `sub:${sub.playlistId}:${sub.seriesId}`
    if (sub.needsRebaseline) {
      const rebaselineBtn = actionButton(
        t("followed.rebaseline"),
        () => {
          void confirmRebaseline(sub, rebaselineBtn)
        },
        false,
        `${subKey}:rebaseline`,
      )
      actions.appendChild(rebaselineBtn)
    }
    actions.appendChild(
      actionButton(
        t("followed.unfollow"),
        () => {
          void confirmUnfollow(sub)
        },
        false,
        `${subKey}:unfollow`,
      ),
    )
    const openBtn = actionButton(
      t("followed.openSeries"),
      () => {
        window.location.href = buildSeriesDetailUrl({ seriesId: sub.seriesId })
      },
      false,
      `${subKey}:open`,
    )
    actions.appendChild(openBtn)
    body.appendChild(actions)
    card.appendChild(body)
    listEl.appendChild(card)
  }
}

async function render(): Promise<void> {
  const focusKey = captureFocusedKey()
  try {
    const [groups, subs, lastCheck] = await Promise.all([
      listNotificationGroups({ includeDismissed: false }),
      listSubscriptions(),
      getFollowedLastCheckAt(),
    ])
    lastGroups = groups
    lastSubs = subs
    renderNewEpisodes(groups)
    renderFollowedList(subs)
    if (lastCheckEl) {
      lastCheckEl.textContent = lastCheck
        ? t("followed.lastCheck", { when: fmtDate(lastCheck) })
        : t("followed.neverChecked")
    }
  } catch (err) {
    log.warn("[xt:followed] page render failed:", err)
  } finally {
    // Background re-renders restore the focused control (or its
    // same-card survivor) and never move focus elsewhere.
    restoreFocusedKey(focusKey)
    restoreListFocus(document, "/followed")
  }
}

let checkRunning = false

checkNowBtn?.addEventListener("click", async () => {
  if (checkRunning) return
  checkRunning = true
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
    checkRunning = false
    checkNowBtn.removeAttribute("disabled")
    await render()
  }
})

function openFollowedMenu(anchor: HTMLElement, focusKey: string): void {
  const actions: TitleContextAction[] = []
  if (focusKey.startsWith("sub:")) {
    const [, playlistId, seriesId] = focusKey.split(":")
    const sub = lastSubs.find(
      (candidate) =>
        String(candidate.playlistId) === playlistId &&
        String(candidate.seriesId) === seriesId,
    )
    if (!sub) return
    actions.push({
      id: "open",
      label: t("followed.openSeries"),
      action: () => {
        window.location.href = buildSeriesDetailUrl({ seriesId: sub.seriesId })
      },
    })
    if (sub.needsRebaseline) {
      actions.push({
        id: "rebaseline",
        label: t("followed.rebaseline"),
        action: () => {
          const trigger =
            findByFocusKey(`sub:${sub.playlistId}:${sub.seriesId}:rebaseline`) ??
            anchor
          void confirmRebaseline(sub, trigger as HTMLButtonElement)
        },
      })
    }
    actions.push({
      id: "unfollow",
      label: t("followed.unfollow"),
      action: () => {
        void confirmUnfollow(sub)
      },
    })
  } else if (focusKey.startsWith("new:")) {
    const groupId = focusKey.split(":")[1]
    const group = lastGroups.find((candidate) => String(candidate.id) === groupId)
    if (!group) return
    actions.push({
      id: "open",
      label: t("followed.openSeries"),
      action: () => {
        window.location.href = buildSeriesDetailUrl({ seriesId: group.seriesId })
      },
    })
    if (!group.read) {
      actions.push({
        id: "mark-read",
        label: t("followed.markRead"),
        action: () => {
          void markNotificationRead(group.id).then(render)
        },
      })
    }
    actions.push({
      id: "dismiss",
      label: t("followed.dismiss"),
      action: () => {
        void dismissNotification(group.id).then(render)
      },
    })
  }
  if (actions.length === 0) return
  openTitleContextMenu(anchor, actions)
}

// W5 (0.11.10): X on a followed card opens its series actions.
// Controller X reaches here as the "x" key (gamepad.ts
// dispatch-first routing); physical keyboards get it today.
document.addEventListener("keydown", (event) => {
  if (event.key !== "x" && event.key !== "X") return
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target as HTMLElement | null
  if (!target || target === document.body) return
  const tag = target.tagName?.toLowerCase()
  if (tag === "input" || tag === "textarea" || tag === "select") return
  if (target.isContentEditable) return
  if (findOpenModal() || isTitleContextMenuOpen()) return
  const anchor = target.closest?.("[data-couch-key]") as HTMLElement | null
  if (!anchor) return
  const focusKey = anchor.getAttribute("data-couch-key") ?? ""
  if (!focusKey.startsWith("sub:") && !focusKey.startsWith("new:")) return
  event.preventDefault()
  openFollowedMenu(anchor, focusKey)
})

document.addEventListener(FOLLOWED_CHANGED_EVENT, () => void render())
document.addEventListener(FOLLOWED_NOTIFICATIONS_EVENT, () => void render())

// W5 (0.11.10): controller contract — logical view + hints (Y is the
// global gamepad search binding, hinted as Search), provenance, and
// the one-level Back step (confirmations own B first via their
// native dialogs and CONFIRM_DIALOG layer).
setLogicalView("followed")
setControllerHints({
  id: "followed",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Select" },
    { glyph: "b", label: "Back" },
    { glyph: "x", label: "Actions" },
    { glyph: "y", label: "Search" },
    { glyph: "menu", label: "Settings" },
    RETURN_HOME_HINT,
  ],
})
recordOriginFromReferrer()
initListFocusMemory(document, "/followed")
registerBackLayer({
  id: "followed-root",
  priority: BACK_PRIORITY.ROUTE,
  isActive: () => !findOpenModal() && !isTitleContextMenuOpen(),
  handle: () => {
    navigateBackWithOrigin("/")
    return true
  },
})

// W1 image fallback for the runtime-built posters (capture-phase error
// handler; idempotent, safe to arm once per page load).
armTvImageFallbacks(document)

// Sports Corner entry card (0.11.13, plan §5.1): one section above
// New Episodes, fed by the SAME memoised scan as the hub. The card
// never triggers an EPG load — if no EPG state exists it shows its
// loading line and waits for xt:epg-loaded. No playlist → the
// section stays hidden (the page's existing empty handling covers
// it). The card does not join the X menu; its actions are its own
// buttons.
async function mountSportsEntryCard(): Promise<void> {
  const section = document.querySelector<HTMLElement>(
    "[data-sports-entry-section]",
  )
  const container = document.querySelector<HTMLElement>(
    "[data-sports-entry-card]",
  )
  if (!section || !container) return
  let playlistId = ""
  let channels: SportsScanChannel[] = []
  let overrides: Record<string, string> = {}
  let scanResult: SportsScanResult | null = null
  let epgFailed = false

  const renderCard = (): void => {
    const state = playlistId ? getProgrammesSync(playlistId) : null
    const model = buildSportsEntryCardModel(
      isSportsTeamFollowed(),
      playlistId !== "",
      state ? "ready" : epgFailed ? "failed" : "loading",
      scanResult,
      Date.now(),
    )
    section.hidden = !model.hasPlaylist
    const callbacks = createSportsHubCallbacks(playlistId, "/followed")
    renderSportsEntryCard(container, model, {
      onWatchLive: (fixture) => callbacks.onWatch(fixture),
      onToggleFollow: () => callbacks.onToggleFollow(),
    })
  }

  const scan = (): void => {
    if (!playlistId || !isSportsTeamFollowed()) return
    try {
      const state = getProgrammesSync(playlistId)
      scanResult = state
        ? getSportsScan(channels, state, overrides, playlistId)
        : null
    } catch (err) {
      log.warn("[xt:sports] entry-card scan failed:", err)
      scanResult = null
    }
  }

  document.addEventListener(EPG_LOADED_EVENT, () => {
    epgFailed = false
    scan()
    renderCard()
  })
  document.addEventListener(EPG_SOURCE_STATUS_EVENT, (event) => {
    const detail = (event as CustomEvent)?.detail ?? {}
    if (
      detail.playlistId &&
      playlistId &&
      detail.playlistId !== playlistId
    ) {
      return
    }
    const sources = Array.isArray(detail.sources) ? detail.sources : []
    if (sources.length === 0) return
    const allFailed = sources.every(
      (source) => source && source.status === "error",
    )
    if (allFailed === epgFailed) return
    epgFailed = allFailed
    renderCard()
  })
  document.addEventListener(SPORTS_FOLLOW_CHANGED_EVENT, () => {
    scan()
    renderCard()
  })

  try {
    const entry = await getActiveEntry()
    if (!entry?._id) return
    playlistId = String(entry._id)
    const rawChannels = readCachedLiveChannels(playlistId)
    channels = (Array.isArray(rawChannels) ? rawChannels : []).filter(
      (channel): channel is SportsScanChannel =>
        channel != null && channel.id != null,
    )
    overrides = {}
    for (const channel of channels) {
      try {
        const override = getChannelEpgOverride(playlistId, channel.id)
        if (override) overrides[String(channel.id)] = override
      } catch {
        // No override for this channel; resolution falls through.
      }
    }
    scan()
    renderCard()
  } catch (err) {
    log.warn("[xt:sports] entry-card mount failed:", err)
  }
}

void render()
void mountSportsEntryCard()
