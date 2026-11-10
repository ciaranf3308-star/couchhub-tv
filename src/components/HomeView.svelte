<!-- RedSilk Couch — Home (W3 production pass). Mounted on /.
     Renders the W2 home-rails contract (see home-assembly.ts):
     a cinematic hero from a real catalogue title, then rails in
     order — Continue Watching, New Episodes, Picked for You,
     Trending, Recently Added Movies, Continue Your Series, Favourite
     Live Channels, Hidden Gems. A rail renders only when it has
     meaningful data; an empty library shows the branded empty state,
     never invented titles.
     Loading contract: cached first paint (getCachedHomeRails()
     renders synchronously), then a debounced progressive refresh;
     a failed refresh NEVER replaces valid cached content with an
     empty screen. Loads are cancelled (AbortController) when a newer
     load supersedes them or the view unmounts. Focus returns to the
     same rail + card after a detail visit via the shared
     couch-focus.ts memory (stable data-couch-key); this view never
     moves focus itself except to restore it when nothing is focused. -->
<script>
  import { onMount, onDestroy, tick } from "svelte"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import { warmupActive } from "@/scripts/lib/catalog.js"
  import {
    getActiveProfileId,
    getActiveProfile,
    SHARED_PROFILE_ID,
  } from "@/scripts/lib/profiles.ts"
  import { ensureLoaded as ensurePrefsLoaded } from "@/scripts/lib/preferences.js"
  import { loadDiscoverData } from "@/scripts/lib/discover.ts"
  import {
    getCachedHomeRails,
    loadHomeRails,
    loadFollowedEpisodes,
    mergeHomePayload,
  } from "@/scripts/lib/home-assembly.ts"
  import { restoreCouchFocus } from "@/scripts/lib/couch-focus.ts"
  import {
    armTvImageFallbacks,
    fallbackMarkFor,
  } from "@/scripts/lib/couch-image.ts"

  let loading = $state(true)
  let noPlaylist = $state(false)
  let loadFailed = $state(false)
  /** Fresh load failed but cached content is on screen — non-fatal. */
  let refreshFailed = $state(false)
  let playlistId = $state("")
  let profileId = $state(SHARED_PROFILE_ID)
  let profileName = $state(null)
  /** @type {import("@/scripts/lib/home-assembly.ts").HomeHero | null} */
  let hero = $state(null)
  /** @type {Array<import("@/scripts/lib/home-assembly.ts").HomeRail>} */
  let rails = $state([])

  let mounted = false
  /** @type {AbortController | null} */
  let currentLoad = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let refreshTimer = null

  const greeting = $derived.by(() => {
    const hour = new Date().getHours()
    if (hour < 5) return "Good night"
    if (hour < 12) return "Good morning"
    if (hour < 18) return "Good afternoon"
    if (hour < 22) return "Good evening"
    return "Good night"
  })
  const heroItem = $derived(hero?.item ?? null)
  const heroTitle = $derived(heroItem ? heroItem.title : greeting)
  const heroMeta = $derived.by(() => {
    if (!heroItem) {
      const time = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date())
      return time
    }
    const parts = []
    if (heroItem.year) parts.push(String(heroItem.year))
    if (typeof heroItem.rating === "number") parts.push(`★ ${heroItem.rating.toFixed(1)}`)
    parts.push(heroItem.kind === "series" ? "Series" : heroItem.kind === "live" ? "Live TV" : "Film")
    if (heroItem.runtimeMinutes) {
      const h = Math.floor(heroItem.runtimeMinutes / 60)
      const m = heroItem.runtimeMinutes % 60
      parts.push(h > 0 ? `${h}h ${m}m` : `${m} min`)
    }
    if (profileName) parts.push(`Watching as ${profileName}`)
    return parts.join(" · ")
  })
  const heroBackdrop = $derived(
    heroItem?.backdropUrl ?? heroItem?.posterUrl ?? "/art/hero-backdrop.jpg",
  )
  const heroActionLabel = $derived(
    heroItem && typeof heroItem.progress === "number" && heroItem.progress > 0
      ? "Resume"
      : "Play",
  )

  /** Current on-screen payload, for the never-replace-cache rule. */
  function currentPayload() {
    return { hero, rails }
  }

  function applyPayload(payload) {
    hero = payload.hero
    rails = payload.rails
    // Focus moves only via restore: after a cached→fresh swap the old
    // focused node is gone, so restore the remembered rail + card by
    // stable key (restoreCouchFocus is a no-op when something is
    // already focused or a modal is open).
    void tick().then(() => {
      if (mounted) restoreCouchFocus()
    })
  }

  async function refresh() {
    if (!playlistId) return
    currentLoad?.abort()
    const controller = new AbortController()
    currentLoad = controller
    try {
      const data = await loadDiscoverData(playlistId, profileId)
      if (controller.signal.aborted) return
      const episodes = await loadFollowedEpisodes()
      if (controller.signal.aborted) return
      const fresh = await loadHomeRails(data, episodes, {
        playlistId,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      const next = mergeHomePayload(currentPayload(), fresh)
      if (next) applyPayload(next)
      refreshFailed = false
    } catch (err) {
      if (controller.signal.aborted || err?.name === "AbortError") return
      // Never blank a good screen: only a hard failure with nothing
      // on screen becomes the error state.
      if (!hero && rails.length === 0) loadFailed = true
      else refreshFailed = true
    } finally {
      if (currentLoad === controller) currentLoad = null
      if (mounted) loading = false
    }
  }

  /** Debounced refresh (returning to the tab revalidates, quietly). */
  function scheduleRefresh(delayMs = 800) {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (mounted && !document.hidden) void refresh()
    }, delayMs)
  }

  function onVisibilityChange() {
    if (!document.hidden) scheduleRefresh()
  }

  onMount(async () => {
    mounted = true
    // Cached first paint: render synchronously, before any network.
    const cached = getCachedHomeRails()
    if (cached && (cached.hero || cached.rails.length > 0)) {
      applyPayload(cached)
      loading = false
    }
    try {
      const entry = await getActiveEntry()
      if (!entry?._id) {
        noPlaylist = true
        loading = false
        return
      }
      playlistId = entry._id
      profileId = getActiveProfileId() ?? SHARED_PROFILE_ID
      const profile = getActiveProfile()
      profileName = profile && profile.id !== SHARED_PROFILE_ID ? profile.name : null

      await warmupActive(playlistId).catch(() => {})
      await ensurePrefsLoaded().catch(() => {})
      await refresh()
    } catch {
      if (mounted && !hero && rails.length === 0) loadFailed = true
      loading = false
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
  })

  onDestroy(() => {
    mounted = false
    currentLoad?.abort()
    if (refreshTimer) clearTimeout(refreshTimer)
    // onDestroy also runs during SSR prerender, where there is no DOM.
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  })

  // W1 image fallback: arms the capture-phase error handler once; the
  // scan covers images that already failed before this ran.
  $effect(() => {
    void loading
    void rails
    void hero
    armTvImageFallbacks(document)
  })

  function itemMeta(item) {
    const parts = []
    if (item.year) parts.push(String(item.year))
    if (typeof item.rating === "number") parts.push(`★ ${item.rating.toFixed(1)}`)
    return parts.length ? parts.join(" · ") : undefined
  }

  /**
   * Presentation for one rail item. Badges are labels, not competing
   * accents (one badge style): "New" for new episodes, "Live" for
   * live programmes. Landscape cards for episode-led rails, posters
   * elsewhere, fitted logos for channels.
   */
  function cardDisplay(rail, item) {
    const isLive = item.kind === "live" || item.isLive === true
    const isNewEpisode = rail.id === "new-episodes"
    const mediaKind = isLive
      ? "logo"
      : rail.kind === "continue-series" || isNewEpisode
        ? "backdrop"
        : "poster"
    const cardKind = isLive ? "channel" : mediaKind === "backdrop" ? "landscape" : "poster"
    return {
      mediaKind,
      cardKind,
      subtitle: isLive ? (item.nowTitle ?? "Live TV") : item.reason,
      meta: isLive
        ? item.nextTitle
          ? `Next: ${item.nextTitle}`
          : undefined
        : itemMeta(item),
      badge: isNewEpisode ? "New" : isLive ? "Live" : undefined,
    }
  }
</script>

<div class="rs-home" data-home-root>
  {#if loading}
    <div class="rs-skeleton rs-skeleton--hero" aria-hidden="true"></div>
    <div class="rs-skeleton-row" style="display: flex; gap: 1.25rem;" aria-hidden="true">
      {#each Array.from({ length: 6 }) as _, i}
        <div class="rs-skeleton rs-skeleton--poster" style="flex: 1 1 0; min-width: 0; animation-delay: {i * 90}ms;"></div>
      {/each}
    </div>
    <span class="rs-sr-only" role="status">Loading Home</span>
  {:else if noPlaylist}
    <div class="rs-empty" role="status">
      <div class="rs-empty__art">
        <div class="rs-image rs-image--backdrop is-fallback" data-tv-image data-kind="backdrop">
          <div class="rs-image__fallback" aria-hidden="true">
            <span class="rs-image__fallback-mark">N</span>
            <span class="rs-image__fallback-title">NylahBox Studios</span>
          </div>
        </div>
      </div>
      <h2 class="rs-empty__title">Nothing to watch yet</h2>
      <p class="rs-empty__message">Add a playlist in Settings and your films, series and live channels will show up here.</p>
      <a class="rs-empty__action" data-nylah-item href="/settings">Go to Settings</a>
    </div>
  {:else if loadFailed}
    <div class="rs-empty" role="status">
      <h2 class="rs-empty__title">Home couldn't load</h2>
      <p class="rs-empty__message">Your library may still be warming up — try again in a moment.</p>
      <button type="button" class="rs-empty__action" onclick={() => location.reload()}>Try again</button>
    </div>
  {:else}
    <section class="rs-hero" data-nylah-hero aria-label={heroTitle}>
      <div class="rs-hero__backdrop" aria-hidden="true">
        <div
          class="rs-image rs-image--backdrop{heroItem ? '' : ' is-fallback'}"
          data-tv-image
          data-kind="backdrop"
        >
          <img
            src={heroBackdrop}
            alt=""
            loading="eager"
            decoding="async"
            data-tv-image-img
          />
          <div class="rs-image__fallback" aria-hidden="true">
            <span class="rs-image__fallback-mark">N</span>
            {#if heroItem}
              <span class="rs-image__fallback-title">{heroItem.title}</span>
            {/if}
          </div>
        </div>
      </div>
      <div class="rs-hero__scrim" aria-hidden="true"></div>
      <div class="rs-hero__content">
        {#if hero?.reason}
          <span class="rs-hero__eyebrow">{hero.reason}</span>
        {/if}
        <h1 class="rs-hero-title">{heroTitle}</h1>
        <p class="rs-hero__meta">{heroMeta}</p>
        {#if heroItem?.overview}
          <p class="rs-hero__description">{heroItem.overview}</p>
        {:else if !heroItem}
          <p class="rs-hero__description">Your films, series and live channels, picked for the couch.</p>
        {/if}
        {#if heroItem}
          <div class="rs-hero__actions">
            {#if heroItem.playHref}
              <a class="rs-hero__action" data-nylah-item href={heroItem.playHref}>▶ {heroActionLabel}</a>
            {/if}
            <a
              class="rs-hero__action rs-hero__action--secondary"
              data-nylah-item
              href={heroItem.detailHref}
            >More Info</a>
          </div>
        {/if}
      </div>
    </section>

    {#if refreshFailed}
      <p class="rs-home__notice" role="status">Couldn't refresh — showing your last Home.</p>
    {/if}

    {#if rails.length}
      <div data-nylah-rails>
        {#each rails as rail (rail.id)}
          <section class="rs-rail" data-nylah-rail={rail.id} aria-label={rail.title}>
            <div class="rs-rail__head">
              <h2 class="rs-section-title">{rail.title}</h2>
              {#if rail.seeAllHref}
                <a class="rs-rail__more" href={rail.seeAllHref}>See all ›</a>
              {/if}
            </div>
            {#if rail.description}
              <p class="rs-meta">{rail.description}</p>
            {/if}
            <div class="rs-rail__row">
              {#each rail.items as item (item.key)}
                {@render homeCard(rail, item)}
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {:else}
      <div class="rs-empty" role="status">
        <div class="rs-empty__art">
          <div class="rs-image rs-image--backdrop is-fallback" data-tv-image data-kind="backdrop">
            <div class="rs-image__fallback" aria-hidden="true">
              <span class="rs-image__fallback-mark">N</span>
              <span class="rs-image__fallback-title">NylahBox Studios</span>
            </div>
          </div>
        </div>
        <h2 class="rs-empty__title">Your library is empty</h2>
        <p class="rs-empty__message">Once films and series are in your playlist, your picks, trending titles and new episodes will appear here.</p>
        <a class="rs-empty__action" data-nylah-item href="/discover">Browse Discover</a>
      </div>
    {/if}
  {/if}
</div>

{#snippet homeCard(rail, item)}
  {@const display = cardDisplay(rail, item)}
  <a
    class="rs-card rs-card--{display.cardKind}"
    data-nylah-item
    data-couch-key={item.key}
    href={item.detailHref}
    aria-label={item.title}
  >
    <span class="rs-card__media">
      <span
        class="rs-image rs-image--{display.mediaKind}{item.posterUrl ? '' : ' is-fallback'}"
        data-tv-image
        data-kind={display.mediaKind}
      >
        {#if item.posterUrl}
          <img
            src={item.posterUrl}
            alt={item.title}
            loading="lazy"
            decoding="async"
            data-tv-image-img
          />
        {/if}
        <span class="rs-image__fallback" aria-hidden="true">
          <span class="rs-image__fallback-mark">{fallbackMarkFor(display.mediaKind, item.title)}</span>
          <span class="rs-image__fallback-title">{item.title}</span>
        </span>
      </span>
      {#if display.badge}
        <span class="rs-card__badge">{display.badge}</span>
      {/if}
      {#if typeof item.progress === "number" && item.progress > 0}
        <span class="rs-card__progress" aria-hidden="true">
          <span class="rs-card__progress-fill" style="width: {Math.round(item.progress * 100)}%" />
        </span>
      {/if}
    </span>
    <span class="rs-card__body">
      <span class="rs-card__title">{item.title}</span>
      {#if display.subtitle}
        <span class="rs-card__subtitle">{display.subtitle}</span>
      {/if}
      {#if display.meta}
        <span class="rs-card__meta">{display.meta}</span>
      {/if}
    </span>
  </a>
{/snippet}

<style>
  .rs-home {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }
  /* Rail rows are not focusable containers; keep the page's vertical
     rhythm tight to the shared rail spacing. */
  .rs-home .rs-rail__head {
    margin-bottom: 0.25rem;
  }
  /* Production pass — hero presence: 40–45% of the initial viewport
     (scoped here; couch.css itself is W1-owned). */
  .rs-home .rs-hero,
  .rs-home .rs-skeleton--hero {
    min-height: clamp(24rem, 42vh, 34rem);
  }
  /* Production pass — large card density: ~5–6 substantial cards per
     visible rail at 1080p. This is the Home-side half of the W1
     density variant (TvRail's own density prop lands with W1); the
     values match the contract's "large" size until then. */
  .rs-home .rs-rail__row > .rs-card--poster {
    flex-basis: clamp(11rem, 14vw, 15.5rem);
  }
  .rs-home .rs-rail__row > .rs-card--landscape,
  .rs-home .rs-rail__row > .rs-card--channel {
    flex-basis: clamp(19rem, 23vw, 27rem);
  }
  /* Quiet refresh-failure notice: text only, no banner, no accent. */
  .rs-home__notice {
    color: var(--rs-text-2);
    font-size: 1.125rem;
    margin: -0.75rem 0.25rem 0;
  }
  .rs-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
