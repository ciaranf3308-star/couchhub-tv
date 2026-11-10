<!-- RedSilk Discover (W2 reskin onto the W1 shared system). Mounted on
     /discover. Logic is unchanged from the W1 Discover CORE: the
     catalogue loads once at mount, search and ranking run in the page,
     and no network request happens during ordinary controller
     navigation. The AI ranker is registered at mount and only consulted
     (via rankWithAI) for natural-language questions — with no ranker,
     or on any AI failure, local ranking runs. The followed-series
     provider is registered at mount too, feeding the "New Episodes of
     Followed Shows" row.
     Reskin: CouchLayout shell (discover.astro), TvKeyboard for mood
     search, rs-rail / rs-card markup with the W1 image-fallback
     structure, rs-empty / rs-skeleton states. -->
<script>
  import { onMount } from "svelte"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import { warmupActive } from "@/scripts/lib/catalog.js"
  import {
    getActiveProfileId,
    SHARED_PROFILE_ID,
    toggleProfileFavorite,
  } from "@/scripts/lib/profiles.ts"
  import {
    toggleFavorite,
    markCompleted,
    setSeriesWatchedOverride,
  } from "@/scripts/lib/preferences.js"
  import {
    loadDiscoverData,
    getDiscoverRows,
    searchDiscover,
    rankWithAI,
    rankCandidates,
    applyDiscoverFeedback,
    candidateDetailHref,
    candidateKey,
    MOOD_PRESETS,
    registerAIRanker,
    registerFollowedProvider,
  } from "@/scripts/lib/discover.ts"
  import { saveTaste, summarizeTaste } from "@/scripts/lib/taste.ts"
  // Intelligence Upgrade seams (coordinator wiring): W2's AI ranker and
  // W3's followed-series provider. The engine (discover.ts) imports
  // neither — registration lives here, at Discover mount.
  import { aiRanker } from "@/scripts/lib/ai/ranking.ts"
  import { initAI } from "@/scripts/lib/ai/init.ts"
  import { ensureFollowedLoaded, followedProvider } from "@/scripts/lib/followed.ts"
  import { fmtImdbRating } from "@/scripts/lib/format.ts"
  import TvKeyboard from "@/components/couch/TvKeyboard.svelte"
  import {
    armTvImageFallbacks,
    fallbackMarkFor,
  } from "@/scripts/lib/couch-image.ts"

  let query = $state("")
  let queryDebounced = $state("")
  let loading = $state(true)
  let noPlaylist = $state(false)
  let loadFailed = $state(false)
  let playlistId = $state("")
  let profileId = $state(SHARED_PROFILE_ID)
  /** @type {import("@/scripts/lib/discover.ts").DiscoverData | null} */
  let data = $state(null)
  /** @type {Array<import("@/scripts/lib/discover.ts").DiscoverRow>} */
  let rows = $state([])
  /** @type {Array<import("@/scripts/lib/discover.ts").RankedCandidate> | null} */
  let searchResults = $state(null)
  let searching = $state(false)
  /** @type {string | null} */
  let activeMood = $state(null)
  /** @type {{ title: string, genres: string[], cast: string[], director?: string } | null} */
  let moreLikeSeed = $state(null)
  /** @type {Record<string, boolean>} */
  let whyOpen = $state({})
  let toast = $state("")
  let toastTimer = null

  const showingSearch = $derived(
    queryDebounced.trim() !== "" || !!activeMood || !!moreLikeSeed
  )
  const tasteSummary = $derived(data ? summarizeTaste(data.taste) : null)

  function showToast(message) {
    toast = message
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast = ""
    }, 3500)
  }

  function refreshRows() {
    if (!data) return
    rows = getDiscoverRows({
      candidates: data.candidates,
      taste: data.taste,
      continueWatching: data.continueWatching,
      recentlyAdded: data.recentlyAdded,
      nowPlaying: data.nowPlaying,
      becauseItems: data.becauseItems,
      watchedKeys: data.watchedKeys,
      excludeWatched: true,
    })
  }

  /** Hide watched / not-interested cards from a search result list. */
  function visibleResults(list) {
    if (!data) return list
    const excluded = new Set([
      ...data.taste.notInterestedKeys,
      ...[...data.watchedKeys],
    ])
    return list.filter((item) => !excluded.has(candidateKey(item.candidate)))
  }

  let searchToken = 0
  async function runSearch() {
    if (!data) return
    const token = ++searchToken
    const q = queryDebounced.trim()
    if (!q && !activeMood && !moreLikeSeed) {
      searchResults = null
      searching = false
      return
    }
    searching = true
    try {
      let results
      if (moreLikeSeed) {
        // "More Like This": rank the catalogue against this one title.
        results = rankCandidates(data.candidates, data.taste, {
          seedTitles: [moreLikeSeed],
          excludeWatched: true,
          watchedKeys: data.watchedKeys,
          excludeKeys: new Set(data.taste.notInterestedKeys),
          limit: 12,
        })
      } else if (activeMood && !q) {
        results = searchDiscover("", data.candidates, data.taste, {
          moodId: activeMood,
          excludeWatched: true,
          watchedKeys: data.watchedKeys,
          excludeKeys: new Set(data.taste.notInterestedKeys),
          limit: 12,
        })
      } else {
        // Natural-language questions go to the registered AI ranker when
        // one exists; plain title searches and the no-ranker case stay
        // local. rankWithAI validates every id against the catalogue.
        results = await rankWithAI(q, data.candidates, data.taste)
        results = visibleResults(results)
      }
      if (token !== searchToken) return
      searchResults = results.slice(0, 24)
    } finally {
      if (token === searchToken) searching = false
    }
  }

  let queryTimer = null
  function onQueryInput(value) {
    query = value
    if (queryTimer) clearTimeout(queryTimer)
    queryTimer = setTimeout(() => {
      queryDebounced = value
      void runSearch()
    }, 150)
  }

  function onOskInput(value) {
    onQueryInput(value)
  }

  function focusFirstResult() {
    requestAnimationFrame(() => {
      document
        .querySelector("[data-discover-results] [data-nylah-item], [data-discover-rows] [data-nylah-item]")
        ?.focus()
    })
  }

  function pickMood(presetId) {
    moreLikeSeed = null
    activeMood = activeMood === presetId ? null : presetId
    query = ""
    queryDebounced = ""
    void runSearch()
  }

  function clearSearch() {
    query = ""
    queryDebounced = ""
    activeMood = null
    moreLikeSeed = null
    searchResults = null
  }

  function feedback(candidate, action) {
    if (!data) return
    if (action === "more-like-this") {
      moreLikeSeed = {
        title: candidate.title,
        genres: candidate.genres,
        cast: candidate.cast,
        director: candidate.director,
      }
      activeMood = null
      query = ""
      queryDebounced = ""
      data.taste = applyDiscoverFeedback(data.taste, candidate, action)
      saveTaste(data.taste)
      showToast(`More like ${candidate.title}`)
      void runSearch()
      return
    }
    data.taste = applyDiscoverFeedback(data.taste, candidate, action)
    saveTaste(data.taste)

    if (action === "favourite") {
      const kind = candidate.kind === "movie" ? "vod" : candidate.kind === "series" ? "series" : null
      if (kind && playlistId) {
        if (profileId === SHARED_PROFILE_ID) {
          toggleFavorite(playlistId, kind, Number(candidate.id), {
            name: candidate.title,
            logo: candidate.posterUrl || null,
          })
        } else {
          toggleProfileFavorite(profileId, kind, Number(candidate.id), {
            name: candidate.title,
            logo: candidate.posterUrl || null,
          })
        }
      }
      showToast(`Added ${candidate.title} to favourites`)
    } else if (action === "already-watched") {
      if (playlistId) {
        if (candidate.kind === "movie") {
          markCompleted(playlistId, "vod", candidate.id, { name: candidate.title })
        } else if (candidate.kind === "series") {
          setSeriesWatchedOverride(playlistId, candidate.id, true)
        }
      }
      data.watchedKeys = new Set([...data.watchedKeys, candidateKey(candidate)])
      showToast(`Marked ${candidate.title} as watched`)
    } else if (action === "not-interested") {
      showToast(`You won't see ${candidate.title} in Discover again`)
    } else {
      showToast("Noted — Discover will learn from this")
    }
    refreshRows()
    if (searchResults) searchResults = visibleResults(searchResults)
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
      profileId = getActiveProfileId() ?? SHARED_PROFILE_ID
      // Register the AI ranker (W2) and followed-series provider (W3) so
      // natural-language search can rank with the model and the "New
      // Episodes of Followed Shows" row is live. Best-effort: a failure
      // here must never break the local engine — with no ranker,
      // rankWithAI falls back to local ranking, and with no provider the
      // New Episodes row simply hides.
      registerAIRanker(aiRanker)
      await initAI().catch(() => {})
      await ensureFollowedLoaded().catch(() => {})
      registerFollowedProvider(followedProvider)
      // Warm the catalogue the way the home page does; Discover then
      // reads the already-loaded cache — no extra network per screen open.
      await warmupActive(playlistId).catch(() => {})
      data = await loadDiscoverData(playlistId, profileId)
      refreshRows()
    } catch {
      loadFailed = true
    } finally {
      loading = false
    }
  })

  // W1 image fallback: arms the capture-phase error handler once; the
  // scan covers images that already failed before this ran.
  $effect(() => {
    void rows
    void searchResults
    void loading
    armTvImageFallbacks(document)
  })
