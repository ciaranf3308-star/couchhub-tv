// Couch Series detail — full-width backdrop detail page with seasons,
// episode management and episode playback (W4).
//
// Reuses the app's existing data path: the cached series catalogue row,
// `get_series_info` via the throttled requestSeriesInfo resolver (the
// same cache entry the legacy detail page reads/writes), preferences
// (favourites, Watch Later, episode progress), the followed store
// (followSeries / unfollowSeries / isFollowing — never reimplemented),
// the local "similar series" heuristic, and the shared Couch VOD
// player (mountPlayer engine + TvOsd controls).
//
// Playback rules, preserved from the legacy page: resume at the exact
// saved position (30s minimum), watched state from the same progress
// records, and the player always returns to the episode listing —
// never to Home. Autoplay-next is a player toggle persisted in
// localStorage (`couch:series:autoplay-next`, default on); there is no
// app-wide autoplay setting to read.

import { mount, unmount } from "svelte";
import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js";
import { hydrate as hydrateCache } from "@/scripts/lib/cache.js";
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
  toggleWatchlist,
  getProgress,
  setProgress,
  markCompleted,
  clearProgress,
} from "@/scripts/lib/preferences.js";
import { buildSeriesStreamUrl } from "@/scripts/lib/stream-urls.ts";
import { requestSeriesInfo } from "@/scripts/lib/series-seasons.ts";
import { followSeries, unfollowSeries, isFollowing } from "@/scripts/lib/followed.ts";
import { pickLocalSimilar, parseProviderPeople } from "@/scripts/lib/similar-local.ts";
import { initI18n } from "@/scripts/lib/i18n.js";
import { log } from "@/scripts/lib/log.js";
import { loadCouchCatalog } from "@/scripts/movies/couch-catalog.ts";
import {
  mapSeriesRow,
  groupEpisodesBySeason,
  selectSeason,
  resumeOrNextEpisode,
  episodeAfter,
  episodeDisplayTitle,
  episodeProgressFraction,
  episodeResumePosition,
  episodeWatchState,
  seriesDetailViewModel,
  type SeriesRow,
  type Episode,
  type SeasonGroup,
  type EpisodeProgress,
} from "@/scripts/series/couch-series.ts";
import {
  createCouchVodPlayer,
  type CouchVodPlayerHandle,
} from "@/scripts/movies/couch-player.ts";
import { renderCouchCards } from "@/scripts/movies/couch-cards.ts";
import {
  detailArtwork,
  paintDetailArtwork,
  paintDetailProgress,
  paintMetaChips,
  seasonWatchSummary,
  seriesDetailChips,
  wireDetailBackLink,
} from "@/scripts/lib/couch-detail-presentation.ts";
import TvSeasonPicker from "@/components/couch/TvSeasonPicker.svelte";
import TvEpisodeCard from "@/components/couch/TvEpisodeCard.svelte";

const SERIES_TTL_MS = 24 * 60 * 60 * 1000;
const AUTOPLAY_NEXT_KEY = "couch:series:autoplay-next";

const params = new URLSearchParams(location.search);
const seriesId = Number(params.get("id") || "0");
const autoplayEpisodeId = Number(params.get("episode") || "0") || null;
const deepLinkSeason = Number(params.get("season") || "0") || null;
const deepLinkEpNum = Number(params.get("epnum") || "0") || null;
const wantsAutoplay = params.get("autoplay") === "1";

const $ = (id: string): HTMLElement | null => document.getElementById(id);

const heroEl = $("series-detail-hero");
const backdropEl = $("series-detail-backdrop");
const titleEl = $("series-detail-title");
const metaEl = $("series-detail-meta");
const plotEl = $("series-detail-plot");
const posterEl = $("series-detail-poster");
const progressEl = $("series-detail-progress");
const episodesSummaryEl = $("series-episodes-summary");
const resumeBtn = $("series-detail-resume") as HTMLButtonElement | null;
const resumeLabelEl = $("series-detail-resume-label");
const resumeSubEl = $("series-detail-resume-sub");
const followBtn = $("series-detail-follow") as HTMLButtonElement | null;
const favBtn = $("series-detail-fav") as HTMLButtonElement | null;
const watchBtn = $("series-detail-watch") as HTMLButtonElement | null;
const seasonPickerMount = $("series-season-picker");
const episodeListEl = $("series-episode-list");
const castSection = $("series-detail-cast");
const castListEl = $("series-detail-cast-list");
const similarSection = $("series-detail-similar");
const similarListEl = $("series-detail-similar-list");
const playerWrap = $("series-detail-player-wrap");
const detailBody = $("series-detail-body");
const statusEl = $("series-detail-status");

