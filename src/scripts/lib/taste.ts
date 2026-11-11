// RedSilk Discover — local taste model (W1, Discover CORE).
//
// A persistent, purely local preference model built on top of the watch
// state the app already keeps (preferences.js progress/favourites and the
// per-profile history in profiles.ts). This module never replaces watch
// history and never phones home: no accounts, no cloud, household default.
//
// Honesty rule, baked in: opening a title is NOT liking it. A title only
// counts as liked when it was completed, favourited, or explicitly liked.
// Stopping early (<20% with no return after a week) is a weak negative,
// never a like. Everything here is keyed `kind:id` and deduped, so
// re-deriving the model across restarts never grows duplicate records.
//
// Storage: one localStorage row per profile+playlist
// (`nylah_taste_v1:<profileId>:<playlistId>`), the same namespaced pattern
// profiles.ts uses. All storage access is guarded so the pure functions
// below run under vitest (node) with no browser globals.

export type TasteKind = "movie" | "series" | "live"

export interface TasteTitleRef {
  kind: TasteKind
  /** Provider id as a string (vod/series id, or channel id for live). */
  id: string
  title: string
  /** 0..1 weight of the signal; favourites and completions weigh most. */
  weight: number
  updatedAt: number
}

export interface TasteModel {
  version: 1
  profileId: string
  playlistId: string
  updatedAt: number
  /** Titles the household demonstrably enjoyed (completed / favourited / liked). */
  likedTitles: TasteTitleRef[]
  /** Explicit dislikes + inferred abandoned titles (weak weight). */
  dislikedTitles: TasteTitleRef[]
  /** Candidate keys the user marked "Not interested" — hard exclusions. */
  notInterestedKeys: string[]
  /** Favourite titles, kept as their own list (they also count as liked). */
  favouriteTitles: TasteTitleRef[]
  /** Normalised genre -> accumulated weight. */
  genreWeights: Record<string, number>
  /** Lower-cased person name -> accumulated weight. */
  castWeights: Record<string, number>
  /** Lower-cased director name -> accumulated weight. */
  directorWeights: Record<string, number>
  /** Runtimes (minutes) observed on liked titles, for the runtime pref. */
  likedRuntimes: number[]
  /** How often a recommended candidate was actually opened, per key. */
  selectedRecommendations: Record<string, number>
}

export function tasteKey(kind: TasteKind | string, id: string | number): string {
  return `${kind}:${String(id)}`
}

export function emptyTasteModel(profileId: string, playlistId: string): TasteModel {
  return {
    version: 1,
    profileId,
    playlistId,
    updatedAt: Date.now(),
    likedTitles: [],
    dislikedTitles: [],
    notInterestedKeys: [],
    favouriteTitles: [],
    genreWeights: {},
    castWeights: {},
    directorWeights: {},
    likedRuntimes: [],
    selectedRecommendations: {},
  }
}

