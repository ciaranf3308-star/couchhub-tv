<script>
  // Cross-playlist watchlist view - mirror of AllFavoritesView, but only
  // movies and series and sorted by added-time (newest first).
  import { onMount } from "svelte"
  import { log } from "@/scripts/lib/log.js"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { getEntries, getActiveEntry, selectEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getAllGlobalWatchlist,
    setWatchlistMeta,
    isFavorite,
    toggleFavorite,
    isOnWatchlist,
    toggleWatchlist,
    isCompleted,
    markCompleted,
    clearProgress,
    hasSeriesWatchedOverride,
    setSeriesWatchedOverride,
  } from "@/scripts/lib/preferences.js"
  import {
    registerBackLayer,
    BACK_PRIORITY,
    recordOriginFromReferrer,
    navigateBackWithOrigin,
    setLogicalView,
    setControllerHints,
    openTitleContextMenu,
    isTitleContextMenuOpen,
  } from "@/scripts/lib/controller-seams-0110.ts"
  import {
    initListFocusMemory,
    restoreListFocus,
    readListFilter,
    writeListFilter,
  } from "@/scripts/lib/couch-list-focus.ts"
  import {
    buildCardContextActions,
    cardContextLabels,
  } from "@/scripts/lib/title-context-actions.ts"
  import { findOpenModal } from "@/scripts/lib/dialog-spatial-nav.ts"
  import { RETURN_HOME_HINT } from "@/scripts/lib/couch-button-hints.ts"

  const ROUTE = "/watchlist"
  const FILTERS = ["all", "vod", "series"]
  /** Filter restored from the last visit (detail return keeps the filter). */
  function initialFilter() {
    try {
      const saved = readListFilter(sessionStorage, ROUTE, "all")
      return FILTERS.includes(saved) ? saved : "all"
    } catch {
      return "all"
    }
  }
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import { kindLabel, isKindFallbackName, KIND_ICON_SVG } from "@/scripts/lib/kinds.js"
  import { cachedImg } from "@/scripts/lib/img-cache.ts"
  import { IconExternalLink } from "@tabler/icons-svelte"

  /** @type {"all"|"vod"|"series"} */
  let filter = $state(initialFilter())
  let activePlaylistId = $state("")
  let locale = $state(0)
  // Wrappers read the locale rune so {tr(...)} / {kl(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const kl = (kind) => (locale, kindLabel(kind))
  /** @type {Array<{ id: string, title: string }>} */
  let playlists = $state([])
  /** @type {Array<{
   *   playlistId: string,
   *   playlistTitle: string,
   *   kind: "vod"|"series",
   *   id: number,
   *   ts: number,
   *   name: string,
   *   logo: string|null,
   *   href: string,
   *   isCrossPlaylist: boolean,
   * }>} */
  let entries = $state([])
  let loading = $state(true)

  const counts = $derived({
    all: entries.length,
    vod: entries.filter((row) => row.kind === "vod").length,
    series: entries.filter((row) => row.kind === "series").length,
  })

  const visible = $derived(
    filter === "all" ? entries : entries.filter((row) => row.kind === filter)
  )

  function buildHref(kind, id) {
    if (kind === "vod") return `/movies/detail?id=${encodeURIComponent(id)}`
    return `/series/detail?id=${encodeURIComponent(id)}`
  }

  /** Play destination: detail autoplays. */
  function playHrefFor(entry) {
    return `${entry.href}&autoplay=1`
  }

  function entryKey(entry) {
    return `${entry.playlistId}:${entry.kind}:${entry.id}`
  }

  let reloadGeneration = 0

  async function reload() {
    const generation = ++reloadGeneration
    await ensurePrefsLoaded()
    const [allEntries, active] = await Promise.all([getEntries(), getActiveEntry()])
    if (generation !== reloadGeneration) return
    activePlaylistId = active?._id || ""
    playlists = allEntries.map((entry) => ({
      id: entry._id,
      title: entry.title || "Untitled playlist",
    }))

    const raw = getAllGlobalWatchlist()
    const needed = new Map()
    for (const row of raw) {
      const kinds = needed.get(row.playlistId) || new Set()
      kinds.add(row.kind)
      needed.set(row.playlistId, kinds)
    }
    const titleById = new Map(playlists.map((entry) => [entry.id, entry.title]))

    const buildEntries = () => {
      /** @type {Map<string, { vod: Map<number, any>, series: Map<number, any> }>} */
      const lookups = new Map()
      for (const playlistId of needed.keys()) {
        lookups.set(playlistId, {
          vod: new Map(
            (getCached(playlistId, "vod")?.data || []).map((item) => [
              Number(item.id),
              item,
            ])
          ),
          series: new Map(
            (getCached(playlistId, "series")?.data || []).map((item) => [
              Number(item.id),
              item,
            ])
          ),
        })
      }

      entries = raw.map((row) => {
        const item = lookups.get(row.playlistId)?.[row.kind]?.get(Number(row.id))
        const isStoredNameFallback = !!row.name && isKindFallbackName(row.kind, row.id, row.name)
        const effectiveStoredName = isStoredNameFallback ? "" : row.name
        const name = effectiveStoredName || item?.name || `${kindLabel(row.kind)} ${row.id}`
        const logo = row.logo ?? item?.logo ?? null
        // Lazily backfill stored meta so cross-playlist clicks still have name
        // and poster even when the source catalog cache later expires.
        if (!effectiveStoredName && !row.logo && (item?.name || item?.logo)) {
          setWatchlistMeta(row.playlistId, row.kind, row.id, {
            name: item.name || "",
            logo: item.logo || null,
          })
        } else if (isStoredNameFallback && item?.name) {
          setWatchlistMeta(row.playlistId, row.kind, row.id, {
            name: item.name,
            logo: row.logo ?? item?.logo ?? null,
          })
        }
        return {
          playlistId: row.playlistId,
          playlistTitle: titleById.get(row.playlistId) || "Removed playlist",
          kind: row.kind,
          id: Number(row.id),
          ts: row.ts,
          name,
          logo,
          href: buildHref(row.kind, row.id),
          isCrossPlaylist: row.playlistId !== activePlaylistId,
        }
      })
    }

    const hydrations = [...needed].flatMap(([playlistId, kinds]) =>
      [...kinds].map((kind) => hydrateCache(playlistId, kind))
    )
    const allCached = raw.every((row) => !!getCached(row.playlistId, row.kind))

    if (allCached) {
      // Paint from memory now; hydration below only refreshes stale rows.
      buildEntries()
      loading = false
      void Promise.allSettled(hydrations).then(() => {
        if (generation === reloadGeneration) buildEntries()
      }).catch(() => {})
    } else {
      await Promise.allSettled(hydrations)
      if (generation !== reloadGeneration) return
      buildEntries()
      loading = false
    }
  }

  async function openCard(event, entry) {
    if (!entry.isCrossPlaylist) return
    event.preventDefault()
    await openEntryAt(entry, entry.href)
  }

  async function openEntryAt(entry, href) {
    if (entry.isCrossPlaylist) {
      try {
        await selectEntry(entry.playlistId)
      } catch (err) {
        log.error("[xt:watchlist] selectEntry failed:", err)
      }
    }
    window.location.href = href
  }

  function setFilter(next) {
    filter = next
    try {
      writeListFilter(sessionStorage, ROUTE, next)
    } catch {
      // Filter memory is a nicety, never fatal.
    }
  }

  // W5 (0.11.10): X on a card opens the title context menu — the
  // controller path to Remove from Watch Later (Contract F). This
  // view previously had no context menu at all (mouse/touch only
  // had the card itself). Controller X reaches here as the "x" key
  // once W1 routes it to views; physical keyboards get it today.
  function openEntryMenu(anchor, entry) {
    const extras = { name: entry.name || "", logo: entry.logo || null }
    const labels = cardContextLabels(t)
    openTitleContextMenu(
      anchor,
      buildCardContextActions(
        {
          kind: entry.kind,
          id: entry.id,
          detailHref: entry.href,
          playHref: playHrefFor(entry),
        },
        {
          favorited: isFavorite(entry.playlistId, entry.kind, entry.id),
          onWatchlist: isOnWatchlist(entry.playlistId, entry.kind, entry.id),
          watched:
            entry.kind === "vod"
              ? isCompleted(entry.playlistId, "vod", entry.id)
              : hasSeriesWatchedOverride(entry.playlistId, entry.id),
        },
        {
          onOpen: () => void openEntryAt(entry, entry.href),
          onPlay: () => void openEntryAt(entry, playHrefFor(entry)),
          onToggleFavorite: () => {
            toggleFavorite(entry.playlistId, entry.kind, entry.id, extras)
          },
          onToggleWatchlist: () => {
            toggleWatchlist(entry.playlistId, entry.kind, entry.id, extras)
            void reload()
          },
          onToggleWatched: (currently) => {
            if (entry.kind === "vod") {
              if (currently) clearProgress(entry.playlistId, "vod", entry.id)
              else markCompleted(entry.playlistId, "vod", entry.id, extras)
            } else {
              setSeriesWatchedOverride(entry.playlistId, entry.id, !currently)
            }
          },
        },
        labels,
      ),
    )
  }

  function onCardKey(event) {
    if (event.key !== "x" && event.key !== "X") return
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return
    }
    if (findOpenModal() || isTitleContextMenuOpen()) return
    const anchor = target?.closest?.("[data-couch-key]")
    if (!anchor) return
    const key = anchor.getAttribute("data-couch-key")
    const entry = visible.find((row) => entryKey(row) === key)
    if (!entry) return
    event.preventDefault()
    openEntryMenu(anchor, entry)
  }

  // Returning from a detail page restores the same card (list focus
  // memory); restore is a no-op while anything holds focus, so list
  // refreshes never yank focus.
  $effect(() => {
    void visible
    void loading
    if (!loading) restoreListFocus(document, ROUTE)
  })

  onMount(() => {
    setLogicalView("watchlist")
    setControllerHints({
      id: "watchlist",
      items: [
        { glyph: "dpad", label: "Move" },
        { glyph: "a", label: "Select" },
        { glyph: "b", label: "Back" },
        { glyph: "x", label: "Actions" },
        { glyph: "y", label: "Search" },
        { glyph: "menu", label: "Settings" },
        RETURN_HOME_HINT,
      ],
    })
    recordOriginFromReferrer()
    const stopFocusMemory = initListFocusMemory(document, ROUTE)
    const unregisterBack = registerBackLayer({
      id: "watchlist-root",
      priority: BACK_PRIORITY.PAGE,
      isActive: () => !findOpenModal() && !isTitleContextMenuOpen(),
      handle: () => navigateBackWithOrigin("/"),
    })
    document.addEventListener("keydown", onCardKey)
    reload()
    const onLocale = () => { locale++ }
    let warmedRaf = 0
    const onCatalogWarmed = () => {
      if (warmedRaf) return
      warmedRaf = requestAnimationFrame(() => {
        warmedRaf = 0
        reload()
      })
    }
    const handlers = {
      "xt:active-changed": reload,
      "xt:entries-updated": reload,
      "xt:watchlist-changed": reload,
      "xt:catalog-warmed": onCatalogWarmed,
      [LOCALE_EVENT]: onLocale,
    }
    for (const [eventName, handler] of Object.entries(handlers)) {
      document.addEventListener(eventName, handler)
    }
    return () => {
      stopFocusMemory()
      unregisterBack()
      document.removeEventListener("keydown", onCardKey)
      for (const [eventName, handler] of Object.entries(handlers)) {
        document.removeEventListener(eventName, handler)
      }
      if (warmedRaf) cancelAnimationFrame(warmedRaf)
    }
  })
