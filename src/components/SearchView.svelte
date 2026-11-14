<script>
  // Full search experience. Mounted on /search and used as the search surface 
  import { onMount, tick } from "svelte"
  import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js"
  import { normalize } from "@/scripts/lib/text.js"
  import { getCached, hydrate as hydrateCache } from "@/scripts/lib/cache.js"
  import {
    ensureLoaded as ensurePrefsLoaded,
    getRecentSearches,
    pushRecentSearch,
    removeRecentSearch,
    clearRecentSearches,
    EVT_SEARCH_RECENT_CHANGED,
  } from "@/scripts/lib/preferences.js"
  import { warmupActive } from "@/scripts/lib/catalog.js"
  import { readCachedLiveChannels, hasCachedLiveChannels } from "@/scripts/lib/live-catalog.ts"
  import {
    loadProgrammes,
    getProgrammesSync,
    EPG_LOADED_EVENT,
  } from "@/scripts/lib/epg-data.js"
  import { kindLabel } from "@/scripts/lib/kinds.js"
  import { fmtChannelIdentity } from "@/scripts/lib/format.ts"
  import { cachedImg } from "@/scripts/lib/img-cache.ts"
  import { t, LOCALE_EVENT } from "@/scripts/lib/i18n.js"
  import {
    observeSeasonCount,
    seasonsLabel,
  } from "@/scripts/lib/series-seasons.ts"
  import { searchPeople } from "@/scripts/lib/person-search.ts"
  import { resolvePersonTitleIds } from "@/scripts/lib/person-filter.ts"
  import { isTvDevice } from "@/scripts/lib/tv-detect"
  import { debounce } from "@/scripts/lib/debounce.ts"
  import {
    categorizeSearchResults,
    suggestionsFor,
  } from "@/scripts/lib/couch-search.ts"
  import TvKeyboard from "@/components/couch/TvKeyboard.svelte"
  import { CouchKeyboardLifecycle } from "@/scripts/lib/couch-keyboard.ts"
  import {
    openCouchKeyboard,
    closeCouchKeyboard,
    isCouchKeyboardOpen,
    endCouchKeyboardSession,
    nextSearchBackStep,
    COUCH_KEYBOARD_CLOSED_EVENT,
  } from "@/scripts/lib/couch-keyboard.ts"
  import {
    BACK_PRIORITY,
    registerBackLayer,
  } from "@/scripts/lib/back-handler.ts"
  // Names the view for the W1 navigation-ownership contract (§2):
  // kind "search" — the rail model can never hijack Search, and the
  // keyboard layer owns editing while results stay a grid.
  import { setLogicalView } from "@/scripts/lib/couch-focus.ts"
  import {
    recordOriginFromReferrer,
    navigateBackWithOrigin,
  } from "@/scripts/lib/route-origin.ts"

  /** @type {{ focusOnMount?: boolean }} */
  let { focusOnMount = false } = $props()

  // Keyboard lifecycle (W2 Browse consolidation): the on-screen
  // keyboard is hidden on initial load — including the programmatic
  // mount focus below, which is suppressed — and opens when the search
  // input receives focus; see src/scripts/lib/couch-keyboard.ts for
  // the full contract (Escape / Hide-button dismiss, blur hides,
  // commit moves focus to results, trailing-Escape swallow).
  const keyboard = new CouchKeyboardLifecycle({
    suppressInitialFocus: focusOnMount,
  })
  let keyboardOpen = $state(false)
  function syncKeyboard() {
    keyboardOpen = keyboard.open
  }
  function onSearchInputFocus() {
    keyboard.onInputFocus()
    syncKeyboard()
    // Contract E session: the keyboard Back layer and the B-close
    // path need to know this input is being edited. Focus stays in
    // the input (pointer / physical typing); the key grid is reached
    // via ArrowDown or A on the input (W1 gamepad entry).
    if (keyboard.open && inputEl) {
      openCouchKeyboard(inputEl, focusFirstResult, { focusGrid: false })
    }
  }
  function onSearchInputKeyDown(ev) {
    if (ev.key === "Escape") {
      // Dismiss first; focus stays on the search input. Falls through
      // (no-op) when the keyboard is already closed, so the window
      // handler below still owns clear / go-back.
      if (keyboard.dismiss()) {
        endCouchKeyboardSession()
        ev.preventDefault()
        ev.stopPropagation()
        syncKeyboard()
      }
      return
    }
    if (ev.key === "ArrowDown") {
      // Down from the input opens the keyboard and lands on its first
      // key; with it already open, land on the first key directly.
      ev.preventDefault()
      ev.stopPropagation()
      if (!keyboard.open) {
        keyboard.openKeyboard()
        syncKeyboard()
        tick().then(() => {
          const firstKey = document.querySelector(
            "[data-couch-keyboard] [data-osk-key]",
          )
          if (firstKey) firstKey.focus()
        })
      } else {
        const firstKey = document.querySelector("[data-osk] [data-osk-key]")
        if (firstKey) firstKey.focus()
      }
    }
  }
  function onSearchScopeFocusOut(ev) {
    const next = /** @type {HTMLElement | null} */ (ev.relatedTarget)
    const scope = /** @type {HTMLElement} */ (ev.currentTarget)
    // Hide only when focus left the scope entirely. Focus moving
    // between the input and the keyboard keys stays inside the scope
    // (the keys live in it), and focus leaving to nowhere (gamepad B
    // blur) keeps the keyboard so the next D-pad move can reach it.
    const leftScope = !!next && !scope.contains(next)
    keyboard.onScopeFocusOut(leftScope)
    syncKeyboard()
  }
  function dismissSearchKeyboard() {
    // Shared lifecycle first (Back layer + focus return); without a
    // session (defensive), dismiss the lifecycle directly.
    if (isCouchKeyboardOpen()) {
      closeCouchKeyboard(false)
      return
    }
    if (keyboard.dismissToInput()) {
      syncKeyboard()
      inputEl?.focus()
    }
  }

  // Read ?q= from the URL at mount time.
  function readUrlQuery() {
    if (typeof window === "undefined") return ""
    try {
      return new URL(window.location.href).searchParams.get("q") || ""
    } catch {
      return ""
    }
  }
  function readUrlPersonParams() {
    if (typeof window === "undefined") return null
    try {
      const params = new URL(window.location.href).searchParams
      const name = params.get("person")
      if (!name) return null
      const tmdbIdRaw = Number(params.get("personId"))
      return { name, tmdbId: Number.isFinite(tmdbIdRaw) && tmdbIdRaw > 0 ? tmdbIdRaw : null }
    } catch {
      return null
    }
  }
  const initialPersonFromUrl = readUrlPersonParams()
  const initialFromUrl = initialPersonFromUrl ? "" : readUrlQuery()

  /** @type {"all"|"live"|"vod"|"series"|"epg"|"actors"} */
  let kindFilter = $state("all")
  /** @type {Array<"all"|"live"|"vod"|"series"|"actors"|"epg">} */
  const kindOptions = ["all", "live", "vod", "series", "actors", "epg"]
  let query = $state(initialFromUrl)
  let queryDebounced = $state(initialFromUrl)
  // Debounced query sync (shared debounce helper): typing never
  // re-scores or rewrites the URL per keystroke, and a results
  // refresh never moves focus — focus only moves on explicit
  // commit / navigation (see focusFirstResult / goBack).
  const applyDebouncedQuery = debounce((value) => {
    queryDebounced = value
    syncUrl(value)
  }, 150)
  function setQueryDebounced(value) {
    applyDebouncedQuery(value)
  }

  /** @type {{name: string, tmdbId: number|null}|null} */
  let personMode = $state(initialPersonFromUrl)
  /** @type {{vod: Set<number>, series: Set<number>}|null} */
  let personTitleIds = $state(null)
  let personResolveToken = 0
  /** @type {import("@/scripts/lib/person-search.ts").PersonCandidate[]} */
  let actorResults = $state([])
  let _personSearchTimer = null
  let _personSearchToken = 0

  let activeIndex = $state(0)
  /** @type {Array<{text: string, ts: number}>} */
  let recentSearches = $state([])
  /** @type {HTMLElement|null} */
  let recentSectionEl = null

  /** @type {Array<{ kind: "live"|"vod"|"series"|"epg", id: string|number, name: string, logo: string|null, subtitle: string, href: string, norm: string }>} */
  let allItems = $state([])
  let rawVodData = $state([])
  let rawSeriesData = $state([])
  let isWarming = $state(false)
  const showRecentSearches = $derived(!personMode && !isWarming && !query.trim() && recentSearches.length > 0)
  let locale = $state(0)
  let activePlaylistId = $state("")
  let seasonCounts = $state({})
  // Wrappers read the locale rune so {tr(...)} / {kl(...)} template effects
  // track it and re-evaluate on LOCALE_EVENT.
  const tr = (key, params) => (locale, t(key, params))
  const kl = (kind) => (locale, kindLabel(kind))

  function displaySubtitle(item) {
    if (item.kind !== "series") return item.subtitle
    void locale
    const parts = ["Series"]
    if (item.year) parts.push(item.year)
    const count = seasonCounts[item.id]
    if (count) parts.push(seasonsLabel(count))
    if (item.genre) parts.push(item.genre)
    return parts.join(" · ")
  }

  function lazySeasons(node, item) {
    if (!item || item.kind !== "series" || !activePlaylistId) return
    observeSeasonCount(node, activePlaylistId, item.id, (count) => {
      seasonCounts = { ...seasonCounts, [item.id]: count }
    })
  }
  /** @type {HTMLInputElement|null} */
  let inputEl = null

  function buildHref(kind, id) {
    if (kind === "live") return `/livetv?channel=${encodeURIComponent(id)}`
    if (kind === "vod") return `/movies/detail?id=${encodeURIComponent(id)}`
    return `/series/detail?id=${encodeURIComponent(id)}`
  }

  function fmtProgrammeStart(start) {
    const startDate = new Date(start)
    const now = new Date()
    const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dayDiff = Math.round((startDay - today) / 86_400_000)
    const time = startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    if (dayDiff === 0) return `${t("epg.today")} ${time}`
    if (dayDiff === 1) return `${t("common.tomorrow")} ${time}`
    const wk = startDate.toLocaleDateString([], { weekday: "short" })
    return `${wk} ${time}`
  }

  let loadIndexGeneration = 0

  async function loadIndex(opts = {}) {
    const generation = ++loadIndexGeneration
    const [active] = await Promise.all([getActiveEntry(), ensurePrefsLoaded()])
    if (generation !== loadIndexGeneration) return
    if (!active) {
      allItems = []
      activePlaylistId = ""
      seasonCounts = {}
      recentSearches = []
      return
    }
    if (active._id !== activePlaylistId) seasonCounts = {}
    activePlaylistId = active._id
    refreshRecentSearches()

    const buildIndex = async () => {
      const liveData = readCachedLiveChannels(active._id)
      const vodData = getCached(active._id, "vod")?.data || []
      const seriesData = getCached(active._id, "series")?.data || []
      rawVodData = vodData
      rawSeriesData = seriesData

      const cold =
        !liveData.length && !vodData.length && !seriesData.length
      if (cold && opts.warm !== false) {
        isWarming = true
        warmupActive(active._id).then(() => {
          isWarming = false
          if (generation === loadIndexGeneration) loadIndex({ warm: false })
        })
      }

      const items = []
      for (const channel of liveData) {
        items.push({
          kind: "live",
          id: Number(channel.id),
          name: channel.name || "",
          logo: channel.logo || null,
          subtitle: `${fmtChannelIdentity(channel.chno, channel.id)} · ${channel.category || "Live"}`,
          href: buildHref("live", channel.id),
          norm: channel.norm || normalize(`${channel.name || ""} ${channel.category || ""}`),
        })
      }
      for (const movie of vodData) {
        items.push({
          kind: "vod",
          id: Number(movie.id),
          name: movie.name || "",
          logo: movie.logo || null,
          subtitle: movie.year ? `Movie · ${movie.year}` : "Movie",
          href: buildHref("vod", movie.id),
          norm: movie.norm || normalize(`${movie.name || ""} ${movie.category || ""}`),
        })
      }
      for (const series of seriesData) {
        items.push({
          kind: "series",
          id: Number(series.id),
          name: series.name || "",
          logo: series.logo || null,
          year: series.year || "",
          genre: series.category || "",
          subtitle: series.year ? `Series · ${series.year}` : "Series",
          href: buildHref("series", series.id),
          norm: series.norm || normalize(`${series.name || ""} ${series.category || ""}`),
        })
      }

      const epgState = getProgrammesSync(active._id)
      const hasTvgChannels = liveData.some((channel) => channel.tvgId)
      if (hasTvgChannels && !epgState && opts.warmEpg !== false) {
        try {
          const creds = await loadCreds()
          if (generation !== loadIndexGeneration) return
          if (creds?.host) loadProgrammes(active._id, creds).catch(() => {})
        } catch {}
      }
      if (epgState?.programmes?.size) {
        const now = Date.now()
        const HORIZON = now + 36 * 60 * 60 * 1000
        const HARD_CAP = 5000
        let epgCount = 0
        outer: for (const channel of liveData) {
          if (!channel.tvgId) continue
          const programmes = epgState.programmes.get(
            String(channel.tvgId).toLowerCase()
          )
          if (!programmes || !programmes.length) continue
          const channelName = channel.name || ""
          const channelLogo = channel.logo || null
          for (const programme of programmes) {
            if (programme.stop <= now) continue
            if (programme.start > HORIZON) break
            const isLive = programme.start <= now && now < programme.stop
            const when = isLive ? "Live now" : fmtProgrammeStart(programme.start)
            items.push({
              kind: "epg",
              id: `${channel.id}:${programme.start}`,
              name: programme.title || "Untitled",
              logo: channelLogo,
              subtitle: `${channelName} · ${when}`,
              href: buildHref("live", channel.id),
              norm: normalize(`${programme.title || ""} ${channelName}`),
            })
            epgCount++
            if (epgCount >= HARD_CAP) break outer
          }
        }
      }

      allItems = items
    }

    const hydrations = [
      hydrateCache(active._id, "live"),
      hydrateCache(active._id, "m3u"),
      hydrateCache(active._id, "vod"),
      hydrateCache(active._id, "series"),
    ]
    const allCached =
      hasCachedLiveChannels(active._id) &&
      !!getCached(active._id, "vod") &&
      !!getCached(active._id, "series")

    if (allCached) {
      // Build from memory now; hydration below only refreshes stale data.
      await buildIndex()
      void Promise.allSettled(hydrations).then(() => {
        if (generation === loadIndexGeneration) buildIndex()
      })
    } else {
      await Promise.allSettled(hydrations)
      if (generation !== loadIndexGeneration) return
      await buildIndex()
    }
  }

  function syncUrl(queryValue) {
    try {
      const url = new URL(window.location.href)
      if (queryValue) url.searchParams.set("q", queryValue)
      else url.searchParams.delete("q")
      window.history.replaceState({}, "", url.toString())
    } catch {}
  }

  function syncPersonUrl() {
    try {
      const url = new URL(window.location.href)
      if (personMode) {
        url.searchParams.set("person", personMode.name)
        if (personMode.tmdbId) url.searchParams.set("personId", String(personMode.tmdbId))
        else url.searchParams.delete("personId")
        url.searchParams.delete("q")
      } else {
        url.searchParams.delete("person")
        url.searchParams.delete("personId")
      }
      window.history.replaceState({}, "", url.toString())
    } catch {}
  }

  function personInitials(name) {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean)
    if (!parts.length) return "?"
    if (parts.length === 1) return parts[0][0].toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }

  function toCatalogEntries(list) {
    return list.map((entry) => ({ id: entry.id, name: entry.name || "", year: entry.year || null }))
  }

  async function resolvePersonMode() {
    if (!personMode) return
    const runToken = ++personResolveToken
    personTitleIds = null
    const currentPerson = personMode
    const [vodIds, seriesIds] = await Promise.all([
      resolvePersonTitleIds({
        kind: "vod",
        playlistId: activePlaylistId,
        personName: currentPerson.name,
        tmdbPersonId: currentPerson.tmdbId,
        catalogEntries: toCatalogEntries(rawVodData),
      }),
      resolvePersonTitleIds({
        kind: "series",
        playlistId: activePlaylistId,
        personName: currentPerson.name,
        tmdbPersonId: currentPerson.tmdbId,
        catalogEntries: toCatalogEntries(rawSeriesData),
      }),
    ])
    if (runToken !== personResolveToken) return
    personTitleIds = { vod: vodIds, series: seriesIds }
  }

  function enterPersonMode(candidate) {
    if (_personSearchTimer) {
      clearTimeout(_personSearchTimer)
      _personSearchTimer = null
    }
    _personSearchToken++
    actorResults = []
    personMode = { name: candidate.name, tmdbId: candidate.tmdbId }
    personTitleIds = null
    kindFilter = "all"
    query = ""
    queryDebounced = ""
    syncPersonUrl()
    resolvePersonMode()
  }

  function exitPersonMode() {
    if (!personMode) return
    personResolveToken++
    personMode = null
    personTitleIds = null
    syncPersonUrl()
  }

  function scheduleActorSearch(value) {
    if (_personSearchTimer) clearTimeout(_personSearchTimer)
    const trimmed = value.trim()
    if (trimmed.length < 2 || !activePlaylistId) {
      actorResults = []
      return
    }
    _personSearchTimer = setTimeout(async () => {
      const runToken = ++_personSearchToken
      const candidates = await searchPeople(activePlaylistId, trimmed, 5)
      if (runToken !== _personSearchToken) return
      actorResults = candidates
    }, 300)
  }

  function personModeResults() {
    if (!personTitleIds) return []
    const activeKind = kindFilter === "vod" || kindFilter === "series" ? kindFilter : "all"
    const out = []
    for (const item of allItems) {
      if (item.kind === "vod") {
        if (!personTitleIds.vod.has(item.id)) continue
      } else if (item.kind === "series") {
        if (!personTitleIds.series.has(item.id)) continue
      } else {
        continue
      }
      if (activeKind !== "all" && activeKind !== item.kind) continue
      out.push(item)
    }
    return out
  }

  let scoredAll = $derived.by(() => {
    const counts = { all: 0, live: 0, vod: 0, series: 0, epg: 0 }
    const normalizedQuery = normalize(queryDebounced.trim())
    if (!normalizedQuery) return { items: [], counts }
    const tokens = normalizedQuery.split(" ").filter(Boolean)
    if (!tokens.length) return { items: [], counts }
    const items = allItems
    const itemsLen = items.length
    const tokensLen = tokens.length
    const matched = []
    const HARD_CAP = 500
    for (let i = 0; i < itemsLen; i++) {
      const item = items[i]
      const norm = item.norm
      let score = 0
      let allMatch = true
      for (let tokenIndex = 0; tokenIndex < tokensLen; tokenIndex++) {
        const tok = tokens[tokenIndex]
        const matchIndex = norm.indexOf(tok)
        if (matchIndex === -1) {
          allMatch = false
          break
        }
        score += 100 - (matchIndex > 99 ? 99 : matchIndex) + (norm.startsWith(tok) ? 25 : 0)
      }
      if (allMatch) {
        counts.all++
        counts[item.kind]++
        if (matched.length < HARD_CAP) matched.push({ item, score })
      }
    }
    matched.sort((left, right) => right.score - left.score)
    return { items: matched, counts }
  })

  let results = $derived.by(() => {
    if (personMode) return personTitleIds === null ? [] : personModeResults()
    const items = scoredAll.items
    const activeKind = kindFilter
    const out = []
    const MAX = 200
    if ((activeKind === "all" || activeKind === "actors") && actorResults.length && queryDebounced.trim()) {
      for (const candidate of actorResults) {
        out.push({
          kind: "person",
          id: candidate.tmdbId ?? candidate.name,
          name: candidate.name,
          profileUrl: candidate.profileUrl,
          knownFor: candidate.knownFor,
          candidate,
        })
      }
    }
    if (activeKind !== "actors") {
      for (let i = 0; i < items.length && out.length < MAX; i++) {
        const it = items[i].item
        if (activeKind !== "all" && it.kind !== activeKind) continue
        out.push(it)
      }
    }
    return out
  })

  let kindCounts = $derived({ ...scoredAll.counts, actors: actorResults.length })

  // Couch categories for the "all" view: Channels / Films / Series /
  // Programmes / People, in display order. Filtered views keep the
  // flat grid below.
  let groupedResults = $derived(
    kindFilter === "all" ? categorizeSearchResults(results) : null,
  )
  let groupedSections = $derived.by(() => {
    if (!groupedResults) return []
    const sections = [
      {
        id: "channels",
        label: tr("search.results.live"),
        items: groupedResults.channels,
        kindFilter: "live",
      },
      {
        id: "films",
        label: tr("search.results.vod"),
        items: groupedResults.films,
        kindFilter: "vod",
      },
      {
        id: "series",
        label: tr("search.results.series"),
        items: groupedResults.series,
        kindFilter: "series",
      },
      {
        id: "programmes",
        label: tr("search.results.programmes"),
        items: groupedResults.programmes,
        kindFilter: "epg",
      },
      {
        id: "people",
        label: tr("search.actors"),
        items: groupedResults.people,
        kindFilter: "actors",
      },
    ]
    return sections.filter((section) => section.items.length > 0)
  })

  // Suggestion chips while typing: matching recent searches first,
  // then top result names. Pure helper — no invented content.
  let suggestions = $derived(
    personMode
      ? []
      : suggestionsFor(
          query,
          recentSearches.map((recent) => recent.text),
          scoredAll.items.slice(0, 10).map((entry) => entry.item.name),
        ),
  )

  // Back / close: return to the recorded origin screen, or Home when
  // there is none. Origin-aware (Contract B) — never WebView-history
  // based, which returns to whatever the history stack happened to
  // hold. The search-launching control restores focus on the return
  // trip via the existing markSearchReturn/consumeSearchReturn flag
  // (TvSearchAction), which full-page origin navigation preserves.
  function goBack() {
    if (typeof window === "undefined") return
    navigateBackWithOrigin("/")
  }

  /** Focus is on a results / recent / filter control, not the input. */
  function isSearchFocusInResults() {
    const active = /** @type {HTMLElement | null} */ (document.activeElement)
    if (!active || active === inputEl || active === document.body) return false
    const view = document.querySelector('[data-couch-view="search"]')
    return !!view?.contains(active)
  }

  /**
   * One Back step (§27), shared by the window Escape handler and the
   * Back layer (Android BACK): close keyboard -> exit person subview
   * -> focus back to the input -> explicit query-clear step -> leave
   * via provenance. Always performs exactly one step and returns true.
   */
  function searchBackStep() {
    const step = nextSearchBackStep({
      keyboardOpen: keyboard.open,
      personMode: !!personMode,
      focusInResults: isSearchFocusInResults(),
      hasQuery: !!query.trim(),
    })
    if (step === "close-keyboard") {
      if (isCouchKeyboardOpen()) closeCouchKeyboard(false)
      else {
        keyboard.dismissToInput()
        syncKeyboard()
        inputEl?.focus()
      }
      return true
    }
    if (step === "exit-person") {
      exitPersonMode()
      inputEl?.focus()
      return true
    }
    if (step === "focus-input") {
      inputEl?.focus()
      return true
    }
    if (step === "clear-query") {
      clearQuery()
      return true
    }
    goBack()
    return true
  }

  function applySuggestion(text) {
    if (personMode) exitPersonMode()
    query = text
    queryDebounced = text
    syncUrl(text)
    scheduleActorSearch(text)
    inputEl?.focus()
  }

  $effect(() => {
    void results
    if (activeIndex >= results.length) activeIndex = 0
  })

  function refreshRecentSearches() {
    recentSearches = activePlaylistId ? getRecentSearches(activePlaylistId) : []
  }

  // Record a committed query (result activated), never a per-keystroke
  // debounce partial.
  function commitSearch() {
    const trimmedQuery = query.trim()
    if (trimmedQuery) pushRecentSearch(activePlaylistId, trimmedQuery)
  }

  // Clear the query entirely and hand focus back to the input — the
  // escape hatch from a no-results dead end (v0.2.2).
  function clearQuery() {
    query = ""
    queryDebounced = ""
    syncUrl("")
    actorResults = []
    if (_personSearchTimer) {
      clearTimeout(_personSearchTimer)
      _personSearchTimer = null
    }
    inputEl?.focus()
  }

  function selectRecentSearch(text) {
    if (personMode) exitPersonMode()
    query = text
    queryDebounced = text
    syncUrl(text)
    scheduleActorSearch(text)
    inputEl?.focus()
  }

  function removeOneRecentSearch(text) {
    removeRecentSearch(activePlaylistId, text)
  }

  function clearAllRecentSearches() {
    clearRecentSearches(activePlaylistId)
    inputEl?.focus()
  }

  function navigate(item) {
    if (!item) return
    if (item.kind === "person") {
      enterPersonMode(item.candidate)
      return
    }
    commitSearch()
    window.location.href = item.href
  }

  // The on-screen keyboard types into the same query: run the same
  // debounce + actor search the physical input runs.
  function onOskInput(nextValue) {
    setQueryDebounced(nextValue)
    scheduleActorSearch(nextValue)
  }

  // The keyboard's Search key: hide the keyboard and land focus on
  // the first result card so a controller user can keep going with the
  // D-pad, or back to the input when there is nothing to open (the
  // input focus reopens the keyboard — they are still typing).
  function focusFirstResult() {
    endCouchKeyboardSession()
    keyboard.commit()
    syncKeyboard()
    const first = document.querySelector(".couch-search__results .rs-card")
    if (first) {
      first.focus()
      return
    }
    inputEl?.focus()
  }

  function onKey(ev) {
    if (isTvDevice()) return
    // Focus inside the on-screen keyboard belongs to the keyboard: B
    // closes it there (its own handler), arrows are spatial
    // navigation, Enter/Space click the key. The search view must not
    // clear the query or steal the key.
    const targetEl = /** @type {HTMLElement | null} */ (ev.target)
    if (targetEl?.closest?.("[data-osk]")) return
    // Trailing Escape: the gamepad layer blurs the input and then
    // dispatches Escape on the body for a B press. With the keyboard
    // open that trailing Escape CLOSES it (focus returns to the
    // input) — §28: one B press, one step. With the keyboard already
    // closed the Escape falls through to the normal steps below.
    if (
      ev.key === "Escape" &&
      keyboard.open &&
      keyboard.isFreshScopeExit() &&
      (document.activeElement === document.body || !document.activeElement)
    ) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      searchBackStep()
      return
    }
    if (ev.key === "Escape" && keyboard.open) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      searchBackStep()
      return
    }
    const onInput = document.activeElement === inputEl
    if (onInput && personMode && ev.key === "Backspace" && !query) {
      ev.preventDefault()
      exitPersonMode()
    } else if (onInput && ev.key === "ArrowDown") {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      // The on-screen keyboard sits between the input and the results, so
      // down from the input lands on its first key (controller users have
      // no Tab key). With the keyboard closed, open it first and land on
      // its first key once mounted; from the keyboard, down reaches the
      // results through spatial navigation; with no keyboard mounted,
      // keep the old path.
      if (!keyboard.open) {
        keyboard.openKeyboard()
        syncKeyboard()
        tick().then(() => {
          const firstKey = document.querySelector(
            "[data-couch-keyboard] [data-osk-key]",
          )
          if (firstKey) firstKey.focus()
        })
      } else {
        const firstKey = document.querySelector("[data-osk] [data-osk-key]")
        if (firstKey) {
          firstKey.focus()
        } else if (showRecentSearches) {
          recentSectionEl?.querySelector(".recent-search-row")?.focus()
        } else if (results.length) {
          activeIndex = (activeIndex + 1) % results.length
        }
      }
    } else if (onInput && ev.key === "ArrowUp") {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      if (results.length)
        activeIndex = (activeIndex - 1 + results.length) % results.length
    } else if (ev.key === "Enter" && onInput) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      navigate(results[activeIndex])
    } else if (ev.key === "Escape") {
      // One Back step (§27): person -> focus input -> clear query ->
      // leave via provenance. Keyboard-open Escapes were handled
      // above; this branch never runs two steps. stopImmediatePropagation
      // matters: this is a window capture listener, and the Back
      // coordinator's capture listener must not run the same step
      // again for this press (listener order is mount order).
      ev.preventDefault()
      ev.stopImmediatePropagation()
      searchBackStep()
    }
  }

  onMount(() => {
    setLogicalView("search")
    loadIndex().then(() => {
      if (personMode) resolvePersonMode()
    })
    // Origin for Back (Contract B): the screen that launched search.
    recordOriginFromReferrer(window.location.pathname)
    // Back layer (Contract A): Android BACK runs the same single step
    // as Escape on Windows. The keyboard layer (priority 80) wins
    // while the keyboard is open; this page layer (30) runs below it.
    const unregisterSearchBack = registerBackLayer({
      id: "search-page",
      priority: BACK_PRIORITY.PAGE_STATE,
      isActive: () => true,
      handle: () => searchBackStep(),
    })
    // Shared keyboard lifecycle: a close (B in the grid, Back layer)
    // arrives as an event on this input — hide the lifecycle keyboard
    // and return focus to the input. Commit hides without suppressing
    // the reopen (the commit handler moves focus onward).
    function onKeyboardClosed(ev) {
      if (ev.target !== inputEl) return
      if (ev.detail?.commit) keyboard.commit()
      else {
        keyboard.dismissToInput()
        inputEl?.focus()
      }
      syncKeyboard()
    }
    window.addEventListener(COUCH_KEYBOARD_CLOSED_EVENT, onKeyboardClosed)
    function onWarmed() {
      loadIndex({ warm: false })
    }
    function onEpgLoaded() {
      loadIndex({ warm: false, warmEpg: false })
    }
    const onLocale = () => { locale++ }
    const onActiveChanged = () =>
      loadIndex().then(() => {
        if (personMode) resolvePersonMode()
      })
    const onSearchRecentChanged = (ev) => {
      if (ev.detail?.playlistId === activePlaylistId) refreshRecentSearches()
    }
    document.addEventListener("xt:catalog-warmed", onWarmed)
    document.addEventListener(EPG_LOADED_EVENT, onEpgLoaded)
    document.addEventListener("xt:active-changed", onActiveChanged)
    document.addEventListener(LOCALE_EVENT, onLocale)
    document.addEventListener(EVT_SEARCH_RECENT_CHANGED, onSearchRecentChanged)
    window.addEventListener("keydown", onKey, true)
    if (focusOnMount) {
      tick().then(() => {
        inputEl?.focus()
        inputEl?.select?.()
      })
    }
    return () => {
      unregisterSearchBack()
      window.removeEventListener(COUCH_KEYBOARD_CLOSED_EVENT, onKeyboardClosed)
      document.removeEventListener("xt:catalog-warmed", onWarmed)
      document.removeEventListener(EPG_LOADED_EVENT, onEpgLoaded)
      document.removeEventListener("xt:active-changed", onActiveChanged)
      document.removeEventListener(LOCALE_EVENT, onLocale)
      document.removeEventListener(EVT_SEARCH_RECENT_CHANGED, onSearchRecentChanged)
      window.removeEventListener("keydown", onKey, true)
      if (_personSearchTimer) clearTimeout(_personSearchTimer)
    }
  })
