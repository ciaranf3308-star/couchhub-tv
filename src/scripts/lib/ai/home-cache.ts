// Durable, versioned AI cache for Movies/Series Home picks (0.11.14, W4).
//
// The Discover orchestrator cache is in-memory only; Home needs picks
// that survive an app relaunch, so this module persists a SMALL,
// bounded cache in localStorage (best-effort: private mode / quota /
// a missing localStorage degrades to an in-memory map, never a throw).
//
// Cache identity (§17) accounts for: active profile, playlist /
// catalogue revision, movies vs series, AI provider/model identity,
// ranking pipeline version, taste revision, request type, and
// exclusions / material constraints. The cache KEY carries hashes of
// the provider identity and of the exclusion/constraint sets — never
// raw endpoints, never taste content, never secrets. A taste revision
// stamp (e.g. the taste model's updatedAt) is a timestamp, not taste
// content, and is always part of the key: a changed taste model must
// never reuse picks ranked for the old one, whether or not taste
// sharing is on.
//
// The key deliberately does NOT include the candidate shortlist: the
// shortlist is rebuilt on every Home load from the same catalogue +
// taste inputs, so keying on its exact order would make every cache
// read miss. Stale-link safety comes from READ-TIME validation
// instead (home-picks.ts re-validates every cached pick against the
// CURRENT pool before serving it — a pick whose catalogue entry is
// gone, or whose kind changed, is dropped; an entry with no surviving
// picks is a miss). The catalogue revision in the key is the first
// line of defence; read-time validation is the second.
//
// Expiry: entries live HOME_AI_CACHE_TTL_MS (24h). An expired entry
// is deleted on read and never served — expired picks must not freeze
// forever. Reopening a page serves a fresh entry with zero model
// calls; only an expired/missing entry may trigger a refresh, and
// only under the trigger rules in home-picks.ts.
//
// The attempt ledger (same file, separate key) records the last
// provider attempt per kind + request type + profile + playlist +
// provider identity. It is what enforces the "at most one bounded
// refresh per content type per ~24h" auto-refresh bound and stops
// retry storms: a failed auto-refresh is recorded exactly like a
// successful one. Explicit "Generate AI Picks" requests ignore the
// ledger (the viewer asked) but still record their attempt.

export type HomeAiKind = "movie" | "series"

export type HomeAiRequestType = "picks" | "discovery"

/**
 * One Home AI pick, as stored. The playable invariant: every stored
 * pick names a real catalogue entry (compositeId `${kind}:${id}`)
 * that was validated against the pool/catalogue at write time AND is
 * re-validated at read time. A pick never names an episode: Home
 * pools are title-level catalogue entries, and the kind on the pick
 * must equal the kind the request asked for.
 */
export interface HomeAiPick {
  compositeId: string
  kind: HomeAiKind
  /** Bare catalogue id (no kind prefix) — what detail routes take. */
  id: string
  title: string
  year: number | null
  /** Model-order score in (0, 1]; higher ranks first. */
  score: number
  /** Short reason, sanitised against real metadata at write time. */
  reason: string
  /** Provider/TMDb id when known; null when the row carries none. */
  tmdbId: number | null
}

export interface HomeAiCacheIdentity {
  kind: HomeAiKind
  requestType: HomeAiRequestType
  profileId?: string
  playlistId?: string
  /** Catalogue revision stamp (CatalogIndex revision / loadCatalogStamp). */
  catalogueRevision?: string | number | null
  /** Provider identity, already read by the caller (guarded getters). */
  endpoint?: string
  model?: string
  /** Ranking pipeline version (home-picks composes this string). */
  pipelineVersion: string
  /** Taste-model revision stamp; "" when unknown. Always keyed. */
  tasteRevision?: string
  /** Generation brief / request label; "" for the rerank picks path. */
  brief?: string
  /** Sorted, normalised exclusion titles. */
  excludeTitles?: string[]
  /** Sorted composite ids excluded from the pool. */
  excludeCompositeIds?: string[]
  /** Material constraints that change the answer (mood, runtime cap). */
  mood?: string
  maxRuntimeMinutes?: number
}

export interface HomeAiCacheEntry {
  key: string
  kind: HomeAiKind
  requestType: HomeAiRequestType
  picks: HomeAiPick[]
  /** Model id that produced the picks (receipts may show this). */
  model: string
  sentToModelCount: number
  createdAt: number
  expiresAt: number
}

/** Picks stay valid for a day — the §16 auto-refresh period. */
export const HOME_AI_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Hard bound on stored entries: 2 kinds x request types x profiles, with slack. */
export const HOME_AI_CACHE_MAX_ENTRIES = 8

/** Hard bound on picks per entry (generation clamps to 12; rerank to 20, stored capped). */
export const HOME_AI_CACHE_MAX_PICKS = 12

const CACHE_KEY = "xt_ai_home_cache_v1"
const ATTEMPT_KEY = "xt_ai_home_attempts_v1"
const MAX_ATTEMPT_ENTRIES = 16

