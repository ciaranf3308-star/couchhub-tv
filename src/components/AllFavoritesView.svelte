<script>
  // Cross-playlist favorites view
  import { onMount } from "svelte"
  import { IconExternalLink } from "@tabler/icons-svelte"
  import { log } from "@/scripts/lib/log.js"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import { getEntries, getActiveEntry, selectEntry } from "@/scripts/lib/creds.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getAllGlobalFavorites,
    getFavoriteMeta,
    setFavoriteMeta,
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
  } from "@/scripts/lib/back-handler.ts"
  import {
    recordOriginFromReferrer,
    navigateBackWithOrigin,
  } from "@/scripts/lib/route-origin.ts"
  import { setLogicalView } from "@/scripts/lib/couch-focus.ts"
  import { setControllerHints } from "@/scripts/lib/couch-button-hints.ts"
  import {
    openTitleContextMenu,
    isTitleContextMenuOpen,
  } from "@/scripts/lib/poster-menu.ts"
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

  const ROUTE = "/favorites"
  const FILTERS = ["all", "live", "vod", "series"]
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
  import { readCachedLiveChannels, hasCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
  import { kindLabel, isKindFallbackName, KIND_ICON_SVG } from "@/scripts/lib/kinds.js"
  import { cachedImg } from "@/scripts/lib/img-cache.ts"

  /** @type {"all"|"live"|"vod"|"series"} */
  let filter = $state(initialFilter())
  let locale = $state(0)
  // Wrappers read the locale rune so {tr(...)} / {kl(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const kl = (kind) => (locale, kindLabel(kind))
  let activePlaylistId = $state("")
  /** @type {Array<{ id: string, title: string }>} */
  let playlists = $state([])
  /** @type {Array<{
   *   playlistId: string,
   *   playlistTitle: string,
   *   kind: "live"|"vod"|"series",
   *   id: number,
   *   name: string,
   *   logo: string|null,
   *   href: string,
   *   isCrossPlaylist: boolean,
   * }>} */
  let entries = $state([])
  let loading = $state(true)

  const counts = $derived({
    all: entries.length,
    live: entries.filter((row) => row.kind === "live").length,
    vod: entries.filter((row) => row.kind === "vod").length,
    series: entries.filter((row) => row.kind === "series").length,
  })

  const visible = $derived(
    filter === "all" ? entries : entries.filter((row) => row.kind === filter)
  )

  function buildHref(kind, id) {
    if (kind === "live") return `/livetv?channel=${encodeURIComponent(id)}`
    if (kind === "vod") return `/movies/detail?id=${encodeURIComponent(id)}`
    return `/series/detail?id=${encodeURIComponent(id)}`
  }

  /** Play destination: live tunes directly; VOD/series detail autoplays. */
  function playHrefFor(entry) {
    return entry.kind === "live" ? entry.href : `${entry.href}&autoplay=1`
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

    const raw = getAllGlobalFavorites()
    const needed = new Map()
    for (const row of raw) {
      const kinds = needed.get(row.playlistId) || new Set()
      kinds.add(row.kind)
      if (row.kind === "live") kinds.add("m3u")
      needed.set(row.playlistId, kinds)
    }
    const titleById = new Map(playlists.map((entry) => [entry.id, entry.title]))

    const buildEntries = () => {
      /** @type {Map<string, { live: Map<number, any>, vod: Map<number, any>, series: Map<number, any>, liveCacheAvailable: boolean }>} */
      const lookups = new Map()
      for (const playlistId of needed.keys()) {
        lookups.set(playlistId, {
          live: new Map(
            readCachedLiveChannels(playlistId).map((item) => [Number(item.id), item])
          ),
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
          liveCacheAvailable: hasCachedLiveChannels(playlistId),
        })
      }

      entries = raw.map((row) => {
        const meta = getFavoriteMeta(row.playlistId, row.kind, row.id)
        const rowLookups = lookups.get(row.playlistId)
        const item = rowLookups?.[row.kind]?.get(Number(row.id))
        // Hidden-channel favorites and unresolved custom-playlist channels both
        // miss the live lookup once the catalog is cached - can't tune either.
        const unavailable = row.kind === "live" && !item && !!rowLookups?.liveCacheAvailable
        const isStoredNameFallback = !!meta?.name && isKindFallbackName(row.kind, row.id, meta.name)
        const effectiveStoredName = isStoredNameFallback ? "" : meta?.name
        const name = effectiveStoredName || item?.name || `${kindLabel(row.kind)} ${row.id}`
        const logo = meta?.logo ?? item?.logo ?? null
        // Lazily backfill meta so cross-playlist clicks still have name + logo
        // even when the source catalog cache later expires.
        if (!meta && (item?.name || item?.logo)) {
          setFavoriteMeta(row.playlistId, row.kind, row.id, {
            name: item.name || "",
            logo: item.logo || null,
          })
        } else if (isStoredNameFallback && item?.name) {
          setFavoriteMeta(row.playlistId, row.kind, row.id, {
            name: item.name,
            logo: meta?.logo ?? item?.logo ?? null,
          })
        }
        return {
          playlistId: row.playlistId,
          playlistTitle: titleById.get(row.playlistId) || "Removed playlist",
          kind: row.kind,
          id: Number(row.id),
          name,
          logo,
          href: buildHref(row.kind, row.id),
          isCrossPlaylist: row.playlistId !== activePlaylistId,
          unavailable,
        }
      })
    }

    const hydrations = [...needed].flatMap(([playlistId, kinds]) =>
      [...kinds].map((kind) => hydrateCache(playlistId, kind))
    )
    const allCached = raw.every((row) =>
      row.kind === "live"
        ? hasCachedLiveChannels(row.playlistId)
        : !!getCached(row.playlistId, row.kind)
    )

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

  async function openEntry(entry) {
    await openEntryAt(entry, entry.href)
  }

  async function openEntryAt(entry, href) {
    if (entry.isCrossPlaylist) {
      try {
        await selectEntry(entry.playlistId)
      } catch (err) {
        log.error("[xt:favorites] selectEntry failed:", err)
      }
    }
    window.location.href = href
  }

  async function openCard(event, entry) {
    if (entry.unavailable) {
      event.preventDefault()
      return
    }
    if (!entry.isCrossPlaylist) return
    event.preventDefault()
    await openEntry(entry)
  }

  // Svelte action: right-click / long-press "Remove from favorites" menu.
  function favoriteCardMenu(node, entry) {
    let current = entry
    let attached = false
    let destroyed = false

    function open(anchor, point) {
      if (destroyed) return
      import("@/scripts/lib/poster-menu").then(({ openPosterMenu }) => {
        if (destroyed) return
        openPosterMenu({
          kind: current.kind,
          entry: { id: current.id, name: current.name, logo: current.logo },
          activePlaylistId: current.playlistId,
          anchor,
          point,
          onOpen: () => openEntry(current),
        })
      })
    }

    function attach() {
      if (attached || destroyed) return
      attached = true
      import("@/scripts/lib/poster-menu").then(({ attachPosterContextMenu }) => {
        if (destroyed) return
        attachPosterContextMenu(node, open)
      })
    }

    attach()

    return {
      update(next) { current = next },
      destroy() { destroyed = true },
    }
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
  // controller path to Remove from Favourites (Contract F). The
  // right-click/long-press poster menu stays for mouse/touch.
  // Controller X reaches here as the "x" key once W1 routes it to
  // views; physical keyboards get it today.
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
          onWatchlist:
            entry.kind === "live"
              ? false
              : isOnWatchlist(entry.playlistId, entry.kind, entry.id),
          watched:
            entry.kind === "live"
              ? false
              : entry.kind === "vod"
                ? isCompleted(entry.playlistId, "vod", entry.id)
                : hasSeriesWatchedOverride(entry.playlistId, entry.id),
        },
        {
          onOpen: () => void openEntry(entry),
          onPlay: () => void openEntryAt(entry, playHrefFor(entry)),
          onToggleFavorite: () => {
            toggleFavorite(entry.playlistId, entry.kind, entry.id, extras)
            void reload()
          },
          onToggleWatchlist: () => {
            toggleWatchlist(entry.playlistId, entry.kind, entry.id, extras)
          },
          onToggleWatched: (currently) => {
            if (entry.kind === "vod") {
              if (currently) clearProgress(entry.playlistId, "vod", entry.id)
              else markCompleted(entry.playlistId, "vod", entry.id, extras)
            } else if (entry.kind === "series") {
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
    if (!entry || entry.unavailable) return
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
    setLogicalView("favorites")
    setControllerHints({
      id: "favorites",
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
      id: "favorites-root",
      priority: BACK_PRIORITY.ROUTE,
      isActive: () => !findOpenModal() && !isTitleContextMenuOpen(),
      handle: () => {
        navigateBackWithOrigin("/")
        return true
      },
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
      "xt:favorites-changed": reload,
      "xt:favorites-order-changed": reload,
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
  <div class="couch-library__chips" role="tablist" aria-label={tr("favorites.heading")}>
    {#each [
      { id: "all", key: "favorites.filter.all" },
      { id: "live", key: "favorites.filter.live" },
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
      <p class="rs-empty__message">{tr("favorites.helperEmpty")}</p>
    </div>
  {:else if !visible.length}
    <div class="rs-empty">
      <p class="rs-empty__message">{tr("favorites.helperFiltered")}</p>
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
    aria-label={tr("favorites.heading")}>
    {#each visible as entry, idx (entry.playlistId + ":" + entry.kind + ":" + entry.id)}
      <a
        href={entry.href}
        onclick={(event) => openCard(event, entry)}
        use:favoriteCardMenu={entry}
        data-nylah-item
        data-couch-key={entry.playlistId + ":" + entry.kind + ":" + entry.id}
        data-couch-detail-href={entry.href}
        data-couch-play-href={playHrefFor(entry)}
        aria-label={tr("favorites.cardAriaLabel", { name: entry.name, playlist: entry.playlistTitle })}
        aria-disabled={entry.unavailable}
        class="rs-card"
        class:rs-card--poster={entry.kind !== "live"}
        class:rs-card--channel={entry.kind === "live"}
        class:couch-library__card--unavailable={entry.unavailable}>
        <span
          class="rs-card__media couch-library__media"
          class:couch-library__media--poster={entry.kind !== "live"}
          class:couch-library__media--wide={entry.kind === "live"}>
          {#if entry.logo}
            {#if entry.kind === "live"}
              <img
                use:cachedImg={{ url: entry.logo, kind: "logo" }}
                alt=""
                aria-hidden="true"
                loading="lazy" fetchpriority="low"
                decoding="async"
                referrerpolicy="no-referrer"
                width="200" height="300"
                class="absolute inset-0 h-full w-full object-cover scale-110 saturate-150 brightness-75 opacity-60 blur-2xl pointer-events-none" />
              <span class="couch-library__logo-wrap">
                <img
                  use:cachedImg={{ url: entry.logo, kind: "logo" }}
                  alt=""
                  loading="lazy" fetchpriority="low"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  width="200" height="200"
                  class="couch-library__logo" />
              </span>
            {:else}
              <img
                use:cachedImg={{ url: entry.logo, kind: "poster" }}
                alt=""
                loading="lazy" fetchpriority="low"
                decoding="async"
                referrerpolicy="no-referrer"
                width="200" height="300"
                class="couch-library__media-img" />
            {/if}
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
