// Couch Series Home controller (0.11.8) — mount entry for the
// standalone /series page.
//
// TWO MODES, ONE NAV ITEM (brief §1.1, §2): Series Home (shelves,
// this module) and Series → Browse Everything (W2's mount). The mode
// lives in the URL (W2's mode contract), so a return from a detail
// page restores mode + category + page through browser history, and
// the selected poster restores through the existing focus memory
// (couch-focus.ts, by stable data-couch-key). Series Home NEVER
// mounts the full catalogue grid: the browse controller mounts only
// when browse mode is entered, and stays mounted-but-suspended (keys
// gated, root hidden) while Home shows, so a return to Browse is
// instant and the catalogue index is built once.
//
// LIVE UPDATES WITHOUT RESTART: Followed changes
// (FOLLOWED_CHANGED_EVENT / FOLLOWED_NOTIFICATIONS_EVENT) and
// progress changes (PROGRESS_CHANGED_EVENT) coalesce into one
// re-render from cached data — unfollowing a series updates the
// New Episodes / Followed shelves in place, with no polling and no
// full restart. In Browse mode, followed changes refresh the
// followed/new-episode browse sets before the controller refreshes.
// Async loads are generation-guarded so a stale response can never
// paint over newer state.
//
// CONTROLLER: no input handling lives here. Shelves use the
// data-nylah-rail / data-nylah-item contract, so the shared XInput
// action pipeline (gamepad.ts + couch-focus.ts) drives everything.
// LB/RB shelf jumping on Home comes from the shared
// installHomeShelfJump (movies-home-mount.ts) via the gamepad seam,
// which routes LB/RB to PageUp/PageDown on Home.

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
import { getActiveProfileId, SHARED_PROFILE_ID } from "@/scripts/lib/profiles.ts";
import { emptyTasteModel, loadTaste, type TasteModel } from "@/scripts/lib/taste.ts";
import { getCachedSeasonCount, getCachedSeriesInfoPayload } from "@/scripts/lib/series-seasons.ts";
import { getCatalogIndex, type CatalogIndex } from "@/scripts/lib/catalog-index.ts";
import {
  mountBrowseEverything,
  type BrowseController,
} from "@/scripts/lib/browse-everything.ts";
import {
  browseStateFromMode,
  isBrowseSortId,
  parseModeFromUrl,
  setModeInUrl,
  type HomeBrowseMode,
} from "@/scripts/lib/home-browse-modes.ts";
import {
  createSeriesBrowseSource,
  refreshFollowedBrowseSets,
  resolveBrowseCategoryLabel,
} from "@/scripts/lib/browse-sources.ts";
import { loadCouchCatalog } from "@/scripts/movies/couch-catalog.ts";
import { seriesAdapter } from "@/scripts/series/couch-series-adapter.ts";
import { installHomeShelfJump } from "@/scripts/movies/movies-home-mount.ts";
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
// widening shared types this module does not own.
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

interface SeriesHomeCatalog {
  rows: SeriesRow[];
  byId: Map<number, SeriesRow>;
  playlistId: string;
  playlistTitle: string;
  loadError: boolean;
  index: CatalogIndex;
}

const CONTINUE_HISTORY_LIMIT = 200;

const homeRoot = document.getElementById("series-home-root");
const browseRoot = document.getElementById("series-browse-root");
const countEl = document.getElementById("series-home-count");
const statusEl = document.getElementById("series-home-status");
const actionsHomeEl = document.getElementById("series-home-actions-home");
const actionsBrowseEl = document.getElementById("series-home-actions-browse");

let generation = 0;
let currentMode: "home" | "browse" = "home";
let catalog: SeriesHomeCatalog | null = null;
let browseController: BrowseController | null = null;
let refreshQueued = false;
let booted = false;

function resolveLabel(
  selection: Parameters<typeof resolveBrowseCategoryLabel>[1],
): string {
  return resolveBrowseCategoryLabel("series", selection);
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) ? n : null;
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
      cachedGroup: cachedSeasonGroup(
        getCachedSeriesInfoPayload(playlistId, row.id),
      ),
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

function loadTasteFor(playlistId: string): TasteModel {
  try {
    const profileId = getActiveProfileId() ?? SHARED_PROFILE_ID;
    return loadTaste(profileId, playlistId);
  } catch {
    return emptyTasteModel(SHARED_PROFILE_ID, playlistId);
  }
}