/** Dedupe title refs by `kind:id`, keeping the newest (then heaviest) record. */
export function dedupeTitleRefs(refs: TasteTitleRef[]): TasteTitleRef[] {
  const best = new Map<string, TasteTitleRef>()
  for (const ref of refs) {
    if (!ref || !ref.id) continue
    const key = tasteKey(ref.kind, ref.id)
    const existing = best.get(key)
    if (
      !existing ||
      ref.updatedAt > existing.updatedAt ||
      (ref.updatedAt === existing.updatedAt && ref.weight > existing.weight)
    ) {
      best.set(key, { ...ref, id: String(ref.id) })
    }
  }
  return [...best.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

function normalizeGenre(genre: string): string {
  return genre.trim().toLowerCase()
}

function addWeight(
  weights: Record<string, number>,
  name: string | undefined | null,
  amount: number
): void {
  if (!name) return
  const key = name.trim().toLowerCase()
  if (!key) return
  weights[key] = (weights[key] || 0) + amount
}

// ---------------------------------------------------------------------------
// Building the model from existing watch state
// ---------------------------------------------------------------------------

export interface TasteSignalInput {
  kind: "vod" | "episode"
  id: string | number
  name?: string | null
  seriesId?: string | number | null
  seriesName?: string | null
  /** Epoch ms of the last progress write. */
  updatedAt: number
  completed: boolean
  /** 0..1 progress fraction when known (preferences getProgressFraction). */
  progressFraction?: number
}

export interface TasteFavouriteInput {
  kind: "movie" | "series"
  id: string | number
  title: string
  addedAt?: number
}

/** Metadata the builder needs about a liked title; resolved by the caller. */
export interface TasteTitleMeta {
  genres: string[]
  cast: string[]
  director?: string | null
  runtimeMinutes?: number | null
}

export interface BuildTasteInput {
  profileId: string
  playlistId: string
  /** Watched signals (preferences getWatchedSignals / profile history). */
  signals: TasteSignalInput[]
  favourites: TasteFavouriteInput[]
  /** Resolve genres/cast/director/runtime for a liked title, or null. */
  resolveMeta?: (kind: TasteKind, id: string) => TasteTitleMeta | null
  nowMs?: number
}

/** A title counts as abandoned when it was stopped below this fraction… */
export const ABANDONED_FRACTION = 0.2
/** …and not returned to within this window. */
export const ABANDONED_AFTER_MS = 7 * 24 * 60 * 60 * 1000
/** Abandonment is a weak negative, never as strong as an explicit dislike. */
export const ABANDONED_WEIGHT = 0.5

/**
 * Derive a taste model from the watch state the app already owns. Opening
 * a title never creates a like: only `completed` signals and favourites do.
 * Unfinished signals are kept out of `likedTitles` entirely; the abandoned
 * inference lives in `dislikedTitles` at weak weight (see below) and only
 * for signals old enough that "no return" is meaningful.
 *
 * Re-running this over the same inputs is idempotent: refs are deduped by
 * `kind:id`, so restarts never duplicate records.
 */
export function buildTasteModel(input: BuildTasteInput): TasteModel {
  const nowMs = input.nowMs ?? Date.now()
  const model = emptyTasteModel(input.profileId, input.playlistId)
  const resolveMeta = input.resolveMeta ?? (() => null)

  const liked: TasteTitleRef[] = []
  const disliked: TasteTitleRef[] = []

  for (const signal of input.signals) {
    const isSeries = signal.kind === "episode"
    const kind: TasteKind = isSeries ? "series" : "movie"
    const id = String(isSeries ? signal.seriesId ?? signal.id : signal.id)
    const title = (isSeries ? signal.seriesName : signal.name) || ""
    if (!id || id === "null" || id === "undefined") continue
    const fraction = signal.progressFraction ?? (signal.completed ? 1 : 0)

    if (signal.completed) {
      liked.push({
        kind,
        id,
        title,
        weight: 1,
        updatedAt: signal.updatedAt || 0,
      })
      continue
    }
    // Stopped early + not returned to within a week = weak negative.
    // A recent stop is NOT a signal at all — the viewer may just be busy.
    if (
      fraction > 0 &&
      fraction < ABANDONED_FRACTION &&
      signal.updatedAt > 0 &&
      nowMs - signal.updatedAt > ABANDONED_AFTER_MS
    ) {
      disliked.push({
        kind,
        id,
        title,
        weight: ABANDONED_WEIGHT,
        updatedAt: signal.updatedAt,
      })
    }
  }

  const favourites: TasteTitleRef[] = input.favourites.map((fav) => ({
    kind: fav.kind,
    id: String(fav.id),
    title: fav.title || "",
    weight: 1,
    updatedAt: fav.addedAt || 0,
  }))
  model.favouriteTitles = dedupeTitleRefs(favourites)

  // Favourites are liked too (weight 1.2: an explicit favourite outranks a
  // bare completion), and they seed the genre/cast/director affinities.
  for (const fav of model.favouriteTitles) {
    liked.push({ ...fav, weight: 1.2 })
  }
  model.likedTitles = dedupeTitleRefs(liked)
  model.dislikedTitles = dedupeTitleRefs(disliked)

  // Affinities come only from liked titles — never from abandoned ones.
  for (const ref of model.likedTitles) {
    const meta = resolveMeta(ref.kind, ref.id)
    if (!meta) continue
    for (const genre of meta.genres || []) {
      addWeight(model.genreWeights, normalizeGenre(genre), ref.weight)
    }
    for (const name of meta.cast || []) {
      addWeight(model.castWeights, name, ref.weight * 0.8)
    }
    addWeight(model.directorWeights, meta.director, ref.weight)
    if (meta.runtimeMinutes && meta.runtimeMinutes > 0) {
      model.likedRuntimes.push(meta.runtimeMinutes)
    }
  }
  model.likedRuntimes.sort((a, b) => a - b)
  model.updatedAt = nowMs
  return model
}

// ---------------------------------------------------------------------------
// Explicit feedback (Discover card controls)
// ---------------------------------------------------------------------------

export type TasteFeedbackAction =
  | "like"
  | "dislike"
  | "not-interested"
  | "favourite"
  | "already-watched"
  | "more-like-this"

export interface TasteFeedback {
  kind: TasteKind
  id: string | number
  title?: string
  action: TasteFeedbackAction
  genres?: string[]
  cast?: string[]
  director?: string | null
  runtimeMinutes?: number | null
}

/**
 * Apply one explicit feedback action, returning a NEW model (the input is
 * not mutated). Every path dedupes: liking an already-liked title refreshes
 * it instead of duplicating it, and un-liking removes the record.
 *
 * - like: adds to likedTitles (weight 1.5 — explicit beats inferred).
 * - dislike: adds to dislikedTitles (weight 1) and removes any like.
 * - not-interested: hard exclusion + a dislike record.
 * - favourite: adds to favourites AND likedTitles.
 * - already-watched: adds to likedTitles at completion weight (the viewer
 *   finished it once; it leaves the unwatched pool, it is not a like
 *   beyond that — weight 0.6) and is excluded from future picks by the
 *   engine's watched filter.
 * - more-like-this: a selection signal, not a like — bumps the
 *   selectedRecommendations count so commonly picked recommendations
 *   strengthen their genre/cast affinities on the next rebuild.
 */
export function recordFeedback(model: TasteModel, feedback: TasteFeedback): TasteModel {
  const next: TasteModel = {
    ...model,
    likedTitles: [...model.likedTitles],
    dislikedTitles: [...model.dislikedTitles],
    notInterestedKeys: [...model.notInterestedKeys],
    favouriteTitles: [...model.favouriteTitles],
    genreWeights: { ...model.genreWeights },
    castWeights: { ...model.castWeights },
    directorWeights: { ...model.directorWeights },
    likedRuntimes: [...model.likedRuntimes],
    selectedRecommendations: { ...model.selectedRecommendations },
    updatedAt: Date.now(),
  }
  const id = String(feedback.id)
  const key = tasteKey(feedback.kind, id)
  const title = feedback.title || ""
  const now = Date.now()

  const dropFrom = (list: TasteTitleRef[]) => {
    const idx = list.findIndex((ref) => tasteKey(ref.kind, ref.id) === key)
    if (idx >= 0) list.splice(idx, 1)
  }
  const upsert = (list: TasteTitleRef[], ref: TasteTitleRef) => {
    dropFrom(list)
    list.unshift(ref)
  }

  switch (feedback.action) {
    case "like":
      dropFrom(next.dislikedTitles)
      upsert(next.likedTitles, { kind: feedback.kind, id, title, weight: 1.5, updatedAt: now })
      break
    case "dislike":
      dropFrom(next.likedTitles)
      dropFrom(next.favouriteTitles)
      upsert(next.dislikedTitles, { kind: feedback.kind, id, title, weight: 1, updatedAt: now })
      break
    case "not-interested":
      if (!next.notInterestedKeys.includes(key)) next.notInterestedKeys.push(key)
      dropFrom(next.likedTitles)
      dropFrom(next.favouriteTitles)
      upsert(next.dislikedTitles, { kind: feedback.kind, id, title, weight: 1, updatedAt: now })
      break
    case "favourite":
      dropFrom(next.dislikedTitles)
      next.notInterestedKeys = next.notInterestedKeys.filter((k) => k !== key)
      upsert(next.favouriteTitles, { kind: feedback.kind, id, title, weight: 1, updatedAt: now })
      upsert(next.likedTitles, { kind: feedback.kind, id, title, weight: 1.2, updatedAt: now })
      break
    case "already-watched":
      upsert(next.likedTitles, { kind: feedback.kind, id, title, weight: 0.6, updatedAt: now })
      break
    case "more-like-this":
      next.selectedRecommendations[key] = (next.selectedRecommendations[key] || 0) + 1
      break
  }

  // Affinities follow explicit feedback immediately (not only on rebuild).
  if (feedback.action === "like" || feedback.action === "favourite") {
    for (const genre of feedback.genres || []) {
      addWeight(next.genreWeights, normalizeGenre(genre), 0.5)
    }
    for (const name of feedback.cast || []) {
      addWeight(next.castWeights, name, 0.4)
    }
    addWeight(next.directorWeights, feedback.director, 0.5)
    if (feedback.runtimeMinutes && feedback.runtimeMinutes > 0) {
      next.likedRuntimes.push(feedback.runtimeMinutes)
      next.likedRuntimes.sort((a, b) => a - b)
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// Summary for the AI ranker seam (contract shape lives in discover.ts)
// ---------------------------------------------------------------------------

export interface TasteSummaryShape {
  favouriteGenres: string[]
  likedTitles: string[]
  dislikedTitles: string[]
  preferredRuntimeMax?: number
  pace?: string
}

const INTENSE_GENRES = new Set([
  "action",
  "thriller",
  "horror",
  "crime",
  "war",
  "mystery",
  "sci-fi",
  "science fiction",
])
const LIGHT_GENRES = new Set([
  "comedy",
  "family",
  "animation",
  "romance",
  "musical",
  "music",
])

function topKeys(weights: Record<string, number>, limit: number): string[] {
  return Object.entries(weights)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key)
}

/** 75th percentile of liked runtimes, when at least 3 samples exist. */
export function preferredRuntimeMax(model: TasteModel): number | undefined {
  const runtimes = model.likedRuntimes
  if (runtimes.length < 3) return undefined
  const idx = Math.floor((runtimes.length - 1) * 0.75)
  return runtimes[idx]
}

export function inferPace(model: TasteModel): string | undefined {
  let intense = 0
  let light = 0
  for (const [genre, weight] of Object.entries(model.genreWeights)) {
    if (INTENSE_GENRES.has(genre)) intense += weight
    if (LIGHT_GENRES.has(genre)) light += weight
  }
  if (intense === 0 && light === 0) return undefined
  if (intense > light * 2) return "intense"
  if (light > intense * 2) return "light"
  return "mixed"
}

export function summarizeTaste(model: TasteModel): TasteSummaryShape {
  const summary: TasteSummaryShape = {
    favouriteGenres: topKeys(model.genreWeights, 5),
    likedTitles: dedupeTitleRefs(model.likedTitles)
      .slice(0, 10)
      .map((ref) => ref.title)
      .filter(Boolean),
    dislikedTitles: dedupeTitleRefs(model.dislikedTitles)
      .slice(0, 10)
      .map((ref) => ref.title)
      .filter(Boolean),
  }
  const runtimeMax = preferredRuntimeMax(model)
  if (runtimeMax) summary.preferredRuntimeMax = runtimeMax
  const pace = inferPace(model)
  if (pace) summary.pace = pace
  return summary
}

// ---------------------------------------------------------------------------
// Preference signals for the recommendation engine (0.10.0, C2 / H05)
// ---------------------------------------------------------------------------

/**
 * The evidence `recommendations.explain()` may cite — and nothing else.
 * Every field here is a real signal: a liked/favourited title, an
 * affinity weight built only from liked titles, a hard exclusion, or a
 * because-watched seed that came from actual watch history. There is
 * no inferred "you might like" field: if none of these match a
 * candidate, explain() returns null and the caller uses a neutral label.
 */
export interface TasteSignals {
  likedTitles: TasteTitleRef[]
  favouriteTitles: TasteTitleRef[]
  dislikedTitles: TasteTitleRef[]
  notInterestedKeys: string[]
  /** Normalised genre -> weight, from liked titles only. */
  genreWeights: Record<string, number>
  /** Lower-cased person name -> weight, from liked titles only. */
  castWeights: Record<string, number>
  /** Lower-cased director name -> weight, from liked titles only. */
  directorWeights: Record<string, number>
  /**
   * The because-watched seed this row was built from, when the caller
   * has one (see because-watched.ts). The seed title must be a title
   * the household actually watched; its genres are the link explain()
   * is allowed to cite.
   */
  seedTitle?: { title: string; genres?: string[] } | null
}

/**
 * Project a stored taste model into the signals the recommendation
 * engine may cite. Pure projection — the model is not modified.
 */
export function tasteSignalsFromModel(
  model: TasteModel,
  seedTitle?: { title: string; genres?: string[] } | null,
): TasteSignals {
  return {
    likedTitles: [...model.likedTitles],
    favouriteTitles: [...model.favouriteTitles],
    dislikedTitles: [...model.dislikedTitles],
    notInterestedKeys: [...model.notInterestedKeys],
    genreWeights: { ...model.genreWeights },
    castWeights: { ...model.castWeights },
    directorWeights: { ...model.directorWeights },
    seedTitle: seedTitle ?? null,
  }
}

// ---------------------------------------------------------------------------
// Persistence (localStorage, same namespaced pattern as profiles.ts)
// ---------------------------------------------------------------------------

export const TASTE_STORAGE_PREFIX = "nylah_taste_v1"

export function tasteStorageKey(profileId: string, playlistId: string): string {
  return `${TASTE_STORAGE_PREFIX}:${profileId}:${playlistId}`
}

function storageAvailable(): boolean {
  return typeof localStorage !== "undefined"
}

function normalizeStored(raw: unknown, profileId: string, playlistId: string): TasteModel {
  const base = emptyTasteModel(profileId, playlistId)
  if (!raw || typeof raw !== "object") return base
  const data = raw as Partial<TasteModel>
  return {
    ...base,
    likedTitles: dedupeTitleRefs(Array.isArray(data.likedTitles) ? data.likedTitles : []),
    dislikedTitles: dedupeTitleRefs(Array.isArray(data.dislikedTitles) ? data.dislikedTitles : []),
    notInterestedKeys: Array.isArray(data.notInterestedKeys)
      ? [...new Set(data.notInterestedKeys.map(String))]
      : [],
    favouriteTitles: dedupeTitleRefs(
      Array.isArray(data.favouriteTitles) ? data.favouriteTitles : []
    ),
    genreWeights:
      data.genreWeights && typeof data.genreWeights === "object" ? data.genreWeights : {},
    castWeights:
      data.castWeights && typeof data.castWeights === "object" ? data.castWeights : {},
    directorWeights:
      data.directorWeights && typeof data.directorWeights === "object"
        ? data.directorWeights
        : {},
    likedRuntimes: Array.isArray(data.likedRuntimes)
      ? data.likedRuntimes.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
      : [],
    selectedRecommendations:
      data.selectedRecommendations && typeof data.selectedRecommendations === "object"
        ? data.selectedRecommendations
        : {},
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
  }
}

/** Load the stored model, or an empty one when nothing is stored (cold start). */
export function loadTaste(profileId: string, playlistId: string): TasteModel {
  if (!storageAvailable()) return emptyTasteModel(profileId, playlistId)
  try {
    const raw = localStorage.getItem(tasteStorageKey(profileId, playlistId))
    if (!raw) return emptyTasteModel(profileId, playlistId)
    return normalizeStored(JSON.parse(raw), profileId, playlistId)
  } catch {
    return emptyTasteModel(profileId, playlistId)
  }
}

/** Persist the model. Watch history is never written here — this is taste only. */
export function saveTaste(model: TasteModel): void {
  if (!storageAvailable()) return
  try {
    localStorage.setItem(
      tasteStorageKey(model.profileId, model.playlistId),
      JSON.stringify(model)
    )
  } catch {
    // Storage full / unavailable: taste stays in memory for the session.
  }
}