</script>

<div class="rs-discover" data-discover-root>
  <div class="rs-discover__search">
    <div class="rs-discover__input-row">
      <label for="discover-query" class="sr-only">What are you in the mood for?</label>
      <input
        id="discover-query"
        type="search"
        bind:value={query}
        oninput={(e) => onQueryInput(e.currentTarget.value)}
        placeholder="What are you in the mood for?"
        autocomplete="off"
        class="rs-discover-input" />
      {#if query || activeMood || moreLikeSeed}
        <button
          type="button"
          onclick={clearSearch}
          class="rs-discover-clear">Clear</button>
      {/if}
    </div>

    <!-- Controller path to typing: QWERTY grid, A types, B deletes, X clears. -->
    <TvKeyboard
      bind:value={query}
      onInput={onOskInput}
      onCommit={focusFirstResult}
      placeholder="What are you in the mood for?" />

    <div class="rs-discover__moods" role="group" aria-label="Quick picks">
      {#each MOOD_PRESETS as preset (preset.id)}
        <button
          type="button"
          onclick={() => pickMood(preset.id)}
          aria-pressed={activeMood === preset.id}
          class="rs-discover-chip"
          class:is-active={activeMood === preset.id}>
          {preset.label}
        </button>
      {/each}
    </div>
  </div>

  {#if toast}
    <p role="status" class="rs-discover-toast">{toast}</p>
  {/if}

  {#if loading}
    <div class="rs-skeleton rs-skeleton--hero" aria-hidden="true"></div>
    <div class="rs-skeleton-row" style="display: flex; gap: 1.25rem;" aria-hidden="true">
      {#each Array.from({ length: 6 }) as _, i}
        <div class="rs-skeleton rs-skeleton--poster" style="flex: 1 1 0; min-width: 0; animation-delay: {i * 90}ms;"></div>
      {/each}
    </div>
  {:else if noPlaylist}
    <div class="rs-empty" role="status">
      <h2 class="rs-empty__title">Nothing to discover yet</h2>
      <p class="rs-empty__message">Add a playlist in Settings and Discover will learn from what you watch.</p>
      <a class="rs-empty__action" data-nylah-item href="/settings">Go to Settings</a>
    </div>
  {:else if loadFailed}
    <div class="rs-empty" role="status">
      <h2 class="rs-empty__title">Discover couldn't load</h2>
      <p class="rs-empty__message">Your library may still be warming up — try again in a moment.</p>
      <button type="button" class="rs-empty__action" onclick={() => location.reload()}>Try again</button>
    </div>
  {:else if showingSearch}
    <section class="rs-rail" data-discover-results data-nylah-rail="discover-results" aria-label="Discover results">
      <div class="rs-rail__head">
        <h2 class="rs-section-title">
          {#if moreLikeSeed}
            More like {moreLikeSeed.title}
          {:else if activeMood}
            {MOOD_PRESETS.find((p) => p.id === activeMood)?.label}
          {:else}
            Results for “{queryDebounced.trim()}”
          {/if}
        </h2>
        {#if searching}
          <p class="rs-meta">Searching your library…</p>
        {/if}
      </div>
      {#if searchResults && searchResults.length}
        <div class="rs-rail__row">
          {#each searchResults as item (candidateKey(item.candidate))}
            {@render discoverCard(item)}
          {/each}
        </div>
      {:else if !searching}
        <p class="rs-meta">Nothing matched — try a different word or a quick pick above. Discover only searches titles already in your library.</p>
      {/if}
    </section>
  {:else}
    <div data-discover-rows class="rs-discover__rows">
      {#each rows as row (row.id)}
        {#if row.items.length}
          <section class="rs-rail" data-nylah-rail={row.id} aria-label={row.title}>
            <div class="rs-rail__head">
              <h2 class="rs-section-title">{row.title}</h2>
            </div>
            {#if row.subtitle}<p class="rs-meta">{row.subtitle}</p>{/if}
            <div class="rs-rail__row">
              {#each row.items as item (candidateKey(item.candidate))}
                {@render discoverCard(item)}
              {/each}
            </div>
          </section>
        {/if}
      {/each}
      {#if !rows.some((r) => r.items.length)}
        <p class="rs-meta">Your library looks empty — once titles are in, Discover will have picks for you here.</p>
      {/if}
    </div>
  {/if}
</div>

{#snippet discoverCard(item)}
  {@const c = item.candidate}
  {@const key = candidateKey(c)}
  {@const isFav = data?.taste.favouriteTitles.some((f) => `${f.kind}:${f.id}` === key)}
  {@const cardKind = c.kind === "live" ? "channel" : "poster"}
  {@const imageKind = c.kind === "live" ? "logo" : "poster"}
  <div class="rs-discover-cell rs-discover-cell--{cardKind}">
    <article class="rs-discover-card">
      <a
        href={candidateDetailHref(c)}
        data-nylah-item
        data-couch-key={key}
        aria-label={`${c.title}${c.year ? ` (${c.year})` : ""}${c.kind === "live" ? ", live TV" : ""}`}
        class="rs-card rs-card--{cardKind}">
        <span class="rs-card__media">
          <span
            class="rs-image rs-image--{imageKind}{c.posterUrl ? '' : ' is-fallback'}"
            data-tv-image
            data-kind={imageKind}
          >
            {#if c.posterUrl}
              <img
                src={c.posterUrl}
                alt=""
                loading="lazy"
                fetchpriority="low"
                decoding="async"
                referrerpolicy="no-referrer"
                data-tv-image-img
              />
            {/if}
            <span class="rs-image__fallback" aria-hidden="true">
              <span class="rs-image__fallback-mark">{fallbackMarkFor(imageKind, c.title)}</span>
              <span class="rs-image__fallback-title">{c.title}</span>
            </span>
          </span>
          {#if c.kind === "live"}
            <span class="rs-card__badge">● Live</span>
          {/if}
          {#if c.rating}
            <span class="rs-discover-rating" aria-label={`Rating ${fmtImdbRating(c.rating)} out of 10`}>
              <span aria-hidden="true">★</span><span>{fmtImdbRating(c.rating)}</span>
            </span>
          {/if}
        </span>
        <span class="rs-card__body">
          <span class="rs-card__title">{c.title}</span>
          <span class="rs-card__subtitle">
            {#if c.year}{c.year} · {/if}{c.kind === "series" ? "Series" : c.kind === "live" ? "Live TV" : "Film"}
          </span>
          <span class="rs-card__meta rs-discover-reason">{item.reason}</span>
        </span>
      </a>
      <div class="rs-discover-fb">
        <button type="button" onclick={() => feedback(c, "more-like-this")} class="discover-fb-btn" title="More like this">More like this</button>
        <button type="button" onclick={() => feedback(c, "not-interested")} class="discover-fb-btn" title="Not interested">Not interested</button>
        {#if c.kind !== "live"}
          <button type="button" onclick={() => feedback(c, "already-watched")} class="discover-fb-btn" title="Already watched">Watched</button>
          <button type="button" onclick={() => feedback(c, "favourite")} aria-pressed={!!isFav} class="discover-fb-btn" title="Favourite">{isFav ? "★ Favourite" : "☆ Favourite"}</button>
        {/if}
        <button
          type="button"
          onclick={() => { whyOpen = { ...whyOpen, [key]: !whyOpen[key] } }}
          aria-expanded={!!whyOpen[key]}
          class="discover-fb-btn"
          title="Why this?">Why this?</button>
      </div>
      {#if whyOpen[key]}
        <div class="rs-discover-why">
          <p>{item.reason}</p>
          {#if tasteSummary?.favouriteGenres.length}
            <p class="rs-meta">Your top genres: {tasteSummary.favouriteGenres.join(", ")}.</p>
          {:else}
            <p class="rs-meta">No watch history yet — this pick comes from your library's ratings.</p>
          {/if}
        </div>
      {/if}
    </article>
  </div>
{/snippet}

<style>
  .rs-discover {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .rs-discover__rows {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }
  .rs-discover__search {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .rs-discover__input-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .rs-discover-input {
    min-width: 0;
    flex: 1;
    font-size: 1.375rem;
    padding: 0.875rem 1.25rem;
    border-radius: 0.75rem;
    background: var(--rs-bg-2);
    border: 1px solid var(--rs-line);
    color: var(--rs-text);
    outline: none;
  }
  .rs-discover-input::placeholder {
    color: var(--rs-text-2);
  }
  .rs-discover-input:focus-visible {
    border-color: var(--rs-focus);
    box-shadow: 0 0 0 2px var(--rs-focus-glow);
  }
  .rs-discover-clear,
  .rs-discover-chip {
    font-size: 1.25rem;
    padding: 0.625rem 1.25rem;
    border-radius: 9999px;
    border: 1px solid var(--rs-line);
    background: transparent;
    color: var(--rs-text-2);
    cursor: pointer;
    white-space: nowrap;
    outline: none;
  }
  .rs-discover-clear:hover,
  .rs-discover-clear:focus-visible,
  .rs-discover-chip:hover,
  .rs-discover-chip:focus-visible {
    color: var(--rs-text);
    background: var(--rs-surface);
    border-color: var(--rs-focus);
  }
  .rs-discover-chip.is-active {
    color: var(--rs-text);
    background: var(--rs-accent);
    border-color: var(--rs-accent);
  }
  .rs-discover__moods {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    overflow-x: auto;
    padding: 0.25rem;
    scrollbar-width: none;
  }
  .rs-discover__moods::-webkit-scrollbar {
    display: none;
  }
  .rs-discover-toast {
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    padding: 0.875rem 1.25rem;
    font-size: 1.25rem;
    color: var(--rs-text);
    margin: 0;
  }
  /* Rail cells: the shared rail widths apply to direct .rs-card
     children; Discover cells wrap a card + its feedback buttons, so
     the cell itself carries the same widths. */
  .rs-discover-cell {
    flex: 0 0 auto;
    min-width: 0;
  }
  .rs-discover-cell--poster {
    flex-basis: clamp(9rem, 11.5vw, 13rem);
    width: clamp(9rem, 11.5vw, 13rem);
  }
  .rs-discover-cell--channel {
    flex-basis: clamp(15rem, 19vw, 22rem);
    width: clamp(15rem, 19vw, 22rem);
  }
  .rs-discover-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  .rs-discover-card .rs-card {
    width: 100%;
  }
  .rs-discover-rating {
    position: absolute;
    bottom: 0.625rem;
    left: 0.625rem;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: 0.5rem;
    padding: 0.25rem 0.5rem;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  /* The reason reads as a second line under the title, not a clipped
     single-line meta. */
  .rs-discover-reason {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rs-discover-fb {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    padding: 0 0.25rem;
  }
  .discover-fb-btn {
    border: 1px solid var(--rs-line);
    border-radius: 9999px;
    padding: 0.375rem 0.75rem;
    font-size: 1.125rem;
    line-height: 1.2;
    color: var(--rs-text-2);
    background: transparent;
    cursor: pointer;
    outline: none;
    transition: color 120ms, background-color 120ms, border-color 120ms;
  }
  .discover-fb-btn:hover,
  .discover-fb-btn:focus-visible {
    color: var(--rs-text);
    background: var(--rs-surface);
    border-color: var(--rs-focus);
  }
  .discover-fb-btn[aria-pressed="true"] {
    color: var(--rs-focus);
    border-color: var(--rs-accent);
  }
  .rs-discover-why {
    margin: 0 0.25rem;
    border-radius: 0.75rem;
    background: var(--rs-bg-2);
    padding: 0.75rem 1rem;
    font-size: 1.125rem;
    line-height: 1.4;
    color: var(--rs-text-2);
    border: 1px solid var(--rs-line-soft);
  }
  .rs-discover-why p {
    margin: 0;
  }
  .rs-discover-why p + p {
    margin-top: 0.375rem;
  }
</style>
