// Couch Movie detail — full-width backdrop detail page (W4).
//
// Reuses the app's existing data path: the cached VOD catalogue row,
// `get_vod_info` (cached 7d under `vod_info_<id>`, the same entry the
// legacy detail page reads/writes), preferences (favourites, Watch
// Later, recents, progress), the local "more like this" heuristic, and
// the shared Couch VOD player (mountPlayer engine + TvOsd controls).
// Playback progress is recorded exactly as the legacy page records
// it, so resume state is shared between the Couch and legacy screens.

import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js";
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js";
import { getCached, setCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js";
import {
  ensureLoaded as ensurePrefsLoaded,
  isFavorite,
  toggleFavorite,
  isOnWatchlist,
  toggleWatchlist,
  pushRecent,
  getProgress,
  setProgress,
  markCompleted,
} from "@/scripts/lib/preferences.js";
import { buildMovieStreamUrl } from "@/scripts/lib/stream-urls.ts";
import { pickLocalSimilar, parseProviderPeople } from "@/scripts/lib/similar-local.ts";
import { initI18n } from "@/scripts/lib/i18n.js";
import { log } from "@/scripts/lib/log.js";
import { loadCouchCatalog } from "@/scripts/movies/couch-catalog.ts";
import {
  mapMovieRow,
  movieDetailViewModel,
  movieDetailMetaLine,
  movieProgressFraction,
  resumePosition,
  playButtonLabel,
  type MovieRow,
} from "@/scripts/movies/couch-movies.ts";
import {
  detailArtwork,
  movieDetailChips,
  paintDetailArtwork,
  paintDetailProgress,
  paintMetaChips,
  wireDetailBackLink,
} from "@/scripts/lib/couch-detail-presentation.ts";
import {
  createCouchVodPlayer,
  type CouchVodPlayerHandle,
} from "@/scripts/movies/couch-player.ts";
import { renderCouchCards } from "@/scripts/movies/couch-cards.ts";
import { openCouchDialog } from "@/scripts/lib/couch-focus.ts";

const VOD_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VOD_TTL_MS = 24 * 60 * 60 * 1000;

const params = new URLSearchParams(location.search);
const movieId = Number(params.get("id") || "0");

const $ = (id: string): HTMLElement | null => document.getElementById(id);

const heroEl = $("movie-detail-hero");
const backdropEl = $("movie-detail-backdrop");
const titleEl = $("movie-detail-title");
const metaEl = $("movie-detail-meta");
const plotEl = $("movie-detail-plot");
const posterEl = $("movie-detail-poster");
const progressEl = $("movie-detail-progress");
const playBtn = $("movie-detail-play") as HTMLButtonElement | null;
const playLabelEl = $("movie-detail-play-label");
const playSubEl = $("movie-detail-play-sub");
const favBtn = $("movie-detail-fav") as HTMLButtonElement | null;
const watchBtn = $("movie-detail-watch") as HTMLButtonElement | null;
const trailerBtn = $("movie-detail-trailer") as HTMLButtonElement | null;
const castSection = $("movie-detail-cast");
const castListEl = $("movie-detail-cast-list");
const similarSection = $("movie-detail-similar");
const similarListEl = $("movie-detail-similar-list");
const playerWrap = $("movie-detail-player-wrap");
const statusEl = $("movie-detail-status");
const trailerFrame = $("movie-detail-trailer-frame") as HTMLIFrameElement | null;

let activePlaylistId = "";
let creds: { host: string; port?: string; user: string; pass: string } = {
  host: "",
  user: "",
  pass: "",
};
let row: MovieRow | null = null;
let detail = movieDetailViewModel(null, null);
let allRows: MovieRow[] = [];
let player: CouchVodPlayerHandle | null = null;
let playerOpen = false;
let playRequestId = 0;

function hideSkeleton() {
  const skeleton = $("movie-detail-skeleton");
  if (skeleton) skeleton.hidden = true;
}

function paintHero() {
  if (titleEl) titleEl.textContent = detail.title || `Movie ${movieId}`;
  // Meta renders as chips (year, runtime, genres, rating) — only the
  // fields the provider actually supplied, never invented values.
  paintMetaChips(metaEl, movieDetailChips(detail));
  if (plotEl) plotEl.textContent = detail.plot || "";
  // Backdrop falls back to the poster; with neither, the shared
  // fallback system paints the intentional initials mark instead.
  const art = detailArtwork(detail);
  paintDetailArtwork(backdropEl, art.heroSrc, "backdrop", detail.title);
  paintDetailArtwork(posterEl, art.posterSrc, "poster", detail.title);
  if (heroEl) heroEl.hidden = false;
  hideSkeleton();
  const osdTitle = $("movie-osd-title");
  if (osdTitle) osdTitle.textContent = detail.title || "";
  const osdSub = $("movie-osd-subtitle");
  if (osdSub) osdSub.textContent = movieDetailMetaLine(detail);
}

function syncPlayButton() {
  if (!playBtn || !playLabelEl) return;
  const saved = activePlaylistId ? getProgress(activePlaylistId, "vod", movieId) : null;
  const { label, sub } = playButtonLabel(saved);
  playLabelEl.textContent = label;
  if (playSubEl) playSubEl.textContent = sub;
  const fraction = movieProgressFraction(saved);
  paintDetailProgress(
    progressEl,
    fraction,
    fraction > 0 ? `${Math.round(fraction * 100)}% watched` : "",
  );
}

function syncActionButtons() {
  if (favBtn && activePlaylistId) {
    const fav = isFavorite(activePlaylistId, "vod", movieId);
    favBtn.setAttribute("aria-pressed", String(fav));
    favBtn.textContent = fav ? "★ Favourited" : "☆ Favourite";
  }
  if (watchBtn && activePlaylistId) {
    const onList = isOnWatchlist(activePlaylistId, "vod", movieId);
    watchBtn.setAttribute("aria-pressed", String(onList));
    watchBtn.textContent = onList ? "✓ Watch Later" : "+ Watch Later";
  }
  if (trailerBtn) {
    trailerBtn.hidden = !detail.trailerYoutubeId;
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
    { id: movieId, category: row?.category || null, castNames: info.castNames, directorName: info.directorName },
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
      href: `/movies/detail?id=${encodeURIComponent(pick.id)}`,
      itemKey: `vod-${pick.id}`,
    })),
  );
}