</script>

<div class="couch-library__filters">
  <div class="couch-library__chips" role="tablist" aria-label={tr("watchlist.heading")}>
    {#each [
      { id: "all", key: "favorites.filter.all" },
      { id: "vod", key: "favorites.filter.vod" },
      { id: "series", key: "favorites.filter.series" },
    ] as chip (chip.id)}
      <button
        type="button"
        role="tab"
        data-nylah-item
        aria-selected={filter === chip.id}
        onclick={() => setFilter(chip.id)}
        class="filter-chip"
        class:is-active={filter === chip.id}>
        {tr(chip.key)}
        <span class="filter-chip__count">{counts[chip.id]}</span>
      </button>
    {/each}
  </div>

  {#if loading && !entries.length}
    <div class="rs-meta">{tr("common.loading")}</div>
  {:else if !entries.length}
    <div class="rs-empty">
      <p class="rs-empty__message">{tr("watchlist.helperEmpty")}</p>
    </div>
  {:else if !visible.length}
    <div class="rs-empty">
      <p class="rs-empty__message">{tr("watchlist.helperFiltered")}</p>
    </div>
  {:else}
    <div class="rs-meta">
      {tr("strip.itemCount", { count: visible.length })}
    </div>
  {/if}
</div>

{#if visible.length}
  <section
    class="rs-grid"
    data-couch-grid
    role="group"
    aria-label={tr("watchlist.heading")}>
    {#each visible as entry, idx (entry.playlistId + ":" + entry.kind + ":" + entry.id)}
      <a
        href={entry.href}
        onclick={(event) => openCard(event, entry)}
        data-nylah-item
        data-couch-key={entry.playlistId + ":" + entry.kind + ":" + entry.id}
        data-couch-detail-href={entry.href}
        data-couch-play-href={playHrefFor(entry)}
        aria-label={tr("watchlist.cardAriaLabel", { name: entry.name, playlist: entry.playlistTitle })}
        class="rs-card rs-card--poster">
        <span class="rs-card__media couch-library__media couch-library__media--poster">
          {#if entry.logo}
            <img
              use:cachedImg={{ url: entry.logo, kind: "poster" }}
              alt=""
              loading="lazy" fetchpriority="low"
              decoding="async"
              referrerpolicy="no-referrer"
              width="200" height="300"
              class="couch-library__media-img" />
          {:else}
            <span class="couch-library__media-fallback">
              <span class="couch-library__media-fallback-icon" aria-hidden="true">{@html KIND_ICON_SVG[entry.kind]}</span>
              <span class="couch-library__media-fallback-name">{entry.name}</span>
            </span>
          {/if}

          <span class="rs-card__badge">
            {kl(entry.kind)}
          </span>
        </span>

        <span class="rs-card__body">
          <span class="rs-card__title">
            {entry.name}
          </span>
          <span class="rs-card__subtitle">
            {#if entry.isCrossPlaylist}
              <IconExternalLink aria-hidden="true" class="couch-library__x-icon" />
            {/if}
            {entry.playlistTitle}
          </span>
        </span>
      </a>
    {/each}
  </section>
{/if}

<style>
  /* Couch library — RedSilk tokens only (couch.css owns .rs-*). */
  .couch-library__filters {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    flex-shrink: 0;
    margin-bottom: 1.5rem;
  }
  .couch-library__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .filter-chip {
    font-size: 1.25rem;
    font-weight: 600;
    white-space: nowrap;
    min-height: 3.5rem;
    padding: 0.625rem 1.25rem;
    border-radius: 999px;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text-2);
    cursor: pointer;
  }
  .filter-chip:hover {
    color: var(--rs-text);
    background: var(--rs-bg-2);
  }
  .filter-chip.is-active {
    background: var(--rs-accent);
    border-color: var(--rs-accent);
    color: var(--rs-text);
    box-shadow: 0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  .filter-chip__count {
    margin-left: 0.5rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .couch-library__media {
    display: block;
    overflow: hidden;
    background: var(--rs-bg-2);
  }
  .couch-library__media--poster {
    aspect-ratio: 2 / 3;
  }
  .couch-library__media--wide {
    aspect-ratio: 16 / 9;
  }
  .couch-library__media-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .couch-library__logo-wrap {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .couch-library__logo {
    position: relative;
    max-height: 100%;
    max-width: 100%;
    object-fit: contain;
  }
  .couch-library__media-fallback {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    width: 100%;
    height: 100%;
    padding: 1rem;
    color: var(--rs-text-2);
    background: linear-gradient(155deg, var(--rs-surface) 0%, var(--rs-bg-2) 70%, var(--rs-bg) 100%);
  }
  .couch-library__media-fallback-icon {
    width: 2rem;
    height: 2rem;
    opacity: 0.6;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .couch-library__media-fallback-name {
    font-family: var(--rs-font-display);
    font-size: 1.25rem;
    text-align: center;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .couch-library__x-icon {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    color: var(--rs-focus);
    vertical-align: -0.125rem;
  }
  .couch-library__card--unavailable {
    opacity: 0.5;
  }
  @media (prefers-reduced-motion: reduce) {
    .filter-chip.is-active {
      box-shadow: none;
    }
  }
</style>
