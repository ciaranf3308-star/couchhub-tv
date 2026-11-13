// Sports Corner hub — Followed > Manchester United (0.11.13, plan §5–§7).
//
// The hub is a derived view: every render recomputes from the
// current EPG state through the shared scan module. No fixture data
// is stored, no EPG ingestion changes, no playback changes. Tune-in
// is a deep link into the existing Live TV autoplay path (§7); the
// Back return from a tune is the guarded §7.4 origin fix.
//
// This module has NO side effects on import: the .astro page calls
// mountSportsHubPage() explicitly, so the render/controller helpers
// stay independently testable. The Followed page imports only the
// entry-card renderer from here.

import {
  BACK_PRIORITY,
  registerBackLayer,
} from "@/scripts/lib/back-handler.js"
import {
  RETURN_HOME_HINT,
  setControllerHints,
  type HintConfig,
} from "@/scripts/lib/couch-button-hints.js"
import { setLogicalView } from "@/scripts/lib/couch-focus.js"
import {
  captureFocusKeyWithin,
  initListFocusMemory,
  restoreFocusKeyWithin,
  restoreListFocus,
} from "@/scripts/lib/couch-list-focus.js"
import {
  catchupBadgeLabel,
} from "@/scripts/lib/couch-livetv-epg.js"
import {
  displayedToUtcMs,
  EPG_LOADED_EVENT,
  EPG_SOURCE_STATUS_EVENT,
  getProgrammesSync,
  loadProgrammes,
} from "@/scripts/lib/epg-data.js"
import {
  getActiveEntry,
  loadCreds,
} from "@/scripts/lib/creds.js"
import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.js"
import {
  enrichProgramme,
  pickArtworkUrl,
} from "@/scripts/lib/livetv-enrichment.js"
import {
  isTitleContextMenuOpen,
  openTitleContextMenu,
  type TitleContextAction,
} from "@/scripts/lib/poster-menu.js"
import { getChannelEpgOverride } from "@/scripts/lib/preferences.js"
import {
  navigateBackWithOrigin,
  recordOriginFromReferrer,
  recordRouteOrigin,
} from "@/scripts/lib/route-origin.js"
import { findOpenModal } from "@/scripts/lib/dialog-spatial-nav.js"
import { toast } from "@/scripts/lib/toast.js"
import {
  isSportsTeamFollowed,
  followSportsTeam,
  unfollowSportsTeam,
  SPORTS_FOLLOW_CHANGED_EVENT,
  SPORTS_FOLLOWED_TEAM_NAME,
} from "@/scripts/lib/sports-follow.js"
import {
  fixtureCatchupAction,
  getSportsScan,
  selectNextFixture,
  splitSportsFixtures,
  sportsFixtureState,
  type SportsFixture,
  type SportsScanChannel,
  type SportsScanResult,
  type SplitSportsFixtures,
} from "@/scripts/lib/sports-fixture-scan.js"

export const SPORTS_HUB_ROUTE = "/followed/sports"

// ── Controller hints (plan §6.3) ────────────────────────────────
// Mirrors the Followed page's hint shape. LB/RB are unmapped and
// deliberately NOT hinted; Y is unconsumed here so the global
// search handler owns it.

export const SPORTS_HUB_HINTS: HintConfig = {
  id: "followed-sports",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Watch" },
    { glyph: "b", label: "Back" },
    { glyph: "x", label: "Actions" },
    { glyph: "y", label: "Search" },
    { glyph: "menu", label: "Settings" },
    RETURN_HOME_HINT,
  ],
}

// ── View model (pure; plan §2.5 + §5.2) ─────────────────────────

export type SportsHubState =
  | "unfollowed"
  | "no-playlist"
  | "no-channels"
  | "loading"
  | "failed"
  | "no-mapping"
  | "ready"

export interface SportsHubModel {
  state: SportsHubState
  followed: boolean
  /** EPG failed but last-good fixtures are shown (§2.5 keep-last-good). */
  stale: boolean
  hero: SportsFixture | null
  split: SplitSportsFixtures
  /** "Last updated HH:MM" from the EPG revision time, when known. */
  lastUpdatedLabel: string | null
  mappedChannelCount: number
  channelCount: number
}

const EMPTY_SPLIT: SplitSportsFixtures = {
  upcoming: [],
  possible: [],
  otherSquadsUpcoming: [],
  otherSquadsRecent: [],
  recent: [],
}

export interface SportsHubModelInput {
  followed: boolean
  hasPlaylist: boolean
  hasChannels: boolean
  /** "loading" = first load in flight; "failed" = every source
   *  errored on the last attempt; "ready" = a clean load landed. */
  epgStatus: "loading" | "failed" | "ready"
  scanResult: SportsScanResult | null
  nowMs: number
}

/**
 * Fixed state precedence, mirroring the Guide's guideDataState
 * discipline: unfollowed > no-playlist > no-channels > failed >
 * loading > no-mapping > ready. A failed load with last-good data
 * renders ready + stale, never the failure panel.
 */
