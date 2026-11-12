// Couch Series Home controller (0.11.8, W4) — mount entry for the
// standalone /series page.
//
// TWO MODES, ONE NAV ITEM (brief §1.1, §2): Series Home (shelves,
// this module) and Series → Browse Everything (W2's mount contract,
// via the catalog shim on this branch). The mode lives in the URL
// (parseModeFromUrl / setModeInUrl), so a return from a detail page
// restores mode + category + page through browser history, and the
// selected poster restores through the existing focus memory
// (couch-focus.ts, by stable data-couch-key). Series Home NEVER
// mounts the full catalogue grid: the browse controller mounts only
// when browse mode is entered.
//
// LIVE UPDATES WITHOUT RESTART: Followed changes
// (FOLLOWED_CHANGED_EVENT / FOLLOWED_NOTIFICATIONS_EVENT) and
// progress changes (PROGRESS_CHANGED_EVENT) coalesce into one
// re-render from cached data — unfollowing a series updates the
// New Episodes / Followed shelves in place, with no polling and no
// full restart. Async loads are generation-guarded so a stale
// response can never paint over newer state.
//
// CONTROLLER: no input handling lives here. Shelves use the
// data-nylah-rail / data-nylah-item contract, so the shared XInput
// action pipeline (gamepad.ts + couch-focus.ts) drives everything.
// LB/RB shelf jumping needs a gamepad.ts seam (read-only for W4) and
// is flagged for integration — D-pad U/D between shelves is the
// shelf navigation on this branch.

import { getCached } from "@/scripts/lib/cache.js";
import { restoreCouchFocus } from "@/scripts/lib/couch-focus.ts";
import {
  FOLLOWED_CHANGED_EVENT,
  FOLLOWED_NOTIFICATIONS_EVENT,
  listNotificationGroups,
  listSubscriptions,
  type FollowedNotificationGroup,
  type FollowedSubscription,
} from "@/scripts/lib/followed.ts";
import {
  ensureLoaded as ensurePrefsLoaded,
  getContinueWatching,
  getSeriesEpisodeProgress,
  getSeriesProgressSummary,
  isCompleted,
  PROGRESS_CHANGED_EVENT,
} from "@/scripts/lib/preferences.js";
import {
  getCatalogIndex,
  mountBrowseEverything,
  type BrowseEverythingHandle,
  type SeriesCatalogIndex,
} from "@/scripts/series/series-home-catalog-shim.ts";
import {
  parseModeFromUrl,
  setModeInUrl,
  type BrowseModeParams,
  type HomeBrowseMode,
} from "@/scripts/series/series-home-shims.ts";
import {
  assembleSeriesHomeSections,
  cachedSeasonGroup,
  type ContinueWatchingInput,
  type SeriesHomeProgressEntry,
  type SeriesHomeSection,
} from "@/scripts/series/series-home-model.ts";
import {
  renderSeriesHome,
  renderSeriesHomeState,
} from "@/scripts/series/series-home-render.ts";
import type { EpisodeProgress, SeriesRow } from "@/scripts/series/couch-series.ts";

// getContinueWatching's JSDoc union does not surface the episode
// extras Series Home needs (seriesId/season/episodeNum) to the
// checker; read them through this structural view instead of
// widening shared types W4 does not own.
interface ContinueEntryView {
  kind: string;
  id: string | number;
  position?: number;
  duration?: number;
  completed?: boolean;
  updatedAt?: number;
  seriesId?: number | string | null;
  season?: number | string | null;
  episodeNum?: number | string | null;
  episodeTitle?: string | null;
}

interface ProgressSummaryView {
  lastWatched?: {
    position?: number;
    duration?: number;
    completed?: boolean;
    updatedAt?: number;
    season?: number | string | null;
    episodeNum?: number | string | null;
    episodeTitle?: string | null;
  } | null;
  lastEpisodeId?: string | number | null;
}

const CONTINUE_HISTORY_LIMIT = 200;

const homeRoot = document.getElementById("series-home-root");
const browseRoot = document.getElementById("series-browse-root");
const countEl = document.getElementById("series-home-count");
const statusEl = document.getElementById("series-home-status");
const actionsHomeEl = document.getElementById("series-home-actions-home");
const actionsBrowseEl = document.getElementById("series-home-actions-browse");