async function loadDetail() {
  const active = await getActiveEntry();
  if (!active) {
    hideSkeleton();
    if (statusEl) statusEl.textContent = "No playlist selected.";
    return;
  }
  activePlaylistId = active._id as string;
  await ensurePrefsLoaded();
  await hydrateCache(activePlaylistId, "vod");
  const catalog = await loadCouchCatalog({
    kind: "vod",
    listAction: "get_vod_streams",
    categoriesAction: "get_vod_categories",
    ttlMs: VOD_TTL_MS,
    mapRow: mapMovieRow,
  });
  allRows = catalog?.rows ?? [];
  row = allRows.find((candidate) => candidate.id === movieId) ?? null;

  const cachedInfo = getCached(activePlaylistId, `vod_info_${movieId}`)?.data;
  let info: unknown = cachedInfo ?? null;
  if (!info) {
    try {
      const r = await xtreamApiFetch("get_vod_info", { vod_id: String(movieId) });
      if (r.ok) {
        info = await r.json();
        setCached(activePlaylistId, `vod_info_${movieId}`, info, VOD_INFO_TTL_MS);
      }
    } catch (err) {
      log.warn("[xt:couch-movie-detail] get_vod_info failed:", err);
    }
  }
  detail = movieDetailViewModel(info, row);
  paintHero();
  syncPlayButton();
  syncActionButtons();
  renderCast();
  renderSimilar();
}

function hidePlayer() {
  playerOpen = false;
  player?.dispose();
  player = null;
  if (playerWrap) playerWrap.hidden = true;
  syncPlayButton();
  playBtn?.focus();
}