export function buildSportsHubModel(input: SportsHubModelInput): SportsHubModel {
  const { followed, hasPlaylist, hasChannels, epgStatus, scanResult } = input
  const base: SportsHubModel = {
    state: "loading",
    followed,
    stale: false,
    hero: null,
    split: EMPTY_SPLIT,
    lastUpdatedLabel: null,
    mappedChannelCount: scanResult?.mappedChannelCount ?? 0,
    channelCount: scanResult?.channelCount ?? 0,
  }
  if (!followed) return { ...base, state: "unfollowed" }
  if (!hasPlaylist) return { ...base, state: "no-playlist" }
  if (!hasChannels) return { ...base, state: "no-channels" }
  if (scanResult === null) {
    return {
      ...base,
      state: epgStatus === "failed" ? "failed" : "loading",
    }
  }
  const split = splitSportsFixtures(scanResult.fixtures, input.nowMs)
  const model: SportsHubModel = {
    ...base,
    split,
    hero: selectNextFixture(scanResult.fixtures, input.nowMs),
    lastUpdatedLabel: formatLastUpdated(scanResult),
  }
  if (scanResult.mappedChannelCount === 0) {
    return { ...model, state: "no-mapping" }
  }
  return {
    ...model,
    state: "ready",
    stale: epgStatus === "failed",
  }
}

function formatLastUpdated(scanResult: SportsScanResult): string | null {
  const ms = scanResult.epgFetchedAt ?? Date.parse(scanResult.scannedAt)
  if (!Number.isFinite(ms)) return null
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms))
}

// ── Time formatting ─────────────────────────────────────────────

export function formatKickoff(startMs: number, nowMs: number): string {
  const start = new Date(startMs)
  const now = new Date(nowMs)
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(start)
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  if (startDay === today) return `Today ${time}`
  if (startDay === today + dayMs) return `Tomorrow ${time}`
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(start)
  return `${date} ${time}`
}

// ── Tune-in deep links (plan §7, pure + testable) ───────────────

export interface TuneTarget {
  url: string
}

/**
 * Live tune: /livetv?channel=<numeric id>. The Live TV autoplay
 * path parses the id with Number() and silently ignores a
 * non-finite value, so a non-numeric provider id must never reach
 * it — the caller navigates to the landing + toast instead (§7.1).
 */
export function buildLiveTuneUrl(fixture: SportsFixture): TuneTarget | null {
  const id = Number(fixture.channelId)
  if (!Number.isFinite(id)) return null
  return { url: `/livetv?channel=${encodeURIComponent(String(fixture.channelId))}` }
}

/**
 * Catch-up tune: the epg.ts navigateToCatchup shape exactly —
 * displayed times converted to UTC, ctitle encoded, NO cid (the
 * player re-resolves the catch-up id from the channel, plan §7.1).
 * Raw (pre-tvg-shift) programme times are the input, as the Guide
 * does. Returns null when the channel id is not numeric.
 */
export function buildCatchupTuneUrl(
  fixture: SportsFixture,
  playlistId: string,
): TuneTarget | null {
  const id = Number(fixture.channelId)
  if (!Number.isFinite(id)) return null
  const startUtc = displayedToUtcMs(
    playlistId,
    fixture.rawStartMs ?? fixture.startMs,
  )
  const stopUtc = displayedToUtcMs(
    playlistId,
    fixture.rawStopMs ?? fixture.stopMs,
  )
  return {
    url:
      `/livetv?channel=${encodeURIComponent(String(fixture.channelId))}` +
      `&cstart=${startUtc}` +
      `&cstop=${stopUtc}` +
      `&ctitle=${encodeURIComponent(fixture.title)}`,
  }
}

export const GUIDE_ROOT_URL = "/livetv?mode=guide"

/**
 * The row's primary (A-button) action. Upcoming/live rows watch
 * live; past rows replay when catch-up allows; a past row with no
 * replay opens the Guide — the only remaining useful action, and
 * the row's action label names it honestly.
 */
export type FixturePrimaryAction = "watch" | "replay" | "guide"

export function fixturePrimaryAction(
  fixture: SportsFixture,
  nowMs: number = Date.now(),
): FixturePrimaryAction {
  const state = sportsFixtureState(fixture, nowMs)
  if (state !== "past") return "watch"
  return fixtureCatchupAction(fixture, nowMs) === "replay"
    ? "replay"
    : "guide"
}

export function fixtureActionLabel(
  fixture: SportsFixture,
  nowMs: number = Date.now(),
): string {
  const action = fixturePrimaryAction(fixture, nowMs)
  if (action === "replay") return "Replay"
  if (action === "guide") return "Open in Guide"
  return sportsFixtureState(fixture, nowMs) === "now" ? "Watch live" : "Watch"
}

// ── Navigation callbacks ────────────────────────────────────────

export interface SportsHubCallbacks {
  /** Tune the fixture live (§7.1). Records the §7.4 return origin. */
  onWatch: (fixture: SportsFixture) => void
  /** Watch a live fixture from its start (§7.3). */
  onWatchFromStart: (fixture: SportsFixture) => void
  /** Replay a past fixture (§7.3). */
  onReplay: (fixture: SportsFixture) => void
  /** Open the Guide root (§5.3). */
  onOpenGuide: () => void
  /** Toggle the follow record (§5.4). */
  onToggleFollow: () => void
}

/** Production navigation: record the return origin, then go. The
 *  origin is what §7.4 consults when B is pressed on the landing. */
