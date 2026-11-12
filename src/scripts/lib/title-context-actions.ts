// RedSilk Couch — X context-menu actions for cards (Controller
// Experience 2.0, 0.11.10, W5).
//
// Builds the TitleContextAction list the seam's
// openTitleContextMenu renders, from the same preference functions
// and i18n keys poster-menu.ts uses — so the controller X menu and
// the right-click/long-press menu stay one vocabulary. The builder
// is pure over the state the view reads (favourited / watchlisted /
// watched) and the callbacks the view supplies; it never touches
// preferences or the DOM itself, so it is unit-testable without a
// browser.
//
// Action order mirrors poster-menu.ts: Open, Play/Resume (only when
// the play destination differs from the detail destination),
// favourite toggle, watchlist + watched toggles (VOD/series only —
// live channels have no watchlist/watched concept).

import type { TitleContextAction } from "@/scripts/lib/controller-seams-0110.js"

export type CardContextKind = "vod" | "series" | "live"

export interface CardContextEntry {
  kind: CardContextKind
  id: string | number
  /** Detail destination (no autoplay). */
  detailHref: string
  /** Play/resume destination, when it differs from detailHref. */
  playHref?: string
}

export interface CardContextState {
  favorited: boolean
  onWatchlist: boolean
  watched: boolean
}

export interface CardContextCallbacks {
  onOpen: () => void
  /** Required when playHref is set and differs from detailHref. */
  onPlay?: () => void
  onToggleFavorite: (currentlyFavorited: boolean) => void
  onToggleWatchlist?: (currentlyOnWatchlist: boolean) => void
  onToggleWatched?: (currentlyWatched: boolean) => void
}

export interface CardContextLabels {
  open: string
  /** Defaults to "Play". Views pass "Resume" for in-progress titles. */
  play?: string
  favoriteAdd: string
  favoriteRemove: string
  watchlistAdd: string
  watchlistRemove: string
  watchedMark: string
  watchedUnmark: string
}

/**
 * Build the X-menu actions for one card. Labels come from the view
 * (resolved through t() there); state and callbacks come from the
 * view's preference reads/writes.
 */
export function buildCardContextActions(
  entry: CardContextEntry,
  state: CardContextState,
  callbacks: CardContextCallbacks,
  labels: CardContextLabels,
): TitleContextAction[] {
  const actions: TitleContextAction[] = [
    { id: "open", label: labels.open, action: callbacks.onOpen },
  ]

  const playHref = entry.playHref
  if (playHref && playHref !== entry.detailHref && callbacks.onPlay) {
    actions.push({
      id: "play",
      label: labels.play ?? "Play",
      action: callbacks.onPlay,
    })
  }

  actions.push({
    id: "favorite",
    label: state.favorited ? labels.favoriteRemove : labels.favoriteAdd,
    action: () => callbacks.onToggleFavorite(state.favorited),
  })

  // Live channels have no watchlist/watched concept (poster-menu.ts).
  if (entry.kind !== "live") {
    if (callbacks.onToggleWatchlist) {
      const toggleWatchlist = callbacks.onToggleWatchlist
      actions.push({
        id: "watchlist",
        label: state.onWatchlist
          ? labels.watchlistRemove
          : labels.watchlistAdd,
        action: () => toggleWatchlist(state.onWatchlist),
      })
    }
    if (callbacks.onToggleWatched) {
      const toggleWatched = callbacks.onToggleWatched
      actions.push({
        id: "watched",
        label: state.watched ? labels.watchedUnmark : labels.watchedMark,
        action: () => toggleWatched(state.watched),
      })
    }
  }

  return actions
}

/**
 * Resolve the labels for buildCardContextActions through the app's
 * t() — the same keys poster-menu.ts uses. The play label stays a
 * view concern (Play vs Resume depends on progress).
 */
export function cardContextLabels(
  t: (key: string) => string,
): Omit<CardContextLabels, "play"> {
  return {
    open: t("list.menu.open"),
    favoriteAdd: t("list.menu.favoriteAdd"),
    favoriteRemove: t("list.menu.favoriteRemove"),
    watchlistAdd: t("list.menu.watchlistAdd"),
    watchlistRemove: t("list.menu.watchlistRemove"),
    watchedMark: t("list.menu.watchedMark"),
    watchedUnmark: t("list.menu.watchedUnmark"),
  }
}
