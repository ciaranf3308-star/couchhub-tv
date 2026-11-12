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
// 0.11.9 — the source is NO LONGER fed raw to the engine. Before
// handle.src(), playback runs the SAME pipeline the legacy detail
// pages use, composed from the same primitives (vod-mount.ts is a
// legacy-page orchestrator whose 30 callbacks assume legacy page
// state, so the Couch player composes the primitives directly rather
// than calling it with stubs): container plan, AVI alternative probe,
// tee-proxy prepare, one error listener delegating to the shared
// remux-recovery classifier (code 4 on MKV pins the content and
// retries through ffmpeg; code 3 gets the same treatment), stall
// watchdog, and the audio switcher for remux mode. Engine errors are
// always surfaced — never silent black again.
//
// Subtitle / audio controls only appear when the mounted media element
// actually exposes tracks — nothing is invented for a stream that has
// none. Seeking is VOD-only: this module is never used for live.

import {
  mountPlayer,
  playWhenReady,
  desktopPlatform,
  isWindows,
  type VjsLikeHandle,
  type PlayerBackend,
} from "@/scripts/lib/player-runtime.ts";
import { getPlayerBackend } from "@/scripts/lib/app-settings.js";
import { chooseMime } from "@/scripts/lib/morph-detail.js";
import {
  planVodContainerPlayback,
  detectVodContainer,
  type VodContainerPlan,
} from "@/scripts/lib/vod-container-plan.ts";
import { probeVodContainerAlternative, swapUrlExtension } from "@/scripts/lib/vod-container-probe.ts";
import { prepareVodPlayback, type VodProxySession } from "@/scripts/lib/vod-proxy.ts";
import { vodAudioRemuxAvailable } from "@/scripts/lib/vod-audio-proxy.ts";
import {
  createVodAudioSwitcher,
  discoverVodAudioTracks,
  type VodAudioSwitcher,
  type VodAudioTrackOption,
} from "@/scripts/lib/vod-audio-switch.ts";
import {
  buildRemuxContentKey,
  isRemuxPinnedContent,
  type RemuxContentKind,
} from "@/scripts/lib/vod-remux-memory.ts";
import {
  createRemuxFailureHandler,
  handlePlayerStartError,
  attachVodStallWatchdog,
} from "@/scripts/lib/vod-remux-recovery.ts";
import { createVodPlaybackToasts } from "@/scripts/lib/vod-playback-toasts.ts";
import type { StallWatchdogHandle } from "@/scripts/lib/stall-watchdog.ts";
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
  /**
   * Remux context (0.11.9). When present, the container plan can pin
   * this exact content to the ffmpeg remux path after a direct-playback
   * demux failure, and a code-4 MKV error retries through onRemuxRetry
   * (the detail page disposes this player and re-runs the tune). When
   * absent, playback still runs the container plan and surfaces errors,
   * but no pin/retry is possible.
   */
  remux?: CouchVodRemuxContext;
  /**
   * True once this mount has been superseded (a newer tune started).
   * Checked after every pipeline await so a stale mount never loads a
   * source. Defaults to the player's own disposed flag.
   */
  isStale?: () => boolean;
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