export function createSportsHubCallbacks(
  playlistId: string,
  returnRoute: string,
): SportsHubCallbacks {
  const tune = (target: TuneTarget | null) => {
    if (!target) {
      toast({
        title: "Couldn't open that channel",
        description: "This channel can't be tuned directly. Opening Live TV instead.",
      })
      window.location.href = "/livetv"
      return
    }
    recordRouteOrigin({ route: returnRoute })
    window.location.href = target.url
  }
  return {
    onWatch: (fixture) => tune(buildLiveTuneUrl(fixture)),
    onWatchFromStart: (fixture) => tune(buildCatchupTuneUrl(fixture, playlistId)),
    onReplay: (fixture) => tune(buildCatchupTuneUrl(fixture, playlistId)),
    onOpenGuide: () => {
      window.location.href = GUIDE_ROOT_URL
    },
    onToggleFollow: () => {
      if (isSportsTeamFollowed()) {
        unfollowSportsTeam()
        toast({ title: `Unfollowed ${SPORTS_FOLLOWED_TEAM_NAME}` })
      } else {
        followSportsTeam()
        toast({ title: `Following ${SPORTS_FOLLOWED_TEAM_NAME}` })
      }
    },
  }
}

// ── DOM helpers ─────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function fixtureMetaLine(
  fixture: SportsFixture,
  nowMs: number,
): string {
  const parts = [
    formatKickoff(fixture.startMs, nowMs),
    fixture.channelName,
  ]
  if (fixture.competition) parts.push(fixture.competition)
  return parts.join(" · ")
}

function alsoOnLine(fixture: SportsFixture): string | null {
  if (fixture.alsoOn.length === 0) return null
  return `Also on: ${fixture.alsoOn.map((c) => c.channelName).join(", ")}`
}

// ── Row + section rendering ─────────────────────────────────────

interface RowContext {
  nowMs: number
  callbacks: SportsHubCallbacks
  /** "possible" rows carry the Unconfirmed-team badge. */
  showPossibleBadge: boolean
}

function buildFixtureRow(
  fixture: SportsFixture,
  ctx: RowContext,
): HTMLButtonElement {
  const row = el("button", "rs-sports-row")
  row.type = "button"
  row.setAttribute("data-couch-key", `sports:fixture:${fixture.id}`)
  row.setAttribute("data-fixture-id", fixture.id)
  const state = sportsFixtureState(fixture, ctx.nowMs)

  const main = el("div", "rs-sports-row-main")
  const titleRow = el("div", "rs-sports-row-title-row")
  titleRow.appendChild(el("span", "rs-sports-row-title", fixture.title))
  if (state === "now") {
    titleRow.appendChild(el("span", "rs-sports-badge rs-sports-badge-live", "LIVE"))
  }
  if (ctx.showPossibleBadge) {
    titleRow.appendChild(
      el("span", "rs-sports-badge rs-sports-badge-possible", "Unconfirmed team"),
    )
  }
  main.appendChild(titleRow)
  main.appendChild(el("div", "rs-sports-row-meta", fixtureMetaLine(fixture, ctx.nowMs)))
  const alsoOn = alsoOnLine(fixture)
  if (alsoOn) {
    main.appendChild(el("div", "rs-sports-row-also", alsoOn))
  }
  if (fixture.desc) {
    const desc = el("div", "rs-sports-row-desc", fixture.desc)
    main.appendChild(desc)
  }
  row.appendChild(main)

  const action = el("div", "rs-sports-row-action")
  action.appendChild(
    el("span", "rs-sports-row-action-label", fixtureActionLabel(fixture, ctx.nowMs)),
  )
  if (state === "past") {
    const catchup = fixtureCatchupAction(fixture, ctx.nowMs)
    const badge = catchupBadgeLabel(catchup)
    if (badge) {
      action.appendChild(el("span", "rs-sports-row-catchup", badge))
    }
  }
  row.appendChild(action)

  row.addEventListener("click", () => {
    const primary = fixturePrimaryAction(fixture, Date.now())
    if (primary === "watch") ctx.callbacks.onWatch(fixture)
    else if (primary === "replay") ctx.callbacks.onReplay(fixture)
    else ctx.callbacks.onOpenGuide()
  })
  return row
}

function buildSection(
  heading: string,
  explainer: string | null,
  rows: SportsFixture[],
  ctx: RowContext,
  emptyLine: string | null,
): HTMLElement | null {
  if (rows.length === 0 && emptyLine === null) return null
  const section = el("section", "rs-sports-section")
  section.appendChild(el("h2", "rs-sports-section-title", heading))
  if (explainer) {
    section.appendChild(el("p", "rs-sports-section-note", explainer))
  }
  if (rows.length === 0 && emptyLine !== null) {
    section.appendChild(el("p", "rs-sports-empty-line", emptyLine))
    return section
  }
  const list = el("div", "rs-sports-list")
  for (const fixture of rows) list.appendChild(buildFixtureRow(fixture, ctx))
  section.appendChild(list)
  return section
}