// ---------------------------------------------------------------------------
// Key building (pure — tested)
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash, hex. Same construction as the orchestrator/ranker. */
export function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function normalizeText(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function sortedNormalized(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => normalizeText(v)).filter(Boolean))].sort()
}

/**
 * Provider identity hash for the key. The raw endpoint is NEVER stored
 * (status receipts exclude it too); the hash distinguishes a changed
 * provider/model without persisting either value.
 */
export function homeAiProviderHash(endpoint: string | undefined, model: string | undefined): string {
  return hashString(`${(endpoint ?? "").trim()}|${(model ?? "").trim()}`)
}

/**
 * Full cache key. Two requests share an entry ONLY when every
 * dimension matches. The key is a JSON string (debuggable, no
 * secrets); the provider/exclusion/constraint material inside it is
 * hashed.
 */
export function buildHomeAiCacheKey(identity: HomeAiCacheIdentity): string {
  return JSON.stringify({
    v: identity.pipelineVersion,
    kind: identity.kind,
    type: identity.requestType,
    profile: identity.profileId ?? "",
    playlist: identity.playlistId ?? "",
    catalogue: identity.catalogueRevision == null ? "" : String(identity.catalogueRevision),
    provider: homeAiProviderHash(identity.endpoint, identity.model),
    taste: identity.tasteRevision ?? "",
    brief: hashString(normalizeText(identity.brief)),
    excl: hashString(
      JSON.stringify({
        t: sortedNormalized(identity.excludeTitles),
        ids: sortedNormalized(identity.excludeCompositeIds),
      })
    ),
    constraints: hashString(
      JSON.stringify({
        mood: normalizeText(identity.mood),
        runtime: identity.maxRuntimeMinutes ?? 0,
      })
    ),
  })
}

/**
 * Attempt-ledger key: coarser than the cache key on purpose — the 24h
 * bound is per content type, not per brief/constraint variation, so a
 * changed mood line cannot restart the auto-refresh clock. Profile,
 * playlist and provider identity still separate ledgers: one
 * profile's attempts never suppress another's, and a provider change
 * re-arms the bound.
 */
export function buildHomeAiLedgerKey(input: {
  kind: HomeAiKind
  requestType: HomeAiRequestType
  profileId?: string
  playlistId?: string
  endpoint?: string
  model?: string
}): string {
  return JSON.stringify({
    kind: input.kind,
    type: input.requestType,
    profile: input.profileId ?? "",
    playlist: input.playlistId ?? "",
    provider: homeAiProviderHash(input.endpoint, input.model),
  })
}

// ---------------------------------------------------------------------------
// Storage (guarded localStorage, in-memory fallback)
// ---------------------------------------------------------------------------

let memoryCacheStore: Record<string, HomeAiCacheEntry> | null = null
let memoryAttemptStore: Record<string, number> | null = null

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage !== null
  } catch {
    return false
  }
}

function readCacheStore(): Record<string, HomeAiCacheEntry> {
  if (!storageAvailable()) {
    return memoryCacheStore ?? {}
  }
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, HomeAiCacheEntry>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function writeCacheStore(store: Record<string, HomeAiCacheEntry>): void {
  if (!storageAvailable()) {
    memoryCacheStore = store
    return
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(store))
  } catch {
    // Quota / private mode: keep the memory copy so this session
    // still benefits; durability is best-effort.
    memoryCacheStore = store
  }
}