async function startPlayback() {
  if (!row && !detail.title) return;
  if (playerOpen) return;
  const requestId = ++playRequestId;
  if (!creds.host || !creds.user || !creds.pass) {
    if (statusEl) statusEl.textContent = "No provider credentials — sign in to play.";
    return;
  }
  const src = buildMovieStreamUrl(creds, movieId, detail.containerExt);
  if (activePlaylistId) {
    pushRecent(activePlaylistId, "vod", movieId, detail.title, detail.poster);
  }
  const saved = activePlaylistId ? getProgress(activePlaylistId, "vod", movieId) : null;
  const resumeAt = resumePosition(saved);
  if (playerWrap) playerWrap.hidden = false;
  playerOpen = true;
  const created = await createCouchVodPlayer({
    logTag: "[xt:couch-movie-detail]",
    videoElementId: "movie-player",
    src,
    durationSeconds: detail.runtimeSeconds,
    resumeSeconds: resumeAt,
    autoplay: true,
    ids: {
      playPause: "movie-osd-play-pause",
      back10: "movie-osd-back10",
      fwd10: "movie-osd-fwd10",
      timeline: "movie-osd-timeline",
      timeLabel: "movie-osd-time",
      fullscreen: "movie-osd-fullscreen",
      back: "movie-osd-back",
      subtitles: "movie-osd-subtitles",
      audio: "movie-osd-audio",
      subtitlesList: "movie-osd-subtitles-list",
      audioList: "movie-osd-audio-list",
    },
    onProgress: (position, duration) => {
      if (!activePlaylistId) return;
      setProgress(activePlaylistId, "vod", movieId, position, duration, {
        name: detail.title,
        logo: detail.poster,
      });
    },
    onEnded: () => {
      if (activePlaylistId) markCompleted(activePlaylistId, "vod", movieId, { name: detail.title, logo: detail.poster });
      hidePlayer();
    },
    onExit: () => hidePlayer(),
    onError: (message) => {
      if (requestId !== playRequestId) return;
      if (statusEl) statusEl.textContent = message;
      hidePlayer();
    },
  });
  if (requestId !== playRequestId) {
    created?.dispose();
    return;
  }
  if (!created) {
    // External backend or mount failure: the player stays hidden and the
    // status line says so — never a silent dead Play button.
    hidePlayer();
    return;
  }
  player = created;
}

// B / Escape while the player is open exits the player to the detail —
// never to Home. Capture phase so the global back handler does not fire first.
document.addEventListener(
  "keydown",
  (ev) => {
    if (!playerOpen) return;
    if (ev.key === "Escape" || ev.key === "BrowserBack") {
      ev.preventDefault();
      ev.stopPropagation();
      hidePlayer();
    }
  },
  true,
);

playBtn?.addEventListener("click", () => {
  void startPlayback();
});
favBtn?.addEventListener("click", () => {
  if (!activePlaylistId) return;
  toggleFavorite(activePlaylistId, "vod", movieId, { name: detail.title, logo: detail.poster });
  syncActionButtons();
});
watchBtn?.addEventListener("click", () => {
  if (!activePlaylistId) return;
  toggleWatchlist(activePlaylistId, "vod", movieId, { name: detail.title, logo: detail.poster });
  syncActionButtons();
});
trailerBtn?.addEventListener("click", () => {
  if (!detail.trailerYoutubeId || !trailerFrame) return;
  trailerFrame.src = `https://www.youtube.com/embed/${encodeURIComponent(detail.trailerYoutubeId)}?autoplay=1`;
  openCouchDialog("movie-trailer-dialog", trailerBtn);
});
document.getElementById("movie-trailer-dialog")?.addEventListener("close", () => {
  if (trailerFrame) trailerFrame.src = "";
});

(async () => {
  await initI18n().catch(() => {});
  creds = await loadCreds();
  // Back to Browse: history.back() when we arrived from the Browse
  // grid, so couch-focus memory restores the exact card; otherwise
  // the link follows its href. (detailBackDecision is the tested half.)
  wireDetailBackLink($("movie-detail-back"), "/browse");
  if (!movieId) {
    hideSkeleton();
    if (statusEl) statusEl.textContent = "No movie selected.";
    return;
  }
  await loadDetail();
})();