function buildOtherSquadsSection(
  upcoming: SportsFixture[],
  recent: SportsFixture[],
  ctx: RowContext,
): HTMLElement | null {
  if (upcoming.length === 0 && recent.length === 0) return null
  const section = el("section", "rs-sports-section")
  section.appendChild(el("h2", "rs-sports-section-title", "Other Squads"))
  section.appendChild(
    el(
      "p",
      "rs-sports-section-note",
      "Women's, youth and academy fixtures, kept separate from the first team.",
    ),
  )
  const upcomingList = el("div", "rs-sports-list")
  for (const fixture of upcoming) {
    upcomingList.appendChild(buildFixtureRow(fixture, ctx))
  }
  section.appendChild(upcomingList)
  if (recent.length > 0) {
    section.appendChild(el("h3", "rs-sports-subhead", "Recent"))
    const recentList = el("div", "rs-sports-list")
    for (const fixture of recent) {
      recentList.appendChild(buildFixtureRow(fixture, ctx))
    }
    section.appendChild(recentList)
  }
  return section
}

// ── Hero ────────────────────────────────────────────────────────

function buildHero(
  fixture: SportsFixture,
  ctx: RowContext,
): HTMLElement {
  const hero = el("section", "rs-sports-hero")
  hero.setAttribute("data-fixture-id", fixture.id)
  const body = el("div", "rs-sports-hero-body")
  body.appendChild(el("p", "rs-sports-hero-eyebrow", "Next match"))
  body.appendChild(el("h2", "rs-sports-hero-title", fixture.title))
  body.appendChild(
    el("p", "rs-sports-hero-meta", fixtureMetaLine(fixture, ctx.nowMs)),
  )
  const alsoOn = alsoOnLine(fixture)
  if (alsoOn) {
    body.appendChild(el("p", "rs-sports-hero-also", alsoOn))
  }
  if (fixture.desc) {
    body.appendChild(el("p", "rs-sports-hero-desc", fixture.desc))
  }
  const watch = el(
    "button",
    "rs-sports-hero-watch",
    fixtureActionLabel(fixture, ctx.nowMs),
  )
  watch.type = "button"
  watch.setAttribute("data-couch-key", "sports:hero:watch")
  watch.setAttribute("data-fixture-id", fixture.id)
  watch.addEventListener("click", () => {
    ctx.callbacks.onWatch(fixture)
  })
  body.appendChild(watch)
  hero.appendChild(body)
  return hero
}

/**
 * Hero artwork only (§10): one enrichment call for the hero
 * fixture, backdrop variant. Rows carry no artwork calls. A null
 * URL leaves the branded gradient fallback untouched — never a
 * stretched logo, never a broken image.
 */
export async function applyHeroArtwork(
  heroElement: HTMLElement,
  fixture: SportsFixture,
): Promise<string | null> {
  try {
    const art = await enrichProgramme({
      title: fixture.title,
      channelName: fixture.channelName,
      startMs: fixture.startMs,
      endMs: fixture.stopMs,
      category: fixture.channelCategory,
      channelLogoUrl: fixture.channelLogo,
    })
    const url = pickArtworkUrl(art, "backdrop")
    if (!url) return null
    if (!heroElement.isConnected) return null
    if (heroElement.getAttribute("data-fixture-id") !== fixture.id) return null
    heroElement.style.setProperty("--rs-sports-hero-art", `url("${url}")`)
    heroElement.classList.add("rs-sports-hero-has-art")
    return url
  } catch {
    return null
  }
}

// ── Hub render ──────────────────────────────────────────────────

export interface SportsHubRoot {
  headerMeta: HTMLElement | null
  staleNote: HTMLElement | null
  followButton: HTMLButtonElement | null
  content: HTMLElement
  states: HTMLElement
}

export function querySportsHubRoot(
  root: ParentNode,
): SportsHubRoot | null {
  const content = root.querySelector<HTMLElement>("[data-sports-hub-content]")
  const states = root.querySelector<HTMLElement>("[data-sports-hub-states]")
  if (!content || !states) return null
  return {
    headerMeta: root.querySelector<HTMLElement>("[data-sports-hub-meta]"),
    staleNote: root.querySelector<HTMLElement>("[data-sports-hub-stale]"),
    followButton: root.querySelector<HTMLButtonElement>(
      "[data-sports-hub-follow]",
    ),
    content,
    states,
  }
}

const HUB_STATE_COPY: Record<
  Exclude<SportsHubState, "ready" | "unfollowed">,
  { title: string; message: string }
> = {
  "no-playlist": {
    title: "No playlist added",
    message: "Add a playlist to see Manchester United fixtures here.",
  },
  "no-channels": {
    title: "Channels haven't loaded yet",
    message:
      "Open Live TV once to load your channels, then come back here.",
  },
  loading: {
    title: "Loading the programme guide…",
    message: "Fixtures from your programme guide will appear here.",
  },
  failed: {
    title: "The programme guide couldn't be loaded",
    message:
      "Check the connection and try again — no listings are shown rather than guessed ones.",
  },
  "no-mapping": {
    title: "No programme data matched",
    message:
      "None of your channels matched programme data, so there is nothing to list here.",
  },
}

function renderStateBlock(
  statesEl: HTMLElement,
  state: Exclude<SportsHubState, "ready" | "unfollowed">,
): void {
  const copy = HUB_STATE_COPY[state]
  const block = el("div", "rs-sports-state")
  block.appendChild(el("h2", "rs-sports-state-title", copy.title))
  block.appendChild(el("p", "rs-sports-state-message", copy.message))
  if (state === "no-playlist") {
    const link = el("a", "rs-sports-state-action", "Add a playlist")
    link.setAttribute("href", "/login")
    block.appendChild(link)
  }
  statesEl.replaceChildren(block)
}

