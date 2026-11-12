<!-- RedSilk Discover (0.10.0) — the dedicated Discover destination.
     A defining feature, not a lost input: a prominent natural-language
     search with example prompts, six quick-pick cards, personalised
     rails, and an always-visible mode badge that says honestly whether
     the picks came from AI or from the local engine.
     - AI requests happen ONLY on an explicit submit / "Ask AI" tap
       (AI07). Typing, focus and scrolling never send anything.
     - First run with no AI configured shows the "Unlock AI Discovery"
       panel once; "Not Now" dismisses it for good (AI01). Browsing is
       never blocked by it.
     - No feedback buttons under posters here (B01): feedback lives on
       the detail screen. Cards show the reason line only.
     - Discover is separate from Live TV: no "On TV Right Now" row.
     - Honesty (0.11.5): every search writes a per-search receipt
       (ai/status.ts) — the rail title, the state note and the
       diagnostics panel are derived from it, and only from it. "AI
       answered just now" is true only for a validated live answer;
       a cache hit is labelled cached, a local result local, and a
       local rail says why it is local (or why Ask AI is unavailable).
     Logic: the catalogue loads once at mount, search and ranking run
     in the page. The AI ranker is registered at mount and only
     consulted (via rankDiscover) for natural-language questions — with
     no ranker, or on any AI failure, local ranking runs and says so. -->