let activePlaylistId = "";
let creds: { host: string; port?: string; user: string; pass: string } = {
  host: "",
  user: "",
  pass: "",
};
let row: SeriesRow | null = null;
let seriesInfoRaw: unknown = null;
let detail = seriesDetailViewModel(null, null);
let group: SeasonGroup = { seasons: [], bySeason: new Map(), totalEpisodes: 0 };
let allRows: SeriesRow[] = [];
let currentSeason: number | null = null;
let currentEpisode: Episode | null = null;
let player: CouchVodPlayerHandle | null = null;
let playerOpen = false;
let playRequestId = 0;
let seasonPickerMounted: ReturnType<typeof mount> | null = null;
let episodeCardsMounted: Array<ReturnType<typeof mount>> = [];
let autoplayNext = true;
try {
  autoplayNext = localStorage.getItem(AUTOPLAY_NEXT_KEY) !== "off";
} catch {
  autoplayNext = true;
}

function progressById(): Map<number, EpisodeProgress> {
  const map = new Map<number, EpisodeProgress>();
  if (!activePlaylistId) return map;
  for (const ep of group.bySeason.values()) {
    for (const episode of ep) {
      const p = getProgress(activePlaylistId, "episode", episode.id);
      if (p) map.set(episode.id, p as EpisodeProgress);
    }
  }
  return map;
}

function hideSkeleton() {
  const skeleton = $("series-detail-skeleton");
  if (skeleton) skeleton.hidden = true;
}

function paintHero() {
  if (titleEl) titleEl.textContent = detail.title || `Series ${seriesId}`;
  // Meta renders as chips (year, seasons, genres, rating) plus a
  // watched-progress chip — only supplied/real values, never invented.
  const chips = seriesDetailChips(detail);
  const summary = seasonWatchSummary(group, progressById());
  if (summary.total > 0) {
    chips.push({ label: summary.label, kind: "progress" });
  }
  paintMetaChips(metaEl, chips);
  if (plotEl) plotEl.textContent = detail.plot || "";
  // Backdrop falls back to the poster; with neither, the shared
  // fallback system paints the intentional initials mark instead.
  const art = detailArtwork(detail);
  paintDetailArtwork(backdropEl, art.heroSrc, "backdrop", detail.title);
  paintDetailArtwork(posterEl, art.posterSrc, "poster", detail.title);
  if (heroEl) heroEl.hidden = false;
  hideSkeleton();
  const episodesSection = $("series-episodes-section");
  if (episodesSection) episodesSection.hidden = false;
}

function syncEpisodesSummary() {
  if (!episodesSummaryEl) return;
  const summary = seasonWatchSummary(group, progressById());
  episodesSummaryEl.textContent =
    summary.total > 0
      ? `${summary.total} episode${summary.total === 1 ? "" : "s"} · ${summary.label}`
      : "";
}

function syncResumeButton() {
  if (!resumeBtn || !resumeLabelEl) return;
  const target = resumeOrNextEpisode(group, progressById());
  if (!target) {
    resumeBtn.hidden = true;
    paintDetailProgress(progressEl, 0, "");
    return;
  }
  resumeBtn.hidden = false;
  resumeLabelEl.textContent = target.label;
  if (resumeSubEl) {
    resumeSubEl.textContent = `S${target.episode.season} E${target.episode.episodeNum} · ${episodeDisplayTitle(target.episode, detail.title)}`;
  }
  // Progress bar tracks the episode the button will resume / start.
  const targetProgress = progressById().get(target.episode.id);
  const fraction = episodeProgressFraction(targetProgress);
  paintDetailProgress(
    progressEl,
    fraction,
    fraction > 0 ? `${Math.round(fraction * 100)}% watched` : "",
  );
  resumeBtn.onclick = () => {
    void playEpisode(target.episode);
  };
}

