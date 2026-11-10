// RedSilk Couch — detail-splash presentation helpers (Browse 0.8.0, W5).
//
// Pure + small DOM helpers shared by the movie and series detail pages.
// The data layer is untouched: these functions only decide HOW a painted
// detail screen looks — which artwork is the hero backdrop, which meta
// chips show, what the season summary says, and whether the back link
// should history.back() (restoring the Browse card you came from via
// the couch-focus memory) or follow its href.
//
// Artwork falls back through the SAME system TvImage uses
// (couch-image.ts: isUsableImageSrc / fallbackMarkFor /
// armTvImageFallbacks) — the client-painted detail pages cannot mount
// the TvImage Astro component for runtime data, so paintDetailArtwork
// builds the identical .rs-image DOM (img + branded fallback block)
// and arms the same error handling. A detail screen with missing art
// still looks intentional: initials mark + title on the burgundy
// surface, never a broken-image icon. No ratings or metadata are ever
// invented here — chips only render fields the view model supplied.

import {
  armTvImageFallbacks,
  fallbackMarkFor,
  isUsableImageSrc,
  type TvImageKind,
} from "@/scripts/lib/couch-image.ts";
import type { MovieDetail } from "@/scripts/movies/couch-movies.ts";
import { genreDisplayLabel } from "@/scripts/movies/couch-movies.ts";
import type {
  EpisodeProgress,
  SeasonGroup,
  SeriesDetail,
} from "@/scripts/series/couch-series.ts";

export interface DetailArtwork {
  /** Backdrop, falling back to the poster so the hero is never bare. */
  heroSrc: string | null;
  /** Poster for the hero's poster slot (null when the provider sent none). */
  posterSrc: string | null;
  /** True when any artwork exists at all. */
  hasArt: boolean;
}

export function detailArtwork(detail: {
  backdrop?: string | null;
  poster?: string | null;
}): DetailArtwork {
  const backdrop = detail.backdrop || null;
  const poster = detail.poster || null;
  const heroSrc = backdrop ?? poster;
  return { heroSrc, posterSrc: poster, hasArt: heroSrc != null };
}

export interface DetailChip {
  label: string;
  kind: "meta" | "genre" | "rating" | "progress";
}

/** Meta chips for a movie: year, runtime, genres, rating — only supplied parts. */
export function movieDetailChips(detail: MovieDetail): DetailChip[] {
  const chips: DetailChip[] = [];
  if (detail.year) chips.push({ label: detail.year, kind: "meta" });
  if (detail.runtimeLabel) chips.push({ label: detail.runtimeLabel, kind: "meta" });
  for (const genre of detail.genres) {
    chips.push({ label: genreDisplayLabel(genre), kind: "genre" });
  }
  if (detail.ratingLabel) {
    chips.push({ label: `★ ${detail.ratingLabel}`, kind: "rating" });
  }
  return chips;
}

/** Meta chips for a series: year, seasons, genres, rating — only supplied parts. */
export function seriesDetailChips(detail: SeriesDetail): DetailChip[] {
  const chips: DetailChip[] = [];
  if (detail.year) chips.push({ label: detail.year, kind: "meta" });
  if (detail.seasonsCount > 0) {
    chips.push({ label: detail.seasonsLabel, kind: "meta" });
  }
  for (const genre of detail.genres) {
    chips.push({ label: genreDisplayLabel(genre), kind: "genre" });
  }
  if (detail.rating) {
    chips.push({ label: `★ ${detail.rating}`, kind: "rating" });
  }
  return chips;
}

export interface SeasonWatchSummary {
  watched: number;
  total: number;
  /** 0..1 across the whole series. */
  percent: number;
  /** "5 of 24 watched" / "" when the series lists no episodes. */
  label: string;
}

/**
 * Watched progress across every season of a series, from the same
 * episode-progress records the episode cards read. Pure.
 */
export function seasonWatchSummary(
  group: SeasonGroup,
  progressByEpisodeId: Map<number, EpisodeProgress> | Record<number, EpisodeProgress>,
): SeasonWatchSummary {
  const get = (id: number): EpisodeProgress | undefined =>
    progressByEpisodeId instanceof Map
      ? progressByEpisodeId.get(id)
      : (progressByEpisodeId as Record<number, EpisodeProgress>)[id];
  let watched = 0;
  let total = 0;
  for (const season of group.seasons) {
    for (const ep of group.bySeason.get(season) ?? []) {
      total += 1;
      if (get(ep.id)?.completed) watched += 1;
    }
  }
  return {
    watched,
    total,
    percent: total > 0 ? watched / total : 0,
    label: total > 0 ? `${watched} of ${total} watched` : "",
  };
}

