// Nylah Studios — shared pause overlay for the in-app players.
import { t } from "@/scripts/lib/i18n.js"
//
// Controller-first transport hub: when the video pauses, a couch-legible
// card appears over the picture with the title, the now-playing info, a
// progress bar (elapsed / total, only when the media reports a finite
// duration — live streams show a LIVE badge instead) and big transport
// buttons (Back 10s / Resume / Forward 10s) that do exactly what the
// gamepad LB / X / RB buttons do. It never touches the playback engine:
// it only listens to the <video> element's own play/pause/timeupdate
// events and calls play()/pause() / currentTime on it, the same calls the
// gamepad layer already makes.
//
// The video element is found lazily (the player backends mount it
// asynchronously), so the overlay is armed once per player wrap and
// re-attaches whenever a new <video> appears under the wrap.
//
// No data is invented here: title / subtitle / badge all come from
// caller-supplied getters that read text already on the page (channel
// name, EPG now-playing row, detail title + meta). The "more like this"
// row is deliberately NOT built here — there is no similar-titles data
// on the Live TV page, and plumbing new data in would be new work, not
// a reskin.

export interface PauseOverlayOptions {
  /** Player container; the overlay is positioned inside it. */
  wrap: HTMLElement | null
  /** Big serif title, e.g. channel name or movie title. */
  getTitle: () => string
  /** One line under the title, e.g. now-playing programme + times. */
  getSubtitle: () => string
  /** Short badge shown above the title ("LIVE", "MOVIE", ...). */
  getBadge?: () => string | null
  /** When true the overlay never shows (e.g. radio/audio-only mode). */
  isSuppressed?: () => boolean
  /** When false the overlay never shows (e.g. player still hidden). */
  isPlayerVisible?: () => boolean
  /** Localised labels; resolved lazily on every show so the page's locale
      (initialised by the main player script) applies instead of whatever
      was active at mount time. English defaults keep the overlay working
      when a locale has no key yet (t() falls back to en.json anyway). */
  labels?: {
    paused?: string
    resume?: string
    back10?: string
    forward10?: string
    hints?: string
    live?: string
  }
}

const STYLE_ID = "nylah-pause-overlay-style"

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = `
.nylah-pause-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
}
.nylah-pause-overlay[data-open="true"] { opacity: 1; }
.nylah-pause-card {
  pointer-events: auto;
  width: min(34rem, 100%);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.5rem 1.75rem;
  border-radius: 1.25rem;
  border: 1px solid var(--color-line);
  background: color-mix(in oklch, var(--color-bg) 82%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  box-shadow:
    0 0 0 1px color-mix(in oklch, var(--color-accent) 35%, transparent),
    0 0 48px 4px color-mix(in oklch, var(--color-accent) 30%, transparent),
    0 24px 64px -16px rgb(0 0 0 / 0.6);
}
.nylah-pause-badge {
  align-self: flex-start;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--color-on-accent, #fff);
  background: var(--color-accent);
  border-radius: 999px;
  padding: 0.3rem 0.75rem;
}
.nylah-pause-title {
  font-family: var(--font-serif);
  font-size: clamp(1.75rem, 3.4vw, 2.75rem);
  line-height: 1.05;
  letter-spacing: -0.02em;
  color: var(--color-fg);
  overflow-wrap: break-word;
}
.nylah-pause-sub {
  font-size: 1rem;
  line-height: 1.45;
  color: var(--color-fg-2);
  overflow-wrap: break-word;
}
.nylah-pause-progress { display: flex; flex-direction: column; gap: 0.4rem; }
.nylah-pause-times {
  display: flex;
  justify-content: space-between;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-fg-2);
}
.nylah-pause-times strong { color: var(--color-fg); font-weight: 600; }
.nylah-pause-bar {
  height: 0.625rem;
  border-radius: 999px;
  background: color-mix(in oklch, var(--color-fg) 18%, transparent);
  overflow: hidden;
}
.nylah-pause-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: var(--color-accent);
  transition: width 200ms linear;
}
.nylah-pause-transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding-top: 0.25rem;
}
.nylah-pause-btn {
  min-height: 3.5rem;
  min-width: 3.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1.1rem;
  border-radius: 0.9rem;
  border: 1px solid var(--color-line);
  background: var(--color-surface-2);
  color: var(--color-fg);
  font-size: 1rem;
  font-weight: 600;
  outline: none;
  transition: border-color 150ms, background-color 150ms, transform 100ms;
}
.nylah-pause-btn:hover { background: var(--color-surface-3); }
.nylah-pause-btn:focus-visible {
  border-color: var(--color-accent);
  box-shadow:
    0 0 0 2px var(--color-accent),
    0 0 24px 4px color-mix(in oklch, var(--color-accent) 45%, transparent);
}
.nylah-pause-btn:active { transform: scale(0.97); }
.nylah-pause-btn--primary {
  min-width: 9rem;
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent, #fff);
  font-size: 1.125rem;
}
.nylah-pause-btn--primary:hover { opacity: 0.92; background: var(--color-accent); }
.nylah-pause-hints {
  text-align: center;
  font-size: 0.8125rem;
  color: var(--color-fg-3);
}
@media (prefers-reduced-motion: reduce) {
  .nylah-pause-overlay { transition: none; }
  .nylah-pause-fill { transition: none; }
}
`
  document.head.appendChild(style)
}