<script>
  import { onMount, tick } from "svelte"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import { warmupActive } from "@/scripts/lib/catalog.js"
  import { getActiveProfileId, SHARED_PROFILE_ID } from "@/scripts/lib/profiles.ts"
  import {
    loadDiscoverData,
    getDiscoverRows,
    searchDiscover,
    rankDiscover,
    candidateDetailHref,
    candidateKey,
    MOOD_PRESETS,
    EXAMPLE_PROMPTS,
    registerAIRanker,
    registerFollowedProvider,
    isNaturalLanguageQuery,
    detectMoodPresets,
  } from "@/scripts/lib/discover.ts"
  import { aiRanker, subscribeAiActivity } from "@/scripts/lib/ai/ranking.ts"
  import { initAI } from "@/scripts/lib/ai/init.ts"
  import {
    getAiStatus,
    getAiAutoRequests,
    hasDismissedAiOnboarding,
    dismissAiOnboarding,
    AI_MODE_LABELS,
    AI_SEARCH_PHASE_LABELS,
    aiSearchRailTitle,
    aiSearchStateNote,
  } from "@/scripts/lib/ai/status.ts"
  import { getAiModel } from "@/scripts/lib/app-settings.js"
  import { ensureFollowedLoaded, followedProvider } from "@/scripts/lib/followed.ts"
  import { fmtImdbRating } from "@/scripts/lib/format.ts"
  import TvKeyboard from "@/components/couch/TvKeyboard.svelte"
  import { CouchKeyboardLifecycle } from "@/scripts/lib/couch-keyboard.ts"
  import { restoreCouchFocus } from "@/scripts/lib/couch-focus.ts"
  import {
    armTvImageFallbacks,
    fallbackMarkFor,
  } from "@/scripts/lib/couch-image.ts"

  // Keyboard lifecycle: the on-screen keyboard is hidden on landing
  // and opens when the search input receives focus; see
  // src/scripts/lib/couch-keyboard.ts for the full contract
  // (Escape / Hide-button dismiss, blur-to-a-real-element hides,
  // commit moves focus to results).
  /** @type {HTMLInputElement | null} */
  let inputEl = null
  const keyboard = new CouchKeyboardLifecycle()
  let keyboardOpen = $state(false)
  function syncKeyboard() {
    keyboardOpen = keyboard.open
  }
  function onSearchInputFocus() {
    keyboard.onInputFocus()
    syncKeyboard()
  }
  function onSearchInputKeyDown(ev) {
    if (ev.key === "Escape") {
      if (keyboard.dismiss()) {
        ev.preventDefault()
        ev.stopPropagation()
        syncKeyboard()
      }
      return
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault()
      ev.stopPropagation()
      keyboard.openKeyboard()
      syncKeyboard()
      requestAnimationFrame(() => {
        document
          .querySelector("[data-couch-keyboard] [data-osk-key]")
          ?.focus()
      })
    }
  }
  function onKeyboardScopeFocusOut(ev) {
    const next = /** @type {HTMLElement | null} */ (ev.relatedTarget)
    const scope = /** @type {HTMLElement} */ (ev.currentTarget)
    const leftScope = !!next && !scope.contains(next)
    keyboard.onScopeFocusOut(leftScope)
    syncKeyboard()
  }
  function dismissKeyboardToInput() {
    if (keyboard.dismissToInput()) {
      syncKeyboard()
      inputEl?.focus()
    }
  }
  function onKeyboardCommit() {
    keyboard.commit()
    syncKeyboard()
    focusFirstResult()
  }

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
  let searchingAi = $state(false)
  /** @type {"ai" | "local" | null} */
  let resultsSource = $state(null)
  let fallbackNotice = $state("")
  /** Per-search engine receipt (0.11.5): the ONLY source for the rail
      title and the "AI answered" note — see ai/status.ts. A rail is
      labelled by the engine that actually produced it, and "AI answered
      just now" is only ever true for a validated receipt (see
      isFreshAiAnswer). Replaced on every completed search; kept across
      the in-flight await so the title never claims AI early. */
  let receipt = $state(
    /** @type {import("@/scripts/lib/ai/status.ts").AiSearchReceipt | null} */ (null)
  )
  let diagnosticsOpen = $state(false)
  /** @type {string} */
  let aiModel = $state("")
  /** @type {boolean} */
  let canAskAi = $state(false)
  /** @type {boolean} */
  let aiKeySaved = $state(false)
  /** Clock tick so a "just now" note ages out without a new search. */
  let nowTick = $state(0)
  /** Activity probe for the in-flight AI call. The ranker emits
      "start" only when a request really leaves the device, and "done"
      only after a reply parses + validates — so a source-"ai" result
      with no "start" is a cache hit, not a fresh answer. Read
      synchronously after the awaited rankDiscover call; reset before
      each AI attempt. */
  const activityProbe = { started: false, done: false, error: false }
  /** @type {string | null} */
  let activeMood = $state(null)
  /** @type {import("@/scripts/lib/ai/status.ts").AiMode | null} */
  let aiMode = $state(null)
  let aiDetail = $state("")
  let aiAuto = $state(false)
  let showOnboarding = $state(false)

  const showingSearch = $derived(
    queryDebounced.trim() !== "" || !!activeMood
  )
  const modeLabel = $derived(aiMode ? AI_MODE_LABELS[aiMode] : "Checking AI…")
  /** Rail title, from the receipt only: "AI picks" for a validated
      live answer, "Cached AI picks" for a cache hit, "Local
      recommendations" for the local engine. A quick pick keeps its own
      label (it is filtered locally by design). */
  const railTitle = $derived(
    activeMood
      ? (MOOD_PRESETS.find((p) => p.id === activeMood)?.label ?? activeMood)
      : receipt
        ? aiSearchRailTitle(receipt)
        : `Local recommendations for “${queryDebounced.trim()}”`
  )
  /** One-line honest state note, from the receipt only. Re-evaluates
      on the clock tick so "just now" ages out (see aiSearchStateNote). */
  const stateNote = $derived(
    receipt ? aiSearchStateNote(receipt, nowTick || Date.now()) : ""
  )
  /** Why there is no Ask AI button, when there is none: the rail must
      say why instead of leaving the user to guess. */
  const askAiWhy = $derived(
    aiMode === "local" && aiKeySaved
      ? "AI is off — turn it on in Settings to ask AI."
      : aiMode === "not-configured" && !aiKeySaved
        ? "No API key saved — set one up in Settings to ask AI."
        : aiMode === "not-configured"
          ? "Finish AI setup in Settings to ask AI."
          : "AI isn't available right now — check Settings."
  )
  // -- Diagnostics text (all from the receipt; "Not reported yet" is a
  //    real answer — a field W1/W2 have not reported yet, never a guess).
  /** @param {number | undefined} value */
  function diagCount(value) {
    return typeof value === "number" ? String(value) : "Not reported yet"
  }
  const diagEngineText = $derived(
    !receipt
      ? "—"
      : receipt.engine === "ai"
        ? "AI — live request"
        : receipt.engine === "cached-ai"
          ? "AI — cached answer"
          : "Local engine"
  )
  const diagPhaseText = $derived(
    receipt ? AI_SEARCH_PHASE_LABELS[receipt.phase] : "—"
  )
  const diagModelText = $derived(
    receipt?.model ??
      (receipt?.phase === "cached" ? "Not recorded (cached answer)" : "—")
  )
  const diagQueryTypeText = $derived(
    !receipt
      ? "—"
      : receipt.diagnostics.queryType === "natural-language"
        ? "Natural-language question"
        : receipt.diagnostics.queryType === "keyword"
          ? "Keyword / title search"
          : receipt.diagnostics.queryType === "mood"
            ? "Quick pick (mood)"
            : "—"
  )
  const diagCacheText = $derived(
    receipt?.cacheHit === true
      ? "Hit — no new request sent"
      : receipt?.engine === "ai"
        ? "Miss — live request"
        : "Not used"
  )
  const diagDurationText = $derived(
    typeof receipt?.durationMs === "number" && Number.isFinite(receipt.durationMs)
      ? `${(receipt.durationMs / 1000).toFixed(1)}s`
      : "—"
  )
  /** What "Ask AI" would ask about right now: the typed question, or
      the active quick pick's label when no question is typed. */
  const askAiLabel = $derived(
    activeMood
      ? (MOOD_PRESETS.find((p) => p.id === activeMood)?.label ?? activeMood)
      : queryDebounced.trim()
  )

  function refreshRows() {
    if (!data) return
    rows = getDiscoverRows({
      candidates: data.candidates,
      taste: data.taste,
      continueWatching: data.continueWatching,
      recentlyAdded: data.recentlyAdded,
      nowPlaying: [],
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

  /** Query type for the receipt, from the query + mood only. */
  function queryTypeFor(q, mood) {
    if (mood) return "mood"
    if (!q.trim()) return "none"
    return isNaturalLanguageQuery(q) ? "natural-language" : "keyword"
  }
  /** Intention for the receipt: the moods the query hints at, or the
      quick pick itself. Display only — never sent anywhere. */
  function intentionFor(q, mood) {
    if (mood) {
      const preset = MOOD_PRESETS.find((p) => p.id === mood)
      return preset ? `Quick pick: ${preset.label}` : undefined
    }
    const moods = detectMoodPresets(q)
    if (moods.length) return `Moods: ${moods.map((m) => m.label).join(", ")}`
    return undefined
  }

  let searchToken = 0
  /**
   * Run a search. Typing only ever runs the LOCAL engine; a paid AI
   * request happens only when `ai` is true — submit with automatic
   * requests on, or an explicit "Ask AI" tap (AI07).
   *
   * Every completed search writes a receipt (see ai/status.ts): the
   * rail title and the state note are derived from it, never from the
   * mode badge or a stale "AI answered" string. The activity probe
   * distinguishes a fresh answer from a cache hit — the ranker emits
   * "start"/"done" only around a real request, so a source-"ai" result
   * with no "start" is cached, and the receipt says so.
   */
  async function runSearch({ ai = false } = {}) {
    if (!data) return
    const token = ++searchToken
    const q = queryDebounced.trim()
    if (!q && !activeMood) {
      searchResults = null
      searching = false
      searchingAi = false
      resultsSource = null
      fallbackNotice = ""
      receipt = null
      return
    }
    searching = true
    searchingAi = ai && !!q && !activeMood
    fallbackNotice = ""
    const searchStartedAt = performance.now()
    try {
      let results
      let source = "local"
      /** @type {import("@/scripts/lib/ai/status.ts").AiSearchReceipt | null} */
      let nextReceipt = null
      if (activeMood && !q) {
        results = searchDiscover("", data.candidates, data.taste, {
          moodId: activeMood,
          excludeWatched: true,
          watchedKeys: data.watchedKeys,
          excludeKeys: new Set(data.taste.notInterestedKeys),
          limit: 12,
        })
        nextReceipt = {
          phase: "local-search",
          engine: "local",
          query: MOOD_PRESETS.find((p) => p.id === activeMood)?.label ?? activeMood,
          durationMs: Math.round(performance.now() - searchStartedAt),
          diagnostics: {
            queryType: "mood",
            intention: intentionFor("", activeMood),
            catalogueSize: data.candidates.length,
            acceptedCount: results.length,
            rejectedCount: 0,
            durationMs: Math.round(performance.now() - searchStartedAt),
          },
        }
      } else if (ai && q) {
        // Explicit ask (submit with automatic on, or an "Ask AI" tap):
        // force the ranker even for a short keyword query — the user
        // consented to the request, so the natural-language gate in
        // rankDiscover must not silently veto it back to local.
        activityProbe.started = false
        activityProbe.done = false
        activityProbe.error = false
        const t0 = performance.now()
        const ranked = await rankDiscover(q, data.candidates, data.taste, { forceAi: true })
        const durationMs = Math.round(performance.now() - t0)
        results = ranked.results
        source = ranked.source
        if (ranked.fallbackReason) fallbackNotice = ranked.fallbackReason
        const d = ranked.diagnostics
        const diagnostics = {
          queryType: queryTypeFor(q, null),
          intention: intentionFor(q, null),
          catalogueSize: data.candidates.length,
          retrievedCount: d?.retrievedCount,
          sentToModelCount: d?.sentToModelCount,
          acceptedCount: d?.acceptedCount ?? results.length,
          rejectedCount: d?.rejectedCount ?? 0,
          durationMs,
          fallbackReason: ranked.fallbackReason,
        }
        if (ranked.source === "ai" && activityProbe.started && activityProbe.done) {
          // A real request left the device and a validated reply came
          // back in THIS search: the only receipt that may ever say
          // "AI answered just now" (and only while it is fresh).
          nextReceipt = {
            phase: "validated",
            engine: "ai",
            query: q,
            model: aiModel || undefined,
            answeredAt: Date.now(),
            durationMs,
            cacheHit: false,
            diagnostics: { ...diagnostics, model: aiModel || undefined, cacheHit: false },
          }
        } else if (ranked.source === "ai" && activityProbe.started) {
          // A request went out but no validated "done" was observed for
          // it: the reply arrived, validation is unconfirmed. Say that
          // — never upgrade it to "validated".
          nextReceipt = {
            phase: "received",
            engine: "ai",
            query: q,
            durationMs,
            diagnostics,
          }
        } else if (ranked.source === "ai") {
          // No request left the device for this search: the ranker
          // answered from its cache. Labelled cached, never "just now".
          nextReceipt = {
            phase: "cached",
            engine: "cached-ai",
            query: q,
            answeredAt: null,
            durationMs,
            cacheHit: true,
            diagnostics: { ...diagnostics, cacheHit: true },
          }
        } else {
          nextReceipt = {
            phase: "fallback",
            engine: "local",
            query: q,
            durationMs,
            fallbackReason: ranked.fallbackReason,
            diagnostics,
          }
        }
      } else {
        results = searchDiscover(q, data.candidates, data.taste, {
          excludeWatched: true,
          watchedKeys: data.watchedKeys,
          excludeKeys: new Set(data.taste.notInterestedKeys),
          limit: 24,
        })
        nextReceipt = {
          phase: "local-search",
          engine: "local",
          query: q,
          durationMs: Math.round(performance.now() - searchStartedAt),
          diagnostics: {
            queryType: queryTypeFor(q, null),
            intention: intentionFor(q, null),
            catalogueSize: data.candidates.length,
            acceptedCount: results.length,
            rejectedCount: 0,
            durationMs: Math.round(performance.now() - searchStartedAt),
          },
        }
      }
      if (token !== searchToken) return
      searchResults = visibleResults(results).slice(0, 24)
      resultsSource = source
      receipt = nextReceipt
    } finally {
      if (token === searchToken) {
        searching = false
        searchingAi = false
      }
    }
  }

  let queryTimer = null
  function onQueryInput(value) {
    query = value
    if (queryTimer) clearTimeout(queryTimer)
    // Typing searches locally only — it never sends an AI request.
    queryTimer = setTimeout(() => {
      queryDebounced = value
      activeMood = null
      void runSearch({ ai: false })
    }, 250)
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

  /** Submit the search box: AI runs when automatic requests are on. */
  function submitSearch() {
    queryDebounced = query
    activeMood = null
    void runSearch({ ai: aiAuto })
    focusFirstResult()
  }

  /** Explicit "Ask AI" — one paid request, on the user's tap. */
  function askAi() {
    // A quick pick is a preset, not a question: ask AI about the pick
    // itself (its label is the question — "Easy Watching", "Hidden
    // Gems") and clear the mood so the AI branch runs. For a typed
    // question, ask it exactly as typed.
    if (activeMood && !query.trim()) {
      const label = MOOD_PRESETS.find((p) => p.id === activeMood)?.label ?? activeMood
      query = label
      queryDebounced = label
      activeMood = null
    } else {
      queryDebounced = query
      activeMood = null
    }
    void runSearch({ ai: true })
    focusFirstResult()
  }

  function pickExample(prompt) {
    query = prompt
    queryDebounced = prompt
    activeMood = null
    void runSearch({ ai: true })
    focusFirstResult()
  }

  function pickMood(presetId) {
    activeMood = activeMood === presetId ? null : presetId
    query = ""
    queryDebounced = ""
    void runSearch({ ai: false })
  }

  /** Short subtitle for a quick-pick card, derived only from the
      preset's own fields (genres / rating floor / runtime cap) — never
      invented. */
  function moodSubtitle(preset) {
    if (preset.maxRuntimeMinutes) return `Under ${preset.maxRuntimeMinutes} minutes`
    if (preset.hiddenGem)
      return `Rated ${(preset.minRating ?? 7.5).toFixed(1)}+ · under the radar`
    if (preset.genres?.length) {
      return preset.genres
        .slice(0, 3)
        .map((g) => g.charAt(0).toUpperCase() + g.slice(1))
        .join(" · ")
    }
    if (preset.kind === "series")
      return preset.minRating ? `Series rated ${preset.minRating}+` : "Series"
    if (preset.minRating) return `Rated ${preset.minRating}+`
    return "Anything in your library"
  }

  function clearSearch() {
    query = ""
    queryDebounced = ""
    activeMood = null
    searchResults = null
    resultsSource = null
    fallbackNotice = ""
    receipt = null
    inputEl?.focus()
  }

  function dismissOnboarding() {
    dismissAiOnboarding()
    showOnboarding = false
  }

  async function refreshAiStatus() {
    try {
      aiModel = getAiModel()
    } catch {
      aiModel = ""
    }
    try {
      const status = await getAiStatus()
      aiMode = status.mode
      aiDetail = status.detail
      canAskAi = status.canAskAi
      aiKeySaved = status.keySaved
      showOnboarding = status.mode === "not-configured" && !hasDismissedAiOnboarding()
    } catch {
      aiMode = "local"
      aiDetail = "AI status couldn't be checked — using local recommendations."
      canAskAi = false
      aiKeySaved = false
      showOnboarding = false
    }
  }

  onMount(async () => {
    aiAuto = getAiAutoRequests()
    // Activity probe only: the receipt is built in runSearch after the
    // awaited rankDiscover call. Never set note text here — a "done"
    // from an earlier search must not describe a later cached result.
    const unsubscribeActivity = subscribeAiActivity((event) => {
      if (event.type === "start") activityProbe.started = true
      else if (event.type === "done") activityProbe.done = true
      else activityProbe.error = true
    })
    // Re-evaluate "just now" freshness while a validated receipt is on
    // screen; cheap, and it keeps the note honest without a new search.
    const clock = setInterval(() => {
      nowTick = Date.now()
    }, 20_000)
    try {
      const entry = await getActiveEntry()
      if (!entry?._id) {
        noPlaylist = true
        loading = false
        await refreshAiStatus()
        return
      }
      playlistId = entry._id
      profileId = getActiveProfileId() ?? SHARED_PROFILE_ID
      registerAIRanker(aiRanker)
      await initAI().catch(() => {})
      await refreshAiStatus()
      document.addEventListener("xt:ai-settings-changed", refreshAiStatus)
      await ensureFollowedLoaded().catch(() => {})
      registerFollowedProvider(followedProvider)
      await warmupActive(playlistId).catch(() => {})
      data = await loadDiscoverData(playlistId, profileId)
      refreshRows()
    } catch {
      loadFailed = true
    } finally {
      loading = false
    }
    return () => {
      clearInterval(clock)
      unsubscribeActivity()
      document.removeEventListener("xt:ai-settings-changed", refreshAiStatus)
    }
  })

  $effect(() => {
    void rows
    void searchResults
    void loading
    armTvImageFallbacks(document)
    void tick().then(() => restoreCouchFocus())
  })
</script>

<div class="rs-discover" data-discover-root>
  <!-- Hero: Discover is a destination, with its purpose and its AI
       mode stated up front. -->
  <header class="rs-discover__hero">
    <div class="rs-discover__hero-text">
      <p class="rs-discover__eyebrow">Discover</p>
      <h1 class="rs-page-title">What are we watching?</h1>
      <p class="rs-discover__lede">
        Ask in your own words, pick a quick pick, or browse picks made
        for you — every recommendation comes from titles already in
        your library.
      </p>
    </div>
    <div class="rs-discover__hero-side">
      <a
        href="/settings/discover-ai#card-ai-discovery"
        data-nylah-item
        class="rs-discover-mode rs-discover-mode--{aiMode ?? 'unknown'}"
        title={aiDetail}>
        <span class="rs-discover-mode__dot" aria-hidden="true"></span>
        <span>{modeLabel}</span>
      </a>
      <a href="/settings/discover-ai#card-ai-discovery" data-nylah-item class="rs-discover-prefs">
        Discovery preferences
      </a>
      {#if aiDetail}
        <p class="rs-discover-mode__detail">{aiDetail}</p>
      {/if}
    </div>
  </header>

  <!-- First-run onboarding (AI01): a polished invitation, never a
       block — the library below stays fully browsable, and "Not Now"
       dismisses it for good. -->
  {#if showOnboarding}
    <section class="rs-discover-onboard" aria-label="Unlock AI Discovery" data-ai-onboarding>
      <div class="rs-discover-onboard__text">
        <h2>Unlock AI Discovery</h2>
        <p>
          Describe the night you're in the mood for — "something funny
          for tonight" — and AI picks titles from your own library,
          explaining each choice. Your watch history stays on this
          device unless you choose to share it, and AI is billed
          separately by your provider.
        </p>
      </div>
      <div class="rs-discover-onboard__actions">
        <a
          href="/settings/discover-ai#card-ai-discovery"
          data-nylah-item
          class="rs-discover-onboard__primary">Set Up AI</a>
        <button type="button" onclick={dismissOnboarding} data-nylah-item class="rs-discover-onboard__secondary">
          Not Now
        </button>
      </div>
    </section>
  {/if}

  <div class="rs-discover__search">
    <div class="rs-discover__keyboard-scope" onfocusout={onKeyboardScopeFocusOut}>
      <form
        class="rs-discover__input-row"
        onsubmit={(e) => {
          e.preventDefault()
          submitSearch()
        }}>
        <label for="discover-query" class="sr-only">What are you in the mood for?</label>
        <input
          id="discover-query"
          type="search"
          bind:this={inputEl}
          bind:value={query}
          oninput={(e) => onQueryInput(e.currentTarget.value)}
          onfocus={onSearchInputFocus}
          onclick={onSearchInputFocus}
          onkeydown={onSearchInputKeyDown}
          placeholder="What are you in the mood for?"
          autocomplete="off"
          class="rs-discover-input" />
        <button type="submit" data-nylah-item class="rs-discover-ask">
          {aiAuto ? "Ask AI" : "Search"}
        </button>
        {#if query || activeMood}
          <button
            type="button"
            onclick={clearSearch}
            data-nylah-item
            class="rs-discover-clear">Clear</button>
        {/if}
      </form>

      <TvKeyboard
        bind:value={query}
        open={keyboardOpen}
        onInput={onOskInput}
        onCommit={onKeyboardCommit}
        onDismiss={dismissKeyboardToInput}
        placeholder="What are you in the mood for?" />
    </div>

    <!-- Example prompts: tap one and it asks, exactly as typed. -->
    <div class="rs-discover__examples">
      <p class="rs-discover__examples-title">Try asking</p>
      <div class="rs-discover__example-grid" role="group" aria-label="Example prompts">
        {#each EXAMPLE_PROMPTS.slice(0, 4) as prompt}
          <button
            type="button"
            onclick={() => pickExample(prompt)}
            data-nylah-item
            class="rs-discover-example">
            <span aria-hidden="true">“</span>{prompt}<span aria-hidden="true">”</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Quick picks (B04): six large cards, one icon + label +
         honest subtitle each, consistent focus, no nested panels. -->
    <div class="rs-discover__moods">
      <p class="rs-discover__moods-title">Quick picks</p>
      <div class="rs-discover__mood-grid" role="group" aria-label="Quick picks">
        {#each MOOD_PRESETS as preset (preset.id)}
          <button
            type="button"
            onclick={() => pickMood(preset.id)}
            aria-pressed={activeMood === preset.id}
            data-nylah-item
            class="rs-discover-mood"
            class:is-active={activeMood === preset.id}>
            <span class="rs-discover-mood__icon" aria-hidden="true">{preset.icon}</span>
            <span class="rs-discover-mood__label">{preset.label}</span>
            <span class="rs-discover-mood__sub">{moodSubtitle(preset)}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>

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
        <!-- Rail title comes from the per-search receipt only: "AI
             picks" for a validated live answer, "Cached AI picks" for
             a cache hit, "Local recommendations" for the local engine.
             A quick pick keeps its own label. -->
        <h2 class="rs-section-title">{railTitle}</h2>
        {#if searchingAi}
          <p class="rs-meta">Asking {aiModel || "AI"}… one request for this question.</p>
        {:else if searching}
          <p class="rs-meta">Searching your library…</p>
        {/if}
      </div>
      {#if !searching && stateNote}
        <p class="rs-meta" data-ai-state-note>{stateNote}</p>
      {/if}
      {#if fallbackNotice}
        <p class="rs-discover-fallback" role="status">{fallbackNotice}</p>
      {/if}
      {#if resultsSource === "local" && !searching && !fallbackNotice}
        <!-- A "Local recommendations" rail must say why it is local,
             next to the action that fixes it — or why there is no
             action. Quick picks filter locally by design; a typed
             query shows local results until AI is asked; with AI off
             or no key saved, the rail says so and links to Settings. -->
        <p class="rs-meta" data-local-note>
          {canAskAi
            ? activeMood
              ? "Quick picks are filtered locally. Ask AI below to rank them for you."
              : "Local results so far — Ask AI below for AI picks."
            : askAiWhy}
          {#if !canAskAi}
            <a href="/settings/discover-ai#card-ai-discovery" data-nylah-item class="rs-discover-prefs">Open AI settings</a>
          {/if}
        </p>
      {/if}
      {#if canAskAi && resultsSource === "local" && !searching && (queryDebounced.trim() || activeMood)}
        <!-- 0.11.4: visible where AI can run — at the results, not only
             as the small submit button in the search row (the TV
             on-screen keyboard commits to the results instead of
             submitting, so that button never fires in the TV flow).
             0.11.5: gated on canAskAi (an attempt can run), not on a
             passing test — an untested-but-configured AI is offered
             here, and a failure surfaces through the fallback reason.
             Shown in Manual AND Automatic: in Automatic it is the
             only reachable ask for a typed query. Hides once AI
             answers (source becomes "ai"); shows again on fallback. -->
        <button type="button" onclick={askAi} data-nylah-item class="rs-discover-ask-ai">
          Ask AI about “{askAiLabel}”
        </button>
      {/if}
      {#if searchResults && searchResults.length}
        <div class="rs-rail__row">
          {#each searchResults as item (candidateKey(item.candidate))}
            {@render discoverCard(item)}
          {/each}
        </div>
      {:else if !searching}
        <p class="rs-meta">Nothing matched — try a different word or a quick pick above. Discover only searches titles already in your library.</p>
      {/if}
      {#if receipt}
        <!-- Diagnostics (0.11.5): collapsible, off the main path, one
             toggle reachable by controller. Shows what actually
             produced this rail — engine, state, model, query type,
             counts, cache, duration, fallback reason. Fields the
             ranker does not report yet read "Not reported yet".
             Never any API key, credential or request text. -->
        <section class="rs-discover-diag" data-ai-diagnostics aria-label="Why these results">
          <button
            type="button"
            onclick={() => {
              diagnosticsOpen = !diagnosticsOpen
            }}
            aria-expanded={diagnosticsOpen}
            data-nylah-item
            class="rs-discover-diag__toggle">
            {diagnosticsOpen ? "Hide diagnostics" : "Why these results?"}
          </button>
          {#if diagnosticsOpen}
            <dl class="rs-discover-diag__grid">
              <div><dt>Engine</dt><dd data-diag-engine>{diagEngineText}</dd></div>
              <div><dt>State</dt><dd data-diag-phase>{diagPhaseText}</dd></div>
              <div><dt>Model</dt><dd data-diag-model>{diagModelText}</dd></div>
              <div>
                <dt>Query type</dt>
                <dd data-diag-query-type>{diagQueryTypeText}{receipt.diagnostics.intention ? ` — ${receipt.diagnostics.intention}` : ""}</dd>
              </div>
              <div><dt>Catalogue size</dt><dd data-diag-catalogue>{diagCount(receipt.diagnostics.catalogueSize)} titles</dd></div>
              <div><dt>Retrieved candidates</dt><dd data-diag-retrieved>{diagCount(receipt.diagnostics.retrievedCount)}</dd></div>
              <div><dt>Sent to the model</dt><dd data-diag-sent>{diagCount(receipt.diagnostics.sentToModelCount)}</dd></div>
              <div><dt>Accepted</dt><dd data-diag-accepted>{diagCount(receipt.diagnostics.acceptedCount)}</dd></div>
              <div><dt>Rejected by catalogue check</dt><dd data-diag-rejected>{diagCount(receipt.diagnostics.rejectedCount)}</dd></div>
              <div><dt>Cache</dt><dd data-diag-cache>{diagCacheText}</dd></div>
              <div><dt>Request time</dt><dd data-diag-duration>{diagDurationText}</dd></div>
              <div><dt>Fallback reason</dt><dd data-diag-fallback>{receipt.diagnostics.fallbackReason ?? receipt.fallbackReason ?? "—"}</dd></div>
            </dl>
            <p class="rs-discover-diag__foot">Diagnostics never include API keys, credentials or request text.</p>
          {/if}
        </section>
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
  <div class="rs-discover-cell rs-discover-cell--poster">
    <article class="rs-discover-card">
      <a
        href={candidateDetailHref(c)}
        data-nylah-item
        data-couch-key={key}
        aria-label={`${c.title}${c.year ? ` (${c.year})` : ""}`}
        class="rs-card rs-card--poster">
        <span class="rs-card__media">
          <span
            class="rs-image rs-image--poster{c.posterUrl ? '' : ' is-fallback'}"
            data-tv-image
            data-kind="poster"
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
              <span class="rs-image__fallback-mark">{fallbackMarkFor("poster", c.title)}</span>
              <span class="rs-image__fallback-title">{c.title}</span>
            </span>
          </span>
          {#if c.rating}
            <span class="rs-discover-rating" aria-label={`Rating ${fmtImdbRating(c.rating)} out of 10`}>
              <span aria-hidden="true">★</span><span>{fmtImdbRating(c.rating)}</span>
            </span>
          {/if}
        </span>
        <span class="rs-card__body">
          <span class="rs-card__title">{c.title}</span>
          <span class="rs-card__subtitle">
            {#if c.year}{c.year} · {/if}{c.kind === "series" ? "Series" : "Film"}
          </span>
          <span class="rs-card__meta rs-discover-reason">{item.reason}</span>
        </span>
      </a>
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
  /* Hero: title + lede on the left, mode + preferences on the right. */
  .rs-discover__hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 2rem;
    flex-wrap: wrap;
  }
  .rs-discover__hero-text {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 46rem;
  }
  .rs-discover__eyebrow {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rs-focus);
  }
  .rs-discover__lede {
    margin: 0;
    font-size: 1.375rem;
    line-height: 1.45;
    color: var(--rs-text-2);
  }
  .rs-discover__hero-side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.5rem;
    min-width: 16rem;
  }
  .rs-discover-mode {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 1.125rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text);
    font-size: 1.25rem;
    font-weight: 700;
    text-decoration: none;
    outline: none;
    white-space: nowrap;
  }
  .rs-discover-mode:hover,
  .rs-discover-mode:focus-visible {
    border-color: var(--rs-focus);
  }
  .rs-discover-mode:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus), 0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  .rs-discover-mode__dot {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: var(--rs-text-2);
    flex: none;
  }
  .rs-discover-mode--connected .rs-discover-mode__dot {
    background: #3fb96f;
  }
  .rs-discover-mode--unavailable .rs-discover-mode__dot {
    background: #e0a63c;
  }
  .rs-discover-mode--local .rs-discover-mode__dot {
    background: #7fb3e8;
  }
  .rs-discover-mode__detail {
    margin: 0;
    max-width: 22rem;
    text-align: right;
    font-size: 1.0625rem;
    line-height: 1.4;
    color: var(--rs-text-2);
  }
  .rs-discover-prefs {
    font-size: 1.125rem;
    color: var(--rs-focus);
    text-decoration: underline;
    text-underline-offset: 0.2em;
    outline: none;
  }
  .rs-discover-prefs:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus);
    border-radius: 0.375rem;
  }
  /* Onboarding: one calm panel, not a modal — browsing continues below. */
  .rs-discover-onboard {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2rem;
    flex-wrap: wrap;
    padding: 1.5rem 1.75rem;
    border-radius: 1rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
  }
  .rs-discover-onboard__text {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 52rem;
  }
  .rs-discover-onboard__text h2 {
    margin: 0;
    font-size: 1.625rem;
    font-weight: 700;
    color: var(--rs-text);
  }
  .rs-discover-onboard__text p {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.5;
    color: var(--rs-text-2);
  }
  .rs-discover-onboard__actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: none;
  }
  .rs-discover-onboard__primary {
    padding: 0.875rem 1.5rem;
    border-radius: 0.75rem;
    background: var(--rs-accent);
    color: #fff;
    font-size: 1.25rem;
    font-weight: 700;
    text-decoration: none;
    outline: none;
    white-space: nowrap;
  }
  .rs-discover-onboard__primary:hover,
  .rs-discover-onboard__primary:focus-visible {
    border-color: var(--rs-focus);
  }
  .rs-discover-onboard__primary:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus), 0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  .rs-discover-onboard__secondary {
    padding: 0.875rem 1.25rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: transparent;
    color: var(--rs-text-2);
    font-size: 1.25rem;
    cursor: pointer;
    outline: none;
    white-space: nowrap;
  }
  .rs-discover-onboard__secondary:hover,
  .rs-discover-onboard__secondary:focus-visible {
    color: var(--rs-text);
    border-color: var(--rs-focus);
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
  .rs-discover-ask {
    padding: 0.875rem 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-focus);
    background: var(--rs-accent);
    color: #fff;
    font-size: 1.25rem;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    outline: none;
  }
  .rs-discover-ask:hover,
  .rs-discover-ask:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus), 0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  .rs-discover-clear {
    font-size: 1.25rem;
    padding: 0.625rem 1.25rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text-2);
    cursor: pointer;
    white-space: nowrap;
    outline: none;
  }
  .rs-discover-clear:hover,
  .rs-discover-clear:focus-visible {
    color: var(--rs-text);
    background: var(--rs-surface);
    border-color: var(--rs-focus);
  }
  .rs-discover__examples {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .rs-discover__examples-title,
  .rs-discover__moods-title {
    margin: 0;
    font-size: 1.375rem;
    font-weight: 700;
    color: var(--rs-text);
  }
  .rs-discover__example-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }
  /* Example prompts are quiet text buttons, not pills and not cards:
     one line each, left aligned, clearly tappable. */
  .rs-discover-example {
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line-soft);
    background: transparent;
    color: var(--rs-text-2);
    font-size: 1.25rem;
    line-height: 1.35;
    text-align: left;
    cursor: pointer;
    outline: none;
  }
  .rs-discover-example:hover,
  .rs-discover-example:focus-visible {
    color: var(--rs-text);
    border-color: var(--rs-focus);
    background: var(--rs-surface);
  }
  .rs-discover-example:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus);
  }
  .rs-discover__moods {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .rs-discover__mood-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
  }
  @media (max-width: 56rem) {
    .rs-discover__mood-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  /* Large navigable quick-pick card: icon + big label + an honest
     subtitle derived from the preset itself. One clear focus ring,
     and the active card reads as selected, not as a pressed pill. */
  .rs-discover-mood {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.375rem;
    min-height: 6.5rem;
    padding: 1.25rem 1.5rem;
    border-radius: 1rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text);
    text-align: left;
    cursor: pointer;
    outline: none;
  }
  .rs-discover-mood:hover,
  .rs-discover-mood:focus-visible {
    border-color: var(--rs-focus);
    background: var(--rs-bg-2);
  }
  .rs-discover-mood:focus-visible {
    box-shadow:
      0 0 0 3px var(--rs-focus),
      0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  .rs-discover-mood.is-active {
    background: var(--rs-accent);
    border-color: var(--rs-focus);
    color: #fff;
  }
  .rs-discover-mood__icon {
    font-size: 1.5rem;
    line-height: 1;
    color: var(--rs-focus);
  }
  .rs-discover-mood.is-active .rs-discover-mood__icon {
    color: #fff;
  }
  .rs-discover-mood__label {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.2;
  }
  .rs-discover-mood__sub {
    font-size: 1.125rem;
    line-height: 1.35;
    color: var(--rs-text-2);
  }
  .rs-discover-mood.is-active .rs-discover-mood__sub {
    color: rgb(255 255 255 / 0.85);
  }
  .rs-discover-fallback {
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    padding: 0.875rem 1.25rem;
    font-size: 1.25rem;
    color: var(--rs-text-2);
    margin: 0;
  }
  .rs-discover-ask-ai {
    align-self: flex-start;
    padding: 0.875rem 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-focus);
    background: var(--rs-accent);
    color: #fff;
    font-size: 1.25rem;
    font-weight: 700;
    cursor: pointer;
    outline: none;
  }
  .rs-discover-ask-ai:hover,
  .rs-discover-ask-ai:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus), 0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  /* Diagnostics (0.11.5): collapsible, off the main path — one quiet
     toggle, and a compact definition list when open. Plain buttons and
     text only: no focus traps, controller-reachable like everything
     else on Discover. */
  .rs-discover-diag {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }
  .rs-discover-diag__toggle {
    padding: 0.625rem 1.125rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: transparent;
    color: var(--rs-text-2);
    font-size: 1.125rem;
    cursor: pointer;
    outline: none;
  }
  .rs-discover-diag__toggle:hover,
  .rs-discover-diag__toggle:focus-visible {
    color: var(--rs-text);
    border-color: var(--rs-focus);
    background: var(--rs-surface);
  }
  .rs-discover-diag__toggle:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus);
  }
  .rs-discover-diag__grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem 2rem;
    width: 100%;
    margin: 0;
    padding: 1rem 1.25rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
  }
  .rs-discover-diag__grid > div {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
    min-width: 0;
  }
  .rs-discover-diag__grid dt {
    flex: none;
    font-size: 1.0625rem;
    font-weight: 700;
    color: var(--rs-text-2);
  }
  .rs-discover-diag__grid dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 1.0625rem;
    color: var(--rs-text);
  }
  .rs-discover-diag__foot {
    margin: 0;
    font-size: 1rem;
    color: var(--rs-text-2);
  }
  .rs-discover-cell {
    flex: 0 0 auto;
    min-width: 0;
  }
  .rs-discover-cell--poster {
    flex-basis: clamp(9rem, 11.5vw, 13rem);
    width: clamp(9rem, 11.5vw, 13rem);
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
    /* Top-left, like TvCard's badge: bottom-left collides with the
       fallback art's own title line (0.10.0 integration — the rating
       pill sat on top of "Bulk Comedy 14"'s first letter). */
    top: 0.625rem;
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
</style>