function readAttemptStore(): Record<string, number> {
  if (!storageAvailable()) {
    return memoryAttemptStore ?? {}
  }
  try {
    const raw = localStorage.getItem(ATTEMPT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, number>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function writeAttemptStore(store: Record<string, number>): void {
  if (!storageAvailable()) {
    memoryAttemptStore = store
    return
  }
  try {
    localStorage.setItem(ATTEMPT_KEY, JSON.stringify(store))
  } catch {
    memoryAttemptStore = store
  }
}

function isValidEntry(entry: unknown): entry is HomeAiCacheEntry {
  if (!entry || typeof entry !== "object") return false
  const e = entry as Partial<HomeAiCacheEntry>
  return (
    typeof e.key === "string" &&
    (e.kind === "movie" || e.kind === "series") &&
    (e.requestType === "picks" || e.requestType === "discovery") &&
    Array.isArray(e.picks) &&
    typeof e.createdAt === "number" &&
    typeof e.expiresAt === "number"
  )
}

function pruneExpired(
  store: Record<string, HomeAiCacheEntry>,
  nowMs: number
): Record<string, HomeAiCacheEntry> {
  const out: Record<string, HomeAiCacheEntry> = {}
  for (const [key, entry] of Object.entries(store)) {
    if (!isValidEntry(entry)) continue
    if (entry.expiresAt <= nowMs) continue
    if (entry.key !== key) continue
    out[key] = entry
  }
  return out
}

// ---------------------------------------------------------------------------
// Cache read / write
// ---------------------------------------------------------------------------

/**
 * Read one entry. Returns null when absent, expired, corrupt, or
 * key-mismatched. An expired entry is deleted (it must not freeze).
 * Read-time pick validation against the current pool happens in
 * home-picks.ts — this layer only guarantees identity + freshness.
 */
export function readHomeAiCacheEntry(
  key: string,
  nowMs: number = Date.now()
): HomeAiCacheEntry | null {
  const store = pruneExpired(readCacheStore(), nowMs)
  const entry = store[key] ?? null
  // Persist the prune so expired entries do not accumulate.
  if (Object.keys(store).length !== Object.keys(readCacheStore()).length) {
    writeCacheStore(store)
  }
  if (!entry) return null
  return {
    ...entry,
    picks: entry.picks.filter(
      (pick): pick is HomeAiPick =>
        !!pick &&
        typeof pick.compositeId === "string" &&
        (pick.kind === "movie" || pick.kind === "series") &&
        typeof pick.id === "string" &&
        pick.id.length > 0
    ),
  }
}

/**
 * Store picks under `key`, bounded to HOME_AI_CACHE_MAX_ENTRIES
 * (oldest-created evicted first) and HOME_AI_CACHE_MAX_PICKS per
 * entry. Empty pick lists are never stored — an empty result must
 * not freeze the shelf. Returns the stored entry, or null when
 * nothing was stored.
 */
export function writeHomeAiCacheEntry(
  input: {
    key: string
    kind: HomeAiKind
    requestType: HomeAiRequestType
    picks: HomeAiPick[]
    model: string
    sentToModelCount: number
  },
  nowMs: number = Date.now()
): HomeAiCacheEntry | null {
  const picks = (input.picks ?? []).filter(
    (pick): pick is HomeAiPick =>
      !!pick &&
      typeof pick.compositeId === "string" &&
      pick.kind === input.kind &&
      typeof pick.id === "string" &&
      pick.id.length > 0
  )
  if (!picks.length) return null
  const entry: HomeAiCacheEntry = {
    key: input.key,
    kind: input.kind,
    requestType: input.requestType,
    picks: picks.slice(0, HOME_AI_CACHE_MAX_PICKS).map((pick) => ({
      compositeId: pick.compositeId,
      kind: pick.kind,
      id: pick.id,
      title: pick.title ?? "",
      year: typeof pick.year === "number" ? pick.year : null,
      score: pick.score,
      reason: pick.reason ?? "",
      tmdbId: typeof pick.tmdbId === "number" ? pick.tmdbId : null,
    })),
    model: input.model ?? "",
    sentToModelCount: input.sentToModelCount ?? 0,
    createdAt: nowMs,
    expiresAt: nowMs + HOME_AI_CACHE_TTL_MS,
  }
  const store = pruneExpired(readCacheStore(), nowMs)
  store[input.key] = entry
  const keys = Object.keys(store).sort(
    (a, b) => (store[a]?.createdAt ?? 0) - (store[b]?.createdAt ?? 0)
  )
  while (keys.length > HOME_AI_CACHE_MAX_ENTRIES) {
    const oldest = keys.shift()
    if (oldest) delete store[oldest]
  }
  writeCacheStore(store)
  return entry
}

/** True when the entry is still inside its TTL at `nowMs`. */
export function isHomeAiCacheEntryFresh(
  entry: HomeAiCacheEntry,
  nowMs: number = Date.now()
): boolean {
  return entry.expiresAt > nowMs && entry.picks.length > 0
}

/** Clear every stored Home AI entry (Settings / tests / profile switch hygiene). */
export function clearHomeAiCache(): void {
  memoryCacheStore = null
  if (storageAvailable()) {
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      // ignore — the in-memory copy is already cleared
    }
  }
}

// ---------------------------------------------------------------------------
// Attempt ledger (24h auto-refresh bound / no-retry-storm)
// ---------------------------------------------------------------------------

/** Epoch ms of the last recorded attempt for this ledger key, or null. */
export function lastHomeAiAttemptAt(ledgerKey: string): number | null {
  const store = readAttemptStore()
  const at = store[ledgerKey]
  return typeof at === "number" && Number.isFinite(at) ? at : null
}

/** Record a provider attempt now (success or failure — both count). */
export function recordHomeAiAttempt(ledgerKey: string, nowMs: number = Date.now()): void {
  const store = readAttemptStore()
  store[ledgerKey] = nowMs
  const keys = Object.keys(store).sort((a, b) => (store[a] ?? 0) - (store[b] ?? 0))
  while (keys.length > MAX_ATTEMPT_ENTRIES) {
    const oldest = keys.shift()
    if (oldest) delete store[oldest]
  }
  writeAttemptStore(store)
}

/** True when an auto-refresh is still inside the 24h bound for this key. */
export function isHomeAiAttemptBounded(ledgerKey: string, nowMs: number = Date.now()): boolean {
  const last = lastHomeAiAttemptAt(ledgerKey)
  if (last === null) return false
  return nowMs - last < HOME_AI_CACHE_TTL_MS
}

export function clearHomeAiAttempts(): void {
  memoryAttemptStore = null
  if (storageAvailable()) {
    try {
      localStorage.removeItem(ATTEMPT_KEY)
    } catch {
      // ignore
    }
  }
}
