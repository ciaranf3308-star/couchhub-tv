<!-- RedSilk Couch — Home (W2). Mounted on /.
     Rebuilds the home screen on the W1 shared system: cinematic hero
     from a real catalogue title, then rails in the fixed order —
     Continue Watching (Movies & Series ONLY, live-channel history
     excluded by rule), New Episodes, Picked for You, Trending,
     Recently Added Movies, Continue Your Series, Favourite Live
     Channels, Hidden Gems. A rail renders only when it has meaningful
     data; an empty library shows the branded empty state, never
     invented titles.
     Data comes from the existing services (loadDiscoverData,
     loadTrending, followed provider, preferences) — this view owns
     loading and markup, not engines. -->
<script>
  import { onMount } from "svelte"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import { warmupActive } from "@/scripts/lib/catalog.js"
  import { hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import {
    getActiveProfileId,
    getActiveProfile,
    SHARED_PROFILE_ID,
  } from "@/scripts/lib/profiles.ts"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getContinueWatching,
    getFavorites,
    getFavoriteMeta,
  } from "@/scripts/lib/preferences.js"
  import { readCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
  import { computeNowNext } from "@/scripts/lib/now-next.ts"
  import {
    loadDiscoverData,
    getDiscoverRows,
    candidateKey,
    candidateDetailHref,
  } from "@/scripts/lib/discover.ts"
  import { loadTrending } from "@/scripts/lib/trending.ts"
  import {
    ensureFollowedLoaded,
    followedProvider,
  } from "@/scripts/lib/followed.ts"
  import {
    buildHomeRails,
    vodProgressCards,
    seriesProgressCards,
    rankedCards,
    candidateCards,
    newEpisodeCards,
    trendingCards,
    favouriteChannelCards,
    hiddenGemCards,
    pickHero,
  } from "@/scripts/lib/couch-home.ts"
  import {
    armTvImageFallbacks,
    fallbackMarkFor,
  } from "@/scripts/lib/couch-image.ts"

  let loading = $state(true)
  let noPlaylist = $state(false)
  let loadFailed = $state(false)
  let playlistId = $state("")
  let profileName = $state(null)
  /** @type {import("@/scripts/lib/couch-home.ts").HeroPick | null} */
  let hero = $state(null)
  /** @type {Array<import("@/scripts/lib/couch-home.ts").HomeRail>} */
  let rails = $state([])

  const greeting = $derived.by(() => {
    const hour = new Date().getHours()
    if (hour < 5) return "Good night"
    if (hour < 12) return "Good morning"
    if (hour < 18) return "Good afternoon"
    if (hour < 22) return "Good evening"
    return "Good night"
  })
  const heroTitle = $derived(hero ? hero.candidate.title : greeting)
  const heroMeta = $derived.by(() => {
    if (!hero) {
      const time = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date())
      return time
    }
    const c = hero.candidate
    const parts = []
    if (c.year) parts.push(String(c.year))
    if (typeof c.rating === "number") parts.push(`★ ${c.rating.toFixed(1)}`)
    parts.push(c.kind === "series" ? "Series" : "Film")
    if (profileName) parts.push(`Watching as ${profileName}`)
    return parts.join(" · ")
  })
  const heroHref = $derived.by(() => {
    if (!hero) return ""
    const c = hero.candidate
    return c.kind === "series"
      ? `/series/detail?id=${encodeURIComponent(c.id)}&autoplay=1`
      : `/movies/detail?id=${encodeURIComponent(c.id)}&autoplay=1`
  })

  function heroImageKind(card) {
    return card.kind === "poster" ? "poster" : card.kind === "channel" ? "logo" : "backdrop"
  }

  async function loadFavouriteChannels(pid) {
    const favIds = [...(getFavorites(pid, "live") ?? [])]
    if (!favIds.length) return []
    const channels = readCachedLiveChannels(pid)
    const byId = new Map(channels.map((ch) => [Number(ch.id), ch]))
    let programmes = null
    try {
      const epg = await import("@/scripts/lib/epg-data.js")
      programmes = epg.getProgrammesSync(pid)?.programmes ?? null
    } catch {
      programmes = null
    }
    const out = []
    for (const id of favIds) {
      const channel = byId.get(Number(id))
      const meta = getFavoriteMeta(pid, "live", Number(id))
      const storedName =
        meta?.name && !/^Channel \d+$/i.test(meta.name) ? meta.name : ""
      const name = channel?.name || storedName
      if (!name) continue
      let nowTitle = null
      let nextTitle = null
      if (programmes && channel) {
        try {
          const slot = computeNowNext(programmes, channel, pid)
          nowTitle = slot?.current?.title ?? null
          nextTitle = slot?.next?.title ?? null
        } catch {
          // No guide slot: the card still shows, with "Live TV".
        }
      }
      out.push({
        id: Number(id),
        name,
        logo: meta?.logo ?? channel?.logo ?? null,
        nowTitle,
        nextTitle,
      })
    }
    return out
  }

  onMount(async () => {
    try {
      const entry = await getActiveEntry()
      if (!entry?._id) {
        noPlaylist = true
        loading = false
        return
      }
      playlistId = entry._id
      const profileId = getActiveProfileId() ?? SHARED_PROFILE_ID
      const profile = getActiveProfile()
      profileName = profile && profile.id !== SHARED_PROFILE_ID ? profile.name : null

      await warmupActive(playlistId).catch(() => {})
      await ensurePrefsLoaded().catch(() => {})
      const data = await loadDiscoverData(playlistId, profileId)
      const rows = getDiscoverRows({
        candidates: data.candidates,
        taste: data.taste,
        continueWatching: data.continueWatching,
        recentlyAdded: data.recentlyAdded,
        nowPlaying: data.nowPlaying,
        becauseItems: data.becauseItems,
        watchedKeys: data.watchedKeys,
        excludeWatched: true,
      })
      const pickedRow = rows.find((r) => r.id === "picked-for-you")
      const pickedItems = pickedRow?.items ?? []

      const byKey = new Map(data.candidates.map((c) => [candidateKey(c), c]))
      const progressRows = getContinueWatching(playlistId, 12) || []

      const trendingResult = await loadTrending(playlistId).catch(() => ({
        source: "none",
        items: [],
      }))

      await ensureFollowedLoaded().catch(() => {})
      const episodes = followedProvider.getNewEpisodes()

      await hydrateCache(playlistId, "live").catch(() => {})
      const favChannels = await loadFavouriteChannels(playlistId)

      const pickedKeys = new Set(pickedItems.map((r) => candidateKey(r.candidate)))
      const gemExcluded = new Set([...pickedKeys, ...data.taste.notInterestedKeys])

      hero = pickHero({
        continueWatching: data.continueWatching,
        picked: pickedItems,
        recentlyAdded: data.recentlyAdded,
      })
      rails = buildHomeRails({
        continueWatching: vodProgressCards(progressRows, byKey),
        newEpisodes: newEpisodeCards(episodes),
        picked: rankedCards(pickedItems),
        trendingSource: trendingResult.source,
        trending: trendingCards(trendingResult.items),
        recentlyAdded: candidateCards(
          data.recentlyAdded.filter((c) => c.kind === "movie"),
        ),
        continueSeries: seriesProgressCards(progressRows, byKey),
        favouriteChannels: favouriteChannelCards(favChannels),
        hiddenGems: hiddenGemCards(data.candidates, data.watchedKeys, gemExcluded),
      })
    } catch {
      loadFailed = true
    } finally {
      loading = false
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
</script>

<div class="rs-home" data-home-root>
  {#if loading}
    <div class="rs-skeleton rs-skeleton--hero" aria-hidden="true"></div>
    <div class="rs-skeleton-row" style="display: flex; gap: 1.25rem;" aria-hidden="true">
      {#each Array.from({ length: 6 }) as _, i}
        <div class="rs-skeleton rs-skeleton--poster" style="flex: 1 1 0; min-width: 0; animation-delay: {i * 90}ms;"></div>
      {/each}
    </div>
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
          class="rs-image rs-image--backdrop{hero?.candidate.posterUrl ? '' : ' is-fallback'}"
          data-tv-image
          data-kind="backdrop"
        >
          {#if hero?.candidate.posterUrl}
            <img
              src={hero.candidate.posterUrl}
              alt=""
              loading="eager"
              decoding="async"
              data-tv-image-img
            />
          {:else}
            <img
              src="/art/hero-backdrop.jpg"
              alt=""
              loading="eager"
              decoding="async"
              data-tv-image-img
            />
          {/if}
          <div class="rs-image__fallback" aria-hidden="true">
            <span class="rs-image__fallback-mark">N</span>
            {#if hero}
              <span class="rs-image__fallback-title">{hero.candidate.title}</span>
            {/if}
          </div>
        </div>
      </div>
      <div class="rs-hero__scrim" aria-hidden="true"></div>
      <div class="rs-hero__content">
        {#if hero}
          <span class="rs-hero__eyebrow">{hero.eyebrow}</span>
        {/if}
        <h1 class="rs-hero-title">{heroTitle}</h1>
        <p class="rs-hero__meta">{heroMeta}</p>
        {#if hero?.candidate.overview}
          <p class="rs-hero__description">{hero.candidate.overview}</p>
        {:else if !hero}
          <p class="rs-hero__description">Your films, series and live channels, picked for the couch.</p>
        {/if}
        {#if hero}
          <div class="rs-hero__actions">
            <a class="rs-hero__action" data-nylah-item href={heroHref}>▶ Play</a>
            <a
              class="rs-hero__action rs-hero__action--secondary"
              data-nylah-item
              href={candidateDetailHref(hero.candidate)}
            >More Info</a>
          </div>
        {/if}
      </div>
    </section>

    {#if rails.length}
      <div data-nylah-rails>
        {#each rails as rail (rail.id)}
          <section class="rs-rail" data-nylah-rail={rail.id} aria-label={rail.title}>
            <div class="rs-rail__head">
              <h2 class="rs-section-title">{rail.title}</h2>
              {#if rail.href}
                <a class="rs-rail__more" href={rail.href}>See all ›</a>
              {/if}
            </div>
            {#if rail.subtitle}
              <p class="rs-meta">{rail.subtitle}</p>
            {/if}
            <div class="rs-rail__row">
              {#each rail.cards as card (card.key)}
                {@render homeCard(card)}
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

{#snippet homeCard(card)}
  {@const imageKind = heroImageKind(card)}
  <a
    class="rs-card rs-card--{card.kind}"
    data-nylah-item
    data-couch-key={card.key}
    href={card.href}
    aria-label={card.title}
  >
    <span class="rs-card__media">
      <span
        class="rs-image rs-image--{imageKind}{card.image ? '' : ' is-fallback'}"
        data-tv-image
        data-kind={imageKind}
      >
        {#if card.image}
          <img
            src={card.image}
            alt={card.title}
            loading="lazy"
            decoding="async"
            data-tv-image-img
          />
        {/if}
        <span class="rs-image__fallback" aria-hidden="true">
          <span class="rs-image__fallback-mark">{fallbackMarkFor(imageKind, card.title)}</span>
          <span class="rs-image__fallback-title">{card.title}</span>
        </span>
      </span>
      {#if card.badge}
        <span class="rs-card__badge">{card.badge}</span>
      {/if}
      {#if typeof card.progress === "number" && card.progress > 0}
        <span class="rs-card__progress" aria-hidden="true">
          <span class="rs-card__progress-fill" style="width: {Math.round(card.progress * 100)}%" />
        </span>
      {/if}
    </span>
    <span class="rs-card__body">
      <span class="rs-card__title">{card.title}</span>
      {#if card.subtitle}
        <span class="rs-card__subtitle">{card.subtitle}</span>
      {/if}
      {#if card.meta}
        <span class="rs-card__meta">{card.meta}</span>
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
</style>