</script>

<section class="couch-search" data-couch-view="search">
  <div class="couch-search__head">
    <button
      type="button"
      onclick={goBack}
      data-nylah-item
      class="couch-search__back"
      aria-label={tr("common.back")}>
      ← {tr("common.back")}
    </button>
    <h1 class="rs-page-title">{tr("page.search.heading")}</h1>
    <p class="rs-meta">{tr("page.search.subPrefix")}<kbd class="couch-search__kbd">{tr("search.shortcut")}</kbd>{tr("page.search.subSuffix")}</p>
  </div>

  <div class="couch-search__controls" onfocusout={onSearchScopeFocusOut}>
    <div data-focus-glide="off" class="couch-search__input-wrap">
      <svg xmlns="http://www.w3.org/2000/svg" width="1.5rem" height="1.5rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="couch-search__icon">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
      </svg>
      {#if personMode}
        <span class="person-chip">
          <span class="truncate">{personMode.name}</span>
          <button
            type="button"
            onclick={exitPersonMode}
            aria-label={tr("search.personChipRemove", { name: personMode.name })}
            class="person-chip-remove">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1rem" height="1rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </span>
      {/if}
      <input
        bind:this={inputEl}
        value={personMode ? "" : query}
        onfocus={onSearchInputFocus}
        onclick={onSearchInputFocus}
        onkeydown={onSearchInputKeyDown}
        oninput={(ev) => {
          const value = ev.currentTarget.value
          if (personMode) exitPersonMode()
          query = value
          setQueryDebounced(value)
          scheduleActorSearch(value)
        }}
        type="search"
        placeholder={tr("search.placeholderFull")}
        aria-label={tr("common.search")}
        autocomplete="off"
        spellcheck="false"
        class="couch-search__input" />
      {#if query && !personMode}
        <button
          type="button"
          onclick={() => {
            query = ""
            queryDebounced = ""
            syncUrl("")
            actorResults = []
            if (_personSearchTimer) {
              clearTimeout(_personSearchTimer)
              _personSearchTimer = null
            }
            inputEl?.focus()
          }}
          aria-label={tr("search.clear")}
          class="search-clear">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.25rem" height="1.25rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      {/if}
    </div>

    <!-- Result categories: Films / Series / Channels (+ Programmes, People). -->
    <div class="couch-search__filters" role="group" aria-label={tr("common.search")}>
      {#each kindOptions as kindOption}
        <button
          type="button"
          data-nylah-item
          onclick={() => (kindFilter = kindOption)}
          aria-pressed={kindFilter === kindOption}
          class="filter-chip"
          class:is-active={kindFilter === kindOption}>
          {kindOption === "all"
            ? tr("common.all")
            : kindOption === "vod"
            ? tr("search.results.vod")
            : kindOption === "live"
            ? tr("search.results.live")
            : kindOption === "epg"
            ? tr("search.results.programmes")
            : kindOption === "actors"
            ? tr("search.actors")
            : tr("search.results.series")}
          {#if queryDebounced.trim()}
            <span class="filter-chip__count">{kindCounts[kindOption]}</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if suggestions.length}
      <div class="couch-search__suggestions" aria-label={tr("search.suggestions")}>
        <span class="couch-search__suggestions-label">{tr("search.suggestions")}</span>
        {#each suggestions as suggestion (suggestion)}
          <button
            type="button"
            data-nylah-item
            onclick={() => applySuggestion(suggestion)}
            class="suggestion-chip">
            {suggestion}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Controller path to typing: QWERTY grid, A types, B closes, ⌫ deletes.
         Hidden until the search input is focused; hides on dismiss / blur / commit. -->
    <TvKeyboard
      bind:value={query}
      open={keyboardOpen}
      onInput={onOskInput}
      onCommit={focusFirstResult}
      onDismiss={dismissSearchKeyboard} />
  </div>

  {#snippet resultCard(result, idx)}
    {#if result.kind === "person"}
      <button
        type="button"
        data-nylah-item
        data-couch-key={"person:" + result.id}
        onmouseenter={() => (activeIndex = idx)}
        onfocus={() => (activeIndex = idx)}
        onclick={() => enterPersonMode(result.candidate)}
        class="rs-card rs-card--poster result-row">
        <span class="rs-card__media couch-search__media couch-search__media--poster">
          <span class="couch-search__person">
            {#if result.profileUrl}
              <img
                use:cachedImg={{ url: result.profileUrl, kind: "poster" }}
                alt=""
                loading="lazy" fetchpriority="low"
                decoding="async"
                referrerpolicy="no-referrer"
                width="80" height="80"
                class="couch-search__person-img" />
            {:else}
              {personInitials(result.name)}
            {/if}
          </span>
          <span class="rs-card__badge">{tr("search.actorGeneric")}</span>
        </span>
        <span class="rs-card__body">
          <span class="rs-card__title">{result.name}</span>
          <span class="rs-card__subtitle">{result.knownFor || tr("search.actorGeneric")}</span>
        </span>
      </button>
    {:else}
      <a
        href={result.href}
        use:lazySeasons={result}
        data-nylah-item
        data-couch-key={result.kind + ":" + result.id}
        onmouseenter={() => (activeIndex = idx)}
        onfocus={() => (activeIndex = idx)}
        onclick={commitSearch}
        class="rs-card result-row"
        class:rs-card--poster={result.kind !== "live" && result.kind !== "epg"}
        class:rs-card--channel={result.kind === "live"}
        class:rs-card--landscape={result.kind === "epg"}>
        <span
          class="rs-card__media couch-search__media"
          class:couch-search__media--poster={result.kind !== "live" && result.kind !== "epg"}
          class:couch-search__media--wide={result.kind === "live" || result.kind === "epg"}>
          {#if result.logo}
            <img
              use:cachedImg={{ url: result.logo, kind: result.kind === "live" ? "logo" : "poster" }}
              alt=""
              loading="lazy" fetchpriority="low"
              decoding="async"
              referrerpolicy="no-referrer"
              width="200" height="300"
              class="couch-search__media-img"
              class:couch-search__media-img--contain={result.kind === "live"} />
          {:else}
            <span class="couch-search__media-fallback">{kl(result.kind)[0]}</span>
          {/if}
          <span class="rs-card__badge">{kl(result.kind)}</span>
        </span>
        <span class="rs-card__body">
          <span class="rs-card__title">{result.name}</span>
          <span class="rs-card__subtitle">{displaySubtitle(result)}</span>
        </span>
      </a>
    {/if}
  {/snippet}

  {#snippet warming(hint)}
    <div class="couch-search__warming">
      <svg viewBox="0 0 24 24" width="1.5rem" height="1.5rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" class="couch-search__spin">
        <path d="M21 12a9 9 0 1 1-6.2-8.55"/>
      </svg>
      <span>{tr("search.loadingCatalog")}</span>
    </div>
    <div class="rs-meta">{hint}</div>
  {/snippet}

  <div class="couch-search__results">
    {#if !personMode && !queryDebounced.trim()}
      {#if showRecentSearches}
        <div bind:this={recentSectionEl} class="couch-search__recent">
          <div class="couch-search__recent-head">
            <span class="rs-section-title">{tr("search.recentHeading")}</span>
            <button
              type="button"
              data-nylah-item
              onclick={clearAllRecentSearches}
              class="couch-search__recent-clear">
              {tr("search.recentClear")}
            </button>
          </div>
          <ul class="couch-search__recent-list">
            {#each recentSearches as recent (recent.text)}
              <li class="couch-search__recent-row">
                <button
                  type="button"
                  data-nylah-item
                  onclick={() => selectRecentSearch(recent.text)}
                  class="recent-search-row">
                  <svg xmlns="http://www.w3.org/2000/svg" width="1.25rem" height="1.25rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="couch-search__recent-icon">
                    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
                  </svg>
                  <span class="truncate">{recent.text}</span>
                </button>
                <button
                  type="button"
                  data-nylah-item
                  onclick={() => removeOneRecentSearch(recent.text)}
                  aria-label={tr("search.recentRemove", { query: recent.text })}
                  class="couch-search__recent-remove">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.25rem" height="1.25rem" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      <div class="rs-empty couch-search__landing">
        {#if isWarming}
          {@render warming(tr("search.warmingHint"))}
        {:else}
          <h2 class="rs-empty__title">{tr("search.helpHeading")}</h2>
          <p class="rs-empty__message">{tr("search.helpKbd")}</p>
          <p class="rs-empty__message">{tr("search.keyboardHint")}</p>
        {/if}
      </div>
    {:else if personMode && personTitleIds === null}
      <ul class="couch-search__person-loading" aria-hidden="true">
        {#each Array.from({ length: 6 }) as _, i (i)}
          <li class="couch-search__person-loading-row">
            <span class="rs-skeleton rs-skeleton--poster couch-search__person-loading-thumb"></span>
            <span class="couch-search__person-loading-lines">
              <span class="rs-skeleton rs-skeleton--line"></span>
              <span class="rs-skeleton rs-skeleton--line couch-search__person-loading-line--short"></span>
            </span>
          </li>
        {/each}
      </ul>
    {:else if !results.length}
      <div class="rs-empty couch-search__empty">
        {#if personMode}
          <h2 class="rs-empty__title">{tr("search.noResultsForPerson", { name: personMode.name })}</h2>
        {:else if isWarming}
          {@render warming(tr("search.warmingResultsHint"))}
        {:else}
          <h2 class="rs-empty__title">{tr("search.noResults", { query: queryDebounced.trim() })}</h2>
          <div class="couch-search__empty-actions">
            {#if kindFilter !== "all" && kindCounts.all > 0}
              <button
                type="button"
                data-nylah-item
                onclick={() => (kindFilter = "all")}
                class="couch-search__action">
                {tr("search.showAllKinds", { n: kindCounts.all })}
              </button>
            {/if}
            <button
              type="button"
              data-nylah-item
              onclick={clearQuery}
              class="couch-search__action couch-search__action--secondary">
              {tr("search.clear")}
            </button>
          </div>
        {/if}
      </div>
    {:else if groupedSections.length}
      {#each groupedSections as section (section.id)}
        <section class="rs-rail" data-nylah-rail={"search-" + section.id} aria-label={section.label}>
          <div class="rs-rail__head">
            <h2 class="rs-section-title">{section.label} <span class="couch-search__rail-count">({section.items.length})</span></h2>
            {#if section.items.length > 8}
              <button
                type="button"
                data-nylah-item
                onclick={() => (kindFilter = section.kindFilter)}
                class="rs-rail__more">
                {tr("search.showAllKinds", { n: section.items.length })} ›
              </button>
            {/if}
          </div>
          <div class="rs-rail__row">
            {#each section.items.slice(0, 8) as result (result.kind + ":" + result.id)}
              {@render resultCard(result, results.indexOf(result))}
            {/each}
          </div>
        </section>
      {/each}
      {#if scoredAll.items.length >= 500}
        <p class="couch-search__cap">
          {tr("search.showingTop", { n: results.length })}
        </p>
      {/if}
    {:else}
      <div class="rs-grid" data-couch-grid role="group" aria-label={tr("common.search")}>
        {#each results as result, idx (result.kind + ":" + result.id)}
          {@render resultCard(result, idx)}
        {/each}
      </div>
      {#if scoredAll.items.length >= 500}
        <p class="couch-search__cap">
          {tr("search.showingTop", { n: results.length })}
        </p>
      {/if}
    {/if}
  </div>
</section>

<style>
  /* Couch search — RedSilk tokens only (couch.css owns .rs-*; this
     file only lays out this screen's own chrome around them). */
  .couch-search {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    flex: 1;
    min-height: 0;
  }
  .couch-search__head {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .couch-search__back {
    align-self: flex-start;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--rs-text-2);
    background: var(--rs-surface);
    border: 1px solid var(--rs-line);
    border-radius: 0.75rem;
    padding: 0.625rem 1.25rem;
    cursor: pointer;
  }
  .couch-search__back:hover {
    color: var(--rs-text);
    background: var(--rs-bg-2);
  }
  .couch-search__kbd {
    font-size: 1.125rem;
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--rs-line);
    border-radius: 0.375rem;
    background: var(--rs-surface);
    color: var(--rs-text);
    font-family: inherit;
  }
  .couch-search__controls {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    flex-shrink: 0;
  }
  .couch-search__input-wrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    border-radius: 1rem;
    border: 1px solid var(--rs-line);
    background: linear-gradient(180deg, var(--rs-surface), var(--rs-bg-2));
    box-shadow: var(--rs-shadow);
  }
  .couch-search__input-wrap:focus-within {
    border-color: var(--rs-focus);
    box-shadow:
      0 0 0 3px var(--rs-focus),
      0 0 2rem 0.25rem var(--rs-focus-glow);
  }
  .couch-search__input-wrap input:focus-visible {
    outline: none;
  }
  .couch-search__icon {
    color: var(--rs-text-2);
    flex-shrink: 0;
  }
  .couch-search__input {
    flex: 1;
    min-width: 0;
    background: transparent;
    color: var(--rs-text);
    border: 0;
    outline: none;
    padding: 0.5rem 0;
    font-size: 1.5rem;
  }
  .couch-search__input::placeholder {
    color: var(--rs-text-2);
  }
  .person-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 3rem;
    padding-left: 1rem;
    padding-right: 0.25rem;
    border-radius: 0.75rem;
    background: var(--rs-accent);
    color: var(--rs-text);
    font-size: 1.25rem;
    max-width: 55%;
    flex-shrink: 0;
  }
  .person-chip-remove {
    width: 2.5rem;
    height: 2.5rem;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    color: var(--rs-text);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .search-clear {
    width: 3rem;
    height: 3rem;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.75rem;
    color: var(--rs-text-2);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .search-clear:hover {
    color: var(--rs-text);
    background: var(--rs-surface);
  }
  .couch-search__filters {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    overflow-x: auto;
    padding: 0.25rem;
    scrollbar-width: none;
  }
  .couch-search__filters::-webkit-scrollbar {
    display: none;
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
  .couch-search__suggestions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .couch-search__suggestions-label {
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--rs-text-2);
  }
  .suggestion-chip {
    font-size: 1.25rem;
    min-height: 3rem;
    padding: 0.5rem 1.25rem;
    border-radius: 999px;
    border: 1px solid var(--rs-line);
    background: var(--rs-bg-2);
    color: var(--rs-text);
    cursor: pointer;
  }
  .suggestion-chip:hover {
    border-color: var(--rs-focus);
  }
  .couch-search__results {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
    padding-bottom: 2rem;
  }
  .couch-search__warming {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    font-size: 1.375rem;
  }
  .couch-search__spin {
    animation: couch-spin 1s linear infinite;
  }
  @keyframes couch-spin {
    to { transform: rotate(360deg); }
  }
  .couch-search__recent {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .couch-search__recent-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0 0.25rem;
  }
  .couch-search__recent-clear {
    font-size: 1.125rem;
    color: var(--rs-text-2);
    background: transparent;
    border: 0;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    min-height: 2.75rem;
    padding: 0 0.5rem;
  }
  .couch-search__recent-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .couch-search__recent-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .recent-search-row {
    flex: 1;
    min-width: 0;
    min-height: 3.5rem;
    border-radius: 0.75rem;
    padding: 0 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    text-align: left;
    font-size: 1.25rem;
    color: var(--rs-text-2);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .recent-search-row:hover {
    background: var(--rs-surface);
    color: var(--rs-text);
  }
  .couch-search__recent-icon {
    color: var(--rs-text-2);
    flex-shrink: 0;
  }
  .couch-search__recent-remove {
    width: 3rem;
    height: 3rem;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.75rem;
    color: var(--rs-text-2);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .couch-search__recent-remove:hover {
    color: var(--rs-text);
    background: var(--rs-surface);
  }
  .couch-search__landing,
  .couch-search__empty {
    max-width: 44rem;
    margin: 0 auto;
    width: 100%;
  }
  .couch-search__empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: center;
    margin-top: 0.5rem;
  }
  .couch-search__action {
    font-size: 1.375rem;
    font-weight: 600;
    min-height: 3.5rem;
    padding: 0.75rem 1.75rem;
    border-radius: 0.75rem;
    background: var(--rs-accent);
    color: var(--rs-text);
    border: 0;
    cursor: pointer;
  }
  .couch-search__action--secondary {
    background: var(--rs-surface);
    border: 1px solid var(--rs-line);
  }
  .couch-search__rail-count {
    color: var(--rs-text-2);
    font-size: 1.5rem;
  }
  .couch-search__cap {
    text-align: center;
    font-size: 1.125rem;
    font-style: italic;
    color: var(--rs-text-2);
    padding: 0.75rem;
  }
  /* Result media: TvCard's aspect comes from TvImage in Astro; in
     Svelte the media span carries it instead. */
  .couch-search__media {
    display: block;
    overflow: hidden;
    background: var(--rs-bg-2);
  }
  .couch-search__media--poster {
    aspect-ratio: 2 / 3;
  }
  .couch-search__media--wide {
    aspect-ratio: 16 / 9;
  }
  .couch-search__media-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .couch-search__media-img--contain {
    object-fit: contain;
    padding: 1rem;
    background: var(--rs-surface);
  }
  .couch-search__media-fallback {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    font-family: var(--rs-font-display);
    font-size: 3rem;
    color: var(--rs-text-2);
  }
  .couch-search__person {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
  }
  .couch-search__person-img {
    width: 6rem;
    height: 6rem;
    border-radius: 999px;
    object-fit: cover;
  }
  .couch-search__person-loading {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .couch-search__person-loading-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0 0.5rem;
  }
  .couch-search__person-loading-thumb {
    width: 4rem;
    height: 4rem;
    border-radius: 999px;
    flex-shrink: 0;
  }
  .couch-search__person-loading-lines {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .couch-search__person-loading-line--short {
    width: 40%;
  }
  .result-row {
    animation: result-enter 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes result-enter {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .result-row { animation: none; }
    .couch-search__spin { animation: none; }
  }
</style>
