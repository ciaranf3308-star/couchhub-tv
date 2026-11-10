// Shared poster-card renderer for the Nylah Studios home rails.
//
// This is an internal helper, not a new UI surface: it renders the same
// poster card the hub strips already use (Continue Watching / Because you
// watched) so the four new rails don't each invent a card design. Markup
// mirrors BecauseWatchedStrip.svelte: rounded poster, IMDb-style rating
// badge, title below; cards link to the existing movie/series detail
// pages, so playback and detail behavior are untouched.
//
// NOTE (extra file): the brief lists 9 files; this 10th internal module
// exists only so the four rail components share one card implementation
// instead of duplicating ~60 lines of markup four times.

import { escapeHtml } from "@/scripts/lib/format.ts"
import { dragScroll } from "@/scripts/lib/drag-scroll.ts"
import { cachedImg } from "@/scripts/lib/img-cache.ts"

/** One playable library title, as shown on a rail. */
export interface RailItem {
  kind: "vod" | "series"
  id: number
  name: string
  logo: string | null
  year: string
  rating: string
}

const STAR_SVG =
  '<svg viewBox="0 0 24 24" width="0.85em" height="0.85em" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" class="text-accent"><path d="M12 17.75l-6.18 3.25 1.18-6.88L2 9.25l6.91-1L12 2l3.09 6.25 6.91 1-5 4.87 1.18 6.88z" /></svg>'

export function railCardHref(item: RailItem): string {
  return item.kind === "vod"
    ? `/movies/detail?id=${encodeURIComponent(item.id)}`
    : `/series/detail?id=${encodeURIComponent(item.id)}`
}

export function buildRailCardHtml(item: RailItem): string {
  const href = railCardHref(item)
  const name = escapeHtml(item.name)
  const year = item.year ? ` (${escapeHtml(item.year)})` : ""
  const thumb = item.logo
    ? `<img data-rail-poster src="${escapeHtml(item.logo)}" alt="" loading="lazy" fetchpriority="low" decoding="async" referrerpolicy="no-referrer" width="200" height="300" class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />`
    : `<div class="h-full w-full flex flex-col items-center justify-center gap-2 px-3 text-fg-3 bg-linear-to-br from-surface-2 to-surface-3"><span class="font-serif text-2xs text-center truncate max-w-full">${name}</span></div>`
  const rating = item.rating
    ? `<span class="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 bg-black/55 backdrop-blur-sm ring-1 ring-white/10 text-white/90 text-2xs font-semibold tabular-nums" aria-label="Rating ${escapeHtml(item.rating)} out of 10">${STAR_SVG}<span>${escapeHtml(item.rating)}</span></span>`
    : ""
  return `<li class="shrink-0 snap-start w-32 sm:w-[9.5rem] lg:w-44">
    <a href="${href}" data-nylah-item aria-label="${name}${year}" class="nylah-card group relative block rounded-xl overflow-hidden bg-surface-2 ring-1 ring-line transition-[transform,box-shadow] duration-150 hover:ring-[3px] hover:ring-accent outline-none focus-visible:ring-1 focus-visible:ring-accent hover:transform-[translateY(-2px)] focus-visible:transform-[translateY(-2px)]">
      <div class="w-full aspect-2-3 overflow-hidden bg-surface-2 relative">${thumb}${rating}</div>
      <div class="px-2 py-2 min-w-0"><div class="truncate text-sm font-medium text-fg">${name}</div></div>
    </a>
  </li>`
}

/**
 * Render items into a rail `<ul>` and wire the app's existing
 * drag-to-scroll + cached-poster behavior. Returns a cleanup function;
 * call it before re-rendering or unmounting.
 */
export function renderRailCards(
  rowEl: HTMLElement,
  items: RailItem[]
): () => void {
  rowEl.innerHTML = items.map(buildRailCardHtml).join("")
  const cleanups: Array<() => void> = []
  const drag = dragScroll(rowEl)
  cleanups.push(() => drag.destroy())
  for (const img of Array.from(
    rowEl.querySelectorAll<HTMLImageElement>("img[data-rail-poster]")
  )) {
    const url = img.getAttribute("src")
    if (!url) continue
    const action = cachedImg(img, { url, kind: "poster" })
    cleanups.push(() => action.destroy())
  }
  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // Cleanup must never throw on a re-render.
      }
    }
  }
}
