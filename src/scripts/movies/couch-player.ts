// Couch VOD player — playback controls on the TvVodOsd shell (W4,
// split from the Live TV TvOsd in 0.11.2 W3).
//
// The streaming engine is NOT rewritten here: playback mounts through
// the shared `mountPlayer` (video.js / artplayer / shaka, per the user's
// configured backend) and the source is fed to its `VjsLikeHandle`.
// This module only owns the Couch control surface: the TvVodOsd buttons
// (play/pause, ±10s seek, timeline, subtitles, audio, fullscreen,
// back, next episode), progress reporting, resume-seek, and the
// ended -> next-episode handoff. The engine keeps its own control bar
// (mountPlayer builds it per backend); the TvVodOsd is the
// controller-first surface — every button is a real focusable element
// the D-pad can reach, and the OSD never hides while focus is inside
// it (TvVodOsd shell behaviour).
//
// Subtitle / audio controls only appear when the mounted media element
// actually exposes tracks — nothing is invented for a stream that has
// none. Seeking is VOD-only: this module is never used for live.

import {
  mountPlayer,
  playWhenReady,
  type VjsLikeHandle,
  type PlayerBackend,
} from "@/scripts/lib/player-runtime.ts";
import { getPlayerBackend } from "@/scripts/lib/app-settings.js";
import { formatClock } from "@/scripts/movies/couch-movies.ts";
import { log } from "@/scripts/lib/log.js";

export interface CouchVodPlayerIds {
  playPause: string;
  back10: string;
  fwd10: string;
  timeline: string;
  timeLabel: string;
  fullscreen: string;
  back: string;
  /** Optional: series "Next Episode" button. */
  next?: string;
  /** Optional: subtitle-track menu button. Hidden when no tracks. */
  subtitles?: string;
  /** Optional: audio-track menu button. Hidden when no tracks. */
  audio?: string;
  /** Optional: autoplay-next toggle (series). */
  autoplayToggle?: string;
  /** Optional: subtitle-track list container (populated by this module). */
  subtitlesList?: string;
  /** Optional: audio-track list container (populated by this module). */
  audioList?: string;
}

export interface CouchVodPlayerOptions {
  logTag: string;
  videoElementId: string;
  src: string;
  /** Known duration in seconds (provider info); seeds the timeline when the container reports none. */
  durationSeconds?: number | null;
  resumeSeconds?: number;
  autoplay?: boolean;
  ids: CouchVodPlayerIds;
  /** Throttled progress writes are the caller's job (preferences). */
  onProgress: (positionSeconds: number, durationSeconds: number) => void;
  /** Playback reached the end (and was not a premature-ended blip the caller filtered). */
  onEnded: () => void;
  /** Back pressed: the caller hides the player and returns to the detail — never to Home. */
  onExit: () => void;
  /** Next-episode pressed (series only). */
  onNext?: () => void;
  /** Autoplay-next toggle changed (series only). */
  onAutoplayChange?: (enabled: boolean) => void;
  /** Initial autoplay-next state (series only). */
  autoplayNext?: boolean;
  /** Called with a human error string when the mount or source fails. */
  onError?: (message: string) => void;
}

export interface CouchVodPlayerHandle {
  dispose: () => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seekBy: (deltaSeconds: number) => void;
  seekTo: (seconds: number) => void;
  isPaused: () => boolean;
  mediaElement: () => HTMLVideoElement | null;
}

const SEEK_STEP_SECONDS = 10;
const PROGRESS_REPORT_MS = 5000;

function byId(id: string | undefined): HTMLElement | null {
  if (!id) return null;
  return document.getElementById(id);
}

function mimeForUrl(url: string): string {
  const path = (url.split("?")[0] ?? "").toLowerCase();
  if (path.endsWith(".m3u8")) return "application/x-mpegURL";
  if (path.endsWith(".mpd")) return "application/dash+xml";
  if (path.endsWith(".ts")) return "video/mp2t";
  if (path.endsWith(".mkv")) return "video/x-matroska";
  if (path.endsWith(".webm")) return "video/webm";
  return "video/mp4";
}

