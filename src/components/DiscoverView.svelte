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
     discovery orchestrator (ai/discovery-orchestrator.ts — a SHIM in
     the W3 branch, replaced by W1's real implementation at
     integration); the local engine (searchDiscover) stays for typing,
     quick picks, and the explicitly-labelled "similar titles
     available locally" option. The old rankDiscover/AI-ranker path is
     retired: one orchestration layer only. -->
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
    EXAMPLE_PROMPTS,
    registerFollowedProvider,
    isNaturalLanguageQuery,
    detectMoodPresets,
  } from "@/scripts/lib/discover.ts"
  // AI-first discovery (0.11.6): the orchestrator + conversation
  // contracts are FROZEN; in this branch both modules are SHIMs that
  // integration replaces with W1's real implementations. The state
  // transitions are likewise a SHIM (W4 owns the real module). The
  // presentation helpers are real, pure, tested code.
  import {
    runAiDiscovery,
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
    isRefinementSubmit,
    refinementContextLabel,
    formatTasteSummaryForAi,
    providerErrorMessage,
    providerErrorCodeFor,
    aiDiscoveryProgressText,
  } from "@/scripts/lib/ai/discovery-presentation.ts"
  import { summarizeTaste } from "@/scripts/lib/taste.ts"
  import { registerBackInterceptor } from "@/scripts/lib/back-handler.ts"
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
    /** @type {Array<import("@/scripts/lib/ai/discovery-orchestrator.ts").VerifiedRecommendation> | null} */ (null)
  )
  /** In-flight orchestrator phase, when the orchestrator reports one.
      Null when idle or when the run reports no progress (the UI then
      shows a single "Asking AI…" state — never invented stages). */
  let aiPhase = $state(
    /** @type {import("@/scripts/lib/ai/discovery-orchestrator.ts").DiscoveryProgressPhase | null} */ (null)
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
  /** @type {string} */
  let aiModel = $state("")
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

  const showingSearch = $derived(
    queryDebounced.trim() !== "" || !!activeMood || aiResults !== null || aiUnavailable !== null
  )
  /** Whether an AI rail (results, or an honest empty/unavailable
      state) is on screen, as opposed to a local rail. */
  const hasAiResults = $derived(aiResults !== null)
  /** Recommendations to show for the current toggle state — a pure
      client-side filter; toggling never re-calls the model. */
  const visibleAiResults = $derived(
    visibleRecommendations(aiResults ?? [], availableOnly)
  )
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
  /** Submit button label: refining is a refinement, not a new search. */
  const submitLabel = $derived(
    isRefinementSubmit(conversation, hasAiResults, query)
      ? "Refine"
      : aiAuto
        ? "Ask AI"
        : "Search"
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
      fallbackNotice = ""
      receipt = null
      aiResults = null
      aiUnavailable = null
      localSimilar = null
      return
    }
    searching = true
    searchingAi = false
    fallbackNotice = ""
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
  function onQueryInput(value) {
    query = value
    if (queryTimer) clearTimeout(queryTimer)
    // Typing a refinement must not clobber the AI results on screen:
    // while an AI rail is showing, typing only edits the box — the
    // refinement runs on submit. Otherwise typing searches locally
    // only — it never sends an AI request.
    if (aiResults !== null) return
    queryTimer = setTimeout(() => {
      queryDebounced = value
      activeMood = null
      void runSearch()
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
   *   model call. The field is still passed, for cache identity.
   * - Taste is sent ONLY when the user opted in to sharing it
   *   (default OFF, AI05), as a single formatted string.
   * - The loaded catalogue is passed for playability matching; the
   *   orchestrator decides the match, the UI only displays it.
   * - Cancellation: a new submit, New Search, Clear, or leaving
   *   Discover aborts the in-flight run; an aborted run updates no
   *   state. The receipt comes from the orchestrator, verbatim.
   */
  async function runAiSearch() {
    if (!data) return
    const q = query.trim()
    if (!q) return
    // No doomed requests: when AI cannot run, fall back to a local
    // search and let the rail say why Ask AI is unavailable.
    if (!canAskAi) {
      queryDebounced = q
      activeMood = null
      await runSearch()
      return
    }
    if (aiAbort) aiAbort.abort()
    const controller = new AbortController()
    aiAbort = controller
    const token = ++searchToken
    queryDebounced = q
    activeMood = null
    searching = true
    searchingAi = true
    aiPhase = "asking"
    aiUnavailable = null
    localSimilar = null
    fallbackNotice = ""
    searchResults = null
    resultsSource = null
    const runStartedAt = performance.now()
    const tasteSummary = getAiShareTaste()
      ? formatTasteSummaryForAi(summarizeTaste(data.taste))
      : null
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
          model: aiModel || undefined,
          catalogue: data.candidates,
          onPhase: (phase) => {
            if (token === searchToken) aiPhase = phase
          },
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
        return
      }
      conversation = result.conversation
      aiResults = result.results
      receipt = result.receipt
      resultsSource = "ai"
      aiPhase = null
      // Focus the first recommendation once it has rendered (the
      // keyboard-dismiss-first discipline lives in focusFirstAiResult).
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

  /** "Available in My Library" toggle: filter only, never a new call. */
  function toggleAvailableOnly() {
    availableOnly = !availableOnly
  }

  /** New Search: clear EVERYTHING, including the conversation. */
  function newSearch() {
    if (aiAbort) aiAbort.abort()
    searchToken++
    const fresh = applyNewSearch()
    query = fresh.query
    queryDebounced = ""
    conversation = fresh.conversation
    availableOnly = fresh.availableOnly
    activeMood = fresh.activeMood
    searchResults = null
    aiResults = null
    resultsSource = null
    receipt = null
    fallbackNotice = ""
    aiUnavailable = null
    localSimilar = null
    aiPhase = null
    searching = false
    searchingAi = false
    diagnosticsOpen = false
    window.scrollTo(0, 0)
    inputEl?.focus()
  }

  /** Snapshot the current state for a frozen state transition. */
  function snapshotState() {
    return { query, conversation, availableOnly, activeMood }
  }

  /** Apply a frozen state transition back onto the component state. */
  function applyDiscoveryState(next) {
    query = next.query
    conversation = next.conversation
    availableOnly = next.availableOnly
    activeMood = next.activeMood
  }

  function focusFirstResult() {
    // Dismiss the on-screen keyboard FIRST: it is in-flow (~588px),
    // so focusing while it is still mounted scrolls against a layout
    // that collapses a frame later — the scroll anchoring then leaves
    // the quick-pick row half-under the sticky nav (0.11.5 seam 6).
    // The dismiss flushes before the rAF below runs, so the scroll
    // and focus below measure the settled layout.
    if (keyboard.dismiss()) syncKeyboard()
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
        .querySelector("[data-ai-results] [data-ai-result-card]")
        ?.scrollIntoView({ block: "nearest" })
      document
        .querySelector("[data-ai-results] [data-ai-result-card]")
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
    const q = query.trim()
    if (isRefinementSubmit(conversation, hasAiResults, q)) {
      queryDebounced = q
      void runAiSearch()
      return
    }
    if (aiAuto && canAskAi && q) {
      queryDebounced = q
      activeMood = null
      void runAiSearch()
      return
    }
    queryDebounced = query
    activeMood = null
    void runSearch()
    focusFirstResult()
  }

  /** Explicit "Ask AI" — one paid request, on the user's tap. */
  function askAi() {
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
    void runAiSearch()
  }

  function pickExample(prompt) {
    // An example prompt is a NEW question: fresh conversation, no
    // carried context — even when refining. When AI cannot run, it
    // searches locally instead of firing a doomed request.
    query = prompt
    queryDebounced = prompt
    activeMood = null
    conversation = newConversation()
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
    if (activeMood === presetId) {
      applyDiscoveryState(applyNewSearch())
      queryDebounced = ""
      searchResults = null
      aiResults = null
      resultsSource = null
      receipt = null
      aiUnavailable = null
      localSimilar = null
      return
    }
    applyDiscoveryState(applyQuickPick(snapshotState(), presetId))
    queryDebounced = ""
    void runSearch()
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
    if (aiAbort) aiAbort.abort()
    searchToken++
    query = ""
    queryDebounced = ""
    activeMood = null
    searchResults = null
    aiResults = null
    resultsSource = null
    fallbackNotice = ""
    receipt = null
    conversation = newConversation()
    availableOnly = false
    aiUnavailable = null
    localSimilar = null
    aiPhase = null
    searching = false
    searchingAi = false
    inputEl?.focus()
  }

  /**
   * B / Escape back steps (gamepad B dispatches Escape outside Live
   * TV; Android BACK goes through the registered interceptor below).
   * Predictable order: close diagnostics -> back out of the results
   * to the search box -> otherwise fall through (at the landing
   * state, B does nothing — Home is one D-pad move up, in the nav).
   * The input's own Escape handler runs first for the on-screen
   * keyboard and stops propagation when it dismisses it.
   */
  function onDiscoverKeyDown(ev) {
    if (ev.key !== "Escape") return
    if (diagnosticsOpen) {
      diagnosticsOpen = false
      ev.preventDefault()
      ev.stopPropagation()
      return
    }
    const active = /** @type {HTMLElement | null} */ (document.activeElement)
    const inResults = active?.closest?.("[data-discover-results]")
    if (inResults && active !== inputEl) {
      ev.preventDefault()
      inputEl?.focus()
    }
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
    // Android BACK: same back steps as the Escape handler (close
    // diagnostics -> back out of results to the landing state ->
    // otherwise fall through to the WebView default).
    const unregisterBack = registerBackInterceptor(() => {
      if (diagnosticsOpen) {
        diagnosticsOpen = false
        return true
      }
      if (
        aiResults !== null ||
        searchResults !== null ||
        queryDebounced.trim() !== "" ||
        activeMood !== null
      ) {
        newSearch()
        return true
      }
      return false
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
      unregisterBack()
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
</script>

<div class="rs-discover" data-discover-root onkeydown={onDiscoverKeyDown}>
  <!-- Hero: Discover is a destination, with its purpose and its AI
       mode stated up front. -->
  <header class="rs-discover__hero">
    <div class="rs-discover__hero-text">
      <p class="rs-discover__eyebrow">Discover</p>
      <h1 class="rs-page-title">What are we watching?</h1>
      <p class="rs-discover__lede">
        Ask in your own words — AI suggests titles from its own
        knowledge, checks each one against TMDB, and shows you which
        are already in your library. Pick a quick pick, or browse
        picks made for you.
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
          placeholder={searchPlaceholder}
          autocomplete="off"
          class="rs-discover-input" />
        <button type="submit" data-nylah-item class="rs-discover-ask">
          {submitLabel}
        </button>
        {#if query || activeMood}
          <button
            type="button"
            onclick={clearSearch}
            data-nylah-item
            class="rs-discover-clear">Clear</button>
        {/if}
      </form>

      <!-- Refinement context: one subtle line, no chat bubbles. The
           original question stays visible while follow-ups refine it,
           and New Search is the obvious way back to a clean query. -->
      {#if refineLabel && hasAiResults}
        <div class="rs-discover-refine" data-refine-context>
          <p class="rs-discover-refine__label">{refineLabel} — type a follow-up, or start fresh.</p>
          <button
            type="button"
            onclick={newSearch}
            data-nylah-item
            class="rs-discover-refine__new">New Search</button>
        </div>
      {/if}

      <TvKeyboard
        bind:value={query}
        open={keyboardOpen}
        onInput={onOskInput}
        onCommit={onKeyboardCommit}
        onDismiss={dismissKeyboardToInput}
        placeholder={searchPlaceholder} />
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
             A quick pick keeps its own label. While an AI run is in
             flight the title says the question is being asked. -->
        <h2 class="rs-section-title">{railTitle}</h2>
        {#if searchingAi}
          <p class="rs-meta" aria-live="polite" data-ai-phase>{aiStatusText} One request for this question.</p>
        {:else if searching}
          <p class="rs-meta">Searching your library…</p>
        {/if}
      </div>
      {#if !searching && stateNote && !aiUnavailable}
        <p class="rs-meta" data-ai-state-note>{stateNote}</p>
      {/if}
      {#if !searching && refineLabel && hasAiResults && !aiUnavailable}
        <!-- Refinement context at the results, where the user's focus
             is: the original question, one line, no chat UI. The New
             Search action lives with the same line under the input. -->
        <p class="rs-meta" data-refine-context-rail>{refineLabel}</p>
      {/if}
      {#if fallbackNotice}
        <p class="rs-discover-fallback" role="status">{fallbackNotice}</p>
      {/if}

      {#if hasAiResults}
        <!-- AI rail (0.11.6): verified recommendations, each with its
             reason and an honest availability badge. Nothing is ever
             substituted or padded: if only two are available, two
             show as available and the rest say so. -->
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
        {:else if aiResults.length === 0 && !searching}
          <div class="rs-ai-panel" role="status" data-ai-empty>
            <h3 class="rs-ai-panel__title">AI couldn't suggest anything for that</h3>
            <p class="rs-ai-panel__text">
              Try rewording your question, or search for similar titles available in your library.
            </p>
            <div class="rs-ai-panel__actions">
              <button type="button" onclick={searchLocalSimilar} data-nylah-item class="rs-ai-panel__primary">
                Search for similar titles available locally
              </button>
              <button type="button" onclick={newSearch} data-nylah-item class="rs-ai-panel__secondary">
                New Search
              </button>
            </div>
          </div>
        {:else}
          <div class="rs-ai-controls">
            <button
              type="button"
              onclick={toggleAvailableOnly}
              aria-pressed={availableOnly}
              data-nylah-item
              data-available-toggle
              class="rs-ai-toggle"
              class:is-on={availableOnly}>
              <span class="rs-ai-toggle__box" aria-hidden="true">{availableOnly ? "✓" : ""}</span>
              <span class="rs-ai-toggle__label">Available in My Library</span>
              <span class="rs-ai-toggle__count">{matchedAiCount} of {aiResults.length} in your library</span>
            </button>
            <p class="rs-ai-controls__note">
              {availableOnly
                ? "Showing only titles in your library."
                : allAiVerified
                  ? "Showing all verified recommendations."
                  : "Showing all recommendations — some couldn't be verified."} Toggling never asks AI again.
            </p>
          </div>
          {#if matchedAiCount === 0 && aiResults.some((rec) => rec.verified) && !searching}
            <div class="rs-ai-panel" role="status" data-none-available>
              <h3 class="rs-ai-panel__title">None of these are in your library yet</h3>
              <p class="rs-ai-panel__text">
                These are AI's suggestions, verified against TMDB. Nothing has been
                swapped for a weaker available title.
              </p>
              <div class="rs-ai-panel__actions">
                <button type="button" onclick={searchLocalSimilar} data-nylah-item class="rs-ai-panel__primary">
                  Search for similar titles available locally
                </button>
              </div>
            </div>
          {/if}
          {#if visibleAiResults.length}
            <div class="rs-ai-grid" data-ai-results>
              {#each visibleAiResults as rec (rec.verified ? `tmdb:${rec.tmdbId}` : `gen:${rec.generated}`)}
                {@render aiRecommendationCard(rec)}
              {/each}
            </div>
          {:else if !searching}
            <div class="rs-ai-panel" role="status" data-available-empty>
              <p class="rs-ai-panel__text">
                None of these picks are in your library. Turn the toggle off to see
                all of AI's suggestions, or search for similar titles available locally.
              </p>
              <div class="rs-ai-panel__actions">
                <button type="button" onclick={searchLocalSimilar} data-nylah-item class="rs-ai-panel__primary">
                  Search for similar titles available locally
                </button>
              </div>
            </div>
          {/if}
        {/if}

        {#if localSimilar}
          <!-- Local similar titles: explicitly labelled local search,
               never masquerading as LLM recommendations. -->
          <div class="rs-ai-similar" data-local-similar>
            <h3 class="rs-section-title">Similar titles in your library</h3>
            <p class="rs-meta">Local search — similar titles from your library, not AI recommendations.</p>
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
      {:else}
        <!-- Local rail: typing, quick picks, Manual submit. A local
             rail says why it is local, next to the action that fixes
             it — or why there is no action. -->
        {#if resultsSource === "local" && !searching && !fallbackNotice}
          <p class="rs-meta" data-local-note>
            {canAskAi
              ? activeMood
                ? "Quick picks are filtered locally. Ask AI below for AI picks about this mood."
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
               here, and a failure surfaces through the unavailable
               state. Shown in Manual AND Automatic: in Automatic it is
               the only reachable ask for a typed query. Hides once AI
               answers (the AI rail replaces the local rail). -->
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
          <p class="rs-meta">Nothing matched — try a different word or a quick pick above.</p>
        {/if}
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

<!-- AI recommendation card (0.11.6): a horizontal card with room for
     the reason — the point of the feature. Verified artwork only: an
     unverified title gets fallback art, a "Couldn't verify" badge and
     no detail link. Available titles link to the existing detail
     flow (where playback starts); unavailable titles are focusable
     but inert, with the genuine reason still shown. -->
{#snippet aiCardBody(rec)}
  {@const showArt = rec.verified && !!rec.posterUrl}
  <span class="rs-ai-card__poster">
    <span
      class="rs-image rs-image--poster{showArt ? '' : ' is-fallback'}"
      data-tv-image
      data-kind="poster"
    >
      {#if showArt}
        <img
          src={rec.posterUrl}
          alt=""
          loading="lazy"
          fetchpriority="low"
          decoding="async"
          referrerpolicy="no-referrer"
          data-tv-image-img
        />
      {/if}
      <span class="rs-image__fallback" aria-hidden="true">
        <span class="rs-image__fallback-mark">{fallbackMarkFor("poster", rec.title)}</span>
        <span class="rs-image__fallback-title">{rec.title}</span>
      </span>
    </span>
  </span>
  <span class="rs-ai-card__body">
    <span class="rs-ai-card__title">{rec.title}</span>
    <span class="rs-ai-card__badges">
      <span class="rs-ai-badge">{rec.kind === "series" ? "Series" : "Film"}</span>
      {#if !rec.verified}
        <span class="rs-ai-badge rs-ai-badge--warn">Couldn't verify</span>
      {:else if rec.match}
        <span class="rs-ai-badge rs-ai-badge--ok">✓ In your library</span>
      {:else}
        <span class="rs-ai-badge rs-ai-badge--muted">Not in your library</span>
      {/if}
      {#if rec.year}<span class="rs-ai-card__year">{rec.year}</span>{/if}
    </span>
    <span class="rs-ai-card__reason">{rec.reason}</span>
    <span class="rs-ai-card__meta">
      {rec.tone + (rec.genres?.length ? ` · ${rec.genres.join(" · ")}` : "")}
    </span>
    {#if !rec.verified && rec.verificationNote}
      <span class="rs-ai-card__note">{rec.verificationNote}</span>
    {/if}
  </span>
{/snippet}

{#snippet aiRecommendationCard(rec)}
  {@const href = recommendationDetailHref(rec)}
  {@const key = rec.match?.catalogueKey ?? `ai:${rec.generated}`}
  {@const kindLabel = rec.kind === "series" ? "Series" : "Film"}
  {#if href}
    <a
      href={href}
      data-nylah-item
      data-ai-result-card
      data-couch-key={key}
      aria-label={`${rec.title}${rec.year ? ` (${rec.year})` : ""}, ${kindLabel}, in your library — open details`}
      class="rs-ai-card">
      {@render aiCardBody(rec)}
    </a>
  {:else}
    <article
      tabindex="0"
      data-nylah-item
      data-ai-result-card
      data-couch-key={key}
      aria-label={`${rec.title}${rec.year ? ` (${rec.year})` : ""}, ${kindLabel}, ${rec.verified ? "not in your library" : "could not be verified"}`}
      class="rs-ai-card rs-ai-card--unavailable">
      {@render aiCardBody(rec)}
    </article>
  {/if}
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

  /* -- AI-first Discover (0.11.6) ---------------------------------- */

  /* Refinement context: one subtle line under the search box — the
     original question plus the obvious New Search action. No chat
     bubbles, no transcript. */
  .rs-discover-refine {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0 0.25rem;
  }
  .rs-discover-refine__label {
    margin: 0;
    font-size: 1.125rem;
    color: var(--rs-text-2);
  }
  .rs-discover-refine__new {
    padding: 0.5rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text);
    font-size: 1.125rem;
    font-weight: 700;
    cursor: pointer;
    outline: none;
    white-space: nowrap;
  }
  .rs-discover-refine__new:hover,
  .rs-discover-refine__new:focus-visible {
    border-color: var(--rs-focus);
  }
  .rs-discover-refine__new:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus);
  }

  /* Available-only toggle row: the toggle is one controller-reachable
     button; the note states the no-new-request guarantee plainly. */
  .rs-ai-controls {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    flex-wrap: wrap;
  }
  .rs-ai-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text);
    font-size: 1.25rem;
    cursor: pointer;
    outline: none;
  }
  .rs-ai-toggle:hover,
  .rs-ai-toggle:focus-visible {
    border-color: var(--rs-focus);
  }
  .rs-ai-toggle:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus), 0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  .rs-ai-toggle.is-on {
    border-color: var(--rs-focus);
    background: var(--rs-bg-2);
  }
  .rs-ai-toggle__box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    flex: none;
    border-radius: 0.375rem;
    border: 2px solid var(--rs-text-2);
    color: #fff;
    font-size: 1.125rem;
    font-weight: 800;
    line-height: 1;
  }
  .rs-ai-toggle.is-on .rs-ai-toggle__box {
    border-color: var(--rs-focus);
    background: var(--rs-accent);
  }
  .rs-ai-toggle__label {
    font-weight: 700;
    white-space: nowrap;
  }
  .rs-ai-toggle__count {
    color: var(--rs-text-2);
    font-size: 1.125rem;
    white-space: nowrap;
  }
  .rs-ai-controls__note {
    margin: 0;
    font-size: 1.125rem;
    color: var(--rs-text-2);
  }

  /* AI recommendation grid: two horizontal cards per row at 1080p —
     poster on the left, readable reason on the right. One column on
     narrow viewports. No horizontal scrolling: the whole set reads
     as one coherent answer. */
  .rs-ai-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1.25rem;
    padding: 0.25rem;
  }
  @media (max-width: 64rem) {
    .rs-ai-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .rs-ai-card {
    display: flex;
    gap: 1.25rem;
    min-width: 0;
    padding: 1rem;
    border-radius: 1rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
    color: var(--rs-text);
    text-decoration: none;
    outline: none;
  }
  a.rs-ai-card {
    cursor: pointer;
  }
  .rs-ai-card:hover,
  .rs-ai-card:focus-visible {
    border-color: var(--rs-focus);
    background: var(--rs-bg-2);
  }
  .rs-ai-card:focus-visible {
    box-shadow:
      0 0 0 3px var(--rs-focus),
      0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  /* Unavailable cards read as present-but-not-playable: full reason,
     honest badge, slightly dimmed poster — never hidden, never
     replaced. */
  .rs-ai-card--unavailable .rs-ai-card__poster {
    opacity: 0.62;
  }
  .rs-ai-card__poster {
    flex: none;
    width: clamp(7rem, 8.5vw, 9.5rem);
  }
  .rs-ai-card__poster .rs-image {
    height: 100%;
    border-radius: 0.625rem;
    overflow: hidden;
  }
  .rs-ai-card__body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.25rem 0;
  }
  .rs-ai-card__title {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }
  .rs-ai-card__badges {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .rs-ai-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    border: 1px solid var(--rs-line);
    background: var(--rs-bg-2);
    color: var(--rs-text-2);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .rs-ai-badge--ok {
    border-color: #3fb96f;
    background: rgb(63 185 111 / 0.16);
    color: #7fd6a4;
  }
  .rs-ai-badge--muted {
    color: var(--rs-text-2);
  }
  .rs-ai-badge--warn {
    border-color: #e0a63c;
    background: rgb(224 166 60 / 0.16);
    color: #f0c573;
  }
  .rs-ai-card__year {
    font-size: 1.125rem;
    color: var(--rs-text-2);
    font-variant-numeric: tabular-nums;
  }
  /* The reason is the point of the feature: full sentences, three
     lines, never a clipped single-line meta. */
  .rs-ai-card__reason {
    font-size: 1.25rem;
    line-height: 1.45;
    color: var(--rs-text);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rs-ai-card__meta {
    font-size: 1.125rem;
    line-height: 1.4;
    color: var(--rs-text-2);
  }
  .rs-ai-card__note {
    font-size: 1.0625rem;
    line-height: 1.4;
    color: #f0c573;
  }

  /* Honest-state panels (none available / unavailable / empty): one
     calm surface, plain explanation, labelled actions. */
  .rs-ai-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: flex-start;
    padding: 1.25rem 1.5rem;
    border-radius: 1rem;
    border: 1px solid var(--rs-line);
    background: var(--rs-surface);
  }
  .rs-ai-panel__title {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--rs-text);
  }
  .rs-ai-panel__text {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.5;
    color: var(--rs-text-2);
  }
  .rs-ai-panel__actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .rs-ai-panel__primary {
    padding: 0.875rem 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-focus);
    background: var(--rs-accent);
    color: #fff;
    font-size: 1.25rem;
    font-weight: 700;
    cursor: pointer;
    outline: none;
    white-space: nowrap;
  }
  .rs-ai-panel__primary:hover,
  .rs-ai-panel__primary:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus), 0 0 1.5rem 0.25rem var(--rs-focus-glow);
  }
  .rs-ai-panel__secondary {
    padding: 0.875rem 1.25rem;
    border-radius: 0.75rem;
    border: 1px solid var(--rs-line);
    background: transparent;
    color: var(--rs-text);
    font-size: 1.25rem;
    font-weight: 700;
    cursor: pointer;
    outline: none;
    white-space: nowrap;
  }
  .rs-ai-panel__secondary:hover,
  .rs-ai-panel__secondary:focus-visible {
    border-color: var(--rs-focus);
  }
  .rs-ai-panel__secondary:focus-visible {
    box-shadow: 0 0 0 3px var(--rs-focus);
  }

  /* Local similar titles: same rail language as the rest of Discover,
     with its labelling carried in the markup, not the styling. */
  .rs-ai-similar {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
</style>