function renderFollowCta(
  statesEl: HTMLElement,
  callbacks: SportsHubCallbacks,
): void {
  const block = el("div", "rs-sports-state")
  block.appendChild(
    el("h2", "rs-sports-state-title", `Follow ${SPORTS_FOLLOWED_TEAM_NAME}`),
  )
  block.appendChild(
    el(
      "p",
      "rs-sports-state-message",
      "Follow Manchester United to see every match in your programme guide — station, kick-off and tune-in, ready when you open this corner.",
    ),
  )
  const button = el("button", "rs-sports-state-action", "Follow")
  button.type = "button"
  button.setAttribute("data-couch-key", "sports:follow")
  button.addEventListener("click", () => callbacks.onToggleFollow())
  block.appendChild(button)
  statesEl.replaceChildren(block)
}

/**
 * Render the hub from a view model. The state blocks live in the
 * static shell; this function owns the dynamic content region and
 * the header meta/follow button. Focus is preserved across
 * re-renders via the focus-key capture/restore pair.
 */
export function renderSportsHub(
  root: SportsHubRoot,
  model: SportsHubModel,
  callbacks: SportsHubCallbacks,
  nowMs: number = Date.now(),
): void {
  const followed = model.followed
  if (root.followButton) {
    root.followButton.textContent = followed ? "Unfollow" : "Follow"
    root.followButton.setAttribute(
      "data-couch-key",
      followed ? "sports:unfollow" : "sports:follow",
    )
  }
  if (root.headerMeta) {
    root.headerMeta.textContent =
      model.lastUpdatedLabel !== null
        ? `Fixtures from your programme guide · Last updated ${model.lastUpdatedLabel}`
        : "Fixtures from your programme guide"
  }
  if (root.staleNote) {
    root.staleNote.hidden = !model.stale
  }

  const focusKey = captureFocusKeyWithin(document, [root.content, root.states])

  if (model.state === "unfollowed") {
    root.content.replaceChildren()
    renderFollowCta(root.states, callbacks)
    restoreFocusKeyWithin(document, focusKey, root.states)
    return
  }
  if (model.state !== "ready") {
    root.content.replaceChildren()
    renderStateBlock(root.states, model.state)
    restoreFocusKeyWithin(document, focusKey, root.states)
    return
  }
  root.states.replaceChildren()

  const ctx: RowContext = { nowMs, callbacks, showPossibleBadge: false }
  const fragment = document.createDocumentFragment()
  if (model.hero) {
    fragment.appendChild(buildHero(model.hero, ctx))
  }
  const { upcoming, possible, otherSquadsUpcoming, otherSquadsRecent, recent } =
    model.split
  const hasAnyFixture =
    upcoming.length > 0 ||
    possible.length > 0 ||
    otherSquadsUpcoming.length > 0 ||
    otherSquadsRecent.length > 0 ||
    recent.length > 0
  if (!hasAnyFixture) {
    const empty = el("div", "rs-sports-state")
    empty.appendChild(
      el(
        "h2",
        "rs-sports-state-title",
        "No Manchester United matches in your programme guide right now",
      ),
    )
    empty.appendChild(
      el(
        "p",
        "rs-sports-state-message",
        "The guide covers about the next day and a half — check back closer to matchday.",
      ),
    )
    fragment.appendChild(empty)
  } else {
    const upcomingSection = buildSection(
      "Upcoming Matches",
      null,
      upcoming,
      ctx,
      "No upcoming matches in the guide right now.",
    )
    if (upcomingSection) fragment.appendChild(upcomingSection)
    const possibleSection = buildSection(
      "Possible Matches",
      "These titles say 'United' without naming the club.",
      possible,
      { ...ctx, showPossibleBadge: true },
      null,
    )
    if (possibleSection) fragment.appendChild(possibleSection)
    const squadsSection = buildOtherSquadsSection(
      otherSquadsUpcoming,
      otherSquadsRecent,
      ctx,
    )
    if (squadsSection) fragment.appendChild(squadsSection)
    const recentSection = buildSection("Recent Matches", null, recent, ctx, null)
    if (recentSection) fragment.appendChild(recentSection)
  }
  root.content.replaceChildren(fragment)
  restoreFocusKeyWithin(document, focusKey, root.content)
}

// ── Fixture context menu (X, plan §5.3) ─────────────────────────

export function fixtureContextActions(
  fixture: SportsFixture,
  callbacks: SportsHubCallbacks,
  nowMs: number = Date.now(),
): TitleContextAction[] {
  const actions: TitleContextAction[] = []
  const state = sportsFixtureState(fixture, nowMs)
  const catchup = fixtureCatchupAction(fixture, nowMs)
  if (state !== "past") {
    actions.push({
      id: "watch",
      label: "Watch",
      action: () => callbacks.onWatch(fixture),
    })
    if (catchup === "watch-from-start") {
      actions.push({
        id: "watch-from-start",
        label: "Watch from start",
        action: () => callbacks.onWatchFromStart(fixture),
      })
    }
  }
  if (state === "past" && catchup === "replay") {
    actions.push({
      id: "replay",
      label: "Replay",
      action: () => callbacks.onReplay(fixture),
    })
  }
  actions.push({
    id: "open-guide",
    label: "Open in Guide",
    action: () => callbacks.onOpenGuide(),
  })
  return actions
}