export async function createCouchVodPlayer(
  opts: CouchVodPlayerOptions,
): Promise<CouchVodPlayerHandle | null> {
  const videoEl = document.getElementById(opts.videoElementId) as HTMLVideoElement | null;
  if (!videoEl) {
    log.warn(`${opts.logTag} no video element #${opts.videoElementId}`);
    opts.onError?.("Player element missing.");
    return null;
  }
  const backend = getPlayerBackend() as PlayerBackend;
  let mounted: Awaited<ReturnType<typeof mountPlayer>>;
  try {
    mounted = await mountPlayer(videoEl, backend, {
      liveui: false,
      fluid: true,
      preload: "auto",
      autoplay: false,
      aspectRatio: "16:9",
    });
  } catch (err) {
    log.warn(`${opts.logTag} mountPlayer failed:`, err);
    opts.onError?.("Player failed to start.");
    return null;
  }
  if (mounted.kind !== "embedded") {
    // External backend (mpv/vlc): the launcher owns playback; the Couch
    // OSD has nothing to drive. The caller falls back to its own
    // external-launch path instead.
    opts.onError?.("External player backend selected.");
    return null;
  }
  const handle: VjsLikeHandle = mounted.handle;
  const media = (): HTMLVideoElement | null => handle.getMediaElement?.() ?? videoEl;

  let disposed = false;
  let duration = opts.durationSeconds && opts.durationSeconds > 0 ? opts.durationSeconds : 0;
  let lastReportAt = 0;
  let autoplayNext = opts.autoplayNext ?? false;

  const playPauseBtn = byId(opts.ids.playPause) as HTMLButtonElement | null;
  const back10Btn = byId(opts.ids.back10) as HTMLButtonElement | null;
  const fwd10Btn = byId(opts.ids.fwd10) as HTMLButtonElement | null;
  const timeline = byId(opts.ids.timeline) as HTMLInputElement | null;
  const timeLabel = byId(opts.ids.timeLabel);
  const fullscreenBtn = byId(opts.ids.fullscreen) as HTMLButtonElement | null;
  const backBtn = byId(opts.ids.back) as HTMLButtonElement | null;
  const nextBtn = byId(opts.ids.next) as HTMLButtonElement | null;
  const subtitlesBtn = byId(opts.ids.subtitles) as HTMLButtonElement | null;
  const audioBtn = byId(opts.ids.audio) as HTMLButtonElement | null;
  const autoplayBtn = byId(opts.ids.autoplayToggle) as HTMLButtonElement | null;
  const subtitlesList = byId(opts.ids.subtitlesList);
  const audioList = byId(opts.ids.audioList);

  const paint = () => {
    const m = media();
    const pos = m ? m.currentTime || 0 : handle.currentTime?.() || 0;
    const dur = duration > 0 ? duration : m?.duration && Number.isFinite(m.duration) ? m.duration : 0;
    if (timeline) {
      timeline.max = String(Math.max(1, Math.floor(dur)));
      if (document.activeElement !== timeline) {
        timeline.value = String(Math.floor(pos));
      }
    }
    if (timeLabel) {
      timeLabel.textContent = dur > 0 ? `${formatClock(pos)} / ${formatClock(dur)}` : formatClock(pos);
    }
    if (playPauseBtn) {
      const paused = m ? m.paused : handle.paused?.() !== false;
      playPauseBtn.textContent = paused ? "▶ Play" : "❚❚ Pause";
      playPauseBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
    }
  };

  const reportProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < PROGRESS_REPORT_MS) return;
    lastReportAt = now;
    const m = media();
    const pos = m ? m.currentTime || 0 : handle.currentTime?.() || 0;
    const dur = duration > 0 ? duration : m?.duration && Number.isFinite(m.duration) ? m.duration : 0;
    if (dur > 0) opts.onProgress(pos, dur);
  };

  const togglePlay = () => {
    const m = media();
    if (m ? m.paused : handle.paused?.() !== false) {
      playWhenReady(handle);
    } else {
      handle.pause();
    }
    paint();
  };

  const seekBy = (delta: number) => {
    const m = media();
    const pos = m ? m.currentTime || 0 : handle.currentTime?.() || 0;
    const dur = duration > 0 ? duration : m?.duration && Number.isFinite(m.duration) ? m.duration : 0;
    const next = Math.max(0, dur > 0 ? Math.min(dur, pos + delta) : pos + delta);
    if (m) m.currentTime = next;
    else handle.currentTime?.(next);
    paint();
    reportProgress(true);
  };

  const seekTo = (seconds: number) => {
    const m = media();
    const dur = duration > 0 ? duration : m?.duration && Number.isFinite(m.duration) ? m.duration : 0;
    const next = Math.max(0, dur > 0 ? Math.min(dur, seconds) : seconds);
    if (m) m.currentTime = next;
    else handle.currentTime?.(next);
    paint();
    reportProgress(true);
  };

  // --- Track menus: only what the media element actually exposes. ---
  const refreshTrackMenus = () => {
    const m = media();
    if (subtitlesBtn) {
      const tracks = m?.textTracks ? Array.from(m.textTracks) : [];
      const usable = tracks.filter((t) => t.kind === "subtitles" || t.kind === "captions");
      subtitlesBtn.hidden = usable.length === 0;
      if (subtitlesList) {
        subtitlesList.replaceChildren();
        const off = document.createElement("button");
        off.type = "button";
        off.className = "rs-osd__btn";
        off.textContent = "Subtitles off";
        off.addEventListener("click", () => {
          for (const t of usable) t.mode = "disabled";
          paintTrackStates();
        });
        subtitlesList.appendChild(off);
        usable.forEach((track, i) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "rs-osd__btn";
          btn.textContent = track.label || track.language || `Subtitle ${i + 1}`;
          btn.setAttribute("aria-pressed", track.mode === "showing" ? "true" : "false");
          btn.addEventListener("click", () => {
            for (const t of usable) t.mode = "disabled";
            track.mode = "showing";
            paintTrackStates();
          });
          subtitlesList.appendChild(btn);
        });
      }
    }
    if (audioBtn) {
      const tracks: any[] = (m as any)?.audioTracks
        ? Array.from((m as any).audioTracks)
        : [];
      audioBtn.hidden = tracks.length <= 1;
      if (audioList) {
        audioList.replaceChildren();
        tracks.forEach((track: any, i: number) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "rs-osd__btn";
          btn.textContent = track.label || track.language || `Audio ${i + 1}`;
          btn.setAttribute("aria-pressed", track.enabled ? "true" : "false");
          btn.addEventListener("click", () => {
            for (const t of tracks) t.enabled = false;
            track.enabled = true;
            paintTrackStates();
          });
          audioList.appendChild(btn);
        });
      }
    }
  };

  const paintTrackStates = () => {
    refreshTrackMenus();
  };

  const syncAutoplayBtn = () => {
    if (!autoplayBtn) return;
    autoplayBtn.setAttribute("aria-pressed", String(autoplayNext));
    autoplayBtn.textContent = `Autoplay next: ${autoplayNext ? "On" : "Off"}`;
  };

  // --- Wire the OSD controls. ---
  const disposers: Array<() => void> = [];
  const on = (
    target: HTMLElement | null,
    event: string,
    fn: (ev: Event) => void,
  ) => {
    if (!target) return;
    target.addEventListener(event, fn);
    disposers.push(() => target.removeEventListener(event, fn));
  };

  on(playPauseBtn, "click", togglePlay);
  on(back10Btn, "click", () => seekBy(-SEEK_STEP_SECONDS));
  on(fwd10Btn, "click", () => seekBy(SEEK_STEP_SECONDS));
  on(fullscreenBtn, "click", () => {
    try {
      const h = handle as any;
      if (typeof h.requestFullscreen === "function") void h.requestFullscreen();
      else if (handle.isFullscreen?.()) handle.exitFullscreen?.();
      else void media()?.requestFullscreen?.();
    } catch {
      // Fullscreen unavailable in this runtime — non-fatal.
    }
  });
  on(backBtn, "click", () => {
    try {
      handle.pause();
    } catch {}
    opts.onExit();
  });
  if (nextBtn) {
    nextBtn.hidden = !opts.onNext;
    on(nextBtn, "click", () => opts.onNext?.());
  }
  if (autoplayBtn) {
    syncAutoplayBtn();
    on(autoplayBtn, "click", () => {
      autoplayNext = !autoplayNext;
      syncAutoplayBtn();
      opts.onAutoplayChange?.(autoplayNext);
    });
  }
  on(timeline, "input", () => {
    if (timeline) seekTo(Number(timeline.value) || 0);
  });
  on(timeline, "change", () => reportProgress(true));

  // X = contextual playback action (play/pause) while the player is up.
  // B/Escape is owned by the page: it exits the player to the detail.
  const onKey = (ev: KeyboardEvent) => {
    if (disposed) return;
    if (ev.key === "x" || ev.key === "X") {
      togglePlay();
      ev.preventDefault();
    }
  };
  document.addEventListener("keydown", onKey);
  disposers.push(() => document.removeEventListener("keydown", onKey));

  // --- Engine events. ---
  const onTimeUpdate = () => {
    const m = media();
    if (m && Number.isFinite(m.duration) && m.duration > 0) duration = m.duration;
    paint();
    reportProgress();
  };
  const onPlay = () => paint();
  const onPause = () => {
    paint();
    reportProgress(true);
  };
  const onEnded = () => {
    reportProgress(true);
    opts.onEnded();
  };
  const onLoadedMetadata = () => {
    refreshTrackMenus();
    const m = media();
    if (m && Number.isFinite(m.duration) && m.duration > 0) duration = m.duration;
    paint();
  };
  try {
    handle.on("timeupdate", onTimeUpdate);
    handle.on("play", onPlay);
    handle.on("pause", onPause);
    handle.on("ended", onEnded);
    handle.on("loadedmetadata", onLoadedMetadata);
  } catch {
    const m = media();
    m?.addEventListener("timeupdate", onTimeUpdate);
    m?.addEventListener("play", onPlay);
    m?.addEventListener("pause", onPause);
    m?.addEventListener("ended", onEnded);
    m?.addEventListener("loadedmetadata", onLoadedMetadata);
  }

  // --- Load the source, resume, and play. ---
  try {
    handle.src({
      src: opts.src,
      type: mimeForUrl(opts.src),
      isLive: false,
      durationSeconds: duration > 0 ? duration : undefined,
    });
  } catch (err) {
    log.warn(`${opts.logTag} handle.src failed:`, err);
    opts.onError?.("Could not load this stream.");
    return null;
  }
  const resumeAt = Math.max(0, opts.resumeSeconds || 0);
  if (resumeAt > 0) {
    const applyResume = () => {
      try {
        const m = media();
        if (m) m.currentTime = resumeAt;
        else handle.currentTime?.(resumeAt);
      } catch {}
    };
    try {
      handle.one?.("loadedmetadata", applyResume);
    } catch {}
    const m = media();
    if (m && m.readyState >= 1) applyResume();
    else m?.addEventListener("loadedmetadata", applyResume, { once: true });
  }
  if (opts.autoplay !== false) playWhenReady(handle);
  refreshTrackMenus();
  paint();
  window.dispatchEvent(new CustomEvent("couch-osd:show"));

  return {
    dispose: () => {
      disposed = true;
      disposers.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
      try {
        handle.off?.("timeupdate", onTimeUpdate);
        handle.off?.("play", onPlay);
        handle.off?.("pause", onPause);
        handle.off?.("ended", onEnded);
        handle.off?.("loadedmetadata", onLoadedMetadata);
      } catch {}
      try {
        handle.pause();
      } catch {}
      // 0.11.2 W3 — pause alone leaves the engine attached with its
      // source loaded, so the provider connection stays held after
      // exit and the next play (live or VOD) can be refused as
      // connection-limit ("already open"). reset() destroys the
      // hls / shaka / mpegts engines and unloads the source while
      // keeping the <video> element for the next mount — dispose()
      // would remove the element the detail page reuses.
      try {
        handle.reset?.();
      } catch {}
    },
    play: () => playWhenReady(handle),
    pause: () => {
      try {
        handle.pause();
      } catch {}
      paint();
    },
    togglePlay,
    seekBy,
    seekTo,
    isPaused: () => {
      const m = media();
      return m ? m.paused : handle.paused?.() !== false;
    },
    mediaElement: media,
  };
}