let generation = 0;
let currentMode: HomeBrowseMode = "home";
let catalog: SeriesCatalogIndex | null = null;
let browseHandle: BrowseEverythingHandle | null = null;
let refreshQueued = false;
let booted = false;

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Cached-only series-info payload: memory hit, not stale, no fetch, no hydrate. */
function cachedSeriesInfoPayload(playlistId: string, seriesId: number): unknown {
  try {
    const hit = getCached(playlistId, `series_info_${seriesId}`) as {
      data: unknown;
      stale: boolean;
    } | null;
    if (!hit || hit.stale) return null;
    return hit.data;
  } catch {
    return null;
  }
}

function buildContinueInputs(
  rows: SeriesRow[],
  playlistId: string,
): { inputs: ContinueWatchingInput[]; hasProgressIds: Set<number> } {
  const unfinished = (getContinueWatching(playlistId, CONTINUE_HISTORY_LIMIT) ??
    []) as unknown as ContinueEntryView[];
  const unfinishedBySeries = new Map<number, ContinueEntryView[]>();
  for (const entry of unfinished) {
    if (entry.kind !== "episode") continue;
    const sid = toFiniteNumber(entry.seriesId);
    if (sid == null) continue;
    const bucket = unfinishedBySeries.get(sid) ?? [];
    bucket.push(entry);
    unfinishedBySeries.set(sid, bucket);
  }

  const inputs: ContinueWatchingInput[] = [];
  const hasProgressIds = new Set<number>();
  for (const row of rows) {
    const summary = getSeriesProgressSummary(playlistId, row.id) as unknown as ProgressSummaryView | null;
    const episodeProgress = getSeriesEpisodeProgress(playlistId, row.id);
    const hasEntries =
      summary != null ||
      episodeProgress.completedIds.length > 0 ||
      episodeProgress.hasIncompleteEpisode;
    if (!hasEntries) continue;
    hasProgressIds.add(row.id);

    let lastProgress: SeriesHomeProgressEntry | null = null;
    const last = summary?.lastWatched;
    if (last) {
      lastProgress = {
        episodeId: summary?.lastEpisodeId ?? null,
        season: toFiniteNumber(last.season),
        episodeNum: toFiniteNumber(last.episodeNum),
        episodeTitle: last.episodeTitle ?? null,
        position: Number(last.position) || 0,
        duration: Number(last.duration) || 0,
        completed: !!last.completed,
        updatedAt: Number(last.updatedAt) || 0,
      };
    }

    const progressByEpisodeId = new Map<number, EpisodeProgress>();
    for (const id of episodeProgress.completedIds) {
      progressByEpisodeId.set(Number(id), { completed: true });
    }
    for (const entry of unfinishedBySeries.get(row.id) ?? []) {
      const episodeId = toFiniteNumber(entry.id);
      if (episodeId == null) continue;
      progressByEpisodeId.set(episodeId, {
        position: Number(entry.position) || 0,
        duration: Number(entry.duration) || 0,
        completed: !!entry.completed,
        updatedAt: Number(entry.updatedAt) || 0,
        season: toFiniteNumber(entry.season),
        episodeNum: toFiniteNumber(entry.episodeNum),
        seriesId: row.id,
      });
    }

    inputs.push({
      row,
      lastProgress,
      hasIncompleteEpisode: episodeProgress.hasIncompleteEpisode,
      completedIds: episodeProgress.completedIds.map(Number),
      cachedGroup: cachedSeasonGroup(cachedSeriesInfoPayload(playlistId, row.id)),
      progressByEpisodeId,
    });
  }
  return { inputs, hasProgressIds };
}

async function loadFollowedData(
  playlistId: string,
): Promise<{ groups: FollowedNotificationGroup[]; subs: FollowedSubscription[] }> {
  try {
    const [groups, subs] = await Promise.all([
      listNotificationGroups({ includeDismissed: false }),
      listSubscriptions(),
    ]);
    // The followed store spans playlists; Series Home shows the
    // ACTIVE playlist's shows (the catalogue is per-playlist, and a
    // detail link must resolve against the active entry).
    return {
      groups: groups.filter((group) => group.playlistId === playlistId),
      subs: subs.filter((sub) => sub.playlistId === playlistId),
    };
  } catch {
    return { groups: [], subs: [] };
  }
}