async function syncFollowButton() {
  if (!followBtn || !activePlaylistId) return;
  const following = await isFollowing(activePlaylistId, String(seriesId)).catch(() => false);
  followBtn.setAttribute("aria-pressed", String(following));
  followBtn.textContent = following ? "✓ Following" : "+ Follow";
}

function syncActionButtons() {
  if (favBtn && activePlaylistId) {
    const fav = isFavorite(activePlaylistId, "series", seriesId);
    favBtn.setAttribute("aria-pressed", String(fav));
    favBtn.textContent = fav ? "★ Favourited" : "☆ Favourite";
  }
  if (watchBtn && activePlaylistId) {
    const onList = isOnWatchlist(activePlaylistId, "series", seriesId);
    watchBtn.setAttribute("aria-pressed", String(onList));
    watchBtn.textContent = onList ? "✓ Watch Later" : "+ Watch Later";
  }
}

function seasonCounts(): Record<number, { watched: number; total: number }> {
  const out: Record<number, { watched: number; total: number }> = {};
  const progress = progressById();
  for (const season of group.seasons) {
    const eps = group.bySeason.get(season) ?? [];
    out[season] = {
      watched: eps.filter((ep) => progress.get(ep.id)?.completed).length,
      total: eps.length,
    };
  }
  return out;
}

function renderSeasonPicker() {
  if (!seasonPickerMount) return;
  if (seasonPickerMounted) {
    try {
      unmount(seasonPickerMounted);
    } catch {}
    seasonPickerMounted = null;
  }
  seasonPickerMount.replaceChildren();
  if (!group.seasons.length) return;
  seasonPickerMounted = mount(TvSeasonPicker, {
    target: seasonPickerMount,
    props: {
      seasons: group.seasons,
      current: currentSeason,
      counts: seasonCounts(),
      onSelect: (season: number) => {
        currentSeason = season;
        renderSeasonPicker();
        renderEpisodes();
      },
    },
  });
}

function renderEpisodes(scrollToEpisodeId?: number) {
  if (!episodeListEl) return;
  for (const mounted of episodeCardsMounted) {
    try {
      unmount(mounted);
    } catch {}
  }
  episodeCardsMounted = [];
  episodeListEl.replaceChildren();
  if (currentSeason == null) {
    episodeListEl.textContent = "No episodes listed for this series yet.";
    return;
  }
  const eps = group.bySeason.get(currentSeason) ?? [];
  if (!eps.length) {
    episodeListEl.textContent = "No episodes in this season.";
    return;
  }
  const progress = progressById();
  const next = resumeOrNextEpisode(group, progress);
  for (const ep of eps) {
    const p = progress.get(ep.id);
    const host = document.createElement("div");
    episodeListEl.appendChild(host);
    const mounted = mount(TvEpisodeCard, {
      target: host,
      props: {
        episode: {
          id: ep.id,
          season: ep.season,
          episodeNum: ep.episodeNum,
          title: episodeDisplayTitle(ep, detail.title),
          plot: ep.plot,
          durationLabel: ep.durationLabel,
          released: ep.released,
          thumb: ep.thumb,
          progress: episodeProgressFraction(p),
          watched: episodeWatchState(p) === "watched",
          isNext: next?.episode.id === ep.id,
          isPlaying: playerOpen && currentEpisode?.id === ep.id,
          resumeSeconds: episodeResumePosition(p),
        },
        onPlay: (episode: { id: number }) => {
          const target = eps.find((candidate) => candidate.id === episode.id);
          if (target) void playEpisode(target);
        },
        onRestart: (episode: { id: number }) => {
          if (!activePlaylistId) return;
          clearProgress(activePlaylistId, "episode", episode.id);
          const target = eps.find((candidate) => candidate.id === episode.id);
          if (target) void playEpisode(target);
        },
        onToggleWatched: (episode: { id: number }) => {
          if (!activePlaylistId) return;
          const target = eps.find((candidate) => candidate.id === episode.id);
          if (!target) return;
          const watched = episodeWatchState(progress.get(episode.id)) === "watched";
          if (watched) clearProgress(activePlaylistId, "episode", episode.id);
          else {
            markCompleted(activePlaylistId, "episode", episode.id, {
              seriesId,
              season: target.season,
              episodeNum: target.episodeNum,
              episodeTitle: target.title,
              seriesName: detail.title,
              seriesLogo: detail.poster,
            });
          }
          renderEpisodes();
          renderSeasonPicker();
          syncResumeButton();
          syncEpisodesSummary();
        },
      },
    });
    episodeCardsMounted.push(mounted);
  }
  try {
    (window as any).SpatialNavigation?.makeFocusable?.();
  } catch {}
  if (scrollToEpisodeId) {
    const card = episodeListEl.querySelector(`[data-couch-key="episode-${scrollToEpisodeId}"]`);
    (card as HTMLElement | null)?.scrollIntoView({ block: "center" });
    (card as HTMLElement | null)?.focus?.();
  }
}

