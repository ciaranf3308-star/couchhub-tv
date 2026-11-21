<!-- RedSilk Discover (0.11.6) — the dedicated Discover destination.
     "What do you fancy watching?" — a natural question in, compelling
     recommendations out. AI-first (0.11.6): the LLM generates
     recommendations from its own knowledge, TMDB verifies each
     identity, and the catalogue match decides playability. Every
     recommendation says honestly whether it is in your library; an
     unavailable pick is never replaced by a weaker available one,
     and empty slots are never filled with random titles.
     - AI requests happen ONLY on an explicit submit / "Ask AI" tap /
       refinement submit (AI07). Typing, focus and scrolling never
       send anything. Toggling "Available in My Library" filters the
       results already returned — it never re-calls the model.
     - Refinements keep the conversation (see ai/generation.ts); New
       Search clears it. No chatbot UI: one subtle context line only.
     - First run with no AI configured shows the "Unlock AI Discovery"
       panel once; "Not Now" dismisses it for good (AI01). Browsing is
       never blocked by it.
     - No feedback buttons under posters here (B01): feedback lives on
       the detail screen. Cards show the reason line only.
     - Discover is separate from Live TV: no "On TV Right Now" row.
     - Honesty (0.11.5/0.11.6): every search writes a per-search
       receipt (ai/status.ts) — the rail title, the state note and the
       diagnostics panel are derived from it, and only from it. "AI
       answered just now" is true only for a validated live answer;
       a cache hit is labelled cached, a local result local, and a
       local rail says why it is local (or why Ask AI is unavailable).
       Unverified titles stay visibly unverified: no artwork, no
       detail link, no invented metadata.
     Logic: the catalogue loads once at mount. The AI path calls the
     discovery orchestrator (ai/discovery-orchestrator.ts: LLM
     generation -> TMDB verification -> catalogue matching); the
     local engine (searchDiscover) stays for typing, quick picks,
     and the explicitly-labelled "similar titles available locally"
     option. The old rankDiscover/AI-ranker path is retired: one
     orchestration layer only. -->