function isEpisodeWatched(
  playlistId: string,
): (seriesId: string, season: number, episode: number, episodeId: number | null) => boolean {
  return (_seriesId, _season, _episode, episodeId) => {
    // Only a provider episode id proves watched state. An episode
    // without one stays on the shelf — showing a watched episode is
    // a nit; hiding an unwatched one loses the alert.
    if (episodeId == null) return false;
    try {
      return isCompleted(playlistId, "episode", episodeId);
    } catch {
      return false;
    }
  };
}

async function renderHome(gen: number): Promise<void> {
  if (!homeRoot || !catalog) return;
  const { groups, subs } = await loadFollowedData(catalog.playlistId);
  if (gen !== generation) return;
  const { inputs, hasProgressIds } = buildContinueInputs(catalog.rows, catalog.playlistId);
  const sections: SeriesHomeSection[] = assembleSeriesHomeSections({
    rows: catalog.rows,
    rowsById: catalog.byId,
    continueInputs: inputs,
    notificationGroups: groups,
    subscriptions: subs,
    hasProgress: (row) => hasProgressIds.has(row.id),
    isEpisodeWatched: isEpisodeWatched(catalog.playlistId),
  });
  if (gen !== generation) return;
  if (sections.length === 0) {
    renderSeriesHomeState(homeRoot, "empty");
    return;
  }
  renderSeriesHome(homeRoot, sections, { playlistId: catalog.playlistId });
  restoreCouchFocus();
}

/** Coalesced refresh: many change signals collapse into one re-render. */
function scheduleHomeRefresh(): void {
  if (refreshQueued || currentMode !== "home" || !catalog) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    const gen = generation;
    void renderHome(gen);
  });
}

function setHeaderForCatalog(index: SeriesCatalogIndex | null, status: string): void {
  if (countEl) {
    countEl.textContent = index
      ? `${index.rows.length.toLocaleString()} ${index.rows.length === 1 ? "series" : "series"}`
      : "—";
  }
  if (statusEl) statusEl.textContent = status;
}

function showMode(mode: HomeBrowseMode): void {
  currentMode = mode;
  if (homeRoot) homeRoot.hidden = mode !== "home";
  if (browseRoot) browseRoot.hidden = mode !== "browse";
  if (actionsHomeEl) actionsHomeEl.hidden = mode !== "home";
  if (actionsBrowseEl) actionsBrowseEl.hidden = mode !== "browse";
  document.documentElement.setAttribute("data-series-mode", mode);
}

function focusFirstBrowseTab(): void {
  const focusIt = (): boolean => {
    const tab = browseRoot?.querySelector<HTMLButtonElement>(
      "#couch-browse-tabs button:not([disabled])",
    );
    if (tab) {
      tab.focus({ preventScroll: true });
      return true;
    }
    return false;
  };
  if (focusIt()) return;
  // The legacy controller renders its tabs during boot (after a
  // dynamic import); watch once for the first tab instead of polling.
  if (!browseRoot) return;
  const observer = new MutationObserver(() => {
    if (focusIt()) observer.disconnect();
  });
  observer.observe(browseRoot, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 3000);
}

function switchToBrowse(params: BrowseModeParams, opts: { focusSearch?: boolean } = {}): void {
  showMode("browse");
  if (!browseHandle) {
    browseHandle = mountBrowseEverything({ initialParams: params });
  } else {
    browseHandle.setParams(params);
  }
  if (opts.focusSearch) {
    // The search input is server-rendered, so focusing is immediate
    // even while the legacy controller is still booting.
    browseHandle.focusSearch();
  } else {
    focusFirstBrowseTab();
  }
}

function switchToHome(): void {
  showMode("home");
  const gen = generation;
  void renderHome(gen).then(() => {
    if (gen === generation) restoreCouchFocus();
  });
}