export function openFixtureContextMenu(
  anchor: HTMLElement,
  fixture: SportsFixture,
  callbacks: SportsHubCallbacks,
): void {
  openTitleContextMenu(anchor, fixtureContextActions(fixture, callbacks))
}

// ── Controller wiring (plan §6) ─────────────────────────────────

export interface SportsHubController {
  destroy: () => void
}

export function installSportsHubController(
  root: HTMLElement,
  fixtures: () => ReadonlyArray<SportsFixture>,
  callbacks: SportsHubCallbacks,
): SportsHubController {
  setLogicalView("followed-sports")
  setControllerHints(SPORTS_HUB_HINTS)
  recordOriginFromReferrer()
  const stopFocusMemory = initListFocusMemory(document, SPORTS_HUB_ROUTE)
  const unregisterBack = registerBackLayer({
    id: "sports-hub-root",
    priority: BACK_PRIORITY.ROUTE,
    isActive: () => !findOpenModal() && !isTitleContextMenuOpen(),
    handle: () => {
      navigateBackWithOrigin("/followed")
      return true
    },
  })

  // Controller X reaches here as the "x" key (gamepad.ts maps the
  // button), mirroring the Followed page's handler. Only fixture
  // rows and the hero Watch button open the menu.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "x" && event.key !== "X") return
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (!target || target === document.body) return
    const tag = target.tagName?.toLowerCase()
    if (tag === "input" || tag === "textarea" || tag === "select") return
    if (target.isContentEditable) return
    if (findOpenModal() || isTitleContextMenuOpen()) return
    const anchor = target.closest?.("[data-fixture-id]") as HTMLElement | null
    if (!anchor || !root.contains(anchor)) return
    const fixtureId = anchor.getAttribute("data-fixture-id")
    const fixture = fixtures().find((candidate) => candidate.id === fixtureId)
    if (!fixture) return
    event.preventDefault()
    openFixtureContextMenu(anchor, fixture, callbacks)
  }
  document.addEventListener("keydown", onKeyDown)

  return {
    destroy: () => {
      document.removeEventListener("keydown", onKeyDown)
      unregisterBack()
      stopFocusMemory()
    },
  }
}

/**
 * Initial focus (plan §6.4 intent): a returning visitor's recorded
 * focus first, else the hero Watch button, else the first Upcoming
 * row, else the Follow/Unfollow control. The Followed page does
 * not seed nav focus, so the hub sets its own explicitly.
 */
export function focusSportsHubInitial(root: ParentNode): void {
  const restored = restoreListFocus(document, SPORTS_HUB_ROUTE, root)
  if (restored) return
  const heroWatch = root.querySelector<HTMLElement>(
    '[data-couch-key="sports:hero:watch"]',
  )
  if (heroWatch) {
    heroWatch.focus({ preventScroll: true })
    return
  }
  const firstRow = root.querySelector<HTMLElement>(
    '[data-couch-key^="sports:fixture:"]',
  )
  if (firstRow) {
    firstRow.focus({ preventScroll: true })
    return
  }
  const followControl = root.querySelector<HTMLElement>(
    '[data-couch-key="sports:follow"], [data-couch-key="sports:unfollow"]',
  )
  followControl?.focus({ preventScroll: true })
}

// ── Entry card (plan §5.1) ──────────────────────────────────────

export interface SportsEntryCardModel {
  followed: boolean
  hasPlaylist: boolean
  /** "loading" = no EPG state yet; "failed" = last load errored. */
  epgStatus: "loading" | "failed" | "ready"
  nextFixture: SportsFixture | null
  hasFixtures: boolean
}

export function buildSportsEntryCardModel(
  followed: boolean,
  hasPlaylist: boolean,
  epgStatus: "loading" | "failed" | "ready",
  scanResult: SportsScanResult | null,
  nowMs: number,
): SportsEntryCardModel {
  return {
    followed,
    hasPlaylist,
    epgStatus,
    nextFixture:
      scanResult !== null
        ? selectNextFixture(scanResult.fixtures, nowMs)
        : null,
    hasFixtures: (scanResult?.fixtures.length ?? 0) > 0,
  }
}

export interface SportsEntryCardCallbacks {
  onWatchLive: (fixture: SportsFixture) => void
  onToggleFollow: () => void
}