export function formatPauseClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00"
  const total = Math.floor(totalSeconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes)
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`
}

export function mountPauseOverlay(opts: PauseOverlayOptions): () => void {
  const { wrap } = opts
  if (!wrap) return () => {}
  ensureStyle()

  const overrides = opts.labels || {}
  // Resolved on every show, not at mount: the page's main script
  // initialises i18n asynchronously, and mount happens before it.
  const resolveLabels = () => ({
    paused: overrides.paused ?? t("player.pauseOverlay.paused"),
    resume: overrides.resume ?? t("player.pauseOverlay.resume"),
    back10: overrides.back10 ?? t("player.pauseOverlay.back10"),
    forward10: overrides.forward10 ?? t("player.pauseOverlay.forward10"),
    hints: overrides.hints ?? t("player.pauseOverlay.hints"),
    live: overrides.live ?? t("player.pauseOverlay.live"),
  })

  const overlay = document.createElement("div")
  overlay.className = "nylah-pause-overlay"
  overlay.dataset.open = "false"
  overlay.setAttribute("role", "dialog")
  overlay.hidden = true

  const card = document.createElement("div")
  card.className = "nylah-pause-card"

  const badge = document.createElement("span")
  badge.className = "nylah-pause-badge"
  card.appendChild(badge)

  const titleEl = document.createElement("div")
  titleEl.className = "nylah-pause-title"
  card.appendChild(titleEl)

  const subEl = document.createElement("div")
  subEl.className = "nylah-pause-sub"
  card.appendChild(subEl)

  const progress = document.createElement("div")
  progress.className = "nylah-pause-progress"
  const times = document.createElement("div")
  times.className = "nylah-pause-times"
  const elapsedEl = document.createElement("span")
  const totalEl = document.createElement("span")
  times.append(elapsedEl, totalEl)
  const bar = document.createElement("div")
  bar.className = "nylah-pause-bar"
  bar.setAttribute("role", "progressbar")
  const fill = document.createElement("div")
  fill.className = "nylah-pause-fill"
  bar.appendChild(fill)
  progress.append(times, bar)
  card.appendChild(progress)

  const transport = document.createElement("div")
  transport.className = "nylah-pause-transport"

  const backBtn = document.createElement("button")
  backBtn.type = "button"
  backBtn.className = "nylah-pause-btn"
  backBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg><span aria-hidden="true">−10s</span>'
  const resumeBtn = document.createElement("button")
  resumeBtn.type = "button"
  resumeBtn.className = "nylah-pause-btn nylah-pause-btn--primary"
  resumeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>'
  const resumeLabel = document.createElement("span")
  resumeBtn.appendChild(resumeLabel)
  const fwdBtn = document.createElement("button")
  fwdBtn.type = "button"
  fwdBtn.className = "nylah-pause-btn"
  fwdBtn.innerHTML =
    '<span aria-hidden="true">+10s</span><svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/></svg>'
  transport.append(backBtn, resumeBtn, fwdBtn)
  card.appendChild(transport)

  const hints = document.createElement("div")
  hints.className = "nylah-pause-hints"
  card.appendChild(hints)

  overlay.appendChild(card)
  wrap.appendChild(overlay)

  let video: HTMLVideoElement | null = null
  let disposed = false

  const seekBy = (seconds: number) => {
    if (!video) return
    const duration = video.duration
    let target = (video.currentTime || 0) + seconds
    if (Number.isFinite(duration)) {
      target = Math.max(0, Math.min(duration, target))
    } else {
      target = Math.max(0, target)
    }
    // currentTime throws before metadata loads; without metadata there is
    // no playhead to move, so the seek is a no-op instead of an error.
    if (video.readyState >= 1) video.currentTime = target
    syncProgress()
  }

  backBtn.addEventListener("click", () => seekBy(-10))
  fwdBtn.addEventListener("click", () => seekBy(10))
  resumeBtn.addEventListener("click", () => {
    if (!video) return
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  })

  const syncProgress = () => {
    if (!video) return
    const duration = video.duration
    if (Number.isFinite(duration) && duration > 0) {
      const elapsed = video.currentTime || 0
      progress.hidden = false
      elapsedEl.innerHTML = ""
      const strong = document.createElement("strong")
      strong.textContent = formatPauseClock(elapsed)
      elapsedEl.appendChild(strong)
      totalEl.textContent = formatPauseClock(duration)
      const pct = Math.max(0, Math.min(100, (elapsed / duration) * 100))
      fill.style.width = `${pct}%`
      bar.setAttribute("aria-valuemin", "0")
      bar.setAttribute("aria-valuemax", "100")
      bar.setAttribute("aria-valuenow", String(Math.round(pct)))
    } else {
      // Live stream: no total exists, so no bar — the badge says LIVE and
      // the subtitle carries the now-playing programme + its times.
      progress.hidden = true
    }
  }

  const syncText = () => {
    const labels = resolveLabels()
    overlay.setAttribute("aria-label", labels.paused)
    backBtn.setAttribute("aria-label", labels.back10)
    fwdBtn.setAttribute("aria-label", labels.forward10)
    resumeLabel.textContent = labels.resume
    bar.setAttribute("aria-label", labels.resume)
    hints.textContent = labels.hints
    const badgeText = opts.getBadge?.() ?? labels.live
    badge.textContent = badgeText || labels.live
    const title = opts.getTitle()
    titleEl.textContent = title || ""
    titleEl.style.display = title ? "" : "none"
    const sub = opts.getSubtitle()
    subEl.textContent = sub || ""
    subEl.style.display = sub ? "" : "none"
  }

  const shouldShow = () => {
    if (disposed || !video) return false
    if (video.ended) return false
    if (opts.isSuppressed?.()) return false
    if (opts.isPlayerVisible && !opts.isPlayerVisible()) return false
    // A video with no layout box (hidden attribute / hidden wrap) is not
    // actually on screen yet.
    if (video.clientWidth <= 0) return false
    if (!(video.currentTime > 0 || video.readyState >= 2)) return false
    return video.paused
  }

  const show = () => {
    if (!shouldShow()) return
    syncText()
    syncProgress()
    overlay.hidden = false
    // Force a frame so the fade-in transition runs.
    requestAnimationFrame(() => {
      if (!disposed) overlay.dataset.open = "true"
    })
    // Controller-first: landing on Resume means A resumes immediately.
    // Only steal focus when focus is already inside the player area or
    // nowhere useful, so pausing while browsing the channel list does not
    // yank the user out of the list.
    const active = document.activeElement as HTMLElement | null
    const focusInPlayer = !!active && wrap.contains(active)
    if (!active || active === document.body || focusInPlayer) {
      resumeBtn.focus({ preventScroll: true })
    }
  }

  const hide = () => {
    overlay.dataset.open = "false"
    overlay.hidden = true
  }

  const onPause = () => show()
  const onPlay = () => hide()
  const onEnded = () => hide()
  const onTimeUpdate = () => {
    if (overlay.dataset.open === "true") syncProgress()
  }

  const attach = (next: HTMLVideoElement) => {
    if (video === next) return
    detach()
    video = next
    video.addEventListener("pause", onPause)
    video.addEventListener("play", onPlay)
    video.addEventListener("playing", onPlay)
    video.addEventListener("ended", onEnded)
    video.addEventListener("timeupdate", onTimeUpdate)
    video.addEventListener("seeked", onTimeUpdate)
    video.addEventListener("loadedmetadata", onTimeUpdate)
    // A backend that mounts an already-paused video still needs the card.
    if (shouldShow()) show()
  }

  const detach = () => {
    if (!video) return
    video.removeEventListener("pause", onPause)
    video.removeEventListener("play", onPlay)
    video.removeEventListener("playing", onPlay)
    video.removeEventListener("ended", onEnded)
    video.removeEventListener("timeupdate", onTimeUpdate)
    video.removeEventListener("seeked", onTimeUpdate)
    video.removeEventListener("loadedmetadata", onTimeUpdate)
    video = null
  }

  const findVideo = () => {
    const found = wrap.querySelector("video")
    if (found) attach(found)
  }

  findVideo()
  const observer = new MutationObserver(() => findVideo())
  observer.observe(wrap, { childList: true, subtree: true })

  return () => {
    disposed = true
    observer.disconnect()
    detach()
    hide()
    overlay.remove()
  }
}
