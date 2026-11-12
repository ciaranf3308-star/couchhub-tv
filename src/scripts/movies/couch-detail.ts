// Couch Movie detail — full-width backdrop detail page (W4).
//
// Reuses the app's existing data path: the cached VOD catalogue row,
// `get_vod_info` (cached 7d under `vod_info_<id>`, the same entry the
// legacy detail page reads/writes), preferences (favourites, Watch
// Later, recents, progress), the local "more like this" heuristic, and
// the shared Couch VOD player (mountPlayer engine + TvVodOsd controls).
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
import { resolveVodPlaySrc } from "@/scripts/lib/stream-urls.ts";
import {
  couchVariantOptions,
  renderCouchVariantPicker,
} from "@/scripts/lib/couch-variants.ts";
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
  type MovieDetail,
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
  closeOpenTrackLists,
  type CouchVodPlayerHandle,
} from "@/scripts/movies/couch-player.ts";
import { renderCouchCards } from "@/scripts/movies/couch-cards.ts";
import { openCouchDialog } from "@/scripts/lib/couch-focus.ts";
import { installDetailBackLayers } from "@/scripts/lib/back-handler.ts";
import {
  navigateBackWithOrigin,
  recordRouteOrigin,
} from "@/scripts/lib/route-origin.ts";import {
  RETURN_HOME_HINT,
  setControllerHints,
  type HintConfig,
} from "@/scripts/lib/couch-button-hints.ts";

const MOVIE_DETAIL_HINTS: HintConfig = {
  id: "movies-detail",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Play / Select" },
    { glyph: "b", label: "Back" },
    { glyph: "x", label: "More options" },
    { glyph: "y", label: "Search Movies" },
    { glyph: "menu", label: "Settings" },
    RETURN_HOME_HINT,
  ],
};

const MOVIE_PLAYBACK_HINTS: HintConfig = {
  id: "movies-detail-playback",
  items: [
    { glyph: "dpad", label: "Move" },
    { glyph: "a", label: "Show controls" },
    { glyph: "b", label: "Exit player" },
    { glyph: "x", label: "Play / Pause" },
    { glyph: "y", label: "Fullscreen" },
    { glyph: "lb", label: "Seek −10s" },
    { glyph: "rb", label: "Seek +10s" },
    { glyph: "lt-rt", label: "Volume" },
    RETURN_HOME_HINT,
  ],
};

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
const variantsSection = $("movie-detail-variants");
const variantsListEl = $("movie-detail-variants-list");
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

async function loadVodInfo(id: number): Promise<unknown> {
  const cachedInfo = getCached(activePlaylistId, `vod_info_${id}`)?.data;
  if (cachedInfo) return cachedInfo;
  try {
    const r = await xtreamApiFetch("get_vod_info", { vod_id: String(id) });
    if (r.ok) {
      const info = await r.json();
      setCached(activePlaylistId, `vod_info_${id}`, info, VOD_INFO_TTL_MS);
      return info;
    }
  } catch (err) {
    log.warn("[xt:couch-movie-detail] get_vod_info failed:", err);
  }
  return null;
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

  const info = await loadVodInfo(movieId);
  detail = movieDetailViewModel(info, row);
  paintHero();
  syncPlayButton();
  syncActionButtons();
  renderCast();
  renderSimilar();
  renderVariants();
  setControllerHints(MOVIE_DETAIL_HINTS);
  // Entry focus (§18): Play/Resume, when focus is still on <body>
  // or the top nav (never steal focus the viewer already moved).
  const activeEl = document.activeElement as HTMLElement | null;
  const inNav = !!activeEl?.closest?.("[data-couch-nav]");
  if ((!activeEl || activeEl === document.body || inNav) && playBtn) {
    playBtn.focus({ preventScroll: true });
  }
}

function renderVariants() {
  const options = couchVariantOptions(allRows, "vod", movieId);
  if (!options || !variantsSection || !variantsListEl) {
    if (variantsSection) variantsSection.hidden = true;
    return;
  }
  const rendered = renderCouchVariantPicker(
    variantsListEl,
    options,
    (variantId) => {
      void playVariant(Number(variantId));
    }
  );
  variantsSection.hidden = !rendered;
}

async function playVariant(variantId: number) {
  if (playerOpen || variantId === movieId) return;
  const variantRow = allRows.find((candidate) => candidate.id === variantId) ?? null;
  const info = await loadVodInfo(variantId);
  const variantDetail = movieDetailViewModel(info, variantRow);
  await startPlayback(variantId, variantDetail);
}

function hidePlayer() {
  // Bumping the request id retires any mount still awaiting its
  // pipeline (probe / tee-proxy) so it can never load a source after
  // the user has already left the player.
  playRequestId += 1;
  playerOpen = false;
  player?.dispose();
  player = null;
  if (playerWrap) playerWrap.hidden = true;
  syncPlayButton();
  setControllerHints(MOVIE_DETAIL_HINTS);
  playBtn?.focus();
}

