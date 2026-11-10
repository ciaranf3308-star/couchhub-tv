<!-- RedSilk Discover (W1, Discover CORE). Mounted on /discover.
     Local-only: the catalogue is loaded once at mount, search and ranking
     run in the page, and no network request happens during ordinary
     controller navigation. The AI ranker is only consulted (via rankWithAI)
     for natural-language questions when W2's module registered one — with
     no ranker, local ranking runs. -->
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
  } from "@/scripts/lib/discover.ts"
  import { saveTaste, summarizeTaste } from "@/scripts/lib/taste.ts"
  import { cachedImg } from "@/scripts/lib/img-cache.ts"
  import { fmtImdbRating } from "@/scripts/lib/format.ts"
  import OnScreenKeyboard from "@/components/OnScreenKeyboard.svelte"

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
</script>

<div class="flex flex-col gap-4" data-discover-root>
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <label for="discover-query" class="sr-only">What are you in the mood for?</label>
      <input
        id="discover-query"
        type="search"
        bind:value={query}
        oninput={(e) => onQueryInput(e.currentTarget.value)}
        placeholder="What are you in the mood for?"
        autocomplete="off"
        class="discover-search-input min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-base text-fg placeholder:text-fg-3 outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      {#if query || activeMood || moreLikeSeed}
        <button
          type="button"
          onclick={clearSearch}
          class="btn shrink-0">Clear</button>
      {/if}
    </div>

    <!-- Controller path to typing: QWERTY grid, A types, B deletes, X clears. -->
    <OnScreenKeyboard
      bind:value={query}
      onInput={onOskInput}
      onCommit={focusFirstResult} />

    <div class="flex items-center gap-2 overflow-x-auto custom-scroll -mx-1 px-1 pb-1" role="group" aria-label="Quick picks">
      {#each MOOD_PRESETS as preset (preset.id)}
        <button
          type="button"
          onclick={() => pickMood(preset.id)}
          aria-pressed={activeMood === preset.id}
          class="filter-chip rounded-full px-4 py-2 text-sm whitespace-nowrap transition-colors outline-none border"
          class:bg-accent-soft={activeMood === preset.id}
          class:text-accent={activeMood === preset.id}
          class:border-accent={activeMood === preset.id}
          class:text-fg-2={activeMood !== preset.id}
          class:border-line={activeMood !== preset.id}
          class:hover:bg-surface-2={activeMood !== preset.id}>
          {preset.label}
        </button>
      {/each}
    </div>
  </div>

  {#if toast}
    <p role="status" class="rounded-xl border border-line bg-surface-2 px-4 py-2 text-sm text-fg">{toast}</p>
  {/if}

  {#if loading}
    <p class="text-sm text-fg-3 py-8 text-center">Loading your library…</p>
  {:else if noPlaylist}
    <div class="nylah-card rounded-2xl bg-surface p-6 text-center">
      <p class="font-serif text-xl">Nothing to discover yet</p>
      <p class="text-sm text-fg-3 mt-2">Add a playlist in Settings and Discover will learn from what you watch.</p>
      <a href="/settings" class="btn btn-primary mt-4 inline-block">Go to Settings</a>
    </div>
  {:else if loadFailed}
    <div class="nylah-card rounded-2xl bg-surface p-6 text-center">
      <p class="font-serif text-xl">Discover couldn't load</p>
      <p class="text-sm text-fg-3 mt-2">Your library may still be warming up — try again in a moment.</p>
      <button type="button" class="btn btn-primary mt-4" onclick={() => location.reload()}>Try again</button>
    </div>
  {:else if showingSearch}
    <section data-discover-results aria-label="Discover results">
      <header class="nylah-rail__head">
        <h2 class="nylah-rail__title font-serif">
          {#if moreLikeSeed}
            More like {moreLikeSeed.title}
          {:else if activeMood}
            {MOOD_PRESETS.find((p) => p.id === activeMood)?.label}
          {:else}
            Results for “{queryDebounced.trim()}”
          {/if}
        </h2>
        {#if searching}
          <p class="text-sm text-fg-3">Searching your library…</p>
        {/if}
      </header>
      {#if searchResults && searchResults.length}
        <ul class="nylah-rail__row flex gap-3 overflow-x-auto pb-2 snap-x custom-scroll">
          {#each searchResults as item (candidateKey(item.candidate))}
            {@render discoverCard(item)}
          {/each}
        </ul>
      {:else if !searching}
        <p class="text-sm text-fg-3 py-6">Nothing matched — try a different word or a quick pick above. Discover only searches titles already in your library.</p>
      {/if}
    </section>
  {:else}
    <div data-discover-rows class="flex flex-col gap-6">
      {#each rows as row (row.id)}
        {#if row.items.length}
          <section data-nylah-rail={row.id} class="nylah-rail" aria-label={row.title}>
            <header class="nylah-rail__head">
              <h2 class="nylah-rail__title font-serif">{row.title}</h2>
              {#if row.subtitle}<p class="text-sm text-fg-3">{row.subtitle}</p>{/if}
            </header>
            <ul class="nylah-rail__row flex gap-3 overflow-x-auto pb-2 snap-x custom-scroll">
              {#each row.items as item (candidateKey(item.candidate))}
                {@render discoverCard(item)}
              {/each}
            </ul>
          </section>
        {/if}
      {/each}
      {#if !rows.some((r) => r.items.length)}
        <p class="text-sm text-fg-3 py-6 text-center">Your library looks empty — once titles are in, Discover will have picks for you here.</p>
      {/if}
    </div>
  {/if}
</div>

{#snippet discoverCard(item)}
  {@const c = item.candidate}
  {@const key = candidateKey(c)}
  {@const isFav = data?.taste.favouriteTitles.some((f) => `${f.kind}:${f.id}` === key)}
  <li class="shrink-0 snap-start w-36 sm:w-44 lg:w-52">
    <article class="nylah-card discover-card group relative rounded-xl overflow-hidden bg-surface-2 ring-1 ring-line transition-[transform,box-shadow] duration-150 hover:ring-[3px] hover:ring-accent focus-within:ring-[3px] focus-within:ring-accent">
      <a
        href={candidateDetailHref(c)}
        data-nylah-item
        aria-label={`${c.title}${c.year ? ` (${c.year})` : ""}${c.kind === "live" ? ", live TV" : ""}`}
        class="block outline-none">
        <div class="w-full aspect-2-3 overflow-hidden bg-surface-2 relative">
          {#if c.posterUrl}
            <img
              use:cachedImg={{ url: c.posterUrl, kind: c.kind === "live" ? "logo" : "poster" }}
              src={c.posterUrl}
              alt=""
              loading="lazy"
              fetchpriority="low"
              decoding="async"
              referrerpolicy="no-referrer"
              width="200"
              height="300"
              class="h-full w-full object-cover" />
          {:else}
            <div class="h-full w-full flex flex-col items-center justify-center gap-2 px-3 text-fg-3 bg-linear-to-br from-surface-2 to-surface-3">
              <span class="font-serif text-base text-center">{c.title}</span>
            </div>
          {/if}
          {#if c.rating}
            <span class="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 bg-black/55 backdrop-blur-sm ring-1 ring-white/10 text-white/90 text-2xs font-semibold tabular-nums" aria-label={`Rating ${fmtImdbRating(c.rating)} out of 10`}>
              <span aria-hidden="true">★</span><span>{fmtImdbRating(c.rating)}</span>
            </span>
          {/if}
          {#if c.kind === "live"}
            <span class="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 bg-accent text-bg text-2xs font-semibold">● LIVE</span>
          {/if}
        </div>
        <div class="px-2 py-2 min-w-0">
          <div class="truncate text-sm font-medium text-fg">{c.title}</div>
          <div class="text-2xs text-fg-3 tabular-nums">
            {#if c.year}{c.year} · {/if}{c.kind === "series" ? "Series" : c.kind === "live" ? "Live TV" : "Film"}
          </div>
          <p class="text-2xs text-fg-2 mt-1 line-clamp-2 min-h-8">{item.reason}</p>
        </div>
      </a>
      <div class="flex flex-wrap gap-1 px-2 pb-2">
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
        <div class="mx-2 mb-2 rounded-lg bg-surface px-2.5 py-2 text-2xs text-fg-2 ring-1 ring-line">
          <p>{item.reason}</p>
          {#if tasteSummary?.favouriteGenres.length}
            <p class="mt-1 text-fg-3">Your top genres: {tasteSummary.favouriteGenres.join(", ")}.</p>
          {:else}
            <p class="mt-1 text-fg-3">No watch history yet — this pick comes from your library's ratings.</p>
          {/if}
        </div>
      {/if}
    </article>
  </li>
{/snippet}

<style>
  .discover-search-input {
    font-size: 1.0625rem;
  }
  @media (min-width: 1024px) {
    .discover-search-input {
      font-size: 1.125rem;
    }
  }
  .discover-fb-btn {
    border: 1px solid var(--color-line, rgb(255 255 255 / 0.12));
    border-radius: 9999px;
    padding: 0.3rem 0.6rem;
    font-size: 0.6875rem;
    line-height: 1;
    color: var(--color-fg-2);
    background: transparent;
    cursor: pointer;
    outline: none;
    transition: color 120ms, background-color 120ms, border-color 120ms;
  }
  .discover-fb-btn:hover,
  .discover-fb-btn:focus-visible {
    color: var(--color-fg);
    background: var(--color-surface-2);
    border-color: var(--color-accent);
  }
  .discover-fb-btn[aria-pressed="true"] {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  /* Strong wine focus glow on the card anchor, matching the v0.3.0
     RedSilk treatment: the focused card must read from the couch. */
  .discover-card a:focus-visible {
    outline: none;
  }
  .discover-card:has(a:focus-visible) {
    box-shadow: 0 0 0 2px var(--nylah-focus-ring, oklch(0.72 0.17 350)),
      0 0 24px 2px var(--nylah-focus-glow, oklch(0.72 0.17 350 / 0.5));
  }
</style>
