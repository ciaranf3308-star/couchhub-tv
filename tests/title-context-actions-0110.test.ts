// W5 — Controller Experience 2.0 (0.11.10): the X context-menu
// action list for poster cards. Order mirrors poster-menu.ts
// (Open, Play/Resume, favourite, watchlist, watched); live channels
// never get watchlist/watched actions; Play appears only when it
// does something different from Open.
import { describe, it, expect, vi } from "vitest"
import {
  buildCardContextActions,
  cardContextLabels,
  type CardContextLabels,
} from "../src/scripts/lib/title-context-actions"

const LABELS: CardContextLabels = {
  open: "Open",
  favoriteAdd: "Add to favourites",
  favoriteRemove: "Remove from favourites",
  watchlistAdd: "Add to Watch Later",
  watchlistRemove: "Remove from Watch Later",
  watchedMark: "Mark as watched",
  watchedUnmark: "Mark as unwatched",
}

function callbacks() {
  return {
    onOpen: vi.fn(),
    onPlay: vi.fn(),
    onToggleFavorite: vi.fn(),
    onToggleWatchlist: vi.fn(),
    onToggleWatched: vi.fn(),
  }
}

describe("buildCardContextActions", () => {
  it("orders Open, Play, favourite, watchlist, watched for a movie", () => {
    const actions = buildCardContextActions(
      {
        kind: "vod",
        id: 42,
        detailHref: "/movies/detail?id=42",
        playHref: "/movies/detail?id=42&autoplay=1",
      },
      { favorited: false, onWatchlist: false, watched: false },
      callbacks(),
      LABELS,
    )
    expect(actions.map((a) => a.id)).toEqual([
      "open",
      "play",
      "favorite",
      "watchlist",
      "watched",
    ])
    expect(actions.map((a) => a.label)).toEqual([
      "Open",
      "Play",
      "Add to favourites",
      "Add to Watch Later",
      "Mark as watched",
    ])
  })

  it("labels Play as Resume when the view passes that label", () => {
    const actions = buildCardContextActions(
      {
        kind: "vod",
        id: 42,
        detailHref: "/movies/detail?id=42",
        playHref: "/movies/detail?id=42&autoplay=1",
      },
      { favorited: false, onWatchlist: false, watched: false },
      callbacks(),
      { ...LABELS, play: "Resume" },
    )
    expect(actions[1]).toMatchObject({ id: "play", label: "Resume" })
  })

  it("defaults the play label to Play when the view passes none", () => {
    const actions = buildCardContextActions(
      {
        kind: "vod",
        id: 42,
        detailHref: "/movies/detail?id=42",
        playHref: "/movies/detail?id=42&autoplay=1",
      },
      { favorited: false, onWatchlist: false, watched: false },
      callbacks(),
      LABELS,
    )
    expect(actions[1]).toMatchObject({ id: "play", label: "Play" })
  })

  it("omits Play when it would do the same as Open", () => {
    const sameHref = buildCardContextActions(
      {
        kind: "live",
        id: 7,
        detailHref: "/livetv?channel=7",
        playHref: "/livetv?channel=7",
      },
      { favorited: false, onWatchlist: false, watched: false },
      callbacks(),
      LABELS,
    )
    expect(sameHref.map((a) => a.id)).toEqual(["open", "favorite"])

    const noPlay = buildCardContextActions(
      {
        kind: "vod",
        id: 42,
        detailHref: "/movies/detail?id=42",
        playHref: "/movies/detail?id=42&autoplay=1",
      },
      { favorited: false, onWatchlist: false, watched: false },
      { onOpen: vi.fn(), onToggleFavorite: vi.fn() },
      LABELS,
    )
    expect(noPlay.map((a) => a.id)).not.toContain("play")
  })

  it("excludes watchlist and watched for live channels", () => {
    const actions = buildCardContextActions(
      {
        kind: "live",
        id: 7,
        detailHref: "/livetv?channel=7",
        playHref: "/livetv?channel=7",
      },
      { favorited: true, onWatchlist: true, watched: true },
      callbacks(),
      LABELS,
    )
    expect(actions.map((a) => a.id)).toEqual(["open", "favorite"])
    expect(actions[1].label).toBe("Remove from favourites")
  })

  it("flips toggle labels with current state", () => {
    const actions = buildCardContextActions(
      {
        kind: "series",
        id: 9,
        detailHref: "/series/detail?id=9",
        playHref: "/series/detail?id=9&autoplay=1",
      },
      { favorited: true, onWatchlist: true, watched: true },
      callbacks(),
      LABELS,
    )
    expect(actions.map((a) => a.label)).toEqual([
      "Open",
      "Play",
      "Remove from favourites",
      "Remove from Watch Later",
      "Mark as unwatched",
    ])
  })

  it("actions invoke the callbacks with current state", () => {
    const cbs = callbacks()
    const actions = buildCardContextActions(
      {
        kind: "vod",
        id: 42,
        detailHref: "/movies/detail?id=42",
        playHref: "/movies/detail?id=42&autoplay=1",
      },
      { favorited: true, onWatchlist: false, watched: true },
      cbs,
      LABELS,
    )
    for (const action of actions) action.action()
    expect(cbs.onOpen).toHaveBeenCalledTimes(1)
    expect(cbs.onPlay).toHaveBeenCalledTimes(1)
    expect(cbs.onToggleFavorite).toHaveBeenCalledWith(true)
    expect(cbs.onToggleWatchlist).toHaveBeenCalledWith(false)
    expect(cbs.onToggleWatched).toHaveBeenCalledWith(true)
  })

  it("cardContextLabels resolves the existing i18n keys", () => {
    const seen: string[] = []
    const labels = cardContextLabels((key: string) => {
      seen.push(key)
      return `L:${key}`
    })
    expect(labels.open).toBe("L:list.menu.open")
    expect(labels.favoriteAdd).toBe("L:list.menu.favoriteAdd")
    expect(labels.favoriteRemove).toBe("L:list.menu.favoriteRemove")
    expect(labels.watchlistAdd).toBe("L:list.menu.watchlistAdd")
    expect(labels.watchlistRemove).toBe("L:list.menu.watchlistRemove")
    expect(labels.watchedMark).toBe("L:list.menu.watchedMark")
    expect(labels.watchedUnmark).toBe("L:list.menu.watchedUnmark")
    // Play/Resume has no generic i18n key; it stays a view concern
    // (Play vs Resume depends on progress) and is absent here.
    expect("play" in labels).toBe(false)
    expect(seen).toHaveLength(7)
  })
})