function renderCast() {
  if (!castSection || !castListEl) return;
  castListEl.replaceChildren();
  const names = detail.cast.slice(0, 12);
  if (!names.length && !detail.director) {
    castSection.hidden = true;
    return;
  }
  castSection.hidden = false;
  if (detail.director) {
    const chip = document.createElement("span");
    chip.className = "rs-meta";
    chip.textContent = `Directed by ${detail.director}`;
    castListEl.appendChild(chip);
  }
  for (const name of names) {
    const chip = document.createElement("span");
    chip.className = "rs-meta";
    chip.textContent = name;
    castListEl.appendChild(chip);
  }
}

function renderSimilar() {
  if (!similarSection || !similarListEl) return;
  const info = parseProviderPeople({
    cast: detail.cast.join(", "),
    director: detail.director || "",
  });
  const picks = pickLocalSimilar(
    { id: seriesId, category: row?.category || null, castNames: info.castNames, directorName: info.directorName },
    allRows.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      year: candidate.year,
      category: candidate.category,
      rating: candidate.rating,
      logo: candidate.logo,
    })),
    { limit: 12 },
  );
  if (!picks.length) {
    similarSection.hidden = true;
    return;
  }
  similarSection.hidden = false;
  renderCouchCards(
    similarListEl,
    picks.map((pick) => ({
      title: pick.name,
      meta: [pick.year, pick.category].filter(Boolean).join(" · "),
      image: pick.logo,
      kind: "poster" as const,
      href: `/series/detail?id=${encodeURIComponent(pick.id)}`,
      itemKey: `series-${pick.id}`,
    })),
  );
}

function progressExtrasFor(ep: Episode) {
  return {
    seriesId,
    season: ep.season ?? currentSeason ?? null,
    episodeNum: ep.episodeNum ?? null,
    episodeTitle: ep.title || "",
    seriesName: detail.title || "",
    seriesLogo: detail.poster,
  };
}

function hidePlayer(focusEpisodeId?: number) {
  playerOpen = false;
  player?.dispose();
  player = null;
  if (playerWrap) playerWrap.hidden = true;
  if (detailBody) detailBody.hidden = false;
  // Re-render so watched state / progress bars reflect what just played.
  renderEpisodes();
  renderSeasonPicker();
  syncResumeButton();
  if (focusEpisodeId) {
    const card = episodeListEl?.querySelector(
      `[data-couch-key="episode-${focusEpisodeId}"]`,
    ) as HTMLElement | null;
    card?.focus?.();
  } else {
    resumeBtn?.focus();
  }
}