<script>
  import { onMount, tick } from "svelte"
  import { getActiveEntry } from "@/scripts/lib/creds.js"
  import { warmupActive } from "@/scripts/lib/catalog.js"
  import { getActiveProfileId, SHARED_PROFILE_ID } from "@/scripts/lib/profiles.ts"
  import {
    loadDiscoverData,
    getDiscoverRows,
    searchDiscover,
    candidateDetailHref,
    candidateKey,
    MOOD_PRESETS,
    registerFollowedProvider,
    isNaturalLanguageQuery,
    detectMoodPresets,
  } from "@/scripts/lib/discover.ts"
  // Guided three-step flow (0.11.18 redesign): the pure flow state
  // machine, request builder and reveal queue live in
  // discover-redesign.ts; the view only renders and calls the real
  // Discovery 3.0 orchestrator.
  import {
    freshDiscoverFlow,
    selectDiscoverKind,
    toggleDiscoverCategory,
    surpriseDiscoverCategories,
    continueToBrief,
    setDiscoverBrief,
    refineFlowState,
    stepBackFlow,
    choicesSummary,
    selectedSummary,
    buildDiscoveryQuery,
    playableRecommendations,
    pickNextRecommendation,
    shownTitles,
    aiNotReadyMessage,
    KIND_CARDS,
    GENRE_CATEGORIES,
  } from "@/scripts/lib/discover-redesign.ts"
  import { isOnWatchlist, toggleWatchlist } from "@/scripts/lib/preferences.js"
  // AI-first discovery (0.11.6): the orchestrator (W1) + verification
  // (W2) + state transitions (W4) are the real modules; in-flight
  // progress arrives via subscribeAiDiscoveryPhase (the orchestrator
  // has no onPhase dep). The presentation helpers are pure, tested
  // code.
  import {
    runAiDiscovery,
    subscribeAiDiscoveryPhase,
  } from "@/scripts/lib/ai/discovery-orchestrator.ts"
  import {
    newConversation,
  } from "@/scripts/lib/ai/generation.ts"
  import {
    applyQuickPick,
    applyNewSearch,
  } from "@/scripts/lib/discover-state.ts"
  import {
    visibleRecommendations,
    countMatched,
    recommendationDetailHref,
    refinementContextLabel,
    formatTasteSummaryForAi,
    providerErrorMessage,
    providerErrorCodeFor,
    aiDiscoveryProgressText,
  } from "@/scripts/lib/ai/discovery-presentation.ts"
  import { summarizeTaste } from "@/scripts/lib/taste.ts"
  import {
    BACK_PRIORITY,
    registerBackLayer,
  } from "@/scripts/lib/back-handler.ts"
  import { setControllerHints } from "@/scripts/lib/couch-button-hints.ts"
  import {
    recordOriginFromReferrer,
    navigateBackWithOrigin,
  } from "@/scripts/lib/route-origin.ts"
  import { initAI } from "@/scripts/lib/ai/init.ts"
  import {
    getAiStatus,
    getAiAutoRequests,
    getAiShareTaste,
    hasDismissedAiOnboarding,
    dismissAiOnboarding,
    AI_MODE_LABELS,
    AI_SEARCH_PHASE_LABELS,
    aiSearchRailTitle,
    aiSearchStateNote,
  } from "@/scripts/lib/ai/status.ts"
  import { ensureFollowedLoaded, followedProvider } from "@/scripts/lib/followed.ts"
  import { fmtImdbRating } from "@/scripts/lib/format.ts"
  import TvKeyboard from "@/components/couch/TvKeyboard.svelte"
  import { CouchKeyboardLifecycle } from "@/scripts/lib/couch-keyboard.ts"
  import {
    openCouchKeyboard,
    closeCouchKeyboard,
    isCouchKeyboardOpen,
    endCouchKeyboardSession,
    nextDiscoverBackStep,
    COUCH_KEYBOARD_CLOSED_EVENT,
  } from "@/scripts/lib/couch-keyboard.ts"
  import { restoreCouchFocus, setLogicalView } from "@/scripts/lib/couch-focus.ts"
  // Region ownership (§7.3, W1 contract): the mixed-kind owner
  // routes D-pad presses between the view's [data-nav-region]
  // sections; see region-direction.ts.
  import { registerNavigationOwner } from "@/scripts/lib/navigation-ownership.ts"
  import {
    createRegionDirectionHandler,
    regionSectionEntry,
  } from "@/scripts/lib/region-direction.ts"
  import {
    armTvImageFallbacks,
    fallbackMarkFor,
  } from "@/scripts/lib/couch-image.ts"

  // Keyboard lifecycle: the on-screen keyboard is hidden on landing
  // and opens when the search input receives focus; see
  // src/scripts/lib/couch-keyboard.ts for the full contract
  // (Escape / Hide-button dismiss, blur-to-a-real-element hides,
  // commit moves focus to results).
  /** @type {HTMLTextAreaElement | null} */
  let inputEl = null
  /** @type {HTMLDivElement | null} */
  let rootEl = null
  const keyboard = new CouchKeyboardLifecycle()
  let keyboardOpen = $state(false)
  function syncKeyboard() {
    keyboardOpen = keyboard.open
  }
  function onSearchInputFocus() {
    // Redesign: the brief is typed on a physical keyboard / chatpad
    // straight into the textarea — the on-screen keyboard NEVER
    // opens on focus. It opens only on the explicit "On-screen
    // keyboard" button (openBriefKeyboard below) or ArrowDown.
    // Focus stays in the textarea; nothing here touches the OSK.
    syncKeyboard()
  }
  function onSearchInputKeyDown(ev) {
    if (ev.key === "Escape") {
      if (keyboard.dismiss()) {
        endCouchKeyboardSession()
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
  function onKeyboardCommit() {
    endCouchKeyboardSession()
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
  /** Per-search engine receipt (0.11.5): the ONLY source for the rail
      title and the "AI answered" note — see ai/status.ts. A rail is
      labelled by the engine that actually produced it, and "AI answered
      just now" is only ever true for a validated receipt (see
      isFreshAiAnswer). Replaced on every completed search; kept across
      the in-flight await so the title never claims AI early. */
  let receipt = $state(
    /** @type {import("@/scripts/lib/ai/status.ts").AiSearchReceipt | null} */ (null)
  )
  // -- AI-first discovery state (0.11.6) -------------------------------
  /** Conversational context for refinements; cleared by New Search. */
  let conversation = $state(newConversation())
  /** "Available in My Library" toggle: client-side filter only — the
      orchestrator is always asked for the full verified set (see
      runAiSearch), so toggling never re-calls the model. */
  let availableOnly = $state(false)
  /** Verified recommendations from the last AI run, or null when no
      AI rail is on screen. An empty array means the run returned
      nothing (honest empty state, never filler). */
  let aiResults = $state(
    /** @type {Array<import("@/scripts/lib/ai/verification.ts").VerifiedRecommendation> | null} */ (null)
  )
  /** In-flight orchestrator phase, when the orchestrator reports one
      via subscribeAiDiscoveryPhase. Only the three in-flight phases
      are shown; terminal phases clear it. Null when idle (the UI then
      shows a single "Asking AI…" state — never invented stages). */
  let aiPhase = $state(
    /** @type {import("@/scripts/lib/ai/status.ts").AiSearchPhase | null} */ (null)
  )
  /** Provider failure for the last AI attempt, or null. */
  let aiUnavailable = $state(
    /** @type {{ providerError: string; message: string } | null} */ (null)
  )
  /** Explicitly-labelled local similar titles, shown only when the
      user asks for them from a none-available / unavailable state.
      Never masquerades as AI recommendations. */
  let localSimilar = $state(
    /** @type {{ query: string; items: Array<import("@/scripts/lib/discover.ts").RankedCandidate> } | null} */ (null)
  )
  /** AbortController for the in-flight AI run, if any. A new submit,
      New Search, Clear, or leaving Discover cancels it. */
  let aiAbort = /** @type {AbortController | null} */ (null)
  let diagnosticsOpen = $state(false)
  /** @type {boolean} */
  let canAskAi = $state(false)
  /** @type {boolean} */
  let aiKeySaved = $state(false)
  /** Clock tick so a "just now" note ages out without a new search. */
  let nowTick = $state(0)
  /** @type {string | null} */
  let activeMood = $state(null)
  /** @type {import("@/scripts/lib/ai/status.ts").AiMode | null} */
  let aiMode = $state(null)
  let aiDetail = $state("")
  let aiAuto = $state(false)
  let showOnboarding = $state(false)

  // -- Guided three-step flow (0.11.18 redesign) ----------------------
  let flow = $state(freshDiscoverFlow())
  /** Catalogue keys / session ids already revealed this session. */
  let shownIds = $state(/** @type {Set<string>} */ (new Set()))
  /** Index of the current pick inside visibleAiResults. */
  let currentPick = $state(0)
  /** Whether the current pick is already on the Watch Later list. */
  let watchLaterSaved = $state(false)
  /** Honest notice for the current step (no-key, empty queue, ...). */
  let flowNotice = $state("")
  /** One-shot explicit question for the next AI run (Ask AI / example
      prompt). Null means "ask the guided flow's question". Cleared
      by runAiSearch as soon as it is read. */
  let aiQueryOverride = $state(/** @type {string | null} */ (null))
  /** @type {HTMLCanvasElement | null} */
  let neuralCanvas = null
  /** rAF id for the neural drift animation, if running. */
  let neuralRaf = 0
  /** Resize handler for the neural canvas, if started. */
  let neuralCanvasResize = null
  /** Nodes / pulses for the neural canvas (owned by startNeuralCanvas). */
  let neuralNodes = []
  let neuralPulses = []

  /** Whether an AI rail (results, or an honest empty/unavailable
      state) is on screen, as opposed to a local rail. */
  const hasAiResults = $derived(aiResults !== null)
  /** Recommendations to show for the current toggle state — a pure
      client-side filter; toggling never re-calls the model. */
  // The reveal queue is playable-only FIRST (verified + confirmed
  // library match — discover-redesign.ts), then the toggle filter.
  // Unplayable titles can never reach the reveal screen.
  const visibleAiResults = $derived(
    visibleRecommendations(playableRecommendations(aiResults ?? []), availableOnly)
  )
  /** The one recommendation on screen right now (reveal is one at a time). */
  const currentRec = $derived(visibleAiResults[currentPick] ?? null)
  const currentHref = $derived(currentRec ? recommendationDetailHref(currentRec) : null)
  const flowStepNumber = $derived(flow.step === "kind" ? 1 : flow.step === "categories" ? 2 : 3)
  const choicesLine = $derived(choicesSummary(flow))
  const selectedLine = $derived(selectedSummary(flow))
  const matchedAiCount = $derived(countMatched(aiResults ?? []))
  /** True when every AI recommendation on screen is TMDB-verified —
      the toggle note may only claim "verified" when that holds. */
  const allAiVerified = $derived(
    (aiResults ?? []).length > 0 && (aiResults ?? []).every((rec) => rec.verified)
  )
  /** Subtle refinement context ("Refining: “dark anime”"), or "". */
  const refineLabel = $derived(refinementContextLabel(conversation))
  /** In-flight status text: the orchestrator's reported phase when
      there is one, else the single honest "Asking AI" state. */
  const aiStatusText = $derived(
    aiPhase ? aiDiscoveryProgressText(aiPhase) : "Asking AI for recommendations…"
  )
  const searchPlaceholder = $derived(
    hasAiResults && conversation.turns.length > 0
      ? "Refine these picks… e.g. Darker, only movies"
      : "What are you in the mood for?"
  )
  const modeLabel = $derived(aiMode ? AI_MODE_LABELS[aiMode] : "Checking AI…")
  /** Rail title, from the receipt only — except while an AI run is in
      flight (the title says the question is being asked), and when
      the AI attempt failed (the title says so — never "Local
      recommendations", because no local results were produced). */
  const railTitle = $derived(
    searchingAi
      ? `Asking AI for “${queryDebounced.trim()}”`
      : aiUnavailable
        ? "AI unavailable"
        : activeMood
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
   * Run a LOCAL search (typing, quick picks, Manual submit). This
   * function never sends an AI request: the AI path is runAiSearch,
   * which calls the discovery orchestrator. A local search is
   * authoritative for the rail — it clears any AI rail on screen, so
   * a stale AI result can never sit above fresh local results.
   *
   * Every completed search writes a receipt (see ai/status.ts): the
   * rail title and the state note are derived from it, never from the
   * mode badge or a stale "AI answered" string.
   */
  async function runSearch() {
    if (!data) return
    const token = ++searchToken
    const q = queryDebounced.trim()
    if (!q && !activeMood) {
      searchResults = null
      searching = false
      searchingAi = false
      resultsSource = null
      receipt = null
      aiResults = null
      aiUnavailable = null
      localSimilar = null
      return
    }
    searching = true
    searchingAi = false
    aiResults = null
    aiUnavailable = null
    localSimilar = null
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
  /**
   * Cancel the pending debounced local search, if any. EVERY
   * transition that replaces the typed query's meaning must call
   * this FIRST: without it, typing then tapping a quick pick (or
   * submitting, or clearing) within the 250ms window lets the stale
   * timer fire afterwards, restoring the typed query, wiping the
   * mood and running a stale local search (0.11.6 debounce hole).
   */
  function cancelQueryTimer() {
    if (queryTimer) {
      clearTimeout(queryTimer)
      queryTimer = null
    }
  }
  function onQueryInput(value) {
    query = value
    cancelQueryTimer()
    // Typing a refinement must not clobber the AI results on screen:
    // while an AI rail is showing, typing only edits the box — the
    // refinement runs on submit. Otherwise typing searches locally
    // only — it never sends an AI request.
    if (aiResults !== null) return
    queryTimer = setTimeout(() => {
      queryTimer = null
      queryDebounced = value
    }, 250)
  }

  function onOskInput(value) {
    onQueryInput(value)
  }

  /**
   * Run the AI-first discovery flow: one explicit orchestrator call
   * (submit with automatic requests on, "Ask AI", an example prompt,
   * or a refinement submit). The previous AI rail stays on screen
   * while a refinement runs, so the user never stares at a blank rail.
   *
   * - availableOnly is ALWAYS false at request time: the toggle is a
   *   client-side filter over the full verified set (see
   *   visibleAiResults), so toggling both ways never needs a new
   *   model call. The orchestrator never filters on the flag and it
   *   is not a cache dimension; the field is passed for API
   *   stability only.
   * - Taste is sent ONLY when the user opted in to sharing it
   *   (default OFF, AI05), as a single formatted string.
   * - The loaded catalogue is passed for playability matching; the
   *   orchestrator decides the match, the UI only displays it. The
   *   active profile id scopes the orchestrator's cache per profile.
   * - In-flight progress arrives via subscribeAiDiscoveryPhase
   *   (scoped to this run, unsubscribed in the finally below); the
   *   orchestrator exposes no onPhase dep, and the model is resolved
   *   from Settings inside the orchestrator, never passed by the UI.
   * - Cancellation: a new submit, New Search, Clear, or leaving
   *   Discover aborts the in-flight run; an aborted run updates no
   *   state. The receipt comes from the orchestrator, verbatim.
   */
  async function runAiSearch() {
    if (!data) return
    // The request is the guided flow's ask (kind + draws + brief),
    // with the titles already shown this session excluded — unless a
    // caller passes an explicit question (Ask AI / example prompt).
    // The orchestrator is the ONLY caller of the model: the LLM
    // generates from its own knowledge, TMDB verifies, and the
    // catalogue match decides playability. Diagnostics therefore show
    // real model calls (sentToModelCount stays the honest 0 — the
    // generation sends no candidate list to the model, by design).
    const q = (
      aiQueryOverride ??
      buildDiscoveryQuery(flow, {
        shownTitles: shownTitles(playableRecommendations(aiResults ?? []), shownIds),
      })
    ).trim()
    aiQueryOverride = null
    if (!q) return
    // No doomed requests: when AI cannot run, stay on step 3 and say
    // why honestly — never pretend the model answered. The local
    // catalogue fallback is offered from the same screen.
    if (!canAskAi) {
      queryDebounced = choicesSummary(flow) || q
      activeMood = null
      flowNotice = aiNotReadyMessage(aiMode, aiKeySaved)
      return
    }
    if (aiAbort) aiAbort.abort()
    const controller = new AbortController()
    aiAbort = controller
    const token = ++searchToken
    queryDebounced = choicesSummary(flow) || q
    activeMood = null
    searching = true
    searchingAi = true
    aiPhase = "asking-ai"
    aiUnavailable = null
    localSimilar = null
    searchResults = null
    resultsSource = null
    flowNotice = ""
    flow = { ...flow, step: "loading" }
    const runStartedAt = performance.now()
    const tasteSummary = getAiShareTaste()
      ? formatTasteSummaryForAi(summarizeTaste(data.taste))
      : null
    // In-flight phases for THIS run only. Terminal phases
    // (ready/unavailable/cached) are ignored here — the completion
    // paths below clear aiPhase. The subscription replays the last
    // phase on subscribe; the in-flight filter keeps a stale
    // terminal phase out, and the run's own "asking-ai" emission
    // lands in the same task.
    const unsubscribePhase = subscribeAiDiscoveryPhase((phase) => {
      if (token !== searchToken) return
      if (
        phase === "asking-ai" ||
        phase === "verifying-tmdb" ||
        phase === "checking-library"
      ) {
        aiPhase = phase
      }
    })
    try {
      const result = await runAiDiscovery(
        {
          query: q,
          conversation,
          tasteSummary,
          availableOnly: false,
          count: 12,
          signal: controller.signal,
        },
        {
          catalogue: data.candidates,
          profileId,
        }
      )
      if (token !== searchToken) return
      // An orchestrator may report a provider failure as a result
      // (empty + providerError) instead of throwing: treat that as
      // unavailable too, never as an empty success.
      if (
        result.results.length === 0 &&
        result.diagnostics.providerError
      ) {
        const providerError = result.diagnostics.providerError
        aiUnavailable = {
          providerError,
          message: providerErrorMessage(providerError),
        }
        aiResults = []
        receipt = result.receipt
        resultsSource = "local"
        aiPhase = null
        flow = { ...flow, step: "brief" }
        flowNotice = aiUnavailable.message
        return
      }
      conversation = result.conversation
      aiResults = result.results
      receipt = result.receipt
      resultsSource = "ai"
      aiPhase = null
      // Reveal ONE playable pick at a time: only verified titles with
      // a confirmed library match ever reach the screen, and the
      // first unshown one is the current pick. An empty playable
      // queue is an honest empty state, never filler.
      const playable = playableRecommendations(result.results)
      const first = pickNextRecommendation(playable, shownIds)
      if (!first.rec) {
        flow = { ...flow, step: "brief" }
        flowNotice =
          playable.length === 0
            ? "AI couldn't find anything in your library for that — try different draws, or a different brief."
            : "You've seen every pick from that run — refine the brief for a fresh set."
        return
      }
      shownIds = first.shownIds
      currentPick = playable.indexOf(first.rec)
      watchLaterSaved = false
      flow = { ...flow, step: "reveal" }
      // Focus the Watch action once it has rendered.
      await tick()
      if (token === searchToken) focusFirstAiResult()
    } catch (error) {
      if (token !== searchToken) return
      if (controller.signal.aborted || error?.name === "AbortError") return
      const providerError = providerErrorCodeFor(error)
      aiUnavailable = {
        providerError,
        message: providerErrorMessage(providerError),
      }
      aiResults = []
      resultsSource = "local"
      aiPhase = null
      flow = { ...flow, step: "brief" }
      flowNotice = aiUnavailable.message
      receipt = {
        phase: "fallback",
        engine: "ai",
        query: q,
        durationMs: Math.round(performance.now() - runStartedAt),
        fallbackReason: aiUnavailable.message,
        diagnostics: {
          queryType: queryTypeFor(q, null),
          intention: intentionFor(q, null),
          catalogueSize: data.candidates.length,
          acceptedCount: 0,
          rejectedCount: 0,
          durationMs: Math.round(performance.now() - runStartedAt),
          fallbackReason: aiUnavailable.message,
          providerError,
        },
      }
    } finally {
      unsubscribePhase()
      if (token === searchToken) {
        searching = false
        searchingAi = false
      }
    }
  }

  /**
   * "Search for similar titles available locally": the EXISTING local
   * engine, explicitly labelled as local similar titles — never
   * masquerading as LLM recommendations. Only runs on the user's tap,
   * from a none-available / unavailable state.
   */
  function searchLocalSimilar() {
    if (!data) return
    const q = (receipt?.query ?? queryDebounced ?? query).trim()
    const items = searchDiscover(q, data.candidates, data.taste, {
      excludeWatched: true,
      watchedKeys: data.watchedKeys,
      excludeKeys: new Set(data.taste.notInterestedKeys),
      limit: 12,
    })
    localSimilar = { query: q, items: visibleResults(items).slice(0, 12) }
    requestAnimationFrame(() => {
      document
        .querySelector("[data-local-similar] [data-nylah-item]")
        ?.focus({ preventScroll: false })
    })
  }

  /** "Available in My Library" toggle: filter only, never a new call.
      Focus discipline (§7.3): the toggle must not jump to the top of
      the page, and a focused card filtered out of the grid must not
      strand focus on <body> — focus returns to the toggle, the
      control the user just operated, with scroll untouched. */
  function toggleAvailableOnly() {
    availableOnly = !availableOnly
    const active = /** @type {HTMLElement | null} */ (document.activeElement)
    const lostCard =
      active && active !== document.body
        ? active.closest?.("[data-ai-results]") && active.getAttribute("data-couch-key")
        : null
    void tick().then(() => {
      // The toggle button itself survives the re-render, so focus on
      // it is untouched. Only a filtered-out card needs recovery.
      if (lostCard && (document.activeElement === document.body || !document.activeElement)) {
        document.querySelector("[data-available-toggle]")?.focus({ preventScroll: true })
      }
    })
  }

  /** New Search: clear EVERYTHING, including the conversation. */
  function newSearch() {
    cancelQueryTimer()
    if (aiAbort) aiAbort.abort()
    searchToken++
    const fresh = applyNewSearch()
    query = fresh.query
    queryDebounced = ""
    // Conversation + toggle are NOT part of DiscoverySearchState
    // (W4): the view clears them alongside, explicitly.
    conversation = newConversation()
    availableOnly = false
    activeMood = fresh.activeMood
    searchResults = null
    aiResults = null
    resultsSource = null
    receipt = null
    aiUnavailable = null
    localSimilar = null
    aiPhase = null
    searching = false
    searchingAi = false
    flow = freshDiscoverFlow()
    shownIds = new Set()
    currentPick = 0
    watchLaterSaved = false
    flowNotice = ""
    closeDiagnostics()
    window.scrollTo(0, 0)
    inputEl?.focus()
  }

  function focusFirstResult() {
    // Dismiss the on-screen keyboard FIRST: it is in-flow (~588px),
    // so focusing while it is still mounted scrolls against a layout
    // that collapses a frame later — the scroll anchoring then leaves
    // the quick-pick row half-under the sticky nav (0.11.5 seam 6).
    // The dismiss flushes before the rAF below runs, so the scroll
    // and focus below measure the settled layout.
    if (keyboard.dismiss()) {
      endCouchKeyboardSession()
      syncKeyboard()
    }
    requestAnimationFrame(() => {
      // Scroll the FIRST RESULT CARD into view (nearest), not the
      // rail and not the Ask AI button: the rail is taller than the
      // remaining viewport, so scrolling it to the top clamps at max
      // scroll with the quick picks still half-under the nav — and
      // centring the button does the same. The card is what the user
      // came for; nearest lands the rail in view with the quick picks
      // fully visible above it. Then focus the first focusable
      // without scrolling.
      document
        .querySelector("[data-discover-results] .rs-discover-card")
        ?.scrollIntoView({ block: "nearest" })
      document
        .querySelector("[data-discover-results] [data-nylah-item], [data-discover-rows] [data-nylah-item]")
        ?.focus({ preventScroll: true })
    })
  }

  /** Focus the first AI recommendation card, with the same
      keyboard-dismiss-first + nearest-scroll discipline as
      focusFirstResult (0.11.5 seam 6): the quick-pick row must sit
      fully below the sticky nav after a search submit. The toggle and
      other controls stay reachable by navigating up from the cards. */
  function focusFirstAiResult() {
    if (keyboard.dismiss()) syncKeyboard()
    requestAnimationFrame(() => {
      document
        .querySelector("[data-reveal] [data-reveal-watch]")
        ?.scrollIntoView({ block: "nearest" })
      document
        .querySelector("[data-reveal] [data-reveal-watch]")
        ?.focus({ preventScroll: true })
    })
  }

  /**
   * Submit the search box.
   * - An AI rail is showing and the user typed a follow-up: a
   *   refinement submit — the orchestrator runs with the conversation.
   * - Otherwise, with automatic requests on and AI runnable: a fresh
   *   AI request. In Manual mode, or when AI cannot run: a local
   *   search, with Ask AI offered at the results.
   */
  function submitSearch() {
    cancelQueryTimer()
    // Step 3 submit: the typed brief (or an empty brief, when the
    // user skips typing) is the request. The flow state carries the
    // kind + draws; runAiSearch builds the one natural-language ask
    // from them. A refinement keeps the conversation, so a follow-up
    // brief refines the picks on screen instead of starting over.
    flow = setDiscoverBrief(flow, query)
    queryDebounced = choicesSummary(flow) || query.trim()
    activeMood = null
    void runAiSearch()
  }

  /** Explicit "Ask AI" — one paid request, on the user's tap. */
  function askAi() {
    cancelQueryTimer()
    // A quick pick is a preset, not a question: ask AI about the pick
    // itself (its label is the question — "Easy Watching", "Hidden
    // Gems") and clear the mood so the AI run asks it. For a typed
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
    aiQueryOverride = query
    void runAiSearch()
  }

  function pickExample(prompt) {
    cancelQueryTimer()
    // An example prompt is a NEW question: fresh conversation, no
    // carried context — even when refining. When AI cannot run, it
    // searches locally instead of firing a doomed request.
    query = prompt
    queryDebounced = prompt
    activeMood = null
    conversation = newConversation()
    aiQueryOverride = prompt
    if (canAskAi) {
      void runAiSearch()
    } else {
      void runSearch()
      focusFirstResult()
    }
  }

  function pickMood(presetId) {
    // A quick pick starts a NEW discovery request (applyQuickPick):
    // no carried query, conversation or filters. Tapping the active
    // pick again clears everything back to the landing state.
    // Cancelling the debounce timer FIRST is what keeps a pick made
    // within 250ms of typing from being undone by the stale timer.
    cancelQueryTimer()
    if (activeMood === presetId) {
      const fresh = applyNewSearch()
      query = fresh.query
      activeMood = fresh.activeMood
      conversation = newConversation()
      availableOnly = false
      queryDebounced = ""
      searchResults = null
      aiResults = null
      resultsSource = null
      receipt = null
      aiUnavailable = null
      localSimilar = null
      closeDiagnostics()
      return
    }
    // Discover holds no genre state of its own (no genre control on
    // this screen), so the transition input carries genre: null;
    // applyQuickPick returns a fresh state with only the new mood.
    // Conversation + toggle are cleared alongside (see newSearch).
    const next = applyQuickPick({ query, activeMood, genre: null }, presetId)
    query = next.query
    activeMood = next.activeMood
    conversation = newConversation()
    availableOnly = false
    queryDebounced = ""
    void runSearch()
  }

  /** Short subtitle for a quick-pick card, derived only from the
      preset's own fields (genres / rating floor / runtime cap) — never
      invented. */
  function moodSubtitle(preset) {
    if (preset.tagline) return preset.tagline
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

  // -- Guided flow actions (0.11.18) --------------------------------
  /** Step 1: pick a kind, move to step 2, send a pulse to the core. */
  function pickKind(kind) {
    flow = selectDiscoverKind(flow, kind)
    pulseNeural()
    void tick().then(() => {
      document
        .querySelector("[data-nav-region=\"flow-categories\"] [data-nylah-item]")
        ?.focus({ preventScroll: true })
    })
  }

  /** Step 2: toggle one draw tile (multi-select, never clears others). */
  function toggleCategory(categoryId) {
    flow = toggleDiscoverCategory(flow, categoryId)
    pulseNeural()
  }

  /** Step 2 "Surprise me": clear the draws and move to step 3. */
  function surpriseMe() {
    flow = surpriseDiscoverCategories(flow)
    query = flow.brief
    void tick().then(() => inputEl?.focus({ preventScroll: true }))
  }

  /** Step 2 Continue: move to step 3 with the draws intact. */
  function goToBrief() {
    flow = continueToBrief(flow)
    query = flow.brief
    void tick().then(() => inputEl?.focus({ preventScroll: true }))
  }

  /** Step 3 "Skip this step": ask with no brief at all. */
  function skipBrief() {
    cancelQueryTimer()
    flow = setDiscoverBrief(flow, "")
    query = ""
    queryDebounced = choicesSummary(flow)
    activeMood = null
    void runAiSearch()
  }

  /**
   * Refine (hard rule): back to step 3 with the ORIGINAL kind,
   * categories and brief intact — "closer, but darker" without
   * starting over. The conversation is kept, so the next submit is
   * a refinement of the picks on screen.
   */
  function refineFlow() {
    flow = refineFlowState(flow)
    query = flow.brief
    flowNotice = ""
    void tick().then(() => inputEl?.focus({ preventScroll: true }))
  }

  /**
   * Next pick: immediate, from the queue already on screen — no
   * model call, and never a repeat within the session. Skipping
   * records nothing: no dislike is stored anywhere.
   */
  function nextPick() {
    const { rec, shownIds: nextShown } = pickNextRecommendation(visibleAiResults, shownIds)
    if (rec) {
      shownIds = nextShown
      currentPick = visibleAiResults.indexOf(rec)
      watchLaterSaved = false
      void tick().then(() => focusFirstAiResult())
      return
    }
    // Queue exhausted: one fresh request, with the shown titles
    // excluded from the new ask. If that comes back empty too, the
    // run says so honestly on step 3.
    flowNotice = ""
    void runAiSearch()
  }

  /** Catalogue key of the current pick, split for preferences.js. */
  function currentMatchParts() {
    const key = currentRec?.match?.catalogueKey
    if (!key) return null
    const colon = key.indexOf(":")
    if (colon <= 0 || colon === key.length - 1) return null
    const kind = key.slice(0, colon)
    if (kind !== "movie" && kind !== "series") return null
    return { prefKind: kind === "movie" ? "vod" : "series", id: key.slice(colon + 1) }
  }

  /** Whether the current pick is already on the Watch Later list. */
  function isCurrentWatchLater() {
    if (watchLaterSaved) return true
    const parts = currentMatchParts()
    if (!parts || !playlistId) return false
    return isOnWatchlist(playlistId, parts.prefKind, parts.id)
  }

  /** Watch Later: the existing preferences.js watchlist, toggled for
      the current pick. Never starts playback, never leaves Discover. */
  function toggleCurrentWatchLater() {
    const parts = currentMatchParts()
    if (!parts || !playlistId || !currentRec) return
    watchLaterSaved = toggleWatchlist(playlistId, parts.prefKind, parts.id, {
      name: currentRec.title,
      logo: currentRec.posterUrl ?? null,
    })
  }

  /**
   * Explicit on-screen keyboard: the ONLY path that opens the OSK
   * in the redesign (button tap or ArrowDown). Focus never opens it.
   */
  function openBriefKeyboard() {
    keyboard.onInputFocus()
    syncKeyboard()
    if (keyboard.open && inputEl) {
      openCouchKeyboard(inputEl, onKeyboardCommit, { focusGrid: false })
    }
  }

  /** Focus the current step's primary control (Back "focus" step). */
  function focusFlowStep() {
    if (flow.step === "brief") {
      inputEl?.focus()
      return
    }
    if (flow.step === "reveal") {
      document
        .querySelector("[data-reveal] [data-reveal-watch]")
        ?.focus({ preventScroll: true })
      return
    }
    document
      .querySelector(`[data-nav-region="flow-${flow.step}"] [data-nylah-item]`)
      ?.focus({ preventScroll: true })
  }

  // -- Neural background (one continuous space) ----------------------
  /** One drifting-neuron frame: filaments, core glow, travelling pulses. */
  function drawNeural() {
    const canvas = neuralCanvas
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const cx = canvas.width * 0.5
    const cy = canvas.height * 0.32
    for (let i = 0; i < neuralNodes.length; i++) {
      for (let j = i + 1; j < neuralNodes.length; j++) {
        const a = neuralNodes[i]
        const b = neuralNodes[j]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d < 150) {
          ctx.strokeStyle = `rgba(80, 160, 255, ${0.16 * (1 - d / 150)})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
    }
    for (const p of neuralPulses) {
      const x = p.x + (cx - p.x) * p.t
      const y = p.y + (cy - p.y) * p.t
      ctx.fillStyle = "rgba(205, 255, 255, 0.9)"
      ctx.beginPath()
      ctx.arc(x, y, 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
    neuralPulses = neuralPulses.filter((p) => p.t < 1)
    for (const n of neuralNodes) {
      ctx.fillStyle = "rgba(140, 200, 255, 0.85)"
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      ctx.fill()
    }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 130)
    g.addColorStop(0, "rgba(13, 140, 253, 0.28)")
    g.addColorStop(1, "rgba(13, 140, 253, 0)")
    ctx.fillStyle = g
    ctx.fillRect(cx - 130, cy - 130, 260, 260)
  }

  /** Start the neural drift (one static frame when reduced motion). */
  function startNeuralCanvas() {
    const canvas = neuralCanvas
    if (!canvas) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width))
      canvas.height = Math.max(1, Math.floor(rect.height))
      const count = Math.floor((canvas.width * canvas.height) / 26000)
      neuralNodes = Array.from(
        { length: Math.min(64, Math.max(24, count)) },
        () => ({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
          r: 1 + Math.random() * 2.2,
        }),
      )
    }
    neuralCanvasResize = resize
    resize()
    drawNeural()
    if (reduced) return
    const frame = () => {
      for (const n of neuralNodes) {
        n.x += n.vx
        n.y += n.vy
        if (n.x < 0 || n.x > canvas.width) n.vx *= -1
        if (n.y < 0 || n.y > canvas.height) n.vy *= -1
      }
      if (Math.random() < 0.02 && neuralNodes.length) {
        const n = neuralNodes[Math.floor(Math.random() * neuralNodes.length)]
        neuralPulses.push({ x: n.x, y: n.y, t: 0 })
      }
      for (const p of neuralPulses) p.t += 0.006
      drawNeural()
      neuralRaf = requestAnimationFrame(frame)
    }
    neuralRaf = requestAnimationFrame(frame)
    window.addEventListener("resize", resize)
  }

  function stopNeuralCanvas() {
    if (neuralRaf) cancelAnimationFrame(neuralRaf)
    neuralRaf = 0
    if (neuralCanvasResize) window.removeEventListener("resize", neuralCanvasResize)
    neuralCanvasResize = null
  }

  /** A selection sends one pulse from a random neuron toward the core. */
  function pulseNeural() {
    if (!neuralNodes.length) return
    const n = neuralNodes[Math.floor(Math.random() * neuralNodes.length)]
    neuralPulses.push({ x: n.x, y: n.y, t: 0 })
  }

  function clearSearch() {
    cancelQueryTimer()
    if (aiAbort) aiAbort.abort()
    searchToken++
    query = ""
    queryDebounced = ""
    activeMood = null
    searchResults = null
    aiResults = null
    resultsSource = null
    receipt = null
    conversation = newConversation()
    availableOnly = false
    aiUnavailable = null
    localSimilar = null
    aiPhase = null
    searching = false
    searchingAi = false
    flow = freshDiscoverFlow()
    shownIds = new Set()
    currentPick = 0
    watchLaterSaved = false
    flowNotice = ""
    closeDiagnostics()
    inputEl?.focus()
  }

  /**
   * Close diagnostics from any path (toggle, Back step, New Search,
   * root reset): release the hints override (§8 — a stale "Close
   * diagnostics" legend must never outlive the panel) and, when the
   * close came from a Back step, return focus to the toggle (§7.3).
   */
  function closeDiagnostics(refocusToggle = false) {
    if (!diagnosticsOpen) return
    diagnosticsOpen = false
    setControllerHints(null)
    if (refocusToggle) {
      void tick().then(() => {
        document
          .querySelector("[data-ai-diagnostics] .rs-discover-diag__toggle")
          ?.focus({ preventScroll: true })
      })
    }
  }

  /**
   * Back-to-root (§25 step 4): reset the RESULTS VIEW only. The
   * refinement conversation is deliberately preserved — only the
   * explicit New Search button clears it — and the "Available in My
   * Library" filter is untouched. Never sends an AI request:
   * cancellation only (debounce timer, abort, token bump). Focus
   * returns to the search control, the Discover root state.
   */
  function backToDiscoverRoot() {
    cancelQueryTimer()
    if (aiAbort) aiAbort.abort()
    searchToken++
    // One Back step in the flow: reveal -> brief (the picks and the
    // refinement conversation are kept, so Refine can continue),
    // brief -> categories, categories -> kind. Only leaving the
    // first step's root clears the results. Never sends an AI
    // request: cancellation only (debounce timer, abort, token bump).
    const leavingFlow = flow.step === "kind"
    flow = stepBackFlow(flow)
    if (leavingFlow) {
      query = ""
      queryDebounced = ""
      activeMood = null
      searchResults = null
      aiResults = null
      resultsSource = null
      receipt = null
      aiUnavailable = null
      localSimilar = null
      aiPhase = null
      searching = false
      searchingAi = false
    }
    closeDiagnostics()
    window.scrollTo(0, 0)
    focusFlowStep()
  }

  /**
   * One Back step (§25), shared by the Escape handler, the
   * body-focused Escape listener, and the Back layer (Android BACK)
   * — the 0.11.9 Escape/Android divergence is gone: both paths run
   * this one function. Order: close diagnostics -> close keyboard ->
   * focus back to the search control (state untouched — a focus move
   * never discards the refinement conversation) -> results view back
   * to the root state -> leave via provenance. Always performs
   * exactly one step and returns true. Never triggers an AI request
   * and never submits a prompt.
   */
  function discoverBackStep() {
    const active = /** @type {HTMLElement | null} */ (document.activeElement)
    const step = nextDiscoverBackStep({
      diagnosticsOpen,
      keyboardOpen: keyboard.open,
      focusInResults:
        !!active?.closest?.("[data-discover-flow]") && active !== inputEl,
      hasResultsView:
        flow.step !== "kind" ||
        aiResults !== null ||
        searchResults !== null ||
        query.trim() !== "" ||
        queryDebounced.trim() !== "" ||
        activeMood !== null ||
        localSimilar !== null,
    })
    if (step === "close-diagnostics") {
      closeDiagnostics(true)
      return true
    }
    if (step === "close-keyboard") {
      if (isCouchKeyboardOpen()) closeCouchKeyboard(false)
      else {
        keyboard.dismissToInput()
        syncKeyboard()
        inputEl?.focus()
      }
      return true
    }
    if (step === "focus-search") {
      focusFlowStep()
      return true
    }
    if (step === "root-state") {
      backToDiscoverRoot()
      return true
    }
    navigateBackWithOrigin("/")
    return true
  }

  /**
   * B / Escape back steps (gamepad B dispatches Escape outside Live
   * TV; Android BACK goes through the registered Back layer, which
   * runs the same discoverBackStep). The input's own Escape handler
   * runs first for the on-screen keyboard and stops propagation when
   * it dismisses it; the key-grid handler stops its own Escape.
   */
  function onDiscoverKeyDown(ev) {
    if (ev.key !== "Escape") return
    ev.preventDefault()
    ev.stopPropagation()
    discoverBackStep()
  }

  /** Diagnostics toggle, with controller hints for the open state.
      Closing releases the override (§8) — the toggle button itself
      keeps focus, so no refocus is needed on this path. */
  function toggleDiagnostics() {
    if (diagnosticsOpen) {
      closeDiagnostics()
      return
    }
    diagnosticsOpen = true
    setControllerHints({
      id: "discover-diagnostics",
      items: [
        { glyph: "b", label: "Close diagnostics" },
        { glyph: "menu", label: "Settings" },
        { glyph: "view-menu", label: "Return home" },
      ],
    })
  }

  function dismissOnboarding() {
    dismissAiOnboarding()
    showOnboarding = false
  }

  async function refreshAiStatus() {
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
    setLogicalView("discover")
    startNeuralCanvas()
    // Region owner (§7.3): search -> examples -> quick picks ->
    // results, column-preserving, no rail hijack (kind "mixed"
    // via setLogicalView above). Unregistered on unmount.
    const unregisterNavOwner = rootEl
      ? registerNavigationOwner({
          id: "discover",
          kind: "mixed",
          root: () => rootEl,
          isActive: () => rootEl?.isConnected ?? false,
          handleDirection: createRegionDirectionHandler(rootEl),
          sectionEntry: regionSectionEntry(rootEl),
        })
      : () => {}
    // Origin for Back (Contract B): the screen that launched Discover.
    recordOriginFromReferrer(window.location.pathname)
    // Back layer (Contract A): Android BACK runs the SAME single step
    // as Escape on Windows (discoverBackStep) — the 0.11.9 divergence
    // (Escape only refocused, Android cleared everything) is gone.
    // The keyboard layer (priority 80) wins while it is open.
    const unregisterBack = registerBackLayer({
      id: "discover-page",
      priority: BACK_PRIORITY.PAGE_STATE,
      isActive: () => true,
      handle: () => discoverBackStep(),
    })
    // Body-focused Escape = the gamepad B-blur trailing Escape: the
    // root handler never sees body-targeted keys, so this capture
    // listener routes them through the same single step. It stays
    // out of the way whenever focus is inside the view.
    function onWindowKeyDown(ev) {
      if (ev.key !== "Escape") return
      if (document.activeElement && document.activeElement !== document.body) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      discoverBackStep()
    }
    window.addEventListener("keydown", onWindowKeyDown, true)
    // Shared keyboard lifecycle: a close (B in the grid, Back layer)
    // arrives as an event on this input — hide the lifecycle keyboard
    // and return focus to the input.
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
    // Discover's OWN search (§25): Y on Discover focuses this input
    // instead of opening global Search. The Y handler below routes
    // the key here via this event; the input focus opens the keyboard.
    function onDiscoverFocusSearch() {
      inputEl?.focus()
    }
    window.addEventListener("couch:discover-focus-search", onDiscoverFocusSearch)
    // Y wiring (0.11.10 integration): the gamepad layer dispatches
    // the "y" key first and only falls back to global Search when
    // no handler claims it — this handler claims it on Discover
    // (outside editable fields, where "y" must type) and routes it
    // through the focus-search event above. Without this, Y on
    // Discover navigated away to /search.
    function onDiscoverYKey(ev) {
      if (ev.key !== "y" && ev.key !== "Y") return
      if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.defaultPrevented) return
      const target = /** @type {HTMLElement | null} */ (ev.target)
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      if (document.querySelector("dialog[open]")) return
      ev.preventDefault()
      ev.stopPropagation()
      window.dispatchEvent(new CustomEvent("couch:discover-focus-search"))
    }
    document.addEventListener("keydown", onDiscoverYKey)
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
      stopNeuralCanvas()
      clearInterval(clock)
      unregisterNavOwner()
      // Leaving with diagnostics open must not strand its legend.
      setControllerHints(null)
      unregisterBack()
      window.removeEventListener("keydown", onWindowKeyDown, true)
      window.removeEventListener(COUCH_KEYBOARD_CLOSED_EVENT, onKeyboardClosed)
      window.removeEventListener("couch:discover-focus-search", onDiscoverFocusSearch)
      document.removeEventListener("keydown", onDiscoverYKey)
      // Leaving Discover cancels any in-flight AI run.
      if (aiAbort) aiAbort.abort()
      document.removeEventListener("xt:ai-settings-changed", refreshAiStatus)
    }
  })

  $effect(() => {
    void rows
    void searchResults
    void aiResults
    void localSimilar
    void loading
    armTvImageFallbacks(document)
    void tick().then(() => restoreCouchFocus())
  })

  // Controller hints follow the flow step (diagnostics keeps its own
  // override while open — this effect never touches it then).
  $effect(() => {
    const step = flow.step
    if (diagnosticsOpen) return
    if (step === "kind") {
      setControllerHints({
        id: "discover-kind",
        items: [
          { glyph: "dpad", label: "Move" },
          { glyph: "a", label: "Select" },
          { glyph: "b", label: "Back" },
        ],
      })
    } else if (step === "categories") {
      setControllerHints({
        id: "discover-categories",
        items: [
          { glyph: "dpad", label: "Move" },
          { glyph: "a", label: "Select / deselect" },
          { glyph: "b", label: "Back" },
        ],
      })
    } else if (step === "brief") {
      setControllerHints({
        id: "discover-brief",
        items: [
          { glyph: "a", label: "Continue" },
          { glyph: "b", label: "Back" },
        ],
      })
    } else if (step === "reveal") {
      setControllerHints({
        id: "discover-reveal",
        items: [
          { glyph: "a", label: "Watch" },
          { glyph: "b", label: "Back" },
        ],
      })
    }
  })
</script>

<div class="rs-discover" data-discover-root bind:this={rootEl} onkeydown={onDiscoverKeyDown}>
  <!-- Hero: Discover is a destination, with its purpose and its AI
       mode stated up front. -->
  <!-- Guided three-step flow (0.11.18 redesign): one continuous
       neural space — the canvas behind this root drifts neurons and
       sends pulses toward the core; each step is a deeper move in,
       not a new page. The top navigation lives in CouchLayout and
       is untouched. -->
  <canvas class="rs-neural-canvas" bind:this={neuralCanvas} aria-hidden="true"></canvas>

  <div class="rs-discover__top">
    <p class="rs-discover__eyebrow">Discover</p>
    <div class="rs-discover__steps" aria-label="Step {flowStepNumber} of 3">
      {#each [1, 2, 3] as n (n)}
        <span class="rs-step-dot" class:is-filled={n <= flowStepNumber} aria-hidden="true"></span>
      {/each}
      <span class="rs-step-text">0{flowStepNumber} / 03</span>
    </div>
  </div>

  <!-- First-run onboarding (AI01): a polished invitation, never a
       block — "Not Now" dismisses it for good. -->
  {#if showOnboarding}
    <section class="rs-discover-onboard" aria-label="Unlock AI Discovery" data-ai-onboarding>
      <div class="rs-discover-onboard__text">
        <h2>Unlock AI Discovery</h2>
        <p>
          Describe the night you're in the mood for — "something funny
          for tonight" — and AI suggests titles from its own knowledge,
          verifies each one against TMDB, explains each choice, and
          shows which ones are in your library. Your watch history
          stays on this device unless you choose to share it, and AI
          is billed separately by your provider.
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
  {:else}
    <div data-discover-flow class="rs-flow">
      {#if flow.step === "kind"}
        <!-- Step 1 — "What are we watching?" -->
        <section class="rs-flow-step rs-flow-step--kind" data-nav-region="flow-kind" aria-label="What are we watching?">
          <div class="rs-brain rs-brain--step1" aria-hidden="true">
            <img class="rs-brain__img" src="/art/discover/brain-step1.png" alt="" onerror={(e) => { e.currentTarget.style.display = "none" }} />
          </div>
          <h1 class="rs-flow-title">What are we watching?</h1>
          <p class="rs-flow-sub">Let&rsquo;s find what you&rsquo;re in the mood for.</p>
          <div class="rs-kind-grid" role="group" aria-label="What are we watching?">
            {#each KIND_CARDS as card (card.id)}
              <button
                type="button"
                onclick={() => pickKind(card.id)}
                data-nylah-item
                class="rs-kind-card">
                <img class="rs-kind-card__art" src={card.art} alt="" onerror={(e) => { e.currentTarget.style.display = "none" }} />
                <span class="rs-kind-card__label">{card.label}</span>
                <span class="rs-kind-card__sub">{card.subtitle}</span>
                {#if card.id === "either"}
                  <!-- Mockup: the (A) badge sits bottom-right of the
                       Either card (Ø36px, centre ≈ (1529, 750)). -->
                  <span class="rs-kind-card__badge" aria-hidden="true">A</span>
                {/if}
              </button>
            {/each}
          </div>
          <p class="rs-flow-hints" aria-hidden="true">
            <span class="rs-hint-glyph">D-pad</span> Move
            <span class="rs-hint-glyph">A</span> Select
            <span class="rs-hint-glyph">B</span> Back
          </p>
          <p class="rs-flow-foot">Discover concept · Step 1 of 3</p>
        </section>
      {:else if flow.step === "categories"}
        <!-- Step 2 — "What are you drawn to?" -->
        <section class="rs-flow-step rs-flow-step--categories" data-nav-region="flow-categories" aria-label="What are you drawn to?">
          <div class="rs-brain rs-brain--step2" aria-hidden="true">
            <img class="rs-brain__img" src="/art/discover/brain-step2.png" alt="" onerror={(e) => { e.currentTarget.style.display = "none" }} />
          </div>
          <h1 class="rs-flow-title rs-flow-title--left">What are you drawn to?</h1>
          <p class="rs-flow-sub rs-flow-sub--left">Choose one or more.</p>
          <div class="rs-discover__mood-grid" role="group" aria-label="Genres you are drawn to">
            {#each GENRE_CATEGORIES as genre (genre.id)}
              <button
                type="button"
                onclick={() => toggleCategory(genre.id)}
                aria-pressed={flow.categories.includes(genre.id)}
                data-nylah-item
                class="rs-discover-mood"
                class:is-active={flow.categories.includes(genre.id)}>
                <img class="rs-discover-mood__art" src={genre.art} alt="" onerror={(e) => { e.currentTarget.style.display = "none" }} />
                {#if flow.categories.includes(genre.id)}
                  <span class="rs-discover-mood__check" aria-hidden="true">✓</span>
                {/if}
                <span class="rs-discover-mood__label">{genre.label}</span>
                <span class="rs-discover-mood__sub">{moodSubtitle(genre)}</span>
              </button>
            {/each}
          </div>
          <div class="rs-flow-foot-row">
            <p class="rs-flow-selected">{selectedLine}</p>
            <button type="button" onclick={surpriseMe} data-nylah-item class="rs-flow-link">Surprise me</button>
            <button type="button" onclick={goToBrief} data-nylah-item class="rs-flow-primary rs-flow-primary--continue">Continue <span aria-hidden="true">→</span></button>
          </div>
          <p class="rs-flow-hints" aria-hidden="true">
            <span class="rs-hint-glyph">D-pad</span> Move
            <span class="rs-hint-glyph">A</span> Select / deselect
            <span class="rs-hint-glyph">B</span> Back
          </p>
          <p class="rs-flow-foot">Discover concept · Step 2 of 3</p>
        </section>
      {:else if flow.step === "brief"}
        <!-- Step 3 — "Tell me what you really want." -->
        <section class="rs-flow-step rs-flow-step--brief" data-nav-region="flow-brief" aria-label="Tell me what you really want">
          <div class="rs-brain rs-brain--step3" aria-hidden="true">
            <img class="rs-brain__img" src="/art/discover/brain-step3.png" alt="" onerror={(e) => { e.currentTarget.style.display = "none" }} />
          </div>
          <h1 class="rs-flow-title rs-flow-title--left">Tell me what you<br />really want.</h1>
          <p class="rs-flow-sub rs-flow-sub--left">Anything to seek out, avoid, or already seen?</p>
          {#if choicesLine}
            <p class="rs-flow-choices">Your choices: {choicesLine}</p>
          {/if}
          <form
            class="rs-flow-brief-form"
            onsubmit={(e) => {
              e.preventDefault()
              submitSearch()
            }}>
            <div class="rs-discover__keyboard-scope" data-nav-region="brief-input" onfocusout={onKeyboardScopeFocusOut}>
              <label for="discover-query" class="rs-flow-brief-label">
                Anything else I should know?
                <span class="rs-flow-brief-optional">Optional</span>
              </label>
              <!-- Real textarea: physical keyboard / chatpad typing
                   works natively. The on-screen keyboard NEVER opens
                   on focus — only the explicit button below (or
                   ArrowDown) opens it. -->
              <textarea
                id="discover-query"
                bind:this={inputEl}
                bind:value={query}
                oninput={(e) => onQueryInput(e.currentTarget.value)}
                onfocus={onSearchInputFocus}
                onclick={onSearchInputFocus}
                onkeydown={onSearchInputKeyDown}
                placeholder="Your mood, your limits, your reference films. Anything goes."
                rows="3"
                class="rs-flow-brief-input"></textarea>
              <TvKeyboard
                bind:value={query}
                open={keyboardOpen}
                onInput={onOskInput}
                onCommit={onKeyboardCommit}
                onDismiss={dismissKeyboardToInput}
                placeholder={searchPlaceholder} />
            </div>
            <p class="rs-flow-hint">Your mood, your limits, your reference films. Anything goes.</p>
            <div class="rs-flow-actions">
              <button type="submit" data-nylah-item class="rs-flow-primary rs-flow-primary--find">
                <span class="rs-hint-glyph" aria-hidden="true">A</span>
                Find my next watch <span aria-hidden="true">→</span>
              </button>
              <button type="button" onclick={skipBrief} data-nylah-item class="rs-flow-link">Skip this step</button>
              <button type="button" onclick={openBriefKeyboard} data-nylah-item class="rs-flow-link">On-screen keyboard</button>
            </div>
          </form>
          {#if flowNotice}
            <p class="rs-flow-notice" role="status">{flowNotice}</p>
          {/if}
          {#if !canAskAi}
            <!-- Honest no-key state: AI is not configured on this
                 device, so no model call is made and nothing pretends
                 it answered. Settings fixes it; the local catalogue
                 fallback is offered instead. -->
            <div class="rs-ai-panel" role="status" data-ai-not-configured>
              <p class="rs-ai-panel__text">{askAiWhy}</p>
              <p class="rs-ai-panel__text">AI picks need a key — or browse your library locally instead.</p>
              <div class="rs-ai-panel__actions">
                <a href="/settings/discover-ai#card-ai-discovery" data-nylah-item class="rs-ai-panel__primary">Open AI settings</a>
                <button type="button" onclick={searchLocalSimilar} data-nylah-item class="rs-ai-panel__secondary">
                  Browse similar titles in my library
                </button>
              </div>
            </div>
          {/if}
          <div class="rs-discover-mode-row">
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
          <p class="rs-flow-hints" aria-hidden="true">
            <span class="rs-hint-glyph">A</span> Continue
            <span class="rs-hint-glyph">B</span> Back
          </p>
          <p class="rs-flow-foot">Discover concept · Step 3 of 3</p>
        </section>
      {:else if flow.step === "loading"}
        <!-- Finding: one honest progress line from the orchestrator. -->
        <section class="rs-flow-step rs-flow-step--loading" data-nav-region="flow-loading" aria-label="Finding your next watch">
          <div class="rs-brain rs-brain--step3" aria-hidden="true">
            <img class="rs-brain__img" src="/art/discover/brain-step3.png" alt="" onerror={(e) => { e.currentTarget.style.display = "none" }} />
          </div>
          <h1 class="rs-flow-title">Finding your next watch…</h1>
          <p class="rs-meta rs-flow-loading-note" aria-live="polite" data-ai-phase>{aiStatusText} One request for this question.</p>
          {#if choicesLine}
            <p class="rs-flow-choices">{choicesLine}</p>
          {/if}
          <p class="rs-flow-foot">Discover concept · Step 3 of 3</p>
        </section>
      {:else if flow.step === "reveal"}
        <!-- Reveal: ONE playable recommendation at a time — cinematic
             art, the facts, and why it fits. Watch links to the
             detail page, which owns playback. -->
        <section class="rs-flow-step rs-flow-step--reveal" data-nav-region="flow-reveal" data-reveal aria-label="Your next watch">
          {#if aiUnavailable}
            <div class="rs-ai-panel" role="status" data-ai-unavailable>
              <p class="rs-ai-panel__text">{aiUnavailable.message}</p>
              <div class="rs-ai-panel__actions">
                <button type="button" onclick={searchLocalSimilar} data-nylah-item class="rs-ai-panel__primary">
                  Search for similar titles available locally
                </button>
                <button type="button" onclick={() => void runAiSearch()} data-nylah-item class="rs-ai-panel__secondary">
                  Try again
                </button>
              </div>
            </div>
          {:else if currentRec}
            <div class="rs-ai-grid" data-ai-results>
              {#each visibleAiResults as rec, aiIndex (rec.verified ? `tmdb:${rec.tmdbId}` : `gen:${aiIndex}:${rec.generated.title}:${rec.generated.kind}:${rec.generated.year ?? ""}`)}
                {#if aiIndex === currentPick}
                  {@render aiRecommendationCard(rec, aiIndex)}
                {/if}
              {/each}
            </div>
            <div class="rs-reveal-actions" data-nav-region="reveal-actions">
              {#if currentHref}
                <a href={currentHref} data-nylah-item data-reveal-watch class="rs-flow-primary rs-flow-primary--watch">Watch</a>
              {/if}
              <button type="button" onclick={nextPick} data-nylah-item class="rs-flow-secondary">Next pick</button>
              <button type="button" onclick={toggleCurrentWatchLater} data-nylah-item class="rs-flow-secondary">
                {isCurrentWatchLater() ? "Saved to Watch Later ✓" : "Watch Later"}
              </button>
              <button type="button" onclick={refineFlow} data-nylah-item class="rs-flow-secondary">Refine what I&rsquo;m looking for</button>
            </div>
            <p class="rs-meta rs-reveal-count">
              {railTitle} — pick {currentPick + 1} of {visibleAiResults.length} · {matchedAiCount} matched in your library{#if allAiVerified} · all verified by TMDB{/if}
              {#if refineLabel} · {refineLabel}{/if}
            </p>
            <button type="button" onclick={askAi} data-nylah-item class="rs-discover-ask-ai">
              Ask AI about “{askAiLabel}”
            </button>
            <button type="button" onclick={newSearch} data-nylah-item class="rs-flow-link">Start over</button>
          {:else if !searching}
            <div class="rs-ai-panel" role="status" data-ai-empty>
              <h3 class="rs-ai-panel__title">AI couldn&rsquo;t suggest anything in your library for that</h3>
              <p class="rs-ai-panel__text">
                Try different draws, or a different brief — or search for similar titles available in your library.
              </p>
              <div class="rs-ai-panel__actions">
                <button type="button" onclick={searchLocalSimilar} data-nylah-item class="rs-ai-panel__primary">
                  Search for similar titles available locally
                </button>
                <button type="button" onclick={refineFlow} data-nylah-item class="rs-ai-panel__secondary">
                  Refine what I&rsquo;m looking for
                </button>
              </div>
            </div>
          {/if}
          {#if !searching && stateNote && !aiUnavailable}
            <p class="rs-meta" data-ai-state-note>{stateNote}</p>
          {/if}
          <p class="rs-flow-foot">Discover concept · Step 3 of 3</p>
        </section>
      {/if}
    </div>

    {#if localSimilar}
      <!-- Local similar titles: explicitly labelled local search,
           never masquerading as LLM recommendations. -->
      <div class="rs-ai-similar" data-local-similar>
        <h3 class="rs-section-title">Similar titles in your library</h3>
        <p class="rs-meta" data-local-note>Local results so far — Quick picks are filtered locally, so these are local matches for your choices, not AI recommendations.</p>
        {#if localSimilar.items.length}
          <div class="rs-rail__row">
            {#each localSimilar.items as item (candidateKey(item.candidate))}
              {@render discoverCard(item)}
            {/each}
          </div>
        {:else}
          <p class="rs-meta">No similar titles in your library either — try a different question.</p>
        {/if}
      </div>
    {/if}

    {#if receipt}
      <!-- Diagnostics (0.11.5/0.11.6): collapsible, off the main
           path, one toggle reachable by controller. Shows what
           actually produced this rail — engine, state, model, query
           type, counts (generated / verified / matched / failures),
           cache, duration, provider error, fallback reason. Fields
           the orchestrator does not report yet read "Not reported
           yet". Never any API key, credential or request text. -->
      <section class="rs-discover-diag" data-ai-diagnostics aria-label="Why these results">
        <button
          type="button"
          onclick={toggleDiagnostics}
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
            <div><dt>Suggestions generated</dt><dd data-diag-generated>{diagCount(receipt.diagnostics.generatedCount)}</dd></div>
            <div><dt>Verified by TMDB</dt><dd data-diag-verified>{diagCount(receipt.diagnostics.verifiedCount)}</dd></div>
            <div><dt>Matched in library</dt><dd data-diag-matched>{diagCount(receipt.diagnostics.matchedCount)}</dd></div>
            <div><dt>Verification failures</dt><dd data-diag-verification-failures>{diagCount(receipt.diagnostics.verificationFailures)}</dd></div>
            <div><dt>Retrieved candidates</dt><dd data-diag-retrieved>{diagCount(receipt.diagnostics.retrievedCount)}</dd></div>
            <div><dt>Sent to the model</dt><dd data-diag-sent>{diagCount(receipt.diagnostics.sentToModelCount)}</dd></div>
            <div><dt>Accepted</dt><dd data-diag-accepted>{diagCount(receipt.diagnostics.acceptedCount)}</dd></div>
            <div><dt>Rejected by catalogue check</dt><dd data-diag-rejected>{diagCount(receipt.diagnostics.rejectedCount)}</dd></div>
            <div><dt>Cache</dt><dd data-diag-cache>{diagCacheText}</dd></div>
            <div><dt>Request time</dt><dd data-diag-duration>{diagDurationText}</dd></div>
            <div><dt>Provider error</dt><dd data-diag-provider-error>{receipt.diagnostics.providerError ?? "—"}</dd></div>
            <div><dt>Fallback reason</dt><dd data-diag-fallback>{receipt.diagnostics.fallbackReason ?? receipt.fallbackReason ?? "—"}</dd></div>
          </dl>
          <p class="rs-discover-diag__foot">Diagnostics never include API keys, credentials or request text.</p>
        {/if}
      </section>
    {/if}
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

<!-- Reveal card (0.11.18): ONE playable recommendation at a
     time — cinematic artwork (the title's own backdrop/poster,
     TMDB-verified), the facts, and the specific reason it fits.
     Only verified + library-matched titles ever reach this snippet
     (the reveal queue is filtered in discover-redesign.ts); Watch
     lives in the actions row below and links to the detail page,
     which owns playback. -->
{#snippet aiRecommendationCard(rec, index)}
  {@const key = rec.match?.catalogueKey ?? (rec.verified ? `tmdb:${rec.tmdbId}` : `gen:${index}:${rec.generated.title}:${rec.generated.kind}:${rec.generated.year ?? ""}`)}
  {@const kindLabel = rec.kind === "series" ? "Series" : "Film"}
  <article class="rs-reveal-card" data-ai-result-card data-couch-key={key} aria-label={`${rec.title}${rec.year ? ` (${rec.year})` : ""}, ${kindLabel}, in your library`}>
    <div class="rs-reveal-card__art">
      {#if rec.backdropUrl || rec.posterUrl}
        <img
          src={rec.backdropUrl ?? rec.posterUrl}
          alt=""
          loading="eager"
          decoding="async"
          referrerpolicy="no-referrer"
          data-tv-image-img
        />
      {:else}
        <span class="rs-reveal-card__fallback" aria-hidden="true">
          <span class="rs-image__fallback-mark">{fallbackMarkFor("poster", rec.title)}</span>
          <span class="rs-image__fallback-title">{rec.title}</span>
        </span>
      {/if}
      <span class="rs-reveal-card__badge">✓ In your library</span>
    </div>
    <div class="rs-reveal-card__body">
      <p class="rs-reveal-card__kind">
        {kindLabel}{rec.year ? ` · ${rec.year}` : ""}{rec.genres?.length ? ` · ${rec.genres.slice(0, 3).join(" · ")}` : ""}
      </p>
      <h2 class="rs-reveal-card__title">{rec.title}</h2>
      {#if rec.synopsis}
        <p class="rs-reveal-card__synopsis">{rec.synopsis}</p>
      {/if}
      <p class="rs-reveal-card__why"><span class="rs-reveal-card__why-label">Why this fits — </span>{rec.reason}</p>
      {#if rec.tone}
        <p class="rs-reveal-card__tone">{rec.tone}</p>
      {/if}
    </div>
  </article>
{/snippet}
<style>
  /* Discover redesign (0.11.18) — deep navy neural space.
     Mockup geometry is 1672×941; sizes below are in rem against
     the app's real root font-size (clamp(12px, min(100vw/120,
     100vh/67.5), 32px) — 13.93px at 1672×941, 16px at 1920×1080),
     i.e. mockup px ÷ 13.93. Do NOT author these as px ÷ 10: that
     was the 0.11.18 scale bug (everything ~39% oversized at 1672).
     Palette (measured): base #010E1E, mid #011327, card fill
     #021830, textbox #031930, focused fill #051E46, primary
     #0D8CFD / #1568AA, glow #CDFFFF, headline #E4EAF0, subhead
     #AEC9E8, muted #9FB6CE, unselected border #43576F. */
  .rs-discover {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1.077rem;
    min-height: 100%;
    /* Full-bleed below the top nav: cancel the shell .rs-main
       side padding (clamp(1.5rem, 3vw, 3rem)) and bottom padding
       (3rem) so the navy fills edge-to-edge; the mockup shows no
       burgundy frame around the panel. The same clamp expression
       cancels it exactly at any root font-size. */
    margin: 0 calc(-1 * clamp(1.5rem, 3vw, 3rem)) -3rem;
    background:
      radial-gradient(86.16rem 43.08rem at 50% -10%, #062a52 0%, transparent 55%),
      radial-gradient(64.62rem 35.9rem at 85% 110%, #041a3a 0%, transparent 60%),
      linear-gradient(180deg, #010e1e 0%, #011327 55%, #010e1e 100%);
    isolation: isolate;
  }
  .rs-neural-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 0;
    opacity: 0.9;
  }
  .rs-discover > *:not(.rs-neural-canvas) {
    position: relative;
    z-index: 1;
  }

  /* Top row: DISCOVER label left, step dots + "01 / 03" right. */
  .rs-discover__top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.862rem 3.375rem 0;
  }
  .rs-discover__eyebrow {
    margin: 0;
    font-size: 1.723rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #deeefc;
  }
  .rs-discover__steps {
    display: flex;
    align-items: center;
    gap: 1.221rem;
  }
  .rs-step-dot {
    width: 0.933rem;
    height: 0.933rem;
    border-radius: 50%;
    border: 0.144rem solid rgba(222, 239, 252, 0.45);
    background: transparent;
  }
  .rs-step-dot.is-filled {
    background: #ffffff;
    border-color: #ffffff;
    box-shadow: 0 0 0.862rem rgba(205, 255, 255, 0.8);
  }
  .rs-step-text {
    font-size: 1.867rem;
    font-weight: 600;
    color: #deeefc;
    letter-spacing: 0.04em;
  }

  /* One continuous flow space. */
  .rs-flow {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .rs-flow-step {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 0 3.375rem 0.718rem;
    min-height: 44.516rem;
  }
  .rs-flow-title {
    margin: 0;
    font-size: 5.744rem;
    line-height: 1.05;
    font-weight: 700;
    color: #e4eaf0;
    text-align: center;
    text-wrap: balance;
  }
  .rs-flow-title--left {
    text-align: left;
    font-size: 4.667rem;
    line-height: 1.08;
  }
  .rs-flow-sub {
    margin: 1.005rem 0 0;
    font-size: 2.585rem;
    line-height: 1.3;
    color: #b7cee6;
    text-align: center;
  }
  .rs-flow-sub--left {
    text-align: left;
    font-size: 2.154rem;
  }
  .rs-flow-choices {
    margin: 1.436rem 0 0;
    font-size: 1.867rem;
    color: #d2dff0;
  }
  .rs-flow-hint {
    margin: 0.862rem 0 0 0.718rem;
    font-size: 1.723rem;
    font-style: italic;
    color: #bcd6ee;
  }
  .rs-flow-notice {
    margin: 1.436rem 0 0;
    font-size: 1.723rem;
    color: #cfe2f4;
    background: rgba(2, 24, 48, 0.85);
    border: 0.072rem solid #43576f;
    border-radius: 0.862rem;
    padding: 1.005rem 1.292rem;
  }
  .rs-flow-hints {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1.149rem;
    margin: 1.723rem 0 0;
    font-size: 1.436rem;
    color: #d9e4f1;
  }
  .rs-hint-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.298rem;
    height: 2.298rem;
    padding: 0 0.574rem;
    border: 0.144rem solid #ffffff;
    border-radius: 50%;
    font-size: 1.292rem;
    font-weight: 700;
    color: #ffffff;
  }
  .rs-flow-foot {
    margin: 1.149rem 0 0;
    font-size: 1.292rem;
    color: #9fb6ce;
    text-align: center;
  }

  /* Brain / neural hero art. The generated PNG sits over a CSS
     neural glow, so a missing asset degrades to the glow, never to
     a broken image. */
  .rs-brain {
    position: relative;
    margin: 0 auto;
    pointer-events: none;
    background:
      radial-gradient(closest-side, rgba(13, 140, 253, 0.35) 0%, rgba(13, 140, 253, 0.12) 55%, transparent 75%);
  }
  .rs-brain--step1 {
    width: min(51.696rem, 86%);
    height: 21.54rem;
  }
  .rs-brain--step2 {
    position: absolute;
    top: 0;
    right: 3.375rem;
    width: 25.13rem;
    height: 15.796rem;
    margin: 0;
  }
  .rs-brain--step3 {
    position: absolute;
    top: 1.436rem;
    right: 0;
    width: 37.336rem;
    height: 31.592rem;
    margin: 0;
  }
  .rs-brain__img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 1.149rem;
    mask-image: radial-gradient(closest-side, #000 55%, transparent 98%);
    -webkit-mask-image: radial-gradient(closest-side, #000 55%, transparent 98%);
  }

  /* Step 1 — three kind cards. */
  .rs-flow-step--kind .rs-flow-title {
    margin-top: 0.718rem;
  }
  .rs-kind-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1.58rem;
    margin: 3.231rem auto 0;
    width: min(102.459rem, 100%);
  }
  .rs-kind-card {
    position: relative;
    height: 16.083rem;
    overflow: hidden;
    text-align: left;
    cursor: pointer;
    border-radius: 1.149rem;
    border: 0.144rem solid #43576f;
    background:
      linear-gradient(180deg, rgba(5, 30, 70, 0.55) 0%, rgba(2, 24, 48, 0.92) 78%),
      #021830;
    color: #e4eaf0;
    padding: 0;
  }
  .rs-kind-card__art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.85;
  }
  .rs-kind-card__label,
  .rs-kind-card__sub {
    position: relative;
    z-index: 1;
    display: block;
    margin-left: 2.728rem;
    text-shadow: 0 0.144rem 0.862rem rgba(1, 14, 30, 0.9);
  }
  .rs-kind-card__label {
    margin-top: 8.257rem;
    font-size: 3.59rem;
    font-weight: 700;
    line-height: 1;
  }
  .rs-kind-card__sub {
    margin-top: 0.718rem;
    font-size: 1.939rem;
    color: #d9e4f1;
  }
  /* (A) badge on the Either card (mockup: Ø36px, bottom-right,
     ring white, dark-blue fill, 'A' ~18px). */
  .rs-kind-card__badge {
    position: absolute;
    right: 0.144rem;
    bottom: 2.728rem;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.585rem;
    height: 2.585rem;
    border-radius: 50%;
    border: 0.144rem solid #ffffff;
    background: #043872;
    color: #ffffff;
    font-size: 1.292rem;
    font-weight: 700;
    box-shadow: 0 0 1.15rem rgba(172, 255, 255, 0.7);
  }
  .rs-kind-card:hover,
  .rs-kind-card:focus-visible {
    border-color: #deffff;
    background-color: #051e46;
    box-shadow:
      0 0 0 0.144rem rgba(205, 255, 255, 0.9),
      0 0 2.298rem rgba(23, 118, 186, 0.75);
    outline: none;
  }

  /* Step 2 — eight genre tiles (the mood grid, reused class names). */
  .rs-flow-step--categories {
    padding-right: 3.375rem;
  }
  .rs-flow-step--categories .rs-brain--step2 {
    top: 0.718rem;
  }
  .rs-discover__mood-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1.077rem;
    margin-top: 2.298rem;
    width: min(100.376rem, 100%);
  }
  .rs-discover-mood {
    position: relative;
    height: 14.36rem;
    overflow: hidden;
    text-align: left;
    cursor: pointer;
    border-radius: 0.862rem;
    border: 0.072rem solid #52718e;
    background:
      linear-gradient(180deg, rgba(0, 30, 56, 0.5) 0%, rgba(2, 24, 48, 0.94) 80%),
      #021830;
    color: #e6ecf6;
    padding: 0;
  }
  .rs-discover-mood__art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.8;
  }
  .rs-discover-mood__label,
  .rs-discover-mood__sub {
    position: relative;
    z-index: 1;
    display: block;
    margin-left: 1.723rem;
    margin-right: 1.723rem;
    text-shadow: 0 0.144rem 0.718rem rgba(1, 14, 30, 0.9);
  }
  .rs-discover-mood__label {
    margin-top: 9.621rem;
    font-size: 2.728rem;
    font-weight: 700;
    line-height: 1;
  }
  .rs-discover-mood__sub {
    margin-top: 0.646rem;
    font-size: 1.436rem;
    color: #cfe2f4;
  }
  .rs-discover-mood__check {
    position: absolute;
    top: 1.723rem;
    right: 1.723rem;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.728rem;
    height: 2.728rem;
    border-radius: 50%;
    border: 0.144rem solid #acffff;
    background: #043872;
    color: #ffffff;
    font-size: 1.58rem;
    font-weight: 700;
    box-shadow: 0 0 1.149rem rgba(172, 255, 255, 0.7);
  }
  .rs-discover-mood:hover,
  .rs-discover-mood:focus-visible {
    border-color: #deffff;
    outline: none;
    box-shadow: 0 0 1.723rem rgba(23, 118, 186, 0.65);
  }
  .rs-discover-mood.is-active {
    border: 0.144rem solid #cdffff;
    box-shadow:
      0 0 0 0.144rem rgba(205, 255, 255, 0.55),
      0 0 2.01rem rgba(23, 118, 186, 0.85);
  }
  .rs-flow-foot-row {
    display: flex;
    align-items: center;
    gap: 2.154rem;
    margin-top: 2.154rem;
    width: min(100.376rem, 100%);
  }
  .rs-flow-selected {
    margin: 0;
    flex: 1;
    font-size: 1.939rem;
    color: #cfe2f4;
    padding-left: 1.723rem;
  }

  /* Step 3 — brief. */
  .rs-flow-step--brief .rs-flow-title--left {
    max-width: 57.44rem;
  }
  .rs-flow-step--brief .rs-flow-sub--left {
    max-width: 57.44rem;
  }
  .rs-flow-brief-form {
    margin-top: 2.441rem;
    max-width: 61.461rem;
  }
  .rs-discover__keyboard-scope {
    position: relative;
  }
  .rs-flow-brief-label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 0 1.005rem 0.862rem;
    font-size: 2.01rem;
    font-weight: 700;
    color: #edf5ff;
  }
  .rs-flow-brief-optional {
    font-size: 1.58rem;
    font-style: italic;
    font-weight: 400;
    color: #a6c4e1;
  }
  .rs-flow-brief-input {
    display: block;
    width: 100%;
    min-height: 13.283rem;
    resize: vertical;
    padding: 1.867rem 3.231rem;
    border-radius: 1.292rem;
    border: 0.144rem solid #dbffff;
    background: #031930;
    color: #e8f2fc;
    font-size: 2.441rem;
    line-height: 1.35;
    font-family: inherit;
    box-shadow: 0 0 1.723rem rgba(23, 118, 186, 0.35);
  }
  .rs-flow-brief-input::placeholder {
    color: #7e9cc0;
  }
  .rs-flow-brief-input:focus-visible {
    outline: none;
    border-color: #cdffff;
    box-shadow:
      0 0 0 0.144rem rgba(205, 255, 255, 0.9),
      0 0 2.298rem rgba(23, 118, 186, 0.8);
  }
  .rs-flow-actions {
    display: flex;
    align-items: center;
    gap: 3.303rem;
    margin-top: 2.154rem;
  }
  .rs-flow-link {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.431rem 0;
    font-size: 1.867rem;
    color: #e2ecfc;
    text-decoration: none;
  }
  .rs-flow-link:hover,
  .rs-flow-link:focus-visible {
    color: #ffffff;
    text-decoration: underline;
    outline: none;
  }

  /* Primary buttons (Continue / Find my next watch / Watch). */
  .rs-flow-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 1.005rem;
    min-height: 4.739rem;
    padding: 0 2.441rem;
    border: none;
    border-radius: 1.149rem;
    cursor: pointer;
    text-decoration: none;
    font-size: 2.01rem;
    font-weight: 700;
    color: #ffffff;
    background: linear-gradient(180deg, #1899f7 0%, #1587ea 55%, #0579f0 100%);
    box-shadow: 0 0 1.436rem rgba(13, 140, 253, 0.45);
  }
  .rs-flow-primary:hover,
  .rs-flow-primary:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 0.144rem rgba(205, 255, 255, 0.9),
      0 0 2.154rem rgba(23, 118, 186, 0.9);
  }
  .rs-flow-primary--find {
    min-height: 5.385rem;
    min-width: 34.32rem;
    font-size: 2.082rem;
    background: linear-gradient(180deg, #42a6da 0%, #0d8cfd 55%, #006de6 100%);
  }
  .rs-flow-primary--continue {
    min-width: 21.109rem;
  }
  .rs-flow-primary--watch {
    min-width: 17.232rem;
  }
  .rs-flow-secondary {
    min-height: 4.739rem;
    padding: 0 2.01rem;
    border-radius: 1.149rem;
    border: 0.144rem solid #52718e;
    background: rgba(2, 24, 48, 0.85);
    color: #e2ecfc;
    font-size: 1.867rem;
    font-weight: 600;
    cursor: pointer;
  }
  .rs-flow-secondary:hover,
  .rs-flow-secondary:focus-visible {
    border-color: #deffff;
    color: #ffffff;
    outline: none;
    box-shadow: 0 0 1.723rem rgba(23, 118, 186, 0.65);
  }

  /* Loading + reveal. */
  .rs-flow-step--loading {
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .rs-flow-loading-note {
    margin-top: 1.436rem;
    font-size: 2.01rem;
    color: #b7cee6;
  }
  .rs-flow-step--reveal {
    align-items: center;
  }
  .rs-ai-grid {
    width: min(94.776rem, 100%);
    margin-top: 0.718rem;
  }
  .rs-reveal-card {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
    gap: 2.298rem;
    align-items: stretch;
  }
  .rs-reveal-card__art {
    position: relative;
    overflow: hidden;
    border-radius: 1.149rem;
    border: 0.144rem solid #43576f;
    background: linear-gradient(135deg, #051e46 0%, #021830 60%, #010e1e 100%);
    min-height: 28.72rem;
  }
  .rs-reveal-card__art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .rs-reveal-card__fallback {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.862rem;
    min-height: 28.72rem;
    padding: 2.154rem;
    text-align: center;
  }
  .rs-reveal-card__badge {
    position: absolute;
    left: 1.149rem;
    bottom: 1.149rem;
    padding: 0.574rem 1.149rem;
    border-radius: 717.282rem;
    background: rgba(4, 56, 114, 0.92);
    border: 0.072rem solid #acffff;
    color: #ffffff;
    font-size: 1.58rem;
    font-weight: 700;
  }
  .rs-reveal-card__body {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1.149rem;
    padding: 0.718rem 0;
  }
  .rs-reveal-card__kind {
    margin: 0;
    font-size: 1.723rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #a9c7e9;
  }
  .rs-reveal-card__title {
    margin: 0;
    font-size: 4.308rem;
    line-height: 1.05;
    font-weight: 700;
    color: #eef2f9;
    text-wrap: balance;
  }
  .rs-reveal-card__synopsis {
    margin: 0;
    font-size: 1.867rem;
    line-height: 1.45;
    color: #d2dff0;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rs-reveal-card__why {
    margin: 0;
    font-size: 1.867rem;
    line-height: 1.45;
    color: #e8f2fc;
    border-left: 0.287rem solid #0d8cfd;
    padding-left: 1.149rem;
  }
  .rs-reveal-card__why-label {
    font-weight: 700;
    color: #ffffff;
  }
  .rs-reveal-card__tone {
    margin: 0;
    font-size: 1.58rem;
    font-style: italic;
    color: #bcd6ee;
  }
  .rs-reveal-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 1.436rem;
    margin-top: 2.298rem;
  }
  .rs-reveal-count {
    margin-top: 1.436rem;
    font-size: 1.58rem;
    color: #9fb6ce;
    text-align: center;
  }

  /* Ask AI about… + mode row. */
  .rs-discover-ask-ai {
    display: inline-block;
    margin-top: 1.436rem;
    padding: 1.005rem 1.867rem;
    border-radius: 1.005rem;
    border: 0.144rem solid #1568aa;
    background: rgba(21, 104, 170, 0.25);
    color: #e2ecfc;
    font-size: 1.723rem;
    cursor: pointer;
  }
  .rs-discover-ask-ai:hover,
  .rs-discover-ask-ai:focus-visible {
    border-color: #deffff;
    color: #ffffff;
    outline: none;
  }
  .rs-discover-mode-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1.436rem;
    margin-top: 2.154rem;
    max-width: 61.461rem;
  }
  .rs-discover-mode {
    display: inline-flex;
    align-items: center;
    gap: 0.718rem;
    padding: 0.718rem 1.292rem;
    border-radius: 717.282rem;
    border: 0.072rem solid #43576f;
    background: rgba(2, 24, 48, 0.85);
    color: #d9e4f1;
    font-size: 1.58rem;
    text-decoration: none;
  }
  .rs-discover-mode:hover,
  .rs-discover-mode:focus-visible {
    border-color: #deffff;
    outline: none;
  }
  .rs-discover-mode__dot {
    width: 0.862rem;
    height: 0.862rem;
    border-radius: 50%;
    background: #9fb6ce;
  }
  .rs-discover-mode--connected .rs-discover-mode__dot {
    background: #37d67a;
  }
  .rs-discover-mode--unavailable .rs-discover-mode__dot {
    background: #f0b429;
  }
  .rs-discover-mode--local .rs-discover-mode__dot {
    background: #f0b429;
  }
  .rs-discover-mode__detail {
    margin: 0;
    font-size: 1.436rem;
    color: #9fb6ce;
  }
  .rs-discover-prefs {
    font-size: 1.58rem;
    color: #c5d7f1;
  }
  .rs-discover-prefs:hover,
  .rs-discover-prefs:focus-visible {
    color: #ffffff;
    outline: none;
  }

  /* Onboarding panel. */
  .rs-discover-onboard {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.436rem;
    flex-wrap: wrap;
    margin: 0 3.375rem;
    padding: 1.723rem 2.01rem;
    border-radius: 1.149rem;
    border: 0.072rem solid #43576f;
    background: rgba(2, 24, 48, 0.9);
  }
  .rs-discover-onboard__text {
    flex: 1 1 43.08rem;
  }
  .rs-discover-onboard__text h2 {
    margin: 0 0 0.718rem;
    font-size: 2.298rem;
    color: #eef2f9;
  }
  .rs-discover-onboard__text p {
    margin: 0;
    font-size: 1.723rem;
    line-height: 1.5;
    color: #b7cee6;
  }
  .rs-discover-onboard__actions {
    display: flex;
    gap: 1.149rem;
    align-items: center;
  }
  .rs-discover-onboard__primary {
    padding: 1.005rem 1.867rem;
    border-radius: 1.005rem;
    background: linear-gradient(180deg, #1899f7 0%, #0579f0 100%);
    color: #ffffff;
    font-size: 1.723rem;
    font-weight: 700;
    text-decoration: none;
  }
  .rs-discover-onboard__primary:hover,
  .rs-discover-onboard__primary:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.144rem rgba(205, 255, 255, 0.9);
  }
  .rs-discover-onboard__secondary {
    padding: 1.005rem 1.436rem;
    border-radius: 1.005rem;
    border: 0.072rem solid #52718e;
    background: transparent;
    color: #e2ecfc;
    font-size: 1.723rem;
    cursor: pointer;
  }
  .rs-discover-onboard__secondary:hover,
  .rs-discover-onboard__secondary:focus-visible {
    border-color: #deffff;
    outline: none;
  }

  /* AI panels (unavailable / empty / not-configured). */
  .rs-ai-panel {
    margin: 1.436rem auto 0;
    padding: 1.723rem 2.01rem;
    max-width: 64.62rem;
    border-radius: 1.149rem;
    border: 0.072rem solid #43576f;
    background: rgba(2, 24, 48, 0.9);
  }
  .rs-ai-panel__title {
    margin: 0 0 0.718rem;
    font-size: 2.154rem;
    color: #eef2f9;
  }
  .rs-ai-panel__text {
    margin: 0 0 0.862rem;
    font-size: 1.723rem;
    line-height: 1.5;
    color: #d2dff0;
  }
  .rs-ai-panel__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1.149rem;
    margin-top: 1.149rem;
  }
  .rs-ai-panel__primary,
  .rs-ai-panel__secondary {
    display: inline-flex;
    align-items: center;
    padding: 1.005rem 1.723rem;
    border-radius: 1.005rem;
    font-size: 1.723rem;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
  }
  .rs-ai-panel__primary {
    border: none;
    background: linear-gradient(180deg, #1899f7 0%, #0579f0 100%);
    color: #ffffff;
  }
  .rs-ai-panel__secondary {
    border: 0.072rem solid #52718e;
    background: transparent;
    color: #e2ecfc;
  }
  .rs-ai-panel__primary:hover,
  .rs-ai-panel__primary:focus-visible,
  .rs-ai-panel__secondary:hover,
  .rs-ai-panel__secondary:focus-visible {
    border-color: #deffff;
    outline: none;
    box-shadow: 0 0 0 0.144rem rgba(205, 255, 255, 0.6);
  }

  /* Local similar rail. */
  .rs-ai-similar {
    margin: 0 3.375rem;
  }
  .rs-ai-similar .rs-section-title {
    font-size: 2.154rem;
    color: #eef2f9;
  }

  /* Diagnostics. */
  .rs-discover-diag {
    margin: 0.718rem 3.375rem 1.436rem;
  }
  .rs-discover-diag__toggle {
    padding: 0.862rem 1.58rem;
    border-radius: 0.862rem;
    border: 0.072rem solid #43576f;
    background: rgba(2, 24, 48, 0.85);
    color: #d9e4f1;
    font-size: 1.58rem;
    cursor: pointer;
  }
  .rs-discover-diag__toggle:hover,
  .rs-discover-diag__toggle:focus-visible {
    border-color: #deffff;
    outline: none;
  }
  .rs-discover-diag__toggle:focus-visible {
    box-shadow: 0 0 0 0.144rem rgba(205, 255, 255, 0.9);
  }
  .rs-discover-diag__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(20.104rem, 1fr));
    gap: 0.862rem 1.723rem;
    margin: 1.149rem 0 0;
    padding: 1.436rem 1.723rem;
    border-radius: 0.862rem;
    border: 0.072rem solid #43576f;
    background: rgba(2, 24, 48, 0.9);
  }
  .rs-discover-diag__grid > div {
    display: flex;
    flex-direction: column;
    gap: 0.287rem;
  }
  .rs-discover-diag__grid dt {
    font-size: 1.364rem;
    color: #9fb6ce;
  }
  .rs-discover-diag__grid dd {
    margin: 0;
    font-size: 1.58rem;
    color: #e8f2fc;
  }
  .rs-discover-diag__foot {
    margin: 0.862rem 0 0;
    font-size: 1.364rem;
    color: #9fb6ce;
  }

  /* Local cards (discoverCard snippet, reused for local similar). */
  .rs-discover-cell {
    flex: 0 0 auto;
  }
  .rs-discover-cell--poster {
    width: 15.796rem;
  }
  .rs-discover-card {
    height: 100%;
  }
  .rs-discover-card .rs-card {
    height: 100%;
  }
  .rs-discover-rating {
    position: absolute;
    top: 0.718rem;
    right: 0.718rem;
    display: inline-flex;
    gap: 0.431rem;
    align-items: center;
    padding: 0.431rem 0.718rem;
    border-radius: 717.282rem;
    background: rgba(1, 14, 30, 0.85);
    color: #ffd166;
    font-size: 1.436rem;
    font-weight: 700;
  }
  .rs-discover-reason {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  @media (max-width: 1100px) {
    .rs-kind-grid {
      grid-template-columns: 1fr;
    }
    .rs-kind-card {
      height: 11.488rem;
    }
    .rs-kind-card__label {
      margin-top: 4.308rem;
    }
    .rs-discover__mood-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .rs-flow-title {
      font-size: 4.021rem;
    }
    .rs-flow-title--left {
      font-size: 3.446rem;
    }
    .rs-reveal-card {
      grid-template-columns: 1fr;
    }
    .rs-brain--step2,
    .rs-brain--step3 {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rs-neural-canvas {
      opacity: 0.35;
    }
  }
</style>