async function startPlayback(variantId: number = movieId, variantDetail: MovieDetail = detail) {
  if (variantId === movieId && !row && !detail.title) return;
  if (playerOpen) return;
  const requestId = ++playRequestId;
  if (!creds.host || !creds.user || !creds.pass) {
    if (statusEl) statusEl.textContent = "No provider credentials — sign in to play.";
    return;
  }
  // Provider stream_url override wins; a missing container extension
  // is probed from the first bytes instead of trusting the .mp4 default.
  const { src } = await resolveVodPlaySrc({
    creds,
    kind: "movie",
    id: variantId,
    containerExt: variantDetail.containerExt,
    streamUrl: variantDetail.streamUrl,
  });
  if (requestId !== playRequestId) return;
  if (activePlaylistId) {
    pushRecent(activePlaylistId, "vod", variantId, variantDetail.title, variantDetail.poster);
  }
  const saved = activePlaylistId ? getProgress(activePlaylistId, "vod", variantId) : null;
  const resumeAt = resumePosition(saved);
  if (playerWrap) playerWrap.hidden = false;
  playerOpen = true;
  const created = await createCouchVodPlayer({
    logTag: "[xt:couch-movie-detail]",
    videoElementId: "movie-player",
    src,
    durationSeconds: variantDetail.runtimeSeconds,
    resumeSeconds: resumeAt,
    autoplay: true,
    remux: {
      playlistId: activePlaylistId || null,
      contentKind: "movie",
      contentId: variantId,
      nameHintSource: variantDetail.title,
      onRemuxRetry: () => {
        // The player disposed itself after pinning this content to
        // remux; re-run the same tune — the pin makes the next plan
        // choose the ffmpeg remux path.
        player = null;
        playerOpen = false;
        void startPlayback(variantId, variantDetail);
      },
    },
    isStale: () => requestId !== playRequestId,
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
      setProgress(activePlaylistId, "vod", variantId, position, duration, {
        name: variantDetail.title,
        logo: variantDetail.poster,
      });
    },
    onEnded: () => {
      if (activePlaylistId) markCompleted(activePlaylistId, "vod", variantId, { name: variantDetail.title, logo: variantDetail.poster });
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
  setControllerHints(MOVIE_PLAYBACK_HINTS);
}

// Back stack (0.11.10 §18–§19): B closes an open track list first,
// then exits playback to the detail, then (player closed) performs
// the same navigation as the Back button via route provenance —
// without requiring focus on the Back button. The pre-0.11.10
// capture handler only ran while the player was open, so B on a
// closed detail did nothing at all.
installDetailBackLayers({
  isPlayerOpen: () => playerOpen,
  closePlaybackSubLayer: () =>
    closeOpenTrackLists(["movie-osd-subtitles-list", "movie-osd-audio-list"]),
  onPlayerBack: () => hidePlayer(),
  onDetailBack: () =>
    navigateBackWithOrigin("/movies", { backLink: $("movie-detail-back") }),
});

// X/Y while browsing the detail (0.11.10 §18): X opens the More
// options dialog (the contextual surface for this title), Y opens
// Search Movies. While playing, X/Y belong to the player
// (play/pause, fullscreen). gamepad.ts dispatches "x"/"y" keys
// first on detail pages (dispatch-first routing), so the
// controller reaches these handlers; keyboard X/Y work too.
document.addEventListener("keydown", (ev) => {
  if (ev.defaultPrevented || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (playerOpen) return;
  if (document.querySelector("dialog[open]")) return;
  const target = ev.target as HTMLElement | null;
  const tag = target?.tagName?.toLowerCase() ?? "";
  if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
    return;
  }
  if (ev.key === "x" || ev.key === "X") {
    const moreBtn = $("movie-detail-more") as HTMLButtonElement | null;
    if (!moreBtn) return;
    ev.preventDefault();
    ev.stopPropagation();
    moreBtn.click();
    return;
  }
  if (ev.key === "y" || ev.key === "Y") {
    ev.preventDefault();
    ev.stopPropagation();
    window.location.assign("/movies?view=browse&focus=search");
  }
});

// Provenance: a Similar/Versions click records this detail as the
// next detail's origin, so B returns here.
for (const listEl of [similarListEl, variantsListEl]) {
  listEl?.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href], button");
    if (!link) return;
    recordRouteOrigin({
      route: window.location.pathname + window.location.search,
      label: detail.title || "Movie",
    });
  });
}

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
  // Back to Movies: history.back() when we arrived from the Movies
  // grid, so couch-focus memory restores the exact card; otherwise
  // the link follows its href. (detailBackDecision is the tested half.)
  wireDetailBackLink($("movie-detail-back"), "/movies");
  if (!movieId) {
    hideSkeleton();
    if (statusEl) statusEl.textContent = "No movie selected.";
    return;
  }
  await loadDetail();
})();