async function playEpisode(ep: Episode) {
  if (!ep) return;
  const requestId = ++playRequestId;
  if (!creds.host || !creds.user || !creds.pass) {
    if (statusEl) statusEl.textContent = "No provider credentials — sign in to play.";
    return;
  }
  // Switching episodes reuses the same player wrap: retire the old
  // mount first so two engines never fight over the element.
  player?.dispose();
  player = null;
  currentEpisode = ep;
  currentSeason = ep.season;
  const src = buildSeriesStreamUrl(creds, ep.id, ep.containerExt);
  const saved = activePlaylistId ? getProgress(activePlaylistId, "episode", ep.id) : null;
  const resumeAt = episodeResumePosition(saved);
  if (playerWrap) playerWrap.hidden = false;
  if (detailBody) detailBody.hidden = true;
  playerOpen = true;
  renderEpisodes();
  const nextEp = episodeAfter(group, ep);
  const created = await createCouchVodPlayer({
    logTag: "[xt:couch-series-detail]",
    videoElementId: "series-player",
    src,
    durationSeconds: ep.durationSeconds,
    resumeSeconds: resumeAt,
    autoplay: true,
    autoplayNext,
    ids: {
      playPause: "series-osd-play-pause",
      back10: "series-osd-back10",
      fwd10: "series-osd-fwd10",
      timeline: "series-osd-timeline",
      timeLabel: "series-osd-time",
      fullscreen: "series-osd-fullscreen",
      back: "series-osd-back",
      next: "series-osd-next",
      subtitles: "series-osd-subtitles",
      audio: "series-osd-audio",
      autoplayToggle: "series-osd-autoplay",
      subtitlesList: "series-osd-subtitles-list",
      audioList: "series-osd-audio-list",
    },
    onProgress: (position, duration) => {
      if (!activePlaylistId || !currentEpisode) return;
      setProgress(activePlaylistId, "episode", currentEpisode.id, position, duration, progressExtrasFor(currentEpisode));
    },
    onEnded: () => {
      if (!activePlaylistId || !currentEpisode) return;
      const ended = currentEpisode;
      markCompleted(activePlaylistId, "episode", ended.id, {
        duration: ended.durationSeconds ?? undefined,
        ...progressExtrasFor(ended),
      });
      const followUp = autoplayNext ? episodeAfter(group, ended) : null;
      if (followUp) {
        void playEpisode(followUp);
      } else {
        hidePlayer();
      }
    },
    onExit: () => hidePlayer(currentEpisode?.id),
    onNext: nextEp
      ? () => {
          void playEpisode(nextEp);
        }
      : undefined,
    onAutoplayChange: (enabled) => {
      autoplayNext = enabled;
      try {
        localStorage.setItem(AUTOPLAY_NEXT_KEY, enabled ? "on" : "off");
      } catch {}
    },
    onError: (message) => {
      if (requestId !== playRequestId) return;
      if (statusEl) statusEl.textContent = message;
      hidePlayer(currentEpisode?.id);
    },
  });
  if (requestId !== playRequestId) {
    created?.dispose();
    return;
  }
  if (!created) {
    hidePlayer(ep.id);
    return;
  }
  player = created;
  // The OSD info line names the episode that is actually playing.
  const infoTitle = $("series-osd-title");
  if (infoTitle) {
    infoTitle.textContent = `${detail.title} — S${ep.season} E${ep.episodeNum} · ${episodeDisplayTitle(ep, detail.title)}`;
  }
}

// B / Escape while the player is open exits to the episode listing —
// never to Home. Capture phase so the global back handler does not fire first.
document.addEventListener(
  "keydown",
  (ev) => {
    if (!playerOpen) return;
    if (ev.key === "Escape" || ev.key === "BrowserBack") {
      ev.preventDefault();
      ev.stopPropagation();
      hidePlayer(currentEpisode?.id);
    }
  },
  true,
);

followBtn?.addEventListener("click", async () => {
  if (!activePlaylistId) return;
  const following = await isFollowing(activePlaylistId, String(seriesId)).catch(() => false);
  if (following) {
    await unfollowSeries(activePlaylistId, String(seriesId));
  } else {
    const result = await followSeries({
      playlistId: activePlaylistId,
      seriesId: String(seriesId),
      seriesTitle: detail.title || row?.name || `Series ${seriesId}`,
      posterUrl: detail.poster,
      sourceKind: "xtream",
      seriesInfo: seriesInfoRaw,
    });
    if (!result.ok && statusEl) {
      statusEl.textContent =
        result.reason === "no-episodes"
          ? "Follow needs the episode list first — retry once it loads."
          : "Could not follow this series right now.";
    }
  }
  void syncFollowButton();
});
favBtn?.addEventListener("click", () => {
  if (!activePlaylistId) return;
  toggleFavorite(activePlaylistId, "series", seriesId, { name: detail.title, logo: detail.poster });
  syncActionButtons();
});
watchBtn?.addEventListener("click", () => {
  if (!activePlaylistId) return;
  toggleWatchlist(activePlaylistId, "series", seriesId, { name: detail.title, logo: detail.poster });
  syncActionButtons();
});