export interface CouchVodRemuxContext {
  playlistId: string | null;
  contentKind: RemuxContentKind;
  contentId: number | string;
  /** Name searched for an HEVC hint when no codec is reported (movie name / episode title). */
  nameHintSource: string;
  /**
   * Re-run the tune after this content was pinned to remux: dispose
   * this player and start playback again (the pin makes the next
   * container plan choose remux). At most one retry per tune — a
   * remux-mode failure is terminal.
   */
  onRemuxRetry: () => void;
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

/** Human error string carrying the real engine code/message — never a bare "failed". */
function describePlayerError(handle: VjsLikeHandle): string {
  const err = handle.error?.() as { code?: number; message?: string } | null | undefined;
  const message = typeof err?.message === "string" ? err.message.trim() : "";
  if (message) return `Playback error: ${message}`;
  if (typeof err?.code === "number") return `Playback failed (media error ${err.code}).`;
  return "Playback failed.";
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
  const isStaleNow = () => disposed || opts.isStale?.() === true;
  // Pipeline-owned state (0.11.9): the tee-proxy session, the audio
  // switcher, the stall watchdog and the discovery controller all die
  // with the player — disposePlayer tears them down in pipeline order.
  let ownAudioSwitcher: VodAudioSwitcher | null = null;
  let preparedPlayback: VodProxySession | null = null;
  let activeMkvSession: { stop(): void } | null | undefined = null;
  let stallWatchdogDetach: StallWatchdogHandle | null = null;
  let audioDiscoveryController: AbortController | null = null;
  let onPlayerErrorRef: ((...args: unknown[]) => void) | null = null;
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

  // --- Teardown (0.11.9: one path shared by dispose() and pipeline
  // aborts, so a mount that fails mid-pipeline releases the engine
  // exactly like a mount the user exits). ---
  const disposePlayer = () => {
    if (disposed) return;
    disposed = true;
    try {
      stallWatchdogDetach?.();
    } catch {}
    stallWatchdogDetach = null;
    try {
      audioDiscoveryController?.abort();
    } catch {}
    audioDiscoveryController = null;
    try {
      ownAudioSwitcher?.dispose();
    } catch {}
    ownAudioSwitcher = null;
    try {
      activeMkvSession?.stop();
    } catch {}
    activeMkvSession = null;
    preparedPlayback = null;
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
      if (onPlayerErrorRef) handle.off?.("error", onPlayerErrorRef);
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
  };

  // --- VOD pipeline (0.11.9). ---
  // Same primitives, same order, same decisions as mountVodPlayback
  // (vod-mount.ts) — composed here because that orchestrator's 30
  // callbacks assume legacy page state. Mount determines the embedded
  // backend first (above); the plan runs from here on.
  const toasts = createVodPlaybackToasts(() => {});
  const remux = opts.remux;
  const contentKey = remux
    ? buildRemuxContentKey(remux.contentKind, remux.contentId)
    : "";
  const nameHintSource = remux?.nameHintSource ?? "";
  const remuxAvailable = await vodAudioRemuxAvailable().catch(() => false);
  if (isStaleNow()) {
    disposePlayer();
    return null;
  }
  const forceRemux =
    remux?.playlistId != null
      ? isRemuxPinnedContent(remux.playlistId, contentKey)
      : false;
  const containerPlanEnv = {
    isTauriDesktop: desktopPlatform,
    isWindows,
    remuxAvailable,
    forceRemux,
  };
  let playSrc = opts.src;
  let containerPlan: VodContainerPlan = planVodContainerPlayback(
    playSrc,
    containerPlanEnv
  );
  let resolvedContainer: "mkv" | "mp4" | null = null;

  if (containerPlan.mode === "unsupported" && containerPlan.container === "avi") {
    const alternative = await probeVodContainerAlternative(playSrc).catch(
      () => null
    );
    if (isStaleNow()) {
      disposePlayer();
      return null;
    }
    if (alternative) {
      log.info(`${opts.logTag} avi source has a playable alternative container`, {
        container: alternative.container,
      });
      playSrc = alternative.url;
      resolvedContainer = alternative.container;
      const planningUrl =
        swapUrlExtension(alternative.url, alternative.container) ||
        alternative.url;
      containerPlan = planVodContainerPlayback(planningUrl, containerPlanEnv);
    }
  }

  const detectedContainer =
    containerPlan.mode === "unsupported"
      ? containerPlan.container
      : resolvedContainer || detectVodContainer(playSrc);
  log.info(`${opts.logTag} plan decided`, {
    mode: containerPlan.mode,
    container: detectedContainer,
    isTauriDesktop: desktopPlatform,
    isWindows,
    remuxAvailable,
    forceRemux,
  });
  if (containerPlan.mode === "unsupported") {
    toasts.showContainerUnsupportedToast(containerPlan.container);
    opts.onError?.("This title's format isn't supported on this device.");
    disposePlayer();
    return null;
  }
  // In remux mode the audio switcher owns the mount; touching src/playhead here would re-register the remux.
  const remuxOwnsInitialMount = containerPlan.mode === "remux";
  const mime =
    resolvedContainer === "mkv"
      ? "video/x-matroska"
      : resolvedContainer === "mp4"
        ? "video/mp4"
        : chooseMime(playSrc);

  // Error plumbing: one persistent "error" listener. The shared
  // classifier decides (pin + remux retry on code 4 MKV, remux-failure
  // toast on code 3 / remux mode); the wrapper guarantees an error is
  // ALWAYS surfaced to the detail page unless a remux retry is in
  // flight — handlePlayerStartError stays silent for other codes, and
  // silent black is the defect this fix removes.
  let startErrorSurfaced = false;
  let remuxRetryTriggered = false;
  const surfaceStartError = () => {
    if (startErrorSurfaced) return;
    startErrorSurfaced = true;
    opts.onError?.(describePlayerError(handle));
  };
  const handleRemuxFailure = createRemuxFailureHandler({
    player: handle,
    posterEl: null,
    playerWrap: null,
    getOwnAudioSwitcher: () => ownAudioSwitcher,
    clearAudioSwitcherIfOwn: (own) => {
      if (own === ownAudioSwitcher) ownAudioSwitcher = null;
    },
    getPipelineMkvSession: () => activeMkvSession,
    clearActiveMkvSessionIfMatches: (session) => {
      if (session === activeMkvSession) activeMkvSession = null;
    },
    nameHintSource,
    contentKey,
    recordGiveUp: (kind) => {
      log.info(`${opts.logTag} vod give-up`, { kind, contentKey });
    },
    endGiveUpSession: () => {},
    resolvedContainer,
    playSrc,
    toasts,
  });
  const wrappedRemuxFailure = (detail: string) => {
    handleRemuxFailure(detail);
    // The toast carries the specific reason; the status line must not
    // sit black, so the detail page hides the player too.
    surfaceStartError();
  };
  const handleStartError = () => {
    if (isStaleNow()) return;
    handlePlayerStartError({
      logTag: opts.logTag,
      player: handle,
      isStale: isStaleNow,
      containerPlanMode: containerPlan.mode,
      desktopPlatform,
      localDownloadPath: null,
      resolvedContainer,
      playSrc,
      remuxAvailable,
      activePlaylistId: remux?.playlistId ?? null,
      contentKey,
      posterEl: null,
      playerWrap: null,
      handleRemuxFailure: wrappedRemuxFailure,
      retirePreviousPlaybackAndRetryRemux: () => {
        remuxRetryTriggered = true;
        // Dispose this mount (releases the engine) before the detail
        // page re-runs the tune; the pin makes the next plan remux.
        disposePlayer();
        remux?.onRemuxRetry();
      },
      toasts,
    });
    if (!remuxRetryTriggered) surfaceStartError();
  };
  let pipelineReady = false;
  let bufferedStartError = false;
  const onPlayerError = () => {
    if (isStaleNow()) return;
    // A reused engine can emit a stale "error" while the tee-proxy
    // registration is in flight — buffer it and classify once the
    // pipeline is ready, exactly like the legacy mount.
    if (!pipelineReady) {
      bufferedStartError = true;
      return;
    }
    handleStartError();
  };
  onPlayerErrorRef = onPlayerError;
  let errorListenerAttached = false;
  try {
    handle.on("error", onPlayerError);
    errorListenerAttached = true;
  } catch (err) {
    log.warn(
      `${opts.logTag} handle error listener unavailable, using media element:`,
      err
    );
  }
  if (!errorListenerAttached) {
    const m = media();
    if (m) {
      const onMediaError = () => {
        if (isStaleNow()) return;
        // Degraded path: the handle never exposed errors, so no remux
        // retry is possible — surface the element's real error.
        const mediaError = m.error as { code?: number; message?: string } | null;
        opts.onError?.(
          mediaError?.message
            ? `Playback error: ${mediaError.message}`
            : typeof mediaError?.code === "number"
              ? `Playback failed (media error ${mediaError.code}).`
              : "Playback failed."
        );
      };
      m.addEventListener("error", onMediaError);
      disposers.push(() => m.removeEventListener("error", onMediaError));
    }
  }

  // Tee-proxy prepare: MKV/WebM sources get a local demux session
  // (subtitle cues + audio tracks); everything else passes through.
  preparedPlayback = await prepareVodPlayback(playSrc).catch((err) => {
    log.warn(
      `${opts.logTag} prepareVodPlayback failed, falling back to direct source:`,
      err
    );
    return null;
  });
  if (isStaleNow()) {
    disposePlayer();
    return null;
  }
  const playbackUrl = preparedPlayback?.playbackUrl ?? playSrc;
  activeMkvSession = preparedPlayback?.mkvSession ?? null;

  const resumeAt = Math.max(0, opts.resumeSeconds || 0);
  const buildAudioSwitcher = (
    tracks: VodAudioTrackOption[]
  ): VodAudioSwitcher =>
    createVodAudioSwitcher({
      handle,
      originalSrc: playbackUrl,
      originalMime: mime,
      originalSubtitles: {
        sourceUrl: playSrc,
        mkvSession: preparedPlayback?.mkvSession ?? null,
      },
      sourceUrl: playSrc,
      remuxInputUrl: preparedPlayback?.mkvSession ? playbackUrl : null,
      getKnownDurationSeconds: () => duration || handle.duration?.() || 0,
      tracks,
      mountRemuxImmediately: remuxOwnsInitialMount,
      initialStartSeconds: resumeAt,
      onRemuxUnrecoverable: (detail) => {
        log.warn(
          `${opts.logTag} remux playback unavailable for this source:`,
          detail
        );
        wrappedRemuxFailure(detail);
      },
    });
  let initialAudioSource: VodAudioSwitcher["source"] | null = null;
  if (remuxOwnsInitialMount) {
    ownAudioSwitcher = buildAudioSwitcher([]);
    initialAudioSource = ownAudioSwitcher.source;
  }

  pipelineReady = true;
  if (bufferedStartError) {
    handleStartError();
    disposePlayer();
    return null;
  }
  if (isStaleNow()) {
    disposePlayer();
    return null;
  }

  const mountEmbeddedSrc = () => {
    handle.src({
      src: playbackUrl,
      type: mime,
      isLive: false,
      durationSeconds: duration > 0 ? duration : undefined,
      subtitles: {
        sourceUrl: playSrc,
        mkvSession: preparedPlayback?.mkvSession ?? null,
      },
      audio: initialAudioSource,
    });
  };
  const video = media();
  if (video) {
    stallWatchdogDetach = attachVodStallWatchdog(video, {
      logTag: opts.logTag,
      player: handle,
      remuxOwnsInitialMount,
      isAudioSwitcherRecovering: () => ownAudioSwitcher?.isRecovering() ?? false,
      recoverRemuxStall: () => {
        ownAudioSwitcher?.recoverRemuxStall();
      },
      mountEmbeddedSrc,
    });
  }

  if (!remuxOwnsInitialMount) {
    try {
      mountEmbeddedSrc();
    } catch (err) {
      log.warn(`${opts.logTag} handle.src failed:`, err);
      opts.onError?.("Could not load this stream.");
      disposePlayer();
      return null;
    }
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
  }

  // Fire-and-forget network probe that must never sit ahead of the mount above.
  if (remuxAvailable) {
    audioDiscoveryController = new AbortController();
    void discoverVodAudioTracks(
      preparedPlayback?.mkvSession ?? null,
      playSrc,
      audioDiscoveryController.signal
    )
      .then((audioTracks) => {
        if (isStaleNow()) return;
        if (remuxOwnsInitialMount) {
          if (audioTracks.length > 0) ownAudioSwitcher?.setTracks(audioTracks);
          return;
        }
        if (audioTracks.length < 2) return;
        ownAudioSwitcher = buildAudioSwitcher(audioTracks);
        handle.setAudioSource?.(ownAudioSwitcher.source);
      })
      .catch(() => {});
  }

  refreshTrackMenus();
  paint();
  window.dispatchEvent(new CustomEvent("couch-osd:show"));

  return {
    dispose: disposePlayer,
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