export function renderSportsEntryCard(
  container: HTMLElement,
  model: SportsEntryCardModel,
  callbacks: SportsEntryCardCallbacks,
  nowMs: number = Date.now(),
): void {
  container.replaceChildren()
  if (!model.hasPlaylist) {
    container.hidden = true
    return
  }
  container.hidden = false
  const card = el("article", "rs-sports-card")
  const art = el("div", "rs-sports-card-art")
  card.appendChild(art)
  const body = el("div", "rs-sports-card-body")
  body.appendChild(
    el("p", "rs-sports-card-team", SPORTS_FOLLOWED_TEAM_NAME.toUpperCase()),
  )

  if (!model.followed) {
    body.appendChild(
      el(
        "p",
        "rs-sports-card-line",
        "Follow Manchester United to see every match, station and kick-off here.",
      ),
    )
    const follow = el("button", "rs-sports-card-button", "Follow")
    follow.type = "button"
    follow.setAttribute("data-couch-key", "sports:card:follow")
    follow.addEventListener("click", () => callbacks.onToggleFollow())
    body.appendChild(follow)
    card.appendChild(body)
    container.appendChild(card)
    return
  }

  if (model.nextFixture) {
    const fixture = model.nextFixture
    body.appendChild(
      el("p", "rs-sports-card-line", `Next match: ${fixture.title}`),
    )
    body.appendChild(
      el("p", "rs-sports-card-meta", fixtureMetaLine(fixture, nowMs)),
    )
    const actions = el("div", "rs-sports-card-actions")
    const open = el("a", "rs-sports-card-button", "Open Sports Corner")
    open.setAttribute("href", SPORTS_HUB_ROUTE)
    open.setAttribute("data-couch-key", "sports:card:open")
    actions.appendChild(open)
    if (sportsFixtureState(fixture, nowMs) === "now") {
      const watch = el("button", "rs-sports-card-button", "Watch live")
      watch.type = "button"
      watch.setAttribute("data-couch-key", "sports:card:watch")
      watch.addEventListener("click", () => callbacks.onWatchLive(fixture))
      actions.appendChild(watch)
    }
    body.appendChild(actions)
  } else if (model.epgStatus === "failed") {
    body.appendChild(
      el(
        "p",
        "rs-sports-card-line",
        "The programme guide couldn't be loaded.",
      ),
    )
    body.appendChild(sportsCardOpenLink())
  } else if (model.epgStatus === "loading") {
    body.appendChild(
      el("p", "rs-sports-card-line", "Checking the programme guide…"),
    )
    body.appendChild(sportsCardOpenLink())
  } else {
    body.appendChild(
      el(
        "p",
        "rs-sports-card-line",
        "No Manchester United matches in your programme guide right now.",
      ),
    )
    body.appendChild(sportsCardOpenLink())
  }
  card.appendChild(body)
  container.appendChild(card)

  if (model.nextFixture) {
    void applyEntryCardArtwork(art, model.nextFixture)
  }
}

function sportsCardOpenLink(): HTMLAnchorElement {
  const open = el("a", "rs-sports-card-button", "Open Sports Corner")
  open.setAttribute("href", SPORTS_HUB_ROUTE)
  open.setAttribute("data-couch-key", "sports:card:open")
  return open
}

async function applyEntryCardArtwork(
  artEl: HTMLElement,
  fixture: SportsFixture,
): Promise<void> {
  try {
    const art = await enrichProgramme({
      title: fixture.title,
      channelName: fixture.channelName,
      startMs: fixture.startMs,
      endMs: fixture.stopMs,
      category: fixture.channelCategory,
      channelLogoUrl: fixture.channelLogo,
    })
    const url = pickArtworkUrl(art, "backdrop")
    if (!url || !artEl.isConnected) return
    artEl.style.setProperty("--rs-sports-card-art", `url("${url}")`)
    artEl.classList.add("rs-sports-card-art-has-art")
  } catch {
    // Branded placeholder stays. Artwork is decoration, never data.
  }
}

// ── Hub mount (plan §2.4) ───────────────────────────────────────

interface HubRuntime {
  playlistId: string
  channels: SportsScanChannel[]
  overrides: Record<string, string>
  epgStatus: "loading" | "failed" | "ready"
  scanResult: SportsScanResult | null
  pipelineFailed: boolean
  heroArtworkFor: string | null
  timer: ReturnType<typeof setInterval> | null
  /** First resolution pass done — render() waits for this so the
   *  static shell's loading block is never replaced by a wrong
   *  no-playlist flash. */
  resolved: boolean
  /** Playlist resolution attempted while followed (re-follow path). */
  playlistAttempted: boolean
}