// ---------------------------------------------------------------------------
// Back link — history.back() restores the Browse rail card you came from.
// ---------------------------------------------------------------------------

export type DetailBackDecision = "history-back" | "follow-link";

/**
 * Pure decision behind the detail back link. history.back() only when
 * the referrer is the Browse grid we point at (same origin, exact
 * pathname — query string ignored) and there is history to go back
 * to; otherwise the link follows its href. Pure.
 */
export function detailBackDecision(opts: {
  referrer: string;
  origin: string;
  gridPath: string;
  historyLength: number;
}): DetailBackDecision {
  if (opts.historyLength <= 1) return "follow-link";
  let referrerUrl: URL;
  try {
    referrerUrl = new URL(opts.referrer);
  } catch {
    return "follow-link";
  }
  if (referrerUrl.origin !== opts.origin) return "follow-link";
  if (referrerUrl.pathname !== opts.gridPath) return "follow-link";
  return "history-back";
}

/**
 * Wire a detail back link to history.back() when the viewer arrived
 * from the Browse grid (focus memory then restores the exact card);
 * otherwise leave the href alone. Plain clicks only — modified
 * clicks / long-presses keep their default behaviour.
 */
export function wireDetailBackLink(
  backLink: HTMLElement | null,
  gridPath: string,
): void {
  backLink?.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const decision = detailBackDecision({
      referrer: document.referrer,
      origin: location.origin,
      gridPath,
      historyLength: history.length,
    });
    if (decision !== "history-back") return;
    event.preventDefault();
    history.back();
  });
}

// ---------------------------------------------------------------------------
// DOM painters — TvImage-compatible markup, client-side.
// ---------------------------------------------------------------------------

/**
 * Paint artwork into a container with the exact DOM TvImage renders
 * (`.rs-image.rs-image--<kind>` + img + branded fallback block), so
 * the couch.css fallback rules and the armed error handler apply.
 * A missing/blank src still paints the intentional fallback (initials
 * + title on the burgundy surface). Returns true when a real image
 * was painted, false for the fallback-only state.
 */
export function paintDetailArtwork(
  el: HTMLElement | null,
  src: string | null | undefined,
  kind: TvImageKind,
  title: string,
): boolean {
  if (!el) return false;
  const usable = isUsableImageSrc(src);
  el.replaceChildren();
  el.classList.add("rs-image", `rs-image--${kind}`);
  el.setAttribute("data-tv-image", "");
  el.setAttribute("data-kind", kind);
  if (!usable) el.classList.add("is-fallback");
  else el.classList.remove("is-fallback");
  if (usable) {
    const img = document.createElement("img");
    img.src = src as string;
    img.alt = kind === "backdrop" ? "" : title;
    img.loading = "eager";
    img.decoding = "async";
    img.setAttribute("data-tv-image-img", "");
    el.appendChild(img);
  }
  const fallback = document.createElement("div");
  fallback.className = "rs-image__fallback";
  fallback.setAttribute("aria-hidden", "true");
  const mark = document.createElement("span");
  mark.className = "rs-image__fallback-mark";
  mark.textContent = fallbackMarkFor(kind, title);
  fallback.appendChild(mark);
  if (title) {
    const label = document.createElement("span");
    label.className = "rs-image__fallback-title";
    label.textContent = title;
    fallback.appendChild(label);
  }
  el.appendChild(fallback);
  armTvImageFallbacks(document);
  return usable;
}

/** Render meta chips into a container (replaces its children). */
export function paintMetaChips(
  container: HTMLElement | null,
  chips: DetailChip[],
): void {
  if (!container) return;
  container.replaceChildren();
  for (const chip of chips) {
    const el = document.createElement("span");
    el.className = `rs-detail-chip rs-detail-chip--${chip.kind}`;
    el.textContent = chip.label;
    container.appendChild(el);
  }
}

/**
 * Paint a resume-progress bar: fill width 0..1 plus an accessible
 * label. The bar element itself is hidden when there is no progress.
 */
export function paintDetailProgress(
  barWrap: HTMLElement | null,
  fraction: number,
  label: string,
): void {
  if (!barWrap) return;
  const fill = barWrap.querySelector<HTMLElement>("[data-role='detail-progress-fill']");
  const text = barWrap.querySelector<HTMLElement>("[data-role='detail-progress-label']");
  const pct = Math.max(0, Math.min(1, fraction || 0));
  if (fill) fill.style.width = `${Math.round(pct * 100)}%`;
  if (text) text.textContent = label;
  barWrap.hidden = pct <= 0;
  barWrap.setAttribute("aria-hidden", pct <= 0 ? "true" : "false");
}