async function renderHome(gen: number): Promise<void> {
  if (!homeRoot || !catalog) return;
  const { groups, subs } = await loadFollowedData(catalog.playlistId);
  if (gen !== generation) return;
  const { inputs, hasProgressIds } = buildContinueInputs(catalog.rows, catalog.playlistId);
  const sections: SeriesHomeSection[] = assembleSeriesHomeSections({
    index: catalog.index,
    rowsById: catalog.byId,
    continueInputs: inputs,
    notificationGroups: groups,
    subscriptions: subs,
    taste: loadTasteFor(catalog.playlistId),
    startedIds: [...hasProgressIds].map(String),
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

/** Followed changes while browsing: refresh the followed browse sets first, then the grid. */
function scheduleBrowseFollowedRefresh(): void {
  if (currentMode !== "browse" || !browseController || !catalog) return;
  const playlistId = catalog.playlistId;
  void refreshFollowedBrowseSets(playlistId).then(() => {
    browseController?.refresh();
  });
}

function setHeaderForCatalog(index: SeriesHomeCatalog | null, status: string): void {
  if (countEl) {
    countEl.textContent = index
      ? `${index.index.totalGroups.toLocaleString()} ${index.index.totalGroups === 1 ? "series" : "series"}`
      : "—";
  }
  if (statusEl) statusEl.textContent = status;
}

function showMode(mode: "home" | "browse"): void {
  currentMode = mode;
  if (homeRoot) homeRoot.hidden = mode !== "home";
  if (browseRoot) browseRoot.hidden = mode !== "browse";
  if (actionsHomeEl) actionsHomeEl.hidden = mode !== "home";
  if (actionsBrowseEl) actionsBrowseEl.hidden = mode !== "browse";
  document.documentElement.setAttribute("data-series-mode", mode);
}

/**
 * Focus the first Browse card when entering Browse with nothing
 * focused (fresh entry, no focus memory, no selected poster). The
 * mount's focus pin / focus memory wins whenever it applies: the
 * check runs after the grid paints (mutation-observed), and only
 * focuses when the body still holds focus.
 */
function focusFirstBrowseCard(): void {
  const tryFocus = (): boolean => {
    const active = document.activeElement;
    if (active && active !== document.body) return true;
    const card = browseRoot?.querySelector<HTMLElement>("[data-browse-key]");
    if (card) {
      card.focus({ preventScroll: true });
      return true;
    }
    return false;
  };
  if (tryFocus()) return;
  if (!browseRoot) return;
  const observer = new MutationObserver(() => {
    if (tryFocus()) observer.disconnect();
  });
  observer.observe(browseRoot, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 3000);
}

function switchToBrowse(mode: HomeBrowseMode, opts: { focusSearch?: boolean } = {}): void {
  if (!browseRoot) return;
  showMode("browse");
  const state = browseStateFromMode(mode, resolveLabel);
  if (!browseController) {
    browseController = mountBrowseEverything(browseRoot, {
      kind: "series",
      initialState: state,
      source: createSeriesBrowseSource(),
      autoOpenSearch: opts.focusSearch ?? false,
      onOpenDetail: (id) => {
        window.location.href = `/series/detail?id=${encodeURIComponent(id)}`;
      },
      onExit: () => {
        setModeInUrl({ view: "home", kind: "series" });
        switchToHome();
      },
    });
  } else {
    browseController.setSuspended(false);
    browseController.setState(state);
    if (opts.focusSearch) browseController.openSearch();
  }
  if (!opts.focusSearch) focusFirstBrowseCard();
}

function switchToHome(): void {
  browseController?.setSuspended(true);
  showMode("home");
  const gen = generation;
  void renderHome(gen).then(() => {
    if (gen === generation) restoreCouchFocus();
  });
}

function applyModeFromUrl(): void {
  const mode = parseModeFromUrl("series", resolveLabel);
  if (mode.view === "browse") switchToBrowse(mode);
  else switchToHome();
}

async function boot(): Promise<void> {
  const gen = ++generation;
  if (!homeRoot) return;
  const mode = parseModeFromUrl("series", resolveLabel);
  showMode(mode.view);
  setHeaderForCatalog(null, "Loading…");
  if (mode.view === "home") renderSeriesHomeState(homeRoot, "loading");

  try {
    await ensurePrefsLoaded().catch(() => {});
    const result = await loadCouchCatalog<SeriesRow>(seriesAdapter.spec);
    if (gen !== generation) return;
    if (!result) {
      catalog = null;
      setHeaderForCatalog(null, "No playlist selected.");
      if (mode.view === "home") renderSeriesHomeState(homeRoot, "no-playlist");
      else switchToBrowse(mode);
      return;
    }
    const byId = new Map<number, SeriesRow>();
    for (const row of result.rows) byId.set(row.id, row);
    const index = getCatalogIndex("series", result.rows, `${result.playlistId}:${result.rows.length}`, {
      playlistId: result.playlistId,
      seasonCountReader: (id) => getCachedSeasonCount(result.playlistId, id),
    });
    catalog = {
      rows: result.rows,
      byId,
      playlistId: result.playlistId,
      playlistTitle: result.playlistTitle,
      loadError: result.loadError,
      index,
    };
    if (result.loadError) {
      setHeaderForCatalog(catalog, "Could not reach the provider.");
      if (mode.view === "home") {
        renderSeriesHomeState(homeRoot, "error", {
          message: `Could not reach ${result.playlistTitle || "the provider"}. Your library may be fine — this is a connection problem, not an empty catalogue.`,
        });
      } else {
        switchToBrowse(mode);
      }
      return;
    }
    setHeaderForCatalog(
      catalog,
      index.totalGroups === 0 ? "This library is empty." : `${result.playlistTitle || "Your library"}`,
    );
    if (mode.view === "browse") {
      switchToBrowse(mode);
      return;
    }
    await renderHome(gen);
  } catch {
    if (gen !== generation) return;
    catalog = null;
    setHeaderForCatalog(null, "Could not load the catalogue.");
    if (mode.view === "home") renderSeriesHomeState(homeRoot, "error");
    else switchToBrowse(mode);
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
  const modeAttr = target.getAttribute("data-series-home-mode");
  if (modeAttr !== "home" && modeAttr !== "browse") return;
  event.preventDefault();
  if (modeAttr === "browse") {
    const genre = target.getAttribute("data-series-home-genre");
    const sort = target.getAttribute("data-series-home-sort");
    const mode: HomeBrowseMode = {
      view: "browse",
      kind: "series",
      category: genre ? `genre:${genre}` : undefined,
      sort: sort && isBrowseSortId(sort) ? sort : undefined,
    };
    // Home→browse ENTER pushes a history entry, so Back returns to Home.
    setModeInUrl(mode, { replace: false });
    switchToBrowse(mode);
  } else {
    setModeInUrl({ view: "home", kind: "series" });
    switchToHome();
  }
});

// Search Series: browse mode with the search layer opened.
document.getElementById("series-home-search")?.addEventListener("click", () => {
  const mode: HomeBrowseMode = { view: "browse", kind: "series" };
  setModeInUrl(mode, { replace: false });
  switchToBrowse(mode, { focusSearch: true });
});

// Error-state retry.
document.addEventListener("click", (event) => {
  const retry = (event.target as Element | null)?.closest?.("[data-series-home-retry]");
  if (!retry) return;
  void boot();
});

// B / Back through history restores the mode the viewer came from.
window.addEventListener("popstate", () => {
  applyModeFromUrl();
});

// Followed + progress changes refresh the home shelves in place.
document.addEventListener(FOLLOWED_CHANGED_EVENT, scheduleHomeRefresh);
document.addEventListener(FOLLOWED_NOTIFICATIONS_EVENT, scheduleHomeRefresh);
document.addEventListener(PROGRESS_CHANGED_EVENT, scheduleHomeRefresh);
// Followed changes while browsing refresh the followed browse sets.
document.addEventListener(FOLLOWED_CHANGED_EVENT, scheduleBrowseFollowedRefresh);
document.addEventListener(FOLLOWED_NOTIFICATIONS_EVENT, scheduleBrowseFollowedRefresh);

// Playlist switch: destroy the browse controller, drop the catalog, reboot.
document.addEventListener("xt:active-changed", () => {
  browseController?.destroy();
  browseController = null;
  catalog = null;
  void boot();
});

// LB/RB shelf jumping on Home (shared helper; the gamepad seam
// routes LB/RB to PageUp/PageDown when Home is active).
if (homeRoot) installHomeShelfJump(homeRoot);

if (!booted) {
  booted = true;
  void boot();
}