export function mountSportsHubPage(): void {
  const shell = document.querySelector<HTMLElement>("[data-sports-hub-shell]")
  if (!shell) return
  const root = querySportsHubRoot(shell)
  if (!root) return

  const runtime: HubRuntime = {
    playlistId: "",
    channels: [],
    overrides: {},
    epgStatus: "loading",
    scanResult: null,
    pipelineFailed: false,
    heroArtworkFor: null,
    timer: null,
    resolved: false,
    playlistAttempted: false,
  }

  let callbacks: SportsHubCallbacks | null = null
  let controller: SportsHubController | null = null
  let mounted = true

  const currentFixtures = (): ReadonlyArray<SportsFixture> =>
    runtime.scanResult?.fixtures ?? []

  function render(): void {
    if (!mounted || !runtime.resolved) return
    const followed = isSportsTeamFollowed()
    const model = buildSportsHubModel({
      followed,
      hasPlaylist: runtime.playlistId !== "",
      hasChannels: runtime.channels.length > 0,
      epgStatus:
        runtime.pipelineFailed && runtime.scanResult === null
          ? "failed"
          : runtime.epgStatus,
      scanResult: followed ? runtime.scanResult : null,
      nowMs: Date.now(),
    })
    const activeCallbacks =
      callbacks ??
      createSportsHubCallbacks(runtime.playlistId, SPORTS_HUB_ROUTE)
    renderSportsHub(root!, model, activeCallbacks)
    if (model.hero && model.hero.id !== runtime.heroArtworkFor) {
      runtime.heroArtworkFor = model.hero.id
      const heroEl = shell!.querySelector<HTMLElement>(".rs-sports-hero")
      if (heroEl) void applyHeroArtwork(heroEl, model.hero)
    }
    if (!controller) {
      controller = installSportsHubController(
        shell!,
        currentFixtures,
        activeCallbacks,
      )
      focusSportsHubInitial(shell!)
    }
  }

  function scan(): void {
    if (!mounted || runtime.playlistId === "") return
    // Unfollowed: no scan runs (§2.5). The memoised result from a
    // previous followed session stays cached for instant re-follow.
    if (!isSportsTeamFollowed()) return
    try {
      const state = getProgrammesSync(runtime.playlistId)
      if (!state) {
        runtime.scanResult = null
        return
      }
      runtime.scanResult = getSportsScan(
        runtime.channels,
        state,
        runtime.overrides,
        runtime.playlistId,
      )
      runtime.pipelineFailed = false
    } catch {
      // A corrupt channel entry must not blank the hub: keep the
      // last-good scan and surface the failure signal instead.
      runtime.pipelineFailed = true
    }
  }

  async function resolvePlaylist(): Promise<void> {
    try {
      // Unfollowed: the CTA needs no playlist, no channels, no EPG
      // load. Resolve nothing; re-follow re-enters here.
      if (!isSportsTeamFollowed()) {
        runtime.resolved = true
        render()
        return
      }
      runtime.playlistAttempted = true
      const entry = await getActiveEntry()
      if (!mounted) return
      runtime.resolved = true
      if (!entry?._id) {
        runtime.playlistId = ""
        render()
        return
      }
      runtime.playlistId = String(entry._id)
      callbacks = createSportsHubCallbacks(
        runtime.playlistId,
        SPORTS_HUB_ROUTE,
      )
      const rawChannels = readCachedLiveChannels(runtime.playlistId)
      runtime.channels = (Array.isArray(rawChannels) ? rawChannels : []).filter(
        (channel): channel is SportsScanChannel =>
          channel != null && channel.id != null,
      )
      runtime.overrides = {}
      for (const channel of runtime.channels) {
        try {
          const override = getChannelEpgOverride(
            runtime.playlistId,
            channel.id,
          )
          if (override) runtime.overrides[String(channel.id)] = override
        } catch {
          // No override for this channel; resolution falls through.
        }
      }
      if (runtime.channels.length === 0) {
        render()
        return
      }
      const state = getProgrammesSync(runtime.playlistId)
      if (state) {
        runtime.epgStatus = "ready"
        scan()
        render()
        return
      }
      // No state yet: trigger the load (hub only — the Followed
      // entry card never triggers one), render loading, re-render
      // on xt:epg-loaded.
      render()
      try {
        const creds = await loadCreds()
        if (!mounted) return
        await loadProgrammes(runtime.playlistId, creds)
      } catch {
        // The source-status event carries the failure signal; a
        // throw here alone must not fake a failure state.
      }
    } catch {
      runtime.pipelineFailed = true
      runtime.resolved = true
      render()
    }
  }

  document.addEventListener(EPG_LOADED_EVENT, () => {
    if (!mounted) return
    runtime.epgStatus = "ready"
    scan()
    render()
  })
  document.addEventListener(EPG_SOURCE_STATUS_EVENT, (event) => {
    if (!mounted) return
    const detail = (event as CustomEvent)?.detail ?? {}
    if (
      detail.playlistId &&
      runtime.playlistId &&
      detail.playlistId !== runtime.playlistId
    ) {
      return
    }
    const sources = Array.isArray(detail.sources) ? detail.sources : []
    if (sources.length === 0) return
    const allFailed = sources.every(
      (source) => source && source.status === "error",
    )
    if (allFailed === (runtime.epgStatus === "failed")) return
    runtime.epgStatus = allFailed ? "failed" : "ready"
    render()
  })
  document.addEventListener(SPORTS_FOLLOW_CHANGED_EVENT, () => {
    if (!mounted) return
    // Re-follow after an unfollowed mount: the playlist was never
    // resolved, so resolve now. Otherwise the memoised scan is
    // reused — nothing was deleted (§3.1).
    if (isSportsTeamFollowed() && !runtime.playlistAttempted) {
      void resolvePlaylist()
      return
    }
    render()
  })

  // 60-second timer: re-derive row states from the clock without
  // re-scanning (§2.4). Re-render only when a boundary crossed —
  // cheap check on the memoised fixture list.
  let lastStateSignature = ""
  runtime.timer = setInterval(() => {
    if (!mounted) return
    const nowMs = Date.now()
    const signature = (runtime.scanResult?.fixtures ?? [])
      .map(
        (fixture) =>
          `${fixture.id}:${sportsFixtureState(fixture, nowMs)}:${fixtureCatchupAction(fixture, nowMs)}`,
      )
      .join("|")
    if (signature === lastStateSignature) return
    lastStateSignature = signature
    render()
  }, 60_000)

  const followButton = root.followButton
  followButton?.addEventListener("click", () => {
    const active =
      callbacks ?? createSportsHubCallbacks(runtime.playlistId, SPORTS_HUB_ROUTE)
    active.onToggleFollow()
  })

  void resolvePlaylist()
}