function applyModeFromUrl(): void {
  const parsed = parseModeFromUrl();
  if (parsed.mode === "browse") switchToBrowse(parsed.params);
  else switchToHome();
}

async function boot(forceReload = false): Promise<void> {
  const gen = ++generation;
  if (!homeRoot) return;
  const parsed = parseModeFromUrl();
  showMode(parsed.mode);
  setHeaderForCatalog(null, "Loading…");
  if (parsed.mode === "home") renderSeriesHomeState(homeRoot, "loading");

  try {
    await ensurePrefsLoaded().catch(() => {});
    const index = await getCatalogIndex({ forceReload });
    if (gen !== generation) return;
    if (!index) {
      catalog = null;
      setHeaderForCatalog(null, "No playlist selected.");
      if (parsed.mode === "home") renderSeriesHomeState(homeRoot, "no-playlist");
      else switchToBrowse(parsed.params);
      return;
    }
    catalog = index;
    if (index.loadError) {
      setHeaderForCatalog(index, "Could not reach the provider.");
      if (parsed.mode === "home") {
        renderSeriesHomeState(homeRoot, "error", {
          message: `Could not reach ${index.playlistTitle || "the provider"}. Your library may be fine — this is a connection problem, not an empty catalogue.`,
        });
      } else {
        switchToBrowse(parsed.params);
      }
      return;
    }
    setHeaderForCatalog(
      index,
      index.rows.length === 0 ? "This library is empty." : `${index.playlistTitle || "Your library"}`,
    );
    if (parsed.mode === "browse") {
      switchToBrowse(parsed.params);
      return;
    }
    await renderHome(gen);
  } catch {
    if (gen !== generation) return;
    catalog = null;
    setHeaderForCatalog(null, "Could not load the catalogue.");
    if (parsed.mode === "home") renderSeriesHomeState(homeRoot, "error");
    else switchToBrowse(parsed.params);
  }
}

// --- Mode links: in-page switching without a reload ----------------------
// Genre tiles, View All tiles, the Browse Everything actions and the
// Series Home action all carry data-series-home-mode. Intercepting
// the click keeps the switch instant and preserves the catalog load;
// the hrefs remain real URLs, so a middle-click / long-press still
// lands on the right mode after a reload.
document.addEventListener("click", (event) => {
  const target = (event.target as Element | null)?.closest?.("[data-series-home-mode]");
  if (!(target instanceof HTMLElement)) return;
  const mode = target.getAttribute("data-series-home-mode") as HomeBrowseMode | null;
  if (mode !== "home" && mode !== "browse") return;
  event.preventDefault();
  if (mode === "browse") {
    const params: BrowseModeParams = {};
    const genre = target.getAttribute("data-series-home-genre");
    if (genre) params.genre = genre;
    const sort = target.getAttribute("data-series-home-sort");
    if (sort) params.sort = sort;
    setModeInUrl("browse", params);
    switchToBrowse(params);
  } else {
    setModeInUrl("home");
    switchToHome();
  }
});

// Search Series: browse mode with the search control focused.
document.getElementById("series-home-search")?.addEventListener("click", () => {
  setModeInUrl("browse");
  switchToBrowse({}, { focusSearch: true });
});

// Error-state retry.
document.addEventListener("click", (event) => {
  const retry = (event.target as Element | null)?.closest?.("[data-series-home-retry]");
  if (!retry) return;
  void boot(true);
});

// B / Back through history restores the mode the viewer came from.
window.addEventListener("popstate", () => {
  applyModeFromUrl();
});

// Followed + progress changes refresh the home shelves in place.
document.addEventListener(FOLLOWED_CHANGED_EVENT, scheduleHomeRefresh);
document.addEventListener(FOLLOWED_NOTIFICATIONS_EVENT, scheduleHomeRefresh);
document.addEventListener(PROGRESS_CHANGED_EVENT, scheduleHomeRefresh);

// Playlist switch: drop the catalog and reboot.
document.addEventListener("xt:active-changed", () => {
  catalog = null;
  browseHandle = null;
  void boot(true);
});

if (!booted) {
  booted = true;
  void boot();
}