async function loadDetail() {
  const active = await getActiveEntry();
  if (!active) {
    hideSkeleton();
    if (statusEl) statusEl.textContent = "No playlist selected.";
    return;
  }
  activePlaylistId = active._id as string;
  await ensurePrefsLoaded();
  await hydrateCache(activePlaylistId, "series");
  const catalog = await loadCouchCatalog({
    kind: "series",
    listAction: "get_series",
    categoriesAction: "get_series_categories",
    ttlMs: SERIES_TTL_MS,
    mapRow: mapSeriesRow,
  });
  allRows = catalog?.rows ?? [];
  row = allRows.find((candidate) => candidate.id === seriesId) ?? null;

  const info = await requestSeriesInfo(activePlaylistId, seriesId).catch((err) => {
    log.warn("[xt:couch-series-detail] get_series_info failed:", err);
    return null;
  });
  seriesInfoRaw = info;
  group = groupEpisodesBySeason(info);
  detail = seriesDetailViewModel(info, row);
  const progress = progressById();
  const resumeTarget = resumeOrNextEpisode(group, progress);
  const resumeSeason = resumeTarget?.episode.season ?? null;
  // Deep-link handoff (?season=N&epnum=M, from the launcher / New
  // Episodes): the requested season wins over the resume season.
  const preferredSeason =
    deepLinkSeason != null && group.bySeason.has(deepLinkSeason)
      ? deepLinkSeason
      : autoplayEpisodeId != null
        ? (allEpisodesSeasonOf(autoplayEpisodeId) ?? resumeSeason)
        : resumeSeason;
  currentSeason = selectSeason(group, preferredSeason, resumeSeason);
  paintHero();
  syncResumeButton();
  syncActionButtons();
  syncEpisodesSummary();
  void syncFollowButton();
  renderCast();
  renderSimilar();
  renderSeasonPicker();
  renderEpisodes();

  // Autoplay handoff (?episode=<id>&autoplay=1, e.g. from /downloads):
  // switch to the episode's season, then play it.
  if (autoplayEpisodeId && wantsAutoplay) {
    const target = findEpisode(autoplayEpisodeId);
    if (target) {
      currentSeason = target.season;
      renderSeasonPicker();
      renderEpisodes();
      void playEpisode(target);
      return;
    }
  }
  // Deep-link handoff (?season=N&epnum=M): scroll the episode into view,
  // and autoplay it when requested.
  if (deepLinkSeason != null && deepLinkEpNum != null) {
    const eps = group.bySeason.get(deepLinkSeason) ?? [];
    const target = eps.find((ep) => ep.episodeNum === deepLinkEpNum);
    if (target) {
      currentSeason = deepLinkSeason;
      renderSeasonPicker();
      renderEpisodes(target.id);
      if (wantsAutoplay) void playEpisode(target);
    }
  }
}

function findEpisode(episodeId: number): Episode | null {
  for (const eps of group.bySeason.values()) {
    const found = eps.find((ep) => ep.id === episodeId);
    if (found) return found;
  }
  return null;
}

function allEpisodesSeasonOf(episodeId: number): number | null {
  return findEpisode(episodeId)?.season ?? null;
}

(async () => {
  await initI18n().catch(() => {});
  creds = await loadCreds();
  // Back to Browse: history.back() when we arrived from the Browse
  // grid, so couch-focus memory restores the exact card; otherwise
  // the link follows its href. (detailBackDecision is the tested half.)
  wireDetailBackLink($("series-detail-back"), "/browse");
  if (!seriesId) {
    hideSkeleton();
    if (statusEl) statusEl.textContent = "No series selected.";
    return;
  }
  await loadDetail();
})();
